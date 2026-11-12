//! Claude capabilities given per model family from a first version on, so every later version of a
//! family inherits them (`claudeCapabilityByFloor`, `shared/llm/anthropic-thinking-contract.mjs`), and
//! the process-wide record of the models that rejected one (`anthropic-capability-fallback.mjs`): a
//! floor can say "yes" to a model the API refuses, so the refused feature is switched off for that
//! model and the request replayed once without it.
//!
//! The answers equal Node's for the whole recorded table (`fixtures/claude-floors`, recorded by
//! `benchmarks/rust-core/recorders/record-claude-floors.mjs`).

use std::collections::HashSet;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use regex::Regex;

/// Family → first `(major, minor)` with the capability; `exceptions` fix the answer of an id (as
/// [`model_key`] gives it) the floors cannot express. A family without a floor stays off.
pub struct Floors {
    pub floors: &'static [(&'static str, (u32, u32))],
    pub exceptions: &'static [(&'static str, bool)],
}

/// Tool preambles written as progress-update thinking blocks (`ANTHROPIC_PROGRESS_UPDATES`).
pub const PROGRESS_UPDATES: Floors = Floors {
    floors: &[("opus", (5, 5)), ("sonnet", (5, 5)), ("fable", (5, 0)), ("mythos", (5, 1))],
    exceptions: &[],
};

/// Turn-scoped `clear_at` system messages (`ANTHROPIC_TURN_SCOPED_SYSTEM`).
pub const TURN_SCOPED_SYSTEM: Floors = Floors {
    floors: &[("opus", (4, 8)), ("sonnet", (5, 5)), ("haiku", (5, 5)), ("fable", (5, 0)), ("mythos", (5, 0))],
    exceptions: &[],
};

/// Message threads (`ANTHROPIC_MESSAGE_THREADS`); `claude-mythos-preview` carries no version.
pub const MESSAGE_THREADS: Floors = Floors {
    floors: &[("opus", (4, 5)), ("sonnet", (4, 5)), ("haiku", (4, 5)), ("fable", (5, 0)), ("mythos", (5, 0))],
    exceptions: &[("claude-mythos-preview", true)],
};

/// `claudeModelKey`: trimmed, lowercased, dots folded to dashes, a release date (`-20251001`,
/// `-2025-10-01`) dropped.
pub fn model_key(model: &str) -> String {
    let key = js_to_lowercase(js_trim(model)).replace('.', "-");
    // The date is ASCII, so the `-` it starts with is a char boundary.
    let tail_is = |shape: &[u8]| {
        key.len() >= shape.len()
            && key.as_bytes()[key.len() - shape.len()..]
                .iter()
                .zip(shape)
                .all(|(b, s)| if *s == b'd' { b.is_ascii_digit() } else { b == s })
    };
    for shape in [&b"-dddddddd"[..], &b"-dddd-dd-dd"[..]] {
        if tail_is(shape) {
            return key[..key.len() - shape.len()].to_owned();
        }
    }
    key
}

/// `claudeFamilyVersion`: family and `(major, minor)` of `claude-<family>-<major>[-<minor>]` (ASCII digits, minor one or
/// two) after [`model_key`]; `None` for every other shape. The digits are read as JavaScript's `Number` reads them: the
/// nearest double, a major past its range infinite.
pub fn family_version(model: &str) -> Option<(String, f64, f64)> {
    let key = model_key(model);
    let rest = key.strip_prefix("claude-")?;
    let (family, version) = rest.split_once('-')?;
    if family.is_empty() || !family.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let (major, minor) = match version.split_once('-') {
        Some((major, minor)) => (major, Some(minor)),
        None => (version, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(major) || minor.is_some_and(|m| !digits(m) || m.len() > 2) {
        return None;
    }
    // Rust's decimal reading rounds to the nearest double as `Number` does and is infinite past the range.
    let number = |s: &str| s.parse::<f64>().unwrap_or(f64::INFINITY);
    Some((family.to_owned(), number(major), minor.map_or(0.0, number)))
}

/// `claudeVersionAtLeast`: `(major, minor)` at or after `(min_major, min_minor)`.
pub fn version_at_least((major, minor): (f64, f64), (min_major, min_minor): (u32, u32)) -> bool {
    let (min_major, min_minor) = (f64::from(min_major), f64::from(min_minor));
    major > min_major || (major == min_major && minor >= min_minor)
}

/// `claudeCapabilityByFloor`.
pub fn by_floor(model: &str, table: &Floors) -> bool {
    let key = model_key(model);
    if let Some((_, answer)) = table.exceptions.iter().find(|(id, _)| *id == key) {
        return *answer;
    }
    let Some((family, major, minor)) = family_version(&key) else { return false };
    table.floors.iter().find(|(f, _)| *f == family).is_some_and(|(_, floor)| version_at_least((major, minor), *floor))
}

/// `emitsAnthropicProgressUpdates`.
pub fn emits_progress_updates(model: &str) -> bool {
    by_floor(model, &PROGRESS_UPDATES)
}

/// `supportsAnthropicTurnScopedSystemMessages`.
pub fn supports_turn_scoped_system_messages(model: &str) -> bool {
    by_floor(model, &TURN_SCOPED_SYSTEM)
}

/// `threadsSupportModel`.
pub fn threads_support_model(model: &str) -> bool {
    by_floor(model, &MESSAGE_THREADS)
}

/// A floor feature a model can reject (`anthropic-capability-fallback.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    ProgressUpdates,
    TurnScopedSystem,
    /// Switched off by the threads' own rejection classifier (`anthropic-message-threads.mjs` `disableModel`), never
    /// by [`rejection`].
    MessageThreads,
}

impl Feature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProgressUpdates => "progressUpdates",
            Self::TurnScopedSystem => "turnScopedSystem",
            Self::MessageThreads => "messageThreads",
        }
    }
}

// The API's error shapes for a field the model does not take ("messages.1.clear_at: Extra inputs are not
// permitted", "thinking.adaptive.display: …") or for its beta header; ASCII case-insensitive as Node's `/i`.
static PROGRESS_REJECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bthinking\.(?:adaptive\.)?display\b|thinking-display-updates").expect("static pattern"));
static TURN_SCOPED_REJECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)clear[_-]at|turn-scoped").expect("static pattern"));
// What a turn-scoped message may hold: the model takes the message.
static TURN_SCOPED_CONTENT_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)supports text blocks only|not permitted on a turn-scoped").expect("static pattern"));

/// `anthropicCapabilityRejection`: the floor feature a provider rejection names.
pub fn rejection(status: Option<u16>, text: &str) -> Option<Feature> {
    if status != Some(400) {
        return None;
    }
    if PROGRESS_REJECTION.is_match(text) {
        return Some(Feature::ProgressUpdates);
    }
    (TURN_SCOPED_REJECTION.is_match(text) && !TURN_SCOPED_CONTENT_RULE.is_match(text)).then_some(Feature::TurnScopedSystem)
}

static UNSUPPORTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

fn unsupported_key(feature: Feature, provider: &str, model: &str) -> String {
    format!("{}:{provider}:{}", feature.as_str(), model_key(model))
}

/// `anthropicCapabilityEnabled`: false once `model` rejected `feature` on `provider` in this process.
pub fn enabled(feature: Feature, provider: &str, model: &str) -> bool {
    !UNSUPPORTED.lock().unwrap_or_else(PoisonError::into_inner).contains(&unsupported_key(feature, provider, model))
}

/// `markAnthropicCapabilityUnsupported`.
pub fn mark_unsupported(feature: Feature, provider: &str, model: &str) {
    UNSUPPORTED.lock().unwrap_or_else(PoisonError::into_inner).insert(unsupported_key(feature, provider, model));
}

/// The switch-offs as a new process has them (none): a replay of a recording Node made in a fresh process starts here.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_process() {
    UNSUPPORTED.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/claude-floors/golden.json")).expect("fixture")
    }

    /// A version number as the recording holds it: the text `JSON.stringify` writes for it (an integer's digits, `null`
    /// for an infinite one) read back by serde_json, which is what the golden's number was read as.
    fn as_recorded(number: f64) -> Value {
        if number.is_infinite() {
            return Value::Null;
        }
        serde_json::from_str(&format!("{number}")).expect("a finite number's digits")
    }

    /// Every predicate, the key and the family version they read, for the whole recorded id table.
    #[test]
    fn the_floors_answer_as_node_for_the_whole_recorded_table() {
        let golden = golden();
        let recorded = golden["predicates"].as_array().expect("predicates");
        let ours: Vec<Value> = recorded
            .iter()
            .map(|row| {
                let model = row["model"].as_str().expect("model");
                json!({
                    "model": model,
                    "key": model_key(model),
                    "familyVersion": family_version(model).map(|(family, major, minor)| json!([family, as_recorded(major), as_recorded(minor)])),
                    "progressUpdates": emits_progress_updates(model),
                    "turnScopedSystem": supports_turn_scoped_system_messages(model),
                    "messageThreads": threads_support_model(model),
                })
            })
            .collect();
        assert_eq!(&ours, recorded);
    }

    #[test]
    fn rejections_name_the_feature_node_names() {
        let golden = golden();
        let recorded = golden["rejections"].as_array().expect("rejections");
        let ours: Vec<Value> = recorded
            .iter()
            .map(|row| {
                let status = row["status"].as_u64().map(|s| u16::try_from(s).expect("status"));
                let text = row["text"].as_str().expect("text");
                json!({ "status": row["status"], "text": text, "feature": rejection(status, text).map(Feature::as_str) })
            })
            .collect();
        assert_eq!(&ours, recorded);
    }
}

/// `claudeGeneration` (`anthropic-thinking-contract.mjs`): major*100 + minor of the version
/// token, `INFINITY` for a claude id without one, `None` for a non-claude id.
pub fn claude_generation(model: &str) -> Option<f64> {
    let normalized = model.to_lowercase().replace('.', "-");
    let id = &normalized[normalized.find("claude-")?..];
    // The two version patterns, `^claude-<family>-<ver>` and `^claude-<ver>`; both read
    // `<major>(-<minor 1-2 digits, not followed by a digit>)?` ending at `-`, `@` or the end.
    let version = |rest: &str| -> Option<f64> {
        let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
        let major_len = digits(rest);
        if major_len == 0 {
            return None;
        }
        let ends = |s: &str| s.is_empty() || s.starts_with('-') || s.starts_with('@');
        let major: f64 = rest[..major_len].parse().ok()?;
        let after = &rest[major_len..];
        if let Some(tail) = after.strip_prefix('-') {
            let minor_len = digits(tail);
            if (1..=2).contains(&minor_len) && ends(&tail[minor_len..]) {
                return Some(major * 100.0 + tail[..minor_len].parse::<f64>().ok()?);
            }
        }
        ends(after).then_some(major * 100.0)
    };
    let after_claude = &id["claude-".len()..];
    let family_first = after_claude.split_once('-').and_then(|(family, rest)| {
        let mut chars = family.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        valid.then(|| version(rest)).flatten()
    });
    Some(family_first.or_else(|| version(after_claude)).unwrap_or(f64::INFINITY))
}

/// `CLAUDE_GENERATION_FLOOR.xhighEffort` / `.maxEffort`.
pub const XHIGH_FLOOR: f64 = 407.0;
pub const MAX_FLOOR: f64 = 405.0;
/// `.adaptiveEffort`: adaptive thinking and `output_config.effort` from here on.
pub const ADAPTIVE_FLOOR: f64 = 406.0;
/// `.manualThinkingRejected`: `thinking: {type: "enabled", budget_tokens}` is refused from here on.
pub const MANUAL_REJECTED_FLOOR: f64 = 407.0;
