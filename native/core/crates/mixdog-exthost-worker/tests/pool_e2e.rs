//! The pool (`mixdog_exthost::ExtHostPool`) driving real worker processes: `ext_worker_dev`, which serves the scripted methods of
//! `src/bin/ext_worker_dev.rs` over the Rust frame loop. Waits are on facts (a frame, a status change); the only timeouts are
//! test watchdogs.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtExit;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerState;
use mixdog_core_api::domain::ext::ExtWorkerStatus;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

type Stream = Box<dyn EventSource<ExtFrame>>;

fn config(workers: usize) -> ExtHostConfig {
    ExtHostConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_ext_worker_dev")),
        args: Vec::new(),
        electron: false,
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-tests"),
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

/// Everything a call produces: its chunk bytes and its outcome.
async fn finish(stream: &mut Stream) -> (Vec<u8>, Result<Value, ExtError>) {
    let mut bytes = Vec::new();
    loop {
        match stream.next().await.expect("stream ended without Done") {
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

async fn until(pool: &ExtHostPool, ready: impl Fn(&[ExtWorkerStatus]) -> bool) {
    while !ready(&pool.status()) {
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
}

fn busy(status: &[ExtWorkerStatus]) -> usize {
    status
        .iter()
        .filter(|s| matches!(s.state, ExtWorkerState::Busy { .. }))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn echoes_params_thread_and_approved_paths() {
    let pool = ExtHostPool::new(config(1)).unwrap();
    let dir = AbsPath::new(std::env::temp_dir()).unwrap();
    let mut with_paths = call("th", "echo", json!({"a": [1, "two", null]}));
    with_paths.paths = vec![dir.clone()];
    assert_eq!(
        run(&pool, with_paths).await,
        json!({
            "params": {"a": [1, "two", null]},
            "paths": [dir.as_path().to_string_lossy()],
            "thread": "th",
        })
    );
    let mut unknown = pool.call(call("t", "no-such-method", json!(null))).unwrap();
    let (_, outcome) = finish(&mut unknown).await;
    assert!(matches!(outcome, Err(ExtError::Failed { code, .. }) if code == "unknown_method"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_chunk_window_stalls_only_its_own_call() {
    let pool = ExtHostPool::new(config(2)).unwrap();
    let size = 3 * 1024 * 1024;
    let mut big = pool
        .call(call("a", "chunks", json!({"bytes": size, "fill": 9})))
        .unwrap();
    // Another call completes while the big call's window is exhausted and unread.
    assert_eq!(run(&pool, call("b", "echo", json!(42))).await["params"], 42);
    // Status is published after the dispatcher sees b finish.
    until(&pool, |s| busy(s) == 1).await;
    let (bytes, outcome) = finish(&mut big).await;
    assert_eq!(bytes.len(), size);
    assert!(bytes.iter().all(|b| *b == 9));
    assert_eq!(outcome.unwrap(), json!({"sent": size}));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_frees_the_worker() {
    // One worker: the next call is answered only once the cancelled one has left it.
    let pool = ExtHostPool::new(config(1)).unwrap();
    let sleeping = pool
        .call(call("a", "sleep", json!({"ms": 600_000})))
        .unwrap();
    until(&pool, |s| busy(s) == 1).await;
    drop(sleeping);
    assert_eq!(
        run(&pool, call("b", "echo", json!("after"))).await["params"],
        "after"
    );
    until(&pool, |s| busy(s) == 0).await;
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_a_worker_stuck_in_cpu_bound_code_ends_its_call_and_a_new_worker_serves_on() {
    let pool = ExtHostPool::new(config(1)).unwrap();
    let mut spinning = pool.call(call("a", "spin", json!(null))).unwrap();
    until(&pool, |s| busy(s) == 1).await;
    let worker = pool.status()[0].id;
    // The cancel cannot reach code that never looks at it: only the operator's stop ends the worker.
    pool.stop_worker(worker).unwrap();
    let (_, outcome) = finish(&mut spinning).await;
    assert!(
        matches!(
            outcome,
            Err(ExtError::HostExited {
                exit: ExtExit::Stopped
            })
        ),
        "{outcome:?}"
    );
    assert_eq!(run(&pool, call("b", "echo", json!(7))).await["params"], 7);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panic_is_answered_without_the_worker_exiting() {
    let pool = ExtHostPool::new(config(1)).unwrap();
    let pid = run(&pool, call("t", "pin", json!({"pin": false}))).await;
    let mut panicking = pool.call(call("t", "panic", json!(null))).unwrap();
    let (_, outcome) = finish(&mut panicking).await;
    assert!(
        matches!(&outcome, Err(ExtError::Failed { code, message }) if code == "failed" && message.contains("boom from ext_worker_dev")),
        "{outcome:?}"
    );
    // The same process answers the next call.
    assert_eq!(
        run(&pool, call("t", "pin", json!({"pin": false}))).await,
        pid
    );
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thread_that_reports_state_stays_on_its_worker() {
    let pool = ExtHostPool::new(config(2)).unwrap();
    let holder = pool
        .call(call("z", "sleep", json!({"ms": 600_000})))
        .unwrap();
    until(&pool, |s| busy(s) == 1).await;
    // Worker 0 is busy, so thread t lands on a second worker and pins itself there.
    let pid = run(&pool, call("t", "pin", json!({"pin": true}))).await;
    drop(holder);
    until(&pool, |s| s.len() == 2 && busy(s) == 0).await;
    for _ in 0..3 {
        // Worker 0 is idle and has the lower id, yet t keeps returning to its own worker.
        assert_eq!(
            run(&pool, call("t", "pin", json!({"pin": true}))).await,
            pid
        );
    }
    assert_eq!(
        run(&pool, call("t", "pin", json!({"pin": false}))).await,
        pid
    );
    assert_ne!(
        run(&pool, call("t", "pin", json!({"pin": false}))).await,
        pid,
        "released: back to the lowest idle worker"
    );
    pool.close().await;
}
