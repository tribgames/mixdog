//! The client behind the frozen API (`api`); it passes the shared conformance suite over any `Connector`.
//!
//! Shape: one driver task owns the transport and every wire decision (ids, responses, close, ladder, restore); callers run the
//! per-call policy (opId, `-32001` retry, ready wait) in their own task through `Inner::run`; each feed (and the connection-scoped stream)
//! has its own fold lane that resolves blob stubs and applies notifications in order, so a slow feed delays only itself.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard},
};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use mixdog_app_protocol::{
    Delivery, SERVER_NOTIFICATIONS,
    v1::InitializeParams,
    v2::{
        feed::{AppSnapshotParams, AppSubscribeParams, ThreadResumePosition},
        op::{
            BlobPutParams, BlobReadParams, BlobReadResponse, OpScopeName, OpStatusParams,
            OpStatusResponse,
        },
        thread::{ThreadIdParams, ThreadResumeParams},
    },
};
use mixdog_protocol::{BlobDigest, InvalidBlobDigest};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::api::*;

// ───────────── pure helpers ─────────────

/// Full jitter: uniform in [0, min(cap, base·2^attempt)). `unit` is uniform in [0, 1).
pub fn ladder_delay(attempt: u32, unit: f64, cfg: LadderConfig) -> u64 {
    let ceiling = cfg
        .cap_ms
        .min(cfg.base_ms.saturating_mul(1u64 << attempt.min(32)));
    (unit * ceiling as f64).floor() as u64
}

pub fn new_op_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn to_json<T: Serialize>(v: &T) -> Json {
    serde_json::to_value(v).expect("wire type serializes")
}

fn from_json<T: DeserializeOwned>(v: Json) -> Result<T, ClientError> {
    serde_json::from_value(v).map_err(|e| ClientError::ProtocolViolation(e.to_string()))
}

/// `{"blob":{…}}` with no sibling members.
fn blob_stub(v: &serde_json::Map<String, Json>) -> Option<BlobRef> {
    if v.len() != 1 {
        return None;
    }
    serde_json::from_value(Json::Object(v.clone())).ok()
}

/// Text blobs replace their stub with the decoded string; other media stay stubs and are read on demand with `read_blob`.
fn is_text_media(media_type: &str) -> bool {
    media_type.starts_with("text/") || media_type == "application/json"
}

fn blob_error(e: ClientError) -> ClientError {
    match e.error_data() {
        Some(ErrorData::BlobNotFound { digest }) => ClientError::BlobNotFound(digest.to_string()),
        Some(ErrorData::BlobCorrupt { digest }) => ClientError::BlobCorrupt(digest.to_string()),
        _ => e,
    }
}

fn is_connection_end(e: &ClientError) -> bool {
    matches!(e, ClientError::ConnectionLost | ClientError::ClientClosed)
}

/// App-feed notifications whose params are a `SectionUpdate`.
fn is_section_method(method: &str) -> bool {
    SERVER_NOTIFICATIONS.iter().any(|n| {
        n.method == method && n.delivery == Some(Delivery::App) && n.params == "SectionUpdate"
    })
}

fn class_index(c: RequestClass) -> usize {
    c as usize
}

const INTERNAL: MethodInfo = MethodInfo {
    class: RequestClass::C0,
    op_scope: OpScopeRule::None,
};
const READ_C1: MethodInfo = MethodInfo {
    class: RequestClass::C1,
    op_scope: OpScopeRule::None,
};

// ───────────── shared state ─────────────

type Reply = oneshot::Sender<Result<Json, ClientError>>;

#[derive(Clone)]
enum Hook {
    /// Runs inside frame handling, before the next frame: records the attach position (and the subscription) of a feed.
    Attach {
        feed_id: String,
        thread: Option<(String, ResumeWindow)>,
    },
}

struct Park {
    op_id: String,
    scope: OpScope,
    method: String,
    params: Json,
    info: MethodInfo,
}
struct Unanswered {
    park: Park,
    reply: Reply,
}

enum FoldItem {
    Feed {
        n: RpcNotification,
        f: FeedStamp,
        snapshot: bool,
        cur_gen: u64,
    },
    Connection {
        n: RpcNotification,
        cur_gen: u64,
    },
}

#[derive(Default)]
struct StoreData {
    threads: HashMap<String, ThreadFold>,
    sections: HashMap<SectionName, BTreeMap<String, SectionEntry>>,
    app: Option<FeedStamp>,
}

struct Shared {
    status: ConnectionStatus,
    server: Option<InitializeResponse>,
    connected: bool,
    terminal: Option<ClientError>,
    store: StoreData,
    subs: Vec<(String, ResumeWindow)>,
    app_subscribed: bool,
    server_requests: Vec<ServerRequest>,
    recv: HashMap<String, (String, u64)>,
    generation: u64,
    responses: u64,
    class_responses: [u64; 4],
    feed_events: u64,
    thread_last_event: HashMap<String, u64>,
    unanswered: Vec<Unanswered>,
}

enum Cmd {
    /// The feed is unsubscribed: its fold lane ends once its queued items are done.
    DropLane { feed: String },
    Rpc {
        method: String,
        params: Json,
        cls: Option<RequestClass>,
        hook: Option<Hook>,
        park: Option<Box<Park>>,
        reply: Reply,
    },
    Send {
        frame: Json,
        reply: oneshot::Sender<Result<(), ClientError>>,
    },
    Close {
        reply: oneshot::Sender<()>,
    },
}

struct SentAt {
    all: u64,
    by_class: [u64; 4],
    feed: u64,
}

pub struct Inner {
    opts: ConnectOptions,
    shared: Mutex<Shared>,
    cmd: mpsc::UnboundedSender<Cmd>,
    pulse: watch::Sender<u64>,
    status: watch::Sender<ConnectionStatus>,
    events: broadcast::Sender<ClientEvent>,
    store_changes: broadcast::Sender<StoreChange>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().expect("client state poisoned")
    }
    fn emit(&self, e: ClientEvent) {
        let _ = self.events.send(e);
    }
    fn pulse(&self) {
        self.pulse.send_modify(|v| *v += 1);
    }
    fn set_status(&self, s: ConnectionStatus) {
        self.lock().status = s.clone();
        self.status.send_replace(s.clone());
        self.emit(ClientEvent::Status(s));
    }

    async fn rpc_once(
        &self,
        method: &str,
        params: Json,
        cls: Option<RequestClass>,
        hook: Option<Hook>,
        park: Option<Box<Park>>,
    ) -> Result<Json, ClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Cmd::Rpc {
                method: method.to_string(),
                params,
                cls,
                hook,
                park,
                reply,
            })
            .map_err(|_| ClientError::ClientClosed)?;
        rx.await.map_err(|_| ClientError::ClientClosed)?
    }

    async fn when_ready(&self) -> Result<(), ClientError> {
        let mut rx = self.status.subscribe();
        loop {
            match &*rx.borrow_and_update() {
                ConnectionStatus::Ready { .. } => return Ok(()),
                ConnectionStatus::Closed { reason } => return Err(reason.clone()),
                ConnectionStatus::Reconnecting { .. } => {}
            }
            rx.changed().await.map_err(|_| ClientError::ClientClosed)?;
        }
    }

    async fn wait_until(&self, done: impl Fn(&Shared) -> bool) {
        let mut rx = self.pulse.subscribe();
        loop {
            {
                let s = self.lock();
                if done(&s) || !s.connected || s.terminal.is_some() {
                    return;
                }
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// One call with its policy: ready wait, `-32001` retry on its trigger (SPEC R7), mutation parking for reconciliation.
    /// `stay` calls (stub resolution inside the fold) never wait for a reconnect: they fail `ConnectionLost` instead.
    async fn run(
        &self,
        method: &str,
        params: Json,
        info: &MethodInfo,
        hook: Option<Hook>,
        stay: bool,
    ) -> Result<Json, ClientError> {
        loop {
            if stay {
                if !matches!(self.lock().status, ConnectionStatus::Ready { .. }) {
                    return Err(ClientError::ConnectionLost);
                }
            } else {
                self.when_ready().await?;
            }
            let sent = {
                let s = self.lock();
                SentAt {
                    all: s.responses,
                    by_class: s.class_responses,
                    feed: s.feed_events,
                }
            };
            let park = if info.is_mutation() {
                let op_id = params
                    .get("opId")
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_string();
                let scope = info.op_scope_of(&params).ok_or_else(|| {
                    ClientError::ProtocolViolation(format!("{method}: op scope field missing"))
                })?;
                Some(Box::new(Park {
                    op_id,
                    scope,
                    method: method.to_string(),
                    params: params.clone(),
                    info: *info,
                }))
            } else {
                None
            };
            match self
                .rpc_once(method, params.clone(), Some(info.class), hook.clone(), park)
                .await
            {
                Err(e) if matches!(&e, ClientError::Rpc(b) if b.code == mixdog_app_protocol::error::OVERLOADED) => {
                    self.await_retry_trigger(e, &sent).await?
                }
                other => return other,
            }
        }
    }

    async fn await_retry_trigger(&self, e: ClientError, sent: &SentAt) -> Result<(), ClientError> {
        match e.error_data() {
            Some(ErrorData::InflightLimit { class, .. }) => {
                let i = class_index(class);
                self.wait_until(|s| s.class_responses[i] > sent.by_class[i])
                    .await;
            }
            Some(ErrorData::QueueFull { .. }) => self.wait_until(|s| s.responses > sent.all).await,
            Some(ErrorData::WindowFull { thread_id }) => {
                let t = thread_id.to_string();
                self.wait_until(|s| s.thread_last_event.get(&t).copied().unwrap_or(0) > sent.feed)
                    .await;
            }
            _ => return Err(e),
        }
        Ok(())
    }

    fn resume_params(&self, thread_id: &ThreadId, window: &ResumeWindow) -> Json {
        let s = self.lock();
        let resume_from = match (
            s.store.threads.get(thread_id.as_str()),
            s.subs.iter().find(|(t, _)| t == thread_id.as_str()),
        ) {
            (Some(prev), Some((_, pw))) => Some(ThreadResumePosition {
                epoch: prev.feed.epoch.clone(),
                seq: prev.feed.seq,
                window: pw.clone(),
            }),
            _ => None,
        };
        to_json(&ThreadResumeParams {
            thread_id: thread_id.clone(),
            window: window.clone(),
            resume_from,
        })
    }
    fn app_params(&self) -> Json {
        let resume_from =
            self.lock()
                .store
                .app
                .as_ref()
                .map(|a| mixdog_app_protocol::v2::feed::FeedPosition {
                    epoch: a.epoch.clone(),
                    seq: a.seq,
                });
        to_json(&AppSubscribeParams { resume_from })
    }

    async fn read_pages(&self, blob: &BlobDescriptor, stay: bool) -> Result<Vec<u8>, ClientError> {
        let page = self
            .lock()
            .server
            .as_ref()
            .expect("initialized")
            .limits
            .max_blob_page_bytes;
        let mut out = Vec::with_capacity(blob.bytes as usize);
        while (out.len() as u64) < blob.bytes {
            let offset = out.len() as u64;
            let params = to_json(&BlobReadParams {
                digest: blob.digest.clone(),
                offset: Some(offset),
                length: Some(page.min(blob.bytes - offset)),
            });
            let r: BlobReadResponse = from_json(
                self.run("blob/read", params, &READ_C1, None, stay)
                    .await
                    .map_err(blob_error)?,
            )?;
            let bytes = B64
                .decode(r.bytes_b64)
                .map_err(|e| ClientError::ProtocolViolation(e.to_string()))?;
            if bytes.is_empty() {
                return Err(ClientError::ProtocolViolation("empty blob page".into()));
            }
            out.extend(bytes);
        }
        Ok(out)
    }

    /// Replaces every text stub by its content. A stub that cannot be read stays a stub and its error is appended to
    /// `failed`; only the end of the connection aborts the whole resolution.
    fn resolve_blobs<'a>(
        &'a self,
        v: Json,
        failed: &'a mut Vec<ClientError>,
    ) -> Pin<Box<dyn Future<Output = Result<Json, ClientError>> + Send + 'a>> {
        Box::pin(async move {
            match v {
                Json::Array(items) => {
                    let mut out = Vec::with_capacity(items.len());
                    for x in items {
                        out.push(self.resolve_blobs(x, failed).await?);
                    }
                    Ok(Json::Array(out))
                }
                Json::Object(map) => {
                    if let Some(b) = blob_stub(&map) {
                        if !is_text_media(&b.blob.media_type) {
                            return Ok(Json::Object(map));
                        }
                        return match self.read_pages(&b.blob, true).await {
                            Ok(bytes) => {
                                Ok(Json::String(String::from_utf8_lossy(&bytes).into_owned()))
                            }
                            Err(e) if is_connection_end(&e) => Err(e),
                            Err(e) => {
                                failed.push(e);
                                Ok(Json::Object(map))
                            }
                        };
                    }
                    let mut out = serde_json::Map::new();
                    for (k, x) in map {
                        out.insert(k, self.resolve_blobs(x, failed).await?);
                    }
                    Ok(Json::Object(out))
                }
                other => Ok(other),
            }
        })
    }

    // ── folder ──

    fn apply_section(&self, st: &mut StoreData, u: SectionUpdate) {
        let bucket = st.sections.entry(u.section).or_default();
        let k = u.key.clone().unwrap_or_default();
        if bucket.get(&k).is_some_and(|c| c.revision >= u.revision) {
            return;
        }
        if u.removed == Some(true) {
            bucket.remove(&k);
        } else {
            bucket.insert(
                k,
                SectionEntry {
                    section: u.section,
                    key: u.key.clone(),
                    revision: u.revision,
                    value: u.value.unwrap_or(Json::Null),
                },
            );
        }
        let _ = self.store_changes.send(StoreChange::Section {
            section: u.section,
            key: u.key,
        });
    }

    async fn fold_item(&self, item: FoldItem) {
        match item {
            FoldItem::Connection { n, cur_gen } => {
                if self.lock().generation != cur_gen {
                    return;
                }
                if n.method == wire::SERVER_REQUEST_RESOLVED {
                    match n
                        .params
                        .clone()
                        .map(serde_json::from_value::<ServerRequestResolvedParams>)
                    {
                        Some(Ok(p)) => {
                            self.lock()
                                .server_requests
                                .retain(|r| *r.id() != p.request_id);
                            self.emit(ClientEvent::ServerRequestResolved(p));
                        }
                        _ => self.emit(ClientEvent::ProtocolViolation(
                            "bad serverRequest/resolved".into(),
                        )),
                    }
                } else {
                    self.emit(ClientEvent::Notification(n));
                }
            }
            FoldItem::Feed {
                n,
                f,
                snapshot,
                cur_gen,
            } => {
                let mut failed = Vec::new();
                let params = match self
                    .resolve_blobs(n.params.clone().unwrap_or(Json::Null), &mut failed)
                    .await
                {
                    Ok(p) => p,
                    Err(_) => return,
                };
                for error in failed {
                    self.emit(ClientEvent::BlobUnavailable {
                        feed: f.clone(),
                        error,
                    });
                }
                let mut resolved = n;
                resolved.params = Some(params.clone());
                let mut passthrough = None;
                {
                    let mut guard = self.lock();
                    if guard.generation != cur_gen {
                        return;
                    }
                    let st = &mut guard.store;
                    if f.id.as_str() == APP_FEED_ID {
                        st.app = Some(f);
                        if snapshot {
                            match serde_json::from_value::<AppSnapshotParams>(params) {
                                Ok(p) => {
                                    st.sections.clear();
                                    for u in p.sections {
                                        self.apply_section(st, u);
                                    }
                                }
                                Err(e) => self.emit(ClientEvent::ProtocolViolation(format!(
                                    "bad app/snapshot: {e}"
                                ))),
                            }
                        } else if is_section_method(&resolved.method) {
                            match serde_json::from_value::<SectionUpdate>(params) {
                                Ok(u) => self.apply_section(st, u),
                                Err(e) => self.emit(ClientEvent::ProtocolViolation(format!(
                                    "bad section update: {e}"
                                ))),
                            }
                        } else {
                            passthrough = Some(resolved);
                        }
                    } else {
                        let reducer = &self.opts.thread_reducer;
                        let state = if snapshot {
                            reducer
                                .as_ref()
                                .map_or_else(|| params.clone(), |r| r.initial(&params))
                        } else if let Some(prev) = st.threads.get(f.id.as_str()) {
                            reducer.as_ref().map_or_else(
                                || prev.state.clone(),
                                |r| r.apply(&prev.state, &resolved),
                            )
                        } else {
                            return;
                        };
                        let id = f.id.to_string();
                        st.threads.insert(id.clone(), ThreadFold { feed: f, state });
                        let _ = self
                            .store_changes
                            .send(StoreChange::Thread { thread_id: id });
                    }
                }
                if let Some(n) = passthrough {
                    self.emit(ClientEvent::Notification(n));
                }
            }
        }
    }

    // ── op reconciliation (protocol.md §9) ──

    /// One independent `op/status` per scope: a slow scope never holds back another.
    fn reconcile_ops(self: &Arc<Self>) {
        let mut by_scope: Vec<(String, Vec<String>)> = Vec::new();
        for u in &self.lock().unanswered {
            match by_scope.iter_mut().find(|(s, _)| *s == u.park.scope) {
                Some((_, ids)) => ids.push(u.park.op_id.clone()),
                None => by_scope.push((u.park.scope.clone(), vec![u.park.op_id.clone()])),
            }
        }
        for (scope, op_ids) in by_scope {
            tokio::spawn(self.clone().reconcile_scope(scope, op_ids));
        }
    }

    /// `op/status` is an ordinary call (ready wait, `-32001` retry). The end of the connection leaves the scope parked for the
    /// next reconnect's reconciliation; any other failure ends the scope's parked calls with `OpOutcomeUnknown`.
    async fn reconcile_scope(self: Arc<Self>, scope: String, op_ids: Vec<String>) {
        let params = OpStatusParams {
            scope: OpScopeName(scope),
            op_ids: op_ids.iter().map(|i| OpId::from(i.as_str())).collect(),
            fence: true,
        };
        let info = method_info("op/status").unwrap_or(INTERNAL);
        let outcome = match self
            .run("op/status", to_json(&params), &info, None, false)
            .await
        {
            Ok(reply) => from_json::<OpStatusResponse>(reply),
            Err(e) => Err(e),
        };
        let take = |op_id: &str| {
            let mut s = self.lock();
            s.unanswered
                .iter()
                .position(|u| u.park.op_id == op_id)
                .map(|i| s.unanswered.remove(i))
        };
        let response = match outcome {
            Ok(r) => r,
            Err(ClientError::ConnectionLost | ClientError::ClientClosed) => return,
            Err(cause) => {
                for op_id in &op_ids {
                    if let Some(u) = take(op_id) {
                        let error = ClientError::OpOutcomeUnknown {
                            op_id: op_id.clone(),
                            state: "statusFailed".into(),
                            cause: Some(Box::new(cause.clone())),
                        };
                        let _ = u.reply.send(Err(error));
                    }
                }
                return;
            }
        };
        for op_id in op_ids {
            let Some(u) = take(&op_id) else { continue };
            match response.ops.iter().find(|e| e.op_id.as_str() == op_id) {
                None => {
                    let _ = u.reply.send(Err(ClientError::ProtocolViolation(format!(
                        "op/status omitted {op_id}"
                    ))));
                }
                Some(e) => self.clone().settle(u, e.state.clone()),
            }
        }
    }

    /// Each subscription is re-attached by its own task: a slow `thread/resume` delays only that feed.
    fn restore_subscriptions(self: &Arc<Self>) {
        let (subs, app) = {
            let s = self.lock();
            (s.subs.clone(), s.app_subscribed)
        };
        for (thread_id, window) in subs {
            tokio::spawn(self.clone().restore_thread(thread_id, window));
        }
        if app {
            tokio::spawn(self.clone().restore_app());
        }
    }

    /// An rpc error drops the subscription; the end of the connection is the ladder's business.
    async fn restore_thread(self: Arc<Self>, thread_id: String, window: ResumeWindow) {
        let params = self.resume_params(&ThreadId::from(thread_id.as_str()), &window);
        let hook = Hook::Attach {
            feed_id: thread_id.clone(),
            thread: Some((thread_id.clone(), window)),
        };
        if let Err(error @ ClientError::Rpc(_)) = self
            .run("thread/resume", params, &INTERNAL, Some(hook), false)
            .await
        {
            {
                let mut s = self.lock();
                s.subs.retain(|(t, _)| *t != thread_id);
                s.store.threads.remove(&thread_id);
            }
            self.emit(ClientEvent::SubscriptionLost { thread_id, error });
        }
    }
    async fn restore_app(self: Arc<Self>) {
        let hook = Hook::Attach {
            feed_id: APP_FEED_ID.to_string(),
            thread: None,
        };
        if let Err(error @ ClientError::Rpc(_)) = self
            .run(
                "app/subscribe",
                self.app_params(),
                &INTERNAL,
                Some(hook),
                false,
            )
            .await
        {
            self.lock().app_subscribed = false;
            self.emit(ClientEvent::SubscriptionLost {
                thread_id: APP_FEED_ID.to_string(),
                error,
            });
        }
    }

    fn settle(self: Arc<Self>, u: Unanswered, state: OpState) {
        let Unanswered { park, reply } = u;
        let unknown = |state: &str| ClientError::OpOutcomeUnknown {
            op_id: park.op_id.clone(),
            state: state.to_string(),
            cause: None,
        };
        match state {
            OpState::Applied { result, .. } => {
                let _ = reply.send(Ok(result.unwrap_or(Json::Null)));
            }
            OpState::Rejected { error } => {
                let _ =
                    reply
                        .send(Err(from_json::<JsonRpcErrorBody>(error)
                            .map_or_else(|e| e, ClientError::Rpc)));
            }
            OpState::InProgress => {
                // Same opId and payload: the core attaches the request to the running execution (§9.3).
                tokio::spawn(async move {
                    let _ = reply.send(
                        self.run(&park.method, park.params, &park.info, None, false)
                            .await,
                    );
                });
            }
            OpState::NotApplied => {
                let _ = reply.send(Err(ClientError::OpNotApplied(park.op_id)));
            }
            OpState::ExternalUnknown { .. } => {
                let _ = reply.send(Err(unknown("externalUnknown")));
            }
            OpState::Expired => {
                let _ = reply.send(Err(unknown("expired")));
            }
        }
    }
}

// ───────────── driver ─────────────

struct Pending {
    cls: Option<RequestClass>,
    hook: Option<Hook>,
    park: Option<Box<Park>>,
    reply: Reply,
}

enum Wake {
    Cmd(Box<Option<Cmd>>),
    Event(TransportEvent),
}

async fn next_event(reader: &mut Option<Box<dyn TransportReader>>) -> TransportEvent {
    match reader {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

struct Driver {
    inner: Arc<Inner>,
    cmd_rx: mpsc::UnboundedReceiver<Cmd>,
    writer: Option<Box<dyn TransportWriter>>,
    reader: Option<Box<dyn TransportReader>>,
    pending: HashMap<u64, Pending>,
    /// Fold lanes of the current connection; dropped with it (queued items of the old generation are discarded by their check).
    lanes: HashMap<Option<String>, mpsc::UnboundedSender<FoldItem>>,
    next_id: u64,
    ever_ready: bool,
    done: bool,
}

impl Driver {
    async fn open(&mut self) -> Result<(), ClientError> {
        let halves = self
            .inner
            .opts
            .connector
            .open(&self.inner.opts.target)
            .await
            .map_err(ClientError::Connector)?;
        self.writer = Some(halves.writer);
        self.reader = Some(halves.reader);
        self.inner.lock().connected = true;
        Ok(())
    }

    async fn drop_transport(&mut self, reason: &str) {
        if let Some(mut w) = self.writer.take() {
            w.close(1000, reason.to_string()).await;
        }
        self.reader = None;
        self.inner.lock().connected = false;
    }

    async fn write(&mut self, frame: &Json) -> Result<(), ClientError> {
        let w = self.writer.as_mut().ok_or(ClientError::ConnectionLost)?;
        w.send(frame.to_string())
            .await
            .map_err(|_| ClientError::ConnectionLost)
    }

    async fn violation(&mut self, code: u16, what: &str) {
        self.inner
            .emit(ClientEvent::ProtocolViolation(what.to_string()));
        if let Some(w) = self.writer.as_mut() {
            w.close(code, what.to_string()).await;
        }
    }

    async fn register(
        &mut self,
        method: String,
        params: Json,
        cls: Option<RequestClass>,
        hook: Option<Hook>,
        park: Option<Box<Park>>,
        reply: Reply,
    ) {
        if self.writer.is_none() {
            let terminal = self.inner.lock().terminal.clone();
            match (terminal, park) {
                (Some(t), _) => {
                    let _ = reply.send(Err(t));
                }
                (None, Some(park)) => self
                    .inner
                    .lock()
                    .unanswered
                    .push(Unanswered { park: *park, reply }),
                (None, None) => {
                    let _ = reply.send(Err(ClientError::ConnectionLost));
                }
            }
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "method": method });
        if !params.is_null() {
            frame["params"] = params;
        }
        // A frame that cannot be written was never sent; treat it like a lost one (parked mutations are reconciled).
        let _ = self.write(&frame).await;
        self.pending.insert(
            id,
            Pending {
                cls,
                hook,
                park,
                reply,
            },
        );
    }

    /// Sends a request and drives the connection until its response (used for handshake and restore).
    async fn rpc_inline(
        &mut self,
        method: &str,
        params: Json,
        hook: Option<Hook>,
    ) -> Result<Json, ClientError> {
        let (tx, mut rx) = oneshot::channel();
        self.register(method.to_string(), params, None, hook, None, tx)
            .await;
        loop {
            let wake = tokio::select! {
                r = &mut rx => return r.map_err(|_| ClientError::ClientClosed)?,
                c = self.cmd_rx.recv() => Wake::Cmd(Box::new(c)),
                e = next_event(&mut self.reader) => Wake::Event(e),
            };
            self.handle(wake).await;
        }
    }

    /// Returns true when the transport closed.
    async fn handle(&mut self, wake: Wake) -> bool {
        match wake {
            Wake::Cmd(c) => match *c {
                Some(c) => self.on_cmd(c).await,
                None => self.done = true,
            },
            Wake::Event(TransportEvent::Frame(t)) => self.on_frame(&t).await,
            Wake::Event(TransportEvent::Closed { .. }) => {
                self.on_closed();
                return true;
            }
        }
        false
    }

    async fn on_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::DropLane { feed } => {
                self.lanes.remove(&Some(feed));
            }
            Cmd::Rpc {
                method,
                params,
                cls,
                hook,
                park,
                reply,
            } => self.register(method, params, cls, hook, park, reply).await,
            Cmd::Send { frame, reply } => {
                let r = self.write(&frame).await;
                let _ = reply.send(r);
            }
            Cmd::Close { reply } => {
                if self.inner.lock().terminal.is_none() {
                    self.terminate(ClientError::ClientClosed);
                    if let Some(mut w) = self.writer.take() {
                        w.close(1000, "client closed".into()).await;
                    }
                    self.reader = None;
                }
                self.done = true;
                let _ = reply.send(());
            }
        }
    }

    fn on_closed(&mut self) {
        self.writer = None;
        self.reader = None;
        self.lanes.clear();
        let mut ids: Vec<u64> = self.pending.keys().copied().collect();
        ids.sort_unstable();
        {
            let mut s = self.inner.lock();
            s.connected = false;
            s.generation += 1;
            s.recv.clear();
            s.server_requests.clear();
            for id in ids {
                let p = self.pending.remove(&id).expect("pending id");
                match p.park {
                    Some(park) => s.unanswered.push(Unanswered {
                        park: *park,
                        reply: p.reply,
                    }),
                    None => {
                        let _ = p.reply.send(Err(ClientError::ConnectionLost));
                    }
                }
            }
        }
        self.inner.pulse();
    }

    fn terminate(&mut self, detail: ClientError) {
        let mut ids: Vec<u64> = self.pending.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let _ = self
                .pending
                .remove(&id)
                .expect("pending id")
                .reply
                .send(Err(detail.clone()));
        }
        {
            let mut s = self.inner.lock();
            s.terminal = Some(detail.clone());
            s.connected = false;
            for u in s.unanswered.drain(..) {
                let _ = u.reply.send(Err(detail.clone()));
            }
        }
        self.inner.pulse();
        self.inner
            .set_status(ConnectionStatus::Closed { reason: detail });
    }

    async fn on_frame(&mut self, text: &str) {
        let Ok(m) = serde_json::from_str::<Json>(text) else {
            return self.violation(1007, "invalid json").await;
        };
        if !m.is_object() {
            return self.violation(1007, "frame is not an object").await;
        }
        if m.get("method").and_then(Json::as_str).is_some() {
            if m.get("id").is_some() {
                match serde_json::from_value::<ServerRequest>(m) {
                    Ok(r) => {
                        self.inner.lock().server_requests.push(r.clone());
                        self.inner.emit(ClientEvent::ServerRequest(r));
                    }
                    Err(e) => self.inner.emit(ClientEvent::ProtocolViolation(format!(
                        "bad server request: {e}"
                    ))),
                }
            } else {
                match serde_json::from_value::<RpcNotification>(m) {
                    Ok(n) => self.on_notification(n).await,
                    Err(_) => self.violation(1007, "bad notification").await,
                }
            }
            return;
        }
        // RFC 6455: 1007 for a payload that does not decode, 1002 for a sequence violation.
        let Some(id) = m
            .get("id")
            .and_then(Json::as_u64)
            .filter(|id| self.pending.contains_key(id))
        else {
            return self.violation(1002, "response to unknown request").await;
        };
        let body = match m
            .get("error")
            .map(|err| serde_json::from_value::<JsonRpcErrorBody>(err.clone()))
        {
            Some(Err(_)) => return self.violation(1007, "bad error body").await, // stays pending: the close settles it
            Some(Ok(body)) => Some(body),
            None => None,
        };
        let p = self.pending.remove(&id).expect("checked above");
        if let Some(body) = body {
            if body.code != mixdog_app_protocol::error::OVERLOADED {
                self.count_response(p.cls);
            }
            let _ = p.reply.send(Err(ClientError::Rpc(body)));
            return;
        }
        self.count_response(p.cls);
        let result = m.get("result").cloned().unwrap_or(Json::Null);
        if let Some(Hook::Attach { feed_id, thread }) = &p.hook {
            let Some(s) = result
                .get("subscription")
                .and_then(|s| serde_json::from_value::<Subscription>(s.clone()).ok())
            else {
                let _ = p.reply.send(Err(ClientError::ProtocolViolation(
                    "response without subscription".into(),
                )));
                return;
            };
            let mut sh = self.inner.lock();
            sh.recv.insert(
                feed_id.clone(),
                (s.epoch.to_string(), s.start_seq.saturating_sub(1)),
            );
            match thread {
                Some((id, w)) => match sh.subs.iter_mut().find(|(t, _)| t == id) {
                    Some(e) => e.1 = w.clone(),
                    None => sh.subs.push((id.clone(), w.clone())),
                },
                None => sh.app_subscribed = true,
            }
        }
        let _ = p.reply.send(Ok(result));
    }

    fn count_response(&self, cls: Option<RequestClass>) {
        {
            let mut s = self.inner.lock();
            s.responses += 1;
            if let Some(c) = cls {
                s.class_responses[class_index(c)] += 1;
            }
        }
        self.inner.pulse();
    }

    /// Queues `item` on its feed's lane (`None`: connection-scoped notifications). Each lane is its own task, so a feed whose
    /// blob stubs are slow to resolve delays only itself; order within a lane is arrival order.
    fn fold(&mut self, lane: Option<String>, item: FoldItem) {
        let inner = &self.inner;
        let tx = self.lanes.entry(lane).or_insert_with(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<FoldItem>();
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some(item) = rx.recv().await {
                    inner.fold_item(item).await;
                }
            });
            tx
        });
        let _ = tx.send(item);
    }

    async fn on_notification(&mut self, n: RpcNotification) {
        let cur_gen = self.inner.lock().generation;
        let Some(f) = n.feed.clone() else {
            self.fold(None, FoldItem::Connection { n, cur_gen });
            return;
        };
        let snapshot = n.method == wire::THREAD_SNAPSHOT || n.method == wire::APP_SNAPSHOT;
        let id = f.id.to_string();
        let gap = {
            let mut s = self.inner.lock();
            s.feed_events += 1;
            let at = s.feed_events;
            s.thread_last_event.insert(id.clone(), at);
            let tracked = if id == APP_FEED_ID {
                s.app_subscribed
            } else {
                s.subs.iter().any(|(t, _)| *t == id)
            };
            if !tracked {
                None
            } else {
                let cur = s.recv.get(&id);
                let bad = !snapshot
                    && !cur.is_some_and(|(e, q)| *e == f.epoch.as_str() && f.seq == q + 1);
                if !bad {
                    s.recv.insert(id.clone(), (f.epoch.to_string(), f.seq));
                }
                Some(bad)
            }
        };
        self.inner.pulse();
        match gap {
            None => {}
            Some(true) => self.violation(1002, &format!("feed gap on {id}")).await,
            Some(false) => {
                self.fold(
                    Some(id),
                    FoldItem::Feed {
                        n,
                        f,
                        snapshot,
                        cur_gen,
                    },
                );
            }
        }
    }

    async fn handshake(&mut self) -> Result<(), ClientError> {
        let params = InitializeParams {
            client_info: self.inner.opts.client_info.clone(),
            capabilities: Some(self.inner.opts.capabilities.clone()),
        };
        let result = match self.rpc_inline("initialize", to_json(&params), None).await {
            Ok(r) => r,
            Err(e) => {
                return Err(match e.error_data() {
                    Some(ErrorData::ClientOutdated {
                        server_version,
                        client_version,
                    }) => ClientError::VersionRefused {
                        reason: "clientOutdated".into(),
                        server_version,
                        client_version,
                    },
                    Some(ErrorData::ServerOutdated {
                        server_version,
                        client_version,
                    }) => ClientError::VersionRefused {
                        reason: "serverOutdated".into(),
                        server_version,
                        client_version,
                    },
                    _ => e,
                });
            }
        };
        let server: InitializeResponse = from_json(result)?;
        self.inner.lock().server = Some(server);
        self.write(&json!({ "method": "initialized" })).await
    }

    /// Sleeps `ms` while still serving commands; false if the client terminated meanwhile.
    async fn sleep(&mut self, ms: u64) -> bool {
        let clock = self.inner.opts.clock.clone();
        let mut s = Box::pin(clock.sleep(ms));
        loop {
            let cmd = tokio::select! {
                _ = &mut s => return self.inner.lock().terminal.is_none(),
                c = self.cmd_rx.recv() => c,
            };
            match cmd {
                Some(c) => self.on_cmd(c).await,
                None => self.done = true,
            }
            if self.done {
                return false;
            }
        }
    }

    async fn reconnect(&mut self) {
        let mut attempt: u32 = 0;
        loop {
            if self.done || self.inner.lock().terminal.is_some() {
                return;
            }
            self.inner
                .set_status(ConnectionStatus::Reconnecting { attempt });
            let delay = ladder_delay(
                attempt,
                self.inner.opts.clock.jitter(),
                self.inner.opts.ladder,
            );
            if !self.sleep(delay).await {
                return;
            }
            let outcome = async {
                self.open().await?;
                self.handshake().await
            }
            .await;
            match outcome {
                Ok(()) => {
                    let id = self
                        .inner
                        .lock()
                        .server
                        .as_ref()
                        .expect("initialized")
                        .server_instance_id
                        .clone();
                    self.inner.set_status(ConnectionStatus::Ready {
                        server_instance_id: id,
                    });
                    // The connection is usable now. Each subscription and each scope's reconciliation proceeds independently.
                    self.inner.restore_subscriptions();
                    self.inner.reconcile_ops();
                    return;
                }
                Err(e @ ClientError::VersionRefused { .. }) => {
                    self.drop_transport("version refused").await;
                    self.terminate(e);
                    return;
                }
                Err(_) => {
                    if self.done {
                        return;
                    }
                    self.drop_transport("attempt failed").await;
                    attempt += 1;
                }
            }
        }
    }

    async fn run(mut self) {
        while !self.done {
            let wake = tokio::select! {
                c = self.cmd_rx.recv() => Wake::Cmd(Box::new(c)),
                e = next_event(&mut self.reader) => Wake::Event(e),
            };
            if self.handle(wake).await && !self.done && self.ever_ready {
                self.reconnect().await;
            }
        }
    }
}

// ───────────── public client ─────────────

pub struct Client {
    inner: Arc<Inner>,
}

struct StoreView(Arc<Inner>);

impl FoldStore for StoreView {
    fn thread(&self, thread_id: &str) -> Option<ThreadFold> {
        self.0.lock().store.threads.get(thread_id).cloned()
    }
    fn section(&self, section: SectionName, key: Option<&str>) -> Option<SectionEntry> {
        self.0
            .lock()
            .store
            .sections
            .get(&section)?
            .get(key.unwrap_or_default())
            .cloned()
    }
    fn sections(&self, section: SectionName) -> Vec<SectionEntry> {
        self.0
            .lock()
            .store
            .sections
            .get(&section)
            .map(|b| b.values().cloned().collect())
            .unwrap_or_default()
    }
    fn app_feed(&self) -> Option<FeedStamp> {
        self.0.lock().store.app.clone()
    }
    fn subscribe(&self) -> broadcast::Receiver<StoreChange> {
        self.0.store_changes.subscribe()
    }
}

/// Opens the transport, performs `initialize` + `initialized`, and returns when the connection is ready. A failure before the
/// first ready connection is the caller's to handle (e.g. start the core); the ladder only runs after a ready connection drops.
pub async fn connect(options: ConnectOptions) -> Result<Client, ClientError> {
    let (cmd, cmd_rx) = mpsc::unbounded_channel();
    let shared = Shared {
        status: ConnectionStatus::Reconnecting { attempt: 0 },
        server: None,
        connected: false,
        terminal: None,
        store: StoreData::default(),
        subs: Vec::new(),
        app_subscribed: false,
        server_requests: Vec::new(),
        recv: HashMap::new(),
        generation: 0,
        responses: 0,
        class_responses: [0; 4],
        feed_events: 0,
        thread_last_event: HashMap::new(),
        unanswered: Vec::new(),
    };
    let inner = Arc::new(Inner {
        opts: options,
        status: watch::channel(shared.status.clone()).0,
        shared: Mutex::new(shared),
        cmd,
        pulse: watch::channel(0).0,
        events: broadcast::channel(1024).0,
        store_changes: broadcast::channel(1024).0,
    });
    let mut driver = Driver {
        inner: inner.clone(),
        cmd_rx,
        writer: None,
        reader: None,
        pending: HashMap::new(),
        lanes: HashMap::new(),
        next_id: 1,
        ever_ready: false,
        done: false,
    };
    driver.open().await?;
    if let Err(e) = driver.handshake().await {
        driver.drop_transport("handshake failed").await;
        return Err(e);
    }
    driver.ever_ready = true;
    let id = inner
        .lock()
        .server
        .as_ref()
        .expect("initialized")
        .server_instance_id
        .clone();
    inner.set_status(ConnectionStatus::Ready {
        server_instance_id: id,
    });
    tokio::spawn(driver.run());
    Ok(Client { inner })
}

#[async_trait]
impl ProtocolClient for Client {
    fn store(&self) -> Arc<dyn FoldStore> {
        Arc::new(StoreView(self.inner.clone()))
    }
    fn server(&self) -> InitializeResponse {
        self.inner.lock().server.clone().expect("initialized")
    }
    fn status(&self) -> ConnectionStatus {
        self.inner.lock().status.clone()
    }

    async fn call_raw(
        &self,
        method: &str,
        params: Json,
        options: CallOptions,
    ) -> Result<Json, ClientError> {
        let info =
            method_info(method).ok_or_else(|| ClientError::UnknownMethod(method.to_string()))?;
        let mut params = params;
        if info.is_mutation() {
            let obj = params.as_object_mut().ok_or_else(|| {
                ClientError::ProtocolViolation("mutation params must be an object".into())
            })?;
            let given = obj.get("opId").and_then(Json::as_str).map(str::to_string);
            let op_id = options.op_id.or(given).unwrap_or_else(|| {
                self.inner
                    .opts
                    .new_op_id
                    .as_ref()
                    .map_or_else(new_op_id, |f| f())
            });
            obj.insert("opId".into(), Json::String(op_id));
        }
        self.inner.run(method, params, &info, None, false).await
    }

    async fn notify(&self, method: &str, params: Json) -> Result<(), ClientError> {
        self.send_frame(json!({ "method": method, "params": params }))
            .await
    }

    async fn resume_thread(
        &self,
        thread_id: &ThreadId,
        window: ResumeWindow,
    ) -> Result<ThreadResumeResponse, ClientError> {
        let params = self.inner.resume_params(thread_id, &window);
        let hook = Hook::Attach {
            feed_id: thread_id.to_string(),
            thread: Some((thread_id.to_string(), window)),
        };
        from_json(
            self.inner
                .run("thread/resume", params, &INTERNAL, Some(hook), false)
                .await?,
        )
    }

    async fn unsubscribe_thread(&self, thread_id: &ThreadId) -> Result<(), ClientError> {
        {
            let mut s = self.inner.lock();
            s.subs.retain(|(t, _)| t != thread_id.as_str());
            s.recv.remove(thread_id.as_str());
            s.store.threads.remove(thread_id.as_str());
        }
        let _ = self.inner.cmd.send(Cmd::DropLane {
            feed: thread_id.as_str().to_string(),
        });
        let params = to_json(&ThreadIdParams {
            thread_id: thread_id.clone(),
        });
        self.inner
            .run("thread/unsubscribe", params, &INTERNAL, None, false)
            .await
            .map(|_| ())
    }

    async fn subscribe_app(&self) -> Result<(), ClientError> {
        let hook = Hook::Attach {
            feed_id: APP_FEED_ID.to_string(),
            thread: None,
        };
        self.inner
            .run(
                "app/subscribe",
                self.inner.app_params(),
                &INTERNAL,
                Some(hook),
                false,
            )
            .await
            .map(|_| ())
    }

    fn pending_server_requests(&self) -> Vec<ServerRequest> {
        self.inner.lock().server_requests.clone()
    }

    async fn respond(&self, id: RequestId, answer: ServerRequestAnswer) -> Result<(), ClientError> {
        let mut frame = json!({ "id": id });
        match answer {
            ServerRequestAnswer::Result(r) => frame["result"] = r,
            ServerRequestAnswer::Error {
                code,
                message,
                data,
            } => {
                frame["error"] = json!({ "code": code, "message": message });
                if let Some(d) = data {
                    frame["error"]["data"] = d;
                }
            }
        }
        self.send_frame(frame).await
    }

    async fn read_blob(&self, blob: &BlobRef) -> Result<Vec<u8>, ClientError> {
        self.inner.read_pages(&blob.blob, false).await
    }

    async fn put_blob(&self, bytes: &[u8], media_type: &str) -> Result<BlobRef, ClientError> {
        let digest: BlobDigest = format!(
            "sha256:{}",
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
        .parse()
        .map_err(|e: InvalidBlobDigest| ClientError::ProtocolViolation(e.to_string()))?;
        let chunk = self
            .inner
            .lock()
            .server
            .as_ref()
            .expect("initialized")
            .limits
            .max_blob_put_chunk_bytes as usize;
        let mut offset = 0;
        loop {
            let end = (offset + chunk).min(bytes.len());
            let params = to_json(&BlobPutParams {
                digest: digest.clone(),
                offset: offset as u64,
                bytes_b64: B64.encode(&bytes[offset..end]),
            });
            self.inner
                .run("blob/put", params, &READ_C1, None, false)
                .await?;
            offset += chunk;
            if offset >= bytes.len() {
                break;
            }
        }
        Ok(BlobRef {
            blob: BlobDescriptor {
                digest,
                bytes: bytes.len() as u64,
                media_type: media_type.to_string(),
            },
        })
    }

    fn events(&self) -> broadcast::Receiver<ClientEvent> {
        self.inner.events.subscribe()
    }

    async fn close(&self) {
        let (reply, rx) = oneshot::channel();
        if self.inner.cmd.send(Cmd::Close { reply }).is_ok() {
            let _ = rx.await;
        }
    }
}

impl Drop for Client {
    /// The driver and folder hold the shared state, so they would outlive the last handle; dropping it closes the connection.
    fn drop(&mut self) {
        let (reply, _) = oneshot::channel();
        let _ = self.inner.cmd.send(Cmd::Close { reply });
    }
}

impl Client {
    async fn send_frame(&self, frame: Json) -> Result<(), ClientError> {
        let (reply, rx) = oneshot::channel();
        self.inner
            .cmd
            .send(Cmd::Send { frame, reply })
            .map_err(|_| ClientError::ClientClosed)?;
        rx.await.map_err(|_| ClientError::ClientClosed)?
    }
}
