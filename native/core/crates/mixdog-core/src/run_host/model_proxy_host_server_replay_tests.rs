//! Replay of the server's provider-config read of `native/core/fixtures/model-proxy-host-cases` (Node
//! `loadModelProxyProviderConfig`) through the product's [`HostProxyProviders`] over a scripted host channel that
//! answers each `ProxyCall::ProviderConfig` when the case says. The claim and heartbeat of Node's channel are the
//! replaced protocol (mixdog-app-protocol/src/inventory.rs marks them Deleted); a stalled PC is a request whose answer
//! never comes.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::ClientEpoch;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::host::NO_CLAIMANT;
use mixdog_core_api::ids::Method;
use mixdog_core_domains::domains::ai_account::ProxyProviders;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::proxy_providers::HostProxyProviders;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-cases/golden.json");

fn observed(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

struct Epoch(tokio::sync::watch::Sender<u64>);

impl ClientEpoch for Epoch {
    fn client_epoch(&self) -> tokio::sync::watch::Receiver<u64> {
        self.0.subscribe()
    }
}

/// Counts the asks whose future was dropped before an answer: the request the deadline aborted.
struct Pending(Arc<AtomicUsize>, bool);

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.1 {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// The PC end of the host channel: each `providerConfig` question waits for the case to answer it (`{ready, providers}`).
#[derive(Default)]
struct Pc {
    connected: AtomicBool,
    replies: Mutex<Vec<oneshot::Sender<Value>>>,
    asked: AtomicUsize,
    aborted: Arc<AtomicUsize>,
    asking: tokio::sync::Notify,
}

impl Pc {
    fn answer(&self, index: usize, value: Value) {
        let reply = std::mem::replace(&mut self.replies.lock().unwrap()[index], oneshot::channel().0);
        reply.send(value).unwrap();
    }
}

#[async_trait]
impl HostChannel for Pc {
    async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
        unreachable!("a provider question is a streamed request")
    }

    fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
        unreachable!("a provider question sends no notification")
    }

    async fn request_streamed(&self, _: HostCapability, _: Method, params: Value, _: &mut (dyn FnMut(Value) + Send)) -> Result<Value, HostError> {
        if !self.connected.load(Ordering::SeqCst) {
            return Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: NO_CLAIMANT.into() }));
        }
        assert_eq!(params["call"]["method"], "providerConfig");
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().push(tx);
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.asking.notify_one();
        let mut pending = Pending(self.aborted.clone(), false);
        let reply = rx.await.expect("the case answers or the read drops the ask");
        pending.1 = true;
        // The typed answer: every provider carries its traits (Node's answers here name none).
        let providers: Map<String, Value> = reply["providers"].as_object().unwrap().iter().map(|(id, info)| {
            let mut info = info.clone();
            info.as_object_mut().unwrap().entry("modelProxy").or_insert(json!({}));
            (id.clone(), info)
        }).collect();
        Ok(json!({ "result": { "result": "providerConfig", "providers": providers, "ready": reply["ready"] } }))
    }
}

fn server(pc: &Arc<Pc>) -> (HostProxyProviders, Arc<Epoch>) {
    let epoch = Arc::new(Epoch(tokio::sync::watch::channel(1).0));
    (HostProxyProviders::new(pc.clone(), epoch.clone(), Arc::new(|| 1_000_000)), epoch)
}

fn connected() -> Arc<Pc> {
    let pc = Arc::new(Pc::default());
    pc.connected.store(true, Ordering::SeqCst);
    pc
}

/// The answer as Node's config: the traits the scripted PC added are taken off where Node's answer named none.
fn as_node(got: Map<String, Value>, node: &Value) -> Value {
    got.into_iter()
        .map(|(id, mut info)| {
            if node[&id].get("modelProxy").is_none() {
                info.as_object_mut().unwrap().shift_remove("modelProxy");
            }
            (id, info)
        })
        .collect()
}

async fn asked(pc: &Pc, n: usize) {
    while pc.asked.load(Ordering::SeqCst) < n {
        pc.asking.notified().await;
    }
}

/// Case 9, the server's part: a read before any PC is connected waits for one (inside Node's `waitMs: 2000`; the
/// product's budget is the one second of every read, proxy_providers.rs `WAIT`), then takes its answer.
#[tokio::test(start_paused = true)]
async fn a_read_before_the_pc_connects_waits_for_it() {
    let node = observed("cold start: the daemon waits for a PC that connects late and loads its registry on demand");
    let pc = Arc::new(Pc::default());
    let (server, epoch) = server(&pc);
    let read = server.providers(false);
    let late = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        pc.connected.store(true, Ordering::SeqCst);
        epoch.0.send_modify(|e| *e += 1);
        asked(&pc, 1).await;
        pc.answer(0, json!({ "ready": true, "providers": node["config"] }));
    };
    let (got, ()) = tokio::join!(read, late);
    assert_eq!(Value::Object(got.unwrap().expect("the PC answered")), node["config"]);
}

/// Case 10: an unready answer is asked again, and the loaded one is the answer.
#[tokio::test(start_paused = true)]
async fn an_unready_answer_is_asked_again() {
    let node = observed("the daemon retries an unready PC answer instead of reading it as \"all disabled\"");
    let pc = connected();
    let (server, _) = server(&pc);
    let read = server.providers(false);
    let answers = async {
        asked(&pc, 1).await;
        pc.answer(0, json!({ "ready": false, "providers": {} }));
        asked(&pc, 2).await;
        pc.answer(1, json!({ "ready": true, "providers": node["config"] }));
    };
    let (got, ()) = tokio::join!(read, answers);
    assert_eq!(as_node(got.unwrap().expect("loaded"), &node["config"]), node["config"]);
    assert_eq!(pc.asked.load(Ordering::SeqCst) as u64, node["asked"].as_u64().unwrap());
}

/// Cases 21 and 22: a PC that never answers is given up at the deadline, the stalled request is dropped (aborted), and
/// the read is `MODEL_PROXY_UNAVAILABLE` (`Ok(None)`, proxy_providers.rs). Whether the PC had claimed the call is the
/// replaced protocol's distinction: a typed run is the PC's from the moment it is sent.
#[tokio::test(start_paused = true)]
async fn a_stalled_pc_is_given_up_at_the_deadline() {
    for claimed in [false, true] {
        let node = observed(&format!("provider config deadline aborts a stalled request (claimed={claimed})"));
        assert_eq!(node["outcome"]["rejected"]["code"], "MODEL_PROXY_UNAVAILABLE");
        let pc = connected();
        let (server, _) = server(&pc);
        let started = tokio::time::Instant::now();
        let got = server.providers(false).await;
        assert!(matches!(got, Ok(None)), "{got:?}");
        assert_eq!(started.elapsed(), Duration::from_secs(1), "the read's budget");
        assert_eq!((pc.asked.load(Ordering::SeqCst), pc.aborted.load(Ordering::SeqCst)), (1, 1), "the one request was dropped at the deadline");
    }
}

/// Case 23: a forced read does not join the older one, and the older one, answered late, does not overwrite the
/// cache the forced one published. Node's second part (a short-budget read does not join a longer one) has no
/// typed form: every read has the same budget (proxy_providers.rs `WAIT`), so a joined read never outlives its own.
#[tokio::test(start_paused = true)]
async fn a_forced_read_neither_joins_nor_is_overwritten_by_an_older_one() {
    let node = observed("forced and short-budget reads do not join an older request or let it overwrite the fresh cache");
    let log = node["log"].as_array().unwrap();
    let pc = connected();
    let (server, _) = server(&pc);
    let mut old = Box::pin(server.providers(false));
    assert!(futures::poll!(old.as_mut()).is_pending());
    let mut fresh = Box::pin(server.providers(true));
    assert!(futures::poll!(fresh.as_mut()).is_pending());
    asked(&pc, 2).await;
    assert_eq!(json!({ "step": "old + forced", "requestsSent": pc.asked.load(Ordering::SeqCst) }), log[0]);
    pc.answer(1, json!({ "ready": true, "providers": { "gemini": { "enabled": true } } }));
    let config = as_node(fresh.await.unwrap().unwrap(), &log[1]["config"]);
    assert_eq!(json!({ "step": "forced answered", "config": config }), log[1]);
    pc.answer(0, json!({ "ready": true, "providers": { "gemini": { "enabled": false } } }));
    old.await.unwrap();
    let cached = as_node(server.providers(false).await.unwrap().unwrap(), &log[2]["config"]);
    assert_eq!(json!({ "step": "old answered late, cache read", "config": cached }), log[2]);
    assert_eq!(pc.asked.load(Ordering::SeqCst), 2, "the cache answered");
    assert_eq!(log[3]["step"], "long + short wait");
}
