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

impl From<AppError> for CommandError {
    fn from(err: AppError) -> Self {
        CommandError {
            kind: err.kind().to_string(),
            message: err.to_string(),
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
    fn command_error_kinds() {
        let c: CommandError = AppError::ReadOnly.into();
        assert_eq!(c.kind, "read_only");
        let c: CommandError = ClientError::Unsupported.into();
        assert_eq!(c.kind, "unsupported");
        let c: CommandError = ClientError::Unreachable("x".into()).into();
        assert_eq!(c.kind, "offline");
    }
}
