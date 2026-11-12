//! Typed key schemas of `config/value/write` (DS §3). The registry is closed: a path without a
//! schema is rejected, and a value of the wrong type is `invalidParams{path, expected}`.
//! A key with a code default is stored only when its value differs from the default.

use serde_json::Value;

use super::notifications;

pub(crate) const DEFAULT_ACTIVITY_RAIL_PINS: &[&str] = &[
    "sessions",
    "agents",
    "schedules",
    "workflows",
    "projects",
    "extensions",
    "skills",
];

const ACTIVITY_RAIL_PIN_IDS: &[&str] = &[
    "sessions",
    "agents",
    "schedules",
    "workflows",
    "projects",
    "extensions",
    "skills",
    "source-control",
    "search",
    "webhooks",
    "studio",
];

pub const NOTIFICATION_VOLUME_DEFAULT: i64 = 100;
pub const NOTIFICATION_VOLUME_MAX: i64 = 400;
pub const SESSION_AUTO_ARCHIVE_DAY_CHOICES: &[i64] = &[0, 1, 7, 14, 30, 90];
pub const SESSION_AUTO_DELETE_DAY_CHOICES: &[i64] = &[0, 7, 30, 90];
pub const SESSION_AUTO_ARCHIVE_DAYS_DEFAULT: i64 = 7;
pub const SESSION_AUTO_DELETE_DAYS_DEFAULT: i64 = 90;

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Bool,
    IntRange(i64, i64),
    IntChoice(&'static [i64]),
    String,
    /// A list of activity-rail destinations; stored with a revision (see `Config::write`).
    Pins,
    /// A site-permission policy; stored normalized (see `browser_permissions`).
    BrowserPermissions,
    /// `{enabled, profileId}`; always stored, so an explicit "off" never falls back to the on
    /// default.
    CookieAutoImport,
    /// Any value; stored as Node's `markdownDefaultViewSetting` reads it: `rich`, `source`, else `preview`.
    MarkdownView,
    /// The whole `notifications` document, or one of its typed parts.
    NotificationsDoc,
    NotificationsMigratedAt,
    NotificationDevices,
    NotificationDevice,
    NotificationOverrides,
    /// Any JSON value; `null` removes it.
    Any,
}

pub(crate) struct Key {
    pub(crate) path: &'static str,
    pub(crate) kind: Kind,
    pub(crate) default: Option<Value>,
}

fn key(path: &'static str, kind: Kind, default: Option<Value>) -> Key {
    Key {
        path,
        kind,
        default,
    }
}

/// A path ending in `**` covers the whole subtree below it; `*` is one segment.
pub(crate) fn registry() -> Vec<Key> {
    let flag = |path, default| key(path, Kind::Bool, Some(Value::Bool(default)));
    let int = |n: i64| Some(Value::from(n));
    vec![
        flag("desktop.keepAwake", true),
        flag("desktop.runInBackground", true),
        flag("desktop.usagePinned", true),
        flag("desktop.usageRailShortLong", false),
        flag("desktop.usageAccountsExpanded", false),
        flag("desktop.usageRailSlotsThree", false),
        flag("desktop.usageRailSlotsAll", false),
        flag("desktop.computerControl", false),
        flag("desktop.computerObserveOnly", false),
        flag("desktop.browserControl", false),
        flag("desktop.browserAutoSignIn", true),
        flag("desktop.browserHidDevices", false),
        flag("desktop.saveChatLogins", true),
        key("desktop.computerInstalled", Kind::Bool, None),
        key("desktop.browserInstalled", Kind::Bool, None),
        key(
            "desktop.notificationVolume",
            Kind::IntRange(0, NOTIFICATION_VOLUME_MAX),
            int(NOTIFICATION_VOLUME_DEFAULT),
        ),
        key(
            "desktop.sessionAutoArchiveDays",
            Kind::IntChoice(SESSION_AUTO_ARCHIVE_DAY_CHOICES),
            int(SESSION_AUTO_ARCHIVE_DAYS_DEFAULT),
        ),
        key(
            "desktop.sessionAutoDeleteDays",
            Kind::IntChoice(SESSION_AUTO_DELETE_DAY_CHOICES),
            int(SESSION_AUTO_DELETE_DAYS_DEFAULT),
        ),
        // The application UI always uses native scale: the only accepted factor is the default.
        key("desktop.zoom", Kind::IntChoice(&[1]), int(1)),
        key("desktop.activityRailPins", Kind::Pins, None),
        key("desktop.browserPermissions", Kind::BrowserPermissions, None),
        key("desktop.browserCookieAutoImport", Kind::CookieAutoImport, None),
        key("desktop.editor.markdownDefaultView", Kind::MarkdownView, None),
        key("desktop.retentionState", Kind::Any, None),
        key("desktop.unclassifiedWorkspaceRoot", Kind::String, None),
        flag("agent.autoClear.enabled", true),
        flag("agent.compaction.auto", true),
        key("agents.greeted", Kind::Any, None),
        key("quotaAutoResume", Kind::Any, None),
        key("remote.enabled", Kind::Bool, None),
        key("remote.activatedAt", Kind::Any, None),
        key("notifications", Kind::NotificationsDoc, None),
        key("notifications.migratedAt", Kind::NotificationsMigratedAt, None),
        key("notifications.devices", Kind::NotificationDevices, None),
        key("notifications.devices.*", Kind::NotificationDevice, None),
        key("notifications.overrides", Kind::NotificationOverrides, None),
        key("toolPolicy.**", Kind::Any, None),
        key("onboarding.**", Kind::Any, None),
        key("terminal.profiles", Kind::Any, None),
    ]
}

fn matches(pattern: &str, path: &str) -> bool {
    let mut want = pattern.split('.');
    let mut have = path.split('.');
    loop {
        match (want.next(), have.next()) {
            (Some("**"), Some(_)) => return true,
            (Some(w), Some(h)) if w == "*" || w == h => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

pub(crate) fn lookup<'a>(keys: &'a [Key], path: &str) -> Option<&'a Key> {
    keys.iter().find(|key| matches(key.path, path))
}

pub(crate) fn expected(kind: Kind) -> String {
    match kind {
        Kind::Bool => "boolean".into(),
        Kind::IntRange(lo, hi) => format!("integer {lo}..={hi}"),
        Kind::IntChoice(choices) => format!("one of {choices:?}"),
        Kind::String => "string".into(),
        Kind::Pins => "Activity rail pins must be an array of supported destinations.".into(),
        Kind::MarkdownView => "any value".into(),
        Kind::BrowserPermissions => "site permission policy object".into(),
        Kind::CookieAutoImport => {
            "{enabled: boolean, profileId: a Chrome profile directory name of at most 120 \
             characters without path separators, required when enabled}"
                .into()
        }
        Kind::NotificationsDoc => "{migratedAt, devices, overrides}".into(),
        Kind::NotificationsMigratedAt => "non-negative safe integer".into(),
        Kind::NotificationDevices => "object of device notification preferences".into(),
        Kind::NotificationDevice => "device notification preferences".into(),
        Kind::NotificationOverrides => "array of conversation notification overrides".into(),
        Kind::Any => "any value".into(),
    }
}

pub(crate) fn accepts(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Bool => value.is_boolean(),
        Kind::IntRange(lo, hi) => value.as_i64().is_some_and(|n| (lo..=hi).contains(&n)),
        Kind::IntChoice(choices) => value.as_i64().is_some_and(|n| choices.contains(&n)),
        Kind::String => value.is_string(),
        Kind::BrowserPermissions => value.is_object(),
        Kind::CookieAutoImport => cookie_auto_import(value).is_some(),
        Kind::NotificationsDoc
        | Kind::NotificationsMigratedAt
        | Kind::NotificationDevices
        | Kind::NotificationDevice
        | Kind::NotificationOverrides => stored_notifications(kind, value).is_some(),
        Kind::Pins => normalize_pins(value).is_some(),
        Kind::MarkdownView | Kind::Any => true,
    }
}

/// `markdownDefaultViewSetting` (workspace-config.ts): the Markdown default view as stored.
pub(crate) fn markdown_view(value: &Value) -> Value {
    match value.as_str() {
        Some(view @ ("rich" | "source")) => Value::from(view),
        _ => Value::from("preview"),
    }
}

/// The keys `DesktopSettingsStore.update` writes (settings-store.ts): each leaves `agent` an object, as its `next.agent = agent` does.
pub(crate) const SETTING_UPDATE_PATHS: &[&str] = &[
    "agent.autoClear.enabled",
    "agent.compaction.auto",
    "desktop.keepAwake",
    "desktop.runInBackground",
    "desktop.usagePinned",
    "desktop.usageRailShortLong",
    "desktop.usageAccountsExpanded",
    "desktop.usageRailSlotsThree",
    "desktop.usageRailSlotsAll",
    "desktop.computerControl",
    "desktop.computerObserveOnly",
    "desktop.browserControl",
    "desktop.browserAutoSignIn",
    "desktop.browserHidDevices",
    "desktop.saveChatLogins",
    "desktop.computerInstalled",
    "desktop.browserInstalled",
];

/// The keys whose Node writer copies the `desktop` section (`{ ...record(current.desktop) }`) before it stores or drops its
/// value, so the section exists afterwards: the flags of [`SETTING_UPDATE_PATHS`] and the other settings-store writers.
pub(crate) const DESKTOP_WRITER_PATHS: &[&str] = &[
    "desktop.notificationVolume",
    "desktop.sessionAutoArchiveDays",
    "desktop.sessionAutoDeleteDays",
    "desktop.browserPermissions",
    "desktop.activityRailPins",
    "desktop.browserCookieAutoImport",
];

/// A `notifications` value as stored (the protocol type's form), or `None` when it is not valid.
pub(crate) fn stored_notifications(kind: Kind, value: &Value) -> Option<Value> {
    match kind {
        Kind::NotificationsDoc => notifications::doc(value),
        Kind::NotificationsMigratedAt => notifications::migrated_at(value),
        Kind::NotificationDevices => notifications::devices(value),
        Kind::NotificationDevice => notifications::device(value),
        Kind::NotificationOverrides => notifications::overrides(value),
        _ => None,
    }
}

/// Node's thrown text for a setting `cookie_auto_import` refuses (`updateBrowserCookieAutoImport`): the shape and
/// length check first, then the separator / missing-profile check.
pub(crate) fn cookie_auto_import_error(value: &Value) -> &'static str {
    let shaped = value.as_object().is_some_and(|object| {
        object.get("enabled").is_some_and(Value::is_boolean)
            && object.get("profileId").and_then(Value::as_str).is_some_and(|p| p.encode_utf16().count() <= 120)
    });
    if shaped {
        "Automatic cookie import needs a Chrome profile."
    } else {
        "Automatic cookie import setting is invalid."
    }
}

/// The setting as stored, or `None` when it is not valid.
pub(crate) fn cookie_auto_import(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let enabled = object.get("enabled")?.as_bool()?;
    let profile = object.get("profileId")?.as_str()?;
    // A profile id is one directory name; the importer re-checks it against Chrome's list.
    let valid = profile.encode_utf16().count() <= 120
        && !profile.contains(['/', '\\'])
        && (!enabled || !profile.is_empty());
    valid.then(|| serde_json::json!({ "enabled": enabled, "profileId": profile }))
}

/// Supported destinations only, duplicates dropped, first occurrence kept.
pub(crate) fn normalize_pins(value: &Value) -> Option<Vec<String>> {
    let mut pins: Vec<String> = Vec::new();
    for id in value.as_array()? {
        let id = id.as_str().filter(|id| ACTIVITY_RAIL_PIN_IDS.contains(id))?;
        if !pins.iter().any(|known| known == id) {
            pins.push(id.to_owned());
        }
    }
    Some(pins)
}
