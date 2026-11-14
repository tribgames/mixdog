//! Who is asked about a Browser Use submit, post or upload, and what answers it without asking: the engine's [`ApprovalPort`] over
//! the core's one approval path. The card is `item/browser/requestApproval` raised through the asking turn's approval gate
//! (`orch::service::call_approvals`, else the session's own gate), the standing allows, the saved `block`s, the "Allow all
//! actions" option and the session's allowances are read through `policy::gate::decide` per kind of step, and the card holds the
//! human-only lock for as long as it is open.
//!
//! Outcome parity with the desktop's `approval-dialog.ts` for the same caller: a session that is no bot's own runs unasked; a bot's
//! own session asks unless it holds a standing or session allowance for EVERY kind of the step; "Allow all actions" lets a bot's
//! step run unasked (an operator `confirm` too) unless the bot blocks one of its kinds, which refuses it; a `confirm` or a payment
//! (the page holds payment evidence) asks once, every time, and no grant of any kind covers it. A core-hosted session sent no
//! `turn_id`, `session_life` or `unattended_*` field to the desktop, so its decisions were an attended turn's: this port reads the
//! session's facts as an attended turn's whatever run owns the session, so it never asks where that did not and never refuses a
//! step that was only asked. What the session's allowances (the registry the core knows) cover may only remove a repeat ask.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalPrompt as CardPrompt;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRemember;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind;
use mixdog_browser_engine::ApprovalPort;
use mixdog_browser_engine::FilePort;
use mixdog_browser_engine::approval::binding::mark_outside;
use mixdog_browser_engine::approval::classify::origin_of_url;
use mixdog_browser_engine::approval::requester::Requester;
use mixdog_browser_engine::types::ApprovalAnswer;
use mixdog_browser_engine::types::BrowserApprovalPrompt;
use mixdog_browser_engine::types::Remember;
use mixdog_browser_policy::redaction::redact_url;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use serde_json::Value;
use serde_json::json;

use crate::orch::service::call_approvals;
use crate::orch::util::cancelled;
use crate::orch::util::unavailable;
use crate::policy::action::GrantKey;
use crate::policy::action::kind_name;
use crate::policy::gate::GateCall;
use crate::policy::gate::GateCx;
use crate::policy::gate::GateVerdict;
use crate::policy::gate::HookAction;
use crate::policy::gate::PolicySettings;
use crate::policy::gate::SessionFacts;
use crate::policy::gate::decide;
use crate::policy::grants::AuditEntry;
use crate::policy::grants::GrantStore;
use crate::policy::session_grants::SessionGrants;

/// The tool a step is asked and audited as.
const TOOL: &str = "browser";
/// How long the requester's name may take to resolve; the card is raised unnamed (the bot's id) when it does not come.
const REQUESTER_TIMEOUT: Duration = Duration::from_millis(1_500);

pub const BLOCKED_BY_PERMISSION: &str = "Browser Use step blocked by this bot's permission; nothing was dispatched";
const NO_APPROVAL_SURFACE: &str = "approval required but no approval UI is available";

/// The human-only lock held while a card is open: released when this is dropped.
pub struct CardHold(Option<Box<dyn FnOnce() + Send>>);

impl CardHold {
    pub fn new(release: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(release)))
    }

    /// A hold that holds nothing (a core with no human-only lock).
    pub fn none() -> Self {
        Self(None)
    }
}

impl Drop for CardHold {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

/// What the core knows of the asking session, read where the composition holds it.
#[async_trait]
pub trait ApprovalContext: Send + Sync {
    /// Who acts for the session (`acting_bot`, the agent whose permissions govern it, its life mark). An unknown session is no
    /// bot's: [`SessionFacts::default`].
    fn facts(&self, thread: &ThreadId) -> SessionFacts;

    /// The "Allow all actions" developer option as it stands now.
    fn settings(&self) -> PolicySettings;

    /// The session's own allowances ("allow for this session").
    fn session_grants(&self, thread: &ThreadId) -> SessionGrants;

    /// The asking session's name for the card and its working directory; [`Requester::default`] when unknown.
    async fn requester(&self, thread: &ThreadId) -> Requester;

    /// The session's approval gate, for a command no tool call made (a bridge command): `None` where the session has none.
    fn session_gate(&self, thread: &ThreadId) -> Option<Arc<dyn ApprovalGate>>;

    /// Takes the human-only lock for the card `request_id` of `thread` until the returned hold is dropped.
    fn hold_card(&self, request_id: &str, thread: &ThreadId) -> CardHold;
}

/// The action kind a standing allow of a kind of step is kept under; `confirm` has none: it always asks.
fn action_kind_of(kind: BrowserApprovalRememberKind) -> Option<ActionKind> {
    match kind {
        BrowserApprovalRememberKind::Submit => Some(ActionKind::BrowserSubmit),
        BrowserApprovalRememberKind::Post => Some(ActionKind::BrowserPost),
        BrowserApprovalRememberKind::Upload => Some(ActionKind::BrowserUpload),
        BrowserApprovalRememberKind::Confirm => None,
    }
}

/// What the policy makes of a step.
#[derive(Debug, PartialEq)]
enum Verdict {
    Run,
    /// The bot blocks a kind of the step and "Allow all actions" is on.
    Refuse,
    Ask { remember: Vec<ApprovalRemember> },
}

/// [`ApprovalPort`] over the core's approval path.
pub struct BrowserApprovals {
    store: Arc<dyn GrantStore>,
    context: Arc<dyn ApprovalContext>,
    files: Arc<dyn FilePort>,
}

impl BrowserApprovals {
    pub fn new(store: Arc<dyn GrantStore>, context: Arc<dyn ApprovalContext>, files: Arc<dyn FilePort>) -> Arc<Self> {
        Arc::new(Self { store, context, files })
    }

    /// The scopes a card of a step every kind of which can be remembered offers.
    fn offered(facts: &SessionFacts) -> Vec<ApprovalRemember> {
        let session = facts.life.is_some().then_some(ApprovalRemember::Session);
        std::iter::once(ApprovalRemember::Once).chain(session).chain([ApprovalRemember::Agent, ApprovalRemember::Always]).collect()
    }

    /// Whether the step runs, is refused or asks. Every kind that has a store action is judged by the human gate; a payment, an
    /// operator `confirm` and a step with no kind that can be remembered ask once.
    async fn judge(&self, facts: &SessionFacts, grants: &SessionGrants, settings: PolicySettings, prompt: &BrowserApprovalPrompt, kinds: &[ActionKind]) -> Verdict {
        // A payment is a floor: no allowance, no option and no block is read for it.
        if prompt.payment {
            return Verdict::Ask { remember: vec![ApprovalRemember::Once] };
        }
        let cx = GateCx { facts, settings, store: &*self.store, session_grants: grants, enricher: None, mcp_scope: None };
        let no_args = Value::Null;
        let (mut every_run, mut blocked) = (true, false);
        for kind in kinds {
            let call = GateCall { name: TOOL, args: &no_args, kind: Some(*kind), hook: HookAction::Allow, hook_reason: None };
            match decide(&cx, &call).await {
                Ok(GateVerdict::Run { .. }) => {}
                Ok(GateVerdict::Ask(_)) => every_run = false,
                // A saved `block`, or a store that cannot be read: the step is not let through by an allowance.
                Ok(GateVerdict::Deny { .. }) | Err(_) => {
                    every_run = false;
                    blocked = true;
                }
            }
        }
        if settings.allow_all_actions {
            return if blocked { Verdict::Refuse } else { Verdict::Run };
        }
        let rememberable = !kinds.is_empty() && kinds.len() == prompt.kinds.len();
        if rememberable && every_run {
            return Verdict::Run;
        }
        Verdict::Ask { remember: if rememberable { Self::offered(facts) } else { vec![ApprovalRemember::Once] } }
    }

    async fn audit(&self, agent: &str, kinds: &[ActionKind], decision: &str) {
        for kind in kinds {
            let entry = AuditEntry {
                agent_id: agent.to_owned(),
                kind: "outbound".to_owned(),
                action: kind_name(*kind).to_owned(),
                tool: TOOL.to_owned(),
                decision: decision.to_owned(),
                ..AuditEntry::default()
            };
            // A failed audit never decides the approval it describes.
            let _ = self.store.record_audit(entry).await;
        }
    }

    async fn canonical(&self, root: &Path) -> PathBuf {
        self.files.stat(root).await.canonical.unwrap_or_else(|| root.to_path_buf())
    }

    /// The card the person is shown (`DesktopBrowserApprovalPrompt`).
    async fn card(&self, id: &str, agent: &str, prompt: &BrowserApprovalPrompt, requester: &Requester, remember: Option<BrowserApprovalRemember>) -> CardPrompt {
        let upload = !prompt.files.is_empty();
        let mut files = prompt.files.clone();
        if upload {
            let cwd = match &requester.cwd {
                Some(cwd) => Some(self.canonical(Path::new(cwd)).await),
                None => None,
            };
            let downloads = match dirs::download_dir() {
                Some(dir) => Some(self.canonical(&dir).await),
                None => None,
            };
            mark_outside(&mut files, cwd.as_deref(), downloads.as_deref());
        }
        CardPrompt {
            id: id.to_owned(),
            action: prompt.action.clone(),
            url: redact_url(&prompt.url),
            session_id: prompt.session_id.clone(),
            surface_session_id: None,
            agent_id: Some(agent.to_owned()),
            requester: if requester.name.is_empty() { agent.to_owned() } else { requester.name.clone() },
            target: prompt.target.clone(),
            paths: prompt.paths.clone(),
            origin: upload.then(|| origin_of_url(&prompt.url)),
            receiver_origin: upload.then(|| prompt.receiver_origin.clone()),
            files: upload.then_some(files),
            remember,
            payment: prompt.payment.then_some(true),
        }
    }

    /// Raises the card and settles what its answer stores.
    async fn raise(&self, thread: &ThreadId, facts: &SessionFacts, grants: &SessionGrants, prompt: &BrowserApprovalPrompt, kinds: &[ActionKind], remember: Vec<ApprovalRemember>) -> Result<ApprovalAnswer, ToolError> {
        let agent = facts.agent_id.as_str();
        let scoped = call_approvals();
        let (gate, call_id): (Arc<dyn ApprovalGate>, Option<ToolCallId>) = match scoped {
            Some(approvals) => (approvals.gate, Some(approvals.call_id)),
            None => match self.context.session_gate(thread) {
                Some(gate) => (gate, None),
                None => return Err(unavailable("approvals", NO_APPROVAL_SURFACE)),
            },
        };
        let grantable = remember.len() > 1;
        let requester = mixdog_rt::time::timeout(REQUESTER_TIMEOUT, self.context.requester(thread)).await.unwrap_or_default();
        let id = uuid::Uuid::new_v4().to_string();
        let offer = grantable.then(|| BrowserApprovalRemember { kinds: prompt.kinds.clone(), session: facts.life.is_some().then_some(true) });
        let card = self.card(&id, agent, prompt, &requester, offer).await;
        let ask = ApprovalAsk {
            kind: ApprovalKind::Browser,
            call_id,
            tool: Some(TOOL.to_owned()),
            action_kind: kinds.first().copied(),
            reason: None,
            payload: json!({ "action": prompt.action, "request": serde_json::to_value(card).unwrap_or(Value::Null) }),
            remember: remember.into_iter().filter(|scope| *scope != ApprovalRemember::Once).collect(),
            expires_after: None,
        };
        // The card holds the human-only lock for its whole life: it ends with the answer, the run or the future.
        let hold = self.context.hold_card(&id, thread);
        let resolution = gate.request(ask).await;
        drop(hold);
        let (answer, device) = match resolution {
            ApprovalResolution::Decided { decision, device, .. } if decision.approved => {
                let scope = match decision.remember {
                    Some(ApprovalRemember::Session) if grantable => Remember::Session,
                    Some(ApprovalRemember::Agent | ApprovalRemember::Always) if grantable => Remember::Always,
                    _ => Remember::Once,
                };
                (ApprovalAnswer::Allow { remember: scope }, device)
            }
            ApprovalResolution::Decided { decision, device, .. } => (ApprovalAnswer::Deny { reason: decision.reason.unwrap_or_default() }, device),
            ApprovalResolution::TimedOut { .. } | ApprovalResolution::Withdrawn { .. } => (ApprovalAnswer::Deny { reason: String::new() }, String::new()),
            ApprovalResolution::Unavailable { .. } => (ApprovalAnswer::Deny { reason: NO_APPROVAL_SURFACE.to_owned() }, String::new()),
            // The run was stopped while the card waited: nobody answered.
            ApprovalResolution::Interrupted { .. } | ApprovalResolution::Cancelled { .. } => return Err(cancelled()),
        };
        if grantable {
            self.settle(agent, facts, grants, kinds, &answer, &device).await;
        }
        Ok(answer)
    }

    /// What an answer stores: the audit line, the session's allowance, the saved allow.
    async fn settle(&self, agent: &str, facts: &SessionFacts, grants: &SessionGrants, kinds: &[ActionKind], answer: &ApprovalAnswer, device: &str) {
        let remember = match answer {
            ApprovalAnswer::Deny { .. } => return self.audit(agent, kinds, "deny").await,
            ApprovalAnswer::Allow { remember } => *remember,
        };
        self.audit(agent, kinds, "approve").await;
        match remember {
            Remember::Once => {}
            Remember::Session => {
                if let Some(life) = facts.life.as_deref() {
                    let stored: Vec<bool> = kinds.iter().map(|kind| grants.grant(agent, &GrantKey::Kind(*kind), life)).collect();
                    if stored.iter().all(|stored| *stored) {
                        self.audit(agent, kinds, "session-granted").await;
                    }
                }
            }
            Remember::Always => {
                let mut saved = true;
                for kind in kinds {
                    // Not saved (the store is unreachable): this step ran once and the next asks again.
                    saved &= matches!(self.store.grant(agent, &GrantKey::Kind(*kind), ApprovalRemember::Agent, device).await, Ok(true));
                }
                if saved {
                    self.audit(agent, kinds, "granted").await;
                }
            }
        }
    }
}

#[async_trait]
impl ApprovalPort for BrowserApprovals {
    async fn ask(&self, prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        let thread = prompt.thread_id.clone().unwrap_or_else(|| ThreadId::from(prompt.session_id.as_str()));
        let mut facts = self.context.facts(&thread);
        // What a core-hosted session sent the desktop made it an attended turn: the run that owns the session changes nothing here.
        facts.run = None;
        // A standing allow is a bot's own; nothing else (a sub-agent, a task session, a coding session) is asked.
        if facts.acting_bot.is_none() {
            return Ok(ApprovalAnswer::Allow { remember: Remember::Once });
        }
        let kinds: Vec<ActionKind> = prompt.kinds.iter().filter_map(|kind| action_kind_of(*kind)).collect();
        let grants = self.context.session_grants(&thread);
        let settings = self.context.settings();
        match self.judge(&facts, &grants, settings, &prompt, &kinds).await {
            Verdict::Run => Ok(ApprovalAnswer::Allow { remember: Remember::Once }),
            Verdict::Refuse => Err(ToolError::new(ToolErrorCode::DeniedByPolicy { rule: "blocked".to_owned() }, BLOCKED_BY_PERMISSION)),
            Verdict::Ask { remember } => self.raise(&thread, &facts, &grants, &prompt, &kinds, remember).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use bytes::Bytes;
    use mixdog_app_protocol::v2::browser_engine::BrowserApprovalFile;
    use mixdog_browser_engine::types::FileFacts;
    use mixdog_protocol::ConnectionKind;
    use mixdog_protocol::ToolApprovalDecision;

    use super::*;
    use crate::orch::service::CallApprovals;
    use crate::orch::service::with_call_approvals;
    use crate::policy::grants::MemoryGrantStore;
    use crate::policy::grants::PermissionMode;
    use crate::policy::run_policy::RunKind;
    use crate::policy::session_grants::SessionGrantRegistry;

    const LIFE: &str = "5:0";

    fn decided(approved: bool, remember: Option<ApprovalRemember>, reason: Option<&str>) -> ApprovalResolution {
        ApprovalResolution::Decided {
            decision: ToolApprovalDecision {
                approved,
                reason: reason.map(str::to_owned),
                answers: None,
                reply: None,
                response: None,
                edited_args: None,
                remember,
                scope: None,
            },
            device: "desktop".to_owned(),
            connection_kind: ConnectionKind::Desktop,
            at: 1,
        }
    }

    /// The approval gate: answers each card from `answers` (a refusal when none is left) and keeps what it was asked.
    #[derive(Default)]
    struct Gate {
        answers: Mutex<VecDeque<ApprovalResolution>>,
        asked: Mutex<Vec<ApprovalAsk>>,
    }

    impl Gate {
        fn answer(&self, resolution: ApprovalResolution) {
            self.answers.lock().unwrap().push_back(resolution);
        }

        fn asked(&self) -> Vec<ApprovalAsk> {
            self.asked.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ApprovalGate for Gate {
        async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
            self.asked.lock().unwrap().push(ask);
            self.answers.lock().unwrap().pop_front().unwrap_or_else(|| decided(false, None, None))
        }
    }

    struct Ctx {
        gate: Arc<Gate>,
        registry: Arc<SessionGrantRegistry>,
        allow_all: AtomicBool,
        life: Mutex<Option<String>>,
        run: Mutex<Option<RunKind>>,
        held: Arc<AtomicUsize>,
        released: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ApprovalContext for Ctx {
        fn facts(&self, thread: &ThreadId) -> SessionFacts {
            // `sess_home_<bot>` is a bot's own chat; any other session is no bot's.
            let bot = thread.as_str().strip_prefix("sess_home_").map(str::to_owned);
            SessionFacts {
                agent_id: bot.clone().unwrap_or_else(|| "lead".to_owned()),
                acting_bot: bot,
                life: self.life.lock().unwrap().clone(),
                run: *self.run.lock().unwrap(),
                ..SessionFacts::default()
            }
        }

        fn settings(&self) -> PolicySettings {
            PolicySettings { allow_all_actions: self.allow_all.load(Ordering::SeqCst) }
        }

        fn session_grants(&self, thread: &ThreadId) -> SessionGrants {
            SessionGrants::of(self.registry.clone(), thread.as_str())
        }

        async fn requester(&self, thread: &ThreadId) -> Requester {
            Requester { name: thread.as_str().trim_start_matches("sess_home_").to_owned(), cwd: Some("/proj".to_owned()) }
        }

        fn session_gate(&self, _: &ThreadId) -> Option<Arc<dyn ApprovalGate>> {
            Some(self.gate.clone())
        }

        fn hold_card(&self, _: &str, _: &ThreadId) -> CardHold {
            self.held.fetch_add(1, Ordering::SeqCst);
            let released = self.released.clone();
            CardHold::new(move || {
                released.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    struct Disk;

    #[async_trait]
    impl FilePort for Disk {
        async fn stat(&self, path: &Path) -> FileFacts {
            FileFacts { exists: true, canonical: Some(path.to_path_buf()), ..FileFacts::default() }
        }

        async fn write_frame(&self, run_dir: &Path, _: Bytes, _: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    struct Rig {
        store: Arc<MemoryGrantStore>,
        ctx: Arc<Ctx>,
        approvals: Arc<BrowserApprovals>,
    }

    fn rig() -> Rig {
        let store = Arc::new(MemoryGrantStore::default());
        let ctx = Arc::new(Ctx {
            gate: Arc::new(Gate::default()),
            registry: SessionGrantRegistry::new(),
            allow_all: AtomicBool::new(false),
            life: Mutex::new(None),
            run: Mutex::new(None),
            held: Arc::default(),
            released: Arc::default(),
        });
        let approvals = BrowserApprovals::new(store.clone(), ctx.clone(), Arc::new(Disk));
        Rig { store, ctx, approvals }
    }

    fn step(session: &str, kinds: &[BrowserApprovalRememberKind]) -> BrowserApprovalPrompt {
        BrowserApprovalPrompt {
            thread_id: Some(ThreadId::from(session)),
            action: "click".to_owned(),
            url: "https://a.example/form?token=abc123".to_owned(),
            session_id: session.to_owned(),
            target: "Send".to_owned(),
            kinds: kinds.to_vec(),
            ..BrowserApprovalPrompt::default()
        }
    }

    use BrowserApprovalRememberKind::Confirm;
    use BrowserApprovalRememberKind::Post;
    use BrowserApprovalRememberKind::Submit;
    use BrowserApprovalRememberKind::Upload;

    impl Rig {
        /// Asks `prompt` with `answer` ready for its card; whether a card was raised and what the port answered.
        async fn ask(&self, prompt: BrowserApprovalPrompt, answer: ApprovalResolution) -> (bool, Result<ApprovalAnswer, ToolError>) {
            self.ctx.gate.answer(answer);
            let before = self.ctx.gate.asked().len();
            let outcome = self.approvals.ask(prompt).await;
            (self.ctx.gate.asked().len() > before, outcome)
        }

        fn allow(&self, agent: &str, kind: ActionKind, mode: PermissionMode) {
            self.store.set_mode(agent, &GrantKey::Kind(kind), mode);
        }

        fn decisions(&self) -> Vec<String> {
            self.store.audit().into_iter().map(|row| row.decision).collect()
        }
    }

    fn allowed(outcome: &Result<ApprovalAnswer, ToolError>) -> bool {
        matches!(outcome, Ok(ApprovalAnswer::Allow { .. }))
    }

    const MARKETER: &str = "sess_home_marketer";

    #[tokio::test]
    async fn a_session_that_is_no_bot_runs_every_kind_without_a_card() {
        let rig = rig();
        for kinds in [&[Submit][..], &[Post], &[Upload], &[Confirm], &[Submit, Confirm]] {
            let (shown, outcome) = rig.ask(step("sess_coding", kinds), decided(false, None, None)).await;
            assert!(!shown && allowed(&outcome), "{kinds:?}");
        }
        assert!(rig.store.audit().is_empty() && rig.ctx.held.load(Ordering::SeqCst) == 0);
    }

    #[tokio::test]
    async fn a_bot_asks_and_the_card_is_the_one_the_desktop_showed() {
        let rig = rig();
        let (shown, outcome) = rig.ask(step(MARKETER, &[Submit]), decided(true, None, None)).await;
        assert!(shown);
        assert_eq!(outcome.unwrap(), ApprovalAnswer::Allow { remember: Remember::Once });
        let asked = rig.ctx.gate.asked();
        assert_eq!((asked[0].kind, asked[0].tool.as_deref(), asked[0].action_kind), (ApprovalKind::Browser, Some("browser"), Some(ActionKind::BrowserSubmit)));
        let card = &asked[0].payload["request"];
        assert_eq!(asked[0].payload["action"], "click");
        assert_eq!((card["agentId"].as_str(), card["requester"].as_str(), card["target"].as_str()), (Some("marketer"), Some("marketer"), Some("Send")));
        assert!(!card["url"].as_str().unwrap().contains("abc123"), "the url is redacted: {card}");
        assert_eq!(card["remember"], json!({ "kinds": ["submit"] }));
        assert!(card.get("payment").is_none() && card.get("files").is_none());
        assert_eq!((rig.ctx.held.load(Ordering::SeqCst), rig.ctx.released.load(Ordering::SeqCst)), (1, 1), "the card held the lock and let it go");
    }

    #[tokio::test]
    async fn always_allow_is_kept_for_that_bot_and_kind_and_its_next_use_runs_without_a_card() {
        let rig = rig();
        let (_, first) = rig.ask(step(MARKETER, &[Submit]), decided(true, Some(ApprovalRemember::Agent), None)).await;
        assert_eq!(first.unwrap(), ApprovalAnswer::Allow { remember: Remember::Always });
        let key = GrantKey::Kind(ActionKind::BrowserSubmit);
        assert_eq!(rig.store.mode_for("marketer", &key, false).await.unwrap(), PermissionMode::Allow);
        let (shown, second) = rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await;
        assert!(!shown && allowed(&second));
        assert_eq!(rig.decisions(), ["approve", "granted", "remembered"]);
    }

    #[tokio::test]
    async fn another_bot_another_kind_a_mixed_command_and_a_revoked_allow_are_asked_again() {
        let rig = rig();
        rig.allow("marketer", ActionKind::BrowserSubmit, PermissionMode::Allow);
        assert!(rig.ask(step("sess_home_clerk", &[Submit]), decided(false, None, None)).await.0);
        assert!(rig.ask(step(MARKETER, &[Post]), decided(false, None, None)).await.0, "a send/post click is another kind");
        assert!(rig.ask(step(MARKETER, &[Submit, Post]), decided(true, None, None)).await.0, "every kind of the command must be allowed");
        rig.allow("marketer", ActionKind::BrowserSubmit, PermissionMode::Ask);
        assert!(rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await.0, "revoked");
    }

    #[tokio::test]
    async fn an_operator_confirm_asks_once_and_is_never_remembered() {
        let rig = rig();
        rig.allow("marketer", ActionKind::BrowserSubmit, PermissionMode::Allow);
        let (shown, outcome) = rig.ask(step(MARKETER, &[Confirm]), decided(true, Some(ApprovalRemember::Agent), None)).await;
        assert!(shown);
        assert_eq!(outcome.unwrap(), ApprovalAnswer::Allow { remember: Remember::Once }, "where none was offered, always is a single allow");
        assert!(rig.ctx.gate.asked()[0].payload["request"]["remember"].is_null());
        assert!(rig.ctx.gate.asked()[0].remember.is_empty());
        assert!(rig.ask(step(MARKETER, &[Submit, Confirm]), decided(false, None, None)).await.0, "one kind that always asks keeps the whole command asking");
    }

    #[tokio::test]
    async fn allow_all_actions_lets_a_bot_run_unasked_and_its_block_refuses() {
        let rig = rig();
        for kinds in [&[Submit][..], &[Post], &[Upload], &[Submit, Post, Upload]] {
            assert!(rig.ask(step(MARKETER, kinds), decided(false, None, None)).await.0, "off {kinds:?}");
        }
        rig.ctx.allow_all.store(true, Ordering::SeqCst);
        for kinds in [&[Submit][..], &[Post], &[Upload], &[Submit, Post, Upload], &[Confirm], &[Submit, Confirm]] {
            let (shown, outcome) = rig.ask(step(MARKETER, kinds), decided(false, None, None)).await;
            assert!(!shown && allowed(&outcome), "on {kinds:?}");
        }
        assert_eq!(rig.decisions().iter().filter(|decision| *decision == "dev-allow-all").count(), 7, "one line per kind of each unasked step");
        rig.allow("marketer", ActionKind::BrowserUpload, PermissionMode::Block);
        let (shown, outcome) = rig.ask(step(MARKETER, &[Submit, Upload]), decided(true, None, None)).await;
        assert!(!shown);
        assert_eq!(outcome.unwrap_err().message_for_model, BLOCKED_BY_PERMISSION);
        // With the option off a block does not refuse: the step is asked, as it was.
        rig.ctx.allow_all.store(false, Ordering::SeqCst);
        assert!(rig.ask(step(MARKETER, &[Upload]), decided(false, None, None)).await.0);
    }

    #[tokio::test]
    async fn allow_for_this_session_needs_a_life_mark_covers_one_kind_and_a_new_life_asks_again() {
        let rig = rig();
        // No life mark: the session choice is not offered and stores nothing.
        let (_, bare) = rig.ask(step(MARKETER, &[Submit]), decided(true, Some(ApprovalRemember::Session), None)).await;
        assert_eq!(bare.unwrap(), ApprovalAnswer::Allow { remember: Remember::Once });
        assert_eq!(rig.ctx.gate.asked()[0].payload["request"]["remember"], json!({ "kinds": ["submit"] }));
        assert!(rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await.0);

        *rig.ctx.life.lock().unwrap() = Some(LIFE.to_owned());
        let (_, granted) = rig.ask(step(MARKETER, &[Submit]), decided(true, Some(ApprovalRemember::Session), None)).await;
        assert_eq!(granted.unwrap(), ApprovalAnswer::Allow { remember: Remember::Session });
        assert_eq!(rig.ctx.gate.asked()[2].payload["request"]["remember"], json!({ "kinds": ["submit"], "session": true }));
        let mut other_page = step(MARKETER, &[Submit]);
        other_page.url = "https://elsewhere.example/other".to_owned();
        let (shown, again) = rig.ask(other_page, decided(false, None, None)).await;
        assert!(!shown && allowed(&again), "any page of the session");
        assert!(rig.decisions().contains(&"session-granted".to_owned()) && rig.decisions().contains(&"session-remembered".to_owned()));
        assert_eq!(rig.store.mode_for("marketer", &GrantKey::Kind(ActionKind::BrowserSubmit), false).await.unwrap(), PermissionMode::Ask, "nothing is saved for always");
        assert!(rig.ask(step(MARKETER, &[Post]), decided(false, None, None)).await.0, "another kind");
        assert!(rig.ask(step("sess_home_other", &[Submit]), decided(false, None, None)).await.0, "another session");
        *rig.ctx.life.lock().unwrap() = Some("5:900".to_owned());
        assert!(rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await.0, "a cleared session has another mark");
    }

    #[tokio::test]
    async fn a_session_allowance_is_removed_by_a_block_and_a_denied_card_stores_none() {
        let rig = rig();
        *rig.ctx.life.lock().unwrap() = Some(LIFE.to_owned());
        assert!(!allowed(&rig.ask(step(MARKETER, &[Submit]), decided(false, None, Some("no"))).await.1));
        assert!(rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await.0, "a denial stored no allowance");
        rig.ask(step(MARKETER, &[Submit]), decided(true, Some(ApprovalRemember::Session), None)).await;
        rig.allow("marketer", ActionKind::BrowserSubmit, PermissionMode::Block);
        assert!(rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await.0, "a block wins over the session's allowance");
    }

    #[tokio::test]
    async fn a_payment_is_a_floor_once_only_no_grant_not_skipped_by_allow_all_and_no_block_read() {
        let rig = rig();
        *rig.ctx.life.lock().unwrap() = Some(LIFE.to_owned());
        rig.allow("payer", ActionKind::BrowserSubmit, PermissionMode::Allow);
        let mut pay = step("sess_home_payer", &[Submit]);
        pay.payment = true;
        let (shown, outcome) = rig.ask(pay.clone(), decided(true, Some(ApprovalRemember::Agent), None)).await;
        assert!(shown);
        assert_eq!(outcome.unwrap(), ApprovalAnswer::Allow { remember: Remember::Once });
        let asked = rig.ctx.gate.asked();
        assert_eq!(asked[0].payload["request"]["payment"], true);
        assert!(asked[0].payload["request"]["remember"].is_null() && asked[0].remember.is_empty());
        // "Allow all actions" does not skip it, and a block does not refuse it.
        rig.ctx.allow_all.store(true, Ordering::SeqCst);
        rig.allow("payer", ActionKind::BrowserSubmit, PermissionMode::Block);
        assert!(rig.ask(pay.clone(), decided(false, None, None)).await.0);
        // Answering "session" on it stores nothing for an ordinary submit either.
        rig.ctx.allow_all.store(false, Ordering::SeqCst);
        rig.allow("payer", ActionKind::BrowserSubmit, PermissionMode::Ask);
        rig.ask(pay, decided(true, Some(ApprovalRemember::Session), None)).await;
        assert!(rig.ask(step("sess_home_payer", &[Submit]), decided(false, None, None)).await.0);
        assert!(!rig.decisions().iter().any(|decision| ["blocked", "dev-allow-all", "granted", "session-granted", "remembered"].contains(&decision.as_str())), "a payment is judged by no allowance: {:?}", rig.decisions());
    }

    /// Owner direction 11: a core-hosted session sent the desktop no `turn_id`, `session_life` or `unattended_*`, so it was an
    /// attended turn: the port adds no ask where that one did not ask.
    #[tokio::test]
    async fn no_new_ask_for_core_session() {
        let rig = rig();
        for (kinds, session) in [(&[Submit][..], "sess_coding"), (&[Confirm], "sess_task"), (&[Upload], "sess_agent_worker")] {
            let (shown, outcome) = rig.ask(step(session, kinds), decided(false, None, None)).await;
            assert!(!shown && allowed(&outcome), "{session} {kinds:?}");
        }
        rig.allow("marketer", ActionKind::BrowserSubmit, PermissionMode::Allow);
        let (shown, outcome) = rig.ask(step(MARKETER, &[Submit]), decided(false, None, None)).await;
        assert!(!shown && allowed(&outcome), "a saved allow runs it unasked");
    }

    /// A bot's session an unattended run owns, whose command carries no unattended field (as a core-hosted one never did), is
    /// decided as an attended turn: it asks where that asked and is refused nowhere a card would have answered.
    #[tokio::test]
    async fn unattended_core_session_unchanged() {
        let rig = rig();
        *rig.ctx.run.lock().unwrap() = Some(RunKind::Schedule);
        let (shown, outcome) = rig.ask(step(MARKETER, &[Submit]), decided(true, None, None)).await;
        assert!(shown && allowed(&outcome), "asks as an attended turn did");
        let mut pay = step(MARKETER, &[Post]);
        pay.payment = true;
        let (shown, outcome) = rig.ask(pay, decided(true, None, None)).await;
        assert!(shown && allowed(&outcome), "a payment asks; it is not refused");
        // The engine's own unattended fields change nothing either.
        let mut flagged = step(MARKETER, &[Upload]);
        flagged.unattended = true;
        flagged.unattended_agent = "marketer".to_owned();
        let (shown, _) = rig.ask(flagged, decided(false, None, None)).await;
        assert!(shown);
        // A session allowance, known to the core, may remove a repeat ask.
        *rig.ctx.life.lock().unwrap() = Some(LIFE.to_owned());
        rig.ask(step(MARKETER, &[Post]), decided(true, Some(ApprovalRemember::Session), None)).await;
        let (shown, outcome) = rig.ask(step(MARKETER, &[Post]), decided(false, None, None)).await;
        assert!(!shown && allowed(&outcome));
    }

    #[tokio::test]
    async fn a_denial_note_reaches_the_agent_and_a_stopped_run_is_cancelled() {
        let rig = rig();
        let (_, denied) = rig.ask(step(MARKETER, &[Submit]), decided(false, None, Some("not this one"))).await;
        assert_eq!(denied.unwrap(), ApprovalAnswer::Deny { reason: "not this one".to_owned() });
        let (_, timed_out) = rig.ask(step(MARKETER, &[Submit]), ApprovalResolution::TimedOut { at: 1 }).await;
        assert_eq!(timed_out.unwrap(), ApprovalAnswer::Deny { reason: String::new() });
        let (_, stopped) = rig.ask(step(MARKETER, &[Submit]), ApprovalResolution::Cancelled { at: 1 }).await;
        assert_eq!(stopped.unwrap_err().code, ToolErrorCode::Cancelled);
        let (_, no_ui) = rig.ask(step(MARKETER, &[Submit]), ApprovalResolution::Unavailable { at: 1 }).await;
        assert_eq!(no_ui.unwrap(), ApprovalAnswer::Deny { reason: NO_APPROVAL_SURFACE.to_owned() });
        assert_eq!(rig.ctx.held.load(Ordering::SeqCst), rig.ctx.released.load(Ordering::SeqCst), "every card let the lock go");
        assert_eq!(rig.decisions(), ["deny", "deny", "deny"], "a stopped run answers nothing and audits nothing");
    }

    #[tokio::test]
    async fn the_card_goes_through_the_gate_of_the_tool_call_asking() {
        let rig = rig();
        let scoped = Arc::new(Gate::default());
        scoped.answer(decided(true, None, None));
        let outcome = with_call_approvals(CallApprovals { gate: scoped.clone(), call_id: ToolCallId::from("call-9") }, rig.approvals.ask(step(MARKETER, &[Submit]))).await;
        assert!(allowed(&outcome));
        assert_eq!(scoped.asked().len(), 1);
        assert_eq!(scoped.asked()[0].call_id, Some(ToolCallId::from("call-9")));
        assert!(rig.ctx.gate.asked().is_empty(), "the session's own gate is for commands no tool call made");
    }

    #[tokio::test]
    async fn an_upload_card_carries_the_origin_each_file_and_marks_files_outside_the_project() {
        let rig = rig();
        let mut upload = step(MARKETER, &[Upload]);
        upload.action = "upload".to_owned();
        upload.url = "https://a.example/form".to_owned();
        upload.receiver_origin = "https://cdn.example".to_owned();
        upload.paths = vec!["/proj/a.txt".to_owned(), "/etc/b.txt".to_owned()];
        upload.files = ["/proj/a.txt", "/etc/b.txt"]
            .map(|path| BrowserApprovalFile { name: path.rsplit('/').next().unwrap().to_owned(), path: path.to_owned(), size: 3, outside: false })
            .to_vec();
        rig.ask(upload, decided(false, None, None)).await;
        let card = &rig.ctx.gate.asked()[0].payload["request"];
        assert_eq!((card["origin"].as_str(), card["receiverOrigin"].as_str()), (Some("https://a.example"), Some("https://cdn.example")));
        let outside: Vec<bool> = card["files"].as_array().unwrap().iter().map(|file| file["outside"].as_bool().unwrap()).collect();
        assert_eq!(outside, [false, true]);
        assert_eq!(card["remember"], json!({ "kinds": ["upload"] }));
    }
}
