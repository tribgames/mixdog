//! The record a failed turn leaves on its last message, built from the run's failure
//! (`failedTurnCompletion`, `manager/ask-turn-failure.mjs:26-45`, over `turnFailureRecord`,
//! `session/turn-failure.mjs:15-49`): `meta.transcript.completion`, whatever the error was, a workspace
//! admission refusal included.
//!
//! The run's `TurnError` carries the message, and for a provider failure its provider, status and kind
//! (`provider_error`). The rest of what `turnFailureRecord` reads off the thrown error - its `code`,
//! `retryAfterMs`, `resetAt`, the account pool's `quotaExhausted` proof and a provider timeout's phase - rides in
//! `TurnError.data` under `providerFacts` ([`ProviderFacts`]), so the wire type keeps its schema. The provider is
//! named in a first-byte timeout from the turn's own route, never from the error (`turn-failure.mjs:44`).

use std::sync::LazyLock;

use mixdog_ai::service::error_text::Descriptor;
use mixdog_ai::service::error_text::ErrorView;
use mixdog_ai::service::error_text::PresentOptions;
use mixdog_ai::service::error_text::TimeoutPhase;
use mixdog_ai::service::error_text::present_error_text;
use mixdog_ai::service::error_text::safe_error_details;
use mixdog_ai::service::error_text::sent_code;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_js::JsRegex;
use mixdog_protocol::ProviderErrorDetail;
use mixdog_protocol::TurnError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The turn's provider and model (`session.provider`, `session.model`).
pub(crate) struct Route<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

/// `error.quotaExhausted`: the account pool's proof that no account can serve the model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaProof {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<u64>,
}

/// `error.timeoutPhase` of a provider timeout (`provider-timeout-phase.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeoutKind {
    Headers,
    FirstChunk,
    Idle,
    Auth,
}

/// A provider timeout's `timeoutPhase`, `waitedMs` and `attempts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeoutFacts {
    pub phase: TimeoutKind,
    #[serde(default)]
    pub waited_ms: u64,
    #[serde(default)]
    pub attempts: u64,
}

/// What `turnFailureRecord` reads off a provider error beyond [`ProviderErrorDetail`]'s provider, status and
/// kind. Every field is absent when the error had none.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFacts {
    /// `error.code`, as sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// `error.retryAfterMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// `error.resetAt`, epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_exhausted: Option<QuotaProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<TimeoutFacts>,
}

/// The key of [`ProviderFacts`] in `TurnError.data`.
const FACTS_KEY: &str = "providerFacts";

/// The `providerFacts` of a `TurnError` are not facts this crate writes: only [`ProviderFacts::into_data`] puts them
/// there, so a value of another shape is a bug of whoever built the error, not an error without facts.
#[derive(Debug)]
pub struct MalformedFacts(serde_json::Error);

impl std::fmt::Display for MalformedFacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the turn error's `{FACTS_KEY}` are malformed: {}", self.0)
    }
}

impl std::error::Error for MalformedFacts {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

impl ProviderFacts {
    /// The facts a failed turn's `TurnError` carries; none when it carries none (a plain failure, as Node's thrown
    /// `Error` without the fields).
    pub fn of(error: &TurnError) -> Result<Self, MalformedFacts> {
        match error.data.get(FACTS_KEY) {
            Some(facts) => serde_json::from_value(facts.clone()).map_err(MalformedFacts),
            None => Ok(Self::default()),
        }
    }

    /// `data` (null or an object of typed fields) with these facts added.
    pub fn into_data(self, data: Value) -> Value {
        let mut fields = match data {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        fields.insert(FACTS_KEY.into(), serde_json::to_value(self).expect("provider facts serialize"));
        Value::Object(fields)
    }
}

/// The `TurnError` of a run that ended on `error` from `provider`: the wire detail (provider, status,
/// kind, delivery) and the facts `turnFailureRecord` reads off the same error. `data` is the error's other
/// typed fields (null when it has none).
pub fn provider_turn_error(error: &ProviderError, provider: &str, data: Value) -> TurnError {
    let descriptor = Descriptor::of(error);
    let facts = ProviderFacts {
        code: Some(sent_code(error)).filter(|code| !code.is_empty()),
        retry_after_ms: descriptor.retry_after_ms,
        reset_at: descriptor.reset_at,
        quota_exhausted: None,
        timeout: None,
    };
    let delivery = match error.delivery {
        DeliveryState::NotSent => mixdog_protocol::DeliveryState::NotSent,
        DeliveryState::Ambiguous => mixdog_protocol::DeliveryState::Ambiguous,
        DeliveryState::Accepted => mixdog_protocol::DeliveryState::Accepted,
    };
    TurnError {
        message: error.message.clone(),
        data: facts.into_data(data),
        provider_error: Some(ProviderErrorDetail { provider: provider.to_owned(), status: error.status, kind: descriptor.kind, delivery: Some(delivery) }),
    }
}

/// `providerDisplayName` (`shared/provider-display-name.mjs`): a known provider id's display name, any other id as
/// itself.
fn provider_display_name(provider: &str) -> String {
    let name = match provider.to_lowercase().as_str() {
        "openai-oauth" => "OpenAI OAuth",
        "anthropic-oauth" => "Anthropic OAuth",
        "grok-oauth" => "Grok OAuth",
        "muse-code-oauth" => "Muse Code",
        "command-code-oauth" => "Command Code",
        "mimo-oauth" => "MiMo",
        "cursor-oauth" => "Cursor OAuth",
        "devin-oauth" => "Devin",
        "antigravity-oauth" => "Antigravity OAuth",
        "openai" | "openai-api" => "OpenAI API",
        "anthropic" | "anthropic-api" => "Anthropic API",
        "gemini" | "gemini-api" => "Gemini API",
        "xai" | "xai-api" => "xAI API",
        "deepseek" | "deepseek-api" => "DeepSeek API",
        "opencode-go-oauth" => "OpenCode Go OAuth",
        "openrouter" => "OpenRouter",
        "mixdog-local" => "Local Provider",
        "default" => "Default",
        _ => provider,
    };
    name.to_owned()
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
pub(crate) fn failure_record(error: &TurnError, route: &Route<'_>) -> Result<Map<String, Value>, MalformedFacts> {
    let facts = ProviderFacts::of(error)?;
    let proof = facts.quota_exhausted.as_ref();
    let provider = error.provider_error.as_ref();
    // `providerErrorKind`: the pool's proof decides first (`provider-error-kind.mjs:674`).
    let kind = if proof.is_some() { "quota_exhausted" } else { provider.map_or("unknown", |p| p.kind.as_str()) };
    let status = provider.and_then(|p| p.status).map_or(0, u32::from);
    let code = facts.code.as_deref().map(|code| code.trim().to_lowercase()).unwrap_or_default();
    let retry_after_ms = facts.retry_after_ms.filter(|ms| *ms > 0);
    // `resetAtOf` (`provider-error-kind.mjs:601-609`): the error's own, else the proof's.
    let reset_at = facts.reset_at.filter(|at| *at > 0).or_else(|| proof.and_then(|p| p.reset_at).filter(|at| *at > 0));
    let mut out = Map::new();
    out.insert("errorKind".into(), json!({ "kind": kind, "code": code, "status": status, "retryAfterMs": retry_after_ms, "resetAt": reset_at }));
    // `turnFailureRecord`: a quota stop is the pool's proof, or an exhausted quota with the reset the provider named.
    if proof.is_some() || (kind == "quota_exhausted" && reset_at.is_some()) {
        let named = |own: Option<&String>, route: &str| own.filter(|name| !name.is_empty()).map_or_else(|| route.to_owned(), Clone::clone);
        let quota_reset = proof.and_then(|p| p.reset_at).or(reset_at);
        out.insert(
            "quota".into(),
            json!({
                "provider": named(proof.and_then(|p| p.provider.as_ref()), route.provider),
                "model": named(proof.and_then(|p| p.model.as_ref()), route.model),
                "resetAt": quota_reset,
            }),
        );
    }
    let descriptor = (provider.is_some() || proof.is_some()).then(|| Descriptor {
        kind: kind.to_owned(),
        code: code.clone(),
        status,
        retry_after_ms,
        reset_at,
    });
    let timeout = facts.timeout;
    let view = ErrorView {
        is_object: true,
        message: error.message.clone(),
        name: "Error".into(),
        code: facts.code.clone().unwrap_or_default(),
        status,
        retry_after_ms: retry_after_ms.unwrap_or(0),
        descriptor,
        timeout_phase: timeout.map(|t| match t.phase {
            TimeoutKind::Headers => TimeoutPhase::Headers,
            TimeoutKind::FirstChunk => TimeoutPhase::FirstChunk,
            TimeoutKind::Idle => TimeoutPhase::Idle,
            TimeoutKind::Auth => TimeoutPhase::Auth,
        }),
        waited_ms: timeout.map_or(0, |t| t.waited_ms),
        attempts: timeout.map_or(0, |t| t.attempts),
        ..ErrorView::default()
    };
    // The provider is named from the turn's own route, never from the error (`turn-failure.mjs:44`).
    let provider_label = (!route.provider.is_empty()).then(|| provider_display_name(route.provider));
    let options = PresentOptions { surface: "turn".into(), max: None, provider_label };
    let text = present_error_text(&view, &options);
    let shown = if SPECIAL.is_match(&text) || ERROR_COLON.is_match(&text) { text } else { format!("Error: {text}") };
    out.insert("detail".into(), json!(STRIP.replace_all_with(&shown, |_| String::new())));
    out.insert("errorDetails".into(), json!(safe_error_details(error_text(error))));
    Ok(out)
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

impl Facts<'_> {
    /// A text field of the turn's `meta.transcript`, when it has one.
    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
    }

    /// The turn's `attemptId`: its own, else the fresh one (`raw.attemptId || randomUUID()`).
    pub(crate) fn attempt(&self) -> &str {
        self.text("attemptId").unwrap_or(&self.attempt_id)
    }

    /// The turn's `completionVerb`; `Thought` when it has none (`failedTurnCompletion`).
    pub(crate) fn verb(&self) -> &str {
        self.text("completionVerb").unwrap_or("Thought")
    }

    /// When the turn began: `raw.at`, else `askStartedAt`.
    pub(crate) fn started(&self) -> i64 {
        self.raw.get("at").and_then(Value::as_f64).filter(|at| *at != 0.0 && at.is_finite()).map_or(self.started_at, |at| at as i64)
    }
}

/// `failedTurnCompletion({ session, err, transcriptMeta, askStartedAt })`, keys in Node's order, over the
/// `turnFailureRecord` of the same error.
pub(crate) fn failed_completion(record: &Map<String, Value>, facts: &Facts<'_>) -> Value {
    let text = |key: &str| facts.text(key);
    let started = facts.started();
    let mut done = Map::new();
    done.insert("status".into(), json!("failed"));
    done.insert("attemptId".into(), json!(facts.attempt()));
    done.insert("at".into(), json!(started));
    done.insert("verb".into(), json!(facts.verb()));
    done.insert("elapsedMs".into(), json!((facts.now - started).max(0)));
    if let Some(checkpoint) = text("checkpointId") {
        done.insert("checkpointId".into(), json!(checkpoint));
    }
    for key in ["modelId", "model", "provider", "agent"] {
        if let Some(value) = text(key) {
            done.insert(key.into(), json!(value));
        }
    }
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
            let got = failure_record(&error, &route).unwrap();
            assert_eq!(got["errorKind"], case["errorKind"], "{case}");
            assert_eq!(got.get("quota").cloned().unwrap_or(Value::Null), case["quota"], "{case}");
            assert_eq!(got["detail"], case["detail"], "{case}");
            assert_eq!(got["errorDetails"], case["errorDetails"], "{case}");
        }
    }

    /// A provider failure as the run host reports it: the `ProviderError` the adapter classified, through
    /// [`provider_turn_error`], plus what no `ProviderError` states (the pool's proof, a timeout's phase) from `fields`.
    fn reported(case: &Value) -> TurnError {
        use mixdog_core_api::domain::provider::ErrorKind;

        let fields = &case["fields"];
        let kind = match case["errorKind"]["kind"].as_str().unwrap() {
            "quota_exhausted" => ErrorKind::QuotaExhausted,
            "rate_limited" => ErrorKind::RateLimited,
            "overloaded" => ErrorKind::Overloaded,
            "billing" => ErrorKind::Billing,
            "unknown" => ErrorKind::Unknown,
            other => panic!("a kind the golden does not use: {other}"),
        };
        let mut refusal = ProviderError::new(kind, DeliveryState::Accepted);
        refusal.message = case["message"].as_str().unwrap().to_owned();
        refusal.status = fields["status"].as_u64().map(|status| u16::try_from(status).unwrap());
        refusal.code = fields["code"].as_str().map(str::to_owned);
        refusal.retry_after = fields["retryAfterMs"].as_u64().map(std::time::Duration::from_millis);
        refusal.reset_at = fields["resetAt"].as_u64().map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
        let mut error = provider_turn_error(&refusal, "anthropic-oauth", Value::Null);
        let mut facts = ProviderFacts::of(&error).unwrap();
        facts.quota_exhausted = fields.get("quotaExhausted").map(|proof| serde_json::from_value(proof.clone()).unwrap());
        facts.timeout = fields.get("timeoutPhase").map(|phase| TimeoutFacts {
            phase: serde_json::from_value(phase.clone()).unwrap(),
            waited_ms: fields["waitedMs"].as_u64().unwrap_or(0),
            attempts: fields["attempts"].as_u64().unwrap_or(0),
        });
        error.data = facts.into_data(error.data);
        error
    }

    /// Node's `turnFailureRecord` for the errors a provider raises (`fixtures/turn-failure`, recorded by
    /// `record-turn-failure.mjs`): the kind with its code, status, retry advice and reset, the quota stop (the pool's
    /// proof, or an exhausted quota whose reset the provider named), and the text, a first-byte timeout naming the
    /// turn's own provider.
    #[test]
    fn a_provider_failure_reads_as_nodes_turn_failure_record() {
        let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/turn-failure/golden.json")).unwrap();
        for case in gold["cases"].as_array().unwrap() {
            let route = Route { provider: case["route"]["provider"].as_str().unwrap_or_default(), model: case["route"]["model"].as_str().unwrap() };
            let got = failure_record(&reported(case), &route).unwrap();
            assert_eq!(got["errorKind"], case["errorKind"], "{}", case["name"]);
            assert_eq!(got.get("quota").cloned().unwrap_or(Value::Null), case["quota"], "{}", case["name"]);
            assert_eq!(got["detail"], case["detail"], "{}", case["name"]);
            assert_eq!(got["errorDetails"], case["errorDetails"], "{}", case["name"]);
        }
    }

    #[test]
    fn a_first_byte_timeout_names_the_turns_provider() {
        let timeout = TimeoutFacts { phase: TimeoutKind::FirstChunk, waited_ms: 30_000, attempts: 2 };
        let data = ProviderFacts { timeout: Some(timeout), ..ProviderFacts::default() }.into_data(Value::Null);
        let error = TurnError { message: "first byte timed out after 30000ms".into(), data, provider_error: None };
        let detail = |provider: &str| failure_record(&error, &Route { provider, model: "m" }).unwrap()["detail"].clone();
        assert_eq!(detail("anthropic-oauth"), json!("Model still thinking: no output in 30s; Anthropic OAuth sent nothing yet; attempts: 2."));
        assert_eq!(detail("my-gateway"), json!("Model still thinking: no output in 30s; my-gateway sent nothing yet; attempts: 2."));
        assert_eq!(detail(""), json!("Model still thinking: no output in 30s; the provider sent nothing yet; attempts: 2."));
    }

    #[test]
    fn the_run_hosts_provider_error_carries_what_the_record_reads() {
        use mixdog_core_api::domain::provider::ErrorKind;

        let mut refusal = ProviderError::new(ErrorKind::RateLimited, DeliveryState::Accepted);
        refusal.status = Some(429);
        refusal.code = Some("Rate_Limit_Exceeded".into());
        refusal.retry_after = Some(std::time::Duration::from_millis(4000));
        refusal.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_900_000_000_000));
        refusal.message = "Rate limit reached".into();
        let error = provider_turn_error(&refusal, "anthropic-oauth", json!({ "carriedReport": "kept" }));
        assert_eq!(error.data["carriedReport"], "kept", "the error's other typed fields stay");
        assert_eq!(
            ProviderFacts::of(&error).unwrap(),
            ProviderFacts { code: Some("Rate_Limit_Exceeded".into()), retry_after_ms: Some(4000), reset_at: Some(1_900_000_000_000), quota_exhausted: None, timeout: None }
        );
        let detail = error.provider_error.as_ref().unwrap();
        assert_eq!((detail.provider.as_str(), detail.status, detail.kind.as_str(), detail.delivery), ("anthropic-oauth", Some(429), "rate_limited", Some(mixdog_protocol::DeliveryState::Accepted)));
        let record = failure_record(&error, &Route { provider: "anthropic-oauth", model: "m" }).unwrap();
        assert_eq!(record["errorKind"], json!({ "kind": "rate_limited", "code": "rate_limit_exceeded", "status": 429, "retryAfterMs": 4000, "resetAt": 1_900_000_000_000_u64 }));
        assert!(!record.contains_key("quota"), "a rate limit is no quota stop");
    }

    /// A `providerFacts` value this crate did not write is a typed error, not an error without facts; an error with
    /// none carries none.
    #[test]
    fn malformed_facts_are_a_typed_error_and_absent_facts_are_none() {
        let route = Route { provider: "p", model: "m" };
        let plain = TurnError { message: "boom".into(), data: Value::Null, provider_error: None };
        assert_eq!(ProviderFacts::of(&plain).unwrap(), ProviderFacts::default());
        let torn = TurnError { message: "boom".into(), data: json!({ "providerFacts": { "resetAt": "soon" } }), provider_error: None };
        assert!(matches!(ProviderFacts::of(&torn), Err(MalformedFacts(_))));
        assert!(failure_record(&torn, &route).is_err());
    }

    #[test]
    fn the_completion_takes_the_turns_identity_and_the_failure() {
        let error = TurnError { message: "boom".into(), data: json!({}), provider_error: None };
        let raw = json!({ "attemptId": "a1", "at": 100, "checkpointId": "c1", "provider": "p", "modelId": "m" });
        let facts = Facts { raw: &raw, started_at: 5, now: 160, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        assert_eq!(
            failed_completion(&failure_record(&error, &facts.route).unwrap(), &facts),
            json!({
                "status": "failed", "attemptId": "a1", "at": 100, "verb": "Thought", "elapsedMs": 60, "checkpointId": "c1",
                "modelId": "m", "provider": "p", "detail": "boom", "errorDetails": "boom",
                "errorKind": { "kind": "unknown", "code": "", "status": 0, "retryAfterMs": null, "resetAt": null },
            })
        );
        let bare = Facts { raw: &Value::Null, started_at: 5, now: 4, attempt_id: "fresh".into(), route: Route { provider: "p", model: "m" } };
        let done = failed_completion(&failure_record(&error, &bare.route).unwrap(), &bare);
        assert_eq!((done["attemptId"].clone(), done["at"].clone(), done["elapsedMs"].clone()), (json!("fresh"), json!(5), json!(0)));
    }
}
