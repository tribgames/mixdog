//! A model response stream cut by a connection-level HTTP/2 error (`TransportFault::H2GoAway`: the connection ended, so every
//! stream on it failed with it) after the response was accepted. What the loop does with it follows what the stream had
//! exposed when it was cut: nothing shown is retried in place; shown output is replayed only once the owner withdrew it,
//! else the turn continues from the shown text (the product's owner offers no withdrawal); a tool input cut mid-stream is
//! replayed with the split-call notice; a call the stream dispatched never runs twice.

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

/// A cut tool input is decided before text continuation: text shown that the owner cannot withdraw ends the turn with the
/// cut's error, with no replay and no continuation that would drop the call.
#[tokio::test]
async fn shown_text_then_a_cut_tool_input_the_owner_cannot_withdraw_ends_the_turn() {
    let mut exposure = input_cut();
    exposure.text_emitted = true;
    let (h, provider) = product(vec![turn(vec![text("part"), Step::Fail(connection_cut(exposure))]), turn(vec![text("never"), done(StopReason::EndTurn)])]);
    let failure = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await.expect_err("the cut surfaces");
    assert!(matches!(failure.error, AgentError::Provider(ref error) if error.transport == Some(TransportFault::H2GoAway { code: 0 })));
    assert_eq!(provider.requests().len(), 1, "not replayed, not continued");
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
