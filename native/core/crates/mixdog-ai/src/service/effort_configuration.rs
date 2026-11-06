//! `effortConfigurationMode` and `customAutoEffortCapable` (`providers/effort-configuration.mjs`):
//! whether a route takes a mid-conversation effort update (and on which wire), and whether a
//! custom route takes a per-request effort. Row hydration reads both (`autoEffortCapable`).

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use mixdog_js::{js_trim, to_number, value_to_string};
use regex::Regex;
use serde_json::Value;

use crate::effort::custom_levels;
use crate::providers::custom::reasoning::is_custom_provider_name;

/// A family not measured yet starts at the earliest checked major.
const ANTHROPIC_FIRST_MAJOR: u32 = 5;
/// `ANTHROPIC_MIN_VERSION`: each family's first version checked on the wire.
const ANTHROPIC_MIN_VERSION: [(&str, (u32, u32)); 5] =
    [("opus", (5, 0)), ("sonnet", (5, 5)), ("haiku", (5, 5)), ("fable", (5, 1)), ("mythos", (5, 1))];
/// GPT-6 and later, standard single-agent mode.
const OPENAI_MIN_MAJOR: f64 = 6.0;

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `String(model || '')`.
fn model_text(model: &Value) -> String {
    if js_truthy(Some(model)) { value_to_string(model) } else { String::new() }
}

/// `modelKey(model)`: trimmed, lowercase, without a trailing date, dots folded to dashes.
pub fn model_key(model: &Value) -> String {
    let dashed = Regex::new(r"-[0-9]{4}-[0-9]{2}-[0-9]{2}$").expect("static pattern");
    let compact = Regex::new(r"-[0-9]{8}$").expect("static pattern");
    let lower = js_trim(&model_text(model)).to_lowercase();
    let lower = dashed.replace(&lower, "");
    compact.replace(&lower, "").replace('.', "-")
}

/// The models that rejected a mid-conversation effort update in this process
/// (`markEffortConfigurationUnsupported`).
#[derive(Default)]
pub struct UnsupportedEfforts(Mutex<HashSet<String>>);

impl UnsupportedEfforts {
    pub fn mark(&self, provider: &str, model: &Value) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(format!("{provider}:{}", model_key(model)));
    }

    fn contains(&self, provider: &str, id: &str) -> bool {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).contains(&format!("{provider}:{id}"))
    }
}

fn version_at_least((major, minor): (u32, u32), (min_major, min_minor): (u32, u32)) -> bool {
    major > min_major || (major == min_major && minor >= min_minor)
}

fn anthropic_version_supported(provider: &str, id: &str) -> bool {
    let pattern = Regex::new(r"^claude-([a-z]+)-([0-9]+)(?:-([0-9]{1,2}))?$").expect("static pattern");
    let Some(m) = pattern.captures(id) else { return false };
    let number = |text: &str| text.parse::<u32>().unwrap_or(u32::MAX);
    let version = (number(&m[2]), m.get(3).map_or(0, |g| number(g.as_str())));
    match ANTHROPIC_MIN_VERSION.iter().find(|(family, _)| *family == &m[1]) {
        Some((_, floor)) => version_at_least(version, *floor),
        None => provider == "anthropic-oauth" && version.0 >= ANTHROPIC_FIRST_MAJOR,
    }
}

/// Any `gpt-<major>` id, whatever follows the major.
fn openai_version_supported(id: &str) -> bool {
    let pattern = Regex::new(r"^gpt-([0-9]+)(?:-|$)").expect("static pattern");
    pattern.captures(id).is_some_and(|m| m[1].parse::<f64>().is_ok_and(|major| major >= OPENAI_MIN_MAJOR))
}

/// The wire an update travels on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UpdateMode {
    Responses,
    Anthropic,
}

impl UpdateMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
        }
    }
}

/// `effortConfigurationMode(provider, model, opts)`. `codex_declared` is the OAuth catalog's own
/// answer for a model id (`codexModelSupportsEffortUpdates`), `None` when it has none.
pub fn effort_configuration_mode(
    provider: &str,
    model: &Value,
    opts: &Value,
    unsupported: &UnsupportedEfforts,
    codex_declared: &dyn Fn(&str) -> Option<bool>,
) -> Option<UpdateMode> {
    let id = model_key(model);
    let opt = |key: &str| opts.get(key);
    if opt("effortConfigurationEnabled") == Some(&Value::Bool(false)) {
        return None;
    }
    if opt("thinkingBudgetTokens").map_or(f64::NAN, to_number) > 0.0 {
        return None;
    }
    if unsupported.contains(provider, &id) {
        return None;
    }
    let openai = (provider == "openai" || provider == "openai-oauth") && {
        let declared = if provider == "openai-oauth" { codex_declared(js_trim(&model_text(model))) } else { None };
        declared.unwrap_or_else(|| openai_version_supported(&id))
    };
    // A custom route on the Responses wire serving GPT-6 or later takes the same update; the
    // version is read from the id's last `/` segment.
    let custom_responses = is_custom_provider_name(provider)
        && opt("protocol") == Some(&Value::from("openai-responses"))
        && openai_version_supported(&id[id.rfind('/').map_or(0, |at| at + 1)..]);
    if openai || custom_responses {
        let parameters = opt("modelParameters").filter(|p| js_truthy(Some(p)));
        let parameter = |key: &str| parameters.and_then(|p| p.get(key)).filter(|v| !v.is_null());
        let mode = opt("reasoning")
            .and_then(|r| r.get("mode"))
            .filter(|v| !v.is_null())
            .or_else(|| parameter("reasoning_mode"))
            .or_else(|| parameter("mode"))
            .cloned()
            .unwrap_or_else(|| Value::from("standard"));
        if mode != Value::from("standard") || opt("multiAgent") == Some(&Value::Bool(true)) || parameter("multi_agent") == Some(&Value::Bool(true)) {
            return None;
        }
        return Some(UpdateMode::Responses);
    }
    let first_party = |base: Option<&Value>| match base {
        None => true,
        Some(b) if !js_truthy(Some(b)) => true,
        Some(b) => {
            let url = value_to_string(b);
            url == "https://api.anthropic.com" || url.starts_with("https://api.anthropic.com/")
        }
    };
    ((provider == "anthropic" || provider == "anthropic-oauth")
        && anthropic_version_supported(provider, &id)
        && opt("disableBetaHeaders") != Some(&Value::Bool(true))
        && first_party(opt("baseURL")))
    .then_some(UpdateMode::Anthropic)
}

/// `customAutoEffortCapable(provider, protocol, model)`: a custom route on a Chat/Responses
/// protocol whose model row declares a non-empty effort level list.
pub fn custom_auto_effort_capable(provider: &str, protocol: Option<&Value>, model: &Value) -> bool {
    is_custom_provider_name(provider)
        && protocol.is_some_and(|p| *p == Value::from("openai-chat") || *p == Value::from("openai-responses"))
        && custom_levels(model).is_some_and(|levels| !levels.is_empty())
}

#[cfg(test)]
#[path = "effort_configuration_tests.rs"]
mod tests;
