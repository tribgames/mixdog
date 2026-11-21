#![allow(clippy::disallowed_types, reason = "test setup")]
#![allow(clippy::disallowed_methods, reason = "test setup")]
//! DS-WS-2/3/4/5/6/9 against the service with mock feeds and mock processes.

use std::path::Path;
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
use mixdog_store::state::CoreState;
use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::recovery::Action;
use mixdog_workspace::recovery::PreparedFile;
use mixdog_workspace::recovery::RecoveryStore;
use mixdog_workspace::service::Deps;
use mixdog_workspace::service::WorkspaceService;
use mixdog_workspace::zip::TrackedFiles;
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
        lanes: Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk },
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
        upload_chunk_bytes: mixdog_app_protocol::limits::Limits::default().max_blob_put_chunk_bytes,
    })
    .unwrap();
    // Registered as a row: `project/create` also leaves `.mixdog/project.id` in the folder, which
    // the recorded folder listings of this project do not have.
    let row = mixdog_store::state::ProjectRow {
        path: root.to_string_lossy().into_owned(),
        alias: None,
        hidden: false,
        hidden_rank: None,
        last_used_at: None,
        name: None,
    };
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

/// A call of the desktop's own window (a local connection).
async fn call_local(env: &Env, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(2), Origin::Local, CancellationToken::new());
    match env.service.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
        Reply::Value(v) => Ok(v),
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    }
}

/// Node's `Error` for a folder that is no registered project: code `PROJECT_UNAVAILABLE`, text "Project is not available." (`projectScope`
/// -> `knownPath`, session-host.ts:556).
fn unavailable<T>(result: &Result<T, CoreError>) -> bool {
    matches!(result, Err(CoreError::DomainError { code, message, .. })
        if code.as_deref() == Some("PROJECT_UNAVAILABLE") && message.as_deref() == Some("Project is not available."))
}

/// Node's plain `Error` for an entry beyond its project: no code, text "Path is outside the project.".
fn outside_the_project<T>(result: &Result<T, CoreError>) -> bool {
    matches!(result, Err(CoreError::DomainError { code: None, message, .. }) if message.as_deref() == Some("Path is outside the project."))
}

struct NoneGone;

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for NoneGone {
    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}

/// A closed connection's unfinished read goes with it; a read another connection holds stays usable. (A first window that
/// finishes after its connection closed is covered in readwindow.rs.)
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_connection_gives_up_its_unfinished_read_and_no_other() {
    let env = env();
    let root = project_holding(&env, "pf-closed", &[("w.txt", "0123456789abcdef".as_bytes())]).await;
    let as_connection = |id: u64, params: Value| {
        let mut req = request("projectFs/readText", params);
        req.ctx = CallContext::connection(ConnectionId(id), Origin::Relay, CancellationToken::new());
        req
    };
    let first = json!({ "root": root, "rel": "w.txt", "maxChars": 4 });
    let mut ids = Vec::new();
    for connection in [1, 2] {
        let Reply::Value(answer) = env.service.call(as_connection(connection, first.clone())).await.unwrap() else { panic!("readText answers with a value") };
        ids.push(answer["readId"].as_str().expect("the read is held").to_owned());
    }
    env.service.connection_closed(&ConnectionId(1));
    let next = |id: &str| json!({ "root": root, "rel": "w.txt", "readId": id, "fromChar": 4, "maxChars": 4 });
    assert!(env.service.call(as_connection(1, next(&ids[0]))).await.is_err(), "the closed connection's read is gone");
    let Reply::Value(second) = env.service.call(as_connection(2, next(&ids[1]))).await.unwrap() else { panic!("readText answers with a value") };
    assert_eq!(second["content"], "4567");
}
/// A file is answered a window of code points at a time (one connection answer is capped), `nextChar` naming where the next starts;
/// the pieces joined are the whole text.
#[tokio::test(flavor = "multi_thread")]
async fn a_text_file_is_read_in_windows_that_join_to_the_whole() {
    let env = env();
    let text = "aé😀b".repeat(5);
    std::fs::write(env.root.join("w.txt"), &text).unwrap();
    let root = env.root.to_string_lossy().into_owned();
    let mut part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "w.txt", "maxChars": 7 })).await.unwrap();
    let mut joined = part["content"].as_str().unwrap().to_owned();
    while let Some(next) = part.get("nextChar").and_then(Value::as_u64) {
        let read_id = part["readId"].clone();
        part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "w.txt", "readId": read_id, "fromChar": next, "maxChars": 7 })).await.unwrap();
        joined.push_str(part["content"].as_str().unwrap());
    }
    assert_eq!(joined, text);
}

const WRONG_PATH: &str = "The selected-file permission does not match this path.";

fn granted_env(folder: &str) -> (Env, PathBuf) {
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join(folder);
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hi\n").unwrap();
    std::fs::write(outside.join("other.txt"), "secret\n").unwrap();
    (env, outside)
}

async fn mint_token(env: &Env, outside: &Path, name: &str) -> String {
    let minted = call(env, "transfer/grant/mint", json!({ "path": outside.join(name).to_string_lossy() })).await.unwrap();
    minted["accessToken"].as_str().unwrap().to_owned()
}

fn granted_source(outside: &Path, rel: &str, token: &str) -> Value {
    json!({ "source": { "kind": "granted", "accessToken": token, "projectPath": outside.to_string_lossy(), "relPath": rel } })
}

fn granted_target(outside: &Path, rel: &str, token: &str) -> Value {
    json!({ "root": outside.to_string_lossy(), "rel": rel, "accessToken": token })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_outside_every_project_is_minted_a_one_file_grant_and_one_inside_is_not() {
    let (env, outside) = granted_env("granted-outside");
    let minted = call(&env, "transfer/grant/mint", json!({ "path": outside.join("note.txt").to_string_lossy() })).await.unwrap();
    assert_eq!(minted["relPath"], "note.txt");
    assert_eq!(minted["projectPath"], outside.to_string_lossy().as_ref());
    assert_eq!((minted["name"].clone(), minted["size"].clone(), minted["dir"].clone()), (json!("note.txt"), json!(3), json!(false)));
    let inside = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy() })).await.unwrap();
    assert_eq!((inside["projectPath"].clone(), inside["relPath"].clone()), (json!(env.root.to_string_lossy()), json!("a.txt")));
    assert!(inside.get("accessToken").is_none());
    let attachment = call(&env, "transfer/grant/mint", json!({ "path": env.root.join("a.txt").to_string_lossy(), "sessionId": "s1" })).await.unwrap();
    assert!(attachment["accessToken"].is_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_granted_file_is_begun_and_read_by_range() {
    let (env, outside) = granted_env("granted-outside");
    let token = mint_token(&env, &outside, "note.txt").await;
    let began = call(&env, "transfer/beginRead", granted_source(&outside, "note.txt", &token)).await.unwrap();
    assert_eq!(began["size"], 3);
    let range = call(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 3 })).await.unwrap();
    assert_eq!(range["data"], "aGkK");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_editor_calls_over_a_grant_answer_as_they_do_for_a_project_file() {
    let (env, outside) = granted_env("granted-outside");
    let token = mint_token(&env, &outside, "note.txt").await;
    let text = call(&env, "projectFs/readText", granted_target(&outside, "note.txt", &token)).await.unwrap();
    let project_file = call(&env, "projectFs/readText", json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" })).await.unwrap();
    let keys = |value: &Value| value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys(&text), keys(&project_file), "the same reply shape as a project file's");
    assert_eq!((text["content"].clone(), text["binary"].clone(), text["tooLarge"].clone()), (json!("hi\n"), json!(false), json!(false)));
    let stat = call(&env, "projectFs/stat", granted_target(&outside, "note.txt", &token)).await.unwrap();
    assert_eq!((stat["size"].clone(), stat["directory"].clone()), (json!(3), json!(false)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_grant_opens_its_one_file_and_a_token_never_issued_opens_nothing() {
    let (env, outside) = granted_env("granted-outside");
    let token = mint_token(&env, &outside, "note.txt").await;
    let wrong = call(&env, "projectFs/readText", granted_target(&outside, "other.txt", &token)).await;
    assert!(format!("{wrong:?}").contains(WRONG_PATH), "{wrong:?}");
    let missing = call(&env, "projectFs/stat", granted_target(&outside, "note.txt", "not-a-token")).await;
    assert!(format!("{missing:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{missing:?}");
    let other = call(&env, "transfer/beginRead", granted_source(&outside, "other.txt", &token)).await;
    assert!(format!("{other:?}").contains(WRONG_PATH), "{other:?}");
    let unknown = call(&env, "transfer/beginRead", granted_source(&outside, "note.txt", "not-a-token")).await;
    assert!(format!("{unknown:?}").contains("SELECTED_FILE_GRANT_UNAVAILABLE"), "{unknown:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_grant_a_relay_connection_reads_no_absolute_path() {
    let (env, outside) = granted_env("granted-outside");
    let plain = call(&env, "transfer/beginRead", json!({ "source": { "kind": "localFile", "path": outside.join("other.txt").to_string_lossy() } })).await;
    assert!(matches!(plain, Err(CoreError::PermissionDenied { .. })), "{plain:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_one_file_permission_writes_its_file_and_refuses_another() {
    let (env, outside) = granted_env("granted-calls");
    let note = mint_token(&env, &outside, "note.txt").await;
    let mut write = granted_target(&outside, "note.txt", &note);
    write["content"] = json!("changed\n");
    write["expectedContent"] = json!("hi\n");
    call(&env, "projectFs/writeText", write).await.unwrap();
    assert_eq!(std::fs::read_to_string(outside.join("note.txt")).unwrap(), "changed\n");
    let mut aside = granted_target(&outside, "other.txt", &note);
    aside["content"] = json!("x");
    aside["expectedContent"] = json!("secret\n");
    let refused = call(&env, "projectFs/writeText", aside).await;
    assert!(format!("{refused:?}").contains(WRONG_PATH), "{refused:?}");
    assert_eq!(std::fs::read_to_string(outside.join("other.txt")).unwrap(), "secret\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_one_file_permission_names_that_file_alone() {
    let (env, outside) = granted_env("granted-calls");
    let note = mint_token(&env, &outside, "note.txt").await;
    let named = call(&env, "projectFs/entryPath", granted_target(&outside, "note.txt", &note)).await.unwrap();
    assert_eq!(named["path"], outside.join("note.txt").to_string_lossy().as_ref());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_devices_image_preview_is_leased_to_that_device_alone() {
    let (env, outside) = granted_env("granted-calls");
    std::fs::write(outside.join("pic.png"), [0x89, b'P', b'N', b'G', 1, 2, 3, 4]).unwrap();
    let pic = mint_token(&env, &outside, "pic.png").await;
    let previewed = call(&env, "projectFs/previewFile", granted_target(&outside, "pic.png", &pic)).await.unwrap();
    assert_eq!((previewed["kind"].clone(), previewed["size"].clone()), (json!("image"), json!(8)));
    let lease = previewed["mediaAssetId"].as_str().expect("a paired device's image is leased").to_owned();
    let leases = env.service.project_leases();
    let served = leases.open(&lease, "phone-1").await.expect("the device's lease opens");
    assert_eq!((served.size(), served.mime()), (8, "image/png"));
    assert_eq!(served.read(4, 2).await.unwrap(), vec![1, 2]);
    assert!(leases.open(&lease, "phone-2").await.is_none(), "another device is refused");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pdf_preview_is_read_by_page_and_never_leased() {
    let (env, outside) = granted_env("granted-calls");
    std::fs::write(outside.join("doc.pdf"), b"%PDF-1.4").unwrap();
    let doc = mint_token(&env, &outside, "doc.pdf").await;
    let pdf = call(&env, "projectFs/previewFile", granted_target(&outside, "doc.pdf", &doc)).await.unwrap();
    assert_eq!(pdf["kind"], "pdf");
    assert!(pdf.get("mediaAssetId").is_none(), "a pdf is read by page, never leased: {pdf:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_preview_range_over_a_grant_names_the_granted_file_alone() {
    let (env, outside) = granted_env("granted-calls");
    std::fs::write(outside.join("pic.png"), [0x89, b'P', b'N', b'G', 1, 2, 3, 4]).unwrap();
    let pic = mint_token(&env, &outside, "pic.png").await;
    let mut range = granted_target(&outside, "pic.png", &pic);
    range["offset"] = json!(4);
    range["length"] = json!(2);
    let part = call(&env, "projectFs/previewRange", range).await.unwrap();
    assert_eq!((part["data"].clone(), part["offset"].clone(), part["size"].clone()), (json!("AQI="), json!(4), json!(8)));
}

/// `FIXED_NOW_MS` of `lib/phone-files-script.mjs`: the clock the Node recording ran on, given to the backups' clock.
const PHONE_FILES_NOW_MS: &str = "1780819750000";

/// A folder whose name only trims to a registered project's is not that project (Node trims the phone's `projectPath` and then
/// acts on the registry's own root). A relay backup named in such a folder is kept under the project's file, which is what the
/// admission checked, and never reaches the backup the desktop keeps for the other folder's file.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_is_kept_under_the_file_that_was_admitted() {
    let env = env();
    let twin = PathBuf::from(format!("{}\u{a0}", env.root.to_string_lossy()));
    std::fs::create_dir_all(&twin).unwrap();
    let source = twin.join("secret.txt").to_string_lossy().into_owned();
    call_local(&env, "projectFs/backup/write", json!({ "sourcePath": source, "content": "private", "expectedContent": "" })).await.unwrap();
    let kept = call_local(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap();
    assert_ne!(kept, Value::Null, "the desktop's backup of the other folder's file");

    assert_eq!(
        call(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap(),
        Value::Null,
        "the phone reads the project's file's backup: none"
    );
    call(&env, "projectFs/backup/delete", json!({ "sourcePath": source })).await.unwrap();
    assert_eq!(call_local(&env, "projectFs/backup/read", json!({ "sourcePath": source })).await.unwrap(), kept, "the phone's delete did not reach it");
}

/// With no desktop window to render or trash, the calls that need one answer the missing capability (the adapter words it as Node's
/// "The desktop app is unavailable on this connection.").
#[tokio::test(flavor = "multi_thread")]
async fn host_only_file_calls_answer_the_missing_desktop_capability_without_a_window() {
    let env = env();
    for (method, extra) in [("projectFs/captureSnapshot", json!({})), ("projectFs/trash", json!({ "viaHost": true }))] {
        let mut params = json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let answered = call(&env, method, params).await;
        assert!(matches!(&answered, Err(CoreError::CapabilityUnavailable { capability, .. }) if &**capability == "desktopHost"), "{method}: {answered:?}");
    }
    assert!(env.root.join("a.txt").exists(), "nothing was trashed");
}

/// The page server is the core's: without the desktop's files enabled the call is refused as unsupported, never sent to a window.
#[tokio::test(flavor = "multi_thread")]
async fn the_local_page_url_without_the_page_server_is_unsupported() {
    let env = env();
    let answered = call(&env, "projectFs/localPageUrl", json!({ "root": env.root.to_string_lossy(), "rel": "a.txt" })).await;
    assert!(matches!(&answered, Err(CoreError::DomainError { code, .. }) if code.as_deref() == Some("unsupported")), "{answered:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_connection_reads_any_absolute_folder_while_a_relay_is_held_to_the_projects() {
    let env = env();
    let outside = env.root.parent().unwrap().join("unregistered");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("note.txt"), "hello\n").unwrap();
    let params = json!({ "root": outside.to_string_lossy(), "rel": "note.txt" });
    // The `…In` operations of Node take any root the window resolved; the relay is the strict origin.
    assert!(unavailable(&call(&env, "projectFs/readText", params.clone()).await));
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
        assert_eq!(
            began["chunkBytes"],
            mixdog_app_protocol::limits::Limits::default().max_blob_put_chunk_bytes,
            "the begin answer states the chunk size the core advertises at initialize"
        );
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
    let listed = call(&env, "projectFs/statLocal", json!({ "paths": [present.to_string_lossy(), missing.to_string_lossy()] })).await.unwrap();
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
    // A different authorized audience may not reuse another audience's result.
    let mut other_audience = with_op("projectFs/writeText", params.clone(), op);
    other_audience.ctx.origin = mixdog_protocol::Origin::Ssh;
    assert!(matches!(env.service.call(other_audience).await, Err(CoreError::OpIdConflict { .. })));
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

#[tokio::test(flavor = "multi_thread")]
async fn paths_outside_the_registry_or_project_are_refused_with_permission_denied() {
    let env = env();
    let outside = env.root.parent().unwrap().join("other");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(unavailable(&call(&env, "projectFs/listDir", json!({ "root": outside.to_string_lossy(), "rel": "." })).await));
    let root = env.root.to_string_lossy().into_owned();
    // The phone asks for Node's answer; a local or SSH caller keeps the permission refusal for the same path.
    assert!(outside_the_project(&call(&env, "projectFs/readText", json!({ "root": root, "rel": "../other/x", "nodeErrors": true })).await));
    let local = call(&env, "projectFs/readText", json!({ "root": root, "rel": "../other/x" })).await;
    assert!(matches!(local, Err(CoreError::PermissionDenied { .. })), "{local:?}");
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

/// An unwatch whose request was cancelled before it ran still ends the OS watch: its record never goes without it.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_unwatch_still_ends_the_os_watch() {
    let env = env();
    env.service.call(request("fs/watch", json!({ "watchId": "w", "path": env.root.to_string_lossy(), "recursive": false }))).await.unwrap();
    assert_eq!(env.service.open_os_watches(), 1);
    let unwatch = request("fs/unwatch", json!({ "watchId": "w" }));
    unwatch.ctx.cancel.cancel();
    let _ = env.service.call(unwatch).await;
    assert_eq!(env.service.open_os_watches(), 0, "the record went and the OS watch with it");
}

/// Node's `folderWatch` took any absolute path (`absoluteLocalPath`, then `fs.watch`): a folder outside every project is watched, and a
/// missing one fails with the text `fs.watch` gives.
#[tokio::test(flavor = "multi_thread")]
async fn watch_takes_any_absolute_folder_and_a_missing_one_fails_like_fs_watch() {
    let env = env();
    let outside = std::env::temp_dir().join(format!("mixdog-watch-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    let reply = env.service.call(request("fs/watch", json!({ "watchId": "out", "path": outside.to_string_lossy(), "recursive": false }))).await.unwrap();
    assert!(matches!(reply, Reply::Subscribe(_)), "a folder outside the project is watched");
    std::fs::remove_dir_all(&outside).unwrap();

    let missing = std::env::temp_dir().join(format!("mixdog-watch-missing-{}", std::process::id()));
    let error = env
        .service
        .call(request("fs/watch", json!({ "watchId": "gone", "path": missing.to_string_lossy(), "recursive": false })))
        .await
        .err()
        .expect("a missing folder cannot be watched");
    let CoreError::DomainError { message: Some(message), .. } = &error else { panic!("a domain error, got {error:?}") };
    assert_eq!(&**message, format!("ENOENT: no such file or directory, watch '{}'", missing.display()));
}

/// Node's `folderWatch` runs `absoluteLocalPath` first and a relative path never reaches `fs.watch` (`relative/dir`
/// -> `path must be absolute.`). A relative path that
/// exists from the core's directory must be refused the same, not resolved and watched.
#[tokio::test(flavor = "multi_thread")]
async fn watch_refuses_a_relative_path_even_when_it_exists_from_the_working_directory() {
    let env = env();
    for relative in [".", "..", "src", "./src"] {
        let error = env
            .service
            .call(request("fs/watch", json!({ "watchId": "rel", "path": relative, "recursive": false })))
            .await
            .err()
            .unwrap_or_else(|| panic!("{relative:?} is relative and must not be watched"));
        assert!(format!("{error:?}").contains("path must be absolute."), "{relative:?}: {error:?}");
    }
    assert_eq!(env.service.open_os_watches(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_pushes_batched_changes_and_connection_close_drops_the_os_watch() {
    let env = env();
    // No event can reach the watcher before the watch exists, so every flush is at least a window after this instant.
    let began = std::time::Instant::now();
    let reply = env.service.call(request("fs/watch", json!({ "watchId": "w1", "path": env.root.to_string_lossy(), "recursive": true }))).await.unwrap();
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

/// A folder for the watch tests: `actual`, a junction `alias` to it, a folder Everyone
/// is denied listing, a file. The deny is undone and the folder removed when it goes, whatever the test did.
#[cfg(windows)]
struct WatchFolder(PathBuf);

#[cfg(windows)]
impl Drop for WatchFolder {
    fn drop(&mut self) {
        let _ = std::process::Command::new("icacls").args([&self.at("locked"), "/remove:d", "*S-1-1-0"]).stdout(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn search_session_ends_with_the_last_query_and_stop_frees_the_index() {
    let env = env();
    let reply = env.service.call(request("search/start", json!({ "sessionId": "q1", "roots": [env.root.to_string_lossy()] }))).await.unwrap();
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
        call(&env, "projectFs/replaceText", json!({ "root": root, "options": { "query": "one", "matchCase": true }, "replacement": "1" })).await.unwrap();
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
        Ok(mixdog_workspace::transfer::SourceFile {
            file: std::fs::File::open(&self.0).unwrap(),
            name: "session.md".into(),
            mime_type: "text/markdown".into(),
            cleanup: None,
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_domains_file_is_read_through_the_transfer_methods() {
    let env = env();
    // The desktop's own window reads it; a paired device downloads an export only through a download grant.
    let began = call_local(&env, "transfer/beginRead", json!({ "source": { "kind": "export", "id": "s1" } })).await.unwrap();
    assert_eq!((began["size"].clone(), began["entry"]["name"].clone(), began["mimeType"].clone()), (json!(8), json!("session.md"), json!("text/markdown")));
    let range = call_local(&env, "transfer/readRange", json!({ "transferId": began["transferId"], "offset": 0, "length": 8 })).await.unwrap();
    assert_eq!(range["eof"], true);
    let relayed = call(&env, "transfer/beginRead", json!({ "source": { "kind": "export", "id": "s1" } })).await;
    assert!(matches!(relayed, Err(CoreError::PermissionDenied { .. })), "{relayed:?}");
    // A kind nobody serves stays unsupported.
    let missing = call_local(&env, "transfer/beginRead", json!({ "source": { "kind": "mediaAsset", "id": "m" } })).await;
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
    async fn revert_turn_review_file(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn turn_changes(
        &self,
        _: &str,
        _: mixdog_core_api::turn_review::ChangesRead,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn revert_turn_changes(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: f64,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        unimplemented!()
    }
    async fn reapply_turn_changes(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: f64,
    ) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
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
    let noted = || -> Vec<Option<Vec<PathBuf>>> { log.0.lock().unwrap().iter().map(|n| n.as_ref().map(|p| p.iter().map(PathBuf::from).collect())).collect() };

    call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "two\n", "expectedContent": "one\n" })).await.unwrap();
    assert_eq!(noted(), [Some(vec![abs("a.txt")])]);

    // A refused write changed nothing and tells no one.
    let refused = call(&env, "projectFs/writeText", json!({ "root": root, "rel": "a.txt", "content": "x", "expectedContent": "stale" })).await;
    assert!(refused.is_err());
    assert_eq!(noted().len(), 1);

    call(
        &env,
        "projectFs/writeTextBatch",
        json!({ "root": root, "files": [
        { "relPath": "a.txt", "content": "three\n", "expectedContent": "two\n" },
        { "relPath": "readme.md", "content": "# yo\n", "expectedContent": "# hi\n" },
    ] }),
    )
    .await
    .unwrap();
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
    let ours: Vec<_> = trash::os_limited::list().unwrap().into_iter().filter(|item| item.original_path() == env.root.join("to-trash.txt")).collect();
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
    let too_long = call(&env, "project/codeGraph", json!({ "path": root, "mode": "references", "query": long })).await;
    assert!(matches!(&too_long, Err(CoreError::InvalidParams { expected, .. }) if &**expected == "Symbol is invalid."), "{too_long:?}");
    let denied = call(&env, "project/codeGraph", json!({ "path": env.root.parent().unwrap().to_string_lossy(), "mode": "symbols", "query": "a" })).await;
    // `host.codeGraphQuery` resolves the folder through `projectDirectory` (session-host.ts:776-781).
    assert!(unavailable(&denied), "{denied:?}");
}

fn futures_block<F: std::future::Future>(f: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(f))
}

/// `project/create` leaves `<project>/.mixdog/project.id` holding the folder's name and a newline (memory classification reads only
/// that), a path given with a trailing separator or a `..` spelling is the same project, and `project/touch` leaves the marker for a
/// project that was registered without one.
#[tokio::test(flavor = "multi_thread")]
async fn project_create_and_touch_leave_the_project_id_marker() {
    let env = env();
    let base = env.root.parent().unwrap().join("markers");
    for (phase, sub, spellings) in [("create", "a", vec!["a", "a/"]), ("create", "rel/proj", vec!["rel/proj", "rel/../rel/proj/."]), ("touch", "n", vec!["n"])]
    {
        let root = base.join(phase);
        std::fs::create_dir_all(root.join(sub)).unwrap();
        for spelling in spellings {
            let path = root.join(spelling).to_string_lossy().into_owned();
            if phase == "create" {
                call(&env, "project/create", json!({ "path": path })).await.unwrap();
            } else {
                let real = canonical(std::path::Path::new(&path)).unwrap().to_string_lossy().into_owned();
                let row = mixdog_store::state::ProjectRow { path: real, alias: None, hidden: false, hidden_rank: None, last_used_at: None, name: None };
                env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
                call(&env, "project/touch", json!({ "path": path })).await.unwrap();
            }
        }
        let marker = std::fs::read_to_string(root.join(sub).join(".mixdog").join("project.id")).unwrap_or_default();
        assert_eq!(marker, format!("{}\n", sub.rsplit('/').next().unwrap()), "{phase}: marker of {sub}");
    }
}

fn registry() -> (Env, PathBuf) {
    let env = env();
    let base = env.root.parent().unwrap().join("registry");
    for name in ["zeta", "alpha"] {
        std::fs::create_dir_all(base.join(name)).unwrap();
    }
    (env, base)
}

fn registry_path(base: &Path, name: &str) -> String {
    canonical(&base.join(name)).unwrap().to_string_lossy().into_owned()
}

async fn registered_names(env: &Env, base: &Path) -> Vec<String> {
    let listing = call(env, "project/list", json!({})).await.unwrap();
    listing["projects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["path"].as_str().unwrap().starts_with(&*base.to_string_lossy()))
        .map(|p| p["name"].as_str().unwrap().to_owned())
        .collect()
}

async fn register(env: &Env, base: &Path, name: &str) -> Value {
    call(env, "project/create", json!({ "path": registry_path(base, name) })).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_is_registered_under_its_own_name_and_listed_by_name() {
    let (env, base) = registry();
    let zeta = register(&env, &base, "zeta").await;
    assert_eq!((&zeta["project"]["name"], &zeta["project"]["alias"], &zeta["project"]["hidden"]), (&json!("zeta"), &Value::Null, &json!(false)));
    call(&env, "project/create", json!({ "path": format!("  {}  ", registry_path(&base, "alpha")) })).await.unwrap();
    assert_eq!(registered_names(&env, &base).await, ["alpha", "zeta"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_alias_renames_a_project_a_touch_lists_it_first_and_an_empty_alias_returns_its_name() {
    let (env, base) = registry();
    register(&env, &base, "zeta").await;
    register(&env, &base, "alpha").await;
    let renamed = call(&env, "project/update", json!({ "path": registry_path(&base, "zeta"), "alias": "  Aardvark " })).await.unwrap();
    assert_eq!((&renamed["project"]["name"], &renamed["project"]["alias"]), (&json!("Aardvark"), &json!("Aardvark")));
    call(&env, "project/touch", json!({ "path": registry_path(&base, "zeta") })).await.unwrap();
    assert_eq!(registered_names(&env, &base).await, ["Aardvark", "alpha"]);
    let back = call(&env, "project/update", json!({ "path": registry_path(&base, "zeta"), "alias": "" })).await.unwrap();
    assert_eq!((&back["project"]["name"], &back["project"]["alias"]), (&json!("zeta"), &Value::Null));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_folder_a_file_or_a_blank_path_is_no_project_and_an_unregistered_one_cannot_be_touched() {
    let (env, base) = registry();
    assert!(call(&env, "project/create", json!({ "path": base.join("missing").to_string_lossy() })).await.is_err(), "a folder that is not there is no project");
    assert!(call(&env, "project/create", json!({ "path": "   " })).await.is_err());
    std::fs::write(base.join("file.txt"), "x").unwrap();
    assert!(call(&env, "project/create", json!({ "path": base.join("file.txt").to_string_lossy() })).await.is_err(), "a file is no project");
    assert!(call(&env, "project/touch", json!({ "path": base.join("missing").to_string_lossy() })).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_read_probes_any_path_and_ensure_directory_makes_it() {
    let (env, base) = registry();
    std::fs::write(base.join("file.txt"), "x").unwrap();
    let probe = call(&env, "project/read", json!({ "path": base.join("file.txt").to_string_lossy() })).await.unwrap();
    assert_eq!((&probe["exists"], &probe["directory"]), (&json!(true), &json!(false)));
    let none = call(&env, "project/read", json!({ "path": base.join("nothing").to_string_lossy() })).await.unwrap();
    assert_eq!((&none["exists"], &none["directory"]), (&json!(false), &json!(false)));
    let made = call(&env, "project/ensureDirectory", json!({ "path": base.join("new/deep").to_string_lossy() })).await.unwrap();
    assert!(Path::new(made["path"].as_str().unwrap()).is_dir());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_folder_reports_removed_once_and_can_be_registered_again_under_its_own_name() {
    let (env, base) = registry();
    register(&env, &base, "zeta").await;
    register(&env, &base, "alpha").await;
    assert_eq!(call(&env, "project/delete", json!({ "path": registry_path(&base, "zeta") })).await.unwrap()["removed"], true);
    assert_eq!(call(&env, "project/delete", json!({ "path": registry_path(&base, "zeta") })).await.unwrap()["removed"], false);
    assert_eq!(registered_names(&env, &base).await, ["alpha"]);
    assert_eq!(register(&env, &base, "zeta").await["project"]["name"], "zeta");
}

#[tokio::test(flavor = "multi_thread")]
async fn project_directory_answers_a_registered_folders_own_path_and_refuses_a_folder_that_is_no_project() {
    let (env, base) = registry();
    register(&env, &base, "alpha").await;
    std::fs::create_dir_all(base.join("new")).unwrap();
    let directory = call(&env, "project/directory", json!({ "path": registry_path(&base, "alpha"), "owner": true })).await.unwrap();
    assert_eq!(directory["path"], registry_path(&base, "alpha").as_str());
    assert!(call(&env, "project/directory", json!({ "path": base.join("new").to_string_lossy() })).await.is_err());
}

/// A folder made by `project/ensureDirectory` is not a project: the registry's lookups (`project/directory`, `transfer/trash/info`) refuse
/// it until `project/create` registers it, `project/read` only sees a directory, and a registered folder is found under another spelling of
/// its path (the working directory, a `.\` prefix, another case) and answered by the spelling it was registered under.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_made_folder_is_no_project_until_it_is_registered_and_is_found_under_any_spelling() {
    let env = env();
    let tmp = env.root.parent().unwrap().to_path_buf();
    // The test needs a process of its own (nextest runs one).
    std::env::set_current_dir(&tmp).unwrap();
    let made = tmp.join("made").join("deep").to_string_lossy().into_owned();

    let ensured = call(&env, "project/ensureDirectory", json!({ "path": "made\\deep" })).await.unwrap();
    assert_eq!(ensured["path"], made.as_str());
    let read = call(&env, "project/read", json!({ "path": made })).await.unwrap();
    assert_eq!((&read["exists"], &read["directory"]), (&json!(true), &json!(true)));
    assert!(unavailable(&call(&env, "project/directory", json!({ "path": made })).await), "a folder that is no project has no directory");
    assert!(unavailable(&call(&env, "transfer/trash/info", json!({ "path": made })).await), "nor a trash");

    let created = call(&env, "project/create", json!({ "path": ".\\made\\deep" })).await.unwrap();
    assert_eq!(created["project"]["path"], made.as_str());
    let upper = made.to_uppercase();
    let found = call(&env, "project/directory", json!({ "path": upper })).await.unwrap();
    assert_eq!(found["path"], made.as_str(), "the lookup answers the registered spelling");
    let again = call(&env, "project/create", json!({ "path": upper })).await.unwrap();
    assert_eq!(again["project"]["path"], made.as_str(), "registering another case is the registered project");
}

/// An offered file name drops a leading dot run and a trailing dot, turns separators and reserved characters into `-`, falls back to
/// `download`, and is cut at 120 characters; the mime type is by extension, case-insensitively, and unknown ones are a byte stream.
#[test]
fn offered_names_and_mime_types_follow_their_rules() {
    for (input, name) in [
        ("report.pdf", "report.pdf"),
        (".hidden.png", "hidden.png"),
        ("a.", "a"),
        (".png", "png"),
        ("a/b\\c:d*.txt", "a-b-c-d-.txt"),
        ("  ..--x.md. ", "x.md"),
        ("...", "download"),
        ("", "download"),
        ("con<>.txt", "con-.txt"),
    ] {
        assert_eq!(mixdog_workspace::transfer::sanitized_file_name(input), name, "{input:?}");
    }
    assert_eq!(mixdog_workspace::transfer::sanitized_file_name(&format!("{}.png", "x".repeat(130))).chars().count(), 120);
    for (input, mime) in [
        (".png", "image/png"),
        ("a.PNG", "image/png"),
        ("C:\\x\\y.JPG", "image/jpeg"),
        ("a.b.md", "text/markdown"),
        ("a.", "application/octet-stream"),
        ("dir.png/noext", "application/octet-stream"),
        ("noext", "application/octet-stream"),
        ("x.unknown", "application/octet-stream"),
        (".gitignore", "application/octet-stream"),
    ] {
        assert_eq!(mixdog_workspace::fsops::mime_type(std::path::Path::new(input)), mime, "{input:?}");
    }
}

/// A transfer read: `begin` answers the file's size, name, mime type and range limit; a path out of the project is refused as a
/// permission denial; a range is the file's bytes with its length and whether it is the end; a range past the end is invalid;
/// after `endRead` the transfer is gone, and aborting an unknown transfer answers false.
#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_read_serves_ranges_of_the_file_until_it_ends() {
    let env = env();
    let root = env.root.to_string_lossy().into_owned();
    std::fs::write(env.root.join("report.bin"), b"0123456789abcdef".repeat(8)).unwrap();
    let began = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "report.bin" } })).await.unwrap();
    assert_eq!(
        (&began["size"], &began["entry"]["name"], &began["entry"]["rangeMaxBytes"], &began["mimeType"]),
        (&json!(128), &json!("report.bin"), &json!(4_194_304), &json!("application/octet-stream"))
    );
    let outside = call(&env, "transfer/beginRead", json!({ "source": { "kind": "file", "root": root, "rel": "../x" } })).await;
    assert!(matches!(&outside, Err(CoreError::PermissionDenied { .. })), "{outside:?}");
    let id = began["transferId"].as_str().unwrap().to_owned();
    let range = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 64 })).await.unwrap();
    assert_eq!(range["data"], "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg==");
    assert_eq!((&range["length"], &range["eof"]), (&json!(64), &json!(false)));
    let past = call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 1000, "length": 8 })).await;
    assert!(matches!(past, Err(CoreError::InvalidParams { .. })), "{past:?}");
    assert_eq!(call(&env, "transfer/endRead", json!({ "transferId": id })).await.unwrap()["ended"], true);
    assert!(call(&env, "transfer/readRange", json!({ "transferId": id, "offset": 0, "length": 8 })).await.is_err());
    assert_eq!(call(&env, "transfer/abort", json!({ "transferId": "nope" })).await.unwrap()["aborted"], false);
}

/// A project folder holding `files`, registered as a project row (not through `project/create`, which also writes a marker file).
async fn project_holding(env: &Env, name: &str, files: &[(&str, &[u8])]) -> String {
    let dir = env.root.parent().unwrap().join(name);
    std::fs::create_dir_all(&dir).unwrap();
    for (rel, data) in files {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }
    let row = mixdog_store::state::ProjectRow {
        path: dir.to_string_lossy().into_owned(),
        alias: None,
        hidden: false,
        hidden_rank: None,
        last_used_at: None,
        name: None,
    };
    env.state.write(move |tx| tx.put_project(&row)).await.unwrap();
    dir.to_string_lossy().into_owned()
}

fn entries(listing: &Value) -> Vec<(String, bool)> {
    listing.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().to_owned(), e["dir"].as_bool().unwrap())).collect()
}

/// A project folder lists folders first and then files, each in name order; a text file is read whole with its line endings, its
/// encoding named (a UTF-8 byte-order mark, UTF-16) and a binary file flagged without content; a path out of the project or a missing
/// file is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_project_folder_lists_and_reads_its_files() {
    let env = env();
    let root = project_holding(
        &env,
        "pf-read",
        &[
            ("utf8.txt", "héllo\nworld\n".as_bytes()),
            ("crlf.txt", b"a\r\nb\r\n"),
            ("bom8.txt", b"\xef\xbb\xbfbom\n"),
            ("utf16le.txt", b"\xff\xfeh\x00i\x00\n\x00"),
            ("bin.dat", &[0, 255, 0, 255, 1, 2, 3]),
            ("dir/inner.txt", b"inner\n"),
        ],
    )
    .await;
    let listing = call(&env, "projectFs/listDir", json!({ "root": root, "rel": "." })).await.unwrap();
    let file = |name: &str| (name.to_owned(), false);
    assert_eq!(entries(&listing), [("dir".to_owned(), true), file("bin.dat"), file("bom8.txt"), file("crlf.txt"), file("utf16le.txt"), file("utf8.txt")]);
    assert_eq!(entries(&call(&env, "projectFs/listDir", json!({ "root": root, "rel": "dir" })).await.unwrap()), [file("inner.txt")]);
    for (rel, binary, content, encoding) in [
        ("utf8.txt", false, "héllo\nworld\n", "utf8"),
        ("crlf.txt", false, "a\r\nb\r\n", "utf8"),
        ("bom8.txt", false, "bom\n", "utf8bom"),
        ("utf16le.txt", false, "hi\n", "utf16le"),
        ("bin.dat", true, "", "utf8"),
    ] {
        let mut read = call(&env, "projectFs/readText", json!({ "root": root, "rel": rel })).await.unwrap();
        // The answer carries the file's modification time (a number the test cannot know); the rest is the file's text and kind.
        assert!(read.as_object_mut().unwrap().remove("mtimeMs").unwrap().is_number(), "{rel}");
        assert_eq!(read, json!({ "binary": binary, "content": content, "encoding": encoding, "tooLarge": false }), "{rel}");
    }
    let stat = call(&env, "projectFs/stat", json!({ "root": root, "rel": "utf8.txt" })).await.unwrap();
    assert_eq!((stat["directory"].clone(), stat["size"].clone()), (json!(false), json!(13)));
    let outside = call(&env, "projectFs/readText", json!({ "root": root, "rel": "../escape.txt" })).await;
    assert!(matches!(&outside, Err(CoreError::PermissionDenied { .. })), "{outside:?}");
    let missing = call(&env, "projectFs/readText", json!({ "root": root, "rel": "missing.txt" })).await;
    assert!(matches!(&missing, Err(CoreError::DomainError { code, .. }) if code.as_deref() == Some("ENOENT")), "{missing:?}");
}

/// Writing needs the content the editor last saw: a different one is refused (`File changed on disk`) and leaves the file; the same
/// one is replaced. Entries are created (a name with a path in it is invalid), renamed, moved into a folder and copied.
#[tokio::test(flavor = "multi_thread")]
async fn a_project_file_is_written_only_over_what_the_editor_saw_and_entries_are_created_renamed_moved_and_copied() {
    let env = env();
    let root =
        project_holding(&env, "pf-write", &[("utf8.txt", "héllo\nworld\n".as_bytes()), ("crlf.txt", b"a\r\nb\r\n"), ("dir/inner.txt", b"inner\n")]).await;
    let mismatch = call(&env, "projectFs/writeText", json!({ "root": root, "rel": "utf8.txt", "content": "new", "expectedContent": "WRONG" })).await;
    assert!(matches!(&mismatch, Err(CoreError::PreconditionFailed { .. })), "{mismatch:?}");
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("utf8.txt")).unwrap(), "héllo\nworld\n");
    call(&env, "projectFs/writeText", json!({ "root": root, "rel": "utf8.txt", "content": "rewritten\n", "expectedContent": "héllo\nworld\n" })).await.unwrap();
    let read = call(&env, "projectFs/readText", json!({ "root": root, "rel": "utf8.txt" })).await.unwrap();
    assert_eq!(read["content"], "rewritten\n");

    call(&env, "projectFs/create", json!({ "root": root, "relDir": "dir", "name": "sub", "directory": true })).await.unwrap();
    let invalid = call(&env, "projectFs/create", json!({ "root": root, "relDir": "dir", "name": "a/../b", "directory": false })).await;
    assert!(matches!(&invalid, Err(CoreError::InvalidParams { .. })), "{invalid:?}");
    call(&env, "projectFs/rename", json!({ "root": root, "rel": "dir/inner.txt", "newName": "renamed.txt" })).await.unwrap();
    call(&env, "projectFs/move", json!({ "root": root, "rel": "dir/renamed.txt", "targetDirRel": "dir/sub" })).await.unwrap();
    let copied = call(&env, "projectFs/copy", json!({ "root": root, "rel": "crlf.txt", "targetDirRel": "dir" })).await.unwrap();
    assert_eq!(copied["name"], "crlf.txt");
    let listing = call(&env, "projectFs/listDir", json!({ "root": root, "rel": "dir" })).await.unwrap();
    assert_eq!(entries(&listing), [("sub".to_owned(), true), ("crlf.txt".to_owned(), false)]);
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("dir/sub/renamed.txt")).unwrap(), "inner\n");
}

fn matches_of(result: &Value) -> Vec<(String, Vec<(u64, u64, String)>)> {
    result["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            let found = file["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| (m["line"].as_u64().unwrap(), m["column"].as_u64().unwrap(), m["matchText"].as_str().unwrap().to_owned()))
                .collect();
            (file["relPath"].as_str().unwrap().to_owned(), found)
        })
        .collect()
}

async fn searchable_project() -> (Env, String) {
    let env = env();
    let root = project_holding(
        &env,
        "ws-search",
        &[
            ("a.txt", b"Hello World\nhello world\nHELLO\n"),
            ("src/x.mjs", b"const hello = \"Hello\";\nfunction helloWorld() {}\n"),
            ("node_modules/skip.js", b"hello skipped\n"),
            ("data.bin", &[0, 1, 2, 104, 101, 108, 108, 111]),
        ],
    )
    .await;
    env.service.catalog().add(&root, &CancellationToken::new(), None).await.unwrap();
    (env, root)
}

async fn search_text(env: &Env, root: &str, options: Value) -> Value {
    call(env, "projectFs/searchText", json!({ "root": root, "options": options })).await.unwrap()
}

fn text_match(line: u64, column: u64, text: &str) -> (u64, u64, String) {
    (line, column, text.to_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_ignores_case_reports_one_based_positions_and_skips_node_modules_and_binary_files() {
    let (env, root) = searchable_project().await;
    let m = text_match;
    let all = search_text(&env, &root, json!({ "query": "hello" })).await;
    assert_eq!(
        matches_of(&all),
        [
            ("a.txt".to_owned(), vec![m(1, 1, "Hello"), m(2, 1, "hello"), m(3, 1, "HELLO")]),
            ("src/x.mjs".to_owned(), vec![m(1, 7, "hello"), m(1, 16, "Hello"), m(2, 10, "hello")])
        ]
    );
    assert_eq!((all["matchCount"].clone(), all["limitHit"].clone()), (json!(6), json!(false)));
    assert_eq!(all["files"][0]["matches"][0]["preview"], "Hello World");
    assert_eq!((all["files"][0]["matches"][0]["endColumn"].clone()), json!(6));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_can_match_case() {
    let (env, root) = searchable_project().await;
    let m = text_match;
    let case = search_text(&env, &root, json!({ "query": "hello", "matchCase": true })).await;
    assert_eq!(matches_of(&case), [("a.txt".to_owned(), vec![m(2, 1, "hello")]), ("src/x.mjs".to_owned(), vec![m(1, 7, "hello"), m(2, 10, "hello")])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_whole_word_search_skips_a_longer_word() {
    let (env, root) = searchable_project().await;
    let word = search_text(&env, &root, json!({ "query": "hello", "wholeWord": true })).await;
    assert_eq!((word["matchCount"].clone(), matches_of(&word)[1].1.len()), (json!(5), 2), "`helloWorld` is not the word");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_can_be_a_regular_expression() {
    let (env, root) = searchable_project().await;
    let regex = search_text(&env, &root, json!({ "query": "hel+o\\w*", "regex": true })).await;
    assert_eq!((regex["matchCount"].clone(), matches_of(&regex)[1].1[2].clone()), (json!(6), text_match(2, 10, "helloWorld")));
}

#[tokio::test(flavor = "multi_thread")]
async fn include_and_exclude_globs_narrow_a_search() {
    let (env, root) = searchable_project().await;
    let only_mjs = search_text(&env, &root, json!({ "query": "hello", "include": "*.mjs" })).await;
    assert_eq!(matches_of(&only_mjs).iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["src/x.mjs"]);
    let not_src = search_text(&env, &root, json!({ "query": "hello", "exclude": "src/**" })).await;
    assert_eq!(matches_of(&not_src).iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["a.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_stops_at_max_results_and_says_so() {
    let (env, root) = searchable_project().await;
    let capped = search_text(&env, &root, json!({ "query": "hello", "maxResults": 2 })).await;
    assert_eq!((capped["matchCount"].clone(), capped["limitHit"].clone(), matches_of(&capped)[0].1.len()), (json!(2), json!(true), 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn replace_changes_exactly_the_matches_and_reports_the_files() {
    let (env, root) = searchable_project().await;
    let m = text_match;
    let replaced =
        call(&env, "projectFs/replaceText", json!({ "root": root, "options": { "query": "hello", "matchCase": true }, "replacement": "bye" })).await.unwrap();
    assert_eq!(replaced, json!({ "filesChanged": 2, "paths": ["a.txt", "src/x.mjs"], "replacements": 3 }));
    let after = search_text(&env, &root, json!({ "query": "bye" })).await;
    assert_eq!(matches_of(&after), [("a.txt".to_owned(), vec![m(2, 1, "bye")]), ("src/x.mjs".to_owned(), vec![m(1, 7, "bye"), m(2, 10, "bye")])]);
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("src/x.mjs")).unwrap(), "const bye = \"Hello\";\nfunction byeWorld() {}\n");
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("node_modules/skip.js")).unwrap(), "hello skipped\n");
}

/// A search pattern that is not a valid regular expression is refused with the text a user sees: `Invalid search pattern: Invalid
/// regular expression: /<pattern>/<flags>: <reason>`, the flags being `giu` (`gu` when case matters). One pattern per reason.
#[test]
fn an_invalid_search_pattern_is_refused_with_the_reason_a_user_reads() {
    use mixdog_workspace::textsearch::Pattern;
    use mixdog_workspace::textsearch::TextQuery;
    let cases = [
        ("(", "Unterminated group"),
        (")", "Unmatched ')'"),
        ("[", "Unterminated character class"),
        ("*", "Nothing to repeat"),
        ("a{2,1}", "numbers out of order in {} quantifier"),
        ("a{", "Incomplete quantifier"),
        ("{", "Lone quantifier brackets"),
        ("\\", "\\ at end of pattern"),
        ("\\u{110000}", "Invalid Unicode escape"),
        ("\\x", "Invalid escape"),
        ("\\p{Foo}", "Invalid property name"),
        ("\\k", "Invalid named reference"),
        ("\\k<a>", "Invalid named capture referenced"),
        ("(?<a>x)(?<a>y)", "Duplicate capture group name"),
        ("(?<1a>x)", "Invalid capture group name"),
        ("(?x)", "Invalid group"),
        ("[b-a]", "Range out of order in character class"),
        ("[\\d-a]", "Invalid character class"),
        ("\\00", "Invalid decimal escape"),
        ("(?=a)*", "Invalid quantifier"),
        ("[\\1]", "Invalid class escape"),
    ];
    for (query, reason) in cases {
        for (match_case, flags) in [(false, "giu"), (true, "gu")] {
            let refused = Pattern::compile(&TextQuery { query: query.into(), regex: true, match_case, ..Default::default() })
                .err()
                .unwrap_or_else(|| panic!("{query:?} compiles"));
            assert_eq!(refused.message, format!("Invalid search pattern: Invalid regular expression: /{query}/{flags}: {reason}"), "{query:?}");
        }
    }
    for valid in ["hel+o\\w*", "(?<name>a)\\k<name>", "[a-z]{2,3}", "\\p{L}+", "a|b"] {
        assert!(Pattern::compile(&TextQuery { query: valid.into(), regex: true, ..Default::default() }).is_ok(), "{valid:?}");
    }
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
    // An entry beyond the project fails the call (Node's `projectEntryPathIn` threw) and publishes no status: the first one
    // below is the open's `starting` at revision 1.
    let outside = call(&env, "lsp/document", json!({ "projectPath": root, "root": root, "document": { "kind": "open", "languageId": "typescript", "relPath": "../x.ts", "content": "x", "version": 1 } })).await;
    assert!(matches!(outside, Err(CoreError::PermissionDenied { .. })), "{outside:?}");
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
    let snapshot = conn2
        .drain_text_until(|texts| texts.iter().any(|f| f.contains("feed/snapshot")))
        .await
        .into_iter()
        .find(|f| f.contains("feed/snapshot"))
        .expect("a snapshot");
    assert!(snapshot.contains("lspStatus") && snapshot.contains(key.replace('\0', "\\u0000").as_str()), "{snapshot}");
}

// ---- the phone's start calls: what Node's `canonicalDirectory`, `knownProject` and `enter` answered (fixtures/phone-chat/host.json) --------

/// Node read a file once, through one authorized handle (`readProjectTextFileAuthorized`), and answered that one version. The windows of one
/// read come from the one read the first window made: a file replaced between two windows changes nothing the reader joins. Node's answer
/// is the one the file had when read (1 MiB + 1 byte of text, so the phone reads it in windows).
#[tokio::test(flavor = "multi_thread")]
async fn the_windows_of_one_read_are_one_version_of_a_file_replaced_between_them() {
    let text = "b".repeat(1_048_577);
    let at_ms = 1_767_323_045_000_u64;
    let expected = json!({ "mtimeMs": at_ms, "binary": false, "tooLarge": false, "readOnly": true, "encoding": "utf8" });
    let env = env();
    let file = env.root.join("toolong.txt");
    let pin = |ms: u64| {
        let open = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
        open.set_modified(std::time::UNIX_EPOCH + Duration::from_millis(ms)).unwrap();
    };
    std::fs::write(&file, &text).unwrap();
    pin(at_ms);
    let root = env.root.to_string_lossy().into_owned();
    let window = 60_000u64;
    let mut part = call(&env, "projectFs/readText", json!({ "root": root, "rel": "toolong.txt", "authorized": true, "maxChars": window })).await.unwrap();
    let mut joined = part["content"].as_str().unwrap().to_owned();
    // The file is replaced (other text, other time) after the first window.
    std::fs::write(&file, "c".repeat(text.len())).unwrap();
    pin(at_ms + 1_000_000);
    while let Some(next) = part.get("nextChar").and_then(Value::as_u64) {
        let read_id = part["readId"].clone();
        part = call(
            &env,
            "projectFs/readText",
            json!({ "root": root, "rel": "toolong.txt", "authorized": true, "readId": read_id, "fromChar": next, "maxChars": window }),
        )
        .await
        .unwrap();
        joined.push_str(part["content"].as_str().unwrap());
    }
    assert!(joined == text, "the joined windows are the first version of the file ({} of {} bytes)", joined.len(), text.len());
    // One JSON number to the phone, whether the core writes it as an integer or a float.
    assert_eq!(part["mtimeMs"].as_f64(), expected["mtimeMs"].as_f64(), "the time of the first read");
    for field in ["binary", "tooLarge", "readOnly", "encoding"] {
        assert_eq!(part[field], expected[field], "{field} of the first read");
    }
    assert_eq!(part.as_object().unwrap().len(), expected.as_object().unwrap().len() + 1, "the fields of a window: the recorded ones and the content");
}
struct RelayRig {
    env: Env,
    outside: PathBuf,
    granted: String,
}

struct Step {
    call: &'static str,
    dir: &'static str,
    rel: &'static str,
    tokened: bool,
    content: &'static str,
    expected: &'static str,
    frame: Value,
}

impl Step {
    fn new(call: &'static str, dir: &'static str, rel: &'static str, tokened: bool, content: &'static str, expected: &'static str, frame: Value) -> Self {
        Self { call, dir, rel, tokened, content, expected, frame }
    }
}

const PREVIEW_NEEDS_A_PAGE: &str = "A document preview needs at least one page.";

fn project_unavailable() -> Value {
    json!({ "ok": false, "error": "Project is not available.", "errorCode": "PROJECT_UNAVAILABLE" })
}

fn beyond_the_project_frame() -> Value {
    json!({ "ok": false, "error": "Path is outside the project." })
}

fn saved_backup(content: &str, expected: &str) -> Value {
    json!({ "ok": true, "value": { "content": content, "expectedContent": expected, "updatedAt": 1_780_819_750_000_u64 } })
}

fn no_backup() -> Value {
    json!({ "ok": true, "value": null })
}

async fn relay_rig() -> RelayRig {
    // SAFETY: nextest runs each test in its own process, and nothing else in this one reads the environment concurrently yet.
    unsafe { std::env::set_var("MIXDOG_FIXED_NOW_MS", PHONE_FILES_NOW_MS) };
    let env = env();
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 1).then(|| "phone-1".to_owned())),
    );
    let outside = env.root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("granted.txt"), "granted edit\n").unwrap();
    std::fs::write(outside.join("other.txt"), "other\n").unwrap();
    std::fs::write(env.root.join("src/a.ts"), "export const a = 1;\n").unwrap();
    let granted = outside.join("granted.txt").to_string_lossy().into_owned();
    call(&env, "transfer/grant/mint", json!({ "path": granted })).await.unwrap();
    RelayRig { env, outside, granted }
}

impl RelayRig {
    fn place(&self, dir: &str) -> PathBuf {
        if dir == "proj" { self.env.root.clone() } else { self.outside.clone() }
    }

    async fn run(&self, steps: Vec<Step>) {
        let env = &self.env;
        for Step { call: name, dir, rel, tokened, content, expected, frame } in steps {
            let file = || -> String { if tokened { self.granted.clone() } else { self.place(dir).join(rel).to_string_lossy().into_owned() } };
            let answer = match name {
                "readEditorBackup" => call(env, "projectFs/backup/read", json!({ "sourcePath": file() })).await,
                "deleteEditorBackup" => call(env, "projectFs/backup/delete", json!({ "sourcePath": file() })).await.map(|_| Value::Null),
                "writeEditorBackup" => {
                    call(env, "projectFs/backup/write", json!({ "sourcePath": file(), "content": content, "expectedContent": expected })).await
                }
                "previewDocumentPages" => {
                    let (root, rel) = if tokened {
                        let path = PathBuf::from(self.granted.clone());
                        (path.parent().unwrap().to_string_lossy().into_owned(), path.file_name().unwrap().to_string_lossy().into_owned())
                    } else {
                        (self.place(dir).to_string_lossy().into_owned(), rel.to_owned())
                    };
                    let admitted = env.service.relay_file(&request("document/previewPages", json!({})), &root, &rel).await;
                    if frame["ok"] == false && frame["error"] != PREVIEW_NEEDS_A_PAGE {
                        admitted.map(|_| Value::Null)
                    } else {
                        assert!(admitted.is_ok(), "{name} {dir}/{rel}: {admitted:?}");
                        continue;
                    }
                }
                _ => unreachable!(),
            };
            let got = match answer {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(CoreError::DomainError { code, message, .. }) => {
                    let mut node = json!({ "ok": false, "error": message.as_deref() });
                    if let Some(code) = code.as_deref() {
                        node["errorCode"] = json!(code);
                    }
                    node
                }
                Err(other) => panic!("{name} {dir}/{rel}: {other:?}"),
            };
            assert_eq!(got, frame, "{name} {dir}/{rel}");
        }
        let kept: Vec<_> = std::fs::read_dir(env.root.parent().unwrap().join("userData").join("editor-backups")).map(|dir| dir.count()).into_iter().collect();
        assert!(kept.iter().all(|count| *count == 0), "{kept:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_of_a_granted_file_is_written_read_and_deleted() {
    let rig = relay_rig().await;
    rig.run(vec![
        Step::new("writeEditorBackup", "outside", "granted.txt", true, "draft granted\n", "granted edit\n", saved_backup("draft granted\n", "granted edit\n")),
        Step::new("readEditorBackup", "outside", "granted.txt", true, "", "", saved_backup("draft granted\n", "granted edit\n")),
        Step::new("deleteEditorBackup", "outside", "granted.txt", true, "", "", no_backup()),
        Step::new("readEditorBackup", "outside", "granted.txt", true, "", "", no_backup()),
    ])
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_or_preview_of_an_ungranted_file_beside_the_project_is_refused() {
    let rig = relay_rig().await;
    rig.run(vec![
        Step::new("writeEditorBackup", "outside", "other.txt", false, "planted\n", "other\n", project_unavailable()),
        Step::new("readEditorBackup", "outside", "other.txt", false, "", "", project_unavailable()),
        Step::new("deleteEditorBackup", "outside", "other.txt", false, "", "", project_unavailable()),
        Step::new("previewDocumentPages", "outside", "other.txt", false, "", "", project_unavailable()),
    ])
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_or_preview_that_goes_out_of_the_project_by_dots_is_refused() {
    let rig = relay_rig().await;
    rig.run(vec![
        Step::new("writeEditorBackup", "proj", "../outside/other.txt", false, "planted\n", "other\n", beyond_the_project_frame()),
        Step::new("readEditorBackup", "proj", "../outside/other.txt", false, "", "", beyond_the_project_frame()),
        Step::new("deleteEditorBackup", "proj", "../outside/other.txt", false, "", "", beyond_the_project_frame()),
        Step::new("previewDocumentPages", "proj", "../outside/other.txt", false, "", "", beyond_the_project_frame()),
    ])
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_backup_of_a_project_file_is_written_read_and_deleted() {
    let rig = relay_rig().await;
    rig.run(vec![
        Step::new(
            "writeEditorBackup",
            "proj",
            "src/a.ts",
            false,
            "relay draft\n",
            "export const a = 1;\n",
            saved_backup("relay draft\n", "export const a = 1;\n"),
        ),
        Step::new("readEditorBackup", "proj", "src/a.ts", false, "", "", saved_backup("relay draft\n", "export const a = 1;\n")),
        Step::new("deleteEditorBackup", "proj", "src/a.ts", false, "", "", no_backup()),
        Step::new("readEditorBackup", "proj", "src/a.ts", false, "", "", no_backup()),
    ])
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_document_preview_admits_a_granted_file_and_the_conversion_answers_for_itself() {
    let rig = relay_rig().await;
    rig.run(vec![Step::new("previewDocumentPages", "outside", "granted.txt", true, "", "", json!({ "ok": false, "error": PREVIEW_NEEDS_A_PAGE }))]).await;
}
/// Every input `absoluteLocalPath` refuses is refused by `fs/watch` with its message, and nothing is watched; a non-string `path`
/// included.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn watch_refuses_every_input_the_path_rule_refuses_with_its_message() {
    let absolute = "path must be absolute.";
    let (invalid, not_text) = ("path is invalid.", "path must be a string.");
    let too_long = format!("C:\\{}", "a".repeat(16_382));
    let cases: Vec<(&str, Option<Value>, &str)> = vec![
        ("relative", Some(json!("relative/dir")), absolute),
        ("dot", Some(json!(".")), absolute),
        ("dot-dot", Some(json!("..")), absolute),
        ("dot slash", Some(json!("./x")), absolute),
        ("dot-dot backslash", Some(json!("..\\x")), absolute),
        ("drive-relative", Some(json!("C:foo")), absolute),
        ("drive-relative other drive", Some(json!("D:foo")), absolute),
        ("drive only", Some(json!("C:")), absolute),
        ("empty", Some(json!("")), invalid),
        ("blank", Some(json!("   ")), invalid),
        ("NUL inside", Some(json!("a\u{0}b")), invalid),
        ("NUL after a drive-absolute path", Some(json!("C:\\a\u{0}")), invalid),
        ("16385 characters", Some(json!(too_long)), invalid),
        ("null", Some(Value::Null), not_text),
        ("number", Some(json!(123)), not_text),
        ("true", Some(json!(true)), not_text),
        ("object", Some(json!({})), not_text),
        ("array", Some(json!([])), not_text),
        ("object with a path", Some(json!({ "path": "C:\\x" })), not_text),
        ("undefined", None, not_text),
    ];
    let env = env();
    for (name, value, message) in cases {
        let mut params = json!({ "watchId": "refused", "recursive": false });
        if let Some(value) = value {
            params["path"] = value;
        }
        let error = env.service.call(request("fs/watch", params)).await.err().unwrap_or_else(|| panic!("{name}: it was refused by the rule and watched"));
        assert!(format!("{error:?}").contains(message), "{name}: expected {message:?}, got {error:?}");
    }
    assert_eq!(env.service.open_os_watches(), 0);
}
#[cfg(windows)]
impl WatchFolder {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mixdog-folder-watch-{}", std::process::id()));
        std::fs::create_dir_all(root.join("actual")).unwrap();
        std::fs::create_dir(root.join("locked")).unwrap();
        std::fs::write(root.join("afile.txt"), "a").unwrap();
        let folder = Self(root);
        folder.run("cmd", &["/c", "mklink", "/J", &folder.at("alias"), &folder.at("actual")]);
        folder.run("icacls", &[&folder.at("locked"), "/deny", "*S-1-1-0:(RD)"]);
        folder
    }

    fn at(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }

    fn fill(&self, template: &str) -> String {
        template.replace("{root}", &self.0.to_string_lossy())
    }

    fn run(&self, program: &str, args: &[&str]) {
        let status = std::process::Command::new(program).args(args).stdout(std::process::Stdio::null()).status().unwrap();
        assert!(status.success(), "{program} {args:?}: {status}");
    }
}

/// Whether `SeBackupPrivilege` is enabled in this process's token. A folder opened with `FILE_FLAG_BACKUP_SEMANTICS` (as `fs.watch` and
/// the watcher open one) passes a deny entry only then, so with it no folder is unlistable to the process.
#[cfg(windows)]
fn backup_privilege_is_enabled() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Foundation::LUID;
    use windows_sys::Win32::Security::GetTokenInformation;
    use windows_sys::Win32::Security::LUID_AND_ATTRIBUTES;
    use windows_sys::Win32::Security::LookupPrivilegeValueW;
    use windows_sys::Win32::Security::SE_PRIVILEGE_ENABLED;
    use windows_sys::Win32::Security::TOKEN_PRIVILEGES;
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::Security::TokenPrivileges;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    let name: Vec<u16> = "SeBackupPrivilege\0".encode_utf16().collect();
    let mut backup = LUID { LowPart: 0, HighPart: 0 };
    let mut token: HANDLE = std::ptr::null_mut();
    let mut needed = 0u32;
    // SAFETY: every pointer is to a local that outlives its call; the token is closed once read, and the buffer is 8-byte aligned and
    // sized by the first query for the TOKEN_PRIVILEGES the second fills.
    unsafe {
        assert!(LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut backup) != 0, "{}", std::io::Error::last_os_error());
        assert!(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0, "{}", std::io::Error::last_os_error());
        GetTokenInformation(token, TokenPrivileges, std::ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let size = needed;
        let read = GetTokenInformation(token, TokenPrivileges, buffer.as_mut_ptr().cast(), size, &mut needed);
        let error = std::io::Error::last_os_error();
        CloseHandle(token);
        assert!(read != 0, "{error}");
        // The entries start where Privileges does inside the allocation; no reference to the one-element array is made, and no more entries
        // are read than the bytes returned hold.
        let header = std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges);
        let entries = buffer.as_ptr().cast::<u8>().add(header).cast::<LUID_AND_ATTRIBUTES>();
        let room = (needed as usize).saturating_sub(header) / std::mem::size_of::<LUID_AND_ATTRIBUTES>();
        let count = (*buffer.as_ptr().cast::<TOKEN_PRIVILEGES>()).PrivilegeCount as usize;
        (0..count.min(room)).any(|at| {
            let entry = entries.add(at).read_unaligned();
            entry.Luid.LowPart == backup.LowPart && entry.Luid.HighPart == backup.HighPart && entry.Attributes & SE_PRIVILEGE_ENABLED != 0
        })
    }
}
#[cfg(windows)]
async fn watch_feed(env: &Env, conn: &MockConnection, id: &'static str, path: String, recursive: bool) -> Result<(), CoreError> {
    let reply = env.service.call(request("fs/watch", json!({ "watchId": id, "path": path, "recursive": recursive }))).await?;
    let Reply::Subscribe(sub) = reply else { panic!("fs/watch must subscribe") };
    let attached = subscribe(&sub.feed, SubscriptionId::from(id), sub.window, None, conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    Ok(())
}

#[cfg(windows)]
fn changed_under(frames: &[String], id: &str) -> Vec<String> {
    frames
        .iter()
        .filter_map(|frame| serde_json::from_str::<Value>(frame.split_once(':').map_or("", |(_, text)| text)).ok())
        .filter(|frame| frame["method"] == "fs/changed" && frame["params"]["watchId"] == id)
        .flat_map(|frame| frame["params"]["changedPaths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect::<Vec<_>>())
        .collect()
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_folder_and_a_junction_to_it_are_two_watches_each_reporting_under_its_own_name() {
    let golden = json!({
        "fsWatchPaths": ["{root}\\alias", "{root}\\actual"],
        "reportedUnder": [{ "dir": "{root}\\alias" }, { "dir": "{root}\\actual" }],
    });
    let env = env();
    let folder = WatchFolder::new();
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let paths: Vec<String> = golden["fsWatchPaths"].as_array().unwrap().iter().map(|p| folder.fill(p.as_str().unwrap())).collect();
    let ids = ["name-1", "name-2"];
    for (id, path) in ids.iter().zip(&paths) {
        watch_feed(&env, &conn, id, path.clone(), true).await.unwrap();
    }
    assert_eq!(env.service.open_os_watches(), paths.len(), "one OS watch per name, for the {} names", paths.len());
    std::fs::write(folder.0.join("actual").join("changed.txt"), "1").unwrap();
    let frames = mixdog_rt::time::timeout(Duration::from_secs(60), conn.drain_text_until(|texts| ids.iter().all(|id| !changed_under(texts, id).is_empty())))
        .await
        .expect("a change under each name within 60 s");
    for (id, reported) in ids.iter().zip(golden["reportedUnder"].as_array().unwrap()) {
        let dir = folder.fill(reported["dir"].as_str().unwrap());
        let paths = changed_under(&frames, id);
        assert!(paths.iter().all(|path| path.starts_with(&format!("{dir}\\"))), "{id}: every change is reported under {dir}: {paths:?}");
    }
    env.service.connection_closed(&ConnectionId(1));
    assert_eq!(env.service.open_os_watches(), 0);
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_path_fs_watch_refuses_fails_with_its_own_code_and_text_and_a_file_is_watched() {
    let golden = json!([
        { "name": "missing folder", "path": "{root}\\missing", "answer": { "error": { "message": "ENOENT: no such file or directory, watch '{root}\\missing'", "code": "ENOENT" } } },
        { "name": "folder the user may not list", "path": "{root}\\locked", "answer": { "error": { "message": "EPERM: operation not permitted, watch '{root}\\locked'", "code": "EPERM" } } },
        { "name": "a file", "path": "{root}\\afile.txt", "answer": { "watched": true }, "reportedUnder": "{root}\\afile.txt" },
    ]);
    let env = env();
    let folder = WatchFolder::new();
    let conn = MockConnection::new(ConnectionId(1), env.limits);
    let ids = ["fail-1", "fail-2", "fail-3"];
    for (id, case) in ids.iter().zip(golden.as_array().unwrap()) {
        let path = folder.fill(case["path"].as_str().unwrap());
        if case["name"] == "folder the user may not list" && backup_privilege_is_enabled() {
            eprintln!("skipped: {}: needs a process without SeBackupPrivilege enabled in its token, which opens any folder", case["name"]);
            continue;
        }
        let got = watch_feed(&env, &conn, id, path.clone(), false).await;
        match case["answer"].get("error") {
            Some(error) => {
                let Err(CoreError::DomainError { code, message, .. }) = got else { panic!("{}: Node failed with {error}, got {got:?}", case["name"]) };
                assert_eq!(message.as_deref(), Some(folder.fill(error["message"].as_str().unwrap()).as_str()), "{}", case["name"]);
                assert_eq!(code.as_deref(), error["code"].as_str(), "{}", case["name"]);
            }
            None => {
                got.unwrap_or_else(|error| panic!("{}: Node watched it, got {error:?}", case["name"]));
                std::fs::write(&path, "b").unwrap();
                let frames = mixdog_rt::time::timeout(Duration::from_secs(60), conn.drain_text_until(|texts| !changed_under(texts, id).is_empty()))
                    .await
                    .expect("the watched file's change within 60 s");
                let under = folder.fill(case["reportedUnder"].as_str().unwrap());
                assert!(changed_under(&frames, id).iter().all(|p| *p == under), "{}: reported under {under}: {:?}", case["name"], changed_under(&frames, id));
            }
        }
    }
    env.service.connection_closed(&ConnectionId(1));
}
// ---- DS-WS-1: the service's answers ----------------------------------------------------------------
