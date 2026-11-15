//! The desktop version a device last reported on its leg (`lib/device-store-version.mjs`), kept with the device row so a relay
//! restart still routes phones to the right renderer release before the desktop has redialed. `deploy/renderer-releases.mjs`
//! reads `appVersion`, `rendererRelease` and `versionSeenAt` from `devices.json`: the names are a contract between the tools.

use serde_json::{Map, Number, Value};

use super::auth::text_or;
use super::devices::{finite, number_value};

/// A fleet redial must not rewrite `devices.json` per desktop for a value that did not change; the timestamp only needs to
/// stay fresh enough for retention.
pub const SEEN_REFRESH_MS: f64 = 60.0 * 60.0 * 1000.0;

/// `DESKTOP_VERSION`: `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`, the app version a desktop reports.
pub fn is_desktop_version(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'_' | b'-'))
}

/// `SHELL_VERSION`: `^[a-f0-9]{64}$`, the renderer release a desktop reports.
pub fn is_shell_version(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// What a device reported, or empty strings when unknown (old desktops never report one).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeviceVersion {
    pub app_version: String,
    pub renderer_release: String,
}

/// `cleanReport`: the usable fields of a row or of a frame.
fn clean_report(fields: &dyn Fn(&str) -> Option<Value>) -> DeviceVersion {
    let usable = |key: &str, valid: fn(&str) -> bool| {
        let text = text_or(fields(key).as_ref(), "");
        if valid(&text) { text } else { String::new() }
    };
    DeviceVersion { app_version: usable("appVersion", is_desktop_version), renderer_release: usable("rendererRelease", is_shell_version) }
}

pub(super) fn row_version(row: &Map<String, Value>) -> DeviceVersion {
    clean_report(&|key| row.get(key).cloned())
}

/// The report of a `desktop-version` frame (`report?.appVersion`), or none when it is not an object.
pub(super) fn report_version(report: &Value) -> DeviceVersion {
    clean_report(&|key| report.get(key).cloned())
}

/// `applyStoredVersion`: drops unusable version fields from a row loaded off disk.
pub(super) fn apply_stored_version(row: &mut Map<String, Value>, now: i64) {
    let DeviceVersion { app_version, renderer_release } = row_version(row);
    if app_version.is_empty() {
        row.shift_remove("appVersion");
        row.shift_remove("rendererRelease");
        row.shift_remove("versionSeenAt");
        return;
    }
    row.insert("appVersion".to_owned(), Value::String(app_version));
    if renderer_release.is_empty() {
        row.shift_remove("rendererRelease");
    } else {
        row.insert("rendererRelease".to_owned(), Value::String(renderer_release));
    }
    let seen = finite(row.get("versionSeenAt")).map_or_else(|| Value::Number(Number::from(now)), number_value);
    row.insert("versionSeenAt".to_owned(), seen);
}

/// `recordDesktopVersion` on a row: whether the row changed. `None` is an unusable report. An unchanged report refreshes the
/// timestamp only once it is older than [`SEEN_REFRESH_MS`].
pub(super) fn record_version(row: &mut Map<String, Value>, report: &DeviceVersion, now: i64) -> Option<bool> {
    if report.app_version.is_empty() {
        return None;
    }
    let stored_release = text_or(row.get("rendererRelease"), "");
    let unchanged = row.get("appVersion").and_then(Value::as_str) == Some(report.app_version.as_str()) && stored_release == report.renderer_release;
    let seen = finite(row.get("versionSeenAt")).unwrap_or(0.0);
    if unchanged && (now as f64) - seen < SEEN_REFRESH_MS {
        return Some(false);
    }
    row.insert("appVersion".to_owned(), Value::String(report.app_version.clone()));
    if report.renderer_release.is_empty() {
        row.shift_remove("rendererRelease");
    } else {
        row.insert("rendererRelease".to_owned(), Value::String(report.renderer_release.clone()));
    }
    row.insert("versionSeenAt".to_owned(), Value::Number(Number::from(now)));
    Some(true)
}
