// Recency inventory: globally ordered mtime top-k over a file list,
// falling back to walk order for files that cannot be stat'd in time.
use super::*;

#[derive(Eq, PartialEq)]
pub(super) struct MtimeHit {
    pub(super) mtime_ms: u128,
    pub(super) path: String,
}

impl Ord for MtimeHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .mtime_ms
            .cmp(&self.mtime_ms)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for MtimeHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Eq, PartialEq)]
pub(super) struct UnstattedHit {
    pub(super) index: usize,
    pub(super) path: String,
}

impl Ord for UnstattedHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.index.cmp(&other.index)
    }
}

impl PartialOrd for UnstattedHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

pub(super) fn retain_bounded<T: Ord>(
    heap: &mut std::collections::BinaryHeap<T>,
    candidate: T,
    cap: usize,
) {
    if heap.len() < cap {
        heap.push(candidate);
    } else if heap.peek().is_some_and(|worst| candidate < *worst) {
        heap.pop();
        heap.push(candidate);
    }
}

pub(super) fn collect_mtime_candidates(
    files: &[PathBuf],
    base_index: usize,
    scope: &OperandScope<'_>,
    trust: &TrustSnapshot,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<(Vec<(usize, String, Option<u128>)>, bool), String> {
    let mut candidates = Vec::new();
    // Check between bounded batches even on a fully cached inventory. A warm
    // path must not stat the whole tree after its request has been cancelled.
    for (chunk_index, chunk) in files.chunks(256).enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
            return Ok((candidates, true));
        }
        let batch: Vec<_> = chunk
            .par_iter()
            .enumerate()
            .filter(|(_, file)| scope.filter.allows(file))
            .map(|(index, file)| {
                let path = display_path(scope.operand, scope.operand_path, file);
                let mtime_ms = file_mtime_ms(file, trust);
                (base_index + chunk_index * 256 + index, path, mtime_ms)
            })
            .collect();
        candidates.extend(batch);
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    Ok((candidates, deadline_expired(deadline_at)))
}

/// Keep a candidate in the statted top-k by mtime, or, when it could not be
/// stat'd in time, in the walk-order fallback.
fn retain_mtime_candidate(
    statted: &mut std::collections::BinaryHeap<MtimeHit>,
    unstatted: &mut std::collections::BinaryHeap<UnstattedHit>,
    (index, path, mtime_ms): (usize, String, Option<u128>),
    cap: usize,
) {
    if let Some(mtime_ms) = mtime_ms {
        retain_bounded(statted, MtimeHit { mtime_ms, path }, cap);
    } else {
        retain_bounded(unstatted, UnstattedHit { index, path }, cap);
    }
}

pub(super) fn handle_mtime_inventory(
    req: &ServeRequest,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    use std::collections::BinaryHeap;

    let cwd = Path::new(&req.cwd);
    refresh_content_signature_journals(&parsed.targets, cwd);
    let cap = req.offset.saturating_add(req.limit.max(1));
    let mut statted = BinaryHeap::with_capacity(cap + 1);
    let mut unstatted = BinaryHeap::with_capacity(cap + 1);
    let mut total_seen = 0usize;
    let mut timed_out = false;
    let mut scan_error_count = 0usize;
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;

    for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
            timed_out = true;
            break;
        }
        // Path::join replaces the base when the operand is absolute.
        let operand_path = cwd.join(operand);
        let filter = PathFilter::new(&operand_path, parsed)?;
        let scope = OperandScope {
            operand,
            operand_path: &operand_path,
            filter: &filter,
        };
        let watched = store.watch_root(&operand_path);
        let trust = TrustSnapshot::capture();
        cache_safe &= watched;
        let walk_key = walk_key(&operand_path, parsed);
        if let Some(files) = store.take_ready(&walk_key) {
            let (candidates, expired) =
                collect_mtime_candidates(&files, 0, &scope, &trust, cancelled, deadline_at)?;
            total_seen = total_seen.saturating_add(candidates.len());
            for candidate in candidates {
                retain_mtime_candidate(&mut statted, &mut unstatted, candidate, cap);
            }
            if expired {
                timed_out = true;
                break;
            }
            continue;
        }

        let (live, owner) = store.begin_live(walk_key.clone(), req.keep_warm);
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(walk_key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                walk_key,
                Arc::clone(&live),
                operand_path.clone(),
                parsed.clone(),
            );
        }
        let mut cursor = 0usize;
        let mut operand_complete = false;
        loop {
            let batch_start = cursor;
            let take = |files: &[PathBuf]| -> Vec<PathBuf> {
                files
                    .iter()
                    .filter(|file| filter.allows(file))
                    .cloned()
                    .collect()
            };
            let batch = match next_stream_batch(&live, &mut cursor, cancelled, deadline_at, take)? {
                StreamBatch::Items(batch) => batch,
                StreamBatch::Complete => {
                    operand_complete = true;
                    break;
                }
                StreamBatch::Abandoned => break,
                StreamBatch::TimedOut => {
                    timed_out = true;
                    break;
                }
            };
            let (candidates, expired) = collect_mtime_candidates(
                &batch,
                batch_start,
                &scope,
                &trust,
                cancelled,
                deadline_at,
            )?;
            timed_out |= expired;
            total_seen = total_seen.saturating_add(candidates.len());
            for candidate in candidates {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_expired(deadline_at) {
                    timed_out = true;
                    break;
                }
                retain_mtime_candidate(&mut statted, &mut unstatted, candidate, cap);
            }
            if timed_out {
                break;
            }
        }
        let walk_errors = live.walk_errors.load(Ordering::Acquire);
        scan_error_count = scan_error_count.saturating_add(walk_errors);
        append_walk_error_details(&mut walk_error_details, live_walk_error_details(&live));
        cache_safe &= live.cacheable.load(Ordering::Acquire);
        if operand_complete {
            live.keep_warm.store(true, Ordering::Release);
        } else {
            timed_out = true;
        }
        if timed_out {
            break;
        }
    }

    // MtimeHit orders newest first, then path, so the ascending heap order is
    // the response order.
    let mut unstatted = unstatted.into_vec();
    unstatted.sort_by_key(|entry| entry.index);
    let ordered: Vec<String> = statted
        .into_sorted_vec()
        .into_iter()
        .map(|entry| entry.path)
        .chain(unstatted.into_iter().map(|entry| entry.path))
        .skip(req.offset)
        .take(req.limit.max(1))
        .collect();
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    let timed_out = timed_out || deadline_expired(deadline_at);
    let complete = !timed_out && scan_error_count == 0;
    Ok(serde_json::json!({
        "id": req.id,
        "lines": ordered,
        "complete": complete,
        "totalSeen": total_seen,
        "partial": timed_out || scan_error_count > 0,
        "timeout": timed_out,
        "scanErrors": scan_error_count,
        "walkErrorDetails": walk_error_details,
        "inventoryChecked": complete,
        "cacheSafe": cache_safe,
    }))
}
