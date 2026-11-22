//! Launch at login (Phase 5) via `tauri-plugin-autostart`, driven from Rust.
//!
//! Platform mechanics (handled by the plugin):
//! - macOS: a LaunchAgent plist in `~/Library/LaunchAgents` (`MacosLauncher::LaunchAgent`,
//!   no extra permission prompt; the user can remove it in System Settings > Login Items).
//! - Windows: a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//! - Linux: a `.desktop` file in `~/.config/autostart` (XDG autostart).
//!
//! The setting is the source of truth: at startup the OS state is synced to
//! `settings.launchAtLogin`, and `update_settings` applies changes before saving them.

use crate::error::AppError;

/// Command-line flag passed by the login item; the app then starts hidden in the tray.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// OS login item (real plugin in the app, fake in tests).
pub trait LoginItem: Send + Sync {
    fn is_enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
}

/// Makes the OS state match `want`. Returns true when something changed.
pub fn sync_login_item(item: &dyn LoginItem, want: bool) -> Result<bool, AppError> {
    let current = item
        .is_enabled()
        .map_err(|e| AppError::Internal(format!("could not read the login item: {e}")))?;
    if current == want {
        return Ok(false);
    }
    item.set_enabled(want)
        .map_err(|e| AppError::Internal(format!("could not change the login item: {e}")))?;
    tracing::info!(enabled = want, "launch at login updated");
    Ok(true)
}

/// Login item backed by `tauri-plugin-autostart`.
pub struct TauriLoginItem(pub tauri::AppHandle);

impl LoginItem for TauriLoginItem {
    fn is_enabled(&self) -> Result<bool, String> {
        use tauri_plugin_autostart::ManagerExt;
        self.0.autolaunch().is_enabled().map_err(|e| e.to_string())
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        let m = self.0.autolaunch();
        if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// In-memory login item; `fail` makes every call fail.
    #[derive(Default)]
    pub(crate) struct FakeLoginItem {
        pub enabled: Mutex<bool>,
        pub fail: bool,
        pub writes: Mutex<u32>,
    }

    impl LoginItem for FakeLoginItem {
        fn is_enabled(&self) -> Result<bool, String> {
            if self.fail {
                return Err("denied".into());
            }
            Ok(*self.enabled.lock().unwrap())
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            if self.fail {
                return Err("denied".into());
            }
            *self.enabled.lock().unwrap() = enabled;
            *self.writes.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[test]
    fn sync_only_writes_on_change() {
        let item = FakeLoginItem::default();
        assert!(!sync_login_item(&item, false).unwrap());
        assert!(sync_login_item(&item, true).unwrap());
        assert!(*item.enabled.lock().unwrap());
        assert!(!sync_login_item(&item, true).unwrap());
        assert_eq!(*item.writes.lock().unwrap(), 1);
        assert!(sync_login_item(&item, false).unwrap());
        let broken = FakeLoginItem {
            fail: true,
            ..Default::default()
        };
        assert_eq!(
            sync_login_item(&broken, true).unwrap_err().kind(),
            "internal"
        );
    }
}
