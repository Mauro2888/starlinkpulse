//! System tray (all platforms) + event emission to the frontend.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::models::{ConnectionState, ConnectionStatus, DishCapabilities, TelemetrySnapshot};
use crate::state::EventSink;

pub const MAIN_WINDOW: &str = "main";
pub const EVENT_TELEMETRY: &str = "telemetry";
pub const EVENT_CONNECTION_STATUS: &str = "connection-status";
pub const EVENT_CAPABILITIES: &str = "capabilities";

/// Shows the main window if hidden, hides it otherwise.
pub fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let visible = win.is_visible().unwrap_or(false);
        let result = if visible {
            win.hide()
        } else {
            win.show().and_then(|_| win.set_focus())
        };
        if let Err(e) = result {
            tracing::warn!(error = %e, "could not toggle main window");
        }
    }
}

/// Text of the disabled status line, e.g. "Connected · 26 ms".
pub fn status_line(state: ConnectionState, latency_ms: Option<f64>) -> String {
    let label = match state {
        ConnectionState::Connecting => "Connecting…",
        ConnectionState::Connected => "Connected",
        ConnectionState::Offline => "Offline",
        ConnectionState::Mock => "Mock data",
    };
    match (state, latency_ms) {
        (ConnectionState::Connected | ConnectionState::Mock, Some(l)) => {
            format!("{label} · {}", ping_title(l))
        }
        _ => label.to_string(),
    }
}

/// Compact ping for the macOS menu bar, e.g. "26 ms".
pub fn ping_title(latency_ms: f64) -> String {
    format!("{} ms", latency_ms.round() as i64)
}

/// Emits events to the webview and mirrors state into the tray.
pub struct TraySink {
    app: AppHandle,
    tray: TrayIcon<Wry>,
    status_item: MenuItem<Wry>,
    last: Mutex<(ConnectionState, Option<f64>)>,
}

impl TraySink {
    fn refresh(&self, state: Option<ConnectionState>, latency: Option<Option<f64>>) {
        let (st, lat) = {
            let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = state {
                last.0 = s;
            }
            if let Some(l) = latency {
                last.1 = l;
            }
            *last
        };
        let live = matches!(st, ConnectionState::Connected | ConnectionState::Mock);
        let lat = lat.filter(|_| live);
        let line = status_line(st, lat);
        let _ = self.status_item.set_text(&line);
        let _ = self
            .tray
            .set_tooltip(Some(format!("StarlinkPulse – {line}")));
        #[cfg(target_os = "macos")]
        {
            let title = lat.map(ping_title).unwrap_or_else(|| "–".to_string());
            let _ = self.tray.set_title(Some(title));
        }
    }
}

impl EventSink for TraySink {
    fn telemetry(&self, snapshot: &TelemetrySnapshot) {
        if let Err(e) = self.app.emit(EVENT_TELEMETRY, snapshot) {
            tracing::debug!(error = %e, "emit telemetry failed");
        }
        self.refresh(None, Some(snapshot.pop_ping_latency_ms));
    }

    fn connection_status(&self, status: &ConnectionStatus) {
        if let Err(e) = self.app.emit(EVENT_CONNECTION_STATUS, status) {
            tracing::debug!(error = %e, "emit connection-status failed");
        }
        self.refresh(Some(status.state), None);
    }

    fn capabilities(&self, caps: &DishCapabilities) {
        if let Err(e) = self.app.emit(EVENT_CAPABILITIES, caps) {
            tracing::debug!(error = %e, "emit capabilities failed");
        }
    }

    fn notify(&self, n: &crate::notify::Notification) {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = self
            .app
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
        {
            tracing::warn!(error = %e, kind = ?n.kind, "could not show notification");
        }
    }
}

/// Builds the tray icon and menu.
pub fn setup(app: &AppHandle) -> tauri::Result<TraySink> {
    let toggle = MenuItem::with_id(app, "toggle", "Show/Hide dashboard", true, None::<&str>)?;
    let status_item = MenuItem::with_id(
        app,
        "status",
        status_line(ConnectionState::Connecting, None),
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit StarlinkPulse", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &status_item, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("StarlinkPulse")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(Some("–"));

    Ok(TraySink {
        app: app.clone(),
        tray,
        status_item,
        last: Mutex::new((ConnectionState::Connecting, None)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines() {
        assert_eq!(
            status_line(ConnectionState::Connected, Some(26.4)),
            "Connected · 26 ms"
        );
        assert_eq!(
            status_line(ConnectionState::Mock, Some(31.6)),
            "Mock data · 32 ms"
        );
        assert_eq!(status_line(ConnectionState::Offline, Some(20.0)), "Offline");
        assert_eq!(status_line(ConnectionState::Connected, None), "Connected");
        assert_eq!(ping_title(25.5), "26 ms");
    }
}
