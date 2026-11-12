//! "Use this PC from other devices": the on/off switch and the PC's own name, persisted next to
//! the activation file (`main/remote-access-settings.ts`, `remote-activation.ts`). Turning access
//! off keeps every pairing; it only stops the relay leg. Without a saved switch an install follows
//! its activation, so existing installs keep working. The scope stays device-wide
//! (`global("remoteAccess")`).

#![allow(clippy::disallowed_methods, reason = "settings file I/O runs only in lane jobs (the service submits every call)")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_store::fsio::{Access, IoError, publish_file_with};
use serde::{Deserialize, Serialize};

// The names the migration gives 1.4.5's files in `<data>/remote` (`desktop_profile/plan.rs` FILE_KINDS): 1.4.5's
// `remote-access-settings.json` is `settings.json` there, and so on for every file of this crate.
const SETTINGS_FILE: &str = "settings.json";
const ACTIVATION_FILE: &str = "remote-activated.json";
/// Evidence of an earlier install: such an install counts as activated.
const LEGACY_EVIDENCE_FILES: [&str; 2] = ["device.json", "remote-client-trust.json"];
pub const MAX_REMOTE_PC_NAME_LENGTH: usize = 64;
pub const MAX_DEVICE_ALIAS_LENGTH: usize = 80;

/// What the settings page and the `remote` section show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub enabled: bool,
    pub name: String,
    pub default_name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// Local nicknames for paired devices, keyed by credential id.
    #[serde(skip_serializing_if = "Option::is_none")]
    device_aliases: Option<BTreeMap<String, String>>,
}

pub struct AccessSettings {
    dir: PathBuf,
    default_name: Arc<dyn Fn() -> String + Send + Sync>,
    /// One write at a time, and a read never sees half of one.
    writes: Mutex<()>,
}

fn clip(text: &str, max: usize) -> String {
    mixdog_js::slice_utf16(mixdog_js::js_trim(text), max)
}

impl AccessSettings {
    /// `default_name` is the OS host name; it is clipped to the name limit.
    pub fn new(dir: impl Into<PathBuf>, default_name: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { dir: dir.into(), default_name, writes: Mutex::new(()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn default_name(&self) -> String {
        mixdog_js::slice_utf16(&(self.default_name)(), MAX_REMOTE_PC_NAME_LENGTH)
    }

    fn load(&self) -> Stored {
        let Ok(bytes) = std::fs::read(self.dir.join(SETTINGS_FILE)) else { return Stored::default() };
        // Node cuts the name and the aliases by UTF-16 units, so its file can hold half an emoji (U+FFFD here).
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&mixdog_js::json_well_formed(&bytes)) else { return Stored::default() };
        Stored {
            enabled: value.get("enabled").and_then(serde_json::Value::as_bool),
            name: value.get("name").and_then(serde_json::Value::as_str).map(str::to_owned),
            device_aliases: value.get("deviceAliases").and_then(serde_json::Value::as_object).map(|map| {
                map.iter()
                    .filter_map(|(id, alias)| alias.as_str().filter(|a| !a.is_empty()).map(|a| (id.clone(), a.to_owned())))
                    .collect()
            }),
        }
    }

    fn save(&self, stored: &Stored) -> Result<(), IoError> {
        publish_file_with(&self.dir.join(SETTINGS_FILE), &serde_json::to_vec(stored).unwrap_or_default(), Access::OwnerOnly)
    }

    fn view(&self, stored: &Stored) -> SettingsView {
        SettingsView {
            enabled: stored.enabled.unwrap_or_else(|| self.is_activated()),
            name: stored.name.clone().filter(|name| !name.is_empty()).unwrap_or_else(|| self.default_name()),
            default_name: self.default_name(),
        }
    }

    fn update(&self, patch: impl FnOnce(&mut Stored)) -> Result<Stored, IoError> {
        let _write = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        let mut next = self.load();
        patch(&mut next);
        if next.name.as_deref() == Some("") {
            next.name = None;
        }
        self.save(&next)?;
        Ok(next)
    }

    pub fn read(&self) -> SettingsView {
        let _read = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        self.view(&self.load())
    }

    /// True only when the user switched access off; an install that never chose is not "off", so
    /// its first explicit remote action can still activate it.
    pub fn disabled(&self) -> bool {
        self.load().enabled == Some(false)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<SettingsView, IoError> {
        let stored = self.update(|stored| stored.enabled = Some(enabled))?;
        Ok(self.view(&stored))
    }

    /// Trims to 64 characters; empty resets to the OS host name.
    pub fn set_name(&self, name: &str) -> Result<SettingsView, IoError> {
        let name = clip(name, MAX_REMOTE_PC_NAME_LENGTH);
        let stored = self.update(|stored| stored.name = Some(name))?;
        Ok(self.view(&stored))
    }

    /// Local nicknames of paired devices by credential id.
    pub fn device_aliases(&self) -> BTreeMap<String, String> {
        self.load().device_aliases.unwrap_or_default()
    }

    /// Trims to 80 characters; empty clears the alias. Returns the full map.
    pub fn set_device_alias(&self, client_id: &str, alias: &str) -> Result<BTreeMap<String, String>, IoError> {
        let alias = clip(alias, MAX_DEVICE_ALIAS_LENGTH);
        let stored = self.update(|stored| {
            let aliases = stored.device_aliases.get_or_insert_with(BTreeMap::new);
            if alias.is_empty() {
                aliases.remove(client_id);
            } else {
                aliases.insert(client_id.to_owned(), alias);
            }
        })?;
        Ok(stored.device_aliases.unwrap_or_default())
    }

    /// Whether this install has ever used remote access. A fresh install must not register on the
    /// relay (trust-on-first-use) until the user asks for it; an install that already holds a
    /// relay identity or the legacy client-trust file counts as activated.
    pub fn is_activated(&self) -> bool {
        if self.dir.join(ACTIVATION_FILE).exists() {
            return true;
        }
        if LEGACY_EVIDENCE_FILES.iter().any(|name| self.dir.join(name).exists()) {
            let _ = self.activate();
            return true;
        }
        false
    }

    /// Only presence is ever read: an activated install is not rewritten.
    pub fn activate(&self) -> Result<(), IoError> {
        let path = self.dir.join(ACTIVATION_FILE);
        if path.exists() {
            return Ok(());
        }
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        publish_file_with(&path, format!("{{\"activatedAt\":{at}}}").as_bytes(), Access::OwnerOnly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// `native/core/fixtures/lone-surrogate-files`: Node's settings file with a name cut at 64 units and an alias cut at
    /// 80, each inside an emoji (record-lone-surrogate-files.mjs).
    fn recorded(name: &str) -> (Value, PathBuf) {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = serde_json::from_slice(&std::fs::read(set.join("cases.json")).unwrap()).unwrap();
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
        (case, set.join(name))
    }

    #[test]
    fn a_settings_file_node_cut_inside_an_emoji_keeps_every_field_and_survives_the_next_write() {
        let (case, files) = recorded("remote-access-settings");
        let dir = tempfile::tempdir().unwrap();
        let file = case["file"].as_str().unwrap();
        // Node's file under the name it has in `<data>/remote`.
        std::fs::copy(files.join("before").join(file), dir.path().join(SETTINGS_FILE)).unwrap();
        let settings = AccessSettings::new(dir.path(), Arc::new(|| "HOST".to_owned()));
        assert_eq!(serde_json::to_value(settings.read()).unwrap(), case["nodeRead"]["settings"]);
        assert_eq!(serde_json::to_value(settings.device_aliases()).unwrap(), case["nodeRead"]["deviceAliases"]);
        let op = &case["op"]["setDeviceAlias"];
        settings.set_device_alias(op[0].as_str().unwrap(), op[1].as_str().unwrap()).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap()).unwrap();
        // As text: key order counts too.
        assert_eq!(written.to_string(), case["after"][file].to_string());
    }
}
