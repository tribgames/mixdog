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
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::ReviewUnsubscribe;
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
use crate::input;

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
/// The body of the `reviewDiff` publication, the app-wide tell to read the review again: Node's `turn-review-changed` carries no
/// data, and the windows read nothing from it.
pub const REVIEW_REREAD: &[u8] = b"{}";
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
    /// The review listener's unsubscribe: the service's `stopTurnReviewPush`.
    stop_review_push: ReviewUnsubscribe,
}

impl Drop for ScmService {
    fn drop(&mut self) {
        let _ = (self.stop_review_push)();
    }
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

/// `requiredRepositoryCwd` of the desktop's own `git/watch`.
fn cwd(value: &str) -> Result<PathBuf, ScmFailure> {
    input::repository_cwd(Some(&Value::String(value.to_owned()))).map(PathBuf::from)
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
        // Node's one `onTurnReviewChanged` consumer forwards the signal as the data-less global `turn-review-changed` event
        // (`desktop-service.ts:1058`), which every window answers by rereading the review of each session it shows
        // (`use-turn-review-reads.ts`). The same tell is one app-wide `reviewDiff` revision, whatever the windows show.
        let review_publisher = Arc::clone(&publisher);
        let stop_review_push = reviews.on_review_changed(Arc::new(move || {
            review_publisher.publish(SectionName::ReviewDiff, None, SectionChange::Set(Bytes::from_static(REVIEW_REREAD)));
        }));
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
            stop_review_push,
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
        // The file of a thread's review is a string (the repository review's raw arguments share this field).
        let file = match &params.path {
            None | Some(Value::Null) => None,
            Some(Value::String(file)) => Some(file.as_str()),
            Some(_) => return Err(CoreError::InvalidParams { path: "path".into(), expected: "a string".into() }),
        };
        let reply = match (params.scope, params.checkpoint_id.as_deref(), file) {
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
    async fn review_get(self: &Arc<Self>, checked: input::NodeArgs, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let (git, dir) = (&self.scm.git, checked.dir());
        match checked.operation {
            "gitReviewDiffs" => {
                let files = checked.args[1].as_array().cloned().unwrap_or_default();
                crate::phone_review::git_review_diffs(git, cancel, &dir, &files, checked.text(2)).await
            }
            "gitReviewDiff" => {
                let patch = crate::phone_review::git_review_diff(git, cancel, &dir, checked.text(1), checked.flag(2), checked.text(3)).await?;
                Ok(Value::String(patch))
            }
            _ => crate::phone_review::git_review(git, self.scm.lane, cancel, &dir, checked.text(1)).await,
        }
    }

    /// `githubRequest`, its directory and request already checked (`input::node_args`), as Node's host checked them before its
    /// operation's gate (remote-methods.ts:567-568, then github-service.ts:21-25).
    async fn github_request(self: &Arc<Self>, project: &std::path::Path, input: &Value, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        if !self.gate.github_enabled().await {
            return Err(ScmFailure::Refused { domain: GITHUB_DOMAIN, code: "FEATURE_DISABLED", message: GATE_OFF.into() });
        }
        // The repository the request runs in; the allowlist never sees it.
        self.scm.github.execute(input, project, cancel).await
    }

    async fn handle(self: &Arc<Self>, req: &CoreRequest) -> Result<Reply, CoreError> {
        let cancel = &req.ctx.cancel;
        let scm = &self.scm;
        let method = req.method.as_str();
        // Every argument of a phone's call is checked as Node's host checked it (`input`), in the order of the call's list and
        // before any git runs; what the call acts on is what those checks gave back.
        let checked = input::node_args(method, &req.params).transpose()?;
        macro_rules! a {
            () => {
                checked.as_ref().expect("every method below is one of the phone's calls")
            };
        }
        // The repository at the checked directory.
        macro_rules! at {
            () => {
                scm.open(&a!().dir(), cancel).await?
            };
        }
        macro_rules! in_place {
            () => {
                scm.open_or_in_place(&a!().dir(), cancel).await?
            };
        }
        let value: Value = match method {
            "git/status" => {
                let options = &a!().args[1];
                scm.git_status_counting(&a!().dir(), cancel, options["skipLineStats"] != Value::Bool(true), options["reuseLineStats"] == Value::Bool(true)).await?
            }
            "git/branches" => scm.git_branches(&a!().dir(), cancel).await?,
            "git/log" => scm.git_log(&a!().dir(), cancel, a!().text(1), a!().number(2), a!().number(3)).await?,
            "git/show" => scm.git_show(&a!().dir(), cancel, a!().text(1)).await?,
            "git/showDiff" => scm.git_show_diff(&a!().dir(), cancel, a!().text(1), a!().text(2)).await?,
            "git/showFile" => scm.git_show_file(&a!().dir(), cancel, a!().text(1), a!().text(2)).await?,
            "git/diff" => scm.git_diff(&a!().dir(), cancel, a!().text(1), a!().flag(2), a!().flag(3), a!().flag(4)).await?,
            "git/stashList" => scm.git_stash_list(&a!().dir(), cancel).await?,
            "git/requestContext" => {
                let input = &a!().args[1];
                let paths: Vec<String> = input["paths"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                scm.git_request_context(&a!().dir(), cancel, &paths, input["base"].as_str().unwrap_or_default()).await?
            }
            "git/cliStatus" => scm.git_cli_status(cancel, false).await?,
            "git/globalConfig/read" => scm.git_global_config(cancel).await?,
            "git/watch" => { let p: p::GitWatchParams = decode(req)?; return Ok(self.git_watch(cwd(&p.cwd)?, cancel).await?); }
            "git/unwatch" => json!({}),
            "git/stage" => { at!().stage(&a!().texts(1)).await?; unit() }
            "git/unstage" => { at!().unstage(&a!().texts(1)).await?; unit() }
            "git/commit" => json!(at!().commit(a!().text(1)).await?),
            "git/commitPaths" => json!(at!().commit_paths(a!().text(1), &a!().texts(2)).await?),
            "git/amend" => json!(at!().amend(a!().text(1)).await?),
            "git/undoLastCommit" => json!(in_place!().undo_last_commit().await?),
            "git/push" => json!(at!().push().await?),
            "git/pull" => json!(at!().pull().await?),
            "git/fetch" => json!(in_place!().fetch().await?),
            "git/sync" => json!(at!().sync().await?),
            "git/stash" => json!(in_place!().stash(a!().text(1)).await?),
            "git/stashPop" => json!(at!().stash_pop().await?),
            "git/stashApply" => json!(at!().stash_apply(a!().text(1)).await?),
            "git/stashDrop" => json!(at!().stash_drop(a!().text(1)).await?),
            "git/createTag" => json!(at!().create_tag(a!().text(1), a!().text(2)).await?),
            "git/deleteTag" => json!(at!().delete_tag(a!().text(1)).await?),
            "git/deleteBranch" => json!(at!().delete_branch(a!().text(1)).await?),
            "git/renameBranch" => json!(at!().rename_branch(a!().text(1), a!().text(2)).await?),
            "git/resetToCommit" => {
                let (place, hash, mode) = (a!().dir(), a!().text(1), a!().text(2));
                match scm.open(&place, cancel).await {
                    Err(ScmFailure::NotARepository) => return Err(scm.commit_lookup_outside_repository(&place, cancel, Some(mode), hash).await.into()),
                    repo => json!(repo?.reset_to_commit(hash, mode, a!().flag(3)).await?),
                }
            }
            "git/revertCommit" => json!(at!().revert_commit(a!().text(1)).await?),
            "git/revertFile" => { at!().revert_file(a!().text(1), a!().flag(2), a!().text(3)).await?; unit() }
            "git/cherryPickCommit" => {
                let (place, hash) = (a!().dir(), a!().text(1));
                match scm.open(&place, cancel).await {
                    Err(ScmFailure::NotARepository) => return Err(scm.commit_lookup_outside_repository(&place, cancel, None, hash).await.into()),
                    repo => json!(repo?.cherry_pick_commit(hash).await?),
                }
            }
            "git/applyPatch" => { at!().apply_patch(a!().text(1), a!().text(2), a!().flag(3)).await?; unit() }
            "git/ignore" => { at!().ignore(a!().text(1), a!().text(2)).await?; unit() }
            "git/continue" => json!(at!().continue_operation().await?),
            "git/abortOperation" => json!(at!().abort_operation().await?),
            "git/globalConfig/write" => {
                let saved = scm.git_global_config_write(cancel, a!().text(0), a!().text(1)).await?;
                // Node announced `notifySettingsChanged('git')` here; the owning actor publishes its own change (DS §3).
                self.publisher.publish(
                    SectionName::HostState,
                    Some(GIT_CONFIG_KEY.to_owned()),
                    SectionChange::Set(serde_json::to_vec(&saved).expect("json").into()),
                );
                saved
            }
            "git/cli/install" => scm.git_cli_install(cancel).await?,
            // Node's phone call took no arguments (remote-methods.ts:562): a refresh is the desktop's.
            "github/status" => scm.gh_status(cancel, req.ctx.origin != mixdog_protocol::Origin::Relay && req.params.get("refresh") == Some(&Value::Bool(true))).await?,
            "github/account" => scm.gh_account(cancel).await?,
            "github/login/start" => self.login_start(cancel).await?,
            "github/login/status" => {
                let id = LoginFlowId(a!().text(0).to_owned());
                let flow = self.flow(&id)?;
                flow.json(&id, &flow.session.state())
            }
            // gh never opens a browser itself (no-op launcher): the client opens the device page.
            "github/login/openBrowser" => { self.flow(&LoginFlowId(a!().text(0).to_owned()))?; json!(false) }
            "github/login/cancel" => {
                if let Some(flow) = self.flows.lock().expect("flows").remove(&LoginFlowId(a!().text(0).to_owned())) {
                    flow.session.cancel();
                    flow.feed.close();
                }
                unit()
            }
            "github/logout" => scm.gh_logout(cancel).await?,
            "github/install" => scm.gh_install(cancel).await?,
            "github/request" => self.github_request(&a!().dir(), &a!().args[1], cancel).await?,
            "github/starStatus" => scm.gh_star_status(cancel).await?,
            "github/star" => scm.gh_star(cancel).await?,
            "github/pr/list" => scm.gh_pr_list(&a!().dir(), cancel).await?,
            "github/pr/view" => scm.gh_pr_view(&a!().dir(), cancel, &a!().args[1]).await?,
            "github/pr/diff" => scm.gh_pr_diff(&a!().dir(), cancel, &a!().args[1]).await?,
            "github/pr/defaultBranch" => scm.gh_pr_default_branch(&a!().dir(), cancel).await?,
            "github/pr/create" => scm.gh_pr_create(&a!().dir(), cancel, &a!().args[1]).await?,
            "github/pr/checkout" => scm.gh_pr_checkout(&a!().dir(), cancel, &a!().args[1]).await?,
            "github/pr/merge" => scm.gh_pr_merge(&a!().dir(), cancel, &a!().args[1], &a!().args[2]).await?,
            "review/diff/get" => match checked {
                Some(checked) => self.review_get(checked, cancel).await?,
                None => self.thread_review(decode(req)?).await?,
            },
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
