// Fuzzy path search: query tokenization, the exact ASCII prefilter and
// the bounded top-k ranking over the shared path corpus.
use super::*;

#[derive(Eq, PartialEq)]
pub(super) struct FuzzyHit {
    pub(super) score: u32,
    pub(super) path: String,
}

// Nucleo fuzzy matching requires every ASCII query byte to occur in order.
// Rejecting paths that fail that necessary condition is exact, not heuristic.
// Keep non-ASCII paths on the full matcher path because Smart normalization
// may fold Unicode characters onto an ASCII query.
pub(super) fn fuzzy_ascii_subsequence_possible(query: &str, path: &str) -> bool {
    if !query.is_ascii() || !path.is_ascii() {
        return true;
    }
    let mut query = query.bytes().map(|byte| byte.to_ascii_lowercase());
    let mut wanted = query.next();
    if wanted.is_none() {
        return true;
    }
    for byte in path.bytes() {
        if Some(byte.to_ascii_lowercase()) == wanted {
            wanted = query.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    false
}

pub(super) fn fuzzy_ascii_presence(value: &str) -> Option<(u64, u64)> {
    if !value.is_ascii() {
        return None;
    }
    let mut low = 0u64;
    let mut high = 0u64;
    for byte in value.bytes().map(|byte| byte.to_ascii_lowercase()) {
        if byte < 64 {
            low |= 1u64 << byte;
        } else {
            high |= 1u64 << (byte - 64);
        }
    }
    Some((low, high))
}

pub(super) struct FuzzyQueryToken {
    pub(super) text: String,
    pub(super) mask: Option<(u64, u64)>,
    pub(super) pattern: Pattern,
}

pub(super) fn retain_fuzzy_path(
    tokens: &[FuzzyQueryToken],
    path: &str,
    path_mask: Option<(u64, u64)>,
    matcher: &mut FuzzyMatcher,
    matches: &mut std::collections::BinaryHeap<FuzzyHit>,
    limit: usize,
    total_matches: &mut usize,
) {
    for token in tokens {
        if let (Some((query_low, query_high)), Some((path_low, path_high))) =
            (token.mask, path_mask)
        {
            if path_low & query_low != query_low || path_high & query_high != query_high {
                return;
            }
        }
        if !fuzzy_ascii_subsequence_possible(&token.text, path) {
            return;
        }
    }
    let matcher_text = Utf32String::from(path.to_string());
    let mut score = 0u32;
    for token in tokens {
        let Some(token_score) = token.pattern.score(matcher_text.slice(..), matcher) else {
            return;
        };
        score = score.saturating_add(token_score);
    }
    *total_matches += 1;
    let candidate = FuzzyHit {
        score,
        path: path.to_string(),
    };
    if matches.len() < limit {
        matches.push(candidate);
        return;
    }
    let replace = matches.peek().is_some_and(|worst| {
        candidate.score > worst.score
            || (candidate.score == worst.score && candidate.path < worst.path)
    });
    if replace {
        matches.pop();
        matches.push(candidate);
    }
}

impl Ord for FuzzyHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .score
            .cmp(&self.score)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for FuzzyHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

pub(super) fn handle_fuzzy(
    req: &ServeRequest,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    use std::collections::BinaryHeap;

    let query = req
        .fuzzy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "empty fuzzy query".to_string())?;
    let limit = req.limit.clamp(1, 1_000);
    let inventory_lease_ms = if req.keep_inventory_ms > 0 {
        req.keep_inventory_ms.min(30_000)
    } else if req.keep_inventory {
        3_000
    } else {
        0
    };
    let parsed = ParsedArgs {
        patterns: Vec::new(),
        globs: req.exclude.clone(),
        iglobs: Vec::new(),
        targets: vec![".".to_string()],
        before: 0,
        after: 0,
        case_insensitive: true,
        fixed_strings: false,
        hidden: req.hidden,
        no_ignore: req.include_noise,
        text: false,
        no_require_git: !req.include_noise,
        max_depth: req.max_depth,
        line_numbers: false,
        with_filename: false,
        files_with_matches: false,
        count: false,
        only_matching: false,
        pcre2: false,
        multiline: false,
        multiline_dotall: false,
        file_types: Vec::new(),
        files_list: true,
        directories: true,
        max_columns: 0,
        literal_trigrams: None,
    };
    let root = Path::new(&req.cwd);
    let key = fuzzy_key(root, &parsed);
    let filter = PathFilter::new(root, &parsed)?;
    let tokens = query
        .split_whitespace()
        .map(|text| FuzzyQueryToken {
            text: text.to_string(),
            mask: fuzzy_ascii_presence(text),
            pattern: Pattern::new(
                text,
                CaseMatching::Ignore,
                Normalization::Smart,
                AtomKind::Fuzzy,
            ),
        })
        .collect::<Vec<_>>();
    let mut matcher = FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths());
    let mut matches = BinaryHeap::with_capacity(limit + 1);
    let mut total_matches = 0usize;
    let mut total_seen = 0usize;
    let mut timed_out = false;
    let mut walk_complete = false;
    let mut walk_errors = 0usize;
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;
    let mut rank_ms = 0.0;
    let inventory_started_at = Instant::now();
    let cached_corpus = store.take_fuzzy_corpus(&key).or_else(|| {
        store
            .take_ready(&key.walk)
            .map(|files| store.fuzzy_corpus(&key, &files, root, &filter))
    });
    if let Some(corpus) = cached_corpus {
        walk_complete = true;
        let rank_started_at = Instant::now();
        for (index, indexed) in corpus.paths.iter().enumerate() {
            if index & 1023 == 0 {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                    timed_out = true;
                    walk_complete = false;
                    break;
                }
            }
            total_seen = index + 1;
            retain_fuzzy_path(
                &tokens,
                &indexed.path,
                indexed.ascii_mask,
                &mut matcher,
                &mut matches,
                limit,
                &mut total_matches,
            );
        }
        rank_ms += rank_started_at.elapsed().as_secs_f64() * 1_000.0;
    } else {
        let watched = store.watch_root(root);
        cache_safe = watched;
        let walk_key = key.walk.clone();
        let (live, owner) =
            store.begin_live_with_inventory(walk_key.clone(), req.keep_warm, inventory_lease_ms);
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(walk_key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                walk_key,
                Arc::clone(&live),
                root.to_path_buf(),
                parsed.clone(),
            );
        }
        let mut cursor = 0usize;
        'stream: loop {
            let batch = {
                let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
                while cursor >= files.len() {
                    if live.enumeration_done.load(Ordering::Acquire) {
                        walk_complete = true;
                        break 'stream;
                    }
                    let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &*state {
                        LiveState::Done(_) => {
                            walk_complete = true;
                            break 'stream;
                        }
                        LiveState::Abandoned => break 'stream,
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
                        break 'stream;
                    }
                }
                // Materialize the wire-relative strings once while advancing
                // the published cursor. The old path cloned every PathBuf into
                // a temporary batch and then allocated the same strings, which
                // was costly across hundreds of thousands of broad candidates.
                let batch: Vec<String> = files[cursor..]
                    .iter()
                    .filter(|file| filter.allows(file))
                    .map(|file| {
                        relative_inventory_path(file, root).unwrap_or_else(|| wire_path(file))
                    })
                    .collect::<Vec<_>>();
                cursor = files.len();
                batch
            };
            let rank_started_at = Instant::now();
            for path in batch {
                if total_seen & 1023 == 0 {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(CANCELLED.to_string());
                    }
                    if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                        timed_out = true;
                        break;
                    }
                }
                total_seen += 1;
                let ascii_mask = fuzzy_ascii_presence(&path);
                retain_fuzzy_path(
                    &tokens,
                    &path,
                    ascii_mask,
                    &mut matcher,
                    &mut matches,
                    limit,
                    &mut total_matches,
                );
            }
            rank_ms += rank_started_at.elapsed().as_secs_f64() * 1_000.0;
            if timed_out {
                break;
            }
        }
        walk_errors = live.walk_errors.load(Ordering::Acquire);
        walk_error_details = live_walk_error_details(&live);
        cache_safe &= live.cacheable.load(Ordering::Acquire);
        if walk_complete && walk_errors == 0 {
            // The response no longer waits for deterministic inventory sort;
            // retain the completed walk until finish_live installs its cache.
            live.keep_warm.store(true, Ordering::Release);
        }
    }

    let inventory_ms = inventory_started_at.elapsed().as_secs_f64() * 1_000.0;
    let inventory_complete = walk_complete && walk_errors == 0;
    let mut matches = matches.into_vec();
    matches.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    let paths: Vec<String> = matches.into_iter().map(|entry| entry.path).collect();
    Ok(serde_json::json!({
        "id": req.id,
        "matches": paths,
        "hasMore": total_matches > limit,
        "totalMatches": total_matches,
        "totalSeen": total_seen,
        "complete": inventory_complete && !timed_out,
        "partial": !walk_complete || timed_out || walk_errors > 0,
        "timeout": timed_out,
        "scanErrors": walk_errors,
        "walkErrorDetails": walk_error_details,
        "inventoryChecked": inventory_complete,
        "cacheSafe": cache_safe,
        "inventoryMs": inventory_ms,
        "rankMs": rank_ms,
        "inventoryContinues": !walk_complete && inventory_lease_ms > 0,
        "inventoryLeaseMs": if !walk_complete { inventory_lease_ms } else { 0 },
    }))
}
