//! The sensitive marks on disk (`<data>/sensitive`), so a mark outlives a process that ends before every session holding
//! its value was rewritten:
//! - `carries.json`: every `[from, to]` whose text went from one session to another (ids only), written before the carry
//!   takes effect;
//! - `pending/<n>.json`: one mark not yet applied everywhere, `{origin, values, sessions: {id: version}}`, written before any
//!   listener hears of the mark (so before the marking call runs) and removed once each listed session's log was
//!   rewritten for at least that version. While it exists it holds the values, as the logs it is about do; once every log
//!   is rewritten nothing on disk does, this file included.
//!
//! The next start ([`super::store::StoreThreads::owe_marks`]) restores the carries and each pending mark, withholds every
//! session still owing it from the reads, then rewrites them behind the serving core; each session rewritten is added to the
//! file's `settled` list, so a start after a quit or a crash rewrites only the rest.
//! - `search-owed/<id>`: a session rewritten whose session-search copy (derived from its log before the rewrite) is not yet
//!   confirmed gone: written before the session is answered again, removed once the copy is dropped. While it exists no
//!   search answers the session.
//!
//! The writes block the caller for one durable publish: a mark is rare and must be on disk before it is acknowledged.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::PoisonError;

use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

/// The folder of the search-copy debts: one empty file per session.
const SEARCH_OWED: &str = "search-owed";

type ValueDigest = [u8; 32];

fn value_digest(value: &str) -> ValueDigest {
    Sha256::digest(value.as_bytes()).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Obligation {
    /// Boot-time recovery obligation (cleared by `forget_recovered` or `is_confirmed_done`).
    Boot,
    /// Concrete live rewrite obligation from `marked()` (cleared when `state.applied[s] >= v` or `is_confirmed_done`).
    Version(u64),
    /// Transferred carry obligation created by `forget_session` (cleared only by `is_confirmed_done` or when `s` itself is
    /// forgotten; never cleared by an unrelated `applied(s, v)` bump or `forget_recovered`).
    Transferred,
}

#[derive(Clone)]
struct MarkRecord {
    disk: PendingMark,
    digests: Vec<ValueDigest>,
    recovered: bool,
    owed: BTreeMap<String, Obligation>,
}

impl MarkRecord {
    fn from_recovered(disk: PendingMark) -> Self {
        let digests = disk.values.iter().map(|v| value_digest(v)).collect();
        let owed = recovery_roots(&disk).into_iter().filter(|root| !disk.settled.contains(root)).map(|root| (root, Obligation::Boot)).collect();
        Self { disk, digests, recovered: true, owed }
    }
}

#[cfg(test)]
type SyncDirHook = Box<dyn FnMut(&Path) -> Result<(), String> + Send>;
#[cfg(test)]
type ForgetHook = Box<dyn FnMut(&str) -> Option<Result<(), String>> + Send>;
#[cfg(test)]
type PendingIoHook = Box<dyn FnMut(&Path) -> Result<(), String> + Send>;

#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    sync_dir: Mutex<Option<SyncDirHook>>,
    forget: Mutex<Option<ForgetHook>>,
    pending_io: Mutex<Option<PendingIoHook>>,
    publishes: Mutex<Vec<PathBuf>>,
    pending_dir_reads: std::sync::atomic::AtomicUsize,
}

pub(crate) struct ForgetBatchOutcome {
    pub any_changed: bool,
    pub failed: Vec<(String, String)>,
}

pub(crate) struct Loaded {
    pub carries: Vec<(String, String)>,
    pub pending: BTreeMap<u64, PendingMark>,
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct PendingMark {
    pub origin: String,
    pub values: Vec<String>,
    pub sessions: BTreeMap<String, u64>,
    /// The sessions a start already rewrote for this mark (the listed ones and those it was carried to): the next start does
    /// not rewrite them again for it.
    #[serde(default)]
    pub settled: BTreeSet<String>,
}

#[derive(Default)]
struct State {
    carries: BTreeSet<(String, String)>,
    /// File number → unified live/recovered mark record.
    marks: BTreeMap<u64, MarkRecord>,
    next: u64,
    /// Per session, the newest version its log was rewritten for in this process.
    applied: HashMap<String, u64>,
    /// Per session, SHA-256 digests of sensitive values already confirmed rewritten in this process (pruned to live marks).
    applied_values: HashMap<String, BTreeSet<ValueDigest>>,
    /// The sessions whose session-search copy still holds text from before their rewrite (`search-owed/<id>`).
    search_owed: BTreeSet<String>,
    /// Set before mutating `pending/` entries (publish or unlink) and cleared only once `sync_dir(pending/)` succeeds.
    pending_dir_sync_needed: bool,
}

pub(crate) struct MarksOnDisk {
    dir: PathBuf,
    state: Mutex<State>,
    #[cfg(test)]
    test_hooks: TestHooks,
}

impl MarksOnDisk {
    pub(crate) fn new(data: &Path) -> Self {
        Self {
            dir: data.join("sensitive"),
            state: Mutex::default(),
            #[cfg(test)]
            test_hooks: TestHooks::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_sync_dir_hook(&self, hook: Option<SyncDirHook>) {
        *self.test_hooks.sync_dir.lock().unwrap_or_else(PoisonError::into_inner) = hook;
    }

    #[cfg(test)]
    pub(crate) fn set_forget_hook(&self, hook: Option<ForgetHook>) {
        *self.test_hooks.forget.lock().unwrap_or_else(PoisonError::into_inner) = hook;
    }

    #[cfg(test)]
    pub(crate) fn set_pending_io_hook(&self, hook: Option<PendingIoHook>) {
        *self.test_hooks.pending_io.lock().unwrap_or_else(PoisonError::into_inner) = hook;
    }

    #[cfg(test)]
    pub(crate) fn take_published_paths(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.test_hooks.publishes.lock().unwrap_or_else(PoisonError::into_inner))
    }

    #[cfg(test)]
    pub(crate) fn take_pending_dir_reads(&self) -> usize {
        self.test_hooks.pending_dir_reads.swap(0, std::sync::atomic::Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pending_path(&self, n: u64) -> PathBuf {
        self.dir.join("pending").join(format!("{n}.json"))
    }

    fn publish(&self, path: &Path, value: &Value) {
        if let Err(error) = self.publish_checked(path, value) {
            tracing::error!(path = %path.display(), "a sensitive mark could not be journaled; a restart before its rewrites ends would keep its copies: {error}");
        }
    }

    /// One durable publish of `value` at `path`; the failure is the caller's.
    fn publish_checked(&self, path: &Path, value: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        mixdog_store::fsio::publish_file_with(path, &bytes, mixdog_store::fsio::Access::OwnerOnly).map_err(|error| format!("{}: {error}", path.display()))?;
        #[cfg(test)]
        self.test_hooks.publishes.lock().unwrap_or_else(PoisonError::into_inner).push(path.to_path_buf());
        #[cfg(test)]
        if let Some(parent) = path.parent()
            && self.test_hooks.sync_dir.lock().unwrap_or_else(PoisonError::into_inner).is_some()
        {
            self.sync_dir(parent)?;
        }
        Ok(())
    }

    fn sync_dir(&self, parent: &Path) -> Result<(), String> {
        #[cfg(test)]
        if let Some(hook) = self.test_hooks.sync_dir.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            return hook(parent);
        }
        mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))
    }

    fn publish_pending(&self, state: &mut State, path: &Path, value: &Value) -> Result<(), String> {
        state.pending_dir_sync_needed = true;
        #[cfg(test)]
        if let Some(hook) = self.test_hooks.pending_io.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            hook(path)?;
        }
        self.publish_checked(path, value)?;
        state.pending_dir_sync_needed = false;
        Ok(())
    }

    fn remove_pending(&self, state: &mut State, path: &Path) -> Result<(), String> {
        state.pending_dir_sync_needed = true;
        #[cfg(test)]
        if let Some(hook) = self.test_hooks.pending_io.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            hook(path)?;
        }
        self.remove_checked(path)?;
        state.pending_dir_sync_needed = false;
        Ok(())
    }

    #[allow(clippy::disallowed_methods, reason = "runs inside a lane job")]
    fn remove_checked(&self, path: &Path) -> Result<(), String> {
        let existed = match std::fs::remove_file(path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        // Retry after an unlink that succeeded before parent-dir sync failed sees `NotFound`:
        // still sync an existing parent directory before reporting durability.
        if let Some(parent) = path.parent()
            && (existed || parent.try_exists().unwrap_or(true))
        {
            self.sync_dir(parent)?;
        }
        Ok(())
    }

    /// Every file of the journal, read on a lane job at start; the next file number follows the highest found.
    #[allow(clippy::disallowed_methods, reason = "runs inside a lane job at start")]
    pub(crate) fn load(&self) -> io::Result<Loaded> {
        let carries: Vec<(String, String)> = match std::fs::read(self.dir.join("carries.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid sensitive carry journal"))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        let mut pending = BTreeMap::new();
        let entries = match std::fs::read_dir(self.dir.join("pending")) {
            Ok(entries) => Some(entries),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        for entry in entries.into_iter().flatten() {
            let entry = entry?;
            let name = entry.file_name();
            let Some(n) = name.to_str().and_then(|name| name.strip_suffix(".json")).and_then(|n| n.parse::<u64>().ok()) else { continue };
            let mark: PendingMark = serde_json::from_slice(&std::fs::read(entry.path())?)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid pending sensitive mark"))?;
            pending.insert(n, mark);
        }
        let next = match pending.last_key_value() {
            Some((&last, _)) => last.checked_add(1).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "sensitive mark journal is full"))?,
            None => 0,
        };
        let search_owed = match std::fs::read_dir(self.dir.join(SEARCH_OWED)) {
            Ok(entries) => entries
                .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
                .filter(|name| name.as_ref().map_or(true, |name| !mixdog_store::fsio::is_tmp_name(name)))
                .collect::<io::Result<BTreeSet<String>>>()?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeSet::new(),
            Err(e) => return Err(e),
        };
        let mut state = self.lock();
        state.carries.extend(carries.iter().cloned());
        state.next = state.next.max(next);
        if !state.pending_dir_sync_needed {
            state.marks.retain(|_, record| !record.recovered);
            for (n, mark) in &pending {
                state.marks.insert(*n, MarkRecord::from_recovered(mark.clone()));
            }
            prune_applied_values(&mut state);
        }
        state.search_owed.extend(search_owed);
        Ok(Loaded { carries, pending })
    }

    /// Returns the durable in-memory boot snapshot without re-reading potentially unsynced VFS entries.
    pub(crate) fn snapshot_recovered(&self) -> Loaded {
        let state = self.lock();
        Loaded {
            carries: state.carries.iter().cloned().collect(),
            pending: state.marks.iter().filter(|(_, record)| record.recovered).map(|(n, record)| (*n, record.disk.clone())).collect(),
        }
    }

    /// Seeds in-memory applied watermarks for sessions already settled at boot so later carries of those values
    /// recognize them as covered without creating synthetic debt.
    pub(crate) fn seed_applied(&self, entries: &[(String, u64)]) {
        if entries.is_empty() {
            return;
        }
        let mut state = self.lock();
        for (session, version) in entries {
            if !session.is_empty() && *version > 0 {
                let seen = state.applied.entry(session.clone()).or_default();
                *seen = (*seen).max(*version);
            }
        }
    }

    /// `session`'s search copy holds text from before its rewrite: journaled durably before this returns, and owed until
    /// [`Self::search_discharged`].
    pub(crate) fn owe_search(&self, session: &str) -> Result<(), String> {
        let mut state = self.lock();
        if state.search_owed.contains(session) {
            return Ok(());
        }
        let path = self.dir.join(SEARCH_OWED).join(session);
        mixdog_store::fsio::publish_file_with(&path, b"", mixdog_store::fsio::Access::OwnerOnly).map_err(|error| format!("{}: {error}", path.display()))?;
        state.search_owed.insert(session.to_owned());
        Ok(())
    }

    /// `session`'s search copy is confirmed gone: its debt leaves the journal (durably), then the set.
    #[allow(clippy::disallowed_methods, reason = "runs inside a maintenance lane job")]
    pub(crate) fn search_discharged(&self, session: &str) -> Result<(), String> {
        let mut state = self.lock();
        let path = self.dir.join(SEARCH_OWED).join(session);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
        if let Some(parent) = path.parent() {
            mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        state.search_owed.remove(session);
        Ok(())
    }

    /// The sessions whose search copy is still owed.
    pub(crate) fn search_owed(&self) -> Vec<String> {
        self.lock().search_owed.iter().cloned().collect()
    }

    /// Retire the original recovery records only after every owed rewrite, including index replacement, is durable.
    pub(crate) fn forget_recovered(&self, recovered: Vec<u64>) {
        let mut state = self.lock();
        for n in recovered {
            if let Some(record) = state.marks.get_mut(&n)
                && record.recovered
            {
                record.owed.retain(|_, req| !matches!(req, Obligation::Boot));
                record.recovered = false;
            }
        }
        self.reconcile_and_prune(&mut state);
    }

    /// `session`'s log was rewritten, and its rows rebuilt, for every value of the recovered marks `marks`: each file says so
    /// durably before this returns, so a start after a quit or a crash does not rewrite it again for them. `Err` when a file
    /// could not say so (the session is then rewritten again by the next start, and is not to be answered before).
    pub(crate) fn settled(&self, session: &str, marks: &[u64]) -> Result<(), String> {
        let mut state = self.lock();
        for n in marks {
            let Some(record) = state.marks.get(n) else { continue };
            if record.disk.settled.contains(session) {
                continue;
            }
            let mut next_disk = record.disk.clone();
            next_disk.settled.insert(session.to_owned());
            let path = self.pending_path(*n);
            self.publish_pending(&mut state, &path, &pending_mark_json(&next_disk))?;
            let digests = if let Some(record) = state.marks.get_mut(n) {
                record.disk = next_disk;
                record.owed.remove(session);
                record.digests.clone()
            } else {
                Vec::new()
            };
            if !digests.is_empty() {
                state.applied_values.entry(session.to_owned()).or_default().extend(digests);
            }
        }
        self.reconcile_and_prune(&mut state);
        Ok(())
    }

    /// `session`'s log was rewritten for every value it held at `version`: each mark obligation it covered is cleared, and
    /// any mark no longer live goes from disk.
    pub(crate) fn applied(&self, session: &str, version: u64) {
        let mut state = self.lock();
        let seen = state.applied.entry(session.to_owned()).or_default();
        *seen = (*seen).max(version);
        self.reconcile_and_prune(&mut state);
    }

    fn reconcile_and_prune(&self, state: &mut State) {
        for record in state.marks.values_mut() {
            let mut satisfied = Vec::new();
            for (session, req) in &record.owed {
                if let Obligation::Version(version) = req
                    && state.applied.get(session).is_some_and(|seen| seen >= version)
                {
                    satisfied.push(session.clone());
                }
            }
            for session in satisfied {
                record.owed.remove(&session);
                if !record.digests.is_empty() {
                    state.applied_values.entry(session).or_default().extend(record.digests.iter().copied());
                }
            }
        }
        for record in state.marks.values_mut() {
            let settled = &record.disk.settled;
            let digests = &record.digests;
            record.owed.retain(|session, _| !is_confirmed_done(session, settled, &state.applied_values, digests));
        }
        let done: Vec<u64> = state.marks.iter().filter(|(_, record)| !is_live(record, &state.carries, &state.applied_values)).map(|(n, _)| *n).collect();
        for n in done {
            state.marks.remove(&n);
            let path = self.pending_path(n);
            if let Err(error) = self.remove_pending(state, &path) {
                tracing::warn!(path = %path.display(), "an applied sensitive mark's journal file stays: {error}");
            }
        }
        prune_applied_values(state);
    }

    /// All session ids currently referenced by carries, marks (origins, disk sessions, settled, or owed), or applied versions.
    pub(crate) fn referenced_sessions(&self) -> Vec<String> {
        let state = self.lock();
        let mut ids = BTreeSet::new();
        for (from, to) in &state.carries {
            if !from.is_empty() {
                ids.insert(from.clone());
            }
            if !to.is_empty() {
                ids.insert(to.clone());
            }
        }
        for record in state.marks.values() {
            if !record.disk.origin.is_empty() {
                ids.insert(record.disk.origin.clone());
            }
            for s in record.disk.sessions.keys().chain(record.disk.settled.iter()).chain(record.owed.keys()) {
                if !s.is_empty() {
                    ids.insert(s.clone());
                }
            }
        }
        ids.extend(state.applied.keys().cloned());
        ids.into_iter().collect()
    }

    /// Drops in-memory and journal state for a deleted `session` while preserving transitive carry edges
    /// (`A -> session -> B` collapses to `A -> B`), transferring outgoing carry obligations when a deleted recovery
    /// root is forgotten before its recipients were journaled (without creating synthetic debt for already-applied
    /// or settled recipients), clearing `origin` on surviving marks so `SensitiveStore::restore` never resurrects
    /// the deleted session on restart, and keeping any `search_owed` debt until confirmed discharged.
    #[cfg(test)]
    pub(crate) fn forget_session(&self, session: &str) -> Result<(), String> {
        if let Some(result) = self.test_hooks.forget.lock().unwrap_or_else(PoisonError::into_inner).as_mut().and_then(|hook| hook(session)) {
            return result;
        }

        let mut state = self.lock();
        let ordered = [session];
        let mut mutated = false;
        let mut failed = Vec::new();
        self.forget_sessions_inner(&mut state, &ordered, &mut mutated, &mut failed);
        prune_applied_values(&mut state);
        match failed.into_iter().next() {
            Some((_, error)) => Err(error),
            None => Ok(()),
        }
    }

    /// Drops in-memory and journal state for a batch of deleted `sessions` in one pass: collapses transitive carry
    /// edges once, scans `pending/` once, updates or retires affected marks, and durably publishes `carries.json` at
    /// most once.
    ///
    /// When a mark file fails to update or retire, only the sessions tied to that mark are reported in `failed` (and
    /// retained in `carries.json` for retry); sessions whose marks succeeded are still pruned in the same pass.
    ///
    /// Because all forgotten sessions are collapsed together, a surviving mark's `sessions` list may omit a surviving
    /// recipient that sequential per-session pruning would have copied in when a collapsed carry edge from a surviving
    /// root already reaches that recipient; `carries.json`, retire decisions, and what `SensitiveStore::restore`
    /// reaches remain identical.
    pub(crate) fn forget_sessions(&self, sessions: &[String]) -> ForgetBatchOutcome {
        if sessions.is_empty() {
            return ForgetBatchOutcome { any_changed: false, failed: Vec::new() };
        }

        let mut failed = Vec::new();
        let mut ordered: Vec<&str> = Vec::with_capacity(sessions.len());
        let mut seen: HashSet<&str> = HashSet::with_capacity(sessions.len());
        let mut any_changed = false;

        for session in sessions {
            let id = session.as_str();
            if !seen.insert(id) {
                continue;
            }
            #[cfg(test)]
            if let Some(result) = self.test_hooks.forget.lock().unwrap_or_else(PoisonError::into_inner).as_mut().and_then(|hook| hook(id)) {
                match result {
                    Ok(()) => any_changed = true,
                    Err(error) => failed.push((session.clone(), error)),
                }
                continue;
            }
            ordered.push(id);
        }

        if ordered.is_empty() {
            return ForgetBatchOutcome { any_changed, failed };
        }

        let mut state = self.lock();
        self.forget_sessions_inner(&mut state, &ordered, &mut any_changed, &mut failed);
        prune_applied_values(&mut state);
        ForgetBatchOutcome { any_changed, failed }
    }

    #[allow(clippy::disallowed_methods, reason = "runs inside a lane job")]
    fn forget_sessions_inner(&self, state: &mut State, ordered: &[&str], mutated: &mut bool, failed: &mut Vec<(String, String)>) {
        let forgotten: HashSet<&str> = ordered.iter().copied().collect();
        let planned_carries = collapse_carries(&state.carries, &forgotten);
        let pending_dir_sync_needed_at_entry = state.pending_dir_sync_needed;
        let mut synced_pending_dir = false;
        let mut blocked: HashMap<&str, String> = HashMap::new();

        // Update mark files before pruning `carries.json` so a crash in between cannot lose an
        // outgoing carry recipient whose obligation was anchored only on a forgotten session.
        let mark_keys: Vec<u64> = state.marks.keys().copied().collect();
        for n in mark_keys {
            let disposition = {
                let Some(record) = state.marks.get(&n) else { continue };
                let effective_carries = planned_carries.as_ref().unwrap_or(&state.carries);
                forget_mark_record(record, &forgotten, &state.carries, effective_carries, &state.applied, &state.applied_values)
            };
            match disposition {
                MarkDisposition::Unchanged => {}
                MarkDisposition::Retire => {
                    let path = self.pending_path(n);
                    match self.remove_pending(state, &path) {
                        Ok(()) => {
                            synced_pending_dir = true;
                            state.marks.remove(&n);
                            *mutated = true;
                        }
                        Err(error) => {
                            if let Some(record) = state.marks.get(&n) {
                                record_mark_failure(&mut blocked, ordered, &forgotten, record, &state.carries, &state.applied_values, error);
                            }
                        }
                    }
                }
                MarkDisposition::Update(next) => {
                    let path = self.pending_path(n);
                    match self.publish_pending(state, &path, &pending_mark_json(&next.disk)) {
                        Ok(()) => {
                            synced_pending_dir = true;
                            state.marks.insert(n, next);
                            *mutated = true;
                        }
                        Err(error) => {
                            if let Some(record) = state.marks.get(&n) {
                                record_mark_failure(&mut blocked, ordered, &forgotten, record, &state.carries, &state.applied_values, error);
                            }
                        }
                    }
                }
            }
        }

        // Also clean any durable `pending/<n>.json` left on disk outside `state.marks` (e.g. a prior best-effort remove failure).
        let pending_dir = self.dir.join("pending");
        #[cfg(test)]
        self.test_hooks.pending_dir_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let entries = match std::fs::read_dir(&pending_dir) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                let message = format!("{}: {error}", pending_dir.display());
                for &id in ordered {
                    blocked.entry(id).or_insert_with(|| message.clone());
                }
                None
            }
        };
        for entry in entries.into_iter().flatten() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    let message = format!("{}: {error}", pending_dir.display());
                    for &id in ordered {
                        blocked.entry(id).or_insert_with(|| message.clone());
                    }
                    break;
                }
            };
            let name = entry.file_name();
            let Some(n) = name.to_str().and_then(|name| name.strip_suffix(".json")).and_then(|n| n.parse::<u64>().ok()) else { continue };
            if state.marks.contains_key(&n) {
                continue;
            }
            let path = entry.path();
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    let message = format!("{}: {error}", path.display());
                    for &id in ordered {
                        blocked.entry(id).or_insert_with(|| message.clone());
                    }
                    continue;
                }
            };
            let disk: PendingMark = match serde_json::from_slice(&bytes) {
                Ok(disk) => disk,
                Err(error) => {
                    let message = format!("{}: {error}", path.display());
                    for &id in ordered {
                        blocked.entry(id).or_insert_with(|| message.clone());
                    }
                    continue;
                }
            };
            let record = MarkRecord::from_recovered(disk);
            let disposition = {
                let effective_carries = planned_carries.as_ref().unwrap_or(&state.carries);
                forget_mark_record(&record, &forgotten, &state.carries, effective_carries, &state.applied, &state.applied_values)
            };
            match disposition {
                MarkDisposition::Unchanged => {}
                MarkDisposition::Retire => match self.remove_pending(state, &path) {
                    Ok(()) => synced_pending_dir = true,
                    Err(error) => record_mark_failure(&mut blocked, ordered, &forgotten, &record, &state.carries, &state.applied_values, error),
                },
                MarkDisposition::Update(next) => match self.publish_pending(state, &path, &pending_mark_json(&next.disk)) {
                    Ok(()) => synced_pending_dir = true,
                    Err(error) => record_mark_failure(&mut blocked, ordered, &forgotten, &record, &state.carries, &state.applied_values, error),
                },
            }
        }

        let prunable: HashSet<&str> = ordered.iter().copied().filter(|id| !blocked.contains_key(id)).collect();
        if !prunable.is_empty() {
            let final_carries = if blocked.is_empty() { planned_carries } else { collapse_carries(&state.carries, &prunable) };
            let carries_changed = final_carries.is_some();

            // Complete any pending `pending/` directory sync left from an earlier call, and unconditionally sync
            // `pending/` before pruning `carries.json` (unless already synced in this call) so an unsynced rename
            // left by a prior process cannot revert after `carries.json` drops the carry edge.
            let mut carries_ready = true;
            if (pending_dir_sync_needed_at_entry && !synced_pending_dir) || (carries_changed && !synced_pending_dir) {
                if pending_dir.try_exists().unwrap_or(true) {
                    if let Err(error) = self.sync_dir(&pending_dir) {
                        for &id in ordered {
                            if prunable.contains(id) {
                                blocked.entry(id).or_insert_with(|| error.clone());
                            }
                        }
                        carries_ready = false;
                    } else {
                        state.pending_dir_sync_needed = false;
                    }
                } else {
                    state.pending_dir_sync_needed = false;
                }
            }

            if carries_ready && let Some(next_carries) = final_carries {
                let all: Vec<Value> = next_carries.iter().map(|(from, to)| json!([from, to])).collect();
                match self.publish_checked(&self.dir.join("carries.json"), &Value::Array(all)) {
                    Ok(()) => {
                        state.carries = next_carries;
                        *mutated = true;
                    }
                    Err(error) => {
                        for &id in ordered {
                            if prunable.contains(id) {
                                blocked.entry(id).or_insert_with(|| error.clone());
                            }
                        }
                        carries_ready = false;
                    }
                }
            }

            if carries_ready {
                for session in &prunable {
                    if state.applied.remove(*session).is_some() {
                        *mutated = true;
                    }
                    if state.applied_values.remove(*session).is_some() {
                        *mutated = true;
                    }
                }
            }
        }

        for &id in ordered {
            if let Some(error) = blocked.remove(id) {
                failed.push((id.to_owned(), error));
            }
        }
    }
}

fn record_mark_failure<'a>(
    blocked: &mut HashMap<&'a str, String>,
    ordered: &[&'a str],
    forgotten: &HashSet<&'a str>,
    record: &MarkRecord,
    carries: &BTreeSet<(String, String)>,
    applied_values: &HashMap<String, BTreeSet<ValueDigest>>,
    error: String,
) {
    let affected = mark_blocked_sessions(record, forgotten, carries, applied_values);
    if affected.is_empty() {
        for &id in ordered {
            blocked.entry(id).or_insert_with(|| error.clone());
        }
    } else {
        for id in affected {
            blocked.entry(id).or_insert_with(|| error.clone());
        }
    }
}

fn mark_blocked_sessions<'a>(
    record: &MarkRecord,
    forgotten: &HashSet<&'a str>,
    old_carries: &BTreeSet<(String, String)>,
    applied_values: &HashMap<String, BTreeSet<ValueDigest>>,
) -> Vec<&'a str> {
    let mut result = BTreeSet::new();
    if let Some(&s) = forgotten.get(record.disk.origin.as_str()) {
        result.insert(s);
    }
    for session in record.disk.sessions.keys().chain(record.disk.settled.iter()).chain(record.owed.keys()) {
        if let Some(&s) = forgotten.get(session.as_str()) {
            result.insert(s);
        }
    }
    if !result.is_empty() {
        return result.into_iter().collect();
    }

    // No forgotten session appears directly in the mark: it can only have been retired because forgotten carry targets
    // drained the unsettled outgoing set of its surviving roots.
    let mut visited = BTreeSet::new();
    let mut queue = std::collections::VecDeque::new();
    for root in recovery_roots(&record.disk) {
        if visited.insert(root.clone()) {
            queue.push_back(root);
        }
    }
    while let Some(node) = queue.pop_front() {
        for (from, to) in old_carries.range((node.clone(), String::new())..) {
            if from != &node {
                break;
            }
            if to.is_empty() || !visited.insert(to.clone()) {
                continue;
            }
            if let Some(&s) = forgotten.get(to.as_str()) {
                result.insert(s);
                queue.push_back(to.clone());
            } else if is_confirmed_done(to, &record.disk.settled, applied_values, &record.digests) {
                queue.push_back(to.clone());
            }
        }
    }
    result.into_iter().collect()
}

enum MarkDisposition {
    Unchanged,
    Retire,
    Update(MarkRecord),
}

fn collapse_carries(carries: &BTreeSet<(String, String)>, forgotten: &HashSet<&str>) -> Option<BTreeSet<(String, String)>> {
    let mut touched = false;
    let mut adj_from_forgotten: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut entry_edges: Vec<(&str, &str)> = Vec::new();
    for (from, to) in carries {
        let from_gone = forgotten.contains(from.as_str());
        let to_gone = forgotten.contains(to.as_str());
        if from_gone || to_gone {
            touched = true;
            if from_gone {
                adj_from_forgotten.entry(from.as_str()).or_default().push(to.as_str());
            } else {
                entry_edges.push((from.as_str(), to.as_str()));
            }
        }
    }
    if !touched {
        return None;
    }

    let mut next_carries: BTreeSet<(String, String)> =
        carries.iter().filter(|(from, to)| !forgotten.contains(from.as_str()) && !forgotten.contains(to.as_str())).cloned().collect();

    let mut targets_cache: HashMap<&str, Vec<&str>> = HashMap::new();
    for (from, entry) in entry_edges {
        let targets = targets_cache.entry(entry).or_insert_with(|| {
            let mut visited_forgotten: HashSet<&str> = HashSet::new();
            let mut seen_targets: HashSet<&str> = HashSet::new();
            let mut queue = std::collections::VecDeque::new();
            let mut targets = Vec::new();
            visited_forgotten.insert(entry);
            queue.push_back(entry);
            while let Some(node) = queue.pop_front() {
                if let Some(outs) = adj_from_forgotten.get(node) {
                    for &next in outs {
                        if forgotten.contains(next) {
                            if visited_forgotten.insert(next) {
                                queue.push_back(next);
                            }
                        } else if seen_targets.insert(next) {
                            targets.push(next);
                        }
                    }
                }
            }
            targets
        });
        for &to in targets.iter() {
            if from != to {
                next_carries.insert((from.to_owned(), to.to_owned()));
            }
        }
    }
    Some(next_carries)
}

fn pending_mark_json(disk: &PendingMark) -> Value {
    if disk.settled.is_empty() {
        json!({ "origin": disk.origin, "values": disk.values, "sessions": disk.sessions })
    } else {
        json!({ "origin": disk.origin, "values": disk.values, "sessions": disk.sessions, "settled": disk.settled })
    }
}

fn recovery_roots(disk: &PendingMark) -> BTreeSet<String> {
    let mut roots = BTreeSet::new();
    if !disk.origin.is_empty() {
        roots.insert(disk.origin.clone());
    }
    for session in disk.sessions.keys() {
        if !session.is_empty() {
            roots.insert(session.clone());
        }
    }
    roots
}

fn is_confirmed_done(session: &str, settled: &BTreeSet<String>, applied_values: &HashMap<String, BTreeSet<ValueDigest>>, digests: &[ValueDigest]) -> bool {
    settled.contains(session) || digests.is_empty() || applied_values.get(session).is_some_and(|seen| digests.iter().all(|digest| seen.contains(digest)))
}

fn unsettled_outgoing_from<'a>(
    seeds: impl IntoIterator<Item = &'a str>,
    carries: &BTreeSet<(String, String)>,
    settled: &BTreeSet<String>,
    applied_values: &HashMap<String, BTreeSet<ValueDigest>>,
    digests: &[ValueDigest],
) -> Vec<String> {
    let empty = HashSet::new();
    unsettled_outgoing_through_forgotten(seeds, carries, &empty, settled, applied_values, digests)
}

fn unsettled_outgoing_through_forgotten<'a>(
    seeds: impl IntoIterator<Item = &'a str>,
    carries: &BTreeSet<(String, String)>,
    forgotten: &HashSet<&str>,
    settled: &BTreeSet<String>,
    applied_values: &HashMap<String, BTreeSet<ValueDigest>>,
    digests: &[ValueDigest],
) -> Vec<String> {
    let mut visited = BTreeSet::new();
    let mut queue = std::collections::VecDeque::new();
    let mut result = Vec::new();
    for seed in seeds {
        if !seed.is_empty() && visited.insert(seed.to_owned()) {
            queue.push_back(seed.to_owned());
        }
    }
    while let Some(node) = queue.pop_front() {
        for (from, to) in carries.range((node.clone(), String::new())..) {
            if from != &node {
                break;
            }
            if to.is_empty() || !visited.insert(to.clone()) {
                continue;
            }
            if forgotten.contains(to.as_str()) || is_confirmed_done(to, settled, applied_values, digests) {
                queue.push_back(to.clone());
            } else {
                result.push(to.clone());
            }
        }
    }
    result
}

fn is_live(record: &MarkRecord, carries: &BTreeSet<(String, String)>, applied_values: &HashMap<String, BTreeSet<ValueDigest>>) -> bool {
    if !record.owed.is_empty() {
        return true;
    }
    let roots = recovery_roots(&record.disk);
    !unsettled_outgoing_from(roots.iter().map(String::as_str), carries, &record.disk.settled, applied_values, &record.digests).is_empty()
}

fn forget_mark_record(
    record: &MarkRecord,
    forgotten: &HashSet<&str>,
    old_carries: &BTreeSet<(String, String)>,
    next_carries: &BTreeSet<(String, String)>,
    applied: &HashMap<String, u64>,
    applied_values: &HashMap<String, BTreeSet<ValueDigest>>,
) -> MarkDisposition {
    let mut forgotten_roots = BTreeSet::new();
    if !record.disk.origin.is_empty() && forgotten.contains(record.disk.origin.as_str()) {
        forgotten_roots.insert(record.disk.origin.as_str());
    }
    for session in record.disk.sessions.keys() {
        if !session.is_empty() && forgotten.contains(session.as_str()) {
            forgotten_roots.insert(session.as_str());
        }
    }

    let mut next = record.clone();
    let prev_sessions_len = next.disk.sessions.len();
    next.disk.sessions.retain(|s, _| !forgotten.contains(s.as_str()));
    let mut changed = next.disk.sessions.len() != prev_sessions_len;

    let prev_settled_len = next.disk.settled.len();
    next.disk.settled.retain(|s| !forgotten.contains(s.as_str()));
    changed |= next.disk.settled.len() != prev_settled_len;

    let prev_owed_len = next.owed.len();
    next.owed.retain(|s, _| !forgotten.contains(s.as_str()));
    changed |= next.owed.len() != prev_owed_len;

    if !next.disk.origin.is_empty() && forgotten.contains(next.disk.origin.as_str()) {
        next.disk.origin.clear();
        changed = true;
    }

    if !forgotten_roots.is_empty() {
        let remaining_roots = recovery_roots(&next.disk);
        let mut covered = remaining_roots.clone();
        covered.extend(unsettled_outgoing_from(remaining_roots.iter().map(String::as_str), next_carries, &next.disk.settled, applied_values, &next.digests));
        for to in
            unsettled_outgoing_through_forgotten(forgotten_roots.iter().copied(), old_carries, forgotten, &record.disk.settled, applied_values, &record.digests)
        {
            if !covered.contains(&to) {
                let version = applied.get(&to).copied().unwrap_or(0).saturating_add(1);
                next.disk.sessions.entry(to.clone()).or_insert(version);
                next.owed.entry(to).or_insert(Obligation::Transferred);
                changed = true;
            }
        }
    }
    if !is_live(&next, next_carries, applied_values) {
        return MarkDisposition::Retire;
    }
    if changed { MarkDisposition::Update(next) } else { MarkDisposition::Unchanged }
}

fn prune_applied_values(state: &mut State) {
    if state.applied_values.is_empty() {
        return;
    }
    let mut live: BTreeSet<ValueDigest> = BTreeSet::new();
    for record in state.marks.values() {
        live.extend(record.digests.iter().copied());
    }
    if live.is_empty() {
        state.applied_values.clear();
        return;
    }
    state.applied_values.retain(|_, digests| {
        digests.retain(|digest| live.contains(digest));
        !digests.is_empty()
    });
}

impl mixdog_services::memory::sensitive::MarkJournal for MarksOnDisk {
    fn carried(&self, from: &str, to: &str) {
        let mut state = self.lock();
        if state.carries.insert((from.to_owned(), to.to_owned())) {
            let all: Vec<Value> = state.carries.iter().map(|(from, to)| json!([from, to])).collect();
            self.publish(&self.dir.join("carries.json"), &Value::Array(all));
        }
    }

    fn marked(&self, origin: &str, values: &[String], sessions: &[(String, u64)]) {
        let mut state = self.lock();
        let digests: Vec<ValueDigest> = values.iter().map(|v| value_digest(v)).collect();
        // A session rewritten for this version already (its barrier ran before this call) owes nothing.
        let mut disk_sessions = BTreeMap::new();
        let mut owed = BTreeMap::new();
        for (session, version) in sessions {
            if state.applied.get(session).is_none_or(|seen| seen < version) {
                disk_sessions.insert(session.clone(), *version);
                owed.insert(session.clone(), Obligation::Version(*version));
            } else if !digests.is_empty() {
                state.applied_values.entry(session.clone()).or_default().extend(digests.iter().copied());
            }
        }
        if !disk_sessions.is_empty() {
            let n = state.next;
            state.next += 1;
            let disk = PendingMark { origin: origin.to_owned(), values: values.to_vec(), sessions: disk_sessions, settled: BTreeSet::new() };
            let path = self.pending_path(n);
            if let Err(error) = self.publish_pending(&mut state, &path, &pending_mark_json(&disk)) {
                tracing::error!(path = %path.display(), "a sensitive mark could not be journaled; a restart before its rewrites ends would keep its copies: {error}");
            }
            state.marks.insert(n, MarkRecord { disk, digests, recovered: false, owed });
        }
        self.reconcile_and_prune(&mut state);
    }
}

#[cfg(test)]
mod tests {
    use mixdog_services::memory::sensitive::MarkJournal;

    use super::*;

    #[test]
    fn forget_session_clears_applied_collapses_carries_and_updates_pending() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        journal.applied("s-mid", 3);
        journal.carried("s-a", "s-mid");
        journal.carried("s-mid", "s-b");
        journal.carried("s-mid", "s-mid");
        journal.marked("s-a", &["secret-1".into()], &[("s-mid".into(), 4)]);
        journal.marked("s-a", &["secret-2".into()], &[("s-mid".into(), 5), ("s-b".into(), 1)]);
        journal.marked("s-solo", &["secret-solo".into()], &[("s-solo".into(), 1)]);
        journal.owe_search("s-mid").unwrap();

        journal.forget_session("s-mid").unwrap();
        journal.forget_session("s-solo").unwrap();

        // In-memory applied map dropped s-mid, while search_owed remains until discharged.
        assert!(!journal.lock().applied.contains_key("s-mid"));
        assert_eq!(journal.search_owed(), vec!["s-mid".to_owned()]);

        // Reload from disk to verify carries collapse, live-origin mark survives without s-mid,
        // shared mark keeps s-b, and solo dead mark is removed.
        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(reloaded.carries, vec![("s-a".to_owned(), "s-b".to_owned())]);
        assert_eq!(reloaded.pending.len(), 2);
        let marks: Vec<&PendingMark> = reloaded.pending.values().collect();
        let live_origin = marks.iter().find(|m| m.values == vec!["secret-1".to_owned()]).unwrap();
        assert_eq!(live_origin.origin, "s-a");
        assert!(live_origin.sessions.is_empty());
        let shared = marks.iter().find(|m| m.values == vec!["secret-2".to_owned()]).unwrap();
        assert_eq!(shared.origin, "s-a");
        assert_eq!(shared.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-b".to_owned()]);
    }

    #[test]
    fn forget_session_clears_deleted_origin_so_restore_does_not_resurrect_it() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.marked("s-origin", &["top-secret".into()], &[("s-origin".into(), 1), ("s-heir".into(), 1)]);
        // Even if s-origin was already rewritten before deletion, forgetting s-origin must clear `origin`.
        journal.applied("s-origin", 1);
        journal.forget_session("s-origin").unwrap();

        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(reloaded.pending.len(), 1);
        let mark = reloaded.pending.values().next().unwrap();
        assert!(mark.origin.is_empty(), "deleted origin must be cleared on disk");
        assert_eq!(mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-heir".to_owned()]);

        let store = mixdog_services::memory::sensitive::SensitiveStore::default();
        let restored = store.restore(mark.origin.clone(), mark.sessions.keys().cloned().collect(), mark.values.clone());
        assert_eq!(restored, std::collections::BTreeSet::from(["s-heir".to_owned()]), "SensitiveStore::restore must not resurrect deleted origin");

        // Also verify recovered marks loaded from disk clear origin when forgotten.
        let dir2 = tempfile::tempdir().unwrap();
        {
            let first = MarksOnDisk::new(dir2.path());
            first.marked("s-del", &["secret-rec".into()], &[("s-del".into(), 1), ("s-keep".into(), 1)]);
        }
        let second = MarksOnDisk::new(dir2.path());
        let _ = second.load().unwrap();
        second.forget_session("s-del").unwrap();
        let after = MarksOnDisk::new(dir2.path()).load().unwrap();
        let rec = after.pending.values().next().unwrap();
        assert!(rec.origin.is_empty());
        assert_eq!(rec.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-keep".to_owned()]);
    }

    #[test]
    fn forget_session_preserves_mark_for_unjournaled_carry_recipient_of_deleted_origin() {
        // Case 1: in-memory pending mark where deleted origin is the only listed session and outgoing carry
        // is the only durable evidence that `s-recipient` needs the mark.
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.carried("s-origin", "s-recipient");
        journal.marked("s-origin", &["secret-carry".into()], &[("s-origin".into(), 1)]);

        journal.forget_session("s-origin").unwrap();

        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty(), "deleted origin carry edge must be pruned");
        assert_eq!(reloaded.pending.len(), 1, "mark file must not be deleted when surviving carry recipient needs it");
        let mark = reloaded.pending.values().next().unwrap();
        assert!(mark.origin.is_empty(), "deleted origin must be cleared");
        assert_eq!(mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-recipient".to_owned()]);

        let store = mixdog_services::memory::sensitive::SensitiveStore::default();
        store.restore_carries(reloaded.carries);
        let restored = store.restore(mark.origin.clone(), mark.sessions.keys().cloned().collect(), mark.values.clone());
        assert_eq!(restored, BTreeSet::from(["s-recipient".to_owned()]));

        // Case 2: recovered from disk across restart + multi-hop deletion (`s-origin -> s-mid -> s-leaf`).
        let dir2 = tempfile::tempdir().unwrap();
        {
            let first = MarksOnDisk::new(dir2.path());
            first.carried("s-origin", "s-mid");
            first.carried("s-mid", "s-leaf");
            first.marked("s-origin", &["secret-chain".into()], &[("s-origin".into(), 1)]);
        }
        let second = MarksOnDisk::new(dir2.path());
        let _ = second.load().unwrap();
        second.forget_session("s-origin").unwrap();
        let mid_reloaded = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(mid_reloaded.carries, vec![("s-mid".to_owned(), "s-leaf".to_owned())]);
        let mid_mark = mid_reloaded.pending.values().next().unwrap();
        assert!(mid_mark.origin.is_empty());
        assert_eq!(mid_mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-mid".to_owned()]);

        second.forget_session("s-mid").unwrap();
        let leaf_reloaded = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert!(leaf_reloaded.carries.is_empty());
        let leaf_mark = leaf_reloaded.pending.values().next().unwrap();
        assert!(leaf_mark.origin.is_empty());
        assert_eq!(leaf_mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-leaf".to_owned()]);
    }

    #[test]
    fn forget_session_rewrites_pending_file_after_applied_cleared_non_origin() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.marked("s-origin", &["secret-shared".into()], &[("s-origin".into(), 1), ("s-non-origin".into(), 1)]);

        // `applied()` drops `s-non-origin` from memory without rewriting the still-shared disk file.
        journal.applied("s-non-origin", 1);
        let before = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(
            before.pending.values().next().unwrap().sessions.contains_key("s-non-origin"),
            "precondition: disk file still names non-origin after applied()"
        );

        journal.forget_session("s-non-origin").unwrap();

        let after = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(after.pending.len(), 1);
        let mark = after.pending.values().next().unwrap();
        assert_eq!(mark.origin, "s-origin");
        assert_eq!(mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-origin".to_owned()]);
        assert!(!mark.sessions.contains_key("s-non-origin"), "disk file must no longer name deleted non-origin");
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test checks unlinked file existence directly")]
    fn remove_checked_retries_parent_dir_sync_after_not_found() {
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        use std::sync::atomic::Ordering;

        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.marked("s-del", &["secret".into()], &[("s-del".into(), 1)]);
        let pending_file = dir.path().join("sensitive/pending/0.json");
        assert!(pending_file.exists());

        let sync_calls = Arc::new(AtomicUsize::new(0));
        let calls = sync_calls.clone();
        journal.set_sync_dir_hook(Some(Box::new(move |parent| {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt <= 2 {
                Err(format!("{}: simulated sync failure #{attempt}", parent.display()))
            } else {
                mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))
            }
        })));

        // Attempt 1: unlink succeeds, parent-dir sync fails.
        let err1 = journal.forget_session("s-del").unwrap_err();
        assert!(err1.contains("simulated sync failure #1"), "{err1}");
        assert!(!pending_file.exists(), "unlink already removed the file on attempt 1");
        assert_eq!(sync_calls.load(Ordering::SeqCst), 1);

        // Attempt 2: unlink returns NotFound, parent-dir sync MUST still run (and surface its failure).
        let err2 = journal.forget_session("s-del").unwrap_err();
        assert!(err2.contains("simulated sync failure #2"), "{err2}");
        assert_eq!(sync_calls.load(Ordering::SeqCst), 2);

        // Attempt 3: unlink returns NotFound, parent-dir sync runs and succeeds.
        journal.forget_session("s-del").unwrap();
        assert_eq!(sync_calls.load(Ordering::SeqCst), 3);
        assert!(journal.lock().marks.is_empty());
    }

    #[test]
    fn forget_session_preserves_mark_with_live_origin_when_last_listed_session_deleted() {
        // Pending case: `{origin: A, sessions: {B}}` + carry edge `A -> C`; purging `B` must keep the mark for `A`/`C`.
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.carried("s-a", "s-c");
        journal.marked("s-a", &["secret-live-origin".into()], &[("s-b".into(), 1)]);

        journal.forget_session("s-b").unwrap();

        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(reloaded.carries, vec![("s-a".to_owned(), "s-c".to_owned())]);
        assert_eq!(reloaded.pending.len(), 1, "mark with live origin must survive when last listed session is deleted");
        let mark = reloaded.pending.values().next().unwrap();
        assert_eq!(mark.origin, "s-a");
        assert!(mark.sessions.is_empty());

        let store = mixdog_services::memory::sensitive::SensitiveStore::default();
        store.restore_carries(reloaded.carries);
        let restored = store.restore(mark.origin.clone(), mark.sessions.keys().cloned().collect(), mark.values.clone());
        assert_eq!(restored, BTreeSet::from(["s-a".to_owned(), "s-c".to_owned()]));

        // Recovered case across restart.
        let dir2 = tempfile::tempdir().unwrap();
        {
            let first = MarksOnDisk::new(dir2.path());
            first.carried("s-a", "s-c");
            first.marked("s-a", &["secret-rec-origin".into()], &[("s-b".into(), 1)]);
        }
        let second = MarksOnDisk::new(dir2.path());
        let _ = second.load().unwrap();
        second.forget_session("s-b").unwrap();

        let after = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(after.pending.len(), 1, "recovered mark with live origin must survive");
        let rec = after.pending.values().next().unwrap();
        assert_eq!(rec.origin, "s-a");
        assert!(rec.sessions.is_empty());
        let store2 = mixdog_services::memory::sensitive::SensitiveStore::default();
        store2.restore_carries(after.carries);
        let restored2 = store2.restore(rec.origin.clone(), rec.sessions.keys().cloned().collect(), rec.values.clone());
        assert_eq!(restored2, BTreeSet::from(["s-a".to_owned(), "s-c".to_owned()]));
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test creates orphan pending file and inspects unlink directly")]
    fn forget_session_retries_parent_dir_sync_after_orphan_unlink_failure() {
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        use std::sync::atomic::Ordering;

        let dir = tempfile::tempdir().unwrap();
        let pending_dir = dir.path().join("sensitive/pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        let orphan_file = pending_dir.join("99.json");
        std::fs::write(&orphan_file, serde_json::to_vec(&json!({ "origin": "s-orphan", "values": ["secret"], "sessions": { "s-orphan": 1 } })).unwrap())
            .unwrap();

        // Fresh journal that does NOT have file 99 in `state.pending` or `state.recovered`.
        let journal = MarksOnDisk::new(dir.path());
        let sync_calls = Arc::new(AtomicUsize::new(0));
        let calls = sync_calls.clone();
        journal.set_sync_dir_hook(Some(Box::new(move |parent| {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt <= 2 {
                Err(format!("{}: simulated orphan sync failure #{attempt}", parent.display()))
            } else {
                mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))
            }
        })));

        // Attempt 1: directory scan finds orphan 99.json, unlinks it, parent-dir sync fails.
        let err1 = journal.forget_session("s-orphan").unwrap_err();
        assert!(err1.contains("simulated orphan sync failure #1"), "{err1}");
        assert!(!orphan_file.exists(), "orphan file was unlinked on attempt 1");
        assert_eq!(sync_calls.load(Ordering::SeqCst), 1);

        // Attempt 2: directory scan no longer sees 99.json, yet retry MUST still sync `pending/`.
        let err2 = journal.forget_session("s-orphan").unwrap_err();
        assert!(err2.contains("simulated orphan sync failure #2"), "{err2}");
        assert_eq!(sync_calls.load(Ordering::SeqCst), 2);

        // Attempt 3: `pending/` sync succeeds and clears dirty flag.
        journal.forget_session("s-orphan").unwrap();
        assert_eq!(sync_calls.load(Ordering::SeqCst), 3);
        assert!(!journal.lock().pending_dir_sync_needed);
    }

    #[test]
    fn forget_session_does_not_create_synthetic_debt_for_already_applied_carry_recipient() {
        // Case 1: recipient already applied -> forgetting origin removes mark file instead of adding synthetic `applied + 1` debt.
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.carried("s-origin", "s-recipient");
        journal.marked("s-origin", &["secret-applied".into()], &[("s-origin".into(), 1), ("s-recipient".into(), 1)]);
        journal.applied("s-recipient", 1);

        journal.forget_session("s-origin").unwrap();

        assert!(journal.lock().marks.is_empty(), "forgetting origin after recipient applied must not leave synthetic in-memory debt");
        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty());
        assert!(reloaded.pending.is_empty(), "plaintext mark file must be deleted when only remaining carry recipient already applied");

        // Case 2: recipient already applied, another session still owes -> forgetting origin keeps disk.sessions
        // un-narrowed for surviving sessions while holding zero owed debt on the already-applied recipient,
        // and applying the remaining real session cleanly deletes the file.
        let dir2 = tempfile::tempdir().unwrap();
        let journal2 = MarksOnDisk::new(dir2.path());
        journal2.carried("s-origin", "s-recipient");
        journal2.marked("s-origin", &["secret-shared".into()], &[("s-origin".into(), 1), ("s-recipient".into(), 1), ("s-other".into(), 1)]);
        journal2.applied("s-recipient", 1);

        journal2.forget_session("s-origin").unwrap();

        let mid = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(mid.pending.len(), 1);
        let mark = mid.pending.values().next().unwrap();
        assert!(mark.origin.is_empty());
        assert_eq!(
            mark.sessions.keys().cloned().collect::<Vec<_>>(),
            vec!["s-other".to_owned(), "s-recipient".to_owned()],
            "disk.sessions stays un-narrowed for surviving sessions while deleted origin is removed"
        );
        assert_eq!(
            journal2.lock().marks.values().next().unwrap().owed.keys().cloned().collect::<Vec<_>>(),
            vec!["s-other".to_owned()],
            "already-applied recipient must have zero owed debt"
        );

        journal2.applied("s-other", 1);
        let after = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert!(after.pending.is_empty(), "applying remaining real session must remove the mark file cleanly");
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages an already-renamed pending file from a prior process")]
    fn forget_session_syncs_pending_dir_before_pruning_carries_across_restart() {
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        use std::sync::atomic::Ordering;

        let dir = tempfile::tempdir().unwrap();
        let sensitive_dir = dir.path().join("sensitive");
        let pending_dir = sensitive_dir.join("pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        // Simulate a prior process that renamed `pending/0.json` to transfer `s-b`, failed `sync_dir(pending/)`,
        // and restarted without OS reboot: `carries.json` still holds `s-a -> s-b`, and `pending/0.json` no longer mentions `s-a`.
        std::fs::write(pending_dir.join("0.json"), serde_json::to_vec(&json!({ "origin": "", "values": ["secret-xproc"], "sessions": { "s-b": 1 } })).unwrap())
            .unwrap();
        std::fs::write(sensitive_dir.join("carries.json"), serde_json::to_vec(&json!([["s-a", "s-b"]])).unwrap()).unwrap();

        // Fresh process instance starts with `pending_dir_sync_needed == false`.
        let journal = MarksOnDisk::new(dir.path());
        let _ = journal.load().unwrap();
        assert!(!journal.lock().pending_dir_sync_needed);

        let pending_attempts = Arc::new(AtomicUsize::new(0));
        let events: Arc<Mutex<Vec<String>>> = Arc::default();
        let attempts_hook = pending_attempts.clone();
        let events_hook = events.clone();
        journal.set_sync_dir_hook(Some(Box::new(move |parent| {
            let name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
            if name == "pending" {
                let attempt = attempts_hook.fetch_add(1, Ordering::SeqCst) + 1;
                events_hook.lock().unwrap_or_else(PoisonError::into_inner).push(format!("pending:{attempt}"));
                if attempt == 1 {
                    return Err(format!("{}: simulated cross-restart pending sync failure", parent.display()));
                }
            } else {
                events_hook.lock().unwrap_or_else(PoisonError::into_inner).push(name);
            }
            mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))
        })));

        // Attempt 1: even though `pending/0.json` did not change in this process, pruning `carries.json` MUST
        // sync `pending/` first; a failure must leave `carries.json` intact.
        let err = journal.forget_session("s-a").unwrap_err();
        assert!(err.contains("simulated cross-restart pending sync failure"), "{err}");
        assert_eq!(pending_attempts.load(Ordering::SeqCst), 1);
        let after_fail = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(after_fail.carries, vec![("s-a".to_owned(), "s-b".to_owned())], "carries.json must not be pruned if pending/ sync fails");

        // Attempt 2: `pending/` sync succeeds first, then `carries.json` is pruned.
        journal.forget_session("s-a").unwrap();
        assert_eq!(pending_attempts.load(Ordering::SeqCst), 2);
        let recorded = events.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let pending_ok = recorded.iter().position(|e| e == "pending:2").expect("pending:2 recorded");
        let carries_sync = recorded.iter().position(|e| e == "sensitive").expect("sensitive sync recorded");
        assert!(pending_ok < carries_sync, "pending/ sync must complete before carries.json is pruned: {recorded:?}");

        let after_ok = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(after_ok.carries.is_empty());
        assert_eq!(after_ok.pending.len(), 1);
        assert_eq!(after_ok.pending[&0].sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-b".to_owned()]);
    }

    #[test]
    fn forget_session_does_not_recreate_debt_after_separate_carry_entry_applied() {
        // Case 1: A marks V (#0) -> A carries V to B (separate entry #1) -> B applies V -> A is forgotten.
        // B already rewrote V, so forgetting A must leave zero synthetic debt and no stale pending file.
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.marked("s-a", &["secret-v".into()], &[("s-a".into(), 1)]);
        journal.carried("s-a", "s-b");
        journal.marked("s-a", &["secret-v".into()], &[("s-b".into(), 1)]);
        journal.applied("s-b", 1);

        journal.forget_session("s-a").unwrap();

        assert!(journal.lock().marks.is_empty(), "forgetting A after B applied V must not create synthetic debt");
        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty());
        assert!(reloaded.pending.is_empty(), "no stale pending file may remain after A is forgotten");

        // Case 2: partial value overlap — A's mark holds [V1, V2], B only applied V1.
        // Forgetting A must STILL transfer the mark to B because V2 was never rewritten in B.
        let dir2 = tempfile::tempdir().unwrap();
        let journal2 = MarksOnDisk::new(dir2.path());
        journal2.marked("s-a", &["secret-v1".into(), "secret-v2".into()], &[("s-a".into(), 1)]);
        journal2.carried("s-a", "s-b");
        journal2.marked("s-a", &["secret-v1".into()], &[("s-b".into(), 1)]);
        journal2.applied("s-b", 1);

        journal2.forget_session("s-a").unwrap();

        let reloaded2 = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(reloaded2.pending.len(), 1, "B still owes V2 so mark must transfer");
        let mark = reloaded2.pending.values().next().unwrap();
        assert!(mark.origin.is_empty());
        assert_eq!(mark.sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-b".to_owned()]);
    }

    #[test]
    fn forget_session_retires_empty_roster_mark_when_origin_has_no_unsettled_recipients() {
        // Case 1: apply A -> carry to B -> forget B (no other carry recipients).
        // The carry mark file must be unlinked immediately instead of leaving plaintext on disk.
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());
        journal.marked("s-a", &["secret-v".into()], &[("s-a".into(), 1)]);
        journal.applied("s-a", 1);
        journal.carried("s-a", "s-b");
        journal.marked("s-a", &["secret-v".into()], &[("s-b".into(), 1)]);

        journal.forget_session("s-b").unwrap();

        assert!(journal.lock().marks.is_empty(), "empty-roster mark with no unsettled carry recipients must be retired");
        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty());
        assert!(reloaded.pending.is_empty(), "plaintext mark file must be removed immediately when B is forgotten");

        // Case 2: apply A -> carry to B & C -> forget B keeps empty-roster mark while C is unsettled;
        // once C applies (or is forgotten), the empty-roster mark is retired immediately.
        let dir2 = tempfile::tempdir().unwrap();
        let journal2 = MarksOnDisk::new(dir2.path());
        journal2.marked("s-a", &["secret-v2".into()], &[("s-a".into(), 1)]);
        journal2.applied("s-a", 1);
        journal2.carried("s-a", "s-b");
        journal2.carried("s-a", "s-c");
        journal2.marked("s-a", &["secret-v2".into()], &[("s-b".into(), 1)]);

        journal2.forget_session("s-b").unwrap();
        let mid = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(mid.pending.len(), 1, "mark stays while unsettled recipient C still exists");

        // Now C is also forgotten -> empty-roster mark must retire immediately.
        journal2.forget_session("s-c").unwrap();
        assert!(journal2.lock().marks.is_empty());
        let after = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert!(after.pending.is_empty(), "empty-roster mark must retire once last carry recipient C is forgotten");
    }

    #[test]
    fn applied_values_prunes_digests_once_pending_marks_settle() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        // Long-lived session marks and settles multiple distinct secrets across pending marks.
        journal.marked("s-long", &["secret-1".into()], &[("s-long".into(), 1)]);
        journal.carried("s-long", "s-peer");
        journal.marked("s-long", &["secret-1".into()], &[("s-peer".into(), 1)]);

        // While s-peer still owes secret-1, s-long's applied digest is retained for that live pending value only.
        journal.applied("s-long", 1);
        {
            let state = journal.lock();
            let digests = state.applied_values.get("s-long").expect("digest retained while peer mark is live");
            assert_eq!(digests.len(), 1);
            assert!(digests.contains(&value_digest("secret-1")));
        }

        // Once s-peer settles secret-1, no live pending marks remain -> applied_values must be completely empty.
        journal.applied("s-peer", 1);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty(), "applied_values must retain no entries once all pending marks settle");

        // Subsequent mark/apply cycle on the carried long-lived session settles once both s-long and its carry target s-peer apply.
        journal.marked("s-long", &["secret-2".into(), "secret-3".into()], &[("s-long".into(), 2), ("s-peer".into(), 2)]);
        journal.applied("s-long", 2);
        assert_eq!(journal.lock().marks.len(), 1, "mark stays live while carry recipient s-peer still owes secret-2/secret-3");
        journal.applied("s-peer", 2);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty(), "applied_values must stay empty for long-lived session after settlement");

        // An uncarried session retires immediately on its own applied() and leaves applied_values empty.
        journal.marked("s-solo", &["secret-solo-1".into(), "secret-solo-2".into()], &[("s-solo".into(), 1)]);
        journal.applied("s-solo", 1);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty(), "applied_values must stay empty for uncarried session after settlement");

        // Already-applied mark call with empty owed roster must also not leak entries into applied_values.
        journal.marked("s-long", &["secret-4".into()], &[("s-long".into(), 2)]);
        journal.marked("s-solo", &["secret-4".into()], &[("s-solo".into(), 1)]);
        assert!(journal.lock().applied_values.is_empty(), "early-return marked() must not retain digests when no pending mark exists");
    }

    #[test]
    fn applied_origin_keeps_mark_until_unsettled_carry_recipient_applies() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        journal.carried("s-a", "s-b");
        journal.marked("s-a", &["secret-live-carry".into()], &[("s-a".into(), 1)]);
        journal.applied("s-a", 1);

        // Mark must remain durable while carry recipient s-b is still unsettled.
        assert_eq!(journal.lock().marks.len(), 1);
        let mid = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(mid.pending.len(), 1);
        let store = mixdog_services::memory::sensitive::SensitiveStore::default();
        store.restore_carries(mid.carries);
        let mark = mid.pending.values().next().unwrap();
        let restored = store.restore(mark.origin.clone(), mark.sessions.keys().cloned().collect(), mark.values.clone());
        assert!(restored.contains("s-b"), "crash recovery must still reach unsettled carry recipient s-b");

        // Once s-b receives and applies the value, both marks retire and applied_values clears.
        journal.marked("s-a", &["secret-live-carry".into()], &[("s-b".into(), 1)]);
        journal.applied("s-b", 1);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    fn forget_session_transfers_outgoing_carry_of_applied_originless_root() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        journal.marked("", &["secret-root".into()], &[("s-b".into(), 1), ("s-c".into(), 1)]);
        journal.carried("s-b", "s-d");
        // s-b finishes its own rewrite before being forgotten; disk.sessions still records s-b as a recovery root.
        journal.applied("s-b", 1);

        journal.forget_session("s-b").unwrap();

        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty(), "s-b -> s-d must be pruned from carries.json");
        assert_eq!(reloaded.pending.len(), 1);
        let mark = reloaded.pending.values().next().unwrap();
        assert!(mark.origin.is_empty());
        assert_eq!(mark.sessions.keys().cloned().collect::<BTreeSet<_>>(), BTreeSet::from(["s-c".to_owned(), "s-d".to_owned()]));

        let d_ver = mark.sessions["s-d"];
        let c_ver = mark.sessions["s-c"];
        journal.applied("s-c", c_ver);
        assert_eq!(journal.lock().marks.len(), 1, "s-d is still owed");
        // An unrelated applied() bump on s-d must NOT discharge Obligation::Transferred.
        journal.applied("s-d", d_ver);
        assert_eq!(journal.lock().marks.len(), 1, "unrelated applied(s-d) must not retire transferred obligation");
        // Confirming secret-root via marked() + applied() retires both marks.
        journal.marked("", &["secret-root".into()], &[("s-d".into(), d_ver + 1)]);
        journal.applied("s-d", d_ver + 1);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    fn independently_settled_recipient_acquires_no_debt_across_carry_and_forget_race() {
        use mixdog_services::memory::sensitive::SensitiveStore;
        use std::sync::Arc;

        let fill = |secret: &str| json!({ "name": "browser", "arguments": { "action": "fill", "sensitive": true, "text": secret } });

        // Case 1: end-to-end SensitiveStore + MarksOnDisk.
        // B independently marks & settles V (digests pruned), later A marks V and carries to B, then A is forgotten.
        let dir = tempfile::tempdir().unwrap();
        let journal = Arc::new(MarksOnDisk::new(dir.path()));
        let store = SensitiveStore::default();
        assert!(store.journal_with(journal.clone()));

        assert!(store.remember("s-b", &[fill("secret-indep")]));
        journal.applied("s-b", store.version("s-b"));
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty());

        assert!(store.remember("s-a", &[fill("secret-indep")]));
        store.carry("s-a", "s-b");
        journal.forget_session("s-a").unwrap();

        assert!(journal.lock().marks.is_empty(), "already-settled B must acquire no stuck debt");
        assert!(journal.lock().applied_values.is_empty());
        let reloaded = MarksOnDisk::new(dir.path()).load().unwrap();
        assert!(reloaded.carries.is_empty());
        assert!(reloaded.pending.is_empty());

        // Case 2: race where forget_session(A) runs between carried(A, B) and spread's marked(A, [V], [(B, covered_ver)]).
        let dir2 = tempfile::tempdir().unwrap();
        let journal2 = MarksOnDisk::new(dir2.path());
        journal2.marked("s-b", &["secret-race".into()], &[("s-b".into(), 1)]);
        journal2.applied("s-b", 1);
        assert!(journal2.lock().applied_values.is_empty());

        journal2.marked("s-a", &["secret-race".into()], &[("s-a".into(), 1)]);
        journal2.carried("s-a", "s-b");
        // Forget races before spread reports B's covered version, conservatively transferring B.
        journal2.forget_session("s-a").unwrap();
        assert_eq!(journal2.lock().marks.len(), 1);

        // Spread finishes and reports B already holds V at version 1 <= applied[B].
        journal2.marked("s-a", &["secret-race".into()], &[("s-b".into(), 1)]);
        assert!(journal2.lock().marks.is_empty(), "spread's version report must clear conservatively transferred debt");
        assert!(journal2.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir2.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages recovered empty-roster mark file on disk")]
    fn recovered_empty_roster_mark_retires_immediately_when_carry_recipient_applies() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive_dir = dir.path().join("sensitive");
        let pending_dir = sensitive_dir.join("pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(sensitive_dir.join("carries.json"), serde_json::to_vec(&json!([["s-a", "s-c"]])).unwrap()).unwrap();
        std::fs::write(
            pending_dir.join("0.json"),
            serde_json::to_vec(&json!({ "origin": "s-a", "values": ["secret-rec-empty"], "sessions": {}, "settled": ["s-a"] })).unwrap(),
        )
        .unwrap();

        let journal = MarksOnDisk::new(dir.path());
        let _ = journal.load().unwrap();
        assert_eq!(journal.lock().marks.len(), 1);

        // Live mark for s-c arrives and settles; recovered empty-roster mark 0 must retire without waiting for forget_recovered.
        journal.marked("s-a", &["secret-rec-empty".into()], &[("s-c".into(), 1)]);
        journal.applied("s-c", 1);

        assert!(journal.lock().marks.is_empty(), "recovered empty-roster mark must retire on applied(C)");
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    fn applied_before_marked_retires_existing_empty_roster_mark() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        journal.carried("s-a", "s-b");
        journal.carried("s-a", "s-c");
        journal.marked("s-a", &["secret-order".into()], &[("s-b".into(), 1)]);
        // Deleting s-b leaves mark 0 with an empty roster kept alive solely for s-a -> s-c.
        journal.forget_session("s-b").unwrap();
        assert_eq!(journal.lock().marks.len(), 1);
        assert_eq!(MarksOnDisk::new(dir.path()).load().unwrap().pending.len(), 1);

        // s-c rewrites BEFORE marked() runs for s-c.
        journal.applied("s-c", 1);
        journal.marked("s-a", &["secret-order".into()], &[("s-c".into(), 1)]);

        assert!(journal.lock().marks.is_empty(), "marked() must retire existing empty-roster mark when s-c already applied");
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    fn forget_session_prunes_applied_values_even_on_partial_carries_failure() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        journal.carried("s-a", "s-b");
        journal.marked("s-a", &["secret-partial".into()], &[("s-a".into(), 1)]);
        journal.applied("s-a", 1);
        assert!(journal.lock().applied_values.contains_key("s-a"), "precondition: digest retained while mark 0 stays live for s-b");

        // Allow pending/ unlink sync to succeed, then fail carries.json parent dir sync ("sensitive").
        journal.set_sync_dir_hook(Some(Box::new(|parent| {
            if parent.file_name().and_then(|n| n.to_str()) == Some("sensitive") {
                return Err(format!("{}: simulated carries sync failure", parent.display()));
            }
            mixdog_store::fsio::sync_dir(parent).map_err(|error| format!("{}: {error}", parent.display()))
        })));

        let err = journal.forget_session("s-b").unwrap_err();
        assert!(err.contains("simulated carries sync failure"), "{err}");
        assert!(journal.lock().marks.is_empty(), "mark 0 was already retired before carries.json failed");
        assert!(journal.lock().applied_values.is_empty(), "applied_values must be pruned even when forget_session returns Err");
    }

    #[test]
    fn transferred_obligation_not_cleared_by_unrelated_applied_bump() {
        let dir = tempfile::tempdir().unwrap();
        let journal = MarksOnDisk::new(dir.path());

        // A marks V, carries to B, then A is forgotten before spread runs on B.
        journal.marked("s-a", &["secret-v".into()], &[("s-a".into(), 1)]);
        journal.carried("s-a", "s-b");
        journal.forget_session("s-a").unwrap();

        {
            let state = journal.lock();
            assert_eq!(state.marks.len(), 1);
            assert_eq!(state.marks[&0].owed.get("s-b"), Some(&Obligation::Transferred));
        }

        // Unrelated mark W on B + applied(B, 1) must NOT credit B with V or unlink mark 0.
        journal.marked("s-b", &["secret-unrelated".into()], &[("s-b".into(), 1)]);
        journal.applied("s-b", 1);

        {
            let state = journal.lock();
            assert_eq!(state.marks.len(), 1, "transferred mark for secret-v must survive unrelated applied(B, 1)");
            assert_eq!(state.marks[&0].owed.get("s-b"), Some(&Obligation::Transferred));
            assert!(
                !state.applied_values.get("s-b").is_some_and(|seen| seen.contains(&value_digest("secret-v"))),
                "unrelated applied(B, 1) must not credit B with secret-v's digest"
            );
        }
        assert_eq!(MarksOnDisk::new(dir.path()).load().unwrap().pending.len(), 1);

        // Spread now delivers V to B at version 2 and B rewrites for version 2 -> retires cleanly.
        journal.marked("s-a", &["secret-v".into()], &[("s-b".into(), 2)]);
        assert_eq!(journal.lock().marks.len(), 2);
        journal.applied("s-b", 2);

        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages recovered mark file on disk")]
    fn post_boot_carry_transfer_on_recovered_mark_survives_forget_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive_dir = dir.path().join("sensitive");
        let pending_dir = sensitive_dir.join("pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(sensitive_dir.join("carries.json"), serde_json::to_vec(&json!([["s-a", "s-b"]])).unwrap()).unwrap();
        std::fs::write(
            pending_dir.join("0.json"),
            serde_json::to_vec(&json!({ "origin": "s-a", "values": ["secret-post-boot"], "sessions": { "s-a": 1 } })).unwrap(),
        )
        .unwrap();

        let journal = MarksOnDisk::new(dir.path());
        let _ = journal.load().unwrap();
        assert_eq!(journal.lock().marks[&0].owed.get("s-a"), Some(&Obligation::Boot));

        // Post-boot deletion of s-a transfers obligation onto s-b as Obligation::Transferred.
        journal.forget_session("s-a").unwrap();
        assert_eq!(journal.lock().marks[&0].owed.get("s-b"), Some(&Obligation::Transferred));

        // Boot MarkRewrites::run completes and calls forget_recovered([0]) -> MUST NOT drop Transferred!
        journal.forget_recovered(vec![0]);
        {
            let state = journal.lock();
            assert_eq!(state.marks.len(), 1, "post-boot transferred obligation must survive forget_recovered");
            assert!(!state.marks[&0].recovered);
            assert_eq!(state.marks[&0].owed.get("s-b"), Some(&Obligation::Transferred));
        }
        assert_eq!(MarksOnDisk::new(dir.path()).load().unwrap().pending.len(), 1);

        // Unrelated applied(B, 1) also must not clear it.
        journal.applied("s-b", 1);
        assert_eq!(journal.lock().marks.len(), 1);

        // Once B confirms the actual secret value, mark 0 retires cleanly.
        journal.marked("", &["secret-post-boot".into()], &[("s-b".into(), 2)]);
        journal.applied("s-b", 2);
        assert!(journal.lock().marks.is_empty());
        assert!(journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(dir.path()).load().unwrap().pending.is_empty());
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages journal files directly on disk")]
    fn forget_sessions_matches_sequential_state_and_publishes_carries_once() {
        let stage = |root: &Path| {
            let sensitive_dir = root.join("sensitive");
            let pending_dir = sensitive_dir.join("pending");
            std::fs::create_dir_all(&pending_dir).unwrap();
            std::fs::write(
                sensitive_dir.join("carries.json"),
                serde_json::to_vec(&json!([
                    ["s-a", "d-0"],
                    ["d-0", "d-1"],
                    ["d-1", "d-2"],
                    ["d-2", "s-b"],
                    ["d-1", "d-0"],
                    ["d-2", "s-a"],
                    ["s-c", "d-3"],
                    ["d-3", "s-mid"],
                    ["s-mid", "d-4"],
                    ["d-4", "s-d"],
                    ["d-origin", "d-hop"],
                    ["d-hop", "s-heir"],
                    ["d-root", "s-settled"],
                    ["s-settled", "d-tail"],
                    ["d-tail", "s-target"],
                    ["s-live-origin", "s-live-heir"],
                ]))
                .unwrap(),
            )
            .unwrap();
            std::fs::write(
                pending_dir.join("0.json"),
                serde_json::to_vec(&json!({ "origin": "d-origin", "values": ["secret-chain"], "sessions": { "d-origin": 1 } })).unwrap(),
            )
            .unwrap();
            std::fs::write(
                pending_dir.join("1.json"),
                serde_json::to_vec(&json!({
                    "origin": "d-root",
                    "values": ["secret-settled-hop"],
                    "sessions": { "d-root": 1 },
                    "settled": ["s-settled"]
                }))
                .unwrap(),
            )
            .unwrap();
            std::fs::write(
                pending_dir.join("2.json"),
                serde_json::to_vec(&json!({ "origin": "s-live-origin", "values": ["secret-live-origin"], "sessions": { "d-listed": 1 } })).unwrap(),
            )
            .unwrap();
            std::fs::write(
                pending_dir.join("3.json"),
                serde_json::to_vec(&json!({ "origin": "d-solo", "values": ["secret-solo"], "sessions": { "d-solo": 1 } })).unwrap(),
            )
            .unwrap();

            let journal = MarksOnDisk::new(root);
            let _ = journal.load().unwrap();
            journal.seed_applied(&[("d-0".into(), 2), ("s-a".into(), 5)]);
            // Orphan file outside `state.marks` must still be cleaned during the single `pending/` pass.
            std::fs::write(
                pending_dir.join("99.json"),
                serde_json::to_vec(&json!({ "origin": "d-orphan", "values": ["secret-orphan"], "sessions": { "d-orphan": 1 } })).unwrap(),
            )
            .unwrap();
            journal
        };

        let forgotten: Vec<String> = ["d-0", "d-1", "d-2", "d-3", "d-4", "d-hop", "d-listed", "d-origin", "d-orphan", "d-root", "d-solo", "d-tail"]
            .into_iter()
            .map(str::to_owned)
            .collect();

        let seq_dir = tempfile::tempdir().unwrap();
        let seq_journal = stage(seq_dir.path());
        for id in &forgotten {
            seq_journal.forget_session(id).unwrap();
        }

        let batch_dir = tempfile::tempdir().unwrap();
        let batch_journal = stage(batch_dir.path());
        batch_journal.take_published_paths();
        batch_journal.take_pending_dir_reads();

        let outcome = batch_journal.forget_sessions(&forgotten);
        assert!(outcome.failed.is_empty(), "batch forget failed: {:?}", outcome.failed);
        assert!(outcome.any_changed);

        let carries_publishes =
            batch_journal.take_published_paths().into_iter().filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("carries.json")).count();
        assert_eq!(carries_publishes, 1, "carries.json must be published once for the whole batch");
        assert_eq!(batch_journal.take_pending_dir_reads(), 1, "pending/ must be scanned once for the whole batch");
        assert!(!batch_journal.lock().applied.contains_key("d-0"));
        assert_eq!(batch_journal.lock().applied.get("s-a"), Some(&5));

        let seq_reloaded = MarksOnDisk::new(seq_dir.path()).load().unwrap();
        let batch_reloaded = MarksOnDisk::new(batch_dir.path()).load().unwrap();
        assert_eq!(batch_reloaded.carries, seq_reloaded.carries);
        assert_eq!(batch_reloaded.pending.keys().copied().collect::<Vec<_>>(), seq_reloaded.pending.keys().copied().collect::<Vec<_>>());
        for (n, expected) in &seq_reloaded.pending {
            let actual = &batch_reloaded.pending[n];
            assert_eq!(actual.origin, expected.origin, "mark {n} origin mismatch");
            assert_eq!(actual.values, expected.values, "mark {n} values mismatch");
            assert_eq!(actual.sessions, expected.sessions, "mark {n} sessions mismatch");
            assert_eq!(actual.settled, expected.settled, "mark {n} settled mismatch");
        }
        assert!(!batch_dir.path().join("sensitive/pending/99.json").exists(), "orphan pending file must be removed");
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages journal files directly on disk")]
    fn forget_sessions_prunes_clean_sessions_when_one_mark_file_fails() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive_dir = dir.path().join("sensitive");
        let pending_dir = sensitive_dir.join("pending");
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(
            sensitive_dir.join("carries.json"),
            serde_json::to_vec(&json!([
                ["d-bad-update", "s-heir-bad"],
                ["s-src-bad", "d-bad-retire"],
                ["d-good-update", "s-heir-good"],
                ["s-a", "d-good-retire"],
                ["s-c", "d-good-carry"],
                ["d-good-carry", "s-d"],
            ]))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            pending_dir.join("0.json"),
            serde_json::to_vec(&json!({ "origin": "d-bad-update", "values": ["secret-bad-u"], "sessions": { "d-bad-update": 1 } })).unwrap(),
        )
        .unwrap();
        std::fs::write(
            pending_dir.join("1.json"),
            serde_json::to_vec(&json!({ "origin": "d-bad-retire", "values": ["secret-bad-r"], "sessions": { "d-bad-retire": 1 } })).unwrap(),
        )
        .unwrap();
        std::fs::write(
            pending_dir.join("2.json"),
            serde_json::to_vec(&json!({ "origin": "d-good-update", "values": ["secret-good-u"], "sessions": { "d-good-update": 1 } })).unwrap(),
        )
        .unwrap();
        std::fs::write(
            pending_dir.join("3.json"),
            serde_json::to_vec(&json!({ "origin": "d-good-retire", "values": ["secret-good-r"], "sessions": { "d-good-retire": 1 } })).unwrap(),
        )
        .unwrap();

        let journal = MarksOnDisk::new(dir.path());
        let _ = journal.load().unwrap();
        journal.seed_applied(&[
            ("d-bad-update".into(), 1),
            ("d-bad-retire".into(), 1),
            ("d-good-update".into(), 1),
            ("d-good-retire".into(), 1),
            ("d-good-carry".into(), 1),
        ]);
        journal.set_pending_io_hook(Some(Box::new(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if matches!(name, "0.json" | "1.json") {
                return Err(format!("{}: simulated mark io failure", path.display()));
            }
            Ok(())
        })));
        journal.take_published_paths();
        journal.take_pending_dir_reads();

        let batch: Vec<String> = ["d-bad-update", "d-bad-retire", "d-good-update", "d-good-retire", "d-good-carry"].into_iter().map(str::to_owned).collect();
        let outcome = journal.forget_sessions(&batch);
        assert!(outcome.any_changed);
        let failed_ids: BTreeSet<String> = outcome.failed.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(
            failed_ids,
            BTreeSet::from(["d-bad-retire".to_owned(), "d-bad-update".to_owned()]),
            "only sessions touching the failing mark files must fail"
        );
        let carries_publishes =
            journal.take_published_paths().into_iter().filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("carries.json")).count();
        assert_eq!(carries_publishes, 1, "clean sessions must still be published to carries.json in one pass");
        assert_eq!(journal.take_pending_dir_reads(), 1);
        {
            let state = journal.lock();
            assert!(state.applied.contains_key("d-bad-update"));
            assert!(state.applied.contains_key("d-bad-retire"));
            assert!(!state.applied.contains_key("d-good-update"));
            assert!(!state.applied.contains_key("d-good-retire"));
            assert!(!state.applied.contains_key("d-good-carry"));
        }

        let mid = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(
            mid.carries,
            vec![
                ("d-bad-update".to_owned(), "s-heir-bad".to_owned()),
                ("s-c".to_owned(), "s-d".to_owned()),
                ("s-src-bad".to_owned(), "d-bad-retire".to_owned()),
            ],
            "good sessions must collapse/prune while failing sessions stay intact in carries.json"
        );
        assert_eq!(mid.pending.keys().copied().collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(mid.pending[&0].origin, "d-bad-update");
        assert_eq!(mid.pending[&1].origin, "d-bad-retire");
        assert!(mid.pending[&2].origin.is_empty());
        assert_eq!(mid.pending[&2].sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-heir-good".to_owned()]);

        // Clearing the mark failure lets a single retry finish pruning the previously blocked sessions.
        journal.set_pending_io_hook(None);
        journal.take_published_paths();
        let retry = journal.forget_sessions(&["d-bad-update".to_owned(), "d-bad-retire".to_owned()]);
        assert!(retry.failed.is_empty(), "retry must succeed: {:?}", retry.failed);
        assert!(retry.any_changed);
        let retry_carries_publishes =
            journal.take_published_paths().into_iter().filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("carries.json")).count();
        assert_eq!(retry_carries_publishes, 1);

        let final_disk = MarksOnDisk::new(dir.path()).load().unwrap();
        assert_eq!(final_disk.carries, vec![("s-c".to_owned(), "s-d".to_owned())]);
        assert_eq!(final_disk.pending.keys().copied().collect::<Vec<_>>(), vec![0, 2]);
        assert!(final_disk.pending[&0].origin.is_empty());
        assert_eq!(final_disk.pending[&0].sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-heir-bad".to_owned()]);

        // Also verify a carry-only clean session still publishes when the only touched mark file fails (no prior pending/ sync).
        let dir2 = tempfile::tempdir().unwrap();
        let sensitive_dir2 = dir2.path().join("sensitive");
        let pending_dir2 = sensitive_dir2.join("pending");
        std::fs::create_dir_all(&pending_dir2).unwrap();
        std::fs::write(sensitive_dir2.join("carries.json"), serde_json::to_vec(&json!([["d-bad", "s-keep"], ["s-x", "d-clean"], ["d-clean", "s-y"]])).unwrap())
            .unwrap();
        std::fs::write(
            pending_dir2.join("0.json"),
            serde_json::to_vec(&json!({ "origin": "d-bad", "values": ["secret-only-bad"], "sessions": { "d-bad": 1 } })).unwrap(),
        )
        .unwrap();
        let journal2 = MarksOnDisk::new(dir2.path());
        let _ = journal2.load().unwrap();
        journal2.set_pending_io_hook(Some(Box::new(|path| Err(format!("{}: simulated failure", path.display())))));
        journal2.take_published_paths();

        let out2 = journal2.forget_sessions(&["d-bad".to_owned(), "d-clean".to_owned()]);
        assert!(out2.any_changed);
        assert_eq!(out2.failed.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), vec!["d-bad"]);
        let carries_publishes2 =
            journal2.take_published_paths().into_iter().filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("carries.json")).count();
        assert_eq!(carries_publishes2, 1);
        let reloaded2 = MarksOnDisk::new(dir2.path()).load().unwrap();
        assert_eq!(reloaded2.carries, vec![("d-bad".to_owned(), "s-keep".to_owned()), ("s-x".to_owned(), "s-y".to_owned())]);
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test stages journal files directly on disk")]
    fn forget_sessions_relies_on_collapsed_carry_and_preserves_restore_and_liveness() {
        let stage = |root: &Path| {
            let sensitive_dir = root.join("sensitive");
            let pending_dir = sensitive_dir.join("pending");
            std::fs::create_dir_all(&pending_dir).unwrap();
            std::fs::write(sensitive_dir.join("carries.json"), serde_json::to_vec(&json!([["s-live", "d-2"], ["d-2", "s-t"], ["d-1", "s-t"]])).unwrap())
                .unwrap();
            std::fs::write(
                pending_dir.join("0.json"),
                serde_json::to_vec(&json!({ "origin": "s-live", "values": ["secret-collapsed"], "sessions": { "d-1": 1 } })).unwrap(),
            )
            .unwrap();
            let journal = MarksOnDisk::new(root);
            let _ = journal.load().unwrap();
            journal
        };

        let seq_dir = tempfile::tempdir().unwrap();
        let seq_journal = stage(seq_dir.path());
        seq_journal.forget_session("d-1").unwrap();
        seq_journal.forget_session("d-2").unwrap();

        let batch_dir = tempfile::tempdir().unwrap();
        let batch_journal = stage(batch_dir.path());
        let outcome = batch_journal.forget_sessions(&["d-1".to_owned(), "d-2".to_owned()]);
        assert!(outcome.failed.is_empty(), "batch forget failed: {:?}", outcome.failed);
        assert!(outcome.any_changed);

        let seq_reloaded = MarksOnDisk::new(seq_dir.path()).load().unwrap();
        let batch_reloaded = MarksOnDisk::new(batch_dir.path()).load().unwrap();
        assert_eq!(batch_reloaded.carries, vec![("s-live".to_owned(), "s-t".to_owned())]);
        assert_eq!(batch_reloaded.carries, seq_reloaded.carries);
        assert_eq!(seq_reloaded.pending[&0].sessions.keys().cloned().collect::<Vec<_>>(), vec!["s-t".to_owned()]);
        assert!(batch_reloaded.pending[&0].sessions.is_empty(), "batch relies on collapsed s-live -> s-t edge");

        // Restore must reach the exact same owed sessions under both sequential and batch states.
        let restore_owed = |loaded: &Loaded| {
            let store = mixdog_services::memory::sensitive::SensitiveStore::default();
            store.restore_carries(loaded.carries.clone());
            let mark = &loaded.pending[&0];
            store.restore(mark.origin.clone(), mark.sessions.keys().cloned().collect(), mark.values.clone())
        };
        let seq_owed = restore_owed(&seq_reloaded);
        let batch_owed = restore_owed(&batch_reloaded);
        assert_eq!(batch_owed, BTreeSet::from(["s-live".to_owned(), "s-t".to_owned()]));
        assert_eq!(batch_owed, seq_owed);

        // The batch mark must stay live even after s-live settles and boot recovery retires until s-t is confirmed.
        batch_journal.settled("s-live", &[0]).unwrap();
        batch_journal.forget_recovered(vec![0]);
        assert_eq!(batch_journal.lock().marks.len(), 1, "mark must stay live while s-t is unconfirmed");
        assert_eq!(MarksOnDisk::new(batch_dir.path()).load().unwrap().pending.len(), 1);

        batch_journal.marked("s-live", &["secret-collapsed".into()], &[("s-t".into(), 1)]);
        batch_journal.applied("s-t", 1);
        assert!(batch_journal.lock().marks.is_empty(), "mark must retire once s-t is confirmed");
        assert!(batch_journal.lock().applied_values.is_empty());
        assert!(MarksOnDisk::new(batch_dir.path()).load().unwrap().pending.is_empty());
    }
}
