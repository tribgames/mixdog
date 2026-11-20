//! The one-line summary of a finished tool call (`shared/tool-result-summary.mjs`): from the tool name, its arguments and the
//! result text alone, a short semantic line per tool surface, or `None` when nothing reliable can be derived (the card then
//! falls back to the raw result block).
//!
//! `translate(key, original, params)` is the catalog lookup of the surface's language; [`keep_original`] is Node's default.
//! The catalog keys the summaries author are listed by [`tool_result_ui_keys`].

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::json_parse;
use mixdog_js::number_to_string;
use mixdog_js::slice_utf16;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_protocol::text_class::parse_task_notification;
use serde_json::Map;
use serde_json::Value;

use crate::results::git_media::git_result_error;
use crate::results::git_media::git_result_exit_code;
use crate::results::git_media::media_result_summary;
use crate::tool_primitives::AGENT_SURFACE_BRIEF_MAX;
use crate::tool_primitives::coalesce;
use crate::tool_primitives::compact_parts;
use crate::tool_primitives::display_path_of;
use crate::tool_primitives::display_tool_path;
use crate::tool_primitives::field;
use crate::tool_primitives::first_text;
use crate::tool_primitives::is_mcp_tool_name;
use crate::tool_primitives::normalize_tool_name;
use crate::tool_primitives::parse_tool_args;
use crate::tool_primitives::picked_text;
use crate::tool_primitives::text_of;
use crate::tool_primitives::title_status;
use crate::tool_primitives::title_word;
use crate::tool_primitives::truncate_single_line;
use crate::tool_primitives::truncate_tool_text;
use crate::tool_primitives::truthy;

/// The catalog lookup: `(key, original, params) -> text`.
pub type Translate<'a> = &'a dyn Fn(&str, &str, &Value) -> String;

/// `keepOriginal`: no catalog, the authored English.
pub fn keep_original(_key: &str, original: &str, _params: &Value) -> String {
    original.to_owned()
}

macro_rules! regex {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

/// The nouns a count label can carry, each with its catalog key `{{count}} <noun>`.
const COUNT_NOUNS: [&str; 17] = [
    "lines",
    "matches",
    "files",
    "entries",
    "candidates",
    "results",
    "skills",
    "items",
    "memories",
    "messages",
    "agents",
    "tasks",
    "references",
    "definitions",
    "symbols",
    "callers",
    "callees",
];
const STATUS_WORDS: [&str; 8] = ["Completed", "Failed", "Cancelled", "Finished", "Running", "Queued", "Pending", "Timed out"];

/// `TOOL_RESULT_UI_KEYS`: the catalog keys of the UI text this module authors, never tool output or interpolated identifiers.
pub fn tool_result_ui_keys() -> Vec<String> {
    COUNT_NOUNS
        .iter()
        .map(|noun| format!("{{{{count}}}} {noun}"))
        .chain(STATUS_WORDS.iter().map(|status| (*status).to_owned()))
        .chain(
            [
                "Image",
                "No output",
                "No results",
                "No agents or tasks",
                "Exit {{code}}",
                "Loaded {{name}}",
                "Used {{name}}",
                "Shell task {{status}} (exit {{code}})",
                "Background tasks: {{count}}",
            ]
            .iter()
            .map(|key| (*key).to_owned()),
        )
        .collect()
}

regex!(HEADER_LINE, r"^(?:agent result|background task)\b", "i");
regex!(
    FIELD_LINE,
    r"^(?:agent task|background task|status|type|target|role|agent|preset|model|effort|fast|limits|session|task-id|task_id|surface|operation|label|exit_code|timed_out|signal|notification|queueDepth|worker|worker_stage|last_progress|silent_for|tool_silent_for|watchdog|queued_followups|diagnostic|started|finished|elapsed|reused|result|message|output|protocol|version):\s*",
    "i"
);
regex!(BRACKETED_FIELD_LINE, r"^\[[a-z-]+:\s*[^\]]*\]$", "i");
regex!(
    ENVELOPE_TAG_LINE,
    r"^</?(?:final-answer|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$",
    "i"
);
regex!(NULLISH, r"^(?:undefined|null)$", "i");
regex!(JSON_OPEN, r"^[[{]", "");
regex!(STATUS_WORD, r"^(?:ok|done|success|saved|sent|updated|reloaded|connected|enabled|disabled|active|inactive)$", "i");
regex!(ZERO_COUNT, r"^\(?\s*(?:no|0)\s+(?:fuzzy\s+)?(?:match(?:es)?|results?|files?|entries|candidates?|hits?)\b", "i");
regex!(ZERO_EMPTY, r"^\(?\s*(?:empty|none)\s*\)?$", "i");
regex!(ZERO_NO_FOUND, r"^no\s+\S+\s+(?:found|matched)\b", "i");
regex!(DELTA_FIELD, r"^\s*[+-]\s*\d+(?:\s*lines?)?(?:(?:\s*/\s*|\s+)[+-]\s*\d+(?:\s*lines?)?)*\s*$", "i");
regex!(DELTA_PART, r"([+-])\s*(\d+)", "");
regex!(UPDATE_SUMMARY, r"^(Updated|Created|Deleted|Checked)\s+(.+?)(?:\s+·\s+|$)", "i");
regex!(FILE_COUNT, r"^(\d+)\s+Files?$", "i");
regex!(OK_LINE, r"^\s*OK\s+(modify|add|delete|create)\s+(.+?)\s*$", "i");
regex!(EDITED_LINE, r"^\s*(Edited|Created|Updated|Wrote):\s+(.+?)(?:\s+\(([^)]+)\))?\s*$", "i");
regex!(
    ERRORISH,
    r"\b(error|failed|failure|denied|refused|timed?\s*out|timeout|not\s+found|missing|invalid|cannot|can't|exception|exit\s+(?:code\s+)?[1-9])\b",
    "i"
);
regex!(ERROR_LEAD, r"^error\s*:\s*", "i");
regex!(BLOCK_LEAD, r"^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)", "");
regex!(BOLD_STAR, r"\*\*([^*]+)\*\*", "");
regex!(BOLD_UNDERSCORE, r"__([^_]+)__", "");
regex!(ITALIC_STAR, r"(?<!\*)\*(?!\*)([^*]+)\*(?!\*)", "");
regex!(CODE_SPAN, r"`([^`]+)`", "");
regex!(GREP_COUNT_ROW, r"(?:^|:)(\d+)$", "");
regex!(GREP_SKIP_ROW, r"^(?:#|--$)", "");
regex!(GREP_CONTEXT_ROW, r"^(?:\d+|[^\s:]+?-\d+)-", "");
regex!(IMAGE_HEAD, r"^\[image:", "i");
regex!(ADDITIONS, r"(\d+)\s+addition", "i");
regex!(REMOVALS, r"(\d+)\s+removal", "i");
regex!(DIFF_HEADER, r"^\+\+\+|^---", "");
regex!(SHELL_JOB, r"^\[(?:task_id|job):\s*([^\]]+)\]", "im");
regex!(SHELL_STATUS, r"^\[status:\s*([^\]]+)\]", "im");
regex!(SHELL_EXIT, r"^\[exit(?:\s+code)?:\s*([^\]]+)\]", "im");
regex!(BACKGROUND_HEAD, r"^background task$", "i");
regex!(BLANK_LINE_SPLIT, r"\r?\n\s*\r?\n", "");
regex!(STREAM_LABEL, r"^\[(?:stdout|stderr)(?: preview)?\]$", "");
regex!(GIT_HEADER_LINE, r"^## .*git(?:\.exe)?(?:\s|$)", "i");
regex!(CODE_GRAPH_COUNT, r"(\d+)\s+(references|definitions|symbols|callers|callees|results|matches)", "i");
regex!(HTTP_STATUS, r"(?:HTTP[\s/]*\d?\.?\d?\s*|status[:\s]+)([1-5]\d{2})\b", "i");
regex!(STATUS_REASON, r"\b([1-5]\d{2})\s+(?:OK|Not\s+Found|Forbidden|Moved|Found|Created|No\s+Content|Bad\s+Request|Unauthorized|Internal)", "");
regex!(BYTE_SIZE, r"\b(\d+(?:\.\d+)?\s?(?:[KMGT]?B|bytes))\b", "i");
regex!(RESULT_COUNT, r"(\d+)\s+results?", "i");
regex!(MEMORY_ID_LINE, r"#\d+\s*$", "");
regex!(SKILL_COUNT, r"(\d+)\s+skills?", "i");
regex!(NO_AGENTS, r"^\(no agents or tasks\)$", "im");
regex!(AGENTS_COUNT, r"^agents:\s*(\d+)", "im");
regex!(TASKS_COUNT, r"^tasks:\s*(\d+)", "im");
regex!(BARE_CANCELLED, r"^(?:cancelled|canceled)[.!]?$", "i");
regex!(BACKGROUND_TASKS, r"^background tasks:\s*(\d+)\s*$", "im");
regex!(JOB_RUNNING, r"^Job still running;\s*\d+ new lines?\.?$", "i");
regex!(SHELL_TASK_SUMMARY, r"^Shell task (was cancelled|[a-z_]+)(?:: (.*?))? \(exit ([^)]+)\)(?:: ([\s\S]*))?$", "");
regex!(USER_REPLIED, r#"^User replied in chat: ("(?:[^"\\]|\\.)*")\. "#, "s");
regex!(USER_ANSWERED, r"^User has answered your questions:\s*(.*?)(?:\s*You can now continue with these answers in mind\.)?$", "s");

// ── Counts and statuses ─────────────────────────────────────────────────────

/// The catalog key of a count noun (`{{count}} lines`), by the lower-cased plural.
fn count_key(plural: &str) -> Option<String> {
    let lower = js_to_lowercase(plural);
    COUNT_NOUNS.contains(&lower.as_str()).then(|| format!("{{{{count}}}} {lower}"))
}

fn plural_of(singular: &str) -> String {
    format!("{singular}s")
}

fn count_params(count: f64) -> Value {
    let mut map = Map::new();
    map.insert("count".to_owned(), json_number(count));
    Value::Object(map)
}

/// `countLabel`: `N noun(s)`, through the catalog when the noun has a key.
fn count_label(translate: Translate<'_>, n: f64, singular: &str, plural: &str) -> String {
    let noun = if n == 1.0 { singular } else { plural };
    let original = format!("{} {noun}", number_to_string(n));
    match count_key(plural) {
        Some(key) => translate(&key, &original, &count_params(n)),
        None => original,
    }
}

/// `countLabel(translate, n, singular)`: the plural is the singular with an `s`.
fn count_label_s(translate: Translate<'_>, n: f64, singular: &str) -> String {
    count_label(translate, n, singular, &plural_of(singular))
}

fn code_params(code: &str) -> Value {
    let mut map = Map::new();
    map.insert("code".to_owned(), Value::from(code));
    Value::Object(map)
}

fn exit_label(translate: Translate<'_>, code: &str) -> String {
    translate("Exit {{code}}", &format!("Exit {code}"), &code_params(code))
}

fn no_output(translate: Translate<'_>) -> String {
    translate("No output", "(No Output)", &Value::Null)
}

/// `localizeStatus`: one status vocabulary for every result, in the active language.
fn localize_status(raw: &str, translate: Translate<'_>) -> String {
    let lowered = js_to_lowercase(js_trim(raw));
    let mut word = String::with_capacity(lowered.len());
    let mut in_run = false;
    for c in lowered.chars() {
        if is_js_space(c) || c == '-' {
            if !in_run {
                word.push('_');
                in_run = true;
            }
        } else {
            word.push(c);
            in_run = false;
        }
    }
    let key = match word.as_str() {
        "completed" | "complete" | "done" | "success" | "succeeded" => "Completed",
        // Node's `/^(?:failed?|error|killed)$/`: "faile" or "failed", never "fail".
        "failed" | "faile" | "error" | "killed" => "Failed",
        "cancelled" | "canceled" | "cancel" => "Cancelled",
        "timeout" | "timed_out" => "Timed out",
        "queued" => "Queued",
        "running" => "Running",
        "pending" => "Pending",
        "finished" => "Finished",
        _ => return title_status(raw),
    };
    translate(key, key, &Value::Object(Map::new()))
}

fn count_non_empty_lines(text: &str) -> usize {
    text.split('\n').filter(|line| !js_trim(line).is_empty()).count()
}

/// `looksLikeZeroResultText`: result text that SAYS "nothing found" summarises as an explicit zero, not as one match. Only a
/// short single-line payload is trusted: a real listing that merely contains the words stays a listing.
fn looks_like_zero_result_text(text: &str) -> bool {
    let trimmed = js_trim(text);
    if trimmed.is_empty() || utf16_len(trimmed) > 200 || trimmed.contains('\n') {
        return false;
    }
    ZERO_COUNT.is_match(trimmed) || ZERO_EMPTY.is_match(trimmed) || ZERO_NO_FOUND.is_match(trimmed)
}

// ── Line deltas and update summaries ────────────────────────────────────────

/// `{ added, removed, seen }` of a line delta.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LineDelta {
    pub added: f64,
    pub removed: f64,
    pub seen: bool,
}

/// `splitPathAndDelta`: a path with its ` — delta` tail split off.
fn split_path_and_delta(value: &str, explicit_delta: &str) -> (String, String) {
    let mut path = js_trim(value).to_owned();
    let mut delta = js_trim(explicit_delta).to_owned();
    if delta.is_empty()
        && let Some(sep) = path.rfind(" — ")
    {
        delta = js_trim(&path[sep + " — ".len()..]).to_owned();
        path = js_trim(&path[..sep]).to_owned();
    }
    (path, delta)
}

/// `parseLineDelta`: only whole delta fields contribute (scanning arbitrary signed numbers turns `report-20260920.md` into
/// deletions).
pub fn parse_line_delta(delta: &str) -> LineDelta {
    let mut totals = LineDelta::default();
    for part in delta.split(['·', ',', '(', ')', '\r', '\n']) {
        if !DELTA_FIELD.is_match(part) {
            continue;
        }
        for found in DELTA_PART.captures_iter(part) {
            let n = string_to_number(found.get(2).unwrap_or_default());
            let n = if n.is_nan() { 0.0 } else { n };
            totals.seen = true;
            if found.get(1) == Some("+") {
                totals.added += n;
            } else {
                totals.removed += n;
            }
        }
    }
    totals
}

/// `formatLineDelta`: `+N lines · -M lines`, or nothing when no line changed.
pub fn format_line_delta(totals: &LineDelta) -> String {
    if !totals.seen {
        return String::new();
    }
    let (added, removed) = (if totals.added.is_nan() { 0.0 } else { totals.added }, if totals.removed.is_nan() { 0.0 } else { totals.removed });
    if added == 0.0 && removed == 0.0 {
        return String::new();
    }
    let line = |count: f64| if count == 1.0 { "line" } else { "lines" };
    let mut parts: Vec<String> = Vec::new();
    if added > 0.0 {
        parts.push(format!("+{} {}", number_to_string(added), line(added)));
    }
    if removed > 0.0 {
        parts.push(format!("-{} {}", number_to_string(removed), line(removed)));
    }
    parts.join(crate::tool_primitives::STATUS_SEPARATOR)
}

/// What `parseUpdateSummary` reads out of an `Updated foo.rs · +3 -1` line.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateSummary {
    pub action: String,
    pub file: String,
    pub file_count: f64,
    pub added: f64,
    pub removed: f64,
    pub seen: bool,
}

/// `parseUpdateSummary`.
pub fn parse_update_summary(text: &str) -> Option<UpdateSummary> {
    let found = UPDATE_SUMMARY.captures(js_trim(text))?;
    let action = title_word(found.get(1)?);
    let target = js_trim(found.get(2)?);
    let file_count = FILE_COUNT.captures(target).and_then(|counted| counted.get(1)).map(string_to_number);
    let totals = parse_line_delta(text);
    Some(UpdateSummary {
        action,
        file: if file_count.is_some() { String::new() } else { target.to_owned() },
        file_count: file_count.map_or(0.0, |count| if count.is_nan() { 0.0 } else { count }),
        added: totals.added,
        removed: totals.removed,
        seen: totals.seen,
    })
}

/// A listing rather than prose: a few long sentences are prose, many shorter rows a listing.
fn looks_line_oriented(text: &str) -> bool {
    let lines: Vec<&str> = text.split('\n').filter(|line| !js_trim(line).is_empty()).collect();
    !lines.is_empty() && lines.iter().all(|line| utf16_len(js_trim(line)) <= 200)
}

struct Changed {
    action: String,
    path: String,
    delta: String,
}

/// `summarizeUpdateResult`: a patch's one-line outcome. A dry run validates without writing, so it is never worded as a real
/// mutation.
fn summarize_update_result(text: &str, args: &Value) -> Option<String> {
    let parsed_args = parse_tool_args(args);
    let is_dry_run = field(&parsed_args, "dry_run") == Some(&Value::Bool(true));
    let mut changed: Vec<Changed> = Vec::new();
    for line in text.split('\n') {
        if let Some(ok) = OK_LINE.captures(line) {
            let (path, delta) = split_path_and_delta(ok.get(2).unwrap_or_default(), "");
            changed.push(Changed { action: js_to_lowercase(ok.get(1).unwrap_or_default()), path, delta });
            continue;
        }
        if let Some(edited) = EDITED_LINE.captures(line) {
            let (path, delta) = split_path_and_delta(edited.get(2).unwrap_or_default(), edited.get(3).unwrap_or_default());
            changed.push(Changed { action: js_to_lowercase(edited.get(1).unwrap_or_default()), path, delta });
        }
    }
    match changed.len() {
        0 => {
            let target = coalesce(&parsed_args, &["path", "file", "file_path"]);
            truthy(target).then(|| format!("{} {}", if is_dry_run { "Checked" } else { "Updated" }, display_path_of(target)))
        }
        1 => {
            let item = &changed[0];
            let action = if is_dry_run {
                "Checked"
            } else if item.action == "delete" {
                "Deleted"
            } else if matches!(item.action.as_str(), "add" | "create" | "created") {
                "Created"
            } else {
                "Updated"
            };
            Some(compact_parts(&[format!("{action} {}", display_tool_path(&item.path)), format_line_delta(&parse_line_delta(&item.delta))]))
        }
        many => {
            let mut totals = LineDelta::default();
            for item in &changed {
                let delta = parse_line_delta(&item.delta);
                totals.added += delta.added;
                totals.removed += delta.removed;
                totals.seen = totals.seen || delta.seen;
            }
            Some(compact_parts(&[format!("{} {many} Files", if is_dry_run { "Checked" } else { "Updated" }), format_line_delta(&totals)]))
        }
    }
}

// ── Text pulled out of envelopes ────────────────────────────────────────────

/// A tag name as regular-expression text.
fn escape_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '^' | '$' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `textBetweenTag`: the trimmed text between `<tag ...>` and `</tag>`, or empty.
pub fn text_between_tag(text: &str, tag: &str) -> String {
    let tag = escape_regex(tag);
    let Ok(pattern) = JsRegex::new(&format!(r"<{tag}[^>]*>([\s\S]*?)<\/{tag}>"), "i") else { return String::new() };
    pattern.captures(text).and_then(|found| found.get(1)).map(|body| js_trim(body).to_owned()).unwrap_or_default()
}

/// `stripInlineMarkdown`: the common inline-markdown markers dropped so a one-line summary reads as prose.
fn strip_inline_markdown(value: &str) -> String {
    let head_cut = BLOCK_LEAD.find(value).map_or(value, |range| &value[range.end..]);
    let step = |pattern: &JsRegex, text: String| pattern.replace_all_with(&text, |found| found.get(1).unwrap_or_default().to_owned());
    let text = step(&BOLD_STAR, head_cut.to_owned());
    let text = step(&BOLD_UNDERSCORE, text);
    let text = step(&ITALIC_STAR, text);
    let text = step(&CODE_SPAN, text);
    js_trim(&text).to_owned()
}

/// The first line of a result that is not an envelope field, header, tag or bracketed control field.
fn first_agent_result_line(text: &str) -> String {
    if let Some(notification) = parse_task_notification(text) {
        return first_agent_result_line(&notification.result);
    }
    let answer = text_between_tag(text, "final-answer");
    let answer = if answer.is_empty() { text_between_tag(text, "result") } else { answer };
    let raw = if answer.is_empty() { text } else { answer.as_str() };
    for line in raw.split('\n') {
        let trimmed = js_trim(line);
        if trimmed.is_empty() || HEADER_LINE.is_match(trimmed) || ENVELOPE_TAG_LINE.is_match(trimmed) {
            continue;
        }
        if FIELD_LINE.is_match(trimmed) || BRACKETED_FIELD_LINE.is_match(trimmed) {
            continue;
        }
        return truncate_single_line(trimmed, AGENT_SURFACE_BRIEF_MAX);
    }
    String::new()
}

fn is_envelope_line(line: &str) -> bool {
    HEADER_LINE.is_match(line) || FIELD_LINE.is_match(line) || BRACKETED_FIELD_LINE.is_match(line)
}

/// `summarizeGenericResult`.
fn summarize_generic_result(text: &str, translate: Translate<'_>) -> Option<String> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() || NULLISH.is_match(trimmed) {
        return None;
    }
    if JSON_OPEN.is_match(trimmed) {
        let parsed = json_parse(trimmed).ok()?;
        if let Value::Array(items) = &parsed {
            return Some(count_label_s(translate, items.len() as f64, "item"));
        }
        if parsed.is_object() {
            if truthy(field(&parsed, "cwd")) {
                return Some(truncate_single_line(&text_of(field(&parsed, "cwd")), AGENT_SURFACE_BRIEF_MAX));
            }
            if let Some(Value::Bool(ok)) = field(&parsed, "ok") {
                return Some(if *ok { "Ok".to_owned() } else { translate("Failed", "Failed", &Value::Null) });
            }
            for key in ["items", "results", "resources", "templates", "providers", "schedules", "channels", "tools"] {
                if let Some(Value::Array(items)) = field(&parsed, key) {
                    let singular = &key[..key.len() - 1];
                    return Some(count_label_s(translate, items.len() as f64, &js_to_lowercase(singular)));
                }
            }
            // A status/state object is a transport envelope, not a successful result body: the card's terminal-status
            // rendering shows it.
            if !first_text(&[field(&parsed, "status"), field(&parsed, "state")]).is_empty() {
                return None;
            }
            let message = first_text(&[field(&parsed, "result"), field(&parsed, "message")]);
            if !message.is_empty() {
                return Some(truncate_single_line(&message, AGENT_SURFACE_BRIEF_MAX));
            }
        }
    }
    let mut line = first_agent_result_line(text);
    if line.is_empty() {
        line = trimmed.split('\n').map(js_trim).find(|item| !item.is_empty() && !is_envelope_line(item)).unwrap_or_default().to_owned();
    }
    if line.is_empty() || line == "{" || line == "[" {
        return None;
    }
    if STATUS_WORD.is_match(&line) {
        return Some(title_status(&line));
    }
    Some(truncate_single_line(&line, AGENT_SURFACE_BRIEF_MAX))
}

/// `extractErrorCause`: when a result is an error, the actual cause line instead of a bare "Failed" or a raw first line:
/// the error-ish key of a JSON envelope, else the first line that carries error signal, else the first line.
pub fn extract_error_cause(result_text: &str) -> String {
    let text = js_trim(result_text);
    if text.is_empty() {
        return String::new();
    }
    if (text.starts_with('{') || text.starts_with('['))
        && let Ok(parsed) = json_parse(text)
    {
        let object = match &parsed {
            Value::Array(items) => items.first(),
            other => Some(other),
        };
        if let Some(object) = object.filter(|value| value.is_object() || value.is_array()) {
            let error = field(object, "error");
            let error_text = match error {
                Some(Value::String(_)) => error,
                other => other.and_then(|value| field(value, "message")),
            };
            let cause = first_text(&[
                error_text,
                field(object, "message"),
                field(object, "cause"),
                field(object, "detail"),
                field(object, "reason"),
                field(object, "status"),
            ]);
            if !cause.is_empty() {
                return truncate_single_line(&cause, AGENT_SURFACE_BRIEF_MAX);
            }
        }
    }
    let lines: Vec<&str> = text.split('\n').map(js_trim).filter(|line| !line.is_empty()).collect();
    let picked = lines.iter().find(|line| ERRORISH.is_match(line)).or(lines.first()).copied().unwrap_or_default();
    let stripped = strip_inline_markdown(picked);
    let without_lead = ERROR_LEAD.find(&stripped).map_or(stripped.as_str(), |range| &stripped[range.end..]);
    truncate_single_line(without_lead, AGENT_SURFACE_BRIEF_MAX)
}

// ── Per-tool result summarisers ─────────────────────────────────────────────

/// What every summariser receives: the result text, its trim, the call's arguments, the normalised tool name and the catalog.
struct ResultInput<'a> {
    text: &'a str,
    trimmed: &'a str,
    args: &'a Value,
    normalized: &'a str,
    translate: Translate<'a>,
}

fn summarize_line_count(input: &ResultInput<'_>, singular: &str, plural: &str) -> Option<String> {
    if input.trimmed.is_empty() || !looks_line_oriented(input.text) {
        return None;
    }
    if looks_like_zero_result_text(input.text) {
        return Some(count_label(input.translate, 0.0, singular, plural));
    }
    let n = count_non_empty_lines(input.text);
    (n > 0).then(|| count_label(input.translate, n as f64, singular, plural))
}

/// grep's three result shapes: per-file counts (`path:N`), a bare file list, or match rows grouped under `# path` headers with
/// context rows around them.
fn summarize_grep_result(input: &ResultInput<'_>) -> Option<String> {
    let translate = input.translate;
    if input.trimmed.is_empty() || !looks_line_oriented(input.text) {
        return None;
    }
    if looks_like_zero_result_text(input.text) {
        return Some(count_label(translate, 0.0, "match", "matches"));
    }
    let parsed = parse_tool_args(input.args);
    let mode = js_to_lowercase(&text_of(coalesce(&parsed, &["output_mode", "mode"])));
    let rows: Vec<&str> = input.text.split('\n').map(js_trim).filter(|line| !line.is_empty() && !line.starts_with('[') && !line.starts_with('…')).collect();
    if mode == "count" {
        let (mut matches, mut files) = (0.0, 0.0);
        for row in &rows {
            let Some(count) = GREP_COUNT_ROW.captures(row).and_then(|found| found.get(1)) else { continue };
            matches += string_to_number(count);
            files += 1.0;
        }
        if files == 0.0 {
            return None;
        }
        return Some(format!("{} in {}", count_label(translate, matches, "match", "matches"), count_label_s(translate, files, "file")));
    }
    if mode == "files" || mode == "files_with_matches" {
        let files = rows.iter().filter(|row| !row.starts_with('#')).count();
        return Some(count_label_s(translate, files as f64, "file"));
    }
    let matches = rows.iter().filter(|row| !GREP_SKIP_ROW.is_match(row) && !GREP_CONTEXT_ROW.is_match(row)).count();
    (matches > 0).then(|| count_label(translate, matches as f64, "match", "matches"))
}

fn summarize_read_result(input: &ResultInput<'_>) -> Option<String> {
    if IMAGE_HEAD.is_match(input.trimmed) {
        return Some((input.translate)("Image", "Image", &Value::Null));
    }
    if input.trimmed.is_empty() {
        return None;
    }
    if input.trimmed.starts_with("(no lines in range") {
        return Some(count_label_s(input.translate, 0.0, "line"));
    }
    Some(count_label_s(input.translate, input.text.split('\n').count() as f64, "line"))
}

fn summarize_patch_result(input: &ResultInput<'_>) -> Option<String> {
    if let Some(update) = summarize_update_result(input.text, input.args) {
        return Some(update);
    }
    // Explicit additions/removals hints the result text states win over counting diff lines.
    let additions = ADDITIONS.captures(input.text).and_then(|found| found.get(1));
    let removals = REMOVALS.captures(input.text).and_then(|found| found.get(1));
    if additions.is_some() || removals.is_some() {
        let count = |group: Option<&str>| group.map_or(0.0, string_to_number);
        return Some(format!("+{} -{}", number_to_string(count(additions)), number_to_string(count(removals))));
    }
    // Else the +/- lines of a unified diff (the +++/--- file headers ignored).
    let (mut added, mut removed) = (0usize, 0usize);
    for line in input.text.split('\n') {
        if DIFF_HEADER.is_match(line) {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added > 0 || removed > 0).then(|| format!("+{added} -{removed}"))
}

/// `text.split(regex)` for a pattern without groups.
fn split_by(pattern: &JsRegex, text: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut last = 0;
    for range in pattern.find_iter(text) {
        pieces.push(text[last..range.start].to_owned());
        last = range.end;
    }
    pieces.push(text[last..].to_owned());
    pieces
}

fn summarize_shell_result(input: &ResultInput<'_>) -> Option<String> {
    let translate = input.translate;
    if input.trimmed.is_empty() {
        return Some(no_output(translate));
    }
    let job = SHELL_JOB.captures(input.text).and_then(|found| found.get(1));
    let status = SHELL_STATUS.captures(input.text).and_then(|found| found.get(1));
    let exit = SHELL_EXIT.captures(input.text).and_then(|found| found.get(1));
    if job.is_some() || status.is_some() || exit.is_some() {
        let status_text = status.map(|raw| localize_status(raw, translate)).unwrap_or_default();
        return Some(compact_parts(&[job.unwrap_or_default().to_owned(), status_text, exit.map(|code| exit_label(translate, code)).unwrap_or_default()]));
    }
    let lines: Vec<&str> = input.trimmed.split('\n').map(js_trim).filter(|line| !line.is_empty()).collect();
    // A background-task block opens with envelope fields; they are not output.
    if lines.first().is_some_and(|first| BACKGROUND_HEAD.is_match(first)) {
        // The header block ends at the first blank line; what follows is output.
        let pieces = split_by(&BLANK_LINE_SPLIT, input.trimmed);
        let after = pieces.get(1..).unwrap_or_default().join("\n");
        // `[stdout]` / `[stderr]` label a stream; they are never the outcome.
        let output = after.split('\n').map(js_trim).find(|line| !line.is_empty() && !STREAM_LABEL.is_match(line));
        return output.map(|line| truncate_single_line(line, AGENT_SURFACE_BRIEF_MAX));
    }
    Some(truncate_single_line(lines[0], AGENT_SURFACE_BRIEF_MAX))
}

fn summarize_git_result(input: &ResultInput<'_>) -> Option<String> {
    let translate = input.translate;
    if let Some(exit) = git_result_exit_code(input.text) {
        return Some(exit_label(translate, &number_to_string(exit)));
    }
    let error = git_result_error(input.text);
    if !error.is_empty() {
        return Some(truncate_single_line(&error, AGENT_SURFACE_BRIEF_MAX));
    }
    if input.trimmed.is_empty() {
        return Some(no_output(translate));
    }
    // Old transcript rows may still contain the previous result envelope.
    if input.trimmed.starts_with('{')
        && let Ok(stored) = json_parse(input.trimmed)
        && matches!(field(&stored, "ok"), Some(Value::Bool(_)))
    {
        return summarize_generic_result(input.text, translate);
    }
    let first = input.text.split('\n').find(|line| !js_trim(line).is_empty() && !GIT_HEADER_LINE.is_match(line));
    Some(first.map_or_else(|| no_output(translate), |line| truncate_single_line(line, AGENT_SURFACE_BRIEF_MAX)))
}

fn summarize_code_graph_result(input: &ResultInput<'_>) -> Option<String> {
    if let Some(found) = CODE_GRAPH_COUNT.captures(input.text) {
        let (number, noun) = (found.get(1).unwrap_or_default(), js_to_lowercase(found.get(2).unwrap_or_default()));
        let key = count_key(&noun).unwrap_or_default();
        return Some((input.translate)(&key, &format!("{number} {noun}"), &count_params(string_to_number(number))));
    }
    looks_like_zero_result_text(input.text).then(|| (input.translate)("No results", "No results", &Value::Null))
}

fn summarize_fetch_result(input: &ResultInput<'_>) -> Option<String> {
    // A status needs a status-like context (`HTTP NNN`, `Status: NNN`, `NNN OK`), not any bare 3-digit number.
    let status = HTTP_STATUS.captures(input.text).and_then(|found| found.get(1)).or_else(|| STATUS_REASON.captures(input.text).and_then(|found| found.get(1)));
    let size = BYTE_SIZE.captures(input.text).and_then(|found| found.get(1));
    match (size, status) {
        (Some(size), Some(status)) => Some(format!("{size} · HTTP {status}")),
        (Some(size), None) => Some(size.to_owned()),
        (None, Some(status)) => Some(format!("HTTP {status}")),
        (None, None) => None,
    }
}

fn summarize_search_result(input: &ResultInput<'_>) -> Option<String> {
    if let Some(found) = RESULT_COUNT.captures(input.text).and_then(|found| found.get(1)) {
        return Some(count_label_s(input.translate, string_to_number(found), "result"));
    }
    answer_line_of(input)
}

/// The text's answer line when it has a body, else nothing.
fn answer_line_of(input: &ResultInput<'_>) -> Option<String> {
    if input.trimmed.is_empty() {
        return None;
    }
    Some(first_agent_result_line(input.text)).filter(|line| !line.is_empty())
}

fn summarize_memory_result(input: &ResultInput<'_>) -> Option<String> {
    if input.trimmed.is_empty() || input.trimmed == "(no results)" || looks_like_zero_result_text(input.text) {
        return Some((input.translate)("No results", "No Results", &Value::Null));
    }
    let n = input.text.split('\n').filter(|line| MEMORY_ID_LINE.is_match(line)).count();
    if n > 0 {
        return Some(count_label(input.translate, n as f64, "Memory", "Memories"));
    }
    summarize_generic_result(input.text, input.translate)
}

fn summarize_skill_result(input: &ResultInput<'_>) -> Option<String> {
    let parsed = parse_tool_args(input.args);
    let target = first_text(&[field(&parsed, "name"), field(&parsed, "skill"), field(&parsed, "skill_name")]);
    if input.normalized == "skills_list" {
        if let Some(count) = SKILL_COUNT.captures(input.text).and_then(|found| found.get(1)) {
            let n = string_to_number(count);
            return Some(count_label_s(input.translate, if n.is_nan() { 0.0 } else { n }, "skill"));
        }
        let lines = count_non_empty_lines(input.text);
        return (lines > 0).then(|| count_label_s(input.translate, lines as f64, "skill"));
    }
    if !target.is_empty() {
        let verb = if matches!(input.normalized, "skill" | "skill_view") { "Loaded" } else { "Used" };
        let name = truncate_tool_text(&target, 80);
        let mut params = Map::new();
        params.insert("name".to_owned(), Value::from(name.clone()));
        return Some((input.translate)(&format!("{verb} {{{{name}}}}"), &format!("{verb} {name}"), &Value::Object(params)));
    }
    answer_line_of(input)
}

/// Status-check (list/status) envelopes start with `agents: N` / `tasks: M` (or `(no agents or tasks)`) and collapse to a
/// tight count summary instead of leaking the raw worker dump into the card.
fn summarize_agent_counts(text: &str, translate: Translate<'_>) -> Option<String> {
    let none = || translate("No agents or tasks", "No agents or tasks", &Value::Null);
    if NO_AGENTS.is_match(text) {
        return Some(none());
    }
    let agents = AGENTS_COUNT.captures(text).and_then(|found| found.get(1));
    let tasks = TASKS_COUNT.captures(text).and_then(|found| found.get(1));
    if agents.is_none() && tasks.is_none() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(agents) = agents {
        parts.push(count_label_s(translate, string_to_number(agents), "agent"));
    }
    if let Some(tasks) = tasks
        && string_to_number(tasks) > 0.0
    {
        parts.push(count_label_s(translate, string_to_number(tasks), "task"));
    }
    let joined = compact_parts(&parts);
    Some(if joined.is_empty() { none() } else { joined })
}

/// `localizeShellSummary`: `Shell task completed (exit 0): npm test`: the status word and the exit are UI, the command after
/// the colon is the user's own text.
fn localize_shell_summary(summary: &str, translate: Translate<'_>) -> String {
    let Some(found) = SHELL_TASK_SUMMARY.captures(summary) else { return summary.to_owned() };
    let word = found.get(1).unwrap_or_default();
    let (error, code, command) = (found.get(2), found.get(3).unwrap_or_default(), found.get(4));
    let status = localize_status(if word == "was cancelled" { "cancelled" } else { word }, translate);
    let mut params = Map::new();
    params.insert("status".to_owned(), Value::from(status));
    params.insert("code".to_owned(), Value::from(code));
    let head = translate("Shell task {{status}} (exit {{code}})", &format!("Shell task {word} (exit {code})"), &Value::Object(params));
    let with_error = match error {
        Some(error) if !error.is_empty() => format!("{head}: {error}"),
        _ => head,
    };
    match command {
        Some(command) if !command.is_empty() => format!("{with_error}: {command}"),
        _ => with_error,
    }
}

fn summarize_agent_result(input: &ResultInput<'_>) -> Option<String> {
    let translate = input.translate;
    if let Some(counts) = summarize_agent_counts(input.text, translate) {
        return Some(counts);
    }
    // A cancel call answers with the one word; a task list opens with its total; a read of a live job says it has no new
    // lines yet.
    if BARE_CANCELLED.is_match(input.trimmed) {
        return Some(translate("Cancelled", input.trimmed, &Value::Object(Map::new())));
    }
    if let Some(total) = BACKGROUND_TASKS.captures(input.trimmed).and_then(|found| found.get(1))
        && input.trimmed.starts_with("background tasks:")
    {
        return Some(translate("Background tasks: {{count}}", &format!("background tasks: {total}"), &count_params(string_to_number(total))));
    }
    if JOB_RUNNING.is_match(input.trimmed) {
        return Some(translate("Running", "Running", &Value::Object(Map::new())));
    }
    // An agent or task result card shows only a one-liner; the full report is behind the expand key.
    Some(first_agent_result_line(input.text))
        .filter(|line| !line.is_empty())
        .map(|line| truncate_single_line(&strip_inline_markdown(&line), AGENT_SURFACE_BRIEF_MAX))
}

fn summarize_ask_user_result(input: &ResultInput<'_>) -> Option<String> {
    let text = js_trim(input.text);
    // A composer message answered: `User replied in chat: "<json>". ` then the picks sentence or only the closing one;
    // summarised as the reply itself.
    if let Some(quoted) = USER_REPLIED.captures(text).and_then(|found| found.get(1)) {
        let reply = match json_parse(quoted) {
            Ok(Value::String(reply)) => reply,
            Ok(other) => value_to_string(&other),
            Err(_) => String::new(),
        };
        let label = (input.translate)("Answered in chat", "Answered in chat", &Value::Object(Map::new()));
        return Some(truncate_single_line(&if reply.is_empty() { label } else { format!("{label}: {reply}") }, AGENT_SURFACE_BRIEF_MAX));
    }
    let answers = USER_ANSWERED.captures(text).and_then(|found| found.get(1));
    Some(truncate_single_line(answers.unwrap_or(text), AGENT_SURFACE_BRIEF_MAX)).filter(|line| !line.is_empty())
}

fn summarize_media_result(input: &ResultInput<'_>) -> Option<String> {
    media_result_summary(&parse_tool_args(input.args), input.text)
}

fn summarize_glob_result(input: &ResultInput<'_>) -> Option<String> {
    summarize_line_count(input, "file", "files")
}

fn summarize_find_result(input: &ResultInput<'_>) -> Option<String> {
    summarize_line_count(input, "candidate", "candidates")
}

fn summarize_list_result(input: &ResultInput<'_>) -> Option<String> {
    summarize_line_count(input, "entry", "entries")
}

fn summarize_generic_input(input: &ResultInput<'_>) -> Option<String> {
    summarize_generic_result(input.text, input.translate)
}

/// The summariser of a normalised tool name.
fn summarizer_for(normalized: &str) -> Option<fn(&ResultInput<'_>) -> Option<String>> {
    Some(match normalized {
        "ask_user" | "handoff_user" => summarize_ask_user_result,
        "read" | "view_image" | "read_mcp_resource" => summarize_read_result,
        "apply_patch" => summarize_patch_result,
        "grep" => summarize_grep_result,
        "media" => summarize_media_result,
        "glob" => summarize_glob_result,
        "find" => summarize_find_result,
        "list" | "ls" => summarize_list_result,
        "shell" | "bash" | "bash_session" | "shell_command" | "job_wait" => summarize_shell_result,
        "git" => summarize_git_result,
        "code_graph" => summarize_code_graph_result,
        "web_fetch" | "fetch" => summarize_fetch_result,
        "search_query" | "image_query" | "web_search" | "web_search_call" => summarize_search_result,
        "recall" | "search_memories" | "memory" => summarize_memory_result,
        "remember"
        | "save_memory"
        | "update_memory"
        | "request_user_input"
        | "update_plan"
        | "cwd"
        | "session"
        | "list_mcp_resources"
        | "list_mcp_resource_templates" => summarize_generic_input,
        "skill" | "skill_execute" | "skill_view" | "skills_list" | "use_skill" => summarize_skill_result,
        "agent" | "task" => summarize_agent_result,
        _ => return None,
    })
}

/// `summarizeToolResult` without a catalog.
pub fn summarize_tool_result(name: &str, args: &Value, result_text: &str, is_error: bool) -> Option<String> {
    summarize_tool_result_translated(name, args, result_text, is_error, &keep_original)
}

/// `summarizeToolResult`: a short semantic one-liner for a completed call, from the tool name, the parsed arguments and the
/// raw result text alone; `None` when nothing reliable can be derived, so the caller falls back to the raw result block.
pub fn summarize_tool_result_translated(name: &str, args: &Value, result_text: &str, is_error: bool, translate: Translate<'_>) -> Option<String> {
    if let Some(notification) = parse_task_notification(result_text) {
        if notification.surface == "shell" && !(is_error && !notification.error.is_empty()) {
            return Some(localize_shell_summary(&notification.summary, translate));
        }
        if is_error {
            return Some(if notification.error.is_empty() { notification.summary } else { notification.error });
        }
        return summarize_tool_result_translated(name, args, &notification.result, false, translate);
    }
    if is_error {
        // An error surfaces the extracted cause, so the collapsed card answers "why" without expanding.
        return Some(extract_error_cause(result_text)).filter(|cause| !cause.is_empty());
    }
    let trimmed = js_trim(result_text);
    if NULLISH.is_match(trimmed) {
        return None;
    }
    if is_mcp_tool_name(name) {
        return if trimmed.is_empty() { None } else { Some(first_agent_result_line(result_text)).filter(|line| !line.is_empty()) };
    }
    let normalized = normalize_tool_name(name);
    let summarize = summarizer_for(&normalized)?;
    summarize(&ResultInput { text: result_text, trimmed, args, normalized: &normalized, translate })
}

/// `truncateAgentSurfaceBrief`: whitespace collapsed, cut to `max` with an ellipsis.
fn truncate_agent_surface_brief(value: &str, max: usize) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if is_js_space(c) {
            if !in_run {
                collapsed.push(' ');
                in_run = true;
            }
        } else {
            collapsed.push(c);
            in_run = false;
        }
    }
    let text = js_trim(&collapsed);
    if text.is_empty() || utf16_len(text) <= max {
        return text.to_owned();
    }
    format!("{}\u{2026}", slice_utf16(text, max.saturating_sub(1).max(1)))
}

/// `summarizeAgentSurfaceBrief`'s options.
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentBriefOptions {
    pub is_error: bool,
    pub is_response: bool,
}

/// `summarizeAgentSurfaceBrief`: a tight one-liner for an agent or task card: the inbound prompt or message for a spawn or
/// send, or the stripped first line of the result when a response landed.
pub fn summarize_agent_surface_brief(name: &str, args: &Value, result_text: &str, options: AgentBriefOptions) -> String {
    let brief = |value: &str| truncate_agent_surface_brief(value, AGENT_SURFACE_BRIEF_MAX);
    let parsed = parse_tool_args(args);
    let action = js_to_lowercase(&picked_text(&parsed, &["type", "action"]));
    let text = js_trim(result_text);
    // A failed call shows why it failed, not the prompt it was handed.
    if options.is_error && !text.is_empty() {
        let cause = extract_error_cause(text);
        if !cause.is_empty() {
            return brief(&cause);
        }
    }
    if options.is_response && !text.is_empty() {
        if let Some(from_result) = summarize_tool_result(name, args, text, options.is_error) {
            return brief(&strip_inline_markdown(&from_result));
        }
        let line = first_agent_result_line(text);
        if !line.is_empty() {
            return brief(&strip_inline_markdown(&line));
        }
    }
    let outbound = first_text(&[field(&parsed, "prompt"), field(&parsed, "message")]);
    if !outbound.is_empty() && (action == "spawn" || action == "send" || action.is_empty()) {
        return brief(&outbound);
    }
    if (action == "spawn" || action == "send")
        && !text.is_empty()
        && !options.is_response
        && let Some(from_result) = summarize_tool_result(name, args, text, options.is_error)
    {
        return brief(&strip_inline_markdown(&from_result));
    }
    String::new()
}

/// `isMemorySurface`.
pub fn is_memory_surface(label: &str) -> bool {
    label == "Memory"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn summary(name: &str, args: Value, text: &str) -> Option<String> {
        summarize_tool_result(name, &args, text, false)
    }

    #[test]
    fn read_and_listing_counts() {
        assert_eq!(summary("read", json!({}), "a\nb\nc"), Some("3 lines".into()));
        assert_eq!(summary("read", json!({}), "[image: image/png]"), Some("Image".into()));
        assert_eq!(summary("read", json!({}), "(no lines in range; file has 3 lines)"), Some("0 lines".into()));
        assert_eq!(summary("glob", json!({}), "a.rs\nb.rs"), Some("2 files".into()));
        assert_eq!(summary("glob", json!({}), "(no files found)"), Some("0 files".into()));
        assert_eq!(summary("ls", json!({}), "only"), Some("1 entry".into()));
        assert_eq!(summary("find", json!({}), "x\ny"), Some("2 candidates".into()));
    }

    #[test]
    fn grep_shapes() {
        assert_eq!(summary("grep", json!({ "output_mode": "count" }), "a.rs:3\nb.rs:2"), Some("5 matches in 2 files".into()));
        assert_eq!(summary("grep", json!({ "mode": "files" }), "a.rs\nb.rs\n# skip"), Some("2 files".into()));
        assert_eq!(summary("grep", json!({}), "# a.rs\n3:x\n4-ctx\n5:y\n--"), Some("2 matches".into()));
        assert_eq!(summary("grep", json!({}), "(no matches)"), Some("0 matches".into()));
    }

    #[test]
    fn patch_and_shell() {
        assert_eq!(summary("apply_patch", json!({}), "OK modify src/a.rs — +3 -1"), Some("Updated a.rs · +3 lines · -1 line".into()));
        assert_eq!(summary("apply_patch", json!({ "dry_run": true }), "OK add b.txt\nOK delete c.txt"), Some("Checked 2 Files".into()));
        assert_eq!(summary("apply_patch", json!({}), "--- a\n+++ b\n+x\n+y\n-z"), Some("+2 -1".into()));
        assert_eq!(summary("shell", json!({}), ""), Some("(No Output)".into()));
        assert_eq!(summary("shell", json!({}), "[status: done]\n[exit code: 0]"), Some("Completed · Exit 0".into()));
        assert_eq!(summary("shell", json!({}), "hello\nworld"), Some("hello".into()));
        assert_eq!(summary("bash", json!({}), "background task\nstatus: running\n\n[stdout]\nthe output"), Some("the output".into()));
    }

    #[test]
    fn other_surfaces() {
        assert_eq!(summary("fetch", json!({}), "HTTP 200 OK\n12 KB"), Some("12 KB · HTTP 200".into()));
        assert_eq!(summary("web_search", json!({}), "7 results"), Some("7 results".into()));
        assert_eq!(summary("recall", json!({}), "x #1\ny #2"), Some("2 Memories".into()));
        assert_eq!(summary("recall", json!({}), "(no results)"), Some("No Results".into()));
        assert_eq!(summary("skill", json!({ "name": "browser" }), "x"), Some("Loaded browser".into()));
        assert_eq!(summary("task", json!({}), "agents: 2\ntasks: 1"), Some("2 agents · 1 task".into()));
        assert_eq!(summary("task", json!({}), "(no agents or tasks)"), Some("No agents or tasks".into()));
        assert_eq!(summary("code_graph", json!({}), "found 4 callers"), Some("4 callers".into()));
        assert_eq!(summary("git", json!({}), "## main\nexit 128\nfatal"), Some("Exit 128".into()));
        assert_eq!(summary("ask_user", json!({}), "User has answered your questions: A. You can now continue with these answers in mind."), Some("A.".into()));
        assert_eq!(summary("mystery", json!({}), "x"), None);
        assert_eq!(summary("session", json!({}), "{\"ok\":true}"), Some("Ok".into()));
        assert_eq!(summary("session", json!({}), "[1,2]"), Some("2 items".into()));
        assert_eq!(summary("session", json!({}), "null"), None);
    }

    #[test]
    fn errors_surface_their_cause() {
        assert_eq!(summarize_tool_result("read", &json!({}), "{\"error\":{\"message\":\"disk full\"}}", true), Some("disk full".into()));
        assert_eq!(summarize_tool_result("read", &json!({}), "Error: **bad** thing\nmore", true), Some("bad thing".into()));
        assert_eq!(summarize_tool_result("read", &json!({}), "ok\nthe call failed hard", true), Some("the call failed hard".into()));
        assert_eq!(summarize_tool_result("read", &json!({}), "", true), None);
    }

    #[test]
    fn a_notification_summarises_its_result() {
        let shell = "<task-notification>\n<task-id>1</task-id>\n<status>completed</status>\n<summary>Shell task completed (exit 0): npm test</summary>\n</task-notification>";
        assert_eq!(summary("task", json!({}), shell), Some("Shell task completed (exit 0): npm test".into()));
        let agent = "<task-notification>\n<task-id>1</task-id>\n<status>completed</status>\n<summary>Agent \"x\" completed</summary>\n<result>\nstatus: done\nThe answer is 42\n</result>\n</task-notification>";
        assert_eq!(summary("agent", json!({}), agent), Some("The answer is 42".into()));
    }

    #[test]
    fn the_catalog_is_asked_for_authored_text() {
        let translate = |key: &str, original: &str, _params: &Value| format!("<{key}|{original}>");
        let text = summarize_tool_result_translated("read", &json!({}), "a\nb", false, &translate);
        assert_eq!(text, Some("<{{count}} lines|2 lines>".into()));
        assert!(tool_result_ui_keys().contains(&"{{count}} lines".to_owned()));
        assert!(tool_result_ui_keys().contains(&"Timed out".to_owned()));
    }

    #[test]
    fn line_deltas() {
        let totals = parse_line_delta("report-20260920.md · +3 -1, +2 lines");
        assert_eq!((totals.added, totals.removed, totals.seen), (5.0, 1.0, true));
        assert_eq!(format_line_delta(&totals), "+5 lines · -1 line");
        assert_eq!(format_line_delta(&LineDelta::default()), "");
        let update = parse_update_summary("Created 3 Files · +9 -0").expect("update");
        assert_eq!((update.action.as_str(), update.file.as_str(), update.file_count, update.added), ("Created", "", 3.0, 9.0));
    }

    #[test]
    fn the_agent_brief() {
        let args = json!({ "action": "spawn", "prompt": "do   the thing" });
        assert_eq!(summarize_agent_surface_brief("agent", &args, "", AgentBriefOptions::default()), "do the thing");
        assert_eq!(summarize_agent_surface_brief("agent", &json!({}), "Error: boom", AgentBriefOptions { is_error: true, is_response: false }), "boom");
        assert_eq!(
            summarize_agent_surface_brief("agent", &json!({}), "status: done\n**All** good", AgentBriefOptions { is_error: false, is_response: true }),
            "All good"
        );
        assert!(is_memory_surface("Memory"));
    }
}
