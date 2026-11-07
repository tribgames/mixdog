//! Merging the Lead's retained worktree (or the linked checkout it works in) into the project
//! folder's branch, the cleanup of the merged worktree, and the session admission of folder
//! changes ([`FolderAdmission`], Node `activity-guards.mjs` `withManagementFolders`).

use std::collections::BTreeMap;

use super::*;

/// Admits a folder-changing action (merge, folder cleanup, branch deletion): refuses while a
/// session or worker runs in an affected folder, or a background command does; `removing`
/// refuses while any session still uses one. Then holds the folders (Mixdog checkouts only; an
/// external checkout is only checked) so new Mixdog work there waits until the admission drops.
pub(super) struct Admission {
    pub inner: Arc<Inner>,
    /// The session acting on its own checkout, whose own turn and workers its caller checked.
    pub actor: Option<String>,
}

impl Inner {
    /// A checkout or merge in the shared checkout `folder` refuses while another session (not
    /// this Lead's own workers) works there, then holds the folder.
    pub(super) fn hold_project_folder(
        self: &Arc<Self>,
        actor: Option<&str>,
        folder: &str,
        hold: bool,
    ) -> Result<worktree_gate::FolderGuard, ScmFailure> {
        let users: Vec<String> = self
            .host
            .live_sessions()
            .into_iter()
            .filter(|c| {
                !c.id.is_empty()
                    && Some(c.id.as_str()) != actor
                    && !c.closed
                    && actor.is_none_or(|a| c.owner_session_id.as_deref() != Some(a) && c.parent_session_id.as_deref() != Some(a))
                    && c.cwd.as_deref().is_some_and(|cwd| is_within(folder, cwd))
                    && c.active
            })
            .map(|c| c.id)
            .collect();
        if !users.is_empty() {
            return Err(folder_in_use(users));
        }
        self.gate.hold_checkout_folder(actor.unwrap_or(""), folder, hold)
    }
}

#[async_trait]
impl FolderAdmission for Admission {
    async fn admit(&self, folders: &[PathBuf], removing: bool) -> Result<Admitted, ScmFailure> {
        let inner = &self.inner;
        let actor = self.actor.as_deref();
        let cancel = CancellationToken::new();
        let mut wanted: Vec<String> = folders.iter().map(|f| text(f)).collect();
        wanted.sort();
        wanted.dedup();
        let mut holds: Vec<Box<dyn Send>> = Vec::new();
        let mut checkouts = Vec::new();
        for folder in &wanted {
            let checkout = inner.of(folder, &cancel).await?;
            holds.push(Box::new(inner.hold_project_folder(actor, folder, !checkout.as_ref().is_some_and(|c| c.external))?));
            checkouts.push((folder.clone(), checkout.ok_or_else(|| errors::coded_text(errors::WORKTREE_UNSUPPORTED_REPO, "This repository does not support managed worktrees."))?));
        }
        holds.push(Box::new(inner.gate.hold_activity(&checkouts, actor)?));
        let live = inner.host.live_sessions();
        let mut consumers: BTreeMap<String, LiveSession> =
            inner.host.stored_consumers().await.into_iter().map(|s| (s.id.clone(), s)).collect();
        for session in live.into_iter().filter(|s| !s.closed) {
            consumers.insert(session.id.clone(), session);
        }
        let affected: Vec<&LiveSession> = consumers
            .values()
            .filter(|s| s.cwd.as_deref().is_some_and(|cwd| wanted.iter().any(|f| is_within(f, cwd))))
            .collect();
        let blocking: Vec<String> = affected
            .iter()
            .filter(|s| {
                removing
                    || (s.active
                        && !actor.is_some_and(|a| {
                            s.id == a || s.owner_session_id.as_deref() == Some(a) || s.parent_session_id.as_deref() == Some(a)
                        }))
            })
            .map(|s| s.id.clone())
            .collect();
        if !blocking.is_empty() {
            return Err(folder_in_use(blocking));
        }
        let jobs = inner.host.running_jobs().await;
        if jobs.iter().any(|j| !j.terminal && wanted.iter().any(|f| is_within(f, &j.cwd))) {
            return Err(errors::busy(RefusalReason::FolderShellJobs));
        }
        let ids: Vec<String> = affected.iter().map(|s| s.id.clone()).collect();
        if inner.host.shell_job_count(&ids).await > 0 {
            return Err(errors::busy(RefusalReason::FolderShellJobs));
        }
        Ok(Admitted { retained_session_ids: consumers.keys().cloned().collect(), hold: Some(Box::new(holds)) })
    }
}

impl Inner {
    /// The merge itself. The retained worktree must belong to this session's Project (same
    /// repository and Project folder — a Project switch may have left it behind); its branch,
    /// or the branch of the linked checkout the session works in, is merged into the project
    /// folder through the shared guarded path, both folders validated and held.
    async fn merge_retained(
        self: &Arc<Self>,
        session: &str,
        target: Option<&str>,
        own_turn: bool,
        expected_revision: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let workspace = self.workspace(session)?;
        assert_revision(workspace.revision, expected_revision)?;
        let _leave = self.gate.begin_transition(session, &format!("merge:{}", new_tx_id()))?;
        self.assert_lead_idle(session, own_turn).await?;
        let project = self.ops.inspect(&workspace.project_path, cancel).await?;
        let branch = if workspace.worktree_id.is_none() && !same_path(&workspace.cwd, &workspace.project_path) {
            let source = self.ops.inspect(&workspace.cwd, cancel).await?;
            if !same_path(&text(&source.common_dir), &text(&project.common_dir)) {
                return Err(errors::project_mismatch(String::new(), workspace.cwd.clone(), workspace.project_path.clone()));
            }
            source.current_branch
        } else {
            let entry = match workspace.worktree_id {
                Some(_) => self.ops.worktree_containing(&workspace.cwd, cancel).await?,
                None => self.ops.session_worktree(session, cancel).await?,
            };
            let entry = entry.ok_or_else(|| errors::missing(None, None, None))?;
            assert_retained_fits(&entry, &project, &workspace.project_path)?;
            if !same_path(&entry.project_path, &workspace.project_path) {
                return Err(errors::project_mismatch(entry.id.clone(), entry.project_path.clone(), workspace.project_path.clone()));
            }
            entry.branch
        };
        let branch = branch.ok_or_else(|| errors::missing(None, None, None))?;
        let admission = Admission { inner: self.clone(), actor: Some(session.to_owned()) };
        self.ops
            .wt
            .merge_confirmed_target(std::path::Path::new(&workspace.project_path), &branch, target, &admission, cancel)
            .await
    }

    /// Merge the retained worktree into the project folder's checked-out branch, with the
    /// optional cleanup of the merged worktree.
    pub(super) async fn merge_workspace(
        self: &Arc<Self>,
        session: &str,
        input: MergeWorkspace,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        if !input.confirmed {
            let mut failure = errors::confirm_required();
            if let ScmFailure::Coded { message, .. } = &mut failure {
                *message = Some("mergeWorkspace requires confirmed: true.".into());
            }
            return Err(failure);
        }
        self.hosted(session)?;
        let merged = self.merge_retained(session, input.target.as_deref(), own_turn, input.expected_revision, cancel).await?;
        if !input.cleanup || merged["merged"] != true {
            return Ok(merged);
        }
        // "Merge and clean up": with autoCleanup on, the merged worktree goes now (a dirty one
        // stays, reported); off, nothing is removed automatically.
        if !self.ops.settings.worktree_settings().await.auto_cleanup {
            return Ok(with_fields(
                merged,
                vec![(
                    "cleanup",
                    json!({ "removed": false, "reason": "auto-cleanup-off", "message": "Auto cleanup is off; the worktree is kept." }),
                )],
            ));
        }
        // The merge is committed: a failed or refused cleanup is a cleanup notice, never a
        // merge failure. The cleanup never moves a session: while this session still works in
        // the merged folder (or any other session uses it) the removal is refused.
        match self.cleanup_merged(session, own_turn, cancel).await {
            Ok(removed) => Ok(with_fields(
                merged,
                vec![
                    ("cleanup", removed["removed"].clone()),
                    ("revision", removed["revision"].clone()),
                    ("workspace", removed["workspace"].clone()),
                ],
            )),
            Err(error) => {
                let workspace = self.workspace(session)?;
                let code = error.code();
                let mut cleanup = json!({
                    "removed": false,
                    "reason": code.unwrap_or("WORKTREE_CLEANUP_FAILED"),
                    "message": failure_message(&error),
                });
                if let Some(code) = code {
                    cleanup["code"] = json!(code);
                }
                Ok(with_fields(
                    merged,
                    vec![
                        ("cleanup", cleanup),
                        ("revision", json!(workspace.revision)),
                        ("workspace", workspace.to_value()),
                    ],
                ))
            }
        }
    }

    async fn cleanup_merged(self: &Arc<Self>, session: &str, own_turn: bool, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        if self.workspace(session)?.is_bound() {
            return Err(folder_in_use(vec![session.to_owned()]));
        }
        let entry = self.ops.session_worktree(session, cancel).await?;
        let admission = Admission { inner: self.clone(), actor: Some(session.to_owned()) };
        let folders: Vec<PathBuf> = entry.iter().map(|e| PathBuf::from(&e.path)).collect();
        let _admitted = admission.admit(&folders, true).await?;
        self.remove_worktree(session, false, None, own_turn, cancel).await
    }

    /// Remove managed worktree `entry` this session owns but does not work in now, without
    /// entering it first: the folder's consumers still refuse, as do dirty or unmerged work
    /// without `force` and other sessions' references.
    pub(super) async fn remove_owned(self: &Arc<Self>, session: &str, entry_id: &str, force: bool, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let row = self.list_rows(cancel).await?.into_iter().find(|r| r["id"] == entry_id);
        let row = row.ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let owner = row["ownerSessionId"].as_str().map(str::to_owned);
        if owner.as_deref() != Some(session) {
            return Err(errors::belongs_to_another(owner.into_iter().collect()));
        }
        if self.workspace(session)?.worktree_id.as_deref() == Some(entry_id) {
            return Err(errors::busy_with("folder-in-use", Some(vec![session.to_owned()]), None, None));
        }
        let path = row["path"].as_str().unwrap_or_default().to_owned();
        let admission = Admission { inner: self.clone(), actor: Some(session.to_owned()) };
        let _admitted = admission.admit(&[PathBuf::from(&path)], true).await?;
        let removed = self.ops.wt.remove(entry_id, force, Some(session), cancel).await?;
        Ok(json!({ "removed": removed, "entryId": entry_id, "path": path }))
    }

    /// Remove managed worktree `row` whose owner is gone, on an explicit request.
    pub(super) async fn remove_orphan(self: &Arc<Self>, row: &JsonValue, force: bool, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let path = row["path"].as_str().unwrap_or_default().to_owned();
        let admission = Admission { inner: self.clone(), actor: None };
        let _admitted = admission.admit(&[PathBuf::from(&path)], true).await?;
        let removed = self.ops.wt.remove(&id, force, None, cancel).await?;
        Ok(json!({ "removed": removed, "entryId": id, "path": path }))
    }

    /// Every managed worktree with who retains it.
    pub(super) async fn list_rows(&self, cancel: &CancellationToken) -> Result<Vec<JsonValue>, ScmFailure> {
        self.ops.wt.list(None, &*self.retention, cancel).await
    }

    /// The listed worktree matching `predicate` whose owner is gone and that the list reports
    /// removable: no owner lane can remove it.
    pub(super) async fn orphan(&self, cancel: &CancellationToken, predicate: impl Fn(&JsonValue) -> bool) -> Result<Option<JsonValue>, ScmFailure> {
        Ok(self
            .list_rows(cancel)
            .await?
            .into_iter()
            .find(|row| predicate(row) && row["ownerLive"] == false && row["removable"] == true))
    }
}
