//! The `git` tool's worktree operations over the workspace transitions (Node
//! `worktree-tool.mjs`): the caller's own session runs with `ownTurn` (the calling turn is
//! tolerated; workers, background shells and other sessions in an affected folder are not);
//! another session runs without it, so a target with a running turn, workers or background
//! shells refuses.

use super::*;

impl Inner {
    /// `assertWorktreeMutationAllowed`: only a conversation session changes worktrees.
    async fn assert_mutation_allowed(&self, caller: &str, what: &str) -> Result<(), ScmFailure> {
        if self.host.attended(caller).await {
            return Ok(());
        }
        Err(plain(format!(
            "{what} changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them"
        )))
    }

    async fn enter(
        self: &Arc<Self>,
        target: &str,
        own_turn: bool,
        name: Option<String>,
        branch: Option<String>,
        create: bool,
        carry: Option<String>,
        confirm_large: bool,
        tx_id: String,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        if let Some(branch) = branch {
            let input = SelectBranch { branch, create, expected_revision: None, confirm_large, tx_id };
            return self.select_branch(target, input, own_turn, cancel).await;
        }
        // A valid slug names the worktree; any other text is a hint the slug is made from.
        let name = mixdog_js::js_trim(&name.unwrap_or_default()).to_owned();
        let slug = (!name.is_empty() && names::name_error(&name).is_none()).then(|| name.clone());
        let input = RequestWorktree {
            prompt: if slug.is_some() { String::new() } else { name },
            name: slug,
            provision: true,
            carry_changes: carry,
            confirm_large,
            tx_id,
            expected_revision: None,
        };
        self.request_worktree(target, input, own_turn, cancel).await
    }

    /// Back to the project folder (the branch checked out there); the worktree stays retained.
    async fn back(self: &Arc<Self>, target: &str, own_turn: bool, tx_id: String, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let workspace = self.workspace_view(target, cancel).await?;
        if !workspace.is_bound() && same_path(&workspace.cwd, &workspace.project_path) {
            return Ok(json!({ "revision": workspace.revision, "workspace": workspace.to_value(), "unchanged": true }));
        }
        let occupancy = self
            .ops
            .wt
            .branch_occupancy(std::path::Path::new(&workspace.project_path), Some(target), cancel)
            .await?;
        let branch = occupancy["occupancy"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["kind"] == "current"))
            .and_then(|row| row["branch"].as_str())
            .map(str::to_owned);
        let Some(branch) = branch else {
            return Err(errors::unsupported_repo(Some(workspace.project_path.clone()), None));
        };
        let input = SelectBranch { branch, create: false, expected_revision: Some(workspace.revision), confirm_large: false, tx_id };
        self.select_branch(target, input, own_turn, cancel).await
    }

    /// The desktop's "merge": into the confirmed merge target, then the cleanup autoCleanup allows.
    async fn merge(self: &Arc<Self>, target: &str, own_turn: bool, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let workspace = self.workspace_view(target, cancel).await?;
        let input = MergeWorkspace {
            confirmed: true,
            target: workspace.merge_target.clone(),
            cleanup: true,
            expected_revision: Some(workspace.revision),
        };
        self.merge_workspace(target, input, own_turn, cancel).await
    }

    /// `git worktree remove <path>`-style removal of the worktree at `path`, whichever owner
    /// holds it: the session's own lane, with the same guards as the desktop's removal.
    pub(super) async fn remove_path(self: &Arc<Self>, path: &str, force: bool, caller: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let entry = self.ops.worktree_by_path(path, cancel).await?.ok_or_else(|| {
            plain(format!(
                "git worktree remove: {path} is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool"
            ))
        })?;
        if entry.owner_session_id.as_deref() != Some(caller) {
            if let Some(gone) = self.orphan(cancel, |row| row["id"] == entry.id.as_str()).await? {
                return self.remove_orphan(&gone, force, cancel).await;
            }
        }
        let Some(owner) = entry.owner_session_id.clone() else {
            return Err(plain(format!(
                "git worktree remove: no session retains {}; git worktree prune removes it once it is clean and merged",
                entry.path
            )));
        };
        let own = owner == caller;
        let workspace = self.workspace_view(&owner, cancel).await?;
        // This session's worktree that it does not work in: removed where it is, without
        // entering it (its own running workers elsewhere never block that).
        if own && workspace.worktree_id.as_deref() != Some(entry.id.as_str()) {
            return self.remove_owned(&owner, &entry.id, force, cancel).await;
        }
        let retained = self.ops.session_worktree(&owner, cancel).await?;
        if retained.as_ref().map(|r| r.id.as_str()) != Some(entry.id.as_str()) {
            return Err(plain(format!(
                "git worktree remove: {} is not the current worktree of session {owner}; enter it (worktree_action enter, branch {}) first, then remove it",
                entry.path,
                entry.branch.clone().unwrap_or_default()
            )));
        }
        self.remove_worktree(&owner, force, Some(workspace.revision), own, cancel).await
    }

    async fn remove(
        self: &Arc<Self>,
        target: &str,
        caller: &str,
        branch: Option<String>,
        force: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        if let Some(branch) = branch {
            // By branch: the managed worktree of that branch this session owns.
            let rows = self.list_rows(cancel).await?;
            let row = rows
                .iter()
                .find(|row| row["branch"] == branch.as_str() && row["ownerSessionId"] == caller)
                .ok_or_else(|| {
                    plain(format!(
                        "git worktree remove: this session owns no managed worktree of branch {branch}; git worktree list shows them"
                    ))
                })?;
            let path = row["path"].as_str().unwrap_or_default().to_owned();
            return self.remove_path(&path, force, caller, cancel).await;
        }
        if target != caller {
            if let Some(gone) = self.orphan(cancel, |row| row["ownerSessionId"] == target).await? {
                return self.remove_orphan(&gone, force, cancel).await;
            }
        }
        self.remove_worktree(target, force, None, target == caller, cancel).await
    }
}

#[async_trait]
impl SessionWorktrees for SessionWorkspaces {
    async fn is_lead(&self, session_id: &str) -> bool {
        self.inner.host.is_lead(session_id).await
    }

    async fn run(&self, op: SessionOp, caller_session_id: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let inner = &self.inner;
        let caller = caller_session_id;
        let (what, target, tx_id) = match &op {
            SessionOp::Enter { session_id, tx_id, .. } => ("enter", session_id, tx_id),
            SessionOp::Return { session_id, tx_id } => ("return", session_id, tx_id),
            SessionOp::Merge { session_id, tx_id } => ("merge", session_id, tx_id),
            SessionOp::Remove { session_id, tx_id, .. } => ("remove", session_id, tx_id),
        };
        inner.assert_mutation_allowed(caller, &format!("git worktree {what}")).await?;
        let target = target.clone().unwrap_or_else(|| caller.to_owned());
        let own_turn = target == caller;
        let tx_id = tx_id.clone();
        match op {
            SessionOp::Enter { name, branch, create, carry, confirm_large, .. } => {
                inner.enter(&target, own_turn, name, branch, create, carry, confirm_large, tx_id, cancel).await
            }
            SessionOp::Return { .. } => inner.back(&target, own_turn, tx_id, cancel).await,
            SessionOp::Merge { .. } => inner.merge(&target, own_turn, cancel).await,
            SessionOp::Remove { branch, force, .. } => inner.remove(&target, caller, branch, force, cancel).await,
        }
    }
}
