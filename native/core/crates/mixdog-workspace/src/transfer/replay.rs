//! What Node's download service holds, replayed on the workspace service: the scenarios of `fixtures/file-downloads/file-downloads.json`
//! (`record-file-downloads.mjs`, b6f10295a) that record the handles the service holds open (`handles` steps): the sweeper's ticks, an
//! unpair, a conversation deleted, each also while a call is in flight. Each recorded call goes to the production service dispatch
//! (`WorkspaceService::call`, as a paired phone's connection makes it); its reply is compared whole with the frame Node's phone got, and
//! after every `handles` step the files the service holds open equal Node's. The clock is a virtual one that moves only by the
//! recording's `advance` steps, tick by tick, the sweeper running on it.
//!
//! This is the proof of what the service HOLDS. The proof of the replies of every recorded call, through the phone's adapter to a real
//! mixdogd, is `benchmarks/rust-core/recorders/record-file-downloads.mjs --replay`: a spawned core cannot be held in the middle of a
//! call or have its handles counted, which these scenarios need. The five calls below are the adapter's requests for a session-file
//! download, one for one (`apps/desktop/src/renderer/remote-protocol-files.ts`).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::tests::Manual;
use super::tests::link_folder;
use super::*;
use crate::service::Deps;
use crate::service::WorkspaceService;

const RECORDING: &str = include_str!("../../../../fixtures/file-downloads/file-downloads.json");

/// The conversations the host's catalog lists now: `s1` a project conversation of the world's project, `s2` a task conversation.
struct Present(Mutex<HashSet<String>>, PathBuf, Mutex<std::collections::HashMap<String, crate::grants::MediaEntry>>);

#[async_trait::async_trait]
impl crate::grants::SessionCatalog for Present {
    /// The host's media store, as the recorder's stub of it: an asset it was told of whose file is still there.
    async fn media(&self, asset: &str) -> WsResult<Option<crate::grants::MediaEntry>> {
        Ok(self.2.lock().unwrap().get(asset).filter(|entry| Path::new(&entry.path).exists()).cloned())
    }

    async fn has(&self, session: &str) -> WsResult<bool> {
        Ok(self.0.lock().unwrap().contains(session))
    }

    async fn row(&self, session: &str) -> WsResult<Option<crate::grants::SessionRow>> {
        if !self.0.lock().unwrap().contains(session) {
            return Ok(None);
        }
        let folder = |name: &str| self.1.join(name).to_string_lossy().into_owned();
        Ok(match session {
            "s1" => Some(crate::grants::SessionRow { project: true, project_path: Some(folder("project")), cwd: folder("project") }),
            "s2" => Some(crate::grants::SessionRow { project: false, project_path: None, cwd: folder("task") }),
            _ => None,
        })
    }
}

/// The attachment domain as the recorder's host stub answers it (`readSessionTranscript` / `readSessionHistory` rows and the store's bytes),
/// staged as the core's `AttachmentSource` stages it (that source is proved against the real store by the adapter replay and its own
/// tests): an id the conversation does not name is `notLinked`, bytes no longer stored `notFound`, bytes that do not hash to the id
/// `changed`, and the name and type are `sessionAttachments`' defaults made to preview (`attachmentViewName`).
#[derive(Default)]
struct Attachments {
    /// (conversation, id) -> (name, type) of the rows that name it.
    named: Mutex<std::collections::HashMap<(String, String), (String, String)>>,
    stored: Mutex<std::collections::HashMap<String, Vec<u8>>>,
}

#[async_trait::async_trait]
impl TransferSource for Attachments {
    fn kind(&self) -> &'static str {
        "attachment"
    }

    async fn open(&self, source: &Value, _: &CancellationToken) -> WsResult<SourceFile> {
        use sha2::Digest as _;
        let (session, id) = (source["sessionId"].as_str().unwrap().to_owned(), source["attachmentId"].as_str().unwrap().to_owned());
        let (name, mime) = self.named.lock().unwrap().get(&(session, id.clone())).cloned().ok_or_else(|| WsError::new(Reason::NotLinked, "This conversation has no such attachment."))?;
        let bytes = self.stored.lock().unwrap().get(&id).cloned().ok_or_else(|| WsError::new(Reason::NotFound, "This attachment is no longer stored on the PC."))?;
        let hash: String = sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hash != id {
            return Err(WsError::new(Reason::Changed, "The stored attachment failed its integrity check."));
        }
        let name = if name.is_empty() { "attachment".to_owned() } else { name };
        let mime = if mime.is_empty() { "application/octet-stream".to_owned() } else { mime };
        let name = sanitized_file_name(&name);
        let extension = match mime.to_lowercase().as_str() {
            "image/png" => ".png",
            "image/jpeg" => ".jpg",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            "application/pdf" => ".pdf",
            "text/plain" => ".txt",
            "text/markdown" => ".md",
            _ => "",
        };
        let name = if name.rfind('.').is_some_and(|at| at > 0) { name } else { format!("{name}{extension}") };
        let (folder, mut out) = crate::transfer::staged_payload()?;
        std::io::Write::write_all(&mut out, &bytes)?;
        drop(out);
        Ok(SourceFile { file: File::open(folder.join(crate::transfer::STAGED_PAYLOAD))?, name, mime_type: mime, cleanup: Some(folder) })
    }
}

struct NoGit;

#[async_trait::async_trait]
impl crate::zip::TrackedFiles for NoGit {
    async fn files(&self, _: &Path, _: &CancellationToken) -> Option<Vec<String>> {
        None
    }
    async fn ignored(&self, _: &Path, _: &CancellationToken) -> Option<u64> {
        None
    }
}

/// The two paired devices of the recording: each is one connection of the service, paired as the credential the recording names.
const DEVICES: [(&str, u64, &str); 5] = [("phone", 1, "aaaaaaa1"), ("tablet", 2, "bbbbbbb2"), ("connection:c1", 3, ""), ("connection:c2", 4, ""), ("digits", 5, "6")];

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
                assert_eq!(r.keys().collect::<std::collections::BTreeSet<_>>(), g.keys().collect::<std::collections::BTreeSet<_>>(), "{at}: recorded {recorded}, got {got}");
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
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), self.resolve(item))).collect()),
            other => other.clone(),
        }
    }
}

/// The request the core is asked for one service call Node's method table made (the recording's `service` of a call, from Node itself):
/// the phone adapter's mapping of Node's five service methods onto the core's, one for one. The arguments are Node's own.
fn core_request(reached: &Value) -> (&'static str, Value) {
    let args = &reached["args"];
    match reached["method"].as_str().unwrap() {
        "authorize" => {
            let (request, source) = (&args[0], &args[0]["source"]);
            let source = match source["kind"].as_str().unwrap() {
                "project" => json!({ "kind": "file", "rel": source["relPath"] }),
                "session" => json!({ "kind": "sessionFile", "path": source["path"] }),
                "media" => json!({ "kind": "mediaAsset", "assetId": source["assetId"] }),
                "link" => json!({ "kind": "link", "itemId": source["itemId"], "href": source["href"] }),
                "attachment" => json!({ "kind": "attachment", "attachmentId": source["attachmentId"] }),
                "folder" => json!({ "kind": "folder", "path": source["path"] }),
                other => panic!("a source of kind {other} has no request"),
            };
            ("transfer/authorizeRead", json!({ "sessionId": args[0]["source"]["sessionId"], "source": source, "purpose": request["purpose"] }))
        }
        "begin" => ("transfer/redeemGrant", json!({ "grantId": args[0] })),
        "readRange" => ("transfer/readRange", json!({ "transferId": args[0], "offset": args[1], "length": args[2], "version": args[3] })),
        "finish" => ("transfer/finishRead", json!({ "transferId": args[0] })),
        "abort" => ("transfer/endRead", json!({ "transferId": args[0] })),
        other => panic!("{other}"),
    }
}

struct World {
    dir: PathBuf,
    service: Arc<WorkspaceService>,
    transfers: Arc<Transfers>,
    manual: Arc<Manual>,
    present: Arc<Present>,
    store: Arc<crate::grants::GrantStore>,
    attachments: Arc<Attachments>,
    tokens: Tokens,
}

/// The frame Node's phone received, less its id.
fn frame_of(method: &str, outcome: Result<Reply, CoreError>) -> Value {
    match outcome {
        Ok(Reply::Value(value)) => json!({ "ok": true, "value": if method == "fileDownloadAbort" { value["ended"].clone() } else { value } }),
        Ok(Reply::Subscribe(_)) => panic!("{method}: a subscription"),
        // Node's frame carries the error's `code` whatever it is: a download refusal's, or a system call's (`ENOENT`).
        Err(CoreError::DomainError { code: Some(code), message, .. }) => json!({ "ok": false, "error": message.as_deref(), "errorCode": code }),
        Err(CoreError::DomainError { code: None, message, .. }) => json!({ "ok": false, "error": message.as_deref() }),
        Err(CoreError::InvalidParams { expected, .. }) => json!({ "ok": false, "error": expected.to_string() }),
        Err(other) => panic!("{method}: {other:?}"),
    }
}

impl World {
    fn connection(device: &str) -> u64 {
        DEVICES.iter().find(|(name, ..)| *name == device).map(|(_, id, _)| *id).unwrap_or_else(|| panic!("{device}"))
    }

    fn request(device: &str, method: &'static str, params: Value) -> CoreRequest {
        CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(Self::connection(device)), Origin::Relay, CancellationToken::new()) }
    }

    /// A recorded value for this run: its `<dir>` is the world's folder.
    fn swap_dir(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => json!(text.replace("<dir>", &self.dir.to_string_lossy().replace('\\', "/"))),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.swap_dir(item)).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), self.swap_dir(item))).collect()),
            other => other.clone(),
        }
    }

    /// An answer in the recording's terms, as the recorder wrote Node's: a text naming the world's folder names `<dir>`, with forward slashes.
    fn unswap_dir(&self, value: &Value) -> Value {
        let native = self.dir.to_string_lossy().into_owned();
        let forward = native.replace('\\', "/");
        match value {
            Value::String(text) if text.contains(&native) => json!(text.replace(&native, "<dir>").replace('\\', "/")),
            Value::String(text) if text.contains(&forward) => json!(text.replace(&forward, "<dir>")),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.unswap_dir(item)).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), self.unswap_dir(item))).collect()),
            other => other.clone(),
        }
    }

    /// One recorded phone call: the request the core is asked for the service call Node's method table made for it (`core_request`), and
    /// the reply as the phone's page sees it. A call Node's table refused before the service, with no service call, is `None`: the
    /// adapter answers it itself, and the adapter replay proves that.
    async fn call(&self, device: &str, method: &str, service: &Value) -> Option<Value> {
        let reached = service.as_array().expect("a call has the service calls Node's table made");
        assert!(reached.len() <= 1, "{method}: {reached:?}");
        let (core, request) = core_request(reached.first()?);
        let params = self.swap_dir(&self.tokens.resolve(&request));
        let request = CoreRequest {
            method: Method(core),
            params,
            op: None,
            ctx: CallContext::connection(ConnectionId(Self::connection(device)), Origin::Relay, CancellationToken::new()),
        };
        Some(frame_of(method, self.service.call(request).await))
    }

    /// Does a recorded file operation; `false` for a step that is none.
    fn file(&self, step: &Value) -> bool {
        file_op(&self.dir, step)
    }

    /// Moves the clock by `ms`, one sweeper tick at a time as Node's virtual queue ran them: to a tick, wait for the sweeper to have
    /// swept at it, on.
    async fn advance(&self, ms: u64) {
        let target = self.manual.elapsed() + ms;
        loop {
            let now = self.manual.elapsed();
            let anchor = (*self.transfers.sweeper.anchor.lock().unwrap()).map(|at| self.manual.ms_of(at));
            let next = anchor.filter(|anchor| *anchor <= now).map(|anchor| anchor + SWEEP_INTERVAL.as_millis() as u64 * ((now - anchor) / SWEEP_INTERVAL.as_millis() as u64 + 1));
            match next {
                Some(tick) if tick <= target => {
                    self.manual.advance(tick - now);
                    let swept = self.transfers.sweeper.swept.notified();
                    tokio::time::timeout(std::time::Duration::from_secs(10), swept).await.unwrap_or_else(|_| panic!("the sweeper did not sweep at {tick} ms"));
                }
                _ => {
                    self.manual.advance(target - now);
                    return;
                }
            }
        }
    }

    /// The host publishes its catalog listing exactly `ids`.
    fn publish(&self, ids: &[String]) {
        publish(&self.present, &self.store, &self.service, ids);
    }

    /// A recorded `media` step: the store gets a file `assets/<name>` and resolves the asset to it.
    fn media(&self, step: &Value) {
        let file = self.dir.join("media/assets").join(step["name"].as_str().unwrap());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, step["text"].as_str().unwrap()).unwrap();
        let entry = crate::grants::MediaEntry { path: file.to_string_lossy().into_owned(), mime: Some(step["mime"].as_str().unwrap().to_owned()) };
        self.present.2.lock().unwrap().insert(step["id"].as_str().unwrap().to_owned(), entry);
    }
}

/// The host publishes its catalog listing exactly `ids`: every conversation of it is seen, and one it listed before and lists no more is
/// removed, which the deletion that dropped it tells the service in its own step.
fn publish(present: &Present, store: &crate::grants::GrantStore, service: &WorkspaceService, ids: &[String]) {
    let before: Vec<String> = present.0.lock().unwrap().iter().cloned().collect();
    *present.0.lock().unwrap() = ids.iter().cloned().collect();
    let listed: Vec<&str> = ids.iter().map(String::as_str).collect();
    mixdog_core_api::state::CatalogObserver::published(store, &listed);
    for gone in before.iter().filter(|id| !ids.contains(id)) {
        service.session_removed(gone);
    }
}

/// Does a recorded file operation in `dir`; `false` for a step that is none.
fn file_op(dir: &Path, step: &Value) -> bool {
    let target = dir.join(step["file"].as_str().unwrap_or_default());
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
        // `rmSync(force)`: a missing file is no error, a file that cannot be removed is.
        "remove" => {
            if target.exists() {
                std::fs::remove_file(&target).unwrap_or_else(|error| panic!("{} could not be removed: {error}", target.display()));
            }
        }
        "mkdir" => std::fs::create_dir_all(&target).unwrap(),
        "rename" => std::fs::rename(&target, dir.join(step["to"].as_str().unwrap())).unwrap(),
        "junction" => {
            let to = dir.join(step["target"].as_str().unwrap());
            drop(std::fs::remove_dir_all(&target));
            link_folder(&to, &target);
        }
        _ => return false,
    }
    true
}

fn ids_of(step: &Value) -> Vec<String> {
    step["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
}

/// A service over a table on a virtual clock that starts at `start` (epoch milliseconds), its sweeper running, with the two paired devices of
/// the recording, its project registered and the conversations `s1` and `s2` listed.
async fn build(base: PathBuf, start: i64) -> (World, tokio::task::JoinHandle<()>) {
    let tokens = mixdog_rt::testing::tokens();
    // The recorder's world: `project/sub` exists from the start too.
    for folder in ["project", "project/sub", "task", "outside", "state"] {
        std::fs::create_dir_all(base.join(folder)).unwrap();
    }
    let limits = mixdog_core_api::mock::MockLimits::default();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("state/core.sqlite")).unwrap();
    let manual = Manual::starting_at(start);
    let transfers = Arc::new(Transfers::with_clock(manual.clone(), UPLOAD_IDLE));
    let attachments = Arc::new(Attachments::default());
    let service = WorkspaceService::new_with_transfers(
        Deps {
            lanes: crate::lanes::Lanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                cpu_bulk: tokens.cpu_bulk,
            },
            feeds: Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(limits)),
            processes: Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default()),
            tracked: Arc::new(NoGit),
            state,
            recovery_dir: base.join("recovery"),
            user_data_dir: base.join("userData"),
            sources: vec![attachments.clone() as Arc<dyn TransferSource>],
            code_graph: None,
            turn_review: None,
            releases: crate::release::FolderReleases::new(),
        },
        transfers.clone(),
    )
    .unwrap();
    service.catalog().add(&base.join("project").to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
    let present = Arc::new(Present(Mutex::default(), base.clone(), Mutex::default()));
    let store = Arc::new(crate::grants::GrantStore::new(manual.clone(), present.clone()));
    service.set_phone_grants(
        store.clone(),
        Arc::new(|connection: ConnectionId| DEVICES.iter().find(|(_, id, _)| *id == connection.0).map(|(_, _, credential)| (*credential).to_owned()).filter(|credential| !credential.is_empty())),
    );
    let sweeping = {
        let (transfers, manual) = (transfers.clone(), manual.clone());
        tokio::spawn(async move { transfers.run_download_sweeper(&*manual).await })
    };
    let world = World { dir: base, service, transfers, manual, present, store, attachments, tokens: Tokens::default() };
    // Every conversation of the host is listed from the start; Node's service has seen none until a publication.
    *world.present.0.lock().unwrap() = ["s1", "s2"].into_iter().map(str::to_owned).collect();
    (world, sweeping)
}

/// The scenarios recorded on Windows alone (their `platform`): their path rules are that system's, so another system does not run them,
/// and says so. On the system a scenario was recorded for, none may be left out.
const WINDOWS_ONLY: [&str; 1] = ["windows path names"];

/// Every recorded scenario, every step: the file operations, the clock, the unpair, the catalog, each call as the adapter makes it of the
/// production service dispatch (reply compared whole with the frame Node's phone got), each call held at a point of the service while the
/// recorded event happens, and after every `handles` step the files the service holds open equal Node's.
#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_download_scenario_is_answered_and_held_as_nodes_service_did() {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let start = recording["clockStart"].as_i64().unwrap();
    let platform = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let all = recording["scenarios"].as_array().unwrap();
    // The request ids of the recording run 1, 2, 3, ... over every call in order: one counter, none skipped or repeated.
    let mut next_id: Option<u64> = None;
    let mut take_id = |recorded: &Value, label: &str| {
        let recorded = recorded.as_u64().unwrap_or_else(|| panic!("{label}: no id"));
        assert_eq!(recorded, *next_id.get_or_insert(recorded), "{label}: the recorded call ids are not consecutive");
        next_id = Some(recorded + 1);
    };
    let (mut compared, mut by_adapter, mut counted, mut held_calls, mut staged_counts) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut replayed_calls = 0usize;
    let mut not_run: Vec<&str> = Vec::new();
    for scenario in all {
        let name = scenario["name"].as_str().unwrap();
        let steps = scenario["steps"].as_array().unwrap();
        if scenario["platform"].as_str().is_some_and(|recorded| recorded != platform) {
            not_run.push(name);
            for step in steps.iter().filter(|step| matches!(step["op"].as_str(), Some("call" | "answer"))) {
                take_id(&step["frame"]["id"], name);
            }
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let (mut world, sweeping) = build(canonical(dir.path()).unwrap(), start).await;
        let mut at = 0;
        let compare = |world: &mut World, recorded: &Value, got: Value, label: &str| {
            let mut recorded = recorded.clone();
            recorded.as_object_mut().unwrap().remove("id");
            let got = world.unswap_dir(&got);
            world.tokens.same(&recorded, &got, label);
        };
        while at < steps.len() {
            let step = &steps[at];
            let label = format!("{name} #{} {}", at + 1, step["op"]);
            at += 1;
            if world.file(step) {
                continue;
            }
            match step["op"].as_str().unwrap() {
                "advance" => world.advance(step["ms"].as_u64().unwrap()).await,
                "revokeDevice" => {
                    // The unpair walks the device's connections: the service is told the connection (`PairedDeviceCleanup`).
                    world.service.revoke_device(&World::connection(step["device"].as_str().unwrap()).to_string());
                }
                // The relay handle closing: what the remote runtime's `relay_closed` reaches (`PairedDeviceCleanup::relay_closed`).
                "revokeAll" => world.service.revoke_all_downloads(),
                "sessions" => world.publish(&ids_of(step)),
                "media" => world.media(step),
                "attachment" => {
                    let field = |key: &str| step[key].as_str().unwrap().to_owned();
                    world.attachments.named.lock().unwrap().insert((field("sessionId"), field("id")), (field("name"), field("mimeType")));
                    if step["stored"] == true {
                        world.attachments.stored.lock().unwrap().insert(field("id"), field("storedText").into_bytes());
                    }
                }
                // An index entry with an empty file: the store resolves it to its assets folder (the core's store does so too, see
                // `mixdog-services` `stored_asset_path`; the adapter replay drives that store itself).
                "mediaRoot" => {
                    let root = world.dir.join("media/assets");
                    std::fs::create_dir_all(&root).unwrap();
                    let entry = crate::grants::MediaEntry { path: root.to_string_lossy().into_owned(), mime: Some(String::new()) };
                    world.present.2.lock().unwrap().insert(step["id"].as_str().unwrap().to_owned(), entry);
                }
                "unmedia" => {
                    let entry = world.present.2.lock().unwrap().remove(step["id"].as_str().unwrap()).unwrap();
                    std::fs::remove_file(entry.path).unwrap();
                }
                "handles" => {
                    assert_eq!(world.transfers.held_downloads() as u64, step["open"].as_u64().unwrap(), "{label}");
                    counted += 1;
                }
                "staged" => {
                    assert_eq!(world.transfers.staged_files() as u64, step["count"].as_u64().unwrap(), "{label}: staged downloads on disk");
                    staged_counts += 1;
                }
                "call" => {
                    take_id(&step["frame"]["id"], &label);
                    replayed_calls += 1;
                    match world.call(step["device"].as_str().unwrap(), step["method"].as_str().unwrap(), &step["service"]).await {
                        Some(got) => {
                            compare(&mut world, &step["frame"], got, &label);
                            compared += 1;
                        }
                        // The phone's adapter answered it without asking the core (an argument it refuses): the adapter replay proves it.
                        None => {
                            assert_eq!(step["frame"]["ok"], false, "{label}");
                            by_adapter += 1;
                        }
                    }
                }
                // A call held at a point of the service while something else runs: hold, send, the event, release, answer.
                "hold" => {
                    let point = match step["gate"].as_str().unwrap() {
                        "read" => "read.read",
                        "stat" => "begin.verify",
                        "afterResolve" => "authorize.resolved",
                        "zipOpen" => "zip.open",
                        other => panic!("{other}"),
                    };
                    let (sent, event, release, answer) = (&steps[at], &steps[at + 1], &steps[at + 2], &steps[at + 3]);
                    assert_eq!((sent["op"].as_str(), release["op"].as_str(), answer["op"].as_str()), (Some("send"), Some("release"), Some("answer")), "{label}");
                    take_id(&answer["frame"]["id"], &label);
                    let hook: Arc<dyn Fn(&str) + Send + Sync> = match event["op"].as_str().unwrap() {
                        "revokeDevice" => {
                            let service = world.service.clone();
                            let id = World::connection(event["device"].as_str().unwrap()).to_string();
                            Arc::new(move |reached: &str| {
                                if reached == point {
                                    service.revoke_device(&id);
                                }
                            })
                        }
                        "revokeAll" => {
                            let service = world.service.clone();
                            Arc::new(move |reached: &str| {
                                if reached == point {
                                    service.revoke_all_downloads();
                                }
                            })
                        }
                        "sessions" => {
                            let (present, store, service, ids) = (world.present.clone(), world.store.clone(), world.service.clone(), ids_of(event));
                            Arc::new(move |reached: &str| {
                                if reached == point {
                                    publish(&present, &store, &service, &ids);
                                }
                            })
                        }
                        _ => {
                            let (dir, event) = (world.dir.clone(), event.clone());
                            Arc::new(move |reached: &str| {
                                if reached == point {
                                    assert!(file_op(&dir, &event), "{event}");
                                }
                            })
                        }
                    };
                    world.transfers.on_point(Some(hook));
                    let got = world.call(sent["device"].as_str().unwrap(), sent["method"].as_str().unwrap(), &sent["service"]).await.unwrap_or_else(|| panic!("{label}: a held call reaches the core"));
                    world.transfers.on_point(None);
                    compare(&mut world, &answer["frame"], got, &label);
                    compared += 1;
                    held_calls += 1;
                    replayed_calls += 1;
                    at += 4;
                }
                other => panic!("{label}: {other}"),
            }
        }
        sweeping.abort();
    }
    // Every call of every scenario of this platform was replayed: none is skipped.
    let steps: Vec<&Value> = all.iter().filter(|s| s["platform"].as_str().is_none_or(|p| p == platform)).flat_map(|s| s["steps"].as_array().unwrap()).collect();
    let of = |op: &str| steps.iter().filter(|step| step["op"] == op).count();
    assert_eq!(compared + by_adapter, of("call") + of("answer"));
    assert_eq!(replayed_calls, of("call") + of("send"));
    assert_eq!(counted, of("handles"));
    assert_eq!(staged_counts, of("staged"));
    assert!(held_calls >= 5 && counted >= 25, "{held_calls} {counted}");
    // Where a scenario was recorded for this system, none is left out; elsewhere exactly the Windows-only ones are.
    let expected: &[&str] = if cfg!(windows) { &[] } else { &WINDOWS_ONLY };
    assert_eq!(not_run, expected, "the scenarios this system did not run");
}
/// What the unpair's `revoke_device` reaches, by the name it is given: the unpair walks the live connections of the device and names each by
/// its id (`PairedDeviceCleanup::unpaired`), which owns the device's grants through its credential; a connection with no credential owns its
/// own by its id; and the credential itself names the grants of a device with no live connection.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_ends_the_downloads_of_the_device_by_whichever_name_the_owner_has() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    let file = world.dir.join("a.bin");
    std::fs::write(&file, b"0123456789abcdef").unwrap();
    let authorize = |connection: u64| {
        let body = json!({ "sessionId": "s1", "source": { "kind": "sessionFile", "path": file.to_string_lossy() }, "purpose": "save" });
        let request = CoreRequest { method: Method("transfer/authorizeRead"), params: body, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, CancellationToken::new()) };
        let service = world.service.clone();
        async move {
            match service.call(request).await.unwrap() {
                Reply::Value(value) => value["grantId"].as_str().unwrap().to_owned(),
                Reply::Subscribe(_) => unreachable!(),
            }
        }
    };
    let redeem = |connection: u64, grant: String| {
        let request = CoreRequest { method: Method("transfer/redeemGrant"), params: json!({ "grantId": grant }), op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, CancellationToken::new()) };
        let service = world.service.clone();
        async move { service.call(request).await }
    };
    let expired = |result: Result<Reply, CoreError>| matches!(result, Err(CoreError::DomainError { code: Some(code), .. }) if &*code == "file-download:expired");
    // A paired device's connection names the device: the grant is the credential's.
    let paired = authorize(1).await;
    world.service.revoke_device("1");
    assert!(expired(redeem(1, paired).await), "a connection id of a paired device ends the credential's grants");
    // The grant store is told the credential of a device that unpairs, whether or not a connection of it is attached.
    let by_credential = authorize(2).await;
    world.store.revoke_device("bbbbbbb2");
    assert!(expired(redeem(2, by_credential).await), "the credential ends its grants");
    // A connection with no credential owns its grants by its id.
    let anonymous = authorize(9).await;
    world.service.revoke_device("9");
    assert!(expired(redeem(9, anonymous).await), "a connection with no credential ends its own");
    // And nothing of another device.
    let kept = authorize(1).await;
    world.service.revoke_device("2");
    assert!(redeem(1, kept).await.is_ok(), "another device's grant lives");
    sweeping.abort();
}

/// A relay caller can call the core directly, so the core decides what a conversation is and where its project is, from its own catalog
/// (Node's `sessionRow` / `projectRoot`): a conversation it does not list is unavailable, a task conversation has no project, and what the
/// caller says of the project (an extra `root` or `projectPath`) changes nothing, so a path through a link out of the project is refused
/// whether or not the caller names the project.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_caller_gets_nothing_the_catalog_does_not_give_it() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    std::fs::create_dir_all(world.dir.join("outside")).unwrap();
    std::fs::write(world.dir.join("outside/n.bin"), b"outside").unwrap();
    std::fs::write(world.dir.join("project/in.bin"), b"inside").unwrap();
    std::fs::write(world.dir.join("task/t.bin"), b"task").unwrap();
    link_folder(&world.dir.join("outside"), &world.dir.join("project").join("link")); // `mklink` refuses a mixed-separator path
    let recorded = |scenario: &str, n: usize| -> Value {
        let recording: Value = serde_json::from_str(RECORDING).unwrap();
        let steps = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == scenario).unwrap()["steps"].as_array().unwrap().clone();
        let step = steps.into_iter().filter(|step| step["op"] == "call").nth(n).unwrap_or_else(|| panic!("{scenario} has no call {n}"));
        // The index names an authorize of the recording, never another call's frame that happens to sit there.
        assert_eq!(step["method"], "fileDownloadAuthorize", "{scenario} call {n}: {step}");
        step["frame"].clone()
    };
    let ask = |session: &str, source: Value| {
        let params = json!({ "sessionId": session, "source": source, "purpose": "save", "root": world.dir.join("outside").to_string_lossy(), "projectPath": world.dir.join("project").to_string_lossy() });
        let (service, request) = (world.service.clone(), World::request("phone", "transfer/authorizeRead", params));
        async move { frame_of("fileDownloadAuthorize", service.call(request).await) }
    };
    let path = |name: &str| world.dir.join(name).to_string_lossy().into_owned();
    let same = |got: Value, recorded: Value| {
        let mut recorded = recorded;
        recorded.as_object_mut().unwrap().remove("id");
        assert_eq!(got, recorded);
    };
    // A conversation the catalog does not list, whoever asks and whatever it names: Node's `unavailable`.
    same(ask("never-existed", json!({ "kind": "sessionFile", "path": path("outside/n.bin") })).await, recorded("sources", 16));
    same(ask("never-existed", json!({ "kind": "file", "rel": "in.bin" })).await, recorded("sources", 8));
    // A task conversation has no project: its project file is outside it.
    same(ask("s2", json!({ "kind": "file", "rel": "in.bin" })).await, recorded("sources", 7));
    // A project conversation's path through a link out of its project, the caller naming no project of its own: refused as Node refuses it.
    same(ask("s1", json!({ "kind": "sessionFile", "path": path("project/link/n.bin") })).await, recorded("ancestor swapped between resolving and opening", 1));
    // And the same through the project-relative form.
    same(ask("s1", json!({ "kind": "file", "rel": "link/n.bin" })).await, recorded("ancestor swapped between resolving and opening", 0));
    sweeping.abort();
}

/// The core is the boundary, not the adapter: every authorize, begin and finish whose arguments Node's method table refused before its
/// service (no service call recorded), sent straight to the core by a relay caller in the core's own terms (the source kinds renamed, the
/// conversation beside the source), is refused with Node's sentence and no download code, before any conversation or file is looked up.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_caller_that_skips_the_adapter_is_refused_as_nodes_table_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let mut sent = 0;
    for scenario in recording["scenarios"].as_array().unwrap() {
        for step in scenario["steps"].as_array().unwrap().iter().filter(|step| step["op"] == "call" && step["service"].as_array().is_some_and(Vec::is_empty)) {
            let args = &step["params"];
            let (method, params) = match step["method"].as_str().unwrap() {
                "fileDownloadAuthorize" if args[0]["source"].is_object() || args[0].get("purpose").is_some() => {
                    let source = &args[0]["source"];
                    let mut core = source.as_object().cloned().unwrap_or_default();
                    core.remove("sessionId");
                    let renamed = |from: &str, to: &str, kind: &str, core: &mut serde_json::Map<String, Value>| {
                        core.insert("kind".into(), json!(kind));
                        if let Some(value) = core.remove(from) {
                            core.insert(to.into(), value);
                        }
                    };
                    match source["kind"].as_str() {
                        Some("project") => renamed("relPath", "rel", "file", &mut core),
                        Some("session") => renamed("path", "path", "sessionFile", &mut core),
                        Some("media") => renamed("assetId", "assetId", "mediaAsset", &mut core),
                        _ => {}
                    }
                    let mut params = json!({ "sessionId": source.get("sessionId").cloned().unwrap_or(Value::Null) });
                    if source.is_object() {
                        params["source"] = Value::Object(core);
                    }
                    if let Some(purpose) = args[0].get("purpose") {
                        params["purpose"] = purpose.clone();
                    }
                    ("transfer/authorizeRead", params)
                }
                "fileDownloadBegin" => ("transfer/redeemGrant", json!({ "grantId": args.get(0).cloned().unwrap_or(Value::Null) })),
                "fileDownloadFinish" => ("transfer/finishRead", json!({ "transferId": args.get(0).cloned().unwrap_or(Value::Null) })),
                _ => continue,
            };
            let request = World::request("phone", method, world.swap_dir(&params));
            let mut recorded = step["frame"].clone();
            recorded.as_object_mut().unwrap().remove("id");
            assert_eq!(frame_of(step["method"].as_str().unwrap(), world.service.call(request).await), recorded, "{} {}: {args}", scenario["name"], step["method"]);
            sent += 1;
        }
    }
    // The asset ids Node refuses (`a b`, empty, 129 characters), the source and purpose shapes, the session ids and the grant ids are all here.
    assert!(sent >= 18, "{sent} refused calls sent");
    sweeping.abort();
}

/// A phone whose connection is `connection`, with a transfer begun on `a.bin` of the world: its transfer id and version.
async fn begun(world: &World, connection: u64) -> (String, String) {
    let call = |method: &'static str, params: Value| {
        let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, CancellationToken::new()) };
        let service = world.service.clone();
        async move {
            match service.call(request).await.unwrap() {
                Reply::Value(value) => value,
                Reply::Subscribe(_) => unreachable!(),
            }
        }
    };
    let granted = call("transfer/authorizeRead", json!({ "sessionId": "s1", "source": { "kind": "sessionFile", "path": world.dir.join("a.bin").to_string_lossy() }, "purpose": "save" })).await;
    let leased = call("transfer/redeemGrant", json!({ "grantId": granted["grantId"] })).await;
    (leased["transferId"].as_str().unwrap().to_owned(), leased["version"].as_str().unwrap().to_owned())
}

/// The frame Node's phone got for the held call of the scenario `name`.
fn node_answer(name: &str) -> Value {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let steps = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}"))["steps"].as_array().unwrap().clone();
    let mut frame = steps.into_iter().find(|step| step["op"] == "answer").unwrap()["frame"].clone();
    frame.as_object_mut().unwrap().remove("id");
    frame
}

/// How many files Node's service held open at the `n`th count of the scenario.
fn node_open(name: &str, n: usize) -> usize {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let steps = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}"))["steps"].as_array().unwrap().clone();
    steps.iter().filter(|step| step["op"] == "handles").nth(n).unwrap()["open"].as_u64().unwrap() as usize
}

/// The frame Node's phone got for the first call of the scenario `name` by `device` of the phone method `method`.
fn node_call(name: &str, device: &str, method: &str) -> Value {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let steps = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}"))["steps"].as_array().unwrap().clone();
    let mut frame = steps.into_iter().find(|step| step["op"] == "call" && step["device"] == device && step["method"] == method).unwrap()["frame"].clone();
    frame.as_object_mut().unwrap().remove("id");
    frame
}

/// A range of the transfer as `connection` asks it, as the frame the phone would get.
async fn range_frame(world: &World, connection: u64, transfer: &(String, String), offset: u64, length: u64) -> Value {
    let params = json!({ "transferId": transfer.0, "offset": offset, "length": length, "version": transfer.1 });
    let request = CoreRequest { method: Method("transfer/readRange"), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, CancellationToken::new()) };
    frame_of("fileDownloadRange", world.service.call(request).await)
}

/// The conversation is deleted while a range read waits at the file: the deletion lands in the step the catalog drops it, and the read,
/// which finds its transfer gone when it looks again, answers as Node's does (`session deleted during a range read`).
#[tokio::test(flavor = "multi_thread")]
async fn a_deletion_while_a_range_is_read_ends_the_read() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    std::fs::write(world.dir.join("a.bin"), b"0123456789abcdef").unwrap();
    world.publish(&["s1".to_owned(), "s2".to_owned()]);
    let transfer = begun(&world, 1).await;
    let (present, store, service) = (world.present.clone(), world.store.clone(), world.service.clone());
    world.transfers.on_point(Some(Arc::new(move |reached: &str| {
        if reached == "read.read" {
            publish(&present, &store, &service, &["s2".to_owned()]);
        }
    })));
    assert_eq!(range_frame(&world, 1, &transfer, 0, 4).await, node_answer("session deleted during a range read"));
    world.transfers.on_point(None);
    assert_eq!(world.transfers.held_downloads(), node_open("session deleted during a range read", 0));
    sweeping.abort();
}

/// A revoke that lands after the range took its last look, while the lane's answer waits to be taken up, is never followed by bytes:
/// the service looks again before it answers. Node's answer for a revoke in a read is its `unpair during a read`.
#[tokio::test(flavor = "multi_thread")]
async fn a_revoke_after_the_last_look_of_a_range_is_not_followed_by_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    std::fs::write(world.dir.join("a.bin"), b"0123456789abcdef").unwrap();
    let transfer = begun(&world, 1).await;
    let store = world.store.clone();
    world.transfers.on_point(Some(Arc::new(move |reached: &str| {
        if reached == "read.checked" {
            store.revoke_device("aaaaaaa1");
        }
    })));
    assert_eq!(range_frame(&world, 1, &transfer, 0, 4).await, node_answer("unpair during a read"));
    world.transfers.on_point(None);
    sweeping.abort();
}

/// The file is cut short while a range waits at it: the file ended before the window did, so the read answers `changed` as Node's does and
/// the transfer is gone with its handle (`file truncated during a range read`).
#[tokio::test(flavor = "multi_thread")]
async fn a_file_cut_short_during_a_range_read_ends_the_transfer() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    std::fs::write(world.dir.join("a.bin"), b"0123456789abcdef").unwrap();
    let transfer = begun(&world, 1).await;
    let file = world.dir.join("a.bin");
    world.transfers.on_point(Some(Arc::new(move |reached: &str| {
        if reached == "read.read" {
            std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(10).unwrap();
        }
    })));
    assert_eq!(range_frame(&world, 1, &transfer, 8, 8).await, node_answer("file truncated during a range read"));
    world.transfers.on_point(None);
    assert_eq!(world.transfers.held_downloads(), node_open("file truncated during a range read", 0), "the dropped transfer's handle is closed");
    sweeping.abort();
}

/// A connection of this machine and a paired phone are different owners whatever the phone's credential spells: a phone admitted as `6`
/// owns its transfer as a device, and the local connection numbered 6 can neither read it nor end it.
#[tokio::test(flavor = "multi_thread")]
async fn a_local_connection_never_owns_what_a_phone_whose_credential_is_its_number_owns() {
    let dir = tempfile::tempdir().unwrap();
    let (world, sweeping) = build(canonical(dir.path()).unwrap(), 1_000).await;
    std::fs::write(world.dir.join("a.bin"), b"0123456789abcdef").unwrap();
    let transfer = begun(&world, 5).await;
    let local = |method: &'static str, params: Value| CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(6), Origin::Local, CancellationToken::new()) };
    let read = local("transfer/readRange", json!({ "transferId": transfer.0, "offset": 0, "length": 4, "version": transfer.1 }));
    // The foreign connection is refused as Node refuses another device's read and abort (`the device`, `finish and abort`).
    assert_eq!(frame_of("fileDownloadRange", world.service.call(read).await), node_call("the device", "tablet", "fileDownloadRange"));
    let end = local("transfer/endRead", json!({ "transferId": transfer.0 }));
    assert_eq!(frame_of("fileDownloadAbort", world.service.call(end).await), node_call("finish and abort", "tablet", "fileDownloadAbort"));
    assert_eq!(range_frame(&world, 5, &transfer, 0, 4).await["ok"], true, "the phone still reads its own");
    assert_ne!(crate::transfer::Owner::device("6"), crate::transfer::Owner::connection(6));
    sweeping.abort();
}