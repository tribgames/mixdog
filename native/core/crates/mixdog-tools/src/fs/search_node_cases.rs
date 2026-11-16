//! Node's search-tool cases (`fixtures/fs-search-cases`, `record-fs-search-cases.mjs`): each recorded call through the
//! Rust `find`, `glob` or `grep` tool on the workspace the case names, its whole text against Node's, in order.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the replay builds real work trees with blocking filesystem calls"
)]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::*;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use tokio_util::sync::CancellationToken;

use super::*;

fn golden() -> JsonValue {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fs-search-cases/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A walk that lists what the inner walk listed (all of it, read before the search starts, so no real thread work is awaited while
/// the runtime's clock is paused) and then waits on a gate the test owns and never opens: with a deadline, the tool's search ends
/// partial holding exactly those entries (Node's served partial). `listed` is signalled once everything is listed.
struct ThenStall(std::collections::VecDeque<Result<DirEntry, FsError>>, Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>);

#[async_trait::async_trait]
impl EventSource<Result<DirEntry, FsError>> for ThenStall {
    async fn next(&mut self) -> Option<Result<DirEntry, FsError>> {
        if let Some(item) = self.0.pop_front() {
            return Some(item);
        }
        self.1.notify_one();
        let _ = self.2.acquire().await;
        None
    }
}

struct Stalling(Arc<dyn FileService>, Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>);

#[async_trait::async_trait]
impl FileService for Stalling {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<FileStat, FsError> {
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: ReadRange) -> Result<FileBytes, FsError> {
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<DirEntry>, FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<FileStat>, FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        let mut inner = self.0.walk(lane, request);
        let mut listed = std::collections::VecDeque::new();
        while let Some(item) = futures::executor::block_on(inner.next()) {
            listed.push_back(item);
        }
        Box::new(ThenStall(listed, self.1.clone(), self.2.clone()))
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        self.0.search_text(lane, request)
    }
}

fn context(root: &AbsPath, files: Arc<dyn FileService>, deadline: Option<std::time::Instant>) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "fs".into(),
        cwd: root.clone(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files,
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// The case's workspace on disk: its files (one fixed mtime), `.gitignore` and extra directories.
fn build_on_disk(root: &Path, case: &JsonValue, mtime: std::time::SystemTime) {
    std::fs::create_dir_all(root).unwrap();
    for dir in case["dirs"].as_array().into_iter().flatten() {
        std::fs::create_dir_all(root.join(dir.as_str().unwrap())).unwrap();
    }
    if let Some(ignore) = case["gitignore"].as_str() {
        std::fs::write(root.join(".gitignore"), ignore).unwrap();
    }
    for (rel, text) in case["files"].as_object().into_iter().flatten() {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text.as_str().unwrap()).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
    }
}

fn tool(name: &str) -> Box<dyn Tool> {
    match name {
        "find" => Box::new(FindTool::new()),
        "glob" => Box::new(GlobTool::new()),
        "grep" => Box::new(GrepTool::new()),
        other => panic!("no tool {other}"),
    }
}

fn text_of(outcome: ToolOutcome) -> String {
    match outcome {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => t.clone(),
            _ => panic!("not text"),
        },
        Err(e) => e.message_for_model,
    }
}

#[tokio::test]
async fn every_recorded_search_call_answers_nodes_text() {
    replay_cases(false).await;
}

/// The served partial, on a runtime clock that is paused from the start (no real time passes): a walk that listed what it found and
/// then waits on a gate the test owns answers nothing until the clock is advanced to the search's soft deadline (the 17.5 s budget
/// less its 1312 ms margin: 16 188 ms), and then answers what it listed. One millisecond short of it the search is still waiting.
/// A deadline read off the wall clock instead of the runtime's would lie some real time after the paused clock's start, and the
/// advance to the soft deadline would not reach it.
#[tokio::test(start_paused = true)]
async fn a_stalled_walk_answers_its_partial_at_the_soft_deadline() {
    replay_cases(true).await;
}

#[tokio::test(start_paused = true)]
async fn a_queued_walk_returns_its_partial_before_the_remaining_total_budget_expires() {
    use std::time::Duration;

    for (name, args) in [
        ("glob", serde_json::json!({ "pattern": "*.rs", "sort": "natural" })),
        ("find", serde_json::json!({ "query": "needle" })),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = AbsPath::new(dir.path().to_path_buf()).unwrap();
        let files = Arc::new(mixdog_core_api::domain::mock::MockFileService::default());
        let seeded = super::tests::context_seeded(&root, files.clone(), vec![("needle.rs".to_owned(), b"needle\n".to_vec())]).await;
        let files = Arc::new(Stalling(files, Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0))));
        let holder_ctx = context(&root, files.clone(), None);
        let waiter_ctx = ToolContext { files, ..seeded };
        let holder_tool = FindTool::new();
        let waiter_tool = tool(name);
        let mut holder = Box::pin(holder_tool.call(&holder_ctx, serde_json::json!({ "query": "needle" })));
        let mut waiter = Box::pin(waiter_tool.call(&waiter_ctx, args));
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(holder.as_mut().poll(cx))).await.is_pending());
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(waiter.as_mut().poll(cx))).await.is_pending());

        tokio::time::advance(Duration::from_millis(10_000)).await;
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(waiter.as_mut().poll(cx))).await.is_pending());
        holder_ctx.cancel.cancel();
        assert!(matches!(holder.await.unwrap_err().code, ToolErrorCode::Cancelled));
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(waiter.as_mut().poll(cx))).await.is_pending());

        // 17 500 ms total minus 10 000 ms queued leaves 7 500 ms, with a 562 ms response margin.
        tokio::time::advance(Duration::from_millis(6_937)).await;
        assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(waiter.as_mut().poll(cx))).await.is_pending());
        tokio::time::advance(Duration::from_millis(1)).await;
        let out = match std::future::poll_fn(|cx| std::task::Poll::Ready(waiter.as_mut().poll(cx))).await {
            std::task::Poll::Ready(out) => out.expect("collected rows must survive the admission wait"),
            std::task::Poll::Pending => panic!("{name}: no partial before the total hard deadline"),
        };
        let text = text_of(Ok(out));
        assert!(text.contains("needle.rs"), "{name}: {text}");
        assert!(text.contains("partial"), "{name}: {text}");
    }
}

async fn replay_cases(stalled: bool) {
    let golden = golden();
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_767_323_045); // the recording's 2026-01-02T03:04:05Z
    assert_eq!(golden["mtime"], "2026-01-02T03:04:05.000Z");
    let mut failures = Vec::new();
    let mut compared = 0;
    let cases: Vec<&JsonValue> = golden["cases"].as_array().unwrap().iter().filter(|case| (case["stall"] == true) == stalled).collect();
    assert!(!cases.is_empty());
    for case in cases.iter().copied() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("ws");
        let root = AbsPath::new(&root_path).unwrap();
        build_on_disk(&root_path, case, mtime);
        let files: Arc<dyn FileService> = Arc::new(mixdog_workspace::localfs::LocalFileService::new());
        let listed = Arc::new(tokio::sync::Notify::new());
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let files: Arc<dyn FileService> = if stalled { Arc::new(Stalling(files, listed.clone(), gate)) } else { files };
        let tool = tool(case["tool"].as_str().unwrap());
        let shown = root_path.to_string_lossy().into_owned();
        for (n, call) in case["calls"].as_array().unwrap().iter().enumerate() {
            // No caller deadline: the client's full timeout (17.5 s) from the runtime's now, whose soft deadline is that less 7.5 % (16 188 ms).
            let ctx = context(&root, files.clone(), None);
            let args: JsonValue = serde_json::from_str(&call["args"].to_string().replace("<ROOT>", &shown.replace('\\', "/"))).unwrap();
            let outcome = if stalled {
                let mut call = std::pin::pin!(tool.call(&ctx, args));
                tokio::select! {
                    out = &mut call => panic!("{name} call {n}: answered before the walk stalled: {out:?}"),
                    () = listed.notified() => {}
                }
                // One millisecond short of the soft deadline nothing is answered; at it the partial is.
                tokio::time::advance(std::time::Duration::from_millis(16_187)).await;
                let early = std::future::poll_fn(|cx| std::task::Poll::Ready(call.as_mut().poll(cx))).await;
                assert!(early.is_pending(), "{name} call {n}: answered before the soft deadline: {early:?}");
                tokio::time::advance(std::time::Duration::from_millis(1)).await;
                // Polled once, not awaited: an idle paused clock would jump to any pending deadline by itself.
                match std::future::poll_fn(|cx| std::task::Poll::Ready(call.as_mut().poll(cx))).await {
                    std::task::Poll::Ready(outcome) => outcome,
                    std::task::Poll::Pending => panic!("{name} call {n}: no answer at the soft deadline"),
                }
            } else {
                tool.call(&ctx, args).await
            };
            let text = text_of(outcome);
            let text = text.replace(&shown, "<ROOT>").replace(&shown.replace('\\', "/"), "<ROOT>");
            let mut want = call["result"].as_str().unwrap().to_owned();
            if let Some(notice) = case["rescueNotice"].as_str() {
                want = want.strip_suffix(notice).expect("the rescue notice ends the Node text").to_owned();
            }
            let want = super::tests::timeout_wording(&want);
            if text != want {
                let at = want.bytes().zip(text.bytes()).take_while(|(a, b)| a == b).count();
                let from = want.floor_char_boundary(at.saturating_sub(200));
                failures.push(format!(
                    "{name} call {n} (first difference at byte {at}, {} vs {} bytes):\n  want …{:?}\n  got  …{:?}",
                    want.len(),
                    text.len(),
                    &want[from..want.floor_char_boundary(at + 400)],
                    &text[from..text.floor_char_boundary(at + 400)]
                ));
            }
            compared += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n").chars().take(20_000).collect::<String>());
    assert_eq!(compared, cases.iter().map(|c| c["calls"].as_array().unwrap().len()).sum::<usize>());
}
