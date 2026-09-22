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
                    let snapshot = lock_recover(&live.files).clone();
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
                let snapshot = lock_recover(&live.files).clone();
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

/// What a live walk has for a consumer right now: newly published paths, the
/// walk finishing, or the deadline expiring while the walker still runs.
pub(super) enum LiveBatch {
    Files(Vec<PathBuf>),
    Done,
    TimedOut,
}

/// Everything the walker published past `cursor`, waiting in short slices
/// while the walk runs. Cancellation and a failed walk are errors; a finished
/// walk and an expired deadline are outcomes each caller reports its own way.
pub(super) fn next_live_batch(
    live: &LiveWalk,
    cursor: &mut usize,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<LiveBatch, String> {
    let mut files = lock_recover(&live.files);
    while *cursor >= files.len() {
        let state = lock_recover(&live.state);
        match &*state {
            LiveState::Done(_) => return Ok(LiveBatch::Done),
            LiveState::Abandoned => return Err(CANCELLED.to_string()),
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
        if deadline_expired(deadline_at) {
            return Ok(LiveBatch::TimedOut);
        }
    }
    let batch = files[*cursor..].to_vec();
    *cursor = files.len();
    Ok(LiveBatch::Files(batch))
}

pub(super) fn scan_streaming_operand(
    store: &Arc<FileListStore>,
    scope: &OperandScope<'_>,
    use_prefix: bool,
    keep_warm: bool,
    ctx: &ScanCtx<'_>,
    out: &mut ScanOutput<'_>,
) -> Result<(bool, bool, bool, Vec<String>), String> {
    let operand_path = scope.operand_path;
    let parsed = ctx.parsed;
    let cancelled = ctx.cancelled;
    let deadline_at = ctx.deadline_at;
    let watched = store.watch_root(operand_path);
    let trust = TrustSnapshot::capture();
    if deadline_expired(deadline_at) {
        return Ok((false, true, watched, Vec::new()));
    }
    let key = walk_key(operand_path, parsed);
    if let Some(files) = store.take_ready(&key) {
        let reached_limit =
            append_scanned_matches_unordered(&files, scope, use_prefix, &trust, ctx, out);
        let timed_out = deadline_expired(deadline_at);
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
            ctx.scan_errors.fetch_add(count, Ordering::Relaxed);
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
        if deadline_expired(deadline_at) {
            account_walk_errors();
            return Ok(outcome(false, true));
        }
        let batch = match next_live_batch(&live, &mut cursor, cancelled, deadline_at)? {
            LiveBatch::Files(batch) => batch,
            LiveBatch::Done => {
                account_walk_errors();
                return Ok(outcome(false, false));
            }
            LiveBatch::TimedOut => {
                account_walk_errors();
                return Ok(outcome(false, true));
            }
        };
        let reached_limit =
            append_scanned_matches_unordered(&batch, scope, use_prefix, &trust, ctx, out);
        if deadline_expired(deadline_at) {
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
    if panic_probe_id() == Some(req.id) {
        panic!("panic probe for request {}", req.id);
    }
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
    if parsed.files_list {
        return handle_inventory(req, &parsed, cancelled, store, deadline_at, collect_until);
    }
    handle_content_search(req, &parsed, cancelled, store, deadline_at, collect_until)
}

/// Everything the inventory loops need from the request that does not change
/// between operands: the walk configuration, the cancellation flag and soft
/// deadline every bounded loop checks, and the hard stop for the window.
struct InventoryCtx<'a> {
    store: &'a Arc<FileListStore>,
    parsed: &'a ParsedArgs,
    cancelled: &'a AtomicBool,
    deadline_at: Option<Instant>,
    keep_warm: bool,
    collect_until: usize,
}

/// What an inventory run accumulates across its operands: the display paths
/// collected so far, plus the accounting a partial or uncacheable result is
/// reported from.
struct InventoryAccum {
    lines: Vec<String>,
    timed_out: bool,
    scan_errors: usize,
    walk_error_details: Vec<String>,
    cache_safe: bool,
}

/// Inventory mode for glob/find: consume paths as the two-thread walker
/// discovers them while the shared inventory continues to completion.
fn handle_inventory(
    req: &ServeRequest,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
    collect_until: usize,
) -> Result<serde_json::Value, String> {
    let cwd = Path::new(&req.cwd);
    let ctx = InventoryCtx {
        store,
        parsed,
        cancelled,
        deadline_at,
        keep_warm: req.keep_warm,
        collect_until,
    };
    let mut out = InventoryAccum {
        lines: Vec::new(),
        timed_out: false,
        scan_errors: 0,
        walk_error_details: Vec::new(),
        cache_safe: true,
    };
    for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
            out.timed_out = true;
            break;
        }
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let watched = store.watch_root(&operand_path);
        out.cache_safe &= watched;
        let filter = PathFilter::new(&operand_path, parsed)?;
        let scope = OperandScope {
            operand,
            operand_path: &operand_path,
            filter: &filter,
        };
        if collect_until == usize::MAX {
            collect_whole_inventory(&ctx, &scope, &mut out)?;
        } else {
            collect_bounded_inventory(&ctx, &scope, watched, &mut out)?;
        }
        if out.timed_out || out.lines.len() >= collect_until {
            break;
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    let timed_out = out.timed_out || deadline_expired(deadline_at);
    let window = response_window(&out.lines, req, collect_until, timed_out, out.scan_errors);
    Ok(serde_json::json!({
        "id": req.id,
        "lines": window.lines,
        "complete": window.complete,
        "totalSeen": window.total_after_offset,
        "partial": timed_out || out.scan_errors > 0,
        "timeout": timed_out,
        "scanErrors": out.scan_errors,
        "walkErrorDetails": out.walk_error_details,
        "inventoryChecked": window.complete,
        "cacheSafe": out.cache_safe,
    }))
}

/// Append one operand's whole inventory. An unlimited request has no window
/// to fill early, so it waits for the walk instead of streaming it.
fn collect_whole_inventory(
    ctx: &InventoryCtx<'_>,
    scope: &OperandScope<'_>,
    out: &mut InventoryAccum,
) -> Result<(), String> {
    let (files, complete, walk_errors, details, operand_cache_safe) = complete_operand_files(
        ctx.store,
        scope.operand_path,
        ctx.parsed,
        ctx.cancelled,
        ctx.deadline_at,
        ctx.keep_warm,
    )?;
    out.cache_safe &= operand_cache_safe;
    out.scan_errors = out.scan_errors.saturating_add(walk_errors);
    append_walk_error_details(&mut out.walk_error_details, details);
    for file in files.iter().filter(|file| scope.filter.allows(file)) {
        out.lines
            .push(display_path(scope.operand, scope.operand_path, file));
    }
    if !complete {
        out.timed_out = true;
    }
    Ok(())
}

/// Append one operand's paths up to the window's hard stop: from a finished
/// inventory when the store has one, otherwise from a live walk's batches as
/// they are published. The walk itself runs on past the stop, for the cache.
fn collect_bounded_inventory(
    ctx: &InventoryCtx<'_>,
    scope: &OperandScope<'_>,
    watched: bool,
    out: &mut InventoryAccum,
) -> Result<(), String> {
    let key = walk_key(scope.operand_path, ctx.parsed);
    if let Some(files) = ctx.store.take_ready(&key) {
        for file in files.iter().filter(|file| scope.filter.allows(file)) {
            out.lines
                .push(display_path(scope.operand, scope.operand_path, file));
            if out.lines.len() >= ctx.collect_until {
                break;
            }
        }
        return Ok(());
    }
    let (live, owner) = ctx.store.begin_live(key.clone(), ctx.keep_warm);
    if !watched {
        live.cacheable.store(false, Ordering::Release);
    }
    let _waiter = ctx.store.waiter_guard(key.clone(), Arc::clone(&live));
    if owner {
        start_live_walk(
            Arc::clone(ctx.store),
            key,
            Arc::clone(&live),
            scope.operand_path.to_path_buf(),
            ctx.parsed.clone(),
        );
    }
    let mut cursor = 0usize;
    'inventory: loop {
        let batch = match next_live_batch(&live, &mut cursor, ctx.cancelled, ctx.deadline_at)? {
            LiveBatch::Files(batch) => batch,
            LiveBatch::Done => break 'inventory,
            LiveBatch::TimedOut => {
                out.timed_out = true;
                break 'inventory;
            }
        };
        for file in batch.iter().filter(|file| scope.filter.allows(file)) {
            out.lines
                .push(display_path(scope.operand, scope.operand_path, file));
            if out.lines.len() >= ctx.collect_until {
                break 'inventory;
            }
        }
        if deadline_expired(ctx.deadline_at) {
            out.timed_out = true;
            break 'inventory;
        }
    }
    out.scan_errors = out
        .scan_errors
        .saturating_add(live.walk_errors.load(Ordering::Acquire));
    out.cache_safe &= live.cacheable.load(Ordering::Acquire);
    append_walk_error_details(&mut out.walk_error_details, live_walk_error_details(&live));
    Ok(())
}

/// The window a response reports, and whether it is the whole answer.
struct ResponseWindow<'a> {
    lines: Vec<&'a String>,
    total_after_offset: usize,
    complete: bool,
}

/// `complete` is the whole-answer claim the caller may cache on: the run
/// finished inside its budget, read every file it meant to, stopped short of
/// the collection cap, and fits the requested window.
fn response_window<'a>(
    all_lines: &'a [String],
    req: &ServeRequest,
    collect_until: usize,
    timed_out: bool,
    scan_error_count: usize,
) -> ResponseWindow<'a> {
    let total_after_offset = all_lines.len().saturating_sub(req.offset);
    ResponseWindow {
        lines: all_lines
            .iter()
            .skip(req.offset)
            .take(if req.limit > 0 { req.limit } else { usize::MAX })
            .collect(),
        total_after_offset,
        complete: !timed_out
            && scan_error_count == 0
            && all_lines.len() < collect_until
            && (req.limit == 0 || total_after_offset <= req.limit),
    }
}

/// Content mode: scan every operand's files with the compiled matcher and
/// assemble the match window.
fn handle_content_search(
    req: &ServeRequest,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
    collect_until: usize,
) -> Result<serde_json::Value, String> {
    let matcher = build_matcher(parsed)?;
    let cwd = Path::new(&req.cwd);
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
    let ctx = ScanCtx {
        parsed,
        matcher: &matcher,
        cancelled,
        deadline_at,
        scan_errors: &scan_errors,
        files_scanned: &files_scanned,
    };
    'operands: for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
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
        let filter = PathFilter::new(&operand_path, parsed)?;
        {
            let scope = OperandScope {
                operand,
                operand_path: &operand_path,
                filter: &filter,
            };
            let (reached_limit, operand_timed_out, operand_cache_safe, details) = {
                let mut out = ScanOutput {
                    all_lines: &mut all_lines,
                    emitted_blocks: &mut emitted_blocks,
                    collect_until,
                };
                scan_streaming_operand(store, &scope, use_prefix, req.keep_warm, &ctx, &mut out)?
            };
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
    let timed_out = timed_out || deadline_expired(deadline_at);
    // Files that failed to open/read mid-walk were skipped, not searched:
    // surface the count so the caller can distinguish "no matches" from
    // "not fully searched" (rg's stderr + exit-2 contract, JSONL-shaped).
    let scan_error_count = scan_errors.load(Ordering::Relaxed);
    let window = response_window(&all_lines, req, collect_until, timed_out, scan_error_count);
    let response = serde_json::json!({
        "id": req.id,
        "lines": window.lines,
        "complete": window.complete,
        "totalSeen": window.total_after_offset,
        "partial": timed_out || scan_error_count > 0,
        "timeout": timed_out,
        "scanErrors": scan_error_count,
        "walkErrorDetails": walk_error_details,
        "filesScanned": files_scanned.load(Ordering::Relaxed),
        "inventoryChecked": window.complete,
        "cacheSafe": cache_safe,
    });
    schedule_content_signature_cache_persist();
    Ok(response)
}
