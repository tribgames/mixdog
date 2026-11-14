//! The person taking the desktop back from the agents (`host/command-queue-pause.ts`, `host/user-input-refusal.ts`,
//! `host/command-attempt.ts`, `shared/takeover-codes.ts`, `session/user-wait.ts`, `host/user-wait-service.ts`).
//!
//! Two holds, shared by one pool's sessions:
//! - a yield: the person's own input interrupted one session's foreground action, so only that session sends nothing until the
//!   desktop has been idle for the idle-resume interval (`ComputerUseCoordinator.yieldSession`);
//! - a takeover: a cleanup the helper could not confirm (`input_cleanup_unconfirmed`) or the pill's Stop hands the whole
//!   desktop back, and every session's input is refused until Resume (`pauseForUser`, `assertAutomationAllowed`).
//!
//! The Node host resumes both from a background sampler; here the sampler is the request that meets the hold (`admit`) and
//! the `wait_for_user` call, each reading the helper's `input_idle_state`.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::ComputerResumeMode;
use mixdog_protocol::ComputerUserControlSection;
use mixdog_rt::time::Instant;
use mixdog_rt::time::sleep;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;
use super::computer_command::text;
use super::computer_lane;

/// Failure codes that hand the whole desktop back to the person (`TAKEOVER_CODES`). The person's own input never does: it
/// refuses just the action it hit.
pub const TAKEOVER_CODES: [&str; 1] = ["input_cleanup_unconfirmed"];
/// Why the pill's Stop holds the desktop (`pauseForUser('user_stop')`).
const USER_STOP: &str = "user_stop";
/// Why the pill's pause holds it (`pauseForUser('user_pause')`).
const USER_PAUSE: &str = "user_pause";
/// The reason the section gives a yield, and the code of its refusal.
const USER_INPUT_ACTIVE: &str = "user_input_active";
/// The message of an admission refusal, which sent nothing (`observer.rs` `begin`).
const SUPERSEDED: &str = "superseded by external input";
/// The code of the refusal of a held desktop (`ComputerUseCoordinator.assertAutomationAllowed`).
const TAKEOVER_CODE: &str = "computer_user_takeover";
/// The reasons an environment change hands the desktop back (`environment-guard.ts`): the screen locked or the machine slept, or the
/// displays changed under the observations. They never resume by themselves.
const ENVIRONMENT_REASONS: [&str; 2] = ["desktop_unavailable", "display_changed"];
/// The code a parked request ends with once the person resumed: it was never dispatched, so it must capture again
/// (`PausedComputerWork`).
const RESUME_RECAPTURE_CODE: &str = "computer_resume_recapture_required";
/// How long a request parks behind the person's pause before it answers `paused` (`MAX_PAUSE_WAIT_MS`).
const PAUSE_WAIT: Duration = Duration::from_secs(15);
/// The largest idle-resume interval, in seconds (`configure`: 0 or 1..60).
const MAX_IDLE_RESUME_SECONDS: u32 = 60;
/// The reads that stay open while the person holds the desktop (`recovery-reads.ts`).
const RECOVERY_READS: [&str; 4] = ["list_windows", "list_apps", "list_history", "diagnose"];

/// `createComputerUserWait`'s default interval (`let seconds = 5`).
const DEFAULT_IDLE_RESUME: Duration = Duration::from_secs(5);
/// The bounds and default of `wait_for_user`'s `timeout_ms`.
const MAX_WAIT_MS: f64 = 120_000.0;
const DEFAULT_WAIT_MS: u64 = 60_000;
/// Waits at once (`waiters.size >= 16`).
const MAX_WAITERS: usize = 16;
/// How often a wait samples the idle state, and how often once the reading keeps failing (`FAILING_OBSERVATION_INTERVAL_MS`).
const SAMPLE_INTERVAL: Duration = Duration::from_millis(500);
const FAILING_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const FAILURES_BEFORE_SLOWING: u32 = 3;
/// A reading that takes longer is not trusted (`now() - sampledAt > 2_000`).
const SLOW_READING: Duration = Duration::from_secs(2);

/// Tells the pool the section changed.
type Listener = Arc<dyn Fn() + Send + Sync>;

/// The whole desktop held by the person.
struct Takeover {
    reason: String,
    /// The desktop may resume by itself once it has been idle: the release was confirmed (`isIdleResumePause`), which a Stop
    /// never is.
    idle_resumable: bool,
    /// The sessions with an open execution when the hold began (`pausedSessionIds`): the hold ends with the last of them
    /// (`releaseEndedPause`), unless it is one the person alone ends.
    paused: BTreeSet<String>,
}

#[derive(Default)]
struct Inner {
    takeover: Option<Takeover>,
    /// The sessions waiting for the person's hands to leave the input (`yieldedSessionIds`).
    yielded: BTreeSet<String>,
    /// The sessions with an open execution (`activities`): a takeover with none has nothing to hold.
    open: BTreeSet<String>,
    /// The sessions inside `wait_for_user`.
    waiting: BTreeSet<String>,
    /// Count the holds, so a quiet interval measured for one is never spent on the next (`takeoverGeneration`,
    /// `yieldGeneration`).
    takeovers: u64,
    yields: u64,
    /// The sessions whose helper cleanup did not confirm (`cleanupState: 'failed'`): only a verified recovery clears them, never
    /// a click alone (`recoverLatchedCleanup`).
    latched: BTreeSet<String>,
}

/// Whether the person holds the desktop, shared by one pool's sessions.
pub struct UserControlState {
    /// The idle-resume interval in seconds, runtime-settable (`configureIdleResume`); zero means only Resume.
    idle_resume: AtomicU32,
    inner: Mutex<Inner>,
    /// Counts the changes, which the waits wake on.
    changes: watch::Sender<u64>,
    listener: Mutex<Option<Listener>>,
    /// The sessions' backends, which a recovery runs the cleanup of again.
    backends: Mutex<BTreeMap<String, Weak<ProcessComputerBackend>>>,
    /// One recovery at a time (`recovering`).
    recovering: tokio::sync::Mutex<()>,
}

impl Default for UserControlState {
    fn default() -> Self {
        Self::new(DEFAULT_IDLE_RESUME)
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What stops a command from running.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Block {
    Takeover,
    Yielded,
}

/// A session's standing with `wait_for_user`.
enum Standing {
    Held,
    Resumed,
    Cancelled,
}

impl Standing {
    /// The status that ends the wait, if the standing does.
    fn status(&self) -> Option<&'static str> {
        match self {
            Self::Held => None,
            Self::Resumed => Some("resumed"),
            Self::Cancelled => Some("cancelled"),
        }
    }
}

/// What interrupted a command's result.
enum Interrupt {
    /// The person's input: the refusal payload.
    UserInput(Map<String, Value>),
    /// A takeover code, and the error the command ends in.
    Takeover { code: String, error: ComputerError },
}

/// One `input_idle_state` reading (`IdleObservation`).
struct Idle {
    monitor: String,
    sequence: i64,
    idle: Duration,
    held: bool,
    /// The observer works but the input desktop is the lock screen or a secure prompt: the person is there.
    desktop_locked: bool,
}

impl Idle {
    /// The reading of a helper reply, or `None` when it is not a valid one (`valid`).
    fn of(result: &Map<String, Value>) -> Option<Self> {
        let monitor = match result.get("monitor") {
            Some(Value::String(monitor)) => monitor.clone(),
            Some(Value::Number(monitor)) => monitor.to_string(),
            _ => String::new(),
        };
        let ready = result.get("ready") == Some(&Value::Bool(true));
        let held = result.get("held") != Some(&Value::Bool(false));
        if result.get("observer_ready") == Some(&Value::Bool(true)) && !ready {
            return Some(Self { monitor, sequence: 0, idle: Duration::ZERO, held, desktop_locked: true });
        }
        if !ready || monitor.is_empty() {
            return None;
        }
        let sequence = result.get("sequence").and_then(Value::as_i64).filter(|sequence| *sequence >= 0)?;
        let idle_ms = result.get("idleMs").and_then(Value::as_f64).filter(|ms| ms.is_finite() && *ms >= 0.0)?;
        let idle = Duration::try_from_secs_f64(idle_ms / 1000.0).ok()?;
        Some(Self { monitor, sequence, idle, held, desktop_locked: false })
    }

    fn same(&self, other: &Self) -> bool {
        self.monitor == other.monitor && self.sequence == other.sequence
    }
}

impl UserControlState {
    /// A control that resumes by itself after `idle_resume` of quiet; zero means only the person's Resume does
    /// (`resume_mode: manual`).
    pub fn new(idle_resume: Duration) -> Self {
        Self {
            idle_resume: AtomicU32::new(u32::try_from(idle_resume.as_secs()).unwrap_or(u32::MAX).min(MAX_IDLE_RESUME_SECONDS)),
            inner: Mutex::default(),
            changes: watch::channel(0).0,
            listener: Mutex::default(),
            backends: Mutex::default(),
            recovering: tokio::sync::Mutex::new(()),
        }
    }

    /// The idle-resume interval (`idleResumeSeconds` of the coordinator's snapshot).
    fn interval(&self) -> Duration {
        Duration::from_secs(u64::from(self.idle_resume_seconds()))
    }

    /// The idle-resume interval in seconds, 0 to 60; zero means only the person's Resume ends a hold.
    pub fn idle_resume_seconds(&self) -> u32 {
        self.idle_resume.load(Ordering::SeqCst)
    }

    /// `configureIdleResume`: sets the interval at run time (a value above 60 is held at 60; the caller rejects it first). The
    /// holds in place are published again, since their resume mode follows the interval, and the waits re-read it.
    pub fn set_idle_resume(&self, seconds: u32) {
        let seconds = seconds.min(MAX_IDLE_RESUME_SECONDS);
        if self.idle_resume.swap(seconds, Ordering::SeqCst) != seconds {
            self.changed();
        }
    }

    /// Makes `backend` the one whose cleanup a recovery of `session` runs again. The pool registers each session's backend.
    pub fn register(&self, session: &str, backend: Weak<ProcessComputerBackend>) {
        locked(&self.backends).insert(session.to_owned(), backend);
    }

    /// Whether a cleanup is latched as unconfirmed.
    pub fn is_latched(&self) -> bool {
        !locked(&self.inner).latched.is_empty()
    }

    /// `session`'s cleanup confirmed: its latch goes (the hold, if any, stays until Resume or a recovery).
    pub(super) fn cleanup_confirmed(&self, session: &str) {
        locked(&self.inner).latched.remove(session);
    }

    /// Ends the hold a cleanup that did not confirm placed, once nothing is latched: true when there was one.
    fn release_cleanup_hold(&self) -> bool {
        let released = {
            let mut inner = locked(&self.inner);
            if inner.latched.is_empty() && inner.takeover.as_ref().is_some_and(|takeover| takeover.reason == TAKEOVER_CODES[0]) {
                inner.takeover = None;
                true
            } else {
                false
            }
        };
        if released {
            self.changed();
        }
        released
    }

    /// `recoverLatchedCleanup`: every latched session's helper is retired and its cleanup run again, once. A session with an
    /// execution open is left (its helper is still working, as a worker that has not exited is in Node); one whose backend is gone
    /// has run its cleanup in its drop. True when nothing stays latched.
    pub async fn recover_latched(&self) -> bool {
        let _one = self.recovering.lock().await;
        let sessions: Vec<String> = locked(&self.inner).latched.iter().cloned().collect();
        for session in sessions {
            let backend = locked(&self.backends).get(&session).and_then(Weak::upgrade);
            let confirmed = match backend {
                None => true,
                Some(backend) if backend.is_executing() => false,
                Some(backend) => backend.recover_cleanup().await,
            };
            if confirmed {
                self.cleanup_confirmed(&session);
            }
        }
        !self.is_latched()
    }

    /// The pill's Resume: a latched cleanup gets its verified recovery first, and one that still does not confirm leaves the
    /// desktop with the person (false), as the click alone never clears it (`resumeByUser`). Without one, `resume`.
    pub async fn resume_verified(&self, session: Option<&str>) -> bool {
        let latched = self.is_latched();
        if latched && !self.recover_latched().await {
            return false;
        }
        let released = latched && self.release_cleanup_hold();
        self.resume(session) || released
    }

    /// The pill's Stop: it holds the desktop, and a latched cleanup gets its verified recovery as `stopAllComputerSessions` runs
    /// it; true when either changed something.
    pub async fn stop_verified(&self) -> bool {
        let held = self.stop();
        let recovered = self.is_latched() && self.recover_latched().await && self.release_cleanup_hold();
        held || recovered
    }

    /// Calls `listener` after each change of the section, which publishes it.
    pub fn on_change(&self, listener: Listener) {
        *locked(&self.listener) = Some(listener);
    }

    /// The hold as the `computer` section shows it: a takeover, or the yield of some session; `None` while the person holds
    /// nothing.
    pub fn section(&self) -> Option<ComputerUserControlSection> {
        let inner = locked(&self.inner);
        if let Some(takeover) = &inner.takeover {
            return Some(ComputerUserControlSection { active: true, reason: takeover.reason.clone(), resume_mode: self.mode(takeover.idle_resumable) });
        }
        (!inner.yielded.is_empty()).then(|| ComputerUserControlSection { active: false, reason: USER_INPUT_ACTIVE.into(), resume_mode: self.mode(true) })
    }

    fn mode(&self, idle_resumable: bool) -> ComputerResumeMode {
        if idle_resumable && !self.interval().is_zero() { ComputerResumeMode::Idle } else { ComputerResumeMode::Manual }
    }

    /// `manualResume`: with no idle interval only the person's Resume ends a yield.
    fn manual(&self) -> bool {
        self.interval().is_zero()
    }

    /// Wakes the waits.
    fn wake(&self) {
        self.changes.send_modify(|count| *count += 1);
    }

    /// Wakes the waits and tells the pool to publish the section.
    fn changed(&self) {
        self.wake();
        let listener = locked(&self.listener).clone();
        if let Some(listener) = listener {
            listener();
        }
    }

    /// The session's execution opened (`beginCommand`). The pool publishes the section along with its own presence.
    pub fn session_began(&self, session: &str) {
        locked(&self.inner).open.insert(session.to_owned());
    }

    /// The session's execution ended (`forgetSession`): its yield goes with it, and a Stop is done once no session is left
    /// (`clearTakeoverReasonWhenIdle`), as is an environment takeover; any other hold, the person's pause among them, ends with the
    /// last session it was taken for (`releaseEndedPause`). The pool publishes the section along with its own presence.
    pub fn session_ended(&self, session: &str) {
        {
            let mut inner = locked(&self.inner);
            inner.open.remove(session);
            inner.yielded.remove(session);
            // `releaseEndedPause`: a turn that ended while held has nothing left to resume, so the hold ends with the last session
            // it was taken for. A Stop confirms its own cleanup and resumes itself, and input that may still be held stays with
            // the person (a latched cleanup, `input_cleanup_unconfirmed`).
            let latched = !inner.latched.is_empty();
            if let Some(takeover) = inner.takeover.as_mut()
                && takeover.paused.remove(session)
                && takeover.paused.is_empty()
                && !latched
                && takeover.reason != USER_STOP
                && takeover.reason != TAKEOVER_CODES[0]
            {
                inner.takeover = None;
            }
            if inner.open.is_empty() && inner.takeover.as_ref().is_some_and(|takeover| takeover.reason == USER_STOP || ENVIRONMENT_REASONS.contains(&takeover.reason.as_str())) {
                inner.takeover = None;
            }
        }
        self.wake();
    }

    /// `pauseForUser`: every session's input is refused until Resume. False when no session has an open execution, which leaves
    /// nothing to hold.
    fn take_over(&self, reason: &str, idle_resumable: bool) -> bool {
        self.hold(reason, idle_resumable, false)
    }

    /// The takeover itself; `always` holds even with no open execution.
    fn hold(&self, reason: &str, idle_resumable: bool, always: bool) -> bool {
        {
            let mut inner = locked(&self.inner);
            if inner.open.is_empty() && !always {
                return false;
            }
            // The whole desktop is now held, which covers every yielded session.
            inner.yielded.clear();
            inner.takeovers += 1;
            // `pauseForUser`: the sessions an earlier hold waited for stay paused along with every open one.
            let mut paused = inner.open.clone();
            if let Some(earlier) = inner.takeover.take() {
                paused.extend(earlier.paused);
            }
            inner.takeover = Some(Takeover { reason: reason.to_owned(), idle_resumable, paused });
        }
        self.changed();
        true
    }

    /// `lifecycle-abort.ts:unconfirmedCleanup`: a helper cleanup that did not confirm holds the desktop for the person, also
    /// when the aborted session's execution has already closed (`pauseForUser(reason, [sessionId])`); only Resume ends it.
    pub(super) fn cleanup_unconfirmed(&self, session: &str) {
        locked(&self.inner).latched.insert(session.to_owned());
        self.hold(TAKEOVER_CODES[0], false, true);
    }

    /// The pill's Stop: holds the desktop and ends every wait. False when no session is using the computer.
    pub fn stop(&self) -> bool {
        self.take_over(USER_STOP, false)
    }

    /// The pause the pill takes when its control renderer dies (`takeOver('user_pause')`): the desktop is held like a Stop's, but
    /// the reason is `user_pause`, so a waiting `wait_for_user` keeps waiting (the task is not cancelled), and the hold lasts until
    /// Resume or until the last session it waits for ends (`releaseEndedPause`). False when no session is using the computer.
    pub fn pause(&self) -> bool {
        self.take_over(USER_PAUSE, false)
    }

    /// `bindComputerEnvironmentGuard`: the screen locked, the machine slept (`desktop_unavailable`) or a display changed
    /// (`display_changed`), which invalidates what the sessions observed. Every session's input is refused like a Stop's, but
    /// the desktop never resumes by itself (only Resume ends it) and no wait is cancelled. False for another reason, or when no
    /// session is using the computer.
    pub fn take_over_environment(&self, reason: &str) -> bool {
        ENVIRONMENT_REASONS.contains(&reason) && self.take_over(reason, false)
    }

    /// The pill's Resume (`resumeAfterUserTakeover`, `resumeYielded`): ends a takeover, else the yield of `session`, or of every
    /// session. False when there was nothing to resume.
    pub fn resume(&self, session: Option<&str>) -> bool {
        let resumed = {
            let mut inner = locked(&self.inner);
            if inner.takeover.take().is_some() {
                true
            } else if let Some(session) = session {
                inner.yielded.remove(session)
            } else {
                let any = !inner.yielded.is_empty();
                inner.yielded.clear();
                any
            }
        };
        if resumed {
            self.changed();
        }
        resumed
    }

    /// `yieldSession`: the session waits until the desktop is quiet. False while the whole desktop is held, which holds it
    /// anyway.
    fn yield_session(&self, session: &str) -> bool {
        {
            let mut inner = locked(&self.inner);
            if inner.takeover.is_some() {
                return false;
            }
            if !inner.yielded.insert(session.to_owned()) {
                return true;
            }
            inner.yields += 1;
        }
        self.changed();
        true
    }

    fn round(&self) -> (u64, u64) {
        let inner = locked(&self.inner);
        (inner.takeovers, inner.yields)
    }

    /// Whether `session`'s hold ends by itself once the desktop has been idle (`isIdleResumable`).
    fn idle_resumable(&self, session: &str) -> bool {
        let inner = locked(&self.inner);
        !self.interval().is_zero() && inner.takeover.as_ref().map_or_else(|| inner.yielded.contains(session), |takeover| takeover.idle_resumable)
    }

    /// The idle-resume of the hold measured in `round`: ends a takeover, else every yield (`resume`, `resumeYielded`). Nothing
    /// ends when a newer hold began meanwhile.
    fn idle_resume(&self, round: (u64, u64)) -> bool {
        let resumed = {
            let mut inner = locked(&self.inner);
            if (inner.takeovers, inner.yields) != round {
                false
            } else if let Some(resumable) = inner.takeover.as_ref().map(|takeover| takeover.idle_resumable) {
                if resumable {
                    inner.takeover = None;
                }
                resumable
            } else {
                let any = !inner.yielded.is_empty();
                inner.yielded.clear();
                any
            }
        };
        if resumed {
            self.changed();
        }
        resumed
    }

    /// What holds `action` of `session` back.
    fn blocked(&self, session: &str, action: &str) -> Option<Block> {
        let inner = locked(&self.inner);
        if inner.takeover.is_some() {
            // `wait_for_user` is no command of the coordinator's (`createComputerUserWait`).
            return (action != "wait_for_user" && !RECOVERY_READS.contains(&action)).then_some(Block::Takeover);
        }
        (inner.yielded.contains(session) && !computer_lane::observes_only(action)).then_some(Block::Yielded)
    }

    fn standing(&self, session: &str) -> Standing {
        let inner = locked(&self.inner);
        match &inner.takeover {
            Some(takeover) if takeover.reason == USER_STOP => Standing::Cancelled,
            Some(_) => Standing::Held,
            None if inner.yielded.contains(session) => Standing::Held,
            None => Standing::Resumed,
        }
    }

    /// The gate every command passes before it dispatches (`waitUntilRunnable`, `executeAttempt`): `None` lets it run, a reply
    /// ends it. A hold whose person has been idle long enough is resumed here first, as the Node host's sampler would have. A
    /// held desktop refuses with an error; a yielded session is answered with the yield.
    pub(super) async fn admit(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Option<Vec<ToolPart>>, ComputerError> {
        let action = text(command, "action");
        match self.blocked_now(backend, command, cancel).await? {
            None => Ok(None),
            Some(Block::Takeover) if self.paused_by_user() => self.park(backend, command, cancel).await,
            Some(Block::Takeover) => Err(takeover_refusal()),
            Some(Block::Yielded) => Ok(Some(reply(yielded_payload(refusal_payload(action, text(command, "window_id"), false), self.manual())))),
        }
    }

    /// A request meeting the person's pause parks before it takes the desktop's lane (`command-queue.ts` parks outside it), so
    /// the other sessions' requests and a Release are not held behind it for the pause's budget. `None` leaves the request to go
    /// on (to the lane and the gate); a reply ends it.
    pub(super) async fn park_before_lane(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Option<Vec<ToolPart>>, ComputerError> {
        // Any other hold is met at the gate in the lane, so its recovery and idle resume run once (`recoverBeforeCommand`).
        if !self.paused_by_user() {
            return Ok(None);
        }
        match self.blocked_now(backend, command, cancel).await? {
            Some(Block::Takeover) if self.paused_by_user() => self.park(backend, command, cancel).await,
            _ => Ok(None),
        }
    }

    /// What holds the command back now, after the recovery and the idle resume that may lift the hold first.
    async fn blocked_now(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Option<Block>, ComputerError> {
        let session = backend.config.session_id.as_str();
        let action = text(command, "action");
        // `recoverBeforeCommand`: a cleanup left latched with no other session open and nobody waiting (nobody to resume it) gets
        // one more verified recovery before a command is refused for it. The asking session's own execution opened before this
        // gate, as Node's activity of the command does only after it.
        let unattended = {
            let inner = locked(&self.inner);
            inner.open.iter().all(|open| open == session) && inner.waiting.is_empty()
        };
        if unattended && self.is_latched() && self.recover_latched().await {
            self.release_cleanup_hold();
        }
        let mut blocked = self.blocked(session, action);
        if blocked.is_some() && self.idle_resumable(session) {
            match self.resume_when_quiet(backend, cancel).await {
                Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
                Ok(true) => blocked = self.blocked(session, action),
                _ => {}
            }
        }
        // `queueCommand`: a session that asks while the desktop is held is one of the sessions the hold waits for.
        if matches!(blocked, Some(Block::Takeover))
            && let Some(takeover) = locked(&self.inner).takeover.as_mut()
        {
            takeover.paused.insert(session.to_owned());
        }
        Ok(blocked)
    }

    /// The person's own pause holds the desktop (`pausedForUserInput`): a request waits it out instead of being refused.
    fn paused_by_user(&self) -> bool {
        locked(&self.inner).takeover.as_ref().is_some_and(|takeover| takeover.reason == USER_PAUSE)
    }

    /// `waitUntilRunnable` + `attemptUntilSettled`: a request meeting the person's pause parks, never dispatched, until Resume
    /// (it then answers with the pending-work reply, since the desktop changed hands) or until `PAUSE_WAIT` passes (it then
    /// answers `paused` and will not dispatch later). A read that only observes runs once the pause ended (`None`), as a changed
    /// takeover generation stales only input (`runAttempt`). A hold that becomes any other takeover refuses it; a cancelled turn
    /// ends it.
    async fn park(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Option<Vec<ToolPart>>, ComputerError> {
        let mut changes = self.changes.subscribe();
        let deadline = Instant::now() + PAUSE_WAIT;
        loop {
            let held = locked(&self.inner).takeover.as_ref().map(|takeover| takeover.reason.clone());
            match held {
                None => break,
                Some(reason) if reason != USER_PAUSE => return Err(takeover_refusal()),
                Some(_) => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(Some(reply(paused_work_reply(command, USER_PAUSE))));
            }
            tokio::select! {
                () = cancel.cancelled() => return Err(ComputerError::Cancelled),
                _ = changes.changed() => {}
                () = sleep(deadline - now) => {}
            }
        }
        if computer_lane::observes_only(text(command, "action")) {
            return Ok(None);
        }
        self.pending_work(backend, command, cancel).await.map(Some)
    }

    /// `recaptureRequiredReply` + `pendingWorkReply`: the fresh look at the request's window, with what the request still has to do.
    async fn pending_work(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let window = text(command, "window_id");
        let mut images = Vec::new();
        let observation = if window.is_empty() {
            failed_observation("exact target window is unavailable for recapture")
        } else {
            let mut capture = Map::new();
            capture.insert("action".into(), json!("capture"));
            capture.insert("window_id".into(), json!(window));
            match backend.capture(capture, "", cancel).await {
                Ok(parts) => {
                    let mut parts = parts.into_iter();
                    match parts.next() {
                        Some(ToolPart::Text(body)) => match serde_json::from_str::<Value>(&body) {
                            Ok(Value::Object(observation)) => {
                                images.extend(parts);
                                observation
                            }
                            _ => failed_observation("the recapture reply was not readable"),
                        },
                        _ => failed_observation("the recapture reply was not readable"),
                    }
                }
                Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
                Err(ComputerError::Failed { message, .. }) => failed_observation(&message),
                Err(other) => failed_observation(&format!("{other:?}")),
            }
        };
        let (payload, fresh) = pending_work_reply(command, observation);
        let mut parts = reply(payload);
        if fresh {
            parts.extend(images);
        }
        Ok(parts)
    }

    /// What a command's result means for the person's hold (`failedAttempt`, `runAttempt`): the person's input interrupting a
    /// foreground action yields its session, and a takeover code hands the desktop back after the helper's cleanup. Any other
    /// result stands.
    pub(super) async fn settle(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, result: Result<Vec<ToolPart>, ComputerError>) -> Result<Vec<ToolPart>, ComputerError> {
        let observes = computer_lane::observes_only(text(command, "action"));
        match interrupt(command, observes, &result) {
            None => result,
            Some(Interrupt::UserInput(payload)) => {
                // A background action only ever refuses; a foreground one's session waits for the person to be idle.
                let yielded = computer_lane::drives_foreground(command) && !observes && self.yield_session(&backend.config.session_id);
                Ok(reply(if yielded { yielded_payload(payload, self.manual()) } else { payload }))
            }
            Some(Interrupt::Takeover { code, error }) => {
                let confirmed = backend.retire().await;
                if !confirmed {
                    locked(&self.inner).latched.insert(backend.config.session_id.clone());
                }
                self.take_over(&code, confirmed);
                Err(error)
            }
        }
    }

    /// One look at the person's input: whether the desktop has been idle for the interval, confirmed by a second reading of the
    /// same observer with nothing held (`recheck`). A reading that cannot be trusted is an error.
    async fn quiet(&self, backend: &ProcessComputerBackend, cancel: &CancellationToken) -> Result<bool, ComputerError> {
        let observe = || async {
            let started = Instant::now();
            let result = backend.host_read("input_idle_state", Vec::new(), None, cancel).await?;
            match Idle::of(&result) {
                Some(idle) if started.elapsed() <= SLOW_READING => Ok(idle),
                _ => Err(ComputerError::Failed { code: "input_observation_unavailable".into(), message: "input_observation_unavailable: the idle state could not be read".into() }),
            }
        };
        let first = observe().await?;
        if first.desktop_locked || first.held || first.idle < self.interval() {
            return Ok(false);
        }
        let last = observe().await?;
        Ok(!last.desktop_locked && !last.held && first.same(&last) && last.idle >= self.interval())
    }

    /// Resumes the hold when the desktop has been quiet. True when it resumed.
    async fn resume_when_quiet(&self, backend: &ProcessComputerBackend, cancel: &CancellationToken) -> Result<bool, ComputerError> {
        let round = self.round();
        Ok(self.quiet(backend, cancel).await? && self.idle_resume(round))
    }

    /// `wait_for_user` (`createUserWaitService.command`): waits until the session may act again, the person stops everything,
    /// the turn is cancelled or `timeout_ms` passes, and says which. It never replays input.
    pub(super) async fn wait_for_user(&self, backend: &ProcessComputerBackend, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let invalid = |message: &str| ComputerError::Failed { code: "invalid_request".into(), message: format!("invalid_request: {message}") };
        if command.keys().any(|key| !["action", "session_id", "timeout_ms"].contains(&key.as_str())) {
            return Err(invalid("wait_for_user accepts only timeout_ms"));
        }
        let timeout = match command.get("timeout_ms") {
            None => DEFAULT_WAIT_MS,
            Some(value) => value
                .as_f64()
                .filter(|ms| ms.fract() == 0.0 && (0.0..=MAX_WAIT_MS).contains(ms))
                .map(|ms| ms as u64)
                .ok_or_else(|| invalid("timeout_ms must be 0..120000"))?,
        };
        let status = self.wait(backend, Duration::from_millis(timeout), cancel).await?;
        let resumed = status == "resumed";
        let reason = locked(&self.inner).takeover.as_ref().map(|takeover| takeover.reason.clone()).unwrap_or_default();
        let payload = json!({
            "ok": true,
            "action": "wait_for_user",
            "status": status,
            "resumed": resumed,
            "fresh_capture_required": resumed,
            "input_replayed": false,
            "reason": reason,
        });
        Ok(vec![ToolPart::Text(payload.to_string())])
    }

    /// The wait's status: `resumed`, `cancelled` or `timeout`.
    async fn wait(&self, backend: &ProcessComputerBackend, timeout: Duration, cancel: &CancellationToken) -> Result<&'static str, ComputerError> {
        let session = backend.config.session_id.as_str();
        let mut changes = self.changes.subscribe();
        if cancel.is_cancelled() {
            return Ok("cancelled");
        }
        if let Some(status) = self.standing(session).status() {
            return Ok(status);
        }
        let _waiting = Waiting::enter(self, session)?;
        let deadline = Instant::now() + timeout;
        let mut failures = 0;
        loop {
            if let Some(status) = self.standing(session).status() {
                return Ok(status);
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok("timeout");
            }
            let mut pause = deadline - now;
            if self.idle_resumable(session) {
                match self.resume_when_quiet(backend, cancel).await {
                    Ok(true) => continue,
                    Err(ComputerError::Cancelled) => return Ok("cancelled"),
                    // A failing observer can delay the resume but never cause it.
                    Err(_) => failures += 1,
                    Ok(false) => failures = 0,
                }
                pause = pause.min(if failures >= FAILURES_BEFORE_SLOWING { FAILING_SAMPLE_INTERVAL } else { SAMPLE_INTERVAL });
            }
            tokio::select! {
                () = cancel.cancelled() => return Ok("cancelled"),
                _ = changes.changed() => {}
                () = sleep(pause) => {}
            }
        }
    }
}

/// A session inside `wait_for_user`: one wait per session, and a few in all.
struct Waiting<'a> {
    control: &'a UserControlState,
    session: String,
}

impl<'a> Waiting<'a> {
    fn enter(control: &'a UserControlState, session: &str) -> Result<Self, ComputerError> {
        let mut inner = locked(&control.inner);
        if inner.waiting.contains(session) || inner.waiting.len() >= MAX_WAITERS {
            return Err(ComputerError::Failed {
                code: "computer_capacity_exhausted".into(),
                message: "computer_capacity_exhausted: user wait already active or full".into(),
            });
        }
        inner.waiting.insert(session.to_owned());
        Ok(Self { control, session: session.to_owned() })
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        locked(&self.control.inner).waiting.remove(&self.session);
    }
}

/// The refusal of a held desktop (`assertAutomationAllowed`).
fn takeover_refusal() -> ComputerError {
    ComputerError::Failed { code: TAKEOVER_CODE.into(), message: format!("{TAKEOVER_CODE}: Computer Use is paused while the user has control") }
}

/// The observation of a recapture that could not be taken (`{ ok: false, action: 'capture', error }`).
fn failed_observation(error: &str) -> Map<String, Value> {
    let mut observation = Map::new();
    observation.insert("ok".into(), json!(false));
    observation.insert("action".into(), json!("capture"));
    observation.insert("error".into(), json!(error));
    observation
}

/// `workProgress` of a request that was parked before it dispatched anything: no step ran, none is uncertain.
fn work_progress(command: &Map<String, Value>) -> Map<String, Value> {
    let single = [Value::Object(command.clone())];
    let steps: &[Value] = match command.get("steps") {
        Some(Value::Array(steps)) => steps,
        _ => &single,
    };
    let listed: Vec<Value> = steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut row = Map::new();
            row.insert("index".into(), json!(index + 1));
            if let Some(action) = step.get("action") {
                row.insert("action".into(), action.clone());
            }
            row.insert("status".into(), json!("pending"));
            Value::Object(row)
        })
        .collect();
    let mut progress = Map::new();
    progress.insert("completed".into(), json!(steps.is_empty()));
    progress.insert("completed_steps".into(), json!(0));
    progress.insert("total_steps".into(), json!(steps.len()));
    progress.insert("input_replayed".into(), json!(false));
    progress.insert("steps".into(), Value::Array(listed));
    progress.insert("pending_work".into(), json!({"completed_steps": 0, "pending_steps": (1..=steps.len()).collect::<Vec<_>>()}));
    progress
}

/// `pausedWorkReply`: ends a request whose pause budget ran out, without ending the person's pause. It will not dispatch later.
fn paused_work_reply(command: &Map<String, Value>, reason: &str) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("ok".into(), json!(true));
    payload.insert("action".into(), json!(text(command, "action")));
    payload.insert("status".into(), json!("paused"));
    payload.insert("code".into(), json!("computer_user_intervention_pending"));
    payload.extend(work_progress(command));
    payload.insert("completed".into(), json!(false));
    payload.insert("reason".into(), json!(reason));
    payload.insert("fresh_capture_required".into(), json!(true));
    payload.insert("verdict".into(), json!({"decision": "wait_for_user", "recommended": "wait_for_user"}));
    payload.insert(
        "recovery".into(),
        json!({
            "next": "wait_for_user",
            "guidance": "User control is still active. This request stopped waiting and will not dispatch later. The configured idle/manual resume route remains available. Wait for confirmed resume, capture fresh state, and continue only the remaining intent. Completed or uncertain input must never be resent blindly.",
        }),
    );
    payload
}

/// `buildRecaptureRequiredPayload` + `pendingWorkReply`: the reply of a request that waited for the person's pause to end, with
/// whether the observation it carries is fresh. A fresh observation is a successful capture of a window; any other one is cut to
/// the fields that say why it failed (`failedRecaptureObservation`).
fn pending_work_reply(command: &Map<String, Value>, observation: Map<String, Value>) -> (Map<String, Value>, bool) {
    const FAILED_FIELDS: [&str; 11] = [
        "ok",
        "action",
        "code",
        "error",
        "window_id",
        "requested_window_id",
        "capture_target_reason",
        "pixel_status",
        "pixel_unavailable",
        "accessibility_status",
        "accessibility_error",
    ];
    // `isFreshRecaptureObservation`: a capture of a named window, the request's own when it named one.
    let named = |key: &str| observation.get(key).and_then(Value::as_str).filter(|id| !id.is_empty());
    let expected = text(command, "window_id");
    let ok = observation.get("ok") == Some(&Value::Bool(true));
    let fresh = ok
        && observation.get("action") == Some(&json!("capture"))
        && named("requested_window_id").or_else(|| named("window_id")).is_some_and(|target| expected.is_empty() || target == expected);
    // A successful capture of another window is not reported at all; a failed one only by the fields that say why.
    let observation: Option<Map<String, Value>> = if fresh {
        Some(observation)
    } else if ok {
        None
    } else {
        Some(observation.into_iter().filter(|(field, _)| FAILED_FIELDS.contains(&field.as_str())).collect())
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), json!(fresh));
    payload.insert("action".into(), json!(text(command, "action")));
    payload.insert("code".into(), json!(RESUME_RECAPTURE_CODE));
    payload.insert("verdict".into(), json!({"decision": if fresh { "verify_fresh_state" } else { "escalate" }, "recommended": if fresh { "continue_pending_work" } else { "recapture" }}));
    payload.insert(
        "recovery".into(),
        json!({
            "next": if fresh { "continue_from_observation" } else { "capture" },
            "guidance": "The request waited for user control to end. Keep the task active. Use the fresh observation to check the target, focus and remaining intent, then continue pending steps. Completed steps must not be replayed. An uncertain step may already have dispatched input: resolve its effect before deciding what remains. Never resend it blindly.",
        }),
    );
    if let Some(observation) = observation {
        payload.insert("observation".into(), Value::Object(observation));
    }
    payload.insert("status".into(), json!("resumed"));
    payload.extend(work_progress(command));
    (payload, fresh)
}

/// A reply object as a result (`{ text: JSON.stringify(payload) }`).
fn reply(payload: Map<String, Value>) -> Vec<ToolPart> {
    vec![ToolPart::Text(Value::Object(payload).to_string())]
}

/// What interrupted `result`, if anything: the person's input (an error of the helper, or a reply that carries the code, as a
/// sequence's does) or a takeover code. A takeover code of a read is no takeover (`observesOnly`).
fn interrupt(command: &Map<String, Value>, observes: bool, result: &Result<Vec<ToolPart>, ComputerError>) -> Option<Interrupt> {
    let takes_over = |code: &str| TAKEOVER_CODES.contains(&code) && !observes;
    match result {
        Err(ComputerError::Failed { code, message }) if code == USER_INPUT_ACTIVE => {
            Some(Interrupt::UserInput(refusal_payload(text(command, "action"), text(command, "window_id"), !observes && !message.contains(SUPERSEDED))))
        }
        Err(error @ ComputerError::Failed { code, .. }) if takes_over(code) => Some(Interrupt::Takeover { code: code.clone(), error: error.clone() }),
        Ok(parts) => {
            let Some(ToolPart::Text(body)) = parts.first() else { return None };
            if !body.contains(USER_INPUT_ACTIVE) && !TAKEOVER_CODES.iter().any(|code| body.contains(code)) {
                return None;
            }
            let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(body) else { return None };
            let code = payload.get("code").and_then(Value::as_str)?.to_owned();
            if code == USER_INPUT_ACTIVE {
                return Some(Interrupt::UserInput(payload));
            }
            let message = payload.get("message").and_then(Value::as_str).unwrap_or("reported by the native result");
            let error = ComputerError::Failed { code: code.clone(), message: format!("{code}: {message}") };
            takes_over(&code).then_some(Interrupt::Takeover { code, error })
        }
        _ => None,
    }
}

/// `userInputRefusalPayload`: the reply for an action the person's own input interrupted. It refuses only that action, never
/// invites a replay, and asks for a fresh observation before any further input.
fn refusal_payload(action: &str, window_id: &str, input_may_have_executed: bool) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("ok".into(), json!(false));
    payload.insert("action".into(), json!(action));
    if !window_id.is_empty() {
        payload.insert("window_id".into(), json!(window_id));
    }
    payload.insert("code".into(), json!(USER_INPUT_ACTIVE));
    payload.insert("effect".into(), json!("unverifiable"));
    payload.insert("verified".into(), json!(false));
    payload.insert("input_may_have_executed".into(), json!(input_may_have_executed));
    payload.insert(
        "message".into(),
        json!(if input_may_have_executed {
            "user input interrupted this action; its input may have landed. Capture fresh state before any further input; do not replay it"
        } else {
            "user input interrupted this action; no input was sent. Capture fresh state before acting"
        }),
    );
    payload.insert("verdict".into(), json!({"decision": "escalate", "recommended": "recapture"}));
    payload.insert("capture_skipped".into(), json!(USER_INPUT_ACTIVE));
    payload
}

/// `yieldedUserInputPayload`: the reply for a foreground action the person's input interrupted. Only this session waits, and it
/// continues by itself once the person has been idle (or, with that off, until they press Resume); the reply says which, so the
/// model neither retries at once nor gives up.
fn yielded_payload(mut payload: Map<String, Value>, manual: bool) -> Map<String, Value> {
    let sent = payload.get("input_may_have_executed") != Some(&Value::Bool(false));
    payload.insert("status".into(), json!("yielded"));
    payload.insert("yielded".into(), json!(true));
    payload.insert("resume_mode".into(), json!(if manual { "manual" } else { "idle" }));
    let resume = if manual {
        "this agent is waiting for the user to press Resume on the overlay and does not continue by itself."
    } else {
        "this agent continues by itself once the user has been idle."
    };
    let landed = if sent { "The user's input interrupted the action and its input may have landed; it will not be replayed." } else { "No input was sent." };
    payload.insert("message".into(), json!(format!("Computer Use yielded to the user's input; {resume} {landed} Call wait_for_user, then capture fresh state before acting")));
    payload.insert("verdict".into(), json!({"decision": "wait_for_user", "recommended": "wait_for_user"}));
    payload
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::ComputerShared;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn payload_of(parts: &[ToolPart]) -> Value {
        let ToolPart::Text(body) = &parts[0] else { panic!("a text part") };
        serde_json::from_str(body).unwrap()
    }

    fn idle_reading(idle_ms: u64) -> Result<Value, String> {
        Ok(json!({"ready": true, "observer_ready": true, "desktop_ready": true, "monitor": "m1", "sequence": 3, "idleMs": idle_ms, "held": false}))
    }

    /// A session's backend over `manager` that shares `control`, whose execution is open.
    fn session(manager: &Arc<Scripted>, control: &Arc<UserControlState>, name: &str) -> ProcessComputerBackend {
        control.session_began(name);
        let shared = ComputerShared { user_control: control.clone(), ..ComputerShared::default() };
        ProcessComputerBackend::new(ComputerConfig::new("helper", name), manager.clone()).with_shared(shared)
    }

    fn interrupted() -> Result<Vec<ToolPart>, ComputerError> {
        Err(ComputerError::Failed { code: USER_INPUT_ACTIVE.into(), message: "user_input_active: external input interrupted this action".into() })
    }

    fn cleanup_failed() -> Result<Vec<ToolPart>, ComputerError> {
        Err(ComputerError::Failed { code: "input_cleanup_unconfirmed".into(), message: "input_cleanup_unconfirmed: a held key could not be released".into() })
    }

    fn focus() -> Map<String, Value> {
        object(json!({"action": "focus_window", "window_id": "hwnd:0x2"}))
    }

    fn click_in_background() -> Map<String, Value> {
        object(json!({"action": "click", "x": 1, "y": 2, "delivery": "background"}))
    }

    fn wait_for_user(timeout_ms: Value) -> Map<String, Value> {
        object(json!({"action": "wait_for_user", "timeout_ms": timeout_ms}))
    }

    /// A helper that answers every request with `ok`.
    fn quiet_helper() -> Arc<Scripted> {
        Scripted::new(|_| Ok(json!({"text": "ok"})))
    }

    /// The refusal and the yield read as the Node host's (`user-input-refusal.ts`).
    #[test]
    fn the_payloads_are_the_hosts() {
        let refusal = refusal_payload("click", "hwnd:0x2", true);
        assert_eq!(
            Value::Object(refusal.clone()),
            json!({
                "ok": false, "action": "click", "window_id": "hwnd:0x2", "code": "user_input_active", "effect": "unverifiable", "verified": false,
                "input_may_have_executed": true,
                "message": "user input interrupted this action; its input may have landed. Capture fresh state before any further input; do not replay it",
                "verdict": {"decision": "escalate", "recommended": "recapture"}, "capture_skipped": "user_input_active",
            })
        );
        let idle = yielded_payload(refusal, false);
        assert_eq!(idle["status"], "yielded");
        assert_eq!(idle["resume_mode"], "idle");
        assert_eq!(
            idle["message"],
            "Computer Use yielded to the user's input; this agent continues by itself once the user has been idle. The user's input interrupted the action and its input may have landed; it will not be replayed. Call wait_for_user, then capture fresh state before acting"
        );
        assert_eq!(idle["verdict"], json!({"decision": "wait_for_user", "recommended": "wait_for_user"}));
        let manual = yielded_payload(refusal_payload("click", "", false), true);
        assert!(manual.get("window_id").is_none());
        assert_eq!(manual["resume_mode"], "manual");
        assert_eq!(
            manual["message"],
            "Computer Use yielded to the user's input; this agent is waiting for the user to press Resume on the overlay and does not continue by itself. No input was sent. Call wait_for_user, then capture fresh state before acting"
        );
    }

    /// A foreground action the person interrupts yields its own session alone; the idle desktop resumes it after the interval,
    /// and the wait says so.
    #[tokio::test(start_paused = true)]
    async fn a_yield_resumes_once_the_desktop_has_been_idle() {
        let started = Instant::now();
        let manager = Scripted::new(move |request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        let (a, b) = (session(&manager, &control, "a"), session(&manager, &control, "b"));
        let cancel = CancellationToken::new();

        let yielded = payload_of(&control.settle(&a, &focus(), interrupted()).await.unwrap());
        assert_eq!(yielded["status"], "yielded");
        assert_eq!(yielded["resume_mode"], "idle");
        assert_eq!(yielded["input_may_have_executed"], true);
        assert_eq!(control.section(), Some(ComputerUserControlSection { active: false, reason: "user_input_active".into(), resume_mode: ComputerResumeMode::Idle }));
        // Only that session waits; it sends nothing, and says so.
        let refused = control.admit(&a, &focus(), &cancel).await.unwrap().expect("the yielded session is refused");
        assert_eq!(payload_of(&refused)["input_may_have_executed"], false);
        assert!(control.admit(&b, &focus(), &cancel).await.unwrap().is_none());
        assert!(control.admit(&a, &object(json!({"action": "list_windows"})), &cancel).await.unwrap().is_none(), "reads stay open");

        let waited = payload_of(&control.wait_for_user(&a, &wait_for_user(json!(60_000)), &cancel).await.unwrap());
        assert_eq!(waited, json!({"ok": true, "action": "wait_for_user", "status": "resumed", "resumed": true, "fresh_capture_required": true, "input_replayed": false, "reason": ""}));
        let elapsed = started.elapsed();
        assert!(elapsed >= DEFAULT_IDLE_RESUME && elapsed <= DEFAULT_IDLE_RESUME + Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(control.section(), None);
        assert!(control.admit(&a, &focus(), &cancel).await.unwrap().is_none());
    }

    /// A yield also ends where the next command meets it, with no wait: the desktop has been idle.
    #[tokio::test(start_paused = true)]
    async fn a_command_that_meets_a_yield_on_an_idle_desktop_runs() {
        let manager = Scripted::new(|request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(9_000),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        let a = session(&manager, &control, "a");
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        assert!(control.admit(&a, &focus(), &CancellationToken::new()).await.unwrap().is_none());
        assert_eq!(control.section(), None);
    }

    /// The person still typing keeps the yield until the wait runs out.
    #[tokio::test(start_paused = true)]
    async fn an_active_desktop_keeps_the_yield_until_the_wait_times_out() {
        let manager = Scripted::new(|request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(100),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        let a = session(&manager, &control, "a");
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        let waited = payload_of(&control.wait_for_user(&a, &wait_for_user(json!(3_000)), &CancellationToken::new()).await.unwrap());
        assert_eq!(waited["status"], "timeout");
        assert_eq!(waited["resumed"], false);
        assert!(control.section().is_some());
    }

    /// A background action's interruption only refuses it, and the reply of a sequence that stopped on the person's input yields.
    #[tokio::test]
    async fn a_background_interruption_refuses_without_yielding() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::default());
        let a = session(&manager, &control, "a");
        let refused = payload_of(&control.settle(&a, &click_in_background(), interrupted()).await.unwrap());
        assert_eq!(refused["code"], "user_input_active");
        assert!(refused.get("status").is_none());
        assert_eq!(control.section(), None);
        // An admission refusal sent nothing.
        let superseded = Err(ComputerError::Failed { code: USER_INPUT_ACTIVE.into(), message: "user_input_active: observation was superseded by external input".into() });
        assert_eq!(payload_of(&control.settle(&a, &click_in_background(), superseded).await.unwrap())["input_may_have_executed"], false);
        // A sequence reports the person's input in its reply instead of an error.
        let in_reply = Ok(vec![ToolPart::Text(json!({"ok": false, "code": "user_input_active", "input_may_have_executed": true}).to_string())]);
        let sequence = object(json!({"action": "sequence", "delivery": "foreground", "steps": [{"action": "key", "text": "a"}]}));
        assert_eq!(payload_of(&control.settle(&a, &sequence, in_reply).await.unwrap())["status"], "yielded");
        assert!(control.section().is_some());
    }

    /// A cleanup the helper could not confirm hands the whole desktop back: every session is refused, a recovery read and the
    /// wait are not, until Resume.
    #[tokio::test(start_paused = true)]
    async fn a_takeover_blocks_every_session_until_resume() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let (a, b) = (session(&manager, &control, "a"), session(&manager, &control, "b"));
        let cancel = CancellationToken::new();

        let ended = control.settle(&a, &click_in_background(), cleanup_failed()).await;
        assert!(matches!(ended, Err(ComputerError::Failed { ref code, .. }) if code == "input_cleanup_unconfirmed"), "the command still ends in its own error");
        assert_eq!(control.section(), Some(ComputerUserControlSection { active: true, reason: "input_cleanup_unconfirmed".into(), resume_mode: ComputerResumeMode::Manual }));
        for backend in [&a, &b] {
            assert_eq!(
                control.admit(backend, &click_in_background(), &cancel).await,
                Err(ComputerError::Failed { code: "computer_user_takeover".into(), message: "computer_user_takeover: Computer Use is paused while the user has control".into() })
            );
        }
        assert!(control.admit(&b, &object(json!({"action": "diagnose"})), &cancel).await.unwrap().is_none());

        let waited = payload_of(&control.wait_for_user(&b, &wait_for_user(json!(1_500)), &cancel).await.unwrap());
        assert_eq!(waited["status"], "timeout");
        assert_eq!(waited["reason"], "input_cleanup_unconfirmed");
        assert!(control.resume(None));
        assert_eq!(control.section(), None);
        assert!(control.admit(&b, &click_in_background(), &cancel).await.unwrap().is_none());
        assert!(!control.resume(None), "nothing is left to resume");
    }

    /// A confirmed cleanup lets the desktop resume by itself once idle.
    #[tokio::test(start_paused = true)]
    async fn a_confirmed_takeover_resumes_when_the_desktop_is_idle() {
        let manager = Scripted::new(|request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(60_000),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        let a = session(&manager, &control, "a");
        control.settle(&a, &click_in_background(), cleanup_failed()).await.unwrap_err();
        assert_eq!(control.section().map(|section| section.resume_mode), Some(ComputerResumeMode::Idle));
        let waited = payload_of(&control.wait_for_user(&a, &wait_for_user(json!(10_000)), &CancellationToken::new()).await.unwrap());
        assert_eq!(waited["status"], "resumed");
        assert_eq!(control.section(), None);
    }

    /// A read's takeover code is no takeover, and a returned reply that carries one is classified as a thrown one.
    #[tokio::test]
    async fn only_a_mutation_hands_the_desktop_back() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::default());
        let a = session(&manager, &control, "a");
        assert!(control.settle(&a, &object(json!({"action": "list_windows"})), cleanup_failed()).await.is_err());
        assert_eq!(control.section(), None);
        let reply = Ok(vec![ToolPart::Text(json!({"ok": false, "code": "input_cleanup_unconfirmed", "message": "x"}).to_string())]);
        assert_eq!(
            control.settle(&a, &click_in_background(), reply).await,
            Err(ComputerError::Failed { code: "input_cleanup_unconfirmed".into(), message: "input_cleanup_unconfirmed: x".into() })
        );
        assert!(control.section().is_some_and(|section| section.active));
    }

    /// The wait's own outcomes: nothing to wait for, a cancelled turn, the person's Stop, the bounds of `timeout_ms`.
    #[tokio::test(start_paused = true)]
    async fn the_wait_ends_as_the_hosts_does() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = Arc::new(session(&manager, &control, "a"));
        let b = Arc::new(session(&manager, &control, "b"));
        let status = |parts: Vec<ToolPart>| payload_of(&parts)["status"].clone();
        let cancel = CancellationToken::new();

        assert_eq!(status(control.wait_for_user(&a, &wait_for_user(json!(5)), &cancel).await.unwrap()), json!("resumed"), "nothing holds the session");
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        assert_eq!(status(control.wait_for_user(&a, &wait_for_user(json!(0)), &cancel).await.unwrap()), json!("timeout"));

        let turn = CancellationToken::new();
        let waiting = {
            let (control, a, turn) = (control.clone(), a.clone(), turn.clone());
            tokio::spawn(async move { control.wait_for_user(&a, &wait_for_user(json!(60_000)), &turn).await })
        };
        sleep(Duration::from_secs(1)).await;
        turn.cancel();
        assert_eq!(status(waiting.await.unwrap().unwrap()), json!("cancelled"), "a cancelled turn wakes its wait");

        control.settle(&b, &focus(), interrupted()).await.unwrap();
        let stopped = {
            let (control, b) = (control.clone(), b.clone());
            tokio::spawn(async move { control.wait_for_user(&b, &wait_for_user(json!(60_000)), &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(1)).await;
        assert!(control.stop());
        assert_eq!(status(stopped.await.unwrap().unwrap()), json!("cancelled"), "Stop wakes every wait");
        assert_eq!(control.section().map(|section| section.reason), Some("user_stop".to_owned()));
        control.session_ended("a");
        assert!(control.section().is_some(), "a session is still using the computer");
        control.session_ended("b");
        assert_eq!(control.section(), None, "the Stop is done once no session is left");

        for bad in [json!(-1), json!(120_001), json!(1.5), json!("5"), json!(null)] {
            assert!(matches!(control.wait_for_user(&b, &wait_for_user(bad), &cancel).await, Err(ComputerError::Failed { ref code, .. }) if code == "invalid_request"));
        }
        let extra = object(json!({"action": "wait_for_user", "window_id": "hwnd:0x2"}));
        assert_eq!(
            control.wait_for_user(&b, &extra, &cancel).await,
            Err(ComputerError::Failed { code: "invalid_request".into(), message: "invalid_request: wait_for_user accepts only timeout_ms".into() })
        );
    }

    /// One wait per session, and sixteen in all.
    #[tokio::test(start_paused = true)]
    async fn the_waits_are_bounded() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let backends: Vec<_> = (0..=MAX_WAITERS).map(|n| Arc::new(session(&manager, &control, &format!("s{n}")))).collect();
        for backend in &backends {
            control.settle(backend, &focus(), interrupted()).await.unwrap();
        }
        let cancel = CancellationToken::new();
        let waits: Vec<_> = backends[..MAX_WAITERS]
            .iter()
            .map(|backend| {
                let (control, backend, cancel) = (control.clone(), backend.clone(), cancel.clone());
                tokio::spawn(async move { control.wait_for_user(&backend, &wait_for_user(json!(60_000)), &cancel).await })
            })
            .collect();
        sleep(Duration::from_secs(1)).await;
        let full = Err(ComputerError::Failed { code: "computer_capacity_exhausted".into(), message: "computer_capacity_exhausted: user wait already active or full".into() });
        assert_eq!(control.wait_for_user(&backends[MAX_WAITERS], &wait_for_user(json!(1)), &cancel).await, full);
        assert_eq!(control.wait_for_user(&backends[0], &wait_for_user(json!(1)), &cancel).await, full, "one wait per session");
        cancel.cancel();
        for wait in waits {
            assert_eq!(payload_of(&wait.await.unwrap().unwrap())["status"], "cancelled");
        }
    }

    /// The pill's Resume ends a manual yield for one session or for all, and a Stop with no session using the computer holds
    /// nothing.
    #[tokio::test]
    async fn the_pills_resume_and_stop() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        assert!(!control.stop(), "no session is using the computer");
        let (a, b) = (session(&manager, &control, "a"), session(&manager, &control, "b"));
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        control.settle(&b, &focus(), interrupted()).await.unwrap();
        assert_eq!(control.section().map(|section| section.resume_mode), Some(ComputerResumeMode::Manual));
        assert!(control.resume(Some("a")));
        assert!(!control.resume(Some("a")));
        assert!(control.section().is_some(), "b still yields");
        assert!(control.resume(None));
        assert_eq!(control.section(), None);
        assert!(control.stop());
        assert!(control.resume(Some("a")), "Resume ends a takeover whatever session it names");
    }

    /// The renderer-death pause holds like a Stop but is no cancellation: a wait keeps waiting, and the hold lasts until Resume or
    /// until the last session it was taken for ends (`takeOver('user_pause')`, `releaseEndedPause`).
    #[tokio::test]
    async fn the_pause_holds_without_cancelling() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        assert!(!control.pause(), "no session is using the computer");
        let _a = session(&manager, &control, "a");
        control.session_began("a");
        let b = session(&manager, &control, "b");
        assert!(control.pause());
        assert_eq!(control.section().map(|section| section.reason), Some("user_pause".to_owned()));
        assert!(matches!(control.standing("a"), Standing::Held), "the model is not told it was cancelled");
        control.session_ended("a");
        assert!(control.section().is_some(), "the pause goes on while a session it was taken for is open");
        control.session_ended("b");
        assert_eq!(control.section(), None, "the pause ends with the last session it was taken for (`releaseEndedPause`)");
        assert!(control.admit(&b, &click_in_background(), &CancellationToken::new()).await.unwrap().is_none());
    }

    /// A session that began after the pause is not one it was taken for, and a Stop or a latched cleanup is the person's alone.
    #[tokio::test]
    async fn only_the_sessions_a_pause_was_taken_for_end_it() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        control.session_began("a");
        assert!(control.pause());
        control.session_began("late");
        control.session_ended("a");
        assert_eq!(control.section(), None, "the pause was taken for `a` alone");
        control.session_ended("late");
        control.session_began("a");
        assert!(control.stop());
        control.session_ended("a");
        assert_eq!(control.section(), None, "a Stop with no session left is done");
        let latched = session(&manager, &control, "c");
        control.session_began("c");
        control.cleanup_unconfirmed("c");
        control.session_ended("c");
        assert!(control.section().is_some(), "a cleanup that did not confirm stays until Resume");
        drop(latched);
    }

    /// The listener hears each change of the section, so the pool publishes it.
    #[tokio::test]
    async fn the_listener_hears_every_change() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::default());
        let heard = Arc::new(Mutex::new(Vec::new()));
        let (watched, log) = (control.clone(), heard.clone());
        control.on_change(Arc::new(move || locked(&log).push(watched.section())));
        let a = session(&manager, &control, "a");
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        control.resume(None);
        let yielded = Some(ComputerUserControlSection { active: false, reason: "user_input_active".into(), resume_mode: ComputerResumeMode::Idle });
        assert_eq!(*locked(&heard), [yielded, None]);
    }

    /// A held desktop refuses a whole tool call before anything reaches the helper.
    #[tokio::test]
    async fn a_held_desktop_never_reaches_the_helper() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = session(&manager, &control, "a");
        control.settle(&a, &focus(), cleanup_failed()).await.unwrap_err();
        let focus_window = ComputerRequest { action: ComputerAction::Window, input: json!({"operation": "focus", "window_id": "hwnd:0x2"}) };
        let error = a.run(focus_window, CancellationToken::new()).await.unwrap_err();
        assert!(matches!(error, ComputerError::Failed { ref code, .. } if code == "computer_user_takeover"), "{error:?}");
        assert!(manager.lines().iter().all(|line| line["action"] != "focus_window"), "{:?}", manager.lines());
    }

    /// A request that meets the person's pause parks without dispatching and, once they press Resume, answers with the pending-work
    /// reply: it asks for a fresh capture and replays nothing.
    #[tokio::test(start_paused = true)]
    async fn a_parked_request_answers_with_the_pending_reply_after_resume() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = Arc::new(session(&manager, &control, "a"));
        assert!(control.pause());
        let parked = {
            let (control, a) = (control.clone(), a.clone());
            tokio::spawn(async move { control.admit(&a, &click_in_background(), &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(5)).await;
        assert!(!parked.is_finished(), "the request waits while the pause lasts");
        assert!(control.resume(None));
        let reply = parked.await.unwrap().unwrap().expect("the parked request is answered, not run");
        let payload = payload_of(&reply);
        assert_eq!(payload["code"], "computer_resume_recapture_required");
        assert_eq!(payload["status"], "resumed");
        assert_eq!(payload["ok"], false, "no window to capture again");
        assert_eq!(payload["input_replayed"], false);
        assert_eq!(payload["observation"], json!({"ok": false, "action": "capture", "error": "exact target window is unavailable for recapture"}));
        assert_eq!(payload["pending_work"], json!({"completed_steps": 0, "pending_steps": [1]}));
        assert_eq!(payload["steps"], json!([{"index": 1, "action": "click", "status": "pending"}]));
        assert_eq!(payload["verdict"], json!({"decision": "escalate", "recommended": "recapture"}));
        assert_eq!(payload["recovery"]["next"], "capture");
        assert!(manager.lines().is_empty(), "nothing reached the helper: {:?}", manager.lines());
    }

    /// A fresh capture of the window makes the reply continue from it; a failed one is cut to the fields that say why.
    #[test]
    fn the_pending_reply_follows_the_observation() {
        let command = object(json!({"action": "type", "window_id": "hwnd:0x2"}));
        let (fresh, is_fresh) = pending_work_reply(&command, object(json!({"ok": true, "action": "capture", "window_id": "hwnd:0x2", "elements": [1]})));
        assert!(is_fresh);
        assert_eq!(fresh["ok"], true);
        assert_eq!(fresh["verdict"], json!({"decision": "verify_fresh_state", "recommended": "continue_pending_work"}));
        assert_eq!(fresh["recovery"]["next"], "continue_from_observation");
        assert_eq!(fresh["observation"]["elements"], json!([1]));
        let (failed, is_fresh) = pending_work_reply(&command, object(json!({"ok": false, "action": "capture", "error": "gone", "elements": [1]})));
        assert!(!is_fresh);
        assert_eq!(failed["observation"], json!({"ok": false, "action": "capture", "error": "gone"}));
        assert_eq!(failed["status"], "resumed");
        let (unnamed, is_fresh) = pending_work_reply(&command, object(json!({"ok": true, "action": "capture"})));
        assert!(!is_fresh, "a capture of no window is not fresh");
        assert_eq!(unnamed["ok"], false);
        assert!(unnamed.get("observation").is_none(), "a successful capture that is not fresh is not reported");
        let (other, is_fresh) = pending_work_reply(&command, object(json!({"ok": true, "action": "capture", "window_id": "hwnd:0x9"})));
        assert!(!is_fresh, "a capture of another window is not fresh");
        assert!(other.get("observation").is_none());
        assert_eq!(other["verdict"], json!({"decision": "escalate", "recommended": "recapture"}));
    }

    /// A read parked behind the pause runs once the person resumes: only input is staled by the desktop changing hands.
    #[tokio::test(start_paused = true)]
    async fn a_parked_read_runs_after_resume() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = Arc::new(session(&manager, &control, "a"));
        assert!(control.pause());
        let parked = {
            let (control, a) = (control.clone(), a.clone());
            tokio::spawn(async move { control.admit(&a, &object(json!({"action": "capture", "window_id": "hwnd:0x2"})), &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(1)).await;
        assert!(!parked.is_finished(), "the read waits while the pause lasts");
        assert!(control.resume(None));
        assert_eq!(parked.await.unwrap(), Ok(None), "the read is let through");
    }

    /// The pause budget runs out: the request answers `paused` with every step pending, and the person's pause stays.
    #[tokio::test(start_paused = true)]
    async fn a_request_parked_past_the_budget_answers_paused() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = session(&manager, &control, "a");
        assert!(control.pause());
        let started = Instant::now();
        let sequence = object(json!({"action": "sequence", "steps": [{"action": "key", "text": "a"}, {"action": "key", "text": "b"}]}));
        let reply = control.admit(&a, &sequence, &CancellationToken::new()).await.unwrap().expect("a paused reply");
        assert_eq!(started.elapsed(), PAUSE_WAIT);
        let payload = payload_of(&reply);
        assert_eq!(payload["status"], "paused");
        assert_eq!(payload["code"], "computer_user_intervention_pending");
        assert_eq!(payload["completed"], false);
        assert_eq!(payload["reason"], "user_pause");
        assert_eq!(payload["total_steps"], 2);
        assert_eq!(payload["pending_work"], json!({"completed_steps": 0, "pending_steps": [1, 2]}));
        assert_eq!(payload["fresh_capture_required"], true);
        assert_eq!(payload["verdict"], json!({"decision": "wait_for_user", "recommended": "wait_for_user"}));
        assert!(control.section().is_some_and(|section| section.reason == "user_pause"), "the pause itself goes on");
    }

    /// A cancelled turn ends its parked request, and a Stop that replaces the pause refuses it.
    #[tokio::test(start_paused = true)]
    async fn a_parked_request_ends_with_its_turn_or_a_stop() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let (a, b) = (Arc::new(session(&manager, &control, "a")), Arc::new(session(&manager, &control, "b")));
        assert!(control.pause());
        let turn = CancellationToken::new();
        let cancelled = {
            let (control, a, turn) = (control.clone(), a.clone(), turn.clone());
            tokio::spawn(async move { control.admit(&a, &click_in_background(), &turn).await })
        };
        let stopped = {
            let (control, b) = (control.clone(), b.clone());
            tokio::spawn(async move { control.admit(&b, &click_in_background(), &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(1)).await;
        turn.cancel();
        assert_eq!(cancelled.await.unwrap(), Err(ComputerError::Cancelled));
        assert!(control.stop());
        assert_eq!(stopped.await.unwrap(), Err(takeover_refusal()));
    }

    /// A session that asks while the pause holds is one the pause waits for (`queueCommand`), though it began after the pause.
    #[tokio::test(start_paused = true)]
    async fn a_session_that_asks_during_the_pause_keeps_it() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        control.session_began("a");
        assert!(control.pause());
        let late = Arc::new(session(&manager, &control, "late"));
        let parked = {
            let (control, late) = (control.clone(), late.clone());
            tokio::spawn(async move { control.park_before_lane(&late, &click_in_background(), &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(1)).await;
        control.session_ended("a");
        assert!(control.section().is_some(), "the late session's request still waits for the pause");
        control.session_ended("late");
        assert_eq!(control.section(), None, "the pause ends with the last session it waits for");
        assert!(parked.await.unwrap().unwrap().is_some(), "the parked request is answered with the pending work");
    }

    /// A request meeting the pause parks before the desktop's lane, so another session's request takes the lane meanwhile.
    #[tokio::test(start_paused = true)]
    async fn a_request_parks_before_it_takes_the_lane() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let shared = ComputerShared { user_control: control.clone(), ..ComputerShared::default() };
        control.session_began("a");
        let a = Arc::new(ProcessComputerBackend::new(ComputerConfig::new("helper", "a"), manager.clone()).with_shared(shared.clone()));
        assert!(control.pause());
        let foreground = object(json!({"action": "click", "x": 1, "y": 2, "delivery": "foreground"}));
        let parked = {
            let (control, a) = (control.clone(), a.clone());
            tokio::spawn(async move { control.park_before_lane(&a, &foreground, &CancellationToken::new()).await })
        };
        sleep(Duration::from_secs(1)).await;
        assert!(!parked.is_finished(), "the request waits for Resume");
        let entered = shared.lane.enter(computer_lane::Kind::Command, &CancellationToken::new()).await;
        assert!(entered.is_ok(), "the lane is free while a request is parked");
        drop(entered);
        assert!(control.resume(None));
        assert!(parked.await.unwrap().unwrap().is_some(), "the parked request is answered with the pending work");
        assert!(control.park_before_lane(&a, &click_in_background(), &CancellationToken::new()).await.unwrap().is_none(), "nothing held: it goes on");
    }

    /// Only a person's pause parks: another takeover still refuses at once.
    #[tokio::test(start_paused = true)]
    async fn only_the_pause_parks() {
        let manager = quiet_helper();
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let a = session(&manager, &control, "a");
        assert!(control.stop());
        let started = Instant::now();
        assert_eq!(control.admit(&a, &click_in_background(), &CancellationToken::new()).await, Err(takeover_refusal()));
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    /// An environment change refuses every session, never resumes by itself even on an idle desktop, ends with the last session
    /// and takes only its own reasons.
    #[tokio::test(start_paused = true)]
    async fn an_environment_takeover_refuses_every_session_until_resume() {
        let manager = Scripted::new(|request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(60_000),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        assert!(!control.take_over_environment("display_changed"), "no session is using the computer");
        let (a, b) = (session(&manager, &control, "a"), session(&manager, &control, "b"));
        let cancel = CancellationToken::new();
        assert!(!control.take_over_environment("user_stop"), "not an environment reason");
        assert!(control.take_over_environment("display_changed"));
        assert_eq!(control.section(), Some(ComputerUserControlSection { active: true, reason: "display_changed".into(), resume_mode: ComputerResumeMode::Manual }));
        for backend in [&a, &b] {
            assert_eq!(control.admit(backend, &click_in_background(), &cancel).await, Err(takeover_refusal()));
        }
        let waited = payload_of(&control.wait_for_user(&a, &wait_for_user(json!(10_000)), &cancel).await.unwrap());
        assert_eq!(waited["status"], "timeout", "an idle desktop does not end it, and the wait is not cancelled");
        assert_eq!(waited["reason"], "display_changed");
        assert!(control.resume(None));
        assert!(control.admit(&a, &click_in_background(), &cancel).await.unwrap().is_none());
        assert!(control.take_over_environment("desktop_unavailable"));
        control.session_ended("a");
        assert!(control.section().is_some());
        control.session_ended("b");
        assert_eq!(control.section(), None, "nothing is left to protect");
    }

    /// The interval is settable at run time: a yield's resume mode follows it, the listener hears the change, and a wait
    /// resumes after the new interval of quiet.
    #[tokio::test(start_paused = true)]
    async fn the_idle_resume_interval_is_settable() {
        let started = Instant::now();
        let manager = Scripted::new(move |request| match request["action"].as_str() {
            Some("input_idle_state") => idle_reading(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
            _ => Ok(json!({"text": "ok"})),
        });
        let control = Arc::new(UserControlState::default());
        assert_eq!(control.idle_resume_seconds(), 5);
        let heard = Arc::new(Mutex::new(0));
        let log = heard.clone();
        control.on_change(Arc::new(move || *locked(&log) += 1));
        let a = session(&manager, &control, "a");
        control.settle(&a, &focus(), interrupted()).await.unwrap();
        assert_eq!(*locked(&heard), 1);
        control.set_idle_resume(20);
        assert_eq!(control.idle_resume_seconds(), 20);
        assert_eq!(*locked(&heard), 2, "the section is published again");
        control.set_idle_resume(20);
        assert_eq!(*locked(&heard), 2, "an unchanged interval publishes nothing");
        let waited = payload_of(&control.wait_for_user(&a, &wait_for_user(json!(60_000)), &CancellationToken::new()).await.unwrap());
        assert_eq!(waited["status"], "resumed");
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_secs(20) && elapsed <= Duration::from_secs(21), "{elapsed:?}");

        control.settle(&a, &focus(), interrupted()).await.unwrap();
        control.set_idle_resume(0);
        assert_eq!(control.section().map(|section| section.resume_mode), Some(ComputerResumeMode::Manual));
        let refused = control.admit(&a, &focus(), &CancellationToken::new()).await.unwrap().expect("a manual yield is not resumed by idleness");
        assert_eq!(payload_of(&refused)["resume_mode"], "manual");
        control.set_idle_resume(90);
        assert_eq!(control.idle_resume_seconds(), 60, "held at the largest interval");
    }
}
