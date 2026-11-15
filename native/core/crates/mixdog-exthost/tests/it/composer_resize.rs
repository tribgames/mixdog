//! The composer's image resize through the REAL extension-host worker (the Rust `ext_worker_dev`, which serves the
//! `image.*` methods over `mixdog-imaging`), against the `resizeImageBuffer(bytes, ext, { profile })` results Node's
//! sharp recorded for the composer's `resizeImage` (`fixtures/turn-ops/composer-image.json`,
//! `benchmarks/rust-core/recorders/record-turn-ops.mjs`): the resized image, its mime type, the original and displayed
//! dimensions, and the decoder's sentence for bytes it rejects.
//!
//! The recorded bytes come from libvips and libjpeg, so they are compared under the rules of `mixdog-imaging`'s twin
//! (`tests/node_twin.rs`): mime, dimensions and the token-gate branch (which they settle) are exact, an image that fits is
//! answered as its own bytes, the pixels are compared by PSNR (38 dB) and mean difference (2.0) of a 32x32 area-averaged
//! thumbnail, and a JPEG's size is within 15 percent (or 200 bytes) of sharp's. See [`same_picture`].

use std::path::Path;

use base64::Engine as _;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::ExtImageCodec;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_imaging::DECODE_PIXEL_LIMIT;
use mixdog_imaging::decode;
use mixdog_protocol::ThreadId;
use serde_json::Value;

const THUMB: usize = 32;
const MIN_PSNR: f64 = 38.0;
const MAX_MEAN_ABSOLUTE_DIFFERENCE: f64 = 2.0;
const JPEG_SIZE_TOLERANCE: f64 = 0.15;

/// The Rust worker these tests start: `ext_worker_dev` of `mixdog-exthost-worker` (built with its feature `test-support`,
/// e.g. `cargo build -p mixdog-exthost-worker --features test-support --bin ext_worker_dev`). Cargo names a binary only to
/// the tests of its own package, so it is found next to this test binary's `deps` directory.
pub(crate) fn worker_binary() -> std::path::PathBuf {
    let exe = std::env::current_exe().expect("the test binary's path");
    let dir = exe.parent().and_then(Path::parent).expect("the target directory");
    let worker = dir.join(format!("ext_worker_dev{}", std::env::consts::EXE_SUFFIX));
    assert!(worker.is_file(), "the Rust worker is not built: {}", worker.display());
    worker
}

/// The mean of every cell of a 32x32 grid over RGBA pixels, rounded.
fn thumbnail(rgba: &[u8], width: u32, height: u32) -> Vec<f64> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0f64; THUMB * THUMB * 4];
    for cy in 0..THUMB {
        let (y0, y1) = (cy * h / THUMB, h.min(((cy + 1) * h / THUMB).max(cy * h / THUMB + 1)));
        for cx in 0..THUMB {
            let (x0, x1) = (cx * w / THUMB, w.min(((cx + 1) * w / THUMB).max(cx * w / THUMB + 1)));
            let mut sums = [0f64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    for (channel, sum) in sums.iter_mut().enumerate() {
                        *sum += f64::from(rgba[(y * w + x) * 4 + channel]);
                    }
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f64;
            for (channel, sum) in sums.iter().enumerate() {
                out[(cy * THUMB + cx) * 4 + channel] = (sum / count).round();
            }
        }
    }
    out
}

/// `ours` is the same picture as `theirs` (bytes sharp produced) under the rules of `mixdog-imaging`'s twin: both decode to
/// the same size, their thumbnails are within PSNR 38 dB and a mean difference of 2.0, and a JPEG's size is within 15
/// percent (or 200 bytes) of sharp's.
pub(crate) fn same_picture(name: &str, mime: &str, ours: &[u8], theirs: &[u8]) {
    let a = decode(ours, DECODE_PIXEL_LIMIT).unwrap_or_else(|error| panic!("{name}: our output does not decode: {error}"));
    let b = decode(theirs, DECODE_PIXEL_LIMIT).unwrap_or_else(|error| panic!("{name}: sharp's output does not decode: {error}"));
    assert_eq!((a.width, a.height), (b.width, b.height), "{name}: decoded size");
    let (x, y) = (thumbnail(&a.raster.to_rgba(), a.width, a.height), thumbnail(&b.raster.to_rgba(), b.width, b.height));
    let (mut squares, mut absolute) = (0f64, 0f64);
    for (p, q) in x.iter().zip(&y) {
        squares += (p - q) * (p - q);
        absolute += (p - q).abs();
    }
    let mse = squares / x.len() as f64;
    let psnr = if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() };
    let mad = absolute / x.len() as f64;
    assert!(psnr >= MIN_PSNR && mad <= MAX_MEAN_ABSOLUTE_DIFFERENCE, "{name}: pixels differ (PSNR {psnr:.1} dB, mean difference {mad:.2})");
    if mime == "image/jpeg" {
        let allowed = (theirs.len() as f64 * JPEG_SIZE_TOLERANCE).max(200.0);
        assert!((ours.len() as f64 - theirs.len() as f64).abs() <= allowed, "{name}: the JPEG is {} bytes, sharp's {}", ours.len(), theirs.len());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_composer_resize_equals_nodes_resize_image_buffer_under_the_providers_profile() {
    let doc: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-ops/composer-image.json")).unwrap();
    let pool = std::sync::Arc::new(
        ExtHostPool::new(ExtHostConfig {
            program: worker_binary(),
            args: Vec::new(),
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
        let got = codec.resize_profiled(&thread, &bytes, ext, profile_of(case["provider"].as_str().unwrap())).await;
        match (got, recorded.get("ok"), recorded.get("error")) {
            (Ok(Some(image)), Some(ok), _) => {
                assert_eq!(image.mime, ok["mimeType"].as_str().unwrap(), "{name}: format");
                let dims = &ok["dimensions"];
                let n = |key: &str| u32::try_from(dims[key].as_u64().unwrap()).unwrap();
                assert_eq!((image.original_w, image.original_h, image.display_w, image.display_h), (n("originalWidth"), n("originalHeight"), n("displayWidth"), n("displayHeight")), "{name}: dimensions");
                let decoded = |text: &str| base64::engine::general_purpose::STANDARD.decode(text).unwrap();
                let (ours, theirs) = (decoded(&image.data_base64), decoded(ok["data"].as_str().unwrap()));
                if theirs == bytes {
                    assert_eq!(ours, bytes, "{name}: an image that fits is answered as its own bytes");
                } else {
                    same_picture(name, &image.mime, &ours, &theirs);
                }
            }
            (Err(ProfiledResizeError::Invalid(message)), _, Some(error)) => assert_eq!(message, error["message"].as_str().unwrap(), "{name}: decoder sentence"),
            (other, ..) => panic!("{name}: {other:?}"),
        }
        compared += 1;
    }
    assert!(compared >= 6, "the recorded image cases were compared");
    pool.close().await;
}
