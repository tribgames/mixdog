//! The `git` tool's worktree operations over the workspace transitions: the caller's own session runs with `ownTurn` (the calling turn is
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
        selection: (Option<String>, Option<String>, bool),
        carrying: (Option<String>, bool),
        tx_id: String,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let (name, branch, create) = selection;
        let (carry, confirm_large) = carrying;
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
        let branch = self.project_folder_branch(target, &workspace.project_path, cancel).await?;
        let input = SelectBranch { branch, create: false, expected_revision: Some(workspace.revision), confirm_large: false, tx_id };
        self.select_branch(target, input, own_turn, cancel).await
    }

    /// The branch checked out in the project folder, which `return` goes back to: a detached folder refuses.
    pub(super) async fn project_folder_branch(&self, session: &str, project_path: &str, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let occupancy = self.ops.wt.branch_occupancy(std::path::Path::new(project_path), Some(session), cancel).await?;
        occupancy["occupancy"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["kind"] == "current"))
            .and_then(|row| row["branch"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| errors::unsupported_repo(Some(project_path.to_owned()), None))
    }

    /// The desktop's "merge": into the confirmed merge target, then the cleanup autoCleanup allows.
    async fn merge(self: &Arc<Self>, target: &str, own_turn: bool, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let workspace = self.workspace_view(target, cancel).await?;
        let input = MergeWorkspace { confirmed: true, target: workspace.merge_target.clone(), cleanup: true, expected_revision: Some(workspace.revision) };
        self.merge_workspace(target, input, own_turn, cancel).await
    }

    /// `WORKTREE_PROJECT_MISMATCH` unless `repo_common_dir` (when given) is the session Project's
    /// repository (`session-view.mjs:90-97`).
    async fn session_project(&self, session: &str, repo_common_dir: Option<&str>, cancel: &CancellationToken) -> Result<(Workspace, RepoFacts), ScmFailure> {
        let workspace = self.workspace(session)?;
        let project = self.ops.inspect(&workspace.project_path, cancel).await?;
        if let Some(repo_dir) = repo_common_dir
            && !same_path(repo_dir, &text(&project.common_dir))
        {
            return Err(errors::repo_project_mismatch(workspace.project_path.clone(), repo_dir.to_owned()));
        }
        Ok((workspace, project))
    }

    /// `git worktree add` for a branch without moving the session (`side-checkouts.mjs:21-58`).
    #[allow(clippy::too_many_arguments)]
    async fn add_branch_worktree(
        self: &Arc<Self>,
        caller: &str,
        branch: &str,
        create: bool,
        start_point: Option<&str>,
        confirm_large: bool,
        tx_id: &str,
        repo_common_dir: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let (workspace, _) = self.session_project(caller, repo_common_dir, cancel).await?;
        let menu = self.ops.wt.branch_occupancy(std::path::Path::new(&workspace.project_path), Some(caller), cancel).await?;
        let held =
            menu["occupancy"].as_array().into_iter().flatten().find(|row| row["branch"].as_str() == Some(branch) && row["kind"].as_str() != Some("free"));
        if let Some(held) = held {
            let own_session = held["kind"].as_str() == Some("session") && held["sessionId"].as_str() == Some(caller);
            if !own_session {
                let path = held["path"].as_str().map(str::to_owned);
                let kind = held["kind"].as_str();
                let holder_session = held["sessionId"].as_str().map(str::to_owned);
                let mut failure = errors::branch_occupied(branch.to_owned(), path.clone(), kind, holder_session);
                if let ScmFailure::Coded { message, .. } = &mut failure {
                    *message = Some(format!("Branch {branch} is checked out in {}.", path.as_deref().unwrap_or("")).into_boxed_str());
                }
                return Err(failure);
            }
        }
        let tx = match mixdog_js::js_trim(tx_id) {
            "" => new_tx_id(),
            given => given.to_owned(),
        };
        let resolved = self
            .ops
            .resolve_branch(&workspace.project_path, branch, create, start_point, TxScope { session: caller, tx_id: &tx }, confirm_large, cancel)
            .await?;
        Ok(json!({
            "path": resolved.path,
            "branch": branch,
            "worktreeId": resolved.entry.as_ref().map(|e| e.id.as_str()),
            "created": resolved.created,
            "baseCommit": resolved.entry.as_ref().and_then(|e| e.base_commit.as_deref()),
            "mergeTarget": resolved.entry.as_ref().and_then(|e| e.merge_target.as_deref()),
        }))
    }

    /// Lead `git worktree add --detach`: a read-only snapshot resolved against the session's Project.
    async fn create_snapshot(
        self: &Arc<Self>,
        caller: &str,
        commit: &str,
        confirm_large: bool,
        tx_id: &str,
        repo_common_dir: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let (workspace, _) = self.session_project(caller, repo_common_dir, cancel).await?;
        let tx = match mixdog_js::js_trim(tx_id) {
            "" => new_tx_id(),
            given => given.to_owned(),
        };
        self.ops.wt.create_turn_snapshot(&self.ops.owner(caller), std::path::Path::new(&workspace.project_path), commit, &tx, confirm_large, cancel).await
    }

    /// `git worktree remove <path>`-style removal of the worktree at `path`, whichever owner
    /// holds it: the session's own lane, with the same guards as the desktop's removal.
    pub(super) async fn remove_path(self: &Arc<Self>, path: &str, force: bool, caller: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let entry = self.ops.worktree_by_path(path, cancel).await?.ok_or_else(|| {
            plain(format!("git worktree remove: {path} is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool"))
        })?;
        if entry.extra.get("kind").and_then(JsonValue::as_str) == Some("snapshot") {
            let removed = self.ops.wt.remove_snapshot_for(&entry.id, force, Some(caller), cancel).await?;
            return Ok(with_fields(removed, vec![("entryId", json!(entry.id)), ("path", json!(entry.path))]));
        }
        if entry.owner_session_id.as_deref() != Some(caller)
            && let Some(gone) = self.orphan(cancel, |row| row["id"] == entry.id.as_str()).await?
        {
            return self.remove_orphan(&gone, force, cancel).await;
        }
        let Some(owner) = entry.owner_session_id.clone() else {
            return Err(plain(format!("git worktree remove: no session retains {}; git worktree prune removes it once it is clean and merged", entry.path)));
        };
        let own = owner == caller;
        let workspace = self.workspace_view(&owner, cancel).await?;
        // This session's worktree that it does not work in: removed where it is, without
        // entering it (its own running workers elsewhere never block that).
        if own && workspace.worktree_id.as_deref() != Some(entry.id.as_str()) {
            return self.remove_owned(&owner, &entry.id, force, cancel).await;
        }
        let current = if workspace.is_bound() { self.ops.worktree_containing(&workspace.cwd, cancel).await? } else { None };
        let retained = match current {
            Some(found) => Some(found),
            None => self.ops.session_worktree(&owner, cancel).await?,
        };
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
                .ok_or_else(|| plain(format!("git worktree remove: this session owns no managed worktree of branch {branch}; git worktree list shows them")))?;
            let path = row["path"].as_str().unwrap_or_default().to_owned();
            return self.remove_path(&path, force, caller, cancel).await;
        }
        if target != caller
            && let Some(gone) = self.orphan(cancel, |row| row["ownerSessionId"] == target).await?
        {
            return self.remove_orphan(&gone, force, cancel).await;
        }
        self.remove_worktree(target, force, None, target == caller, cancel).await
    }
}

impl SessionWorkspaces {
    /// The pending Project move `pending` of a session that may work in a managed worktree, carried out: back to the project
    /// folder as the `git` tool's `return` does (the worktree kept), then [`Self::switch_project`], as one transition: the
    /// session's turns wait for it, and a failure anywhere puts the session back in the worktree it left. The write of the
    /// new folder takes `pending` off the record. Resolves the runtime cwd after the move.
    pub async fn move_to_project(
        &self,
        session: &str,
        cwd: &str,
        desktop_session: Option<JsonValue>,
        pending: JsonValue,
        cancel: &CancellationToken,
    ) -> Result<String, ScmFailure> {
        if !self.inner.workspace(session)?.is_bound() {
            return self.switch_project_moved(session, cwd, desktop_session, false, Some(pending), cancel).await;
        }
        self.inner.host.ensure_session(session).await?;
        let target = Target::Project { cwd: cwd.to_owned(), desktop_session, pending };
        self.inner.run_project_move(session, target, cancel).await.map(|_| cwd.to_owned())
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
            SessionOp::Enter { session_id, tx_id, .. } => ("enter", session_id.as_deref(), tx_id.as_str()),
            SessionOp::Return { session_id, tx_id } => ("return", session_id.as_deref(), tx_id.as_str()),
            SessionOp::Merge { session_id, tx_id } => ("merge", session_id.as_deref(), tx_id.as_str()),
            SessionOp::Remove { session_id, tx_id, .. } => ("remove", session_id.as_deref(), tx_id.as_str()),
            SessionOp::RemovePath { .. } => ("remove-path", None, ""),
            SessionOp::Add { tx_id, .. } => ("add", None, tx_id.as_str()),
            SessionOp::Snapshot { tx_id, .. } => ("snapshot", None, tx_id.as_str()),
        };
        inner.assert_mutation_allowed(caller, &format!("git worktree {what}")).await?;
        let target = target.unwrap_or(caller).to_owned();
        let own_turn = target == caller;
        let tx_id = tx_id.to_owned();
        match op {
            SessionOp::Enter { name, branch, create, carry, confirm_large, .. } => {
                inner.enter(&target, own_turn, (name, branch, create), (carry, confirm_large), tx_id, cancel).await
            }
            SessionOp::Return { .. } => inner.back(&target, own_turn, tx_id, cancel).await,
            SessionOp::Merge { .. } => inner.merge(&target, own_turn, cancel).await,
            SessionOp::Remove { branch, force, .. } => inner.remove(&target, caller, branch, force, cancel).await,
            SessionOp::RemovePath { path, force } => inner.remove_path(&path, force, caller, cancel).await,
            SessionOp::Add { branch, create, start_point, confirm_large, repo_common_dir, .. } => {
                inner.add_branch_worktree(caller, &branch, create, start_point.as_deref(), confirm_large, &tx_id, repo_common_dir.as_deref(), cancel).await
            }
            SessionOp::Snapshot { commit, confirm_large, repo_common_dir, .. } => {
                inner.create_snapshot(caller, &commit, confirm_large, &tx_id, repo_common_dir.as_deref(), cancel).await
            }
        }
    }
}
