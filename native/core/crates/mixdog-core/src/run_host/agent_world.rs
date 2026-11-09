//! The production worlds of the hidden-role dispatch ([`DispatchWorld`], [`HostWorld`]): what a
//! `cycle1-agent` (or title, or explore) dispatch reads of the configuration and the product
//! around it, and what the inline host checks before it runs one.
//!
//! Each value is Node's, checked against `fixtures/agent-world` (recorded by
//! `benchmarks/rust-core/recorders/record-agent-world.mjs` from the real modules):
//! `getHiddenAgent` (`defaults/agents.json` with the frontmatter of its `systemFile`),
//! `resolveRuntimeSpec`, and `contextSelectionFromState(resolveRouteContextState(..))`.
//! `configuredAgentRouteCandidates` is the config's `agents.<role>` entry: Node asks the bot store
//! first, but an internal role is never a bot (agent creation refuses a name that collides with
//! `listHiddenAgentNames`), so the store answers "no bot" and the config decides.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::Clock;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::{jnum, resolve_route_context_state, truthy};
use mixdog_core_config::config::Config;
use mixdog_core_config::config::hidden_agents::hidden_agent;
use serde_json::{Map, Value};

use super::agent_dispatch::{DispatchWorld, HostWorld};
use super::run_seams::EnvReader;
use super::single_flight::{Join, SingleFlight};

/// `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

/// `resolveRuntimeSpec(preset, { lane: 'agent', agentId })`: effort and fast changes share a
/// session; role, provider or model changes do not. (Node throws `agent lane requires agentId` for an
/// empty id; a dispatch always names its agent, so the id is never empty here.)
pub fn resolve_runtime_spec(preset: &Value, agent: &str) -> Value {
    let provider = Some(clean(preset.get("provider"))).filter(|p| !p.is_empty()).unwrap_or_else(|| "unknown".into());
    let model = Some(clean(preset.get("model"))).filter(|m| !m.is_empty()).unwrap_or_else(|| "_".into());
    serde_json::json!({
        "lane": "agent",
        "scopeKey": format!("agent:{agent}:{provider}:{model}"),
        "reuse": true,
        "preset": preset,
    })
}

/// `configuredAgentRouteCandidates(config, role)` for an internal role: the config's `agents.<role>`
/// when it names a route.
pub fn configured_route_candidates(config: &Map<String, Value>, role: &str) -> Vec<Value> {
    let id = mixdog_js::js_trim(role);
    if id.is_empty() {
        return Vec::new();
    }
    config.get("agents").and_then(|agents| agents.get(id)).filter(|route| truthy(Some(route))).cloned().into_iter().collect()
}

/// `assertOpen(signal)`: an aborted signal throws its own reason first, then a closed host throws.
fn open_check(closed: bool, cancel: Option<&Cancel>) -> Result<(), String> {
    if let Some(cancel) = cancel.filter(|cancel| cancel.is_aborted()) {
        return Err(cancel.reason());
    }
    if closed {
        return Err("session runtime host is closed".to_owned());
    }
    Ok(())
}

/// The model window a route's own context choice is sized on (`cachedRouteWindows`).
pub trait RouteWindows: Send + Sync {
    fn window_meta(&self, provider: &str, model: &str) -> Option<Value>;
}

/// The provider catalog's cached model row.
pub struct CatalogWindows(pub Arc<CatalogService>);

impl RouteWindows for CatalogWindows {
    fn window_meta(&self, provider: &str, model: &str) -> Option<Value> {
        self.0.cached_windows(provider, model).and_then(|windows| serde_json::to_value(windows).ok())
    }
}

/// `contextSelectionFromState(resolveRouteContextState(preset, null), preset)`: the session fields a
/// route's own context choice creates a session with. A model whose window is not known resolves to
/// nothing, so the choice travels as stored. Only set fields are returned.
pub fn context_selection(preset: &Value, windows: &dyn RouteWindows) -> Map<String, Value> {
    let route = preset.as_object().cloned().unwrap_or_default();
    let meta = windows.window_meta(&clean(route.get("provider")), &clean(route.get("model")));
    let state = resolve_route_context_state(&route, meta.as_ref());
    let window_known = state.context_default_percent.is_some();
    let percent = state.context_percent.map(jnum).or_else(|| route.get("contextPercent").cloned());
    let window = state.selected_context_window.map(jnum);
    let tokens = state.context_tokens.map(jnum).or_else(|| if window_known { None } else { route.get("contextTokens").cloned() });
    let mut chosen = Map::new();
    for (key, value) in [("contextPercent", percent), ("selectedContextWindow", window), ("contextTokens", tokens)] {
        if let Some(value) = value.filter(|v| truthy(Some(v))) {
            chosen.insert(key.into(), value);
        }
    }
    chosen
}

/// [`DispatchWorld`] over the saved config, the shipped internal agents and the catalog.
pub struct AgentWorld {
    config: Config,
    windows: Arc<dyn RouteWindows>,
    env: EnvReader,
    clock: Arc<dyn Clock>,
}

impl AgentWorld {
    pub fn new(config: Config, windows: Arc<dyn RouteWindows>, env: EnvReader, clock: Arc<dyn Clock>) -> Self {
        Self { config, windows, env, clock }
    }
}

impl DispatchWorld for AgentWorld {
    fn config(&self) -> Map<String, Value> {
        (*self.config.full()).clone()
    }

    fn hidden_agent(&self, name: &str) -> Option<Value> {
        hidden_agent(name)
    }

    fn route_candidates(&self, config: &Map<String, Value>, role: &str) -> Vec<Value> {
        configured_route_candidates(config, role)
    }

    fn runtime_spec(&self, preset: &Value, agent: &str) -> Value {
        resolve_runtime_spec(preset, agent)
    }

    fn context_selection(&self, preset: &Value) -> Map<String, Value> {
        context_selection(preset, self.windows.as_ref())
    }

    fn env(&self, name: &str) -> Option<String> {
        (self.env)(name)
    }

    fn clock(&self) -> Arc<dyn Clock> {
        self.clock.clone()
    }

    fn diagnostic(&self, line: &str) {
        mixdog_rt::node_stderr!("{line}");
    }
}

/// Why a preparation failed: the registry's own message, or its task ending abnormally (a panic, or
/// the runtime shutting down), which rejects every waiter as Node's promise would.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
enum PrepareFailure {
    #[error("{0}")]
    Init(String),
    #[error("{0}")]
    Task(String),
}

type Outcome = Result<(), PrepareFailure>;

/// What a dispatch does about the preparation.
enum Step {
    /// The registry already holds this signature.
    Ready,
    /// This call started the work.
    Started(Join<Outcome>),
    /// Another call's work is in flight.
    Joined(Join<Outcome>),
}

/// Node's `preparedProviderSignature` (the single-flight's state: the `providers` section the
/// registry was last initialised with) and `providerPreparePromise` (its flight), `boot-loaders.mjs:80-109`.
#[derive(Default)]
struct Preparation(SingleFlight<Option<String>, (), Outcome>);

impl Preparation {
    /// `boot-loaders.mjs:87-103`. `work` is built only when this call starts the preparation.
    fn step<W: Future<Output = Result<(), String>> + Send + 'static>(&self, signature: String, work: impl FnOnce() -> W) -> Step {
        let core = self.0.lock();
        if core.state.as_deref() == Some(signature.as_str()) {
            return Step::Ready;
        }
        if let Some((_, join)) = core.joinable() {
            return Step::Joined(join);
        }
        let flights = self.0.clone();
        Step::Started(self.0.start(
            "agent-provider-preparation",
            core,
            (),
            // The future is built here, outside the spawned task, so the task owns only a `Send + 'static`
            // future (`work` itself may borrow the caller).
            move |_| {
                let work = work();
                async move {
                    let outcome = work.await.map_err(PrepareFailure::Init);
                    if outcome.is_ok() {
                        flights.lock().state = Some(signature);
                    }
                    outcome
                }
            },
            |message| Err(PrepareFailure::Task(message)),
        ))
    }

    fn is_prepared(&self, signature: &str) -> bool {
        self.0.lock().state.as_deref() == Some(signature)
    }

    /// `prepareAgentProviders` after the keychain prewarm. `load` reads the `providers` section now
    /// (its signature and the value `work` initialises the registry with).
    async fn prepare<P, W: Future<Output = Result<(), String>> + Send + 'static>(
        &self,
        mut assert_open: impl FnMut() -> Result<(), String>,
        mut load: impl FnMut() -> (String, P),
        work: impl Fn(P) -> W,
    ) -> Result<(), String> {
        loop {
            assert_open()?;
            let (signature, payload) = load();
            let (flight, joined) = match self.step(signature.clone(), || work(payload)) {
                Step::Ready => return Ok(()),
                Step::Started(flight) => (flight, false),
                Step::Joined(flight) => (flight, true),
            };
            flight.await.map_err(|failure| failure.to_string())?;
            if !joined {
                return Ok(());
            }
            assert_open()?;
            // The finished work answers a joiner whose own snapshot it recorded; only another one
            // starts over, reading the config again (`boot-loaders.mjs:88-93`).
            if self.is_prepared(&signature) {
                return Ok(());
            }
        }
    }
}

/// [`HostWorld`] of the inline host: open until [`AgentHost::close`], and the providers the agents
/// reach are registered once per distinct `providers` section (`prepareAgentProviders`).
pub struct AgentHost {
    config: Config,
    registry: Arc<ProviderRegistry>,
    closed: Arc<AtomicBool>,
    prepared: Preparation,
}

impl AgentHost {
    pub fn new(config: Config, registry: Arc<ProviderRegistry>) -> Self {
        Self { config, registry, closed: Arc::new(AtomicBool::new(false)), prepared: Preparation::default() }
    }

    /// The host is closing: every later dispatch is refused.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn providers(&self) -> Map<String, Value> {
        self.config.agent().get("providers").and_then(Value::as_object).cloned().unwrap_or_default()
    }
}

#[async_trait]
impl HostWorld for AgentHost {
    fn assert_open(&self, cancel: Option<&Cancel>) -> Result<(), String> {
        open_check(self.closed.load(Ordering::SeqCst), cancel)
    }

    async fn prepare_providers(&self, cancel: &Cancel) -> Result<(), String> {
        self.prepared
            .prepare(
                || self.assert_open(Some(cancel)),
                || {
                    let providers = self.providers();
                    (Value::Object(providers.clone()).to_string(), providers)
                },
                |providers| {
                    let (closed, registry) = (self.closed.clone(), self.registry.clone());
                    // Only the host closing retires the shared work, not one waiter's cancel
                    // (`boot-loaders.mjs:95-99`).
                    async move {
                        open_check(closed.load(Ordering::SeqCst), None)?;
                        registry.init_providers(&providers).await.map_err(|error| error.message)
                    }
                },
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/agent-world/golden.json");

    fn golden() -> Value {
        serde_json::from_str(GOLDEN).unwrap()
    }

    #[test]
    fn the_runtime_spec_is_what_node_resolved() {
        for case in golden()["runtimeSpec"].as_array().unwrap() {
            let preset = &case["preset"];
            let got = resolve_runtime_spec(preset, case["agentId"].as_str().unwrap());
            assert_eq!(got, case["spec"], "{preset}");
        }
    }

    struct Table;

    impl RouteWindows for Table {
        fn window_meta(&self, provider: &str, model: &str) -> Option<Value> {
            match (provider, model) {
                ("p", "known") => Some(serde_json::json!({ "contextWindow": 400000, "maxContextWindow": 1000000 })),
                ("p", "plain") => Some(serde_json::json!({ "contextWindow": 200000, "maxContextWindow": 200000 })),
                ("p", "only-max") => Some(serde_json::json!({ "maxContextWindow": 500000 })),
                _ => None,
            }
        }
    }

    /// `serde_json` keeps `120000` and `120000.0` apart; JavaScript has one number type.
    fn floats(value: Value) -> Value {
        match value {
            Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
            Value::Array(items) => Value::Array(items.into_iter().map(floats).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, floats(v))).collect()),
            other => other,
        }
    }

    #[test]
    fn a_routes_context_choice_is_what_node_selected() {
        for case in golden()["contextSelection"].as_array().unwrap() {
            let got = Value::Object(context_selection(&case["route"], &Table));
            assert_eq!(floats(got), floats(case["selection"].clone()), "{}", case["route"]);
        }
    }

    #[test]
    fn the_route_candidates_of_a_role_are_its_configured_route() {
        let config = serde_json::json!({ "agents": { "maintainer": { "provider": "p", "model": "m" }, "explore": "" } });
        let config = config.as_object().unwrap();
        assert_eq!(configured_route_candidates(config, " maintainer "), vec![serde_json::json!({ "provider": "p", "model": "m" })]);
        assert!(configured_route_candidates(config, "explore").is_empty(), "an empty route is no route");
        assert!(configured_route_candidates(config, "").is_empty());
        assert!(configured_route_candidates(config, "absent").is_empty());
    }

    #[test]
    fn an_aborted_signal_is_refused_with_its_reason_before_a_closed_host() {
        let cancel = Cancel::new();
        assert_eq!(open_check(false, Some(&cancel)), Ok(()));
        assert_eq!(open_check(true, None), Err("session runtime host is closed".to_owned()));
        cancel.abort("stop now");
        assert_eq!(open_check(true, Some(&cancel)), Err("stop now".to_owned()));
        assert_eq!(open_check(false, Some(&cancel)), Err("stop now".to_owned()));
    }

    /// A preparation held until the test lets it go.
    struct Gated {
        gate: tokio::sync::Notify,
        runs: std::sync::atomic::AtomicUsize,
    }

    impl Gated {
        fn new() -> Arc<Self> {
            Arc::new(Self { gate: tokio::sync::Notify::new(), runs: std::sync::atomic::AtomicUsize::new(0) })
        }

        async fn work(self: Arc<Self>) -> Result<(), String> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            self.gate.notified().await;
            Ok(())
        }
    }

    fn open() -> Result<(), String> {
        Ok(())
    }

    #[tokio::test(start_paused = true)]
    async fn a_joined_waiter_is_answered_by_the_signature_it_asked_for_not_the_configs_new_one() {
        mixdog_rt::testing::tokens();
        let work = Gated::new();
        let preparation = Preparation::default();
        let config = std::cell::Cell::new("a");
        let mut starter = Box::pin(preparation.prepare(open, || ("a".to_owned(), ()), |()| work.clone().work()));
        assert!(futures::poll!(starter.as_mut()).is_pending());
        let mut joiner = Box::pin(preparation.prepare(open, || (config.get().to_owned(), ()), |()| work.clone().work()));
        assert!(futures::poll!(joiner.as_mut()).is_pending());
        // The config changes while the joiner waits; the work it joined records "a".
        config.set("b");
        work.gate.notify_one();
        assert_eq!(starter.await, Ok(()));
        assert_eq!(joiner.await, Ok(()), "the joiner asked for \"a\", which the finished work recorded");
        assert_eq!(work.runs.load(Ordering::SeqCst), 1, "nothing started \"b\"");
        assert!(preparation.is_prepared("a") && !preparation.is_prepared("b"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_joiner_whose_snapshot_was_not_recorded_starts_over_on_the_new_config() {
        mixdog_rt::testing::tokens();
        let work = Gated::new();
        let preparation = Preparation::default();
        let mut starter = Box::pin(preparation.prepare(open, || ("a".to_owned(), ()), |()| work.clone().work()));
        assert!(futures::poll!(starter.as_mut()).is_pending());
        let snapshots = std::cell::Cell::new(0);
        let mut joiner = Box::pin(preparation.prepare(
            open,
            || {
                snapshots.set(snapshots.get() + 1);
                (if snapshots.get() == 1 { "b" } else { "c" }.to_owned(), ())
            },
            |()| work.clone().work(),
        ));
        assert!(futures::poll!(joiner.as_mut()).is_pending());
        work.gate.notify_one();
        assert_eq!(starter.await, Ok(()));
        // "a" was recorded, not the joiner's "b": it reads the config again and starts that work.
        assert!(futures::poll!(joiner.as_mut()).is_pending());
        work.gate.notify_one();
        assert_eq!(joiner.await, Ok(()));
        assert_eq!(work.runs.load(Ordering::SeqCst), 2);
        assert!(preparation.is_prepared("c"));
    }
}
