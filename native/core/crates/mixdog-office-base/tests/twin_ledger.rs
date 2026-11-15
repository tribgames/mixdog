//! Twin test `ledger`: the recording of Node's `core/office-write-ledger.mjs`
//! (`native/core/fixtures/office-journal/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-journal.mjs`) against [`CallLedger`]: creating, editing and removing a
//! file, a file over the per-file limit or the snapshot budget, a path under the data folder or the temp folder, a
//! directory, repeated, padded and relative paths, and paths that differ in case. Every scenario runs the recorded
//! operations and compares the change list with the recorded one. Re-recording is `twin_live_ledger` (ignored: it runs
//! Node).

use std::io::Write;
use std::path::{Path, PathBuf};

use mixdog_fsio::{OpenOptions, Unlaned};
use mixdog_office_base::ledger::{CallLedger, ChangeSide, FileChange};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn golden() -> Value {
    twin::load_golden("office-journal")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex")).collect()
}

fn side(side: &ChangeSide) -> Value {
    match side {
        ChangeSide::Absent => Value::Null,
        ChangeSide::Bytes(bytes) => {
            let mut entry = json!({ "bytes": bytes.len(), "sha256": hex(&Sha256::digest(bytes)) });
            if bytes.len() <= 64 {
                entry["text"] = Value::from(bytes.iter().map(|byte| char::from(*byte)).collect::<String>());
            }
            entry
        }
        ChangeSide::Uncaptured { size, reason } => json!({ "omitted": true, "size": size, "reason": reason }),
    }
}

fn change(root: &Path, change: &FileChange) -> Value {
    let relative = change.path.strip_prefix(root).expect("under the root").to_string_lossy().replace('\\', "/");
    json!({ "path": relative, "before": side(&change.before), "after": side(&change.after) })
}

fn put(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        mixdog_fsio::create_dir_all(&Unlaned, parent).expect("folder");
    }
    mixdog_fsio::write(&Unlaned, path, bytes).expect("write");
}

fn apply(root: &Path, ledger: &CallLedger, op: &Value) {
    let text = |key: &str| op[key].as_str().unwrap_or_else(|| panic!("{key} of {op}"));
    let at = || -> PathBuf { root.join(text("at")) };
    match text("op") {
        "put" => put(&at(), &op["hex"].as_str().map_or_else(|| text("text").as_bytes().to_vec(), unhex)),
        "sparse" => {
            let path = at();
            mixdog_fsio::create_dir_all(&Unlaned, path.parent().expect("folder")).expect("folder");
            let file = OpenOptions::new().write(true).create(true).open(&Unlaned, &path).expect("open");
            file.set_len(&Unlaned, op["size"].as_u64().expect("size")).expect("set the length");
        }
        "append" => {
            let mut file = OpenOptions::new().append(true).open(&Unlaned, at()).expect("open");
            file.write_all(text("text").as_bytes()).expect("append");
        }
        "mkdir" => mixdog_fsio::create_dir_all(&Unlaned, at()).expect("folder"),
        "rm" => mixdog_fsio::remove_file(&Unlaned, at()).expect("remove"),
        "rmdir" => mixdog_fsio::remove_dir(&Unlaned, at()).expect("remove the folder"),
        "note" => match op["abs"].as_str() {
            Some(abs) => ledger.note_write(&root.join(abs)),
            None => ledger.note_write(Path::new(text("rel"))),
        },
        other => panic!("unknown op {other}"),
    }
}

fn replay(scenario: &Value) -> Option<Value> {
    // Windows compares paths without regard to case; the recording of that scenario holds where the platform agrees.
    if let Some(folding) = scenario["caseFolding"].as_bool()
        && folding != cfg!(windows)
    {
        return None;
    }
    let dir = tempfile::tempdir().expect("root");
    let root = dir.path();
    for folder in ["work", "data", "scratch"] {
        mixdog_fsio::create_dir_all(&Unlaned, root.join(folder)).expect("folder");
    }
    let ledger = CallLedger::new(&root.join("work"), &root.join("data")).expect("ledger");
    for op in scenario["ops"].as_array().expect("ops") {
        apply(root, &ledger, op);
    }
    Some(Value::Array(ledger.changes(&Unlaned).iter().map(|found| change(root, found)).collect()))
}

#[test]
fn every_scenario_reports_the_changes_node_reports() {
    let golden = golden();
    let scenarios = golden["ledger"]["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 9);
    let mut replayed = 0;
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("name");
        if let Some(found) = replay(scenario) {
            assert_eq!(found, scenario["changes"], "scenario {name}");
            replayed += 1;
        }
    }
    assert!(replayed >= scenarios.len() - 1);
}

/// Records again with Node and replays: `cargo test -p mixdog-office-base --test twin_ledger -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-write-ledger.mjs)"]
fn twin_live_ledger() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-journal.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_reports_the_changes_node_reports();
}
