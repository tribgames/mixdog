//! The `DomainService` of the `git`, `github` and `review` namespaces (DS §5.1): it parses a
//! request, runs the one engine, and answers in the shapes the panes already receive. The same
//! object is registered under all three slots.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::v2::domain::ReviewDiffGetParams;
use mixdog_app_protocol::v2::domain::ReviewScope as WireReviewScope;
use mixdog_app_protocol::v2::params as p;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::StatePublisher;
use mixdog_core_api::Subscribe;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::repo::ChangeKind;
use mixdog_core_api::domain::repo::InspectorKey;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::RepoEvidence;
use mixdog_core_api::domain::repo::RepoInspector;
use mixdog_core_api::domain::repo::RepoRef;
use mixdog_core_api::domain::repo::ReviewRequest;
use mixdog_core_api::domain::repo::ReviewScope;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::DomainService;
use mixdog_protocol::FeedId;
use mixdog_protocol::LoginFlowId;
use mixdog_protocol::SectionName;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::GITHUB_DOMAIN;
use crate::error::ScmFailure;
use crate::feeds::FeedPublisher;

/// The `git` plugin gate: GitHub actions are refused while Git & GitHub is off in Extensions.
#[async_trait]
pub trait FeatureGate: Send + Sync {
    async fn github_enabled(&self) -> bool;
}

/// Where a turn or session review starts: the repository and the tree captured at the start of
/// the scope. Owned by the thread layer (change records and checkpoints).
#[async_trait]
pub trait ReviewBases: Send + Sync {
    async fn base(
        &self,
        thread: &ThreadId,
        scope: WireReviewScope,
        checkpoint: Option<&str>,
    ) -> Option<(PathBuf, ObjectId)>;
}

/// The working directory of a thread (the `cwd` of its header): what Node's session review reads
/// resolve against (`getCwd()`).
#[async_trait]
pub trait ThreadWorktrees: Send + Sync {
    /// `Ok(None)`: no such thread. `Err`: the record read never ran.
    async fn cwd(&self, thread: &ThreadId) -> Result<Option<String>, CoreError>;
}

/// `hostState` key of the global git identity (`{name, email, defaultBranch}`), published after each write.
pub const GIT_CONFIG_KEY: &str = "gitConfig";
const GATE_OFF: &str = "Enable Git & GitHub in Extensions → Plugin before using GitHub actions.";

struct GitWatch {
    feed: FeedPublisher,
    root: PathBuf,
    revision: AtomicU64,
    dirty: AtomicBool,
    running: AtomicBool,
}

struct Flow {
    session: Arc<dyn LoginSession>,
    feed: FeedPublisher,
    /// The code and device page the flow showed, kept for the states after it.
    device: Mutex<Option<(String, String)>>,
}

impl Flow {
    fn json(&self, id: &LoginFlowId, state: &LoginState) -> Value {
        let mut device = self.device.lock().expect("device");
        if let LoginState::DeviceCode { user_code, verification_uri, .. } = state {
            *device = Some((user_code.clone(), verification_uri.clone()));
        }
        flow_json(id, state, device.as_ref())
    }
}

pub struct ScmService {
    scm: Arc<Scm>,
    feeds: Arc<dyn ScopedFeeds>,
    publisher: Arc<dyn StatePublisher>,
    gate: Arc<dyn FeatureGate>,
    reviews: Arc<dyn TurnReviewApi>,
    worktrees: Arc<dyn ThreadWorktrees>,
    login: crate::gh::login::GithubLogin,
    flows: Mutex<HashMap<LoginFlowId, Arc<Flow>>>,
    flow_seq: AtomicU64,
    watches: Mutex<HashMap<String, Arc<GitWatch>>>,
}

fn invalid(error: serde_json::Error) -> CoreError {
    CoreError::InvalidParams {
        path: "params".into(),
        expected: error.to_string().into(),
    }
}

/// A turn-review failure, with the message Node's error carried.
fn review_error(error: ReviewError) -> CoreError {
    CoreError::DomainError { domain: "turnReview".into(), code: None, message: Some(error.message.into()), detail: None }
}

fn decode<T: DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(invalid)
}

fn cwd(value: &str) -> Result<PathBuf, ScmFailure> {
    let trimmed = value.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        // `requiredRepositoryCwd` (git-contract.mjs): Node threw this plain TypeError.
        return Err(ScmFailure::git("A project directory is required."));
    }
    Ok(path)
}

fn string_field(input: &Value, key: &str) -> Result<String, ScmFailure> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ScmFailure::invalid(format!("input.{key}"), "a string"))
}

fn unit() -> Value {
    Value::Null
}

pub(crate) fn kind_letter(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "A",
        ChangeKind::Deleted => "D",
        ChangeKind::TypeChanged => "T",
        ChangeKind::Untracked => "?",
        ChangeKind::Conflicted => "U",
        _ => "M",
    }
}

pub fn key_text(key: &InspectorKey) -> String {
    format!(
        "{}:{}:{}",
        key.head.as_ref().map_or("", |h| h.0.as_str()),
        key.index_checksum.as_deref().unwrap_or(""),
        key.worktree_token
    )
}

/// The wire shape of a `GitHub` sign-in flow.
pub fn flow_json(flow: &LoginFlowId, state: &LoginState, device: Option<&(String, String)>) -> Value {
    let id = flow.as_str();
    // Node's flow keeps the code and the device page it showed: `{...flow, state: 'success' | 'error'}`.
    let with_device = |mut value: Value| {
        if let (Some((code, url)), Some(fields)) = (device, value.as_object_mut()) {
            fields.insert("code".into(), json!(code));
            fields.insert("url".into(), json!(url));
        }
        value
    };
    match state {
        LoginState::Starting | LoginState::Waiting | LoginState::Authorize { .. } => {
            json!({ "flowId": id, "state": "pending" })
        }
        LoginState::DeviceCode { user_code, verification_uri, .. } => {
            json!({ "flowId": id, "state": "code", "code": user_code, "url": verification_uri })
        }
        LoginState::Done { account } => match account {
            Some(login) => with_device(json!({ "flowId": id, "state": "success", "login": login })),
            None => with_device(json!({ "flowId": id, "state": "success" })),
        },
        LoginState::Failed(failure) => {
            let message = match failure {
                LoginFailure::Denied => "GitHub denied the sign-in.".to_owned(),
                LoginFailure::Expired => "The sign-in code expired.".to_owned(),
                LoginFailure::Unavailable { .. } => "GitHub CLI is not installed.".to_owned(),
                LoginFailure::Failed { message, .. } => message.clone(),
                LoginFailure::VerificationRequired { url, .. } => format!("Verify your account at {url} and sign in again."),
            };
            with_device(json!({ "flowId": id, "state": "error", "message": message }))
        }
        LoginState::Cancelled => json!({ "flowId": id, "state": "cancelled" }),
    }
}

impl ScmService {
    pub fn new(
        scm: Arc<Scm>,
        feeds: Arc<dyn ScopedFeeds>,
        publisher: Arc<dyn StatePublisher>,
        gate: Arc<dyn FeatureGate>,
        reviews: Arc<dyn TurnReviewApi>,
        worktrees: Arc<dyn ThreadWorktrees>,
    ) -> Arc<Self> {
        Arc::new(Self {
            login: scm.github_login(),
            scm,
            feeds,
            publisher,
            gate,
            reviews,
            worktrees,
            flows: Mutex::new(HashMap::new()),
            flow_seq: AtomicU64::new(0),
            watches: Mutex::new(HashMap::new()),
        })
    }

    pub fn scm(&self) -> &Arc<Scm> {
        &self.scm
    }

    /// The watcher saw the repository change: cached inspections go stale and the pane's
    /// `gitStatus` section is recomputed once (a change during the recompute earns one more).
    pub fn evidence(self: &Arc<Self>, repo: &RepoRef, evidence: RepoEvidence) {
        self.scm.inspector.evidence(repo, evidence);
        let Some(tree) = repo.work_tree.as_ref() else {
            return;
        };
        let watch = self
            .watches
            .lock()
            .expect("watches")
            .get(&crate::locks::path_key(tree.as_path()))
            .cloned();
        if let Some(watch) = watch {
            self.refresh_watch(watch, repo.clone());
        }
    }

    fn refresh_watch(self: &Arc<Self>, watch: Arc<GitWatch>, repo: RepoRef) {
        watch.dirty.store(true, Ordering::Release);
        if watch.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        mixdog_rt::spawn("scm-git-watch", TaskClass::Work, async move {
            loop {
                watch.dirty.store(false, Ordering::Release);
                if let Ok(scan) = this.scm.inspector.scan(this.scm.lane, repo.clone()).await {
                    let value = serde_json::to_value(&scan.json).unwrap_or(Value::Null);
                    let revision = watch.revision.fetch_add(1, Ordering::AcqRel) + 1;
                    let key = crate::inspect::status::path_text(&watch.root);
                    watch.feed.publish(
                        "git/status/updated",
                        json!({ "section": "gitStatus", "key": key, "revision": revision, "value": value }),
                        value.clone(),
                    );
                }
                if !watch.dirty.load(Ordering::Acquire) {
                    watch.running.store(false, Ordering::Release);
                    // Evidence that arrived between the check and the store.
                    if watch.dirty.load(Ordering::Acquire) && !watch.running.swap(true, Ordering::AcqRel) {
                        continue;
                    }
                    break;
                }
            }
        });
    }

    async fn git_watch(self: &Arc<Self>, cwd: PathBuf, cancel: &CancellationToken) -> Result<Reply, ScmFailure> {
        let repo = self.scm.open(&cwd, cancel).await?;
        let root = repo.root()?.to_path_buf();
        let key = crate::locks::path_key(&root);
        let existing = self.watches.lock().expect("watches").get(&key).cloned();
        let watch = match existing {
            Some(watch) => watch,
            None => {
                let status = self.scm.git_status(&root, cancel).await?;
                let id = FeedId(format!("git:{}", crate::inspect::status::path_text(&root)));
                let watch = Arc::new(GitWatch {
                    feed: FeedPublisher::create(self.feeds.as_ref(), id, status),
                    root,
                    revision: AtomicU64::new(0),
                    dirty: AtomicBool::new(false),
                    running: AtomicBool::new(false),
                });
                self.watches
                    .lock()
                    .expect("watches")
                    .entry(key)
                    .or_insert(watch)
                    .clone()
            }
        };
        Ok(Reply::Subscribe(Subscribe {
            result: json!({}),
            feed: watch.feed.source(),
            window: Window::Fixed,
            resume_from: None,
        }))
    }

    fn flow(&self, id: &LoginFlowId) -> Result<Arc<Flow>, ScmFailure> {
        self.flows
            .lock()
            .expect("flows")
            .get(id)
            .cloned()
            .ok_or_else(|| ScmFailure::refused("UNKNOWN_FLOW", "Unknown GitHub login flow."))
    }

    async fn login_start(self: &Arc<Self>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        // githubCliLoginStart: `resolveGh` first, so a machine without `gh` is refused before anything is started.
        if self.scm.gh_version(cancel).await?.is_none() {
            return Err(ScmFailure::git("GitHub CLI is not installed."));
        }
        let session: Arc<dyn LoginSession> = match self.login.start().await {
            Ok(session) => Arc::from(session),
            Err(mixdog_core_api::domain::login::LoginError::Failed(LoginFailure::Unavailable { .. })) => {
                return Err(ScmFailure::git("GitHub CLI is not installed."));
            }
            Err(error) => return Err(ScmFailure::Command { domain: GITHUB_DOMAIN, text: format!("{error:?}") }),
        };
        let id = LoginFlowId(format!(
            "ghlogin_{}_{}",
            std::process::id(),
            self.flow_seq.fetch_add(1, Ordering::Relaxed) + 1
        ));
        let initial = flow_json(&id, &session.state(), None);
        let flow = Arc::new(Flow {
            feed: FeedPublisher::create(self.feeds.as_ref(), FeedId(format!("login:{id}")), initial.clone()),
            session: session.clone(),
            device: Mutex::new(None),
        });
        {
            // One login at a time: a fresh start supersedes the earlier flows.
            let mut flows = self.flows.lock().expect("flows");
            for (_, old) in flows.drain() {
                old.session.cancel();
                old.feed.close();
            }
            flows.insert(id.clone(), flow.clone());
        }
        let watcher = flow.clone();
        let flow_id = id.clone();
        mixdog_rt::spawn("scm-login-feed", TaskClass::Work, async move {
            while let Some(state) = watcher.session.next().await {
                let value = watcher.json(&flow_id, &state);
                watcher
                    .feed
                    .publish("login/updated", json!({ "flowId": flow_id, "state": value }), value.clone());
            }
        });
        Ok(initial)
    }

    /// The turn and session reviews of a thread, answered by the turn review exactly as Node's
    /// `getTurnReviewDiff`, `getTurnReviewFilePatch`, `getTurnChanges`, `getSessionReviewDiff`
    /// and `getSessionReviewFilePatch` do. What picks the read: the scope, a `checkpointId`
    /// (`getTurnChanges`, which also takes `patch` and the file as `path`), a `path` (one file's
    /// patch, a rename's source as `oldPath`), else the review itself (`summary`, `known`).
    async fn thread_review(&self, params: ReviewDiffGetParams) -> Result<Value, CoreError> {
        let thread = params.thread_id.clone().ok_or_else(|| CoreError::InvalidParams { path: "threadId".into(), expected: "a thread id".into() })?;
        let session = thread.as_str();
        let reply = match (params.scope, params.checkpoint_id.as_deref(), params.path.as_deref()) {
            (WireReviewScope::Turn, Some(checkpoint), file) => {
                let read = ChangesRead { checkpoint_id: checkpoint.to_owned(), patch: params.patch == Some(true), file: file.map(str::to_owned) };
                self.reviews.turn_changes(session, read).await.map_err(review_error)?
            }
            (WireReviewScope::Turn, None, Some(file)) => self.reviews.turn_review_file_patch("", session, file).await,
            (WireReviewScope::Turn, None, None) => {
                let read = ReviewRead { known: params.known.clone(), summary: params.summary == Some(true) };
                self.reviews.turn_review_diff("", session, read).await
            }
            (WireReviewScope::Repo, ..) => {
                return Err(CoreError::InvalidParams { path: "scope".into(), expected: "turn or session".into() });
            }
            (WireReviewScope::Session, _, file) => {
                let worktree = self.worktrees.cwd(&thread).await?.ok_or_else(|| CoreError::InvalidParams {
                    path: "threadId".into(),
                    expected: "a thread with a working directory".into(),
                })?;
                match file {
                    Some(file) => self.reviews.session_review_file_patch(&worktree, session, file, params.old_path.as_deref().unwrap_or("")).await,
                    None => self.reviews.session_review_diff(&worktree, session).await,
                }
            }
        };
        Ok(Value::Object(reply))
    }

    /// The repository review of the phone (`scope: repo`): `gitReview`, `gitReviewDiff` or `gitReviewDiffs`, by request form. Their
    /// reads are git-history.ts's own (`phone_review`), not the pushed review's.
    async fn review_get(self: &Arc<Self>, params: ReviewDiffGetParams, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let dir = cwd(params.cwd.as_deref().unwrap_or(""))?;
        let source = params.source.as_deref().unwrap_or("branch");
        let git = &self.scm.git;
        if let Some(files) = &params.files {
            return crate::phone_review::git_review_diffs(git, cancel, &dir, files, source).await;
        }
        if let Some(path) = &params.path {
            let patch = crate::phone_review::git_review_diff(git, cancel, &dir, path, params.untracked == Some(true), source).await?;
            return Ok(Value::String(patch));
        }
        crate::phone_review::git_review(git, self.scm.lane, cancel, &dir, source).await
    }
    /// Computes the review of `thread` and publishes its summary (the `reviewDiff` section);
    /// called after a run ends and after repository evidence, so clients never poll.
    pub async fn publish_review(
        self: &Arc<Self>,
        thread: &ThreadId,
        cwd: PathBuf,
        base: ObjectId,
        cancel: &CancellationToken,
    ) -> Result<(), ScmFailure> {
        let repo = self.scm.open(&cwd, cancel).await?;
        let summary = self
            .scm
            .inspector
            .review_summary(
                self.scm.lane,
                ReviewRequest {
                    repo: repo.repo_ref()?,
                    scope: ReviewScope::Session { thread_id: thread.clone() },
                    base,
                },
            )
            .await
            .map_err(crate::mutate::scm_error)?;
        let files: Vec<Value> = summary
            .files
            .iter()
            .map(|f| json!({ "path": f.path, "status": kind_letter(f.status), "adds": f.adds, "dels": f.dels }))
            .collect();
        let value = json!({ "key": key_text(&summary.key), "summary": { "files": files } });
        self.publisher.publish(
            SectionName::ReviewDiff,
            Some(thread.as_str().to_owned()),
            SectionChange::Set(Bytes::from(serde_json::to_vec(&value).unwrap_or_default())),
        );
        Ok(())
    }

    async fn github_request(self: &Arc<Self>, project: &str, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        if !self.gate.github_enabled().await {
            return Err(ScmFailure::Refused { domain: GITHUB_DOMAIN, code: "FEATURE_DISABLED", message: GATE_OFF.into() });
        }
        // The repository the request runs in; the allowlist never sees it.
        self.scm.github.execute(input, &cwd(project)?, cancel).await
    }

    async fn handle(self: &Arc<Self>, req: &CoreRequest) -> Result<Reply, CoreError> {
        let cancel = &req.ctx.cancel;
        let scm = &self.scm;
        let method = req.method.as_str();
        macro_rules! open {
            ($p:expr) => {
                scm.open(&cwd(&$p.cwd)?, cancel).await?
            };
        }
        let value: Value = match method {
            "git/status" => { let p: p::GitStatusParams = decode(req)?; scm.git_status_counting(&cwd(&p.cwd)?, cancel, p.skip_line_stats != Some(true), p.reuse_line_stats == Some(true)).await? }
            "git/branches" => { let p: p::GitBranchesParams = decode(req)?; scm.git_branches(&cwd(&p.cwd)?, cancel).await? }
            "git/log" => { let p: p::GitLogParams = decode(req)?; scm.git_log(&cwd(&p.cwd)?, cancel, p.query.as_deref().unwrap_or(""), p.skip.unwrap_or(0), p.limit.unwrap_or(40)).await? }
            "git/show" => { let p: p::GitShowParams = decode(req)?; scm.git_show(&cwd(&p.cwd)?, cancel, &p.hash).await? }
            "git/showDiff" => { let p: p::GitShowDiffParams = decode(req)?; scm.git_show_diff(&cwd(&p.cwd)?, cancel, &p.hash, &p.path).await? }
            "git/showFile" => { let p: p::GitShowFileParams = decode(req)?; scm.git_show_file(&cwd(&p.cwd)?, cancel, &p.rev, &p.path).await? }
            "git/diff" => { let p: p::GitDiffParams = decode(req)?; scm.git_diff(&cwd(&p.cwd)?, cancel, &p.path, p.staged, p.worktree_only.unwrap_or(false), p.untracked.unwrap_or(false)).await? }
            "git/stashList" => { let p: p::GitStashListParams = decode(req)?; scm.git_stash_list(&cwd(&p.cwd)?, cancel).await? }
            "git/requestContext" => {
                let p: p::GitRequestContextParams = decode(req)?;
                scm.git_request_context(&cwd(&p.cwd)?, cancel, &p.input.paths, p.input.base.as_deref().unwrap_or("")).await?
            }
            "git/cliStatus" => scm.git_cli_status(cancel, false).await?,
            "git/globalConfig/read" => scm.git_global_config(cancel).await?,
            "git/watch" => { let p: p::GitWatchParams = decode(req)?; return Ok(self.git_watch(cwd(&p.cwd)?, cancel).await?); }
            "git/unwatch" => json!({}),
            "git/stage" => { let p: p::GitStageParams = decode(req)?; open!(p).stage(&p.paths).await?; unit() }
            "git/unstage" => { let p: p::GitUnstageParams = decode(req)?; open!(p).unstage(&p.paths).await?; unit() }
            "git/commit" => { let p: p::GitCommitParams = decode(req)?; json!(open!(p).commit(&p.message).await?) }
            "git/commitPaths" => {
                let p: p::GitCommitPathsParams = decode(req)?;
                json!(open!(p).commit_paths(&p.input.message, &p.input.paths).await?)
            }
            "git/amend" => { let p: p::GitAmendParams = decode(req)?; json!(open!(p).amend(p.message.as_deref().unwrap_or("")).await?) }
            "git/undoLastCommit" => { let p: p::GitUndoLastCommitParams = decode(req)?; json!(open!(p).undo_last_commit().await?) }
            "git/push" => { let p: p::GitPushParams = decode(req)?; json!(open!(p).push().await?) }
            "git/pull" => { let p: p::GitPullParams = decode(req)?; json!(open!(p).pull().await?) }
            "git/fetch" => { let p: p::GitFetchParams = decode(req)?; json!(open!(p).fetch().await?) }
            "git/sync" => { let p: p::GitSyncParams = decode(req)?; json!(open!(p).sync().await?) }
            "git/stash" => { let p: p::GitStashParams = decode(req)?; json!(open!(p).stash(p.message.as_deref().unwrap_or("")).await?) }
            "git/stashPop" => { let p: p::GitStashPopParams = decode(req)?; json!(open!(p).stash_pop().await?) }
            "git/stashApply" => { let p: p::GitStashApplyParams = decode(req)?; json!(open!(p).stash_apply(&string_field(&req.params, "ref")?).await?) }
            "git/stashDrop" => { let p: p::GitStashDropParams = decode(req)?; json!(open!(p).stash_drop(&string_field(&req.params, "ref")?).await?) }
            "git/createTag" => { let p: p::GitCreateTagParams = decode(req)?; json!(open!(p).create_tag(&p.value, &p.at).await?) }
            "git/deleteTag" => { let p: p::GitDeleteTagParams = decode(req)?; json!(open!(p).delete_tag(&p.value).await?) }
            "git/deleteBranch" => { let p: p::GitDeleteBranchParams = decode(req)?; json!(open!(p).delete_branch(&p.input.branch).await?) }
            "git/renameBranch" => {
                let p: p::GitRenameBranchParams = decode(req)?;
                json!(open!(p).rename_branch(&p.input.branch, &p.input.next_branch).await?)
            }
            "git/resetToCommit" => { let p: p::GitResetToCommitParams = decode(req)?; json!(open!(p).reset_to_commit(&p.value, &p.mode, p.confirmed_dirty.unwrap_or(false)).await?) }
            "git/revertCommit" => { let p: p::GitRevertCommitParams = decode(req)?; json!(open!(p).revert_commit(&p.value).await?) }
            "git/revertFile" => { let p: p::GitRevertFileParams = decode(req)?; open!(p).revert_file(&p.path, p.untracked, p.mode.as_deref().unwrap_or("all")).await?; unit() }
            "git/cherryPickCommit" => { let p: p::GitCherryPickCommitParams = decode(req)?; json!(open!(p).cherry_pick_commit(&p.value).await?) }
            "git/applyPatch" => { let p: p::GitApplyPatchParams = decode(req)?; open!(p).apply_patch(&p.path, &p.patch, p.reverse.unwrap_or(false)).await?; unit() }
            "git/ignore" => { let p: p::GitIgnoreParams = decode(req)?; open!(p).ignore(&p.path, p.scope.as_deref().unwrap_or("file")).await?; unit() }
            "git/continue" => { let p: p::GitContinueParams = decode(req)?; json!(open!(p).continue_operation().await?) }
            "git/abortOperation" => { let p: p::GitAbortOperationParams = decode(req)?; json!(open!(p).abort_operation().await?) }
            "git/globalConfig/write" => {
                let p: p::GitGlobalConfigWriteParams = decode(req)?;
                let saved = scm.git_global_config_write(cancel, &p.key, &p.value).await?;
                // Node announced `notifySettingsChanged('git')` here; the owning actor publishes its own change (DS §3).
                self.publisher.publish(
                    SectionName::HostState,
                    Some(GIT_CONFIG_KEY.to_owned()),
                    SectionChange::Set(serde_json::to_vec(&saved).expect("json").into()),
                );
                saved
            }
            "git/cli/install" => scm.git_cli_install(cancel).await?,
            "github/status" => { let p: p::GithubStatusParams = decode(req)?; scm.gh_status(cancel, p.refresh.unwrap_or(false)).await? }
            "github/account" => scm.gh_account(cancel).await?,
            "github/login/start" => self.login_start(cancel).await?,
            "github/login/status" => {
                let p: p::GithubLoginStatusParams = decode(req)?;
                { let flow = self.flow(&p.flow_id)?; flow.json(&p.flow_id, &flow.session.state()) }
            }
            // gh never opens a browser itself (no-op launcher): the client opens the device page.
            "github/login/openBrowser" => { let p: p::GithubLoginOpenBrowserParams = decode(req)?; self.flow(&p.flow_id)?; json!(false) }
            "github/login/cancel" => {
                let p: p::GithubLoginCancelParams = decode(req)?;
                if let Some(flow) = self.flows.lock().expect("flows").remove(&p.flow_id) {
                    flow.session.cancel();
                    flow.feed.close();
                }
                unit()
            }
            "github/logout" => scm.gh_logout(cancel).await?,
            "github/install" => scm.gh_install(cancel).await?,
            "github/request" => { let p: p::GithubRequestParams = decode(req)?; self.github_request(&p.cwd, &p.input, cancel).await? }
            "github/starStatus" => scm.gh_star_status(cancel).await?,
            "github/star" => scm.gh_star(cancel).await?,
            "github/pr/list" => { let p: p::GithubPrListParams = decode(req)?; scm.gh_pr_list(&cwd(&p.cwd)?, cancel).await? }
            "github/pr/view" => { let p: p::GithubPrViewParams = decode(req)?; scm.gh_pr_view(&cwd(&p.cwd)?, cancel, &p.value).await? }
            "github/pr/diff" => { let p: p::GithubPrDiffParams = decode(req)?; scm.gh_pr_diff(&cwd(&p.cwd)?, cancel, &p.value).await? }
            "github/pr/defaultBranch" => { let p: p::GithubPrDefaultBranchParams = decode(req)?; scm.gh_pr_default_branch(&cwd(&p.cwd)?, cancel).await? }
            "github/pr/create" => { let p: p::GithubPrCreateParams = decode(req)?; scm.gh_pr_create(&cwd(&p.cwd)?, cancel, &p.value).await? }
            "github/pr/checkout" => { let p: p::GithubPrCheckoutParams = decode(req)?; scm.gh_pr_checkout(&cwd(&p.cwd)?, cancel, &p.value).await? }
            "github/pr/merge" => { let p: p::GithubPrMergeParams = decode(req)?; scm.gh_pr_merge(&cwd(&p.cwd)?, cancel, &p.value, &p.method).await? }
            "review/diff/get" => {
                let p: ReviewDiffGetParams = decode(req)?;
                match p.scope {
                    WireReviewScope::Repo => self.review_get(p, cancel).await?,
                    WireReviewScope::Turn | WireReviewScope::Session => self.thread_review(p).await?,
                }
            }
            other => return Err(CoreError::InvalidParams { path: "method".into(), expected: format!("a method of git, github or review, not {other}").into() }),
        };
        Ok(Reply::Value(value))
    }
}

/// The service plus the `Arc` it needs to spawn work: register `ScmHandle` in the slots.
#[derive(Clone)]
pub struct ScmHandle(pub Arc<ScmService>);

#[async_trait]
impl DomainService for ScmHandle {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.0.handle(&req).await
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "git/status",
            "git/branches",
            "git/log",
            "git/show",
            "git/showDiff",
            "git/showFile",
            "git/diff",
            "git/stashList",
            "git/requestContext",
            "git/cliStatus",
            "git/globalConfig/read",
            "git/watch",
            "git/unwatch",
            "git/stage",
            "git/unstage",
            "git/commit",
            "git/commitPaths",
            "git/amend",
            "git/undoLastCommit",
            "git/push",
            "git/pull",
            "git/fetch",
            "git/sync",
            "git/stash",
            "git/stashPop",
            "git/stashApply",
            "git/stashDrop",
            "git/createTag",
            "git/deleteTag",
            "git/deleteBranch",
            "git/renameBranch",
            "git/resetToCommit",
            "git/revertCommit",
            "git/revertFile",
            "git/cherryPickCommit",
            "git/applyPatch",
            "git/ignore",
            "git/continue",
            "git/abortOperation",
            "git/globalConfig/write",
            "git/cli/install",
            "github/status",
            "github/account",
            "github/login/start",
            "github/login/status",
            "github/login/openBrowser",
            "github/login/cancel",
            "github/logout",
            "github/install",
            "github/request",
            "github/starStatus",
            "github/star",
            "github/pr/list",
            "github/pr/view",
            "github/pr/diff",
            "github/pr/defaultBranch",
            "github/pr/create",
            "github/pr/checkout",
            "github/pr/merge",
            "review/diff/get",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
