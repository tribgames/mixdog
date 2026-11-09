//! Which backup restores a lost config (`findRestorableConfig`, `loadLatestMixdogConfigFromBackup`) and the evidence
//! that an older build initialized a dir (`findLegacyUserDataEvidence`, `isUserDataRecoveryExpected`).

use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_statefile::IoLane;
use serde_json::Value;

use super::BACKUP_MANIFEST;
use super::CONFIG_FILE;
use super::GuardError;
use super::LegacyHit;
use super::RestoreHit;
use super::UserData;
use super::hash16;
use super::names::SCOPE_PREFIX;
use super::normalize_data_dir;
use super::read_json;
use super::resolve;
use crate::workflow::ids::truthy;

/// What shows an older build initialized a dir that has no in-dir marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyEvidence {
    /// The `.initialized-<hash>.json` markers of the dir.
    pub markers: Vec<PathBuf>,
    /// The unscoped backups whose manifest names the dir, newest first.
    pub backups: Vec<PathBuf>,
    /// The roots searched.
    pub roots: Vec<PathBuf>,
}

/// `isStructurallyCompleteMixdogConfigBackup(parsed)`: skips single-section wipe remnants (e.g. `{ search: … }` only).
fn is_complete(parsed: &Value) -> bool {
    let Some(map) = parsed.as_object() else { return false };
    map.len() > 1 && (truthy(map.get("agent")) || truthy(map.get("channels")))
}

fn names_dir(manifest: &Value, key: &str) -> bool {
    manifest.get("dataDir").and_then(Value::as_str).is_some_and(|dir| normalize_data_dir(Path::new(dir)) == key)
}

impl UserData {
    /// `legacyBackupRoots()`: the current root, and the older builds' when it differs.
    fn legacy_roots(&self) -> Result<Vec<PathBuf>, GuardError> {
        let legacy = self.env.legacy_root()?;
        let current = self.env.backup_root()?;
        Ok(if normalize_data_dir(&legacy) == normalize_data_dir(&current) { vec![current] } else { vec![current, legacy] })
    }

    /// `manifestDataDirMatches(backupDir, dataDirKey)`.
    fn manifest_names(&self, backup_dir: &Path, key: &str) -> bool {
        read_json(&backup_dir.join(BACKUP_MANIFEST)).is_ok_and(|manifest| names_dir(&manifest, key))
    }

    /// `legacyMarkersFor(root, dataDir, dataDirKey)`.
    fn legacy_markers<L: IoLane>(&self, lane: &InLane<L>, root: &Path, data_dir: &Path, key: &str) -> Vec<PathBuf> {
        let given = data_dir.to_string_lossy().into_owned();
        let hashed = [given, resolve(data_dir).to_string_lossy().into_owned()].map(|value| format!(".initialized-{}.json", hash16(&value)));
        let Ok(names) = mixdog_statefile::list_dir(lane, root) else { return Vec::new() };
        names
            .into_iter()
            .filter(|name| name.starts_with(".initialized-") && name.ends_with(".json"))
            .filter(|name| hashed.contains(name) || read_json(&root.join(name)).is_ok_and(|marker| names_dir(&marker, key)))
            .map(|name| root.join(name))
            .collect()
    }

    fn scan_legacy<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, key: &str) -> Result<Option<LegacyEvidence>, GuardError> {
        if !self.backup_dirs_or_none(lane, &self.scope_dir(data_dir)?).is_empty() {
            return Ok(None);
        }
        let roots = self.legacy_roots()?;
        let (mut markers, mut backups) = (Vec::new(), Vec::new());
        for root in &roots {
            markers.extend(self.legacy_markers(lane, root, data_dir, key));
            for name in self.backup_dirs_or_none(lane, root) {
                if !name.starts_with(SCOPE_PREFIX) && self.manifest_names(&root.join(&name), key) {
                    backups.push(root.join(name));
                }
            }
        }
        let base = |path: &PathBuf| path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        backups.sort_by(|x, y| mixdog_js::locale_compare(&base(y), &base(x)));
        Ok((!markers.is_empty() || !backups.is_empty()).then_some(LegacyEvidence { markers, backups, roots }))
    }

    /// `findLegacyUserDataEvidence(dataDir, { fresh })`: evidence that a data dir without the in-dir marker was initialized
    /// by an older build: a legacy marker for it, or an unscoped backup whose manifest names it. `None` when there is none,
    /// or when the dir was already migrated (scoped backups exist), so a recreated profile stays fresh. A plain read
    /// reuses the last scan while the roots are unchanged (a fresh install with a missing config would otherwise rescan
    /// the legacy root on every read); a `fresh` lookup (a write) always rescans, and this process's own backups drop it.
    pub fn legacy_evidence<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, fresh: bool) -> Result<Option<LegacyEvidence>, GuardError> {
        if data_dir.as_os_str().is_empty() || self.has_init_marker(data_dir)? {
            return Ok(None);
        }
        let key = normalize_data_dir(data_dir);
        let roots = self.legacy_roots()?.iter().map(|root| root.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\n");
        if !fresh && let Some(hit) = self.state().legacy.get(&key).filter(|hit| hit.roots == roots) {
            return Ok(hit.evidence.clone());
        }
        let evidence = self.scan_legacy(lane, data_dir, &key)?;
        self.state().legacy.insert(key, LegacyHit { roots, evidence: evidence.clone() });
        Ok(evidence)
    }

    /// `isUserDataRecoveryExpected(dataDir, options)`: a missing config is a loss to recover (not a fresh install).
    pub fn is_recovery_expected<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, fresh: bool) -> Result<bool, GuardError> {
        Ok(self.has_init_marker(data_dir)? || self.legacy_evidence(lane, data_dir, fresh)?.is_some())
    }

    /// `readRestorableConfig(backupDir, dataDirKey, instanceId)`: a backup is restorable only when its manifest names this
    /// data dir and this incarnation of it. Legacy unscoped backups carry no manifest, so they stay on disk but never
    /// match. A transient read failure is an error: skipping the backup would restore an older one instead.
    fn restorable(&self, backup_dir: &Path, key: &str, instance_id: &str) -> Result<Option<Value>, GuardError> {
        let read = || -> Result<Option<Value>, GuardError> {
            let manifest = read_json(&backup_dir.join(BACKUP_MANIFEST))?;
            if !names_dir(&manifest, key) || manifest.get("instanceId").and_then(Value::as_str) != Some(instance_id) {
                return Ok(None);
            }
            let parsed = read_json(&backup_dir.join(CONFIG_FILE))?;
            Ok(is_complete(&parsed).then_some(parsed))
        };
        match read() {
            Err(error) if error.is_absent() => Ok(None),
            other => other,
        }
    }

    /// `findRestorableConfig(dataDir, instanceId)`: the scope's backups newest first, then the unscoped ones of the root.
    fn find_restorable<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, instance_id: &str) -> Result<Option<Value>, GuardError> {
        let key = normalize_data_dir(data_dir);
        let scope_dir = self.scope_dir(data_dir)?;
        for name in self.backup_dirs_newest_first(lane, &scope_dir)? {
            if let Some(parsed) = self.restorable(&scope_dir.join(name), &key, instance_id)? {
                return Ok(Some(parsed));
            }
        }
        let root = self.env.backup_root()?;
        for name in self.backup_dirs_newest_first(lane, &root)? {
            if name.starts_with(SCOPE_PREFIX) {
                continue;
            }
            if let Some(parsed) = self.restorable(&root.join(name), &key, instance_id)? {
                return Ok(Some(parsed));
            }
        }
        Ok(None)
    }

    /// `loadLatestMixdogConfigFromBackup(dataDir, options)`: the newest structurally complete `mixdog-config.json` backed up
    /// from THIS data dir (skipping degenerate single-section snapshots from a prior failed write). Never another data
    /// dir's config, and nothing for an uninitialized one. A hit is reused while the backup root and the marker's
    /// `instanceId` are unchanged; this process's own backups invalidate it, and a `fresh` lookup (a write, which another
    /// process's newer backup may precede) always rescans. A transient read failure is an error and is never cached.
    pub fn load_latest_config<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, fresh: bool) -> Result<Option<Value>, GuardError> {
        let Some(instance_id) = self.init_instance_id(data_dir)? else { return self.load_legacy_config(lane, data_dir, fresh) };
        let key = normalize_data_dir(data_dir);
        let root = self.env.backup_root()?;
        if !fresh && let Some(hit) = self.state().restore.get(&key).filter(|hit| hit.root == root && hit.instance_id == instance_id) {
            return Ok(hit.config.clone());
        }
        self.state().restore.remove(&key);
        let config = self.find_restorable(lane, data_dir, &instance_id)?;
        self.state().restore.insert(key, RestoreHit { root, instance_id, config: config.clone() });
        Ok(config)
    }

    /// `loadLegacyMixdogConfigFromBackup(dataDir, options)`: an upgraded data dir without the in-dir marker; only an
    /// unscoped backup whose manifest names this data dir is verifiable (legacy backups predate instanceIds).
    fn load_legacy_config<L: IoLane>(&self, lane: &InLane<L>, data_dir: &Path, fresh: bool) -> Result<Option<Value>, GuardError> {
        let evidence = self.legacy_evidence(lane, data_dir, fresh)?;
        for backup_dir in evidence.iter().flat_map(|evidence| &evidence.backups) {
            if let Ok(parsed) = read_json(&backup_dir.join(CONFIG_FILE))
                && is_complete(&parsed)
            {
                return Ok(Some(parsed));
            }
        }
        Ok(None)
    }
}
