//! Owner: s4-engine-settle
//! The `expect` of a command: text that must appear, text that must be gone, and/or a URL fragment, checked the same way
//! before or after the action (`postcondition.ts`), and the explicit `settleMs` delay. Nothing here waits; the wait is
//! `reply_wait`.

use std::fmt;
use std::time::Duration;

use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use serde_json::Value;

const DEFAULT_POSTCONDITION_TIMEOUT_MS: i64 = 5_000;
const MIN_POSTCONDITION_TIMEOUT_MS: i64 = 500;
const MAX_POSTCONDITION_TIMEOUT_MS: i64 = 20_000;
const MAX_EXPLICIT_SETTLE_MS: i64 = 5_000;

/// A caller's `expect` or `settleMs` that cannot be read (the text of the TypeError the old engine threw).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectError(pub String);

impl fmt::Display for ExpectError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for ExpectError {}

/// A normalised `expect`: empty strings mean "not asked", and at least one of the three is not empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Postcondition {
    pub text: String,
    pub text_gone: String,
    pub url: String,
    /// How long it may take to become true (500 ms to 20 s, default 5 s).
    pub timeout: Duration,
}

/// What a postcondition is checked against.
#[derive(Debug, Clone, Copy)]
pub struct PageSample<'a> {
    /// `None` means the text was not observed, never an observed empty document.
    pub text: Option<&'a str>,
    pub url: &'a str,
}

/// The three conditions without a time limit: what [`matches`] and [`describe`] read.
#[derive(Debug, Clone, Copy)]
pub struct Expected<'a> {
    pub text: &'a str,
    pub text_gone: &'a str,
    pub url: &'a str,
}

impl Postcondition {
    pub fn expected(&self) -> Expected<'_> {
        Expected { text: &self.text, text_gone: &self.text_gone, url: &self.url }
    }
}

/// `Number.isFinite` of a JSON value; `None` for anything that is not a finite number.
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

/// `Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : fallback))`.
fn bounded_integer(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    let number = value.and_then(finite).map_or(fallback, |number| number.trunc().clamp(i64::MIN as f64, i64::MAX as f64) as i64);
    number.max(min).min(max)
}

fn optional_string(raw: &serde_json::Map<String, Value>, name: &str) -> Result<String, ExpectError> {
    match raw.get(name) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => Ok(js_trim(text).to_string()),
        Some(_) => Err(ExpectError(format!("expect.{name} must be a string"))),
    }
}

/// `normalizeBrowserPostcondition`: `None` when the command has no `expect`.
pub fn normalize(raw: Option<&Value>) -> Result<Option<Postcondition>, ExpectError> {
    let raw = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(ExpectError("expect must be an object".into())),
    };
    let text = optional_string(raw, "text")?;
    let text_gone = optional_string(raw, "textGone")?;
    let url = optional_string(raw, "url")?;
    if text.is_empty() && text_gone.is_empty() && url.is_empty() {
        return Err(ExpectError("expect requires text, textGone, and/or url".into()));
    }
    let timeout = raw.get("timeoutMs");
    if timeout.is_some_and(|value| finite(value).is_none()) {
        return Err(ExpectError("expect.timeoutMs must be a finite number".into()));
    }
    let millis = bounded_integer(timeout, DEFAULT_POSTCONDITION_TIMEOUT_MS, MIN_POSTCONDITION_TIMEOUT_MS, MAX_POSTCONDITION_TIMEOUT_MS);
    Ok(Some(Postcondition { text, text_gone, url, timeout: Duration::from_millis(millis as u64) }))
}

/// `normalizeBrowserSettleMs`: the explicit delay a command asked for, 0 to 5 s.
pub fn normalize_settle_ms(raw: Option<&Value>) -> Result<Duration, ExpectError> {
    let raw = match raw {
        None | Some(Value::Null) => return Ok(Duration::ZERO),
        Some(value) => value,
    };
    if finite(raw).is_none() {
        return Err(ExpectError("settleMs must be a finite number".into()));
    }
    Ok(Duration::from_millis(bounded_integer(Some(raw), 0, 0, MAX_EXPLICIT_SETTLE_MS) as u64))
}

/// Page text keeps the document's own spacing: an indent, a run of spaces, or a non-breaking space where the caller wrote one
/// plain space. Runs of horizontal whitespace collapse on both sides, while line breaks stay: two blocks the reader sees on
/// separate lines are not one phrase.
fn comparable_text(value: &str) -> String {
    let lines: Vec<String> = value
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let mut collapsed = String::with_capacity(line.len());
            let mut in_run = false;
            for character in line.chars() {
                if is_js_space(character) && character != '\r' {
                    if !in_run {
                        collapsed.push(' ');
                    }
                    in_run = true;
                } else {
                    collapsed.push(character);
                    in_run = false;
                }
            }
            js_trim(&collapsed).to_string()
        })
        .collect();
    js_to_lowercase(&lines.join("\n"))
}

/// `browserPostconditionMatches`.
pub fn matches(expected: Expected<'_>, state: PageSample<'_>) -> bool {
    let text = state.text.map(comparable_text);
    let url = js_to_lowercase(state.url);
    (expected.text.is_empty() || text.as_ref().is_some_and(|text| text.contains(&comparable_text(expected.text))))
        && (expected.text_gone.is_empty() || text.as_ref().is_some_and(|text| !text.contains(&comparable_text(expected.text_gone))))
        && (expected.url.is_empty() || url.contains(&js_to_lowercase(expected.url)))
}

/// `describeBrowserPostcondition`: `text "Saved" and textGone "Loading" and url "/complete"`.
pub fn describe(expected: Expected<'_>) -> String {
    let quote = |value: &str| serde_json::to_string(value).unwrap_or_default();
    let mut parts = Vec::new();
    if !expected.text.is_empty() {
        parts.push(format!("text {}", quote(expected.text)));
    }
    if !expected.text_gone.is_empty() {
        parts.push(format!("textGone {}", quote(expected.text_gone)));
    }
    if !expected.url.is_empty() {
        parts.push(format!("url {}", quote(expected.url)));
    }
    parts.join(" and ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample<'a>(text: Option<&'a str>, url: &'a str) -> PageSample<'a> {
        PageSample { text, url }
    }

    fn only<'a>(text: &'a str, text_gone: &'a str, url: &'a str) -> Expected<'a> {
        Expected { text, text_gone, url }
    }

    #[test]
    fn postconditions_normalize_bounded_waits_and_match_text_plus_url() {
        let expected = normalize(Some(&json!({"text": "Saved", "textGone": "Loading", "url": "/complete", "timeoutMs": 90_000}))).expect("valid").expect("some");
        assert_eq!(
            expected,
            Postcondition { text: "Saved".into(), text_gone: "Loading".into(), url: "/complete".into(), timeout: Duration::from_millis(20_000) }
        );
        assert!(matches(expected.expected(), sample(Some("Saved successfully"), "https://example.test/complete?locale=ko")));
        assert!(!matches(expected.expected(), sample(Some("Loading \u{2014} Saved successfully"), "https://example.test/complete")));
        assert_eq!(describe(expected.expected()), "text \"Saved\" and textGone \"Loading\" and url \"/complete\"");
        let short = normalize(Some(&json!({"text": "x", "timeoutMs": 1}))).expect("valid").expect("some");
        assert_eq!(short.timeout, Duration::from_millis(500));
        let default = normalize(Some(&json!({"url": "x"}))).expect("valid").expect("some");
        assert_eq!(default.timeout, Duration::from_millis(5_000));
    }

    #[test]
    fn empty_contracts_are_rejected_and_explicit_settle_delays_are_bounded() {
        assert_eq!(normalize(None), Ok(None));
        assert_eq!(normalize(Some(&Value::Null)), Ok(None));
        assert!(normalize(Some(&json!({}))).unwrap_err().0.contains("requires text"));
        assert!(normalize(Some(&json!({"text": 1}))).unwrap_err().0.contains("must be a string"));
        assert!(normalize(Some(&json!([]))).unwrap_err().0.contains("must be an object"));
        assert!(normalize(Some(&json!({"text": "a", "timeoutMs": "5"}))).unwrap_err().0.contains("finite number"));
        assert_eq!(normalize(Some(&json!({"text": "  "}))).unwrap_err().0, "expect requires text, textGone, and/or url");
        assert_eq!(normalize_settle_ms(Some(&json!(-1))), Ok(Duration::ZERO));
        assert_eq!(normalize_settle_ms(Some(&json!(20_000))), Ok(Duration::from_millis(5_000)));
        assert_eq!(normalize_settle_ms(Some(&json!(250.9))), Ok(Duration::from_millis(250)));
        assert_eq!(normalize_settle_ms(None), Ok(Duration::ZERO));
        assert!(normalize_settle_ms(Some(&json!("5"))).unwrap_err().0.contains("finite number"));
    }

    #[test]
    fn an_unobserved_document_cannot_satisfy_text_absence_while_url_only_checks_need_no_text() {
        assert!(!matches(only("", "Saving", ""), sample(None, "https://example.test/")));
        assert!(!matches(only("Saved", "", ""), sample(None, "https://example.test/")));
        assert!(matches(only("", "Saving", ""), sample(Some(""), "https://example.test/")));
        assert!(matches(only("", "", "/COMPLETE"), sample(None, "https://example.test/complete")));
        assert!(matches(only("SAVED", "LOADING", ""), sample(Some("Saved"), "")));
    }

    #[test]
    fn a_text_condition_reads_a_phrase_through_page_spacing_but_never_across_separate_lines() {
        assert!(matches(only("Order placed successfully", "", ""), sample(Some("Order placed\u{a0}  successfully"), "")));
        assert!(!matches(only("Role designer", "", ""), sample(Some("Preferred role\nDesigner"), "")));
        assert!(!matches(only("", "Still  saving", ""), sample(Some("Still saving"), "")));
        assert!(matches(only("a\nb", "", ""), sample(Some("a  \r\n  b"), "")));
    }
}
