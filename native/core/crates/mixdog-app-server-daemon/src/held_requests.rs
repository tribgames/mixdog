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
//! An answered request is audited twice, as in Node: `settle` records it under the held row's
//! identity (`record_decision`, before the hold returns) and the policy gate records it again
//! under the call's identity (`ToolPolicy::record_decision` on the resolution this returns).
//!
//! Which runs reach the hold is decided upstream, per ask: the policy gate never asks for a
//! schedule or webhook run (`ToolPolicy::ask`, Node `isGrantedRun`), so only a room member's ask
//! arrives, and `HeldApprovals::request` holds it when no approval UI was attached to its thread
//! when its turn was assembled (Node's hook belongs to the turn, not to the ask).

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
use mixdog_tools::policy::AuditEntry;
use mixdog_tools::policy::GrantKey;
use mixdog_tools::policy::GrantStore;
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
    /// An approval UI is attached to the thread's surface (Node: the turn has a
    /// `toolApprovalHook`). Read once per turn, when its gate is assembled; a held request is used only when none is.
    fn ui_attached(&self, thread: &ThreadId) -> bool;
    /// Posts the row into the agent's home thread (`deliverHeldRequest`). A failure is logged
    /// and never fails the hold.
    async fn deliver(&self, agent_id: &str, held: &HeldRequest) -> Result<(), String>;
    /// The sanitized phone push (`notifyHeldRequest`): ids and the agent's name only.
    fn push(&self, event: &HeldPush);
    /// `mixyDisplayName()` for the Lead, the id otherwise. A file read on the lane: a dropped lane job is `Err` (no default name), and the hold skips the push.
    async fn agent_name(&self, agent_id: &str) -> Result<String, String>;
    /// A fresh id suffix; the id is `held_` + this.
    fn new_id(&self) -> String;
    /// The store an answered request's audit line and grant are written to (`humanGateStore()`).
    fn grants(&self) -> Arc<dyn GrantStore>;
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
    /// Held while a delivery is started, so the deliveries of all requests start in the order they were posted.
    starts: Mutex<()>,
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
        Arc::new(Self { home, now_ms, pending: Mutex::new(HashMap::new()), starts: Mutex::new(()) })
    }

    /// The approval entry point of one thread's run: held when the thread is an unattended run
    /// with no approval UI, the session's own otherwise.
    pub fn gate_for(self: &Arc<Self>, thread: ThreadId, inner: Arc<dyn ApprovalGate>) -> Arc<dyn ApprovalGate> {
        let attended = self.home.ui_attached(&thread);
        Arc::new(HeldApprovals { held: Arc::clone(self), thread, inner, attended })
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
        self.lock().insert(id.clone(), Entry { held: held.clone(), remember: offered.clone(), editable, outbound, reply });
        // The run being cancelled drops this future: that denies the request. An answered
        // request is already out of the table, so the guard finds nothing then.
        let _guard = CancelGuard { held: self, id: id.clone() };
        self.post(&run.agent_id, &held);
        let home_agent = agent_home_session_id(&run.agent_id).or_else(|| agent_home_session_id(MIXY_AGENT_ID)).unwrap_or_default();
        // A lane job dropped at shutdown cannot name the agent: no push, logged, like the other shutdown-time failures (the row is already posted).
        match self.home.agent_name(&run.agent_id).await {
            Ok(agent_name) => self.home.push(&HeldPush { session_id: home_agent, agent_id: run.agent_id.clone(), agent_name, request_id: id }),
            Err(error) => tracing::warn!(id, "held request push skipped, the agent name could not be read: {error}"),
        }
        let resolution = answer.await.unwrap_or(ApprovalResolution::Cancelled { at: (self.now_ms)() });
        if let ApprovalResolution::Decided { decision, device, .. } = &resolution {
            let response = decision.response.and_then(|response| serde_json::to_value(response).ok());
            let response = response.as_ref().and_then(Value::as_str).unwrap_or(if decision.approved { "approve" } else { "deny" });
            // Before the run goes on to the policy gate's own record of the same answer, as `settle` starts this one first.
            record_decision(self.home.grants().as_ref(), &held, &offered, decision.approved, response, decision.remember, device).await;
        }
        resolution
    }

    /// `post(agentId, held)`: starts the delivery and does not wait for it (`void post(...)`). Delivery waits for the home thread's
    /// queue to persist the row; the push, the answer and the audit never wait on that. Node starts the deliveries in call order
    /// (`Promise.resolve().then(deliver)`, one microtask each): the delivery is polled to its first wait right here, under `starts`,
    /// so the home thread's queue sees the pending row before the settled one; the rest of it runs on a task of its own.
    fn post(&self, agent_id: &str, held: &HeldRequest) {
        let (home, agent_id, held) = (Arc::clone(&self.home), agent_id.to_owned(), held.clone());
        let mut delivery = Box::pin(async move {
            if let Err(error) = home.deliver(&agent_id, &held).await {
                tracing::warn!(id = held.id, "held request could not be delivered: {error}");
            }
        });
        let _order = self.starts.lock().unwrap_or_else(PoisonError::into_inner);
        if delivery.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())).is_pending() {
            drop(mixdog_rt::spawn("held-request-deliver", mixdog_rt::TaskClass::Work, delivery));
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
        self.post(&settled.agent_id, &settled);
        let _ = entry.reply.send(ApprovalResolution::Decided { decision, device: answer.device, connection_kind: kind, at });
        true
    }

}

/// `recordHumanDecision(entry.gate, approval)` of `settle`: the audit line of an answered held
/// request and the grant it may store, under the held row's own identity (the gate Node builds in
/// `hold`: the run's agent, the row's kind, action, tool and target). The policy gate records the
/// same answer once more under the call's identity, as `askApproval` does after the hold returns.
/// A scope the row did not offer stores nothing, and neither does `session`: the gate has no
/// session to keep it for.
async fn record_decision(
    store: &dyn GrantStore,
    held: &HeldRequest,
    offered: &[ApprovalRemember],
    approved: bool,
    response: &str,
    remember: Option<ApprovalRemember>,
    device: &str,
) {
    let entry = |decision: &str| AuditEntry {
        agent_id: held.agent_id.clone(),
        kind: held.kind.clone(),
        action: held.action.clone().unwrap_or_default(),
        tool: held.tool.clone(),
        target: held.target.clone(),
        decision: decision.to_owned(),
        device: device.to_owned(),
        at_ms: None,
    };
    let mut granted = false;
    if let (true, Some(action), Some(scope)) = (approved, held.action.as_deref().and_then(GrantKey::parse), remember)
        && matches!(scope, ApprovalRemember::Agent | ApprovalRemember::Always)
        && offered.contains(&scope)
    {
        match store.grant(&held.agent_id, &action, scope, device).await {
            Ok(stored) => granted = stored,
            Err(error) => tracing::warn!(id = held.id, "held request grant failed: {error}"),
        }
    }
    for decision in std::iter::once(response).chain(granted.then_some("granted")) {
        if let Err(error) = store.record_audit(entry(decision)).await {
            tracing::warn!(id = held.id, "held request audit failed: {error}");
        }
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

/// The composition's approval routing: every run's asks pass the held layer, which decides per ask
/// (`HeldApprovals::request`) as `resolvePreToolAskApproval` does.
pub struct HeldGates(pub Arc<HeldRequests>);

impl mixdog_core::run_host::run_approvals::RunApprovals for HeldGates {
    fn gate_for(&self, thread: &ThreadId, own: Arc<dyn ApprovalGate>) -> Arc<dyn ApprovalGate> {
        self.0.gate_for(thread.clone(), own)
    }
}

/// Mixy's heartbeat counts the held requests still waiting as approvals (`pendingHeldRequests`).
#[async_trait]
impl mixdog_services::bots::beat::HeldRequests for HeldRequests {
    async fn pending(&self) -> Result<usize, String> {
        // The inherent `pending` (the rows) is the one named by the method call.
        Ok(self.pending().len())
    }
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
        self.held.post(&settled.agent_id, &settled);
        // The abort's own answer (`reason: 'run cancelled'`, no device) is audited as any other, whether or not the row was delivered.
        drop(mixdog_rt::spawn("held-request-cancel", mixdog_rt::TaskClass::Work, async move {
            record_decision(home.grants().as_ref(), &settled, &entry.remember, false, "deny", None, "").await;
        }));
    }
}

struct HeldApprovals {
    held: Arc<HeldRequests>,
    thread: ThreadId,
    inner: Arc<dyn ApprovalGate>,
    /// Whether an approval UI was attached when the turn was assembled. Node installs `toolApprovalHook` on the session for the whole
    /// turn when a client starts it (`ask-turn-execute.mjs:284-288`, restored at `:334-338`), so the clients leaving mid-turn changes
    /// nothing: the card waits in the turn's own queue. A turn assembled with none has none for all of its asks.
    attended: bool,
}

#[async_trait]
impl ApprovalGate for HeldApprovals {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        if !self.attended
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

    /// A counter the tests wait on (a semaphore that starts empty).
    struct Permits(tokio::sync::Semaphore);

    impl Default for Permits {
        fn default() -> Self {
            Self(tokio::sync::Semaphore::new(0))
        }
    }

    impl std::ops::Deref for Permits {
        type Target = tokio::sync::Semaphore;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    #[derive(Default)]
    struct Home {
        attached: AtomicBool,
        rows: Mutex<Vec<(String, HeldRequest)>>,
        pushes: Mutex<Vec<HeldPush>>,
        ids: AtomicU64,
        /// Delivery of a settled row never completes (a slow or wedged home thread).
        stall_settled: AtomicBool,
        store: Arc<mixdog_tools::policy::MemoryGrantStore>,
        /// One permit per row delivered: the tests wait on the delivery itself.
        delivered: Permits,
        /// Every delivery never completes.
        stall_all: AtomicBool,
        pushed: Permits,
        audited: Arc<Permits>,
        /// The status of every delivery, in the order the deliveries were started (before any wait).
        started: Mutex<Vec<HeldRequestStatus>>,
    }

    /// The store, signalling each audit line it takes.
    struct Audits(Arc<mixdog_tools::policy::MemoryGrantStore>, Arc<Permits>);

    #[async_trait]
    impl GrantStore for Audits {
        async fn mode_for(&self, agent_id: &str, action: &GrantKey, shared_only: bool) -> Result<mixdog_tools::policy::PermissionMode, mixdog_tools::policy::StoreError> {
            self.0.mode_for(agent_id, action, shared_only).await
        }
        async fn grant(&self, agent_id: &str, action: &GrantKey, scope: ApprovalRemember, device: &str) -> Result<bool, mixdog_tools::policy::StoreError> {
            self.0.grant(agent_id, action, scope, device).await
        }
        async fn record_audit(&self, entry: AuditEntry) -> Result<(), mixdog_tools::policy::StoreError> {
            let out = self.0.record_audit(entry).await;
            self.1.add_permits(1);
            out
        }
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
            self.started.lock().unwrap().push(held.status);
            if self.stall_all.load(Ordering::SeqCst) || (held.status != HeldRequestStatus::Pending && self.stall_settled.load(Ordering::SeqCst)) {
                std::future::pending::<()>().await;
            }
            self.rows.lock().unwrap().push((agent_id.to_owned(), held.clone()));
            self.delivered.add_permits(1);
            Ok(())
        }
        fn push(&self, event: &HeldPush) {
            self.pushes.lock().unwrap().push(event.clone());
            self.pushed.add_permits(1);
        }
        async fn agent_name(&self, agent_id: &str) -> Result<String, String> {
            Ok(agent_id.to_owned())
        }
        fn new_id(&self) -> String {
            self.ids.fetch_add(1, Ordering::SeqCst).to_string()
        }
        fn grants(&self) -> Arc<dyn GrantStore> {
            Arc::new(Audits(self.store.clone(), self.audited.clone()))
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

    /// Waits for the next row to be delivered.
    async fn next_delivery(home: &Home) {
        home.delivered.acquire().await.unwrap().forget();
    }

    async fn first_row(home: &Home) -> HeldRequest {
        next_delivery(home).await;
        home.rows.lock().unwrap().first().expect("a delivered row").1.clone()
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
        next_delivery(&home).await;
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
    async fn an_answer_reaches_the_waiting_run_and_the_resolving_call_returns_while_the_settled_row_is_still_being_delivered() {
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
        assert!(resolving.await.unwrap(), "the answer was accepted without waiting for the delivery");
        assert!(held.pending().is_empty());
    }

    /// Node starts the delivery on its own (`void post`): with a delivery that never completes the push goes out at once, an answer
    /// reaches the run and is audited, and a cancelled run is denied and audited.
    #[tokio::test]
    async fn a_delivery_that_never_completes_holds_back_neither_the_push_nor_the_answer_nor_the_audit() {
        let (home, held, gate) = setup();
        home.stall_all.store(true, Ordering::SeqCst);
        let answered = tokio::spawn({
            let gate = gate.clone();
            async move { gate.request(ask()).await }
        });
        home.pushed.acquire().await.unwrap().forget();
        assert_eq!(held.pending().len(), 1);
        let id = held.pending()[0].id.clone();
        assert!(held.resolve(&id, HeldAnswer { approved: true, ..HeldAnswer::default() }).await);
        let ApprovalResolution::Decided { decision, .. } = answered.await.unwrap() else { panic!("decided") };
        assert!(decision.approved);
        home.audited.acquire().await.unwrap().forget();
        assert!(held.pending().is_empty());

        let cancelled = tokio::spawn(async move { gate.request(ask()).await });
        home.pushed.acquire().await.unwrap().forget();
        cancelled.abort();
        let _ = cancelled.await;
        home.audited.acquire().await.unwrap().forget();
        assert!(held.pending().is_empty());
        assert!(home.rows.lock().unwrap().is_empty(), "no row was ever delivered");
    }

    /// Node starts the deliveries in call order, whatever they wait on (`Promise.resolve().then(deliver)` per `post`): the pending
    /// row's delivery is under way, waiting on a home thread that never answers, before the answer posts the settled row. Both
    /// are polled once by hand with no yield in between, so no task of the runtime can have started either for us.
    #[test]
    fn deliveries_start_in_the_order_they_are_posted_even_when_the_first_never_completes() {
        let _ = mixdog_rt::testing::tokens();
        let home = Arc::new(Home::default());
        home.stall_all.store(true, Ordering::SeqCst);
        let held = HeldRequests::new(home.clone(), Arc::new(|| 42));
        let gate = held.gate_for(ThreadId::from("sess_rmem_abcdef_ann"), Arc::new(Inner));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        let mut asking = Box::pin(gate.request(ask()));
        assert!(asking.as_mut().poll(&mut context).is_pending());
        assert_eq!(*home.started.lock().unwrap(), [HeldRequestStatus::Pending], "the pending delivery started with the hold");
        assert_eq!(home.pushes.lock().unwrap().len(), 1);
        let id = held.pending()[0].id.clone();
        let mut resolving = Box::pin(held.resolve(&id, HeldAnswer { approved: true, ..HeldAnswer::default() }));
        assert!(matches!(resolving.as_mut().poll(&mut context), std::task::Poll::Ready(true)));
        assert_eq!(*home.started.lock().unwrap(), [HeldRequestStatus::Pending, HeldRequestStatus::Approved]);
        assert!(matches!(asking.as_mut().poll(&mut context), std::task::Poll::Ready(ApprovalResolution::Decided { .. })));
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
        next_delivery(&home).await;
        assert!(held.pending().is_empty());
        assert_eq!(home.rows.lock().unwrap().len(), 2, "pending row, then the denied one");
    }

    /// `resolvePreToolAskApproval` recorded over Node (`fixtures/approval-surface/golden.json`): a
    /// run's ask goes to its owner exactly when no approval UI is attached; with one, or with no
    /// run to hold for, it stays with the surface's own gate.
    #[tokio::test]
    async fn a_run_is_held_exactly_when_node_holds_it() {
        let golden: Value = serde_json::from_str(include_str!("../../../fixtures/approval-surface/golden.json")).expect("golden parses");
        let rows = golden["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 4);
        for row in rows {
            let (home, _held, _) = setup();
            home.attached.store(row["hookPresent"].as_bool().unwrap(), Ordering::SeqCst);
            let held = HeldRequests::new(home.clone(), Arc::new(|| 42));
            let thread = if row["run"].is_null() { "sess_plain" } else { "sess_rmem_abcdef_ann" };
            let gate = held.gate_for(ThreadId::from(thread), Arc::new(Inner));
            if row["answeredBy"] == "held" {
                let waiting = tokio::spawn(async move { gate.request(ask()).await });
                first_row(&home).await;
                waiting.abort();
            } else {
                assert_eq!(gate.request(ask()).await, ApprovalResolution::Unavailable { at: 7 }, "{row}");
                assert!(home.rows.lock().unwrap().is_empty(), "{row}");
            }
        }
    }

    /// Mixy's heartbeat counts the requests still waiting as approvals (`held.length` of
    /// `collectHeartbeatFacts`): one while the run waits, none once it is answered.
    #[tokio::test]
    async fn the_heartbeat_counts_the_requests_still_waiting() {
        let (home, held, gate) = setup();
        let count = || <HeldRequests as mixdog_services::bots::beat::HeldRequests>::pending(&held);
        assert_eq!(count().await, Ok(0));
        let waiting = tokio::spawn(async move { gate.request(ask()).await });
        let row = first_row(&home).await;
        assert_eq!(count().await, Ok(1));
        assert!(held.resolve(&row.id, HeldAnswer { approved: true, ..HeldAnswer::default() }).await);
        waiting.await.unwrap();
        assert_eq!(count().await, Ok(0));
    }

    /// The ask goes to the surface's own gate (`Inner`, which answers `Unavailable`): its task finishes before any push is made. A held
    /// ask pushes and then waits for its answer, so it ends the wait on the push instead of hanging.
    async fn asked_of_the_surface(home: &Home, gate: Arc<dyn ApprovalGate>) -> ApprovalResolution {
        let asking = tokio::spawn(async move { gate.request(ask()).await });
        tokio::select! {
            answered = asking => answered.expect("the ask settles"),
            _ = home.pushed.acquire() => panic!("the ask was held, not asked of the surface's own gate"),
        }
    }

    #[tokio::test]
    async fn an_attached_ui_keeps_its_own_approval() {
        let (home, held, _) = setup();
        home.attached.store(true, Ordering::SeqCst);
        let gate = held.gate_for(ThreadId::from("sess_rmem_abcdef_ann"), Arc::new(Inner));
        assert_eq!(asked_of_the_surface(&home, gate).await, ApprovalResolution::Unavailable { at: 7 });
        assert!(home.rows.lock().unwrap().is_empty());
    }

    /// Node's hook belongs to the turn: the clients leaving mid-turn leaves the turn's asks with its own card.
    #[tokio::test]
    async fn a_turn_assembled_with_a_ui_keeps_its_own_approval_after_the_ui_leaves() {
        let (home, held, _) = setup();
        home.attached.store(true, Ordering::SeqCst);
        let gate = held.gate_for(ThreadId::from("sess_rmem_abcdef_ann"), Arc::new(Inner));
        home.attached.store(false, Ordering::SeqCst);
        assert_eq!(asked_of_the_surface(&home, gate).await, ApprovalResolution::Unavailable { at: 7 });
        assert!(home.rows.lock().unwrap().is_empty());
        assert!(held.pending().is_empty());
    }
}
