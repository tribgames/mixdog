//! `components/status-line/use-statusline-text.mjs`: the footer text a status line holds. An instant local line is shown
//! whenever the route, the theme or the first full render changes what is true, and a debounced full render replaces it;
//! the full line is rendered again on a refresh tick and whenever an input it reads changes (stale while refresh: the line
//! on screen is never blanked while the next one is computed).
//!
//! The hook is a React effect; here it is a machine driven by three calls: [`StatuslineText::update`] for a render of the
//! component (the effect runs when an input of its dependency list changed), [`StatuslineText::refresh_tick`] for the shared
//! tick that fires every [`StatuslineText::refresh_ms`], and [`StatuslineText::poll`] for the host's timer that fires at
//! [`StatuslineText::next_wake`]. The clock is the renderer's, so a test drives all of it with one fake clock.

use mixdog_js::number_to_string;
use mixdog_js::value_to_string;
use mixdog_tui_style::bridge::statusline_footer_identity_changed;
use mixdog_tui_widgets::statusline::LocalLineArgs;
use mixdog_tui_widgets::statusline::build_local_snap_line;
use mixdog_tui_widgets::statusline::normalize_status_line;
use mixdog_view_model::display::statusline_format::num;
use mixdog_view_model::display::statusline_format::time_ms;
use serde_json::Value;
use serde_json::json;

use super::render::RenderArgs;
use super::render::StatuslineRenderer;
use super::schedule::STATUSLINE_ACTIVE_REFRESH_MS;
use super::schedule::STATUSLINE_REFRESH_MS;
use super::schedule::STATUSLINE_RENDER_DEBOUNCE_MS;
use super::schedule::STATUSLINE_RETRY_FLOOR_MS;
use super::schedule::boot_full_render_delay_remaining_ms;
use super::schedule::first_text;
use super::schedule::has_active_statusline_work;
use super::schedule::truthy;

/// What the status line hook is given besides the render arguments.
#[derive(Clone, Debug, Default)]
pub struct FooterInputs {
    pub args: RenderArgs,
    /// Bumped when the terminal is resized, so the full line is rendered for the new width.
    pub resize_epoch: u64,
    /// Bumped when the set of agents changes.
    pub agent_revision: u64,
    /// Bumped when the theme changes, so the line is re-toned at once.
    pub theme_epoch: u64,
}

/// The inputs whose change runs the effect again (the dependency list of the hook, signatures standing for the objects).
#[derive(Clone, Debug, PartialEq)]
struct Deps {
    session_id: Option<String>,
    client_host_pid: Option<u64>,
    provider: String,
    model: String,
    effort: String,
    fast: bool,
    ultra: bool,
    cwd: String,
    stats: String,
    windows: [u64; 5],
    resize_epoch: u64,
    agent_revision: u64,
    workers: String,
    jobs: String,
    tools: String,
    refresh_tick: u64,
    theme_epoch: u64,
}

fn bits(value: f64) -> u64 {
    value.to_bits()
}

/// The `tag|stage|start` signature of each worker or job, so a new array with the same content does not run the effect.
fn entries_signature(entries: &[Value], tag_keys: &[&str], stage_keys: &[&str]) -> String {
    let start_keys = ["startedAt", "startTime", "createdAt"];
    entries
        .iter()
        .map(|entry| {
            let started = start_keys.iter().find_map(|key| entry.get(key).filter(|v| truthy(Some(v))));
            format!("{}|{}|{}", first_text(entry, tag_keys), first_text(entry, stage_keys), number_to_string(time_ms(started)))
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The numeric fields of the usage accumulator the footer reads, joined.
fn stats_signature(stats: Option<&Value>) -> String {
    let empty = json!({});
    let stats = stats.filter(|stats| stats.is_object()).unwrap_or(&empty);
    let n = |key: &str| number_to_string(num(stats.get(key)));
    let source = stats.get("currentContextSource").filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
    [
        n("currentContextTokens"),
        n("currentEstimatedContextTokens"),
        n("inputTokens"),
        n("latestInputTokens"),
        n("promptTokens"),
        n("turns"),
        n("contextTokens"),
        source,
    ]
    .join("|")
}

fn tools_signature(active_tools: Option<&Value>) -> String {
    let Some(tools) = active_tools.filter(|tools| truthy(Some(tools))) else { return String::new() };
    let search = tools.get("web_search");
    let field = |key: &str| {
        let n = search.and_then(|search| search.get(key)).map_or(f64::NAN, mixdog_js::to_number);
        if n.is_nan() || n == 0.0 { 0.0 } else { n }
    };
    [number_to_string(field("count")), number_to_string(field("startedAt"))].join("|")
}

/// The fields `statuslineFooterIdentityChanged` compares (the hook's `lastImmediateArgsRef` and the effect's `args`).
fn identity_args(inputs: &FooterInputs) -> Value {
    let args = &inputs.args;
    let mut object = serde_json::Map::new();
    object.insert("agentRevision".into(), json!(inputs.agent_revision));
    if let Some(session) = &args.session_id {
        object.insert("sessionId".into(), json!(session));
    }
    for (key, value) in [("provider", &args.provider), ("model", &args.model), ("effort", &args.effort)] {
        object.insert(key.into(), json!(value));
    }
    object.insert("fast".into(), json!(args.fast));
    object.insert("ultra".into(), json!(args.ultra));
    for (key, value) in [
        ("contextWindow", args.context_window),
        ("displayContextWindow", args.display_context_window),
        ("rawContextWindow", args.raw_context_window),
        ("compactBoundaryTokens", args.compact_boundary_tokens),
        ("autoCompactTokenLimit", args.auto_compact_token_limit),
    ] {
        object.insert(key.into(), mixdog_js::json_number(value));
    }
    if let Some(stats) = &args.stats {
        object.insert("stats".into(), stats.clone());
    }
    Value::Object(object)
}

/// The route of the previous run of the effect, to tell a route switch from other churn.
#[derive(Clone, Debug, PartialEq)]
struct RouteKey {
    session_id: Option<String>,
    provider: String,
    model: String,
    effort: String,
    fast: bool,
    ultra: bool,
}

impl RouteKey {
    fn of(args: &RenderArgs) -> Self {
        Self { session_id: args.session_id.clone(), provider: args.provider.clone(), model: args.model.clone(), effort: args.effort.clone(), fast: args.fast, ultra: args.ultra }
    }
}

/// The text of one footer.
pub struct StatuslineText {
    renderer: StatuslineRenderer,
    line: String,
    /// The inputs of the latest render of the component.
    inputs: FooterInputs,
    /// The arguments the effect captured when it last ran: its timers render with these.
    effect_args: RenderArgs,
    refresh_tick: u64,
    deps: Option<Deps>,
    boot_full_done: bool,
    mount_at: f64,
    last_raw_full_line: String,
    last_identity: Option<Value>,
    last_route: Option<RouteKey>,
    theme_epoch: u64,
    /// When the debounced full render of the current run of the effect fires.
    debounce_at: Option<f64>,
    /// When the effect is armed again to retry a boot full render that was not yet eligible.
    boot_retry_at: Option<f64>,
}

impl StatuslineText {
    /// The hook's first render: `initial_line` (a line saved by the previous footer) or the local boot line, toned for the
    /// theme. Nothing runs until [`Self::update`] arms the effect.
    pub fn new(renderer: StatuslineRenderer, inputs: &FooterInputs, initial_line: Option<&str>) -> Self {
        let now = renderer.now();
        let line = match initial_line.filter(|line| !line.is_empty()) {
            Some(initial) => normalize_status_line(initial),
            None => {
                // The boot line is built from the route alone: no session scope and no host pid.
                let shell = renderer.scoped_shell_jobs_status(0.0, None);
                build_local_snap_line(&local_args(&inputs.args, Some(&shell)), "", now)
            }
        };
        Self {
            renderer,
            line,
            inputs: inputs.clone(),
            effect_args: inputs.args.clone(),
            refresh_tick: 0,
            deps: None,
            boot_full_done: false,
            mount_at: now,
            last_raw_full_line: String::new(),
            last_identity: None,
            last_route: None,
            theme_epoch: inputs.theme_epoch,
            debounce_at: None,
            boot_retry_at: None,
        }
    }

    /// The line to paint.
    pub fn line(&self) -> &str {
        &self.line
    }

    /// The period of the shared refresh tick: faster while something runs.
    pub fn refresh_ms(&self) -> f64 {
        if has_active_statusline_work(&self.line, &self.inputs.args.agent_workers, &self.inputs.args.agent_jobs, self.inputs.args.active_tools.as_ref()) {
            STATUSLINE_ACTIVE_REFRESH_MS
        } else {
            STATUSLINE_REFRESH_MS
        }
    }

    /// The earliest time a timer of the machine fires; the host calls [`Self::poll`] then.
    pub fn next_wake(&self) -> Option<f64> {
        [self.debounce_at, self.boot_retry_at].into_iter().flatten().min_by(f64::total_cmp)
    }

    fn deps_of(&self, inputs: &FooterInputs) -> Deps {
        let args = &inputs.args;
        let pid = args.client_host_pid;
        Deps {
            session_id: args.session_id.clone(),
            client_host_pid: pid.map(bits),
            provider: args.provider.clone(),
            model: args.model.clone(),
            effort: args.effort.clone(),
            fast: args.fast,
            ultra: args.ultra,
            cwd: args.cwd.clone(),
            stats: stats_signature(args.stats.as_ref()),
            windows: [args.context_window, args.display_context_window, args.compact_boundary_tokens, args.auto_compact_token_limit, args.raw_context_window].map(bits),
            resize_epoch: inputs.resize_epoch,
            agent_revision: inputs.agent_revision,
            workers: entries_signature(&args.agent_workers, &["tag", "agent", "name"], &["stage", "status"]),
            jobs: entries_signature(&args.agent_jobs, &["tag", "agent", "name"], &["status", "stage"]),
            tools: tools_signature(args.active_tools.as_ref()),
            refresh_tick: self.refresh_tick,
            theme_epoch: inputs.theme_epoch,
        }
    }

    /// A render of the component with these inputs: the effect runs again when one of its dependencies changed.
    pub fn update(&mut self, inputs: &FooterInputs) {
        self.inputs = inputs.clone();
        let deps = self.deps_of(inputs);
        if self.deps.as_ref() == Some(&deps) {
            return;
        }
        self.deps = Some(deps);
        self.run_effect(inputs);
    }

    /// The shared tick fired: the effect runs again.
    pub fn refresh_tick(&mut self, inputs: &FooterInputs) {
        self.refresh_tick = (self.refresh_tick + 1) % 1_000_000;
        self.update(inputs);
    }

    fn run_effect(&mut self, inputs: &FooterInputs) {
        // The cleanup of the previous run: its timers never fire.
        self.debounce_at = None;
        self.boot_retry_at = None;
        let now = self.renderer.now();
        let identity = identity_args(inputs);
        let identity_changed = statusline_footer_identity_changed(Some(&identity), self.last_identity.as_ref());
        // A route switch (a different session, provider, model, effort, fast or ultra) is the only thing that invalidates the
        // cached full line and its quota segment: a context window that arrives with the first response, or an agent
        // turning over, only moves the context bar, and snapping to the quota-less local line for it made the quota blink.
        let route = RouteKey::of(&inputs.args);
        let route_changed = self.last_route.as_ref() != Some(&route);
        // A theme switch must re-tone the footer at once: the held line has the old palette, so normalising it again does
        // nothing. The local line is rebuilt, and the next full render is normalised again.
        let theme_changed = self.theme_epoch != inputs.theme_epoch;
        if theme_changed {
            self.theme_epoch = inputs.theme_epoch;
        }
        if route_changed {
            self.last_raw_full_line.clear();
            self.boot_full_done = false;
        }
        if theme_changed || !self.boot_full_done || identity_changed {
            let cached = if route_changed { "" } else { self.last_raw_full_line.as_str() };
            let shell = self.renderer.scoped_shell_jobs_status(inputs.args.client_host_pid.unwrap_or(0.0), inputs.args.session_id.as_deref());
            let next = build_local_snap_line(&local_args(&inputs.args, Some(&shell)), cached, now);
            if !next.is_empty() {
                self.line = next;
            }
        }
        self.last_identity = Some(identity);
        self.last_route = Some(route);
        self.effect_args = inputs.args.clone();
        self.debounce_at = Some(now + STATUSLINE_RENDER_DEBOUNCE_MS);
    }

    /// The host's timer fired: runs what is due.
    pub fn poll(&mut self) {
        let now = self.renderer.now();
        if self.boot_retry_at.is_some_and(|at| at <= now) {
            // The timer bumps the refresh tick, which runs the effect again: the debounce restarts.
            self.boot_retry_at = None;
            let inputs = self.inputs.clone();
            self.refresh_tick(&inputs);
        }
        if self.debounce_at.is_some_and(|at| at <= now) {
            self.debounce_at = None;
            self.render_full(now);
        }
    }

    fn render_full(&mut self, now: f64) {
        let args = self.effect_args.clone();
        if !self.boot_full_done {
            let remaining = boot_full_render_delay_remaining_ms(self.mount_at, now, &self.line, &args.agent_workers, &args.agent_jobs, args.active_tools.as_ref());
            if remaining > 0.0 {
                // Not eligible yet: a follow-up for the remaining boot delay keeps the first full render on schedule
                // instead of waiting for the next refresh tick.
                self.boot_retry_at = Some(now + remaining.max(STATUSLINE_RETRY_FLOOR_MS));
                return;
            }
        }
        let rendered = self.renderer.render(&args);
        self.last_raw_full_line.clone_from(&rendered);
        self.boot_full_done = true;
        let next = normalize_status_line(&rendered);
        if !next.is_empty() {
            self.line = next;
        }
    }
}

fn local_args<'a>(args: &'a RenderArgs, shell: Option<&'a Value>) -> LocalLineArgs<'a> {
    LocalLineArgs {
        model: &args.model,
        effort: &args.effort,
        fast: args.fast,
        ultra: args.ultra,
        stats: args.stats.as_ref(),
        context_window: args.context_window,
        display_context_window: args.display_context_window,
        raw_context_window: args.raw_context_window,
        agent_workers: &args.agent_workers,
        agent_jobs: &args.agent_jobs,
        active_tools: args.active_tools.as_ref(),
        shell_status: shell,
        terminal_columns: args.terminal_columns,
    }
}
