//! Node's offload-prune recording (`fixtures/offload-prune-order`, `record-offload-prune-order.mjs`) stored in the core:
//! the recorded session, its sidecars aged as Node's, and what is on disk at each point Node observed (its
//! tool-result directory whole and its stored transcript whole). Used by the session crate's replay
//! (`offload_prune_order_tests.rs`) and by the host's, whose turns run through the product run host.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::Rig;
use super::lock;
use super::offload_store;
use crate::session::SessionDeps;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::run::Compaction;
use crate::session::seams::RunOutcome;
use crate::session::turn_ops::CompactionCommit;
use crate::session::turn_ops::CompactionHeader;

/// `wait`, failing with `what` when it has not ended within ten seconds.
pub async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("no answer within 10s: {what}"))
}

pub fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/offload-prune-order/golden.json")).expect("golden.json parses")
}

/// Node's case `name`.
pub fn node_case(name: &str) -> Value {
    golden()["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no Node case {name}"))
}

/// The recorded session, stored in the core: its transcript, its sidecars aged as Node's, the rig's scripted turns
/// waiting for `release`.
pub struct World {
    pub rig: Rig,
    pub directory: Arc<SessionDirectory>,
    pub handle: Arc<SessionHandle>,
    pub release: Arc<Notify>,
    pub data: tempfile::TempDir,
    pub case: Value,
    /// Each sidecar's role and path.
    pub sidecars: Vec<(String, String)>,
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup ages a fixture file to the recorded mtime")]
fn age(path: &str, mtime_ms: u64) {
    let file = std::fs::File::options().write(true).open(path).expect("the sidecar");
    file.set_modified(std::time::UNIX_EPOCH + Duration::from_millis(mtime_ms)).expect("aged");
}

/// A stored message row as a writer commits it.
pub fn item(iid: String, body: &Value) -> Record {
    let record = json!({
        "k": "item", "iid": iid, "form": "message", "model": true, "visible": true,
        "role": body["role"], "refs": [], "body": { "inline": body },
    });
    serde_json::from_value(record).expect("item record")
}

/// The recording's `<DATA>` named as the data dir `data`.
pub fn unmask(data: &Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    serde_json::from_str(&serde_json::to_string(value).expect("json").replace("<DATA>", &escaped[1..escaped.len() - 1])).expect("unmasked")
}

/// The data dir `data` named `<DATA>`, as the recording names Node's, a turn completion's `attemptId` (a random UUID on
/// both sides) named `<ATTEMPT>` and its `verb` (the client's label, which Node's runtime has none of) `<VERB>`.
fn mask(data: &Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    let mut masked: Value = serde_json::from_str(&serde_json::to_string(value).expect("json").replace(&escaped[1..escaped.len() - 1], "<DATA>")).expect("masked");
    mask_attempts(&mut masked);
    masked
}

fn mask_attempts(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("attemptId") && map.contains_key("status") {
                map.insert("attemptId".into(), json!("<ATTEMPT>"));
                if map.contains_key("verb") {
                    map.insert("verb".into(), json!("<VERB>"));
                }
            }
            map.values_mut().for_each(mask_attempts);
        }
        Value::Array(items) => items.iter_mut().for_each(mask_attempts),
        _ => {}
    }
}

/// The compaction Node adopted, committed as the host commits its compactor's output.
pub fn compaction_of(data: &Path, case: &Value) -> Compaction {
    let compacted = unmask(data, &case["compacted"]);
    let replacement = compacted.as_array().expect("compacted").iter().enumerate().map(|(index, row)| (ItemId::from(format!("compacted{index}")), row.clone())).collect();
    Compaction { replacement, at: golden()["clockMs"].as_i64().expect("clock"), dropped_count: 0, dropped: None }
}

pub fn header() -> CompactionHeader {
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    Box::new(move |_, _| HeaderChange { set, unset: Vec::new() })
}

impl World {
    /// Node's case `name` stored over `rig`, its session opened by a directory over `deps()` (the rig's, or the
    /// rig's with the host's run factory). The opens (the creator's and the session's) list nothing: the sidecars
    /// are written once both listed.
    pub async fn new(name: &str, rig: Rig, deps: impl Fn(&Rig) -> Arc<SessionDeps>) -> World {
        let (golden, case) = (golden(), node_case(name));
        let release: Arc<Notify> = Arc::default();
        let gate = release.clone();
        rig.set_script(Arc::new(move |run| {
            let gate = gate.clone();
            Box::pin(async move {
                within("the turn's input is durable", run.port.input_durable()).await.expect("input durable");
                within("the test releases the turn", gate.notified()).await;
                RunOutcome::Completed(Default::default())
            })
        }));
        let data = tempfile::tempdir().expect("data dir");
        let id = ThreadId::from(case["seed"]["sessionId"].as_str().expect("session id"));
        let clock = golden["clockMs"].as_u64().expect("clock");
        rig.clock.0.store(clock, std::sync::atomic::Ordering::SeqCst);
        let mut listings = rig.compaction.listings.subscribe();
        let creator = SessionDirectory::new(deps(&rig));
        within("the session is created", creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
        let transcript = unmask(data.path(), &case["seed"]["transcript"]);
        rig.store.seed(&id, transcript.as_array().expect("transcript").iter().enumerate().map(|(index, body)| item(format!("seed{index}"), body)).collect());
        let directory = Arc::new(SessionDirectory::new(deps(&rig)));
        let handle = within("the session opens", directory.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
        within("both opens have listed", listings.wait_for(|count| *count >= 2)).await.expect("listings");
        *lock(&rig.compaction.offloads) = Some((data.path().to_path_buf(), clock));
        let store = offload_store(data.path(), &id);
        let mut sidecars = Vec::new();
        for sidecar in case["seed"]["sidecars"].as_array().expect("sidecars") {
            let path = within("the sidecar is written", store.persist(sidecar["content"].as_str().expect("content"))).await.expect("persisted").path;
            age(&path, sidecar["mtimeMs"].as_u64().unwrap_or_else(|| golden["sidecarMtimeMs"].as_u64().expect("mtime")));
            sidecars.push((sidecar["role"].as_str().expect("role").to_owned(), path));
        }
        World { rig, directory, handle, release, data, case, sidecars }
    }

    pub fn path(&self, role: &str) -> &str {
        self.sidecars.iter().find(|(name, _)| name == role).map(|(_, path)| path.as_str()).expect("a role")
    }

    /// The compaction Node adopted, committed on the context it was planned on.
    pub async fn commit(&self) -> Result<CompactionCommit, CoreError> {
        let snapshot = within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context").into_iter().map(|(iid, _)| iid).collect();
        within("the commit answers", self.directory.commit_compaction(&self.handle.id, snapshot, compaction_of(self.data.path(), &self.case), Some(header()))).await
    }

    /// The running turn has ended.
    pub async fn ended(&self) {
        within("the turn ends", crate::eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_none().then_some(()))).await;
    }

    /// What is on disk now, as Node's `point`: the tool-result directory in listing order with each entry's text (null
    /// for a directory; with `mtimes`, each file's mtime), and the stored transcript.
    #[allow(clippy::disallowed_methods, reason = "test reads the sidecar dir")]
    pub async fn point(&self, at: &str, mtimes: bool) -> Value {
        let dir = self.data.path().join("tool-results").join(mixdog_core_run::run_host::artifact::safe_segment(self.handle.id.as_str()));
        let tool_results: Vec<Value> = std::fs::read_dir(dir)
            .expect("the sidecar dir")
            .map(|entry| {
                let entry = entry.expect("an entry");
                let info = entry.metadata().expect("its metadata");
                let text = if info.is_dir() { Value::Null } else { json!(std::fs::read_to_string(entry.path()).expect("a sidecar")) };
                let mut row = vec![json!(entry.file_name().to_string_lossy()), text];
                if mtimes {
                    row.push(json!(info.modified().expect("mtime").duration_since(std::time::UNIX_EPOCH).expect("after the epoch").as_millis() as u64));
                }
                Value::Array(row)
            })
            .collect();
        let rows = within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context");
        let transcript: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
        json!({ "at": at, "toolResults": mask(self.data.path(), &json!(tool_results)), "transcript": mask(self.data.path(), &json!(transcript)) })
    }

    /// Node's case with the core's answer and points in place of Node's.
    pub fn got(&self, changed: Value, error: Value, points: Vec<Value>) -> Value {
        let mut got = self.case.clone();
        got["changed"] = changed;
        got["error"] = error;
        got["points"] = json!(points);
        got
    }
}
