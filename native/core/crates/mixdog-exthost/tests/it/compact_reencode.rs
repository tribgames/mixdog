//! Tool-result image compaction over the real Rust worker equals Node's recorded re-encode
//! (`fixtures/agent/compact/golden/image.json`, `reencode`): the mime and the note are exact; the JPEG is the same picture
//! as the one sharp wrote, under the rules of `mixdog-imaging`'s twin (`super::composer_resize::same_picture`).

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
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
async fn a_large_png_is_reencoded_to_nodes_picture_and_note() {
    let pool = Arc::new(
        ExtHostPool::new(ExtHostConfig {
            program: super::composer_resize::worker_binary(),
            args: Vec::new(),
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
    let outcome = compactor.compact(case["data"].as_str().unwrap(), case["mime"].as_str().unwrap()).await;
    let ImageOutcome::Compacted { data, mime, note } = outcome else { panic!("not re-encoded") };
    assert_eq!(mime, case["outMime"].as_str().unwrap());
    assert_eq!(note.as_deref(), case["note"].as_str());
    let decoded = |text: &str| base64::engine::general_purpose::STANDARD.decode(text).unwrap();
    super::composer_resize::same_picture("the re-encoded JPEG", &mime, &decoded(&data), &decoded(case["jpeg"].as_str().unwrap()));
    pool.close().await;
}
