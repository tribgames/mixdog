//! The notice texts and small value helpers the commands share (`app-format.mjs`'s `workflowDisplayName`,
//! `workflowSwitchNotice`, `modelSwitchNotice`, `outputStyleNotice` of `route-pickers/output-style-picker.mjs`, `themeNotice`
//! of `theme-effort-pickers.mjs`, `projectNameFromPath` of `session/labels.mjs`).

use mixdog_js::{js_trim, value_to_string};
use serde_json::Value;

/// JavaScript truthiness of a parsed JSON value (`undefined` is `Null`).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || ...` over the members `keys` of `value`, as the text of the first truthy one.
pub fn first_truthy_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().filter_map(|key| value.get(*key)).find(|member| truthy(member)).map(value_text)
}

/// `String(value)` of a value that may be absent: `Null` is the empty text here only where the caller means "absent".
pub fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => value_to_string(other),
    }
}

/// `workflowDisplayName(workflow)`: the trimmed name or id, else `Default`.
pub fn workflow_display_name(workflow: &Value) -> String {
    let text = first_truthy_text(workflow, &["name", "id"]).unwrap_or_default();
    let text = js_trim(&text);
    if text.is_empty() { "Default".to_owned() } else { text.to_owned() }
}

/// `workflowSwitchNotice(workflow)`.
pub fn workflow_switch_notice(_workflow: &Value) -> String {
    "Workflow saved \u{b7} new sessions".to_owned()
}

/// `modelSwitchNotice()`.
pub fn model_switch_notice() -> String {
    "Model saved \u{b7} new sessions".to_owned()
}

/// `outputStyleNotice(result)`.
pub fn output_style_notice(result: &Value) -> String {
    let current = result.get("current").cloned().unwrap_or(Value::Null);
    let label = first_truthy_text(&current, &["label", "id"]).or_else(|| first_truthy_text(result, &["configured"])).unwrap_or_else(|| "Default".to_owned());
    if result.get("appliedToCurrentSession") == Some(&Value::Bool(false)) {
        format!("Output style set to {label}. Use /clear to apply to this chat.")
    } else {
        format!("Output style set to {label}.")
    }
}

/// `themeNotice(applied)`.
pub fn theme_notice(applied: &Value) -> String {
    format!("Theme set to {}", first_truthy_text(applied, &["label", "id"]).unwrap_or_else(|| "default".to_owned()))
}

/// `projectNameFromPath(value)`: the last path segment, `(current)` for none.
pub fn project_name_from_path(value: &str) -> String {
    let text = value.trim_end_matches(['\\', '/']);
    let last = text.rsplit(['\\', '/']).next().unwrap_or("");
    if !last.is_empty() {
        last.to_owned()
    } else if !text.is_empty() {
        text.to_owned()
    } else {
        "(current)".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn truthiness_follows_javascript() {
        for (value, want) in [
            (json!(null), false),
            (json!(false), false),
            (json!(0), false),
            (json!(""), false),
            (json!("x"), true),
            (json!(1), true),
            (json!([]), true),
            (json!({}), true),
        ] {
            assert_eq!(truthy(&value), want, "{value}");
        }
    }

    #[test]
    fn the_notice_texts_name_what_was_saved() {
        assert_eq!(workflow_display_name(&json!({"name": " Review ", "id": "r"})), "Review");
        assert_eq!(workflow_display_name(&json!({"name": "", "id": "r"})), "r");
        assert_eq!(workflow_display_name(&json!({})), "Default");
        assert_eq!(workflow_switch_notice(&json!({})), "Workflow saved \u{b7} new sessions");
        assert_eq!(model_switch_notice(), "Model saved \u{b7} new sessions");
        assert_eq!(output_style_notice(&json!({"current": {"label": "Simple"}})), "Output style set to Simple.");
        assert_eq!(
            output_style_notice(&json!({"configured": "terse", "appliedToCurrentSession": false})),
            "Output style set to terse. Use /clear to apply to this chat."
        );
        assert_eq!(output_style_notice(&json!({})), "Output style set to Default.");
        assert_eq!(theme_notice(&json!({"id": "dawn"})), "Theme set to dawn");
        assert_eq!(theme_notice(&json!({})), "Theme set to default");
    }

    #[test]
    fn a_project_is_named_by_its_last_path_segment() {
        assert_eq!(project_name_from_path("C:\\work\\app\\"), "app");
        assert_eq!(project_name_from_path("/a/b"), "b");
        assert_eq!(project_name_from_path("/"), "(current)");
        assert_eq!(project_name_from_path(""), "(current)");
    }
}
