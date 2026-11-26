use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute};
use mixdog_agent::fork::{forked_request_stubbed, send_forked};
use mixdog_agent::response::ModelResponse;
use mixdog_core_api::domain::provider::{ModelRequest, ProviderAdapter};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::turn_ops::{SIDE_QUESTION_NO_REQUEST, SideEnd, SideFailure, SideQuestions, SideReply, SideRun};
use mixdog_rt::CancellationToken;

use super::summary_routes::{ForkSender, SavedRequest};

/// A request a side question forks (`sideQuestionRequestSnapshot`): the request as the loop sent it
/// and the provider that sent it.
#[derive(Clone)]
pub struct SideMaterial {
    /// Shared with the fork sender captured beside it ([`super::side_requests::RequestFork`]) and with the loop that sent it:
    /// the request as sent, which may end with its tail reminder; what the store means by it is the request without that
    /// reminder ([`mixdog_agent::kept_messages`], [`mixdog_agent::without_tail_reminder`]).
    pub request: Arc<ModelRequest>,
    pub provider: Arc<dyn ProviderAdapter>,
}

struct Entry {
    request: SavedRequest,
    sender: Arc<dyn ForkSender>,
    side: SideMaterial,
    /// The reply the request produced; `None` until its send settles with an answer.
    reply: Option<ModelResponse>,
}

/// One captured request. Its identity is the allocation: a failed send restores only its own
/// predecessor, and a settle reaches the request itself even after a later capture displaced it
/// (the displaced one comes back, settled, if that later send fails).
type Slot = Arc<Mutex<Entry>>;

fn lock(slot: &Slot) -> std::sync::MutexGuard<'_, Entry> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a capture holds; [`SideQuestionStore::settle`] and [`SideQuestionStore::discard`] take it
/// back. `previous` is what the capture displaced (`None`: the session had no request).
pub struct Capture {
    thread: String,
    slot: Slot,
    kept: bool,
    previous: Option<Slot>,
}

/// The cache warmer as the store tells it of the main loop's sends (`side-question-store.mjs`): every send, the kept or not
/// (an agent-owned session keeps no request but is warmed like any other), its settled reply, and the end of its prefix.
pub trait SendWarmth: Send + Sync {
    /// `noteCacheWarmActivity`: a request of the main loop is going out.
    fn sending(&self, thread: &ThreadId, provider_name: &str, side: &SideMaterial, sent_at: u64);
    /// `armCacheWarm`: that request settled with `reply`.
    fn settled(&self, thread: &ThreadId, provider_name: &str, side: &SideMaterial, sent_at: u64, reply: &ModelResponse);
    /// `forgetCacheWarm`: the session's chain ends with its durable touch (a rewrite, a route change, a tombstone), loaded
    /// or not.
    fn forget(&self, thread: &ThreadId);
    /// `cancelCacheWarm`: the chain ends and the touch stays for the restart re-arm (a detach).
    fn cancel(&self, thread: &ThreadId);
}

#[derive(Default)]
pub struct SideQuestionStore {
    requests: Mutex<HashMap<String, Slot>>,
    warm: std::sync::OnceLock<Arc<dyn SendWarmth>>,
    ended: std::sync::OnceLock<SideEndHook>,
}

type SideEndHook = Box<dyn Fn(&ThreadId, SideEnd) + Send + Sync>;

/// The fork of a session with no saved request. A compaction only sends it for a request that
/// `SessionFork` found forkable, so reaching it is a bug of the caller.
pub(crate) struct NoSavedRequest;

#[async_trait]
impl ForkSender for NoSavedRequest {
    async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        Err(SummaryFailure::Failed("no saved request to fork".to_owned()))
    }
}

/// The same slot that supplied the fork's token count and route. A replacement or rewrite
/// while the summary route is being resolved must not send the superseded prefix.
struct CompactionFork {
    store: Arc<SideQuestionStore>,
    thread: ThreadId,
    slot: Slot,
}

#[async_trait]
impl ForkSender for CompactionFork {
    async fn send(&self, route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        let sender = {
            let requests = self.store.requests();
            let entry = lock(&self.slot);
            if requests.get(self.thread.as_str()).is_none_or(|current| !Arc::ptr_eq(current, &self.slot)) || !entry.request.settled || entry.request.compacted {
                return Err(SummaryFailure::Failed("saved compaction request is no longer current".to_owned()));
            }
            entry.sender.clone()
        };
        sender.send(route).await
    }
}

impl SideQuestionStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The process's cache warmer, bound once after it is built (it reads this store's request source).
    pub fn bind_warm(&self, warm: Arc<dyn SendWarmth>) {
        let _ = self.warm.set(warm);
    }

    /// `captureSideQuestionRequest`: records the request the loop is sending as the session's
    /// latest. An agent-owned session keeps nothing (`/btw` is a Lead command). The request starts
    /// unsettled and uncompacted.
    pub fn capture(&self, thread: &ThreadId, request: SavedRequest, sender: Arc<dyn ForkSender>, side: SideMaterial, agent_owner: bool) -> Capture {
        let kept = !agent_owner;
        let request = SavedRequest { settled: false, compacted: false, ..request };
        if let Some(warm) = self.warm.get() {
            warm.sending(thread, &request.provider_name, &side, request.sent_at);
        }
        let slot: Slot = Arc::new(Mutex::new(Entry { request, sender, side, reply: None }));
        let previous = if kept { self.requests().insert(thread.as_str().to_owned(), slot.clone()) } else { None };
        Capture { thread: thread.as_str().to_owned(), slot, kept, previous }
    }

    /// `handle.settle(response)`: the reply settled with an answer (`response` truthy). It sets the
    /// captured request itself, wherever it now is, and a settled one arms the session's next warm.
    pub fn settle(&self, capture: &Capture, response: Option<ModelResponse>) {
        let mut entry = lock(&capture.slot);
        entry.request.settled = response.is_some();
        entry.reply = response;
        drop(entry);
        self.arm(capture);
    }

    /// [`SideQuestionStore::settle`] that also records the tokens of the forked messages plus the
    /// tool-schema reserve a compaction summary weighs against its route's window (`promptTokens`
    /// of `summarizeOnSharedPrefix`).
    pub fn settle_measured(&self, capture: &Capture, response: Option<ModelResponse>, prompt_tokens: u64) {
        let mut entry = lock(&capture.slot);
        entry.request.settled = response.is_some();
        entry.request.prompt_tokens = prompt_tokens;
        entry.reply = response;
        drop(entry);
        self.arm(capture);
    }

    fn arm(&self, capture: &Capture) {
        let Some(warm) = self.warm.get() else { return };
        let (provider_name, side, sent_at, reply) = {
            let entry = lock(&capture.slot);
            let Some(reply) = entry.reply.clone() else { return };
            (entry.request.provider_name.clone(), entry.side.clone(), entry.request.sent_at, reply)
        };
        warm.settled(&ThreadId::from(capture.thread.as_str()), &provider_name, &side, sent_at, &reply);
    }

    /// The saved material and reply, together with the slot a retry may invalidate.
    fn side_request(&self, thread: &ThreadId) -> Option<(Slot, SideMaterial, Option<ModelResponse>)> {
        self.current(thread).map(|slot| {
            let (material, reply) = {
                let entry = lock(&slot);
                (entry.side.clone(), entry.reply.clone())
            };
            (slot, material, reply)
        })
    }

    /// `handle.discard()`: the send failed, so the previous request is put back, if this capture's is
    /// still the session's.
    pub fn discard(&self, capture: Capture) {
        if !capture.kept {
            return;
        }
        let mut requests = self.requests();
        if requests.get(&capture.thread).is_none_or(|current| !Arc::ptr_eq(current, &capture.slot)) {
            return;
        }
        match capture.previous {
            Some(previous) => requests.insert(capture.thread, previous),
            None => requests.remove(&capture.thread),
        };
    }

    fn current(&self, thread: &ThreadId) -> Option<Slot> {
        self.requests().get(thread.as_str()).cloned()
    }

    /// `sideQuestionRequest(sessionId)`.
    pub fn saved_request(&self, thread: &ThreadId) -> Option<SavedRequest> {
        self.current(thread).map(|slot| lock(&slot).request.clone())
    }

    /// The sender of the session's saved request.
    pub fn fork_sender(&self, thread: &ThreadId) -> Arc<dyn ForkSender> {
        self.current(thread).map_or_else(|| Arc::new(NoSavedRequest) as Arc<dyn ForkSender>, |slot| lock(&slot).sender.clone())
    }

    /// Only the current entry is eligible. In particular, an unsettled entry must not make
    /// the summary silently fall back to an earlier turn's cached request.
    pub(crate) fn compaction_fork(self: &Arc<Self>, thread: &ThreadId) -> Option<(SavedRequest, Arc<dyn ForkSender>)> {
        let requests = self.requests();
        let slot = requests.get(thread.as_str())?;
        let entry = lock(slot);
        if !entry.request.settled || entry.request.compacted {
            return None;
        }
        let sender = CompactionFork { store: self.clone(), thread: thread.clone(), slot: slot.clone() };
        Some((entry.request.clone(), Arc::new(sender)))
    }

    /// `retireCompactionFork`: a compaction rewrote the transcript, so the saved request no longer
    /// holds the history a later compaction must summarize.
    pub fn retire_compaction_fork(&self, thread: &ThreadId) {
        if let Some(slot) = self.current(thread) {
            lock(&slot).request.compacted = true;
        }
        self.warm_end(thread, SideEnd::Transcript);
    }

    /// Releases a resting session's cached last request and response without ending its warm chain
    /// or firing `on_end`: a later side question rebuilds from committed history via [`NextMainRequest::next`].
    pub fn release_rested(&self, thread: &ThreadId) {
        self.requests().remove(thread.as_str());
    }

    /// `forgetSideQuestion(id, { cancel })` for `end`: the saved request goes, and the session's cache warm as [`SideEnd`] says.
    pub fn end(&self, thread: &ThreadId, end: SideEnd) {
        self.requests().remove(thread.as_str());
        self.warm_end(thread, end);
        if let Some(ended) = self.ended.get() {
            ended(thread, end);
        }
    }

    /// `hear` is told of every session end, once bound; the first binding stands.
    pub fn on_end(&self, hear: impl Fn(&ThreadId, SideEnd) + Send + Sync + 'static) {
        let _ = self.ended.set(Box::new(hear));
    }

    /// The one place the warm hears how a session's request ended: an unload keeps the chain and its touch; a detach ends
    /// the chain and keeps the touch for the restart re-arm; a rewrite, a route change and a tombstone end both.
    fn warm_end(&self, thread: &ThreadId, end: SideEnd) {
        let Some(warm) = self.warm.get() else { return };
        match end {
            SideEnd::Unload => {}
            SideEnd::Detach => warm.cancel(thread),
            SideEnd::Transcript | SideEnd::Route | SideEnd::Tombstone => warm.forget(thread),
        }
    }

    fn forget_if_current(&self, thread: &ThreadId, slot: &Slot) {
        let mut requests = self.requests();
        if requests.get(thread.as_str()).is_some_and(|current| Arc::ptr_eq(current, slot)) {
            requests.remove(thread.as_str());
        }
    }
}

#[async_trait]
pub trait NextMainRequest: Send + Sync {
    async fn next(&self, thread: &ThreadId) -> Option<SideMaterial>;
    /// Whether `thread` has a rebuildable request, answered without building one.
    async fn has_next(&self, thread: &ThreadId) -> bool;
    /// Compacts the idle session's committed history now, as `thread/compact/start` does.
    async fn compact(&self, _thread: &ThreadId) -> Result<(), String> {
        Err("this session cannot be compacted here".to_owned())
    }
    /// Why the thread's next turn sends no request of Mixdog's a question could fork, for a thread whose turns an
    /// agent outside the loop runs; `None` for every other thread.
    async fn outside_refusal(&self, _thread: &ThreadId) -> Option<String> {
        None
    }
}

/// What `/btw` answers on a session whose turns an agent outside the loop runs.
pub const SIDE_QUESTION_OUTSIDE_AGENT: &str = "/btw is not available on this model: an ACP agent keeps the conversation in its own session, and the protocol gives Mixdog no copy of it to ask a side question on without the question joining the conversation. Ask it as a message instead.";

pub(crate) struct ForkScope {
    name: String,
    provider: Arc<dyn ProviderAdapter>,
}

impl ForkScope {
    pub(crate) fn new(thread: &ThreadId, label: &str, provider: &Arc<dyn ProviderAdapter>) -> Self {
        Self { name: format!("{}#{label}:{}", thread.as_str(), uuid::Uuid::new_v4()), provider: provider.clone() }
    }

    pub(crate) fn apply(&self, request: &mut ModelRequest) {
        request.options.transport_scope = Some(self.name.clone());
    }
}

impl Drop for ForkScope {
    fn drop(&mut self) {
        self.provider.release_transport_scope(&self.name);
    }
}

/// The one cancel source of a thread's side question in flight, with the identity that lets its
/// own end leave a newer question's source alone.
type Runs = Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>;

struct RunEnd {
    runs: Runs,
    thread: String,
    id: u64,
}

impl Drop for RunEnd {
    fn drop(&mut self) {
        let mut runs = self.runs.lock().unwrap_or_else(PoisonError::into_inner);
        if runs.get(&self.thread).is_some_and(|(id, _)| *id == self.id) {
            runs.remove(&self.thread);
        }
    }
}

/// The session's `SideQuestions`: the loop's saved request (or the one its next turn would send),
/// the question in flight and the fork's single provider call.
pub struct SideQuestionService {
    store: Arc<SideQuestionStore>,
    next: Arc<dyn NextMainRequest>,
    runs: Runs,
    seq: AtomicU64,
}

impl SideQuestionService {
    pub fn new(store: Arc<SideQuestionStore>, next: Arc<dyn NextMainRequest>) -> Self {
        Self { store, next, runs: Runs::default(), seq: AtomicU64::new(0) }
    }

    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, (u64, CancellationToken)>> {
        self.runs.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl SideQuestions for SideQuestionService {
    async fn has_request(&self, thread: &ThreadId) -> bool {
        self.store.current(thread).is_some() || self.next.has_next(thread).await
    }

    async fn refusal(&self, thread: &ThreadId) -> Option<String> {
        self.next.outside_refusal(thread).await
    }

    fn begin(&self, thread: &ThreadId) -> SideRun {
        self.cancel(thread);
        let (id, cancel) = (self.seq.fetch_add(1, Ordering::Relaxed), CancellationToken::new());
        self.runs().insert(thread.as_str().to_owned(), (id, cancel.clone()));
        SideRun { cancel, end: Box::new(RunEnd { runs: self.runs.clone(), thread: thread.as_str().to_owned(), id }) }
    }

    fn cancel(&self, thread: &ThreadId) -> bool {
        let run = self.runs().remove(thread.as_str());
        run.map(|(_, cancel)| cancel.cancel()).is_some()
    }

    fn forget(&self, thread: &ThreadId, end: SideEnd) {
        self.store.end(thread, end);
        if matches!(end, SideEnd::Detach | SideEnd::Tombstone | SideEnd::Unload) {
            self.cancel(thread);
        }
    }

    async fn send(&self, thread: &ThreadId, prompt: &str, tool_stub: &str, idle: bool, cancel: &CancellationToken) -> Result<SideReply, SideFailure> {
        use mixdog_core_api::domain::cache_tail::TailRefusal;
        let (slot, mut material, mut reply) = match self.store.side_request(thread) {
            Some((slot, material, reply)) => (Some(slot), material, reply),
            None => match self.next.next(thread).await {
                Some(next) => (None, next, None),
                None => return Err(SideFailure::Failed(SIDE_QUESTION_NO_REQUEST.to_owned())),
            },
        };
        // The fork goes out once, or once more on the history a rewrite left: the compaction this question ran on the idle
        // session, the rewrite another caller owned, or a rewrite after the saved request was taken.
        let mut rebuilt = false;
        // The rebuilt request is the compacted base's first write: this question compacted the idle session itself, or the
        // idle session's history was compacted already and not sent since.
        let mut compacted = false;
        loop {
            use mixdog_core_api::domain::cache_tail::Purpose;
            let mut fork = forked_request_stubbed(&material.request, reply.as_ref(), prompt, tool_stub);
            // Admitted on its own route like any attempt (the gate rides the request it forks, loaded from the session's
            // header when the request was rebuilt); the side conversation never enters the session's history.
            fork.options.tail_purpose = if compacted { Purpose::SideAfterCompaction } else { Purpose::SideQuestion };
            let gate = fork.options.tail_gate.clone();
            let scope = ForkScope::new(thread, "side", &material.provider);
            scope.apply(&mut fork);
            // The send is accounted by the provider itself (the registry's accounted provider writes the
            // fork's usage row under the session), as the main loop's sends are.
            let refusal = match send_forked(&material.provider, fork, cancel).await {
                Ok(Some(response)) if !cancel.is_cancelled() => {
                    return Ok(SideReply { content: response.content, tool_call: !response.tool_calls.is_empty() });
                }
                Ok(_) => return Err(SideFailure::Aborted),
                Err(_) if cancel.is_cancelled() => return Err(SideFailure::Aborted),
                Err(mut error) => match error.tail_refusal.take() {
                    Some(refusal) => (refusal, error.into_message()),
                    None => return Err(SideFailure::Failed(error.into_message())),
                },
            };
            let decline = |message: &str| {
                Err(SideFailure::Failed(format!(
                    "Not asked: {message}, and a side question would resend the whole transcript. Ask it after the next turn, which compacts or rewrites the transcript first."
                )))
            };
            if rebuilt {
                return decline(&refusal.1);
            }
            match refusal.0 {
                TailRefusal::Wait(ticket) => match gate {
                    Some(gate) => {
                        tokio::select! {
                            () = gate.0.wait_for(ticket) => {}
                            () = cancel.cancelled() => return Err(SideFailure::Aborted),
                        }
                    }
                    None => return decline(&refusal.1),
                },
                // The history was rewritten after this request was prepared: the question goes on the committed one.
                TailRefusal::Stale => {}
                // No send on record: the history is a compacted base nobody wrote yet. An idle session's committed history
                // is that base, so the question is asked on it as it is; nothing has expired, and nothing is compacted.
                TailRefusal::Skip(mixdog_core_api::domain::cache_tail::Cold::Unproven) if idle => compacted = true,
                // Expired: an idle session is compacted now and asked on the rebuilt history; a busy one is declined.
                TailRefusal::Skip(_) | TailRefusal::Rebuild(_) if idle => {
                    if let Err(message) = self.next.compact(thread).await {
                        return decline(&message);
                    }
                    compacted = true;
                }
                TailRefusal::Skip(_) | TailRefusal::Rebuild(_) => return decline(&refusal.1),
                // The owner of the transcript on another host could not be reached: nothing was sent.
                TailRefusal::Unjudged => return Err(SideFailure::Failed(refusal.1)),
            }
            rebuilt = true;
            if let Some(slot) = &slot {
                self.store.forget_if_current(thread, slot);
            }
            material = match self.next.next(thread).await {
                Some(next) => next,
                None => return Err(SideFailure::Failed(SIDE_QUESTION_NO_REQUEST.to_owned())),
            };
            reply = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::summary_run::{RouteStep, SummaryCall, SummarySender};
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, Message, ModelStream, ProviderError, RequestOptions, Role, ToolCall, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_session::session::turn_ops::{SIDE_QUESTION_TOOL_STUB, ask_side_question};
    use mixdog_protocol::ProviderId;

    use super::*;

    #[test]
    fn a_bound_listener_hears_every_session_end() {
        let store = SideQuestionStore::new();
        let heard: Arc<Mutex<Vec<(String, SideEnd)>>> = Arc::default();
        let sink = heard.clone();
        store.on_end(move |thread, end| sink.lock().unwrap().push((thread.as_str().to_owned(), end)));
        store.end(&ThreadId::from("t"), SideEnd::Detach);
        assert_eq!(*heard.lock().unwrap(), [("t".to_owned(), SideEnd::Detach)]);
    }

    /// Records the requests it is sent, then answers from the mock script.
    struct Recording {
        inner: MockProvider,
        sent: Mutex<Vec<ModelRequest>>,
        released: Mutex<Vec<String>>,
    }
    impl Recording {
        fn new(script: impl IntoIterator<Item = MockAttempt>) -> Arc<Self> {
            Arc::new(Self { inner: MockProvider::new(script), sent: Mutex::default(), released: Mutex::default() })
        }
    }
    #[async_trait]
    impl ProviderAdapter for Recording {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.sent.lock().unwrap().push((*request).clone());
            self.inner.attempt(request).await
        }
        fn release_session(&self, session_id: &str) {
            self.released.lock().unwrap().push(session_id.to_owned());
        }
    }

    fn saved_model_request() -> ModelRequest {
        let options = RequestOptions { tool_choice: Some("auto".into()), ..RequestOptions::default() };
        ModelRequest { model: "mock-model".into(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: Vec::new(), options }
    }

    fn material(provider: Arc<dyn ProviderAdapter>) -> SideMaterial {
        SideMaterial { request: Arc::new(saved_model_request()), provider }
    }

    /// A material whose provider has nothing scripted, for tests that only keep requests.
    fn idle_material() -> SideMaterial {
        material(Recording::new([]))
    }

    struct NoNext;
    #[async_trait]
    impl NextMainRequest for NoNext {
        async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
            None
        }
        async fn has_next(&self, _: &ThreadId) -> bool {
            false
        }
    }
    struct Rebuilt(Arc<Recording>);
    #[async_trait]
    impl NextMainRequest for Rebuilt {
        async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
            Some(material(self.0.clone()))
        }
        async fn has_next(&self, _: &ThreadId) -> bool {
            true
        }
    }
    /// A provider whose first attempt the cache owner refuses as cold; later attempts reach `inner`.
    struct ColdOnce {
        cold: std::sync::atomic::AtomicBool,
        inner: Arc<Recording>,
    }
    #[async_trait]
    impl ProviderAdapter for ColdOnce {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            if self.cold.swap(false, Ordering::SeqCst) {
                return Err(ProviderError::tail_refused(mixdog_core_api::domain::cache_tail::TailRefusal::Skip(
                    mixdog_core_api::domain::cache_tail::Cold::Expired,
                )));
            }
            self.inner.attempt(request).await
        }
    }
    /// The next request on `provider`, and a compaction that is recorded.
    struct Compacts(Arc<ColdOnce>, AtomicU64);
    #[async_trait]
    impl NextMainRequest for Compacts {
        async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
            Some(material(self.0.clone()))
        }
        async fn has_next(&self, _: &ThreadId) -> bool {
            true
        }
        async fn compact(&self, _: &ThreadId) -> Result<(), String> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// A cold transcript: an idle session is compacted and then asked, on the rebuilt request; a busy one is declined
    /// with the reason and nothing is compacted or sent.
    #[tokio::test]
    async fn a_cold_side_question_compacts_an_idle_session_first_and_declines_on_a_busy_one() {
        let store = Arc::new(SideQuestionStore::new());
        let inner = Recording::new([MockAttempt::Body(b"t:answer\ndone\n".to_vec())]);
        let next = Arc::new(Compacts(Arc::new(ColdOnce { cold: true.into(), inner: inner.clone() }), AtomicU64::new(0)));
        let side = service(&store, next.clone());
        assert_eq!(ask_side_question(&side, &thread(), "x", true).await.unwrap(), "answer");
        assert_eq!((next.1.load(Ordering::SeqCst), inner.sent.lock().unwrap().len()), (1, 1), "compacted once, then asked once");

        let inner = Recording::new([]);
        let next = Arc::new(Compacts(Arc::new(ColdOnce { cold: true.into(), inner: inner.clone() }), AtomicU64::new(0)));
        let side = service(&store, next.clone());
        let declined = format!("{:?}", ask_side_question(&side, &thread(), "x", false).await.unwrap_err());
        assert!(declined.contains("Not asked: the transcript's prompt cache expired"), "{declined}");
        assert_eq!((next.1.load(Ordering::SeqCst), inner.sent.lock().unwrap().len()), (0, 0));
    }

    #[tokio::test]
    async fn a_side_question_retry_keeps_the_request_that_settled_while_it_waited() {
        use tokio::sync::oneshot;

        struct Rebuild {
            provider: Arc<Recording>,
            pause: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
        }
        #[async_trait]
        impl NextMainRequest for Rebuild {
            async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
                Some(material(self.provider.clone()))
            }

            async fn has_next(&self, _: &ThreadId) -> bool {
                true
            }

            async fn compact(&self, _: &ThreadId) -> Result<(), String> {
                let (started, done) = self.pause.lock().unwrap().take().unwrap();
                started.send(()).unwrap();
                done.await.unwrap();
                Ok(())
            }
        }

        let store = Arc::new(SideQuestionStore::new());
        let thread = thread();
        let cold = Arc::new(ColdOnce { cold: true.into(), inner: Recording::new([]) });
        let first = store.capture(&thread, request(1), Arc::new(Tagged("first")), material(cold), false);
        store.settle(&first, Some(ModelResponse::default()));
        let (started, waiting) = oneshot::channel();
        let (resume, done) = oneshot::channel();
        let rebuilt = Recording::new([MockAttempt::Body(b"t:answer from rebuilt history\ndone\n".to_vec())]);
        let side = service(&store, Arc::new(Rebuild { provider: rebuilt, pause: Mutex::new(Some((started, done))) }));

        let (answer, ()) = tokio::join!(ask_side_question(&side, &thread, "x", true), async {
            waiting.await.unwrap();
            let newer = store.capture(&thread, request(2), Arc::new(Tagged("newer")), idle_material(), false);
            store.settle(&newer, Some(ModelResponse::default()));
            resume.send(()).unwrap();
        });

        assert_eq!(answer.unwrap(), "answer from rebuilt history");
        let (saved, _) = store.compaction_fork(&thread).expect("the next fold can still fork the newer request");
        assert_eq!(saved.sent_at, 2);
    }

    fn service(store: &Arc<SideQuestionStore>, next: Arc<dyn NextMainRequest>) -> SideQuestionService {
        SideQuestionService::new(store.clone(), next)
    }

    /// `askSideQuestion` over a saved request: the fork is the saved messages, the settled reply
    /// with a side-question stub per tool call, then the prompt, on a transport scope of its own.
    #[tokio::test]
    async fn a_side_question_forks_the_saved_request() {
        let store = Arc::new(SideQuestionStore::new());
        let provider = Recording::new([MockAttempt::Body(b"t:  in parser.rs \nu:10,5\ndone\n".to_vec())]);
        let capture = store.capture(&thread(), request(1), Arc::new(Tagged("a")), material(provider.clone()), false);
        let reply = ModelResponse {
            tool_calls: vec![
                ToolCall { id: "c1".into(), name: "Read".into(), arguments: serde_json::json!({}), native_type: None },
                ToolCall { id: "c2".into(), name: "Grep".into(), arguments: serde_json::json!({}), native_type: None },
            ],
            ..ModelResponse::default()
        };
        store.settle(&capture, Some(reply));
        let side = service(&store, Arc::new(NoNext));

        let answer = ask_side_question(&side, &thread(), "  where?  ", true).await.unwrap();
        assert_eq!(answer, "in parser.rs");

        let sent = provider.sent.lock().unwrap();
        let fork = &sent[0];
        let roles: Vec<Role> = fork.messages.iter().map(|m| m.role).collect();
        assert_eq!(roles, [Role::User, Role::Assistant, Role::Tool, Role::Tool, Role::User]);
        assert_eq!((fork.messages[2].tool_call_id.as_deref(), fork.messages[3].tool_call_id.as_deref()), (Some("c1"), Some("c2")));
        assert!(format!("{:?}", fork.messages[2]).contains(SIDE_QUESTION_TOOL_STUB));
        assert!(format!("{:?}", fork.messages[4]).contains("where?\\n</side-question>"));
        assert!(fork.options.transport_scope.as_deref().is_some_and(|scope| scope.starts_with("sess_a#side:")));
        assert_eq!(fork.options.shared_cache_prefix_count, Some(1));
        assert_eq!(fork.options.tool_choice, None, "a forced choice does not carry over");
    }

    /// Each fork runs in a scope of its own, released once it ends: two answered forks and a cancelled one
    /// share no scope, and every scope they sent under is released.
    #[tokio::test]
    async fn every_fork_has_its_own_transport_scope_released_when_it_ends() {
        let store = Arc::new(SideQuestionStore::new());
        let provider = Recording::new([MockAttempt::Body(b"t:one\ndone\n".to_vec()), MockAttempt::Body(b"t:two\ndone\n".to_vec())]);
        store.capture(&thread(), request(1), Arc::new(Tagged("a")), material(provider.clone()), false);
        let side = service(&store, Arc::new(NoNext));
        assert_eq!(ask_side_question(&side, &thread(), "first", true).await.unwrap(), "one");
        assert_eq!(ask_side_question(&side, &thread(), "second", true).await.unwrap(), "two");
        let run = side.begin(&thread());
        run.cancel.cancel();
        assert!(matches!(side.send(&thread(), "q", "stub", true, &run.cancel).await, Err(SideFailure::Aborted)));

        let sent = provider.sent.lock().unwrap();
        let scopes: Vec<String> = sent.iter().map(|r| r.options.transport_scope.clone().unwrap()).collect();
        assert_eq!(scopes.len(), 2, "the cancelled fork never reached the provider");
        assert!(scopes[0] != scopes[1] && scopes.iter().all(|s| s.starts_with("sess_a#side:")), "{scopes:?}");
        let released = provider.released.lock().unwrap();
        assert_eq!(released.len(), 3, "the cancelled fork's scope is released too");
        assert_eq!(released[..2], scopes[..]);
    }

    /// A session with no saved request forks the request its next turn would send; with neither it
    /// has none.
    #[tokio::test]
    async fn a_session_without_a_saved_request_forks_its_next_main_request() {
        let store = Arc::new(SideQuestionStore::new());
        let none = service(&store, Arc::new(NoNext));
        assert!(!none.has_request(&thread()).await);
        let err = ask_side_question(&none, &thread(), "x", true).await.unwrap_err();
        assert!(format!("{err:?}").contains("Send a message first, then try /btw."));

        let provider = Recording::new([MockAttempt::Body(b"t:answer\ndone\n".to_vec())]);
        let rebuilt = service(&store, Arc::new(Rebuilt(provider.clone())));
        assert!(rebuilt.has_request(&thread()).await);
        assert_eq!(ask_side_question(&rebuilt, &thread(), "x", true).await.unwrap(), "answer");
        assert_eq!(provider.sent.lock().unwrap()[0].messages.len(), 2, "the transcript, then the prompt: no reply to append");
        assert!(store.saved_request(&thread()).is_none(), "a rebuilt request is not kept");
    }

    /// The next turn of a session on an agent outside the loop sends no request of Mixdog's.
    struct OutsideAgent(Arc<Recording>);
    #[async_trait]
    impl NextMainRequest for OutsideAgent {
        async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
            Some(material(self.0.clone()))
        }
        async fn has_next(&self, _: &ThreadId) -> bool {
            true
        }
        async fn outside_refusal(&self, _: &ThreadId) -> Option<String> {
            Some(SIDE_QUESTION_OUTSIDE_AGENT.to_owned())
        }
    }

    /// A session whose turns an agent outside the loop runs refuses a side question in so many words, and asks
    /// nothing of any provider: not "send a message first", which no message would cure.
    #[tokio::test]
    async fn a_session_on_an_outside_agent_refuses_a_side_question_with_its_reason() {
        let provider = Recording::new([MockAttempt::Body(b"t:answer\ndone\n".to_vec())]);
        let side = service(&Arc::new(SideQuestionStore::new()), Arc::new(OutsideAgent(provider.clone())));
        let refused = ask_side_question(&side, &thread(), "x", true).await.unwrap_err();
        assert!(format!("{refused:?}").contains(SIDE_QUESTION_OUTSIDE_AGENT), "{refused:?}");
        assert!(provider.sent.lock().unwrap().is_empty());
    }

    /// One cancel source per thread: a new begin cancels the old, a cancel reports whether a run was
    /// in flight, and an ended run leaves nothing to cancel.
    #[test]
    fn one_side_question_runs_per_thread_and_cancel_reports_it() {
        let side = service(&Arc::new(SideQuestionStore::new()), Arc::new(NoNext));
        assert!(!side.cancel(&thread()));
        let first = side.begin(&thread());
        let second = side.begin(&thread());
        assert!(first.cancel.is_cancelled() && !second.cancel.is_cancelled());
        drop(first);
        assert!(side.cancel(&thread()) && second.cancel.is_cancelled(), "the old run's end left the newer source");
        assert!(!side.cancel(&thread()));
        drop(side.begin(&thread()));
        assert!(!side.cancel(&thread()), "an ended run is not in flight");
        assert!(!side.begin(&ThreadId::from("sess_b".to_owned())).cancel.is_cancelled());
    }

    #[tokio::test]
    async fn a_cancelled_question_rejects_with_nodes_canceled_text() {
        let store = Arc::new(SideQuestionStore::new());
        store.capture(&thread(), request(1), Arc::new(Tagged("a")), material(Recording::new([])), false);
        let side = service(&store, Arc::new(NoNext));
        let run = side.begin(&thread());
        run.cancel.cancel();
        let sent = side.send(&thread(), "q", "stub", true, &run.cancel).await;
        assert!(matches!(sent, Err(SideFailure::Aborted)));
    }
    struct Tagged(&'static str);
    #[async_trait]
    impl ForkSender for Tagged {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            Err(SummaryFailure::Failed(self.0.to_owned()))
        }
    }

    fn request(sent_at: u64) -> SavedRequest {
        SavedRequest {
            provider_name: "anthropic".into(),
            model: "m".into(),
            cache_strategy: Some(serde_json::json!({ "messages": "5m" })),
            catalog_supports_prompt_caching: true,
            sent_at,
            settled: true,
            compacted: true,
            prompt_tokens: 10,
            shared_prefix_messages: 2,
        }
    }

    fn thread() -> ThreadId {
        ThreadId::from("sess_a".to_owned())
    }

    struct Quiet;
    #[async_trait]
    impl SummarySender for Quiet {
        async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!("the fork sender is the one under test")
        }
    }

    async fn tag(store: &SideQuestionStore) -> String {
        let route = SummaryRoute {
            step: RouteStep::Session,
            provider_name: String::new(),
            model: String::new(),
            context_window: 0,
            calibration: 1.0,
            fast: false,
            effort: None,
            sender: Arc::new(Quiet),
        };
        match store.fork_sender(&thread()).send(&route).await {
            Err(SummaryFailure::Failed(tag)) => tag,
            _ => unreachable!(),
        }
    }

    /// `side-question-store.mjs` run in Node on these steps: a request is the session's once sent,
    /// forkable once its reply settles, and a failed send puts the previous one back.
    #[tokio::test]
    async fn a_request_is_kept_unsettled_settles_and_a_failed_send_restores_the_previous() {
        let store = SideQuestionStore::new();
        assert_eq!(store.saved_request(&thread()), None);
        assert_eq!(tag(&store).await, "no saved request to fork");

        let first = store.capture(&thread(), request(1), Arc::new(Tagged("first")), idle_material(), false);
        let kept = store.saved_request(&thread()).unwrap();
        assert!(!kept.settled && !kept.compacted, "a capture starts unsettled and uncompacted");
        store.settle(&first, Some(ModelResponse::default()));
        assert!(store.saved_request(&thread()).unwrap().settled);

        let second = store.capture(&thread(), request(2), Arc::new(Tagged("second")), idle_material(), false);
        assert_eq!(store.saved_request(&thread()).unwrap().sent_at, 2);
        assert_eq!(tag(&store).await, "second");
        store.discard(second);
        assert_eq!(store.saved_request(&thread()).unwrap().sent_at, 1);
        assert!(store.saved_request(&thread()).unwrap().settled, "the restored request is the settled one");
        assert_eq!(tag(&store).await, "first");

        let lone = SideQuestionStore::new();
        let only = lone.capture(&thread(), request(3), Arc::new(Tagged("only")), idle_material(), false);
        lone.discard(only);
        assert_eq!(lone.saved_request(&thread()), None);
    }

    #[tokio::test]
    async fn a_settle_without_an_answer_keeps_the_request_unforkable() {
        let store = SideQuestionStore::new();
        let sent = store.capture(&thread(), request(1), Arc::new(Tagged("a")), idle_material(), false);
        store.settle(&sent, None);
        assert!(!store.saved_request(&thread()).unwrap().settled);
    }

    #[tokio::test]
    async fn a_discard_of_a_superseded_capture_leaves_the_newer_request() {
        let store = SideQuestionStore::new();
        let old = store.capture(&thread(), request(1), Arc::new(Tagged("old")), idle_material(), false);
        store.capture(&thread(), request(2), Arc::new(Tagged("new")), idle_material(), false);
        store.discard(old);
        assert_eq!(store.saved_request(&thread()).unwrap().sent_at, 2);
    }

    /// `side-question-store.mjs` run in Node on capture A, capture B, settle A, discard B: the settle
    /// reaches A though B displaced it, and the discard puts A back with its response.
    #[tokio::test]
    async fn a_settle_of_a_displaced_capture_reaches_it_and_a_discard_restores_it_settled() {
        let store = SideQuestionStore::new();
        let first = store.capture(&thread(), request(1), Arc::new(Tagged("a")), idle_material(), false);
        let second = store.capture(&thread(), request(2), Arc::new(Tagged("b")), idle_material(), false);
        store.settle(&first, Some(ModelResponse::default()));
        let current = store.saved_request(&thread()).unwrap();
        assert!(current.sent_at == 2 && !current.settled, "the displaced settle leaves the current request alone");
        store.discard(second);
        let restored = store.saved_request(&thread()).unwrap();
        assert_eq!((restored.sent_at, restored.settled), (1, true), "A comes back forkable");
        assert_eq!(tag(&store).await, "a");
    }

    #[test]
    fn an_agent_session_keeps_nothing_and_a_compaction_or_clear_retires_the_fork() {
        let store = SideQuestionStore::new();
        let agent = store.capture(&thread(), request(1), Arc::new(Tagged("a")), idle_material(), true);
        assert_eq!(store.saved_request(&thread()), None);
        store.settle(&agent, Some(ModelResponse::default()));
        store.discard(agent);
        assert_eq!(store.saved_request(&thread()), None);

        let lead = store.capture(&thread(), request(2), Arc::new(Tagged("l")), idle_material(), false);
        store.settle(&lead, Some(ModelResponse::default()));
        store.retire_compaction_fork(&thread());
        let retired = store.saved_request(&thread()).unwrap();
        assert!(retired.settled && retired.compacted, "settled, but a compaction rewrote the transcript since");
        store.end(&thread(), SideEnd::Transcript);
        assert_eq!(store.saved_request(&thread()), None);
    }

    #[tokio::test]
    async fn a_resting_session_releases_its_cached_request_and_rebuilds_from_history() {
        struct RecordWarm {
            forgotten: Mutex<Vec<String>>,
            cancelled: Mutex<Vec<String>>,
        }
        impl SendWarmth for RecordWarm {
            fn sending(&self, _: &ThreadId, _: &str, _: &SideMaterial, _: u64) {}
            fn settled(&self, _: &ThreadId, _: &str, _: &SideMaterial, _: u64, _: &ModelResponse) {}
            fn forget(&self, thread: &ThreadId) {
                self.forgotten.lock().unwrap().push(thread.as_str().to_owned());
            }
            fn cancel(&self, thread: &ThreadId) {
                self.cancelled.lock().unwrap().push(thread.as_str().to_owned());
            }
        }
        struct CountedRebuild(Arc<Recording>, AtomicU64);
        #[async_trait]
        impl NextMainRequest for CountedRebuild {
            async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
                self.1.fetch_add(1, Ordering::SeqCst);
                Some(material(self.0.clone()))
            }
            async fn has_next(&self, _: &ThreadId) -> bool {
                true
            }
        }

        let store = Arc::new(SideQuestionStore::new());
        let warm = Arc::new(RecordWarm { forgotten: Mutex::default(), cancelled: Mutex::default() });
        store.bind_warm(warm.clone());
        let ended: Arc<Mutex<Vec<(String, SideEnd)>>> = Arc::default();
        let sink = ended.clone();
        store.on_end(move |t, end| sink.lock().unwrap().push((t.as_str().to_owned(), end)));

        let t1 = ThreadId::from("t1");
        let t2 = ThreadId::from("t2");
        let c1 = store.capture(&t1, request(1), Arc::new(Tagged("one")), idle_material(), false);
        store.settle(&c1, Some(ModelResponse::default()));
        let c2 = store.capture(&t2, request(2), Arc::new(Tagged("two")), idle_material(), false);
        store.settle(&c2, Some(ModelResponse::default()));

        store.release_rested(&t1);
        assert_eq!(store.saved_request(&t1), None, "resting drops the cached request and response");
        assert!(store.saved_request(&t2).is_some(), "other sessions stay cached");
        assert!(warm.forgotten.lock().unwrap().is_empty() && warm.cancelled.lock().unwrap().is_empty(), "resting keeps the warm chain");
        assert!(ended.lock().unwrap().is_empty(), "resting does not fire on_end");

        let provider = Recording::new([MockAttempt::Body(b"t:rebuilt\ndone\n".to_vec())]);
        let next = Arc::new(CountedRebuild(provider, AtomicU64::new(0)));
        let side = service(&store, next.clone());
        assert_eq!(ask_side_question(&side, &t1, "q", true).await.unwrap(), "rebuilt");
        assert_eq!(next.1.load(Ordering::SeqCst), 1, "rebuilt from committed history");
    }

    #[tokio::test]
    async fn has_request_checks_without_building_or_retaining_a_request() {
        struct SwitchingRebuild {
            provider: Mutex<Arc<Recording>>,
            builds: AtomicU64,
        }
        #[async_trait]
        impl NextMainRequest for SwitchingRebuild {
            async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
                self.builds.fetch_add(1, Ordering::SeqCst);
                Some(material(self.provider.lock().unwrap().clone()))
            }
            async fn has_next(&self, _: &ThreadId) -> bool {
                true
            }
        }

        let store = Arc::new(SideQuestionStore::new());
        let first = Recording::new([MockAttempt::Body(b"t:stale\ndone\n".to_vec())]);
        let updated = Recording::new([MockAttempt::Body(b"t:fresh\ndone\n".to_vec())]);
        let next = Arc::new(SwitchingRebuild { provider: Mutex::new(first), builds: AtomicU64::new(0) });
        let side = service(&store, next.clone());

        assert!(side.has_request(&thread()).await);
        assert_eq!(next.builds.load(Ordering::SeqCst), 0, "has_request builds nothing");

        *next.provider.lock().unwrap() = updated;
        assert_eq!(ask_side_question(&side, &thread(), "q", true).await.unwrap(), "fresh");
        assert_eq!(next.builds.load(Ordering::SeqCst), 1, "send builds freshly from current history");
    }
}
