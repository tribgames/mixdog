//! `prepareGrepArgs` (`tools/builtin/arg-guard.mjs`, `path-utils.mjs`): the private copy of a
//! grep request after the builtin guard and alias normalization. The result cache keys grep on
//! it, so two spellings of one search share an entry and an invalid request never hits one.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::number_to_string;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use mixdog_protocol::JsonValue;
use serde_json::Map;

type Args = Map<String, JsonValue>;

const MAX_INT: f64 = 100_000.0;
const PATH_BATCH_LIMIT: usize = 10;
const GREP_CONTEXT_MAX: f64 = 200.0;
const GREP_CTX_HEAD_LIMIT_MAX: f64 = 40.0;
const OUTPUT_MODES: [&str; 4] = ["files_with_matches", "content", "content_with_context", "count"];

const CONTEXT_KEY_GROUPS: [(&str, &[&str]); 3] = [
    (
        "-A",
        &["-A", "A", "after", "after_context", "afterContext", "--after-context", "after-context", "afterLines", "after_lines"],
    ),
    (
        "-B",
        &[
            "-B",
            "B",
            "before",
            "before_context",
            "beforeContext",
            "--before-context",
            "before-context",
            "beforeLines",
            "before_lines",
        ],
    ),
    ("context", &["context", "-C", "C", "context_lines", "contextLines", "--context", "contextN", "around", "surrounding"]),
];

const STRING_LIST_ARG_KEYS: [&str; 15] = [
    "path",
    "paths",
    "root",
    "file",
    "files",
    "pattern",
    "patterns",
    "query",
    "regex",
    "needle",
    "glob",
    "file_pattern",
    "include",
    "type",
    "symbols",
];

static RANGE_SHAPED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d+\s*[,\-:]\s*\d+$", ""));
static DRIVE_ROOT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[A-Za-z]:[\\/]", ""));
static DRIVE_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z]:[\\/]", ""));
static LIST_SPLIT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"[\s,;]+(?=["']?[A-Za-z]:[\\/])"#, ""));
static QUOTED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^(["'])(.*)\1$"#, ""));

/// A JS number as JSON: whole values are integers, as `JSON.stringify` prints them.
fn num(n: f64) -> JsonValue {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15 {
        JsonValue::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(JsonValue::Null, JsonValue::Number)
    }
}

fn describe_type(v: &JsonValue) -> &'static str {
    match v {
        JsonValue::Null => "null",
        JsonValue::Array(_) => "array",
        JsonValue::String(_) => "string",
        JsonValue::Number(_) => "number",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Object(_) => "object",
    }
}

fn is_present(a: &Args, k: &str) -> bool {
    a.get(k).is_some_and(|v| !v.is_null())
}

fn is_non_empty_present(a: &Args, k: &str) -> bool {
    is_present(a, k) && a[k].as_str() != Some("")
}

fn is_finite_int(v: &JsonValue) -> bool {
    v.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0)
}

/// `coerceIntegerString`: "850" and "850.0" are the integer; "3.5" and "soon" are not.
fn coerce_integer_string(text: &str) -> Option<f64> {
    let t = js_trim(text);
    let body = t.strip_prefix('-').unwrap_or(t);
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || frac.is_some_and(|f| !digits(f)) {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// `checkIntInRange`: coerces in place, then bounds the value. `clamp` fields saturate on both
/// sides; the others clamp only above and refuse a value below the minimum.
fn check_int_in_range(a: &mut Args, field: &str, min: f64, max: f64, clamp: bool) -> Option<String> {
    let mut value = a.get(field).filter(|v| !v.is_null())?.clone();
    if let JsonValue::String(text) = &value
        && let Some(n) = coerce_integer_string(text)
    {
        value = num(n);
        a.insert(field.to_owned(), value.clone());
    }
    if let JsonValue::String(text) = &value
        && RANGE_SHAPED.is_match(js_trim(text))
    {
        return Some(format!(
            "Error: \"{field}\" takes one integer, not a range \"{text}\" — use offset+limit (e.g. offset:0, limit:40)"
        ));
    }
    if clamp
        && let Some(n) = value.as_f64()
        && n.is_finite()
        && n.fract() != 0.0
    {
        value = num(n.floor());
        a.insert(field.to_owned(), value.clone());
    }
    if !is_finite_int(&value) {
        return Some(format!(
            "Error: \"{field}\" must be an integer (got {}) — e.g. {field}:40",
            describe_type(&value)
        ));
    }
    let n = value.as_f64().unwrap_or(f64::NAN);
    if clamp {
        a.insert(field.to_owned(), num(n.clamp(min, max)));
        return None;
    }
    if n < min {
        return Some(format!(
            "Error: builtin arg \"{field}\" must be >= {} (got {})",
            number_to_string(min),
            number_to_string(n)
        ));
    }
    a.insert(field.to_owned(), num(n.min(max)));
    None
}

/// `coercePatternStringValues`: a number or boolean where a string belongs becomes its string form.
fn coerce_pattern_values(v: &JsonValue) -> JsonValue {
    let one = |value: &JsonValue| match value {
        JsonValue::Number(_) | JsonValue::Bool(_) => JsonValue::String(value_to_string(value)),
        other => other.clone(),
    };
    match v {
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(one).collect()),
        other => one(other),
    }
}

fn is_string_or_string_array(v: &JsonValue) -> bool {
    match v {
        JsonValue::String(_) => true,
        JsonValue::Array(items) => !items.is_empty() && items.iter().all(JsonValue::is_string),
        _ => false,
    }
}

fn has_multiple_absolute_windows_paths(v: &JsonValue) -> bool {
    v.as_str().is_some_and(|s| DRIVE_ROOT.find_iter(s).count() > 1)
}

/// A string that only lists absolute Windows paths splits exactly at the drive roots; anything
/// else around the paths gives None.
fn split_listed_absolute_windows_paths(value: &str) -> Option<Vec<String>> {
    let trimmed = js_trim(value);
    let inner = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(trimmed);
    let body = inner.trim_matches(|c: char| is_js_space(c) || c == ',' || c == ';');
    let mut pieces = Vec::new();
    let mut from = 0;
    for m in LIST_SPLIT.find_iter(body) {
        pieces.push(&body[from..m.start]);
        from = m.end;
    }
    pieces.push(&body[from..]);
    let pieces: Vec<String> = pieces
        .into_iter()
        .map(|piece| QUOTED.captures(piece).and_then(|c| c.get(2)).unwrap_or(piece).to_owned())
        .collect();
    pieces
        .iter()
        .all(|p| DRIVE_HEAD.is_match(p) && !DRIVE_ROOT.is_match(&p[3..]))
        .then_some(pieces)
}

fn first_present<'a>(a: &'a Args, names: &[&str]) -> Option<&'a JsonValue> {
    names.iter().find_map(|n| a.get(*n).filter(|v| !v.is_null() && v.as_str() != Some("")))
}

fn push_clamp_notice(a: &mut Args, msg: String) {
    let notices = a.entry("_clampNotices".to_owned()).or_insert_with(|| JsonValue::Array(Vec::new()));
    if !notices.is_array() {
        *notices = JsonValue::Array(Vec::new());
    }
    if let JsonValue::Array(list) = notices {
        list.push(JsonValue::String(msg));
    }
}

fn guard_mode_args(a: &mut Args) -> Option<String> {
    for k in ["output_mode", "mode"] {
        let Some(value) = a.get(k) else { continue };
        // A second field's value concatenated after a newline: the first token names the mode.
        let first_token = value.as_str().filter(|t| t.contains('\n')).and_then(|text| {
            let first_line = js_trim(text.split('\n').next().unwrap_or_default());
            let token = first_line.split(is_js_space).find(|t| !t.is_empty()).unwrap_or_default();
            OUTPUT_MODES.contains(&token).then(|| token.to_owned())
        });
        if let Some(token) = first_token {
            a.insert(k.to_owned(), JsonValue::String(token));
        }
        if !a[k].as_str().is_some_and(|s| OUTPUT_MODES.contains(&s)) {
            return Some(format!(
                "Error: grep arg \"{k}\" must be one of content_with_context|content|files_with_matches|count (got {})",
                json_stringify(&a[k])
            ));
        }
    }
    None
}

/// Context mode counts head_limit in match blocks, so it is clamped harder.
fn clamp_context_head_limit(a: &mut Args) {
    let truthy = |k: &str| a.get(k).is_some_and(|v| v.as_str().is_none_or(|s| !s.is_empty()));
    let mode = if truthy("output_mode") { a.get("output_mode") } else { a.get("mode") }.and_then(|v| v.as_str());
    let has_explicit_ctx = ["-A", "-B", "-C", "context"].iter().any(|k| is_non_empty_present(a, k));
    if matches!(mode, Some("files_with_matches" | "count"))
        || (mode.is_some_and(|m| m != "content_with_context") && !has_explicit_ctx)
    {
        return;
    }
    if is_non_empty_present(a, "head_limit") {
        let hl = to_number(&a["head_limit"]);
        if hl.is_finite() && hl > GREP_CTX_HEAD_LIMIT_MAX {
            a.insert("head_limit".to_owned(), num(GREP_CTX_HEAD_LIMIT_MAX));
            push_clamp_notice(a, format!("notice: grep limit clamped to {GREP_CTX_HEAD_LIMIT_MAX} match blocks (context mode)"));
        }
    }
}

fn guard_grep(a: &mut Args) -> Option<String> {
    for key in ["include_noise", "text"] {
        if a.get(key).is_some_and(|v| !v.is_boolean()) {
            return Some(format!("Error: grep arg \"{key}\" must be a boolean"));
        }
    }
    const PATTERN_KEYS: [&str; 4] = ["pattern", "query", "regex", "needle"];
    const GLOB_KEYS: [&str; 4] = ["glob", "file_pattern", "include", "files"];
    for k in PATTERN_KEYS {
        if let Some(v) = a.get(k) {
            let coerced = coerce_pattern_values(v);
            a.insert(k.to_owned(), coerced);
        }
    }
    if !PATTERN_KEYS.iter().chain(GLOB_KEYS.iter()).any(|k| a.contains_key(*k)) {
        return Some("Error: grep requires pattern (or alias query/regex/needle) or glob.".to_owned());
    }
    for k in PATTERN_KEYS {
        if let Some(v) = a.get(k)
            && !is_string_or_string_array(v)
        {
            return Some(format!("Error: grep arg \"{k}\" must be string or string[] (got {})", describe_type(v)));
        }
    }
    for k in GLOB_KEYS {
        if let Some(v) = a.get(k) {
            let coerced = coerce_pattern_values(v);
            a.insert(k.to_owned(), coerced);
            if !a[k].is_string() {
                return Some(format!("Error: grep arg \"{k}\" must be string (got {})", describe_type(&a[k])));
            }
        }
    }
    for k in ["path", "root"] {
        if !a.contains_key(k) {
            continue;
        }
        if has_multiple_absolute_windows_paths(&a[k]) {
            let Some(listed) = a[k].as_str().and_then(split_listed_absolute_windows_paths) else {
                return Some(format!(
                    "Error: grep arg \"{k}\" contains multiple absolute paths in one string. Use one common parent path plus glob, or separate grep calls."
                ));
            };
            a.insert(k.to_owned(), JsonValue::Array(listed.into_iter().map(JsonValue::String).collect()));
        }
        if let JsonValue::Array(items) = &a[k] {
            if items.is_empty()
                || items.len() > PATH_BATCH_LIMIT
                || !items.iter().all(|i| i.as_str().is_some_and(|s| !s.is_empty()))
            {
                return Some(format!(
                    "Error: grep arg \"{k}\" must contain 1-{PATH_BATCH_LIMIT} non-empty path strings ({} given, max {PATH_BATCH_LIMIT})",
                    items.len()
                ));
            }
            continue;
        }
        if !a[k].is_string() {
            return Some(format!("Error: grep arg \"{k}\" must be string or string[] (got {})", describe_type(&a[k])));
        }
    }
    for k in ["head_limit", "offset"] {
        if let Some(err) = check_int_in_range(a, k, 0.0, MAX_INT, false) {
            return Some(err);
        }
    }
    for k in ["-A", "-B", "-C", "context"] {
        if a.get(k).and_then(|v| v.as_str()) == Some("") {
            a.remove(k);
            continue;
        }
        if let Some(err) = check_int_in_range(a, k, 0.0, GREP_CONTEXT_MAX, true) {
            return Some(err);
        }
    }
    if let Some(err) = guard_mode_args(a) {
        return Some(err);
    }
    clamp_context_head_limit(a);
    None
}

/// `applyGrepContextLeadPolicy`: the ripgrep spellings fold onto `-A`/`-B`/`context`, clamped.
fn apply_context_policy(a: &mut Args) {
    for (canonical, keys) in CONTEXT_KEY_GROUPS {
        let zero = |v: &JsonValue| {
            let n = to_number(v);
            n.is_finite() && n == 0.0
        };
        let found = keys
            .iter()
            .find(|k| is_non_empty_present(a, k) && !zero(&a[**k]))
            .or_else(|| keys.iter().find(|k| is_non_empty_present(a, k)));
        let Some(key) = found else { continue };
        let value = a[*key].clone();
        let n = to_number(&value);
        let shaped = if n.is_finite() && n > GREP_CONTEXT_MAX { num(GREP_CONTEXT_MAX) } else { value };
        for k in keys {
            a.remove(*k);
        }
        a.insert(canonical.to_owned(), shaped);
    }
}

/// `normalizeStringListArgs` for grep: nested lists flatten one level and blanks drop; `path` and
/// `root` are exact operands and stay as given.
fn normalize_string_lists(a: &mut Args) {
    for key in STRING_LIST_ARG_KEYS {
        if matches!(key, "path" | "root") {
            continue;
        }
        let Some(JsonValue::Array(source)) = a.get(key) else { continue };
        let mut flat = Vec::new();
        for entry in source.iter().flat_map(|e| match e {
            JsonValue::Array(inner) => inner.iter(),
            other => std::slice::from_ref(other).iter(),
        }) {
            if entry.is_null() || entry.as_str().is_some_and(|s| js_trim(s).is_empty()) {
                continue;
            }
            flat.push(entry.clone());
        }
        if flat == *source {
            continue;
        }
        if flat.is_empty() {
            a.remove(key);
        } else {
            a.insert(key.to_owned(), JsonValue::Array(flat));
        }
    }
}

fn validate(args: &mut JsonValue) -> Option<String> {
    let a = match args {
        JsonValue::Null => return Some("Error: grep requires arguments object (got null)".to_owned()),
        JsonValue::Object(a) => a,
        other => return Some(format!("Error: grep arguments must be an object (got {})", describe_type(other))),
    };
    a.retain(|_, v| !v.is_null());
    for key in ["path", "root"] {
        if a.get(key).and_then(|v| v.as_str()).is_some_and(|s| js_trim(s).is_empty()) {
            a.remove(key);
        }
    }
    if !a.contains_key("head_limit")
        && let Some(limit) = a.remove("limit")
    {
        a.insert("head_limit".to_owned(), limit);
    }
    if !a.contains_key("output_mode")
        && let Some(mode) = a.get("mode").and_then(|m| m.as_str())
    {
        let canonical = match js_trim(mode) {
            "content" => Some("content_with_context"),
            "files" => Some("files_with_matches"),
            "count" => Some("count"),
            _ => None,
        };
        if let Some(canonical) = canonical {
            a.insert("output_mode".to_owned(), JsonValue::String(canonical.to_owned()));
            a.remove("mode");
        }
    }
    normalize_string_lists(a);
    apply_context_policy(a);
    guard_grep(a)
}

/// `normalizeGrepArgs`: the alias spellings the guard accepts, adopted into the canonical fields.
fn normalize(a: &mut Args) {
    let empty = |a: &Args, k: &str| a.get(k).is_none_or(|v| v.is_null() || v.as_str() == Some(""));
    if a.get("head_limit").is_none_or(JsonValue::is_null)
        && let Some(limit) = a.remove("limit")
    {
        a.insert("head_limit".to_owned(), limit);
    }
    let adopt = |a: &mut Args, key: &str, aliases: &[&str]| {
        if empty(a, key)
            && let Some(v) = first_present(a, aliases).cloned()
        {
            a.insert(key.to_owned(), v);
        }
    };
    adopt(a, "path", &["root", "directory", "dir"]);
    adopt(a, "pattern", &["query", "regex", "regexp", "needle", "search", "literal"]);
    adopt(a, "glob", &["file_pattern", "filePattern", "include", "includes", "files"]);
    if empty(a, "output_mode")
        && let Some(mode) = a.get("mode").and_then(|m| m.as_str())
    {
        let canonical = match js_trim(mode) {
            "content" | "content_with_context" => Some("content_with_context"),
            "files" | "files_with_matches" => Some("files_with_matches"),
            "count" => Some("count"),
            _ => None,
        };
        if let Some(canonical) = canonical {
            a.insert("output_mode".to_owned(), JsonValue::String(canonical.to_owned()));
        }
    }
}

/// `{ args }` or the guard's error text.
pub(crate) fn prepare_grep_args(raw: &JsonValue) -> Result<JsonValue, String> {
    let mut args = raw.clone();
    if let JsonValue::Object(a) = &mut args {
        a.remove("_clampNotices");
    }
    if let Some(error) = validate(&mut args) {
        return Err(error);
    }
    if let JsonValue::Object(a) = &mut args {
        normalize(a);
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn ok(v: JsonValue) -> JsonValue {
        prepare_grep_args(&v).unwrap()
    }

    fn err(v: JsonValue) -> String {
        prepare_grep_args(&v).unwrap_err()
    }

    // Goldens: `prepareGrepArgs` run in Node on the same inputs.
    #[test]
    fn aliases_and_numeric_strings_normalize() {
        assert_eq!(
            ok(json!({"query": "foo", "limit": "5", "mode": "content"})),
            json!({"query": "foo", "head_limit": 5, "output_mode": "content_with_context", "pattern": "foo"})
        );
        assert_eq!(
            ok(json!({"pattern": "a", "-C": 3, "after": "300", "B": "2.0"})),
            json!({"pattern": "a", "-A": 200, "-B": 2, "context": 3})
        );
        assert_eq!(ok(json!({"pattern": ["a", ["b", ""], null, "  "]})), json!({"pattern": ["a", "b"]}));
        assert_eq!(
            ok(json!({"file_pattern": "*.ts", "regex": "q", "dir": "src", "includes": "*.mjs"})),
            json!({"file_pattern": "*.ts", "regex": "q", "dir": "src", "includes": "*.mjs", "path": "src", "pattern": "q", "glob": "*.ts"})
        );
    }

    #[test]
    fn clamps_and_notices_follow_the_guard() {
        assert_eq!(
            ok(json!({"pattern": 42, "path": "  ", "output_mode": "content_with_context\ntrue", "head_limit": 90})),
            json!({"pattern": "42", "output_mode": "content_with_context", "head_limit": 40,
                   "_clampNotices": ["notice: grep limit clamped to 40 match blocks (context mode)"]})
        );
        assert_eq!(
            ok(json!({"pattern": "x", "offset": "7", "-A": 2.7, "output_mode": "count", "_clampNotices": ["z"]})),
            json!({"pattern": "x", "offset": 7, "output_mode": "count", "-A": 2})
        );
        assert_eq!(
            ok(json!({"pattern": "x", "path": ["a", "b"], "head_limit": 100, "context": 0, "C": 4})),
            json!({"pattern": "x", "path": ["a", "b"], "head_limit": 40, "context": 4,
                   "_clampNotices": ["notice: grep limit clamped to 40 match blocks (context mode)"]})
        );
        assert_eq!(ok(json!({"pattern": "x", "mode": "files"})), json!({"pattern": "x", "output_mode": "files_with_matches"}));
    }

    #[test]
    fn windows_path_lists_split_at_drive_roots() {
        assert_eq!(ok(json!({"pattern": "x", "path": "C:\\a C:\\b"})), json!({"pattern": "x", "path": ["C:\\a", "C:\\b"]}));
        assert_eq!(
            ok(json!({"pattern": "x", "path": "C:\\a x C:\\b"})),
            json!({"pattern": "x", "path": ["C:\\a x", "C:\\b"]})
        );
    }

    #[test]
    fn invalid_requests_give_the_guard_errors() {
        assert_eq!(err(json!({})), "Error: grep requires pattern (or alias query/regex/needle) or glob.");
        assert_eq!(err(JsonValue::Null), "Error: grep requires arguments object (got null)");
        assert_eq!(err(json!([1])), "Error: grep arguments must be an object (got array)");
        assert_eq!(
            err(json!({"pattern": "x", "context": "1,5"})),
            "Error: \"context\" takes one integer, not a range \"1,5\" — use offset+limit (e.g. offset:0, limit:40)"
        );
        assert_eq!(err(json!({"pattern": "x", "head_limit": -1})), "Error: builtin arg \"head_limit\" must be >= 0 (got -1)");
        assert_eq!(
            err(json!({"pattern": "x", "mode": "bogus", "output_mode": "count"})),
            "Error: grep arg \"mode\" must be one of content_with_context|content|files_with_matches|count (got \"bogus\")"
        );
        assert_eq!(err(json!({"pattern": "x", "include_noise": "yes"})), "Error: grep arg \"include_noise\" must be a boolean");
        assert_eq!(
            err(json!({"pattern": "x", "path": []})),
            "Error: grep arg \"path\" must contain 1-10 non-empty path strings (0 given, max 10)"
        );
    }
}
