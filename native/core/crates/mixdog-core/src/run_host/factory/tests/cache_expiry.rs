use super::*;

/// The owner's rule through the production wiring: the second turn's request after a tool wait longer than the
/// transcript tail's five-minute lifetime is compacted before it goes out (the old tool output gone, the recent call and
/// result kept, a smaller body); the next immediate tool round reuses that write without compacting again; and the
/// same history inside the lifetime goes out whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_tool_wait_past_the_tail_lifetime_compacts_the_next_request_before_it_is_sent() {
    let (mut bodies, header) = tool_wait_turns(6 * 60_000).await;
    let summaries = bodies.pop().expect("the summary count");
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    // read the log → grep; its answer; now wait → list; after the wait; the immediate round after it.
    assert_eq!(bodies.len(), 5, "{text:#?}");
    // The old output is tool history, not conversation: the compaction moves it out by reference without a model summary,
    // and the round after it asks for none either.
    assert_eq!(summaries, json!(0), "no summary request");
    let (a, b, c) = (&text[2], &text[3], &text[4]);
    assert!(a.contains(OLD_PAYLOAD), "request A carries the old tool output");
    assert!(!b.contains(OLD_PAYLOAD), "request B was compacted before dispatch: {b}");
    assert!(b.contains("omitted or shortened to fit the tool-history budget"), "B carries the compaction's handoff reference: {b}");
    assert!(b.contains("now wait") && b.contains("toolu_c2") && b.contains("RECENT-RESULT"), "the recent call and its result are kept: {b}");
    assert!(serde_json::to_vec(&bodies[3]).unwrap().len() < serde_json::to_vec(&bodies[2]).unwrap().len(), "B is smaller than A");
    assert!(!c.contains(OLD_PAYLOAD) && c.contains("RECENT-RESULT") && c.contains("toolu_c3"), "the next round extends B without a second compaction: {c}");
    assert!(header.get("cacheTailBook").is_some_and(|book| !book.is_null()), "the book is persisted on the session: {header}");
}

/// The paired control: the same history and tool wait inside the tail's lifetime keeps the old tool output.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_tool_wait_inside_the_tail_lifetime_sends_the_transcript_whole() {
    let (mut bodies, _) = tool_wait_turns(60_000).await;
    assert_eq!(bodies.pop(), Some(json!(0)), "no summary");
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert_eq!(bodies.len(), 5, "{text:#?}");
    assert!(text[3].contains(OLD_PAYLOAD) && text[4].contains(OLD_PAYLOAD), "nothing was compacted: {text:#?}");
}

/// A fresh host after a persisted checkpoint judges the next request by the stored book: inside the tail's lifetime the
/// transcript goes out whole; past it (the restart drops the expired proof) it is compacted before the first send.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_fresh_host_judges_the_first_send_by_the_persisted_book() {
    let (bodies, _) = first_turn_then_restart(10_000, AfterRestart::Turn).await;
    let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
    assert!(first.contains(OLD_PAYLOAD) && first.contains("now wait"), "the persisted proof is live: sent whole");
    let (bodies, _) = first_turn_then_restart(6 * 60_000, AfterRestart::Turn).await;
    let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
    assert!(!first.contains(OLD_PAYLOAD) && first.contains("now wait"), "compacted before the first send after the restart: {first}");
}

/// A side question on a fresh host (no turn ran in this process) is judged through the gate its rebuilt request loads
/// from the header: the idle session's cold transcript is compacted first by the host's own manual pass
/// (`thread/compact/start`, the production compaction over the turns' compactor), and the question is then asked on the
/// request rebuilt from the compacted history — the old tool output gone, the stale body never sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_cold_side_question_compacts_the_idle_session_and_is_asked_on_the_rebuilt_request() {
    let (bodies, answer) = first_turn_then_restart(6 * 60_000, AfterRestart::SideQuestion).await;
    let answer = answer.expect("an answer");
    assert_eq!(answer["text"], "done", "the question was asked and answered: {answer}");
    assert_eq!(bodies.len(), 1, "one side request, and no stale one before it: {bodies:#?}");
    let sent = bodies[0]["messages"].to_string();
    assert!(sent.contains("what did the log say?"), "the side question rides the request: {sent}");
    assert!(!sent.contains(OLD_PAYLOAD), "the request was rebuilt from the compacted history: {sent}");
}
