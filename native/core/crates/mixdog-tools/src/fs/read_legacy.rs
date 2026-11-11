//! The executor's own spelling of a `read` call: `path` (a string, an array of strings, region
//! objects or compact tuples) with its 0-based `offset`, `limit` (0 = no limit), `line`/`context`,
//! `mode`/`n` and `full`. Node's `guardRead` (`tools/builtin/arg-guard.mjs`) takes every one of them
//! and either refuses with a text or leaves the args the executor reads; this is that function, and
//! the glance modes (`read-mode-tool.mjs`) as pure renderers over the decoded text.

use mixdog_protocol::JsonValue;
use serde_json::Map;

pub(super) type Obj = Map<String, JsonValue>;

const MAX_INT: f64 = 100_000.0;
/// `Number.MAX_SAFE_INTEGER`: a start line only positions the window, so it is not capped like the limit.
const READ_OFFSET_MAX: f64 = 9_007_199_254_740_991.0;
const GUARD_DEFAULT_LIMIT: i64 = 500;
const LINE_SEP: char = '→';

fn regex(cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("a fixed pattern"))
}

pub(super) fn describe_type(v: &JsonValue) -> &'static str {
    match v {
        JsonValue::Null => "null",
        JsonValue::Array(_) => "array",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Object(_) => "object",
    }
}

fn is_finite_int(v: &JsonValue) -> bool {
    v.as_f64().is_some_and(|f| f.floor() == f)
}

/// A whole number as the JSON a JS integer serializes to.
fn int_value(n: f64) -> JsonValue {
    if n.abs() < 9.0e18 { JsonValue::from(n as i64) } else { JsonValue::from(n) }
}

fn present(o: &Obj, k: &str) -> bool {
    o.get(k).is_some_and(|v| !v.is_null())
}

fn is_plain_object(v: &JsonValue) -> bool {
    matches!(v, JsonValue::Object(_))
}

/// `coerceIntegerString`: a lossless integer spelled as a string.
fn coerce_integer_string(v: &JsonValue) -> Option<f64> {
    static INT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let JsonValue::String(s) = v else { return None };
    let t = mixdog_js::js_trim(s);
    if t.is_empty() || !regex(&INT, r"^-?\d+(\.\d+)?$").is_match(t) {
        return None;
    }
    let n: f64 = t.parse().ok()?;
    (n.is_finite() && n.fract() == 0.0).then_some(n)
}

fn range_shaped(s: &str) -> bool {
    static RANGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    regex(&RANGE, r"^\d+\s*[,\-:]\s*\d+$").is_match(s)
}

/// `checkIntInRange`: a numeric string is coerced in place; under `min` is refused, over `max` clamped.
fn check_int_in_range(a: &mut Obj, field: &str, min: f64, max: f64) -> Option<String> {
    let mut value = a.get(field)?.clone();
    if value.is_null() {
        return None;
    }
    if let Some(n) = coerce_integer_string(&value) {
        value = int_value(n);
        a.insert(field.to_owned(), value.clone());
    }
    if let JsonValue::String(s) = &value
        && range_shaped(mixdog_js::js_trim(s))
    {
        return Some(format!(
            "Error: \"{field}\" takes one integer, not a range \"{s}\" — use offset+limit (e.g. offset:0, limit:40)"
        ));
    }
    if !is_finite_int(&value) {
        return Some(format!("Error: \"{field}\" must be an integer (got {}) — e.g. {field}:40", describe_type(&value)));
    }
    let n = value.as_f64().unwrap_or_default();
    if n < min {
        return Some(format!("Error: builtin arg \"{field}\" must be >= {min} (got {n})"));
    }
    a.insert(field.to_owned(), int_value(n.min(max)));
    None
}

/// `coerceShapeFlex`: a JSON-spelled array, quoted string or `{path,…}` object becomes the value.
fn coerce_shape_flex(value: &JsonValue) -> JsonValue {
    let JsonValue::String(s) = value else { return value.clone() };
    let t = mixdog_js::js_trim(s);
    if t.starts_with('[') && t.ends_with(']')
        && let Ok(parsed @ JsonValue::Array(_)) = serde_json::from_str::<JsonValue>(t)
    {
        return parsed;
    }
    if t.chars().count() >= 2 && t.starts_with('"') && t.ends_with('"')
        && let Ok(parsed @ JsonValue::String(_)) = serde_json::from_str::<JsonValue>(t)
    {
        return parsed;
    }
    if t.starts_with('{') && t.ends_with('}')
        && let Ok(parsed @ JsonValue::Object(_)) = serde_json::from_str::<JsonValue>(t)
    {
        let named = parsed.get("path").filter(|v| !v.is_null()).or_else(|| parsed.get("file_path"));
        if named.is_some_and(JsonValue::is_string) {
            return JsonValue::Array(vec![parsed]);
        }
    }
    value.clone()
}

fn coerce_window_array(v: Option<&JsonValue>) -> Option<Vec<JsonValue>> {
    match v? {
        JsonValue::Array(items) => Some(items.clone()),
        JsonValue::String(_) => {
            let v = v?;
            let mut c = coerce_shape_flex(v);
            if c.is_string() && c != *v {
                c = coerce_shape_flex(&c);
            }
            match c {
                JsonValue::Array(items) => Some(items),
                _ => None,
            }
        }
        _ => None,
    }
}

/// `compactReadRangeTuple`: `[path, offset, limit?]` as a region object.
fn compact_range_tuple(value: &JsonValue) -> Option<JsonValue> {
    static NUM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let JsonValue::Array(parts) = value else { return None };
    if parts.len() < 2 || parts.len() > 3 || !parts[0].is_string() {
        return None;
    }
    let numeric = parts[1..].iter().all(|p| match p {
        JsonValue::Number(_) => true,
        JsonValue::String(s) => regex(&NUM, r"^-?\d+(?:\.\d+)?$").is_match(mixdog_js::js_trim(s)),
        _ => false,
    });
    if !numeric {
        return None;
    }
    let mut region = Obj::new();
    region.insert("path".to_owned(), parts[0].clone());
    region.insert("offset".to_owned(), parts[1].clone());
    if parts.len() == 3 {
        region.insert("limit".to_owned(), parts[2].clone());
    }
    Some(JsonValue::Object(region))
}

/// `coerceReadFamilyPathArg`: compact tuples become regions, blanks and nulls go, a lone string is scalar.
fn coerce_read_family_path_arg(path: JsonValue) -> JsonValue {
    let JsonValue::Array(list) = &path else { return path };
    if let Some(direct) = compact_range_tuple(&path) {
        return JsonValue::Array(vec![direct]);
    }
    let mut kept: Vec<JsonValue> = list
        .iter()
        .map(|p| {
            compact_range_tuple(p).unwrap_or_else(|| match p {
                JsonValue::String(s) => JsonValue::String(mixdog_js::js_trim(s).to_owned()),
                other => other.clone(),
            })
        })
        .filter(|p| match p {
            JsonValue::String(s) => !s.is_empty(),
            JsonValue::Object(_) | JsonValue::Array(_) => true,
            _ => false,
        })
        .collect();
    if kept.len() == 1 && kept[0].is_string() {
        return kept.remove(0);
    }
    JsonValue::Array(kept)
}

/// `absorbReadEchoedPathInteger`: an integer followed by the echo of this call's own path.
fn absorb_echoed_path_integer(a: &mut Obj, field: &str) {
    static ECHO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let Some(JsonValue::String(value)) = a.get(field) else { return };
    let Some(m) = regex(&ECHO, r"(?s)^(\d+)(?:\s+├──path──|\s*usepath\?)(.+)$").captures(mixdog_js::js_trim(value)) else { return };
    let comparable = |s: &str| {
        let normalized = mixdog_js::js_trim(s).replace('\\', "/");
        if cfg!(windows) { normalized.to_lowercase() } else { normalized }
    };
    let target = ["file_path", "path"].iter().find_map(|k| a.get(*k).and_then(JsonValue::as_str)).unwrap_or("");
    if target.is_empty() || comparable(&m[2]) != comparable(target) {
        return;
    }
    let Ok(n) = m[1].parse::<f64>() else { return };
    a.insert(field.to_owned(), int_value(n));
}

/// `maybeZipPathWindowArrays`: parallel `offset`/`limit` arrays become one region per path.
fn maybe_zip_path_window_arrays(a: &mut Obj) {
    if let Some(JsonValue::String(p)) = a.get("path")
        && !p.is_empty()
        && (coerce_window_array(a.get("offset")).is_some() || coerce_window_array(a.get("limit")).is_some())
    {
        let wrapped = JsonValue::Array(vec![JsonValue::String(p.clone())]);
        a.insert("path".to_owned(), wrapped);
    }
    let Some(JsonValue::Array(paths)) = a.get("path") else { return };
    if paths.is_empty() || !paths.iter().all(JsonValue::is_string) {
        return;
    }
    let (offs, lims) = (coerce_window_array(a.get("offset")), coerce_window_array(a.get("limit")));
    if offs.is_none() && lims.is_none() {
        return;
    }
    let pick = |arr: &Option<Vec<JsonValue>>, i: usize| -> Option<JsonValue> {
        let arr = arr.as_ref()?;
        if arr.len() == 1 { arr.first().cloned() } else { arr.get(i).cloned() }
    };
    let region = |p: &JsonValue, i: usize| {
        let mut r = Obj::new();
        r.insert("path".to_owned(), p.clone());
        if let Some(o) = pick(&offs, i).filter(|o| !o.is_null()) {
            r.insert("offset".to_owned(), o);
        }
        if let Some(l) = pick(&lims, i).filter(|l| !l.is_null()) {
            r.insert("limit".to_owned(), l);
        }
        JsonValue::Object(r)
    };
    let k = offs.as_ref().map_or(0, Vec::len).max(lims.as_ref().map_or(0, Vec::len));
    let regions: Vec<JsonValue> = if paths.len() == 1 && k > 1 {
        (0..k).map(|i| region(&paths[0], i)).collect()
    } else {
        paths.iter().enumerate().map(|(i, p)| region(p, i)).collect()
    };
    a.insert("path".to_owned(), JsonValue::Array(regions));
    a.shift_remove("offset");
    a.shift_remove("limit");
}

/// `absorbNegativeReadOffset`: `offset:-N` is the last N lines.
fn absorb_negative_read_offset(obj: &mut Obj) {
    if !present(obj, "offset") {
        return;
    }
    if let Some(n) = obj.get("offset").and_then(coerce_integer_string) {
        obj.insert("offset".to_owned(), int_value(n));
    }
    let Some(value) = obj.get("offset").filter(|v| is_finite_int(v)).and_then(JsonValue::as_f64) else { return };
    if value >= 0.0 {
        return;
    }
    let n = value.abs().min(MAX_INT);
    if !present(obj, "mode") {
        obj.insert("mode".to_owned(), JsonValue::String("tail".to_owned()));
    }
    if !present(obj, "n") {
        obj.insert("n".to_owned(), int_value(n));
    }
    obj.shift_remove("offset");
    obj.shift_remove("limit");
}

/// `applyLineContextWindow`: `{line, context}` as `{offset, limit}`; an explicit window wins.
fn apply_line_context_window(obj: &mut Obj, prefix: &str) -> Option<String> {
    for k in ["line", "context", "offset", "limit"] {
        if let Some(n) = obj.get(k).filter(|v| v.is_string()).and_then(coerce_integer_string) {
            obj.insert(k.to_owned(), int_value(n));
        }
    }
    let (has_line, has_context) = (present(obj, "line"), present(obj, "context"));
    if !has_line && !has_context {
        return None;
    }
    if present(obj, "offset") || present(obj, "limit") {
        obj.shift_remove("line");
        obj.shift_remove("context");
        return None;
    }
    if !has_line {
        return Some(format!("Error: read arg \"{prefix}context\" requires \"{prefix}line\" to compute a window"));
    }
    let line = obj.get("line").cloned().unwrap_or(JsonValue::Null);
    if let JsonValue::String(s) = &line
        && range_shaped(mixdog_js::js_trim(s))
    {
        return Some(format!(
            "Error: \"{prefix}line\" takes one integer, not a range \"{s}\" — use offset+limit (e.g. offset:0, limit:40)"
        ));
    }
    let line_no = line.as_f64().filter(|_| is_finite_int(&line)).filter(|n| *n >= 1.0);
    let Some(line_no) = line_no else {
        return Some(format!("Error: \"{prefix}line\" must be an integer >= 1 (got {}) — e.g. line:40", describe_type(&line)));
    };
    let mut ctx = 0.0;
    if has_context {
        let context = obj.get("context").cloned().unwrap_or(JsonValue::Null);
        if let JsonValue::String(s) = &context
            && range_shaped(mixdog_js::js_trim(s))
        {
            return Some(format!("Error: \"{prefix}context\" takes one integer, not a range \"{s}\" — e.g. context:5"));
        }
        let Some(c) = context.as_f64().filter(|_| is_finite_int(&context)).filter(|n| *n >= 0.0) else {
            return Some(format!("Error: \"{prefix}context\" must be an integer >= 0 (got {}) — e.g. context:5", describe_type(&context)));
        };
        ctx = c;
    }
    obj.insert("offset".to_owned(), int_value((line_no - 1.0 - ctx).max(0.0)));
    obj.insert("limit".to_owned(), int_value(2.0 * ctx + 1.0));
    obj.shift_remove("line");
    obj.shift_remove("context");
    None
}

/// `maybeCapUnboundedRead`: a plain read with no window of any kind gets the default window.
/// Returns whether the limit is the injected default (the glob survey may tighten it).
fn maybe_cap_unbounded_read(a: &mut Obj) -> bool {
    static COORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let named = |v: Option<&JsonValue>| v.and_then(JsonValue::as_str).filter(|s| !mixdog_js::js_trim(s).is_empty()).map(str::to_owned);
    let paths: Vec<String> = if let Some(p) = named(a.get("path")) {
        vec![p]
    } else if let Some(p) = named(a.get("file_path")) {
        vec![p]
    } else if let Some(JsonValue::Array(items)) = a.get("path")
        && !items.is_empty()
        && items.iter().all(|e| e.as_str().is_some_and(|s| !mixdog_js::js_trim(s).is_empty()))
    {
        items.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect()
    } else {
        return false;
    };
    if a.get("full") == Some(&JsonValue::Bool(true)) {
        return false;
    }
    if ["offset", "limit", "line", "context", "n", "mode", "pages"].iter().any(|k| present(a, k)) {
        return false;
    }
    if paths.iter().any(|p| p.contains('#') || regex(&COORD, r":\d+(?:-\d+)?\s*$").is_match(p)) {
        return false;
    }
    a.insert("limit".to_owned(), JsonValue::from(GUARD_DEFAULT_LIMIT));
    true
}

const STRING_LIST_ARG_KEYS: [&str; 15] = [
    "path", "paths", "root", "file", "files", "pattern", "patterns", "query", "regex", "needle", "glob",
    "file_pattern", "include", "type", "symbols",
];

/// What `validateBuiltinArgs` does to a `read` call before its guard: `null` means not sent, and a
/// string-list argument is flattened one level and loses its blanks.
pub(super) fn prepare(a: &mut Obj) {
    a.retain(|_, v| !v.is_null());
    for key in STRING_LIST_ARG_KEYS {
        let Some(JsonValue::Array(source)) = a.get(key) else { continue };
        if key == "path" && source.iter().any(JsonValue::is_array) {
            continue;
        }
        let mut flat: Vec<JsonValue> = Vec::new();
        for entry in source {
            match entry {
                JsonValue::Array(inner) => flat.extend(inner.iter().cloned()),
                other => flat.push(other.clone()),
            }
        }
        flat.retain(|e| !e.is_null() && !e.as_str().is_some_and(|s| mixdog_js::js_trim(s).is_empty()));
        if flat == *source {
            continue;
        }
        if flat.is_empty() {
            a.shift_remove(key);
        } else {
            a.insert(key.to_owned(), JsonValue::Array(flat));
        }
    }
}

/// `guardRead` for a call without `file_path`: the refusal, or whether the limit is the injected default.
pub(super) fn guard_read(a: &mut Obj) -> Result<bool, String> {
    if !a.contains_key("path") {
        return Err("Error: read requires \"path\" (or alias file_path).".to_owned());
    }
    let path = coerce_read_family_path_arg(a.get("path").cloned().unwrap_or(JsonValue::Null));
    a.insert("path".to_owned(), path);
    absorb_echoed_path_integer(a, "offset");
    absorb_echoed_path_integer(a, "limit");
    maybe_zip_path_window_arrays(a);
    absorb_negative_read_offset(a);
    if let Some(JsonValue::Array(entries)) = a.get_mut("path") {
        for entry in entries.iter_mut() {
            if let JsonValue::Object(obj) = entry {
                absorb_negative_read_offset(obj);
            }
        }
    }
    let path = a.get("path").cloned().unwrap_or(JsonValue::Null);
    let usable = path.is_string() || matches!(&path, JsonValue::Array(items) if !items.is_empty());
    if !usable {
        return Err(format!("Error: read arg \"path\" must be string, string[], or object[] (got {})", describe_type(&path)));
    }
    if let JsonValue::Array(mut entries) = path {
        let has_region_obj = entries.iter().any(is_plain_object);
        if has_region_obj && (present(a, "offset") || present(a, "limit")) {
            for entry in entries.iter_mut() {
                let JsonValue::Object(e) = entry else { continue };
                for k in ["offset", "limit"] {
                    if present(a, k) && !present(e, k) {
                        e.insert(k.to_owned(), a.get(k).cloned().unwrap_or(JsonValue::Null));
                    }
                }
            }
            a.shift_remove("offset");
            a.shift_remove("limit");
        }
        for (i, entry) in entries.iter_mut().enumerate() {
            if entry.is_string() {
                continue;
            }
            let kind = describe_type(entry);
            let JsonValue::Object(e) = entry else {
                return Err(format!("Error: read arg \"path[{i}]\" must be string or {{path,offset,limit}} object (got {kind})"));
            };
            if let Some(err) = apply_line_context_window(e, &format!("path[{i}].")) {
                return Err(err);
            }
            for ek in ["offset", "limit"] {
                let max = if ek == "offset" { READ_OFFSET_MAX } else { MAX_INT };
                if let Some(err) = check_int_in_range(e, ek, 0.0, max) {
                    return Err(err.replacen(&format!("\"{ek}\""), &format!("\"path[{i}].{ek}\""), 1));
                }
            }
        }
        a.insert("path".to_owned(), JsonValue::Array(entries));
    }
    let defaulted = maybe_cap_unbounded_read(a);
    if let Some(err) = apply_line_context_window(a, "") {
        return Err(err);
    }
    if let Some(err) = check_int_in_range(a, "offset", 0.0, READ_OFFSET_MAX) {
        return Err(err);
    }
    if let Some(err) = check_int_in_range(a, "limit", 0.0, MAX_INT) {
        return Err(err);
    }
    if present(a, "n")
        && let Some(err) = check_int_in_range(a, "n", 0.0, 10_000.0)
    {
        return Err(err);
    }
    Ok(defaulted)
}

// ---------------------------------------------------------------------------
// The glance modes: head, tail, count, summary, hex
// ---------------------------------------------------------------------------

/// `parseInt(value ?? default) || default`, clamped: `0` and what is not a number take the default.
pub(super) fn mode_count(v: Option<&JsonValue>, default: i64, min: i64, max: i64) -> i64 {
    let n = v.and_then(JsonValue::as_f64).map_or(default, |f| f.trunc() as i64);
    (if n == 0 { default } else { n }).clamp(min, max)
}

/// `capShellOutput`: whole when it fits, else its head and tail lines.
pub(super) fn cap_shell_output(s: &str) -> String {
    const MAX_BYTES: usize = 50 * 1024;
    const MAX_LINES: usize = 400;
    const KEEP: usize = 80;
    let lines: Vec<&str> = s.split('\n').collect();
    if s.len() <= MAX_BYTES && lines.len() <= MAX_LINES {
        return s.to_owned();
    }
    if s.len() <= MAX_BYTES {
        let middle = lines.len() - 2 * KEEP;
        return format!(
            "{}\n\n... [{middle} lines omitted of {} total — head and tail shown] ...\n\n{}",
            lines[..KEEP].join("\n"),
            lines.len(),
            lines[lines.len() - KEEP..].join("\n")
        );
    }
    if lines.len() <= MAX_LINES {
        return format!("{}\n\n... [output exceeded {} KB on a single line] ...", super::common::byte_prefix(s, MAX_BYTES), MAX_BYTES / 1024);
    }
    let middle = lines.len() - 2 * KEEP;
    let total_kb = (s.len() as f64 / 1024.0).round() as u64;
    format!(
        "{}\n\n... [{middle} lines omitted of {} total / {total_kb} KB — head and tail shown] ...\n\n{}",
        lines[..KEEP].join("\n"),
        lines.len(),
        lines[lines.len() - KEEP..].join("\n")
    )
}

fn raw_lines(content: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn display_line(raw: &str, index: usize) -> &str {
    let line = raw.strip_suffix('\r').unwrap_or(raw);
    if index == 0 { line.strip_prefix('\u{feff}').unwrap_or(line) } else { line }
}

/// What a head or tail answer showed whole: lines start..=end of a file of 	otal.
pub(super) struct Seen {
    pub start: u64,
    pub end: u64,
    pub total: u64,
    pub whole: bool,
}

fn window_rows(lines: &[&str], start: usize, n: usize) -> (String, Option<Seen>) {
    let rows = lines
        .iter()
        .enumerate()
        .skip(start)
        .take(n)
        .map(|(i, l)| format!("{}{LINE_SEP}{}", i + 1, display_line(l, i)))
        .collect::<Vec<_>>()
        .join("\n");
    let shown = lines.len().saturating_sub(start).min(n);
    let out = cap_shell_output(&rows);
    let seen = (out == rows && shown > 0).then(|| Seen { start: start as u64 + 1, end: (start + shown) as u64, total: lines.len() as u64, whole: shown >= lines.len() });
    (out, seen)
}

pub(super) fn head_rows(content: &str, n: usize) -> (String, Option<Seen>) {
    window_rows(&raw_lines(content), 0, n)
}

pub(super) fn tail_rows(content: &str, n: usize) -> (String, Option<Seen>) {
    let lines = raw_lines(content);
    window_rows(&lines, lines.len().saturating_sub(n), n)
}

/// `countDisplayLines`, the words of `/\S+/g`, and the file's size on disk.
pub(super) fn text_stats(content: &str, bytes: u64) -> String {
    let lines = if content.is_empty() {
        0
    } else {
        usize::from(!content.ends_with('\n')) + content.matches('\n').count()
    };
    let words = content.split(mixdog_js::is_js_space).filter(|w| !w.is_empty()).count();
    format!("lines\t{lines}\twords\t{words}\tbytes\t{bytes}")
}

fn symbol_pattern() -> &'static regex::Regex {
    static SYMBOL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let id = r"[A-Za-z_$][A-Za-z0-9_$]*";
    let pattern = [
        format!(r"^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|enum)\s+{id}"),
        format!(r"^\s*(?:export\s+)?(?:const|let|var)\s+{id}\s*="),
        r"^\s*(?:def|class)\s+[A-Za-z_][A-Za-z0-9_]*".to_owned(),
        r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*".to_owned(),
        r"^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+[A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?".to_owned(),
        r"^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(".to_owned(),
        r"^\s*type\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:struct|interface)\b".to_owned(),
        r"^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|async|final)\s+)*(?:class|interface|enum|record|struct)\s+[A-Za-z_][A-Za-z0-9_]*".to_owned(),
        r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|final|synchronized|abstract|partial)\s+)+(?:[A-Za-z0-9_<>\[\],.?]+\s+)+[A-Za-z_][A-Za-z0-9_]*\s*\(".to_owned(),
        r"^\s*#{1,3}\s+\S".to_owned(),
    ]
    .iter()
    .map(|p| format!("(?:{p})"))
    .collect::<Vec<_>>()
    .join("|");
    regex(&SYMBOL, &pattern)
}

/// One row of `collectSummarySymbols`: the line, when it opens a symbol or heading.
pub(super) fn symbol_row(line_no: u64, line: &str, render_line: &dyn Fn(u64, &str) -> String) -> Option<String> {
    symbol_pattern().is_match(line).then(|| render_line(line_no, line.trim_end_matches(mixdog_js::is_js_space)))
}

/// `renderSummary`: the stats line, the symbol count (`capped` at `limit`) and the symbol rows.
pub(super) fn summary_render(shown: &str, stats: &str, symbols: Vec<String>, limit: usize) -> String {
    let capped = if symbols.len() >= limit { format!(" (capped at {limit})") } else { String::new() };
    let mut lines = vec![format!("summary {shown}"), stats.to_owned(), format!("symbols\t{}{capped}", symbols.len()), String::new()];
    if symbols.is_empty() {
        lines.push("(no obvious symbols/headings found)".to_owned());
    } else {
        lines.extend(symbols);
    }
    cap_shell_output(&lines.join("\n"))
}

/// `executeSummaryTool`'s text over a file held whole: its stats and its first `limit` symbol rows.
pub(super) fn summary_text(shown: &str, content: &str, bytes: u64, limit: usize, render_line: &dyn Fn(u64, &str) -> String) -> String {
    let mut symbols: Vec<String> = Vec::new();
    for (i, raw) in content.split('\n').enumerate() {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = if i == 0 { raw.strip_prefix('\u{feff}').unwrap_or(raw) } else { raw };
        if let Some(row) = symbol_row(i as u64 + 1, line, render_line) {
            symbols.push(row);
            if symbols.len() >= limit {
                break;
            }
        }
    }
    summary_render(shown, &text_stats(content, bytes), symbols, limit)
}

/// Node's `readline` over a byte stream: lines end at `\n`, `\r\n` or a lone `\r`; the last line
/// needs no terminator. Bytes are decoded as UTF-8, a bad sequence becoming U+FFFD.
#[derive(Default)]
pub(super) struct LineReader {
    pending: Vec<u8>,
    after_cr: bool,
}

impl LineReader {
    /// Feeds a chunk; completed lines go to `out` until it holds `max` of them.
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>, max: usize) {
        for &byte in chunk {
            if out.len() >= max {
                return;
            }
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\n' => out.push(String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned()),
                b'\r' => {
                    out.push(String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned());
                    self.after_cr = true;
                }
                other => self.pending.push(other),
            }
        }
    }

    /// The end of the stream: an unterminated last line is a line.
    pub fn finish(&mut self, out: &mut Vec<String>) {
        if !self.pending.is_empty() {
            out.push(String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned());
        }
    }
}

/// `readLargeTailWindowSync` after its read: the last `target` lines of the tail window `buf` (the
/// last `buf.len()` bytes of a file of `size`), and whether the window is approximate / capped.
pub(super) fn large_tail_lines(buf: &[u8], size: u64, target: usize, window_cap: u64) -> (Vec<String>, bool, bool) {
    let approximate = (buf.len() as u64) < size;
    let skip = if approximate { buf.iter().take(4).take_while(|b| (**b & 0xc0) == 0x80).count() } else { 0 };
    let text = String::from_utf8_lossy(&buf[skip..]).into_owned();
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    if approximate && lines.len() > 1 {
        lines.remove(0);
    }
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let from = lines.len().saturating_sub(target);
    let capped = approximate && (buf.len() as u64) >= window_cap;
    (lines.split_off(from), approximate, capped)
}

/// `renderTailWindowSync` without exact line numbers: a header, the rows, the cap note.
pub(super) fn large_tail_text(lines: &[String], capped: bool, window_cap: u64, clip: &dyn Fn(&str) -> String) -> String {
    let rendered = lines.iter().enumerate().map(|(i, l)| clip(display_line(l, i))).collect::<Vec<_>>().join("\n");
    let marker = if capped { format!("\n... [tail window capped at {} KB]", window_cap / 1024) } else { String::new() };
    cap_shell_output(&format!("... [tail of {} lines from end of file; line numbers omitted]\n{rendered}{marker}", lines.len()))
}
/// `executeHexTool`'s text: `bytes` is the window read from `offset` of a file of `size` bytes.
pub(super) fn hex_text(shown: &str, bytes: &[u8], offset: u64, size: u64) -> String {
    let mut lines = vec![format!("hex {shown} offset={offset} read={}/{size}", bytes.len())];
    for (row, chunk) in bytes.chunks(16).enumerate() {
        let hex = chunk.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        let ascii: String = chunk.iter().map(|b| if (0x20..0x7f).contains(b) { *b as char } else { '.' }).collect();
        lines.push(format!("{:08x}  {hex:<48}  |{ascii}|", offset + row as u64 * 16));
    }
    let read = bytes.len() as u64;
    if offset + read < size {
        lines.push(format!("... {} more bytes (paginate via n + offset)", size - offset - read));
    }
    cap_shell_output(&lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Node's `guardRead` made of every recorded call (`legacy_read_cases.json`): the refusal,
    /// or the args it left for the executor and whether the limit is the injected default.
    #[test]
    fn the_guard_refuses_and_rewrites_as_node_does() {
        let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/legacy_read_cases.json")).unwrap();
        let mut failures = Vec::new();
        let mut ran = 0;
        for case in doc["cases"].as_array().unwrap() {
            let JsonValue::Object(input) = &case["input"] else { continue };
            // The public `file_path` form is `normalizePublicReadTargets`, which `parse_public` answers.
            if input.contains_key("file_path") {
                continue;
            }
            ran += 1;
            let mut args = input.clone();
            prepare(&mut args);
            let outcome = guard_read(&mut args);
            let want = &case["guard"];
            let same = match (&outcome, want.get("error")) {
                (Err(text), Some(error)) => error.as_str() == Some(text.as_str()),
                (Ok(defaulted), None) => {
                    JsonValue::Object(args.clone()) == want["args"] && *defaulted == want["limitDefaulted"].as_bool().unwrap_or(false)
                }
                _ => false,
            };
            if !same {
                failures.push(format!("{}\n  want {want}\n  got  {outcome:?} {args:?}", case["name"]));
            }
        }
        assert!(failures.is_empty(), "{} of {ran} differ:\n{}", failures.len(), failures.join("\n"));
    }
}