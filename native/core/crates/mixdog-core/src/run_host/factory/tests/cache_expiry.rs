use super::*;

fn lead_auto_clear() -> Value {
    json!({ "enabled": true, "idleMs": 300_000, "minContextPercent": 10 })
}

fn subagent_turns(base_input_tokens: u64, payload_repeats: usize) -> CacheTurns {
    CacheTurns { owner: Some("agent"), auto: true, auto_clear: None, base_input_tokens, payload_repeats }
}

/// A delegated sub-agent through the production wiring: when its context is at least 10% of its compaction trigger, the
/// second turn's request after a tool wait longer than the transcript tail's five-minute lifetime is compacted before it
/// goes out (the old tool output gone, the recent call and result kept, a smaller body); the next immediate tool round
/// reuses that write without compacting again; and the same history inside the lifetime goes out whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_tool_wait_past_the_tail_lifetime_compacts_the_next_request_before_it_is_sent() {
    let (mut bodies, header) = tool_wait_turns(6 * 60_000, subagent_turns(20_000, 1_000)).await;
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

/// The paired control: the same sub-agent history and tool wait inside the tail's lifetime keeps the old tool output.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_tool_wait_inside_the_tail_lifetime_sends_the_transcript_whole() {
    let (mut bodies, _) = tool_wait_turns(60_000, subagent_turns(20_000, 1_000)).await;
    assert_eq!(bodies.pop(), Some(json!(0)), "no summary");
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert_eq!(bodies.len(), 5, "{text:#?}");
    assert!(text[3].contains(OLD_PAYLOAD) && text[4].contains(OLD_PAYLOAD), "nothing was compacted: {text:#?}");
}

/// A delegated sub-agent whose context is below 10% of its compaction trigger is never compacted because its cache
/// expired, even after a wait past the tail's lifetime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_small_subagent_below_ten_percent_is_not_compacted_when_cache_expires() {
    let (mut bodies, _) = tool_wait_turns(6 * 60_000, subagent_turns(10, 1_000)).await;
    assert_eq!(bodies.pop(), Some(json!(0)), "no summary");
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert_eq!(bodies.len(), 5, "{text:#?}");
    assert!(text[3].contains(OLD_PAYLOAD) && text[4].contains(OLD_PAYLOAD), "below 10% of trigger is never compacted on cache expiry: {text:#?}");
}

/// A fresh host after a persisted checkpoint judges a sub-agent's next request by the stored book: inside the tail's
/// lifetime the transcript goes out whole; past it (the restart drops the expired proof) it is compacted before the
/// first send when context is at least 10% of its compaction trigger.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_fresh_host_judges_the_first_send_by_the_persisted_book() {
    let (bodies, _) = first_turn_then_restart(10_000, AfterRestart::Turn, subagent_turns(20_000, 1_000)).await;
    let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
    assert!(first.contains(OLD_PAYLOAD) && first.contains("now wait"), "the persisted proof is live: sent whole");
    let (bodies, _) = first_turn_then_restart(6 * 60_000, AfterRestart::Turn, subagent_turns(20_000, 1_000)).await;
    let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
    assert!(!first.contains(OLD_PAYLOAD) && first.contains("now wait"), "compacted before the first send after the restart: {first}");
}

/// A cold side question on an idle Lead session answers on the session's transcript without compacting it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_cold_side_question_on_a_lead_session_answers_without_compacting() {
    let lead = CacheTurns { owner: None, auto: true, auto_clear: Some(lead_auto_clear()), base_input_tokens: 10, payload_repeats: 1_000 };
    let (bodies, answer) = first_turn_then_restart(6 * 60_000, AfterRestart::SideQuestion, lead).await;
    let answer = answer.expect("an answer");
    assert_eq!(answer["text"], "done", "the question was asked and answered: {answer}");
    assert_eq!(bodies.len(), 1, "one side request: {bodies:#?}");
    let sent = bodies[0]["messages"].to_string();
    assert!(sent.contains("what did the log say?"), "the side question rides the request: {sent}");
    assert!(sent.contains(OLD_PAYLOAD), "Lead side question does not compact on an expired cache: {sent}");
}

/// A small Lead chat (below 10% of its compaction trigger) left idle past both `idleMs` and the prompt-cache tail is
/// not compacted on the next send.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_small_idle_lead_chat_is_not_compacted_on_the_next_send() {
    let (bodies, _) = idle_lead_turns(10 * 60_000, 10, 1_000, lead_auto_clear()).await;
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert!(bodies.len() >= 3, "turn 1 and turn 2 ran: {text:#?}");
    assert!(text[2].contains(OLD_PAYLOAD) && text[2].contains("now wait"), "small idle Lead chat is sent whole without compacting: {text:#?}");
}

/// A large Lead chat (at least 10% of its compaction trigger) left idle past `idleMs` is compacted by idle auto-clear
/// before the next send starts. The old tool output stays under grep's offload threshold: an offloaded one leaves only
/// its preview, which no compaction reduces.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_large_idle_lead_chat_is_compacted_by_idle_auto_clear_before_the_next_send() {
    let (bodies, _) = idle_lead_turns(10 * 60_000, 20_000, 1_000, lead_auto_clear()).await;
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert!(bodies.len() >= 3, "turn 1 and turn 2 ran: {text:#?}");
    assert!(!text[2].contains(OLD_PAYLOAD), "large idle Lead chat was compacted before turn 2 started: {}", text[2]);
    assert!(text[2].contains("now wait"), "turn 2 runs on the compacted transcript: {}", text[2]);
}

/// A running Lead turn resuming after a long agent/tool wait past both `idleMs` and the cache tail is never compacted
/// between tool rounds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_expiry_a_lead_turn_resuming_after_a_long_agent_wait_is_not_compacted() {
    let lead = CacheTurns { owner: None, auto: true, auto_clear: Some(lead_auto_clear()), base_input_tokens: 20_000, payload_repeats: 4_000 };
    let (mut bodies, _) = tool_wait_turns(6 * 60_000, lead).await;
    assert_eq!(bodies.pop(), Some(json!(0)), "no summary");
    let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
    assert_eq!(bodies.len(), 5, "{text:#?}");
    assert!(text[2].contains(OLD_PAYLOAD), "request A carries the old tool output");
    assert!(text[3].contains(OLD_PAYLOAD) && text[4].contains(OLD_PAYLOAD), "Lead turn resuming after a long wait is not compacted mid-turn: {text:#?}");
}
