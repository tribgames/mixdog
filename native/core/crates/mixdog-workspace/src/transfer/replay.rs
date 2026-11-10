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
use super::*;
use crate::service::Deps;
use crate::service::WorkspaceService;

const RECORDING: &str = include_str!("../../../../fixtures/file-downloads/file-downloads.json");

/// The conversations the host's catalog lists now.
#[derive(Default)]
struct Present(Mutex<HashSet<String>>);

#[async_trait::async_trait]
impl crate::grants::SessionCatalog for Present {
    async fn has(&self, session: &str) -> WsResult<bool> {
        Ok(self.0.lock().unwrap().contains(session))
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
const DEVICES: [(&str, u64, &str); 2] = [("phone", 1, "aaaaaaa1"), ("tablet", 2, "bbbbbbb2")];

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
    fn path(&self, text: &str) -> PathBuf {
        self.dir.join(text.replace("<dir>/", ""))
    }

    fn connection(device: &str) -> u64 {
        DEVICES.iter().find(|(name, ..)| *name == device).map(|(_, id, _)| *id).unwrap_or_else(|| panic!("{device}"))
    }

    fn request(device: &str, method: &'static str, params: Value) -> CoreRequest {
        CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(Self::connection(device)), Origin::Relay, CancellationToken::new()) }
    }

    /// One recorded phone call as the adapter makes it of the core, and the reply as the phone's page sees it.
    async fn call(&self, device: &str, method: &str, params: &Value) -> Value {
        let params = self.tokens.resolve(params);
        let text = |at: usize| params[at].as_str().unwrap_or_default().to_owned();
        let (core, body) = match method {
            "fileDownloadAuthorize" => {
                let source = &params[0]["source"];
                assert_eq!(source["kind"], "session", "{method}: only session files are held-state scenarios");
                let session = source["sessionId"].as_str().unwrap();
                let path = self.path(source["path"].as_str().unwrap()).to_string_lossy().into_owned();
                ("transfer/authorizeRead", json!({ "sessionId": session, "source": { "kind": "sessionFile", "path": path }, "purpose": params[0]["purpose"] }))
            }
            "fileDownloadBegin" => ("transfer/redeemGrant", json!({ "grantId": text(0) })),
            "fileDownloadRange" => ("transfer/readRange", json!({ "transferId": text(0), "offset": params[1], "length": params[2], "version": text(3) })),
            "fileDownloadFinish" => ("transfer/finishRead", json!({ "transferId": text(0) })),
            "fileDownloadAbort" => ("transfer/endRead", json!({ "transferId": text(0) })),
            other => panic!("{other}"),
        };
        frame_of(method, self.service.call(Self::request(device, core, body)).await)
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
                    self.transfers.sweeper.swept.notified().await;
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

fn ids_of(step: &Value) -> Vec<String> {
    step["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_recorded_download_scenario_that_counts_handles_answers_and_holds_as_nodes_service_did() {
    let recording: Value = serde_json::from_str(RECORDING).unwrap();
    let start = recording["clockStart"].as_i64().unwrap();
    let scenarios: Vec<&Value> = recording["scenarios"].as_array().unwrap().iter().filter(|s| s["steps"].as_array().unwrap().iter().any(|step| step["op"] == "handles")).collect();
    assert!(scenarios.len() >= 12, "{}", scenarios.len());
    let (mut calls, mut compared, mut counted) = (0, 0, 0);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        for folder in ["project", "task", "outside", "state"] {
            std::fs::create_dir_all(base.join(folder)).unwrap();
        }
        let limits = mixdog_core_api::mock::MockLimits::default();
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("state/core.sqlite")).unwrap();
        let manual = Manual::new();
        let mut table = Transfers::with_clock(manual.clone(), UPLOAD_IDLE);
        table.epoch_ms = start;
        let transfers = Arc::new(table);
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
        let present = Arc::new(Present::default());
        let store = Arc::new(crate::grants::GrantStore::new(manual.clone(), present.clone()));
        service.set_phone_grants(
            store.clone(),
            Arc::new(|connection: ConnectionId| DEVICES.iter().find(|(_, id, _)| *id == connection.0).map(|(_, _, credential)| (*credential).to_owned())),
        );
        let sweeping = {
            let (transfers, manual) = (transfers.clone(), manual.clone());
            tokio::spawn(async move { transfers.run_download_sweeper(&*manual).await })
        };
        let mut world = World { dir: base, service, transfers, manual, present, store, tokens: Tokens::default() };
        // Every conversation of the host is listed from the start; Node's service has seen none until a publication.
        *world.present.0.lock().unwrap() = ["s1", "s2"].into_iter().map(str::to_owned).collect();

        let steps = scenario["steps"].as_array().unwrap();
        let mut at = 0;
        let compare = |world: &mut World, recorded: &Value, got: Value, label: &str| {
            let mut recorded = recorded.clone();
            recorded.as_object_mut().unwrap().remove("id");
            world.tokens.same(&recorded, &got, label);
        };
        while at < steps.len() {
            let step = &steps[at];
            at += 1;
            let label = format!("{name} #{at} {}", step["op"]);
            match step["op"].as_str().unwrap() {
                "write" | "append" | "size" | "remove" | "mkdir" => world.file(step),
                "advance" => world.advance(step["ms"].as_u64().unwrap()).await,
                "revokeDevice" => {
                    // The unpair walks the device's connections: the service is told the connection (`PairedDeviceCleanup`).
                    world.service.revoke_device(&World::connection(step["device"].as_str().unwrap()).to_string());
                }
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
                    let got = world.call(step["device"].as_str().unwrap(), step["method"].as_str().unwrap(), &step["params"]).await;
                    compare(&mut world, &step["frame"], got, &label);
                    calls += 1;
                    compared += 1;
                }
                // A call held at a point of the service while something else runs: hold, send, the event, release, answer.
                "hold" => {
                    let point = match step["gate"].as_str().unwrap() {
                        "read" => "read.read",
                        "stat" => "begin.verify",
                        "afterResolve" => "authorize.opened",
                        other => panic!("{other}"),
                    };
                    let (sent, event, release, answer) = (&steps[at], &steps[at + 1], &steps[at + 2], &steps[at + 3]);
                    assert_eq!((sent["op"].as_str(), release["op"].as_str(), answer["op"].as_str()), (Some("send"), Some("release"), Some("answer")), "{label}");
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
                        other => panic!("{label}: {other}"),
                    };
                    world.transfers.on_point(Some(hook));
                    let got = world.call(sent["device"].as_str().unwrap(), sent["method"].as_str().unwrap(), &sent["params"]).await;
                    world.transfers.on_point(None);
                    compare(&mut world, &answer["frame"], got, &label);
                    calls += 1;
                    compared += 1;
                    at += 4;
                }
                other => panic!("{label}: {other}"),
            }
        }
        sweeping.abort();
    }
    // Every call and every `handles` step of the counted scenarios was replayed: none is skipped.
    let all = recording["scenarios"].as_array().unwrap().iter().filter(|s| s["steps"].as_array().unwrap().iter().any(|step| step["op"] == "handles"));
    let steps: Vec<&Value> = all.flat_map(|s| s["steps"].as_array().unwrap()).collect();
    let of = |op: &str| steps.iter().filter(|step| step["op"] == op).count();
    assert_eq!((calls, compared, counted), (of("call") + of("answer"), of("call") + of("answer"), of("handles")));
}
