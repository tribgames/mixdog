//! The labels of the text-entry panel by prompt kind (`src/tui/app/app-view/text-entry-labels.mjs`): the title, the hint and
//! the prompt of a provider prompt, and the action and the prompt of a settings prompt.

use mixdog_js::value_to_string;
use serde_json::Value;

/// What a provider prompt shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPromptFields {
    pub title: String,
    pub hint: String,
    pub prompt_label: String,
}

/// What a settings prompt shows besides its own title and hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsPromptFields {
    pub action_label: &'static str,
    pub prompt_label: &'static str,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `${prompt[key]}` of a template literal: an absent field is the word `undefined`.
fn template(prompt: &Value, key: &str) -> String {
    prompt.get(key).map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value || '')`.
fn text_or_empty(prompt: &Value, key: &str) -> String {
    let value = prompt.get(key);
    if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { String::new() }
}

/// `providerPromptFields(providerPrompt)`.
pub fn provider_prompt_fields(prompt: &Value) -> ProviderPromptFields {
    let kind = prompt.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "api-key" => {
            let verb = if prompt.get("mode").and_then(Value::as_str) == Some("replace") { "Replace" } else { "Set" };
            let mut parts = Vec::new();
            if truthy(prompt.get("envName")) {
                parts.push(format!("Env: {}", template(prompt, "envName")));
            }
            if truthy(prompt.get("source")) {
                parts.push(format!("Current: {}", template(prompt, "source")));
            }
            if truthy(prompt.get("keyUrl")) {
                parts.push(format!("Get a key: {}", template(prompt, "keyUrl")));
            }
            let own = text_or_empty(prompt, "hint");
            if !own.is_empty() {
                parts.push(own);
            }
            parts.push("Stored in the OS keychain.".to_owned());
            ProviderPromptFields {
                title: format!("{verb} API key \u{b7} {}", template(prompt, "label")),
                hint: parts.join(" \u{b7} "),
                prompt_label: "API key > ".to_owned(),
            }
        }
        "oauth-code" => {
            let hint = text_or_empty(prompt, "hint");
            ProviderPromptFields {
                title: text_or_empty(prompt, "label"),
                hint: if hint.is_empty() { "Paste the browser code.".to_owned() } else { hint },
                prompt_label: "Paste code here if prompted > ".to_owned(),
            }
        }
        "openai-usage-session" => ProviderPromptFields {
            title: "OpenAI Usage \u{b7} Session Key".to_owned(),
            hint: "Paste an OpenAI dashboard/session key for the undocumented credit lookup. It is stored in the OS keychain.".to_owned(),
            prompt_label: "Session key > ".to_owned(),
        },
        _ => ProviderPromptFields {
            title: format!("Base URL \u{b7} {}", template(prompt, "label")),
            hint: format!("Default: {}", template(prompt, "defaultURL")),
            prompt_label: "Base URL > ".to_owned(),
        },
    }
}

/// `settingsPromptFields(kind)`.
pub fn settings_prompt_fields(kind: &str) -> SettingsPromptFields {
    let (action_label, prompt_label) = match kind {
        "skill-use" => ("run", "Command > "),
        "autoclear-provider" => ("save", "Duration > "),
        "project-new" => ("open", "Path > "),
        "project-create-confirm" => ("confirm", "Create? (y/n) > "),
        "project-rename" => ("rename", "Name > "),
        "core-add" => ("add", "Sentence > "),
        "core-edit" => ("save", "Sentence > "),
        "core-delete-confirm" => ("confirm", "Delete? (y/n) > "),
        _ => ("save", "Value > "),
    };
    SettingsPromptFields { action_label, prompt_label }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_api_key_prompt_says_where_the_key_comes_from_and_where_it_goes() {
        let fields = provider_prompt_fields(
            &json!({ "kind": "api-key", "mode": "replace", "label": "OpenAI", "envName": "OPENAI_API_KEY", "source": "env", "keyUrl": "https://k.example", "hint": "extra" }),
        );
        assert_eq!(fields.title, "Replace API key \u{b7} OpenAI");
        assert_eq!(fields.hint, "Env: OPENAI_API_KEY \u{b7} Current: env \u{b7} Get a key: https://k.example \u{b7} extra \u{b7} Stored in the OS keychain.");
        assert_eq!(fields.prompt_label, "API key > ");
        let plain = provider_prompt_fields(&json!({ "kind": "api-key", "label": "X" }));
        assert_eq!((plain.title.as_str(), plain.hint.as_str()), ("Set API key \u{b7} X", "Stored in the OS keychain."));
    }

    #[test]
    fn the_other_provider_kinds_have_their_own_copy() {
        let oauth = provider_prompt_fields(&json!({ "kind": "oauth-code", "label": "Sign in" }));
        assert_eq!((oauth.title.as_str(), oauth.hint.as_str()), ("Sign in", "Paste the browser code."));
        assert_eq!(provider_prompt_fields(&json!({ "kind": "oauth-code", "label": "S", "hint": "Paste it." })).hint, "Paste it.");
        assert_eq!(provider_prompt_fields(&json!({ "kind": "openai-usage-session" })).prompt_label, "Session key > ");
        let base = provider_prompt_fields(&json!({ "kind": "base-url", "label": "Local", "defaultURL": "http://localhost:1" }));
        assert_eq!((base.title.as_str(), base.hint.as_str()), ("Base URL \u{b7} Local", "Default: http://localhost:1"));
    }

    #[test]
    fn a_settings_prompt_names_its_action_and_its_prompt_by_kind() {
        assert_eq!(settings_prompt_fields("project-new"), SettingsPromptFields { action_label: "open", prompt_label: "Path > " });
        assert_eq!(settings_prompt_fields("core-delete-confirm").action_label, "confirm");
        assert_eq!(settings_prompt_fields("core-edit"), SettingsPromptFields { action_label: "save", prompt_label: "Sentence > " });
        assert_eq!(settings_prompt_fields("anything"), SettingsPromptFields { action_label: "save", prompt_label: "Value > " });
    }
}
