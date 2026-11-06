//! The data tables of `provider-catalog-registry.mjs`, `provider-seed-rosters.mjs`,
//! `provider-model-identities.mjs` and the hand-verified rows of
//! `model-catalog.mjs`. All are facts (endpoints, published rates, documented
//! ladders); none infers anything from a model's name except the Muse/MiMo
//! seed lineage Node itself defines.

use std::sync::LazyLock;

use serde_json::Value;
use serde_json::json;

use super::rates::Obj;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Seed {
    Muse,
    Mimo,
}

/// `providerCatalogEntry(provider)`.
#[derive(Clone, Debug)]
pub struct Entry {
    pub provider: String,
    pub models_dev: String,
    pub same_endpoint: bool,
    pub relay: bool,
    pub roster_limits_authoritative: bool,
    pub roster_ladder_final: bool,
    pub seed: Option<Seed>,
}

struct Row {
    models_dev: Option<&'static str>,
    same_endpoint: bool,
    relay: bool,
    limits_authoritative: bool,
    ladder_final: bool,
    seed: Option<Seed>,
}

const BASE: Row = Row { models_dev: None, same_endpoint: true, relay: false, limits_authoritative: false, ladder_final: false, seed: None };

fn row_of(provider: &str) -> Option<Row> {
    let row = match provider {
        "openai" => Row { models_dev: Some("openai"), ..BASE },
        "openai-oauth" => Row { models_dev: Some("openai"), same_endpoint: false, limits_authoritative: true, ..BASE },
        "anthropic-oauth" => Row { models_dev: Some("anthropic"), same_endpoint: false, limits_authoritative: true, ..BASE },
        "anthropic" => Row { models_dev: Some("anthropic"), ..BASE },
        "gemini" => Row { models_dev: Some("google"), ..BASE },
        "vertex-ai" => Row { models_dev: Some("google-vertex"), ..BASE },
        "grok-oauth" => Row { models_dev: Some("xai"), same_endpoint: false, limits_authoritative: true, ..BASE },
        "muse-code-oauth" => Row { models_dev: Some("meta"), limits_authoritative: true, seed: Some(Seed::Muse), ..BASE },
        "mimo-oauth" => {
            Row { models_dev: Some("xiaomi"), same_endpoint: false, limits_authoritative: true, seed: Some(Seed::Mimo), ..BASE }
        }
        "antigravity-oauth" => Row { relay: true, ladder_final: true, ..BASE },
        "command-code-oauth" => Row { relay: true, limits_authoritative: true, ..BASE },
        "cursor-oauth" | "devin-oauth" | "cursor-api" | "opencode-go" => Row { relay: true, ..BASE },
        "opencode-go-oauth" => Row { models_dev: Some("opencode-go"), relay: true, limits_authoritative: true, ..BASE },
        _ => return None,
    };
    Some(row)
}

/// `providerCatalogEntry`: an unlisted provider is its own models.dev id and endpoint.
pub fn provider_catalog_entry(provider: &str) -> Option<Entry> {
    let key = mixdog_js::js_trim(provider).to_lowercase();
    if key.is_empty() {
        return None;
    }
    let row = row_of(&key).unwrap_or(BASE);
    Some(Entry {
        models_dev: row.models_dev.map_or_else(|| key.clone(), str::to_owned),
        provider: key,
        same_endpoint: row.same_endpoint,
        relay: row.relay,
        roster_limits_authoritative: row.limits_authoritative,
        roster_ladder_final: row.ladder_final,
        seed: row.seed,
    })
}

/// `modelsDevProviderId`.
pub fn models_dev_provider_id(provider: &str) -> Option<String> {
    provider_catalog_entry(provider).map(|e| e.models_dev)
}

/// `firstPartyModelsDevIds`: vendors that serve their own models, sorted.
pub fn first_party_ids() -> [&'static str; 7] {
    ["anthropic", "google", "google-vertex", "meta", "openai", "xai", "xiaomi"]
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("a static table")
}

/// `PRICING_OVERRIDES`: hand-verified rows in the LiteLLM row shape.
pub static PRICING_OVERRIDES: LazyLock<Value> = LazyLock::new(|| {
    parse(
        r#"{
  "gemini-3-flash": {"litellm_provider": "gemini", "input_cost_per_token": 5e-7, "output_cost_per_token": 3e-6, "cache_read_input_token_cost": 5e-8, "mode": "chat", "supports_vision": true, "supports_function_calling": true, "supports_prompt_caching": true},
  "gemini-3.1-pro": {"litellm_provider": "gemini", "input_cost_per_token": 2e-6, "input_cost_per_token_above_200k_tokens": 4e-6, "output_cost_per_token": 1.2e-5, "output_cost_per_token_above_200k_tokens": 1.8e-5, "cache_read_input_token_cost": 2e-7, "cache_read_input_token_cost_above_200k_tokens": 4e-7, "mode": "chat", "supports_vision": true, "supports_function_calling": true, "supports_prompt_caching": true},
  "deepseek-flash": {"litellm_provider": "deepseek", "input_cost_per_token": 3e-7, "output_cost_per_token": 1.2e-6, "cache_read_input_token_cost": 6e-9, "off_peak_multiplier": 0.5, "max_input_tokens": 1000000, "max_output_tokens": 384000, "mode": "chat", "supports_vision": true, "supports_function_calling": true, "supports_prompt_caching": true},
  "deepseek-v4-flash": {"litellm_provider": "deepseek", "input_cost_per_token": 3e-7, "output_cost_per_token": 1.2e-6, "cache_read_input_token_cost": 6e-9, "off_peak_multiplier": 0.5, "max_input_tokens": 1000000, "max_output_tokens": 384000, "mode": "chat", "supports_function_calling": true, "supports_prompt_caching": true},
  "deepseek-v4-pro": {"litellm_provider": "deepseek", "input_cost_per_token": 1.32e-6, "output_cost_per_token": 3.96e-6, "cache_read_input_token_cost": 4.4e-8, "off_peak_multiplier": 0.5, "max_input_tokens": 1000000, "max_output_tokens": 384000, "mode": "chat", "supports_function_calling": true, "supports_prompt_caching": true}
}"#,
    )
});

/// `CURSOR_PRICING`: Cursor-billed rates no catalog publishes.
pub static CURSOR_PRICING: LazyLock<Value> = LazyLock::new(|| {
    parse(
        r#"{
  "composer-2.5": {"inputCostPerM": 0.5, "cacheReadCostPerM": 0.2, "outputCostPerM": 2.5, "fast": {"inputCostPerM": 3, "cacheReadCostPerM": 0.5, "outputCostPerM": 15}},
  "grok-4.7": {"fast": {"inputCostPerM": 4, "cacheReadCostPerM": 1, "outputCostPerM": 12, "pricingTiers": [{"aboveInputTokens": 256000, "inputCostPerM": 6, "cacheReadCostPerM": 1.5, "outputCostPerM": 18}]}},
  "grok-4.6": {"fast": {"inputCostPerM": 4, "cacheReadCostPerM": 1, "outputCostPerM": 12}},
  "grok-4.5": {"fast": {"inputCostPerM": 4, "cacheReadCostPerM": 1, "outputCostPerM": 18}},
  "claude-opus-4-7": {"fast": {"inputCostPerM": 30, "cacheWriteCostPerM": 37.5, "cacheReadCostPerM": 3, "outputCostPerM": 150}}
}"#,
    )
});

/// A price multiple of a base SKU (`pricedVariant`).
pub struct Variant {
    pub base: String,
    pub rate_multiplier: f64,
    pub row_multiplier: Option<&'static str>,
}

/// `pricedVariant(provider, id)`.
pub fn priced_variant(provider: &str, id: &str) -> Option<Variant> {
    if provider == "grok-oauth" && id == "grok-4.7-build-fast" {
        return Some(Variant { base: "grok-4.7".into(), rate_multiplier: 2.0, row_multiplier: None });
    }
    if provider != "vertex-ai" {
        return None;
    }
    if let Some(base) = id.strip_suffix("@regional") {
        return Some(Variant { base: base.into(), rate_multiplier: 1.1, row_multiplier: Some("regionalUplift") });
    }
    // A pinned version bills as its model when no row prices the version itself.
    let version = id.find('@').filter(|i| *i > 0)?;
    Some(Variant { base: id[..id.len().min(version)].into(), rate_multiplier: 1.0, row_multiplier: None })
}

/// `VERIFIED_CORRECTIONS[provider][model]`.
pub fn metadata_correction(provider: &str, model: &str) -> Option<Obj> {
    let key = mixdog_js::js_trim(provider).to_lowercase();
    if key != "muse-code-oauth" || model != "muse-spark-1.3-contributor" {
        return None;
    }
    let levels = json!(["minimal", "low", "medium", "high", "xhigh", "max"]);
    let mut out = Obj::new();
    out.insert("reasoningOptions".into(), json!([{"type": "effort", "values": levels}]));
    Some(out)
}

// ── seeds ──────────────────────────────────────────────────────────────────

const MUSE_DEFAULT: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];
const MUSE_SIX: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const STANDARD_COST: [f64; 4] = [1.25, 4.25, 0.15, 0.0];
const CONTRIBUTOR_COST: [f64; 4] = [0.1, 0.2, 0.002, 0.0];
const MUSE_SEEDS: [(&str, &str, bool, bool); 5] = [
    // id, name, six levels, contributor cost
    ("muse-spark-1.1", "Muse Spark 1.1", false, false),
    ("muse-spark-1.2", "Muse Spark 1.2", false, false),
    ("muse-spark-1.2-contributor", "Muse Spark 1.2 (C)", false, true),
    ("muse-spark-1.3", "Muse Spark 1.3", true, false),
    ("muse-spark-1.3-contributor", "Muse Spark 1.3 (C)", true, true),
];

fn muse_row(id: &str, name: &str, levels: &[&str], cost: [f64; 4]) -> Value {
    let mut row = json!({
        "id": id, "name": name, "provider": "muse-code-oauth", "family": "muse-spark",
        "contextWindow": 1_048_576, "outputTokens": 131_072,
        "supportsReasoning": true, "supportsVision": true, "supportsFunctionCalling": true,
        "reasoningLevels": levels, "reasoningOptions": [{"type": "effort", "values": levels}],
    });
    let keys = ["inputCostPerM", "outputCostPerM", "cacheReadCostPerM", "cacheWriteCostPerM"];
    for (key, value) in keys.iter().zip(cost) {
        row[*key] = crate::service::admin_route::jnum(value);
    }
    row
}

/// `/^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/i`: (major, minor, patch text, contributor).
fn spark_id(id: &str) -> Option<(u64, u64, Option<u64>, bool)> {
    let lower = id.to_ascii_lowercase();
    let rest = lower.strip_prefix("muse-spark-")?;
    let (rest, contributor) = match rest.strip_suffix("-contributor") {
        Some(r) => (r, true),
        None => (rest, false),
    };
    let mut parts = rest.split('.');
    let number = |p: Option<&str>| p.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse().ok());
    let major = number(parts.next())?;
    let minor = number(parts.next())?;
    let patch = match parts.next() {
        Some(p) => Some(number(Some(p))?),
        None => None,
    };
    parts.next().is_none().then_some((major, minor, patch, contributor))
}

fn muse_lineage(id: &str) -> Option<Value> {
    let (major, minor, patch, contributor) = spark_id(id)?;
    let mut template: Option<(&str, (u64, u64, u64))> = None;
    for (seed_id, ..) in MUSE_SEEDS {
        let (smajor, sminor, spatch, scontributor) = spark_id(seed_id)?;
        if scontributor != contributor {
            continue;
        }
        let revision = (smajor, sminor, spatch.unwrap_or(0));
        if template.is_none_or(|(_, current)| revision > current) {
            template = Some((seed_id, revision));
        }
    }
    let (template, _) = template?;
    let revision = match patch {
        Some(p) if p != 0 => format!("{major}.{minor}.{p}"),
        _ => format!("{major}.{minor}"),
    };
    let cost = if MUSE_SEEDS.iter().any(|s| s.0 == template && s.3) { CONTRIBUTOR_COST } else { STANDARD_COST };
    let name = format!("Muse Spark {revision}{}", if contributor { " (C)" } else { "" });
    Some(muse_row(id, &name, &MUSE_DEFAULT, cost))
}

/// `museSeedRow`: a seeded id, else the lineage row of a revisioned Spark id.
fn muse_seed(id: &str) -> Option<Value> {
    if let Some((seed_id, name, six, contributor)) = MUSE_SEEDS.iter().find(|s| s.0 == id) {
        let cost = if *contributor { CONTRIBUTOR_COST } else { STANDARD_COST };
        return Some(muse_row(seed_id, name, if *six { &MUSE_SIX } else { &MUSE_DEFAULT }, cost));
    }
    muse_lineage(id)
}

/// id, display name, context window.
const MIMO_SEEDS: [(&str, &str, u64); 7] = [
    ("mimo-v2.6-pro", "MiMo-V2.6-Pro", 1_048_576),
    ("mimo-v2.6-flash", "MiMo-V2.6-Flash", 1_048_576),
    ("mimo-v2.6-pro-ultraspeed", "MiMo-V2.6-Pro-Ultraspeed", 1_048_576),
    ("mimo-v2.5-pro", "MiMo-V2.5-Pro", 1_048_576),
    ("mimo-v2.5", "MiMo-V2.5", 1_048_576),
    ("mimo-v2-pro", "MiMo-V2-Pro", 1_048_576),
    ("mimo-v2-omni", "MiMo-V2-Omni", 262_144),
];

/// `seedModelItems()`: the roster a provider shows when its listing is empty
/// or cannot be read (id, display name); none for a provider without one.
pub fn seed_roster(provider: &str) -> Vec<(&'static str, &'static str)> {
    match provider_catalog_entry(provider).and_then(|e| e.seed) {
        Some(Seed::Mimo) => MIMO_SEEDS.iter().map(|s| (s.0, s.1)).collect(),
        _ => Vec::new(),
    }
}

/// The display name `providerSeedRow` gives a model (`museSeedRow(id).name`).
pub fn seed_display_name(provider: &str, model: &str) -> Option<String> {
    let entry = provider_catalog_entry(provider)?;
    seed_row(&entry, model)?.get("name")?.as_str().map(str::to_owned)
}

/// `mimoSeedMetadata(model)`: the exact seed id, else the longest seed whose
/// id is a lineage prefix of the model.
fn mimo_seed(model: &str) -> Option<Value> {
    let id = model.to_lowercase();
    let mut seed = MIMO_SEEDS.iter().find(|s| s.0 == id);
    if seed.is_none() {
        for item in &MIMO_SEEDS {
            let prefixed = id.strip_prefix(item.0).is_some_and(|r| r.starts_with('-'));
            if prefixed && seed.is_none_or(|s| item.0.len() > s.0.len()) {
                seed = Some(item);
            }
        }
    }
    let seed = seed?;
    Some(json!({"contextWindow": seed.2, "outputTokens": 131_072, "supportsReasoning": true, "supportsVision": true}))
}

/// `providerSeedRow(provider, model)`.
pub fn seed_row(entry: &Entry, model: &str) -> Option<Value> {
    match entry.seed? {
        Seed::Muse => muse_seed(model),
        Seed::Mimo => mimo_seed(model),
    }
}

// ── identities ─────────────────────────────────────────────────────────────

/// `normalizeGrokModelId`.
pub fn normalize_grok_model_id(id: &str) -> &str {
    match id {
        "grok-code-fast-1" | "grok-code-fast" | "grok-code-fast-1-0825" => "grok-build-0.1",
        other => other,
    }
}

/// `ANTIGRAVITY_MODELS`: (id, wire ids) of the fallback rows; `wire` is the
/// tier map's values or the single wire id.
pub const ANTIGRAVITY_FALLBACK: [(&str, &[&str]); 6] = [
    ("gemini-3.8-flash", &["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]),
    ("gemini-3.1-pro", &["gemini-3.1-pro-low", "gemini-3.1-pro-high"]),
    ("gemini-4-argon", &["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]),
    ("claude-opus-4-6-thinking", &["claude-opus-4-6-thinking"]),
    ("claude-sonnet-4-6", &["claude-sonnet-4-6"]),
    ("gpt-oss-120b-medium", &["gpt-oss-120b-medium"]),
];

/// `ANTIGRAVITY_PRICING_ALIASES`.
pub fn antigravity_pricing_alias(id: &str) -> &str {
    if id == "claude-opus-4-6-thinking" { "claude-opus-4-6" } else { id }
}
