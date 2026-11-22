//! Guided alignment mode (Phase 4.8): while enabled, the live poll reads `get_status` every
//! second (read-only) so the UI can guide a manual dish into position. Only for dishes
//! without motors; stops automatically after 10 minutes, on reconnect, and when switching
//! between the real dish and the mock.

use std::sync::Arc;
use std::time::Duration;

use crate::error::{AppError, ClientError};
use crate::models::{ActuatorSupport, AlignmentModeEvent};
use crate::state::AppState;
use crate::time::now_ms;

/// Poll period while alignment mode is on.
pub const FAST_POLL: Duration = Duration::from_secs(1);
/// Automatic stop.
pub const MAX_DURATION_MS: i64 = 10 * 60_000;
/// How often `alignment-mode` repeats the remaining time while active.
pub const EVENT_EVERY_MS: i64 = 30_000;

/// Active alignment mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignmentSession {
    /// Connection session it belongs to (a reconnect ends it).
    pub session_id: u64,
    pub until_ms: i64,
}

/// Remaining milliseconds when `mode` is active for `session_id` at `now`.
pub fn remaining_ms(mode: Option<AlignmentSession>, session_id: u64, now: i64) -> Option<i64> {
    mode.filter(|m| m.session_id == session_id && now < m.until_ms)
        .map(|m| m.until_ms - now)
}

/// Live poll period: 1 s while aligning, otherwise the configured interval.
pub fn poll_period(base: Duration, aligning: bool) -> Duration {
    if aligning { FAST_POLL.min(base) } else { base }
}

fn event(remaining_ms: Option<i64>) -> AlignmentModeEvent {
    match remaining_ms {
        Some(ms) => AlignmentModeEvent {
            enabled: true,
            remaining_s: ((ms + 999) / 1000).max(0) as u32,
        },
        None => AlignmentModeEvent::default(),
    }
}

fn current_session(state: &AppState) -> u64 {
    state.session.load(std::sync::atomic::Ordering::SeqCst)
}

/// Remaining ms of alignment mode for the current session, if active.
pub fn active_remaining_ms(state: &AppState, now: i64) -> Option<i64> {
    let mode = *state.alignment.lock().unwrap_or_else(|p| p.into_inner());
    remaining_ms(mode, current_session(state), now)
}

async fn emit(state: &AppState, e: AlignmentModeEvent) {
    if let Some(sink) = state.sink.read().await.as_ref() {
        sink.alignment_mode(&e);
    }
}

/// Starts or stops alignment mode (the `set_alignment_mode` command).
pub async fn set_mode(state: &AppState, enabled: bool) -> Result<AlignmentModeEvent, AppError> {
    if !enabled {
        stop(state).await;
        return Ok(AlignmentModeEvent::default());
    }
    let Some((caps, client)) = state.session_caps_and_client().await else {
        return Err(ClientError::Unreachable("not connected".into()).into());
    };
    if caps.actuators != ActuatorSupport::No {
        return Err(AppError::InvalidInput(
            "Alignment mode is only available for dishes without motors.".into(),
        ));
    }
    let now = now_ms();
    let mode = AlignmentSession {
        session_id: current_session(state),
        until_ms: now + MAX_DURATION_MS,
    };
    *state.alignment.lock().unwrap_or_else(|p| p.into_inner()) = Some(mode);
    client.alignment_started();
    state.alignment_changed.notify_one();
    let e = event(Some(MAX_DURATION_MS));
    tracing::info!("alignment mode started");
    emit(state, e).await;
    Ok(e)
}

/// Stops alignment mode if it was on (any session); emits `alignment-mode {enabled:false}`.
pub async fn stop(state: &AppState) -> bool {
    let was = state
        .alignment
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .is_some();
    if was {
        state.alignment_changed.notify_one();
        tracing::info!("alignment mode stopped");
        emit(state, AlignmentModeEvent::default()).await;
    }
    was
}

/// Called by the live poll each cycle: handles auto-off and the periodic remaining-time
/// event. Returns whether alignment mode is active.
pub async fn tick(state: &Arc<AppState>, last_event_ms: &mut i64) -> bool {
    let now = now_ms();
    let has_mode = state
        .alignment
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_some();
    match active_remaining_ms(state, now) {
        Some(rem) => {
            if now - *last_event_ms >= EVENT_EVERY_MS {
                *last_event_ms = now;
                emit(state, event(Some(rem))).await;
            }
            true
        }
        None => {
            if has_mode {
                // Expired (10 min) or belongs to an old session.
                stop(state).await;
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_and_period() {
        let m = Some(AlignmentSession {
            session_id: 3,
            until_ms: 10_000,
        });
        assert_eq!(remaining_ms(m, 3, 4_000), Some(6_000));
        assert_eq!(remaining_ms(m, 3, 10_000), None, "auto-off at the deadline");
        assert_eq!(remaining_ms(m, 4, 4_000), None, "other session");
        assert_eq!(remaining_ms(None, 3, 0), None);
        assert_eq!(poll_period(Duration::from_secs(3), true), FAST_POLL);
        assert_eq!(
            poll_period(Duration::from_secs(3), false),
            Duration::from_secs(3)
        );
        assert_eq!(event(Some(1)).remaining_s, 1);
        assert_eq!(event(Some(600_000)).remaining_s, 600);
        assert!(!event(None).enabled);
    }
}
