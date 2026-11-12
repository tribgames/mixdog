//! Durable server requests and multi-client arbitration (P §8, SPEC R18, R41).
//!
//! The owning session actor persists `approval{requested}` before the request is published
//! and `approval{decided|expired}` before it is applied: the waiting run resumes, every
//! eligible connection receives `serverRequest/resolved`, and the thread shows
//! `toolApprovalResult`. The first decision that passes validation wins (P §8.4); later
//! decisions for the same id are no-ops, and a decision that fails validation is answered to
//! its sender only, through [`mixdog_core_api::ServerRequestSink::response_rejected`], leaving the request
//! pending.
//!
//! The request id is the data-dir-unique [`ApprovalId`]; it is also the per-surface
//! presentation order (P §8.5), so requests of a sub-agent and of its surface thread order by
//! allocation without a shared counter between their actors.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::time::Duration;

use bytes::Bytes;
use mixdog_app_protocol::rpc::JsonRpcNotification;
use mixdog_app_protocol::rpc::JsonRpcRequest;
use mixdog_app_protocol::rpc::RequestId;
use mixdog_app_protocol::v2::approval::ServerRequestResolvedParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::domain::approval::ApprovalRequest;
use mixdog_core_api::domain::approval::ChainLink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::HumanGateResponse;
use mixdog_protocol::ToolApprovalDecision;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::time::Instant;

pub mod devices;

/// Allocates approval ids unique in the data dir and increasing (P §8.2, §8.5). The composition
/// root's allocator reserves ranges durably in `state/core.sqlite`; a call waits only when
/// both reserved blocks are used up, and fails when that reservation fails.
#[async_trait::async_trait]
pub trait ApprovalIds: Send + Sync + 'static {
    async fn next(&self) -> Result<ApprovalId, CoreError>;
}

/// [`ApprovalIds`] over `mixdog_store::state::IdAllocator` (`IdAllocator::new(state,
/// "approval", block)`).
pub struct StoreApprovalIds(pub mixdog_store::state::IdAllocator);

impl StoreApprovalIds {
    /// The `approval` counter's ids: one durable reservation per [`Self::BLOCK`] ids.
    pub const BLOCK: u64 = 100;

    /// Over the core's `state/core.sqlite` (`CoreState::open`); reserves the first block.
    pub async fn open(state: mixdog_store::state::CoreState) -> Result<Self, mixdog_store::sqlite::DbError> {
        Ok(Self(mixdog_store::state::IdAllocator::new(state, "approval", Self::BLOCK).await?))
    }
}

#[async_trait::async_trait]
impl ApprovalIds for StoreApprovalIds {
    async fn next(&self) -> Result<ApprovalId, CoreError> {
        self.0
            .next()
            .await
            .map(ApprovalId)
            .map_err(|error| CoreError::BarrierFailed {
                scope: "approvalIds".into(),
                io_kind: error.to_string().into(),
            })
    }
}

/// Who answered: the device and kind of a connection, stamped on its decision (P §8.1).
/// Implemented by the server, which knows every connection it routes a response from.
pub trait Devices: Send + Sync + 'static {
    fn describe(&self, connection: ConnectionId) -> DeviceInfo;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device: String,
    pub kind: ConnectionKind,
}

/// Where a thread's requests are shown: the top-level chat and the delegation chain to it
/// (P §8.3 point 2). A top-level thread is its own surface with an empty chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lineage {
    pub surface: ThreadId,
    pub chain: Vec<ThreadId>,
}

impl Lineage {
    pub fn top_level(thread: &ThreadId) -> Self {
        Self {
            surface: thread.clone(),
            chain: Vec::new(),
        }
    }
}

/// An open request held by its actor.
struct Open {
    request: ApprovalRequest,
    rid: TurnId,
    /// The waiting run; `None` once it left (dropped future) or after a reload.
    waiter: Option<oneshot::Sender<ApprovalResolution>>,
    deadline: Option<Instant>,
    /// A resolution record is pending: later decisions are no-ops.
    resolving: bool,
}

/// The open approvals of one actor, their waiters and the request deadlines (the actor's one
/// timer wheel, P §8.4 `timedOut`).
#[derive(Default)]
pub struct ApprovalBook {
    open: HashMap<ApprovalId, Open>,
    deadlines: BTreeSet<(Instant, ApprovalId)>,
}

/// A decision that passed validation.
#[derive(Debug)]
pub struct Accepted {
    pub aid: ApprovalId,
    pub rid: TurnId,
    pub resolution: ApprovalResolution,
}

/// The wait limit of a request that names none (`resolveToolApprovalTimeoutMs`, tool-approval.mjs:30): none unless
/// `MIXDOG_TOOL_APPROVAL_TIMEOUT_MS` sets one (tests and ops), one second at least.
fn default_limit() -> Option<Duration> {
    static LIMIT: std::sync::OnceLock<Option<Duration>> = std::sync::OnceLock::new();
    *LIMIT.get_or_init(|| {
        let value = mixdog_js::string_to_number(&std::env::var("MIXDOG_TOOL_APPROVAL_TIMEOUT_MS").unwrap_or_default());
        (value.is_finite() && value > 0.0).then(|| Duration::from_millis(value.round().max(1000.0) as u64))
    })
}

/// Node's session api resolved every person's answer with `decision.reason || (approved ? 'approved by user' : 'denied by user')`
/// (session-api/lifecycle.mjs:74, over what `normalizeHumanResponse` returned): a refusal without words reads as the person's, never
/// as the reason the card asked for.
pub fn word_as_the_persons(resolution: &mut ApprovalResolution) {
    if let ApprovalResolution::Decided { decision, .. } = resolution
        && decision.reason.as_deref().is_none_or(str::is_empty)
    {
        decision.reason = Some(if decision.approved { "approved by user" } else { "denied by user" }.to_owned());
    }
}

impl ApprovalBook {
    /// Builds the request record for `ask`. The caller persists it and calls [`Self::insert`].
    pub fn request(
        aid: ApprovalId,
        thread: &ThreadId,
        lineage: &Lineage,
        mut ask: ApprovalAsk,
        requested_at_ms: i64,
    ) -> ApprovalRequest {
        ask.expires_after = ask.expires_after.or_else(default_limit);
        let expires_at = ask
            .expires_after
            .map(|after| std::time::UNIX_EPOCH + ms(requested_at_ms) + after);
        ApprovalRequest {
            id: aid,
            thread_id: thread.clone(),
            surface_thread_id: lineage.surface.clone(),
            chain: lineage
                .chain
                .iter()
                .map(|thread_id| ChainLink {
                    thread_id: thread_id.clone(),
                    agent: None,
                })
                .collect(),
            order: aid.0,
            requested_at: std::time::UNIX_EPOCH + ms(requested_at_ms),
            expires_at,
            ask,
        }
    }

    pub fn insert(
        &mut self,
        request: ApprovalRequest,
        rid: TurnId,
        waiter: Option<oneshot::Sender<ApprovalResolution>>,
    ) {
        let deadline = request.ask.expires_after.map(|after| Instant::now() + after);
        if let Some(deadline) = deadline {
            self.deadlines.insert((deadline, request.id));
        }
        self.open.insert(
            request.id,
            Open {
                request,
                rid,
                waiter,
                deadline,
                resolving: false,
            },
        );
    }

    /// Ids that accept a decision now (published to the control cell for RT-C pre-checks).
    pub fn decidable(&self) -> Vec<ApprovalId> {
        self.open
            .iter()
            .filter(|(_, open)| !open.resolving)
            .map(|(aid, _)| *aid)
            .collect()
    }

    /// The request a surface shows now (Node's `state.toolApproval`, the head of its FIFO): the
    /// first by order that still accepts a decision.
    pub fn shown(&self) -> Option<&ApprovalRequest> {
        self.open.values().filter(|open| !open.resolving).map(|open| &open.request).min_by_key(|request| request.order)
    }

    /// What every request still held (pending or resolving, until its resolution is durable) asked.
    pub fn open_asks(&self) -> impl Iterator<Item = &ApprovalAsk> {
        self.open.values().map(|open| &open.request.ask)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.deadlines.first().map(|(at, _)| *at)
    }

    /// Requests whose deadline passed, marked resolving.
    pub fn expired(&mut self, now: Instant) -> Vec<(ApprovalId, TurnId)> {
        let mut out = Vec::new();
        while let Some(&(at, aid)) = self.deadlines.first() {
            if at > now {
                break;
            }
            self.deadlines.pop_first();
            if let Some(open) = self.open.get_mut(&aid)
                && !open.resolving
            {
                open.resolving = true;
                out.push((aid, open.rid.clone()));
            }
        }
        out
    }

    /// Open requests of run `rid`, marked resolving (its abort or end, P §8.4 `interrupted`).
    pub fn take_run(&mut self, rid: &TurnId) -> Vec<ApprovalId> {
        let mut out: Vec<ApprovalId> = self
            .open
            .iter_mut()
            .filter(|(_, open)| !open.resolving && &open.rid == rid)
            .map(|(aid, open)| {
                open.resolving = true;
                *aid
            })
            .collect();
        out.sort();
        out
    }

    /// P §8.4 step 2: still pending, decodes, allowed for this request. The decision is the card's canonical response
    /// (`normalizeHumanResponse`), which words no reason: the session that takes it does ([`word_as_the_persons`]). `Ok(None)` is a
    /// decision for a request that is resolved or resolving (step 4: a no-op).
    pub fn validate(
        &mut self,
        request: &ServerRequestId,
        result: &Value,
        device: DeviceInfo,
        at_ms: i64,
    ) -> Result<Option<Accepted>, CoreError> {
        let Some(aid) = parse_id(request) else {
            return Ok(None);
        };
        let Some(open) = self.open.get_mut(&aid) else {
            return Ok(None);
        };
        if open.resolving {
            return Ok(None);
        }
        let rejected = |detail: &str| CoreError::InvalidServerRequestResponse {
            request_id: request.clone(),
            detail: detail.into(),
        };
        let decision: ToolApprovalDecision =
            serde_json::from_value(result.clone()).map_err(|_| rejected("result"))?;
        let decision = normalize_decision(&open.request.ask, decision);
        open.resolving = true;
        Ok(Some(Accepted {
            aid,
            rid: open.rid.clone(),
            resolution: ApprovalResolution::Decided {
                decision,
                device: device.device,
                connection_kind: device.kind,
                at: at_ms,
            },
        }))
    }

    /// The resolution record of `aid` is durable: the request is forgotten and its run resumes.
    pub fn resolved(&mut self, aid: ApprovalId, resolution: &ApprovalResolution) {
        if let Some(open) = self.open.remove(&aid) {
            if let Some(deadline) = open.deadline {
                self.deadlines.remove(&(deadline, aid));
            }
            if let Some(waiter) = open.waiter {
                let _ = waiter.send(resolution.clone());
            }
        }
    }

    /// Hands `resolution` to the waiting run now, ahead of its durable record. For a run that is
    /// being closed or aborted, whose token fires right after: Node resolves the pending approval
    /// `interrupted` and then aborts, so the run must see that resolution before it sees the
    /// cancel, however long the record takes to land. The record's ack ([`Self::resolved`]) later
    /// finds nobody left to tell.
    pub fn answer(&mut self, aid: ApprovalId, resolution: &ApprovalResolution) {
        if let Some(waiter) = self.open.get_mut(&aid).and_then(|open| open.waiter.take()) {
            let _ = waiter.send(resolution.clone());
        }
    }

    /// A resolution record failed its barrier: the request is pending again.
    pub fn unresolve(&mut self, aid: ApprovalId) {
        if let Some(open) = self.open.get_mut(&aid) {
            open.resolving = false;
        }
    }

    /// A request record failed its barrier: it never existed.
    pub fn forget(&mut self, aid: ApprovalId) {
        if let Some(open) = self.open.remove(&aid) {
            if let Some(deadline) = open.deadline {
                self.deadlines.remove(&(deadline, aid));
            }
        }
    }
}

const HUMAN_REQUEST_KINDS: [&str; 6] = ["approval", "outbound", "secret", "takeover", "permission", "connector"];
const PAYLOAD_LIMIT: usize = 40_000;

/// `RESPONSES_BY_KIND[kind]`: the granting response first, the refusing one last.
fn responses_of(kind: &str) -> &'static [HumanGateResponse] {
    use HumanGateResponse::*;
    match kind {
        "outbound" => &[Approve, EditAndApprove, Deny],
        "secret" => &[ProvideSecret, Skip],
        "takeover" => &[Done, Deny],
        _ => &[Approve, Deny],
    }
}

/// `GRANTING_RESPONSES`.
fn grants(response: HumanGateResponse) -> bool {
    matches!(
        response,
        HumanGateResponse::Approve | HumanGateResponse::EditAndApprove | HumanGateResponse::ProvideSecret | HumanGateResponse::Done
    )
}

fn remember_name(scope: ApprovalRemember) -> &'static str {
    match scope {
        ApprovalRemember::Once => "once",
        ApprovalRemember::Session => "session",
        ApprovalRemember::Agent => "agent",
        ApprovalRemember::Always => "always",
    }
}

/// The answer a request takes from a client's decision. A human-kind request (one whose card
/// lists `remember`) answers with Node's canonical response (`normalizeHumanResponse`, applied by
/// the approval queue, `tool-approval-settle.mjs`): an unknown or contradicting response falls back
/// to the card's polarity, edits survive only on an outbound card's editable fields, a scope the
/// card did not offer (or any scope of a refusal) is `once`, and a permission or connector scope
/// only when it was one of the choices. Any other request keeps the decision, without a scope it
/// did not offer. A decision is never refused for what it chose: Node drops it.
fn normalize_decision(ask: &ApprovalAsk, mut decision: ToolApprovalDecision) -> ToolApprovalDecision {
    let payload = ask.payload.as_object();
    let field = |key: &str| payload.and_then(|fields| fields.get(key));
    let polarity = decision.approved;
    let Some(offered) = field("remember").and_then(Value::as_array) else {
        decision.remember = decision
            .remember
            .filter(|scope| polarity && (*scope == ApprovalRemember::Once || ask.remember.contains(scope)));
        return decision;
    };
    let kind = field("kind").and_then(Value::as_str).filter(|kind| HUMAN_REQUEST_KINDS.contains(kind)).unwrap_or("approval");
    let allowed = responses_of(kind);
    let fallback = if polarity { allowed[0] } else { allowed[allowed.len() - 1] };
    let asked = decision.response.filter(|response| allowed.contains(response));
    let mut response = asked.filter(|asked| grants(*asked) == polarity).unwrap_or(fallback);
    let mut edited = None;
    if response == HumanGateResponse::EditAndApprove {
        let editable = field("outbound").and_then(|outbound| outbound.get("editable")).and_then(Value::as_array);
        let edits: std::collections::BTreeMap<String, String> = editable
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|name| {
                let text = decision.edited_args.as_ref()?.get(name)?;
                Some((name.to_owned(), mixdog_js::slice_utf16(text, PAYLOAD_LIMIT)))
            })
            .collect();
        if edits.is_empty() {
            response = HumanGateResponse::Approve;
        } else {
            edited = Some(edits);
        }
    }
    decision.response = Some(response);
    decision.edited_args = edited;
    let listed = |scope: ApprovalRemember| offered.iter().any(|name| name.as_str() == Some(remember_name(scope)));
    decision.remember = Some(decision.remember.filter(|scope| polarity && listed(*scope)).unwrap_or(ApprovalRemember::Once));
    let choices: Vec<&str> = match kind {
        "permission" => field("permission")
            .and_then(|permission| permission.get("scopes"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|scope| scope.get("id").and_then(Value::as_str))
            .collect(),
        "connector" => field("connector")
            .and_then(|connector| connector.get("choices"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect(),
        _ => Vec::new(),
    };
    decision.scope = decision.scope.filter(|scope| polarity && choices.contains(&scope.as_str()));
    decision
}

fn ms(value: i64) -> Duration {
    Duration::from_millis(u64::try_from(value).unwrap_or(0))
}

fn epoch_ms(at: std::time::SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub fn parse_id(request: &ServerRequestId) -> Option<ApprovalId> {
    request.as_str().parse().ok().map(ApprovalId)
}

/// The server request params: the asker's kind-specific fields (`payload`, an object) with
/// the actor's envelope (P §8.2, `ApprovalEnvelope`).
pub fn request_params(request: &ApprovalRequest, rid: &TurnId) -> Value {
    let mut params = match &request.ask.payload {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    params.insert("threadId".into(), json!(request.thread_id));
    params.insert("turnId".into(), json!(rid));
    if let Some(call) = &request.ask.call_id {
        params.insert("itemId".into(), json!(call));
    }
    if request.surface_thread_id != request.thread_id {
        params.insert("surfaceThreadId".into(), json!(request.surface_thread_id));
        params.insert(
            "chain".into(),
            json!(
                request
                    .chain
                    .iter()
                    .map(|link| &link.thread_id)
                    .collect::<Vec<_>>()
            ),
        );
    }
    params.insert("requestedAt".into(), json!(epoch_ms(request.requested_at)));
    if let Some(expires_at) = request.expires_at {
        params.insert("expiresAt".into(), json!(epoch_ms(expires_at)));
    }
    params.insert("order".into(), json!(request.order));
    Value::Object(params)
}

/// The JSON-RPC request frame (id = the approval id as a string, P §8.2).
pub fn request_frame(request: &ApprovalRequest, params: Value) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&JsonRpcRequest {
            id: RequestId::String(request.id.request_id().0),
            method: request.ask.kind.method().as_str().to_owned(),
            params: Some(params),
            trace: None,
            lone_surrogates: Vec::new(),
        })
        .expect("protocol types serialize"),
    )
}

/// `serverRequest/resolved{threadId, requestId, resolution}` (connection-scoped, no feed).
pub fn resolved_frame(
    thread: &ThreadId,
    aid: ApprovalId,
    resolution: &ApprovalResolution,
) -> Bytes {
    let params = ServerRequestResolvedParams {
        thread_id: thread.clone(),
        request_id: RequestId::String(aid.request_id().0),
        resolution: resolution.clone(),
    };
    Bytes::from(
        serde_json::to_vec(&JsonRpcNotification {
            method: "serverRequest/resolved".to_owned(),
            params: Some(serde_json::to_value(params).expect("protocol types serialize")),
            emitted_at_ms: None,
            feed: None,
            lone_surrogates: Vec::new(),
        })
        .expect("protocol types serialize"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::approval::ApprovalKind;

    fn ask(remember: Vec<ApprovalRemember>) -> ApprovalAsk {
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: None,
            tool: Some("shell".into()),
            action_kind: None,
            reason: None,
            payload: json!({"kind": "shell", "tool": "shell", "request": {"target": "ls"}}),
            remember,
            expires_after: None,
        }
    }

    fn device() -> DeviceInfo {
        DeviceInfo {
            device: "desktop-1".into(),
            kind: ConnectionKind::Desktop,
        }
    }

    #[test]
    fn first_valid_decision_wins_and_invalid_ones_leave_it_pending() {
        let thread = ThreadId::from("t");
        let mut book = ApprovalBook::default();
        let aid = ApprovalId(7);
        let request = ApprovalBook::request(
            aid,
            &thread,
            &Lineage::top_level(&thread),
            ask(vec![ApprovalRemember::Session]),
            1000,
        );
        book.insert(request, TurnId::from("r"), None);
        let id = aid.request_id();

        let err = book
            .validate(&id, &json!({"approved": "yes"}), device(), 1)
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidServerRequestResponse { .. }));
        assert_eq!(book.decidable(), vec![aid]);

        let won = book
            .validate(&id, &json!({"approved": true, "remember": "session"}), device(), 5)
            .unwrap()
            .expect("first valid decision");
        assert_eq!(won.aid, aid);
        assert!(book.validate(&id, &json!({"approved": false}), device(), 6).unwrap().is_none());
        assert!(book.decidable().is_empty());
        assert!(
            book.validate(&ServerRequestId("nope".into()), &json!({}), device(), 6)
                .unwrap()
                .is_none()
        );
    }

    /// A person's answer without words reads as the person's (Node's session api: `'denied by user'` / `'approved by user'`); words they
    /// gave are kept. The book's own normalization adds none.
    #[test]
    fn an_answer_without_a_reason_is_the_persons() {
        let thread = ThreadId::from("t");
        let reason_of = |answer: Value| {
            let mut book = ApprovalBook::default();
            let aid = ApprovalId(1);
            book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), ask(vec![]), 1000), TurnId::from("r"), None);
            let mut accepted = book.validate(&aid.request_id(), &answer, device(), 1).unwrap().expect("accepted");
            let unworded = match &accepted.resolution {
                ApprovalResolution::Decided { decision, .. } => decision.reason.clone(),
                _ => panic!("decided"),
            };
            word_as_the_persons(&mut accepted.resolution);
            let ApprovalResolution::Decided { decision, .. } = accepted.resolution else { panic!("decided") };
            (unworded, decision.reason)
        };
        assert_eq!(reason_of(json!({"approved": false})), (None, Some("denied by user".to_owned())));
        assert_eq!(reason_of(json!({"approved": true, "reason": ""})).1.as_deref(), Some("approved by user"));
        assert_eq!(reason_of(json!({"approved": false, "reason": "not now"})).1.as_deref(), Some("not now"));
    }

    /// `normalizeHumanResponse`: a scope the card did not offer is answered `once`, never refused.
    #[test]
    fn a_scope_the_card_did_not_offer_is_answered_once() {
        let thread = ThreadId::from("t");
        let mut book = ApprovalBook::default();
        let aid = ApprovalId(8);
        let mut card = ask(vec![ApprovalRemember::Session, ApprovalRemember::Always]);
        card.payload = json!({"kind": "approval", "remember": ["once", "session", "always"], "grantAction": "tool:shell"});
        book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), card, 1000), TurnId::from("r"), None);
        let accepted = book
            .validate(&aid.request_id(), &json!({"approved": true, "remember": "agent"}), device(), 5)
            .unwrap()
            .expect("the decision is taken");
        let ApprovalResolution::Decided { decision, .. } = accepted.resolution else { panic!("decided") };
        assert_eq!(serde_json::to_value(decision).unwrap(), json!({"approved": true, "response": "approve", "remember": "once"}));
    }

    #[test]
    fn params_carry_the_envelope_and_the_askers_fields() {
        let thread = ThreadId::from("child");
        let lineage = Lineage {
            surface: ThreadId::from("lead"),
            chain: vec![ThreadId::from("lead")],
        };
        let mut a = ask(vec![]);
        a.expires_after = Some(Duration::from_secs(2));
        let request = ApprovalBook::request(ApprovalId(3), &thread, &lineage, a, 1000);
        let params = request_params(&request, &TurnId::from("r1"));
        assert_eq!(
            params,
            json!({
                "kind": "shell", "tool": "shell", "request": {"target": "ls"},
                "threadId": "child", "turnId": "r1", "surfaceThreadId": "lead",
                "chain": ["lead"], "requestedAt": 1000, "expiresAt": 3000, "order": 3
            })
        );
        let frame: Value = serde_json::from_slice(&request_frame(&request, params)).unwrap();
        assert_eq!(frame["id"], json!("3"));
        assert_eq!(frame["method"], json!("item/tool/requestApproval"));
    }

    /// A close or abort answers the waiting run `interrupted` at once; the durable record
    /// that follows has nobody left to tell.
    #[test]
    fn an_answer_reaches_the_waiting_run_before_the_record_is_durable() {
        let thread = ThreadId::from("t");
        let mut book = ApprovalBook::default();
        let aid = ApprovalId(4);
        let request = ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), ask(vec![]), 1000);
        let (waiter, mut answered) = oneshot::channel();
        book.insert(request, TurnId::from("r"), Some(waiter));
        assert_eq!(book.take_run(&TurnId::from("r")), vec![aid]);
        let interrupted = ApprovalResolution::Interrupted { at: 7 };
        book.answer(aid, &interrupted);
        assert!(matches!(answered.try_recv(), Ok(ApprovalResolution::Interrupted { at: 7 })), "answered before the ack");
        book.resolved(aid, &interrupted);
        assert!(book.decidable().is_empty() && book.open_asks().next().is_none(), "the ack forgets the request");
    }

    /// A takeover card the core times out is announced to clients as `serverRequest/resolved`: that
    /// frame is what ends the page the desktop handed over (`apps/desktop/src/main/takeover-feed.ts`),
    /// and the request it answers is what started the takeover there.
    #[test]
    fn a_takeover_card_that_times_out_is_announced_resolved_to_the_clients() {
        let thread = ThreadId::from("t");
        let mut book = ApprovalBook::default();
        let aid = ApprovalId(9);
        let mut card = ask(Vec::new());
        card.payload = json!({"kind": "takeover", "takeover": {"surface": "browser", "instructions": "sign in"}});
        card.expires_after = Some(Duration::from_secs(15 * 60));
        let request = ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), card, 1000);
        let params = request_params(&request, &TurnId::from("r"));
        assert_eq!((params["kind"].clone(), params["threadId"].clone()), (json!("takeover"), json!("t")));
        assert_eq!(params["takeover"]["surface"], "browser");
        assert!(params["expiresAt"].is_number(), "the card carries its own deadline");
        book.insert(request, TurnId::from("r"), None);
        assert!(book.expired(Instant::now() + Duration::from_secs(14 * 60)).is_empty(), "not before the deadline");
        assert_eq!(book.expired(Instant::now() + Duration::from_secs(16 * 60)).len(), 1);
        let frame: Value = serde_json::from_slice(&resolved_frame(&thread, aid, &ApprovalResolution::TimedOut { at: 5 })).unwrap();
        assert_eq!(frame["method"], "serverRequest/resolved");
        assert_eq!(frame["params"], json!({"threadId": "t", "requestId": aid.request_id().0, "resolution": {"kind": "timedOut", "at": 5}}));
    }
}