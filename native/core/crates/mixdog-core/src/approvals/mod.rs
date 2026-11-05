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
use mixdog_core_api::domain::approval::DecisionRejected;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
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
pub(crate) struct ApprovalBook {
    open: HashMap<ApprovalId, Open>,
    deadlines: BTreeSet<(Instant, ApprovalId)>,
}

/// A decision that passed validation.
#[derive(Debug)]
pub(crate) struct Accepted {
    pub aid: ApprovalId,
    pub rid: TurnId,
    pub resolution: ApprovalResolution,
}

impl ApprovalBook {
    /// Builds the request record for `ask`. The caller persists it and calls [`Self::insert`].
    pub fn request(
        aid: ApprovalId,
        thread: &ThreadId,
        lineage: &Lineage,
        ask: ApprovalAsk,
        requested_at_ms: i64,
    ) -> ApprovalRequest {
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

    /// P §8.4 step 2: still pending, decodes, allowed for this request. `Ok(None)` is a
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
        open.request
            .check_decision(&decision)
            .map_err(|reason| match reason {
                DecisionRejected::RememberNotAllowed => rejected("rememberNotAllowed"),
                DecisionRejected::UnrememberableAction => rejected("unrememberableAction"),
            })?;
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

fn ms(value: i64) -> Duration {
    Duration::from_millis(u64::try_from(value).unwrap_or(0))
}

fn epoch_ms(at: std::time::SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(crate) fn parse_id(request: &ServerRequestId) -> Option<ApprovalId> {
    request.as_str().parse().ok().map(ApprovalId)
}

/// The server request params: the asker's kind-specific fields (`payload`, an object) with
/// the actor's envelope (P §8.2, `ApprovalEnvelope`).
pub(crate) fn request_params(request: &ApprovalRequest, rid: &TurnId) -> Value {
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
pub(crate) fn request_frame(request: &ApprovalRequest, params: Value) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&JsonRpcRequest {
            id: RequestId::String(request.id.request_id().0),
            method: request.ask.kind.method().as_str().to_owned(),
            params: Some(params),
            trace: None,
        })
        .expect("protocol types serialize"),
    )
}

/// `serverRequest/resolved{threadId, requestId, resolution}` (connection-scoped, no feed).
pub(crate) fn resolved_frame(
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
        })
        .expect("protocol types serialize"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::approval::ApprovalKind;
    use mixdog_protocol::ApprovalRemember;

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
        let err = book
            .validate(&id, &json!({"approved": true, "remember": "always"}), device(), 1)
            .unwrap_err();
        assert_eq!(
            err,
            CoreError::InvalidServerRequestResponse {
                request_id: id.clone(),
                detail: "rememberNotAllowed".into()
            }
        );
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
}
