//! A mock core: every seam trait implemented over in-memory state, with programmable replies
//! and recorded calls.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

use super::EchoView;
use super::MockFeed;
use super::MockLimits;
use super::epoch;
use crate::call::CallContext;
use crate::call::CoreRequest;
use crate::call::Reply;
use crate::error::CoreError;
use crate::feed::AttachDecision;
use crate::feed::AttachRequest;
use crate::feed::FeedSource;
use crate::handle::CoreHandle;
use crate::handle::CoreState;
use crate::host::HostCapability;
use crate::host::HostChannel;
use crate::host::HostError;
use crate::host::HostMediaSink;
use crate::ids::ConnectionId;
use crate::ids::FeedId;
use crate::ids::Method;
use crate::ids::OpId;
use crate::ids::ServerRequestId;
use crate::ids::SubscriptionId;
use crate::ids::ThreadId;
use crate::ids::TurnId;
use crate::ops::OpIndex;
use crate::ops::OpScope;
use crate::ops::OpStatus;
use crate::server_request::PendingServerRequest;
use crate::server_request::ServerRequestSink;
use crate::service::Admit;
use crate::service::DomainService;
use crate::state::SectionChange;
use crate::state::StatePublisher;
use crate::thread::Decision;
use crate::thread::RunControl;
use crate::thread::ThreadDirectory;
use crate::thread::ThreadHandle;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A programmable reply.
pub type Handler = Arc<dyn Fn(&CoreRequest) -> Result<Reply, CoreError> + Send + Sync>;

/// Replies `{"method": <method>, "params": <params>}`.
fn echo() -> Handler {
    Arc::new(|req: &CoreRequest| {
        Ok(Reply::Value(json!({
            "method": req.method.as_str(),
            "params": req.params,
        })))
    })
}

pub struct MockCore {
    threads: MockDirectory,
    app_feed: Arc<MockFeed>,
    ops: MockOpIndex,
    domains: HashMap<String, Arc<MockDomain>>,
    media: MockHostMedia,
    lifecycle: watch::Sender<CoreState>,
}

impl MockCore {
    /// A serving core with an empty directory and one [`MockDomain`] per namespace.
    pub fn new(namespaces: &[&str], limits: MockLimits) -> Self {
        Self {
            threads: MockDirectory::new(limits),
            app_feed: Arc::new(MockFeed::new(
                FeedId::from("app"),
                epoch(1),
                Arc::new(EchoView),
                limits,
            )),
            ops: MockOpIndex::default(),
            domains: namespaces
                .iter()
                .map(|ns| (ns.to_string(), Arc::new(MockDomain::default())))
                .collect(),
            media: MockHostMedia::default(),
            lifecycle: watch::Sender::new(CoreState::Serving),
        }
    }

    pub fn directory(&self) -> &MockDirectory {
        &self.threads
    }

    pub fn app(&self) -> &Arc<MockFeed> {
        &self.app_feed
    }

    pub fn op_index(&self) -> &MockOpIndex {
        &self.ops
    }

    pub fn mock_domain(&self, namespace: &str) -> Option<&Arc<MockDomain>> {
        self.domains.get(namespace)
    }

    pub fn media(&self) -> &MockHostMedia {
        &self.media
    }

    pub fn set_state(&self, state: CoreState) {
        self.lifecycle.send_replace(state);
    }
}

impl CoreHandle for MockCore {
    fn threads(&self) -> &dyn ThreadDirectory {
        &self.threads
    }

    fn app_feed(&self) -> Arc<dyn FeedSource> {
        self.app_feed.clone()
    }

    fn ops(&self) -> &dyn OpIndex {
        &self.ops
    }

    fn domain(&self, namespace: &str) -> Option<&dyn DomainService> {
        self.domains
            .get(namespace)
            .map(|d| d.as_ref() as &dyn DomainService)
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        &self.media
    }

    fn lifecycle(&self) -> watch::Receiver<CoreState> {
        self.lifecycle.subscribe()
    }
}

pub struct MockDirectory {
    limits: MockLimits,
    threads: Mutex<HashMap<ThreadId, Arc<MockThread>>>,
    handler: Mutex<Handler>,
}

impl MockDirectory {
    fn new(limits: MockLimits) -> Self {
        Self {
            limits,
            threads: Mutex::new(HashMap::new()),
            handler: Mutex::new(echo()),
        }
    }

    /// Loads a thread (seq 0, [`EchoView`]).
    pub fn insert(&self, id: ThreadId) -> Arc<MockThread> {
        let thread = Arc::new(MockThread::new(id.clone(), self.limits));
        lock(&self.threads).insert(id, thread.clone());
        thread
    }

    pub fn set_handler(&self, handler: Handler) {
        *lock(&self.handler) = handler;
    }
}

#[async_trait]
impl ThreadDirectory for MockDirectory {
    fn get(&self, id: &ThreadId) -> Option<Arc<dyn ThreadHandle>> {
        lock(&self.threads)
            .get(id)
            .map(|thread| thread.clone() as Arc<dyn ThreadHandle>)
    }

    async fn open(
        &self,
        id: &ThreadId,
        _ctx: &CallContext,
    ) -> Result<Arc<dyn ThreadHandle>, CoreError> {
        self.get(id).ok_or_else(|| CoreError::ThreadNotFound {
            thread_id: id.clone(),
        })
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let handler = lock(&self.handler).clone();
        handler(&req)
    }
}

/// A recorded control-plane call.
#[derive(Clone, Debug, PartialEq)]
pub enum ControlCall {
    Interrupt(TurnId),
    Steer {
        turn: TurnId,
        input: Value,
        op: OpId,
    },
    Decide(Decision),
}

pub struct MockThread {
    id: ThreadId,
    feed: Arc<MockFeed>,
    active_turn: Mutex<Option<TurnId>>,
    control: Mutex<Vec<ControlCall>>,
    handler: Mutex<Handler>,
}

impl MockThread {
    fn new(id: ThreadId, limits: MockLimits) -> Self {
        Self {
            feed: Arc::new(MockFeed::new(
                FeedId::from(id.as_str()),
                epoch(2),
                Arc::new(EchoView),
                limits,
            )),
            id,
            active_turn: Mutex::new(None),
            control: Mutex::new(Vec::new()),
            handler: Mutex::new(echo()),
        }
    }

    /// The thread feed, for publishing.
    pub fn feed(&self) -> &Arc<MockFeed> {
        &self.feed
    }

    pub fn set_active_turn(&self, turn: Option<TurnId>) {
        *lock(&self.active_turn) = turn;
    }

    pub fn set_handler(&self, handler: Handler) {
        *lock(&self.handler) = handler;
    }

    pub fn control_calls(&self) -> Vec<ControlCall> {
        lock(&self.control).clone()
    }

    fn check_turn(&self, turn: &TurnId) -> Result<(), CoreError> {
        if lock(&self.active_turn).as_ref() == Some(turn) {
            Ok(())
        } else {
            Err(CoreError::TurnNotActive {
                thread_id: self.id.clone(),
                turn_id: Some(turn.clone()),
            })
        }
    }
}

impl FeedSource for MockThread {
    fn feed_id(&self) -> FeedId {
        self.feed.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        self.feed.attach(req)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.feed.detach(sub)
    }
}

impl RunControl for MockThread {
    fn interrupt(&self, turn: &TurnId) -> Result<Value, CoreError> {
        self.check_turn(turn)?;
        lock(&self.control).push(ControlCall::Interrupt(turn.clone()));
        Ok(json!({}))
    }

    fn steer(&self, expected_turn: &TurnId, input: Value, op: OpId) -> Result<Value, CoreError> {
        self.check_turn(expected_turn)?;
        lock(&self.control).push(ControlCall::Steer {
            turn: expected_turn.clone(),
            input,
            op,
        });
        Ok(json!({ "turnId": expected_turn }))
    }

    fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        lock(&self.control).push(ControlCall::Decide(decision));
        Ok(())
    }
}

#[async_trait]
impl ThreadHandle for MockThread {
    fn id(&self) -> &ThreadId {
        &self.id
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let handler = lock(&self.handler).clone();
        handler(&req)
    }
}

/// Answers `notApplied` for unknown ids; `fence` records them as fenced (still `notApplied`).
#[derive(Default)]
pub struct MockOpIndex {
    records: Mutex<HashMap<(OpScope, OpId), OpStatus>>,
}

impl MockOpIndex {
    pub fn set(&self, scope: OpScope, op: OpId, status: OpStatus) {
        lock(&self.records).insert((scope, op), status);
    }
}

#[async_trait]
impl OpIndex for MockOpIndex {
    async fn status(
        &self,
        scope: &OpScope,
        ids: &[OpId],
        fence: bool,
        _ctx: &CallContext,
    ) -> Result<Vec<OpStatus>, CoreError> {
        let mut records = lock(&self.records);
        Ok(ids
            .iter()
            .map(|op| {
                let key = (scope.clone(), op.clone());
                match records.get(&key) {
                    Some(status) => status.clone(),
                    None => {
                        if fence {
                            records.insert(key, OpStatus::NotApplied);
                        }
                        OpStatus::NotApplied
                    }
                }
            })
            .collect())
    }
}

/// A domain that answers with its handler (echo by default) and records notifications.
pub struct MockDomain {
    handler: Mutex<Handler>,
    notifications: Mutex<Vec<(Method, Value, ConnectionId)>>,
}

impl Default for MockDomain {
    fn default() -> Self {
        Self {
            handler: Mutex::new(echo()),
            notifications: Mutex::new(Vec::new()),
        }
    }
}

impl MockDomain {
    pub fn set_handler(&self, handler: Handler) {
        *lock(&self.handler) = handler;
    }

    pub fn notifications(&self) -> Vec<(Method, Value, ConnectionId)> {
        lock(&self.notifications).clone()
    }
}

#[async_trait]
impl DomainService for MockDomain {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let handler = lock(&self.handler).clone();
        handler(&req)
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        lock(&self.notifications).push((method, params, from));
        Admit::Accepted
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerRequestEvent {
    Published(PendingServerRequest),
    Resolved(ServerRequestId, Bytes),
    ResponseRejected(ConnectionId, CoreError),
}

/// Records what the core sends to the server's outgoing router.
#[derive(Default)]
pub struct MockServerRequests {
    events: Mutex<Vec<ServerRequestEvent>>,
}

impl MockServerRequests {
    pub fn events(&self) -> Vec<ServerRequestEvent> {
        lock(&self.events).clone()
    }
}

impl ServerRequestSink for MockServerRequests {
    fn publish(&self, req: PendingServerRequest) {
        lock(&self.events).push(ServerRequestEvent::Published(req));
    }

    fn resolved(&self, id: &ServerRequestId, frame: Bytes) {
        lock(&self.events).push(ServerRequestEvent::Resolved(id.clone(), frame));
    }

    fn response_rejected(&self, to: ConnectionId, error: CoreError) {
        lock(&self.events).push(ServerRequestEvent::ResponseRejected(to, error));
    }
}

/// Records section publications.
#[derive(Default)]
pub struct MockStatePublisher {
    published: Mutex<Vec<(SectionName, Option<String>, SectionChange)>>,
}

impl MockStatePublisher {
    pub fn published(&self) -> Vec<(SectionName, Option<String>, SectionChange)> {
        lock(&self.published).clone()
    }
}

impl StatePublisher for MockStatePublisher {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        lock(&self.published).push((section, key, change));
    }
}

/// A desktop host: capabilities that were claimed answer from `replies` (by method), others
/// fail `capabilityUnavailable{desktopHost}`.
#[derive(Default)]
pub struct MockHostChannel {
    claimed: Mutex<Vec<HostCapability>>,
    replies: Mutex<HashMap<&'static str, Result<Value, HostError>>>,
    sent: Mutex<Vec<(HostCapability, Method, Value)>>,
}

impl MockHostChannel {
    pub fn claim(&self, capability: HostCapability) {
        lock(&self.claimed).push(capability);
    }

    pub fn reply(&self, method: Method, result: Value) {
        lock(&self.replies).insert(method.as_str(), Ok(result));
    }

    /// The claimant answers `method` with this JSON-RPC error.
    pub fn fail(&self, method: Method, code: i64, message: &str, data: Option<Value>) {
        let error = HostError::Rpc {
            code,
            message: message.to_owned(),
            data,
        };
        lock(&self.replies).insert(method.as_str(), Err(error));
    }

    pub fn sent(&self) -> Vec<(HostCapability, Method, Value)> {
        lock(&self.sent).clone()
    }

    fn route(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(), CoreError> {
        if !lock(&self.claimed).contains(&capability) {
            return Err(CoreError::CapabilityUnavailable {
                capability: "desktopHost".into(),
                detail: "noClaimant".into(),
            });
        }
        lock(&self.sent).push((capability, method, params));
        Ok(())
    }
}

#[async_trait]
impl HostChannel for MockHostChannel {
    async fn request(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<Value, HostError> {
        self.route(capability, method, params)?;
        lock(&self.replies)
            .get(method.as_str())
            .cloned()
            .unwrap_or(Ok(Value::Null))
    }

    fn notify(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(), CoreError> {
        self.route(capability, method, params)
    }
}

/// Records host media frames.
#[derive(Default)]
pub struct MockHostMedia {
    frames: Mutex<Vec<(ConnectionId, Bytes)>>,
}

impl MockHostMedia {
    pub fn frames(&self) -> Vec<(ConnectionId, Bytes)> {
        lock(&self.frames).clone()
    }
}

impl HostMediaSink for MockHostMedia {
    fn frame(&self, from: ConnectionId, frame: Bytes) {
        lock(&self.frames).push((from, frame));
    }
}
