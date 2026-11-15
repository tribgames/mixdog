//! Pool behaviour against scripted workers and browsers (`src/bin/ext_fake_worker.rs`, `src/bin/ext_fake_browser.rs`).
//! Waits are on facts (a frame, a status change); the only timeouts are test watchdogs.

#![allow(
    clippy::disallowed_methods,
    reason = "a test driver: it reads and removes the pid file its scripted worker wrote"
)]

use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::conformance::check_ext_pool;
use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtExit;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerState;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_exthost::worker_count;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

type Stream = Box<dyn EventSource<ExtFrame>>;

/// The pool over the real Rust worker (`ext_worker_dev`: the document, pdf and image methods of `mixdogd ext-worker`).
fn real_worker_config() -> ExtHostConfig {
    let mut real = config(1, &[]);
    real.program = super::composer_resize::worker_binary();
    real
}

/// The fake browser started in `mode` (`endpoint`, `silent` or `stderr-closed`), the last two recording their pid in `pid_file`.
fn fake_browser(mode: &str, pid_file: Option<&Path>) -> (PathBuf, Vec<std::ffi::OsString>) {
    let mut args = vec![mode.into()];
    args.extend(pid_file.map(|file| file.as_os_str().to_owned()));
    (env!("CARGO_BIN_EXE_ext_fake_browser").into(), args)
}

fn config(workers: usize, extra: &[&str]) -> ExtHostConfig {
    ExtHostConfig {
        program: env!("CARGO_BIN_EXE_ext_fake_worker").into(),
        args: extra.iter().map(Into::into).collect(),
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: Some(fake_browser("endpoint", None)),
            profile_root: std::env::temp_dir().join("mixdog-exthost-tests"),
            no_sandbox: false,
        },
    }
}

fn call(thread: &str, method: &str, params: Value) -> ExtCall {
    ExtCall {
        thread: ThreadId::from(thread),
        method: method.into(),
        params,
        paths: Vec::new(),
    }
}

async fn within<T>(fut: impl Future<Output = T>) -> T {
    fut.await
}

/// Everything a call produces: its chunk bytes and its outcome.
async fn finish(stream: &mut Stream) -> (Vec<u8>, Result<Value, ExtError>) {
    let mut bytes = Vec::new();
    loop {
        match within(stream.next()).await.expect("stream ended without Done") {
            ExtFrame::Chunk(chunk) => bytes.extend(chunk),
            ExtFrame::Done(outcome) => {
                assert!(stream.next().await.is_none(), "nothing follows Done");
                return (bytes, outcome);
            }
        }
    }
}

async fn run(pool: &ExtHostPool, call: ExtCall) -> Value {
    let mut stream = pool.call(call).expect("accepted");
    finish(&mut stream).await.1.expect("call succeeds")
}

async fn until(pool: &ExtHostPool, what: &str, ready: impl Fn(&[mixdog_core_api::domain::ext::ExtWorkerStatus]) -> bool) {
    within(async {
        while !ready(&pool.status()) {
            mixdog_rt::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let _ = what;
}

fn busy(status: &[mixdog_core_api::domain::ext::ExtWorkerStatus]) -> usize {
    status
        .iter()
        .filter(|s| matches!(s.state, ExtWorkerState::Busy { .. }))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn satisfies_the_pool_contract() {
    let mut config = config(2, &[]);
    config.pending_cap = 4;
    let pool = ExtHostPool::new(config).unwrap();
    within(check_ext_pool(&pool, call("t", "echo", json!({"x": 1})), 4)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn echoes_params_and_approved_paths() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    assert_eq!(run(&pool, call("t", "echo", json!({"a": [1, "two", null]}))).await, json!({"a": [1, "two", null]}));
    let dir = AbsPath::new(std::env::temp_dir()).unwrap();
    let mut with_paths = call("t", "approved", json!(null));
    with_paths.paths = vec![dir.clone()];
    assert_eq!(
        run(&pool, with_paths).await,
        json!([dir.as_path().to_string_lossy()])
    );
    let mut unknown = pool.call(call("t", "no-such-method", json!(null))).unwrap();
    let (_, outcome) = finish(&mut unknown).await;
    assert!(matches!(outcome, Err(ExtError::Failed { code, .. }) if code == "unknown_method"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_chunk_window_stalls_only_its_own_call() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let size = 3 * 1024 * 1024;
    let mut big = pool.call(call("a", "chunks", json!({"bytes": size, "fill": 9}))).unwrap();
    // Another call completes while the big call's window is exhausted and unread.
    assert_eq!(run(&pool, call("b", "echo", json!(42))).await, json!(42));
    // Status is published after the dispatcher sees b finish.
    until(&pool, "b released", |s| busy(s) == 1).await;
    let (bytes, outcome) = finish(&mut big).await;
    assert_eq!(bytes.len(), size);
    assert!(bytes.iter().all(|b| *b == 9));
    assert_eq!(outcome.unwrap(), json!({"sent": size}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_thread_cannot_take_more_than_its_share_and_cancel_releases_the_worker() {
    // W = 2 gives a per-thread cap of 1.
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let first = pool.call(call("a", "hold", json!(null))).unwrap();
    until(&pool, "first holds a worker", |s| busy(s) == 1).await;
    let mut second = pool.call(call("a", "echo", json!("second"))).unwrap();
    // Thread b is served meanwhile.
    assert_eq!(run(&pool, call("b", "echo", json!("b"))).await, json!("b"));
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(200), second.next()).await.is_err(),
        "a's second call waits behind its first"
    );
    drop(first); // cancel: the worker answers, its slot frees
    let (_, outcome) = finish(&mut second).await;
    assert_eq!(outcome.unwrap(), json!("second"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_worker_stuck_in_sync_code_keeps_its_slot_until_stopped() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    let spinning = pool.call(call("a", "spin", json!(null))).unwrap();
    until(&pool, "spin starts", |s| busy(s) == 1).await;
    let worker = pool.status()[0].id;
    drop(spinning); // the caller walks away; cancel is sent but the worker cannot see it
    let mut waiting = pool.call(call("b", "echo", json!("after"))).unwrap();
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(300), waiting.next()).await.is_err(),
        "the slot is held until the cancel's grace has passed (a_parser_that_ignores_the_cancel_is_ended_after_the_grace)"
    );
    assert_eq!(busy(&pool.status()), 1);
    pool.stop_worker(worker).unwrap();
    // A replacement worker serves the call that was waiting.
    assert_eq!(finish(&mut waiting).await.1.unwrap(), json!("after"));
    assert!(matches!(pool.stop_worker(ExtWorkerId(999)), Err(ExtError::UnknownWorker)));
}

/// A parser that never looks at the cancel (the PDF read after its 60,000 ms deadline drops the call): the process is ended
/// once `CANCEL_GRACE` has passed, with nobody stopping the worker, and the next call (the only worker is the parser's) is
/// answered by a fresh worker: that answer is the fact this waits on, and the parser's process is gone by then. The grace
/// is the pool's own seam (`ExtHostPool::with_grace`): it ends only when this test releases it, the test's one explicit
/// advance of the grace; before that the parser is found alive and the next call unanswered.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_parser_that_ignores_the_cancel_is_ended_after_the_grace() {
    let asked = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let (release, released) = tokio::sync::watch::channel(false);
    let grace: mixdog_exthost::GraceWait = {
        let asked = asked.clone();
        std::sync::Arc::new(move || {
            asked.add_permits(1);
            let mut released = released.clone();
            Box::pin(async move {
                let _ = released.wait_for(|r| *r).await;
            })
        })
    };
    let pool = ExtHostPool::with_grace(config(1, &[]), grace).unwrap();
    let pid_file = pid_file("ignores-cancel");
    let spinning = pool.call(call("a", "spinWithPid", json!({"pidFile": pid_file}))).unwrap();
    let parser = helper_pid(&pid_file).await;
    let _ = std::fs::remove_file(&pid_file);
    drop(spinning);
    let mut waiting = pool.call(call("b", "echo", json!("after"))).unwrap();
    // The pool has asked for the grace of the dropped call: the cancel is sent and the end of the grace is awaited.
    asked.acquire().await.expect("the pool asks for the grace").forget();
    assert!(alive(parser).await, "the parser is still running before its grace has ended");
    assert!(tokio::time::timeout(Duration::ZERO, waiting.next()).await.is_err(), "the slot is held until the grace has ended");
    release.send(true).unwrap();
    let (_, outcome) = finish(&mut waiting).await;
    assert_eq!(outcome.unwrap(), json!("after"), "a fresh worker serves the next call");
    assert!(!alive(parser).await, "the parser process is gone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_a_worker_ends_its_call_as_stopped() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let mut spinning = pool.call(call("a", "spin", json!(null))).unwrap();
    until(&pool, "spin starts", |s| busy(s) == 1).await;
    let worker = pool.status()[0].id;
    // The other worker keeps serving while the first is stuck.
    assert_eq!(run(&pool, call("b", "echo", json!(7))).await, json!(7));
    pool.stop_worker(worker).unwrap();
    let (_, outcome) = finish(&mut spinning).await;
    assert!(matches!(outcome, Err(ExtError::HostExited { exit: ExtExit::Stopped })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_ends_only_its_own_call() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let other = pool.call(call("b", "hold", json!(null))).unwrap();
    until(&pool, "hold starts", |s| busy(s) == 1).await;
    let mut crashing = pool.call(call("a", "crash", json!(null))).unwrap();
    let (_, outcome) = finish(&mut crashing).await;
    assert!(matches!(outcome, Err(ExtError::HostExited { exit: ExtExit::Code(3) })));
    assert_eq!(run(&pool, call("a", "echo", json!(1))).await, json!(1));
    drop(other);
}

/// Whether `pid` is a live process.
async fn alive(pid: u32) -> bool {
    process_exists(pid)
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    let found = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    // A process of another user exists too.
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

    /// The exit code of a process that has not exited.
    const STILL_ACTIVE: u32 = 259;
    const ACCESS_DENIED: i32 = 5;

    // SAFETY: plain Win32 calls on a handle opened here and closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            // A process this one may not open exists too.
            return std::io::Error::last_os_error().raw_os_error() == Some(ACCESS_DENIED);
        }
        let mut code = 0;
        let queried = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        queried == 0 || code == STILL_ACTIVE
    }
}

/// Reads the helper pid a scripted worker recorded, and waits for that process to be gone: the
/// exit is observed before the group is killed, so it may need a moment to go.
async fn helper_is_gone(pid_file: &Path) {
    let helper: u32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    let _ = std::fs::remove_file(pid_file);
    within(async {
        while alive(helper).await {
            mixdog_rt::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
}

fn pid_file(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("exthost-helper-{label}-{}.pid", std::process::id()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crashed_worker_takes_its_helper_processes_with_it() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    let pid_file = pid_file("crash");
    let mut crashing = pool
        .call(call("a", "crashWithHelper", json!({"pidFile": pid_file})))
        .unwrap();
    let (_, outcome) = finish(&mut crashing).await;
    assert!(matches!(outcome, Err(ExtError::HostExited { exit: ExtExit::Code(3) })), "{outcome:?}");
    helper_is_gone(&pid_file).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_worker_that_exits_normally_takes_its_lingering_helper_with_it() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    let pid_file = pid_file("normal");
    assert_eq!(run(&pool, call("a", "exitWithHelper", json!({"pidFile": pid_file}))).await, json!("answered"));
    // The worker exits on its own after answering; its slot goes and the helper goes with it.
    until(&pool, "worker exited", |s| s.is_empty()).await;
    helper_is_gone(&pid_file).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chunk_beyond_the_window_terminates_the_worker() {
    let pool = ExtHostPool::new(config(1, &["overrun"])).unwrap();
    let mut greedy = pool.call(call("a", "chunks", json!({"bytes": 3 * 1024 * 1024}))).unwrap();
    // Nothing is read, so the window cannot reopen: the worker is killed once it overruns. There
    // is one worker and the greedy call holds it until it is gone, so this other thread's call can
    // only be answered by a fresh worker: its answer is the proof that the first one was terminated.
    // (Watching the status for 'busy' and then 'empty' misses the busy phase when the overrun comes
    // within one poll.)
    assert_eq!(run(&pool, call("b", "echo", json!(42))).await, json!(42));
    let (_, outcome) = finish(&mut greedy).await;
    assert!(matches!(outcome, Err(ExtError::HostExited { .. })), "{outcome:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thread_that_reports_state_stays_on_its_worker() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let holder = pool.call(call("z", "hold", json!(null))).unwrap();
    until(&pool, "worker 0 busy", |s| busy(s) == 1).await;
    // Worker 0 is busy, so thread t lands on a second worker and pins itself there.
    let pid = run(&pool, call("t", "whoami", json!({"pin": true}))).await;
    drop(holder);
    until(&pool, "both idle", |s| s.len() == 2 && busy(s) == 0).await;
    for _ in 0..3 {
        // Worker 0 is idle and has the lower id, yet t keeps returning to its own worker.
        assert_eq!(run(&pool, call("t", "whoami", json!({"pin": true}))).await, pid);
    }
    assert_eq!(run(&pool, call("t", "whoami", json!({"pin": false}))).await, pid);
    assert_ne!(run(&pool, call("t", "whoami", json!({"pin": false}))).await, pid, "released: back to the lowest idle worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workers_share_one_render_browser() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    let mut a = pool.call(call("a", "browser", json!(null))).unwrap();
    let mut b = pool.call(call("b", "browser", json!(null))).unwrap();
    let a = finish(&mut a).await.1.unwrap();
    let b = finish(&mut b).await.1.unwrap();
    let ws = a.as_str().unwrap();
    assert!(ws.starts_with("ws://127.0.0.1:9222/devtools/browser/fake-"), "{ws}");
    assert_eq!(a, b, "one browser, one endpoint");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_worker_program_answers_unavailable() {
    let mut config = config(1, &[]);
    config.program = "mixdog-no-such-worker".into();
    let pool = ExtHostPool::new(config).unwrap();
    let mut stream = pool.call(call("a", "echo", json!(1))).unwrap();
    let (_, outcome) = finish(&mut stream).await;
    assert!(matches!(outcome, Err(ExtError::Unavailable { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_ends_every_worker() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    assert_eq!(run(&pool, call("a", "echo", json!(1))).await, json!(1));
    assert!(!pool.status().is_empty());
    within(pool.close()).await;
    assert!(pool.status().is_empty());
    // The event loop may still hold its receiver for an instant after `close` returns, so a call
    // is refused at once or its stream ends `Unavailable`; either way it is never served.
    match pool.call(call("a", "echo", json!(1))) {
        Err(error) => assert!(matches!(error, ExtError::Unavailable { .. })),
        Ok(mut stream) => assert!(matches!(finish(&mut stream).await.1, Err(ExtError::Unavailable { .. }))),
    }
}

/// `pid_file`'s helper pid, once the scripted worker has written it. The wait is on the wall clock and ends the test by name: a
/// script that never starts (a missing file, no runtime) would otherwise leave it waiting for ever.
async fn helper_pid(pid_file: &Path) -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(text) = std::fs::read_to_string(pid_file)
            && let Ok(pid) = text.parse()
        {
            return pid;
        }
        assert!(std::time::Instant::now() < deadline, "{} was not written within 60 s: the scripted process did not start", pid_file.display());
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_with_busy_workers_leaves_no_process_behind() {
    let pool = ExtHostPool::new(config(2, &[])).unwrap();
    // The shared browser runs (its pid is in the fake's endpoint), then both workers go busy, each
    // with a helper that would outlive it.
    let ws = run(&pool, call("a", "browser", json!(null))).await;
    let browser: u32 = ws.as_str().unwrap().rsplit('-').next().unwrap().parse().unwrap();
    let files = [pid_file("close-a"), pid_file("close-b")];
    let mut busy_calls = Vec::new();
    for (thread, file) in ["a", "b"].into_iter().zip(&files) {
        busy_calls.push(pool.call(call(thread, "holdWithHelper", json!({"pidFile": file}))).unwrap());
    }
    let mut helpers = Vec::new();
    for file in &files {
        helpers.push(helper_pid(file).await);
        let _ = std::fs::remove_file(file);
    }
    until(&pool, "both workers busy", |s| busy(s) == 2).await;
    assert!(alive(browser).await);
    for helper in &helpers {
        assert!(alive(*helper).await);
    }

    within(pool.close()).await;

    // No waiting: `close` returns only after every owner has signalled and reaped.
    assert!(!alive(browser).await, "the render browser is gone");
    for helper in &helpers {
        assert!(!alive(*helper).await, "helper {helper} is gone");
    }
    assert!(pool.status().is_empty());
    // Each worker left on the close's `BYE` (its own exit 0, not the kill), its helper ended with its group all the same.
    for call in &mut busy_calls {
        let (_, outcome) = finish(call).await;
        assert!(matches!(outcome, Err(ExtError::HostExited { exit: ExtExit::Code(0) })), "{outcome:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_ends_a_browser_that_never_publishes_its_endpoint() {
    let pid_file = pid_file("silent-browser");
    let mut config = config(1, &[]);
    config.render_browser.command = Some(fake_browser("silent", Some(&pid_file)));
    let pool = ExtHostPool::new(config).unwrap();
    // The worker asks for the browser and waits; the browser lives but never answers.
    let mut waiting = pool.call(call("a", "browser", json!(null))).unwrap();
    let browser = helper_pid(&pid_file).await;
    let _ = std::fs::remove_file(&pid_file);
    assert!(alive(browser).await);

    within(pool.close()).await;

    assert!(!alive(browser).await, "the stalled browser is gone when close returns");
    let (_, outcome) = finish(&mut waiting).await;
    assert!(matches!(outcome, Err(ExtError::HostExited { .. })), "{outcome:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_racing_a_failed_endpoint_channel_still_waits_for_the_browser() {
    // The browser closes its stderr (the endpoint channel fails) and stays alive, while `close`
    // arrives: whichever wins, `close` returns only once the process is gone.
    for round in 0..5 {
        let pid_file = pid_file(&format!("stderr-closed-{round}"));
        let mut config = config(1, &[]);
        config.render_browser.command = Some(fake_browser("stderr-closed", Some(&pid_file)));
        let pool = ExtHostPool::new(config).unwrap();
        let _waiting = pool.call(call("a", "browser", json!(null))).unwrap();
        let browser = helper_pid(&pid_file).await;
        let _ = std::fs::remove_file(&pid_file);

        within(pool.close()).await;

        assert!(!alive(browser).await, "round {round}: the browser is gone when close returns");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_render_browser_serves_the_endpoint_trait_object_the_web_renderer_holds() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    let endpoint: std::sync::Arc<dyn BrowserEndpoint> = std::sync::Arc::new(pool.render_browser());
    let (first, _hold) = endpoint.lease().await.unwrap();
    assert!(first.starts_with("ws://127.0.0.1:9222/devtools/browser/fake-"), "{first}");
    assert_eq!(endpoint.lease().await.unwrap().0, first, "one browser while it is in use");
    assert_eq!(run(&pool, call("a", "browser", json!(null))).await, json!(first), "the workers share it");
    assert_eq!(pool.browser_launches(), 1);
    within(pool.close()).await;
    assert!(endpoint.lease().await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_public_render_browser_is_the_one_the_workers_use() {
    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    let from_worker = run(&pool, call("a", "browser", json!(null))).await;
    let handle = pool.render_browser();
    assert_eq!(handle.endpoint().await.unwrap(), from_worker.as_str().unwrap());
    assert_eq!(pool.browser_launches(), 1);
    within(pool.close()).await;
    assert!(handle.endpoint().await.is_err(), "after close no browser is launched");
}

/// Node's own extraction, recorded by `benchmarks/rust-core/recorders/record-media-text.mjs`: the text
/// of each attached-document format, `null` for a file with no text form, and the fixed text for a
/// PDF the parser rejects. The real worker must answer every case exactly as Node did.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn document_text_equals_nodes_recorded_extraction_for_every_format_error_and_limit() {
    use mixdog_core_api::domain::ext::DocumentText;
    use mixdog_core_api::domain::ext::PdfCounts;
    use mixdog_core_api::domain::ext::PdfIntake;
    use mixdog_exthost::ExtDocumentText;
    use sha2::Digest;

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().join("fixtures/tools/media-text");
    let load = |name: &str| -> Vec<Value> {
        serde_json::from_slice(&std::fs::read(fixtures.join(name)).unwrap()).unwrap()
    };
    let pool = std::sync::Arc::new(ExtHostPool::new(real_worker_config()).unwrap());
    let media = ExtDocumentText::new(pool.clone());
    let thread = ThreadId::from("t");

    let office = load("office.json");
    assert_eq!(office.len(), 10);
    for case in &office {
        let got = within(media.office_text(&thread, case["filename"].as_str().unwrap(), case["dataBase64"].as_str().unwrap()))
            .await
            .unwrap();
        if let Some(bytes) = case["textBytes"].as_u64() {
            // Too large to keep whole: the golden holds its size, hash and end.
            let text = got.expect("the capped text exists");
            assert_eq!(text.len() as u64, bytes, "office case {}", case["name"]);
            assert_eq!(format!("{:x}", sha2::Sha256::digest(text.as_bytes())), case["textSha256"].as_str().unwrap());
            assert!(text.ends_with(case["textTail"].as_str().unwrap()));
        } else {
            assert_eq!(got.as_deref(), case["text"].as_str(), "office case {}", case["name"]);
        }
    }
    let pdf = load("pdf.json");
    assert_eq!(pdf.len(), 5);
    for case in &pdf {
        let got = within(media.pdf_text(&thread, case["dataBase64"].as_str().unwrap())).await.unwrap();
        if let Some(bytes) = case["textBytes"].as_u64() {
            // Too large to keep whole: the golden holds its size, hash and end.
            assert_eq!(got.len() as u64, bytes, "pdf case {}", case["name"]);
            assert_eq!(format!("{:x}", sha2::Sha256::digest(got.as_bytes())), case["textSha256"].as_str().unwrap());
            assert!(got.ends_with(case["textTail"].as_str().unwrap()));
        } else {
            assert_eq!(Some(got.as_str()), case["text"].as_str(), "pdf case {}", case["name"]);
        }
    }
    // The intake's counts: a text PDF, a scan, a mix (one text page, one stamped number only, one
    // image) and bytes the parser rejects.
    let counts = load("pdf-counts.json");
    assert_eq!(counts.len(), 5);
    for case in &counts {
        let got = within(media.pdf_counts(&thread, case["dataBase64"].as_str().unwrap())).await.unwrap();
        let want = match case["rejected"].as_str() {
            Some(message) => PdfIntake::Rejected(message.to_owned()),
            None => {
                let c = &case["counts"];
                PdfIntake::Counts(PdfCounts {
                    page_count: c["pageCount"].as_u64().unwrap(),
                    text_pages: c["textPages"].as_u64().unwrap(),
                    text_chars: c["textChars"].as_u64().unwrap(),
                })
            }
        };
        assert_eq!(got, want, "pdf-counts case {}", case["name"]);
    }
    let by_name = |n: &str| counts.iter().find(|c| c["name"] == n).unwrap().clone();
    assert_eq!(by_name("scanned-pdf")["counts"]["textPages"], 0);
    assert_eq!(by_name("text-scan-and-stamped-page")["counts"]["textPages"], 1);
    assert_eq!(by_name("text-scan-and-stamped-page")["counts"]["pageCount"], 3);
    // The message is pdf.js's own, not ours.
    assert!(!by_name("unreadable-not-a-pdf")["rejected"].as_str().unwrap().is_empty());
    assert!(!by_name("unreadable-truncated")["rejected"].as_str().unwrap().is_empty());
    within(pool.close()).await;
}

/// The flat-colour PNG (stored zlib blocks) `record_image.mjs` builds, so the read goldens can be
/// replayed from their recipe.
fn flat_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let body = [&kind[..], data].concat();
        [(data.len() as u32).to_be_bytes().to_vec(), body.clone(), crc32(&body).to_be_bytes().to_vec()].concat()
    }
    let mut row = vec![0u8];
    for _ in 0..width {
        row.extend_from_slice(&rgb);
    }
    let raw: Vec<u8> = (0..height).flat_map(|_| row.clone()).collect();
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, part) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        zlib.extend_from_slice(&(part.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(part);
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = [width.to_be_bytes(), height.to_be_bytes()].concat();
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    [
        vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        chunk(b"IHDR", &ihdr),
        chunk(b"IDAT", &zlib),
        chunk(b"IEND", &[]),
    ]
    .concat()
}

/// The image calls over the real Rust worker: `read_resize` replays Node's recorded `read` results
/// (`mixdog-tools/src/fs/golden/image_cases.json`): mime and both sizes exact, the answer decoding at the displayed size; and
/// every op the compaction codec needs round-trips a png, a jpeg and a webp to Node's sizes. The encoder is the Rust one, so the
/// bytes of a re-encode are not sharp's (the picture twins of `mixdog-imaging` and `composer_resize` compare the pixels).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_codec_answers_nodes_sharp_shapes_for_png_jpeg_and_webp() {
    use base64::Engine as _;
    use mixdog_agent::compact::image::CodecError;
    use mixdog_agent::compact::image::ImageCodec;
    use mixdog_agent::compact::image::ImageSize;
    use mixdog_exthost::ExtImageCodec;
    use mixdog_core_api::domain::ext::ImageResizeError;
    use mixdog_core_api::domain::ext::ImageResizer;
    use mixdog_exthost::ReadResizeError;
    use mixdog_exthost::RenditionVariant;
    use sha2::Digest;

    let hex = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
    let pool = std::sync::Arc::new(ExtHostPool::new(real_worker_config()).unwrap());
    let codec = ExtImageCodec::new(pool.clone());
    let resizer: &dyn ImageResizer = &codec;
    let thread = ThreadId::from("t");

    // The read tool's goldens, through the `ImageResizer` trait the read tool holds.
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().join("crates/mixdog-tools/src/fs/golden/image_cases.json");
    let cases: Vec<Value> = serde_json::from_slice(&std::fs::read(golden).unwrap()).unwrap();
    assert_eq!(cases.len(), 7);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let Some(png) = case.get("png") else {
            // The empty file never reaches the resizer in Node (the tool answers first); the corrupt
            // one is rejected by the decoder.
            let bytes = case["bytes"].as_str().unwrap().as_bytes();
            let got = within(resizer.resize(&thread, bytes, "png")).await;
            let want = if bytes.is_empty() { Ok(None) } else { Err(ImageResizeError::Invalid) };
            assert_eq!(got, want, "{name}");
            // The inherent call agrees.
            assert_eq!(within(codec.read_resize(&thread, bytes, "png")).await.err(), (!bytes.is_empty()).then_some(ReadResizeError::Invalid));
            continue;
        };
        let rgb = png["rgb"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as u8).collect::<Vec<_>>();
        let bytes = flat_png(png["width"].as_u64().unwrap() as u32, png["height"].as_u64().unwrap() as u32, [rgb[0], rgb[1], rgb[2]]);
        assert_eq!(hex(&bytes), case["sourceSha256"].as_str().unwrap(), "{name}: the rebuilt source differs from the recipe");
        let got = within(resizer.resize(&thread, &bytes, "png")).await.unwrap().expect("sharp is present");
        let image = case["content"].as_array().unwrap().iter().find(|b| b["type"] == "image").unwrap();
        assert_eq!(got.mime, image["mimeType"].as_str().unwrap(), "{name}");
        let out = base64::engine::general_purpose::STANDARD.decode(&got.data_base64).unwrap();
        assert_eq!(within(codec.probe(&out)).await, Ok(ImageSize { width: got.display_w, height: got.display_h }), "{name}: the answer decodes at the displayed size");
        assert_eq!((got.display_w, got.display_h), (image["width"].as_u64().unwrap() as u32, image["height"].as_u64().unwrap() as u32), "{name}");
        assert_eq!((got.original_w, got.original_h), (png["width"].as_u64().unwrap() as u32, png["height"].as_u64().unwrap() as u32), "{name}");
    }

    // A jpeg and a webp (64x48 gradients, `tests/fixtures/image`): the sub-patch image is lifted to
    // the 200 px floor in its own format; the size is Node's `resizeImageBuffer` on the same bytes.
    let jpeg: &[u8] = include_bytes!("../fixtures/image/gradient.jpg");
    let webp: &[u8] = include_bytes!("../fixtures/image/gradient.webp");
    for (bytes, ext, mime) in [(jpeg, "jpeg", "image/jpeg"), (webp, "webp", "image/webp")] {
        let got = within(codec.read_resize(&thread, bytes, ext)).await.unwrap().unwrap();
        assert_eq!(got.mime.as_str(), mime, "{ext}");
        let out = base64::engine::general_purpose::STANDARD.decode(&got.data_base64).unwrap();
        assert_eq!(within(codec.probe(&out)).await, Ok(ImageSize { width: 267, height: 200 }), "{ext}");
        assert_eq!((got.original_w, got.original_h, got.display_w, got.display_h), (64, 48, 267, 200), "{ext}");
    }

    // The compaction ops, on all three formats.
    let flat = flat_png(300, 200, [20, 200, 20]);
    let wanted = [(&flat[..], 300, 200), (jpeg, 64, 48), (webp, 64, 48)];
    for (bytes, width, height) in wanted {
        assert_eq!(within(codec.probe(bytes)).await, Ok(ImageSize { width, height }));
        assert_eq!(within(codec.validate(bytes, "png")).await, Ok(()));
    }
    for bytes in [jpeg, webp] {
        let out = within(codec.jpeg(bytes, 32, 24, false, 85)).await.unwrap();
        assert_eq!(out.size, ImageSize { width: 32, height: 24 });
        assert_eq!(&out.bytes[..2], &[0xff, 0xd8]);
        assert_eq!(within(codec.probe(&out.bytes)).await, Ok(out.size));
    }
    // The enlargement flag lifts a small image past its own size, and not otherwise.
    let lifted = within(codec.jpeg(jpeg, 128, 96, true, 70)).await.unwrap();
    assert_eq!(lifted.size, ImageSize { width: 128, height: 96 });
    let held = within(codec.jpeg(jpeg, 128, 96, false, 70)).await.unwrap();
    assert_eq!(held.size, ImageSize { width: 64, height: 48 });
    assert_eq!(&lifted.bytes[..2], &[0xff, 0xd8]);

    // Bytes no decoder takes are `Invalid` for every op.
    let junk = b"not an image at all";
    assert_eq!(within(codec.probe(junk)).await, Err(CodecError::Invalid));
    assert_eq!(within(codec.validate(junk, "png")).await.unwrap_err(), CodecError::Invalid);
    assert!(within(codec.jpeg(junk, 32, 24, false, 85)).await.is_err());
    assert_eq!(within(codec.read_resize(&thread, junk, "png")).await, Err(ReadResizeError::Invalid));

    // The media store's still rendition (Node's `encodeStill`): a webp at the variant's size (the 64x48 gradient jpeg is never
    // enlarged). The worker twin (`still_twin`) holds the recorded sizes; here the codec's reading of the answer.
    for variant in [RenditionVariant::Thumb, RenditionVariant::Display] {
        let still = within(codec.still_rendition(&thread, jpeg, variant)).await.unwrap().unwrap();
        assert_eq!(still.extension.as_str(), ".webp");
        assert_eq!(&still.bytes[..4], b"RIFF");
        assert!(within(codec.probe(&still.bytes)).await.unwrap().width <= 64, "never enlarged");
    }
    // A source that does not decode is Node's `null`.
    assert_eq!(within(codec.still_rendition(&thread, junk, RenditionVariant::Thumb)).await, Ok(None));

    // A host that is gone is an error, never "sharp is absent".
    within(pool.close()).await;
    assert!(matches!(within(codec.read_resize(&thread, jpeg, "jpeg")).await, Err(ReadResizeError::Host(_))));
    assert!(within(codec.still_rendition(&thread, jpeg, RenditionVariant::Thumb)).await.is_err());
    assert!(matches!(within(codec.probe(jpeg)).await, Err(CodecError::Environment(Some(_)))));
}

#[test]
fn worker_count_follows_the_cores_and_the_setting() {
    assert_eq!(worker_count(None, 1), 1);
    assert_eq!(worker_count(None, 8), 2);
    assert_eq!(worker_count(None, 64), 4);
    assert_eq!(worker_count(Some(0), 8), 1);
    assert_eq!(worker_count(Some(99), 8), 8);
    assert_eq!(worker_count(Some(3), 8), 3);
}
