//! In-app updates (Phase 5) via `tauri-plugin-updater` and GitHub Releases `latest.json`.
//!
//! The public key and endpoint live in `tauri.conf.json` (`plugins.updater`). Until the
//! maintainer sets a real public key (see docs/releasing.md), the updater counts as
//! "not configured": `check_for_update` returns `updaterConfigured: false` and never errors.

use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::AppError;
use crate::models::UpdateInfo;

/// Legacy placeholder owner marker, retained so invalid historical builds are rejected.
pub const OWNER_PLACEHOLDER: &str = "/OWNER/";

/// Repository URL from Cargo.toml `repository`, fixed at compile time.
pub const REPOSITORY_URL: &str = env!("CARGO_PKG_REPOSITORY");

/// The only URL `open_releases_page` can open: `<repository>/releases`.
pub fn releases_url(repository: &str) -> Result<String, AppError> {
    let repo = repository.trim().trim_end_matches('/');
    let url = format!("{repo}/releases");
    if url.contains(OWNER_PLACEHOLDER) {
        return Err(AppError::InvalidInput(
            "the releases page is not configured in this build (repository owner placeholder)"
                .into(),
        ));
    }
    if !url.starts_with("https://github.com/") || repo.split('/').count() != 5 {
        return Err(AppError::InvalidInput(
            "the repository URL in this build is not a GitHub repository".into(),
        ));
    }
    Ok(url)
}

/// Opens the releases page in the system browser (no webview permission involved).
pub fn open_releases_page(app: &AppHandle) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let url = releases_url(REPOSITORY_URL)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the browser: {e}")))
}

/// True when the updater config has a real public key and real endpoints.
pub fn is_configured(updater_config: Option<&Value>) -> bool {
    let Some(cfg) = updater_config else {
        return false;
    };
    let pubkey = cfg
        .get("pubkey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let endpoints: Vec<&str> = cfg
        .get("endpoints")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    // A minisign public key is a long base64 string; reject empty/placeholder values.
    let key_ok = pubkey.len() >= 40 && !pubkey.to_ascii_uppercase().contains("REPLACE");
    let endpoints_ok = !endpoints.is_empty()
        && endpoints
            .iter()
            .all(|e| e.starts_with("https://") && !e.contains(OWNER_PLACEHOLDER));
    key_ok && endpoints_ok
}

fn configured(app: &AppHandle) -> bool {
    is_configured(app.config().plugins.0.get("updater"))
}

fn not_configured_info(current: String) -> UpdateInfo {
    UpdateInfo {
        updater_configured: false,
        available: false,
        current_version: current,
        latest_version: None,
        notes: None,
    }
}

/// Checks GitHub Releases for a newer version.
pub async fn check(app: &AppHandle) -> Result<UpdateInfo, AppError> {
    let current = app.package_info().version.to_string();
    if !configured(app) {
        return Ok(not_configured_info(current));
    }
    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater: {e}")))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(UpdateInfo {
            updater_configured: true,
            available: true,
            current_version: current,
            latest_version: Some(u.version.clone()),
            notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        }),
        Ok(None) => Ok(UpdateInfo {
            updater_configured: true,
            available: false,
            current_version: current.clone(),
            latest_version: Some(current),
            notes: None,
        }),
        Err(e) => {
            tracing::info!(error = %e, "update check failed");
            Err(AppError::Network(
                "Could not check for updates; try again later.".into(),
            ))
        }
    }
}

/// Downloads, verifies (signature) and installs the update, then restarts the app.
pub async fn install(app: &AppHandle) -> Result<(), AppError> {
    if !configured(app) {
        return Err(AppError::Unsupported(
            "updates are not configured in this build".into(),
        ));
    }
    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|_| AppError::Network("Could not check for updates; try again later.".into()))?
        .ok_or_else(|| AppError::InvalidInput("no update is available".into()))?;
    tracing::info!(version = %update.version, "installing update");
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| AppError::Internal(format!("update failed: {e}")))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str =
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0RFRjEyMzQ1Njc4OTAK";

    #[test]
    fn releases_url_is_fixed_and_validated() {
        assert_eq!(
            releases_url("https://github.com/acme/StarlinkPulse").unwrap(),
            "https://github.com/acme/StarlinkPulse/releases"
        );
        assert_eq!(
            releases_url("https://github.com/acme/StarlinkPulse/").unwrap(),
            "https://github.com/acme/StarlinkPulse/releases"
        );
        // Historical OWNER placeholders are rejected with invalid_input.
        let e = releases_url("https://github.com/OWNER/StarlinkPulse").unwrap_err();
        assert_eq!(e.kind(), "invalid_input");
        assert_eq!(REPOSITORY_URL, "https://github.com/Mauro2888/starlinkpulse");
        assert_eq!(
            releases_url(REPOSITORY_URL).unwrap(),
            "https://github.com/Mauro2888/starlinkpulse/releases"
        );
        for bad in [
            "http://github.com/a/b",
            "https://evil.example/a/b",
            "https://github.com/a/b/c",
            "",
        ] {
            assert!(releases_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn configuration_detection() {
        assert!(!is_configured(None));
        let shipped = json!({
            "pubkey": "",
            "endpoints": ["https://github.com/OWNER/StarlinkPulse/releases/latest/download/latest.json"]
        });
        assert!(
            !is_configured(Some(&shipped)),
            "repo default is not configured"
        );
        let placeholder_owner = json!({ "pubkey": KEY, "endpoints": shipped["endpoints"] });
        assert!(!is_configured(Some(&placeholder_owner)));
        let replace_me = json!({
            "pubkey": "REPLACE_WITH_PUBLIC_KEY_REPLACE_WITH_PUBLIC_KEY",
            "endpoints": ["https://github.com/acme/StarlinkPulse/releases/latest/download/latest.json"]
        });
        assert!(!is_configured(Some(&replace_me)));
        let http = json!({ "pubkey": KEY, "endpoints": ["http://example.com/latest.json"] });
        assert!(!is_configured(Some(&http)));
        let ok = json!({
            "pubkey": KEY,
            "endpoints": ["https://github.com/acme/StarlinkPulse/releases/latest/download/latest.json"]
        });
        assert!(is_configured(Some(&ok)));
    }

    #[test]
    fn not_configured_info_never_claims_an_update() {
        let i = not_configured_info("0.1.0".into());
        assert!(!i.updater_configured && !i.available);
        assert_eq!(i.current_version, "0.1.0");
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["updaterConfigured"], false);
        assert!(v["latestVersion"].is_null());
    }

    #[test]
    fn shipped_tauri_conf_is_not_configured() {
        let path = format!("{}/tauri.conf.json", env!("CARGO_MANIFEST_DIR"));
        let conf: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let updater = conf.pointer("/plugins/updater");
        assert!(
            updater.is_some(),
            "plugins.updater must exist (pubkey is required)"
        );
        assert!(!is_configured(updater));
    }
}
