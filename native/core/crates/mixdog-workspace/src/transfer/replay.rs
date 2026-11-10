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
struct Present(Mutex<HashSet<String>>, PathBuf);

#[async_trait::async_trait]
impl crate::grants::SessionCatalog for Present {
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
const DEVICES: [(&str, u64, &str); 4] = [("phone", 1, "aaaaaaa1"), ("tablet", 2, "bbbbbbb2"), ("connection:c1", 3, ""), ("connection:c2", 4, "")];

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

struct World {
    dir: PathBuf,
    service: Arc<WorkspaceService>,
    transfers: Arc<Transfers>,
    manual: Arc<Manual>,
    present: Arc<Present>,
    store: Arc<crate::grants::GrantStore>,
    tokens: Tokens,
}

/// The frame Node's phone received, less its id.
fn frame_of(method: &str, outcome: Result<Reply, CoreError>) -> Value {
    match outcome {
        Ok(Reply::Value(value)) => json!({ "ok": true, "value": if method == "fileDownloadAbort" { value["ended"].clone() } else { value } }),
        Ok(Reply::Subscribe(_)) => panic!("{method}: a subscription"),
        Err(CoreError::DomainError { code: Some(code), message, .. }) if code.starts_with("file-download:") => {
            json!({ "ok": false, "error": message.as_deref(), "errorCode": code })
        }
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

    /// One recorded phone call: the request the adapter made of the core for it (`core-requests.json`, which the adapter replay
    /// compares with what the adapter really sends), and the reply as the phone's page sees it. A call the adapter answers itself, with
    /// no request, is `None`: that is the adapter replay's to prove.
    async fn call(&self, device: &str, method: &str, requests: &Value) -> Option<Value> {
        let requests = requests.as_array().expect("a call has its requests");
        assert!(requests.len() <= 1, "{method}: {requests:?}");
        let request = requests.first()?;
        let params = self.swap_dir(&self.tokens.resolve(&request["params"]));
        let core = request["method"].as_str().unwrap();
        let request = CoreRequest {
            method: Method(Box::leak(core.to_owned().into_boxed_str())),
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
        *self.present.0.lock().unwrap() = ids.iter().cloned().collect();
        let listed: Vec<&str> = ids.iter().map(String::as_str).collect();
        mixdog_core_api::state::CatalogObserver::published(&*self.store, &listed);
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
        "remove" => drop(std::fs::remove_file(&target)),
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
    for folder in ["project", "task", "outside", "state"] {
        std::fs::create_dir_all(base.join(folder)).unwrap();
    }
    let limits = mixdog_core_api::mock::MockLimits::default();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("state/core.sqlite")).unwrap();
    let manual = Manual::starting_at(start);
    let transfers = Arc::new(Transfers::with_clock(manual.clone(), UPLOAD_IDLE));
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
            sources: vec![],
            code_graph: None,
            turn_review: None,
            releases: crate::release::FolderReleases::new(),
        },
        transfers.clone(),
    )
    .unwrap();
    service.catalog().add(&base.join("project").to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
    let present = Arc::new(Present(Mutex::default(), base.clone()));
    let store = Arc::new(crate::grants::GrantStore::new(manual.clone(), present.clone()));
    service.set_phone_grants(
        store.clone(),
        Arc::new(|connection: ConnectionId| DEVICES.iter().find(|(_, id, _)| *id == connection.0).map(|(_, _, credential)| (*credential).to_owned()).filter(|credential| !credential.is_empty())),
    );
    let sweeping = {
        let (transfers, manual) = (transfers.clone(), manual.clone());
        tokio::spawn(async move { transfers.run_download_sweeper(&*manual).await })
    };
    let world = World { dir: base, service, transfers, manual, present, store, tokens: Tokens::default() };
    // Every conversation of the host is listed from the start; Node's service has seen none until a publication.
    *world.present.0.lock().unwrap() = ["s1", "s2"].into_iter().map(str::to_owned).collect();
    (world, sweeping)
}

/// The requests the phone's adapter makes of the core for each recorded call (`record-file-downloads.mjs --replay --write-requests`, which
/// the adapter replay compares with what the adapter really sends): the same ones this replay sends.
const REQUESTS: &str = include_str!("../../../../fixtures/file-download-requests/core-requests.json");

/// Every recorded scenario, every step: the file operations, the clock, the unpair, the catalog, each call as the adapter makes it of the
/// production service dispatch (reply compared whole with the frame Node's phone got), each call held at a point of the service while the
/// recorded event happens, and after every `handles` step the files the service holds open equal Node's.
#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_download_scenario_is_answered_and_held_as_nodes_service_did() {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let golden: Value = serde_json::from_str(REQUESTS).unwrap();
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
    let (mut compared, mut by_adapter, mut counted, mut held_calls, mut other_platform) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut replayed_calls = 0usize;
    for scenario in all {
        let name = scenario["name"].as_str().unwrap();
        let steps = scenario["steps"].as_array().unwrap();
        let sent = |step: &&Value| matches!(step["op"].as_str(), Some("call" | "send"));
        if scenario["platform"].as_str().is_some_and(|recorded| recorded != platform) {
            other_platform += steps.iter().filter(sent).count();
            for step in steps.iter().filter(|step| matches!(step["op"].as_str(), Some("call" | "answer"))) {
                take_id(&step["frame"]["id"], name);
            }
            continue;
        }
        let requests = golden["scenarios"].as_array().unwrap().iter().find(|g| g["name"] == name).unwrap_or_else(|| panic!("{name}: no recorded requests"))["steps"].as_array().unwrap();
        assert_eq!(requests.len(), steps.len(), "{name}");
        let dir = tempfile::tempdir().unwrap();
        let (mut world, sweeping) = build(canonical(dir.path()).unwrap(), start).await;
        let mut at = 0;
        let compare = |world: &mut World, recorded: &Value, got: Value, label: &str| {
            let mut recorded = recorded.clone();
            recorded.as_object_mut().unwrap().remove("id");
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
                // The relay leg closing or every device revoked: nothing in the daemon calls this yet (the remote domain's event).
                "revokeAll" => world.transfers.revoke_all(),
                "sessions" => {
                    world.publish(&ids_of(step));
                    world.service.retire_gone_download_sessions().await;
                }
                "handles" => {
                    assert_eq!(world.transfers.held_downloads() as u64, step["open"].as_u64().unwrap(), "{label}");
                    counted += 1;
                }
                "call" => {
                    take_id(&step["frame"]["id"], &label);
                    replayed_calls += 1;
                    match world.call(step["device"].as_str().unwrap(), step["method"].as_str().unwrap(), &requests[at - 1]).await {
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
                        "sessions" => {
                            let (present, ids) = (world.present.clone(), ids_of(event));
                            Arc::new(move |reached: &str| {
                                if reached == point {
                                    *present.0.lock().unwrap() = ids.iter().cloned().collect();
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
                    let got = world.call(sent["device"].as_str().unwrap(), sent["method"].as_str().unwrap(), &requests[at]).await.unwrap_or_else(|| panic!("{label}: a held call reaches the core"));
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
    assert!(held_calls >= 5 && counted >= 25, "{held_calls} {counted}");
    let _ = other_platform;
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
    // The credential names the grants of a device with no live connection.
    let by_credential = authorize(2).await;
    world.service.revoke_device("bbbbbbb2");
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
        steps.into_iter().filter(|step| step["op"] == "call").nth(n).unwrap()["frame"].clone()
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
