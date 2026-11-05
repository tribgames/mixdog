//! `model-pricing-rates.mjs`: every source's price columns normalized to USD
//! per million tokens before merging.

use serde_json::Map;
use serde_json::Value;

use crate::service::admin_route::jnum;

pub type Obj = Map<String, Value>;

pub const RATE_KEYS: [&str; 4] = ["inputCostPerM", "outputCostPerM", "cacheReadCostPerM", "cacheWriteCostPerM"];
const LITELLM_KEYS: [&str; 4] =
    ["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"];
const MODELSDEV_KEYS: [&str; 4] = ["input", "output", "cache_read", "cache_write"];

/// `validRate`: a finite, non-negative number.
fn valid_rate(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
}

fn rates(source: Option<&Value>, keys: [String; 4], multiplier: f64) -> Obj {
    RATE_KEYS
        .iter()
        .zip(keys)
        .map(|(key, source_key)| {
            let rate = valid_rate(source.and_then(|s| s.get(&source_key))).map_or(Value::Null, |n| jnum(n * multiplier));
            ((*key).to_owned(), rate)
        })
        .collect()
}

fn suffixed(keys: &[&str; 4], tail: &str) -> [String; 4] {
    keys.map(|key| format!("{key}{tail}"))
}

/// The threshold of a `<prefix>_above_<N>k_tokens<suffix>` column, in tokens.
fn tier_threshold(key: &str, suffix: &str) -> Option<u64> {
    LITELLM_KEYS.iter().find_map(|prefix| {
        let rest = key.strip_prefix(prefix)?.strip_prefix("_above_")?;
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let (number, tail) = rest.split_at(digits);
        (digits > 0 && tail.strip_prefix("k_tokens") == Some(suffix)).then(|| number.parse::<u64>().ok()).flatten()
    })
    .map(|k| k * 1000)
}

/// `litellmPricing(entry, suffix)`: `suffix` selects a service-tier column set (`_priority`).
pub fn litellm_pricing(entry: Option<&Value>, suffix: &str) -> Obj {
    let mut thresholds: Vec<u64> = entry
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|o| o.keys())
        .filter_map(|key| tier_threshold(key, suffix))
        .collect();
    thresholds.sort_unstable();
    thresholds.dedup();
    let mut out = rates(entry, suffixed(&LITELLM_KEYS, suffix), 1_000_000.0);
    let tiers = thresholds
        .into_iter()
        .map(|above| {
            let mut tier = Obj::new();
            tier.insert("aboveInputTokens".into(), Value::from(above));
            let tail = format!("_above_{}k_tokens{suffix}", above / 1000);
            tier.extend(rates(entry, suffixed(&LITELLM_KEYS, &tail), 1_000_000.0));
            Value::Object(tier)
        })
        .collect();
    out.insert("pricingTiers".into(), Value::Array(tiers));
    out
}

/// `litellmMediaPricing(entry)`: non-token media rates.
pub fn litellm_media_pricing(entry: Option<&Value>) -> Obj {
    let per_m = |key: &str| valid_rate(entry.and_then(|e| e.get(key))).map_or(Value::Null, |n| jnum(n * 1_000_000.0));
    let plain = |key: &str| valid_rate(entry.and_then(|e| e.get(key))).map_or(Value::Null, jnum);
    let mut by_resolution = Obj::new();
    for (key, value) in entry.and_then(Value::as_object).into_iter().flatten() {
        if let Some(resolution) = key.strip_prefix("output_cost_per_second_").filter(|r| !r.is_empty())
            && let Some(rate) = valid_rate(Some(value))
        {
            by_resolution.insert(resolution.to_lowercase(), jnum(rate));
        }
    }
    let mut out = Obj::new();
    out.insert("outputImageCostPerM".into(), per_m("output_cost_per_image_token"));
    out.insert("outputVideoCostPerM".into(), per_m("output_cost_per_video_token"));
    out.insert("outputCostPerImage".into(), plain("output_cost_per_image"));
    out.insert("outputCostPerSecond".into(), plain("output_cost_per_second"));
    out.insert("outputCostPerSecondByResolution".into(), Value::Object(by_resolution));
    out
}

/// `modelsDevPricing(cost)`: structured tiers supersede the older
/// `context_over_200k` field.
pub fn models_dev_pricing(cost: Option<&Value>) -> Obj {
    let plain = |row: &Value| rates(Some(row), MODELSDEV_KEYS.map(str::to_owned), 1.0);
    let mut tiers: Vec<(f64, Obj)> = Vec::new();
    if let Some(rows) = cost.and_then(|c| c.get("tiers")).and_then(Value::as_array) {
        for row in rows {
            let tier = row.get("tier");
            let size = tier.and_then(|t| t.get("size")).and_then(Value::as_f64);
            if tier.and_then(|t| t.get("type")).and_then(Value::as_str) == Some("context")
                && let Some(size) = size.filter(|s| s.is_finite() && *s > 0.0)
            {
                let mut entry = Obj::new();
                entry.insert("aboveInputTokens".into(), jnum(size));
                entry.extend(plain(row));
                tiers.push((size, entry));
            }
        }
    } else if let Some(over) = cost.and_then(|c| c.get("context_over_200k")).filter(|v| crate::service::admin_route::truthy(Some(v))) {
        let mut entry = Obj::new();
        entry.insert("aboveInputTokens".into(), Value::from(200_000));
        entry.extend(plain(over));
        tiers.push((200_000.0, entry));
    }
    tiers.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = match cost {
        Some(c) => plain(c),
        None => rates(None, MODELSDEV_KEYS.map(str::to_owned), 1.0),
    };
    out.insert("pricingTiers".into(), Value::Array(tiers.into_iter().map(|(_, t)| Value::Object(t)).collect()));
    out
}
