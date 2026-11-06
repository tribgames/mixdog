//! The Project switch of a Lead (Node `transition-runner.mjs` and `transition-steps.mjs`
//! `switchProject`): the desktop and remote `setCwd`. Admitted like a workspace transition,
//! refused while a turn or workers run and while the session works in a managed worktree; the
//! runtime cwd, `session.cwd`, the workspace record and the desktop classification move
//! together through the host, journaled so a failure puts back what already moved.

use super::*;

/// `WORKTREE_BOUND_SWITCH`.
const WORKTREE_BOUND_SWITCH: &str = "The session works in a managed worktree; exit the worktree first (switch to a project-folder branch, or merge or remove the worktree) before moving it to another project.";

impl SessionWorkspaces {
    /// `switchProject(cwd, { classifyByMembership: true })` of the hosted `session`: `cwd` is the
    /// resolved folder, `desktop_session` the classification to store (`None`: the session has
    /// none). Background shells do not refuse it. Resolves the runtime cwd after the switch.
    pub async fn switch_project(
        &self,
        session: &str,
        cwd: &str,
        desktop_session: Option<JsonValue>,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        let inner = &self.inner;
        let leave = inner.gate.begin_transition(session, &format!("project:{}", new_tx_id()))?;
        let mut journal = Journal::default();
        let outcome = inner.switch_project(session, cwd, desktop_session, &mut journal, cancel).await;
        if outcome.is_err() {
            journal.undo_all().await;
        }
        drop(leave);
        outcome
    }
}

impl Inner {
    async fn switch_project(
        self: &Arc<Self>,
        session: &str,
        cwd: &str,
        desktop_session: Option<JsonValue>,
        journal: &mut Journal,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        self.assert_lead_idle_with(session, false, false).await?;
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
        let change = WorkspaceChange {
            cwd: cwd.to_owned(),
            workspace: workspace.unwrap_or(JsonValue::Null),
            moved: None,
            desktop_session,
        };
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
