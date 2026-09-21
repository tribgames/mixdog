// Filesystem-change side of the store: watcher registration, event
// classification, inventory invalidation and the incremental repair
// worker that splices changed paths into a cached inventory.
use super::*;

impl FileListStore {
    pub(super) fn schedule_inventory_repairs(self: &Arc<Self>, paths: &[PathBuf]) -> Vec<PathBuf> {
        let roots = self.affected_roots(paths);
        if roots.is_empty() {
            return roots;
        }
        let repair_paths = if paths.iter().any(|path| is_ignore_rule_path(path)) {
            roots.clone()
        } else {
            paths.to_vec()
        };
        let cached = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(key, _)| {
                roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
            })
            .map(|(key, entry)| {
                (
                    key.clone(),
                    Arc::clone(&entry.files),
                    Arc::clone(&entry.directory_failures),
                )
            })
            .collect::<Vec<_>>();
        {
            let mut pending = self
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for (key, entry) in pending.iter_mut() {
                if roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
                {
                    entry.paths.extend(repair_paths.iter().cloned());
                }
            }
            for (key, base, directory_failures) in cached {
                let entry = pending
                    .entry(key)
                    .or_insert_with(|| PendingInventoryRepair {
                        base,
                        directory_failures,
                        paths: HashSet::new(),
                        processing: false,
                        token: Arc::new(()),
                    });
                entry.paths.extend(repair_paths.iter().cloned());
            }
        }
        self.invalidate_roots_with_paths(&roots, Some(&repair_paths));
        self.start_inventory_repair_worker();
        roots
    }

    pub(super) fn start_inventory_repair_worker(self: &Arc<Self>) {
        if self
            .repair_worker_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(50));
                let jobs = {
                    let mut pending = store
                        .pending_repairs
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    pending
                        .iter_mut()
                        .filter(|(_, entry)| !entry.processing && !entry.paths.is_empty())
                        .map(|(key, entry)| {
                            entry.processing = true;
                            (
                                key.clone(),
                                Arc::clone(&entry.base),
                                entry.paths.drain().collect::<Vec<_>>(),
                                Arc::clone(&entry.token),
                            )
                        })
                        .collect::<Vec<_>>()
                };
                if jobs.is_empty() {
                    break;
                }
                for (key, base, paths, token) in jobs {
                    let repaired = repair_inventory(&key, &base, &paths);
                    store.finish_inventory_repair(&key, &token, repaired);
                }
            }
            store.repair_worker_running.store(false, Ordering::Release);
            let restart = store
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values()
                .any(|entry| !entry.processing && !entry.paths.is_empty());
            if restart {
                store.start_inventory_repair_worker();
            }
        });
    }

    pub(super) fn schedule_noise_prewarm(self: &Arc<Self>) {
        let keys = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .filter(|key| key.no_ignore)
            .cloned()
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            let cancelled = AtomicBool::new(false);
            for key in keys {
                let parsed = ParsedArgs {
                    targets: vec![key.operand.to_string_lossy().into_owned()],
                    hidden: key.hidden,
                    no_ignore: key.no_ignore,
                    no_require_git: key.no_require_git,
                    max_depth: key.max_depth,
                    files_list: true,
                    directories: key.directories,
                    ..ParsedArgs::default()
                };
                let _ =
                    complete_operand_files(&store, &key.operand, &parsed, &cancelled, None, true);
            }
        });
    }

    pub(super) fn invalidate_roots(&self, roots: &[PathBuf]) {
        self.invalidate_roots_with_paths(roots, None);
    }

    pub(super) fn finish_inventory_repair(
        &self,
        key: &WalkKey,
        token: &Arc<()>,
        repaired: Result<Arc<Vec<PathBuf>>, String>,
    ) {
        let mut pending = self
            .pending_repairs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(entry) = pending.get_mut(key) else {
            return;
        };
        // A rescan can replace a job while its old worker is still running.
        // Key equality alone must not let that old result overwrite the new job.
        if !Arc::ptr_eq(token, &entry.token) {
            return;
        }
        match repaired {
            Ok(files) => {
                entry.base = files;
                entry.processing = false;
                if entry.paths.is_empty() {
                    self.remember_inventory(
                        key.clone(),
                        Arc::clone(&entry.base),
                        self.generation(&key.operand),
                        Arc::clone(&entry.directory_failures),
                    );
                    pending.remove(key);
                    self.repair_changed.notify_all();
                }
            }
            Err(_) => {
                pending.remove(key);
                self.repair_changed.notify_all();
            }
        }
    }

    pub(super) fn invalidate_roots_with_paths(&self, roots: &[PathBuf], paths: Option<&[PathBuf]>) {
        if roots.is_empty() {
            return;
        }
        if paths.is_none() {
            self.pending_repairs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|key, _| {
                    !roots
                        .iter()
                        .any(|root| Self::paths_overlap(&key.operand, root))
                });
            self.repair_changed.notify_all();
        }
        {
            let mut changes = self.changes.lock().unwrap_or_else(|e| e.into_inner());
            changes.record(roots, paths);
            let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
            for root in roots {
                *generations.entry(root.clone()).or_insert(0) += 1;
            }
        }
        self.ready
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| {
                !roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
            });
        self.fuzzy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| {
                !roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.walk.operand, root))
            });
        let stale: Vec<Arc<LiveWalk>> = {
            let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let mut stale = Vec::new();
            live.retain(|key, value| {
                let affected = roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root));
                if !affected {
                    return true;
                }
                stale.push(Arc::clone(value));
                false
            });
            stale
        };
        for live in stale {
            // Cache invalidation applies to future searches. Existing waiters
            // still receive the snapshot they started; it simply cannot be
            // cached under the newer generation.
            live.keep_warm.store(false, Ordering::Release);
            if live.waiters.load(Ordering::Acquire) == 0 {
                live.cancelled.store(true, Ordering::Release);
                let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                if matches!(&*state, LiveState::Running) {
                    *state = LiveState::Abandoned;
                }
                live.cond.notify_all();
            }
        }
    }

    pub(super) fn watch_root(self: &Arc<Self>, operand: &Path) -> bool {
        // Root-wide recursive registration is unrelated to the requested
        // matches and cannot honor the search deadline or its tree exclusions.
        // Search roots without caching instead of blocking on OS watch setup.
        if is_filesystem_root(operand) {
            return false;
        }
        // Watching is an optional cache optimization, never a prerequisite for
        // searching. An exact-file operand is already cheap to scan; watching
        // its parent recursively can block indefinitely on virtual, network, or
        // otherwise non-watchable filesystems. Serve the search uncached instead.
        if operand.is_file() {
            return false;
        }
        let watch_operand = operand;
        if !watch_operand.is_dir() {
            return false;
        }
        let root = normalized_operand(watch_operand);
        if !self.watcher_healthy.load(Ordering::Acquire) {
            let stale_roots = {
                let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
                if self.watcher_healthy.load(Ordering::Acquire) {
                    Vec::new()
                } else {
                    *watcher = None;
                    let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
                    let stale = roots.drain().map(|(path, _)| path).collect::<Vec<_>>();
                    trusted_watch_roots()
                        .write()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    stale
                }
            };
            if !stale_roots.is_empty() {
                self.invalidate_roots(&stale_roots);
            }
        }
        // An existing recursive watch on an ancestor already covers this root.
        // Registering every explicit file operand's parent as its own root
        // churned the WATCH_ROOT_MAX-bounded set (evict → invalidate
        // broadcast → client in-flight abort → retry → re-register), which
        // looped candidate-scoped fan-out greps indefinitely. Invalidation
        // stays correct: affected_roots/invalidate_roots match cache keys by
        // path overlap, so events under the ancestor reach descendant
        // operands. Refresh the covering root so hot ancestors stay resident.
        {
            let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(covering) = roots
                .keys()
                .find(|existing| root.starts_with(existing.as_path()))
                .cloned()
            {
                roots.insert(covering, Instant::now());
                return true;
            }
        }
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if watcher.is_none() {
            let weak: Weak<Self> = Arc::downgrade(self);
            let created =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let Some(store) = weak.upgrade() else { return };
                    let (paths, inventory_changed) = match event {
                        Ok(event) => {
                            let Some(change) = inventory_event_change(event) else {
                                return;
                            };
                            // Folder names do not establish exclusion from
                            // every active query. Let repair use each query's
                            // actual ignore/override rules instead.
                            change
                        }
                        Err(_) => {
                            store.watcher_healthy.store(false, Ordering::Release);
                            trusted_watch_roots()
                                .write()
                                .unwrap_or_else(|e| e.into_inner())
                                .clear();
                            (Vec::new(), true)
                        }
                    };
                    invalidate_content_signatures(&paths, inventory_changed);
                    invalidate_file_metadata(&paths, inventory_changed);
                    let changed = if inventory_changed {
                        if paths.is_empty() {
                            // Watcher failure/overflow has no exact repair
                            // boundary; preserve correctness with full eviction.
                            store.invalidate_paths(&paths)
                        } else {
                            store.schedule_inventory_repairs(&paths)
                        }
                    } else {
                        // Content/metadata changes invalidate JS grep and mtime
                        // result caches, but the file-name inventory is still
                        // current and remains reusable.
                        store.affected_roots(&paths)
                    };
                    if !changed.is_empty() {
                        write_response(&serde_json::json!({
                            "event": "invalidate",
                            "paths": changed.iter().map(|path| wire_path(path)).collect::<Vec<_>>()
                        }));
                    }
                });
            let Ok(created) = created else { return false };
            *watcher = Some(created);
            self.watcher_healthy.store(true, Ordering::Release);
        }
        // Never hold watched_roots across the OS watch/unwatch calls. Windows
        // may synchronously emit an initial notify callback from watch(); that
        // callback re-enters affected_roots/invalidate_paths and needs this
        // mutex. Holding it here deadlocked every concurrent directory search
        // until the outer 20s deadline killed the resident server.
        let evicted = {
            let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(touched) = roots.get_mut(&root) {
                *touched = Instant::now();
                return self.watcher_healthy.load(Ordering::Acquire);
            }
            if roots.len() >= WATCH_ROOT_MAX {
                let oldest = roots
                    .iter()
                    .min_by_key(|(_, touched)| **touched)
                    .map(|(path, _)| path.clone());
                if let Some(oldest) = oldest.as_ref() {
                    roots.remove(oldest);
                    trusted_watch_roots()
                        .write()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(oldest);
                }
                oldest
            } else {
                None
            }
        };
        if let Some(oldest) = evicted.as_ref() {
            if let Some(watcher) = watcher.as_mut() {
                let _ = watcher.unwatch(oldest);
            }
            self.invalidate_roots(std::slice::from_ref(oldest));
            write_response(&serde_json::json!({
                "event": "invalidate",
                "paths": [wire_path(oldest)],
            }));
        }
        let watched = watcher
            .as_mut()
            .is_some_and(|watcher| watcher.watch(&root, RecursiveMode::Recursive).is_ok());
        if watched {
            let mut trusted = trusted_watch_roots()
                .write()
                .unwrap_or_else(|e| e.into_inner());
            trusted.insert(root.clone());
            trusted.insert(watch_operand.to_path_buf());
            drop(trusted);
            self.watched_roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(root.clone(), Instant::now());
        }
        watched
    }
}

pub(super) fn is_ignore_rule_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    [".gitignore", ".ignore", "exclude"]
        .iter()
        .any(|candidate| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case(candidate)
            } else {
                name == *candidate
            }
        })
}

pub(super) fn inventory_event_change(event: notify::Event) -> Option<(Vec<PathBuf>, bool)> {
    if event.need_rescan() || matches!(event.kind, EventKind::Any | EventKind::Other) {
        return Some((Vec::new(), true));
    }
    inventory_changed_by_event(&event.kind, &event.paths).map(|changed| (event.paths, changed))
}

pub(super) fn inventory_changed_by_event(kind: &EventKind, paths: &[PathBuf]) -> Option<bool> {
    match kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) | EventKind::Remove(_) => {
            Some(true)
        }
        EventKind::Modify(ModifyKind::Data(_)) => {
            Some(paths.iter().any(|path| is_ignore_rule_path(path)))
        }
        // Windows reports attributes and security changes as Modify(Any).
        // Only an explicitly data-only notification can retain membership.
        EventKind::Modify(_) => Some(true),
        _ => None,
    }
}
