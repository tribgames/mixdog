//! The surfaces' control of the background shells of one thread: the structured stop of one job
//! or of all of them (`stopBackgroundShellJob`, `stopBackgroundShellJobs`), the list `/stop`
//! shows (`listStoppableShellJobs`), and the owner-wide cancel of a closing session
//! (`cancelOwnedShellTrees` plus `cancelBackgroundTasks({surface: 'shell'})`). The cancel is the
//! `task` tool's own, so a shell has one kill route.

use std::sync::Arc;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_spawn::tasks::TaskRow;
use mixdog_spawn::tasks::TaskStatus;
use serde_json::json;

use super::jobs::ExecRuntime;
use super::task::CancelOutcome;
use super::task::cancel_job;
use super::task::send_kill;

/// One background shell a stop would end (`listStoppableShellJobs`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StoppableJob {
    pub task_id: String,
    pub command: String,
}

/// The running shells control of one runtime over the process manager that spawned them.
pub struct ShellControl {
    runtime: Arc<ExecRuntime>,
    processes: Arc<dyn ProcessManager>,
}

impl ShellControl {
    pub fn new(runtime: Arc<ExecRuntime>, processes: Arc<dyn ProcessManager>) -> Self {
        Self { runtime, processes }
    }

    pub fn tasks(&self) -> &Arc<TaskRegistry> {
        &self.runtime.config.tasks
    }

    /// The task row of a shell that is held with its termination unconfirmed (the termination
    /// holds `forceReleaseTerminationHold` looks up).
    pub fn hold(&self, task_id: &str) -> Option<TaskRow> {
        self.tasks().get(task_id).filter(|row| row.surface == "shell" && row.termination_unconfirmed)
    }

    /// `hold.release()`: the job and its row go; its processes stay as they are.
    pub fn release(&self, task_id: &str) {
        self.runtime.release(task_id);
    }

    /// `sessionShellTasks`: the running background shells `owner` has, including a task whose
    /// command already exited while its tracked descendants still run. A foreground command
    /// holds no background task, so it never appears.
    fn owned_background(&self, owner: &ThreadId) -> Vec<TaskRow> {
        if owner.as_str().is_empty() {
            return Vec::new();
        }
        self.tasks()
            .list()
            .into_iter()
            .filter(|row| {
                row.surface == "shell"
                    && !row.foreground
                    && row.owner.as_deref() == Some(owner.as_str())
                    && (row.status == TaskStatus::Running || row.termination_unconfirmed)
            })
            .collect()
    }

    /// `listStoppableShellJobs`.
    pub fn list_stoppable(&self, owner: &ThreadId) -> Vec<StoppableJob> {
        self.owned_background(owner)
            .into_iter()
            .map(|row| StoppableJob { task_id: row.task_id, command: row.command })
            .collect()
    }

    /// `stopBackgroundShellJob`: `{stopped: true}` only when the job was actually cancelled. A job
    /// that had already ended answers `finished: true` with its terminal status in `error`; one
    /// that is not the owner's reads as unknown. The registry keeps no job record across a
    /// restart (decisions.md, "Shell job records"), so a job it does not hold is unknown.
    pub async fn stop_job(&self, owner: &ThreadId, task_id: &str) -> JsonValue {
        let id = mixdog_js::js_trim(task_id);
        if id.is_empty() {
            return json!({ "stopped": false, "error": "task_id is required" });
        }
        let unknown = || json!({ "stopped": false, "error": format!("task not found: {id}") });
        let Some(job) = self.runtime.get(owner, id) else { return unknown() };
        let Some(row) = self.tasks().get(id).filter(|row| row.surface == "shell" && !row.foreground) else {
            return unknown();
        };
        // A root that exited while tracked descendants run is still stoppable.
        if !job.is_running() && !row.termination_unconfirmed {
            return json!({ "stopped": false, "finished": true, "error": format!("task already {}: {id}", job.status().as_str()) });
        }
        match cancel_job(&self.runtime, &*self.processes, &job).await {
            CancelOutcome::Cancelled => json!({ "stopped": true }),
            CancelOutcome::Unconfirmed | CancelOutcome::Pending => {
                json!({ "stopped": false, "unconfirmed": true, "error": format!("cancellation not confirmed: {id}") })
            }
        }
    }

    /// `stopBackgroundShellJobs`: every background shell of `owner`, each through the same
    /// confirmed cancel. `stopping` counts those whose processes are not yet confirmed gone.
    pub async fn stop_jobs(&self, owner: &ThreadId) -> JsonValue {
        let answers = futures::future::join_all(
            self.owned_background(owner).iter().map(|row| self.stop_job(owner, &row.task_id)),
        )
        .await;
        let count = |key: &str| answers.iter().filter(|answer| answer[key] == JsonValue::Bool(true)).count();
        json!({ "stopped": count("stopped"), "stopping": count("unconfirmed") })
    }

    /// `cancelOwnedShellTrees(id)` and `cancelBackgroundTasks({surface: 'shell',
    /// executionSessionId: id})` of a closing session, then `noteShellOwnerSessionClosed`: every
    /// shell the thread started is killed, those of a finished command that outlived it through
    /// their observer, and what is still held is flagged for the sessions that see its folder.
    /// The close does not wait for a confirmation.
    pub fn cancel_owned(&self, owner: &ThreadId) {
        for job in self.runtime.list(owner) {
            if !job.is_running() {
                continue;
            }
            if job.survivors {
                let runtime = self.runtime.clone();
                drop(mixdog_rt::spawn("shell-owner-close", TaskClass::Work, async move {
                    match &runtime.config.survivors {
                        Some(watch) if watch.kill(&job.handle).await => runtime.finish_survivors(&job, true).await,
                        _ => runtime.hold_unconfirmed(&job),
                    }
                }));
            } else if !send_kill(&self.runtime, &*self.processes, &job) {
                // A kill that cannot be sent leaves the shell running and held, as a stop's would;
                // the close records an outcome only for a tombstone (`record`), which Rust never plants.
                self.runtime.hold_unconfirmed(&job);
            }
        }
        self.tasks().owner_closed(owner.as_str());
    }
}
