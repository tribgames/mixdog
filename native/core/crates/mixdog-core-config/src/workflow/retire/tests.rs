//! The retirement pass against Node's recording (`fixtures/shipped-retirement/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-shipped-retirement.mjs` from Node's real `ensureStandaloneEnvironment`): over each recorded
//! state the data dir the pass leaves (every file's bytes, the marker, the backup folders), what it throws, and that it logs nothing.

use std::path::Path;

use mixdog_rt::CancellationToken;
use serde_json::Value;

use super::*;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/shipped-retirement/twin.json")).expect("twin.json")
}

fn bytes_of(encoded: &Value) -> Vec<u8> {
    match encoded {
        Value::String(text) => text.as_bytes().to_vec(),
        other => {
            let hex = other["hex"].as_str().expect("hex");
            (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex digit")).collect()
        }
    }
}

fn lay(dir: &Path, files: &serde_json::Map<String, Value>) {
    for (rel, encoded) in files {
        if encoded.is_null() {
            continue;
        }
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(path, bytes_of(encoded)).expect("file");
    }
}

/// Node's `mask`: the timestamp of a backup folder name.
fn mask(path: &str) -> String {
    let tag = "defaults-separation-";
    let mut out = String::new();
    let mut rest = path;
    while let Some(at) = rest.find(tag) {
        out.push_str(&rest[..at + tag.len()]);
        let tail = &rest[at + tag.len()..];
        let stamp: String = tail.chars().take(24).collect();
        let shaped = stamp.len() == 24 && stamp.ends_with('Z') && stamp.starts_with(|c: char| c.is_ascii_digit());
        if shaped {
            out.push_str("<iso>");
            rest = &tail[24..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// Node's `snapshot`: folders as `path/`, files with their bytes, sorted by UTF-16 code units.
fn snapshot(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    fn walk(current: &Path, prefix: &str, out: &mut Vec<(String, Option<Vec<u8>>)>) {
        for entry in std::fs::read_dir(current).expect("read_dir") {
            let entry = entry.expect("entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if entry.file_type().expect("type").is_dir() {
                out.push((format!("{}/", mask(&rel)), None));
                walk(&entry.path(), &rel, out);
            } else {
                out.push((mask(&rel), Some(std::fs::read(entry.path()).expect("read"))));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out);
    out.sort_by_key(|(path, _)| path.encode_utf16().collect::<Vec<u16>>());
    out
}

fn recorded(snapshot: &Value) -> Vec<(String, Option<Vec<u8>>)> {
    snapshot.as_array().expect("snapshot").iter().map(|entry| (entry["path"].as_str().expect("path").to_owned(), entry.get("content").map(bytes_of))).collect()
}

#[tokio::test]
async fn every_recorded_state_leaves_the_data_dir_node_left() {
    let twin = twin();
    let world = twin["world"].as_object().expect("world");
    let states = twin["states"].as_array().expect("states");
    assert!(states.len() > 60, "{} states", states.len());
    for state in states {
        let name = state["name"].as_str().expect("name");
        assert_eq!(state["logs"].as_array().expect("logs").len(), 0, "{name}: Node logs nothing");
        let dir = tempfile::tempdir().expect("dir");
        let (root, data) = (dir.path().join("package"), dir.path().join("data"));
        lay(&root, world);
        for (rel, encoded) in state["root"].as_object().expect("root") {
            if encoded.is_null() {
                std::fs::remove_file(root.join(rel)).expect("removed");
            }
        }
        lay(&root, &state["root"].as_object().expect("root").iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect());
        if state["noDataDir"] != true {
            std::fs::create_dir_all(&data).expect("data");
        }
        lay(&data, state["before"].as_object().expect("before"));
        let mut error = None;
        for (run, after) in state["after"].as_array().expect("after").iter().enumerate() {
            let paths = WorkflowPaths { root: root.clone(), data: data.clone() };
            let outcome = mixdog_core_base::support::on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
                retire_seeded_copies(lane, &paths, &|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            })
            .await
            .expect("lane job");
            error = outcome.err();
            assert_eq!(snapshot(&data), recorded(after), "{name}: run {run}");
        }
        let node = state["error"].as_str().map(|text| text.strip_prefix("TypeError: ").unwrap_or(text).to_owned());
        assert_eq!(error, node, "{name}: what the pass throws");
    }
}
