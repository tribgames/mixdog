//! The `max_tokens` adjustment both Anthropic routes make after a context-overflow 400
//! (`adjustMaxTokensForContextOverflow`, anthropic-max-tokens-recovery.mjs): a 400 "input length and `max_tokens`
//! exceed context limit: A + B > C" is answered by shrinking `max_tokens` to what the context still has room for
//! (1000-token safety buffer, 3000-token floor, thinking budget + 1 minimum) and replaying; with less than the floor
//! available the error surfaces.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `FLOOR_OUTPUT_TOKENS`.
const FLOOR_OUTPUT_TOKENS: u64 = 3000;
/// `CONTEXT_SAFETY_BUFFER_TOKENS`.
const CONTEXT_SAFETY_BUFFER_TOKENS: u64 = 1000;

/// `OVERFLOW_RE`.
static OVERFLOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)").expect("a valid pattern"));

/// What the exact 400 reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Overflow {
    pub(super) input_tokens: u64,
    pub(super) max_tokens: u64,
    pub(super) context_limit: u64,
}

/// `parseMaxTokensContextOverflow`: the three numbers of the exact 400, else `None`.
pub(super) fn parse(status: Option<u16>, message: &str) -> Option<Overflow> {
    if status != Some(400) {
        return None;
    }
    let found = OVERFLOW.captures(message)?;
    let number = |at: usize| found[at].parse::<u64>().ok();
    Some(Overflow { input_tokens: number(1)?, max_tokens: number(2)?, context_limit: number(3)? })
}

/// `thinkingBudget`: the budget of an enabled thinking block, else 0.
fn thinking_budget(body: &Map<String, Value>) -> u64 {
    let Some(thinking) = body.get("thinking") else { return 0 };
    if thinking.get("type").and_then(Value::as_str) != Some("enabled") {
        return 0;
    }
    thinking.get("budget_tokens").and_then(Value::as_f64).filter(|budget| *budget > 0.0).map_or(0, |budget| budget as u64)
}

/// `adjustMaxTokensForContextOverflow`: `body` with `max_tokens` shrunk to fit the context the refusal (`status`,
/// `message`) reports, and that `max_tokens`. `None` when the refusal is another one, the body is not a JSON object or
/// less than the floor is available: the error then surfaces.
pub(super) fn adjust_for_context_overflow(body: &[u8], status: Option<u16>, message: &str) -> Option<(Vec<u8>, u64)> {
    let overflow = parse(status, message)?;
    let parsed: Map<String, Value> = serde_json::from_slice(body).ok()?;
    let available = overflow.context_limit.saturating_sub(overflow.input_tokens).saturating_sub(CONTEXT_SAFETY_BUFFER_TOKENS);
    if available < FLOOR_OUTPUT_TOKENS {
        return None;
    }
    let max = FLOOR_OUTPUT_TOKENS.max(available).max(thinking_budget(&parsed) + 1);
    Some((with_max_tokens(body, max)?, max))
}

/// `body` with `max_tokens` set to `max`, every other field in its place.
pub(super) fn with_max_tokens(body: &[u8], max: u64) -> Option<Vec<u8>> {
    let mut parsed: Map<String, Value> = serde_json::from_slice(body).ok()?;
    parsed.insert("max_tokens".into(), json!(max));
    serde_json::to_vec(&parsed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REFUSAL: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000, decrease input length or `max_tokens` and try again"}}"#;

    /// `parseMaxTokensContextOverflow`: the exact text under a 400 only.
    #[test]
    fn only_the_exact_400_is_read() {
        assert_eq!(parse(Some(400), REFUSAL), Some(Overflow { input_tokens: 190_000, max_tokens: 32_000, context_limit: 200_000 }));
        assert_eq!(parse(Some(413), REFUSAL), None);
        assert_eq!(parse(Some(400), "prompt is too long: 210000 tokens > 200000 maximum"), None);
    }

    /// `adjustMaxTokensForContextOverflow`: `max(FLOOR, limit - input - 1000, budget + 1)`, the other fields untouched.
    #[test]
    fn max_tokens_shrinks_to_the_room_left_and_never_below_the_thinking_budget() {
        let body = br#"{"model":"m","max_tokens":32000,"stream":true}"#;
        let (adjusted, max) = adjust_for_context_overflow(body, Some(400), REFUSAL).expect("room is left");
        assert_eq!(max, 9000);
        assert_eq!(adjusted, br#"{"model":"m","max_tokens":9000,"stream":true}"#);

        let thinking = br#"{"max_tokens":32000,"thinking":{"type":"enabled","budget_tokens":16000}}"#;
        assert_eq!(adjust_for_context_overflow(thinking, Some(400), REFUSAL).map(|(_, max)| max), Some(16_001));
        // A thinking block that is not `enabled` has no budget to keep.
        let adaptive = br#"{"max_tokens":32000,"thinking":{"type":"adaptive","budget_tokens":16000}}"#;
        assert_eq!(adjust_for_context_overflow(adaptive, Some(400), REFUSAL).map(|(_, max)| max), Some(9000));
    }

    /// Less than `FLOOR_OUTPUT_TOKENS` available: nothing is adjusted and the refusal surfaces.
    #[test]
    fn a_context_with_less_than_the_floor_left_is_not_replayed() {
        let tight = "input length and `max_tokens` exceed context limit: 197000 + 8000 > 200000";
        assert!(adjust_for_context_overflow(br#"{"max_tokens":8000}"#, Some(400), tight).is_none());
        let exact = "input length and `max_tokens` exceed context limit: 196000 + 8000 > 200000";
        assert_eq!(adjust_for_context_overflow(br#"{"max_tokens":8000}"#, Some(400), exact).map(|(_, max)| max), Some(3000));
    }
}
