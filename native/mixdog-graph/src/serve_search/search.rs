// Request execution: resolve an operand to files (cached, live or
// streamed), scan them, and assemble the JSON response.
use super::*;

pub(super) fn contain_search_panic<T, F>(label: &str, run: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    catch_unwind(AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err(format!("{label} panicked; request isolated")))
}

pub(super) fn complete_operand_files(
    store: &Arc<FileListStore>,
    operand_path: &Path,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    keep_warm: bool,
) -> Result<(Arc<Vec<PathBuf>>, bool, usize, Vec<String>, bool), String> {
    let watched = store.watch_root(operand_path);
    // A walk abandoned by cache invalidation restarts from scratch. Under
    // continuous writes under the root that can repeat until the request
    // deadline, so cap it: after one restart the partial snapshot is served
    // instead of burning the whole budget on re-walks.
    const MAX_WALK_RESTARTS: usize = 1;
    let mut restarts = 0usize;
    loop {
        let key = walk_key(operand_path, parsed);
        if let Some(hit) = store.take_ready(&key) {
            return Ok((hit, true, 0, Vec::new(), watched));
        }
        let (live, owner) = store.begin_live(key.clone(), keep_warm);
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                key,
                Arc::clone(&live),
                operand_path.to_path_buf(),
                parsed.clone(),
            );
        }
        match wait_live_complete(&live, cancelled, deadline_at) {
            Ok(Some(files)) => {
                return Ok((
                    files,
                    true,
                    live.walk_errors.load(Ordering::Acquire),
                    live_walk_error_details(&live),
                    live.cacheable.load(Ordering::Acquire),
                ))
            }
            Ok(None) => {
                restarts += 1;
                if restarts > MAX_WALK_RESTARTS {
                    let snapshot = live.files.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    return Ok((
                        Arc::new(snapshot),
                        false,
                        live.walk_errors.load(Ordering::Acquire),
                        live_walk_error_details(&live),
                        false,
                    ));
                }
                continue;
            }
            Err(reason) if reason == SOFT_TIMEOUT => {
                let snapshot = live.files.lock().unwrap_or_else(|e| e.into_inner()).clone();
                return Ok((
                    Arc::new(snapshot),
                    false,
                    live.walk_errors.load(Ordering::Acquire),
                    live_walk_error_details(&live),
                    false,
                ));
            }
            Err(reason) => return Err(reason),
        }
    }
}

pub(super) fn scan_streaming_operand(
    store: &Arc<FileListStore>,
    operand: &str,
    operand_path: &Path,
    parsed: &ParsedArgs,
    filter: &PathFilter,
    matcher: &CompiledMatcher,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    keep_warm: bool,
    use_prefix: bool,
    all_lines: &mut Vec<String>,
    emitted_blocks: &mut usize,
    collect_until: usize,
    scan_errors: &AtomicUsize,
    files_scanned: &AtomicUsize,
) -> Result<(bool, bool, bool, Vec<String>), String> {
    let watched = store.watch_root(operand_path);
    let trust = TrustSnapshot::capture();
    if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
        return Ok((false, true, watched, Vec::new()));
    }
    let key = walk_key(operand_path, parsed);
    if let Some(files) = store.take_ready(&key) {
        let reached_limit = append_scanned_matches_unordered(
            &files,
            operand,
            operand_path,
            use_prefix,
            matcher,
            parsed,
            filter,
            cancelled,
            deadline_at,
            all_lines,
            emitted_blocks,
            collect_until,
            &trust,
            scan_errors,
            files_scanned,
        );
        let timed_out = deadline_at.is_some_and(|deadline| Instant::now() >= deadline);
        return Ok((reached_limit, timed_out, watched, Vec::new()));
    }
    let (live, owner) = store.begin_live(key.clone(), keep_warm);
    if !watched {
        live.cacheable.store(false, Ordering::Release);
    }
    let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
    if owner {
        start_live_walk(
            Arc::clone(store),
            key,
            Arc::clone(&live),
            operand_path.to_path_buf(),
            parsed.clone(),
        );
    }
    let mut cursor = 0usize;
    let account_walk_errors = || {
        let count = live.walk_errors.load(Ordering::Acquire);
        if count > 0 {
            scan_errors.fetch_add(count, Ordering::Relaxed);
        }
    };
    let outcome = |reached_limit, timed_out| {
        (
            reached_limit,
            timed_out,
            live.cacheable.load(Ordering::Acquire),
            live_walk_error_details(&live),
        )
    };
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            account_walk_errors();
            return Ok(outcome(false, true));
        }
        let batch = {
            let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
            while cursor >= files.len() {
                let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                match &*state {
                    LiveState::Done(_) => {
                        account_walk_errors();
                        return Ok(outcome(false, false));
                    }
                    LiveState::Abandoned => return Err(CANCELLED.to_string()),
                    LiveState::Failed(error) => return Err(error.clone()),
                    LiveState::Running => {}
                }
                drop(state);
                let waited = live
                    .files_cond
                    .wait_timeout(files, Duration::from_millis(10))
                    .unwrap_or_else(|e| e.into_inner());
                files = waited.0;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                    account_walk_errors();
                    return Ok(outcome(false, true));
                }
            }
            let batch = files[cursor..].to_vec();
            cursor = files.len();
            batch
        };
        let reached_limit = append_scanned_matches_unordered(
            &batch,
            operand,
            operand_path,
            use_prefix,
            matcher,
            parsed,
            filter,
            cancelled,
            deadline_at,
            all_lines,
            emitted_blocks,
            collect_until,
            &trust,
            scan_errors,
            files_scanned,
        );
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            account_walk_errors();
            return Ok(outcome(reached_limit, true));
        }
        if reached_limit {
            account_walk_errors();
            return Ok(outcome(true, false));
        }
    }
}

pub(super) fn handle(
    req: &ServeRequest,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    if req.fuzzy.is_some() {
        return handle_fuzzy(req, cancelled, store, deadline_at);
    }
    let parsed = parse_args(&req.args)?;
    refresh_content_signature_journals(&parsed.targets, Path::new(&req.cwd));
    if parsed.files_list && req.mtime_top_k && req.limit > 0 {
        return handle_mtime_inventory(req, &parsed, cancelled, store, deadline_at);
    }
    let collect_until = if req.limit > 0 {
        req.offset.saturating_add(req.limit).saturating_add(1)
    } else {
        usize::MAX
    };
    // Inventory mode for glob/find: consume paths as the two-thread walker
    // discovers them while the shared inventory continues to completion.
    if parsed.files_list {
        let cwd = Path::new(&req.cwd);
        let mut all_lines: Vec<String> = Vec::new();
        let mut timed_out = false;
        let mut scan_error_count = 0usize;
        let mut walk_error_details = Vec::new();
        let mut cache_safe = true;
        for operand in &parsed.targets {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                break;
            }
            let operand_path = if Path::new(operand).is_absolute() {
                PathBuf::from(operand)
            } else {
                cwd.join(operand)
            };
            let watched = store.watch_root(&operand_path);
            cache_safe &= watched;
            let filter = PathFilter::new(&operand_path, &parsed)?;
            if collect_until == usize::MAX {
                let (files, complete, walk_errors, details, operand_cache_safe) =
                    complete_operand_files(
                        store,
                        &operand_path,
                        &parsed,
                        cancelled,
                        deadline_at,
                        req.keep_warm,
                    )?;
                cache_safe &= operand_cache_safe;
                scan_error_count = scan_error_count.saturating_add(walk_errors);
                append_walk_error_details(&mut walk_error_details, details);
                for file in files.iter().filter(|file| filter.allows(file)) {
                    all_lines.push(display_path(operand, &operand_path, file));
                }
                if !complete {
                    timed_out = true;
                }
            } else {
                let key = walk_key(&operand_path, &parsed);
                if let Some(files) = store.take_ready(&key) {
                    for file in files.iter().filter(|file| filter.allows(file)) {
                        all_lines.push(display_path(operand, &operand_path, file));
                        if all_lines.len() >= collect_until {
                            break;
                        }
                    }
                } else {
                    let (live, owner) = store.begin_live(key.clone(), req.keep_warm);
                    if !watched {
                        live.cacheable.store(false, Ordering::Release);
                    }
                    let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
                    if owner {
                        start_live_walk(
                            Arc::clone(store),
                            key,
                            Arc::clone(&live),
                            operand_path.clone(),
                            parsed.clone(),
                        );
                    }
                    let mut cursor = 0usize;
                    'inventory: loop {
                        let batch = {
                            let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
                            while cursor >= files.len() {
                                let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                                match &*state {
                                    LiveState::Done(_) => break 'inventory,
                                    LiveState::Abandoned => {
                                        return Err(CANCELLED.to_string());
                                    }
                                    LiveState::Failed(error) => return Err(error.clone()),
                                    LiveState::Running => {}
                                }
                                drop(state);
                                files = live
                                    .files_cond
                                    .wait_timeout(files, Duration::from_millis(10))
                                    .unwrap_or_else(|e| e.into_inner())
                                    .0;
                                if cancelled.load(Ordering::Relaxed) {
                                    return Err(CANCELLED.to_string());
                                }
                                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                                    timed_out = true;
                                    break 'inventory;
                                }
                            }
                            let batch = files[cursor..].to_vec();
                            cursor = files.len();
                            batch
                        };
                        for file in batch.iter().filter(|file| filter.allows(file)) {
                            all_lines.push(display_path(operand, &operand_path, file));
                            if all_lines.len() >= collect_until {
                                break 'inventory;
                            }
                        }
                        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                            timed_out = true;
                            break 'inventory;
                        }
                    }
                    scan_error_count =
                        scan_error_count.saturating_add(live.walk_errors.load(Ordering::Acquire));
                    cache_safe &= live.cacheable.load(Ordering::Acquire);
                    append_walk_error_details(
                        &mut walk_error_details,
                        live_walk_error_details(&live),
                    );
                }
            }
            if timed_out || all_lines.len() >= collect_until {
                break;
            }
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let timed_out = timed_out || deadline_at.is_some_and(|deadline| Instant::now() >= deadline);
        let total_after_offset = all_lines.len().saturating_sub(req.offset);
        let window: Vec<&String> = all_lines
            .iter()
            .skip(req.offset)
            .take(if req.limit > 0 { req.limit } else { usize::MAX })
            .collect();
        let complete = !timed_out
            && scan_error_count == 0
            && all_lines.len() < collect_until
            && (req.limit == 0 || total_after_offset <= req.limit);
        return Ok(serde_json::json!({
            "id": req.id,
            "lines": window,
            "complete": complete,
            "totalSeen": total_after_offset,
            "partial": timed_out || scan_error_count > 0,
            "timeout": timed_out,
            "scanErrors": scan_error_count,
            "walkErrorDetails": walk_error_details,
            "inventoryChecked": complete,
            "cacheSafe": cache_safe,
        }));
    }
    let matcher = build_matcher(&parsed)?;
    let cwd = Path::new(&req.cwd);
    refresh_content_signature_journals(&parsed.targets, cwd);
    let multi_target = parsed.targets.len() > 1;
    let mut all_lines: Vec<String> = Vec::new();
    let mut emitted_blocks = 0usize;
    let mut timed_out = false;
    let scan_errors = AtomicUsize::new(0);
    // Observability for silent-empty diagnosis: how many files the scan loops
    // actually opened. An empty result with filesScanned=0 on a scope that
    // demonstrably contains files is a server-state anomaly, not a no-match
    // (observed once in the wild; JS retries that signature once).
    let files_scanned = AtomicUsize::new(0);
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;
    'operands: for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            timed_out = true;
            break;
        }
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let use_prefix = parsed.with_filename
            || parsed.files_with_matches
            || multi_target
            || operand_path.is_dir();
        let filter = PathFilter::new(&operand_path, &parsed)?;
        {
            let (reached_limit, operand_timed_out, operand_cache_safe, details) =
                scan_streaming_operand(
                    store,
                    operand,
                    &operand_path,
                    &parsed,
                    &filter,
                    &matcher,
                    cancelled,
                    deadline_at,
                    req.keep_warm,
                    use_prefix,
                    &mut all_lines,
                    &mut emitted_blocks,
                    collect_until,
                    &scan_errors,
                    &files_scanned,
                )?;
            cache_safe &= operand_cache_safe;
            append_walk_error_details(&mut walk_error_details, details);
            if operand_timed_out {
                timed_out = true;
                break 'operands;
            }
            if reached_limit {
                break 'operands;
            }
            if all_lines.len() >= collect_until {
                break 'operands;
            }
            continue;
        }
    }
    // scan_standard/scan_summary swallow a mid-file soft-deadline expiry: the
    // CancellableReader's TimedOut error surfaces as `None`, indistinguishable
    // from "no matches in this file", and the between-chunks deadline checks
    // never run again after the LAST file. Re-check the deadline once after
    // every scan loop so that expiry is reported as a partial, timed-out
    // response instead of a silent (possibly empty) complete one — observed
    // in the wild as a false "(no matches)" under 8-way host saturation.
    let timed_out = timed_out || deadline_at.is_some_and(|deadline| Instant::now() >= deadline);
    // Files that failed to open/read mid-walk were skipped, not searched:
    // surface the count so the caller can distinguish "no matches" from
    // "not fully searched" (rg's stderr + exit-2 contract, JSONL-shaped).
    let scan_error_count = scan_errors.load(Ordering::Relaxed);
    let total_after_offset = all_lines.len().saturating_sub(req.offset);
    let window: Vec<&String> = all_lines
        .iter()
        .skip(req.offset)
        .take(if req.limit > 0 { req.limit } else { usize::MAX })
        .collect();
    let complete = !timed_out
        && scan_error_count == 0
        && all_lines.len() < collect_until
        && (req.limit == 0 || total_after_offset <= req.limit);
    let response = serde_json::json!({
        "id": req.id,
        "lines": window,
        "complete": complete,
        "totalSeen": total_after_offset,
        "partial": timed_out || scan_error_count > 0,
        "timeout": timed_out,
        "scanErrors": scan_error_count,
        "walkErrorDetails": walk_error_details,
        "filesScanned": files_scanned.load(Ordering::Relaxed),
        "inventoryChecked": complete,
        "cacheSafe": cache_safe,
    });
    schedule_content_signature_cache_persist();
    Ok(response)
}
