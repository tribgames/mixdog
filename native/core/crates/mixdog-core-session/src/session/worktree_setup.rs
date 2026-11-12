//! The one-time preparation of a session's new worktree at the first turn it runs there
//! (frozen dependency installs), with its progress for viewers and the compact note the agent
//! gets with that turn (Node `worktree-setup.mjs`).
//!
//! The setup belongs to the worktree it was made for, whichever path made it (a worktree
//! task, a branch selection, `git worktree add`): its registry entry keeps it pending
//! (`Worktrees::claim_setup`) until the first turn a session runs there, never in another
//! folder. The installs create no link of their own; the links a worktree owns are made, and
//! recorded (`Worktrees::record_link`), by its creation, so removal always knows them.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::dependencies::PlanInput;
use mixdog_scm::worktree::dependencies::plan_dependency_setup;
use mixdog_scm::worktree::manager::Worktrees;
use serde_json::Value;

use super::Workspace;
use super::new_tx_id;
use super::thrown_message;
use super::worktree_setup_note::PreparationReport;
use super::worktree_setup_note::worktree_preparation_note;
use super::worktree_setup_run::RunOptions;
use super::worktree_setup_run::SetupEvent;
use super::worktree_setup_run::SetupReport;
use super::worktree_setup_run::SetupRunner;

/// The note the agent gets with the next turn (`session.pendingSetupNotice`).
#[derive(Clone, Debug, PartialEq)]
pub struct SetupNotice {
    /// Milliseconds since the epoch.
    pub revision: i64,
    pub content: String,
}

/// How a preparation ended for the turn: the notice to keep, and whether the turn was
/// cancelled meanwhile (it then aborts like any other stop, after the notice is kept).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetupRun {
    pub notice: Option<SetupNotice>,
    pub cancelled: bool,
}

/// A viewer of the setup progress; a panicking viewer never stops the setup.
pub type SetupListener = Arc<dyn Fn(Value) + Send + Sync>;

type Listeners = Arc<Mutex<Vec<(u64, SetupListener)>>>;

/// Dropping it unsubscribes the listener.
pub struct SetupSubscription {
    listeners: Listeners,
    id: u64,
}

impl Drop for SetupSubscription {
    fn drop(&mut self) {
        self.listeners.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|(id, _)| *id != self.id);
    }
}

pub struct WorktreeSetup {
    worktrees: Arc<Worktrees>,
    runner: SetupRunner,
    listeners: Listeners,
    next: AtomicU64,
}

fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl WorktreeSetup {
    pub fn new(worktrees: Arc<Worktrees>, processes: Arc<dyn ProcessManager>) -> Self {
        Self { worktrees, runner: SetupRunner::new(processes), listeners: Listeners::default(), next: AtomicU64::new(0) }
    }

    /// Subscribe to worktree setup progress; every event carries `id`, `sessionId` and `cwd`.
    pub fn on_worktree_setup(&self, listener: SetupListener) -> SetupSubscription {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.listeners.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((id, listener));
        SetupSubscription { listeners: self.listeners.clone(), id }
    }

    fn emit(&self, event: &SetupEvent, id: &str, session_id: &str, cwd: &str) {
        let mut value = event.to_value();
        if let Some(object) = value.as_object_mut() {
            object.insert("id".into(), id.into());
            object.insert("sessionId".into(), session_id.into());
            object.insert("cwd".into(), cwd.into());
        }
        let listeners: Vec<SetupListener> =
            self.listeners.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(value.clone())));
        }
    }

    /// Prepare the session's new worktree, once, under the turn (its admission keeps the
    /// folder from being merged or removed; its token, the Stop button, cancels): the frozen
    /// installs the links made at creation did not cover. A failure or timeout is in the
    /// note and the turn goes on; a cancel aborts the turn like any other stop. The worktree
    /// stays either way.
    pub async fn run_pending(&self, session_id: &str, workspace: Option<&Value>, cancel: &CancellationToken) -> Result<SetupRun, ScmFailure> {
        let Some(here) = workspace.and_then(|w| Workspace::from_value(w).ok()).filter(Workspace::is_bound) else {
            return Ok(SetupRun::default());
        };
        let Some(worktree_id) = here.worktree_id.as_deref() else { return Ok(SetupRun::default()) };
        let Some(claimed) = self.worktrees.claim_setup(worktree_id, cancel).await? else { return Ok(SetupRun::default()) };
        let id = new_tx_id();
        let root = claimed
            .prepared
            .as_ref()
            .and_then(|p| p.get("root"))
            .and_then(Value::as_str)
            .filter(|root| !root.is_empty())
            .unwrap_or(&here.project_path)
            .to_owned();
        let mut dependency_notes = Vec::new();
        let mut installs: Option<SetupReport> = None;
        let mut notes = Vec::new();
        if !claimed.blocked.is_empty() {
            let blocked = &claimed.blocked;
            notes.push(format!(
                "Dependencies were not installed: {} {}, and any install here could empty the folder it points at (such as the main checkout's) through it. Remove the link (never its target); the next turn installs.",
                blocked.join(", "),
                if blocked.len() > 1 { "are links" } else { "is a link" },
            ));
            return Ok(self.finish(&root, &claimed.prepared, &dependency_notes, installs.as_ref(), &notes, false));
        }
        let planned = plan_dependency_setup(
            self.worktrees.scm(),
            cancel,
            PlanInput {
                worktree_dir: here.cwd.clone().into(),
                main_dir: Some(here.project_path.clone().into()),
                shared: claimed.shared.clone(),
                path_var: None,
            },
        )
        .await;
        match planned {
            Ok(plan) => {
                dependency_notes = plan.notes;
                if !plan.commands.is_empty() {
                    installs = Some(
                        self.runner
                            .run(plan.commands, cancel, &RunOptions::default(), &mut |event| self.emit(&event, &id, session_id, &here.cwd))
                            .await,
                    );
                }
            }
            Err(error) => {
                if !cancel.is_cancelled() {
                    notes.push(format!("Dependencies could not be prepared: {}", thrown_message(&error)));
                }
            }
        }
        Ok(self.finish(&root, &claimed.prepared, &dependency_notes, installs.as_ref(), &notes, cancel.is_cancelled()))
    }

    fn finish(&self, root: &str, prepared: &Option<Value>, dependency_notes: &[String], installs: Option<&SetupReport>, notes: &[String], cancelled: bool) -> SetupRun {
        let content = worktree_preparation_note(&PreparationReport { root, prepared: prepared.as_ref(), dependency_notes, installs, notes });
        SetupRun { notice: Some(SetupNotice { revision: now_ms(), content }), cancelled }
    }
}
