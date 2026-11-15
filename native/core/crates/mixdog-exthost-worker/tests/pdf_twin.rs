//! The PDF methods the real worker serves, driven through the pool over `ext_worker_dev` and replayed against what Node's
//! worker answered: `media.pdfText` over `fixtures/tools/media-text/pdf.json`, `media.pdfCounts` over `pdf-counts.json`, the
//! intake scenarios of `fixtures/pdf-intake` through `pdf.inspect`, and the case of `src/ext-host/pdf.e2e.test.mjs` that
//! concerns `pdf.inspect` (the render and OCR cases belong to their own methods). The read tool's golden of a damaged PDF
//! (`fixtures/tools/read/read-pdf-corrupt.json`) shows the message `pdf.inspect` must answer.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::{ExtCall, ExtError, ExtFrame, ExtPool};
use mixdog_exthost::{ExtHostConfig, ExtHostPool, RenderBrowserConfig};
use mixdog_protocol::ThreadId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn fixture(relative: &str) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join(relative))).expect("the fixture parses")
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
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-pdf-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

async fn ask(pool: &ExtHostPool, method: &str, params: Value, approved: &[&Path]) -> Result<Value, ExtError> {
    let mut stream = pool
        .call(ExtCall {
            thread: ThreadId::from("pdf-twin"),
            method: method.to_owned(),
            params,
            paths: approved.iter().map(|path| AbsPath::new(path.to_path_buf()).expect("an absolute path")).collect(),
        })
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

/// The recording of a text: the text itself, or (for one too large to keep) its size, hash and end.
fn matches_recording(what: &str, actual: &str, case: &Value) {
    match case.get("text") {
        Some(text) => assert_eq!(actual, text.as_str().unwrap(), "{what}"),
        None => {
            assert_eq!(actual.len() as u64, case["textBytes"].as_u64().unwrap(), "{what}: byte count");
            let hash: String = Sha256::digest(actual.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(hash, case["textSha256"].as_str().unwrap(), "{what}: sha256");
            let tail: Vec<char> = actual.chars().rev().take(80).collect();
            let tail: String = tail.into_iter().rev().collect();
            assert_eq!(tail, case["textTail"].as_str().unwrap(), "{what}: last 80 characters");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attached_pdfs_answer_the_media_text_set() {
    let pool = pool();
    let cases = fixture("tools/media-text/pdf.json");
    assert!(cases.as_array().unwrap().len() >= 5);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let answer = ask(&pool, "media.pdfText", json!({"data": case["dataBase64"]}), &[])
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        matches_recording(name, answer["text"].as_str().unwrap_or_else(|| panic!("{name}: no text")), case);
        // The second ask is the speed cache's: the same answer.
        let again = ask(&pool, "media.pdfText", json!({"data": case["dataBase64"]}), &[]).await.unwrap();
        assert_eq!(again, answer, "{name}: from the memo");
    }
    let (code, message) = refused(ask(&pool, "media.pdfText", json!({"data": 7}), &[]).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attached_pdfs_answer_the_counts_set() {
    let pool = pool();
    let cases = fixture("tools/media-text/pdf-counts.json");
    assert!(cases.as_array().unwrap().len() >= 5);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let answer = ask(&pool, "media.pdfCounts", json!({"data": case["dataBase64"]}), &[])
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        match case.get("counts") {
            Some(counts) => assert_eq!(&answer["counts"], counts, "{name}"),
            None => assert_eq!(&answer["rejected"], &case["rejected"], "{name}"),
        }
    }
    let (code, message) = refused(ask(&pool, "media.pdfCounts", json!({}), &[]).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    pool.close().await;
}

/// The case of `pdf.e2e.test.mjs` for `pdf.inspect`: the page count and the text of a file inside the approved paths, and a
/// path outside them refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pdf_inspect_answers_over_the_worker_protocol() {
    let pool = pool();
    let root = tempfile::tempdir().expect("scratch folder");
    let two_pages = fixture("tools/media-text/pdf.json");
    let data = two_pages[0]["dataBase64"].as_str().unwrap();
    let file = root.path().join("t.pdf");
    mixdog_testkit::write(&file, STANDARD.decode(data).unwrap());
    let path = file.to_string_lossy().into_owned();

    let inspected = ask(&pool, "pdf.inspect", json!({"path": path, "extractText": true}), &[root.path()]).await.unwrap();
    assert_eq!(inspected["pageCount"], 2);
    assert_eq!(inspected["truncated"], false);
    assert_eq!(inspected["text"], two_pages[0]["text"]);
    assert_eq!(inspected["pages"], json!([{"page": 1, "text": "Hello media text"}, {"page": 2, "text": "Second page"}]));

    let counted = ask(&pool, "pdf.inspect", json!({"path": path}), &[root.path()]).await.unwrap();
    assert_eq!(counted, json!({"pageCount": 2, "text": "", "truncated": false}));
    let measured = ask(&pool, "pdf.inspect", json!({"path": path, "measureText": true, "maxPages": "unlimited"}), &[root.path()]).await.unwrap();
    assert_eq!(measured["pageCount"], 2);
    let ranged = ask(&pool, "pdf.inspect", json!({"path": path, "extractText": true, "pageRange": {"from": 2, "to": 2}}), &[root.path()])
        .await
        .unwrap();
    assert_eq!(ranged["text"], "--- Page 2 ---\nSecond page");

    let outside = tempfile::tempdir().expect("another folder");
    let (code, _) = refused(ask(&pool, "pdf.inspect", json!({"path": outside.path().join("x.pdf").to_string_lossy()}), &[root.path()]).await);
    assert_eq!(code, "path_not_approved", "a path outside the approved set is refused");
    let (code, message) = refused(ask(&pool, "pdf.inspect", json!({"path": root.path().join("missing.pdf").to_string_lossy()}), &[root.path()]).await);
    assert_eq!(code, "ENOENT", "{message}");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pdf_inspect_answers_the_errors_the_intake_and_the_read_tool_recorded() {
    let pool = pool();
    let root = tempfile::tempdir().expect("scratch folder");
    let put = |name: &str, scenario: &str| {
        let recording = fixture(&format!("pdf-intake/{scenario}.json"));
        let file = root.path().join(name);
        mixdog_testkit::write(&file, STANDARD.decode(recording["pdfBase64"].as_str().unwrap()).unwrap());
        file.to_string_lossy().into_owned()
    };
    let encrypted = put("encrypted.pdf", "encrypted");
    let damaged = put("damaged.pdf", "damaged");
    let long = put("long.pdf", "pages-101");

    let (code, message) = refused(ask(&pool, "pdf.inspect", json!({"path": encrypted, "maxPages": "unlimited"}), &[root.path()]).await);
    assert_eq!((code.as_str(), message.as_str()), ("1", "No password given"));
    let (code, message) = refused(ask(&pool, "pdf.inspect", json!({"path": encrypted, "password": "wrong", "maxPages": "unlimited"}), &[root.path()]).await);
    assert_eq!((code.as_str(), message.as_str()), ("2", "Incorrect Password"));
    let (code, message) = refused(ask(&pool, "pdf.inspect", json!({"path": damaged}), &[root.path()]).await);
    assert_eq!((code.as_str(), message.as_str()), ("failed", "Invalid PDF structure."));
    let corrupt = fixture("tools/read/read-pdf-corrupt.json");
    assert!(corrupt["text"].as_str().unwrap().contains(&format!("({message})")), "the read tool shows this message");
    let (code, message) = refused(ask(&pool, "pdf.inspect", json!({"path": long}), &[root.path()]).await);
    assert_eq!(
        (code.as_str(), message.as_str()),
        ("failed", "PDF has 101 pages; maximum supported attachment is 100 pages")
    );
    let unlimited = ask(&pool, "pdf.inspect", json!({"path": long, "maxPages": "unlimited"}), &[root.path()]).await.unwrap();
    assert_eq!(unlimited["pageCount"], 101);
    pool.close().await;
}
