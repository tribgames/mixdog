//! A 1.4.5 session log of hundreds of MB converts with memory bounded independently of its size.
//!
//! 1.4.5 rewrites the whole history as a `compacted` record whenever a save shares no message by
//! reference at either end of the list (`session-log-writer.mjs` `_messageRecord`), so the log of
//! a long session is that history written over and over: the real 635 MB log of a desktop session
//! holds 478 snapshots of at most 2.2 MB. The migration used to read the file whole, split it into
//! lines and keep every parsed record; it now reads a line at a time and keeps the working history.
//!
//! Own test binary: the allocator below counts the whole process, so no other test may run in it.
//! The record encodings are the ones real 1.4.5 wrote (`fixtures/long-session-log`, recorded by
//! `benchmarks/rust-core/recorders/record-long-session-log.mjs`).

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
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_migrate::session::source::fold_log;
use mixdog_migrate::session::target::read_sessions;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

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

/// The recorded log, and what 1.4.5's own reader replayed from it.
fn recorded() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/long-session-log/log.json");
    serde_json::from_slice(&std::fs::read(path).expect("the recording")).expect("json")
}

// The record encodings of `session-log-format.mjs`, as the recording shows them.

fn array(messages: &[String]) -> String {
    format!("[{}]", messages.join(","))
}

fn compacted(seq: u64, messages: &[String]) -> String {
    format!("{{\"t\":\"compacted\",\"s\":{seq},\"len\":{},\"messages\":{}}}\n", messages.len(), array(messages))
}

fn append(seq: u64, len: usize, messages: &[String]) -> String {
    format!("{{\"t\":\"append\",\"s\":{seq},\"len\":{len},\"messages\":{}}}\n", array(messages))
}

fn edit(seq: u64, len: usize, at: usize, del: usize, messages: &[String]) -> String {
    format!("{{\"t\":\"edit\",\"s\":{seq},\"len\":{len},\"at\":{at},\"del\":{del},\"messages\":{}}}\n", array(messages))
}

fn rollback(seq: u64, len: usize) -> String {
    format!("{{\"t\":\"rollback\",\"s\":{seq},\"len\":{len}}}\n")
}

fn patch(seq: u64, set: &Value, unset: &Value) -> String {
    format!("{{\"t\":\"patch\",\"s\":{seq},\"set\":{set},\"unset\":{unset}}}\n")
}

fn session(log_id: &str, id: &str, header: &Value) -> String {
    format!("{{\"t\":\"session\",\"s\":0,\"v\":1,\"logId\":\"{log_id}\",\"id\":\"{id}\",\"prev\":null,\"legacy\":null,\"header\":{header}}}\n")
}

#[test]
fn the_encodings_are_the_ones_node_wrote() {
    let recorded = recorded();
    let log = recorded["log"].as_str().expect("log");
    let messages = |v: &Value| -> Vec<String> { v["messages"].as_array().expect("messages").iter().map(|m| m.to_string()).collect() };
    let mut again = String::new();
    for line in log.lines() {
        let v: Value = serde_json::from_str(line).expect("record");
        let seq = v["s"].as_u64().expect("s");
        again += &match v["t"].as_str().expect("t") {
            "session" => session(v["logId"].as_str().expect("logId"), v["id"].as_str().expect("id"), &v["header"]),
            "compacted" => compacted(seq, &messages(&v)),
            "append" => append(seq, v["len"].as_u64().expect("len") as usize, &messages(&v)),
            "edit" => edit(
                seq,
                v["len"].as_u64().expect("len") as usize,
                v["at"].as_u64().expect("at") as usize,
                v["del"].as_u64().expect("del") as usize,
                &messages(&v),
            ),
            "rollback" => rollback(seq, v["len"].as_u64().expect("len") as usize),
            "patch" => patch(seq, &v["set"], &v["unset"]),
            other => panic!("record kind {other}"),
        };
    }
    assert_eq!(again, log);
    let kinds = recorded["kinds"].as_array().expect("kinds");
    for kind in ["session", "compacted", "append", "edit", "rollback", "patch"] {
        assert!(kinds.iter().any(|k| k == kind), "the recording holds a {kind} record");
    }
}

#[test]
fn the_streaming_fold_replays_the_log_as_node_does() {
    let recorded = recorded();
    let dir = tempfile::tempdir().expect("scratch dir");
    let path = dir.path().join("sess_longlog.log.jsonl");
    std::fs::write(&path, recorded["log"].as_str().expect("log")).expect("write");
    let mut log = durable::open_buffered(&path).expect("open");
    let fold = fold_log(recorded["id"].as_str().expect("id"), &mut log, &mut 0).expect("the log folds");
    let replay = &recorded["replay"];
    assert_eq!(Value::Object(fold.header), replay["header"]);
    assert_eq!(Value::Array(fold.messages), replay["messages"]);
}

struct NoDocs;

#[async_trait::async_trait]
impl DocumentText for NoDocs {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        panic!("the data has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// Snapshots of the whole history every round: the shape 1.4.5 gives a long session.
const START: usize = 200;
const ROUNDS: usize = 250;
const MIB: usize = 1 << 20;

fn message(n: usize) -> String {
    let role = ["user", "assistant", "tool"][n % 3];
    let content = format!("message {n}\n\t\"quoted\" {}", "é\u{1F600} text ".repeat(150));
    json!({ "role": role, "content": content }).to_string()
}

/// Writes the log and returns the messages it replays to.
fn write_log(path: &Path) -> Vec<String> {
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).expect("create"));
    let mut put = |text: String| out.write_all(text.as_bytes()).expect("write");
    let mut history: Vec<String> = vec![json!({ "role": "system", "content": "You are a coding agent." }).to_string()];
    history.extend((0..START).map(message));
    let mut next = START;
    put(session("0123456789abcdef01234567", "sess_big", &json!({ "id": "sess_big", "title": "first", "updatedAt": 1 })));
    put(compacted(1, &history));
    let mut seq = 2;
    for round in 0..ROUNDS {
        let added: Vec<String> = (next..next + 2).map(message).collect();
        next += 2;
        history.extend(added.iter().cloned());
        put(append(seq, history.len(), &added));
        put(patch(seq + 1, &json!({ "updatedAt": round + 2 }), &json!([])));
        seq += 2;
        // The save that rebuilt the first message: the whole history again.
        let added: Vec<String> = (next..next + 2).map(message).collect();
        next += 2;
        history.extend(added);
        put(compacted(seq, &history));
        seq += 1;
        if round % 25 == 0 {
            let last = history.len() - 1;
            history[last] = message(next);
            next += 1;
            put(edit(seq, history.len(), last, 1, &history[last..]));
            seq += 1;
        }
    }
    history.truncate(history.len() - 1);
    put(rollback(seq, history.len()));
    put(patch(seq + 1, &json!({ "title": "last" }), &json!(["updatedAt"])));
    // A line the writer was still writing when the process ended.
    put(format!("{{\"t\":\"append\",\"s\":{},\"len\":{},\"mess", seq + 2, history.len() + 1));
    out.flush().expect("flush");
    history
}

#[test]
fn a_log_of_hundreds_of_mb_converts_in_bounded_memory() {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    std::fs::create_dir_all(roots.data.join("sessions")).expect("sessions dir");
    std::fs::create_dir_all(&roots.home).expect("home dir");
    let log = roots.data.join("sessions/sess_big.log.jsonl");
    let history = write_log(&log);
    let size = std::fs::metadata(&log).expect("log").len() as usize;
    assert!(size > 256 * MIB, "the log is {size} bytes");

    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("a runtime");
    let office = OfficeExtractor { docs: Arc::new(NoDocs), runtime: runtime.handle().clone() };
    let migrator = Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default());
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let complete = migrator.run().expect("the migration completes");
    let held = PEAK.load(Ordering::Relaxed) - before;
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    // The file was never held: the most the run held at once is a few lines and the history.
    assert!(held < 64 * MIB, "the run held {held} bytes converting a {size} byte log");

    let folded = read_sessions(&roots, &complete.manifest_sha256).expect("the migrated sessions fold");
    let session = &folded["sess_big"];
    let rows: Vec<&Value> = session.rows.iter().filter(|r| r.model && r.visible).map(|r| &r.body).collect();
    // The system message is the header's prompt, not a row.
    assert_eq!(rows.len(), history.len() - 1);
    for (n, (want, got)) in history[1..].iter().zip(&rows).enumerate() {
        assert_eq!(&serde_json::from_str::<Value>(want).expect("message"), *got, "message {n}");
    }
    let header = serde_json::to_value(&session.header).expect("header");
    assert_eq!(header["title"], "last");
    assert_eq!(header.get("updatedAt"), None);
}
