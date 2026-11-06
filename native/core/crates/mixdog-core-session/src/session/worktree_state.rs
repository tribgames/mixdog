//! The session workspace record (`workspace` of the session header): where a Lead executes,
//! its revision and the in-flight transition marker, with Node's validation texts, plus the
//! path comparisons every workspace decision uses and the pure record helpers of a Project
//! switch and a resume.

use mixdog_scm::error::ScmFailure;
use mixdog_scm::locks::path_key;
use serde_json::Value;
use serde_json::json;

/// A plain failure whose text is the message (Node's `TypeError`/`Error`).
pub(super) fn plain(message: impl Into<String>) -> ScmFailure {
    ScmFailure::git(message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionState {
    Idle,
    Provisioning,
    Switching,
    Removing,
    Recovery,
}

impl TransitionState {
    const ALL: [Self; 5] = [Self::Idle, Self::Provisioning, Self::Switching, Self::Removing, Self::Recovery];

    pub fn wire(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Provisioning => "provisioning",
            Self::Switching => "switching",
            Self::Removing => "removing",
            Self::Recovery => "recovery",
        }
    }
}

/// Where a Lead session executes. `project_path` stays the registered Project while `cwd`
/// points into a managed worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub project_path: String,
    pub repo_common_dir: Option<String>,
    pub cwd: String,
    pub worktree_id: Option<String>,
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub merge_target: Option<String>,
    pub revision: u64,
    pub state: TransitionState,
    /// `None` exactly when `state` is idle.
    pub tx_id: Option<String>,
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn text(value: Option<&Value>, name: &str) -> Result<String, ScmFailure> {
    match value {
        Some(Value::String(s)) if !mixdog_js::js_trim(s).is_empty() => Ok(s.clone()),
        _ => Err(plain(format!("{name} must be a non-empty string."))),
    }
}

fn nullable_text(value: Option<&Value>, name: &str) -> Result<Option<String>, ScmFailure> {
    match value {
        None | Some(Value::Null) => Ok(None),
        other => text(other, name).map(Some),
    }
}

fn nullable_commit(value: Option<&Value>, name: &str) -> Result<Option<String>, ScmFailure> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s))
            if (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(Some(s.clone()))
        }
        _ => Err(plain(format!("{name} must be a full lowercase commit id."))),
    }
}

impl Workspace {
    /// `normalizeSessionWorkspace`: every invalid field or broken invariant fails with Node's text.
    pub fn from_value(input: &Value) -> Result<Self, ScmFailure> {
        let value = input.as_object().ok_or_else(|| plain("workspace must be an object."))?;
        let default_transition = json!({ "state": "idle", "txId": null });
        let transition = value
            .get("transition")
            .unwrap_or(&default_transition)
            .as_object()
            .ok_or_else(|| plain("workspace.transition must be an object."))?;
        let state = transition
            .get("state")
            .and_then(Value::as_str)
            .and_then(|s| TransitionState::ALL.into_iter().find(|t| t.wire() == s))
            .ok_or_else(|| {
                let names: Vec<&str> = TransitionState::ALL.iter().map(|t| t.wire()).collect();
                plain(format!("workspace.transition.state must be one of {}.", names.join(", ")))
            })?;
        let tx_id = nullable_text(transition.get("txId"), "workspace.transition.txId")?;
        if (state == TransitionState::Idle) != tx_id.is_none() {
            return Err(plain("workspace.transition.txId must be null exactly when the state is idle."));
        }
        let revision = match value.get("revision") {
            None => 0,
            Some(v) => v
                .as_u64()
                .filter(|r| *r <= MAX_SAFE_INTEGER)
                .ok_or_else(|| plain("workspace.revision must be a non-negative integer."))?,
        };
        let workspace = Self {
            project_path: text(value.get("projectPath"), "workspace.projectPath")?,
            repo_common_dir: nullable_text(value.get("repoCommonDir"), "workspace.repoCommonDir")?,
            cwd: text(value.get("cwd"), "workspace.cwd")?,
            worktree_id: nullable_text(value.get("worktreeId"), "workspace.worktreeId")?,
            branch: nullable_text(value.get("branch"), "workspace.branch")?,
            base_commit: nullable_commit(value.get("baseCommit"), "workspace.baseCommit")?,
            merge_target: nullable_text(value.get("mergeTarget"), "workspace.mergeTarget")?,
            revision,
            state,
            tx_id,
        };
        if workspace.worktree_id.is_some() && (workspace.repo_common_dir.is_none() || workspace.branch.is_none()) {
            return Err(plain("A worktree-bound workspace requires repoCommonDir and branch."));
        }
        Ok(workspace)
    }

    /// The project-folder workspace a session that never moved has (revision 0).
    pub fn project(project_path: &str, cwd: &str) -> Self {
        Self {
            project_path: project_path.to_owned(),
            repo_common_dir: None,
            cwd: cwd.to_owned(),
            worktree_id: None,
            branch: None,
            base_commit: None,
            merge_target: None,
            revision: 0,
            state: TransitionState::Idle,
            tx_id: None,
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "projectPath": self.project_path,
            "repoCommonDir": self.repo_common_dir,
            "cwd": self.cwd,
            "worktreeId": self.worktree_id,
            "branch": self.branch,
            "baseCommit": self.base_commit,
            "mergeTarget": self.merge_target,
            "revision": self.revision,
            "transition": { "state": self.state.wire(), "txId": self.tx_id },
        })
    }

    pub fn is_bound(&self) -> bool {
        self.worktree_id.as_deref().is_some_and(|id| !id.is_empty())
    }

    /// The revision a committed change carries.
    pub fn next_revision(&self) -> u64 {
        self.revision + 1
    }

    pub fn in_transition(&self, state: TransitionState, tx_id: &str) -> Self {
        Self { state, tx_id: Some(tx_id.to_owned()), ..self.clone() }
    }

    pub fn idle(&self) -> Self {
        Self { state: TransitionState::Idle, tx_id: None, ..self.clone() }
    }
}

/// The stored record, or `None` when absent or malformed (`readSessionWorkspace`).
pub fn read_session_workspace(stored: Option<&Value>) -> Option<Workspace> {
    stored.and_then(|v| Workspace::from_value(v).ok())
}

pub(super) fn is_bound(workspace: &Option<Workspace>) -> bool {
    workspace.as_ref().is_some_and(Workspace::is_bound)
}

// ---- paths -------------------------------------------------------------------------------

pub fn same_path(left: &str, right: &str) -> bool {
    path_key(std::path::Path::new(left)) == path_key(std::path::Path::new(right))
}

/// `child` is `parent` itself or lies inside it.
pub fn is_within(parent: &str, child: &str) -> bool {
    let base = path_key(std::path::Path::new(parent));
    let target = path_key(std::path::Path::new(child));
    target == base || target.starts_with(&format!("{base}/"))
}

/// Repository-relative folder of a Project registered below the repository root ('' for the
/// root or anything outside it), with forward slashes.
pub fn project_subdir_of(top_level: &str, project_path: &str) -> String {
    if top_level.is_empty() || project_path.is_empty() || !is_within(top_level, project_path) {
        return String::new();
    }
    let top = path_key(std::path::Path::new(top_level));
    let project = project_path.replace('\\', "/");
    project.get(top.len()..).map(|rest| rest.trim_matches('/').to_owned()).unwrap_or_default()
}

/// `subdir` (forward slashes) inside `root`.
pub fn checkout_folder(root: &str, subdir: &str) -> String {
    if subdir.is_empty() {
        return root.to_owned();
    }
    let mut path = std::path::PathBuf::from(root);
    path.extend(subdir.split('/'));
    path.to_string_lossy().into_owned()
}

// ---- record helpers ------------------------------------------------------------------------

/// A manual Project selection while a workspace record exists (`workspaceForProjectSelection`):
/// the record to store (`None`: keep the session's) and the Project path the desktop metadata
/// carries.
pub fn workspace_for_project_selection(stored: Option<&Value>, cwd: &str) -> (Option<Value>, String) {
    let Some(current) = read_session_workspace(stored) else {
        return (stored.cloned(), cwd.to_owned());
    };
    if current.is_bound() && is_within(&current.cwd, cwd) {
        return (stored.cloned(), current.project_path);
    }
    if !current.is_bound() && same_path(&current.cwd, cwd) {
        return (stored.cloned(), cwd.to_owned());
    }
    let mut moved = Workspace::project(cwd, cwd);
    moved.revision = current.next_revision();
    (Some(moved.to_value()), cwd.to_owned())
}

/// Where a session replacing this one (/new, /clear) starts: the Project folder when the
/// session is bound to a worktree.
pub fn replacement_session_cwd(stored: Option<&Value>) -> Option<String> {
    read_session_workspace(stored).filter(Workspace::is_bound).map(|w| w.project_path)
}

/// Execution root of a bound session on resume: the worktree (`missing` false) when it exists,
/// else the Project folder flagged missing; `None` when not bound.
pub fn bound_workspace_cwd(stored: Option<&Value>, worktree_exists: bool) -> Option<(String, bool)> {
    let workspace = read_session_workspace(stored).filter(Workspace::is_bound)?;
    Some(if worktree_exists { (workspace.cwd, false) } else { (workspace.project_path, true) })
}

/// What a resume does to the record: the record to store and the worker cwd lock.
pub struct Resumed {
    pub workspace: Option<Value>,
    pub lock: Option<String>,
}

/// A bound session whose worktree vanished enters `recovery` (turns refuse until the user picks
/// a branch or removes the worktree); an intact one re-locks its workers to the worktree.
pub fn restore_workspace_after_resume(stored: Option<&Value>, worktree_exists: bool) -> Resumed {
    let Some(workspace) = read_session_workspace(stored).filter(Workspace::is_bound) else {
        return Resumed { workspace: stored.cloned(), lock: None };
    };
    if worktree_exists {
        let record = if workspace.state != TransitionState::Idle { Some(workspace.idle().to_value()) } else { stored.cloned() };
        return Resumed { workspace: record, lock: Some(workspace.cwd) };
    }
    let tx = format!("recovery:{}", workspace.worktree_id.clone().unwrap_or_default());
    Resumed { workspace: Some(workspace.in_transition(TransitionState::Recovery, &tx).to_value()), lock: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_validated_with_nodes_texts() {
        let bad = |v: Value| Workspace::from_value(&v).unwrap_err().to_string();
        assert_eq!(bad(json!(1)), "workspace must be an object.");
        assert_eq!(bad(json!({"cwd": "/a"})), "workspace.projectPath must be a non-empty string.");
        assert_eq!(
            bad(json!({"projectPath": "/a", "cwd": "/a", "transition": {"state": "switching", "txId": null}})),
            "workspace.transition.txId must be null exactly when the state is idle."
        );
        assert_eq!(
            bad(json!({"projectPath": "/a", "cwd": "/a", "worktreeId": "w"})),
            "A worktree-bound workspace requires repoCommonDir and branch."
        );
        assert_eq!(bad(json!({"projectPath": "/a", "cwd": "/a", "revision": -1})), "workspace.revision must be a non-negative integer.");
        let ok = Workspace::from_value(&json!({"projectPath": "/a", "cwd": "/a"})).unwrap();
        assert_eq!((ok.revision, ok.next_revision(), ok.is_bound()), (0, 1, false));
        assert_eq!(Workspace::from_value(&ok.to_value()).unwrap(), ok);
    }

    #[test]
    fn subfolder_projects_map_into_the_checkout() {
        assert_eq!(project_subdir_of("/r", "/r/apps/web"), "apps/web");
        assert_eq!(project_subdir_of("/r", "/r"), "");
        assert_eq!(project_subdir_of("/r", "/other"), "");
        assert!(is_within("/r", "/r/a") && !is_within("/r", "/rx"));
    }

    #[test]
    fn a_project_selection_outside_the_worktree_leaves_it_at_a_new_revision() {
        let bound = json!({"projectPath": "/p", "repoCommonDir": "/p/.git", "cwd": "/w", "worktreeId": "w", "branch": "b", "revision": 3});
        let (kept, project) = workspace_for_project_selection(Some(&bound), "/w/sub");
        assert_eq!((kept, project.as_str()), (Some(bound.clone()), "/p"));
        let (moved, project) = workspace_for_project_selection(Some(&bound), "/q");
        let moved = Workspace::from_value(&moved.unwrap()).unwrap();
        assert_eq!((moved.revision, moved.is_bound(), project.as_str()), (4, false, "/q"));
        assert_eq!(replacement_session_cwd(Some(&bound)).as_deref(), Some("/p"));
    }

    #[test]
    fn a_resume_with_a_missing_worktree_enters_recovery() {
        let bound = json!({"projectPath": "/p", "repoCommonDir": "/p/.git", "cwd": "/w", "worktreeId": "w", "branch": "b"});
        let resumed = restore_workspace_after_resume(Some(&bound), false);
        let record = Workspace::from_value(&resumed.workspace.unwrap()).unwrap();
        assert_eq!((record.state, record.tx_id.as_deref()), (TransitionState::Recovery, Some("recovery:w")));
        assert!(resumed.lock.is_none());
        assert_eq!(restore_workspace_after_resume(Some(&bound), true).lock.as_deref(), Some("/w"));
        assert_eq!(bound_workspace_cwd(Some(&bound), false), Some(("/p".to_owned(), true)));
    }
}
