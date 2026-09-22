// Inventory enumeration: the parallel walk that fills a live file list,
// its error accounting, and the incremental repair/merge helpers used
// when only a few paths changed.
use super::*;

pub(super) fn publish_live_files(live: &LiveWalk, files: &[PathBuf]) {
    if files.is_empty() {
        return;
    }
    lock_recover(&live.files).extend(files.iter().map(|path| PathBuf::from(wire_path(path))));
    live.files_cond.notify_all();
}

pub(super) fn inventory_parallelism() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    std::env::var("MIXDOG_SEARCH_INVENTORY_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(1, 2))
        .clamp(1, 8)
}

pub(super) fn inventory_publish_batch() -> usize {
    std::env::var("MIXDOG_SEARCH_INVENTORY_PUBLISH_BATCH")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(256)
        .clamp(128, 512)
}

pub(super) fn inventory_pool() -> &'static ThreadPool {
    static POOL: OnceLock<ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        ThreadPoolBuilder::new()
            .num_threads(inventory_parallelism())
            .thread_name(|index| format!("mixdog-search-inventory-{index}"))
            .build()
            .expect("mixdog inventory worker pool")
    })
}

pub(super) fn inventory_walk_threads(operand: &Path) -> usize {
    // Drive walks have enough independent directories to benefit from more
    // I/O workers. Keep ordinary project walks small and both paths bounded.
    let maximum = if is_filesystem_root(operand) { 12 } else { 4 };
    std::env::var("MIXDOG_SEARCH_INVENTORY_THREADS")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|threads| *threads > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
        })
        .clamp(2, maximum)
}

pub(super) struct WorkerWalkBatch<'a> {
    pub(super) live: &'a LiveWalk,
    pub(super) files: Vec<PathBuf>,
    pub(super) capacity: usize,
    pub(super) last_flush: Option<Instant>,
}

#[derive(Clone)]
pub(super) struct DirectoryFailure {
    pub(super) path: PathBuf,
    pub(super) raw_os_error: i32,
    pub(super) detail: String,
}

impl DirectoryFailure {
    pub(super) fn from_walk_error(error: &ignore::Error) -> Option<Self> {
        // With link following disabled, the parallel walker attaches both
        // depth and path to read_dir failures. Do not cache parse errors,
        // iterator errors without paths, or arbitrary metadata failures.
        let ignore::Error::WithDepth { err, .. } = error else {
            return None;
        };
        let ignore::Error::WithPath { path, err } = err.as_ref() else {
            return None;
        };
        let ignore::Error::Io(io_error) = err.as_ref() else {
            return None;
        };
        Some(Self {
            path: path.clone(),
            raw_os_error: io_error.raw_os_error()?,
            detail: error.to_string(),
        })
    }

    pub(super) fn unchanged(&self) -> bool {
        std::fs::read_dir(&self.path)
            .err()
            .is_some_and(|error| error.raw_os_error() == Some(self.raw_os_error))
    }
}

pub(super) fn record_directory_error(live: &LiveWalk, error: &ignore::Error) {
    record_walk_error(live, error);
    if let Some(failure) = DirectoryFailure::from_walk_error(error) {
        let mut failures = lock_recover(&live.directory_failures);
        if failures.len() < 1024 {
            failures.push(failure);
        }
    } else if std::env::var_os("MIXDOG_SEARCH_CACHE_TRACE").is_some() {
        eprintln!("inventory-untracked-error {error:?}");
    }
}

pub(super) fn record_walk_error(live: &LiveWalk, detail: impl ToString) {
    live.walk_errors.fetch_add(1, Ordering::Relaxed);
    let mut details = lock_recover(&live.walk_error_details);
    if details.len() >= WALK_ERROR_DETAIL_MAX {
        return;
    }
    details.push(
        detail
            .to_string()
            .chars()
            .take(WALK_ERROR_DETAIL_CHARS)
            .collect(),
    );
}

pub(super) fn live_walk_error_details(live: &LiveWalk) -> Vec<String> {
    lock_recover(&live.walk_error_details).clone()
}

pub(super) fn append_walk_error_details(target: &mut Vec<String>, details: Vec<String>) {
    for detail in details {
        if target.len() >= WALK_ERROR_DETAIL_MAX {
            break;
        }
        if !target.contains(&detail) {
            target.push(detail);
        }
    }
}

impl<'a> WorkerWalkBatch<'a> {
    pub(super) fn new(live: &'a LiveWalk, capacity: usize) -> Self {
        Self {
            live,
            files: Vec::with_capacity(capacity),
            capacity,
            last_flush: None,
        }
    }

    pub(super) fn push(&mut self, path: PathBuf) {
        self.files.push(path);
        if self.files.len() >= self.capacity || self.last_flush.is_none() {
            self.flush();
        } else {
            self.flush_due();
        }
    }

    pub(super) fn flush_due(&mut self) {
        if !self.files.is_empty()
            && self
                .last_flush
                .is_some_and(|last| last.elapsed() >= Duration::from_millis(10))
        {
            self.flush();
        }
    }

    pub(super) fn flush(&mut self) {
        if self.files.is_empty() {
            return;
        }
        // Recovered, never skipped: dropping this batch would answer with an
        // inventory that is short by exactly these paths and still claims to
        // be complete. The paths themselves are unaffected by whatever panic
        // poisoned the collector, so they are published.
        lock_recover(&self.live.files).append(&mut self.files);
        self.last_flush = Some(Instant::now());
        self.live.files_cond.notify_all();
    }
}

impl Drop for WorkerWalkBatch<'_> {
    fn drop(&mut self) {
        self.flush();
    }
}

pub(super) fn merge_sorted_inventory(left: &[PathBuf], right: &[PathBuf]) -> Vec<PathBuf> {
    let mut merged = Vec::with_capacity(left.len().saturating_add(right.len()));
    let (mut left_index, mut right_index) = (0usize, 0usize);
    while left_index < left.len() || right_index < right.len() {
        let next = match (left.get(left_index), right.get(right_index)) {
            (Some(left), Some(right)) if left <= right => {
                left_index += 1;
                left
            }
            (Some(_), Some(right)) => {
                right_index += 1;
                right
            }
            (Some(left), None) => {
                left_index += 1;
                left
            }
            (None, Some(right)) => {
                right_index += 1;
                right
            }
            (None, None) => break,
        };
        if merged.last() != Some(next) {
            merged.push(next.clone());
        }
    }
    merged
}

pub(super) fn repair_anchors(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut anchors = paths
        .iter()
        .map(|path| {
            if path_starts_with(path, root) {
                PathBuf::from(wire_path(path))
            } else if path_starts_with(root, path) {
                root.to_path_buf()
            } else {
                PathBuf::from(wire_path(path))
            }
        })
        .filter(|path| FileListStore::paths_overlap(path, root))
        .collect::<Vec<_>>();
    anchors.sort_by_key(|path| path.components().count());
    let mut minimal: Vec<PathBuf> = Vec::new();
    for path in anchors {
        if !minimal
            .iter()
            .any(|ancestor| path_starts_with(&path, ancestor))
        {
            minimal.push(path);
        }
    }
    minimal
}

#[cfg(test)]
pub(super) fn scan_inventory_subtree(key: &WalkKey, anchor: &Path) -> Result<Vec<PathBuf>, String> {
    scan_inventory_anchors(key, &[anchor.to_path_buf()])
}

pub(super) fn scan_inventory_anchors(
    key: &WalkKey,
    anchors: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    // Start at the original root so ignore rules and hidden-directory rules
    // are identical to a full walk. Only descend into changed branches.
    let branches = anchors.to_vec();
    let mut walk = WalkBuilder::new(&key.operand);
    walk.hidden(!key.hidden)
        .threads(inventory_walk_threads(&key.operand));
    walk.filter_entry(move |entry| {
        branches
            .iter()
            .any(|anchor| FileListStore::paths_overlap(entry.path(), anchor))
    });
    if key.no_ignore {
        walk.ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false);
    } else if key.no_require_git {
        walk.require_git(false);
    }
    if let Some(max_depth) = key.max_depth {
        walk.max_depth(Some(max_depth));
    }
    if let Some(overrides) = prune_overrides(&key.operand, &key.prune, &key.iglobs) {
        walk.overrides(overrides);
    }
    let mut files = Vec::new();
    for entry in walk.build() {
        let entry = entry.map_err(|error| error.to_string())?;
        if !path_starts_with(entry.path(), &key.operand)
            || !anchors
                .iter()
                .any(|anchor| path_starts_with(entry.path(), anchor))
        {
            continue;
        }
        let (is_file, is_dir, is_symlink) = if let Some(kind) = entry.file_type() {
            (kind.is_file(), kind.is_dir(), kind.is_symlink())
        } else {
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            let kind = metadata.file_type();
            (kind.is_file(), kind.is_dir(), kind.is_symlink())
        };
        if is_file || key.directories && ((is_dir && entry.path() != key.operand) || is_symlink) {
            files.push(PathBuf::from(wire_path(entry.path())));
        }
    }
    files.par_sort_unstable();
    files.dedup();
    Ok(files)
}

pub(super) fn repair_inventory(
    key: &WalkKey,
    base: &[PathBuf],
    changed_paths: &[PathBuf],
) -> Result<Arc<Vec<PathBuf>>, String> {
    let anchors = repair_anchors(&key.operand, changed_paths);
    if anchors.is_empty() {
        return Ok(Arc::new(base.to_vec()));
    }
    let retained = base
        .iter()
        .filter(|path| !anchors.iter().any(|anchor| path_starts_with(path, anchor)))
        .cloned()
        .collect::<Vec<_>>();
    let additions = scan_inventory_anchors(key, &anchors)?;
    Ok(Arc::new(merge_sorted_inventory(&retained, &additions)))
}

pub(super) fn reuse_failed_inventory(
    store: &FileListStore,
    key: &WalkKey,
    live: &LiveWalk,
) -> Option<Arc<Vec<PathBuf>>> {
    if !live.cacheable.load(Ordering::Acquire) || !store.watcher_healthy.load(Ordering::Acquire) {
        return None;
    }
    let (files, failures) = {
        let ready = lock_recover(&store.ready);
        let entry = ready.get(key).filter(|entry| {
            entry.generation == live.generation && !entry.directory_failures.is_empty()
        })?;
        (
            Arc::clone(&entry.files),
            Arc::clone(&entry.directory_failures),
        )
    };
    // Never serve the saved errors without retrying their actual I/O in this
    // request. Any recovery or different error needs a fresh complete walk.
    for failure in failures.iter() {
        if live.cancelled.load(Ordering::Acquire) {
            return None;
        }
        if !failure.unchanged() {
            if std::env::var_os("MIXDOG_SEARCH_CACHE_TRACE").is_some() {
                eprintln!("inventory-recheck-changed {}", failure.path.display());
            }
            let mut ready = lock_recover(&store.ready);
            if ready
                .get(key)
                .is_some_and(|entry| Arc::ptr_eq(&entry.files, &files))
            {
                ready.remove(key);
            }
            return None;
        }
    }
    if store.generation(&key.operand) != live.generation
        || !live.cacheable.load(Ordering::Acquire)
        || !store.watcher_healthy.load(Ordering::Acquire)
        || live.cancelled.load(Ordering::Acquire)
    {
        return None;
    }
    for failure in failures.iter() {
        record_walk_error(live, &failure.detail);
    }
    *lock_recover(&live.directory_failures) = (*failures).clone();
    Some(files)
}

/// Publish an inventory that is already complete: the shortcut paths know the
/// whole answer up front, so they announce enumeration as done with it.
fn publish_complete_inventory(live: &LiveWalk, files: &[PathBuf]) {
    publish_live_files(live, files);
    live.enumeration_done.store(true, Ordering::Release);
    live.files_cond.notify_all();
}

/// One request's walk options as a configured walker: ignore rules, worker
/// count, depth bound and the directories this operand prunes.
fn configure_inventory_walk(operand: &Path, parsed: &ParsedArgs) -> WalkBuilder {
    let mut walk = WalkBuilder::new(operand);
    walk.hidden(!parsed.hidden)
        .threads(inventory_walk_threads(operand));
    if parsed.no_ignore {
        walk.ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false);
    } else if parsed.no_require_git {
        walk.require_git(false);
    }
    if let Some(max_depth) = parsed.max_depth {
        walk.max_depth(Some(max_depth));
    }
    // Prune excluded directories while walking. Without this the
    // inventory descends into .git/node_modules on every request and
    // only discards them later, at scan time.
    let prune = prune_globs(operand, parsed);
    if let Some(overrides) = prune_overrides(operand, &prune, &parsed.iglobs) {
        walk.overrides(overrides);
    }
    walk
}

/// File/dir/symlink flags for one walked entry, stat-ing the path when the
/// walker carried no file type. A failed stat is a walk error and the entry is
/// skipped, never guessed at.
fn walk_entry_kinds(live: &LiveWalk, entry: &ignore::DirEntry) -> Option<(bool, bool, bool)> {
    if let Some(kind) = entry.file_type() {
        return Some((kind.is_file(), kind.is_dir(), kind.is_symlink()));
    }
    match std::fs::symlink_metadata(entry.path()) {
        Ok(metadata) => {
            let kind = metadata.file_type();
            Some((kind.is_file(), kind.is_dir(), kind.is_symlink()))
        }
        Err(error) => {
            record_walk_error(live, error);
            None
        }
    }
}

pub(super) fn start_live_walk(
    store: Arc<FileListStore>,
    key: WalkKey,
    live: Arc<LiveWalk>,
    operand: PathBuf,
    parsed: ParsedArgs,
) {
    inventory_pool().spawn(move || {
        let result = contain_search_panic("native inventory worker", || {
            if let Some(files) = reuse_failed_inventory(&store, &key, &live) {
                publish_complete_inventory(&live, &files);
                return Ok(files);
            }
            if live.cancelled.load(Ordering::Acquire) {
                return Err(CANCELLED.to_string());
            }
            if operand.is_file() {
                let files = vec![operand];
                publish_complete_inventory(&live, &files);
                return Ok(Arc::new(files));
            }
            if !operand.is_dir() {
                return Err(format!("no such path {}", operand.display()));
            }
            let walk = configure_inventory_walk(&operand, &parsed);
            // Publish the first candidate immediately, then amortize locking
            // with size/time-bounded batches for every query shape.
            let publish_batch = inventory_publish_batch();
            walk.build_parallel().run(|| {
                let live = &live;
                let operand = &operand;
                let mut batch = WorkerWalkBatch::new(live, publish_batch);
                Box::new(move |entry| {
                    batch.flush_due();
                    if abandon_expired_idle_walk(live, serve_search_uptime_ms())
                        || live.cancelled.load(Ordering::Acquire)
                    {
                        return ignore::WalkState::Quit;
                    }
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            record_directory_error(live, &error);
                            return ignore::WalkState::Continue;
                        }
                    };
                    let Some((is_file, is_dir, is_symlink)) = walk_entry_kinds(live, &entry) else {
                        return ignore::WalkState::Continue;
                    };
                    if !is_file
                        && !(parsed.directories
                            && ((is_dir && entry.path() != operand.as_path()) || is_symlink))
                    {
                        return ignore::WalkState::Continue;
                    }
                    let path = entry.into_path();
                    batch.push(path);
                    ignore::WalkState::Continue
                })
            });
            if live.cancelled.load(Ordering::Acquire) {
                return Err(CANCELLED.to_string());
            }
            // Fuzzy consumers rank the published stream in discovery order and
            // do not depend on inventory ordering. Let them return as soon as
            // enumeration is complete while this worker finishes the
            // deterministic sorted cache in the background.
            live.enumeration_done.store(true, Ordering::Release);
            live.files_cond.notify_all();
            // THE ONE DELIBERATE EXCEPTION to the recover-a-poisoned-lock
            // policy (`store.rs`), and the reason is what this read is for: it
            // is not a cache read, it is the answer being published. Every
            // other holder of this mutex recovers, because a poisoned lock
            // says nothing about the paths already in it. Here the walk is
            // about to install this vector as a CACHED, `complete` inventory
            // that later requests reuse — and a panic inside a writer's
            // critical section (`append`/`extend` above) can leave it short.
            // An inventory that may be truncated must fail loudly once, not be
            // cached as the whole answer: the next request restarts the walk.
            let mut files = live
                .files
                .lock()
                .map_err(|_| "parallel file collector poisoned".to_string())?
                .clone();
            // Inventory order is deterministic but duplicate paths are
            // equivalent, so stability buys nothing. Parallel unstable sort
            // removes the single-core tail that cold broad finds previously
            // paid after the parallel walk had already completed.
            files.par_sort_unstable();
            Ok(Arc::new(files))
        });
        match result {
            Ok(files) => {
                store.finish_live(key, &live, Ok(files));
            }
            Err(error) if error == CANCELLED => {
                store.finish_live(key, &live, Err(None));
            }
            Err(error) => {
                store.finish_live(key, &live, Err(Some(error)));
            }
        }
    });
}

pub(super) fn wait_live_complete(
    live: &LiveWalk,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<Option<Arc<Vec<PathBuf>>>, String> {
    let mut state = lock_recover(&live.state);
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
            return Err(SOFT_TIMEOUT.to_string());
        }
        match &*state {
            LiveState::Running => {
                state = live
                    .cond
                    .wait_timeout(state, Duration::from_millis(10))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            LiveState::Done(files) => return Ok(Some(Arc::clone(files))),
            LiveState::Abandoned => return Ok(None),
            LiveState::Failed(err) => return Err(err.clone()),
        }
    }
}
