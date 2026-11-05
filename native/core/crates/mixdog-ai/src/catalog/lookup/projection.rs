//! `model-catalog-projection.mjs`: a published catalog narrowed to the fields
//! its readers touch, so the multi-MB original is not held resident. Disk
//! caches keep the full payload.

use serde_json::Value;

use super::rates::Obj;

const LITELLM_NUMBERS: [&str; 11] = [
    "max_input_tokens",
    "max_tokens",
    "max_output_tokens",
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
    "output_cost_per_image",
    "output_cost_per_image_token",
    "output_cost_per_video_token",
    "output_cost_per_second",
];
const LITELLM_FLAGS: [&str; 7] = [
    "supports_vision",
    "supports_function_calling",
    "supports_web_search",
    "supports_websearch",
    "supports_prompt_caching",
    "supports_reasoning",
    "supports_fast_mode",
];
const LITELLM_STRINGS: [&str; 3] = ["mode", "litellm_provider", "reasoning_content_field"];

fn finite(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

/// `^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|
/// cache_creation_input_token_cost)(?:_above_\d+k_tokens)?(?:_priority|_ultrafast|_flex)?$`
fn is_rate_column(field: &str) -> bool {
    const BASES: [&str; 4] = [
        "input_cost_per_token",
        "output_cost_per_token",
        "cache_read_input_token_cost",
        "cache_creation_input_token_cost",
    ];
    BASES.iter().any(|base| {
        let Some(mut rest) = field.strip_prefix(base) else { return false };
        if let Some(tier) = rest.strip_prefix("_above_") {
            let digits = tier.bytes().take_while(u8::is_ascii_digit).count();
            match tier[digits..].strip_prefix("k_tokens") {
                Some(tail) if digits > 0 => rest = tail,
                _ => {}
            }
        }
        matches!(rest, "" | "_priority" | "_ultrafast" | "_flex")
    })
}

fn is_per_second_resolution(field: &str) -> bool {
    field
        .strip_prefix("output_cost_per_second_")
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

fn litellm_row(row: &Value) -> Option<Value> {
    let row = row.as_object()?;
    let mut out = Obj::new();
    for field in LITELLM_NUMBERS {
        if let Some(value) = row.get(field).filter(|v| v.is_number() && finite(v)) {
            out.insert(field.into(), value.clone());
        }
    }
    for (field, value) in row {
        if (is_rate_column(field) || is_per_second_resolution(field) || field == "regional_endpoint_uplift_multiplier")
            && value.is_number()
            && finite(value)
        {
            out.insert(field.clone(), value.clone());
        }
    }
    for field in LITELLM_FLAGS {
        if let Some(value) = row.get(field).filter(|v| v.is_boolean()) {
            out.insert(field.into(), value.clone());
        }
    }
    for field in LITELLM_STRINGS {
        if let Some(value) = row.get(field).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
            out.insert(field.into(), value.clone());
        }
    }
    if let Some(options) = row.get("reasoning_options").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
        out.insert("reasoning_options".into(), options.clone());
    }
    Some(Value::Object(out))
}

/// `projectLitellmCatalog`: keys preserved exactly, rows narrowed.
pub fn project_litellm(data: &Value) -> Value {
    let Some(map) = data.as_object() else { return data.clone() };
    Value::Object(map.iter().filter_map(|(key, row)| litellm_row(row).map(|r| (key.clone(), r))).collect())
}

fn pick_present(source: Option<&Value>, fields: &[&str]) -> Option<Obj> {
    let source = source?.as_object()?;
    let out: Obj = fields
        .iter()
        .filter_map(|f| source.get(*f).filter(|v| !v.is_null()).map(|v| ((*f).to_owned(), v.clone())))
        .collect();
    (!out.is_empty()).then_some(out)
}

fn pick_arrays(source: Option<&Value>, fields: &[&str]) -> Option<Obj> {
    let source = source?.as_object()?;
    let out: Obj = fields
        .iter()
        .filter_map(|f| source.get(*f).filter(|v| v.is_array()).map(|v| ((*f).to_owned(), v.clone())))
        .collect();
    (!out.is_empty()).then_some(out)
}

fn models_dev_row(row: &Value) -> Option<Value> {
    row.as_object()?;
    let mut out = Obj::new();
    if let Some(cost) = pick_present(row.get("cost"), &["input", "output", "cache_read", "cache_write", "tiers", "context_over_200k"]) {
        out.insert("cost".into(), Value::Object(cost));
    }
    if let Some(limit) = pick_present(row.get("limit"), &["context", "output"]) {
        out.insert("limit".into(), Value::Object(limit));
    }
    if let Some(modalities) = pick_arrays(row.get("modalities"), &["input", "output"]) {
        out.insert("modalities".into(), Value::Object(modalities));
    }
    if let Some(reasoning) = row.get("reasoning").filter(|v| v.is_boolean()) {
        out.insert("reasoning".into(), reasoning.clone());
    }
    if let Some(options) = row.get("reasoning_options").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
        out.insert("reasoning_options".into(), options.clone());
    }
    if let Some(field) = row.pointer("/interleaved/field").filter(|v| crate::service::admin_route::truthy(Some(v))) {
        out.insert("interleaved".into(), serde_json::json!({ "field": field }));
    }
    if let Some(tool_call) = row.get("tool_call").filter(|v| v.is_boolean()) {
        out.insert("tool_call".into(), tool_call.clone());
    }
    for (field, out_field) in [("family", "family"), ("release_date", "release_date"), ("name", "name")] {
        if let Some(text) = row.get(field).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
            out.insert(out_field.into(), text.clone());
        }
    }
    if let Some(npm) = row.pointer("/provider/npm").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
        out.insert("npm".into(), npm.clone());
    }
    Some(Value::Object(out))
}

/// `projectModelsDevCatalog`: `{ providerId: { models } }`; a provider with
/// no models map is dropped.
pub fn project_models_dev(data: &Value) -> Value {
    let Some(providers) = data.as_object() else { return data.clone() };
    let mut out = Obj::new();
    for (id, provider) in providers {
        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
        let projected: Obj = models.iter().filter_map(|(m, row)| models_dev_row(row).map(|r| (m.clone(), r))).collect();
        out.insert(id.clone(), serde_json::json!({ "models": projected }));
    }
    Value::Object(out)
}
