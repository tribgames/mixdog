//! The gateway status the terminal footer is built from, and the limit segments it prints
//! (`vendor/statusline/bin/statusline-route.mjs`): `loadGatewayStatus` (the route a session shows: its own
//! stored route, the config's gateway route or the one inherited from Claude Code, with the context window
//! of the model and the cached provider quota), `compactBoundaryForStatus`, `cachedQuotaWindowsFallback` and
//! `formatGatewayLimitSegments`. The files are read by the caller and handed in parsed.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::math;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::gateway_routes::clean_bool;
use super::gateway_routes::normalize_client_host_pid;
use super::gateway_routes::read_latest_host_route;
use super::gateway_routes::read_session_route;
use super::gateway_usage::event;
use super::gateway_usage::event::truthy;
use super::statusline_claude::CLAUDE_CURRENT_MODE;
use super::statusline_claude::ClaudeRoute;
use super::statusline_claude::is_mixdog_model_selection;
use super::statusline_claude::num;
use super::statusline_claude::strip_claude_context_suffix;

/// What the status reads of the model catalog, the cached model rosters and Claude Code.
pub trait StatusWorld {
    /// `getModelMetadataSync(model, provider)`.
    fn catalog_meta(&self, model: &str, provider: &str) -> Option<Map<String, Value>>;
    /// `loadCachedModel(provider, model)`: the row of the provider's cached model file (`<provider>-models.json`).
    fn cached_model(&self, provider: &str, model: &str) -> Option<Value>;
    /// `readClaudeCodeCurrentRoute()`.
    fn inherited_route(&self) -> ClaudeRoute;
}

/// `loadGatewayStatus`'s options and the files it reads.
pub struct StatusInput<'a> {
    /// `mixdog-config.json` of the data dir.
    pub config: Option<&'a Value>,
    /// The config dir's `settings.json`.
    pub settings: Option<&'a Value>,
    /// `gateway-session-routes.json`.
    pub routes: &'a Value,
    /// `gateway-oauth-usage-cache.json`.
    pub quota_cache: Option<&'a Value>,
    /// `options.sessionId`.
    pub session_id: &'a str,
    /// `options.clientHostPid`.
    pub client_host_pid: Option<&'a Value>,
    /// `options.currentRoute`.
    pub current_route: Option<&'a Value>,
    /// `options.activeContextTokens`.
    pub active_context_tokens: Option<f64>,
    /// When this process started (epoch ms): a cached quota older than it is a previous launch's.
    pub process_started_at_ms: f64,
}

fn clean(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

/// The first truthy of the values, cleaned (`cleanString(a || b || ...)`).
fn clean_first(values: &[Option<&Value>]) -> String {
    clean(values.iter().copied().flatten().find(|value| truthy(Some(value))))
}

/// `cleanString(a) || cleanString(b) || ...`.
fn first_clean(values: &[Option<&Value>]) -> String {
    values.iter().map(|value| clean(*value)).find(|text| !text.is_empty()).unwrap_or_default()
}

fn nullish<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().flatten().find(|value| !value.is_null())
}

fn positive(values: &[Option<&Value>]) -> Option<f64> {
    values.iter().find_map(|value| num(*value).filter(|n| *n > 0.0))
}

/// `money(value)`.
fn money(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    if value == 0.0 {
        return "$0".into();
    }
    let digits = if value >= 10.0 {
        0
    } else if value >= 1.0 {
        2
    } else if value >= 0.01 {
        3
    } else {
        4
    };
    format!("${}", math::to_fixed(value, digits))
}

/// `compactNumber(value)`.
fn compact_number(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if n.abs() >= 1_000_000.0 {
        return format!("{}M", math::to_fixed(n / 1_000_000.0, usize::from(n < 10_000_000.0)));
    }
    if n.abs() >= 1_000.0 {
        return format!("{}K", math::to_fixed(n / 1_000.0, usize::from(n < 10_000.0)));
    }
    if n.abs() >= 10.0 {
        return math::to_fixed(n, 0);
    }
    if n.abs() >= 1.0 { math::to_fixed(n, 1) } else { math::to_fixed(n, 2) }
}

/// `pctOf(value, total)`.
fn pct_of(value: Option<f64>, total: Option<f64>) -> Option<f64> {
    let (v, t) = (value?, total?);
    (v.is_finite() && t.is_finite() && t > 0.0).then(|| math::round(v * 10_000.0 / t) / 100.0)
}

/// `boundedPercent(value, fallback)`.
fn bounded_percent(value: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    let n = mixdog_js::to_number_of(value);
    if n.is_finite() && n > 0.0 && n <= 100.0 { Some(n) } else { fallback }
}

/// `slugSegment(value)`.
fn slug_segment(value: Option<&Value>) -> String {
    let lower = js_to_lowercase(&clean(value));
    let mut out = String::new();
    let mut dashing = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            dashing = false;
        } else if !dashing {
            out.push('-');
            dashing = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// A preset as a model target (`resolveConfiguredModelTarget`).
struct Target {
    provider: Value,
    model: Value,
    preset_id: Option<Value>,
    preset_name: Option<Value>,
    effort: Option<Value>,
    fast: bool,
}

impl Target {
    /// `targetAliasId(target)`: `mixdog/<slug>`, the name the preset is selected by.
    fn alias_id(&self) -> String {
        let slug = |value: Option<&Value>| slug_segment(value);
        let mut base = slug(self.preset_id.as_ref());
        if base.is_empty() {
            base = slug(self.preset_name.as_ref());
        }
        if base.is_empty() && !slug(Some(&self.provider)).is_empty() && !slug(Some(&self.model)).is_empty() {
            let mut parts = vec![slug(Some(&self.provider)), slug(Some(&self.model)), slug(self.effort.as_ref())];
            if self.fast {
                parts.push("fast".into());
            }
            base = parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
        }
        if base.is_empty() { String::new() } else { format!("mixdog/{base}") }
    }
}

/// `resolveConfiguredModelTarget(cfg, rawModel)`: the preset a requested model names, by its alias or its model id.
fn resolve_configured_model_target(config: Option<&Value>, raw_model: &Value) -> Option<Target> {
    let stripped = strip_claude_context_suffix(raw_model);
    if stripped.is_empty() {
        return None;
    }
    let lower = js_to_lowercase(&stripped);
    let agent = config.and_then(|config| config.get("agent")).filter(|agent| agent.is_object());
    let providers = agent.and_then(|agent| agent.get("providers")).filter(|providers| providers.is_object());
    for preset in mixdog_core_config::workflow::with_default_presets(agent.and_then(|agent| agent.get("presets"))) {
        let (Some(provider), Some(model)) = (preset.get("provider").filter(|v| truthy(Some(v))), preset.get("model").filter(|v| truthy(Some(v)))) else { continue };
        let entry = providers.and_then(|providers| providers.get(value_to_string(provider)));
        if entry.is_some_and(|entry| entry.is_object() && entry.get("enabled") == Some(&Value::Bool(false))) {
            continue;
        }
        let kept = |key: &str| preset.get(key).filter(|v| truthy(Some(v))).cloned();
        let target = Target { provider: provider.clone(), model: model.clone(), preset_id: kept("id"), preset_name: kept("name"), effort: kept("effort"), fast: preset.get("fast") == Some(&Value::Bool(true)) };
        let alias = js_to_lowercase(&target.alias_id());
        if (!alias.is_empty() && lower == alias) || lower == js_to_lowercase(&value_to_string(&target.model)) {
            return Some(target);
        }
    }
    None
}

/// `routeContextMeta(provider, info, inherited)`: the context window of the route and its compaction limit.
fn route_context_meta(info: &Value, inherited: &Value) -> Map<String, Value> {
    let (i, m) = (|key: &str| inherited.get(key), |key: &str| info.get(key));
    let raw_context_window = positive(&[
        i("rawContextWindow"),
        i("raw_context_window"),
        m("context_window"),
        m("max_context_window"),
        m("contextWindow"),
        m("maxContextWindow"),
        m("max_input_tokens"),
    ]);
    // The gateway reports the full model boundary: the trigger headroom is a compaction concern and does not shrink it.
    let percent_source = nullish(&[i("effectiveContextWindowPercent"), i("effective_context_window_percent"), m("effectiveContextWindowPercent"), m("effective_context_window_percent")]);
    let effective_percent = bounded_percent(percent_source, Some(100.0));
    let derived = raw_context_window.map(|raw| {
        let percent = effective_percent.filter(|p| *p > 0.0 && *p <= 100.0).unwrap_or(100.0);
        math::max(1.0, (raw * percent / 100.0).floor())
    });
    let explicit = positive(&[i("contextWindow"), i("displayContextWindow"), i("compactBoundaryTokens"), i("compact_boundary_tokens")]);
    let context_window = explicit.or(derived);
    let limit_source = nullish(&[i("autoCompactTokenLimit"), i("auto_compact_token_limit"), m("autoCompactTokenLimit"), m("auto_compact_token_limit")]);
    let explicit_limit = num(limit_source);
    // An explicit limit is a trigger only strictly below the boundary: a value at or above it is a derived
    // full-window artifact. A limit is never derived from the window.
    let boundary = context_window.or(raw_context_window);
    let auto_compact_token_limit = explicit_limit.filter(|limit| *limit > 0.0).and_then(|limit| match boundary {
        Some(boundary) => (limit < boundary).then_some(limit),
        None => Some(limit),
    });
    let number = |value: Option<f64>| value.map_or(Value::Null, json_number);
    let mut out = Map::new();
    out.insert("contextWindow".into(), number(context_window));
    out.insert("rawContextWindow".into(), number(raw_context_window));
    out.insert("effectiveContextWindowPercent".into(), number(effective_percent));
    out.insert("autoCompactTokenLimit".into(), number(auto_compact_token_limit));
    out
}

/// `compactBoundaryForStatus(routeInfo, compact)`: the denominator of the context percentage, when there is one.
pub fn compact_boundary_for_status(route: &Value, compact: &Value) -> Option<f64> {
    let n = event::compact_boundary_denominator(route, compact);
    (n > 0.0).then_some(n)
}

/// `{ ...a, ...b }`.
fn spread(a: Option<&Value>, b: Option<&Value>) -> Map<String, Value> {
    let mut out = a.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(b) = b.and_then(Value::as_object) {
        out.extend(b.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    out
}

/// `sessionRouteFor(gateway, sessionId, clientHostPid)`: the route the session shows and whether it is the session's
/// own: its stored route (its host's first, then the legacy slot), else the newest route of the same host.
fn session_route_for(input: &StatusInput<'_>, gateway: Map<String, Value>) -> (Map<String, Value>, bool) {
    let sid = js_trim(input.session_id);
    if sid.is_empty() {
        return (gateway, false);
    }
    let pid = normalize_client_host_pid(input.client_host_pid);
    let route = read_session_route(input.routes, sid, pid, true).or_else(|| read_latest_host_route(input.routes, pid, Some(sid)));
    let Some(route) = route else { return (gateway, false) };
    let route_value = Value::Object(route);
    let provider = clean_first(&[route_value.get("defaultProvider"), route_value.get("provider")]);
    let model = clean_first(&[route_value.get("defaultModel"), route_value.get("model")]);
    if provider.is_empty() || model.is_empty() {
        return (gateway, false);
    }
    let mut merged = spread(Some(&Value::Object(gateway)), Some(&route_value));
    merged.insert("defaultProvider".into(), json!(provider));
    merged.insert("defaultModel".into(), json!(model));
    (merged, true)
}

/// `routeOwnsModelDisplay(gateway, sessionScoped)`: the route's own `modelDisplay` stands.
fn route_owns_model_display(gateway: &Map<String, Value>, session_scoped: bool) -> bool {
    clean(gateway.get("mode")) == CLAUDE_CURRENT_MODE || (!session_scoped && !clean(gateway.get("modelDisplay")).is_empty())
}

/// `displayForModel(provider, model, info)`.
fn display_for_model(provider: &str, model: &str, info: &Value) -> String {
    let named = clean_first(&[info.get("display"), info.get("displayName"), info.get("name")]);
    if !named.is_empty() {
        return named;
    }
    let lower = js_to_lowercase(model);
    if provider == "anthropic-oauth"
        && let Some(rest) = lower.strip_prefix("claude-")
    {
        let families = ["opus", "sonnet", "haiku", "fable", "mythos"];
        if let Some(family) = families.into_iter().find(|family| rest.strip_prefix(family).is_some_and(|tail| tail.starts_with('-'))) {
            let tail = &rest[family.len() + 1..];
            let mut parts = tail.split('-');
            let first = parts.next().unwrap_or_default();
            let leading = |part: &str| part.bytes().take_while(u8::is_ascii_digit).count();
            let major = &first[..leading(first)];
            if !major.is_empty() {
                let minor = if leading(first) == first.len() { parts.next().map(|part| &part[..leading(part)]).filter(|minor| !minor.is_empty()) } else { None };
                let mut name = family.to_owned();
                name[..1].make_ascii_uppercase();
                return format!("{name} {major}{}", minor.map(|minor| format!(".{minor}")).unwrap_or_default());
            }
        }
    }
    let raw = js_trim(model);
    for (prefix, label) in [("gpt", "GPT"), ("grok", "Grok"), ("glm", "GLM")] {
        let lower_raw = js_to_lowercase(raw);
        if let Some(rest) = lower_raw.strip_prefix(prefix).and_then(|rest| rest.strip_prefix(['-', '_']))
            && !rest.is_empty()
        {
            // The original casing of the rest, its runs of `-` and `_` as spaces.
            let rest = raw.get(prefix.len() + 1..).unwrap_or(rest);
            return format!("{label} {}", collapse_separators(rest));
        }
    }
    model.to_owned()
}

/// `.replace(/[-_]+/g, ' ')`.
fn collapse_separators(text: &str) -> String {
    let mut out = String::new();
    let mut separating = false;
    for c in text.chars() {
        if c == '-' || c == '_' {
            if !separating {
                out.push(' ');
            }
            separating = true;
        } else {
            out.push(c);
            separating = false;
        }
    }
    out
}

const MODEL_SUFFIXES: [&str; 7] = ["XHIGH", "HIGH", "MEDIUM", "MID", "LOW", "MAX", "FAST"];

/// `stripStatuslineModelSuffixes(label)`: the label without trailing effort and speed words.
fn strip_statusline_model_suffixes(label: &str) -> String {
    let text = js_trim(label);
    if text.is_empty() {
        return String::new();
    }
    let mut parts: Vec<&str> = mixdog_js::js_words(text).collect();
    while parts.len() > 1 && parts.last().is_some_and(|last| MODEL_SUFFIXES.contains(&last.to_uppercase().as_str())) {
        parts.pop();
    }
    parts.join(" ")
}

/// `statuslineDisplayForModel(provider, model, info, preferred)`.
fn statusline_display_for_model(provider: &str, model: &str, info: &Value, preferred: &str) -> String {
    let stripped = strip_statusline_model_suffixes(preferred);
    let from_model = display_for_model(provider, model, info);
    let norm = |value: &str| {
        let lower = js_to_lowercase(js_trim(value));
        let mut out = String::new();
        let mut spacing = false;
        for c in lower.chars() {
            if mixdog_js::is_js_space(c) || c == '_' {
                if !spacing {
                    out.push('-');
                }
                spacing = true;
            } else {
                out.push(c);
                spacing = false;
            }
        }
        out
    };
    if !stripped.is_empty() {
        if norm(&stripped) == norm(model) && stripped.contains(['-', '_']) {
            return if from_model.is_empty() { stripped } else { from_model };
        }
        return stripped;
    }
    from_model
}

/// `cachedQuotaWindowsFallback(provider, model)`: OAuth quota belongs to the account, not the model: the route's own
/// cache entry, else the provider's, else the freshest entry of the same provider, so a model switch keeps showing
/// the quota until the next live fetch. A snapshot older than this process is a previous launch's and is not shown.
/// Returns the windows with the entry's `cachedAt`, for a caller that never lets an older snapshot displace a newer.
pub fn cached_quota_windows_fallback(cache: Option<&Value>, provider: &str, model: &str, process_started_at_ms: f64) -> (Vec<Value>, f64) {
    let none = (Vec::new(), 0.0);
    if provider.is_empty() || model.is_empty() {
        return none;
    }
    let Some(routes) = cache.and_then(|cache| cache.get("routes")).and_then(Value::as_object) else { return none };
    let provider_key = js_to_lowercase(provider);
    let route_key = format!("{provider_key}{model}");
    let truthy_entry = |key: &str| routes.get(key).filter(|entry| truthy(Some(entry)));
    let entry = truthy_entry(&route_key).or_else(|| truthy_entry(&provider_key)).or_else(|| {
        let mut same: Vec<(&String, &Value)> = routes.iter().filter(|(key, value)| key.starts_with(&provider_key) && value.get("quotaWindows").is_some_and(Value::is_array)).collect();
        mixdog_js::js_sort_by(&mut same, |a, b| {
            let at = |entry: &Value| {
                let n = to_number(entry.get("cachedAt").unwrap_or(&Value::Null));
                if n.is_nan() || n == 0.0 { 0.0 } else { n }
            };
            at(b.1) - at(a.1)
        });
        same.first().map(|(_, value)| *value)
    });
    let Some(windows) = entry.and_then(|entry| entry.get("quotaWindows")).and_then(Value::as_array) else { return none };
    let cached_at = to_number(entry.and_then(|entry| entry.get("cachedAt")).unwrap_or(&Value::Null));
    if !cached_at.is_finite() || cached_at < process_started_at_ms {
        return none;
    }
    (windows.clone(), cached_at)
}

/// The route the footer shows, from the config, the session's stored route and Claude Code. `None` when the gateway
/// module is off, no route resolves, or a requested `mixdog/` model names no preset.
fn configured_gateway_status(world: &dyn StatusWorld, input: &StatusInput<'_>) -> Option<Map<String, Value>> {
    let config = input.config;
    let gateway_base = config.and_then(|config| config.get("gateway")).filter(|gateway| gateway.is_object());
    let (mut gateway, session_scoped) = session_route_for(input, spread(gateway_base, None));
    let current = input.current_route.filter(|route| route.is_object());
    let current_provider = clean_first(&[current.and_then(|route| route.get("provider")), current.and_then(|route| route.get("defaultProvider"))]);
    let current_model = clean_first(&[current.and_then(|route| route.get("model")), current.and_then(|route| route.get("defaultModel"))]);
    if (clean(gateway.get("defaultProvider")).is_empty() || clean(gateway.get("defaultModel")).is_empty()) && !current_provider.is_empty() && !current_model.is_empty() {
        let mode = Some(clean(gateway.get("mode"))).filter(|mode| !mode.is_empty()).unwrap_or_else(|| "fixed".into());
        gateway.insert("mode".into(), json!(mode));
        gateway.insert("defaultProvider".into(), json!(current_provider));
        gateway.insert("defaultModel".into(), json!(current_model));
        let effort = clean(nullish(&[current.and_then(|route| route.get("effort")), current.and_then(|route| route.get("displayEffort"))]));
        if !effort.is_empty() {
            gateway.insert("effort".into(), json!(effort));
        }
        if let Some(fast) = clean_bool(current.and_then(|route| route.get("fast"))) {
            gateway.insert("fast".into(), json!(fast));
        }
        for key in ["contextWindow", "rawContextWindow"] {
            if let Some(window) = num(current.and_then(|route| route.get(key))).filter(|window| *window != 0.0) {
                gateway.insert(key.into(), json_number(window));
            }
        }
    }
    let modules_gateway = config.and_then(|config| config.get("modules")).filter(|modules| modules.is_object()).and_then(|modules| modules.get("gateway"));
    if modules_gateway.is_some_and(|module| truthy(Some(module)) && module.get("enabled") == Some(&Value::Bool(false))) {
        return None;
    }
    let inherit = clean(gateway.get("mode")) == CLAUDE_CURRENT_MODE;
    let inherited = inherit.then(|| world.inherited_route());
    let inherited_json = inherited.as_ref().map(ClaudeRoute::json);
    let current_requested = {
        let requested = first_clean(&[current.and_then(|route| route.get("requestedModel")), current.and_then(|route| route.get("model"))]);
        if is_mixdog_model_selection(&Value::String(requested.clone())) { requested } else { String::new() }
    };
    let settings_requested = if session_scoped {
        String::new()
    } else {
        let model = clean(input.settings.and_then(|settings| settings.get("model")));
        if is_mixdog_model_selection(&Value::String(model.clone())) { model } else { String::new() }
    };
    let explicit_requested = if current_requested.is_empty() { settings_requested } else { current_requested };
    let mut alias = if explicit_requested.is_empty() { None } else { resolve_configured_model_target(config, &Value::String(explicit_requested.clone())) };
    if !explicit_requested.is_empty() && alias.is_none() {
        return None;
    }
    let inherited_provider = inherited.as_ref().and_then(|route| route.provider.clone()).unwrap_or_default();
    let inherited_model = inherited.as_ref().and_then(|route| route.model.clone()).unwrap_or_default();
    let mut provider = if inherit && !inherited_provider.is_empty() { inherited_provider } else { clean(gateway.get("defaultProvider")) };
    let mut model = if inherit && !inherited_model.is_empty() { inherited_model } else { clean(gateway.get("defaultModel")) };
    if alias.is_none()
        && inherit
        && inherited.as_ref().is_some_and(|route| route.provider.as_deref().is_none_or(|p| js_trim(p).is_empty()))
        && let Some(requested) = inherited.as_ref().and_then(|route| route.requested_model.clone()).filter(|requested| !js_trim(requested).is_empty())
    {
        alias = resolve_configured_model_target(config, &Value::String(requested));
    }
    if let Some(target) = &alias {
        provider = value_to_string(&target.provider);
        model = value_to_string(&target.model);
    }
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let agent_presets = config.and_then(|config| config.get("agent")).and_then(|agent| agent.get("presets"));
    let presets = mixdog_core_config::workflow::with_default_presets(agent_presets);
    let same_model = |preset: &&Value| preset.get("provider").and_then(Value::as_str) == Some(provider.as_str()) && preset.get("model").and_then(Value::as_str) == Some(model.as_str());
    let (preset_id, preset_name) = (gateway.get("presetId"), gateway.get("presetName"));
    let named = presets.iter().filter(same_model).find(|preset| {
        (preset_id.is_some_and(|id| truthy(Some(id))) && preset.get("id") == preset_id)
            || (preset_name.is_some_and(|name| truthy(Some(name))) && (preset.get("name") == preset_name || preset.get("id") == preset_name))
    });
    let preset = named.or_else(|| {
        let mut matching = presets.iter().filter(same_model);
        let first = matching.next();
        if matching.next().is_none() { first } else { None }
    });
    let mut info = world.cached_model(&provider, &model).filter(|info| info.is_object()).unwrap_or_else(|| json!({}));
    // The catalog is authoritative for the context window: a cached model file can hold a stale one. A live window
    // the provider API reported on the cached row still outranks the catalog.
    let catalog = world.catalog_meta(&model, &provider).map(Value::Object);
    let catalog_window = num(nullish(&[
        catalog.as_ref().and_then(|c| c.get("contextWindow")),
        catalog.as_ref().and_then(|c| c.get("maxContextWindow")),
        catalog.as_ref().and_then(|c| c.get("context_window")),
        catalog.as_ref().and_then(|c| c.get("max_context_window")),
    ]))
    .unwrap_or(0.0);
    let api_window = num(nullish(&[info.get("context_window"), info.get("max_context_window")])).unwrap_or(0.0);
    let cached_window = num(nullish(&[info.get("contextWindow"), info.get("maxContextWindow")])).unwrap_or(0.0);
    if api_window == 0.0 && catalog_window > 0.0 && cached_window != catalog_window
        && let Some(object) = info.as_object_mut()
    {
        object.insert("contextWindow".into(), json_number(catalog_window));
        object.insert("maxContextWindow".into(), json_number(catalog_window));
    }
    let g = |key: &str| gateway.get(key);
    let p = |key: &str| preset.and_then(|preset| preset.get(key));
    let inherited_effort = inherited_json.as_ref().and_then(|route| route.get("effort").cloned());
    let effort = if let Some(target) = &alias {
        clean_first(&[target.effort.as_ref(), g("effort"), g("displayEffort"), p("effort")])
    } else if inherit {
        clean_first(&[inherited_effort.as_ref(), g("effort"), g("displayEffort"), p("effort")])
    } else {
        clean_first(&[g("effort"), g("displayEffort"), p("effort")])
    };
    let inherited_fast = inherited.as_ref().and_then(|route| route.fast).map(Value::Bool);
    let alias_fast = alias.as_ref().map(|target| Value::Bool(target.fast));
    let fast_chain: Vec<Option<&Value>> = if alias.is_some() {
        vec![alias_fast.as_ref(), g("fast"), p("fast")]
    } else if inherit {
        vec![inherited_fast.as_ref(), g("fast"), p("fast")]
    } else {
        vec![g("fast"), p("fast")]
    };
    let fast = fast_chain.into_iter().find_map(clean_bool).unwrap_or(false);
    let route_matches_current = current_provider == provider && current_model == model;
    let seed = spread(inherited_json.as_ref(), if route_matches_current { input.current_route } else { None });
    let seed_value = if alias.is_some() { Value::Object(Map::new()) } else { Value::Object(seed) };
    let context_meta = route_context_meta(&info, &seed_value);
    let preferred = {
        let named = alias.as_ref().map(|target| clean(target.preset_name.as_ref())).unwrap_or_default();
        let from_route = clean(inherited_json.as_ref().and_then(|route| route.get("modelDisplay")));
        if !named.is_empty() {
            named
        } else if !from_route.is_empty() {
            from_route
        } else if route_owns_model_display(&gateway, session_scoped) {
            clean(gateway.get("modelDisplay"))
        } else {
            String::new()
        }
    };
    let mut out = Map::new();
    out.insert("mode".into(), json!(if inherit { CLAUDE_CURRENT_MODE } else { "" }));
    out.insert("provider".into(), json!(provider));
    out.insert("model".into(), json!(model));
    out.insert("providerKind".into(), json!(event::provider_kind(Some(&json!(provider)))));
    out.insert("modelDisplay".into(), json!(statusline_display_for_model(&provider, &model, &info, &preferred)));
    out.insert("effort".into(), json!(effort));
    out.insert("fast".into(), json!(fast));
    out.extend(context_meta);
    let output_tokens = num(nullish(&[info.get("outputTokens"), info.get("maxOutputTokens"), info.get("max_output_tokens")]));
    out.insert("outputTokens".into(), output_tokens.map_or(Value::Null, json_number));
    Some(out)
}

/// `loadGatewayStatus(options)`: the route the footer shows with the cached quota windows and the context
/// percentage of the active context; `None` when no route resolves.
pub fn load_gateway_status(world: &dyn StatusWorld, input: &StatusInput<'_>) -> Option<Value> {
    let mut status = configured_gateway_status(world, input)?;
    let provider = clean(status.get("provider"));
    let model = clean(status.get("model"));
    let (windows, cached_at) = cached_quota_windows_fallback(input.quota_cache, &provider, &model, input.process_started_at_ms);
    let boundary = compact_boundary_for_status(&Value::Object(status.clone()), &Value::Null);
    let used = pct_of(input.active_context_tokens, boundary);
    status.insert("contextUsedPct".into(), used.map_or(Value::Null, json_number));
    status.insert("lastUsage".into(), Value::Null);
    status.insert("quotaWindows".into(), Value::Array(windows));
    // The shared provider-wide cache snapshot is not owned by this instance: `asOf` lets a caller reject an older one.
    status.insert("quotaWindowsAsOf".into(), json_number(if cached_at.is_finite() { cached_at } else { 0.0 }));
    status.insert("quotaWindowsOwned".into(), Value::Bool(false));
    status.insert("balance".into(), Value::Null);
    status.insert("routeSpend".into(), Value::Null);
    Some(Value::Object(status))
}

/// How the segments are laid out and coloured (`fmt` of `formatGatewayLimitSegments`).
pub struct SegmentFormat<'a> {
    pub cols: u32,
    pub dim: &'a str,
    pub reset: &'a str,
    pub green: &'a str,
    pub yellow: &'a str,
    pub red: &'a str,
    pub colour_pct: &'a dyn Fn(i64) -> String,
    pub epoch_ms_to_hhmm: &'a dyn Fn(f64) -> String,
    /// `Date.now()`.
    pub now: f64,
}

/// The length of the text with its ESC-bracket colour codes taken out.
fn visible_length(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut length = 0;
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '\u{1b}' && chars.get(at + 1) == Some(&'[') {
            let digits = chars[at + 2..].iter().take_while(|c| c.is_ascii_digit() || **c == ';').count();
            if chars.get(at + 2 + digits) == Some(&'m') {
                at += 3 + digits;
                continue;
            }
        }
        length += chars[at].len_utf16();
        at += 1;
    }
    length
}

fn pad_left_visible(text: &str, width: usize) -> String {
    let pad = width.saturating_sub(visible_length(text));
    format!("{}{text}", " ".repeat(pad))
}

/// `isLocalEstimateWindow(window)`.
fn is_local_estimate_window(window: &Value) -> bool {
    let source = js_to_lowercase(&clean(window.get("source").filter(|v| truthy(Some(v)))));
    source.is_empty() || source.contains("local") || source.contains("config")
}

/// `formatGatewayLimitSegments(status, fmt)`: what the footer prints for the limits of a status: the quota windows
/// (as many as the width takes), the route spend and the credit balance.
pub fn format_gateway_limit_segments(status: &Value, fmt: &SegmentFormat<'_>) -> Vec<String> {
    if !status.is_object() {
        return Vec::new();
    }
    let (d, r) = (fmt.dim, fmt.reset);
    let mut segments: Vec<String> = Vec::new();
    let lower = |key: &str| js_to_lowercase(&clean(status.get(key).filter(|v| truthy(Some(v)))));
    let kind = lower("providerKind");
    let provider_id = lower("provider");
    let status_source = lower("source");
    let balance_source = js_to_lowercase(&clean(status.get("balance").and_then(|b| b.get("source")).filter(|v| truthy(Some(v)))));
    let is_openai_oauth = (kind == "oauth" || provider_id.contains("oauth"))
        && (provider_id == "openai-oauth" || status_source.contains("openai") || status_source.contains("codex") || balance_source.contains("openai") || balance_source.contains("codex"));
    let is_plain_api = kind == "api";
    let empty = Vec::new();
    let windows: &Vec<Value> = if is_plain_api { &empty } else { status.get("quotaWindows").and_then(Value::as_array).unwrap_or(&empty) };
    let max_windows = if fmt.cols >= 120 { 3 } else if fmt.cols >= 80 { 2 } else { 1 };
    let route_spend = num(status.get("routeSpend").and_then(|spend| spend.get("costUsd")));
    let label = clean(status.get("routeSpend").and_then(|spend| spend.get("label")));
    let route_spend_label = if label.is_empty() { (if fmt.cols >= 120 { "SESS" } else { "S" }).to_owned() } else { label };
    // The percentage and the reset time are right-aligned in their own columns so the separators stop drifting as the
    // values change width. Off below 80 columns, where the narrow layout keeps its own shape.
    let align = fmt.cols >= 80;
    let reset_width = if align { 5 } else { 0 };
    let window_reset_text = |window: &Value| -> String {
        if is_local_estimate_window(window) {
            return String::new();
        }
        let Some(at) = num(window.get("resetAt")).filter(|at| *at != 0.0 && *at > fmt.now) else { return String::new() };
        if at - fmt.now < 24.0 * 60.0 * 60_000.0 {
            return (fmt.epoch_ms_to_hhmm)(at);
        }
        match mixdog_js::time::local_fields(at) {
            Some(t) => format!("{:02}-{:02} {:02}:{:02}", t.month, t.day, t.hour, t.minute),
            None => String::new(),
        }
    };
    let with_reset = |segment: String, window: &Value| {
        let reset = window_reset_text(window);
        if reset.is_empty() { segment } else { format!("{segment} {d}↻ {}{r}", pad_left_visible(&reset, reset_width)) }
    };
    let add_route_spend = |segments: &mut Vec<String>| -> bool {
        match route_spend {
            Some(spend) if spend > 0.0 => {
                segments.push(format!("{d}{}{r} {}", route_spend_label.to_uppercase(), money(spend)));
                true
            }
            _ => false,
        }
    };
    let add_api_balance = |segments: &mut Vec<String>| -> bool {
        if is_openai_oauth {
            return false;
        }
        let remaining = num(status.get("balance").and_then(|balance| balance.get("remainingUsd")));
        if let Some(remaining) = remaining {
            segments.push(format!("{d}Credit{r} {}", money(remaining)));
        }
        remaining.is_some()
    };
    if is_plain_api {
        add_route_spend(&mut segments);
        if add_api_balance(&mut segments) || !segments.is_empty() {
            return segments;
        }
    }
    for window in windows.iter().take(max_windows) {
        let label = window.get("label").filter(|v| truthy(Some(v))).map_or_else(|| "USE".to_owned(), value_to_string).to_uppercase();
        let pct = num(window.get("usedPct"));
        let field = |key: &str| if is_openai_oauth { None } else { num(window.get(key)) };
        let (remaining, limit, used) = (field("remainingUsd"), field("limitUsd"), field("usedUsd"));
        let (remaining_credits, limit_credits, used_credits) = (field("remainingCredits"), field("limitCredits"), field("usedCredits"));
        let estimated = is_local_estimate_window(window);
        let est = if estimated { "est " } else { "" };
        let credit_color = if estimated { fmt.yellow } else if pct.is_some_and(|p| p >= 95.0) { fmt.red } else if pct.is_some_and(|p| p >= 80.0) { fmt.yellow } else { fmt.green };
        let segment = if let Some(remaining) = remaining {
            let color = if estimated { fmt.yellow } else if remaining <= 1.0 { fmt.red } else if remaining <= 5.0 { fmt.yellow } else { fmt.green };
            format!("{d}{label}{r} {color}{est}{}{r}", money(remaining))
        } else if let (Some(used), Some(limit)) = (used, limit) {
            format!("{d}{label}{r} {est}{}/{}", money(used), money(limit))
        } else if let (Some(left), Some(limit)) = (remaining_credits, limit_credits) {
            format!("{d}{label}{r} {credit_color}{est}{}/{}{r}", compact_number(left), compact_number(limit))
        } else if let Some(left) = remaining_credits {
            format!("{d}{label}{r} {credit_color}{est}{}{r}", compact_number(left))
        } else if let (Some(used), Some(limit)) = (used_credits, limit_credits) {
            format!("{d}{label}{r} {est}{}/{}", compact_number(used), compact_number(limit))
        } else if let Some(pct) = pct {
            let pct_text = (fmt.colour_pct)(math::round(pct) as i64);
            let shown = if align { pad_left_visible(&pct_text, 4) } else { pct_text };
            format!("{d}{label}{r} {est}{shown}")
        } else {
            continue;
        };
        segments.push(with_reset(segment, window));
    }
    add_route_spend(&mut segments);
    if !is_plain_api && fmt.cols >= 80 {
        add_api_balance(&mut segments);
    }
    if !segments.is_empty() {
        return segments;
    }
    let remaining = if is_openai_oauth { None } else { num(status.get("balance").and_then(|balance| balance.get("remainingUsd"))) };
    if let Some(remaining) = remaining {
        segments.push(format!("{d}Credit{r} {}", money(remaining)));
        add_route_spend(&mut segments);
        return segments;
    }
    if add_route_spend(&mut segments) {
        return segments;
    }
    let last_cost = num(status.get("lastUsage").and_then(|usage| usage.get("costUsd")));
    let provider_text = status.get("provider").filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
    if let Some(cost) = last_cost.filter(|cost| *cost > 0.0)
        && !provider_text.contains("oauth")
    {
        segments.push(format!("{d}${r} {}", money(cost)));
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    struct World {
        meta: Option<Map<String, Value>>,
        cached: Option<Value>,
    }

    impl StatusWorld for World {
        fn catalog_meta(&self, _model: &str, _provider: &str) -> Option<Map<String, Value>> {
            self.meta.clone()
        }
        fn cached_model(&self, _provider: &str, _model: &str) -> Option<Value> {
            self.cached.clone()
        }
        fn inherited_route(&self) -> ClaudeRoute {
            ClaudeRoute {
                mode: CLAUDE_CURRENT_MODE.into(),
                provider: Some("anthropic-oauth".into()),
                model: Some("claude-opus-4-8".into()),
                requested_model: Some("opus".into()),
                model_display: Some("Opus 4.8".into()),
                effort: Some("high".into()),
                fast: Some(false),
                context_window: Some(1_000_000.0),
                ..ClaudeRoute::default()
            }
        }
    }

    fn world() -> World {
        World { meta: None, cached: None }
    }

    fn input<'a>(config: Option<&'a Value>, routes: &'a Value) -> StatusInput<'a> {
        StatusInput {
            config,
            settings: None,
            routes,
            quota_cache: None,
            session_id: "",
            client_host_pid: None,
            current_route: None,
            active_context_tokens: None,
            process_started_at_ms: 1000.0,
        }
    }

    #[test]
    fn a_fixed_gateway_route_shows_its_model_window_and_context_percentage() {
        let config = json!({ "gateway": { "mode": "fixed", "defaultProvider": "openai", "defaultModel": "gpt-5-codex", "effort": "high", "fast": "on" } });
        let world = World { meta: Some(serde_json::from_value(json!({ "contextWindow": 400000 })).unwrap()), cached: Some(json!({ "contextWindow": 272000, "outputTokens": 128000 })) };
        let routes = json!({});
        let mut input = input(Some(&config), &routes);
        input.active_context_tokens = Some(100_000.0);
        let status = load_gateway_status(&world, &input).unwrap();
        assert_eq!(
            (status["provider"].clone(), status["providerKind"].clone(), status["modelDisplay"].clone(), status["effort"].clone(), status["fast"].clone()),
            (json!("openai"), json!("api"), json!("GPT 5 codex"), json!("high"), json!(true))
        );
        // The catalog's window wins over the stale cached one.
        assert_eq!((status["contextWindow"].clone(), status["contextUsedPct"].clone(), status["outputTokens"].clone()), (json!(400000), json!(25), json!(128000)));
        assert_eq!((status["quotaWindows"].clone(), status["quotaWindowsAsOf"].clone(), status["quotaWindowsOwned"].clone()), (json!([]), json!(0), json!(false)));
    }

    #[test]
    fn a_session_shows_its_stored_route_over_the_gateway_one() {
        let config = json!({ "gateway": { "mode": "fixed", "defaultProvider": "openai", "defaultModel": "gpt-5" } });
        let routes = json!({ "sessionHosts": { "sess_abcdef01#7": { "mode": "fixed", "defaultProvider": "xai", "defaultModel": "grok-4", "modelDisplay": "Grok Fast MID", "sessionId": "sess_abcdef01", "clientHostPid": 7, "updatedAt": 1 } } });
        let mut input = input(Some(&config), &routes);
        input.session_id = "sess_abcdef01";
        let pid = json!(7);
        input.client_host_pid = Some(&pid);
        let status = load_gateway_status(&world(), &input).unwrap();
        assert_eq!((status["provider"].clone(), status["model"].clone(), status["modelDisplay"].clone()), (json!("xai"), json!("grok-4"), json!("Grok 4")));
        // Another session of the same host takes the host's newest route.
        input.session_id = "sess_other001";
        let status = load_gateway_status(&world(), &input).unwrap();
        assert_eq!(status["model"], "grok-4");
        // With no session the gateway route stands.
        input.session_id = "";
        assert_eq!(load_gateway_status(&world(), &input).unwrap()["model"], "gpt-5");
    }

    #[test]
    fn a_claude_current_gateway_inherits_the_model_effort_and_window_of_claude_code() {
        let config = json!({ "gateway": { "mode": "claude-current" } });
        let routes = json!({});
        let status = load_gateway_status(&world(), &input(Some(&config), &routes)).unwrap();
        assert_eq!(
            (status["mode"].clone(), status["provider"].clone(), status["model"].clone(), status["modelDisplay"].clone(), status["effort"].clone(), status["contextWindow"].clone()),
            (json!("claude-current"), json!("anthropic-oauth"), json!("claude-opus-4-8"), json!("Opus 4.8"), json!("high"), json!(1000000))
        );
    }

    #[test]
    fn the_current_route_stands_in_when_the_config_has_none_and_a_disabled_gateway_shows_nothing() {
        let routes = json!({});
        let mut with_current = input(None, &routes);
        let current = json!({ "provider": "openai", "model": "gpt-5", "effort": "low", "fast": true, "contextWindow": 200000 });
        with_current.current_route = Some(&current);
        let status = load_gateway_status(&world(), &with_current).unwrap();
        assert_eq!((status["model"].clone(), status["effort"].clone(), status["contextWindow"].clone()), (json!("gpt-5"), json!("low"), json!(200000)));
        let config = json!({ "modules": { "gateway": { "enabled": false } } });
        let mut off = input(Some(&config), &routes);
        off.current_route = Some(&current);
        assert_eq!(load_gateway_status(&world(), &off), None);
        assert_eq!(load_gateway_status(&world(), &input(None, &routes)), None);
    }

    #[test]
    fn a_requested_mixdog_model_resolves_to_its_preset_or_shows_nothing() {
        let config = json!({ "agent": { "presets": [{ "id": "mine", "name": "Mine", "provider": "openai", "model": "gpt-5", "effort": "low", "fast": true }] }, "gateway": { "mode": "fixed", "defaultProvider": "xai", "defaultModel": "grok-4" } });
        let routes = json!({});
        let current = json!({ "requestedModel": "mixdog/mine" });
        let mut input = input(Some(&config), &routes);
        input.current_route = Some(&current);
        let status = load_gateway_status(&world(), &input).unwrap();
        assert_eq!((status["provider"].clone(), status["model"].clone(), status["effort"].clone(), status["fast"].clone(), status["modelDisplay"].clone()), (json!("openai"), json!("gpt-5"), json!("low"), json!(true), json!("Mine")));
        let unknown = json!({ "requestedModel": "mixdog/nothing" });
        input.current_route = Some(&unknown);
        assert_eq!(load_gateway_status(&world(), &input), None);
        // The shipped presets resolve too, by their alias.
        let shipped = json!({ "requestedModel": "mixdog/opus-high" });
        input.current_route = Some(&shipped);
        assert_eq!(load_gateway_status(&world(), &input).unwrap()["model"], "claude-opus-4-8");
    }

    #[test]
    fn context_meta_never_derives_a_compaction_limit() {
        let info = json!({ "context_window": 1_000_000, "autoCompactTokenLimit": 1_000_000 });
        let meta = route_context_meta(&info, &json!({ "effectiveContextWindowPercent": 90 }));
        assert_eq!((meta["contextWindow"].clone(), meta["rawContextWindow"].clone(), meta["autoCompactTokenLimit"].clone()), (json!(900000), json!(1000000), Value::Null));
        let meta = route_context_meta(&json!({ "contextWindow": 200000, "autoCompactTokenLimit": 150000 }), &json!({}));
        assert_eq!((meta["contextWindow"].clone(), meta["autoCompactTokenLimit"].clone()), (json!(200000), json!(150000)));
        assert_eq!(compact_boundary_for_status(&json!({ "contextWindow": 5 }), &Value::Null), Some(5.0));
        assert_eq!(compact_boundary_for_status(&json!({}), &Value::Null), None);
    }

    #[test]
    fn the_cached_quota_is_the_routes_then_the_providers_then_the_freshest_of_the_provider() {
        let cache = json!({ "routes": {
            "openai-oauthgpt-5": { "cachedAt": 5000, "quotaWindows": [{ "label": "5H" }] },
            "openai-oauthgpt-4": { "cachedAt": 6000, "quotaWindows": [{ "label": "OLD" }] },
            "openai-oauthgpt-3": { "cachedAt": 9000, "quotaWindows": [{ "label": "NEW" }] },
        } });
        assert_eq!(cached_quota_windows_fallback(Some(&cache), "openai-oauth", "gpt-5", 1000.0), (vec![json!({ "label": "5H" })], 5000.0));
        assert_eq!(cached_quota_windows_fallback(Some(&cache), "openai-oauth", "gpt-9", 1000.0).0, vec![json!({ "label": "NEW" })]);
        // A snapshot from before this process started is a previous launch's.
        assert_eq!(cached_quota_windows_fallback(Some(&cache), "openai-oauth", "gpt-5", 5001.0), (Vec::new(), 0.0));
        assert_eq!(cached_quota_windows_fallback(None, "openai-oauth", "gpt-5", 0.0), (Vec::new(), 0.0));
    }

    fn plain<'a>(cols: u32, now: f64) -> SegmentFormat<'a> {
        SegmentFormat { cols, dim: "", reset: "", green: "", yellow: "", red: "", colour_pct: &percent_text, epoch_ms_to_hhmm: &clock_text, now }
    }

    fn percent_text(percent: i64) -> String {
        format!("{percent}%")
    }

    fn clock_text(_at: f64) -> String {
        "07:59".into()
    }

    #[test]
    fn oauth_windows_print_their_percentage_and_reset_aligned_in_columns() {
        let status = json!({
            "provider": "openai-oauth", "providerKind": "oauth",
            "quotaWindows": [
                { "label": "5h", "usedPct": 5.4, "source": "provider", "resetAt": 10_000.0 },
                { "label": "7d", "usedPct": 100, "source": "openai", "resetAt": 10_000.0 + 3.0 * 86_400_000.0 },
                { "label": "x", "usedPct": 1, "source": "provider" },
                { "label": "extra", "usedPct": 1 },
            ],
            "routeSpend": { "costUsd": 0.5 },
        });
        let segments = format_gateway_limit_segments(&status, &plain(120, 0.0));
        assert_eq!(segments.len(), 4);
        assert_eq!(segments[0], "5H   5% ↻ 07:59");
        assert!(segments[1].starts_with("7D 100% ↻ ") && segments[1].len() > "7D 100% ↻ ".len());
        assert_eq!(segments[2], "X   1%");
        assert_eq!(segments[3], "SESS $0.500");
        // Narrow: one window, no alignment.
        let narrow = format_gateway_limit_segments(&status, &plain(60, 0.0));
        assert_eq!(narrow[0], "5H 5% ↻ 07:59");
        assert_eq!(narrow.len(), 2);
    }

    #[test]
    fn a_plain_api_route_prints_spend_and_credit_not_windows() {
        let status = json!({ "provider": "deepseek", "providerKind": "api", "quotaWindows": [{ "label": "5H", "usedPct": 5 }], "routeSpend": { "label": "sess", "costUsd": 12.3456 }, "balance": { "remainingUsd": 0.004 } });
        assert_eq!(format_gateway_limit_segments(&status, &plain(120, 0.0)), vec!["SESS $12".to_owned(), "Credit $0.0040".to_owned()]);
        let none = json!({ "provider": "deepseek", "providerKind": "api", "lastUsage": { "costUsd": 2.5 } });
        assert_eq!(format_gateway_limit_segments(&none, &plain(120, 0.0)), vec!["$ $2.50".to_owned()]);
        assert!(format_gateway_limit_segments(&Value::Null, &plain(120, 0.0)).is_empty());
    }

    #[test]
    fn dollar_and_credit_windows_colour_by_what_is_left() {
        let colour = SegmentFormat { green: "<g>", yellow: "<y>", red: "<r>", reset: "</>", ..plain(120, 0.0) };
        let status = json!({
            "provider": "x-oauth", "providerKind": "oauth",
            "quotaWindows": [
                { "label": "A", "source": "provider", "remainingUsd": 0.5 },
                { "label": "B", "source": "local", "remainingUsd": 20 },
                { "label": "C", "source": "provider", "remainingCredits": 1500, "limitCredits": 20000, "usedPct": 96 },
            ],
        });
        let segments = format_gateway_limit_segments(&status, &colour);
        assert_eq!(segments[0], "A</> <r>$0.500</>");
        assert_eq!(segments[1], "B</> <y>est $20</>");
        assert_eq!(segments[2], "C</> <r>1.5K/20K</>");
    }

    #[test]
    fn money_and_compact_numbers_round_as_the_footer_does() {
        assert_eq!([money(0.0), money(12.6), money(3.14159), money(0.0449), money(0.00004), money(f64::NAN)], ["$0", "$13", "$3.14", "$0.045", "$0.0000", ""]);
        assert_eq!([compact_number(1_250_000.0), compact_number(12_000_000.0), compact_number(1500.0), compact_number(15_000.0), compact_number(42.0), compact_number(3.14), compact_number(0.5)], ["1.3M", "12M", "1.5K", "15K", "42", "3.1", "0.50"]);
        assert_eq!(visible_length("\u{1b}[31mab\u{1b}[0m"), 2);
        assert_eq!(strip_statusline_model_suffixes("Opus 4.8 XHIGH fast"), "Opus 4.8");
        assert_eq!(strip_statusline_model_suffixes("HIGH"), "HIGH");
    }
}
