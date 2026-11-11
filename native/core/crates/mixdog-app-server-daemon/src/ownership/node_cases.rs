//! Node's daemon owner lock cases (`fixtures/daemon-owner-lock-cases`, `record-daemon-owner-lock-cases.mjs`): each case's
//! steps through the core's [`acquire`], in this process and in contender processes (this test binary re-run as
//! [`contender`]: it acquires, reports `{"held":..}`, then holds what it got until killed), every observed value against
//! Node's, in order. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test: fixture files and contender processes")]

use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Read as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;

use mixdog_core_api::domain::ownership::Ownership;
use serde_json::Value;
use serde_json::json;

use super::*;

const CONTENDER_ENV: &str = "MIXDOG_OWNER_LOCK_CONTENDER";

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/daemon-owner-lock-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The contender process: run only when re-invoked with the data dir in [`CONTENDER_ENV`].
#[test]
fn contender() {
    let Ok(data) = std::env::var(CONTENDER_ENV) else { return };
    let lock = acquire(Path::new(&data));
    println!("{}", json!({ "held": lock.is_ok() }));
    let _held = lock;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

struct Contender {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Contender {
    fn start(data: &Path) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["ownership::node_cases::contender", "--exact", "--nocapture", "--test-threads=1"])
            .env(CONTENDER_ENV, data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdout }
    }

    fn verdict(&mut self) -> Value {
        let mut line = String::new();
        loop {
            line.clear();
            assert!(self.stdout.read_line(&mut line).unwrap() > 0, "contender exited before answering");
            // libtest prints `test <name> ... ` before the test's own output, on the same line.
            if let Some(start) = line.find("{\"held\"") {
                return serde_json::from_str(line[start..].trim()).unwrap();
            }
        }
    }

    fn kill(&mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let mut stderr = String::new();
        let _ = self.child.stderr.take().unwrap().read_to_string(&mut stderr);
        stderr
    }
}

impl Drop for Contender {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Fixtures {
    root: tempfile::TempDir,
    n: usize,
}

impl Fixtures {
    /// A new data dir (not created) and its lock file path.
    fn next(&mut self) -> (PathBuf, PathBuf) {
        self.n += 1;
        let data = self.root.path().join(format!("fx-{}", self.n)).join("data");
        let lock = data.join(LOCK_FILE);
        (data, lock)
    }
}

fn holders(data: &Path) -> Value {
    let mut racers: Vec<Contender> = (0..4).map(|_| Contender::start(data)).collect();
    json!(racers.iter_mut().map(Contender::verdict).filter(|verdict| verdict["held"] == true).count())
}

fn replay(name: &str, fx: &mut Fixtures) -> Vec<Value> {
    let mut seen = Vec::new();
    let mut see = |what: &str, value: Value| seen.push(json!({ "what": what, "value": value }));
    match name {
        "a held lock refuses every other process, and a SIGKILLed holder frees it at once" => {
            let (data, _) = fx.next();
            let mut holder = Contender::start(&data);
            see("holder", holder.verdict());
            see("this process", json!(acquire(&data).is_ok()));
            let mut second = Contender::start(&data);
            see("second contender", second.verdict());
            let stderr = holder.kill();
            see("holder stderr has an ExperimentalWarning", json!(stderr.contains("ExperimentalWarning")));
            let next = acquire(&data);
            see("this process after the kill", json!(next.is_ok()));
        }
        "the holder opening, reading and closing the lock file (as a hosted Read tool would) keeps the lock" => {
            let (data, path) = fx.next();
            let lock = acquire(&data);
            see("this process", json!(lock.is_ok()));
            see("read bytes", json!(std::fs::read(&path).unwrap().len()));
            drop(std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap());
            see("contender", Contender::start(&data).verdict());
            see("intact", json!(lock.unwrap().revalidate().is_ok()));
        }
        "simultaneous acquisitions leave exactly one holder" => {
            let (data, _) = fx.next();
            see("holders of 4", holders(&data));
        }
        "data dirs whose lock files hold equal bytes (empty, or copied) are locked independently" => {
            for seed in ["empty", "copied"] {
                let (first, first_lock) = fx.next();
                let (second, second_lock) = fx.next();
                if seed == "empty" {
                    std::fs::create_dir_all(&first).unwrap();
                    std::fs::create_dir_all(&second).unwrap();
                    std::fs::write(&first_lock, "").unwrap();
                    std::fs::write(&second_lock, "").unwrap();
                }
                let mut holder = Contender::start(&first);
                see(&format!("{seed}: holder of the first"), holder.verdict());
                if seed == "copied" {
                    std::fs::create_dir_all(&second).unwrap();
                    std::fs::copy(&first_lock, &second_lock).unwrap();
                }
                let lock = acquire(&second);
                see(&format!("{seed}: this process on the second"), json!(lock.is_ok()));
            }
        }
        "racing daemons on an existing lock file leave exactly one holder" => {
            let (data, path) = fx.next();
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(&path, "").unwrap();
            see("holders of 4", holders(&data));
        }
        "one process holds it once; release frees it; intact() follows the locked file at its path" => {
            let (data, path) = fx.next();
            let lock = acquire(&data).ok();
            see("this process", json!(lock.is_some()));
            see("a second acquisition here", json!(acquire(&data).is_ok()));
            let lock = lock.unwrap();
            see("intact", json!(lock.revalidate().is_ok()));
            let removed = std::fs::remove_file(&path).is_ok();
            see("deleted", json!(removed));
            see("exists", json!(path.exists()));
            see("intact after the delete", json!(lock.revalidate().is_ok()));
            if !removed {
                drop(lock);
                see("this process after the release", json!(acquire(&data).is_ok()));
            }
        }
        other => panic!("{other}: no replay and no exclusion"),
    }
    seen
}

#[test]
fn every_replayed_owner_lock_case_observes_what_node_observes() {
    if std::env::var(CONTENDER_ENV).is_ok() {
        return;
    }
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let mut fx = Fixtures { root: tempfile::tempdir().unwrap(), n: 0 };
    let mut replayed = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        assert!(!excluded.contains_key(name), "{name} is recorded and excluded");
        assert_eq!(Value::Array(replay(name, &mut fx)), case["observed"], "{name}");
        replayed += 1;
    }
    assert_eq!(replayed + excluded.len(), 8, "every case of the Node test");
}
