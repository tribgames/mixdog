//! The trace spool's file when rows arrive while a flush is writing: every row once, in the order it was queued, as Node's
//! (`_flushLocalTrace` keeps one write in flight and queues the rest), replayed from `fixtures/trace-spool/golden.json`
//! (benchmarks/rust-core/recorders/record-trace-spool.mjs). Rust flushes from any thread, so two flushers must not write their
//! chunks out of order.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "fixture loading reads files synchronously; the test runs its flushers on plain threads"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_trace::AgentTrace;
use mixdog_trace::flush_probe;
use mixdog_trace::TraceConfig;
use serde_json::Value;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/trace-spool/golden.json");
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

/// Failure deadline of every wait: nothing in a passing run waits for it.
const DEADLINE: Duration = Duration::from_secs(60);

enum Event {
    Blocked,
    Writing(String),
}

/// Holds the first flush at its write until the test releases it; reports every write and every flush that waits.
struct Probe {
    events: Mutex<mpsc::Sender<Event>>,
    release: Mutex<mpsc::Receiver<()>>,
    held_first: AtomicBool,
}

impl flush_probe::Probe for Probe {
    fn blocked(&self) {
        self.events.lock().unwrap().send(Event::Blocked).unwrap();
    }

    fn writing(&self, chunk: &str) {
        self.events.lock().unwrap().send(Event::Writing(chunk.to_owned())).unwrap();
        if !self.held_first.swap(true, Ordering::SeqCst) {
            self.release.lock().unwrap().recv_timeout(DEADLINE).expect("the test did not release the first flush from its write");
        }
    }
}

#[test]
fn a_flush_started_while_another_writes_waits_and_writes_the_chunks_node_wrote() {
    let golden = golden();
    let chunks: Vec<&str> = golden["chunks"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
    assert_eq!(chunks.len(), 2, "Node wrote the rows in two appends: the rows queued during the first");
    let rows = golden["rows"].as_array().unwrap();
    let first_rows = chunks[0].lines().count();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("trace").join("agent-trace.jsonl");
    let env: BTreeMap<String, String> = [("MIXDOG_DIAGNOSTICS", "1"), ("MIXDOG_AGENT_TRACE_PATH", path.to_str().unwrap())]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &|name| env.get(name).cloned(), false));
    let (events, seen) = mpsc::channel();
    let (release, released) = mpsc::channel();
    flush_probe::install(
        &path,
        Arc::new(Probe { events: Mutex::new(events), release: Mutex::new(released), held_first: AtomicBool::new(false) }),
    );
    let now = 1_700_000_000_000;
    let next = || seen.recv_timeout(DEADLINE).expect("no flush reached its write or its wait for the first flush");
    std::thread::scope(|scope| {
        // Owned here: a failed assertion drops it, which frees the held flush instead of leaving the scope waiting for it.
        let release = release;
        for row in &rows[..first_rows] {
            trace.append(row.as_object().unwrap(), now);
        }
        let first = scope.spawn(|| trace.flush(now));
        // The first flush holds its chunk at the write; the rest of the rows queue behind it, as in Node.
        assert!(matches!(next(), Event::Writing(chunk) if chunk == chunks[0]), "the first write is not Node's first chunk");
        for row in &rows[first_rows..] {
            trace.append(row.as_object().unwrap(), now);
        }
        let second = scope.spawn(|| trace.flush(now));
        assert!(matches!(next(), Event::Blocked), "a second flush wrote while the first held its write");
        release.send(()).unwrap();
        assert!(matches!(next(), Event::Writing(chunk) if chunk == chunks[1]), "the second write is not Node's second chunk");
        assert!(first.join().unwrap().is_empty());
        assert!(second.join().unwrap().is_empty());
    });
    assert_eq!(fs::read_to_string(&path).unwrap(), golden["jsonl"].as_str().unwrap());
}
