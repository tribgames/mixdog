//! `cursor-oauth` / `cursor-api` model listing: the account's models as the
//! picker shows them, from the parameters and variants the server declares.
//!
//! A parameterized model is one row carrying its efforts, its fast variants,
//! its non-effort parameter options and the route parameters of each variant.
//! The models the server describes by neither parameters nor modes are named
//! by their ids: the ids sharing a base (`-thinking`, an effort, `-fast`
//! stripped) are one row whose efforts and fast variants are the suffixes.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::math;
use mixdog_js::string_to_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::models::CursorModel;
use super::models::DEFAULT_CONTEXT_WINDOW;
use super::models::ParameterDefinition;
use super::models::Variant;
use super::models::is_auto_model_id;
use super::models::is_effort_parameter_id;
use super::models::normalize_parameter_value;
use super::variants::EFFORT_ORDER;
use super::variants::SlugGroup;
use super::variants::SlugVariant;
use super::variants::slug_groups;

static CONTEXT_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("^(\\d+(?:\\.\\d+)?)(k|m)?$", ""));
static DESCRIBED_CONTEXT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static("(\\d+(?:\\.\\d+)?)\\s*([km])\\s+context window", "i"));
static HEADING_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\\s+\\([^)]*\\)\\s*$", ""));
static FAST_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\\s+Fast$", "i"));

/// The markup the server's text carries, reduced to plain text in one line.
static PLAIN_TEXT: LazyLock<[(JsRegex, Replacement); 10]> = LazyLock::new(|| {
    [
        (JsRegex::new_static("<br\\s*\\/?>", "gi"), Replacement::Text(" · ")),
        (JsRegex::new_static("<[^>]+>", "g"), Replacement::Text("")),
        (JsRegex::new_static("\\[([^\\]]+)\\]\\([^)]+\\)", "g"), Replacement::LinkText),
        (JsRegex::new_static("[*_`]+", "g"), Replacement::Text("")),
        (JsRegex::new_static("&amp;", "g"), Replacement::Text("&")),
        (JsRegex::new_static("&quot;", "g"), Replacement::Text("\"")),
        (JsRegex::new_static("[\\u200B-\\u200D\\uFEFF]", "g"), Replacement::Text("")),
        (JsRegex::new_static("\\s*·\\s*", "g"), Replacement::Text(" · ")),
        (JsRegex::new_static("(?:\\s*·\\s*){2,}", "g"), Replacement::Text(" · ")),
        (JsRegex::new_static("\\s+", "g"), Replacement::Text(" ")),
    ]
});

enum Replacement {
    Text(&'static str),
    /// The text of a markdown link.
    LinkText,
}

fn plain_text(value: &str) -> String {
    let mut text = value.to_owned();
    for (pattern, with) in PLAIN_TEXT.iter() {
        text = pattern.replace_all_with(&text, |caps| match with {
            Replacement::Text(text) => (*text).to_owned(),
            Replacement::LinkText => caps.get(1).unwrap_or("").to_owned(),
        });
    }
    js_trim(&text).to_owned()
}

/// `200k`, `1m`, `1000000` as a token count; 0 for anything else.
fn context_window_of(value: &str) -> u64 {
    let text = js_trim(value).to_lowercase();
    let Some(caps) = CONTEXT_VALUE.captures(&text) else { return 0 };
    let scale = match caps.get(2) {
        Some("k") => 1_000.0,
        Some("m") => 1_000_000.0,
        _ => 1.0,
    };
    math::round(string_to_number(caps.get(1).unwrap_or("")) * scale) as u64
}

fn described_context_window(description: &str) -> u64 {
    DESCRIBED_CONTEXT
        .captures(description)
        .map_or(0, |caps| context_window_of(&format!("{}{}", caps.get(1).unwrap_or(""), caps.get(2).unwrap_or(""))))
}

/// The description without the heading that only repeats the model's name.
fn description_of(model: &CursorModel) -> String {
    let display = plain_text(&model.name);
    let text = plain_text(&model.description);
    let mut parts: Vec<&str> = text.split(" · ").filter(|p| !p.is_empty()).collect();
    if let Some(first) = parts.first()
        && !display.is_empty()
    {
        let heading = HEADING_SUFFIX.replace_all_with(first, |_| String::new());
        if js_trim(&heading).to_lowercase() == display.to_lowercase() {
            parts.remove(0);
        }
    }
    parts.join(" · ")
}

/// A variant's parameters keyed by route name (the effort parameter is
/// `effort`) with normalized values.
fn route_parameters(variant: &Variant, effort_id: Option<&str>) -> Map<String, Value> {
    let mut route = Map::new();
    for (id, value) in &variant.parameters {
        let key = if Some(id.as_str()) == effort_id { "effort" } else { id.as_str() };
        route.insert(key.to_owned(), json!(normalize_parameter_value(id, value)));
    }
    route
}

/// The non-effort, non-fast parameters as selectable options; a context
/// option carries the window it selects.
fn parameter_options(definitions: &[ParameterDefinition]) -> Vec<Value> {
    definitions
        .iter()
        .filter(|d| !is_effort_parameter_id(&d.id) && d.id != "fast")
        .map(|d| {
            let options: Vec<Value> = d
                .values
                .iter()
                .map(|option| {
                    let mut entry = Map::new();
                    entry.insert("value".into(), json!(normalize_parameter_value(&d.id, &option.value)));
                    entry.insert("label".into(), json!(option.label));
                    let window = if d.id == "context" { context_window_of(&option.value) } else { 0 };
                    if window > 0 {
                        entry.insert("contextWindow".into(), json!(window));
                    }
                    Value::Object(entry)
                })
                .collect();
            json!({
                "id": d.id,
                "label": if d.name.is_empty() { &d.id } else { &d.name },
                "kind": if d.boolean { "boolean" } else { "enum" },
                "options": options,
            })
        })
        .collect()
}

/// The model's default variant in the mode it opens in.
fn default_variant(routes: &[(&Variant, Map<String, Value>)], max_only: bool) -> Option<usize> {
    let by_default = |variant: &Variant| if max_only { variant.default_max } else { variant.default_non_max };
    routes
        .iter()
        .position(|(variant, _)| by_default(variant))
        .or_else(|| routes.iter().position(|(variant, _)| variant.max_mode == max_only))
        .or(if routes.is_empty() { None } else { Some(0) })
}

fn parameterized_row(model: &CursorModel, provider: &str) -> Map<String, Value> {
    let effort = model.effort_definition();
    let routes: Vec<(&Variant, Map<String, Value>)> =
        model.variants.iter().map(|v| (v, route_parameters(v, effort.map(|d| d.id.as_str())))).collect();
    let supports_max = model.supports_max_mode;
    let supports_non_max = model.supports_non_max_mode || !supports_max;
    let max_only = supports_max && !supports_non_max;
    let default = default_variant(&routes, max_only).map(|at| &routes[at].1);
    let efforts = model.efforts();
    let mut fast_efforts: Vec<String> = Vec::new();
    for (_, route) in &routes {
        if route.get("fast").and_then(Value::as_str) == Some("true") {
            let effort = route.get("effort").and_then(Value::as_str).unwrap_or("").to_owned();
            if !fast_efforts.contains(&effort) {
                fast_efforts.push(effort);
            }
        }
    }
    let default_parameters: Map<String, Value> = default
        .map(|route| route.iter().filter(|(k, _)| !matches!(k.as_str(), "effort" | "fast")).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let description = description_of(model);
    let described = described_context_window(&description);
    let default_context = default_parameters.get("context").and_then(Value::as_str).map_or(0, context_window_of);
    let non_max = [default_context, model.context_window]
        .into_iter()
        .find(|n| *n > 0)
        .or(if supports_max && supports_non_max { None } else { Some(described).filter(|n| *n > 0) })
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let max = if model.max_context_window > 0 {
        model.max_context_window
    } else if supports_max {
        described
    } else {
        0
    };
    let context_window = if max_only && max > 0 { max } else { non_max };
    let reasoning = !efforts.is_empty() || model.supports_reasoning;
    let mut row = Map::new();
    row.insert("id".into(), json!(model.id));
    row.insert("display".into(), json!(if is_auto_model_id(&model.id) { "Auto".to_owned() } else { plain_text(&model.name) }));
    row.insert("provider".into(), json!(provider));
    row.insert("mode".into(), json!("chat"));
    row.insert("contextWindow".into(), json!(context_window));
    if max > context_window {
        row.insert("maxContextWindow".into(), json!(max));
    }
    row.insert("description".into(), json!(description));
    row.insert("supportsVision".into(), json!(model.supports_vision));
    row.insert("reasoning".into(), json!(reasoning));
    row.insert("supportsReasoning".into(), json!(reasoning));
    row.insert("reasoningLevels".into(), json!(efforts));
    row.insert(
        "reasoningOptions".into(),
        if efforts.is_empty() { json!([]) } else { json!([{"type": "effort", "values": efforts}]) },
    );
    row.insert("fastCapable".into(), json!(model.fast_capable()));
    row.insert("fastEfforts".into(), json!(fast_efforts));
    row.insert("modelParameterOptions".into(), json!(parameter_options(&model.definitions)));
    row.insert("parameterVariants".into(), json!(routes.iter().map(|(_, r)| r).collect::<Vec<_>>()));
    row.insert("defaultModelParameters".into(), Value::Object(default_parameters));
    row.insert("defaultEffort".into(), json!(default.and_then(|r| r.get("effort")).and_then(Value::as_str).filter(|e| !e.is_empty())));
    row.insert("defaultFast".into(), json!(default.is_some_and(|r| r.get("fast").and_then(Value::as_str) == Some("true"))));
    row.insert("supportsMaxMode".into(), json!(supports_max));
    row
}

/// The model's name in the picker, without the speed or effort its id adds.
fn variant_display(group: &SlugGroup<'_>, variant: &SlugVariant<'_>) -> String {
    if group.base_id == "auto" {
        return "Auto".to_owned();
    }
    let model = variant.model;
    let named = [model.name.as_str(), model.id.as_str(), group.base_id.as_str()]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let mut display = FAST_SUFFIX.replace_all_with(js_trim(named), |_| String::new());
    if let Some(effort) = variant.parsed.effort.as_deref() {
        let label = if effort == "xhigh" {
            "Extra High".to_owned()
        } else {
            let mut chars = effort.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
        };
        let label_suffix =
            JsRegex::new_static(&format!("\\s+{label}(?=\\s+Thinking(?:\\s|$)|\\s+\\(NO ZDR\\)|$)"), "i");
        if let Some(found) = label_suffix.find(&display) {
            display.replace_range(found, "");
        }
    }
    if display.is_empty() { group.base_id.clone() } else { display }
}

/// The ids sharing a base as one model, described by the id requests prefer.
fn group_row(group: &SlugGroup<'_>, provider: &str) -> Map<String, Value> {
    let representative = &group.variants[0];
    let efforts: Vec<&str> = EFFORT_ORDER
        .into_iter()
        .filter(|effort| group.variants.iter().any(|v| v.parsed.effort.as_deref() == Some(effort)))
        .collect();
    let mut fast_efforts: Vec<String> = Vec::new();
    for variant in group.variants.iter().filter(|v| v.parsed.fast) {
        let effort = variant.parsed.effort.clone().unwrap_or_default();
        if !fast_efforts.contains(&effort) {
            fast_efforts.push(effort);
        }
    }
    let reasoning = !efforts.is_empty() || representative.parsed.thinking;
    let window = representative.model.context_window;
    let mut row = Map::new();
    row.insert("id".into(), json!(group.base_id));
    row.insert("display".into(), json!(variant_display(group, representative)));
    row.insert("provider".into(), json!(provider));
    row.insert("mode".into(), json!("chat"));
    row.insert("contextWindow".into(), json!(if window > 0 { window } else { DEFAULT_CONTEXT_WINDOW }));
    row.insert("reasoning".into(), json!(reasoning));
    row.insert("supportsReasoning".into(), json!(reasoning));
    row.insert("reasoningLevels".into(), json!(efforts));
    row.insert(
        "reasoningOptions".into(),
        if efforts.is_empty() { json!([]) } else { json!([{"type": "effort", "values": efforts}]) },
    );
    row.insert("fastCapable".into(), json!(!fast_efforts.is_empty()));
    row.insert("fastEfforts".into(), json!(fast_efforts));
    row
}

/// The picker rows: the parameterized models, then the id-named ones grouped
/// by base, each in the order the server listed them (Auto first).
pub fn rows(models: &[CursorModel], provider: &str) -> Vec<Map<String, Value>> {
    let (auto, others): (Vec<&CursorModel>, Vec<&CursorModel>) = models.iter().partition(|m| m.id == "auto");
    let ordered: Vec<&CursorModel> = auto.into_iter().chain(others).collect();
    let parameterized: Vec<&CursorModel> = ordered.iter().copied().filter(|m| m.is_parameterized()).collect();
    let groups = slug_groups(ordered.iter().copied());
    parameterized
        .iter()
        .map(|m| parameterized_row(m, provider))
        .chain(
            groups
                .iter()
                .filter(|group| !parameterized.iter().any(|m| m.id == group.base_id))
                .map(|group| group_row(group, provider)),
        )
        .collect()
}
