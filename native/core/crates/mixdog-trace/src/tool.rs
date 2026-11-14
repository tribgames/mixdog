//! The tool rows of `agent-trace-format.mjs`: `traceAgentTool` (the `tool` row, the `tool_slow` row)
//! and `traceAgentToolFailure` (the `tool-failures.jsonl` row), with what they are built from:
//! `classifyToolFailure`, the secret redaction, `summarizeToolArgs`, `parseGrepCoverage`,
//! `countJsonNextCalls` (`tools/next-call-utils.mjs`) and the argument hash.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::builders::Args;
use crate::record::truthy;
use crate::text::slice_utf16;

macro_rules! re {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

re!(REDACT_KEY, r"token|secret|password|passwd|credential|authorization|api[_-]?key", "i");
re!(BODY_KEY, r"content|old_string|new_string|patch|rewrite", "i");
re!(SECRET_ASSIGNMENT, r"((?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY)\s*=\s*)\S+", "gi");
re!(BEARER_HEADER, r"(Authorization:\s*Bearer\s+)\S+", "gi");
re!(SECRET_QUERY_PARAM, r"([?&](?:token|api[-_]?key|access[-_]?token|auth|password|secret)=)[^&\s#]+", "gi");
re!(SECRET_LONG_FLAG, r"(--(?:password|token|secret|api[-_]?key)(?:\s+|=))\S+", "gi");
re!(SECRET_SHORT_FLAG, r"((?:^|\s)-p(?:\s+|=))\S+", "g");
re!(URL_USERINFO, r"(:\/\/[^:/\s@]+:)[^@\s]+(@)", "g");
re!(ERROR_PREFIX, r"^Error:\s*", "i");

/// `text.replace(re, '$1[redacted]')`.
fn redact_with(text: &str, re: &JsRegex) -> String {
    re.replace_all_with(text, |c| format!("{}[redacted]", c.get(1).unwrap_or("")))
}

/// `_redactShellCommand`.
pub fn redact_shell_command(cmd: &str) -> String {
    let mut out = redact_with(cmd, &SECRET_ASSIGNMENT);
    out = redact_with(&out, &BEARER_HEADER);
    out = redact_with(&out, &SECRET_LONG_FLAG);
    out = redact_with(&out, &SECRET_SHORT_FLAG);
    out = URL_USERINFO.replace_all_with(&out, |c| format!("{}[redacted]{}", c.get(1).unwrap_or(""), c.get(2).unwrap_or("")));
    redact_with(&out, &SECRET_QUERY_PARAM)
}

/// `_redactLogText` (a non-string is the empty text).
pub fn redact_log_text(text: &str) -> String {
    let mut out = redact_with(text, &BEARER_HEADER);
    out = redact_with(&out, &SECRET_QUERY_PARAM);
    out = redact_with(&out, &SECRET_ASSIGNMENT);
    out = redact_with(&out, &SECRET_LONG_FLAG);
    out = redact_with(&out, &SECRET_SHORT_FLAG);
    URL_USERINFO.replace_all_with(&out, |c| format!("{}[redacted]{}", c.get(1).unwrap_or(""), c.get(2).unwrap_or("")))
}

// ---------------------------------------------------------------------------
// summarizeToolArgs
// ---------------------------------------------------------------------------

fn tool_arg_keys(tool: &str) -> Option<&'static [&'static str]> {
    Some(match tool {
        "read" => &["file_path", "path", "offset", "limit", "line", "context"],
        "grep" => &["pattern", "path", "glob", "output_mode", "head_limit", "offset"],
        "glob" => &["pattern", "path", "head_limit", "offset", "sort"],
        "find" => &["query", "path", "head_limit"],
        "list" => &["path", "head_limit", "offset"],
        "recall" => &["query", "limit", "session_id", "cwd"],
        "search" => &["query", "limit", "cwd"],
        "code_graph" => &["mode", "file", "files", "symbol", "symbols", "body", "language", "limit", "depth", "page", "cwd"],
        "shell" => &["command", "cwd", "timeout_ms"],
        "task" => &["action", "task_id"],
        "edit" => &["file_path", "replace_all"],
        "edit_many" => &["edits"],
        "write" => &["path"],
        "apply_patch" => &["base_path", "dry_run"],
        _ => return None,
    })
}

/// `Object.keys(value)` of an object or array, JavaScript order.
fn own_keys(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => mixdog_js::js_object_keys(map).into_iter().cloned().collect(),
        Value::Array(list) => (0..list.len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

fn own_get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        Value::Array(list) => key.parse::<usize>().ok().and_then(|i| list.get(i)),
        _ => None,
    }
}

/// `compactTraceArgValue`.
fn compact_arg_value(value: &Value, key: &str, depth: usize) -> Value {
    if REDACT_KEY.is_match(key) {
        return Value::String("[redacted]".into());
    }
    match value {
        Value::Null | Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::String(s) => {
            let text = if key == "command" { redact_shell_command(s) } else { s.clone() };
            let limit = if BODY_KEY.is_match(key) { 60 } else { 180 };
            if mixdog_js::utf16_len(&text) > limit {
                Value::String(format!("{}...", slice_utf16(&text, limit)))
            } else {
                Value::String(text)
            }
        }
        Value::Array(list) => {
            if depth >= 2 {
                return Value::String(format!("[{} items]", list.len()));
            }
            Value::Array(list.iter().take(6).map(|v| compact_arg_value(v, key, depth + 1)).collect())
        }
        Value::Object(map) => {
            if depth >= 2 {
                return Value::String("{...}".into());
            }
            let mut out = Map::new();
            for k in mixdog_js::js_object_keys(map).into_iter().take(12) {
                out.insert(k.clone(), compact_arg_value(&map[k], k, depth + 1));
            }
            Value::Object(out)
        }
    }
}

/// `summarizeToolArgs(toolName, args)`.
pub fn summarize_tool_args(tool_name: &str, args: Option<&Value>) -> Option<Value> {
    let args = args.filter(|a| a.is_object() || a.is_array())?;
    let keys: Vec<String> = match tool_arg_keys(tool_name) {
        Some(list) => list.iter().map(|k| (*k).to_string()).collect(),
        None => own_keys(args).into_iter().take(8).collect(),
    };
    let mut out = Map::new();
    for key in &keys {
        if let Some(v) = own_get(args, key) {
            out.insert(key.clone(), compact_arg_value(v, key, 0));
        }
    }
    for count_key in ["edits", "writes", "file_path", "path"] {
        if let Some(Value::Array(list)) = own_get(args, count_key) {
            out.insert(format!("{count_key}_count"), Value::from(list.len()));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `hashTraceValue`: the first 16 hex digits of the sha256 of the key-sorted JSON.
pub fn hash_trace_value(value: &Value) -> String {
    let digest = Sha256::digest(mixdog_js::json_stringify_sorted(value).as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/// `toolTraceText`.
pub fn tool_trace_text(value: &Value) -> String {
    if let Value::String(s) = value {
        return s.clone();
    }
    let parts = match value {
        Value::Array(list) => Some(list),
        other => other.get("content").and_then(Value::as_array),
    };
    if let Some(parts) = parts {
        return parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if value.is_null() { String::new() } else { mixdog_js::json_stringify(value) }
}

fn lines(text: &str) -> Vec<&str> {
    // `split(/\r?\n/)`: a `\r` goes only when a `\n` follows it.
    let mut parts: Vec<&str> = text.split('\n').collect();
    let last = parts.len() - 1;
    for part in &mut parts[..last] {
        *part = part.strip_suffix('\r').unwrap_or(part);
    }
    parts
}

/// `_firstNonEmptyLine`.
fn first_non_empty_line(text: &str) -> String {
    lines(text).into_iter().find(|l| !js_trim(l).is_empty()).map(|l| js_trim(l).to_string()).unwrap_or_default()
}

/// `toolFailureCause`.
fn tool_failure_cause(text: &str) -> String {
    let trimmed = js_trim(text);
    let body = ERROR_PREFIX.find(trimmed).filter(|r| r.start == 0).map_or(trimmed, |r| &trimmed[r.end..]);
    if body.starts_with('{') {
        if let Ok(value) = mixdog_js::json_parse(body) {
            if value.get("ok") == Some(&Value::Bool(false)) {
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    return error.to_string();
                }
            }
        }
    }
    text.to_string()
}

/// `toolFailureLeadingLine`.
fn leading_line(text: &str) -> String {
    let found = lines(text).into_iter().map(js_trim).find(|l| !l.is_empty() && !l.starts_with("\u{26a0}\u{fe0f} "));
    match found {
        Some(l) => ERROR_PREFIX.find(l).filter(|r| r.start == 0).map_or(l, |r| &l[r.end..]).to_string(),
        None => String::new(),
    }
}

re!(EXPECTED_CANCEL, r#"^Session\s+"[^"]+"\s+closed:\s*(?:aborted|closed)\s+during call\b"#, "i");
re!(USER_CONTROL_CANCEL, r"^(?:Error:\s*)?(?:Browser command interrupted by local user input\.|computer_session_aborted:|computer_user_control_active:|computer_user_takeover:)", "i");

fn is_expected_cancellation(raw: &str) -> bool {
    EXPECTED_CANCEL.is_match(&leading_line(raw))
}

fn is_user_control_cancellation(text: &str) -> bool {
    USER_CONTROL_CANCEL.is_match(mixdog_js::js_trim_start(text))
}

// ---------------------------------------------------------------------------
// classifyToolFailure
// ---------------------------------------------------------------------------

re!(PATCH_COMMITTED, r"already applied to disk \(writes committed\)|applied to disk \(committed\) and left in place|applied \(committed to disk\)|rollback was incomplete|--- rollback incomplete ---|patch partially (?:applied|created|updated|written)", "");
re!(PATCH_LIMIT, r"patch too large|byte cap", "");
re!(PATCH_DUP, r"(?:multiple|conflicting) operations target", "");
re!(PATCH_CONTEXT, r"hunk rejected|context not found|context mismatch|anchor not found|expected first old(?:/context| line)", "");
re!(PATCH_STALE, r"nearest line|first divergent line|hunk rejected", "");
re!(PATCH_PARSE_A, r"parse failed|invalid patch|malformed patch|missing \*\*\* (?:begin|end) patch|patch body is empty|unsupported patch format", "");
re!(PATCH_PARSE_B, r"contained no file sections|contains an empty file path", "");
re!(PATCH_OUTSIDE, r"target\(s\) fall outside the write root", "");
re!(PATCH_MISSING, r"enoent|no such file|target unreadable|source (?:missing or )?unreadable|destination unreadable|cannot find", "");
re!(PATCH_VERIFY, r"preflight rejected|does not support|cannot be combined|only one v4a rename|missing parsed entry|internal js dispatch|rollback snapshot target|refusing hunkless delete", "");

/// `classifyPatchFailure`.
fn classify_patch_failure(text: &str) -> Option<&'static str> {
    if PATCH_COMMITTED.is_match(text) {
        return Some("patch/partial-apply");
    }
    if PATCH_LIMIT.is_match(text) {
        return Some("patch/limit");
    }
    if PATCH_DUP.is_match(text) {
        return Some("patch/duplicate-target");
    }
    if PATCH_CONTEXT.is_match(text) {
        return Some(if PATCH_STALE.is_match(text) { "patch/stale-context" } else { "patch/context" });
    }
    if PATCH_PARSE_A.is_match(text) || PATCH_PARSE_B.is_match(text) {
        return Some("patch/parse");
    }
    if PATCH_OUTSIDE.is_match(text) {
        return Some("path/outside-root");
    }
    if PATCH_MISSING.is_match(text) {
        return None;
    }
    if PATCH_VERIFY.is_match(text) {
        return Some("patch/verification");
    }
    None
}

re!(NAV_PERMISSION, r"\b(?:eacces|eperm)\b|access is denied|permission denied|operation not permitted", "i");
re!(NAV_MISS, r#"\b(?:enoent|enotdir)\b|path does not exist|directory does not exist|no such (?:file|path)|not found at this path|file not found\b|symbol "[^"\n]*" not found in "#, "i");

/// `isReadOnlyNavigationMiss`.
fn is_read_only_navigation_miss(tool_name: &str, result: &str) -> bool {
    let tool = mixdog_js::js_to_lowercase(tool_name);
    if !["find", "glob", "grep", "list", "read", "code_graph"].contains(&tool.as_str()) {
        return false;
    }
    if NAV_PERMISSION.is_match(result) {
        return false;
    }
    NAV_MISS.is_match(result)
}

re!(C_SHELL_ARG, r#"^\[shell-tool-failed\]\s+shell arg "[^"]+" is unsupported\b"#, "i");
re!(C_SHELL_TOOL, r"^\[shell-tool-failed\](?:\s|$)", "i");
re!(C_SHELL_RUN, r"^\[shell-run-failed\](?:\s|$)", "i");
re!(C_TIMEOUT, r"\[timeout:|cause:\s*(?:timeout|cancellation)\b", "i");
re!(C_RUNTIME_CAUSE, r"cause:\s*(?:output-limit|output-capture-error|background-promotion-failed)\b", "i");
re!(C_SIGNAL, r"\[signal:\s*[^\]]+", "i");
re!(C_EDIT_MISS, r"^edit failed \(old_string (?:not found|found \d+ times)\b", "i");
re!(C_COMPACTED, r"compacted-history placeholder", "");
re!(C_VALIDATION, r"\[tool-input-validation\]", "");
re!(C_SCHEMA_LEADING_A, r"^The arguments provided to `[^`]+` are invalid JSON and could not be parsed:", "i");
re!(C_SCHEMA_LEADING_B, r"^new Goal tasks must omit ids; use updates for existing tasks$", "i");
re!(C_SCHEMA_LEADING_C, r"^goal task exceeds \d+ characters$", "i");
re!(C_SCHEMA_LEADING_D, r"^goal (?:tasks|updates) support at most \d+ entries(?:$|;)", "i");
re!(C_SCHEMA_LEADING_E, r"^goal arguments contain unknown fields:", "i");
re!(C_SCHEMA_LEADING_F, r"^Unsupported field for GitHub [\w.]+\.$", "i");
re!(C_SCHEMA_LEADING_G, r#"^browser action "[^"]+" (?:does not accept input field|requires input\.|accepts only one input target form|fields must be inside input:|input\.[^\n]*(?:must be|requires|accepts at most))"#, "i");
re!(C_SCHEMA_LEADING_H, r"^Computer Use [^\n]*(?:does not accept|requires input|must be|accepts at most)", "i");
re!(C_SCHEMA_LEADING_I, r"^regex parse error:", "i");
re!(C_HTTP_ERROR, r"\berrorCode:\s*HTTP_ERROR\b", "");
re!(C_MEDIA, r"^generation failed on [^\n]+failed \([45]\d\d\):", "i");
re!(C_CLOSING, r"^Web search failed: native web search failed: .+: runtime is closing$", "i");
re!(C_PATCH_SURFACE, r"apply_patch|native patch|v4a|\*\*\* begin patch|hunk rejected|context not found", "");
re!(C_ADD_EXISTS, r"add file target already exists", "");
re!(C_LOCK, r"advisory lock (?:timeout|busy)|lock held by pid|\.mixdog-lock", "");
re!(C_PERMISSION, r"eacces|eperm|permission|denied|forbidden|operation not permitted", "");
re!(C_STAT_DELETE, r"\bstat\b.*\bfor delete\b.*\(os error 2\)", "");
re!(C_SCHEMA_A, r"requires either|invalid arguments|unknown parameter|unknown memory action", "i");
re!(C_SCHEMA_B, r"must be|schema|required|old_string is .*>?=", "i");
re!(C_NOT_ALLOWED, r"not in allow-list|not allowed", "");
re!(C_EXIT_CODE, r"^\s*\[exit code:\s*\d+\]", "i");
re!(C_ABSENT_EXEC, r"executable not found in this environment", "");
re!(C_ENOENT, r"enoent|cannot find|not found at this path|path does not exist|no such file|file not found in graph|unreadable", "");
re!(C_TIMED_OUT, r"timed out|timeout|interrupted|aborted", "");
re!(C_TOOL_SURFACE, r"unknown tool|tool.*not.*available|missing.*tool", "");

/// `classifyToolFailure(resultText, toolName)`.
pub fn classify_tool_failure(result: &Value, tool_name: &str) -> String {
    let raw = tool_failure_cause(&tool_trace_text(result));
    let text = mixdog_js::js_to_lowercase(&raw);
    if is_expected_cancellation(&raw) {
        return "expected-cancellation".into();
    }
    let leading = leading_line(&raw);
    let out = |s: &str| s.to_string();
    if C_SHELL_ARG.is_match(&leading) {
        return out("schema/args");
    }
    if C_SHELL_TOOL.is_match(&leading) {
        return out("tool-call/failure");
    }
    if C_SHELL_RUN.is_match(&leading) {
        if C_TIMEOUT.is_match(&leading) {
            return out("timeout/abort");
        }
        if C_RUNTIME_CAUSE.is_match(&leading) {
            return out("runtime/failure");
        }
        if C_SIGNAL.is_match(&leading) {
            return out("process/signal");
        }
        return out("command-exit");
    }
    if tool_name == "edit" && C_EDIT_MISS.is_match(&leading) {
        return out("runtime/failure");
    }
    if C_COMPACTED.is_match(&text) {
        return out("expected-preflight");
    }
    if C_VALIDATION.is_match(&text) {
        return out("schema/args");
    }
    if is_user_control_cancellation(&leading) {
        return out("expected-cancellation");
    }
    let schema_leading = [
        &C_SCHEMA_LEADING_A, &C_SCHEMA_LEADING_B, &C_SCHEMA_LEADING_C, &C_SCHEMA_LEADING_D, &C_SCHEMA_LEADING_E,
        &C_SCHEMA_LEADING_F, &C_SCHEMA_LEADING_G, &C_SCHEMA_LEADING_H, &C_SCHEMA_LEADING_I,
    ];
    if schema_leading.iter().any(|re| re.is_match(&leading)) {
        return out("schema/args");
    }
    if tool_name == "web_fetch" && C_HTTP_ERROR.is_match(&raw) {
        return out("upstream/http");
    }
    if tool_name == "media" && C_MEDIA.is_match(&leading) {
        return out("upstream/http");
    }
    if tool_name == "web_search" && C_CLOSING.is_match(&leading) {
        return out("lifecycle/closing");
    }
    let patch_surface = tool_name == "apply_patch" || (tool_name != "shell" && C_PATCH_SURFACE.is_match(&text));
    if patch_surface && PATCH_COMMITTED.is_match(&text) {
        return out("patch/partial-apply");
    }
    if patch_surface && C_ADD_EXISTS.is_match(&text) {
        return out("expected-preflight");
    }
    if C_LOCK.is_match(&text) {
        return out("resource/lock");
    }
    if C_PERMISSION.is_match(&text) {
        return out("path/permission");
    }
    if patch_surface {
        if let Some(category) = classify_patch_failure(&text) {
            return out(category);
        }
        if C_STAT_DELETE.is_match(&text) {
            return out("path/enoent");
        }
    }
    if C_SCHEMA_A.is_match(&leading) || C_SCHEMA_B.is_match(&leading) {
        return out("schema/args");
    }
    if C_NOT_ALLOWED.is_match(&text) {
        return out("permission");
    }
    if tool_name == "shell" || C_EXIT_CODE.is_match(&raw) {
        return out("command-exit");
    }
    if is_read_only_navigation_miss(tool_name, &raw) {
        return out("navigation/miss");
    }
    if C_ABSENT_EXEC.is_match(&text) {
        return out("environment/unavailable");
    }
    if C_ENOENT.is_match(&text) {
        return out("path/enoent");
    }
    if C_TIMED_OUT.is_match(&text) {
        return out("timeout/abort");
    }
    if C_TOOL_SURFACE.is_match(&text) {
        return out("tool-surface");
    }
    out("runtime/failure")
}

// ---------------------------------------------------------------------------
// countJsonNextCalls, parseGrepCoverage
// ---------------------------------------------------------------------------

re!(NEXT_CALL, r"next_call:\s*([A-Za-z_][\w]*)\(", "g");

/// `parseNextCallArgs(text, start)`: whether a `{...}` JSON object closed by `)` starts at `start`.
fn next_call_args_parse(text: &str, start: usize) -> bool {
    let mut chars = text[start..].char_indices().peekable();
    // skip whitespace
    let mut at = None;
    while let Some(&(i, c)) = chars.peek() {
        if mixdog_js::is_js_space(c) {
            chars.next();
        } else {
            at = Some(i);
            break;
        }
    }
    let Some(open) = at else { return false };
    if !text[start + open..].starts_with('{') {
        return false;
    }
    let (mut depth, mut in_string, mut escaped) = (0_i32, false, false);
    for (i, ch) in text[start + open..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + open + i + 1;
                    let raw = js_trim(&text[start..end]);
                    let rest = text[end..].trim_start_matches(mixdog_js::is_js_space);
                    return rest.starts_with(')') && mixdog_js::json_parse(raw).is_ok();
                }
            }
            _ => {}
        }
    }
    false
}

/// `countJsonNextCalls(text)`.
pub fn count_json_next_calls(text: &str) -> usize {
    if !text.contains("next_call:") {
        return 0;
    }
    NEXT_CALL.captures_iter(text).filter(|c| next_call_args_parse(text, c.range().end)).count()
}

re!(GREP_HEADER, r"^# (.+):(\d+) \[lines (\d+)-(\d+)\]$", "");
re!(GREP_SECTION, r"^# grep (.+)$", "");
re!(GREP_DELIM, r"([:-])(\d+)\1", "");
re!(GREP_OMITTED, r"^(\d+)(?::|-)", "");
re!(DRIVE_LETTER, r"^[A-Za-z]:", "");

const GREP_COVERAGE_MAX: usize = 512;

struct GrepPrefix {
    path: String,
    line_no: u64,
}

/// `splitGrepLinePrefix(line)` (not match-only).
fn split_grep_line_prefix(line: &str) -> Option<GrepPrefix> {
    if line.is_empty() {
        return None;
    }
    let search_from = if DRIVE_LETTER.is_match(line) { 2 } else { 0 };
    let caps = GREP_DELIM.captures(&line[search_from..])?;
    let path_end = search_from + caps.range().start;
    if path_end == 0 {
        return None;
    }
    Some(GrepPrefix { path: line[..path_end].to_string(), line_no: caps.get(2)?.parse().ok()? })
}

/// `parseGrepCoverage`: `None` where Node returns null.
pub fn parse_grep_coverage(result_text: &Value, tool_name: &str, tool_args: Option<&Value>, result_kind: Option<&str>) -> Option<Value> {
    let output_mode = tool_args.and_then(|a| a.get("output_mode"));
    if tool_name != "grep"
        || result_kind == Some("error")
        || output_mode.is_some_and(|m| truthy(m) && m.as_str() != Some("content_with_context"))
    {
        return None;
    }
    let tool_path = tool_args.and_then(|a| a.get("path")).and_then(Value::as_str);
    let text = if result_text.is_null() { String::new() } else { value_to_string(result_text) };
    let mut out: Vec<(String, u64)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut section_path: Option<String> = None;
    let mut raw_remaining = 0_u64;
    let mut add = |path: &str, line_no: u64, out: &mut Vec<(String, u64)>| {
        if path.is_empty() || line_no < 1 || out.len() >= GREP_COVERAGE_MAX {
            return;
        }
        if !seen.insert((path.to_string(), line_no)) {
            return;
        }
        out.push((path.replace('\\', "/"), line_no));
    };
    for line in lines(&text) {
        if raw_remaining > 0 {
            raw_remaining -= 1;
            continue;
        }
        if let Some(c) = GREP_HEADER.captures(line) {
            let num = |g: usize| c.get(g).and_then(|s| s.parse::<u64>().ok());
            if let (Some(m), Some(s), Some(e)) = (num(2), num(3), num(4)) {
                let safe = |n: u64| n <= 9_007_199_254_740_991;
                if safe(m) && safe(s) && safe(e) && s >= 1 && e >= s && m >= s && m <= e {
                    let path = c.get(1).unwrap_or("");
                    let mut n = s;
                    while n <= e && out.len() < GREP_COVERAGE_MAX {
                        add(path, n, &mut out);
                        n += 1;
                    }
                    raw_remaining = e - s + 1;
                    continue;
                }
            }
        }
        if let Some(c) = GREP_SECTION.captures(line) {
            let name = c.get(1).unwrap_or("");
            if !name.starts_with("pattern:") {
                section_path = Some(name.to_string());
            }
            continue;
        }
        let split = split_grep_line_prefix(line);
        let omitted = if split.is_none() && tool_path.is_some() { GREP_OMITTED.captures(line) } else { None };
        let section_omitted = if split.is_none() && section_path.is_some() { GREP_OMITTED.captures(line) } else { None };
        let number = |c: &mixdog_js::Caps| c.get(1).and_then(|s| s.parse::<u64>().ok());
        let path = split
            .as_ref()
            .map(|s| s.path.clone())
            .filter(|p| !p.is_empty())
            .or_else(|| omitted.as_ref().and(tool_path).map(str::to_string).filter(|p| !p.is_empty()))
            .or_else(|| section_omitted.as_ref().and(section_path.clone()).filter(|p| !p.is_empty()));
        let line_no = split
            .as_ref()
            .map(|s| s.line_no)
            .filter(|n| *n != 0)
            .or_else(|| omitted.as_ref().and_then(number).filter(|n| *n != 0))
            .or_else(|| section_omitted.as_ref().and_then(number).filter(|n| *n != 0));
        if let (Some(path), Some(line_no)) = (path, line_no) {
            add(&path, line_no, &mut out);
        }
        if out.len() >= GREP_COVERAGE_MAX {
            break;
        }
    }
    (!out.is_empty()).then(|| {
        Value::Array(
            out.into_iter()
                .map(|(path, line)| {
                    let mut o = Map::new();
                    o.insert("path".into(), Value::String(path));
                    o.insert("line".into(), Value::from(line));
                    Value::Object(o)
                })
                .collect(),
        )
    })
}

// ---------------------------------------------------------------------------
// the rows
// ---------------------------------------------------------------------------

/// `MIXDOG_SLOW_TOOL_TRACE_MS` / `_NAMES`.
#[derive(Debug, Clone)]
pub struct SlowTool {
    pub threshold_ms: i64,
    /// `None`: every tool (`*`); `Some(empty)` also means every tool, as in Node.
    pub names: Option<Vec<String>>,
}

impl SlowTool {
    pub fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Self {
        let threshold_ms = get("MIXDOG_SLOW_TOOL_TRACE_MS")
            .and_then(|v| {
                let t = mixdog_js::js_trim_start(&v).to_string();
                let digits: String = t.strip_prefix('+').unwrap_or(&t).chars().take_while(char::is_ascii_digit).collect();
                digits.parse::<i64>().ok()
            })
            .filter(|n| *n > 0)
            .unwrap_or(3000);
        let raw = get("MIXDOG_SLOW_TOOL_TRACE_NAMES").filter(|v| !v.is_empty()).unwrap_or_else(|| "recall,grep,code_graph".into());
        let names = if js_trim(&raw) == "*" {
            None
        } else {
            Some(raw.split(',').map(|n| js_trim(n).to_string()).filter(|n| !n.is_empty()).collect())
        };
        Self { threshold_ms, names }
    }

    fn matches(&self, tool_name: &str) -> bool {
        match &self.names {
            None => true,
            Some(names) => names.is_empty() || names.iter().any(|n| n == tool_name),
        }
    }
}

fn number_of(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `summarizeToolTiming`.
fn summarize_tool_timing(timing: Option<&Value>) -> Option<Value> {
    let timing = timing.filter(|t| t.is_object())?;
    let num = |key: &str| {
        let n = number_of(timing.get(key));
        n.is_finite().then_some(n)
    };
    let (dispatch, exec_start, exec_end, post, done) = (
        num("dispatchStartedAt"),
        num("executionStartedAt"),
        num("executionCompletedAt"),
        num("postprocessStartedAt"),
        num("resultCompletedAt"),
    );
    let mut out = Map::new();
    let mut duration = |key: &str, start: Option<f64>, end: Option<f64>| {
        if let (Some(s), Some(e)) = (start, end) {
            out.insert(key.into(), json_number(((e - s) + 0.5).floor().max(0.0)));
        }
    };
    duration("dispatch_wait_ms", dispatch, exec_start);
    duration("execution_ms", exec_start, exec_end);
    duration("result_collection_wait_ms", exec_end, post);
    duration("postprocess_ms", post, done);
    duration("total_ms", dispatch, done);
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Everything `traceAgentTool` writes for one call.
#[derive(Debug)]
pub struct ToolRecords {
    pub tool: Args,
    pub slow: Option<Args>,
    /// The `tool-failures.jsonl` row, when `resultKind === 'error'` and the failure is not an
    /// expected session close.
    pub failure: Option<Value>,
}

fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Null,
    }
}

fn put(map: &mut Args, key: &str, value: Value) {
    map.insert(key.into(), value);
}

fn copy(map: &mut Args, a: &Args, key: &str) {
    if let Some(v) = a.get(key) {
        map.insert(key.into(), v.clone());
    }
}

/// The tool name as `String(toolName || '')` reads it.
fn tool_name_of(a: &Args) -> String {
    match a.get("toolName") {
        Some(v) if truthy(v) => value_to_string(v),
        _ => String::new(),
    }
}

fn result_text_string(a: &Args) -> Option<&str> {
    a.get("resultText").and_then(Value::as_str)
}

/// `traceAgentToolFailure`'s row (`None`: Node writes nothing). `ts` is `now_ms`.
pub fn tool_failure_row(a: &Args, now_ms: i64) -> Option<Value> {
    let clean = redact_log_text(&tool_trace_text(a.get("resultText").unwrap_or(&Value::Null)));
    if is_expected_cancellation(&clean) {
        return None;
    }
    let tool_name = tool_name_of(a);
    let tool_ms = number_of(a.get("toolMs"));
    let session_id = match a.get("sessionId") {
        Some(v) if truthy(v) => Value::String(value_to_string(v)),
        _ => Value::String("no-session".into()),
    };
    let result_kind = match a.get("resultKind") {
        None => Value::String("error".into()),
        Some(v) if truthy(v) => v.clone(),
        Some(_) => Value::String("error".into()),
    };
    let mut row = Map::new();
    put(&mut row, "ts", Value::from(now_ms));
    put(&mut row, "session_id", session_id);
    put(&mut row, "iteration", a.get("iteration").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    put(&mut row, "tool_name", or_null(a.get("toolName")));
    put(&mut row, "tool_kind", or_null(a.get("toolKind")));
    put(&mut row, "result_kind", result_kind);
    put(&mut row, "category", Value::String(classify_tool_failure(&Value::String(clean.clone()), &tool_name)));
    put(&mut row, "agent", or_null(a.get("agent")));
    put(&mut row, "model", or_null(a.get("model")));
    put(&mut row, "cwd", or_null(a.get("cwd")));
    put(&mut row, "tool_ms", if tool_ms.is_finite() { json_number(tool_ms) } else { Value::Null });
    put(&mut row, "tool_args", summarize_tool_args(&tool_name, a.get("toolArgs")).unwrap_or(Value::Null));
    put(&mut row, "error_first_line", Value::String(slice_utf16(&first_non_empty_line(&tool_failure_cause(&clean)), 300)));
    put(&mut row, "error_preview", Value::String(slice_utf16(&clean, 1200)));
    put(&mut row, "result_bytes_est", Value::from(clean.len()));
    put(&mut row, "result_lines_est", Value::from(if clean.is_empty() { 0 } else { clean.split('\n').count() }));
    Some(Value::Object(row))
}

/// `traceAgentTool`: the `tool` row, the `tool_slow` row and the failure row.
pub fn tool_records(a: &Args, slow: &SlowTool, now_ms: i64) -> ToolRecords {
    let tool_name = tool_name_of(a);
    let result = a.get("resultText");
    let result_str = result_text_string(a);
    let next_calls = count_json_next_calls(&match result {
        None | Some(Value::Null) => String::new(),
        Some(v) => value_to_string(v),
    });
    let bytes_est = result_str.map_or(0, str::len);
    let lines_est = result_str.map_or(0, |s| if s.is_empty() { 0 } else { s.split('\n').count() });
    let numeric_tool_ms = number_of(a.get("toolMs"));
    let timing = summarize_tool_timing(a.get("toolTiming"));
    let args = a.get("toolArgs");
    let summarized = summarize_tool_args(&tool_name, args);
    let summarized_value = summarized.clone().unwrap_or(Value::Null);
    let result_kind = a.get("resultKind").and_then(Value::as_str);
    let grep = parse_grep_coverage(result.unwrap_or(&Value::Null), a.get("toolName").and_then(Value::as_str).unwrap_or(""), args, result_kind);
    let hashed = match args {
        Some(v) if v.is_object() || v.is_array() => Some(v),
        _ => summarized.as_ref(),
    };
    let args_hash = hashed.map_or(Value::Null, |v| Value::String(hash_trace_value(v)));
    let is_error = result_kind == Some("error");
    let null_result = Value::Null;
    let first_line = if is_error {
        let cause = tool_failure_cause(&redact_log_text(&tool_trace_text(result.unwrap_or(&null_result))));
        let line = slice_utf16(&first_non_empty_line(&cause), 200);
        if line.is_empty() { Value::Null } else { Value::String(line) }
    } else {
        Value::Null
    };
    let category = if is_error {
        Value::String(classify_tool_failure(result.unwrap_or(&null_result), &tool_name))
    } else {
        Value::Null
    };
    let local_search = match a.get("localSearchTelemetry") {
        Some(Value::Object(m)) if !m.is_empty() => Value::Object(m.clone()),
        _ => Value::Null,
    };
    let mut payload = Map::new();
    if let Some(t) = &timing {
        put(&mut payload, "timing", t.clone());
    }
    if a.get("toolBatchId").is_some_and(truthy) {
        let mut batch = Map::new();
        copy_as(&mut batch, a, "toolBatchId", "batch_id");
        copy_as(&mut batch, a, "toolCallId", "tool_call_id");
        put(&mut payload, "batch", Value::Object(batch));
    }
    if let Some(list @ Value::Array(_)) = a.get("executionIntervals") {
        put(&mut payload, "execution_intervals", list.clone());
    }
    let telemetry = a.get("resultTelemetry");
    if let Some(integrity) = telemetry.and_then(|t| t.get("integrity")).filter(|v| truthy(v)) {
        put(&mut payload, "integrity", integrity.clone());
    }
    if let Some(list @ Value::Array(_)) = telemetry.and_then(|t| t.get("shellMisuse")) {
        put(&mut payload, "shell_misuse", list.clone());
    }
    let mut tool = Map::new();
    copy(&mut tool, a, "sessionId");
    copy(&mut tool, a, "iteration");
    put(&mut tool, "kind", Value::String("tool".into()));
    put(&mut tool, "agent", or_null(a.get("agent")));
    put(&mut tool, "model", or_null(a.get("model")));
    copy_as(&mut tool, a, "toolName", "tool_name");
    copy_as(&mut tool, a, "toolKind", "tool_kind");
    copy_as(&mut tool, a, "toolMs", "tool_ms");
    put(&mut tool, "tool_args", summarized_value.clone());
    put(&mut tool, "tool_args_hash", args_hash.clone());
    put(&mut tool, "tool_args_summary", summarized_value.clone());
    put(&mut tool, "result_kind", or_null(a.get("resultKind")));
    put(&mut tool, "result_error_first_line", first_line);
    put(&mut tool, "result_error_category", category);
    put(&mut tool, "result_has_next_call", Value::Bool(next_calls > 0));
    put(&mut tool, "result_next_call_count", Value::from(next_calls));
    put(&mut tool, "result_bytes_est", Value::from(bytes_est));
    put(&mut tool, "result_lines_est", Value::from(lines_est));
    put(&mut tool, "grep_coverage", grep.unwrap_or(Value::Null));
    put(&mut tool, "local_search", local_search.clone());
    put(&mut tool, "payload", Value::Object(payload));
    put(&mut tool, "cwd", or_null(a.get("cwd")));

    let slow_row = (numeric_tool_ms.is_finite() && numeric_tool_ms >= slow.threshold_ms as f64 && slow.matches(&tool_name)).then(|| {
        let mut payload = Map::new();
        put(&mut payload, "threshold_ms", Value::from(slow.threshold_ms));
        put(&mut payload, "result_kind", or_null(a.get("resultKind")));
        put(&mut payload, "tool_args", summarized_value.clone());
        put(&mut payload, "tool_args_hash", args_hash.clone());
        put(&mut payload, "tool_args_summary", summarized_value.clone());
        put(&mut payload, "result_has_next_call", Value::Bool(next_calls > 0));
        put(&mut payload, "result_next_call_count", Value::from(next_calls));
        put(&mut payload, "result_bytes_est", Value::from(bytes_est));
        put(&mut payload, "result_lines_est", Value::from(lines_est));
        put(&mut payload, "local_search", local_search.clone());
        put(&mut payload, "cwd", or_null(a.get("cwd")));
        let mut row = Map::new();
        copy(&mut row, a, "sessionId");
        copy(&mut row, a, "iteration");
        put(&mut row, "kind", Value::String("tool_slow".into()));
        put(&mut row, "agent", or_null(a.get("agent")));
        put(&mut row, "model", or_null(a.get("model")));
        copy_as(&mut row, a, "toolName", "tool_name");
        copy_as(&mut row, a, "toolKind", "tool_kind");
        put(&mut row, "tool_ms", json_number(numeric_tool_ms));
        put(&mut row, "payload", Value::Object(payload));
        row
    });
    let failure = if is_error { tool_failure_row(a, now_ms) } else { None };
    ToolRecords { tool, slow: slow_row, failure }
}

fn copy_as(map: &mut Args, a: &Args, from: &str, to: &str) {
    if let Some(v) = a.get(from) {
        map.insert(to.into(), v.clone());
    }
}