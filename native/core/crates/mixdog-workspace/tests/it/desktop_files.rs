#![allow(clippy::disallowed_types, reason = "test setup")]
#![allow(clippy::disallowed_methods, reason = "test setup")]
//! The desktop file grants, standalone roots and page server through the workspace `DomainService`.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::Origin;
use mixdog_store::state::CoreState;
use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::service::Deps;
use mixdog_workspace::service::WorkspaceService;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

struct NoGit;

#[async_trait::async_trait]
impl mixdog_workspace::zip::TrackedFiles for NoGit {
    async fn files(&self, _: &Path, _: &CancellationToken) -> Option<Vec<String>> {
        None
    }
    async fn ignored(&self, _: &Path, _: &CancellationToken) -> Option<u64> {
        None
    }
}

struct Env {
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    service: Arc<WorkspaceService>,
}

/// A service with one registered project and the desktop files enabled (unless `enabled` is false).
fn env(enabled: bool) -> Env {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("page.html"), "<p>project page</p>").unwrap();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("core.sqlite")).unwrap();
    let service = WorkspaceService::new(Deps {
        lanes: Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk },
        feeds: Arc::new(MockScopedFeeds::new(MockLimits::default())),
        processes: Arc::new(MockProcessManager::default()),
        tracked: Arc::new(NoGit),
        state: state.clone(),
        recovery_dir: base.join("recovery"),
        user_data_dir: base.join("userData"),
        sources: Vec::new(),
        code_graph: None,
        turn_review: None,
        releases: mixdog_workspace::release::FolderReleases::new(),
    })
    .unwrap();
    let row = mixdog_store::state::ProjectRow { path: root.to_string_lossy().into_owned(), alias: None, hidden: false, hidden_rank: None, last_used_at: None, name: None };
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(state.write(move |tx| tx.put_project(&row)))).unwrap();
    if enabled {
        service.enable_desktop_files(base.join("data/desktop/selected-file-grants.json"), base.join("data/desktop/page-server.json"));
    }
    Env { _dir: dir, base, root, service }
}

async fn call_as(env: &Env, origin: Origin, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(2), origin, CancellationToken::new());
    match env.service.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
        Reply::Value(v) => Ok(v),
        Reply::Subscribe(_) => panic!("unexpected subscribe"),
    }
}

async fn local(env: &Env, method: &'static str, params: Value) -> Result<Value, CoreError> {
    call_as(env, Origin::Local, method, params).await
}

/// A file outside every project, described and granted: its folder, its name and the token.
async fn granted_file(env: &Env, name: &str, text: &str) -> (PathBuf, String, String) {
    let folder = env.base.join("outside");
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join(name);
    std::fs::write(&file, text).unwrap();
    let described = local(env, "projectFs/grant/describe", json!({ "paths": [file.to_string_lossy()] })).await.unwrap();
    let row = &described[0];
    assert_eq!(row["name"], name);
    (folder, row["relPath"].as_str().unwrap().to_owned(), row["accessToken"].as_str().expect("a minted token").to_owned())
}

async fn get(url: &str) -> (u16, String) {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut stream = TcpStream::connect(host).await.unwrap();
    stream.write_all(format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split(' ').nth(1).unwrap().parse().unwrap();
    (status, text.split_once("\r\n\r\n").map(|(_, body)| body.to_owned()).unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread")]
async fn describe_and_redeem_round_trip_and_a_local_token_reads_the_file() {
    let env = env(true);
    let (folder, rel, token) = granted_file(&env, "note.txt", "granted text").await;
    let redeemed = local(&env, "projectFs/grant/redeem", json!({ "accessToken": token, "projectPath": folder.to_string_lossy(), "relPath": rel })).await.unwrap();
    assert_eq!((redeemed["rel"].clone(), redeemed["root"].as_str().map(PathBuf::from)), (json!("note.txt"), Some(folder.clone())));
    // A path the grant does not name is refused with its code.
    let other = local(&env, "projectFs/grant/redeem", json!({ "accessToken": token, "projectPath": folder.to_string_lossy(), "relPath": "other.txt" })).await;
    assert!(matches!(&other, Err(CoreError::DomainError { code, .. }) if code.as_deref() == Some("MIXDOG_LOCAL_ACCESS_DENIED")), "{other:?}");
    let read = local(&env, "projectFs/readText", json!({ "root": folder.to_string_lossy(), "rel": rel, "accessToken": token })).await.unwrap();
    assert_eq!(read["content"], "granted text");
    // A file inside the registered project is described with that project and needs no token.
    let inside = local(&env, "projectFs/grant/describe", json!({ "paths": [env.root.join("page.html").to_string_lossy()] })).await.unwrap();
    assert_eq!((inside[0]["projectPath"].as_str().map(PathBuf::from), inside[0]["relPath"].clone(), inside[0]["accessToken"].clone()), (Some(env.root.clone()), json!("page.html"), Value::Null));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_token_is_the_phone_table_and_never_the_desktop_one() {
    let env = env(true);
    let (folder, rel, token) = granted_file(&env, "note.txt", "x").await;
    // No paired-device table is connected: the relay path answers as before, and a desktop token is not a phone token.
    let read = call_as(&env, Origin::Relay, "projectFs/readText", json!({ "root": folder.to_string_lossy(), "rel": rel, "accessToken": token })).await;
    assert!(read.is_err(), "{read:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_page_url_loads_over_http_and_revoking_the_owner_ends_it() {
    let env = env(true);
    let origin = local(&env, "projectFs/localPage/origin", json!({})).await.unwrap();
    assert!(origin.as_str().unwrap().starts_with("http://127.0.0.1:"));
    assert_eq!(local(&env, "projectFs/localPage/origin", json!({})).await.unwrap(), origin);
    let url = local(&env, "projectFs/localPageUrl", json!({ "root": env.root.to_string_lossy(), "rel": "page.html", "ownerId": "window-1" })).await.unwrap();
    let url = url.as_str().unwrap().to_owned();
    assert!(url.starts_with(origin.as_str().unwrap()), "{url}");
    assert_eq!(get(&url).await, (200, "<p>project page</p>".to_owned()));
    local(&env, "projectFs/localPage/revokeOwner", json!({ "ownerId": "window-1" })).await.unwrap();
    assert_eq!(get(&url).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_one_file_grant_leases_that_file_alone() {
    let env = env(true);
    let (folder, rel, token) = granted_file(&env, "granted.html", "<p>granted page</p>").await;
    std::fs::write(folder.join("sibling.html"), "<p>sibling</p>").unwrap();
    let url = local(&env, "projectFs/localPageUrl", json!({ "root": folder.to_string_lossy(), "rel": rel, "accessToken": token })).await.unwrap();
    // A one-file grant is a sandboxed lease: its HTML document carries the storage shim first (local-page-server.ts withShim).
    let (status, body) = get(url.as_str().unwrap()).await;
    assert_eq!(status, 200);
    assert!(body.contains("<script") && body.ends_with("<p>granted page</p>"), "{body}");
    // The token names one file: asking for its sibling under it is refused.
    let sibling = local(&env, "projectFs/localPageUrl", json!({ "root": folder.to_string_lossy(), "rel": "sibling.html", "accessToken": token })).await;
    assert!(sibling.is_err(), "{sibling:?}");
}

struct NoneGone;

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for NoneGone {
    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_one_file_grant_leases_that_file_alone() {
    let env = env(true);
    env.service.set_phone_grants(
        Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(NoneGone))),
        Arc::new(|connection: ConnectionId| (connection.0 == 2).then(|| "phone-1".to_owned())),
    );
    let folder = env.base.join("phone-outside");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("phone.html"), "<p>phone page</p>").unwrap();
    std::fs::write(folder.join("sibling.html"), "<p>sibling</p>").unwrap();
    let minted = call_as(&env, Origin::Relay, "transfer/grant/mint", json!({ "path": folder.join("phone.html").to_string_lossy() })).await.unwrap();
    let (root, rel, token) = (minted["projectPath"].clone(), minted["relPath"].clone(), minted["accessToken"].clone());
    let url = call_as(&env, Origin::Relay, "projectFs/localPageUrl", json!({ "root": root, "rel": rel, "accessToken": token })).await.unwrap();
    // A one-file grant is a sandboxed lease: its HTML document carries the storage shim first (local-page-server.ts withShim).
    let (status, body) = get(url.as_str().unwrap()).await;
    assert_eq!(status, 200);
    assert!(body.contains("<script") && body.ends_with("<p>phone page</p>"), "{body}");
    let sibling = call_as(&env, Origin::Relay, "projectFs/localPageUrl", json!({ "root": root, "rel": "sibling.html", "accessToken": token })).await;
    assert!(sibling.is_err(), "{sibling:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_call_for_a_root_the_relay_refuses_is_refused() {
    let env = env(true);
    let stranger = env.base.join("stranger");
    std::fs::create_dir_all(&stranger).unwrap();
    std::fs::write(stranger.join("page.html"), "<p>no</p>").unwrap();
    let refused = call_as(&env, Origin::Relay, "projectFs/localPageUrl", json!({ "root": stranger.to_string_lossy(), "rel": "page.html" })).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { code, .. }) if code.as_deref() == Some("PROJECT_UNAVAILABLE")), "{refused:?}");
    // The registered project passes the same check.
    let admitted = call_as(&env, Origin::Relay, "projectFs/localPageUrl", json!({ "root": env.root.to_string_lossy(), "rel": "page.html" })).await.unwrap();
    assert_eq!(get(admitted.as_str().unwrap()).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn standalone_classifies_registered_unregistered_and_missing_paths() {
    let env = env(false);
    let registered = local(&env, "project/directory", json!({ "path": env.root.to_string_lossy(), "standalone": true })).await.unwrap();
    assert_eq!(registered["standalone"], Value::Null);
    let folder = env.base.join("loose");
    std::fs::create_dir_all(&folder).unwrap();
    let loose = local(&env, "project/directory", json!({ "path": folder.to_string_lossy(), "standalone": true })).await.unwrap();
    assert_eq!((loose["path"].as_str().map(PathBuf::from), loose["standalone"].clone()), (Some(folder.clone()), json!(true)));
    // Without the flag an unregistered folder keeps the registry refusal.
    assert!(local(&env, "project/directory", json!({ "path": folder.to_string_lossy() })).await.is_err());
    // A missing path, a file and a relay caller are refused.
    assert!(local(&env, "project/directory", json!({ "path": env.base.join("missing").to_string_lossy(), "standalone": true })).await.is_err());
    assert!(local(&env, "project/directory", json!({ "path": env.root.join("page.html").to_string_lossy(), "standalone": true })).await.is_err());
    assert!(call_as(&env, Origin::Relay, "project/directory", json!({ "path": folder.to_string_lossy(), "standalone": true })).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_new_methods_are_unsupported_until_the_desktop_files_are_enabled() {
    let env = env(false);
    for method in ["projectFs/grant/describe", "projectFs/grant/redeem", "projectFs/localPage/revokeOwner", "projectFs/localPage/origin"] {
        assert!(env.service.methods().contains(&method));
    }
    let refused = local(&env, "projectFs/localPage/origin", json!({})).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { code, .. }) if code.as_deref() == Some("unsupported")), "{refused:?}");
}
