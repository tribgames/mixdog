//! `office.sweepJournals` through the pool over the worker process: the data directory holds journals Node wrote (a pending
//! one, a committed one, one that does not parse, one past the 30-day retention with its checkpoint and baseline PDF); the
//! answer is Node's (`{value: null}`) and the folder holds what Node's listing leaves.

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_fsio::Unlaned;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

fn pool() -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(mixdog_testkit::bin_exe!("ext_worker_dev")),
        args: Vec::new(),
        workers: 1,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-office-journal-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

async fn sweep(pool: &ExtHostPool, params: Value) -> Result<Value, ExtError> {
    let mut stream = pool
        .call(ExtCall { thread: ThreadId::from("office-sweep"), method: "office.sweepJournals".to_owned(), params, paths: Vec::new() })
        .expect("the call is accepted");
    loop {
        if let ExtFrame::Done(outcome) = stream.next().await.expect("the stream ends with Done") {
            return outcome;
        }
    }
}

fn put(path: &Path, text: &str) {
    mixdog_fsio::create_dir_all(&Unlaned, path.parent().expect("a parent")).expect("folder");
    mixdog_fsio::write(&Unlaned, path, text.as_bytes()).expect("file");
}

fn names(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = mixdog_fsio::read_dir(&Unlaned, folder)
        .expect("the folder exists")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sweep_answers_null_and_leaves_what_the_listing_leaves() {
    let scratch = tempfile::tempdir().expect("scratch");
    let data = scratch.path().join("data");
    let folder = data.join("office-transactions");
    let checkpoint = scratch.path().join("checkpoint.bin");
    let baseline = scratch.path().join("baseline.pdf");
    let fresh = "2999-01-01T00:00:00.000Z";
    put(&folder.join("pending.json"), &json!({"version": 1, "id": "pending", "updatedAt": fresh, "transaction": {"state": "pending"}}).to_string());
    put(&folder.join("committed.json"), &json!({"version": 1, "id": "committed", "startedAt": fresh, "transaction": {"state": "committed"}}).to_string());
    put(&folder.join("corrupt.json"), "{ not json");
    put(&folder.join("notes.txt"), "not a journal");
    put(&checkpoint, "checkpoint");
    put(&baseline, "baseline");
    put(
        &folder.join("old.json"),
        &json!({
            "version": 1, "id": "old", "updatedAt": "2000-01-01T00:00:00.000Z",
            "checkpoint": checkpoint.to_string_lossy(), "baselinePdf": baseline.to_string_lossy(),
        })
        .to_string(),
    );
    let pool = pool();
    let answer = sweep(&pool, json!({"dataDir": data.to_string_lossy()})).await.expect("the sweep answers");
    assert_eq!(answer, Value::Null);
    // The old record, its checkpoint and its baseline are gone; the fresh ones, the unparsable file (its modification time is
    // new) and the non-journal file stay.
    assert_eq!(names(&folder), ["committed.json", "corrupt.json", "notes.txt", "pending.json"]);
    assert!(!mixdog_fsio::exists(&Unlaned, &checkpoint).unwrap() && !mixdog_fsio::exists(&Unlaned, &baseline).unwrap());
    // A second sweep finds nothing more to do.
    assert_eq!(sweep(&pool, json!({"dataDir": data.to_string_lossy()})).await.expect("answers"), Value::Null);
    assert_eq!(names(&folder).len(), 4);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sweep_creates_the_missing_folder_and_a_bad_parameter_is_refused() {
    let scratch = tempfile::tempdir().expect("scratch");
    let data = scratch.path().join("fresh");
    let pool = pool();
    assert_eq!(sweep(&pool, json!({"dataDir": data.to_string_lossy()})).await.expect("answers"), Value::Null);
    assert!(mixdog_fsio::is_dir(&Unlaned, &data.join("office-transactions")));
    match sweep(&pool, json!({"dataDir": 7})).await {
        Err(ExtError::Failed { code, .. }) => assert_eq!(code, "ERR_INVALID_ARG_TYPE"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    pool.close().await;
}
