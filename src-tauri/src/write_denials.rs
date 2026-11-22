//! Runtime capability downgrade for write commands (docs/compatibility.md, "Write commands").
//!
//! Recent firmware rejects local unauthenticated writes with `PermissionDenied`. When the
//! user's explicit action hits that, the action is remembered per `softwareVersion` and the
//! matching capability is disabled from then on. Writes are never probed automatically.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::dish::WriteAction;
use crate::error::AppError;
use crate::models::DishCapabilities;

pub const DENIALS_FILE: &str = "write_denials.json";
const UNKNOWN_VERSION: &str = "unknown";

/// Stable key of a write action ("stow" covers stow and unstow).
pub fn action_key(action: WriteAction) -> &'static str {
    match action {
        WriteAction::Reboot => "reboot",
        WriteAction::Stow | WriteAction::Unstow => "stow",
        WriteAction::SetSnowMelt(_) => "snow_melt",
    }
}

/// Denied actions per firmware version.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDenials {
    #[serde(default)]
    pub by_software_version: BTreeMap<String, BTreeSet<String>>,
}

fn version_key(version: Option<&str>) -> String {
    version
        .filter(|v| !v.is_empty())
        .unwrap_or(UNKNOWN_VERSION)
        .to_string()
}

impl WriteDenials {
    /// Loads the file; missing or corrupt -> empty.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text =
            serde_json::to_string_pretty(self).map_err(|e| AppError::Internal(e.to_string()))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Records a denial; returns true when it was new.
    pub fn record(&mut self, software_version: Option<&str>, action: WriteAction) -> bool {
        self.by_software_version
            .entry(version_key(software_version))
            .or_default()
            .insert(action_key(action).to_string())
    }

    pub fn is_denied(&self, software_version: Option<&str>, key: &str) -> bool {
        self.by_software_version
            .get(&version_key(software_version))
            .is_some_and(|s| s.contains(key))
    }

    /// Disables capabilities denied for `caps.software_version`.
    pub fn apply(&self, caps: &mut DishCapabilities) {
        let v = caps.software_version.clone();
        let v = v.as_deref();
        if self.is_denied(v, "reboot") {
            caps.can_reboot = false;
        }
        if self.is_denied(v, "stow") {
            caps.can_stow = false;
        }
        if self.is_denied(v, "snow_melt") {
            caps.can_set_snow_melt = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SnowMeltMode;

    fn caps(version: &str) -> DishCapabilities {
        DishCapabilities {
            software_version: Some(version.into()),
            can_reboot: true,
            can_stow: true,
            can_set_snow_melt: true,
            ..Default::default()
        }
    }

    #[test]
    fn denial_is_per_action_and_version() {
        let mut d = WriteDenials::default();
        assert!(d.record(Some("fw1"), WriteAction::SetSnowMelt(SnowMeltMode::Auto)));
        assert!(!d.record(
            Some("fw1"),
            WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn)
        ));
        let mut c = caps("fw1");
        d.apply(&mut c);
        assert!(!c.can_set_snow_melt);
        assert!(c.can_reboot && c.can_stow);
        // A firmware update gets a fresh chance.
        let mut c2 = caps("fw2");
        d.apply(&mut c2);
        assert!(c2.can_set_snow_melt);
        // Unstow shares the stow key.
        d.record(Some("fw1"), WriteAction::Unstow);
        let mut c3 = caps("fw1");
        d.apply(&mut c3);
        assert!(!c3.can_stow);
    }

    #[test]
    fn roundtrip_and_corrupt_file() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-denials-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        let path = dir.join(DENIALS_FILE);
        assert_eq!(WriteDenials::load(&path), WriteDenials::default());
        let mut d = WriteDenials::default();
        d.record(None, WriteAction::Reboot);
        d.save(&path).unwrap();
        let loaded = WriteDenials::load(&path);
        assert!(loaded.is_denied(None, "reboot"));
        std::fs::write(&path, "{oops").unwrap();
        assert_eq!(WriteDenials::load(&path), WriteDenials::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
