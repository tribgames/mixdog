//! The `DomainService` of the `git`, `github` and `review` namespaces (DS §5.1): it parses a
//! request, runs the one engine, and answers in the shapes the panes already receive. The same
//! object is registered under all three slots.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

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
use mixdog_rt::time::Instant;
use mixdog_workspace::watcher::ChangeKind as FolderChange;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::GITHUB_DOMAIN;
use crate::error::ScmFailure;
use crate::feeds::FeedPublisher;
use crate::input;
use crate::repo::admit;
use crate::repo::on_lane;

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
/// The id of a `git/watch`'s folder watch on the core's `FolderWatcher` is this prefix, the watch's number and its key
/// (`scm.git:<n>:<key>`): a watch made again after the last unwatch never shares its id with the one still being ended.
const FOLDER_WATCH_PREFIX: &str = "scm.git:";
/// `activityDebounceMs` of the desktop's git refresh schedulers (`createGitRefreshScheduler`): evidence that arrives while a watch
/// is idle is read this long after the first of it.
const RESCAN_DEBOUNCE: Duration = Duration::from_millis(125);
/// `activityMinGapMs` of the surfaces that follow a diff (`FILE_DIFF_REFRESH_OPTIONS`: the editor gutter, the diff pane): the least
/// time from the end of one rescan of a watch to the start of the next. The status surfaces that wait 3 s read the same feed.
const RESCAN_MIN_GAP: Duration = Duration::from_millis(1_000);
/// Who holds a `git/watch`: the connection that made it, or an internal caller.
type Holder = Option<ConnectionId>;

struct GitWatch {
    feed: FeedPublisher,
    root: PathBuf,
    repo: RepoRef,
    /// Its folder watch's id on the core's `FolderWatcher` (see [`FOLDER_WATCH_PREFIX`]).
    folder: String,
    revision: AtomicU64,
    dirty: AtomicBool,
    running: AtomicBool,
    /// When the last read of its status ended (the snapshot `git/watch` published, then each rescan) and how long the last
    /// one that read a status took.
    paced: Mutex<Option<(Instant, Duration)>>,
    /// The holders of `git/watch` calls not yet ended by a `git/unwatch` (`createFolderWatchRegistry`'s `count`), one entry per
    /// call, changed only under the service's `watches` lock: at least one while the watch is in the service's map, and none once
    /// its last unwatch took it out.
    holders: Mutex<Vec<Holder>>,
}

impl GitWatch {
    /// One more listener of the watch, held by `holder`.
    fn listen(self: &Arc<Self>, holder: Holder) -> Arc<Self> {
        self.holders.lock().expect("holders").push(holder);
        Arc::clone(self)
    }

    /// Its last listener unwatched it: it is out of the service's map, and its rescans stop.
    fn ended(&self) -> bool {
        self.holders.lock().expect("holders").is_empty()
    }

    /// One listener fewer: `holder`'s own, else any (Node's count is the registry's, whoever unwatches).
    fn unlisten(&self, holder: Holder) {
        let mut holders = self.holders.lock().expect("holders");
        let at = holders.iter().position(|held| *held == holder).unwrap_or(0);
        if at < holders.len() {
            holders.remove(at);
        }
    }

    /// When the next rescan may start (`createGitRefreshScheduler`'s `requiredIdleMs`): the larger of [`RESCAN_MIN_GAP`] and the
    /// last run's duration after its end, so a slow read is not run back to back.
    fn next_scan(&self) -> Option<Instant> {
        let paced = *self.paced.lock().expect("paced");
        paced.map(|(ended, took)| ended + took.max(RESCAN_MIN_GAP))
    }

    /// A read of the status that began at `started` ended. One that failed timed no work: the gap keeps the last good run's
    /// duration.
    fn scanned(&self, started: Instant, read: bool) {
        let ended = Instant::now();
        let mut paced = self.paced.lock().expect("paced");
        let took = if read { ended.saturating_duration_since(started) } else { paced.map_or(Duration::ZERO, |(_, took)| took) };
        *paced = Some((ended, took));
    }
}

/// A `git/watch` making its watch: the folder watch it registered ahead of its snapshot. Dropped, it leaves `opening`, and unless
/// the watch was made (`keep`) ends the folder watch, whether the call failed, was cancelled, or lost to another first watch.
struct Opening {
    service: Arc<ScmService>,
    folder: String,
    keep: bool,
}

impl Drop for Opening {
    fn drop(&mut self) {
        self.service.opening.lock().expect("opening").remove(&self.folder);
        if !self.keep && let Err(error) = self.service.end_follow(self.folder.clone()) {
            tracing::warn!(folder = %self.folder, "the git watch's folder watch is not ended: {error:?}");
        }
    }
}

/// The core watcher's sink for the folder watches of `git/watch`, bound to its service by [`ScmService::watch_folders`] (the
/// watcher takes its sinks before the service exists). A batch is evidence for its watch: Node's desktop folder watch
/// (`createFolderWatchRegistry`, which also follows the checkout's git dirs) raised `folder-changed`, and the pane read the
/// status again.
#[derive(Default)]
pub struct GitWatchSink(OnceLock<Weak<ScmService>>);

impl ChangeSink for GitWatchSink {
    fn changed(&self, watch_id: &str, _paths: Vec<String>, kind: FolderChange) {
        let Some((_, key)) = watch_id.strip_prefix(FOLDER_WATCH_PREFIX).and_then(|rest| rest.split_once(':')) else {
            return;
        };
        let Some(service) = self.0.get().and_then(Weak::upgrade) else {
            return;
        };
        // A batch of a folder watch still being ended is not the current watch's; one of a watch still being made (its snapshot
        // is not read yet) is kept, for the watch to read again once it is made.
        let current = service
            .watches
            .lock()
            .expect("watches")
            .get(key)
            .filter(|watch| watch.folder == watch_id)
            .map(|watch| watch.repo.clone());
        let repo = current.or_else(|| {
            service.opening.lock().expect("opening").get_mut(watch_id).map(|(repo, seen)| {
                *seen = true;
                repo.clone()
            })
        });
        let evidence = match kind {
            FolderChange::Git => RepoEvidence::GitDir,
            FolderChange::Overflow => RepoEvidence::Overflow,
            FolderChange::Modified | FolderChange::Removed | FolderChange::Renamed => RepoEvidence::WorkTree,
        };
        if let Some(repo) = repo {
            service.evidence(&repo, evidence);
        }
    }
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
    /// The number of the last `git/watch` made, in its folder watch's id.
    watch_seq: AtomicU64,
    /// The folder watches of the `git/watch` calls that are making their watch (the OS watch is registered before the snapshot is
    /// read): the repository each follows and whether a batch of it has come since.
    opening: Mutex<HashMap<String, (RepoRef, bool)>>,
    /// Where each `git/watch` follows its work tree; unbound, a watch publishes its snapshot only.
    folders: OnceLock<Arc<FolderWatcher>>,
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

/// The holder of a `git/watch` call: its connection.
fn holder_of(req: &CoreRequest) -> Holder {
    match req.ctx.caller {
        mixdog_core_api::call::Caller::Connection(connection) => Some(connection),
        mixdog_core_api::call::Caller::Internal(_) => None,
    }
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
            watch_seq: AtomicU64::new(0),
            opening: Mutex::new(HashMap::new()),
            folders: OnceLock::new(),
            stop_review_push,
        })
    }

    pub fn scm(&self) -> &Arc<Scm> {
        &self.scm
    }

    /// Binds the core's `FolderWatcher`, built with `sink` among its sinks: each `git/watch` follows its work tree there.
    pub fn watch_folders(self: &Arc<Self>, folders: Arc<FolderWatcher>, sink: &GitWatchSink) {
        let _ = sink.0.set(Arc::downgrade(self));
        let _ = self.folders.set(folders);
    }

    /// A recursive watch of the work tree, which also follows its git dirs outside it: Node's desktop `folderWatch` of the
    /// project (`createFolderWatchRegistry`). Not cancelled with the request.
    async fn follow(&self, folder: &str, root: &std::path::Path) {
        let Some(folders) = self.folders.get().cloned() else {
            return;
        };
        let (id, path) = (folder.to_owned(), root.to_path_buf());
        match on_lane(self.scm.lane, &CancellationToken::new(), move || folders.watch(&id, &path, true)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(root = %root.display(), "the git watch cannot follow the work tree: {}", error.message),
            Err(error) => tracing::warn!(root = %root.display(), "the git watch cannot follow the work tree: {error}"),
        }
    }

    /// Ends the folder watch `folder` on the lane, as `follow` opened it, with a token no cancel reaches. Not waited for: the job
    /// runs whether or not its handle is kept.
    fn end_follow(&self, folder: String) -> Result<Option<mixdog_rt::JobHandle<()>>, ScmFailure> {
        let Some(folders) = self.folders.get().cloned() else {
            return Ok(None);
        };
        admit(self.scm.lane, &CancellationToken::new(), move || folders.unwatch(&folder)).map(Some)
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
            // The first evidence of an idle watch waits out the debounce; evidence that came during a read is read at once (the
            // scheduler's `scheduleActivity(0)`). Both wait out the gap.
            let mut debounce = RESCAN_DEBOUNCE;
            loop {
                let due = Instant::now() + debounce;
                let due = watch.next_scan().map_or(due, |gap| gap.max(due));
                if due > Instant::now() {
                    mixdog_rt::time::sleep_until(due).await;
                }
                debounce = Duration::ZERO;
                // A watch whose last listener left during the wait reads nothing more: its feed is closed.
                if watch.ended() {
                    watch.running.store(false, Ordering::Release);
                    break;
                }
                // Evidence that came during the wait is read by this scan.
                watch.dirty.store(false, Ordering::Release);
                let started = Instant::now();
                let scanned = this.scm.inspector.scan(this.scm.lane, repo.clone()).await;
                watch.scanned(started, scanned.is_ok());
                if let Ok(scan) = scanned {
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

    async fn git_watch(self: &Arc<Self>, cwd: PathBuf, holder: Holder, cancel: &CancellationToken) -> Result<Reply, ScmFailure> {
        let repo = self.scm.open(&cwd, cancel).await?;
        let root = repo.root()?.to_path_buf();
        let key = crate::locks::path_key(&root);
        let existing = self.watches.lock().expect("watches").get(&key).map(|watch| watch.listen(holder));
        let watch = match existing {
            Some(watch) => watch,
            None => {
                let reference = repo.repo_ref()?;
                let number = self.watch_seq.fetch_add(1, Ordering::Relaxed) + 1;
                let folder = format!("{FOLDER_WATCH_PREFIX}{number}:{key}");
                // The OS watch is registered before the snapshot is read, so a change between the two is a batch of the watch (kept
                // in `opening` until the watch exists) and not lost. A request cancelled or failed from here on ends the OS watch.
                self.opening.lock().expect("opening").insert(folder.clone(), (reference.clone(), false));
                let mut opening = Opening { service: Arc::clone(self), folder: folder.clone(), keep: false };
                self.follow(&folder, &root).await;
                let read = Instant::now();
                let status = self.scm.git_status(&root, cancel).await?;
                let id = FeedId(format!("git:{}", crate::inspect::status::path_text(&root)));
                let created = Arc::new(GitWatch {
                    feed: FeedPublisher::create(self.feeds.as_ref(), id, status),
                    repo: reference.clone(),
                    folder,
                    root,
                    revision: AtomicU64::new(0),
                    dirty: AtomicBool::new(false),
                    running: AtomicBool::new(false),
                    paced: Mutex::new(None),
                    holders: Mutex::new(Vec::new()),
                });
                // The snapshot is the watch's first read (the scheduler's run on `resume`): evidence right after it waits out
                // the gap too.
                created.scanned(read, true);
                let watch = self.watches.lock().expect("watches").entry(key).or_insert_with(|| created.clone()).listen(holder);
                // A concurrent first watch of the same work tree that got in first already follows it: this one's OS watch ends
                // with `opening`.
                if Arc::ptr_eq(&watch, &created) {
                    opening.keep = true;
                    let seen = self.opening.lock().expect("opening").get(&watch.folder).is_some_and(|(_, seen)| *seen);
                    if seen {
                        self.refresh_watch(Arc::clone(&watch), reference);
                    }
                }
                watch
            }
        };
        Ok(Reply::Subscribe(Subscribe {
            result: json!({}),
            feed: watch.feed.source(),
            window: Window::Fixed,
            resume_from: None,
        }))
    }

    /// Ends one `git/watch` of the work tree holding `cwd` (`createFolderWatchRegistry`'s `unwatch`): the last one ends the
    /// folder watch and the feed, whose subscriptions end with it. A work tree nobody watches is left as it is.
    async fn git_unwatch(&self, cwd: PathBuf, holder: Holder, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let repo = match self.scm.open(&cwd, cancel).await {
            Err(ScmFailure::NotARepository) => return Ok(()),
            repo => repo?,
        };
        let key = crate::locks::path_key(repo.root()?);
        if let Some(unfollow) = self.release(&key, holder)? {
            // Dropped unrun only by a lane that shut down, with the folder watcher.
            let _ = unfollow.await;
        }
        Ok(())
    }

    /// One listener of the watch at `key` fewer, held by `holder` (else any). The last one ends the folder watch on the lane
    /// ([`Self::end_follow`]), which is admitted before the watch's record goes (as `fs/unwatch` does): a lane that refuses it
    /// leaves the watch whole, so the OS watch never outlives its record. The job to wait for, if it was the last.
    fn release(&self, key: &str, holder: Holder) -> Result<Option<mixdog_rt::JobHandle<()>>, ScmFailure> {
        let (watch, unfollow) = {
            let mut watches = self.watches.lock().expect("watches");
            let Some(watch) = watches.get(key).cloned() else { return Ok(None) };
            if watch.holders.lock().expect("holders").len() > 1 {
                watch.unlisten(holder);
                return Ok(None);
            }
            let unfollow = self.end_follow(watch.folder.clone())?;
            watch.unlisten(holder);
            watches.remove(key);
            (watch, unfollow)
        };
        watch.feed.close();
        Ok(unfollow)
    }

    /// A connection closed: the `git/watch` calls it made and did not end with a `git/unwatch` end (Node's windows leave no watch
    /// of theirs behind). The OS watch of the last of them ends on the lane, as it would on the unwatch.
    pub fn connection_closed(&self, connection: ConnectionId) {
        let held: Vec<(String, usize)> = self
            .watches
            .lock()
            .expect("watches")
            .iter()
            .map(|(key, watch)| (key.clone(), watch.holders.lock().expect("holders").iter().filter(|held| **held == Some(connection)).count()))
            .filter(|(_, count)| *count > 0)
            .collect();
        for (key, count) in held {
            for _ in 0..count {
                if let Err(error) = self.release(&key, Some(connection)) {
                    tracing::warn!(%key, "a closed connection's git watch is not ended: {error:?}");
                    break;
                }
            }
        }
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
                // No such thread, as the turn scope answers one (Node's session read: `session <id> is not available`).
                let worktree = self.worktrees.cwd(&thread).await?.ok_or_else(|| CoreError::ThreadNotFound { thread_id: thread.clone() })?;
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
            "git/watch" => { let p: p::GitWatchParams = decode(req)?; return Ok(self.git_watch(cwd(&p.cwd)?, holder_of(req), cancel).await?); }
            "git/unwatch" => {
                let p: p::GitUnwatchParams = decode(req)?;
                self.git_unwatch(cwd(&p.cwd)?, holder_of(req), cancel).await?;
                json!({})
            }
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

#[cfg(test)]
mod watch_tests {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;

    use super::*;

    fn watch() -> Arc<GitWatch> {
        let root = std::env::temp_dir();
        Arc::new(GitWatch {
            feed: FeedPublisher::create(&MockScopedFeeds::new(MockLimits::default()), FeedId("git:test".into()), json!({})),
            repo: RepoRef { common_dir: AbsPath::new(root.clone()).expect("absolute"), work_tree: AbsPath::new(root.clone()) },
            folder: "scm.git:1:test".into(),
            root,
            revision: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            running: AtomicBool::new(false),
            paced: Mutex::new(None),
            holders: Mutex::new(Vec::new()),
        })
    }

    #[test]
    fn a_rescan_waits_one_second_after_the_last_read_and_longer_after_a_slow_one() {
        assert_eq!(RESCAN_DEBOUNCE, Duration::from_millis(125));
        let watch = watch();
        assert_eq!(watch.next_scan(), None);
        let started = Instant::now();
        watch.scanned(started, true);
        let due = watch.next_scan().expect("a read was timed");
        assert!(due - Instant::now() <= RESCAN_MIN_GAP && RESCAN_MIN_GAP == Duration::from_secs(1));
        watch.scanned(started - Duration::from_secs(4), true);
        assert!(watch.next_scan().expect("timed") > Instant::now() + Duration::from_secs(3), "a 4 s read is not repeated back to back");
    }

    #[test]
    fn a_watch_ends_with_its_last_holder_whoever_unwatches() {
        let watch = watch();
        let (one, two) = (Some(ConnectionId(1)), Some(ConnectionId(2)));
        assert!(watch.ended());
        watch.listen(one);
        watch.listen(one);
        watch.listen(two);
        watch.unlisten(two);
        assert_eq!(*watch.holders.lock().unwrap(), vec![one, one]);
        watch.unlisten(two);
        assert_eq!(*watch.holders.lock().unwrap(), vec![one], "an unwatch by another connection still counts, as Node's count does");
        watch.unlisten(one);
        assert!(watch.ended());
    }
}
