//! Handler selection details and the legacy before-tool rule file (Node `rules.mjs`,
//! `handlers.mjs` `ifConditionPasses`).

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use super::output::TOOL_IF_EVENTS;
use crate::hooks::HookHandler;

/// `*` and `?` globs, anchored; every other character is literal.
fn glob_regex(glob: &str) -> Option<JsRegex> {
    let mut out = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push('$');
    JsRegex::new(&out, "").ok()
}

fn primary_arg(tool_name: &str, input: &Value) -> String {
    let text = |key: &str| input.get(key).filter(|v| !v.is_null()).map(js_string);
    if matches!(tool_name, "Bash" | "bash" | "shell") {
        return text("command").unwrap_or_default();
    }
    text("file_path")
        .or_else(|| text("path"))
        .or_else(|| text("command"))
        .or_else(|| text("file"))
        .unwrap_or_default()
}

fn js_string(value: &Value) -> String {
    value_to_string(value)
}

/// A handler's `if`: `Tool(glob)` against the tool and its primary argument. Events that are
/// not tool events never pass a condition; an unparseable one passes.
pub fn if_condition_passes(condition: Option<&Value>, event: &str, tool_name: &str, tool_input: &Value) -> bool {
    let Some(condition) = condition.filter(|c| !c.is_null()) else { return true };
    let text = js_string(condition);
    if js_trim(&text).is_empty() {
        return true;
    }
    if !TOOL_IF_EVENTS.contains(&event) {
        return false;
    }
    let pattern = JsRegex::new_static(r"^\s*([A-Za-z0-9_*]+)\s*\(([^)]*)\)\s*$", "");
    let Some(captures) = pattern.captures(&text) else { return true };
    let (tool, glob) = (captures.get(1).unwrap_or_default(), js_trim(captures.get(2).unwrap_or_default()));
    if tool != "*" && tool != tool_name {
        return false;
    }
    glob_regex(glob).is_none_or(|re| re.is_match(&primary_arg(tool_name, tool_input)))
}

/// The key two handlers share when they would run the same thing.
pub fn dedupe_key(handler: &HookHandler) -> String {
    let raw = &handler.raw;
    let text = |key: &str| raw.get(key).map(js_string).unwrap_or_default();
    let if_key = raw.get("if").filter(|v| !v.is_null()).map(|v| format!("|if:{}", json_stringify(v))).unwrap_or_default();
    match raw.get("type").and_then(Value::as_str).unwrap_or_default() {
        "command" => {
            let root = handler.plugin_root.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let args = raw.get("args").filter(|v| !v.is_null()).map_or_else(|| "null".to_owned(), json_stringify);
            format!("command:{root}:{}:{args}{if_key}", text("command"))
        }
        "http" => format!("http:{}{if_key}", text("url")),
        "mcp_tool" => format!("mcp_tool:{}:{}{if_key}", text("server"), text("tool")),
        "prompt" => format!("prompt:{}{if_key}", text("prompt")),
        other => format!("{}:{}", if other.is_empty() { "unknown" } else { other }, json_stringify(raw)),
    }
}

/// What names a handler's shell in a failure message.
pub fn shell_count_for(handler: &HookHandler) -> String {
    let raw = &handler.raw;
    match raw.get("type").and_then(Value::as_str) {
        Some("command") => {
            if raw.get("args").is_some_and(|a| !a.is_null() && a.as_bool() != Some(false)) {
                return "exec".to_owned();
            }
            match raw.get("shell").and_then(Value::as_str) {
                Some(shell @ ("powershell" | "bash")) => shell.to_owned(),
                _ => default_shell_kind().to_owned(),
            }
        }
        Some(other) => other.to_owned(),
        None => "unknown".to_owned(),
    }
}

pub fn default_shell_kind() -> &'static str {
    if cfg!(windows) { "powershell" } else { "bash" }
}

/// The legacy rule list of a parsed document: an array, or `toolBefore` / `beforeTool` /
/// `hooks.toolBefore`.
pub fn normalize_rules(raw: &Value) -> Vec<Value> {
    let list = if raw.is_array() {
        raw.as_array()
    } else {
        raw.get("toolBefore")
            .and_then(Value::as_array)
            .or_else(|| raw.get("beforeTool").and_then(Value::as_array))
            .or_else(|| raw.pointer("/hooks/toolBefore").and_then(Value::as_array))
    };
    // `rule && typeof rule === 'object'`: a JavaScript array is an object too.
    list.map(|rules| rules.iter().filter(|r| r.is_object() || r.is_array()).cloned().collect()).unwrap_or_default()
}

/// The call a legacy rule is matched against.
pub struct Subject<'a> {
    pub name: &'a str,
    pub args: &'a Value,
    pub cwd: &'a str,
}

fn matches_list(pattern: Option<&Value>, value: &str) -> bool {
    let Some(pattern) = pattern.filter(|p| !p.is_null()) else { return true };
    if pattern.as_str().is_some_and(|s| s == "*" || s == "all") {
        return true;
    }
    let items: Vec<&Value> = match pattern {
        Value::Array(list) => list.iter().collect(),
        single => vec![single],
    };
    items.iter().any(|item| {
        let text = if item.is_null() { String::new() } else { js_trim(&js_string(item)).to_owned() };
        if text.is_empty() || text == "*" || text == "all" {
            return true;
        }
        match text.strip_suffix('*') {
            Some(prefix) => value.starts_with(prefix),
            None => text == value,
        }
    })
}

pub fn rule_matches(rule: &Value, subject: &Subject<'_>) -> bool {
    if !rule.is_object() || rule.get("enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    let first = |keys: &[&str]| keys.iter().find_map(|k| rule.get(*k).filter(|v| !v.is_null()));
    if !matches_list(first(&["tool", "name", "tools"]), subject.name) {
        return false;
    }
    if let Some(cwd) = rule.get("cwd").filter(|c| !c.is_null() && c.as_str() != Some("")) {
        if !subject.cwd.contains(&js_string(cwd)) {
            return false;
        }
    }
    if let Some(needles) = first(&["match", "contains"]) {
        let haystack = json_stringify(
            &serde_json::json!({"args": subject.args, "cwd": if subject.cwd.is_empty() { Value::Null } else { Value::String(subject.cwd.to_owned()) }}),
        );
        let list: Vec<&Value> = match needles {
            Value::Array(list) => list.iter().collect(),
            single => vec![single],
        };
        if !list.iter().any(|needle| haystack.contains(&js_string(needle))) {
            return false;
        }
    }
    true
}

/// A legacy rule's verdict.
#[derive(Clone, PartialEq, Debug)]
pub struct RuleDecision {
    pub action: &'static str,
    pub args: Option<Value>,
    pub name: Option<String>,
    pub reason: Option<String>,
}

fn reason_of(rule: &Value) -> Option<String> {
    ["reason", "message"].iter().find_map(|k| rule.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())).map(str::to_owned)
}

pub fn decision_from_rule(rule: &Value, subject: &Subject<'_>) -> RuleDecision {
    let action = ["action", "decision"]
        .iter()
        .find_map(|k| rule.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .unwrap_or("allow")
        .to_lowercase();
    match action.as_str() {
        "deny" | "block" => RuleDecision {
            action: "deny",
            args: None,
            name: None,
            reason: Some(reason_of(rule).unwrap_or_else(|| format!("blocked by hook rule for {}", subject.name))),
        },
        "modify" | "rewrite" => {
            let args = match rule.get("args").filter(|a| a.is_object()) {
                Some(args) => args.clone(),
                None => {
                    let mut merged: Map<String, Value> = subject.args.as_object().cloned().unwrap_or_default();
                    if let Some(patch) = rule.get("patch").and_then(Value::as_object) {
                        merged.extend(patch.clone());
                    }
                    Value::Object(merged)
                }
            };
            let name = ["updatedToolName", "replaceTool", "targetTool"]
                .iter()
                .find_map(|k| rule.get(*k).filter(|v| !v.is_null()))
                .and_then(Value::as_str)
                .map(js_trim)
                .filter(|n| !n.is_empty())
                .map(str::to_owned);
            RuleDecision {
                action: "modify",
                args: Some(args),
                name,
                reason: Some(reason_of(rule).unwrap_or_else(|| format!("modified by hook rule for {}", subject.name))),
            }
        }
        "ask" => RuleDecision {
            action: "ask",
            args: None,
            name: None,
            reason: Some(reason_of(rule).unwrap_or_else(|| format!("approval requested by hook rule for {}", subject.name))),
        },
        _ => RuleDecision { action: "allow", args: None, name: None, reason: reason_of(rule) },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn if_conditions_match_tool_and_primary_argument() {
        let input = json!({"command": "git push origin"});
        assert!(if_condition_passes(Some(&json!("Bash(git push*)")), "PreToolUse", "Bash", &input));
        assert!(!if_condition_passes(Some(&json!("Bash(git pull*)")), "PreToolUse", "Bash", &input));
        assert!(!if_condition_passes(Some(&json!("Read(*)")), "PreToolUse", "Bash", &input));
        assert!(if_condition_passes(Some(&json!("not a pattern")), "PreToolUse", "Bash", &input));
        assert!(!if_condition_passes(Some(&json!("Bash(*)")), "Stop", "Bash", &input), "not a tool event");
        assert!(if_condition_passes(None, "Stop", "x", &input));
    }

    #[test]
    fn legacy_rules_match_by_tool_pattern_cwd_and_content() {
        let args = json!({"command": "rm -rf /"});
        let subject = Subject { name: "shell", args: &args, cwd: "/work/proj" };
        assert!(rule_matches(&json!({"tool": "sh*", "match": "rm -rf"}), &subject));
        assert!(!rule_matches(&json!({"tool": "read"}), &subject));
        assert!(!rule_matches(&json!({"tool": "*", "enabled": false}), &subject));
        assert!(!rule_matches(&json!({"cwd": "/other"}), &subject));
        let deny = decision_from_rule(&json!({"action": "block"}), &subject);
        assert_eq!((deny.action, deny.reason.as_deref()), ("deny", Some("blocked by hook rule for shell")));
        let patched = decision_from_rule(&json!({"action": "rewrite", "patch": {"command": "ls"}}), &subject);
        assert_eq!(patched.args, Some(json!({"command": "ls"})));
        assert_eq!(decision_from_rule(&json!({}), &subject).action, "allow");
    }

    #[test]
    fn rules_are_found_in_every_supported_container() {
        assert_eq!(normalize_rules(&json!([{"a": 1}, 3, "x", null])).len(), 1);
        assert_eq!(normalize_rules(&json!([{"a": 1}, [2]])).len(), 2);
        assert_eq!(normalize_rules(&json!({"hooks": {"toolBefore": [{"a": 1}]}})).len(), 1);
        assert!(normalize_rules(&json!({"other": 1})).is_empty());
    }
}
