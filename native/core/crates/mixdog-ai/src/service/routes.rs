//! Route chains, the native web-search route and the compaction lighter
//! model (`shared/model-route-chain.mjs`, `runtime-core/workflow.mjs`,
//! `runtime-core/model-capabilities.mjs`, `session-runtime/native-web-search`,
//! `session/compact/summary-route.mjs`): pure functions over route JSON and
//! catalog rows. The host feeds them the config, the main route and the
//! loaded catalog rows.

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Map;
use serde_json::Value;

pub const WEB_SEARCH_DEFAULT_PROVIDER: &str = "default";
pub const WEB_SEARCH_DEFAULT_MODEL: &str = "default";

const WEB_SEARCH_PROVIDER_FAMILIES: [(&str, &str); 8] = [
    ("openai-oauth", "openai"),
    ("openai", "openai"),
    ("grok-oauth", "xai"),
    ("xai", "xai"),
    ("gemini", "gemini"),
    ("antigravity-oauth", "gemini"),
    ("anthropic", "anthropic"),
    ("anthropic-oauth", "anthropic"),
];

/// JS `String(value)`: arrays join their elements with `,` (null as empty),
/// objects are `[object Object]`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `clean(value)` (`shared/clean.mjs`): `String(value ?? '').trim()`.
pub(crate) fn clean(v: Option<&Value>) -> String {
    v.map_or_else(String::new, |v| mixdog_js::js_trim(&js_string(v)).to_owned())
}

/// JS truthiness of a value, as `a || b` chains read it.
pub(crate) fn truthy(v: Option<&Value>) -> Option<&Value> {
    truthy_str(v)
}

fn truthy_str(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| match x {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        _ => true,
    })
}

// -- route chains -------------------------------------------------------------------------

/// `canonicalRouteProvider`.
pub fn canonical_route_provider(value: &str) -> String {
    let id = mixdog_js::js_trim(value);
    match id {
        "openai-api" => "openai",
        "xai-api" => "xai",
        "gemini-api" => "gemini",
        "anthropic-api" => "anthropic",
        other => other,
    }
    .to_owned()
}

/// `routeChain`: the primary route followed by its fallbacks (empty for a
/// non-object).
pub fn route_chain(route: &Value) -> Result<Vec<Value>, String> {
    let Some(object) = route.as_object() else { return Ok(Vec::new()) };
    let mut primary = object.clone();
    let fallbacks = primary.remove("fallbacks");
    let fallbacks = match fallbacks {
        // The `= []` default applies to a missing key only; `null` is not an array.
        None => Vec::new(),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("route.fallbacks must be an array".into()),
    };
    for entry in &fallbacks {
        if entry.as_object().is_none_or(|o| o.contains_key("fallbacks")) {
            return Err("fallback routes must be leaf route objects".into());
        }
    }
    let mut chain = vec![Value::Object(primary)];
    chain.extend(fallbacks);
    Ok(chain)
}

/// The fallbacks a chain runs: those on a provider not already used by the
/// primary or an earlier fallback.
pub fn execution_fallbacks(route: &Value) -> Result<Vec<Value>, String> {
    let mut chain = route_chain(route)?.into_iter();
    let Some(primary) = chain.next() else { return Ok(Vec::new()) };
    let mut seen = vec![canonical_route_provider(&clean(primary.get("provider")))];
    let mut out = Vec::new();
    for entry in chain {
        let provider = canonical_route_provider(&clean(entry.get("provider")));
        if !seen.contains(&provider) {
            seen.push(provider);
            out.push(entry);
        }
    }
    Ok(out)
}

/// `validateRouteChainProviders`: every route names a provider and model; a
/// provider repeats only when `allow_duplicates`; `default` (follow Main) is
/// only the primary.
pub fn validate_route_chain_providers(routes: &[Value], allow_duplicates: bool) -> Result<(), String> {
    let mut providers: Vec<String> = Vec::new();
    for route in routes {
        let provider = canonical_route_provider(&clean(route.get("provider")));
        if provider.is_empty() || clean(route.get("model")).is_empty() {
            return Err("route requires provider and model".into());
        }
        if !allow_duplicates && providers.contains(&provider) {
            return Err(format!("duplicate route provider \"{provider}\""));
        }
        if !providers.is_empty() && provider == "default" {
            return Err("follow Main is only allowed as the primary route".into());
        }
        providers.push(provider);
    }
    Ok(())
}

/// `normalizeRouteChain` with a leaf normalizer; `strict` refuses a repeated provider.
pub fn normalize_route_chain(
    route: &Value,
    normalize_leaf: &dyn Fn(&Value, &Value) -> Option<Value>,
    fallback: &Value,
    strict: bool,
) -> Result<Option<Value>, String> {
    let mut merged = fallback.as_object().cloned().unwrap_or_default();
    if let Some(r) = route.as_object() {
        merged.extend(r.clone());
    }
    let raw = route_chain(&Value::Object(merged))?;
    let Some(primary) = normalize_leaf(route, fallback) else { return Ok(None) };
    let empty = Value::Object(Map::new());
    let mut routes = Vec::new();
    for (index, entry) in raw.iter().enumerate() {
        let normalized = if index == 0 {
            primary.clone()
        } else {
            normalize_leaf(entry, &empty).ok_or("fallback route requires provider and model")?
        };
        let mut o = normalized.as_object().cloned().unwrap_or_default();
        let provider = canonical_route_provider(&clean(o.get("provider")));
        o.insert("provider".into(), Value::String(provider));
        routes.push(Value::Object(o));
    }
    validate_route_chain_providers(&routes, !strict)?;
    let mut rest = routes.split_off(1);
    let first = routes.remove(0);
    if rest.is_empty() {
        return Ok(Some(first));
    }
    let mut out = first.as_object().cloned().unwrap_or_default();
    out.insert("fallbacks".into(), Value::Array(std::mem::take(&mut rest)));
    Ok(Some(Value::Object(out)))
}

// -- web search routes ------------------------------------------------------------------------

pub fn normalize_web_search_provider_id(provider: &str) -> String {
    canonical_route_provider(provider)
}

/// `webSearchProviderFamily`: `openai`, `xai`, `gemini`, `anthropic`, or `""`.
pub fn web_search_provider_family(provider: &str) -> &'static str {
    let id = normalize_web_search_provider_id(provider);
    WEB_SEARCH_PROVIDER_FAMILIES.iter().find(|(p, _)| *p == id).map_or("", |(_, f)| f)
}

pub fn is_web_search_capable_provider(provider: &str) -> bool {
    !web_search_provider_family(provider).is_empty()
}

pub fn is_default_web_search_route(route: &Value) -> bool {
    normalize_web_search_provider_id(&clean(route.get("provider"))) == WEB_SEARCH_DEFAULT_PROVIDER
        && clean(route.get("model")).to_lowercase() == WEB_SEARCH_DEFAULT_MODEL
}

/// `normalizeEffortInput` without the throw: `None` for blank/`auto`/invalid.
fn effort_of(v: Option<&Value>) -> Option<String> {
    crate::effort::normalize_saved_effort(v)
}

fn pick<'a>(route: &'a Value, fallback: &'a Value, key: &str) -> Option<&'a Value> {
    truthy_str(route.get(key)).or_else(|| fallback.get(key).filter(|v| !v.is_null() && !(v.is_string() && v.as_str() == Some(""))))
}

fn web_search_leaf(route: &Value, fallback: &Value) -> Option<Value> {
    let provider = normalize_web_search_provider_id(&clean(pick(route, fallback, "provider")));
    let model = clean(pick(route, fallback, "model"));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let effort = effort_of(route.get("effort").filter(|v| !v.is_null()).or_else(|| fallback.get("effort")));
    let fast = route.get("fast").filter(|v| !v.is_null()).or_else(|| fallback.get("fast"));
    let tool_type = clean(pick(route, fallback, "toolType"));
    let params = route.get("modelParameters").filter(|v| !v.is_null()).or_else(|| fallback.get("modelParameters"));
    let mut out = Map::new();
    out.insert("provider".into(), provider.into());
    out.insert("model".into(), model.into());
    if let Some(e) = effort {
        out.insert("effort".into(), e.into());
    }
    if let Some(f @ Value::Bool(_)) = fast {
        out.insert("fast".into(), f.clone());
    }
    if let Some(p @ Value::Object(_)) = params {
        out.insert("modelParameters".into(), p.clone());
    }
    if !tool_type.is_empty() {
        out.insert("toolType".into(), tool_type.into());
    }
    Some(Value::Object(out))
}

pub fn normalize_web_search_route_config(route: &Value, fallback: &Value) -> Result<Option<Value>, String> {
    normalize_route_chain(route, &web_search_leaf, fallback, true)
}

/// `webSearchRouteOrDefault`: the first candidate that normalizes, else the
/// default "follow the Main Model" route.
pub fn web_search_route_or_default(candidates: &[&Value]) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    for candidate in candidates {
        if let Some(normalized) = normalize_web_search_route_config(candidate, &empty)? {
            return Ok(normalized);
        }
    }
    let default = serde_json::json!({"provider": WEB_SEARCH_DEFAULT_PROVIDER, "model": WEB_SEARCH_DEFAULT_MODEL});
    Ok(normalize_web_search_route_config(&default, &empty)?.unwrap_or(default))
}

// -- hosted web-search capability -------------------------------------------------------------

const NON_CHAT_ID: [&str; 13] = [
    "embedding", "rerank", "moderation", "image", "imagen", "imagine", "video", "veo", "audio", "tts", "stt", "aqa",
    "search-preview",
];

fn non_chat(id: &str) -> bool {
    NON_CHAT_ID.iter().any(|p| id.contains(p))
}

/// `^name(?:-|$)`.
fn starts_word(id: &str, name: &str) -> bool {
    id.strip_prefix(name).is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

fn openai_unsupported(id: &str) -> bool {
    if non_chat(id) || id.contains("codex") {
        return true;
    }
    // ^gpt-(?:3|4(?:$|-))
    if let Some(rest) = id.strip_prefix("gpt-") {
        if rest.starts_with('3') || (rest.starts_with('4') && (rest.len() == 1 || rest[1..].starts_with('-'))) {
            return true;
        }
    }
    // ^o[12](?:-|$)
    if ["o1", "o2"].iter().any(|o| starts_word(id, o)) {
        return true;
    }
    ["babbage", "davinci", "text-"].iter().any(|p| id.starts_with(p))
}

fn grok_unsupported(id: &str) -> bool {
    if non_chat(id) || id.contains("composer") || id == "grok-build" {
        return true;
    }
    // ^grok-[123](?:[.-]|$)
    id.strip_prefix("grok-").is_some_and(|rest| {
        let mut chars = rest.chars();
        matches!(chars.next(), Some('1' | '2' | '3')) && matches!(chars.next(), None | Some('.' | '-'))
    })
}

fn gemini_unsupported(id: &str) -> bool {
    if non_chat(id) || !id.starts_with("gemini-") || id.contains("computer-use") || id.contains("customtools") {
        return true;
    }
    let rest = &id["gemini-".len()..];
    // ^gemini-(?:1[.-]|pro|ultra)
    if rest.starts_with("1.") || rest.starts_with("1-") || rest.starts_with("pro") || rest.starts_with("ultra") {
        return true;
    }
    // ^gemini-2\.0-(?!flash)
    rest.strip_prefix("2.0-").is_some_and(|tail| !tail.starts_with("flash"))
}

fn anthropic_unsupported(id: &str) -> bool {
    // ^claude-(?:\d|instant)  |  ^claude-[a-z]+-[123](?:[-.]|$)
    let Some(rest) = id.strip_prefix("claude-") else { return false };
    if rest.starts_with(|c: char| c.is_ascii_digit()) || rest.starts_with("instant") {
        return true;
    }
    let word = rest.chars().take_while(char::is_ascii_lowercase).count();
    if word == 0 {
        return false;
    }
    rest[word..].strip_prefix('-').is_some_and(|tail| {
        let mut chars = tail.chars();
        matches!(chars.next(), Some('1' | '2' | '3')) && matches!(chars.next(), None | Some('-' | '.'))
    })
}

/// What one catalog row states about hosted web search: its own
/// `supportsWebSearch`, else a web_search tool in its tool lists.
fn row_web_search_declaration(row: Option<&Value>) -> Option<bool> {
    let row = row.filter(|r| r.is_object())?;
    if let Some(flag) = row.get("supportsWebSearch").and_then(Value::as_bool) {
        return Some(flag);
    }
    let lists = [
        row.get("supportedTools"),
        row.get("tools"),
        row.get("capabilities").and_then(|c| c.get("tools")),
    ];
    let has = lists.into_iter().flatten().filter_map(Value::as_array).flatten().any(|tool| {
        let name = ["type", "name"]
            .iter()
            .find_map(|k| truthy_str(tool.get(*k)))
            .or(Some(tool))
            .map(|v| clean(Some(v)).to_lowercase())
            .unwrap_or_default();
        name == "web_search" || name == "web_search_preview"
    });
    has.then_some(true)
}

/// `webSearchCapableFor(provider, model)`: the route's own row, then the
/// catalog's row for the model, then the family's closed set of retired and
/// non-chat ids. `model_row` is the route's row (`None` for a bare id).
pub fn web_search_capable_for(
    provider: &str,
    model_id: &str,
    model_row: Option<&Value>,
    catalog_row: Option<&Value>,
) -> bool {
    let unsupported: fn(&str) -> bool = match web_search_provider_family(provider) {
        "openai" => openai_unsupported,
        "xai" => grok_unsupported,
        "gemini" => gemini_unsupported,
        "anthropic" => anthropic_unsupported,
        _ => return false,
    };
    let id = mixdog_js::js_trim(model_id).to_lowercase();
    if id.is_empty() {
        return false;
    }
    if let Some(declared) = row_web_search_declaration(model_row).or_else(|| row_web_search_declaration(catalog_row)) {
        return declared;
    }
    !unsupported(&id)
}

/// The Main route a default web-search route follows.
#[derive(Clone, Debug, Default)]
pub struct MainRoute {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub fast: bool,
    pub model_parameters: Value,
    /// The provider catalog's row for the model (loaded by the caller when
    /// the provider keeps no per-model cache).
    pub catalog_row: Option<Value>,
}

/// One provider/model that may answer a native web search.
#[derive(Clone, PartialEq, Debug)]
pub struct SearchCandidate {
    pub key: String,
    pub provider: String,
    pub model: String,
    pub source: &'static str,
    pub effort: Option<String>,
    pub fast: bool,
    pub model_parameters: Value,
    pub tool_type: Option<String>,
}

/// `nativeWebSearchRoutes`: the configured chain resolved to candidates,
/// deduplicated by provider. `catalog_row_for(provider, model)` is the
/// catalog's row for a bare id.
pub fn native_web_search_routes(
    web_search_route: &Value,
    main: Option<&MainRoute>,
    catalog_row_for: &dyn Fn(&str, &str) -> Option<Value>,
) -> Result<Vec<SearchCandidate>, String> {
    let mut out: Vec<SearchCandidate> = Vec::new();
    for selected in route_chain(web_search_route)? {
        let Some(mut candidate) = resolve_candidate(&selected, main, catalog_row_for) else { continue };
        candidate.provider = canonical_route_provider(&candidate.provider);
        if out.iter().any(|c| c.provider == candidate.provider) {
            continue;
        }
        out.push(candidate);
    }
    Ok(out)
}

fn resolve_candidate(
    route: &Value,
    main: Option<&MainRoute>,
    catalog_row_for: &dyn Fn(&str, &str) -> Option<Value>,
) -> Option<SearchCandidate> {
    let tool_type = Some(clean(route.get("toolType"))).filter(|t| !t.is_empty());
    if is_default_web_search_route(route) {
        let main = main.filter(|m| !m.provider.is_empty() && !m.model.is_empty())?;
        // The global catalog is always consulted (`catalogRowFor(id, provider)`), after the
        // Main row: a row that declares nothing leaves the catalog the word.
        let catalog = catalog_row_for(&main.provider, &main.model);
        if !web_search_capable_for(&main.provider, &main.model, main.catalog_row.as_ref(), catalog.as_ref()) {
            return None;
        }
        return Some(SearchCandidate {
            key: format!("default\n{}\n{}", main.provider, main.model),
            provider: normalize_web_search_provider_id(&main.provider),
            model: main.model.clone(),
            source: "default-web-search-route",
            effort: main.effort.clone(),
            fast: main.fast,
            model_parameters: if main.model_parameters.is_object() { main.model_parameters.clone() } else { Value::Object(Map::new()) },
            tool_type,
        });
    }
    let provider = normalize_web_search_provider_id(&clean(route.get("provider")));
    if !is_web_search_capable_provider(&provider) {
        return None;
    }
    let model = route.get("model").map(|m| clean(Some(m))).unwrap_or_default();
    Some(SearchCandidate {
        key: format!("{provider}\n{model}"),
        provider,
        model,
        source: "web-search-route",
        effort: Some(clean(route.get("effort"))).filter(|e| !e.is_empty()),
        fast: route.get("fast") == Some(&Value::Bool(true)),
        model_parameters: route
            .get("modelParameters")
            .filter(|p| p.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
        tool_type,
    })
}

/// The error text when no candidate can run (`noCandidateError`).
pub fn no_candidate_message(web_search_route: &Value, main: Option<&MainRoute>) -> String {
    if is_default_web_search_route(web_search_route) {
        let unknown = || "unknown".to_owned();
        let provider = main.map(|m| m.provider.clone()).filter(|p| !p.is_empty()).unwrap_or_else(unknown);
        let model = main.map(|m| m.model.clone()).filter(|p| !p.is_empty()).unwrap_or_else(unknown);
        return format!(
            "default web search route requires the current main model to support native web search ({provider}/{model})"
        );
    }
    let field = |key: &str| truthy_str(web_search_route.get(key)).map(|v| clean(Some(v))).unwrap_or_else(|| "unknown".into());
    format!(
        "web search route \"{}/{}\" cannot run native web search; open /websearch to choose another provider/model",
        field("provider"),
        field("model")
    )
}

/// `canFallbackCapacityRoute`: only a capacity refusal the server stated
/// (429/503, or an account-pool quota refusal) before any output moves to the
/// next provider; a denied or failed credential surfaces. A started or
/// terminal stream stays on its route.
pub fn capacity_fallback(error: &ProviderError, aborted: bool, pool_quota_refusal: bool) -> bool {
    if aborted || error.exposure.text_emitted || error.exposure.tool_dispatched || error.exposure.tool_input_cut {
        return false;
    }
    if error.unsafe_to_retry {
        return false;
    }
    if !matches!(
        error.kind,
        ErrorKind::RateLimited | ErrorKind::QuotaExhausted | ErrorKind::Overloaded | ErrorKind::Transient
    ) {
        return false;
    }
    matches!(error.status, Some(429 | 503)) || (error.kind == ErrorKind::QuotaExhausted && pool_quota_refusal)
}

// -- compaction lighter model -----------------------------------------------------------------

/// `gptVersion`: `[major, minor]` of `gpt-N[.M]`, or `None`.
pub fn gpt_version(id: &str) -> Option<(u64, u64)> {
    let rest = id.strip_prefix("gpt-")?;
    let digits = |s: &str| s.chars().take_while(char::is_ascii_digit).count();
    let d1 = digits(rest);
    if d1 == 0 {
        return None;
    }
    let boundary = |s: &str| s.is_empty() || s.starts_with('-');
    let after = &rest[d1..];
    let (minor, tail_ok) = match after.strip_prefix('.') {
        Some(frac) if digits(frac) > 0 => {
            let d2 = digits(frac);
            (Some(&frac[..d2]), boundary(&frac[d2..]))
        }
        _ => (None, boundary(after)),
    };
    let (minor, tail_ok) = if minor.is_some() && !tail_ok { (None, boundary(after)) } else { (minor, tail_ok) };
    if !tail_ok {
        return None;
    }
    if d1 > 1 && minor.is_none() && format!("gpt-{}", &rest[..d1]) == id {
        return None;
    }
    Some((rest[..d1].parse().ok()?, minor.map_or(Some(0), |m| m.parse().ok())?))
}

fn claude_version(id: &str) -> Vec<u64> {
    // ^claude-[a-z]+-(\d+)(?:-(\d+))?  (case-insensitive)
    let Some(rest) = id.get(..7).filter(|p| p.eq_ignore_ascii_case("claude-")).map(|_| &id[7..]) else {
        return Vec::new();
    };
    let word = rest.chars().take_while(char::is_ascii_alphabetic).count();
    let Some(after) = (word > 0).then(|| rest[word..].strip_prefix('-')).flatten() else { return Vec::new() };
    let digits = |s: &str| s.chars().take_while(char::is_ascii_digit).count();
    let major = digits(after);
    if major == 0 {
        return Vec::new();
    }
    let mut out = vec![after[..major].parse().unwrap_or(0)];
    if let Some(minor_text) = after[major..].strip_prefix('-') {
        let minor = digits(minor_text);
        if minor > 0 {
            out.push(minor_text[..minor].parse().unwrap_or(0));
        }
    }
    out
}

fn compare_anthropic_version(a: &str, b: &str) -> std::cmp::Ordering {
    let (na, nb) = (claude_version(a), claude_version(b));
    for i in 0..na.len().max(nb.len()) {
        let (x, y) = (na.get(i).copied().unwrap_or(0), nb.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    mixdog_js::locale_compare(a, b)
}

fn compare_gpt_version(a: &str, b: &str) -> std::cmp::Ordering {
    let (am, an) = gpt_version(a).unwrap_or((0, 0));
    let (bm, bn) = gpt_version(b).unwrap_or((0, 0));
    am.cmp(&bm).then(an.cmp(&bn)).then(b.len().cmp(&a.len()))
}

/// `lighterSubscriptionModel`: the newest lighter-family model the saved
/// catalog of a subscription provider lists. API-key providers bill per token
/// and get no lighter step.
pub fn lighter_subscription_model(provider: &str, catalog: &[Value]) -> Option<String> {
    let (matches, compare): (fn(&Value, &str) -> bool, fn(&str, &str) -> std::cmp::Ordering) = match provider {
        "anthropic-oauth" => (|row, _| row.get("family").and_then(Value::as_str) == Some("haiku"), compare_anthropic_version),
        "openai-oauth" => (|_, id| id.contains("-luna") && gpt_version(id).is_some(), compare_gpt_version),
        _ => return None,
    };
    let mut best: Option<String> = None;
    for row in catalog {
        let id = clean(row.get("id"));
        if id.is_empty() || !matches(row, &id) {
            continue;
        }
        if best.as_deref().is_none_or(|b| compare(&id, b).is_gt()) {
            best = Some(id);
        }
    }
    best
}

/// How long the cache a saved request wrote or read stays readable.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CacheLifetime {
    /// Never expires (openai-oauth).
    Forever,
    Ms(u64),
}

const ANTHROPIC_TAIL_5M_MS: u64 = 5 * 60_000;
const ANTHROPIC_TAIL_1H_MS: u64 = 60 * 60_000;
/// OpenAI public API, GPT-5.6+ Responses: request ttl "30m".
const OPENAI_TAIL_LIFETIME_MS: u64 = 30 * 60_000;

/// `providerTailCacheLifetimeMs`: how long a session's message-tail cache
/// stays readable. `None`: it does not expire (openai-oauth) or the provider
/// exposes no tail lifetime. `messages_tier` is the session cache strategy's
/// `messages` tier (`5m`/`1h`/`none`).
pub fn provider_tail_cache_lifetime_ms(provider: &str, messages_tier: Option<&str>) -> Option<u64> {
    let key = mixdog_js::js_trim(provider).to_lowercase();
    match key.as_str() {
        "openai-oauth" => None,
        "openai" => Some(OPENAI_TAIL_LIFETIME_MS),
        "anthropic" | "anthropic-oauth" => match messages_tier {
            Some("5m") => Some(ANTHROPIC_TAIL_5M_MS),
            Some("1h") => Some(ANTHROPIC_TAIL_1H_MS),
            _ => None,
        },
        _ => None,
    }
}

/// `requestCacheLifetimeMs`: how long the cache a saved request wrote or read
/// stays readable. Anthropic: the request's message-tail tier; OpenAI: 30m;
/// other providers: the catalog's prompt-caching flag decides.
pub fn request_cache_lifetime(provider: &str, messages_tier: Option<&str>, catalog_supports_prompt_caching: bool) -> CacheLifetime {
    if provider == "openai-oauth" {
        return CacheLifetime::Forever;
    }
    if provider == "openai" || matches!(provider, "anthropic" | "anthropic-oauth") {
        return CacheLifetime::Ms(provider_tail_cache_lifetime_ms(provider, messages_tier).unwrap_or(0));
    }
    CacheLifetime::Ms(if catalog_supports_prompt_caching { CATALOG_PROMPT_CACHE_LIFETIME_MS } else { 0 })
}

/// The lifetime for a provider outside the Anthropic/OpenAI ones whose
/// catalog marks prompt caching: the shortest common cache lifetime.
pub const CATALOG_PROMPT_CACHE_LIFETIME_MS: u64 = 5 * 60_000;
const WARM_MARGIN_MIN_MS: f64 = 30_000.0;
const WARM_MARGIN_RATIO: f64 = 0.1;

/// `compactionCacheWarm`: whether the session's last settled request is still
/// inside the cache lifetime it used, with a safety margin. No forkable
/// request (`None`) is cold.
pub fn compaction_cache_warm(request: Option<(CacheLifetime, u64)>, now_ms: u64) -> bool {
    let Some((lifetime, sent_at)) = request else { return false };
    let CacheLifetime::Ms(lifetime) = lifetime else { return true };
    let lifetime = lifetime as f64;
    let margin = WARM_MARGIN_MIN_MS.max(lifetime * WARM_MARGIN_RATIO);
    (now_ms as f64 - sent_at as f64) < lifetime - margin
}

#[cfg(test)]
mod tests;