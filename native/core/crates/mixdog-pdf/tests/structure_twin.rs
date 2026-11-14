//! The structure of a document against what pdf.js answered to the same files (`fixtures/pdf-reader`, recorded by
//! `benchmarks/rust-core/recorders/record-pdf-reader.mjs` from the Node product's own pdf.js 6.4.299).
//!
//! For every recorded file: the exception that stops opening it (name, code and message), or the number of pages and,
//! page by page, the exception of `getPage` or the `view`, the `rotate`, the `userUnit` and the viewport at scale 1
//! (width, height, rotation, offsets, transform). The text of the pages is not compared here: it belongs to the text
//! extraction of the reader.

use std::path::{Path, PathBuf};

use mixdog_pdf::document::{Document, Exception, OpenOptions, wrap_reason};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pdf-reader")
}

fn json(path: PathBuf) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("a recording parses")
}

fn recorded_error(error: &Value) -> Exception {
    Exception {
        name: match error["name"].as_str() {
            Some("PasswordException") => "PasswordException",
            Some("InvalidPDFException") => "InvalidPDFException",
            Some("AbortException") => "AbortException",
            Some("UnknownErrorException") => "UnknownErrorException",
            other => panic!("an exception class the port does not report: {other:?}"),
        },
        code: error["code"].as_u64().map(|c| c as u8),
        message: error["message"].as_str().unwrap_or_default().to_owned(),
    }
}

fn numbers(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .expect("an array of numbers")
        .iter()
        .map(|n| n.as_f64().expect("a number"))
        .collect()
}

/// What differs between the recording `golden` and this port, as short lines.
fn differences(golden: &Value) -> Vec<String> {
    let name = golden["name"].as_str().expect("a name");
    let bytes = mixdog_testkit::read(fixtures().join(golden["file"].as_str().expect("a file")));
    let outcome = &golden["outcome"];
    let opened = Document::open(bytes, &OpenOptions::default());
    let mut found = Vec::new();
    if outcome["ok"] != Value::Bool(true) {
        match opened {
            Ok(_) => found.push(format!("{name}: opened, pdf.js failed")),
            Err(e) if wrap_reason(&e) != recorded_error(&outcome["error"]) => {
                found.push(format!("{name}: {:?}, pdf.js {}", wrap_reason(&e), outcome["error"]));
            }
            Err(_) => {}
        }
        return found;
    }
    let document = match opened {
        Ok(document) => document,
        Err(e) => return vec![format!("{name}: failed to open: {e}")],
    };
    let recorded_pages = outcome["pages"].as_array().expect("pages");
    if Some(document.num_pages()) != outcome["numPages"].as_i64() {
        found.push(format!(
            "{name}: {} pages, pdf.js {}",
            document.num_pages(),
            outcome["numPages"]
        ));
        return found;
    }
    for recorded in recorded_pages {
        let number = recorded["number"].as_u64().expect("a page number") as usize;
        let page = document.page(number - 1);
        if !recorded["error"].is_null() {
            match page {
                Ok(_) => found.push(format!("{name} page {number}: read, pdf.js failed")),
                Err(e) if wrap_reason(&e) != recorded_error(&recorded["error"]) => {
                    found.push(format!("{name} page {number}: {:?}", wrap_reason(&e)));
                }
                Err(_) => {}
            }
            continue;
        }
        let page = match page {
            Ok(page) => page,
            Err(e) => {
                found.push(format!("{name} page {number}: failed: {e}"));
                continue;
            }
        };
        let viewport = page.viewport(1.0);
        let recorded_viewport = &recorded["viewport"];
        let mut check = |what: &str, ours: Vec<f64>, theirs: Vec<f64>| {
            if ours != theirs {
                found.push(format!("{name} page {number} {what}: {ours:?}, pdf.js {theirs:?}"));
            }
        };
        check("view", page.view.to_vec(), numbers(&recorded["view"]));
        check("rotate", vec![f64::from(page.rotate)], vec![recorded["rotate"].as_f64().expect("rotate")]);
        check("userUnit", vec![page.user_unit], vec![recorded["userUnit"].as_f64().expect("userUnit")]);
        check(
            "viewport",
            vec![
                viewport.width,
                viewport.height,
                f64::from(viewport.rotation),
                viewport.offset_x,
                viewport.offset_y,
            ],
            ["width", "height", "rotation", "offsetX", "offsetY"]
                .iter()
                .map(|key| recorded_viewport[*key].as_f64().expect("a viewport number"))
                .collect(),
        );
        check("transform", viewport.transform.to_vec(), numbers(&recorded_viewport["transform"]));
    }
    found
}

#[test]
fn every_recorded_document_opens_and_reads_as_in_pdf_js() {
    let manifest = json(fixtures().join("MANIFEST.json"));
    let cases = manifest["cases"].as_array().expect("the cases");
    assert!(cases.len() >= 74, "the recording lost cases: {}", cases.len());
    let mut found = Vec::new();
    for case in cases {
        let golden = json(fixtures().join("goldens").join(format!("{}.json", case.as_str().expect("a case name"))));
        found.extend(differences(&golden));
    }
    found.truncate(20);
    assert!(found.is_empty(), "differences from pdf.js:\n{}", found.join("\n"));
}

#[test]
fn a_file_that_is_not_a_pdf_fails_as_invalid() {
    let error = Document::open(b"just some text, not a document".to_vec(), &OpenOptions::default())
        .err()
        .expect("text is no PDF");
    assert_eq!(wrap_reason(&error).name, "InvalidPDFException");
    assert_eq!(wrap_reason(&error).message, "Invalid PDF structure.");
}

#[test]
fn an_empty_file_fails_with_the_size_message() {
    let error = Document::open(Vec::new(), &OpenOptions::default()).err().expect("empty");
    assert_eq!(
        wrap_reason(&error),
        Exception {
            name: "InvalidPDFException",
            code: None,
            message: "The PDF file is empty, i.e. its size is zero bytes.".to_owned(),
        }
    );
}
