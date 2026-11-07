//! Rows whose turn a process exit or restart ended (1.4.5 `worker-index/restart-settlement.mjs`
//! with `row-liveness.mjs`): stale active rows settle at startup and on later sweeps, as failed
//! (`process-restart`) when another process ran their turn and as idle otherwise; an approval wait
//! left behind by a runtime that is gone clears; and the failures still owed to their owner are
//! listed and stamped once told.
//!
//! The recorded Node run is `fixtures/restart-settlement/golden.json`
//! (`record-restart-settlement.mjs`).

use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_agent::agent_tool::stamp::iso_from_ms;
use mixdog_js::JsRegex;
use serde_json::Value;

use super::*;

/// `PROCESS_RESTART_FAILURE`.
pub const PROCESS_RESTART_FAILURE: &str = "process-restart";

/// `WORKER_POOL_FRESH_MS`: an active row whose own stamp is this recent still has a worker.
const FRESH_MS: i64 = 2 * 60 * 1000;

/// Whether a process exists (`process.kill(pid, 0)`; a permission error means it does).
pub trait ProcessProbe: Send + Sync {
    fn alive(&self, pid: u64) -> bool;
}

/// What the settlement reads of the running daemon.
pub struct Liveness<'a> {
    pub probe: &'a dyn ProcessProbe,
    /// `process.pid`.
    pub own_pid: u64,
    /// `mgr.isSessionTurnInFlight(sessionId)`.
    pub running: &'a (dyn Fn(&str) -> bool + Sync),
    pub reap: &'a dyn ReapWindow,
    pub now_ms: i64,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

fn matches_status(pattern: &str, text: &str) -> bool {
    JsRegex::new_static(pattern, "i").is_match(text)
}

/// `isActiveWorkerRow`: `status` decides, `stage` only for a row with no status; a cancel in either is
/// not work.
pub fn is_active_worker_row(row: &Row) -> bool {
    const CANCELLED: &str = r"^(?:cancelled|canceled|killed|cancel[-_\s]?(?:unconfirmed|pending))$";
    const ACTIVE: &str = r"^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$";
    let (status, stage) = (clean(row.get("status")), clean(row.get("stage")));
    !matches_status(CANCELLED, &status) && !matches_status(CANCELLED, &stage) && matches_status(ACTIVE, if status.is_empty() { &stage } else { &status })
}

impl Liveness<'_> {
    /// `runtimeAlive(pid)`: an unknown pid, and this process, are alive.
    fn alive(&self, pid: Option<&Value>) -> bool {
        let id = Some(mixdog_js::to_number_of(pid)).filter(|n| !n.is_nan()).unwrap_or(0.0);
        if id <= 0.0 || id == self.own_pid as f64 {
            return true;
        }
        self.probe.alive(id as u64)
    }

    /// `runtimeDied(row)`.
    fn died(&self, row: &Row) -> bool {
        positive_int(row.get("runtimePid")).is_some() && !self.alive(row.get("runtimePid"))
    }

    /// `isStaleApprovalWait(row)`.
    fn stale_wait(&self, row: &Row) -> bool {
        truthy(row.get("awaitingUser")) && !self.alive(row.get("runtimePid"))
    }

    /// `liveness.isStaleActive(row, now)`.
    fn stale_active(&self, row: &Row) -> bool {
        if !is_active_worker_row(row) {
            return false;
        }
        if self.died(row) {
            return true;
        }
        if (self.running)(&clean(row.get("sessionId"))) {
            return false;
        }
        let updated = mixdog_js::time::date_parse(&clean(row.get("updatedAt")));
        let updated = if updated.is_nan() { 0 } else { updated as i64 };
        !(updated > 0 && self.now_ms - updated <= FRESH_MS)
    }

    fn terminal_reap_at(&self, row: &Row) -> Value {
        let ms = self.reap.terminal_reap_ms(&clean(row.get("provider")));
        if ms.is_finite() { Value::String(iso_from_ms(self.now_ms + ms as i64)) } else { Value::Null }
    }

    /// `liveness.idleRow(row, now, touch)`: the row settled to idle; an idle worker waits on nobody, so a
    /// persisted approval wait drops too.
    fn idle_row(&self, row: &Row, touch: bool) -> Row {
        let stamp = iso_from_ms(self.now_ms);
        let mut out = row.clone();
        out.shift_remove("awaitingUser");
        let kept = |key: &str| Some(clean(row.get(key))).filter(|s| !s.is_empty());
        out.insert("status".into(), "idle".into());
        out.insert("stage".into(), "idle".into());
        out.insert("turnStartedAt".into(), Value::Null);
        out.insert("finishedAt".into(), Value::String(if touch { stamp.clone() } else { kept("finishedAt").or_else(|| kept("updatedAt")).unwrap_or_else(|| stamp.clone()) }));
        out.insert("updatedAt".into(), Value::String(if touch { stamp.clone() } else { kept("updatedAt").unwrap_or(stamp) }));
        out.insert("reapAt".into(), if touch { self.terminal_reap_at(row) } else { kept("reapAt").map_or_else(|| self.terminal_reap_at(row), Value::String) });
        out
    }

    /// `liveness.failedRow`.
    fn failed_row(&self, row: &Row, reason: &str, touch: bool) -> Row {
        let mut out = self.idle_row(row, touch);
        out.insert("status".into(), "failed".into());
        out.insert("stage".into(), "failed".into());
        out.insert("failureReason".into(), reason.into());
        out
    }
}

/// `recoverStaleWorkerRows({ deadOnly })` over the rows of every session: the rows that change (by
/// session id) and whether anything was stale.
pub fn settle_rows(rows: &[(String, Row)], dead_only: bool, live: &Liveness<'_>) -> (Vec<(String, Row)>, bool) {
    let is_stale = |row: &Row| if dead_only { is_active_worker_row(row) && live.died(row) } else { live.stale_active(row) };
    let stale_active = rows.iter().any(|(_, row)| is_stale(row));
    let stale_waits = rows.iter().any(|(_, row)| live.stale_wait(row));
    if !stale_active && !stale_waits {
        return (Vec::new(), false);
    }
    let mut changed = Vec::new();
    for (session, row) in rows {
        let mut next = row.clone();
        if is_stale(row) {
            let elsewhere = positive_int(row.get("runtimePid")).is_some_and(|pid| pid != live.own_pid);
            next = if elsewhere { live.failed_row(row, PROCESS_RESTART_FAILURE, false) } else { live.idle_row(row, false) };
        }
        // `clearAwaitingUser(byKey, isStaleApprovalWait)`, after the settlement above.
        if truthy(next.get("awaitingUser")) && live.stale_wait(&next) {
            next.shift_remove("awaitingUser");
        }
        if next != *row {
            changed.push((session.clone(), next));
        }
    }
    (changed, true)
}

/// `isUnnotifiedRestartFailure(row)`.
pub fn is_unnotified_restart_failure(row: &Row) -> bool {
    row.get("status").and_then(Value::as_str) == Some("failed")
        && row.get("failureReason").and_then(Value::as_str) == Some(PROCESS_RESTART_FAILURE)
        && !clean(row.get("ownerSessionId")).is_empty()
        && !truthy(row.get("restartNotified"))
}

impl AgentRegistry {
    fn pool_rows(maps: Vec<(String, Row)>) -> Vec<(String, Row)> {
        maps.into_iter().filter(|(_, row)| !is_lead_pool_agent(row.get("agent"))).collect()
    }

    /// `recoverStaleWorkerRows({ deadOnly })`: settles what is stale and writes the changed rows;
    /// `Ok(false)` when nothing was stale.
    pub async fn recover_stale_worker_rows(&self, dead_only: bool, live: &Liveness<'_>) -> Result<bool, String> {
        let rows = Self::pool_rows(self.store.worker_maps().await?);
        let (changed, any) = settle_rows(&rows, dead_only, live);
        for (session, row) in changed {
            self.store.write(&session, Some(row));
        }
        Ok(any)
    }

    /// `pendingRestartFailures()`: the rows whose turn a restart ended and whose owner has not been told.
    pub async fn pending_restart_failures(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(Self::pool_rows(self.store.worker_maps().await?).into_iter().filter(|(_, row)| is_unnotified_restart_failure(row)).collect())
    }

    /// `markRestartNotified(rows)`: stamp them, once their notification is durably queued; a row that
    /// changed meanwhile is left alone.
    pub async fn mark_restart_notified(&self, sessions: &[String], stamp: &str) -> Result<(), String> {
        let rows = Self::pool_rows(self.store.worker_maps().await?);
        for (session, row) in rows {
            if sessions.contains(&session) && is_unnotified_restart_failure(&row) {
                let mut next = row;
                next.insert("restartNotified".into(), stamp.into());
                self.store.write(&session, Some(next));
            }
        }
        Ok(())
    }
}

/// `RESTART_FAILURE_ERROR`.
const RESTART_FAILURE_ERROR: &str = "process restart: the daemon restarted while this agent task was running";

/// `restartNotificationId(row)`: the stable dedup id of one lost task's notification; a row that never
/// recorded a task id falls back to its session and settle time.
pub fn restart_notification_id(row: &Row) -> String {
    let task = clean(row.get("task_id"));
    format!("restart:{}", if task.is_empty() { format!("{}:{}", clean(row.get("sessionId")), clean(row.get("finishedAt"))) } else { task })
}

/// `registerFailedTask(row)`: lets `agent status <id>` resolve the lost task after the restart. A row
/// that never recorded a task id, or whose id the board already holds, registers nothing. The
/// completion is acknowledged and not announced (the queued notification above is the announcement).
pub fn register_failed_task(board: &JobBoard, row: &Row) {
    let task = clean(row.get("task_id"));
    if task.is_empty() || board.get(&task, &Scope::default()).is_some() {
        return;
    }
    let owner = Some(clean(row.get("ownerSessionId")));
    let kept = |key: &str| Some(clean(row.get(key))).filter(|s| !s.is_empty());
    let registered = board.register(NewJob {
        task_id: Some(task.clone()),
        operation: "restart".into(),
        label: kept("tag"),
        owner: JobOwner { caller_session_id: owner.clone(), owner_session_id: owner, host_pid: positive_int(row.get("clientHostPid")) },
        meta: JobMeta {
            tag: kept("tag"),
            session_id: kept("sessionId"),
            agent: kept("agent"),
            provider: kept("provider"),
            model: kept("model"),
            preset: kept("preset"),
            effort: kept("effort"),
            ..JobMeta::default()
        },
        ..NewJob::default()
    });
    // A task the board refused is a status lookup that finds nothing, as Node's best-effort catch.
    if registered.is_err() {
        return;
    }
    board.complete(
        &task,
        Completion { error: Some(RESTART_FAILURE_ERROR.into()), notify: false, terminal_reason: Some(PROCESS_RESTART_FAILURE.into()), ..Completion::new("failed") },
    );
    board.acknowledge(&task);
}

impl AgentRegistry {
    /// `flushActiveWorkerRows()` at process exit: the rows this process wrote as active and still holds
    /// as active settle as failed (`process-restart`, stamped now), so a crash of the host never leaves
    /// them running; a row another process took over is left alone. The caller then awaits
    /// `StoreWorkers::settled` for the writes to reach the headers.
    pub fn flush_active_worker_rows(&self, live: &Liveness<'_>) {
        let mut st = self.lock();
        let keys: Vec<String> = st.active.drain().collect();
        for key in keys {
            let Some(current) = st.map(&key).cloned() else { continue };
            if positive_int(current.get("runtimePid")) != Some(live.own_pid) || !is_active_worker_row(&current) {
                continue;
            }
            self.persist(&mut st, &key, Some(live.failed_row(&current, PROCESS_RESTART_FAILURE, true)));
        }
    }
}

/// `notifyRestartFailures()`: tells each owner, once, that its agent task died with the previous process.
/// The notification is queued under its stable execution id first (`TaskNotifier::finished`, which the
/// session directory queues for the owner's model), and only then is the row stamped, so a crash between
/// the two retries the row and the id makes the retry exactly-once. Returns how many owners were told.
pub async fn notify_restart_failures(
    registry: &AgentRegistry,
    notifier: &dyn mixdog_tools::exec::TaskNotifier,
    board: &JobBoard,
    stamp: &str,
) -> Result<usize, String> {
    let mut told = 0;
    for (session, row) in registry.pending_restart_failures().await? {
        let execution = restart_notification_id(&row);
        let task = clean(row.get("task_id"));
        let text = mixdog_agent::agent_tool::board::render_agent_completion(
            if task.is_empty() { &execution } else { &task },
            &clean(row.get("tag")),
            "failed",
            "",
            RESTART_FAILURE_ERROR,
            "",
        );
        notifier.finished(&ThreadId::from(clean(row.get("ownerSessionId")).as_str()), "agent", &execution, "failed", text).await;
        registry.mark_restart_notified(&[session], stamp).await?;
        register_failed_task(board, &row);
        told += 1;
    }
    Ok(told)
}

#[cfg(test)]
mod tests;
