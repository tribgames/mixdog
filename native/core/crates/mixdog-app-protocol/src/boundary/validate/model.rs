//! Input validation for the `model` methods: the model selection of `route/set`, `thread/continueInModel` and
//! `thread/fork`, the catalog options of `model/list`, and the decision of `thread/approval/answer`. The limits, the
//! accepted shapes and the messages are the desktop's (`ipc-validation.ts` `requiredModelSelection`,
//! `requiredModelCatalogOptions`, `requiredToolApprovalDecision`, `requiredQuestionAnswers`), applied to the protocol
//! params every client sends. A field the clients leave out is not required here (a `route` of `{}` and a `result` of
//! `{}` are accepted); a field that is present is held to the desktop's rule.

use mixdog_js::{js_trim, utf16_len};
use serde_json::{Map, Value};

use crate::error::ErrorData;

type Checked = Result<(), ErrorData>;

const MODEL_SELECTION_KEYS: [&str; 10] = [
    "provider",
    "model",
    "effort",
    "fast",
    "autoEffort",
    "modelParameters",
    "contextPercent",
    "contextTokens",
    "fallbacks",
    "onlyIfEmpty",
];
const MODEL_CATALOG_OPTION_KEYS: [&str; 3] = ["force", "refresh", "quick"];
const TOOL_APPROVAL_KEYS: [&str; 8] =
    ["approved", "reason", "answers", "reply", "response", "editedArgs", "remember", "scope"];
const TOOL_APPROVAL_RESPONSES: [&str; 6] = ["approve", "deny", "edit-and-approve", "provide-secret", "skip", "done"];
const TOOL_APPROVAL_REMEMBER: [&str; 4] = ["once", "session", "agent", "always"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    Some(match method {
        "route/set" | "thread/continueInModel" => route(params, false),
        "thread/fork" => route(params, true),
        "model/list" => catalog_options(params),
        "thread/approval/answer" => decision(params),
        _ => return None,
    })
}

fn refuse(path: &str, expected: &str) -> Checked {
    Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() })
}

fn field<'a>(params: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    params.and_then(Value::as_object).and_then(|object| object.get(name))
}

fn join(path: &str, name: &str) -> String {
    format!("{path}/{name}")
}

/// `requireAllowedKeys`.
fn allowed_keys(object: &Map<String, Value>, allowed: &[&str], path: &str, name: &str) -> Checked {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return refuse(path, &format!("{name} contains an unsupported field."));
    }
    Ok(())
}

/// `Number.isSafeInteger` of a JSON number.
fn safe_integer(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number)
}

/// `requiredString` on a present field: a string, not empty once trimmed, at most `maximum` UTF-16 units trimmed.
fn required_string(value: &Value, path: &str, name: &str, maximum: usize) -> Checked {
    let Some(text) = value.as_str() else {
        return refuse(path, &format!("{name} must be a string."));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > maximum {
        return refuse(path, &format!("{name} is invalid."));
    }
    Ok(())
}

fn boolean(value: Option<&Value>, path: &str, expected: &str) -> Checked {
    match value {
        Some(value) if !value.is_boolean() => refuse(path, expected),
        _ => Ok(()),
    }
}

/// `requiredModelSelection` of `params.route`; `nullable` is the `thread/fork` route, which may be absent or null
/// (`inheritSession` without a selection). A method without a route is the typed decode's refusal.
fn route(params: Option<&Value>, nullable: bool) -> Checked {
    match field(params, "route") {
        None => Ok(()),
        Some(Value::Null) if nullable => Ok(()),
        Some(value) => model_selection(value, "/route"),
    }
}

/// `requiredModelSelection`, also the check of a new task draft's `route` (prompt group).
pub(super) fn model_selection(value: &Value, path: &str) -> Checked {
    let Some(object) = value.as_object() else {
        return refuse(path, "model selection is invalid.");
    };
    allowed_keys(object, &MODEL_SELECTION_KEYS, path, "model selection")?;
    let at = |name: &str| join(path, name);
    boolean(object.get("onlyIfEmpty"), &at("onlyIfEmpty"), "selection.onlyIfEmpty must be a boolean.")?;
    if let Some(tokens) = object.get("contextTokens") {
        if !safe_integer(tokens).is_some_and(|number| number >= 1.0) {
            return refuse(&at("contextTokens"), "selection.contextTokens must be a positive integer.");
        }
    }
    if let Some(effort) = object.get("effort") {
        if !effort.is_string() {
            return refuse(&at("effort"), "selection.effort must be a string.");
        }
    }
    boolean(object.get("fast"), &at("fast"), "selection.fast must be a boolean.")?;
    boolean(object.get("autoEffort"), &at("autoEffort"), "selection.autoEffort must be a boolean.")?;
    if let Some(parameters) = object.get("modelParameters") {
        let string_map = parameters
            .as_object()
            .is_some_and(|map| map.iter().all(|(key, option)| !key.is_empty() && option.is_string()));
        if !string_map {
            return refuse(&at("modelParameters"), "selection.modelParameters must be a string map.");
        }
    }
    // A number is accepted as the runtime takes it (`normalizeContextPercent` snaps it to a 10% step from 10 to 100):
    // the phone sends any number here (fixtures/clients-accepted.json), so the desktop's range and step rule
    // would refuse what they send today.
    if let Some(percent) = object.get("contextPercent") {
        if !percent.is_number() {
            return refuse(
                &at("contextPercent"),
                "selection.contextPercent must be a 10-point percentage from 10 to 100.",
            );
        }
    }
    if let Some(fallbacks) = object.get("fallbacks") {
        let entries = match fallbacks.as_array() {
            Some(entries) if entries.len() <= 16 => entries,
            _ => return refuse(&at("fallbacks"), "selection.fallbacks must be an array of model selections."),
        };
        for (index, entry) in entries.iter().enumerate() {
            let entry_path = format!("{}/{index}", at("fallbacks"));
            if entry.as_object().is_some_and(|leaf| leaf.contains_key("fallbacks")) {
                return refuse(&entry_path, "fallback selections must be leaf selections.");
            }
            model_selection(entry, &entry_path)?;
        }
    }
    for (name, label, maximum) in [("provider", "selection.provider", 256), ("model", "selection.model", 512)] {
        if let Some(text) = object.get(name) {
            required_string(text, &at(name), label, maximum)?;
        }
    }
    if let Some(effort) = object.get("effort") {
        required_string(effort, &at("effort"), "selection.effort", 64)?;
    }
    Ok(())
}

/// `requiredModelCatalogOptions` on the options the protocol carries: the three flags are booleans; the other fields
/// of the params (`opId`, `providerId`) are the typed decode's.
fn catalog_options(params: Option<&Value>) -> Checked {
    let Some(params) = params else {
        return Ok(());
    };
    let Some(object) = params.as_object() else {
        return refuse("", "model catalog options are invalid.");
    };
    for key in MODEL_CATALOG_OPTION_KEYS {
        if object.get(key).is_some_and(|option| !option.is_boolean()) {
            return refuse(&format!("/{key}"), "model catalog options are invalid.");
        }
    }
    Ok(())
}

/// `requiredToolApprovalDecision` of `params.result`.
fn decision(params: Option<&Value>) -> Checked {
    let Some(value) = field(params, "result") else {
        return Ok(());
    };
    let path = "/result";
    let at = |name: &str| join(path, name);
    let Some(object) = value.as_object() else {
        return refuse(path, "decision is invalid.");
    };
    if object.get("approved").is_some_and(|approved| !approved.is_boolean()) {
        return refuse(path, "decision is invalid.");
    }
    allowed_keys(object, &TOOL_APPROVAL_KEYS, path, "decision")?;
    if let Some(reason) = object.get("reason") {
        if !reason.as_str().is_some_and(|text| utf16_len(text) <= 4_096) {
            return refuse(&at("reason"), "decision.reason is invalid.");
        }
    }
    if let Some(answers) = object.get("answers") {
        question_answers(answers, &at("answers"))?;
    }
    if let Some(reply) = object.get("reply") {
        if !reply.as_str().is_some_and(|text| utf16_len(js_trim(text)) <= 4_000) {
            return refuse(&at("reply"), "decision.reply is invalid.");
        }
    }
    if let Some(response) = object.get("response") {
        if !response.as_str().is_some_and(|text| TOOL_APPROVAL_RESPONSES.contains(&text)) {
            return refuse(&at("response"), "decision.response is invalid.");
        }
    }
    if let Some(remember) = object.get("remember") {
        if !remember.as_str().is_some_and(|text| TOOL_APPROVAL_REMEMBER.contains(&text)) {
            return refuse(&at("remember"), "decision.remember is invalid.");
        }
    }
    if let Some(scope) = object.get("scope") {
        if !scope.as_str().is_some_and(|text| utf16_len(text) <= 200) {
            return refuse(&at("scope"), "decision.scope is invalid.");
        }
    }
    if let Some(edited) = object.get("editedArgs") {
        let valid = edited.as_object().is_some_and(|map| {
            map.len() <= 8 && map.values().all(|text| text.as_str().is_some_and(|text| utf16_len(text) <= 40_000))
        });
        if !valid {
            return refuse(&at("editedArgs"), "decision.editedArgs is invalid.");
        }
    }
    Ok(())
}

/// `requiredQuestionAnswers`: up to four entries, each null or `{selected: string[<=4 of <=200], text?: string<=4000}`.
fn question_answers(value: &Value, path: &str) -> Checked {
    const INVALID: &str = "decision.answers is invalid.";
    let Some(entries) = value.as_array().filter(|entries| entries.len() <= 4) else {
        return refuse(path, INVALID);
    };
    for (index, entry) in entries.iter().enumerate() {
        if entry.is_null() {
            continue;
        }
        let entry_path = format!("{path}/{index}");
        let Some(object) = entry.as_object() else {
            return refuse(&entry_path, INVALID);
        };
        allowed_keys(object, &["selected", "text"], &entry_path, "decision.answers")?;
        let labels_valid = object.get("selected").and_then(Value::as_array).is_some_and(|labels| {
            labels.len() <= 4 && labels.iter().all(|label| label.as_str().is_some_and(|text| utf16_len(text) <= 200))
        });
        if !labels_valid {
            return refuse(&join(&entry_path, "selected"), INVALID);
        }
        if let Some(text) = object.get("text") {
            if !text.as_str().is_some_and(|text| utf16_len(text) <= 4_000) {
                return refuse(&join(&entry_path, "text"), INVALID);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    const FIXTURE: &str = include_str!("fixtures/model.json");
    const CLIENTS_ACCEPTED: &str = include_str!("fixtures/clients-accepted.json");

    fn verdict(method: &str, params: &Value) -> Checked {
        check(method, Some(params)).expect("the model group owns this method")
    }

    #[test]
    fn validate_model_fixture_rows_match() {
        let rows: Vec<Value> = serde_json::from_str(FIXTURE).expect("fixtures/model.json is JSON");
        assert!(!rows.is_empty());
        for row in &rows {
            let method = row["method"].as_str().expect("method");
            let got = verdict(method, &row["params"]);
            match row["expected"].as_str() {
                None => assert_eq!(got, Ok(()), "{} accepts: {}", method, row["case"]),
                Some(expected) => assert_eq!(
                    got,
                    refuse(row["path"].as_str().expect("path of a refuse row"), expected),
                    "{} refuses: {}",
                    method,
                    row["case"]
                ),
            }
        }
    }

    #[test]
    fn validate_model_clients_accepted_rows_pass() {
        let rows: Vec<Value> = serde_json::from_str(CLIENTS_ACCEPTED).expect("clients-accepted.json is JSON");
        let mut seen = 0;
        for row in &rows {
            let method = row["method"].as_str().expect("method");
            if let Some(got) = check(method, Some(&row["params"])) {
                seen += 1;
                assert_eq!(got, Ok(()), "{} from {} is accepted", method, row["client"]);
            }
        }
        assert!(seen > 0);
    }

    #[test]
    fn validate_model_other_methods_are_not_owned() {
        assert!(check("thread/start", Some(&json!({}))).is_none());
    }

    #[test]
    fn validate_model_counts_utf16_units() {
        // 129 astral characters are 258 UTF-16 units: over the 256 of `provider`, under it in scalar values.
        let provider = "\u{1F600}".repeat(129);
        let got = verdict("route/set", &json!({ "route": { "provider": provider } }));
        assert_eq!(got, refuse("/route/provider", "selection.provider is invalid."));
    }
}
