//! The shared lock timing out as Node's `file-lock.mjs` does (`lock_record.mjs`): every recorded case is run through
//! [`locked_on`] on a virtual clock driven as the recorder's (`Date.now()` starts at the recording's instant, a wait is
//! recorded with the delay asked for and moves the clock by it rounded up to a whole millisecond, `Math.random()` is
//! 0.5), with the recording's lock file (no owner, its file time to the nanosecond) at the recording's relative path,
//! and what it did (the waits, the instant it gave up, the error's whole text and code) is compared whole with Node's.
//! The paths are relative to the test's own directory, made the working directory: nextest runs each test in a process
//! of its own.
use std::cell::Cell;
use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;

use mixdog_fsio::ReadProof;
use mixdog_fsio::Unlaned;
use serde_json::Value;
use serde_json::json;

use super::LockClock;
use super::LockOpts;
use super::locked_on;

#[path = "../../mixdog-ai/src/providers/grok/fixture_manifest.rs"]
mod fixture_manifest;

const RECORDER: &str = "native/core/crates/mixdog-statefile/src/lock_record.mjs";

struct Virtual {
    now_ms: Cell<u64>,
    sleeps: RefCell<Vec<Value>>,
}

/// A number of milliseconds as the recording's JSON writes it: a whole number without a fraction.
fn ms_value(ms: f64) -> Value {
    if ms.fract() == 0.0 { json!(ms as u64) } else { json!(ms) }
}

impl LockClock for Virtual {
    fn now_ns(&self) -> i128 {
        i128::from(self.now_ms.get()) * 1_000_000
    }
    fn sleep(&self, _proof: &impl ReadProof, duration: Duration) {
        let ms = duration.as_nanos() as f64 / 1e6;
        self.sleeps.borrow_mut().push(ms_value(ms));
        self.now_ms.set(self.now_ms.get() + ms.ceil() as u64);
    }
    fn draw(&self) -> f64 {
        0.5
    }
}

#[test]
fn every_timeout_case_does_what_nodes_file_lock_did() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let set = repo.join("native/core/fixtures/shared-file-lock");
    fixture_manifest::verify_dir(&repo, &set, RECORDER);
    let recording: Value = serde_json::from_slice(&mixdog_testkit::read(set.join("node-recorded.json"))).unwrap();
    let t = recording["t"].as_u64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::env::set_current_dir(dir.path()).unwrap();
    let mut differing = Vec::new();
    for case in recording["cases"].as_array().unwrap() {
        let lock = Path::new(case["lockPath"].as_str().unwrap());
        mixdog_testkit::create_dir_all(lock.parent().unwrap());
        mixdog_testkit::write(lock, "");
        let mtime_ns: u64 = case["mtimeNs"].as_str().unwrap().parse().unwrap();
        mixdog_fsio::File::options()
            .write(true)
            .open(&Unlaned, lock)
            .unwrap()
            .set_modified(&Unlaned, std::time::UNIX_EPOCH + Duration::from_nanos(mtime_ns))
            .unwrap();
        let clock = Virtual { now_ms: Cell::new(t), sleeps: RefCell::default() };
        let opts = LockOpts { timeout: Some(super::ms_duration(case["timeoutMs"].as_f64().unwrap())), ..Default::default() };
        let outcome = match locked_on(&clock, &Unlaned, lock, &opts, || ()) {
            Ok(()) => json!({ "entered": true }),
            Err(error) => json!({ "message": error.to_string(), "code": error.code() }),
        };
        let core = json!({ "sleeps": clock.sleeps.take(), "atMs": clock.now_ms.get() - t, "outcome": outcome });
        let node = json!({ "sleeps": case["sleeps"], "atMs": case["atMs"], "outcome": case["outcome"] });
        if core != node {
            differing.push(format!("{}:\n  node {node}\n  core {core}", case["name"].as_str().unwrap()));
        }
    }
    std::env::set_current_dir(&repo).unwrap();
    assert!(differing.is_empty(), "{} cases differ from Node:\n{}", differing.len(), differing.join("\n"));
}
