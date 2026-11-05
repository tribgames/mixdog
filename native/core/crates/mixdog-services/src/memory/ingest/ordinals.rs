//! Untimestamped-repeat ordinal state, per session (`ingest/ordinal-state.mjs`).
//!
//! `occ_next[identity]` is the next free occurrence ordinal of a (role,
//! content) identity. It tells apart textually identical turns that carry no
//! timestamp, so a genuine appended repeat lands above every stored copy while
//! a re-ingest of the same transcript reproduces the same references. The
//! state lives in memory, bounded to [`MAX_SESSIONS`] by least-recent use, and
//! is rebuilt from the previous snapshot or the durable high-water after an
//! eviction or a restart.
//!
//! Node also keeps a per-message-object ordinal in a WeakMap. A transcript
//! reaches this runtime as freshly parsed JSON on every call, so no object is
//! ever seen twice and that map never hits; it has no counterpart here.

use std::collections::{HashMap, VecDeque};

use mixdog_js::{to_number, utf16_len};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::schema::{get_meta, set_meta};

const MAX_SESSIONS: usize = 2048;
const KEY_PREFIX: &str = "state.session_ingest_ordinals.";

/// Short content-derived key of the durable map: a fixed-width hash per
/// duplicate identity instead of raw message text.
pub fn identity_hash(occurrence_key: &str) -> String {
    let digest = Sha256::digest(occurrence_key.as_bytes());
    digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Default)]
pub struct SessionState {
    pub occ_next: HashMap<String, u64>,
    /// An earlier ingest established this state (a warm call).
    pub seeded: bool,
    /// The previous ordered (source key, occurrence) sequence.
    pub snapshot: Vec<(String, u64)>,
    pub durable: HashMap<String, u64>,
    durable_loaded: bool,
    pub dirty: bool,
}

impl SessionState {
    /// Draws the occurrence of a first-seen row; `floor` lifts a warm
    /// untimestamped turn above the durable high-water.
    pub fn assign(&mut self, key: &str, floor: u64) -> u64 {
        let next = self.occ_next.get(key).copied().unwrap_or(0).max(floor);
        self.occ_next.insert(key.to_owned(), next + 1);
        next
    }

    /// Reuses an occurrence recovered from the previous snapshot.
    pub fn reuse(&mut self, key: &str, occurrence: u64) -> u64 {
        if occurrence + 1 > self.occ_next.get(key).copied().unwrap_or(0) {
            self.occ_next.insert(key.to_owned(), occurrence + 1);
        }
        occurrence
    }

    /// Loads the durable high-water once per (re)established state. Absent or
    /// corrupt data leaves it empty: the in-memory path is still correct.
    pub async fn ensure_durable_loaded(&mut self, db: &Db, session_id: &str) {
        if self.durable_loaded {
            return;
        }
        self.durable.clear();
        if let Ok(Some(Value::Object(map))) = get_meta(db, &format!("{KEY_PREFIX}{session_id}")).await {
            for (key, value) in map {
                let n = to_number(&value);
                if n.is_finite() && n > 0.0 {
                    self.durable.insert(key, n.floor() as u64);
                }
            }
        }
        self.durable_loaded = true;
    }

    /// Persists the durable high-water when it changed. A failure only
    /// degrades a rare post-restart append, never this call.
    pub async fn persist_durable(&mut self, db: &Db, session_id: &str) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let map: serde_json::Map<String, Value> = self.durable.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect();
        let saved: Result<()> = set_meta(db, &format!("{KEY_PREFIX}{session_id}"), &Value::Object(map)).await;
        if let Err(error) = saved {
            tracing::warn!(%error, "[ingest] untimestamped high-water persist failed");
        }
    }
}

/// The sessions' states, least recently used first.
#[derive(Default)]
pub struct OrdinalStore {
    states: HashMap<String, SessionState>,
    order: VecDeque<String>,
}

impl OrdinalStore {
    /// Takes the session's state out (creating it on a miss); [`put`] returns it
    /// as the most recent. The caller's per-session chain keeps two ingests of
    /// one session from holding it at once.
    pub fn take(&mut self, session_id: &str) -> SessionState {
        if let Some(state) = self.states.remove(session_id) {
            self.order.retain(|id| id != session_id);
            return state;
        }
        SessionState::default()
    }

    pub fn put(&mut self, session_id: &str, state: SessionState) {
        self.states.insert(session_id.to_owned(), state);
        self.order.push_back(session_id.to_owned());
        while self.states.len() > MAX_SESSIONS {
            let Some(oldest) = self.order.pop_front() else { break };
            self.states.remove(&oldest);
        }
    }
}

/// Content/order fallback for JSON-cloned transcript replays: the previous
/// sequence is indexed by base source key, and a greedy forward match
/// recognises unchanged prefixes, compacted survivors and appended suffixes.
pub struct PriorMatcher {
    by_key: HashMap<String, Vec<(usize, u64)>>,
    pointers: HashMap<String, usize>,
    cursor: usize,
}

impl PriorMatcher {
    pub fn new(snapshot: &[(String, u64)]) -> Self {
        let mut by_key: HashMap<String, Vec<(usize, u64)>> = HashMap::new();
        for (index, (key, occurrence)) in snapshot.iter().enumerate() {
            if utf16_len(key) > 0 {
                by_key.entry(key.clone()).or_default().push((index, *occurrence));
            }
        }
        Self { by_key, pointers: HashMap::new(), cursor: 0 }
    }

    pub fn take(&mut self, key: &str) -> Option<u64> {
        let list = self.by_key.get(key).filter(|list| !list.is_empty())?;
        let mut p = self.pointers.get(key).copied().unwrap_or(0);
        while p < list.len() && list[p].0 < self.cursor {
            p += 1;
        }
        if p >= list.len() {
            self.pointers.insert(key.to_owned(), p);
            return None;
        }
        let (index, occurrence) = list[p];
        self.pointers.insert(key.to_owned(), p + 1);
        self.cursor = index + 1;
        Some(occurrence)
    }
}
