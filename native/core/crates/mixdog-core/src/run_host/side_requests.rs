//! The loop's send path into the side-question store (Node `captureSideQuestionRequest`): each logical send
//! records the request it is sending as the session's latest, keeps it once the reply proceeds and puts
//! the previous one back when the send fails. A compaction summary forks it through [`ForkSender`]; a `/btw`
//! side question forks the request the store keeps.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::summary::forked_compaction_prompt;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute};
use mixdog_agent::env::{Clock, SendTap, SendTicket};
use mixdog_agent::fork::{forked_request, prompt_tokens, send_forked};
use mixdog_agent::response::ModelResponse;
use mixdog_agent::without_tail_reminder;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::provider::{ModelRequest, ProviderAdapter, Usage};
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use mixdog_rt::CancellationToken;

use super::media::{AttachmentFacts, MediaLowering};
use super::side_question_store::{Capture, ForkScope, SideMaterial, SideQuestionStore};
use super::summary_routes::{ForkSender, SavedRequest};

/// `getCachedModelInfo(model) ?? getModelMetadataSync(model, provider)` marks prompt caching.
pub type CatalogCaching = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// The process's one side-question store and what a capture reads besides the request.
#[derive(Clone)]
pub struct SideRequests {
    pub store: Arc<SideQuestionStore>,
    pub caching: CatalogCaching,
    pub docs: Arc<dyn DocumentText>,
    pub reader: Arc<dyn AttachmentReader>,
    pub facts: Arc<dyn AttachmentFacts>,
    pub clock: Arc<dyn Clock>,
}

/// The run a tap serves.
pub struct RunSide {
    pub thread: ThreadId,
    pub provider_name: String,
    pub provider: Arc<dyn ProviderAdapter>,
    /// `isAgentOwner(session)`: an agent session keeps nothing (`/btw` is a Lead command).
    pub agent_owner: bool,
}

impl SideRequests {
    pub fn tap(&self, run: RunSide) -> Arc<dyn SendTap> {
        Arc::new(RunTap { side: self.clone(), run })
    }
}

struct RunTap {
    side: SideRequests,
    run: RunSide,
}

/// `cacheStrategy.messages` of the request's model parameters.
fn messages_tier(request: &ModelRequest) -> Option<String> {
    request.options.model_parameters.as_ref()?.get("cacheStrategy")?.get("messages")?.as_str().map(str::to_owned)
}

impl SendTap for RunTap {
    fn begin(&self, request: &ModelRequest) -> Box<dyn SendTicket> {
        // The store keeps the request without its tail reminder (Node captures the messages before
        // `sendWithRecovery` adds it): a fork or a warm adds the reminder of its own moment, and the
        // shared prefix counts the messages the reminder is not part of.
        let request = &without_tail_reminder(request);
        let side = &self.side;
        let reply = Arc::new(Mutex::new(None));
        let sender = Arc::new(RequestFork {
            thread: self.run.thread.clone(),
            provider: self.run.provider.clone(),
            request: request.clone(),
            reply: reply.clone(),
        });
        let saved = SavedRequest {
            provider_name: self.run.provider_name.clone(),
            model: request.model.clone(),
            messages_tier: messages_tier(request),
            catalog_supports_prompt_caching: (side.caching)(&self.run.provider_name, &request.model),
            sent_at: side.clock.now_ms().max(0) as u64,
            settled: false,
            compacted: false,
            prompt_tokens: 0,
            shared_prefix_messages: request.messages.len(),
        };
        let material = SideMaterial { request: request.clone(), provider: self.run.provider.clone() };
        let capture = side.store.capture(&self.run.thread, saved, sender.clone(), material, self.run.agent_owner);
        Box::new(Sent { side: side.clone(), run_thread: self.run.thread.clone(), provider_name: self.run.provider_name.clone(), capture, fork: sender, reply })
    }
}

struct Sent {
    side: SideRequests,
    run_thread: ThreadId,
    provider_name: String,
    capture: Capture,
    fork: Arc<RequestFork>,
    reply: Arc<Mutex<Option<ModelResponse>>>,
}

impl SendTicket for Sent {
    fn settle(self: Box<Self>, response: &ModelResponse) {
        *self.reply.lock().unwrap_or_else(PoisonError::into_inner) = Some(response.clone());
        // What a summary fork weighs against the window: the saved messages, the reply and the prompt.
        let media = MediaLowering::new(
            self.run_thread.clone(),
            self.side.docs.clone(),
            self.side.reader.clone(),
            self.side.facts.clone(),
            false,
            ProviderId::from(self.provider_name.as_str()),
        );
        let owner = ProviderId::from(self.provider_name.as_str());
        let meter = MessageMeter { media: &media, replay_owner: &owner };
        let tokens = prompt_tokens(&forked_request(&self.fork.request, Some(response), &forked_compaction_prompt()), &meter);
        self.side.store.settle_measured(&self.capture, Some(response.clone()), tokens);
    }

    fn discard(self: Box<Self>) {
        self.side.store.discard(self.capture);
    }
}

/// Sends forks of the saved request: a compaction's on the summary route, a side question's with its own
/// transport scope.
pub(crate) struct RequestFork {
    pub(crate) thread: ThreadId,
    pub(crate) provider: Arc<dyn ProviderAdapter>,
    pub(crate) request: ModelRequest,
    /// The reply the saved request produced; `None` until its send settles.
    pub(crate) reply: Arc<Mutex<Option<ModelResponse>>>,
}

#[async_trait]
impl ForkSender for RequestFork {
    async fn send(&self, _route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        self.send_fork().await
    }
}

impl RequestFork {
    /// The compaction's fork of the saved request, sent on its provider.
    pub(crate) async fn send_fork(&self) -> Result<SummaryResponse, SummaryFailure> {
        let reply = self.reply.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let mut fork = forked_request(&self.request, reply.as_ref(), &forked_compaction_prompt());
        // The ledger source, and a transport scope of its own: no pooled socket or response chain of the
        // main session is touched (`forkTransportScope(sessionId, 'compact')`).
        fork.options.request_kind = Some("compaction".to_owned());
        let scope = ForkScope::new(&self.thread, "compact", &self.provider);
        scope.apply(&mut fork);
        match send_forked(&self.provider, fork, &CancellationToken::new()).await {
            Ok(Some(response)) => {
                let reported = response.usage != Usage::default();
                Ok(SummaryResponse { text: response.content, tool_call: !response.tool_calls.is_empty(), usage: reported.then_some(response.usage) })
            }
            Ok(None) => Err(SummaryFailure::Aborted),
            Err(error) => Err(SummaryFailure::Failed(error.message)),
        }
    }
}


#[cfg(test)]
mod tests {
    use mixdog_agent::compact::summary_run::{RouteStep, SummaryCall, SummarySender};
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, Message, RequestOptions, Role};
    use serde_json::json;

    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            42
        }
    }

    struct Quiet;
    #[async_trait]
    impl SummarySender for Quiet {
        async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!("the fork sends on its own request")
        }
    }

    fn request(text: &str) -> ModelRequest {
        ModelRequest {
            model: "mock-model".into(),
            messages: vec![Message::new(Role::User, Content::Text(text.into()))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        }
    }

    /// The loop sends the request with its tail reminder (`wire_request`); the store keeps the
    /// messages before it (Node `captureSideQuestionRequest`), so the saved prefix counts them only.
    #[tokio::test]
    async fn the_saved_request_is_kept_without_the_tail_reminder() {
        let dir = tempfile::tempdir().unwrap();
        let side = side(dir.path()).await;
        let provider = Arc::new(MockProvider::new([]));
        let tap = side.tap(run(provider, false));
        let sent = mixdog_agent::wire_request("mock-model", RequestOptions::default(), request("hi").messages, Some("remember"), Vec::new());
        assert_eq!(sent.messages.len(), 2);
        tap.begin(&sent).settle(&reply("ok"));
        let saved = side.store.saved_request(&ThreadId::from("t")).unwrap();
        assert_eq!(saved.shared_prefix_messages, 1, "the reminder is not part of the shared prefix");
    }

    fn reply(content: &str) -> ModelResponse {
        ModelResponse { content: content.into(), ..ModelResponse::default() }
    }

    async fn side(dir: &std::path::Path) -> SideRequests {
        let compaction = super::super::compaction_world::tests::services(dir, json!({}), Arc::default()).await;
        SideRequests {
            store: Arc::new(SideQuestionStore::new()),
            caching: Arc::new(|provider, _| provider == "mock"),
            docs: compaction.docs.clone(),
            reader: compaction.reader.clone(),
            facts: compaction.attachment_facts.clone(),
            clock: Arc::new(Fixed),
        }
    }

    fn run(provider: Arc<MockProvider>, agent_owner: bool) -> RunSide {
        RunSide { thread: ThreadId::from("t"), provider_name: "mock".into(), provider, agent_owner }
    }

    #[tokio::test]
    async fn a_settled_send_is_saved_with_its_facts_and_forks_through_the_provider() {
        let dir = tempfile::tempdir().unwrap();
        let side = side(dir.path()).await;
        let provider = Arc::new(MockProvider::new([MockAttempt::Body(b"t:the summary\ndone\n".to_vec())]));
        let tap = side.tap(run(provider.clone(), false));
        let ticket = tap.begin(&request("hi"));
        let thread = ThreadId::from("t");
        let pending = side.store.saved_request(&thread).unwrap();
        assert!(!pending.settled && pending.catalog_supports_prompt_caching && pending.sent_at == 42 && pending.shared_prefix_messages == 1);
        ticket.settle(&reply("ok"));
        let saved = side.store.saved_request(&thread).unwrap();
        assert!(saved.settled);
        assert!(saved.prompt_tokens > 0);
        let route = SummaryRoute {
            step: RouteStep::Session,
            provider_name: "mock".into(),
            model: "mock-model".into(),
            context_window: 100_000,
            calibration: 1.0,
            fast: false,
            effort: None,
            sender: Arc::new(Quiet),
        };
        let response = side.store.fork_sender(&thread).send(&route).await.unwrap();
        assert_eq!(response.text, "the summary");
        assert!(!response.tool_call);
    }

    #[tokio::test]
    async fn a_discarded_send_puts_the_previous_request_back_and_an_agent_session_keeps_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let side = side(dir.path()).await;
        let provider = Arc::new(MockProvider::new([]));
        let tap = side.tap(run(provider.clone(), false));
        tap.begin(&request("one")).settle(&reply("ok"));
        tap.begin(&request("two")).discard();
        let thread = ThreadId::from("t");
        let kept = side.store.saved_request(&thread).unwrap();
        assert!(kept.settled);
        assert_eq!(kept.shared_prefix_messages, 1);
        let agent = side.tap(run(provider, true));
        agent.begin(&request("three")).settle(&reply("ok"));
        let again = side.store.saved_request(&thread).unwrap();
        assert!(again.settled, "the agent session's send replaced nothing");
    }
}
