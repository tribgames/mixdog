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
        user_data_dir: base.join("userdata"),
    })
    .unwrap();
    futures_block(service.catalog().add(&root.to_string_lossy(), &CancellationToken::new(), None)).unwrap();
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
    tokio::time::sleep(Duration::from_millis(900)).await;
    let frames: Vec<String> = conn.drain_text().into_iter().filter(|f| f.contains("fs/changed")).collect();
    assert!((1..=5).contains(&frames.len()), "{} notifications", frames.len());
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
    tokio::time::sleep(Duration::from_millis(600)).await;
    let updates: Vec<String> = conn.drain_text().into_iter().filter(|f| f.contains("search/updated")).collect();
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
        call(&env, "projectFs/replaceText", json!({ "root": root, "options": { "query": "one", "replacement": "1", "matchCase": true } }))
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
                let mut options = args[0].clone();
                options["replacement"] = args[1].clone();
                ("projectFs/replaceText", json!({ "root": root, "options": options }))
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
    env.service.catalog().add(&pf.to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
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

#[tokio::test(flavor = "multi_thread")]
async fn recorded_lsp_registry_and_unsupported_answers_replay() {
    let env = env();
    let fixture = corpus("lsp");
    let find = |op: &str| fixture["entries"].as_array().unwrap().iter().find(|e| e["op"] == op).unwrap().clone();
    let root = env.root.to_string_lossy().into_owned();
    let doc = call(&env, "lsp/document", json!({ "root": root, "document": { "kind": "open", "languageId": "plaintext", "relPath": "a.xyz", "content": "x", "version": 1 } })).await.unwrap();
    assert_eq!(doc, find("lspDocument")["result"]);
    let request = call(
        &env,
        "lsp/request",
        json!({ "root": root, "request": { "relPath": "a.xyz", "languageId": "plaintext", "method": "textDocument/hover", "params": { "position": { "line": 0, "character": 0 } } } }),
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
