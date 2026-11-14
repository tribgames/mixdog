//! The state a server window shows for its link to the daemon, and the probe loop behind it. The tunnel and the service client
//! each recover on their own; this owns what the user sees (connected, reconnecting with the attempt and its countdown, lost,
//! paused for sleep) and nudges both layers so an attempt really happens when the countdown says so.
//!
//! Timers are `mixdog_rt::time` timers, so a paused or virtual clock moves them. The machine does not touch windows: its view is
//! a `watch` channel a forwarder reads.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_rt::TaskClass;
use mixdog_rt::time::Instant;
use mixdog_rt::time::MissedTickBehavior;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// App-level health probe through the tunnel while connected.
pub const HEALTH_INTERVAL_MS: u64 = 15_000;
pub const HEALTH_TIMEOUT_MS: u64 = 5_000;
/// This many failed probes inside [`FAILURE_WINDOW_MS`] replace the tunnel's ssh child.
pub const FAILURES_TO_REPLACE: usize = 3;
pub const FAILURE_WINDOW_MS: u64 = 60_000;
/// A link that stayed healthy this long starts its backoff over.
pub const STABLE_RESET_MS: u64 = 60_000;
/// After sleep the link is probed this many times before it is called dead.
const RESUME_PROBE_ATTEMPTS: usize = 2;
pub const RECONNECT_BASE_DELAY_MS: u64 = 1_000;
pub const RECONNECT_MAX_DELAY_MS: u64 = 30_000;
/// How long the server keeps an idle daemon for a remote client that went away, when `MIXDOG_REMOTE_CLIENT_GRACE_MS` is not set.
pub const REMOTE_CLIENT_GRACE_DEFAULT_MS: u64 = 1_800_000;
/// Attempts that must still fit inside the grace window at the longest delay.
const ATTEMPTS_INSIDE_GRACE: u64 = 6;

/// The grace the server applies: the configured value, or its default.
pub fn remote_client_grace_ms(configured: Option<&str>) -> u64 {
    configured
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map_or(REMOTE_CLIENT_GRACE_DEFAULT_MS, |value| value as u64)
}

/// A host's own grace setting (minutes) in ms; `None` when it has none, so the server's configured or default grace applies.
pub fn host_grace_ms(grace_minutes: Option<f64>) -> Option<u64> {
    grace_minutes.filter(|minutes| minutes.is_finite() && *minutes > 0.0).map(|minutes| (minutes * 60_000.0).round() as u64)
}

/// The longest wait between attempts: capped, and short enough that several attempts land while the server still keeps the daemon
/// for this client.
pub fn reconnect_delay_cap_ms(grace_ms: u64) -> u64 {
    RECONNECT_BASE_DELAY_MS.max(RECONNECT_MAX_DELAY_MS.min(grace_ms / ATTEMPTS_INSIDE_GRACE))
}

/// Exponential delays up to the cap; the ladder starts over once the link stayed healthy for the stable-reset time.
#[derive(Debug)]
pub struct ReconnectLadder {
    cap_ms: u64,
    attempt: u32,
    healthy_since: Option<u64>,
}

impl ReconnectLadder {
    pub fn new(cap_ms: u64) -> Self {
        Self { cap_ms, attempt: 0, healthy_since: None }
    }

    /// The next attempt's number and the wait before it; `now_ms` is the machine's clock.
    pub fn next(&mut self, now_ms: u64) -> (u32, u64) {
        if self.healthy_since.is_some_and(|since| now_ms.saturating_sub(since) >= STABLE_RESET_MS) {
            self.attempt = 0;
        }
        self.healthy_since = None;
        self.attempt += 1;
        let delay = RECONNECT_BASE_DELAY_MS.saturating_mul(1u64 << (self.attempt - 1).min(16));
        (self.attempt, delay.min(self.cap_ms))
    }

    pub fn mark_healthy(&mut self, now_ms: u64) {
        if self.healthy_since.is_none() {
            self.healthy_since = Some(now_ms);
        }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
        self.healthy_since = None;
    }
}

/// The failure that stopped the connection for good, or the ssh side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkFailure {
    pub code: String,
    pub message: String,
    pub settings_required: bool,
}

/// What the layers under the machine do for it.
#[async_trait::async_trait]
pub trait LinkActions: Send + Sync + 'static {
    /// One /health round trip through the tunnel: ms, or `None` when it failed.
    async fn probe(&self, timeout_ms: u64) -> Option<u64>;
    /// Replace the tunnel's ssh child now, with a fresh backoff.
    fn reset_tunnel(&self);
    /// Start the tunnel's ssh child now if none runs; a live one stays.
    fn revive_tunnel(&self);
    /// Have the service client attach now instead of waiting out its delay.
    fn retry_service(&self);
    /// The failure that stopped the ssh side for good (a changed host key, a refused login), noticed by the tunnel before any
    /// transport saw it.
    fn stopped_by(&self) -> Option<LinkFailure>;
    /// Automatic reconnection is off: refuse dials until [`LinkActions::release`].
    fn hold(&self);
    /// The user reconnects: dials are allowed again.
    fn release(&self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelLogin {
    Pc,
    Server,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkState {
    Connected,
    /// `next_retry_at_ms` (the machine's clock, epoch based) and `countdown_ms` (the wait it was scheduled with) are `None`
    /// while an attempt is running.
    Reconnecting { attempt: u32, next_retry_at_ms: Option<u64>, countdown_ms: Option<u64> },
    /// `terminal`: only a new connection can fix it (host key, login, server install). `settings_required`: it needs the user's
    /// confirmation in Settings.
    Lost { terminal: bool, code: String, message: String, settings_required: bool },
    /// This PC is asleep: not a failure.
    Paused,
}

/// What the window shows (mirrors `ConnectionLinkView`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkViewState {
    pub connection_id: String,
    pub state: LinkState,
    /// Last health round trip through the tunnel in ms; `None` before the first.
    pub rtt_ms: Option<u64>,
    /// False when the server cannot run terminals; everything else still works.
    pub terminals_available: bool,
    pub model_login: ModelLogin,
}

pub struct LinkOptions {
    pub connection_id: String,
    pub actions: Arc<dyn LinkActions>,
    pub grace_ms: u64,
    /// The host's setting; false: a drop goes straight to lost, and only the user's Reconnect dials again.
    pub auto_reconnect: bool,
    /// Whose provider logins the server's models run on.
    pub model_login: ModelLogin,
}

impl LinkOptions {
    /// Automatic reconnection on, the PC's model logins.
    pub fn new(connection_id: impl Into<String>, actions: Arc<dyn LinkActions>, grace_ms: u64) -> Self {
        Self { connection_id: connection_id.into(), actions, grace_ms, auto_reconnect: true, model_login: ModelLogin::Pc }
    }
}

fn auto_reconnect_off() -> LinkState {
    LinkState::Lost {
        terminal: false,
        code: "auto-reconnect-off".into(),
        message: "Automatic reconnection is off for this server.".into(),
        settings_required: false,
    }
}

/// A call on the layers below, made once the machine's lock is released.
enum Effect {
    Hold,
    ResetTunnel,
    ReviveTunnel,
    RetryService,
}

struct Core {
    state: LinkState,
    started: bool,
    disposed: bool,
    paused: bool,
    /// The service lost its stream/transport and has not re-attached yet.
    service_down: bool,
    /// Health probes failed often enough that the tunnel was replaced.
    link_down: bool,
    down_since: Option<u64>,
    failures: Vec<u64>,
    rtt_ms: Option<u64>,
    terminals: bool,
    model_login: ModelLogin,
    ladder: ReconnectLadder,
    attempt_timer: Option<JoinHandle<()>>,
    /// Which armed countdown a waking timer task belongs to.
    timer_generation: u64,
    health_timer: Option<JoinHandle<()>>,
}

struct Inner {
    connection_id: String,
    actions: Arc<dyn LinkActions>,
    grace_ms: u64,
    auto_reconnect: bool,
    core: Mutex<Core>,
    view: watch::Sender<LinkViewState>,
    origin: Instant,
    origin_epoch_ms: u64,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let core = self.core.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(timer) = core.attempt_timer.take() {
            timer.abort();
        }
        if let Some(timer) = core.health_timer.take() {
            timer.abort();
        }
    }
}

/// The link state machine of one server connection. Clones share the machine.
#[derive(Clone)]
pub struct LinkMachine {
    inner: Arc<Inner>,
}

impl LinkMachine {
    pub fn new(options: LinkOptions) -> Self {
        let origin = Instant::now();
        let origin_epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
        let core = Core {
            state: LinkState::Connected,
            started: false,
            disposed: false,
            paused: false,
            service_down: false,
            link_down: false,
            down_since: None,
            failures: Vec::new(),
            rtt_ms: None,
            terminals: true,
            model_login: options.model_login,
            ladder: ReconnectLadder::new(reconnect_delay_cap_ms(options.grace_ms)),
            attempt_timer: None,
            timer_generation: 0,
            health_timer: None,
        };
        let (view, _) = watch::channel(Self::view_of(&options.connection_id, &core));
        Self {
            inner: Arc::new(Inner {
                connection_id: options.connection_id,
                actions: options.actions,
                grace_ms: options.grace_ms,
                auto_reconnect: options.auto_reconnect,
                core: Mutex::new(core),
                view,
                origin,
                origin_epoch_ms,
            }),
        }
    }

    /// The view, current at every read; it changes whenever the machine does (once started).
    pub fn view(&self) -> watch::Receiver<LinkViewState> {
        self.inner.view.subscribe()
    }

    /// The machine's clock: epoch milliseconds that follow the runtime's (possibly paused) clock; the base of `next_retry_at_ms`.
    pub fn now_ms(&self) -> u64 {
        self.inner.now_ms()
    }

    fn view_of(connection_id: &str, core: &Core) -> LinkViewState {
        LinkViewState {
            connection_id: connection_id.to_string(),
            state: core.state.clone(),
            rtt_ms: core.rtt_ms,
            terminals_available: core.terminals,
            model_login: core.model_login,
        }
    }

    pub fn set_model_login(&self, model_login: ModelLogin) {
        let mut core = self.inner.lock();
        if core.model_login == model_login {
            return;
        }
        core.model_login = model_login;
        self.inner.emit(&core);
    }

    pub fn set_terminals_available(&self, available: bool) {
        let mut core = self.inner.lock();
        if core.terminals == available {
            return;
        }
        core.terminals = available;
        self.inner.emit(&core);
    }

    /// The first attachment is up: probing starts.
    pub fn start(&self) {
        let mut core = self.inner.lock();
        if core.started || core.disposed {
            return;
        }
        core.started = true;
        core.ladder.mark_healthy(self.inner.now_ms());
        core.health_timer = Some(Inner::spawn_health(&self.inner));
        self.inner.emit(&core);
    }

    /// The service's stream or transport dropped.
    pub fn service_lost(&self) {
        let mut fx = Vec::new();
        {
            let mut core = self.inner.lock();
            if !core.started || core.disposed {
                return;
            }
            core.service_down = true;
            self.inner.go_down(&mut core, &mut fx);
        }
        self.inner.run(fx);
    }

    /// The service attached again (stream back, transport ready, daemon replaced).
    pub fn service_restored(&self) {
        let mut core = self.inner.lock();
        if !core.started || core.disposed {
            return;
        }
        core.service_down = false;
        core.link_down = false;
        self.inner.go_up(&mut core, false);
    }

    /// A failure no retry fixes stopped the connection.
    pub fn terminal(&self, failure: LinkFailure) {
        let mut core = self.inner.lock();
        self.inner.terminal(&mut core, failure);
    }

    /// The connection was opened again after a terminal failure.
    pub fn reopening(&self) {
        let mut core = self.inner.lock();
        if core.disposed {
            return;
        }
        self.inner.clear_attempt(&mut core);
        core.ladder.reset();
        core.service_down = true;
        core.down_since = Some(self.inner.now_ms());
        self.inner.set_state(&mut core, LinkState::Reconnecting { attempt: 1, next_retry_at_ms: None, countdown_ms: None });
    }

    /// The user asked to reconnect now (a non-terminal loss or a long wait).
    pub fn retry(&self) {
        {
            let mut core = self.inner.lock();
            if core.disposed || core.paused || !Inner::is_down(&core) {
                return;
            }
            self.inner.clear_attempt(&mut core);
            core.ladder.reset();
            core.down_since = Some(self.inner.now_ms());
            self.inner.begin_attempt(&mut core, 1);
        }
        self.inner.actions.release();
        Inner::spawn_attempt(&self.inner);
    }

    /// The user skips the countdown: the scheduled attempt runs now. The ladder keeps its count and the outage keeps its start,
    /// so a failed attempt schedules the next step exactly as the timer would have.
    pub fn retry_now(&self) {
        {
            let mut core = self.inner.lock();
            let LinkState::Reconnecting { attempt, .. } = core.state else { return };
            if core.disposed || core.paused || core.attempt_timer.is_none() {
                return;
            }
            self.inner.clear_attempt(&mut core);
            self.inner.begin_attempt(&mut core, attempt);
        }
        Inner::spawn_attempt(&self.inner);
    }

    /// Automatic reconnection is off: refuse dials until [`LinkMachine::release`].
    pub fn hold(&self) {
        self.inner.actions.hold();
    }

    /// The user reconnects: dials are allowed again.
    pub fn release(&self) {
        self.inner.actions.release();
    }

    /// This PC goes to sleep: not a failure, nothing is attempted.
    pub fn suspend(&self) {
        let mut core = self.inner.lock();
        if !core.started || core.disposed || core.paused {
            return;
        }
        core.paused = true;
        self.inner.clear_attempt(&mut core);
        if Inner::is_terminal(&core) {
            return;
        }
        self.inner.set_state(&mut core, LinkState::Paused);
    }

    /// This PC woke up: probe the link before touching it. A live link stays as it is; a dead one gets a new ssh child and a
    /// fresh backoff.
    pub async fn resume(&self) {
        {
            let mut core = self.inner.lock();
            if !core.started || core.disposed || !core.paused {
                return;
            }
            core.paused = false;
            core.ladder.reset();
            core.failures.clear();
            if Inner::is_terminal(&core) {
                return;
            }
        }
        let mut rtt = None;
        for _ in 0..RESUME_PROBE_ATTEMPTS {
            if rtt.is_some() {
                break;
            }
            rtt = self.inner.actions.probe(HEALTH_TIMEOUT_MS).await;
            let core = self.inner.lock();
            if core.disposed || core.paused {
                return;
            }
        }
        let mut fx = Vec::new();
        {
            let mut core = self.inner.lock();
            if let Some(rtt) = rtt {
                core.rtt_ms = Some(rtt);
                core.link_down = false;
                if core.service_down {
                    fx.push(Effect::RetryService);
                    self.inner.go_down(&mut core, &mut fx);
                } else {
                    self.inner.go_up(&mut core, true);
                }
            } else {
                if self.inner.auto_reconnect {
                    fx.push(Effect::ResetTunnel);
                }
                core.link_down = true;
                core.down_since = None;
                self.inner.go_down(&mut core, &mut fx);
            }
        }
        self.inner.run(fx);
    }

    pub fn dispose(&self) {
        let mut core = self.inner.lock();
        core.disposed = true;
        self.inner.clear_attempt(&mut core);
        if let Some(timer) = core.health_timer.take() {
            timer.abort();
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn now_ms(&self) -> u64 {
        self.origin_epoch_ms + self.origin.elapsed().as_millis() as u64
    }

    fn is_down(core: &Core) -> bool {
        matches!(core.state, LinkState::Reconnecting { .. } | LinkState::Lost { .. })
    }

    fn is_terminal(core: &Core) -> bool {
        matches!(core.state, LinkState::Lost { terminal: true, .. })
    }

    fn emit(&self, core: &Core) {
        if core.started && !core.disposed {
            self.view.send_replace(LinkMachine::view_of(&self.connection_id, core));
        }
    }

    fn set_state(&self, core: &mut Core, state: LinkState) {
        core.state = state;
        self.emit(core);
    }

    fn run(&self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Hold => self.actions.hold(),
                Effect::ResetTunnel => self.actions.reset_tunnel(),
                Effect::ReviveTunnel => self.actions.revive_tunnel(),
                Effect::RetryService => self.actions.retry_service(),
            }
        }
    }

    fn clear_attempt(&self, core: &mut Core) {
        core.timer_generation += 1;
        if let Some(timer) = core.attempt_timer.take() {
            timer.abort();
        }
    }

    fn terminal(&self, core: &mut Core, failure: LinkFailure) {
        if core.disposed {
            return;
        }
        self.clear_attempt(core);
        core.service_down = true;
        self.set_state(
            core,
            LinkState::Lost { terminal: true, code: failure.code, message: failure.message, settings_required: failure.settings_required },
        );
    }

    fn go_down(self: &Arc<Self>, core: &mut Core, fx: &mut Vec<Effect>) {
        if core.paused || Self::is_terminal(core) {
            return;
        }
        if !Self::is_down(core) {
            core.down_since = Some(self.now_ms());
        }
        if matches!(core.state, LinkState::Lost { .. }) || core.attempt_timer.is_some() {
            return;
        }
        self.schedule_attempt(core, fx);
    }

    fn go_up(&self, core: &mut Core, force: bool) {
        if core.paused || core.service_down || core.link_down {
            return;
        }
        if Self::is_terminal(core) && !force {
            return;
        }
        self.clear_attempt(core);
        core.down_since = None;
        core.ladder.mark_healthy(self.now_ms());
        self.set_state(core, LinkState::Connected);
    }

    fn schedule_attempt(self: &Arc<Self>, core: &mut Core, fx: &mut Vec<Effect>) {
        if !self.auto_reconnect {
            fx.push(Effect::Hold);
            self.set_state(core, auto_reconnect_off());
            return;
        }
        let now = self.now_ms();
        if core.down_since.is_some_and(|since| now.saturating_sub(since) >= self.grace_ms) {
            // Past the server's grace the daemon may have let this client go: stop counting down and leave the next step to the
            // user.
            self.set_state(
                core,
                LinkState::Lost {
                    terminal: false,
                    code: "unreachable".into(),
                    message: "The server stayed unreachable longer than it keeps a session for this PC.".into(),
                    settings_required: false,
                },
            );
            return;
        }
        let (attempt, delay_ms) = core.ladder.next(now);
        self.set_state(
            core,
            LinkState::Reconnecting { attempt, next_retry_at_ms: Some(now + delay_ms), countdown_ms: Some(delay_ms) },
        );
        core.timer_generation += 1;
        let generation = core.timer_generation;
        let inner = Arc::clone(self);
        core.attempt_timer = Some(mixdog_rt::spawn("link-attempt-timer", TaskClass::Control, async move {
            mixdog_rt::time::sleep(Duration::from_millis(delay_ms)).await;
            {
                let mut core = inner.lock();
                if core.timer_generation != generation {
                    return;
                }
                // Past this point the timer is spent: clearing the countdown can no longer cancel the attempt.
                core.attempt_timer = None;
                if !inner.begin_attempt(&mut core, attempt) {
                    return;
                }
            }
            inner.finish_attempt().await;
        }));
    }

    /// The part of an attempt that runs where it is asked for; false when there is nothing to attempt.
    fn begin_attempt(&self, core: &mut Core, attempt: u32) -> bool {
        if core.disposed || core.paused {
            return false;
        }
        self.set_state(core, LinkState::Reconnecting { attempt, next_retry_at_ms: None, countdown_ms: None });
        true
    }

    fn spawn_attempt(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        drop(mixdog_rt::spawn("link-attempt", TaskClass::Control, async move { inner.finish_attempt().await }));
    }

    async fn finish_attempt(self: &Arc<Self>) {
        let rtt = self.actions.probe(HEALTH_TIMEOUT_MS).await;
        let stopped = if rtt.is_none() { self.actions.stopped_by() } else { None };
        let mut fx = Vec::new();
        {
            let mut core = self.lock();
            if core.disposed || core.paused || !Self::is_down(&core) || Self::is_terminal(&core) {
                return;
            }
            if let Some(rtt) = rtt {
                core.rtt_ms = Some(rtt);
                core.link_down = false;
                if core.service_down {
                    fx.push(Effect::RetryService);
                } else {
                    self.go_up(&mut core, false);
                    return;
                }
            } else {
                if let Some(stopped) = stopped {
                    self.terminal(&mut core, stopped);
                    return;
                }
                fx.push(Effect::ReviveTunnel);
                if !self.auto_reconnect {
                    // The user's one attempt: its outcome comes from the service (attached again, or dropped once more and lost).
                    fx.push(Effect::RetryService);
                    drop(core);
                    self.run(fx);
                    return;
                }
            }
            if core.attempt_timer.is_none() && Self::is_down(&core) {
                self.schedule_attempt(&mut core, &mut fx);
            }
        }
        self.run(fx);
    }

    fn spawn_health(inner: &Arc<Self>) -> JoinHandle<()> {
        let weak: Weak<Self> = Arc::downgrade(inner);
        mixdog_rt::spawn("link-health", TaskClass::Control, async move {
            let period = Duration::from_millis(HEALTH_INTERVAL_MS);
            let mut ticks = mixdog_rt::time::interval_at_unrefed(Instant::now() + period, period);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                let Some(inner) = weak.upgrade() else { return };
                inner.health_tick().await;
            }
        })
    }

    async fn health_tick(self: &Arc<Self>) {
        {
            let core = self.lock();
            if core.disposed || core.paused || core.state != LinkState::Connected {
                return;
            }
        }
        let rtt = self.actions.probe(HEALTH_TIMEOUT_MS).await;
        let mut fx = Vec::new();
        {
            let mut core = self.lock();
            if core.disposed || core.paused {
                return;
            }
            let now = self.now_ms();
            if let Some(rtt) = rtt {
                core.rtt_ms = Some(rtt);
                self.emit(&core);
                return;
            }
            core.failures.retain(|at| now.saturating_sub(*at) < FAILURE_WINDOW_MS);
            core.failures.push(now);
            if core.failures.len() < FAILURES_TO_REPLACE {
                return;
            }
            core.failures.clear();
            if self.auto_reconnect {
                fx.push(Effect::ResetTunnel);
            }
            core.link_down = true;
            self.go_down(&mut core, &mut fx);
        }
        self.run(fx);
    }
}

#[cfg(test)]
#[path = "link_machine_tests.rs"]
mod tests;
