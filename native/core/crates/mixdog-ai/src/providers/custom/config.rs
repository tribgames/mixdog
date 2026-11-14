//! `normalizeCustomProviderConfig` (`custom-provider-config.mjs`): the secret-free schema-v2
//! config of a custom provider, from a stored entry or a setup input. Pure, and Node-exact down
//! to the text of each refusal (`[custom-provider] <message>`), because the setup UI shows it.
//!
//! The reasoning, header and request-body rules of the parent module are the builder's lenient
//! reading of an already-saved entry; this is the validating side a save runs, and the reading the
//! builder takes an entry's model overrides from (`createCustomProvider`).

use super::reasoning::canonical_level;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Obj = Map<String, Value>;
type Checked<T> = Result<T, String>;

pub const SCHEMA_VERSION: i64 = 2;
const PROTOCOLS: [&str; 3] = ["openai-chat", "openai-responses", "anthropic"];
const AUTH_MODES: [&str; 2] = ["key", "none"];
const WIRE_FORMATS: [&str; 4] = ["standard", "deepseek", "together", "vllm"];
/// The wires a custom endpoint can serve, in the order a stored list keeps.
const WIRES: [&str; 3] = ["chat", "responses", "messages"];
/// Ranked weakest to strongest.
const LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const OVERRIDE_LIMIT: usize = 500;
const HEADER_LIMIT: usize = 64;
const REQUEST_BODY_MAX_CHARS: usize = 16384;
const MAX_MODEL_ID: usize = 256;
const MAX_NAME: usize = 200;
const MAX_WIRE_VALUE: usize = 64;
const MAX_HEADER_TEXT: usize = 4096;
const MAX_BASE_URL: usize = 2048;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const UNSAFE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const AUTH_HEADERS: [&str; 3] = ["authorization", "x-api-key", "api-key"];
/// Transport headers the HTTP client owns; model-level headers may not set them.
pub const MODEL_REFUSED_HEADERS: [&str; 6] =
    ["content-type", "content-length", "host", "connection", "transfer-encoding", "proxy-authorization"];
const RESERVED_BODY_KEYS: [&str; 17] = [
    "model",
    "messages",
    "input",
    "system",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "stream_options",
    "previous_response_id",
    "store",
    "include",
    "prompt_cache_key",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
];
const OVERRIDE_KEYS: [&str; 9] = [
    "manual",
    "hidden",
    "name",
    "contextWindow",
    "maxOutputTokens",
    "supportsVision",
    "reasoning",
    "requestBody",
    "requestHeaders",
];
const REASONING_KEYS: [&str; 4] = ["levels", "wireFormat", "wireValues", "replay"];
const DISCOVERY_KEYS: [&str; 1] = ["newModelsHidden"];
/// v2 config fields plus the transport fields callers pass alongside them.
const V2_TOP_LEVEL_KEYS: [&str; 17] = [
    "type",
    "schemaVersion",
    "name",
    "protocol",
    "baseURL",
    "enabled",
    "auth",
    "discovery",
    "modelOverrides",
    "wires",
    "modelWires",
    "headers",
    "requestBody",
    "id",
    "apiKey",
    "apiKeyEnv",
    "preconnect",
];

fn fail<T>(message: impl AsRef<str>) -> Checked<T> {
    Err(format!("[custom-provider] {}", message.as_ref()))
}

/// `CUSTOM_API_KEY_ENV_RE`.
pub fn is_api_key_env(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned()
}

fn has_control(value: &str) -> bool {
    value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn bounded_text(value: Option<&Value>, label: &str, max: usize) -> Checked<String> {
    let Some(raw) = value.and_then(Value::as_str) else { return fail(format!("{label} must be a string")) };
    let out = js_trim(raw);
    if utf16_len(out) > max {
        return fail(format!("{label} must be at most {max} characters"));
    }
    if has_control(out) {
        return fail(format!("{label} must not contain control characters"));
    }
    Ok(out.to_owned())
}

fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

fn int_value(n: f64) -> Value {
    json!(n as i64)
}

/// Legacy (unversioned) input stays tolerant: blank is unset, numeric strings are numbers; an
/// integer beyond the safe range is dropped.
fn lenient_positive_int(value: Option<&Value>, label: &str) -> Checked<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() || value.as_str() == Some("") {
        return Ok(None);
    }
    let n = to_number(value);
    if !is_integer(n) || n <= 0.0 {
        return fail(format!("{label} must be a positive integer"));
    }
    Ok((n <= SAFE_INTEGER).then(|| int_value(n)))
}

/// v2: a JSON number that is a safe positive integer, or absent.
fn strict_positive_int(value: Option<&Value>, label: &str) -> Checked<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    match value.as_f64().filter(|_| value.is_number()) {
        Some(n) if is_integer(n) && n.abs() <= SAFE_INTEGER && n > 0.0 => Ok(Some(int_value(n))),
        _ => fail(format!("{label} must be a positive integer")),
    }
}

fn only_known_keys(value: &Obj, allowed: &[&str], label: &str) -> Checked<()> {
    match value.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => fail(format!("{label} has unsupported field: {key}")),
        None => Ok(()),
    }
}

fn optional_boolean(value: Option<&Value>, label: &str) -> Checked<Option<bool>> {
    match value {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => fail(format!("{label} must be a boolean")),
    }
}

fn assert_safe_base_url(raw: &str) -> Checked<()> {
    let Ok(parsed) = url::Url::parse(raw) else { return Err("[provider:custom] invalid baseURL".into()) };
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("[provider:custom] baseURL scheme not allowed: {scheme}: (only http/https)"));
    }
    if scheme == "http" {
        let host = parsed.host_str().unwrap_or_default().to_lowercase();
        if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
            return Err(format!(
                "[provider:custom] baseURL must use https for non-localhost host (got http://{host})"
            ));
        }
    }
    Ok(())
}

fn normalize_base_url(raw: Option<&Value>) -> Checked<String> {
    let value = text(raw);
    if value.is_empty() {
        return fail("baseURL is required");
    }
    if utf16_len(&value) > MAX_BASE_URL {
        return fail(format!("baseURL must be at most {MAX_BASE_URL} characters"));
    }
    let Ok(url) = url::Url::parse(&value) else { return fail(format!("invalid baseURL: {value}")) };
    if url.scheme() != "https" && url.scheme() != "http" {
        return fail("baseURL must use http or https");
    }
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return fail("baseURL must not embed credentials");
    }
    if url.query().is_some() || url.fragment().is_some() || value.contains(['?', '#']) {
        return fail("baseURL must not contain a query or hash");
    }
    let stripped = value.trim_end_matches('/').to_owned();
    assert_safe_base_url(&stripped)?;
    Ok(stripped)
}

fn model_id_key(raw: &str, label: &str) -> Checked<String> {
    if js_trim(raw).is_empty() {
        return fail(format!("every {label} must be a non-empty string"));
    }
    if raw != js_trim(raw) {
        let mut quoted = String::new();
        mixdog_js::json_quote(raw, &mut quoted);
        return fail(format!("{label} must not have surrounding whitespace: {quoted}"));
    }
    if utf16_len(raw) > MAX_MODEL_ID {
        return fail(format!("{label} must be at most {MAX_MODEL_ID} characters"));
    }
    if has_control(raw) {
        return fail(format!("{label} must not contain control characters"));
    }
    if UNSAFE_KEYS.contains(&raw) {
        return fail(format!("unsafe {label}: {raw}"));
    }
    Ok(raw.to_owned())
}

/// `canonicalReasoningLevel`: the canonical level for a string (alias-aware), else `None`.
pub fn canonical_reasoning_level(raw: &Value) -> Option<&'static str> {
    raw.as_str().and_then(canonical_level)
}

fn rank(level: &str) -> usize {
    LEVELS.iter().position(|l| *l == level).unwrap_or(usize::MAX)
}

fn normalize_levels(raw: &Value, label: &str) -> Checked<Vec<&'static str>> {
    let Some(items) = raw.as_array() else { return fail(format!("{label} must be an array")) };
    let mut seen: Vec<&'static str> = Vec::new();
    for entry in items {
        let Some(level) = canonical_reasoning_level(entry) else {
            return fail(format!("{label} has unknown level: {}", value_to_string(entry)));
        };
        if seen.contains(&level) {
            return fail(format!("{label} has duplicate level: {level}"));
        }
        seen.push(level);
    }
    seen.sort_by_key(|level| rank(level));
    Ok(seen)
}

/// `levels` (canonical) ties every key to a declared level; `None` skips the tie.
fn normalize_wire_values(raw: &Value, label: &str, levels: Option<&[&str]>) -> Checked<Obj> {
    let Some(object) = raw.as_object() else { return fail(format!("{label}.wireValues must be an object")) };
    let mut found: Vec<(&'static str, String)> = Vec::new();
    for (key, value) in object {
        let Some(level) = canonical_level(key) else {
            return fail(format!("{label}.wireValues has unknown level: {key}"));
        };
        if levels.is_some_and(|declared| !declared.contains(&level)) {
            return fail(format!("{label}.wireValues level {level} is not in levels"));
        }
        if found.iter().any(|(seen, _)| *seen == level) {
            return fail(format!("{label}.wireValues has duplicate level: {level}"));
        }
        let wire = bounded_text(Some(value), &format!("{label}.wireValues.{level}"), MAX_WIRE_VALUE)?;
        if wire.is_empty() {
            return fail(format!("{label}.wireValues.{level} must be non-empty"));
        }
        found.push((level, wire));
    }
    found.sort_by_key(|(level, _)| rank(level));
    Ok(found.into_iter().map(|(level, wire)| (level.to_owned(), Value::String(wire))).collect())
}

fn normalize_reasoning(raw: &Value, label: &str, protocol: &str) -> Checked<Obj> {
    let Some(object) = raw.as_object() else { return fail(format!("{label} must be an object")) };
    only_known_keys(object, &REASONING_KEYS, label)?;
    let mut out = Obj::new();
    let mut declared: Option<Vec<&'static str>> = None;
    if let Some(levels) = object.get("levels") {
        let levels = normalize_levels(levels, &format!("{label}.levels"))?;
        out.insert("levels".into(), json!(levels));
        declared = Some(levels);
    }
    if let Some(raw_format) = object.get("wireFormat") {
        let format = text(Some(raw_format));
        if !WIRE_FORMATS.contains(&format.as_str()) {
            return fail(format!("{label}.wireFormat is invalid: {}", value_to_string(raw_format)));
        }
        if format == "deepseek" && protocol != "openai-chat" {
            return fail(format!("{label}.wireFormat 'deepseek' requires protocol 'openai-chat'"));
        }
        out.insert("wireFormat".into(), json!(format));
    }
    if let Some(values) = object.get("wireValues") {
        out.insert("wireValues".into(), Value::Object(normalize_wire_values(values, label, declared.as_deref())?));
    }
    if let Some(replay) = optional_boolean(object.get("replay"), &format!("{label}.replay"))? {
        out.insert("replay".into(), json!(replay));
    }
    Ok(out)
}

/// `assertCustomReasoningPatch`: the shape check of a tri-state reasoning patch (`null`
/// deletes a field), minus the levels-to-wireValues tie the caller settles after merging.
pub fn assert_reasoning_patch(raw: &Value) -> Checked<()> {
    let label = "reasoning patch";
    let Some(object) = raw.as_object() else { return fail(format!("{label} must be an object")) };
    only_known_keys(object, &REASONING_KEYS, label)?;
    let supplied = |key: &str| object.get(key).filter(|value| !value.is_null());
    if let Some(levels) = supplied("levels") {
        normalize_levels(levels, &format!("{label}.levels"))?;
    }
    if let Some(format) = supplied("wireFormat")
        && !WIRE_FORMATS.contains(&text(Some(format)).as_str())
    {
        return fail(format!("{label}.wireFormat is invalid: {}", value_to_string(format)));
    }
    if let Some(values) = supplied("wireValues") {
        normalize_wire_values(values, label, None)?;
    }
    if let Some(replay) = supplied("replay") {
        optional_boolean(Some(replay), &format!("{label}.replay"))?;
    }
    Ok(())
}

fn normalize_headers(raw: Option<&Value>, label: &str, refused: &[&str]) -> Checked<Obj> {
    let Some(raw) = raw else { return Ok(Obj::new()) };
    let Some(object) = raw.as_object() else {
        return fail(format!("{label} must be an object of header names to string values"));
    };
    if object.len() > HEADER_LIMIT {
        return fail(format!("at most {HEADER_LIMIT} {label} are allowed"));
    }
    let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
    let mut seen: Vec<String> = Vec::new();
    let mut out = Obj::new();
    for (name, value) in object {
        if utf16_len(name) > MAX_HEADER_TEXT || name.is_empty() || !name.chars().all(token) {
            let mut quoted = String::new();
            mixdog_js::json_quote(&slice_utf16(name, 64), &mut quoted);
            return fail(format!("{label} has an invalid header name: {quoted}"));
        }
        let lower = name.to_ascii_lowercase();
        if AUTH_HEADERS.contains(&lower.as_str()) {
            return fail(format!("{label} must not set {name}: authentication belongs to the API key field"));
        }
        if refused.contains(&lower.as_str()) {
            return fail(format!("{label} must not set {name}: the app owns this header"));
        }
        if seen.contains(&lower) {
            return fail(format!("{label} has duplicate header: {name}"));
        }
        seen.push(lower);
        let Some(text) = value.as_str() else { return fail(format!("{label}.{name} must be a string")) };
        let visible = |c: char| c == '\t' || ('\u{20}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c);
        if !text.chars().all(visible) {
            return fail(format!("{label}.{name} has an invalid value"));
        }
        let trimmed = text.trim_matches([' ', '\t']);
        if utf16_len(trimmed) > MAX_HEADER_TEXT {
            return fail(format!("{label}.{name} has an invalid value"));
        }
        out.insert(name.clone(), Value::String(trimmed.to_owned()));
    }
    Ok(out)
}

/// Extra JSON request fields: a shallow object, size-capped; the keys the app builds the
/// request from can never be set. The size is Node's `JSON.stringify(raw).length`: each of the
/// `lone_units` lone surrogates the client's body held (read as U+FFFD, one unit here) is the
/// six units of its `\udXXX` escape there.
fn normalize_request_body(raw: Option<&Value>, label: &str, lone_units: usize) -> Checked<Obj> {
    let Some(raw) = raw else { return Ok(Obj::new()) };
    let Some(object) = raw.as_object() else { return fail(format!("{label} must be a JSON object")) };
    let size = utf16_len(&mixdog_js::json_stringify(raw)) + 5 * lone_units;
    if size > REQUEST_BODY_MAX_CHARS {
        return fail(format!("{label} must be at most {REQUEST_BODY_MAX_CHARS} characters"));
    }
    for key in object.keys() {
        if UNSAFE_KEYS.contains(&key.as_str()) {
            return fail(format!("{label} has an unsafe key: {key}"));
        }
        if RESERVED_BODY_KEYS.contains(&key.as_str()) {
            return fail(format!("{label} must not set {key}: the app owns this field"));
        }
    }
    Ok(object.clone())
}

/// `legacy` marks overrides generated from an unversioned config, whose tolerant value rules
/// are kept; everything else is v2-strict.
fn normalize_override(id: &str, raw: &Value, protocol: &str, legacy: bool) -> Checked<Obj> {
    let label = format!("modelOverrides[{id}]");
    let Some(object) = raw.as_object() else { return fail(format!("{label} must be an object")) };
    only_known_keys(object, &OVERRIDE_KEYS, &label)?;
    let positive = |key: &str| {
        let at = format!("{label}.{key}");
        if legacy { lenient_positive_int(object.get(key), &at) } else { strict_positive_int(object.get(key), &at) }
    };
    let mut out = Obj::new();
    if optional_boolean(object.get("manual"), &format!("{label}.manual"))? == Some(true) {
        out.insert("manual".into(), json!(true));
    }
    if let Some(hidden) = optional_boolean(object.get("hidden"), &format!("{label}.hidden"))? {
        out.insert("hidden".into(), json!(hidden));
    }
    if let Some(raw_name) = object.get("name") {
        let name = bounded_text(Some(raw_name), &format!("{label}.name"), MAX_NAME)?;
        if name.is_empty() && !legacy {
            return fail(format!("{label}.name must be non-empty"));
        }
        if !name.is_empty() {
            out.insert("name".into(), json!(name));
        }
    }
    if let Some(window) = positive("contextWindow")? {
        out.insert("contextWindow".into(), window);
    }
    if let Some(tokens) = positive("maxOutputTokens")? {
        out.insert("maxOutputTokens".into(), tokens);
    }
    if let Some(vision) = optional_boolean(object.get("supportsVision"), &format!("{label}.supportsVision"))? {
        out.insert("supportsVision".into(), json!(vision));
    }
    if let Some(raw_reasoning) = object.get("reasoning") {
        let reasoning = normalize_reasoning(raw_reasoning, &format!("{label}.reasoning"), protocol)?;
        if !reasoning.is_empty() {
            out.insert("reasoning".into(), Value::Object(reasoning));
        }
    }
    let body = normalize_request_body(object.get("requestBody"), &format!("{label}.requestBody"), 0)?;
    if !body.is_empty() {
        out.insert("requestBody".into(), Value::Object(body));
    }
    let headers =
        normalize_headers(object.get("requestHeaders"), &format!("{label}.requestHeaders"), &MODEL_REFUSED_HEADERS)?;
    if !headers.is_empty() {
        out.insert("requestHeaders".into(), Value::Object(headers));
    }
    Ok(out)
}

fn normalize_overrides(raw: Option<&Value>, protocol: &str, legacy: bool) -> Checked<Obj> {
    let Some(raw) = raw else { return Ok(Obj::new()) };
    let Some(object) = raw.as_object() else { return fail("modelOverrides must be an object") };
    if object.len() > OVERRIDE_LIMIT {
        return fail(format!("at most {OVERRIDE_LIMIT} model overrides are allowed"));
    }
    let mut out = Obj::new();
    for (key, value) in object {
        let id = model_id_key(key, "modelOverrides key")?;
        out.insert(id.clone(), Value::Object(normalize_override(&id, value, protocol, legacy)?));
    }
    Ok(out)
}

/// The wire each protocol speaks.
pub fn protocol_wire(protocol: &str) -> &'static str {
    match protocol {
        "openai-chat" => "chat",
        "openai-responses" => "responses",
        _ => "messages",
    }
}

/// The wires the endpoint serves (the protocol's own included); `None` is the protocol's wire only.
fn normalize_wires(raw: Option<&Value>, protocol: &str) -> Checked<Option<Vec<&'static str>>> {
    let Some(raw) = raw else { return Ok(None) };
    if protocol == "anthropic" {
        return fail("wires requires an 'openai-chat' or 'openai-responses' protocol");
    }
    let Some(items) = raw.as_array().filter(|items| !items.is_empty()) else {
        return fail("wires must be a non-empty array");
    };
    let mut seen: Vec<&'static str> = Vec::new();
    for wire in items {
        let Some(known) = wire.as_str().and_then(|w| WIRES.iter().find(|k| **k == w)) else {
            return fail(format!("wires has unsupported wire: {}", value_to_string(wire)));
        };
        if seen.contains(known) {
            return fail(format!("wires has duplicate wire: {known}"));
        }
        seen.push(known);
    }
    if !seen.contains(&protocol_wire(protocol)) {
        return fail(format!("wires must include the protocol wire: {}", protocol_wire(protocol)));
    }
    Ok(Some(WIRES.iter().copied().filter(|wire| seen.contains(wire)).collect()))
}

/// Per-model wire override, each one of the served wires.
fn normalize_model_wires(raw: Option<&Value>, protocol: &str, wires: Option<&[&str]>) -> Checked<Obj> {
    let Some(raw) = raw else { return Ok(Obj::new()) };
    if protocol == "anthropic" {
        return fail("modelWires requires an 'openai-chat' or 'openai-responses' protocol");
    }
    let Some(object) = raw.as_object() else { return fail("modelWires must be an object") };
    if object.len() > OVERRIDE_LIMIT {
        return fail(format!("at most {OVERRIDE_LIMIT} model wires are allowed"));
    }
    let own = [protocol_wire(protocol)];
    let served: &[&str] = wires.unwrap_or(&own);
    let mut out = Obj::new();
    for (key, wire) in object {
        let id = model_id_key(key, "modelWires key")?;
        if !wire.as_str().is_some_and(|w| served.contains(&w)) {
            return fail(format!("modelWires[{id}] must be one of the served wires: {}", served.join(", ")));
        }
        out.insert(id, wire.clone());
    }
    Ok(out)
}

/// Legacy (pre-v2) `models: [{ id, name?, contextWindow?, maxOutputTokens? }]` become manual,
/// visible overrides; their presence hides newly discovered ids.
fn migrate_legacy(input: &Obj) -> Checked<Obj> {
    let models: Vec<Value> = match input.get("models") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return fail("models must be an array"),
    };
    if models.len() > OVERRIDE_LIMIT {
        return fail(format!("at most {OVERRIDE_LIMIT} models are allowed"));
    }
    let mut overrides = Obj::new();
    for entry in &models {
        let id = model_id_key(&text(entry.get("id")), "model id")?;
        if overrides.contains_key(&id) {
            return fail(format!("duplicate model id: {id}"));
        }
        let mut row = Obj::new();
        row.insert("manual".into(), json!(true));
        row.insert("hidden".into(), json!(false));
        let name = text(entry.get("name"));
        if !name.is_empty() {
            row.insert("name".into(), json!(name));
        }
        for key in ["contextWindow", "maxOutputTokens"] {
            if let Some(value) = entry.get(key) {
                row.insert(key.into(), value.clone());
            }
        }
        overrides.insert(id, Value::Object(row));
    }
    let mut out = input.clone();
    let auth = input.get("auth").filter(|auth| !auth.is_null()).cloned().unwrap_or_else(|| json!("key"));
    out.insert("auth".into(), auth);
    out.insert("discovery".into(), json!({ "newModelsHidden": !models.is_empty() }));
    out.insert("modelOverrides".into(), Value::Object(overrides));
    Ok(out)
}

/// Normalized, secret-free v2 config. Legacy (no `schemaVersion`) input is migrated
/// deterministically; unknown future versions are rejected. `Err` is the message Node throws.
pub fn normalize(input: &Value) -> Checked<Value> {
    normalize_input(input, 0)
}

/// [`normalize`] of a client's input whose top-level `requestBody` held `body_lone_units` lone
/// surrogates (`CallContext::lone_surrogates`), each measured as Node measures it.
pub fn normalize_input(input: &Value, body_lone_units: usize) -> Checked<Value> {
    let Some(input) = input.as_object() else { return fail("config must be an object") };
    let version = input.get("schemaVersion").filter(|version| !version.is_null());
    let legacy = version.is_none();
    let source = match version {
        None => {
            if input.contains_key("modelOverrides") || input.contains_key("discovery") {
                return fail("modelOverrides and discovery require schemaVersion 2");
            }
            if input.contains_key("wires") || input.contains_key("modelWires") {
                return fail("wires and modelWires require schemaVersion 2");
            }
            if input.contains_key("headers") {
                return fail("headers require schemaVersion 2");
            }
            if input.contains_key("requestBody") {
                return fail("requestBody requires schemaVersion 2");
            }
            migrate_legacy(input)?
        }
        Some(version) => {
            let number = version.as_f64().filter(|_| version.is_number());
            if let Some(n) = number.filter(|n| is_integer(*n) && *n > SCHEMA_VERSION as f64) {
                return fail(format!("unsupported schemaVersion {}; update mixdog to use this provider", n as i64));
            }
            if number != Some(SCHEMA_VERSION as f64) {
                return fail(format!("invalid schemaVersion: {}", value_to_string(version)));
            }
            // v2 top level is strict: no unknown fields, exact enum strings, boolean `enabled`.
            only_known_keys(input, &V2_TOP_LEVEL_KEYS, "config")?;
            if let Some(kind) = input.get("type")
                && kind.as_str() != Some("custom")
            {
                return fail(format!("invalid type: {}", value_to_string(kind)));
            }
            if let Some(protocol) = input.get("protocol") {
                let Some(protocol) = protocol.as_str() else { return fail("protocol must be a string") };
                if protocol != js_trim(protocol) {
                    return fail(format!("unsupported protocol: {protocol}"));
                }
            }
            if let Some(auth) = input.get("auth")
                && !auth.as_str().is_some_and(|auth| AUTH_MODES.contains(&auth))
            {
                return fail(format!("invalid auth: {}", value_to_string(auth)));
            }
            optional_boolean(input.get("enabled"), "enabled")?;
            optional_boolean(input.get("preconnect"), "preconnect")?;
            input.clone()
        }
    };
    let name = match source.get("name").filter(|name| !name.is_null()) {
        Some(name) => bounded_text(Some(name), "name", MAX_NAME)?,
        None => String::new(),
    };
    if name.is_empty() {
        return fail("name is required");
    }
    let protocol = text(source.get("protocol"));
    if protocol.is_empty() {
        return fail("protocol is required");
    }
    if !PROTOCOLS.contains(&protocol.as_str()) {
        return fail(format!("unsupported protocol: {protocol}"));
    }
    let auth = match source.get("auth") {
        None | Some(Value::Null) => "key".to_owned(),
        auth => text(auth),
    };
    if !AUTH_MODES.contains(&auth.as_str()) {
        return fail(format!("invalid auth: {}", source.get("auth").map(value_to_string).unwrap_or_default()));
    }
    let api_key_env = match source.get("apiKeyEnv") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(name)) if is_api_key_env(name) => name.clone(),
        Some(_) => return fail("apiKeyEnv must be a valid environment variable name"),
    };
    let discovery = match source.get("discovery") {
        None => Obj::new(),
        Some(Value::Object(discovery)) => discovery.clone(),
        Some(_) => return fail("discovery must be an object"),
    };
    only_known_keys(&discovery, &DISCOVERY_KEYS, "discovery")?;
    let hidden = optional_boolean(discovery.get("newModelsHidden"), "discovery.newModelsHidden")?.unwrap_or(false);
    let wires = normalize_wires(source.get("wires"), &protocol)?;
    let model_wires = normalize_model_wires(source.get("modelWires"), &protocol, wires.as_deref())?;
    let headers = normalize_headers(source.get("headers"), "headers", &[])?;
    let request_body = normalize_request_body(source.get("requestBody"), "requestBody", body_lone_units)?;
    let base_url = normalize_base_url(source.get("baseURL"))?;
    let overrides = normalize_overrides(source.get("modelOverrides"), &protocol, legacy)?;
    let mut out = Obj::new();
    out.insert("type".into(), json!("custom"));
    out.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    out.insert("name".into(), json!(name));
    out.insert("protocol".into(), json!(protocol));
    out.insert("baseURL".into(), json!(base_url));
    out.insert("enabled".into(), json!(source.get("enabled") != Some(&Value::Bool(false))));
    out.insert("auth".into(), json!(auth));
    if !api_key_env.is_empty() && auth == "key" {
        out.insert("apiKeyEnv".into(), json!(api_key_env));
    }
    if !headers.is_empty() {
        out.insert("headers".into(), Value::Object(headers));
    }
    if !request_body.is_empty() {
        out.insert("requestBody".into(), Value::Object(request_body));
    }
    out.insert("discovery".into(), json!({ "newModelsHidden": hidden }));
    out.insert("modelOverrides".into(), Value::Object(overrides));
    if let Some(wires) = wires {
        out.insert("wires".into(), json!(wires));
    }
    if !model_wires.is_empty() {
        out.insert("modelWires".into(), Value::Object(model_wires));
    }
    Ok(Value::Object(out))
}
