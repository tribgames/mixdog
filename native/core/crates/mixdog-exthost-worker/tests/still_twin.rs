//! `image.still` and `image.resize` as the real worker serves them, driven through the pool over `ext_worker_dev` and replayed
//! against what Node's worker answered: the still cases of `fixtures/image-still` (class, extension, size and alpha of the
//! rendition), its WebP `image.resize` cases, and the resize cases of `fixtures/image-codec` (the envelope, the sizes, the
//! mime type and the decoder's sentence). `ExtImageCodec::still_rendition` must read the same `StillRendition` shapes from the
//! worker as it read from Node's.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::ExtImageCodec;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_exthost::RenditionVariant;
use mixdog_exthost::StillRendition;
use mixdog_imaging::DECODE_PIXEL_LIMIT;
use mixdog_imaging::Format;
use mixdog_imaging::decode;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn cases(corpus: &str, op: &str) -> Vec<Value> {
    let recorded: Value =
        serde_json::from_str(&mixdog_testkit::read_string(fixtures().join(corpus).join("corpus.json"))).expect("the corpus parses");
    let cases: Vec<Value> = recorded["cases"].as_array().unwrap().iter().filter(|case| case["op"] == op).cloned().collect();
    assert!(!cases.is_empty(), "no {op} cases in {corpus}");
    cases
}

fn input(corpus: &str, case: &Value) -> Vec<u8> {
    mixdog_testkit::read(fixtures().join(corpus).join("inputs").join(format!("{}.bin", case["input"].as_str().unwrap())))
}

fn pool() -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_ext_worker_dev")),
        args: Vec::new(),
        electron: false,
        workers: 2,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-still-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

async fn ask(pool: &ExtHostPool, method: &str, params: Value) -> Result<Value, ExtError> {
    let mut stream = pool
        .call(ExtCall { thread: ThreadId::from("still-twin"), method: method.to_owned(), params, paths: Vec::new() })
        .expect("the call is accepted");
    loop {
        match stream.next().await.expect("the stream ends with Done") {
            ExtFrame::Chunk(_) => {}
            ExtFrame::Done(outcome) => return outcome,
        }
    }
}

fn refused(outcome: Result<Value, ExtError>) -> (String, String) {
    match outcome {
        Err(ExtError::Failed { code, message }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// What a recorded `pixels` entry says about an output image: its format, size and alpha.
fn check_shape(name: &str, data: &[u8], recorded: &Value) {
    let decoded = decode(data, DECODE_PIXEL_LIMIT).unwrap_or_else(|error| panic!("{name}: the output does not decode: {error}"));
    assert_eq!(decoded.format, Format::Webp, "{name}: format");
    assert_eq!(u64::from(decoded.width), recorded["width"].as_u64().unwrap(), "{name}: width");
    assert_eq!(u64::from(decoded.height), recorded["height"].as_u64().unwrap(), "{name}: height");
    assert_eq!(decoded.raster.has_alpha, recorded["hasAlpha"].as_bool().unwrap(), "{name}: alpha");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_still_answers_the_recorded_renditions() {
    let pool = pool();
    let mut seen_none = false;
    for case in cases("image-still", "still") {
        let name = case["name"].as_str().unwrap();
        let params = json!({"data": STANDARD.encode(input("image-still", &case)), "variant": case["variant"]});
        let answer = ask(&pool, "image.still", params).await.unwrap_or_else(|error| panic!("{name}: {error:?}"));
        if case["divergence"] == "avif-svg" {
            // Owner decision: AVIF and SVG bytes are answered as not decoding.
            assert_eq!(answer, json!({"ok": null}), "{name}");
            continue;
        }
        let expect = &case["expect"];
        if expect["class"] == "none" {
            seen_none = true;
            assert_eq!(answer, json!({"ok": null}), "{name}");
        } else {
            assert_eq!(answer["ok"]["extension"], expect["extension"], "{name}");
            let data = STANDARD.decode(answer["ok"]["data"].as_str().unwrap_or_else(|| panic!("{name}: no rendition"))).unwrap();
            check_shape(name, &data, &expect["pixels"]);
        }
    }
    assert!(seen_none, "the corpus has sources that do not decode");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_resize_answers_the_recorded_envelopes() {
    let pool = pool();
    for corpus in ["image-codec", "image-still"] {
        for case in cases(corpus, "resize") {
            let name = case["name"].as_str().unwrap();
            let params = json!({"data": STANDARD.encode(input(corpus, &case)), "ext": case["ext"], "profile": case["profile"]});
            let answer = ask(&pool, "image.resize", params).await.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let expect = &case["expect"];
            if case["divergence"] == "avif-svg" {
                assert_eq!(answer["error"], "invalid", "{name}: {answer}");
                assert!(answer["message"].as_str().unwrap().contains("unsupported image format"), "{name}: {answer}");
                continue;
            }
            match expect["class"].as_str().unwrap() {
                "none" => assert_eq!(answer, json!({"ok": null}), "{name}"),
                "invalid" => assert_eq!(answer, json!({"error": "invalid", "message": expect["error"]["message"]}), "{name}"),
                _ => {
                    let ok = &answer["ok"];
                    assert_eq!(ok["mimeType"], expect["mime"], "{name}: mime");
                    for key in ["originalWidth", "originalHeight", "displayWidth", "displayHeight"] {
                        assert_eq!(ok["dimensions"][key], expect[key], "{name}: {key}");
                    }
                    let data = STANDARD.decode(ok["data"].as_str().unwrap_or_else(|| panic!("{name}: {answer}"))).unwrap();
                    if let Some(original) = expect.get("original").and_then(Value::as_bool) {
                        assert_eq!(data == input(corpus, &case), original, "{name}: untouched");
                    }
                }
            }
        }
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_codec_reads_the_same_rendition_shapes_from_the_worker() {
    let pool = Arc::new(pool());
    let codec = ExtImageCodec::new(pool.clone() as Arc<dyn ExtPool>);
    let thread = ThreadId::from("still-twin");
    for case in cases("image-still", "still") {
        let name = case["name"].as_str().unwrap();
        let variant = match case["variant"].as_str().unwrap() {
            "thumb" => RenditionVariant::Thumb,
            _ => RenditionVariant::Display,
        };
        let got = codec
            .still_rendition(&thread, &input("image-still", &case), variant)
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        if case["divergence"] == "avif-svg" || case["expect"]["class"] == "none" {
            assert_eq!(got, None, "{name}");
            continue;
        }
        let StillRendition { extension, bytes } = got.unwrap_or_else(|| panic!("{name}: no rendition"));
        assert_eq!(extension, case["expect"]["extension"].as_str().unwrap(), "{name}");
        check_shape(name, &bytes, &case["expect"]["pixels"]);
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_still_and_resize_calls_refuse_what_the_node_handlers_refuse() {
    let pool = pool();
    let data = STANDARD.encode(input("image-still", &cases("image-still", "still")[0]));
    let (code, message) = refused(ask(&pool, "image.still", json!({"data": data, "variant": "original"})).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "unknown rendition variant: original"));
    let (_, message) = refused(ask(&pool, "image.still", json!({"data": data})).await);
    assert_eq!(message, "unknown rendition variant: undefined");
    let (code, message) = refused(ask(&pool, "image.still", json!({"data": 5, "variant": "thumb"})).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    let (code, message) = refused(ask(&pool, "image.resize", json!({"data": null, "ext": "png"})).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    // An empty buffer gives no image.
    assert_eq!(ask(&pool, "image.resize", json!({"data": "", "ext": "png"})).await.unwrap(), json!({"ok": null}));
    assert_eq!(ask(&pool, "image.still", json!({"data": "", "variant": "thumb"})).await.unwrap(), json!({"ok": null}));
    pool.close().await;
}
