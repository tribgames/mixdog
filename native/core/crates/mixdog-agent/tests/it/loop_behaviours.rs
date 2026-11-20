//! What the agent loop does with a turn: tool-call ids, the output-limit and refusal ladders, the todo report, the
//! turn caps, dispatch order and the repeat-failure guard, an outage, the cache-break guard, the kept and warm
//! request, and the text-only check. Each test scripts the provider and the tools in the test itself.

use mixdog_agent::prefix_guard::GuardOptions;
use mixdog_agent::prefix_guard::compare;
use mixdog_agent::prefix_guard::snapshot;
use mixdog_agent::repair::ToolCallIds;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_agent::text_only::MediaText;
use mixdog_agent::text_only::TextOnlyModel;
use mixdog_agent::text_only::assert_text_only_input;
use mixdog_agent::todo::TodoGuards;
use mixdog_agent::todo::TodoPhase;
use mixdog_agent::todo::TodoStatus;
use mixdog_agent::todo::TodoTask;
use mixdog_agent::todo::TodoView;
use mixdog_core_api::domain::cache_warm::cache_warm_request;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use tokio::sync::watch;

use super::*;

// ---------------------------------------------------------------------------
// Tool-call ids
// ---------------------------------------------------------------------------

fn tc(id: &str) -> ToolCall {
    ToolCall { id: id.into(), name: "t".into(), arguments: json!({}), native_type: None }
}

/// A round the history already holds: one assistant turn with the calls and a result for each.
fn answered(ids: &[&str]) -> Vec<AgentMessage> {
    let mut round = vec![AgentMessage::assistant("", ids.iter().map(|id| tc(id)).collect())];
    round.extend(ids.iter().map(|id| AgentMessage::tool_text(*id, "r", ToolKind::Normal)));
    round
}

fn ids_of(calls: &[ToolCall]) -> Vec<&str> {
    calls.iter().map(|call| call.id.as_str()).collect()
}

#[test]
fn an_id_the_history_already_answered_is_renamed_and_a_fresh_id_is_kept() {
    let mut ids = ToolCallIds::new(&answered(&["a"]));
    let (mut reused, mut fresh) = (tc("a"), tc("b"));
    ids.resolve(&mut reused);
    ids.resolve(&mut fresh);
    assert_eq!((reused.id.as_str(), fresh.id.as_str()), ("a-2", "b"));
}

#[test]
fn two_calls_of_one_batch_sharing_an_id_stay_distinct_with_or_without_history() {
    let mut batch = [tc("a"), tc("a")];
    ToolCallIds::new(&[]).resolve_all(&mut batch);
    assert_eq!(ids_of(&batch), ["a", "a-2"]);
    let mut batch = [tc("a"), tc("a")];
    ToolCallIds::new(&answered(&["a"])).resolve_all(&mut batch);
    assert_eq!(ids_of(&batch), ["a-2", "a-3"]);
}

#[test]
fn a_renamed_id_never_lands_on_another_call_of_the_batch_in_either_order() {
    let mut batch = [tc("a-2"), tc("a")];
    ToolCallIds::new(&answered(&["a"])).resolve_all(&mut batch);
    assert_eq!(ids_of(&batch), ["a-2", "a-3"]);
    let mut batch = [tc("a"), tc("a-2")];
    ToolCallIds::new(&answered(&["a"])).resolve_all(&mut batch);
    assert_eq!(ids_of(&batch), ["a-3", "a-2"]);
}

#[test]
fn the_calls_a_stream_finished_and_the_final_batch_get_the_same_ids() {
    let mut ids = ToolCallIds::new(&answered(&["a"]));
    let (mut first, mut second) = (tc("a"), tc("a"));
    ids.resolve(&mut first);
    ids.resolve(&mut second);
    let mut batch = [tc("a"), tc("a")];
    ids.resolve_all(&mut batch);
    assert_eq!((first.id.as_str(), second.id.as_str()), ("a-2", "a-3"));
    assert_eq!(ids_of(&batch), ["a-2", "a-3"], "the batch carries what the stream already handed out");
}

#[test]
fn a_call_without_an_id_is_left_without_one() {
    let (mut streamed, mut batch) = (tc(""), [tc(""), tc("x")]);
    let mut ids = ToolCallIds::new(&[]);
    ids.resolve(&mut streamed);
    ids.resolve_all(&mut batch);
    assert_eq!((streamed.id.as_str(), ids_of(&batch)), ("", vec!["", "x"]));
}

#[tokio::test]
async fn a_provider_that_reuses_a_call_id_in_every_turn_still_gets_each_result_back() {
    let round = |n: u32| turn(vec![call("c", "echo", json!({ "n": n })), done(StopReason::ToolUse)]);
    let h = Harness::new(vec![round(1), round(2), round(3), turn(vec![text("fin"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript),
        [
            "user:go",
            "assistant[echo#c]:",
            "tool#c(Normal):echo:{\"n\":1}",
            "assistant[echo#c-2]:",
            "tool#c-2(Normal):echo:{\"n\":2}",
            "assistant[echo#c-3]:",
            "tool#c-3(Normal):echo:{\"n\":3}",
        ]
    );
    assert_eq!(output.response.content, "fin");
}

// ---------------------------------------------------------------------------
// The output-limit ladder, refusal, provider continuations
// ---------------------------------------------------------------------------

const RESUME: &str = "[mixdog-runtime] Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where you left off, and break the remaining work into smaller pieces.";
const EXHAUSTED: &str = "[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts.";

fn cut(piece: &str) -> Attempt {
    turn(if piece.is_empty() { vec![done(StopReason::MaxTokens)] } else { vec![text(piece), done(StopReason::MaxTokens)] })
}

fn overrides(h: &Harness) -> Vec<Option<u32>> {
    h.provider.requests().iter().map(|r| r.options.max_output_tokens_override).collect()
}

#[tokio::test]
async fn an_empty_cut_escalates_once_without_a_nudge_then_resumes_three_times_then_ends_with_the_notice() {
    let h = Harness::new((0..5).map(|_| cut("")).collect());
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(8_000);
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, Some(8_000), None, None, None]);
    let lengths: Vec<usize> = h.provider.requests().iter().map(|r| r.messages.len()).collect();
    assert_eq!(lengths, [1, 1, 2, 3, 4], "the escalation appends nothing, each resume one prompt");
    assert_eq!(output.response.content, EXHAUSTED);
    assert_eq!(output.response.max_output_recovery_attempts, Some(3));
}

const ESCALATED: u32 = 128_000;

fn escalating() -> RunConfig {
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(ESCALATED);
    cfg
}

/// The higher limit is one-shot: only the send that follows the cut carries it, whatever becomes of that send (the request
/// building takes it off the run, `send.rs` `build_request`: "this attempt alone carries it"). A replay of the send, a
/// failure that ends the run and an abort all leave nothing behind for a later request.
#[tokio::test]
async fn a_replay_of_the_escalated_send_does_not_carry_the_higher_limit_again() {
    let mut incomplete = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    incomplete.code = Some("PROVIDER_INCOMPLETE".into());
    let h = Harness::new(vec![cut(""), Attempt::Reject(incomplete), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(escalating(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, Some(ESCALATED), None]);
    assert_eq!(output.response.content, "done");
}

#[tokio::test]
async fn an_error_on_the_escalated_send_leaves_no_higher_limit_for_a_later_run() {
    let h = Harness::new(vec![cut(""), rejection(ErrorKind::Auth, None), turn(vec![text("later"), done(StopReason::EndTurn)])]);
    let failure = h.run(escalating(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the error ends the run");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    let output = finish(h.run(escalating(), vec![], vec![AgentMessage::user("again")])).await;
    assert_eq!(overrides(&h), [None, Some(ESCALATED), None]);
    assert_eq!(output.response.content, "later");
}

#[tokio::test]
async fn an_abort_during_the_escalated_send_leaves_no_higher_limit_for_a_later_run() {
    let mut h = Harness::new(vec![cut(""), turn(vec![Step::Hang]), turn(vec![text("later"), done(StopReason::EndTurn)])]);
    let run = h.run(escalating(), vec![], vec![AgentMessage::user("go")]);
    let cancel = h.cancel.clone();
    let task = tokio::spawn(run.run());
    while h.provider.requests().len() < 2 {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(matches!(failure.error, AgentError::Aborted));
    h.cancel = CancellationToken::new();
    let output = finish(h.run(escalating(), vec![], vec![AgentMessage::user("again")])).await;
    assert_eq!(overrides(&h), [None, Some(ESCALATED), None]);
    assert_eq!(output.response.content, "later");
}

#[tokio::test]
async fn a_cut_with_no_higher_limit_available_goes_straight_to_the_resume_prompt() {
    let h = Harness::new(vec![cut("aa"), turn(vec![text("bb"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, None]);
    // The transcript holds the prompt as written; the wire carries it wrapped as a runtime-control message.
    let wire = wire_dump(&h.provider.requests()[1]);
    assert_eq!(wire[..2], ["User:go", "Assistant:aa"]);
    assert_eq!(wire.len(), 3);
    assert_eq!(wire[2], format!("User:<mixdog-runtime kind=\"runtime-control\">\n{RESUME}\n</mixdog-runtime>"));
    assert_eq!(dump(&output.transcript)[2], format!("user<MaxOutputRecovery>:{RESUME}"));
    assert_eq!(output.response.content, "aabb");
}

#[tokio::test]
async fn shown_text_the_owner_cannot_withdraw_is_not_escalated_over() {
    let mut h = Harness::new(vec![cut("aa"), turn(vec![text("bb"), done(StopReason::EndTurn)])]);
    h.observer = Observer::new(Retracted::Refused);
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(8_000);
    finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, None], "escalating would show the text twice");
    assert_eq!(h.provider.requests()[1].messages.len(), 3);
}

#[tokio::test]
async fn a_tool_call_turn_is_progress_and_gives_the_ladder_its_escalation_again() {
    let h = Harness::new(vec![
        cut("a"),
        cut("b"),
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        cut("c"),
        turn(vec![text("d"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(8_000);
    finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, Some(8_000), None, None, Some(8_000)]);
}

#[tokio::test]
async fn a_hidden_agent_cut_empty_at_the_limit_recovers_and_its_ordinary_empty_end_is_not_nudged() {
    let h = Harness::new(vec![cut(""), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.hidden_agent = true;
    cfg.escalated_max_output_tokens = Some(8_000);
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, Some(8_000)]);
    assert_eq!(output.response.content, "ok");

    let h = Harness::new(vec![turn(vec![done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.hidden_agent = true;
    finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(h.provider.requests().len(), 1, "no nudge request");
}

#[tokio::test]
async fn an_empty_pause_turn_is_nudged_as_an_incomplete_turn_and_never_escalated() {
    let h = Harness::new(vec![turn(vec![done(StopReason::Other("pause_turn".into()))]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(8_000);
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(overrides(&h), [None, None]);
    let dumped = dump(&output.transcript);
    let nudge = &dumped[1];
    assert!(nudge.starts_with("user:[mixdog-runtime] Empty incomplete turn (stopReason=pause_turn)."), "{nudge}");
}

#[tokio::test]
async fn a_refusal_keeps_its_narration_gets_one_policy_prompt_and_may_then_complete() {
    let h = Harness::new(vec![
        turn(vec![text("I cannot do that."), done(StopReason::Refusal)]),
        turn(vec![text("Here is a safe version."), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let dumped = dump(&output.transcript);
    assert_eq!(dumped[1], "assistant:I cannot do that.");
    assert!(dumped[2].starts_with("user<RefusalRecovery>:[mixdog-runtime] The previous completion was refused"), "{}", dumped[2]);
    assert_eq!(output.termination, None);
    assert_eq!(output.response.content, "I cannot do that.\n\nHere is a safe version.");
}

#[tokio::test]
async fn text_only_continuations_are_capped_and_the_last_text_is_the_answer() {
    let limit = config().continuation_no_tool_limit as usize;
    let pause = |n: usize| turn(vec![text(&format!("p{n}")), done(StopReason::Other("pause_turn".into()))]);
    let h = Harness::new((0..=limit).map(pause).collect());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.provider_continuations as usize, limit);
    assert_eq!(h.provider.requests().len(), limit + 1);
    assert!(output.response.content.ends_with(&format!("p{limit}")), "{}", output.response.content);
}

#[tokio::test]
async fn an_executed_tool_batch_resets_the_continuation_budget() {
    let limit = config().continuation_no_tool_limit as usize;
    let pause = |n: usize| turn(vec![text(&format!("p{n}")), done(StopReason::Other("pause_turn".into()))]);
    let mut script: Vec<Attempt> = (0..limit).map(pause).collect();
    script.push(turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]));
    script.extend((0..limit).map(pause));
    script.push(turn(vec![text("end"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.provider_continuations as usize, 2 * limit);
}

// ---------------------------------------------------------------------------
// The todo report
// ---------------------------------------------------------------------------

/// A todo list the `todo` tool closes whole.
struct List(Mutex<Vec<TodoPhase>>);

impl List {
    fn open(items: &[&str]) -> Arc<Self> {
        let tasks = items.iter().map(|item| TodoTask { content: (*item).into(), status: TodoStatus::Pending }).collect();
        Arc::new(Self(Mutex::new(vec![TodoPhase { tasks }])))
    }
}

#[async_trait]
impl TodoView for List {
    async fn phases(&self) -> Vec<TodoPhase> {
        self.0.lock().unwrap().clone()
    }
    async fn goal_active(&self) -> bool {
        false
    }
    async fn awaiting_background_work(&self) -> bool {
        false
    }
    async fn user_waiting(&self) -> bool {
        false
    }
    fn is_mutation(&self, _call: &ToolCall) -> bool {
        false
    }
    async fn genuine_prompt(&self) {}
}

struct CloseTodos(ToolSpec, Arc<List>);

#[async_trait]
impl Tool for CloseTodos {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        for phase in self.1.0.lock().unwrap().iter_mut() {
            phase.tasks.iter_mut().for_each(|task| task.status = TodoStatus::Completed);
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text("closed".into())], ..ToolOutput::default() })
    }
}

async fn with_todos(h: &Harness, list: &Arc<List>, tools: Vec<Arc<dyn Tool>>) -> Run {
    let guards = TodoGuards::new(list.clone(), false);
    guards.start_turn(true).await;
    let mut env = h.run_env();
    env.guards = Arc::new(guards);
    let names = tools.iter().map(|t| t.spec().name.clone()).collect();
    Run::new(
        env,
        h.cancel.clone(),
        h.provider.clone(),
        ToolSet::with_builtins(tools, names),
        h.tool_env(),
        config(),
        vec![AgentMessage::user("go")],
        RunCarry::default(),
    )
}

fn todo_tool(list: &Arc<List>) -> Arc<dyn Tool> {
    let mut spec = Echo::tool().spec().clone();
    spec.name = "todo".into();
    Arc::new(CloseTodos(spec, list.clone()))
}

#[tokio::test]
async fn an_empty_end_after_only_todo_bookkeeping_delivers_the_kept_answer_as_the_report() {
    let list = List::open(&["First", "Second"]);
    let h = Harness::new(vec![
        turn(vec![text("Credentials are missing."), done(StopReason::EndTurn)]),
        turn(vec![call("c1", "todo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![done(StopReason::EndTurn)]),
    ]);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list)]).await).await;
    assert_eq!(output.termination, None, "the answer already given is the reply");
    assert_eq!(output.response.report_content.as_deref().map(str::trim), Some("Credentials are missing."));
    assert_eq!(h.provider.requests().len(), 3, "no empty-turn nudge was sent");
}

#[tokio::test]
async fn an_answer_the_reminder_cut_short_is_not_delivered_before_the_next_answer() {
    let list = List::open(&["First", "Second"]);
    let h = Harness::new(vec![
        turn(vec![text("Status: done. Full report."), done(StopReason::EndTurn)]),
        turn(vec![call("c1", "todo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("Status: done. Nothing changed."), done(StopReason::EndTurn)]),
    ]);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list)]).await).await;
    let report = output.response.report_content.as_deref().unwrap_or(&output.response.content);
    assert_eq!(report.trim(), "Status: done. Nothing changed.");
}

fn report_of(output: &RunOutput) -> &str {
    output.response.report_content.as_deref().unwrap_or(&output.response.content)
}

#[tokio::test]
async fn a_runtime_notice_does_not_displace_the_answer_the_reminder_cut_short() {
    let list = List::open(&["First"]);
    let mut script = vec![turn(vec![text("The answer."), done(StopReason::EndTurn)]), turn(vec![call("c1", "todo", json!({})), done(StopReason::ToolUse)])];
    script.extend((0..4).map(|_| cut("")));
    let h = Harness::new(script);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list)]).await).await;
    assert_eq!(report_of(&output), format!("The answer.\n\n{EXHAUSTED}"));
}

#[tokio::test]
async fn text_from_an_earlier_recovery_attempt_replaces_the_answer_the_reminder_cut_short() {
    let list = List::open(&["First"]);
    let mut script = vec![
        turn(vec![text("The answer."), done(StopReason::EndTurn)]),
        turn(vec![call("c1", "todo", json!({})), done(StopReason::ToolUse)]),
        cut("Again, the "),
    ];
    script.extend((0..3).map(|_| cut("")));
    let h = Harness::new(script);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list)]).await).await;
    assert_eq!(report_of(&output), format!("Again, the \n\n{EXHAUSTED}"));
}

#[tokio::test]
async fn every_segment_of_an_answer_the_reminder_cut_short_is_left_out() {
    let list = List::open(&["First"]);
    let h = Harness::new(vec![
        cut("part one "),
        turn(vec![text("part two"), done(StopReason::EndTurn)]),
        turn(vec![call("c1", "todo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("Final."), done(StopReason::EndTurn)]),
    ]);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list)]).await).await;
    assert_eq!(report_of(&output).trim(), "Final.");
}

#[tokio::test]
async fn the_report_of_a_failed_turn_keeps_its_answers_in_order() {
    let list = List::open(&["First"]);
    let mut h = Harness::new(vec![
        turn(vec![text("A"), done(StopReason::EndTurn)]),
        turn(vec![text("    B"), done(StopReason::EndTurn)]),
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        rejection(ErrorKind::Auth, None),
    ]);
    h.hooks = Some(Arc::new(StopHook::new(1, "again")));
    let failure = with_todos(&h, &list, vec![todo_tool(&list), Echo::tool()]).await.run().await.expect_err("the request fails");
    assert_eq!(failure.carried_report, "A\n\n    B", "an indented block keeps its indentation");
}

#[tokio::test]
async fn an_empty_end_after_new_work_is_still_an_empty_turn() {
    let list = List::open(&["First"]);
    let mut script =
        vec![turn(vec![text("Credentials are missing."), done(StopReason::EndTurn)]), turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)])];
    script.extend((0..4).map(|_| turn(vec![done(StopReason::EndTurn)])));
    let h = Harness::new(script);
    let output = finish(with_todos(&h, &list, vec![todo_tool(&list), Echo::tool()]).await).await;
    assert_eq!(output.termination, Some(mixdog_agent::response::Termination::Empty));
}

// ---------------------------------------------------------------------------
// Turn caps and long turns
// ---------------------------------------------------------------------------

#[tokio::test]
async fn past_the_wrap_up_time_no_call_runs_and_the_next_request_forbids_tools() {
    let h =
        Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("wrapping up"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.limits = Some(TurnLimits { wrap_up_at_ms: Some(h.clock.now_ms() - 1), ..TurnLimits::default() });
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert!(dump(&output.transcript)[2].starts_with("tool#c1(Error):[turn-limit]"), "{:?}", dump(&output.transcript));
    assert_eq!(h.provider.requests()[1].options.tool_choice.as_deref(), Some("none"));
    assert_eq!(output.response.content, "wrapping up");
}

#[tokio::test]
async fn a_capped_turn_that_keeps_calling_tools_after_it_was_told_to_reply_ends_unrun() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"n": 1})), done(StopReason::ToolUse)]),
        turn(vec![call("c2", "echo", json!({"n": 2})), done(StopReason::ToolUse)]),
        turn(vec![text("never asked"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.limits = Some(TurnLimits { max_tool_calls: Some(1), ..TurnLimits::default() });
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(h.provider.requests().len(), 2, "the turn ends on the overrunning batch");
    // The total counts every call the model issued, the one answered unrun included (three rounds of three calls under a cap
    // of eight total nine).
    assert_eq!(output.tool_calls_total, 2);
    let dumped = dump(&output.transcript);
    assert_eq!(dumped.iter().filter(|line| line.starts_with("tool#c1(Normal)")).count(), 1, "the first call ran");
    assert!(dumped.iter().any(|line| line.starts_with("tool#c2(Error):[turn-limit]")), "{dumped:?}");
}

#[tokio::test]
async fn an_uncapped_turn_never_limits_its_calls() {
    let mut script: Vec<Attempt> = (0..6).map(|n| turn(vec![call(&format!("c{n}"), "echo", json!({ "n": n })), done(StopReason::ToolUse)])).collect();
    script.push(turn(vec![text("fin"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.tool_calls_total, 6);
    assert!(h.provider.requests().iter().all(|r| r.options.tool_choice.is_none()));
    assert!(dump(&output.transcript).iter().all(|line| !line.contains("[turn-limit]")));
}

#[tokio::test]
async fn productive_work_continues_past_two_hundred_iterations() {
    let mut script: Vec<Attempt> = (0..205).map(|n| turn(vec![call(&format!("c{n}"), "echo", json!({ "n": n })), done(StopReason::ToolUse)])).collect();
    script.push(turn(vec![text("fin"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!((output.iterations, output.response.content.as_str()), (206, "fin"));
}

#[tokio::test]
async fn every_request_of_a_turn_extends_the_one_before_it_unchanged() {
    let h = Harness::new(vec![
        turn(vec![text("one"), call("c1", "echo", json!({"n": 1})), done(StopReason::ToolUse)]),
        turn(vec![call("c2", "echo", json!({"n": 2})), done(StopReason::ToolUse)]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let sent: Vec<Vec<String>> = h.provider.requests().iter().map(|r| r.messages.iter().map(|m| format!("{m:?}")).collect()).collect();
    assert_eq!(sent.iter().map(Vec::len).collect::<Vec<_>>(), [1, 3, 5]);
    for pair in sent.windows(2) {
        assert_eq!(pair[1][..pair[0].len()], pair[0][..], "the sent prefix is not rewritten");
    }
}

// ---------------------------------------------------------------------------
// Dispatch: a call starts with its stream; edits, shell and the repeat guard
// ---------------------------------------------------------------------------

/// A tool that logs when a call starts and ends, can hold the call whose key it is given until opened, and can fail.
struct Logged {
    spec: ToolSpec,
    log: Arc<Mutex<Vec<String>>>,
    tick: watch::Sender<usize>,
    hold: Option<(String, watch::Receiver<bool>)>,
    fail: bool,
}

impl Logged {
    fn new(name: &str, log: &Arc<Mutex<Vec<String>>>, tick: &watch::Sender<usize>) -> Self {
        let mut spec = Echo::tool().spec().clone();
        spec.name = name.into();
        spec.annotations = ToolAnnotations::default();
        Self { spec, log: log.clone(), tick: tick.clone(), hold: None, fail: false }
    }
}

#[async_trait]
impl Tool for Logged {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let key = args["k"].as_str().unwrap_or("").to_owned();
        let name = &self.spec.name;
        self.log.lock().unwrap().push(format!("start {name}:{key}"));
        self.tick.send_modify(|n| *n += 1);
        if let Some((held, gate)) = &self.hold
            && *held == key
        {
            let _ = gate.clone().wait_for(|open| *open).await;
        }
        self.log.lock().unwrap().push(format!("end {name}:{key}"));
        if self.fail {
            return Err(ToolError::new(ToolErrorCode::Failed { reason: "failed".into() }, "Error: failed"));
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text("ok".into())], ..ToolOutput::default() })
    }
}

#[tokio::test]
async fn a_call_starts_while_its_reply_is_still_streaming() {
    let (log, (tick, _)) = (Arc::new(Mutex::new(Vec::new())), watch::channel(0usize));
    let tool: Arc<dyn Tool> = Arc::new(Logged::new("echo", &log, &tick));
    let h = Harness::new(vec![
        turn(vec![
            call("c1", "echo", json!({"k": "x"})),
            Step::Until(tick.subscribe(), 1, "the call to start before the reply ended"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "fin");
    assert_eq!(*log.lock().unwrap(), ["start echo:x", "end echo:x"]);
}

#[tokio::test]
async fn edits_of_one_file_run_one_at_a_time_while_another_file_does_not_wait() {
    let (log, (tick, _)) = (Arc::new(Mutex::new(Vec::new())), watch::channel(0usize));
    let (open, gate) = watch::channel(false);
    let mut edit = Logged::new("edit", &log, &tick);
    edit.hold = Some(("a1".into(), gate));
    let tool: Arc<dyn Tool> = Arc::new(edit);
    let on = |id: &str, file: &str, k: &str| call(id, "edit", json!({ "file_path": file, "k": k }));
    let h = Harness::new(vec![
        turn(vec![
            on("e1", "a.txt", "a1"),
            on("e2", "a.txt", "a2"),
            on("e3", "b.txt", "b1"),
            Step::Until(tick.subscribe(), 2, "the first edit of each file to start"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    let run = tokio::spawn(finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])));
    let mut seen = tick.subscribe();
    assert!(tokio::time::timeout(Duration::from_secs(30), seen.wait_for(|n| *n >= 2)).await.is_ok());
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let held = log.lock().unwrap().clone();
    assert!(held.contains(&"start edit:b1".to_owned()) && held.contains(&"end edit:b1".to_owned()), "{held:?}");
    assert!(!held.iter().any(|line| line == "start edit:a2"), "the second edit of a.txt waits for the first: {held:?}");
    open.send_replace(true);
    run.await.unwrap();
    let all = log.lock().unwrap().clone();
    let at = |line: &str| all.iter().position(|l| l == line).unwrap_or_else(|| panic!("{line} in {all:?}"));
    assert!(at("end edit:a1") < at("start edit:a2"));
}

#[tokio::test]
async fn a_shell_call_waits_for_the_edit_before_it_and_is_skipped_when_that_edit_failed() {
    for fail in [false, true] {
        let (log, (tick, _)) = (Arc::new(Mutex::new(Vec::new())), watch::channel(0usize));
        let mut edit = Logged::new("edit", &log, &tick);
        edit.fail = fail;
        let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(edit), Arc::new(Logged::new("shell", &log, &tick))];
        let h = Harness::new(vec![
            turn(vec![call("c1", "edit", json!({"file_path": "a.txt", "k": "e"})), call("c2", "shell", json!({"k": "s"})), done(StopReason::ToolUse)]),
            turn(vec![text("fin"), done(StopReason::EndTurn)]),
        ]);
        let output = finish(h.run(config(), tools, vec![AgentMessage::user("go")])).await;
        let dumped = dump(&output.transcript);
        let ran = log.lock().unwrap().clone();
        if fail {
            assert_eq!(ran, ["start edit:e", "end edit:e"], "the shell does not run");
            assert!(
                dumped
                    .iter()
                    .any(|l| l.starts_with("tool#c2(Skipped):[mutation-dependency-guard] `shell` skipped because earlier mutation call(s) failed: c1")),
                "{dumped:?}"
            );
        } else {
            assert_eq!(ran, ["start edit:e", "end edit:e", "start shell:s", "end shell:s"]);
        }
    }
}

#[tokio::test]
async fn an_identical_failing_call_is_not_run_again_after_three_failures_and_paths_are_compared_normalized() {
    let (log, (tick, _)) = (Arc::new(Mutex::new(Vec::new())), watch::channel(0usize));
    let mut probe = Logged::new("probe", &log, &tick);
    probe.fail = true;
    let spellings = ["a.txt", "./a.txt", "sub/../a.txt", "a.txt", "./a.txt"];
    let mut script: Vec<Attempt> = spellings
        .iter()
        .enumerate()
        .map(|(n, path)| turn(vec![call(&format!("c{n}"), "probe", json!({ "file_path": path })), done(StopReason::ToolUse)]))
        .collect();
    script.push(turn(vec![text("fin"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let output = finish(h.run(config(), vec![Arc::new(probe)], vec![AgentMessage::user("go")])).await;
    assert_eq!(log.lock().unwrap().iter().filter(|l| l.starts_with("start")).count(), 3, "the fourth and fifth spellings are one call");
    let dumped = dump(&output.transcript);
    for id in ["c3", "c4"] {
        let line = dumped.iter().find(|l| l.starts_with(&format!("tool#{id}("))).unwrap();
        assert!(line.contains("[repeat-failure-guard] Identical normalized `probe` call failed 3 times; not re-executed."), "{line}");
    }
}

#[tokio::test]
async fn a_failing_tool_does_not_stop_a_turn_that_never_gets_a_new_result() {
    let (log, (tick, _)) = (Arc::new(Mutex::new(Vec::new())), watch::channel(0usize));
    let mut probe = Logged::new("probe", &log, &tick);
    probe.fail = true;
    let mut script: Vec<Attempt> = (0..45).map(|n| turn(vec![call(&format!("c{n}"), "probe", json!({"k": "same"})), done(StopReason::ToolUse)])).collect();
    script.push(turn(vec![text("my own answer"), done(StopReason::EndTurn)]));
    let h = Harness::new(script);
    let output = finish(h.run(config(), vec![Arc::new(probe)], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "my own answer");
    assert_eq!(h.provider.requests().len(), 46);
}

// ---------------------------------------------------------------------------
// Arguments are coerced against the tool's own schema, a registry tool included
// ---------------------------------------------------------------------------

struct Office {
    spec: ToolSpec,
    received: Mutex<Vec<JsonValue>>,
}

#[async_trait]
impl Tool for Office {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.received.lock().unwrap().push(args);
        Ok(ToolOutput { parts: vec![ToolPart::Text("done".into())], ..ToolOutput::default() })
    }
}

struct OnlyRegistry(Arc<Office>);

impl mixdog_tools::policy::ToolResolver for OnlyRegistry {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        (name == self.0.spec.name).then(|| self.0.clone() as Arc<dyn Tool>)
    }
}

#[tokio::test]
async fn a_registry_tool_the_session_does_not_offer_gets_its_arguments_coerced_to_its_own_schema() {
    let mut spec = Echo::tool().spec().clone();
    spec.name = "office".into();
    spec.input_schema = json!({"type": "object", "properties": {
        "count": {"type": "integer"}, "design": {"type": "object"}, "note": {"type": "string"}, "other": {"type": "integer"}
    }});
    let office = Arc::new(Office { spec, received: Mutex::new(Vec::new()) });
    let h = Harness::new(vec![
        turn(vec![
            call("c1", "office", json!({"count": "3", "design": "{\"a\":1}", "note": "{\"x\":1}", "other": "3.5"})),
            call("c2", "ghost", json!({"count": "3"})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    let tools = ToolSet::new(Vec::new()).with_registry(Arc::new(OnlyRegistry(office.clone())), None);
    let run = Run::new(h.run_env(), h.cancel.clone(), h.provider.clone(), tools, h.tool_env(), config(), vec![AgentMessage::user("go")], RunCarry::default());
    let output = finish(run).await;
    assert_eq!(*office.received.lock().unwrap(), [json!({"count": 3, "design": {"a": 1}, "note": "{\"x\":1}", "other": "3.5"})]);
    let ghost = dump(&output.transcript).into_iter().find(|l| l.starts_with("tool#c2(")).unwrap();
    assert!(ghost.starts_with("tool#c2(Error)") && ghost.contains("ghost"), "{ghost}");
}

// ---------------------------------------------------------------------------
// An outage
// ---------------------------------------------------------------------------

fn unsent(fault: TransportFault) -> Attempt {
    Attempt::Reject(ProviderError::transport(fault, DeliveryState::NotSent))
}

/// The loop's own waits: the ones of 5 s and over (the provider row's are shorter).
fn laps(h: &Harness) -> Vec<Duration> {
    h.waiter.0.lock().unwrap().iter().copied().filter(|wait| *wait >= Duration::from_secs(5)).collect()
}

/// An unreachable network is not a provider fault: once the provider's own row (the first send and four retries) is spent the
/// loop replays on the connection row, 5, 10, 20 and 40 s then nine of 60 s (13 replays, about ten minutes of cover), and every
/// replay keeps the provider's spent row. The ladder ends with the connect failure itself.
#[tokio::test]
async fn an_unreachable_network_is_waited_out_on_the_connection_ladder_and_then_surfaces_as_itself() {
    for fault in [TransportFault::Connect { os_code: None }, TransportFault::Dns] {
        let h = Harness::with_policy((0..70).map(|_| unsent(fault.clone())).collect(), RetryPolicy::codex_default());
        let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the outage surfaces");
        assert!(matches!(&failure.error, AgentError::Provider(e) if e.transport == Some(fault.clone())), "{}", failure.error);
        assert_eq!(h.provider.requests().len(), 18, "{fault:?}: five provider attempts plus thirteen connection replays");
        let secs = |n: u64| Duration::from_secs(n);
        let mut ladder = vec![secs(5), secs(10), secs(20), secs(40)];
        ladder.extend(std::iter::repeat_n(secs(60), 9));
        assert_eq!(laps(&h), ladder, "{fault:?}");
    }
}

#[tokio::test]
async fn a_connection_reset_before_any_header_spends_the_provider_ladder_and_no_outage_lap() {
    let h = Harness::with_policy((0..8).map(|_| unsent(TransportFault::Reset)).collect(), RetryPolicy::codex_default());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the reset surfaces");
    assert!(matches!(&failure.error, AgentError::Provider(e) if e.transport == Some(TransportFault::Reset)));
    assert!(laps(&h).is_empty(), "{:?}", h.waiter.0.lock().unwrap());
    assert_eq!(h.provider.requests().len(), 5, "the first send and the four retries of the request row");
}

// ---------------------------------------------------------------------------
// The cache-break guard
// ---------------------------------------------------------------------------

fn system(text: &str) -> AgentMessage {
    AgentMessage::new(Message::new(Role::System, Content::Text(text.into())))
}

/// A run over `messages` whose breaks are collected, carrying the guard of the run before it.
async fn guarded(
    model: &str,
    tools: Vec<Arc<dyn Tool>>,
    messages: Vec<AgentMessage>,
    guard: Option<mixdog_agent::prefix_guard::Snapshot>,
    script: Vec<Attempt>,
) -> (Result<RunOutput, mixdog_agent::RunFailure>, Vec<serde_json::Map<String, JsonValue>>, usize) {
    let mut h = Harness::new(script);
    let breaks = Arc::new(CacheBreaks::default());
    h.failures = Some(breaks.clone());
    let names = tools.iter().map(|t| t.spec().name.clone()).collect();
    let carry = RunCarry { prefix_guard: guard, ..RunCarry::default() };
    let run = Run::new(
        h.run_env(),
        h.cancel.clone(),
        h.provider.clone(),
        ToolSet::with_builtins(tools, names),
        h.tool_env(),
        RunConfig::new(ThreadId::from("t"), TurnId::from("r"), model),
        messages,
        carry,
    );
    let ended = run.run().await;
    let records = breaks.0.lock().unwrap().clone();
    (ended, records, h.provider.requests().len())
}

fn reply() -> Vec<Attempt> {
    vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]
}

#[tokio::test]
async fn a_history_that_shrank_since_the_last_send_is_traced_and_refused_before_anything_is_sent() {
    let first = vec![system("rules"), AgentMessage::user("one"), AgentMessage::assistant("a", Vec::new()), AgentMessage::user("two")];
    let (ended, breaks, _) = guarded("m", vec![], first, None, reply()).await;
    assert!(breaks.is_empty(), "the first send has nothing to compare with");
    let guard = ended.unwrap_or_else(|f| panic!("{}", f.error)).carry.prefix_guard;
    let (ended, breaks, sent) = guarded("m", vec![], vec![system("rules"), AgentMessage::user("one")], guard, reply()).await;
    assert!(matches!(ended.err().map(|f| f.error), Some(AgentError::PrefixMutation(_))));
    assert_eq!(sent, 0);
    assert_eq!((breaks[0]["classification"].as_str(), breaks[0]["reason"].as_str()), (Some("unexpected"), Some("history_shrink")));
}

#[tokio::test]
async fn a_model_or_tool_change_between_sends_is_an_intentional_break_and_the_send_goes_on() {
    let first = vec![system("rules"), AgentMessage::user("one")];
    let (ended, _, _) = guarded("m", vec![], first.clone(), None, reply()).await;
    let guard = ended.unwrap_or_else(|f| panic!("{}", f.error)).carry.prefix_guard;
    let (ended, breaks, sent) = guarded("other-model", vec![], first.clone(), guard.clone(), reply()).await;
    assert!(ended.is_ok());
    assert_eq!(sent, 1);
    assert_eq!((breaks[0]["classification"].as_str(), breaks[0]["reason"].as_str()), (Some("intentional"), Some("model_changed")));
    let (ended, breaks, _) = guarded("m", vec![Echo::tool()], first, guard, reply()).await;
    assert!(ended.is_ok());
    assert_eq!(breaks[0]["reason"].as_str(), Some("tool_schema_changed"));
}

#[tokio::test]
async fn a_refused_image_is_not_replayed_so_no_rebaseline_is_traced() {
    let prompt = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("look".into(), None), ContentPart::Image(ImageSource::Url("u".into()))]));
    let script = vec![rejection(ErrorKind::ImageRejected, None), turn(vec![text("ok"), done(StopReason::EndTurn)])];
    let (ended, breaks, sent) = guarded("m", vec![], vec![system("rules"), prompt], None, script).await;
    assert!(ended.is_err(), "the rejection surfaces");
    assert_eq!(sent, 1);
    assert!(breaks.is_empty());
}

fn guard_options<'a>(intent: Option<&'a str>) -> GuardOptions<'a> {
    GuardOptions { provider: "anthropic", model: "m", intent, mutation_source: None }
}

fn tool(name: &str, deferred: bool) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: format!("{name}."), input_schema: json!({"type": "object"}), defer_loading: deferred, freeform: None }
}

#[test]
fn the_guard_tells_a_rewritten_message_from_a_shrunk_history_and_a_compaction_accepts_both() {
    let m = |text: &str| Message::new(Role::User, Content::Text(text.into()));
    let before = snapshot::<JsonValue>(&[m("a"), m("b")], &[], &[], "anthropic", "m");
    let rewritten = snapshot::<JsonValue>(&[m("a"), m("changed")], &[], &[], "anthropic", "m");
    let shrunk = snapshot::<JsonValue>(&[m("a")], &[], &[], "anthropic", "m");
    let told = compare(Some(&before), &rewritten, &guard_options(None)).unwrap();
    assert_eq!((told["classification"].as_str(), told["reason"].as_str(), told["index"].as_u64()), (Some("unexpected"), Some("message_prefix"), Some(1)));
    let told = compare(Some(&before), &shrunk, &guard_options(None)).unwrap();
    assert_eq!((told["classification"].as_str(), told["reason"].as_str(), told["index"].as_u64()), (Some("unexpected"), Some("history_shrink"), Some(1)));
    let told = compare(Some(&before), &rewritten, &guard_options(Some("manual_compaction"))).unwrap();
    assert_eq!((told["classification"].as_str(), told["reason"].as_str()), (Some("intentional"), Some("manual_compaction")));
    assert!(compare(Some(&before), &before, &guard_options(None)).is_none(), "an unchanged request is no break");
    assert!(compare(None, &before, &guard_options(None)).is_none(), "the first request has nothing to compare with");
}

#[test]
fn a_changed_prefix_names_what_changed_and_an_anthropic_deferred_tool_does_not_move_it() {
    let base = snapshot::<JsonValue>(&[], &[tool("a", false)], &[], "anthropic", "m");
    let other_model = snapshot::<JsonValue>(&[], &[tool("a", false)], &[], "anthropic", "n");
    let other_provider = snapshot::<JsonValue>(&[], &[tool("a", false)], &[], "openai", "m");
    let more_tools = snapshot::<JsonValue>(&[], &[tool("a", false), tool("b", false)], &[], "anthropic", "m");
    let reason =
        |next: &mixdog_agent::prefix_guard::Snapshot| compare(Some(&base), next, &guard_options(None)).map(|t| t["reason"].as_str().unwrap().to_owned());
    assert_eq!(reason(&other_model).as_deref(), Some("model_changed"));
    assert_eq!(reason(&other_provider).as_deref(), Some("provider_changed"));
    assert_eq!(reason(&more_tools).as_deref(), Some("tool_schema_changed"));
    let deferred = snapshot::<JsonValue>(&[], &[tool("a", false), tool("d", true)], &[], "anthropic", "m");
    assert_eq!(base.request_prefix_hash, deferred.request_prefix_hash, "a deferred tool loads later without moving the cache");
    let kept_elsewhere = snapshot::<JsonValue>(&[], &[tool("a", false), tool("d", true)], &[], "openai", "m");
    assert_ne!(snapshot::<JsonValue>(&[], &[tool("a", false)], &[], "openai", "m").request_prefix_hash, kept_elsewhere.request_prefix_hash);
}

// ---------------------------------------------------------------------------
// The kept request and the warm
// ---------------------------------------------------------------------------

fn korean_lead() -> RuleTailReminder {
    RuleTailReminder {
        context: TailContext { provider: "anthropic".into(), language: Some(TailLanguage { id: "ko".into(), name: "Korean".into() }), role: TailRole::Lead },
    }
}

const REMINDER: &str = "<system-reminder>Write all user-facing text in Korean.</system-reminder>";

#[test]
fn what_the_store_keeps_of_a_send_is_the_request_before_its_tail_reminder() {
    let reminder = korean_lead().text("claude-opus-5-5");
    assert_eq!(reminder.as_deref(), Some(REMINDER));
    let messages = vec![Message::new(Role::System, Content::Text("rules".into())), Message::new(Role::User, Content::Text("hi".into()))];
    let sent = mixdog_agent::wire_request("claude-opus-5-5", RequestOptions::default(), messages.clone(), reminder.as_deref(), vec![tool("a", false)]);
    assert_eq!(sent.messages.len(), 3);
    assert_eq!(sent.messages[2].source, Some(MessageSource::TailReminder));
    let kept = mixdog_agent::without_tail_reminder(&sent);
    assert_eq!(kept.messages, messages);
    assert_eq!(kept.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["a"]);
}

#[test]
fn a_cache_warm_replays_the_kept_messages_and_tools_with_the_reminder_of_its_moment_capped_at_one_token() {
    let messages = vec![Message::new(Role::User, Content::Text("hi".into()))];
    let kept = mixdog_agent::wire_request("claude-opus-5-5", RequestOptions::default(), messages.clone(), None, vec![tool("a", false)]);
    let warm = cache_warm_request(&mixdog_agent::with_tail_reminder(&kept, korean_lead().text("claude-opus-5-5").as_deref()));
    assert_eq!(warm.messages.len(), 2);
    assert_eq!(warm.messages[..1], messages[..]);
    assert_eq!(warm.messages[1].content, Content::Text(REMINDER.into()));
    assert_eq!(warm.messages[1].source, Some(MessageSource::TailReminder));
    assert_eq!(warm.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["a"]);
    assert_eq!(warm.options.max_output_tokens_override, Some(1));
    // A model with no reminder is warmed with the messages alone, and a request with no tools sends none.
    let bare = mixdog_agent::wire_request("claude-sonnet-4-5", RequestOptions::default(), messages.clone(), None, Vec::new());
    let warm = cache_warm_request(&mixdog_agent::with_tail_reminder(&bare, korean_lead().text("claude-sonnet-4-5").as_deref()));
    assert_eq!(warm.messages, messages);
    assert!(warm.tools.is_empty());
}

// ---------------------------------------------------------------------------
// The text-only check
// ---------------------------------------------------------------------------

struct Files;

#[async_trait]
impl MediaText for Files {
    async fn prepare_pdf_text(&self, messages: Vec<Message>) -> Result<Vec<Message>, Box<ProviderError>> {
        Ok(messages)
    }
    async fn prepare_for_route(&self, messages: Vec<Message>, _: mixdog_core_api::domain::provider::MediaSupport) -> Result<Vec<Message>, Box<ProviderError>> {
        Ok(messages)
    }
    fn text_form(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        Ok(matches!(part, ContentPart::File { .. }).then(|| "file text".to_owned()))
    }
}

fn model(supports_tools: Option<bool>) -> TextOnlyModel {
    TextOnlyModel { name: "local".into(), supports_tools }
}

fn parts(parts: Vec<ContentPart>) -> Vec<Message> {
    vec![Message::new(Role::User, Content::Parts(parts))]
}

fn image() -> ContentPart {
    ContentPart::Image(ImageSource::Url("u".into()))
}

fn file() -> ContentPart {
    ContentPart::File {
        source: mixdog_core_api::domain::provider::BinarySource::Base64("eA==".into()),
        mime_type: "text/plain".into(),
        filename: None,
        text: None,
    }
}

#[test]
fn an_image_is_never_replaced_by_text_and_the_text_around_it_stays() {
    // The text-only projection leaves the image in place: the route it takes refuses it by name before anything is sent.
    let sent = assert_text_only_input(&model(None), &Files, parts(vec![ContentPart::Text("see".into(), None), image()]), false, false).unwrap();
    assert_eq!(sent[0].content, Content::Parts(vec![ContentPart::Text("see".into(), None), image()]));
}

#[test]
fn a_stored_image_reference_is_left_for_the_route_and_a_file_with_a_text_form_is_input() {
    let stored = ContentPart::File {
        source: mixdog_core_api::domain::provider::BinarySource::AttachmentRef("a".repeat(64)),
        mime_type: "image/png".into(),
        filename: None,
        text: None,
    };
    let sent = assert_text_only_input(&model(None), &Files, parts(vec![stored.clone()]), false, false).unwrap();
    assert_eq!(sent[0].content, Content::Parts(vec![stored]));
    let sent = assert_text_only_input(&model(None), &Files, parts(vec![file()]), false, false).unwrap();
    assert_eq!(sent[0].content, Content::Parts(vec![ContentPart::Text("file text".into(), None)]));
}

#[test]
fn tools_on_a_model_that_cannot_use_them_and_an_effort_setting_are_refused_unsent() {
    let plain = || parts(vec![ContentPart::Text("hi".into(), None)]);
    let error = assert_text_only_input(&model(Some(false)), &Files, plain(), true, false).unwrap_err();
    assert_eq!(error.message, "[local-provider] local does not support the requested tool interface. Choose a tool-capable model.");
    assert!(assert_text_only_input(&model(None), &Files, plain(), true, false).is_ok(), "a model that does not say is tried");
    assert!(assert_text_only_input(&model(Some(true)), &Files, plain(), true, false).is_ok());
    let error = assert_text_only_input(&model(None), &Files, plain(), false, true).unwrap_err();
    assert_eq!(error.message, "[local-provider] reasoning-level controls are not configured for this model; remove the setting or choose another provider.");
}

// ---------------------------------------------------------------------------
// A spawn that pins its model
// ---------------------------------------------------------------------------

/// What the spawn resolves to for `args`, for an agent `worker` whose own route is `openai` / `gpt-5` at medium effort.
fn pinned(args: JsonValue) -> Result<(JsonValue, JsonValue), String> {
    let config = json!({ "presets": [{ "id": "mine", "provider": "openai", "model": "gpt-x" }] });
    let own = json!({ "provider": "openai", "model": "gpt-5", "effort": "medium" });
    let mut args = args;
    args["agent"] = json!("worker");
    mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(config.as_object().unwrap(), &args, &[own])
        .map(|spawn| (spawn.preset_name, spawn.preset))
}

#[test]
fn a_spawn_that_names_another_model_runs_on_it_alone_with_the_pickers_defaults_under_the_callers_asks() {
    let defaults = json!({ "effort": "high", "fast": true });
    let (name, preset) = pinned(json!({ "provider": "anthropic", "model": "opus", "modelDefaults": defaults })).unwrap();
    assert_eq!(name, "__direct__");
    assert_eq!(
        (&preset["id"], &preset["provider"], &preset["model"], &preset["effort"], &preset["fast"]),
        (&json!("__direct__"), &json!("anthropic"), &json!("opus"), &json!("high"), &json!(true))
    );
    assert!(preset.get("fallbacks").is_none() && preset.get("fallbackSource").is_none(), "the named model answers or the failure is the answer");
    let (_, asked) = pinned(json!({ "provider": "anthropic", "model": "opus", "modelDefaults": defaults, "effort": "low", "fast": false })).unwrap();
    assert_eq!((&asked["effort"], &asked["fast"]), (&json!("low"), &json!(false)));
    let (_, plain) = pinned(json!({ "provider": "anthropic", "model": "opus" })).unwrap();
    assert!(plain.get("effort").is_none());
    assert_eq!(plain["fast"], false);
    let (_, no_auto) = pinned(json!({ "provider": "anthropic", "model": "opus", "autoEffort": false })).unwrap();
    assert_eq!(no_auto["autoEffort"], false);
}

#[test]
fn a_pin_on_the_agents_own_model_keeps_the_agents_effort_unless_the_model_does_not_offer_it() {
    let (_, own) = pinned(json!({ "provider": "openai", "model": "gpt-5" })).unwrap();
    assert_eq!((&own["id"], &own["effort"]), (&json!("__direct__"), &json!("medium")), "a direct identity that keeps the agent's own effort");
    assert!(own.get("fallbackSource").is_none());
    let offered = json!({ "efforts": ["low", "high"], "effort": "high" });
    let (_, held) = pinned(json!({ "provider": "openai", "model": "gpt-5", "modelDefaults": offered })).unwrap();
    assert_eq!(held["effort"], "high", "medium is not offered: the model's default stands in");
    let (_, asked) = pinned(json!({ "provider": "openai", "model": "gpt-5", "effort": "low", "modelDefaults": offered })).unwrap();
    assert_eq!(asked["effort"], "low");
}

#[test]
fn a_pin_keeps_the_presets_name_when_one_is_given_and_half_a_pin_is_no_pin() {
    let (name, preset) = pinned(json!({ "provider": "anthropic", "model": "opus", "preset": "mine" })).unwrap();
    assert_eq!((name, &preset["id"]), (json!("mine"), &json!("__direct__")));
    let (name, preset) = pinned(json!({ "provider": "anthropic" })).unwrap();
    assert_eq!(
        (name, &preset["id"], &preset["model"]),
        (json!("AGENT WORKER"), &json!("agent-worker"), &json!("gpt-5")),
        "a provider without a model runs on the agent's route"
    );
}

// ---------------------------------------------------------------------------
// A cache miss told by the reported usage
// ---------------------------------------------------------------------------

/// Two sends of one session on `provider`: the first writes `10_000` tokens to the cache, the second reads `read` of them back.
/// Both are served by one roster account (the cache scope a reading compares within) and report Anthropic's raw cache
/// counters (a field that did not arrive is unknown, never zero). The session record carries the run's cache state
/// between the two. Returns the breaks traced.
async fn cache_reads(provider: &str, read: u64) -> Vec<serde_json::Map<String, JsonValue>> {
    let usage = |read: u64, write: u64| {
        let served = mixdog_core_api::domain::provider::AccountRouting { provider: provider.to_owned(), account_id: "acct".into(), session_account_id: None };
        let raw = json!({ "input_tokens": 10, "cache_read_input_tokens": read, "cache_creation_input_tokens": write });
        [
            Step::Event(StreamEvent::AccountRouting(served)),
            Step::Event(StreamEvent::Usage(mixdog_core_api::domain::provider::Usage {
                input_tokens: 10,
                cache_read_tokens: read,
                cache_write_tokens: write,
                raw: Some(raw),
                ..Default::default()
            })),
        ]
    };
    let mut header = serde_json::Map::new();
    header.insert("providerCacheOpts".into(), json!({ "cacheStrategy": { "messages": "5m" } }));
    let mut messages = vec![system("rules"), AgentMessage::user("one")];
    let mut guard = None;
    let mut traced = Vec::new();
    for (reply, step) in [(usage(0, 10_000), "first"), (usage(read, 0), "second")] {
        let steps = reply.into_iter().chain([text(step), done(StopReason::EndTurn)]).collect();
        let scripted = Arc::new(Scripted { id: ProviderId::from(provider), ..Arc::into_inner(Scripted::new(vec![turn(steps)])).expect("one owner") });
        let mut h = Harness { provider: scripted, ..Harness::new(Vec::new()) };
        let breaks = Arc::new(CacheBreaks::default());
        h.failures = Some(breaks.clone());
        let carry = RunCarry { prefix_guard: guard.take(), ..RunCarry::from_saved(&header) };
        let run = Run::new(
            h.run_env(),
            h.cancel.clone(),
            h.provider.clone(),
            ToolSet::with_builtins(Vec::new(), Vec::new()),
            h.tool_env(),
            config(),
            messages.clone(),
            carry,
        );
        let output = finish(run).await;
        header.extend(output.carry.to_saved());
        // The host saves the time of the send beside the carry.
        header.insert("lastProviderSendAt".into(), json!(h.clock.0.load(Ordering::SeqCst)));
        guard = output.carry.prefix_guard.clone();
        messages = output.transcript;
        messages.push(AgentMessage::assistant(step, Vec::new()));
        messages.push(AgentMessage::user("next"));
        traced = breaks.0.lock().unwrap().clone();
    }
    traced
}

#[tokio::test]
async fn a_send_that_reads_far_less_of_the_cache_than_the_last_one_held_is_traced_as_an_actual_miss() {
    let breaks = cache_reads("anthropic", 1_000).await;
    assert_eq!(breaks.len(), 1);
    let miss = &breaks[0];
    assert_eq!(
        (miss["classification"].as_str(), miss["reason"].as_str(), miss["source"].as_str()),
        (Some("unexpected"), Some("actual_cache_miss"), Some("provider_usage"))
    );
    assert_eq!((miss["cachedTokens"].as_u64(), miss["previousCachedPrefixTokens"].as_u64()), (Some(1_000), Some(10_000)));
    assert_eq!(miss["actualCacheMiss"], true);
}

#[tokio::test]
async fn a_smaller_drop_of_the_cache_read_and_a_provider_that_is_not_anthropic_trace_no_miss() {
    // Half of the held prefix is still read (the ratio) / the drop is under 4096 tokens: not a miss.
    assert!(cache_reads("anthropic", 5_000).await.is_empty());
    assert!(cache_reads("anthropic", 8_000).await.is_empty());
    assert!(cache_reads("openai", 1_000).await.is_empty());
}
