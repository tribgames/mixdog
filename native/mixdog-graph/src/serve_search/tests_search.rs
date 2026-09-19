use super::test_support::request;
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
#[test]
fn path_prefix_checks_are_utf8_boundary_safe() {
    assert!(path_starts_with(
        Path::new(r"C:\한\child"),
        Path::new(r"C:\한"),
    ));
    assert!(!path_starts_with(
        Path::new(r"C:\€\child"),
        Path::new(r"C:\é"),
    ));
}

#[test]
fn overrides_preserve_ignore_precedence_and_rule_order() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-overrides-{nonce}"));
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::create_dir_all(dir.join(".cache")).unwrap();
    std::fs::write(dir.join(".gitignore"), "*.mjs\n").unwrap();
    for name in ["keep.mjs", "drop.mjs", ".cache/hit.mjs", "other.RS"] {
        std::fs::write(dir.join(name), "needle\n").unwrap();
    }
    let store = Arc::new(FileListStore::new());
    for (flags, expected) in [
        (
            vec!["--glob", "*.mjs"],
            vec![".cache/hit.mjs", "drop.mjs", "keep.mjs"],
        ),
        (
            vec!["--glob", "*.mjs", "--glob", "!drop.mjs"],
            vec![".cache/hit.mjs", "keep.mjs"],
        ),
        (
            vec!["--glob", "!drop.mjs", "--glob", "*.mjs"],
            vec![".cache/hit.mjs", "drop.mjs", "keep.mjs"],
        ),
        (
            vec!["--glob", "!**/.cache/**", "--glob", "*.mjs"],
            vec![".cache/hit.mjs", "drop.mjs", "keep.mjs"],
        ),
        (
            vec!["--glob", "*.mjs", "--glob", "!**/.cache/**"],
            vec!["drop.mjs", "keep.mjs"],
        ),
        (
            vec!["--glob", "keep.mjs", "--iglob", "*.rs"],
            vec!["keep.mjs", "other.RS"],
        ),
    ] {
        for mode in ["--files", "-l"] {
            let mut args = vec!["--hidden", mode];
            if mode == "-l" {
                args.extend(["-e", "needle"]);
            }
            args.extend(flags.iter().copied());
            args.push(".");
            let mut req = request(&args, 0);
            req.cwd = dir.to_string_lossy().into_owned();
            let response = handle(&req, &AtomicBool::new(false), &store, None).unwrap();
            assert_eq!(response["complete"], true, "{response}");
            let mut actual = response["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| {
                    line.as_str()
                        .unwrap()
                        .replace('\\', "/")
                        .trim_start_matches("./")
                        .to_string()
                })
                .collect::<Vec<_>>();
            actual.sort();
            assert_eq!(actual, expected, "{args:?}");
        }
    }
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unlimited_grep_scans_before_inventory_completion() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-stream-grep-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("early.txt");
    std::fs::write(&path, "needle\n").unwrap();
    let mut req = request(&["-l", "-e", "needle", "."], 0);
    req.cwd = dir.to_string_lossy().into_owned();
    let parsed = parse_args(&req.args).unwrap();
    let store = Arc::new(FileListStore::new());
    store.watch_root(&dir);
    let key = walk_key(&dir, &parsed);
    let (live, _) = store.begin_live(key.clone(), true);
    let mut batch = WorkerWalkBatch::new(&live, inventory_publish_batch());
    batch.push(path.clone());
    let response = handle(
        &req,
        &AtomicBool::new(false),
        &store,
        Some(Instant::now() + Duration::from_millis(250)),
    )
    .unwrap();
    assert_eq!(response["filesScanned"], 1, "{response}");
    assert_eq!(response["lines"].as_array().unwrap().len(), 1);
    assert_eq!(response["timeout"], true);
    assert_eq!(response["complete"], false);
    drop(batch);
    store.finish_live(key.clone(), &live, Ok(Arc::new(vec![path])));
    store.release_live(&key, &live);
    let complete = handle(&req, &AtomicBool::new(false), &store, None).unwrap();
    assert_eq!(complete["complete"], true, "{complete}");
    assert_eq!(complete["lines"], response["lines"]);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn fuzzy_ascii_prefilter_rejects_only_impossible_candidates() {
    assert!(fuzzy_ascii_subsequence_possible(
        "TLSMOKE",
        "scripts/tool-smoke.mjs"
    ));
    assert!(!fuzzy_ascii_subsequence_possible(
        "tool-smoke",
        "scripts/trace-store.mjs"
    ));
    // Unicode stays on Nucleo's Smart-normalization path.
    assert!(fuzzy_ascii_subsequence_possible("resume", "src/résumé.rs"));
}

#[test]
fn exact_file_search_skips_parent_watch_and_stays_complete() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mixdog-exact-file-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("mountinfo");
    std::fs::write(&file, "overlay / overlay\n").unwrap();
    let store = Arc::new(FileListStore::new());
    let cancelled = AtomicBool::new(false);
    let req = request(
        &[
            "--no-heading",
            "--line-number",
            "-e",
            "overlay",
            "--",
            &file.to_string_lossy(),
        ],
        20,
    );

    let response = handle(&req, &cancelled, &store, None).unwrap();

    assert_eq!(response["complete"], true);
    assert_eq!(response["partial"], false);
    assert_eq!(response["cacheSafe"], false);
    assert!(response["lines"]
        .as_array()
        .is_some_and(|lines| lines.iter().any(|line| {
            line.as_str()
                .is_some_and(|value| value.contains("overlay / overlay"))
        })));
    assert!(store
        .watched_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unreadable_file_counts_a_scan_error_instead_of_silent_no_match() {
    let parsed = parse_args(&request(&["-e", "x", "."], 10).args).unwrap();
    let matcher = build_matcher(&parsed).unwrap();
    let cancelled = AtomicBool::new(false);
    let scan_errors = AtomicUsize::new(0);
    // A file that vanished (or is unreadable) between the walk and the
    // scan: the scan yields None, but the error counter must record that
    // this file was skipped rather than searched-and-empty.
    let missing = std::env::temp_dir().join("mg-vanished-during-walk.txt");
    std::fs::remove_file(&missing).ok();
    assert!(scan_file(
        &missing,
        "",
        &matcher,
        &parsed,
        &cancelled,
        None,
        None,
        &TrustSnapshot {
            usn_volumes: Arc::new(HashSet::new()),
            watch_roots: Arc::new(Vec::new()),
        },
        &scan_errors,
    )
    .is_none());
    assert_eq!(scan_errors.load(Ordering::Relaxed), 1);
}

#[test]
fn expired_deadline_never_reports_a_silent_complete_empty_result() {
    let dir = std::env::temp_dir().join(format!("mg-deadline-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("sample.py");
    std::fs::write(&file, "raise ValueError\n").unwrap();
    let store = Arc::new(FileListStore::new());
    let cancelled = AtomicBool::new(false);
    let mut req = request(
        &[
            "--no-heading",
            "--line-number",
            "-e",
            "raise",
            "--",
            &file.to_string_lossy(),
        ],
        50,
    );
    req.cwd = dir.to_string_lossy().into_owned();
    // scan_standard swallows a mid-scan TimedOut read error into `None`
    // ("no matches in this file"); the response-level deadline re-check
    // must still surface partial/timeout instead of complete-empty.
    let expired = Some(Instant::now() - Duration::from_millis(1));
    let response = handle(&req, &cancelled, &store, expired).unwrap();
    assert_eq!(response["timeout"], true);
    assert_eq!(response["partial"], true);
    assert_eq!(response["complete"], false);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn broad_search_mtime_deadline_and_cancellation_are_not_complete_results() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-mtime-deadline-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("needle.txt"), "needle\n").unwrap();
    let store = Arc::new(FileListStore::new());
    let cancelled = AtomicBool::new(false);
    let mut req = request(&["--files", "."], 10);
    req.cwd = dir.to_string_lossy().into_owned();
    req.mtime_top_k = true;
    let warm = handle(&req, &cancelled, &store, None).unwrap();
    assert_eq!(warm["complete"], true);
    assert_eq!(warm["lines"].as_array().unwrap().len(), 1);
    let expired = Some(Instant::now() - Duration::from_millis(1));
    let response = handle(&req, &cancelled, &store, expired).unwrap();
    assert_eq!(response["complete"], false);
    assert_eq!(response["partial"], true);
    assert_eq!(response["timeout"], true);
    cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        handle(&req, &cancelled, &store, None).unwrap_err(),
        CANCELLED
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn root_search_windows_paths_are_relative_without_device_prefixes() {
    let normal = Path::new(r"C:\Project\mixdog\한글.mjs");
    let verbatim = Path::new(r"\\?\C:\Project\mixdog\한글.mjs");
    let root = Path::new(r"c:\project\mixdog");
    assert_eq!(
        relative_inventory_path(normal, root),
        Some("한글.mjs".to_string())
    );
    assert_eq!(
        relative_inventory_path(verbatim, root),
        Some("한글.mjs".to_string())
    );
    assert_eq!(display_path(".", root, verbatim), ".\\한글.mjs");
    assert!(path_starts_with(verbatim, Path::new(r"C:\")));
    assert!(!path_starts_with(normal, Path::new(r"C:\Project\mix")));
    assert_eq!(
        relative_inventory_path(
            Path::new(r"\\?\UNC\server\share\leaf"),
            Path::new(r"\\server\share")
        ),
        Some("leaf".to_string()),
    );
}

#[test]
fn root_search_waits_for_completion_in_the_same_call_past_three_seconds() {
    let root = if cfg!(windows) {
        Path::new(r"C:\")
    } else {
        Path::new("/")
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let scope = std::env::temp_dir().join(format!("mg-same-call-{nonce}"));
    std::fs::create_dir_all(&scope).unwrap();
    let path = scope.join("same-call-result.txt");
    std::fs::write(&path, "result").unwrap();
    let mut req = request(&["--files", scope.to_str().unwrap()], 25);
    req.cwd = root.to_string_lossy().into_owned();
    let parsed = parse_args(&req.args).unwrap();
    let key = walk_key(&scope, &parsed);
    let store = Arc::new(FileListStore::new());
    // Root cwd exercises the old three-second policy; the operand stays
    // inside a quiet fixture rather than depending on live drive changes.
    store.watch_root(&scope);
    let (live, _) = store.begin_live(key.clone(), false);
    let producer_store = Arc::clone(&store);
    let producer_live = Arc::clone(&live);
    let producer_key = key.clone();
    let producer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3200));
        let files = Arc::new(vec![path]);
        publish_live_files(&producer_live, &files);
        producer_live
            .enumeration_done
            .store(true, Ordering::Release);
        producer_store.finish_live(producer_key.clone(), &producer_live, Ok(files));
        producer_store.release_live(&producer_key, &producer_live);
    });
    let result = handle(
        &req,
        &AtomicBool::new(false),
        &store,
        Some(Instant::now() + Duration::from_secs(8)),
    )
    .unwrap();
    producer.join().unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(result["partial"], false);
    assert!(result["lines"][0]
        .as_str()
        .unwrap()
        .ends_with("same-call-result.txt"));
    std::fs::remove_dir_all(scope).unwrap();
}

#[test]
fn broad_search_mtime_order_tracks_updates_without_content_reads() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-mtime-order-{nonce}"));
    std::fs::create_dir_all(&dir).unwrap();
    let older = dir.join("older.txt");
    let newer = dir.join("newer.txt");
    std::fs::write(&older, "old").unwrap();
    std::fs::write(&newer, "new").unwrap();
    File::options()
        .write(true)
        .open(&older)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(1000))
        .unwrap();
    File::options()
        .write(true)
        .open(&newer)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(2000))
        .unwrap();
    let trust = TrustSnapshot {
        usn_volumes: Arc::new(HashSet::new()),
        watch_roots: Arc::new(Vec::new()),
    };
    assert!(file_mtime_ms(&older, &trust).unwrap() < file_mtime_ms(&newer, &trust).unwrap());
    File::options()
        .write(true)
        .open(&older)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(3000))
        .unwrap();
    assert!(file_mtime_ms(&older, &trust).unwrap() > file_mtime_ms(&newer, &trust).unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn fuzzy_inventory_includes_symlink_leaves_without_following_symlink_directories() {
    use std::os::unix::fs::symlink;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mg-fuzzy-links-{nonce}"));
    let outside = std::env::temp_dir().join(format!("mg-fuzzy-links-outside-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("real-tool");
    std::fs::write(&outside_file, "tool\n").unwrap();
    std::fs::write(outside.join("nested-only-marker"), "nested\n").unwrap();
    symlink(&outside_file, root.join("tool-link")).unwrap();
    symlink(&outside, root.join("external-dir-link")).unwrap();

    let store = Arc::new(FileListStore::new());
    let cancelled = AtomicBool::new(false);
    let mut req = request(&[], 10);
    req.cwd = root.to_string_lossy().into_owned();
    req.fuzzy = Some("tool-link".to_string());
    req.hidden = true;
    req.include_noise = true;
    req.keep_inventory = true;

    let linked_file = handle_fuzzy(&req, &cancelled, &store, None).unwrap();
    assert_eq!(linked_file["complete"], true);
    assert!(linked_file["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|path| path.as_str() == Some("tool-link")));

    req.fuzzy = Some("nested-only-marker".to_string());
    let linked_directory = handle_fuzzy(&req, &cancelled, &store, None).unwrap();
    assert_eq!(linked_directory["complete"], true);
    assert!(linked_directory["matches"].as_array().unwrap().is_empty());

    std::fs::remove_dir_all(&root).ok();
    std::fs::remove_dir_all(&outside).ok();
}

#[cfg(windows)]
#[test]
fn failed_directory_inventory_preserves_results_and_rechecks_recovery() {
    use std::os::windows::fs::OpenOptionsExt;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mg-retry-directory-{nonce}"));
    let blocked = dir.join("blocked");
    std::fs::create_dir_all(&blocked).unwrap();
    std::fs::write(dir.join("visible.txt"), "needle\n").unwrap();
    std::fs::write(blocked.join("recovered.txt"), "needle\n").unwrap();
    let mut req = request(&["-l", "-e", "needle", "."], 0);
    req.cwd = dir.to_string_lossy().into_owned();
    let store = Arc::new(FileListStore::new());
    assert!(store.watch_root(&dir));
    // A private fixture handle prevents directory enumeration without
    // changing ACLs or requiring administrator privileges.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(0x02000000)
        .open(&blocked)
        .unwrap();
    assert!(std::fs::read_dir(&blocked).is_err());
    let cancelled = AtomicBool::new(false);
    let first = handle(&req, &cancelled, &store, None).unwrap();
    let repeat = handle(&req, &cancelled, &store, None).unwrap();
    assert_eq!(first["lines"], repeat["lines"]);
    assert_eq!(first["lines"].as_array().unwrap().len(), 1);
    assert_eq!(repeat["complete"], false);
    assert_eq!(repeat["partial"], true);
    assert_eq!(repeat["timeout"], false);
    assert_eq!(first["scanErrors"], repeat["scanErrors"]);
    assert_eq!(first["walkErrorDetails"], repeat["walkErrorDetails"]);

    std::fs::write(dir.join("added.txt"), "needle\n").unwrap();
    store.invalidate_paths(&[dir.join("added.txt")]);
    let changed = handle(&req, &cancelled, &store, None).unwrap();
    assert_eq!(changed["lines"].as_array().unwrap().len(), 2);
    assert_eq!(changed["complete"], false);
    drop(lock);
    // Access recovery does not depend on a filesystem notification.
    let recovered = handle(&req, &cancelled, &store, None).unwrap();
    assert_eq!(recovered["lines"].as_array().unwrap().len(), 3);
    assert_eq!(recovered["complete"], true);
    assert_eq!(recovered["scanErrors"], 0);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
