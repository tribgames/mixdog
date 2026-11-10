//! The latest provider request each session's main loop sent (Node `side-question-store.mjs`): the
//! request a compaction summary forks, kept in memory only because the sender it holds is live.
//!
//! The loop's send path records into it: [`SideQuestionStore::capture`] when it sends,
//! [`SideQuestionStore::settle`] when the reply settles and [`SideQuestionStore::discard`] when the
//! send fails; a compaction that rewrites the transcript calls
//! [`SideQuestionStore::retire_compaction_fork`], a clear or rewind [`SideQuestionStore::forget`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute};
use mixdog_agent::fork::{forked_request_stubbed, send_forked};
use mixdog_agent::response::ModelResponse;
use mixdog_core_api::domain::provider::{ModelRequest, ProviderAdapter};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::turn_ops::{SideFailure, SideQuestions, SideReply, SideRun, SIDE_QUESTION_NO_REQUEST};
use mixdog_rt::CancellationToken;

use super::summary_routes::{ForkSender, SavedRequest};

/// A request a side question forks (`sideQuestionRequestSnapshot`): the request as the loop sent it
/// and the provider that sent it.
#[derive(Clone)]
pub struct SideMaterial {
    pub request: ModelRequest,
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

#[derive(Default)]
pub struct SideQuestionStore {
    requests: Mutex<HashMap<String, Slot>>,
}

/// The fork of a session with no saved request. A compaction only sends it for a request that
/// `SessionFork` found forkable, so reaching it is a bug of the caller.
struct NoSavedRequest;

#[async_trait]
impl ForkSender for NoSavedRequest {
    async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        Err(SummaryFailure::Failed("no saved request to fork".to_owned()))
    }
}

impl SideQuestionStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `captureSideQuestionRequest`: records the request the loop is sending as the session's
    /// latest. An agent-owned session keeps nothing (`/btw` is a Lead command). The request starts
    /// unsettled and uncompacted.
    pub fn capture(&self, thread: &ThreadId, request: SavedRequest, sender: Arc<dyn ForkSender>, side: SideMaterial, agent_owner: bool) -> Capture {
        let kept = !agent_owner;
        let request = SavedRequest { settled: false, compacted: false, ..request };
        let slot: Slot = Arc::new(Mutex::new(Entry { request, sender, side, reply: None }));
        let previous = if kept { self.requests().insert(thread.as_str().to_owned(), slot.clone()) } else { None };
        Capture { thread: thread.as_str().to_owned(), slot, kept, previous }
    }

    /// `handle.settle(response)`: the reply settled with an answer (`response` truthy). It sets the
    /// captured request itself, wherever it now is.
    pub fn settle(&self, capture: &Capture, response: Option<ModelResponse>) {
        let mut entry = lock(&capture.slot);
        entry.request.settled = response.is_some();
        entry.reply = response;
    }

    /// [`SideQuestionStore::settle`] that also records the tokens of the forked messages plus the
    /// tool-schema reserve a compaction summary weighs against its route's window (`promptTokens`
    /// of `summarizeOnSharedPrefix`).
    pub fn settle_measured(&self, capture: &Capture, response: Option<ModelResponse>, prompt_tokens: u64) {
        let mut entry = lock(&capture.slot);
        entry.request.settled = response.is_some();
        entry.request.prompt_tokens = prompt_tokens;
        entry.reply = response;
    }

    /// The session's saved request as a side question forks it, with the reply it settled on.
    pub fn side_request(&self, thread: &ThreadId) -> Option<(SideMaterial, Option<ModelResponse>)> {
        self.current(thread).map(|slot| {
            let entry = lock(&slot);
            (entry.side.clone(), entry.reply.clone())
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

    /// `retireCompactionFork`: a compaction rewrote the transcript, so the saved request no longer
    /// holds the history a later compaction must summarize.
    pub fn retire_compaction_fork(&self, thread: &ThreadId) {
        if let Some(slot) = self.current(thread) {
            lock(&slot).request.compacted = true;
        }
    }

    /// `forgetSideQuestion`: the transcript the request carried is gone (clear, rewind, close).
    pub fn forget(&self, thread: &ThreadId) {
        self.requests().remove(thread.as_str());
    }
}

/// `nextMainRequest`: the request the session's next turn would send, for a session with none
/// saved (a restart, or the saved one forgotten): the session's own provider, model, tools, send
/// options and transcript assembled by the loop's own pieces without its side effects. `None` when
/// the session has no conversation, no resolvable provider, is closed, or is an agent's.
#[async_trait]
pub trait NextMainRequest: Send + Sync {
    async fn next(&self, thread: &ThreadId) -> Option<SideMaterial>;
}

/// A transport scope of one fork's own (`forkTransportScope(sessionId, label)`: `<session>#<label>:<uuid>`):
/// the fork keeps the session id for prompt-cache routing, but no pooled socket, response-chain anchor or
/// turn state of the session, or of another fork, is read or replaced. Dropping the scope releases the
/// provider's connections and state under it (`disposeTransportScope`), whether the fork was answered,
/// failed or cancelled.
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
        self.store.current(thread).is_some() || self.next.next(thread).await.is_some()
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

    fn forget(&self, thread: &ThreadId, cancel: bool) {
        self.store.forget(thread);
        if cancel {
            self.cancel(thread);
        }
    }

    async fn send(&self, thread: &ThreadId, prompt: &str, tool_stub: &str, cancel: &CancellationToken) -> Result<SideReply, SideFailure> {
        let (material, reply) = match self.store.side_request(thread) {
            Some(saved) => saved,
            None => match self.next.next(thread).await {
                Some(next) => (next, None),
                None => return Err(SideFailure::Failed(SIDE_QUESTION_NO_REQUEST.to_owned())),
            },
        };
        let mut fork = forked_request_stubbed(&material.request, reply.as_ref(), prompt, tool_stub);
        let scope = ForkScope::new(thread, "side", &material.provider);
        scope.apply(&mut fork);
        // The send is accounted by the provider itself (the registry's accounted provider writes the
        // fork's usage row under the session), as the main loop's sends are.
        match send_forked(&material.provider, fork, cancel).await {
            Ok(Some(response)) if !cancel.is_cancelled() => {
                Ok(SideReply { content: response.content, tool_call: !response.tool_calls.is_empty() })
            }
            Ok(_) => Err(SideFailure::Aborted),
            Err(_) if cancel.is_cancelled() => Err(SideFailure::Aborted),
            Err(error) => Err(SideFailure::Failed(error.message)),
        }
    }
}

/// A material on a provider that is never asked, for tests that only keep requests.
#[cfg(test)]
pub(crate) fn tests_material() -> SideMaterial {
    tests::material(Arc::new(mixdog_core_api::domain::mock::MockProvider::new([])))
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::summary_run::{RouteStep, SummaryCall, SummarySender};
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, Message, ModelStream, ProviderError, RequestOptions, Role, ToolCall, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_session::session::turn_ops::{ask_side_question, SIDE_QUESTION_TOOL_STUB};
    use mixdog_protocol::ProviderId;

    use super::*;

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

    pub(super) fn material(provider: Arc<dyn ProviderAdapter>) -> SideMaterial {
        SideMaterial { request: saved_model_request(), provider }
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
    }
    struct Rebuilt(Arc<Recording>);
    #[async_trait]
    impl NextMainRequest for Rebuilt {
        async fn next(&self, _: &ThreadId) -> Option<SideMaterial> {
            Some(material(self.0.clone()))
        }
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

        let answer = ask_side_question(&side, &thread(), "  where?  ").await.unwrap();
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
        assert_eq!(ask_side_question(&side, &thread(), "first").await.unwrap(), "one");
        assert_eq!(ask_side_question(&side, &thread(), "second").await.unwrap(), "two");
        let run = side.begin(&thread());
        run.cancel.cancel();
        assert!(matches!(side.send(&thread(), "q", "stub", &run.cancel).await, Err(SideFailure::Aborted)));

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
        let err = ask_side_question(&none, &thread(), "x").await.unwrap_err();
        assert!(format!("{err:?}").contains("Send a message first, then try /btw."));

        let provider = Recording::new([MockAttempt::Body(b"t:answer\ndone\n".to_vec())]);
        let rebuilt = service(&store, Arc::new(Rebuilt(provider.clone())));
        assert!(rebuilt.has_request(&thread()).await);
        assert_eq!(ask_side_question(&rebuilt, &thread(), "x").await.unwrap(), "answer");
        assert_eq!(provider.sent.lock().unwrap()[0].messages.len(), 2, "the transcript, then the prompt: no reply to append");
        assert!(store.saved_request(&thread()).is_none(), "a rebuilt request is not kept");
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
        let sent = side.send(&thread(), "q", "stub", &run.cancel).await;
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
            messages_tier: Some("5m".into()),
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
        store.forget(&thread());
        assert_eq!(store.saved_request(&thread()), None);
    }
}
