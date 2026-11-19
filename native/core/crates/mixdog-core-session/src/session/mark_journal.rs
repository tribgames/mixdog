//! The sensitive marks on disk (`<data>/sensitive`), so a mark outlives a process that ends before every session holding
//! its value was rewritten:
//! - `carries.json`: every `[from, to]` whose text went from one session to another (ids only), written before the carry
//!   takes effect;
//! - `pending/<n>.json`: one mark not yet applied everywhere, `{origin, values, sessions: {id: version}}`, written before any
//!   listener hears of the mark (so before the marking call runs) and removed once each listed session's log was
//!   rewritten for at least that version. While it exists it holds the values, as the logs it is about do; once every log
//!   is rewritten nothing on disk does, this file included.
//!
//! The next start ([`super::store::StoreThreads::settle_marks`]) restores the carries and each pending mark, then rewrites
//! every session still listed.
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

pub(crate) struct Loaded {
    pub carries: Vec<(String, String)>,
    pub pending: BTreeMap<u64, PendingMark>,
}

#[derive(serde::Deserialize)]
pub(crate) struct PendingMark {
    pub origin: String,
    pub values: Vec<String>,
    pub sessions: BTreeMap<String, u64>,
}

#[derive(Default)]
struct State {
    carries: BTreeSet<(String, String)>,
    /// File number → (origin, values, session → the version that holds the values).
    pending: BTreeMap<u64, PendingMarkUpdate>,
    next: u64,
    /// Per session, the newest version its log was rewritten for in this process.
    applied: HashMap<String, u64>,
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
        let bytes = serde_json::to_vec(value).unwrap_or_default();
        if let Err(error) = mixdog_store::fsio::publish_file_with(path, &bytes, mixdog_store::fsio::Access::OwnerOnly) {
            tracing::error!(path = %path.display(), "a sensitive mark could not be journaled; a restart before its rewrites ends would keep its copies: {error}");
        }
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
        let mut state = self.lock();
        state.carries.extend(carries.iter().cloned());
        state.next = state.next.max(next);
        Ok(Loaded { carries, pending })
    }

    /// Retire the original recovery records only after every owed rewrite, including index replacement, is durable.
    pub(crate) fn forget_recovered(&self, recovered: Vec<u64>) {
        for n in recovered {
            Self::remove(&self.pending_path(n));
        }
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
