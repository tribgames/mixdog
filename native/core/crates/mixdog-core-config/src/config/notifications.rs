//! Writes to `notifications` (value type `NotificationPreferences` in `mixdog-protocol`). The
//! protocol types give the shape; this adds the rules they cannot express, as Node's
//! `storedPreferences` and `storedOverride` do. A value is stored as the typed form serializes,
//! so unknown fields are dropped and missing ones take their defaults.

use super::Config;
use mixdog_protocol::config::ConversationNotificationOverride;
use mixdog_protocol::config::ConversationNotificationSetting;
use mixdog_protocol::config::NotificationDevicePreferences;
use mixdog_protocol::config::NotificationPreferences;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// `HH:MM`, hours 00-23, minutes 00-59.
fn clock(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[..2].iter().all(u8::is_ascii_digit)
        && b[3..].iter().all(u8::is_ascii_digit)
        && text[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && text[3..].parse::<u8>().is_ok_and(|m| m < 60)
}

/// `^[\w.:-]{1,200}$`.
fn target_id(text: &str) -> bool {
    (1..=200).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// `Number.isSafeInteger`: an integer JSON number, `50.0` included.
pub(super) fn safe_integer(value: &Value) -> Option<i64> {
    let Value::Number(n) = value else { return None };
    let whole = n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?;
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&whole).then_some(whole)
}

/// `storedPreferences` (notification-preferences.ts): each field of a stored record falls back to its own default
/// when missing or invalid, so one bad value never resets the others.
fn stored_device(value: &Value) -> NotificationDevicePreferences {
    let base = NotificationDevicePreferences::default();
    let none = serde_json::Map::new();
    let stored = value.as_object().unwrap_or(&none);
    let events = stored.get("events").and_then(Value::as_object).unwrap_or(&none);
    let quiet = stored.get("quietHours").and_then(Value::as_object).unwrap_or(&none);
    let flag = |map: &serde_json::Map<String, Value>, key: &str, fallback: bool| map.get(key).and_then(Value::as_bool).unwrap_or(fallback);
    let clock_at = |key: &str, fallback: String| quiet.get(key).and_then(Value::as_str).filter(|text| clock(text)).map_or(fallback, str::to_owned);
    fn named<T: DeserializeOwned>(map: &serde_json::Map<String, Value>, key: &str) -> Option<T> {
        map.get(key).and_then(|raw| serde_json::from_value(raw.clone()).ok())
    }
    NotificationDevicePreferences {
        scope: named(stored, "scope").unwrap_or(base.scope),
        events: mixdog_protocol::config::NotificationEvents {
            finished: flag(events, "finished", base.events.finished),
            question: flag(events, "question", base.events.question),
            approval: flag(events, "approval", base.events.approval),
            error: flag(events, "error", base.events.error),
        },
        automatic_runs: flag(stored, "automaticRuns", base.automatic_runs),
        quiet_hours: mixdog_protocol::config::NotificationQuietHours {
            enabled: flag(quiet, "enabled", base.quiet_hours.enabled),
            start: clock_at("start", base.quiet_hours.start),
            end: clock_at("end", base.quiet_hours.end),
            days: named(quiet, "days").unwrap_or(base.quiet_hours.days),
            allow_waiting: flag(quiet, "allowWaiting", base.quiet_hours.allow_waiting),
        },
        hold_while_desktop_active: flag(stored, "holdWhileDesktopActive", base.hold_while_desktop_active),
        taskbar_flash: flag(stored, "taskbarFlash", base.taskbar_flash),
    }
}

/// `storedOverride`: one stored override, or `None` when it is malformed (only that entry is dropped).
fn stored_override(value: &Value) -> Option<ConversationNotificationOverride> {
    let target = value.get("target")?;
    let kind = serde_json::from_value(target.get("kind")?.clone()).ok()?;
    let id = target.get("id")?.as_str().filter(|id| target_id(id))?.to_owned();
    let setting = value.get("setting")?;
    let setting = match setting.get("mode")?.as_str()? {
        "always" => ConversationNotificationSetting::Always,
        "muted" => match setting.get("until")? {
            Value::Null => ConversationNotificationSetting::Muted { until: None },
            other => ConversationNotificationSetting::Muted { until: Some(safe_integer(other).filter(|until| *until > 0)?) },
        },
        _ => return None,
    };
    Some(ConversationNotificationOverride { target: mixdog_protocol::config::NotificationTarget { kind, id }, setting })
}

impl Config {
    /// A paired client's stored preferences, else the defaults (`DEFAULT_NOTIFICATION_PREFERENCES`):
    /// `PushPreferences.device` of `push-notifier.ts` for a client with no pairing record. The
    /// kind-and-pairing-time default a phone app paired after the migration gets belongs to the
    /// caller that knows the pairing.
    pub fn notification_device(&self, client_id: &str) -> NotificationDevicePreferences {
        self.get("notifications")
            .and_then(|doc| doc.get("devices")?.get(client_id).cloned())
            .map(|stored| stored_device(&stored))
            .unwrap_or_default()
    }

    /// The conversation overrides still in force now: a mute whose `until` has passed is dropped
    /// (`activeOverrides`).
    pub fn notification_overrides(&self) -> Vec<ConversationNotificationOverride> {
        self.notification_overrides_at(now_ms())
    }

    /// [`Self::notification_overrides`] at an explicit time.
    pub fn notification_overrides_at(&self, now: i64) -> Vec<ConversationNotificationOverride> {
        let stored = self.get("notifications").and_then(|doc| doc.get("overrides").cloned());
        let all: Vec<ConversationNotificationOverride> = match stored {
            Some(Value::Array(list)) => list.iter().filter_map(stored_override).collect(),
            _ => Vec::new(),
        };
        all.into_iter()
            .filter(|entry| match entry.setting {
                ConversationNotificationSetting::Muted { until: Some(until) } => until > now,
                _ => true,
            })
            .collect()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

fn device_ok(prefs: &NotificationDevicePreferences) -> bool {
    clock(&prefs.quiet_hours.start) && clock(&prefs.quiet_hours.end)
}

fn override_ok(entry: &ConversationNotificationOverride) -> bool {
    target_id(&entry.target.id)
        && match entry.setting {
            ConversationNotificationSetting::Always => true,
            ConversationNotificationSetting::Muted { until } => {
                until.is_none_or(|u| (1..=MAX_SAFE_INTEGER).contains(&u))
            }
        }
}

fn typed<T: DeserializeOwned + Serialize>(value: &Value, ok: impl Fn(&T) -> bool) -> Option<Value> {
    let parsed: T = serde_json::from_value(value.clone()).ok()?;
    ok(&parsed).then(|| serde_json::to_value(&parsed).expect("config types serialize"))
}

pub(crate) fn device(value: &Value) -> Option<Value> {
    typed::<NotificationDevicePreferences>(value, device_ok)
}

pub(crate) fn devices(value: &Value) -> Option<Value> {
    typed::<std::collections::BTreeMap<String, NotificationDevicePreferences>>(value, |all| {
        all.values().all(device_ok)
    })
}

pub(crate) fn overrides(value: &Value) -> Option<Value> {
    typed::<Vec<ConversationNotificationOverride>>(value, |all| all.iter().all(override_ok))
}

/// `setNotificationPreferences`: `patch` applied over the stored record (`events` and `quietHours` key
/// by key), or over the default of a device with none stored (`bots` starts from bot chats only),
/// then validated as a stored record is.
pub(crate) fn merge_device(stored: Option<&Value>, patch: &Value, bots: bool) -> Result<Value, String> {
    let patch = patch.as_object().ok_or_else(|| "an object patch of device notification preferences".to_owned())?;
    let mut merged = match stored {
        Some(stored) => stored.clone(),
        None => {
            let mut base = serde_json::to_value(NotificationDevicePreferences::default()).expect("config types serialize");
            if bots {
                base["scope"] = Value::from("bots");
            }
            base
        }
    };
    let record = merged.as_object_mut().ok_or_else(|| "stored device notification preferences".to_owned())?;
    for (key, value) in patch {
        match (record.get_mut(key), value) {
            (Some(Value::Object(current)), Value::Object(change)) if key == "events" || key == "quietHours" => {
                for (name, next) in change {
                    current.insert(name.clone(), next.clone());
                }
            }
            _ => {
                record.insert(key.clone(), value.clone());
            }
        }
    }
    device(&merged).ok_or_else(|| "valid device notification preferences".to_owned())
}

/// `setConversationNotification`: the stored overrides without expired mutes and without the
/// target's entry, plus the new entry unless the mode is `inherit`.
pub(crate) fn set_conversation(stored: Option<&Value>, entry: &Value, now: i64) -> Result<Value, String> {
    let shape = || "{target: {kind, id}, setting: {mode}}".to_owned();
    let target = entry.get("target").filter(|t| t.is_object()).ok_or_else(shape)?;
    let setting = entry.get("setting").filter(|s| s.is_object()).ok_or_else(shape)?;
    let same = |other: &Value| other.get("kind") == target.get("kind") && other.get("id") == target.get("id");
    let mut list: Vec<Value> = stored
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|held| {
            let held_setting = held.get("setting");
            let mode = held_setting.and_then(|s| s.get("mode")).and_then(Value::as_str);
            let until = held_setting.and_then(|s| s.get("until")).and_then(Value::as_i64);
            mode != Some("muted") || until.is_none_or(|until| until > now)
        })
        .filter(|held| !held.get("target").is_some_and(same))
        .cloned()
        .collect();
    if setting.get("mode").and_then(Value::as_str) != Some("inherit") {
        list.push(serde_json::json!({ "target": { "kind": target.get("kind"), "id": target.get("id") }, "setting": setting }));
    }
    overrides(&Value::Array(list)).ok_or_else(|| "valid conversation notification settings".to_owned())
}

pub(crate) fn migrated_at(value: &Value) -> Option<Value> {
    typed::<i64>(value, |n| (0..=MAX_SAFE_INTEGER).contains(n))
}

pub(crate) fn doc(value: &Value) -> Option<Value> {
    // Unlike the parts, the whole document must be an object: `default` would take `null`.
    value.as_object()?;
    typed::<NotificationPreferences>(value, |all| {
        (0..=MAX_SAFE_INTEGER).contains(&all.migrated_at)
            && all.devices.values().all(device_ok)
            && all.overrides.iter().all(override_ok)
    })
}
