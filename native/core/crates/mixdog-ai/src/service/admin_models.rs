//! `model/list` pure parts (to move into `mixdog-ai/src/service/admin_models.rs`):
//! model-recency (sort, selectable, cache row), model-select `providerRows`,
//! openai-daybreak / OpenRouter parameter options, and row hydration.

use std::cmp::Ordering;

use super::admin_route::{
    Obj, clean, context_window_range, fast_preference_for, jnum, model_settings_for, truthy,
};
use mixdog_js::time::date_parse;
use mixdog_js::{is_js_space, js_trim, locale_compare, to_number, value_to_string};
use serde_json::{Value, json};

fn text(v: Option<&Value>) -> String {
    clean(v)
}

// -- version parsing ---------------------------------------------------------------------

fn digit_run(b: &[u8], i: usize) -> usize {
    let mut j = i;
    while b.get(j).is_some_and(u8::is_ascii_digit) {
        j += 1;
    }
    j
}

fn num(b: &[u8], from: usize, to: usize) -> f64 {
    let v: f64 = std::str::from_utf8(&b[from..to]).unwrap_or("0").parse().unwrap_or(0.0);
    if v.is_nan() { 0.0 } else { v }
}

/// `(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?` at `i`.
fn numbers_at(b: &[u8], i: usize) -> Option<Vec<f64>> {
    let e1 = digit_run(b, i);
    if e1 == i {
        return None;
    }
    let mut out = vec![num(b, i, e1)];
    let mut j = e1;
    if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(u8::is_ascii_digit) {
        let e2 = digit_run(b, j + 1);
        out.push(num(b, j + 1, e2));
        j = e2;
        if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(u8::is_ascii_digit) {
            let e3 = digit_run(b, j + 1).min(j + 4);
            out.push(num(b, j + 1, e3));
        }
    }
    Some(out)
}

fn claude_version(b: &[u8]) -> Option<Vec<f64>> {
    let rest = b.strip_prefix(b"claude-")?;
    let letters = rest.iter().take_while(|c| c.is_ascii_lowercase()).count();
    if letters == 0 || rest.get(letters) != Some(&b'-') {
        return None;
    }
    let at = 7 + letters + 1;
    let e1 = digit_run(b, at);
    if e1 == at {
        return None;
    }
    let mut out = vec![num(b, at, e1), 0.0];
    if matches!(b.get(e1), Some(b'-' | b'.')) && b.get(e1 + 1).is_some_and(u8::is_ascii_digit) {
        out[1] = num(b, e1 + 1, digit_run(b, e1 + 1));
    }
    Some(out)
}

const COMPACT_NAMES: [&[u8]; 9] = [b"o", b"gpt", b"grok", b"qwen", b"llama", b"mistral", b"gemma", b"phi", b"glm"];

fn compact_version(b: &[u8]) -> Option<Vec<f64>> {
    for start in 0..=b.len() {
        // `(?:^|[-_])`: the anchor first at 0, then a separator character.
        let mut after = Vec::new();
        if start == 0 {
            after.push(0);
        }
        if matches!(b.get(start), Some(b'-' | b'_')) {
            after.push(start + 1);
        }
        for at in after {
            for name in COMPACT_NAMES {
                if b[at..].starts_with(name)
                    && let Some(v) = numbers_at(b, at + name.len())
                {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn generic_version(b: &[u8]) -> Option<Vec<f64>> {
    for start in 0..=b.len() {
        if start == 0
            && let Some(v) = numbers_at(b, 0)
        {
            return Some(v);
        }
        if matches!(b.get(start), Some(b'-' | b'_' | b'v'))
            && let Some(v) = numbers_at(b, start + 1)
        {
            return Some(v);
        }
    }
    None
}

fn parsed_version(id: Option<&Value>) -> Vec<f64> {
    let lower = text(id).to_lowercase();
    let b = lower.as_bytes();
    claude_version(b).or_else(|| compact_version(b)).or_else(|| generic_version(b)).unwrap_or_default()
}

fn first_truthy<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| truthy(Some(*v)))
}

fn compare_version(a: &Value, b: &Value) -> f64 {
    let va = parsed_version(first_truthy(a, &["id", "display", "name"]));
    let vb = parsed_version(first_truthy(b, &["id", "display", "name"]));
    if va.is_empty() && vb.is_empty() {
        return 0.0;
    }
    if va.is_empty() {
        return 1.0;
    }
    if vb.is_empty() {
        return -1.0;
    }
    for i in 0..va.len().max(vb.len()) {
        let delta = vb.get(i).copied().unwrap_or(0.0) - va.get(i).copied().unwrap_or(0.0);
        if delta != 0.0 {
            return delta;
        }
    }
    0.0
}

fn release_time(model: &Value) -> f64 {
    if truthy(model.get("releaseDate")) {
        let t = date_parse(&value_to_string(&model["releaseDate"]));
        if t.is_finite() {
            return t;
        }
    }
    if let Some(created) = model.get("created") {
        let created = to_number(created);
        if created.is_finite() && created > 0.0 {
            return if created < 1_000_000_000_000.0 { created * 1000.0 } else { created };
        }
    }
    dated_id_time(&text(model.get("id")))
}

/// `/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/` over the id, as `Date.parse(...) || 0`.
fn dated_id_time(id: &str) -> f64 {
    let b = id.as_bytes();
    for start in 0..=b.len() {
        let mut at = Vec::new();
        if start == 0 {
            at.push(0);
        }
        if b.get(start) == Some(&b'-') {
            at.push(start + 1);
        }
        for i in at {
            if b.len() >= i + 8 && b[i..i + 8].iter().all(u8::is_ascii_digit) && matches!(b.get(i + 8), None | Some(b'-')) {
                let t = date_parse(&format!("{}-{}-{}", &id[i..i + 4], &id[i + 4..i + 6], &id[i + 6..i + 8]));
                return if t.is_nan() { 0.0 } else { t };
            }
        }
    }
    0.0
}

fn is_claude_model(model: &Value) -> bool {
    let id = text(model.get("id")).to_lowercase();
    let b = id.as_bytes();
    text(model.get("provider")).to_lowercase().contains("anthropic")
        && b.strip_prefix(b"claude-").is_some_and(|rest| {
            let letters = rest.iter().take_while(|c| c.is_ascii_lowercase()).count();
            letters > 0 && rest.get(letters) == Some(&b'-')
        })
}

fn label(row: &Value) -> String {
    text(if truthy(row.get("display")) { row.get("display") } else { row.get("id") })
}

fn ordering(delta: f64) -> Ordering {
    if delta > 0.0 {
        Ordering::Greater
    } else if delta < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

fn latest_order(a: &Value, b: &Value) -> Option<Ordering> {
    (a.get("latest") != b.get("latest")).then(|| if a.get("latest") == Some(&Value::Bool(true)) { Ordering::Less } else { Ordering::Greater })
}

fn compare_recency(a: &Value, b: &Value) -> Ordering {
    if is_claude_model(a) && is_claude_model(b) {
        if let Some(o) = latest_order(a, b) {
            return o;
        }
        let version = compare_version(a, b);
        if version != 0.0 {
            return ordering(version);
        }
        let (ta, tb) = (release_time(a), release_time(b));
        if ta != tb {
            return ordering(tb - ta);
        }
        return locale_compare(&label(a), &label(b));
    }
    let (ta, tb) = (release_time(a), release_time(b));
    let version = compare_version(a, b);
    if ta > 0.0 && tb > 0.0 && ta != tb {
        return ordering(tb - ta);
    }
    if version != 0.0 {
        return ordering(version);
    }
    if let Some(o) = latest_order(a, b) {
        return o;
    }
    if ta != tb {
        return ordering(tb - ta);
    }
    locale_compare(&label(a), &label(b))
}

/// `sortProviderModels(models, primaryProvider)`.
pub fn sort_provider_models(models: &mut [Value], primary: &str) {
    // The recency order is not a strict weak order (its rules can disagree), so the result is
    // the one V8's sort gives, comparison for comparison.
    let mut sorted = models.to_vec();
    mixdog_js::js_sort_by(&mut sorted, |a, b| {
        let rank = |m: &Value| usize::from(m.get("provider").and_then(Value::as_str) != Some(primary));
        let order = rank(a).cmp(&rank(b)).then_with(|| {
            let (pa, pb) = (text(a.get("provider")), text(b.get("provider")));
            if a.get("provider") != b.get("provider") { locale_compare(&pa, &pb) } else { compare_recency(a, b) }
        });
        match order {
            Ordering::Less => -1.0,
            Ordering::Equal => 0.0,
            Ordering::Greater => 1.0,
        }
    });
    models.clone_from_slice(&sorted);
}

/// `isSelectableLlmModel(model)`.
pub fn is_selectable_llm_model(model: &Value) -> bool {
    let id = text(model.get("id")).to_lowercase();
    let display = text(first_truthy(model, &["display", "name"])).to_lowercase();
    let mode = text(model.get("mode")).to_lowercase();
    if id.is_empty() {
        return false;
    }
    if !mode.is_empty() && !["chat", "completion", "responses", "messages"].contains(&mode.as_str()) {
        return false;
    }
    let all = format!("{id} {display}");
    let segments: Vec<&str> = all.split(|c: char| c == '-' || c == '_' || is_js_space(c)).collect();
    const BLOCKED: [&str; 14] = [
        "image", "images", "video", "videos", "audio", "tts", "stt", "speech", "embed", "embedding", "embeddings", "rerank",
        "reranker", "realtime",
    ];
    if segments.iter().any(|s| BLOCKED.contains(s) || *s == "moderation" || *s == "imagine") {
        return false;
    }
    for (i, s) in segments.iter().enumerate() {
        if matches!(*s, "dalle" | "sora" | "imagen") || (*s == "dall" && segments.get(i + 1) == Some(&"e")) {
            return false;
        }
    }
    true
}

// -- cache row ---------------------------------------------------------------------------

fn flag(m: &Value, key: &str) -> Value {
    Value::Bool(m.get(key) == Some(&Value::Bool(true)))
}

fn or_null(v: Option<&Value>) -> Value {
    if truthy(v) { v.cloned().unwrap_or(Value::Null) } else { Value::Null }
}

fn array_or(v: Option<&Value>, default: Value) -> Value {
    match v {
        Some(a @ Value::Array(_)) => a.clone(),
        _ => default,
    }
}

/// `providerModelCacheRow(name, m, webSearchCapableFor)`.
pub fn provider_model_cache_row(name: &str, m: &Value, web_search_capable: bool) -> Obj {
    let (default_window, max_window) = context_window_range(name, m.get("contextWindow"), m.get("maxContextWindow"));
    let mut row = Obj::new();
    let mut put = |k: &str, v: Value| {
        row.insert(k.to_owned(), v);
    };
    put("id", m.get("id").cloned().unwrap_or(Value::Null));
    put("provider", Value::from(name));
    put("display", {
        let pick = first_truthy(m, &["display", "name", "id"]);
        pick.cloned().unwrap_or_else(|| m.get("id").cloned().unwrap_or(Value::Null))
    });
    put("created", match m.get("created") {
        Some(c @ Value::Number(_)) => c.clone(),
        _ => Value::Null,
    });
    put("releaseDate", or_null(m.get("releaseDate")));
    let mut contexts: Vec<(&str, Option<Value>)> = Vec::new();
    contexts.push(("contextWindow", if default_window != 0.0 { Some(jnum(default_window)) } else { m.get("contextWindow").cloned() }));
    contexts.push((
        "maxContextWindow",
        if max_window > default_window {
            Some(jnum(max_window))
        } else {
            Some(if truthy(m.get("maxContextWindow")) { m["maxContextWindow"].clone() } else { Value::Null })
        },
    ));
    for (k, v) in contexts {
        if let Some(v) = v {
            put(k, v);
        }
    }
    put("outputTokens", or_null(m.get("outputTokens")));
    put("family", or_null(m.get("family")));
    put("tier", or_null(m.get("tier")));
    put("latest", flag(m, "latest"));
    put("description", if truthy(m.get("description")) { m["description"].clone() } else { Value::from("") });
    put("supportsVision", flag(m, "supportsVision"));
    put("supportsFunctionCalling", flag(m, "supportsFunctionCalling"));
    put("supportsWebSearch", Value::Bool(web_search_capable));
    put("supportsPromptCaching", flag(m, "supportsPromptCaching"));
    put("supportsReasoning", flag(m, "supportsReasoning"));
    if let Some(a @ Value::Array(_)) = m.get("reasoningLevels") {
        put("reasoningLevels", a.clone());
    }
    put("reasoningOptions", array_or(m.get("reasoningOptions"), json!([])));
    put("reasoningContentField", or_null(m.get("reasoningContentField")));
    put("serviceTiers", array_or(m.get("serviceTiers"), json!([])));
    put("additionalSpeedTiers", array_or(m.get("additionalSpeedTiers"), json!([])));
    put("defaultServiceTier", or_null(m.get("defaultServiceTier")));
    if let Some(a @ Value::Array(_)) = m.get("accessPrograms") {
        put("accessPrograms", a.clone());
    }
    if m.get("hidden") == Some(&Value::Bool(true)) {
        put("hidden", Value::Bool(true));
    }
    put("fastCapable", flag(m, "fastCapable"));
    if let Some(a @ Value::Array(_)) = m.get("fastEfforts") {
        put("fastEfforts", a.clone());
    }
    put("modelParameterOptions", array_or(m.get("modelParameterOptions"), json!([])));
    put("parameterVariants", array_or(m.get("parameterVariants"), json!([])));
    put("defaultModelParameters", match m.get("defaultModelParameters") {
        Some(o @ Value::Object(_)) | Some(o @ Value::Array(_)) => o.clone(),
        _ => json!({}),
    });
    put("defaultEffort", or_null(m.get("defaultEffort")));
    put("defaultFast", flag(m, "defaultFast"));
    put("supportsMaxMode", flag(m, "supportsMaxMode"));
    put("mode", or_null(m.get("mode")));
    if name.starts_with("custom-") {
        for key in ["name", "providerName"] {
            if let Some(Value::String(s)) = m.get(key)
                && !s.is_empty()
            {
                put(key, m[key].clone());
            }
        }
        for key in ["hidden", "manual"] {
            if let Some(b @ Value::Bool(_)) = m.get(key) {
                put(key, b.clone());
            }
        }
        if let Some(o @ (Value::Object(_) | Value::Array(_))) = m.get("customReasoning") {
            put("customReasoning", o.clone());
        }
    }
    row
}

// -- model-select providerRows -----------------------------------------------------------

fn norm(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// `providerRows(rows, provider)`; `provider` empty means no scope.
pub fn provider_rows(rows: &[Value], provider: &str) -> Vec<Value> {
    if provider.is_empty() {
        return rows.to_vec();
    }
    let wanted = norm(provider);
    let row_norm = |r: &Value| norm(&r.get("provider").map(value_to_string).unwrap_or_default());
    let exact: Vec<Value> = rows.iter().filter(|r| row_norm(r) == wanted).cloned().collect();
    if !exact.is_empty() {
        return exact;
    }
    rows.iter().filter(|r| row_norm(r).contains(&wanted)).cloned().collect()
}

// -- provider-availability ---------------------------------------------------------------

/// The environment switch for remote (SSH) mode.
pub const MODEL_PROXY_ENV: &str = "MIXDOG_MODEL_PROXY";

/// `modelProxyClientMode(env)`: the daemon runs on a server that holds no model credentials.
pub fn model_proxy_client_mode(var: &dyn Fn(&str) -> Option<String>) -> bool {
    var(MODEL_PROXY_ENV).as_deref() == Some("client")
}

/// The Developer option id that gates a dev-only OAuth provider (`developerOptionForProvider`).
pub fn developer_option_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "antigravity-oauth" => Some("antigravityOAuth"),
        "cursor-oauth" => Some("cursorOAuth"),
        "devin-oauth" => Some("devinOAuth"),
        "mimo-oauth" => Some("mimoOAuth"),
        _ => None,
    }
}

/// `developerOptionEnabled(id, stored)`: the option exists and its stored value is `true`.
pub fn developer_option_enabled(id: &str, stored: &Value) -> bool {
    const KNOWN: [&str; 5] = ["allowAllActions", "antigravityOAuth", "cursorOAuth", "devinOAuth", "mimoOAuth"];
    KNOWN.contains(&id) && stored.get(id) == Some(&Value::Bool(true))
}

/// `providerAvailable(name)`: remote client mode serves the PC's providers; otherwise a
/// gated provider answers to its stored Developer option.
pub fn provider_available(name: &str, client_mode: bool, stored_developer: &Value) -> bool {
    client_mode || developer_option_for_provider(name).is_none_or(|id| developer_option_enabled(id, stored_developer))
}

/// `providerUnavailableError(name)`'s message.
pub fn provider_unavailable_message(name: &str) -> String {
    format!("Provider \"{name}\" is disabled: its Developer option was switched off before the request was sent.")
}

// -- hydration ---------------------------------------------------------------------------

/// The facts row hydration reads from the model capabilities, the effort ladder, the effort
/// configuration and the registry.
pub trait HydrationFacts {
    fn fast_capable(&self, provider: &str, row: &Value) -> bool;
    fn ultrafast_capable(&self, provider: &str, row: &Value) -> bool;
    fn effort_items(&self, provider: &str, row: &Value) -> Value;
    /// `Boolean(effortConfigurationMode(provider, model, {...providerConfig, modelParameters}))`.
    fn effort_configuration_mode(&self, provider: &str, model: &str, opts: &Value) -> bool;
    fn custom_auto_effort_capable(&self, provider: &str, protocol: Option<&Value>, row: &Value) -> bool;
    /// `getProvider(provider)?.config`.
    fn provider_config(&self, provider: &str) -> Obj;
}

pub fn daybreak_option() -> Value {
    json!({ "id": "daybreak", "label": "Daybreak Blue", "kind": "boolean",
        "options": [{ "value": "off", "label": "Off" }, { "value": "on", "label": "On" }] })
}

pub fn openrouter_sort_option() -> Value {
    json!({ "id": "providerSort", "label": "Routing", "kind": "enum", "options": [
        { "value": "auto", "label": "Auto" }, { "value": "price", "label": "Price first" },
        { "value": "throughput", "label": "Speed first" }, { "value": "latency", "label": "Latency first" }] })
}

fn ultrafast_speed_option() -> Value {
    json!({ "id": "serviceTier", "label": "Speed", "kind": "enum",
        "options": [{ "value": "priority", "label": "Fast" }, { "value": "ultrafast", "label": "Ultrafast" }] })
}

fn daybreak_blue_supported(row: &Value) -> bool {
    row.get("accessPrograms").and_then(Value::as_array).is_some_and(|a| a.iter().any(|p| p == "daybreak_blue"))
}

/// `hydrateProviderModelRow(cfg, row)`.
pub fn hydrate_provider_model_row(cfg: &Obj, row: &Value, facts: &dyn HydrationFacts) -> Value {
    let provider = text(row.get("provider"));
    let provider_raw = row.get("provider").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| provider.clone());
    let id = row.get("id").map(value_to_string).unwrap_or_default();
    let saved = model_settings_for(cfg, &provider_raw, &id);
    let alias = match saved.get("alias") {
        Some(Value::String(s)) => js_trim(s).to_owned(),
        _ => String::new(),
    };
    let fast_capable = facts.fast_capable(&provider_raw, row);
    let existing: Vec<Value> = row.get("modelParameterOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut added = Vec::new();
    if provider_raw == "openai-oauth" && daybreak_blue_supported(row) {
        added.push(daybreak_option());
    }
    if fast_capable && facts.ultrafast_capable(&provider_raw, row) {
        added.push(ultrafast_speed_option());
    }
    if provider_raw == "openrouter" {
        added.push(openrouter_sort_option());
    }
    let parameter_options: Option<Value> = if added.is_empty() {
        row.get("modelParameterOptions").cloned()
    } else {
        let mut all: Vec<Value> = existing
            .into_iter()
            .filter(|o| !added.iter().any(|a| a.get("id") == o.get("id") && o.get("id").is_some()))
            .collect();
        all.extend(added);
        Some(Value::Array(all))
    };
    let is_custom = provider_raw.starts_with("custom-");
    let provider_config = cfg.get("providers").and_then(|p| p.get(&provider_raw));
    let custom_name = if is_custom {
        let name = provider_config.and_then(|c| c.get("name"));
        if truthy(name) { js_trim(&value_to_string(name.expect("truthy"))).to_owned() } else { String::new() }
    } else {
        String::new()
    };
    let mut out = row.as_object().cloned().unwrap_or_default();
    if is_custom {
        out.shift_remove("providerName");
    }
    if !custom_name.is_empty() {
        out.insert("providerName".into(), Value::String(custom_name));
    }
    if !alias.is_empty() {
        out.insert("display".into(), Value::String(alias.clone()));
        out.insert("displayAlias".into(), Value::String(alias));
    }
    if let Some(options) = parameter_options.filter(|o| truthy(Some(o))) {
        out.insert("modelParameterOptions".into(), options);
    }
    out.insert("effortOptions".into(), facts.effort_items(&provider_raw, row));
    out.insert("fastCapable".into(), Value::Bool(fast_capable));
    let has_fast = saved.contains_key("fast");
    out.insert(
        "fastPreferred".into(),
        Value::Bool(if has_fast {
            saved.get("fast") == Some(&Value::Bool(true))
        } else {
            row.get("defaultFast") == Some(&Value::Bool(true)) || fast_preference_for(cfg, &provider_raw, &id)
        }),
    );
    let mut opts = facts.provider_config(&provider_raw);
    opts.insert(
        "modelParameters".into(),
        if truthy(saved.get("modelParameters")) { saved["modelParameters"].clone() } else { json!({}) },
    );
    let auto = facts.effort_configuration_mode(&provider_raw, &id, &Value::Object(opts))
        || facts.custom_auto_effort_capable(&provider_raw, provider_config.and_then(|c| c.get("protocol")), row);
    out.insert("autoEffortCapable".into(), Value::Bool(auto));
    out.insert("savedEffort".into(), or_null(saved.get("effort")));
    if has_fast {
        out.insert("savedFast".into(), Value::Bool(saved.get("fast") == Some(&Value::Bool(true))));
    }
    if saved.contains_key("autoEffort") {
        out.insert("savedAutoEffort".into(), Value::Bool(saved.get("autoEffort") != Some(&Value::Bool(false))));
    }
    out.insert(
        "savedModelParameters".into(),
        if truthy(saved.get("modelParameters")) { saved["modelParameters"].clone() } else { json!({}) },
    );
    for (key, source) in [("savedContextPercent", "contextPercent"), ("savedContextTokens", "contextTokens")] {
        let n = saved.get(source).map_or(f64::NAN, to_number);
        if n.is_finite() && n != 0.0 {
            out.insert(key.into(), jnum(n));
        }
    }
    if let Some(Value::Bool(h)) = saved.get("hidden") {
        out.insert("savedHidden".into(), Value::Bool(*h));
    }
    if saved.get("favorite") == Some(&Value::Bool(true)) {
        out.insert("favorite".into(), Value::Bool(true));
    }
    Value::Object(out)
}

/// `withCatalogState(models, partial)`: rows of a partial answer say so.
pub fn with_catalog_state(models: Vec<Value>, partial: Option<(&[String], f64)>) -> Vec<Value> {
    let Some((missing, retry_at)) = partial else { return models };
    models
        .into_iter()
        .map(|row| {
            let mut row = row.as_object().cloned().unwrap_or_default();
            row.insert("catalogPartial".into(), Value::Bool(true));
            row.insert("catalogMissing".into(), json!(missing));
            row.insert("catalogRetryAt".into(), jnum(retry_at));
            Value::Object(row)
        })
        .collect()
}

#[cfg(test)]
#[path = "admin_models_tests.rs"]
mod tests;
