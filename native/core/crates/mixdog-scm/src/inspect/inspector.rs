//! `RepoInspector` (RL §10.2): one cell per repository, reads without the repo lock,
//! single-flighted and cached by `(HEAD oid, index checksum, worktree token)`. The token is the
//! generation of the change evidence the watcher delivered, so a result stays valid until
//! evidence arrives (or HEAD / the index move) and nothing polls.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::repo::Cached;
use mixdog_core_api::domain::repo::InspectorKey;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::RepoEvidence;
use mixdog_core_api::domain::repo::RepoInspector;
use mixdog_core_api::domain::repo::RepoRef;
use mixdog_core_api::domain::repo::RepoStatus;
use mixdog_core_api::domain::repo::ReviewPage;
use mixdog_core_api::domain::repo::ReviewRequest;
use mixdog_core_api::domain::repo::ReviewSummary;
use mixdog_core_api::domain::repo::ScmError;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::TaskClass;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::Git;
use crate::inspect::review;
use crate::inspect::review::ReviewEntry;
use crate::inspect::status::StatusScan;
use crate::inspect::status::scan;
use crate::repo;
use crate::repo::RepoIdentity;
use crate::repo::on_lane;

type Outcome<T> = Result<Arc<T>, ScmError>;

/// A computation shared by every caller that asks while it runs, and its result afterwards.
enum Slot<T> {
    Running(watch::Receiver<Option<Outcome<T>>>),
    Ready(Arc<T>),
}

impl<T> Clone for Slot<T> {
    fn clone(&self) -> Self {
        match self {
            Slot::Running(receiver) => Slot::Running(receiver.clone()),
            Slot::Ready(value) => Slot::Ready(value.clone()),
        }
    }
}

impl<T> Slot<T> {
    async fn wait(self) -> Outcome<T> {
        match self {
            Slot::Ready(value) => Ok(value),
            Slot::Running(mut receiver) => {
                let settled = receiver.wait_for(Option::is_some).await;
                match settled {
                    Ok(value) => value.clone().expect("wait_for returned a settled value"),
                    Err(_) => Err(ScmError::Corrupt {
                        detail: "inspection task ended without a result".into(),
                    }),
                }
            }
        }
    }
}

type Sender<T> = watch::Sender<Option<Outcome<T>>>;
type StatusCell = Arc<Mutex<Option<(InspectorKey, Slot<StatusScan>)>>>;

/// The slot of `key`: the running or finished one, or a new running one whose sender the
/// caller must resolve. Check and claim are one critical section, so concurrent callers of
/// one key start one computation.
fn claim_status(
    cell: &StatusCell,
    key: &InspectorKey,
) -> (Slot<StatusScan>, Option<Sender<StatusScan>>) {
    let mut guard = cell.lock().expect("status lock");
    if let Some((cached, slot)) = guard.as_ref() {
        if cached == key {
            return (slot.clone(), None);
        }
    }
    let (sender, receiver) = watch::channel(None);
    let slot = Slot::Running(receiver);
    *guard = Some((key.clone(), slot.clone()));
    (slot, Some(sender))
}

/// Runs `compute` detached from its callers: a caller that stops waiting does not cancel the
/// work the others share. A success becomes the cell's ready value; a failure clears it so the
/// next call retries.
fn run_status<F>(cell: StatusCell, key: InspectorKey, sender: Sender<StatusScan>, compute: F)
where
    F: Future<Output = Result<StatusScan, ScmFailure>> + Send + 'static,
{
    mixdog_rt::spawn("scm-inspect", TaskClass::Work, async move {
        let outcome = compute.await.map(Arc::new).map_err(ScmError::from);
        {
            let mut guard = cell.lock().expect("status lock");
            if guard.as_ref().is_some_and(|(current, _)| *current == key) {
                *guard = match &outcome {
                    Ok(value) => Some((key, Slot::Ready(value.clone()))),
                    Err(_) => None,
                };
            }
        }
        let _ = sender.send(Some(outcome));
    });
}

struct RepoCell {
    identity: Mutex<Option<RepoIdentity>>,
    generation: AtomicU64,
    id: String,
    status: StatusCell,
}

const REVIEW_ENTRIES: usize = 32;

/// Review results by their key, oldest first out.
#[derive(Default)]
struct Reviews {
    slots: HashMap<InspectorKey, Slot<ReviewEntry>>,
    order: VecDeque<InspectorKey>,
}

pub struct GitInspector {
    git: Git,
    cells: Mutex<HashMap<RepoRef, Arc<RepoCell>>>,
    reviews: Arc<Mutex<Reviews>>,
    flights: AtomicU64,
    /// Where a review builds the scratch index of the work tree's current tree.
    scratch: std::path::PathBuf,
}

impl GitInspector {
    pub fn new(git: Git, scratch: std::path::PathBuf) -> Self {
        Self {
            scratch,
            git,
            cells: Mutex::new(HashMap::new()),
            reviews: Arc::new(Mutex::new(Reviews::default())),
            flights: AtomicU64::new(0),
        }
    }

    /// How many inspections were started; two callers sharing one flight count once.
    pub fn flights_started(&self) -> u64 {
        self.flights.load(Ordering::Relaxed)
    }

    pub fn git(&self) -> &Git {
        &self.git
    }

    fn cell(&self, repo: &RepoRef) -> Arc<RepoCell> {
        let mut cells = self.cells.lock().expect("cells lock");
        cells
            .entry(repo.clone())
            .or_insert_with(|| {
                let mut hasher = Sha256::new();
                hasher.update(repo.common_dir.as_path().to_string_lossy().as_bytes());
                if let Some(tree) = &repo.work_tree {
                    hasher.update(b"\0");
                    hasher.update(tree.as_path().to_string_lossy().as_bytes());
                }
                let id = repo::hex(&hasher.finalize()[..8]);
                Arc::new(RepoCell {
                    identity: Mutex::new(None),
                    generation: AtomicU64::new(0),
                    id,
                    status: Arc::new(Mutex::new(None)),
                })
            })
            .clone()
    }

    async fn identity(
        &self,
        lane: MaintenanceIo,
        cell: &RepoCell,
        repo: &RepoRef,
    ) -> Result<RepoIdentity, ScmFailure> {
        if let Some(identity) = cell.identity.lock().expect("identity lock").clone() {
            return Ok(identity);
        }
        let start = repo
            .work_tree
            .as_ref()
            .unwrap_or(&repo.common_dir)
            .as_path()
            .to_path_buf();
        let found = on_lane(lane, &CancellationToken::new(), move || repo::discover(&start)).await??;
        *cell.identity.lock().expect("identity lock") = Some(found.clone());
        Ok(found)
    }

    async fn current_key(
        &self,
        lane: MaintenanceIo,
        cell: &RepoCell,
        identity: &RepoIdentity,
    ) -> Result<InspectorKey, ScmFailure> {
        let identity = identity.clone();
        let generation = cell.generation.load(Ordering::Acquire);
        let id = cell.id.clone();
        let mut key = on_lane(lane, &CancellationToken::new(), move || {
            repo::key(&identity, generation)
        })
        .await??;
        key.worktree_token = format!("{id}.{}", key.worktree_token);
        Ok(key)
    }

    /// The scan behind both the desktop `GitStatusResult` and the inspector's `RepoStatus`.
    pub async fn scan(
        &self,
        lane: MaintenanceIo,
        repo: RepoRef,
    ) -> Result<Arc<StatusScan>, ScmError> {
        let cell = self.cell(&repo);
        let identity = self.identity(lane, &cell, &repo).await.map_err(ScmError::from)?;
        let key = self
            .current_key(lane, &cell, &identity)
            .await
            .map_err(ScmError::from)?;
        let (slot, sender) = claim_status(&cell.status, &key);
        if let Some(sender) = sender {
            self.flights.fetch_add(1, Ordering::Relaxed);
            let git = self.git.clone();
            let head = key.head.clone();
            run_status(cell.status.clone(), key, sender, async move {
                scan(&git, lane, &CancellationToken::new(), &identity, head, true).await
            });
        }
        slot.wait().await
    }

    /// The scan without add/delete counts: never shared with, or kept for, the counted scan.
    pub async fn scan_without_line_stats(
        &self,
        lane: MaintenanceIo,
        repo: RepoRef,
    ) -> Result<Arc<StatusScan>, ScmError> {
        let cell = self.cell(&repo);
        let identity = self.identity(lane, &cell, &repo).await.map_err(ScmError::from)?;
        let key = self
            .current_key(lane, &cell, &identity)
            .await
            .map_err(ScmError::from)?;
        let scanned = scan(&self.git, lane, &CancellationToken::new(), &identity, key.head, false)
            .await
            .map_err(ScmError::from)?;
        Ok(Arc::new(scanned))
    }

    fn review_slot(&self, key: &InspectorKey) -> Option<Slot<ReviewEntry>> {
        self.reviews.lock().expect("reviews lock").slots.get(key).cloned()
    }

    /// The slot of review `key`, claiming it when absent (check and claim in one section).
    fn claim_review(
        &self,
        key: &InspectorKey,
    ) -> (Slot<ReviewEntry>, Option<Sender<ReviewEntry>>) {
        let mut guard = self.reviews.lock().expect("reviews lock");
        if let Some(slot) = guard.slots.get(key) {
            return (slot.clone(), None);
        }
        let (sender, receiver) = watch::channel(None);
        let slot = Slot::Running(receiver);
        guard.slots.insert(key.clone(), slot.clone());
        guard.order.push_back(key.clone());
        while guard.order.len() > REVIEW_ENTRIES {
            if let Some(oldest) = guard.order.pop_front() {
                guard.slots.remove(&oldest);
            }
        }
        (slot, Some(sender))
    }

    fn review_key(status_key: &InspectorKey, base: &ObjectId) -> InspectorKey {
        let mut key = status_key.clone();
        key.worktree_token = format!("{}@{}", key.worktree_token, base.0);
        key
    }
}

fn abs(path: &std::path::Path) -> Option<AbsPath> {
    AbsPath::new(path)
}

/// The `RepoRef` of the repository containing `cwd`.
pub fn repo_ref(identity: &RepoIdentity) -> Result<RepoRef, ScmFailure> {
    Ok(RepoRef {
        common_dir: abs(&identity.common_dir)
            .ok_or_else(|| ScmFailure::invalid("commonDir", "an absolute path"))?,
        work_tree: identity.work_tree.as_deref().and_then(abs),
    })
}

fn project_status(scan: &StatusScan, key: InspectorKey) -> RepoStatus {
    RepoStatus {
        key,
        branch: scan.branch.clone(),
        head: scan.head.clone(),
        upstream: scan.upstream.clone(),
        operation: scan.operation,
        entries: scan.entries.clone(),
    }
}

#[async_trait]
impl RepoInspector for GitInspector {
    async fn key(&self, lane: MaintenanceIo, repo: RepoRef) -> Result<InspectorKey, ScmError> {
        let cell = self.cell(&repo);
        let identity = self.identity(lane, &cell, &repo).await?;
        Ok(self.current_key(lane, &cell, &identity).await?)
    }

    async fn status(
        &self,
        lane: MaintenanceIo,
        repo: RepoRef,
    ) -> Result<Arc<RepoStatus>, ScmError> {
        let key = self.key(lane, repo.clone()).await?;
        let scan = self.scan(lane, repo).await?;
        Ok(Arc::new(project_status(&scan, key)))
    }

    async fn review_summary(
        &self,
        lane: MaintenanceIo,
        request: ReviewRequest,
    ) -> Result<Arc<ReviewSummary>, ScmError> {
        let status_key = self.key(lane, request.repo.clone()).await?;
        let key = Self::review_key(&status_key, &request.base);
        let cell = self.cell(&request.repo);
        let identity = self.identity(lane, &cell, &request.repo).await?;
        let (slot, sender) = self.claim_review(&key);
        if let Some(sender) = sender {
            self.flights.fetch_add(1, Ordering::Relaxed);
            let git = self.git.clone();
            let base = request.base.clone();
            let compute_key = key.clone();
            let reviews = self.reviews.clone();
            let scratch = self.scratch.clone();
            mixdog_rt::spawn("scm-review", TaskClass::Work, async move {
                let outcome = review::compute(
                    &git,
                    lane,
                    &CancellationToken::new(),
                    &identity,
                    compute_key.clone(),
                    &base,
                    &scratch,
                )
                .await
                .map(Arc::new)
                .map_err(ScmError::from);
                {
                    let mut guard = reviews.lock().expect("reviews lock");
                    match &outcome {
                        Ok(entry) => {
                            if guard.slots.contains_key(&compute_key) {
                                guard.slots.insert(compute_key, Slot::Ready(entry.clone()));
                            }
                        }
                        Err(_) => {
                            guard.slots.remove(&compute_key);
                            guard.order.retain(|queued| *queued != compute_key);
                        }
                    }
                }
                let _ = sender.send(Some(outcome));
            });
        }
        let entry = slot.wait().await?;
        Ok(Arc::new(entry.summary.clone()))
    }

    fn review_page(
        &self,
        key: &InspectorKey,
        path: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Cached<ReviewPage>, ScmError> {
        match self.review_slot(key) {
            Some(Slot::Ready(entry)) => Ok(Cached::Ready(entry.page(path, cursor))),
            _ => Ok(Cached::Pending { key: key.clone() }),
        }
    }

    async fn resolve_refs(
        &self,
        lane: MaintenanceIo,
        repo: RepoRef,
        refs: Vec<String>,
    ) -> Result<Vec<Option<ObjectId>>, ScmError> {
        let cell = self.cell(&repo);
        let identity = self.identity(lane, &cell, &repo).await?;
        Ok(on_lane(lane, &CancellationToken::new(), move || {
            repo::resolve_refs(&identity, &refs)
        })
        .await??)
    }

    fn evidence(&self, repo: &RepoRef, _evidence: RepoEvidence) {
        // Every kind marks the cached results stale; `Overflow` and the others differ only in
        // how much the watcher knows, not in what the inspector must do.
        self.cell(repo).generation.fetch_add(1, Ordering::AcqRel);
    }
}
