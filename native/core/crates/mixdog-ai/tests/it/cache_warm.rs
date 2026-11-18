//! The prompt-cache warmer's decisions (does a warm pay, what a response wrote, what a turn of the session is for the
//! idle learning) and how a warm's response stream is read.

use std::collections::VecDeque;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::transport::link::BodyStream;
use mixdog_ai::warmer::plan::CacheStrategy;
use mixdog_ai::warmer::plan::Gap;
use mixdog_ai::warmer::plan::Plan;
use mixdog_ai::warmer::plan::PlanInput;
use mixdog_ai::warmer::plan::Prices;
use mixdog_ai::warmer::plan::TurnKind;
use mixdog_ai::warmer::plan::entry_lapsed;
use mixdog_ai::warmer::plan::plan_cache_warm;
use mixdog_ai::warmer::plan::session_return_chance;
use mixdog_ai::warmer::plan::turn_kind;
use mixdog_ai::warmer::plan::warm_delay_ms;
use mixdog_ai::warmer::plan::warm_economics;
use mixdog_ai::warmer::plan::warm_rewrote;
use mixdog_ai::warmer::plan::warming_enabled;
use mixdog_ai::warmer::plan::wilson_lower_bound;
use mixdog_ai::warmer::stream::WarmUsage;
use mixdog_ai::warmer::stream::read_cache_warm_stream;
use mixdog_core_api::domain::provider::TransportFault;
use serde_json::json;

fn near(got: f64, want: f64) {
    assert!((got - want).abs() < 1e-3, "{got} is not near {want}");
}

#[test]
fn the_wilson_lower_bound_is_a_cautious_estimate_that_grows_with_evidence() {
    assert_eq!(wilson_lower_bound(0.0, 10.0), 0.0, "no hit, no chance");
    assert_eq!(wilson_lower_bound(5.0, 0.0), 0.0, "no trial, no chance");
    assert_eq!(wilson_lower_bound(f64::NAN, 10.0), 0.0);
    near(wilson_lower_bound(10.0, 10.0), 0.7225);
    near(wilson_lower_bound(5.0, 10.0), 0.2366);
    assert!(wilson_lower_bound(100.0, 100.0) > wilson_lower_bound(10.0, 10.0), "more evidence, a higher bound");
    assert!(wilson_lower_bound(100.0, 100.0) < 1.0);
}

fn gap(ms: f64, censored: bool) -> Gap {
    Gap { at: 0.0, ms, censored }
}

#[test]
fn the_return_chance_counts_the_longer_gaps_and_those_of_them_that_ended_in_a_return_within_the_window() {
    let gaps = [gap(100.0, false), gap(150.0, false), gap(200.0, false), gap(300.0, true), gap(400.0, false), gap(f64::NAN, false)];
    let chance = session_return_chance(&gaps, 150.0, 100.0);
    assert_eq!((chance.idle, chance.returns), (3.0, 1.0), "only gaps longer than the elapsed idle count; a censored gap never returned; the window is closed at its end");
    assert_eq!(chance.p, wilson_lower_bound(1.0, 3.0));
    let none = session_return_chance(&gaps, 1000.0, 100.0);
    assert_eq!((none.idle, none.returns, none.p), (0.0, 0.0, 0.0));
    assert_eq!(session_return_chance(&gaps, 150.0, 250.0).returns, 2.0, "a wider window reaches 200 and 400, not the censored 300");
}

#[test]
fn a_warm_rewrote_only_when_a_substantial_write_was_not_matched_by_reads() {
    assert!(warm_rewrote(0.0, 4096.0));
    assert!(!warm_rewrote(0.0, 4095.0), "a small write is prompt growth");
    assert!(!warm_rewrote(5000.0, 5000.0), "reads covering the write");
    assert!(warm_rewrote(4999.0, 5000.0));
    assert!(!warm_rewrote(0.0, 0.0));
}

#[test]
fn a_cache_entry_has_lapsed_when_it_will_expire_before_the_warm_arrives() {
    assert!(!entry_lapsed(0.0, 300_000.0, 240_000.0, None));
    assert!(entry_lapsed(0.0, 300_000.0, 300_000.0, None), "expiring exactly now");
    assert!(entry_lapsed(0.0, 300_000.0, 240_000.0, Some(70_000.0)), "the warm's own latency counts");
    assert!(!entry_lapsed(0.0, 300_000.0, 240_000.0, Some(50_000.0)));
    assert!(!entry_lapsed(0.0, 300_000.0, 240_000.0, Some(f64::NAN)), "an unknown latency counts as none");
}

#[test]
fn a_warm_goes_out_a_minute_before_the_entry_expires_and_never_in_the_past() {
    assert_eq!(warm_delay_ms(300_000.0), 240_000.0);
    assert_eq!(warm_delay_ms(3_600_000.0), 3_540_000.0);
    assert_eq!(warm_delay_ms(30_000.0), 1.0);
}

fn strategy(value: serde_json::Value) -> Option<CacheStrategy> {
    CacheStrategy::from_value(&value)
}

#[test]
fn a_strategy_is_read_only_from_an_object() {
    assert_eq!(strategy(json!("5m")), None);
    assert_eq!(strategy(json!({ "messages": "5m" })).and_then(|s| s.messages), Some("5m".to_owned()));
}

#[test]
fn what_a_warm_costs_and_what_a_miss_would_cost_need_every_price_and_a_prompt_size() {
    let prices = Prices { read: Some(1.0), write: Some(3.0), output: Some(5.0) };
    let e = warm_economics(100.0, &prices).unwrap();
    assert_eq!((e.warm_cost, e.miss_cost), (105.0, 200.0), "a warm reads the prompt and writes an output; a miss rewrites it at the write price over the read price");
    assert_eq!(warm_economics(100.0, &Prices { read: Some(3.0), write: Some(1.0), output: Some(0.0) }).unwrap().miss_cost, 0.0, "a write cheaper than a read never costs more");
    for bad in [
        Prices { read: None, ..prices },
        Prices { write: None, ..prices },
        Prices { output: None, ..prices },
        Prices { read: Some(-1.0), ..prices },
        Prices { write: Some(f64::INFINITY), ..prices },
        Prices { output: Some(f64::NAN), ..prices },
    ] {
        assert_eq!(warm_economics(100.0, &bad), None, "{bad:?}");
    }
    assert_eq!(warm_economics(0.0, &prices), None);
    assert_eq!(warm_economics(f64::NAN, &prices), None);
}

const FIVE_MIN: f64 = 300_000.0;

fn plan_of(gaps: &[Gap], edit: impl FnOnce(&mut PlanInput<'_>)) -> Plan {
    let mut input = PlanInput {
        now: 241_000.0,
        touch_at: 1_000.0,
        ttl_ms: FIVE_MIN,
        last_call_at: 1_000.0,
        gaps,
        prompt_tokens: 1_000_000.0,
        prices: Prices { read: Some(1.0), write: Some(10.0), output: Some(5.0) },
        latency_ms: None,
    };
    edit(&mut input);
    plan_cache_warm(&input)
}

#[test]
fn a_warm_goes_ahead_when_the_chance_of_a_return_times_the_miss_outweighs_the_warms() {
    let gaps = vec![gap(400_000.0, false); 30];
    assert_eq!(plan_of(&gaps, |_| {}), Plan::Warm { warms: 1.0, p: wilson_lower_bound(30.0, 30.0) });
}

#[test]
fn a_return_that_is_only_likely_after_a_longer_wait_needs_that_many_warms() {
    let gaps = vec![gap(600_000.0, false); 30];
    assert_eq!(plan_of(&gaps, |_| {}), Plan::Warm { warms: 2.0, p: wilson_lower_bound(30.0, 30.0) }, "the return lies beyond the first warm's reach, within the second's");
}

#[test]
fn a_warm_is_refused_with_its_reason() {
    let gaps = vec![gap(400_000.0, false); 30];
    assert_eq!(plan_of(&gaps, |i| i.last_call_at = 0.0), Plan::Stop("last real call unknown"));
    assert_eq!(plan_of(&gaps, |i| i.touch_at = 1_000.0 + 12.0 * 3_600_000.0), Plan::Stop("idle time reaches the learned window"));
    assert_eq!(plan_of(&gaps, |i| i.now = 301_000.0), Plan::Stop("late timer"));
    assert_eq!(plan_of(&gaps, |i| i.prices.write = None), Plan::Stop("prompt size or cache prices unknown"));
    assert_eq!(plan_of(&[], |_| {}), Plan::Stop("no idle history this long"));
    assert_eq!(plan_of(&[gap(100.0, false)], |_| {}), Plan::Stop("no idle history this long"), "only shorter gaps than this idle");
    assert_eq!(
        plan_of(&gaps, |i| {
            i.prompt_tokens = 10.0;
            i.prices = Prices { read: Some(1.0), write: Some(1.1), output: Some(5.0) };
        }),
        Plan::Stop("warms cost more than the expected miss")
    );
    assert_eq!(plan_of(&vec![gap(400_000.0, true); 30], |_| {}), Plan::Stop("warms cost more than the expected miss"), "censored gaps never returned");
}

#[test]
fn a_users_routines_webhooks_and_channels_returns_to_the_session_but_the_runtimes_own_turns_do_not() {
    let kind = |input: serde_json::Value| turn_kind(&input, None);
    assert_eq!(kind(json!({})), TurnKind::Return);
    assert_eq!(kind(json!({"promptSource": "user"})), TurnKind::Return);
    assert_eq!(kind(json!({"promptSource": "goal-continuation"})), TurnKind::System);
    assert_eq!(kind(json!({"promptSource": "goal-closeout"})), TurnKind::System);
    assert_eq!(kind(json!({"promptSource": {"source": "task-notification"}})), TurnKind::System);
    assert_eq!(kind(json!({"promptOrigin": "agent-report"})), TurnKind::System);
    assert_eq!(kind(json!({"promptOrigin": "channel", "promptSource": "goal-continuation"})), TurnKind::Return, "a channel message is a return whatever its source");
}

fn failed_user_turn(provenance: serde_json::Value) -> serde_json::Value {
    json!([
        {"role": "system"},
        {"role": "user", "meta": {"transcript": {"completion": {"status": "failed"}}, "provenance": provenance}},
    ])
}

#[test]
fn a_retry_of_a_failed_turn_is_a_continuation_unless_the_failed_turn_was_the_runtimes_own() {
    let retry = json!({"retryFailedTurn": true});
    assert_eq!(turn_kind(&retry, Some(&failed_user_turn(json!({"source": "user"})))), TurnKind::Continuation);
    assert_eq!(turn_kind(&retry, Some(&failed_user_turn(json!({"source": "goal-continuation"})))), TurnKind::System);
    assert_eq!(turn_kind(&retry, None), TurnKind::Continuation, "no transcript to resolve");
    let not_failed = json!([{"role": "user", "meta": {"transcript": {"completion": {"status": "completed"}}, "provenance": {"source": "goal-continuation"}}}]);
    assert_eq!(turn_kind(&retry, Some(&not_failed)), TurnKind::Continuation);
    let by_meta = json!([{"role": "user", "meta": {"transcript": {"completion": {"status": "failed"}}, "origin": "agent-report"}}]);
    assert_eq!(turn_kind(&retry, Some(&by_meta)), TurnKind::System, "the older meta shape names origin and source directly");
}

#[test]
fn a_retry_by_turn_id_finds_its_failed_turn_by_message_id_or_by_the_attempt_that_failed() {
    let by_id = json!({"retryTurnId": "m1"});
    let turn = |id: &str| json!([{"role": "user", "meta": {"transcript": {"messageId": id, "completion": {"status": "failed"}}, "provenance": {"source": "goal-closeout"}}}]);
    assert_eq!(turn_kind(&by_id, Some(&turn("m1"))), TurnKind::System);
    assert_eq!(turn_kind(&by_id, Some(&turn("m2"))), TurnKind::Continuation, "another turn failed");
    let answered = |attempt: &str| {
        json!([
            {"role": "user", "meta": {"transcript": {"attemptId": "a1"}, "provenance": {"source": "task-notification"}}},
            {"role": "assistant", "meta": {"transcript": {"completion": {"status": "failed", "attemptId": attempt}}}},
        ])
    };
    let retry = json!({"retryFailedTurn": true});
    assert_eq!(turn_kind(&retry, Some(&answered("a1"))), TurnKind::System, "the prompt of the attempt that failed");
    assert_eq!(turn_kind(&retry, Some(&answered("a2"))), TurnKind::Continuation);
}

#[test]
fn warming_is_off_unless_the_config_says_true() {
    assert!(warming_enabled(Some(&json!({"promptCacheWarming": true}))));
    for config in [json!({"promptCacheWarming": false}), json!({"promptCacheWarming": "true"}), json!({"promptCacheWarming": 1}), json!({})] {
        assert!(!warming_enabled(Some(&config)), "{config}");
    }
    assert!(!warming_enabled(None));
}

struct Chunks(VecDeque<Bytes>);

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

fn frame(event: serde_json::Value) -> String {
    format!("data: {event}\n\n")
}

fn body(chunks: Vec<String>) -> Chunks {
    Chunks(chunks.into_iter().map(Bytes::from).collect())
}

struct Heard {
    usages: Vec<WarmUsage>,
    chunks: Vec<bool>,
}

async fn read(mut stream: Chunks) -> (Result<WarmUsage, mixdog_ai::warmer::stream::WarmFailure>, Heard) {
    let mut heard = Heard { usages: Vec::new(), chunks: Vec::new() };
    let (usages, chunks) = (&mut heard.usages, &mut heard.chunks);
    let result = read_cache_warm_stream(&mut stream, &mut |usage: &WarmUsage| usages.push(usage.clone()), &mut |reported| chunks.push(reported)).await;
    (result, heard)
}

fn start(usage: serde_json::Value) -> String {
    frame(json!({"type": "message_start", "message": {"usage": usage}}))
}

fn content() -> String {
    frame(json!({"type": "content_block_start", "index": 0}))
}

#[tokio::test]
async fn a_warm_stream_is_read_until_the_first_content_block_once_the_prefix_usage_is_known() {
    let usage = json!({"input_tokens": 10, "cache_read_input_tokens": 5000, "cache_creation_input_tokens": 200, "output_tokens": 1});
    let (result, heard) = read(body(vec![start(usage), content(), frame(json!({"type": "error", "error": {"type": "overloaded_error", "message": "never read"}}))])).await;
    let usage = result.expect("the warm succeeded");
    assert_eq!((usage.input, usage.cached, usage.cache_write, usage.output), (10.0, 5000.0, 200.0, 1.0));
    assert_eq!(usage.prompt_tokens, Some(5210.0), "input plus reads plus writes");
    assert_eq!(heard.usages.len(), 1, "usage is handed over as it arrives");
}

#[tokio::test]
async fn a_content_block_before_any_usage_does_not_end_the_read_and_message_stop_does() {
    let (result, heard) = read(body(vec![content(), frame(json!({"type": "message_delta", "usage": {"output_tokens": 7}})), content()])).await;
    let usage = result.unwrap();
    assert_eq!((usage.output, usage.prompt_tokens), (7.0, Some(0.0)), "the prompt is input, reads and writes: an output-only report has none");
    assert_eq!(heard.chunks, [false, true], "the idle watchdog hears each chunk that did not end the read, flagged once usage is known");
    let (stopped, _) = read(body(vec![frame(json!({"type": "message_stop"})), frame(json!({"type": "error", "error": {"message": "late"}}))])).await;
    assert_eq!(stopped.unwrap(), WarmUsage::default(), "stopped before any usage: all zero");
    let (ended, _) = read(body(vec![])).await;
    assert!(ended.is_ok(), "a body that just ends is not a failure");
}

#[tokio::test]
async fn a_later_report_replaces_only_the_fields_it_states_an_explicit_zero_included() {
    let first = start(json!({"input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 50, "output_tokens": 1}));
    let delta = frame(json!({"type": "message_delta", "usage": {"output_tokens": 30, "cache_read_input_tokens": 0, "input_tokens": null}}));
    let (result, heard) = read(body(vec![first, delta, frame(json!({"type": "message_stop"}))])).await;
    let usage = result.unwrap();
    assert_eq!((usage.input, usage.cached, usage.cache_write, usage.output), (10.0, 0.0, 50.0, 30.0));
    assert_eq!(usage.prompt_tokens, Some(60.0));
    assert_eq!(heard.usages.len(), 2);
}

#[tokio::test]
async fn the_one_hour_share_and_a_gateways_cost_are_read_when_stated_and_sane() {
    let usage = json!({"cache_creation_input_tokens": 5000, "cache_creation": {"ephemeral_1h_input_tokens": 2000}, "cost": 0.002});
    let (result, _) = read(body(vec![start(usage), frame(json!({"type": "message_stop"}))])).await;
    let usage = result.unwrap();
    assert_eq!((usage.cache_write_1h, usage.cost_usd), (Some(2000.0), Some(0.002)));
    for cost in [json!(-1), json!(""), json!(null), json!("x")] {
        let (result, _) = read(body(vec![start(json!({"input_tokens": 1, "cost": cost})), frame(json!({"type": "message_stop"}))])).await;
        assert_eq!(result.unwrap().cost_usd, None, "{cost}");
    }
}

#[tokio::test]
async fn an_error_event_fails_the_warm_with_its_text_and_the_usage_reported_before_it() {
    let error = frame(json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}));
    let (before, _) = read(body(vec![error.clone()])).await;
    let failure = before.expect_err("an error event fails the warm");
    assert_eq!(failure.message, "Anthropic cache warm SSE error overloaded_error: Overloaded");
    assert!(failure.usage.is_none(), "no usage was reported before it");
    assert!(failure.error.is_some(), "the classified error rides along for the lane and roster");
    let (after, _) = read(body(vec![start(json!({"input_tokens": 4})), error])).await;
    assert_eq!(after.expect_err("failed").usage.map(|u| u.input), Some(4.0), "an accounted warm still shows its usage");
    let (bare, _) = read(body(vec![frame(json!({"error": "boom"}))])).await;
    assert_eq!(bare.expect_err("failed").message, "Anthropic cache warm SSE error error: Anthropic SSE error");
}

#[tokio::test]
async fn frames_split_across_chunks_and_characters_split_inside_one_are_read_whole() {
    let whole = start(json!({"input_tokens": 3, "note": "한글"}));
    let bytes = whole.as_bytes();
    let cut = whole.find('한').unwrap() + 1;
    let chunks = vec![
        Bytes::copy_from_slice(&bytes[..10]),
        Bytes::copy_from_slice(&bytes[10..cut]),
        Bytes::copy_from_slice(&bytes[cut..]),
        Bytes::from(frame(json!({"type": "message_stop"}))),
    ];
    let (result, _) = read(Chunks(chunks.into())).await;
    assert_eq!(result.unwrap().input, 3.0);
    let (noise, _) = read(body(vec!["data: not json\n\n".to_owned(), ": comment\n\n".to_owned(), start(json!({"input_tokens": 2}))])).await;
    assert_eq!(noise.unwrap().input, 2.0, "a frame that is not JSON is skipped");
}
