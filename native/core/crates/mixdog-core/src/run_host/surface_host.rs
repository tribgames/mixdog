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
use super::session_tools::BRIDGE;
use super::session_tools::Resolve;
use super::session_tools::SessionMcp;
use super::session_tools::SkillsListed;
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
/// servers' initialize instructions (`getMcpServerInstructionsMap`; the hub is one scope).
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

    fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
        let mut out = Map::new();
        for server in self.hub.servers() {
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
    /// The connected servers' tools for a folder.
    pub mcp: Arc<dyn SessionMcp>,
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
}

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
        Ok(Self { mode: normalize_tool_mode(&sources.mode), sources, agent_defs, applied: std::sync::Mutex::default() })
    }

    /// `availabilityKey()` less the skill and plugin generation: the config installed, and the gate list.
    fn gates(&self, feature_denied: &[String]) -> String {
        format!("{}|{}", (self.sources.config_revision)(), feature_denied.join(","))
    }

    /// `appliedKeys.get(session)`.
    fn applied_to(&self, thread: &ThreadId) -> Option<Applied> {
        self.applied.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(thread.as_str()).cloned()
    }

    /// `appliedKeys.set(session, key)`.
    fn note_applied(&self, thread: &ThreadId, key: Applied) {
        self.applied.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread.as_str().to_owned(), key);
    }

    /// Whether `thread` was last brought to these gates (`applied?.gates === gates`).
    fn gates_applied(&self, thread: &ThreadId, gates: &str) -> bool {
        self.applied_to(thread).is_some_and(|applied| applied.gates == gates)
    }

    /// The gates a staging brought `thread` to, the prompt settings already recorded for it kept.
    fn note_gates(&self, thread: &ThreadId, gates: String) {
        self.applied.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(thread.as_str().to_owned()).or_default().gates = gates;
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
        // `previewSessionTools(toolSpecForMode(mode), [], ..)`: no skills, not an agent's session.
        let resolved = resolve(
            &s.pool,
            s.mcp.tools(&s.cwd),
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
            "mcpScopeId": Value::Null,
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
            s.mcp.tools(&cwd),
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
        self.stage(thread, true).await
    }

    /// [`Self::stage_gates`], or with `tools` false only the connector switches, which Node reads every turn.
    async fn stage(&self, thread: &ThreadId, tools: bool) -> Result<Staged, CoreError> {
        let s = &self.sources;
        loop {
            let header = s.threads.header(thread).await.map_err(|error| port(thread, error))?;
            let mut next = header.clone();
            let connectors = stage_connector_availability(&mut next, thread, s.connectors.as_ref(), s.clock.now_ms());
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
        let unchanged = self.gates_applied(thread, &gates);
        if !conversation {
            let header = s.threads.header(thread).await.map_err(|error| port(thread, error)).map_err(described)?;
            if header.get("promptIdentity").is_some_and(Value::is_object) {
                self.settle_empty(thread).await.map_err(described)?;
                return s.threads.header(thread).await.map_err(|error| port(thread, error)).map_err(described);
            }
        }
        let staged = self.stage(thread, !unchanged).await.map_err(described)?;
        self.note_gates(thread, gates);
        Ok(staged.header)
    }
}

/// A new Lead thread starts as Node's `createSession` + `seedToolSurface` make it: the workflow
/// the config gives, the tools its spec resolves to (`resolveSessionToolSurface`), the deferred
/// surface over them, and the session system composed (`composeSessionSystem`) by the same
/// [`PromptRebuild`] a reconcile uses, so the prompt has one composition path.
#[async_trait]
impl NewThreadTools for LeadSurfaceHost {
    async fn seed(&self, thread: &ThreadId, header: &Header) -> Result<Header, String> {
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
        if workflow_disallows_agent_tool(&target.summary, session_mode_of(header) == "agent") {
            denied.push("agent".to_owned());
        }
        denied.push(REACTION_TOOL_NAME.to_owned());
        let routing = resolve(
            &s.pool,
            s.mcp.tools(&cwd),
            &Resolve { tool_spec: header.get("toolSpec"), model: &model, skills_listed, agent_owned: false, schema_allowed: None, disallowed: &[] },
        );
        let resolved = resolve(
            &s.pool,
            s.mcp.tools(&cwd),
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
        let feature_denied = s.feature_denied.denied().await?;
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
        extra.extend(s.mcp.tools(&cwd).iter().map(tool_doc));
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
