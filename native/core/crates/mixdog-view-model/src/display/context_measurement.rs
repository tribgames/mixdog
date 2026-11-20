//! `runtime/shared/context-measurement.mjs`: the presentation contract of the context figure is the last measured prompt,
//! never cumulative billing, generated output, or the internal estimate that protects the context window.

use mixdog_js::json_number;
use mixdog_js::math::round;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use super::coerce::field;
use super::coerce::number_or_zero;
use super::coerce::or;
use super::coerce::present;
use super::coerce::truthy;

/// What `sessionContextMeasurement` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextMeasurement {
    pub tokens: Option<f64>,
    /// `pending`, `unavailable` or `last_api_request`.
    pub source: &'static str,
    pub updated_at: Option<f64>,
}

impl ContextMeasurement {
    const PENDING: Self = Self { tokens: None, source: "pending", updated_at: None };

    /// The object Node builds.
    pub fn to_value(self) -> Value {
        let mut map = Map::new();
        map.insert("tokens".into(), self.tokens.map_or(Value::Null, json_number));
        map.insert("source".into(), Value::String(self.source.to_owned()));
        map.insert("updatedAt".into(), self.updated_at.map_or(Value::Null, json_number));
        Value::Object(map)
    }
}

/// `sessionContextMeasurement(session, hasConversationActivity)`.
pub fn session_context_measurement(session: &Value, has_conversation_activity: bool) -> ContextMeasurement {
    let pending = ContextMeasurement::PENDING;
    if !truthy(Some(session)) || !has_conversation_activity {
        return pending;
    }
    let session = Some(session);
    if field(session, "contextPressureBaselineSource").and_then(Value::as_str) == Some("checkpoint_post_compact") {
        return pending;
    }
    let updated_at = number_or_zero(field(session, "lastContextTokensUpdatedAt"));
    let compaction = field(session, "compaction");
    let compact_at = number_or_zero(field(compaction, "lastChangedAt")).max(number_or_zero(field(compaction, "lastCompactAt")));
    let baseline_provider = field(session, "contextPressureBaselineProvider");
    let baseline_model = field(session, "contextPressureBaselineModel");
    let route_mismatch =
        (truthy(baseline_provider) && baseline_provider != field(session, "provider")) || (truthy(baseline_model) && baseline_model != field(session, "model"));
    if route_mismatch || (compact_at > 0.0 && updated_at <= compact_at) {
        return pending;
    }
    // Missing usage is explicitly persisted as null: an older provider anchor is not revived and a missing reading is
    // not turned into zero.
    if matches!(field(session, "lastContextTokens"), Some(Value::Null)) && updated_at > 0.0 {
        return ContextMeasurement { tokens: None, source: "unavailable", updated_at: Some(updated_at) };
    }
    if field(session, "lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true)) {
        return pending;
    }
    let tokens = to_number_of(field(session, "lastContextTokens"));
    if tokens.is_finite() && tokens > 0.0 {
        ContextMeasurement { tokens: Some(tokens), source: "last_api_request", updated_at: (updated_at != 0.0).then_some(updated_at) }
    } else {
        pending
    }
}

/// A known measurement is the last API request; otherwise the transport says unavailable or still pending.
fn measurement_source(known: bool, source: &str) -> &'static str {
    if known {
        "last_api_request"
    } else if source == "unavailable" {
        "unavailable"
    } else {
        "pending"
    }
}

/// `contextMeasurementStats(context)`: `currentContextTokens`, `currentEstimatedContextTokens` (always 0: estimates no
/// longer enter the display lane), `currentContextSource` and `currentContextUpdatedAt`.
pub fn context_measurement_stats(context: Option<&Value>) -> Value {
    let given = present(field(context, "measurement"));
    let stale = truthy(field(context, "lastApiRequestStale"));
    let (tokens, source, updated_at) = match given {
        Some(measurement) => {
            (field(Some(measurement), "tokens"), field(Some(measurement), "source").map(value_to_string), field(Some(measurement), "updatedAt"))
        }
        None => {
            (if stale { None } else { field(context, "lastApiRequestTokens") }, Some((if stale { "pending" } else { "last_api_request" }).to_owned()), None)
        }
    };
    let n = to_number_of(tokens);
    let known = source.as_deref() == Some("last_api_request") && n.is_finite() && n > 0.0;
    let mut map = Map::new();
    map.insert("currentContextTokens".into(), if known { json_number(n) } else { Value::Null });
    map.insert("currentEstimatedContextTokens".into(), json_number(0.0));
    map.insert("currentContextSource".into(), Value::String(measurement_source(known, source.as_deref().unwrap_or_default()).to_owned()));
    map.insert("currentContextUpdatedAt".into(), if truthy(updated_at) { updated_at.cloned().unwrap_or(Value::Null) } else { Value::Null });
    Value::Object(map)
}

/// `contextPercent(tokens, limit)`: the share of the window used, clamped to 0..100 and rounded to a tenth; `None` when
/// there is no reading or no window.
pub fn context_percent(tokens: Option<f64>, limit: f64) -> Option<f64> {
    let tokens = tokens?;
    if limit.is_nan() || limit <= 0.0 {
        return None;
    }
    let ratio = tokens / limit * 100.0;
    let clamped = if ratio.is_nan() { ratio } else { ratio.clamp(0.0, 100.0) };
    Some(round(clamped * 10.0) / 10.0)
}

/// `measuredContextUsage(input)`: `used`, `limit`, `percent`, `known`, `source`, `updatedAt` and `estimated` (always
/// false) of an input that carries `stats` and `contextWindow` (or the display or raw window).
pub fn measured_context_usage(input: &Value) -> Value {
    let input = Some(input);
    let stats = field(input, "stats").filter(|stats| stats.is_object());
    let window = or(or(field(input, "contextWindow"), field(input, "displayContextWindow")), field(input, "rawContextWindow"));
    let limit = number_or_zero(window).max(0.0);
    let source_value = field(stats, "currentContextSource");
    let source = if truthy(source_value) { source_value.map(value_to_string).unwrap_or_default() } else { String::new() };
    let tokens = field(stats, "currentContextTokens");
    let token_number = to_number_of(tokens);
    let known = tokens.is_some_and(|t| !t.is_null()) && token_number.is_finite() && token_number > 0.0 && (source == "last_api_request" || source.is_empty());
    let used = known.then_some(token_number);
    let mut map = Map::new();
    map.insert("used".into(), used.map_or(Value::Null, json_number));
    map.insert("limit".into(), json_number(limit));
    map.insert("percent".into(), context_percent(used, limit).map_or(Value::Null, json_number));
    map.insert("known".into(), Value::Bool(known));
    map.insert("source".into(), Value::String(measurement_source(known, &source).to_owned()));
    let updated_at = field(stats, "currentContextUpdatedAt");
    map.insert("updatedAt".into(), if truthy(updated_at) { updated_at.cloned().unwrap_or(Value::Null) } else { Value::Null });
    map.insert("estimated".into(), Value::Bool(false));
    Value::Object(map)
}

/// `contextMeasurementLabel(source)`.
pub fn context_measurement_label(source: &str) -> &'static str {
    match source {
        "last_api_request" => "Last measured input",
        "unavailable" => "Usage unavailable",
        _ => "Awaiting measurement",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn measure(session: Value) -> Value {
        session_context_measurement(&session, true).to_value()
    }

    #[test]
    fn a_session_with_no_activity_or_no_reading_is_pending() {
        assert_eq!(session_context_measurement(&json!({ "lastContextTokens": 10 }), false).source, "pending");
        assert_eq!(session_context_measurement(&Value::Null, true).source, "pending");
        assert_eq!(measure(json!({})), json!({ "tokens": null, "source": "pending", "updatedAt": null }));
        assert_eq!(measure(json!({ "lastContextTokens": 0 }))["source"], "pending");
    }

    #[test]
    fn the_last_api_request_is_the_measurement() {
        assert_eq!(
            measure(json!({ "lastContextTokens": 1200, "lastContextTokensUpdatedAt": 50 })),
            json!({ "tokens": 1200, "source": "last_api_request", "updatedAt": 50 })
        );
        assert_eq!(measure(json!({ "lastContextTokens": "300" }))["tokens"], json!(300));
    }

    #[test]
    fn a_persisted_null_reads_unavailable() {
        assert_eq!(
            measure(json!({ "lastContextTokens": null, "lastContextTokensUpdatedAt": 9 })),
            json!({ "tokens": null, "source": "unavailable", "updatedAt": 9 })
        );
        assert_eq!(measure(json!({ "lastContextTokens": null }))["source"], "pending");
    }

    #[test]
    fn a_compaction_or_route_change_after_the_reading_makes_it_pending() {
        let base = json!({ "lastContextTokens": 1200, "lastContextTokensUpdatedAt": 50 });
        let mut compacted = base.clone();
        compacted["compaction"] = json!({ "lastCompactAt": 50 });
        assert_eq!(measure(compacted)["source"], "pending");
        let mut earlier = base.clone();
        earlier["compaction"] = json!({ "lastChangedAt": 49 });
        assert_eq!(measure(earlier)["source"], "last_api_request");
        let mut moved = base.clone();
        moved["provider"] = json!("b");
        moved["contextPressureBaselineProvider"] = json!("a");
        assert_eq!(measure(moved)["source"], "pending");
        let mut model = base.clone();
        model["model"] = json!("m2");
        model["contextPressureBaselineModel"] = json!("m1");
        assert_eq!(measure(model)["source"], "pending");
        let mut checkpoint = base.clone();
        checkpoint["contextPressureBaselineSource"] = json!("checkpoint_post_compact");
        assert_eq!(measure(checkpoint)["source"], "pending");
        let mut stale = base;
        stale["lastContextTokensStaleAfterCompact"] = json!(true);
        assert_eq!(measure(stale)["source"], "pending");
    }

    #[test]
    fn stats_come_from_the_measurement_or_the_last_api_request() {
        let known = context_measurement_stats(Some(&json!({ "measurement": { "tokens": 5, "source": "last_api_request", "updatedAt": 7 } })));
        assert_eq!(known["currentContextTokens"], json!(5));
        assert_eq!(known["currentContextUpdatedAt"], json!(7));
        assert_eq!(known["currentEstimatedContextTokens"], json!(0));
        let unavailable = context_measurement_stats(Some(&json!({ "measurement": { "tokens": null, "source": "unavailable" } })));
        assert_eq!(unavailable["currentContextSource"], "unavailable");
        assert_eq!(unavailable["currentContextTokens"], Value::Null);
        let stale = context_measurement_stats(Some(&json!({ "lastApiRequestStale": true, "lastApiRequestTokens": 9 })));
        assert_eq!(stale["currentContextSource"], "pending");
        let live = context_measurement_stats(Some(&json!({ "lastApiRequestTokens": 9 })));
        assert_eq!(live["currentContextTokens"], json!(9));
        assert_eq!(context_measurement_stats(None)["currentContextSource"], "pending");
    }

    #[test]
    fn percent_is_clamped_and_rounded_to_a_tenth() {
        assert_eq!(context_percent(Some(50.0), 200.0), Some(25.0));
        assert_eq!(context_percent(Some(1.0), 3.0), Some(33.3));
        assert_eq!(context_percent(Some(500.0), 200.0), Some(100.0));
        assert_eq!(context_percent(Some(-4.0), 200.0), Some(0.0));
        assert_eq!(context_percent(None, 200.0), None);
        assert_eq!(context_percent(Some(5.0), 0.0), None);
    }

    #[test]
    fn measured_usage_needs_a_known_last_request() {
        let usage =
            measured_context_usage(&json!({ "contextWindow": 1000, "stats": { "currentContextTokens": 250, "currentContextSource": "last_api_request" } }));
        assert_eq!(usage["used"], json!(250));
        assert_eq!(usage["percent"], json!(25));
        assert_eq!(usage["known"], json!(true));
        assert_eq!(usage["limit"], json!(1000));
        let estimate =
            measured_context_usage(&json!({ "displayContextWindow": 1000, "stats": { "currentContextTokens": 250, "currentContextSource": "estimate" } }));
        assert_eq!(estimate["known"], json!(false));
        assert_eq!(estimate["source"], "pending");
        assert_eq!(estimate["percent"], Value::Null);
        let bare = measured_context_usage(&json!({ "rawContextWindow": 400, "stats": { "currentContextTokens": 100 } }));
        assert_eq!(bare["known"], json!(true));
        assert_eq!(bare["updatedAt"], Value::Null);
        assert_eq!(measured_context_usage(&json!({}))["limit"], json!(0));
    }

    #[test]
    fn labels_name_the_source() {
        assert_eq!(context_measurement_label("last_api_request"), "Last measured input");
        assert_eq!(context_measurement_label("unavailable"), "Usage unavailable");
        assert_eq!(context_measurement_label("pending"), "Awaiting measurement");
        assert_eq!(context_measurement_label("anything"), "Awaiting measurement");
    }
}
