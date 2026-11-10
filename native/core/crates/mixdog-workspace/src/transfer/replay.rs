//! Node's download service replayed on the transfer table: the recording `fixtures/file-downloads/file-downloads.json`
//! (`record-file-downloads.mjs`, b6f10295a), every step of it that reaches the table (the checks of the phone's arguments and of the
//! conversation it names are the desktop adapter's, replayed by `remote-protocol-files`' own test). A call's answer is compared whole,
//! as the frame Node's phone received, with the random ids and versions bound to the recording's tokens at first sight; the clock
//! moves only by the recording's `advance` steps.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use serde_json::Value;
use serde_json::json;

use super::*;

const RECORDING: &str = include_str!("../../../../fixtures/file-downloads/file-downloads.json");

struct Manual(AtomicI64);

impl WallClock for Manual {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The frame Node's phone received, less its id.
fn frame_of(outcome: WsResult<Value>) -> Value {
    match outcome {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => match error.reason {
            Reason::DownloadExpired | Reason::Download(_) => json!({ "ok": false, "error": error.message, "errorCode": error.reason.code() }),
            _ => json!({ "ok": false, "error": error.message }),
        },
    }
}

/// Binds the recording's `<kind#n>` tokens to the values this run made, and checks every later sighting against them.
#[derive(Default)]
struct Tokens(std::collections::HashMap<String, String>);

impl Tokens {
    fn token(text: &str) -> bool {
        text.starts_with('<') && text.ends_with('>') && text.contains('#') && !text.contains('/')
    }

    /// `recorded` against `got`: equal, with each token bound to (or equal to) the value at its place.
    fn same(&mut self, recorded: &Value, got: &Value, at: &str) {
        match (recorded, got) {
            (Value::String(token), Value::String(actual)) if Self::token(token) => {
                let bound = self.0.entry(token.clone()).or_insert_with(|| actual.clone());
                assert_eq!(bound, actual, "{at}: {token}");
            }
            (Value::Object(r), Value::Object(g)) => {
                assert_eq!(r.keys().collect::<std::collections::BTreeSet<_>>(), g.keys().collect::<std::collections::BTreeSet<_>>(), "{at}");
                for (key, value) in r {
                    self.same(value, &g[key], &format!("{at}.{key}"));
                }
            }
            _ => assert_eq!(recorded, got, "{at}"),
        }
    }

    /// A recorded argument: a token is the value it was bound to.
    fn resolve(&self, value: &Value) -> Value {
        match value {
            Value::String(text) if Self::token(text) => json!(self.0.get(text).unwrap_or_else(|| panic!("{text} is not bound"))),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.resolve(item)).collect()),
            other => other.clone(),
        }
    }
}

struct World {
    dir: PathBuf,
    transfers: Arc<Transfers>,
    clock: Arc<Manual>,
    tokens: Tokens,
}

impl World {
    fn path(&self, text: &str) -> PathBuf {
        self.dir.join(text.replace("<dir>/", ""))
    }

    fn owner(device: &str) -> &str {
        match device {
            "phone" => "aaaaaaa1",
            "tablet" => "bbbbbbb2",
            other => other,
        }
    }

    /// What the table is asked for one recorded call; `None` for a call whose answer is the desktop adapter's alone.
    fn call(&self, device: &str, method: &str, params: &Value) -> Option<WsResult<Value>> {
        let owner = Self::owner(device);
        let params = self.tokens.resolve(params);
        let t = &self.transfers;
        let text = |at: usize| params[at].as_str().unwrap_or_default().to_owned();
        Some(match method {
            "fileDownloadAuthorize" => {
                let request = &params[0];
                let source = &request["source"];
                if source["sessionId"] != "s1" && source["sessionId"] != "s2" {
                    return None;
                }
                let project = self.dir.join("project");
                let project = (source["sessionId"] == "s1").then(|| canonical(&project).unwrap());
                let mark = t.mark(owner);
                let opened = match source["kind"].as_str()? {
                    "project" => match &project {
                        Some(root) => open_project_download(root, source["relPath"].as_str()?),
                        None => return None,
                    },
                    _ => open_session_download(&self.path(source["path"].as_str()?).to_string_lossy(), project.as_deref(), project.as_deref()),
                };
                opened.and_then(|file| t.authorize(owner, mark, file)).map(|granted| json!(granted))
            }
            "fileDownloadBegin" => t.begin_grant(owner, &text(0)).map(|leased| json!(leased)),
            "fileDownloadRange" => {
                let (offset, length) = (params[1].as_u64()?, params[2].as_u64()?);
                if length == 0 || length > RANGE_MAX_BYTES || offset > DOWNLOAD_MAX_BYTES {
                    return None;
                }
                t.read_range(&[owner], &text(0), offset, length, params[3].as_str()).map(|range| json!(range))
            }
            "fileDownloadFinish" => t.finish_read(owner, &text(0)).map(|finished| json!(finished)),
            "fileDownloadAbort" => Ok(json!(t.end_read(&[owner], &text(0)))),
            other => panic!("{other}"),
        })
    }

    fn file(&self, step: &Value) {
        let target = self.dir.join(step["file"].as_str().unwrap_or_default());
        match step["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, step["text"].as_str().unwrap()).unwrap();
            }
            "append" => {
                use std::io::Write;
                std::fs::OpenOptions::new().append(true).open(&target).unwrap().write_all(step["text"].as_str().unwrap().as_bytes()).unwrap();
            }
            "size" => std::fs::OpenOptions::new().write(true).open(&target).unwrap().set_len(step["bytes"].as_u64().unwrap()).unwrap(),
            "remove" => drop(std::fs::remove_file(&target)),
            "mkdir" => std::fs::create_dir_all(&target).unwrap(),
            _ => unreachable!(),
        }
    }
}

/// Whether the recorded answer to a call is one the table gives (argument and conversation refusals are the adapter's).
fn table_answer(frame: &Value) -> bool {
    frame["ok"] == true || frame["errorCode"].is_string() || frame["error"] == "offset is past the end of the file."
}

#[test]
fn every_recorded_step_that_reaches_the_table_answers_as_nodes_service_did() {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let start = recording["clockStart"].as_i64().unwrap();
    let mut compared = 0;
    let mut unreachable_by_table = 0;
    for scenario in recording["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(Manual(AtomicI64::new(start)));
        let transfers = Arc::new(Transfers::default());
        transfers.set_wall(clock.clone());
        let mut world = World { dir: canonical(dir.path()).unwrap(), transfers, clock, tokens: Tokens::default() };
        for folder in ["project", "task", "outside"] {
            std::fs::create_dir_all(world.dir.join(folder)).unwrap();
        }
        let steps = scenario["steps"].as_array().unwrap();
        let mut at = 0;
        while at < steps.len() {
            let step = &steps[at];
            at += 1;
            let label = format!("{name} #{at}");
            match step["op"].as_str().unwrap() {
                "write" | "append" | "size" | "remove" | "mkdir" => world.file(step),
                "advance" => {
                    world.clock.0.fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
                }
                "revokeDevice" => world.transfers.revoke_owner(World::owner(step["deviceId"].as_str().unwrap())),
                "revokeAll" => world.transfers.revoke_all(),
                "call" => {
                    let frame = &step["frame"];
                    let (device, method) = (step["device"].as_str().unwrap(), step["method"].as_str().unwrap());
                    if !table_answer(frame) {
                        unreachable_by_table += 1;
                        continue;
                    }
                    let Some(outcome) = world.call(device, method, &step["params"]) else {
                        unreachable_by_table += 1;
                        continue;
                    };
                    let mut recorded = frame.clone();
                    recorded.as_object_mut().unwrap().remove("id");
                    world.tokens.same(&recorded, &frame_of(outcome), &label);
                    compared += 1;
                }
                // A call held at a point of the table while the device is revoked: hold, send, revoke, release, answer.
                "hold" => {
                    let point = match step["gate"].as_str().unwrap() {
                        "read" => "read.read",
                        "stat" => "begin.verify",
                        "afterResolve" => "authorize.opened",
                        other => panic!("{other}"),
                    };
                    let sent = &steps[at];
                    let revoke = &steps[at + 1];
                    let answer = &steps[at + 3];
                    assert_eq!((sent["op"].as_str(), revoke["op"].as_str(), answer["op"].as_str()), (Some("send"), Some("revokeDevice"), Some("answer")));
                    let owner = World::owner(revoke["deviceId"].as_str().unwrap()).to_owned();
                    let table = world.transfers.clone();
                    *world.transfers.pause.lock().unwrap() = Some(Arc::new(move |reached: &str| {
                        if reached == point {
                            table.revoke_owner(&owner);
                        }
                    }));
                    let outcome = world.call(sent["device"].as_str().unwrap(), sent["method"].as_str().unwrap(), &sent["params"]).unwrap();
                    *world.transfers.pause.lock().unwrap() = None;
                    let mut recorded = answer["frame"].clone();
                    recorded.as_object_mut().unwrap().remove("id");
                    world.tokens.same(&recorded, &frame_of(outcome), &label);
                    compared += 1;
                    at += 4;
                }
                other => panic!("{label}: {other}"),
            }
        }
    }
    // The rest are the adapter's: arguments and the conversations a request names (`remote-protocol-files`' replay compares them).
    assert_eq!((compared, unreachable_by_table), (171, 32));
}
