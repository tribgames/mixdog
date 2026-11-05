//! The compaction and auto-clear settings of the agent config (Node
//! `settings-compaction-api.mjs` + `config-helpers.mjs` `normalizeCompactionConfig`,
//! `normalizeAutoClearConfig`, the auto-clear provider windows). Every function takes the
//! `agent` config document and returns the Node result; writing it back is the service's job.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_object_keys;
use mixdog_js::js_trim;
use mixdog_js::math;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

pub type Doc = Map<String, Value>;

/// A validation failure Node throws as an `Error`; the message is the wire message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsError(pub String);

/// `AUTO_CLEAR_UNLIMITED_MS` (`Number.MAX_SAFE_INTEGER`).
pub const AUTO_CLEAR_UNLIMITED_MS: f64 = 9_007_199_254_740_991.0;
const DEFAULT_IDLE_MS: f64 = 3_600_000.0;
const HOUR: f64 = 3_600_000.0;
const MINUTE: f64 = 60_000.0;

/// `AUTO_CLEAR_PROVIDER_IDLE_MS`, in Node's order; 0 is unlimited.
const BUILT_IN: [(&str, f64); 10] = [
    ("anthropic", HOUR),
    ("anthropic-oauth", HOUR),
    ("gemini", HOUR),
    ("groq", 2.0 * HOUR),
    ("openai", 30.0 * MINUTE),
    ("deepseek", 24.0 * HOUR),
    ("xai", HOUR),
    ("openai-oauth", 0.0),
    ("mistral", HOUR),
    ("default", DEFAULT_IDLE_MS),
];

pub const SUMMARY_MODES: [&str; 3] = ["smart", "maintainer", "self"];

/// Every spelling of the main-context buffer budget; a new representation replaces the old.
pub const MAIN_BUFFER_KEYS: [&str; 6] = [
    "mainBufferTokens",
    "mainBuffer",
    "mainBufferPercent",
    "mainBufferPct",
    "mainBufferRatio",
    "mainBufferFraction",
];

/// `RETIRED_COMPACTION_FIELDS` (config-storage.mjs).
const RETIRED_FIELDS: [&str; 16] = [
    "type",
    "compactType",
    "compact_type",
    "semantic",
    "semanticModel",
    "prune",
    "tailTurns",
    "recallMemoryTimeoutMs",
    "recallIngestLimit",
    "recallChunkLimit",
    "recallLimit",
    "recallCycle1BatchSize",
    "recallRowsPerSession",
    "recallWindowSize",
    "recallConcurrency",
    "recallCycle1DeadlineMs",
];

/// `COMPACTION_CONFIG_KEYS`: the fields of `session.compaction` the saved config owns.
pub fn compaction_config_keys() -> Vec<&'static str> {
    let mut keys = vec!["auto", "onModelChange", "summaryMode"];
    keys.extend(RETIRED_FIELDS);
    keys.extend([
        "enabled",
        "useMaintainer",
        "model",
        "summaryModel",
        "timeoutMs",
        "memoryTimeoutMs",
        "buffer",
        "bufferTokens",
        "reservedTokens",
        "bufferPercent",
        "bufferPct",
        "bufferRatio",
        "bufferFraction",
    ]);
    keys.extend(MAIN_BUFFER_KEYS);
    keys
}

/// `adoptSessionCompaction`: the session keeps what the config does not own, and takes the
/// saved fields.
pub fn adopt_session_compaction(session: &mut Doc, saved: &Doc) {
    for key in compaction_config_keys() {
        session.shift_remove(key);
    }
    for (key, value) in saved {
        session.insert(key.clone(), value.clone());
    }
}

static UNLIMITED_DURATION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:unlimited|never)$", "i"));
static DURATION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d+(?:\.\d+)?)(ms|s|m|h)?$", ""));

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// A JS number as JSON: whole numbers stay integers.
fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= AUTO_CLEAR_UNLIMITED_MS {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// `Number(input[key])`: a missing key is `undefined`, so NaN.
fn number_field(object: &Doc, key: &str) -> f64 {
    object.get(key).map_or(f64::NAN, to_number)
}

fn clamp_percent(value: f64) -> f64 {
    math::min(100.0, math::max(0.0, math::round(value)))
}

fn object_of(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

// ---- compaction ----------------------------------------------------------------------------

/// `normalizeCompactionConfig`.
pub fn normalize_compaction(value: Option<&Value>) -> Doc {
    let raw = object_of(value);
    let mut next = raw.clone();
    if !next.get("summaryModel").is_some_and(truthy)
        && let Some(model) = raw.get("semanticModel").filter(|v| truthy(v))
    {
        next.insert("summaryModel".into(), model.clone());
    }
    if !next.get("memoryTimeoutMs").is_some_and(truthy)
        && let Some(ms) = raw.get("recallMemoryTimeoutMs").filter(|v| truthy(v))
    {
        next.insert("memoryTimeoutMs".into(), ms.clone());
    }
    for key in [
        "type",
        "compactType",
        "compact_type",
        "semantic",
        "semanticModel",
        "prune",
        "tailTurns",
        "recallMemoryTimeoutMs",
        "recallIngestLimit",
        "recallChunkLimit",
        "recallLimit",
        "recallCycle1BatchSize",
        "recallRowsPerSession",
        "recallWindowSize",
        "recallConcurrency",
        "recallCycle1DeadlineMs",
        "enabled",
        "useMaintainer",
    ] {
        next.shift_remove(key);
    }
    let flag_off = |key: &str| raw.get(key) == Some(&Value::Bool(false));
    next.insert("auto".into(), Value::Bool(!flag_off("auto") && !flag_off("enabled")));
    next.insert("onModelChange".into(), Value::Bool(!flag_off("onModelChange")));
    let mode = match raw.get("summaryMode").and_then(Value::as_str) {
        Some(mode) if SUMMARY_MODES.contains(&mode) => mode,
        _ if flag_off("useMaintainer") => "self",
        _ => "smart",
    };
    next.insert("summaryMode".into(), Value::String(mode.into()));
    next
}

/// `getCompactionSettings`.
pub fn get_compaction_settings(agent: &Doc) -> Doc {
    normalize_compaction(agent.get("compaction"))
}

/// `setCompactionSettings`: the new `compaction` section. The caller stores it and then adopts
/// it into the session (`adopt_session_compaction`).
pub fn set_compaction_settings(agent: &Doc, input: &Doc) -> Result<Doc, SettingsError> {
    let mut next = get_compaction_settings(agent);
    if let Some(auto) = input.get("auto") {
        next.insert("auto".into(), Value::Bool(*auto != Value::Bool(false)));
    }
    if let Some(enabled) = input.get("enabled") {
        next.insert("auto".into(), Value::Bool(*enabled != Value::Bool(false)));
    }
    if let Some(on_change) = input.get("onModelChange") {
        next.insert("onModelChange".into(), Value::Bool(*on_change != Value::Bool(false)));
    }
    if let Some(mode) = input.get("summaryMode") {
        match mode.as_str() {
            Some(mode) if SUMMARY_MODES.contains(&mode) => {
                next.insert("summaryMode".into(), Value::String(mode.into()));
            }
            _ => return Err(SettingsError(format!("usage: summaryMode {}", SUMMARY_MODES.join(" | ")))),
        }
    }
    if MAIN_BUFFER_KEYS.iter().any(|key| input.contains_key(*key)) {
        for old in MAIN_BUFFER_KEYS {
            next.shift_remove(old);
        }
    }
    for key in MAIN_BUFFER_KEYS {
        if let Some(value) = input.get(key) {
            next.insert(key.into(), value.clone());
        }
    }
    Ok(normalize_compaction(Some(&Value::Object(next))))
}

// ---- auto-clear ----------------------------------------------------------------------------

/// `normalizeAutoClearIdleValue`: 0 (unlimited), a window of at least a minute, or None.
fn idle_value(value: &Value) -> Option<f64> {
    match value {
        Value::Null | Value::Bool(_) => return None,
        Value::String(text) => {
            let text = js_trim(text).to_lowercase();
            if text.is_empty() {
                return None;
            }
            if text == "unlimited" || text == "never" {
                return Some(0.0);
            }
        }
        _ => {}
    }
    let idle = to_number(value);
    if !idle.is_finite() || idle < 0.0 {
        return None;
    }
    if idle == 0.0 {
        return Some(0.0);
    }
    Some(math::max(MINUTE, math::round(idle)))
}

fn resolved(stored: f64) -> f64 {
    if stored == 0.0 { AUTO_CLEAR_UNLIMITED_MS } else { stored }
}

pub fn is_auto_clear_unlimited(idle_ms: f64) -> bool {
    idle_ms >= AUTO_CLEAR_UNLIMITED_MS
}

/// `normalizeAutoClearProviderIdleMs`.
fn provider_idle(value: Option<&Value>) -> Doc {
    let mut out = Doc::new();
    let Some(raw) = value.and_then(Value::as_object) else {
        return out;
    };
    for key in js_object_keys(raw) {
        let ms = &raw[key];
        let provider = js_trim(key).to_lowercase();
        if let (false, Some(idle)) = (provider.is_empty(), idle_value(ms)) {
            out.insert(provider, num(idle));
        }
    }
    out
}

fn built_in(provider: &str) -> Option<f64> {
    BUILT_IN.iter().find(|(id, _)| *id == provider).map(|(_, ms)| *ms)
}

fn override_of(overrides: &Doc, key: &str) -> Option<f64> {
    overrides.get(key).and_then(Value::as_f64)
}

/// `autoClearIdleMsForProvider`.
pub fn idle_ms_for_provider(provider: Option<&Value>, provider_idle_ms: Option<&Value>) -> f64 {
    let overrides = provider_idle(provider_idle_ms);
    let key = clean(provider).to_lowercase();
    if !key.is_empty() {
        if let Some(ms) = override_of(&overrides, &key) {
            return resolved(ms);
        }
        if let Some(ms) = built_in(&key) {
            return resolved(ms);
        }
    }
    override_of(&overrides, "default").map_or(DEFAULT_IDLE_MS, resolved)
}

/// `autoClearProviderDefaults`.
pub fn provider_defaults(provider_idle_ms: Option<&Value>, extra: &[String]) -> Vec<Value> {
    let overrides = provider_idle(provider_idle_ms);
    let mut ids: Vec<String> = BUILT_IN.iter().map(|(id, _)| (*id).to_owned()).filter(|id| id != "default").collect();
    for value in extra {
        let id = js_trim(value).to_lowercase();
        if !id.is_empty() && !ids.contains(&id) && id != "default" {
            ids.push(id);
        }
    }
    for id in js_object_keys(&overrides) {
        if !ids.contains(id) && id != "default" {
            ids.push(id.clone());
        }
    }
    ids.push("default".into());
    let overrides_value = Value::Object(overrides.clone());
    ids.into_iter()
        .map(|provider| {
            let built = built_in(&provider).unwrap_or(DEFAULT_IDLE_MS);
            let idle = if let Some(ms) = override_of(&overrides, &provider) {
                resolved(ms)
            } else if built_in(&provider).is_some() {
                resolved(built)
            } else {
                idle_ms_for_provider(Some(&Value::String(provider.clone())), Some(&overrides_value))
            };
            let mut entry = Doc::new();
            entry.insert("provider".into(), Value::String(provider.clone()));
            entry.insert("idleMs".into(), num(idle));
            entry.insert("builtInMs".into(), num(resolved(built)));
            entry.insert("unlimited".into(), Value::Bool(is_auto_clear_unlimited(idle)));
            entry.insert("builtInUnlimited".into(), Value::Bool(built == 0.0));
            entry.insert("custom".into(), Value::Bool(overrides.contains_key(&provider)));
            Value::Object(entry)
        })
        .collect()
}

/// `resolveAutoClearIdleMs(config, provider)`.
pub fn resolve_idle_ms(agent: &Doc, provider: Option<&Value>) -> f64 {
    let raw = object_of(agent.get("autoClear"));
    let key = clean(provider).to_lowercase();
    let overrides = provider_idle(raw.get("providerIdleMs"));
    if !key.is_empty()
        && key != "default"
        && let Some(ms) = override_of(&overrides, &key)
    {
        return resolved(ms);
    }
    let idle = number_field(&raw, "idleMs");
    if idle.is_finite() && idle > 0.0 {
        return math::max(MINUTE, math::round(idle));
    }
    idle_ms_for_provider(provider, raw.get("providerIdleMs"))
}

/// `normalizeAutoClearConfig`: `enabled`, `idleMs`, `custom`, `providerIdleMs`,
/// `minContextPercent`.
pub fn normalize_auto_clear(value: Option<&Value>) -> Doc {
    let raw = object_of(value);
    let idle = number_field(&raw, "idleMs");
    let explicit = idle.is_finite() && idle > 0.0;
    let min_pct = number_field(&raw, "minContextPercent");
    let min_pct = if min_pct.is_finite() { clamp_percent(min_pct) } else { 10.0 };
    let mut out = Doc::new();
    out.insert("enabled".into(), Value::Bool(raw.get("enabled") != Some(&Value::Bool(false))));
    out.insert("idleMs".into(), if explicit { num(math::max(MINUTE, math::round(idle))) } else { Value::Null });
    out.insert("custom".into(), Value::Bool(explicit));
    out.insert("providerIdleMs".into(), Value::Object(provider_idle(raw.get("providerIdleMs"))));
    out.insert("minContextPercent".into(), num(min_pct));
    out
}

/// `formatDurationMs`.
pub fn format_duration_ms(ms: f64) -> String {
    let value = if ms.is_nan() { 0.0 } else { math::max(0.0, ms) };
    if value % HOUR == 0.0 {
        format!("{}h", number_to_string(value / HOUR))
    } else if value % MINUTE == 0.0 {
        format!("{}m", number_to_string(value / MINUTE))
    } else {
        format!("{}s", number_to_string(math::round(value / 1000.0)))
    }
}

/// `parseDurationMs`: at least a minute, None when not a duration.
pub fn parse_duration_ms(input: Option<&Value>) -> Option<f64> {
    let text = clean(input).to_lowercase();
    if text.is_empty() {
        return None;
    }
    let caps = DURATION.captures(&text)?;
    let n = string_to_number(caps.get(1)?);
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let mult = match caps.get(2).unwrap_or("m") {
        "h" => HOUR,
        "m" => MINUTE,
        "s" => 1000.0,
        _ => 1.0,
    };
    Some(math::max(MINUTE, math::round(n * mult)))
}

/// `enabledProviderKeys(config, provider)`, in the order `Object.entries` lists the providers.
fn enabled_providers(agent: &Doc, provider: Option<&str>) -> Vec<String> {
    let mut set = Vec::new();
    let mut add = |id: String| {
        if !set.contains(&id) {
            set.push(id);
        }
    };
    if let Some(providers) = agent.get("providers").and_then(Value::as_object) {
        for key in js_object_keys(providers) {
            let on = match &providers[key] {
                Value::Object(entry) => entry.get("enabled") != Some(&Value::Bool(false)),
                Value::Array(_) => true,
                _ => false,
            };
            if on {
                add(key.to_lowercase());
            }
        }
    }
    if let Some(provider) = provider {
        add(provider.to_lowercase());
    }
    set
}

/// `getAutoClear`. `provider` is the live route's provider (`route?.provider || null`).
pub fn get_auto_clear(agent: &Doc, provider: Option<&str>) -> Doc {
    let normalized = normalize_auto_clear(agent.get("autoClear"));
    let provider = provider.filter(|p| !p.is_empty());
    let provider_value = provider.map(|p| Value::String(p.into()));
    let provider_idle_ms = normalized.get("providerIdleMs");
    let provider_default = idle_ms_for_provider(provider_value.as_ref(), provider_idle_ms);
    let idle = resolve_idle_ms(agent, provider_value.as_ref());
    let key = provider.unwrap_or_default().to_lowercase();
    let custom_stored = provider_idle_ms.and_then(Value::as_object).and_then(|m| m.get(&key)).and_then(Value::as_f64);
    let provider_custom = !key.is_empty() && key != "default" && custom_stored.is_some_and(|ms| ms != 0.0);
    let enabled = enabled_providers(agent, provider);
    let defaults = provider_defaults(provider_idle_ms, &enabled)
        .into_iter()
        .filter(|entry| {
            let id = entry["provider"].as_str().unwrap_or_default();
            id == "default" || entry["custom"] == Value::Bool(true) || enabled.iter().any(|e| e == id)
        })
        .collect();
    let unlimited = is_auto_clear_unlimited(idle);
    let mut out = Doc::new();
    out.insert("enabled".into(), normalized["enabled"].clone());
    out.insert("idleMs".into(), num(idle));
    out.insert("unlimited".into(), Value::Bool(unlimited));
    out.insert("label".into(), Value::String(if unlimited { "unlimited".into() } else { format_duration_ms(idle) }));
    out.insert("custom".into(), normalized["custom"].clone());
    out.insert("providerCustom".into(), Value::Bool(provider_custom));
    out.insert("providerDefault".into(), num(provider_default));
    out.insert("provider".into(), provider_value.unwrap_or(Value::Null));
    out.insert("providerDefaults".into(), Value::Array(defaults));
    out.insert("minContextPercent".into(), normalized["minContextPercent"].clone());
    out
}

fn is_unlimited_text(value: Option<&Value>) -> bool {
    UNLIMITED_DURATION.is_match(&clean(value))
}

const PROVIDER_USAGE: &str = "usage: duration like 10m, 1h, 24h, or unlimited";

/// `saveProviderIdle`: the `autoClear` section with the provider's window edited.
fn provider_idle_section(mut next: Doc, key: &str, input: &Doc) -> Result<Doc, SettingsError> {
    let mut windows = object_of(next.get("providerIdleMs"));
    let has_duration = input.contains_key("duration");
    let has_idle = input.contains_key("idleMs");
    let idle_null = input.get("idleMs").is_none_or(Value::is_null);
    if input.get("resetProvider") == Some(&Value::Bool(true)) || (has_idle && idle_null) {
        windows.shift_remove(key);
    } else {
        let zero = input.get("idleMs").is_some_and(|v| v.is_number() && v.as_f64() == Some(0.0));
        let unlimited = input.get("unlimited") == Some(&Value::Bool(true))
            || (has_duration && is_unlimited_text(input.get("duration")))
            || (!has_duration && has_idle && zero);
        if unlimited {
            windows.insert(key.into(), num(0.0));
        } else {
            let idle = if has_duration {
                parse_duration_ms(input.get("duration")).unwrap_or(0.0)
            } else {
                number_field(input, "idleMs")
            };
            if idle == 0.0 || !idle.is_finite() || idle <= 0.0 {
                return Err(SettingsError(PROVIDER_USAGE.into()));
            }
            windows.insert(key.into(), num(math::max(MINUTE, math::round(idle))));
        }
    }
    next.insert("providerIdleMs".into(), Value::Object(windows));
    Ok(next)
}

/// `setAutoClear`: the new `autoClear` section. `route_provider` is the live route's provider.
pub fn set_auto_clear(agent: &Doc, route_provider: Option<&str>, input: &Doc) -> Result<Doc, SettingsError> {
    let mut next = normalize_auto_clear(agent.get("autoClear"));
    if let Some(enabled) = input.get("enabled") {
        next.insert("enabled".into(), Value::Bool(*enabled != Value::Bool(false)));
    }
    if input.contains_key("minContextPercent") {
        let pct = number_field(input, "minContextPercent");
        if !pct.is_finite() {
            return Err(SettingsError("autoclear minContextPercent must be a number between 0 and 100".into()));
        }
        next.insert("minContextPercent".into(), num(clamp_percent(pct)));
    }
    let has_duration = input.contains_key("duration");
    let wants_unlimited = has_duration && is_unlimited_text(input.get("duration"));
    let named = input.get("provider").filter(|v| truthy(v));
    let route = route_provider.filter(|p| !p.is_empty());
    let provider_key = match (named, wants_unlimited, route) {
        (Some(value), _, _) => value_to_string(value),
        (None, true, Some(route)) => route.to_owned(),
        _ => String::new(),
    };
    let provider_key = js_trim(&provider_key).to_lowercase();
    let edits_provider = !provider_key.is_empty()
        && (input.get("resetProvider") == Some(&Value::Bool(true))
            || input.get("unlimited") == Some(&Value::Bool(true))
            || has_duration
            || input.contains_key("idleMs"));
    if edits_provider {
        return provider_idle_section(next, &provider_key, input);
    }
    let idle_null = input.get("idleMs").is_none_or(Value::is_null);
    if input.get("reset") == Some(&Value::Bool(true)) || (input.contains_key("idleMs") && idle_null) {
        next.insert("idleMs".into(), Value::Null);
    } else if input.contains_key("idleMs") {
        let idle = number_field(input, "idleMs");
        if !idle.is_finite() || idle <= 0.0 {
            return Err(SettingsError("autoclear idleMs must be a positive number".into()));
        }
        next.insert("idleMs".into(), num(math::max(MINUTE, math::round(idle))));
    }
    if has_duration {
        let Some(idle) = parse_duration_ms(input.get("duration")) else {
            return Err(SettingsError("usage: /autoclear [on|off|status|<minutes|1h|90m>|unlimited]".into()));
        };
        next.insert("idleMs".into(), num(idle));
        if !input.contains_key("enabled") {
            next.insert("enabled".into(), Value::Bool(true));
        }
    }
    Ok(next)
}
