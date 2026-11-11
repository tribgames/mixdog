//! The `project/*` branch, worktree and connector methods (Node `project-branches.mjs`,
//! `worktree-maintenance.mjs` and `agent-connectors.mjs` through the session runtime's public
//! workspace methods): a registered Project's branch menu, guarded checkout, merge and branch
//! management, the managed-worktree list and its cleanup, a session's worktree removal and the
//! project's connector switches. Every Project argument must be a registered Project.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params as p;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::Origin;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::branches::CheckoutRequest;
use mixdog_scm::worktree::branches::ManageRequest;
use mixdog_scm::worktree::errors;
use mixdog_scm::worktree::listing::without_snapshots;
use mixdog_scm::worktree::maintenance::CleanupOptions;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::menu::branch_menu_entries;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::connectors::ProjectConnectors;
use crate::session::worktree::LiveSessions;
use crate::session::worktree::SessionWorkspaces;
use crate::session::worktree::scm_error;
use crate::session::worktree::Workspace;

const DOMAIN: &str = "project";

const READS: [&str; 5] = [
    "project/inspectProjectBranch",
    "project/getProjectBranchMenu",
    "project/getProjectConnectors",
    "project/listWorktrees",
    "project/previewWorktreeCleanup",
];

const MUTATIONS: [&str; 8] = [
    "project/selectProjectBranch",
    "project/mergeProjectBranch",
    "project/manageProjectBranch",
    "project/removeWorktree",
    "project/pruneWorktrees",
    "project/deleteWorktree",
    "project/setArchivedSessionWorktrees",
    "project/setProjectConnectorEnabled",
];

/// The project registry: `findRegisteredProject`, the registered Project at a path.
#[async_trait]
pub trait Registry: Send + Sync {
    /// The registered Project's stored path equal to `path`; `None` when none is registered.
    async fn registered(&self, path: &str) -> Result<Option<String>, String>;
}

#[async_trait]
impl Registry for mixdog_workspace::service::WorkspaceService {
    async fn registered(&self, path: &str) -> Result<Option<String>, String> {
        use mixdog_workspace::error::Reason;
        match self.catalog().resolve(path).await {
            Ok(found) => Ok(Some(found.to_string_lossy().into_owned())),
            // No registered project at the path (`resolve`'s refusal): Node's `findRegisteredProject` answered `null`.
            Err(error) if matches!(error.reason, Reason::PermissionDenied | Reason::Coded("PROJECT_UNAVAILABLE")) => Ok(None),
            Err(error) => Err(error.message),
        }
    }
}

/// `project/setProjectConnectorEnabled` params with `enabled` as sent: the protocol types it as a
/// boolean, but Node answers any other value with `enabled must be a boolean` (after the
/// connector id is checked, before the project), so the service does the check itself.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorSwitchParams {
    project_path: String,
    connector_id: String,
    #[serde(default)]
    enabled: Value,
    #[serde(default)]
    options: Option<Value>,
}

pub struct ProjectService {
    projects: Arc<dyn Registry>,
    worktrees: Arc<Worktrees>,
    workspaces: SessionWorkspaces,
    sessions: Arc<dyn SessionSource>,
    live: LiveSessions,
    connectors: ProjectConnectors,
    ops: OpScopes,
}

/// A thrown plain `Error`/`TypeError`: its text is the whole answer.
fn plain(message: impl Into<String>) -> ScmFailure {
    ScmFailure::git(message)
}

/// Plain errors travel as `{ error: message }`, coded ones with their code and detail, worded as the
/// thread worktree actions word them (`scm_error`: Node throws the same typed errors to both).
fn wire(failure: ScmFailure) -> CoreError {
    match failure {
        ScmFailure::Command { domain, text } => failed(domain, text),
        other => scm_error(other),
    }
}

/// `{ ...input }` of an action's input: a `null` cannot be destructured; anything that is not an
/// object has none of the fields.
fn fields(input: &Value, first: &str) -> Result<Map<String, Value>, ScmFailure> {
    match input {
        Value::Object(map) => Ok(map.clone()),
        Value::Null => Err(plain(format!("Cannot destructure property '{first}' of 'object null' as it is null."))),
        _ => Ok(Map::new()),
    }
}

/// `requireText`: the trimmed text of a non-blank string.
fn require_text(value: Option<&Value>, name: &str) -> Result<String, ScmFailure> {
    match value {
        Some(Value::String(text)) if !mixdog_js::js_trim(text).is_empty() => Ok(mixdog_js::js_trim(text).to_owned()),
        _ => Err(plain(format!("{name} must be a non-empty string."))),
    }
}

fn flag(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key) == Some(&Value::Bool(true))
}

/// A field that is a string, `None` for anything else (absent, `null`, other types).
fn text_of(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl ProjectService {
    pub fn new(
        projects: Arc<dyn Registry>,
        worktrees: Arc<Worktrees>,
        workspaces: SessionWorkspaces,
        sessions: Arc<dyn SessionSource>,
        live: LiveSessions,
        connectors: ProjectConnectors,
        ops: OpScopes,
    ) -> Self {
        Self { projects, worktrees, workspaces, sessions, live, connectors, ops }
    }

    /// `WORKTREE_PROJECT_UNKNOWN` unless `value` is a registered Project; with no details, as Node's
    /// `projectScopedArgs` refused it (session-host-lifecycle.ts:1232-1243 at b6f10295a).
    async fn registered_project(&self, value: Option<&Value>) -> Result<String, ScmFailure> {
        let path = require_text(value, "projectPath")?;
        match self.projects.registered(&path).await.map_err(plain)? {
            Some(registered) => Ok(registered),
            None => Err(ScmFailure::coded(
                errors::WORKTREE_PROJECT_UNKNOWN,
                DomainErrorDetail::WorktreeProjectUnknown { project_path: None, reason: None },
            )),
        }
    }

    /// A Project's branch menu with no session: the project folder's workspace and the real
    /// occupancy (current / session / external / free).
    async fn branch_menu(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "projectPath")?;
        let path = self.registered_project(input.get("projectPath")).await?;
        let project = Path::new(&path);
        let inspected = match self.worktrees.inspect_repo(project, cancel).await {
            Ok(facts) => self.worktrees.branch_occupancy(project, None, cancel).await.map(|menu| (facts, menu)),
            Err(failure) => Err(failure),
        };
        let (facts, menu) = match inspected {
            Ok(found) => found,
            // A folder with no usable repository has no branches: an answer, not a failure the
            // menu would retry.
            Err(failure) if failure.code() == Some(errors::WORKTREE_UNSUPPORTED_REPO) => {
                let workspace = Workspace::project(&path, &path).to_value();
                return Ok(json!({ "workspace": workspace, "branches": [], "occupancy": [], "retainedWorktree": null }));
            }
            Err(failure) => return Err(failure),
        };
        let mut workspace = Workspace::project(&path, &path);
        workspace.repo_common_dir = Some(path_text(&facts.common_dir));
        workspace.branch = facts.current_branch.clone();
        let mut workspace = workspace.to_value();
        if facts.current_branch.is_none() {
            // Detached: branch null and the checked-out commit in baseCommit.
            workspace["baseCommit"] = json!(facts.head);
        }
        let names = menu["branches"].as_array().cloned().unwrap_or_default();
        let occupancy = menu["occupancy"].as_array().cloned().unwrap_or_default();
        Ok(json!({
            "workspace": workspace,
            "branches": branch_menu_entries(&names, &occupancy, &menu["committedAt"]),
            "occupancy": occupancy,
            "retainedWorktree": null,
        }))
    }

    /// Check out (or create) a branch in a Project folder with no session: the same guarded
    /// path a session's branch change takes, the folder held while git changes it.
    async fn select_branch(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "projectPath")?;
        let path = self.registered_project(input.get("projectPath")).await?;
        let project = Path::new(&path);
        let start_point = input.get("startPoint").filter(|v| !v.is_null());
        let detach = input.get("detach").filter(|v| !v.is_null());
        if let Some(detach) = detach {
            // A history entry checked out detached: the same guard, no branch.
            if input.contains_key("branch") || flag(&input, "create") || flag(&input, "remote") || start_point.is_some() {
                return Err(plain("detach excludes branch, create, remote and startPoint."));
            }
            let commit = require_text(Some(detach), "detach")?;
            let facts = self.worktrees.inspect_repo(project, cancel).await?;
            let _held = self.workspaces.hold_project_folder(&path_text(&facts.top_level))?;
            return self
                .worktrees
                .checkout_project_branch(
                    CheckoutRequest { project_path: project.to_path_buf(), branch: None, create: false, remote: false, start_point: None, detach: Some(commit) },
                    cancel,
                )
                .await;
        }
        let name = require_text(input.get("branch"), "branch")?;
        let (create, remote) = (flag(&input, "create"), flag(&input, "remote"));
        if create && remote {
            return Err(plain("create and remote are exclusive."));
        }
        if start_point.is_some() && !create {
            return Err(plain("startPoint needs create."));
        }
        let facts = self.worktrees.inspect_repo(project, cancel).await?;
        if !create && !remote && facts.current_branch.as_deref() == Some(name.as_str()) {
            return Ok(json!({ "branch": name, "changed": false }));
        }
        let start_point = start_point.map(|point| require_text(Some(point), "startPoint")).transpose()?;
        let _held = self.workspaces.hold_project_folder(&path_text(&facts.top_level))?;
        self.worktrees
            .checkout_project_branch(CheckoutRequest { project_path: project.to_path_buf(), branch: Some(name), create, remote, start_point, detach: None }, cancel)
            .await
    }

    /// Merge a local branch into a Project folder's checked-out branch with no session: `target`
    /// is the branch the user confirmed and must still be checked out.
    async fn merge_branch(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "projectPath")?;
        let path = self.registered_project(input.get("projectPath")).await?;
        let branch = require_text(input.get("branch"), "branch")?;
        let target = require_text(input.get("target"), "target")?;
        let admission = self.workspaces.folder_admission(None);
        self.worktrees.merge_confirmed_target(Path::new(&path), &branch, Some(&target), &*admission, cancel).await
    }

    async fn inspect_branch(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "projectPath")?;
        let path = self.registered_project(input.get("projectPath")).await?;
        let branch = require_text(input.get("branch"), "branch")?;
        Ok(self.worktrees.inspect_project_branch(Path::new(&path), &branch, cancel).await?.to_json())
    }

    async fn manage_branch(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "projectPath")?;
        let path = self.registered_project(input.get("projectPath")).await?;
        let request = ManageRequest {
            project_path: PathBuf::from(path),
            branch: text_of(&input, "branch").unwrap_or_default(),
            action: text_of(&input, "action").unwrap_or_default(),
            commit: text_of(&input, "commit").unwrap_or_default(),
            target: text_of(&input, "target"),
            target_commit: text_of(&input, "targetCommit"),
            confirmed: flag(&input, "confirmed"),
            force: flag(&input, "force"),
        };
        let admission = self.workspaces.folder_admission(None);
        self.worktrees.manage_project_branch(request, &*admission, cancel).await
    }

    /// Every managed worktree with its retention and details (Settings → Worktrees).
    async fn list_worktrees(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let rows = self.worktrees.list_with_retention(&self.sessions, &(self.live)(), true, now_ms(), cancel).await?;
        Ok(Value::Array(without_snapshots(rows)))
    }

    fn cleanup_options(&self, input: Option<&Value>, explicit: bool) -> CleanupOptions {
        let repo_common_dir = input.and_then(|input| input.get("repoCommonDir")).and_then(Value::as_str).map(str::to_owned);
        CleanupOptions { live: (self.live)(), repo_common_dir, explicit, current_live: self.live.clone(), ..CleanupOptions::default() }
    }

    /// Whether the manual prune could act on anything (no git verification, nothing removed).
    async fn preview_cleanup(&self, input: Option<&Value>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let options = self.cleanup_options(input, false);
        let (ids, stale) = self.worktrees.preview_worktree_cleanup(&self.sessions, &options, cancel).await?;
        Ok(json!({ "hasCandidates": ids.len() + stale.len() > 0 }))
    }

    /// The manual prune: independent of autoCleanup, optionally limited to one repository.
    async fn prune(&self, input: Option<&Value>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.worktrees.run_worktree_cleanup(&self.sessions, &self.cleanup_options(input, true), cancel).await
    }

    /// Delete managed worktree `entryId` from the worktree list, whoever owns it: a live owner or a
    /// session or background command working in the folder refuses; dirty or unmerged work needs
    /// `force`.
    async fn delete_worktree(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "entryId")?;
        let entry_id = text_of(&input, "entryId");
        let live = (self.live)();
        let retained = self.sessions.stored_session_ids().await?;
        let rows = without_snapshots(self.worktrees.list_managed(&live, &retained, false, false, cancel).await?);
        let row = rows
            .iter()
            .find(|row| entry_id.is_some() && row["id"].as_str() == entry_id.as_deref())
            .ok_or_else(|| errors::missing(entry_id.clone(), None, None))?;
        let folder = row["path"].as_str().unwrap_or_default().to_owned();
        let _admitted = self.workspaces.folder_admission(None).admit(&[PathBuf::from(&folder)], false).await?;
        // The scope is read again under the admission, as the callback of `withManagementFolders` does.
        let live = (self.live)();
        let retained = self.sessions.stored_session_ids().await?;
        let removed = self
            .worktrees
            .remove_orphaned(entry_id.as_deref().unwrap_or_default(), flag(&input, "force"), &live, &retained, true, cancel)
            .await?;
        Ok(json!({ "removed": removed, "entryId": entry_id, "path": folder }))
    }

    /// Archived (or restored) sessions: autoCleanup and cleanupArchived decide whether their
    /// worktrees become disposable.
    async fn set_archived(&self, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let input = fields(input, "sessionIds")?;
        let ids: HashSet<String> = input.get("sessionIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        self.worktrees.set_archived_session_worktrees(&ids, flag(&input, "archived"), cancel).await
    }

    /// The session's own worktree removal (`removeWorktree({ force, expectedRevision })`).
    async fn remove_worktree(&self, params: &p::ProjectRemoveWorktreeParams, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let Some(thread) = &params.thread_id else { return Err(ScmFailure::invalid("threadId", "the thread whose worktree to remove")) };
        let input = match &params.input {
            Some(input) => fields(input, "force")?,
            None => Map::new(),
        };
        let expected = input.get("expectedRevision").and_then(Value::as_u64);
        self.workspaces.remove_worktree(thread.as_str(), flag(&input, "force"), expected, false, cancel).await
    }

    async fn read(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let cancel = &req.ctx.cancel;
        match req.method.as_str() {
            "project/inspectProjectBranch" => {
                let params: p::ProjectInspectProjectBranchParams = decode(req)?;
                self.inspect_branch(&params.input, cancel).await.map_err(wire)
            }
            "project/getProjectBranchMenu" => {
                let params: p::ProjectGetProjectBranchMenuParams = decode(req)?;
                self.branch_menu(&params.input, cancel).await.map_err(wire)
            }
            "project/getProjectConnectors" => {
                let params: p::ProjectGetProjectConnectorsParams = decode(req)?;
                self.connectors.get(&params.project_path, cancel).await.map_err(|message| failed(DOMAIN, message))
            }
            "project/listWorktrees" => {
                let _: p::ProjectListWorktreesParams = decode(req)?;
                self.list_worktrees(cancel).await.map_err(wire)
            }
            "project/previewWorktreeCleanup" => {
                let params: p::ProjectPreviewWorktreeCleanupParams = decode(req)?;
                self.preview_cleanup(params.input.as_ref(), cancel).await.map_err(wire)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    async fn mutate(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let cancel = &req.ctx.cancel;
        match req.method.as_str() {
            "project/selectProjectBranch" => {
                let params: p::ProjectSelectProjectBranchParams = decode(req)?;
                self.select_branch(&params.input, cancel).await.map_err(wire)
            }
            "project/mergeProjectBranch" => {
                let params: p::ProjectMergeProjectBranchParams = decode(req)?;
                self.merge_branch(&params.input, cancel).await.map_err(wire)
            }
            "project/manageProjectBranch" => {
                let params: p::ProjectManageProjectBranchParams = decode(req)?;
                self.manage_branch(&params.input, cancel).await.map_err(wire)
            }
            "project/removeWorktree" => {
                let params: p::ProjectRemoveWorktreeParams = decode(req)?;
                self.remove_worktree(&params, cancel).await.map_err(wire)
            }
            "project/pruneWorktrees" => {
                let params: p::ProjectPruneWorktreesParams = decode(req)?;
                self.prune(params.input.as_ref(), cancel).await.map_err(wire)
            }
            "project/deleteWorktree" => {
                let params: p::ProjectDeleteWorktreeParams = decode(req)?;
                self.delete_worktree(&params.input, cancel).await.map_err(wire)
            }
            "project/setArchivedSessionWorktrees" => {
                let params: p::ProjectSetArchivedSessionWorktreesParams = decode(req)?;
                self.set_archived(&params.input, cancel).await.map_err(wire)
            }
            "project/setProjectConnectorEnabled" => {
                let params: ConnectorSwitchParams = decode(req)?;
                // The host marks a remote client's call; a relay origin is one by itself.
                let no_widen = req.ctx.origin == Origin::Relay || params.options.as_ref().and_then(|o| o.get("noWiden")) == Some(&Value::Bool(true));
                self.connectors
                    .set_enabled(&params.project_path, &params.connector_id, &params.enabled, no_widen, cancel)
                    .await
                    .map_err(|message| failed(DOMAIN, message))
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }
}

fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[async_trait]
impl DomainService for ProjectService {
    fn methods(&self) -> &'static [&'static str] {
        &[
            "project/inspectProjectBranch",
            "project/getProjectBranchMenu",
            "project/getProjectConnectors",
            "project/listWorktrees",
            "project/previewWorktreeCleanup",
            "project/selectProjectBranch",
            "project/mergeProjectBranch",
            "project/manageProjectBranch",
            "project/removeWorktree",
            "project/pruneWorktrees",
            "project/deleteWorktree",
            "project/setArchivedSessionWorktrees",
            "project/setProjectConnectorEnabled",
        ]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        if READS.contains(&method) {
            return self.read(&req).await.map(Reply::Value);
        }
        if MUTATIONS.contains(&method) {
            // A duplicate answers what the first one did; a report too large to be stored with
            // the op is not reproduced.
            return self.ops.run(&req, None, || self.mutate(&req), || async { Ok(Value::Null) }).await;
        }
        Err(wrong_method(DOMAIN, method))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
