//! Node's git repository write lock cases (`fixtures/repo-locks-cases`, `record-repo-locks-cases.mjs`): each recorded
//! spelling through `path_key` (which spellings share one key), and each order script run through `RepoLocks::acquire`,
//! every snapshot of the events and every write's outcome against Node's. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;
use tokio::task::JoinHandle;

use super::*;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/repo-locks-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Node's `setImmediate` / `Promise.resolve()` checkpoint: every ready task runs until it waits.
async fn settle() {
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
}

async fn run(steps: &[Value], root: Option<&Path>) -> Vec<Value> {
    let locks = RepoLocks::new();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut holds: HashMap<String, oneshot::Sender<()>> = HashMap::new();
    let mut tokens: HashMap<String, CancellationToken> = HashMap::new();
    let mut writes: HashMap<String, JoinHandle<Result<(), String>>> = HashMap::new();
    let mut out = Vec::new();
    let path = |p: &str| -> PathBuf {
        if p == "<upper>" {
            return PathBuf::from(format!("{}\\", root.unwrap().join("Worktree").to_string_lossy().to_uppercase()));
        }
        match p.strip_prefix("<root>") {
            Some(rest) => root.unwrap().join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(p),
        }
    };
    for step in steps {
        let name = step["name"].as_str().unwrap_or_default().to_owned();
        match step["op"].as_str().unwrap() {
            "write" => {
                let repo = path(step["repo"].as_str().unwrap());
                let trees: Option<Vec<PathBuf>> = step["worktrees"].as_array().map(|t| t.iter().map(|p| path(p.as_str().unwrap())).collect());
                let gate = (step["hold"] == true).then(|| {
                    let (tx, rx) = oneshot::channel();
                    holds.insert(name.clone(), tx);
                    rx
                });
                let token = CancellationToken::new();
                if step["signal"] == true {
                    tokens.insert(name.clone(), token.clone());
                }
                let (locks, events, label) = (locks.clone(), events.clone(), name.clone());
                writes.insert(
                    name,
                    tokio::spawn(async move {
                        let refs: Option<Vec<&Path>> = trees.as_ref().map(|t| t.iter().map(PathBuf::as_path).collect());
                        let guard = locks.acquire(&repo, refs.as_deref(), &token).await.map_err(|e| e.to_string())?;
                        match gate {
                            Some(gate) => {
                                events.lock().unwrap().push(format!("{label}:start"));
                                let _ = gate.await;
                                events.lock().unwrap().push(format!("{label}:end"));
                            }
                            None => events.lock().unwrap().push(label),
                        }
                        drop(guard);
                        Ok(())
                    }),
                );
            }
            "settle" | "tick" => settle().await,
            "release" => holds.remove(&name).unwrap().send(()).unwrap(),
            "abort" => tokens[&name].cancel(),
            "await" => {
                let outcome = writes.remove(&name).unwrap().await.unwrap();
                out.push(match outcome {
                    Ok(()) => json!({ "await": name, "ok": true }),
                    Err(error) => json!({ "await": name, "ok": false, "error": error }),
                });
            }
            "snapshot" => out.push(json!({ "events": *events.lock().unwrap() })),
            other => panic!("op {other}"),
        }
    }
    out
}

#[tokio::test]
async fn every_recorded_lock_order_and_key_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let got = match case["kind"].as_str().unwrap() {
            "keys" => {
                std::fs::create_dir_all(dir.path().join("Repo").join(".git")).unwrap();
                let keys: Vec<String> = case["spellings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().replace("<root>", &root))
                    .map(|s| path_key(Path::new(&s)))
                    .collect();
                let groups: Vec<usize> = keys.iter().map(|k| keys.iter().position(|o| o == k).unwrap()).collect();
                json!({ "groups": groups })
            }
            "order" => {
                std::fs::create_dir(dir.path().join("Worktree")).unwrap();
                Value::Array(run(case["steps"].as_array().unwrap(), Some(dir.path())).await)
            }
            other => panic!("kind {other}"),
        };
        if got != case["recorded"] {
            failures.push(format!("{}:\n  want {}\n  got  {got}", case["case"], case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(cases.len(), 8, "every case of the test file is recorded");
}
