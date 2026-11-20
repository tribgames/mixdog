//! Identify rejected mid-conversation effort updates and remember the
//! first-party models that don't support them.

use std::collections::HashSet;
use std::sync::Mutex;

use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

/// Index N of an `input[N]...` parameter path.
fn input_index(param: &str) -> Option<usize> {
    let rest = param.strip_prefix("input[")?;
    rest[..rest.find(']')?].parse().ok()
}

fn is_update(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("configuration_update")
}

fn rejects_effort_value(code: Option<&str>, param: Option<&str>, text: &str) -> bool {
    if matches!(code, Some("unsupported_parameter" | "unknown_parameter")) {
        return false;
    }
    let effort_field =
        |name: &str| name == "effort" || name.ends_with(".effort") || name.ends_with("reasoning_effort") || name.ends_with("reasoning_effort_update");
    static EFFORT_NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\b(?:effort|reasoning_effort(?:_update)?)\b").expect("static pattern"));
    static QUOTED_LEVEL: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#"['"`](none|minimal|low|medium|high|xhigh|max|ultra)['"`]"#).expect("static pattern"));
    (param.is_some_and(effort_field) || EFFORT_NAME.is_match(text))
        && (matches!(code, Some("unsupported_value" | "invalid_value" | "invalid_enum_value")) || QUOTED_LEVEL.is_match(text))
}

/// Indexes in the frame actually sent, not in the full input from which a
/// WebSocket delta was derived.
#[derive(Default)]
pub(super) struct SentUpdates(Vec<usize>);

impl SentUpdates {
    pub(super) fn of(input: Option<&Value>) -> Self {
        Self(input.and_then(Value::as_array).into_iter().flatten().enumerate().filter_map(|(index, item)| is_update(item).then_some(index)).collect())
    }

    pub(super) fn rejected(&self, error: &ProviderError, param: Option<&str>) -> bool {
        if self.0.is_empty() || error.status != Some(400) {
            return false;
        }
        let text = error.message.to_ascii_lowercase();
        if ["clear_at", "clear-at", "turn-scoped"].iter().any(|part| text.contains(part)) || rejects_effort_value(error.code.as_deref(), param, &text) {
            return false;
        }
        if param.and_then(input_index).is_some_and(|index| self.0.contains(&index)) {
            return true;
        }
        if ["mid-conversation", "configuration_update", "reasoning_effort_update"].iter().any(|part| text.contains(part)) {
            return true;
        }
        text.contains("output_config")
    }
}

/// The same request without its effort updates, when `response` rejected one
/// of them; `None` for any other failure, and for a request that carries no
/// update (so a second rejection never retries again).
pub fn without_effort_updates(sent: &WireRequest, response: &ErrorResponse) -> Option<WireRequest> {
    if response.status != Some(400) {
        return None;
    }
    let error: Value = serde_json::from_slice(&response.body).ok()?;
    let error = error.get("error")?;
    let param = error.get("param")?.as_str()?;
    let index = input_index(param)?;
    let code = error.get("code").and_then(Value::as_str);
    let text = error.get("message").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    if rejects_effort_value(code, Some(param), &text) {
        return None;
    }
    let mut body: Value = serde_json::from_slice(&sent.body).ok()?;
    let input = body.get_mut("input")?.as_array_mut()?;
    if !input.get(index).is_some_and(is_update) {
        return None;
    }
    input.retain(|item| !is_update(item));
    Some(WireRequest { body: serde_json::to_vec(&body).ok()?, ..sent.clone() })
}

/// Models that rejected an effort update: no updates for them for the rest of
/// the process.
#[derive(Default, Debug)]
pub struct EffortUpdateSupport {
    rejected: Mutex<HashSet<(String, String)>>,
}

impl EffortUpdateSupport {
    pub fn mark_rejected(&self, route: &str, model: &str) {
        if let Ok(mut set) = self.rejected.lock() {
            set.insert(Self::key(route, model));
        }
    }

    pub fn is_rejected(&self, route: &str, model: &str) -> bool {
        self.rejected.lock().is_ok_and(|set| !set.is_empty() && set.contains(&Self::key(route, model)))
    }

    fn key(route: &str, model: &str) -> (String, String) {
        (route.to_owned(), crate::service::effort_configuration::model_key(&Value::String(model.to_owned())))
    }
}
