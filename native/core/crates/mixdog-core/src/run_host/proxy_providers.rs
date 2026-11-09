//! The production [`ProxyProviders`]: Node's `loadModelProxyProviderConfig({ force, waitMs: 1000 })`
//! (`providers/model-proxy-provider.mjs`), the setup tool's read of the providers the PC advertises
//! in the model-proxy client mode.
//!
//! The question is one `model/proxy/execute` request carrying `ProxyCall::ProviderConfig` (Node's
//! published `{ provider: '', method: 'providerConfig' }`) to the PC that declared
//! `capabilities.modelProxy`, over the same host channel as [`super::quota_channel`]. What is kept
//! from Node:
//! - an answer counts when the PC says its registry is loaded (`ready`); an unready one is asked
//!   again, 250 ms then doubling to 2 s, until the 1 s budget is spent;
//! - a PC that cannot be reached (no client, gone, did not pick up, stopped answering) is
//!   `Ok(None)` (`MODEL_PROXY_UNAVAILABLE`); the PC's own failure is the error;
//! - a loaded answer is cached for 15 s for one client generation, one read in flight is shared,
//!   and a forced read neither uses nor joins them; only the newest read publishes to the cache.
//!
//! A read that finds no client waits for one to connect (`whenConnected`), woken by the client
//! generation ([`ClientEpoch`]) rather than by polling, and gives up when the budget is spent. An
//! answer that omits `ready` (an older PC) counts when it names an enabled provider, as in Node, and
//! providers keep the order the PC sent them.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::ModelProxyResult;
use mixdog_app_protocol::v2::model_proxy::ProxyAnswer;
use mixdog_app_protocol::v2::model_proxy::ProxyCall;
use mixdog_core_api::ClientEpoch;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::CoreError;
use mixdog_core_domains::domains::ai_account::ProxyProviders;
use mixdog_core_domains::domains::ai_account::failure::Failure;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::time::Instant;

use mixdog_core_api::host::NO_CLAIMANT;

use super::quota_channel::EXECUTE;
use super::quota_channel::failure_message;
use super::quota_channel::message_of;
use super::single_flight::{Core, SingleFlight};

const CACHE_TTL_MS: i64 = 15_000;
const WAIT: Duration = Duration::from_millis(1_000);
const RETRY_FIRST: Duration = Duration::from_millis(250);
const RETRY_MAX: Duration = Duration::from_millis(2_000);

type Providers = Map<String, Value>;
type Outcome = Result<Option<Providers>, Failure>;

struct Cached {
    at: i64,
    generation: u64,
    value: Providers,
}

/// The cache and the read in flight (Node `_providerConfigCache`, `_providerConfigInFlight`); the flight's
/// key is the client generation it started under.
type Reads = SingleFlight<Option<Cached>, u64, Outcome>;

/// Why one ask did not give an answer.
enum Ask {
    /// No client is connected: wait for one.
    NoClient,
    /// `MODEL_PROXY_UNAVAILABLE` of a client that went away or stopped answering: worth retrying.
    Unavailable,
    Failed(String),
}

struct Inner {
    host: Arc<dyn HostChannel>,
    /// The client generation: an answer learned under one is not served to the next.
    epoch: Arc<dyn ClientEpoch>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    reads: Reads,
}

pub struct HostProxyProviders {
    inner: Arc<Inner>,
}

impl HostProxyProviders {
    pub fn new(host: Arc<dyn HostChannel>, epoch: Arc<dyn ClientEpoch>, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { inner: Arc::new(Inner { host, epoch, now, reads: Reads::default() }) }
    }
}

impl Inner {
    fn generation(&self) -> u64 {
        *self.epoch.client_epoch().borrow()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Core<Option<Cached>, u64, Outcome>> {
        self.reads.lock()
    }

    /// One `providerConfig` question: the providers (as the PC projected them) and whether its
    /// registry is loaded.
    async fn ask(&self) -> Result<(Providers, bool), Ask> {
        let call = serde_json::to_value(ProxyCall::ProviderConfig).expect("a typed call serializes");
        let mut no_events = |_: Value| {};
        let reply = self.host.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({ "call": call }), &mut no_events).await;
        match reply {
            Ok(result) => match serde_json::from_value::<ModelProxyResult>(result).map(|result| result.result) {
                Ok(ProxyAnswer::ProviderConfig { providers, ready }) => {
                    let providers: Providers = providers.into_iter().map(|(id, info)| (id, serde_json::to_value(info).expect("a typed provider serializes"))).collect();
                    // `providerConfigReady`: a loaded registry is authoritative, even with nothing enabled;
                    // one that does not say is read by whether it names an enabled provider.
                    let ready = ready.unwrap_or_else(|| providers.values().any(|info| info.get("enabled") == Some(&Value::Bool(true))));
                    Ok((providers, ready))
                }
                Ok(ProxyAnswer::Failed { failure }) => Err(Ask::Failed(message_of(failure))),
                // Node reads any other answer as a registry that has not loaded.
                _ => Ok((Map::new(), false)),
            },
            Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &*detail == NO_CLAIMANT => Err(Ask::NoClient),
            Err(HostError::Core(_)) => Err(Ask::Unavailable),
            Err(HostError::Rpc { data, .. }) => Err(Ask::Failed(failure_message(data))),
        }
    }

    async fn fetch(self: Arc<Self>, id: u64, generation: u64) -> Outcome {
        let deadline = Instant::now() + WAIT;
        let mut delay = RETRY_FIRST;
        // Taken before the first ask, so a client that connects while it runs wakes the wait below.
        let mut changes = self.epoch.client_epoch();
        let outcome = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            // The request is bounded by what is left of the budget ("the desktop provider request timed out").
            match tokio::time::timeout(remaining, self.ask()).await {
                Ok(Ok((providers, true))) => break Ok(Some(providers)),
                Ok(Err(Ask::Failed(message))) => break Err(Failure::error(message)),
                Ok(Err(Ask::NoClient)) => {
                    // `whenConnected(remaining)`: until a client connects, or the budget is spent.
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match tokio::time::timeout(remaining, changes.changed()).await {
                        Ok(Ok(())) => continue,
                        _ => break Ok(None),
                    }
                }
                Ok(Ok((_, false)) | Err(Ask::Unavailable)) | Err(_) => {}
            }
            if Instant::now() + delay > deadline {
                break Ok(None);
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(RETRY_MAX);
        };
        // An older read may finish after a forced one: only the newest read, under the generation it started in, publishes.
        // The slot itself is emptied by the flight's guard when this task ends, however it ends.
        if let Ok(Some(value)) = &outcome
            && self.generation() == generation
        {
            let mut core = self.state();
            if core.holds(id) {
                core.state = Some(Cached { at: (self.now)(), generation, value: value.clone() });
            }
        }
        outcome
    }
}

#[async_trait]
impl ProxyProviders for HostProxyProviders {
    async fn providers(&self, force: bool) -> Outcome {
        let generation = self.inner.generation();
        // The cache check, the join of the read in flight and the start of a new one happen under one
        // lock, so concurrent callers share one fetch; the guard ends with this block, before any await.
        let task = {
            let core = self.inner.state();
            let joined = if force {
                None
            } else {
                if let Some(cached) = core.state.as_ref().filter(|c| c.generation == generation && (self.inner.now)() - c.at < CACHE_TTL_MS) {
                    return Ok(Some(cached.value.clone()));
                }
                core.joinable().filter(|(started, _)| **started == generation).map(|(_, task)| task)
            };
            match joined {
                Some(task) => task,
                // Node's promise runs on its own: the read finishes, publishes and clears its slot
                // whether or not a caller is still waiting (see `single_flight`). The task owns the
                // read; the stored future only awaits its result, so the state never holds the `Inner`.
                None => {
                    let inner = Arc::clone(&self.inner);
                    self.inner.reads.start(
                        "model-proxy-provider-config",
                        core,
                        generation,
                        move |id| inner.fetch(id, generation),
                        |message| Err(Failure::error(message)),
                    )
                }
            }
        };
        task.await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use mixdog_app_protocol::v2::model_proxy::{ProxyDelivery, ProxyErrorKind, ProxyFailure, ProxyOutcome};
    use mixdog_core_api::ids::Method;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/proxy-provider-config/golden.json");

    struct Epoch(tokio::sync::watch::Sender<u64>);

    impl Epoch {
        fn new() -> Arc<Self> {
            Arc::new(Self(tokio::sync::watch::channel(1).0))
        }

        fn changed(&self) {
            self.0.send_modify(|epoch| *epoch += 1);
        }
    }

    impl ClientEpoch for Epoch {
        fn client_epoch(&self) -> tokio::sync::watch::Receiver<u64> {
            self.0.subscribe()
        }
    }

    /// The PC: answers each ask from the scenario's queue and counts them.
    struct Pc {
        replies: Mutex<VecDeque<Value>>,
        connected: AtomicBool,
        asked: Mutex<Vec<Value>>,
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
            self.asked.lock().unwrap().push(params);
            let reply = self.replies.lock().unwrap().pop_front().expect("the scenario scripts every ask");
            if reply["ok"] == true {
                // The object keeps the PC's order (the crate keeps key order), and an older PC sends no `ready`.
                let providers: Map<String, Value> = reply["value"]["providers"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(id, info)| {
                        let mut info = info.clone();
                        info["modelProxy"] = json!({});
                        (id.clone(), info)
                    })
                    .collect();
                let mut answer = json!({ "result": "providerConfig", "providers": providers });
                if let Some(ready) = reply["value"].get("ready") {
                    answer["ready"] = ready.clone();
                }
                Ok(json!({ "result": answer }))
            } else {
                let failure = failure(reply["error"]["message"].as_str().unwrap());
                Err(HostError::Rpc { code: -32000, message: failure.message.clone(), data: Some(serde_json::to_value(failure).unwrap()) })
            }
        }
    }

    fn failure(message: &str) -> ProxyFailure {
        ProxyFailure {
            outcome: ProxyOutcome::Provider,
            kind: ProxyErrorKind::Unknown,
            code: Some("EPC".into()),
            status: None,
            retry_after_ms: None,
            reset_at_ms: None,
            quota_scope: None,
            reauth_required: false,
            should_retry: None,
            text_emitted: false,
            tool_dispatched: false,
            tool_input_cut: false,
            delivery: ProxyDelivery::NotSent,
            transport: None,
            message: message.into(),
            partial_usage: None,
            partial_model: None,
            verification_url: None,
            rejected_tool: None,
            account_blocked: false,
            unsafe_to_retry: false,
            quota_limit: None,
        }
    }

    fn without_traits(mut providers: Providers) -> Providers {
        for info in providers.values_mut() {
            info.as_object_mut().unwrap().shift_remove("modelProxy");
        }
        providers
    }

    #[derive(PartialEq)]
    enum Op {
        Call,
        Reconnect,
    }

    /// The recording lists only calls; the scenarios with a reconnect between them.
    fn scenario_ops(name: &str) -> Vec<Op> {
        match name {
            "a reconnect is a new generation: the cache is not served" => vec![Op::Call, Op::Reconnect, Op::Call],
            "a second call inside 15 s is served from the cache" | "a call after 15 s asks again" | "force asks again inside the cache window" | "a failed ask leaves no cache" => vec![Op::Call, Op::Call],
            _ => vec![Op::Call],
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_read_is_nodes_load_model_proxy_provider_config() {
        mixdog_rt::testing::tokens();
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let mut checked = 0;
        for scenario in golden["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let connect_after = scenario.get("connectAfter").and_then(Value::as_u64);
            let pc = Arc::new(Pc {
                replies: Mutex::new(scenario["replies"].as_array().unwrap().iter().cloned().collect()),
                connected: AtomicBool::new(scenario["connected"] == true && connect_after.is_none()),
                asked: Mutex::default(),
            });
            let epoch = Epoch::new();
            let clock = Arc::new(AtomicI64::new(1_000_000));
            let c = clock.clone();
            let providers = HostProxyProviders::new(pc.clone(), epoch.clone(), Arc::new(move || c.load(Ordering::SeqCst)));
            if let Some(after) = connect_after {
                let (pc, epoch) = (pc.clone(), epoch.clone());
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(after)).await;
                    pc.connected.store(true, Ordering::SeqCst);
                    epoch.changed();
                });
            }
            let mut calls = scenario["calls"].as_array().unwrap().iter();
            for op in scenario_ops(name) {
                if op == Op::Reconnect {
                    epoch.changed();
                    continue;
                }
                let call = calls.next().unwrap();
                clock.fetch_add(call["advance"].as_i64().unwrap(), Ordering::SeqCst);
                let before = pc.asked.lock().unwrap().len();
                let got = providers.providers(call["force"] == true).await;
                let asks = pc.asked.lock().unwrap().len() - before;
                assert_eq!(asks as u64, call["asks"].as_u64().unwrap(), "{name}: asks");
                match (got, call.get("error")) {
                    (Ok(Some(got)), None) => {
                        // Entries in the PC's order, not a map compared as a set.
                        let want: Vec<(String, Value)> = call["value"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                        assert_eq!(without_traits(got).into_iter().collect::<Vec<_>>(), want, "{name}");
                    }
                    (Ok(None), Some(error)) => assert_eq!(error["code"], "MODEL_PROXY_UNAVAILABLE", "{name}"),
                    (Err(failure), Some(error)) => assert_eq!(failure.message(), error["message"].as_str().unwrap(), "{name}"),
                    (got, want) => panic!("{name}: {got:?} against {want:?}"),
                }
                checked += 1;
            }
            if let Some(first) = pc.asked.lock().unwrap().first() {
                assert_eq!(first["call"]["method"], "providerConfig", "{name}");
            }
        }
        assert!(checked >= 17, "the recording is replayed: {checked}");
    }

    /// A PC whose answer is held until the test lets it go.
    struct GatedPc {
        started: tokio::sync::Notify,
        gate: tokio::sync::Notify,
        answered: tokio::sync::Notify,
        asked: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl HostChannel for GatedPc {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a provider question is a streamed request")
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a provider question sends no notification")
        }

        async fn request_streamed(&self, _: HostCapability, _: Method, _: Value, _: &mut (dyn FnMut(Value) + Send)) -> Result<Value, HostError> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.gate.notified().await;
            self.answered.notify_one();
            let info = json!({ "enabled": true, "type": "api-key", "authState": "present", "modelProxy": {} });
            Ok(json!({ "result": { "result": "providerConfig", "providers": { "openai": info }, "ready": true } }))
        }
    }

    /// A PC whose handling of the question panics, which ends the read's task abnormally.
    struct PanickingPc;

    #[async_trait]
    impl HostChannel for PanickingPc {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a provider question is a streamed request")
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a provider question sends no notification")
        }

        async fn request_streamed(&self, _: HostCapability, _: Method, _: Value, _: &mut (dyn FnMut(Value) + Send)) -> Result<Value, HostError> {
            panic!("the host died while answering");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_task_ends_abnormally_rejects_its_callers_and_clears_its_slot() {
        mixdog_rt::testing::tokens();
        let providers = HostProxyProviders::new(Arc::new(PanickingPc), Epoch::new(), Arc::new(|| 1_000_000));
        let failure = providers.providers(false).await.unwrap_err();
        assert!(failure.message().contains("panicked"), "{}", failure.message());
        let state = providers.inner.state();
        assert!(state.is_idle(), "the slot is empty, so the next call reads again");
        assert!(state.state.is_none(), "nothing was published");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_read_reaches_both_waiters_and_the_next_call_reads_again() {
        mixdog_rt::testing::tokens();
        let providers = HostProxyProviders::new(Arc::new(PanickingPc), Epoch::new(), Arc::new(|| 1_000_000));
        let (first, second) = futures::join!(providers.providers(false), providers.providers(false));
        let (first, second) = (first.unwrap_err(), second.unwrap_err());
        assert!(first.message().contains("panicked"), "{}", first.message());
        assert_eq!(first.message(), second.message(), "the second call joined the first one's read");
        assert!(providers.inner.state().is_idle(), "the failure is not retained in the slot");
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_whose_callers_all_left_still_completes_publishes_and_clears_its_slot() {
        mixdog_rt::testing::tokens();
        let pc = Arc::new(GatedPc {
            started: tokio::sync::Notify::new(),
            gate: tokio::sync::Notify::new(),
            answered: tokio::sync::Notify::new(),
            asked: std::sync::atomic::AtomicUsize::new(0),
        });
        let providers = HostProxyProviders::new(pc.clone(), Epoch::new(), Arc::new(|| 1_000_000));
        let mut caller = Box::pin(providers.providers(false));
        assert!(futures::poll!(caller.as_mut()).is_pending());
        mixdog_core_session::session::testing::awaiting("the PC read to start", pc.started.notified()).await;
        let mut joined = providers.inner.state().joinable().expect("the read is in flight").1;
        drop(caller);
        pc.gate.notify_one();
        // Nobody polls the read now but its own task: it still reaches the PC's answer.
        // Biased: the answer precedes the join, so when both are ready the answer's kept permit is taken first.
        mixdog_core_session::session::testing::awaiting("the PC to answer the read", async {
            tokio::select! {
                biased;
                () = pc.answered.notified() => {}
                outcome = &mut joined => panic!("the read ended without the PC's answer (the join answered: {})", outcome.is_ok()),
            }
        })
        .await;
        let outcome = mixdog_core_session::session::testing::awaiting("the read to end once the PC has answered", joined).await;
        assert_eq!(without_traits(outcome.unwrap().unwrap()).keys().collect::<Vec<_>>(), ["openai"]);
        {
            let state = providers.inner.state();
            assert!(state.is_idle(), "the finished read cleared its slot");
            assert!(state.state.is_some(), "the finished read published its answer");
        }
        let cached = providers.providers(false).await.unwrap().unwrap();
        assert_eq!(cached.keys().collect::<Vec<_>>(), ["openai"]);
        assert_eq!(pc.asked.load(Ordering::SeqCst), 1, "the cache answered the second call");
    }
}