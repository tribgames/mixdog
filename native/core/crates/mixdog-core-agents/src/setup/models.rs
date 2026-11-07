//! The shaping of the setup tool's `list_models` (`setup-tool/extended-actions.mjs`): the provider
//! index, one provider's paged compact rows and one model's detail, over the rows the model
//! catalog lists. Objects are built in Node's key order; absent fields are left out as
//! `JSON.stringify` leaves them out.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::settings::truthy;

const PAGE_DEFAULT: i64 = 25;

/// `OPENAI_COMPAT_PRESETS[provider]?.defaultModel`.
const DEFAULT_MODELS: [(&str, &str); 3] = [("deepseek", "deepseek-v4-pro"), ("xai", "grok-4.5"), ("openrouter", "openrouter/auto")];

/// `Number(value)` of a JSON value.
fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => mixdog_js::string_to_number(text),
        Some(_) => f64::NAN,
    }
}

/// A JS number as JSON: whole numbers print without a fraction.
fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

/// `row.<key> || fallback`.
fn or(row: &Value, key: &str, fallback: Value) -> Value {
    match row.get(key) {
        Some(value) if truthy(Some(value)) => value.clone(),
        _ => fallback,
    }
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The model-management choices, only when set.
fn preferences(row: &Value, out: &mut Map<String, Value>) {
    if let Some(hidden @ Value::Bool(_)) = row.get("savedHidden") {
        out.insert("hidden".into(), hidden.clone());
    }
    if row.get("favorite") == Some(&Value::Bool(true)) {
        out.insert("favorite".into(), Value::Bool(true));
    }
}

fn provider_index(rows: &[Value]) -> Value {
    let mut counts: Vec<(Value, u64)> = Vec::new();
    for row in rows {
        let provider = row.get("provider").cloned().unwrap_or(Value::Null);
        match counts.iter_mut().find(|(seen, _)| *seen == provider) {
            Some((_, count)) => *count += 1,
            None => counts.push((provider, 1)),
        }
    }
    Value::Array(
        counts
            .into_iter()
            .map(|(provider, count)| {
                let mut entry = Map::new();
                let default = provider.as_str().and_then(|name| DEFAULT_MODELS.iter().find(|(id, _)| *id == name));
                entry.insert("provider".into(), provider);
                entry.insert("count".into(), json!(count));
                if let Some((_, model)) = default {
                    entry.insert("defaultModel".into(), json!(model));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

fn compact_row(row: &Value) -> Value {
    let context = or(row, "contextWindow", Value::Null);
    let max_context = number(row.get("maxContextWindow"));
    let max_context = if max_context.is_nan() { 0.0 } else { max_context };
    let mut out = Map::new();
    if let Some(id) = row.get("id") {
        out.insert("id".into(), id.clone());
    }
    let display = or(row, "display", row.get("id").cloned().unwrap_or(Value::Null));
    if !display.is_null() || row.get("id").is_some() {
        out.insert("display".into(), display);
    }
    let context_number = if context.is_null() { 0.0 } else { number(Some(&context)) };
    out.insert("context".into(), context);
    if max_context > context_number {
        out.insert("maxContext".into(), json_number(max_context));
    }
    let efforts: Vec<Value> = row
        .get("effortOptions")
        .and_then(Value::as_array)
        .map(|options| options.iter().map(|option| option.get("value").cloned().unwrap_or(Value::Null)).collect())
        .unwrap_or_default();
    out.insert("efforts".into(), Value::Array(efforts));
    for (key, flag) in [("fastCapable", "fast"), ("supportsVision", "vision")] {
        if row.get(key) == Some(&Value::Bool(true)) {
            out.insert(flag.into(), Value::Bool(true));
        }
    }
    preferences(row, &mut out);
    Value::Object(out)
}

/// `isPresent`: not null, not `''`, not `false`, not an empty object or array.
fn present(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::Array(items) => !items.is_empty(),
        _ => true,
    }
}

fn model_detail(row: &Value) -> Value {
    let get = |key: &str| row.get(key).cloned();
    let max_context = {
        let max = number(row.get("maxContextWindow"));
        if max > number(row.get("contextWindow")) { get("maxContextWindow") } else { Some(Value::Null) }
    };
    let effort_options = row.get("effortOptions").and_then(Value::as_array).map(|options| {
        Value::Array(
            options
                .iter()
                .map(|option| {
                    let mut kept = Map::new();
                    for key in ["value", "label"] {
                        if let Some(value) = option.get(key) {
                            kept.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(kept)
                })
                .collect(),
        )
    });
    let display = or(row, "display", row.get("id").cloned().unwrap_or(Value::Null));
    let fields: [(&str, Option<Value>); 21] = [
        ("provider", get("provider")),
        ("id", get("id")),
        ("display", Some(display)),
        ("context", get("contextWindow")),
        ("maxContext", max_context),
        ("outputTokens", get("outputTokens")),
        ("vision", get("supportsVision")),
        ("webSearch", get("supportsWebSearch")),
        ("reasoning", get("supportsReasoning")),
        ("effortOptions", Some(effort_options.unwrap_or_else(|| Value::Array(Vec::new())))),
        ("defaultEffort", get("defaultEffort")),
        ("fastCapable", get("fastCapable")),
        ("fastEfforts", get("fastEfforts")),
        ("defaultFast", get("defaultFast")),
        ("serviceTiers", get("serviceTiers")),
        ("defaultServiceTier", get("defaultServiceTier")),
        ("additionalSpeedTiers", get("additionalSpeedTiers")),
        ("modelParameterOptions", get("modelParameterOptions")),
        ("parameterVariants", get("parameterVariants")),
        ("defaultModelParameters", get("defaultModelParameters")),
        ("supportsMaxMode", get("supportsMaxMode")),
    ];
    let mut out = Map::new();
    for (key, value) in fields {
        if let Some(value) = value.filter(present) {
            out.insert(key.into(), value);
        }
    }
    preferences(row, &mut out);
    Value::Object(out)
}

fn find_model<'a>(rows: &'a [Value], id: &str, provider: Option<&str>) -> Result<&'a Value, String> {
    let matches: Vec<&Value> = rows
        .iter()
        .filter(|row| text(row, "id").as_deref() == Some(id) && provider.is_none_or(|wanted| text(row, "provider").as_deref() == Some(wanted)))
        .collect();
    let Some(first) = matches.first() else {
        let scope = provider.map(|p| format!(" for provider \"{p}\"")).unwrap_or_default();
        return Err(format!("model \"{id}\" not found{scope}; list_models with catalog.provider returns its model ids"));
    };
    let mut providers: Vec<String> = Vec::new();
    for row in &matches {
        let name = mixdog_js::value_to_string(row.get("provider").unwrap_or(&Value::Null));
        if !providers.contains(&name) {
            providers.push(name);
        }
    }
    if providers.len() > 1 {
        return Err(format!("model \"{id}\" is offered by {}; pass catalog.provider", providers.join(", ")));
    }
    Ok(first)
}

/// What the catalog argument asks for, with Node's destructuring defaults.
pub(super) struct Query {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub page: i64,
    pub limit: i64,
    pub web_search: bool,
    pub refresh: bool,
}

impl Query {
    pub(super) fn of(args: &Value) -> Self {
        let catalog = args.get("catalog").filter(|catalog| truthy(Some(catalog)));
        let get = |key: &str| catalog.and_then(|catalog| catalog.get(key));
        // A falsy provider or model means "not given" (`if (model)`, `if (!provider)`).
        let name = |key: &str| get(key).filter(|value| truthy(Some(value))).map(mixdog_js::value_to_string);
        let integer = |key: &str, default: i64| match get(key) {
            None => default,
            Some(value) => number(Some(value)) as i64,
        };
        Self {
            provider: name("provider"),
            model: name("model"),
            page: integer("page", 1),
            limit: integer("limit", PAGE_DEFAULT),
            web_search: truthy(get("webSearch")),
            refresh: get("refresh") == Some(&Value::Bool(true)),
        }
    }
}

pub(super) fn answer(query: &Query, rows: &[Value]) -> Result<Value, String> {
    if let Some(model) = &query.model {
        return Ok(json!({ "model": model_detail(find_model(rows, model, query.provider.as_deref())?) }));
    }
    let Some(provider) = &query.provider else {
        return Ok(json!({ "providers": provider_index(rows) }));
    };
    let own: Vec<&Value> = rows.iter().filter(|row| text(row, "provider").as_deref() == Some(provider)).collect();
    let limit = query.limit.max(1);
    let pages = (own.len() as i64 + limit - 1) / limit;
    let pages = pages.max(1);
    let start = ((query.page - 1) * limit).max(0) as usize;
    let end = (query.page * limit).max(0) as usize;
    let models: Vec<Value> = own.iter().skip(start).take(end.saturating_sub(start)).map(|row| compact_row(row)).collect();
    let mut out = Map::new();
    out.insert("provider".into(), json!(provider));
    out.insert("total".into(), json!(own.len()));
    out.insert("page".into(), json!(query.page));
    out.insert("pages".into(), json!(pages));
    if query.page < pages {
        out.insert("nextPage".into(), json!(query.page + 1));
    }
    out.insert("models".into(), Value::Array(models));
    Ok(Value::Object(out))
}