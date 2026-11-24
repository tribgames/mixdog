use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor};
use mixdog_core_api::domain::provider::{Exposure, ProviderReplay, TransportFault};

use super::*;

/// A response whose stream ends in a connection cut after its events, with the exposure the transport saw; a held one waits
/// before its last event until the test lets it.
struct Cut(VecDeque<StreamEvent>, Option<ProviderError>, Option<Arc<tokio::sync::Notify>>);

#[async_trait]
impl ModelStream for Cut {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if self.0.len() == 1
            && let Some(release) = self.2.take()
        {
            release.notified().await;
        }
        match self.0.pop_front() {
            Some(event) => Some(Ok(event)),
            None => self.1.take().map(Err),
        }
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

struct CutFault {
    tool_input_cut: bool,
    signed_thinking: bool,
}

impl CutFault {
    fn tool_input() -> Self {
        Self { tool_input_cut: true, signed_thinking: false }
    }

    fn tool_input_with_thinking() -> Self {
        Self { tool_input_cut: true, signed_thinking: true }
    }

    fn stream_with_thinking() -> Self {
        Self { tool_input_cut: false, signed_thinking: true }
    }
}

struct CutScripted {
    id: ProviderId,
    codec: AnthropicCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    script: Mutex<VecDeque<(Vec<StreamEvent>, Option<CutFault>)>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    /// The attempts (by number, from 0) whose stream holds its last event until the test lets it.
    holds: Vec<(usize, Arc<tokio::sync::Notify>)>,
}

#[async_trait]
impl ProviderAdapter for CutScripted {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let number = {
            let mut requests = lock(&self.requests);
            requests.push(request);
            requests.len() - 1
        };
        let held = self.holds.iter().find(|(held, _)| *held == number).map(|(_, release)| release.clone());
        let (events, cut) = lock(&self.script).pop_front().expect("provider script exhausted");
        let error = cut.map(|fault| {
            let mut error = ProviderError::transport(TransportFault::H2GoAway { code: 0 }, DeliveryState::Accepted);
            error.exposure = Exposure { text_emitted: true, tool_input_cut: fault.tool_input_cut, ..Exposure::default() };
            if fault.signed_thinking {
                let thinking = json!({ "type": "thinking", "thinking": "weighing options", "signature": "sig-1" });
                error.partial_thinking_blocks = vec![thinking.clone()];
                error.partial_replay = Some(Box::new(ProviderReplay { owner: ProviderId::from("anthropic"), items: Value::Array(vec![thinking]) }));
            }
            error
        });
        Ok(Box::new(Cut(events.into(), error, held)))
    }
}

fn done() -> StreamEvent {
    StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }
}

fn anthropic_codec() -> AnthropicCodec {
    AnthropicCodec::new(Flavor::OAuth, AnthropicConfig::new(Arc::new(|_: &str| None)))
}

fn encode_messages(codec: &AnthropicCodec, request: &ModelRequest) -> Vec<Value> {
    let wire = codec.encode(request).expect("anthropic encode");
    let body: Value = serde_json::from_slice(&wire.body).expect("json body");
    body["messages"].as_array().expect("messages array").clone()
}

fn assert_no_thinking_only_assistant_turn(codec: &AnthropicCodec, request: &ModelRequest) {
    for message in encode_messages(codec, request) {
        if message["role"] != "assistant" {
            continue;
        }
        match &message["content"] {
            Value::Array(blocks) => {
                assert!(
                    blocks.iter().any(|block| !matches!(block.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking"))),
                    "replay assistant turn must not be thinking-only: {blocks:?}"
                );
            }
            Value::String(text) => assert!(!text.trim().is_empty(), "replay assistant turn must not be blank"),
            other => panic!("unexpected assistant content shape: {other:?}"),
        }
    }
}

struct CutOutcome {
    rows: Vec<String>,
    reasoning: Vec<(String, Vec<String>)>,
    handoff: Value,
    requests: Vec<Arc<ModelRequest>>,
    codec: AnthropicCodec,
}

/// A turn started over `script` through the run host's own observer and sink, not waited for yet.
struct CutTurn {
    rig: Rig,
    directory: SessionDirectory,
    id: ThreadId,
    handle: Arc<mixdog_core_session::session::SessionHandle>,
    provider: Arc<CutScripted>,
    _workspace: tempfile::TempDir,
}

/// Starts one turn over `script`; each attempt `holds` names holds its last event until its notice is given.
async fn start_cut_turn(script: Vec<(Vec<StreamEvent>, Option<CutFault>)>, holds: Vec<(usize, Arc<tokio::sync::Notify>)>) -> CutTurn {
    let provider = Arc::new(CutScripted {
        id: ProviderId::from("anthropic"),
        codec: anthropic_codec(),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        script: Mutex::new(script.into()),
        requests: Mutex::new(Vec::new()),
        holds,
    });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    CutTurn { rig, directory, id, handle, provider, _workspace: workspace }
}

/// Runs one turn over `script` through the run host's own observer and sink, returning the thread's
/// agent-message rows, reasoning items, `lastHandoff`, and sent provider requests once the turn ends.
async fn run_cut_turn(script: Vec<(Vec<StreamEvent>, Option<CutFault>)>) -> CutOutcome {
    settle_cut_turn(start_cut_turn(script, Vec::new()).await).await
}

/// Waits for the turn's end and reads what it left.
async fn settle_cut_turn(turn: CutTurn) -> CutOutcome {
    let CutTurn { directory, handle, provider, .. } = turn;
    let codec = anthropic_codec();
    let handoff =
        eventually_on_awaiting(|| "the turn's result on the record".to_owned(), &[handle.stepped()], || handle.header_snapshot().get("lastHandoff").cloned())
            .await;
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
    let items = handle.view_items();
    let rows = items
        .iter()
        .filter_map(|item| match item.as_ref() {
            ThreadItem::AgentMessage { text: MaybeBlob::Inline(text), .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    let reasoning = items
        .iter()
        .filter_map(|item| match item.as_ref() {
            ThreadItem::Reasoning { id, content, .. } => Some((id.as_str().to_owned(), content.clone())),
            _ => None,
        })
        .collect();
    let requests = lock(&provider.requests).clone();
    directory.shutdown().await;
    CutOutcome { rows, reasoning, handoff, requests, codec }
}

/// A progress update shown with a signed thinking block, then a cut inside a tool call's input: the progress settles
/// for display only (shown once), never enters model history or `lastHandoff`, and the replay request carries no
/// thinking-only assistant turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn progress_then_a_cut_tool_input_leaves_the_answer_in_a_segment_of_its_own() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::ProgressDelta("thinking it over".into())], Some(CutFault::tool_input_with_thinking())),
        (vec![StreamEvent::TextDelta("the answer".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 2);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[1]);
    let replay_messages = encode_messages(&outcome.codec, &outcome.requests[1]);
    assert!(
        replay_messages.iter().all(|message| message["role"] != "assistant"),
        "progress-only cut must not push an assistant turn into model history: {replay_messages:?}"
    );
    assert_eq!(
        outcome.rows.iter().filter(|text| text.as_str() == "thinking it over").count(),
        1,
        "progress update is shown once as a display row: {:?}",
        outcome.rows
    );
    assert_eq!(outcome.rows.iter().filter(|text| text.contains("the answer")).count(), 1, "the answer is shown once: {:?}", outcome.rows);
    assert!(outcome.rows.iter().any(|text| text == "the answer"), "the answer is its own row, not appended to the preamble: {:?}", outcome.rows);
    assert_eq!(outcome.handoff, json!("the answer"));
}

/// Shown text with a signed thinking block in `partial_replay` before a cut tool input: the replay assistant turn
/// carries the kept text and is never lowered as thinking-only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shown_text_with_signed_thinking_replay_never_sends_thinking_only_turn() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::TextDelta("part".into())], Some(CutFault::tool_input_with_thinking())),
        (vec![StreamEvent::TextDelta("split".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 2);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[1]);
    let replay_messages = encode_messages(&outcome.codec, &outcome.requests[1]);
    assert!(
        replay_messages.iter().any(|message| {
            message["role"] == "assistant"
                && match &message["content"] {
                    Value::Array(blocks) => blocks.iter().any(|block| block["type"] == "text" && block["text"] == "part"),
                    Value::String(text) => text == "part",
                    _ => false,
                }
        }),
        "kept text must appear in the replay assistant turn: {replay_messages:?}"
    );
    assert_eq!(outcome.handoff, json!("part\n\nsplit"));
}

/// A reasoning-only cut closes the dead attempt's reasoning item so the replay starts a new reasoning item instead of
/// appending onto the first one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_only_cut_starts_a_new_reasoning_item_on_replay() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::ReasoningDelta("first thought".into())], Some(CutFault::stream_with_thinking())),
        (vec![StreamEvent::ReasoningDelta("second thought".into()), StreamEvent::TextDelta("done".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 2);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[1]);
    assert_eq!(outcome.reasoning.len(), 2, "replay must open a separate reasoning item: {:?}", outcome.reasoning);
    assert_ne!(outcome.reasoning[0].0, outcome.reasoning[1].0, "reasoning items must have distinct ids");
    assert_eq!(outcome.reasoning[0].1, vec!["first thought"]);
    assert_eq!(outcome.reasoning[1].1, vec!["second thought"]);
    assert_eq!(outcome.handoff, json!("done"));
}

/// Text shown before each of two cuts in one ladder: both are kept, in order, and the replay repeats neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_cuts_each_after_shown_text_keep_both_and_repeat_neither() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::TextDelta("one".into())], Some(CutFault::tool_input())),
        (vec![StreamEvent::TextDelta("two".into())], Some(CutFault::tool_input())),
        (vec![StreamEvent::TextDelta("three".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 3);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[1]);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[2]);
    for text in ["one", "two", "three"] {
        assert_eq!(outcome.rows.iter().filter(|row| row.as_str() == text).count(), 1, "{text} is one row of its own: {:?}", outcome.rows);
    }
    assert_eq!(outcome.handoff, json!("one\n\ntwo\n\nthree"));
}

/// An agent task's result (`lastHandoff`, what its caller gets back) holds the text kept across the cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_task_result_includes_the_text_kept_across_a_cut_tool_input() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::TextDelta("part".into())], Some(CutFault::tool_input())),
        (vec![StreamEvent::TextDelta("split".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.handoff, json!("part\n\nsplit"));
}

/// Progress, then the blank text a model streams between its thinking and its next block, then a cut mid-stream: blank
/// text is no kept text. The progress settles for display only, the signed thinking goes with the attempt, and the
/// replay carries neither an assistant turn nor an empty-turn nudge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn progress_then_blank_text_then_a_cut_settles_for_display_and_replays() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::ProgressDelta("thinking it over".into()), StreamEvent::TextDelta("\n".into())], Some(CutFault::stream_with_thinking())),
        (vec![StreamEvent::TextDelta("the answer".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 2);
    let replay_messages = encode_messages(&outcome.codec, &outcome.requests[1]);
    assert!(replay_messages.iter().all(|message| message["role"] != "assistant"), "the dead attempt is no history: {replay_messages:?}");
    assert!(!Value::Array(replay_messages.clone()).to_string().contains("Empty response"), "no empty-turn nudge: {replay_messages:?}");
    assert_eq!(outcome.rows.iter().filter(|text| text.trim() == "thinking it over").count(), 1, "the progress shows once: {:?}", outcome.rows);
    assert!(outcome.rows.iter().any(|text| text == "the answer"), "the answer is a row of its own: {:?}", outcome.rows);
    assert!(outcome.rows.iter().all(|text| !text.trim().is_empty()), "no blank row: {:?}", outcome.rows);
    assert_eq!(outcome.handoff, json!("the answer"));
}

/// Text, then reasoning, then a cut inside a tool call's input: the text is kept, and the replay's reasoning is an item of
/// its own, never appended to the dead attempt's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_after_kept_text_is_closed_before_the_replay_reasons() {
    let outcome = run_cut_turn(vec![
        (vec![StreamEvent::TextDelta("part".into()), StreamEvent::ReasoningDelta("pondering".into())], Some(CutFault::tool_input())),
        (vec![StreamEvent::ReasoningDelta("second thought".into()), StreamEvent::TextDelta("split".into()), done()], None),
    ])
    .await;
    assert_eq!(outcome.requests.len(), 2);
    assert_no_thinking_only_assistant_turn(&outcome.codec, &outcome.requests[1]);
    assert_eq!(outcome.reasoning.len(), 2, "one reasoning item per attempt: {:?}", outcome.reasoning);
    assert_ne!(outcome.reasoning[0].0, outcome.reasoning[1].0);
    assert_eq!(outcome.reasoning[0].1, vec!["pondering"]);
    assert_eq!(outcome.reasoning[1].1, vec!["second thought"]);
    for text in ["part", "split"] {
        assert_eq!(outcome.rows.iter().filter(|row| row.as_str() == text).count(), 1, "{text} is one row of its own: {:?}", outcome.rows);
    }
    assert_eq!(outcome.handoff, json!("part\n\nsplit"));
}

/// The draft a recovery of the running turn would take: its file folded as the store folds it at open.
fn recovered_draft(rig: &Rig, id: &ThreadId) -> mixdog_core_session::session::turn_draft::RunDraft {
    let records = rig.store.records(id);
    let landed = |iid: &str| records.iter().any(|(_, record)| matches!(record, Record::Item(item) if item.iid.as_str() == iid));
    let mut draft = mixdog_core_session::session::turn_draft::RunDraft::default();
    for (_, bodies) in rig.store.draft_files(id) {
        draft.apply_file(&bodies, &landed, |_| false);
    }
    draft
}

/// Whether the run's draft file ever held `text`.
fn drafted(rig: &Rig, id: &ThreadId, text: &str) -> bool {
    rig.store.draft_files(id).iter().any(|(_, bodies)| bodies.iter().any(|body| body.to_string().contains(text)))
}

/// A display-only row (no model message) of `text`.
fn display_row(record: &Record, text: &str) -> bool {
    matches!(record, Record::Item(item) if !item.model && matches!(&item.body, Slot::Inline(body) if body["text"] == text))
}

/// The settle is a job of the run's one ordered queue: behind every draft of the attempt it settles and ahead of every
/// draft of the next, whatever the forwarding of the shown reports does meanwhile.
#[test]
fn a_settle_is_queued_between_the_drafts_of_its_attempt_and_the_next() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let observed = Observed { started: true, text: "thinking it over".into(), ..Observed::default() };
    let jobs = Jobs { observed: Arc::new(Mutex::new(observed)), seq: AtomicU64::new(0), tx, shown: None, taken: Mutex::default() };
    jobs.draft();
    jobs.settle(vec![(ItemId::from("segment"), "thinking it over".to_owned())], None);
    jobs.draft();
    lock(&jobs.observed).text.push_str("the answer");
    jobs.draft();
    let mut order = Vec::new();
    while let Ok(job) = rx.try_recv() {
        order.push(match job {
            Job::Draft(_, body) => format!("draft {}", body["text"].as_str().unwrap_or_default()),
            Job::Settle(_, segments, ..) => format!("settle {}", segments[0].1),
            Job::Commit(..) | Job::Compact(..) | Job::Rewound(..) => "other".to_owned(),
        });
    }
    assert_eq!(order, ["draft thinking it over", "settle thinking it over", "draft the answer"]);
}

/// The cut attempt's first script entry: progress, then a keepalive its stream holds until the test lets it, so the cut
/// comes once the progress is drafted. A cut right after the progress would come before its throttled draft is written,
/// and the settle at the cut leaves that write nothing to take.
fn drafted_progress_then_a_cut() -> (Vec<StreamEvent>, Option<CutFault>) {
    (vec![StreamEvent::ProgressDelta("thinking it over".into()), StreamEvent::ProviderKeepalive], Some(CutFault::stream_with_thinking()))
}

/// Waits until the run's draft file holds `text`.
async fn until_drafted(turn: &CutTurn, text: &str) {
    let (rig, id) = (&turn.rig, &turn.id);
    eventually_on_awaiting(
        || format!("{text:?} drafted: {:?}", rig.store.draft_files(id)),
        &[&rig.store.committed, turn.handle.stepped()],
        || drafted(rig, id, text).then_some(()),
    )
    .await;
}

/// The replay streams at once, its start never waiting on the cut attempt's settle: the settle at the cut ends the draft's
/// message before any draft of the replay, so the draft holds the replay's reasoning and text and none of the settled
/// progress.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_replays_drafts_follow_the_settle_of_the_cut_attempt() {
    let (cut, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let turn = start_cut_turn(
        vec![
            drafted_progress_then_a_cut(),
            (vec![StreamEvent::ReasoningDelta("second thought".into()), StreamEvent::TextDelta("the answer".into()), done()], None),
        ],
        vec![(0, cut.clone()), (1, release.clone())],
    )
    .await;
    until_drafted(&turn, "thinking it over").await;
    cut.notify_one();
    let (rig, id) = (&turn.rig, &turn.id);
    eventually_on_awaiting(
        || format!("the replay's draft after the settle: {:?}", recovered_draft(rig, id)),
        &[&rig.store.committed, turn.handle.stepped()],
        || {
            let draft = recovered_draft(rig, id);
            let settled = rig.store.records(id).iter().any(|(_, record)| display_row(record, "thinking it over"));
            (settled && draft.text == "the answer" && draft.reasoning == "second thought").then_some(())
        },
    )
    .await;
    release.notify_one();
    let outcome = settle_cut_turn(turn).await;
    assert_eq!(outcome.handoff, json!("the answer"));
}

/// The settle's display row is written only once the draft no longer holds the settled text: a process that dies with
/// the row's write under way recovers none of that text into the model's history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_settle_clears_the_draft_before_its_display_row_is_written() {
    let cut = Arc::new(tokio::sync::Notify::new());
    let turn =
        start_cut_turn(vec![drafted_progress_then_a_cut(), (vec![StreamEvent::TextDelta("the answer".into()), done()], None)], vec![(0, cut.clone())]).await;
    until_drafted(&turn, "thinking it over").await;
    let (rig, id) = (&turn.rig, &turn.id);
    let (arrived, go) = rig.store.hold_record(|record| display_row(record, "thinking it over"));
    cut.notify_one();
    mixdog_core_session::session::testing::awaiting(|| "the display row's write".to_owned(), arrived.notified()).await;
    let draft = recovered_draft(rig, id);
    let written = rig.store.records(id).iter().any(|(_, record)| display_row(record, "thinking it over"));
    go.send(()).expect("the held write waits");
    assert!(!written, "the row's write is held");
    assert!(!draft.text.contains("thinking it over"), "the draft gave up the settled text before its row's write: {draft:?}");
    let outcome = settle_cut_turn(turn).await;
    assert_eq!(outcome.handoff, json!("the answer"));
    assert_eq!(outcome.rows.iter().filter(|text| text.as_str() == "thinking it over").count(), 1, "{:?}", outcome.rows);
}

/// A finished thinking row of `text`.
fn reasoning_row(record: &Record, text: &str) -> bool {
    matches!(record, Record::Item(item) if !item.model && matches!(&item.body, Slot::Inline(body) if body["kind"] == "reasoning" && body["content"][0] == text))
}

/// A reasoning-only cut: the thinking the attempt was still showing is stored as its thinking row only once the draft no
/// longer holds it, as the settle's text rows are, so a process that dies with the row's write under way recovers none of it
/// into the model's history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_settled_reasoning_row_is_written_after_the_draft_gives_it_up() {
    let cut = Arc::new(tokio::sync::Notify::new());
    let turn = start_cut_turn(
        vec![
            (vec![StreamEvent::ReasoningDelta("first thought".into()), StreamEvent::ProviderKeepalive], Some(CutFault::stream_with_thinking())),
            (vec![StreamEvent::TextDelta("the answer".into()), done()], None),
        ],
        vec![(0, cut.clone())],
    )
    .await;
    until_drafted(&turn, "first thought").await;
    let (rig, id) = (&turn.rig, &turn.id);
    let (arrived, go) = rig.store.hold_record(|record| reasoning_row(record, "first thought"));
    cut.notify_one();
    mixdog_core_session::session::testing::awaiting(|| "the thinking row's write".to_owned(), arrived.notified()).await;
    let draft = recovered_draft(rig, id);
    go.send(()).expect("the held write waits");
    assert!(!draft.reasoning.contains("first thought"), "the draft gave up the settled reasoning before its row's write: {draft:?}");
    let outcome = settle_cut_turn(turn).await;
    assert_eq!(outcome.handoff, json!("the answer"));
    let thoughts: Vec<&Vec<String>> = outcome.reasoning.iter().map(|(_, content)| content).collect();
    assert_eq!(thoughts, [&vec!["first thought".to_owned()]], "one thinking row, shown once");
}

/// Blank text the cut attempt showed ends with the settle: it leaves the turn's in-progress items, and the clients' live row
/// by its `item/completed` ahead of the replay's reasoning, with no row stored, while the replay streams.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_settle_ends_the_blank_text_the_cut_attempt_showed() {
    let release = Arc::new(tokio::sync::Notify::new());
    let turn = start_cut_turn(
        vec![
            (vec![StreamEvent::TextDelta("\n".into())], Some(CutFault::stream_with_thinking())),
            (vec![StreamEvent::ReasoningDelta("second thought".into()), StreamEvent::TextDelta("the answer".into()), done()], None),
        ],
        vec![(1, release.clone())],
    )
    .await;
    let frames = || turn.rig.feeds.frames(turn.id.as_str());
    let started = |frame: &(u64, String, Value)| frame.1 == "item/started" && frame.2["item"]["type"] == "agentMessage";
    let blank = eventually_on_awaiting(
        || format!("the blank text's item: {:?}", frames()),
        &[turn.handle.stepped()],
        || frames().iter().find(|frame| started(frame)).and_then(|frame| frame.2["item"]["id"].as_str().map(str::to_owned)),
    )
    .await;
    let ended = |frames: &[(u64, String, Value)]| frames.iter().position(|frame| frame.1 == "item/completed" && frame.2["item"]["id"] == blank.as_str());
    let reasoned = |frames: &[(u64, String, Value)]| frames.iter().position(|frame| frame.2.to_string().contains("second thought"));
    let (ended_at, reasoned_at) = eventually_on_awaiting(
        || format!("the blank item's completion and the replay's reasoning: {:?}", frames()),
        &[turn.handle.stepped()],
        || {
            let frames = frames();
            ended(&frames).zip(reasoned(&frames))
        },
    )
    .await;
    assert!(ended_at < reasoned_at, "the live row ends before the replay reasons: {:?}", frames());
    assert!(
        !turn.rig.store.records(&turn.id).iter().any(|(_, record)| matches!(record, Record::Item(item) if item.iid.as_str() == blank)),
        "no row of the blank text is stored"
    );
    let texts = || {
        turn.handle
            .view_items()
            .iter()
            .filter_map(|item| match item.as_ref() {
                ThreadItem::AgentMessage { text: MaybeBlob::Inline(text), .. } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    eventually_on_awaiting(
        || format!("the replay streaming with no blank item left: {:?}", texts()),
        &[turn.handle.stepped()],
        || {
            let texts = texts();
            (texts.iter().any(|text| text == "the answer") && texts.iter().all(|text| !text.trim().is_empty())).then_some(())
        },
    )
    .await;
    release.notify_one();
    let outcome = settle_cut_turn(turn).await;
    assert_eq!(outcome.handoff, json!("the answer"));
}

/// An attempt that kept nothing settles as the loop decides so, before its backoff: in the wait its display row is stored, the
/// draft holds none of it, and the prompt its text committed is the user's again. A Stop then is that of a turn that answered
/// nothing: the question goes back to the composer, and no row of the turn is left as an answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_in_the_backoff_keeps_none_of_the_settled_attempt_as_an_answer() {
    let turn = start_cut_turn(
        vec![
            (vec![StreamEvent::ProgressDelta("thinking it over".into())], Some(CutFault::stream_with_thinking())),
            (vec![StreamEvent::TextDelta("never".into()), done()], None),
        ],
        Vec::new(),
    )
    .await;
    let (rig, id) = (&turn.rig, &turn.id);
    let requests = || lock(&turn.provider.requests).len();
    eventually_on_awaiting(
        || format!("the settle in the backoff: {} requests, draft {:?}", requests(), recovered_draft(rig, id)),
        &[turn.handle.stepped()],
        || {
            let shown = rig.store.records(id).iter().any(|(_, record)| display_row(record, "thinking it over"));
            let drafted = recovered_draft(rig, id).text.contains("thinking it over");
            (shown && !drafted && requests() == 1).then_some(())
        },
    )
    .await;
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    let stopped =
        turn.handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await.expect("stop in the backoff");
    assert_eq!(stopped["restoreText"], json!("go"), "the question goes back to the composer: {stopped}");
    let left = || {
        turn.handle
            .view_items()
            .iter()
            .filter(|item| matches!(item.as_ref(), ThreadItem::UserMessage { .. } | ThreadItem::AgentMessage { .. }))
            .cloned()
            .collect::<Vec<_>>()
    };
    let rewound = || rig.store.records(id).iter().any(|(_, record)| matches!(record, Record::Rewind(_)));
    eventually_on_awaiting(
        || format!("the stopped turn's end, its question handed back: rewound {}, left {:?}", rewound(), left()),
        &[&rig.store.committed, turn.handle.stepped()],
        || (!turn.handle.turn_busy() && rewound() && left().is_empty()).then_some(()),
    )
    .await;
    assert_eq!(requests(), 1, "no replay after the stop");
    let answered = rig
        .store
        .records(id)
        .into_iter()
        .any(|(_, record)| matches!(&record, Record::Item(item) if item.model && matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant")));
    assert!(!answered, "no answer row: {:?}", rig.store.records(id));
    turn.directory.shutdown().await;
}

/// A Stop while the settle is on its way, after the run took the cut attempt's text and before the session settled it: the
/// Stop finds the prompt committed by that text and hands nothing back, and the turn's close, which finds none of the text,
/// keeps the question as the Stop decided. The reply and the transcript agree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_while_the_settle_is_on_its_way_keeps_the_question_it_did_not_hand_back() {
    let (held, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    SETTLE_HOLDS.lock().unwrap().push(("weighing the stop".to_owned(), held.clone(), go.clone()));
    let turn = start_cut_turn(
        vec![
            (vec![StreamEvent::ProgressDelta("weighing the stop".into())], Some(CutFault::stream_with_thinking())),
            (vec![StreamEvent::TextDelta("never".into()), done()], None),
        ],
        Vec::new(),
    )
    .await;
    let (rig, id) = (&turn.rig, &turn.id);
    mixdog_core_session::session::testing::awaiting(|| "the settle held on its way".to_owned(), held.notified()).await;
    eventually_on_awaiting(
        || "the shown text in the session".to_owned(),
        &[turn.handle.stepped()],
        || {
            let shown = turn
                .handle
                .view_items()
                .iter()
                .any(|item| matches!(item.as_ref(), ThreadItem::AgentMessage { text: MaybeBlob::Inline(text), .. } if text == "weighing the stop"));
            shown.then_some(())
        },
    )
    .await;
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    let stopped =
        turn.handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await.expect("stop in the window");
    go.notify_one();
    assert_eq!(stopped["restoreText"], json!(""), "the Stop found the prompt answered by the shown text: {stopped}");
    let ended = || {
        rig.store
            .records(id)
            .iter()
            .any(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Interrupted)))
    };
    eventually_on_awaiting(
        || format!("the stopped turn's end: {:?}", rig.store.records(id)),
        &[&rig.store.committed, turn.handle.stepped()],
        || (!turn.handle.turn_busy() && ended()).then_some(()),
    )
    .await;
    assert!(!rig.store.records(id).iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "nothing is rewound: {:?}", rig.store.records(id));
    let questions = turn.handle.view_items().iter().filter(|item| matches!(item.as_ref(), ThreadItem::UserMessage { .. })).count();
    assert_eq!(questions, 1, "the question stays: {:?}", turn.handle.view_items());
    turn.directory.shutdown().await;
}
