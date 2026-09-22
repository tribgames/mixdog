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
    retain_bounded(matches, candidate, limit);
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

/// The enumeration one fuzzy request asks for: the trimmed query, the bounded
/// result cap, how long the query-independent inventory outlives the response,
/// and the walk the corpus is built from.
struct FuzzyScope<'a> {
    query: &'a str,
    limit: usize,
    inventory_lease_ms: u64,
    parsed: ParsedArgs,
    root: &'a Path,
    key: FuzzyKey,
    filter: PathFilter,
}

fn fuzzy_scope(req: &ServeRequest) -> Result<FuzzyScope<'_>, String> {
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
        globs: req.exclude.clone(),
        targets: vec![".".to_string()],
        case_insensitive: true,
        hidden: req.hidden,
        no_ignore: req.include_noise,
        no_require_git: !req.include_noise,
        max_depth: req.max_depth,
        files_list: true,
        directories: true,
        ..ParsedArgs::default()
    };
    let root = Path::new(&req.cwd);
    let key = fuzzy_key(root, &parsed);
    let filter = PathFilter::new(root, &parsed)?;
    Ok(FuzzyScope {
        query,
        limit,
        inventory_lease_ms,
        parsed,
        root,
        key,
        filter,
    })
}

/// The whitespace-separated query atoms. Each carries its own ASCII presence
/// mask and compiled pattern, and every one of them has to match.
fn fuzzy_query_tokens(query: &str) -> Vec<FuzzyQueryToken> {
    query
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
        .collect::<Vec<_>>()
}

/// The bounded top-k ranking both corpus sources feed: the query atoms, the
/// reusable matcher, the heap capped at `limit`, and the counters the
/// response reports.
struct FuzzyRanking<'a> {
    tokens: &'a [FuzzyQueryToken],
    matcher: FuzzyMatcher,
    matches: std::collections::BinaryHeap<FuzzyHit>,
    limit: usize,
    total_matches: usize,
    total_seen: usize,
}

impl<'a> FuzzyRanking<'a> {
    fn new(tokens: &'a [FuzzyQueryToken], limit: usize) -> Self {
        Self {
            tokens,
            matcher: FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths()),
            matches: std::collections::BinaryHeap::with_capacity(limit + 1),
            limit,
            total_matches: 0,
            total_seen: 0,
        }
    }

    fn consider(&mut self, path: &str, path_mask: Option<(u64, u64)>) {
        retain_fuzzy_path(
            self.tokens,
            path,
            path_mask,
            &mut self.matcher,
            &mut self.matches,
            self.limit,
            &mut self.total_matches,
        );
    }
}

/// What the corpus contributed beyond the ranking itself: whether the
/// enumeration was seen to its end, whether the request ran out of budget,
/// the walk's error accounting, and the time spent scoring.
struct FuzzyWalkOutcome {
    timed_out: bool,
    walk_complete: bool,
    walk_errors: usize,
    walk_error_details: Vec<String>,
    cache_safe: bool,
    rank_ms: f64,
}

/// Rank a corpus that is already enumerated, filtered and materialized: the
/// whole cost here is scoring, so cancellation is checked every 1024 paths.
fn rank_cached_corpus(
    corpus: &FuzzyCorpus,
    ranking: &mut FuzzyRanking<'_>,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<FuzzyWalkOutcome, String> {
    let mut timed_out = false;
    let mut walk_complete = true;
    let rank_started_at = Instant::now();
    for (index, indexed) in corpus.paths.iter().enumerate() {
        if index & 1023 == 0 {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if deadline_expired(deadline_at) {
                timed_out = true;
                walk_complete = false;
                break;
            }
        }
        ranking.total_seen = index + 1;
        ranking.consider(&indexed.path, indexed.ascii_mask);
    }
    Ok(FuzzyWalkOutcome {
        timed_out,
        walk_complete,
        walk_errors: 0,
        walk_error_details: Vec::new(),
        cache_safe: true,
        rank_ms: rank_started_at.elapsed().as_secs_f64() * 1_000.0,
    })
}

/// The next candidates a live fuzzy walk published, or the reason the stream
/// ended: an abandoned walk is not an error here, it simply ranks nothing
/// more, while a failed walk and cancellation are.
enum RankedBatch {
    Paths(Vec<String>),
    Complete,
    Abandoned,
    TimedOut,
}

/// Take the paths published past `cursor` as the wire-relative strings the
/// ranker scores, waiting in short slices while the walk runs.
fn next_ranked_batch(
    live: &LiveWalk,
    cursor: &mut usize,
    scope: &FuzzyScope<'_>,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<RankedBatch, String> {
    let root = scope.root;
    let mut files = lock_recover(&live.files);
    while *cursor >= files.len() {
        if live.enumeration_done.load(Ordering::Acquire) {
            return Ok(RankedBatch::Complete);
        }
        let state = lock_recover(&live.state);
        match &*state {
            LiveState::Done(_) => return Ok(RankedBatch::Complete),
            LiveState::Abandoned => return Ok(RankedBatch::Abandoned),
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
            return Ok(RankedBatch::TimedOut);
        }
    }
    // Materialize the wire-relative strings once while advancing the
    // published cursor. The old path cloned every PathBuf into a temporary
    // batch and then allocated the same strings, which was costly across
    // hundreds of thousands of broad candidates.
    let batch: Vec<String> = files[*cursor..]
        .iter()
        .filter(|file| scope.filter.allows(file))
        .map(|file| relative_inventory_path(file, root).unwrap_or_else(|| wire_path(file)))
        .collect::<Vec<_>>();
    *cursor = files.len();
    Ok(RankedBatch::Paths(batch))
}

/// Rank a walk that is still running: score every batch of paths the walker
/// publishes, then wait for the next one, so the response is bounded by the
/// deadline rather than by the size of the tree.
fn rank_live_walk(
    scope: &FuzzyScope<'_>,
    store: &Arc<FileListStore>,
    keep_warm: bool,
    ranking: &mut FuzzyRanking<'_>,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<FuzzyWalkOutcome, String> {
    let root = scope.root;
    let mut timed_out = false;
    let mut walk_complete = false;
    let mut rank_ms = 0.0;
    let watched = store.watch_root(root);
    let mut cache_safe = watched;
    let walk_key = scope.key.walk.clone();
    let (live, owner) =
        store.begin_live_with_inventory(walk_key.clone(), keep_warm, scope.inventory_lease_ms);
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
            scope.parsed.clone(),
        );
    }
    let mut cursor = 0usize;
    loop {
        let batch = match next_ranked_batch(&live, &mut cursor, scope, cancelled, deadline_at)? {
            RankedBatch::Paths(batch) => batch,
            RankedBatch::Complete => {
                walk_complete = true;
                break;
            }
            RankedBatch::Abandoned => break,
            RankedBatch::TimedOut => {
                timed_out = true;
                break;
            }
        };
        let rank_started_at = Instant::now();
        for path in batch {
            if ranking.total_seen & 1023 == 0 {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_expired(deadline_at) {
                    timed_out = true;
                    break;
                }
            }
            ranking.total_seen += 1;
            let ascii_mask = fuzzy_ascii_presence(&path);
            ranking.consider(&path, ascii_mask);
        }
        rank_ms += rank_started_at.elapsed().as_secs_f64() * 1_000.0;
        if timed_out {
            break;
        }
    }
    let walk_errors = live.walk_errors.load(Ordering::Acquire);
    let walk_error_details = live_walk_error_details(&live);
    cache_safe &= live.cacheable.load(Ordering::Acquire);
    if walk_complete && walk_errors == 0 {
        // The response no longer waits for deterministic inventory sort;
        // retain the completed walk until finish_live installs its cache.
        live.keep_warm.store(true, Ordering::Release);
    }
    Ok(FuzzyWalkOutcome {
        timed_out,
        walk_complete,
        walk_errors,
        walk_error_details,
        cache_safe,
        rank_ms,
    })
}

pub(super) fn handle_fuzzy(
    req: &ServeRequest,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    let scope = fuzzy_scope(req)?;
    let limit = scope.limit;
    let inventory_lease_ms = scope.inventory_lease_ms;
    let tokens = fuzzy_query_tokens(scope.query);
    let mut ranking = FuzzyRanking::new(&tokens, limit);
    let inventory_started_at = Instant::now();
    let cached_corpus = store.take_fuzzy_corpus(&scope.key).or_else(|| {
        store
            .take_ready(&scope.key.walk)
            .map(|files| store.fuzzy_corpus(&scope.key, &files, scope.root, &scope.filter))
    });
    let FuzzyWalkOutcome {
        timed_out,
        walk_complete,
        walk_errors,
        walk_error_details,
        cache_safe,
        rank_ms,
    } = match cached_corpus {
        Some(corpus) => rank_cached_corpus(&corpus, &mut ranking, cancelled, deadline_at)?,
        None => rank_live_walk(
            &scope,
            store,
            req.keep_warm,
            &mut ranking,
            cancelled,
            deadline_at,
        )?,
    };
    let total_matches = ranking.total_matches;
    let total_seen = ranking.total_seen;
    let matches = ranking.matches;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_fuzzy_hits_keep_best_scores_and_lexical_ties() {
        let mut hits = std::collections::BinaryHeap::new();
        for (score, path) in [(5, "early"), (10, "beta"), (10, "alpha"), (3, "late")] {
            retain_bounded(
                &mut hits,
                FuzzyHit {
                    score,
                    path: path.to_string(),
                },
                2,
            );
        }
        let kept: Vec<_> = hits
            .into_sorted_vec()
            .into_iter()
            .map(|hit| (hit.score, hit.path))
            .collect();
        assert_eq!(
            kept,
            vec![(10, "alpha".to_string()), (10, "beta".to_string())]
        );
    }
}
