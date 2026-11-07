//! The workers' `status` and `stage` the workspace guard reads (1.4.5 `activity-guards.mjs`
//! `assertLeadIdle`): the rows the agent list shows by default (`job-views/agent-list.mjs`,
//! `memoryOnly`: the worker index and the live sessions, no session record read) with the
//! `status`/`stage` each shows, and how many of them are busy (`BUSY_WORKER_STATES`).
//! `session_entries` answers the session records themselves, which carry neither the live
//! runtime's stage nor the list's filter.

use super::*;

/// `BUSY_WORKER_STATES`: `ACTIVE_STAGES` and the states of a worker not started yet.
const BUSY_WORKER_STATES: [&str; 10] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling", "starting", "spawning", "queued", "pending"];

/// One listed worker session: the `status` and `stage` of its list row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerState {
    pub session_id: String,
    pub status: String,
    pub stage: String,
}

/// `CANCELLED_WORKER_STATUS`: `^(?:cancelled|canceled|killed|cancel[-_\s]?(?:unconfirmed|pending))$`.
fn is_cancelled_status(status: &str) -> bool {
    if matches!(status, "cancelled" | "canceled" | "killed") {
        return true;
    }
    let Some(rest) = status.strip_prefix("cancel") else { return false };
    let rest = match rest.chars().next() {
        Some(c) if c == '-' || c == '_' || mixdog_js::is_js_space(c) => &rest[c.len_utf8()..],
        _ => rest,
    };
    matches!(rest, "unconfirmed" | "pending")
}

/// `isActiveWorkerRow`: `status` decides, the stage only stands in for a row with no status, and a
/// cancel in either field is not work.
fn is_active_worker_row(status: &str, stage: &str) -> bool {
    let (status, stage) = (mixdog_js::js_trim(status).to_lowercase(), mixdog_js::js_trim(stage).to_lowercase());
    if is_cancelled_status(&stage) || is_cancelled_status(&status) {
        return false;
    }
    let effective = if status.is_empty() { &stage } else { &status };
    if ACTIVE_STAGES.contains(&effective.as_str()) {
        return true;
    }
    if effective.is_empty() || effective == "unknown" {
        return false;
    }
    !is_terminal_worker_status(effective)
}

/// `lower(value)`: `String(value || '').toLowerCase()`, no trimming.
fn is_busy_worker_state(value: &str) -> bool {
    BUSY_WORKER_STATES.contains(&value.to_lowercase().as_str())
}

impl AgentRegistry {
    /// The list's rows for `scope` (`views.list({ scanSessions: false, context, memoryOnly: true })`):
    /// the index refreshed first, then every tag-bound worker session of the scope whose row is
    /// active, each with its `rowState`. Order is the registry's.
    pub async fn worker_states(&self, scope: &Scope) -> Vec<WorkerState> {
        self.refresh_tags_from_sessions(false, scope).await;
        self.session_entries(false, scope)
            .into_iter()
            .filter_map(|(_, session)| {
                let id = clean(session.get("id"));
                let text = |key: &str| session.get(key).filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string);
                // `rowState`: a closed session reads `closed`; a stage of its own wins; a finished
                // status is its own stage; otherwise the live runtime's.
                let status = if session.get("closed") == Some(&Value::Bool(true)) { "closed".to_owned() } else { text("status").unwrap_or_else(|| "idle".to_owned()) };
                let stage = text("stage").unwrap_or_else(|| {
                    if matches!(status.as_str(), "idle" | "error" | "closed") {
                        status.clone()
                    } else {
                        self.live.runtime_stage(&id).filter(|stage| !stage.is_empty()).unwrap_or_else(|| status.clone())
                    }
                });
                is_active_worker_row(&status, &stage).then_some(WorkerState { session_id: id, status, stage })
            })
            .collect()
    }

    /// `assertLeadIdle`'s `busyWorkers`: the listed workers whose `status` or `stage` is busy.
    pub async fn busy_worker_count(&self, scope: &Scope) -> u64 {
        self.worker_states(scope).await.iter().filter(|w| is_busy_worker_state(&w.status) || is_busy_worker_state(&w.stage)).count() as u64
    }
}

#[cfg(test)]
mod tests;