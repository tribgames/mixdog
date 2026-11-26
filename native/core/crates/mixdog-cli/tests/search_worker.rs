//! `mixdogd search-worker`: the search helper a core's `SearchHost` starts as this program.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test writes its folder with blocking calls on the test thread and ends the helper as a crash would"
)]

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::SearchClass;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_graph_host::clock::ManualClock;
use mixdog_search_host::CloseOutcome;
use mixdog_search_host::HostConfig;
use mixdog_search_host::HostEvent;
use mixdog_search_host::HostState;
use mixdog_search_host::IDLE;
use mixdog_search_host::OwnedCommand;
use mixdog_search_host::SearchHost;
use mixdog_workspace::localfs::QUEUE;

/// How long an awaited event may take before the test fails instead of hanging.
const BOUND: Duration = Duration::from_secs(120);

async fn within<T>(future: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(BOUND, future).await.expect("the awaited event did not come")
}

/// `a.txt` and `b/c.txt` with a needle each, and `many.txt` with three queues' worth of needles.
fn tree() -> (tempfile::TempDir, AbsPath) {
    let dir = tempfile::tempdir().expect("tmp");
    std::fs::write(dir.path().join("a.txt"), "needle\n").unwrap();
    std::fs::create_dir(dir.path().join("b")).unwrap();
    std::fs::write(dir.path().join("b").join("c.txt"), "a needle\n").unwrap();
    std::fs::write(dir.path().join("many.txt"), "needle\n".repeat(3 * QUEUE)).unwrap();
    let root = AbsPath::new(dir.path().canonicalize().unwrap()).unwrap();
    (dir, root)
}

fn config() -> HostConfig {
    HostConfig::new(OwnedCommand::new(mixdog_testkit::bin_exe!("mixdogd")).arg("search-worker"), BOUND)
}

fn host() -> (SearchHost, tokio::task::JoinHandle<()>) {
    let (host, driver) = SearchHost::new(config());
    (host, tokio::spawn(driver))
}

fn needle(root: &AbsPath) -> SearchRequest {
    SearchRequest {
        root: root.clone(),
        pattern: "needle".into(),
        regex: true,
        case_sensitive: true,
        include_globs: Vec::new(),
        exclude_globs: Vec::new(),
        include_hidden: true,
        respect_ignore: false,
        multiline: false,
        pcre2: false,
        binary_as_text: false,
        limit: None,
        first_per_file: false,
        deadline: None,
        class: SearchClass::Interactive,
    }
}

fn under(root: &AbsPath, path: &AbsPath) -> String {
    path.as_path().strip_prefix(root.as_path()).unwrap().to_string_lossy().replace('\\', "/")
}

async fn drained<T: Send>(stream: &mut Box<dyn EventSource<Result<T, FsError>>>) -> Vec<Result<T, FsError>> {
    let mut items = Vec::new();
    while let Some(item) = within(stream.next()).await {
        items.push(item);
    }
    within(stream.close()).await;
    items
}

/// The helper the registered subcommand runs streams a search's matches in path order, stops a search closed mid-stream,
/// keeps serving, streams more than its queue holds as they are taken, and at the host's close exits by itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_registered_helper_streams_searches_stops_one_closed_mid_stream_and_exits_on_close() {
    let (_dir, root) = tree();
    let (host, driver) = host();

    let mut first = host.search(needle(&root), false);
    let mut seen = Vec::new();
    for _ in 0..4 {
        let SearchMatch { path, line, .. } = within(first.next()).await.expect("a match").expect("not an error");
        seen.push((under(&root, &path), line));
    }
    assert_eq!(seen, [("a.txt".to_owned(), 1), ("b/c.txt".to_owned(), 1), ("many.txt".to_owned(), 1), ("many.txt".to_owned(), 2)]);
    within(first.close()).await;
    assert!(within(first.next()).await.is_none(), "a closed stream has nothing more");
    let running = within(host.wait_status(|status| status.streams == 0)).await;
    assert_eq!(running.state, HostState::Running, "{running:?}");

    let mut dropped = host.search(needle(&root), true);
    assert!(within(dropped.next()).await.expect("a row").is_ok());
    drop(dropped);
    within(host.wait_status(|status| status.streams == 0)).await;

    let walk = WalkRequest {
        root: root.clone(),
        recursive: true,
        include_hidden: true,
        respect_ignore: false,
        require_git: true,
        include_dirs: true,
        prune: Vec::new(),
        descent: Default::default(),
        server: Some(SearchClass::Bulk),
    };
    let mut walked = host.walk(walk);
    let entries: Vec<(String, EntryKind)> =
        drained(&mut walked).await.into_iter().map(|entry| entry.map(|DirEntry { path, kind }| (under(&root, &path), kind)).unwrap()).collect();
    let file = EntryKind::File;
    assert_eq!(entries, [("a.txt".to_owned(), file), ("b".to_owned(), EntryKind::Dir), ("b/c.txt".to_owned(), file), ("many.txt".to_owned(), file)]);

    let mut whole = host.search(needle(&root), false);
    let matches = drained(&mut whole).await;
    assert_eq!(matches.len(), 3 * QUEUE + 2, "every match crossed, past the queue's worth");
    assert!(matches.iter().all(Result::is_ok));
    assert_eq!(host.status().pid, running.pid, "one helper served every stream");

    assert_eq!(within(host.close(BOUND)).await, CloseOutcome::Exited, "the helper exited by itself once its input closed");
    assert_eq!(host.status().state, HostState::Closed);
    let late = drained(&mut host.search(needle(&root), false)).await;
    assert!(matches!(&late[..], [Err(FsError { kind: FsErrorKind::Io { .. }, .. })]), "a closed host runs nothing: {late:?}");
    drop((first, walked, whole, host));
    within(driver).await.expect("the driver ends with its last handle and stream");
}

/// Ends the process `pid` as a crash would.
fn crash(pid: u32) {
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output().expect("taskkill").status;
    #[cfg(unix)]
    let status = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().expect("kill");
    assert!(status.success(), "the helper {pid} was not ended");
}

/// A helper that dies fails the streams it carried with a read's failure, after the items it sent; the next search starts
/// a new helper.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crashed_helper_fails_its_streams_and_the_next_search_starts_another() {
    let (_dir, root) = tree();
    let (host, driver) = host();
    let mut carried = host.search(needle(&root), false);
    assert!(within(carried.next()).await.expect("a match").is_ok());
    let crashed = host.status();
    crash(crashed.pid.expect("a running helper's pid"));

    let rest = drained(&mut carried).await;
    let (last, before) = rest.split_last().expect("the crash's answer");
    assert!(before.iter().all(Result::is_ok), "{before:?}");
    assert!(matches!(last, Err(FsError { kind: FsErrorKind::Io { os_code: None }, path: None, .. })), "{last:?}");
    assert!(rest.len() < 3 * QUEUE + 2, "the crash cut the stream");

    let mut next = host.search(needle(&root), false);
    assert_eq!(drained(&mut next).await.into_iter().filter(Result::is_ok).count(), 3 * QUEUE + 2);
    let started = host.status();
    assert!(started.generation > crashed.generation && started.pid != crashed.pid, "{crashed:?} then {started:?}");

    assert_eq!(within(host.close(BOUND)).await, CloseOutcome::Exited);
    drop((carried, next, host));
    within(driver).await.expect("the driver ends with its last handle and stream");
}

async fn until(events: &mut tokio::sync::mpsc::UnboundedReceiver<HostEvent>, wanted: impl Fn(&HostEvent) -> bool) {
    while !wanted(&within(events.recv()).await.expect("the host's events")) {}
}

/// A helper with no stream open exits by itself at the idle deadline, and nothing starts another until a search does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_helper_exits_and_the_next_search_starts_another() {
    let (_dir, root) = tree();
    let clock = Arc::new(ManualClock::new());
    let (seen, mut events) = tokio::sync::mpsc::unbounded_channel();
    let mut config = config();
    config.clock = clock.clone();
    config.observer = Some(Arc::new(move |event: &HostEvent| drop(seen.send(event.clone()))));
    let (host, driver) = SearchHost::new(config);
    let driver = tokio::spawn(driver);

    let mut first = host.search(needle(&root), true);
    assert_eq!(drained(&mut first).await.len(), 3, "a row per file");
    until(&mut events, |event| matches!(event, HostEvent::IdleArmed { generation: 1 })).await;
    clock.advance(IDLE);
    until(&mut events, |event| matches!(event, HostEvent::Reaped { generation: 1, code: Some(0), .. })).await;
    assert_eq!(host.status().state, HostState::Absent, "the idle helper exited and none took its place");

    let mut second = host.search(needle(&root), true);
    assert_eq!(drained(&mut second).await.len(), 3);
    assert_eq!(host.status().generation, Some(2), "the search started a helper of its own");
    assert_eq!(within(host.close(BOUND)).await, CloseOutcome::Exited);
    drop((first, second, host));
    within(driver).await.expect("the driver ends with its last handle and stream");
}
