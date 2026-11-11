//! The warm's decisions (`session/cache-warm.mjs`): the rule that says whether a warm pays, the
//! Wilson bound under it, the tier a response wrote, the usage that shows a rewrite, and what a
//! turn of the session is for the idle learning. Pure: every answer is a function of its
//! arguments. Times are epoch milliseconds in `f64`, as JavaScript holds them.

use serde_json::Value;

/// The refresh goes out this long before the entry's expiry, for both tiers.
pub const LEAD_MS: f64 = 60_000.0;
/// The idle stretch returns are learned over: 12 h after the session's last real call.
pub const IDLE_RETURN_WINDOW_MS: f64 = 12.0 * 60.0 * 60_000.0;
/// The period a session's idle gaps are kept and learned from: the last 7 days.
pub const IDLE_RETURN_LOOKBACK_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
pub const TTL_5M_MS: f64 = 5.0 * 60_000.0;
pub const TTL_1H_MS: f64 = 60.0 * 60_000.0;
/// z of a two-sided 95% normal interval.
const WILSON_Z_95: f64 = 1.959_963_984_540_054;
/// A write below this many tokens is prompt growth, never a rewrite.
const REWRITE_FLOOR_TOKENS: f64 = 4096.0;

/// One idle gap of a session: its start, its length, and whether it was cut at the window.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Gap {
    pub at: f64,
    pub ms: f64,
    pub censored: bool,
}

/// `wilsonLowerBound(hits, n)`: the lower bound of the 95% Wilson score interval.
pub fn wilson_lower_bound(hits: f64, n: f64) -> f64 {
    if n.is_nan() || n <= 0.0 || hits.is_nan() || hits <= 0.0 {
        return 0.0;
    }
    let p = hits / n;
    let z = WILSON_Z_95;
    let z2 = z * z;
    let centre = p + z2 / (2.0 * n);
    let spread = z * ((p * (1.0 - p)) / n + z2 / (4.0 * n * n)).sqrt();
    f64::max(0.0, (centre - spread) / (1.0 + z2 / n))
}

/// `sessionReturnChance(gaps, elapsedMs, withinMs)`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ReturnChance {
    pub idle: f64,
    pub returns: f64,
    pub p: f64,
}

pub fn session_return_chance(gaps: &[Gap], elapsed_ms: f64, within_ms: f64) -> ReturnChance {
    let (mut idle, mut returns) = (0.0, 0.0);
    for gap in gaps {
        if gap.ms.is_nan() || gap.ms <= elapsed_ms {
            continue;
        }
        idle += 1.0;
        if !gap.censored && gap.ms <= elapsed_ms + within_ms {
            returns += 1.0;
        }
    }
    ReturnChance { idle, returns, p: wilson_lower_bound(returns, idle) }
}

/// `warmRewrote(usage)`: a substantial rewrite with poor read coverage.
pub fn warm_rewrote(cached: f64, cache_write: f64) -> bool {
    cache_write >= REWRITE_FLOOR_TOKENS && cached < cache_write
}

/// `cacheEntryLapsed`: whether an entry last used at `touch_at` living `ttl_ms` has expired by the
/// time a warm sent at `now` reaches the provider (`latency_ms` later).
pub fn entry_lapsed(touch_at: f64, ttl_ms: f64, now: f64, latency_ms: Option<f64>) -> bool {
    let latency = latency_ms.filter(|l| !l.is_nan()).unwrap_or(0.0);
    touch_at + ttl_ms - now <= latency
}

/// `cacheWarmDelayMs(ttlMs)`: when a warm goes out after the last cache use.
pub fn warm_delay_ms(ttl_ms: f64) -> f64 {
    f64::max(1.0, ttl_ms - LEAD_MS)
}

/// The tiers of a session's `cacheStrategy`, as the strings the config holds.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct CacheStrategy {
    pub tools: Option<String>,
    pub system: Option<String>,
    pub tier3: Option<String>,
    pub messages: Option<String>,
}

impl CacheStrategy {
    /// `Some` for an object; each tier is its string or absent.
    pub fn from_value(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let tier = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self { tools: tier("tools"), system: tier("system"), tier3: tier("tier3"), messages: tier("messages") })
    }
}

fn tier_ms(tier: &str) -> Option<f64> {
    match tier {
        "5m" => Some(TTL_5M_MS),
        "1h" => Some(TTL_1H_MS),
        _ => None,
    }
}

/// `writtenCacheTtlMs(usage, cacheStrategy)`: the lifetime of the message-tail entry a response
/// wrote, or 0 when the usage does not prove it.
pub fn written_cache_ttl_ms(cache_write: f64, cache_write_1h: f64, strategy: Option<&CacheStrategy>) -> f64 {
    if cache_write.is_nan() || cache_write <= 0.0 {
        return 0.0;
    }
    let written_1h = f64::min(cache_write_1h, cache_write);
    let written_5m = cache_write - written_1h;
    if written_5m <= 0.0 {
        return TTL_1H_MS;
    }
    if written_1h <= 0.0 {
        return TTL_5M_MS;
    }
    let Some(strategy) = strategy else { return 0.0 };
    let Some(tail) = strategy.messages.as_deref().filter(|t| tier_ms(t).is_some()) else { return 0.0 };
    let asked = [&strategy.tools, &strategy.system, &strategy.tier3].iter().any(|other| other.as_deref() == Some(tail));
    if asked { 0.0 } else { tier_ms(tail).unwrap_or(0.0) }
}

/// Per-token dollars of a read, a write of the entry's tier and an output token; each unknown
/// price is `None`.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Prices {
    pub read: Option<f64>,
    pub write: Option<f64>,
    pub output: Option<f64>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Economics {
    pub warm_cost: f64,
    pub miss_cost: f64,
}

/// `cacheWarmEconomics(promptTokens, prices)`: `None` when the prompt size or any price is unknown.
pub fn warm_economics(prompt_tokens: f64, prices: &Prices) -> Option<Economics> {
    let known = |price: Option<f64>| price.filter(|v| v.is_finite() && *v >= 0.0);
    let (read, write, output) = (known(prices.read)?, known(prices.write)?, known(prices.output)?);
    if prompt_tokens.is_nan() || prompt_tokens <= 0.0 {
        return None;
    }
    Some(Economics { warm_cost: read * prompt_tokens + output, miss_cost: f64::max(0.0, (write - read) * prompt_tokens) })
}

/// What `planCacheWarm` reads.
pub struct PlanInput<'a> {
    pub now: f64,
    pub touch_at: f64,
    pub ttl_ms: f64,
    pub last_call_at: f64,
    pub gaps: &'a [Gap],
    pub prompt_tokens: f64,
    pub prices: Prices,
    pub latency_ms: Option<f64>,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Plan {
    /// Warm: `warms` further warms are what the return needs, `p` the chance of it.
    Warm { warms: f64, p: f64 },
    Stop(&'static str),
}

/// `planCacheWarm`: whether a warm sent at `now` pays off for the session.
pub fn plan_cache_warm(input: &PlanInput<'_>) -> Plan {
    let PlanInput { now, touch_at, ttl_ms, last_call_at, gaps, prompt_tokens, prices, latency_ms } = input;
    if last_call_at.is_nan() || *last_call_at <= 0.0 {
        return Plan::Stop("last real call unknown");
    }
    if (touch_at + ttl_ms).partial_cmp(&(last_call_at + IDLE_RETURN_WINDOW_MS)) != Some(std::cmp::Ordering::Less) {
        return Plan::Stop("idle time reaches the learned window");
    }
    if entry_lapsed(*touch_at, *ttl_ms, *now, *latency_ms) {
        return Plan::Stop("late timer");
    }
    let Some(economics) = warm_economics(*prompt_tokens, prices) else {
        return Plan::Stop("prompt size or cache prices unknown");
    };
    let interval = warm_delay_ms(*ttl_ms);
    let elapsed = now - last_call_at;
    if session_return_chance(gaps, elapsed, 0.0).idle == 0.0 {
        return Plan::Stop("no idle history this long");
    }
    let mut j = 1.0;
    while elapsed + j * interval <= IDLE_RETURN_WINDOW_MS {
        let p = session_return_chance(gaps, elapsed, j * interval).p;
        if p * economics.miss_cost > j * economics.warm_cost {
            return Plan::Warm { warms: j, p };
        }
        j += 1.0;
    }
    Plan::Stop("warms cost more than the expected miss")
}

/// What a turn of a session is for the idle learning.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TurnKind {
    /// A turn the runtime starts itself: neither return nor activity.
    System,
    /// A user's, a routine's, a webhook's, a heartbeat's or a sub-agent dispatch: a return.
    Return,
    /// A retry of a failed turn: no return.
    Continuation,
}

const ORIGIN_CHANNEL: &str = "channel";
const ORIGIN_AGENT_REPORT: &str = "agent-report";
const SYSTEM_TURN_SOURCES: [&str; 3] = ["goal-continuation", "goal-closeout", "task-notification"];

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `provenanceKind(source, origin)`.
fn provenance_kind(source: Option<&Value>, origin: Option<&Value>) -> TurnKind {
    if origin.and_then(Value::as_str) == Some(ORIGIN_CHANNEL) {
        return TurnKind::Return;
    }
    if origin.and_then(Value::as_str) == Some(ORIGIN_AGENT_REPORT) {
        return TurnKind::System;
    }
    match source.and_then(Value::as_str) {
        Some(source) if SYSTEM_TURN_SOURCES.contains(&source) => TurnKind::System,
        _ => TurnKind::Return,
    }
}

/// `failedTurnMessage(messages, input)`: the input message of the failed turn a retry reruns.
fn failed_turn_message<'a>(messages: Option<&'a Value>, input: &Value) -> Option<&'a Value> {
    let list = messages.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let end_index = list.iter().rposition(|item| item.get("role").and_then(Value::as_str) != Some("system"))?;
    let end = &list[end_index];
    let transcript_of = |item: &'a Value| item.get("meta").and_then(|m| m.get("transcript"));
    let completion = transcript_of(end).and_then(|t| t.get("completion"));
    if completion.and_then(|c| c.get("status")).and_then(Value::as_str) != Some("failed") {
        return None;
    }
    let retry_turn_id = input.get("retryTurnId");
    if truthy(retry_turn_id) && transcript_of(end).and_then(|t| t.get("messageId")) != retry_turn_id {
        return None;
    }
    if end.get("role").and_then(Value::as_str) == Some("user") {
        return Some(end);
    }
    let completion = completion?;
    let attempt_id = completion.get("attemptId").and_then(Value::as_str).unwrap_or("");
    let at = mixdog_js::to_number_of(completion.get("at"));
    let at = if at.is_nan() { 0.0 } else { at };
    for index in (0..end_index).rev() {
        let item = &list[index];
        let transcript = transcript_of(item).filter(|t| truthy(Some(t)));
        if truthy(transcript.and_then(|t| t.get("completion"))) {
            return None;
        }
        let Some(transcript) = transcript else { continue };
        if item.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let same = if truthy(transcript.get("attemptId")) {
            transcript.get("attemptId").and_then(Value::as_str) == Some(attempt_id)
        } else {
            at > 0.0 && mixdog_js::to_number_of(transcript.get("at")) == at
        };
        if same {
            return Some(item);
        }
    }
    None
}

/// `failedTurnProvenance(messages, input)`: the `{ source, origin }` of the failed turn a retry
/// input reruns; `None` when it cannot be resolved.
pub fn failed_turn_provenance(messages: Option<&Value>, input: &Value) -> Option<(Option<Value>, Option<Value>)> {
    if input.get("retryFailedTurn") != Some(&Value::Bool(true)) && !truthy(input.get("retryTurnId")) {
        return None;
    }
    let meta = failed_turn_message(messages, input)?.get("meta").filter(|m| truthy(Some(m)))?;
    if let Some(provenance) = meta.get("provenance").filter(|p| p.is_object() || p.is_array()) {
        return Some((provenance.get("source").cloned(), provenance.get("origin").cloned()));
    }
    let origin = meta.get("origin").filter(|o| matches!(o.as_str(), Some(ORIGIN_CHANNEL | ORIGIN_AGENT_REPORT))).cloned();
    let source = meta.get("source").filter(|s| s.as_str().is_some_and(|s| !s.is_empty())).cloned();
    Some((source, origin))
}

/// `cacheWarmTurnKind(input, messages)`.
pub fn turn_kind(input: &Value, messages: Option<&Value>) -> TurnKind {
    if input.get("retryFailedTurn") == Some(&Value::Bool(true)) || truthy(input.get("retryTurnId")) {
        let failed = failed_turn_provenance(messages, input);
        return match failed {
            Some((source, origin)) if provenance_kind(source.as_ref(), origin.as_ref()) == TurnKind::System => TurnKind::System,
            _ => TurnKind::Continuation,
        };
    }
    let source = match input.get("promptSource") {
        Some(Value::String(source)) => Some(Value::String(source.clone())),
        other => other.and_then(|s| s.get("source")).cloned(),
    };
    provenance_kind(source.as_ref(), input.get("promptOrigin"))
}

/// `cacheWarmingEnabled(config)`: config `promptCacheWarming`, default off.
pub fn warming_enabled(config: Option<&Value>) -> bool {
    config.and_then(|c| c.get("promptCacheWarming")) == Some(&Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/cache-warm/golden.json")).unwrap()
    }

    fn gap_of(value: &Value) -> Gap {
        Gap { at: value["at"].as_f64().unwrap(), ms: value["ms"].as_f64().unwrap(), censored: value["censored"] == json!(true) }
    }

    fn prices_of(value: &Value) -> Prices {
        let price = |key: &str| value.get(key).and_then(Value::as_f64);
        Prices { read: price("read"), write: price("write"), output: price("output") }
    }

    #[test]
    fn the_wilson_bound_and_the_return_chance_equal_nodes() {
        let golden = golden();
        for row in golden["pure"]["wilson"].as_array().unwrap() {
            let got = wilson_lower_bound(row["hits"].as_f64().unwrap(), row["n"].as_f64().unwrap());
            assert_eq!(got, row["bound"].as_f64().unwrap(), "{row}");
        }
        let gaps: Vec<Gap> = golden["pure"]["gaps"].as_array().unwrap().iter().map(gap_of).collect();
        for row in golden["pure"]["chance"].as_array().unwrap() {
            let got = session_return_chance(&gaps, row["elapsed"].as_f64().unwrap(), row["within"].as_f64().unwrap());
            assert_eq!((got.idle, got.returns, got.p), (row["idle"].as_f64().unwrap(), row["returns"].as_f64().unwrap(), row["p"].as_f64().unwrap()), "{row}");
        }
    }

    #[test]
    fn the_tier_a_response_wrote_the_rewrite_test_and_the_delay_equal_nodes() {
        let golden = golden();
        let num = |usage: &Value, key: &str| {
            let v = mixdog_js::to_number_of(usage.get(key));
            if v.is_nan() { 0.0 } else { v }
        };
        for row in golden["pure"]["rewrote"].as_array().unwrap() {
            let usage = &row["usage"];
            assert_eq!(warm_rewrote(num(usage, "cachedTokens"), num(usage, "cacheWriteTokens")), row["rewrote"].as_bool().unwrap(), "{row}");
        }
        for row in golden["pure"]["delay"].as_array().unwrap() {
            assert_eq!(warm_delay_ms(row["ttl"].as_f64().unwrap()), row["delay"].as_f64().unwrap(), "{row}");
        }
        for row in golden["pure"]["ttl"].as_array().unwrap() {
            let usage = &row["usage"];
            let strategy = CacheStrategy::from_value(&row["strategy"]);
            let got = written_cache_ttl_ms(num(usage, "cacheWriteTokens"), num(usage, "cacheWrite1hTokens"), strategy.as_ref());
            assert_eq!(got, row["ttl"].as_f64().unwrap(), "{row}");
        }
    }

    #[test]
    fn the_economics_and_the_plan_equal_nodes_for_every_recorded_input() {
        let golden = golden();
        for row in golden["pure"]["economics"].as_array().unwrap() {
            let got = warm_economics(row["tokens"].as_f64().unwrap(), &prices_of(&row["prices"]));
            match row["economics"].as_object() {
                None => assert_eq!(got, None, "{row}"),
                Some(e) => {
                    let got = got.unwrap_or_else(|| panic!("{row}"));
                    assert_eq!((got.warm_cost, got.miss_cost), (e["warmCost"].as_f64().unwrap(), e["missCost"].as_f64().unwrap()), "{row}");
                }
            }
        }
        let gaps_of = |value: &Value| -> Vec<Gap> { value.as_array().unwrap().iter().map(gap_of).collect() };
        for row in golden["pure"]["plan"].as_array().unwrap() {
            let input = &row["input"];
            let gaps = gaps_of(&input["gaps"]);
            let got = plan_cache_warm(&PlanInput {
                now: input["now"].as_f64().unwrap(),
                touch_at: input["touchAt"].as_f64().unwrap(),
                ttl_ms: input["ttlMs"].as_f64().unwrap(),
                last_call_at: input["lastCallAt"].as_f64().unwrap(),
                gaps: &gaps,
                prompt_tokens: input["promptTokens"].as_f64().unwrap(),
                prices: prices_of(&input["prices"]),
                latency_ms: input["latencyMs"].as_f64(),
            });
            let want = &row["plan"];
            match want.get("stop").and_then(Value::as_str) {
                Some(stop) => assert_eq!(got, Plan::Stop(Box::leak(stop.to_owned().into_boxed_str())), "{}", row["name"]),
                None => assert_eq!(got, Plan::Warm { warms: want["warms"].as_f64().unwrap(), p: want["p"].as_f64().unwrap() }, "{}", row["name"]),
            }
        }
    }

    #[test]
    fn a_turns_kind_equals_nodes_for_every_recorded_provenance() {
        let golden = golden();
        for row in golden["pure"]["turnKind"].as_array().unwrap() {
            let kind = match turn_kind(&row["input"], row.get("messages").filter(|m| !m.is_null())) {
                TurnKind::System => "system",
                TurnKind::Return => "return",
                TurnKind::Continuation => "continuation",
            };
            assert_eq!(kind, row["kind"].as_str().unwrap(), "{row}");
        }
        for row in golden["pure"]["enabled"].as_array().unwrap() {
            assert_eq!(warming_enabled(row.get("config").filter(|c| !c.is_null())), row["enabled"].as_bool().unwrap(), "{row}");
        }
    }
}
