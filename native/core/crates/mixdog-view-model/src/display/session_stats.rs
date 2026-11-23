//! `ui/session-stats.mjs`: the session-usage accumulator a surface folds `onUsageDelta` events into.

use mixdog_js::json_number;
use serde_json::Map;
use serde_json::Value;

use super::coerce::field;
use super::coerce::finite_or_zero;
use super::coerce::truthy;

/// `createSessionStats()`: the running totals and the latest call.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SessionStats {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_tokens: f64,
    pub cache_write_tokens: f64,
    pub prompt_tokens: f64,
    pub latest_input_tokens: f64,
    pub latest_output_tokens: f64,
    pub latest_cached_tokens: f64,
    pub latest_cache_write_tokens: f64,
    pub latest_prompt_tokens: f64,
    pub cost_usd: f64,
    pub turns: f64,
}

impl SessionStats {
    /// `createSessionStats()`.
    pub fn new() -> Self {
        Self::default()
    }

    /// `applyUsageDelta(stats, delta)`: folds one usage event in (an absent delta is an empty one, which zeroes the latest call; a
    /// falsy one changes nothing). `delta` carries `deltaInput`, `deltaOutput`,
    /// `deltaCachedRead`, `deltaCacheWrite`, `deltaPrompt` and `costUsd`; a field that is missing or not a finite number
    /// counts 0. The engine's `costUsd` is per call, so the per-turn deltas are summed.
    pub fn apply_usage_delta(&mut self, delta: Option<&Value>) {
        let empty = Value::Object(Map::new());
        let delta = match delta {
            None => &empty,
            Some(delta) if truthy(Some(delta)) => delta,
            Some(_) => return,
        };
        let delta = Some(delta);
        let input = finite_or_zero(field(delta, "deltaInput"));
        let output = finite_or_zero(field(delta, "deltaOutput"));
        let cached = finite_or_zero(field(delta, "deltaCachedRead"));
        let cache_write = finite_or_zero(field(delta, "deltaCacheWrite"));
        let prompt = finite_or_zero(field(delta, "deltaPrompt"));
        self.input_tokens += input;
        self.output_tokens += output;
        self.cached_tokens += cached;
        self.cache_write_tokens += cache_write;
        self.prompt_tokens += prompt;
        self.latest_input_tokens = input;
        self.latest_output_tokens = output;
        self.latest_cached_tokens = cached;
        self.latest_cache_write_tokens = cache_write;
        // A delta that bills several model calls at once counts their sum as its prompt; the prompt of the latest
        // call is the one it measured the context on, where it states one.
        self.latest_prompt_tokens = match field(delta, "contextPromptTokens").filter(|stated| !stated.is_null()) {
            Some(stated) => finite_or_zero(Some(stated)),
            None => prompt,
        };
        self.cost_usd += finite_or_zero(field(delta, "costUsd"));
    }

    /// The object Node's accumulator is.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in [
            ("inputTokens", self.input_tokens),
            ("outputTokens", self.output_tokens),
            ("cachedTokens", self.cached_tokens),
            ("cacheWriteTokens", self.cache_write_tokens),
            ("promptTokens", self.prompt_tokens),
            ("latestInputTokens", self.latest_input_tokens),
            ("latestOutputTokens", self.latest_output_tokens),
            ("latestCachedTokens", self.latest_cached_tokens),
            ("latestCacheWriteTokens", self.latest_cache_write_tokens),
            ("latestPromptTokens", self.latest_prompt_tokens),
            ("costUsd", self.cost_usd),
            ("turns", self.turns),
        ] {
            map.insert(key.to_owned(), json_number(value));
        }
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_new_accumulator_is_all_zero() {
        let value = SessionStats::new().to_value();
        assert_eq!(value["inputTokens"], json!(0));
        assert_eq!(value["turns"], json!(0));
        assert_eq!(value.as_object().expect("object").len(), 12);
    }

    #[test]
    fn a_delta_adds_to_the_totals_and_replaces_the_latest_call() {
        let mut stats = SessionStats::new();
        stats.apply_usage_delta(Some(
            &json!({ "deltaInput": 10, "deltaOutput": 4, "deltaCachedRead": 3, "deltaCacheWrite": 2, "deltaPrompt": 15, "costUsd": 0.5 }),
        ));
        stats.apply_usage_delta(Some(&json!({ "deltaInput": 5, "deltaOutput": 1, "costUsd": 0.25 })));
        assert_eq!((stats.input_tokens, stats.output_tokens, stats.cached_tokens), (15.0, 5.0, 3.0));
        assert_eq!((stats.cache_write_tokens, stats.prompt_tokens, stats.cost_usd), (2.0, 15.0, 0.75));
        assert_eq!((stats.latest_input_tokens, stats.latest_output_tokens, stats.latest_cached_tokens), (5.0, 1.0, 0.0));
        assert_eq!((stats.latest_cache_write_tokens, stats.latest_prompt_tokens), (0.0, 0.0));
    }

    /// A delta of a whole turn adds its sum to the totals; the latest prompt is the context it measured, not the sum.
    #[test]
    fn the_latest_prompt_of_a_delta_that_bills_a_whole_turn_is_the_context_it_measured() {
        let mut stats = SessionStats::new();
        stats.apply_usage_delta(Some(&json!({ "deltaInput": 37108, "deltaPrompt": 37108, "contextPromptTokens": 9000 })));
        assert_eq!((stats.prompt_tokens, stats.latest_prompt_tokens), (37108.0, 9000.0));
    }

    #[test]
    fn a_field_that_is_not_a_finite_number_counts_zero() {
        let mut stats = SessionStats::new();
        stats.apply_usage_delta(Some(&json!({ "deltaInput": "12", "deltaOutput": "x", "deltaCachedRead": null, "costUsd": -1 })));
        assert_eq!((stats.input_tokens, stats.output_tokens, stats.cached_tokens, stats.cost_usd), (12.0, 0.0, 0.0, -1.0));
    }

    #[test]
    fn no_delta_leaves_the_totals_alone() {
        let mut stats = SessionStats::new();
        stats.apply_usage_delta(None);
        stats.apply_usage_delta(Some(&Value::Null));
        assert_eq!(stats, SessionStats::new());
        stats.apply_usage_delta(Some(&json!({})));
        assert_eq!(stats, SessionStats::new());
    }
}
