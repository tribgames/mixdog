//! The limits the statusline footer shows beside the model: provider usage windows, windows and a balance
//! the config declares (with the local USD spend over each window), and the spend of the current route
//! (`buildGatewayLimits` and what it reads of `vendor/statusline/src/gateway/route-meta.mjs`). The events
//! come from the usage store (`gateway-usage.local.jsonl`), read through [`UsageView`].

use mixdog_js::json_number;
use mixdog_js::math;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::gateway_usage::event;
use super::gateway_usage::event::RouteSection;
use super::gateway_usage::event::clean_string;
use super::gateway_usage::event::num;
use super::gateway_usage::event::round;
use super::gateway_usage::event::truthy;

const MAX_USAGE_EVENTS: usize = 5000;
const USAGE_EVENT_TTL_MS: f64 = 35.0 * 24.0 * 60.0 * 60_000.0;
const MINUTE_MS: f64 = 60_000.0;

/// The incrementally updated in-memory view of the JSONL usage store: a refresh reads only the bytes appended
/// since the last one, and a replaced (compacted) or truncated file is read again in full.
#[derive(Default)]
pub struct UsageView {
    id: Option<String>,
    offset: u64,
    events: Vec<Value>,
}

impl UsageView {
    /// `refreshUsageView`: brings the view up to the file of identity `id` and length `size` (`read(offset, len)` reads
    /// bytes of it; `None` is a read that failed, which leaves the view as it is). Only complete lines count.
    pub fn refresh(&mut self, id: &str, size: u64, read: impl FnOnce(u64, usize) -> Option<Vec<u8>>) -> &[Value] {
        if self.id.as_deref() != Some(id) || size < self.offset {
            *self = Self { id: Some(id.to_owned()), offset: 0, events: Vec::new() };
        }
        if size > self.offset
            && let Some(bytes) = read(self.offset, usize::try_from(size - self.offset).unwrap_or(usize::MAX))
        {
            let end = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
            if end > 0 {
                self.offset += end as u64;
                self.events.extend(parse_jsonl_events(&String::from_utf8_lossy(&bytes[..end])));
                if self.events.len() > MAX_USAGE_EVENTS * 2 {
                    self.events = self.events.split_off(self.events.len() - MAX_USAGE_EVENTS);
                }
            }
        }
        &self.events
    }

    /// A store that cannot be opened: the view is emptied (`usageView = { path: null, ... }`).
    pub fn lost(&mut self) {
        *self = Self::default();
    }

    /// `loadUsageEvents` over the refreshed view: the newest events inside the 35-day TTL.
    pub fn load(&self, now: f64) -> Vec<Value> {
        let start = self.events.len().saturating_sub(MAX_USAGE_EVENTS);
        let cutoff = now - USAGE_EVENT_TTL_MS;
        self.events[start..].iter().filter(|event| num(event.get("ts"), 0.0) >= cutoff).cloned().collect()
    }
}

/// `parseJsonlEvents`: the object lines; a torn line is skipped.
pub fn parse_jsonl_events(text: &str) -> Vec<Value> {
    text.split('\n')
        .filter(|line| !mixdog_js::js_trim(line).is_empty())
        .filter_map(|line| mixdog_js::json_parse(line).ok())
        .filter(|event| event.is_object() || event.is_array())
        .collect()
}

/// `agentConfigSection()`: the `agent` section of the config, whichever way it is nested.
pub fn agent_config_section(raw: &Value) -> &Value {
    match raw.get("agent") {
        Some(agent) if truthy(agent.get("providers")) => agent,
        _ => raw,
    }
}

/// What the limits read of the config and of the usage store.
pub struct LimitsInput<'a> {
    /// `readSection('gateway')`.
    pub gateway: &'a Value,
    /// `readSection('agent')`.
    pub agent: &'a Value,
    /// `loadUsageEvents()`.
    pub events: &'a [Value],
    /// `Date.now()`.
    pub now: f64,
}

/// `round(value, digits)` as the JSON number it serializes to (`null` for a non-finite value).
fn rounded(value: f64, digits: i32) -> Value {
    round(value, digits).map_or(Value::Null, json_number)
}

/// `entry.a ?? entry.b ?? ...`: the first key whose value is neither null nor undefined.
fn first_of<'a>(entry: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| entry.get(*key).filter(|value| !value.is_null()))
}

/// `num(first_of(..), NaN)`.
fn number_of(entry: &Value, keys: &[&str]) -> f64 {
    num(first_of(entry, keys), f64::NAN)
}

/// `labelForWindow(key, entry)`.
fn label_for_window(key: &str, entry: &Value) -> String {
    if let Some(explicit) = clean_string(entry.get("label")) {
        return explicit.to_uppercase();
    }
    let lower = mixdog_js::js_to_lowercase(key);
    let mut normalized = String::new();
    let mut separating = false;
    for c in lower.chars() {
        if c == '-' || mixdog_js::is_js_space(c) {
            if !separating {
                normalized.push('_');
            }
            separating = true;
        } else {
            normalized.push(c);
            separating = false;
        }
    }
    match normalized.as_str() {
        "five_hour" | "five_hours" | "5h" | "5_hour" => "5H".into(),
        "seven_day" | "seven_days" | "weekly" | "week" | "7d" | "7_day" => "7D".into(),
        "monthly" | "month" | "30d" | "30_day" => "M".into(),
        "daily" | "day" | "24h" | "24_hour" => "24H".into(),
        _ => if key.is_empty() { "USE".into() } else { key.to_uppercase() },
    }
}

/// `durationMsForWindow(key, entry)`.
fn duration_ms_for_window(key: &str, entry: &Value) -> f64 {
    let direct = num(first_of(entry, &["durationMs", "windowMs"]), 0.0);
    if direct > 0.0 {
        return direct;
    }
    let hours = num(first_of(entry, &["hours", "durationHours", "windowHours"]), 0.0);
    if hours > 0.0 {
        return hours * 60.0 * MINUTE_MS;
    }
    let days = num(first_of(entry, &["days", "durationDays", "windowDays"]), 0.0);
    if days > 0.0 {
        return days * 24.0 * 60.0 * MINUTE_MS;
    }
    match label_for_window(key, entry).as_str() {
        "5H" => 5.0 * 60.0 * MINUTE_MS,
        "7D" => 7.0 * 24.0 * 60.0 * MINUTE_MS,
        "24H" => 24.0 * 60.0 * MINUTE_MS,
        "M" => 30.0 * 24.0 * 60.0 * MINUTE_MS,
        _ => 0.0,
    }
}

/// `resetAtForWindow(key, entry)`: the reset the entry names (seconds are taken to milliseconds), else the end of
/// the window the clock is in.
fn reset_at_for_window(key: &str, entry: &Value, now: f64) -> Option<f64> {
    let n = num(first_of(entry, &["resetAt", "resetsAt", "reset_at", "resets_at"]), 0.0);
    if n > 0.0 {
        return Some(if n < 10_000_000_000.0 { n * 1000.0 } else { n });
    }
    let duration = duration_ms_for_window(key, entry);
    if duration <= 0.0 || duration.is_nan() {
        return None;
    }
    Some((now / duration).floor() * duration + duration)
}

/// `windowFromRaw(key, value)`: one provider or configured window, `None` when it says nothing.
fn window_from_raw(key: &str, value: &Value, now: f64) -> Option<Map<String, Value>> {
    let wrapped;
    let entry = if value.is_object() || value.is_array() {
        value
    } else {
        wrapped = json!({ "used_percentage": value });
        &wrapped
    };
    let cents = |name: &str| {
        let n = mixdog_js::to_number_of(entry.get(name)) / 100.0;
        if n.is_finite() { n } else { f64::NAN }
    };
    let or_cents = |keys: &[&str], name: &str| {
        let found = first_of(entry, keys).map(|value| num(Some(value), f64::NAN));
        found.unwrap_or_else(|| cents(name))
    };
    let used_pct = number_of(entry, &["usedPct", "used_percentage", "percent", "used_percent", "percentage"]);
    let limit_usd = or_cents(&["limitUsd", "limit_usd", "budgetUsd", "budget_usd"], "limit_usd_cents");
    let used_usd = or_cents(&["usedUsd", "used_usd", "spendUsd", "spend_usd", "costUsd", "cost_usd"], "used_usd_cents");
    let remaining_usd = or_cents(&["remainingUsd", "remaining_usd", "leftUsd", "left_usd", "balanceUsd", "balance_usd"], "remaining_usd_cents");
    let mut out = Map::new();
    out.insert("label".into(), json!(label_for_window(key, entry)));
    out.insert("source".into(), json!(clean_string(entry.get("source")).unwrap_or_else(|| "provider".into())));
    for (name, value, digits) in [("usedPct", used_pct, 2), ("limitUsd", limit_usd, 4), ("usedUsd", used_usd, 4), ("remainingUsd", remaining_usd, 4)] {
        if value.is_finite()
            && let Some(rounded) = round(value, digits)
        {
            out.insert(name.into(), json_number(rounded));
        }
    }
    if let Some(reset) = reset_at_for_window(key, entry, now).filter(|reset| *reset != 0.0) {
        out.insert("resetAt".into(), json_number(reset));
    }
    (out.len() > 2).then_some(out)
}

/// `normaliseWindowsFromObject(obj)`: an array's entries (keyed by their `id`, `name`, `label` or position) or an
/// object's members, as windows.
fn windows_from_object(object: Option<&Value>, now: f64) -> Vec<Map<String, Value>> {
    match object {
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let named = ["id", "name", "label"].iter().find_map(|key| entry.get(*key).filter(|v| truthy(Some(v))));
                // The position stands in as the key when no name does; position 0 is falsy there (`String(0 || 'USE')`).
                let key = named.map_or_else(|| if index == 0 { String::new() } else { index.to_string() }, value_to_string);
                window_from_raw(&key, entry, now)
            })
            .collect(),
        Some(Value::Object(members)) => members.iter().filter_map(|(key, value)| window_from_raw(key, value, now)).collect(),
        _ => Vec::new(),
    }
}

/// `a || b || ...`: the first truthy member.
fn first_truthy<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key).filter(|member| truthy(Some(member))))
}

/// `rawUsageWindows(rawUsage)`: the windows a provider's raw usage reports.
pub fn raw_usage_windows(raw: Option<&Value>, now: f64) -> Vec<Map<String, Value>> {
    let Some(raw) = raw.filter(|raw| raw.is_object() || raw.is_array()) else { return Vec::new() };
    let direct = first_truthy(raw, &["quotaWindows", "quota_windows", "usageWindows", "usage_windows"]);
    let rate = first_truthy(raw, &["rate_limits", "rateLimits"]);
    let quota = first_truthy(raw, &["quota", "quotas", "limits", "budgets"]);
    [direct, rate, quota].into_iter().flat_map(|part| windows_from_object(part, now)).collect()
}

/// `providerSection(provider)`.
fn provider_section<'a>(input: &'a LimitsInput<'_>, provider: &str) -> Option<&'a Value> {
    agent_config_section(input.agent).get("providers")?.get(provider).filter(|section| section.is_object())
}

/// The route's provider as text, `None` when it has none (`routeInfo?.provider`).
fn route_provider(route: &Value) -> Option<&str> {
    route.get("provider").filter(|provider| truthy(Some(provider))).and_then(Value::as_str)
}

/// `configuredWindows(routeInfo)`: the windows the gateway and the route's provider declare in the config.
fn configured_windows(input: &LimitsInput<'_>, route: &Value) -> Vec<Map<String, Value>> {
    let provider = route_provider(route).and_then(|provider| provider_section(input, provider));
    let from = |section: Option<&Value>| {
        let found = section.and_then(|section| first_truthy(section, &["quotaWindows", "usageWindows"]));
        windows_from_object(found, input.now)
    };
    let mut windows = from(Some(input.gateway));
    windows.extend(from(provider));
    windows
}

fn event_matches(event: &Value, route: &Value, model_too: bool) -> bool {
    let same = |key: &str| !truthy(route.get(key)) || event.get(key) == route.get(key);
    same("provider") && (!model_too || same("model"))
}

fn cost_since(events: &[&Value], since: f64) -> f64 {
    events.iter().filter(|event| num(event.get("ts"), 0.0) >= since).map(|event| num(event.get("costUsd"), 0.0)).sum()
}

/// `applyLocalSpend(windows, routeInfo)`: a window with a USD limit is measured against the local spend of the
/// route's provider and model over the window.
fn apply_local_spend(input: &LimitsInput<'_>, windows: Vec<Map<String, Value>>, route: &Value) -> Vec<Map<String, Value>> {
    if windows.is_empty() {
        return Vec::new();
    }
    let events: Vec<&Value> = input.events.iter().filter(|event| event_matches(event, route, true)).collect();
    windows
        .into_iter()
        .map(|window| {
            let mut next = window;
            let view = Value::Object(next.clone());
            let label = view.get("label").and_then(Value::as_str).unwrap_or_default().to_owned();
            let duration = duration_ms_for_window(&label, &view);
            let since = if duration > 0.0 { input.now - duration } else { 0.0 };
            let used = cost_since(&events, since);
            let limit = num(view.get("limitUsd"), 0.0);
            if limit > 0.0 {
                let put = |next: &mut Map<String, Value>, key: &str, value: Option<f64>| {
                    next.insert(key.into(), value.map_or(Value::Null, json_number));
                };
                put(&mut next, "usedUsd", round(used, 4));
                put(&mut next, "remainingUsd", round(math::max(0.0, limit - used), 4));
                put(&mut next, "usedPct", round(math::min(100.0, used * 100.0 / limit), 2));
                if !truthy(view.get("source")) {
                    next.insert("source".into(), json!("local-budget"));
                }
                if !truthy(view.get("resetAt")) {
                    next.insert("resetAt".into(), reset_at_for_window(&label, &view, input.now).map_or(Value::Null, json_number));
                }
            }
            next
        })
        .collect()
}

/// `configuredBalance(routeInfo)`: the budget the config declares for the gateway or the provider, with what the
/// provider's events spent of it over the period.
fn configured_balance(input: &LimitsInput<'_>, route: &Value) -> Option<Value> {
    let provider = route_provider(route).and_then(|provider| provider_section(input, provider));
    let raw = [Some(input.gateway), provider]
        .into_iter()
        .flatten()
        .flat_map(|section| ["balance", "budget"].into_iter().map(move |key| section.get(key)))
        .flatten()
        .find(|member| truthy(Some(member)))
        .filter(|raw| raw.is_object() || raw.is_array())?;
    let budget = number_of(raw, &["budgetUsd", "limitUsd", "monthlyUsd", "amountUsd"]);
    if !budget.is_finite() {
        return None;
    }
    let events: Vec<&Value> = input.events.iter().filter(|event| event_matches(event, route, false)).collect();
    let period = clean_string(raw.get("period")).unwrap_or_else(|| "30d".into());
    let duration = Some(duration_ms_for_window(&period, raw)).filter(|duration| *duration != 0.0).unwrap_or(30.0 * 24.0 * 60.0 * MINUTE_MS);
    let spent = cost_since(&events, input.now - duration);
    Some(json!({
        "source": "local-budget",
        "period": period,
        "budgetUsd": rounded(budget, 4),
        "spentUsd": rounded(spent, 4),
        "remainingUsd": rounded(math::max(0.0, budget - spent), 4),
    }))
}

/// `localRouteSpend(routeInfo)`: the SESS segment for an API provider: what the current route has spent since its
/// identity last changed.
fn local_route_spend(input: &LimitsInput<'_>, section: &mut RouteSection, route: &Value) -> Option<Value> {
    let kind = if truthy(route.get("providerKind")) { value_to_string(&route["providerKind"]) } else { event::provider_kind(route.get("provider")).to_owned() };
    if kind != "api" && kind != "quota-api" {
        return None;
    }
    let started_at = event::ensure_route_section(section, route, input.now as i64);
    if started_at == 0 {
        return None;
    }
    let key = event::route_identity_key(route);
    let cost: f64 = input
        .events
        .iter()
        .filter(|event| event_matches(event, route, true))
        .filter(|event| !truthy(event.get("routeKey")) || event.get("routeKey").and_then(Value::as_str) == Some(key.as_str()))
        .filter(|event| num(event.get("ts"), 0.0) >= started_at as f64)
        .map(|event| num(event.get("costUsd"), 0.0))
        .sum();
    if cost <= 0.0 || cost.is_nan() {
        return None;
    }
    Some(json!({ "label": "SESS", "source": "local-route", "period": "session", "startedAt": started_at, "costUsd": rounded(cost, 6) }))
}

/// `buildGatewayLimits(routeInfo, providerOut, usageSnapshot)`: the provider's own windows, else the snapshot's,
/// else the configured ones with the local spend; the snapshot's balance, else the configured one; the route spend.
pub fn build_gateway_limits(input: &LimitsInput<'_>, section: &mut RouteSection, route: &Value, provider_out: Option<&Value>, usage_snapshot: Option<&Value>) -> Value {
    let raw = provider_out.and_then(|out| out.get("usage")).and_then(|usage| usage.get("raw"));
    let provider_windows = raw_usage_windows(raw, input.now);
    let snapshot_windows: Vec<Value> = usage_snapshot.and_then(|snapshot| snapshot.get("quotaWindows")).and_then(Value::as_array).cloned().unwrap_or_default();
    let configured = apply_local_spend(input, configured_windows(input, route), route);
    let quota_windows: Vec<Value> = if !provider_windows.is_empty() {
        provider_windows.into_iter().map(Value::Object).collect()
    } else if !snapshot_windows.is_empty() {
        snapshot_windows
    } else {
        configured.into_iter().map(Value::Object).collect()
    };
    let balance = usage_snapshot.and_then(|snapshot| snapshot.get("balance")).filter(|balance| truthy(Some(balance))).cloned().or_else(|| configured_balance(input, route));
    let route_spend = local_route_spend(input, section, route);
    json!({ "quotaWindows": quota_windows, "balance": balance, "routeSpend": route_spend })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_800_000_000_000.0;

    fn input<'a>(gateway: &'a Value, agent: &'a Value, events: &'a [Value]) -> LimitsInput<'a> {
        LimitsInput { gateway, agent, events, now: NOW }
    }

    #[test]
    fn provider_windows_are_read_from_every_shape_the_raw_usage_uses() {
        let raw = json!({
            "rate_limits": { "five_hour": { "used_percentage": 41.256, "resets_at": 1_800_003_600 }, "seven-day": 7 },
            "quota": [{ "id": "daily", "usedUsd": "1.5", "limit_usd_cents": 500 }, { "x": 1 }],
        });
        let windows = raw_usage_windows(Some(&raw), NOW);
        assert_eq!(windows.len(), 3);
        assert_eq!(
            Value::Object(windows[0].clone()),
            json!({ "label": "5H", "source": "provider", "usedPct": 41.26, "resetAt": 1_800_003_600_000_i64 })
        );
        assert_eq!(windows[1]["label"], "7D");
        assert_eq!(windows[1]["usedPct"], 7);
        assert_eq!((windows[2]["label"].clone(), windows[2]["usedUsd"].clone(), windows[2]["limitUsd"].clone()), (json!("24H"), json!(1.5), json!(5)));
        assert_eq!(windows[1]["resetAt"], json!(((NOW / (7.0 * 86_400_000.0)).floor() * 7.0 * 86_400_000.0 + 7.0 * 86_400_000.0) as i64));
        assert!(raw_usage_windows(None, NOW).is_empty());
    }

    #[test]
    fn a_configured_window_is_measured_against_the_local_spend_of_its_route() {
        let gateway = json!({ "quotaWindows": { "daily": { "limitUsd": 10 } } });
        let agent = json!({ "agent": { "providers": { "openai": { "usageWindows": [{ "label": "week", "limit_usd": 100 }] } } } });
        let events = [
            json!({ "ts": NOW - 1000.0, "provider": "openai", "model": "gpt-5", "costUsd": 2.5 }),
            json!({ "ts": NOW - 2.0 * 86_400_000.0, "provider": "openai", "model": "gpt-5", "costUsd": 4 }),
            json!({ "ts": NOW - 1000.0, "provider": "other", "model": "gpt-5", "costUsd": 99 }),
        ];
        let route = json!({ "provider": "openai", "model": "gpt-5" });
        let mut section = RouteSection::default();
        let limits = build_gateway_limits(&input(&gateway, &agent, &events), &mut section, &route, None, None);
        let windows = limits["quotaWindows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0]["label"].clone(), windows[0]["usedUsd"].clone(), windows[0]["remainingUsd"].clone(), windows[0]["usedPct"].clone()), (json!("24H"), json!(2.5), json!(7.5), json!(25)));
        assert_eq!((windows[1]["label"].clone(), windows[1]["usedUsd"].clone(), windows[1]["usedPct"].clone()), (json!("WEEK"), json!(6.5), json!(6.5)));
        assert!(windows[0]["resetAt"].as_f64().unwrap() > NOW);
        assert_eq!(limits["balance"], Value::Null);
    }

    #[test]
    fn the_snapshot_beats_configured_windows_and_the_provider_beats_the_snapshot() {
        let gateway = json!({ "quotaWindows": { "daily": { "limitUsd": 10 } }, "balance": { "budgetUsd": 20, "period": "7d" } });
        let events = [json!({ "ts": NOW - 5000.0, "provider": "openai", "costUsd": 5 })];
        let route = json!({ "provider": "openai", "model": "gpt-5" });
        let snapshot = json!({ "quotaWindows": [{ "label": "SNAP" }], "balance": { "remainingUsd": 3 } });
        let empty = json!({});
        let mut section = RouteSection::default();
        let limits = build_gateway_limits(&input(&gateway, &empty, &events), &mut section, &route, None, Some(&snapshot));
        assert_eq!((limits["quotaWindows"].clone(), limits["balance"].clone()), (json!([{ "label": "SNAP" }]), json!({ "remainingUsd": 3 })));
        let out = json!({ "usage": { "raw": { "quotaWindows": { "5h": { "percent": 10 } } } } });
        let limits = build_gateway_limits(&input(&gateway, &empty, &events), &mut section, &route, Some(&out), None);
        assert_eq!(limits["quotaWindows"][0]["label"], "5H");
        assert_eq!(
            limits["balance"],
            json!({ "source": "local-budget", "period": "7d", "budgetUsd": 20, "spentUsd": 5, "remainingUsd": 15 })
        );
    }

    #[test]
    fn an_api_route_reports_its_spend_since_the_route_identity_changed() {
        let events = [
            json!({ "ts": NOW - 50_000.0, "provider": "deepseek", "model": "m", "routeKey": "deepseek\u{1}m\u{1}\u{1}", "costUsd": 1 }),
            json!({ "ts": NOW - 10_000.0, "provider": "deepseek", "model": "m", "routeKey": "deepseek\u{1}m\u{1}\u{1}", "costUsd": 0.5 }),
            json!({ "ts": NOW - 10_000.0, "provider": "deepseek", "model": "m", "routeKey": "other", "costUsd": 9 }),
        ];
        let (gateway, agent) = (json!({}), json!({}));
        let route = json!({ "provider": "deepseek", "model": "m" });
        let mut section = RouteSection::default();
        // The section starts now: nothing was spent in it yet.
        let first = build_gateway_limits(&input(&gateway, &agent, &events), &mut section, &route, None, None);
        assert_eq!(first["routeSpend"], Value::Null);
        let mut later = input(&gateway, &agent, &events);
        later.now = NOW;
        section = RouteSection::default();
        event::ensure_route_section(&mut section, &route, (NOW - 20_000.0) as i64);
        let spend = build_gateway_limits(&later, &mut section, &route, None, None);
        assert_eq!(spend["routeSpend"], json!({ "label": "SESS", "source": "local-route", "period": "session", "startedAt": (NOW - 20_000.0) as i64, "costUsd": 0.5 }));
        // An OAuth route tracks no dollars.
        let oauth = json!({ "provider": "openai-oauth", "model": "m" });
        assert_eq!(build_gateway_limits(&later, &mut section, &oauth, None, None)["routeSpend"], Value::Null);
    }

    #[test]
    fn the_usage_view_reads_only_what_was_appended_and_starts_over_when_the_file_is_replaced() {
        let mut view = UsageView::default();
        let first = b"{\"ts\":1}\n{\"ts\":2}\n{\"ts\":3";
        assert_eq!(view.refresh("a", first.len() as u64, |offset, len| Some(first[offset as usize..][..len].to_vec())).len(), 2);
        let grown = b"{\"ts\":1}\n{\"ts\":2}\n{\"ts\":3}\n";
        assert_eq!(view.refresh("a", grown.len() as u64, |offset, len| {
            assert_eq!(offset, 18);
            Some(grown[offset as usize..][..len].to_vec())
        }).len(), 3);
        // A shorter file is a compaction: it is read again from the start.
        let compacted = b"{\"ts\":3}\n";
        assert_eq!(view.refresh("a", compacted.len() as u64, |offset, len| Some(compacted[offset as usize..][..len].to_vec())).len(), 1);
        view.lost();
        assert!(view.load(NOW).is_empty());
        assert_eq!(parse_jsonl_events("{\"a\":1}\n torn\n\n[1]\n7\n").len(), 2);
    }

    #[test]
    fn events_older_than_thirty_five_days_are_not_loaded() {
        let mut view = UsageView::default();
        let text = format!("{{\"ts\":{}}}\n{{\"ts\":{}}}\n", NOW - 36.0 * 86_400_000.0, NOW - 1.0);
        view.refresh("a", text.len() as u64, |_, _| Some(text.clone().into_bytes()));
        assert_eq!(view.load(NOW).len(), 1);
    }
}
