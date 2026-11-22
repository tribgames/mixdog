//! The Project switch of a Lead: the desktop and remote `setCwd`. Admitted like a workspace transition,
//! refused while a turn or workers run and while the session works in a managed worktree; the
//! runtime cwd, `session.cwd`, the workspace record and the desktop classification move
//! together through the host, journaled so a failure puts back what already moved.

use super::*;

const WORKTREE_BOUND_SWITCH: &str = "The session works in a managed worktree; exit the worktree first (switch to a project-folder branch, or merge or remove the worktree) before moving it to another project.";

impl SessionWorkspaces {
    /// Switch the hosted `session` to another Project: `cwd` is the
    /// resolved folder, `desktop_session` the classification to store (`None`: the session has
    /// none). Background shells do not refuse it. Resolves the runtime cwd after the switch.
    /// `own_turn`: the Lead's own `session set-project` call, which tolerates its calling turn.
    pub async fn switch_project(
        &self,
        session: &str,
        cwd: &str,
        desktop_session: Option<JsonValue>,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        self.switch_project_moved(session, cwd, desktop_session, own_turn, None, cancel).await
    }

    /// [`Self::switch_project`] that carries out the pending Project move `project_move`, when one is given.
    pub(super) async fn switch_project_moved(
        &self,
        session: &str,
        cwd: &str,
        desktop_session: Option<JsonValue>,
        own_turn: bool,
        project_move: Option<JsonValue>,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        let inner = &self.inner;
        let leave = inner.gate.begin_transition(session, &format!("project:{}", new_tx_id()))?;
        let mut journal = Journal::default();
        let outcome = inner.switch_project(session, cwd, Stored { desktop_session, project_move }, own_turn, &mut journal, cancel).await;
        if outcome.is_err() {
            journal.undo_all().await;
        }
        drop(leave);
        outcome
    }
}

/// What a Project switch stores with the folder: the desktop classification (`None`: the session has none), and the pending
/// Project move the switch carries out, when it carries one out.
pub(super) struct Stored {
    pub(super) desktop_session: Option<JsonValue>,
    pub(super) project_move: Option<JsonValue>,
}

impl Inner {
    pub(super) async fn switch_project(
        self: &Arc<Self>,
        session: &str,
        cwd: &str,
        stored: Stored,
        own_turn: bool,
        journal: &mut Journal,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        let Stored { desktop_session, project_move } = stored;
        self.assert_lead_idle_with(session, own_turn, false).await?;
        let view = self.hosted(session)?;
        if read_session_workspace(view.workspace.as_ref()).is_some_and(|workspace| workspace.is_bound()) {
            return Err(plain(WORKTREE_BOUND_SWITCH));
        }
        if !same_path(&view.runtime_cwd, cwd) {
            let checkout = self.of(cwd, cancel).await?;
            self.gate.retain_admitted_turn_workspace(session, cwd, checkout.as_ref())?;
        }
        let (workspace, _) = workspace_for_project_selection(view.workspace.as_ref(), cwd);
        let record_moved = workspace != view.workspace;
        let change = WorkspaceChange { cwd: cwd.to_owned(), workspace: workspace.unwrap_or(JsonValue::Null), moved: None, desktop_session, project_move };
        journal.push(self.host.apply(session, change).await?);
        // A record left behind releases the worker lock its worktree held.
        if record_moved {
            let prior_lock = self.gate.workspace_cwd_lock(&[session]);
            let (gate, id) = (self.gate.clone(), session.to_owned());
            journal.push(undo(async move {
                gate.set_workspace_cwd_lock(&id, prior_lock.as_deref());
                Ok(())
            }));
            self.gate.set_workspace_cwd_lock(session, None);
        }
        Ok(cwd.to_owned())
    }
}
