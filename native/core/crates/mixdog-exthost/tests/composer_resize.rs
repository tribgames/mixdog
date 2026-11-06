//! The composer's image resize through the REAL extension-host worker and its `sharp`
//! (`src/ext-host/worker.mjs`, which needs `sharp` in the repository's `node_modules`), against the
//! `resizeImageBuffer(bytes, ext, { profile })` results Node recorded for the composer's
//! `resizeImage` (`fixtures/turn-ops/composer-image.json`, `benchmarks/rust-core/recorders/
//! record-turn-ops.mjs`): the resized image's bytes (so its format and quality), its mime type, the
//! original and displayed dimensions, and the decoder's sentence for bytes it rejects.

use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::ExtImageCodec;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_protocol::ThreadId;
use serde_json::Value;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_composer_resize_equals_nodes_resize_image_buffer_under_the_providers_profile() {
    let doc: Value = serde_json::from_str(include_str!("../../../fixtures/turn-ops/composer-image.json")).unwrap();
    let pool = std::sync::Arc::new(
        ExtHostPool::new(ExtHostConfig {
            program: "node".into(),
            args: vec![root().join("src").join("ext-host").join("worker.mjs").into_os_string()],
            electron: false,
            workers: 1,
            pending_cap: 64,
            spawn_io: mixdog_rt::testing::tokens().spawn_io,
            render_browser: RenderBrowserConfig { command: None, profile_root: std::env::temp_dir().join("mixdog-exthost-composer"), no_sandbox: false },
        })
        .unwrap(),
    );
    let codec = ExtImageCodec::new(pool.clone());
    let thread = ThreadId::from("composer");
    let profile_of = |provider: &str| {
        let recorded = doc["profiles"].as_array().unwrap().iter().find(|p| p["provider"].as_str().unwrap_or_default() == provider).unwrap();
        if recorded["profile"] == "openai" { ImageProfile::OpenAi } else { ImageProfile::Anthropic }
    };
    let mut compared = 0;
    for case in doc["resize"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let recorded = &case["resizer"];
        if recorded.is_null() {
            continue;
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(case["input"]["data"].as_str().unwrap()).unwrap();
        let ext = case["ext"].as_str().unwrap();
        let got = tokio::time::timeout(Duration::from_secs(60), codec.resize_profiled(&thread, &bytes, ext, profile_of(case["provider"].as_str().unwrap())))
            .await
            .unwrap();
        match (got, recorded.get("ok"), recorded.get("error")) {
            (Ok(Some(image)), Some(ok), _) => {
                assert_eq!(image.data_base64, ok["data"].as_str().unwrap(), "{name}: bytes");
                assert_eq!(image.mime, ok["mimeType"].as_str().unwrap(), "{name}: format");
                let dims = &ok["dimensions"];
                let n = |key: &str| u32::try_from(dims[key].as_u64().unwrap()).unwrap();
                assert_eq!((image.original_w, image.original_h, image.display_w, image.display_h), (n("originalWidth"), n("originalHeight"), n("displayWidth"), n("displayHeight")), "{name}: dimensions");
            }
            (Err(ProfiledResizeError::Invalid(message)), _, Some(error)) => assert_eq!(message, error["message"].as_str().unwrap(), "{name}: decoder sentence"),
            (other, ..) => panic!("{name}: {other:?}"),
        }
        compared += 1;
    }
    assert!(compared >= 6, "the recorded image cases were compared");
    pool.close().await;
}
