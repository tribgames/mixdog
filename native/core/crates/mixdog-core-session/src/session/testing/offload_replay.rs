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
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
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

/// The recording (`fixtures/offload-prune-order/golden.json`), whose text the calling test reads at run time
/// (`mixdog_testkit::fixture!`).
pub fn golden(text: &str) -> Value {
    serde_json::from_str(text).expect("golden.json parses")
}

/// Node's case `name` of the recording `golden`.
pub fn node_case(golden: &Value, name: &str) -> Value {
    golden["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no Node case {name}"))
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
    /// The recording's clock (`clockMs`).
    pub clock_ms: i64,
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
pub fn compaction_of(data: &Path, case: &Value, clock_ms: i64) -> Compaction {
    let compacted = unmask(data, &case["compacted"]);
    // The compacted transcript's system prompt stays in the header, as the session's own does (`migrated`).
    let rows = compacted.as_array().expect("compacted").iter().filter(|row| row["role"] != "system");
    let replacement = rows.enumerate().map(|(index, row)| (ItemId::from(format!("compacted{index}")), row.clone())).collect();
    Compaction { replacement, at: clock_ms, dropped_count: 0, dropped: None }
}

/// A session Node stored as `transcript` (its whole `messages`), as the migration stores it: the leading system
/// messages become the header's prompt blocks (`migrate_system_messages`), the rows the rest. The header and the rows.
pub fn migrated(transcript: Value) -> (Header, Value) {
    let messages = transcript.as_array().cloned().expect("transcript");
    let mut header = json!({ "cwd": "/ws" }).as_object().cloned().expect("object");
    let system = mixdog_core_prompt::prompt::migrate::migrate_system_messages(&messages, &header).expect("Node's system prefix");
    system.apply(&mut header);
    (header, Value::Array(messages[system.rows_from..].to_vec()))
}

pub fn header() -> CompactionHeader {
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    Box::new(move |_, _| HeaderChange { set, unset: Vec::new() })
}

impl World {
    /// Node's case `name` of the recording `golden` (its text) stored over `rig`, its session opened by a directory
    /// over `deps()` (the rig's, or the rig's with the host's run factory). The opens (the creator's and the
    /// session's) list nothing: the sidecars are written once both listed.
    pub async fn new(name: &str, golden: &str, rig: Rig, deps: impl Fn(&Rig) -> Arc<SessionDeps>) -> World {
        Self::seeded(name, golden, rig, deps, tempfile::tempdir().expect("data dir"), false).await
    }

    /// `new` over a store with one writer per log (the real one, over the data dir `data`): the recorded transcript
    /// is committed through the session by its creator (`thread/inheritedRows/append`, rows of no turn as an
    /// inheritance's or an import's), which then lets the session go before it is opened.
    pub async fn through_session(name: &str, golden: &str, rig: Rig, deps: impl Fn(&Rig) -> Arc<SessionDeps>, data: tempfile::TempDir) -> World {
        Self::seeded(name, golden, rig, deps, data, true).await
    }

    async fn seeded(name: &str, golden: &str, rig: Rig, deps: impl Fn(&Rig) -> Arc<SessionDeps>, data: tempfile::TempDir, through_session: bool) -> World {
        let golden = self::golden(golden);
        let mut case = node_case(&golden, name);
        // The core holds the system prompt in the header's prompt blocks, which carry no message meta: the transcript
        // id Node's compaction stamps on its system message is not compared (manifest `systemMessageMeta`).
        for point in case["points"].as_array_mut().into_iter().flatten() {
            for message in point["transcript"].as_array_mut().into_iter().flatten() {
                if message["role"] == "system" {
                    message.as_object_mut().expect("a message").shift_remove("meta");
                }
            }
        }
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
        let id = ThreadId::from(case["seed"]["sessionId"].as_str().expect("session id"));
        let clock = golden["clockMs"].as_u64().expect("clock");
        rig.clock.0.store(clock, std::sync::atomic::Ordering::SeqCst);
        let mut listings = rig.compaction.listings.subscribe();
        let creator = SessionDirectory::new(deps(&rig));
        let (header, transcript) = migrated(unmask(data.path(), &case["seed"]["transcript"]));
        within("the session is created", creator.create_with_id(id.clone(), header, json!({}))).await.expect("create");
        if through_session {
            let created = within("the session opens", creator.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
            let request = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "threadId": id, "messages": transcript }), op: None, ctx: CallContext::internal("test") };
            within("the transcript is committed", created.request(request)).await.expect("rows appended");
            within("the creator lets the session go", creator.shutdown_for("seeded")).await;
        } else {
            rig.store.seed(&id, transcript.as_array().expect("transcript").iter().enumerate().map(|(index, body)| item(format!("seed{index}"), body)).collect());
        }
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
        World { rig, directory, handle, release, data, case, clock_ms: clock as i64, sidecars }
    }

    pub fn path(&self, role: &str) -> &str {
        self.sidecars.iter().find(|(name, _)| name == role).map(|(_, path)| path.as_str()).expect("a role")
    }

    /// The compaction Node adopted, committed on the context it was planned on.
    pub async fn commit(&self) -> Result<CompactionCommit, CoreError> {
        let snapshot = within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context").into_iter().map(|(iid, _)| iid).collect();
        within("the commit answers", self.directory.commit_compaction(&self.handle.id, snapshot, compaction_of(self.data.path(), &self.case, self.clock_ms), Some(header()))).await
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
        // Node's `messages`: the system prompt (the header's prompt blocks) and the rows. The environment a clear writes
        // for the next request (`sessionStartMetaInjected: false`) Node keeps outside `messages` until that request
        // (`resetSessionBp3Environment`, session-crud.mjs:361): it is not part of them (manifest `clearedEnvironment`).
        let header = within("the header is read", self.directory.try_stored_header(&self.handle.id)).await.expect("header").expect("the session");
        let mut blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header);
        if header.get("sessionStartMetaInjected") == Some(&Value::Bool(false)) {
            blocks.env = None;
        }
        let system = blocks.node_messages();
        let transcript: Vec<Value> = system.into_iter().chain(rows.into_iter().map(|(_, row)| row)).collect();
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
