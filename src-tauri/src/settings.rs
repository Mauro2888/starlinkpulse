//! User settings persisted as JSON in `app_data_dir/settings.json` (never the API key).

use std::path::Path;

use crate::error::AppError;
use crate::models::Settings;

pub const SETTINGS_FILE: &str = "settings.json";
pub const MIN_POLL_S: u32 = 1;
pub const MAX_POLL_S: u32 = 60;

/// Loads settings; a missing or corrupt file yields defaults (read-only ON).
pub fn load(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) => validate(s).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "invalid settings on disk, using defaults");
                Settings::default()
            }),
            Err(e) => {
                tracing::warn!(error = %e, "unreadable settings, using defaults");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

/// Atomically writes settings.
pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| AppError::Internal(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Validates a `host:port` address (IPv4, hostname or `[IPv6]`).
fn validate_address(field: &str, value: &str) -> Result<String, AppError> {
    let v = value.trim();
    let invalid = || AppError::InvalidInput(format!("{field} must be host:port"));
    if v.is_empty() || v.contains("://") || v.contains('/') || v.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let (host, port) = v.rsplit_once(':').ok_or_else(invalid)?;
    if host.is_empty() || host == "[]" {
        return Err(invalid());
    }
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        return Err(invalid());
    }
    match port.parse::<u16>() {
        Ok(p) if p > 0 => Ok(v.to_string()),
        _ => Err(invalid()),
    }
}

/// Validates and normalizes settings.
pub fn validate(mut s: Settings) -> Result<Settings, AppError> {
    s.dish_address = validate_address("dishAddress", &s.dish_address)?;
    // Empty router address = router features disabled.
    s.router_address = if s.router_address.trim().is_empty() {
        String::new()
    } else {
        validate_address("routerAddress", &s.router_address)?
    };
    if !(MIN_POLL_S..=MAX_POLL_S).contains(&s.live_poll_interval_s) {
        return Err(AppError::InvalidInput(format!(
            "livePollIntervalS must be between {MIN_POLL_S} and {MAX_POLL_S}"
        )));
    }
    s.active_location = match s.active_location.take() {
        None => None,
        Some(n) if n.trim().is_empty() => None,
        Some(n) => Some(validate_location_name(&n)?),
    };
    if let Some(b) = &s.battery {
        let ok = b.capacity_ah.is_finite()
            && (1.0..=100_000.0).contains(&b.capacity_ah)
            && b.voltage.is_finite()
            && (1.0..=1_000.0).contains(&b.voltage)
            && b.usable_fraction.is_finite()
            && (0.1..=1.0).contains(&b.usable_fraction);
        if !ok {
            return Err(AppError::InvalidInput(
                "battery: capacityAh 1–100000, voltage 1–1000, usableFraction 0.1–1".into(),
            ));
        }
    }
    if !(1..=28).contains(&s.billing_cycle_day) {
        return Err(AppError::InvalidInput(
            "billingCycleDay must be between 1 and 28".into(),
        ));
    }
    if let Some(cap) = s.data_cap_gb
        && !(cap.is_finite() && cap > 0.0 && cap <= 1_000_000.0)
    {
        return Err(AppError::InvalidInput(
            "dataCapGb must be a positive number".into(),
        ));
    }
    let n = &s.notifications;
    match (n.quiet_start_hour, n.quiet_end_hour) {
        (None, None) => {}
        (Some(a), Some(b)) if a <= 23 && b <= 23 => {}
        _ => {
            return Err(AppError::InvalidInput(
                "quiet hours need both a start and an end hour (0-23)".into(),
            ));
        }
    }
    // scheme://host[:port][/path] only: no user info, query or fragment.
    s.local_ai_url = crate::ai::http::validate_base_url(&s.local_ai_url).map_err(|e| {
        AppError::InvalidInput(format!(
            "localAiUrl must be an http(s)://host[:port][/path] URL: {e}"
        ))
    })?;
    s.local_ai_model = s.local_ai_model.trim().to_string();
    if s.local_ai_model.len() > 200 || s.local_ai_model.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "localAiModel is not a valid model name".into(),
        ));
    }
    s.claude_model = s.claude_model.trim().to_string();
    if s.claude_model.is_empty()
        || s.claude_model.len() > 100
        || !s
            .claude_model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '@'))
    {
        return Err(AppError::InvalidInput(
            "claudeModel is not a valid model id".into(),
        ));
    }
    Ok(s)
}

/// Validates a location name: trimmed, 1–40 characters, no control characters.
pub fn validate_location_name(name: &str) -> Result<String, AppError> {
    let n = name.trim();
    let len = n.chars().count();
    if !(1..=40).contains(&len) || n.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "location names must be 1–40 characters without control characters".into(),
        ));
    }
    Ok(n.to_string())
}

/// True when the dish/router connection must be re-established after a settings change.
pub fn needs_reconnect(old: &Settings, new: &Settings) -> bool {
    old.dish_address != new.dish_address
        || old.router_address != new.router_address
        || old.mock_mode != new.mock_mode
        || old.mock_profile != new.mock_profile
        || old.live_poll_interval_s != new.live_poll_interval_s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{MockMode, MockProfile, NotificationSettings};

    #[test]
    fn defaults_are_read_only_and_valid() {
        let s = Settings::default();
        assert!(s.read_only);
        assert_eq!(validate(s.clone()).unwrap(), s);
    }

    #[test]
    fn rejects_bad_values() {
        let bad = |f: fn(&mut Settings)| {
            let mut s = Settings::default();
            f(&mut s);
            validate(s).is_err()
        };
        assert!(bad(|s| s.dish_address = "".into()));
        assert!(bad(|s| s.dish_address = "http://192.168.100.1:9200".into()));
        assert!(bad(|s| s.dish_address = "192.168.100.1".into()));
        assert!(bad(|s| s.dish_address = "192.168.100.1:0".into()));
        assert!(bad(|s| s.dish_address = "192.168.100.1:99999".into()));
        assert!(bad(|s| s.router_address = "::1:9000".into()));
        assert!(bad(|s| s.live_poll_interval_s = 0));
        assert!(bad(|s| s.live_poll_interval_s = 61));
        assert!(bad(|s| s.billing_cycle_day = 0));
        assert!(bad(|s| s.billing_cycle_day = 29));
        assert!(bad(|s| s.data_cap_gb = Some(0.0)));
        assert!(bad(|s| s.data_cap_gb = Some(f64::NAN)));
        assert!(bad(|s| s.notifications.quiet_start_hour = Some(22)));
        assert!(bad(|s| {
            s.notifications.quiet_start_hour = Some(24);
            s.notifications.quiet_end_hour = Some(7);
        }));
        assert!(bad(|s| s.claude_model = " ".into()));
        assert!(bad(|s| s.claude_model = "a b".into()));
    }

    #[test]
    fn accepts_and_trims() {
        let s = Settings {
            dish_address: " dish.local:9200 ".into(),
            router_address: "[fe80::1]:9000".into(),
            ..Default::default()
        };
        let v = validate(s).unwrap();
        assert_eq!(v.dish_address, "dish.local:9200");
    }

    #[test]
    fn empty_router_address_disables_router() {
        let s = Settings {
            router_address: "   ".into(),
            ..Default::default()
        };
        assert_eq!(validate(s).unwrap().router_address, "");
        let bad_dish = Settings {
            dish_address: "".into(),
            ..Default::default()
        };
        assert!(validate(bad_dish).is_err(), "dish address stays mandatory");
    }

    #[test]
    fn phase6_settings() {
        use crate::models::{AppLanguage, BatteryConfig};
        let d = Settings::default();
        assert_eq!(d.language, AppLanguage::System);
        assert_eq!(d.active_location, None);
        assert_eq!(d.battery, None);
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["language"], "system");
        assert!(v["activeLocation"].is_null() && v["battery"].is_null());
        let ok = Settings {
            active_location: Some("  Roof ".into()),
            battery: Some(BatteryConfig {
                capacity_ah: 100.0,
                voltage: 12.8,
                usable_fraction: 0.8,
            }),
            language: AppLanguage::It,
            ..Default::default()
        };
        let v = validate(ok).unwrap();
        assert_eq!(v.active_location.as_deref(), Some("Roof"));
        let blank = Settings {
            active_location: Some("  ".into()),
            ..Default::default()
        };
        assert_eq!(validate(blank).unwrap().active_location, None);
        for bad in ["x".repeat(41), "a\u{7}b".to_string()] {
            let s = Settings {
                active_location: Some(bad),
                ..Default::default()
            };
            assert!(validate(s).is_err());
        }
        let bad_battery = Settings {
            battery: Some(BatteryConfig {
                capacity_ah: 100.0,
                voltage: 12.0,
                usable_fraction: 0.05,
            }),
            ..Default::default()
        };
        assert!(validate(bad_battery).is_err());
        assert_eq!(validate_location_name(" Balcony ").unwrap(), "Balcony");
    }

    #[test]
    fn local_ai_settings() {
        use crate::models::{AiProvider, LocalAiKind};
        let d = Settings::default();
        assert_eq!(d.ai_provider, AiProvider::Off);
        assert_eq!(d.local_ai_url, "http://localhost:11434");
        assert_eq!(d.local_ai_kind, LocalAiKind::Ollama);
        assert_eq!(d.local_ai_model, "");
        let ok = Settings {
            local_ai_url: " https://gpu-box.lan:1234/ ".into(),
            local_ai_model: " llama3.2:3b ".into(),
            local_ai_kind: LocalAiKind::OpenaiCompatible,
            ..Default::default()
        };
        let v = validate(ok).unwrap();
        assert_eq!(v.local_ai_url, "https://gpu-box.lan:1234");
        assert_eq!(v.local_ai_model, "llama3.2:3b");
        for bad in [
            "",
            "localhost:11434",
            "ftp://x",
            "file:///etc/passwd",
            "http://",
            "http://user:pw@localhost:11434",
            "http://localhost:11434/?model=x",
            "http://localhost:11434/#x",
        ] {
            let s = Settings {
                local_ai_url: bad.into(),
                ..Default::default()
            };
            assert!(validate(s).is_err(), "{bad}");
        }
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["aiProvider"], "off");
        assert_eq!(json["localAiKind"], "ollama");
        let s: Settings = serde_json::from_str(r#"{"localAiKind":"openai_compatible"}"#).unwrap();
        assert_eq!(s.local_ai_kind, LocalAiKind::OpenaiCompatible);
    }

    #[test]
    fn phase45_defaults() {
        let s = Settings::default();
        assert!(s.notifications.enabled && s.notifications.outage && s.notifications.data_cap);
        assert_eq!(s.notifications.quiet_start_hour, None);
        assert_eq!(s.data_cap_gb, None);
        assert_eq!(s.billing_cycle_day, 1);
        // Old settings files get the defaults; partial notification objects too.
        let old: Settings =
            serde_json::from_str(r#"{"readOnly": false, "notifications": {"outage": false}}"#)
                .unwrap();
        assert!(!old.notifications.outage);
        assert!(old.notifications.enabled);
        assert_eq!(old.billing_cycle_day, 1);
        let ok = Settings {
            data_cap_gb: Some(250.0),
            billing_cycle_day: 28,
            notifications: NotificationSettings {
                quiet_start_hour: Some(22),
                quiet_end_hour: Some(7),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate(ok).is_ok());
    }

    #[test]
    fn close_to_tray_default_depends_on_platform() {
        assert_eq!(
            Settings::default().close_to_tray,
            !cfg!(target_os = "linux")
        );
        // Older settings files without the field get the platform default.
        let s: Settings = serde_json::from_str(r#"{"readOnly": true}"#).unwrap();
        assert_eq!(s.close_to_tray, Settings::default().close_to_tray);
    }

    #[test]
    fn reconnect_detection() {
        let a = Settings::default();
        let mut b = a.clone();
        b.read_only = false;
        b.claude_model = "other".into();
        assert!(!needs_reconnect(&a, &b));
        b.mock_mode = MockMode::On;
        assert!(needs_reconnect(&a, &b));
        let mut c = a.clone();
        c.mock_profile = MockProfile::Obstructed;
        assert!(needs_reconnect(&a, &c));
    }

    #[test]
    fn save_load_roundtrip_and_corrupt_file() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-settings-test-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        let path = dir.join(SETTINGS_FILE);
        assert_eq!(load(&path), Settings::default());
        let s = Settings {
            read_only: false,
            mock_mode: MockMode::On,
            ..Default::default()
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        // Partial file: missing fields take defaults.
        std::fs::write(&path, r#"{"mockMode":"on"}"#).unwrap();
        let partial = load(&path);
        assert_eq!(partial.mock_mode, MockMode::On);
        assert!(partial.read_only);
        std::fs::remove_dir_all(&dir).ok();
    }
}
