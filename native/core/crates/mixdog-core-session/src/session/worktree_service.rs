//! The thread methods of the session workspace and the turn changes (Node's session read and
//! configure actions `getBranchMenu`, `getSessionWorktreeWork`, `requestWorktree`, `selectBranch`,
//! `mergeWorkspace`, `revertTurnChanges`, `reapplyTurnChanges`). The app-server hands them to
//! this domain instead of the thread's actor: they act on the workspace transitions
//! ([`SessionWorkspaces`]) and the turn review, and only name the thread. They are the public
//! input of those actions: never `ownTurn`, which stays with the `git` tool.
//!
//! A request without a `threadId` is refused: the 1.4.5 daemon hosted one session and answered
//! such a call for it, the core hosts many.

use mixdog_app_protocol::v2::params::ThreadGetBranchMenuParams;
use mixdog_app_protocol::v2::params::ThreadGetSessionWorktreeWorkParams;
use mixdog_app_protocol::v2::params::ThreadMergeWorkspaceParams;
use mixdog_app_protocol::v2::params::ThreadReapplyTurnChangesParams;
use mixdog_app_protocol::v2::params::ThreadRequestWorktreeParams;
use mixdog_app_protocol::v2::params::ThreadRevertTurnChangesParams;
use mixdog_app_protocol::v2::params::ThreadSelectBranchParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_scm::error::WORKTREE_DOMAIN;

use super::*;

pub const GET_BRANCH_MENU: &str = "thread/getBranchMenu";
pub const GET_SESSION_WORKTREE_WORK: &str = "thread/getSessionWorktreeWork";
pub const REQUEST_WORKTREE: &str = "thread/requestWorktree";
pub const SELECT_BRANCH: &str = "thread/selectBranch";
pub const MERGE_WORKSPACE: &str = "thread/mergeWorkspace";
pub const REVERT_TURN_CHANGES: &str = "thread/revertTurnChanges";
pub const REAPPLY_TURN_CHANGES: &str = "thread/reapplyTurnChanges";

const TURN_REVIEW_DOMAIN: &str = "turnReview";
/// What the op record calls a change that leaves the process: git moves a checkout.
const GIT_EFFECT: &str = "git/worktree";

pub struct ThreadScmService {
    workspaces: SessionWorkspaces,
    review: Arc<dyn TurnReviewApi>,
    ops: OpScopes,
}

/// A failure as the 1.4.5 daemon threw it: a plain `Error` or `TypeError` answers its sentence
/// alone, a typed worktree error its code, the runtime's own text and its details.
pub(crate) fn scm_error(failure: ScmFailure) -> CoreError {
    match &failure {
        ScmFailure::Command { text, .. } => failed(WORKTREE_DOMAIN, text.clone()),
        ScmFailure::Coded { domain, code, detail, .. } => CoreError::DomainError {
            domain: (*domain).into(),
            code: Some((*code).into()),
            message: Some(thrown_message(&failure).into()),
            detail: detail.clone(),
        },
        _ => failure.into(),
    }
}

fn review_error(error: ReviewError) -> CoreError {
    CoreError::DomainError { domain: TURN_REVIEW_DOMAIN.into(), code: None, message: Some(error.message.into()), detail: None }
}

fn thread_of(id: Option<ThreadId>) -> Result<ThreadId, CoreError> {
    id.ok_or_else(|| invalid("threadId", "the thread to act on"))
}

/// `validRevision`: absent or null is no expectation, anything else a safe non-negative integer.
fn valid_revision(value: Option<&JsonValue>) -> Result<Option<u64>, ScmFailure> {
    match value {
        None | Some(JsonValue::Null) => Ok(None),
        Some(number) => number
            .as_f64()
            .filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n))
            .map(|n| Some(n as u64))
            .ok_or_else(|| plain("expectedRevision must be a non-negative integer.")),
    }
}

fn flag(input: &JsonValue, key: &str) -> bool {
    input.get(key) == Some(&JsonValue::Bool(true))
}

fn string(input: &JsonValue, key: &str) -> String {
    input.get(key).and_then(JsonValue::as_str).unwrap_or_default().to_owned()
}

/// The `requestWorktree` input, validated in Node's order: the name, the revision, the choice.
fn request_input(input: &JsonValue) -> Result<RequestWorktree, ScmFailure> {
    let name = match input.get("name") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(name)) => Some(name.as_str()),
        Some(_) => return Err(plain("worktree name is invalid: a name is required")),
    };
    let name = valid_name(name)?;
    let expected_revision = valid_revision(input.get("expectedRevision"))?;
    let carry_changes = match input.get("carryChanges") {
        None | Some(JsonValue::Null) => None,
        // Not a choice either way: `request_worktree` refuses it with Node's text.
        other => Some(other.and_then(JsonValue::as_str).unwrap_or_default().to_owned()),
    };
    Ok(RequestWorktree {
        name,
        confirm_large: flag(input, "confirmLarge"),
        provision: flag(input, "provision"),
        carry_changes,
        prompt: string(input, "prompt"),
        tx_id: string(input, "txId"),
        expected_revision,
    })
}

fn select_input(input: &JsonValue) -> Result<SelectBranch, ScmFailure> {
    Ok(SelectBranch {
        branch: string(input, "branch"),
        create: flag(input, "create"),
        expected_revision: valid_revision(input.get("expectedRevision"))?,
        confirm_large: flag(input, "confirmLarge"),
        tx_id: string(input, "txId"),
    })
}

fn merge_input(input: &JsonValue) -> Result<MergeWorkspace, ScmFailure> {
    let confirmed = flag(input, "confirmed");
    Ok(MergeWorkspace {
        confirmed,
        target: input.get("target").and_then(JsonValue::as_str).map(str::to_owned),
        cleanup: flag(input, "cleanup"),
        // An unconfirmed merge is refused before its revision is read.
        expected_revision: if confirmed { valid_revision(input.get("expectedRevision"))? } else { None },
    })
}

/// `sessionIds` of the `getSessionWorktreeWork` input: the non-empty strings of an array.
fn session_ids(input: Option<&JsonValue>) -> Vec<String> {
    input
        .and_then(|input| input.get("sessionIds"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `promptTitle(prompt, displayText)` (`session-title.mjs`) over a `TurnInput` as JSON: the visible text titles the
/// worktree, else the prompt's text, else its first attachment.
fn prompt_title(input: Option<&JsonValue>) -> String {
    use mixdog_store::title::generated_session_title;
    use mixdog_store::title::normalize_session_title;
    let Some(input) = input else { return String::new() };
    if let Some(shown) = input.pointer("/options/displayText").and_then(JsonValue::as_str).filter(|text| !text.is_empty()) {
        let title = generated_session_title(shown, "", 32);
        if !title.is_empty() {
            return title;
        }
    }
    match input.get("prompt") {
        Some(JsonValue::String(text)) => generated_session_title(text, "", 32),
        Some(JsonValue::Array(parts)) => {
            let kind = |part: &JsonValue| part.get("type").and_then(JsonValue::as_str).unwrap_or_default().to_owned();
            let fallback = match parts.iter().find(|part| ["image", "video", "file"].contains(&kind(part).as_str())) {
                Some(part) => match kind(part).as_str() {
                    "video" => "[Video]".to_owned(),
                    "image" => "[Image]".to_owned(),
                    _ => normalize_session_title(part.get("filename").and_then(JsonValue::as_str).unwrap_or_default(), "[File]", 32),
                },
                None => String::new(),
            };
            let text = parts
                .iter()
                .filter(|part| kind(part) == "text")
                .map(|part| part.get("text").and_then(JsonValue::as_str).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" ");
            generated_session_title(&text, &fallback, 32)
        }
        _ => String::new(),
    }
}

impl ThreadScmService {
    /// The draft's worktree step of `createNewTask` (`session-host-lifecycle.ts:847-897`), through the same workspace
    /// transitions `thread/selectBranch` and `thread/requestWorktree` use: a named branch is selected (created when
    /// `create`), else a worktree is provisioned at the current commit without the project folder's changes. The session
    /// must have entered it before the first prompt. Only the settings default (`fromDefault`) is allowed to find the
    /// repository unsupported and run in its folder.
    pub(crate) async fn enter_new_thread_worktree(
        &self,
        thread: &ThreadId,
        draft: &JsonValue,
        input: Option<&JsonValue>,
        cancel: &CancellationToken,
    ) -> Result<(), CoreError> {
        let not_entered = || CoreError::DomainError {
            domain: WORKTREE_DOMAIN.into(),
            code: Some("WORKTREE_NOT_IMPLEMENTED".into()),
            message: Some("WORKTREE_NOT_IMPLEMENTED: The session did not enter its worktree before the first prompt.".into()),
            detail: None,
        };
        let confirm = flag(draft, "confirmLarge");
        let branch = string(draft, "branch");
        if !branch.is_empty() {
            let select = select_input(&json!({ "branch": branch, "create": flag(draft, "create"), "confirmLarge": confirm })).map_err(scm_error)?;
            let done = self.workspaces.select_branch(thread.as_str(), select, false, cancel).await.map_err(scm_error)?;
            return if done.pointer("/workspace/branch").and_then(JsonValue::as_str) == Some(branch.as_str()) { Ok(()) } else { Err(not_entered()) };
        }
        let tx_id = input
            .and_then(|input| input.pointer("/options/clientSubmissionId"))
            .and_then(JsonValue::as_str)
            .map_or_else(|| format!("desktop-submit-{}", thread.as_str()), str::to_owned);
        let request = request_input(&json!({
            "provision": true,
            "carryChanges": "leave",
            "confirmLarge": confirm,
            "prompt": prompt_title(input),
            "txId": tx_id,
        }))
        .map_err(scm_error)?;
        match self.workspaces.request_worktree(thread.as_str(), request, false, cancel).await {
            Ok(done) => {
                let bound = done.get("pending") == Some(&JsonValue::Bool(false)) && done.pointer("/workspace/worktreeId").is_some_and(JsonValue::is_string);
                if bound { Ok(()) } else { Err(not_entered()) }
            }
            Err(failure) if flag(draft, "fromDefault") && matches!(&failure, ScmFailure::Coded { code, .. } if *code == "WORKTREE_UNSUPPORTED_REPO") => Ok(()),
            Err(failure) => Err(scm_error(failure)),
        }
    }

    pub fn new(workspaces: SessionWorkspaces, review: Arc<dyn TurnReviewApi>, ops: OpScopes) -> Self {
        Self { workspaces, review, ops }
    }

    /// The workspace as it is now, the answer of a duplicate whose result was not kept.
    async fn workspace_now(&self, thread: &ThreadId) -> Result<JsonValue, CoreError> {
        let workspace = self.workspaces.workspace(thread.as_str()).map_err(scm_error)?;
        Ok(json!({ "revision": workspace.revision, "workspace": workspace.to_value() }))
    }

    /// An admitted mutation completes even when its caller leaves: it runs on its own token.
    async fn mutate_workspace(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let own = CancellationToken::new();
        match req.method.as_str() {
            REQUEST_WORKTREE => {
                let params: ThreadRequestWorktreeParams = decode(req)?;
                let thread = thread_of(params.thread_id)?;
                let provisions = flag(&params.input, "provision");
                let run = || async {
                    let input = request_input(&params.input).map_err(scm_error)?;
                    self.workspaces.request_worktree(thread.as_str(), input, false, &own).await.map_err(scm_error)
                };
                let external = provisions.then(|| (GIT_EFFECT, thread.as_str().to_owned()));
                self.ops.run(req, external, run, || self.workspace_now(&thread)).await
            }
            SELECT_BRANCH => {
                let params: ThreadSelectBranchParams = decode(req)?;
                let thread = thread_of(params.thread_id)?;
                let run = || async {
                    let input = select_input(&params.input).map_err(scm_error)?;
                    self.workspaces.select_branch(thread.as_str(), input, false, &own).await.map_err(scm_error)
                };
                self.ops.run(req, Some((GIT_EFFECT, thread.as_str().to_owned())), run, || self.workspace_now(&thread)).await
            }
            MERGE_WORKSPACE => {
                let params: ThreadMergeWorkspaceParams = decode(req)?;
                let thread = thread_of(params.thread_id)?;
                let run = || async {
                    let input = merge_input(&params.input).map_err(scm_error)?;
                    self.workspaces.merge_workspace(thread.as_str(), input, false, &own).await.map_err(scm_error)
                };
                self.ops.run(req, Some(("git/merge", thread.as_str().to_owned())), run, || self.workspace_now(&thread)).await
            }
            other => Err(wrong_method("thread workspace", other)),
        }
    }

    /// Undo or Reapply one file or the whole turn at a record revision.
    async fn mutate_changes(
        &self,
        req: &CoreRequest,
        thread: ThreadId,
        checkpoint_id: String,
        file: JsonValue,
        revision: i64,
        reverse: bool,
    ) -> Result<Reply, CoreError> {
        let session = thread.as_str();
        // Node cleans anything but a string to nothing, which asks for the whole turn.
        let file = file.as_str();
        let run = || async {
            let reply = if reverse {
                self.review.revert_turn_changes(session, &checkpoint_id, file, revision as f64).await
            } else {
                self.review.reapply_turn_changes(session, &checkpoint_id, file, revision as f64).await
            };
            reply.map(JsonValue::Object).map_err(review_error)
        };
        // The record as it reads now: a duplicate's answer when the reply was too large to keep.
        let reproduce = || async {
            let read = ChangesRead { checkpoint_id: checkpoint_id.clone(), patch: false, file: None };
            self.review.turn_changes(session, read).await.map(JsonValue::Object).map_err(review_error)
        };
        self.ops.run(req, None, run, reproduce).await
    }
}

/// [`NewThreadPlace`](super::NewThreadPlace) over the workspace service and the registered Projects.
pub struct ScmNewThreadPlace {
    scm: Arc<ThreadScmService>,
    folders: Arc<dyn crate::session::thread_settings::ProjectFolders>,
}

impl ScmNewThreadPlace {
    pub fn new(scm: Arc<ThreadScmService>, folders: Arc<dyn crate::session::thread_settings::ProjectFolders>) -> Self {
        Self { scm, folders }
    }
}

#[async_trait]
impl crate::session::NewThreadPlace for ScmNewThreadPlace {
    async fn projects(&self) -> Result<Vec<String>, String> {
        self.folders.projects().await
    }

    async fn touch_project(&self, path: &str) -> Result<(), String> {
        self.folders.touch_selected(path).await
    }

    async fn enter_worktree(&self, thread: &ThreadId, worktree: &JsonValue, input: Option<&JsonValue>, cancel: &CancellationToken) -> Result<(), CoreError> {
        self.scm.enter_new_thread_worktree(thread, worktree, input, cancel).await
    }
}

#[async_trait]
impl DomainService for ThreadScmService {
    fn methods(&self) -> &'static [&'static str] {
        &[
            GET_BRANCH_MENU,
            GET_SESSION_WORKTREE_WORK,
            REQUEST_WORKTREE,
            SELECT_BRANCH,
            MERGE_WORKSPACE,
            REVERT_TURN_CHANGES,
            REAPPLY_TURN_CHANGES,
        ]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            GET_BRANCH_MENU => {
                let params: ThreadGetBranchMenuParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                // A session that is not there is the thread's absence, as the workspace mutations answer it (Node's session read:
                // `session <id> is not available`).
                if !self.workspaces.hosts(thread.as_str()) {
                    return Err(CoreError::ThreadNotFound { thread_id: thread });
                }
                let menu = self.workspaces.branch_menu(thread.as_str(), &req.ctx.cancel).await;
                menu.map(Reply::Value).map_err(scm_error)
            }
            GET_SESSION_WORKTREE_WORK => {
                let params: ThreadGetSessionWorktreeWorkParams = decode(&req)?;
                let work = self.workspaces.session_worktree_work(&session_ids(params.input.as_ref()), &req.ctx.cancel).await;
                work.map(Reply::Value).map_err(scm_error)
            }
            REQUEST_WORKTREE | SELECT_BRANCH | MERGE_WORKSPACE => self.mutate_workspace(&req).await,
            REVERT_TURN_CHANGES => {
                let params: ThreadRevertTurnChangesParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                self.mutate_changes(&req, thread, params.checkpoint_id, params.file, params.revision, true).await
            }
            REAPPLY_TURN_CHANGES => {
                let params: ThreadReapplyTurnChangesParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                self.mutate_changes(&req, thread, params.checkpoint_id, params.file, params.revision, false).await
            }
            other => Err(wrong_method("thread workspace", other)),
        }
    }

    fn notify(&self, _: Method, _: JsonValue, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
