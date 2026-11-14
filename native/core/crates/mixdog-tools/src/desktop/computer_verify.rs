//! `verify`: a bounded wait for a window condition (`observation/verify-window.ts`, `verify-predicate.ts`, and
//! `evaluateVerifyPredicate` of `analysis.ts`). The predicates are judged against the helper's read-only `window_predicates`
//! (title and element text) until they hold for enough consecutive samples or the budget ends; it never invalidates refs.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_words;
use mixdog_js::slice_utf16;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_rt::time::Instant;
use mixdog_rt::time::sleep;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_STABLE_SAMPLES: u64 = 2;
const POLL_INTERVAL_MS: u64 = 250;
/// A busy window can need longer than the floor, so each read gets the time left up to the cap; a timed-out read is retried.
const PROVIDER_MIN_TIMEOUT_MS: u64 = 2_000;
const PROVIDER_MAX_TIMEOUT_MS: u64 = 5_000;
/// A text wait whose reads time out this many times in a row stays unknown instead of spending the rest of its budget.
const TIMEOUT_GIVE_UP_READS: u32 = 2;
const TEXT_SAMPLE_ENTRIES: usize = 12;
const TEXT_SAMPLE_CHARS: usize = 60;
const MAX_ELEMENTS: u64 = 400;
/// Prefix of the helper's integrity refusal (`INTEGRITY_BLOCK_CODE`).
const INTEGRITY_BLOCK_CODE: &str = "accessibility_blocked_by_integrity";
const TIMEOUT_CODE: &str = "computer_command_timeout";

/// The helper reads `verify` polls: the process backend serves them, a fake serves the tests.
#[async_trait]
trait Reader: Sync {
    async fn read(&self, command: Map<String, Value>, timeout: Duration, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError>;
}

#[async_trait]
impl Reader for ProcessComputerBackend {
    async fn read(&self, command: Map<String, Value>, timeout: Duration, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        self.call_with(command, timeout, cancel).await
    }
}

/// `VerifyStatus`: negative text evidence is valid only when the read completed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Satisfied,
    Unsatisfied,
    Unknown,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Satisfied => "satisfied",
            Status::Unsatisfied => "unsatisfied",
            Status::Unknown => "unknown",
        }
    }
}

/// `VerifyGiveUp`: a wait that stopped before its deadline because more polling could not help (the cached-unusable-tree case
/// belongs to the desktop host's capture cache, which the core does not hold).
#[derive(Clone, Copy, PartialEq, Eq)]
enum GiveUp {
    RepeatedTimeouts,
}

/// `VerifyObservation`.
struct Observation {
    exists: bool,
    title: String,
    haystack: String,
    text_complete: bool,
}

/// `VerifyState`.
struct State {
    attempts: u32,
    samples: u64,
    /// Samples in a row where every predicate held.
    consecutive: u64,
    statuses: Vec<Status>,
    title: String,
    exists: bool,
    observed_elements: usize,
    text_complete: bool,
    text_sample: Vec<String>,
    provider_error: String,
    consecutive_timeouts: u32,
}

/// `evaluateVerifyPredicate`.
fn evaluate(predicate: &Map<String, Value>, observation: &Observation) -> Status {
    let text = |key: &str| predicate.get(key).and_then(Value::as_str);
    if let Some(wanted) = predicate.get("window_exists").and_then(Value::as_bool) {
        return if observation.exists == wanted { Status::Satisfied } else { Status::Unsatisfied };
    }
    if !observation.exists {
        return Status::Unknown;
    }
    if let Some(wanted) = text("present") {
        if observation.haystack.contains(&js_to_lowercase(wanted)) {
            return Status::Satisfied;
        }
        return if observation.text_complete { Status::Unsatisfied } else { Status::Unknown };
    }
    if let Some(unwanted) = text("absent") {
        if observation.haystack.contains(&js_to_lowercase(unwanted)) {
            return Status::Unsatisfied;
        }
        return if observation.text_complete { Status::Satisfied } else { Status::Unknown };
    }
    if let Some(part) = text("title_contains") {
        return if js_to_lowercase(&observation.title).contains(&js_to_lowercase(part)) { Status::Satisfied } else { Status::Unsatisfied };
    }
    Status::Unknown
}

/// `verifyUnknownReason`: why a text predicate could not be decided, and what to change.
fn unknown_reason(needs_text: bool, state: &State, gave_up: Option<GiveUp>) -> Option<(&'static str, &'static str)> {
    if state.provider_error.contains(INTEGRITY_BLOCK_CODE) {
        return Some((INTEGRITY_BLOCK_CODE, "Windows hides this window's text from a lower-integrity host; capture it for pixels or OCR, or verify title_contains/window_exists instead"));
    }
    if gave_up == Some(GiveUp::RepeatedTimeouts) {
        return Some(("provider_timeout", "consecutive window reads timed out, so verify stopped before its deadline instead of restarting the provider again; the window may be busy, so capture it or verify title_contains/window_exists"));
    }
    if state.provider_error.contains(TIMEOUT_CODE) {
        return Some(("provider_timeout", "the latest window read did not answer within its budget and the deadline passed without a decision; the window may be busy, so retry with a longer timeout_ms or verify title_contains/window_exists"));
    }
    if !state.provider_error.is_empty() {
        return Some(("provider_error", "the latest window read failed and the deadline passed without a decision; see provider_error, retry, or verify title_contains/window_exists"));
    }
    if !needs_text || state.text_complete {
        return None;
    }
    if state.observed_elements > 0 {
        Some(("element_text_incomplete", "the provider did not complete its element-text read; capture the window for visible evidence, or verify title_contains/window_exists instead"))
    } else {
        Some(("element_text_empty", "the window published no element text, which never proves a string is absent; capture the window to see what it exposes"))
    }
}

/// `screenshotInteger`: an absent field is the default, anything else must be an integer in range.
fn bounded(command: &Map<String, Value>, key: &str, default: u64, min: u64, max: u64) -> Result<u64, ComputerError> {
    let Some(value) = command.get(key) else { return Ok(default) };
    let integer = value.as_u64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).map(|f| f as u64));
    match integer {
        Some(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(ComputerError::InvalidInput { reason: format!("{key} must be an integer from {min} to {max}") }),
    }
}

/// `verifyPredicates`: 1..8 predicate objects.
fn predicates_of(command: &Map<String, Value>) -> Result<Vec<Map<String, Value>>, ComputerError> {
    let predicates: Vec<Map<String, Value>> =
        command.get("expect").and_then(Value::as_array).into_iter().flatten().filter_map(|entry| entry.as_object().cloned()).collect();
    if predicates.is_empty() || predicates.len() > 8 {
        return Err(ComputerError::InvalidInput { reason: "verify requires 1..8 predicates".into() });
    }
    Ok(predicates)
}

/// An element's `name value` text, as the predicates and the sample read it.
fn name_value(element: &Value) -> String {
    let field = |key: &str| element.get(key).and_then(Value::as_str).unwrap_or_default();
    format!("{} {}", field("name"), field("value"))
}

/// `elementTextSample`: what an undecided text wait returns of the last read.
fn text_sample(elements: &[Value]) -> Vec<String> {
    let mut sample: Vec<String> = Vec::new();
    for element in elements {
        // The JS whitespace collapse, trim and 60-unit slice, with JS's whitespace and UTF-16 units.
        let text = slice_utf16(&js_words(&name_value(element)).collect::<Vec<_>>().join(" "), TEXT_SAMPLE_CHARS);
        if text.is_empty() || sample.contains(&text) {
            continue;
        }
        sample.push(text);
        if sample.len() >= TEXT_SAMPLE_ENTRIES {
            break;
        }
    }
    sample
}

fn error_message(error: &ComputerError) -> String {
    match error {
        ComputerError::Failed { message, .. } => message.clone(),
        ComputerError::Unavailable { reason } | ComputerError::InvalidInput { reason } => reason.clone(),
        ComputerError::Denied => "denied".into(),
        ComputerError::Cancelled => "cancelled".into(),
    }
}

/// `failSample`: a failed read is unknown, not a verdict; only an integrity block cannot change with time, so only it stops the
/// wait. Returns whether it did.
fn fail_sample(state: &mut State, message: String) -> bool {
    state.statuses.fill(Status::Unknown);
    state.consecutive = 0;
    state.consecutive_timeouts = if message.contains(TIMEOUT_CODE) { state.consecutive_timeouts + 1 } else { 0 };
    let blocked = message.contains(INTEGRITY_BLOCK_CODE);
    state.provider_error = message;
    blocked
}

/// `samplePredicates`: one read judged against every predicate. Err stops the whole call (cancel, denial); Ok(true) is an
/// integrity block.
async fn sample(
    reader: &dyn Reader,
    command: &Map<String, Value>,
    predicates: &[Map<String, Value>],
    needs_text: bool,
    state: &mut State,
    provider_timeout: Duration,
    cancel: &CancellationToken,
) -> Result<bool, ComputerError> {
    let mut read = Map::new();
    read.insert("action".into(), json!("window_predicates"));
    for key in ["window", "window_id"] {
        read.insert(key.into(), command.get(key).cloned().unwrap_or(Value::Null));
    }
    read.insert("max_elements".into(), json!(MAX_ELEMENTS));
    read.insert("include_elements".into(), json!(needs_text));
    read.insert("read_only".into(), json!(true));
    read.insert("pointer_feedback".into(), json!(false));
    state.attempts += 1;
    let result = match reader.read(read, provider_timeout, cancel).await {
        Ok(result) => result,
        Err(error @ (ComputerError::Cancelled | ComputerError::Denied)) => return Err(error),
        Err(error) => return Ok(fail_sample(state, error_message(&error))),
    };
    state.samples += 1;
    state.provider_error.clear();
    state.consecutive_timeouts = 0;
    let elements: &[Value] = result.get("elements").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    state.observed_elements = elements.len();
    state.text_complete = result.get("text_complete") == Some(&Value::Bool(true)) && !elements.is_empty();
    state.title = result.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
    state.exists = result.get("exists") != Some(&Value::Bool(false));
    state.text_sample = text_sample(elements);
    let observation = Observation {
        exists: state.exists,
        title: state.title.clone(),
        haystack: js_to_lowercase(&elements.iter().map(name_value).collect::<Vec<_>>().join("\n")),
        text_complete: state.text_complete,
    };
    state.statuses = predicates.iter().map(|predicate| evaluate(predicate, &observation)).collect();
    state.consecutive = if state.statuses.iter().all(|status| *status == Status::Satisfied) { state.consecutive + 1 } else { 0 };
    Ok(false)
}

/// `verifyWindowState`: the verdict as the JSON text the model reads.
async fn verify(reader: &dyn Reader, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<String, ComputerError> {
    let started = Instant::now();
    let predicates = predicates_of(command)?;
    let timeout_ms = bounded(command, "timeout_ms", DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS)?;
    let stable_samples = bounded(command, "stable_samples", DEFAULT_STABLE_SAMPLES, 1, 5)?;
    let deadline = started + Duration::from_millis(timeout_ms);
    let needs_text = predicates.iter().any(|p| p.get("present").is_some_and(Value::is_string) || p.get("absent").is_some_and(Value::is_string));
    let mut state = State {
        attempts: 0,
        samples: 0,
        consecutive: 0,
        statuses: vec![Status::Unknown; predicates.len()],
        title: String::new(),
        exists: true,
        observed_elements: 0,
        text_complete: false,
        text_sample: Vec::new(),
        provider_error: String::new(),
        consecutive_timeouts: 0,
    };
    let window_id = command.get("window_id").and_then(Value::as_str).filter(|id| !id.is_empty());
    let mut gave_up = None;
    // A closed exact window never reopens under the same handle, so an unmet predicate can no longer change.
    let mut target_closed = false;
    loop {
        if cancel.is_cancelled() {
            return Err(ComputerError::Cancelled);
        }
        let now = Instant::now();
        // The deadline is not a provider-health deadline: even a one-shot read gets its normal bounded budget.
        if state.attempts > 0 && now >= deadline {
            break;
        }
        let left = deadline.saturating_duration_since(now).as_millis() as u64;
        let provider_timeout = Duration::from_millis(left.clamp(PROVIDER_MIN_TIMEOUT_MS, PROVIDER_MAX_TIMEOUT_MS));
        if sample(reader, command, &predicates, needs_text, &mut state, provider_timeout, cancel).await? {
            break;
        }
        if state.consecutive >= stable_samples {
            break;
        }
        if window_id.is_some() && !state.exists && state.statuses.iter().any(|s| *s != Status::Satisfied) {
            target_closed = true;
            break;
        }
        // Only a text read is worth abandoning: a title-only predicate reads no tree.
        if needs_text && state.consecutive_timeouts >= TIMEOUT_GIVE_UP_READS {
            gave_up = Some(GiveUp::RepeatedTimeouts);
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        sleep(Duration::from_millis(POLL_INTERVAL_MS).min(deadline - now).max(Duration::from_millis(1))).await;
    }
    let decision = if state.consecutive >= stable_samples {
        Status::Satisfied
    } else if state.statuses.contains(&Status::Unknown) {
        Status::Unknown
    } else {
        Status::Unsatisfied
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), json!(decision == Status::Satisfied));
    payload.insert("action".into(), json!("verify"));
    payload.insert("decision".into(), json!(decision.as_str()));
    if let Some(id) = window_id {
        payload.insert("window_id".into(), json!(id));
    }
    if !state.title.is_empty() {
        payload.insert("title".into(), json!(state.title));
    }
    payload.insert("samples".into(), json!(state.samples));
    payload.insert("stable_samples".into(), json!(stable_samples));
    payload.insert("observed_elements".into(), json!(state.observed_elements));
    if needs_text {
        payload.insert("text_complete".into(), json!(state.text_complete));
    }
    if target_closed {
        payload.insert("target_closed".into(), json!(true));
        payload.insert("unknown_hint".into(), json!("the exact window closed before the wait was decided; list windows to find its replacement"));
    } else if decision == Status::Unknown
        && let Some((reason, hint)) = unknown_reason(needs_text, &state, gave_up)
    {
        payload.insert("unknown_reason".into(), json!(reason));
        payload.insert("unknown_hint".into(), json!(hint));
        if gave_up.is_some() {
            payload.insert("gave_up_early".into(), json!(true));
        }
    }
    if decision != Status::Satisfied && needs_text && !state.text_sample.is_empty() {
        payload.insert("observed_text_sample".into(), json!(state.text_sample));
    }
    if !state.provider_error.is_empty() {
        payload.insert("provider_error".into(), json!(state.provider_error));
    }
    let results: Vec<Value> = predicates.iter().zip(&state.statuses).map(|(predicate, status)| json!({ "predicate": predicate, "status": status.as_str() })).collect();
    payload.insert("results".into(), json!(results));
    payload.insert("timings_ms".into(), json!({ "total_ms": started.elapsed().as_millis() as u64 }));
    Ok(Value::Object(payload).to_string())
}

/// `verify`: polls `window_predicates` and replies the verdict.
pub(super) async fn run(backend: &ProcessComputerBackend, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
    Ok(vec![ToolPart::Text(verify(backend, &command, cancel).await?)])
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Replies from a script; the last one repeats.
    struct Fake {
        replies: Mutex<Vec<Result<Map<String, Value>, ComputerError>>>,
        calls: Mutex<Vec<Map<String, Value>>>,
    }

    impl Fake {
        fn new(replies: Vec<Result<Value, ComputerError>>) -> Self {
            let replies = replies.into_iter().map(|r| r.map(|v| v.as_object().cloned().expect("object"))).collect();
            Self { replies: Mutex::new(replies), calls: Mutex::new(Vec::new()) }
        }

        fn call_count(&self) -> usize {
            self.calls.lock().expect("calls").len()
        }
    }

    #[async_trait]
    impl Reader for Fake {
        async fn read(&self, command: Map<String, Value>, _timeout: Duration, _cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
            self.calls.lock().expect("calls").push(command);
            let mut replies = self.replies.lock().expect("replies");
            if replies.len() > 1 { replies.remove(0) } else { replies[0].clone() }
        }
    }

    fn read(title: &str, names: &[&str], complete: bool) -> Result<Value, ComputerError> {
        let elements: Vec<Value> = names.iter().map(|n| json!({ "name": n, "value": "" })).collect();
        Ok(json!({ "exists": true, "title": title, "elements": elements, "text_complete": complete }))
    }

    fn timed_out() -> Result<Value, ComputerError> {
        Err(ComputerError::Failed { code: TIMEOUT_CODE.into(), message: format!("{TIMEOUT_CODE}: command exceeded 2000ms") })
    }

    async fn run_verify(fake: &Fake, command: Value) -> Result<Value, ComputerError> {
        let command = command.as_object().cloned().expect("object");
        verify(fake, &command, &CancellationToken::new()).await.map(|text| serde_json::from_str(&text).expect("json"))
    }

    #[tokio::test(start_paused = true)]
    async fn met_on_the_third_sample_with_two_stable() {
        let fake = Fake::new(vec![read("Notepad", &["x"], true), read("Notepad", &["hello"], true), read("Notepad", &["hello"], true), read("Notepad", &["hello"], true)]);
        let out = run_verify(&fake, json!({ "expect": [{ "present": "HELLO" }], "stable_samples": 2 })).await.expect("verdict");
        assert_eq!(out["decision"], "satisfied");
        assert_eq!(out["ok"], true);
        assert_eq!(out["samples"], 3);
        assert_eq!(fake.call_count(), 3);
        assert_eq!(fake.calls.lock().expect("calls")[0]["include_elements"], true);
    }

    #[tokio::test(start_paused = true)]
    async fn absent_without_complete_text_is_unknown() {
        let fake = Fake::new(vec![read("Notepad", &["a"], false)]);
        let out = run_verify(&fake, json!({ "expect": [{ "absent": "gone" }], "timeout_ms": 600 })).await.expect("verdict");
        assert_eq!(out["decision"], "unknown");
        assert_eq!(out["unknown_reason"], "element_text_incomplete");
        assert_eq!(out["text_complete"], false);
        assert_eq!(out["observed_text_sample"], json!(["a"]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_is_gone_is_window_exists_false() {
        let gone = || Fake::new(vec![Ok(json!({ "exists": false, "title": "", "elements": [] }))]);
        let fake = gone();
        let out = run_verify(&fake, json!({ "expect": [{ "window_exists": false }], "window_id": "w1", "stable_samples": 1 })).await.expect("verdict");
        assert_eq!(out["decision"], "satisfied");
        assert_eq!(fake.calls.lock().expect("calls")[0]["include_elements"], false);
        let out = run_verify(&gone(), json!({ "expect": [{ "window_exists": true }], "window_id": "w1" })).await.expect("verdict");
        assert_eq!(out["decision"], "unsatisfied");
        assert_eq!(out["target_closed"], true);
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_timed_out_reads_give_up_early() {
        let fake = Fake::new(vec![timed_out()]);
        let out = run_verify(&fake, json!({ "expect": [{ "present": "x" }], "timeout_ms": 30000 })).await.expect("verdict");
        assert_eq!(out["decision"], "unknown");
        assert_eq!(out["unknown_reason"], "provider_timeout");
        assert_eq!(out["gave_up_early"], true);
        assert_eq!(fake.call_count(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_integrity_block_stops_the_wait() {
        let fake = Fake::new(vec![Err(ComputerError::Failed { code: INTEGRITY_BLOCK_CODE.into(), message: format!("{INTEGRITY_BLOCK_CODE}: this window runs higher") })]);
        let out = run_verify(&fake, json!({ "expect": [{ "present": "x" }] })).await.expect("verdict");
        assert_eq!(out["unknown_reason"], INTEGRITY_BLOCK_CODE);
        assert_eq!(fake.call_count(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_predicates_and_options_are_refused() {
        let fake = Fake::new(vec![read("t", &[], true)]);
        for command in [json!({}), json!({ "expect": [] }), json!({ "expect": vec![json!({ "present": "a" }); 9] })] {
            let error = run_verify(&fake, command).await.expect_err("refused");
            assert_eq!(error_message(&error), "verify requires 1..8 predicates");
        }
        let error = run_verify(&fake, json!({ "expect": [{ "present": "a" }], "timeout_ms": 30001 })).await.expect_err("refused");
        assert_eq!(error_message(&error), "timeout_ms must be an integer from 0 to 30000");
        let error = run_verify(&fake, json!({ "expect": [{ "present": "a" }], "stable_samples": 0 })).await.expect_err("refused");
        assert_eq!(error_message(&error), "stable_samples must be an integer from 1 to 5");
        assert_eq!(fake.call_count(), 0);
    }

    #[test]
    fn predicates_are_judged_as_node_judges_them() {
        let seen = Observation { exists: true, title: "Notepad".into(), haystack: "saved".into(), text_complete: true };
        let gone = Observation { exists: false, title: String::new(), haystack: String::new(), text_complete: false };
        let judge = |p: Value, o: &Observation| evaluate(p.as_object().expect("object"), o);
        assert_eq!(judge(json!({ "present": "saved" }), &seen), Status::Satisfied);
        assert_eq!(judge(json!({ "present": "saving" }), &seen), Status::Unsatisfied);
        assert_eq!(judge(json!({ "absent": "saving" }), &seen), Status::Satisfied);
        assert_eq!(judge(json!({ "absent": "saved" }), &seen), Status::Unsatisfied);
        assert_eq!(judge(json!({ "title_contains": "notepad" }), &seen), Status::Satisfied);
        assert_eq!(judge(json!({ "window_exists": false }), &gone), Status::Satisfied);
        assert_eq!(judge(json!({ "window_exists": true }), &gone), Status::Unsatisfied);
        assert_eq!(judge(json!({ "present": "saved" }), &gone), Status::Unknown);
    }
}
