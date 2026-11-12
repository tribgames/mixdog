//! The real [`SummaryHost`]: what a session's compaction summary route plan reads of the process
//! around it (Node `session/loop/fresh-context.mjs` `compactionSummaryPlan` and
//! `session/compact/summary-route.mjs`): the conversation's own route from the session header,
//! the Maintainer's route from the saved config, the provider registry, the catalog's whole
//! window, the token calibration, the summary sender and the provider's saved account catalog.
//!
//! One [`SummaryServices`] per process; [`SummaryServices::host`] binds it to one session, the
//! value `CompactionFacts.summary` carries.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{SummaryCall, SummaryFailure, SummaryResponse, SummarySender, route_failure};
use mixdog_agent::env::Clock;
use mixdog_agent::one_shot::OneShot;
use mixdog_agent::tools::ToolEnv;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::approval::{ApprovalAsk, ApprovalGate};
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::tool::{ProgressSink, SurfaceKind, ToolIo, ToolProgress};
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::{ApprovalResolution, TurnId};
use mixdog_rt::{InLane, InteractiveIo};
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::run_host::run_seams::EnvReader;
use mixdog_core_config::config::agent_disabled;
use crate::run_host::run_seams::token_calibration;
use mixdog_core_base::support::on_lane;
use mixdog_core_run::run_host::hop_host::ConfigSnapshot;
use crate::run_host::retry::{RandomJitter, TimerWait};
use mixdog_core_run::run_host::session_context_meta::session_context_meta_with;
use crate::run_host::summary_routes::{MaintainerRoute, SessionRoute, SummaryHost, maintainer_effort};

/// The Maintainer's agent id (the settings role of `cycle1-agent`'s `maintKey: memory`).
const MAINTAINER_ROLE: &str = "maintainer";
const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

/// The summary's `ProgressSink`: it drops what it is given. Node's summary requests (`forked-summary.mjs` `provider.send(..)`, the isolated request in `runner.mjs`) carry no
/// progress callback and offer no tool, so nothing about a summary is ever shown on the thread being summarized; there is no per-thread sink to build.
pub struct DroppedProgress;

impl ProgressSink for DroppedProgress {
    fn progress(&self, _: ToolProgress) {}
}

/// What the process supplies. `config` is the agent config (`loadConfig()`: providers, agents,
/// disabled agents); `data_dir` holds the providers' saved catalogs.
pub struct SummaryDeps {
    pub registry: Arc<ProviderRegistry>,
    pub catalog: Arc<CatalogService>,
    pub config: ConfigSnapshot,
    pub env: EnvReader,
    pub clock: Arc<dyn Clock>,
    pub data_dir: AbsPath,
    /// The file and process services and the lanes a summary call's run identity carries; no
    /// tool is offered to a summary, so none of them is used by it.
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub progress: Arc<dyn ProgressSink>,
    pub io: ToolIo,
}

pub struct SummaryServices {
    deps: Arc<SummaryDeps>,
}

impl SummaryServices {
    pub fn new(deps: SummaryDeps) -> Self {
        Self { deps: Arc::new(deps) }
    }

    /// The heartbeat's Maintainer model over the same providers (`createMaintainerCall`).
    pub fn heartbeat_maintainer(&self) -> Arc<crate::run_host::heartbeat_parts::HeartbeatMaintainer> {
        crate::run_host::heartbeat_parts::HeartbeatMaintainer::new(self.deps.clone())
    }

    /// The title model over the same providers (`generateSessionTitle`).
    pub fn title_completion(&self) -> crate::run_host::title_completion::TitleCompletion {
        crate::run_host::title_completion::TitleCompletion::new(self.deps.clone())
    }

    /// The host of one session. `header` names its own route (`provider`, `model`,
    /// `contextWindow`); a Maintainer-only user passes an empty header.
    pub fn host(&self, thread: &ThreadId, header: &Header) -> Arc<dyn SummaryHost> {
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let window = mixdog_agent::agent_tool::scope::positive_int(header.get("contextWindow"));
        Arc::new(ProcessSummaryHost {
            deps: self.deps.clone(),
            thread: thread.clone(),
            attributed: true,
            session: SessionRoute { provider: text("provider"), model: text("model"), context_window: window },
        })
    }

    /// The host of a step that belongs to no session (the room supervisor, `decideRoomTurn`): no
    /// route of its own, and its usage is recorded against no session, as Node's send carries no
    /// `sessionId`. `label` only names the run for the tool-free send's identity.
    pub fn sessionless_host(&self, label: &str) -> Arc<dyn SummaryHost> {
        Arc::new(ProcessSummaryHost {
            deps: self.deps.clone(),
            thread: ThreadId::from(label),
            attributed: false,
            session: SessionRoute { provider: String::new(), model: String::new(), context_window: None },
        })
    }
}

struct ProcessSummaryHost {
    deps: Arc<SummaryDeps>,
    thread: ThreadId,
    /// The summary's usage is the session's (`<thread>:compact`); false for a session-less step.
    attributed: bool,
    session: SessionRoute,
}

/// The usage attribution of a summary request: the session's own `<thread>:compact`, or none.
fn attributed_session(thread: &ThreadId, attributed: bool) -> Option<String> {
    attributed.then(|| format!("{}:compact", thread.as_str()))
}

/// `String(value || '').trim()`.
pub(crate) fn trimmed(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

/// The Maintainer's route of a config: a disabled Maintainer has none, its stored route is the
/// only candidate and needs a provider and a model, and its provider must not be switched off.
pub(crate) fn maintainer_of(config: &Map<String, Value>) -> Option<MaintainerRoute> {
    if agent_disabled(config, MAINTAINER_ROLE) {
        return None;
    }
    let route = config.get("agents")?.get(MAINTAINER_ROLE).filter(|route| route.is_object())?;
    let (provider, model) = (trimmed(route.get("provider")), trimmed(route.get("model")));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let enabled = config.get("providers").and_then(|p| p.get(&provider)).and_then(|p| p.get("enabled"));
    (enabled != Some(&Value::Bool(false))).then(|| MaintainerRoute {
        fast: route.get("fast") == Some(&Value::Bool(true)),
        effort: maintainer_effort(route.get("effort")),
        provider,
        model,
    })
}

#[async_trait]
impl SummaryHost for ProcessSummaryHost {
    fn session(&self) -> SessionRoute {
        self.session.clone()
    }

    /// `resolveMaintenanceRoute({ agent: 'cycle1-agent', config, includeDefault: false })`: a
    /// disabled Maintainer has no route, its stored route is the only candidate and needs a
    /// provider and a model; then its provider must not be switched off.
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        maintainer_of(&(self.deps.config)())
    }

    /// `await initProviders(config.providers || {})` (when `init`) then `getProvider(provider)`: an
    /// init failure is the step's own failure, moving to the next route when `fallsToNextRoute`
    /// says so; a provider that is not there is not ready.
    async fn provider_ready(&self, provider: &str, init: bool) -> Result<bool, SummaryFailure> {
        if init {
            let config = (self.deps.config)();
            let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
            self.deps.registry.init_providers(&providers).await.map_err(|error| route_failure(error.message, error.code, None, false))?;
        }
        Ok(self.deps.registry.try_get(provider).await.map_err(|error| SummaryFailure::Failed(error.message))?.is_some())
    }

    fn whole_window(&self, provider: &str, model: &str) -> u64 {
        session_context_meta_with(&self.deps.catalog, provider, model, &json!({}), true)
            .and_then(|meta| meta.context_window.as_f64())
            .map_or(0, |window| window as u64)
    }

    fn calibration(&self, provider: &str, _model: &str) -> f64 {
        token_calibration(Some(&Value::String(provider.to_owned())), &|name| (self.deps.env)(name))
    }

    fn sender(&self, provider: &str) -> Arc<dyn SummarySender> {
        Arc::new(RegistrySender { deps: self.deps.clone(), thread: self.thread.clone(), attributed: self.attributed, provider: provider.to_owned() })
    }

    /// `loadAnthropicCatalogCache()` / `loadSavedCodexCatalog()`: the provider's saved catalog
    /// file, no auth or network. Anthropic's within its 24 h age at the schema version that wrote
    /// it, Codex's stale or not; any other provider has no lighter step.
    async fn saved_catalog(&self, provider: &str) -> Option<Vec<Value>> {
        let (file, version, ttl_ms) = match provider {
            "anthropic-oauth" => ("anthropic-oauth-models.json", 2, Some(DAY_MS)),
            "openai-oauth" => ("openai-oauth-models.json", 7, None),
            _ => return None,
        };
        let path = self.deps.data_dir.as_path().join(file);
        let now = self.deps.clock.now_ms() as f64;
        let bytes = on_lane(self.deps.io.interactive, &CancellationToken::new(), move |lane| read_saved(lane, &path)).await.ok()??;
        saved_models(&bytes, version, ttl_ms, now)
    }
}

/// The saved catalog file, `None` when it cannot be read.
#[allow(clippy::disallowed_methods, reason = "runs on the interactive-io lane job (lane proof argument)")]
fn read_saved(_lane: &InLane<InteractiveIo>, path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

/// `makeModelCache(...).loadSync({ allowStale })`: the saved record's `models`, when it is of
/// the cache's `version`, has a `fetchedAt` and (unless stale is allowed) is within `ttl_ms`.
fn saved_models(bytes: &[u8], version: u64, ttl_ms: Option<f64>, now_ms: f64) -> Option<Vec<Value>> {
    let record: Value = serde_json::from_slice(bytes).ok()?;
    if record.get("version").and_then(Value::as_u64) != Some(version) {
        return None;
    }
    let fetched = record.get("fetchedAt").map(mixdog_js::to_number).filter(|at| *at != 0.0 && !at.is_nan())?;
    let models = record.get("models")?.as_array()?;
    if ttl_ms.is_some_and(|ttl| now_ms - fetched > ttl) {
        return None;
    }
    Some(models.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The config file's agent section for a config built the way Node's recording builds it: its roster in memory form.
    fn config(value: Value) -> Map<String, Value> {
        mixdog_core_config::config::agent_routes::stored_file_of(&value)["agent"].as_object().cloned().unwrap()
    }

    /// `resolveMaintenanceRoute({ agent: 'cycle1-agent', includeDefault: false })` followed by
    /// the plan's provider-enabled check, run in Node on these configs.
    #[test]
    fn the_maintainer_route_is_the_stored_route_of_an_enabled_maintainer() {
        let route = |c: Value| maintainer_of(&config(c));
        assert_eq!(route(json!({})), None);
        assert_eq!(
            route(json!({ "agents": { "maintainer": { "provider": " anthropic ", "model": " haiku ", "effort": " high ", "fast": true } } })),
            Some(MaintainerRoute { provider: "anthropic".into(), model: "haiku".into(), fast: true, effort: "high".into() })
        );
        assert_eq!(
            route(json!({ "providers": { "a": { "enabled": true } }, "agents": { "maintainer": { "provider": "a", "model": "m", "fast": "true" } } })),
            Some(MaintainerRoute { provider: "a".into(), model: "m".into(), fast: false, effort: "low".into() })
        );
        let stored = json!({ "provider": "a", "model": "m" });
        assert_eq!(route(json!({ "disabledAgents": ["maintainer"], "agents": { "maintainer": stored } })), None);
        assert_eq!(route(json!({ "disabledAgents": [" Maintainer "], "agents": { "maintainer": stored } })), None);
        assert_eq!(route(json!({ "providers": { "a": { "enabled": false } }, "agents": { "maintainer": stored } })), None);
        assert_eq!(route(json!({ "agents": { "maintainer": { "provider": "a", "model": "  " } } })), None);
        assert_eq!(route(json!({ "agents": { "maintainer": "preset-name" } })), None);
        assert_eq!(route(json!({ "agents": { "maintainer": ["x"] } })), None);
    }

    #[test]
    fn a_summary_is_attributed_to_its_session_and_a_sessionless_step_to_none() {
        let thread = ThreadId::from("sess_a");
        assert_eq!(attributed_session(&thread, true).as_deref(), Some("sess_a:compact"));
        assert_eq!(attributed_session(&thread, false), None);
    }

    /// `makeModelCache(...).loadSync({ allowStale })`, run in Node on these records: the version
    /// gate and a recorded `fetchedAt` always apply; the age only unless stale is allowed.
    #[test]
    fn a_saved_catalog_needs_its_version_a_fetch_time_and_models_and_is_stale_after_its_age() {
        const H: f64 = 3_600_000.0;
        let now = 1_000_000_000_000.0;
        let models = vec![json!({ "id": "a" })];
        let read = |record: Value, ttl: Option<f64>| saved_models(record.to_string().as_bytes(), 2, ttl, now);
        let fresh = json!({ "version": 2, "fetchedAt": now - H, "models": [{ "id": "a" }] });
        assert_eq!(read(fresh.clone(), Some(24.0 * H)), Some(models.clone()));
        let old = json!({ "version": 2, "fetchedAt": now - 25.0 * H, "models": [{ "id": "a" }] });
        assert_eq!(read(old.clone(), Some(24.0 * H)), None);
        assert_eq!(read(old, None), Some(models));
        for broken in [
            json!({ "version": 1, "fetchedAt": now - H, "models": [{ "id": "a" }] }),
            json!({ "version": 2, "models": [{ "id": "a" }] }),
            json!({ "version": 2, "fetchedAt": 0, "models": [{ "id": "a" }] }),
            json!({ "version": 2, "fetchedAt": now, "models": {} }),
            json!({ "fetchedAt": now, "models": [] }),
        ] {
            assert_eq!(read(broken.clone(), None), None, "{broken}");
        }
        assert_eq!(saved_models(b"not json", 2, None, now), None);
    }
}

/// No approval surface: a summary offers no tool, so nothing asks.
pub(crate) struct NoApprovals(pub(crate) Arc<dyn Clock>);

#[async_trait]
impl ApprovalGate for NoApprovals {
    async fn request(&self, _ask: ApprovalAsk) -> ApprovalResolution {
        ApprovalResolution::Unavailable { at: self.0.now_ms() }
    }
}

/// Sends a summary request on `provider` through the one-shot path, the provider taken from the
/// registry at send time.
struct RegistrySender {
    deps: Arc<SummaryDeps>,
    thread: ThreadId,
    attributed: bool,
    provider: String,
}

#[async_trait]
impl SummarySender for RegistrySender {
    async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        let deps = &self.deps;
        let Some(provider) = deps.registry.get(&self.provider).await else {
            return Err(SummaryFailure::Failed(format!("compact summary route unavailable: {}/{}", self.provider, call.model)));
        };
        let tool_env = ToolEnv {
            thread_id: self.thread.clone(),
            turn_id: TurnId::from("compact"),
            cwd: deps.data_dir.clone(),
            surface: SurfaceKind::Lead,
            io: deps.io,
            approvals: Arc::new(NoApprovals(deps.clock.clone())),
            files: deps.files.clone(),
            processes: deps.processes.clone(),
            progress: deps.progress.clone(),
            deadline_of: None,
            notify: None,
            review: None,
        };
        // Usage attribution: the summary is the session's, on a request of its own, unless the
        // step belongs to no session.
        // `runner.mjs` `sendOpts.usageSessionId = opts.sessionId`: the spend is the session's own.
        let options = RequestOptions {
            session_id: attributed_session(&self.thread, self.attributed),
            usage_session_id: self.attributed.then(|| self.thread.as_str().to_owned()),
            ..RequestOptions::default()
        };
        let one_shot = OneShot::standalone(
            deps.clock.clone(),
            Arc::new(RandomJitter),
            Arc::new(TimerWait),
            Arc::new(StandardRetryDecider),
            tool_env,
            provider,
            CancellationToken::new(),
        )
        .with_options(options);
        one_shot.send(system, prompt, call).await
    }
}
