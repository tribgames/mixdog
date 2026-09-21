use super::test_support::request;
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn pending_walk() -> LiveWalk {
    LiveWalk {
        files: Mutex::new(Vec::new()),
        state: Mutex::new(LiveState::Running),
        cond: Condvar::new(),
        files_cond: Condvar::new(),
        waiters: AtomicUsize::new(0),
        cancelled: AtomicBool::new(false),
        enumeration_done: AtomicBool::new(false),
        keep_warm: AtomicBool::new(false),
        inventory_lease: InventoryLease::new(0, 0),
        cacheable: AtomicBool::new(true),
        walk_errors: AtomicUsize::new(0),
        walk_error_details: Mutex::new(Vec::new()),
        directory_failures: Mutex::new(Vec::new()),
        generation: 0,
        change_sequence: 0,
    }
}

#[test]
fn inventory_key_preserves_request_globs() {
    let first = request(&["--files", "--glob", "*.rs", "."], 20);
    let second = request(&["--files", "--glob", "*.ts", "."], 20);
    let first = parse_args(&first.args).unwrap();
    let second = parse_args(&second.args).unwrap();
    assert!(walk_key(Path::new("."), &first) != walk_key(Path::new("."), &second));
    assert!(fuzzy_key(Path::new("."), &first) != fuzzy_key(Path::new("."), &second));
}

#[test]
fn negative_globs_prune_the_walk_and_split_the_inventory_key() {
    let plain = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let excluded =
        parse_args(&request(&["--files", "--glob", "!**/node_modules/**", "."], 20).args).unwrap();
    let prune = prune_globs(Path::new("."), &excluded);
    // Preserve the original rule: synthesizing a parent exclusion would
    // prevent a later positive override from selecting its children.
    assert!(prune.iter().any(|glob| glob == "!**/node_modules/**"));
    assert!(walk_key(Path::new("."), &plain) != walk_key(Path::new("."), &excluded));
    assert!(prune_overrides(Path::new("."), &prune, &[]).is_some());
}

#[test]
fn git_directory_is_pruned_unless_the_caller_targets_it() {
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let prune = prune_globs(Path::new("."), &parsed);
    assert!(prune.iter().any(|glob| glob == "!**/.git"));
    assert!(prune.iter().any(|glob| glob == "!**/.git/**"));
    let inside = prune_globs(Path::new("repo/.git"), &parsed);
    assert!(inside.is_empty());
}

#[test]
fn descendant_operands_reuse_the_ancestor_watch_root() {
    let store = Arc::new(FileListStore::new());
    let dir = std::env::temp_dir().join("mixdog-watch-cover-test");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    assert!(store.watch_root(&dir));
    assert!(store.watch_root(&sub));
    assert_eq!(
        store
            .watched_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        1
    );
}

#[test]
fn filesystem_root_watch_is_unavailable_without_blocking_scoped_watches() {
    let store = Arc::new(FileListStore::new());
    let current = std::env::current_dir().unwrap();
    let root = current.ancestors().last().unwrap();
    assert!(!store.watch_root(root));
    let dir = std::env::temp_dir().join("mixdog-root-watch-scope-test");
    std::fs::create_dir_all(&dir).unwrap();
    assert!(store.watch_root(&dir));
    assert!(!store.watch_root(root));
    assert!(store.watch_root(&dir));
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn watcher_preserves_inventory_for_content_changes_only() {
    assert_eq!(
        inventory_changed_by_event(
            &EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any,)),
            &[]
        ),
        Some(false)
    );
    assert_eq!(
        inventory_changed_by_event(
            &EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Any,)),
            &[]
        ),
        Some(true)
    );
    assert_eq!(
        inventory_changed_by_event(&EventKind::Create(notify::event::CreateKind::Any), &[]),
        Some(true)
    );
    assert_eq!(
        inventory_changed_by_event(&EventKind::Remove(notify::event::RemoveKind::Any), &[]),
        Some(true)
    );
    assert_eq!(inventory_changed_by_event(&EventKind::Other, &[]), None);
}

#[test]
fn inventory_walk_parallelism_stays_bounded() {
    assert!((2..=4).contains(&inventory_walk_threads(Path::new("."))));
    let root = if cfg!(windows) {
        Path::new(r"C:\")
    } else {
        Path::new("/")
    };
    assert!((2..=12).contains(&inventory_walk_threads(root)));
}

#[test]
fn complete_inventory_wait_honors_request_cancellation() {
    let live = pending_walk();
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        wait_live_complete(&live, &cancelled, None).unwrap_err(),
        CANCELLED
    );
}

#[test]
fn complete_inventory_wait_honors_soft_deadline() {
    let live = pending_walk();
    let cancelled = AtomicBool::new(false);
    assert_eq!(
        wait_live_complete(
            &live,
            &cancelled,
            Some(Instant::now() - Duration::from_millis(1)),
        )
        .unwrap_err(),
        SOFT_TIMEOUT
    );
}

#[test]
fn last_waiter_cancels_normal_inventory_but_explicit_prewarm_survives() {
    let store = FileListStore::new();
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let key = walk_key(Path::new("."), &parsed);
    let (live, owner) = store.begin_live(key.clone(), false);
    assert!(owner);
    let (joined, owner) = store.begin_live(key.clone(), false);
    assert!(!owner);
    assert!(Arc::ptr_eq(&live, &joined));
    store.release_live(&key, &live);
    assert!(!live.cancelled.load(Ordering::Acquire));
    store.release_live(&key, &joined);
    assert!(live.cancelled.load(Ordering::Acquire));
    assert!(matches!(
        &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
        LiveState::Abandoned
    ));
    assert!(store
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .is_none());

    let warm_key = walk_key(Path::new("warm"), &parsed);
    let (warm, owner) = store.begin_live(warm_key.clone(), true);
    assert!(owner);
    store.release_live(&warm_key, &warm);
    assert!(!warm.cancelled.load(Ordering::Acquire));
    assert!(store
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&warm_key)
        .is_some());

    let inventory_key = walk_key(Path::new("inventory"), &parsed);
    let (inventory, owner) = store.begin_live_with_inventory(inventory_key.clone(), false, 60_000);
    assert!(owner);
    store.release_live(&inventory_key, &inventory);
    assert!(!inventory.cancelled.load(Ordering::Acquire));
    assert!(!inventory.keep_warm.load(Ordering::Acquire));
    assert!(inventory.inventory_lease.active(serve_search_uptime_ms()));
    assert!(store
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&inventory_key)
        .is_some());
}

#[test]
fn root_search_globs_filter_inventory_without_changing_the_match_set() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-root-filter-{nonce}"));
    std::fs::create_dir_all(dir.join("nested")).unwrap();
    std::fs::write(dir.join("target.mjs"), "one").unwrap();
    std::fs::write(dir.join("nested/target.mjs"), "two").unwrap();
    std::fs::write(dir.join("other.rs"), "other").unwrap();
    let drive = if cfg!(windows) {
        Path::new(r"C:\")
    } else {
        Path::new("/")
    };
    let parsed =
        parse_args(&request(&["--files", "--glob", "**/target.mjs", "."], 25).args).unwrap();
    let mut key = walk_key(&dir, &parsed);
    // Exercise the drive-root enumeration policy on a controlled tree.
    key.prune = prune_globs(drive, &parsed);
    let paths = scan_inventory_subtree(&key, &dir).unwrap();
    assert_eq!(paths.len(), 2);
    assert!(paths
        .iter()
        .all(|path| path.file_name().unwrap() == "target.mjs"));
    let other = parse_args(&request(&["--files", "--glob", "**/*.rs", "."], 25).args).unwrap();
    key.prune = prune_globs(drive, &other);
    let paths = scan_inventory_subtree(&key, &dir).unwrap();
    assert_eq!(paths, vec![dir.join("other.rs")]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalidation_detaches_active_snapshot_without_dropping_its_waiter() {
    let store = FileListStore::new();
    let root = PathBuf::from("mutable-root");
    store
        .watched_roots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.clone(), Instant::now());
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let key = walk_key(&root, &parsed);
    let (live, owner) = store.begin_live(key.clone(), false);
    assert!(owner);

    assert_eq!(
        store.invalidate_paths(&[root.join("changed.log")]),
        vec![root.clone()]
    );
    assert!(!live.cancelled.load(Ordering::Acquire));
    assert!(matches!(
        &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
        LiveState::Running
    ));
    assert!(store
        .live
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .is_none());

    let snapshot = Arc::new(vec![root.join("snapshot.log")]);
    assert!(!store.finish_live(key.clone(), &live, Ok(snapshot)));
    assert!(matches!(
        &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
        LiveState::Done(files) if files.len() == 1
    ));
    assert!(store.take_ready(&key).is_none());
    store.release_live(&key, &live);
}

#[test]
fn inventory_repair_during_walk_preserves_ignore_and_hidden_rules() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-live-repair-{nonce}"));
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".gitignore"), "ignored/\n").unwrap();
    let first = dir.join("first.mjs");
    std::fs::write(&first, "needle\n").unwrap();
    let mut req = request(&["--files", "--glob", "*.mjs", "."], 0);
    req.cwd = dir.to_string_lossy().into_owned();
    let parsed = parse_args(&req.args).unwrap();
    let key = walk_key(&dir, &parsed);
    let store = Arc::new(FileListStore::new());
    assert!(store.watch_root(&dir));
    let (live, _) = store.begin_live(key.clone(), false);
    let original = Arc::new(vec![first]);
    let added = dir.join("added.mjs");
    let ignored = dir.join("ignored");
    let hidden = dir.join(".hidden");
    std::fs::write(&added, "needle\n").unwrap();
    std::fs::create_dir_all(&ignored).unwrap();
    std::fs::create_dir_all(&hidden).unwrap();
    std::fs::write(ignored.join("skipped.mjs"), "needle\n").unwrap();
    std::fs::write(hidden.join("skipped.mjs"), "needle\n").unwrap();
    store.schedule_inventory_repairs(&[added, ignored, hidden]);
    live.enumeration_done.store(true, Ordering::Release);
    store.finish_live(key.clone(), &live, Ok(original));
    store.release_live(&key, &live);
    let cached = handle(&req, &AtomicBool::new(false), &store, None).unwrap();
    let fresh_store = Arc::new(FileListStore::new());
    let fresh = handle(&req, &AtomicBool::new(false), &fresh_store, None).unwrap();
    let ordered = |value: &serde_json::Value| {
        let mut lines = value["lines"].as_array().unwrap().clone();
        lines.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        lines
    };
    assert_eq!(ordered(&cached), ordered(&fresh));
    assert_eq!(cached["lines"].as_array().unwrap().len(), 2);
    assert_eq!(cached["complete"], true);
    drop(store);
    drop(fresh_store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lost_notifications_cannot_republish_an_obsolete_repair() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-rescan-repair-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    let actual = dir.join("actual.txt");
    std::fs::write(&actual, "needle\n").unwrap();
    let mut req = request(&["--files", "."], 0);
    req.cwd = dir.to_string_lossy().into_owned();
    let parsed = parse_args(&req.args).unwrap();
    let key = walk_key(&dir, &parsed);
    let store = Arc::new(FileListStore::new());
    let events = [
        notify::Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Any,
        )))
        .add_path(actual.clone())
        .set_flag(notify::event::Flag::Rescan),
        notify::Event::new(EventKind::Any).add_path(actual.clone()),
        notify::Event::new(EventKind::Other).add_path(actual.clone()),
    ];
    for event in events {
        let before = handle(&req, &AtomicBool::new(false), &store, None).unwrap();
        let old = Arc::new(());
        let replacement = Arc::new(());
        let make_job = |token| PendingInventoryRepair {
            base: Arc::new(vec![actual.clone()]),
            directory_failures: Arc::new(Vec::new()),
            paths: HashSet::new(),
            processing: true,
            token,
        };
        store
            .pending_repairs
            .lock()
            .unwrap()
            .insert(key.clone(), make_job(Arc::clone(&old)));
        let (paths, inventory_changed) = inventory_event_change(event).unwrap();
        assert!(inventory_changed);
        store.invalidate_paths(&paths);
        // Old work must be harmless both before and after a replacement
        // job reuses the same key.
        store.finish_inventory_repair(&key, &old, Ok(Arc::new(vec![dir.join("obsolete.txt")])));
        store
            .pending_repairs
            .lock()
            .unwrap()
            .insert(key.clone(), make_job(Arc::clone(&replacement)));
        store.finish_inventory_repair(&key, &old, Ok(Arc::new(vec![dir.join("obsolete.txt")])));
        store.finish_inventory_repair(&key, &replacement, Ok(Arc::new(vec![actual.clone()])));
        let after = handle(&req, &AtomicBool::new(false), &store, None).unwrap();
        assert_eq!(after["complete"], true);
        assert_eq!(after["lines"], before["lines"]);
    }
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn inventory_with_walk_errors_is_never_cached_as_complete() {
    let store = FileListStore::new();
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let key = walk_key(Path::new("partial"), &parsed);
    let (live, owner) = store.begin_live(key.clone(), false);
    assert!(owner);
    live.walk_errors.store(1, Ordering::Release);
    assert!(!store.finish_live(
        key.clone(),
        &live,
        Ok(Arc::new(vec![PathBuf::from("partial/visible.rs")])),
    ));
    assert!(store.take_ready(&key).is_none());
    assert_eq!(live.walk_errors.load(Ordering::Acquire), 1);
}

#[test]
fn streaming_and_complete_waiters_share_one_walk_without_panicking() {
    let store = FileListStore::new();
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let key = walk_key(Path::new("shared"), &parsed);
    let (live, owner) = store.begin_live(key.clone(), false);
    assert!(owner);

    // Complete-inventory waiter binds `cond` to the state mutex on its own
    // thread while this thread streams via `files_cond`/`files`. Before the
    // condvars were split this combination panicked and the search died.
    let complete = std::thread::spawn({
        let live = Arc::clone(&live);
        move || {
            let cancelled = AtomicBool::new(false);
            wait_live_complete(&live, &cancelled, None)
        }
    });
    std::thread::sleep(Duration::from_millis(30));

    publish_live_files(&live, &[PathBuf::from("streamed.rs")]);
    {
        let files = live.files.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(files.len(), 1);
        let (files, _) = live
            .files_cond
            .wait_timeout(files, Duration::from_millis(10))
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(files.len(), 1);
    }

    assert!(store.finish_live(key, &live, Ok(Arc::new(vec![PathBuf::from("streamed.rs")])),));
    let completed = complete
        .join()
        .expect("complete waiter must not panic")
        .expect("walk must finish")
        .expect("walk must produce files");
    assert_eq!(completed.len(), 1);
}

#[test]
fn watched_inventory_survives_ttl_until_watch_is_removed() {
    let store = FileListStore::new();
    let root = PathBuf::from("watched-ttl-root");
    let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
    let key = walk_key(&root, &parsed);
    store
        .watched_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(root.clone(), Instant::now());
    store
        .ready
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            key.clone(),
            ReadyEntry {
                files: Arc::new(vec![root.join("cached.rs")]),
                directory_failures: Arc::new(Vec::new()),
                expires_at: Instant::now() - Duration::from_secs(1),
                generation: 0,
                touched_at: Instant::now(),
                estimated_bytes: 1,
                root_identity: None,
            },
        );

    assert_eq!(store.take_ready(&key).map(|files| files.len()), Some(1));
    store
        .watched_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
    assert!(store.take_ready(&key).is_none());
}

#[test]
fn incremental_inventory_repair_splices_changed_paths() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "mixdog-inventory-repair-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("fixture root");
    let keep = root.join("keep.rs");
    let removed = root.join("removed.rs");
    let added = root.join("added.rs");
    std::fs::write(&keep, "keep").expect("keep");
    std::fs::write(&added, "added").expect("added");
    let parsed =
        parse_args(&request(&["--files", root.to_string_lossy().as_ref()], 20).args).unwrap();
    let key = walk_key(&root, &parsed);
    let mut base = vec![keep.clone(), removed.clone()];
    base.sort();

    let repaired = repair_inventory(&key, &base, &[removed, added.clone()]).expect("repair");
    assert_eq!(repaired.as_ref(), &vec![added, keep]);
    std::fs::remove_dir_all(root).ok();
}
