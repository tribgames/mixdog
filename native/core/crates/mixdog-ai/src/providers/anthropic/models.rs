//! The Anthropic model listing: one `GET {base}/v1/models`, each row
//! normalized the way the route's Node normalizer does. The two routes differ
//! and stay different: the API-key route also reads the alias fields
//! (`name`, `model`, `displayName`, `input_token_limit`, ...) and derives no
//! release date or `latest` mark; the subscription route derives both.
//!
//! Capability facts come from the row's `capabilities`; a row that states
//! none keeps the generation ladder Node derives for blanket effort support.
//! The context window is, in Node's order: what the row states, else what the
//! shared catalog states for the id ([`ModelCaps::context_window`]), else the
//! release-generation default of [`default_context`]. The catalog merge that
//! follows a listing never replaces a window the listing set, so this order
//! is what the picker shows.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::LazyLock;

use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_js::JsRegex;
use serde_json::Value;

use super::caps::CapsLookup;
use super::codec::AnthropicConfig;
use super::codec::DEFAULT_BASE_URL;
use super::codec::Flavor;

/// The window of a model nothing states a window for.
const DEFAULT_CONTEXT: u64 = 200_000;
/// The window of the long-context generations.
const LONG_CONTEXT: u64 = 1_000_000;
/// The first major version whose models all have the long window.
const LONG_CONTEXT_FROM_MAJOR: f64 = 5.0;

/// Control flags that ride the `capabilities.effort` map; never levels.
const CONTROL_KEYS: [&str; 3] = ["supported", "enabled", "default"];
/// Display order of effort levels; an unknown level sorts after these.
const LEVEL_ORDER: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
/// The level ladder of blanket effort support, before the generation gates.
const LADDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// First release generation (major * 100 + minor) with the `max` level.
const MAX_EFFORT_FLOOR: f64 = 405.0;
/// First release generation with the `xhigh` level.
const XHIGH_EFFORT_FLOOR: f64 = 407.0;

fn regex(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

static FAMILY: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^claude-([a-z]+)", "i"));
static DATED: LazyLock<JsRegex> = LazyLock::new(|| regex(r"-\d{8}$", ""));
static VERSIONED: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^claude-[a-z]+-\d+(?:-\d+)?$", "i"));
static RELEASE: LazyLock<JsRegex> = LazyLock::new(|| regex(r"-(\d{4})(\d{2})(\d{2})$", ""));
static VERSION: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^claude-[a-z]+-(\d+)(?:-(\d+))?", "i"));
/// Version 4 models that already have the long window (opus / sonnet 4.6 to 4.8).
static LONG_CONTEXT_FOUR: LazyLock<JsRegex> = LazyLock::new(|| regex(r"^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)", "i"));
static GENERATION_FAMILY_FIRST: LazyLock<JsRegex> =
    LazyLock::new(|| regex(r"^claude-[a-z][a-z0-9]*-(\d+)(?:-(\d{1,2})(?!\d))?(?:[-@]|$)", ""));
static GENERATION_VERSION_FIRST: LazyLock<JsRegex> =
    LazyLock::new(|| regex(r"^claude-(\d+)(?:-(\d{1,2})(?!\d))?(?:[-@]|$)", ""));

/// How a model id is listed in the catalog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// A snapshot id: trailing `-YYYYMMDD`.
    Dated,
    /// A versioned alias: `claude-<family>-<major>[-<minor>]`.
    Version,
    /// Anything else.
    Family,
}

/// One listed model, as the route's normalizer reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct AnthropicModel {
    pub id: String,
    pub display: String,
    pub family: String,
    /// The route's provider name.
    pub provider: &'static str,
    pub context_window: u64,
    pub output_tokens: Option<u64>,
    pub tier: Tier,
    /// Subscription route only: the highest-versioned model of its family.
    pub latest: bool,
    /// Subscription route only: `YYYY-MM-DD` of a trailing `-YYYYMMDD`.
    pub release_date: Option<String>,
    pub supports_reasoning: bool,
    /// Effort levels the model advertises, in display order.
    pub effort_levels: Vec<String>,
    /// `capabilities.thinking.types.adaptive`, when the row declares it.
    pub thinking_adaptive: Option<bool>,
    /// `capabilities.thinking.types.enabled`, when the row declares it.
    pub thinking_enabled: Option<bool>,
    /// The provider's row verbatim.
    pub raw: Value,
}

impl AnthropicModel {
    /// The reasoning options a picker shows: one `effort` option when the
    /// model advertises levels, none otherwise.
    pub fn reasoning_options(&self) -> Vec<ReasoningOption> {
        if self.effort_levels.is_empty() {
            Vec::new()
        } else {
            vec![ReasoningOption { kind: "effort".to_owned(), values: self.effort_levels.clone() }]
        }
    }

    pub fn to_record(&self) -> ModelRecord {
        let mut record = ModelRecord::new(self.id.clone());
        record.picker.release_date.clone_from(&self.release_date);
        record.picker.reasoning_options = self.reasoning_options();
        // `reasoningOptions` is always an array on an Anthropic row, empty for a model that takes
        // no effort; `thinkingTypes` only when the row declares one.
        record.efforts_stated = true;
        record.thinking_adaptive = self.thinking_adaptive;
        record.thinking_enabled = self.thinking_enabled;
        record.picker.tier = Some(
            match self.tier {
                Tier::Dated => "dated",
                Tier::Version => "version",
                Tier::Family => "family",
            }
            .to_owned(),
        );
        record.picker.latest = self.latest;
        record.display_name = Some(self.display.clone());
        record.context_window = Some(self.context_window);
        record.max_output_tokens = self.output_tokens;
        record.supports_reasoning = Some(self.supports_reasoning);
        record.reasoning_levels = self.effort_levels.clone();
        record.raw = Some(self.raw.clone());
        record
    }
}

/// JS truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `row[k1] || row[k2] || ...` for a string field.
fn first_string(row: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|k| row.get(*k))
        .find(|v| truthy(v))
        .and_then(|v| v.as_str().map(str::to_owned))
}

/// `row[k1] || row[k2] || ...` for a token count.
fn first_count(row: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .filter_map(|k| row.get(*k))
        .find(|v| truthy(v))
        .and_then(Value::as_f64)
        .map(|f| f as u64)
}

/// The window of a model no row and no catalog states one for: the long
/// window from version 5 and for opus / sonnet 4.6 to 4.8, else the default.
fn default_context(id: &str) -> u64 {
    let major = VERSION
        .captures(id)
        .and_then(|c| c.get(1).and_then(|m| m.parse::<f64>().ok()))
        .unwrap_or(0.0);
    if major >= LONG_CONTEXT_FROM_MAJOR || LONG_CONTEXT_FOUR.is_match(id) {
        LONG_CONTEXT
    } else {
        DEFAULT_CONTEXT
    }
}

fn capitalized(family: &str) -> String {
    let mut chars = family.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn pretty_name(id: &str, family: &str) -> String {
    let base = capitalized(family);
    let Some(caps) = VERSION.captures(id) else {
        return base;
    };
    let minor = caps.get(2).map(|m| format!(".{m}")).unwrap_or_default();
    format!("{base} {}{minor}", caps.get(1).unwrap_or_default())
}

/// Release generation of a Claude id as major * 100 + minor; a `claude-` id
/// with no version token ranks as the newest, a non-Claude id has none.
fn generation(model: &str) -> Option<f64> {
    let normalized = model.to_lowercase().replace('.', "-");
    let at = normalized.find("claude-")?;
    let id = &normalized[at..];
    let caps = GENERATION_FAMILY_FIRST.captures(id).or_else(|| GENERATION_VERSION_FIRST.captures(id));
    Some(match caps {
        Some(caps) => {
            let number = |s: Option<&str>| s.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            number(caps.get(1)) * 100.0 + number(caps.get(2))
        }
        None => f64::INFINITY,
    })
}

fn level_rank(level: &str) -> usize {
    LEVEL_ORDER.iter().position(|l| *l == level).unwrap_or(LEVEL_ORDER.len())
}

fn level_advertised(value: &Value) -> bool {
    value.as_bool() == Some(true) || value.get("supported").and_then(Value::as_bool) == Some(true)
}

/// The effort levels a row's `capabilities` advertise. An enumerated map is
/// the source of truth; blanket support (`effort: true` or `{supported: true}`
/// with no level flags) takes the ladder gated by the id's generation.
fn effort_levels(capabilities: Option<&Value>, model: &str) -> Vec<String> {
    let Some(effort) = capabilities.and_then(|c| c.get("effort")).filter(|e| truthy(e)) else {
        return Vec::new();
    };
    if let Value::Object(map) = effort {
        let mut advertised: Vec<&String> = map
            .iter()
            .filter(|(level, value)| {
                let control = mixdog_js::js_trim(level).to_lowercase();
                !CONTROL_KEYS.contains(&control.as_str()) && level_advertised(value)
            })
            .map(|(level, _)| level)
            .collect();
        if !advertised.is_empty() {
            advertised.sort_by_key(|level| level_rank(level));
            return advertised.into_iter().cloned().collect();
        }
        if map.get("supported").and_then(Value::as_bool) != Some(true) {
            return Vec::new();
        }
    } else if effort.is_array() {
        return Vec::new();
    }
    let generation = generation(model);
    let at_least = |floor: f64| generation.is_some_and(|g| g >= floor);
    LADDER
        .iter()
        .filter(|level| match **level {
            "max" => at_least(MAX_EFFORT_FLOOR),
            "xhigh" => at_least(XHIGH_EFFORT_FLOOR),
            _ => true,
        })
        .map(|level| (*level).to_owned())
        .collect()
}

/// `capabilities.thinking.types.<kind>`: a boolean, or an object's `supported`.
fn declared_thinking(capabilities: Option<&Value>, kind: &str) -> Option<bool> {
    let declared = capabilities?.get("thinking")?.get("types")?.as_object()?.get(kind)?;
    declared.as_bool().or_else(|| declared.get("supported").and_then(Value::as_bool))
}

fn thinking_supported(capabilities: Option<&Value>) -> bool {
    capabilities
        .and_then(|c| c.get("thinking"))
        .is_some_and(|t| t.as_bool() == Some(true) || t.get("supported").and_then(Value::as_bool) == Some(true))
}

/// One row, normalized for `flavor`; `None` for a row naming no model.
pub fn normalize(raw: &Value, flavor: Flavor, caps: &CapsLookup) -> Option<AnthropicModel> {
    let api_key = flavor == Flavor::ApiKey;
    let id = first_string(raw, if api_key { &["id", "name", "model"] } else { &["id", "name"] })?;
    let family = FAMILY.captures(&id).and_then(|c| c.get(1).map(str::to_lowercase)).unwrap_or_else(|| "other".to_owned());
    let dated = DATED.is_match(&id);
    let versioned = !dated && VERSIONED.is_match(&id);
    let tier = if dated {
        Tier::Dated
    } else if versioned {
        Tier::Version
    } else {
        Tier::Family
    };
    let capabilities = raw.get("capabilities");
    let levels = effort_levels(capabilities, &id);
    let display_keys: &[&str] = if api_key { &["display_name", "displayName", "display"] } else { &["display_name"] };
    let context_keys: &[&str] = if api_key {
        &["context_window", "max_context_window", "max_input_tokens", "input_token_limit", "inputTokenLimit"]
    } else {
        &["context_window", "max_context_window", "max_input_tokens"]
    };
    let output_keys: &[&str] = if api_key {
        &["max_tokens", "max_output_tokens", "output_token_limit", "outputTokenLimit"]
    } else {
        &["max_tokens", "max_output_tokens"]
    };
    let release_date = (!api_key && dated)
        .then(|| RELEASE.captures(&id))
        .flatten()
        .map(|c| format!("{}-{}-{}", c.get(1).unwrap_or_default(), c.get(2).unwrap_or_default(), c.get(3).unwrap_or_default()));
    Some(AnthropicModel {
        display: first_string(raw, display_keys).unwrap_or_else(|| pretty_name(&id, &family)),
        context_window: first_count(raw, context_keys)
            .or_else(|| caps(&id).and_then(|c| c.context_window).filter(|w| *w > 0))
            .unwrap_or_else(|| default_context(&id)),
        output_tokens: first_count(raw, output_keys),
        provider: flavor.provider_name(),
        tier,
        latest: false,
        release_date,
        supports_reasoning: !levels.is_empty() || thinking_supported(capabilities),
        thinking_adaptive: declared_thinking(capabilities, "adaptive"),
        thinking_enabled: declared_thinking(capabilities, "enabled"),
        effort_levels: levels,
        family,
        raw: raw.clone(),
        id,
    })
}

/// `a` against `b` by version: the numeric parts first, then the ids.
fn compare_version(a: &str, b: &str) -> Ordering {
    let parts = |id: &str| -> [f64; 2] {
        let number = |s: Option<&str>| s.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        VERSION.captures(id).map_or([0.0; 2], |c| [number(c.get(1)), number(c.get(2))])
    };
    let (pa, pb) = (parts(a), parts(b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        if x != y {
            return x.partial_cmp(y).unwrap_or(Ordering::Equal);
        }
    }
    mixdog_js::locale_compare(a, b)
}

/// Marks the highest-versioned model of each family `latest`; only listed
/// versioned aliases compete, and the first of equals wins.
fn mark_latest(models: &mut [AnthropicModel]) {
    let mut best: BTreeMap<String, usize> = BTreeMap::new();
    for (index, model) in models.iter().enumerate() {
        if model.tier != Tier::Version {
            continue;
        }
        match best.get(&model.family) {
            Some(&current) if compare_version(&model.id, &models[current].id) != Ordering::Greater => {}
            _ => {
                best.insert(model.family.clone(), index);
            }
        }
    }
    for index in best.into_values() {
        models[index].latest = true;
    }
}

/// The listing request URL of a route: the API-key route lists from its own
/// base URL, the subscription route always from Anthropic's.
pub(crate) fn listing_url(flavor: Flavor, config: &AnthropicConfig) -> String {
    let base = match flavor {
        Flavor::ApiKey => config.base_url.trim_end_matches('/'),
        Flavor::OAuth => DEFAULT_BASE_URL,
    };
    format!("{base}/v1/models")
}

/// Every normalized row of a listing body, in the order served. A body that
/// is not a JSON object with a `data` array lists nothing.
pub(crate) fn parse_listing(
    body: &[u8],
    flavor: Flavor,
    caps: &CapsLookup,
) -> Result<Vec<AnthropicModel>, serde_json::Error> {
    let document: Value = serde_json::from_slice(body)?;
    let mut models: Vec<AnthropicModel> = document
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(|row| normalize(row, flavor, caps)).collect())
        .unwrap_or_default();
    if flavor == Flavor::OAuth {
        mark_latest(&mut models);
    }
    Ok(models)
}
