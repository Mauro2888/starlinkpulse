//! System tray (all platforms) + event emission to the frontend.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{Lang, TrayTexts};
use crate::models::{
    ConnectionState, ConnectionStatus, DishCapabilities, Readiness, TelemetrySnapshot,
};
use crate::state::EventSink;

pub const MAIN_WINDOW: &str = "main";
pub const EVENT_TELEMETRY: &str = "telemetry";
pub const EVENT_CONNECTION_STATUS: &str = "connection-status";
pub const EVENT_CAPABILITIES: &str = "capabilities";
pub const EVENT_ALIGNMENT_MODE: &str = "alignment-mode";

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
pub fn status_line(lang: Lang, state: ConnectionState, latency_ms: Option<f64>) -> String {
    let t = TrayTexts::get(lang);
    let label = match state {
        ConnectionState::Connecting => t.connecting,
        ConnectionState::Connected => t.connected,
        ConnectionState::Offline => t.offline,
        ConnectionState::Mock => t.mock,
    };
    match (state, latency_ms) {
        (ConnectionState::Connected | ConnectionState::Mock, Some(l)) => {
            format!("{label} · {}", ping_title(l))
        }
        _ => label.to_string(),
    }
}

/// "Video ✓ · Gaming ~ · Streaming ✓".
pub fn readiness_text(lang: Lang, r: &Readiness) -> String {
    use crate::readiness::mark;
    let t = TrayTexts::get(lang);
    format!(
        "{} {} · {} {} · {} {}",
        t.video,
        mark(r.video_call),
        t.gaming,
        mark(r.gaming),
        t.streaming,
        mark(r.streaming)
    )
}

/// Tooltip, e.g. "StarlinkPulse – Connected · 26 ms · Video ✓ · Gaming ~ · Streaming ✓".
pub fn tooltip(lang: Lang, line: &str, readiness: Option<&Readiness>) -> String {
    match readiness {
        Some(r) => format!("StarlinkPulse – {line} · {}", readiness_text(lang, r)),
        None => format!("StarlinkPulse – {line}"),
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
    toggle_item: MenuItem<Wry>,
    quit_item: MenuItem<Wry>,
    last: Mutex<(ConnectionState, Option<f64>, Option<Readiness>)>,
}

impl TraySink {
    fn refresh(
        &self,
        state: Option<ConnectionState>,
        live: Option<(Option<f64>, Option<Readiness>)>,
    ) {
        let (st, lat, ready) = {
            let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = state {
                last.0 = s;
            }
            if let Some((l, r)) = live {
                last.1 = l;
                last.2 = r;
            }
            *last
        };
        let lang = crate::i18n::current();
        let is_live = matches!(st, ConnectionState::Connected | ConnectionState::Mock);
        let lat = lat.filter(|_| is_live);
        let ready = ready.filter(|_| is_live);
        let line = status_line(lang, st, lat);
        let _ = self.status_item.set_text(&line);
        let _ = self
            .tray
            .set_tooltip(Some(tooltip(lang, &line, ready.as_ref())));
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
        self.refresh(
            None,
            Some((snapshot.pop_ping_latency_ms, snapshot.readiness)),
        );
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

    fn language_changed(&self) {
        // Rebuild the menu texts in the new language.
        let t = TrayTexts::get(crate::i18n::current());
        let _ = self.toggle_item.set_text(t.show_hide);
        let _ = self.quit_item.set_text(t.quit);
        self.refresh(None, None);
    }

    fn alignment_mode(&self, e: &crate::models::AlignmentModeEvent) {
        if let Err(err) = self.app.emit(EVENT_ALIGNMENT_MODE, e) {
            tracing::debug!(error = %err, "emit alignment-mode failed");
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
    let lang = crate::i18n::current();
    let t = TrayTexts::get(lang);
    let toggle = MenuItem::with_id(app, "toggle", t.show_hide, true, None::<&str>)?;
    let status_item = MenuItem::with_id(
        app,
        "status",
        status_line(lang, ConnectionState::Connecting, None),
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
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
    // macOS menu bar: monochrome template icon (adapts to light/dark menu bar).
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-template.png"
            ))?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
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
        toggle_item: toggle,
        quit_item: quit,
        last: Mutex::new((ConnectionState::Connecting, None, None)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines() {
        use crate::models::ReadinessLevel::*;
        let en = Lang::En;
        assert_eq!(
            status_line(en, ConnectionState::Connected, Some(26.4)),
            "Connected · 26 ms"
        );
        assert_eq!(
            status_line(en, ConnectionState::Mock, Some(31.6)),
            "Mock data · 32 ms"
        );
        assert_eq!(
            status_line(en, ConnectionState::Offline, Some(20.0)),
            "Offline"
        );
        assert_eq!(
            status_line(Lang::It, ConnectionState::Connected, None),
            "Connesso"
        );
        assert_eq!(ping_title(25.5), "26 ms");
        let r = Readiness {
            video_call: Good,
            gaming: Fair,
            streaming: Poor,
        };
        assert_eq!(
            tooltip(en, "Connected · 26 ms", Some(&r)),
            "StarlinkPulse – Connected · 26 ms · Video ✓ · Gaming ~ · Streaming ✗"
        );
        assert_eq!(
            readiness_text(Lang::It, &r),
            "Video ✓ · Gioco ~ · Streaming ✗"
        );
        assert_eq!(tooltip(en, "Offline", None), "StarlinkPulse – Offline");
    }
}
