//! The per-row selections of one provider's model list (`model-picker/route-selection.mjs` and `route-selection/*`): effort,
//! Fast, the thinking-style parameters and the context percent, seeded from the current route, the live UI state and the saved
//! values, plus the route input Enter saves. Mutators answer whether anything changed so the caller knows when to repaint.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::options::{DAYBREAK_PARAMETER_ID, OPENROUTER_SORT_PARAMETER, model_context_window};
use crate::pickers::common::RouteState;
use crate::slash::notices::truthy;

/// The row identity the selection maps are keyed by: one provider and one id.
pub fn model_key(model: &Value) -> String {
    let text = |key: &str| model.get(key).filter(|value| truthy(value)).map(mixdog_js::value_to_string).unwrap_or_default();
    format!("{}\n{}", text("provider"), text("id"))
}

const EFFORT_PREFERENCE: [&str; 7] = ["high", "medium", "low", "none", "xhigh", "max", "ultra"];

fn preferred_effort(values: &[String]) -> Option<String> {
    EFFORT_PREFERENCE.iter().find(|wanted| values.iter().any(|value| value == *wanted)).map(|value| (*value).to_owned()).or_else(|| values.first().cloned())
}

/// `effortItemsFor(model)`: the model's effort options.
pub fn effort_items_for(model: &Value) -> Vec<Value> {
    model.get("effortOptions").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn model_effort_values(model: &Value) -> Vec<String> {
    effort_items_for(model).iter().filter_map(|effort| effort.get("value").filter(|value| truthy(value)).map(mixdog_js::value_to_string)).collect()
}

fn text_field<'a>(model: &'a Value, key: &str) -> Option<&'a str> {
    model.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// `catalogDefaultEffort(model)`: the saved choice, else the catalog default, else the preference order.
pub fn catalog_default_effort(model: &Value) -> Option<String> {
    let values = model_effort_values(model);
    if values.is_empty() {
        return None;
    }
    for key in ["savedEffort", "defaultEffort"] {
        if let Some(effort) = text_field(model, key).filter(|effort| values.iter().any(|value| value == effort)) {
            return Some(effort.to_owned());
        }
    }
    preferred_effort(&values)
}

fn clamp_percent(value: f64) -> i64 {
    value.clamp(10.0, 100.0) as i64
}

/// The context window a row selects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextSelection {
    pub percent: i64,
    pub default_percent: i64,
    pub tokens: f64,
}

/// The selections of one provider's model list.
pub struct RouteSelection {
    provider_models: Vec<Value>,
    state: RouteState,
    current_route: Option<Value>,
    efforts: HashMap<String, Option<String>>,
    fasts: HashMap<String, bool>,
    parameters: HashMap<String, Map<String, Value>>,
    context: HashMap<String, i64>,
}

impl RouteSelection {
    pub fn new(provider_models: Vec<Value>, state: RouteState, current_route: Option<Value>) -> Self {
        Self { provider_models, state, current_route, efforts: HashMap::new(), fasts: HashMap::new(), parameters: HashMap::new(), context: HashMap::new() }
    }

    fn is_current_route(&self, model: &Value) -> bool {
        self.current_route
            .as_ref()
            .is_some_and(|route| route.get("provider") == model.get("provider") && route.get("model") == model.get("id") && route.get("model").is_some())
    }

    fn is_state_route(&self, model: &Value) -> bool {
        let text = |key: &str| model.get(key).and_then(Value::as_str).unwrap_or_default();
        text("provider") == self.state.provider && text("id") == self.state.model
    }

    // ---- effort ----

    /// The effort a model starts on when nothing selects one: the current route, the UI state, the saved choice, the catalog
    /// default, then the preference order.
    pub fn model_default_effort(&self, model: &Value) -> Option<String> {
        let values = model_effort_values(model);
        if values.is_empty() {
            return None;
        }
        let has = |effort: &str| values.iter().any(|value| value == effort);
        if self.is_current_route(model) {
            if let Some(effort) = self.current_route.as_ref().and_then(|route| text_field(route, "effort")).filter(|effort| has(effort)) {
                return Some(effort.to_owned());
            }
        }
        if self.is_state_route(model) {
            if let Some(effort) = self.state.effort.as_deref().filter(|effort| !effort.is_empty() && has(effort)) {
                return Some(effort.to_owned());
            }
        }
        catalog_default_effort(model)
    }

    /// `getSelectedEffort(model)`.
    pub fn get_selected_effort(&mut self, model: Option<&Value>) -> Option<String> {
        let model = model?;
        let key = model_key(model);
        if let Some(effort) = self.efforts.get(&key) {
            return effort.clone();
        }
        let effort = self.model_default_effort(model);
        self.efforts.insert(key, effort.clone());
        effort
    }

    /// `setSelectedEffort(model, effort)`.
    pub fn set_selected_effort(&mut self, model: Option<&Value>, effort: Option<String>) {
        if let Some(model) = model {
            self.efforts.insert(model_key(model), effort.filter(|effort| !effort.is_empty()));
        }
    }

    /// Every effort offered by any model of this provider, first occurrence wins.
    pub fn provider_effort_items(&self) -> Vec<Value> {
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for effort in self.provider_models.iter().flat_map(effort_items_for) {
            let Some(value) = effort.get("value").filter(|value| truthy(value)).map(mixdog_js::value_to_string) else { continue };
            if seen.contains(&value) {
                continue;
            }
            seen.push(value);
            out.push(effort);
        }
        out
    }

    /// The effort Enter saves: the selected one when the model offers it, else the model's default.
    pub fn coerce_effort(&mut self, model: &Value) -> Option<String> {
        let values = model_effort_values(model);
        if values.is_empty() {
            return None;
        }
        match self.get_selected_effort(Some(model)) {
            Some(selected) if values.contains(&selected) => Some(selected),
            _ => self.model_default_effort(model),
        }
    }

    /// Moves the effort one step with wrap-around; false when the model has none.
    pub fn cycle_effort(&mut self, model: &Value, direction: i64) -> bool {
        let values = model_effort_values(model);
        if values.is_empty() {
            return false;
        }
        let current = self.coerce_effort(model).and_then(|effort| values.iter().position(|value| *value == effort)).unwrap_or(0);
        let next = (current as i64 + direction).rem_euclid(values.len() as i64) as usize;
        self.set_selected_effort(Some(model), Some(values[next].clone()));
        true
    }

    // ---- Fast and parameters ----

    /// `modelParametersFor(model)`: the selected value of each parameter the model offers.
    pub fn model_parameters_for(&mut self, model: &Value) -> Map<String, Value> {
        let key = model_key(model);
        if let Some(values) = self.parameters.get(&key) {
            return values.clone();
        }
        let object = |value: Option<&Value>| value.and_then(Value::as_object).cloned().unwrap_or_default();
        let current =
            if self.is_current_route(model) { object(self.current_route.as_ref().and_then(|route| route.get("modelParameters"))) } else { Map::new() };
        let mut defaults = object(model.get("defaultModelParameters"));
        defaults.extend(object(model.get("savedModelParameters")));
        defaults.extend(current);
        let mut values = Map::new();
        for parameter in model.get("modelParameterOptions").and_then(Value::as_array).into_iter().flatten() {
            let id = parameter.get("id").and_then(Value::as_str).unwrap_or_default();
            let options = parameter.get("options").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let wanted = defaults.get(id);
            let selected = if wanted.is_some() && options.iter().any(|option| option.get("value") == wanted) {
                wanted.cloned()
            } else {
                options.first().and_then(|option| option.get("value")).cloned()
            };
            if let Some(selected) = selected.filter(truthy) {
                values.insert(id.to_owned(), selected);
            }
        }
        self.parameters.insert(key, values.clone());
        values
    }

    /// `fastAvailableFor(model, effort)`: Fast is offered when the model is fast capable and a variant (or the list of efforts
    /// Fast runs at) allows the selected parameters and effort.
    pub fn fast_available_for(&mut self, model: &Value, effort: &Option<String>) -> bool {
        if !model.get("fastCapable").is_some_and(truthy) {
            return false;
        }
        let effort_text = effort.as_deref().unwrap_or_default();
        if let Some(variants) = model.get("parameterVariants").and_then(Value::as_array).filter(|variants| !variants.is_empty()) {
            let parameters = self.model_parameters_for(model);
            return variants.iter().any(|variant| {
                variant.get("fast").and_then(Value::as_str) == Some("true")
                    && (effort_text.is_empty()
                        || !variant.get("effort").is_some_and(truthy)
                        || variant.get("effort").and_then(Value::as_str) == Some(effort_text))
                    && parameters.iter().all(|(key, value)| !variant.get(key).is_some_and(truthy) || variant.get(key) == Some(value))
            });
        }
        let efforts = model.get("fastEfforts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        efforts.is_empty() || efforts.iter().any(|candidate| candidate.as_str() == Some(effort_text))
    }

    fn fast_available_at_selected(&mut self, model: &Value) -> bool {
        let effort = self.get_selected_effort(Some(model));
        self.fast_available_for(model, &effort)
    }

    /// `fastAvailableFor(model)` at the selected effort; false without a model.
    pub fn fast_available(&mut self, model: Option<&Value>) -> bool {
        model.is_some_and(|model| self.fast_available_at_selected(model))
    }

    fn model_default_fast(&mut self, model: &Value) -> bool {
        if !self.fast_available_at_selected(model) {
            return false;
        }
        if self.is_current_route(model) {
            if let Some(fast) = self.current_route.as_ref().and_then(|route| route.get("fast")).and_then(Value::as_bool) {
                return fast;
            }
        }
        if self.is_state_route(model) {
            if let Some(fast) = self.state.fast {
                return fast;
            }
        }
        if let Some(saved) = model.get("savedFast").and_then(Value::as_bool) {
            return saved;
        }
        model.get("fastPreferred") == Some(&Value::Bool(true))
    }

    /// `getSelectedFast(model)`.
    pub fn get_selected_fast(&mut self, model: &Value) -> bool {
        if !self.fast_available_at_selected(model) {
            return false;
        }
        let key = model_key(model);
        if let Some(fast) = self.fasts.get(&key) {
            return *fast;
        }
        let fast = self.model_default_fast(model);
        self.fasts.insert(key, fast);
        fast
    }

    fn ultrafast_offered(model: &Value) -> bool {
        model.get("modelParameterOptions").and_then(Value::as_array).into_iter().flatten().any(|parameter| {
            parameter.get("id").and_then(Value::as_str) == Some("serviceTier")
                && parameter
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|option| option.get("value").and_then(Value::as_str) == Some("ultrafast"))
        })
    }

    /// `isUltrafast(model)`.
    pub fn is_ultrafast(&mut self, model: &Value) -> bool {
        Self::ultrafast_offered(model)
            && self.get_selected_fast(model)
            && self.model_parameters_for(model).get("serviceTier").and_then(Value::as_str) == Some("ultrafast")
    }

    fn set_speed(&mut self, model: &Value, fast: bool, tier: &str) {
        let mut parameters = self.model_parameters_for(model);
        parameters.insert("serviceTier".to_owned(), json!(tier));
        self.fasts.insert(model_key(model), fast);
        self.parameters.insert(model_key(model), parameters);
    }

    /// Cycles Standard, Fast, Ultrafast, Standard when the model offers Ultrafast, else flips Fast; false when the model cannot
    /// run Fast at the selected effort.
    pub fn toggle_fast(&mut self, model: &Value) -> bool {
        if !self.fast_available_at_selected(model) {
            return false;
        }
        if !Self::ultrafast_offered(model) {
            let next = !self.get_selected_fast(model);
            self.fasts.insert(model_key(model), next);
            return true;
        }
        if !self.get_selected_fast(model) {
            self.set_speed(model, true, "priority");
        } else if !self.is_ultrafast(model) {
            self.set_speed(model, true, "ultrafast");
        } else {
            self.set_speed(model, false, "priority");
        }
        true
    }

    /// Cycles one parameter to its next option; false when the model does not offer it. Fast is dropped when the new
    /// parameters rule it out.
    fn cycle_parameter(&mut self, model: &Value, ids: &[&str]) -> bool {
        let definition = model
            .get("modelParameterOptions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|parameter| parameter.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(&id)));
        let Some(definition) = definition else { return false };
        let options = definition.get("options").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        if options.is_empty() {
            return false;
        }
        let wanted = definition.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut parameters = self.model_parameters_for(model);
        let current = options.iter().position(|option| option.get("value") == parameters.get(&wanted)).unwrap_or(0);
        parameters.insert(wanted, options[(current + 1) % options.len()].get("value").cloned().unwrap_or(Value::Null));
        self.parameters.insert(model_key(model), parameters);
        if !self.fast_available_at_selected(model) {
            self.fasts.insert(model_key(model), false);
        }
        true
    }

    /// Cycles the model's toggle parameter (`thinking`, or Daybreak Blue's on/off).
    pub fn cycle_thinking(&mut self, model: &Value) -> bool {
        self.cycle_parameter(model, &["thinking", DAYBREAK_PARAMETER_ID])
    }

    /// Cycles OpenRouter's Routing (Auto, Price, Speed, Latency); false on other rows.
    pub fn cycle_routing(&mut self, model: &Value) -> bool {
        self.cycle_parameter(model, &[OPENROUTER_SORT_PARAMETER])
    }

    // ---- context window ----

    /// `contextSelectionFor(model)`: the 10% notch the route, state or saved value seeds, and the tokens it resolves to;
    /// `None` when the model has no window.
    pub fn context_selection_for(&mut self, model: &Value) -> Option<ContextSelection> {
        let key = model_key(model);
        let default_window = model_context_window(model);
        let declared_max = mixdog_js::to_number_of(model.get("maxContextWindow"));
        let max_window = default_window.max(if declared_max.is_nan() { 0.0 } else { declared_max });
        if max_window == 0.0 {
            return None;
        }
        let default_percent = clamp_percent(mixdog_js::math::round(default_window / max_window * 10.0) * 10.0);
        if !self.context.contains_key(&key) {
            let requested = if self.is_current_route(model) {
                self.current_route.as_ref().and_then(|route| route.get("contextPercent")).cloned()
            } else if self.is_state_route(model) {
                Some(self.state.context_percent.clone())
            } else {
                model.get("savedContextPercent").cloned()
            };
            let number = mixdog_js::to_number_of(requested.as_ref());
            let percent = if number.is_finite() && number > 0.0 { clamp_percent(mixdog_js::math::round(number / 10.0) * 10.0) } else { default_percent };
            self.context.insert(key.clone(), percent);
        }
        let percent = self.context[&key];
        let tokens = if percent == default_percent { default_window } else { (max_window * percent as f64 / 100.0).floor() };
        Some(ContextSelection { percent, default_percent, tokens })
    }

    /// Steps the context one 10% notch; false when the model has no window.
    pub fn step_context(&mut self, model: &Value, direction: i64) -> bool {
        let Some(context) = self.context_selection_for(model) else { return false };
        self.context.insert(model_key(model), clamp_percent((context.percent + direction * 10) as f64));
        true
    }

    // ---- the route Enter saves ----

    /// The route Enter saves for `selected`, with the effort it was coerced to.
    pub fn route_input_for(&mut self, selected: &Value) -> (Option<String>, Value) {
        let coerced = self.coerce_effort(selected);
        let fast_capable = self.fast_available_for(selected, &coerced);
        let context = self.context_selection_for(selected);
        let mut other = self.model_parameters_for(selected);
        let tier = other.remove("serviceTier").filter(truthy);
        let selected_fast = self.get_selected_fast(selected);
        if let Some(tier) = tier.filter(|_| fast_capable && selected_fast) {
            other.insert("serviceTier".to_owned(), tier);
        }
        let mut route = Map::new();
        route.insert("provider".to_owned(), selected.get("provider").cloned().unwrap_or(Value::Null));
        route.insert("model".to_owned(), selected.get("id").cloned().unwrap_or(Value::Null));
        if let Some(effort) = &coerced {
            route.insert("effort".to_owned(), json!(effort));
        }
        if let Some(context) = context {
            route.insert("contextPercent".to_owned(), json!(context.percent));
        }
        if selected.get("fastCapable").is_some_and(truthy) {
            route.insert("fast".to_owned(), json!(fast_capable && selected_fast));
        }
        if selected.get("modelParameterOptions").and_then(Value::as_array).is_some_and(|options| !options.is_empty()) {
            route.insert("modelParameters".to_owned(), Value::Object(other));
        }
        (coerced, Value::Object(route))
    }
}
