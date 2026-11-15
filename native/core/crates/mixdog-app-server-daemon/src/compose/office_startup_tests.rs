use super::*;
use serde_json::{Value, json};
use std::time::Duration;

/// The binary of `mixdog-exthost-worker --features test-support --bin ext_worker_dev`: Cargo names a binary only to the tests of
/// its own package, so it is found next to this test binary's `deps` directory.
fn worker_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("the test binary's path");
    let dir = exe.parent().and_then(Path::parent).expect("the target directory");
    let worker = dir.join(format!("ext_worker_dev{}", std::env::consts::EXE_SUFFIX));
    assert!(worker.is_file(), "the Rust worker is not built: {}", worker.display());
    worker
}

/// The files of `dir` below `prefix` in name order, directories first as their own rows: `{path, kind, base64}`.
#[allow(clippy::disallowed_methods, reason = "test snapshot read on the test thread")]
fn tree(dir: &Path, prefix: &str) -> Vec<Value> {
    use base64::Engine as _;
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap()).collect();
    entries.sort_by_key(|entry| entry.file_name());
    let mut out = Vec::new();
    for entry in entries {
        let path = format!("{prefix}{}", entry.file_name().to_string_lossy());
        if entry.file_type().unwrap().is_dir() {
            out.push(json!({"path": path, "kind": "directory"}));
            out.extend(tree(&entry.path(), &format!("{path}/")));
        } else {
            out.push(json!({"path": path, "kind": "file", "base64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(entry.path()).unwrap())}));
        }
    }
    out
}

/// The recording's journals (ages around the 30-day retention, an unreadable file, a file that is no journal) are swept by the
/// worker the session start asks, at the clock the recording was taken at (`--clock-ms`): the folder holds what Node left.
#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::disallowed_methods, reason = "test setup writes the recorded folder on the test thread")]
async fn session_start_sweeps_the_complete_recorded_office_subject() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let expected: Value = serde_json::from_str(include_str!("../../../../fixtures/office-startup/recording.json")).unwrap();
    let input = &expected;
    for row in input["inputs"].as_array().unwrap() {
        let path = data.join(row["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, row["text"].as_str().unwrap()).unwrap();
        let modified = std::time::UNIX_EPOCH + Duration::from_millis(row["mtimeMs"].as_u64().unwrap());
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
    }
    let now = input["now"].as_u64().unwrap();
    let mut js = crate::js_runtime::fixture(dir.path());
    // The recording is the sweep at its own clock, so the scripted worker (the document methods and a sweep on that clock) answers it.
    js.ext_worker = Some((worker_binary(), vec!["--clock-ms".into(), now.to_string().into()]));
    let tokens = mixdog_rt::testing::tokens();
    let stop = mixdog_rt::CancellationToken::new();
    let mut completed = crate::office_startup::completions().subscribe();
    let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, ComposeConfig {
        data_dir: data.clone(), user_data_dir: dir.path().join("userdata"), runtime_root: dir.path().join("runtime"),
        js_runtime: js, ort_library: OrtRuntime::NoBinding,
        outgoing: mixdog_app_server::Outgoing::new(),
        ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
        log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
        stop, catalog_http: crate::compose_test_support::offline_http(),
        pg_install: Some(Arc::new(|_| Box::pin(async {
            Err(mixdog_services::memory::error::MemoryError::Runtime("office sweep test must not install PostgreSQL".into()))
        }))),
    })).await.expect("office sweep core composition did not complete within 60 seconds").unwrap();
    let thread = mixdog_core_api::ids::ThreadId::from("office-startup-recording");
    let outcome = async {
        core.real.directory.create_with_id(thread.clone(), serde_json::Map::new(), json!({})).await.unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(30), async {
            loop { if completed.recv().await.unwrap() == thread { break; } }
        }).await.expect("session startup office-journal host call did not complete within 30 seconds");
        let mut artifacts = Vec::new();
        for row in input["inputs"].as_array().unwrap() {
            if !row["path"].as_str().unwrap().ends_with(".json") { continue; }
            let Ok(record) = serde_json::from_str::<Value>(row["text"].as_str().unwrap()) else { continue };
            for key in ["checkpoint", "baselinePdf"] {
                let path = record[key].as_str().unwrap();
                match std::fs::read(data.join(path)) {
                    Ok(bytes) => artifacts.push(json!({"path": path, "present": true, "base64": base64::engine::general_purpose::STANDARD.encode(bytes)})),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => artifacts.push(json!({"path": path, "present": false})),
                    Err(error) => panic!("{path}: {error}"),
                }
            }
        }
        json!({"journals": tree(&data.join("office-transactions"), ""), "artifacts": artifacts})
    };
    use futures::FutureExt;
    let result = std::panic::AssertUnwindSafe(outcome).catch_unwind().await;
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("office startup test")).await
        .expect("office startup core shutdown did not complete within 30 seconds");
    assert_eq!(result.unwrap(), expected["tree"]);
}
