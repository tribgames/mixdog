//! A mock session actor for approvals (P §8.4; §14.9 "with a mock actor").
//!
//! It plays the part the server leaves to the owning actor: the pending set of one thread, the
//! check order of a decision, the first valid decision winning, and the other resolutions. All
//! it does to the outside goes through [`ServerRequestSink`], as the real actor's does, so the
//! server's side of arbitration (who may answer, who hears about it) is what the tests check.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::v2::approval::ServerRequestResolvedParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::MockThread;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_core_api::thread::Decision;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ToolApprovalDecision;
use serde_json::Value;
use serde_json::json;

use crate::sharded::lock;

struct Open {
    remember: Vec<ApprovalRemember>,
    expires_at: Option<i64>,
}

pub(crate) struct ApprovalActor {
    thread: ThreadId,
    sink: Arc<dyn ServerRequestSink>,
    clock: AtomicI64,
    next_order: AtomicU64,
    open: Mutex<HashMap<ServerRequestId, Open>>,
    /// The `approval.resolved` records, in the order they were persisted.
    resolved: Mutex<Vec<(ServerRequestId, ApprovalResolution)>>,
}

impl ApprovalActor {
    pub(crate) fn new(thread: &str, sink: Arc<dyn ServerRequestSink>) -> Self {
        Self {
            thread: ThreadId::from(thread),
            sink,
            clock: AtomicI64::new(1),
            next_order: AtomicU64::new(1),
            open: Mutex::default(),
            resolved: Mutex::default(),
        }
    }

    /// A request of this thread, shown on `surface`, offering the `remember` scopes beyond
    /// once and expiring at `expires_at`.
    pub(crate) fn ask(
        &self,
        id: &str,
        surface: &str,
        remember: &[ApprovalRemember],
        expires_at: Option<i64>,
    ) {
        let id = ServerRequestId(id.to_owned());
        lock(&self.open).insert(
            id.clone(),
            Open {
                remember: remember.to_vec(),
                expires_at,
            },
        );
        let frame = json!({
            "id": id.0,
            "method": "item/tool/requestApproval",
            "params": { "threadId": self.thread.as_str() },
        });
        self.sink.publish(PendingServerRequest {
            id,
            method: Method("item/tool/requestApproval"),
            thread: self.thread.clone(),
            surface: ThreadId::from(surface),
            order: self.next_order.fetch_add(1, Ordering::Relaxed),
            frame: Bytes::from(frame.to_string()),
        });
    }

    /// P §8.4 steps 2–5: still pending, decodes, allowed; the first that passes wins.
    pub(crate) fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        let resolution = {
            let mut open = lock(&self.open);
            // Every later Decide for a resolved request is a no-op.
            let Some(request) = open.get(&decision.request) else {
                return Ok(());
            };
            let verdict = serde_json::from_value::<ToolApprovalDecision>(decision.result.clone())
                .map_err(|error| error.to_string())
                .and_then(|parsed| match parsed.remember {
                    Some(scope)
                        if scope != ApprovalRemember::Once
                            && !request.remember.contains(&scope) =>
                    {
                        Err(format!("remember {scope:?} is not offered by this request"))
                    }
                    _ => Ok(parsed),
                });
            match verdict {
                Ok(parsed) => {
                    open.remove(&decision.request);
                    ApprovalResolution::Decided {
                        decision: parsed,
                        device: decision.device.clone(),
                        connection_kind: decision.connection_kind,
                        at: self.now(),
                    }
                }
                Err(detail) => {
                    drop(open);
                    // The request stays pending; only the sender hears of it.
                    self.sink.response_rejected(
                        decision.connection,
                        CoreError::InvalidServerRequestResponse {
                            request_id: decision.request,
                            detail: detail.into(),
                        },
                    );
                    return Ok(());
                }
            }
        };
        self.resolve(&decision.request, resolution);
        Ok(())
    }

    /// The actor's timer wheel: resolves every request whose own expiry is `now` or earlier.
    pub(crate) fn expire(&self, now: i64) {
        let mut due: Vec<ServerRequestId> = {
            let mut open = lock(&self.open);
            let due: Vec<_> = open
                .iter()
                .filter(|(_, request)| request.expires_at.is_some_and(|at| at <= now))
                .map(|(id, _)| id.clone())
                .collect();
            for id in &due {
                open.remove(id);
            }
            due
        };
        due.sort();
        for id in due {
            self.resolve(&id, ApprovalResolution::TimedOut { at: now });
        }
    }

    /// `turn/interrupt` of this thread, session close, or recovery after a restart: this
    /// thread's own requests only.
    pub(crate) fn interrupt(&self) {
        let mut ids: Vec<ServerRequestId> = lock(&self.open).drain().map(|(id, _)| id).collect();
        ids.sort();
        for id in ids {
            let at = self.now();
            self.resolve(&id, ApprovalResolution::Interrupted { at });
        }
    }

    pub(crate) fn pending(&self) -> usize {
        lock(&self.open).len()
    }

    pub(crate) fn resolutions(&self) -> Vec<(ServerRequestId, ApprovalResolution)> {
        lock(&self.resolved).clone()
    }

    fn now(&self) -> i64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    /// Persists the resolution, then applies it: every eligible connection is told.
    fn resolve(&self, id: &ServerRequestId, resolution: ApprovalResolution) {
        lock(&self.resolved).push((id.clone(), resolution.clone()));
        let params = ServerRequestResolvedParams {
            thread_id: self.thread.clone(),
            request_id: RequestId::String(id.0.clone()),
            resolution,
        };
        let frame = json!({ "method": "serverRequest/resolved", "params": params });
        self.sink.resolved(id, Bytes::from(frame.to_string()));
    }
}

/// A mock thread whose control plane is an [`ApprovalActor`].
pub(crate) struct ActorThread {
    pub(crate) thread: Arc<MockThread>,
    pub(crate) actor: ApprovalActor,
}

impl FeedSource for ActorThread {
    fn feed_id(&self) -> FeedId {
        self.thread.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        self.thread.attach(req)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.thread.detach(sub);
    }
}

impl RunControl for ActorThread {
    fn interrupt(&self, turn: &TurnId, restore_prompt: Option<bool>) -> Result<Value, CoreError> {
        let reply = self.thread.interrupt(turn, restore_prompt)?;
        self.actor.interrupt();
        Ok(reply)
    }

    fn steer(&self, expected_turn: &TurnId, input: Value, op: OpId) -> Result<Value, CoreError> {
        self.thread.steer(expected_turn, input, op)
    }

    fn active_turn(&self) -> Option<TurnId> {
        self.thread.active_turn()
    }

    fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        self.actor.decide(decision)
    }
}

#[async_trait]
impl ThreadHandle for ActorThread {
    fn id(&self) -> &ThreadId {
        self.thread.id()
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.thread.request(req).await
    }
}
