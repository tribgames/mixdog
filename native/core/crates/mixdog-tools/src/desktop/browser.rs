//! `browser` and `browser_devtools`: argument contract and dispatch over `host/browser/command`.
//! The page is driven by Electron; approvals and grants for submit/post/upload are decided by
//! the core's browser policy (`item/browser/requestApproval`), not here.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use serde_json::Map;
use serde_json::Value;

use super::host::BROWSER_UNAVAILABLE;
use super::host::HostCommands;
use super::host::browser_output;
use super::host::command_error;
use crate::orch::schema::value_error;
use crate::orch::util::JsStr;
use crate::orch::util::cancelled;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;

pub const MAX_REQUEST_BYTES: usize = 256 * 1024;

pub const DEVTOOLS_ACTIONS: [&str; 6] = ["emulate", "cookies", "storage", "intercept", "init_script", "performance"];
/// Actions that only observe the page, so a lost answer may be asked again.
pub const OBSERVATION_ACTIONS: [&str; 10] =
    ["snapshot", "read", "extract", "locate", "status", "console", "network", "list_tabs", "downloads", "wait"];
const SEQUENCE_STEP_ACTIONS: [&str; 8] = ["click", "fill", "type", "select", "hover", "press", "scroll", "wait"];

const PAGE_TARGET: [&str; 2] = ["tab", "background"];
const SNAPSHOT_FILTERS: [&str; 4] = ["query", "viewportOnly", "maxElements", "maxChars"];
const SCREENSHOT_OPTIONS: [&str; 4] = ["fullPage", "format", "quality", "image_output"];
const POST_ACTION: [&str; 3] = ["expect", "settleMs", "brief"];

/// One action's accepted input fields and the alternative groups of which one must be present.
struct Contract {
    action: &'static str,
    fields: Vec<&'static str>,
    required_any: Vec<Vec<&'static str>>,
}

fn post_action_snapshot() -> Vec<&'static str> {
    [&PAGE_TARGET[..], &SNAPSHOT_FILTERS, &["includeScreenshot"], &SCREENSHOT_OPTIONS, &POST_ACTION].concat()
}

fn with_post(extra: &[&'static str]) -> Vec<&'static str> {
    [post_action_snapshot(), extra.to_vec()].concat()
}

fn row(action: &'static str, fields: Vec<&'static str>, required_any: &[&[&'static str]]) -> Contract {
    Contract { action, fields, required_any: required_any.iter().map(|g| g.to_vec()).collect() }
}

fn contracts() -> Vec<Contract> {
    let page = PAGE_TARGET.to_vec();
    let pt = |extra: &[&'static str]| [page.clone(), extra.to_vec()].concat();
    vec![
        row("navigate", with_post(&["url", "reload"]), &[&["url"], &["reload"]]),
        row("snapshot", pt(&["query", "viewportOnly", "maxElements", "maxChars", "mode", "ref", "target", "fullPage", "format", "quality", "image_output", "settleMs"]), &[]),
        row("locate", pt(&["query", "limit"]), &[&["query"]]),
        row("evaluate", with_post(&["script", "ref", "timeoutMs", "maxChars"]), &[&["script"]]),
        row("emulate", with_post(&["width", "height", "deviceScaleFactor", "mobile", "touch", "userAgent", "locale", "timezone", "colorScheme", "reducedMotion", "networkProfile", "cpuThrottlingRate", "orientation", "latitude", "longitude", "accuracy", "headers", "reset"]), &[]),
        row("cookies", pt(&["operation", "url", "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expirationDate"]), &[]),
        row("storage", pt(&["operation", "storageType", "name", "value"]), &[]),
        row("performance", pt(&["operation", "reload", "saveTrace"]), &[]),
        row("click", with_post(&["ref", "target", "snapshotId", "x", "y", "pointer", "button", "modifiers", "doubleClick"]), &[&["ref"], &["target"], &["snapshotId", "x", "y"]]),
        row("fill", with_post(&["ref", "target", "text", "checked", "fields", "submit", "savedAccount", "sensitive"]), &[&["ref", "text"], &["target", "text"], &["ref", "checked"], &["target", "checked"], &["fields"], &["savedAccount"]]),
        row("type", with_post(&["ref", "target", "text", "submit"]), &[&["ref", "text"], &["target", "text"]]),
        row("select", with_post(&["ref", "target", "values"]), &[&["ref"], &["target"]]),
        row("hover", with_post(&["ref", "target", "snapshotId", "x", "y"]), &[&["ref"], &["target"], &["snapshotId", "x", "y"]]),
        row("drag", with_post(&["ref", "target", "targetRef", "dropTarget", "snapshotId", "x", "y", "targetX", "targetY", "pointer"]), &[&["ref", "targetRef"], &["target", "dropTarget"], &["snapshotId", "x", "y", "targetX", "targetY"]]),
        row("upload", with_post(&["ref", "target", "paths"]), &[&["paths"]]),
        row("handle_dialog", with_post(&["accept", "promptText"]), &[]),
        row("press", with_post(&["key"]), &[&["key"]]),
        row("scroll", with_post(&["ref", "target", "snapshotId", "x", "y", "dx", "dy", "text"]), &[]),
        row("back", post_action_snapshot(), &[]),
        row("sequence", with_post(&["steps"]), &[&["steps"]]),
        row("read", pt(&["query", "maxChars", "offset"]), &[]),
        row("extract", pt(&["selector", "attributes", "limit", "maxChars"]), &[&["selector"]]),
        row("wait", pt(&["query", "viewportOnly", "maxElements", "maxChars", "text", "textGone", "url", "timeoutMs"]), &[]),
        row("status", page.clone(), &[]),
        row("console", pt(&["level", "query", "limit"]), &[]),
        row("network", pt(&["requestId", "resourceTypes", "limit", "frameLimit", "maxChars", "query"]), &[]),
        row("intercept", pt(&["operation", "url", "resourceTypes", "abort", "body", "ruleId"]), &[]),
        row("init_script", pt(&["operation", "script", "scriptId"]), &[]),
        row("list_tabs", vec![], &[]),
        row("close_tab", vec!["tab"], &[&["tab"]]),
        row("downloads", vec!["downloadId", "wait", "attach", "timeoutMs"], &[]),
        row("open", page, &[]),
        row("hide", vec![], &[]),
    ]
}

fn has_value(input: &Map<String, Value>, name: &str) -> bool {
    input.get(name).is_some_and(|v| !v.is_null())
}

fn utf16_len(s: &str) -> usize {
    mixdog_js::utf16_len(s)
}

/// A parsed `browser` call: the action and its input object.
#[derive(Clone, PartialEq, Debug)]
pub struct BrowserCall {
    pub action: String,
    pub input: Map<String, Value>,
}

/// Validates a call of `tool` (`browser` or `browser_devtools`); `schema_fields` is the input
/// schema's `properties` object, whose `maxLength`s bound the string fields.
pub fn validate(tool: &str, args: &Value, schema_fields: &Map<String, Value>) -> Result<BrowserCall, String> {
    let object = args.as_object().ok_or("browser arguments must be an object")?;
    let action = object.get("action").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
    let table = contracts();
    let Some(contract) = table.iter().find(|c| c.action == action) else {
        let shown = if action.is_empty() { "(empty)" } else { action.as_str() };
        return Err(format!("unknown browser action \"{shown}\""));
    };
    let owner = if DEVTOOLS_ACTIONS.contains(&action.as_str()) { "browser_devtools" } else { "browser" };
    if !tool.is_empty() && tool != owner {
        return Err(format!("browser action \"{action}\" belongs to the {owner} tool; call {owner} with the same input"));
    }
    let input = resolve_input(&action, object)?;
    let unsupported: Vec<&str> = input.keys().map(String::as_str).filter(|k| !contract.fields.contains(k)).collect();
    if !unsupported.is_empty() {
        return Err(format!("browser action \"{action}\" does not accept input field(s): {}", unsupported.join(", ")));
    }
    bounded_fields(&action, &input, schema_fields)?;
    for field in ["target", "dropTarget"] {
        if let Some(spec) = input.get(field) {
            target_spec(spec, &format!("browser action \"{action}\" input.{field}"))?;
        }
    }
    if ["snapshot", "read", "wait"].contains(&action.as_str())
        && let Some(query) = input.get("query")
    {
        query_syntax(query, &format!("browser action \"{action}\" input.query"))?;
    }
    target_form(&action, contract, &input)?;
    action_rules(&action, &input)?;
    for (name, value) in &input {
        let schema = schema_fields.get(name).cloned().unwrap_or_else(|| Value::Object(Map::new()));
        if let Some(error) = value_error(value, &schema, &format!("browser action \"{action}\" input.{name}")) {
            return Err(error);
        }
    }
    Ok(BrowserCall { action, input })
}

/// The input nested under `input` (a JSON-object string is read as the object), or the root
/// fields of the flat shape. Root fields beside a nested input are refused.
fn resolve_input(action: &str, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let Some(nested) = args.get("input") else {
        return Ok(args.iter().filter(|(k, _)| k.as_str() != "action").map(|(k, v)| (k.clone(), v.clone())).collect());
    };
    let stray: Vec<&str> = args.keys().map(String::as_str).filter(|k| *k != "input" && *k != "action").collect();
    let parsed = match nested {
        Value::String(s) if s.js_trim_start().starts_with('{') => {
            serde_json::from_str::<Value>(s.js_trim()).ok().filter(Value::is_object).unwrap_or_else(|| nested.clone())
        }
        other => other.clone(),
    };
    let input = match parsed {
        Value::Null => Map::new(),
        Value::Object(o) => o,
        _ => return Err(format!("browser action \"{action}\" input must be an object")),
    };
    if !stray.is_empty() {
        return Err(format!("browser action \"{action}\" fields must be inside input: {}", stray.join(", ")));
    }
    Ok(input)
}

fn bounded_fields(action: &str, input: &Map<String, Value>, schema: &Map<String, Value>) -> Result<(), String> {
    for (name, def) in schema {
        if def.get("type").and_then(Value::as_str) != Some("string") {
            continue;
        }
        let Some(max) = def.get("maxLength").and_then(Value::as_u64) else { continue };
        let Some(value) = input.get(name) else { continue };
        let limit = if name == "script" && action == "init_script" { 20_000 } else { max as usize };
        if !value.as_str().is_some_and(|s| utf16_len(s) <= limit) {
            return Err(format!("browser action \"{action}\" input.{name} must be a string of at most {limit} characters"));
        }
    }
    for (name, count, item) in [("modifiers", 4, 20), ("paths", 10, 32_767), ("resourceTypes", 20, 40), ("values", 100, 4_096)] {
        let Some(value) = input.get(name) else { continue };
        let ok = value
            .as_array()
            .is_some_and(|a| a.len() <= count && a.iter().all(|v| v.as_str().is_some_and(|s| utf16_len(s) <= item)));
        if !ok {
            return Err(format!(
                "browser action \"{action}\" input.{name} requires at most {count} strings of at most {item} characters"
            ));
        }
    }
    Ok(())
}

/// Exactly one target form: a second complete form, or a field that belongs only to another
/// form, is a contradiction.
fn target_form(action: &str, c: &Contract, input: &Map<String, Value>) -> Result<(), String> {
    if c.required_any.is_empty() {
        return Ok(());
    }
    let matching: Vec<&Vec<&str>> = c.required_any.iter().filter(|g| g.iter().all(|n| has_value(input, n))).collect();
    let Some(first) = matching.first() else {
        let groups: Vec<String> = c.required_any.iter().map(|g| g.join("+")).collect();
        return Err(format!("browser action \"{action}\" requires input.{}", groups.join(" or input.")));
    };
    let stray = c
        .required_any
        .iter()
        .any(|g| !std::ptr::eq(g, *first) && g.iter().any(|n| input.contains_key(*n) && !first.contains(n)));
    if matching.len() > 1 || stray {
        return Err(format!("browser action \"{action}\" accepts only one input target form"));
    }
    Ok(())
}

type Rule = fn(&str, &Map<String, Value>) -> Result<(), String>;

/// Action-specific rules, in the order they are reported.
const RULES: [Rule; 14] = [
    navigate_rule,
    fill_fields_rule,
    sensitive_fill_rule,
    scroll_rule,
    screenshot_options_rule,
    snapshot_target_rule,
    screenshot_format_rule,
    touch_click_rule,
    sequence_rule,
    save_trace_rule,
    extract_rule,
    emulate_rule,
    expect_rule,
    rule_operation,
];

fn action_rules(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    RULES.iter().try_for_each(|rule| rule(action, input))
}

fn string_len(value: &str) -> usize {
    mixdog_js::utf16_len(value)
}

fn navigate_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action == "navigate" && !has_value(input, "url") && input.get("reload") != Some(&Value::Bool(true)) {
        return Err("browser action \"navigate\" requires input.url or input.reload=true".to_owned());
    }
    Ok(())
}

fn touch_click_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action == "click"
        && input.get("pointer").and_then(Value::as_str) == Some("touch")
        && (input.get("button").is_some() || input.get("modifiers").is_some() || input.get("doubleClick") == Some(&Value::Bool(true)))
    {
        return Err("browser action \"click\" pointer=touch does not accept button, modifiers, or doubleClick".to_owned());
    }
    Ok(())
}

fn save_trace_rule(_: &str, input: &Map<String, Value>) -> Result<(), String> {
    if input.contains_key("saveTrace")
        && !(input.get("saveTrace").is_some_and(Value::is_boolean) && input.get("operation").and_then(Value::as_str) == Some("start"))
    {
        return Err("performance saveTrace requires operation=start and a boolean".to_owned());
    }
    Ok(())
}

fn sequence_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action == "sequence" { sequence_steps(input.get("steps")) } else { Ok(()) }
}

/// A target names one element by role and/or accessible name, or by a CSS selector; the host
/// insists on exactly one match at dispatch time.
fn target_spec(spec: &Value, at: &str) -> Result<(), String> {
    let Some(spec) = spec.as_object() else {
        return Err(format!("{at} must be an object with role, name, and/or selector"));
    };
    let unsupported: Vec<&str> = spec.keys().map(String::as_str).filter(|k| !["role", "name", "selector", "exact", "nth"].contains(k)).collect();
    if !unsupported.is_empty() {
        return Err(format!("{at} does not accept field(s): {}", unsupported.join(", ")));
    }
    for (name, limit) in [("role", 60), ("name", 500), ("selector", 4_096)] {
        if let Some(v) = spec.get(name)
            && !v.as_str().is_some_and(|s| string_len(s) <= limit)
        {
            return Err(format!("{at}.{name} must be a string of at most {limit} characters"));
        }
    }
    if spec.get("exact").is_some_and(|v| !v.is_boolean()) {
        return Err(format!("{at}.exact must be a boolean"));
    }
    if spec.get("nth").is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=500).contains(&n))) {
        return Err(format!("{at}.nth must be an integer from 1 to 500"));
    }
    let present = |n: &str| spec.get(n).and_then(Value::as_str).is_some_and(|s| !s.js_trim().is_empty());
    if !present("role") && !present("name") && !present("selector") {
        return Err(format!("{at} requires role, name, and/or selector"));
    }
    if spec.get("exact") == Some(&Value::Bool(true)) && !present("name") {
        return Err(format!("{at}.exact applies to name"));
    }
    Ok(())
}

/// Keywords match with OR; `/pattern/` or `/pattern/i` is a regular expression and must
/// compile as an ECMAScript pattern (V8 reports the error). Other flags change matching semantics the page-side
/// matcher does not implement, so they are refused.
fn query_syntax(query: &Value, at: &str) -> Result<(), String> {
    let Some(q) = query.as_str() else { return Ok(()) };
    let q = q.js_trim();
    let Some(rest) = q.strip_prefix('/') else { return Ok(()) };
    let Some(close) = rest.rfind('/') else { return Ok(()) };
    let (body, flags) = (&rest[..close], &rest[close + 1..]);
    if body.is_empty() || !flags.chars().all(|c| c.is_ascii_lowercase()) {
        return Ok(());
    }
    if !flags.replace('i', "").is_empty() {
        return Err(format!("{at} regular expression accepts only the i flag"));
    }
    let engine_flags = if flags.contains('i') { "i" } else { "" };
    match mixdog_js::js_regex_error(body, engine_flags) {
        Some(message) => Err(format!("{at} regular expression is invalid: {message}")),
        None => Ok(()),
    }
}
fn fill_field_verdict(field: &Value, index: usize) -> Result<bool, String> {
    let at = format!("browser action \"fill\" input.fields[{index}]");
    let Some(field) = field.as_object() else { return Err(format!("{at} must be an object")) };
    let bad: Vec<&str> = field.keys().map(String::as_str).filter(|k| !["ref", "target", "text", "value", "values", "checked"].contains(k)).collect();
    if !bad.is_empty() {
        return Err(format!("{at} does not accept field(s): {}", bad.join(", ")));
    }
    let has_ref = field.get("ref").and_then(Value::as_str).is_some_and(|s| !s.js_trim().is_empty());
    let has_target = field.contains_key("target");
    if has_ref == has_target {
        return Err(format!("{at} requires ref or target, not both"));
    }
    if has_target {
        target_spec(&field["target"], &format!("{at}.target"))?;
    }
    let has_text = field.get("text").is_some_and(Value::is_string);
    let has_value = field.get("value").is_some_and(Value::is_string);
    let values = field.get("values").and_then(Value::as_array).filter(|v| !v.is_empty() && v.len() <= 100 && v.iter().all(Value::is_string));
    let has_checked = field.get("checked").is_some_and(Value::is_boolean);
    let payloads = usize::from(has_text || has_value) + usize::from(values.is_some()) + usize::from(has_checked);
    if payloads != 1 || (has_text && has_value) {
        return Err(format!("{at} requires exactly one of text/value, values, or checked"));
    }
    let long = |v: Option<&Value>, max: usize| v.and_then(Value::as_str).is_some_and(|s| string_len(s) > max);
    if (has_ref && long(field.get("ref"), 128))
        || long(field.get("text"), 100_000)
        || long(field.get("value"), 100_000)
        || values.is_some_and(|v| v.iter().any(|s| long(Some(s), 4_096)))
    {
        return Err(format!("{at} is too large"));
    }
    Ok(has_target)
}

fn fill_fields_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "fill" || !input.contains_key("fields") {
        return Ok(());
    }
    let fields = input["fields"].as_array().filter(|f| (1..=30).contains(&f.len()));
    let Some(fields) = fields else {
        return Err("browser action \"fill\" input.fields requires 1 to 30 items".to_owned());
    };
    let mut targeted = 0;
    for (i, field) in fields.iter().enumerate() {
        if fill_field_verdict(field, i)? {
            targeted += 1;
        }
    }
    // Targets resolve against one fresh observation that retires the caller's refs, so a batch
    // is addressed one way or the other.
    if targeted != 0 && targeted != fields.len() {
        return Err("browser action \"fill\" input.fields must use ref for every item or target for every item".to_owned());
    }
    Ok(())
}

/// A sensitive fill's text is kept out of every stored transcript at any length; an empty one
/// has nothing to protect and is refused.
fn sensitive_fill_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "fill" || input.get("sensitive") != Some(&Value::Bool(true)) {
        return Ok(());
    }
    let mut values = vec![input.get("text")];
    for field in input.get("fields").and_then(Value::as_array).into_iter().flatten() {
        values.push(field.get("text"));
        values.push(field.get("value"));
    }
    if values.into_iter().any(|v| v.and_then(Value::as_str).is_some_and(str::is_empty)) {
        return Err("browser action \"fill\" input.sensitive text must not be empty".to_owned());
    }
    Ok(())
}

fn screenshot_options_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    let touched = SCREENSHOT_OPTIONS.iter().any(|n| input.contains_key(*n));
    if action == "snapshot" && touched {
        let mode = input.get("mode").and_then(Value::as_str).unwrap_or("semantic");
        if mode == "semantic" {
            return Err("browser action \"snapshot\" screenshot options require input.mode=visual or input.mode=both".to_owned());
        }
        if input.get("fullPage") == Some(&Value::Bool(true)) && mode == "both" {
            return Err("browser action \"snapshot\" fullPage is inspection-only and requires input.mode=visual".to_owned());
        }
    } else if touched && input.get("includeScreenshot") != Some(&Value::Bool(true)) {
        return Err(format!("browser action \"{action}\" screenshot options require input.includeScreenshot=true"));
    }
    Ok(())
}

/// A snapshot target crops the image to that element; the document-sized and printed forms
/// have no element to crop.
fn snapshot_target_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "snapshot" || !(input.contains_key("ref") || input.contains_key("target")) {
        return Ok(());
    }
    if input.contains_key("ref") && input.contains_key("target") {
        return Err("browser action \"snapshot\" accepts only one input target form".to_owned());
    }
    if input.get("mode").and_then(Value::as_str).unwrap_or("semantic") != "visual" {
        return Err("browser action \"snapshot\" input.ref or input.target crops the image and requires input.mode=visual".to_owned());
    }
    if input.get("fullPage") == Some(&Value::Bool(true)) {
        return Err("browser action \"snapshot\" input.ref or input.target cannot be combined with fullPage".to_owned());
    }
    if input.get("format").and_then(Value::as_str) == Some("pdf") {
        return Err("browser action \"snapshot\" format=pdf prints the whole page; drop input.ref or input.target".to_owned());
    }
    Ok(())
}

fn screenshot_format_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    let format = input.get("format").and_then(Value::as_str);
    if format != Some("jpeg") && input.contains_key("quality") {
        return Err("browser screenshot input.quality is supported only with input.format=jpeg".to_owned());
    }
    if format == Some("pdf") {
        if action != "snapshot" || input.get("mode").and_then(Value::as_str).unwrap_or("semantic") != "visual" {
            return Err("browser format=pdf requires action \"snapshot\" with input.mode=visual".to_owned());
        }
        if input.contains_key("image_output") && input.get("image_output").and_then(Value::as_str) != Some("file") {
            return Err("browser format=pdf always writes a file; drop input.image_output".to_owned());
        }
    }
    Ok(())
}

fn extract_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "extract" {
        return Ok(());
    }
    if !input.get("selector").and_then(Value::as_str).is_some_and(|s| !s.js_trim().is_empty()) {
        return Err("browser action \"extract\" requires a non-empty input.selector".to_owned());
    }
    if let Some(names) = input.get("attributes") {
        let ok = names
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.len() <= 12 && a.iter().all(|n| n.as_str().is_some_and(|n| !n.js_trim().is_empty() && string_len(n) <= 60)));
        if !ok {
            return Err("browser action \"extract\" input.attributes requires 1 to 12 attribute names".to_owned());
        }
    }
    Ok(())
}

fn emulate_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "emulate" {
        return Ok(());
    }
    if has_value(input, "latitude") != has_value(input, "longitude") {
        return Err("browser action \"emulate\" geolocation requires input.latitude and input.longitude together".to_owned());
    }
    if input.contains_key("accuracy") && !has_value(input, "latitude") {
        return Err("browser action \"emulate\" input.accuracy requires latitude and longitude".to_owned());
    }
    if let Some(headers) = input.get("headers") {
        let ok = headers.as_object().is_some_and(|h| !h.is_empty() && h.len() <= 20 && h.values().all(Value::is_string));
        if !ok {
            return Err("browser action \"emulate\" input.headers requires 1 to 20 header names with string values".to_owned());
        }
    }
    Ok(())
}

fn expect_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    let Some(expected) = input.get("expect") else { return Ok(()) };
    let ok = expected.as_object().is_some_and(|e| {
        e.keys().all(|k| ["text", "textGone", "url", "timeoutMs"].contains(&k.as_str()))
            && ["text", "textGone", "url"].iter().all(|n| e.get(*n).is_none_or(|v| v.as_str().is_some_and(|s| string_len(s) <= 10_000)))
    });
    if ok { Ok(()) } else { Err(format!("browser action \"{action}\" input.expect is invalid or too large")) }
}
fn scroll_rule(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "scroll" {
        return Ok(());
    }
    let forms: [&[&str]; 4] = [&["ref"], &["target"], &["snapshotId", "x", "y"], &["text"]];
    let touched: Vec<&&[&str]> = forms.iter().filter(|f| f.iter().any(|n| input.contains_key(*n))).collect();
    if touched.len() > 1 {
        return Err("browser action \"scroll\" accepts only one input target form".to_owned());
    }
    if let Some(form) = touched.first()
        && !form.iter().all(|n| has_value(input, n))
    {
        return Err(format!("browser action \"scroll\" target requires input.{}", form.join("+")));
    }
    Ok(())
}

fn step_fields(step_action: &str) -> Option<(&'static [&'static str], &'static [&'static [&'static str]])> {
    Some(match step_action {
        "click" => (&["ref", "target"], &[&["ref"], &["target"]]),
        "fill" => (
            &["ref", "target", "text", "checked", "submit", "savedAccount"],
            &[&["ref", "text"], &["target", "text"], &["ref", "checked"], &["target", "checked"], &["savedAccount"]],
        ),
        "type" => (&["ref", "target", "text", "submit"], &[&["ref", "text"], &["target", "text"]]),
        "select" => (&["ref", "target", "values"], &[&["ref", "values"], &["target", "values"]]),
        "hover" => (&["ref", "target"], &[&["ref"], &["target"]]),
        "press" => (&["key"], &[&["key"]]),
        "scroll" => (&["ref", "target", "dx", "dy"], &[]),
        "wait" => (&["text", "textGone", "url", "timeoutMs"], &[&["text"], &["textGone"], &["url"]]),
        _ => return None,
    })
}

fn sequence_steps(steps: Option<&Value>) -> Result<(), String> {
    let steps = steps.and_then(Value::as_array).filter(|s| (2..=6).contains(&s.len()));
    let Some(steps) = steps else {
        return Err("browser action \"sequence\" input.steps requires 2 to 6 steps".to_owned());
    };
    for (index, step) in steps.iter().enumerate() {
        let at = format!("browser action \"sequence\" input.steps[{index}]");
        let Some(step) = step.as_object() else { return Err(format!("{at} must be an object")) };
        let step_action = step.get("action").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        let Some((allowed, required)) = step_fields(step_action) else {
            return Err(format!("{at} action must be one of {}", SEQUENCE_STEP_ACTIONS.join(", ")));
        };
        let bad: Vec<&str> = step.keys().map(String::as_str).filter(|k| *k != "action" && !allowed.contains(k)).collect();
        if !bad.is_empty() {
            return Err(format!("{at} does not accept field(s): {}", bad.join(", ")));
        }
        if !required.is_empty() && !required.iter().any(|g| g.iter().all(|n| has_value(step, n))) {
            let groups: Vec<String> = required.iter().map(|g| g.join("+")).collect();
            return Err(format!("{at} requires {}", groups.join(" or ")));
        }
        if has_value(step, "ref") && has_value(step, "target") {
            return Err(format!("{at} accepts ref or target, not both"));
        }
        if has_value(step, "savedAccount") && ["ref", "target", "text", "checked"].iter().any(|n| has_value(step, n)) {
            return Err(format!("{at} savedAccount fills the whole sign-in form; it takes no ref, target, text, or checked"));
        }
        if let Some(target) = step.get("target") {
            target_spec(target, &format!("{at}.target"))?;
        }
        if step_action == "select"
            && !step.get("values").and_then(Value::as_array).is_some_and(|v| !v.is_empty() && v.len() <= 100 && v.iter().all(Value::is_string))
        {
            return Err(format!("{at} values must be a non-empty array of strings"));
        }
        for (name, limit) in [("ref", 128), ("text", 100_000), ("textGone", 10_000), ("url", 8_192), ("key", 100)] {
            if let Some(v) = step.get(name)
                && !v.as_str().is_some_and(|s| string_len(s) <= limit)
            {
                return Err(format!("{at}.{name} must be a string of at most {limit} characters"));
            }
        }
        if step.get("values").and_then(Value::as_array).is_some_and(|v| v.iter().any(|s| s.as_str().is_some_and(|s| string_len(s) > 4_096))) {
            return Err(format!("{at}.values entries are limited to 4096 characters"));
        }
    }
    Ok(())
}

/// intercept / init_script: add, remove, list, clear over a rule or script.
fn rule_operation(action: &str, input: &Map<String, Value>) -> Result<(), String> {
    if action != "intercept" && action != "init_script" {
        return Ok(());
    }
    let operation = input.get("operation").and_then(Value::as_str).unwrap_or("list").js_trim().to_lowercase();
    if !["add", "remove", "list", "clear"].contains(&operation.as_str()) {
        return Err(format!("browser action \"{action}\" operation must be add, remove, list, or clear"));
    }
    let rule_fields: &[&str] = if action == "intercept" { &["url", "abort", "body", "resourceTypes"] } else { &["script"] };
    if operation != "add" {
        let stray: Vec<&str> = rule_fields.iter().copied().filter(|n| input.contains_key(*n)).collect();
        if !stray.is_empty() {
            return Err(format!("browser action \"{action}\" {operation} does not accept input field(s): {}", stray.join(", ")));
        }
    }
    let handle = if action == "intercept" { "ruleId" } else { "scriptId" };
    let handle_set = input.get(handle).and_then(Value::as_str).is_some_and(|s| !s.js_trim().is_empty());
    if operation == "remove" && !handle_set {
        return Err(format!("browser action \"{action}\" remove requires input.{handle} from an {action} list"));
    }
    if operation != "remove" && input.contains_key(handle) {
        return Err(format!("browser action \"{action}\" input.{handle} belongs to remove"));
    }
    if operation != "add" {
        return Ok(());
    }
    let nonblank = |n: &str| input.get(n).and_then(Value::as_str).is_some_and(|s| !s.js_trim().is_empty());
    if action == "init_script" && !nonblank("script") {
        return Err("browser action \"init_script\" add requires input.script".to_owned());
    }
    if action == "intercept" {
        if !nonblank("url") {
            return Err("browser action \"intercept\" add requires input.url, a wildcard pattern such as \"*/api/*\"".to_owned());
        }
        let abort = input.get("abort") == Some(&Value::Bool(true));
        let body = input.contains_key("body");
        if abort && body {
            return Err("browser action \"intercept\" add takes input.abort or input.body, not both".to_owned());
        }
        if !abort && !body {
            return Err("browser action \"intercept\" add requires input.abort=true or input.body".to_owned());
        }
    }
    Ok(())
}

pub struct BrowserTool {
    spec: ToolSpec,
    host: Arc<dyn HostCommands>,
    schema_fields: Map<String, Value>,
}

impl BrowserTool {
    pub fn browser(host: Arc<dyn HostCommands>) -> Self {
        Self::build(include_str!("defs/browser.json"), host)
    }

    pub fn devtools(host: Arc<dyn HostCommands>) -> Self {
        Self::build(include_str!("defs/browser_devtools.json"), host)
    }

    fn build(def: &'static str, host: Arc<dyn HostCommands>) -> Self {
        let spec = spec_from_def(def, false, &["browser"]);
        let schema_fields = spec.input_schema["properties"]["input"]["properties"].as_object().cloned().unwrap_or_default();
        Self { spec, host, schema_fields }
    }
}

#[async_trait]
impl Tool for BrowserTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let call = validate(&self.spec.name, &args, &self.schema_fields).map_err(|m| invalid("input", m))?;
        let input = Value::Object(call.input);
        if input.to_string().len() > MAX_REQUEST_BYTES {
            return Err(invalid("input", format!("browser command exceeds {MAX_REQUEST_BYTES} bytes")));
        }
        let answer = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(cancelled()),
            r = self.host.browser(&ctx.thread_id, &call.action, input) => r,
        };
        match answer {
            Ok(value) => browser_output(&value),
            Err(error) => Err(command_error(BROWSER_UNAVAILABLE, error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn check(tool: &str, args: Value) -> Result<BrowserCall, String> {
        validate(tool, &args, &Map::new())
    }

    /// Golden twin: `golden/browser_validate.json` is `validateBrowserToolArgs` of today's Node
    /// product on 65 calls; the verdict and the exact error text (what the model reads) must match.
    #[test]
    fn validation_equals_the_recorded_node_verdicts() {
        let golden: Vec<Value> = serde_json::from_str(include_str!("golden/browser_validate.json")).expect("golden");
        let fields = |def: &'static str| {
            let spec = spec_from_def(def, false, &[]);
            spec.input_schema["properties"]["input"]["properties"].as_object().cloned().unwrap_or_default()
        };
        let browser = fields(include_str!("defs/browser.json"));
        let devtools = fields(include_str!("defs/browser_devtools.json"));
        for case in golden {
            let tool = case["tool"].as_str().unwrap();
            let schema = if tool == "browser" { &browser } else { &devtools };
            let got = validate(tool, &case["args"], schema);
            let want = case["error"].as_str();
            assert_eq!(got.as_ref().err().map(String::as_str), want, "{} {}", tool, case["args"]);
        }
    }

    #[test]
    fn query_regex_is_compile_checked_like_the_page_engine() {
        assert!(check("browser", json!({"action":"wait","input":{"query":"/a+(b|c)/i"}})).is_ok());
        assert!(check("browser", json!({"action":"wait","input":{"query":"/[a-z]+(?=x)/"}})).is_ok());
        let err = check("browser", json!({"action":"wait","input":{"query":"/(/"}})).unwrap_err();
        assert_eq!(err, "browser action \"wait\" input.query regular expression is invalid: Invalid regular expression: /(/: Unterminated group");
        assert_eq!(
            check("browser", json!({"action":"read","input":{"query":"/a/g"}})).unwrap_err(),
            "browser action \"read\" input.query regular expression accepts only the i flag"
        );
    }

    #[test]
    fn action_belongs_to_one_tool() {
        assert_eq!(
            check("browser", json!({"action":"cookies"})).unwrap_err(),
            "browser action \"cookies\" belongs to the browser_devtools tool; call browser_devtools with the same input"
        );
        assert_eq!(check("browser", json!({"action":"nope"})).unwrap_err(), "unknown browser action \"nope\"");
    }

    #[test]
    fn target_forms_and_nesting() {
        assert!(check("browser", json!({"action":"click","input":{"ref":"e1"}})).is_ok());
        assert_eq!(
            check("browser", json!({"action":"click","input":{}})).unwrap_err(),
            "browser action \"click\" requires input.ref or input.target or input.snapshotId+x+y"
        );
        assert_eq!(
            check("browser", json!({"action":"click","input":{"ref":"e1","target":{"role":"b"}}})).unwrap_err(),
            "browser action \"click\" accepts only one input target form"
        );
        assert_eq!(
            check("browser", json!({"action":"navigate","url":"https://a","input":{"url":"https://b"}})).unwrap_err(),
            "browser action \"navigate\" fields must be inside input: url"
        );
        assert_eq!(
            check("browser", json!({"action":"press","input":{"key":"A","bogus":1}})).unwrap_err(),
            "browser action \"press\" does not accept input field(s): bogus"
        );
    }

    #[test]
    fn sequence_needs_two_to_six_valid_steps() {
        assert_eq!(
            check("browser", json!({"action":"sequence","input":{"steps":[{"action":"press","key":"a"}]}})).unwrap_err(),
            "browser action \"sequence\" input.steps requires 2 to 6 steps"
        );
        assert_eq!(
            check("browser", json!({"action":"sequence","input":{"steps":[{"action":"press","key":"a"},{"action":"click"}]}})).unwrap_err(),
            "browser action \"sequence\" input.steps[1] requires ref or target"
        );
    }

    #[test]
    fn intercept_rules() {
        assert_eq!(
            check("browser_devtools", json!({"action":"intercept","input":{"operation":"add","url":"*/a"}})).unwrap_err(),
            "browser action \"intercept\" add requires input.abort=true or input.body"
        );
        assert!(check("browser_devtools", json!({"action":"intercept"})).is_ok());
    }
}
