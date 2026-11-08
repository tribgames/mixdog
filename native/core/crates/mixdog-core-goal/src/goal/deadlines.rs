//! `goal-deadlines.mjs`: the time cap and its warnings, the heartbeat that shows a live runtime
//! ran an open segment, and suspend accounting.
//!
//! The cap is a budget the user set, enforced by the process ticker: one deadline per active
//! capped Goal, set when the Goal's clock starts and re-set whenever its record changes. Timers
//! only observe a crossing; every durable transition joins the session's mutation queue and
//! re-checks the committed record.

use std::sync::{Arc, Weak};

use super::error::GoalResult;
use super::js::{Goal, count, number, put_num, string, truthy};
use super::runtime::{Inner, Slot, SlotMem, TimerKind, Tx, reserve_turn};
use super::state::{
    GOAL_LIVE_HEARTBEAT_MS, active_elapsed_ms, discard_suspended_time, normalize_deadline_warned_ms, stop_active_clock,
};

/// Wall time may outrun the monotonic clock by a little without any suspend.
const MIN_SUSPEND_EVIDENCE_MS: f64 = 5_000.0;
/// The timer rounding margin of the warning delay.
const WARNING_MARGIN_MS: f64 = 250.0;

struct Warnings {
    crossed: f64,
    next_delay: f64,
}

impl Inner {
    /// Wall time that outran the monotonic clock since the anchor is suspend. Without evidence
    /// time counts: overcounting is safer than a Goal running past its cap.
    fn suspended_ms(&self, slot: &Slot, at: f64) -> f64 {
        let mut mem = slot.mem();
        let Some((wall, mono)) = mem.anchor else { return 0.0 };
        let Some(now_mono) = self.env.clock.monotonic() else {
            mem.anchor = None;
            return 0.0;
        };
        let suspended = at - wall - (now_mono - mono);
        if suspended > MIN_SUSPEND_EVIDENCE_MS { suspended } else { 0.0 }
    }

    /// `dropSuspended` / `settleSuspended`.
    pub fn drop_suspended(&self, slot: &Slot, _id: &str, goal: &mut Goal, at: f64) -> bool {
        let suspended = self.suspended_ms(slot, at);
        discard_suspended_time(goal, at, suspended)
    }

    /// `observe` / `refreshAnchor`: only a Goal still running keeps an anchor.
    pub fn observe(&self, slot: &Slot, _id: &str, at: f64, goal: &Goal) {
        if string(goal, "status") != "active" {
            return;
        }
        let mono = if self.suspend_detectable { self.env.clock.monotonic() } else { None };
        slot.mem().anchor = mono.map(|mono| (at, mono));
    }

    pub fn clear_deadline(&self, slot: &Slot) {
        let mut mem = slot.mem();
        if let Some(timer) = mem.deadline_timer.take() {
            timer.cancel();
        }
        if let Some(timer) = mem.warning_timer.take() {
            timer.cancel();
        }
    }

    fn stop_heartbeat(mem: &mut SlotMem) {
        mem.heartbeat_gen += 1;
        if let Some(timer) = mem.heartbeat.take() {
            timer.cancel();
        }
    }

    pub fn close_deadlines(&self, mem: &mut SlotMem) {
        if let Some(timer) = mem.deadline_timer.take() {
            timer.cancel();
        }
        if let Some(timer) = mem.warning_timer.take() {
            timer.cancel();
        }
        Self::stop_heartbeat(mem);
        mem.warning_pending = false;
        mem.expiry_pending = false;
        mem.anchor = None;
    }

    /// `expiredProjection`: an active Goal whose time reached its cap ends as duration_reached.
    fn expired_projection(goal: Option<&mut Goal>, at: f64) -> bool {
        let Some(goal) = goal else { return false };
        if string(goal, "status") != "active" || !(number(goal, "timeLimitMs") > 0.0) || active_elapsed_ms(goal, at) < number(goal, "timeLimitMs") {
            return false;
        }
        stop_active_clock(goal, at);
        super::js::put(goal, "status", "duration_reached");
        let limit = number(goal, "timeLimitMs");
        put_num(goal, "timeUsedMs", limit);
        put_num(goal, "updatedAt", at);
        true
    }

    /// `settleProjection`: drop the suspended stretch, then expire.
    pub fn settle_projection(&self, slot: &Slot, id: &str, goal: Option<&mut Goal>, at: f64) -> bool {
        match goal {
            None => false,
            Some(goal) => {
                let dropped = self.drop_suspended(slot, id, goal, at);
                Self::expired_projection(Some(goal), at) || dropped
            }
        }
    }

    /// `limitIfExpired` over a record already read: the expiry is committed in the background.
    pub fn limit_if_expired_with(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, mut goal: Option<Goal>) -> Option<Goal> {
        let changed = self.settle_projection(slot, id, goal.as_mut(), self.now());
        if changed && !self.is_closed() {
            let start = {
                let mut mem = slot.mem();
                !std::mem::replace(&mut mem.expiry_pending, true)
            };
            if start {
                let (task_slot, done_slot) = (slot.clone(), slot.clone());
                let task_id = id.to_owned();
                self.spawn_mutation(
                    id.to_owned(),
                    move |tx| tx.expire_if_due(&task_slot, &task_id),
                    move |_| done_slot.mem().expiry_pending = false,
                );
            }
        }
        goal
    }

    /// Crossing several thresholds at once delivers only the most urgent one.
    fn crossed_warning_ms(&self, goal: &Goal, remaining: f64) -> f64 {
        let warned = normalize_deadline_warned_ms(goal.get("deadlineWarnedMs"));
        let mut urgent = 0.0;
        for threshold in &self.warning_thresholds {
            if *threshold < remaining || *threshold >= warned {
                continue;
            }
            urgent = if urgent != 0.0 { f64::min(urgent, *threshold) } else { *threshold };
        }
        urgent
    }

    fn next_warning_delay_ms(&self, goal: &Goal, remaining: f64) -> f64 {
        let warned = normalize_deadline_warned_ms(goal.get("deadlineWarnedMs"));
        let mut delay = 0.0;
        for threshold in &self.warning_thresholds {
            if *threshold >= remaining || *threshold >= warned {
                continue;
            }
            let candidate = remaining - *threshold;
            delay = if delay != 0.0 { f64::min(delay, candidate) } else { candidate };
        }
        delay
    }

    fn warning_state(&self, slot: &Slot, id: &str, goal: Option<&mut Goal>, at: f64) -> Option<Warnings> {
        let goal = goal?;
        if string(goal, "status") != "active" || !truthy(goal.get("lastStartedAt")) || !(number(goal, "timeLimitMs") > 0.0) {
            return None;
        }
        self.drop_suspended(slot, id, goal, at);
        let remaining = (number(goal, "timeLimitMs") - active_elapsed_ms(goal, at)).max(0.0);
        if remaining <= 0.0 {
            return None;
        }
        Some(Warnings { crossed: self.crossed_warning_ms(goal, remaining), next_delay: self.next_warning_delay_ms(goal, remaining) })
    }

    /// The rest of `deliverDeadlineWarning` over a record already read; its mutation joins the
    /// session's queue at once.
    fn deliver_warning_with(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, threshold_ms: f64, mut view: Option<Goal>) {
        if self.is_closed() || slot.mem().warning_pending {
            return;
        }
        let slot = slot.clone();
        let pending = self.warning_state(&slot, id, view.as_mut(), self.now());
        let crossed = pending.as_ref().map_or(0.0, |p| p.crossed);
        let target = if threshold_ms != 0.0 { threshold_ms } else { crossed };
        if pending.is_none() || target == 0.0 || crossed != target {
            return;
        }
        slot.mem().warning_pending = true;
        let done_slot = slot.clone();
        let (task_slot, task_id) = (slot.clone(), id.to_owned());
        self.spawn_mutation(
            id.to_owned(),
            move |tx| tx.deliver_warning(&task_slot, &task_id, target),
            move |_| done_slot.mem().warning_pending = false,
        );
    }

    fn spawn_limit_check(self: &Arc<Self>, id: &str) {
        let (inner, id) = (self.clone(), id.to_owned());
        self.spawn_task(async move {
            let slot = inner.slot(&id);
            match inner.cached(&slot, &id).await {
                Ok(goal) => {
                    inner.limit_if_expired_with(&slot, &id, goal);
                }
                Err(error) => inner.on_error(&error),
            }
        });
    }

    /// `deliverDeadlineWarning` from the warning timer. Node reads the record synchronously and
    /// queues the mutation in the same turn; the read here needs the lane, so the place in the
    /// session's queue is taken first, at the moment the timer fires, and the mutation's own
    /// re-check decides whether anything is written.
    fn spawn_warning(self: &Arc<Self>, id: &str) {
        let slot = self.slot(id);
        if self.is_closed() || slot.mem().warning_pending {
            return;
        }
        slot.mem().warning_pending = true;
        let turn = reserve_turn(&slot);
        let (inner, id) = (self.clone(), id.to_owned());
        self.spawn_task(async move {
            let slot = inner.slot(&id);
            let view = inner.cached(&slot, &id).await;
            let outcome = match view {
                Err(error) => Err(error),
                Ok(mut view) => {
                    let pending = inner.warning_state(&slot, &id, view.as_mut(), inner.now());
                    match pending.map(|p| p.crossed).filter(|c| *c != 0.0) {
                        None => Ok(()),
                        Some(target) => {
                            let (task_slot, task_id) = (slot.clone(), id.clone());
                            inner.run_mutation(&id, &slot, turn, move |tx| tx.deliver_warning(&task_slot, &task_id, target)).await
                        }
                    }
                }
            };
            if let Err(error) = outcome {
                inner.on_error(&error);
            }
            slot.mem().warning_pending = false;
        });
    }

    /// The crossing seen by `armDeadline` is delivered from that same read.
    fn spawn_crossed_warning(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, threshold_ms: f64, goal: &Goal) {
        self.deliver_warning_with(slot, id, threshold_ms, Some(goal.clone()));
    }

    /// `armDeadline` over an observer's read of the record.
    pub async fn arm_observed(self: &Arc<Self>, id: &str) -> GoalResult<()> {
        let slot = self.slot(id);
        let goal = self.cached(&slot, id).await?;
        self.arm_deadline(&slot, id, goal);
        Ok(())
    }

    /// `armDeadline`: the heartbeat of a running Goal, a warning timer, and the cap's deadline.
    pub fn arm_deadline(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, goal: Option<Goal>) {
        if self.is_closed() {
            return;
        }
        self.clear_deadline(slot);
        let mut goal = goal;
        let running = goal.as_ref().is_some_and(|g| string(g, "status") == "active" && truthy(g.get("lastStartedAt")));
        if running {
            let needs_anchor = slot.mem().anchor.is_none();
            if needs_anchor {
                if let Some(goal) = &goal {
                    self.observe(slot, id, self.now(), goal);
                }
            }
            if slot.mem().heartbeat.is_none() {
                self.start_heartbeat(slot, id);
            }
        } else {
            let mut mem = slot.mem();
            Self::stop_heartbeat(&mut mem);
            mem.anchor = None;
        }
        let Some(goal) = goal.as_mut() else { return };
        if !running || !(number(goal, "timeLimitMs") > 0.0) {
            return;
        }
        let at = self.now();
        self.drop_suspended(slot, id, goal, at);
        let remaining = (number(goal, "timeLimitMs") - active_elapsed_ms(goal, at)).max(0.0);
        if remaining <= 0.0 {
            self.spawn_limit_check(id);
            return;
        }
        let warnings = self.warning_state(slot, id, Some(goal), at);
        if let Some(warnings) = warnings {
            if warnings.crossed != 0.0 {
                let seen = goal.clone();
                self.spawn_crossed_warning(slot, id, warnings.crossed, &seen);
            } else if warnings.next_delay > 0.0 {
                let delay = f64::min(remaining, warnings.next_delay + WARNING_MARGIN_MS);
                let (weak, task_id) = (Arc::downgrade(self), id.to_owned());
                let timer = self.env.timers.after(
                    TimerKind::Warning,
                    delay,
                    Box::new(move || {
                        let Some(inner) = weak.upgrade() else { return };
                        inner.slot(&task_id).mem().warning_timer = None;
                        inner.spawn_warning(&task_id);
                    }),
                );
                slot.mem().warning_timer = Some(timer);
            }
        }
        let (weak, task_id) = (Arc::downgrade(self), id.to_owned());
        let timer = self.env.timers.after(
            TimerKind::Deadline,
            remaining,
            Box::new(move || {
                let Some(inner) = weak.upgrade() else { return };
                let slot = inner.slot(&task_id);
                slot.mem().deadline_timer = None;
                let (task_slot, id) = (slot.clone(), task_id.clone());
                inner.spawn_mutation(task_id, move |tx| tx.expire_if_due(&task_slot, &id), |_| {});
            }),
        );
        slot.mem().deadline_timer = Some(timer);
    }

    fn start_heartbeat(self: &Arc<Self>, slot: &Arc<Slot>, id: &str) {
        let generation = {
            let mut mem = slot.mem();
            mem.heartbeat_gen += 1;
            mem.heartbeat_gen
        };
        self.schedule_beat(slot, id, generation);
    }

    /// The beat repeats until the Goal stops running (`setInterval`).
    fn schedule_beat(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, generation: u64) {
        let (weak, task_id): (Weak<Inner>, String) = (Arc::downgrade(self), id.to_owned());
        let timer = self.env.timers.after(
            TimerKind::Heartbeat,
            GOAL_LIVE_HEARTBEAT_MS,
            Box::new(move || {
                let Some(inner) = weak.upgrade() else { return };
                let slot = inner.slot(&task_id);
                if slot.mem().heartbeat_gen != generation || inner.is_closed() {
                    return;
                }
                inner.schedule_beat(&slot, &task_id, generation);
                let task_slot = slot.clone();
                let beat_id = task_id.clone();
                inner.spawn_mutation(task_id, move |tx| tx.beat(&task_slot, &beat_id), |_| {});
            }),
        );
        slot.mem().heartbeat = Some(timer);
    }
}

impl Tx<'_> {
    /// The deadline timer's / expiry check's mutation: settle the suspension first, then decide.
    pub(crate) fn expire_if_due(&mut self, slot: &Arc<Slot>, id: &str) -> GoalResult<()> {
        if self.inner.is_closed() {
            return Ok(());
        }
        let mut current = self.read_stored()?;
        let at = self.now();
        if self.inner.settle_projection(slot, id, current.as_mut(), at) {
            let current = current.expect("an expired Goal exists");
            self.commit(Some(current.clone()), None)?;
            self.inner.observe(slot, id, at, &current);
        }
        Ok(())
    }

    pub(crate) fn deliver_warning(&mut self, slot: &Arc<Slot>, id: &str, target: f64) -> GoalResult<()> {
        if self.inner.is_closed() {
            return Ok(());
        }
        let mut current = self.read_stored()?;
        let state = self.inner.warning_state(slot, id, current.as_mut(), self.now());
        let Some(state) = state.filter(|s| s.crossed != 0.0 && s.crossed == target) else { return Ok(()) };
        let _ = state;
        let mut goal = current.expect("a warned Goal exists");
        let warned = normalize_deadline_warned_ms(goal.get("deadlineWarnedMs")).min(target);
        put_num(&mut goal, "deadlineWarnedMs", warned);
        let revision = count(&goal, "warningRevision") + 1.0;
        put_num(&mut goal, "warningRevision", revision);
        let now = self.now();
        put_num(&mut goal, "updatedAt", now);
        self.commit(Some(goal), None)?;
        Ok(())
    }

    /// The heartbeat: re-stamp the record, or drop a stretch the PC slept through and republish.
    pub(crate) fn beat(&mut self, slot: &Arc<Slot>, id: &str) -> GoalResult<()> {
        if self.inner.is_closed() {
            return Ok(());
        }
        let Some(mut goal) = self.read_stored()? else { return Ok(()) };
        if string(&goal, "status") != "active" || !truthy(goal.get("lastStartedAt")) {
            return Ok(());
        }
        let at = self.now();
        if self.inner.drop_suspended(slot, id, &mut goal, at) {
            self.commit(Some(goal.clone()), None)?;
        } else {
            put_num(&mut goal, "liveAt", at);
            self.stamp_live(&goal)?;
        }
        self.inner.observe(slot, id, at, &goal);
        Ok(())
    }
}
