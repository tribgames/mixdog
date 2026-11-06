//! The read side of the session workspace: the branch menu (Node `session-view.mjs`
//! `getBranchMenu`) and the sessions holding worktree work (`worktree-maintenance.mjs`
//! `getSessionWorktreeWork`).

use mixdog_scm::worktree::manager::entry_json;

use super::*;

/// `branchMenuEntries`: the menu's rows for the local branch names the manager lists;
/// `current` marks the branch checked out in the project folder, `committedAt` becomes
/// `lastCommitAt`.
fn branch_menu_entries(menu: &JsonValue) -> Vec<JsonValue> {
    let current: Vec<&str> = menu["occupancy"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["kind"] == "current")
        .filter_map(|row| row["branch"].as_str())
        .collect();
    menu["branches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .map(|name| {
            let mut entry = json!({ "name": name, "current": current.contains(&name), "remote": false, "upstream": "" });
            if let Some(at) = menu["committedAt"][name].as_str().filter(|at| !at.is_empty()) {
                entry["lastCommitAt"] = json!(at);
            }
            entry
        })
        .collect()
}

impl Inner {
    pub(super) async fn branch_menu(self: &Arc<Self>, session: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let workspace = self.workspace(session)?;
        let pending = self.intent(session).map(|intent| json!({ "name": intent.name }));
        let listed = self.ops.wt.branch_occupancy(std::path::Path::new(&workspace.project_path), Some(session), cancel).await;
        let menu = match listed {
            Ok(menu) => menu,
            // A Project with no usable repository has no branches: an answer, not a failure the
            // menu would retry (no repoCommonDir reads as not git).
            Err(failure) if failure.code() == Some(errors::WORKTREE_UNSUPPORTED_REPO) => {
                let view = Workspace { repo_common_dir: None, branch: None, ..workspace };
                return Ok(json!({
                    "workspace": view.to_value(),
                    "pendingWorktree": pending,
                    "branches": [],
                    "occupancy": [],
                    "retainedWorktree": null,
                    "warnings": [],
                }));
            }
            Err(failure) => return Err(failure),
        };
        let selected = if workspace.is_bound() {
            self.ops.worktree_containing(&workspace.cwd, cancel).await?.map(|record| entry_json(&record))
        } else {
            None
        };
        // A session outside a managed worktree is on whatever its folder has checked out now;
        // a detached checkout shows branch null with the commit in baseCommit.
        let view = if workspace.is_bound() {
            let mut view = workspace;
            self.follow_checkout_branch(&mut view, cancel).await?;
            view
        } else {
            let project = self.ops.inspect(&workspace.cwd, cancel).await?;
            let checked_out = project.current_branch.clone();
            Workspace {
                repo_common_dir: Some(text(&project.common_dir)),
                base_commit: if checked_out.is_some() { workspace.base_commit.clone() } else { Some(project.head.clone()) },
                branch: checked_out,
                ..workspace
            }
        };
        let retained = &menu["retainedWorktree"];
        Ok(json!({
            "workspace": view.to_value(),
            "pendingWorktree": pending,
            "branches": branch_menu_entries(&menu),
            "occupancy": menu["occupancy"],
            "retainedWorktree": selected.unwrap_or_else(|| retained.clone()),
            // Creation notes of the retained worktree (submodules, include entries).
            "warnings": retained["warnings"].as_array().cloned().unwrap_or_default(),
        }))
    }

    /// Of `wanted`, the sessions owning a managed worktree whose removal would be refused
    /// without `force` (dirty or unmerged work, another session's reference, retained recovery
    /// data). Read-only; a check that fails counts as holding work.
    pub(super) async fn session_worktree_work(self: &Arc<Self>, wanted: &[String], cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let mut holding: Vec<String> = Vec::new();
        if wanted.is_empty() {
            return Ok(json!({ "sessionIds": holding }));
        }
        for row in self.list_rows(cancel).await? {
            if row["kind"] == "snapshot" {
                continue;
            }
            let Some(owner) = row["ownerSessionId"].as_str() else { continue };
            if !wanted.iter().any(|id| id == owner) || holding.iter().any(|id| id == owner) {
                continue;
            }
            let entry_id = row["id"].as_str().unwrap_or_default();
            if self.ops.wt.assert_worktree_removable(entry_id, false, Some(owner), cancel).await.is_err() {
                holding.push(owner.to_owned());
            }
        }
        Ok(json!({ "sessionIds": holding }))
    }
}
