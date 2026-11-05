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

impl Config {
    /// A paired client's stored preferences, else the defaults (`DEFAULT_NOTIFICATION_PREFERENCES`):
    /// `PushPreferences.device` of `push-notifier.ts` for a client with no pairing record. The
    /// kind-and-pairing-time default a phone app paired after the migration gets belongs to the
    /// caller that knows the pairing.
    pub fn notification_device(&self, client_id: &str) -> NotificationDevicePreferences {
        self.get("notifications")
            .and_then(|doc| doc.get("devices")?.get(client_id).cloned())
            .and_then(|stored| serde_json::from_value(stored).ok())
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
        let all: Vec<ConversationNotificationOverride> =
            stored.and_then(|list| serde_json::from_value(list).ok()).unwrap_or_default();
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
