//! Anthropic API key storage in the OS keyring (ADR-005). The key is never logged,
//! returned to the frontend or written to settings.

use keyring::Entry;

use crate::error::AppError;

pub const SERVICE: &str = "StarlinkPulse";
pub const USER: &str = "anthropic-api-key";
const MAX_KEY_LEN: usize = 512;

fn map_err(e: keyring::Error) -> AppError {
    // keyring errors never include the secret itself.
    match e {
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
            AppError::Keyring(if cfg!(target_os = "linux") {
                "the OS keyring is not available; install and unlock a Secret Service provider \
                 (e.g. GNOME Keyring or KWallet)"
                    .into()
            } else {
                "the OS keyring is not available".into()
            })
        }
        other => AppError::Keyring(other.to_string()),
    }
}

fn entry() -> Result<Entry, AppError> {
    Entry::new(SERVICE, USER).map_err(map_err)
}

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
    entry()?.set_password(k).map_err(map_err)?;
    tracing::info!("API key stored in keyring");
    Ok(())
}

pub fn has_api_key() -> Result<bool, AppError> {
    match entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(map_err(e)),
    }
}

pub fn delete_api_key() -> Result<(), AppError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            tracing::info!("API key removed from keyring");
            Ok(())
        }
        Err(e) => Err(map_err(e)),
    }
}

/// Reads the key for the AI module. Never log the result.
pub fn get_api_key() -> Result<Option<String>, AppError> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
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
}
