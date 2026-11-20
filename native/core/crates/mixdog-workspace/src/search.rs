//! Sessioned fuzzy file search (DS §4.5; port of `project-file-search.ts`
//! ranking and walk rules). The tree is walked once per root on the maintenance
//! lane and kept while a session is open; the watcher marks it stale. Scoring
//! runs on the bulk CPU lane. A new `update` supersedes the running one, which
//! stops without publishing.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::feed::ScopedFeeds;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::WsError;
use crate::error::WsResult;
use crate::feedpub::Publisher;
use crate::lanes::Lanes;
use crate::lanes::run;
use crate::pathguard::comparable;
use crate::rank::FileMatch;
use crate::rank::compare;
use crate::rank::match_file;
use crate::rank::normalize_query;
use crate::walk::INDEX_MAX_ENTRIES;
use crate::walk::Pending;
use crate::walk::index_paths;
use crate::walk::matches_beyond;
use crate::watcher::FolderWatcher;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;
/// Time the walk past the scan cap may take.
const BEYOND_BUDGET: std::time::Duration = std::time::Duration::from_millis(400);

#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub roots: Vec<PathBuf>,
    pub limit: Option<usize>,
    pub include_ignored: bool,
    pub include_directories: bool,
    pub consumer: Option<String>,
    /// Entries the index scan visits before leaving folders to the per-query walk.
    pub scan_cap: Option<usize>,
    /// Time the walk past the scan cap may take (Node's `beyondBudgetMs`, default 400 ms).
    pub beyond_budget: Option<std::time::Duration>,
}

struct Index {
    files: Vec<String>,
    /// Folders the scan cap left unvisited (empty when the whole tree was walked).
    pending: Vec<Pending>,
    /// Every path beyond the index containing the needle, from a walk that finished: any query
    /// containing the needle is answered from it without walking again.
    beyond: Mutex<Option<(String, Vec<String>)>>,
}

type IndexKey = (PathBuf, bool, usize);

fn index_key(root: &Path, config: &SessionConfig) -> IndexKey {
    (comparable(root), config.include_ignored, config.scan_cap.unwrap_or(INDEX_MAX_ENTRIES).max(1))
}

struct IndexSlot {
    building: tokio::sync::Semaphore,
    current: Mutex<Option<(Arc<()>, Arc<Index>)>>,
}

impl Default for IndexSlot {
    fn default() -> Self {
        Self { building: tokio::sync::Semaphore::new(1), current: Mutex::default() }
    }
}

struct Session {
    id: String,
    config: SessionConfig,
    generation: Arc<AtomicU64>,
    cancel: CancellationToken,
    publisher: Arc<Publisher>,
}

pub struct SearchSessions {
    lanes: Lanes,
    feeds: Arc<dyn ScopedFeeds>,
    watcher: Arc<FolderWatcher>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    indexes: Mutex<HashMap<IndexKey, Arc<IndexSlot>>>,
}

/// The watch id a session uses to learn that a root changed.
pub fn index_watch_id(session: &str, root: usize) -> String {
    format!("idx:{session}:{root}")
}

impl SearchSessions {
    pub fn new(lanes: Lanes, feeds: Arc<dyn ScopedFeeds>, watcher: Arc<FolderWatcher>) -> Arc<Self> {
        Arc::new(Self {
            lanes,
            feeds,
            watcher,
            sessions: Mutex::default(),
            indexes: Mutex::default(),
        })
    }

    pub fn start(&self, session_id: &str, config: SessionConfig) -> WsResult<Arc<Publisher>> {
        let mut sessions = self.sessions.lock().expect("search sessions");
        if sessions.contains_key(session_id) {
            return Err(WsError::invalid("Search session id is already in use."));
        }
        if let Some(consumer) = &config.consumer {
            // The consumer's next search supersedes its previous one.
            for other in sessions.values().filter(|s| s.config.consumer.as_ref() == Some(consumer)) {
                other.generation.fetch_add(1, Ordering::SeqCst);
            }
        }
        for (i, root) in config.roots.iter().enumerate() {
            if let Err(error) = self.watcher.watch(&index_watch_id(session_id, i), root, true) {
                for prior in 0..i {
                    self.watcher.unwatch(&index_watch_id(session_id, prior));
                }
                return Err(error);
            }
        }
        let publisher = Arc::new(Publisher::create(
            self.feeds.as_ref(),
            &format!("search:{session_id}"),
            json!({ "query": "", "files": [] }),
        ));
        sessions.insert(
            session_id.to_owned(),
            Arc::new(Session {
                id: session_id.to_owned(),
                config,
                generation: Arc::new(AtomicU64::new(0)),
                cancel: CancellationToken::new(),
                publisher: publisher.clone(),
            }),
        );
        Ok(publisher)
    }

    /// `lone`: the query held an unpaired surrogate escape on the wire (now U+FFFD). Node's needle keeps the lone unit, which no
    /// path read from disk holds (shared/file-match.ts:34-55): the query matches nothing, where U+FFFD would match real ones.
    pub fn update(self: &Arc<Self>, session_id: &str, query: String, lone: bool) -> WsResult<()> {
        let session = self
            .sessions
            .lock()
            .expect("search sessions")
            .get(session_id)
            .cloned()
            .ok_or_else(|| WsError::invalid("Search session is not open."))?;
        let generation = session.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        tokio::spawn(async move {
            let _ = this.search(&session, generation, query, lone).await;
        });
        Ok(())
    }

    pub fn stop(&self, session_id: &str) {
        let session = {
            let mut sessions = self.sessions.lock().expect("search sessions");
            let Some(session) = sessions.remove(session_id) else { return };
            session.generation.fetch_add(1, Ordering::SeqCst);
            session.cancel.cancel();
            let live: HashSet<_> = sessions.values()
                .flat_map(|s| s.config.roots.iter().map(|r| index_key(r, &s.config)))
                .collect();
            self.indexes.lock().expect("search indexes").retain(|key, _| live.contains(key));
            session
        };
        for i in 0..session.config.roots.len() {
            self.watcher.unwatch(&index_watch_id(session_id, i));
        }
        session.publisher.close();
    }

    /// Index slots for watched roots (freed when the last matching session stops).
    pub fn index_count(&self) -> usize {
        self.indexes.lock().expect("search indexes").len()
    }

    async fn index_for(&self, session: &Session, generation: u64, root_no: usize, root: &Path) -> WsResult<Option<Arc<Index>>> {
        let walk_root = root.to_path_buf();
        let watch = SessionStop { generation, session_generation: session.generation.clone() };
        self.index_with(session, generation, root_no, root, |include_ignored, scan_cap| async move {
            run(self.lanes.maintenance, &session.cancel, move || {
                index_paths(&walk_root, include_ignored, scan_cap, &|| watch.superseded())
            }).await
        }).await
    }

    async fn index_with<F>(
        &self,
        session: &Session,
        generation: u64,
        root_no: usize,
        root: &Path,
        walk: impl FnOnce(bool, usize) -> F,
    ) -> WsResult<Option<Arc<Index>>>
    where
        F: std::future::Future<Output = WsResult<(Vec<String>, Vec<Pending>)>> + Send,
    {
        let key = index_key(root, &session.config);
        let (_, include_ignored, scan_cap) = key;
        let slot = {
            let mut indexes = self.indexes.lock().expect("search indexes");
            if session.generation.load(Ordering::SeqCst) != generation {
                return Ok(None);
            }
            indexes.entry(key).or_default().clone()
        };
        let _build = slot.building.acquire().await.expect("the build gate is never closed");
        if session.generation.load(Ordering::SeqCst) != generation {
            return Ok(None);
        }
        let watch_id = index_watch_id(&session.id, root_no);
        let coverage = self.watcher.coverage(&watch_id);
        {
            let mut current = slot.current.lock().expect("index state");
            if let Some((built_under, index)) = &*current
                && coverage.as_ref().is_some_and(|now| Arc::ptr_eq(now, built_under))
            {
                return Ok(Some(index.clone()));
            }
            *current = None;
        }
        let (files, pending) = walk(include_ignored, scan_cap).await?;
        if session.generation.load(Ordering::SeqCst) != generation {
            return Ok(None);
        }
        let index = Arc::new(Index { files, pending, beyond: Mutex::new(None) });
        if let (Some(before), Some(after)) = (coverage, self.watcher.coverage(&watch_id))
            && Arc::ptr_eq(&before, &after)
        {
            *slot.current.lock().expect("index state") = Some((before, index.clone()));
        }
        // This query gets one walk even on a busy tree. A walk invalidated while
        // it was running must not become the next query's cached view.
        Ok(Some(index))
    }

    /// Matches among the unvisited folders: answered from an earlier finished walk when the
    /// query extends its needle, else walked within the time budget (an unfinished walk keeps nothing).
    async fn beyond(&self, session: &Session, generation: u64, root: &Path, index: &Arc<Index>, query: &str) -> WsResult<Vec<String>> {
        let needle = normalize_query(query);
        if let Some((cached, matches)) = &*index.beyond.lock().expect("beyond cache")
            && needle.contains(cached.as_str()) {
            return Ok(matches.iter().filter(|p| match_file(p, query).is_some()).cloned().collect());
        }
        let (walk_root, pending, include_ignored, q) = (root.to_path_buf(), index.pending.clone(), session.config.include_ignored, query.to_owned());
        let watch = SessionStop { generation, session_generation: session.generation.clone() };
        let deadline = std::time::Instant::now() + session.config.beyond_budget.unwrap_or(BEYOND_BUDGET);
        let (found, finished) = run(self.lanes.maintenance, &session.cancel, move || {
            matches_beyond(&walk_root, &pending, include_ignored, &|| watch.superseded() || std::time::Instant::now() > deadline, &|p| match_file(p, &q).is_some())
        })
        .await?;
        // A walk the budget cut short answers with what it found and keeps nothing.
        if finished && found.len() <= INDEX_MAX_ENTRIES {
            *index.beyond.lock().expect("beyond cache") = Some((needle, found.clone()));
        }
        Ok(found)
    }

    async fn search(&self, session: &Arc<Session>, generation: u64, query: String, lone: bool) -> WsResult<()> {
        let mut scored_roots = Vec::new();
        for (root_no, root) in session.config.roots.iter().enumerate().filter(|_| !lone) {
            let Some(index) = self.index_for(session, generation, root_no, root).await? else { return Ok(()) };
            // The cap keeps the cached index small, not the search narrow: a typed query also
            // walks the folders the cap left over, keeping only what matches.
            let extra = if index.pending.is_empty() || normalize_query(&query).is_empty() {
                Vec::new()
            } else {
                let found = self.beyond(session, generation, root, &index, &query).await?;
                let indexed: std::collections::HashSet<&String> = index.files.iter().collect();
                found.into_iter().filter(|p| !indexed.contains(p)).collect()
            };
            scored_roots.push((root.clone(), index, extra));
        }
        let limit = session.config.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let include_directories = session.config.include_directories;
        let q = query.clone();
        let files = run(self.lanes.cpu_bulk, &session.cancel, move || rank_roots(&scored_roots, &q, limit, include_directories))
            .await?;
        if session.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        let state = json!({ "query": query, "files": files });
        session.publisher.publish(
            "search/updated",
            json!({ "sessionId": session.id, "query": query, "files": files }),
            Some(state),
        );
        session.publisher.publish("search/completed", json!({ "sessionId": session.id, "query": query }), None);
        Ok(())
    }
}

struct SessionStop {
    generation: u64,
    session_generation: Arc<AtomicU64>,
}

impl SessionStop {
    fn superseded(&self) -> bool {
        self.session_generation.load(Ordering::SeqCst) != self.generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::ChangeKind;
    use crate::watcher::ChangeSink;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;

    struct Null;
    impl ChangeSink for Null {
        fn changed(&self, _: &str, _: Vec<String>, _: ChangeKind) {}
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_scan_cap_leaves_folders_to_the_per_query_walk() {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        for d in ["a", "b", "c", "d"] {
            std::fs::create_dir_all(root.join(d).join("deep")).unwrap();
            for i in 0..5 {
                std::fs::write(root.join(d).join(format!("f{i}.txt")), "").unwrap();
            }
        }
        std::fs::write(root.join("d/deep/needle-file.rs"), "").unwrap();
        let feeds = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let sessions = SearchSessions::new(lanes, feeds, Arc::new(FolderWatcher::new(Arc::new(Null)).unwrap()));
        // The walk past the cap has a time budget (400 ms by default); a loaded machine must not
        // decide this test, so it gets a budget no walk reaches.
        let config = SessionConfig {
            roots: vec![root.clone()],
            limit: None,
            include_ignored: false,
            include_directories: false,
            consumer: None,
            scan_cap: Some(6),
            beyond_budget: Some(std::time::Duration::from_secs(600)),
        };
        let publisher = sessions.start("s", config).unwrap();
        let session = sessions.sessions.lock().unwrap().get("s").cloned().unwrap();
        let index = sessions.index_for(&session, 0, 0, &root).await.unwrap().unwrap();
        assert!(!index.pending.is_empty(), "the cap must leave folders unvisited");
        assert!(!index.files.iter().any(|f| f.contains("needle-file")));
        sessions.search(&session, 0, "needle-file".into(), false).await.unwrap();
        let files = publisher.state()["files"].to_string();
        assert!(files.contains("d/deep/needle-file.rs"), "{files}");
        // A longer query containing the first one is answered from the finished walk.
        sessions.search(&session, 0, "needle-file.r".into(), false).await.unwrap();
        // A watch that is still settling gives no coverage, so the first index may not have been cached and the searches
        // then ran on a later one: the finished walk is kept on the index the session holds now.
        let current = sessions.index_for(&session, 0, 0, &root).await.unwrap().unwrap();
        assert!(current.beyond.lock().unwrap().is_some());
        assert!(publisher.state()["files"].to_string().contains("needle-file.rs"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_walk_the_budget_cut_short_answers_with_the_index_and_keeps_nothing() {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        for d in ["a", "b", "c", "d"] {
            std::fs::create_dir_all(root.join(d).join("deep")).unwrap();
            for i in 0..5 {
                std::fs::write(root.join(d).join(format!("f{i}.txt")), "").unwrap();
            }
        }
        std::fs::write(root.join("d/deep/needle-file.rs"), "").unwrap();
        std::fs::write(root.join("top-file.txt"), "").unwrap();
        let feeds = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let sessions = SearchSessions::new(lanes, feeds, Arc::new(FolderWatcher::new(Arc::new(Null)).unwrap()));
        let config = SessionConfig {
            roots: vec![root.clone()],
            limit: None,
            include_ignored: false,
            include_directories: false,
            consumer: None,
            scan_cap: Some(6),
            beyond_budget: Some(std::time::Duration::ZERO),
        };
        let publisher = sessions.start("s", config).unwrap();
        let session = sessions.sessions.lock().unwrap().get("s").cloned().unwrap();
        let index = sessions.index_for(&session, 0, 0, &root).await.unwrap().unwrap();
        assert!(index.files.iter().any(|f| f == "top-file.txt"), "{:?}", index.files);
        sessions.search(&session, 0, "top-file".into(), false).await.unwrap();
        // The answer still comes (what the index holds), and the cut-short walk is not cached
        // as if it had finished.
        let files = publisher.state()["files"].to_string();
        assert!(files.contains("top-file.txt"), "{files}");
        assert!(index.beyond.lock().unwrap().is_none());
    }

    /// A query that held a lone surrogate matches no path, even one whose name holds a real U+FFFD (Node's needle keeps the
    /// lone unit, shared/file-match.ts:34-55); the same query typed with a real U+FFFD finds it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_query_that_held_a_lone_surrogate_matches_no_path() {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::write(root.join("a\u{fffd}.txt"), "").unwrap();
        let feeds = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let sessions = SearchSessions::new(lanes, feeds, Arc::new(FolderWatcher::new(Arc::new(Null)).unwrap()));
        let config = SessionConfig { roots: vec![root.clone()], limit: None, include_ignored: false, include_directories: false, consumer: None, scan_cap: None, beyond_budget: None };
        let publisher = sessions.start("s", config).unwrap();
        let session = sessions.sessions.lock().unwrap().get("s").cloned().unwrap();
        sessions.search(&session, 0, "\u{fffd}".into(), true).await.unwrap();
        assert_eq!(publisher.state()["files"], serde_json::json!([]));
        sessions.search(&session, 0, "\u{fffd}".into(), false).await.unwrap();
        assert!(publisher.state()["files"].to_string().contains("a\u{fffd}.txt"), "{}", publisher.state());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn overlapping_searches_share_the_walk_and_a_reopen_sees_invalidated_files() {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::write(root.join("before.txt"), "").unwrap();
        let feeds = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let sessions = SearchSessions::new(lanes, feeds, Arc::new(FolderWatcher::new(Arc::new(Null)).unwrap()));
        let config = SessionConfig { roots: vec![root.clone()], limit: None, include_ignored: false, include_directories: false, consumer: None, scan_cap: None, beyond_budget: None };
        let session = |id: &str| sessions.sessions.lock().unwrap().get(id).cloned().unwrap();
        sessions.start("first", config.clone()).unwrap();
        sessions.start("peer", config.clone()).unwrap();
        let (first, peer) = (session("first"), session("peer"));
        let (a, b) = tokio::join!(sessions.index_for(&first, 0, 0, &root), sessions.index_for(&peer, 0, 0, &root));
        let (a, b) = (a.unwrap().unwrap(), b.unwrap().unwrap());
        assert!(Arc::ptr_eq(&a, &b), "both searches use the same completed walk");
        sessions.stop("first");
        sessions.start("unchanged", config.clone()).unwrap();
        let reopened = sessions.index_for(&session("unchanged"), 0, 0, &root).await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&reopened, &b), "the peer kept the unchanged index watched");

        sessions.stop("unchanged");
        std::fs::rename(root.join("before.txt"), root.join("after.txt")).unwrap();
        // Only the old subscriber owns the queued event; its replacement has not subscribed yet.
        crate::watcher::queue_test_change(&sessions.watcher, root.join("after.txt"));
        let publisher = sessions.start("changed", config).unwrap();
        sessions.stop("peer");
        let changed = session("changed");
        sessions.search(&changed, 0, "after".into(), false).await.unwrap();
        let files = publisher.state()["files"].to_string();
        assert!(files.contains("after.txt"), "{files}");
        sessions.search(&changed, 0, "before".into(), false).await.unwrap();
        assert_eq!(publisher.state()["files"], json!([]));

        crate::watcher::queue_test_change(&sessions.watcher, root.join("after.txt"));
        let built_during_changes = sessions.index_with(&changed, 0, 0, &root, |_, _| async {
            crate::watcher::queue_test_change(&sessions.watcher, root.join("after.txt"));
            crate::watcher::queue_test_change(&sessions.watcher, root.join("after.txt"));
            Ok((vec!["during.txt".to_owned()], Vec::new()))
        }).await.unwrap().unwrap();
        assert_eq!(built_during_changes.files, ["during.txt"], "the query gets an answer without retrying");
        let next = sessions.index_for(&changed, 0, 0, &root).await.unwrap().unwrap();
        assert!(next.files.iter().any(|f| f == "after.txt"), "the invalidated walk was not cached");

        // Losing the backend watch must bypass the old index even without a file-change batch.
        sessions.watcher.unwatch(&index_watch_id("changed", 0));
        std::fs::rename(root.join("after.txt"), root.join("unwatched.txt")).unwrap();
        sessions.search(&changed, 0, "unwatched".into(), false).await.unwrap();
        assert!(publisher.state()["files"].to_string().contains("unwatched.txt"));
        std::fs::rename(root.join("unwatched.txt"), root.join("moved-again.txt")).unwrap();
        sessions.search(&changed, 0, "moved-again".into(), false).await.unwrap();
        assert!(publisher.state()["files"].to_string().contains("moved-again.txt"));
        sessions.stop("changed");
    }

    // Current-thread runtime: the 30 launched tasks cannot start before the test first awaits, so
    // every earlier query is already superseded when it runs.
    #[tokio::test(flavor = "current_thread")]
    async fn thirty_updates_end_with_the_last_query_and_stop_frees_the_index() {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("readme.md"), "").unwrap();
        let feeds = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let sessions = SearchSessions::new(lanes, feeds, Arc::new(FolderWatcher::new(Arc::new(Null)).unwrap()));
        let publisher = sessions
            .start("s1", SessionConfig { roots: vec![root.clone()], limit: None, include_ignored: false, include_directories: false, consumer: None, scan_cap: None, beyond_budget: None })
            .unwrap();
        for i in 0..29 {
            sessions.update("s1", format!("q{i}"), false).unwrap();
        }
        sessions.update("s1", "main".into(), false).unwrap();
        // Every launched search task holds a clone of `sessions` until it ends, so the strong count
        // returning to 1 means all 30 ended. A missing launch never changes the count, so the wait
        // is bounded by the position check below instead.
        let all_ended = async {
            while Arc::strong_count(&sessions) > 1 {
                tokio::task::yield_now().await;
            }
        };
        let _ = mixdog_rt::time::timeout(std::time::Duration::from_secs(5), all_ended).await;
        assert_eq!(Arc::strong_count(&sessions), 1, "searches are still running");
        // All 30 are superseded but the last: one search published (an updated and a completed
        // frame), so a stale one did not.
        assert_eq!(publisher.position().seq, 2, "update did not publish exactly the last query's search");
        let state = publisher.state();
        assert_eq!(state["query"], "main");
        assert!(state["files"].to_string().contains("src/main.rs"), "{state}");
        let position = publisher.source().feed_id();
        assert_eq!(position.to_string(), "search:s1");
        assert_eq!(sessions.index_count(), 1);
        sessions.stop("s1");
        assert_eq!(sessions.index_count(), 0);
    }
}

fn rank_roots(roots: &[(PathBuf, Arc<Index>, Vec<String>)], query: &str, limit: usize, include_directories: bool) -> Vec<Value> {
    struct Hit<'a> {
        root: &'a Path,
        path: &'a str,
        matched: FileMatch,
        name: &'a str,
        directory: bool,
    }
    let root_only = normalize_query(query).is_empty();
    let mut hits: Vec<Hit> = Vec::new();
    for (root, index, extra) in roots {
        for path in index.files.iter().chain(extra) {
            let directory = path.ends_with('/');
            if directory && !include_directories {
                continue;
            }
            let entry = path.strip_suffix('/').unwrap_or(path);
            if root_only && entry.contains('/') {
                continue;
            }
            if let Some(matched) = match_file(path, query) {
                let name = entry.rsplit('/').next().unwrap_or(entry);
                hits.push(Hit { root, path, matched, name, directory });
            }
        }
    }
    if root_only {
        hits.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| mixdog_js::locale_compare(a.name, b.name))
                .then_with(|| mixdog_js::locale_compare(a.path, b.path))
        });
    } else {
        hits.sort_by(|a, b| compare((a.path, &a.matched), (b.path, &b.matched)));
    }
    hits.into_iter()
        .take(limit)
        .map(|h| {
            let path = h.path.strip_suffix('/').unwrap_or(h.path);
            json!({
                "root": h.root.to_string_lossy(),
                "path": path,
                "matchType": if h.directory { "directory" } else { "file" },
                "fileName": h.name,
                "score": 1000u32.saturating_sub(u32::from(h.matched.tier) * 100),
                "indices": (h.matched.start..h.matched.end).collect::<Vec<_>>(),
            })
        })
        .collect()
}
