//! A 1.4.5 session log far larger than its history converts with memory bounded by the history.
//!
//! 1.4.5 rewrites the whole history as a `compacted` record whenever a save shares no message by
//! reference at either end of the list (`session-log-writer.mjs` `_messageRecord`), so the log of
//! a long session is that history written over and over: the real 635 MB log of a desktop session
//! holds 478 snapshots of at most 2.2 MB. The migration used to read the file whole, split it into
//! lines and keep every parsed record; it now reads a line at a time and keeps the working history.
//!
//! Own test binary: the allocator below counts the whole process, so no other test may run in it
//! (nextest runs every test in its own process; under `cargo test` run it alone).
//!
//! The log is generated here, record by record, in that shape.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures build and inspect data dirs with blocking std::fs"
)]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_migrate::session::target::read_sessions;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

#[path = "support/log_harness.rs"]
mod support;
use support::*;

/// Bytes the process holds now and the most it held since `PEAK` was last reset.
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct Counting;

fn grow(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

// SAFETY: every call is forwarded to `System` with the caller's layout; the counters only observe.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            grow(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: as `alloc`.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            grow(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from this allocator with `layout`, as the caller promises.
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: `ptr` came from this allocator with `layout`, as the caller promises.
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if !moved.is_null() {
            if new_size >= layout.size() {
                grow(new_size - layout.size());
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// What the migration may hold at once: a few copies of the history and the fixed cost of the run.
const BUDGET: usize = 3 * (1 << 20);

/// The recorder's generator, in Rust: its parameters, the same messages, the same record order.
struct Params {
    id: String,
    log_id: String,
    start: usize,
    rounds: usize,
    edit_every: usize,
    repeat: usize,
}

impl Params {
    fn new() -> Self {
        Self { id: "sess_longlog".into(), log_id: "longlog1".into(), start: 100, rounds: 24, edit_every: 5, repeat: 200 }
    }

    fn message(&self, n: usize) -> String {
        let role = ["user", "assistant", "tool"][n % 3];
        let content = format!("message {n}\n\t\"quoted\" {}", "é\u{1F600} text ".repeat(self.repeat));
        json!({ "role": role, "content": content }).to_string()
    }
}

/// Writes the log; its size and SHA-256.
fn write_log(path: &Path, params: &Params) -> (u64, String, Vec<String>) {
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).expect("create"));
    let (mut bytes, mut hash) = (0u64, Sha256::new());
    let mut put = |text: String| {
        out.write_all(text.as_bytes()).expect("write");
        hash.update(text.as_bytes());
        bytes += text.len() as u64;
    };
    let history = generate(params, &mut put);
    out.flush().expect("flush");
    (bytes, hex(&hash.finalize()), history)
}

/// Every record of the log, in order, to `put`; the history the log leaves.
fn generate(params: &Params, put: &mut impl FnMut(String)) -> Vec<String> {
    let mut history: Vec<String> = vec![json!({ "role": "system", "content": "You are a coding agent." }).to_string()];
    history.extend((0..params.start).map(|n| params.message(n)));
    let mut next = params.start;
    put(session(&params.log_id, &params.id, &json!({ "id": params.id, "title": "first", "updatedAt": 1 })));
    put(compacted(1, &history));
    let mut seq = 2;
    for round in 0..params.rounds {
        let added: Vec<String> = (next..next + 2).map(|n| params.message(n)).collect();
        next += 2;
        history.extend(added.iter().cloned());
        put(append(seq, history.len(), &added));
        put(patch(seq + 1, &json!({ "updatedAt": round + 2 }), &json!([])));
        seq += 2;
        // The save that rebuilt the first message: the whole history again.
        history.extend((next..next + 2).map(|n| params.message(n)));
        next += 2;
        put(compacted(seq, &history));
        seq += 1;
        if round % params.edit_every == 0 {
            let last = history.len() - 1;
            history[last] = params.message(next);
            next += 1;
            put(edit(seq, history.len(), last, 1, &history[last..]));
            seq += 1;
        }
    }
    history.pop();
    put(rollback(seq, history.len()));
    put(patch(seq + 1, &json!({ "title": "last" }), &json!(["updatedAt"])));
    // A line the writer was still writing when the process ended.
    put(format!("{{\"t\":\"append\",\"s\":{},\"len\":{},\"mess", seq + 2, history.len() + 1));
    history
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn a_log_many_times_its_history_converts_in_bounded_memory_to_the_history_it_leaves() {
    let params = Params::new();
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    let log = roots.data.join(format!("sessions/{}.log.jsonl", params.id));
    let (size, _, history) = write_log(&log, &params);
    let history_bytes: usize = history.iter().map(String::len).sum();

    let (_runtime, migrator) = migrator(&roots, Default::default());
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let complete = migrator.run().expect("the migration completes");
    let held = PEAK.load(Ordering::Relaxed) - before;
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    eprintln!("log {size} bytes, history {history_bytes} bytes, held {held} bytes");
    // Holding the file whole would take more than the budget, so the budget tells streaming from buffering.
    assert!(size as usize > 2 * BUDGET, "the log ({size} bytes) is too small to tell buffering from streaming");
    assert!(held < BUDGET, "the run held {held} bytes converting a {size} byte log");

    let folded = read_sessions(&roots, &complete.manifest_sha256).expect("the migrated sessions fold");
    assert_eq!(folded.len(), 1);
    let session = &folded[&params.id];
    // The system message is the header's prompt base; every other message of the final history is one row, in order.
    assert_eq!(session.header["promptBase"], "You are a coding agent.");
    assert_eq!(session.rows.len(), history.len() - 1);
    let body = |n: usize| serde_json::to_string(&session.rows[n].body).expect("json");
    let want = |n: usize| serde_json::to_string(&serde_json::from_str::<Value>(&history[n + 1]).expect("json")).expect("json");
    for n in [0, 1, session.rows.len() / 2, session.rows.len() - 1] {
        assert_eq!(body(n), want(n), "row {n}");
    }
}
