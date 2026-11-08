#![allow(clippy::disallowed_types, reason = "test setup")]
#![allow(clippy::disallowed_methods, reason = "test setup")]
//! DS-WS-2/3/4/5/6/9 against the service with mock feeds and mock processes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::Origin;
use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::recovery::Action;
use mixdog_workspace::recovery::PreparedFile;
use mixdog_workspace::recovery::RecoveryStore;
use mixdog_store::state::CoreState;
use mixdog_workspace::service::Deps;
use mixdog_workspace::zip::TrackedFiles;
use mixdog_workspace::service::WorkspaceService;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    service: Arc<WorkspaceService>,
    state: CoreState,
    limits: MockLimits,
}

fn env() -> Env {
    env_with(None)
}

fn env_with(turn_review: Option<Arc<dyn mixdog_core_api::turn_review::TurnReviewApi>>) -> Env {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(root.join("readme.md"), "# hi\n").unwrap();
    let limits = MockLimits::default();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("core.sqlite")).unwrap();
    let service = WorkspaceService::new(Deps {
        lanes: Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        },
        feeds: Arc::new(MockScopedFeeds::new(limits)),
        processes: Arc::new(MockProcessManager::default()),
        tracked: Arc::new(GitCli),
        state: state.clone(),
        recovery_dir: base.join("recovery"),
        user_data_dir: base.join("userData"),
        sources: vec![Arc::new(FixedSource(base.join("export.bin")))],
        code_graph: Some(Arc::new(EchoGraph)),
        turn_review,
        releases: mixdog_workspace::release::FolderReleases::new(),
    })
    .unwrap();
    // Registered as a row: `project/create` also leaves `.mixdog/project.id` in the folder, which
    // the recorded folder listings of this project do not have.
    let row = mixdog_store::state::ProjectRow { path: root.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None };
    futures_block(state.write(move |tx| tx.put_project(&row))).unwrap();
    Env { _dir: dir, root, service, state, limits }
}

fn request(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(1), Origin::Relay, CancellationToken::new()) }
}

async fn call(env: &Env, method: &'static str, params: Value) -> Result<Value, CoreError> {
    match env.service.call(request(method, params)).await? {
        Reply::Value(v) => Ok(v),
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    }
}

struct NoneGone;

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for NoneGone {
    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}

/// The paired device's side of the spec's `transfer/*` (SPEC.md R44): a path outside every project is described
/// with a one-file grant (`transfer/grant/mint`), which `transfer/beginRead` redeems for exactly that file; the
/// request is a relay connection (origin Relay), paired as "phone-1".
#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_reads_one_granted_file_outside_its_projects_and_nothing_else() {
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join("granted-outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hi\n").unwrap();
    std::fs::write(outside.join("other.txt"), "secret\n").unwrap();

    // Outside every project: the row Node's `resolveLocalPaths` answers, with a grant.
    let minted = call(&env, "transfer/grant/mint", json!({ "path": outside.join("note.txt").to_string_lossy() })).await.unwrap();
    assert_eq!(minted["relPath"], "note.txt");
    assert_eq!(minted["projectPath"], outside.to_string_lossy().as_ref());
    assert_eq!((minted["name"].clone(), minted["size"].clone(), minted["dir"].clone()), (json!("note.txt"), json!(3), json!(false)));
    let token = minted["accessToken"].as_str().unwrap().to_owned();
    // Inside a registered project: the project and path, no grant.
    let inside = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy() })).await.unwrap();
    assert_eq!((inside["projectPath"].clone(), inside["relPath"].clone()), (json!(env.root.to_string_lossy()), json!("a.txt")));
    assert!(inside.get("accessToken").is_none());
    // A conversation's attachment is always granted.
    let attachment = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy(), "sessionId": "s1" })).await.unwrap();
    assert!(attachment["accessToken"].is_string());

    let source = |rel: &str, token: &str| json!({ "source": { "kind": "granted", "accessToken": token, "projectPath": outside.to_string_lossy(), "relPath": rel } });
    let began = call(&env, "transfer/beginRead", source("note.txt", &token)).await.unwrap();
    assert_eq!(began["size"], 3);
    let range = call(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 3 })).await.unwrap();
    assert_eq!(range["data"], "aGkK");
    // The editor calls over the same grant answer as they do for a project file (Node's `readProjectTextFileAuthorized` and
    // `statProjectFileIn` over `remoteFileTarget`): the phone sends `(projectPath, relPath, accessToken)` as `root`, `rel`, `accessToken`.
    let text = call(&env, "projectFs/readText", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": token })).await.unwrap();
    let project_file = call(&env, "projectFs/readText", json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" })).await.unwrap();
    let keys = |value: &Value| value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys(&text), keys(&project_file), "the same reply shape as a project file's");
    assert_eq!((text["content"].clone(), text["binary"].clone(), text["tooLarge"].clone()), (json!("hi\n"), json!(false), json!(false)));
    let stat = call(&env, "projectFs/stat", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": token })).await.unwrap();
    assert_eq!((stat["size"].clone(), stat["directory"].clone()), (json!(3), json!(false)));
    let wrong = call(&env, "projectFs/readText", json!({ "root": outside.to_string_lossy(), "rel": "other.txt", "accessToken": token })).await;
    assert!(format!("{wrong:?}").contains("The selected-file permission does not match this path."), "{wrong:?}");
    let missing = call(&env, "projectFs/stat", json!({ "root": outside.to_string_lossy(), "rel": "note.txt", "accessToken": "not-a-token" })).await;
    assert!(format!("{missing:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{missing:?}");
    // The grant names one exact file, and a token that was never issued opens nothing.
    let other = call(&env, "transfer/beginRead", source("other.txt", &token)).await;
    assert!(format!("{other:?}").contains("The selected-file permission does not match this path."), "{other:?}");
    let unknown = call(&env, "transfer/beginRead", source("note.txt", "not-a-token")).await;
    assert!(format!("{unknown:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{unknown:?}");
    // Without a grant a relay connection reads no absolute path.
    let plain = call(&env, "transfer/beginRead", json!({ "source": { "kind": "localFile", "path": outside.join("other.txt").to_string_lossy() } })).await;
    assert!(matches!(plain, Err(CoreError::PermissionDenied { .. })), "{plain:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_connection_reads_any_absolute_folder_while_a_relay_is_held_to_the_projects() {
    let env = env();
    let outside = env.root.parent().unwrap().join("unregistered");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hello\n").unwrap();
    let params = json!({ "root": outside.to_string_lossy(), "rel": "note.txt" });
    // The `…In` operations of Node take any root the window resolved; the relay is the strict origin.
    assert!(matches!(call(&env, "projectFs/readText", params.clone()).await, Err(CoreError::PermissionDenied { .. })));
    let mut local = request("projectFs/readText", params.clone());
    local.ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    let Reply::Value(read) = env.service.call(local).await.unwrap() else { panic!("readText answers with a value") };
    assert_eq!(read["content"], "hello\n");
    let mut stat = request("projectFs/stat", params);
    stat.ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    let Reply::Value(stat) = env.service.call(stat).await.unwrap() else { panic!("stat answers with a value") };
    assert_eq!(stat["directory"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_staged_upload_is_named_uniquely_and_a_path_range_needs_no_transfer() {
    let env = env();
    let mut published = Vec::new();
    for _ in 0..2 {
        let began = call(&env, "transfer/beginWrite", json!({ "name": "dir\\b.txt", "size": 2, "scope": "draft1" })).await.unwrap();
        assert_eq!(began["uploadId"], began["transferId"]);
        assert_eq!(began["chunkBytes"], 2 * 1024 * 1024);
        let id = began["transferId"].as_str().unwrap().to_owned();
        call(&env, "transfer/writeChunk", json!({ "transferId": id, "offset": 0, "bytesB64": "aGk=" })).await.unwrap();
        let done = call(&env, "transfer/commit", json!({ "transferId": id })).await.unwrap();
        assert_eq!(std::fs::read(done["absolutePath"].as_str().unwrap()).unwrap(), b"hi");
        published.push(done["name"].as_str().unwrap().to_owned());
    }
    assert_eq!(published, ["b.txt", "b (2).txt"]);
    let bad = call(&env, "transfer/beginWrite", json!({ "name": "x", "size": 2, "scope": "../up" })).await;
    assert!(matches!(bad, Err(CoreError::InvalidParams { .. })));

    let root = env.root.to_string_lossy().into_owned();
    let range = call(&env, "transfer/readRange", json!({ "root": root, "rel": "a.txt", "offset": 0, "length": 3 })).await.unwrap();
    assert_eq!(range["data"], "b25l");
    assert_eq!(range["offset"], 0);
    assert!(range["size"].as_u64().unwrap() >= 3 && range["mtimeMs"].is_number());
}

#[tokio::test(flavor = "multi_thread")]
async fn stat_local_reports_a_failure_per_path() {
    let env = env();
    let present = env.root.join("a.txt");
    let missing = env.root.join("missing.txt");
    let listed = call(&env, "projectFs/statLocal", json!({ "paths": [present.to_string_lossy(), missing.to_string_lossy()] }))
        .await
        .unwrap();
    assert_eq!(listed[0]["name"], "a.txt");
    assert!(listed[1]["error"].is_string(), "a path that cannot be read carries its own error: {listed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_writes_with_one_expected_content_have_one_winner() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let write = |content: &'static str| {
        let params = json!({ "root": root, "rel": "a.txt", "content": content, "expectedContent": "one\n" });
        call(&env, "projectFs/writeText", params)
    };
    let (a, b) = tokio::join!(write("from a\n"), write("from b\n"));
    let results = [a, b];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let failed = results.iter().find_map(|r| r.as_ref().err()).unwrap();
    assert!(matches!(failed, CoreError::PreconditionFailed { .. }), "{failed:?}");
}

fn with_op(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest { op: Some(mixdog_core_api::ids::OpId::from(op)), ..request(method, params) }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_mutation_records_its_op_and_a_repeat_answers_from_the_record() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let params = json!({ "root": root, "rel": "a.txt", "content": "two\n", "expectedContent": "one\n" });
    let op = "0190a000-0000-7000-8000-000000000001";
    let first = env.service.call(with_op("projectFs/writeText", params.clone(), op)).await.unwrap();
    let Reply::Value(first) = first else { panic!() };
    let row = env.state.op("projectFs", op).await.unwrap().expect("op row");
    assert_eq!(row.state, mixdog_store::state::OpRowState::Applied);
    assert_eq!(row.method, "projectFs/writeText");
    // The same op id and payload again: answered from the record, nothing re-executed.
    std::fs::write(env.root.join("a.txt"), "changed elsewhere\n").unwrap();
    let again = env.service.call(with_op("projectFs/writeText", params.clone(), op)).await.unwrap();
    let Reply::Value(again) = again else { panic!() };
    assert_eq!(again, first);
    assert_eq!(std::fs::read_to_string(env.root.join("a.txt")).unwrap(), "changed elsewhere\n");
    // The same id with another payload conflicts.
    let other = json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "changed elsewhere\n" });
    let err = env.service.call(with_op("projectFs/writeText", other, op)).await.unwrap_err();
    assert!(matches!(err, CoreError::OpIdConflict { .. }), "{err:?}");
    // A refused mutation is recorded rejected.
    let refused = json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "stale" });
    let op2 = "0190a000-0000-7000-8000-000000000002";
    assert!(env.service.call(with_op("projectFs/writeText", refused, op2)).await.is_err());
    assert_eq!(env.state.op("projectFs", op2).await.unwrap().unwrap().state, mixdog_store::state::OpRowState::Rejected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_registry_change_and_its_op_row_commit_in_one_transaction() {
    let env = env();
    let other = env.root.parent().unwrap().join("second");
    std::fs::create_dir_all(&other).unwrap();
    let op = "0190a000-0000-7000-8000-000000000003";
    env.service.call(with_op("project/create", json!({ "path": other.to_string_lossy() }), op)).await.unwrap();
    assert_eq!(env.state.op("project", op).await.unwrap().unwrap().state, mixdog_store::state::OpRowState::Applied);
    assert_eq!(env.state.projects().await.unwrap().len(), 2);
}

/// Node's `addProject` / `touchProjectSelected` leave `<project>/.mixdog/project.id` (memory
/// classification reads only that); the `markers` of the recorded registry cases, replayed through
/// `project/create` and, for a project registered without one, `project/touch`.
#[tokio::test(flavor = "multi_thread")]
async fn project_create_and_touch_leave_the_project_id_marker_node_leaves() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/store/registry/projects-registry.json")).unwrap();
    let env = env();
    let base = env.root.parent().unwrap().join("markers");
    let mut checked = 0;
    for case in golden["cases"].as_array().unwrap() {
        let expected = case["markers"].as_object().unwrap();
        if expected.is_empty() {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        for phase in ["create", "touch"] {
            let root = base.join(phase).join(name);
            for sub in case["dirs"].as_array().unwrap() {
                std::fs::create_dir_all(root.join(sub.as_str().unwrap())).unwrap();
            }
            let root_text = root.to_string_lossy().into_owned();
            for op in case["ops"].as_array().unwrap().iter().filter(|op| op["op"] == "add") {
                let raw = op["path"].as_str().unwrap().replace("<ABS>", &root_text);
                if raw.is_empty() {
                    continue;
                }
                let path = if std::path::Path::new(&raw).is_absolute() { raw } else { root.join(raw).to_string_lossy().into_owned() };
                if phase == "create" {
                    call(&env, "project/create", json!({ "path": path })).await.unwrap();
                } else {
                    let real = canonical(std::path::Path::new(&path)).unwrap().to_string_lossy().into_owned();
                    env.state
                        .write(move |tx| {
                            tx.put_project(&mixdog_store::state::ProjectRow {
                                path: real,
                                alias: None,
                                hidden: false,
                                hidden_rank: None,
                                last_used_at: None,
                            })
                        })
                        .await
                        .unwrap();
                    call(&env, "project/touch", json!({ "path": path })).await.unwrap();
                }
            }
            for (sub, text) in expected {
                let marker = std::fs::read_to_string(root.join(sub).join(".mixdog").join("project.id")).unwrap_or_default();
                assert_eq!(marker, text.as_str().unwrap(), "{name} ({phase}): marker of {sub}");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 6, "three recorded markers, each through create and touch");
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_outside_the_registry_or_project_are_refused_with_permission_denied() {
    let env = env();
    let outside = env.root.parent().unwrap().join("other");
    std::fs::create_dir_all(&outside).unwrap();
    let denied = |r: Result<Value, CoreError>| matches!(r, Err(CoreError::PermissionDenied { origin: Origin::Relay, .. }));
    assert!(denied(call(&env, "projectFs/listDir", json!({ "root": outside.to_string_lossy(), "rel": "." })).await));
    let root = env.root.to_string_lossy().into_owned();
    assert!(denied(call(&env, "projectFs/readText", json!({ "root": root, "rel": "../other/x" })).await));
    let ok = call(&env, "projectFs/listDir", json!({ "root": root, "rel": "." })).await.unwrap();
    assert_eq!(ok[0]["name"], "src");
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupted_batch_is_listed_inspected_and_restored_to_the_pre_image() {
    let env = env();
    let base = env.root.parent().unwrap().join("crash-store");
    let store = RecoveryStore::new(base.clone());
    let file = env.root.join("a.txt");
    let journal = store
        .begin(
            &env.root,
            vec![PreparedFile {
                rel_path: "a.txt".into(),
                destination: canonical(&file).unwrap(),
                parent: mixdog_workspace::recovery::identity_of(&env.root).unwrap(),
                mode: 0,
                before: b"one\n".to_vec(),
                after: b"two\n".to_vec(),
            }],
        )
        .unwrap();
    std::fs::write(&file, "two\n").unwrap(); // the write that was in flight when the core died
    store.release(&journal.directory).unwrap();
    drop(store);

    let restarted = RecoveryStore::new(base);
    let listed = restarted.list(&env.root).unwrap();
    assert_eq!(serde_json::to_value(&listed[0]).unwrap()["phase"], "interrupted");
    let detail = restarted.execute(&env.root, Action::Inspect { id: listed[0].id.clone() }).unwrap().detail.unwrap();
    assert_eq!(serde_json::to_value(&detail.files[0]).unwrap()["status"], "written");
    restarted.execute(&env.root, Action::Restore { id: listed[0].id.clone(), revision: detail.revision }).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_pushes_batched_changes_and_connection_close_drops_the_os_watch() {
    let env = env();
    // No event can reach the watcher before the watch exists, so every flush is at least a window after this instant.
    let began = std::time::Instant::now();
    let reply = env
        .service
        .call(request("fs/watch", json!({ "watchId": "w1", "path": env.root.to_string_lossy(), "recursive": true })))
        .await
        .unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("fs/watch must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    assert_eq!(attached.decision.mode, AttachMode::Snapshot);
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    assert_eq!(env.service.open_os_watches(), 1);
    for i in 0..300 {
        std::fs::write(env.root.join(format!("t{i}.txt")), "x").unwrap();
    }
    // Until every path has been announced; the batches are counted below.
    let covered = |texts: &[String]| {
        let all = texts.iter().filter(|f| f.contains("fs/changed")).cloned().collect::<Vec<_>>().join("");
        (0..300).all(|i| all.contains(&format!("t{i}.txt")))
    };
    let frames: Vec<String> = conn.drain_text_until(covered).await.into_iter().filter(|f| f.contains("fs/changed")).collect();
    // A batch is flushed one window after the first event it holds and the next batch starts after that flush, so n
    // notifications need n windows. The count is bounded by how long the burst took, whatever the disk's speed; a watcher that
    // announced each event on its own would send hundreds in the same time.
    let windows = began.elapsed().as_millis() / u128::from(mixdog_workspace::watch::BATCH_WINDOW_MS);
    assert!(!frames.is_empty() && frames.len() as u128 <= windows, "{} notifications in {windows} windows", frames.len());
    let all = frames.join("");
    assert!((0..300).all(|i| all.contains(&format!("t{i}.txt"))), "every path is covered");
    env.service.connection_closed(&ConnectionId(1));
    assert_eq!(env.service.open_os_watches(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn search_session_ends_with_the_last_query_and_stop_frees_the_index() {
    let env = env();
    let reply = env
        .service
        .call(request("search/start", json!({ "sessionId": "q1", "roots": [env.root.to_string_lossy()] })))
        .await
        .unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("search/start must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    for i in 0..29 {
        call(&env, "search/update", json!({ "sessionId": "q1", "query": format!("zz{i}") })).await.unwrap();
    }
    call(&env, "search/update", json!({ "sessionId": "q1", "query": "main" })).await.unwrap();
    // Until the result of the last query has been pushed.
    let answered = |texts: &[String]| texts.iter().any(|f| f.contains("search/updated") && f.contains("\"query\":\"main\"") && f.contains("src/main.rs"));
    let updates: Vec<String> = conn.drain_text_until(answered).await.into_iter().filter(|f| f.contains("search/updated")).collect();
    let last = updates.last().expect("a result frame");
    assert!(last.contains("\"query\":\"main\"") && last.contains("src/main.rs"), "{last}");
    assert!(updates.iter().all(|u| u.contains("\"query\":\"main\"") || !u.contains("main.rs")));
    call(&env, "search/stop", json!({ "sessionId": "q1" })).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_text_search_and_replace_round_trip_through_the_service() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let found = call(&env, "projectFs/searchText", json!({ "root": root, "options": { "query": "one" } })).await.unwrap();
    assert_eq!(found["matchCount"], 1);
    let replaced =
        call(&env, "projectFs/replaceText", json!({ "root": root, "options": { "query": "one", "matchCase": true }, "replacement": "1" }))
            .await
            .unwrap();
    assert_eq!(replaced["filesChanged"], 1);
    assert_eq!(std::fs::read_to_string(env.root.join("a.txt")).unwrap(), "1\n");
}

/// `git ls-files` through the git CLI: the test stand-in for WP-SCM's gix implementation.
pub struct GitCli;

fn git_lines(root: &std::path::Path, args: &[&str]) -> Option<Vec<String>> {
    let out = std::process::Command::new("git").args(args).current_dir(root).output().ok()?;
    out.status.success().then(|| out.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| String::from_utf8_lossy(r).into_owned()).collect())
}

#[async_trait::async_trait]
impl TrackedFiles for GitCli {
    async fn files(&self, root: &std::path::Path, _: &CancellationToken) -> Option<Vec<String>> {
        git_lines(root, &["ls-files", "-z", "-c", "-o", "--exclude-standard"])
    }
    async fn ignored(&self, root: &std::path::Path, _: &CancellationToken) -> Option<u64> {
        git_lines(root, &["ls-files", "-z", "-o", "-i", "--exclude-standard"]).map(|l| l.len() as u64)
    }
}

/// A source domain's `TransferSource`: serves one staged file as kind `export`.
struct FixedSource(PathBuf);

#[async_trait::async_trait]
impl mixdog_workspace::transfer::TransferSource for FixedSource {
    fn kind(&self) -> &'static str {
        "export"
    }
    async fn open(&self, _: &Value, _: &CancellationToken) -> Result<mixdog_workspace::transfer::SourceFile, mixdog_workspace::error::WsError> {
        std::fs::write(&self.0, b"exported").unwrap();
        Ok(mixdog_workspace::transfer::SourceFile { file: std::fs::File::open(&self.0).unwrap(), name: "session.md".into(), mime_type: "text/markdown".into(), cleanup: None })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_domains_file_is_read_through_the_transfer_methods() {
    let env = env();
    let began = call(&env, "transfer/beginRead", json!({ "source": { "kind": "export", "id": "s1" } })).await.unwrap();
    assert_eq!((began["size"].clone(), began["entry"]["name"].clone(), began["mimeType"].clone()), (json!(8), json!("session.md"), json!("text/markdown")));
    let range = call(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 8 })).await.unwrap();
    assert_eq!(range["eof"], true);
    // A kind nobody serves stays unsupported.
    let missing = call(&env, "transfer/beginRead", json!({ "source": { "kind": "mediaAsset", "id": "m" } })).await;
    assert!(matches!(missing, Err(CoreError::DomainError { .. })), "{missing:?}");
}

/// A turn review that only records the `note_change` boundaries it is told of.
#[derive(Default)]
struct NoteLog(std::sync::Mutex<Vec<Option<Vec<String>>>>);

#[async_trait::async_trait]
impl mixdog_core_api::turn_review::TurnReviewApi for NoteLog {
    fn note_change(&self, paths: Option<&[String]>) {
        self.0.lock().unwrap().push(paths.map(<[String]>::to_vec));
    }
    async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {
        unimplemented!()
    }
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {
        unimplemented!()
    }
    fn take_call_diff(&self, _: &str) -> Option<String> {
        unimplemented!()
    }
    async fn begin_turn(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::TurnOpen) -> Option<mixdog_core_api::turn_review::TurnToken> {
        unimplemented!()
    }
    async fn complete_turn(&self, _: &str, _: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        unimplemented!()
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn mixdog_core_api::turn_review::AgentReview>> {
        unimplemented!()
    }
    fn forget_session(&self, _: &str) {
        unimplemented!()
    }
    async fn turn_review_diff(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::ReviewRead) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn session_review_diff(&self, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        unimplemented!()
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn turn_changes(&self, _: &str, _: mixdog_core_api::turn_review::ChangesRead) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn clear_change_history(&self, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_service_tells_the_turn_review_which_files_it_changed_and_only_after_it_did() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    let abs = |rel: &str| env.root.join(rel);
    let noted = || -> Vec<Option<Vec<PathBuf>>> {
        log.0.lock().unwrap().iter().map(|n| n.as_ref().map(|p| p.iter().map(PathBuf::from).collect())).collect()
    };

    call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "two\n", "expectedContent": "one\n" })).await.unwrap();
    assert_eq!(noted(), [Some(vec![abs("a.txt")])]);

    // A refused write changed nothing and tells no one.
    let refused = call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "stale" })).await;
    assert!(refused.is_err());
    assert_eq!(noted().len(), 1);

    call(&env, "projectFs/writeTextBatch", json!({ "root": root, "files": [
        { "relPath": "a.txt", "content": "three\n", "expectedContent": "two\n" },
        { "relPath": "readme.md", "content": "# yo\n", "expectedContent": "# hi\n" },
    ] })).await.unwrap();
    call(&env, "projectFs/create", json!({ "root": root, "relDir": "src", "name": "new.txt" })).await.unwrap();
    call(&env, "projectFs/rename", json!({ "root": root, "rel": "src/new.txt", "newName": "old.txt" })).await.unwrap();
    call(&env, "projectFs/move", json!({ "root": root, "rel": "src/old.txt", "targetDirRel": "." })).await.unwrap();
    call(&env, "projectFs/copy", json!({ "root": root, "rel": "old.txt", "targetDirRel": "src" })).await.unwrap();
    assert_eq!(
        noted()[1..],
        [
            Some(vec![abs("a.txt"), abs("readme.md")]),
            Some(vec![abs("src/new.txt")]),
            Some(vec![abs("src/new.txt"), abs("src/old.txt")]),
            Some(vec![abs("src/old.txt"), abs("old.txt")]),
            Some(vec![abs("src/old.txt")]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_trash_entry_names_its_path_and_an_upload_commit_names_none() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    let noted = || log.0.lock().unwrap().clone();

    // A permanent delete through the server trash path.
    call(&env, "transfer/trash/entry", json!({ "path": root, "rel": "readme.md", "permanent": true })).await.unwrap();
    assert!(!env.root.join("readme.md").exists());
    assert_eq!(noted().len(), 1);
    assert_eq!(noted()[0].as_ref().unwrap().iter().map(PathBuf::from).collect::<Vec<_>>(), [env.root.join("readme.md")]);

    // A refused entry (missing) tells no one.
    assert!(call(&env, "transfer/trash/entry", json!({ "path": root, "rel": "readme.md", "permanent": true })).await.is_err());
    assert_eq!(noted().len(), 1);

    // An upload names no file at commit: anything may have changed.
    let begun = call(&env, "transfer/beginWrite", json!({ "root": root, "rel": "up.bin", "size": 3 })).await.unwrap();
    assert_eq!(noted().len(), 1, "beginning an upload changes nothing");
    let id = begun["transferId"].clone();
    call(&env, "transfer/writeChunk", json!({ "transferId": id, "offset": 0, "bytesB64": "YWJj" })).await.unwrap();
    assert_eq!(noted().len(), 1, "a chunk is only staged");
    call(&env, "transfer/commit", json!({ "transferId": id })).await.unwrap();
    assert_eq!(noted()[1..], [None]);
    assert_eq!(std::fs::read(env.root.join("up.bin")).unwrap(), b"abc");
}

// `projectFs/trash` moves to the OS recycle bin, which a headless Unix host may not have.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_trashed_project_entry_is_noted_by_its_absolute_path() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    std::fs::write(env.root.join("to-trash.txt"), "x").unwrap();
    call(&env, "projectFs/trash", json!({ "root": root, "rel": "to-trash.txt" })).await.unwrap();
    assert!(!env.root.join("to-trash.txt").exists());
    // The item sits in the user's real recycle bin: take it out again, found by its original path
    // (the project folder is this test's own temp directory, so nothing else can match).
    let ours: Vec<_> = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .filter(|item| item.original_path() == env.root.join("to-trash.txt"))
        .collect();
    assert_eq!(ours.len(), 1, "the trashed file is in the recycle bin");
    trash::os_limited::purge_all(ours).unwrap();
    let noted = log.0.lock().unwrap().clone();
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0].as_ref().unwrap().iter().map(PathBuf::from).collect::<Vec<_>>(), [env.root.join("to-trash.txt")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recovery_restore_names_no_file_and_listing_or_inspecting_tells_no_one() {
    let log = Arc::new(NoteLog::default());
    let env = env_with(Some(log.clone()));
    let root = env.root.to_string_lossy().into_owned();
    // The service's journal folder (`Deps.recovery_dir`): an interrupted batch left a record.
    let store = RecoveryStore::new(env.root.parent().unwrap().join("recovery"));
    let file = env.root.join("a.txt");
    let journal = store
        .begin(
            &env.root,
            vec![PreparedFile {
                rel_path: "a.txt".into(),
                destination: canonical(&file).unwrap(),
                parent: mixdog_workspace::recovery::identity_of(&env.root).unwrap(),
                mode: 0,
                before: b"one\n".to_vec(),
                after: b"two\n".to_vec(),
            }],
        )
        .unwrap();
    std::fs::write(&file, "two\n").unwrap();
    store.release(&journal.directory).unwrap();

    let listed = call(&env, "projectFs/recovery", json!({ "root": root, "action": "list" })).await.unwrap();
    let id = listed["records"][0]["id"].as_str().unwrap_or_else(|| panic!("{listed}")).to_owned();
    let inspected = call(&env, "projectFs/recovery", json!({ "root": root, "action": "inspect", "id": id })).await.unwrap();
    let revision = inspected["detail"]["revision"].as_str().unwrap_or_else(|| panic!("{inspected}")).to_owned();
    assert!(log.0.lock().unwrap().is_empty(), "reading a record changes nothing");

    call(&env, "projectFs/recovery", json!({ "root": root, "action": "restore", "id": id, "revision": revision })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
    assert_eq!(log.0.lock().unwrap().clone(), [None]);
}

#[test]
fn offered_names_and_mime_types_match_nodes_recorded_answers() {
    let golden: Value = serde_json::from_slice(
        &std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/transfer/names.json")).unwrap(),
    )
    .unwrap();
    for row in golden["sanitize"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(mixdog_workspace::transfer::sanitized_file_name(input), row["name"].as_str().unwrap(), "{input:?}");
    }
    for row in golden["mime"].as_array().unwrap() {
        let input = row["input"].as_str().unwrap();
        assert_eq!(mixdog_workspace::fsops::mime_type(std::path::Path::new(input)), row["mime"].as_str().unwrap(), "{input:?}");
    }
}

/// Stands for the adapter over `CodeGraphTool`: answers with the cwd and the args it was given.
struct EchoGraph;

#[async_trait::async_trait]
impl mixdog_workspace::service::CodeGraph for EchoGraph {
    async fn query(&self, cwd: &std::path::Path, args: Value, _: &CancellationToken) -> Result<String, mixdog_workspace::error::WsError> {
        Ok(format!("{}|{args}", cwd.display()))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn code_graph_queries_pass_the_tools_arguments_and_return_its_text() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let found = call(&env, "project/codeGraph", json!({ "path": root, "mode": "find_symbol", "query": "  main " })).await.unwrap();
    assert_eq!(found, json!(format!("{root}|{}", json!({ "mode": "find_symbol", "symbols": "main", "limit": 20 }))));
    let outline = call(&env, "project/codeGraph", json!({ "path": root, "mode": "symbols", "query": "src/main.rs" })).await.unwrap();
    assert_eq!(outline, json!(format!("{root}|{}", json!({ "mode": "symbols", "files": "src/main.rs", "limit": 200 }))));
    let long = "x".repeat(257);
    let refused = call(&env, "project/codeGraph", json!({ "path": root, "mode": "references", "query": long })).await;
    assert!(matches!(&refused, Err(CoreError::InvalidParams { expected, .. }) if &**expected == "Symbol is invalid."), "{refused:?}");
    let denied = call(&env, "project/codeGraph", json!({ "path": env.root.parent().unwrap().to_string_lossy(), "mode": "symbols", "query": "a" })).await;
    assert!(matches!(denied, Err(CoreError::PermissionDenied { .. })));
}

fn futures_block<F: std::future::Future>(f: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(f))
}
// ---- DS-WS-1: the recorded Node fixtures, replayed through the service -----------------------------

fn corpus(domain: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/desktop/{domain}/corpus.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn strip_mtime(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.remove("mtimeMs");
            for v in map.values_mut() {
                *v = strip_mtime(v.take());
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                *v = strip_mtime(v.take());
            }
        }
        _ => {}
    }
    value
}

/// The recorded Node error text, as the reason the Rust core must answer with.
fn expect_error(message: &str, got: &CoreError, ctx: &str) {
    let ok = match got {
        CoreError::PermissionDenied { .. } => message == "Path is outside the project." || message == "Path resolves outside the project.",
        CoreError::PreconditionFailed { .. } => message.starts_with("File changed on disk"),
        CoreError::InvalidParams { expected, .. } => {
            // Search-pattern text is shown to the user: byte-equal. Others map by reason.
            if message.starts_with("Invalid search pattern") { &**expected == message } else { message == "Entry name is invalid." }
        }
        CoreError::DomainError { code, .. } => message.starts_with("ENOENT") && code.as_deref() == Some("notFound"),
        _ => false,
    };
    assert!(ok, "{ctx}: recorded {message:?}, got {got:?}");
}

fn tree(root: &std::path::Path, files: &[(&str, &[u8])]) {
    for (rel, data) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }
}

async fn replay(env: &Env, cases: &Value, root: &str, ctx: &str) {
    for case in cases["cases"].as_array().or_else(|| cases["entries"].as_array()).unwrap() {
        let op = case["op"].as_str().unwrap();
        let args = &case["args"];
        let (method, params): (&'static str, Value) = match op {
            "listProjectDirIn" | "listProjectDirIn(after)" => ("projectFs/listDir", json!({ "root": root, "rel": args[0] })),
            "readProjectTextFileIn" | "readProjectTextFileIn(after write)" => ("projectFs/readText", json!({ "root": root, "rel": args[0] })),
            "statProjectFileIn" => ("projectFs/stat", json!({ "root": root, "rel": args[0] })),
            "writeProjectTextFileIn(expected mismatch)" => {
                ("projectFs/writeText", json!({ "root": root, "rel": args[0], "content": "new", "expectedContent": "WRONG" }))
            }
            "writeProjectTextFileIn" => (
                "projectFs/writeText",
                json!({ "root": root, "rel": args[0], "content": "rewritten\n", "expectedContent": "héllo\nworld\n" }),
            ),
            "createProjectEntryIn" | "createProjectEntryIn(invalid)" => {
                ("projectFs/create", json!({ "root": root, "relDir": args[0], "name": args[1], "directory": args[2] }))
            }
            "renameProjectEntryIn" => ("projectFs/rename", json!({ "root": root, "rel": args[0], "newName": args[1] })),
            "moveProjectEntryIn" => ("projectFs/move", json!({ "root": root, "rel": args[0], "targetDirRel": args[1] })),
            "copyProjectEntryIn" => ("projectFs/copy", json!({ "root": root, "rel": args[0], "targetDirRel": args[1] })),
            "searchWorkspaceTextIn" => ("projectFs/searchText", json!({ "root": root, "options": args })),
            "replaceWorkspaceTextIn" => {
                let mut params = json!({ "root": root, "options": args[0], "replacement": args[1] });
                if let Some(paths) = args.get(2).filter(|p| !p.is_null()) {
                    params["relPaths"] = paths.clone();
                }
                ("projectFs/replaceText", params)
            }
            other => panic!("{ctx}: unmapped recorded op {other}"),
        };
        let got = call(env, method, params).await;
        let label = format!("{ctx} {op} {args}");
        match (case.get("error"), got) {
            (Some(error), Err(e)) => expect_error(error.as_str().unwrap(), &e, &label),
            (None, Ok(value)) => {
                if let Some(expected) = case.get("result") {
                    assert_eq!(&strip_mtime(value), expected, "{label}");
                }
            }
            (error, got) => panic!("{label}: recorded error {error:?}, got {got:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_project_file_operations_replay_identically() {
    let env = env();
    let pf = env.root.parent().unwrap().join("pf");
    std::fs::create_dir_all(&pf).unwrap();
    tree(
        &pf,
        &[
            ("utf8.txt", "héllo\nworld\n".as_bytes()),
            ("crlf.txt", b"a\r\nb\r\n"),
            ("bom8.txt", b"\xef\xbb\xbfbom\n"),
            ("utf16le.txt", b"\xff\xfeh\x00i\x00\n\x00"),
            ("bin.dat", &[0, 255, 0, 255, 1, 2, 3]),
            ("dir/inner.txt", b"inner\n"),
        ],
    );
    // A row, not `project/create`: the recorded listing of this folder has no `.mixdog/project.id`.
    let row = mixdog_store::state::ProjectRow { path: pf.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None };
    env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
    replay(&env, &corpus("files"), &pf.to_string_lossy(), "files").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_workspace_searches_and_replace_replay_identically() {
    let env = env();
    let ws = env.root.parent().unwrap().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    tree(
        &ws,
        &[
            ("a.txt", b"Hello World\nhello world\nHELLO\n"),
            ("src/x.mjs", b"const hello = \"Hello\";\nfunction helloWorld() {}\n"),
            ("node_modules/skip.js", b"hello skipped\n"),
            ("data.bin", &[0, 1, 2, 104, 101, 108, 108, 111]),
        ],
    );
    env.service.catalog().add(&ws.to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
    replay(&env, &corpus("search"), &ws.to_string_lossy(), "search").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_transfer_reads_replay_through_the_transfer_methods() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let payload: Vec<u8> = b"0123456789abcdef".repeat(8);
    std::fs::write(env.root.join("report.bin"), &payload).unwrap();
    let fixture = corpus("transfer");
    let entry = |op: &str| fixture["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap().clone();
    // begin: the size and name the Node service recorded.
    let began = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "report.bin" } })).await.unwrap();
    assert_eq!(began["size"], entry("begin")["result"]["size"]);
    assert_eq!(began["entry"]["name"], entry("begin")["result"]["name"]);
    assert_eq!(began["entry"]["rangeMaxBytes"], entry("begin")["result"]["rangeMaxBytes"]);
    assert_eq!(began["mimeType"], entry("authorize")["result"]["mime"]);
    // authorize(outside): a path out of the project is refused.
    let outside = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "../x" } })).await;
    assert!(matches!(outside, Err(CoreError::PermissionDenied { .. })));
    let id = began["transferId"].as_str().unwrap().to_owned();
    // readRange: the recorded bytes.
    let range = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 64 })).await.unwrap();
    assert_eq!(range["data"], entry("readRange")["result"]["data"]);
    assert_eq!((&range["length"], &range["eof"]), (&entry("readRange")["result"]["length"], &entry("readRange")["result"]["eof"]));
    // past end: recorded as a TypeError (invalid params).
    let past = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 1000, "length": 8 })).await;
    assert!(matches!(past, Err(CoreError::InvalidParams { .. })), "{past:?}");
    // finish, then the id is gone; abort of an unknown id is false.
    assert_eq!(call(&env, "transfer/endRead", json!({ "transferId": id })).await.unwrap()["ended"], true);
    assert!(call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 8 })).await.is_err());
    assert_eq!(call(&env, "transfer/abort", json!({ "transferId": "nope" })).await.unwrap()["aborted"], entry("abort(unknown)")["result"]);
}

fn fill(value: &Value, work: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<WORK>", work)),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, work)).collect()),
        // `{"$repeat": [unit, count]}` stands for a string too long to keep in the corpus.
        Value::Object(map) if map.contains_key("$repeat") => {
            Value::String(map["$repeat"][0].as_str().unwrap().repeat(map["$repeat"][1].as_u64().unwrap() as usize))
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, work))).collect()),
        other => other.clone(),
    }
}

/// The corpus's scrubbing: the temp root becomes `<WORK>`, millisecond clocks 0, huge bodies their length.
fn scrub(value: &Value, work: &str) -> Value {
    match value {
        Value::String(s) if s.encode_utf16().count() > 100_000 => Value::String(format!("<LEN:{}>", s.encode_utf16().count())),
        Value::String(s) => Value::String(s.replace(work, "<WORK>")),
        Value::Number(n) if n.as_u64().is_some_and(|n| (1_600_000_000_000..1_800_000_000_000).contains(&n)) => json!(0),
        Value::Array(items) => Value::Array(items.iter().map(|v| scrub(v, work)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), scrub(v, work))).collect()),
        other => other.clone(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_editor_files_replay_identically() {
    let fixture = corpus("editor-config");
    let host = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    if fixture["platform"] != host {
        eprintln!("editor-config corpus was recorded on {}; its backup names follow that platform's case rule", fixture["platform"]);
        return;
    }
    let env = env();
    let work = env.root.parent().unwrap().to_path_buf();
    let work_s = work.to_string_lossy().into_owned();
    let backups = mixdog_workspace::editorcfg::Backups::new(&work.join("userData"));
    let backup_files = || -> Vec<String> {
        std::fs::read_dir(work.join("userData/editor-backups")).map(|d| d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
    };
    for (index, entry) in fixture["entries"].as_array().unwrap().iter().enumerate() {
        let label = format!("#{index} {} {}", entry["method"], entry["input"]);
        if entry["input"].get("note").is_some() {
            // The file-count cap: 105 sources, newest last, mtimes one second apart.
            let _ = std::fs::remove_dir_all(work.join("userData/editor-backups"));
            let now = std::time::SystemTime::now();
            for i in 0..105u64 {
                let source = work.join(format!("cap/f{i}.txt")).to_string_lossy().into_owned();
                call(&env, "projectFs/backup/write", json!({ "sourcePath": source, "content": format!("c{i}"), "expectedContent": "e" })).await.unwrap();
                let file = std::fs::OpenOptions::new().write(true).open(backups.path_of(&source).unwrap()).unwrap();
                file.set_modified(now - Duration::from_secs(105 - i)).unwrap();
            }
            assert_eq!(backup_files().len() as u64, entry["result"]["filesAfter"].as_u64().unwrap(), "{label}");
            continue;
        }
        for step in entry["setup"].as_array().into_iter().flatten() {
            if let Some(rel) = step["file"].as_str() {
                tree(&work, &[(rel, step["text"].as_str().unwrap().as_bytes())]);
            } else {
                let source = work.join(step["backup"].as_str().unwrap()).to_string_lossy().into_owned();
                let text = match step["raw"].as_str() {
                    Some(raw) => raw.to_owned(),
                    None => {
                        let updated = mixdog_workspace::editorcfg::now_ms() - step["ageMs"].as_i64().unwrap();
                        json!({ "content": step["content"], "expectedContent": step["expectedContent"], "updatedAt": updated }).to_string()
                    }
                };
                std::fs::write(backups.path_of(&source).unwrap(), text).unwrap();
            }
        }
        let input = fill(&entry["input"], &work_s);
        let (method, params): (&'static str, Value) = match entry["method"].as_str().unwrap() {
            "projectFs/workspaceFile/read" => ("projectFs/workspaceFile/read", json!({ "workspaceFile": input["workspaceFile"] })),
            "projectFs/workspaceFile/write" => {
                ("projectFs/workspaceFile/write", json!({ "workspaceFile": input["workspaceFile"], "folders": input["folders"] }))
            }
            "projectFs/readEditorSettings" => {
                let root = input["root"].as_str().unwrap();
                if !std::path::Path::new(root).exists() {
                    // A folder that is not there cannot be a registered project: the boundary refuses it.
                    let denied = call(&env, "projectFs/readEditorSettings", json!({ "root": root, "rel": input["rel"] })).await;
                    assert!(matches!(denied, Err(CoreError::PermissionDenied { .. })), "{label}: {denied:?}");
                    continue;
                }
                env.service.catalog().add(root, &CancellationToken::new(), None).await.unwrap();
                ("projectFs/readEditorSettings", json!({ "root": root, "rel": input["rel"], "workspaceFile": input["workspaceFile"] }))
            }
            "projectFs/backup/read" => ("projectFs/backup/read", json!({ "sourcePath": input["sourcePath"] })),
            "projectFs/backup/write" => (
                "projectFs/backup/write",
                json!({ "sourcePath": input["sourcePath"], "content": input["content"], "expectedContent": input["expectedContent"] }),
            ),
            "projectFs/backup/delete" => ("projectFs/backup/delete", json!({ "sourcePath": input["sourcePath"] })),
            "project/taskWorkspace" => ("project/taskWorkspace", json!({})),
            other => panic!("{label}: unmapped recorded method {other}"),
        };
        match (entry.get("error"), call(&env, method, params).await) {
            (Some(error), Err(got)) => {
                // Node's TypeErrors are this core's invalid params, with the text; its system errors only need to fail.
                if error["name"] == "TypeError" {
                    let CoreError::InvalidParams { expected, .. } = &got else { panic!("{label}: {got:?}") };
                    assert_eq!(&**expected, error["message"].as_str().unwrap(), "{label}");
                }
            }
            (None, Ok(value)) => {
                if let Some(expected) = entry.get("result") {
                    assert_eq!(&scrub(&value, &work_s), expected, "{label}");
                }
            }
            (error, got) => panic!("{label}: recorded error {error:?}, got {got:?}"),
        }
        if let Some(expected) = entry.get("fileAfter") {
            let mut file = input["workspaceFile"].as_str().unwrap().to_owned();
            if !file.to_lowercase().ends_with(".code-workspace") {
                file.push_str(".code-workspace");
            }
            // The file's text is JSON: a Windows path in it has doubled backslashes.
            let text = std::fs::read_to_string(&file)
                .map(|t| Value::String(t.replace(&work_s.replace('\\', "\\\\"), "<WORK>").replace(&work_s, "<WORK>")))
                .unwrap_or(Value::Null);
            assert_eq!(&text, expected, "{label}: file after");
        }
        if let Some(expected) = entry.get("files") {
            assert_eq!(backup_files().len() as u64, expected.as_u64().unwrap(), "{label}: backup files");
            let strays: Vec<String> = backup_files().into_iter().filter(|n| n.len() != 69 || !n.ends_with(".json")).collect();
            assert_eq!(json!(strays), entry["fileNames"], "{label}: stray names");
        }
        if let Some(gone) = entry.get("fileGone") {
            assert_eq!(!backups.path_of(input["sourcePath"].as_str().unwrap()).unwrap().exists(), gone.as_bool().unwrap(), "{label}");
        }
    }
}

/// The user's Markdown default view is a config key here (`desktop.editor.markdownDefaultView`; Node keeps it in the user settings
/// file as `mixdog.markdown.defaultView`). Editor settings put it in the user scope: the recorded Node answers of the scoped
/// settings (where the user file states `rich`) are the same when the file lacks the key and the config states it.
#[tokio::test(flavor = "multi_thread")]
async fn the_users_markdown_view_in_the_config_is_the_user_scope_of_editor_settings() {
    const STATED: &str = "\"mixdog.markdown.defaultView\": \"rich\",";
    let fixture = corpus("editor-config");
    let entries = fixture["entries"].as_array().unwrap();
    let start = entries
        .iter()
        .position(|entry| entry["setup"].as_array().is_some_and(|setup| setup.iter().any(|step| step["text"].as_str().is_some_and(|text| text.contains(STATED)))))
        .expect("the corpus records a user scope that states the view");
    let env = env();
    env.service.set_user_markdown_view(Arc::new(|| Some("rich".to_owned())));
    let work = env.root.parent().unwrap().to_path_buf();
    let work_s = work.to_string_lossy().into_owned();
    for step in entries[start]["setup"].as_array().unwrap() {
        let text = step["text"].as_str().unwrap().replace(STATED, "");
        tree(&work, &[(step["file"].as_str().unwrap(), text.as_bytes())]);
    }
    let mut replayed = 0;
    for (index, entry) in entries.iter().enumerate().skip(start) {
        if index > start && entry.get("setup").is_some() {
            break;
        }
        if entry["method"] != "projectFs/readEditorSettings" {
            continue;
        }
        let input = fill(&entry["input"], &work_s);
        if !std::path::Path::new(input["root"].as_str().unwrap()).exists() {
            continue;
        }
        env.service.catalog().add(input["root"].as_str().unwrap(), &CancellationToken::new(), None).await.unwrap();
        let got = call(&env, "projectFs/readEditorSettings", json!({ "root": input["root"], "rel": input["rel"], "workspaceFile": input["workspaceFile"] })).await.unwrap();
        assert_eq!(&scrub(&got, &work_s), &entry["result"], "#{index} {}", entry["input"]);
        replayed += 1;
    }
    assert!(replayed > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn lsp_feed_carries_node_keyed_sections_with_a_snapshot_for_late_subscribers() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    let reply = env.service.call(request("lsp/subscribe", json!({ "root": root }))).await.unwrap();
    let Reply::Subscribe(sub) = reply else { panic!("lsp/subscribe must subscribe") };
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let attached = subscribe(&sub.feed, SubscriptionId::from("s1"), sub.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    // The mock process manager starts no real server: opening a TypeScript file publishes statuses.
    call(&env, "lsp/document", json!({ "projectPath": root, "root": root, "document": { "kind": "open", "languageId": "typescript", "relPath": "a.ts", "content": "x", "version": 1 } })).await.unwrap();
    let raw = conn.drain_text_until(|texts| texts.iter().any(|f| f.contains("lsp/status/updated"))).await;
    let frames: Vec<Value> = raw.iter().filter_map(|f| serde_json::from_str(f.split_once(':')?.1).ok()).collect();
    assert!(!raw.is_empty(), "no frames at all");
    let status = frames.iter().find(|f| f["method"] == "lsp/status/updated").unwrap_or_else(|| panic!("a status frame in {raw:?}"));
    let key = status["params"]["key"].as_str().unwrap();
    // Node's `statusKey`: the language, or the language, `\0` and the path.
    assert!(key == "typescript" || key == "typescript\0a.ts", "{key:?}");
    assert_eq!(status["params"]["section"], "lspStatus");
    assert_eq!(status["params"]["value"]["projectPath"], root.as_str());
    assert_eq!(status["params"]["revision"], 1);
    assert_eq!(status["params"]["value"]["status"], "starting");
    // A subscriber that joins later sees the current rows in its snapshot.
    let late = env.service.call(request("lsp/subscribe", json!({ "root": root }))).await.unwrap();
    let Reply::Subscribe(late) = late else { panic!() };
    let conn2 = MockConnection::new(ConnectionId(2), env.limits);
    let attached = subscribe(&late.feed, SubscriptionId::from("s2"), late.window, None, &conn2).unwrap();
    conn2.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    let snapshot = conn2.drain_text_until(|texts| texts.iter().any(|f| f.contains("feed/snapshot"))).await.into_iter().find(|f| f.contains("feed/snapshot")).expect("a snapshot");
    assert!(snapshot.contains("lspStatus") && snapshot.contains(key.replace('\0', "\\u0000").as_str()), "{snapshot}");
}

#[tokio::test(flavor = "multi_thread")]
async fn recorded_lsp_registry_and_unsupported_answers_replay() {
    let env = env();
    let fixture = corpus("lsp");
    let find = |op: &str| fixture["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap().clone();
    let root = env.root.to_string_lossy().into_owned();
    let doc = call(&env, "lsp/document", json!({ "projectPath": root, "root": root, "document": { "kind": "open", "languageId": "plaintext", "relPath": "a.xyz", "content": "x", "version": 1 } })).await.unwrap();
    assert_eq!(doc, find("lspDocument")["result"]);
    let request = call(
        &env,
        "lsp/request",
        json!({ "projectPath": root, "root": root, "request": { "relPath": "a.xyz", "languageId": "plaintext", "method": "textDocument/hover", "params": { "position": { "line": 0, "character": 0 } } } }),
    )
    .await
    .unwrap();
    assert_eq!(request, find("lspRequest")["result"]);
    assert_eq!(mixdog_workspace::lsp::document_language_id("a.tsx", "typescript"), "typescriptreact");
    assert_eq!(mixdog_workspace::lsp::document_language_id("Dockerfile", "plaintext"), "plaintext");
    let table = &find("SERVER_BY_LANGUAGE")["result"];
    for language in mixdog_workspace::lsp::DEFAULT_LANGUAGES {
        let spec = mixdog_workspace::lsp::default_spec(language).unwrap();
        assert_eq!(table[language]["command"], spec.command.as_str(), "{language}");
        assert_eq!(table[language]["id"], spec.id.as_str(), "{language}");
        assert_eq!(table[language]["args"], json!(spec.args), "{language}");
    }
}
