//! The model and effort the statusline shows when the gateway mode is `claude-current`: the route inherited
//! from Claude Code (`vendor/statusline/src/gateway/claude-current.mjs`). Three sources are layered, each over
//! the one before: Claude Code's `settings.json`, the persisted status (`claude-current-model.json` of the data
//! dir, else `cc-statusline-last.json` of the config dir, either only while younger than ten minutes) and the
//! request in hand; with none of them the route is the newest Opus.
//!
//! The files are read by the caller (through the I/O lanes) and handed in parsed, with the age of the two
//! persisted ones; this module only decides.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;

/// `CLAUDE_CURRENT_MODE`.
pub const CLAUDE_CURRENT_MODE: &str = "claude-current";

/// `readClaudeCodeCurrentRoute`'s default `maxAgeMs` for the persisted status files.
pub const PERSISTED_MAX_AGE_MS: f64 = 10.0 * 60.0 * 1000.0;

/// `EFFORT_BUDGET`, in the order Node iterates it.
const EFFORT_BUDGET: [(&str, f64); 5] = [("low", 1024.0), ("medium", 4096.0), ("high", 16384.0), ("xhigh", 32768.0), ("max", 32768.0)];

/// `DEFAULT_FAMILY_MODEL`.
fn default_family_model(family: &str) -> Option<&'static str> {
    match family {
        "opus" => Some("claude-opus-4-8"),
        "sonnet" => Some("claude-sonnet-4-6"),
        "haiku" => Some("claude-haiku-4-5-20251001"),
        _ => None,
    }
}

/// What the route resolution reads of the model catalog, the provider roster and the environment.
pub trait ClaudeWorld {
    /// `getModelMetadataSync(model, 'anthropic-oauth')?.contextWindow`.
    fn context_window(&self, model: &str) -> Option<f64>;
    /// `providerCachedModelsSync('anthropic-oauth')`: the cached roster rows.
    fn roster(&self) -> Vec<Value>;
    /// The environment variable `name`.
    fn env(&self, name: &str) -> Option<String>;
}

/// A persisted status file as read: its content and its age's reference, the modification time (epoch ms).
#[derive(Clone, Copy, Debug)]
pub struct AgedFile<'a> {
    pub value: &'a Value,
    pub mtime_ms: f64,
}

/// Everything `readClaudeCodeCurrentRoute` reads.
pub struct ClaudeSources<'a> {
    /// `<config dir>/settings.json`.
    pub settings: Option<&'a Value>,
    /// `<data dir>/claude-current-model.json`.
    pub own: Option<AgedFile<'a>>,
    /// `<config dir>/cc-statusline-last.json`.
    pub last: Option<AgedFile<'a>>,
    /// The request payload.
    pub request: Option<&'a Value>,
    pub max_age_ms: f64,
    pub for_boot: bool,
    pub now: f64,
}

/// A claude-current route.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClaudeRoute {
    pub mode: String,
    pub source: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requested_model: Option<String>,
    pub model_display: Option<String>,
    pub effort: Option<String>,
    pub fast: Option<bool>,
    pub thinking_budget_tokens: Option<f64>,
    pub context_window: Option<f64>,
    pub thinking_enabled: Option<bool>,
    pub at: f64,
}

fn clean(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

fn some(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

/// `isMixdogModelSelection(value)`: the text, or the object's `requestedModel || model`, starts with `mixdog/`.
pub fn is_mixdog_model_selection(value: &Value) -> bool {
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => {
            let requested = clean(map.get("requestedModel"));
            if requested.is_empty() { clean(map.get("model")) } else { requested }
        }
        _ => String::new(),
    };
    js_to_lowercase(js_trim(&raw)).starts_with("mixdog/")
}

/// `num(v, null)`: a finite number, else none; null, undefined and the empty string are none.
pub(crate) fn num(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(to_number(value)).filter(|n| n.is_finite()),
    }
}

/// `cleanBool`: a boolean, or the flag a word names; anything else is none.
fn clean_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) => match js_to_lowercase(js_trim(text)).as_str() {
            "1" | "true" | "yes" | "on" | "fast" | "priority" => Some(true),
            "0" | "false" | "no" | "off" | "standard" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `stripClaudeContextSuffix`: the model without a trailing `[...]` suffix.
pub fn strip_claude_context_suffix(model: &Value) -> String {
    let text = clean(Some(model));
    if let Some(body) = text.strip_suffix(']')
        && let Some(open) = body.rfind('[')
        && !body[open + 1..].is_empty()
        && !body[open + 1..].contains(']')
    {
        return body[..open].to_owned();
    }
    text
}

/// A roster row's release stamp: its `releaseDate`, else its positive `created`.
fn stamp(row: &Value) -> f64 {
    let date = row.get("releaseDate").map_or(f64::NAN, |value| match value {
        Value::String(text) => mixdog_js::time::date_parse(text),
        other => mixdog_js::time::date_parse(&mixdog_js::value_to_string(other)),
    });
    if date.is_finite() && date != 0.0 {
        return date;
    }
    let created = to_number(row.get("created").unwrap_or(&Value::Null));
    if created > 0.0 { created } else { 0.0 }
}

/// `newestRosterModel(family)`: the newest roster model of the family, by the roster's own release stamps.
fn newest_roster_model(world: &dyn ClaudeWorld, family: &str) -> Option<String> {
    let prefix = format!("claude-{family}-");
    let mut rows: Vec<Value> = world
        .roster()
        .into_iter()
        .filter(|row| row.get("id").is_some_and(|id| js_to_lowercase(&mixdog_js::value_to_string(id)).starts_with(&prefix)))
        .collect();
    mixdog_js::js_sort_by(&mut rows, |a, b| stamp(b) - stamp(a));
    rows.first().and_then(|row| row.get("id")).filter(|id| !matches!(id, Value::Null) && !id.as_str().is_some_and(str::is_empty)).map(mixdog_js::value_to_string)
}

/// `familyDefaultModel(family)`: the environment override, else the newest roster model, else the shipped one.
pub fn family_default_model(world: &dyn ClaudeWorld, family: &str) -> Option<String> {
    let family = js_to_lowercase(family);
    if family.is_empty() {
        return None;
    }
    let name = format!("ANTHROPIC_DEFAULT_{}_MODEL", family.to_uppercase());
    let from_env = world.env(&name).map(|value| js_trim(&value).to_owned()).filter(|value| !value.is_empty());
    from_env.or_else(|| newest_roster_model(world, &family)).or_else(|| default_family_model(&family).map(str::to_owned))
}

/// `resolveClaudeModelAlias(model)`: a `claude-` id as it is, a family name as the family's default model.
pub fn resolve_claude_model_alias(world: &dyn ClaudeWorld, model: &Value) -> Option<String> {
    let raw = clean(Some(model));
    if raw.is_empty() {
        return None;
    }
    let stripped = strip_claude_context_suffix(&Value::String(raw));
    if js_to_lowercase(&stripped).starts_with("claude-") {
        return Some(stripped);
    }
    family_of(&stripped).and_then(|family| family_default_model(world, family))
}

const FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];

/// `^(opus|sonnet|haiku|fable|mythos)(?:[-_].*)?$` (case-insensitive): the family.
fn family_of(text: &str) -> Option<&'static str> {
    let lower = js_to_lowercase(text);
    FAMILIES.into_iter().find(|family| lower.strip_prefix(family).is_some_and(|rest| rest.is_empty() || rest.starts_with(['-', '_'])))
}

/// `contextWindowFromRawModel(raw, resolved)`: one million for a `[1m]` model, else the catalog's window.
fn context_window_from_raw(world: &dyn ClaudeWorld, raw: &str, resolved: Option<&str>) -> Option<f64> {
    if js_to_lowercase(js_trim(raw)).contains("[1m]") {
        return Some(1_000_000.0);
    }
    resolved.and_then(|model| world.context_window(model)).filter(|window| *window != 0.0)
}

/// `claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?:-\d{8})?` over the whole id: the family and the
/// version digits.
fn parse_claude_id(id: &str) -> Option<(&'static str, String, Option<String>)> {
    let lower = js_to_lowercase(id);
    let rest = lower.strip_prefix("claude-")?;
    let family = FAMILIES.into_iter().find(|family| rest.strip_prefix(family).is_some_and(|tail| tail.starts_with('-')))?;
    let tail = &rest[family.len() + 1..];
    let parts: Vec<&str> = tail.split('-').collect();
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let date = |part: &str| part.len() == 8 && digits(part);
    match parts.as_slice() {
        [major] if digits(major) => Some((family, (*major).to_owned(), None)),
        [major, minor] if digits(major) && digits(minor) => Some((family, (*major).to_owned(), Some((*minor).to_owned()))),
        [major, minor, stamp] if digits(major) && digits(minor) && date(stamp) => Some((family, (*major).to_owned(), Some((*minor).to_owned()))),
        _ => None,
    }
}

/// `displayClaudeModel(model, raw, display)`.
pub fn display_claude_model(world: &dyn ClaudeWorld, model: Option<&str>, raw: &str, display: &str) -> String {
    let explicit = js_trim(display);
    if !explicit.is_empty() {
        return explicit.to_owned();
    }
    let id = match model.map(js_trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_owned(),
        None => resolve_claude_model_alias(world, &Value::String(raw.to_owned())).unwrap_or_else(|| js_trim(raw).to_owned()),
    };
    if let Some((family, major, minor)) = parse_claude_id(&id) {
        let mut name = family.to_owned();
        name[..1].make_ascii_uppercase();
        let million = js_to_lowercase(raw).contains("[1m]") || context_window_from_raw(world, raw, Some(&id)) == Some(1_000_000.0);
        let suffix = if million { " (1M context)" } else { "" };
        return format!("{name} {major}{}{suffix}", minor.map(|minor| format!(".{minor}")).unwrap_or_default());
    }
    if id.is_empty() { raw.to_owned() } else { id }
}

/// `normalizeEffort`.
fn normalize_effort(value: Option<&Value>) -> Option<String> {
    let text = js_to_lowercase(&clean(value));
    match text.as_str() {
        "" => None,
        "extra-high" | "very-high" => Some("xhigh".into()),
        "low" | "medium" | "high" | "xhigh" | "max" => Some(text),
        _ => None,
    }
}

/// `effortFromThinking`: the effort whose budget is nearest the thinking budget.
fn effort_from_thinking(thinking: Option<&Value>) -> Option<String> {
    let thinking = thinking?.as_object()?;
    let kind = js_to_lowercase(&clean(thinking.get("type")));
    if !kind.is_empty() && kind != "enabled" {
        return None;
    }
    let budget = num(thinking.get("budget_tokens").filter(|v| !v.is_null()).or_else(|| thinking.get("budgetTokens")))?;
    if budget <= 0.0 {
        return None;
    }
    let mut best = None;
    let mut best_delta = f64::INFINITY;
    for (effort, value) in EFFORT_BUDGET {
        let delta = (value - budget).abs();
        if delta < best_delta {
            best = Some(effort.to_owned());
            best_delta = delta;
        }
    }
    best
}

/// `fastFromPayload`.
fn fast_from_payload(payload: &Map<String, Value>) -> Option<bool> {
    let direct = clean_bool(payload.get("fast_mode")).or_else(|| clean_bool(payload.get("fastMode"))).or_else(|| clean_bool(payload.get("fast")));
    if direct.is_some() {
        return direct;
    }
    let speed = ["speed", "service_tier", "serviceTier"].iter().find_map(|key| payload.get(*key).filter(|v| is_truthy(v)));
    match js_to_lowercase(&clean(speed)).as_str() {
        "fast" | "priority" => Some(true),
        "standard" | "default" => Some(false),
        _ => None,
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn first_clean(values: &[Option<&Value>]) -> String {
    values.iter().map(|value| clean(*value)).find(|text| !text.is_empty()).unwrap_or_default()
}

/// `routeFromPayload(payload, source)`.
fn route_from_payload(world: &dyn ClaudeWorld, payload: Option<&Value>, source: &str, now: f64) -> Option<ClaudeRoute> {
    let payload = payload?.as_object()?;
    let model_object = payload.get("model").and_then(Value::as_object);
    let raw_model = first_clean(&[
        model_object.and_then(|object| object.get("id")),
        payload.get("model"),
        payload.get("request").and_then(|request| request.get("model")),
        payload.get("message").and_then(|message| message.get("model")),
    ]);
    let model = resolve_claude_model_alias(world, &Value::String(raw_model.clone()));
    let level = payload.get("effort").and_then(|effort| effort.get("level"));
    let effort = normalize_effort(level).or_else(|| normalize_effort(payload.get("effortLevel"))).or_else(|| effort_from_thinking(payload.get("thinking")));
    let fast = fast_from_payload(payload);
    let thinking = payload.get("thinking");
    let budget = thinking
        .and_then(|thinking| thinking.get("budget_tokens").filter(|v| !v.is_null()).or_else(|| thinking.get("budgetTokens")))
        .and_then(|value| num(Some(value)));
    let window = num(payload.get("context_window").and_then(|window| window.get("context_window_size")))
        .filter(|window| *window != 0.0)
        .or_else(|| context_window_from_raw(world, &raw_model, model.as_deref()));
    let budget_positive = budget.filter(|budget| *budget > 0.0);
    // A present raw model alone is a route: when it is no Claude-family alias the model and provider stay
    // unset so the caller can map the requested model to a gateway target.
    if model.is_none() && raw_model.is_empty() && effort.is_none() && fast.is_none() && budget_positive.is_none() {
        return None;
    }
    let display = model.as_deref().map(|model| display_claude_model(world, Some(model), &raw_model, &clean(model_object.and_then(|object| object.get("display_name")))));
    Some(ClaudeRoute {
        mode: CLAUDE_CURRENT_MODE.into(),
        source: Some(source.into()),
        provider: model.as_ref().map(|_| "anthropic-oauth".into()),
        model,
        requested_model: some(raw_model),
        model_display: display,
        effort,
        fast,
        thinking_budget_tokens: budget_positive,
        context_window: window.filter(|window| *window > 0.0),
        thinking_enabled: None,
        at: now,
    })
}

/// `mergeRoute(base, next)`: `next` over `base`. A new requested model supersedes the base layer's provider,
/// model, display and window even when `next` left them unset (a non-Claude model awaiting a gateway target).
fn merge_route(base: Option<ClaudeRoute>, next: Option<ClaudeRoute>) -> Option<ClaudeRoute> {
    let Some(next) = next else { return base };
    let Some(base) = base else { return Some(next) };
    let next_requested = next.requested_model.clone().unwrap_or_default();
    let base_requested = base.requested_model.clone().unwrap_or_default();
    let supersedes = !next_requested.is_empty() && next_requested != base_requested;
    let pick = |next: Option<String>, base: Option<String>| if supersedes { next } else { next.or(base) };
    Some(ClaudeRoute {
        mode: if next.mode.is_empty() { base.mode } else { next.mode },
        source: next.source.or(base.source),
        provider: pick(next.provider, base.provider),
        model: pick(next.model, base.model),
        requested_model: next.requested_model.or(base.requested_model),
        model_display: pick(next.model_display, base.model_display),
        effort: next.effort.or(base.effort),
        fast: next.fast.or(base.fast),
        thinking_budget_tokens: next.thinking_budget_tokens.filter(|n| *n != 0.0).or(base.thinking_budget_tokens),
        context_window: if supersedes { next.context_window } else { next.context_window.filter(|n| *n != 0.0).or(base.context_window) },
        thinking_enabled: next.thinking_enabled.or(base.thinking_enabled),
        at: next.at,
    })
}

/// `routeFromSettings`.
fn route_from_settings(world: &dyn ClaudeWorld, settings: Option<&Value>, now: f64) -> Option<ClaudeRoute> {
    let settings = settings?.as_object()?;
    let fast = ["fastMode", "fast_mode", "fast"].iter().find_map(|key| settings.get(*key).filter(|v| !v.is_null()));
    let mut payload = Map::new();
    payload.insert("model".into(), Value::String(clean(settings.get("model"))));
    if let Some(level) = settings.get("effortLevel") {
        payload.insert("effortLevel".into(), level.clone());
    }
    if let Some(fast) = fast {
        payload.insert("fast_mode".into(), fast.clone());
    }
    let mut route = route_from_payload(world, Some(&Value::Object(payload)), "settings", now)?;
    route.thinking_enabled = Some(settings.get("alwaysThinkingEnabled") == Some(&Value::Bool(true)) || route.effort.is_some());
    Some(route)
}

/// A route as the data dir's own status file stores it (`own.mode === 'claude-current'` makes it a route as it
/// is): the fields it has, read as they were written.
fn route_from_stored(value: &Value) -> ClaudeRoute {
    let text = |key: &str| some(clean(value.get(key)));
    ClaudeRoute {
        mode: CLAUDE_CURRENT_MODE.into(),
        source: text("source"),
        provider: text("provider"),
        model: text("model"),
        requested_model: text("requestedModel"),
        model_display: text("modelDisplay"),
        effort: text("effort"),
        fast: value.get("fast").and_then(Value::as_bool),
        thinking_budget_tokens: num(value.get("thinkingBudgetTokens")).filter(|n| *n > 0.0),
        context_window: num(value.get("contextWindow")).filter(|n| *n > 0.0),
        thinking_enabled: value.get("thinkingEnabled").and_then(Value::as_bool),
        at: num(value.get("at")).unwrap_or(0.0),
    }
}

/// `readFreshJsonFile`'s age test: a file older than `max_age_ms` is not read.
fn fresh(file: Option<AgedFile<'_>>, now: f64, max_age_ms: f64) -> Option<&Value> {
    let file = file?;
    if max_age_ms.is_finite() && max_age_ms > 0.0 && now - file.mtime_ms > max_age_ms {
        return None;
    }
    Some(file.value)
}

/// `routeFromPersistedStatus(maxAgeMs)`.
fn route_from_persisted(world: &dyn ClaudeWorld, sources: &ClaudeSources<'_>) -> Option<ClaudeRoute> {
    let own = fresh(sources.own, sources.now, sources.max_age_ms);
    if let Some(own) = own.filter(|own| own.get("mode").and_then(Value::as_str) == Some(CLAUDE_CURRENT_MODE)) {
        return Some(route_from_stored(own));
    }
    route_from_payload(world, fresh(sources.last, sources.now, sources.max_age_ms), "cc-statusline-last", sources.now)
}

/// `readClaudeCodeCurrentRoute`: the route Claude Code is on. A route with no model at boot (`for_boot`) is
/// replaced by the default Opus: boot needs a concrete provider and model, where the request path keeps them
/// unset so the caller can map the requested model.
pub fn read_claude_code_current_route(world: &dyn ClaudeWorld, sources: &ClaudeSources<'_>) -> ClaudeRoute {
    let mut route = route_from_settings(world, sources.settings, sources.now);
    route = merge_route(route, route_from_persisted(world, sources));
    route = merge_route(route, route_from_payload(world, sources.request, "request", sources.now));
    let mut route = match route {
        Some(route) if !(sources.for_boot && route.model.is_none()) => route,
        _ => {
            let model = family_default_model(world, "opus");
            ClaudeRoute {
                mode: CLAUDE_CURRENT_MODE.into(),
                source: Some("default".into()),
                provider: Some("anthropic-oauth".into()),
                model_display: Some(display_claude_model(world, model.as_deref(), "opus[1m]", "")),
                model,
                requested_model: Some("opus".into()),
                effort: None,
                fast: Some(false),
                thinking_budget_tokens: None,
                context_window: Some(1_000_000.0),
                thinking_enabled: None,
                at: sources.now,
            }
        }
    };
    // The Claude OAuth provider only when a Claude-family model resolved.
    if route.model.is_some() && route.provider.is_none() {
        route.provider = Some("anthropic-oauth".into());
    }
    if route.model_display.is_none() {
        let raw = route.requested_model.clone().or_else(|| route.model.clone()).unwrap_or_default();
        route.model_display = some(display_claude_model(world, route.model.as_deref(), &raw, ""));
    }
    if route.context_window.is_none() {
        let raw = route.requested_model.clone().or_else(|| route.model.clone()).unwrap_or_default();
        route.context_window = context_window_from_raw(world, &raw, route.model.as_deref());
    }
    if route.fast.is_none() {
        route.fast = Some(false);
    }
    route
}

impl ClaudeRoute {
    /// The route as the JSON a consumer reads: unset fields are `null`.
    pub fn json(&self) -> Value {
        let text = |value: &Option<String>| value.clone().map_or(Value::Null, Value::String);
        let number = |value: Option<f64>| value.map_or(Value::Null, json_number);
        let mut out = Map::new();
        out.insert("mode".into(), Value::String(self.mode.clone()));
        out.insert("source".into(), text(&self.source));
        out.insert("provider".into(), text(&self.provider));
        out.insert("model".into(), text(&self.model));
        out.insert("requestedModel".into(), text(&self.requested_model));
        out.insert("modelDisplay".into(), text(&self.model_display));
        out.insert("effort".into(), text(&self.effort));
        out.insert("fast".into(), self.fast.map_or(Value::Null, Value::Bool));
        out.insert("thinkingBudgetTokens".into(), number(self.thinking_budget_tokens));
        out.insert("contextWindow".into(), number(self.context_window));
        if let Some(enabled) = self.thinking_enabled {
            out.insert("thinkingEnabled".into(), Value::Bool(enabled));
        }
        out.insert("at".into(), json_number(self.at));
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct World {
        roster: Vec<Value>,
        window: Option<f64>,
    }

    impl ClaudeWorld for World {
        fn context_window(&self, _model: &str) -> Option<f64> {
            self.window
        }
        fn roster(&self) -> Vec<Value> {
            self.roster.clone()
        }
        fn env(&self, _name: &str) -> Option<String> {
            None
        }
    }

    fn world() -> World {
        World { roster: Vec::new(), window: None }
    }

    fn sources<'a>() -> ClaudeSources<'a> {
        ClaudeSources { settings: None, own: None, last: None, request: None, max_age_ms: PERSISTED_MAX_AGE_MS, for_boot: false, now: 1_000_000.0 }
    }

    #[test]
    fn a_context_suffix_is_stripped_and_families_resolve_to_a_default() {
        let world = world();
        assert_eq!(strip_claude_context_suffix(&json!(" claude-opus-4-8[1m] ")), "claude-opus-4-8");
        assert_eq!(strip_claude_context_suffix(&json!("a[b]c]")), "a[b]c]");
        assert_eq!(resolve_claude_model_alias(&world, &json!("sonnet[1m]")).as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(resolve_claude_model_alias(&world, &json!("Opus_x")).as_deref(), Some("claude-opus-4-8"));
        assert_eq!(resolve_claude_model_alias(&world, &json!("fable")), None);
        assert_eq!(resolve_claude_model_alias(&world, &json!("gpt-5")), None);
    }

    #[test]
    fn the_newest_roster_model_of_a_family_beats_the_shipped_default() {
        let world = World {
            roster: vec![
                json!({ "id": "claude-opus-4-7", "releaseDate": "2026-01-01" }),
                json!({ "id": "claude-opus-4-9", "releaseDate": "2026-06-01" }),
                json!({ "id": "claude-sonnet-4-9", "created": 5 }),
            ],
            window: None,
        };
        assert_eq!(family_default_model(&world, "opus").as_deref(), Some("claude-opus-4-9"));
        assert_eq!(family_default_model(&world, "haiku").as_deref(), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn a_model_is_shown_by_family_and_version_with_its_window() {
        let world = world();
        assert_eq!(display_claude_model(&world, Some("claude-opus-4-8"), "opus[1m]", ""), "Opus 4.8 (1M context)");
        assert_eq!(display_claude_model(&world, Some("claude-sonnet-4-6-20251001"), "sonnet", ""), "Sonnet 4.6");
        assert_eq!(display_claude_model(&world, Some("claude-opus-5"), "opus", ""), "Opus 5");
        assert_eq!(display_claude_model(&world, Some("gpt-5"), "gpt-5", ""), "gpt-5");
        assert_eq!(display_claude_model(&world, None, "x", " Named "), "Named");
    }

    #[test]
    fn settings_persisted_status_and_request_layer_in_that_order() {
        let world = world();
        let settings = json!({ "model": "opus", "effortLevel": "high", "alwaysThinkingEnabled": true });
        let last = json!({ "model": { "id": "claude-sonnet-4-6" }, "thinking": { "type": "enabled", "budget_tokens": 4000 } });
        let mut sources = sources();
        sources.settings = Some(&settings);
        sources.last = Some(AgedFile { value: &last, mtime_ms: 999_000.0 });
        let route = read_claude_code_current_route(&world, &sources);
        assert_eq!((route.source.as_deref(), route.model.as_deref(), route.effort.as_deref()), (Some("cc-statusline-last"), Some("claude-sonnet-4-6"), Some("medium")));
        assert_eq!(route.thinking_budget_tokens, Some(4000.0));
        assert_eq!(route.thinking_enabled, Some(true));
        // A last status older than ten minutes is not read.
        sources.last = Some(AgedFile { value: &last, mtime_ms: 1.0 });
        let route = read_claude_code_current_route(&world, &sources);
        assert_eq!((route.source.as_deref(), route.model.as_deref(), route.effort.as_deref()), (Some("settings"), Some("claude-opus-4-8"), Some("high")));
        assert_eq!(route.model_display.as_deref(), Some("Opus 4.8"));
    }

    #[test]
    fn a_new_requested_model_keeps_the_base_route_from_bleeding_through() {
        let world = world();
        let settings = json!({ "model": "opus" });
        let request = json!({ "model": "mixdog/my-preset" });
        let mut sources = sources();
        sources.settings = Some(&settings);
        sources.request = Some(&request);
        let route = read_claude_code_current_route(&world, &sources);
        assert_eq!((route.requested_model.as_deref(), route.model.clone(), route.provider.clone()), (Some("mixdog/my-preset"), None, None));
        // At boot there is no request to map: the default Opus stands in.
        sources.for_boot = true;
        let route = read_claude_code_current_route(&world, &sources);
        assert_eq!((route.source.as_deref(), route.model.as_deref(), route.context_window), (Some("default"), Some("claude-opus-4-8"), Some(1_000_000.0)));
        assert_eq!(route.model_display.as_deref(), Some("Opus 4.8 (1M context)"));
    }

    #[test]
    fn nothing_known_is_the_default_route_and_mixdog_selections_are_told_apart() {
        let world = world();
        let route = read_claude_code_current_route(&world, &sources());
        assert_eq!((route.source.as_deref(), route.requested_model.as_deref(), route.fast), (Some("default"), Some("opus"), Some(false)));
        assert!(is_mixdog_model_selection(&json!(" Mixdog/x")));
        assert!(is_mixdog_model_selection(&json!({ "requestedModel": "mixdog/y", "model": "claude" })));
        assert!(!is_mixdog_model_selection(&json!({ "model": "claude" })));
    }

    #[test]
    fn the_own_status_file_is_a_route_as_it_is() {
        let world = world();
        let own = json!({ "mode": "claude-current", "provider": "anthropic-oauth", "model": "claude-haiku-4-5-20251001", "effort": "low", "fast": true });
        let mut sources = sources();
        sources.own = Some(AgedFile { value: &own, mtime_ms: 999_999.0 });
        let route = read_claude_code_current_route(&world, &sources);
        assert_eq!((route.model.as_deref(), route.effort.as_deref(), route.fast), (Some("claude-haiku-4-5-20251001"), Some("low"), Some(true)));
    }
}
