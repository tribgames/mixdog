//! Replayed against Node's `renderPdfPages` (`fixtures/office-render-pages/golden.json`); the pixels are held to it by
//! `mixdog-office-pdf`'s own twin test. Recognition downloads its engine on first use, so only its path guard is exercised.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::{ExtCall, ExtError, ExtFrame, ExtPool};
use mixdog_exthost::{ExtHostConfig, ExtHostPool, RenderBrowserConfig};
use mixdog_protocol::ThreadId;
use serde_json::{Value, json};

const PNG_MAGIC: [u8; 4] = [0x89, 0x50, 0x4e, 0x47];

fn pool(workers: usize) -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(mixdog_testkit::bin_exe!("ext_worker_dev")),
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

fn refusal(outcome: Result<Value, ExtError>) -> (String, String) {
    match outcome {
        Err(ExtError::Failed { code, message }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).expect("the folder lists").map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
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

/// A PDF of `pages` pages of 200x100 points, each with one filled rectangle.
fn pdf_of(pages: usize) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    let kids: Vec<String> = (0..pages).map(|page| format!("{} 0 R", 3 + 2 * page)).collect();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_owned());
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", kids.join(" ")));
    for page in 0..pages {
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents {} 0 R >>", 4 + 2 * page));
        let content = "0 0 1 rg 20 20 100 50 re f";
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
    }
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (at, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", at + 1));
    }
    let xref = out.len();
    out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
    for offset in offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1));
    out.into_bytes()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pdf_is_rendered_to_png_images_that_travel_as_chunks_and_nothing_is_written_beside_it() {
    let pool = pool(1);
    let scratch = tempfile::tempdir().expect("scratch");
    let file = scratch.path().join("doc.pdf");
    std::fs::write(&file, pdf_of(3)).expect("the PDF is written");
    let (chunks, outcome) = ask(&pool, "pdf.render", json!({"path": file}), &[scratch.path()]).await;
    let answered = outcome.expect("the render answers");
    assert_eq!(answered["pageCount"], 3);
    let images = answered["images"].as_array().expect("images");
    assert!(!images.is_empty());
    let sent = chunks.concat();
    let counted: u64 = images.iter().map(|entry| entry["bytes"].as_u64().expect("bytes")).sum();
    assert_eq!(sent.len() as u64, counted, "the chunks are the images' bytes, nothing else");
    let mut offset = 0;
    for entry in images {
        assert_eq!(entry["mimeType"], "image/png");
        assert!(entry.get("data").is_none(), "an entry carries bytes, not data");
        assert_eq!(sent[offset..offset + 4], PNG_MAGIC, "each image starts where the one before ends");
        offset += entry["bytes"].as_u64().expect("bytes") as usize;
    }
    assert_eq!(file_names(scratch.path()), vec!["doc.pdf".to_owned()], "the worker writes nothing beside the PDF");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bytes_that_are_not_a_pdf_are_refused_without_an_image() {
    let pool = pool(1);
    let scratch = tempfile::tempdir().expect("scratch");
    let file = scratch.path().join("doc.pdf");
    std::fs::write(&file, b"this is not a pdf").expect("the file is written");
    let (chunks, outcome) = ask(&pool, "pdf.render", json!({"path": file}), &[scratch.path()]).await;
    let (code, _) = refusal(outcome);
    assert_eq!(code, "failed");
    assert!(chunks.is_empty(), "a refusal sends no image");
    assert_eq!(file_names(scratch.path()), vec!["doc.pdf".to_owned()]);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_in_the_middle_of_a_render_frees_the_worker() {
    let scratch = tempfile::tempdir().expect("scratch");
    let file = scratch.path().join("doc.pdf");
    std::fs::write(&file, pdf_of(25)).expect("the PDF is written");
    // One worker: the next call is answered only once the cancelled render has left it.
    let pool = pool(1);
    let rendering = pool.call(call("pdf.render", json!({"path": file}), &[scratch.path()])).expect("accepted");
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(rendering);
    let (_, answer) = tokio::time::timeout(Duration::from_secs(120), ask(&pool, "echo", json!("after"), &[])).await.expect("the worker is free again");
    assert_eq!(answer.expect("echo answers")["params"], "after");
    assert_eq!(file_names(scratch.path()), vec!["doc.pdf".to_owned()]);
    pool.close().await;
}
