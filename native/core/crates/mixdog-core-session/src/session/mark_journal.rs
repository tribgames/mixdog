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

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::PoisonError;

use serde_json::Value;
use serde_json::json;

/// What a start reads back: the carries, and each pending mark (its file number, origin, values and listed sessions).
pub(crate) struct Loaded {
    pub carries: Vec<(String, String)>,
    pub pending: Vec<(u64, String, Vec<String>, Vec<String>)>,
}

#[derive(Default)]
struct State {
    carries: BTreeSet<(String, String)>,
    /// File number → (origin, values, session → the version that holds the values).
    pending: BTreeMap<u64, (String, Vec<String>, BTreeMap<String, u64>)>,
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
    pub(crate) fn load(&self) -> Loaded {
        let read = |path: &Path| std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let text = |value: &Value| value.as_str().map(str::to_owned);
        let carries: Vec<(String, String)> = read(&self.dir.join("carries.json"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|pair| Some((text(pair.get(0)?)?, text(pair.get(1)?)?)))
            .collect();
        let mut pending = Vec::new();
        for entry in std::fs::read_dir(self.dir.join("pending")).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(n) = name.strip_suffix(".json").and_then(|n| n.parse::<u64>().ok()) else { continue };
            let Some(mark) = read(&entry.path()) else { continue };
            let values: Vec<String> = mark["values"].as_array().into_iter().flatten().filter_map(text).collect();
            let sessions: Vec<String> = mark["sessions"].as_object().map(|s| s.keys().cloned().collect()).unwrap_or_default();
            pending.push((n, text(&mark["origin"]).unwrap_or_default(), values, sessions));
        }
        pending.sort_by_key(|p| p.0);
        let mut state = self.lock();
        state.carries.extend(carries.iter().cloned());
        state.next = state.next.max(pending.last().map_or(0, |p| p.0 + 1));
        Loaded { carries, pending }
    }

    /// A pending mark read back at start, once it was marked again (journaled anew): its old file goes.
    pub(crate) fn forget(&self, n: u64) {
        Self::remove(&self.pending_path(n));
    }

    /// The sessions some pending mark still lists.
    pub(crate) fn owed(&self) -> Vec<String> {
        let state = self.lock();
        let owed: BTreeSet<String> = state.pending.values().flat_map(|(_, _, sessions)| sessions.keys().cloned()).collect();
        owed.into_iter().collect()
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
