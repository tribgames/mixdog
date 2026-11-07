//! The record a failed turn leaves on its last message, built from the run's failure
//! (`failedTurnCompletion`, `manager/ask-turn-failure.mjs:26-45`, over `turnFailureRecord`,
//! `session/turn-failure.mjs:15-49`): `meta.transcript.completion`, whatever the error was, a workspace
//! admission refusal included.
//!
//! The run's `TurnError` carries the message, and for a provider failure its provider, status and kind; the
//! error's own `code`, `retryAfterMs`, `resetAt` and `quotaExhausted` are not in it, so those read as an
//! error without them (a quota stop has `resetAt: null`).

use std::sync::LazyLock;

use mixdog_ai::service::error_text::ErrorView;
use mixdog_ai::service::error_text::PresentOptions;
use mixdog_ai::service::error_text::present_error_text;
use mixdog_ai::service::error_text::safe_error_details;
use mixdog_js::JsRegex;
use mixdog_protocol::TurnError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The turn's provider and model (`session.provider`, `session.model`).
pub(crate) struct Route<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

/// `toolErrorDisplay`'s no-prefix cases (`tool-result-text.mjs:121-128`).
static SPECIAL: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:Search failed|Fetch failed|No first response|No progress|Cancelled|The .+ went stale|(?:Web search agent|Agent|Tool|Request) (?:stopped|was cancelled))",
        "i",
    )
});
static ERROR_COLON: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error\s*:", "i"));
static STRIP: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Error:\s*", "i"));

/// `errText(error)` of an `Error`: its message, else its name.
fn error_text(error: &TurnError) -> &str {
    if error.message.is_empty() { "Error" } else { &error.message }
}

/// `{ errorKind, quota, detail, errorDetails }` of `turnFailureRecord(error, route)`.
pub(crate) fn failure_record(error: &TurnError, route: &Route<'_>) -> Map<String, Value> {
    let (kind, status) = match &error.provider_error {
        Some(provider) => (provider.kind.as_str(), provider.status.map_or(0, u32::from)),
        None => ("unknown", 0),
    };
    let mut out = Map::new();
    out.insert("errorKind".into(), json!({ "kind": kind, "code": "", "status": status, "retryAfterMs": null, "resetAt": null }));
    if kind == "quota_exhausted" {
        let provider = error.provider_error.as_ref().map(|p| p.provider.as_str()).filter(|p| !p.is_empty()).unwrap_or(route.provider);
        out.insert("quota".into(), json!({ "provider": provider, "model": route.model, "resetAt": null }));
    }
    let view = ErrorView { is_object: true, message: error.message.clone(), name: "Error".into(), ..ErrorView::default() };
    let options = PresentOptions { surface: "turn".into(), max: None, provider_label: None };
    let text = present_error_text(&view, &options);
    let shown = if SPECIAL.is_match(&text) || ERROR_COLON.is_match(&text) { text } else { format!("Error: {text}") };
    out.insert("detail".into(), json!(STRIP.replace_all_with(&shown, |_| String::new())));
    out.insert("errorDetails".into(), json!(safe_error_details(error_text(error))));
    out
}

/// What `failedTurnCompletion` adds to the turn's own facts. `raw` is the turn's `meta.transcript`
/// (`transcriptMeta`): its `attemptId`, `at`, `completionVerb`, `checkpointId` and route fields.
pub(crate) struct Facts<'a> {
    pub raw: &'a Value,
    /// `askStartedAt`: when the run began, the start when `raw` has no `at`.
    pub started_at: i64,
    pub now: i64,
    pub attempt_id: String,
    pub route: Route<'a>,
}

/// `failedTurnCompletion({ session, err, transcriptMeta, askStartedAt })`, keys in Node's order.
pub(crate) fn failed_completion(error: &TurnError, facts: &Facts<'_>) -> Value {
    let raw = facts.raw;
    let text = |key: &str| raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
    let started = raw.get("at").and_then(Value::as_f64).filter(|at| *at != 0.0 && at.is_finite()).map_or(facts.started_at, |at| at as i64);
    let mut done = Map::new();
    done.insert("status".into(), json!("failed"));
    done.insert("attemptId".into(), json!(text("attemptId").unwrap_or(&facts.attempt_id)));
    done.insert("at".into(), json!(started));
    done.insert("verb".into(), json!(text("completionVerb").unwrap_or("Thought")));
    done.insert("elapsedMs".into(), json!((facts.now - started).max(0)));
    if let Some(checkpoint) = text("checkpointId") {
        done.insert("checkpointId".into(), json!(checkpoint));
    }
    for key in ["modelId", "model", "provider", "agent"] {
        if let Some(value) = text(key) {
            done.insert(key.into(), json!(value));
        }
    }
    let record = failure_record(error, &facts.route);
    for key in ["detail", "errorDetails", "errorKind", "quota"] {
        if let Some(value) = record.get(key).filter(|v| !v.as_str().is_some_and(str::is_empty)) {
            done.insert(key.into(), value.clone());
        }
    }
    Value::Object(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_reads_as_nodes_turn_failure_record() {
        let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/failed-completion/golden.json")).unwrap();
        for case in gold["cases"].as_array().unwrap() {
            let error = TurnError { message: case["message"].as_str().unwrap().to_owned(), data: json!({}), provider_error: None };
            let route = Route { provider: case["route"]["provider"].as_str().unwrap(), model: case["route"]["model"].as_str().unwrap() };
            let got = failure_record(&error, &route);
            assert_eq!(got["errorKind"], case["errorKind"], "{case}");
            assert_eq!(got.get("quota").cloned().unwrap_or(Value::Null), case["quota"], "{case}");
            assert_eq!(got["detail"], case["detail"], "{case}");
            assert_eq!(got["errorDetails"], case["errorDetails"], "{case}");
        }
    }

    #[test]
    fn the_completion_takes_the_turns_identity_and_the_failure() {
        let error = TurnError { message: "boom".into(), data: json!({}), provider_error: None };
        let raw = json!({ "attemptId": "a1", "at": 100, "checkpointId": "c1", "provider": "p", "modelId": "m" });
        let facts = Facts { raw: &raw, started_at: 5, now: 160, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        assert_eq!(
            failed_completion(&error, &facts),
            json!({
                "status": "failed", "attemptId": "a1", "at": 100, "verb": "Thought", "elapsedMs": 60, "checkpointId": "c1",
                "modelId": "m", "provider": "p", "detail": "boom", "errorDetails": "boom",
                "errorKind": { "kind": "unknown", "code": "", "status": 0, "retryAfterMs": null, "resetAt": null },
            })
        );
        let bare = Facts { raw: &Value::Null, started_at: 5, now: 4, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        let done = failed_completion(&error, &bare);
        assert_eq!((done["attemptId"].clone(), done["at"].clone(), done["elapsedMs"].clone()), (json!("fresh"), json!(5), json!(0)));
    }
}
