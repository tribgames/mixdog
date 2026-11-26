//! The human gate: the one rule that turns an outbound call into an `ask`
//! whatever the hooks said short of a deny, unless the acting agent's
//! permission for that action kind is `allow`; `block` denies it without a
//! card. The outbound rule applies only while a bot acts; an ordinary coding
//! session's outbound call passes with the hook decision unchanged. A bot's
//! remembered outbound approval covers the action category (as in 1.4.5), and
//! per-tool grants stored by 1.5.0 also continue to answer calls of that tool.
//! A hook's own `ask` always uses the per-tool key (`tool:<identity>`) for both
//! lookup and storage, so category grants never silence or come from a hook ask.
//!
//! Schedule and webhook runs never ask (see [`super::run_policy`]). The
//! "Allow all actions" developer option skips every ask except a payment or
//! permanent delete; a `block` and a hook `deny` still deny.
//!
//! Whether a call is outbound is the tool's own typed answer
//! (`Tool::outbound_kind`), passed in as [`GateCall::kind`].

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_protocol::ApprovalRemember;
use serde_json::Value;

use super::action::GrantKey;
use super::action::kind_name;
use super::card::CardEnricher;
use super::card::OutboundCard;
use super::grants::AuditEntry;
use super::grants::DEV_ALLOW_ALL_DECISION;
use super::grants::GrantStore;
use super::grants::PermissionMode;
use super::grants::SESSION_REMEMBERED_DECISION;
use super::grants::StoreError;
use super::offer::Caller;
use super::offer::Card;
use super::offer::offered_scopes;
use super::run_policy::AUTOMATION_GRANT_REASON;
use super::run_policy::RUN_FORBIDDEN_REASON;
use super::run_policy::RunKind;
use super::run_policy::saves_automation;
use super::session_grants::SessionGrants;

pub const OUTBOUND_APPROVAL_REASON: &str = "This sends or posts on your behalf; it needs your approval.";
pub const BLOCKED_ACTION_REASON: &str = "This agent's permission blocks this action.";
pub const DEFAULT_ASK_REASON: &str = "approval requested by hook";

/// What the session actor knows about who is acting.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SessionFacts {
    /// The agent the session acts for (its run's owner, a room member, a home
    /// thread's agent, else Mixy).
    pub agent_id: String,
    /// The bot the session acts for; `None` for a coding Lead, a task session
    /// and every sub-agent of a chat.
    pub acting_bot: Option<String>,
    /// The contact bot (not Mixy) the session acts for.
    pub contact_bot: Option<String>,
    /// The agent whose connector policy governs the session.
    pub connector_agent_id: String,
    /// The unattended run that owns the session.
    pub run: Option<RunKind>,
    /// The session's current life mark; `None` for a session that has ended.
    pub life: Option<String>,
}

impl SessionFacts {
    /// Whether a person is attending the session.
    pub fn attended(&self) -> bool {
        self.run.is_none()
    }

    /// Who answers this session's cards ([`offered_scopes`]).
    pub fn caller(&self) -> Caller {
        if self.attended() { Caller::Attended } else { Caller::Unattended }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct PolicySettings {
    /// The "Allow all actions" developer option. An unreadable or malformed
    /// setting is `false`.
    pub allow_all_actions: bool,
}

/// What a PreToolUse hook decided; `Block` is `Deny`, `Modify` is `Rewrite`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum HookAction {
    #[default]
    Allow,
    Deny,
    Ask,
    Rewrite,
}

pub struct GateCall<'a> {
    pub name: &'a str,
    /// The tool's stable identity (`ConnectorPermissions::tool_identity`): what a
    /// remembered approval is keyed by.
    pub identity: &'a str,
    pub args: &'a Value,
    /// `Tool::outbound_kind` of the call as it will run.
    pub kind: Option<ActionKind>,
    pub hook: HookAction,
    pub hook_reason: Option<&'a str>,
}

pub struct GateCx<'a> {
    pub facts: &'a SessionFacts,
    pub settings: PolicySettings,
    pub store: &'a dyn GrantStore,
    pub session_grants: &'a SessionGrants,
    pub enricher: Option<&'a dyn CardEnricher>,
    /// The calling session's MCP scope (`ctx.mcpScopeId`): where a card's connector is asked.
    pub mcp_scope: Option<&'a str>,
}

/// What an `ask` presents.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AskRequest {
    Approval {
        agent_id: String,
        remember: Vec<ApprovalRemember>,
        grant_action: Option<GrantKey>,
        /// The call's outbound classification, if any.
        action_kind: Option<ActionKind>,
    },
    Outbound {
        agent_id: String,
        card: OutboundCard,
        remember: Vec<ApprovalRemember>,
    },
    /// [`Card::ConnectorPolicy`]: the acting contact bot's connector tool set to ask.
    Connector {
        agent_id: String,
        remember: Vec<ApprovalRemember>,
    },
}

/// The audit identity of an ask and the grant its answer may store.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct GateAudit {
    pub agent_id: String,
    pub card: Card,
    pub action: Option<GrantKey>,
    /// The key an answer may be remembered under; `None` where nothing is remembered.
    pub grant: Option<GrantKey>,
    /// The call's outbound classification, if any.
    pub category: Option<ActionKind>,
    pub tool: String,
    pub target: String,
}

impl GateAudit {
    /// The scopes this ask offers `caller`, and the only ones its answer may store.
    pub fn offered(&self, caller: Caller) -> Vec<ApprovalRemember> {
        offered_scopes(self.card, self.grant.as_ref(), self.category, caller)
    }

    pub fn entry(&self, decision: &str, device: &str) -> AuditEntry {
        AuditEntry {
            agent_id: self.agent_id.clone(),
            kind: self.card.kind().to_owned(),
            action: self.action.as_ref().map(GrantKey::render).unwrap_or_default(),
            tool: self.tool.clone(),
            target: self.target.clone(),
            decision: decision.to_owned(),
            device: device.to_owned(),
            at_ms: None,
        }
    }

    fn with_grant(&self, grant: &GrantKey) -> Self {
        Self { action: Some(grant.clone()), grant: Some(grant.clone()), ..self.clone() }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AskPlan {
    pub reason: String,
    pub request: AskRequest,
    pub audit: GateAudit,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DenyRule {
    /// The agent's permission for the action kind is `block`.
    Blocked,
    /// A payment or permanent delete in a schedule/webhook run.
    RunForbidden,
}

impl DenyRule {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::RunForbidden => "run-forbidden",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum GateVerdict {
    /// Run as the hooks left it. `remembered`: a stored grant answered an
    /// outbound call, so no later layer asks again.
    Run {
        remembered: bool,
    },
    Deny {
        rule: DenyRule,
        reason: &'static str,
    },
    Ask(Box<AskPlan>),
}

/// The per-tool key for a hook ask or a legacy 1.5.0 per-tool grant. Never a
/// payment or permanent delete, and never a tool whose approval is always
/// answered once (`GrantKey::tool`).
fn tool_grant_key(identity: &str, kind: Option<ActionKind>) -> Option<GrantKey> {
    if kind.is_some_and(|kind| !kind.rememberable()) {
        return None;
    }
    GrantKey::tool(identity)
}

fn skips_approval(kind: Option<ActionKind>, settings: PolicySettings) -> bool {
    settings.allow_all_actions && kind.is_none_or(ActionKind::rememberable)
}

fn session_allows(cx: &GateCx<'_>, action: &GrantKey) -> bool {
    if !action.rememberable() || !cx.facts.attended() {
        return false;
    }
    cx.facts.life.as_deref().is_some_and(|life| cx.session_grants.has(&cx.facts.agent_id, action, life))
}

/// The audit decision of the allowance that answers a hook `ask` for `action`:
/// a saved every-agent allow, else this session's own; `None` when none does.
/// A bot's own "this agent" allow was never an answer to a hook's ask.
async fn allowance_for_hook_ask(cx: &GateCx<'_>, action: &GrantKey) -> Result<Option<&'static str>, StoreError> {
    let shared = cx.store.mode_for(&cx.facts.agent_id, action, true).await?;
    if shared == PermissionMode::Allow {
        return Ok(Some("remembered"));
    }
    Ok(session_allows(cx, action).then_some(SESSION_REMEMBERED_DECISION))
}

/// A saved allow for `grant`, or this session's own allowance for it (never an
/// unattended run's, never a payment or permanent delete's), answers an outbound call.
async fn answered_by_allowance(
    cx: &GateCx<'_>,
    audit: &GateAudit,
    grant: &GrantKey,
    known_mode: Option<PermissionMode>,
) -> Result<Option<GateVerdict>, StoreError> {
    let mode = match known_mode {
        Some(mode) => mode,
        None => cx.store.mode_for(&cx.facts.agent_id, grant, false).await?,
    };
    let standing = mode == PermissionMode::Allow;
    if !standing && !session_allows(cx, grant) {
        return Ok(None);
    }
    cx.store.record_audit(audit.entry(if standing { "remembered" } else { SESSION_REMEMBERED_DECISION }, "")).await?;
    Ok(Some(GateVerdict::Run { remembered: true }))
}

pub async fn decide(cx: &GateCx<'_>, call: &GateCall<'_>) -> Result<GateVerdict, StoreError> {
    let facts = cx.facts;
    let agent = facts.agent_id.as_str();
    let asked = call.hook == HookAction::Ask;

    if facts.run.is_some_and(RunKind::is_granted) && call.kind == Some(ActionKind::Delete) {
        cx.store
            .record_audit(AuditEntry {
                agent_id: agent.to_owned(),
                kind: "outbound".into(),
                action: kind_name(ActionKind::Delete).into(),
                tool: call.name.to_owned(),
                decision: "run-forbidden".into(),
                ..AuditEntry::default()
            })
            .await?;
        return Ok(GateVerdict::Deny { rule: DenyRule::RunForbidden, reason: RUN_FORBIDDEN_REASON });
    }

    let Some(kind) = call.kind.filter(|_| facts.acting_bot.is_some()) else {
        return decide_plain(cx, call).await;
    };

    let mut card = OutboundCard::build(call.name, call.args, kind);
    let action = GrantKey::Kind(kind);
    // A bot's own outbound card remembers by action category (1.4.5); when a
    // hook also asked, lookup and storage stay per tool (1.5.0).
    let grant = if asked { tool_grant_key(call.identity, Some(kind)) } else { kind.rememberable().then_some(action.clone()) };
    // A hook's `ask` on the call still gets the outbound card and what it offers.
    let audit = GateAudit {
        agent_id: agent.to_owned(),
        card: Card::Outbound,
        action: Some(action.clone()),
        grant: grant.clone(),
        category: Some(kind),
        tool: card.tool.clone(),
        target: card.target.clone(),
    };
    let record = |decision: &str| cx.store.record_audit(audit.entry(decision, ""));

    let mode = cx.store.mode_for(agent, &action, false).await?;
    if mode == PermissionMode::Block {
        record("blocked").await?;
        return Ok(GateVerdict::Deny { rule: DenyRule::Blocked, reason: BLOCKED_ACTION_REASON });
    }
    // The bot's `ask` mode (and a hook's `ask`) is bypassed; a payment or delete is not.
    if skips_approval(Some(kind), cx.settings) {
        record(DEV_ALLOW_ALL_DECISION).await?;
        return Ok(GateVerdict::Run { remembered: false });
    }
    if let Some(grant) = &grant {
        if asked {
            if let Some(answered) = allowance_for_hook_ask(cx, grant).await? {
                record(answered).await?;
                // It answers the hook's ask only: not `remembered`, so a connector's
                // own approval layer still asks its own question.
                return Ok(GateVerdict::Run { remembered: false });
            }
        } else {
            if let Some(verdict) = answered_by_allowance(cx, &audit, grant, Some(mode)).await? {
                return Ok(verdict);
            }
            // Honour per-tool grants stored by 1.5.0 for calls of that tool.
            if let Some(tool) = tool_grant_key(call.identity, Some(kind))
                && let Some(verdict) = answered_by_allowance(cx, &audit, &tool, None).await?
            {
                return Ok(verdict);
            }
        }
    }
    if let Some(enricher) = cx.enricher {
        enricher.enrich(cx.mcp_scope, call.name, call.args, &mut card).await;
    }
    Ok(GateVerdict::Ask(Box::new(AskPlan {
        reason: reason_of(call.hook_reason, OUTBOUND_APPROVAL_REASON),
        request: AskRequest::Outbound { agent_id: agent.to_owned(), card, remember: audit.offered(facts.caller()) },
        audit,
    })))
}

/// A call no bot's outbound rule covers (a coding Lead's call, any tool a hook
/// rule names): passes unless a hook asked.
async fn decide_plain(cx: &GateCx<'_>, call: &GateCall<'_>) -> Result<GateVerdict, StoreError> {
    if call.hook != HookAction::Ask {
        return Ok(GateVerdict::Run { remembered: false });
    }
    let agent = cx.facts.agent_id.as_str();
    let base = GateAudit {
        agent_id: agent.to_owned(),
        card: Card::HookAsk,
        action: None,
        grant: None,
        category: call.kind,
        tool: call.name.to_owned(),
        target: String::new(),
    };
    if skips_approval(call.kind, cx.settings) {
        cx.store.record_audit(base.entry(DEV_ALLOW_ALL_DECISION, "")).await?;
        return Ok(GateVerdict::Run { remembered: false });
    }
    // Remembered strictly per tool (never a category, never a payment or permanent
    // delete), never per argument.
    let grant_action = tool_grant_key(call.identity, call.kind);
    if let Some(action) = &grant_action
        && let Some(answered) = allowance_for_hook_ask(cx, action).await?
    {
        cx.store.record_audit(base.with_grant(action).entry(answered, "")).await?;
        return Ok(GateVerdict::Run { remembered: false });
    }
    let reason = if saves_automation(call.name, call.args) { AUTOMATION_GRANT_REASON.to_owned() } else { reason_of(call.hook_reason, DEFAULT_ASK_REASON) };
    let audit = match &grant_action {
        Some(action) => base.with_grant(action),
        None => base,
    };
    Ok(GateVerdict::Ask(Box::new(AskPlan {
        reason,
        request: AskRequest::Approval { agent_id: agent.to_owned(), remember: audit.offered(cx.facts.caller()), grant_action, action_kind: call.kind },
        audit,
    })))
}

fn reason_of(hook_reason: Option<&str>, default: &str) -> String {
    hook_reason.map(str::trim).filter(|reason| !reason.is_empty()).unwrap_or(default).to_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::grants::GrantTable;
    use super::super::grants::MemoryGrantStore;
    use super::*;

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

    fn lead() -> SessionFacts {
        SessionFacts { agent_id: "lead".into(), life: Some("life".into()), ..SessionFacts::default() }
    }

    struct Fixture {
        store: MemoryGrantStore,
        grants: SessionGrants,
    }

    impl Fixture {
        fn new() -> Self {
            Self { store: MemoryGrantStore::default(), grants: SessionGrants::default() }
        }

        async fn run(&self, facts: &SessionFacts, settings: PolicySettings, name: &str, kind: Option<ActionKind>, hook: HookAction) -> GateVerdict {
            let cx = GateCx { facts, settings, store: &self.store, session_grants: &self.grants, enricher: None, mcp_scope: None };
            let args = json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "draft"});
            let call = GateCall { name, identity: name, args: &args, kind, hook, hook_reason: None };
            decide(&cx, &call).await.expect("decide")
        }

        fn audit_decisions(&self) -> Vec<String> {
            self.store.audit().into_iter().map(|e| e.decision).collect()
        }
    }

    fn ask(verdict: GateVerdict) -> AskPlan {
        match verdict {
            GateVerdict::Ask(plan) => *plan,
            other => panic!("expected ask, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_outbound_call_asks_even_when_hooks_allow() {
        let f = Fixture::new();
        let plan = ask(f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await);
        assert_eq!(plan.reason, OUTBOUND_APPROVAL_REASON);
        let AskRequest::Outbound { card, remember, .. } = plan.request else {
            panic!("outbound request");
        };
        assert_eq!(card.payload, "draft");
        assert_eq!(card.editable, ["body"]);
        assert_eq!(remember, [ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Agent]);
        assert_eq!(plan.audit.action, Some(GrantKey::Kind(ActionKind::Comment)));
        assert_eq!(plan.audit.grant, Some(GrantKey::Kind(ActionKind::Comment)), "the answer is remembered for the action category");
    }

    #[tokio::test]
    async fn a_coding_lead_is_not_gated_on_outbound_calls() {
        let f = Fixture::new();
        let verdict = f.run(&lead(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: false });
        assert!(f.store.audit().is_empty());
    }

    #[tokio::test]
    async fn a_block_denies_without_a_card_and_an_allow_runs_remembered() {
        let f = Fixture::new();
        let comment = GrantKey::Kind(ActionKind::Comment);
        f.store.set_mode("mailer", &comment, PermissionMode::Block);
        let verdict = f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Deny { rule: DenyRule::Blocked, reason: BLOCKED_ACTION_REASON });
        f.store.set_mode("mailer", &comment, PermissionMode::Allow);
        let verdict = f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: true });
        assert_eq!(f.audit_decisions(), ["blocked", "remembered"]);
    }

    #[tokio::test]
    async fn an_approval_covers_the_action_category_whatever_the_scope() {
        let comment = Some(ActionKind::Comment);
        let key = GrantKey::Kind(ActionKind::Comment);
        let other = "mcp__slack__post_comment";
        // Agent scope covers every tool of that category for this agent, not other agents or categories.
        let mut table = GrantTable::default();
        assert!(table.grant("mailer", &key, ApprovalRemember::Agent, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        assert_eq!(f.run(&bot(), PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert_eq!(f.run(&bot(), PolicySettings::default(), other, comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert!(matches!(f.run(&bot(), PolicySettings::default(), "mcp__gmail__send", Some(ActionKind::Email), HookAction::Allow).await, GateVerdict::Ask(_)));
        let stranger = SessionFacts { agent_id: "other".into(), ..bot() };
        assert!(matches!(f.run(&stranger, PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Ask(_)));
        // Every-agent scope covers every tool of that category for every agent.
        let mut table = GrantTable::default();
        assert!(table.grant("mailer", &key, ApprovalRemember::Always, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        assert_eq!(f.run(&stranger, PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert_eq!(f.run(&stranger, PolicySettings::default(), other, comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert!(matches!(
            f.run(&stranger, PolicySettings::default(), "mcp__gmail__send", Some(ActionKind::Email), HookAction::Allow).await,
            GateVerdict::Ask(_)
        ));
        // This conversation.
        let f = Fixture::new();
        assert!(f.grants.grant("mailer", &key, "life"));
        assert_eq!(f.run(&bot(), PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert_eq!(f.run(&bot(), PolicySettings::default(), other, comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert!(matches!(f.run(&bot(), PolicySettings::default(), "mcp__gmail__send", Some(ActionKind::Email), HookAction::Allow).await, GateVerdict::Ask(_)));
    }

    /// Per-tool grants stored by 1.5.0 continue to answer calls of that tool, without widening
    /// to other tools, and category blocks and payment/delete rules still take precedence.
    #[tokio::test]
    async fn a_1_5_0_per_tool_grant_keeps_answering_that_tool() {
        let comment = Some(ActionKind::Comment);
        let github = GrantKey::tool("github").expect("key");
        let other = "mcp__slack__post_comment";
        // Agent-scoped 1.5.0 per-tool grant.
        let mut table = GrantTable::default();
        assert!(table.grant("mailer", &github, ApprovalRemember::Agent, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        assert_eq!(f.run(&bot(), PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert!(matches!(f.run(&bot(), PolicySettings::default(), other, comment, HookAction::Allow).await, GateVerdict::Ask(_)));
        // Category block still denies even when a 1.5.0 tool grant exists.
        f.store.set_mode("mailer", &GrantKey::Kind(ActionKind::Comment), PermissionMode::Block);
        assert_eq!(
            f.run(&bot(), PolicySettings::default(), "github", comment, HookAction::Allow).await,
            GateVerdict::Deny { rule: DenyRule::Blocked, reason: BLOCKED_ACTION_REASON }
        );
        // Every-agent 1.5.0 per-tool grant answers outbound calls and hook asks for that tool.
        let mut table = GrantTable::default();
        assert!(table.grant("mailer", &github, ApprovalRemember::Always, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        let stranger = SessionFacts { agent_id: "other".into(), ..bot() };
        assert_eq!(f.run(&stranger, PolicySettings::default(), "github", comment, HookAction::Allow).await, GateVerdict::Run { remembered: true });
        assert_eq!(f.run(&lead(), PolicySettings::default(), "github", comment, HookAction::Ask).await, GateVerdict::Run { remembered: false });
        // A 1.5.0 per-tool grant never bypasses payment or permanent delete.
        let buy = GrantKey::tool("mcp__shop__buy").expect("key");
        let mut table = GrantTable::default();
        assert!(table.grant("mailer", &buy, ApprovalRemember::Always, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        for kind in [ActionKind::Payment, ActionKind::Delete] {
            assert!(matches!(f.run(&bot(), PolicySettings::default(), "mcp__shop__buy", Some(kind), HookAction::Allow).await, GateVerdict::Ask(_)), "{kind:?}");
        }
    }

    /// A hook's `ask` on a bot's outbound call is put on the outbound card, and that card offers
    /// what an outbound card offers: never "always" for every agent.
    #[tokio::test]
    async fn a_hook_ask_is_not_answered_by_the_bots_own_allow_and_its_outbound_card_offers_no_every_agent_scope() {
        let f = Fixture::new();
        f.store.set_mode("mailer", &GrantKey::Kind(ActionKind::Comment), PermissionMode::Allow);
        let plan = ask(f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Ask).await);
        assert_eq!(
            plan.request,
            AskRequest::Outbound {
                agent_id: "mailer".into(),
                card: OutboundCard::build("github", &json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "draft"}), ActionKind::Comment),
                remember: vec![ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Agent],
            }
        );
        assert_eq!(plan.audit.grant, GrantKey::tool("github"), "a hook ask stays keyed per tool");
        assert!(!plan.audit.offered(Caller::Attended).contains(&ApprovalRemember::Always));
    }

    #[tokio::test]
    async fn an_every_agent_allow_answers_a_hook_ask_but_is_not_remembered() {
        let mut table = GrantTable::default();
        table.grant("x", &GrantKey::tool("github").expect("key"), ApprovalRemember::Always, "", 0);
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        let verdict = f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Ask).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: false });
        assert_eq!(f.audit_decisions(), ["remembered"]);
    }

    #[tokio::test]
    async fn category_grants_never_answer_or_come_from_a_hook_ask() {
        // Every-agent category allows (such as 1.4.5's) never silence hook asks on either path.
        let mut table = GrantTable::default();
        assert!(table.grant("x", &GrantKey::Kind(ActionKind::Email), ApprovalRemember::Always, "", 0).is_some());
        assert!(table.grant("x", &GrantKey::Kind(ActionKind::BrowserSubmit), ApprovalRemember::Always, "", 0).is_some());
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };

        let lead_mail = ask(f.run(&lead(), PolicySettings::default(), "mcp__gmail__send_email", Some(ActionKind::Email), HookAction::Ask).await);
        assert_eq!(
            lead_mail.request,
            AskRequest::Approval {
                agent_id: "lead".into(),
                remember: vec![ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Always],
                grant_action: GrantKey::tool("mcp__gmail__send_email"),
                action_kind: Some(ActionKind::Email),
            }
        );
        let lead_browser = ask(f.run(&lead(), PolicySettings::default(), "browser", Some(ActionKind::BrowserSubmit), HookAction::Ask).await);
        assert_eq!(
            lead_browser.request,
            AskRequest::Approval {
                agent_id: "lead".into(),
                remember: vec![ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Always],
                grant_action: GrantKey::tool("browser"),
                action_kind: Some(ActionKind::BrowserSubmit),
            }
        );
        let bot_mail = ask(f.run(&bot(), PolicySettings::default(), "mcp__gmail__send_email", Some(ActionKind::Email), HookAction::Ask).await);
        assert_eq!(bot_mail.audit.grant, GrantKey::tool("mcp__gmail__send_email"));

        // A bot's session category grant answers normal outbound calls on other tools, never a hook ask.
        let f = Fixture::new();
        assert!(f.grants.grant("mailer", &GrantKey::Kind(ActionKind::Comment), "life"));
        assert_eq!(
            f.run(&bot(), PolicySettings::default(), "mcp__slack__post_comment", Some(ActionKind::Comment), HookAction::Allow).await,
            GateVerdict::Run { remembered: true }
        );
        let hook_on_same = ask(f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Ask).await);
        assert_eq!(hook_on_same.audit.grant, GrantKey::tool("github"));
        let hook_on_other = ask(f.run(&bot(), PolicySettings::default(), "mcp__slack__post_comment", Some(ActionKind::Comment), HookAction::Ask).await);
        assert_eq!(hook_on_other.audit.grant, GrantKey::tool("mcp__slack__post_comment"));
    }

    #[tokio::test]
    async fn this_sessions_allowance_answers_only_where_a_person_attends() {
        let f = Fixture::new();
        let comment = GrantKey::Kind(ActionKind::Comment);
        assert!(f.grants.grant("mailer", &comment, "life"));
        let verdict = f.run(&bot(), PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: true });
        assert_eq!(f.audit_decisions(), [SESSION_REMEMBERED_DECISION]);
        let unattended = SessionFacts { run: Some(RunKind::Room), ..bot() };
        let plan = ask(f.run(&unattended, PolicySettings::default(), "github", Some(ActionKind::Comment), HookAction::Allow).await);
        let AskRequest::Outbound { remember, .. } = plan.request else {
            panic!("outbound request");
        };
        assert_eq!(remember, [ApprovalRemember::Once, ApprovalRemember::Agent]);
    }

    #[tokio::test]
    async fn payments_and_deletes_ask_every_time_and_offer_only_once() {
        let f = Fixture::new();
        let allow_all = PolicySettings { allow_all_actions: true };
        for kind in [ActionKind::Payment, ActionKind::Delete] {
            assert!(!f.grants.grant("mailer", &GrantKey::Kind(kind), "life"));
            let plan = ask(f.run(&bot(), allow_all, "mcp__shop__buy", Some(kind), HookAction::Allow).await);
            let AskRequest::Outbound { remember, .. } = plan.request else {
                panic!("outbound request");
            };
            assert_eq!(remember, [ApprovalRemember::Once], "{kind:?}");
        }
    }

    #[tokio::test]
    async fn allow_all_actions_skips_every_other_ask_and_audits_it() {
        let f = Fixture::new();
        let allow_all = PolicySettings { allow_all_actions: true };
        let verdict = f.run(&bot(), allow_all, "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: false });
        let verdict = f.run(&lead(), allow_all, "shell", None, HookAction::Ask).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: false });
        assert_eq!(f.audit_decisions(), [DEV_ALLOW_ALL_DECISION, DEV_ALLOW_ALL_DECISION]);
        // A block still denies.
        f.store.set_mode("mailer", &GrantKey::Kind(ActionKind::Comment), PermissionMode::Block);
        let verdict = f.run(&bot(), allow_all, "github", Some(ActionKind::Comment), HookAction::Allow).await;
        assert!(matches!(verdict, GateVerdict::Deny { rule: DenyRule::Blocked, .. }));
    }

    #[tokio::test]
    async fn a_hook_ask_on_a_plain_tool_is_remembered_per_tool() {
        let f = Fixture::new();
        let plan = ask(f.run(&lead(), PolicySettings::default(), "shell", None, HookAction::Ask).await);
        assert_eq!(plan.reason, DEFAULT_ASK_REASON);
        assert_eq!(
            plan.request,
            AskRequest::Approval {
                agent_id: "lead".into(),
                remember: vec![ApprovalRemember::Once, ApprovalRemember::Session, ApprovalRemember::Always],
                grant_action: GrantKey::tool("shell"),
                action_kind: None,
            }
        );
        // The tools that change what agents may do are answered once.
        let plan = ask(f.run(&lead(), PolicySettings::default(), "setup", None, HookAction::Ask).await);
        let AskRequest::Approval { remember, grant_action, .. } = plan.request else {
            panic!("approval request");
        };
        assert_eq!((remember, grant_action), (vec![ApprovalRemember::Once], None));
    }

    #[tokio::test]
    async fn a_saved_every_agent_tool_allow_answers_the_hook_ask() {
        let mut table = GrantTable::default();
        let shell = GrantKey::tool("shell").expect("key");
        table.grant("x", &shell, ApprovalRemember::Always, "", 0);
        let f = Fixture { store: MemoryGrantStore::with_table(table), grants: SessionGrants::default() };
        let verdict = f.run(&lead(), PolicySettings::default(), "shell", None, HookAction::Ask).await;
        assert_eq!(verdict, GateVerdict::Run { remembered: false });
        let audit = f.store.audit();
        assert_eq!((audit[0].action.as_str(), audit[0].decision.as_str()), ("tool:shell", "remembered"));
    }

    #[tokio::test]
    async fn a_classified_payment_under_a_hook_ask_is_never_keyed() {
        let f = Fixture::new();
        let plan = ask(f.run(&lead(), PolicySettings::default(), "mcp__shop__buy", Some(ActionKind::Payment), HookAction::Ask).await);
        assert_eq!(
            plan.request,
            AskRequest::Approval {
                agent_id: "lead".into(),
                remember: vec![ApprovalRemember::Once],
                grant_action: None,
                action_kind: Some(ActionKind::Payment),
            }
        );
    }

    #[tokio::test]
    async fn saving_an_automation_says_what_the_approval_grants() {
        let f = Fixture::new();
        let facts = lead();
        let cx = GateCx { facts: &facts, settings: PolicySettings::default(), store: &f.store, session_grants: &f.grants, enricher: None, mcp_scope: None };
        let args = json!({"action": "save_automation"});
        let call = GateCall { name: "setup", identity: "setup", args: &args, kind: None, hook: HookAction::Ask, hook_reason: Some("hook says") };
        let plan = ask(decide(&cx, &call).await.expect("decide"));
        assert_eq!(plan.reason, AUTOMATION_GRANT_REASON);
    }

    #[tokio::test]
    async fn a_remote_delete_in_a_schedule_run_is_denied_and_audited() {
        let f = Fixture::new();
        let facts = SessionFacts { run: Some(RunKind::Schedule), ..bot() };
        let verdict = f.run(&facts, PolicySettings::default(), "mcp__drive__delete_file", Some(ActionKind::Delete), HookAction::Allow).await;
        assert_eq!(verdict, GateVerdict::Deny { rule: DenyRule::RunForbidden, reason: RUN_FORBIDDEN_REASON });
        assert_eq!(f.audit_decisions(), ["run-forbidden"]);
        // A room member is not a run of this kind.
        let room = SessionFacts { run: Some(RunKind::Room), ..bot() };
        let verdict = f.run(&room, PolicySettings::default(), "mcp__drive__delete_file", Some(ActionKind::Delete), HookAction::Allow).await;
        assert!(matches!(verdict, GateVerdict::Ask(_)));
    }
}
