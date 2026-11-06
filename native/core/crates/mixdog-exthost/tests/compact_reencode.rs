//! Tool-result image compaction over the real sharp worker equals Node's recorded re-encode
//! (`fixtures/agent/compact/golden/image.json`, `reencode`): the JPEG bytes, mime and note.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::compact::image::ToolImageCompactor;
use mixdog_agent::offload::ImageCompactor;
use mixdog_agent::offload::ImageOutcome;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::ExtImageCodec;
use mixdog_exthost::RenderBrowserConfig;
use serde_json::Value;

#[allow(clippy::disallowed_methods, reason = "test setup: reads the recorded golden fixture")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_png_is_reencoded_to_nodes_bytes_and_note() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    let host = root.join("src").join("ext-host");
    let pool = Arc::new(
        ExtHostPool::new(ExtHostConfig {
            program: "node".into(),
            args: vec![host.join("worker.mjs").into_os_string()],
            electron: false,
            workers: 1,
            pending_cap: 64,
            spawn_io: mixdog_rt::testing::tokens().spawn_io,
            render_browser: RenderBrowserConfig { command: None, profile_root: std::env::temp_dir().join("mixdog-exthost-tests"), no_sandbox: false },
        })
        .unwrap(),
    );
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().join("fixtures/agent/compact/golden/image.json");
    let golden: Value = serde_json::from_slice(&std::fs::read(golden).unwrap()).unwrap();
    let case = &golden["reencode"];

    let compactor = ToolImageCompactor::new(Arc::new(ExtImageCodec::new(pool.clone())));
    let outcome = tokio::time::timeout(Duration::from_secs(60), compactor.compact(case["data"].as_str().unwrap(), case["mime"].as_str().unwrap()))
        .await
        .expect("watchdog");
    let ImageOutcome::Compacted { data, mime, note } = outcome else { panic!("not re-encoded") };
    assert_eq!(data, case["jpeg"].as_str().unwrap(), "the JPEG bytes differ from Node's");
    assert_eq!(mime, case["outMime"].as_str().unwrap());
    assert_eq!(note.as_deref(), case["note"].as_str());
    pool.close().await;
}
