//! The production [`SurfaceHost`] behind `tools/*` and the MCP surface's `tool_names`: which tools
//! the Lead lists, its mode, and the empty-surface reconcile (Node `session-runtime/tool-surface.mjs`
//! `buildPreSessionSurface` / `activeToolSurface`, `tool-policy-refresh.mjs` `reconcileEmptySession`
//! with `tool-policy/policy-stage.mjs` `applyToolDenials`).
//!
//! * `mode` is `rt.mode`: the daemon's tool mode, fixed when the host is built (Node sets it from
//!   `params.toolMode` and `setToolMode`; a thread's own mode is its header's `toolSpec`, which
//!   `thread/setToolMode` writes and which this process-wide value does not follow).
//! * `preview` is the surface before any session exists: the tools the mode's spec resolves to
//!   (`session_tools::resolve`, no skills, no agent owner), less the Lead's denials, then the
//!   deferred surface over the standalone tools (`ToolSurface::apply`), as a header.
//! * `reconcile_empty` brings an empty, idle Lead thread's tool surface to the current gates:
//!   the denials the workflow and the settings give (`WorkflowSurface`), then the deferred
//!   surface rebuilt (`applyToolDenials`). The prompt half of Node's reconcile (BP1/BP2/BP3) is
//!   not part of what the status reads and is not done here.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::failed;
use mixdog_core_domains::domains::ai_admin::route_set_service::PRE_SESSION;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::tools_status::SurfaceHost;
use mixdog_core_ports::ports::tools_status::surface_of_header;
use mixdog_core_session::session::EmptyToolSurface;
use mixdog_core_session::session::NewThreadTools;
use mixdog_core_session::session::agent_registry::LiveSessions;
use mixdog_core_session::session::session_options::LEAD_DISALLOWED_TOOLS;
use mixdog_core_session::session::session_options::write_lead_record;
use mixdog_core_session::session::thread_switches::WorkflowTarget;
use sha2::Digest as _;
use sha2::Sha256;
use mixdog_core_session::session::thread_settings::has_conversation_messages;
use mixdog_core_session::session::thread_settings::normalize_tool_mode;
use mixdog_core_session::session::thread_settings::tool_spec_for_mode;
use mixdog_core_session::session::thread_switches::WorkflowSurface;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_core_session::session::thread_switches::workflow_meta;
use mixdog_js::js_trim;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_tools::policy::surface::AGENT_DENIED_TOOLS;
use mixdog_mcp::McpHub;
use mixdog_mcp::hub::normalize_scope;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_mcp::server::ServerState;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::status::StatusSurface;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::agent_variants::VariantError;
use super::agent_variants::agent_definitions;
use super::agent_variants::check_pool;
use super::agent_variants::bind_agent_docs;
use super::deferred_manifest::apply_initial_manifest;
use super::prompt_rebuild::PromptRebuild;
use super::prompt_rebuild::RebuildRequest;
use super::prompt_session::SessionPrompt;
use mixdog_core_prompt::prompt::notice::OwnedSections;
use mixdog_core_prompt::prompt::notice::stage_prompt_settings_notice;
use super::prompt_session::refresh_environment;
use super::tool_availability::Moved;
use super::tool_availability::stage_connector_availability;
use super::turn_settings::TurnSettings;
use super::tool_availability::missing_definitions;
use super::tool_availability::stage_tool_availability;
use super::tool_pool::model_surface::workflow_disallows_agent_tool;
use super::workflow_surface::RunWorkflowSurface;
use super::reactions::REACTION_TOOL_NAME;
use super::route_surface::header_diff;
use super::route_surface::is_agent_owner;
use super::route_surface::load_tool_def;
use super::tool_exposure::tool_exposure_migration_needed;
use super::tool_migration::has_unanswered_tool_calls;
use super::tool_migration::invalidate_for_tool_surface_migration;
use super::session_tools::BRIDGE;
use super::session_tools::Resolve;
use super::session_tools::SessionMcp;
use super::session_tools::SkillsListed;
use super::session_tools::header_scope;
use super::session_tools::internal_tools;
use super::session_tools::resolve;
use super::session_tools::route_rank;
use super::session_tools::session_doc;
use super::tool_pool::model_surface::SurfaceInputs;
use super::tool_pool::model_surface::model_standalone_tools;
use super::tool_pool::model_surface::workflow_allows_agents;
use super::tool_surface::ApplyOptions;
use super::tool_surface::ToolSurface;
use super::tool_surface::clean;
use super::tool_surface::parse_tool_selection;
use super::tool_surface::truthy;
use super::tool_surface::filter_disallowed_tools;
use super::tool_surface::tool_name;
use super::tool_surface::SurfaceHost as ToolSurfaceHost;

/// A tool as the session layer holds it (Node's tool object): its definition, with `name`, `title`,
/// `trigger`, `public` (only `false`), `description`, `inputSchema` and `annotations`, each only where
/// the definition has it.
pub fn tool_doc(tool: &Arc<dyn Tool>) -> Value {
    tool.spec().definition()
}

/// The bridge exposure's own definitions (`TOOL_BRIDGE_TOOLS`): `load_tool` and `call_tool`.
pub fn bridge_docs(pool: &[Arc<dyn Tool>]) -> Vec<Value> {
    BRIDGE.iter().filter_map(|name| pool.iter().find(|tool| tool.spec().name == *name)).map(tool_doc).collect()
}

/// [`ToolSurfaceHost`] over the tool pool and the MCP hub: the bridge definitions and the ready
/// servers' initialize instructions (`getMcpServerInstructionsMap(scopeId)`).
pub struct HubSurfaceHost {
    bridge: Vec<Value>,
    hub: Arc<McpHub>,
}

impl HubSurfaceHost {
    pub fn new(pool: &[Arc<dyn Tool>], hub: Arc<McpHub>) -> Self {
        Self { bridge: bridge_docs(pool), hub }
    }
}

impl ToolSurfaceHost for HubSurfaceHost {
    fn bridge_tools(&self) -> Vec<Value> {
        self.bridge.clone()
    }

    fn mcp_server_instructions(&self, scope: Option<&str>) -> Value {
        let mut out = Map::new();
        for server in self.hub.servers_in(&normalize_scope(scope)) {
            let state = server.state();
            let ServerState::Ready(ready) = &*state else { continue };
            let text = ready.instructions.as_deref().map_or("", js_trim);
            if !text.is_empty() {
                out.insert(server.name().to_owned(), Value::String(text.to_owned()));
            }
        }
        Value::Object(out)
    }
}

/// `getFeatureDisallowedTools()`: the tools the settings gates and the machine switch off right now.
/// Read fresh on every use (the gates move with the config and the desktop bridges), never cached;
/// a read that cannot run is the error.
#[async_trait]
pub trait FeatureDenied: Send + Sync + 'static {
    async fn denied(&self) -> Result<Vec<String>, String>;
}

#[async_trait]
impl FeatureDenied for RunWorkflowSurface {
    async fn denied(&self) -> Result<Vec<String>, String> {
        self.feature_denied().await.map_err(String::from)
    }
}

/// What the Lead's surface is built from.
pub struct SurfaceSources {
    /// `rt.mode` (`normalizeToolMode(params.toolMode)`); anything but `readonly`/`lead` is `full`.
    pub mode: String,
    /// Every registered tool (the `tool_pool` of `TurnPathParts`, the one the session builder holds).
    pub pool: Vec<Arc<dyn Tool>>,
    /// `agentToolNames`: the delegation tools a workflow that delegates to no one hides.
    pub agent_tools: HashSet<&'static str>,
    /// The connected servers' tools for a scope and a folder.
    pub mcp: Arc<dyn SessionMcp>,
    /// Opens and releases a thread's MCP scope.
    pub scopes: Arc<dyn McpScopes>,
    /// `rt.currentCwd` before any session exists: the daemon's startup folder.
    pub cwd: PathBuf,
    /// The runtime's live route; the pre-session route is its [`PRE_SESSION`] cell.
    pub routes: Arc<dyn LiveRoute>,
    /// `getFeatureDisallowedTools()`: the tools a settings gate or an absent bridge switches off.
    pub feature_denied: Arc<dyn FeatureDenied>,
    /// The agent connector policy and the project switches (`agentMcpToolPermission`, `projectMcpToolDisabled`).
    pub connectors: Arc<dyn ConnectorPermissions>,
    /// `configuredOrchestrationMode(config)`.
    pub orchestration_mode: Arc<dyn Fn() -> String + Send + Sync>,
    /// getHiddenAgent(agent): only a hidden agent's session honors a caller's schema allowlist.
    pub hidden_agent: Arc<dyn Fn(Option<&str>) -> bool + Send + Sync>,
    /// The prompt of an empty thread composed again.
    pub prompt: Arc<dyn PromptRebuild>,
    /// Whether skills are listed for a folder: a new thread carries `Skill` only then.
    pub skills: Arc<dyn SkillsListed>,
    pub tool_host: Arc<dyn ToolSurfaceHost>,
    pub clock: Arc<dyn Clock>,
    pub threads: Arc<dyn ThreadState>,
    pub messages: Arc<dyn ThreadMessages>,
    pub live: Arc<dyn LiveSessions>,
    pub workflow: Arc<dyn WorkflowSurface>,
    /// How many documents the config has installed so far (`Config::revision`): Node's `availabilityKey`
    /// counts the config objects, replaced on every adopt and every reload.
    pub config_revision: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// `surfaceGeneration`: moved by every `invalidatePreSessionToolSurface()` (a skill, plugin or MCP change, a built-in toggled).
    pub surface_generation: SurfaceGeneration,
}

pub use mixdog_core_base::surface::SurfaceGeneration;

/// What an empty thread's surface was last brought to (`appliedKeys` of `tool-policy-refresh.mjs`): the
/// gates it was built from and the revision of the prompt settings it presents.
#[derive(Clone, PartialEq, Eq, Default)]
struct Applied {
    gates: String,
    settings: String,
}

/// The production [`SurfaceHost`].
pub struct LeadSurfaceHost {
    mode: &'static str,
    sources: SurfaceSources,
    /// The agent definition of the pool's `git` and `task` (`Tool::agent_spec`), for agent-owned threads.
    agent_defs: HashMap<String, Value>,
    /// Thread id to the key its surface was last brought to. In this process only, as Node's is: a thread
    /// first seen here (resumed) is checked once.
    applied: std::sync::Mutex<HashMap<String, Applied>>,
    /// Thread id to the inputs its last MCP reconcile left (`RECONCILE_STATE`); in this process only, as Node's is.
    mcp_state: std::sync::Mutex<HashMap<String, Value>>,
}

/// `deferredSurfaceModeForLead`.
fn deferred_mode(mode: &str) -> &'static str {
    if mode == "readonly" { "readonly" } else { "lead" }
}

/// A thread's tool mode: the `toolMode` its start or `thread/setToolMode` wrote; a thread from
/// before that key is `readonly` or `full` by its spec.
fn thread_mode(header: &Header) -> &'static str {
    match header.get("toolMode").and_then(Value::as_str) {
        Some(mode) => normalize_tool_mode(mode),
        None if header.get("toolSpec") == Some(&tool_spec_for_mode("readonly")) => "readonly",
        None => "full",
    }
}

fn port(thread: &ThreadId, error: PortError) -> CoreError {
    match error {
        PortError::NotFound { .. } => CoreError::ThreadNotFound { thread_id: thread.clone() },
        other => failed("tools", format!("{other:?}")),
    }
}

/// `finalizeSessionToolList` for a non-agent session: the caller's allowlist, then its denylist,
/// by lower-cased name.
fn finalize_docs(docs: Vec<Value>, allowed: Option<&[String]>, denied: &[String], agent: Option<&HashMap<String, Value>>) -> Vec<Value> {
    let mut kept: Vec<Value> = docs
        .into_iter()
        .filter(|doc| {
            let name = tool_name(doc).to_lowercase();
            allowed.is_none_or(|allowed| allowed.iter().any(|a| a.to_lowercase() == name)) && !denied.iter().any(|d| d.to_lowercase() == name)
        })
        .collect();
    if let Some(agent) = agent {
        kept.retain(|doc| !AGENT_DENIED_TOOLS.contains(&tool_name(doc).to_lowercase().as_str()));
        // `bindAgentOwner` before the order: the agent text of `git` and `task`.
        kept = bind_agent_docs(kept, agent);
        kept.sort_by_key(|doc| route_rank(&tool_name(doc)));
    }
    kept
}

fn doc_names(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().map(tool_name).collect()).unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().map(|v| clean(Some(v))).collect()).unwrap_or_default()
}

impl LeadSurfaceHost {
    /// The pool must give a delegated agent its `git` and `task` definitions (`check_pool`): a pool
    /// without them is refused here with a typed error.
    pub fn new(sources: SurfaceSources) -> Result<Self, VariantError> {
        check_pool(&sources.pool)?;
        let agent_defs = agent_definitions(&sources.pool);
        Ok(Self { mode: normalize_tool_mode(&sources.mode), sources, agent_defs, applied: std::sync::Mutex::default(), mcp_state: std::sync::Mutex::default() })
    }

    /// `availabilityKey()`: the config installed, the surface generation and the gate list.
    fn gates(&self, feature_denied: &[String]) -> String {
        format!("{}|{}|{}", (self.sources.config_revision)(), self.sources.surface_generation.get(), feature_denied.join(","))
    }

    /// `appliedKeys.get(session)`.
    fn applied_to(&self, thread: &ThreadId) -> Option<Applied> {
        self.applied.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(thread.as_str()).cloned()
    }

    /// `appliedKeys.set(session, key)`.
    fn note_applied(&self, thread: &ThreadId, key: Applied) {
        self.applied.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread.as_str().to_owned(), key);
    }

    /// `note_applied` of the key a reconcile brought the surface to, if it brought it to one.
    fn note_applied_key(&self, thread: &ThreadId, key: Option<Applied>) {
        if let Some(key) = key {
            self.note_applied(thread, key);
        }
    }

    /// `buildPreSessionSurface()`: the surface a Lead with no session would start with.
    pub(crate) async fn preview_surface(&self) -> Result<Header, String> {
        let s = &self.sources;
        let route = s.routes.route(&ThreadId::from(PRE_SESSION));
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        let spec = tool_spec_for_mode(self.mode);
        // The serving runtime's own scope (`getMcpScopeId()`, `tool-surface.mjs:100,109,142`): the runtime
        // scope the daemon connected at boot. No session takes it; each is created with a scope of its own.
        let runtime_scope = s.scopes.open_runtime(&s.cwd).await.map_err(|error| format!("mcp scope of the runtime: {error}"))?;
        // `previewSessionTools(toolSpecForMode(mode), [], ..)`: no skills, not an agent's session.
        let resolved = resolve(
            &s.pool,
            s.mcp.tools(Some(&runtime_scope), &s.cwd),
            &Resolve { tool_spec: Some(&spec), model: &model, skills_listed: false, agent_owned: false, schema_allowed: None, disallowed: &[] },
        );
        let feature_denied = s.feature_denied.denied().await?;
        // With no session the Lead is a coding Lead (`agentMode` false), so the delegatable agents
        // are never counted.
        let inputs = SurfaceInputs { session: None, profile_allowed: None, feature_denied: &feature_denied, delegatable_agents: &|| 0 };
        // `disallowedTools()` of the interactive profile; `reactionDisabled(null)` is always true.
        let mut denied: Vec<String> = LEAD_DISALLOWED_TOOLS.iter().map(|name| (*name).to_owned()).collect();
        denied.extend(feature_denied.iter().cloned());
        if !workflow_allows_agents(&inputs) {
            denied.extend(s.agent_tools.iter().map(|name| (*name).to_owned()));
        }
        denied.push(REACTION_TOOL_NAME.to_owned());
        let docs: Vec<Value> = resolved.iter().map(|tool| session_doc(&s.pool, tool)).collect();
        let standalone = internal_tools(&s.pool);
        let extra: Vec<Value> = model_standalone_tools(&standalone, &s.agent_tools, &inputs).iter().map(tool_doc).collect();
        let mut surface = json!({
            "tools": filter_disallowed_tools(&docs, &denied),
            "mcpScopeId": runtime_scope,
            "cwd": s.cwd.to_string_lossy(),
            "orchestrationMode": (s.orchestration_mode)(),
        });
        let options = ApplyOptions { provider: Some(provider), model: Some(model), disallowed: denied };
        ToolSurface { host: s.tool_host.as_ref(), clock: s.clock.as_ref() }.apply(&mut surface, deferred_mode(self.mode), &extra, &options);
        Ok(surface.as_object().cloned().expect("surface object"))
    }

    /// `reconcileSession` over an empty thread's header: the workflow it takes (`applyPolicy`),
    /// its tool surface under the gates as they stand (`applyToolDenials`) and, when it has a
    /// prompt identity, its prompt composed again (`stagePolicy`). A delegated worker takes the
    /// same path with its owner's finalization: the Lead-only control tools leave its list,
    /// which is put in route order, and only a hidden agent honors a schema allowlist. A surface already
    /// brought to the gates and the prompt settings as they stand is left as it is, but for the connectors
    /// (`appliedKeys`); the key a rebuilt surface is brought to comes back with its change.
    async fn empty_surface_change(&self, thread: &ThreadId, header: &Header) -> Result<(HeaderChange, Option<Applied>), String> {
        let s = &self.sources;
        let mut session = Value::Object(header.clone());
        // `stageConnectorAvailability` first, on the session as it was (Node's order in `reconcileSession`).
        if let Some(map) = session.as_object_mut() {
            stage_connector_availability(map, thread, s.connectors.as_ref(), s.clock.now_ms());
        }
        let connectors_only = header_diff(header, session.as_object().expect("session object"));
        let owner_is_agent = is_agent_owner(&session);
        let identity = header.get("promptIdentity").filter(|identity| identity.is_object());
        let agent = identity.and_then(|identity| identity.get("agent")).and_then(Value::as_str).filter(|agent| !agent.is_empty());
        let route = s.routes.route(thread);
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        // ctiveWorkflowContext(config): the workflow the config makes active, not the session's.
        let target = s.workflow.target(header, "", None).await.map_err(String::from)?;
        let mut denied: Vec<String> = Vec::new();
        for name in s.workflow.live_denied_tools(header, &target.summary).await.map_err(String::from)? {
            if !name.is_empty() && !denied.contains(&name) {
                denied.push(name);
            }
        }
        // `honoredSchemaAllowlist`: an agent-owned session honors one only for a hidden agent.
        let honored = header.get("schemaAllowedTools").is_some_and(Value::is_array) && (!owner_is_agent || (s.hidden_agent)(agent));
        let allowed = honored.then(|| strings(header.get("schemaAllowedTools")));
        // `applyPolicy`: the workflow as the config gives it, the overlays dropped.
        let map = session.as_object_mut().expect("session object");
        for key in ["workflowOverlay", "orchestrationModeOverlay", "workflowOpenedTools", "promptFoldPending", "compactionFoldPending"] {
            map.shift_remove(key);
        }
        map.insert("workflow".to_owned(), workflow_meta(&target.summary));
        map.insert("orchestrationMode".to_owned(), json!(target.orchestration_mode));
        map.insert("sessionMode".to_owned(), json!(session_mode_of(header)));
        session["disallowedTools"] = json!(denied);
        for key in ["tools", "deferredToolCatalog"] {
            if let Some(items) = session.get(key).and_then(Value::as_array) {
                let kept = filter_disallowed_tools(items, &denied);
                session[key] = Value::Array(kept);
            }
        }
        let standalone = finalize_docs(s.workflow.standalone_tools(header).await.map_err(String::from)?, allowed.as_deref(), &denied, owner_is_agent.then_some(&self.agent_defs));
        if let Some(items) = session.get("tools").and_then(Value::as_array) {
            let kept = finalize_docs(items.clone(), allowed.as_deref(), &denied, owner_is_agent.then_some(&self.agent_defs));
            session["tools"] = Value::Array(kept);
        }
        // The prompt is composed first so the deferred surface's own manifest step finds its blocks.
        let surface = ToolSurface { host: s.tool_host.as_ref(), clock: s.clock.as_ref() };
        let mut prompt = None;
        if identity.is_some() {
            let names = |key: &str| doc_names(session.get(key));
            let has_git_tool = names("tools").iter().chain(names("deferredToolCatalog").iter()).any(|name| name == "git");
            let request = RebuildRequest { header: header.clone(), target: target.clone(), denied: denied.clone(), allow: allowed.clone(), provider: provider.clone(), model: model.clone(), has_git_tool };
            let composed = s.prompt.rebuild(request).await?;
            session["messages"] = Value::Array(composed.blocks.node_messages());
            prompt = Some(composed);
        }
        // `reconcileSession`: a surface already brought to these gates and these prompt settings stays.
        let gates = self.gates(&s.feature_denied.denied().await?);
        let settings = prompt.as_ref().and_then(|composed| composed.prompt_settings.get("revision")).and_then(Value::as_str).unwrap_or_default().to_owned();
        let key = Applied { gates, settings };
        if self.applied_to(thread).as_ref() == Some(&key) && !truthy(header.get("promptSettingsRecheck")) {
            return Ok((connectors_only, None));
        }
        let options = ApplyOptions { provider: Some(provider), model: None, disallowed: Vec::new() };
        surface.apply(&mut session, deferred_mode(thread_mode(header)), &standalone, &options);
        if let Some(composed) = prompt {
            // `applyInitialDeferredToolManifestToBp2(session, pool, { rebuild: true })`.
            let pool = surface.pool_tool_names(&session);
            apply_initial_manifest(&mut session, &pool, true, s.clock.as_ref());
            // The first-turn MCP fold may rebuild the prompt in place too (an empty thread reopened from disk was never marked).
            session["deferredInitialRefreshPending"] = json!(true);
            land_prompt(&mut session, composed, &model)?;
        }
        let map = session.as_object_mut().expect("session object");
        map.shift_remove("messages");
        // `stageToolAvailability` last, on the session as rebuilt: a gate that moved meanwhile.
        let feature_denied = s.feature_denied.denied().await?;
        let candidates = if missing_definitions(map, &feature_denied).is_empty() { Vec::new() } else { self.definition_candidates(thread, header).await? };
        stage_tool_availability(map, &feature_denied, &candidates, s.clock.now_ms());
        Ok((header_diff(header, map), Some(key)))
    }

    /// `toolDefinitionsFor(names)`: the definitions the thread's kind may hold, built-ins included,
    /// for tools a settings gate opened: the workflow's standalone tools, then the tools its spec
    /// resolves to; the first of a name, finalized for the owner (a worker loses the Lead-only tools).
    async fn definition_candidates(&self, thread: &ThreadId, header: &Header) -> Result<Vec<Value>, String> {
        let s = &self.sources;
        let model = clean(s.routes.route(thread).get("model"));
        let cwd = header.get("cwd").and_then(Value::as_str).map_or_else(|| s.cwd.clone(), PathBuf::from);
        let spec = tool_spec_for_mode(thread_mode(header));
        let previewed = resolve(
            &s.pool,
            s.mcp.tools(header_scope(header), &cwd),
            &Resolve { tool_spec: Some(&spec), model: &model, skills_listed: false, agent_owned: false, schema_allowed: None, disallowed: &[] },
        );
        let mut seen = HashSet::new();
        let docs: Vec<Value> = s
            .workflow
            .standalone_tools(header)
            .await
            .map_err(String::from)?
            .into_iter()
            .chain(previewed.iter().map(tool_doc))
            .filter(|doc| {
                let name = tool_name(doc);
                !name.is_empty() && seen.insert(name)
            })
            .collect();
        Ok(finalize_docs(docs, None, &[], is_agent_owner(&Value::Object(header.clone())).then_some(&self.agent_defs)))
    }

    /// ``reconcileSession`` over an empty thread: its settings, tool surface and prompt rebuilt from the
    /// settings as they stand and written back (retried when the header moved meanwhile). The caller
    /// has decided the thread is empty and idle.
    async fn settle_empty(&self, thread: &ThreadId) -> Result<(), CoreError> {
        let s = &self.sources;
        loop {
            let header = s.threads.header(thread).await.map_err(|error| port(thread, error))?;
            let (change, applied) = self.empty_surface_change(thread, &header).await.map_err(|message| failed("tools", message))?;
            if change.set.is_empty() && change.unset.is_empty() {
                self.note_applied_key(thread, applied);
                return Ok(());
            }
            let expect: Map<String, Value> =
                change.set.keys().chain(change.unset.iter()).map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            // A header that moved meanwhile is read and decided again.
            if s.threads.patch_header_if(thread, expect, change.set, change.unset).await.map_err(|error| port(thread, error))?.is_none() {
                self.note_applied_key(thread, applied);
                return Ok(());
            }
        }
    }

    /// The turn-start half of Node's reconcile for a thread that has a conversation: its settings-gated
    /// tools follow the live gates (`stageToolAvailability`) without touching its prefix. What moved,
    /// if anything; the header is written only when it changed.
    pub async fn stage_gates(&self, thread: &ThreadId) -> Result<Staged, CoreError> {
        self.stage(thread, true, None).await
    }

    /// The prompt sections a conversation's settings are compared with, as they stand now
    /// (`promptSettingsSections`): the prompt composition's own, over the thread's workflow, denials and route.
    async fn current_prompt(&self, thread: &ThreadId, header: &Header) -> Result<SessionPrompt, String> {
        let s = &self.sources;
        let route = s.routes.route(thread);
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        let target = s.workflow.target(header, "", None).await.map_err(String::from)?;
        let mut denied: Vec<String> = Vec::new();
        for name in s.workflow.live_denied_tools(header, &target.summary).await.map_err(String::from)? {
            if !name.is_empty() && !denied.contains(&name) {
                denied.push(name);
            }
        }
        let owner_is_agent = is_agent_owner(&Value::Object(header.clone()));
        let agent = header.get("promptIdentity").and_then(|identity| identity.get("agent")).and_then(Value::as_str).filter(|agent| !agent.is_empty());
        let honored = header.get("schemaAllowedTools").is_some_and(Value::is_array) && (!owner_is_agent || (s.hidden_agent)(agent));
        let allowed = honored.then(|| strings(header.get("schemaAllowedTools")));
        let has_git_tool = doc_names(header.get("tools")).iter().chain(doc_names(header.get("deferredToolCatalog")).iter()).any(|name| name == "git");
        s.prompt.rebuild(RebuildRequest { header: header.clone(), target, denied, allow: allowed, provider, model, has_git_tool }).await
    }

    /// [`Self::stage_gates`], or with `tools` false only the connector switches, which Node reads every turn. With
    /// `notice` (the sections as they stand now) the thread's prompt settings are compared with them first and the
    /// notice for what changed is staged (`stagePromptSettingsNotice`); a change folds in at the next cold point
    /// (`promptFoldPending`), except for a delegated worker, whose prompt is never rebuilt.
    async fn stage(&self, thread: &ThreadId, tools: bool, notice: Option<&OwnedSections>) -> Result<Staged, CoreError> {
        let s = &self.sources;
        loop {
            let header = s.threads.header(thread).await.map_err(|error| port(thread, error))?;
            let mut next = header.clone();
            let connectors = stage_connector_availability(&mut next, thread, s.connectors.as_ref(), s.clock.now_ms());
            if let Some(sections) = notice {
                let changed = stage_prompt_settings_notice(&mut next, sections, s.clock.now_ms());
                if !changed.is_empty() && !is_agent_owner(&Value::Object(next.clone())) {
                    next.insert("promptFoldPending".to_owned(), Value::Bool(true));
                }
            }
            let mut moved = None;
            if tools {
                let feature_denied = s.feature_denied.denied().await.map_err(|message| failed("tools", message))?;
                let candidates = if missing_definitions(&next, &feature_denied).is_empty() { Vec::new() } else { self.definition_candidates(thread, &header).await.map_err(|message| failed("tools", message))? };
                moved = stage_tool_availability(&mut next, &feature_denied, &candidates, s.clock.now_ms());
            }
            let change = header_diff(&header, &next);
            if change.set.is_empty() && change.unset.is_empty() {
                return Ok(Staged { moved, connectors, header });
            }
            let expect: Map<String, Value> = change.set.keys().chain(change.unset.iter()).map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            if s.threads.patch_header_if(thread, expect, change.set, change.unset).await.map_err(|error| port(thread, error))?.is_none() {
                return Ok(Staged { moved, connectors, header: next });
            }
        }
    }
}
#[async_trait]
impl SurfaceHost for LeadSurfaceHost {
    fn mode(&self, header: Option<&Header>) -> String {
        header.map_or(self.mode, thread_mode).to_owned()
    }

    async fn preview(&self) -> Result<StatusSurface, CoreError> {
        let surface = self.preview_surface().await.map_err(|message| failed("tools", message))?;
        Ok(surface_of_header(self.mode.to_owned(), &surface))
    }

    async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), CoreError> {
        let s = &self.sources;
        // `reconcileEmptySession`: a running turn, or a conversation, keeps its surface.
        if s.live.running(thread.as_str()) {
            return Ok(());
        }
        let messages = s.messages.messages(thread).await.map_err(|error| port(thread, error))?;
        if has_conversation_messages(&messages) {
            return Ok(());
        }
        self.settle_empty(thread).await
    }
}

/// What staging the gates left: what moved, and the thread's header afterwards.
pub struct Staged {
    /// The settings-gated tools a gate opened or closed.
    pub moved: Option<Moved>,
    /// The connector tools the agent and project policies opened or closed.
    pub connectors: Option<Moved>,
    pub header: Header,
}

/// `reconcileTurnSettings` at a turn start: the thread's settings-gated tools follow the live gates
/// before the turn is assembled from its header.
#[async_trait]
impl TurnSettings for LeadSurfaceHost {
    /// ``reconcileTurnSettings``: a thread with no conversation yet and a prompt identity is rebuilt whole
    /// (the prompt composed at creation follows the settings as they stand now), the way Node rebuilds an
    /// empty session at its first turn; one without an identity is a session Node never rebuilds
    /// (``missing-prompt-identity``) and, like one with a conversation, only takes the moved gates and
    /// connectors without touching its prefix.
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String> {
        let described = |error: CoreError| format!("{error:?}");
        let s = &self.sources;
        // `applied?.gates === gates`: a thread already brought to the live gate list is not staged again.
        let gates = self.gates(&s.feature_denied.denied().await?);
        let header = s.threads.header(thread).await.map_err(|error| port(thread, error)).map_err(described)?;
        let identity = header.get("promptIdentity").is_some_and(Value::is_object);
        if !conversation && identity {
            self.settle_empty(thread).await.map_err(described)?;
            return self.fold_mcp_surface(thread).await.map_err(described);
        }
        // A conversation with a prompt identity compares the prompt settings as they stand now with what its prompt
        // presents (`reconcileSession`: `applied.gates === gates && applied.settings === settings`); a session without
        // an identity has no sections (`settings` undefined).
        let (sections, settings) = if identity {
            let composed = self.current_prompt(thread, &header).await?;
            let revision = composed.prompt_settings.get("revision").and_then(Value::as_str).unwrap_or_default().to_owned();
            (Some(composed.sections), revision)
        } else {
            (None, String::new())
        };
        let key = Applied { gates: gates.clone(), settings };
        let unchanged = self.applied_to(thread).as_ref() == Some(&key) && !truthy(header.get("promptSettingsRecheck"));
        self.stage(thread, !unchanged, sections.as_ref().filter(|_| !unchanged)).await.map_err(described)?;
        self.note_applied(thread, key);
        self.fold_mcp_surface(thread).await.map_err(described)
    }

    /// `refreshDeferredMcpToolCatalog(session)` at a request boundary, a tool call or a `load_tool`.
    async fn refresh_mcp(&self, thread: &ThreadId) -> Result<(), String> {
        self.fold(thread, false).await.map(|_| ()).map_err(|error| format!("{error:?}"))
    }
}

impl LeadSurfaceHost {
    /// The header after Node's `foldMcpSurface` (`turn-prepare.mjs`), which follows `reconcileTurnSettings` at a turn
    /// start, and the request boundary's `refreshDeferredMcpToolCatalog` that runs at the turn's first model request.
    ///
    /// * First turn of a fresh thread (`deferredInitialRefreshPending`): the flag is cleared and the live MCP tools are
    ///   folded into the initial surface (`refreshInitialDeferredMcpSurface`); the boundary then reconciles the late
    ///   pool against the same registry, which no turn-start step can have moved.
    /// * Any later turn: the late pool, connected names and pending delta follow the live registry
    ///   (`reconcileDeferredMcpToolCatalog`).
    ///
    /// Not carried: the grace Node waits for a reconnect in flight (`awaitMcpGrace`, and the agent runtime's wait for
    /// its initial connect), since the hub offers no readiness wait. The reconciles at the request boundary and around
    /// each tool call are `refresh_mcp`.
    async fn fold_mcp_surface(&self, thread: &ThreadId) -> Result<Header, CoreError> {
        self.fold(thread, true).await
    }

    /// `refreshDeferredMcpToolCatalog(session)`: the reconcile alone, for a session that has a deferred provider mode.
    async fn fold(&self, thread: &ThreadId, first_turn: bool) -> Result<Header, CoreError> {
        let s = &self.sources;
        // The turn's request boundary migrates a surface built for another exposure only where no tool call waits for a result.
        let unanswered = first_turn && has_unanswered_tool_calls(&s.messages.messages(thread).await.map_err(|error| port(thread, error))?);
        loop {
            let header = s.threads.header(thread).await.map_err(|error| port(thread, error))?;
            let cwd = header.get("cwd").and_then(Value::as_str).map_or_else(|| s.cwd.clone(), PathBuf::from);
            let live: Vec<Value> = s.mcp.tools(header_scope(&header), &cwd).iter().map(tool_doc).collect();
            let (next, state) = self.folded_surface(thread, &header, &live, first_turn).map_err(|message| failed("tools", message))?;
            let next = match first_turn {
                true => self.migrate_exposure(&next, unanswered).map_err(|message| failed("tools", message))?.unwrap_or(next),
                false => next,
            };
            let change = header_diff(&header, &next);
            if change.set.is_empty() && change.unset.is_empty() {
                self.note_mcp_state(thread, state);
                return Ok(header);
            }
            let expect: Map<String, Value> = change.set.keys().chain(change.unset.iter()).map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            // A header that moved meanwhile is read and decided again; the state is kept only for a fold that landed.
            if s.threads.patch_header_if(thread, expect, change.set, change.unset).await.map_err(|error| port(thread, error))?.is_none() {
                self.note_mcp_state(thread, state);
                return Ok(next);
            }
        }
    }

    /// `reconcileStateOf(session, liveMcpTools)`: the inputs a reconcile reads, as they stand. The
    /// registry's tool-generation counter (`getMcpToolGeneration`) only invalidates Node's identity-keyed tool
    /// clones; the live tools themselves are compared by value here.
    fn mcp_state_of(session: &Value, live: &[Value]) -> Value {
        let text = |key: &str| json!(clean(session.get(key)));
        let selection = |key: &str| json!(parse_tool_selection(session.get(key)));
        json!({
            "live": live,
            "tools": session.get("tools").cloned().unwrap_or(Value::Null),
            "lateCatalog": session.get("deferredLateToolCatalog").cloned().unwrap_or(Value::Null),
            "scope": text("mcpScopeId"),
            "cwd": text("cwd"),
            "mode": text("deferredSurfaceMode"),
            "providerMode": text("deferredProviderMode"),
            "exposure": text("toolExposureMode"),
            "provider": text("provider"),
            "model": text("model"),
            "disallowed": session.get("disallowedTools").cloned().unwrap_or_else(|| json!([])),
            "callable": selection("deferredCallableTools"),
            "discovered": selection("deferredDiscoveredTools"),
        })
    }

    /// `reconcileDeferredMcpToolCatalog` behind its `RECONCILE_STATE` cache: a reconcile whose inputs equal those the
    /// last one left behind is skipped outright. The state to remember once the result is written, `None` for a skip.
    fn reconcile_cached(&self, thread: &ThreadId, surface: &ToolSurface, session: &mut Value, live: &[Value]) -> Option<Value> {
        if !session.get("tools").is_some_and(Value::is_array) {
            return None;
        }
        if self.mcp_state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(thread.as_str()) == Some(&Self::mcp_state_of(session, live)) {
            return None;
        }
        surface.reconcile_mcp_catalog(session, live);
        Some(Self::mcp_state_of(session, live))
    }

    /// Remembers the state a landed reconcile left (`RECONCILE_STATE.set`).
    fn note_mcp_state(&self, thread: &ThreadId, state: Option<Value>) {
        if let Some(state) = state {
            self.mcp_state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread.as_str().to_owned(), state);
        }
    }

    /// `migrateToolExposureAtBoundary` (`session/loop/tool-exposure-migration.mjs`) and the request boundary's
    /// `delete sessionRef.pendingCacheBreakIntent` after it: a surface persisted for another exposure than its provider's
    /// (or a bridge surface an earlier revision built) is rebuilt by `applyDeferredToolSurface`, and what was measured
    /// against the old one is dropped: the provider state, the prefix guard, the context baseline. `None`: nothing to
    /// migrate, or `unanswered` (a tool call still waits for its result, which is not a safe boundary).
    ///
    /// The migration's cache-break tag rides on Node's request options (`opts.cacheBreakIntent`), which the Rust loop
    /// has no counterpart of, so the header carries none (see `decisions.md` `deferred-fold-5`).
    fn migrate_exposure(&self, header: &Header, unanswered: bool) -> Result<Option<Header>, String> {
        let s = &self.sources;
        let mut session = Value::Object(header.clone());
        if unanswered || !tool_exposure_migration_needed(&session, None, &load_tool_def(s.tool_host.as_ref())) {
            return Ok(None);
        }
        let surface = ToolSurface { host: s.tool_host.as_ref(), clock: s.clock.as_ref() };
        let before = SystemBlocks::from_header(header);
        session["messages"] = Value::Array(before.node_messages());
        let mode = header.get("deferredSurfaceMode").and_then(Value::as_str).filter(|mode| !mode.is_empty()).unwrap_or("lead").to_owned();
        let options = ApplyOptions { provider: Some(clean(header.get("provider"))), model: Some(clean(header.get("model"))), disallowed: Vec::new() };
        surface.apply(&mut session, &mode, &[], &options);
        let mut next = session.as_object().cloned().ok_or_else(|| "the migrated session is not an object".to_owned())?;
        let messages = next.shift_remove("messages").and_then(|messages| messages.as_array().cloned()).unwrap_or_default();
        let mut after = SystemBlocks::from_node_messages(&messages).map_err(|error| format!("{error:?}"))?;
        after.combined = before.combined;
        if after != before {
            after.write(&mut next);
        }
        let invalidated = invalidate_for_tool_surface_migration(s.clock.as_ref());
        for key in invalidated.unset {
            next.shift_remove(&key);
        }
        next.extend(invalidated.set);
        next.shift_remove("pendingCacheBreakIntent");
        Ok(Some(next))
    }

    /// `header` with the MCP fold applied over the system prompt as the session holds it (`messages`), the blocks
    /// written back only where the fold changed them, and the reconcile state to remember once it is written.
    /// `first_turn`: the turn start (`foldMcpSurface`), which also runs the initial fold of a fresh session.
    fn folded_surface(&self, thread: &ThreadId, header: &Header, live: &[Value], first_turn: bool) -> Result<(Header, Option<Value>), String> {
        // `refreshDeferredMcpToolCatalog`: a session with no deferred provider mode has no MCP catalog to refresh.
        if !first_turn && !truthy(header.get("deferredProviderMode")) {
            return Ok((header.clone(), None));
        }
        let s = &self.sources;
        let surface = ToolSurface { host: s.tool_host.as_ref(), clock: s.clock.as_ref() };
        let before = SystemBlocks::from_header(header);
        let mut session = Value::Object(header.clone());
        session["messages"] = Value::Array(before.node_messages());
        let state = if first_turn && truthy(header.get("deferredInitialRefreshPending")) {
            // One-shot: cleared before the fold, so the fold never runs twice.
            session["deferredInitialRefreshPending"] = json!(false);
            surface.refresh_initial_mcp_surface(&mut session, live);
            // The request boundary's `refreshDeferredMcpToolCatalog` follows, for a session with a deferred mode.
            if truthy(session.get("deferredProviderMode")) { self.reconcile_cached(thread, &surface, &mut session, live) } else { None }
        } else {
            self.reconcile_cached(thread, &surface, &mut session, live)
        };
        let mut next = session.as_object().cloned().ok_or_else(|| "the folded session is not an object".to_owned())?;
        let messages = next.shift_remove("messages").and_then(|messages| messages.as_array().cloned()).unwrap_or_default();
        let mut after = SystemBlocks::from_node_messages(&messages).map_err(|error| format!("{error:?}"))?;
        after.combined = before.combined;
        if after != before {
            after.write(&mut next);
        }
        Ok((next, state))
    }
}

/// A new Lead thread starts as Node's `createSession` + `seedToolSurface` make it: the workflow
/// the config gives, the tools its spec resolves to (`resolveSessionToolSurface`), the deferred
/// surface over them, and the session system composed (`composeSessionSystem`) by the same
/// `refreshEmptySessionToolPolicy`: the same rebuild a turn start gives an empty thread, asked for by `thread/clear`.
#[async_trait]
impl EmptyToolSurface for LeadSurfaceHost {
    async fn refresh_empty(&self, thread: &ThreadId) -> Result<bool, String> {
        let s = &self.sources;
        let described = |error: CoreError| format!("{error:?}");
        // `invalidatePreSessionToolSurface()` comes first, whether or not the thread admits the refresh.
        s.surface_generation.bump();
        // `admitsRefresh`: a running turn, or a conversation, keeps its surface.
        if s.live.running(thread.as_str()) {
            return Ok(false);
        }
        let messages = s.messages.messages(thread).await.map_err(|error| described(port(thread, error)))?;
        if has_conversation_messages(&messages) {
            return Ok(false);
        }
        let header = s.threads.header(thread).await.map_err(|error| described(port(thread, error)))?;
        // `missing-prompt-identity`: an older record is never rebuilt.
        if !header.get("promptIdentity").is_some_and(Value::is_object) {
            return Ok(false);
        }
        self.settle_empty(thread).await.map_err(described)?;
        Ok(true)
    }
}

/// [`PromptRebuild`] a reconcile uses, so the prompt has one composition path.
#[async_trait]
impl NewThreadTools for LeadSurfaceHost {
    /// The thread's own MCP scope comes first (`rt.mcpScopeId = randomUUID()`, `boot/begin.mjs:24`): the
    /// configured servers connect under it (`mcp-glue/connect.mjs`) before the tools are read, and it
    /// is written into the header as `createSession` records it. A seed that does not end in a
    /// created thread is abandoned by `thread/start`, which releases the scope.
    async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
        let s = &self.sources;
        let cwd = header.get("cwd").and_then(Value::as_str).map_or_else(|| s.cwd.clone(), PathBuf::from);
        // Each session is created with a scope of its own, as each `createSession` boots a runtime of its
        // own (`session-service/entries/lifecycle.mjs:47`, `begin.mjs:24`); the runtime scope is never handed on.
        let scope = uuid::Uuid::new_v4().to_string();
        s.scopes.open(&scope, thread.as_str(), &cwd).await.map_err(|error| format!("mcp scope {scope}: {error}"))?;
        let mut scoped = header.clone();
        scoped.insert("mcpScopeId".to_owned(), json!(scope));
        self.seed_scoped(thread, &scoped, &scope).await
    }

    /// The desktop's control thread is the runtime that Node boots separately (`ensureControlSession`): it
    /// opens no scope of its own and runs in the daemon's runtime scope, the one connected at boot, so
    /// there is one connection set for it and for every read with no session. The scope is the daemon's,
    /// not the thread's: closing the thread releases nothing.
    async fn seed_control(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
        let s = &self.sources;
        let scope = s.scopes.open_runtime(&s.cwd).await.map_err(|error| format!("mcp scope of the runtime: {error}"))?;
        let mut scoped = header.clone();
        scoped.insert("mcpScopeId".to_owned(), json!(scope));
        self.seed_scoped(thread, &scoped, &scope).await
    }

    /// The thread was seeded and not created: the scope the seed opened for it is released.
    fn abandon(&self, thread: &ThreadId) {
        self.sources.scopes.release(thread.as_str());
    }
}

impl LeadSurfaceHost {
    /// `seed` over a header that already names the thread's MCP scope, `scope`, which is open.
    async fn seed_scoped(&self, thread: &ThreadId, header: &Header, scope: &str) -> Result<Header, String> {
        let s = &self.sources;
        let route = s.routes.route(thread);
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        let cwd = header.get("cwd").and_then(Value::as_str).map_or_else(|| s.cwd.clone(), PathBuf::from);
        let skills_listed = s.skills.any_for(&cwd).await?;
        // `activeWorkflowContext(config)`: the workflow the config makes active.
        let target = s.workflow.target(header, "", None).await.map_err(String::from)?;
        let allowed = header.get("schemaAllowedTools").is_some_and(Value::is_array).then(|| strings(header.get("schemaAllowedTools")));
        // `sessionDeny`: the caller's denials, `agent` where the workflow delegates to no one, and
        // `react` outside a bot's own chat.
        let mut denied = strings(header.get("disallowedTools"));
        // `createSession`'s `disallowedTools: [...callerDisallowedTools, ...featureDisallowedTools()]`: the gates as they
        // stand now, so a tool a setting switches off is in neither the schema, the deferred pool nor the announced set.
        let feature_denied = s.feature_denied.denied().await?;
        for name in &feature_denied {
            if !denied.contains(name) {
                denied.push(name.clone());
            }
        }
        if workflow_disallows_agent_tool(&target.summary, session_mode_of(header) == "agent") {
            denied.push("agent".to_owned());
        }
        denied.push(REACTION_TOOL_NAME.to_owned());
        let routing = resolve(
            &s.pool,
            s.mcp.tools(Some(scope), &cwd),
            &Resolve { tool_spec: header.get("toolSpec"), model: &model, skills_listed, agent_owned: false, schema_allowed: None, disallowed: &[] },
        );
        let resolved = resolve(
            &s.pool,
            s.mcp.tools(Some(scope), &cwd),
            &Resolve { tool_spec: header.get("toolSpec"), model: &model, skills_listed, agent_owned: false, schema_allowed: allowed.as_deref(), disallowed: &denied },
        );
        // `schemaOmittedToolNames`: with a caller allowlist, every routed tool it hides is omitted from BP1 too.
        let mut omit = denied.clone();
        if allowed.is_some() {
            let visible: Vec<String> = resolved.iter().map(|tool| tool.spec().name.to_lowercase()).collect();
            omit.extend(routing.iter().map(|tool| tool.spec().name.clone()).filter(|name| !name.is_empty() && !visible.contains(&name.to_lowercase())));
        }
        let mut session = Value::Object(header.clone());
        session["id"] = json!(thread.as_str());
        session["tools"] = Value::Array(resolved.iter().map(|tool| session_doc(&s.pool, tool)).collect());
        session["disallowedTools"] = json!(denied);
        session["workflow"] = workflow_meta(&target.summary);
        session["orchestrationMode"] = json!(target.orchestration_mode);
        session["sessionMode"] = json!(session_mode_of(header));
        let standalone = internal_tools(&s.pool);
        let mut extra: Vec<Value> = {
            let inputs = SurfaceInputs {
                session: session.as_object(),
                profile_allowed: None,
                feature_denied: &feature_denied,
                // A session that has an orchestration mode never counts the delegatable agents.
                delegatable_agents: &|| 0,
            };
            model_standalone_tools(&standalone, &s.agent_tools, &inputs).iter().map(tool_doc).collect()
        };
        extra.extend(s.mcp.tools(Some(scope), &cwd).iter().map(tool_doc));
        // `composeSessionSystem`: a Lead's identity is the default one (no caller prompt, no skips), of the `lead` agent
        // (`sessionOptions`: `agent: homeAgent || 'lead'`).
        let mut identified = header.clone();
        identified.insert("id".to_owned(), json!(thread.as_str()));
        identified.insert("promptIdentity".to_owned(), json!({ "systemPrompt": "", "skipAgentRules": false, "profileSkip": {}, "agent": "lead" }));
        let roster = roster_revision(&target);
        let request = RebuildRequest {
            header: identified,
            target,
            denied: omit,
            allow: allowed,
            provider: provider.clone(),
            model: model.clone(),
            has_git_tool: routing.iter().any(|tool| tool.spec().name == "git"),
        };
        let composed = s.prompt.rebuild(request).await?;
        session["messages"] = Value::Array(composed.blocks.node_messages());
        // `deferredSurfaceModeForLead(mode)` of the mode the spec was made from.
        let mode = if header.get("toolSpec") == Some(&tool_spec_for_mode("readonly")) { "readonly" } else { "lead" };
        let options = ApplyOptions { provider: Some(provider), model: Some(model.clone()), disallowed: Vec::new() };
        ToolSurface { host: s.tool_host.as_ref(), clock: s.clock.as_ref() }.apply(&mut session, mode, &extra, &options);
        // `seedToolSurface`: a fresh session (never a resumed one) is eligible for the first turn's MCP fold, which
        // re-folds a server that finished its handshake between creation and that turn.
        session["deferredInitialRefreshPending"] = json!(true);
        // `noteToolAvailability`: built from the settings as they stand, its first turn need not rebuild it.
        let settings = composed.prompt_settings.get("revision").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.note_applied(thread, Applied { gates: self.gates(&feature_denied), settings });
        land_prompt(&mut session, composed, &model)?;
        let mut seeded = session.as_object().cloned().ok_or_else(|| "the seeded session is not an object".to_owned())?;
        seeded.shift_remove("messages");
        // `buildSessionRecord`'s remaining fields, and the stamps of the profile and bot roster the prompt was composed from.
        write_lead_record(&mut seeded, s.clock.now_ms(), std::process::id());
        seeded.insert("agentRosterRevision".to_owned(), json!(roster));
        Ok(seeded)
    }
}

/// `leadRosterRevision(parts)` (`role-instructions.mjs:413`): the bot roster a Lead's prompt lists (its
/// agent catalog and Mixy's contact catalog), as one hash.
fn roster_revision(target: &WorkflowTarget) -> String {
    let mut hash = Sha256::new();
    for slice in [&target.agent_catalog_context, &target.contact_catalog_context] {
        hash.update(format!("{slice}\0"));
    }
    hash.finalize().iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

/// The session's system messages after the deferred surface's manifest step, back into the
/// header's blocks, written with the rest of the prompt's fields; then
/// `refreshSessionBp3Environment(session, session.cwd)`, which `createSession` and the empty-session
/// rebuild end with: the `env` block becomes the `# Session` block (the folder and the model) followed
/// by the environment tail. `model` is the route's: a created thread's header names it only once its
/// route is seated.
fn land_prompt(session: &mut Value, mut composed: SessionPrompt, model: &str) -> Result<(), String> {
    let messages = session.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    composed.blocks = SystemBlocks::from_node_messages(&messages).map_err(|error| format!("{error:?}"))?;
    let header = session.as_object_mut().ok_or_else(|| "the session is not an object".to_owned())?;
    composed.write(header);
    let mut routed = header.clone();
    routed.insert("model".to_owned(), json!(model));
    let patch = refresh_environment(&routed, &SystemBlocks::from_header(&routed));
    for key in &patch.change.unset {
        header.shift_remove(key);
    }
    for (key, value) in patch.change.set {
        header.insert(key, value);
    }
    Ok(())
}
#[cfg(test)]
mod tests;
