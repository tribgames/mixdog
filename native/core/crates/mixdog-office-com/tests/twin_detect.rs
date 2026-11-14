//! Twin of Node's `detectMicrosoftOffice` (`src/runtime/office/com/com-adapter.mjs`): the one-shot `detect` action for
//! docx, xlsx and pptx must answer, through Rust, exactly the JSON the recording
//! (`fixtures/office-detect/golden.json`, recorded by `benchmarks/rust-core/recorders/record-office-detect.mjs`) holds
//! for the same machine. Windows only: elsewhere there is no COM to probe and the test passes without running.
//! The action only reads the registry and the running-object table; no application is started.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use serde_json::Value;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-com-detect-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&dir);
    dir
}

async fn replay(golden: &Value) {
    let data = scratch();
    let mut config = OfficeComConfig::new(data.clone(), mixdog_rt::testing::tokens());
    config.drain_grace = Duration::from_secs(15);
    let office = OfficeCom::new(config);
    let cases = golden["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let format = case["format"].as_str().expect("format");
        let path = case["path"].as_str().expect("path");
        let reply = office.detect(format, path).await;
        assert_eq!(reply.value, case["result"], "detect {format} {path:?}");
    }
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rust_detect_equals_nodes_recorded_answer() {
    if !cfg!(windows) {
        return;
    }
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/office-detect/golden.json"))
        .expect("golden.json");
    assert_eq!(golden["platform"], "win32", "the recording is of a Windows machine");
    replay(&golden).await;
}

/// Records again with Node and compares: `cargo test -p mixdog-office-com --test twin_detect -- --ignored`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "re-records through Node (src/runtime/office/com/com-adapter.mjs) and probes this machine's Office installation"]
async fn twin_live_detect() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let recorder = root.join("benchmarks/rust-core/recorders/record-office-detect.mjs");
    let status = tokio::process::Command::new("node")
        .arg(&recorder)
        .arg("--tree")
        .arg(&root)
        .status()
        .await
        .expect("run node");
    assert!(status.success(), "the recorder failed");
    let golden: Value = serde_json::from_str(&mixdog_testkit::read_string(
        root.join("native/core/fixtures/office-detect/golden.json"),
    ))
    .expect("golden.json");
    replay(&golden).await;
}
