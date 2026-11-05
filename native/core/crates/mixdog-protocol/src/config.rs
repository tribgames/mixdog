//! Config paths of the one `Config` actor over `mixdog-config.json` (DS §3).
//! A path is dot-separated (`desktop.zoom`, `notifications.devices.<deviceId>`).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(transparent)]
pub struct ConfigPath(pub String);

/// How a `config/value/write` edit applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConfigWriteMode {
    /// Replace the value (default).
    Replace,
    /// Write only when the path holds no value; the compare is inside the write transaction.
    InitializeIfMissing,
}

/// Config paths that replace former wire operations and Electron-profile
/// files (DS §3, SPEC §4.11, DS §16 D1). Key schemas of the remaining
/// subtrees are owned by WP-CONFIG through this crate.
pub mod keys {
    pub const QUOTA_AUTO_RESUME: &str = "quotaAutoResume";
    pub const DESKTOP: &str = "desktop";
    pub const DESKTOP_ACTIVITY_RAIL_PINS: &str = "desktop.activityRailPins";
    pub const DESKTOP_NOTIFICATION_VOLUME: &str = "desktop.notificationVolume";
    pub const DESKTOP_ZOOM: &str = "desktop.zoom";
    pub const DESKTOP_BROWSER_PERMISSIONS: &str = "desktop.browserPermissions";
    pub const DESKTOP_SESSION_AUTO_ARCHIVE_DAYS: &str = "desktop.sessionAutoArchiveDays";
    pub const DESKTOP_SESSION_AUTO_DELETE_DAYS: &str = "desktop.sessionAutoDeleteDays";
    pub const DESKTOP_MARKDOWN_DEFAULT_VIEW: &str = "desktop.editor.markdownDefaultView";
    pub const DESKTOP_RETENTION_STATE: &str = "desktop.retentionState";
    pub const DESKTOP_UNCLASSIFIED_WORKSPACE_ROOT: &str = "desktop.unclassifiedWorkspaceRoot";
    /// Value type `NotificationPreferences`.
    pub const NOTIFICATIONS: &str = "notifications";
    pub const AGENTS_GREETED: &str = "agents.greeted";
    pub const REMOTE_ACTIVATED_AT: &str = "remote.activatedAt";
    pub const REMOTE_ENABLED: &str = "remote.enabled";
    pub const TOOL_POLICY: &str = "toolPolicy";
    pub const ONBOARDING: &str = "onboarding";
    pub const TERMINAL_PROFILES: &str = "terminal.profiles";
}

// ---- `notifications` (the storage half of `notification-preferences.ts`, issue #221) ----
// A missing or invalid field reads as its default, as the Node loader does.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum NotificationScope {
    All,
    Bots,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum NotificationQuietDays {
    Every,
    Weekdays,
    Weekends,
}

/// Which kinds of event notify.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationEvents {
    pub finished: bool,
    pub question: bool,
    pub approval: bool,
    pub error: bool,
}

impl Default for NotificationEvents {
    fn default() -> Self {
        Self {
            finished: true,
            question: true,
            approval: true,
            error: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationQuietHours {
    pub enabled: bool,
    /// `HH:MM` on the PC's local clock; an end at or before the start spans midnight.
    pub start: String,
    pub end: String,
    pub days: NotificationQuietDays,
    /// Questions and approvals still notify inside quiet hours.
    pub allow_waiting: bool,
}

impl Default for NotificationQuietHours {
    fn default() -> Self {
        Self {
            enabled: false,
            start: "23:00".into(),
            end: "08:00".into(),
            days: NotificationQuietDays::Every,
            allow_waiting: false,
        }
    }
}

/// One device's preferences (this PC under device id `pc`, a paired device under its client id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationDevicePreferences {
    pub scope: NotificationScope,
    pub events: NotificationEvents,
    /// Final answers and errors of turns a schedule or webhook started.
    pub automatic_runs: bool,
    pub quiet_hours: NotificationQuietHours,
    /// Paired devices: wait while this PC has recent user input.
    pub hold_while_desktop_active: bool,
    /// This PC: flash the taskbar.
    pub taskbar_flash: bool,
}

impl Default for NotificationDevicePreferences {
    fn default() -> Self {
        Self {
            scope: NotificationScope::All,
            events: NotificationEvents::default(),
            automatic_runs: true,
            quiet_hours: NotificationQuietHours::default(),
            hold_while_desktop_active: true,
            taskbar_flash: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum NotificationTargetKind {
    Session,
    Agent,
    Room,
}

/// What a conversation override is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    pub kind: NotificationTargetKind,
    /// 1–200 of `[A-Za-z0-9_.:-]`.
    pub id: String,
}

/// An override in force; "inherit" is the absence of an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ConversationNotificationSetting {
    /// Notifies whatever the device scope says (quiet hours still apply).
    Always,
    /// `until`: epoch ms, or `null` for no end.
    Muted {
        #[ts(type = "number | null")]
        until: Option<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationNotificationOverride {
    pub target: NotificationTarget,
    pub setting: ConversationNotificationSetting,
}

/// The value of config key `notifications`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPreferences {
    /// When the store was first written: devices paired before it keep today's behaviour.
    #[ts(type = "number")]
    pub migrated_at: i64,
    /// By device id.
    pub devices: BTreeMap<String, NotificationDevicePreferences>,
    pub overrides: Vec<ConversationNotificationOverride>,
}
