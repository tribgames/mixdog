//! Config paths of the one `Config` actor over `mixdog-config.json` (DS §3).
//! A path is dot-separated (`desktop.zoom`, `notifications.conversations.<threadId>`).

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
    pub const NOTIFICATIONS: &str = "notifications";
    pub const NOTIFICATIONS_CONVERSATIONS: &str = "notifications.conversations";
    pub const AGENTS_GREETED: &str = "agents.greeted";
    pub const REMOTE_ACTIVATED_AT: &str = "remote.activatedAt";
    pub const REMOTE_ENABLED: &str = "remote.enabled";
    pub const TOOL_POLICY: &str = "toolPolicy";
    pub const ONBOARDING: &str = "onboarding";
    pub const TERMINAL_PROFILES: &str = "terminal.profiles";
}
