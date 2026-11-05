//! `config/getCompactionSettings`, `config/setCompactionSettings`, `config/getAutoClear` and
//! `config/setAutoClear` (Node `settings-compaction-api.mjs`) as a domain service. The agent
//! config lives behind `AgentConfigStore` (`Config::agent` / `Config::update_agent`); the live
//! route and the session adoption behind `CompactionHost`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::DomainErrorDetail;
use mixdog_core_api::service::Admit;
use serde_json::Value;

use super::settings::Doc;
use super::settings::SettingsError;
use super::settings::get_auto_clear;
use super::settings::get_compaction_settings;
use super::settings::set_auto_clear;
use super::settings::set_compaction_settings;

/// An edit of the agent section, run inside the store's write transaction.
pub type AgentChange = Box<dyn FnOnce(&mut Doc) -> Result<(), CoreError> + Send>;

/// The `agent` section of the config file.
#[async_trait]
pub trait AgentConfigStore: Send + Sync {
    /// `Config::agent()`.
    fn agent(&self) -> Doc;
    /// `Config::update_agent`: runs `change` on the section as that transaction starts, so no
    /// other writer's edit can fall between its read and its write. An `Err` from `change`
    /// writes nothing and comes back unchanged; a failure of the store itself comes back as the
    /// store's own `CoreError`.
    async fn update(&self, change: AgentChange) -> Result<(), CoreError>;
}

/// What the settings change reaches outside the config.
pub trait CompactionHost: Send + Sync {
    /// `getRoute()?.provider`. With a thread, that thread's live route; without one, the route
    /// Node boots with before any session exists: `resolveRoute(config, {…})`
    /// (`session-runtime/boot/config.mjs:23-27` via `resolveInitialConfigState`,
    /// `config-lifecycle.mjs`), i.e. the configured default route.
    fn route_provider(&self, thread: Option<&ThreadId>) -> Option<String>;
    /// `adoptSessionCompaction(getSession(), saved)`; use `settings::adopt_session_compaction`
    /// on the thread's session `compaction` record. Without a thread there is no session and
    /// Node's call returns at once (`session-compaction-sync.mjs:16`).
    fn adopt_session_compaction(&self, thread: Option<&ThreadId>, saved: &Doc);
    /// `invalidateContextStatusCache()` (`settings-compaction-api.mjs:119`).
    fn invalidate_context_status(&self, thread: Option<&ThreadId>);
    /// `refreshLeadCacheOpts()` (`settings-compaction-api.mjs:72-76`): the thread's session
    /// (`refreshSessionProviderCacheOpts`, a no-op without one) and then every live Lead
    /// session (`refreshLiveSessionsProviderCacheOpts`, `session-lifecycle.mjs`), which Node
    /// does whatever the caller's thread.
    fn refresh_lead_cache_opts(&self, thread: Option<&ThreadId>, agent: &Doc);
}

pub struct CompactionSettingsService {
    store: Arc<dyn AgentConfigStore>,
    host: Arc<dyn CompactionHost>,
}

/// Node's plain `Error`: no code, and its message text as the failure message.
fn failed(error: SettingsError) -> CoreError {
    CoreError::DomainError {
        domain: "config".into(),
        code: None,
        detail: Some(Box::new(DomainErrorDetail::ExternalFailure { message: error.0 })),
    }
}

/// The edit that replaces one key of the agent section by what `build` makes of the section
/// the transaction sees: a validation error from `build` is Node's thrown `Error`, before any save.
fn replace_key(
    key: &'static str,
    build: impl FnOnce(&Doc) -> Result<Doc, SettingsError> + Send + 'static,
) -> AgentChange {
    Box::new(move |agent| {
        let next = build(agent).map_err(failed)?;
        agent.insert(key.into(), Value::Object(next));
        Ok(())
    })
}

/// The wire params are `{opId?, threadId?, input?}`; `input = {}` when absent.
fn input_of(params: &Value) -> Result<Doc, CoreError> {
    match params.get("input") {
        None | Some(Value::Null) => Ok(Doc::new()),
        Some(Value::Object(input)) => Ok(input.clone()),
        Some(_) => Err(CoreError::InvalidParams { path: "params.input".into(), expected: "object".into() }),
    }
}

fn thread_of(params: &Value) -> Option<ThreadId> {
    params.get("threadId").and_then(Value::as_str).map(ThreadId::from)
}

impl CompactionSettingsService {
    pub fn new(store: Arc<dyn AgentConfigStore>, host: Arc<dyn CompactionHost>) -> Self {
        Self { store, host }
    }

    fn auto_clear(&self, thread: Option<&ThreadId>) -> Value {
        Value::Object(get_auto_clear(&self.store.agent(), self.host.route_provider(thread).as_deref()))
    }

    async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
        let thread = thread_of(params);
        let thread = thread.as_ref();
        match method {
            "config/getCompactionSettings" => Ok(Value::Object(get_compaction_settings(&self.store.agent()))),
            "config/setCompactionSettings" => {
                let input = input_of(params)?;
                self.store.update(replace_key("compaction", move |agent| set_compaction_settings(agent, &input))).await?;
                let saved = get_compaction_settings(&self.store.agent());
                self.host.adopt_session_compaction(thread, &saved);
                self.host.invalidate_context_status(thread);
                Ok(Value::Object(saved))
            }
            "config/getAutoClear" => Ok(self.auto_clear(thread)),
            "config/setAutoClear" => {
                let route = self.host.route_provider(thread);
                let input = input_of(params)?;
                self.store
                    .update(replace_key("autoClear", move |agent| set_auto_clear(agent, route.as_deref(), &input)))
                    .await?;
                self.host.refresh_lead_cache_opts(thread, &self.store.agent());
                Ok(self.auto_clear(thread))
            }
            other => Err(CoreError::CapabilityUnavailable {
                capability: other.into(),
                detail: "not a compaction settings method".into(),
            }),
        }
    }
}

#[async_trait]
impl DomainService for CompactionSettingsService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "config/getCompactionSettings",
            "config/setCompactionSettings",
            "config/getAutoClear",
            "config/setAutoClear",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
