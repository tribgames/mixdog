//! The labels of a provider setup row: the one "is this provider usable" rule (`app/provider-usable.mjs`), the status, detail
//! and kind labels (`providerStatusLabel`, `providerDetailText`, `providerKindLabel` of `app-format.mjs`), the status footer
//! and the key-console address (`provider-setup/provider-items.mjs`), and the web-search marker route.

use mixdog_tui_style::Key;
use mixdog_tui_style::theme::theme_color;
use mixdog_tui_widgets::picker::layout::FooterInput;
use serde_json::{Value, json};

use crate::slash::notices::{truthy, value_text};

/// The text of member `key` of a setup row, `String(row[key] ?? '')` trimmed (`clean`).
fn clean_member(row: &Value, key: &str) -> String {
    match row.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&value_text(value)).to_owned(),
    }
}

fn member_is(row: &Value, key: &str, text: &str) -> bool {
    row.get(key).and_then(Value::as_str) == Some(text)
}

/// `providerRowUsable(row)`: a row that requires sign-in again is never usable; `usable` is authoritative when the row has it
/// (OAuth rows always do, local rows carry detected and enabled); an API-key row is usable only with a credential.
pub fn provider_row_usable(row: &Value) -> bool {
    if !truthy(row) || row.get("reauthRequired") == Some(&Value::Bool(true)) {
        return false;
    }
    match row.get("usable") {
        None | Some(Value::Null) => row.get("authenticated") == Some(&Value::Bool(true)),
        Some(usable) => *usable == Value::Bool(true),
    }
}

/// `providerStatusLabel(provider)`.
pub fn provider_status_label(provider: &Value) -> String {
    let status = clean_member(provider, "status");
    if !status.is_empty() {
        return status;
    }
    if provider.get("enabled").is_some_and(truthy)
        || provider.get("authenticated").is_some_and(truthy)
    {
        return "Set".to_owned();
    }
    if provider.get("detected").is_some_and(truthy) {
        return "Detected".to_owned();
    }
    "Off".to_owned()
}

/// `providerDetailText(provider)`.
pub fn provider_detail_text(provider: &Value) -> String {
    let detail = clean_member(provider, "detail");
    if !detail.is_empty() {
        return detail;
    }
    let text = |key: &str| {
        provider
            .get(key)
            .filter(|value| truthy(value))
            .map(value_text)
    };
    if provider.get("env").is_some_and(truthy) {
        if let Some(name) = text("envName") {
            return format!("env: {name}");
        }
    }
    text("envName")
        .or_else(|| text("baseURL"))
        .or_else(|| text("desc"))
        .unwrap_or_default()
}

/// `providerKindLabel(provider)`.
pub fn provider_kind_label(provider: &Value) -> &'static str {
    if member_is(provider, "type", "oauth") {
        "OAuth"
    } else if member_is(provider, "type", "local") {
        "Local endpoint"
    } else {
        "API key"
    }
}

/// `keyConsoleUrl(provider)`: the row's `url` when it is an `https://` address, else nothing.
pub fn key_console_url(provider: &Value) -> String {
    let url = clean_member(provider, "url");
    if url.starts_with("https://") {
        url
    } else {
        String::new()
    }
}

/// `providerStatusFooter(provider)`: the active glyph plus kind, status and detail; nothing for no provider.
pub fn provider_status_footer(provider: Option<&Value>) -> Vec<FooterInput> {
    let Some(provider) = provider else {
        return Vec::new();
    };
    let active = provider_row_usable(provider);
    let text = [
        provider_kind_label(provider).to_owned(),
        provider_status_label(provider),
        provider_detail_text(provider),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" \u{b7} ");
    vec![FooterInput::Object {
        glyph: if active { "\u{25cf}" } else { "\u{25cb}" }.to_owned(),
        color: Some(theme_color(if active {
            Key::Success
        } else {
            Key::Inactive
        })),
        text,
    }]
}

/// `WEB_SEARCH_DEFAULT_ROUTE`: a web-search route of `default/default` follows the Main Model at run time.
pub fn web_search_default_route() -> Value {
    json!({"provider": "default", "model": "default"})
}

/// `isWebSearchDefaultRoute(route)`.
pub fn is_web_search_default_route(route: &Value) -> bool {
    let lower = |key: &str| {
        route
            .get(key)
            .filter(|value| truthy(value))
            .map(|value| value_text(value).to_lowercase())
    };
    lower("provider").as_deref() == Some("default") && lower("model").as_deref() == Some("default")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<(Value, bool)> {
        vec![
            (
                json!({"id": "openai", "type": "api-key", "enabled": true, "authenticated": true, "stored": true, "env": false}),
                true,
            ),
            (
                json!({"id": "anthropic", "type": "api-key", "enabled": true, "authenticated": false}),
                false,
            ),
            (
                json!({"id": "gemini", "type": "api-key", "enabled": false, "authenticated": false}),
                false,
            ),
            (
                json!({"id": "anthropic-oauth", "type": "oauth", "authenticated": true, "usable": true, "reauthRequired": false}),
                true,
            ),
            (
                json!({"id": "grok-oauth", "type": "oauth", "authenticated": true, "usable": false}),
                false,
            ),
            (
                json!({"id": "openai-oauth", "type": "oauth", "usable": false, "reauthRequired": true}),
                false,
            ),
            (
                json!({"id": "mixdog-local", "type": "local", "enabled": true, "detected": true, "authenticated": true, "usable": true}),
                true,
            ),
            (
                json!({"id": "mixdog-local", "type": "local", "enabled": false, "detected": true, "authenticated": true, "usable": false}),
                false,
            ),
        ]
    }

    #[test]
    fn a_row_is_usable_only_per_the_setup_contract() {
        for (row, usable) in rows() {
            assert_eq!(provider_row_usable(&row), usable, "{row}");
        }
        assert!(!provider_row_usable(&Value::Null));
    }

    #[test]
    fn the_footer_marks_a_provider_active_only_per_the_same_rule() {
        for (row, usable) in rows() {
            let footer = provider_status_footer(Some(&row));
            let FooterInput::Object { glyph, .. } = &footer[0] else {
                panic!("an object line")
            };
            assert_eq!(glyph, if usable { "\u{25cf}" } else { "\u{25cb}" }, "{row}");
        }
        assert!(provider_status_footer(None).is_empty());
    }

    #[test]
    fn the_labels_follow_the_row() {
        assert_eq!(
            provider_status_label(&json!({"status": " Invalid config "})),
            "Invalid config"
        );
        assert_eq!(
            provider_status_label(&json!({"authenticated": true})),
            "Set"
        );
        assert_eq!(
            provider_status_label(&json!({"detected": true})),
            "Detected"
        );
        assert_eq!(provider_status_label(&json!({})), "Off");
        assert_eq!(
            provider_detail_text(&json!({"env": true, "envName": "KEY"})),
            "env: KEY"
        );
        assert_eq!(provider_detail_text(&json!({"envName": "KEY"})), "KEY");
        assert_eq!(
            provider_detail_text(&json!({"baseURL": "http://x"})),
            "http://x"
        );
        assert_eq!(provider_kind_label(&json!({"type": "oauth"})), "OAuth");
        assert_eq!(
            provider_kind_label(&json!({"type": "local"})),
            "Local endpoint"
        );
        assert_eq!(provider_kind_label(&json!({})), "API key");
        assert_eq!(
            key_console_url(&json!({"url": " https://opencode.ai/keys "})),
            "https://opencode.ai/keys"
        );
        assert_eq!(key_console_url(&json!({"url": "http://insecure"})), "");
    }

    #[test]
    fn the_web_search_marker_route() {
        assert!(is_web_search_default_route(&web_search_default_route()));
        assert!(is_web_search_default_route(
            &json!({"provider": "Default", "model": "DEFAULT"})
        ));
        assert!(!is_web_search_default_route(
            &json!({"provider": "openai", "model": "default"})
        ));
        assert!(!is_web_search_default_route(&Value::Null));
    }
}
