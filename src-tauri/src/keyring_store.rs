//! Anthropic API key storage in the OS keyring (ADR-005). The key is never logged,
//! returned to the frontend or written to settings.
//!
//! Linux fallback (opt-in, ADR-005): when the Secret Service is unavailable and the app was
//! started with `STARLINKPULSE_KEYRING_FILE=1`, the key is stored in
//! `<app_data_dir>/anthropic-api-key` with permissions 0600. The file is plain text protected
//! only by file permissions; it is never used unless explicitly enabled. The settings
//! contract is unchanged.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use keyring::Entry;

use crate::error::AppError;

pub const SERVICE: &str = "StarlinkPulse";
pub const USER: &str = "anthropic-api-key";
/// Environment variable enabling the Linux file fallback.
pub const FILE_FALLBACK_ENV: &str = "STARLINKPULSE_KEYRING_FILE";
pub const KEY_FILE_NAME: &str = "anthropic-api-key";
const MAX_KEY_LEN: usize = 512;

static FALLBACK_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Enables the file fallback in `data_dir` when running on Linux with
/// `STARLINKPULSE_KEYRING_FILE=1`. Called once at startup.
pub fn init_file_fallback(data_dir: &Path) {
    if cfg!(target_os = "linux") && std::env::var(FILE_FALLBACK_ENV).as_deref() == Ok("1") {
        let _ = FALLBACK_DIR.set(data_dir.to_path_buf());
        tracing::warn!("keyring file fallback enabled ({FILE_FALLBACK_ENV}=1)");
    }
}

fn fallback_path() -> Option<PathBuf> {
    FALLBACK_DIR.get().map(|d| d.join(KEY_FILE_NAME))
}

fn is_unavailable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

fn map_err(e: keyring::Error) -> AppError {
    // keyring errors never include the secret itself.
    if is_unavailable(&e) {
        return AppError::Keyring(if cfg!(target_os = "linux") {
            format!(
                "the OS keyring is not available; install and unlock a Secret Service provider \
                 (e.g. GNOME Keyring or KWallet), or start the app with {FILE_FALLBACK_ENV}=1 \
                 to store the key in a private file"
            )
        } else {
            "the OS keyring is not available".into()
        });
    }
    AppError::Keyring(e.to_string())
}

fn entry() -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, USER)
}

// --- file fallback (0600) ---------------------------------------------------

/// Writes the key with owner-only permissions.
pub fn file_write(path: &Path, key: &str) -> Result<(), AppError> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    #[cfg(unix)]
    {
        // An existing file keeps its old mode on open: enforce 0600.
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(key.as_bytes())?;
    f.sync_all()?;
    Ok(())
}

pub fn file_read(path: &Path) -> Result<Option<String>, AppError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s.trim().to_string()).filter(|k| !k.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn file_delete(path: &Path) -> Result<(), AppError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// --- public API ---------------------------------------------------------------

/// Validates a key before storing it (trimmed, non-empty, no whitespace/control chars).
pub fn validate_key(key: &str) -> Result<&str, AppError> {
    let k = key.trim();
    if k.is_empty()
        || k.len() > MAX_KEY_LEN
        || k.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::InvalidInput("API key format is invalid".into()));
    }
    Ok(k)
}

pub fn set_api_key(key: &str) -> Result<(), AppError> {
    let k = validate_key(key)?;
    match entry().and_then(|e| e.set_password(k)) {
        Ok(()) => {
            tracing::info!("API key stored in keyring");
            Ok(())
        }
        Err(e) if is_unavailable(&e) && fallback_path().is_some() => {
            file_write(&fallback_path().unwrap_or_default(), k)?;
            tracing::info!("API key stored in fallback file");
            Ok(())
        }
        Err(e) => Err(map_err(e)),
    }
}

pub fn has_api_key() -> Result<bool, AppError> {
    Ok(get_api_key()?.is_some())
}

pub fn delete_api_key() -> Result<(), AppError> {
    let keyring = match entry().and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) if is_unavailable(&e) && fallback_path().is_some() => Ok(()),
        Err(e) => Err(map_err(e)),
    };
    if let Some(p) = fallback_path() {
        file_delete(&p)?;
    }
    keyring?;
    tracing::info!("API key removed");
    Ok(())
}

/// Reads the key for the AI module. Never log the result.
pub fn get_api_key() -> Result<Option<String>, AppError> {
    match entry().and_then(|e| e.get_password()) {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) if is_unavailable(&e) => match fallback_path() {
            Some(p) => file_read(&p),
            None => Err(map_err(e)),
        },
        Err(e) => Err(map_err(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_validation() {
        assert!(validate_key("").is_err());
        assert!(validate_key("   ").is_err());
        assert!(validate_key("sk-ant abc").is_err());
        assert!(validate_key(&"x".repeat(600)).is_err());
        assert_eq!(
            validate_key("  sk-ant-api03-abc  ").unwrap(),
            "sk-ant-api03-abc"
        );
    }

    #[test]
    fn platform_failure_maps_to_keyring_kind() {
        let e = map_err(keyring::Error::NoStorageAccess("x".into()));
        assert_eq!(e.kind(), "keyring");
    }

    #[test]
    fn fallback_file_is_private_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-keyfile-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        let path = dir.join(KEY_FILE_NAME);
        assert_eq!(file_read(&path).unwrap(), None);
        file_write(&path, "sk-ant-test-1").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            // A pre-existing file with wider permissions is tightened on write.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            file_write(&path, "sk-ant-test-2").unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        #[cfg(not(unix))]
        file_write(&path, "sk-ant-test-2").unwrap();
        assert_eq!(file_read(&path).unwrap().as_deref(), Some("sk-ant-test-2"));
        file_delete(&path).unwrap();
        file_delete(&path).unwrap(); // idempotent
        assert_eq!(file_read(&path).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fallback_is_off_by_default() {
        // Not initialized in tests: no fallback path, keyring errors surface as before.
        assert!(fallback_path().is_none());
    }
}
