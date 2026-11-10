//! Snapshots (`backupUserData`, `ensureUserDataInitialized`): the folder claimed for one, the copy into it, the manifest
//! that publishes it, and the ring that keeps the newest forty.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_statefile::IoLane;
use mixdog_statefile::WriteLane;
use serde_json::Map;
use serde_json::Value;

use super::BACKUP_MANIFEST;
use super::CONFIG_FILE;
use super::GuardError;
use super::USER_DATA_DIRS;
use super::UserData;
use super::names::iso;
use super::names::to_prune;
use super::normalize_data_dir;
use super::read_json;
use super::resolve;

/// What a snapshot did: the folder it made and the files it copied; none when there was nothing to copy.
#[derive(Debug, Default)]
pub struct BackupResult {
    pub dir: Option<PathBuf>,
    pub copied: Vec<PathBuf>,
}

/// `scopeBackupNames(entries)`: the folders of a scope (a link to one is not a folder here).
pub(super) fn dir_names<L: IoLane>(lane: &InLane<L>, dir: &Path) -> Result<Vec<String>, GuardError> {
    let mut names = Vec::new();
    for name in mixdog_statefile::list_dir(lane, dir)? {
        // `readdirSync(dir, { withFileTypes: true })` types the entry itself, not what a link points at.
        if mixdog_statefile::symlink_metadata(lane, &dir.join(&name)).is_ok_and(|meta| meta.is_dir()) {
            names.push(name);
        }
    }
    Ok(names)
}

/// `statSync(path).mode & 0o777`; where a file has no Unix mode, the new-file default of the publisher.
fn file_mode(meta: &std::fs::Metadata) -> u32 {
    crate::config::source_mode(meta)
}

impl UserData {
    /// `listBackupDirsNewestFirst(dir)`: the folder names of `dir`, newest first; none when it is absent, an error on any
    /// other failure.
    pub(super) fn backup_dirs_newest_first<L: IoLane>(&self, lane: &InLane<L>, dir: &Path) -> Result<Vec<String>, GuardError> {
        match dir_names(lane, dir) {
            Ok(mut names) => {
                names.sort_by(|a, b| super::names::js_order(b, a));
                Ok(names)
            }
            Err(error) if error.is_absent() => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// `backupDirsNewestFirst(dir)`: as above, none when unreadable.
    pub(super) fn backup_dirs_or_none<L: IoLane>(&self, lane: &InLane<L>, dir: &Path) -> Vec<String> {
        self.backup_dirs_newest_first(lane, dir).unwrap_or_default()
    }

    /// `reserveBackupDir(scopeDir, reason)`: claims the next name with an exclusive `mkdir` (an existing one moves on to the
    /// next). The scope's names are listed first and a listing failure is an error: a name guessed without it could sort
    /// before the newest backup. Answers the folder and the scope's names, the claimed one among them.
    fn reserve<L: WriteLane>(&self, lane: &InLane<L>, scope_dir: &Path, reason: &str) -> Result<(PathBuf, Vec<String>), GuardError> {
        mixdog_statefile::create_dir_all(lane, scope_dir)?;
        let mut names = dir_names(lane, scope_dir)?;
        loop {
            let name = self.state().counter.next_name(&names, reason, self.now());
            names.push(name.clone());
            let dir = scope_dir.join(&name);
            match mixdog_statefile::create_dir(lane, &dir) {
                Ok(()) => return Ok((dir, names)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// `copyTree(src, dst, copied)`: every file below `src`, copied through an fsynced handle (a plain copy can leave a
    /// backup that is NUL exactly when a crash makes it needed) with the mode of its source.
    fn copy_tree<L: WriteLane>(&self, lane: &InLane<L>, src: &Path, dst: &Path, copied: &mut Vec<PathBuf>) -> Result<(), GuardError> {
        let meta = mixdog_statefile::metadata(lane, src)?;
        if meta.is_dir() {
            for name in mixdog_statefile::list_dir(lane, src)? {
                self.copy_tree(lane, &src.join(&name), &dst.join(&name), copied)?;
            }
            return Ok(());
        }
        if !meta.is_file() {
            return Ok(());
        }
        let bytes = mixdog_statefile::read_content(src)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        let opts = mixdog_statefile::Opts { mode: file_mode(&meta), ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_file_stepped(lane, dst, &bytes, &opts)?;
        // Windows has no mode bits: a file without write permission is created read-only, and stays so.
        #[cfg(windows)]
        if meta.permissions().readonly() {
            mixdog_statefile::set_readonly(lane, dst, true)?;
        }
        copied.push(dst.to_path_buf());
        Ok(())
    }

    /// `finishBackup(dataDir, backupDir, reason)`: marks first so the manifest carries this incarnation's `instanceId`; the
    /// manifest goes last, so an interrupted copy is never restorable.
    fn finish<L: WriteLane>(&self, lane: &InLane<L>, data_dir: &Path, backup_dir: &Path, reason: &str) -> Result<(), GuardError> {
        let instance_id = self.mark_initialized(lane, data_dir)?;
        let mut manifest = Map::new();
        manifest.insert("dataDir".into(), Value::String(resolve(data_dir).to_string_lossy().into_owned()));
        manifest.insert("instanceId".into(), instance_id.map_or(Value::Null, Value::String));
        manifest.insert("reason".into(), Value::String(reason.to_owned()));
        manifest.insert("createdAt".into(), Value::String(iso(self.now())));
        mixdog_statefile::write_json(lane, &backup_dir.join(BACKUP_MANIFEST), &Value::Object(manifest), &mixdog_statefile::Opts::default())
            .map_err(|error| GuardError::Io(io::Error::other(error.to_string())))?;
        self.forget(&normalize_data_dir(data_dir));
        Ok(())
    }

    /// `pruneBackups(scopeDir, names, own)`: prunes one data dir's scope only; other scopes, legacy entries and unfinished
    /// reservations stay. Only a published manifest makes a backup count toward retention.
    fn prune<L: WriteLane>(&self, lane: &InLane<L>, scope_dir: &Path, names: &[String], own: &str) {
        let completed: Vec<String> = names
            .iter()
            .filter(|name| mixdog_statefile::metadata(lane, &scope_dir.join(name).join(BACKUP_MANIFEST)).is_ok_and(|meta| meta.is_file()))
            .cloned()
            .collect();
        for name in to_prune(&completed, own) {
            let _ = mixdog_statefile::remove_dir_all(lane, &scope_dir.join(name));
        }
    }

    /// `backupUserData(dataDir, reason, { dirs })`: copies the config and the user-data folders to a new backup of the data
    /// dir's scope. `dirs` are more data-dir folders this one snapshot also carries (a one-time migration's, e.g. `agents/`
    /// and `bots/`: [`BOT_SPLIT_BACKUP_DIRS`](super::BOT_SPLIT_BACKUP_DIRS)); routine snapshots keep to the three folders so the
    /// ring stays small.
    pub fn backup_user_data<L: WriteLane>(&self, lane: &InLane<L>, data_dir: &Path, reason: &str, dirs: &[&str]) -> Result<BackupResult, GuardError> {
        if self.env.skips_backups() || data_dir.as_os_str().is_empty() || mixdog_statefile::metadata(lane, data_dir).is_err() {
            return Ok(BackupResult::default());
        }
        let scope_dir = self.scope_dir(data_dir)?;
        let (backup_dir, names) = self.reserve(lane, &scope_dir, reason)?;
        let mut copied = Vec::new();
        let made = (|| {
            for rel in std::iter::once(CONFIG_FILE).chain(USER_DATA_DIRS).chain(dirs.iter().copied()) {
                let src = data_dir.join(rel);
                if mixdog_statefile::metadata(lane, &src).is_ok() {
                    self.copy_tree(lane, &src, &backup_dir.join(rel), &mut copied)?;
                }
            }
            if copied.is_empty() { Ok(()) } else { self.finish(lane, data_dir, &backup_dir, reason) }
        })();
        if let Err(error) = made {
            // Drops only this call's reservation; a failed cleanup must not mask the cause.
            let _ = mixdog_statefile::remove_dir_all(lane, &backup_dir);
            return Err(error);
        }
        if copied.is_empty() {
            mixdog_statefile::remove_dir_all(lane, &backup_dir)?;
            return Ok(BackupResult::default());
        }
        let own = backup_dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        self.prune(lane, &scope_dir, &names, &own);
        if !self.env.quiet() {
            self.line(&format!("[user-data-backup] {reason}: copied {} file(s) to {}", copied.len(), backup_dir.display()));
        }
        Ok(BackupResult { dir: Some(backup_dir), copied })
    }

    /// `hasPublishedBackup(dataDir)`: whether the data dir's scope holds a published backup of its current incarnation
    /// (the marker's `instanceId`). A transient manifest read failure is an error.
    fn has_published_backup<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path) -> Result<bool, GuardError> {
        let Some(instance_id) = self.init_instance_id(data_dir)? else { return Ok(false) };
        let key = normalize_data_dir(data_dir);
        let scope_dir = self.scope_dir(data_dir)?;
        for name in self.backup_dirs_newest_first(lane, &scope_dir)? {
            match read_json(&scope_dir.join(&name).join(BACKUP_MANIFEST)) {
                Ok(manifest) => {
                    let named = manifest.get("dataDir").and_then(Value::as_str).is_some_and(|dir| normalize_data_dir(Path::new(dir)) == key);
                    if named && manifest.get("instanceId").and_then(Value::as_str) == Some(instance_id.as_str()) {
                        return Ok(true);
                    }
                }
                Err(error) if error.is_absent() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }

    /// `ensureUserDataInitialized(dataDir)`: called when a readable config is observed. A data dir that predates the in-dir
    /// marker (an upgraded install) gets its marker together with a first scoped snapshot, so a later loss of the config
    /// stays recoverable. Once per data dir per process.
    pub fn ensure_initialized<L: WriteLane>(&self, lane: &InLane<L>, data_dir: &Path) -> Result<(), GuardError> {
        if data_dir.as_os_str().is_empty() || self.env.skips_backups() {
            return Ok(());
        }
        let key = normalize_data_dir(data_dir);
        if self.state().ensured.contains(&key) {
            return Ok(());
        }
        // The marker alone is no proof: a first snapshot whose manifest failed left it behind. Only a published backup of
        // this incarnation counts, so a failed or interrupted one is taken again by the next read or restart.
        if !self.has_published_backup(lane, data_dir)? {
            self.backup_user_data(lane, data_dir, "initial-snapshot", &[])?;
            if !self.has_published_backup(lane, data_dir)? {
                return Ok(());
            }
        }
        self.state().ensured.insert(key);
        Ok(())
    }
}
