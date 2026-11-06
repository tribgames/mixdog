//! Route resolution and the saved per-model settings (`runtime-core/config-helpers.mjs`
//! `makeResolveRoute`, `model-capabilities.mjs` `saveModelSettings`, `effort.mjs`,
//! `workflow.mjs` `normalizeWorkflowRoute`, `default-context-window.mjs`,
//! `route-context-state.mjs`): pure functions over the config document and route JSON.
//! A "request" is the JS object a caller passes; a key that is absent is `undefined`.

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use super::routes::normalize_route_chain;

pub const DEFAULT_PROVIDER: &str = "anthropic-oauth";
pub const DEFAULT_CONTEXT_WINDOW_CEILING: f64 = 500_000.0;

pub type Obj = Map<String, Value>;

/// `clean(value)`: `String(value ?? '').trim()`.
pub fn clean(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_trim(&value_to_string(other)).to_owned(),
    }
}

/// JS truthiness of an optional value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// `Number(v)` of an optional value (`Number(undefined)` is NaN).
pub fn number(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, to_number)
}

pub use mixdog_js::json_number as jnum;

/// `Math.round`: halves go toward +Infinity.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `a ?? b` over optional JSON values.
pub fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some => some,
    }
}

/// `delete obj[key]` keeping the order of the other keys.
pub fn del(map: &mut Obj, key: &str) {
    map.shift_remove(key);
}

fn is_undefined_or_null(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

// -- effort ---------------------------------------------------------------------------

pub use crate::effort::normalize_effort_input;
pub use crate::effort::normalize_saved_effort;

fn opt_str(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

// -- context window -------------------------------------------------------------------

/// `normalizeContextTokens`.
pub fn normalize_context_tokens(value: Option<&Value>) -> Option<f64> {
    let tokens = js_round(number(value));
    (tokens.is_finite() && tokens > 0.0).then_some(tokens)
}

fn positive_tokens(value: Option<&Value>) -> f64 {
    let tokens = number(value);
    if tokens.is_finite() && tokens > 0.0 { tokens.floor() } else { 0.0 }
}

/// `contextWindowRange`: the default and the largest selectable window.
pub fn context_window_range(provider: &str, context_window: Option<&Value>, max_context_window: Option<&Value>) -> (f64, f64) {
    let served = positive_tokens(context_window);
    let max_window = served.max(positive_tokens(max_context_window));
    if served <= DEFAULT_CONTEXT_WINDOW_CEILING {
        return (served, max_window);
    }
    let lower = provider.to_lowercase();
    if lower == "mixdog-local" || lower == "local" {
        return (served, max_window);
    }
    if js_round(DEFAULT_CONTEXT_WINDOW_CEILING / max_window * 10.0) >= 10.0 {
        return (served, max_window);
    }
    (DEFAULT_CONTEXT_WINDOW_CEILING, max_window)
}

fn clamp_percent(p: f64) -> f64 {
    p.clamp(10.0, 100.0)
}

/// The three fields of `resolveRouteContextState` (`None` = undefined).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ContextState {
    pub context_percent: Option<f64>,
    pub context_default_percent: Option<f64>,
    pub selected_context_window: Option<f64>,
    pub context_tokens: Option<f64>,
}

/// `resolveRouteContextState`; `window_meta` is the model row's (or cached provider row's)
/// `contextWindow` / `maxContextWindow` holder, already resolved by the caller.
pub fn resolve_route_context_state(route: &Obj, window_meta: Option<&Value>) -> ContextState {
    let provider = clean(route.get("provider"));
    let (default_window, max_window) = context_window_range(
        &provider,
        window_meta.and_then(|m| m.get("contextWindow")),
        window_meta.and_then(|m| m.get("maxContextWindow")),
    );
    if max_window == 0.0 {
        return ContextState::default();
    }
    let default_percent = clamp_percent(js_round(default_window / max_window * 10.0) * 10.0);
    if let Some(requested) = normalize_context_tokens(route.get("contextTokens")) {
        let tokens = (max_window * 0.1).ceil().max(requested.min(max_window));
        if tokens == default_window {
            return ContextState {
                context_percent: Some(default_percent),
                context_default_percent: Some(default_percent),
                selected_context_window: Some(default_window),
                context_tokens: None,
            };
        }
        return ContextState {
            context_percent: Some(clamp_percent(js_round(tokens / max_window * 10.0) * 10.0)),
            context_default_percent: Some(default_percent),
            selected_context_window: Some(tokens),
            context_tokens: Some(tokens),
        };
    }
    let requested = number(route.get("contextPercent"));
    let percent = if requested.is_finite() && requested > 0.0 {
        clamp_percent(js_round(requested / 10.0) * 10.0)
    } else {
        default_percent
    };
    let selected = if percent == default_percent {
        default_window
    } else {
        1.0_f64.max((max_window * percent / 100.0).floor())
    };
    ContextState {
        context_percent: Some(percent),
        context_default_percent: Some(default_percent),
        selected_context_window: Some(selected),
        context_tokens: None,
    }
}

// -- presets and saved settings -------------------------------------------------------

/// `routeFastKey`.
pub fn route_fast_key(provider: Option<&Value>, model: Option<&Value>) -> String {
    let p = clean(provider);
    let m = clean(model);
    if p.is_empty() || m.is_empty() { String::new() } else { format!("{p}/{m}") }
}

/// `modelSettingsFor`: the saved settings of `provider/model`, `{}` when none.
pub fn model_settings_for(config: &Obj, provider: &str, model: &str) -> Obj {
    let key = route_fast_key(Some(&Value::from(provider)), Some(&Value::from(model)));
    if key.is_empty() {
        return Obj::new();
    }
    match config.get("modelSettings").and_then(|s| s.get(&key)) {
        Some(Value::Object(o)) => o.clone(),
        _ => Obj::new(),
    }
}

/// `findPreset`.
pub fn find_preset<'a>(config: &'a Obj, key: Option<&Value>) -> Option<&'a Value> {
    let wanted = clean(key).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    config.get("presets")?.as_array()?.iter().find(|p| {
        clean(p.get("id")).to_lowercase() == wanted || clean(p.get("name")).to_lowercase() == wanted
    })
}

/// `fastPreferenceFor(config, provider, model)`.
pub fn fast_preference_for(config: &Obj, provider: &str, model: &str) -> bool {
    let key = route_fast_key(Some(&Value::from(provider)), Some(&Value::from(model)));
    !key.is_empty()
        && config
            .get("modelSettings")
            .and_then(|s| s.get(&key))
            .is_some_and(|saved| saved.is_object() && saved.get("fast") == Some(&Value::Bool(true)))
}

fn clean_model_parameters(value: Option<&Value>) -> Obj {
    let Some(Value::Object(o)) = value else { return Obj::new() };
    let mut out = Obj::new();
    for (k, v) in o {
        let key = js_trim(k).to_owned();
        let entry = clean(Some(v));
        if !key.is_empty() && !entry.is_empty() {
            out.insert(key, Value::String(entry));
        }
    }
    out
}

/// `normalizeContextPercent`: a requested share snapped to 10% steps within 10..100.
pub fn clean_context_percent(value: Option<&Value>) -> Option<f64> {
    let percent = number(value);
    if !percent.is_finite() || percent <= 0.0 {
        return None;
    }
    Some(clamp_percent(js_round(percent / 10.0) * 10.0))
}

/// `isLikelyRawModelId`.
pub fn is_likely_raw_model_id(value: Option<&Value>) -> bool {
    let model = clean(value);
    if model.is_empty() || utf16_len(&model) > 160 || model.chars().any(is_js_space) {
        return false;
    }
    let body = model.strip_prefix('~').unwrap_or(&model);
    let mut chars = body.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '+' | '-'))
}

/// `validateRequestedModelSelector`.
pub fn validate_requested_model_selector(config: &Obj, requested: &Obj) -> Result<(), String> {
    let model = clean(requested.get("model"));
    if model.is_empty() || find_preset(config, Some(&Value::from(model.as_str()))).is_some() {
        return Ok(());
    }
    if is_likely_raw_model_id(Some(&Value::from(model.as_str()))) {
        return Ok(());
    }
    Err(format!(
        "Invalid model selector \"{model}\". Use a preset or a model id; free-form text cannot be used as a model."
    ))
}

/// `ensureProviderEnabled`: the providers map with `provider` enabled.
pub fn ensure_provider_enabled(config: &Obj, provider: &str) -> Obj {
    let mut providers = match config.get("providers") {
        Some(Value::Object(o)) => o.clone(),
        _ => Obj::new(),
    };
    let mut entry = match providers.get(provider) {
        Some(Value::Object(o)) => o.clone(),
        _ => Obj::new(),
    };
    entry.insert("enabled".into(), Value::Bool(true));
    providers.insert(provider.to_owned(), Value::Object(entry));
    providers
}

/// `modelMetaLooksResolved`: the row says more than its `id` and `provider`.
pub fn model_meta_looks_resolved(meta: Option<&Value>) -> bool {
    meta.and_then(Value::as_object).is_some_and(|o| o.keys().any(|k| k != "id" && k != "provider"))
}

// -- resolveRoute ---------------------------------------------------------------------

/// The provider a provider-less Main selector falls to; `is_known(provider, config)` is
/// `isKnownProvider`.
pub fn resolve_default_provider(config: &Obj, is_known: &dyn Fn(&str, &Obj) -> bool) -> String {
    let selected = find_preset(config, config.get("default"));
    let configured = clean(selected.and_then(|p| p.get("provider")));
    if !configured.is_empty() && is_known(&configured, config) {
        return configured;
    }
    DEFAULT_PROVIDER.to_owned()
}

fn resolve_context_tokens(
    context_tokens: Option<&Value>,
    explicit_percent: bool,
    saved: &Obj,
    preset: Option<&Value>,
) -> Option<f64> {
    if context_tokens.is_some() {
        return normalize_context_tokens(context_tokens);
    }
    if explicit_percent {
        return None;
    }
    normalize_context_tokens(nullish(saved.get("contextTokens"), preset.and_then(|p| p.get("contextTokens"))))
}

/// `resolveRoute(config, request)`.
pub fn resolve_route(config: &Obj, request: &Obj, is_known: &dyn Fn(&str, &Obj) -> bool) -> Result<Obj, String> {
    let explicit_provider = clean(request.get("provider"));
    let explicit_model = clean(request.get("model"));
    let has_effort = request.contains_key("effort");
    let explicit_effort = if has_effort { normalize_effort_input(request.get("effort"))? } else { None };
    let fast = request.get("fast");
    let explicit_percent = request.contains_key("contextPercent");
    let keeps_saved_percent = !request.contains_key("contextTokens");
    let context_tokens = request.get("contextTokens");
    let auto_effort = request.get("autoEffort");
    let has_params = request.contains_key("modelParameters");

    let build = |provider: String, model: String, preset: Option<&Value>, saved: Obj| -> Obj {
        let tokens = resolve_context_tokens(context_tokens, explicit_percent, &saved, preset);
        let effort = if has_effort {
            explicit_effort.clone()
        } else {
            normalize_saved_effort(nullish(saved.get("effort"), preset.and_then(|p| p.get("effort"))))
        };
        let fast_value = if fast.is_some() {
            fast == Some(&Value::Bool(true))
        } else if saved.contains_key("fast") {
            saved.get("fast") == Some(&Value::Bool(true))
        } else {
            preset.is_some_and(|p| p.get("fast") == Some(&Value::Bool(true)))
                || fast_preference_for(config, &provider, &model)
        };
        let auto = if auto_effort.is_some() {
            auto_effort != Some(&Value::Bool(false))
        } else if saved.contains_key("autoEffort") {
            saved.get("autoEffort") != Some(&Value::Bool(false))
        } else {
            preset.is_none_or(|p| p.get("autoEffort") != Some(&Value::Bool(false)))
        };
        let params = if has_params {
            clean_model_parameters(request.get("modelParameters"))
        } else {
            clean_model_parameters(nullish(saved.get("modelParameters"), preset.and_then(|p| p.get("modelParameters"))))
        };
        let percent = if explicit_percent {
            clean_context_percent(request.get("contextPercent"))
        } else if keeps_saved_percent {
            clean_context_percent(nullish(saved.get("contextPercent"), preset.and_then(|p| p.get("contextPercent"))))
        } else {
            None
        };
        let mut route = Obj::new();
        route.insert("provider".into(), Value::String(provider));
        route.insert("model".into(), Value::String(model));
        route.insert("preset".into(), preset.cloned().unwrap_or(Value::Null));
        route.insert("effort".into(), opt_str(effort));
        route.insert("fast".into(), Value::Bool(fast_value));
        route.insert("autoEffort".into(), Value::Bool(auto));
        route.insert("modelParameters".into(), Value::Object(params));
        if let Some(p) = percent {
            route.insert("contextPercent".into(), jnum(p));
        }
        if let Some(t) = tokens {
            route.insert("contextTokens".into(), jnum(t));
        }
        route
    };

    if explicit_provider.is_empty() {
        let key = if explicit_model.is_empty() { config.get("default").cloned() } else { Some(Value::from(explicit_model.as_str())) };
        if let Some(preset) = find_preset(config, key.as_ref()) {
            let p = clean(preset.get("provider"));
            let m = clean(preset.get("model"));
            if !p.is_empty() && !m.is_empty() {
                let saved = model_settings_for(config, &p, &m);
                return Ok(build(p, m, Some(preset), saved));
            }
        }
    }
    let p = if explicit_provider.is_empty() { resolve_default_provider(config, is_known) } else { explicit_provider };
    let saved = model_settings_for(config, &p, &explicit_model);
    Ok(build(p, explicit_model, None, saved))
}

// -- saveModelSettings ----------------------------------------------------------------

/// `saveModelSettings(cfgMod, route, { fastCapable })` applied to `config` in place.
pub fn save_model_settings(config: &mut Obj, route: &Obj, fast_capable: bool) {
    let key = route_fast_key(route.get("provider"), route.get("model"));
    if key.is_empty() {
        return;
    }
    let mut settings = match config.get("modelSettings") {
        Some(Value::Object(o)) => o.clone(),
        _ => Obj::new(),
    };
    let mut next = match settings.get(&key) {
        Some(Value::Object(o)) => o.clone(),
        _ => Obj::new(),
    };
    match route.get("effort") {
        Some(e) if truthy(Some(e)) => {
            next.insert("effort".into(), e.clone());
        }
        _ => del(&mut next, "effort"),
    }
    next.insert("fast".into(), Value::Bool(fast_capable && route.get("fast") == Some(&Value::Bool(true))));
    if route.contains_key("autoEffort") {
        if route.get("autoEffort") == Some(&Value::Bool(false)) {
            next.insert("autoEffort".into(), Value::Bool(false));
        } else {
            del(&mut next, "autoEffort");
        }
    }
    match route.get("modelParameters") {
        Some(Value::Object(o)) => {
            next.insert("modelParameters".into(), Value::Object(clean_model_parameters(Some(&Value::Object(o.clone())))));
        }
        Some(Value::Array(_)) => {
            next.insert("modelParameters".into(), Value::Object(Obj::new()));
        }
        _ => del(&mut next, "modelParameters"),
    }
    let tokens = normalize_context_tokens(route.get("contextTokens"));
    let requested = number(route.get("contextPercent"));
    let percent = js_round(requested / 10.0) * 10.0;
    let is_default = percent == number(route.get("contextDefaultPercent"));
    if let Some(t) = tokens {
        next.insert("contextTokens".into(), jnum(t));
        del(&mut next, "contextPercent");
    } else if (10.0..=100.0).contains(&requested) && !is_default {
        next.insert("contextPercent".into(), jnum(percent));
        del(&mut next, "contextTokens");
    } else {
        del(&mut next, "contextPercent");
        del(&mut next, "contextTokens");
    }
    settings.insert(key, Value::Object(next));
    config.insert("modelSettings".into(), Value::Object(settings));
}

// -- workflow routes ------------------------------------------------------------------

/// `workflowPresetId`.
pub fn workflow_preset_id(slot: &str) -> String {
    format!("workflow-{slot}")
}

fn spread_object(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Object(a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect()),
        other => other.clone(),
    }
}

fn workflow_leaf(route: &Value, fallback: &Value) -> Result<Option<Value>, String> {
    let get = |k: &str| route.get(k);
    let fb = |k: &str| fallback.get(k);
    let provider = match clean(get("provider")) {
        s if s.is_empty() => clean(fb("provider")),
        s => s,
    };
    let model = match clean(get("model")) {
        s if s.is_empty() => clean(fb("model")),
        s => s,
    };
    if provider.is_empty() || model.is_empty() || !is_likely_raw_model_id(Some(&Value::from(model.as_str()))) {
        return Ok(None);
    }
    let effort = normalize_effort_input(nullish(get("effort"), fb("effort")))?;
    let fast = nullish(get("fast"), fb("fast"));
    let auto_effort = nullish(get("autoEffort"), fb("autoEffort"));
    let params = nullish(get("modelParameters"), fb("modelParameters"));
    let requested = number(nullish(get("contextPercent"), fb("contextPercent")));
    let percent = (requested.is_finite() && (10.0..=100.0).contains(&requested)).then(|| js_round(requested / 10.0) * 10.0);
    let tokens_src = nullish(get("contextTokens"), if is_undefined_or_null(get("contextPercent")) { fb("contextTokens") } else { None });
    let tokens = normalize_context_tokens(tokens_src);
    let mut out = Obj::new();
    out.insert("provider".into(), Value::String(provider));
    out.insert("model".into(), Value::String(model));
    if let Some(e) = effort {
        out.insert("effort".into(), Value::String(e));
    }
    if let Some(Value::Bool(b)) = fast {
        out.insert("fast".into(), Value::Bool(*b));
    }
    if auto_effort == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), Value::Bool(false));
    }
    if let Some(p) = params.filter(|p| p.is_object() || p.is_array()) {
        out.insert("modelParameters".into(), spread_object(p));
    }
    if let Some(p) = percent.filter(|p| *p != 0.0) {
        out.insert("contextPercent".into(), jnum(p));
    }
    if let Some(t) = tokens {
        out.insert("contextTokens".into(), jnum(t));
    }
    Ok(Some(Value::Object(out)))
}

/// `normalizeWorkflowRoute(route, fallback, { strict })`: `Ok(None)` is JS `null`.
pub fn normalize_workflow_route(route: &Value, fallback: &Value, strict: bool) -> Result<Option<Value>, String> {
    // The chain normalizer's leaf cannot throw; the first leaf error is kept and wins.
    let failure = std::cell::RefCell::new(None::<String>);
    let leaf = |r: &Value, f: &Value| match workflow_leaf(r, f) {
        Ok(v) => v,
        Err(e) => {
            failure.borrow_mut().get_or_insert(e);
            None
        }
    };
    let result = normalize_route_chain(route, &leaf, fallback, strict);
    if let Some(e) = failure.into_inner() {
        return Err(e);
    }
    result
}

// -- refreshRouteEffort ---------------------------------------------------------------------

/// `routeModelDisplay(config, route, meta)` (route-state.mjs:46).
pub fn route_model_display(config: &Obj, route: &Obj, meta: Option<&Value>) -> String {
    let field = |key: &str| clean(meta.and_then(|m| m.get(key)));
    let alias = clean(model_settings_for(config, &clean(route.get("provider")), &clean(route.get("model"))).get("alias"));
    if !alias.is_empty() {
        return alias;
    }
    for key in ["display", "displayName"] {
        let v = field(key);
        if !v.is_empty() {
            return v;
        }
    }
    let name = field("name");
    if !name.is_empty() && name != clean(route.get("model")) {
        return name;
    }
    clean(route.get("modelDisplay"))
}

/// `fastCapableFor(provider, meta, effort, modelParameters)`.
pub type FastCapable<'a> = &'a dyn Fn(&str, &Value, Option<&str>, &Value) -> bool;

/// `resolveRouteEffortState` (route-state.mjs:11): the effective effort (`null` when none) and
/// whether the route may run Fast.
pub fn resolve_route_effort_state(target: &Obj, meta: Option<&Value>, fast: FastCapable<'_>) -> (Value, bool) {
    let requested = if target.contains_key("effort") {
        target["effort"].clone()
    } else {
        let preset_effort = target.get("preset").and_then(|p| p.get("effort"));
        if truthy(preset_effort) { preset_effort.cloned().unwrap_or(Value::Null) } else { Value::Null }
    };
    if !model_meta_looks_resolved(meta) {
        let effective = if truthy(Some(&requested)) { requested } else { Value::Null };
        return (effective, target.get("fast") == Some(&Value::Bool(true)));
    }
    let meta = meta.unwrap_or(&Value::Null);
    let provider = target.get("provider").and_then(Value::as_str).unwrap_or("");
    let effective = requested.as_str().and_then(|e| crate::effort::coerce_effort_for(provider, meta, e, None));
    let params = target.get("modelParameters").cloned().unwrap_or(Value::Null);
    let capable = fast(provider, meta, effective.as_deref(), &params);
    (effective.map_or(Value::Null, Value::String), capable)
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    let n = number(value);
    (n > 0.0).then_some(n)
}

/// The route `refreshRouteEffort` (route-resolution.mjs:36) leaves on the runtime: the effort, Fast,
/// context and display fields derived from `target` and its model row. `live_provider` is the
/// provider of the runtime's current route, whose ladder lists the effort options.
pub fn refresh_route_fields(config: &Obj, target: &Obj, meta: Option<&Value>, live_provider: &str, fast: FastCapable<'_>) -> Obj {
    let (effective_effort, fast_capable) = resolve_route_effort_state(target, meta, fast);
    let state = resolve_route_context_state(target, meta);
    let context_value = clean(target.get("modelParameters").and_then(|p| p.get("context")));
    let context_option = meta
        .and_then(|m| m.get("modelParameterOptions"))
        .and_then(Value::as_array)
        .and_then(|options| options.iter().find(|o| o.get("id").and_then(Value::as_str) == Some("context")))
        .and_then(|o| o.get("options"))
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|o| clean(o.get("value")) == context_value));
    let model_display = route_model_display(config, target, meta);
    let window_known = state.context_default_percent.is_some();
    let selected = state
        .selected_context_window
        .filter(|w| *w > 0.0)
        .or_else(|| positive_number(context_option.and_then(|o| o.get("contextWindow"))))
        .or_else(|| if window_known { None } else { positive_number(target.get("selectedContextWindow")) });
    let context_tokens = if window_known { state.context_tokens } else { normalize_context_tokens(target.get("contextTokens")) };
    let mut route = target.clone();
    route.shift_remove("contextTokens");
    route.insert("fast".into(), Value::Bool(fast_capable && target.get("fast") == Some(&Value::Bool(true))));
    route.insert("fastCapable".into(), Value::Bool(fast_capable));
    let active = effective_effort.as_str().map(str::to_owned);
    route.insert("effectiveEffort".into(), effective_effort);
    let items = crate::effort::effort_items_for(live_provider, meta.unwrap_or(&Value::Null), active.as_deref(), None);
    route.insert(
        "effortOptions".into(),
        Value::Array(
            items.into_iter().map(|i| serde_json::json!({ "value": i.value, "label": i.label, "description": i.description })).collect(),
        ),
    );
    let percent = if window_known { state.context_percent.map(jnum) } else { target.get("contextPercent").cloned() };
    match percent {
        Some(p) => route.insert("contextPercent".into(), p),
        None => route.shift_remove("contextPercent"),
    };
    match state.context_default_percent {
        Some(p) => route.insert("contextDefaultPercent".into(), jnum(p)),
        None => route.shift_remove("contextDefaultPercent"),
    };
    if let Some(tokens) = context_tokens.filter(|t| *t != 0.0) {
        route.insert("contextTokens".into(), jnum(tokens));
    }
    if let Some(window) = selected {
        route.insert("selectedContextWindow".into(), jnum(window));
    }
    if !model_display.is_empty() {
        route.insert("modelDisplay".into(), Value::String(model_display));
    }
    route
}

#[cfg(test)]
#[path = "admin_route_tests.rs"]
mod tests;

/// `upsertWorkflowPreset`.
pub fn upsert_workflow_preset(presets: &Value, slot: &str, route: &Value) -> Result<Value, String> {
    let current = presets.as_array().cloned().unwrap_or_default();
    let Some(route) = normalize_workflow_route(route, &Value::Object(Obj::new()), false)? else {
        return Ok(presets.clone());
    };
    let id = workflow_preset_id(slot);
    let name = format!("WORKFLOW {}", slot.to_uppercase());
    let mut preset = Obj::new();
    preset.insert("id".into(), Value::String(id.clone()));
    preset.insert("name".into(), Value::String(name.clone()));
    preset.insert("type".into(), Value::from("agent"));
    preset.insert("provider".into(), route["provider"].clone());
    preset.insert("model".into(), route["model"].clone());
    if truthy(route.get("effort")) {
        preset.insert("effort".into(), route["effort"].clone());
    }
    if route.get("fast") == Some(&Value::Bool(true)) {
        preset.insert("fast".into(), Value::Bool(true));
    }
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        preset.insert("autoEffort".into(), Value::Bool(false));
    }
    if let Some(p) = route.get("modelParameters") {
        preset.insert("modelParameters".into(), p.clone());
    }
    if route.get("fallbacks").and_then(Value::as_array).is_some_and(|f| !f.is_empty()) {
        preset.insert("fallbacks".into(), route["fallbacks"].clone());
    }
    preset.insert("tools".into(), Value::from("full"));
    let mut next: Vec<Value> = current
        .into_iter()
        .filter(|p| clean(p.get("id")) != id && clean(p.get("name")) != name)
        .collect();
    next.push(Value::Object(preset));
    Ok(Value::Array(next))
}

// -- selection validation and the Lead route ------------------------------------------

const MODEL_SELECTION_KEYS: [&str; 10] = [
    "provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens",
    "fallbacks", "onlyIfEmpty",
];

/// `requiredString(value, name, maximum)`.
fn required_string(value: Option<&Value>, name: &str, maximum: usize) -> Result<String, String> {
    let Some(Value::String(s)) = value else { return Err(format!("{name} must be a string.")) };
    let text = js_trim(s);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(format!("{name} is invalid."));
    }
    Ok(text.to_owned())
}

/// `requiredModelSelection` (desktop `ipc-validation.ts`): the checked selection, keys in
/// the order Node builds them; the error is the `TypeError` text.
pub fn required_model_selection(value: &Value) -> Result<Obj, String> {
    let Some(selection) = value.as_object() else { return Err("model selection is invalid.".into()) };
    if selection.keys().any(|k| !MODEL_SELECTION_KEYS.contains(&k.as_str())) {
        return Err("model selection contains an unsupported field.".into());
    }
    let defined = |k: &str| selection.get(k);
    let only_if_empty = defined("onlyIfEmpty");
    if only_if_empty.is_some_and(|v| !v.is_boolean()) {
        return Err("selection.onlyIfEmpty must be a boolean.".into());
    }
    if let Some(t) = defined("contextTokens") {
        let ok = t.as_f64().is_some_and(|f| f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 && f >= 1.0);
        if !ok {
            return Err("selection.contextTokens must be a positive integer.".into());
        }
    }
    if defined("effort").is_some_and(|v| !v.is_string()) {
        return Err("selection.effort must be a string.".into());
    }
    if defined("fast").is_some_and(|v| !v.is_boolean()) {
        return Err("selection.fast must be a boolean.".into());
    }
    if defined("autoEffort").is_some_and(|v| !v.is_boolean()) {
        return Err("selection.autoEffort must be a boolean.".into());
    }
    if let Some(p) = defined("modelParameters") {
        let ok = p.as_object().is_some_and(|o| o.iter().all(|(k, v)| !k.is_empty() && v.is_string()));
        if !ok {
            return Err("selection.modelParameters must be a string map.".into());
        }
    }
    if let Some(p) = defined("contextPercent") {
        let ok = p.as_f64().is_some_and(|f| (10.0..=100.0).contains(&f) && f % 10.0 == 0.0);
        if !ok {
            return Err("selection.contextPercent must be a 10-point percentage from 10 to 100.".into());
        }
    }
    let mut fallbacks = None;
    if let Some(list) = defined("fallbacks") {
        let Some(list) = list.as_array().filter(|l| l.len() <= 16) else {
            return Err("selection.fallbacks must be an array of model selections.".into());
        };
        let mut checked = Vec::new();
        for entry in list {
            if entry.as_object().is_some_and(|o| o.contains_key("fallbacks")) {
                return Err("fallback selections must be leaf selections.".into());
            }
            checked.push(Value::Object(required_model_selection(entry)?));
        }
        fallbacks = Some(Value::Array(checked));
    }
    let mut out = Obj::new();
    out.insert("provider".into(), Value::String(required_string(selection.get("provider"), "selection.provider", 256)?));
    if let Some(f) = fallbacks {
        out.insert("fallbacks".into(), f);
    }
    out.insert("model".into(), Value::String(required_string(selection.get("model"), "selection.model", 512)?));
    if defined("effort").is_some() {
        out.insert("effort".into(), Value::String(required_string(selection.get("effort"), "selection.effort", 64)?));
    }
    for key in ["fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"] {
        if let Some(v) = defined(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if only_if_empty == Some(&Value::Bool(true)) {
        out.insert("onlyIfEmpty".into(), Value::Bool(true));
    }
    Ok(out)
}

/// The model row whose windows size a route: the row itself when it states one, else the
/// cached provider row, else the row (`resolveRouteContextState`'s `windowMeta`).
pub fn window_meta_of<'a>(meta: Option<&'a Value>, cached: Option<&'a Value>) -> Option<&'a Value> {
    let states = |m: Option<&Value>| {
        number(m.and_then(|m| m.get("contextWindow"))) > 0.0 || number(m.and_then(|m| m.get("maxContextWindow"))) > 0.0
    };
    if states(meta) { meta } else { cached.or(meta) }
}

/// `tunesNonMainModel`: re-tuning the live model is not a Main-model choice.
pub fn tunes_non_main_model(live: &Obj, route: &Obj, main: &Obj) -> bool {
    let same = |o: &Obj| o.get("provider") == route.get("provider") && o.get("model") == route.get("model");
    same(live) && !same(main)
}

/// `persistLeadRoute`: the Lead preset and `default` written into `config`; the normalized
/// Lead route, or `None` when it normalizes to nothing.
pub fn persist_lead_route(config: &mut Obj, route: &Value) -> Result<Option<Value>, String> {
    let Some(lead) = normalize_workflow_route(route, &Value::Object(Obj::new()), false)? else { return Ok(None) };
    let presets = config.get("presets").cloned().unwrap_or(Value::Null);
    config.insert("presets".into(), upsert_workflow_preset(&presets, "lead", &lead)?);
    config.insert("default".into(), Value::String(workflow_preset_id("lead")));
    Ok(Some(lead))
}

// -- selection fast clamp, chain entries, Lead persistence -----------------------------
/// `selectionFastCapable(provider, meta, effort, params)`: placeholder metadata is unknown,
/// not "no Fast". `catalog_capable` is `fastCapableFor(...)`, asked only for resolved rows.
pub fn selection_fast_capable(meta: Option<&Value>, catalog_capable: impl FnOnce() -> bool) -> bool {
    !model_meta_looks_resolved(meta) || catalog_capable()
}

fn put(map: &mut Obj, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            map.insert(key.to_owned(), v);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// `resolveChainEntry`, first half: the route the entry selects, with what it inherits from
/// the `stored` entry of the same model. The caller then readies the provider and looks up
/// the model row, and calls [`finish_chain_entry`].
pub fn start_chain_entry(
    config: &Obj,
    requested: &Obj,
    stored: &Obj,
    is_known: &dyn Fn(&str, &Obj) -> bool,
) -> Result<Obj, String> {
    let mut selected = resolve_route(config, requested, is_known)?;
    let same_model = clean(selected.get("provider")) == clean(stored.get("provider"))
        && clean(selected.get("model")) == clean(stored.get("model"));
    let defined = |k: &str| requested.contains_key(k);
    let stored_truthy = |k: &str| stored.get(k).filter(|v| truthy(Some(*v))).cloned();
    let requests_percent = defined("contextPercent");
    let requests_tokens = defined("contextTokens");
    let effort = if defined("effort") {
        selected.get("effort").cloned()
    } else {
        Some(if same_model { stored_truthy("effort").unwrap_or(Value::Null) } else { Value::Null })
    };
    let fast = if defined("fast") {
        selected.get("fast") == Some(&Value::Bool(true))
    } else {
        same_model && stored.get("fast") == Some(&Value::Bool(true))
    };
    let auto_effort = if defined("autoEffort") {
        requested.get("autoEffort") != Some(&Value::Bool(false))
    } else {
        !same_model || stored.get("autoEffort") != Some(&Value::Bool(false))
    };
    let model_parameters = if defined("modelParameters") {
        selected.get("modelParameters").cloned()
    } else {
        Some(if same_model { stored_truthy("modelParameters").unwrap_or(Value::Object(Obj::new())) } else { Value::Object(Obj::new()) })
    };
    let percent = if requests_percent {
        requested.get("contextPercent").cloned()
    } else if same_model && !requests_tokens {
        stored.get("contextPercent").cloned()
    } else {
        None
    };
    let tokens = if requests_tokens {
        requested.get("contextTokens").cloned()
    } else if same_model && !requests_percent {
        stored.get("contextTokens").cloned()
    } else {
        None
    };
    put(&mut selected, "effort", effort);
    put(&mut selected, "fast", Some(Value::Bool(fast)));
    put(&mut selected, "autoEffort", Some(Value::Bool(auto_effort)));
    put(&mut selected, "modelParameters", model_parameters);
    put(&mut selected, "contextPercent", percent);
    put(&mut selected, "contextTokens", tokens);
    Ok(selected)
}

/// `resolveChainEntry`, second half: the window clamp and the Fast clamp against the model
/// row. `window_meta` is [`window_meta_of`]; `fast_catalog` is `fastCapableFor(...)`.
pub fn finish_chain_entry(
    mut selected: Obj,
    meta: Option<&Value>,
    window_meta: Option<&Value>,
    fast_catalog: impl FnOnce(&Obj) -> bool,
) -> Obj {
    let state = resolve_route_context_state(&selected, window_meta);
    if state.context_default_percent.is_some() {
        put(&mut selected, "contextTokens", state.context_tokens.map(jnum));
    }
    let capable = selection_fast_capable(meta, || fast_catalog(&selected));
    let fast = capable && selected.get("fast") == Some(&Value::Bool(true));
    selected.insert("fast".into(), Value::Bool(fast));
    selected
}

/// `persistAdoptedModelSettings(route, { keepMainModel })` (route-persist.mjs) on `config`:
/// the Lead preset is written unless the selection keeps the Main model, or only re-tunes the
/// live model that is not Main. Returns the Lead route written.
pub fn persist_adopted_model_settings(
    config: &mut Obj,
    live: &Obj,
    route: &Obj,
    keep_main_model: Option<bool>,
    is_known: &dyn Fn(&str, &Obj) -> bool,
) -> Result<Option<Value>, String> {
    let keeps = match keep_main_model {
        Some(true) => true,
        Some(false) => false,
        None => {
            let main = resolve_route(config, &Obj::new(), is_known)?;
            tunes_non_main_model(live, route, &main)
        }
    };
    if keeps {
        return Ok(None);
    }
    persist_lead_route(config, &Value::Object(route.clone()))
}

