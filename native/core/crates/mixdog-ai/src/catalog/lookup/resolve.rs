//! `lookupModelMetadata` of `model-catalog.mjs`, layer by layer: the
//! provider's live roster, the catalog rows under its models.dev id (in full
//! when that entry is the same endpoint, otherwise pricing only), verified
//! corrections, offline seeds, and the vendor row a relay, a same-vendor
//! other endpoint or a custom provider takes as a first guess for
//! capabilities and the effort ladder (never limits).
//!
//! A value JavaScript leaves `undefined` is an absent key here. The
//! relay-vendor guess reads facts only: the vendor a catalog lists the id
//! under (LiteLLM's `litellm_provider` field, a models.dev row of the id);
//! no model name is pattern-matched.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::rates::Obj;
use super::rates::RATE_KEYS;
use super::rates::litellm_media_pricing;
use super::rates::litellm_pricing;
use super::rates::models_dev_pricing;
use super::registry;
use super::registry::Entry;
use crate::catalog::rosters::RosterSnapshot;
use crate::service::admin_route::jnum;
use crate::service::admin_route::number;
use crate::service::admin_route::truthy;

const SIMPLE_PREFIXES: [&str; 10] = [
    "anthropic/",
    "openai/",
    "gemini/",
    "google/",
    "xai/",
    "azure_ai/",
    "deepseek/",
    "openrouter/anthropic/",
    "openrouter/openai/",
    "vertex_ai/",
];
const BEDROCK_PREFIXES: [&str; 2] = ["anthropic.", "bedrock/anthropic."];

const CAPABILITY_FLAGS: [&str; 6] = [
    "supportsVision",
    "supportsFunctionCalling",
    "supportsWebSearch",
    "supportsPromptCaching",
    "supportsFastMode",
    "supportsReasoning",
];
const GUESSED_FLAGS: [&str; 5] =
    ["supportsVision", "supportsFunctionCalling", "supportsWebSearch", "supportsPromptCaching", "supportsReasoning"];
const PRICING_FIELDS: [&str; 17] = [
    "inputCostPerM",
    "outputCostPerM",
    "cacheReadCostPerM",
    "cacheWriteCostPerM",
    "pricingTiers",
    "fastPricing",
    "ultrafastPricing",
    "flexPricing",
    "offPeakMultiplier",
    "outputImageCostPerM",
    "outputVideoCostPerM",
    "outputCostPerImage",
    "outputCostPerSecond",
    "outputCostPerSecondByResolution",
    "pricingSource",
    "pricingProvider",
    "supportsPromptCaching",
];

fn nn(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null))
}

/// `a || b || ...`: the first truthy value.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|v| truthy(*v)).flatten()
}

fn or_null(v: Option<&Value>) -> Value {
    v.cloned().unwrap_or(Value::Null)
}

fn put(o: &mut Obj, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            o.insert(key.into(), v);
        }
        None => {
            o.shift_remove(key);
        }
    }
}

/// `capabilityFlag`: a declared boolean stays; anything else is undeclared.
fn capability(v: Option<&Value>) -> Option<Value> {
    v.filter(|v| v.is_boolean()).cloned()
}

fn has_rates(meta: Option<&Obj>) -> bool {
    meta.is_some_and(|m| RATE_KEYS.iter().any(|k| nn(m.get(*k))))
}

fn rate_set_has_rates(set: &Value) -> bool {
    RATE_KEYS.iter().any(|k| nn(set.get(*k)))
}

fn is_array_nonempty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_array).is_some_and(|a| !a.is_empty())
}

/// `_normalize(entry)`: a LiteLLM-shaped row as metadata.
pub fn normalize(entry: &Value) -> Option<Obj> {
    let e = entry.as_object()?;
    let mut m = Obj::new();
    m.insert("contextWindow".into(), or_null(first_truthy(&[e.get("max_input_tokens"), e.get("max_tokens")])));
    m.insert("outputTokens".into(), or_null(first_truthy(&[e.get("max_output_tokens")])));
    m.extend(litellm_pricing(Some(entry), ""));
    m.extend(litellm_media_pricing(Some(entry)));
    for (suffix, key) in [("_priority", "fastPricing"), ("_ultrafast", "ultrafastPricing"), ("_flex", "flexPricing")] {
        let set = Value::Object(litellm_pricing(Some(entry), suffix));
        if rate_set_has_rates(&set) {
            m.insert(key.into(), set);
        }
    }
    if truthy(e.get("off_peak_multiplier")) {
        m.insert("offPeakMultiplier".into(), e["off_peak_multiplier"].clone());
    }
    if number(e.get("regional_endpoint_uplift_multiplier")) > 0.0 {
        m.insert("regionalUplift".into(), e["regional_endpoint_uplift_multiplier"].clone());
    }
    put(&mut m, "supportsVision", capability(e.get("supports_vision")));
    put(&mut m, "supportsFunctionCalling", capability(e.get("supports_function_calling")));
    let web = if e.get("supports_web_search") == Some(&Value::Bool(true)) || e.get("supports_websearch") == Some(&Value::Bool(true)) {
        Some(Value::Bool(true))
    } else {
        capability(e.get("supports_web_search")).or_else(|| capability(e.get("supports_websearch")))
    };
    put(&mut m, "supportsWebSearch", web);
    put(&mut m, "supportsPromptCaching", capability(e.get("supports_prompt_caching")));
    put(&mut m, "supportsFastMode", capability(e.get("supports_fast_mode")));
    put(&mut m, "supportsReasoning", capability(e.get("supports_reasoning")));
    let options = e.get("reasoning_options").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
    m.insert("reasoningOptions".into(), options);
    m.insert("reasoningContentField".into(), or_null(first_truthy(&[e.get("reasoning_content_field")])));
    m.insert("mode".into(), or_null(first_truthy(&[e.get("mode")])));
    Some(m)
}

fn blank() -> Obj {
    normalize(&json!({})).expect("an object")
}

/// `effortEntry(options)`.
fn effort_entry(options: Option<&Value>) -> Option<Value> {
    options?.as_array()?.iter().find(|o| o.get("type").and_then(Value::as_str) == Some("effort")).cloned()
}

fn merged_reasoning_options(base: &Obj, overlay: &Obj) -> Value {
    if is_array_nonempty(overlay.get("reasoningOptions")) {
        return overlay["reasoningOptions"].clone();
    }
    let reasoning = if nn(overlay.get("supportsReasoning")) { overlay.get("supportsReasoning") } else { base.get("supportsReasoning") };
    if reasoning == Some(&Value::Bool(false)) {
        return json!([]);
    }
    first_truthy(&[base.get("reasoningOptions")]).cloned().unwrap_or_else(|| json!([]))
}

/// `mergeModelMetadata(base, overlay, { preserveBaseCosts, preserveBaseLimits })`.
fn merge_metadata(base: Option<Obj>, overlay: Option<Obj>, preserve_costs: bool, preserve_limits: bool) -> Option<Obj> {
    let Some(base) = base else { return overlay };
    let Some(overlay) = overlay else { return Some(base) };
    let mut out = base.clone();
    let limit = |key: &str| {
        let (first, second) = if preserve_limits { (&base, &overlay) } else { (&overlay, &base) };
        or_null(first_truthy(&[first.get(key), second.get(key)]))
    };
    out.insert("contextWindow".into(), limit("contextWindow"));
    out.insert("outputTokens".into(), limit("outputTokens"));
    for key in RATE_KEYS {
        let value = if !preserve_costs && nn(overlay.get(key)) { overlay.get(key) } else { base.get(key) };
        put(&mut out, key, value.cloned());
    }
    let tiers = if !preserve_costs && is_array_nonempty(overlay.get("pricingTiers")) {
        overlay["pricingTiers"].clone()
    } else {
        first_truthy(&[base.get("pricingTiers")]).cloned().unwrap_or_else(|| json!([]))
    };
    out.insert("pricingTiers".into(), tiers);
    let source = if !preserve_costs && RATE_KEYS.iter().any(|k| nn(overlay.get(*k))) { overlay.get("pricingSource") } else { base.get("pricingSource") };
    put(&mut out, "pricingSource", source.cloned());
    for key in CAPABILITY_FLAGS {
        let value = if nn(overlay.get(key)) { overlay.get(key) } else { base.get(key) };
        put(&mut out, key, value.cloned());
    }
    out.insert("reasoningOptions".into(), merged_reasoning_options(&base, &overlay));
    out.insert("reasoningContentField".into(), or_null(first_truthy(&[overlay.get("reasoningContentField"), base.get("reasoningContentField")])));
    out.insert("mode".into(), or_null(first_truthy(&[base.get("mode"), overlay.get("mode")])));
    Some(out)
}

fn pricing_fields(meta: &Obj) -> Obj {
    PRICING_FIELDS.iter().filter_map(|k| meta.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect()
}

/// `pricingOnly`: a vendor row prices the model and lends its label.
fn pricing_only(meta: Option<&Obj>) -> Option<Obj> {
    let meta = meta?;
    let mut out = blank();
    out.extend(pricing_fields(meta));
    out.insert("displayName".into(), or_null(first_truthy(&[meta.get("displayName")])));
    Some(out)
}

fn with_vendor_guess(meta: Option<Obj>, guess: Option<&Obj>, ladder: bool, relay: bool) -> Option<Obj> {
    let Some(guess) = guess else { return meta };
    let mut out = meta.unwrap_or_else(blank);
    for key in GUESSED_FLAGS {
        if relay && key == "supportsWebSearch" {
            continue;
        }
        if !nn(out.get(key)) {
            put(&mut out, key, guess.get(key).cloned());
        }
    }
    let effort = effort_entry(guess.get("reasoningOptions"));
    if ladder
        && let Some(effort) = effort
        && out.get("supportsReasoning") != Some(&Value::Bool(false))
        && effort_entry(out.get("reasoningOptions")).is_none()
    {
        let mut options = out.get("reasoningOptions").and_then(Value::as_array).cloned().unwrap_or_default();
        options.push(effort);
        out.insert("reasoningOptions".into(), Value::Array(options));
    }
    Some(out)
}

fn with_seed_fallback(meta: Option<Obj>, seed: Option<&Value>, provider: &str) -> Option<Obj> {
    let Some(seed) = seed else { return meta };
    let mut out = meta.unwrap_or_else(blank);
    for key in CAPABILITY_FLAGS {
        if !nn(out.get(key)) {
            put(&mut out, key, capability(seed.get(key)));
        }
    }
    if !truthy(out.get("displayName")) && truthy(seed.get("name")) {
        out.insert("displayName".into(), seed["name"].clone());
    }
    for key in ["contextWindow", "outputTokens"] {
        if !truthy(out.get(key)) && truthy(seed.get(key)) {
            out.insert(key.into(), seed[key].clone());
        }
    }
    if !is_array_nonempty(out.get("reasoningOptions"))
        && is_array_nonempty(seed.get("reasoningOptions"))
        && out.get("supportsReasoning") != Some(&Value::Bool(false))
    {
        out.insert("reasoningOptions".into(), seed["reasoningOptions"].clone());
    }
    if !has_rates(Some(&out)) && rate_set_has_rates(seed) {
        for key in RATE_KEYS {
            out.insert(key.into(), or_null(seed.get(key)));
        }
        out.insert("pricingTiers".into(), json!([]));
        out.insert("pricingSource".into(), json!("seed"));
        out.insert("pricingProvider".into(), json!(provider));
    }
    Some(out)
}

fn listed_rates(row: &Value) -> Obj {
    let mut out: Obj = RATE_KEYS.iter().map(|k| ((*k).to_owned(), or_null(row.get(*k)))).collect();
    let tiers = row.get("pricingTiers").and_then(Value::as_array).map_or_else(Vec::new, |tiers| {
        tiers
            .iter()
            .map(|tier| {
                let mut t = Obj::new();
                t.insert("aboveInputTokens".into(), or_null(tier.get("aboveInputTokens")));
                t.extend(RATE_KEYS.iter().map(|k| ((*k).to_owned(), or_null(tier.get(*k)))));
                Value::Object(t)
            })
            .collect()
    });
    out.insert("pricingTiers".into(), Value::Array(tiers));
    out
}

fn scaled_rates(row: Option<&Value>, factor: f64) -> Obj {
    RATE_KEYS
        .iter()
        .map(|k| {
            let scaled = row.and_then(|r| r.get(*k)).filter(|v| !v.is_null()).map_or(Value::Null, |v| jnum(number(Some(v)) * factor));
            ((*k).to_owned(), scaled)
        })
        .collect()
}

/// `modelsDevDisplayName`: the label without marketing tails such as
/// `(New)` or a `Contributor` program tier.
fn models_dev_display_name(row: &Value) -> Value {
    let Some(name) = row.get("name").and_then(Value::as_str) else { return Value::Null };
    let mut text = name.to_owned();
    // /\s*\([^)]*\)\s*$/
    let trimmed = mixdog_js::js_trim_end(&text).to_owned();
    if let Some(body) = trimmed.strip_suffix(')') {
        let from = body.rfind(')').map_or(0, |i| i + 1);
        if let Some(open) = body[from..].find('(') {
            let start = from + open;
            text = mixdog_js::js_trim_end(&body[..start]).to_owned();
        }
    }
    // /\s+contributor$/i
    let lower = text.to_ascii_lowercase();
    if lower.ends_with("contributor") {
        let head = &text[..text.len() - "contributor".len()];
        let without = mixdog_js::js_trim_end(head);
        if without.len() < head.len() {
            text = without.to_owned();
        }
    }
    let cleaned = mixdog_js::js_trim(&text);
    if cleaned.is_empty() { Value::Null } else { json!(cleaned) }
}

/// `_modelsDevMetadata(row)`: capabilities share the metadata schema; prices stay in $/M.
fn models_dev_metadata(row: &Value) -> Obj {
    let cost = row.get("cost").filter(|c| truthy(Some(c)));
    let empty = json!({});
    let cost_or_empty = cost.unwrap_or(&empty);
    let mut raw = Map::new();
    put(&mut raw, "max_input_tokens", row.pointer("/limit/context").cloned());
    put(&mut raw, "max_output_tokens", row.pointer("/limit/output").cloned());
    raw.insert("mode".into(), json!("chat"));
    put(&mut raw, "supports_reasoning", capability(row.get("reasoning")));
    let options = row.get("reasoning_options").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
    raw.insert("reasoning_options".into(), options);
    put(&mut raw, "reasoning_content_field", row.pointer("/interleaved/field").filter(|v| truthy(Some(v))).cloned());
    put(&mut raw, "supports_function_calling", capability(row.get("tool_call")));
    let vision = row.pointer("/modalities/input").and_then(Value::as_array).map(|a| Value::Bool(a.iter().any(|m| m.as_str() == Some("image"))));
    put(&mut raw, "supports_vision", vision);
    put(&mut raw, "supports_prompt_caching", nn(cost_or_empty.get("cache_read")).then_some(Value::Bool(true)));
    let mut out = normalize(&Value::Object(raw)).expect("an object");
    out.extend(models_dev_pricing(Some(cost_or_empty)));
    out.insert("pricingSource".into(), if cost.is_some() { json!("models.dev") } else { Value::Null });
    out
}

/// What a roster row states (`rosterRowMetadata`).
pub fn roster_row_metadata(provider: &str, row: &Value) -> Obj {
    let p = mixdog_js::js_trim(provider).to_lowercase();
    let num = |v: Option<&Value>| {
        let n = number(v);
        if n.is_finite() && n > 0.0 { jnum(n.floor()) } else { Value::Null }
    };
    fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
        if nn(a) { a } else { b }
    }
    let window = nullish(
        nullish(nullish(nullish(row.get("contextWindow"), row.get("context_window")), row.get("maxContextWindow")), row.get("max_context_window")),
        row.get("max_input_tokens"),
    );
    let output = if p == "grok-oauth" {
        Value::Null
    } else {
        num(nullish(nullish(nullish(row.get("outputTokens"), row.get("maxOutputTokens")), row.get("max_output_tokens")), row.get("output_token_limit")))
    };
    let flag = |key: &str| (row.get(key) == Some(&Value::Bool(true))).then_some(Value::Bool(true));
    let mut m = Obj::new();
    m.insert("contextWindow".into(), num(window));
    m.insert("outputTokens".into(), output);
    put(&mut m, "supportsVision", flag("supportsVision"));
    put(&mut m, "supportsFunctionCalling", flag("supportsFunctionCalling"));
    put(&mut m, "supportsWebSearch", flag("supportsWebSearch"));
    put(&mut m, "supportsPromptCaching", flag("supportsPromptCaching"));
    put(&mut m, "supportsReasoning", flag("supportsReasoning"));
    m.insert("reasoningOptions".into(), roster_reasoning_options(row));
    m.insert("reasoningContentField".into(), or_null(first_truthy(&[row.get("reasoningContentField")])));
    m.insert("mode".into(), or_null(first_truthy(&[row.get("mode")])));
    m.insert("displayName".into(), or_null(first_truthy(&[row.get("displayName"), row.get("display"), row.get("name")])));
    m.insert("name".into(), or_null(first_truthy(&[row.get("name"), row.get("display")])));
    m.insert("rawProviderModel".into(), row.clone());
    m
}

/// `rosterReasoningOptions(row)`.
fn roster_reasoning_options(row: &Value) -> Value {
    let options: Vec<Value> = row.get("reasoningOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    let usable: Vec<Value> = options
        .into_iter()
        .filter(|o| o.get("type").and_then(Value::as_str) != Some("effort") || is_array_nonempty(o.get("values")))
        .collect();
    if usable.iter().any(|o| o.get("type").and_then(Value::as_str) == Some("effort")) {
        return Value::Array(usable);
    }
    let levels: Vec<Value> = row
        .get("reasoningLevels")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|v| v.is_string()).cloned().collect())
        .unwrap_or_default();
    if levels.is_empty() {
        return Value::Array(usable);
    }
    let mut all = usable;
    all.push(json!({"type": "effort", "values": levels}));
    Value::Array(all)
}

/// The resident tables a lookup reads; none of it does I/O.
pub struct Lookup<'a> {
    pub litellm: &'a Value,
    pub models_dev: &'a Value,
    pub rosters: &'a RosterSnapshot,
}

fn is_custom(provider: &str) -> bool {
    provider.starts_with("custom-")
}

impl Lookup<'_> {
    /// `providerPricingModelSync`: only explicit catalog wire mappings establish an alias.
    pub fn pricing_model(&self, provider: &str, model: &str) -> String {
        if provider == "grok-oauth" {
            return registry::normalize_grok_model_id(model).to_owned();
        }
        if provider != "antigravity-oauth" {
            return model.to_owned();
        }
        let wire_matches = |wire: Option<&Value>| match wire {
            Some(Value::String(s)) => s == model,
            Some(Value::Object(o)) => o.values().any(|v| v.as_str() == Some(model)),
            _ => false,
        };
        let cached = self.rosters.cached_models(provider);
        let found = cached.iter().find_map(|row| {
            (row.get("id").and_then(Value::as_str) == Some(model) || wire_matches(row.get("wire")))
                .then(|| first_truthy(&[row.get("pricingModel"), row.get("id")]).and_then(Value::as_str).map(str::to_owned))
        });
        let id = match found {
            Some(id) => id.unwrap_or_else(|| model.to_owned()),
            None => registry::ANTIGRAVITY_FALLBACK
                .iter()
                .find(|(id, wires)| *id == model || wires.contains(&model))
                .map_or_else(|| model.to_owned(), |(id, _)| (*id).to_owned()),
        };
        registry::antigravity_pricing_alias(&id).to_owned()
    }

    fn catalog_row(&self, key: &str) -> Option<&Value> {
        self.litellm.get(key).filter(|v| truthy(Some(v)))
    }

    /// Override → LiteLLM → models.dev rows under one catalog provider id.
    fn catalog_metadata(&self, id: &str, mapped: Option<&str>) -> Option<Obj> {
        let mut meta: Option<Obj> = None;
        let provider_matches = |row: &Value| {
            mapped.is_none_or(|m| {
                row.get("litellm_provider").and_then(Value::as_str).and_then(registry::models_dev_provider_id).as_deref() == Some(m)
            })
        };
        if let Some(ov) = registry::PRICING_OVERRIDES.get(id)
            && provider_matches(ov)
        {
            let mut m = normalize(ov).expect("an object");
            m.insert("pricingSource".into(), json!("override"));
            meta = Some(m);
        }
        let from_override = meta.is_some();
        let litellm = |row: &Value| {
            let mut m = normalize(row).unwrap_or_default();
            m.insert("pricingSource".into(), json!("litellm"));
            m
        };
        if meta.is_none() {
            if let Some(row) = self.catalog_row(id).filter(|r| provider_matches(r)) {
                meta = Some(litellm(row));
            }
            let prefixes: Vec<&str> = match mapped {
                None => SIMPLE_PREFIXES.to_vec(),
                Some(m) => {
                    let allowed: &[&str] = match m {
                        "openai" => &["openai/"],
                        "anthropic" => &["anthropic/"],
                        "google" => &["gemini/", "google/"],
                        "xai" => &["xai/"],
                        "deepseek" => &["deepseek/"],
                        "azure" => &["azure_ai/"],
                        "google-vertex" => &["vertex_ai/"],
                        _ => &[],
                    };
                    SIMPLE_PREFIXES.iter().copied().filter(|p| allowed.contains(p)).collect()
                }
            };
            for prefix in prefixes {
                if meta.is_some() {
                    break;
                }
                if let Some(row) = self.catalog_row(&format!("{prefix}{id}")) {
                    meta = Some(litellm(row));
                }
            }
            if mapped.is_none_or(|m| m == "anthropic") {
                for prefix in BEDROCK_PREFIXES {
                    if meta.is_some() {
                        break;
                    }
                    if let Some(row) = self.catalog_row(&format!("{prefix}{id}-v1:0")) {
                        meta = Some(litellm(row));
                    }
                }
            }
        }
        if let Some(mapped) = mapped {
            let row = self.models_dev.get(mapped).and_then(|p| p.get("models")).and_then(|m| m.get(id)).filter(|r| truthy(Some(r)));
            if let Some(row) = row {
                meta = merge_metadata(meta, Some(models_dev_metadata(row)), from_override, from_override);
                let mut m = meta.unwrap_or_default();
                m.insert("displayName".into(), models_dev_display_name(row));
                meta = Some(m);
            }
        }
        meta
    }

    /// Vendors that served a relayed model, by provenance that does not
    /// depend on catalog entry order.
    fn relayed_model_vendors(&self, id: &str) -> Vec<String> {
        let is_vendor = |vendor: &str| !vendor.is_empty() && !vendor.starts_with("custom-") && !registry::provider_catalog_entry(vendor).is_some_and(|e| e.relay);
        let mut vendors: Vec<String> = Vec::new();
        let add = |vendor: String, vendors: &mut Vec<String>| {
            if !vendors.contains(&vendor) {
                vendors.push(vendor);
            }
        };
        let keys = std::iter::once(id.to_owned()).chain(SIMPLE_PREFIXES.iter().map(|p| format!("{p}{id}")));
        for key in keys {
            let vendor = self
                .litellm
                .get(&key)
                .and_then(|r| r.get("litellm_provider"))
                .and_then(Value::as_str)
                .and_then(registry::models_dev_provider_id);
            if let Some(vendor) = vendor.filter(|v| is_vendor(v)) {
                add(vendor, &mut vendors);
            }
        }
        let has_model = |vendor: &str| self.models_dev.get(vendor).and_then(|p| p.get("models")).and_then(|m| m.get(id)).is_some_and(|r| truthy(Some(r)));
        let first_party = registry::first_party_ids();
        for vendor in first_party {
            if has_model(vendor) {
                add(vendor.to_owned(), &mut vendors);
            }
        }
        let unregistered: Vec<&String> = self
            .models_dev
            .as_object()
            .into_iter()
            .flat_map(|o| o.keys())
            .filter(|v| has_model(v) && !first_party.contains(&v.as_str()) && is_vendor(v))
            .collect();
        if let [only] = unregistered.as_slice() {
            add((*only).clone(), &mut vendors);
        }
        vendors
    }

    /// The row of the vendor serving a relayed or custom model id.
    fn serving_vendor_metadata(&self, id: &str) -> Option<Obj> {
        let mut candidates = vec![id.to_owned()];
        let hyphenated = dots_to_hyphens(id);
        if hyphenated != id {
            candidates.push(hyphenated);
        }
        for candidate in candidates {
            for vendor in self.relayed_model_vendors(&candidate) {
                if let Some(row) = self.lookup(&candidate, &vendor, None) {
                    return Some(row);
                }
            }
        }
        None
    }

    fn custom_vendor_metadata(&self, original_id: &str) -> Option<Obj> {
        let tail = original_id.rsplit_once('/').map_or(original_id, |(_, t)| t);
        let mut ids = vec![original_id];
        if tail != original_id {
            ids.push(tail);
        }
        ids.into_iter().filter(|id| !id.is_empty()).find_map(|id| self.serving_vendor_metadata(id))
    }

    /// `lookupModelMetadata(originalId, provider, catalog, modelsDevCatalog, listedRow)`.
    pub fn lookup(&self, original_id: &str, provider: &str, listed: Option<&Value>) -> Option<Obj> {
        let custom = is_custom(provider);
        let id = self.pricing_model(provider, original_id);
        let source: Option<Entry> = if provider.is_empty() { None } else { registry::provider_catalog_entry(provider) };
        let mapped_provider = source.as_ref().map(|s| s.models_dev.clone());
        let mapped = self.catalog_metadata(&id, mapped_provider.as_deref());
        let mut meta = if source.as_ref().is_some_and(|s| !s.same_endpoint) { pricing_only(mapped.as_ref()) } else { mapped.clone() };
        let correction = source.as_ref().and_then(|_| registry::metadata_correction(provider, &id));
        if let (Some(m), Some(c)) = (meta.as_mut(), correction) {
            m.extend(c);
        }
        let mut guess: Option<Obj> = None;
        let relay_guess = if source.as_ref().is_some_and(|s| s.relay) { self.serving_vendor_metadata(&id) } else { None };
        if custom {
            guess = self.custom_vendor_metadata(original_id);
        } else if relay_guess.is_some() {
            guess = relay_guess.clone();
        } else if source.as_ref().is_some_and(|s| !s.same_endpoint) {
            guess = mapped.clone();
        }
        if source.as_ref().is_some_and(|s| s.relay) && !has_rates(meta.as_ref()) && has_rates(guess.as_ref()) {
            let lent = pricing_fields(guess.as_ref().expect("has rates"));
            meta = match meta {
                Some(mut m) => {
                    m.extend(lent);
                    Some(m)
                }
                None => pricing_only(guess.as_ref()),
            };
        }
        let source_provider = source.as_ref().map_or("", |s| s.provider.as_str());
        if let Some(variant) = registry::priced_variant(source_provider, &id)
            && !has_rates(meta.as_ref())
            && let Some(base) = self.lookup(&variant.base, provider, None)
            && RATE_KEYS.iter().any(|k| nn(base.get(*k)))
        {
            let multiplier = variant.row_multiplier.and_then(|k| base.get(k)).filter(|v| truthy(Some(v)));
            let factor = multiplier.map_or(variant.rate_multiplier, |v| number(Some(v)));
            let scaled = |set: &Value| {
                let mut out = scaled_rates(Some(set), factor);
                let tiers: Vec<Value> = set
                    .get("pricingTiers")
                    .and_then(Value::as_array)
                    .map(|tiers| {
                        tiers
                            .iter()
                            .map(|tier| {
                                let mut t = tier.as_object().cloned().unwrap_or_default();
                                t.extend(scaled_rates(Some(tier), factor));
                                Value::Object(t)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                out.insert("pricingTiers".into(), Value::Array(tiers));
                out
            };
            let base_value = Value::Object(base.clone());
            let mut m = meta.take().unwrap_or_default();
            m.extend(scaled(&base_value));
            for key in ["fastPricing", "ultrafastPricing", "flexPricing"] {
                if let Some(set) = base.get(key).filter(|v| truthy(Some(v))) {
                    m.insert(key.into(), Value::Object(scaled(set)));
                }
            }
            put(&mut m, "pricingSource", base.get("pricingSource").cloned());
            put(&mut m, "supportsPromptCaching", base.get("supportsPromptCaching").cloned());
            meta = Some(m);
        }
        let cursor_row = matches!(source_provider, "cursor-oauth" | "cursor-api").then(|| registry::CURSOR_PRICING.get(id.as_str())).flatten();
        if let Some(row) = cursor_row {
            if !has_rates(meta.as_ref()) {
                let mut m = meta.take().unwrap_or_default();
                m.extend(listed_rates(row));
                m.insert("pricingSource".into(), json!("override"));
                meta = Some(m);
            }
            if let Some(fast) = row.get("fast") {
                let mut m = meta.take().unwrap_or_default();
                m.insert("fastPricing".into(), Value::Object(listed_rates(fast)));
                meta = Some(m);
            }
        }
        let cached = if provider.is_empty() {
            None
        } else {
            self.rosters.row(source_provider, original_id).map(|row| roster_row_metadata(provider, row))
        };
        let seed = source.as_ref().and_then(|s| registry::seed_row(s, original_id));
        if meta.is_none() && cached.is_none() && seed.is_none() && guess.is_none() {
            return None;
        }
        let listed_meta = listed.map(|row| roster_row_metadata(provider, row));
        if custom && meta.is_none() && cached.is_none() {
            let with = with_vendor_guess(listed_meta, guess.as_ref(), true, false).unwrap_or_default();
            let guess = guess.unwrap_or_default();
            let mut out: Obj = GUESSED_FLAGS.iter().filter_map(|k| with.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect();
            out.insert("reasoningOptions".into(), first_truthy(&[with.get("reasoningOptions")]).cloned().unwrap_or_else(|| json!([])));
            out.insert("reasoningContentField".into(), or_null(first_truthy(&[with.get("reasoningContentField"), guess.get("reasoningContentField")])));
            return Some(out);
        }
        for roster in [cached.clone(), listed_meta].into_iter().flatten() {
            let authoritative = source.as_ref().is_some_and(|s| s.roster_limits_authoritative);
            meta = merge_metadata(meta, Some(roster), true, !authoritative);
        }
        meta = with_seed_fallback(meta, seed.as_ref(), source_provider);
        let ladders = [cached.as_ref().and_then(|c| c.get("rawProviderModel")), listed]
            .into_iter()
            .flatten()
            .any(|row| row.get("reasoningLevels").is_some_and(Value::is_array) || row.get("reasoningOptions").is_some_and(Value::is_array));
        let ladder_final = source.as_ref().is_some_and(|s| s.roster_ladder_final) && ladders;
        meta = with_vendor_guess(meta, guess.as_ref(), !ladder_final, relay_guess.is_some());
        let mut meta = meta?;
        meta.insert("pricingModel".into(), json!(id));
        // meta.pricingProvider || mappedProvider || provider || null
        let pricing_provider = match first_truthy(&[meta.get("pricingProvider")]) {
            Some(v) => v.clone(),
            None => match mapped_provider.as_deref().filter(|m| !m.is_empty()).or(Some(provider).filter(|p| !p.is_empty())) {
                Some(name) => json!(name),
                None => Value::Null,
            },
        };
        meta.insert("pricingProvider".into(), pricing_provider);
        Some(meta)
    }
}

/// `id.replace(/(\d)\.(\d)/g, '$1-$2')`: matches do not overlap.
fn dots_to_hyphens(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    let mut out = String::with_capacity(id.len());
    let mut i = 0;
    while i < chars.len() {
        if i + 2 < chars.len() && chars[i].is_ascii_digit() && chars[i + 1] == '.' && chars[i + 2].is_ascii_digit() {
            out.push(chars[i]);
            out.push('-');
            out.push(chars[i + 2]);
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// `enrichModels` for one listed row: the catalog's facts layered under the
/// row's own (provider-native limits stay authoritative).
pub fn enrich_model(lookup: &Lookup<'_>, listed: &Value) -> Value {
    let id = first_truthy(&[listed.get("id"), listed.get("name")]).and_then(Value::as_str);
    let Some(id) = id else { return listed.clone() };
    let provider = listed.get("provider").and_then(Value::as_str).unwrap_or("");
    let Some(meta) = lookup.lookup(id, provider, Some(listed)) else { return listed.clone() };
    let mut out = listed.as_object().cloned().unwrap_or_default();
    if truthy(meta.get("displayName")) && !truthy(listed.get("display")) {
        out.insert("display".into(), meta["displayName"].clone());
    }
    out.insert("contextWindow".into(), or_null(first_truthy(&[listed.get("contextWindow"), meta.get("contextWindow")])));
    out.insert("outputTokens".into(), or_null(first_truthy(&[listed.get("outputTokens"), meta.get("outputTokens")])));
    for key in ["inputCostPerM", "outputCostPerM", "cacheReadCostPerM", "cacheWriteCostPerM", "pricingTiers", "pricingModel", "pricingProvider", "pricingSource"] {
        put(&mut out, key, meta.get(key).cloned());
    }
    for key in GUESSED_FLAGS {
        put(&mut out, key, meta.get(key).cloned());
    }
    out.insert("reasoningOptions".into(), first_truthy(&[meta.get("reasoningOptions")]).cloned().unwrap_or_else(|| json!([])));
    out.insert("reasoningContentField".into(), or_null(first_truthy(&[meta.get("reasoningContentField"), listed.get("reasoningContentField")])));
    out.insert("mode".into(), or_null(first_truthy(&[meta.get("mode"), listed.get("mode")])));
    Value::Object(out)
}
