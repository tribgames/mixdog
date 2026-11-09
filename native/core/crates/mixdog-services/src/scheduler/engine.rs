//! The scheduler: arms cron jobs and one-shot timers, claims each slot once, and runs the
//! fire under the overlap, rename and failure rules.
//!
//! Locking: one short `std::sync::Mutex` over in-memory sets, never held across an await.
//! Every fire is its own task, so a slow run never delays another schedule's fire.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use chrono_tz::Tz;
use serde::Serialize;
use tokio::task::JoinHandle;

use super::cron::{CronExpr, plan_beat};
use super::model::{Schedule, ScheduleError, ScheduleStatus};
use super::store::{Clock, RunOutcome, ScheduleRunner, ScheduleStore, Ts};
use crate::channels::running::{RunningWork, WorkGuard};

/// Longest single timer wait; a farther instant re-arms instead of firing early.
const MAX_TIMER_DELAY: StdDuration = StdDuration::from_millis((1 << 31) - 1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Renaming,
    Running,
}

#[derive(Debug, Clone, Copy, Default)]
struct FireOpts {
    await_dispatch: bool,
    reserved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatusRow {
    pub name: String,
    pub time: Option<String>,
    pub running: bool,
    pub last_fired: Option<String>,
    pub last_success: Option<String>,
    pub last_failed: Option<String>,
    pub next_fire: Option<String>,
}

#[derive(Default)]
struct State {
    schedules: Vec<Schedule>,
    running: HashSet<String>,
    renaming: HashSet<String>,
    rename_blocked: HashSet<String>,
    tasks: HashMap<String, JoinHandle<()>>,
    /// Held while jobs are armed: an armed schedule keeps the core alive.
    keep_alive: Option<WorkGuard>,
    started: bool,
}

struct Inner {
    store: Arc<dyn ScheduleStore>,
    runner: Arc<dyn ScheduleRunner>,
    clock: Arc<dyn Clock>,
    work: RunningWork,
    local_tz: Tz,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Scheduler {
    inner: Arc<Inner>,
}

fn iso(t: Ts) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn tz_of(schedule: &Schedule, fallback: Tz) -> Tz {
    schedule.timezone.as_deref().and_then(|t| mixdog_js::js_trim(t).parse().ok()).unwrap_or(fallback)
}

/// node-cron `getDelay`: a heartbeat waits at most a day.
const MAX_BEAT_WAIT_MS: i64 = 86_400_000;
/// node-cron `DEFAULT_MISSED_EXECUTION_TOLERANCE`: how late a slot may still run.
const MISSED_TOLERANCE_MS: i64 = 1000;

/// node-cron `nowWithoutMs`.
fn whole_seconds(t: Ts) -> Ts {
    Ts::from_timestamp(t.timestamp(), 0).unwrap_or(t)
}

fn std_delay(ms: i64) -> StdDuration {
    StdDuration::from_millis(ms.max(0) as u64).min(MAX_TIMER_DELAY)
}

impl Scheduler {
    pub fn new(
        store: Arc<dyn ScheduleStore>,
        runner: Arc<dyn ScheduleRunner>,
        clock: Arc<dyn Clock>,
        work: RunningWork,
        local_tz: Tz,
        schedules: Vec<Schedule>,
    ) -> Self {
        let state = State { schedules: schedules.into_iter().filter(|s| s.enabled).collect(), ..State::default() };
        Self { inner: Arc::new(Inner { store, runner, clock, work, local_tz, state: Mutex::new(state) }) }
    }

    /// Arms every loaded schedule. A no-op when already started or when none is loaded.
    pub fn start(&self) {
        self.inner.start();
    }

    pub fn stop(&self) {
        self.inner.stop();
    }

    pub fn restart(&self) {
        self.inner.stop();
        self.inner.start();
    }

    /// Replaces the loaded schedules (enabled ones only) and re-arms them unless
    /// `restart` is false, in which case the stale jobs are only dropped.
    pub fn reload_config(&self, schedules: Vec<Schedule>, restart: bool) {
        {
            let mut st = self.inner.state.lock().unwrap();
            st.schedules = schedules.into_iter().filter(|s| s.enabled).collect();
        }
        if restart {
            self.restart();
        } else {
            self.inner.abort_tasks();
        }
    }

    pub fn find_schedule(&self, name: &str) -> Option<Schedule> {
        self.inner.find(name)
    }

    pub async fn defer(&self, name: &str, minutes: f64) -> Result<(), ScheduleError> {
        if !minutes.is_finite() || minutes <= 0.0 {
            return Err(ScheduleError::Run(format!("defer: minutes must be a positive number, got {minutes}")));
        }
        if self.find_schedule(name).is_none() {
            return Err(ScheduleError::Run(format!(
                "defer: unknown schedule \"{name}\" — use schedule_status to list valid names"
            )));
        }
        let until = self.inner.clock.now() + Duration::milliseconds((minutes * 60_000.0) as i64);
        self.inner.store.set_deferred(name, Some(until)).await?;
        self.inner.update(name, |s| s.deferred_until = Some(until));
        Ok(())
    }

    /// Skips a schedule for the rest of today (the end of the local day).
    pub async fn skip_today(&self, name: &str) -> Result<(), ScheduleError> {
        if self.find_schedule(name).is_none() {
            return Err(ScheduleError::Run(format!(
                "skip_today: unknown schedule \"{name}\" — use schedule_status to list valid names"
            )));
        }
        let local = self.inner.clock.now().with_timezone(&self.inner.local_tz);
        let end_of_day = local
            .date_naive()
            .and_hms_milli_opt(23, 59, 59, 999)
            .and_then(|t| t.and_local_timezone(self.inner.local_tz).latest())
            .map(|t| t.with_timezone(&Utc))
            .ok_or_else(|| ScheduleError::Run("skip_today: end of day is not representable".into()))?;
        self.inner.store.set_skipped_until(name, Some(end_of_day)).await?;
        self.inner.update(name, |s| s.skipped_until = Some(end_of_day));
        Ok(())
    }

    pub fn should_skip(&self, name: &str) -> bool {
        self.inner.skip_until(name).is_some()
    }

    pub fn status(&self) -> Vec<ScheduleStatusRow> {
        let st = self.inner.state.lock().unwrap();
        st.schedules
            .iter()
            .map(|s| ScheduleStatusRow {
                name: s.name.clone(),
                time: s.when_cron.clone().or_else(|| s.when_at.map(iso)),
                running: st.running.contains(&s.name),
                last_fired: s.last_fired_at.map(iso),
                last_success: s.last_success_at.map(iso),
                last_failed: s.last_failed_at.map(iso),
                next_fire: s.next_fire_at.map(iso),
            })
            .collect()
    }

    /// "Run now": fires without claiming a cron slot; the message mirrors the outcome.
    pub async fn trigger_manual(&self, name: &str) -> String {
        if self.find_schedule(name).is_none() {
            return format!("schedule \"{name}\" not found");
        }
        if self.inner.state.lock().unwrap().running.contains(name) {
            return format!("\"{name}\" is already running");
        }
        match self.inner.fire_timed(name, FireOpts::default()).await {
            Ok(true) => format!("triggered \"{name}\""),
            _ => format!("\"{name}\" did not fire (skipped or already running)"),
        }
    }

    /// Fires a cron slot as the armed timer would; public for hosts that own the timing.
    pub async fn fire_cron_slot(&self, name: &str, scheduled_at: Ts) {
        self.inner.on_cron_fire(name, scheduled_at).await;
    }

    pub async fn fire_one_shot(&self, name: &str) {
        self.inner.fire_one_shot(name).await;
    }

    /// Runs `rename` (which moves schedule `name`'s row) while no run of `name` can start
    /// or be in flight: the check and the reservation are one step under the state lock.
    pub async fn rename_locked<R, Fut, RlFut>(
        &self,
        name: &str,
        rename: impl FnOnce() -> Fut,
        reload: impl FnOnce() -> RlFut,
    ) -> Result<Option<R>, ScheduleError>
    where
        Fut: Future<Output = Result<Option<R>, ScheduleError>>,
        RlFut: Future<Output = Result<(), String>>,
    {
        {
            let mut st = self.inner.state.lock().unwrap();
            if st.running.contains(name) || st.renaming.contains(name) {
                return Err(ScheduleError::RenameRunning { name: name.into() });
            }
            st.renaming.insert(name.into());
            st.rename_blocked.remove(name);
        }
        let outcome = async {
            let Some(saved) = rename().await? else { return Ok(None) };
            if let Err(cause) = reload().await {
                // The row moved but the reload that arms the new name failed: nothing may
                // keep running under the old one.
                self.inner.drop_schedule(name);
                return Err(ScheduleError::RenameReloadFailed { name: name.into(), cause });
            }
            Ok(Some(saved))
        }
        .await;
        let rearm = {
            let mut st = self.inner.state.lock().unwrap();
            st.renaming.remove(name);
            let blocked = st.rename_blocked.remove(name);
            outcome.is_err() && blocked && st.started
        };
        // A one-shot whose timer a blocked fire consumed is armed again from the loaded rows.
        if rearm {
            self.restart();
        }
        outcome
    }
}

struct Held {
    inner: Arc<Inner>,
    name: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.inner.release(&self.name);
    }
}

impl Inner {
    fn find(&self, name: &str) -> Option<Schedule> {
        self.state.lock().unwrap().schedules.iter().find(|s| s.name == name).cloned()
    }

    fn update(&self, name: &str, f: impl FnOnce(&mut Schedule)) {
        if let Some(s) = self.state.lock().unwrap().schedules.iter_mut().find(|s| s.name == name) {
            f(s);
        }
    }

    fn skip_until(&self, name: &str) -> Option<Ts> {
        let now = self.clock.now();
        self.find(name).and_then(|s| s.skip_until(now))
    }

    fn notify_failure(&self, name: &str, reason: &str) {
        mixdog_rt::node_stderr!("mixdog scheduler: schedule \"{name}\": {reason}");
    }

    fn abort_tasks(&self) {
        let tasks: Vec<_> = self.state.lock().unwrap().tasks.drain().collect();
        for (_, t) in tasks {
            t.abort();
        }
    }

    fn stop(&self) {
        self.abort_tasks();
        let mut st = self.state.lock().unwrap();
        st.started = false;
        st.keep_alive = None;
    }

    fn drop_schedule(&self, name: &str) {
        let mut st = self.state.lock().unwrap();
        if let Some(t) = st.tasks.remove(name) {
            t.abort();
        }
        st.schedules.retain(|s| s.name != name);
    }

    /// Atomically decides whether a fire of `name` may start, reserving the name if so.
    fn reserve(&self, name: &str) -> Option<Refusal> {
        let mut st = self.state.lock().unwrap();
        if st.renaming.contains(name) {
            Some(Refusal::Renaming)
        } else if st.running.contains(name) {
            Some(Refusal::Running)
        } else {
            st.running.insert(name.into());
            None
        }
    }

    fn release(&self, name: &str) {
        self.state.lock().unwrap().running.remove(name);
    }

    /// Releases `name` when dropped, so a fire aborted at shutdown or by a dropped future still
    /// frees its overlap reservation.
    fn hold(self: &Arc<Self>, name: &str) -> Held {
        Held { inner: Arc::clone(self), name: name.into() }
    }
    fn start(self: &Arc<Self>) {
        let schedules = {
            let mut st = self.state.lock().unwrap();
            if st.started || st.schedules.is_empty() {
                return;
            }
            st.started = true;
            st.keep_alive = Some(self.work.begin());
            st.schedules.clone()
        };
        for s in schedules {
            if let Some(cron) = s.when_cron.clone() {
                self.arm_cron(&s, &cron);
            } else if s.when_at.is_some() {
                self.arm_one_shot(&s);
            }
        }
    }

    fn spawn_task(&self, name: &str, task: impl Future<Output = ()> + Send + 'static) {
        let handle = tokio::spawn(task);
        if let Some(old) = self.state.lock().unwrap().tasks.insert(name.into(), handle) {
            old.abort();
        }
    }

    fn arm_cron(self: &Arc<Self>, schedule: &Schedule, expression: &str) {
        let Ok(expr) = CronExpr::parse(expression) else {
            mixdog_rt::node_stderr!("mixdog scheduler: invalid cron \"{}\" ({expression}) — skipped", schedule.name);
            return;
        };
        let tz = tz_of(schedule, self.local_tz);
        let name = schedule.name.clone();
        let inner = Arc::clone(self);
        let mut expected = expr.next_after(whole_seconds(self.clock.now()), tz);
        self.update(&name, |s| s.next_fire_at = expected);
        self.spawn_task(&schedule.name, async move {
            if let Some(next) = expected {
                let store = Arc::clone(&inner.store);
                let n = name.clone();
                tokio::spawn(async move {
                    // `scheduler.mjs:311`: a failed write is logged, the schedule still runs.
                    if let Err(err) = store.set_next_fire(&n, Some(next)).await {
                        mixdog_rt::node_stderr!("mixdog scheduler: {n} setNextFire failed: {err}");
                    }
                });
            }
            // node-cron's heartbeat: wait for the expected slot (at most a day at a time),
            // then plan from the present. Slots a suspend or clock jump skipped are only
            // logged; the next wait is computed from now, never replayed.
            while let Some(slot) = expected {
                let wait = (slot - inner.clock.now()).num_milliseconds();
                tokio::time::sleep(std_delay(wait.min(MAX_BEAT_WAIT_MS))).await;
                let plan = plan_beat(slot, whole_seconds(inner.clock.now()), MISSED_TOLERANCE_MS, |d| {
                    expr.next_after(d, tz)
                });
                expected = plan.next;
                for missed in plan.missed {
                    tracing::warn!(schedule = %name, "missed execution at {}!", iso(missed));
                }
                if let Some(run) = plan.run {
                    let fire = Arc::clone(&inner);
                    let n = name.clone();
                    tokio::spawn(async move { fire.on_cron_fire(&n, run).await });
                }
            }
        });
    }

    fn arm_one_shot(self: &Arc<Self>, schedule: &Schedule) {
        let Some(at) = schedule.when_at else { return };
        self.arm_one_shot_at(&schedule.name, at, at);
    }

    /// Arms a timer for `fire_at`; a past-due instant fires at once. `shown` is the
    /// instant reported as the next fire.
    fn arm_one_shot_at(self: &Arc<Self>, name: &str, fire_at: Ts, shown: Ts) {
        let inner = Arc::clone(self);
        let n = name.to_string();
        self.update(name, |s| s.next_fire_at = Some(shown));
        let store = Arc::clone(&self.store);
        let persist_name = name.to_string();
        self.spawn_task(name, async move {
            let _ = store.set_next_fire(&persist_name, Some(shown)).await;
            loop {
                let wait = (fire_at - inner.clock.now()).num_milliseconds();
                if wait <= 0 {
                    break;
                }
                tokio::time::sleep(std_delay(wait)).await;
            }
            inner.fire_one_shot(&n).await;
        });
    }

    async fn on_cron_fire(self: &Arc<Self>, name: &str, scheduled_at: Ts) {
        let started_at = self.clock.now();
        let Some(armed) = self.find(name) else { return };
        let next = armed
            .when_cron
            .as_deref()
            .and_then(|c| CronExpr::parse(c).ok())
            .and_then(|c| c.next_after(scheduled_at, tz_of(&armed, self.local_tz)));
        self.update(name, |s| s.next_fire_at = next);
        if self.skip_until(name).is_some() {
            if let Err(err) = self.store.advance_cursor(name, scheduled_at, next).await {
                mixdog_rt::node_stderr!("mixdog scheduler: {name} cursor advance failed: {err}");
            }
            return;
        }
        // The name is held in `running` from before the claim until the completion stamps
        // are written, so a rename can neither complete meanwhile nor leave this fire to
        // run under the old name. A refused fire still claims its slot and records a skip.
        let refusal = self.reserve(name);
        let _held = refusal.is_none().then(|| self.hold(name));
        let outcome = self.run_claimed_slot(name, scheduled_at, started_at, next, refusal).await;
        if let Err(err) = outcome {
            let now = self.clock.now();
            self.update(name, |s| s.last_failed_at = Some(now));
            let _ = self.store.mark_failure(name, now).await;
            mixdog_rt::node_stderr!("mixdog scheduler: {name} failed: {err}");
            self.notify_failure(name, &format!("run failed: {err}"));
        }
    }

    async fn run_claimed_slot(
        self: &Arc<Self>,
        name: &str,
        scheduled_at: Ts,
        started_at: Ts,
        next: Option<Ts>,
        refusal: Option<Refusal>,
    ) -> Result<(), ScheduleError> {
        if !self.store.claim_run(name, scheduled_at, started_at, next).await? {
            mixdog_rt::node_stderr!("mixdog scheduler: {name}: duplicate/stale cron slot skipped");
            return Ok(());
        }
        self.update(name, |s| {
            s.last_scheduled_at = Some(scheduled_at);
            s.last_started_at = Some(started_at);
            s.last_fired_at = Some(started_at);
        });
        if let Some(reason) = refusal {
            self.record_refusal(name, reason).await;
            return Ok(());
        }
        let fired = self.fire_timed(name, FireOpts { await_dispatch: true, reserved: true }).await?;
        // An overlap skip is recorded as a skip, never as a failed run.
        if !fired && self.skipped_since(name, started_at) {
            return Ok(());
        }
        let now = self.clock.now();
        if !fired {
            self.update(name, |s| s.last_failed_at = Some(now));
            return self.store.mark_failure(name, now).await;
        }
        self.update(name, |s| s.last_success_at = Some(now));
        self.store.mark_success(name, now).await
    }

    fn skipped_since(&self, name: &str, since: Ts) -> bool {
        self.find(name).and_then(|s| s.last_skipped_at).is_some_and(|t| t >= since)
    }

    async fn record_refusal(&self, name: &str, reason: Refusal) {
        let now = self.clock.now();
        self.update(name, |s| s.last_skipped_at = Some(now));
        match reason {
            Refusal::Running => {
                if let Err(err) = self.store.mark_skipped(name, now).await {
                    mixdog_rt::node_stderr!("mixdog scheduler: {name} skip record failed: {err}");
                }
            }
            // A skip, not a failure: a one-shot stays pending and rename_locked re-arms it.
            Refusal::Renaming => {
                self.state.lock().unwrap().rename_blocked.insert(name.into());
            }
        }
    }

    async fn mark_done_with_retry(&self, name: &str) -> bool {
        for attempt in 1..=3 {
            match self.store.mark_done(name).await {
                Ok(()) => return true,
                Err(err) => {
                    mixdog_rt::node_stderr!("mixdog scheduler: {name} markDone failed (attempt {attempt}/3): {err}");
                    if attempt < 3 {
                        tokio::time::sleep(StdDuration::from_millis(250)).await;
                    }
                }
            }
        }
        false
    }

    /// Fires a one-shot exactly once, then marks it done. A fire that did not complete
    /// leaves it pending; one that already fired only retries the done marker.
    async fn fire_one_shot(self: &Arc<Self>, name: &str) {
        // Detach this timer's own handle (dropping a JoinHandle never aborts the task).
        self.state.lock().unwrap().tasks.remove(name);
        let Some(armed) = self.find(name) else { return };
        let now = self.clock.now();
        if armed.last_fired_at.is_some() {
            self.mark_done_with_retry(name).await;
            return;
        }
        if self.skip_until(name).is_some() {
            self.rearm_deferred_one_shot(&armed);
            return;
        }
        let reserved = self.reserve(name);
        let _held = reserved.is_none().then(|| self.hold(name));
        let result = self.run_one_shot(name, now, reserved).await;
        if let Err(err) = result {
            // `scheduler.mjs:374-376`: the failure mark of the catch is itself ignored.
            let _ = self.mark_one_shot_failed(name).await;
            self.notify_failure(name, &format!("one-shot failed: {err} — left pending for retry"));
        }
    }

    async fn run_one_shot(self: &Arc<Self>, name: &str, started: Ts, reserved: Option<Refusal>) -> Result<(), ScheduleError> {
        let fired = match reserved {
            Some(refusal) => {
                self.record_refusal(name, refusal).await;
                false
            }
            None => self.fire_timed(name, FireOpts { await_dispatch: true, reserved: true }).await?,
        };
        if !fired && self.skipped_since(name, started) {
            return Ok(());
        }
        if !fired {
            // `scheduler.mjs:366`: awaited in the run's try, so a failed mark is the run's failure.
            self.mark_one_shot_failed(name).await?;
            return Ok(());
        }
        let now = self.clock.now();
        self.update(name, |s| {
            s.last_fired_at = Some(started);
            s.last_success_at = Some(now);
        });
        if let Err(err) = self.store.mark_fired(name, started).await {
            mixdog_rt::node_stderr!("mixdog scheduler: {name} markFired failed: {err}");
        }
        // `scheduler.mjs:371`: a failed success mark is the run's failure (the caller marks it failed, logs and notifies).
        self.store.mark_success(name, now).await?;
        self.mark_done_with_retry(name).await;
        Ok(())
    }

    async fn mark_one_shot_failed(&self, name: &str) -> Result<(), ScheduleError> {
        let now = self.clock.now();
        self.update(name, |s| s.last_failed_at = Some(now));
        self.store.mark_failure(name, now).await
    }

    /// A deferred one-shot's timer already elapsed, so it re-arms for the later of its
    /// instant and the deferral's end rather than waiting for a restart.
    fn rearm_deferred_one_shot(self: &Arc<Self>, schedule: &Schedule) {
        let until = self.skip_until(&schedule.name);
        let target = [schedule.when_at, until].into_iter().flatten().max();
        let Some(target) = target else { return };
        let min_target = self.clock.now() + Duration::milliseconds(1);
        self.arm_one_shot_at(&schedule.name, target.max(min_target), target);
    }

    /// The stored row decides whether, and with what prompt, an armed fire still happens.
    async fn fire_timed(self: &Arc<Self>, name: &str, opts: FireOpts) -> Result<bool, ScheduleError> {
        let Some(armed) = self.find(name) else { return Ok(false) };
        let row = match self.store.get(name).await {
            Ok(row) => row,
            Err(err) => {
                self.notify_failure(name, &format!("schedule unreadable — fire skipped ({err})"));
                return Ok(false);
            }
        };
        let current = row.as_ref().is_some_and(|r| {
            r.enabled && r.status != ScheduleStatus::Done && r.when_at == armed.when_at && r.when_cron == armed.when_cron
        });
        if !current {
            mixdog_rt::node_stderr!("mixdog scheduler: {name}: not fired — deleted or changed since it was armed");
            let now = self.clock.now();
            // A skip, not a failed run: the callers record no failure on its row.
            self.update(name, |s| s.last_skipped_at = Some(now));
            return Ok(false);
        }
        let prompt = row.map(|r| r.prompt).unwrap_or_default();
        if prompt.is_empty() {
            self.notify_failure(name, "prompt not found — fire skipped");
            return Ok(false);
        }
        self.update(name, |s| s.prompt = prompt.clone());
        self.fire_timed_prompt(armed, prompt, opts).await
    }

    async fn fire_timed_prompt(
        self: &Arc<Self>,
        mut schedule: Schedule,
        prompt: String,
        opts: FireOpts,
    ) -> Result<bool, ScheduleError> {
        let name = schedule.name.clone();
        if !opts.reserved
            && let Some(refusal) = self.reserve(&name)
        {
            self.record_refusal(&name, refusal).await;
            return Ok(false);
        }
        schedule.prompt = prompt.clone();
        let run = {
            let inner = Arc::clone(self);
            let owned = !opts.reserved;
            async move {
                let _held = owned.then(|| inner.hold(&schedule.name));
                inner.dispatch_run(&schedule, &prompt, opts.await_dispatch).await
            }
        };
        // Cron-style fires are fire-and-forget; a one-shot awaits the dispatch so a
        // rejected run leaves the entry pending for retry.
        if opts.await_dispatch {
            return run.await;
        }
        tokio::spawn(run);
        Ok(true)
    }

    async fn dispatch_run(&self, schedule: &Schedule, prompt: &str, await_dispatch: bool) -> Result<bool, ScheduleError> {
        match self.runner.run(schedule, prompt).await {
            Ok(RunOutcome::Skipped(reason)) => {
                let now = self.clock.now();
                self.update(&schedule.name, |s| s.last_skipped_at = Some(now));
                mixdog_rt::node_stderr!("mixdog scheduler: {}: skipped — {}", schedule.name, reason.text());
                Ok(false)
            }
            Ok(RunOutcome::Done) => Ok(true),
            Err(err) => {
                tracing::warn!(schedule = %schedule.name, "run error: {err}");
                if await_dispatch {
                    return Err(ScheduleError::Run(err));
                }
                self.notify_failure(&schedule.name, &format!("run failed: {err}"));
                Ok(false)
            }
        }
    }
}
