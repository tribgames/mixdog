//! Views over the full config that the desktop reads from the `config` section (DS §3):
//! the settings object, the activity-rail pins and the session retention policy.

use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use super::schema::DEFAULT_ACTIVITY_RAIL_PINS;
use super::schema::NOTIFICATION_VOLUME_DEFAULT;
use super::schema::NOTIFICATION_VOLUME_MAX;
use super::schema::SESSION_AUTO_ARCHIVE_DAY_CHOICES;
use super::schema::SESSION_AUTO_ARCHIVE_DAYS_DEFAULT;
use super::schema::SESSION_AUTO_DELETE_DAY_CHOICES;
use super::schema::SESSION_AUTO_DELETE_DAYS_DEFAULT;
use super::schema::normalize_pins;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub auto_clear: bool,
    pub auto_compact: bool,
    pub keep_awake: bool,
    pub run_in_background: bool,
    pub notification_volume: i64,
    pub session_auto_archive_days: i64,
    pub session_auto_delete_days: i64,
    pub usage_pinned: bool,
    pub usage_rail_short_long: bool,
    pub usage_accounts_expanded: bool,
    pub usage_rail_slots_three: bool,
    pub usage_rail_slots_all: bool,
    pub computer_control: bool,
    pub computer_observe_only: bool,
    pub browser_control: bool,
    pub browser_auto_sign_in: bool,
    pub browser_hid_devices: bool,
    /// Every default kind plus the site exceptions.
    pub browser_permissions: Value,
    pub save_chat_logins: bool,
    pub computer_installed: bool,
    pub browser_installed: bool,
}

/// The stored session retention policy; `None` when a stored value is not one of the offered
/// choices, so the retention pass does nothing rather than act on a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionRetention {
    pub auto_archive_days: i64,
    pub auto_delete_days: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityRailPins {
    pub pins: Vec<String>,
    pub revision: u64,
}

fn object<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    map.get(key).and_then(Value::as_object)
}

fn empty() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn flag(map: &Map<String, Value>, key: &str, default_on: bool) -> bool {
    let stored = map.get(key);
    if default_on {
        stored != Some(&Value::Bool(false))
    } else {
        stored == Some(&Value::Bool(true))
    }
}

fn retention_days(desktop: &Map<String, Value>, key: &str, choices: &[i64]) -> Option<i64> {
    desktop
        .get(key)
        .map(|stored| stored.as_i64().filter(|days| choices.contains(days)))
        .unwrap_or(Some(match key {
            "sessionAutoArchiveDays" => SESSION_AUTO_ARCHIVE_DAYS_DEFAULT,
            _ => SESSION_AUTO_DELETE_DAYS_DEFAULT,
        }))
}

pub fn session_retention(config: &Map<String, Value>) -> Option<SessionRetention> {
    let desktop = object(config, "desktop").unwrap_or(empty());
    Some(SessionRetention {
        auto_archive_days: retention_days(
            desktop,
            "sessionAutoArchiveDays",
            SESSION_AUTO_ARCHIVE_DAY_CHOICES,
        )?,
        auto_delete_days: retention_days(
            desktop,
            "sessionAutoDeleteDays",
            SESSION_AUTO_DELETE_DAY_CHOICES,
        )?,
    })
}

/// Automatic cookie import: on unless the user saved "off"; an empty profile means none is bound.
pub fn browser_cookie_auto_import(config: &Map<String, Value>) -> (bool, String) {
    let stored = object(object(config, "desktop").unwrap_or(empty()), "browserCookieAutoImport")
        .unwrap_or(empty());
    let profile = stored.get("profileId").and_then(Value::as_str).unwrap_or("");
    (stored.get("enabled") != Some(&Value::Bool(false)), profile.to_owned())
}

/// Which implementation serves the `computer` tool (`desktop.computerBackend`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerBackendChoice {
    /// The resident `mixdog-computer` helper.
    Helper,
    /// Every command forwarded to the desktop's own computer host (`host/computer/command`), the dual path kept until the
    /// helper is signed off. Windows only.
    DesktopHost,
}

/// The stored choice as it applies on a platform: `"desktopHost"` on Windows, the helper for every other value, a missing one
/// and every other platform.
fn choose_computer_backend(stored: Option<&Value>, windows: bool) -> ComputerBackendChoice {
    match stored.and_then(Value::as_str) {
        Some("desktopHost") if windows => ComputerBackendChoice::DesktopHost,
        _ => ComputerBackendChoice::Helper,
    }
}

/// `desktop.computerBackend`, read afresh from the config.
pub fn computer_backend(config: &Map<String, Value>) -> ComputerBackendChoice {
    choose_computer_backend(object(config, "desktop").unwrap_or(empty()).get("computerBackend"), cfg!(windows))
}

pub fn desktop_settings(config: &Map<String, Value>) -> DesktopSettings {
    let desktop = object(config, "desktop").unwrap_or(empty());
    let agent = object(config, "agent").unwrap_or(empty());
    let auto_clear = object(agent, "autoClear").unwrap_or(empty());
    let compaction = object(agent, "compaction").unwrap_or(empty());
    let retention = |key: &str, choices: &[i64], default| {
        desktop
            .get(key)
            .and_then(Value::as_i64)
            .filter(|days| choices.contains(days))
            .unwrap_or(default)
    };
    DesktopSettings {
        auto_clear: flag(auto_clear, "enabled", true),
        auto_compact: flag(compaction, "auto", true) && flag(compaction, "enabled", true),
        keep_awake: flag(desktop, "keepAwake", true),
        run_in_background: flag(desktop, "runInBackground", true),
        notification_volume: desktop
            .get("notificationVolume")
            .and_then(Value::as_i64)
            .filter(|n| (0..=NOTIFICATION_VOLUME_MAX).contains(n))
            .unwrap_or(NOTIFICATION_VOLUME_DEFAULT),
        session_auto_archive_days: retention(
            "sessionAutoArchiveDays",
            SESSION_AUTO_ARCHIVE_DAY_CHOICES,
            SESSION_AUTO_ARCHIVE_DAYS_DEFAULT,
        ),
        session_auto_delete_days: retention(
            "sessionAutoDeleteDays",
            SESSION_AUTO_DELETE_DAY_CHOICES,
            SESSION_AUTO_DELETE_DAYS_DEFAULT,
        ),
        usage_pinned: flag(desktop, "usagePinned", true),
        usage_rail_short_long: flag(desktop, "usageRailShortLong", false),
        usage_accounts_expanded: flag(desktop, "usageAccountsExpanded", false),
        usage_rail_slots_three: flag(desktop, "usageRailSlotsThree", false),
        usage_rail_slots_all: flag(desktop, "usageRailSlotsAll", false),
        computer_control: flag(desktop, "computerControl", false),
        computer_observe_only: flag(desktop, "computerObserveOnly", false),
        browser_control: flag(desktop, "browserControl", false),
        browser_auto_sign_in: flag(desktop, "browserAutoSignIn", true),
        browser_hid_devices: flag(desktop, "browserHidDevices", false),
        browser_permissions: super::browser_permissions::view(desktop.get("browserPermissions")),
        save_chat_logins: flag(desktop, "saveChatLogins", true),
        // A control that is already on predates the install marker.
        computer_installed: flag(desktop, "computerInstalled", false)
            || flag(desktop, "computerControl", false),
        browser_installed: flag(desktop, "browserInstalled", false)
            || flag(desktop, "browserControl", false),
    }
}

/// Stored pins: a full state, or a revision alone meaning the default list.
pub fn activity_rail_pins(stored: Option<&Value>) -> Option<ActivityRailPins> {
    let stored = stored?.as_object()?;
    let revision = stored
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|r| (1..=MAX_SAFE_INTEGER).contains(r))?;
    match stored.get("pins") {
        Some(pins) => Some(ActivityRailPins {
            pins: normalize_pins(pins)?,
            revision,
        }),
        None => Some(ActivityRailPins {
            pins: DEFAULT_ACTIVITY_RAIL_PINS
                .iter()
                .map(|id| (*id).to_owned())
                .collect(),
            revision,
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn config(desktop: Value) -> Map<String, Value> {
        json!({ "desktop": desktop }).as_object().unwrap().clone()
    }

    #[test]
    fn the_helper_is_the_default_and_desktop_host_is_windows_only() {
        for stored in [None, Some(json!("helper")), Some(json!("other")), Some(json!(true)), Some(json!(null))] {
            assert_eq!(choose_computer_backend(stored.as_ref(), true), ComputerBackendChoice::Helper);
        }
        let host = json!("desktopHost");
        assert_eq!(choose_computer_backend(Some(&host), true), ComputerBackendChoice::DesktopHost);
        assert_eq!(choose_computer_backend(Some(&host), false), ComputerBackendChoice::Helper);
    }

    #[test]
    fn the_choice_is_read_from_the_desktop_section() {
        assert_eq!(computer_backend(&Map::new()), ComputerBackendChoice::Helper);
        assert_eq!(computer_backend(&config(json!({}))), ComputerBackendChoice::Helper);
        let chosen = computer_backend(&config(json!({ "computerBackend": "desktopHost" })));
        assert_eq!(chosen == ComputerBackendChoice::DesktopHost, cfg!(windows));
    }
}
