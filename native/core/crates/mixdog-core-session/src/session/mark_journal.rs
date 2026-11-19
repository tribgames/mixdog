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

// Transparent names for existing callback/record shapes; no ownership or ordering change.
type PendingMarkUpdate = (String, Vec<String>, BTreeMap<String, u64>);

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::PoisonError;

use serde_json::Value;
use serde_json::json;

/// The folder of the search-copy debts: one empty file per session.
const SEARCH_OWED: &str = "search-owed";

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
    /// File number → (origin, values, session → the version that holds the values).
    pending: BTreeMap<u64, PendingMarkUpdate>,
    next: u64,
    /// Per session, the newest version its log was rewritten for in this process.
    applied: HashMap<String, u64>,
    /// The marks an earlier process left, by file number, as loaded and settled since.
    recovered: BTreeMap<u64, PendingMark>,
    /// The sessions whose session-search copy still holds text from before their rewrite (`search-owed/<id>`).
    search_owed: BTreeSet<String>,
}

pub(crate) struct MarksOnDisk {
    dir: PathBuf,
    state: Mutex<State>,
}

impl MarksOnDisk {
    pub(crate) fn new(data: &Path) -> Self {
        Self { dir: data.join("sensitive"), state: Mutex::default() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pending_path(&self, n: u64) -> PathBuf {
        self.dir.join("pending").join(format!("{n}.json"))
    }

    fn publish(path: &Path, value: &Value) {
        if let Err(error) = Self::publish_checked(path, value) {
            tracing::error!(path = %path.display(), "a sensitive mark could not be journaled; a restart before its rewrites ends would keep its copies: {error}");
        }
    }

    /// One durable publish of `value` at `path`; the failure is the caller's.
    fn publish_checked(path: &Path, value: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        mixdog_store::fsio::publish_file_with(path, &bytes, mixdog_store::fsio::Access::OwnerOnly).map_err(|error| format!("{}: {error}", path.display()))
    }

    #[allow(clippy::disallowed_methods, reason = "a journaled mark is removed once applied; blocking by design (see module)")]
    fn remove(path: &Path) {
        match std::fs::remove_file(path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    let _ = mixdog_store::fsio::sync_dir(parent);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(path = %path.display(), "an applied sensitive mark's journal file stays: {error}"),
        }
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
            let mark = serde_json::from_slice(&std::fs::read(entry.path())?)
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
        state.recovered = pending.clone();
        state.search_owed.extend(search_owed);
        Ok(Loaded { carries, pending })
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
            state.recovered.remove(&n);
            Self::remove(&self.pending_path(n));
        }
    }

    /// `session`'s log was rewritten, and its rows rebuilt, for every value of the recovered marks `marks`: each file says so
    /// durably before this returns, so a start after a quit or a crash does not rewrite it again for them. `Err` when a file
    /// could not say so (the session is then rewritten again by the next start, and is not to be answered before).
    pub(crate) fn settled(&self, session: &str, marks: &[u64]) -> Result<(), String> {
        let mut state = self.lock();
        for n in marks {
            let Some(mark) = state.recovered.get_mut(n) else { continue };
            if mark.settled.contains(session) {
                continue;
            }
            let mut settled = mark.settled.clone();
            settled.insert(session.to_owned());
            let file = json!({ "origin": mark.origin, "values": mark.values, "sessions": mark.sessions, "settled": settled });
            Self::publish_checked(&self.pending_path(*n), &file)?;
            mark.settled = settled;
        }
        Ok(())
    }

    /// `session`'s log was rewritten for every value it held at `version`: each pending mark it held by then drops it, and
    /// a mark no session is left in goes from disk.
    pub(crate) fn applied(&self, session: &str, version: u64) {
        let mut state = self.lock();
        let seen = state.applied.entry(session.to_owned()).or_default();
        *seen = (*seen).max(version);
        let mut done = Vec::new();
        for (n, (_, _, sessions)) in &mut state.pending {
            if sessions.get(session).is_some_and(|held| *held <= version) {
                sessions.remove(session);
                if sessions.is_empty() {
                    done.push(*n);
                }
            }
        }
        for n in done {
            state.pending.remove(&n);
            Self::remove(&self.pending_path(n));
        }
    }
}

impl mixdog_services::memory::sensitive::MarkJournal for MarksOnDisk {
    fn carried(&self, from: &str, to: &str) {
        let mut state = self.lock();
        if state.carries.insert((from.to_owned(), to.to_owned())) {
            let all: Vec<Value> = state.carries.iter().map(|(from, to)| json!([from, to])).collect();
            Self::publish(&self.dir.join("carries.json"), &Value::Array(all));
        }
    }

    fn marked(&self, origin: &str, values: &[String], sessions: &[(String, u64)]) {
        let mut state = self.lock();
        // A session rewritten for this version already (its barrier ran before this call) owes nothing.
        let owed: BTreeMap<String, u64> =
            sessions.iter().filter(|(session, version)| state.applied.get(session).is_none_or(|seen| seen < version)).cloned().collect();
        if owed.is_empty() {
            return;
        }
        let n = state.next;
        state.next += 1;
        Self::publish(&self.pending_path(n), &json!({ "origin": origin, "values": values, "sessions": owed }));
        state.pending.insert(n, (origin.to_owned(), values.to_vec(), owed));
    }
}
