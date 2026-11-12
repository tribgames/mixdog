//! The model listings of the Google providers (`listModels`:
//! `gemini.mjs:924`, `vertex-ai.mjs:552`, `antigravity-oauth.mjs:252`), as
//! pure request builders and parsers; [`super::adapter::GoogleAdapter`] does
//! the one fetch.
//!
//! A listing is what the provider states: the catalog merge (models.dev,
//! LiteLLM, the sanitizer) and every cache and fallback list are above this
//! (PW §9). `ModelRecord::raw` holds Node's row, key for key.

use std::cmp::Ordering;
use std::sync::LazyLock;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ParameterOption;
use mixdog_core_api::domain::provider::ParameterValue;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_core_api::domain::provider::WireIds;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::codec::antigravity_user_agent;
use super::serving::FLEX_MODELS;
use super::serving::PRIORITY_MODELS;
use super::serving::listed_locations;
use super::traits::ModelTraits;
use super::traits::ThinkingControl;

fn regex(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "")
}

fn unreadable(message: impl Into<String>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    err.message = message.into();
    err
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A count a row states; `None` for anything that is not a positive number.
fn count(value: &Value) -> Option<u64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0).map(|n| n.floor() as u64)
}

use mixdog_js::json_number as number;

// ---------------------------------------------------------------------------
// Gemini API
// ---------------------------------------------------------------------------

/// One page of `GET /v1beta/models` (`fetchGeminiModelPages`); the key rides
/// in the credential header the adapter adds.
pub fn gemini_request(origin: &str, page_token: Option<&str>) -> WireRequest {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("pageSize", "1000");
    if let Some(token) = page_token {
        query.append_pair("pageToken", token);
    }
    WireRequest {
        transport: TransportKind::Http1,
        method: "GET".into(),
        url: format!("{origin}/v1beta/models?{}", query.finish()),
        headers: Vec::new(),
        body: Vec::new(),
    }
}

pub struct GeminiPage {
    pub models: Vec<Value>,
    /// Absent or empty ends the listing.
    pub next: Option<String>,
}

pub fn gemini_page(body: &[u8]) -> Result<GeminiPage, ProviderError> {
    let data: Value = serde_json::from_slice(body).map_err(|e| unreadable(format!("gemini model listing is not JSON: {e}")))?;
    Ok(GeminiPage {
        models: data.get("models").and_then(Value::as_array).cloned().unwrap_or_default(),
        next: data
            .get("nextPageToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_owned),
    })
}

struct GeminiRow {
    id: String,
    display: String,
    family: &'static str,
    context_window: Value,
    output_tokens: Value,
    description: String,
    latest: bool,
}

/// Most specific family first: a flash-lite id also contains `flash`.
fn gemini_family(id: &str) -> &'static str {
    if id.contains("flash-lite") {
        "gemini-flash-lite"
    } else if id.contains("flash") {
        "gemini-flash"
    } else if id.contains("pro") {
        "gemini-pro"
    } else {
        "gemini"
    }
}

static GEMINI_VERSION: LazyLock<JsRegex> = LazyLock::new(|| regex(r"gemini-(\d+)(?:\.(\d+))?"));

/// `[major, minor]` of a Gemini id; an absent part is 0 (`Number(undefined) || 0`).
fn gemini_version(id: &str) -> Vec<f64> {
    GEMINI_VERSION.captures(id).map_or_else(Vec::new, |caps| {
        (1..=2).map(|i| caps.get(i).and_then(|part| part.parse::<f64>().ok()).unwrap_or(0.0)).collect()
    })
}

/// `compareVersion(a, b) > 0`.
fn newer(a: &str, b: &str) -> bool {
    let (va, vb) = (gemini_version(a), gemini_version(b));
    for i in 0..va.len().max(vb.len()) {
        let (x, y) = (va.get(i).copied().unwrap_or(0.0), vb.get(i).copied().unwrap_or(0.0));
        if x != y {
            return x > y;
        }
    }
    locale_compare(a, b) == Ordering::Greater
}

fn limit(model: &Value, key: &str) -> Value {
    model.get(key).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null)
}

fn text_or(model: &Value, key: &str, fallback: &str) -> String {
    model.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(fallback).to_owned()
}

impl GeminiRow {
    fn of(model: &Value) -> Option<Self> {
        let name = model.get("name").and_then(Value::as_str).unwrap_or("");
        let generates = match model.get("supportedGenerationMethods") {
            Some(Value::Array(methods)) => methods.iter().any(|m| m.as_str() == Some("generateContent")),
            _ => true,
        };
        let excluded = ["embedding", "aqa", "imagen", "robotics", "computer-use"].iter().any(|p| name.contains(p));
        if !name.contains("gemini") || !generates || excluded {
            return None;
        }
        let id = name.strip_prefix("models/").unwrap_or(name).to_owned();
        Some(Self {
            display: text_or(model, "displayName", &id),
            family: gemini_family(&id),
            context_window: limit(model, "inputTokenLimit"),
            output_tokens: limit(model, "outputTokenLimit"),
            description: text_or(model, "description", ""),
            latest: false,
            id,
        })
    }

    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "display": self.display,
            "family": self.family,
            "provider": "gemini",
            "contextWindow": self.context_window,
            "outputTokens": self.output_tokens,
            "tier": "version",
            "latest": self.latest,
            "description": self.description,
        })
    }

    fn record(&self) -> ModelRecord {
        let mut record = ModelRecord::new(self.id.clone());
        record.display_name = Some(self.display.clone());
        record.context_window = count(&self.context_window);
        record.max_output_tokens = count(&self.output_tokens);
        record.picker.tier = Some("version".to_owned());
        record.picker.latest = self.latest;
        record.picker.description = Some(self.description.clone());
        record.raw = Some(self.json());
        record
    }
}

/// `fetchAndCacheGeminiModels` up to the catalog merge: filter, normalize and
/// mark the newest model of each family (`markLatest`).
pub fn gemini_records(models: &[Value]) -> Vec<ModelRecord> {
    let mut rows: Vec<GeminiRow> = models.iter().filter_map(GeminiRow::of).collect();
    let mut newest: Vec<(&'static str, usize)> = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        match newest.iter_mut().find(|(family, _)| *family == row.family) {
            Some((_, best)) if newer(&row.id, &rows[*best].id) => *best = at,
            Some(_) => {}
            None => newest.push((row.family, at)),
        }
    }
    for (_, at) in newest {
        rows[at].latest = true;
    }
    rows.iter().map(GeminiRow::record).collect()
}

// ---------------------------------------------------------------------------
// Vertex AI
// ---------------------------------------------------------------------------

/// `VERTEX_MODELS` (`vertex-ai-models.mjs`): id, name, context window, Claude
/// family. The open models are the ids with a `publisher/` prefix; their
/// availability is the serving table's.
const VERTEX_MODELS: [(&str, &str, Option<u64>, Option<&str>); 51] = [
    ("gemini-4-argon", "Gemini 4 Argon", Some(1_048_576), None),
    ("gemini-4-argon-cyber-permissive", "Gemini 4 Argon Cyber Permissive", None, None),
    ("gemini-3.8-flash", "Gemini 3.8 Flash", Some(1_048_576), None),
    ("gemini-3.8-flash-cyber", "Gemini 3.8 Flash Cyber", None, None),
    ("gemini-3.7-flash", "Gemini 3.7 Flash", None, None),
    ("gemini-3.6-flash", "Gemini 3.6 Flash", None, None),
    ("gemini-3.5-flash", "Gemini 3.5 Flash", None, None),
    ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", Some(1_048_576), None),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", None, None),
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", Some(1_048_576), None),
    ("gemini-3-flash-preview", "Gemini 3 Flash Preview", None, None),
    ("claude-opus-5-5", "Claude Opus 5.5", Some(1_000_000), Some("opus")),
    ("claude-fable-5-1", "Claude Fable 5.1", Some(1_000_000), Some("fable")),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", Some(1_000_000), Some("sonnet")),
    ("claude-haiku-5-5", "Claude Haiku 5.5", None, Some("haiku")),
    ("claude-opus-5", "Claude Opus 5", None, Some("opus")),
    ("claude-fable-5", "Claude Fable 5", None, Some("fable")),
    ("claude-sonnet-5", "Claude Sonnet 5", None, Some("sonnet")),
    ("claude-opus-4-8", "Claude Opus 4.8", None, Some("opus")),
    ("claude-opus-4-7", "Claude Opus 4.7", None, Some("opus")),
    ("claude-opus-4-6", "Claude Opus 4.6", None, Some("opus")),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", None, Some("sonnet")),
    ("claude-opus-4-5", "Claude Opus 4.5", None, Some("opus")),
    ("claude-sonnet-4-5", "Claude Sonnet 4.5", None, Some("sonnet")),
    ("claude-haiku-4-5", "Claude Haiku 4.5", None, Some("haiku")),
    ("claude-3-7-sonnet", "Claude 3.7 Sonnet", None, Some("sonnet")),
    ("claude-3-5-sonnet-v2", "Claude 3.5 Sonnet v2", None, Some("sonnet")),
    ("claude-3-5-sonnet", "Claude 3.5 Sonnet", None, Some("sonnet")),
    ("claude-3-5-haiku", "Claude 3.5 Haiku", None, Some("haiku")),
    ("deepseek-ai/deepseek-v4.1-flash-maas", "DeepSeek V4.1 Flash", None, None),
    ("deepseek-ai/deepseek-v3.2-maas", "DeepSeek V3.2", None, None),
    ("deepseek-ai/deepseek-v3.1-maas", "DeepSeek V3.1", None, None),
    ("deepseek-ai/deepseek-r1-0528-maas", "DeepSeek R1 (0528)", None, None),
    ("qwen/qwen3-coder-480b-a35b-instruct-maas", "Qwen3 Coder", None, None),
    ("qwen/qwen3-next-80b-a3b-instruct-maas", "Qwen3-Next 80B Instruct", None, None),
    ("qwen/qwen3-next-80b-a3b-thinking-maas", "Qwen3-Next 80B Thinking", None, None),
    ("zai-org/glm-5.2-maas", "GLM 5.2", None, None),
    ("zai-org/glm-5-maas", "GLM 5", None, None),
    ("zai-org/glm-4.7-maas", "GLM 4.7", None, None),
    ("moonshotai/kimi-k2-thinking-maas", "Kimi K2 Thinking", None, None),
    ("minimaxai/minimax-m2-maas", "MiniMax M2", None, None),
    ("openai/gpt-oss-120b-maas", "gpt-oss 120B", None, None),
    ("openai/gpt-oss-20b-maas", "gpt-oss 20B", None, None),
    ("meta/llama-4-maverick-17b-128e-instruct-maas", "Llama 4 Maverick 17B-128E", None, None),
    ("meta/llama-4-scout-17b-16e-instruct-maas", "Llama 4 Scout 17B-16E", None, None),
    ("google/gemma-4-26b-a4b-it-maas", "Gemma 4 26B A4B IT", None, None),
    ("xai/grok-4.7", "Grok 4.7", None, None),
    ("xai/grok-4.6", "Grok 4.6", None, None),
    ("xai/grok-4.3", "Grok 4.3", None, None),
    ("xai/grok-4.20-reasoning", "Grok 4.20 (Reasoning)", None, None),
    ("xai/grok-4.20-non-reasoning", "Grok 4.20 (Non-reasoning)", None, None),
];

/// `geminiDocumentedThinkingLevels`: models whose ladder differs from the
/// generic wire vocabulary.
fn documented_levels(id: &str) -> Option<Vec<String>> {
    let bare = id.strip_prefix("models/").unwrap_or(id).to_lowercase();
    matches!(bare.as_str(), "gemini-4-argon" | "gemini-3.8-flash")
        .then(|| ["low", "medium", "high"].map(str::to_owned).to_vec())
}

/// `vertexTierOption`: the service-tier parameter a listed model offers.
fn tier_option(id: &str) -> Option<ParameterOption> {
    let value = |value: &str, label: &str| ParameterValue { value: value.into(), label: label.into(), context_window: None };
    let mut options = Vec::new();
    if FLEX_MODELS.contains(&id) {
        options.push(value("flex", "Flex (50% off, slower)"));
    }
    if PRIORITY_MODELS.contains(&id) {
        options.push(value("priority", "Priority (faster, higher price)"));
    }
    if options.is_empty() {
        return None;
    }
    options.insert(0, value("standard", "Standard"));
    Some(ParameterOption { id: "serviceTier".into(), label: "Service tier".into(), kind: "enum".into(), options })
}

/// Vertex AI's own list: no endpoint, no credential. This is Node's listing,
/// not a fallback.
pub fn vertex_records() -> Vec<ModelRecord> {
    VERTEX_MODELS
        .iter()
        .map(|&(id, name, context_window, family)| {
            let mut row = Map::new();
            row.insert("id".into(), json!(id));
            row.insert("name".into(), json!(name));
            if let Some(family) = family {
                row.insert("family".into(), json!(family));
            }
            if let Some(window) = context_window {
                row.insert("contextWindow".into(), json!(window));
            }
            if let Some(locations) = listed_locations(id) {
                row.insert("locations".into(), json!(locations));
            }
            row.insert("provider".into(), json!("vertex-ai"));
            let mut record = ModelRecord::new(id);
            record.display_name = Some(name.to_owned());
            record.name = Some(name.to_owned());
            record.context_window = context_window;
            // The picker offers effort only from a declared ladder.
            if let Some(levels) = documented_levels(id) {
                row.insert("supportsReasoning".into(), json!(true));
                row.insert("reasoningOptions".into(), json!([{"type": "effort", "values": levels}]));
                record.supports_reasoning = Some(true);
                record.picker.reasoning_options = vec![ReasoningOption { kind: "effort".into(), values: levels }];
            }
            if let Some(option) = tier_option(id) {
                row.insert("modelParameterOptions".into(), json!([option]));
                record.picker.model_parameter_options = vec![option];
            }
            record.raw = Some(Value::Object(row));
            record
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

/// `fetchAvailableModels`: the daily host's catalog of the account's project.
pub fn antigravity_request(origin: &str, project: &str, client_version: &str) -> WireRequest {
    let body = if project.is_empty() { json!({}) } else { json!({ "project": project }) };
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: format!("{origin}/v1internal:fetchAvailableModels"),
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("user-agent".into(), antigravity_user_agent(client_version)),
        ],
        body: serde_json::to_vec(&body).expect("a JSON value serializes"),
    }
}

/// Tier labels the gateway puts in parentheses.
const TIER_EFFORTS: [(&str, &str); 5] =
    [("extra low", "minimal"), ("minimal", "minimal"), ("low", "low"), ("medium", "medium"), ("high", "high")];
const EFFORT_ORDER: [&str; 4] = ["minimal", "low", "medium", "high"];
/// The thinkingLevel values the gateway accepts on a single wire id.
const GATEWAY_LEVELS: [&str; 3] = ["low", "medium", "high"];

static INTERNAL_ID: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^(?:chat|tab)_"));
static TIER_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^(.*?)\s*\(([^()]+)\)\s*$"));
static FIRST_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| regex(r"\d+(?:\.\d+)?"));
static CLAUDE_WIRE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^claude-", "i"));

/// `splitDisplay`: the label without a trailing tier, and that tier's effort.
fn split_display(display: &str) -> (String, Option<&'static str>) {
    let text = js_trim(display);
    if let Some(caps) = TIER_SUFFIX.captures(text) {
        let label = js_trim(caps.get(2).unwrap_or("")).to_lowercase();
        if let Some((_, effort)) = TIER_EFFORTS.iter().find(|(tier, _)| *tier == label) {
            return (js_trim(caps.get(1).unwrap_or("")).to_owned(), Some(effort));
        }
    }
    (text.to_owned(), None)
}

fn family_id(base: &str) -> String {
    let mut out = String::new();
    for c in base.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

fn family_kind(base: &str) -> Option<&'static str> {
    let text = base.to_lowercase();
    if text.contains("claude") {
        None
    } else if text.contains("gemini") {
        Some(if text.contains("flash") { "gemini-flash" } else { "gemini-pro" })
    } else if text.contains("gpt") {
        Some("gpt-oss")
    } else {
        None
    }
}

/// Several wire ids can share one label: the one whose id carries the labelled
/// version, then the shortest, so the choice is stable across responses.
fn pick_wire(candidates: &[String], base: &str) -> String {
    let version = FIRST_NUMBER.find(base).map(|range| &base[range]);
    let rank = |id: &str| usize::from(!version.is_some_and(|v| id.contains(v)));
    let mut sorted: Vec<&String> = candidates.iter().collect();
    sorted.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(utf16_len(a).cmp(&utf16_len(b)))
            .then_with(|| locale_compare(a, b))
    });
    sorted[0].clone()
}

/// A bare wire id takes the ordinary thinkingLevel field: the catalog's ladder
/// narrows what the gateway accepts; with none declared the gateway-accepted
/// levels are offered and the server judges the value.
fn bare_levels(wire: &str, reasoning: bool, traits: &dyn ModelTraits) -> Vec<String> {
    let gateway = || GATEWAY_LEVELS.map(str::to_owned).to_vec();
    if !reasoning {
        return Vec::new();
    }
    if CLAUDE_WIRE.is_match(wire) {
        return gateway();
    }
    if !traits.is_gemini_family(wire) {
        return Vec::new();
    }
    match traits.thinking(wire) {
        ThinkingControl::Levels(declared) if !declared.is_empty() => {
            let declared: Vec<String> = declared.iter().map(|l| l.to_lowercase()).collect();
            GATEWAY_LEVELS.iter().filter(|l| declared.iter().any(|d| d == *l)).map(|l| (*l).to_owned()).collect()
        }
        _ => gateway(),
    }
}

struct Family {
    base: String,
    context_window: f64,
    /// 0 until an entry declares one; then the smallest declared.
    max_output: f64,
    vision: bool,
    reasoning: bool,
    /// Wire ids per tier slot (`""` for an unlabelled one), in listing order.
    wires: Vec<(&'static str, Vec<String>)>,
}

/// `resolveAntigravityWireModel`: the wire id for a picker id and effort, and
/// the effort that still travels as `thinkingLevel`, read from the records'
/// `wire`. An id with no wire is sent as it is, effort unchanged. With one
/// wire id, the effort rides along only if the record lists levels.
pub fn resolve_wire(roster: &[ModelRecord], model: &str, effort: Option<&str>) -> (String, Option<String>) {
    let Some((record, wire)) = roster.iter().find_map(|r| r.wire.as_ref().filter(|_| r.id == model).map(|w| (r, w))) else {
        return (model.to_owned(), effort.map(str::to_owned));
    };
    match wire {
        WireIds::Tiers(tiers) => {
            let wanted = effort.unwrap_or("").to_lowercase();
            let chosen = tiers
                .iter()
                .find(|(level, _)| *level == wanted)
                .or_else(|| tiers.iter().find(|(level, _)| level == "high"))
                .or(tiers.last());
            (chosen.map(|(_, wire)| wire.clone()).unwrap_or_else(|| model.to_owned()), None)
        }
        WireIds::One(wire) => (wire.clone(), if record.reasoning_levels.is_empty() { None } else { effort.map(str::to_owned) }),
    }
}

/// `DEFAULT_ANTIGRAVITY_MODEL`: the first curated model, the one a send without a model goes to.
pub const DEFAULT_ANTIGRAVITY_MODEL: &str = crate::catalog::ANTIGRAVITY_FALLBACK[0].0;

/// The `family` the curated fallback rows carry (`ANTIGRAVITY_MODELS`, `provider-model-identities.mjs`); the
/// Claude and gpt-oss rows have none.
const FALLBACK_FAMILIES: [(&str, &str); 3] = [("gemini-3.8-flash", "gemini-flash"), ("gemini-3.1-pro", "gemini-pro"), ("gemini-4-argon", "gemini-pro")];

/// `antigravityModelFamily(model)`: the catalog `family` of a picker id or one of its wire ids, from the listing the
/// roster holds, else from the curated rows (`antigravityCatalogModels`: the last live list, else the fallback).
pub fn antigravity_family(roster: &[ModelRecord], model: &str) -> Option<String> {
    let wires_of = |record: &ModelRecord| match &record.wire {
        Some(WireIds::One(wire)) => vec![wire.clone()],
        Some(WireIds::Tiers(tiers)) => tiers.iter().map(|(_, wire)| wire.clone()).collect(),
        None => Vec::new(),
    };
    if roster.is_empty() {
        let (id, _) = crate::catalog::ANTIGRAVITY_FALLBACK.iter().find(|(id, wires)| *id == model || wires.contains(&model))?;
        return FALLBACK_FAMILIES.iter().find(|(known, _)| known == id).map(|(_, family)| (*family).to_owned());
    }
    let record = roster.iter().find(|r| r.id == model).or_else(|| roster.iter().find(|r| wires_of(r).iter().any(|wire| wire == model)))?;
    record.raw.as_ref()?.get("family")?.as_str().filter(|family| !family.is_empty()).map(str::to_owned)
}

struct AntigravityRow {
    display: String,
    record: ModelRecord,
}

/// `normalizeAntigravityCatalog`: the gateway's per-tier wire ids collapse into
/// one record per model, whose `wire` map turns the chosen effort back into a
/// wire id.
fn antigravity_rows(raw: &Map<String, Value>, traits: &dyn ModelTraits) -> Vec<AntigravityRow> {
    let mut families: Vec<(String, Family)> = Vec::new();
    for (wire_id, entry) in raw {
        if !entry.is_object() || INTERNAL_ID.is_match(wire_id) {
            continue;
        }
        let shown = entry.get("displayName").filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
        let display = js_trim(&shown);
        let window = Some(to_number(entry.get("maxTokens").unwrap_or(&Value::Null))).filter(|n| *n > 0.0);
        let (Some(window), false) = (window, display.is_empty()) else { continue };
        let (base, effort) = split_display(display);
        let key = family_id(&base);
        let at = match families.iter().position(|(k, _)| *k == key) {
            Some(at) => at,
            None => {
                families.push((
                    key,
                    Family { base, context_window: 0.0, max_output: 0.0, vision: false, reasoning: false, wires: Vec::new() },
                ));
                families.len() - 1
            }
        };
        let family = &mut families[at].1;
        family.context_window = family.context_window.max(window);
        // Wire ids sharing one record keep the smallest declared output limit,
        // so the ceiling holds for every id the record can resolve to.
        let declared = to_number(entry.get("maxOutputTokens").unwrap_or(&Value::Null)).floor();
        if declared > 0.0 {
            family.max_output = if family.max_output > 0.0 { family.max_output.min(declared) } else { declared };
        }
        family.vision |= entry.get("supportsImages") == Some(&Value::Bool(true));
        family.reasoning |= entry.get("supportsThinking") == Some(&Value::Bool(true));
        let slot = effort.unwrap_or("");
        match family.wires.iter_mut().find(|(s, _)| *s == slot) {
            Some((_, ids)) => ids.push(wire_id.clone()),
            None => family.wires.push((slot, vec![wire_id.clone()])),
        }
    }
    let mut rows: Vec<AntigravityRow> = families
        .into_iter()
        .map(|(key, family)| {
            let wires_of = |slot: &str| family.wires.iter().find(|(s, _)| *s == slot).map(|(_, ids)| ids.as_slice());
            let efforts: Vec<&str> = EFFORT_ORDER.iter().copied().filter(|e| wires_of(e).is_some()).collect();
            let tiered = efforts.len() > 1;
            let pick = |slot: &str| pick_wire(wires_of(slot).expect("a slot of the family"), &family.base);
            let (wire, ids, id) = if tiered {
                let tiers: Vec<(String, String)> = efforts.iter().map(|e| ((*e).to_owned(), pick(e))).collect();
                let map: Map<String, Value> = tiers.iter().map(|(e, w)| (e.clone(), json!(w))).collect();
                (Value::Object(map), WireIds::Tiers(tiers), key)
            } else {
                let wire = pick(efforts.first().copied().unwrap_or(""));
                (json!(wire), WireIds::One(wire.clone()), wire)
            };
            let display = match efforts.first() {
                Some(first) if !tiered => {
                    let mut chars = first.chars();
                    let head: String = chars.next().into_iter().flat_map(char::to_uppercase).collect();
                    format!("{} ({head}{})", family.base, chars.as_str())
                }
                _ => family.base.clone(),
            };
            let levels: Vec<String> = if efforts.is_empty() {
                bare_levels(wire.as_str().unwrap_or(""), family.reasoning, traits)
            } else if tiered {
                efforts.iter().map(|e| (*e).to_owned()).collect()
            } else {
                // A lone labelled tier already names its effort in the wire id.
                Vec::new()
            };
            let mut row = Map::new();
            row.insert("id".into(), json!(id));
            row.insert("name".into(), json!(display));
            row.insert("display".into(), json!(display));
            row.insert("provider".into(), json!("antigravity-oauth"));
            if let Some(kind) = family_kind(&family.base) {
                row.insert("family".into(), json!(kind));
            }
            row.insert("contextWindow".into(), number(family.context_window));
            if family.max_output > 0.0 {
                row.insert("maxOutputTokens".into(), number(family.max_output));
            }
            row.insert("supportsVision".into(), json!(family.vision));
            row.insert("supportsReasoning".into(), json!(family.reasoning));
            row.insert("supportsFunctionCalling".into(), json!(true));
            row.insert("reasoningLevels".into(), json!(levels));
            row.insert("wire".into(), wire);
            let json = Value::Object(row);
            let mut record = ModelRecord::new(id);
            record.wire = Some(ids);
            record.display_name = Some(display.clone());
            record.name = Some(display.clone());
            record.context_window = Some(family.context_window as u64);
            record.max_output_tokens = (family.max_output > 0.0).then_some(family.max_output as u64);
            record.supports_reasoning = Some(family.reasoning);
            record.supports_images = Some(family.vision);
            record.reasoning_levels = levels;
            record.raw = Some(json);
            AntigravityRow { display, record }
        })
        .collect();
    rows.sort_by(|a, b| locale_compare(&a.display, &b.display));
    rows
}

/// The answer of `fetchAvailableModels` as records. A gateway that lists no
/// chat model is a failed listing, never an empty one.
pub fn antigravity_records(body: &[u8], traits: &dyn ModelTraits) -> Result<Vec<ModelRecord>, ProviderError> {
    let data: Value = serde_json::from_slice(body)
        .map_err(|e| unreadable(format!("[antigravity-oauth] fetchAvailableModels is not JSON: {e}")))?;
    let raw = data
        .get("models")
        .and_then(Value::as_object)
        .ok_or_else(|| unreadable("[antigravity-oauth] fetchAvailableModels returned no models"))?;
    let rows = antigravity_rows(raw, traits);
    if rows.is_empty() {
        return Err(unreadable("[antigravity-oauth] fetchAvailableModels listed no chat models"));
    }
    Ok(rows.into_iter().map(|row| row.record).collect())
}

#[cfg(test)]
mod tests;
