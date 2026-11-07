//! `_prepareResumeTools(session, preset)` (Node `session/manager/session-tool-surface.mjs:127-160`):
//! the tool list a stored session resolves to now, with the spec it was resolved from. A route
//! change refills the session's tools from it (`resetSessionForRouteChange`,
//! `session-lifecycle.mjs:459-461`): this is the [`PrepareTools`] of `AiRouteFacts`.
//!
//! The skills are collected inside the call, as Node's `collectPromptSkillsCached` collects when its
//! cache is stale (`skill-catalog.mjs:390-416`): [`SkillsListed::any_for`] reads the one catalog
//! cache and collects again after an invalidation, so a route change right after a skill write sees
//! it.
//!
//! Node's agent-runtime profile branch (`:131-139`, `profile.tools` for a `profileId`) is not
//! ported: `setAgentRuntime()` has no live caller (`session-lifecycle.mjs:260-262`), so it never
//! fires.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_mcp::McpHub;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::agent_variants::agent_definitions;
use super::agent_variants::bind_agent_docs;
use super::reactions::REACTION_TOOL_NAME;
use super::route_surface::PrepareTools;
use super::route_surface::PreparedTools;
use super::route_surface::is_agent_owner;
use super::rules::RulesPolicy;
use super::session_tools::Resolve;
use super::session_tools::SessionMcp;
use super::session_tools::SkillsListed;
use super::session_tools::resolve;
use super::surface_host::tool_doc;
use super::tool_surface::truthy;

/// `DEFAULT_MCP_SCOPE_ID` (`mcp/client.mjs:72`): the scope a session without `mcpScopeId` reads.
/// The daemon's one hub is this scope.
const DEFAULT_MCP_SCOPE: &str = "global";

/// The server and the server's own tool name of a connected MCP tool (`mcp__<server>__<tool>`,
/// possibly shortened): what a definition names when its name was cut.
pub trait McpToolNames: Send + Sync {
    fn names(&self, qualified: &str) -> Option<(String, String)>;
}

impl McpToolNames for McpHub {
    fn names(&self, qualified: &str) -> Option<(String, String)> {
        let target = self.tool_target(qualified)?;
        let entry = target.entry?;
        Some((target.server.name().to_owned(), entry.tool.clone()))
    }
}

/// The producer: the registered tools, the connected servers' tools and the skill catalog.
pub struct ResumeTools {
    /// Every registered tool (the `SessionToolBuilder` pool).
    pub pool: Vec<Arc<dyn Tool>>,
    pub mcp: Arc<dyn SessionMcp>,
    /// The hub's names of an MCP tool (`mcpServerName` / `mcpToolName`).
    pub mcp_names: Arc<dyn McpToolNames>,
    /// `collectPromptSkillsCached(cwd).length > 0` (`mcp_seams::CatalogSkillsListed`).
    pub skills: Arc<dyn SkillsListed>,
    /// `getHiddenAgent` and `delegationDisabled`.
    pub policy: Arc<dyn RulesPolicy>,
}

/// `reactionDisabled(source, ownerIsAgent)` (`session-tool-surface.mjs:33-36`): the react tool
/// belongs to a bot's home chat or its seat in a room, decided by the session's id.
fn reaction_disabled(session: &Value, owner_is_agent: bool) -> bool {
    let id = session.get("id").map(value_to_string).unwrap_or_default();
    owner_is_agent || !(agent_id_of_home_session(&id).is_some() || room_member_of_session(&id).is_some())
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| items.iter().map(value_to_string).collect())
}

/// A tool's definition as the session holds it (`ToolSpec::definition`). A connected MCP tool
/// whose name was shortened to fit provider limits also names its server's own tool and the server,
/// right after `name` (`mcpServerTools`, `mcp/client.mjs:1641-1646`).
fn definition(tool: &Arc<dyn Tool>, names: &dyn McpToolNames) -> Value {
    let doc = tool_doc(tool);
    let qualified = &tool.spec().name;
    let Some((server, leaf)) = names.names(qualified) else { return doc };
    if *qualified == format!("mcp__{server}__{leaf}") {
        return doc;
    }
    let Value::Object(fields) = doc else { return doc };
    let mut out = Map::new();
    for (key, value) in fields {
        let is_name = key == "name";
        out.insert(key, value);
        if is_name {
            out.insert("mcpToolName".into(), json!(leaf));
            out.insert("mcpServerName".into(), json!(server));
        }
    }
    Value::Object(out)
}

impl ResumeTools {
    /// `_prepareResumeTools(session, session.preset || 'full')`, the call a route change makes. A
    /// skill list that cannot be collected is the error, never "no skills".
    pub async fn prepare_tools(&self, header: &Header) -> Result<PreparedTools, String> {
        let session = Value::Object(header.clone());
        let owner_is_agent = is_agent_owner(&session);
        let cwd = header.get("cwd").and_then(Value::as_str).map(PathBuf::from).unwrap_or_default();
        let skills_listed = self.skills.any_for(&cwd).await?;
        // `ownerIsAgent ? 'full' : preset || session.preset || 'full'`, with `preset` itself
        // `session.preset || 'full'`.
        let tool_spec = match header.get("preset") {
            _ if owner_is_agent => json!("full"),
            Some(preset) if truthy(Some(preset)) => preset.clone(),
            _ => json!("full"),
        };
        // `honoredSchemaAllowlist`: an agent worker's allowlist binds only a hidden role.
        let agent = header.get("agent").and_then(Value::as_str);
        let schema_allowed = strings(header.get("schemaAllowedTools")).filter(|_| !owner_is_agent || self.policy.hidden_agent(agent));
        let mut disallowed = strings(header.get("disallowedTools")).unwrap_or_default();
        if self.policy.delegation_disabled(&session, owner_is_agent) {
            disallowed.push("agent".into());
        }
        if reaction_disabled(&session, owner_is_agent) {
            disallowed.push(REACTION_TOOL_NAME.into());
        }
        let model = header.get("model").and_then(Value::as_str).map_or("", js_trim);
        // `_getMcpTools(session.mcpScopeId, cwd)`: the servers registered under the session's scope
        // (`normalizeMcpScopeId`: empty is the default one). The daemon's hub is the default scope,
        // so a session of another scope has no connected server.
        let scope = header.get("mcpScopeId").and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty());
        let mcp = match scope {
            None | Some(DEFAULT_MCP_SCOPE) => self.mcp.tools(&cwd),
            Some(_) => Vec::new(),
        };
        let tools = resolve(
            &self.pool,
            mcp,
            &Resolve {
                tool_spec: Some(&tool_spec),
                model,
                skills_listed,
                agent_owned: owner_is_agent,
                schema_allowed: schema_allowed.as_deref(),
                disallowed: &disallowed,
            },
        );
        let docs: Vec<Value> = tools.iter().map(|tool| definition(tool, self.mcp_names.as_ref())).collect();
        // `bindAgentOwner` (`finalizeSessionToolList`, `tool-resolution.mjs:72-75`): an agent's
        // session holds the agent text of `git` and `task` (`Tool::agent_spec`).
        let docs = if owner_is_agent { bind_agent_docs(docs, &agent_definitions(&self.pool)) } else { docs };
        Ok(PreparedTools { tools: Value::Array(docs), tool_spec })
    }
}

#[async_trait]
impl PrepareTools for ResumeTools {
    /// A skill list that cannot be collected keeps the stored tools and says why.
    async fn prepare(&self, header: &Header) -> Option<PreparedTools> {
        match self.prepare_tools(header).await {
            Ok(prepared) => Some(prepared),
            Err(error) => {
                tracing::warn!(%error, "[session] route change kept the stored tools");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use mixdog_core_api::domain::tool::ToolAnnotations;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolOutcome;
    use mixdog_core_api::domain::tool::ToolOutput;
    use mixdog_core_api::domain::tool::ToolSpec;
    use mixdog_core_base::rooms::ids::agent_home_session_id;

    use super::*;

    struct Stub(ToolSpec);

    #[async_trait]
    impl Tool for Stub {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    fn spec_of(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: format!("{name} tool."),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: (name == "read").then_some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    /// `git` and `task` carry the agent text delegated agents are sent, as the real ones do.
    struct Agented(ToolSpec, ToolSpec);

    #[async_trait]
    impl Tool for Agented {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn agent_spec(&self) -> Option<&ToolSpec> {
            Some(&self.1)
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    fn stub(name: &str) -> Arc<dyn Tool> {
        if matches!(name, "git" | "task") {
            let agent = ToolSpec { description: format!("{name} for agents."), ..spec_of(name) };
            return Arc::new(Agented(spec_of(name), agent));
        }
        Arc::new(Stub(spec_of(name)))
    }

    /// The hub's names: `mcp__alpha__zeta` is `zeta` of `alpha` (not shortened); the cut
    /// `mcp__beta__web_search_extra` stands for `web_search_extra_long_name` of `beta`.
    struct Names;
    impl McpToolNames for Names {
        fn names(&self, qualified: &str) -> Option<(String, String)> {
            match qualified {
                "mcp__alpha__zeta" => Some(("alpha".into(), "zeta".into())),
                "mcp__beta__web_search_extra" => Some(("beta".into(), "web_search_extra_long_name".into())),
                _ => None,
            }
        }
    }

    struct Fixed(Vec<Arc<dyn Tool>>);
    impl SessionMcp for Fixed {
        fn tools(&self, _: &Path) -> Vec<Arc<dyn Tool>> {
            self.0.clone()
        }
    }

    struct Skills(Result<bool, String>);
    #[async_trait]
    impl SkillsListed for Skills {
        async fn any_for(&self, _: &Path) -> Result<bool, String> {
            self.0.clone()
        }
    }

    struct Policy {
        hidden: bool,
        no_delegation: bool,
    }
    impl RulesPolicy for Policy {
        fn hidden_agent(&self, _: Option<&str>) -> bool {
            self.hidden
        }
        fn delegation_disabled(&self, _: &Value, _: bool) -> bool {
            self.no_delegation
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/session_tools.json")).expect("fixture")
    }

    fn list(value: &Value) -> Vec<String> {
        value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_owned()).collect()
    }

    fn producer(skills: Result<bool, String>, policy: Policy) -> ResumeTools {
        let g = golden();
        let p = &g["pool"];
        let pool = ["builtin", "patch", "codeGraph", "internal"].iter().flat_map(|k| list(&p[k])).chain(["todo".to_owned(), "call_tool".to_owned()]);
        ResumeTools {
            pool: pool.map(|n| stub(&n)).collect(),
            mcp: Arc::new(Fixed(list(&p["mcp"]).iter().map(|n| stub(n)).collect())),
            mcp_names: Arc::new(Names),
            skills: Arc::new(Skills(skills)),
            policy: Arc::new(policy),
        }
    }

    fn header(value: Value) -> Header {
        value.as_object().expect("object").clone()
    }

    fn names(prepared: &PreparedTools) -> Vec<String> {
        prepared.tools.as_array().expect("tools").iter().map(|t| t["name"].as_str().expect("name").to_owned()).collect()
    }

    /// Every Lead case Node recorded (`resolveSessionTools` + `finalizeSessionToolList`): a home
    /// chat keeps `react`, a Lead that may delegate keeps `agent`, the stored preset is the spec.
    #[tokio::test]
    async fn a_lead_route_change_resolves_what_node_resolves() {
        let g = golden();
        let home = agent_home_session_id("bot").expect("home id");
        for case in g["cases"].as_array().expect("cases").iter().filter(|c| c["agent"] == false) {
            let skills = case["skills"].as_bool().expect("skills");
            let prepared = producer(Ok(skills), Policy { hidden: false, no_delegation: false })
                .prepare_tools(&header(json!({
                    "id": home, "cwd": "/work", "model": case["model"], "preset": case["spec"],
                    "schemaAllowedTools": case["allowed"], "disallowedTools": case["denied"],
                })))
                .await
                .expect("prepared");
            assert_eq!(names(&prepared), list(&case["tools"]), "{}", case["name"]);
            assert_eq!(prepared.tool_spec, case["spec"], "{}", case["name"]);
        }
    }

    /// Node's rules around the resolve: no preset is `full`; an agent worker is `full` whatever
    /// its preset and loses `react`; its allowlist binds only a hidden role; a Lead that may not
    /// delegate loses `agent`; outside a home chat or room seat `react` is gone.
    #[tokio::test]
    async fn the_spec_and_deny_rules_follow_node() {
        let lead = producer(Ok(false), Policy { hidden: false, no_delegation: true })
            .prepare_tools(&header(json!({ "id": "sess_plain", "cwd": "/work", "model": "claude-sonnet-4" })))
            .await
            .expect("prepared");
        assert_eq!(lead.tool_spec, json!("full"));
        assert!(!names(&lead).iter().any(|n| n == "agent" || n == "react"), "{:?}", names(&lead));

        let worker = |hidden: bool| async move {
            producer(Ok(false), Policy { hidden, no_delegation: false })
                .prepare_tools(&header(json!({
                    "id": "sess_w", "owner": "Agent", "agent": "explorer", "cwd": "/work", "model": "claude-sonnet-4",
                    "preset": "readonly", "schemaAllowedTools": ["read", "grep"],
                })))
                .await
                .expect("prepared")
        };
        let plain = worker(false).await;
        assert_eq!(plain.tool_spec, json!("full"));
        assert!(names(&plain).len() > 2 && !names(&plain).iter().any(|n| n == "react"), "{:?}", names(&plain));
        assert_eq!(names(&worker(true).await), ["grep", "read"]);
    }

    /// The definitions are the tools' own (`ToolSpec::definition`), and a skill list that cannot be
    /// collected is the error, not "no skills": the route change keeps the stored tools.
    #[tokio::test]
    async fn definitions_are_the_tools_own_and_an_uncollected_skill_list_is_an_error() {
        let prepared = producer(Ok(false), Policy { hidden: false, no_delegation: false })
            .prepare_tools(&header(json!({ "id": "sess_plain", "cwd": "/work", "model": "claude-sonnet-4", "preset": ["tools:readonly"] })))
            .await
            .expect("prepared");
        let read = prepared.tools.as_array().expect("tools").iter().find(|t| t["name"] == "read").expect("read");
        assert_eq!(read, &spec_of("read").definition());
        let failing = producer(Err("lane gone".into()), Policy { hidden: false, no_delegation: false });
        assert_eq!(failing.prepare_tools(&header(json!({ "cwd": "/work" }))).await.err().as_deref(), Some("lane gone"));
        assert!(failing.prepare(&header(json!({ "cwd": "/work" }))).await.is_none());
    }

    fn doc<'a>(prepared: &'a PreparedTools, name: &str) -> Option<&'a Value> {
        prepared.tools.as_array().expect("tools").iter().find(|t| t["name"] == name)
    }

    /// The tool's own variants: an agent's session holds the agent text of `git` and `task`
    /// (`bindAgentOwner`), a Lead the Lead's; a shortened MCP name carries `mcpToolName` and
    /// `mcpServerName` right after `name`, an unshortened one neither; a session of a scope the
    /// daemon has no server under sees no MCP tool (`_getMcpTools(mcpScopeId, cwd)`).
    #[tokio::test]
    async fn definitions_follow_the_owner_the_mcp_names_and_the_scope() {
        let rig = || producer(Ok(false), Policy { hidden: false, no_delegation: false });
        let worker = rig()
            .prepare_tools(&header(json!({ "id": "sess_w", "owner": "agent", "cwd": "/work", "model": "claude-sonnet-4" })))
            .await
            .expect("prepared");
        assert_eq!(doc(&worker, "git").map(|d| d["description"].clone()), Some(json!("git for agents.")));
        assert_eq!(doc(&worker, "task").map(|d| d["description"].clone()), Some(json!("task for agents.")));
        let lead = rig()
            .prepare_tools(&header(json!({ "id": agent_home_session_id("bot").unwrap(), "cwd": "/work", "model": "claude-sonnet-4" })))
            .await
            .expect("prepared");
        assert_eq!(doc(&lead, "git").map(|d| d["description"].clone()), Some(json!("git tool.")));

        let cut = doc(&lead, "mcp__beta__web_search_extra").expect("cut tool");
        let keys: Vec<&str> = cut.as_object().unwrap().keys().map(String::as_str).take(3).collect();
        assert_eq!(keys, ["name", "mcpToolName", "mcpServerName"]);
        assert_eq!((cut["mcpToolName"].clone(), cut["mcpServerName"].clone()), (json!("web_search_extra_long_name"), json!("beta")));
        let whole = doc(&lead, "mcp__alpha__zeta").expect("whole tool");
        assert!(whole.get("mcpToolName").is_none() && whole.get("mcpServerName").is_none(), "{whole}");

        for (scope, sees) in [(json!(null), true), (json!(""), true), (json!("global"), true), (json!("agent-runtime-7"), false)] {
            let prepared = rig()
                .prepare_tools(&header(json!({ "id": "sess_plain", "cwd": "/work", "model": "claude-sonnet-4", "mcpScopeId": scope })))
                .await
                .expect("prepared");
            assert_eq!(names(&prepared).iter().any(|n| n.starts_with("mcp__")), sees, "scope {scope}");
        }
    }
}
