//! The message processor (P §2.2, §4): one per server, shared by every connection. A
//! transport hands each inbound message of a connection to its [`ConnectionHandle`]; nothing
//! here waits, so a connection's socket reader never blocks on request work (P §7.3):
//!
//! 1. the initialize latch (`notInitialized`), method lookup, origin rule, lifecycle gate;
//! 2. admission through Node's call lanes ([`crate::lanes`]): a control call starts at once, any other waits its turn
//!    among the owners of its lane and is refused only past the lane's queue, with Node's message;
//! 3. typed decode against the generated method table;
//! 4. dispatch: C0 controls run inline on the caller, everything else becomes a task, queued
//!    under the key the method table declares (see [`crate::serialization`]) or free-running
//!    when the table declares none.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
use mixdog_app_protocol::ClientRequest;
use mixdog_app_protocol::ErrorData;
use mixdog_app_protocol::InboundText;
use mixdog_app_protocol::JsonRpcError;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::JsonRpcNotification;
use mixdog_app_protocol::JsonRpcRequest;
use mixdog_app_protocol::JsonRpcResponse;
use mixdog_app_protocol::MethodSpec;
use mixdog_app_protocol::Mutation;
use mixdog_app_protocol::RequestClass;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::decode_inbound_text;
use mixdog_app_protocol::free_text;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::LimitsViolation;
use mixdog_app_protocol::v1;
use mixdog_app_protocol::v2::feed::Subscription;
use mixdog_app_protocol::v2::feed::SubscriptionMode;
use mixdog_app_protocol::v2::op::OpState;
use mixdog_app_protocol::v2::op::OpStatusEntry;
use mixdog_app_protocol::v2::op::OpStatusResponse;
use mixdog_app_protocol::v2::thread::TurnInterruptParams;
use mixdog_app_protocol::v2::thread::TurnSteerParams;
use mixdog_app_protocol::v2::thread::TurnSteerResponse;
use mixdog_core_api::AfterAnswer;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::CoreState;
use mixdog_core_api::HostError;
use mixdog_core_api::Reply;
use mixdog_core_api::Subscribe;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use mixdog_core_api::service::Admit;
use mixdog_core_api::thread::Decision;
use mixdog_core_api::thread::Stop;
use mixdog_core_api::thread::stop_reply;
use mixdog_protocol::Origin;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

use crate::config::ServerConfig;
use crate::config::VersionOrder;
use crate::connection::Connection;
use crate::connection::Registered;
use crate::connection::Slot;
use crate::connection::Session;
use crate::connection::Sub;
use crate::error::error_body;
use crate::error::error_data;
use crate::error::internal;
use crate::frame::error_frame;
use crate::frame::error_notification_frame;
use crate::frame::response_frame;
use crate::lanes::CallLanes;
use crate::lanes::Lane;
use crate::lanes::Placed;
use crate::lanes::Refusal;
use crate::outgoing::Outgoing;
use crate::sharded::lock;
use crate::serialization::KeyedQueues;
use crate::serialization::QueueKey;

/// A request waiting in a call lane, or starting from it.
struct Job {
    conn: Arc<Connection>,
    request: JsonRpcRequest,
    spec: &'static MethodSpec,
    origin: Origin,
}

/// `callLane` (`call-lanes.mjs:35`) for the method a Node call became: an abort, an approval answer and an unsubscribe never
/// queue; a create, read, submit and the project and terminal calls the desktop makes while the user waits queue behind a smaller
/// bound than the rest. The other control calls are control calls. Node's `session.subscribe` is interactive (`call-lanes.mjs:24`):
/// it is `thread/resume`, which waits behind its owner's earlier interactive calls like any other (recorded: `session-call-lanes`,
/// "an attach queues in the interactive lane"). `feed/subscribe` and `app/subscribe` are not `/call`s in Node: a phone opens its
/// feeds with the relay's `setRemoteLanes` (`remote-relay-client-calls.ts`, recorded in `phone-lifecycle`'s lane matrix, which
/// `tests/lane_pushes.rs` replays), a control-plane message that never enters a lane; they run where they arrive.
pub(crate) fn lane_of(spec: &MethodSpec) -> Lane {
    match spec.method {
        "thread/resume" | "thread/start" | "thread/read" | "turn/start" | "room/send" | "turn/steer" | "turn/retryFailed" | "project/list" | "project/read" | "project/create"
        | "project/touch" | "project/update" | "project/delete" | "project/ensureDirectory" | "terminal/ensure" | "terminal/focus"
        | "terminal/dispose" | "terminal/profiles" => Lane::Interactive,
        "thread/approval/answer" | "thread/approval/answerNotification" => Lane::Critical,
        method if crate::node_calls::is_session_action(method) => Lane::Interactive,
        _ if spec.class == RequestClass::C0 => Lane::Critical,
        _ => Lane::Normal,
    }
}

/// `ownerKeyFor` (`call-route.mjs:21`): the session the call addresses, else the client.
fn owner_of(conn: &Connection, request: &JsonRpcRequest) -> String {
    match request.params.as_ref().and_then(|params| params.get("threadId")).and_then(Value::as_str).map(str::trim) {
        Some(thread) if !thread.is_empty() => format!("session:{thread}"),
        _ => format!("client:{}", conn.id),
    }
}

const INITIALIZE: &str = "initialize";

/// The namespaces served by the thread directory and loaded threads; every other namespace
/// of the method table is a domain service.
const THREAD_NAMESPACES: [&str; 2] = ["thread", "turn"];

/// Thread reads the directory answers from the stored session, loaded or not: they never open
/// (load) the thread they name.
const STORED_READS: [&str; 6] = [
    "thread/items/list",
    "thread/items/read",
    "thread/turns/list",
    "thread/attachment/list",
    "thread/modelMessages/list",
    "thread/finalAnswer/read",
];

/// Thread methods the directory serves whether or not the thread opens: `thread/delete` answers
/// for a session that is not there as Node does (`deleted: false` / `not-archived`), not
/// `threadNotFound`. `thread/fork` is served there for `inheritFrom`, which creates the heir's session before it looks the source up.
/// `thread/inheritancePreflight` reads its own thread and the source the directory looks up; no session actor serves it.
/// `thread/approval/answerNotification` and `thread/approval/answer` answer only an approval a loaded thread shows: they never
/// load one.
const DIRECTORY_SERVED: [&str; 5] =
    ["thread/delete", "thread/fork", "thread/inheritancePreflight", "thread/approval/answerNotification", "thread/approval/answer"];

/// What a transport does after handing a message over.
pub enum Inbound {
    Continue,
    /// A domain's bounded input buffer is full: stop reading this socket until the future
    /// resolves (TCP backpressure, P §7.3).
    Pause(Pin<Box<dyn Future<Output = ()> + Send>>),
    /// Close the connection with `code` once the frames already queued are written.
    Close(CloseCode),
}

/// Replay-only (`replay-controls`): a request a replay sends before it looks at the core's files, answered once every store a
/// call writes in the background has written what it was given (the core's service for it says which).
#[cfg(feature = "replay-controls")]
pub const REPLAY_STORES_SETTLED: &str = "replay/storesSettled";

/// The method-table origin of a registered connection, `None` for one that is gone or was
/// never registered (the transport's `ConnectionHub::origin_of`). Asked on every request.
pub type OriginOf = Arc<dyn Fn(ConnectionId) -> Option<Origin> + Send + Sync>;

/// The server: shared by every connection.
#[derive(Clone)]
pub struct AppServer {
    shared: Arc<Shared>,
}

impl AppServer {
    /// `outgoing` is the router the core was given as its `ServerRequestSink` and
    /// `HostChannel`.
    pub fn new(
        core: Arc<dyn CoreHandle>,
        outgoing: Arc<Outgoing>,
        origin_of: OriginOf,
        config: ServerConfig,
    ) -> Result<Self, LimitsViolation> {
        config.limits.check()?;
        Ok(Self {
            shared: Arc::new(Shared {
                lifecycle: core.lifecycle(),
                core,
                outgoing,
                origin_of,
                config,
                queues: KeyedQueues::new(),
                lanes: Mutex::new(CallLanes::new()),
                checking: AtomicBool::new(false),
            }),
        })
    }

    /// Registers an accepted, authenticated connection.
    pub fn open(
        &self,
        id: ConnectionId,
        sink: Arc<dyn mixdog_core_api::ConnectionSink>,
    ) -> ConnectionHandle {
        let conn = Arc::new(Connection::new(id, sink));
        self.shared.outgoing.register(Arc::clone(&conn));
        ConnectionHandle {
            shared: Arc::clone(&self.shared),
            conn,
        }
    }
}

/// One connection, as the transport drives it. Dropping it is the close of the connection
/// (P §4.5): its gate closes, queued requests are discarded, subscriptions are detached and
/// it leaves server-request eligibility. Running requests finish and their responses are
/// dropped; pending approvals stay pending.
pub struct ConnectionHandle {
    shared: Arc<Shared>,
    conn: Arc<Connection>,
}

impl ConnectionHandle {
    pub fn id(&self) -> ConnectionId {
        self.conn.id
    }

    /// One inbound text frame. Oversized and unparseable frames end the connection (P §3).
    pub fn on_text(&self, frame: &str) -> Inbound {
        match decode_inbound_text(frame, self.shared.config.limits.max_inbound_frame_bytes as usize)
        {
            InboundText::Message(message) => self.on_message(message),
            InboundText::TooLarge => Inbound::Close(CloseCode::FrameTooBig),
            InboundText::Invalid => Inbound::Close(CloseCode::InvalidFrame),
        }
    }

    pub fn on_message(&self, message: JsonRpcMessage) -> Inbound {
        let (shared, conn) = (&self.shared, &self.conn);
        match message {
            JsonRpcMessage::Request(request) => shared.on_request(conn, request),
            JsonRpcMessage::Notification(notification) => {
                shared.on_notification(conn, notification)
            }
            JsonRpcMessage::Response(response) => {
                shared.on_response(conn, response);
                Inbound::Continue
            }
            JsonRpcMessage::Error(error) => {
                shared.on_error_response(conn, error);
                Inbound::Continue
            }
        }
    }

    /// An X17 binary frame: only a connection that declared the host media role may send one.
    pub fn on_binary(&self, frame: Bytes) -> Result<(), CloseCode> {
        let may_send = self
            .conn
            .session()
            .and_then(|session| session.host.as_ref())
            .is_some_and(|host| host.media);
        if !may_send {
            return Err(CloseCode::UnsupportedData);
        }
        self.shared.core.host_media().frame(self.conn.id, frame);
        Ok(())
    }

    /// Whether this connection opted out of server notifications named `method`
    /// (`initialize` capabilities); false before `initialize`.
    pub fn opted_out(&self, method: &str) -> bool {
        self.conn
            .session()
            .is_some_and(|session| session.opt_out_notification_methods.contains(method))
    }
}

impl Drop for ConnectionHandle {
    fn drop(&mut self) {
        let closed = self.conn.close();
        for sub in closed.subs {
            sub.feed.detach(sub.id);
        }
        self.shared.outgoing.unregister(&self.conn);
        // Last: the feed subscriptions and the server-request eligibility are gone, so the owners release what the connection held. Every end path
        // (clean close, transport error, heartbeat or slow-consumer close, server stop) ends the drive loop that owns this handle: once per connection.
        self.shared.core.connection_closed(self.conn.id);
    }
}

pub(crate) struct Shared {
    core: Arc<dyn CoreHandle>,
    outgoing: Arc<Outgoing>,
    origin_of: OriginOf,
    config: ServerConfig,
    lifecycle: watch::Receiver<CoreState>,
    queues: KeyedQueues,
    lanes: Mutex<CallLanes<Job>>,
    /// A task is running the lanes' check phases; set and cleared under the `lanes` lock.
    checking: AtomicBool,
}

type ReplyFuture = Pin<Box<dyn Future<Output = Result<Reply, CoreError>> + Send>>;

enum Dispatch {
    Ready(Result<Reply, CoreError>),
    Later(TaskClass, ReplyFuture),
}

pub(crate) fn method_index() -> &'static HashMap<&'static str, &'static MethodSpec> {
    static INDEX: OnceLock<HashMap<&'static str, &'static MethodSpec>> = OnceLock::new();
    INDEX.get_or_init(|| CLIENT_METHODS.iter().map(|spec| (spec.method, spec)).collect())
}

/// Whether `message` is for the control path: a C0 request, or a client's answer to a server or
/// host request. A reader that pauses on [`Inbound::Pause`] keeps reading and hands these on
/// first, so a `turn/interrupt` or an approval decision never waits behind a paused data frame.
pub fn is_control(message: &JsonRpcMessage) -> bool {
    match message {
        JsonRpcMessage::Request(request) => method_index()
            .get(request.method.as_str())
            .is_some_and(|spec| spec.class == RequestClass::C0),
        JsonRpcMessage::Response(_) | JsonRpcMessage::Error(_) => true,
        JsonRpcMessage::Notification(_) => false,
    }
}

fn namespace(method: &'static str) -> &'static str {
    method.split_once('/').map_or(method, |(namespace, _)| namespace)
}

fn empty_result() -> Value {
    json!({})
}

impl Shared {
    fn reject(&self, conn: &Connection, id: &RequestId, data: &ErrorData) {
        // A closing connection no longer needs the answer.
        let _ = conn.sink.send_control(error_frame(id, data));
    }

    /// Answers `error` unless it is the internal "connection closed" race (never on the wire).
    fn reject_core(&self, conn: &Connection, id: &RequestId, error: &CoreError) {
        if !matches!(error, CoreError::ConnectionClosed) {
            self.reject(conn, id, &error_data(error));
        }
    }

    // ---- requests

    fn on_request(self: &Arc<Self>, conn: &Arc<Connection>, request: JsonRpcRequest) -> Inbound {
        let id = request.id.clone();
        // No origin is no scope to judge the call by: refuse, never assume one.
        let Some(origin) = (self.origin_of)(conn.id) else {
            self.reject_core(conn, &id, &internal("request from a connection without an origin"));
            return Inbound::Continue;
        };
        if conn.session().is_none() && request.method != INITIALIZE {
            self.reject(conn, &id, &ErrorData::NotInitialized);
            return Inbound::Continue;
        }
        #[cfg(feature = "replay-controls")]
        if request.method == REPLAY_STORES_SETTLED {
            self.replay_stores_settled(conn, id, origin);
            return Inbound::Continue;
        }
        let Some(spec) = method_index().get(request.method.as_str()).copied() else {
            self.reject(
                conn,
                &id,
                &ErrorData::MethodNotFound {
                    method: request.method,
                },
            );
            return Inbound::Continue;
        };
        if !spec.allows(origin) {
            let denied = CoreError::PermissionDenied {
                method: spec.method.into(),
                origin,
            };
            self.reject_core(conn, &id, &denied);
            return Inbound::Continue;
        }
        if let Err(error) = self.lifecycle_gate(spec) {
            self.reject_core(conn, &id, &error);
            return Inbound::Continue;
        }
        // The handshake is a control-plane call (Node's `/client/register`): it never enters a lane.
        if request.method == INITIALIZE {
            let guard = self.request_guard(&request);
            return self.admitted(conn, request, spec, origin, Slot::new(guard, || {}));
        }
        let (lane, owner) = (lane_of(spec), owner_of(conn, &request));
        let dispatched = lock(&self.lanes).dispatch(&owner, lane, Job { conn: Arc::clone(conn), request, spec, origin });
        if let Some((evicted, refusal)) = dispatched.displaced {
            self.refuse(&evicted.conn, &evicted.request.id, &refusal);
        }
        match dispatched.placed {
            Ok(Placed::Start(job)) => self.start(lane, owner, job),
            Ok(Placed::Queued) => {
                self.ensure_checks();
                Inbound::Continue
            }
            Err((job, refusal)) => {
                self.refuse(&job.conn, &job.request.id, &refusal);
                Inbound::Continue
            }
        }
    }

    /// The core is told of the request for as long as the guard is held.
    fn request_guard(&self, request: &JsonRpcRequest) -> mixdog_core_api::handle::RequestGuard {
        let no_params = Value::Null;
        self.core.request_started(&request.method, request.params.as_ref().unwrap_or(&no_params))
    }

    /// A call a lane lets go: it holds its place in the lane until it ends, and the lane is told then.
    fn start(self: &Arc<Self>, lane: Lane, owner: String, job: Job) -> Inbound {
        let shared = Arc::clone(self);
        let slot = Slot::new(self.request_guard(&job.request), move || shared.ended(&owner, lane));
        self.admitted(&job.conn, job.request, job.spec, job.origin, slot)
    }

    fn ended(self: &Arc<Self>, owner: &str, lane: Lane) {
        lock(&self.lanes).finished(owner, lane);
        self.ensure_checks();
    }

    /// The lanes' refusal, as the route answers it: `{ error: message }` (the status code is not on the wire).
    fn refuse(&self, conn: &Connection, id: &RequestId, refusal: &Refusal) {
        let refused = CoreError::DomainError { domain: "session".into(), code: None, message: Some(refusal.message.as_str().into()), detail: None };
        self.reject_core(conn, id, &refused);
    }

    /// Starts the task that runs the lanes' check phases (Node's `setImmediate` dispatch) unless one is running.
    fn ensure_checks(self: &Arc<Self>) {
        {
            let lanes = lock(&self.lanes);
            if !lanes.wants_check() || self.checking.swap(true, Ordering::AcqRel) {
                return;
            }
        }
        let shared = Arc::clone(self);
        mixdog_rt::spawn("call-lanes", TaskClass::Work, async move {
            loop {
                mixdog_rt::time::immediate().await;
                let started = lock(&shared.lanes).check_phase();
                for (lane, owner, job) in started {
                    // A queued call's own refusals and answers go to its connection; what a reader would do next is already done.
                    let _ = shared.start(lane, owner, job);
                }
                let more = {
                    let lanes = lock(&shared.lanes);
                    let more = lanes.wants_check();
                    if !more {
                        shared.checking.store(false, Ordering::Release);
                    }
                    more
                };
                if !more {
                    break;
                }
            }
        });
    }

    /// A request that holds its in-flight slot: checked, decoded and dispatched.
    fn admitted(
        self: &Arc<Self>,
        conn: &Arc<Connection>,
        mut request: JsonRpcRequest,
        spec: &'static MethodSpec,
        origin: Origin,
        slot: crate::connection::Slot,
    ) -> Inbound {
        let id = request.id.clone();
        if let Err(data) = precheck(spec, request.params.as_ref()) {
            drop(slot);
            self.reject(conn, &id, &data);
            return Inbound::Continue;
        }
        if let Some(at) = free_text::refused(free_text::Kind::Request, spec.method, &request.lone_surrogates) {
            drop(slot);
            self.reject(conn, &id, &lone_refusal(&format!("{}.params", spec.method), at));
            return Inbound::Continue;
        }
        // The owner decodes its own params from the raw value; the table decode below only
        // validates them and yields the scope and op.
        let params = request.params.clone();
        let lone_surrogates = std::mem::take(&mut request.lone_surrogates);
        let typed = match ClientRequest::from_jsonrpc(request) {
            Ok(typed) => typed,
            Err(error) => {
                drop(slot);
                self.reject(conn, &id, &error.into_error_data());
                return Inbound::Continue;
            }
        };
        if let ClientRequest::Initialize { params, .. } = typed {
            drop(slot);
            return self.initialize(conn, &id, origin, params);
        }
        let scope = typed.serialization_scope();
        let params = params.unwrap_or_else(empty_result);
        // What the call keeps until its answer is queued ends right after `finish` queues it, or with the request if it never is.
        let after = AfterAnswer::default();
        match self.dispatch(conn, &id, origin, typed, (params, lone_surrogates), spec, &after) {
            Dispatch::Ready(outcome) => {
                drop(slot);
                self.finish(conn, &id, outcome);
                after.release();
            }
            Dispatch::Later(class, work) => {
                let shared = Arc::clone(self);
                let owner = Arc::clone(conn);
                let run = async move {
                    let outcome = work.await;
                    drop(slot);
                    shared.finish(&owner, &id, outcome);
                    after.release();
                };
                match scope {
                    Some(scope) => {
                        let (key, access) = QueueKey::resolve(scope, || {
                            conn.session()
                                .map(|session| session.client.name.clone())
                                .unwrap_or_default()
                        });
                        self.queues
                            .enqueue(key, access, conn.cancel.clone(), Box::pin(run));
                    }
                    None => {
                        mixdog_rt::spawn("request", class, run);
                    }
                }
            }
        }
        Inbound::Continue
    }

    /// [`REPLAY_STORES_SETTLED`]: answered by the service the core registers for it, outside the method table (no ordinary build
    /// has it), on the work runtime; a core that registers none answers it unclaimed.
    #[cfg(feature = "replay-controls")]
    fn replay_stores_settled(self: &Arc<Self>, conn: &Arc<Connection>, id: RequestId, origin: Origin) {
        let (shared, owner, core) = (Arc::clone(self), Arc::clone(conn), Arc::clone(&self.core));
        let request = CoreRequest {
            method: Method(REPLAY_STORES_SETTLED),
            params: empty_result(),
            op: None,
            ctx: CallContext::connection(conn.id, origin, conn.cancel.clone()),
        };
        mixdog_rt::spawn("replay-stores-settled", TaskClass::Work, async move {
            let outcome = match core.domain_for(REPLAY_STORES_SETTLED) {
                Some(domain) => domain.call(request).await,
                None => Err(unclaimed(REPLAY_STORES_SETTLED)),
            };
            shared.finish(&owner, &id, outcome);
        });
    }

    /// Refuses what the core's lifecycle does not serve. C0 controls always pass, so a client
    /// can still subscribe, read op status and interrupt (P §11.1, §4.4).
    fn lifecycle_gate(&self, spec: &MethodSpec) -> Result<(), CoreError> {
        let unavailable = |detail: &str| CoreError::CapabilityUnavailable {
            capability: "core".into(),
            detail: detail.into(),
        };
        match &*self.lifecycle.borrow() {
            CoreState::Serving => Ok(()),
            CoreState::Migrating(progress) if spec.class != RequestClass::C0 => {
                Err(CoreError::CoreMigrating {
                    kind: progress.kind.clone(),
                    done: progress.done,
                    total: progress.total,
                })
            }
            CoreState::Migrating(_) => Ok(()),
            // New work is refused; reads continue until the connections close.
            CoreState::Draining { reason } => {
                let reads = spec.mutation == Mutation::None && spec.class != RequestClass::C3;
                if spec.class == RequestClass::C0 || reads {
                    Ok(())
                } else {
                    Err(CoreError::ServerShuttingDown {
                        drain_reason: *reason,
                    })
                }
            }
            CoreState::Booting => Err(unavailable("booting")),
            CoreState::Stopped => Err(unavailable("stopped")),
            _ => Err(unavailable("unavailable")),
        }
    }

    fn core_state(&self) -> Result<v1::CoreState, CoreError> {
        match &*self.lifecycle.borrow() {
            CoreState::Serving => Ok(v1::CoreState::Serving),
            CoreState::Migrating(progress) => Ok(v1::CoreState::Migrating {
                kind: progress.kind.to_string(),
                done: progress.done,
                total: progress.total,
            }),
            CoreState::Draining { reason } => Ok(v1::CoreState::Draining { reason: *reason }),
            _ => Err(CoreError::CapabilityUnavailable {
                capability: "core".into(),
                detail: "notServing".into(),
            }),
        }
    }

    // ---- initialize (P §4.4)

    fn initialize(
        &self,
        conn: &Arc<Connection>,
        id: &RequestId,
        origin: Origin,
        params: v1::InitializeParams,
    ) -> Inbound {
        if conn.session().is_some() {
            self.reject(conn, id, &ErrorData::AlreadyInitialized);
            return Inbound::Continue;
        }
        let core_state = match self.core_state() {
            Ok(state) => state,
            Err(error) => {
                self.reject_core(conn, id, &error);
                return Inbound::Continue;
            }
        };
        let config = &self.config;
        let refusal = |make: fn(String, String) -> ErrorData| {
            make(config.server_version.clone(), params.client_info.version.clone())
        };
        let refused = match (config.version_gate)(&params.client_info) {
            VersionOrder::Equal => None,
            VersionOrder::ClientOlder => Some(refusal(|server_version, client_version| {
                ErrorData::ClientOutdated {
                    server_version,
                    client_version,
                }
            })),
            VersionOrder::ClientNewer => Some(refusal(|server_version, client_version| {
                ErrorData::ServerOutdated {
                    server_version,
                    client_version,
                }
            })),
        };
        if let Some(data) = refused {
            self.reject(conn, id, &data);
            return Inbound::Close(CloseCode::VersionRefused);
        }
        let capabilities = params.capabilities.unwrap_or_default();
        let client = params.client_info;
        let device = client.title.clone().unwrap_or_else(|| client.name.clone());
        let kind = client.kind;
        let session = Session {
            opt_out_notification_methods: capabilities
                .opt_out_notification_methods
                .unwrap_or_default()
                .into_iter()
                .collect(),
            approvals_inbox: capabilities.approvals_inbox.unwrap_or(false),
            host: capabilities.host,
            model_proxy: capabilities.model_proxy.unwrap_or(false),
            client,
        };
        if conn.initialize(session).is_err() {
            self.reject(conn, id, &ErrorData::AlreadyInitialized);
            return Inbound::Continue;
        }
        // Before the response: the client sends nothing the registry must know about until it has read it.
        self.core.connection_opened(conn.id, origin, &device, kind);
        let response = v1::InitializeResponse {
            defaults_separation: Some(config.defaults_separation.clone()),
            user_agent: config.user_agent.clone(),
            platform_family: config.platform_family.clone(),
            platform_os: config.platform_os.clone(),
            server_version: config.server_version.clone(),
            server_build: config.server_build.clone(),
            server_instance_id: config.server_instance_id.clone(),
            core_state,
            limits: config.limits.clone(),
            capabilities: {
                let mut capabilities = config.capabilities.clone();
                capabilities.remote = mixdog_app_protocol::remote_flags::remote_capabilities((config.native_push)());
                capabilities
            },
            connection: v1::ConnectionInfo {
                origin,
                device,
            },
        };
        let result = serde_json::to_value(response).expect("initialize response serializes");
        let _ = conn.sink.send_control(response_frame(id, &result));
        // Eligibility starts only now, behind the response; what was published meanwhile is
        // delivered here, and an approvals-inbox connection gets every pending request.
        conn.finish_handshake();
        if let Some(kind) = conn.session().map(|session| session.client.kind) {
            self.outgoing.client_registered(kind);
        }
        if conn.session().is_some_and(|session| session.model_proxy) {
            self.outgoing.serve_model_proxy(conn);
        }
        self.outgoing.redeliver(conn);
        Inbound::Continue
    }

    // ---- dispatch

    fn dispatch(
        self: &Arc<Self>,
        conn: &Arc<Connection>,
        id: &RequestId,
        origin: Origin,
        request: ClientRequest,
        (params, lone_surrogates): (Value, Vec<mixdog_app_protocol::rpc::LoneAt>),
        spec: &'static MethodSpec,
        after: &AfterAnswer,
    ) -> Dispatch {
        match request {
            ClientRequest::AppSubscribe { params: app, .. } => {
                Dispatch::Ready(Ok(Reply::Subscribe(Subscribe {
                    result: empty_result(),
                    feed: self.core.app_feed(),
                    window: Window::Fixed,
                    resume_from: app.resume_from.map(|position| ResumeFrom {
                        position: FeedPosition {
                            epoch: position.epoch,
                            seq: position.seq,
                        },
                        window: Window::Fixed,
                    }),
                })))
            }
            ClientRequest::FeedSubscribe { params: sub, .. } => {
                Dispatch::Ready(match self.core.scoped_feed(&sub.feed_id) {
                    // The feed's scope may end between this lookup and the attach; the attach
                    // then answers `connectionClosed`, as for any subscription racing a close.
                    Some(feed) => Ok(Reply::Subscribe(Subscribe {
                        result: empty_result(),
                        feed,
                        window: Window::Fixed,
                        resume_from: sub.resume_from.map(|position| ResumeFrom {
                            position: FeedPosition { epoch: position.epoch, seq: position.seq },
                            window: Window::Fixed,
                        }),
                    })),
                    None => Err(CoreError::InvalidParams {
                        path: "feedId".into(),
                        expected: "the id of a live scoped feed".into(),
                    }),
                })
            }
            ClientRequest::FeedUnsubscribe { params, .. } => {
                Dispatch::Ready(self.unsubscribe(conn, &params.feed_id))
            }
            ClientRequest::ThreadUnsubscribe { params, .. } => {
                let feed = FeedId::from(params.thread_id.as_str());
                Dispatch::Ready(self.unsubscribe(conn, &feed))
            }
            ClientRequest::TurnInterrupt { params, .. } => {
                self.interrupt(CallContext::connection(conn.id, origin, conn.cancel.clone()), params)
            }
            ClientRequest::TurnSteer { params, .. } => {
                Dispatch::Ready(self.steer(conn.id, id, params))
            }
            ClientRequest::OpStatus { params, .. } => {
                let core = Arc::clone(&self.core);
                let ctx = CallContext::connection(conn.id, origin, conn.cancel.clone());
                Dispatch::Later(
                    TaskClass::Work,
                    Box::pin(async move {
                        let scope = match params.scope.0.strip_prefix("thread:") {
                            Some(thread) => OpScope::Thread(ThreadId::from(thread)),
                            None => OpScope::Domain(params.scope.0.as_str().into()),
                        };
                        let statuses = core
                            .ops()
                            .status(&scope, &params.op_ids, params.fence, &ctx)
                            .await?;
                        op_status_reply(params.op_ids, statuses)
                    }),
                )
            }
            ClientRequest::HostClaim { params, .. } => {
                let shared = Arc::clone(self);
                let conn = Arc::clone(conn);
                Dispatch::Later(
                    TaskClass::Work,
                    Box::pin(async move {
                        let declared = conn.session().is_some_and(|session| session.host.is_some());
                        if !declared {
                            return Err(CoreError::CapabilityUnavailable {
                                capability: "host".into(),
                                detail: "notDeclared".into(),
                            });
                        }
                        shared.outgoing.claim(params.host_id, &conn);
                        Ok(Reply::Value(empty_result()))
                    }),
                )
            }
            _ => {
                let op = request.op().map(|(_, op)| op.clone());
                self.route(conn, origin, spec, (params, lone_surrogates), op, after)
            }
        }
    }

    /// A method served by the core: the thread directory or a loaded thread for the thread
    /// namespaces (a request that names a `threadId` is addressed to that thread), the domain
    /// service that claims the exact method for every other one. A thread-namespace method a
    /// domain service claims (`thread/continueInModel`, `thread/quotaResume/*`: they act on the
    /// route and on daemon-wide stores, not on the thread's actor) goes to that service.
    fn route(
        &self,
        conn: &Connection,
        origin: Origin,
        spec: &'static MethodSpec,
        (params, lone_surrogates): (Value, Vec<mixdog_app_protocol::rpc::LoneAt>),
        op: Option<OpId>,
        after: &AfterAnswer,
    ) -> Dispatch {
        let mut ctx = CallContext::connection(conn.id, origin, conn.cancel.clone());
        ctx.after_answer = after.clone();
        ctx.lone_surrogates = lone_surrogates;
        let namespace = namespace(spec.method);
        let thread = THREAD_NAMESPACES
            .contains(&namespace)
            .then(|| params.get("threadId").and_then(Value::as_str).map(ThreadId::from))
            .flatten();
        let request = CoreRequest {
            method: Method(spec.method),
            params,
            op,
            ctx,
        };
        let core = Arc::clone(&self.core);
        if THREAD_NAMESPACES.contains(&namespace) && core.domain_for(spec.method).is_none() {
            // A control that targets a loaded thread stays on RT-C; a cold open awaits the
            // core's load jobs and so runs on RT-W.
            let loaded = thread
                .as_ref()
                .is_some_and(|id| core.threads().get(id).is_some());
            let class = if spec.class == RequestClass::C0 && loaded {
                TaskClass::Control
            } else {
                TaskClass::Work
            };
            return Dispatch::Later(
                class,
                Box::pin(async move {
                    match thread {
                        Some(id) if !STORED_READS.contains(&request.method.0) && !DIRECTORY_SERVED.contains(&request.method.0) => {
                            let handle = core.threads().open(&id, &request.ctx).await?;
                            handle.request(request).await
                        }
                        _ => core.threads().request(request).await,
                    }
                }),
            );
        }
        Dispatch::Later(
            TaskClass::Work,
            Box::pin(async move {
                match core.domain_for(spec.method) {
                    Some(domain) => domain.call(request).await,
                    None => Err(unclaimed(spec.method)),
                }
            }),
        )
    }

    fn unsubscribe(&self, conn: &Connection, feed: &FeedId) -> Result<Reply, CoreError> {
        if let Some(sub) = conn.remove_subscription(feed) {
            sub.feed.detach(sub.id);
        }
        Ok(Reply::Value(empty_result()))
    }

    /// `turn/interrupt` (C0, R12): the control plane of a loaded thread, never a load.
    /// A turn that is named must be the running one of a loaded thread; none named stops the thread's active turn, and a
    /// thread with none (or not loaded) is idle: its answer is Node's `aborted: false` (SPEC R12, amended).
    fn interrupt(&self, ctx: CallContext, params: TurnInterruptParams) -> Dispatch {
        let TurnInterruptParams { thread_id, turn_id, restore_prompt, submission_id } = params;
        let thread = match &turn_id {
            Some(turn) => match self.loaded_thread(&thread_id, turn) {
                Ok(thread) => Some(thread),
                Err(error) => return Dispatch::Ready(Err(error)),
            },
            None => self.core.threads().get(&thread_id),
        };
        let Some(thread) = thread else {
            return Dispatch::Ready(Ok(Reply::Value(stop_reply(None, false))));
        };
        let stop = Stop { turn: turn_id, restore_prompt, submission_id, ctx };
        Dispatch::Later(
            TaskClass::Control,
            Box::pin(async move {
                let reply = thread.stop(stop).await?;
                Ok(Reply::Value(reply))
            }),
        )
    }

    /// `turn/steer` (C0, R10, R12).
    fn steer(
        &self,
        from: ConnectionId,
        id: &RequestId,
        params: TurnSteerParams,
    ) -> Result<Reply, CoreError> {
        // A request that names no turn steers the thread's active one, if it has one.
        let thread = match &params.expected_turn_id {
            Some(turn) => self.loaded_thread(&params.thread_id, turn)?,
            None => self.core.threads().get(&params.thread_id).ok_or_else(|| CoreError::TurnNotActive { thread_id: params.thread_id.clone(), turn_id: None })?,
        };
        // `RunControl::steer` still takes an input and an op id; the wire carries neither
        // (contract change request), so the entry is named and the call keyed by this request.
        let op = OpId::from(format!("steer:{from}:{id}"));
        thread.steer(
            params.expected_turn_id.as_ref(),
            json!({ "queuedId": params.queued_id }),
            op,
        )?;
        reply_value(&TurnSteerResponse {
            accepted: true,
            queued_id: params.queued_id,
        })
    }

    /// A control never loads a thread: one that is not loaded has no active turn.
    fn loaded_thread(
        &self,
        thread: &ThreadId,
        turn: &TurnId,
    ) -> Result<Arc<dyn ThreadHandle>, CoreError> {
        self.core
            .threads()
            .get(thread)
            .ok_or_else(|| CoreError::TurnNotActive {
                thread_id: thread.clone(),
                turn_id: Some(turn.clone()),
            })
    }

    // ---- responses

    /// Writes the outcome of a request. The slot of the request is already free.
    fn finish(&self, conn: &Connection, id: &RequestId, outcome: Result<Reply, CoreError>) {
        match outcome {
            Ok(Reply::Value(result)) => {
                let _ = conn.sink.send_control(response_frame(id, &result));
            }
            Ok(Reply::Subscribe(sub)) => self.finish_subscribe(conn, id, sub),
            Err(error) => self.reject_core(conn, id, &error),
        }
    }

    /// A subscribing reply (P §6.4): allocate the subscription, attach, and write the
    /// response with the lane release, so no lane frame can precede it. Server requests
    /// follow the response (P §8.3).
    fn finish_subscribe(&self, conn: &Connection, id: &RequestId, sub: Subscribe) {
        let Subscribe {
            result,
            feed,
            window,
            resume_from,
        } = sub;
        let sub_id = conn.next_subscription_id();
        let attached = match subscribe(&feed, sub_id.clone(), window, resume_from, &*conn.sink) {
            Ok(attached) => attached,
            Err(error) => return self.reject_core(conn, id, &error),
        };
        let Value::Object(mut result) = result else {
            feed.detach(sub_id);
            let error = internal("subscribing reply without an object result");
            return self.reject_core(conn, id, &error);
        };
        let subscription = Subscription {
            id: sub_id.clone(),
            mode: match attached.decision.mode {
                AttachMode::Replay => SubscriptionMode::Replay,
                AttachMode::Snapshot => SubscriptionMode::Snapshot,
            },
            epoch: attached.decision.epoch.clone(),
            start_seq: attached.decision.start_seq,
            live_seq: attached.decision.live_seq,
        };
        result.insert(
            "subscription".to_owned(),
            serde_json::to_value(subscription).expect("subscription serializes"),
        );
        let feed_id = feed.feed_id();
        let registered = conn.register_subscription(
            feed_id.clone(),
            Sub {
                id: sub_id.clone(),
                feed: Arc::clone(&feed),
                live: false,
            },
        );
        match registered {
            Registered::ConnectionClosed => return feed.detach(sub_id),
            Registered::Replaced(Some(old)) => old.feed.detach(old.id),
            Registered::Replaced(None) => {}
        }
        let frame = response_frame(id, &Value::Object(result));
        let release = attached.release;
        if conn
            .send_attach_response(&feed_id, &sub_id, || conn.sink.send_control_release(frame, release))
            .is_err()
        {
            return;
        }
        if feed_id == FeedId::from(mixdog_app_protocol::v2::feed::APP_FEED_ID) && conn.is_desktop_on(&feed_id) {
            self.outgoing.desktop_ready();
        }
        self.outgoing.redeliver(conn);
    }

    /// A response of a client: the answer to a `host/*` request it serves, or a decision on
    /// a server request (P §8.4 step 1). The first valid decision wins in the owning actor;
    /// a response for a request that is gone or was never delivered here is dropped.
    fn on_response(&self, conn: &Connection, response: JsonRpcResponse) {
        let Some(session) = conn.session() else {
            return;
        };
        let JsonRpcResponse { id, result, lone_surrogates } = response;
        // A `host/*` answer that held a lone surrogate outside its free-text fields ([`free_text`]) fails its request.
        let free = conn.host_request_method(&id).is_some_and(|method| free_text::refused(free_text::Kind::Answer, method.as_str(), &lone_surrogates).is_none());
        let (reply, decision) = if lone_surrogates.is_empty() || free { (Ok(result), None) } else { (Err(lone_answer()), Some(result)) };
        let Err(back) = conn.complete_host_request(&id, reply) else {
            return;
        };
        let Some(result) = decision.or_else(|| back.ok()) else {
            return;
        };
        let request = ServerRequestId(id.to_string());
        let Some((thread, method)) = self.outgoing.owner_for_response(&request, conn.id) else {
            return;
        };
        // A decision holding a lone surrogate outside its free-text fields decides nothing: the request stays open.
        if let Some(at) = free_text::refused(free_text::Kind::Answer, method.as_str(), &lone_surrogates) {
            let _ = conn.sink.send_control(error_notification_frame(&lone_refusal("result", at)));
            return;
        }
        let Some(handle) = self.core.threads().get(&thread) else {
            return;
        };
        // As for a request: no origin is no transport to judge the answer by, so it decides nothing.
        let Some(origin) = (self.origin_of)(conn.id) else {
            return;
        };
        let client = &session.client;
        let decision = Decision {
            request,
            connection: conn.id,
            device: client.title.clone().unwrap_or_else(|| client.name.clone()),
            connection_kind: client.kind,
            origin,
            result,
        };
        if let Err(error) = handle.decide(decision) {
            let _ = conn
                .sink
                .send_control(error_notification_frame(&error_data(&error)));
        }
    }

    /// An error response of a client does not resolve a server request (P §8.4 step 6); for a
    /// `host/*` request it is the request's failure.
    fn on_error_response(&self, conn: &Connection, response: JsonRpcError) {
        // An error answer has no free-text field: one that held a lone surrogate fails its request as a refused answer does,
        // so no consumer reads its U+FFFD-substituted message or data.
        let failed = if response.lone_surrogates.is_empty() {
            HostError::Rpc {
                code: response.error.code,
                message: response.error.message.clone(),
                data: response.error.data.clone(),
            }
        } else {
            lone_answer()
        };
        let _ = conn.complete_host_request(&response.id, Err(failed));
    }

    // ---- notifications

    /// Client notifications take no slot and are never dropped (P §7.3, X11).
    fn on_notification(&self, conn: &Connection, notification: JsonRpcNotification) -> Inbound {
        if conn.session().is_none() {
            return Inbound::Continue;
        }
        let Some(spec) = CLIENT_NOTIFICATIONS
            .iter()
            .find(|spec| spec.method == notification.method)
        else {
            return Inbound::Continue;
        };
        if spec.method == "initialized" {
            return Inbound::Continue;
        }
        // A notification holding a lone surrogate outside its free-text fields is dropped: it has no effect.
        if free_text::refused(free_text::Kind::Notification, spec.method, &notification.lone_surrogates).is_some() {
            return Inbound::Continue;
        }
        let Some(domain) = self.core.domain_for(spec.method) else {
            return Inbound::Continue;
        };
        let params = notification.params.unwrap_or(Value::Null);
        match domain.notify(Method(spec.method), params, conn.id) {
            Admit::Accepted => Inbound::Continue,
            Admit::Pause(resume) => Inbound::Pause(resume),
        }
    }
}

/// The refusal of a frame that held a lone surrogate outside its free-text fields ([`free_text`]): no shipped client sends one
/// there, so the frame is refused whole and nothing acts on it (decisions.md "frame-lone-surrogate"). `what` names the payload;
/// a place outside it (the id) keeps its own pointer.
fn lone_refusal(what: &str, at: &str) -> ErrorData {
    let path = at.strip_prefix('#').map_or_else(|| format!("{what}{at}"), str::to_owned);
    // The sentence names the field: it is what a client shows a person (remote-protocol-files.ts `failure`, protocol-client
    // `ClientFailure`), and the person has to know which text to fix.
    let expected = format!("text without unpaired surrogates (a lone \\ud800-\\udfff escape) in {path}");
    ErrorData::InvalidParams { path, expected }
}

/// The failure of a `host/*` request whose answer held a lone surrogate outside its free-text fields.
fn lone_answer() -> HostError {
    HostError::Rpc {
        code: mixdog_app_protocol::error::INVALID_PARAMS,
        message: "The answer contains unpaired Unicode surrogates.".into(),
        data: None,
    }
}

/// The answer for a method no service claims.
fn unclaimed(method: &str) -> CoreError {
    CoreError::CapabilityUnavailable {
        capability: method.into(),
        detail: "unclaimed".into(),
    }
}

/// Request shape rules that hold for every method (P §4.3, §9.1), checked on the raw params
/// so the answer is the specific reason rather than a decode failure.
fn precheck(spec: &MethodSpec, params: Option<&Value>) -> Result<(), Box<ErrorData>> {
    let object = params.and_then(Value::as_object);
    if object.is_some_and(|params| params.contains_key("device")) {
        return Err(Box::new(ErrorData::InvalidParams {
            path: "device".to_owned(),
            expected: "absent: the host stamps the device".to_owned(),
        }));
    }
    if matches!(spec.mutation, Mutation::Op(_))
        && !object.is_some_and(|params| params.contains_key("opId"))
    {
        return Err(Box::new(ErrorData::OpIdRequired));
    }
    Ok(())
}

fn reply_value(value: &impl serde::Serialize) -> Result<Reply, CoreError> {
    Ok(Reply::Value(
        serde_json::to_value(value).expect("fixed reply serializes"),
    ))
}

fn op_status_reply(op_ids: Vec<OpId>, statuses: Vec<OpStatus>) -> Result<Reply, CoreError> {
    if statuses.len() != op_ids.len() {
        return Err(internal("op index answered another number of ids"));
    }
    let ops = op_ids
        .into_iter()
        .zip(statuses)
        .map(|(op_id, status)| OpStatusEntry {
            op_id,
            state: match status {
                OpStatus::Applied { seq, result } => OpState::Applied { seq, result },
                OpStatus::Rejected { error } => OpState::Rejected {
                    error: error_body(&error),
                },
                OpStatus::InProgress => OpState::InProgress,
                OpStatus::ExternalUnknown { effect, target } => OpState::ExternalUnknown {
                    effect: effect.to_string(),
                    target: target.to_string(),
                },
                OpStatus::NotApplied => OpState::NotApplied,
                OpStatus::Expired => OpState::Expired,
            },
        })
        .collect();
    reply_value(&OpStatusResponse { ops })
}
