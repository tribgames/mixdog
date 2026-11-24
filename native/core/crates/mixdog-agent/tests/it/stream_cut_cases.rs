use mixdog_core_api::domain::provider::ConnectionInfo;
use mixdog_core_api::domain::provider::Exposure;

use super::*;

/// The error a body read gives when the connection under the stream ended with a GOAWAY: accepted, typed, no code and no
/// message, with the connection it rode.
fn connection_cut(exposure: Exposure) -> ProviderError {
    let mut error = ProviderError::transport(TransportFault::H2GoAway { code: 0 }, DeliveryState::Accepted);
    error.exposure = exposure;
    error.connection = Some(ConnectionInfo { id: 7, protocol: "h2" });
    error
}

fn shown() -> Exposure {
    Exposure { text_emitted: true, ..Exposure::default() }
}

fn input_cut() -> Exposure {
    Exposure { tool_input_cut: true, ..Exposure::default() }
}

fn reasoning(piece: &str) -> Step {
    Step::Event(StreamEvent::ReasoningDelta(piece.into()))
}

/// A harness judged by the production decider whose owner can withdraw nothing, as the core's run host is
/// (`RunObserver::can_retract` is false there).
fn product(script: Vec<Attempt>) -> (Harness, Arc<Scripted>) {
    let (mut h, provider) = judged(script, RetryPolicy::codex_default());
    h.observer = Observer::new(Retracted::Refused);
    Arc::get_mut(&mut h.observer).expect("one owner").reset_channel = false;
    (h, provider)
}

/// The same with an owner that withdraws what was shown.
fn withdrawing(script: Vec<Attempt>) -> (Harness, Arc<Scripted>) {
    let (mut h, provider) = judged(script, RetryPolicy::codex_default());
    h.observer = Observer::new(Retracted::Withdrawn);
    (h, provider)
}

fn waits(h: &Harness) -> Vec<Duration> {
    h.waiter.0.lock().unwrap().clone()
}

/// The `reconnecting` stages the run showed, as (attempt, max).
fn reconnecting(h: &Harness) -> Vec<(u32, u32)> {
    h.observer
        .events()
        .into_iter()
        .filter_map(|event| match event {
            RunEvent::Stage(Stage::Reconnecting { attempt, max, .. }) => Some((attempt, max)),
            _ => None,
        })
        .collect()
}

fn notices(output: &RunOutput) -> usize {
    dump(&output.transcript).iter().filter(|line| line.starts_with("user<StreamCutRecovery>")).count()
}

#[tokio::test]
async fn a_cut_with_nothing_shown_is_retried_in_place_and_shows_reconnecting() {
    let (h, provider) = product(vec![turn(vec![Step::Fail(connection_cut(Exposure::default()))]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    assert_eq!(provider.requests().len(), 2, "one retry");
    let waited = waits(&h);
    assert_eq!(waited.len(), 1);
    assert!(waited[0] < Duration::from_secs(5), "the provider's in-place row, not the loop ladder: {waited:?}");
    assert_eq!(reconnecting(&h).len(), 1, "the stage is shown before the wait");
}

#[tokio::test]
async fn shown_reasoning_is_replayed_on_the_loop_ladder_with_no_withdrawal_asked() {
    let (h, provider) =
        product(vec![turn(vec![reasoning("thinking"), Step::Fail(connection_cut(shown()))]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(waits(&h), [Duration::from_secs(5)], "the first step of the loop's own ladder");
    assert_eq!(reconnecting(&h), [(1, 3)]);
}

#[tokio::test]
async fn shown_text_the_owner_cannot_withdraw_is_kept_and_continued_never_replayed() {
    let (h, _) = product(vec![turn(vec![text("part"), Step::Fail(connection_cut(shown()))]), turn(vec![text(" rest"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert!(output.response.content.starts_with("part"), "{}", output.response.content);
    assert!(waits(&h).is_empty(), "continued, not replayed");
    assert!(reconnecting(&h).is_empty());
}

#[tokio::test]
async fn shown_text_the_owner_withdrew_is_replayed_on_the_loop_ladder_without_repeating_it() {
    let (h, provider) = withdrawing(vec![turn(vec![text("part"), Step::Fail(connection_cut(shown()))]), turn(vec![text("whole"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "whole", "the dead attempt's text is not part of the turn");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(waits(&h), [Duration::from_secs(5)]);
    assert_eq!(reconnecting(&h), [(1, 3)]);
}

#[tokio::test]
async fn a_withdrawal_the_owner_refuses_ends_the_turn_and_nothing_is_replayed() {
    let (mut h, provider) = judged(
        vec![turn(vec![text("part"), Step::Fail(connection_cut(shown()))]), turn(vec![text("never"), done(StopReason::EndTurn)])],
        RetryPolicy::codex_default(),
    );
    h.observer = Observer::new(Retracted::Refused);
    // A channel that exists and refuses: the text stays, and the send fails rather than continue it.
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the refusal surfaces");
    assert!(matches!(failure.error, AgentError::Provider(ref error) if error.transport == Some(TransportFault::H2GoAway { code: 0 })));
    assert_eq!(provider.requests().len(), 1);
    assert!(waits(&h).is_empty());
}

#[tokio::test]
async fn a_cut_tool_input_is_replayed_with_the_split_call_notice_and_the_call_never_runs() {
    let (h, provider) = product(vec![turn(vec![Step::Fail(connection_cut(input_cut()))]), turn(vec![text("split"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.tool_calls_total, 0, "the half-streamed call is dropped unrun");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(notices(&output), 1, "the notice the model is told to split by");
    assert_eq!(waits(&h), [Duration::from_secs(5)]);
    assert_eq!(reconnecting(&h), [(1, 3)]);
}

#[tokio::test]
async fn reasoning_then_a_cut_tool_input_is_replayed_with_the_notice() {
    let mut exposure = input_cut();
    exposure.text_emitted = true;
    let (h, provider) =
        product(vec![turn(vec![reasoning("planning the write"), Step::Fail(connection_cut(exposure))]), turn(vec![text("split"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(notices(&output), 1);
    assert_eq!(waits(&h), [Duration::from_secs(5)]);
}

#[tokio::test]
async fn shown_text_then_a_cut_tool_input_the_owner_cannot_withdraw_is_kept_and_the_turn_continues() {
    let mut exposure = input_cut();
    exposure.text_emitted = true;
    let (h, provider) = product(vec![turn(vec![text("part"), Step::Fail(connection_cut(exposure))]), turn(vec![text("split"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "part\n\nsplit");
    assert_eq!(output.tool_calls_total, 0, "the cut call is dropped unrun");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(notices(&output), 1);
    assert!(dump(&output.transcript).iter().any(|line| line.contains("part")), "the shown text stays in the history");
    assert_eq!(waits(&h), [Duration::from_secs(5)]);
    assert_eq!(reconnecting(&h), [(1, 3)]);
}

#[tokio::test]
async fn progress_then_a_cut_tool_input_the_owner_cannot_withdraw_continues_the_turn() {
    let mut exposure = input_cut();
    exposure.text_emitted = true;
    let progress = Step::Event(StreamEvent::ProgressDelta("thinking about it".into()));
    let (h, provider) = product(vec![turn(vec![progress, Step::Fail(connection_cut(exposure))]), turn(vec![text("split"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "split");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(notices(&output), 1);
    assert_eq!(waits(&h), [Duration::from_secs(5)]);
}

/// Progress, then the blank text a model streams between its thinking and its next block, then a cut mid-stream: blank
/// text is no kept text. The attempt settles for display and is replayed on the loop's ladder, its thinking blocks go
/// with it, and neither an empty-turn nudge nor a blank or thinking-only assistant turn reaches the history or the
/// replay, for a hidden role either.
#[tokio::test]
async fn progress_then_blank_text_then_a_cut_keeps_nothing_and_is_replayed() {
    for hidden_agent in [false, true] {
        let mut cut = connection_cut(shown());
        cut.partial_thinking_blocks = vec![json!({ "type": "thinking", "thinking": "weighing", "signature": "sig-1" })];
        let progress = Step::Event(StreamEvent::ProgressDelta("thinking it over".into()));
        let (h, provider) = product(vec![turn(vec![progress, text("\n"), Step::Fail(cut)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let mut config = config();
        config.hidden_agent = hidden_agent;
        let output = finish(h.run(config, vec![], vec![AgentMessage::user("go")])).await;
        assert_eq!(output.response.content, "ok", "hidden {hidden_agent}");
        assert_eq!(dump(&output.transcript), ["user:go"], "hidden {hidden_agent}: nothing of the dead attempt is history");
        let requests = provider.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(wire_dump(&requests[1]), ["User:go"], "hidden {hidden_agent}: the replay is the request as it was");
        assert_eq!(waits(&h), [Duration::from_secs(5)], "hidden {hidden_agent}: the loop's own ladder");
        let settled = h.observer.events().iter().filter(|event| matches!(event, RunEvent::AttemptDisplaySettled)).count();
        assert_eq!(settled, 1, "hidden {hidden_agent}: the shown progress settles for display once");
    }
}

/// A reasoning mark with none of its text (a reasoning item opening, its text withheld) shows the owner nothing, though the
/// adapter calls the send unsafe for it: the cut is retried in place, with nothing to settle.
#[tokio::test]
async fn a_cut_after_a_reasoning_mark_alone_is_retried_in_place() {
    let mut cut = connection_cut(Exposure::default());
    cut.unsafe_to_retry = true;
    let mark = Step::Event(StreamEvent::Progress(mixdog_core_api::domain::provider::ProgressKind::Reasoning));
    let (h, provider) = product(vec![turn(vec![mark, Step::Fail(cut)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    assert_eq!(provider.requests().len(), 2, "one retry");
    let waited = waits(&h);
    assert_eq!(waited.len(), 1);
    assert!(waited[0] < Duration::from_secs(5), "the provider's in-place row, not the loop ladder: {waited:?}");
    assert!(!h.observer.events().iter().any(|event| matches!(event, RunEvent::AttemptDisplaySettled)), "nothing shown, nothing settled");
}

/// An attempt that showed progress and kept nothing settles for display as the loop decides so, before the backoff: a stop
/// in the wait finds it settled, and a ladder that ends settles every attempt it ran, the last one included.
#[tokio::test]
async fn shown_progress_settles_before_the_backoff_whatever_ends_the_attempt() {
    let progress = || Step::Event(StreamEvent::ProgressDelta("thinking it over".into()));
    let settled = |h: &Harness| h.observer.events().iter().filter(|event| matches!(event, RunEvent::AttemptDisplaySettled)).count();

    let (mut h, provider) = product(vec![turn(vec![progress(), Step::Fail(connection_cut(shown()))]), turn(vec![text("never"), done(StopReason::EndTurn)])]);
    let timer = Arc::new(HeldTimer::default());
    h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(timer.clone())));
    let task = tokio::spawn(h.run(config(), vec![], vec![AgentMessage::user("go")]).run());
    timer.waiting.notified().await;
    assert_eq!(settled(&h), 1, "settled before the wait ends");
    h.cancel.cancel();
    assert!(matches!(task.await.unwrap().expect_err("stopped in the wait").error, AgentError::Aborted));
    assert_eq!(provider.requests().len(), 1, "no replay after the stop");
    assert_eq!(settled(&h), 1);

    let script = (0..16).map(|_| turn(vec![progress(), Step::Fail(connection_cut(shown()))])).collect();
    let (h, provider) = product(script);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the cut surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(settled(&h), provider.requests().len(), "each dead attempt settles once, the one the ladder ended on too");
}

#[tokio::test]
async fn text_then_a_cut_after_a_dispatch_still_surfaces() {
    let mut exposure = input_cut();
    exposure.text_emitted = true;
    exposure.tool_dispatched = true;
    let (h, provider) = product(vec![turn(vec![text("part"), Step::Fail(connection_cut(exposure))]), turn(vec![text("never"), done(StopReason::EndTurn)])]);
    let failure = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await.expect_err("a dispatched call is a replay boundary");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(provider.requests().len(), 1);
    assert!(waits(&h).is_empty());
}

#[tokio::test]
async fn a_finished_call_before_a_cut_tool_input_runs_once_and_nothing_is_replayed() {
    let mut exposure = input_cut();
    exposure.tool_dispatched = true;
    let (h, provider) =
        product(vec![turn(vec![call("c1", "echo", json!({})), Step::Fail(connection_cut(exposure))]), turn(vec![text("fin"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.tool_calls_total, 1, "the dispatched call ran exactly once");
    assert_eq!(dump(&output.transcript).iter().filter(|line| line.starts_with("tool#c1")).count(), 1);
    assert_eq!(provider.requests().len(), 2, "the next request continues the turn; the cut one is not sent again");
    assert!(waits(&h).is_empty(), "continued, not replayed");
}

#[tokio::test]
async fn a_cut_after_a_dispatch_the_loop_holds_no_call_for_is_never_replayed() {
    for owner in [product, withdrawing] {
        let mut exposure = shown();
        exposure.tool_dispatched = true;
        let (h, provider) = owner(vec![turn(vec![text("part"), Step::Fail(connection_cut(exposure))]), turn(vec![text("never"), done(StopReason::EndTurn)])]);
        let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("a dispatched call is a replay boundary");
        assert!(matches!(failure.error, AgentError::Provider(_)));
        assert_eq!(provider.requests().len(), 1, "no second request");
        assert!(waits(&h).is_empty());
    }
}

#[tokio::test]
async fn a_cut_that_keeps_coming_ends_after_the_provider_row_without_the_loop_ladder() {
    let script = (0..8).map(|_| turn(vec![Step::Fail(connection_cut(Exposure::default()))])).collect();
    let (h, provider) = product(script);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the cut surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    let policy = RetryPolicy::codex_default();
    let retries = policy.midstream.schedule.max_retries as usize;
    assert_eq!(provider.requests().len(), retries + 1, "the in-place row, then the end (the provider's spent ladder is final)");
}
