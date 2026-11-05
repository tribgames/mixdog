//! What the tool loop does with the after-tool hooks' answers (Node `after-hook.mjs`,
//! `record-outcome.mjs`, `flush.mjs`): the model-visible result a `PostToolUse` hook may
//! replace, the directory hooks see for a call, and the note a blocking `PostToolBatch` hook
//! adds for the next model call.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::value_to_string;
use serde_json::Value;

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_text(value: &Value) -> String {
    value_to_string(value)
}

/// A `PostToolUse` replacement as the model sees it: a legacy MCP text envelope
/// (`{content:[{type:"text",text}]}`) becomes its text lines unless it carries a non-text
/// part; `null` becomes the empty text; anything else is used as given.
pub fn normalize_updated_tool_output(value: Value) -> Value {
    if value.is_null() {
        return Value::String(String::new());
    }
    let Some(items) = value.get("content").and_then(Value::as_array) else { return value };
    let non_text = items.iter().any(|c| {
        c.as_object().is_some_and(|o| o.get("type").is_some_and(truthy) && o.get("type").and_then(Value::as_str) != Some("text"))
    });
    if non_text {
        return value;
    }
    let lines: Vec<String> = items
        .iter()
        .map(|c| match c.get("type").and_then(Value::as_str) {
            Some("text") => c.get("text").filter(|t| truthy(t)).map(js_text).unwrap_or_default(),
            _ => json_stringify(c),
        })
        .collect();
    Value::String(lines.join("\n"))
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn expand_home(requested: &str) -> PathBuf {
    let home = home_dir();
    let rest = requested.strip_prefix("~/").or_else(|| if cfg!(windows) { requested.strip_prefix("~\\") } else { None });
    match (requested, rest, home) {
        ("~", _, Some(home)) => home,
        (_, Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(requested),
    }
}

/// The directory hooks and approvals see for a call: a shell call's own `cwd` argument
/// resolved against the session directory, the session directory for every other tool.
pub fn effective_tool_cwd(tool: &str, args: &Value, session_cwd: &Path) -> PathBuf {
    if tool != "shell" {
        return session_cwd.to_path_buf();
    }
    let Some(requested) = args.get("cwd").and_then(Value::as_str).filter(|r| !js_trim(r).is_empty()) else {
        return session_cwd.to_path_buf();
    };
    let base = if session_cwd.as_os_str().is_empty() { std::env::current_dir().unwrap_or_default() } else { session_cwd.to_path_buf() };
    lexical(&base.join(expand_home(requested)))
}

/// The note a blocking `PostToolBatch` hook adds before the next model call (`None`: nothing to
/// add).
pub fn batch_reminder(reason: Option<&str>) -> Option<String> {
    let reason = js_trim(reason.filter(|r| !r.is_empty()).unwrap_or("PostToolBatch hook blocked continuation"));
    (!reason.is_empty()).then(|| format!("<system-reminder>\n{reason}\n</system-reminder>"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn text_envelopes_become_text_and_other_parts_keep_the_envelope() {
        let text = json!({"content": [{"type": "text", "text": "a"}, {"type": "text"}, {"x": 1}]});
        assert_eq!(normalize_updated_tool_output(text), json!("a\n\n{\"x\":1}"));
        let image = json!({"content": [{"type": "text", "text": "a"}, {"type": "image", "data": "d"}]});
        assert_eq!(normalize_updated_tool_output(image.clone()), image);
        assert_eq!(normalize_updated_tool_output(Value::Null), json!(""));
        assert_eq!(normalize_updated_tool_output(json!("plain")), json!("plain"));
        assert_eq!(normalize_updated_tool_output(json!({"other": 1})), json!({"other": 1}));
    }

    #[test]
    fn only_a_shell_call_changes_the_hook_directory() {
        let session = std::env::temp_dir();
        assert_eq!(effective_tool_cwd("read", &json!({"cwd": "x"}), &session), session);
        assert_eq!(effective_tool_cwd("shell", &json!({}), &session), session);
        assert_eq!(effective_tool_cwd("shell", &json!({"cwd": "  "}), &session), session);
        assert_eq!(effective_tool_cwd("shell", &json!({"cwd": "a/../b"}), &session), session.join("b"));
        let absolute = session.join("abs");
        assert_eq!(effective_tool_cwd("shell", &json!({"cwd": absolute.to_string_lossy()}), &session), absolute);
    }

    #[test]
    fn the_batch_note_wraps_the_reason() {
        assert_eq!(batch_reminder(Some(" stop ")).as_deref(), Some("<system-reminder>\nstop\n</system-reminder>"));
        assert_eq!(batch_reminder(None).as_deref(), Some("<system-reminder>\nPostToolBatch hook blocked continuation\n</system-reminder>"));
    }
}
