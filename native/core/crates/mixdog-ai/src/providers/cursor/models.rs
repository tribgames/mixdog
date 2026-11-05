//! Cursor model catalog (`AvailableModels` with model parameters) and the
//! selection of a request's variant from the model's declared parameters.
//!
//! Variant naming comes from the server's parameter definitions and variant
//! rows; a model id is never parsed for effort or speed suffixes. An id the
//! catalog does not describe is sent as it is.

use std::collections::BTreeMap;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Map;
use serde_json::Value;

use super::request::ModelSelection;
use crate::providers::connect::pb::PbError;
use crate::providers::connect::pb::Reader;
use crate::providers::connect::pb::Writer;

pub const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

pub fn is_auto_model_id(id: &str) -> bool {
    matches!(id.trim().to_ascii_lowercase().as_str(), "auto" | "default")
}

/// `auto` and `default` are one model.
pub fn canonical_model_id(id: &str) -> String {
    let id = id.trim();
    if is_auto_model_id(id) { "auto".to_owned() } else { id.to_owned() }
}

pub fn is_effort_parameter_id(id: &str) -> bool {
    let key = id.trim().to_ascii_lowercase();
    key == "effort" || key == "reasoning" || key.ends_with("_effort") || key.ends_with("-effort")
}

/// A parameter value as compared and sent: lowercase and trimmed; the effort
/// parameter's `extra-high` is `xhigh`.
pub fn normalize_parameter_value(id: &str, value: &str) -> String {
    let text = value.trim().to_ascii_lowercase();
    if is_effort_parameter_id(id) && text == "extra-high" {
        "xhigh".to_owned()
    } else {
        text
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterValue {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterDefinition {
    pub id: String,
    pub name: String,
    pub boolean: bool,
    pub values: Vec<ParameterValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    /// Parameter id to value, in the server's order.
    pub parameters: Vec<(String, String)>,
    pub max_mode: bool,
    pub default_max: bool,
    pub default_non_max: bool,
    pub legacy_slug: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CursorModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub context_window: u64,
    pub max_context_window: u64,
    pub supports_max_mode: bool,
    pub supports_non_max_mode: bool,
    pub supports_vision: bool,
    pub supports_reasoning: bool,
    pub definitions: Vec<ParameterDefinition>,
    pub variants: Vec<Variant>,
    pub aliases: Vec<String>,
}

impl CursorModel {
    pub fn effort_definition(&self) -> Option<&ParameterDefinition> {
        self.definitions.iter().find(|d| is_effort_parameter_id(&d.id))
    }

    /// The efforts the model offers, normalized.
    pub fn efforts(&self) -> Vec<String> {
        self.effort_definition()
            .map(|d| {
                d.values
                    .iter()
                    .map(|v| normalize_parameter_value(&d.id, &v.value))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn fast_capable(&self) -> bool {
        self.definitions.iter().any(|d| d.id == "fast")
    }
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/// `AvailableModelsRequest`: long-context models, with model parameters.
pub fn available_models_request() -> Vec<u8> {
    let mut w = Writer::new();
    w.varint(2, 1);
    w.varint(5, 1);
    w.varint(6, 0);
    w.varint(7, 0);
    w.varint(8, 0);
    w.finish()
}

fn decode_definition(bytes: &[u8]) -> Result<ParameterDefinition, PbError> {
    let mut out = ParameterDefinition {
        id: String::new(),
        name: String::new(),
        boolean: false,
        values: Vec::new(),
    };
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => out.id = v.text().trim().to_owned(),
            2 => out.name = v.text().trim().to_owned(),
            4 => {
                let mut t = Reader::new(v.bytes());
                while let Some((kind, list)) = t.next_field()? {
                    // 1 boolean, 2 enum: each a list of values.
                    let (blocked_field, is_bool) = match kind {
                        1 => (6, true),
                        2 => (4, false),
                        _ => continue,
                    };
                    out.boolean |= is_bool;
                    let mut values = Reader::new(list.bytes());
                    while let Some((m, value)) = values.next_field()? {
                        if m != 1 {
                            continue;
                        }
                        let (mut raw, mut label, mut blocked) = (String::new(), String::new(), false);
                        let mut f = Reader::new(value.bytes());
                        while let Some((k, x)) = f.next_field()? {
                            match k {
                                1 => raw = x.text(),
                                2 => label = x.text(),
                                k if k == blocked_field => blocked = x.as_bool(),
                                _ => {}
                            }
                        }
                        if !blocked && !raw.trim().is_empty() {
                            let label = if label.is_empty() {
                                match (is_bool, raw.as_str()) {
                                    (true, "true") => "On".to_owned(),
                                    (true, "false") => "Off".to_owned(),
                                    _ => raw.clone(),
                                }
                            } else {
                                label
                            };
                            out.values.push(ParameterValue { value: raw, label });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn decode_variant(bytes: &[u8]) -> Result<Variant, PbError> {
    let mut out = Variant {
        parameters: Vec::new(),
        max_mode: false,
        default_max: false,
        default_non_max: false,
        legacy_slug: String::new(),
    };
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => {
                let (mut id, mut value) = (String::new(), String::new());
                let mut f = Reader::new(v.bytes());
                while let Some((k, x)) = f.next_field()? {
                    match k {
                        1 => id = x.text().trim().to_owned(),
                        2 => value = x.text(),
                        _ => {}
                    }
                }
                if !id.is_empty() {
                    out.parameters.push((id, value));
                }
            }
            3 => out.max_mode = v.as_bool(),
            4 => out.default_max = v.as_bool(),
            5 => out.default_non_max = v.as_bool(),
            11 => out.legacy_slug = v.text().trim().to_owned(),
            _ => {}
        }
    }
    Ok(out)
}

/// Rows of an `AvailableModelsResponse`; empty unless the response states
/// that it uses model parameters.
pub fn decode_available_models(bytes: &[u8]) -> Result<Vec<CursorModel>, PbError> {
    let mut raw: Vec<&[u8]> = Vec::new();
    let mut uses_parameters = false;
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            2 => raw.push(v.bytes()),
            11 => uses_parameters = v.as_bool(),
            _ => {}
        }
    }
    if !uses_parameters {
        return Ok(Vec::new());
    }
    let mut by_id: BTreeMap<String, CursorModel> = BTreeMap::new();
    for model_bytes in raw {
        let mut name = String::new();
        let mut server_name = String::new();
        let (mut display, mut short, mut tagline) = (String::new(), String::new(), String::new());
        let mut tooltip = (String::new(), String::new(), String::new());
        let (mut ctx, mut auto_ctx, mut ctx_max, mut auto_ctx_max) = (0u64, 0u64, 0u64, 0u64);
        let (mut max_mode, mut non_max, mut images, mut thinking, mut hidden) = (false, false, false, false, false);
        let mut definitions = Vec::new();
        let mut variants = Vec::new();
        let mut aliases = Vec::new();
        let mut f = Reader::new(model_bytes);
        while let Some((n, v)) = f.next_field()? {
            match n {
                1 => name = v.text(),
                8 => {
                    let mut t = Reader::new(v.bytes());
                    while let Some((k, x)) = t.next_field()? {
                        match k {
                            1 => tooltip.0 = x.text(),
                            2 => tooltip.1 = x.text(),
                            7 => tooltip.2 = x.text(),
                            _ => {}
                        }
                    }
                }
                9 => thinking = v.as_bool(),
                10 => images = v.as_bool(),
                12 => auto_ctx = v.as_u64(),
                13 => auto_ctx_max = v.as_u64(),
                14 => max_mode = v.as_bool(),
                15 => ctx = v.as_u64(),
                16 => ctx_max = v.as_u64(),
                17 => display = v.text(),
                18 => server_name = v.text(),
                19 => non_max = v.as_bool(),
                24 => short = v.text(),
                29 => definitions.push(decode_definition(v.bytes())?),
                30 => variants.push(decode_variant(v.bytes())?),
                35 => hidden = v.as_bool(),
                36 | 37 => aliases.push(v.text().trim().to_owned()),
                39 => tagline = v.text(),
                _ => {}
            }
        }
        let raw_id = if name.trim().is_empty() { server_name.trim() } else { name.trim() }.to_owned();
        if raw_id.is_empty() || hidden {
            continue;
        }
        let id = canonical_model_id(&raw_id);
        definitions.retain(|d: &ParameterDefinition| !d.id.is_empty() && !d.values.is_empty());
        aliases.extend(variants.iter().filter(|v| !v.legacy_slug.is_empty()).map(|v| v.legacy_slug.clone()));
        if raw_id != id {
            aliases.push(raw_id.clone());
        }
        let mut seen = std::collections::BTreeSet::new();
        aliases.retain(|a| !a.is_empty() && *a != id && seen.insert(a.clone()));
        let next = CursorModel {
            name: if is_auto_model_id(&raw_id) {
                "Auto".to_owned()
            } else if !display.is_empty() {
                display
            } else if !short.is_empty() {
                short
            } else {
                id.clone()
            },
            description: [tagline, tooltip.2, tooltip.1]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or_default(),
            context_window: [ctx, auto_ctx].into_iter().find(|n| *n > 0).unwrap_or(0),
            max_context_window: [ctx_max, auto_ctx_max].into_iter().find(|n| *n > 0).unwrap_or(0),
            supports_max_mode: max_mode,
            supports_non_max_mode: non_max,
            supports_vision: images,
            supports_reasoning: thinking || definitions.iter().any(|d| is_effort_parameter_id(&d.id)),
            definitions,
            variants,
            aliases,
            id: id.clone(),
        };
        let rank = |m: &CursorModel| {
            usize::from(!m.definitions.is_empty()) * 2
                + usize::from(m.supports_max_mode || m.supports_non_max_mode || m.max_context_window > 0)
        };
        if by_id.get(&id).is_none_or(|current| rank(&next) >= rank(current)) {
            by_id.insert(id, next);
        }
    }
    Ok(by_id.into_values().collect())
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/// What a request asks of the model's parameters.
#[derive(Debug, Clone, Default)]
pub struct ParameterAsk<'a> {
    pub effort: Option<&'a str>,
    pub fast: bool,
    /// Explicit values by parameter id (the route's saved choices).
    pub route: Option<&'a Map<String, Value>>,
    pub selected_context_window: Option<u64>,
}

fn invalid(message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = message;
    error
}

fn set(parameters: &mut Vec<(String, String)>, id: &str, value: String) {
    match parameters.iter_mut().find(|(k, _)| k == id) {
        Some(slot) => slot.1 = value,
        None => parameters.push((id.to_owned(), value)),
    }
}

/// The wire selection for a parameterized model.
pub fn select_variant(model: &CursorModel, ask: &ParameterAsk<'_>) -> Result<ModelSelection, ProviderError> {
    let max_mode = model.supports_max_mode
        && (!model.supports_non_max_mode || ask.selected_context_window.unwrap_or(0) > model.context_window);
    let mode_variants: Vec<&Variant> = model.variants.iter().filter(|v| v.max_mode == max_mode).collect();
    let available: Vec<&Variant> = if mode_variants.is_empty() {
        model.variants.iter().collect()
    } else {
        mode_variants
    };
    let default_variant = available
        .iter()
        .find(|v| if max_mode { v.default_max } else { v.default_non_max })
        .or_else(|| available.first())
        .copied();
    let mut parameters: Vec<(String, String)> = default_variant.map(|v| v.parameters.clone()).unwrap_or_default();
    let default_context = parameters.iter().find(|(k, _)| k == "context").map(|(_, v)| v.clone());
    let route = ask.route.cloned().unwrap_or_default();
    for definition in &model.definitions {
        if let Some(value) = route.get(&definition.id) {
            let text = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            set(&mut parameters, &definition.id, text);
        }
    }
    if let (Some(effort_def), Some(effort)) = (model.effort_definition(), ask.effort) {
        let wanted = normalize_parameter_value(&effort_def.id, effort);
        let option = effort_def
            .values
            .iter()
            .find(|c| normalize_parameter_value(&effort_def.id, &c.value) == wanted)
            .ok_or_else(|| invalid(format!("Cursor model {} does not offer {wanted} effort", model.id)))?;
        set(&mut parameters, &effort_def.id, option.value.clone());
    }
    if model.fast_capable() {
        set(&mut parameters, "fast", if ask.fast { "true" } else { "false" }.to_owned());
    }
    let matches = |parameters: &[(String, String)]| {
        available.iter().any(|variant| {
            parameters.iter().all(|(id, value)| {
                variant
                    .parameters
                    .iter()
                    .find(|(k, _)| k == id)
                    .map_or("", |(_, v)| v.as_str())
                    == value
            })
        })
    };
    let mut ok = matches(&parameters);
    // A persisted context can exist in this mode but conflict with the
    // requested effort/fast/other options: retry with the mode's default
    // context, keeping every other choice.
    if !ok && route.contains_key("context") {
        match &default_context {
            Some(context) => set(&mut parameters, "context", context.clone()),
            None => parameters.retain(|(k, _)| k != "context"),
        }
        ok = matches(&parameters);
    }
    if !ok && !available.is_empty() {
        return Err(invalid(format!(
            "Cursor model {} does not offer the selected parameter combination",
            model.id
        )));
    }
    Ok(ModelSelection {
        model_id: model.id.clone(),
        parameters,
        max_mode,
    })
}

/// The selection for `requested`: the model's variant when the catalog
/// describes it, else the id as it is.
pub fn resolve_selection(
    catalog: &[CursorModel],
    requested: &str,
    ask: &ParameterAsk<'_>,
) -> Result<ModelSelection, ProviderError> {
    let requested = canonical_model_id(if requested.trim().is_empty() { "auto" } else { requested });
    match catalog.iter().find(|m| m.id == requested) {
        Some(model) => select_variant(model, ask),
        None => Ok(ModelSelection {
            model_id: requested,
            parameters: Vec::new(),
            max_mode: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(id: &str, values: &[&str]) -> ParameterDefinition {
        ParameterDefinition {
            id: id.to_owned(),
            name: id.to_owned(),
            boolean: id == "fast",
            values: values
                .iter()
                .map(|v| ParameterValue {
                    value: (*v).to_owned(),
                    label: (*v).to_owned(),
                })
                .collect(),
        }
    }

    fn variant(params: &[(&str, &str)], default: bool) -> Variant {
        Variant {
            parameters: params.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect(),
            max_mode: false,
            default_max: false,
            default_non_max: default,
            legacy_slug: String::new(),
        }
    }

    fn model() -> CursorModel {
        CursorModel {
            id: "m".into(),
            name: "M".into(),
            description: String::new(),
            context_window: 200_000,
            max_context_window: 0,
            supports_max_mode: false,
            supports_non_max_mode: true,
            supports_vision: false,
            supports_reasoning: true,
            definitions: vec![def("effort", &["low", "high"]), def("fast", &["true", "false"])],
            variants: vec![
                variant(&[("effort", "low"), ("fast", "false")], true),
                variant(&[("effort", "high"), ("fast", "false")], false),
                variant(&[("effort", "high"), ("fast", "true")], false),
            ],
            aliases: Vec::new(),
        }
    }

    #[test]
    fn default_variant_and_effort_choice() {
        let m = model();
        let s = select_variant(&m, &ParameterAsk::default()).unwrap();
        assert_eq!(s.parameters, [("effort".into(), "low".into()), ("fast".into(), "false".into())]);
        let s = select_variant(&m, &ParameterAsk { effort: Some("HIGH"), fast: true, ..Default::default() }).unwrap();
        assert_eq!(s.parameters, [("effort".into(), "high".into()), ("fast".into(), "true".into())]);
    }

    #[test]
    fn unoffered_effort_or_combination_is_rejected() {
        let m = model();
        let e = select_variant(&m, &ParameterAsk { effort: Some("max"), ..Default::default() }).unwrap_err();
        assert_eq!(e.message, "Cursor model m does not offer max effort");
        let e = select_variant(&m, &ParameterAsk { effort: Some("low"), fast: true, ..Default::default() }).unwrap_err();
        assert!(e.message.contains("selected parameter combination"));
    }

    #[test]
    fn unknown_model_is_sent_as_it_is() {
        let s = resolve_selection(&[], "composer-x", &ParameterAsk::default()).unwrap();
        assert_eq!((s.model_id.as_str(), s.parameters.len()), ("composer-x", 0));
        assert_eq!(resolve_selection(&[], "default", &ParameterAsk::default()).unwrap().model_id, "auto");
    }
}
