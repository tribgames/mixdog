//! Transcript ingest (`transcript-ingest.mjs` and `ingest/`): incremental JSONL ingestion of the
//! session transcripts under the projects root, plus the watcher that keeps them flowing.

pub mod discovery;
pub mod rows;
pub mod tail;
pub mod watcher;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_js::to_number_of;
use mixdog_rt::{DurabilityIo, MaintenanceIo};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use crate::memory::error::Result;
use crate::memory::ingest::NowMs;
use crate::memory::pg::db::Db;
use crate::memory::schema::{get_meta, set_meta};

const OFFSETS_KEY: &str = "state.transcript_offsets";

/// The lanes the transcript jobs read and classify on.
#[derive(Clone, Copy)]
pub struct TranscriptIo {
    /// Transcript reads and the active-file scan.
    pub maintenance: MaintenanceIo,
    /// The project marker files (`resolve_project_id`).
    pub durability: DurabilityIo,
}

/// A file's read position, in JS numbers like the persisted blob.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub bytes: f64,
    pub line_index: f64,
    pub generation: f64,
}

/// `transcript-offsets.mjs`: per-file positions persisted as one JSON blob in the `meta` kv,
/// writes serialized so concurrent file ingests never interleave.
pub struct Offsets {
    map: Mutex<Map<String, Value>>,
    persisting: Semaphore,
}

impl Offsets {
    fn new() -> Self {
        Self { map: Mutex::default(), persisting: Semaphore::new(1) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        self.map.lock().expect("transcript offsets")
    }

    /// A damaged or missing blob starts empty.
    pub async fn load(&self, db: &Db) {
        let loaded = match get_meta(db, OFFSETS_KEY).await {
            Ok(Some(Value::Object(map))) => map,
            _ => Map::new(),
        };
        *self.lock() = loaded;
    }

    pub async fn persist(&self, db: &Db) {
        let Ok(_turn) = self.persisting.acquire().await else { return };
        let blob = Value::Object(self.lock().clone());
        if let Err(error) = set_meta(db, OFFSETS_KEY, &blob).await {
            mixdog_rt::memory_stderr!("[memory] persist transcript offsets failed: {}", error.message());
        }
    }

    /// The position of one file; a missing entry starts at zero.
    pub fn snapshot(&self, path: &str) -> Position {
        let map = self.lock();
        let field = |stored: &Value, name: &str| {
            let n = to_number_of(stored.get(name));
            if n.is_nan() || n == 0.0 { 0.0 } else { n }
        };
        map.get(path).map_or(Position { bytes: 0.0, line_index: 0.0, generation: 0.0 }, |stored| Position {
            bytes: field(stored, "bytes"),
            line_index: field(stored, "lineIndex"),
            generation: field(stored, "generation"),
        })
    }

    /// The stored position, if the file has one.
    pub fn get(&self, path: &str) -> Option<Position> {
        let present = self.lock().contains_key(path);
        present.then(|| self.snapshot(path))
    }

    pub fn set(&self, path: &str, position: Position) {
        // JS numbers, as Node's JSON.stringify writes them (782, not 782.0).
        let number = mixdog_js::json_number;
        self.lock().insert(
            path.to_owned(),
            json!({"bytes": number(position.bytes), "lineIndex": number(position.line_index), "generation": number(position.generation)}),
        );
    }

    fn forget(&self, path: &str) -> bool {
        self.lock().shift_remove(path).is_some()
    }

    pub fn reset(&self) {
        self.lock().clear();
    }
}

/// A transcript's text mapped to the same lines, each possibly changed.
pub type LineRewrite = Box<dyn FnOnce(String) -> String + Send>;

/// Replaces `path` atomically with `rewrite` of its text, on `lane`; the old and new bytes, or
/// `None` when the file is missing or unchanged.
// Boxed as `Send` here: the lane's higher-ranked job closure otherwise defeats the `Send` proof of
// every async caller that awaits it.
pub fn rewrite_lines_file<L: mixdog_fsio::WriteLane + Send + 'static>(
    lane: L,
    path: &Path,
    rewrite: LineRewrite,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<Option<(Vec<u8>, Vec<u8>)>>> + Send>> {
    let file = path.to_owned();
    Box::pin(async move { rewrite_lines_job(lane, file, rewrite).await })
}

async fn rewrite_lines_job<L: mixdog_fsio::WriteLane>(lane: L, file: std::path::PathBuf, rewrite: LineRewrite) -> std::io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let job = lane
        .submit_wait(&mixdog_rt::CancellationToken::new(), move |lane| -> std::io::Result<Option<(Vec<u8>, Vec<u8>)>> {
            let Ok(stat) = mixdog_statefile::metadata(lane, &file) else { return Ok(None) };
            let old = mixdog_statefile::read_range(lane, &file, 0, stat.len() as usize)?;
            let new = rewrite(String::from_utf8_lossy(&old).into_owned()).into_bytes();
            if new == old {
                return Ok(None);
            }
            mixdog_statefile::write_file(lane, &file, &new, &mixdog_statefile::Opts::default()).map_err(std::io::Error::other)?;
            Ok(Some((old, new)))
        })
        .await
        .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    job.await.map_err(|e| std::io::Error::other(e.to_string()))?
}

/// The offset in `new` that ends the same number of lines `bytes` ends in `old`.
pub fn same_line_offset(old: &[u8], new: &[u8], bytes: f64) -> f64 {
    let end = (bytes.max(0.0) as usize).min(old.len());
    let lines = old[..end].iter().filter(|b| **b == b'\n').count();
    if lines == 0 {
        return 0.0;
    }
    new.iter().enumerate().filter(|(_, b)| **b == b'\n').nth(lines - 1).map_or(new.len(), |(at, _)| at + 1) as f64
}

/// `createTranscriptIngest`: ingest of one transcript at a time per file, over the offsets.
pub struct TranscriptIngest {
    pub(crate) db: Db,
    pub(crate) io: TranscriptIo,
    pub(crate) now: NowMs,
    pub(crate) offsets: Offsets,
    /// Per-file serialization: two ingests of one transcript never overlap.
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl TranscriptIngest {
    pub fn new(db: Db, io: TranscriptIo, now: NowMs) -> Arc<Self> {
        Arc::new(Self { db, io, now, offsets: Offsets::new(), gates: Mutex::default() })
    }

    pub async fn load_transcript_offsets(&self) {
        self.offsets.load(&self.db).await;
    }

    pub async fn persist_transcript_offsets(&self) {
        self.offsets.persist(&self.db).await;
    }

    /// `getOffset`.
    pub fn get_offset(&self, path: &Path) -> Option<Position> {
        self.offsets.get(&path.to_string_lossy())
    }

    pub fn reset_offsets(&self) {
        self.offsets.reset();
    }

    fn gate(&self, key: &str) -> Arc<Semaphore> {
        Arc::clone(self.gates.lock().expect("transcript gates").entry(key.to_owned()).or_insert_with(|| Arc::new(Semaphore::new(1))))
    }

    /// Drops the file's queue entry once nothing else holds it.
    fn release(&self, key: &str, gate: Arc<Semaphore>) {
        let mut gates = self.gates.lock().expect("transcript gates");
        if Arc::strong_count(&gate) == 2 {
            gates.remove(key);
        }
    }

    /// `ingestTranscriptFile`: the number of rows inserted.
    pub async fn ingest_transcript_file(&self, path: &Path, cwd: Option<&Path>) -> Result<usize> {
        let key = std::path::absolute(path).unwrap_or_else(|_| path.to_owned()).to_string_lossy().into_owned();
        let gate = self.gate(&key);
        let outcome = {
            let _turn = gate.acquire().await;
            tail::ingest_transcript_tail(self, path, cwd).await
        };
        self.release(&key, gate);
        outcome
    }

    /// A transcript rewritten in place line for line (`rewrite` maps the file's text to text with
    /// the same lines, in order, each possibly changed): under the file's ingest gate, so no ingest
    /// reads it half-replaced, the file is replaced atomically and the persisted read position moves
    /// to the same line of the new text. The watcher then neither skips a line nor reads one again
    /// (the generation and line index stay; only the byte offset follows the rewritten lengths).
    /// `false` when the file is missing or `rewrite` leaves it as it was.
    pub async fn rewrite_transcript(&self, path: &Path, rewrite: LineRewrite) -> std::io::Result<bool> {
        let key = std::path::absolute(path).unwrap_or_else(|_| path.to_owned()).to_string_lossy().into_owned();
        let gate = self.gate(&key);
        let outcome = {
            let _turn = gate.acquire().await;
            let mut keys = vec![path.to_string_lossy().into_owned()];
            if !keys.contains(&key) {
                keys.push(key.clone());
            }
            let held: Vec<(String, Position)> = keys.into_iter().filter_map(|k| self.offsets.get(&k).map(|p| (k, p))).collect();
            match rewrite_lines_file(self.io.maintenance, path, rewrite).await {
                Ok(Some((old, new))) => {
                    for (k, position) in held {
                        self.offsets.set(&k, Position { bytes: same_line_offset(&old, &new, position.bytes), ..position });
                    }
                    self.offsets.persist(&self.db).await;
                    Ok(true)
                }
                Ok(None) => Ok(false),
                Err(error) => Err(error),
            }
        };
        self.release(&key, gate);
        outcome
    }

    /// A deleted session's transcripts: wait out any ingest of each file, then drop its persisted
    /// position. Returns the entries removed.
    pub async fn forget_transcripts(&self, paths: &[PathBuf]) -> usize {
        let mut removed = 0;
        for path in paths {
            let resolved = std::path::absolute(path).unwrap_or_else(|_| path.clone());
            let key = resolved.to_string_lossy().into_owned();
            let gate = self.gate(&key);
            drop(gate.acquire().await);
            self.release(&key, gate);
            let mut seen = Vec::new();
            for name in [path.to_string_lossy().into_owned(), key] {
                if !seen.contains(&name) {
                    removed += usize::from(self.offsets.forget(&name));
                    seen.push(name);
                }
            }
        }
        if removed > 0 {
            self.persist_transcript_offsets().await;
        }
        removed
    }
}
