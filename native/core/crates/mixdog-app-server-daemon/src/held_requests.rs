//! Held requests (Node `session-runtime/held-requests.mjs` `createHeldRequests`,
//! `runtime/shared/held-request-host.mjs`, `human-gate/held-message.mjs`).
//!
//! A schedule or webhook run never asks and never holds (its saved routine is the user's grant;
//! the policy gate settles it before an approval is asked). A group-room member with no approval
//! UI attached is held instead of shown a card: the run pauses on the request, a `pending`
//! [`HeldRequest`] row is delivered to the owning agent's home thread, a phone push names only
//! the agent (no tool, arguments or text), and the request waits until the user answers it with
//! the held id (`resolve`) or the run is cancelled, which denies it. It never expires on a timer.
//!
//! The audit line and the remembered grant of an answered request are the policy gate's own
//! (`ToolPolicy::record_decision` runs on the resolution this returns), so unlike Node's hook
//! there is no separate record seam here.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::HeldRequest;
use mixdog_protocol::HeldRequestStatus;
use mixdog_protocol::HeldRun;
use mixdog_protocol::HeldRunKind;
use mixdog_protocol::HumanGateResponse;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use serde_json::Value;

/// The unattended run that owns a thread; `name` is the schedule or webhook name, or a room id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    pub kind: HeldRunKind,
    pub agent_id: String,
    pub name: String,
}

/// What the held layer needs from the process.
#[async_trait]
pub trait HeldHome: Send + Sync {
    /// The unattended run that owns `thread` (`unattendedRunOf`).
    async fn run_of(&self, thread: &ThreadId) -> Option<RunInfo>;
    /// An approval UI is attached to the thread's surface (Node: the run has a
    /// `toolApprovalHook`). A held request is used only when none is.
    fn ui_attached(&self, thread: &ThreadId) -> bool;
    /// Posts the row into the agent's home thread (`deliverHeldRequest`). A failure is logged
    /// and never fails the hold.
    async fn deliver(&self, agent_id: &str, held: &HeldRequest) -> Result<(), String>;
    /// The sanitized phone push (`notifyHeldRequest`): ids and the agent's name only.
    fn push(&self, event: &HeldPush);
    /// `mixyDisplayName()` for the Lead, the id otherwise.
    fn agent_name(&self, agent_id: &str) -> String;
    /// A fresh id suffix; the id is `held_` + this.
    fn new_id(&self) -> String;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldPush {
    pub session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub request_id: String,
}

/// An answer to a held request (the ordinary approval call with the held id).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeldAnswer {
    pub approved: bool,
    pub reason: Option<String>,
    pub device: String,
    pub connection_kind: Option<ConnectionKind>,
    pub response: Option<HumanGateResponse>,
    pub edited_args: Option<std::collections::BTreeMap<String, String>>,
    pub remember: Option<ApprovalRemember>,
}

struct Entry {
    held: HeldRequest,
    /// The scopes the gate offered, `once` first.
    remember: Vec<ApprovalRemember>,
    editable: Vec<String>,
    outbound: bool,
    reply: tokio::sync::oneshot::Sender<ApprovalResolution>,
}

pub struct HeldRequests {
    home: Arc<dyn HeldHome>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    pending: Mutex<HashMap<String, Entry>>,
}

/// `clean(value, limit)` of `held-message.mjs`.
fn clean(value: &str, limit: usize) -> String {
    let flat: String = value.chars().map(|c| if matches!(c, '\r' | '\n' | '"') { ' ' } else { c }).collect();
    mixdog_tools::exec::escape_harness_tags(flat.trim()).chars().take(limit).collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn scope_of(name: &str) -> Option<ApprovalRemember> {
    match name {
        "once" => Some(ApprovalRemember::Once),
        "session" => Some(ApprovalRemember::Session),
        "agent" => Some(ApprovalRemember::Agent),
        "always" => Some(ApprovalRemember::Always),
        _ => None,
    }
}

impl HeldRequests {
    pub fn new(home: Arc<dyn HeldHome>, now_ms: Arc<dyn Fn() -> i64 + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { home, now_ms, pending: Mutex::new(HashMap::new()) })
    }

    /// The approval entry point of one thread's run: held when the thread is an unattended run
    /// with no approval UI, the session's own otherwise.
    pub fn gate_for(self: &Arc<Self>, thread: ThreadId, inner: Arc<dyn ApprovalGate>) -> Arc<dyn ApprovalGate> {
        Arc::new(HeldApprovals { held: Arc::clone(self), thread, inner })
    }

    /// The held requests still waiting (`pendingHeldRequests`).
    pub fn pending(&self) -> Vec<HeldRequest> {
        let mut rows: Vec<HeldRequest> = self.lock().values().map(|entry| entry.held.clone()).collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        rows
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the pending request out of the table; `None` when it is not (or no longer) there.
    fn take(&self, id: &str) -> Option<Entry> {
        match self.lock().entry(id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(pending) => Some(pending.remove()),
            std::collections::hash_map::Entry::Vacant(_) => None,
        }
    }

    /// `hold(request)`: registers the request, posts its row and push, and waits for the answer.
    async fn hold(&self, thread: &ThreadId, run: RunInfo, ask: &ApprovalAsk) -> ApprovalResolution {
        let id = format!("held_{}", self.home.new_id());
        let payload = &ask.payload;
        let outbound = text(payload, "kind") == "outbound";
        let card = payload.get("outbound").cloned().unwrap_or(Value::Null);
        // The scopes the gate offered: its own grants, or once.
        let offered: Vec<ApprovalRemember> = payload
            .get("remember")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(|n| n.as_str().and_then(scope_of)).collect::<Vec<_>>())
            .filter(|scopes| !scopes.is_empty())
            .unwrap_or_else(|| vec![ApprovalRemember::Once]);
        let remember_names: Vec<String> = offered.iter().map(|s| remember_name(*s).to_owned()).collect();
        let account = |v: &Value| Some(clean(text(v, "account"), 200)).filter(|a| !a.is_empty());
        let held = HeldRequest {
            id: id.clone(),
            status: HeldRequestStatus::Pending,
            agent_id: run.agent_id.clone(),
            kind: Some(text(payload, "kind")).filter(|k| !k.is_empty()).unwrap_or("approval").to_owned(),
            tool: clean(text(payload, "name"), 200),
            target: clean(text(&card, "target"), 200),
            reason: clean(text(payload, "reason"), 400),
            payload: outbound.then(|| text(&card, "payload")).filter(|p| !p.is_empty()).map(|p| p.chars().take(4_000).collect()),
            action: outbound.then(|| clean(text(&card, "category"), 40)).filter(|a| !a.is_empty()),
            // An outbound card's own account (what the gate read) comes first.
            account: if outbound { account(&card).or_else(|| account(payload)) } else { account(payload) },
            editable: outbound
                .then(|| string_list(card.get("editable")).iter().map(|n| clean(n, 40)).collect::<Vec<_>>())
                .filter(|names| !names.is_empty()),
            details: outbound
                .then(|| {
                    card.get("details")
                        .and_then(Value::as_object)
                        .map(|map| {
                            map.iter()
                                .filter_map(|(k, v)| v.as_str().filter(|s| !s.is_empty()).map(|s| (clean(k, 40), clean(s, 200))))
                                .collect::<std::collections::BTreeMap<_, _>>()
                        })
                })
                .flatten(),
            remember: Some(remember_names),
            run: HeldRun { kind: run.kind, name: clean(&run.name, 200), session_id: Some(thread.as_str().to_owned()) },
            expires_at: None,
            device: None,
        };
        let (reply, answer) = tokio::sync::oneshot::channel();
        let editable = held.editable.clone().unwrap_or_default();
        self.lock().insert(id.clone(), Entry { held: held.clone(), remember: offered, editable, outbound, reply });
        // The run being cancelled drops this future: that denies the request. An answered
        // request is already out of the table, so the guard finds nothing then.
        let _guard = CancelGuard { held: self, id: id.clone() };
        self.post(&run.agent_id, &held).await;
        let home_agent = agent_home_session_id(&run.agent_id).or_else(|| agent_home_session_id(MIXY_AGENT_ID)).unwrap_or_default();
        self.home.push(&HeldPush {
            session_id: home_agent,
            agent_id: run.agent_id.clone(),
            agent_name: self.home.agent_name(&run.agent_id),
            request_id: id,
        });
        answer.await.unwrap_or(ApprovalResolution::Cancelled { at: (self.now_ms)() })
    }

    async fn post(&self, agent_id: &str, held: &HeldRequest) {
        if let Err(error) = self.home.deliver(agent_id, held).await {
            tracing::warn!(id = held.id, "held request could not be delivered: {error}");
        }
    }

    /// `resolve(id, decision)`: false when `id` is not pending (already settled). Answers the
    /// waiting run first, with no await before it, so a cancelled caller cannot leave an
    /// approval that went out unanswered; then posts the settled row (Node settles without
    /// awaiting the delivery).
    pub async fn resolve(&self, id: &str, answer: HeldAnswer) -> bool {
        let Some(entry) = self.take(id) else { return false };
        let approved = answer.approved;
        let mut response = if approved { HumanGateResponse::Approve } else { HumanGateResponse::Deny };
        if let Some(asked) = answer.response.filter(|asked| allowed(entry.outbound, *asked) && granting(*asked) == approved) {
            response = asked;
        }
        let mut edited_args = None;
        if response == HumanGateResponse::EditAndApprove {
            let edits: std::collections::BTreeMap<String, String> = answer
                .edited_args
                .unwrap_or_default()
                .into_iter()
                .filter(|(name, _)| entry.editable.contains(name))
                .map(|(name, value)| (name, value.chars().take(4_000).collect()))
                .collect();
            if edits.is_empty() {
                response = HumanGateResponse::Approve;
            } else {
                edited_args = Some(edits);
            }
        }
        // A scope the row did not offer counts as once.
        let remember = answer.remember.filter(|scope| approved && entry.remember.contains(scope)).unwrap_or(ApprovalRemember::Once);
        let reason = answer.reason.filter(|r| !r.is_empty()).unwrap_or_else(|| if approved { "approved by user" } else { "denied by user" }.to_owned());
        let decision = ToolApprovalDecision {
            approved,
            reason: Some(reason),
            answers: None,
            reply: None,
            response: Some(response),
            edited_args,
            remember: Some(remember),
            scope: None,
        };
        let mut settled = entry.held;
        settled.status = if approved { HeldRequestStatus::Approved } else { HeldRequestStatus::Denied };
        settled.device = Some(clean(&answer.device, 80)).filter(|d| !d.is_empty());
        let at = (self.now_ms)();
        let kind = answer.connection_kind.unwrap_or(ConnectionKind::Desktop);
        let _ = entry.reply.send(ApprovalResolution::Decided { decision, device: answer.device, connection_kind: kind, at });
        self.post(&settled.agent_id, &settled).await;
        true
    }

}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn remember_name(scope: ApprovalRemember) -> &'static str {
    match scope {
        ApprovalRemember::Once => "once",
        ApprovalRemember::Session => "session",
        ApprovalRemember::Agent => "agent",
        ApprovalRemember::Always => "always",
    }
}

/// `RESPONSES_BY_KIND`: an approval card answers approve or deny; an outbound one may also edit.
fn allowed(outbound: bool, response: HumanGateResponse) -> bool {
    matches!(response, HumanGateResponse::Approve | HumanGateResponse::Deny)
        || (outbound && response == HumanGateResponse::EditAndApprove)
}

fn granting(response: HumanGateResponse) -> bool {
    matches!(response, HumanGateResponse::Approve | HumanGateResponse::EditAndApprove)
}

/// Denies a held request whose asking future was dropped before it was answered.
struct CancelGuard<'a> {
    held: &'a HeldRequests,
    id: String,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        // The settled row is posted off the drop: the run is gone, the denial must still land.
        let Some(entry) = self.held.take(&self.id) else { return };
        let mut settled = entry.held;
        settled.status = HeldRequestStatus::Denied;
        let home = Arc::clone(&self.held.home);
        drop(mixdog_rt::spawn("held-request-cancel", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = home.deliver(&settled.agent_id, &settled).await {
                tracing::warn!(id = settled.id, "held request could not be delivered: {error}");
            }
        }));
    }
}

struct HeldApprovals {
    held: Arc<HeldRequests>,
    thread: ThreadId,
    inner: Arc<dyn ApprovalGate>,
}

#[async_trait]
impl ApprovalGate for HeldApprovals {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        if !self.held.home.ui_attached(&self.thread)
            && let Some(run) = self.held.home.run_of(&self.thread).await
        {
            return self.held.hold(&self.thread, run, &ask).await;
        }
        self.inner.request(ask).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::approval::ApprovalKind;
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Home {
        attached: AtomicBool,
        rows: Mutex<Vec<(String, HeldRequest)>>,
        pushes: Mutex<Vec<HeldPush>>,
        ids: AtomicU64,
        /// Delivery of a settled row never completes (a slow or wedged home thread).
        stall_settled: AtomicBool,
    }

    #[async_trait]
    impl HeldHome for Home {
        async fn run_of(&self, thread: &ThreadId) -> Option<RunInfo> {
            (thread.as_str() == "sess_rmem_abcdef_ann").then(|| RunInfo { kind: HeldRunKind::Room, agent_id: "ann".into(), name: "abcdef".into() })
        }
        fn ui_attached(&self, _: &ThreadId) -> bool {
            self.attached.load(Ordering::SeqCst)
        }
        async fn deliver(&self, agent_id: &str, held: &HeldRequest) -> Result<(), String> {
            if held.status != HeldRequestStatus::Pending && self.stall_settled.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            self.rows.lock().unwrap().push((agent_id.to_owned(), held.clone()));
            Ok(())
        }
        fn push(&self, event: &HeldPush) {
            self.pushes.lock().unwrap().push(event.clone());
        }
        fn agent_name(&self, agent_id: &str) -> String {
            agent_id.to_owned()
        }
        fn new_id(&self) -> String {
            self.ids.fetch_add(1, Ordering::SeqCst).to_string()
        }
    }

    struct Inner;
    #[async_trait]
    impl ApprovalGate for Inner {
        async fn request(&self, _: ApprovalAsk) -> ApprovalResolution {
            ApprovalResolution::Unavailable { at: 7 }
        }
    }

    fn ask() -> ApprovalAsk {
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: None,
            tool: Some("github".into()),
            action_kind: None,
            reason: Some("posts".into()),
            payload: json!({
                "name": "github", "kind": "outbound", "reason": "This sends or posts outside Mixdog",
                "args": {"body": "ARG-SENTINEL"},
                "outbound": {"target": "o/r#4", "account": "github.com", "payload": "ARG-SENTINEL", "category": "comment", "editable": ["body"]},
                "remember": ["once", "agent"],
            }),
            remember: vec![ApprovalRemember::Agent],
            expires_after: None,
        }
    }

    fn setup() -> (Arc<Home>, Arc<HeldRequests>, Arc<dyn ApprovalGate>) {
        let _ = mixdog_rt::testing::tokens();
        let home = Arc::new(Home::default());
        let held = HeldRequests::new(home.clone(), Arc::new(|| 42));
        let gate = held.gate_for(ThreadId::from("sess_rmem_abcdef_ann"), Arc::new(Inner));
        (home, held, gate)
    }

    async fn first_row(home: &Home) -> HeldRequest {
        loop {
            if let Some((_, row)) = home.rows.lock().unwrap().first() {
                return row.clone();
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn a_held_request_is_delivered_pushed_without_text_and_answered_by_id() {
        let (home, held, gate) = setup();
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move { gate.request(ask()).await }
        });
        let row = first_row(&home).await;
        assert_eq!((row.status, row.tool.as_str(), row.target.as_str(), row.run.kind), (HeldRequestStatus::Pending, "github", "o/r#4", HeldRunKind::Room));
        assert_eq!(row.action.as_deref(), Some("comment"));
        assert_eq!(row.remember.as_deref(), Some(&["once".to_owned(), "agent".to_owned()][..]));
        let pushes = home.pushes.lock().unwrap().clone();
        assert_eq!(pushes.len(), 1);
        assert_eq!((pushes[0].session_id.as_str(), pushes[0].agent_name.as_str()), ("sess_home_ann", "ann"));
        assert!(!format!("{pushes:?}").contains("ARG-SENTINEL"));
        let answer = HeldAnswer { approved: true, device: "Pixel".into(), remember: Some(ApprovalRemember::Agent), ..HeldAnswer::default() };
        assert!(held.resolve(&row.id, answer.clone()).await);
        assert!(!held.resolve(&row.id, answer).await, "a settled request answers nothing");
        let ApprovalResolution::Decided { decision, device, .. } = waiting.await.unwrap() else { panic!("decided") };
        assert_eq!((decision.approved, decision.remember, device.as_str()), (true, Some(ApprovalRemember::Agent), "Pixel"));
        let settled = home.rows.lock().unwrap().last().unwrap().1.clone();
        assert_eq!((settled.status, settled.device.as_deref()), (HeldRequestStatus::Approved, Some("Pixel")));
        assert!(held.pending().is_empty());
    }

    #[tokio::test]
    async fn a_scope_the_row_did_not_offer_counts_as_once_and_a_denial_never_remembers() {
        let (home, held, gate) = setup();
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move { gate.request(ask()).await }
        });
        let row = first_row(&home).await;
        held.resolve(&row.id, HeldAnswer { approved: true, remember: Some(ApprovalRemember::Always), ..HeldAnswer::default() }).await;
        let ApprovalResolution::Decided { decision, .. } = waiting.await.unwrap() else { panic!("decided") };
        assert_eq!(decision.remember, Some(ApprovalRemember::Once));
        assert_eq!(decision.response, Some(HumanGateResponse::Approve));
    }

    #[tokio::test]
    async fn an_answer_reaches_the_waiting_run_even_when_the_resolving_call_is_cancelled_in_delivery() {
        let (home, held, gate) = setup();
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move { gate.request(ask()).await }
        });
        let row = first_row(&home).await;
        home.stall_settled.store(true, Ordering::SeqCst);
        let resolving = tokio::spawn({
            let (held, id) = (held.clone(), row.id.clone());
            async move { held.resolve(&id, HeldAnswer { approved: true, ..HeldAnswer::default() }).await }
        });
        // The run is answered while the settled row is still being delivered.
        let ApprovalResolution::Decided { decision, .. } = waiting.await.unwrap() else { panic!("decided, not cancelled") };
        assert!(decision.approved);
        resolving.abort();
        assert!(resolving.await.unwrap_err().is_cancelled());
        assert!(held.pending().is_empty());
    }

    #[tokio::test]
    async fn dropping_the_asking_run_denies_the_request() {
        let (home, held, gate) = setup();
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move { gate.request(ask()).await }
        });
        first_row(&home).await;
        waiting.abort();
        let _ = waiting.await;
        assert!(held.pending().is_empty());
        assert_eq!(home.rows.lock().unwrap().len(), 2, "pending row, then the denied one");
    }

    #[tokio::test]
    async fn an_attached_ui_keeps_its_own_approval() {
        let (home, _held, gate) = setup();
        home.attached.store(true, Ordering::SeqCst);
        assert_eq!(gate.request(ask()).await, ApprovalResolution::Unavailable { at: 7 });
        assert!(home.rows.lock().unwrap().is_empty());
    }
}
