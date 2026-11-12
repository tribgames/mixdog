//! A reaped agent child read through the core's entries over the 1.4.5 data directory Node b6f10295a answered from
//! (`benchmarks/rust-core/recorders/record-archived-agent.mjs` -> `fixtures/archived-agent`), migrated as the core
//! does at its first start: `thread/read` (the server's fallback after `open` finds no thread), `thread/resume`
//! (`open`), `thread/fork` and `thread/delete`, each set against Node's answer for the same child.

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::call::Reply;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::recorded_145_tests::NoDocuments;
use super::recorded_145_tests::StoreProjector;
use super::recorded_145_tests::threads_over;
use super::testing::Rig;
use super::transcript::RecordTranscript;

fn recording() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/archived-agent/archived-agent.json");
    serde_json::from_slice(&durable::read(&path).expect("the recording")).expect("json")
}

fn request(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }
}

/// The core's answer to `thread/read` of `id` as the server routes it: the opened thread, else the directory's read of a
/// thread that has vanished.
async fn read(directory: &SessionDirectory, id: &str) -> Result<Value, CoreError> {
    let thread = ThreadId::from(id);
    let req = request("thread/read", json!({ "threadId": id }));
    let reply = match directory.open(&thread, &req.ctx).await {
        Ok(handle) => handle.request(req).await,
        Err(CoreError::ThreadNotFound { .. }) => directory.read_vanished(&thread, req).await,
        Err(error) => Err(error),
    }?;
    let Reply::Value(value) = reply else { panic!("thread/read answers a value") };
    Ok(value)
}

/// The core's read set against Node's `readStoredSessionTranscript` answer: no thread for Node's `null`; else Node's one
/// row as the core's item (id, text, time, route labels, status) and Node's route as the read's route and list row.
fn assert_read(id: &str, got: Result<Value, CoreError>, node: &Value) {
    let Some(want) = node.get("value").filter(|v| !v.is_null()) else {
        assert!(matches!(got, Err(CoreError::ThreadNotFound { .. })), "{id}: Node read nothing, the core answered {got:?}");
        return;
    };
    let got = got.unwrap_or_else(|e| panic!("{id}: Node read {want}, the core answered {e:?}"));
    let rows = want["items"].as_array().expect("items");
    let items = got["items"].as_array().expect("items");
    assert_eq!(items.len(), rows.len(), "{id}: {got}");
    for (item, row) in items.iter().zip(rows) {
        assert_eq!(item["type"], "agentMessage", "{id}: {item}");
        assert_eq!(item["id"], row["id"], "{id}");
        assert_eq!(item["text"], row["text"], "{id}");
        let meta = &item["meta"];
        assert_eq!(meta.get("at"), row.get("at"), "{id}");
        for key in ["model", "provider", "agent"] {
            assert_eq!(meta.get(key), row.get(key), "{id}: {key}");
        }
        assert_eq!(meta["ext"]["status"], row["status"], "{id}");
    }
    // The route states a field Node's view leaves empty as absent (null).
    let route = |key: &str| got["state"]["route"].get(key).filter(|v| !v.is_null()).cloned();
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(|s| json!(s));
    assert_eq!(route("sessionProvider"), text(&want["provider"]), "{id}: provider");
    assert_eq!(route("sessionModel"), text(&want["model"]), "{id}: model");
    assert_eq!(route("effort"), text(&want["effort"]), "{id}: effort");
    assert_eq!(route("fast"), Some(want["fast"].clone()), "{id}: fast");
    assert_eq!(route("cwd"), text(&want["cwd"]), "{id}: cwd");
    let desktop = &want["desktopSession"];
    assert_eq!(got["thread"]["classification"], desktop.get("classification").cloned().unwrap_or_else(|| json!({})), "{id}");
    assert_eq!(got["thread"]["projectPath"], desktop.get("projectPath").cloned().unwrap_or(Value::Null), "{id}");
    assert_eq!(got["hasOlder"], false, "{id}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_reaped_agent_child_answers_read_resume_fork_and_delete_as_node() {
    let recorded = recording();
    let dir = tempfile::tempdir().expect("scratch dir");
    let home = dir.path().join(".mixdog");
    let roots = MigrationRoots { data: home.join("data"), home, profile: None };
    for (rel, text) in recorded["files"].as_object().expect("files") {
        let target = roots.data.join(rel);
        durable::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        durable::write_synced(&target, text.as_str().expect("text").as_bytes()).expect("write");
    }
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded data completes");

    let threads = threads_over(&roots.data).await;
    // The model's `session` tool list: Node lists the two parents, newest first, and a reaped child never (with
    // agents, also the child still stored). The core's thread/list over the same migrated data lists what Node's list
    // with agents lists (the session tool's own list action, which hides agents by default, is not in the core).
    let list = super::thread_list::ThreadListService::new(
        Arc::new(threads.index().clone()),
        Arc::new(super::recorded_145_tests::Idle),
        Arc::new(super::recorded_145_tests::NoRooms),
        Arc::new(super::testing::FixedTaskWorkspace("/tasks")),
    );
    let listed = mixdog_core_base::support::testing::value(&list, mixdog_core_base::support::testing::request(super::thread_list::LIST, json!({ "limit": 50 }), None))
        .await
        .expect("thread/list");
    let ids = |rows: &Value| -> Vec<Value> { rows.as_array().expect("rows").iter().map(|row| row["id"].clone()).collect() };
    let tool = &recorded["sessionTool"];
    assert_eq!(ids(&listed["data"]), ids(&tool["listAgents"]["value"]["sessions"]), "{listed}");
    for child in recorded["children"].as_array().expect("children") {
        assert!(!ids(&tool["listAgents"]["value"]["sessions"]).contains(child), "Node lists no reaped child: {child}");
    }

    let rig = Rig::new();
    let mut parts = rig.deps_parts(threads);
    parts.transcript = Arc::new(RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(parts));

    let answers = recorded["answers"].as_object().expect("answers");
    for (id, node) in answers {
        assert_read(id, read(&directory, id).await, &node["transcript"]);
    }
    // The session tool over each child: its read is the archived view the transcript read gives (the orphan, whose one
    // parent is gone, and an id never stored: "not available"), and a send starts nothing ("not available").
    for id in ["sess_child_link", "sess_child_orphan", "sess_never_existed"] {
        let node = &tool[id];
        let gone = json!({ "$exact": "error", "name": "Error", "message": format!("session {id} is not available"), "props": {} });
        match node["read"]["value"]["items"].as_array() {
            Some(items) => {
                let viewed = &answers[id]["transcript"]["value"]["items"];
                for (item, row) in items.iter().zip(viewed.as_array().expect("items")) {
                    assert_eq!((&item["id"], &item["kind"], &item["status"], &item["text"]), (&row["id"], &row["kind"], &row["status"], &row["text"]), "{id}");
                }
                let got = read(&directory, id).await.expect("the archived view");
                assert_eq!(got["items"].as_array().map(Vec::len), Some(items.len()), "{id}");
            }
            None => {
                assert_eq!(node["read"]["threw"], gone, "{id}");
                assert!(matches!(read(&directory, id).await, Err(CoreError::ThreadNotFound { .. })), "{id}");
            }
        }
        assert_eq!(node["send"]["threw"], gone, "{id}");
        // A turn starts only on a thread the directory opens; none opens for these ids.
        let opened = directory.open(&ThreadId::from(id), &CallContext::internal("test")).await.map(|_| ());
        assert!(matches!(opened, Err(CoreError::ThreadNotFound { .. })), "{id}: a send to it starts nothing: {opened:?}");
    }
    let mut entries = 0;
    for (id, node) in answers.iter().filter(|(_, node)| node.get("resume").is_some()) {
        entries += 1;
        // `resumeSession` answers null: the core opens no thread.
        assert_eq!(node["resume"], json!({ "value": null }), "{id}");
        let ctx = CallContext::internal("test");
        let resumed = directory.open(&ThreadId::from(id.as_str()), &ctx).await.map(|_| ());
        assert!(matches!(resumed, Err(CoreError::ThreadNotFound { .. })), "{id}: {resumed:?}");
        // The fork throws the source not found: the core's `threadNotFound`, which the desktop words as Node's error.
        assert_eq!(node["fork"]["threw"]["message"], json!(format!("inheritFrom: session {id} was not found")), "{id}");
        let forked = directory.request(request("thread/fork", json!({ "threadId": id }))).await.map(|_| ());
        assert!(matches!(forked, Err(CoreError::ThreadNotFound { .. })), "{id}: {forked:?}");
        let Reply::Value(deleted) = directory.request(request("thread/delete", json!({ "threadId": id, "opId": format!("op-delete-{id}") }))).await.expect("delete") else {
            panic!("thread/delete answers a value")
        };
        assert_eq!(json!({ "value": deleted }), node["delete"], "{id}");
        assert_read(id, read(&directory, id).await, &node["transcriptAfterDelete"]);
    }
    assert_eq!(entries, 2, "the recording drives the other entries over two children");
}
