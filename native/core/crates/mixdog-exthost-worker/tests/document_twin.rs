//! The `document.*` methods the real worker serves, driven through the pool over `ext_worker_dev`: the cases of
//! `src/ext-host/document.e2e.test.mjs` that do not need the rasteriser (a PDF previews in place; the root and the type are
//! guarded; the page, width and password checks), with the answers Node's handlers gave. The rasterised pages, the pin of a
//! thread that unlocked a document and the LibreOffice probe with its candidates seam are tested beside the handlers
//! (`src/methods/document.rs`, `src/methods/soffice.rs`), where the engine and the probe's runner are scripted: a test here
//! must not start a LibreOffice or a package manager.

use std::path::{Path, PathBuf};

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::{ExtCall, ExtError, ExtFrame, ExtPool};
use mixdog_exthost::{ExtHostConfig, ExtHostPool, RenderBrowserConfig};
use mixdog_protocol::ThreadId;
use serde_json::{Value, json};

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
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-document-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

async fn ask(pool: &ExtHostPool, method: &str, params: Value, approved: &[&Path]) -> Result<Value, ExtError> {
    let mut stream = pool
        .call(ExtCall {
            thread: ThreadId::from("document-twin"),
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

#[test]
fn the_worker_serves_the_four_document_methods() {
    let names = mixdog_exthost_worker::native_methods();
    for method in ["document.preview", "document.previewPages", "document.libreOfficeStatus", "document.installLibreOffice"] {
        assert!(names.contains(&method), "{method}");
    }
}

#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "test setup builds fixture trees")]
async fn a_pdf_previews_in_place_and_the_root_and_type_are_guarded() {
    let root = tempfile::tempdir().expect("root");
    let outside = tempfile::tempdir().expect("outside");
    let base = root.path();
    std::fs::write(base.join("a.pdf"), b"%PDF-1.4\n").expect("pdf");
    std::fs::write(base.join("notes.txt"), b"plain").expect("text");
    let pool = pool();
    let root_text = base.to_string_lossy().into_owned();
    let call = |method: &'static str, params: Value, paths: Vec<&Path>| {
        let pool = &pool;
        let root_text = root_text.clone();
        let paths: Vec<PathBuf> = paths.into_iter().map(Path::to_path_buf).collect();
        async move {
            let mut full = json!({"root": root_text, "cacheRoot": base.join(".cache").to_string_lossy()});
            full.as_object_mut().unwrap().extend(params.as_object().unwrap().clone());
            let approved: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
            ask(pool, method, full, &approved).await
        }
    };

    let preview = call("document.preview", json!({"rel": "a.pdf"}), vec![base]).await.expect("preview");
    assert_eq!(preview["format"], "pdf");
    assert_eq!(preview["cached"], true);
    assert_eq!(preview["size"], 9);
    assert!(preview["path"].as_str().unwrap().ends_with("a.pdf"));
    assert!(preview["mtimeMs"].as_f64().unwrap() > 0.0);

    let too_many = call("document.previewPages", json!({"rel": "a.pdf", "options": {"pages": [1, 2, 3, 4, 5]}}), vec![base]).await;
    assert_eq!(refused(too_many), ("invalid_params".to_owned(), "A document preview accepts at most 4 pages per request.".to_owned()));
    let no_pages = call("document.previewPages", json!({"rel": "a.pdf", "options": {"pages": [0]}}), vec![base]).await;
    assert_eq!(refused(no_pages).0, "invalid_params");
    let too_long = call("document.previewPages", json!({"rel": "a.pdf", "options": {"password": "x".repeat(256)}}), vec![base]).await;
    assert_eq!(refused(too_long).0, "invalid_params");

    let text = call("document.preview", json!({"rel": "notes.txt"}), vec![base]).await;
    assert_eq!(
        refused(text),
        ("no_preview_for_type".to_owned(), "This file type has no built-in document preview.".to_owned())
    );
    let escape = call("document.preview", json!({"rel": "../escape.pdf"}), vec![base]).await;
    assert_eq!(refused(escape).0, "path_outside_project");
    let unapproved = call("document.preview", json!({"rel": "a.pdf"}), vec![outside.path()]).await;
    assert_eq!(refused(unapproved).0, "path_not_approved");
    let directory = call("document.preview", json!({"rel": "."}), vec![base]).await;
    assert!(directory.is_err(), "a directory is no document");
    let not_a_file = {
        std::fs::create_dir(base.join("folder.pdf")).expect("folder");
        call("document.preview", json!({"rel": "folder.pdf"}), vec![base]).await
    };
    assert_eq!(refused(not_a_file), ("not_a_file".to_owned(), "Not a file.".to_owned()));
}

/// The page of a PDF rasterised by the office PDF backend the worker registers (no LibreOffice or Office is started: the
/// document is a PDF), answered in the shape of Node's `document.previewPages`.
#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "test setup builds fixture trees")]
async fn a_pdf_page_is_rasterised_by_the_registered_engine() {
    const PDF: &str = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 49 >>\nstream\n0.9 g 0 0 595 842 re f 0.2 g 59.5 421 476 12 re f\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000219 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n318\n%%EOF\n";
    let root = tempfile::tempdir().expect("root");
    let base = root.path();
    std::fs::write(base.join("page.pdf"), PDF).expect("pdf");
    let pool = pool();
    let params = json!({
        "root": base.to_string_lossy(),
        "rel": "page.pdf",
        "cacheRoot": base.join(".cache").to_string_lossy(),
        "options": {"pages": [1], "maxWidth": 400},
    });
    let answer = ask(&pool, "document.previewPages", params, &[base]).await.expect("the page is rendered");
    assert_eq!(answer["pageCount"], 1);
    let pages = answer["pages"].as_array().expect("pages");
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0]["page"], 1);
    assert_eq!(pages[0]["mime"], "image/png");
    assert_eq!(pages[0]["width"], 401, "Math.ceil(595 * (400 / 595)) is 401 in doubles, as in Node");
    assert_eq!(pages[0]["height"], 567);
    let data = pages[0]["base64"].as_str().expect("base64");
    assert!(data.starts_with("iVBORw0KGgo"), "a PNG");
}
