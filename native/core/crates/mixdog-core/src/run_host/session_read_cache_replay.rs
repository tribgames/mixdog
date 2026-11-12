//! `fixtures/read-cache/golden.json` (`record-read-cache.mjs`): several turns of one session through the product's turn
//! path, against what Node showed the model. A session's cached tool results live as long as the session, not as long as one
//! turn: the second turn's first read of a file the first turn read is answered from the cache, or is not, exactly where Node's is.
//!
//! The turns are real (`turn/start` on a session directory, the run factory, the loop, the tool batch, the read and apply_patch tools
//! over one read state that persists its snapshots), against a scripted provider; the run's result cache is the one the production
//! assembly hands a run (`LiveReuses::run`, bound to the read state as the composition binds it). The steps between the turns are the
//! recorded ones: a write to the file on disk, and the session's close (`SessionClose::detach`, the close that keeps the record
//! open) followed by the resume of the thread. The compaction scenario needs the whole daemon and is replayed by
//! `replay-read-cache.mjs`; the tool messages of every request, per turn, are compared whole.

#![allow(clippy::disallowed_methods, reason = "the replay lays out its fixture files with blocking calls on the test thread")]

use std::collections::VecDeque;

use mixdog_core_api::domain::provider::{ContentPart, Message};
use mixdog_tools::fs::read_state::Persistence;
use mixdog_tools::fs::{ApplyPatchTool, ReadState, ReadTool};

use super::*;
use crate::run_host::result_reuse::LiveReuses;

struct NoShells;

impl mixdog_core_session::session::shell_jobs::OwnedShells for NoShells {
    fn cancel_owned(&self, _: &ThreadId) {}
}

struct NoProviders;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// The production assembly's tool set and result cache for a run, over a workspace.
struct ReadParts {
    provider: Arc<dyn ProviderAdapter>,
    workspace: std::path::PathBuf,
    state: Arc<ReadState>,
    reuses: Arc<LiveReuses>,
}

#[async_trait]
impl RunParts for ReadParts {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let tokens = mixdog_rt::testing::tokens();
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(ReadTool::new(None, None).with_state(self.state.clone())), Arc::new(ApplyPatchTool::new().with_state(self.state.clone()))];
        Ok(Assembled {
            provider: self.provider.clone(),
            tools: ToolSet::new(tools),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: io.clone(),
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config: RunConfig::new(input.thread.clone(), input.turn.clone(), "m"),
            clock: Arc::new(Fixed),
            decider: Arc::new(MockRetryDecider),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            skills: None,
            hooks: None,
            reuse: Some(self.reuses.run(io, input.thread.as_str(), &self.workspace, false, Arc::new(Fixed))),
            reactions: None,
            reaction_scope: None,
            rows: Arc::default(),
            tail: None,
            side: None,
            step_judge: None,
            artifacts: None,
            images: None,
            failures: None,
            blobs: Arc::new(NoBlobs),
            carry: RunCarry::default(),
        })
    }
}

/// What the model says to one request, as the provider's stream.
fn stream_of(reply: &Value) -> Vec<StreamEvent> {
    let calls = reply["calls"].as_array().unwrap();
    let mut events = Vec::new();
    if !reply["text"].as_str().unwrap().is_empty() {
        events.push(StreamEvent::TextDelta(reply["text"].as_str().unwrap().into()));
    }
    for call in calls {
        events.push(StreamEvent::ToolCallDone(ToolCall { id: call["id"].as_str().unwrap().into(), name: call["name"].as_str().unwrap().into(), arguments: call["args"].clone(), native_type: None }));
    }
    let stop = if calls.is_empty() { StopReason::EndTurn } else { StopReason::ToolUse };
    events.push(StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None });
    events
}

fn text_of(message: &Message) -> String {
    match &message.content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts.iter().filter_map(|part| if let ContentPart::Text(text, _) = part { Some(text.as_str()) } else { None }).collect(),
    }
}

/// `record-read-cache.mjs`'s walk over a request: once the transcript holds an assistant message, the tool messages after the last one.
fn tool_messages(request: &ModelRequest) -> Option<Vec<String>> {
    let last = request.messages.iter().rposition(|m| m.role == Role::Assistant)?;
    Some(request.messages[last + 1..].iter().filter(|m| m.role == Role::Tool).map(text_of).collect())
}

/// One recorded scenario run on the core. Returns, per turn, the tool messages of its requests and the replies left unused.
async fn play(scenario: &Value) -> Vec<(Vec<Vec<String>>, usize)> {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let golden = scenario;
    let files: serde_json::Map<String, Value> = golden["files"].as_object().cloned().unwrap_or_default();
    let base: serde_json::Map<String, Value> = recording()["files"].as_object().cloned().unwrap();
    for (name, text) in base.iter().chain(files.iter()) {
        std::fs::write(workspace.path().join(name), text.as_str().unwrap()).unwrap();
    }
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::new()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let tokens = mixdog_rt::testing::tokens();
    let persist = Arc::new(crate::run_host::read_snapshots::FileSnapshotPersist::new(data.path()));
    let state = Arc::new(ReadState::new(Some(Persistence::new(persist, tokens.durability_io))));
    let reuses: Arc<LiveReuses> = Arc::default();
    reuses.bind(&state);
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    let parts = Arc::new(ReadParts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), state: state.clone(), reuses });
    let liveness = mixdog_services::task_reports::runtime_state::RuntimeLiveness::new();
    deps.runs = Arc::new(RunHostFactory::new(liveness.clone(),mixdog_tools::web::NativeSearchUsageSinks::new(), parts));
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let close = mixdog_core_session::session::close::SessionClose::new(directory.clone(), providers, Arc::new(NoShells), state.clone());
    let Reply::Subscribe(subscribe) = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start") else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));

    let mut handle = directory.handle(&id).expect("the thread is open");
    let mut turns = Vec::new();
    for phase in golden["phases"].as_array().unwrap() {
        if let Some(replies) = phase["turn"].as_array() {
            let (before, number) = (lock(&provider.requests).len(), turns.len() + 1);
            *lock(&provider.script) = replies.iter().map(stream_of).collect();
            let op = format!("op-turn-{number}");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": format!("go {number}") } }), &op)).await.expect("turn/start");
            // A turn is over when its closing answer, the assistant row with no tool call, is in the store (every scenario ends each turn with one).
            let answers = || {
                rig.store
                    .records(&id)
                    .into_iter()
                    .filter_map(|(_, record)| match record {
                        Record::Item(item) => match item.body {
                            Slot::Inline(body) => Some(body),
                            _ => None,
                        },
                        _ => None,
                    })
                    .filter(|body| body["role"] == "assistant" && body["toolCalls"].as_array().is_none_or(Vec::is_empty))
                    .count()
            };
            eventually_on_awaiting(|| format!("{number} closing answers in the store (found {})", answers()), &[handle.stepped()], || (answers() >= number).then_some(())).await;
            // Node's `askSession` has returned when the turn is over; the session is idle then, and only then is it closed or asked again.
            eventually_on_awaiting(|| format!("the run of turn {number} ended"), &[handle.stepped(), &*rig.feeds.published], || (!liveness.in_flight_session_activity().working.contains(id.as_str())).then_some(())).await;
            let sends = lock(&provider.requests)[before..].iter().filter_map(|request| tool_messages(request)).collect();
            turns.push((sends, lock(&provider.script).len()));
        } else if phase["write"].is_object() {
            std::fs::write(workspace.path().join(phase["write"]["file"].as_str().unwrap()), phase["write"]["text"].as_str().unwrap()).unwrap();
        } else if phase["close"] == json!(true) {
            // `closeSession(id, 'resume-away', { tombstone: false })` and the resume: the snapshots are written as the session leaves memory.
            assert!(close.detach(id.as_str(), "resume-away", false).await, "the session detaches");
            state.settle().await;
            handle = directory.open_handle(&id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("the thread resumes");
            // The client follows the resumed thread (`thread/resume`), as it follows a started one: the feed it watches carries the turn's frames.
            let Reply::Subscribe(_) = handle.request(request("thread/resume", json!({ "threadId": id, "window": { "lastItems": 10 } }), "op-resume")).await.expect("thread/resume") else { panic!("thread/resume subscribes") };
        } else {
            unreachable!("a phase this replay does not play: {phase}");
        }
    }
    turns
}

fn recording() -> Value {
    serde_json::from_str(&mixdog_testkit::fixture!("../../fixtures/read-cache/golden.json")).expect("the read-cache recording")
}

/// A scenario of the recording this replay plays: the compaction one needs the daemon.
fn played(scenario: &Value) -> bool {
    !scenario["phases"].as_array().unwrap().iter().any(|phase| phase["compact"] == json!(true))
}

async fn replay(name: &str) {
    let golden = recording();
    let at = golden["scenarios"].as_array().unwrap().iter().position(|s| s["name"] == name).expect("a recorded scenario");
    let scenario = &golden["scenarios"][at];
    assert!(played(scenario));
    let node = &golden["results"][at];
    let turns = play(scenario).await;
    let expected: Vec<(Vec<Vec<String>>, usize)> = node["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|turn| (turn["sends"].as_array().unwrap().iter().map(|send| send.as_array().unwrap().iter().map(|text| text.as_str().unwrap().to_owned()).collect()).collect(), turn["unused"].as_u64().unwrap() as usize))
        .collect();
    assert_eq!(turns, expected, "{name}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_read_in_one_turn_is_answered_from_the_session_cache_in_the_next() {
    replay("the same file read again in the next turn").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeated_read_within_each_of_two_turns_reads_like_nodes() {
    replay("the same file read twice in each of two turns").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_changed_on_disk_between_the_turns_is_read_again() {
    replay("the file changed on disk between the turns").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_patched_by_the_session_is_read_again_in_the_turn_after() {
    replay("the file patched by the session in the next turn").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_files_read_leaves_the_first_cached() {
    replay("another file read after the first turn").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_and_resumed_session_reads_like_nodes() {
    replay("the session closed and resumed between the turns").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hundred_and_first_entry_of_a_session_evicts_the_first() {
    replay("the hundred and first entry").await;
}
