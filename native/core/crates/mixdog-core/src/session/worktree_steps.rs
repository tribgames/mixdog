//! The serialized moves of a Lead (Node `transition-runner.mjs` and `transition-steps.mjs`):
//! enter a worktree, run in a branch's checkout, remove the retained worktree. Every step
//! pushes the exact undo of what it changed onto the transaction's journal.

use mixdog_protocol::RemovalRemnant;

use super::*;

impl Inner {
    /// Apply the new workspace: runtime cwd, record, worker lock, prompt context of the Lead
    /// and its idle workers, durable save. Journals the exact undo.
    async fn commit(
        self: &Arc<Self>,
        session: &str,
        previous: &Workspace,
        fields: Fields,
        journal: &mut Journal,
        moved: Option<Move>,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let next = Workspace {
            project_path: fields.project_path,
            repo_common_dir: fields.repo_common_dir,
            cwd: fields.cwd,
            worktree_id: fields.worktree_id,
            branch: fields.branch,
            base_commit: fields.base_commit,
            merge_target: fields.merge_target,
            revision: previous.next_revision(),
            state: TransitionState::Idle,
            tx_id: None,
        };
        let next = Workspace::from_value(&next.to_value())?;
        let checkout = self.of(&next.cwd, cancel).await?;
        self.gate.retain_admitted_turn_workspace(session, &next.cwd, checkout.as_ref())?;
        let prior_lock = self.gate.workspace_cwd_lock(&[session]);
        let applied = self
            .host
            .apply(session, WorkspaceChange { cwd: next.cwd.clone(), workspace: next.to_value(), moved })
            .await?;
        journal.push(applied);
        let (gate, id) = (self.gate.clone(), session.to_owned());
        journal.push(undo(async move {
            gate.set_workspace_cwd_lock(&id, prior_lock.as_deref());
            Ok(())
        }));
        self.gate.set_workspace_cwd_lock(session, next.is_bound().then_some(next.cwd.as_str()));
        Ok(json!({ "revision": next.revision, "workspace": next.to_value() }))
    }

    fn release_undo(self: &Arc<Self>, entry_id: &str, session: &str, forget_reference: bool) -> Undo {
        let (inner, entry, id) = (self.clone(), entry_id.to_owned(), session.to_owned());
        undo(async move { inner.ops.release(&entry, &id, forget_reference, &CancellationToken::new()).await })
    }

    fn claim_undo(self: &Arc<Self>, entry_id: &str, session: &str) -> Undo {
        let (inner, entry, id) = (self.clone(), entry_id.to_owned(), session.to_owned());
        undo(async move { inner.ops.claim(&entry, &id, &CancellationToken::new()).await.map(|_| ()) })
    }

    /// `changes` (a new worktree only): the project folder's uncommitted changes. `ask`
    /// refuses with WORKTREE_DIRTY_CHOICE while there are any, `leave` keeps them there;
    /// omitted, they are not examined (lazy provisioning).
    async fn enter_worktree(
        self: &Arc<Self>,
        session: &str,
        previous: &Workspace,
        name: Option<String>,
        options: &Options,
        tx_id: &str,
        journal: &mut Journal,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let project_path = previous.project_path.clone();
        let project = self.ops.inspect(&project_path, cancel).await?;
        let (entry, changes) = match self.ops.session_worktree(session, cancel).await? {
            Some(entry) => {
                if !self.ops.exists(&entry.path, cancel).await? {
                    return Err(errors::missing(None, Some(entry.id.clone()), Some(entry.path.clone())));
                }
                if previous.is_bound() && previous.worktree_id.as_deref() == Some(entry.id.as_str()) {
                    return Ok(json!({ "revision": previous.revision, "workspace": previous.to_value() }));
                }
                assert_retained_fits(&entry, &project, &project_path)?;
                self.ops.claim(&entry.id, session, cancel).await?;
                journal.push(self.release_undo(&entry.id, session, false));
                (entry, None)
            }
            None => {
                let hint = name.or_else(|| options.name_hint.clone()).unwrap_or_default();
                let created = self
                    .ops
                    .create_for_session(&project, session, tx_id, &hint, options.changes.as_deref(), options.confirm_large, cancel)
                    .await?;
                (created.record, created.changes)
            }
        };
        // Cancelled after the worktree exists: it stays retained (same txId on retry), the
        // session does not move.
        if cancel.is_cancelled() {
            return Err(ScmFailure::Cancelled);
        }
        let subdir = project_subdir_of(&text(&project.top_level), &text(&project.project_path));
        let cwd = checkout_folder(&entry.path, &subdir);
        if !self.ops.exists(&cwd, cancel).await? {
            self.ops.make_dir(&cwd, cancel).await?;
        }
        self.host.copy_project_identity(&project_path, &cwd).await?;
        let repo_common_dir =
            if entry.repo_common_dir.is_empty() { text(&project.common_dir) } else { entry.repo_common_dir.clone() };
        let moved = (!previous.is_bound())
            .then(|| Move { from: previous.cwd.clone(), changes: changes.map(|(mode, _)| mode.to_owned()) });
        let entered = self
            .commit(
                session,
                previous,
                Fields {
                    project_path,
                    repo_common_dir: Some(repo_common_dir),
                    cwd,
                    worktree_id: Some(entry.id.clone()),
                    branch: entry.branch.clone(),
                    base_commit: entry.base_commit.clone(),
                    merge_target: project.current_branch.clone(),
                },
                journal,
                moved,
                cancel,
            )
            .await?;
        let warnings = entry.extra.get("warnings").cloned().filter(JsonValue::is_array).unwrap_or_else(|| json!([]));
        let mut extra = vec![("warnings", warnings)];
        if let Some((mode, count)) = changes {
            extra.push(("changes", json!({ "mode": mode, "count": count })));
        }
        Ok(with_fields(entered, extra))
    }

    async fn enter_project_branch(
        self: &Arc<Self>,
        session: &str,
        previous: &Workspace,
        branch: &str,
        create: bool,
        options: &Options,
        tx_id: &str,
        journal: &mut Journal,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let project_path = previous.project_path.clone();
        let project = self.ops.inspect(&project_path, cancel).await?;
        let resolved = self.ops.resolve_branch(&project_path, branch, create, session, tx_id, options.confirm_large, cancel).await?;
        let entry = resolved.entry;
        if let Some(entry) = &entry {
            journal.push(self.release_undo(&entry.id, session, resolved.reference_added));
            assert_retained_fits(entry, &project, &project_path)?;
        }
        if cancel.is_cancelled() {
            return Err(ScmFailure::Cancelled);
        }
        let subdir = project_subdir_of(&text(&project.top_level), &text(&project.project_path));
        let cwd = checkout_folder(&resolved.path, &subdir);
        if !self.ops.exists(&cwd, cancel).await? {
            return Err(errors::missing(None, None, Some(cwd)));
        }
        if entry.is_some() {
            self.host.copy_project_identity(&project_path, &cwd).await?;
        }
        let result = self
            .commit(
                session,
                previous,
                Fields {
                    project_path,
                    repo_common_dir: Some(resolved.repo_common_dir),
                    cwd,
                    worktree_id: entry.as_ref().map(|e| e.id.clone()),
                    branch: Some(branch.to_owned()),
                    base_commit: entry.as_ref().and_then(|e| e.base_commit.clone()),
                    merge_target: project.current_branch.clone(),
                },
                journal,
                Some(Move { from: previous.cwd.clone(), changes: Some("left".into()) }),
                cancel,
            )
            .await?;
        if let Some(left) = previous.worktree_id.as_deref().filter(|id| Some(*id) != entry.as_ref().map(|e| e.id.as_str())) {
            journal.push(self.claim_undo(left, session));
            self.ops.release(left, session, true, cancel).await?;
        }
        Ok(result)
    }

    /// WORKTREE_REMOVAL_INCOMPLETE: the deletion started but something in the folder is still
    /// held. The session keeps the project folder (never a cwd that may be deleted) and a
    /// repeated removal resumes the deletion.
    fn incomplete(
        journal: &mut Journal,
        entry: &WorktreeRecord,
        revision: u64,
        retryable: bool,
        remaining: Vec<RemovalRemnant>,
        reason: Option<String>,
    ) -> ScmFailure {
        journal.clear();
        ScmFailure::coded(
            errors::WORKTREE_REMOVAL_INCOMPLETE,
            DomainErrorDetail::WorktreeRemovalIncomplete {
                entry_id: entry.id.clone(),
                path: entry.path.clone(),
                retryable,
                remaining,
                reason,
                revision: Some(revision),
            },
        )
    }

    /// Validate the removal first (a dirty or unmerged worktree without `force` refuses with
    /// the session untouched), then return the session to its project folder, release the live
    /// lease and remove. A removal that still fails puts the session back exactly.
    async fn remove_retained(
        self: &Arc<Self>,
        session: &str,
        previous: &Workspace,
        force: bool,
        journal: &mut Journal,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let entry = if previous.is_bound() {
            self.ops.worktree_containing(&previous.cwd, cancel).await?
        } else if same_path(&previous.cwd, &previous.project_path) {
            self.ops.session_worktree(session, cancel).await?
        } else {
            None
        };
        if let Some(entry) = &entry {
            self.ops.assert_removable(&entry.id, force, session, cancel).await?;
        }
        let mut result = json!({ "revision": previous.revision, "workspace": previous.to_value() });
        if previous.is_bound() {
            let project = self.ops.inspect(&previous.project_path, cancel).await?;
            result = self
                .commit(
                    session,
                    previous,
                    Fields {
                        project_path: previous.project_path.clone(),
                        repo_common_dir: Some(text(&project.common_dir)),
                        cwd: previous.project_path.clone(),
                        worktree_id: None,
                        branch: project.current_branch.clone(),
                        base_commit: None,
                        merge_target: None,
                    },
                    journal,
                    None,
                    cancel,
                )
                .await?;
            if let Some(entry) = &entry {
                self.ops.release(&entry.id, session, false, cancel).await?;
                journal.push(self.claim_undo(&entry.id, session));
            }
        }
        let Some(entry) = entry else { return Ok(with_fields(result, vec![("removed", JsonValue::Null)])) };
        let revision = result["revision"].as_u64().unwrap_or(previous.revision);
        #[cfg(test)]
        if let Some(hook) = self.before_remove.lock().unwrap().take() {
            hook();
        }
        match self.ops.wt.remove(&entry.id, force, Some(session), cancel).await {
            Ok(removed) if removed["removed"] == true => Ok(with_fields(result, vec![("removed", removed)])),
            Ok(_) => Err(Self::incomplete(journal, &entry, revision, true, Vec::new(), None)),
            Err(ScmFailure::Coded {
                code: errors::WORKTREE_REMOVAL_INCOMPLETE,
                detail: Some(detail),
                ..
            }) => {
                let (retryable, remaining, reason) = match *detail {
                    DomainErrorDetail::WorktreeRemovalIncomplete { retryable, remaining, reason, .. } => {
                        (retryable, remaining, reason)
                    }
                    _ => (true, Vec::new(), None),
                };
                Err(Self::incomplete(journal, &entry, revision, retryable, remaining, reason))
            }
            Err(error) => {
                // Refused before anything was deleted: the journal puts the session back. Once
                // the checkout may be (partly) gone, the session stays in the project folder
                // and the removal is reported incomplete.
                if self.removal_left_it_intact(session, &entry).await? {
                    return Err(error);
                }
                Err(Self::incomplete(journal, &entry, revision, true, Vec::new(), Some(failure_message(&error))))
            }
        }
    }

    /// Whether a removal that failed left the worktree untouched. It runs under a token of its
    /// own: the operation's token may be the very cancellation that arrived after Git deleted
    /// the folder, and a finished deletion must always be recorded as finished, never rolled
    /// back to a cwd that no longer exists.
    pub(super) async fn removal_left_it_intact(&self, session: &str, entry: &WorktreeRecord) -> Result<bool, ScmFailure> {
        let recovery = CancellationToken::new();
        let now = self.ops.session_worktree(session, &recovery).await.ok().flatten().or_else(|| Some(entry.clone()));
        match &now {
            Some(now) => Ok(now.id == entry.id && now.state == "ready" && self.ops.exists(&entry.path, &recovery).await?),
            None => Ok(false),
        }
    }

    /// The one entry of every transition: admitted against turns and other workspace changes,
    /// the Lead checked idle, the steps journaled.
    async fn transition(
        self: &Arc<Self>,
        session: &str,
        target: Target,
        options: Options,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        if cancel.is_cancelled() {
            return Err(ScmFailure::Cancelled);
        }
        let previous = self.workspace(session)?;
        assert_revision(previous.revision, options.expected_revision)?;
        let tx_id = match mixdog_js::js_trim(&options.tx_id) {
            "" => new_tx_id(),
            given => given.to_owned(),
        };
        let leave = self.gate.begin_transition(session, &tx_id)?;
        let stored = self.host.session(session).and_then(|view| view.workspace);
        let state = match target {
            Target::Worktree { .. } => TransitionState::Provisioning,
            Target::Branch { .. } => TransitionState::Switching,
            Target::Remove { .. } => TransitionState::Removing,
        };
        let marker = previous.in_transition(state, &tx_id).to_value();
        self.host.set_workspace(session, Some(marker.clone()));
        let mut journal = Journal::default();
        let outcome = async {
            self.assert_lead_idle(session, options.own_turn).await?;
            match &target {
                Target::Worktree { name } => {
                    self.enter_worktree(session, &previous, name.clone(), &options, &tx_id, &mut journal, cancel).await
                }
                Target::Branch { branch, create } => {
                    self.enter_project_branch(session, &previous, branch, *create, &options, &tx_id, &mut journal, cancel).await
                }
                Target::Remove { force } => self.remove_retained(session, &previous, *force, &mut journal, cancel).await,
            }
        }
        .await;
        if outcome.is_err() {
            // Whatever already moved (cwd, record, prompts, worker roots, lease) goes back
            // exactly; the previous workspace stays authoritative.
            journal.undo_all().await;
        }
        if self.host.session(session).and_then(|view| view.workspace).as_ref() == Some(&marker) {
            self.host.set_workspace(session, stored);
        }
        drop(leave);
        outcome
    }

    pub(super) async fn remove_worktree(
        self: &Arc<Self>,
        session: &str,
        force: bool,
        expected_revision: Option<u64>,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.transition(session, Target::Remove { force }, Options { expected_revision, own_turn, ..Options::default() }, cancel)
            .await
    }

    /// `runTransition`: a branch or retained-worktree entry from a request.
    pub(super) async fn run_branch(
        self: &Arc<Self>,
        session: &str,
        branch: &str,
        create: bool,
        options: Options,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let branch = mixdog_js::js_trim(branch);
        if branch.is_empty() {
            return Err(plain("workspace target branch must be a non-empty string."));
        }
        self.transition(session, Target::Branch { branch: branch.to_owned(), create }, options, cancel).await
    }

    pub(super) async fn run_worktree(
        self: &Arc<Self>,
        session: &str,
        name: Option<String>,
        options: Options,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.transition(session, Target::Worktree { name }, options, cancel).await
    }
}
