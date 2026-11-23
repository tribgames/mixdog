use std::sync::Arc;

use mixdog_core_session::session::turn_ops::SideQuestions;

use super::next_request_source::NextRequestSource;
use super::side_question_store::SideQuestionService;
use super::side_requests::SideRequests;

pub struct SideWiring {
    requests: SideRequests,
    next: Arc<NextRequestSource>,
    questions: Arc<SideQuestionService>,
}

impl SideWiring {
    /// `requests` carries the store: the caller builds it once, with the catalog's caching answer
    /// and the attachment services a capture reads.
    pub fn new(requests: SideRequests) -> Self {
        let next = NextRequestSource::new();
        let questions = Arc::new(SideQuestionService::new(requests.store.clone(), next.clone()));
        Self { requests, next, questions }
    }

    /// `TurnPathParts.side` / `HostParts.side`: the loop's send path.
    pub fn requests(&self) -> SideRequests {
        self.requests.clone()
    }

    /// `TurnPathParts.next` / `HostParts.next`: bound once by `build_directory`.
    pub fn next(&self) -> Arc<NextRequestSource> {
        self.next.clone()
    }

    /// `SessionDeps.side`.
    pub fn questions(&self) -> Arc<dyn SideQuestions> {
        self.questions.clone()
    }
}

#[cfg(test)]
mod tests {

    use mixdog_agent::env::Clock;
    use mixdog_agent::response::ModelResponse;
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, Message, ModelRequest, RequestOptions, Role};
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_session::session::turn_ops::{SIDE_QUESTION_NO_REQUEST, ask_side_question};
    use serde_json::json;

    use super::super::side_requests::RunSide;
    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }
    async fn wiring(dir: &std::path::Path) -> SideWiring {
        SideWiring::new(requests(dir).await)
    }

    async fn requests(dir: &std::path::Path) -> SideRequests {
        let compaction = super::super::compaction_world::tests::services(dir, json!({}), Arc::default()).await;
        SideRequests {
            store: compaction.requests.saved.clone(),
            caching: Arc::new(|_, _| false),
            docs: compaction.docs.clone(),
            reader: compaction.reader.clone(),
            facts: compaction.attachment_facts.clone(),
            clock: Arc::new(Fixed),
        }
    }

    fn request(messages: usize) -> ModelRequest {
        ModelRequest {
            model: "mock-model".into(),
            messages: (0..messages).map(|i| Message::new(Role::User, Content::Text(i.to_string().into()))).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        }
    }

    fn reply() -> ModelResponse {
        ModelResponse { content: "reply".into(), ..ModelResponse::default() }
    }

    struct Rewrites;

    #[tokio::test]
    async fn a_question_asked_during_a_turn_is_answered_from_the_saved_request_and_a_clear_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        let wiring = wiring(dir.path()).await;
        let questions = wiring.questions();
        let thread = ThreadId::from("t");
        let provider = Arc::new(MockProvider::new([MockAttempt::Body(b"t:the answer\ndone\n".to_vec())]));
        let run = RunSide { thread: thread.clone(), provider_name: "mock".into(), provider, agent_owner: false };
        wiring.requests().tap(run).begin(&request(1)).settle(&reply());

        assert_eq!(ask_side_question(&*questions, &thread, " why ", true).await.unwrap(), "the answer");

        questions.forget(&thread, false);
        let refused = ask_side_question(&*questions, &thread, "again", true).await.unwrap_err();
        assert!(format!("{refused:?}").contains(SIDE_QUESTION_NO_REQUEST), "{refused:?}");
    }

    #[async_trait::async_trait]
    impl mixdog_agent::env::Compactor for Rewrites {
        fn estimate_tokens(&self, _: &[mixdog_agent::message::AgentMessage]) -> u64 {
            0
        }
        async fn reduces(&self, _: &mixdog_agent::env::CompactRequest<'_>) -> bool {
            true
        }
        async fn compact(&self, request: mixdog_agent::env::CompactRequest<'_>) -> Result<mixdog_agent::env::CompactOutput, mixdog_agent::env::CompactError> {
            Ok(mixdog_agent::env::CompactOutput {
                messages: request.messages.to_vec(),
                usage: None,
                input_excludes_cache: false,
                dropped_count: 0,
                dropped: None,
                skipped: request.budget_tokens == 0,
                pipeline_ms: 0.0,
                summary_ms: None,
                summary_route: None,
            })
        }
        fn request_media(&self, _: &[mixdog_agent::message::AgentMessage]) -> bool {
            false
        }
    }
    #[tokio::test]
    async fn a_compaction_that_rewrote_the_transcript_retires_the_fork_and_a_skipped_one_does_not() {
        use mixdog_agent::env::{CompactRequest, CompactTrigger, Compactor};
        let dir = tempfile::tempdir().unwrap();
        let compaction = super::super::compaction_world::tests::services(dir.path(), json!({}), Arc::default()).await;
        let store = compaction.requests.saved.clone();
        let world: Arc<dyn super::super::compactors::CompactionWorld> = Arc::new(super::super::compaction_world::ProcessCompactionWorld::new(compaction));
        let thread = ThreadId::from("t");
        let retiring = super::super::retiring_compactor::RetiringCompactor::new(Arc::new(Rewrites), world, thread.clone());
        let provider = Arc::new(MockProvider::new([]));
        let run = RunSide { thread: thread.clone(), provider_name: "mock".into(), provider, agent_owner: false };
        let saved = |compacted: bool| store.saved_request(&thread).map(|r| r.compacted == compacted);
        let side = SideWiring::new(SideRequests { store: store.clone(), ..requests(dir.path()).await });
        side.requests().tap(run).begin(&request(1)).settle(&reply());
        let ask = |budget_tokens| CompactRequest {
            messages: &[],
            budget_tokens,
            trigger: CompactTrigger::Auto,
            require_reduction: false,
            reference_latest_attachments: false,
            active_turn: true,
            latest_user_prefix: "",
        };

        retiring.compact(ask(0)).await.unwrap();
        assert_eq!(saved(false), Some(true), "a skipped pass adopts nothing");
        retiring.compact(ask(1)).await.unwrap();
        assert_eq!(saved(true), Some(true), "the saved request is marked as rewritten");
    }
}
