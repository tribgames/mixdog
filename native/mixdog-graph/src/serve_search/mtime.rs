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
        other.mtime_ms.cmp(&self.mtime_ms).then_with(|| self.path.cmp(&other.path))
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

pub(super) fn retain_bounded<T: Ord>(heap: &mut std::collections::BinaryHeap<T>, candidate: T, cap: usize) {
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

type MtimeCandidate = (usize, String, Option<u128>);

struct MtimeInventory {
    cap: usize,
    statted: std::collections::BinaryHeap<MtimeHit>,
    unstatted: std::collections::BinaryHeap<UnstattedHit>,
    total_seen: usize,
    timed_out: bool,
    scan_error_count: usize,
    walk_error_details: Vec<String>,
    cache_safe: bool,
}

impl MtimeInventory {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            statted: std::collections::BinaryHeap::with_capacity(cap + 1),
            unstatted: std::collections::BinaryHeap::with_capacity(cap + 1),
            total_seen: 0,
            timed_out: false,
            scan_error_count: 0,
            walk_error_details: Vec::new(),
            cache_safe: true,
        }
    }

    /// Keep a candidate in the statted top-k by mtime, or, when it could not be
    /// stat'd in time, in the walk-order fallback.
    fn retain(&mut self, (index, path, mtime_ms): MtimeCandidate) {
        if let Some(mtime_ms) = mtime_ms {
            retain_bounded(&mut self.statted, MtimeHit { mtime_ms, path }, self.cap);
        } else {
            retain_bounded(&mut self.unstatted, UnstattedHit { index, path }, self.cap);
        }
    }

    fn scan_operand(
        &mut self,
        req: &ServeRequest,
        parsed: &ParsedArgs,
        operand: &str,
        cancelled: &AtomicBool,
        store: &Arc<FileListStore>,
        deadline_at: Option<Instant>,
    ) -> Result<(), String> {
        let cwd = Path::new(&req.cwd);
        // Path::join replaces the base when the operand is absolute.
        let operand_path = cwd.join(operand);
        let filter = PathFilter::new(&operand_path, parsed)?;
        let scope = OperandScope { operand, operand_path: &operand_path, filter: &filter };
        let watched = store.watch_root(&operand_path);
        let trust = TrustSnapshot::capture();
        self.cache_safe &= watched;
        let walk_key = walk_key(&operand_path, parsed);
        if let Some(files) = store.take_ready(&walk_key) {
            let (candidates, expired) = collect_mtime_candidates(&files, 0, &scope, &trust, cancelled, deadline_at)?;
            self.total_seen = self.total_seen.saturating_add(candidates.len());
            for candidate in candidates {
                self.retain(candidate);
            }
            self.timed_out |= expired;
            return Ok(());
        }

        let (live, _waiter) = store.join_live_walk(walk_key, &operand_path, parsed, req.keep_warm, 0, watched);
        let mut cursor = 0usize;
        let mut operand_complete = false;
        loop {
            let batch_start = cursor;
            let take = |files: &[PathBuf]| -> Vec<PathBuf> { files.iter().filter(|file| filter.allows(file)).cloned().collect() };
            let batch = match next_stream_batch(&live, &mut cursor, cancelled, deadline_at, take)? {
                StreamBatch::Items(batch) => batch,
                StreamBatch::Complete => {
                    operand_complete = true;
                    break;
                }
                StreamBatch::Abandoned => break,
                StreamBatch::TimedOut => {
                    self.timed_out = true;
                    break;
                }
            };
            let (candidates, expired) = collect_mtime_candidates(&batch, batch_start, &scope, &trust, cancelled, deadline_at)?;
            self.timed_out |= expired;
            self.total_seen = self.total_seen.saturating_add(candidates.len());
            for candidate in candidates {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_expired(deadline_at) {
                    self.timed_out = true;
                    break;
                }
                self.retain(candidate);
            }
            if self.timed_out {
                break;
            }
        }
        let walk_errors = live.walk_errors.load(Ordering::Acquire);
        self.scan_error_count = self.scan_error_count.saturating_add(walk_errors);
        append_walk_error_details(&mut self.walk_error_details, live_walk_error_details(&live));
        self.cache_safe &= live.cacheable.load(Ordering::Acquire);
        if operand_complete {
            live.keep_warm.store(true, Ordering::Release);
        } else {
            self.timed_out = true;
        }
        Ok(())
    }

    fn into_response(self, req: &ServeRequest, cancelled: &AtomicBool, deadline_at: Option<Instant>) -> Result<serde_json::Value, String> {
        // MtimeHit orders newest first, then path, so the ascending heap order is
        // the response order.
        let mut unstatted = self.unstatted.into_vec();
        unstatted.sort_by_key(|entry| entry.index);
        let ordered: Vec<String> = self
            .statted
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
        let timed_out = self.timed_out || deadline_expired(deadline_at);
        let complete = !timed_out && self.scan_error_count == 0;
        Ok(serde_json::json!({
            "id": req.id,
            "lines": ordered,
            "complete": complete,
            "totalSeen": self.total_seen,
            "partial": timed_out || self.scan_error_count > 0,
            "timeout": timed_out,
            "scanErrors": self.scan_error_count,
            "walkErrorDetails": self.walk_error_details,
            "inventoryChecked": complete,
            "cacheSafe": self.cache_safe,
        }))
    }
}

pub(super) fn handle_mtime_inventory(
    req: &ServeRequest,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    refresh_content_signature_journals(&parsed.targets, Path::new(&req.cwd));
    let mut inventory = MtimeInventory::new(req.offset.saturating_add(req.limit.max(1)));
    for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_expired(deadline_at) {
            inventory.timed_out = true;
            break;
        }
        inventory.scan_operand(req, parsed, operand, cancelled, store, deadline_at)?;
        if inventory.timed_out {
            break;
        }
    }
    inventory.into_response(req, cancelled, deadline_at)
}
