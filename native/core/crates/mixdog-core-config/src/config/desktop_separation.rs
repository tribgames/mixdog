//! The one-time defaults separation of the `desktop` section: Node's `DesktopSettingsStore.separateDefaults`
//! (`apps/desktop/src/main/settings-store.ts`), which the desktop app ran in its own process at app-ready.
//! The daemon is the only config writer from K1 on, so it runs the pass: a config whose `desktop` section has no
//! `defaultsSeparationVersion` marker is copied to `<data>/backups/defaults-separation-<timestamp>[-n]/mixdog-config.json`
//! (the pre-image as `JSON.stringify(…, null, 2)`, not the file's bytes), loses the toggles equal to their default, the dead
//! keys `zoomFactor` and `git` and a pin list that was ever the default, and takes the marker. It is a pass of its own,
//! after the core pass of `separation.rs` (two backups when both change something), as in Node where the daemon had
//! separated the file long before the window asked.

use std::path::Path;

use serde_json::Value;

use super::Applied;
use super::Config;
use super::ConfigError;
use super::Doc;
use super::Shared;
use super::canonical;
use super::separation::DEFAULTS_VERSION_KEY;
use super::separation::claim_backup_dir;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;

/// `DEFAULTS_SEPARATION_MARKER` / `DEFAULTS_SEPARATION_VERSION`.
const MARKER: &str = "defaultsSeparationVersion";
const VERSION: f64 = 1.0;
/// `DESKTOP_FLAG_DEFAULTS`: the code defaults of the user-facing toggles; storage holds only a value that differs.
/// The install markers are system state and have none.
const FLAG_DEFAULTS: [(&str, bool); 13] = [
    ("keepAwake", true),
    ("runInBackground", true),
    ("usagePinned", true),
    ("usageRailShortLong", false),
    ("usageAccountsExpanded", false),
    ("usageRailSlotsThree", false),
    ("usageRailSlotsAll", false),
    ("computerControl", false),
    ("computerObserveOnly", false),
    ("browserControl", false),
    ("browserAutoSignIn", true),
    ("browserHidDevices", false),
    ("saveChatLogins", true),
];
/// `HISTORICAL_ACTIVITY_RAIL_PINS`: every activity-rail default list ever shipped (order matters).
const HISTORICAL_ACTIVITY_RAIL_PINS: [&[&str]; 3] = [
    &["sessions", "agents", "schedules", "workflows", "projects"],
    &["sessions", "agents", "schedules", "workflows", "projects", "extensions"],
    &["sessions", "agents", "schedules", "workflows", "projects", "extensions", "skills"],
];

/// `record(value)`: a copy of a plain object, `{}` for anything else.
fn record(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `supported(desktop.defaultsSeparationVersion)`: a number at or above this version.
fn marked(desktop: &Doc) -> bool {
    matches!(desktop.get(MARKER), Some(Value::Number(version)) if version.as_f64().is_some_and(|version| version >= VERSION))
}

/// The config with its `desktop` section separated (the updater of `separateDefaults`).
fn separate(current: &Doc) -> Doc {
    let mut desktop = record(current.get("desktop"));
    for (key, default) in FLAG_DEFAULTS {
        if desktop.get(key) == Some(&Value::Bool(default)) {
            desktop.shift_remove(key);
        }
    }
    desktop.shift_remove("zoomFactor");
    desktop.shift_remove("git");
    let historical = match record(desktop.get("activityRailPins")).get("pins") {
        Some(Value::Array(pins)) => HISTORICAL_ACTIVITY_RAIL_PINS
            .iter()
            .any(|list| pins.len() == list.len() && pins.iter().zip(list.iter()).all(|(pin, id)| pin.as_str() == Some(*id))),
        _ => false,
    };
    if historical {
        desktop.shift_remove("activityRailPins");
    }
    desktop.insert(MARKER.into(), Value::from(VERSION as i64));
    let mut next = current.clone();
    next.insert("desktop".into(), Value::Object(desktop));
    next
}

/// `readAllForRmW()` with `stripGeneratedMarker`: the file as it is now, `{}` when there is none.
fn read_preimage(path: &Path) -> Result<Doc, ConfigError> {
    let Some(bytes) = mixdog_statefile::read_content(path)? else { return Ok(Doc::new()) };
    match mixdog_statefile::parse_json_text(&bytes) {
        Ok(Value::Object(mut doc)) => {
            doc.shift_remove("_generated");
            Ok(doc)
        }
        Ok(_) => Err(ConfigError::Parse("the top level is not an object".into())),
        Err(error) => Err(ConfigError::Parse(error.to_string())),
    }
}

impl Shared {
    /// `separateDefaults` under the config transaction. The gate, the backup and the update read the file itself, as
    /// Node's read-modify-write does (not the canonical document in memory), so the copy is the pre-image Node saved.
    fn separate_desktop_on(&self, lane: &InLane<DurabilityIo>, now_ms: i64) -> Result<(bool, Applied), ConfigError> {
        let mut raised = super::lock(&self.writer);
        let data_dir = self.path.parent().unwrap_or_else(|| Path::new(""));
        // Node's pass is `updateConfig`: under the file's lock, from what `readAllForRmW` settles on, snapshotted by the guard.
        let written = self.guard.locked(lane, |baseline| {
            let preimage = match baseline.doc {
                Some(restored) => restored,
                None => read_preimage(&self.path)?,
            };
            if marked(&record(preimage.get("desktop"))) {
                return Ok(None);
            }
            let dir = claim_backup_dir(lane, data_dir, now_ms)?;
            let opts = mixdog_statefile::Opts::default();
            let bytes = mixdog_statefile::json_bytes(&Value::Object(preimage.clone()), &opts);
            mixdog_statefile::write_file_stepped(lane, &dir.join("mixdog-config.json"), &bytes, &opts).map_err(ConfigError::Publish)?;
            // `writeAll`: a save writes the canonical document; a file with nothing in it is born current.
            let mut next = canonical::canonicalize(separate(&preimage));
            if preimage.is_empty() && !next.contains_key(DEFAULTS_VERSION_KEY) {
                next.insert(DEFAULTS_VERSION_KEY.into(), Value::from(2));
            }
            self.guard.write(lane, &next, "post-config-write")?;
            Ok(Some(next))
        })?;
        let Some(next) = written else { return Ok((false, Applied::default())) };
        let current = self.doc.load_full();
        Ok((true, self.install(&mut raised, &current, next)))
    }
}

impl Config {
    /// `DesktopSettingsStore.separateDefaults(dataDir, now)`: run once per file (the marker is the gate); whether it ran.
    /// `now_ms` names the backup folder.
    pub async fn separate_desktop_defaults(&self, now_ms: i64) -> Result<bool, ConfigError> {
        let shared = self.shared.clone();
        let (ran, _) = super::on_lane(self.lanes.write, move |lane| shared.separate_desktop_on(lane, now_ms)).await??;
        Ok(ran)
    }
}

#[cfg(test)]
mod tests;
