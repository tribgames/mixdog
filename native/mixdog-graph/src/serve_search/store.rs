// The shared file-list store: ready inventories, fuzzy corpora and the
// live walks that produce them, including the waiter bookkeeping that
// decides when an abandoned walk is cancelled.
use super::*;

pub(super) struct ReadyEntry {
    pub(super) files: Arc<Vec<PathBuf>>,
    pub(super) directory_failures: Arc<Vec<DirectoryFailure>>,
    pub(super) expires_at: Instant,
    pub(super) generation: u64,
    pub(super) touched_at: Instant,
    pub(super) estimated_bytes: usize,
    pub(super) root_identity: Option<crate::serve_search_usn::FileIdentity>,
}

pub(super) struct FuzzyIndexedPath {
    pub(super) path: String,
    pub(super) ascii_mask: Option<(u64, u64)>,
}

pub(super) struct FuzzyCorpus {
    pub(super) paths: Vec<FuzzyIndexedPath>,
}

pub(super) struct FuzzyEntry {
    pub(super) corpus: Arc<FuzzyCorpus>,
    pub(super) touched_at: Instant,
    pub(super) estimated_bytes: usize,
}

pub(super) fn paths_storage_bytes(files: &[PathBuf]) -> usize {
    files.iter().fold(0usize, |total, path| {
        total
            .saturating_add(std::mem::size_of::<PathBuf>())
            .saturating_add(path.as_os_str().to_string_lossy().len().saturating_mul(2))
    })
}

pub(super) fn fuzzy_storage_bytes(corpus: &FuzzyCorpus) -> usize {
    corpus
        .paths
        .iter()
        .fold(std::mem::size_of::<FuzzyCorpus>(), |total, indexed| {
            total
                .saturating_add(std::mem::size_of::<FuzzyIndexedPath>())
                .saturating_add(indexed.path.len())
        })
}

pub(super) enum LiveState {
    Running,
    Done(Arc<Vec<PathBuf>>),
    Abandoned,
    Failed(String),
}

pub(super) struct LiveWalk {
    pub(super) files: Mutex<Vec<PathBuf>>,
    pub(super) state: Mutex<LiveState>,
    // `cond` pairs exclusively with the `state` mutex and `files_cond` with the
    // `files` mutex. std::sync::Condvar panics when one condvar is waited on
    // with two different mutexes, which killed searches whenever a streaming
    // consumer and a complete-inventory waiter shared one walk.
    pub(super) cond: Condvar,
    pub(super) files_cond: Condvar,
    pub(super) waiters: AtomicUsize,
    pub(super) cancelled: AtomicBool,
    pub(super) enumeration_done: AtomicBool,
    pub(super) keep_warm: AtomicBool,
    pub(super) inventory_lease: InventoryLease,
    pub(super) cacheable: AtomicBool,
    pub(super) walk_errors: AtomicUsize,
    pub(super) walk_error_details: Mutex<Vec<String>>,
    pub(super) directory_failures: Mutex<Vec<DirectoryFailure>>,
    pub(super) generation: u64,
    pub(super) change_sequence: u64,
}

pub(super) fn abandon_expired_idle_walk(live: &LiveWalk, now_ms: u64) -> bool {
    let mut state = live.state.lock().unwrap_or_else(|error| error.into_inner());
    let idle = live.waiters.load(Ordering::Acquire) == 0
        && !live.keep_warm.load(Ordering::Acquire)
        && !live.inventory_lease.active(now_ms);
    if !idle || !matches!(&*state, LiveState::Running) {
        return false;
    }
    live.cancelled.store(true, Ordering::Release);
    *state = LiveState::Abandoned;
    live.cond.notify_all();
    live.files_cond.notify_all();
    true
}

pub(super) struct FileListStore {
    pub(super) ready: Arc<Mutex<HashMap<WalkKey, ReadyEntry>>>,
    pub(super) persisted_checkpoints:
        Mutex<Option<Vec<crate::serve_search_usn::JournalCheckpoint>>>,
    pub(super) live: Mutex<HashMap<WalkKey, Arc<LiveWalk>>>,
    pub(super) fuzzy: Mutex<HashMap<FuzzyKey, FuzzyEntry>>,
    pub(super) generations: Mutex<HashMap<PathBuf, u64>>,
    pub(super) pending_repairs: Mutex<HashMap<WalkKey, PendingInventoryRepair>>,
    pub(super) repair_worker_running: AtomicBool,
    pub(super) repair_changed: Condvar,
    pub(super) watcher: Mutex<Option<RecommendedWatcher>>,
    pub(super) watcher_healthy: AtomicBool,
    pub(super) watched_roots: Mutex<HashMap<PathBuf, Instant>>,
    pub(super) changes: Mutex<InventoryChanges>,
}

#[derive(Default)]
pub(super) struct InventoryChanges {
    pub(super) sequence: u64,
    pub(super) records: VecDeque<(u64, Vec<PathBuf>, Option<Vec<PathBuf>>)>,
}

impl InventoryChanges {
    pub(super) fn record(&mut self, roots: &[PathBuf], paths: Option<&[PathBuf]>) {
        self.sequence += 1;
        // A bounded journal is only an optimization. A gap or an unknown
        // change boundary forces a fresh walk, never a guessed repair.
        self.records.push_back((
            self.sequence,
            roots.to_vec(),
            paths
                .filter(|paths| paths.len() <= 256)
                .map(<[PathBuf]>::to_vec),
        ));
        while self.records.len() > 1024 {
            self.records.pop_front();
        }
    }

    pub(super) fn since(&self, sequence: u64, root: &Path) -> Option<Vec<PathBuf>> {
        if self
            .records
            .front()
            .is_some_and(|(first, _, _)| *first > sequence + 1)
        {
            return None;
        }
        let mut changed = HashSet::new();
        for (_, roots, paths) in self.records.iter().filter(|(id, _, _)| *id > sequence) {
            if !roots
                .iter()
                .any(|path| FileListStore::paths_overlap(path, root))
            {
                continue;
            }
            for path in paths.as_ref()? {
                if FileListStore::paths_overlap(path, root) {
                    if path_starts_with(root, path) {
                        return None;
                    }
                    changed.insert(path.clone());
                    if changed.len() > 4096 {
                        return None;
                    }
                }
            }
        }
        Some(changed.into_iter().collect())
    }
}

pub(super) struct PendingInventoryRepair {
    pub(super) base: Arc<Vec<PathBuf>>,
    pub(super) directory_failures: Arc<Vec<DirectoryFailure>>,
    pub(super) paths: HashSet<PathBuf>,
    pub(super) processing: bool,
    pub(super) token: Arc<()>,
}

pub(super) struct LiveWaiterGuard<'a> {
    pub(super) store: &'a FileListStore,
    pub(super) key: WalkKey,
    pub(super) live: Arc<LiveWalk>,
}

impl Drop for LiveWaiterGuard<'_> {
    fn drop(&mut self) {
        self.store.release_live(&self.key, &self.live);
    }
}

impl FileListStore {
    #[cfg(test)]
    pub(super) fn new() -> Self {
        Self {
            ready: Arc::new(Mutex::new(HashMap::new())),
            persisted_checkpoints: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            fuzzy: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            pending_repairs: Mutex::new(HashMap::new()),
            repair_worker_running: AtomicBool::new(false),
            repair_changed: Condvar::new(),
            watcher: Mutex::new(None),
            watcher_healthy: AtomicBool::new(false),
            watched_roots: Mutex::new(HashMap::new()),
            changes: Mutex::new(InventoryChanges::default()),
        }
    }

    /// Drop every warm cache without tearing the server down.
    ///
    /// A standalone server reclaims by exiting and letting the OS take the
    /// pages back. An in-process server has no exit to reclaim through — the
    /// host owns the process — so the same idle window frees the inventory,
    /// the fuzzy corpus, the trigram signatures and the OS watchers instead.
    /// Only cached RESULTS are dropped: walks in flight hold their own Arc and
    /// finish untouched, and everything persisted first is reloaded on demand,
    /// exactly as a freshly spawned process would.
    pub(super) fn release_caches(&self) {
        persist_file_list_snapshot(&self.ready);
        persist_content_signature_cache();
        self.ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.fuzzy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.generations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.pending_repairs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        // Dropping the watcher unwatches every root at once. An idle server
        // pinning one OS handle per watched root is exactly the cost this
        // release exists to remove; the next search re-arms it.
        *self
            .watcher
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.watcher_healthy.store(false, Ordering::Release);
        self.watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        trusted_watch_roots()
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        for shard in raw_content_signature_cache() {
            shard
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clear();
        }
        // Re-arm the loader so the next search reads the snapshot just
        // persisted rather than rebuilding every signature from scratch.
        CONTENT_SIGNATURE_CACHE_LOADED.store(false, Ordering::Release);
    }

    pub(super) fn new_persistent() -> Self {
        let (ready, persisted_checkpoints) = load_file_list_snapshot();
        Self {
            ready: Arc::new(Mutex::new(ready)),
            persisted_checkpoints: Mutex::new(persisted_checkpoints),
            live: Mutex::new(HashMap::new()),
            fuzzy: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            pending_repairs: Mutex::new(HashMap::new()),
            repair_worker_running: AtomicBool::new(false),
            repair_changed: Condvar::new(),
            watcher: Mutex::new(None),
            watcher_healthy: AtomicBool::new(false),
            watched_roots: Mutex::new(HashMap::new()),
            changes: Mutex::new(InventoryChanges::default()),
        }
    }

    pub(super) fn validate_persisted_ready(&self) {
        let checkpoints = self
            .persisted_checkpoints
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(checkpoints) = checkpoints else {
            return;
        };
        let mut changed_paths = HashMap::new();
        for checkpoint in &checkpoints {
            let result = crate::serve_search_usn::sync_volume(checkpoint.volume);
            let trusted = result.trusted && result.volume_serial == Some(checkpoint.volume_serial);
            let current = crate::serve_search_usn::journal_checkpoints()
                .into_iter()
                .find(|current| current.volume == checkpoint.volume);
            let continuous = trusted
                && current.is_some_and(|current| {
                    current.volume_serial == checkpoint.volume_serial
                        && current.journal_id == checkpoint.journal_id
                        && current.next_usn >= checkpoint.next_usn
                });
            let resolved = if continuous {
                let mut ids = result.changed.clone();
                ids.extend(result.parents.iter().copied());
                crate::serve_search_usn::resolve_file_ids(checkpoint.volume, &ids)
            } else {
                None
            };
            apply_content_signature_journal_sync(result);
            changed_paths.insert(checkpoint.volume, resolved);
        }
        self.ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|key, entry| {
                let Some(volume) = crate::serve_search_usn::volume_for_path(&key.operand) else {
                    return false;
                };
                let Some(Some(paths)) = changed_paths.get(&volume) else {
                    return false;
                };
                if entry.root_identity != crate::serve_search_usn::path_identity(&key.operand) {
                    return false;
                }
                !paths
                    .iter()
                    .any(|path| Self::paths_overlap(path, &key.operand))
            });
    }

    pub(super) fn generation(&self, operand: &Path) -> u64 {
        self.generations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(operand)
            .copied()
            .unwrap_or(0)
    }

    pub(super) fn paths_overlap(left: &Path, right: &Path) -> bool {
        path_starts_with(left, right) || path_starts_with(right, left)
    }

    pub(super) fn affected_roots(&self, paths: &[PathBuf]) -> Vec<PathBuf> {
        self.watched_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .filter(|root| {
                paths.is_empty() || paths.iter().any(|path| Self::paths_overlap(root, path))
            })
            .cloned()
            .collect()
    }

    pub(super) fn invalidate_paths(&self, paths: &[PathBuf]) -> Vec<PathBuf> {
        let roots = self.affected_roots(paths);
        if roots.is_empty() {
            return roots;
        }
        self.invalidate_roots(&roots);
        roots
    }

    pub(super) fn take_ready(&self, key: &WalkKey) -> Option<Arc<Vec<PathBuf>>> {
        self.validate_persisted_ready();
        {
            let deadline = Instant::now() + Duration::from_millis(250);
            let mut pending = self
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while pending.contains_key(key) {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                pending = self
                    .repair_changed
                    .wait_timeout(pending, deadline.saturating_duration_since(now))
                    .unwrap_or_else(|error| error.into_inner())
                    .0;
            }
        }
        let generation = self.generation(&key.operand);
        let watched_roots = self
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|ready_key, entry| {
            entry.expires_at > now
                || watched_roots
                    .iter()
                    .any(|root| Self::paths_overlap(&ready_key.operand, root))
        });
        if !ready.contains_key(key) {
            self.fuzzy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|fuzzy, _| &fuzzy.walk != key);
        }
        let entry = ready.get_mut(key).filter(|entry| {
            entry.generation == generation && entry.directory_failures.is_empty()
        })?;
        entry.touched_at = now;
        Some(Arc::clone(&entry.files))
    }

    pub(super) fn remember_inventory(
        &self,
        key: WalkKey,
        files: Arc<Vec<PathBuf>>,
        generation: u64,
        directory_failures: Arc<Vec<DirectoryFailure>>,
    ) {
        let Some(ttl) = file_list_ttl() else { return };
        if self.generation(&key.operand) != generation {
            return;
        }
        let root_identity = crate::serve_search_usn::path_identity(&key.operand);
        let estimated_bytes = paths_storage_bytes(&files).saturating_add(
            directory_failures
                .iter()
                .map(|failure| {
                    std::mem::size_of::<DirectoryFailure>()
                        + failure.path.as_os_str().len() * 2
                        + failure.detail.len()
                })
                .sum::<usize>(),
        );
        let bytes_limit = file_list_cache_bytes();
        if estimated_bytes > bytes_limit {
            return;
        }
        let watched_roots = self
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|ready_key, entry| {
            entry.expires_at > now
                || watched_roots
                    .iter()
                    .any(|root| Self::paths_overlap(&ready_key.operand, root))
        });
        ready.remove(&key);
        while !ready.is_empty()
            && (ready.len() >= FILE_LIST_CACHE_MAX
                || ready.values().fold(estimated_bytes, |total, entry| {
                    total.saturating_add(entry.estimated_bytes)
                }) > bytes_limit)
        {
            if let Some(oldest) = ready
                .iter()
                .min_by_key(|(_, entry)| entry.touched_at)
                .map(|(k, _)| k.clone())
            {
                ready.remove(&oldest);
            } else {
                break;
            }
        }
        ready.insert(
            key.clone(),
            ReadyEntry {
                files,
                directory_failures,
                expires_at: now + ttl,
                generation,
                touched_at: now,
                estimated_bytes,
                root_identity,
            },
        );
        drop(ready);
        schedule_file_list_snapshot(Arc::clone(&self.ready));
        self.fuzzy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|fuzzy, _| fuzzy.walk != key);
    }

    pub(super) fn fuzzy_corpus(
        &self,
        key: &FuzzyKey,
        files: &Arc<Vec<PathBuf>>,
        root: &Path,
        filter: &PathFilter,
    ) -> Arc<FuzzyCorpus> {
        {
            let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = fuzzy.get_mut(key) {
                entry.touched_at = Instant::now();
                return Arc::clone(&entry.corpus);
            }
        }
        let corpus = Arc::new(FuzzyCorpus {
            paths: files
                .iter()
                .filter(|file| filter.allows(file))
                .map(|file| {
                    let path =
                        relative_inventory_path(file, root).unwrap_or_else(|| wire_path(file));
                    let ascii_mask = fuzzy_ascii_presence(&path);
                    FuzzyIndexedPath { path, ascii_mask }
                })
                .collect(),
        });
        self.remember_fuzzy_corpus(key, corpus)
    }

    pub(super) fn take_fuzzy_corpus(&self, key: &FuzzyKey) -> Option<Arc<FuzzyCorpus>> {
        let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
        let entry = fuzzy.get_mut(key)?;
        entry.touched_at = Instant::now();
        Some(Arc::clone(&entry.corpus))
    }

    pub(super) fn remember_fuzzy_corpus(
        &self,
        key: &FuzzyKey,
        corpus: Arc<FuzzyCorpus>,
    ) -> Arc<FuzzyCorpus> {
        let estimated_bytes = fuzzy_storage_bytes(&corpus);
        let bytes_limit = fuzzy_cache_bytes();
        if estimated_bytes > bytes_limit {
            return corpus;
        }
        let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = fuzzy.get_mut(key) {
            entry.touched_at = Instant::now();
            return Arc::clone(&entry.corpus);
        }
        while !fuzzy.is_empty()
            && (fuzzy.len() >= FILE_LIST_CACHE_MAX
                || fuzzy.values().fold(estimated_bytes, |total, entry| {
                    total.saturating_add(entry.estimated_bytes)
                }) > bytes_limit)
        {
            if let Some(oldest) = fuzzy
                .iter()
                .min_by_key(|(_, entry)| entry.touched_at)
                .map(|(key, _)| key.clone())
            {
                fuzzy.remove(&oldest);
            } else {
                break;
            }
        }
        fuzzy.insert(
            key.clone(),
            FuzzyEntry {
                corpus: Arc::clone(&corpus),
                touched_at: Instant::now(),
                estimated_bytes,
            },
        );
        corpus
    }

    pub(super) fn begin_live(&self, key: WalkKey, keep_warm: bool) -> (Arc<LiveWalk>, bool) {
        self.begin_live_with_inventory(key, keep_warm, 0)
    }

    pub(super) fn begin_live_with_inventory(
        &self,
        key: WalkKey,
        keep_warm: bool,
        inventory_lease_ms: u64,
    ) -> (Arc<LiveWalk>, bool) {
        // Read the generation before taking the live-map lock; generation()
        // locks the generations mutex and nesting it under `live` invites
        // lock-order inversions with invalidation.
        let change_sequence = self
            .changes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sequence;
        let generation = self.generation(&key.operand);
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = live.get(&key).cloned() {
            let state = existing
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if matches!(&*state, LiveState::Running)
                && existing.generation == generation
                && !existing.cancelled.load(Ordering::Acquire)
            {
                if keep_warm {
                    existing.keep_warm.store(true, Ordering::Release);
                }
                existing
                    .inventory_lease
                    .extend(serve_search_uptime_ms(), inventory_lease_ms);
                existing.waiters.fetch_add(1, Ordering::Relaxed);
                drop(state);
                return (existing, false);
            }
            drop(state);
            live.remove(&key);
        }
        let created = Arc::new(LiveWalk {
            files: Mutex::new(Vec::new()),
            state: Mutex::new(LiveState::Running),
            cond: Condvar::new(),
            files_cond: Condvar::new(),
            waiters: AtomicUsize::new(1),
            cancelled: AtomicBool::new(false),
            enumeration_done: AtomicBool::new(false),
            keep_warm: AtomicBool::new(keep_warm),
            inventory_lease: InventoryLease::new(serve_search_uptime_ms(), inventory_lease_ms),
            cacheable: AtomicBool::new(true),
            walk_errors: AtomicUsize::new(0),
            walk_error_details: Mutex::new(Vec::new()),
            directory_failures: Mutex::new(Vec::new()),
            generation,
            change_sequence,
        });
        live.insert(key, Arc::clone(&created));
        (created, true)
    }

    pub(super) fn waiter_guard<'a>(
        &'a self,
        key: WalkKey,
        live: Arc<LiveWalk>,
    ) -> LiveWaiterGuard<'a> {
        LiveWaiterGuard {
            store: self,
            key,
            live,
        }
    }

    pub(super) fn release_live(&self, key: &WalkKey, live: &Arc<LiveWalk>) {
        let previous = live.waiters.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "live inventory waiter underflow");
        if previous != 1
            || live.keep_warm.load(Ordering::Acquire)
            || live.inventory_lease.active(serve_search_uptime_ms())
        {
            return;
        }
        let should_cancel = {
            let mut live_map = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let same = live_map
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            let idle = live.waiters.load(Ordering::Acquire) == 0
                && !live.keep_warm.load(Ordering::Acquire)
                && !live.inventory_lease.active(serve_search_uptime_ms());
            if same && idle {
                live_map.remove(key);
            }
            idle
        };
        if should_cancel {
            abandon_expired_idle_walk(live, serve_search_uptime_ms());
        }
    }

    pub(super) fn finish_live(
        &self,
        key: WalkKey,
        live: &Arc<LiveWalk>,
        result: Result<Arc<Vec<PathBuf>>, Option<String>>,
    ) -> bool {
        // Same ordering rule as begin_live: never lock generations under the
        // live-map lock. remember() re-checks the current generation, so a
        // racing invalidation still prevents caching a stale inventory.
        let current_generation = self.generation(&key.operand);
        let failures = Arc::new(
            live.directory_failures
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        );
        let cacheable = {
            let mut live_map = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let same = live_map
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            if same {
                live_map.remove(&key);
            }
            same && current_generation == live.generation
                && live.cacheable.load(Ordering::Acquire)
                && live.walk_errors.load(Ordering::Acquire) == failures.len()
        };
        // Cache repair performs I/O. Keep the state mutex available so
        // waiting requests can still observe deadlines and cancellation.
        let completed_state = match result {
            Ok(files) => {
                if std::env::var_os("MIXDOG_SEARCH_CACHE_TRACE").is_some() {
                    eprintln!("inventory-cache root={} saved={} generation={}/{} watch={} errors={} retryable={}",
                        key.operand.display(), cacheable, live.generation, current_generation,
                        live.cacheable.load(Ordering::Acquire),
                        live.walk_errors.load(Ordering::Acquire), failures.len());
                }
                if cacheable {
                    self.remember_inventory(key, Arc::clone(&files), live.generation, failures);
                } else if live.cacheable.load(Ordering::Acquire)
                    && self.watcher_healthy.load(Ordering::Acquire)
                    && live.walk_errors.load(Ordering::Acquire) == failures.len()
                    && !live.cancelled.load(Ordering::Acquire)
                {
                    // Serialize the cache repair with journal publication.
                    // Notifications queued during repair invalidate it after
                    // this guard is released, just like a fresh inventory.
                    let changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(paths) = changes
                        .since(live.change_sequence, &key.operand)
                        .filter(|paths| !paths.is_empty())
                    {
                        if let Ok(repaired) = repair_inventory(&key, &files, &paths) {
                            if !live.cancelled.load(Ordering::Acquire)
                                && self.watcher_healthy.load(Ordering::Acquire)
                            {
                                self.remember_inventory(
                                    key.clone(),
                                    repaired,
                                    self.generation(&key.operand),
                                    failures,
                                );
                            }
                        }
                    }
                }
                if live.keep_warm.load(Ordering::Acquire) {
                    schedule_signature_prewarm(Arc::clone(&files));
                }
                LiveState::Done(files)
            }
            Err(Some(err)) => LiveState::Failed(err),
            Err(None) => LiveState::Abandoned,
        };
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        *state = completed_state;
        live.cond.notify_all();
        live.files_cond.notify_all();
        cacheable
    }
}
