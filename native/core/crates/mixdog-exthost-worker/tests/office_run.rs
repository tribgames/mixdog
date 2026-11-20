//! `office.run` through the pool over the worker process (the port of `src/ext-host/office-run.e2e.test.mjs`): the approved-path
//! refusal (a leading space, a link out of the workspace), a document created and its write receipt, and the pin across the calls
//! of one thread. Nothing here needs Microsoft Office, a browser or the network: the documents are made by the portable route.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerState;
use mixdog_core_api::domain::ext::ExtWorkerStatus;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_fsio::Unlaned;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

fn pool(workers: usize) -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_ext_worker_dev")),
        args: Vec::new(),
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-office-run-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

fn approved(root: &Path) -> Vec<AbsPath> {
    vec![AbsPath::new(root.to_path_buf()).expect("an absolute folder")]
}

/// One call to the end: its chunk bytes and its outcome.
async fn finish(pool: &ExtHostPool, call: ExtCall) -> (Vec<u8>, Result<Value, ExtError>) {
    let mut stream = pool.call(call).expect("the call is accepted");
    let mut bytes = Vec::new();
    loop {
        match stream.next().await.expect("the stream ends with Done") {
            ExtFrame::Chunk(chunk) => bytes.extend(chunk),
            ExtFrame::Done(outcome) => return (bytes, outcome),
        }
    }
}

fn office(thread: &str, root: &Path, data: &Path, args: Value) -> ExtCall {
    ExtCall {
        thread: ThreadId::from(thread),
        method: "office.run".to_owned(),
        params: json!({"args": args, "cwd": root.to_string_lossy(), "dataDir": data.to_string_lossy()}),
        paths: approved(root),
    }
}

fn plain(thread: &str, method: &str, params: Value) -> ExtCall {
    ExtCall { thread: ThreadId::from(thread), method: method.to_owned(), params, paths: Vec::new() }
}

fn create(file: &str) -> Value {
    json!({"action": "create", "format": "docx", "mode": "portable", "path": file})
}

/// The text of the tool result's first block, parsed.
fn answer(value: &Value) -> Value {
    let text = value["result"]["content"][0]["text"].as_str().expect("a text block");
    serde_json::from_str(text).unwrap_or_else(|error| panic!("the answer is not JSON ({error}): {text}"))
}

fn refusal(outcome: Result<Value, ExtError>) -> String {
    match outcome {
        Err(ExtError::Failed { code, message }) => {
            assert_eq!(code, "path_not_approved", "{message}");
            message
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// A directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a test fixture: the link is made by the system's own tool")]
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().expect("cmd runs");
        assert!(made.status.success(), "mklink failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("a symlink");
}

fn exists(path: &Path) -> bool {
    mixdog_fsio::exists(&Unlaned, path).expect("the folder can be read")
}

fn busy(status: &[ExtWorkerStatus]) -> usize {
    status.iter().filter(|s| matches!(s.state, ExtWorkerState::Busy { .. })).count()
}

async fn until(pool: &ExtHostPool, ready: impl Fn(&[ExtWorkerStatus]) -> bool) {
    while !ready(&pool.status()) {
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_prefixed_outside_path_and_a_link_out_of_the_workspace_are_refused() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, outside, data) = (scratch.path().join("root"), scratch.path().join("outside"), scratch.path().join("data"));
    for folder in [&root, &outside, &data] {
        mixdog_fsio::create_dir_all(&Unlaned, folder).expect("folder");
    }
    let pool = pool(1);

    let spaced = outside.join("spaced.docx");
    let (_, outcome) = finish(&pool, office("t", &root, &data, create(&format!(" {}", spaced.display())))).await;
    refusal(outcome);
    assert!(!exists(&spaced), "a leading space does not turn an outside path into a workspace one");

    link_dir(&root.join("link"), &outside);
    let escaped = outside.join("escaped.docx");
    let (_, outcome) = finish(&pool, office("t", &root, &data, create(&Path::new("link").join("escaped.docx").to_string_lossy()))).await;
    refusal(outcome);
    assert!(!exists(&escaped), "a link out of the workspace is refused");

    let (_, outcome) = finish(&pool, office("t", &root, &data, json!({"action": "open", "path": outside.join("other.docx").to_string_lossy()}))).await;
    refusal(outcome);

    let (_, inside) = finish(&pool, office("t", &root, &data, create("inside.docx"))).await;
    let inside = inside.expect("a plain workspace path still works");
    assert_eq!(answer(&inside)["created"], true);
    assert!(exists(&root.join("inside.docx")));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_created_document_comes_back_as_a_write_receipt_with_its_bytes() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(1);
    let file = root.join("a.docx");
    let (chunks, outcome) = finish(&pool, office("t", &root, &data, create(&file.to_string_lossy()))).await;
    let value = outcome.expect("the call succeeds");

    let created = answer(&value);
    assert_eq!(created["fileKind"], "docx");
    assert_eq!(created["created"], true);
    assert!(created["session"].as_str().expect("a session").starts_with("office_"));

    let writes = value["writes"].as_array().expect("writes");
    assert_eq!(writes.len(), 1);
    assert_eq!(PathBuf::from(writes[0]["path"].as_str().expect("a path")), file);
    assert_eq!(writes[0]["before"], Value::Null);
    let on_disk = mixdog_fsio::read(&Unlaned, &file).expect("the document");
    assert_eq!(writes[0]["after"], json!({"bytes": on_disk.len()}));
    assert_eq!(chunks, on_disk, "the after bytes follow as chunks");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thread_that_owns_a_session_stays_on_its_worker_until_it_closes_it() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(2);

    // Worker 0 is busy, so the thread's session is made on the second worker and pins the thread there.
    let holder = pool.call(plain("holder", "sleep", json!({"ms": 600_000}))).expect("accepted");
    until(&pool, |s| busy(s) == 1).await;
    let (_, made) = finish(&pool, office("owner", &root, &data, create("pinned.docx"))).await;
    let session = answer(&made.expect("the call succeeds"))["session"].clone();
    drop(holder);
    until(&pool, |s| s.len() == 2 && busy(s) == 0).await;

    let pid_of = |outcome: Result<Value, ExtError>| outcome.expect("answers");
    // An answer that is not pinned releases its thread, so the owner is not asked where it is while it holds the session: that
    // its calls reach the worker with the session is what shows it. Another thread goes to the lowest idle worker, the first.
    let other_pid = pid_of(finish(&pool, plain("other", "pin", json!({"pin": false}))).await.1);

    // The session is found on the next call of the same thread, which is on the same worker (the first worker never had it).
    let seen = finish(&pool, office("owner", &root, &data, json!({"action": "snapshot", "session": session}))).await.1.expect("the call succeeds");
    assert!(seen["result"]["isError"].is_null(), "the session is known to the worker: {seen}");
    let again = finish(&pool, office("owner", &root, &data, json!({"action": "snapshot", "session": session}))).await.1.expect("the call succeeds");
    assert!(again["result"]["isError"].is_null(), "the thread is still on the worker of its session: {again}");

    // Closing the session releases the thread: the next call goes to the lowest idle worker.
    let closed = finish(&pool, office("owner", &root, &data, json!({"action": "close", "session": session}))).await.1.expect("the close succeeds");
    assert!(closed["result"]["isError"].is_null(), "{closed}");
    assert_eq!(pid_of(finish(&pool, plain("owner", "pin", json!({"pin": false}))).await.1), other_pid);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_worker_leaves_cleanly_after_office_calls() {
    // The worker's end runs the engine's shutdown (every Office session host drained) before the process exits; with no host
    // running it is a no-op, and the pool's close must not wait on a worker that cannot leave.
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(1);
    let (_, made) = finish(&pool, office("t", &root, &data, create("left.docx"))).await;
    made.expect("the call succeeds");
    pool.close().await;
    assert!(exists(&root.join("left.docx")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_filled_formula_range_of_five_thousand_rows_batch_returns() {
    for rows in [5000usize] {
        let scratch = tempfile::tempdir().expect("scratch");
        let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
        mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
        let pool = pool(1);
        let made = json!({"action": "create", "format": "xlsx", "mode": "portable", "path": "x.xlsx"});
        let (_, made) = finish(&pool, office("t", &root, &data, made)).await;
        let session = answer(&made.expect("the call succeeds"))["session"].clone();
        let operations = json!([
            {"op": "add_sheet", "name": "Second"},
            {"op": "set_formula", "sheet": "Second", "range": format!("A1:A{rows}"), "formula": "=ROW()*2"},
            {"op": "set_formula", "sheet": "Second", "range": format!("B1:B{rows}"), "formula": "=A1+1"}
        ]);
        let call = office("t", &root, &data, json!({"action": "batch", "session": session, "operations": operations}));
        let started = std::time::Instant::now();
        let done = tokio::time::timeout(Duration::from_secs(120), finish(&pool, call)).await;
        eprintln!("rows={rows} elapsed={:?} returned={}", started.elapsed(), done.is_ok());
        let (_, batch) = done.expect("the batch returns");
        let value = batch.expect("the call succeeds");
        assert!(value["result"]["isError"].is_null(), "{value}");
        pool.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn calls_made_together_on_one_session_all_find_it() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    // Four workers, so a second call of the thread could be given an idle worker that does not hold the session.
    let pool = pool(4);
    let made = json!({"action": "create", "format": "xlsx", "mode": "portable", "path": "x.xlsx"});
    let (_, made) = finish(&pool, office("t", &root, &data, made)).await;
    let session = answer(&made.expect("the call succeeds"))["session"].clone();
    for round in 0..4 {
        let calls = [
            json!({"action": "issues", "session": session}),
            json!({"action": "render", "session": session, "output": format!("x{round}.png")}),
            json!({"action": "snapshot", "session": session}),
            json!({"action": "issues", "session": session}),
        ];
        let answers = futures_join(&pool, &root, &data, calls).await;
        for (at, text) in answers.iter().enumerate() {
            assert!(!text.contains("Unknown or closed Office Use session"), "round {round} call {at}: {text}");
        }
    }
    pool.close().await;
}

async fn futures_join(pool: &ExtHostPool, root: &Path, data: &Path, calls: [Value; 4]) -> Vec<String> {
    let streams: Vec<_> = calls.into_iter().map(|args| finish(pool, office("t", root, data, args))).collect();
    let mut texts = Vec::new();
    for (_, outcome) in futures_util_join_all(streams).await {
        let value = outcome.expect("the call is answered");
        texts.push(value["result"]["content"][0]["text"].as_str().unwrap_or_default().to_owned());
    }
    texts
}

async fn futures_util_join_all<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    let handles: Vec<_> = futures.into_iter().map(|f| Box::pin(f)).collect();
    let mut out = Vec::new();
    // Polled together so every call is in the pool before any is answered.
    let mut pending: Vec<_> = handles.into_iter().map(Some).collect();
    let mut results: Vec<Option<F::Output>> = (0..pending.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (slot, result) in pending.iter_mut().zip(results.iter_mut()) {
            if let Some(future) = slot {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(value) => {
                        *result = Some(value);
                        *slot = None;
                    }
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    })
    .await;
    out.extend(results.into_iter().flatten());
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_small_csv_snapshot_fits_the_smallest_budget() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(1);
    let made = json!({"action": "create", "format": "csv", "mode": "portable", "path": "x.csv"});
    let (_, made) = finish(&pool, office("t", &root, &data, made)).await;
    let session = answer(&made.expect("the call succeeds"))["session"].clone();
    let fill = json!({"action": "batch", "session": session, "operations": [{"op": "set_range", "range": "A1:B4", "values": [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]}]});
    let (_, filled) = finish(&pool, office("t", &root, &data, fill)).await;
    filled.expect("the batch succeeds");
    let read = json!({"action": "snapshot", "session": session, "maxChars": 1000});
    let (_, read) = finish(&pool, office("t", &root, &data, read)).await;
    let text = read.expect("the snapshot is answered")["result"]["content"][0]["text"].as_str().unwrap_or_default().to_owned();
    assert!(!text.contains("retryRequired"), "{} chars: {text}", text.len());
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_with_an_output_writes_the_copy_there() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(1);
    let made = json!({"action": "create", "format": "xlsx", "mode": "portable", "path": "t1.xlsx"});
    let (_, made) = finish(&pool, office("t", &root, &data, made)).await;
    let session = answer(&made.expect("the call succeeds"))["session"].clone();
    let saved = json!({"action": "save", "session": session, "output": "t1-copy.xlsx"});
    let (_, saved) = finish(&pool, office("t", &root, &data, saved)).await;
    let value = saved.expect("the call succeeds");
    assert!(value["result"]["isError"].is_null(), "{value}");
    let copy = root.join("t1-copy.xlsx");
    assert!(exists(&copy), "the copy is written to output");
    assert_eq!(mixdog_fsio::read(&Unlaned, &copy).expect("copy"), mixdog_fsio::read(&Unlaned, &root.join("t1.xlsx")).expect("original"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_call_does_not_unpin_the_thread_from_the_worker_that_holds_its_session() {
    let scratch = tempfile::tempdir().expect("scratch");
    let (root, data) = (scratch.path().join("root"), scratch.path().join("data"));
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let pool = pool(2);
    // Worker 0 is busy, so the session is made on worker 1, which pins the thread there.
    let holder = pool.call(plain("holder", "sleep", json!({"ms": 600_000}))).expect("accepted");
    until(&pool, |s| busy(s) == 1).await;
    let (_, made) = finish(&pool, office("owner", &root, &data, create("held.docx"))).await;
    let session = answer(&made.expect("the call succeeds"))["session"].clone();
    drop(holder);
    until(&pool, |s| s.len() == 2 && busy(s) == 0).await;

    // A call the worker refuses before it runs (a path outside what was approved) answers an error, not a pin.
    let (_, refused) = finish(&pool, office("owner", &root, &data, json!({"action": "snapshot", "path": "../outside.docx"}))).await;
    assert!(refused.is_err(), "the path is refused");

    // Both workers are idle and worker 0 is the first the pool would pick: the session is still on worker 1.
    let seen = finish(&pool, office("owner", &root, &data, json!({"action": "snapshot", "session": session}))).await.1.expect("the call succeeds");
    assert!(seen["result"]["isError"].is_null(), "the thread stayed on the worker of its session: {seen}");
    pool.close().await;
}
