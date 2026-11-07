//! The workflow, orchestration-mode, web-search-route, model-preference and onboarding methods
//! of the `config/` namespace: `getWorkflowPack`, `saveWorkflowPack`, `createWorkflow`,
//! `deleteWorkflow`, `getOrchestrationMode`, `getConfiguredOrchestrationMode`,
//! `setWebSearchRoute`, `setModelPreferences`, `skipOnboarding` and `completeOnboarding`.
//!
//! Each follows the 1.4.5 daemon's code path (`workflow-agents-api/*`, `model-route/
//! web-search-route.mjs`, `provider-auth/login.mjs`): same results, same sentences. The agent
//! config is read from and written through [`Config`]; what other owners hold (the live Main
//! route, the provider registry and model catalog, the custom-agent list, the thread's session
//! facts) comes in through [`WorkflowHost`].
//!
//! The core routes by exact method, so the service is registered with its [`METHODS`].

pub mod ids;
pub(crate) mod onboarding;
pub mod pack;
mod prefs;
pub(crate) mod presets;
mod search;
pub mod sections;
pub mod thread_settings;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod thread_settings_tests;

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub use self::pack::WorkflowPaths;
use self::ids::Doc;
use self::ids::DEFAULT_WORKFLOW_ID;
use self::ids::active_workflow_id;
use self::ids::configured_orchestration_mode;
use self::ids::thread_orchestration_mode;
use self::ids::workflow_id;
use crate::config::Config;
use crate::config::ConfigError;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::wrong_method;
use crate::tool_modules::with_grandfathered_builtins;

const DOMAIN: &str = "config";

/// The methods this service answers.
pub const METHODS: [&str; 10] = [
    "config/getWorkflowPack",
    "config/saveWorkflowPack",
    "config/createWorkflow",
    "config/deleteWorkflow",
    "config/getOrchestrationMode",
    "config/getConfiguredOrchestrationMode",
    "config/setWebSearchRoute",
    "config/setModelPreferences",
    "config/skipOnboarding",
    "config/completeOnboarding",
];

/// What the methods need from the other owners of the runtime. A failure is the sentence Node
/// threw.
#[async_trait]
pub trait WorkflowHost: Send + Sync {
    /// The session facts of a thread (`orchestrationMode`, `pendingOrchestrationMode`,
    /// `workflow`), or the thread's own refusal.
    async fn thread_mode_facts(&self, thread_id: &str) -> Result<Value, CoreError>;

    /// The live Main route (`getRoute()`), the fallback of a sent default route.
    fn main_route(&self) -> Value;

    /// After the Lead route was saved: the live Main route becomes `selection`
    /// (`{ provider, model, effort? }`, resolved against the saved config) and the tool surface
    /// of an empty session is rebuilt.
    async fn adopt_lead_route(&self, selection: Value);

    /// `listCustomAgentIds()`: the ids of the custom agents on disk.
    async fn custom_agent_ids(&self) -> Vec<String>;

    /// Whether a developer-gated OAuth provider is switched on (`isKnownProvider`).
    fn provider_available(&self, provider: &str) -> bool;

    /// `requireLocalProviderManagement()`: refuses where provider management is off.
    fn require_local_provider_management(&self) -> Result<(), String>;

    /// `normalizeCustomProviderConfig(entry)` of a stored custom provider.
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String>;

    /// `refresh.afterCredentialChange()`: the registry and catalogs follow the new config.
    async fn after_credential_change(&self);

    /// `ensureProvidersReady(providers)`: the providers map with the provider turned on.
    async fn ensure_providers_ready(&self, providers: Doc) -> Result<(), String>;

    /// `lookupModelMeta(provider, model, { allowFetch: true })`.
    async fn lookup_model_meta(&self, provider: &str, model: &str) -> Option<Value>;

    /// `webSearchCapableFor(provider, meta)`.
    fn web_search_capable(&self, provider: &str, meta: Option<&Value>) -> bool;

    /// `fastCapableFor(provider, meta, effort, modelParameters)` of a resolved row.
    fn fast_capable(&self, provider: &str, meta: Option<&Value>, effort: Option<&str>, model_parameters: Option<&Value>) -> bool;

    /// A web-search route was stored: the live route state follows and the provider caches drop.
    fn web_search_route_saved(&self, route: &Value);
}

pub struct WorkflowConfig {
    config: Config,
    paths: WorkflowPaths,
    host: Arc<dyn WorkflowHost>,
    ops: OpScopes,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    /// Woken after a workflow pack was saved, created or deleted: the `workflows` section follows.
    pack_changes: tokio::sync::Notify,
}

fn utc_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A failed config write as the caller sees it.
fn config_failure(error: ConfigError) -> CoreError {
    match error {
        ConfigError::InvalidParams { path, expected } => CoreError::InvalidParams { path: path.into(), expected: expected.into() },
        ConfigError::Overloaded(full) => CoreError::from(full),
        other => CoreError::DomainError {
            domain: DOMAIN.into(),
            code: Some("configFailed".into()),
            message: Some(other.to_string().into()),
            detail: None,
        },
    }
}

fn thrown(message: String) -> CoreError {
    failed(DOMAIN, message)
}

fn text_param<'a>(req: &'a CoreRequest, key: &str) -> Result<&'a str, CoreError> {
    req.params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(&format!("params.{key}"), "string"))
}

fn payload_of(req: &CoreRequest) -> Value {
    req.params.get("payload").cloned().unwrap_or_else(|| Value::Object(Map::new()))
}

impl WorkflowConfig {
    pub fn new(
        config: Config,
        paths: WorkflowPaths,
        host: Arc<dyn WorkflowHost>,
        ops: OpScopes,
        tokens: &LaneTokens,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            paths,
            host,
            ops,
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            now: Arc::new(utc_now),
            pack_changes: tokio::sync::Notify::new(),
        })
    }

    /// The clock of completion stamps and backup folder names (`new Date().toISOString()`).
    pub fn with_clock(self: Arc<Self>, now: Arc<dyn Fn() -> String + Send + Sync>) -> Arc<Self> {
        let this = Arc::try_unwrap(self).unwrap_or_else(|_| panic!("the clock is set before the service is shared"));
        Arc::new(Self { now, ..this })
    }

    pub async fn call(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "config/getWorkflowPack" => self.get_pack(req).await,
            "config/saveWorkflowPack" => self.packs_changed(self.save_pack(req).await),
            "config/createWorkflow" => self.packs_changed(self.create_pack(req).await),
            "config/deleteWorkflow" => self.packs_changed(self.delete_pack(req).await),
            "config/getOrchestrationMode" => self.orchestration_mode(req).await,
            "config/getConfiguredOrchestrationMode" => {
                Ok(Reply::Value(Value::String(configured_orchestration_mode(&self.config.agent()))))
            }
            "config/setWebSearchRoute" => self.set_web_search_route(req).await,
            "config/setModelPreferences" => self.set_model_preferences(req).await,
            "config/skipOnboarding" => self.skip_onboarding(req).await,
            "config/completeOnboarding" => self.complete_onboarding(req).await,
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn packs_changed(&self, result: Result<Reply, CoreError>) -> Result<Reply, CoreError> {
        if result.is_ok() {
            self.pack_changes.notify_one();
        }
        result
    }

    /// Writes `after` against `before` (what the caller started from).
    /// `saveConfigAndAdopt`: the runtime holds the grandfathered config, so both sides of the
    /// diff carry `builtins` and the first write seeds it.
    async fn save(&self, before: &Doc, after: &Doc) -> Result<(), CoreError> {
        // `after` descends from the adopted config, so it keeps the section `before` was stamped
        // with: a Lead route it adds must not turn a fresh profile into a grandfathered one.
        let before = with_grandfathered_builtins(before);
        let mut after = after.clone();
        if !after.contains_key("builtins") {
            after.insert("builtins".into(), before.get("builtins").cloned().unwrap_or(Value::Null));
        }
        self.save_plain(&before, &after).await
    }

    /// `cfgMod.saveConfig(next, { baseConfig })`: the diff of the documents as given.
    async fn save_plain(&self, before: &Doc, after: &Doc) -> Result<(), CoreError> {
        self.config.save_agent_config(before, after, false).await.map(|_| ()).map_err(config_failure)
    }

    async fn orchestration_mode(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let mode = match req.params.get("threadId").and_then(Value::as_str) {
            Some(thread) => thread_orchestration_mode(&self.host.thread_mode_facts(thread).await?),
            None => configured_orchestration_mode(&self.config.agent()),
        };
        Ok(Reply::Value(Value::String(mode)))
    }

    // --- workflow packs ---

    async fn get_pack(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: mixdog_app_protocol::v2::params::ConfigGetWorkflowPackParams = decode(req)?;
        let paths = self.paths.clone();
        let view = on_lane(self.interactive, &req.ctx.cancel, move |_| pack::get_pack(&paths, &params.workflow_id)).await??;
        Ok(Reply::Value(view))
    }

    async fn save_pack(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let payload = payload_of(req);
        let (paths, now, durability, interactive) = (self.paths.clone(), self.now.clone(), self.durability, self.interactive);
        let (cancel, replay_cancel) = (req.ctx.cancel.clone(), req.ctx.cancel.clone());
        let (replay_paths, replay_payload) = (self.paths.clone(), payload.clone());
        self.ops
            .run(
                req,
                None,
                move || async move { on_lane(durability, &cancel, move |lane| pack::save_pack(lane, &paths,&payload, &*now)).await? },
                move || async move {
                    let id = ids::clean(replay_payload.get("id"));
                    on_lane(interactive, &replay_cancel, move |_| pack::get_pack(&replay_paths, &id)).await?
                },
            )
            .await
    }

    async fn create_pack(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let payload = payload_of(req);
        let (paths, now, durability, interactive) = (self.paths.clone(), self.now.clone(), self.durability, self.interactive);
        let (cancel, replay_cancel) = (req.ctx.cancel.clone(), req.ctx.cancel.clone());
        let (replay_paths, replay_payload) = (self.paths.clone(), payload.clone());
        self.ops
            .run(
                req,
                None,
                move || async move { on_lane(durability, &cancel, move |lane| pack::create_pack(lane, &paths,&payload, &*now)).await? },
                move || async move {
                    on_lane(interactive, &replay_cancel, move |_| match pack::created_id(&replay_paths, &replay_payload) {
                        Some(id) => pack::get_pack(&replay_paths, &id),
                        None => Err(failed(DOMAIN, "workflow id must contain letters/numbers (dashes and dots allowed)")),
                    })
                    .await?
                },
            )
            .await
    }

    async fn delete_pack(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: mixdog_app_protocol::v2::params::ConfigDeleteWorkflowParams = decode(req)?;
        let requested = params.workflow_id;
        let (paths, durability, interactive) = (self.paths.clone(), self.durability, self.interactive);
        let (cancel, replay_cancel) = (req.ctx.cancel.clone(), req.ctx.cancel.clone());
        let (replay_paths, replay_requested) = (self.paths.clone(), requested.clone());
        self.ops
            .run(
                req,
                None,
                move || async move {
                    let (id, reverted) =
                        on_lane(durability, &cancel, move |_| pack::delete_pack(&paths, &requested)).await??;
                    // A fully removed pack must not stay active; Default takes over.
                    let before = self.config.agent();
                    if !reverted && active_workflow_id(&before) == id {
                        let mut after = before.clone();
                        let mut workflow = before.get("workflow").and_then(Value::as_object).cloned().unwrap_or_default();
                        workflow.insert("active".into(), Value::String(DEFAULT_WORKFLOW_ID.into()));
                        after.insert("workflow".into(), Value::Object(workflow));
                        self.save(&before, &after).await?;
                    }
                    Ok(json!({ "id": id, "deleted": true, "revertedToBuiltIn": reverted }))
                },
                move || async move {
                    let id = workflow_id(&replay_requested).unwrap_or_default();
                    let reverted = on_lane(interactive, &replay_cancel, {
                        let id = id.clone();
                        move |_| pack::pack_exists(&replay_paths, &id)
                    })
                    .await?;
                    Ok(json!({ "id": id, "deleted": true, "revertedToBuiltIn": reverted }))
                },
            )
            .await
    }

    // --- web-search route and model preferences ---

    async fn set_web_search_route(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let next = req.params.get("next").cloned().unwrap_or(Value::Null);
        self.ops
            .run(
                req,
                None,
                || async {
                    let before = self.config.agent();
                    let route = search::plan(&before, &next, &*self.host).await.map_err(thrown)?;
                    let before = self.config.agent();
                    let mut after = before.clone();
                    // Node answers its adopted route, which still carries a false `fast` that
                    // the stored form drops.
                    let saved = search::normalized(Some(&route)).map_err(thrown)?;
                    after.insert("webSearchRoute".into(), route);
                    self.save(&before, &after).await?;
                    self.host.web_search_route_saved(&saved);
                    Ok(saved)
                },
                || async { search::normalized(self.config.agent().get("webSearchRoute")).map_err(thrown) },
            )
            .await
    }

    async fn set_model_preferences(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let provider = req.params.get("providerId").cloned().unwrap_or(Value::Null);
        let changes = req.params.get("changes").cloned().unwrap_or(Value::Null);
        self.ops
            .run(
                req,
                None,
                || async {
                    let before = self.config.agent();
                    let prefs = prefs::prepare(&before, &provider, &changes, &*self.host).map_err(thrown)?;
                    self.save_plain(&before, &prefs.after).await?;
                    if prefs.custom_catalog_changed {
                        self.host.after_credential_change().await;
                    } else {
                        self.config.reload_full_config().await.map_err(config_failure)?;
                    }
                    Ok(prefs.result)
                },
                || async { prefs::answer(&provider, &changes).map_err(thrown) },
            )
            .await
    }

    // --- onboarding ---

    /// `listWorkflows()`: the catalog with the configured workflow marked active.
    pub async fn list_workflows(&self) -> Result<Value, CoreError> {
        let paths = self.paths.clone();
        let packs = on_lane(self.interactive, &mixdog_rt::CancellationToken::new(), move |_| pack::list_packs(&paths)).await?;
        let active = ids::active_workflow_id(&self.config.agent());
        let rows = packs.into_iter().map(|listed| {
            let mut row = Map::new();
            row.insert("id".into(), json!(listed.pack.id));
            row.insert("name".into(), json!(listed.pack.name));
            row.insert("description".into(), json!(listed.pack.description));
            row.insert("source".into(), json!(listed.pack.source));
            if listed.overrides_built_in {
                row.insert("overridesBuiltIn".into(), Value::Bool(true));
            }
            row.insert("active".into(), Value::Bool(listed.pack.id == active));
            Value::Object(row)
        });
        Ok(Value::Array(rows.collect()))
    }

    /// `getOnboardingStatus()`.
    pub fn onboarding_status(&self) -> Result<Value, CoreError> {
        onboarding::status(&self.config.agent()).map_err(thrown)
    }

    /// `getWebSearchRoute()`: the stored route, the follow-Main marker when there is none.
    pub fn web_search_route(&self) -> Result<Value, CoreError> {
        search::current(&self.config.agent()).map_err(thrown)
    }

    /// The status of the config a save just adopted: Node reads its in-memory config, which
    /// still holds what the stored form drops (an empty `modelParameters`).
    fn adopted_status(&self, before: &Doc, adopted: &Doc) -> Result<Value, CoreError> {
        onboarding::adopted_status(before, adopted).map_err(thrown)
    }

    async fn skip_onboarding(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        self.ops
            .run(
                req,
                None,
                || async {
                    let before = self.config.agent();
                    let after = onboarding::skipped(&before, &(self.now)());
                    self.save(&before, &after).await?;
                    self.adopted_status(&before, &after)
                },
                || async { self.onboarding_status() },
            )
            .await
    }

    async fn complete_onboarding(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let payload = payload_of(req);
        self.ops
            .run(
                req,
                None,
                || async {
                    let before = self.config.agent();
                    let custom = if onboarding::object_payload(&payload, "agentRoutes").is_some() {
                        self.host.custom_agent_ids().await
                    } else {
                        Vec::new()
                    };
                    let completion =
                        onboarding::completed(&before, &payload, &self.host.main_route(), &custom, &(self.now)()).map_err(thrown)?;
                    self.save(&before, &completion.after).await?;
                    // Whatever wrote the Lead route also moves the live Main route, so a pending
                    // conditional fill finds a route that is not empty.
                    if let Some(lead) = completion.lead {
                        self.host.adopt_lead_route(onboarding::lead_selection(&lead)).await;
                    }
                    self.adopted_status(&before, &completion.after)
                },
                || async { self.onboarding_status() },
            )
            .await
    }
}

#[async_trait]
impl DomainService for WorkflowConfig {
    fn methods(&self) -> &'static [&'static str] {
        &METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        WorkflowConfig::call(self, &req).await
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
