//! The one wiring of a process's side questions: the saved-request store the loop's sends record into
//! ([`SideRequests`]), the source of a session's next request ([`NextRequestSource`]) and the
//! [`SideQuestions`] the session's `thread/askSide` and `thread/cancelSide` run on, all over the same
//! store and the same source. The composition builds this once and hands each part to the seam that
//! takes it; it cannot give the session a service over another store than the loop records into.
//!
//! Clearing follows Node (`side-question-store.mjs`): a clear or rewind `forget`s the saved request, a
//! close or runtime unload `forget`s it and cancels the question in flight
//! (`SideQuestions::forget`, called by the session), a compaction that rewrote the transcript retires
//! the fork ([`RetiringCompactor`](super::retiring_compactor::RetiringCompactor), over
//! `CompactionWorld::retire_fork`).

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
    use std::collections::HashMap;

    use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute};
    use mixdog_agent::env::{Clock, SendTicket};
    use mixdog_agent::response::ModelResponse;
    use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
    use mixdog_core_api::domain::provider::{Content, Message, ModelRequest, RequestOptions, Role};
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_session::session::turn_ops::{ask_side_question, SideRun, SIDE_QUESTION_NO_REQUEST};
    use mixdog_rt::CancellationToken;
    use serde_json::{json, Value};

    use super::super::side_requests::RunSide;
    use mixdog_agent::compact::summary_run::ForkSource;
    use super::super::summary_routes::{ForkSender, SessionFork};
    use super::*;

    /// What Node's store kept at every step of the recorded scenarios
    /// (`benchmarks/rust-core/recorders/record-side-question-store.mjs`).
    const GOLDEN: &str = include_str!("../../../../fixtures/side-question-store/golden.json");

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    struct Never;
    #[async_trait::async_trait]
    impl ForkSender for Never {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!("the replay only reads the saved request")
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
            messages: (0..messages).map(|i| Message::new(Role::User, Content::Text(i.to_string()))).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        }
    }

    fn reply() -> ModelResponse {
        ModelResponse { content: "reply".into(), ..ModelResponse::default() }
    }

    fn header(owner: Option<&str>) -> serde_json::Map<String, Value> {
        let Value::Object(header) = (match owner {
            Some(owner) => json!({ "owner": owner }),
            None => json!({ "owner": "lead" }),
        }) else {
            unreachable!()
        };
        header
    }

    /// The state Node's `sideQuestionRequest` and `compactionForkRequest` read back.
    fn observed(wiring: &SideWiring, session: &str) -> Value {
        let thread = ThreadId::from(session);
        let saved = wiring.requests.store.saved_request(&thread);
        let forkable = SessionFork::new(saved.clone(), Arc::new(Fixed), Arc::new(Never)).request().is_some();
        json!({
            "request": saved.map(|r| json!({ "messages": r.shared_prefix_messages, "settled": r.settled, "compacted": r.compacted })),
            "forkable": forkable,
        })
    }

    #[tokio::test]
    async fn every_recorded_step_of_nodes_store_is_reached_through_the_wiring() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
        let dir = tempfile::tempdir().unwrap();
        let mut steps_run = 0;
        for scenario in golden["scenarios"].as_array().expect("scenarios") {
            let wiring = wiring(dir.path()).await;
            let questions = wiring.questions();
            let provider = Arc::new(MockProvider::new([]));
            let mut tickets: HashMap<String, Box<dyn SendTicket>> = HashMap::new();
            let mut runs: HashMap<String, (CancellationToken, Option<SideRun>)> = HashMap::new();
            for recorded in scenario["steps"].as_array().expect("steps") {
                let step = &recorded["step"];
                let thread = ThreadId::from(step["session"].as_str().unwrap_or("s"));
                let alias = step["as"].as_str().unwrap_or_default().to_owned();
                let mut returned = None;
                match step["op"].as_str().unwrap() {
                    "capture" => {
                        let owner = step["owner"].as_str();
                        let agent_owner = super::super::compaction_world::is_agent_owner(&header(Some(owner.unwrap_or("lead"))));
                        let run = RunSide { thread, provider_name: "mock".into(), provider: provider.clone(), agent_owner };
                        let ticket = wiring.requests().tap(run).begin(&request(step["messages"].as_u64().unwrap() as usize));
                        tickets.insert(alias, ticket);
                    }
                    "settle" => tickets.remove(&alias).unwrap().settle(&reply()),
                    "discard" => tickets.remove(&alias).unwrap().discard(),
                    "retire" => wiring.requests.store.retire_compaction_fork(&thread),
                    "forget" => questions.forget(&thread, step["cancel"].as_bool().unwrap()),
                    "begin" => {
                        let run = questions.begin(&thread);
                        runs.insert(alias, (run.cancel.clone(), Some(run)));
                    }
                    "end" => drop(runs.get_mut(&alias).unwrap().1.take()),
                    "cancel" => returned = Some(questions.cancel(&thread)),
                    other => panic!("unknown step {other}"),
                }
                let name = scenario["name"].as_str().unwrap();
                for session in ["s", "t"] {
                    assert_eq!(observed(&wiring, session), recorded["state"][session], "{name}: {step} (session {session})");
                }
                assert_eq!(returned.map(Value::Bool), recorded.get("returned").cloned(), "{name}: {step} (returned)");
                for (alias, (cancel, _)) in &runs {
                    assert_eq!(Value::Bool(cancel.is_cancelled()), recorded["aborted"][alias], "{name}: {step} (run {alias})");
                }
                steps_run += 1;
            }
        }
        assert_eq!(steps_run, 57);
    }

    struct Rewrites;
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
                dropped_count: 0,
                dropped: None,
                skipped: request.budget_tokens == 0,
                pipeline_ms: 0.0,
                summary_ms: None,
            })
        }
        fn cache_expired(&self) -> bool {
            false
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
        let ask = |budget_tokens| CompactRequest { messages: &[], budget_tokens, trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };

        retiring.compact(ask(0)).await.unwrap();
        assert_eq!(saved(false), Some(true), "a skipped pass adopts nothing");
        retiring.compact(ask(1)).await.unwrap();
        assert_eq!(saved(true), Some(true), "the saved request is marked as rewritten");
    }

    #[tokio::test]
    async fn a_question_asked_during_a_turn_is_answered_from_the_saved_request_and_a_clear_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        let wiring = wiring(dir.path()).await;
        let questions = wiring.questions();
        let thread = ThreadId::from("t");
        let provider = Arc::new(MockProvider::new([MockAttempt::Body(b"t:the answer\ndone\n".to_vec())]));
        let run = RunSide { thread: thread.clone(), provider_name: "mock".into(), provider, agent_owner: false };
        wiring.requests().tap(run).begin(&request(1)).settle(&reply());

        assert_eq!(ask_side_question(&*questions, &thread, " why ").await.unwrap(), "the answer");

        questions.forget(&thread, false);
        let refused = ask_side_question(&*questions, &thread, "again").await.unwrap_err();
        assert!(format!("{refused:?}").contains(SIDE_QUESTION_NO_REQUEST), "{refused:?}");
    }
}