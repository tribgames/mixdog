//! Input validation for the `capability_settings` methods: the usage reads, the network proxy and
//! the setting switches, the media board, the local provider and the provider secrets. Each check
//! is the one the desktop's main process ran on the capability call (`ipc-validation.ts`), applied to
//! the params of the protocol method that call resolves to, with the same limits, the same accepted
//! shapes and the same error text (`expected`). Lengths are UTF-16 units and trimming is JavaScript's.

use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

use crate::error::ErrorData;

/// The switches whose first argument must be a boolean (`BOOLEAN_FIRST_CAPABILITIES`).
const BOOLEAN_FIRST: &[&str] = &[
    "config/setAutoUpdate",
    "config/setRecapEnabled",
    "config/setAiSessionTitles",
    "config/setCacheWarmingEnabled",
    "config/setHeartbeatEnabled",
    "config/setReactionsEnabled",
    "config/setWebSearchEnabled",
    "config/setMemoryToolsEnabled",
    "voice/toggleVoice",
];
/// The switches whose second argument must be a boolean (`BOOLEAN_SECOND_CAPABILITIES`); both are `enabled`.
const BOOLEAN_SECOND: &[&str] = &[
    "mcp/setMcpServerEnabled",
    "plugins/setPluginEnabled",
    "channel/setScheduleEnabled",
    "channel/setWebhookEnabled",
    "config/setBuiltinToolEnabled",
    "config/setDeveloperOption",
];
const HEARTBEAT_INTERVAL_CHOICES: &[f64] = &[30.0, 60.0, 120.0, 240.0];
const TOGGLEABLE_BUILTIN_TOOLS: &[&str] = &["git", "office", "localProvider", "tidy", "autoEffort", "visualize", "media"];
const INSTALLABLE_BUILTIN_FEATURES: &[&str] = &["git", "memory", "office", "localProvider", "tidy", "autoEffort"];

const MAX_USAGE_REQUEST_PAGE: f64 = 200.0;
const MAX_USAGE_REQUEST_CURSOR_LENGTH: usize = 200;
const MAX_USAGE_REQUEST_MODEL_LENGTH: usize = 300;
const USAGE_REQUEST_STATUSES: &[&str] = &["completed", "substituted", "retried", "failed"];
const USAGE_PERIOD_VIEWS: &[&str] = &["hour", "7d", "day", "week", "month", "year", "all", "custom"];
const USAGE_REQUEST_KEYS: &[&str] = &[
    "view", "anchor", "startDay", "endDay", "startTime", "endTime", "status", "model", "cursor", "limit", "asOf",
];
const MAX_SESSION_USAGE_IDS: usize = 64;
const MAX_SESSION_ID_LENGTH: usize = 256;

const MEDIA_BOARD_NAME_MAX: usize = 120;
const MEDIA_ID_MAX: usize = 128;
const MEDIA_BOARD_MOVE_MAX: usize = 10_000;
const SECRET_MAX: usize = 65_536;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const RUNTIME_TAKES_NO_MODEL: &str = "runtime installation does not accept modelId.";

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    let p = Fields(params.and_then(Value::as_object));
    let outcome = match method {
        "thread/getSessionUsage" => session_usage(&p),
        "usage/getUsageRequests" => usage_requests(&p),
        "config/setHeartbeatInterval" => heartbeat_interval(&p),
        "instructions/setInstructionFiles" => one_of(
            &p,
            "mode",
            &["all", "agents", "claude", "off"],
            "setInstructionFiles requires all, agents, claude, or off.",
        ),
        "config/setAutoEffortBase" => {
            one_of(&p, "level", &["low", "medium", "high"], "setAutoEffortBase requires low, medium, or high.")
        }
        "config/setBuiltinToolEnabled" => builtin_tool(&p, method),
        "config/setDeveloperOption" => developer_option(&p, method),
        "config/setNetworkProxy" => network_proxy_set(&p),
        "config/getNetworkProxy" | "config/testNetworkProxy" => proxy_options(&p, method),
        "config/installBuiltinFeature" => install_builtin_feature(&p),
        "media/createMediaBoard" => text(&p, "name", "board name", MEDIA_BOARD_NAME_MAX),
        "media/renameMediaBoard" => rename_media_board(&p),
        "media/deleteMediaBoard" => text(&p, "id", "board id", MEDIA_ID_MAX),
        "media/setMediaAssetBoard" => set_media_asset_board(&p),
        "localProvider/startLocalProviderInstallation" => start_installation(&p),
        "localProvider/cancelLocalProviderInstallation" => text(&p, "jobId", "jobId", 128),
        "localProvider/discardLocalProviderInstallation" => discard_installation(&p),
        "localProvider/setLocalProviderContext" => local_provider_context(&p),
        "localProvider/getLocalProviderModelDetails" => model_id(&p),
        "localProvider/startLocalProviderModelMaintenance" => model_maintenance(&p),
        "localProvider/deleteLocalProviderModel" => text(&p, "confirmationToken", "confirmationToken", 128),
        "localProvider/setLocalProviderIdleTtl" => idle_ttl(&p),
        "account/saveProviderApiKey" => save_provider_api_key(&p),
        "account/authenticateProvider" => secret(p.get("secret"), "provider secret"),
        "account/checkCustomProviderKeyEnv" => text(&p, "name", "environment variable name", 128),
        "account/removeCustomProvider" => text(&p, "providerId", "custom provider id", 128),
        "account/saveCustomProviderKey" => save_custom_provider_key(&p),
        "account/saveOpenAIUsageSessionKey" => secret(p.get("secret"), "secret"),
        _ if BOOLEAN_FIRST.contains(&method) || BOOLEAN_SECOND.contains(&method) => boolean_switch(&p, method),
        _ => return None,
    };
    Some(outcome)
}

/// The params object of a request; a field that is absent reads as `undefined`.
struct Fields<'a>(Option<&'a Map<String, Value>>);

impl<'a> Fields<'a> {
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.and_then(|map| map.get(key))
    }
}

fn invalid(path: &str, expected: impl Into<String>) -> ErrorData {
    ErrorData::InvalidParams { path: path.to_string(), expected: expected.into() }
}

/// `requiredString`: a string whose trimmed text is not empty and at most `max` UTF-16 units.
fn required_string<'a>(value: Option<&'a Value>, path: &str, name: &str, max: usize) -> Result<&'a str, ErrorData> {
    let Some(Value::String(text)) = value else {
        return Err(invalid(path, format!("{name} must be a string.")));
    };
    let trimmed = js_trim(text);
    if trimmed.is_empty() || utf16_len(trimmed) > max {
        return Err(invalid(path, format!("{name} is invalid.")));
    }
    Ok(trimmed)
}

/// `requiredString` of the param `key`, the text itself not needed.
fn text(p: &Fields, key: &str, name: &str, max: usize) -> Result<(), ErrorData> {
    required_string(p.get(key), &format!("/{key}"), name, max).map(|_| ())
}

/// `validateSecret` of the param `secret`: a string with text in it, at most 65536 UTF-16 units before trimming.
fn secret(value: Option<&Value>, name: &str) -> Result<(), ErrorData> {
    match value {
        Some(Value::String(text)) if !js_trim(text).is_empty() && utf16_len(text) <= SECRET_MAX => Ok(()),
        _ => Err(invalid("/secret", format!("{name} is invalid."))),
    }
}

/// `requireAllowedKeys`.
fn allowed_keys(map: &Map<String, Value>, allowed: &[&str], path: &str, name: &str) -> Result<(), ErrorData> {
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(path, format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// `Number.isInteger`: a JSON number with no fraction.
fn integer(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `Number.isSafeInteger`.
fn safe_integer(value: &Value) -> Option<f64> {
    integer(value).filter(|number| number.abs() <= MAX_SAFE_INTEGER)
}

fn one_of(p: &Fields, key: &str, choices: &[&str], message: &str) -> Result<(), ErrorData> {
    match p.get(key) {
        Some(Value::String(choice)) if choices.contains(&choice.as_str()) => Ok(()),
        _ => Err(invalid(&format!("/{key}"), message)),
    }
}

/// The capability name of a method (`config/setTheme` is `setTheme`), the one the error texts name.
fn capability_of(method: &str) -> &str {
    method.rsplit('/').next().unwrap_or(method)
}

fn boolean_switch(p: &Fields, method: &str) -> Result<(), ErrorData> {
    match p.get("enabled") {
        Some(Value::Bool(_)) => Ok(()),
        _ => Err(invalid("/enabled", format!("{} requires a boolean value.", capability_of(method)))),
    }
}

fn heartbeat_interval(p: &Fields) -> Result<(), ErrorData> {
    let listed = p
        .get("minutes")
        .and_then(Value::as_f64)
        .is_some_and(|minutes| HEARTBEAT_INTERVAL_CHOICES.contains(&minutes));
    if listed {
        return Ok(());
    }
    let choices: Vec<String> = HEARTBEAT_INTERVAL_CHOICES.iter().map(|choice| choice.to_string()).collect();
    Err(invalid("/minutes", format!("setHeartbeatInterval requires {} minutes.", choices.join(", "))))
}

fn builtin_tool(p: &Fields, method: &str) -> Result<(), ErrorData> {
    boolean_switch(p, method)?;
    match p.get("name") {
        Some(Value::String(name)) if TOGGLEABLE_BUILTIN_TOOLS.contains(&name.as_str()) => Ok(()),
        _ => Err(invalid(
            "/name",
            "setBuiltinToolEnabled requires git, office, localProvider, tidy, autoEffort, visualize, or media.",
        )),
    }
}

fn developer_option(p: &Fields, method: &str) -> Result<(), ErrorData> {
    boolean_switch(p, method)?;
    text(p, "id", "developer option id", 128)
}

/// The shape of a network proxy patch only; the runtime validates the values.
fn network_proxy_set(p: &Fields) -> Result<(), ErrorData> {
    let Some(Value::Object(patch)) = p.get("patch") else {
        return Err(invalid("/patch", "network proxy settings must be an object."));
    };
    allowed_keys(patch, &["mode", "url", "exceptions"], "/patch", "network proxy settings")?;
    if patch.is_empty() {
        return Err(invalid("/patch", "network proxy settings require at least one setting."));
    }
    for key in ["mode", "url", "exceptions"] {
        if patch.get(key).is_some_and(|value| !value.is_string()) {
            return Err(invalid(&format!("/patch/{key}"), format!("network proxy {key} must be a string.")));
        }
    }
    proxy_options(p, "config/setNetworkProxy")
}

fn proxy_options(p: &Fields, method: &str) -> Result<(), ErrorData> {
    let Some(options) = p.get("options") else { return Ok(()) };
    let name = capability_of(method);
    let Value::Object(record) = options else {
        return Err(invalid("/options", format!("{name} options must be an object.")));
    };
    allowed_keys(record, &["provider"], "/options", &format!("{name} options"))?;
    match record.get("provider") {
        None => Ok(()),
        provider => required_string(provider, "/options/provider", "network proxy provider", 128).map(|_| ()),
    }
}

fn install_builtin_feature(p: &Fields) -> Result<(), ErrorData> {
    let name = p.get("name").and_then(Value::as_str);
    if !name.is_some_and(|name| INSTALLABLE_BUILTIN_FEATURES.contains(&name)) {
        return Err(invalid("/name", "installBuiltinFeature requires git, memory, office, localProvider, or tidy."));
    }
    let Some(options) = p.get("options") else { return Ok(()) };
    let engines = options.get("engines").and_then(Value::as_array);
    let listed = name == Some("tidy")
        && engines.is_some_and(|ids| {
            !ids.is_empty() && ids.len() <= 16 && ids.iter().all(|id| id.as_str().is_some_and(engine_id))
        });
    if listed {
        Ok(())
    } else {
        Err(invalid("/options", "installBuiltinFeature options accept only engines:[ids] for tidy."))
    }
}

/// `/^[a-z0-9_-]{1,64}$/`.
fn engine_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn session_usage(p: &Fields) -> Result<(), ErrorData> {
    let Some(options) = p.get("options") else { return Ok(()) };
    let Value::Object(request) = options else {
        return Err(invalid("/options", "session usage options must be an object."));
    };
    allowed_keys(request, &["sessionIds", "agents"], "/options", "session usage options")?;
    if let Some(ids) = request.get("sessionIds") {
        session_ids(ids)?;
    }
    if request.get("agents").is_some_and(|agents| !agents.is_boolean()) {
        return Err(invalid("/options/agents", "session usage agents must be a boolean."));
    }
    Ok(())
}

/// `requiredSessionIds(ids, 64)`: each id a trimmed `[A-Za-z0-9_-]` string of at most 256 units.
fn session_ids(ids: &Value) -> Result<(), ErrorData> {
    let Some(list) = ids.as_array().filter(|list| list.len() <= MAX_SESSION_USAGE_IDS) else {
        return Err(invalid("/options/sessionIds", "sessionIds must be a bounded array."));
    };
    for (index, id) in list.iter().enumerate() {
        let path = format!("/options/sessionIds/{index}");
        let Value::String(raw) = id else {
            return Err(invalid(&path, "session id must be a string."));
        };
        let trimmed = js_trim(raw);
        let well_formed = !trimmed.is_empty()
            && utf16_len(trimmed) <= MAX_SESSION_ID_LENGTH
            && trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !well_formed {
            return Err(invalid(&path, "session id is invalid."));
        }
    }
    Ok(())
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn period_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, b)| if at == 4 || at == 7 { *b == b'-' } else { b.is_ascii_digit() })
}

/// `/^\d{2}:\d{2}(?::\d{2})?$/`.
fn period_clock(text: &str) -> bool {
    let bytes = text.as_bytes();
    (bytes.len() == 5 || bytes.len() == 8)
        && bytes.iter().enumerate().all(|(at, b)| if at == 2 || at == 5 { *b == b':' } else { b.is_ascii_digit() })
}

fn usage_requests(p: &Fields) -> Result<(), ErrorData> {
    let Some(options) = p.get("options") else { return Ok(()) };
    let Value::Object(request) = options else {
        return Err(invalid("/options", "request log options must be an object."));
    };
    allowed_keys(request, USAGE_REQUEST_KEYS, "/options", "request log options")?;
    // The first page's time, pinned for later pages: the shape only.
    if let Some(as_of) = request.get("asOf") {
        if !as_of.as_f64().is_some_and(|time| time.is_finite() && time > 0.0) {
            return Err(invalid("/options/asOf", "request log asOf must be a positive timestamp."));
        }
    }
    let choice = |key: &str, choices: &[&str], message: &str| match request.get(key) {
        None => Ok(()),
        Some(Value::String(value)) if choices.contains(&value.as_str()) => Ok(()),
        Some(_) => Err(invalid(&format!("/options/{key}"), message)),
    };
    let shaped = |key: &str, shape: fn(&str) -> bool, what: &str| match request.get(key) {
        Some(value) if !value.as_str().is_some_and(shape) => {
            Err(invalid(&format!("/options/{key}"), format!("request log {key} must be a {what}.")))
        }
        _ => Ok(()),
    };
    choice("view", USAGE_PERIOD_VIEWS, "request log view is unknown.")?;
    for key in ["anchor", "startDay", "endDay"] {
        shaped(key, period_day, "YYYY-MM-DD date")?;
    }
    for key in ["startTime", "endTime"] {
        shaped(key, period_clock, "HH:MM time")?;
    }
    choice("status", USAGE_REQUEST_STATUSES, "request log status is unknown.")?;
    if let Some(model) = request.get("model") {
        required_string(Some(model), "/options/model", "request log model", MAX_USAGE_REQUEST_MODEL_LENGTH)?;
    }
    if let Some(cursor) = request.get("cursor") {
        required_string(Some(cursor), "/options/cursor", "request log cursor", MAX_USAGE_REQUEST_CURSOR_LENGTH)?;
    }
    if let Some(limit) = request.get("limit") {
        if !integer(limit).is_some_and(|limit| (1.0..=MAX_USAGE_REQUEST_PAGE).contains(&limit)) {
            return Err(invalid("/options/limit", "request log limit must be an integer from 1 to 200."));
        }
    }
    Ok(())
}

fn rename_media_board(p: &Fields) -> Result<(), ErrorData> {
    text(p, "id", "board id", MEDIA_ID_MAX)?;
    text(p, "name", "board name", MEDIA_BOARD_NAME_MAX)
}

fn set_media_asset_board(p: &Fields) -> Result<(), ErrorData> {
    let ids = p.get("ids").and_then(Value::as_array).filter(|ids| !ids.is_empty() && ids.len() <= MEDIA_BOARD_MOVE_MAX);
    let Some(ids) = ids else {
        return Err(invalid("/ids", "asset ids must be a non-empty array."));
    };
    for (index, id) in ids.iter().enumerate() {
        required_string(Some(id), &format!("/ids/{index}"), "asset id", MEDIA_ID_MAX)?;
    }
    // Only null takes results out of a board; anything else names one.
    match p.get("boardId") {
        Some(Value::Null) => Ok(()),
        board => required_string(board, "/boardId", "board id", MEDIA_ID_MAX).map(|_| ()),
    }
}

fn model_id(p: &Fields) -> Result<(), ErrorData> {
    text(p, "modelId", "modelId", 512)
}

fn start_installation(p: &Fields) -> Result<(), ErrorData> {
    let phase = p.get("phase").and_then(Value::as_str);
    if phase != Some("runtime") && phase != Some("model") {
        return Err(invalid("/phase", "phase must be runtime or model."));
    }
    if phase == Some("model") {
        model_id(p)
    } else if p.get("modelId").is_some() {
        Err(invalid("/modelId", RUNTIME_TAKES_NO_MODEL))
    } else {
        Ok(())
    }
}

fn discard_installation(p: &Fields) -> Result<(), ErrorData> {
    let phase = p.get("phase").and_then(Value::as_str);
    if !phase.is_some_and(|phase| ["runtime", "model", "verify", "repair"].contains(&phase)) {
        return Err(invalid("/phase", "phase must be runtime, model, verify or repair."));
    }
    if phase != Some("runtime") {
        model_id(p)
    } else if p.get("modelId").is_some() {
        Err(invalid("/modelId", RUNTIME_TAKES_NO_MODEL))
    } else {
        Ok(())
    }
}

fn local_provider_context(p: &Fields) -> Result<(), ErrorData> {
    model_id(p)?;
    let sized = match p.get("tokens") {
        Some(Value::Null) => true,
        Some(tokens) => safe_integer(tokens).is_some_and(|tokens| tokens >= 16384.0),
        None => false,
    };
    if sized {
        Ok(())
    } else {
        Err(invalid("/tokens", "Context size must be null (automatic) or an integer of at least 16384 tokens."))
    }
}

fn model_maintenance(p: &Fields) -> Result<(), ErrorData> {
    model_id(p)?;
    one_of(p, "operation", &["verify", "repair"], "operation must be verify or repair.")
}

fn idle_ttl(p: &Fields) -> Result<(), ErrorData> {
    if p.get("seconds").and_then(integer).is_some_and(|seconds| (0.0..=86400.0).contains(&seconds)) {
        Ok(())
    } else {
        Err(invalid("/seconds", "idleTtlSeconds must be an integer from 0 to 86400."))
    }
}

/// The key of a provider and, for Vertex AI, its settings (`options`).
fn save_provider_api_key(p: &Fields) -> Result<(), ErrorData> {
    let options = p.get("options");
    // A Vertex AI gcloud login (ADC) save sends no secret at all.
    let adc = options.and_then(|options| options.get("authMode")).and_then(Value::as_str) == Some("adc");
    if !adc {
        secret(p.get("secret"), "provider secret")?;
    }
    let Some(options) = options else { return Ok(()) };
    if p.get("providerId").and_then(Value::as_str) != Some("vertex-ai") {
        return Err(invalid("/options", "Provider settings are only supported for Vertex AI."));
    }
    let Value::Object(options) = options else {
        return Err(invalid("/options", "Vertex AI settings are invalid."));
    };
    // service-account: the JSON key; api-key: an express-mode API key.
    let mode_known = match options.get("authMode") {
        None => true,
        Some(Value::String(mode)) => adc || mode == "service-account" || mode == "api-key",
        Some(_) => false,
    };
    if !mode_known {
        return Err(invalid("/options/authMode", "Vertex AI authentication mode is invalid."));
    }
    if adc && p.get("secret").and_then(Value::as_str) != Some("") {
        return Err(invalid("/secret", "Vertex AI gcloud login takes no key."));
    }
    // No location (or an empty one) leaves it unset: the environment's region, then global.
    if let Some(location) = options.get("location").filter(|location| location.as_str() != Some("")) {
        required_string(Some(location), "/options/location", "Vertex AI location", 63)?;
        let known = location
            .as_str()
            .is_some_and(|text| text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
        if !known {
            return Err(invalid("/options/location", "Vertex AI location is invalid."));
        }
    }
    if let Some(project) = options.get("projectId").filter(|project| project.as_str() != Some("")) {
        required_string(Some(project), "/options/projectId", "Vertex AI project ID", 128)?;
        let known = project.as_str().is_some_and(|text| {
            text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        });
        if !known {
            return Err(invalid("/options/projectId", "Vertex AI project ID is invalid."));
        }
    }
    Ok(())
}

/// `/^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, after the `custom-` prefix.
fn custom_provider_uuid(id: &str) -> bool {
    let mut parts = id.split('-');
    let mut hex = |len: usize| {
        parts.next().is_some_and(|part| {
            part.len() == len && part.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    };
    let groups = [8, 4, 4, 4, 12].iter().all(|len| hex(*len));
    groups && parts.next().is_none()
}

fn save_custom_provider_key(p: &Fields) -> Result<(), ErrorData> {
    let uuid = p.get("providerId").and_then(Value::as_str).and_then(|id| id.strip_prefix("custom-"));
    if !uuid.is_some_and(custom_provider_uuid) {
        return Err(invalid("/providerId", "custom provider id is invalid."));
    }
    secret(p.get("secret"), "provider secret")
}

#[cfg(test)]
mod validate_capability_settings {
    use serde_json::Value;

    use super::check;
    use crate::error::ErrorData;
    use crate::methods::CLIENT_METHODS;

    const FIXTURE: &str = include_str!("fixtures/capability_settings.json");
    const CLIENTS_ACCEPTED: &str = include_str!("fixtures/clients-accepted.json");

    /// Methods whose rows in `clients-accepted.json` carry a schema-synthesised placeholder
    /// (`level-1`, `name-1`, `phase-1`, one minute, an empty patch) that the checks of the desktop's
    /// main process refuse as well: the real senders never send these values.
    const PLACEHOLDER_REFUSED: &[&str] = &[
        "config/setHeartbeatInterval",
        "config/setAutoEffortBase",
        "config/setBuiltinToolEnabled",
        "config/installBuiltinFeature",
        "config/setNetworkProxy",
        "instructions/setInstructionFiles",
        "media/setMediaAssetBoard",
        "localProvider/startLocalProviderInstallation",
        "localProvider/discardLocalProviderInstallation",
        "localProvider/setLocalProviderContext",
        "localProvider/startLocalProviderModelMaintenance",
        "account/saveProviderApiKey",
        "account/saveCustomProviderKey",
    ];

    fn rows(text: &str) -> Vec<Value> {
        serde_json::from_str(text).expect("fixture is JSON")
    }

    #[test]
    fn fixture_rows_match() {
        let real = |name: &str| CLIENT_METHODS.iter().any(|spec| spec.method == name);
        let table = rows(FIXTURE);
        assert!(!table.is_empty());
        for row in &table {
            let method = row["method"].as_str().expect("method");
            assert!(real(method), "fixture names `{method}`, which is not a client method");
            let got = check(method, row.get("params")).unwrap_or_else(|| panic!("`{method}` is not owned"));
            let case = row["case"].as_str().unwrap_or_default();
            match (&row["expected"], got) {
                (Value::Null, Ok(())) => {}
                (Value::Null, Err(error)) => panic!("{method} [{case}] was refused: {error:?}"),
                (expected, Ok(())) => panic!("{method} [{case}] was accepted, expected {expected}"),
                (expected, Err(error)) => {
                    let want = ErrorData::InvalidParams {
                        path: expected["path"].as_str().expect("path").to_string(),
                        expected: expected["expected"].as_str().expect("expected").to_string(),
                    };
                    assert_eq!(error, want, "{method} [{case}]");
                }
            }
        }
    }

    /// Every method this group owns has an accept row and a refuse row.
    #[test]
    fn every_owned_method_has_rows() {
        let table = rows(FIXTURE);
        let accepted = |method: &str| table.iter().any(|r| r["method"] == method && r["expected"].is_null());
        let refused = |method: &str| table.iter().any(|r| r["method"] == method && !r["expected"].is_null());
        for spec in CLIENT_METHODS.iter() {
            if check(spec.method, None).is_some() {
                assert!(accepted(spec.method), "{} has no accept row", spec.method);
                assert!(refused(spec.method), "{} has no refuse row", spec.method);
            }
        }
    }

    /// The inputs the clients send are accepted; only a placeholder-valued row of a method in
    /// `PLACEHOLDER_REFUSED` may be refused.
    #[test]
    fn clients_accepted_rows_are_accepted() {
        let mut seen = 0;
        for row in rows(CLIENTS_ACCEPTED) {
            let method = row["method"].as_str().expect("method");
            let Some(got) = check(method, row.get("params")) else { continue };
            seen += 1;
            if PLACEHOLDER_REFUSED.contains(&method) {
                continue;
            }
            assert_eq!(got, Ok(()), "{} row of {method} [{}]", row["client"], row["case"]);
        }
        assert!(seen > 0);
    }
}
