//! `ToolDispatcher` (what `call_tool` runs its target through) over the tool registry and the
//! live session: the target meets the gate, approval wait, hooks, argument coercion and
//! PostToolUse a direct call of it would (`session/loop/tool-exec.mjs` `executeToolOwned`, which
//! Node reaches by projecting the `call_tool` onto its target in the loop).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::McpCatalog;
use mixdog_agent::env::NoGuards;
use mixdog_agent::env::NullObserver;
use mixdog_agent::env::PolicyGate;
use mixdog_agent::env::PolicyGateParts;
use mixdog_agent::env::ToolHooks;
use mixdog_agent::tools::Pipeline;
use mixdog_agent::tools::run_nested;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::LiveHeader;
use mixdog_core_ports::ports::gate::SessionGate;
use mixdog_core_session::session::SessionDirectory;
use mixdog_tools::orch::bridge::ToolDispatcher;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use serde_json::Value;
use tokio::sync::watch;

use crate::run_host::hooks::PostToolDispatch;
use crate::run_host::hooks::SessionToolHooks;
use crate::run_host::session_tools::header_scope;
use crate::run_host::turn_settings::SettingsMcp;
use crate::run_host::turn_settings::TurnSettings;

/// What the policy reads of a running session.
pub struct LiveSession {
    pub header: Arc<dyn LiveHeader>,
    pub surface: watch::Receiver<Arc<SessionSurface>>,
    pub grants: Arc<SessionGrants>,
}

/// The sessions that are running now.
pub trait LiveSessions: Send + Sync {
    fn session(&self, thread: &ThreadId) -> Option<LiveSession>;
}

impl LiveSessions for SessionDirectory {
    fn session(&self, thread: &ThreadId) -> Option<LiveSession> {
        let handle = self.handle(thread)?;
        Some(LiveSession { header: handle.live_header(), surface: handle.surface(), grants: handle.grants() })
    }
}

/// The process-wide parts of the pipeline: one value, shared by every session's bridged calls.
pub struct PipelineDispatcher {
    sessions: Arc<dyn LiveSessions>,
    policy: Arc<ToolPolicy>,
    connectors: Arc<dyn ConnectorPermissions>,
    tools: Arc<dyn ToolResolver>,
    gate_env: Arc<dyn GateEnv>,
    post_tool: Arc<dyn PostToolDispatch>,
    /// The turn settings whose MCP catalog a bridged MCP call refreshes before it is judged.
    mcp: Option<Arc<dyn TurnSettings>>,
}

impl PipelineDispatcher {
    /// A bridged MCP call refreshes the thread's MCP catalog through `settings`, as a direct call does.
    #[must_use]
    pub fn with_mcp(mut self, settings: Arc<dyn TurnSettings>) -> Self {
        self.mcp = Some(settings);
        self
    }

    /// `policy`, `connectors`, `tools` and `gate_env` are the very values the turn's own gate is
    /// built from (`TurnPath`'s `policy`, `connectors`, `resolver` and `HostGateEnv`).
    pub fn new(
        sessions: Arc<dyn LiveSessions>,
        policy: Arc<ToolPolicy>,
        connectors: Arc<dyn ConnectorPermissions>,
        tools: Arc<dyn ToolResolver>,
        gate_env: Arc<dyn GateEnv>,
        post_tool: Arc<dyn PostToolDispatch>,
    ) -> Self {
        Self { sessions, policy, connectors, tools, gate_env, post_tool, mcp: None }
    }
}

#[async_trait]
impl ToolDispatcher for PipelineDispatcher {
    async fn dispatch(&self, ctx: &ToolContext, name: &str, arguments: Value) -> ToolOutcome {
        let Some(live) = self.sessions.session(&ctx.thread_id) else {
            return Err(ToolError::new(
                ToolErrorCode::Unavailable { capability: "session".to_owned(), reason: "closed".to_owned() },
                format!("Error: session {} is not running", ctx.thread_id.as_str()),
            ));
        };
        let observer = Arc::new(NullObserver);
        let guards = Arc::new(NoGuards);
        // The calling session's MCP scope: a nested MCP call resolves against its own servers.
        let scope = header_scope(&live.header.header()).map(str::to_owned);
        let session = Arc::new(SessionGate::new(ctx.thread_id.clone(), live.header, live.surface, self.gate_env.clone()));
        let gate = PolicyGate::new(PolicyGateParts {
            policy: self.policy.clone(),
            connectors: self.connectors.clone(),
            session,
            tools: self.tools.clone(),
            grants: live.grants,
            approvals: ctx.approvals.clone(),
            observer: observer.clone(),
            guards: guards.clone(),
            thread_id: ctx.thread_id.clone(),
            cwd: ctx.cwd.as_path().to_path_buf(),
            cancel: ctx.cancel.clone(),
        });
        let hooks = SessionToolHooks::new(ctx.thread_id.as_str(), ctx.cwd.as_path(), self.post_tool.clone(), true);
        let hooks: Arc<dyn ToolHooks> = Arc::new(hooks);
        let mcp = self.mcp.clone().map(|settings| Arc::new(SettingsMcp { settings, thread: ctx.thread_id.clone() }) as Arc<dyn McpCatalog>);
        let pipeline = Pipeline { gate: Arc::new(gate), hooks: Some(hooks), observer, guards, mcp };
        run_nested(&pipeline, self.tools.as_ref(), scope.as_deref(), ctx, name, arguments).await
    }
}
