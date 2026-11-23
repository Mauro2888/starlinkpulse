//! Shared application state.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{Notify, RwLock};

use crate::dish::reflection::SchemaCache;
use crate::dish::{StarlinkClient, WifiClientInfo};
use crate::error::AppError;
use crate::models::{ConnectionStatus, DishCapabilities, MockProfile, Settings, TelemetrySnapshot};
use crate::settings;
use crate::storage::Db;
use crate::write_denials::{DENIALS_FILE, WriteDenials};

/// Receives backend events (Tauri emitter + tray in the app, a recorder in tests).
pub trait EventSink: Send + Sync {
    fn telemetry(&self, snapshot: &TelemetrySnapshot);
    fn connection_status(&self, status: &ConnectionStatus);
    fn capabilities(&self, caps: &DishCapabilities);
    /// Shows a desktop notification (already filtered by the engine).
    fn notify(&self, _n: &crate::notify::Notification) {}
    /// The UI language changed (tray menu texts are rebuilt).
    fn language_changed(&self) {}
    /// `alignment-mode` event.
    fn alignment_mode(&self, _e: &crate::models::AlignmentModeEvent) {}
}

/// Sink that discards everything.
#[derive(Debug, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn telemetry(&self, _: &TelemetrySnapshot) {}
    fn connection_status(&self, _: &ConnectionStatus) {}
    fn capabilities(&self, _: &DishCapabilities) {}
}

pub struct AppState {
    settings_path: Option<PathBuf>,
    pub settings: RwLock<Settings>,
    pub client: RwLock<Option<Arc<dyn StarlinkClient>>>,
    pub status: RwLock<ConnectionStatus>,
    pub capabilities: RwLock<DishCapabilities>,
    /// Id of the current connection session (incremented on every (re)connect).
    pub session: AtomicU64,
    /// Session the current `capabilities` were detected for (0 = none).
    pub caps_session: AtomicU64,
    pub snapshot: RwLock<Option<TelemetrySnapshot>>,
    /// Latest power sample and when it was read (Unix ms).
    pub power_cache: RwLock<Option<(Option<f64>, i64)>>,
    /// Sanitized Wi-Fi clients from the Starlink router (empty when absent).
    pub wifi_clients: RwLock<Vec<WifiClientInfo>>,
    /// When `wifi_clients` was last refreshed (Unix ms).
    pub wifi_updated_ms: RwLock<Option<i64>>,
    /// Read-only LAN dashboard server.
    pub lan: tokio::sync::Mutex<crate::lan::LanServer>,
    /// History of the real dish (file-backed).
    pub db: Arc<Mutex<Db>>,
    /// History of the mock dish (in memory, never mixed with real data).
    pub mock_db: Arc<Mutex<Db>>,
    /// Profile the mock database was filled with.
    pub mock_db_profile: Mutex<Option<MockProfile>>,
    pub schema_cache: Option<SchemaCache>,
    denials_path: Option<PathBuf>,
    /// Writes rejected by the firmware, per software version (persisted).
    pub write_denials: Mutex<WriteDenials>,
    /// Event sink, set by the service (used by commands to emit `capabilities`).
    pub sink: RwLock<Option<Arc<dyn EventSink>>>,
    /// Dish address the notification markers belong to.
    pub notified_dish_address: Mutex<Option<String>>,
    /// Notification decisions (transitions, cooldown).
    pub notifier: Mutex<crate::notify::NotificationEngine>,
    /// OS login item (launch at login); set at startup by the app.
    pub login_item: RwLock<Option<Arc<dyn crate::autostart::LoginItem>>>,
    /// Guided alignment mode (fast read-only polling), bound to a connection session.
    pub alignment: Mutex<Option<crate::alignment::AlignmentSession>>,
    /// Wakes the live poll when alignment mode changes (interval switch).
    pub alignment_changed: Notify,
    /// Held while an AI analysis runs (one at a time).
    pub ai_lock: tokio::sync::Mutex<()>,
    /// Signalled when settings require a reconnect.
    pub reconnect: Notify,
}

/// Locks a database mutex, recovering from poisoning (a panicked writer leaves SQLite
/// consistent thanks to transactions).
pub fn lock_db(db: &Mutex<Db>) -> MutexGuard<'_, Db> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

impl AppState {
    /// Production state rooted in `app_data_dir`.
    pub fn new(data_dir: &Path) -> Result<Self, AppError> {
        std::fs::create_dir_all(data_dir)?;
        let settings_path = data_dir.join(settings::SETTINGS_FILE);
        let mut settings = settings::load(&settings_path);
        if settings.lan_dashboard.token.is_empty() {
            settings.lan_dashboard.token = crate::lan::generate_token();
            if let Err(e) = settings::save(&settings_path, &settings) {
                tracing::warn!(error = %e, "could not save the LAN dashboard access code");
            }
        }
        let db = Db::open(&data_dir.join("history.db"))?;
        let mut state = Self::build(
            Some(settings_path),
            settings,
            db,
            Some(SchemaCache::new(data_dir.join("schema"))),
        )?;
        let denials_path = data_dir.join(DENIALS_FILE);
        state.write_denials = Mutex::new(WriteDenials::load(&denials_path));
        state.denials_path = Some(denials_path);
        Ok(state)
    }

    /// In-memory state (tests).
    pub fn in_memory(settings: Settings) -> Result<Self, AppError> {
        Self::build(None, settings, Db::open_in_memory()?, None)
    }

    fn build(
        settings_path: Option<PathBuf>,
        settings: Settings,
        db: Db,
        schema_cache: Option<SchemaCache>,
    ) -> Result<Self, AppError> {
        let status = ConnectionStatus {
            dish_address: settings.dish_address.clone(),
            ..Default::default()
        };
        Ok(Self {
            settings_path,
            settings: RwLock::new(settings),
            client: RwLock::new(None),
            status: RwLock::new(status),
            capabilities: RwLock::new(DishCapabilities::default()),
            session: AtomicU64::new(0),
            caps_session: AtomicU64::new(0),
            snapshot: RwLock::new(None),
            power_cache: RwLock::new(None),
            wifi_clients: RwLock::new(Vec::new()),
            wifi_updated_ms: RwLock::new(None),
            lan: tokio::sync::Mutex::new(crate::lan::LanServer::default()),
            db: Arc::new(Mutex::new(db)),
            mock_db: Arc::new(Mutex::new(Db::open_in_memory()?)),
            mock_db_profile: Mutex::new(None),
            schema_cache,
            denials_path: None,
            write_denials: Mutex::new(WriteDenials::default()),
            sink: RwLock::new(None),
            ai_lock: tokio::sync::Mutex::new(()),
            alignment: Mutex::new(None),
            alignment_changed: Notify::new(),
            login_item: RwLock::new(None),
            notifier: Mutex::new(crate::notify::NotificationEngine::new()),
            notified_dish_address: Mutex::new(None),
            reconnect: Notify::new(),
        })
    }

    /// Database matching the data source.
    pub fn db_for(&self, is_mock: bool) -> Arc<Mutex<Db>> {
        if is_mock {
            self.mock_db.clone()
        } else {
            self.db.clone()
        }
    }

    /// Database of the currently active client (real DB when not connected).
    pub async fn current_db(&self) -> Arc<Mutex<Db>> {
        let is_mock = self
            .client
            .read()
            .await
            .as_ref()
            .is_some_and(|c| c.is_mock());
        self.db_for(is_mock)
    }

    /// Starts a new connection session: drops the client and resets capabilities (no write
    /// capability) BEFORE a new client is installed, so stale capabilities of a previous
    /// dish/mock can never authorize a write on the new one.
    pub async fn begin_session(&self) -> u64 {
        let mut caps = self.capabilities.write().await;
        *self.client.write().await = None;
        *caps = DishCapabilities::default();
        let id = self.session.fetch_add(1, Ordering::SeqCst) + 1;
        // New connection: the next status is a notification baseline again.
        self.notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reset();
        self.caps_session.store(0, Ordering::SeqCst);
        id
    }

    /// Publishes capabilities detected for session `id`; ignored if a newer session started.
    pub async fn set_capabilities(&self, id: u64, caps: DishCapabilities) -> bool {
        let mut guard = self.capabilities.write().await;
        if self.session.load(Ordering::SeqCst) != id {
            return false;
        }
        *guard = caps;
        self.caps_session.store(id, Ordering::SeqCst);
        true
    }

    /// Capabilities and client, only if the capabilities were detected for the current
    /// session and match the client kind (real vs mock).
    pub async fn session_caps_and_client(
        &self,
    ) -> Option<(DishCapabilities, Arc<dyn StarlinkClient>)> {
        let caps = self.capabilities.read().await;
        let client = self.client.read().await.clone()?;
        let current = self.session.load(Ordering::SeqCst);
        if self.caps_session.load(Ordering::SeqCst) != current || caps.is_mock != client.is_mock() {
            return None;
        }
        Some((caps.clone(), client))
    }

    /// Disables capabilities whose writes were previously denied for this firmware.
    pub fn apply_write_denials(&self, caps: &mut DishCapabilities) {
        self.write_denials
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .apply(caps);
    }

    /// Updates the known snow-melt mode and emits `capabilities`.
    pub async fn update_snow_melt_mode(&self, mode: crate::models::SnowMeltMode) {
        let caps = {
            let mut caps = self.capabilities.write().await;
            caps.snow_melt_mode = Some(mode);
            caps.clone()
        };
        if let Some(sink) = self.sink.read().await.as_ref() {
            sink.capabilities(&caps);
        }
    }

    /// Records a firmware write denial, persists it, downgrades the live capabilities and
    /// emits `capabilities`.
    pub async fn record_write_denial(&self, action: crate::dish::WriteAction) {
        let mut caps = self.capabilities.write().await;
        let snapshot = {
            let mut denials = self.write_denials.lock().unwrap_or_else(|p| p.into_inner());
            denials.record(caps.software_version.as_deref(), action);
            denials.apply(&mut caps);
            denials.clone()
        };
        let caps_now = caps.clone();
        drop(caps);
        if let Some(path) = &self.denials_path
            && let Err(e) = snapshot.save(path)
        {
            tracing::warn!(error = %e, "could not persist write denial");
        }
        tracing::info!(?action, "write denied by firmware; capability disabled");
        if let Some(sink) = self.sink.read().await.as_ref() {
            sink.capabilities(&caps_now);
        }
    }

    /// Validates, persists and applies new settings; triggers a reconnect when needed.
    pub async fn update_settings(&self, mut new: Settings) -> Result<Settings, AppError> {
        // An empty access code keeps the current one (it is only changed by
        // `regenerate_lan_token`).
        if new.lan_dashboard.token.is_empty() {
            new.lan_dashboard.token = self.settings.read().await.lan_dashboard.token.clone();
        }
        let new = settings::validate(new)?;
        // Apply launch-at-login first: if the OS refuses, nothing is saved.
        let old_login = self.settings.read().await.launch_at_login;
        if old_login != new.launch_at_login
            && let Some(item) = self.login_item.read().await.clone()
        {
            crate::autostart::sync_login_item(item.as_ref(), new.launch_at_login)?;
        }
        if let Some(path) = &self.settings_path {
            settings::save(path, &new)?;
        }
        let mut guard = self.settings.write().await;
        let reconnect = settings::needs_reconnect(&guard, &new);
        let language_changed = guard.language != new.language;
        *guard = new.clone();
        drop(guard);
        if language_changed {
            crate::i18n::set_current(crate::i18n::resolve(
                new.language,
                crate::i18n::os_locale().as_deref(),
            ));
            if let Some(sink) = self.sink.read().await.as_ref() {
                sink.language_changed();
            }
        }
        if reconnect {
            tracing::info!("settings changed, reconnecting");
            self.reconnect.notify_one();
        }
        Ok(new)
    }
}
