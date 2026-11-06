//! The real `AudienceSource` (push-notifier.ts `deliveryGate`, desktop-service.ts
//! `remote.notifications`): who hears a notification, read at the moment it is decided. Each paired
//! device's preferences come from the config store, its foreground state from the live relay
//! legs, this PC's idle time and notification support from the host.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::HostNotificationStatus;
use mixdog_core_api::host::{HostCapability, HostChannel};
use mixdog_core_api::ids::Method;
use mixdog_protocol::config::{
    ConversationNotificationOverride, ConversationNotificationSetting, NotificationDevicePreferences,
    NotificationScope, NotificationTargetKind,
};
use mixdog_protocol::ConfigWriteMode;
use serde_json::json;

use super::decision::{
    ConversationOverride, DESKTOP_ACTIVE_WINDOW_SECONDS, DevicePreferences, OverrideSetting, PreferencesView,
    TargetKind,
};use super::engine::{Audience, HostConnection, PairedDevice};
use super::service::AudienceSource;
use mixdog_core_config::config::Config;

const STATUS: Method = Method("host/notification/status");
/// The one desktop host; its toast goes to whichever connection claimed the role.
const HOST_CONNECTION: &str = "host";
/// This PC's device id in the preferences (`NOTIFICATION_PC_DEVICE_ID`).
const PC_DEVICE: &str = "pc";

/// What the pairing record says about one paired credential (`pairedDeviceInfo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairedClient {
    pub id: String,
    /// The Mixdog phone app (`remoteClientKind(browser) === 'app'`).
    pub phone_app: bool,
    /// The record's creation time; absent when it is not a positive safe integer.
    pub paired_at: Option<i64>,
}

/// The live side of the remote runtime.
pub trait Presence: Send + Sync {
    /// Paired credentials that are not awaiting removal.
    fn paired(&self) -> Vec<PairedClient>;
    /// Whether that device shows `thread_id` right now (`isClientForeground`).
    fn client_shows(&self, client_id: &str, thread_id: &str) -> bool;
    /// Whether the desktop window is focused, visible and painting `thread_id`
    /// (`isSessionOnScreen`).
    fn host_shows(&self, thread_id: &str) -> bool;
}

/// The stored notification preferences (`notification-preferences.ts`).
#[async_trait]
pub trait Preferences: Send + Sync {
    /// This PC's preferences, or the default.
    fn pc(&self) -> NotificationDevicePreferences;
    /// A device's stored entry; `None` when it has none.
    fn stored_device(&self, client_id: &str) -> Option<NotificationDevicePreferences>;
    /// When the store was first written.
    fn migrated_at(&self) -> i64;
    /// The overrides still in force.
    fn overrides(&self) -> Vec<ConversationNotificationOverride>;
    /// Writes a device's resolved default if it still has no entry (`resolveDevice`), so a later
    /// `migratedAt` rewrite cannot change it.
    async fn remember_device(&self, client_id: &str, prefs: &NotificationDevicePreferences);
}

#[async_trait]
impl Preferences for Config {
    fn pc(&self) -> NotificationDevicePreferences {
        self.notification_device(PC_DEVICE)
    }

    fn stored_device(&self, client_id: &str) -> Option<NotificationDevicePreferences> {
        self.get("notifications")?.get("devices")?.get(client_id)?;
        Some(self.notification_device(client_id))
    }

    fn migrated_at(&self) -> i64 {
        self.get("notifications")
            .and_then(|doc| doc.get("migratedAt")?.as_i64())
            .unwrap_or(0)
    }

    fn overrides(&self) -> Vec<ConversationNotificationOverride> {
        self.notification_overrides()
    }

    async fn remember_device(&self, client_id: &str, prefs: &NotificationDevicePreferences) {
        // A config path cannot name an id with a dot in it; paired credential ids have none.
        if client_id.contains('.') {
            return;
        }
        let value = serde_json::to_value(prefs).expect("config types serialize");
        // A failed write leaves the computed default in force for this notification.
        let _ = self
            .write(&format!("notifications.devices.{client_id}"), value, ConfigWriteMode::InitializeIfMissing)
            .await;
    }
}

/// Both sides use the same wire names, so the typed forms convert through their JSON.
fn decision_prefs(prefs: &NotificationDevicePreferences) -> DevicePreferences {
    serde_json::from_value(serde_json::to_value(prefs).expect("config types serialize"))
        .expect("the decision's preferences read the config's shape")
}

fn decision_override(entry: &ConversationNotificationOverride) -> ConversationOverride {
    ConversationOverride {
        kind: match entry.target.kind {
            NotificationTargetKind::Session => TargetKind::Session,
            NotificationTargetKind::Agent => TargetKind::Agent,
            NotificationTargetKind::Room => TargetKind::Room,
        },
        id: entry.target.id.clone(),
        setting: match entry.setting {
            ConversationNotificationSetting::Always => OverrideSetting::Always,
            ConversationNotificationSetting::Muted { until } => OverrideSetting::Muted { until },
        },
    }
}

pub struct LiveAudience {
    preferences: Arc<dyn Preferences>,
    presence: Arc<dyn Presence>,
    host: Arc<dyn HostChannel>,
}

impl LiveAudience {
    pub fn new(preferences: Arc<dyn Preferences>, presence: Arc<dyn Presence>, host: Arc<dyn HostChannel>) -> Self {
        Self { preferences, presence, host }
    }

    /// A device's preferences: its stored entry, else the default its kind and pairing time give
    /// it (`devicePreferencesIn`). A phone app paired at or after the store was first written
    /// starts with bot chats only. A default resolved from a pairing record is written once.
    async fn device_prefs(&self, client: &PairedClient) -> NotificationDevicePreferences {
        if let Some(stored) = self.preferences.stored_device(&client.id) {
            return stored;
        }
        let paired_after = client.paired_at.is_some_and(|at| at >= self.preferences.migrated_at());
        let resolved = if client.phone_app && paired_after {
            NotificationDevicePreferences { scope: NotificationScope::Bots, ..Default::default() }
        } else {
            NotificationDevicePreferences::default()
        };
        if client.paired_at.is_some() {
            self.preferences.remember_device(&client.id, &resolved).await;
        }
        resolved
    }

    /// `None` when there is no host to ask, or it cannot show notifications.
    async fn host_status(&self) -> Option<HostNotificationStatus> {
        let answer = self.host.request(HostCapability::Notifications, STATUS, json!({})).await.ok()?;
        serde_json::from_value(answer).ok()
    }
}

#[async_trait]
impl AudienceSource for LiveAudience {
    async fn audience(&self, thread_id: &str) -> Audience {
        let overrides: Vec<ConversationOverride> = self.preferences.overrides().iter().map(decision_override).collect();
        let view = |preferences| PreferencesView { preferences, overrides: overrides.clone() };
        let status = self.host_status().await;
        let hosts = match &status {
            Some(status) if status.supported => vec![HostConnection {
                connection_id: HOST_CONNECTION.into(),
                foreground_thread: self.presence.host_shows(thread_id).then(|| thread_id.to_owned()),
            }],
            _ => Vec::new(),
        };
        // `idleSeconds !== null && idleSeconds < DESKTOP_ACTIVE_WINDOW_SECONDS`
        let desktop_active = status
            .and_then(|status| status.idle_seconds)
            .is_some_and(|idle| idle < DESKTOP_ACTIVE_WINDOW_SECONDS as f64);
        let mut devices = Vec::new();
        for client in self.presence.paired() {
            devices.push(PairedDevice {
                view: view(decision_prefs(&self.device_prefs(&client).await)),
                foreground_thread: self.presence.client_shows(&client.id, thread_id).then(|| thread_id.to_owned()),
                device_id: client.id,
            });
        }
        Audience { pc: view(decision_prefs(&self.preferences.pc())), hosts, devices, desktop_active }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::CoreError;
    use mixdog_core_api::host::HostError;
    use mixdog_protocol::config::{NotificationScope, NotificationTarget};
    use serde_json::Value;

    use super::*;
    use crate::notify::decision::Scope;

    struct Prefs {
        stored: Vec<(&'static str, NotificationDevicePreferences)>,
        migrated_at: i64,
        remembered: std::sync::Mutex<Vec<(String, NotificationScope)>>,
    }

    impl Prefs {
        fn new(stored: Vec<(&'static str, NotificationDevicePreferences)>, migrated_at: i64) -> Self {
            Self { stored, migrated_at, remembered: Default::default() }
        }
    }

    #[async_trait]
    impl Preferences for Prefs {
        async fn remember_device(&self, id: &str, prefs: &NotificationDevicePreferences) {
            self.remembered.lock().unwrap().push((id.into(), prefs.scope));
        }
        fn pc(&self) -> NotificationDevicePreferences {
            NotificationDevicePreferences::default()
        }
        fn stored_device(&self, id: &str) -> Option<NotificationDevicePreferences> {
            self.stored.iter().find(|(key, _)| *key == id).map(|(_, prefs)| prefs.clone())
        }
        fn migrated_at(&self) -> i64 {
            self.migrated_at
        }
        fn overrides(&self) -> Vec<ConversationNotificationOverride> {
            vec![ConversationNotificationOverride {
                target: NotificationTarget { kind: NotificationTargetKind::Room, id: "r1".into() },
                setting: ConversationNotificationSetting::Muted { until: Some(9) },
            }]
        }
    }

    struct Live {
        paired: Vec<PairedClient>,
        showing: Vec<(&'static str, &'static str)>,
        screen: Vec<&'static str>,
    }

    impl Presence for Live {
        fn paired(&self) -> Vec<PairedClient> {
            self.paired.clone()
        }
        fn client_shows(&self, client: &str, thread: &str) -> bool {
            self.showing.contains(&(client, thread))
        }
        fn host_shows(&self, thread: &str) -> bool {
            self.screen.contains(&thread)
        }
    }

    struct Host(Result<Value, ()>);

    #[async_trait]
    impl HostChannel for Host {
        async fn request(&self, _: HostCapability, method: Method, _: Value) -> Result<Value, HostError> {
            assert_eq!(method.as_str(), "host/notification/status");
            self.0.clone().map_err(|()| HostError::Core(CoreError::ConnectionClosed))
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn client(id: &str, phone_app: bool, paired_at: Option<i64>) -> PairedClient {
        PairedClient { id: id.into(), phone_app, paired_at }
    }

    fn source(prefs: Prefs, live: Live, host: Result<Value, ()>) -> LiveAudience {
        LiveAudience::new(Arc::new(prefs), Arc::new(live), Arc::new(Host(host)))
    }

    fn live(paired: Vec<PairedClient>) -> Live {
        Live { paired, showing: vec![], screen: vec![] }
    }

    #[tokio::test]
    async fn an_unstored_phone_app_defaults_by_pairing_time_and_everything_else_to_the_default() {
        let paired = vec![
            client("new-app", true, Some(100)),
            client("old-app", true, Some(99)),
            client("new-browser", false, Some(500)),
            client("no-record-time", true, None),
        ];
        let prefs = Arc::new(Prefs::new(vec![], 100));
        let audience = LiveAudience::new(prefs.clone(), Arc::new(live(paired)), Arc::new(Host(Err(()))))
            .audience("t1")
            .await;
        // Written once for each device with a pairing record, never for one without.
        assert_eq!(
            *prefs.remembered.lock().unwrap(),
            vec![
                ("new-app".to_owned(), NotificationScope::Bots),
                ("old-app".to_owned(), NotificationScope::All),
                ("new-browser".to_owned(), NotificationScope::All),
            ]
        );
        let scope = |id: &str| audience.devices.iter().find(|d| d.device_id == id).unwrap().view.preferences.scope;
        assert_eq!(scope("new-app"), Scope::Bots);
        assert_eq!(scope("old-app"), Scope::All);
        assert_eq!(scope("new-browser"), Scope::All);
        assert_eq!(scope("no-record-time"), Scope::All);
    }

    #[tokio::test]
    async fn a_stored_entry_wins_over_the_pairing_default_and_overrides_reach_every_view() {
        let stored = NotificationDevicePreferences { scope: NotificationScope::Off, ..Default::default() };
        let audience = source(
            Prefs::new(vec![("new-app", stored)], 0),
            live(vec![client("new-app", true, Some(5))]),
            Err(()),
        )
        .audience("t1")
        .await;
        assert_eq!(audience.devices[0].view.preferences.scope, Scope::Off);
        for overrides in [&audience.devices[0].view.overrides, &audience.pc.overrides] {
            assert_eq!(overrides.len(), 1);
            assert_eq!(overrides[0].kind, TargetKind::Room);
            assert_eq!(overrides[0].setting, OverrideSetting::Muted { until: Some(9) });
        }
    }

    #[tokio::test]
    async fn the_foreground_thread_is_the_asked_thread_only_for_a_device_that_shows_it() {
        let mut presence = live(vec![client("a", false, None), client("b", false, None)]);
        presence.showing = vec![("a", "t1"), ("b", "t2")];
        let audience = source(Prefs::new(vec![], 0), presence, Err(())).audience("t1").await;
        assert_eq!(audience.devices[0].foreground_thread.as_deref(), Some("t1"));
        assert_eq!(audience.devices[1].foreground_thread, None);
    }

    #[tokio::test]
    async fn the_host_gives_the_toast_target_and_the_desktop_activity() {
        let status = |supported: bool, idle: Option<f64>| Ok(json!({ "supported": supported, "idleSeconds": idle }));
        let mut presence = live(vec![]);
        presence.screen = vec!["t9"];
        let prefs = || Prefs::new(vec![], 0);
        let screen = |presence: &Live| Live { paired: vec![], showing: vec![], screen: presence.screen.clone() };

        let active = source(prefs(), screen(&presence), status(true, Some(179.9))).audience("t9").await;
        assert!(active.desktop_active);
        assert_eq!(active.hosts[0].foreground_thread.as_deref(), Some("t9"));
        let elsewhere = source(prefs(), screen(&presence), status(true, None)).audience("t1").await;
        assert_eq!(elsewhere.hosts[0].foreground_thread, None);

        let idle = source(prefs(), screen(&presence), status(true, Some(180.0))).audience("t1").await;
        assert!(!idle.desktop_active, "the window is a strict `<`");

        let unknown = source(prefs(), screen(&presence), status(true, None)).audience("t1").await;
        assert!(!unknown.desktop_active, "a null idle time is not active");

        let unsupported = source(prefs(), screen(&presence), status(false, Some(1.0))).audience("t1").await;
        assert!(unsupported.hosts.is_empty());

        let absent = source(prefs(), screen(&presence), Err(())).audience("t1").await;
        assert!(absent.hosts.is_empty() && !absent.desktop_active);
    }
}
