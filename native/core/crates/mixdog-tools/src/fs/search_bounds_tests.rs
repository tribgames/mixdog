#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests build real work trees and inspect bounded walks")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_core_api::domain::common::{AbsPath, EventSource};
use mixdog_core_api::domain::fs::{
    DirEntry, EntryKind, FileBytes, FileService, FileStat, FsError, LocatorStat, ReadRange, SearchClass, SearchMatch, SearchRequest, WalkRequest, WriteRequest,
};
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::tool::Tool;
use mixdog_rt::{DurabilityIo, InteractiveIo, MaintenanceIo};
use mixdog_workspace::localfs::LocalFileService;
use serde_json::json;
use tokio::sync::Barrier;

use super::tests::{context_seeded, small_dir, text_of};
use super::{FindTool, GlobTool, GrepTool};

#[derive(Default)]
struct SpyState {
    walk_requests: Mutex<Vec<WalkRequest>>,
    flood_list_dir: bool,
    search_barrier: Option<Arc<Barrier>>,
    newest_path: Option<AbsPath>,
    symlink_paths: Vec<AbsPath>,
}

struct BarrierSource {
    inner: Box<dyn EventSource<Result<SearchMatch, FsError>>>,
    barrier: Option<Arc<Barrier>>,
}

#[async_trait]
impl EventSource<Result<SearchMatch, FsError>> for BarrierSource {
    async fn next(&mut self) -> Option<Result<SearchMatch, FsError>> {
        if let Some(barrier) = self.barrier.take() {
            tokio::time::timeout(Duration::from_secs(3), barrier.wait()).await.expect("concurrent sections must reach the barrier together");
        }
        self.inner.next().await
    }

    async fn close(&mut self) {
        self.inner.close().await;
    }
}

struct SpyFileService {
    inner: Arc<dyn FileService>,
    state: Arc<SpyState>,
}

#[async_trait]
impl FileService for SpyFileService {
    async fn stat(&self, lane: InteractiveIo, path: AbsPath) -> Result<FileStat, FsError> {
        self.inner.stat(lane, path).await
    }

    async fn stat_for_locator(&self, lane: InteractiveIo, path: AbsPath) -> Result<LocatorStat, FsError> {
        let mut stat = self.inner.stat_for_locator(lane, path.clone()).await?;
        if self.state.newest_path.as_ref() == Some(&path) {
            stat.modified = Some(UNIX_EPOCH + Duration::from_secs(2_000_000_000));
        } else if self.state.newest_path.is_some() {
            stat.modified = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000));
        }
        Ok(stat)
    }

    async fn lstat_for_locator(&self, lane: InteractiveIo, path: AbsPath) -> Result<LocatorStat, FsError> {
        let mut stat = self.inner.lstat_for_locator(lane, path.clone()).await?;
        if self.state.symlink_paths.contains(&path) {
            stat.kind = EntryKind::Symlink;
        }
        Ok(stat)
    }

    async fn read(&self, lane: InteractiveIo, path: AbsPath, range: ReadRange) -> Result<FileBytes, FsError> {
        self.inner.read(lane, path, range).await
    }

    async fn list_dir(&self, lane: InteractiveIo, path: AbsPath) -> Result<Vec<DirEntry>, FsError> {
        if self.state.flood_list_dir {
            return Ok(vec![DirEntry { path: path.join("d0"), kind: EntryKind::Dir }, DirEntry { path: path.join("d1"), kind: EntryKind::Dir }]);
        }
        self.inner.list_dir(lane, path).await
    }

    async fn write(&self, lane: DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError> {
        self.inner.write(lane, request).await
    }

    async fn write_batch(&self, lane: DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<FileStat>, FsError> {
        self.inner.write_batch(lane, requests).await
    }

    async fn create_dir(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        self.inner.create_dir(lane, path, recursive).await
    }

    async fn rename(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        self.inner.rename(lane, from, to, overwrite).await
    }

    async fn copy(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        self.inner.copy(lane, from, to, overwrite).await
    }

    async fn remove(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        self.inner.remove(lane, path, recursive).await
    }

    fn walk(&self, lane: MaintenanceIo, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        self.state.walk_requests.lock().unwrap().push(request.clone());
        self.inner.walk(lane, request)
    }

    fn search_text(&self, lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        let barrier = (request.class == SearchClass::Interactive).then(|| self.state.search_barrier.clone()).flatten();
        Box::new(BarrierSource { inner: self.inner.search_text(lane, request), barrier })
    }

    fn search_summary(&self, lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        let barrier = (request.class == SearchClass::Interactive).then(|| self.state.search_barrier.clone()).flatten();
        Box::new(BarrierSource { inner: self.inner.search_summary(lane, request), barrier })
    }
}

#[tokio::test]
async fn find_exact_basename_ranks_by_relative_path_and_reports_omitted() {
    let (_dir, root) = small_dir();
    let seeds = vec![("core/index.ts".to_owned(), Vec::new()), ("core-utils/index.ts".to_owned(), Vec::new())];
    let ctx = context_seeded(&root, Arc::new(LocalFileService::new()), seeds).await;

    let out = FindTool::new().call(&ctx, json!({ "query": "index.ts", "limit": 1 })).await.unwrap();
    assert_eq!(out.meta.as_ref().unwrap()["complete"], json!(true));
    let (_, text) = text_of(Ok(out));
    assert_eq!(text, "core-utils/index.ts\n... (top 1; additional matches omitted)");
}

#[tokio::test]
async fn glob_starts_at_relative_fixed_prefix_and_handles_missing_and_negations() {
    let (_dir, root) = small_dir();
    let seeds =
        vec![("design/mockups/a.png".to_owned(), Vec::new()), ("design/mockups/sub/b.png".to_owned(), Vec::new()), ("other/big/c.png".to_owned(), Vec::new())];
    let state = Arc::new(SpyState::default());
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state: state.clone() });
    let ctx = context_seeded(&root, service, seeds).await;

    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "design/mockups/**/*", "limit": 0, "sort": "natural" })).await);
    assert!(!failed, "{text}");
    assert_eq!(text, "design/mockups/a.png\ndesign/mockups/sub/b.png");
    {
        let reqs = state.walk_requests.lock().unwrap();
        let bulk: Vec<_> = reqs.iter().filter(|r| r.server == Some(SearchClass::Bulk)).collect();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].root, root.join("design/mockups"));
    }

    state.walk_requests.lock().unwrap().clear();
    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": ["design/mockups/**/*", "!design/mockups/sub/**"], "sort": "natural" })).await);
    assert!(!failed, "{text}");
    assert_eq!(text, "design/mockups/a.png");
    {
        let reqs = state.walk_requests.lock().unwrap();
        let bulk: Vec<_> = reqs.iter().filter(|r| r.server == Some(SearchClass::Bulk)).collect();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].root, root.join("design/mockups"));
    }

    state.walk_requests.lock().unwrap().clear();
    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "missing/dir/**/*.png" })).await);
    assert!(!failed, "{text}");
    assert!(text.starts_with("(no files found)"), "{text}");
    assert!(state.walk_requests.lock().unwrap().is_empty(), "missing relative prefix should not walk the workspace");
}

#[tokio::test]
async fn glob_relative_prefix_preserves_noise_gitignore_and_symlink_filters() {
    let (_dir, root) = small_dir();
    let seeds = vec![
        (".gitignore".to_owned(), b"dist/\n".to_vec()),
        ("node_modules/react/index.js".to_owned(), Vec::new()),
        (".git/HEAD".to_owned(), b"ref: refs/heads/main\n".to_vec()),
        ("dist/bundle.js".to_owned(), Vec::new()),
        ("link/sub/a.js".to_owned(), Vec::new()),
    ];
    let state = Arc::new(SpyState { symlink_paths: vec![root.join("link")], ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state: state.clone() });
    let ctx = context_seeded(&root, service, seeds).await;
    let glob = GlobTool::new();

    for pattern in ["node_modules/react/**/*.js", ".git/**", "dist/**/*.js", "link/sub/**/*.js"] {
        let (failed, text) = text_of(glob.call(&ctx, json!({ "pattern": pattern })).await);
        assert!(!failed, "{pattern}: {text}");
        assert!(text.starts_with("(no files found)"), "{pattern} should be filtered out with include_noise:false: {text}");
    }

    for (pattern, expected) in [("node_modules/react/**/*.js", "node_modules/react/index.js"), (".git/**", ".git/HEAD"), ("dist/**/*.js", "dist/bundle.js")] {
        let (failed, text) = text_of(glob.call(&ctx, json!({ "pattern": pattern, "include_noise": true })).await);
        assert!(!failed, "{pattern}: {text}");
        assert_eq!(text, expected, "{pattern} with include_noise:true");
    }

    // Even with include_noise:true, an earlier symlink component in the prefix must not be followed.
    let (failed, text) = text_of(glob.call(&ctx, json!({ "pattern": "link/sub/**/*.js", "include_noise": true })).await);
    assert!(!failed, "{text}");
    assert!(text.starts_with("(no files found)"), "symlink prefix must not be followed: {text}");
}

#[tokio::test]
async fn glob_bounds_depth_for_patterns_without_globstar() {
    let (_dir, root) = small_dir();
    let seeds = vec![("cursor1.txt".to_owned(), Vec::new()), ("sub/cursor2.txt".to_owned(), Vec::new()), ("sub/deep/cursor3.txt".to_owned(), Vec::new())];
    let state = Arc::new(SpyState::default());
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state: state.clone() });
    let ctx = context_seeded(&root, service, seeds).await;

    let abs_one_level = format!("{}/cursor*", root.as_path().to_string_lossy().replace('\\', "/"));
    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": abs_one_level, "sort": "natural" })).await);
    assert!(!failed, "{text}");
    assert_eq!(text, "cursor1.txt");
    {
        let reqs = state.walk_requests.lock().unwrap();
        let bulk: Vec<_> = reqs.iter().filter(|r| r.server == Some(SearchClass::Bulk)).collect();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].descent.max_depth, Some(1));
    }

    state.walk_requests.lock().unwrap().clear();
    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "sub/*/*.txt", "sort": "natural" })).await);
    assert!(!failed, "{text}");
    assert_eq!(text, "sub/deep/cursor3.txt");
    {
        let reqs = state.walk_requests.lock().unwrap();
        let bulk: Vec<_> = reqs.iter().filter(|r| r.server == Some(SearchClass::Bulk)).collect();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].root, root.join("sub"));
        assert_eq!(bulk[0].descent.max_depth, Some(2));
    }

    state.walk_requests.lock().unwrap().clear();
    let (failed, text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "sub/**/*.txt", "sort": "natural" })).await);
    assert!(!failed, "{text}");
    assert_eq!(text, "sub/cursor2.txt\nsub/deep/cursor3.txt");
    {
        let reqs = state.walk_requests.lock().unwrap();
        let bulk: Vec<_> = reqs.iter().filter(|r| r.server == Some(SearchClass::Bulk)).collect();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].descent.max_depth, None);
    }
}

#[tokio::test]
async fn glob_bounded_mtime_and_natural_see_entries_past_accum_cap() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-past-accum-cap").join("ws")).unwrap();
    let mut seeds: Vec<(String, Vec<u8>)> = (0..50_000).map(|i| (format!("f/{i:05}.txt"), Vec::new())).collect();
    seeds.push(("zz/newest.txt".to_owned(), Vec::new()));
    let state = Arc::new(SpyState { newest_path: Some(root.join("zz/newest.txt")), ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(MockFileService::default()), state });
    let ctx = context_seeded(&root, service, seeds).await;

    let (failed, mtime_text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "**/*.txt", "limit": 1 })).await);
    assert!(!failed, "{mtime_text}");
    assert_eq!(mtime_text, "zz/newest.txt\n[entries 1-1 of 50001; offset:1 for more]");

    let (failed, natural_text) = text_of(GlobTool::new().call(&ctx, json!({ "pattern": "**/*.txt", "sort": "natural", "offset": 50_000, "limit": 1 })).await);
    assert!(!failed, "{natural_text}");
    assert_eq!(natural_text, "zz/newest.txt");
}

#[tokio::test]
async fn grep_missing_path_does_not_launch_whole_tree_glob() {
    let (_dir, root) = small_dir();
    let state = Arc::new(SpyState { flood_list_dir: true, ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state: state.clone() });
    let ctx = context_seeded(&root, service, vec![("real/target.rs".to_owned(), b"needle\n".to_vec())]).await;

    let (failed, text) = text_of(GrepTool::new().call(&ctx, json!({ "pattern": "needle", "path": "missing/target.rs" })).await);
    assert!(!failed, "{text}");
    assert!(text.contains("Error: path does not exist:"), "{text}");
    assert!(text.contains("Locate with find on the basename before retrying."), "{text}");
    assert!(!text.contains("same-named indexed file"), "{text}");
    assert!(state.walk_requests.lock().unwrap().is_empty(), "missing-path grep must not launch a glob walk");
}

#[tokio::test]
async fn grep_runs_multi_pattern_and_multi_path_sections_concurrently() {
    let (_dir, root) = small_dir();
    let seeds = vec![
        ("a/x.txt".to_owned(), b"alpha\nbeta\ngamma\n".to_vec()),
        ("b/x.txt".to_owned(), b"alpha\n".to_vec()),
        ("c/x.txt".to_owned(), b"alpha\n".to_vec()),
    ];

    // Multi-pattern content grep with automatic context (falls back from combined_patterns to per-pattern scans).
    let state = Arc::new(SpyState { search_barrier: Some(Arc::new(Barrier::new(3))), ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state });
    let ctx = context_seeded(&root, service, seeds.clone()).await;
    let (failed, text) = text_of(GrepTool::new().call(&ctx, json!({ "pattern": ["alpha", "beta", "gamma"], "path": "a" })).await);
    assert!(!failed, "{text}");
    assert!(text.contains("# grep pattern:\"alpha\"") && text.contains("# grep pattern:\"beta\"") && text.contains("# grep pattern:\"gamma\""), "{text}");

    // Multi-path combined_collect (content mode, single pattern).
    let state = Arc::new(SpyState { search_barrier: Some(Arc::new(Barrier::new(3))), ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state });
    let ctx = context_seeded(&root, service, seeds.clone()).await;
    let (failed, text) = text_of(GrepTool::new().call(&ctx, json!({ "pattern": "alpha", "path": ["a", "b", "c"], "context": 0 })).await);
    assert!(!failed, "{text}");
    assert!(text.contains("# grep a") && text.contains("# grep b") && text.contains("# grep c"), "{text}");

    // Multi-path fallback (count mode declines combined_collect and fans out in GrepTool::answer).
    let state = Arc::new(SpyState { search_barrier: Some(Arc::new(Barrier::new(3))), ..SpyState::default() });
    let service = Arc::new(SpyFileService { inner: Arc::new(LocalFileService::new()), state });
    let ctx = context_seeded(&root, service, seeds).await;
    let (failed, text) = text_of(GrepTool::new().call(&ctx, json!({ "pattern": "alpha", "path": ["a", "b", "c"], "mode": "count" })).await);
    assert!(!failed, "{text}");
    assert!(text.contains("# grep a") && text.contains("# grep b") && text.contains("# grep c"), "{text}");
}
