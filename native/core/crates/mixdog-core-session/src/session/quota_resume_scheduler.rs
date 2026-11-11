//! The daemon's clock for quota auto-resume (`standalone/session-service/quota-resume.mjs`
//! `createQuotaResumeScheduler`). Waiting lives in the durable queue ([`QuotaResumeStore`]), never
//! in a session, so an evicted or not-yet-loaded session waits exactly like a live one. One timer
//! is armed for the earliest due entry; when it fires, the addressed session is materialized, a
//! fresh usage reading decides whether its provider can serve the model again, and the session's
//! own lane runs the retry under the entry's generation. Overdue entries run as soon as the
//! scheduler starts.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mixdog_core_base::quota_resume::{Entry, QuotaError, QuotaResumeStore};
use mixdog_js::json_number;
use mixdog_rt::CancellationToken;
use mixdog_rt::{Scope, Scoped};
use serde_json::json;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

/// A still-exhausted reading is re-taken once, this much later.
pub const QUOTA_RESUME_RETRY_MS: f64 = 5.0 * 60_000.0;
/// A busy session is re-checked this much later, without spending an attempt.
pub const QUOTA_RESUME_BUSY_RECHECK_MS: f64 = 30_000.0;
/// The longest a JavaScript timer waits.
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
/// The longest one call into the host (`materialize`, `route`, `usable`, `fire`) may take. A call
/// past it fails its entry, which is deferred like any other failure, so one hung host call
/// cannot stall the entries behind it or the timer.
const HOST_CALL_BOUND: Duration = Duration::from_secs(120);

/// `$what` awaited under [`Pass::bounded`]; the entry's pass returns early when it ends the wait.
macro_rules! bounded {
    ($pass:expr, $what:expr, $work:expr) => {
        match $pass.bounded($what, $work).await {
            Ok(out) => out,
            Err(early) => return early,
        }
    };
}

/// `now` and `setTimer` of the scheduler's options.
#[async_trait]
pub trait ResumeClock: Send + Sync {
    /// `Date.now()`.
    fn now_ms(&self) -> f64;
    /// Resolves after `ms`; dropping it clears the timer.
    async fn sleep(&self, ms: u64);
}

/// The wall clock and tokio's timer.
pub struct SystemResumeClock;

#[async_trait]
impl ResumeClock for SystemResumeClock {
    fn now_ms(&self) -> f64 {
        mixdog_core_goal::goal::js::now_wall_ms()
    }

    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

/// Why a usage reading failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UsageError {
    /// `MODEL_PROXY_UNAVAILABLE`: a disconnected PC supplies no reading. The pass defers the entry
    /// without spending an exhaustion attempt.
    ProxyUnavailable(String),
    /// Any other failure: logged, and the reading counts as exhausted.
    Failed(String),
}

/// What `runtime.fireQuotaResume({ generation })` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FireOutcome {
    Fired,
    Busy,
    Rejected,
    Stale,
    Superseded,
    Unreplayable,
}

impl FireOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fired => "fired",
            Self::Busy => "busy",
            Self::Rejected => "rejected",
            Self::Stale => "stale",
            Self::Superseded => "superseded",
            Self::Unreplayable => "unreplayable",
        }
    }
}

/// The route a session's next turn runs on, as its state reports it; an empty field is absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRoute {
    pub provider: String,
    pub model: String,
}

/// What the scheduler asks of the daemon: `materializeSession`, the session's state, its
/// `fireQuotaResume` and `readQuotaUsable`.
#[async_trait]
pub trait ResumeHost: Send + Sync {
    /// Loads the session under daemon ownership; the error text is what the log carries.
    async fn materialize(&self, session_id: &str) -> Result<(), String>;
    /// `snapshot.provider || snapshot.sessionProvider || runtime.session.provider`, and the model.
    async fn route(&self, session_id: &str) -> SessionRoute;
    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError>;
    /// The session's own lane runs the retry; an error is the rejection the lane raised.
    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String>;
}

enum Outcome {
    Closed,
    Unavailable,
    Cancelled,
    RouteChanged,
    ExhaustedRetry,
    Exhausted,
    Fire(FireOutcome),
}

impl Outcome {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Unavailable => "unavailable",
            Self::Cancelled => "cancelled",
            Self::RouteChanged => "route-changed",
            Self::ExhaustedRetry => "exhausted-retry",
            Self::Exhausted => "exhausted",
            Self::Fire(outcome) => outcome.as_str(),
        }
    }
}

pub type ResumeLog = Arc<dyn Fn(&str) + Send + Sync>;

fn message(error: QuotaError) -> String {
    error.to_string()
}

/// The one pass state the clock's timer and every public `tick()` share: the holdoffs and the
/// pass in flight live here, not in a call.
struct Pass {
    store: Arc<QuotaResumeStore>,
    host: Arc<dyn ResumeHost>,
    clock: Arc<dyn ResumeClock>,
    auto_resume: Arc<dyn Fn() -> bool + Send + Sync>,
    log: ResumeLog,
    cancel: CancellationToken,
    /// sessionId -> (generation, at): an entry whose store write failed is not tried again before
    /// `at`, so a full disk is not retried in a loop. Only that entry waits; the one timer still
    /// goes to the earliest time any entry may run.
    not_before: Mutex<HashMap<String, (u64, f64)>>,
    /// The pass in flight, as a signal that turns true when it ends. A tick that finds one waits
    /// for it instead of starting another, as Node's `tick()` answers `running`.
    running: Mutex<Option<watch::Receiver<bool>>>,
    /// Holds a permit once a tick has found a pass in flight and begun waiting for it.
    #[cfg(any(test, feature = "test-support"))]
    joined: tokio::sync::Notify,
}

/// Ends the pass in flight when its leader finishes or is dropped.
struct Release<'a> {
    pass: &'a Pass,
    finished: watch::Sender<bool>,
}

impl Drop for Release<'_> {
    fn drop(&mut self) {
        *self.pass.running.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.finished.send_replace(true);
    }
}

fn number(value: &serde_json::Number) -> f64 {
    value.as_f64().expect("a stored reset time is finite")
}

impl Pass {
    fn closed(&self) -> bool {
        self.cancel.is_cancelled()
    }

    fn is_current(&self, entry: &Entry) -> bool {
        self.store.entry(&entry.session_id).is_some_and(|stored| stored.generation == entry.generation)
    }

    fn runnable_at(&self, entry: &Entry) -> f64 {
        let reset = number(&entry.reset_at);
        let mut held = self.not_before.lock().unwrap_or_else(PoisonError::into_inner);
        match held.get(&entry.session_id) {
            Some((generation, _)) if *generation != entry.generation => {
                held.retain(|id, _| id != &entry.session_id);
                reset
            }
            Some((_, at)) => reset.max(*at),
            None => reset,
        }
    }

    fn hold_off(&self, entry: &Entry) {
        let at = self.clock.now_ms() + QUOTA_RESUME_RETRY_MS;
        self.not_before.lock().unwrap_or_else(PoisonError::into_inner).insert(entry.session_id.clone(), (entry.generation, at));
    }

    /// How long the one timer waits, or none when no entry is queued.
    fn arm(&self) -> Option<u64> {
        let entries = self.store.list();
        self.not_before.lock().unwrap_or_else(PoisonError::into_inner).retain(|id, _| entries.iter().any(|e| &e.session_id == id));
        let due = entries.iter().map(|e| self.runnable_at(e)).reduce(f64::min)?;
        Some((due - self.clock.now_ms()).clamp(0.0, MAX_TIMER_MS) as u64)
    }

    async fn defer(&self, entry: &Entry, reset_at: f64, attempts: u64) -> Result<(), QuotaError> {
        self.store.defer(&entry.session_id, Some(entry.generation), &json!({ "resetAt": json_number(reset_at), "attempts": attempts })).await.map(drop)
    }

    /// One call into the host under the scheduler's token and [`HOST_CALL_BOUND`]: `Err` is how
    /// the entry's pass ends early (stopped: closed; too slow: a failure the entry is deferred for).
    async fn bounded<T>(&self, what: &str, work: impl Future<Output = T>) -> Result<T, Result<Outcome, String>> {
        let scope = Scope::new().cancel(&self.cancel).deadline(Some(Instant::now() + HOST_CALL_BOUND));
        match scope.run(work).await {
            Scoped::Done(out) => Ok(out),
            Scoped::Cancelled => Err(Ok(Outcome::Closed)),
            Scoped::DeadlineExceeded => Err(Err(format!("{what} timed out"))),
        }
    }

    /// One due entry: load its session, take the fresh reading, then fire, re-check later, or
    /// clear it. The error is a failure the pass defers the entry for.
    async fn resume_due(&self, entry: &Entry) -> Result<Outcome, String> {
        let id = entry.session_id.as_str();
        let generation = entry.generation;
        if let Err(error) = bounded!(self, "materialize", self.host.materialize(id)) {
            if self.closed() {
                return Ok(Outcome::Closed);
            }
            (self.log)(&format!("quota resume could not load session={id}: {error}"));
            self.store.cancel(id, Some(generation)).await.map_err(message)?;
            return Ok(Outcome::Unavailable);
        }
        if !self.is_current(entry) {
            return Ok(Outcome::Cancelled);
        }
        let route = bounded!(self, "route", self.host.route(id));
        let pick = |own: String, entry: &str| if own.is_empty() { entry.to_owned() } else { own };
        let (provider, model) = (pick(route.provider, &entry.provider), pick(route.model, &entry.model));
        let usable = match bounded!(self, "usable", self.host.usable(&provider, &model)) {
            Ok(usable) => usable,
            Err(UsageError::ProxyUnavailable(error)) => return Err(error),
            Err(UsageError::Failed(error)) => {
                (self.log)(&format!("quota resume usage reading failed provider={provider}: {error}"));
                false
            }
        };
        if !self.is_current(entry) {
            return Ok(Outcome::Cancelled);
        }
        let selected = bounded!(self, "route", self.host.route(id));
        let selected_provider = if selected.provider.is_empty() { entry.provider.clone() } else { selected.provider };
        let selected_model = if selected.model.is_empty() { entry.model.clone() } else { selected.model };
        if selected_provider != provider || selected_model != model {
            // The reading belongs to the old route. Preserve the reservation and check the
            // selected route on the normal busy-recheck cadence.
            self.defer(entry, self.clock.now_ms() + QUOTA_RESUME_BUSY_RECHECK_MS, entry.attempts).await.map_err(message)?;
            return Ok(Outcome::RouteChanged);
        }
        if !usable {
            // One more reading five minutes on; after that the session falls back to the user's
            // own choice.
            if entry.attempts < 1 {
                self.defer(entry, self.clock.now_ms() + QUOTA_RESUME_RETRY_MS, entry.attempts + 1).await.map_err(message)?;
                return Ok(Outcome::ExhaustedRetry);
            }
            self.store.cancel(id, Some(generation)).await.map_err(message)?;
            return Ok(Outcome::Exhausted);
        }
        let outcome = bounded!(self, "fire", self.host.fire(id, generation))?;
        if matches!(outcome, FireOutcome::Busy | FireOutcome::Rejected) {
            self.defer(entry, self.clock.now_ms() + QUOTA_RESUME_BUSY_RECHECK_MS, entry.attempts).await.map_err(message)?;
        } else if self.is_current(entry) {
            // Every other outcome settles the entry; one the session could not address (it now
            // holds another session id) must not stay due forever.
            self.store.cancel(id, Some(generation)).await.map_err(message)?;
        }
        Ok(Outcome::Fire(outcome))
    }

    /// Runs every due entry now. A call that finds a pass in flight waits for that pass, so one
    /// generation is never fired by two passes; after `stop` it does nothing.
    async fn tick(&self) {
        let leader = {
            let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
            if self.closed() {
                return;
            }
            match running.as_ref() {
                Some(done) => Err(done.clone()),
                None => {
                    let (finished, done) = watch::channel(false);
                    *running = Some(done);
                    Ok(finished)
                }
            }
        };
        match leader {
            Err(mut done) => {
                #[cfg(any(test, feature = "test-support"))]
                self.joined.notify_one();
                // Ends when the leader's release signals, or when the leader is dropped, or at stop.
                let _ = Scope::new().cancel(&self.cancel).run(done.wait_for(|finished| *finished)).await;
            }
            Ok(finished) => {
                let _release = Release { pass: self, finished };
                self.run_pass().await;
            }
        }
    }

    async fn run_pass(&self) {
        if let Err(error) = self.run_due().await {
            // Not tied to one entry (the setting's cancel-all): all wait.
            for entry in self.store.list() {
                self.hold_off(&entry);
            }
            (self.log)(&format!("quota resume pass failed: {error}"));
        }
    }

    async fn run_due(&self) -> Result<(), String> {
        // The setting turned off anywhere (another process, a hand edit), not only through
        // `setQuotaAutoResumeEnabled` here: nothing pending resumes.
        if !(self.auto_resume)() {
            if !self.store.list().is_empty() {
                self.store.cancel_all().await.map_err(message)?;
                (self.log)("quota resume off: pending resumes cancelled");
            }
            return Ok(());
        }
        for entry in self.store.list() {
            if self.closed() {
                return Ok(());
            }
            if self.runnable_at(&entry) > self.clock.now_ms() || !self.is_current(&entry) {
                continue;
            }
            match self.resume_due(&entry).await {
                Ok(outcome) => {
                    self.not_before.lock().unwrap_or_else(PoisonError::into_inner).retain(|id, _| id != &entry.session_id);
                    (self.log)(&format!("quota resume session={} outcome={}", entry.session_id, outcome.as_str()));
                }
                Err(error) => {
                    (self.log)(&format!("quota resume failed session={}: {error}", entry.session_id));
                    if let Err(store_error) = self.defer(&entry, self.clock.now_ms() + QUOTA_RESUME_RETRY_MS, entry.attempts).await {
                        // The store keeps the entry as it was on disk: it stays due and is tried
                        // again by a later pass.
                        self.hold_off(&entry);
                        (self.log)(&format!("quota resume could not record the deferral session={}: {store_error}", entry.session_id));
                    }
                }
            }
        }
        Ok(())
    }

    /// The timer: armed for the earliest entry, re-armed when the queue changes, run when it fires.
    async fn run(self: Arc<Self>, changed: Arc<Notify>) {
        loop {
            let wait = self.arm();
            let timer = async {
                match wait {
                    Some(ms) => self.clock.sleep(ms).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => return,
                () = changed.notified() => {}
                // The pass runs under the token too: `stop` reaches it between host calls.
                () = timer => {
                    if Scope::new().cancel(&self.cancel).run(self.tick()).await == Scoped::Cancelled {
                        return;
                    }
                }
            }
        }
    }
}

pub struct QuotaResumeScheduler {
    pass: Arc<Pass>,
    /// The timer's task, once started.
    started: Mutex<Option<JoinHandle<()>>>,
}

impl QuotaResumeScheduler {
    /// `auto_resume` is `quotaAutoResumeEnabled()`: the sessions' `SessionQuota::auto_resume`
    /// ([`super::quota_lane::auto_resume_enabled`]).
    pub fn new(
        store: Arc<QuotaResumeStore>,
        host: Arc<dyn ResumeHost>,
        clock: Arc<dyn ResumeClock>,
        auto_resume: Arc<dyn Fn() -> bool + Send + Sync>,
        log: ResumeLog,
    ) -> Self {
        let pass = Pass { store, host, clock, auto_resume, log, cancel: CancellationToken::new(), not_before: Mutex::default(), running: Mutex::default(), #[cfg(any(test, feature = "test-support"))] joined: tokio::sync::Notify::new() };
        Self { pass: Arc::new(pass), started: Mutex::new(None) }
    }

    /// Returns once a tick has found a pass in flight and is waiting for it.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(crate) async fn joined(&self) {
        self.pass.joined.notified().await;
    }

    /// The delay the one timer would wait now, or none when nothing is queued.
    pub fn armed_ms(&self) -> Option<u64> {
        self.pass.arm()
    }

    /// `tick()`: runs every due entry now (joining the pass already running, if any), and answers
    /// the delay the timer re-arms for. After `stop` it runs nothing and answers none.
    pub async fn tick(&self) -> Option<u64> {
        if self.pass.closed() {
            return None;
        }
        self.pass.tick().await;
        self.pass.arm()
    }

    /// Starts the clock; entries already due run right away. A stopped clock stays stopped.
    pub fn start(&self) {
        let mut started = self.started.lock().unwrap_or_else(PoisonError::into_inner);
        if started.is_some() || self.pass.closed() {
            return;
        }
        let changed = Arc::new(Notify::new());
        let subscription = {
            let changed = changed.clone();
            self.pass.store.subscribe(move |_| changed.notify_one())
        };
        let pass = self.pass.clone();
        *started = Some(tokio::spawn(async move {
            let _subscription = subscription;
            pass.run(changed).await;
        }));
    }

    /// Ends the clock for good: the timer's task and the pass in flight (its current entry
    /// finishes, no further one starts) are over when this returns, and no tick runs after it.
    pub async fn stop(&self) {
        self.pass.cancel.cancel();
        let task = self.started.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(task) = task
            && let Err(error) = task.await
            && error.is_panic()
        {
            std::panic::resume_unwind(error.into_panic());
        }
        let in_flight = self.pass.running.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(mut done) = in_flight {
            let _ = done.wait_for(|finished| *finished).await;
        }
    }
}
