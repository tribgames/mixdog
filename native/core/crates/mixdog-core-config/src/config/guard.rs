//! The config layer's use of the user-data guard (`runtime/shared/config.mjs`): what a read does with a config that is
//! missing or damaged (`readConfigFile`, `readAll`, `persistRestoredConfig`), what a write starts from
//! (`readAllForRmW`, `restoreAllForRmWOrThrow`), and the snapshots a write is wrapped in (`writeConfigFile`).
//!
//! The document the actor holds stands for the file while the file is intact, so a read or a write only consults the
//! guard when the file is not: missing, not JSON, or not an object.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_statefile::LockOpts;
use serde_json::Value;

use super::ConfigError;
use super::ConfigLanes;
use super::Doc;
use super::canonical;
use super::lock;
use super::on_lane;
use super::write_file;
use crate::user_data::UserData;

/// What the config file holds.
pub(super) enum Seen {
    Missing,
    /// The text `null`: `readConfigFile` answers it as no file.
    Null,
    Object(Doc),
    /// JSON that is no object (`[]`, a string, …).
    NotObject,
    /// Text that is not JSON, in V8's words.
    Malformed(String),
}

fn classify(bytes: Option<Vec<u8>>) -> Seen {
    let Some(bytes) = bytes else { return Seen::Missing };
    match mixdog_statefile::parse_json_text(&bytes) {
        Ok(Value::Object(doc)) => Seen::Object(doc),
        Ok(Value::Null) => Seen::Null,
        Ok(_) => Seen::NotObject,
        Err(error) => Seen::Malformed(mixdog_statefile::json_text_problem(&bytes).unwrap_or_else(|| error.to_string())),
    }
}

/// What a read-modify-write starts from.
pub(super) struct Baseline {
    /// The guard's document; `None` is the actor's own (the file is intact).
    pub doc: Option<Doc>,
    /// The file was lost or damaged: write even when the edit changes nothing.
    pub forced: bool,
}

impl Baseline {
    fn memory() -> Self {
        Self { doc: None, forced: false }
    }
}

pub(super) struct Guard {
    path: PathBuf,
    pub(super) user_data: Arc<UserData>,
    /// Config paths whose restore could not be persisted: the in-memory restore is still served, but the failure is
    /// logged (and the write retried) only once per process instead of on every read.
    persist_failed: Mutex<HashSet<PathBuf>>,
}

/// `mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 })`: mode 0700 where there are mode bits; on Windows the
/// mode is advisory, so the folder takes the ACL it inherits (no owner-only DACL of its own, unlike `create_private_dir_all`).
fn create_config_dir(lane: &InLane<DurabilityIo>, dir: &Path) -> Result<(), ConfigError> {
    #[cfg(unix)]
    let created = mixdog_statefile::create_private_dir_all(lane, dir);
    #[cfg(windows)]
    let created = mixdog_statefile::create_dir_all(lane, dir);
    Ok(created?)
}

fn user_data_error(error: crate::user_data::GuardError) -> ConfigError {
    ConfigError::UserData { code: None, message: error.to_string() }
}

impl Guard {
    pub(super) fn new(path: PathBuf, user_data: Arc<UserData>) -> Self {
        Self { path, user_data, persist_failed: Mutex::default() }
    }

    pub(super) fn data_dir(&self) -> &Path {
        match self.path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir,
            _ => Path::new("."),
        }
    }

    fn line(&self, text: &str) {
        self.user_data.line(text);
    }

    /// `readAll()` of a config file: a readable one settles the dir's first snapshot (an upgraded install gets its marker
    /// and a scoped backup, so its config stays recoverable); a missing or damaged one is recovered. `in_pass` is a read
    /// of the change notification pass (the file watch): a config that does not parse is then a write in progress, and
    /// the current document stays.
    pub(super) async fn read(self: &Arc<Self>, lanes: ConfigLanes, in_pass: bool) -> Result<Doc, ConfigError> {
        let path = self.path.clone();
        let read = on_lane(lanes.read, move |_| mixdog_statefile::read_content(&path)).await?;
        let bytes = read.map_err(|error| {
            self.line(&format!("[config] readJsonFile: unexpected read error for {}: {error}", self.path.display()));
            ConfigError::from(error)
        })?;
        match classify(bytes) {
            Seen::Object(doc) => {
                self.ensure(lanes).await;
                Ok(canonical::canonicalize(doc))
            }
            Seen::NotObject => {
                self.ensure(lanes).await;
                Ok(Doc::new())
            }
            Seen::Malformed(reason) if in_pass => Err(ConfigError::Parse(reason)),
            lost => {
                let guard = self.clone();
                on_lane(lanes.write, move |lane| guard.recover(lane, lost)).await?
            }
        }
    }

    /// `ensureUserDataInitialized` (best effort: a failure is never a failed read).
    async fn ensure(self: &Arc<Self>, lanes: ConfigLanes) {
        if !self.user_data.needs_ensure(self.data_dir()) {
            return;
        }
        let guard = self.clone();
        let _ = on_lane(lanes.write, move |lane| {
            let _ = guard.user_data.ensure_initialized(lane, guard.data_dir());
        })
        .await;
    }

    /// `readConfigFile`'s quarantine of a malformed config, then `readAll`'s answer for a lost one: a missing or unreadable
    /// config on a data dir that was previously initialized means the file was LOST (deleted, failed write), not a fresh
    /// install. It is healed from this data dir's newest structurally complete backup instead of silently collapsing to `{}`,
    /// which callers merge with in-memory defaults, dropping the user's presets, agent routes and sections. The restore is
    /// persisted under the config lock (only if the file is still missing) so later reads hit the file. A recreated data
    /// dir has no marker and starts fresh.
    fn recover(&self, lane: &InLane<DurabilityIo>, lost: Seen) -> Result<Doc, ConfigError> {
        if let Seen::Malformed(reason) = &lost {
            self.quarantine(lane, reason);
        }
        let dir = self.data_dir();
        if self.user_data.is_recovery_expected(lane, dir, false).map_err(user_data_error)? {
            match self.user_data.load_latest_config(lane, dir, false) {
                Ok(Some(Value::Object(restored))) => {
                    let config = canonical::canonicalize(restored);
                    self.persist_restored(lane, &config);
                    return Ok(config);
                }
                Ok(_) => {}
                // A transient backup read failure: this read stays empty and the next one retries (a write refuses instead).
                Err(error) => self.line(&format!("[config] backup restore lookup failed: {error}")),
            }
        }
        Ok(Doc::new())
    }

    /// `quarantineMalformedConfig(parseErr)`: the damaged file is kept aside as `<file>.corrupt-<ms>`; answers whether it is.
    fn quarantine(&self, lane: &InLane<DurabilityIo>, reason: &str) -> bool {
        let corrupt = mixdog_statefile::quarantine_path(&self.path);
        let mut kept_aside = false;
        if mixdog_statefile::metadata(lane, &self.path).is_ok() {
            let _ = mixdog_statefile::rename_with_retry(lane, &self.path, &corrupt);
            kept_aside = mixdog_statefile::metadata(lane, &corrupt).is_ok();
        }
        self.line(&format!(
            "[config] mixdog-config.json is malformed ({reason}). Renamed to {}. Restore it or delete to start fresh.",
            corrupt.display()
        ));
        kept_aside
    }

    /// `persistRestoredConfig(restored)`: writes a config restored on a plain read back through the normal save path (atomic
    /// write and snapshots), so later reads hit the file instead of restoring again. Try-once lock: a contended lock means a
    /// writer is about to persist, so the next read retries.
    fn persist_restored(&self, lane: &InLane<DurabilityIo>, restored: &Doc) {
        if lock(&self.persist_failed).contains(&self.path) {
            return;
        }
        let opts = LockOpts { timeout: Some(Duration::ZERO), ..LockOpts::default() };
        let wrote = mixdog_statefile::with_lock(lane, &self.path, &opts, || {
            if mixdog_statefile::metadata(lane, &self.path).is_ok() {
                return Ok(false);
            }
            self.write(lane, restored, "post-restore")?;
            Ok::<bool, ConfigError>(true)
        });
        let failed = match wrote {
            Ok(Ok(true)) => {
                self.line("[config] read: restored mixdog-config.json from latest user-data backup (missing after init) and saved it");
                return;
            }
            Ok(Ok(false)) => return,
            Err(busy) if busy.code() == Some("ELOCKCONTENDED") => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => error.to_string(),
        };
        lock(&self.persist_failed).insert(self.path.clone());
        self.line(&format!(
            "[config] read: restored mixdog-config.json from latest user-data backup (missing after init); saving it failed, serving it from memory: {failed}"
        ));
    }

    /// `writeConfigFile(data, postBackupReason)`: the config folder, a snapshot of what is there, the atomic write, the init
    /// marker, and a snapshot of what was written. A failed snapshot or marker never fails the write.
    pub(super) fn write(&self, lane: &InLane<DurabilityIo>, doc: &Doc, post_reason: &str) -> Result<(), ConfigError> {
        let dir = self.data_dir();
        create_config_dir(lane, dir)?;
        let _ = self.user_data.backup_user_data(lane, dir, "pre-config-write", &[]);
        write_file(lane, &self.path, doc)?;
        let _ = self.user_data.mark_initialized(lane, dir);
        let _ = self.user_data.backup_user_data(lane, dir, post_reason, &[]);
        Ok(())
    }

    /// Runs a read-modify-write under the config's file lock, from the baseline `readAllForRmW` settles on.
    pub(super) fn locked<R>(
        &self,
        lane: &InLane<DurabilityIo>,
        body: impl FnOnce(Baseline) -> Result<R, ConfigError>,
    ) -> Result<R, ConfigError> {
        let result = mixdog_statefile::with_lock(lane, &self.path, &LockOpts::default(), || body(self.baseline(lane)?));
        match result {
            Ok(done) => done,
            Err(error) => Err(std::io::Error::other(error.to_string()).into()),
        }
    }

    /// `readAllForRmW()`: a never-initialized dir without a config starts from `{}`; a config that is missing after the dir
    /// was initialized, or damaged, is restored from backup or refused, never silently collapsed to a one-section overwrite.
    /// The exception is a damaged config whose bytes were kept aside as `.corrupt-<ms>`: with no backup to restore, the
    /// save starts from an empty config. A config that cannot be READ (I/O error) still fails.
    fn baseline(&self, lane: &InLane<DurabilityIo>) -> Result<Baseline, ConfigError> {
        let bytes = mixdog_statefile::read_content(&self.path).map_err(|error| {
            self.line(&format!("[config] readAllForRmW: unexpected read error for {}: {error}", self.path.display()));
            ConfigError::from(error)
        })?;
        let reason = match classify(bytes) {
            Seen::Object(_) => return Ok(Baseline::memory()),
            Seen::Missing => {
                let dir = self.data_dir();
                if !self.user_data.is_recovery_expected(lane, dir, true).map_err(user_data_error)? {
                    return Ok(Baseline { doc: Some(Doc::new()), forced: false });
                }
                return self.restore(lane, "config file missing after user-data was initialized", self.has_quarantined_copy(lane));
            }
            Seen::Null | Seen::NotObject => "config root must be a JSON object".to_owned(),
            Seen::Malformed(reason) => reason,
        };
        let kept_aside = self.quarantine(lane, &reason);
        self.restore(lane, &reason, kept_aside)
    }

    /// `hasQuarantinedCopy()`: a damaged config kept aside is not a lost config: those bytes are the safety net.
    fn has_quarantined_copy(&self, lane: &InLane<DurabilityIo>) -> bool {
        let prefix = format!("{}.corrupt-", self.path.file_name().unwrap_or_default().to_string_lossy());
        mixdog_statefile::list_dir(lane, self.data_dir()).is_ok_and(|names| names.iter().any(|name| name.starts_with(&prefix)))
    }

    /// `restoreAllForRmWOrThrow(reason, keptAside)`.
    fn restore(&self, lane: &InLane<DurabilityIo>, reason: &str, kept_aside: bool) -> Result<Baseline, ConfigError> {
        let dir = self.data_dir();
        if let Some(Value::Object(restored)) = self.user_data.load_latest_config(lane, dir, true).map_err(user_data_error)? {
            self.line(&format!("[config] RMW read: restored mixdog-config.json from latest user-data backup ({reason})"));
            return Ok(Baseline { doc: Some(restored), forced: true });
        }
        if kept_aside {
            self.line(&format!(
                "[config] RMW read: mixdog-config.json is unusable ({reason}); its bytes are kept aside and no backup exists; starting empty"
            ));
            return Ok(Baseline { doc: Some(Doc::new()), forced: true });
        }
        if let Some(legacy) = self.user_data.legacy_evidence(lane, dir, true).map_err(user_data_error)? {
            let roots: Vec<String> = legacy.roots.iter().map(|root| root.display().to_string()).collect();
            let markers: Vec<String> = legacy.markers.iter().map(|marker| marker.display().to_string()).collect();
            let markers = if markers.is_empty() { "(none; matching legacy backups are incomplete)".to_owned() } else { markers.join(", ") };
            return Err(ConfigError::UserData {
                code: Some("EUSERDATARECOVERY"),
                message: format!(
                    "[config] mixdog-config.json is missing but this data dir ({}) was initialized by an older Mixdog build and no backup verified to belong to it was found; refusing to write a fresh config over a recoverable state. Restore mixdog-config.json from a backup under {}, or delete the legacy marker(s) to start fresh: {markers}",
                    dir.display(),
                    roots.join(" or ")
                ),
            });
        }
        Err(ConfigError::UserData {
            code: None,
            message: format!(
                "[config] mixdog-config.json is unreadable and no valid backup was found ({reason}); refusing section write that would wipe other sections"
            ),
        })
    }
}
