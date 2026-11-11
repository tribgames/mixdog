//! `fixtures/provider-gemini-error-contract` (PURE): every recorded call through the core's public entries over the
//! same inputs: `geminiErrorContract` through `google::error::classify` over a body carrying those details (status
//! absent), `geminiRestError` / `antigravityError` through `classify` with the route's label or endpoint,
//! `geminiPolicyFinishCode` through `decode::policy_finish_code`, `geminiIncompleteError` through the Gemini decoder
//! ending on that candidate, and `providerErrorKind` / `isAntigravityCapacityError` as the classified error's kind. The
//! recorder's result object is rebuilt from the core's answers in the recorded shape and compared whole; each recorded
//! error is compared field by field through [`ERROR_FIELDS`](crate::provider_case::ERROR_FIELDS). `Date.now()` is the
//! recorded clock (`clockStartMs`).

use std::collections::VecDeque;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_ai::providers::google::decode::DecodeDialect;
use mixdog_ai::providers::google::decode::GeminiDecoder;
use mixdog_ai::providers::google::decode::UsageStyle;
use mixdog_ai::providers::google::decode::policy_finish_code;
use mixdog_ai::providers::google::error::ErrorDialect;
use mixdog_ai::providers::google::error::classify;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::QuotaScope;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;

use crate::provider_case::CaseSet;
use crate::provider_case::assert_exact;
use crate::provider_case::error_field;
use crate::provider_case::error_field_unread;
use crate::provider_case::plain;
use crate::provider_cases;

/// One error the core built for a recorded call, with what it was built from.
struct Built {
    error: ProviderError,
    /// The body the response served, parsed (`data`), when it was JSON.
    served: Option<Value>,
    /// The attempt's events before the error (the decoder's).
    events: Vec<StreamEvent>,
    /// The send's model (`geminiIncompleteError`'s `useModel`).
    model: Option<String>,
}

#[derive(Default)]
struct Answers {
    contracts: VecDeque<ProviderError>,
    errors: VecDeque<usize>,
    kinds: VecDeque<usize>,
    capacity: VecDeque<usize>,
    policy: VecDeque<Option<&'static str>>,
    built: Vec<Built>,
}

fn now(set: &CaseSet, case: &crate::provider_case::Case) -> SystemTime {
    let _ = set;
    SystemTime::UNIX_EPOCH + Duration::from_millis(case.result().get("clockStartMs").as_f64() as u64)
}

fn response(res: &Exact, text: &str) -> ErrorResponse {
    let headers = res
        .get("headers")
        .get("headers")
        .as_array()
        .iter()
        .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
        .collect();
    ErrorResponse { status: Some(res.get("status").as_f64() as u16), headers, body: text.as_bytes().to_vec() }
}

/// `geminiErrorContract(input)` as the error of a body carrying `input` (`details ?? errorDetails`, `status`,
/// `message`), with no HTTP status of its own.
fn contract_error(input: &Exact, now: SystemTime) -> ProviderError {
    let input = provider_cases::plain(input);
    let mut error = serde_json::Map::new();
    if let Some(status) = input.get("googleStatus") {
        error.insert("status".into(), status.clone());
    }
    if let Some(message) = input.get("message") {
        error.insert("message".into(), message.clone());
    }
    match (input.get("details"), input.get("errorDetails")) {
        (Some(_), Some(_)) => panic!("geminiErrorContract reads both lists; a body carries one"),
        (Some(details), None) => {
            error.insert("details".into(), details.clone());
        }
        (None, Some(details)) => {
            error.insert("errorDetails".into(), details.clone());
        }
        (None, None) => {}
    }
    let body = json!({ "error": error }).to_string();
    classify(&ErrorResponse { status: None, headers: Vec::new(), body: body.into_bytes() }, &ErrorDialect::gemini("Gemini"), now)
}

/// `geminiIncompleteError(response, parsed, model)`: the Gemini decoder over the response the call describes (the
/// parsed candidate, the prompt feedback), for `model`.
fn incomplete(args: &[Exact]) -> Built {
    let response = provider_cases::plain(&args[0]);
    // `parsed` is the candidate the response carries: its content is the candidate's text ('' for none) and its calls
    // the candidate's (`undefined` for none).
    let parsed = &args[1];
    assert!(matches!(parsed.try_get("toolCalls"), None | Some(Exact::Undefined)), "no calls");
    let model = args[2].as_str().to_owned();
    let mut chunk = response.as_object().cloned().unwrap_or_default();
    if let Some(candidate) = parsed.try_get("candidate").filter(|c| !matches!(c, Exact::Null)) {
        assert_eq!(parsed.get("content").as_str(), "", "a candidate without text");
        chunk.insert("candidates".into(), json!([provider_cases::plain(candidate)]));
    }
    let mut decoder = GeminiDecoder::new(DecodeDialect {
        owner: ProviderId::from("gemini"),
        envelope: false,
        usage: UsageStyle::Inclusive,
        errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
    })
    .for_model(&model);
    let wire = format!("data: {}\n\n", Value::Object(chunk));
    let mut events = decoder.feed(wire.as_bytes()).expect("the chunk decodes");
    let error = match decoder.finish() {
        Ok(more) => panic!("the turn ended without an error: {more:?}"),
        Err(error) => error,
    };
    events.retain(|e| !matches!(e, StreamEvent::ChunkProgress(_)));
    Built { error, served: None, events, model: Some(model) }
}

fn answer(set: &CaseSet, case: &crate::provider_case::Case) -> Answers {
    let now = now(set, case);
    let mut answers = Answers::default();
    for call in &case.calls {
        let entry = call.entry.rsplit('.').next().expect("an entry");
        let args = &call.args;
        match entry {
            "geminiErrorContract" => answers.contracts.push_back(contract_error(&args[0], now)),
            "geminiRestError" | "antigravityError" => {
                let text = args[1].as_str();
                let dialect = if entry == "geminiRestError" {
                    // The label is the caller's: the recorder passes the test's.
                    let label: &'static str = match args[2].as_str() {
                        "Gemini" => "Gemini",
                        other => panic!("label {other}"),
                    };
                    ErrorDialect::gemini(label)
                } else {
                    ErrorDialect::antigravity(args[2].as_str())
                };
                let error = classify(&response(&args[0], text), &dialect, now);
                answers.errors.push_back(answers.built.len());
                answers.built.push(Built { error, served: serde_json::from_str(text).ok(), events: Vec::new(), model: None });
            }
            "geminiIncompleteError" => {
                answers.errors.push_back(answers.built.len());
                answers.built.push(incomplete(args));
            }
            // The error a kind is read from is the oldest built one not yet read.
            "providerErrorKind" => {
                let index = answers.kinds.len();
                answers.kinds.push_back(index);
            }
            "isAntigravityCapacityError" => {
                let index = answers.capacity.len();
                answers.capacity.push_back(index);
            }
            "geminiPolicyFinishCode" => answers.policy.push_back(policy_finish_code(args[0].as_str())),
            other => panic!("{}: entry {other}", case.id),
        }
    }
    answers
}

fn scope_name(scope: QuotaScope) -> &'static str {
    match scope {
        QuotaScope::Minute => "minute",
        QuotaScope::Day => "day",
        QuotaScope::Plan => "plan",
    }
}

fn kind_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Auth => "auth",
        ErrorKind::Permission => "permission",
        ErrorKind::InvalidRequest => "invalid_request",
        ErrorKind::Transient => "transient",
        ErrorKind::RateLimited => "rate_limited",
        ErrorKind::QuotaExhausted => "quota_exhausted",
        ErrorKind::Overloaded => "overloaded",
        ErrorKind::Policy => "policy",
        ErrorKind::Billing => "billing",
        ErrorKind::Unknown => "unknown",
        other => panic!("kind {other:?}"),
    }
}

fn ms_of(at: SystemTime) -> f64 {
    at.duration_since(SystemTime::UNIX_EPOCH).expect("after the epoch").as_millis() as f64
}

/// The contract fields of an error in `geminiErrorContract`'s key order; `resetAtMinusClock` where the recorder's
/// `fields()` added it.
fn contract_fields(error: &ProviderError, recorded: &Exact, now: SystemTime) -> Exact {
    let mut out: Vec<(String, Exact)> = Vec::new();
    if let Some(code) = &error.code {
        out.push(("code".into(), Exact::String(code.clone())));
    }
    if let Some(wait) = error.retry_after {
        out.push(("retryAfterMs".into(), Exact::Number(wait.as_millis() as f64)));
    }
    if let Some(at) = error.reset_at {
        out.push(("resetAt".into(), Exact::Number(ms_of(at))));
    }
    if let Some(scope) = error.quota_scope {
        out.push(("quotaScope".into(), Exact::String(scope_name(scope).into())));
    }
    if recorded.try_get("resetAtMinusClock").is_some()
        && let Some(at) = error.reset_at
    {
        out.push(("resetAtMinusClock".into(), Exact::Number(ms_of(at) - ms_of(now))));
    }
    Exact::Object(out)
}

/// `providerErrorKind(err)` of the core's error: its kind, code, status, advice and reset.
fn kind_of(error: &ProviderError) -> Exact {
    let opt = |v: Option<f64>| v.map_or(Exact::Null, Exact::Number);
    Exact::Object(vec![
        ("kind".into(), Exact::String(kind_name(error.kind).into())),
        ("code".into(), Exact::String(error.code.clone().unwrap_or_default())),
        ("status".into(), Exact::Number(f64::from(error.status.unwrap_or(0)))),
        ("retryAfterMs".into(), opt(error.retry_after.map(|d| d.as_millis() as f64))),
        ("resetAt".into(), opt(error.reset_at.map(ms_of))),
    ])
}

const CONTRACT_KEYS: [&str; 5] = ["code", "retryAfterMs", "resetAt", "quotaScope", "resetAtMinusClock"];

struct Walk<'a> {
    case: &'a str,
    now: SystemTime,
    answers: Answers,
    error_at: usize,
}

impl Walk<'_> {
    fn node(&mut self, key: &str, recorded: &Exact) -> Exact {
        match (key, recorded) {
            ("clockStartMs", _) => Exact::Number(ms_of(self.now)),
            // The response the error carries is the one handed in (`err.headers === res.headers`): the core reads the
            // response's own headers.
            ("headersIsTheResponsesOwn", _) => Exact::Bool(true),
            ("stampMs", _) => Exact::Number(mixdog_js::time::date_parse("2099-01-01T00:00:00Z")),
            ("kind", Exact::Object(_)) => {
                let index = self.answers.kinds.pop_front().expect("a kind call");
                kind_of(&self.answers.built[index].error)
            }
            ("isCapacity", _) => {
                let index = self.answers.capacity.pop_front().expect("a capacity call");
                Exact::Bool(self.answers.built[index].error.kind == ErrorKind::Overloaded)
            }
            ("policy", Exact::Object(entries)) => Exact::Object(
                entries
                    .iter()
                    .map(|(reason, _)| {
                        let code = self.answers.policy.pop_front().expect("a policy call");
                        (reason.clone(), code.map_or(Exact::Null, |c| Exact::String(c.into())))
                    })
                    .collect(),
            ),
            (_, Exact::Error { .. }) => {
                let index = self.answers.errors.pop_front().expect("an error call");
                let built = &self.answers.built[index];
                compare_error(&format!("{}: {key}", self.case), recorded, built);
                self.error_at += 1;
                recorded.clone()
            }
            (_, Exact::Object(entries)) if entries.iter().all(|(k, _)| CONTRACT_KEYS.contains(&k.as_str())) => {
                let error = self.answers.contracts.pop_front().expect("a contract call");
                contract_fields(&error, recorded, self.now)
            }
            (_, Exact::Object(entries)) => {
                Exact::Object(entries.iter().map(|(k, v)| (k.clone(), self.node(k, v))).collect())
            }
            (other, value) => panic!("{}: no answer for {other} = {value:?}", self.case),
        }
    }
}

fn opt_str(value: &Exact) -> Option<&str> {
    match value {
        Exact::Undefined | Exact::Null => None,
        other => Some(other.as_str()),
    }
}

/// `retryInfoDelayMs`: the first positive RetryInfo delay written in seconds (`"<n>s"` or `{seconds, nanos}`).
fn retry_info_ms(details: &Exact) -> Option<f64> {
    for detail in details.as_array() {
        let ms = match detail.try_get("retryDelay") {
            Some(Exact::String(text)) => text.trim().strip_suffix('s').and_then(|n| n.parse::<f64>().ok()).map(|n| n * 1000.0),
            Some(Exact::Object(_)) => {
                let delay = provider_cases::plain(detail.get("retryDelay"));
                let n = |k: &str| delay.get(k).map_or(0.0, mixdog_js::to_number);
                Some(n("seconds") * 1000.0 + n("nanos") / 1_000_000.0)
            }
            _ => None,
        };
        if let Some(ms) = ms.filter(|ms| ms.is_finite() && *ms > 0.0) {
            return Some(ms.ceil());
        }
    }
    None
}

/// One recorded error against the core's, every field through the table.
fn compare_error(what: &str, recorded: &Exact, built: &Built) {
    let Exact::Error { name, message, code, cause, props } = recorded else { panic!("{what}: not an error") };
    assert!(cause.is_none(), "{what}: a cause");
    let error = &built.error;
    let prop = |key: &str| props.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let mut fields: Vec<(String, Exact)> = vec![
        ("name".into(), Exact::String(name.clone())),
        ("message".into(), Exact::String(message.clone())),
        ("code".into(), code.as_deref().cloned().unwrap_or(Exact::Undefined)),
    ];
    fields.extend(props.iter().cloned());
    let text: String = built.events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
    for (field, value) in &fields {
        if error_field_unread(field) {
            continue;
        }
        let mapping = error_field(field);
        let what = format!("{what}.{field} ({mapping})");
        match field.as_str() {
            "name" => assert!(!error.timed_out && error.transport.is_none(), "{what}: {} is a typed refusal", value.as_str()),
            "message" => assert_eq!(error.message, value.as_str(), "{what}"),
            "code" => assert_eq!(error.code.as_deref(), opt_str(value), "{what}"),
            "status" | "httpStatus" => assert_eq!(error.status.map(f64::from), Some(value.as_f64()), "{what}"),
            "headers" => {
                // Header advice stands behind the body's own (`retryAfterMs`).
                if prop("retryAfterMs").is_none() {
                    assert!(value.get("headers").as_array().is_empty() && error.retry_after.is_none(), "{what}");
                }
            }
            "initialResponseError" => assert!(value.as_bool() && error.transport.is_none(), "{what}"),
            "error" => {
                if let Some(Exact::String(own)) = value.try_get("message") {
                    let shown = mixdog_ai::oauth::scrub::scrub_oauth_secrets(own, &[]);
                    assert!(error.message.contains(&shown), "{what}: {:?} does not carry {shown:?}", error.message);
                }
            }
            "data" => assert_eq!(value, &plain(built.served.as_ref().expect("a JSON body")), "{what}"),
            "geminiStatus" => {
                let status = value.as_str().to_lowercase();
                if code.as_deref().and_then(opt_str) == Some(status.as_str()) {
                    assert_eq!(error.code.as_deref(), Some(status.as_str()), "{what}");
                }
            }
            "details" => {
                if prop("retryAfterMs").is_none() {
                    assert_eq!(error.retry_after.map(|d| d.as_millis() as f64), retry_info_ms(value), "{what}");
                }
            }
            "retryAfterMs" => assert_eq!(error.retry_after.map(|d| d.as_millis() as f64), Some(value.as_f64()), "{what}"),
            "resetAt" => assert_eq!(error.reset_at.map(ms_of), Some(value.as_f64()), "{what}"),
            "quotaScope" => assert_eq!(error.quota_scope.map(scope_name), Some(value.as_str()), "{what}"),
            "providerIncomplete" => assert_eq!(error.finish_reason.is_some(), value.as_bool(), "{what}"),
            "finishReason" => assert_eq!(error.finish_reason.as_deref(), opt_str(value), "{what}"),
            "partialContent" => match value {
                Exact::Undefined => assert!(text.is_empty(), "{what}"),
                other => assert_eq!(text, other.as_str(), "{what}"),
            },
            "partialToolCalls" => {
                let done = built.events.iter().filter(|e| matches!(e, StreamEvent::ToolCallDone(_))).count();
                match value {
                    Exact::Undefined => assert_eq!(done, 0, "{what}"),
                    other => assert_eq!(done, other.as_array().len(), "{what}"),
                }
            }
            "partialProviderReplay" => {
                assert!(matches!(value, Exact::Undefined) && error.partial_replay.is_none(), "{what}")
            }
            "providerMetadata" => {
                let replay = built.events.iter().any(|e| matches!(e, StreamEvent::ReasoningReplay(_)));
                assert!(matches!(value, Exact::Undefined) && !replay, "{what}");
            }
            "model" => {
                let model = error.partial_model.as_deref().or(built.model.as_deref());
                assert_eq!(model, Some(value.as_str()), "{what}");
            }
            "rawUsage" => assert!(matches!(value, Exact::Null) && error.partial_usage.is_none(), "{what}"),
            other => panic!("{what}: no comparison for {other}"),
        }
    }
}

#[test]
fn every_case_answers_as_nodes() {
    let set = CaseSet::load("gemini-error-contract");
    assert_eq!(set.cases.len(), 26, "the recorded cases");
    for case in &set.cases {
        let answers = answer(&set, case);
        let mut walk = Walk { case: &case.id, now: now(&set, case), answers, error_at: 0 };
        let actual = walk.node("", case.result());
        assert!(walk.answers.contracts.is_empty() && walk.answers.errors.is_empty(), "{}: every call answered", case.id);
        assert!(walk.answers.kinds.is_empty() && walk.answers.capacity.is_empty() && walk.answers.policy.is_empty(), "{}", case.id);
        assert_exact(&format!("provider-gemini-error-contract {}: result", case.id), case.result(), &actual);
    }
}
