//! `renderStatusline` of `src/ui/statusline.mjs`: the footer text. The first row is the model, its effort and speed, the
//! context share with the way it was measured, and the provider quota segments; the second is what runs now (agents, shells,
//! a web search, the memory cycle). The text is built from the arguments and from three caches that a background job keeps:
//! the gateway status of the route, the provider's cached quota and the quota segments last shown.
//!
//! A render call never reads a file: it answers from the caches at once and, when one is due, hands its refresh to the
//! [`BackgroundRun`] (Node's `setImmediate`), at most one in flight per cache. That is what the first full render of a boot
//! depends on, so the render stays here, in the process that paints the footer, rather than a `statusline/read` round trip
//! per tick; the reads and the rules are those of `mixdog-core-session` (the service answers the same two values from the
//! same functions).

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_core_session::session::gateway_usage::RouteSection;
use mixdog_core_session::session::statusline_agents::LabelColours;
use mixdog_core_session::session::statusline_agents::Owner;
use mixdog_core_session::session::statusline_agents::active_hidden_agent_workers;
use mixdog_core_session::session::statusline_agents::agent_statusline_payload;
use mixdog_core_session::session::statusline_agents::agent_web_search_status;
use mixdog_core_session::session::statusline_agents::classify_agent_workers;
use mixdog_core_session::session::statusline_limits::LimitsInput;
use mixdog_core_session::session::statusline_limits::UsageView;
use mixdog_core_session::session::statusline_limits::agent_config_section;
use mixdog_core_session::session::statusline_limits::build_gateway_limits;
use mixdog_core_session::session::statusline_status::SegmentFormat;
use mixdog_core_session::session::statusline_status::format_gateway_limit_segments;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::number_to_string;
use mixdog_js::value_to_string;
use mixdog_view_model::display::context_measurement::measured_context_usage;
use mixdog_view_model::display::statusline_format::ModelSegment;
use mixdog_view_model::display::statusline_format::StatusStyle;
use mixdog_view_model::display::statusline_format::colour_pct;
use mixdog_view_model::display::statusline_format::epoch_ms_to_hhmm;
use mixdog_view_model::display::statusline_format::format_context_segment;
use mixdog_view_model::display::statusline_format::format_elapsed;
use mixdog_view_model::display::statusline_format::format_model_segment;
use mixdog_view_model::display::statusline_format::num;
use mixdog_view_model::display::statusline_format::terminal_columns;
use mixdog_view_model::display::statusline_segments::BackgroundRun;
use mixdog_view_model::display::statusline_segments::Clock;
use mixdog_view_model::display::statusline_segments::StatuslineSegments;
use mixdog_view_model::display::statusline_segments::unconfirmed_shell_count;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::files::DataDirSegments;
use super::files::StatusFiles;
use super::files::StatusRequest;
use super::host::StatusHost;
use super::host::StatusPaths;
use super::host::model_metadata;
use super::io::StatusIo;
use super::schedule::truthy;

/// The glyphs the L2 segments spin through, one step every [`L2_SPINNER_FRAME_MS`] (the worker spinner's dots, faster).
const WORKER_SPINNER_FRAMES: [&str; 10] = ["\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}", "\u{2826}", "\u{2827}", "\u{2807}", "\u{280f}"];
const L2_SPINNER_FRAME_MS: f64 = 120.0;
/// How long a cached gateway or fallback quota status is served without a refresh.
const GATEWAY_QUOTA_STATUS_CACHE_MS: f64 = 500.0;
const LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX: usize = 8;

/// What a render is built from (the store state the status line hook holds).
#[derive(Clone, Debug, Default)]
pub struct RenderArgs {
    pub session_id: Option<String>,
    /// The pid of the process that hosts the session; none: this process.
    pub client_host_pid: Option<f64>,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub fast: bool,
    pub ultra: bool,
    pub cwd: String,
    /// The session's usage accumulator (`createSessionStats()`), none for an empty one.
    pub stats: Option<Value>,
    pub context_window: f64,
    pub display_context_window: f64,
    pub raw_context_window: f64,
    pub compact_boundary_tokens: f64,
    pub auto_compact_token_limit: f64,
    pub agent_workers: Vec<Value>,
    pub agent_jobs: Vec<Value>,
    /// `{ web_search: { count, startedAt } }`.
    pub active_tools: Option<Value>,
    /// The terminal's width as it reports it (none when unknown: 120).
    pub terminal_columns: Option<f64>,
}

/// What a renderer reads and runs on.
pub struct RendererDeps {
    pub host: Arc<dyn StatusHost>,
    pub io: Arc<dyn StatusIo>,
    pub paths: StatusPaths,
    /// Runs a cache refresh off the render call.
    pub background: Arc<dyn BackgroundRun>,
    /// `Date.now()`.
    pub clock: Clock,
    pub style: StatusStyle,
    /// When this process started (epoch ms): a quota cached before it is a previous launch's.
    pub process_started_at_ms: f64,
}

struct StatusCache {
    key: String,
    route_key: String,
    at: f64,
    value: Option<Value>,
}

struct FallbackCache {
    key: String,
    at: f64,
    value: Option<Value>,
}

/// The quota segments last shown for a route, with the age and the owner of the reading they came from.
#[derive(Clone)]
struct Held {
    segments: Vec<String>,
    as_of: f64,
    owned: bool,
}

struct State {
    gateway: StatusCache,
    gateway_in_flight: bool,
    fallback: FallbackCache,
    fallback_in_flight: bool,
    /// The last non-empty quota segments per provider and route, least recently used first.
    held: Vec<(String, Held)>,
    /// The OAuth providers whose first confirmed usage of this process was seen (monotonic).
    armed: HashSet<String>,
    arm_in_flight: HashSet<String>,
    hidden_agents: Option<Vec<String>>,
}

struct Reads {
    usage: UsageView,
    route_section: RouteSection,
}

struct Inner {
    host: Arc<dyn StatusHost>,
    files: StatusFiles,
    background: Arc<dyn BackgroundRun>,
    clock: Clock,
    segments: Arc<StatuslineSegments>,
    style: StatusStyle,
    started_ms: f64,
    state: Mutex<State>,
    reads: Mutex<Reads>,
}

/// The footer text of one process.
#[derive(Clone)]
pub struct StatuslineRenderer {
    inner: Arc<Inner>,
}

fn pid_text(pid: f64) -> String {
    if pid == 0.0 || pid.is_nan() { String::new() } else { number_to_string(pid) }
}

fn clean(value: Option<&Value>) -> String {
    value.filter(|v| truthy(Some(v))).map(|v| js_trim(&value_to_string(v)).to_owned()).unwrap_or_default()
}

fn normalize_provider_id(provider: &str) -> String {
    js_to_lowercase(js_trim(provider))
}

/// `providerKindForQuota(provider)`.
fn provider_kind_for_quota(provider: &str) -> &'static str {
    let provider = js_to_lowercase(provider);
    if provider.contains("oauth") {
        "oauth"
    } else if provider == "mixdog-local" {
        "local"
    } else {
        "api"
    }
}

/// `gatewayStatusMatchesRoute(status, { provider, model })`: a status whose provider or model disagrees with the route is
/// not this route's quota.
fn status_matches_route(status: &Value, provider: &str, model: &str) -> bool {
    let (status_provider, status_model) = (clean(status.get("provider")), clean(status.get("model")));
    let (provider, model) = (js_trim(provider), js_trim(model));
    !(!provider.is_empty() && !status_provider.is_empty() && status_provider != provider) && !(!model.is_empty() && !status_model.is_empty() && status_model != model)
}

/// `isConfirmedCurrentProcessSnapshot(snapshot)`.
fn confirmed_current_process(snapshot: Option<&Value>, started_ms: f64) -> bool {
    snapshot.filter(|snapshot| snapshot.is_object()).map(|snapshot| num(snapshot.get("cachedAt"))).is_some_and(|cached_at| cached_at > 0.0 && cached_at >= started_ms)
}

/// `acceptQuotaSnapshot(held, incoming)`: a newer or own reading replaces the one shown; an older shared one does not, so
/// the quota does not flap when another instance overwrites the shared cache with an older snapshot.
fn accept_quota_snapshot(held: Option<&Held>, as_of: f64, owned: bool) -> bool {
    let Some(held) = held else { return true };
    if owned {
        return true;
    }
    if as_of == 0.0 || held.as_of == 0.0 {
        return true;
    }
    if held.owned { as_of > held.as_of } else { as_of >= held.as_of }
}

/// `mergeQuotaStatus(primary, fallback)`.
fn merge_quota_status(primary: Option<Value>, fallback: Option<Value>) -> Option<Value> {
    let Some(primary) = primary else { return fallback };
    let Some(fallback) = fallback else { return Some(primary) };
    let object = |value: &Value| value.as_object().cloned().unwrap_or_default();
    let (primary_map, fallback_map) = (object(&primary), object(&fallback));
    let windows = |map: &Map<String, Value>| map.get("quotaWindows").and_then(Value::as_array).cloned().unwrap_or_default();
    let use_primary = !windows(&primary_map).is_empty();
    let mut out = fallback_map.clone();
    out.extend(primary_map.clone());
    let source = if use_primary { &primary_map } else { &fallback_map };
    out.insert("quotaWindows".into(), Value::Array(windows(source)));
    out.insert("quotaWindowsAsOf".into(), json!(num(source.get("quotaWindowsAsOf"))));
    out.insert("quotaWindowsOwned".into(), json!(source.get("quotaWindowsOwned") == Some(&Value::Bool(true))));
    let either = |key: &str| {
        let value = [primary_map.get(key), fallback_map.get(key)].into_iter().flatten().find(|v| truthy(Some(v))).cloned();
        value.unwrap_or(Value::Null)
    };
    out.insert("balance".into(), either("balance"));
    out.insert("routeSpend".into(), either("routeSpend"));
    let kind = either("providerKind");
    let kind = if truthy(Some(&kind)) {
        kind
    } else {
        let provider = either("provider");
        json!(provider_kind_for_quota(&value_to_string(&provider)))
    };
    out.insert("providerKind".into(), kind);
    Some(Value::Object(out))
}

fn l2_spinner_frame(now: f64) -> &'static str {
    WORKER_SPINNER_FRAMES[((now / L2_SPINNER_FRAME_MS).floor() % WORKER_SPINNER_FRAMES.len() as f64) as usize]
}

impl StatuslineRenderer {
    pub fn new(deps: RendererDeps) -> Self {
        let source = Arc::new(DataDirSegments::new(Arc::clone(&deps.io), &deps.paths.data_dir));
        let segments = StatuslineSegments::new(source, Arc::clone(&deps.background), Arc::clone(&deps.clock));
        let state = State {
            gateway: StatusCache { key: String::new(), route_key: String::new(), at: 0.0, value: None },
            gateway_in_flight: false,
            fallback: FallbackCache { key: String::new(), at: 0.0, value: None },
            fallback_in_flight: false,
            held: Vec::new(),
            armed: HashSet::new(),
            arm_in_flight: HashSet::new(),
            hidden_agents: None,
        };
        let inner = Inner {
            host: deps.host,
            files: StatusFiles::new(deps.io, deps.paths),
            background: deps.background,
            clock: deps.clock,
            segments,
            style: deps.style,
            started_ms: deps.process_started_at_ms,
            state: Mutex::new(state),
            reads: Mutex::new(Reads { usage: UsageView::default(), route_section: RouteSection::default() }),
        };
        Self { inner: Arc::new(inner) }
    }

    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        (self.inner.clock)()
    }

    /// `shellJobsStatus({ clientHostPid, sessionId })`: the cache-only read of the shell jobs (the session's own when a scope
    /// is named, else the owner process's).
    pub fn shell_jobs_status(&self, client_host_pid: f64, session_id: Option<&str>) -> Value {
        self.inner.segments.shell_jobs_status(client_host_pid, session_id)
    }

    /// `shellJobsStatus` scoped as the footer scopes it: the session's own jobs whenever it names a session, the owner
    /// process's aggregate for a session-less caller.
    pub fn scoped_shell_jobs_status(&self, client_host_pid: f64, session_id: Option<&str>) -> Value {
        let scope = js_trim(session_id.unwrap_or_default());
        self.shell_jobs_status(client_host_pid, if scope.is_empty() { None } else { Some(scope) })
    }

    /// `renderStatusline(args)`: the footer text, one or two rows. When the render cannot run (a refresh job panicked and
    /// left a cache poisoned) the minimal line of the model and the context share stands in, as in Node on any error.
    pub fn render(&self, args: &RenderArgs) -> String {
        self.render_native(args).unwrap_or_else(|| self.fallback_line(args))
    }

    fn state(&self) -> Option<MutexGuard<'_, State>> {
        self.inner.state.lock().ok()
    }

    fn pid_of(args: &RenderArgs) -> f64 {
        args.client_host_pid.unwrap_or_else(|| f64::from(std::process::id()))
    }

    fn lookup<'a>(&'a self) -> impl Fn(&str, &str) -> Option<mixdog_view_model::display::statusline_format::ModelMetadata> + 'a {
        |model, provider| model_metadata(&*self.inner.host, model, provider)
    }

    fn model_segment(&self, args: &RenderArgs, cols: f64) -> String {
        let segment = ModelSegment { provider: &args.provider, model: &args.model, effort: &args.effort, fast: args.fast, ultra: args.ultra, cols };
        format_model_segment(self.inner.style, segment, &self.lookup())
    }

    fn context_pct(args: &RenderArgs, stats: &Value) -> Option<f64> {
        let usage = measured_context_usage(&json!({
            "stats": stats,
            "contextWindow": args.context_window,
            "displayContextWindow": args.display_context_window,
            "rawContextWindow": args.raw_context_window,
        }));
        usage.get("percent").and_then(Value::as_f64)
    }

    fn context_segment(&self, ctx_pct: Option<f64>, cols: f64, stats: &Value) -> String {
        let source = stats.get("currentContextSource").and_then(Value::as_str).unwrap_or("");
        format_context_segment(self.inner.style, ctx_pct, cols, source)
    }

    fn render_native(&self, args: &RenderArgs) -> Option<String> {
        let style = self.inner.style;
        let cols = terminal_columns(args.terminal_columns);
        let empty = json!({});
        let stats = args.stats.as_ref().filter(|stats| !stats.is_null()).unwrap_or(&empty);
        let gateway_status = self.load_gateway_quota_status(args, stats)?;
        let ctx_pct = Self::context_pct(args, stats);
        let sep = format!(" {}\u{2502}{} ", style.dim(), style.reset());
        let mut l1: Vec<String> = vec![self.model_segment(args, cols), self.context_segment(ctx_pct, cols, stats)];
        l1.extend(self.quota_segments_for(args, gateway_status, cols)?);
        let l1 = l1.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(&sep);
        let l1 = if l1.is_empty() { "mixdog".to_owned() } else { l1 };
        let l2 = self.activity_segments(args).join(&sep);
        Some(if l2.is_empty() { l1 } else { format!("{l1}\n{l2}") })
    }

    /// `fallbackLine(...)`.
    fn fallback_line(&self, args: &RenderArgs) -> String {
        let cols = terminal_columns(args.terminal_columns);
        let empty = json!({});
        let stats = args.stats.as_ref().filter(|stats| !stats.is_null()).unwrap_or(&empty);
        let ctx_pct = Self::context_pct(args, stats);
        let sep = format!(" {}\u{2502}{} ", self.inner.style.dim(), self.inner.style.reset());
        let parts: Vec<String> = [self.model_segment(args, cols), self.context_segment(ctx_pct, cols, stats)].into_iter().filter(|part| !part.is_empty()).collect();
        if parts.is_empty() { self.inner.style.status_subtle("> mixdog") } else { parts.join(&sep) }
    }

    /// `loadGatewayQuotaStatus(...)`: the cached gateway status of this route, refreshed off the render call. The outer
    /// `None` is a cache that cannot be read; the inner one a route with no status.
    fn load_gateway_quota_status(&self, args: &RenderArgs, stats: &Value) -> Option<Option<Value>> {
        let pid = Self::pid_of(args);
        let usage = measured_context_usage(&json!({ "stats": stats }));
        let used = usage.get("used").and_then(Value::as_f64);
        let finite = |n: f64| if n.is_finite() { n } else { 0.0 };
        let display = finite(args.display_context_window);
        let route_context_window = if display > 0.0 { display } else { finite(args.context_window) };
        let session_text = args.session_id.as_deref().filter(|id| !id.is_empty()).unwrap_or_default();
        let route_key = [args.provider.as_str(), args.model.as_str(), args.effort.as_str(), if args.fast { "fast" } else { "" }, session_text, &pid_text(pid)].join("\0");
        let key = [
            route_key.as_str(),
            &number_to_string(route_context_window),
            &number_to_string(args.raw_context_window),
            &number_to_string(args.auto_compact_token_limit),
            &number_to_string(((used.unwrap_or(0.0)) / 1024.0).floor()),
        ]
        .join("\0");
        let now = self.now();
        let kick = {
            let mut state = self.state()?;
            if state.gateway.key == key && now - state.gateway.at < GATEWAY_QUOTA_STATUS_CACHE_MS {
                return Some(state.gateway.value.clone());
            }
            let kick = !state.gateway_in_flight;
            state.gateway_in_flight = true;
            kick
        };
        if kick {
            let request = StatusRequest {
                session_id: args.session_id.clone().unwrap_or_default(),
                client_host_pid: pid,
                active_context_tokens: used,
                current_route: json!({
                    "provider": args.provider,
                    "model": args.model,
                    "effort": args.effort,
                    "fast": args.fast,
                    "contextWindow": route_context_window,
                    "rawContextWindow": args.raw_context_window,
                    "autoCompactTokenLimit": args.auto_compact_token_limit,
                }),
            };
            let (provider, model, job_key, job_route_key) = (args.provider.clone(), args.model.clone(), key, route_key.clone());
            let inner = Arc::clone(&self.inner);
            self.inner.background.run(Box::new(move || {
                let at = (inner.clock)();
                let status = inner.files.load_status(&*inner.host, &request, inner.started_ms, at);
                let value = status.filter(|status| status_matches_route(status, &provider, &model));
                let done = (inner.clock)();
                if let Ok(mut state) = inner.state.lock() {
                    state.gateway = StatusCache { key: job_key, route_key: job_route_key, at: done, value };
                    state.gateway_in_flight = false;
                }
            }));
        }
        let state = self.state()?;
        Some(if state.gateway.route_key == route_key { state.gateway.value.clone() } else { None })
    }

    /// `oauthUsageSegmentReady({ provider, model })`: for an OAuth route, whether this process has captured its first confirmed
    /// usage snapshot of the provider (a latch that stays on), so the quota segment turns on once and then holds. The check
    /// runs in the background; until it flips the latch the segment stays empty.
    fn oauth_usage_segment_ready(&self, provider: &str, model: &str) -> Option<bool> {
        let provider = normalize_provider_id(provider);
        if !provider.contains("oauth") {
            return Some(true);
        }
        let kick = {
            let mut state = self.state()?;
            if state.armed.contains(&provider) {
                return Some(true);
            }
            state.arm_in_flight.insert(provider.clone())
        };
        if kick {
            let route = json!({ "provider": provider, "model": js_trim(model), "providerKind": provider_kind_for_quota(&provider) });
            let inner = Arc::clone(&self.inner);
            self.inner.background.run(Box::new(move || {
                let snapshot = inner.host.cached_oauth_usage(&route, true);
                if let Ok(mut state) = inner.state.lock() {
                    if confirmed_current_process(snapshot.as_ref(), inner.started_ms) {
                        state.armed.insert(provider.clone());
                    }
                    state.arm_in_flight.remove(&provider);
                }
            }));
        }
        Some(false)
    }

    /// `fallbackQuotaStatus({ provider, model })`: the quota, balance and spend from the provider's cached usage, refreshed
    /// off the render call and never shown for another route.
    fn fallback_quota_status(&self, provider: &str, model: &str) -> Option<Option<Value>> {
        let provider = normalize_provider_id(provider);
        if provider.is_empty() {
            return Some(None);
        }
        let model = js_trim(model).to_owned();
        let cache_key = format!("{provider}\0{model}");
        let now = self.now();
        let kick = {
            let mut state = self.state()?;
            if state.fallback.key == cache_key && now - state.fallback.at < GATEWAY_QUOTA_STATUS_CACHE_MS {
                return Some(state.fallback.value.clone());
            }
            let kick = !state.fallback_in_flight;
            state.fallback_in_flight = true;
            kick
        };
        if kick {
            let (inner, job_key, job_provider) = (Arc::clone(&self.inner), cache_key.clone(), provider);
            self.inner.background.run(Box::new(move || {
                let route = json!({ "provider": job_provider, "model": model, "providerKind": provider_kind_for_quota(&job_provider) });
                let value = Self::fallback_quota_value(&inner, &route, &job_provider);
                let at = (inner.clock)();
                if let Ok(mut state) = inner.state.lock() {
                    state.fallback = FallbackCache { key: job_key, at, value };
                    state.fallback_in_flight = false;
                }
            }));
        }
        let state = self.state()?;
        Some(if state.fallback.key == cache_key { state.fallback.value.clone() } else { None })
    }

    /// `fallbackQuotaValue(routeInfo, provider)`: the quota, balance and spend the route reports, or none when it reports
    /// nothing worth a segment.
    fn fallback_quota_value(inner: &Inner, route: &Value, provider: &str) -> Option<Value> {
        let mut snapshot = if provider.contains("oauth") { inner.host.cached_oauth_usage(route, true) } else { None };
        // Boot guard: a usage cached before this process started is a previous launch's, so its windows are not shown.
        if let Some(snapshot) = snapshot.as_mut() {
            let cached_at = num(snapshot.get("cachedAt"));
            if cached_at == 0.0 || cached_at < inner.started_ms {
                if let Some(map) = snapshot.as_object_mut() {
                    map.insert("quotaWindows".into(), json!([]));
                }
            }
        }
        let now = (inner.clock)();
        let config = inner.files.config().unwrap_or_else(|| json!({}));
        let limits = {
            let mut reads = inner.reads.lock().ok()?;
            let reads = &mut *reads;
            let events = inner.files.usage_events(&mut reads.usage, now);
            let empty = json!({});
            let input = LimitsInput { gateway: config.get("gateway").unwrap_or(&empty), agent: agent_config_section(&config), events: &events, now };
            build_gateway_limits(&input, &mut reads.route_section, route, None, snapshot.as_ref())
        };
        let windows = limits.get("quotaWindows").cloned().unwrap_or(json!([]));
        let (balance, spend) = (limits.get("balance").cloned().unwrap_or(Value::Null), limits.get("routeSpend").cloned().unwrap_or(Value::Null));
        let has_windows = windows.as_array().is_some_and(|windows| !windows.is_empty());
        if !(has_windows || truthy(Some(&balance)) || truthy(Some(&spend))) {
            return None;
        }
        let mut out = route.as_object().cloned().unwrap_or_default();
        out.insert("quotaWindows".into(), windows);
        out.insert("quotaWindowsAsOf".into(), json!(num(snapshot.as_ref().and_then(|snapshot| snapshot.get("cachedAt")))));
        out.insert("quotaWindowsOwned".into(), json!(false));
        out.insert("balance".into(), if truthy(Some(&balance)) { balance } else { Value::Null });
        out.insert("routeSpend".into(), if truthy(Some(&spend)) { spend } else { Value::Null });
        Some(Value::Object(out))
    }

    /// `quotaSegmentsFor(...)`: the quota segments of the first row. For an OAuth route nothing shows until the process has
    /// its first confirmed usage; after that the last non-empty segments are held through a transient miss and are replaced
    /// only by a reading at least as fresh (or the instance's own).
    fn quota_segments_for(&self, args: &RenderArgs, gateway_status: Option<Value>, cols: f64) -> Option<Vec<String>> {
        let style = self.inner.style;
        let usage_ready = self.oauth_usage_segment_ready(&args.provider, &args.model)?;
        let quota_status = if usage_ready { merge_quota_status(gateway_status, self.fallback_quota_status(&args.provider, &args.model)?) } else { None };
        let now = self.now();
        let segments: Vec<String> = match &quota_status {
            Some(status) => {
                let colour = |pct: i64| colour_pct(style, pct as f64);
                let hhmm = |ms: f64| epoch_ms_to_hhmm(ms);
                let (dim, reset, green, yellow, red) = (style.dim(), style.reset(), style.green(), style.yellow(), style.red());
                let fmt = SegmentFormat { cols: cols as u32, dim: &dim, reset: &reset, green: &green, yellow: &yellow, red: &red, colour_pct: &colour, epoch_ms_to_hhmm: &hhmm, now };
                format_gateway_limit_segments(status, &fmt)
            }
            None => Vec::new(),
        };
        let provider = normalize_provider_id(&args.provider);
        let mut state = self.state()?;
        // Only a provider that armed the boot latch holds its segments; a non-OAuth route keeps its plain empty result.
        if !usage_ready || !state.armed.contains(&provider) {
            return Some(segments);
        }
        let hold_key = [provider.as_str(), js_trim(&args.model), js_trim(&args.effort), if args.fast { "fast" } else { "" }, args.session_id.as_deref().unwrap_or(""), &pid_text(Self::pid_of(args))].join("\0");
        let held = state.held.iter().find(|(key, _)| *key == hold_key).map(|(_, held)| held.clone());
        let held_segments = || held.as_ref().filter(|held| !held.segments.is_empty()).map(|held| held.segments.clone());
        if segments.is_empty() {
            return Some(held_segments().unwrap_or(segments));
        }
        let status = quota_status.as_ref();
        let as_of = num(status.and_then(|status| status.get("quotaWindowsAsOf")));
        let owned = status.and_then(|status| status.get("quotaWindowsOwned")) == Some(&Value::Bool(true));
        if accept_quota_snapshot(held.as_ref(), as_of, owned) {
            state.held.retain(|(key, _)| *key != hold_key);
            state.held.push((hold_key, Held { segments: segments.clone(), as_of, owned }));
            if state.held.len() > LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX {
                state.held.remove(0);
            }
            return Some(segments);
        }
        Some(held_segments().unwrap_or(segments))
    }

    /// `activitySegments(...)`: the second row, in the order running agents, running shells, web searching, memory.
    fn activity_segments(&self, args: &RenderArgs) -> Vec<String> {
        let style = self.inner.style;
        let pid = Self::pid_of(args);
        let session = args.session_id.as_deref().unwrap_or("");
        let owner_pid = (pid.floor() >= 1.0 && pid.is_finite()).then(|| pid.floor() as u64);
        let owner = Owner { session_id: session, client_host_pid: owner_pid };
        let hidden: Vec<String> = {
            let cached = self.state().and_then(|state| state.hidden_agents.clone());
            cached.unwrap_or_else(|| {
                let names = self.inner.host.hidden_agent_names();
                if let Some(mut state) = self.state() {
                    state.hidden_agents = Some(names.clone());
                }
                names
            })
        };
        let hidden_rows = active_hidden_agent_workers(&self.inner.host.agent_runtimes(), owner, &hidden);
        let mut workers = args.agent_workers.clone();
        let value_of = |value: &Option<Value>| value.clone().unwrap_or(Value::Null);
        workers.extend(hidden_rows.iter().map(|row| {
            json!({ "tag": row.tag, "agent": value_of(&row.agent), "status": "running", "stage": value_of(&row.stage),
                    "sessionId": value_of(&row.session_id), "provider": value_of(&row.provider), "model": value_of(&row.model) })
        }));
        let payload = agent_statusline_payload(&workers, &args.agent_jobs);
        let (green, reset, bold) = (style.green(), style.reset(), style.bold());
        let running = classify_agent_workers(&payload.workers, &LabelColours { green: &green, reset: &reset, bold: &bold }).running_workers;
        let shell = self.scoped_shell_jobs_status(pid, Some(session));
        let now = self.now();

        let dim = style.dim();
        let spin = format!("{green}{}{reset}", l2_spinner_frame(now));
        let segment = |label: &str, elapsed: &str| {
            let suffix = if elapsed.is_empty() { String::new() } else { format!(" {dim}\u{b7}{reset} {elapsed}") };
            format!("{spin} {bold}{label}{reset}{suffix}")
        };
        let mut parts: Vec<String> = Vec::new();
        if !running.is_empty() {
            let n = running.len();
            let oldest = running.iter().map(|worker| worker.started_at_ms).filter(|t| *t > 0.0).fold(f64::INFINITY, f64::min);
            let elapsed = if oldest.is_finite() { format_elapsed(now - oldest) } else { String::new() };
            parts.push(segment(&format!("Running {n} Agent{}", if n == 1 { "" } else { "s" }), &elapsed));
        }
        let unconfirmed = unconfirmed_shell_count(&shell);
        let shell_count = num(shell.get("count")) - unconfirmed as f64;
        if shell_count > 0.0 {
            let elapsed = shell.get("elapsedLabel").filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
            parts.push(segment(&format!("Running {} Shell{}", number_to_string(shell_count), if shell_count == 1.0 { "" } else { "s" }), &elapsed));
        }
        if unconfirmed > 0 {
            let yellow = style.yellow();
            parts.push(format!("{yellow}\u{26a0} {unconfirmed} Shell{} termination unconfirmed{reset} {dim}\u{b7}{reset} /shells", if unconfirmed == 1 { "" } else { "s" }));
        }
        let (searches, searching_since) = self.web_search_activity(args.active_tools.as_ref(), owner);
        if searches > 0.0 {
            let elapsed = if searching_since > 0.0 { format_elapsed(now - searching_since) } else { String::new() };
            parts.push(segment("Web Searching", &elapsed));
        }
        if let Some(memory) = self.inner.segments.memory_cycle_status().filter(|memory| memory.get("kind").and_then(Value::as_str) == Some("running")) {
            let elapsed = format_elapsed(now - num(memory.get("startedAt")));
            parts.push(segment("Memory", &elapsed));
        }
        parts
    }

    /// `webSearchActivity(activeTools, ...)`: the lead's own web searches plus those of its sub-sessions, and the earliest
    /// start of them.
    fn web_search_activity(&self, active_tools: Option<&Value>, owner: Owner<'_>) -> (f64, f64) {
        let info = active_tools.filter(|tools| tools.is_object()).and_then(|tools| tools.get("web_search")).filter(|info| truthy(Some(info)));
        let (agent_count, agent_start) = agent_web_search_status(&self.inner.host.agent_runtimes(), owner);
        let count = info.map_or(0.0, |info| num(info.get("count"))) + f64::from(agent_count);
        let starts = [info.map_or(0.0, |info| num(info.get("startedAt"))), agent_start];
        let start = starts.into_iter().filter(|start| *start > 0.0).fold(f64::INFINITY, f64::min);
        (count, if start.is_finite() { start } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_kind_follows_the_provider_name() {
        assert_eq!(provider_kind_for_quota("OpenAI-OAuth"), "oauth");
        assert_eq!(provider_kind_for_quota("mixdog-local"), "local");
        assert_eq!(provider_kind_for_quota("openai"), "api");
    }

    #[test]
    fn a_status_of_another_route_is_not_this_routes_quota() {
        let status = json!({ "provider": " openai ", "model": "gpt-5" });
        assert!(status_matches_route(&status, "openai", "gpt-5"));
        assert!(status_matches_route(&status, "", " gpt-5 "));
        assert!(!status_matches_route(&status, "anthropic", "gpt-5"));
        assert!(!status_matches_route(&status, "openai", "gpt-6"));
        assert!(status_matches_route(&json!({}), "openai", "gpt-6"));
    }

    #[test]
    fn only_a_reading_of_this_process_confirms_the_usage() {
        assert!(confirmed_current_process(Some(&json!({ "cachedAt": 10 })), 10.0));
        assert!(!confirmed_current_process(Some(&json!({ "cachedAt": 9 })), 10.0));
        assert!(!confirmed_current_process(Some(&json!({})), 0.0));
        assert!(!confirmed_current_process(None, 0.0));
    }

    #[test]
    fn an_older_shared_reading_does_not_replace_the_one_shown() {
        let held = |as_of: f64, owned: bool| Held { segments: vec!["x".into()], as_of, owned };
        assert!(accept_quota_snapshot(None, 1.0, false));
        assert!(accept_quota_snapshot(Some(&held(5.0, false)), 1.0, true));
        assert!(accept_quota_snapshot(Some(&held(5.0, false)), 0.0, false));
        assert!(accept_quota_snapshot(Some(&held(0.0, false)), 1.0, false));
        assert!(accept_quota_snapshot(Some(&held(5.0, false)), 5.0, false));
        assert!(!accept_quota_snapshot(Some(&held(5.0, false)), 4.0, false));
        assert!(!accept_quota_snapshot(Some(&held(5.0, true)), 5.0, false));
        assert!(accept_quota_snapshot(Some(&held(5.0, true)), 6.0, false));
    }

    #[test]
    fn the_primary_status_wins_the_merge_and_its_windows_carry_their_age() {
        let primary = json!({ "provider": "openai-oauth", "quotaWindows": [{ "label": "5H" }], "quotaWindowsAsOf": 7, "quotaWindowsOwned": true, "balance": null });
        let fallback = json!({ "quotaWindows": [{ "label": "7D" }], "quotaWindowsAsOf": 3, "balance": { "remainingUsd": 2 }, "routeSpend": { "costUsd": 1 } });
        let merged = merge_quota_status(Some(primary.clone()), Some(fallback.clone())).unwrap();
        assert_eq!(merged["quotaWindows"], json!([{ "label": "5H" }]));
        assert_eq!((merged["quotaWindowsAsOf"].clone(), merged["quotaWindowsOwned"].clone()), (json!(7.0), json!(true)));
        assert_eq!((merged["balance"].clone(), merged["routeSpend"].clone()), (json!({ "remainingUsd": 2 }), json!({ "costUsd": 1 })));
        assert_eq!(merged["providerKind"], "oauth");
        let empty_primary = json!({ "quotaWindows": [] });
        let merged = merge_quota_status(Some(empty_primary), Some(fallback.clone())).unwrap();
        assert_eq!((merged["quotaWindows"].clone(), merged["quotaWindowsAsOf"].clone(), merged["quotaWindowsOwned"].clone()), (json!([{ "label": "7D" }]), json!(3.0), json!(false)));
        assert_eq!(merge_quota_status(None, Some(fallback.clone())), Some(fallback));
        assert_eq!(merge_quota_status(Some(primary.clone()), None), Some(primary));
        assert_eq!(merge_quota_status(None, None), None);
    }

    #[test]
    fn the_spinner_steps_every_120_ms() {
        assert_eq!(l2_spinner_frame(0.0), WORKER_SPINNER_FRAMES[0]);
        assert_eq!(l2_spinner_frame(119.0), WORKER_SPINNER_FRAMES[0]);
        assert_eq!(l2_spinner_frame(120.0), WORKER_SPINNER_FRAMES[1]);
        assert_eq!(l2_spinner_frame(1200.0), WORKER_SPINNER_FRAMES[0]);
    }

    #[test]
    fn a_pid_of_zero_or_nan_is_empty_in_a_key() {
        assert_eq!(pid_text(0.0), "");
        assert_eq!(pid_text(f64::NAN), "");
        assert_eq!(pid_text(4242.0), "4242");
    }
}
