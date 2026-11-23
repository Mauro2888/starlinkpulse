//! Internal error types and their mapping to the frontend `CommandError`.
//!
//! Error messages must never contain device IDs, MAC/IP addresses, GPS data or the API key.

use thiserror::Error;

use crate::models::CommandError;

/// Errors produced while talking to the dish or the router.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ClientError {
    #[error("device unreachable: {0}")]
    Unreachable(String),
    #[error("request timed out")]
    Timeout,
    /// The device does not implement the request (`Unimplemented` / `PermissionDenied`)
    /// or the schema lacks the request/field.
    #[error("not supported by this device")]
    Unsupported,
    /// gRPC `PermissionDenied`. For reads it means "unsupported"; for writes it means the
    /// firmware blocks the change from the local network.
    #[error("permission denied by the device")]
    PermissionDenied,
    #[error("schema error: {0}")]
    Schema(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("rpc error: {0}")]
    Rpc(String),
}

impl ClientError {
    /// True when the error means "device not reachable right now".
    pub fn is_connectivity(&self) -> bool {
        matches!(self, ClientError::Unreachable(_) | ClientError::Timeout)
    }

    /// True for `Unimplemented` and `PermissionDenied` (capability not available).
    pub fn is_unsupported(&self) -> bool {
        matches!(
            self,
            ClientError::Unsupported | ClientError::PermissionDenied
        )
    }
}

impl From<tonic::Status> for ClientError {
    fn from(status: tonic::Status) -> Self {
        use tonic::Code;
        // Only the status code is kept: server messages could contain arbitrary data.
        match status.code() {
            Code::Unimplemented => ClientError::Unsupported,
            Code::PermissionDenied => ClientError::PermissionDenied,
            Code::DeadlineExceeded => ClientError::Timeout,
            Code::Unavailable | Code::Cancelled => {
                ClientError::Unreachable(format!("{:?}", status.code()))
            }
            other => ClientError::Rpc(format!("{other:?}")),
        }
    }
}

/// Application-level error, converted into [`CommandError`] at the command boundary.
#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error("read-only mode is enabled; disable it in settings to send commands")]
    ReadOnly,
    /// A write was rejected with `PermissionDenied` (firmware requires the Starlink app).
    #[error(
        "This dish firmware does not allow this change from the local network. Use the Starlink app."
    )]
    WriteDenied,
    #[error("not supported: {0}")]
    Unsupported(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("keyring: {0}")]
    Keyring(String),
    #[error("no Anthropic API key configured; add one in settings")]
    NoApiKey,
    #[error("{0}")]
    AiAuth(String),
    #[error("{0}")]
    AiRateLimit(String),
    #[error("{0}")]
    AiUnavailable(String),
    #[error("the model declined to analyze this data")]
    AiRefused,
    #[error(
        "Not enough history yet: StarlinkPulse needs at least 1 hour of data. Keep the app running and try again."
    )]
    InsufficientData,
    #[error("invalid AI response: {0}")]
    AiInvalidResponse(String),
    /// Network failure towards a remote service (not the dish).
    #[error("{0}")]
    Network(String),
    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Client(ClientError::Unsupported | ClientError::PermissionDenied)
            | AppError::Unsupported(_)
            | AppError::WriteDenied => "unsupported",
            AppError::Client(ClientError::Timeout) => "timeout",
            AppError::Client(ClientError::Unreachable(_)) => "offline",
            AppError::Client(_) => "internal",
            AppError::ReadOnly => "read_only",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::Keyring(_) => "keyring",
            AppError::NoApiKey => "no_api_key",
            AppError::AiAuth(_) => "ai_auth",
            AppError::AiRateLimit(_) => "ai_rate_limit",
            AppError::AiUnavailable(_) => "ai_unavailable",
            AppError::AiRefused => "ai_refused",
            AppError::InsufficientData => "insufficient_data",
            AppError::AiInvalidResponse(_) => "ai_invalid_response",
            AppError::Network(_) => "offline",
            AppError::Storage(_) | AppError::Io(_) | AppError::Internal(_) => "internal",
        }
    }
}

impl AppError {
    /// Message shown to the user in `lang`. Known fixed messages are translated; dynamic
    /// ones (server texts, validation details) stay as they are.
    pub fn localized_message(&self, lang: crate::i18n::Lang) -> String {
        use crate::i18n::{ErrorTexts, Lang};
        if lang == Lang::En {
            return self.to_string();
        }
        let t = ErrorTexts::get(lang);
        let en = &ErrorTexts::EN;
        match self {
            AppError::ReadOnly => t.read_only.into(),
            AppError::WriteDenied => t.write_denied.into(),
            AppError::InsufficientData => t.insufficient_data.into(),
            AppError::NoApiKey => t.no_api_key.into(),
            AppError::AiRefused => t.ai_refused.into(),
            AppError::InvalidInput(m) | AppError::Unsupported(m) => {
                let pairs = [
                    (en.ai_off, t.ai_off),
                    (en.alignment_manual_only, t.alignment_manual_only),
                ];
                pairs
                    .iter()
                    .find(|(e, _)| m == e)
                    .map(|(_, l)| l.to_string())
                    .unwrap_or_else(|| self.to_string())
            }
            AppError::Network(m) if m == crate::weather::UNREACHABLE => {
                t.weather_unreachable.into()
            }
            AppError::Client(ClientError::Unreachable(m)) if m == "not connected" => {
                t.not_connected.into()
            }
            _ => self.to_string(),
        }
    }
}

impl From<AppError> for CommandError {
    fn from(err: AppError) -> Self {
        CommandError {
            kind: err.kind().to_string(),
            message: err.localized_message(crate::i18n::current()),
        }
    }
}

impl From<ClientError> for CommandError {
    fn from(err: ClientError) -> Self {
        AppError::from(err).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tonic_codes_map_to_unsupported() {
        let e: ClientError = tonic::Status::unimplemented("x").into();
        assert_eq!(e, ClientError::Unsupported);
        let e: ClientError = tonic::Status::permission_denied("x").into();
        assert_eq!(e, ClientError::PermissionDenied);
        assert!(e.is_unsupported());
        // Reads: PermissionDenied is still reported as "unsupported".
        let c: CommandError = e.into();
        assert_eq!(c.kind, "unsupported");
        let c: CommandError = AppError::WriteDenied.into();
        assert_eq!(c.kind, "unsupported");
        assert!(c.message.contains("Starlink app"));
        let e: ClientError = tonic::Status::deadline_exceeded("x").into();
        assert_eq!(e, ClientError::Timeout);
    }

    #[test]
    fn italian_error_messages() {
        use crate::i18n::Lang;
        assert_eq!(
            AppError::ReadOnly.localized_message(Lang::It),
            "La modalità sola lettura è attiva; disattivala nelle Impostazioni per inviare comandi alla parabola."
        );
        assert!(
            AppError::InsufficientData
                .localized_message(Lang::It)
                .starts_with("Storico ancora insufficiente")
        );
        assert_eq!(
            AppError::InvalidInput("AI explanations are turned off".into())
                .localized_message(Lang::It),
            "Le spiegazioni AI sono disattivate"
        );
        assert_eq!(
            AppError::Client(ClientError::Unreachable("not connected".into()))
                .localized_message(Lang::It),
            "Non connesso alla parabola."
        );
        // Dynamic messages are kept; English is unchanged.
        let dynamic = AppError::InvalidInput("days must be between 7 and 90".into());
        assert_eq!(dynamic.localized_message(Lang::It), dynamic.to_string());
        assert_eq!(
            AppError::ReadOnly.localized_message(Lang::En),
            AppError::ReadOnly.to_string()
        );
    }

    #[test]
    fn command_error_kinds() {
        let c: CommandError = AppError::ReadOnly.into();
        assert_eq!(c.kind, "read_only");
        let c: CommandError = ClientError::Unsupported.into();
        assert_eq!(c.kind, "unsupported");
        let c: CommandError = ClientError::Unreachable("x".into()).into();
        assert_eq!(c.kind, "offline");
    }
}
