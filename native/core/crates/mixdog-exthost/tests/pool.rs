//! Pool behaviour against scripted Node workers (`src/ext-host/test/fake-worker.mjs`).
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
use mixdog_exthost::SyntaxCheck;
use mixdog_exthost::SyntaxKind;
use mixdog_exthost::check_syntax;
use mixdog_exthost::worker_count;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

type Stream = Box<dyn EventSource<ExtFrame>>;

fn host_dir() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    root.join("src").join("ext-host").join("test")
}

fn config(workers: usize, extra: &[&str]) -> ExtHostConfig {
    let mut args = vec![host_dir().join("fake-worker.mjs").into_os_string()];
    args.extend(extra.iter().map(Into::into));
    ExtHostConfig {
        program: "node".into(),
        args,
        electron: false,
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: Some(("node".into(), vec![host_dir().join("fake-browser.mjs").into_os_string()])),
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
    tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .expect("watchdog: nothing happened for 30 s")
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
            tokio::time::sleep(Duration::from_millis(5)).await;
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
        tokio::time::timeout(Duration::from_millis(200), second.next()).await.is_err(),
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
        tokio::time::timeout(Duration::from_millis(300), waiting.next()).await.is_err(),
        "no timer reclaims a slot"
    );
    assert_eq!(busy(&pool.status()), 1);
    pool.stop_worker(worker).unwrap();
    // A replacement worker serves the call that was waiting.
    assert_eq!(finish(&mut waiting).await.1.unwrap(), json!("after"));
    assert!(matches!(pool.stop_worker(ExtWorkerId(999)), Err(ExtError::UnknownWorker)));
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

/// Whether `pid` is a live process, asked of Node (`process.kill(pid, 0)`) so it reads the same on
/// every platform.
async fn alive(pid: u32) -> bool {
    tokio::process::Command::new("node")
        .args(["-e", &format!("try {{ process.kill({pid}, 0) }} catch (e) {{ process.exit(e.code === 'EPERM' ? 0 : 1) }}")])
        .status()
        .await
        .unwrap()
        .success()
}

/// Reads the helper pid a scripted worker recorded, and waits for that process to be gone: the
/// exit is observed before the group is killed, so it may need a moment to go.
async fn helper_is_gone(pid_file: &Path) {
    let helper: u32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    let _ = std::fs::remove_file(pid_file);
    within(async {
        while alive(helper).await {
            tokio::time::sleep(Duration::from_millis(20)).await;
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
    // Nothing is read, so the window cannot reopen: the worker is killed once it overruns.
    until(&pool, "worker busy", |s| busy(s) == 1).await;
    until(&pool, "worker terminated", |s| s.is_empty()).await;
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
async fn a_missing_runtime_answers_unavailable() {
    let mut config = config(1, &[]);
    config.program = "mixdog-no-such-node".into();
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
    assert!(matches!(pool.call(call("a", "echo", json!(1))), Err(ExtError::Unavailable { .. })));
}

/// `pid_file`'s helper pid, once the scripted worker has written it.
async fn helper_pid(pid_file: &Path) -> u32 {
    within(async {
        loop {
            if let Ok(text) = std::fs::read_to_string(pid_file)
                && let Ok(pid) = text.parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
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
    for call in &mut busy_calls {
        let (_, outcome) = finish(call).await;
        assert!(matches!(outcome, Err(ExtError::HostExited { .. })), "{outcome:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_ends_a_browser_that_never_publishes_its_endpoint() {
    let pid_file = pid_file("silent-browser");
    let mut config = config(1, &[]);
    config.render_browser.command = Some((
        "node".into(),
        vec![
            host_dir().join("silent-browser.mjs").into_os_string(),
            pid_file.clone().into_os_string(),
        ],
    ));
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
        config.render_browser.command = Some((
            "node".into(),
            vec![
                host_dir().join("stderr-closed-browser.mjs").into_os_string(),
                pid_file.clone().into_os_string(),
            ],
        ));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn electron_workers_run_in_node_mode_and_others_do_not() {
    let mut electron = config(1, &[]);
    electron.electron = true;
    let pool = ExtHostPool::new(electron).unwrap();
    assert_eq!(run(&pool, call("a", "electronMode", json!(null))).await, json!("1"));

    let pool = ExtHostPool::new(config(1, &[])).unwrap();
    assert_eq!(run(&pool, call("a", "electronMode", json!(null))).await, json!(null));
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
    let mut real = config(1, &[]);
    real.args = vec![host_dir().parent().unwrap().join("worker.mjs").into_os_string()];
    let pool = std::sync::Arc::new(ExtHostPool::new(real).unwrap());
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
    assert_eq!(pdf.len(), 3);
    for case in &pdf {
        let got = within(media.pdf_text(&thread, case["dataBase64"].as_str().unwrap())).await.unwrap();
        assert_eq!(Some(got.as_str()), case["text"].as_str(), "pdf case {}", case["name"]);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn syntax_check_asks_a_real_worker_whether_v8_compiles_the_source() {
    let mut real = config(1, &[]);
    real.args = vec![host_dir().parent().unwrap().join("worker.mjs").into_os_string()];
    let pool = ExtHostPool::new(real).unwrap();
    let thread = || ThreadId::from("t");
    let check = |source: &'static str| check_syntax(&pool, thread(), source, SyntaxKind::CommonJsScript);

    assert_eq!(within(check("const a = 1; a + 1")).await.unwrap(), SyntaxCheck::Ok);
    // Top-level await is not a CommonJS script; V8's own message comes back.
    match within(check("await 1")).await.unwrap() {
        SyntaxCheck::Invalid { message } => assert!(message.contains("await"), "{message}"),
        SyntaxCheck::Ok => panic!("top-level await compiled as a script"),
    }
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
