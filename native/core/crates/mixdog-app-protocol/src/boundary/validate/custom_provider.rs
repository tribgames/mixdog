//! Input validation for the `custom_provider` methods: the shape checks the desktop's main process made on the custom-provider
//! capabilities (ipc-validation.ts: requiredCustomProviderInput, requiredCustomModelPatch, model preferences), now answered for
//! every origin. Each message is the TypeError text of the old check and `path` the pointer of the field.

use std::collections::BTreeSet;

use mixdog_js::{js_to_lowercase, js_trim, utf16_len};
use serde_json::{Map, Value};

use crate::error::ErrorData;

type Check = Result<(), ErrorData>;

const PROVIDER_KEYS: &[&str] = &[
    "id", "name", "protocol", "baseURL", "apiKey", "apiKeyEnv", "extraApiKeys", "models", "schemaVersion", "enabled", "auth", "discovery",
    "modelOverrides", "wires", "modelWires", "headers", "requestBody", "type",
];
const V2_ONLY_KEYS: &[&str] = &["discovery", "modelOverrides", "wires", "modelWires", "headers", "requestBody"];
const WIRES: &[&str] = &["chat", "responses", "messages"];
const MODEL_KEYS: &[&str] = &["id", "name", "contextWindow", "maxOutputTokens"];
const PROTOCOLS: &[&str] = &["openai-chat", "openai-responses", "anthropic"];
const OVERRIDE_KEYS: &[&str] =
    &["manual", "hidden", "name", "contextWindow", "maxOutputTokens", "supportsVision", "reasoning", "requestBody", "requestHeaders"];
const REASONING_KEYS: &[&str] = &["levels", "wireFormat", "wireValues", "replay"];
const REASONING_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const WIRE_FORMATS: &[&str] = &["standard", "deepseek"];
const UNSAFE_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];
const PREFERENCE_KEYS: &[&str] = &["model", "hidden", "favorite"];
const MAX_OVERRIDES: usize = 500;
const MAX_HEADERS: usize = 64;
const MAX_MODEL_ID: usize = 256;
const MAX_NAME: usize = 200;
const MAX_WIRE_VALUE: usize = 64;
const MAX_API_KEY: usize = 65_536;
const MAX_EXTRA_API_KEYS: usize = 19;
const MAX_PREFERENCE_CHANGES: usize = 5_000;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    let owned = matches!(
        method,
        "account/saveCustomProvider"
            | "account/testCustomProvider"
            | "account/discoverCustomProviderModels"
            | "account/checkCustomProviderKeyEnv"
            | "account/removeCustomProvider"
            | "account/saveCustomProviderKey"
            | "account/updateCustomProviderModel"
            | "config/setModelPreferences"
    );
    if !owned {
        return None;
    }
    // A request without params, or with params that are not an object, is the typed decode's refusal.
    let Some(params) = params.and_then(Value::as_object) else { return Some(Ok(())) };
    let text_field = |key: &str, name: &str, maximum: usize| match params.get(key) {
        Some(value) => required_string(value, &at("", key), name, maximum).map(drop),
        // An absent argument is `undefined` to the host's `requiredString`.
        None => Err(fail(&at("", key), &format!("{name} must be a string."))),
    };
    Some(match method {
        "account/saveCustomProvider" | "account/testCustomProvider" => provider_input(params, false),
        "account/discoverCustomProviderModels" => provider_input(params, true),
        "account/checkCustomProviderKeyEnv" => text_field("name", "environment variable name", 128),
        "account/removeCustomProvider" => text_field("providerId", "custom provider id", 128),
        "account/saveCustomProviderKey" => save_key(params),
        "account/updateCustomProviderModel" => model_patch(params),
        _ => model_preferences(params),
    })
}

fn fail(path: &str, message: &str) -> ErrorData {
    ErrorData::InvalidParams { path: path.to_owned(), expected: message.to_owned() }
}

/// `path` extended by one JSON pointer token (RFC 6901).
fn at(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// `requiredString`: a string, trimmed, not empty, at most `maximum` UTF-16 units; returns the trimmed text.
fn required_string<'a>(value: &'a Value, path: &str, name: &str, maximum: usize) -> Result<&'a str, ErrorData> {
    let Some(text) = value.as_str() else { return Err(fail(path, &format!("{name} must be a string."))) };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(fail(path, &format!("{name} is invalid.")));
    }
    Ok(text)
}

/// `requiredString` of a field that may be absent, which reads as undefined.
fn required_field<'a>(record: &'a Map<String, Value>, key: &str, path: &str, name: &str, maximum: usize) -> Result<&'a str, ErrorData> {
    match record.get(key) {
        Some(value) => required_string(value, &at(path, key), name, maximum),
        None => Err(fail(&at(path, key), &format!("{name} must be a string."))),
    }
}

/// `hasControlCharacter`: C0 controls and DEL.
fn has_control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn bounded_text(value: &Value, path: &str, name: &str, maximum: usize) -> Check {
    let text = required_string(value, path, name, maximum)?;
    if has_control(text) {
        return Err(fail(path, &format!("{name} is invalid.")));
    }
    Ok(())
}

/// `plainRecord`: an object that is not null or an array.
fn plain_record<'a>(value: &'a Value, path: &str, name: &str) -> Result<&'a Map<String, Value>, ErrorData> {
    value.as_object().ok_or_else(|| fail(path, &format!("{name} is invalid.")))
}

fn allowed_keys(record: &Map<String, Value>, allowed: &[&str], path: &str, name: &str) -> Check {
    if record.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(fail(path, &format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// `Number.isSafeInteger(value) && value > 0`.
fn positive_safe_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE_INTEGER)
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `/^custom-<uuid>$/`.
fn is_provider_id(text: &str) -> bool {
    text.strip_prefix("custom-").is_some_and(is_uuid)
}

/// `/^[A-Za-z_][A-Za-z0-9_]{0,127}$/`.
fn is_key_env(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_') && text.len() <= 128 && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The level the runtime reads: trimmed, case-folded, `ultra` as `max`; `None` when it is none of the levels.
fn canonical_level(value: &str) -> Option<&'static str> {
    let text = js_to_lowercase(js_trim(value));
    let level = if text == "ultra" { "max" } else { text.as_str() };
    REASONING_LEVELS.iter().copied().find(|known| *known == level)
}

fn safe_model_id(model_id: &str, path: &str) -> Check {
    if js_trim(model_id).is_empty()
        || model_id != js_trim(model_id)
        || utf16_len(model_id) > MAX_MODEL_ID
        || has_control(model_id)
        || UNSAFE_KEYS.contains(&model_id)
    {
        return Err(fail(path, "custom provider model id is invalid."));
    }
    Ok(())
}

fn extra_api_keys(value: &Value, path: &str) -> Check {
    const NAME: &str = "custom provider extraApiKeys";
    let rows = match value.as_array() {
        Some(rows) if rows.len() <= MAX_EXTRA_API_KEYS => rows,
        _ => return Err(fail(path, "custom provider extraApiKeys are invalid.")),
    };
    let mut ids = BTreeSet::new();
    for (index, item) in rows.iter().enumerate() {
        let row_path = format!("{path}/{index}");
        let row = plain_record(item, &row_path, NAME)?;
        allowed_keys(row, &["id", "apiKey"], &row_path, NAME)?;
        let id = row.get("id");
        if let Some(id) = id
            && !id.as_str().is_some_and(|text| is_uuid(text) && !ids.contains(text))
        {
            return Err(fail(&at(&row_path, "id"), "custom provider extraApiKeys id is invalid."));
        }
        let key = row.get("apiKey");
        if let Some(key) = key
            && !key.as_str().is_some_and(|text| utf16_len(text) <= MAX_API_KEY)
        {
            return Err(fail(&at(&row_path, "apiKey"), "custom provider extraApiKeys apiKey is invalid."));
        }
        if id.is_none() && !key.and_then(Value::as_str).is_some_and(|text| !js_trim(text).is_empty()) {
            return Err(fail(&row_path, "custom provider additional API key is empty."));
        }
        if let Some(text) = id.and_then(Value::as_str) {
            ids.insert(text);
        }
    }
    Ok(())
}

/// A header map: at most 64 entries, every value a string.
fn header_map(value: &Value, path: &str, name: &str, too_large: &str) -> Check {
    let headers = plain_record(value, path, name)?;
    if headers.len() > MAX_HEADERS {
        return Err(fail(path, too_large));
    }
    if headers.values().any(|v| !v.is_string()) {
        return Err(fail(path, &format!("{name} are invalid.")));
    }
    Ok(())
}

fn provider_input(params: &Map<String, Value>, models_optional: bool) -> Check {
    let Some(value) = params.get("input") else { return Err(fail("/input", "custom provider is invalid.")) };
    let path = "/input";
    // No field at all is the placeholder the generic clients send; the runtime refuses it for its own missing fields.
    if value.as_object().is_some_and(Map::is_empty) {
        return Ok(());
    }
    let input = plain_record(value, path, "custom provider")?;
    allowed_keys(input, PROVIDER_KEYS, path, "custom provider")?;
    let field = |key: &str| input.get(key);
    let schema_v2 = field("schemaVersion").is_some_and(|v| v.as_f64() == Some(2.0));
    if let Some(id) = field("id")
        && !id.as_str().is_some_and(is_provider_id)
    {
        return Err(fail(&at(path, "id"), "custom provider id is invalid."));
    }
    match field("name") {
        Some(name) => bounded_text(name, &at(path, "name"), "custom provider name", MAX_NAME)?,
        None => return Err(fail(&at(path, "name"), "custom provider name must be a string.")),
    }
    let protocol = match field("protocol").and_then(Value::as_str) {
        Some(protocol) if PROTOCOLS.contains(&protocol) => protocol,
        _ => return Err(fail(&at(path, "protocol"), "custom provider protocol is invalid.")),
    };
    required_field(input, "baseURL", path, "custom provider baseURL", 2048)?;
    let api_key = field("apiKey");
    if let Some(key) = api_key
        && !key.as_str().is_some_and(|text| utf16_len(text) <= MAX_API_KEY)
    {
        return Err(fail(&at(path, "apiKey"), "custom provider apiKey is invalid."));
    }
    if let Some(env) = field("apiKeyEnv").filter(|v| !v.is_null()) {
        if !env.as_str().is_some_and(is_key_env) {
            return Err(fail(&at(path, "apiKeyEnv"), "custom provider apiKeyEnv is invalid."));
        }
        if field("auth").and_then(Value::as_str) == Some("none") {
            return Err(fail(&at(path, "apiKeyEnv"), "custom provider apiKeyEnv requires key auth."));
        }
        if api_key.and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
            return Err(fail(&at(path, "apiKeyEnv"), "custom provider apiKey and apiKeyEnv are mutually exclusive."));
        }
    }
    if let Some(extra) = field("extraApiKeys") {
        extra_api_keys(extra, &at(path, "extraApiKeys"))?;
    }
    if field("schemaVersion").is_some() && !schema_v2 {
        return Err(fail(&at(path, "schemaVersion"), "custom provider schemaVersion is invalid."));
    }
    if field("enabled").is_some_and(|v| !v.is_boolean()) {
        return Err(fail(&at(path, "enabled"), "custom provider enabled is invalid."));
    }
    if field("auth").is_some_and(|v| !matches!(v.as_str(), Some("key" | "none"))) {
        return Err(fail(&at(path, "auth"), "custom provider auth is invalid."));
    }
    if field("type").is_some_and(|v| v.as_str() != Some("custom")) {
        return Err(fail(&at(path, "type"), "custom provider type is invalid."));
    }
    if !schema_v2 && V2_ONLY_KEYS.iter().copied().any(|key| field(key).is_some()) {
        return Err(fail(&at(path, "schemaVersion"), "custom provider schemaVersion is invalid."));
    }
    if let Some(body) = field("requestBody") {
        plain_record(body, &at(path, "requestBody"), "custom provider requestBody")?;
    }
    if let Some(headers) = field("headers") {
        header_map(headers, &at(path, "headers"), "custom provider headers", "custom provider headers are too large.")?;
    }
    if let Some(wires) = field("wires") {
        let valid = wires.as_array().is_some_and(|list| {
            !list.is_empty() && list.len() <= WIRES.len() && list.iter().all(|w| w.as_str().is_some_and(|w| WIRES.contains(&w)))
        });
        if !valid {
            return Err(fail(&at(path, "wires"), "custom provider wires are invalid."));
        }
    }
    if let Some(wires) = field("modelWires") {
        let wires_path = at(path, "modelWires");
        let map = plain_record(wires, &wires_path, "custom provider modelWires")?;
        if map.len() > MAX_OVERRIDES {
            return Err(fail(&wires_path, "custom provider modelWires are too large."));
        }
        for model_id in mixdog_js::js_object_keys(map) {
            let wire = &map[model_id];
            safe_model_id(model_id, &at(&wires_path, model_id))?;
            if !wire.as_str().is_some_and(|w| WIRES.contains(&w)) {
                return Err(fail(&at(&wires_path, model_id), "custom provider modelWires are invalid."));
            }
        }
    }
    // v2 states models as modelOverrides; a legacy `models` list is unversioned only.
    if schema_v2 && field("models").is_some() {
        return Err(fail(&at(path, "models"), "custom provider models are invalid."));
    }
    if let Some(discovery) = field("discovery") {
        let discovery_path = at(path, "discovery");
        let record = plain_record(discovery, &discovery_path, "custom provider discovery")?;
        allowed_keys(record, &["newModelsHidden"], &discovery_path, "custom provider discovery")?;
        if record.get("newModelsHidden").is_some_and(|v| !v.is_boolean()) {
            return Err(fail(&discovery_path, "custom provider discovery is invalid."));
        }
    }
    if let Some(overrides) = field("modelOverrides") {
        let overrides_path = at(path, "modelOverrides");
        let map = plain_record(overrides, &overrides_path, "custom provider modelOverrides")?;
        if map.len() > MAX_OVERRIDES {
            return Err(fail(&overrides_path, "custom provider modelOverrides are too large."));
        }
        for model_id in mixdog_js::js_object_keys(map) {
            let row_path = at(&overrides_path, model_id);
            safe_model_id(model_id, &row_path)?;
            model_override(&map[model_id], &row_path, false, Some(protocol))?;
        }
    }
    let models = field("models");
    if models.is_none() && (models_optional || schema_v2) {
        return Ok(());
    }
    let models_path = at(path, "models");
    let list = match models.and_then(Value::as_array) {
        Some(list) if list.len() <= MAX_OVERRIDES => list,
        _ => return Err(fail(&models_path, "custom provider models are invalid.")),
    };
    for (index, model) in list.iter().enumerate() {
        let row_path = format!("{models_path}/{index}");
        let row = plain_record(model, &row_path, "custom provider model")?;
        allowed_keys(row, MODEL_KEYS, &row_path, "custom provider model")?;
        required_field(row, "id", &row_path, "custom provider model id", MAX_MODEL_ID)?;
        if let Some(name) = row.get("name") {
            required_string(name, &at(&row_path, "name"), "custom provider model name", MAX_NAME)?;
        }
        for key in ["contextWindow", "maxOutputTokens"] {
            if row.get(key).is_some_and(|v| !positive_safe_integer(v)) {
                return Err(fail(&at(&row_path, key), &format!("custom provider model {key} is invalid.")));
            }
        }
    }
    Ok(())
}

/// One model override with the runtime normalizer's accept set. `patch` also allows null to delete a property, and does not tie wire
/// values to the declared levels (the service prunes them against the merged levels). `protocol` is the provider's, when it is known.
fn model_override(value: &Value, path: &str, patch: bool, protocol: Option<&str>) -> Check {
    const NAME: &str = "custom provider model override";
    let row = plain_record(value, path, NAME)?;
    allowed_keys(row, OVERRIDE_KEYS, path, NAME)?;
    // A property that is present and not (null in a patch).
    let present = |key: &str| row.get(key).filter(|v| !(patch && v.is_null()));
    for key in ["manual", "hidden", "supportsVision"] {
        if present(key).is_some_and(|v| !v.is_boolean()) {
            return Err(fail(&at(path, key), &format!("custom provider model {key} is invalid.")));
        }
    }
    if let Some(name) = present("name") {
        bounded_text(name, &at(path, "name"), "custom provider model name", MAX_NAME)?;
    }
    for key in ["contextWindow", "maxOutputTokens"] {
        if present(key).is_some_and(|v| !positive_safe_integer(v)) {
            return Err(fail(&at(path, key), &format!("custom provider model {key} is invalid.")));
        }
    }
    if let Some(body) = present("requestBody") {
        plain_record(body, &at(path, "requestBody"), "custom provider requestBody")?;
    }
    if let Some(headers) = present("requestHeaders") {
        header_map(headers, &at(path, "requestHeaders"), "custom provider requestHeaders", "custom provider requestHeaders are invalid.")?;
    }
    let Some(reasoning) = present("reasoning") else { return Ok(()) };
    let reasoning_path = at(path, "reasoning");
    let record = plain_record(reasoning, &reasoning_path, "custom provider reasoning")?;
    allowed_keys(record, REASONING_KEYS, &reasoning_path, "custom provider reasoning")?;
    let part = |key: &str| record.get(key).filter(|v| !(patch && v.is_null()));
    let mut declared: Option<BTreeSet<&str>> = None;
    if let Some(levels) = part("levels") {
        let levels_path = at(&reasoning_path, "levels");
        let list = match levels.as_array() {
            Some(list) if list.len() <= REASONING_LEVELS.len() => list,
            _ => return Err(fail(&levels_path, "custom provider reasoning levels are invalid.")),
        };
        let mut set = BTreeSet::new();
        for entry in list {
            let level = entry.as_str().and_then(canonical_level);
            if !level.is_some_and(|level| set.insert(level)) {
                return Err(fail(&levels_path, "custom provider reasoning levels are invalid."));
            }
        }
        declared = Some(set);
    }
    if let Some(format) = part("wireFormat") {
        let format = format.as_str().map_or("", js_trim);
        if !WIRE_FORMATS.contains(&format) || (format == "deepseek" && protocol.is_some_and(|p| p != "openai-chat")) {
            return Err(fail(&at(&reasoning_path, "wireFormat"), "custom provider reasoning wireFormat is invalid."));
        }
    }
    if part("replay").is_some_and(|v| !v.is_boolean()) {
        return Err(fail(&at(&reasoning_path, "replay"), "custom provider reasoning replay is invalid."));
    }
    if let Some(values) = part("wireValues") {
        let values_path = at(&reasoning_path, "wireValues");
        let map = plain_record(values, &values_path, "custom provider reasoning wireValues")?;
        let mut seen = BTreeSet::new();
        for (key, wire) in map {
            let wire = wire.as_str().map(js_trim);
            let level = canonical_level(key).filter(|level| {
                !seen.contains(level)
                    && (patch || declared.as_ref().is_none_or(|declared| declared.contains(level)))
                    && wire.is_some_and(|w| !w.is_empty() && utf16_len(w) <= MAX_WIRE_VALUE && !has_control(w))
            });
            let Some(level) = level else {
                return Err(fail(&values_path, "custom provider reasoning wireValues are invalid."));
            };
            seen.insert(level);
        }
    }
    Ok(())
}

/// `saveCustomProviderKey`: the secret is a string with something in it, at most 65536 units. The provider id is not matched against
/// the custom id form here: the service finds no such provider and says so, as it does for the other id-keyed methods.
fn save_key(params: &Map<String, Value>) -> Check {
    // An absent secret is `undefined` to the host's `validateSecret`.
    let valid = params
        .get("secret")
        .and_then(Value::as_str)
        .is_some_and(|text| !js_trim(text).is_empty() && utf16_len(text) <= MAX_API_KEY);
    if !valid {
        return Err(fail("/secret", "provider secret is invalid."));
    }
    Ok(())
}

/// `updateCustomProviderModel`: provider id, model id and the patch (null deletes the override).
fn model_patch(params: &Map<String, Value>) -> Check {
    // An absent argument is `undefined` to the host's `requiredString`.
    let absent = Value::Null;
    required_string(params.get("providerId").unwrap_or(&absent), "/providerId", "custom provider id", 128)?;
    let model = params.get("modelId").unwrap_or(&absent);
    safe_model_id(required_string(model, "/modelId", "custom provider model id", MAX_MODEL_ID)?, "/modelId")?;
    match params.get("patch") {
        Some(patch) if !patch.is_null() => model_override(patch, "/patch", true, None),
        _ => Ok(()),
    }
}

/// `setModelPreferences`: a list of `{ model, hidden?, favorite? }`; an empty object stands for no changes.
fn model_preferences(params: &Map<String, Value>) -> Check {
    required_string(params.get("providerId").unwrap_or(&Value::Null), "/providerId", "provider id", 128)?;
    let Some(changes) = params.get("changes") else {
        return Err(fail("/changes", "model preference changes are invalid."));
    };
    if changes.as_object().is_some_and(Map::is_empty) {
        return Ok(());
    }
    let list = match changes.as_array() {
        Some(list) if list.len() <= MAX_PREFERENCE_CHANGES => list,
        _ => return Err(fail("/changes", "model preference changes are invalid.")),
    };
    for (index, raw) in list.iter().enumerate() {
        let path = format!("/changes/{index}");
        let change = plain_record(raw, &path, "model preference change")?;
        allowed_keys(change, PREFERENCE_KEYS, &path, "model preference change")?;
        let model = required_field(change, "model", &path, "model id", MAX_MODEL_ID)?;
        safe_model_id(model, &at(&path, "model"))?;
        for key in ["hidden", "favorite"] {
            if change.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(fail(&at(&path, key), &format!("model preference {key} is invalid.")));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One row per accept or refuse case: `expected` null accepts, a text is the refusal's message (`path` its pointer).
    #[test]
    fn fixture_rows_match() {
        let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/custom_provider.json")).expect("fixture rows");
        assert!(rows.len() > 100, "{} rows", rows.len());
        for row in &rows {
            let method = row["method"].as_str().expect("method");
            let got = check(method, Some(&row["params"])).unwrap_or_else(|| panic!("{method} is owned"));
            match (row["expected"].as_str(), got) {
                (None, Ok(())) => {}
                (Some(expected), Err(ErrorData::InvalidParams { path, expected: message })) => {
                    assert_eq!(message, expected, "{}", row["case"]);
                    assert_eq!(Some(path.as_str()), row["path"].as_str(), "{}", row["case"]);
                }
                (want, got) => panic!("{}: wanted {want:?}, got {got:?}", row["case"]),
            }
        }
    }

    /// Every input the TUI, the phone and the protocol client send for these methods is accepted.
    #[test]
    fn clients_accepted_rows_are_accepted() {
        let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/clients-accepted.json")).expect("corpus");
        let mut seen = 0;
        for row in &rows {
            let method = row["method"].as_str().expect("method");
            if let Some(got) = check(method, Some(&row["params"])) {
                assert_eq!(got, Ok(()), "{method} {}", row["case"]);
                seen += 1;
            }
        }
        assert!(seen >= 8, "{seen} rows of the group");
    }

    #[test]
    fn other_methods_are_not_owned() {
        assert!(check("thread/start", Some(&Value::Null)).is_none());
    }
}
