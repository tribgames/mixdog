//! Tool arguments checked as Node's zod 4 schemas check them (`index.mjs`: `urlArgsSchema`,
//! `webSearchArgsSchema`), issue for issue and in the same key order, because the issue list is
//! the model-visible error text. A union reports its branches only when none of them had a
//! type-compatible attempt, as zod does (`continue` is false on a type or value mismatch).

use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

const SAFE_INT: i64 = 9_007_199_254_740_991;

struct Issue {
    json: Value,
    /// zod's `continue`: later checks of the same value still ran.
    keep_going: bool,
}

type Issues = Vec<Issue>;

fn found(json: Value, keep_going: bool) -> Issues {
    vec![Issue { json, keep_going }]
}

/// Prepends `key` to every issue's path.
fn at(mut issues: Issues, key: Value) -> Issues {
    for issue in &mut issues {
        if let Some(Value::Array(path)) = issue.json.get_mut("path") {
            path.insert(0, key.clone());
        }
    }
    issues
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, value: Option<&Value>) -> Issue {
    Issue {
        json: json!({
            "expected": expected,
            "code": "invalid_type",
            "path": [],
            "message": format!("Invalid input: expected {expected}, received {}", received(value)),
        }),
        keep_going: false,
    }
}

fn too_small_length(origin: &str) -> Issue {
    let unit = if origin == "string" { "characters" } else { "items" };
    Issue {
        json: json!({
            "origin": origin,
            "code": "too_small",
            "minimum": 1,
            "inclusive": true,
            "path": [],
            "message": format!("Too small: expected {origin} to have >=1 {unit}"),
        }),
        keep_going: true,
    }
}

/// `z.string()`, with `.min(1)` and/or `.url()`. zod runs a length check on any value that has a
/// length, even one of the wrong type, so an empty array fails `.min(1)` as well.
fn string(value: Option<&Value>, min_one: bool, url: bool) -> Issues {
    match value {
        Some(Value::String(text)) => {
            let mut issues = Vec::new();
            if min_one && text.is_empty() {
                issues.push(too_small_length("string"));
            }
            if url && Url::parse(text).is_err() {
                issues.push(Issue {
                    json: json!({ "code": "invalid_format", "format": "url", "path": [], "message": "Invalid URL" }),
                    keep_going: true,
                });
            }
            issues
        }
        other => {
            let mut issues = vec![invalid_type("string", other)];
            if min_one && matches!(other, Some(Value::Array(items)) if items.is_empty()) {
                issues.push(too_small_length("array"));
            }
            issues
        }
    }
}

fn array(value: Option<&Value>, min_one: bool, item: impl Fn(Option<&Value>) -> Issues) -> Issues {
    match value {
        Some(Value::Array(items)) => {
            let mut issues = Vec::new();
            for (index, element) in items.iter().enumerate() {
                issues.extend(at(item(Some(element)), json!(index)));
            }
            if min_one && items.is_empty() {
                issues.push(too_small_length("array"));
            }
            issues
        }
        other => found(invalid_type("array", other).json, false),
    }
}

/// `z.union([a, b])` of two branches with disjoint types.
fn union(branches: [Issues; 2]) -> Issues {
    if branches.iter().any(Vec::is_empty) {
        return Vec::new();
    }
    let errors: Vec<Value> = branches
        .iter()
        .map(|issues| Value::Array(issues.iter().map(|issue| issue.json.clone()).collect()))
        .collect();
    let mut open: Vec<Issues> = branches.into_iter().filter(|issues| issues.iter().all(|issue| issue.keep_going)).collect();
    if open.len() == 1 {
        return open.remove(0);
    }
    found(json!({ "code": "invalid_union", "errors": errors, "path": [], "message": "Invalid input" }), false)
}

/// `z.number().int().min(min)` with an optional `.max(max)`: zod's order is the type, the
/// integer check (a fraction ends the value's checks; an unsafe integer does not), then the bounds.
fn int(value: Option<&Value>, min: i64, max: Option<i64>) -> Issues {
    let Some(Value::Number(number)) = value else {
        return found(invalid_type("number", value).json, false);
    };
    let n = number.as_f64().unwrap_or(f64::NAN);
    if n.fract() != 0.0 {
        return found(
            json!({
                "expected": "int",
                "format": "safeint",
                "code": "invalid_type",
                "path": [],
                "message": "Invalid input: expected int, received number",
            }),
            false,
        );
    }
    let mut issues = Vec::new();
    let note = "Integers must be within the safe integer range.";
    if n > SAFE_INT as f64 {
        issues.push(Issue {
            json: json!({
                "code": "too_big", "maximum": SAFE_INT, "note": note, "origin": "int", "inclusive": true,
                "path": [], "message": format!("Too big: expected int to be <={SAFE_INT}"),
            }),
            keep_going: true,
        });
    } else if n < -(SAFE_INT as f64) {
        issues.push(Issue {
            json: json!({
                "code": "too_small", "minimum": -SAFE_INT, "note": note, "origin": "int", "inclusive": true,
                "path": [], "message": format!("Too small: expected int to be >={}", -SAFE_INT),
            }),
            keep_going: true,
        });
    }
    if n < min as f64 {
        issues.push(Issue {
            json: json!({
                "origin": "number", "code": "too_small", "minimum": min, "inclusive": true,
                "path": [], "message": format!("Too small: expected number to be >={min}"),
            }),
            keep_going: true,
        });
    }
    if let Some(max) = max
        && n > max as f64
    {
        issues.push(Issue {
            json: json!({
                "origin": "number", "code": "too_big", "maximum": max, "inclusive": true,
                "path": [], "message": format!("Too big: expected number to be <={max}"),
            }),
            keep_going: true,
        });
    }
    issues
}

fn one_of(value: Option<&Value>, values: &[&str]) -> Issues {
    if matches!(value, Some(Value::String(text)) if values.contains(&text.as_str())) {
        return Vec::new();
    }
    let options: Vec<String> = values.iter().map(|option| format!("\"{option}\"")).collect();
    found(
        json!({
            "code": "invalid_value",
            "values": values,
            "path": [],
            "message": format!("Invalid option: expected one of {}", options.join("|")),
        }),
        false,
    )
}

/// One key of an object schema; an optional key may be absent.
fn field(map: &Map<String, Value>, key: &str, optional: bool, check: impl Fn(Option<&Value>) -> Issues) -> Issues {
    let value = map.get(key);
    if optional && value.is_none() {
        return Vec::new();
    }
    at(check(value), json!(key))
}

fn object<'a>(value: &'a Value, check: impl Fn(&'a Map<String, Value>) -> Issues) -> Issues {
    match value {
        Value::Object(map) => check(map),
        other => found(invalid_type("object", Some(other)).json, false),
    }
}

fn rejection(issues: Issues) -> ToolError {
    let details: Vec<Value> = issues.into_iter().map(|issue| issue.json).collect();
    let first = details.first();
    let field = first
        .and_then(|issue| issue["path"].get(0))
        .map(|key| key.as_str().map_or_else(|| key.to_string(), str::to_string))
        .unwrap_or_default();
    let reason = first.and_then(|issue| issue["message"].as_str()).unwrap_or_default().to_string();
    let text = mixdog_js::json_stringify(&json!({ "error": "Invalid arguments", "details": details }));
    ToolError::new(ToolErrorCode::InvalidArgs { field, reason }, text)
}

/// JavaScript truthiness of a value that came through JSON.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub(super) struct FetchArgs {
    pub urls: Vec<String>,
    pub start_index: u64,
    pub max_length: Option<u64>,
}

/// `normalizeUrlArgs`: trims `url`, and drops blank entries of a list (and the key when none is left).
fn normalize_url_args(raw: &Value) -> Value {
    let Value::Object(map) = raw else {
        return raw.clone();
    };
    let mut args = map.clone();
    match args.get("url") {
        Some(Value::String(text)) => {
            let trimmed = mixdog_js::js_trim(text).to_string();
            args.insert("url".into(), Value::String(trimmed));
        }
        Some(Value::Array(items)) => {
            let kept: Vec<Value> = items
                .iter()
                .map(|item| match item {
                    Value::String(text) => Value::String(mixdog_js::js_trim(text).to_string()),
                    other => other.clone(),
                })
                .filter(|item| truthy(item))
                .collect();
            if kept.is_empty() {
                args.shift_remove("url");
            } else {
                args.insert("url".into(), Value::Array(kept));
            }
        }
        _ => {}
    }
    Value::Object(args)
}

fn whole(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_f64).map(|n| n as u64)
}

/// `urlArgsSchema.parse(normalizeUrlArgs(rawArgs || {}))` for `web_fetch`, `local_fetch` and `image_fetch`.
pub(super) fn fetch_args(raw: &Value) -> Result<FetchArgs, ToolError> {
    let empty = json!({});
    let args = normalize_url_args(if truthy(raw) { raw } else { &empty });
    let issues = object(&args, |map| {
        let mut issues = field(map, "url", false, |url| {
            union([
                string(url, false, true),
                array(url, true, |item| string(item, false, true)),
            ])
        });
        issues.extend(field(map, "startIndex", true, |v| int(v, 0, None)));
        issues.extend(field(map, "maxLength", true, |v| int(v, 0, None)));
        issues.extend(field(map, "cwd", true, |v| string(v, false, false)));
        issues
    });
    if !issues.is_empty() {
        return Err(rejection(issues));
    }
    let urls = match args.get("url") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(text)) => vec![text.clone()],
        _ => Vec::new(),
    };
    Ok(FetchArgs {
        urls,
        start_index: whole(&args, "startIndex").unwrap_or(0),
        max_length: whole(&args, "maxLength"),
    })
}

pub(super) struct SearchInput {
    /// `keywords` as given: one query, or a list.
    pub queries: Vec<String>,
    pub listed: bool,
    pub site: Option<String>,
    pub locale: Option<Value>,
    pub context_size: String,
    pub max_results: usize,
}

/// `normalizeWebSearchArgs`: trims the text fields and drops the blank ones.
fn normalize_search_args(raw: &Value) -> Value {
    let Value::Object(map) = raw else {
        return raw.clone();
    };
    let mut args = map.clone();
    for key in ["keywords", "site", "locale", "contextSize"] {
        if let Some(Value::String(text)) = args.get(key) {
            let trimmed = mixdog_js::js_trim(text).to_string();
            if trimmed.is_empty() {
                args.shift_remove(key);
            } else {
                args.insert(key.into(), Value::String(trimmed));
            }
        }
    }
    if let Some(Value::Array(items)) = args.get("keywords") {
        let trimmed: Vec<Value> = items
            .iter()
            .map(|item| match item {
                Value::String(text) => Value::String(mixdog_js::js_trim(text).to_string()),
                other => other.clone(),
            })
            .collect();
        args.insert("keywords".into(), Value::Array(trimmed));
    }
    Value::Object(args)
}

pub(super) const PATTERN_ONLY: &str = "Error: web search requires query; use glob(pattern=...) for file paths.";

/// `handleToolCall('web_search')` up to the schema: the `query` alias, then `webSearchArgsSchema`.
pub(super) fn search_args(raw: &Value) -> Result<SearchInput, ToolError> {
    let mut raw = raw.clone();
    if let Value::Object(map) = &mut raw {
        if map.contains_key("pattern") && !map.contains_key("query") && !map.contains_key("keywords") {
            return Err(ToolError::new(
                ToolErrorCode::InvalidArgs { field: "query".into(), reason: PATTERN_ONLY.into() },
                PATTERN_ONLY,
            ));
        }
        if !map.contains_key("keywords")
            && let Some(query) = map.shift_remove("query")
        {
            map.insert("keywords".into(), query);
        }
    }
    let empty = json!({});
    let args = normalize_search_args(if truthy(&raw) { &raw } else { &empty });
    let issues = object(&args, |map| {
        let mut issues = field(map, "keywords", false, |v| {
            union([string(v, true, false), array(v, true, |item| string(item, true, false))])
        });
        issues.extend(field(map, "site", true, |v| string(v, false, false)));
        issues.extend(field(map, "maxResults", true, |v| int(v, 1, Some(20))));
        issues.extend(field(map, "locale", true, |v| {
            union([
                string(v, false, false),
                match v {
                    Some(value) => object(value, |locale| {
                        let mut issues = Vec::new();
                        for key in ["country", "language", "region", "city", "timezone"] {
                            issues.extend(field(locale, key, true, |v| string(v, false, false)));
                        }
                        issues
                    }),
                    None => found(invalid_type("object", None).json, false),
                },
            ])
        }));
        issues.extend(field(map, "contextSize", true, |v| one_of(v, &["low", "medium", "high"])));
        issues
    });
    if !issues.is_empty() {
        return Err(rejection(issues));
    }
    let (queries, listed) = match args.get("keywords") {
        Some(Value::Array(items)) => (items.iter().filter_map(Value::as_str).map(str::to_string).collect(), true),
        Some(Value::String(text)) => (vec![text.clone()], false),
        _ => (Vec::new(), false),
    };
    Ok(SearchInput {
        queries,
        listed,
        site: args.get("site").and_then(Value::as_str).filter(|site| !site.is_empty()).map(str::to_string),
        locale: args.get("locale").filter(|locale| truthy(locale)).cloned(),
        context_size: args.get("contextSize").and_then(Value::as_str).unwrap_or("low").to_string(),
        max_results: whole(&args, "maxResults").map_or(10, |n| n as usize),
    })
}
