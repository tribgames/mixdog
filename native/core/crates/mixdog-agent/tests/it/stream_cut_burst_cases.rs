//! A burst of connection-level cuts on a provider whose stream ladder leaves a spent cut to the loop
//! (`RetryPolicy::stream_cut_loop_replay`, the Anthropic routes): the loop replays such a send on its transport ladder
//! (5, 15, 30 s), and a replay does not refill the stream row the first send spent. A response the loop proceeds with, a
//! salvaged one included, ends the outage the budgets covered.

use mixdog_core_api::domain::provider::ConnectionInfo;
use mixdog_core_api::domain::provider::Exposure;

use super::*;

/// The stream row of the Anthropic policy in count (3 retries) on the default shape, with the loop replay of a spent cut.
fn cut_replaying() -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.midstream.schedule.max_retries = 3;
    policy.stream_cut_loop_replay = true;
    policy
}

/// The body read's error once the shared connection under the stream ended: accepted, typed, with no message.
fn cut(exposure: Exposure) -> ProviderError {
    let mut error = ProviderError::transport(TransportFault::H2GoAway { code: 0 }, DeliveryState::Accepted);
    error.exposure = exposure;
    error.connection = Some(ConnectionInfo { id: 7, protocol: "h2" });
    error
}

fn cut_attempt() -> Attempt {
    turn(vec![Step::Fail(cut(Exposure::default()))])
}

fn waits(h: &Harness) -> Vec<Duration> {
    h.waiter.0.lock().unwrap().clone()
}

/// The loop's own waits: the transport row's steps, never below 5 s; the stream row's are below it.
fn loop_waits(h: &Harness) -> Vec<Duration> {
    waits(h).into_iter().filter(|wait| *wait >= Duration::from_secs(5)).collect()
}

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

/// A burst longer than the stream row: the fourth cut in a row spends it, the loop waits its first transport step, and the
/// replay completes.
#[tokio::test]
async fn a_burst_that_outlasts_the_stream_row_is_carried_by_the_loop_transport_row() {
    let mut script: Vec<Attempt> = (0..4).map(|_| cut_attempt()).collect();
    script.push(turn(vec![text("ok"), done(StopReason::EndTurn)]));
    let (h, provider) = judged(script, cut_replaying());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    assert_eq!(provider.requests().len(), 5, "three in place, then the loop's replay");
    assert_eq!(waits(&h).len(), 4);
    assert_eq!(loop_waits(&h), [Duration::from_secs(5)], "the first transport step, after the stream row's three");
    assert_eq!(reconnecting(&h), [(1, 3), (2, 3), (3, 3), (1, 3)], "the stream row's three, then the loop's first of three");
}

/// Cuts that never stop: the first send spends the stream row (4 attempts), the loop replays three times on 5, 15 and 30 s
/// with one attempt each, and the cut then surfaces as itself. Each failed attempt is named in the daemon log with its fault and connection.
#[tokio::test]
async fn a_spent_budget_surfaces_the_cut_after_every_send_ran_its_stream_row() {
    let (lines, _capture) = mixdog_rt::node_log::capture();
    let (h, provider) = judged((0..20).map(|_| cut_attempt()).collect(), cut_replaying());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the cut surfaces once spent");
    assert!(matches!(failure.error, AgentError::Provider(ref error) if error.transport == Some(TransportFault::H2GoAway { code: 0 })));
    // The replays do not refill the provider's spent stream row (the loop's escalation only changes the schedule): the
    // first send's four attempts, then one attempt per replay.
    assert_eq!(provider.requests().len(), 7, "four attempts, then three replays of one");
    assert_eq!(loop_waits(&h), [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30)]);
    assert_eq!(waits(&h).len(), 6);
    let attempts: Vec<String> = lines
        .lock()
        .unwrap()
        .iter()
        .map(|(_, _, line)| line.clone())
        .filter(|line| line.starts_with("[attempt-error] "))
        .collect();
    assert_eq!(attempts.len(), 7, "one line per failed attempt");
    for line in &attempts {
        assert!(line.contains(" phase=stream ") && line.contains(" delivery=Accepted "), "{line}");
        // The daemon log appends the turn's trace identity (session, turn, send, attempt, phase) to every line.
        assert!(line.contains(" fault=H2GoAway { code: 0 } connection=h2/7 session=t turn=r send="), "{line}");
    }
}

/// A cut that left a finished tool call is salvaged: the call runs once and the turn goes on. That response is progress,
/// so the next send has the whole stream row again however much the salvaged send had spent: three more cuts in a row are
/// still retried in place, with no wait of the loop.
#[tokio::test]
async fn a_salvaged_response_gives_the_next_send_its_whole_budget() {
    let script = vec![
        cut_attempt(),
        cut_attempt(),
        turn(vec![call("c1", "echo", json!({})), Step::Fail(cut(Exposure { tool_dispatched: true, ..Exposure::default() }))]),
        cut_attempt(),
        cut_attempt(),
        cut_attempt(),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ];
    let (h, provider) = judged(script, cut_replaying());
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "fin");
    assert_eq!(output.tool_calls_total, 1, "the salvaged call ran once");
    assert_eq!(provider.requests().len(), 7);
    assert_eq!(waits(&h).len(), 5, "two in-place retries before the salvage, three after it");
    assert!(loop_waits(&h).is_empty(), "the stream row was whole again after the salvage: {:?}", waits(&h));
}

/// The same burst on a provider whose spent stream row ends its recovery (the default) surfaces after the row, as before.
#[tokio::test]
async fn without_the_loop_replay_a_spent_stream_row_ends_the_send() {
    let mut policy = cut_replaying();
    policy.stream_cut_loop_replay = false;
    let (h, provider) = judged((0..8).map(|_| cut_attempt()).collect(), policy);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the cut surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(provider.requests().len(), 4);
    assert!(loop_waits(&h).is_empty());
}
