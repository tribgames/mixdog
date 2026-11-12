//! The approval pipeline of one tool call (T §1.2 steps 2–4):
//! `PreToolUse hook → human gate → approval → connector approval`.
//!
//! Which calls ask by default is the gate's rule ([`super::gate`]); this file
//! orders the layers, asks through the session's [`ApprovalGate`], records the
//! answer and stores what the person chose to remember. Every failure of a
//! policy layer denies the call (fail closed); a call cancelled while it waits
//! returns `Cancelled`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::HumanGateResponse;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::action::GrantKey;
use super::card::CardEnricher;
use super::card::apply_edited_args;
use super::gate::AskPlan;
use super::gate::AskRequest;
use super::gate::GateAudit;
use super::gate::GateCall;
use super::gate::GateCx;
use super::gate::GateVerdict;
use super::gate::HookAction;
use super::gate::PolicySettings;
use super::gate::SessionFacts;
use super::gate::decide;
use super::grants::GrantStore;
use super::grants::SESSION_GRANTED_DECISION;
use super::run_policy::RUN_FORBIDDEN_REASON;
use super::run_policy::forbidden_in_run;
use super::session_grants::SessionGrants;
use super::surface::SessionSurface;

/// `ask_user` and `handoff_user` are themselves the user prompt; they never
/// go through the ordinary approval gate.
pub const USER_PROMPT_TOOLS: [&str; 2] = ["ask_user", "handoff_user"];

pub const CONNECTOR_APPROVAL_REASON: &str =
    "This connector tool is set to ask before it runs for this agent.";

/// A hook call as the hook runner sees it.
pub struct HookCall<'a> {
    pub call_id: &'a ToolCallId,
    pub thread_id: &'a ThreadId,
    pub name: &'a str,
    pub args: &'a Value,
    pub cwd: &'a Path,
}

/// A PreToolUse decision. `name` and `args` take effect on `Ask` and `Rewrite`.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct HookDecision {
    pub action: HookAction,
    pub reason: Option<String>,
    pub name: Option<String>,
    pub args: Option<Value>,
}

/// A hook that could not decide (spawn failure, timeout, bad output).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct HookFailure(pub String);

#[async_trait]
pub trait PreToolHook: Send + Sync {
    async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure>;
}

/// The registry, as far as the policy needs it: the tool a name resolves to. An MCP tool resolves
/// against `scope`, the calling session's MCP scope (`session.mcpScopeId`); a session that holds none
/// resolves no MCP tool, and no other session's server is ever consulted.
pub trait ToolResolver: Send + Sync {
    fn resolve(&self, scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>>;
}

/// Per-agent connector tool permissions.
#[async_trait]
pub trait ConnectorPermissions: Send + Sync {
    /// Whether the agent set the connector tool to `needs_approval`.
    fn needs_approval(&self, connector_agent_id: &str, tool: &str) -> bool;
    /// Whether the agent's connector policy sets the tool to `disabled`
    /// (`agentMcpToolPermission`; a tool of a server it does not mount counts).
    fn disabled(&self, connector_agent_id: &str, tool: &str) -> bool;
    /// Whether the project the thread runs in switched the connector tool off.
    fn project_disabled(&self, thread: &ThreadId, tool: &str) -> bool;
    /// Saves "always allow" for the bot's own entry of the tool; false when it
    /// could not be saved.
    async fn allow_always(&self, bot_id: &str, tool: &str) -> bool;
}

pub struct AuthorizeRequest<'a> {
    pub call_id: &'a ToolCallId,
    pub thread_id: &'a ThreadId,
    pub name: &'a str,
    pub args: Value,
    pub cwd: &'a Path,
    pub facts: &'a SessionFacts,
    pub surface: &'a SessionSurface,
    /// The name the call has in the schema when routing renamed it.
    pub schema_name: Option<&'a str>,
    pub settings: PolicySettings,
    /// The connector account the call is bound to; the card names it.
    pub account: Option<&'a str>,
    pub session_grants: &'a SessionGrants,
    pub tools: &'a dyn ToolResolver,
    pub approvals: &'a dyn ApprovalGate,
    pub cancel: &'a CancellationToken,
}

/// The call as it will run.
#[derive(Clone, PartialEq, Debug)]
pub struct Authorized {
    pub name: String,
    pub args: Value,
    /// "Always allow" for a connector tool was chosen but could not be saved:
    /// this call runs, the next one asks again.
    pub allow_not_saved: bool,
}

pub struct ToolPolicy {
    hook: Option<Arc<dyn PreToolHook>>,
    store: Arc<dyn GrantStore>,
    connectors: Arc<dyn ConnectorPermissions>,
    enricher: Option<Arc<dyn CardEnricher>>,
    /// Development only (`policy-observer`): told the gate's verdict of every call the pipeline judges, before it acts on it,
    /// and may replace it (a replay presenting a recorded gate the product's own sessions cannot produce).
    #[cfg(feature = "policy-observer")]
    observer: Option<Arc<dyn Fn(&mut GateVerdict) + Send + Sync>>,
}

fn denied(name: &str, code: ToolErrorCode, detail: &str) -> ToolError {
    ToolError::new(code, format!("Error: tool \"{name}\" denied{detail}"))
}

fn denied_by_hook(name: &str, reason: Option<&str>) -> ToolError {
    let reason = reason
        .filter(|reason| !reason.is_empty())
        .map(|reason| format!(": {reason}"))
        .unwrap_or_default();
    denied(name, ToolErrorCode::DeniedByHook, &format!(" by hook{reason}"))
}

fn check_failed(name: &str, message: &str) -> ToolError {
    denied(
        name,
        ToolErrorCode::DeniedByPolicy {
            rule: "check-failed".into(),
        },
        &format!(": PreToolUse policy check failed: {message}"),
    )
}

fn cancelled() -> ToolError {
    ToolError::new(ToolErrorCode::Cancelled, "Error: cancelled")
}

/// `formatMissingToolApprovalUiDenial(toolName, askReason)` (`tool-helpers.mjs:187`).
fn missing_approval_ui_denial(name: &str, ask_reason: &str) -> String {
    let reason = mixdog_js::js_trim(if ask_reason.is_empty() { "approval requested by hook" } else { ask_reason });
    let name = if name.is_empty() { "tool" } else { name };
    let reason = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
    format!("Error: tool \"{name}\" denied by hook: approval required but no approval UI is available{reason}")
}

fn remember_name(scope: ApprovalRemember) -> &'static str {
    match scope {
        ApprovalRemember::Once => "once",
        ApprovalRemember::Session => "session",
        ApprovalRemember::Agent => "agent",
        ApprovalRemember::Always => "always",
    }
}

fn response_name(response: HumanGateResponse) -> &'static str {
    match response {
        HumanGateResponse::Approve => "approve",
        HumanGateResponse::Deny => "deny",
        HumanGateResponse::EditAndApprove => "edit-and-approve",
        HumanGateResponse::ProvideSecret => "provide-secret",
        HumanGateResponse::Skip => "skip",
        HumanGateResponse::Done => "done",
    }
}

/// What the person (or the run policy) answered.
struct Answer {
    remember: Option<ApprovalRemember>,
    edited_args: Option<BTreeMap<String, String>>,
}

struct AskSpec<'a> {
    /// Effective tool name, as the card shows it.
    name: &'a str,
    args: &'a Value,
    reason: &'a str,
    request: Option<&'a AskRequest>,
    /// Present for asks that are audited and may store a grant.
    audit: Option<&'a GateAudit>,
    account: Option<&'a str>,
}

impl ToolPolicy {
    pub fn new(
        store: Arc<dyn GrantStore>,
        connectors: Arc<dyn ConnectorPermissions>,
    ) -> Self {
        Self {
            hook: None,
            store,
            connectors,
            enricher: None,
            #[cfg(feature = "policy-observer")]
            observer: None,
        }
    }

    /// Development only (`policy-observer`): `observer` is told the gate's verdict of every call before the pipeline acts on
    /// it, and the pipeline acts on the verdict as `observer` leaves it.
    #[cfg(feature = "policy-observer")]
    pub fn with_observer(mut self, observer: impl Fn(&mut GateVerdict) + Send + Sync + 'static) -> Self {
        self.observer = Some(Arc::new(observer));
        self
    }

    pub fn with_hook(mut self, hook: Arc<dyn PreToolHook>) -> Self {
        self.hook = Some(hook);
        self
    }

    pub fn with_enricher(mut self, enricher: Arc<dyn CardEnricher>) -> Self {
        self.enricher = Some(enricher);
        self
    }

    /// Runs the pipeline for one call. `Ok` carries the call as it will run
    /// (a hook or the card may have rewritten it); `Err` is the denial.
    pub async fn authorize(&self, rq: AuthorizeRequest<'_>) -> Result<Authorized, ToolError> {
        let name = rq.name;
        // The session's own tool policy refuses before any hook or approval. What the
        // agent's connectors and the project switched off depends on the tool, so it is
        // read here per call (under the name the tool has in the schema).
        let schema = rq.schema_name.unwrap_or(name);
        let mut surface = rq.surface.clone();
        surface.connector_disabled = self.connectors.disabled(&rq.facts.connector_agent_id, schema);
        surface.project_disabled = self.connectors.project_disabled(rq.thread_id, schema);
        if let Some(refusal) = surface.refusal_for_call(name, rq.schema_name, &rq.args) {
            return Err(refusal);
        }
        if USER_PROMPT_TOOLS.contains(&name) {
            return Ok(Authorized {
                name: name.to_owned(),
                args: rq.args,
                allow_not_saved: false,
            });
        }

        let decision = self.run_hook(&rq).await?.unwrap_or_default();
        if decision.action == HookAction::Deny {
            return Err(denied_by_hook(name, decision.reason.as_deref()));
        }
        // Judged as the call will run: only a rewriting decision changes name/args.
        let rewriting = matches!(decision.action, HookAction::Ask | HookAction::Rewrite);
        let mut call_name = name.to_owned();
        let mut call_args = rq.args.clone();
        if rewriting {
            if let Some(renamed) = decision.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                call_name = renamed.to_owned();
            }
            if let Some(args) = decision.args.as_ref().filter(|args| args.is_object()) {
                call_args = args.clone();
            }
        }

        let kind = rq
            .tools
            .resolve(rq.surface.mcp_scope.as_deref(), &call_name)
            .and_then(|tool| tool.outbound_kind(&call_args));
        let cx = GateCx {
            facts: rq.facts,
            settings: rq.settings,
            store: self.store.as_ref(),
            session_grants: rq.session_grants,
            enricher: self.enricher.as_deref(),
            mcp_scope: rq.surface.mcp_scope.as_deref(),
        };
        let verdict = decide(
            &cx,
            &GateCall {
                name: &call_name,
                args: &call_args,
                kind,
                hook: decision.action,
                hook_reason: decision.reason.as_deref(),
            },
        )
        .await
        .map_err(|error| check_failed(name, &error.0))?;
        #[cfg(feature = "policy-observer")]
        let verdict = {
            let mut verdict = verdict;
            if let Some(observer) = &self.observer {
                observer(&mut verdict);
            }
            verdict
        };

        let mut outbound_approved = false;
        match verdict {
            GateVerdict::Run { remembered } => outbound_approved = remembered,
            GateVerdict::Deny { rule, reason } => {
                return Err(denied(
                    name,
                    ToolErrorCode::DeniedByPolicy {
                        rule: rule.name().into(),
                    },
                    &format!(" by hook: {reason}"),
                ));
            }
            GateVerdict::Ask(plan) => {
                let AskPlan {
                    reason,
                    request,
                    audit,
                } = *plan;
                let account = (call_name == name).then_some(rq.account).flatten();
                let answer = self
                    .ask(
                        &rq,
                        AskSpec {
                            name: &call_name,
                            args: &call_args,
                            reason: &reason,
                            request: Some(&request),
                            audit: Some(&audit),
                            account,
                        },
                    )
                    .await?;
                if let AskRequest::Outbound { card, .. } = &request {
                    // The user approved this very call on the richer outbound card.
                    outbound_approved = true;
                    if let Some(edited) = &answer.edited_args {
                        call_args = apply_edited_args(&call_args, edited, &card.editable);
                    }
                }
            }
        }

        let allow_not_saved = self
            .connector_approval(&rq, &call_name, &call_args, outbound_approved)
            .await?;
        Ok(Authorized {
            name: call_name,
            args: call_args,
            allow_not_saved,
        })
    }

    async fn run_hook(&self, rq: &AuthorizeRequest<'_>) -> Result<Option<HookDecision>, ToolError> {
        let Some(hook) = &self.hook else {
            return Ok(None);
        };
        let call = HookCall {
            call_id: rq.call_id,
            thread_id: rq.thread_id,
            name: rq.name,
            args: &rq.args,
            cwd: rq.cwd,
        };
        tokio::select! {
            () = rq.cancel.cancelled() => Err(cancelled()),
            decided = hook.pre_tool(&call) => decided.map_err(|failure| check_failed(rq.name, &failure.0)),
        }
    }

    /// A connector tool a bot's own session runs, and the bot set to
    /// `needs_approval`, asks again here unless the outbound card already
    /// approved this very call.
    async fn connector_approval(
        &self,
        rq: &AuthorizeRequest<'_>,
        name: &str,
        args: &Value,
        outbound_approved: bool,
    ) -> Result<bool, ToolError> {
        let facts = rq.facts;
        if outbound_approved
            || facts.acting_bot.is_none()
            || rq.settings.allow_all_actions
            || !self
                .connectors
                .needs_approval(&facts.connector_agent_id, name)
        {
            return Ok(false);
        }
        // "Always allow" is offered only to the contact bot that is acting, for
        // its own policy entry of this one tool: never another bot or Mixy.
        let bot = facts
            .contact_bot
            .as_deref()
            .filter(|bot| *bot == facts.connector_agent_id);
        let request = bot.map(|bot| AskRequest::Approval {
            agent_id: bot.to_owned(),
            remember: vec![ApprovalRemember::Once, ApprovalRemember::Agent],
            grant_action: None,
            action_kind: None,
        });
        let answer = self
            .ask(
                rq,
                AskSpec {
                    name,
                    args,
                    reason: CONNECTOR_APPROVAL_REASON,
                    request: request.as_ref(),
                    audit: None,
                    account: rq.account.filter(|_| name == rq.name),
                },
            )
            .await?;
        match bot {
            Some(bot) if answer.remember == Some(ApprovalRemember::Agent) => {
                Ok(!self.connectors.allow_always(bot, name).await)
            }
            _ => Ok(false),
        }
    }

    async fn ask(&self, rq: &AuthorizeRequest<'_>, spec: AskSpec<'_>) -> Result<Answer, ToolError> {
        // A schedule or webhook run never asks: saving it was the user's grant.
        if rq.facts.run.is_some_and(|run| run.is_granted()) {
            let forbidden = matches!(
                spec.request,
                Some(AskRequest::Outbound { card, .. }) if forbidden_in_run(card.category)
            );
            let decision = if forbidden { "run-forbidden" } else { "run-allowed" };
            if let Some(audit) = spec.audit {
                self.audit(audit, decision, "").await.map_err(|e| check_failed(spec.name, &e))?;
            }
            if forbidden {
                return Err(denied(
                    spec.name,
                    ToolErrorCode::DeniedByPolicy {
                        rule: "run-forbidden".into(),
                    },
                    &format!(
                        ": {RUN_FORBIDDEN_REASON} Report this to the user; do not retry it or reach the same result another way."
                    ),
                ));
            }
            return Ok(Answer {
                remember: None,
                edited_args: None,
            });
        }

        let resolution = rq.approvals.request(self.approval_ask(rq, &spec)).await;
        let (approved, response, remember, device, edited_args, detail, timed_out) = match resolution {
            ApprovalResolution::Decided { decision, device, .. } => (
                decision.approved,
                decision.response.map(response_name),
                decision.remember,
                device,
                decision.edited_args,
                decision.reason.unwrap_or_default(),
                false,
            ),
            ApprovalResolution::TimedOut { .. } => (
                false,
                None,
                None,
                String::new(),
                None,
                "approval timed out".to_owned(),
                true,
            ),
            ApprovalResolution::Withdrawn { .. } => (
                false,
                None,
                None,
                String::new(),
                None,
                "approval withdrawn".to_owned(),
                false,
            ),
            // The run was stopped while it waited: nobody answered.
            ApprovalResolution::Interrupted { .. } | ApprovalResolution::Cancelled { .. } => {
                return Err(cancelled());
            }
            // Nobody could be asked (`resolvePreToolAskApproval` without a hook, `tool-helpers.mjs:218`): denied with
            // no approval, which `before-hook.mjs` still records, as a plain `deny` (`recordHumanDecision(gate, undefined)`).
            ApprovalResolution::Unavailable { .. } => {
                if let Some(audit) = spec.audit {
                    self.record_decision(rq, audit, false, "deny", None, "")
                        .await
                        .map_err(|error| check_failed(spec.name, &error))?;
                }
                return Err(ToolError::new(
                    ToolErrorCode::DeniedByHook,
                    missing_approval_ui_denial(spec.name, spec.reason),
                ));
            }
        };

        if let Some(audit) = spec.audit {
            let decision = if timed_out {
                "timeout"
            } else {
                response.unwrap_or(if approved { "approve" } else { "deny" })
            };
            self.record_decision(rq, audit, approved && !timed_out, decision, remember, &device)
                .await
                .map_err(|error| check_failed(spec.name, &error))?;
        }

        if !approved {
            let detail = mixdog_js::js_trim(&detail);
            let detail = if detail.is_empty() { mixdog_js::js_trim(spec.reason) } else { detail };
            let detail = detail.trim_end_matches(|c: char| c == '.' || mixdog_js::is_js_space(c));
            let detail = if detail.is_empty() { "not approved" } else { detail };
            return Err(ToolError::new(
                ToolErrorCode::PermissionDenied,
                format!(
                    "Error: tool \"{}\" was not approved: {detail}. Do not retry it or reach the same result another way; report it.",
                    spec.name
                ),
            ));
        }
        Ok(Answer {
            remember,
            edited_args,
        })
    }

    fn approval_ask(&self, rq: &AuthorizeRequest<'_>, spec: &AskSpec<'_>) -> ApprovalAsk {
        let mut payload = json!({
            "name": spec.name,
            "args": spec.args,
            "cwd": rq.cwd.display().to_string(),
            "reason": spec.reason,
        });
        let fields = payload.as_object_mut().expect("object");
        let (remember, action_kind): (Vec<ApprovalRemember>, Option<ActionKind>) = match spec.request {
            Some(AskRequest::Approval {
                agent_id,
                remember,
                grant_action,
                action_kind,
            }) => {
                fields.insert("kind".into(), "approval".into());
                fields.insert("agentId".into(), agent_id.clone().into());
                if let Some(action) = grant_action {
                    fields.insert("grantAction".into(), action.render().into());
                }
                (remember.clone(), *action_kind)
            }
            Some(AskRequest::Outbound {
                agent_id,
                card,
                remember,
            }) => {
                fields.insert("kind".into(), "outbound".into());
                fields.insert("agentId".into(), agent_id.clone().into());
                fields.insert("outbound".into(), card.to_json());
                (remember.clone(), Some(card.category))
            }
            None => (Vec::new(), None),
        };
        if spec.request.is_some() {
            fields.insert(
                "remember".into(),
                remember.iter().map(|s| remember_name(*s)).collect::<Vec<_>>().into(),
            );
        }
        if let Some(account) = spec.account.filter(|account| !mixdog_js::js_trim(account).is_empty()) {
            fields.insert("account".into(), mixdog_js::js_trim(account).into());
        }
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: Some(rq.call_id.clone()),
            tool: Some(spec.name.to_owned()),
            action_kind,
            reason: Some(spec.reason.to_owned()),
            payload,
            remember: remember
                .into_iter()
                .filter(|scope| *scope != ApprovalRemember::Once)
                .collect(),
            expires_after: None,
        }
    }

    async fn audit(&self, audit: &GateAudit, decision: &str, device: &str) -> Result<(), String> {
        self.store
            .record_audit(audit.entry(decision, device))
            .await
            .map_err(|error| error.0)
    }

    /// Audits one answered request and stores its remembered grant: "always"
    /// (`agent`/`always`) in the store, "this session" in the session's own
    /// grants. A denial, a timeout and a scope the request did not offer store
    /// nothing.
    async fn record_decision(
        &self,
        rq: &AuthorizeRequest<'_>,
        audit: &GateAudit,
        approved: bool,
        decision: &str,
        remember: Option<ApprovalRemember>,
        device: &str,
    ) -> Result<(), String> {
        let mut granted = false;
        if let (true, Some(action), Some(scope)) = (approved, &audit.action, remember)
            && audit.remember.contains(&scope)
        {
            granted = self.store_grant(rq, audit, action, scope, device).await?;
        }
        self.audit(audit, decision, device).await?;
        if granted {
            let decision = match remember {
                Some(ApprovalRemember::Session) => SESSION_GRANTED_DECISION,
                _ => "granted",
            };
            self.audit(audit, decision, device).await?;
        }
        Ok(())
    }

    async fn store_grant(
        &self,
        rq: &AuthorizeRequest<'_>,
        audit: &GateAudit,
        action: &GrantKey,
        scope: ApprovalRemember,
        device: &str,
    ) -> Result<bool, String> {
        match scope {
            ApprovalRemember::Once => Ok(false),
            ApprovalRemember::Session => Ok(rq.facts.attended()
                && rq
                    .facts
                    .life
                    .as_deref()
                    .is_some_and(|life| rq.session_grants.grant(&audit.agent_id, action, life))),
            ApprovalRemember::Agent | ApprovalRemember::Always => self
                .store
                .grant(&audit.agent_id, action, scope, device)
                .await
                .map_err(|error| error.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::tool::ToolAnnotations;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolOutcome;
    use mixdog_core_api::domain::tool::ToolOutput;
    use mixdog_core_api::domain::tool::ToolSpec;
    use mixdog_protocol::ConnectionKind;
    use mixdog_protocol::ToolApprovalDecision;

    use super::super::grants::MemoryGrantStore;
    use super::super::grants::PermissionMode;
    use super::super::run_policy::RunKind;
    use super::*;

    struct TestTool {
        spec: ToolSpec,
        kind: Option<ActionKind>,
    }

    #[async_trait]
    impl Tool for TestTool {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }

        fn outbound_kind(&self, _args: &Value) -> Option<ActionKind> {
            self.kind
        }

        async fn call(&self, _ctx: &ToolContext, _args: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    #[derive(Default)]
    struct Tools(Vec<(String, Arc<dyn Tool>)>);

    impl Tools {
        fn with(mut self, name: &str, kind: Option<ActionKind>) -> Self {
            let spec = ToolSpec {
                name: name.into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: String::new(),
                input_schema: json!({}),
                annotations: ToolAnnotations::default(),
                parallel_safe: true,
                exclusive_with: Vec::new(),
            };
            self.0.push((name.into(), Arc::new(TestTool { spec, kind })));
            self
        }
    }

    impl ToolResolver for Tools {
        fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
            self.0.iter().find(|(n, _)| n == name).map(|(_, t)| t.clone())
        }
    }

    #[derive(Default)]
    struct Connectors {
        needs: Vec<String>,
        disabled: Vec<String>,
        project_off: Vec<String>,
        saved: Mutex<Vec<String>>,
        save_works: bool,
    }

    #[async_trait]
    impl ConnectorPermissions for Connectors {
        fn needs_approval(&self, _agent: &str, tool: &str) -> bool {
            self.needs.iter().any(|n| n == tool)
        }

        fn disabled(&self, _agent: &str, tool: &str) -> bool {
            self.disabled.iter().any(|n| n == tool)
        }

        fn project_disabled(&self, _thread: &ThreadId, tool: &str) -> bool {
            self.project_off.iter().any(|n| n == tool)
        }

        async fn allow_always(&self, bot_id: &str, tool: &str) -> bool {
            self.saved.lock().expect("saved").push(format!("{bot_id}/{tool}"));
            self.save_works
        }
    }

    struct FixedHook(Result<Option<HookDecision>, HookFailure>);

    #[async_trait]
    impl PreToolHook for FixedHook {
        async fn pre_tool(&self, _call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
            self.0.clone()
        }
    }

    fn decided(approved: bool, remember: Option<ApprovalRemember>) -> ApprovalResolution {
        ApprovalResolution::Decided {
            decision: ToolApprovalDecision {
                approved,
                reason: None,
                answers: None,
                reply: None,
                response: None,
                edited_args: None,
                remember,
                scope: None,
            },
            device: "Pixel".into(),
            connection_kind: ConnectionKind::Phone,
            at: 0,
        }
    }

    fn bot() -> SessionFacts {
        SessionFacts {
            agent_id: "mailer".into(),
            acting_bot: Some("mailer".into()),
            contact_bot: Some("mailer".into()),
            connector_agent_id: "mailer".into(),
            run: None,
            life: Some("life".into()),
        }
    }

    struct Harness {
        store: Arc<MemoryGrantStore>,
        connectors: Arc<Connectors>,
        gate: MockApprovalGate,
        grants: SessionGrants,
        tools: Tools,
        cancel: CancellationToken,
    }

    impl Harness {
        fn new(tools: Tools) -> Self {
            Self {
                store: Arc::new(MemoryGrantStore::default()),
                connectors: Arc::new(Connectors { save_works: true, ..Connectors::default() }),
                gate: MockApprovalGate::default(),
                grants: SessionGrants::default(),
                tools,
                cancel: CancellationToken::new(),
            }
        }

        fn answer(&self, resolution: ApprovalResolution) {
            self.gate.script.lock().expect("script").push_back(resolution);
        }

        fn policy(&self, hook: Option<Arc<dyn PreToolHook>>) -> ToolPolicy {
            let policy = ToolPolicy::new(self.store.clone(), self.connectors.clone());
            match hook {
                Some(hook) => policy.with_hook(hook),
                None => policy,
            }
        }

        async fn run(
            &self,
            policy: &ToolPolicy,
            facts: &SessionFacts,
            name: &str,
            args: Value,
        ) -> Result<Authorized, ToolError> {
            policy
                .authorize(AuthorizeRequest {
                    call_id: &ToolCallId::from("call-1"),
                    thread_id: &ThreadId::from("thread-1"),
                    name,
                    args,
                    cwd: Path::new("work"),
                    facts,
                    surface: &SessionSurface::default(),
                    schema_name: None,
                    settings: PolicySettings::default(),
                    account: Some("work@example.com"),
                    session_grants: &self.grants,
                    tools: &self.tools,
                    approvals: &self.gate,
                    cancel: &self.cancel,
                })
                .await
        }

        fn asks(&self) -> Vec<ApprovalAsk> {
            self.gate.asks.lock().expect("asks").clone()
        }
    }

    fn comment_args() -> Value {
        json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "draft"})
    }

    fn github() -> Tools {
        Tools::default().with("github", Some(ActionKind::Comment))
    }

    fn allow_hook() -> Option<Arc<dyn PreToolHook>> {
        Some(Arc::new(FixedHook(Ok(Some(HookDecision::default())))))
    }

    /// A resolver that records the scope each lookup was made in.
    struct Recorder(std::sync::Mutex<Vec<Option<String>>>);

    impl ToolResolver for Recorder {
        fn resolve(&self, scope: Option<&str>, _name: &str) -> Option<Arc<dyn Tool>> {
            self.0.lock().expect("scopes").push(scope.map(str::to_owned));
            None
        }
    }

    /// The call's tool is looked up in the calling session's MCP scope (`sessionRef.mcpScopeId`,
    /// `tool-exec/dispatch.mjs:57-59`), so another session's server never supplies its metadata; a
    /// session that holds no scope looks in none.
    #[tokio::test]
    async fn the_tool_is_resolved_in_the_calling_sessions_scope() {
        let h = Harness::new(Tools::default());
        let recorder = Recorder(std::sync::Mutex::default());
        let policy = h.policy(allow_hook());
        for scope in [Some("s1"), Some("s2"), None] {
            let surface = SessionSurface { mcp_scope: scope.map(str::to_owned), ..SessionSurface::default() };
            policy
                .authorize(AuthorizeRequest {
                    call_id: &ToolCallId::from("call-1"),
                    thread_id: &ThreadId::from("thread-1"),
                    name: "mcp__a__b",
                    args: json!({}),
                    cwd: Path::new("work"),
                    facts: &bot(),
                    surface: &surface,
                    schema_name: None,
                    settings: PolicySettings::default(),
                    account: None,
                    session_grants: &h.grants,
                    tools: &recorder,
                    approvals: &h.gate,
                    cancel: &h.cancel,
                })
                .await
                .expect("runs");
        }
        assert_eq!(*recorder.0.lock().expect("scopes"), [Some("s1".to_owned()), Some("s2".to_owned()), None]);
    }
    #[tokio::test]
    async fn connector_and_project_switches_refuse_per_called_tool() {
        let mut h = Harness::new(Tools::default().with("mcp__a__b", None).with("mcp__a__c", None));
        h.connectors = Arc::new(Connectors {
            disabled: vec!["mcp__a__b".into()],
            project_off: vec!["mcp__a__c".into()],
            save_works: true,
            ..Connectors::default()
        });
        let policy = h.policy(allow_hook());
        let off = h.run(&policy, &bot(), "mcp__a__b", json!({})).await.expect_err("agent off");
        assert_eq!(off.message_for_model, "Error: tool \"mcp__a__b\" is not available to this agent.");
        let project = h.run(&policy, &bot(), "mcp__a__c", json!({})).await.expect_err("project off");
        assert_eq!(project.message_for_model, "Error: tool \"mcp__a__c\" is switched off in this project.");
        h.run(&policy, &bot(), "mcp__a__d", json!({})).await.expect("other tools run");
    }

    #[tokio::test]
    async fn an_outbound_call_asks_even_when_hooks_allow_and_edits_replace_the_args() {
        let h = Harness::new(github());
        let mut decision = decided(true, None);
        if let ApprovalResolution::Decided { decision: d, .. } = &mut decision {
            d.response = Some(HumanGateResponse::EditAndApprove);
            d.edited_args = Some(BTreeMap::from([
                ("body".to_owned(), "final text".to_owned()),
                ("repo".to_owned(), "evil/x".to_owned()),
            ]));
        }
        h.answer(decision);
        let got = h.run(&h.policy(allow_hook()), &bot(), "github", comment_args()).await.expect("ok");
        assert_eq!(
            got.args,
            json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "final text"})
        );
        let asks = h.asks();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].action_kind, Some(ActionKind::Comment));
        assert_eq!(asks[0].payload["kind"], "outbound");
        assert_eq!(asks[0].payload["outbound"]["payload"], "draft");
        assert_eq!(asks[0].payload["account"], "work@example.com");
        assert_eq!(
            asks[0].remember,
            [ApprovalRemember::Session, ApprovalRemember::Agent]
        );
        assert_eq!(h.store.audit()[0].decision, "edit-and-approve");
    }

    #[tokio::test]
    async fn an_allowing_hook_cannot_swap_the_outbound_call() {
        let h = Harness::new(github().with("shell", None));
        h.answer(decided(true, None));
        let hook = FixedHook(Ok(Some(HookDecision {
            action: HookAction::Allow,
            name: Some("shell".into()),
            args: Some(json!({"action": "issue.comment", "repo": "evil/x", "number": 9, "body": "other"})),
            reason: None,
        })));
        let got = h
            .run(&h.policy(Some(Arc::new(hook))), &bot(), "github", comment_args())
            .await
            .expect("ok");
        assert_eq!((got.name.as_str(), got.args), ("github", comment_args()));
        assert_eq!(h.asks()[0].payload["outbound"]["payload"], "draft");
    }

    #[tokio::test]
    async fn a_denied_card_stops_the_call_and_stores_nothing() {
        let h = Harness::new(github());
        h.answer(decided(false, Some(ApprovalRemember::Agent)));
        let err = h.run(&h.policy(None), &bot(), "github", comment_args()).await.expect_err("denied");
        assert_eq!(err.code, ToolErrorCode::PermissionDenied);
        assert_eq!(
            err.message_for_model,
            "Error: tool \"github\" was not approved: This sends or posts outside Mixdog; it needs your approval. Do not retry it or reach the same result another way; report it."
        );
        assert_eq!(
            h.store.mode_for("mailer", &GrantKey::Kind(ActionKind::Comment), false).await,
            Ok(PermissionMode::Ask)
        );
    }

    #[tokio::test]
    async fn dont_ask_again_stores_a_grant_that_answers_the_next_call() {
        let h = Harness::new(github());
        h.answer(decided(true, Some(ApprovalRemember::Agent)));
        let policy = h.policy(None);
        h.run(&policy, &bot(), "github", comment_args()).await.expect("first");
        assert_eq!(
            h.store.mode_for("mailer", &GrantKey::Kind(ActionKind::Comment), false).await,
            Ok(PermissionMode::Allow)
        );
        h.run(&policy, &bot(), "github", comment_args()).await.expect("second");
        assert_eq!(h.asks().len(), 1);
        let decisions: Vec<_> = h.store.audit().into_iter().map(|e| e.decision).collect();
        assert_eq!(decisions, ["approve", "granted", "remembered"]);
    }

    #[tokio::test]
    async fn allow_for_this_session_is_kept_in_the_session_and_lapses_with_its_life() {
        let h = Harness::new(github());
        h.answer(decided(true, Some(ApprovalRemember::Session)));
        let policy = h.policy(None);
        h.run(&policy, &bot(), "github", comment_args()).await.expect("first");
        h.run(&policy, &bot(), "github", comment_args()).await.expect("second");
        assert_eq!(h.asks().len(), 1);
        h.answer(decided(true, None));
        let reset = SessionFacts { life: Some("life-2".into()), ..bot() };
        h.run(&policy, &reset, "github", comment_args()).await.expect("after reset");
        assert_eq!(h.asks().len(), 2);
        let decisions: Vec<_> = h.store.audit().into_iter().map(|e| e.decision).collect();
        assert_eq!(decisions, ["approve", "session-granted", "session-remembered", "approve"]);
    }

    #[tokio::test]
    async fn a_scope_the_request_did_not_offer_stores_nothing() {
        let tools = Tools::default().with("mcp__shop__buy", Some(ActionKind::Payment));
        let h = Harness::new(tools);
        h.answer(decided(true, Some(ApprovalRemember::Agent)));
        h.run(&h.policy(None), &bot(), "mcp__shop__buy", json!({"amount": 5})).await.expect("ok");
        assert_eq!(
            h.store.mode_for("mailer", &GrantKey::Kind(ActionKind::Payment), false).await,
            Ok(PermissionMode::Ask)
        );
        assert_eq!(h.asks()[0].action_kind, Some(ActionKind::Payment));
    }

    #[tokio::test]
    async fn a_hook_deny_and_a_failing_hook_both_stop_the_call() {
        let h = Harness::new(github());
        let deny = FixedHook(Ok(Some(HookDecision {
            action: HookAction::Deny,
            reason: Some("no".into()),
            ..HookDecision::default()
        })));
        let err = h.run(&h.policy(Some(Arc::new(deny))), &bot(), "github", comment_args()).await.expect_err("deny");
        assert_eq!(err.code, ToolErrorCode::DeniedByHook);
        assert_eq!(err.message_for_model, "Error: tool \"github\" denied by hook: no");
        let broken = FixedHook(Err(HookFailure("spawn failed".into())));
        let err = h.run(&h.policy(Some(Arc::new(broken))), &bot(), "github", comment_args()).await.expect_err("fails closed");
        assert_eq!(
            err.message_for_model,
            "Error: tool \"github\" denied: PreToolUse policy check failed: spawn failed"
        );
        assert!(h.asks().is_empty());
    }

    #[tokio::test]
    async fn a_blocked_kind_is_denied_without_a_card() {
        let h = Harness::new(github());
        h.store.set_mode("mailer", &GrantKey::Kind(ActionKind::Comment), PermissionMode::Block);
        let err = h.run(&h.policy(None), &bot(), "github", comment_args()).await.expect_err("blocked");
        assert_eq!(err.code, ToolErrorCode::DeniedByPolicy { rule: "blocked".into() });
        assert_eq!(
            err.message_for_model,
            "Error: tool \"github\" denied by hook: This agent's permission blocks this action."
        );
        assert!(h.asks().is_empty());
    }

    #[tokio::test]
    async fn runs_are_answered_by_policy_never_by_a_card() {
        let tools = Tools::default()
            .with("github", Some(ActionKind::Comment))
            .with("mcp__shop__buy", Some(ActionKind::Payment));
        let h = Harness::new(tools);
        let schedule = SessionFacts { run: Some(RunKind::Schedule), ..bot() };
        let policy = h.policy(None);
        h.run(&policy, &schedule, "github", comment_args()).await.expect("allowed");
        let err = h.run(&policy, &schedule, "mcp__shop__buy", json!({})).await.expect_err("payment");
        assert_eq!(err.code, ToolErrorCode::DeniedByPolicy { rule: "run-forbidden".into() });
        assert!(err.message_for_model.starts_with("Error: tool \"mcp__shop__buy\" denied: Payments and permanent deletes"));
        assert!(h.asks().is_empty());
        let decisions: Vec<_> = h.store.audit().into_iter().map(|e| e.decision).collect();
        assert_eq!(decisions, ["run-allowed", "run-forbidden"]);
    }

    #[tokio::test]
    async fn a_hook_ask_on_the_lead_is_remembered_per_tool() {
        let tools = Tools::default().with("shell", None);
        let h = Harness::new(tools);
        let lead = SessionFacts { agent_id: "lead".into(), life: Some("life".into()), ..SessionFacts::default() };
        let hook: Arc<dyn PreToolHook> = Arc::new(FixedHook(Ok(Some(HookDecision {
            action: HookAction::Ask,
            reason: Some("shell needs a look".into()),
            ..HookDecision::default()
        }))));
        h.answer(decided(true, Some(ApprovalRemember::Always)));
        let policy = h.policy(Some(hook));
        h.run(&policy, &lead, "shell", json!({"command": "ls"})).await.expect("first");
        h.run(&policy, &lead, "shell", json!({"command": "pwd"})).await.expect("second");
        let asks = h.asks();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].reason.as_deref(), Some("shell needs a look"));
        assert_eq!(asks[0].payload["grantAction"], "tool:shell");
        assert_eq!(asks[0].remember, [ApprovalRemember::Session, ApprovalRemember::Always]);
    }

    #[tokio::test]
    async fn a_connector_set_to_ask_asks_unless_the_outbound_card_did() {
        let tools = Tools::default().with("mcp__notes__append", None).with("github", Some(ActionKind::Comment));
        let mut h = Harness::new(tools);
        h.connectors = Arc::new(Connectors {
            needs: vec!["mcp__notes__append".into(), "github".into()],
            save_works: false,
            ..Connectors::default()
        });
        let policy = h.policy(None);
        h.answer(decided(true, Some(ApprovalRemember::Agent)));
        let got = h.run(&policy, &bot(), "mcp__notes__append", json!({})).await.expect("ok");
        assert!(got.allow_not_saved, "the save failed: the notice is owed");
        assert_eq!(h.connectors.saved.lock().expect("saved").as_slice(), ["mailer/mcp__notes__append"]);
        let asks = h.asks();
        assert_eq!(asks[0].reason.as_deref(), Some(CONNECTOR_APPROVAL_REASON));
        assert_eq!(asks[0].remember, [ApprovalRemember::Agent]);
        // The outbound card approved this very call: the connector ask is not repeated.
        h.answer(decided(true, None));
        h.run(&policy, &bot(), "github", comment_args()).await.expect("outbound");
        assert_eq!(h.asks().len(), 2);
        // A coding session runs connector tools unasked.
        let lead = SessionFacts { agent_id: "lead".into(), ..SessionFacts::default() };
        h.run(&policy, &lead, "mcp__notes__append", json!({})).await.expect("unasked");
        assert_eq!(h.asks().len(), 2);
    }

    #[tokio::test]
    async fn the_user_prompt_tools_bypass_the_gate() {
        let tools = Tools::default().with("ask_user", Some(ActionKind::Message));
        let h = Harness::new(tools);
        let hook: Arc<dyn PreToolHook> = Arc::new(FixedHook(Ok(Some(HookDecision {
            action: HookAction::Deny,
            ..HookDecision::default()
        }))));
        h.run(&h.policy(Some(hook)), &bot(), "ask_user", json!({})).await.expect("bypassed");
        assert!(h.asks().is_empty());
    }

    #[tokio::test]
    async fn a_stopped_run_returns_cancelled_without_an_audit() {
        let h = Harness::new(github());
        h.answer(ApprovalResolution::Cancelled { at: 0 });
        let err = h.run(&h.policy(None), &bot(), "github", comment_args()).await.expect_err("cancelled");
        assert_eq!(err.code, ToolErrorCode::Cancelled);
        assert!(h.store.audit().is_empty());
    }

    #[tokio::test]
    async fn a_session_without_an_approval_surface_is_denied_with_nodes_text_and_a_deny_audit() {
        let h = Harness::new(github());
        h.answer(ApprovalResolution::Unavailable { at: 0 });
        let err = h.run(&h.policy(None), &bot(), "github", comment_args()).await.expect_err("unavailable");
        assert_eq!(err.code, ToolErrorCode::DeniedByHook);
        assert_eq!(
            err.message_for_model,
            "Error: tool \"github\" denied by hook: approval required but no approval UI is available (This sends or posts outside Mixdog; it needs your approval.)"
        );
        assert_eq!(h.store.audit().iter().map(|e| e.decision.as_str()).collect::<Vec<_>>(), ["deny"]);
        assert_eq!(
            missing_approval_ui_denial("shell", ""),
            "Error: tool \"shell\" denied by hook: approval required but no approval UI is available (approval requested by hook)"
        );
        assert_eq!(
            missing_approval_ui_denial("", " \u{a0}"),
            "Error: tool \"tool\" denied by hook: approval required but no approval UI is available"
        );
    }

    #[tokio::test]
    async fn a_timeout_denies_and_is_audited_as_a_timeout() {
        let h = Harness::new(github());
        h.answer(ApprovalResolution::TimedOut { at: 0 });
        let err = h.run(&h.policy(None), &bot(), "github", comment_args()).await.expect_err("timeout");
        assert!(err.message_for_model.contains("approval timed out"));
        assert_eq!(h.store.audit()[0].decision, "timeout");
    }
}
