//! `pdf.render` and `pdf.ocr` of the real worker, driven through the pool over `ext_worker_dev` and replayed against what
//! Node's `renderPdfPages` answered (`fixtures/office-render-pages/golden.json`): the result object without the pixels (they
//! travel as chunks, one per top-level image in `images` order, and each entry carries `bytes` in place of `data`), the error
//! messages, the nothing-written-beside-the-PDF rule, the approved-path guard and a cancel in the middle of a render. The pixels
//! themselves are held to the recording by `mixdog-office-pdf`'s own twin test; here a chunk is checked to be the PNG the entry
//! names. Recognition needs the engine downloaded on first use, which no test starts: only its path guard is exercised.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::{ExtCall, ExtError, ExtFrame, ExtPool};
use mixdog_exthost::{ExtHostConfig, ExtHostPool, RenderBrowserConfig};
use mixdog_protocol::ThreadId;
use serde_json::{Value, json};

const PNG_MAGIC: [u8; 4] = [0x89, 0x50, 0x4e, 0x47];

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn pool(workers: usize) -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_ext_worker_dev")),
        args: Vec::new(),
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-pdf-render-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

fn call(method: &str, params: Value, approved: &[&Path]) -> ExtCall {
    ExtCall {
        thread: ThreadId::from("pdf-render-ocr"),
        method: method.to_owned(),
        params,
        paths: approved.iter().map(|path| AbsPath::new(path.to_path_buf()).expect("an absolute path")).collect(),
    }
}

/// The chunks of a call in order and its outcome.
async fn ask(pool: &ExtHostPool, method: &str, params: Value, approved: &[&Path]) -> (Vec<Vec<u8>>, Result<Value, ExtError>) {
    let mut stream = pool.call(call(method, params, approved)).expect("the call is accepted");
    let mut chunks = Vec::new();
    loop {
        match stream.next().await.expect("the stream ends with Done") {
            ExtFrame::Chunk(bytes) => chunks.push(bytes),
            ExtFrame::Done(outcome) => return (chunks, outcome),
        }
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

/// The call's parameters from the recorded options.
fn params_of(path: &Path, options: &Value) -> Value {
    let mut params = json!({"path": path});
    for key in ["pages", "maxWidth", "maximumScale"] {
        if let Some(value) = options.get(key) {
            params[key] = value.clone();
        }
    }
    params
}

fn refusal(outcome: Result<Value, ExtError>) -> (String, String) {
    match outcome {
        Err(ExtError::Failed { code, message }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).expect("the folder lists").map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// Each recorded image against the answered entry: the geometry and pages, and its bytes, which follow in `images` order (a
/// chunk carries at most 64 KiB, so an image may span several).
fn check_images(name: &str, answered: &Value, recorded: &Value, chunks: &[Vec<u8>]) {
    let images = answered["images"].as_array().expect("images");
    let expected = recorded["images"].as_array().expect("recorded images");
    assert_eq!(images.len(), expected.len(), "{name}: image count");
    let sent = chunks.concat();
    let counted: u64 = images.iter().map(|entry| entry["bytes"].as_u64().expect("bytes")).sum();
    assert_eq!(sent.len() as u64, counted, "{name}: the chunks are the images' bytes, nothing else");
    let mut offset = 0;
    for (at, (entry, golden)) in images.iter().zip(expected).enumerate() {
        for key in ["page", "pages", "width", "height", "mimeType"] {
            assert_eq!(entry.get(key), golden.get(key), "{name}: image {at} {key}");
        }
        let file = Path::new(entry["path"].as_str().expect("path")).file_name().expect("file name").to_string_lossy().into_owned();
        assert_eq!(Some(file.as_str()), golden["file"].as_str(), "{name}: image {at} file");
        assert!(entry.get("data").is_none(), "{name}: image {at} carries bytes, not data");
        let bytes = entry["bytes"].as_u64().expect("bytes") as usize;
        assert_eq!(sent[offset..offset + 4], PNG_MAGIC, "{name}: image {at}'s bytes start where the one before ends, a PNG");
        offset += bytes;
        if let Some(sheet) = golden.get("pageImages").and_then(Value::as_array) {
            let pages = entry["pageImages"].as_array().expect("pageImages");
            assert_eq!(pages.len(), sheet.len(), "{name}: thumbnails of image {at}");
            for (page, thumbnail) in pages.iter().zip(sheet) {
                for key in ["page", "width", "height"] {
                    assert_eq!(page.get(key), thumbnail.get(key), "{name}: thumbnail {key}");
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn render_answers_the_recorded_cases_with_the_images_as_chunks() {
    let golden: Value = serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("office-render-pages/golden.json"))).expect("the golden parses");
    let pool = pool(2);
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 15);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let scratch = tempfile::tempdir().expect("scratch");
        let file = scratch.path().join("doc.pdf");
        std::fs::write(&file, unhex(case["pdf"].as_str().expect("pdf"))).expect("the PDF is written");
        let (chunks, outcome) = ask(&pool, "pdf.render", params_of(&file, &case["options"]), &[scratch.path()]).await;
        match (case.get("result"), case.get("error")) {
            (Some(recorded), _) => {
                let answered = outcome.unwrap_or_else(|error| panic!("{name}: {error:?}"));
                assert_eq!(answered["pageCount"], recorded["pageCount"], "{name}: page count");
                assert_eq!(answered["visualCoverage"], recorded["visualCoverage"], "{name}: coverage");
                check_images(name, &answered, recorded, &chunks);
            }
            (None, Some(message)) => {
                let (code, text) = refusal(outcome);
                assert_eq!((code.as_str(), text.as_str()), ("failed", message.as_str().expect("message")), "{name}");
                assert!(chunks.is_empty(), "{name}: a refusal sends no image");
            }
            _ => panic!("{name}: neither a result nor an error"),
        }
        assert_eq!(file_names(scratch.path()), vec!["doc.pdf".to_owned()], "{name}: the worker writes nothing beside the PDF");
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_path_outside_the_approved_set_is_refused_by_both_methods() {
    let pool = pool(1);
    let approved = tempfile::tempdir().expect("approved");
    let outside = tempfile::tempdir().expect("outside");
    let file = outside.path().join("x.pdf");
    for (method, params) in [("pdf.render", json!({"path": file})), ("pdf.ocr", json!({"path": file, "pages": [1], "dataDir": approved.path().join("data")}))] {
        let (chunks, outcome) = ask(&pool, method, params, &[approved.path()]).await;
        assert!(chunks.is_empty(), "{method}");
        assert!(matches!(outcome, Err(ExtError::Failed { .. })), "{method}: refused, got {outcome:?}");
    }
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_in_the_middle_of_a_render_frees_the_worker() {
    let golden: Value = serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("office-render-pages/golden.json"))).expect("the golden parses");
    let many = golden["cases"].as_array().expect("cases").iter().find(|case| case["name"] == "twenty-five-pages-into-nine-sheets-of-three").expect("the long case");
    let scratch = tempfile::tempdir().expect("scratch");
    let file = scratch.path().join("doc.pdf");
    std::fs::write(&file, unhex(many["pdf"].as_str().expect("pdf"))).expect("the PDF is written");
    // One worker: the next call is answered only once the cancelled render has left it.
    let pool = pool(1);
    let rendering = pool.call(call("pdf.render", params_of(&file, &many["options"]), &[scratch.path()])).expect("accepted");
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(rendering);
    let (_, answer) = tokio::time::timeout(Duration::from_secs(120), ask(&pool, "echo", json!("after"), &[])).await.expect("the worker is free again");
    assert_eq!(answer.expect("echo answers")["params"], "after");
    assert_eq!(file_names(scratch.path()), vec!["doc.pdf".to_owned()]);
    pool.close().await;
}
