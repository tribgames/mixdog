//! `inspect_pdf_buffer` against what the Node product answered.
//!
//! The intake recordings (`fixtures/pdf-intake`, from `record-pdf-intake.mjs`) give the text-layer counts the intake
//! prices a PDF with, and the errors pdf.js raised for an encrypted and a damaged file; the size scenarios are one-page
//! files padded after their end. The reader recordings (`fixtures/pdf-reader`) give every text item pdf.js returned; the
//! page text of the extraction of each recorded file must be what `pageBodyText` makes of those items, and the page count
//! must be the recorded one.

use std::path::{Path, PathBuf};

use mixdog_pdf::inspect::{
    Detail, InspectError, InspectOptions, MAX_PDF_PAGES, PageRange, Run, inspect_pdf_buffer, page_body_text,
};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn json(path: PathBuf) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("a recording parses")
}

fn unbase64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut bits, mut have) = (0u32, 0);
    for c in text.bytes().take_while(|c| *c != b'=') {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("not base64: {other}"),
        };
        bits = (bits << 6) | u32::from(value);
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
            bits &= (1 << have) - 1;
        }
    }
    out
}

/// The file of an intake scenario: its bytes, or the one-page file padded with spaces to the recorded size.
fn intake_bytes(scenario: &Value) -> Vec<u8> {
    match scenario["pdfBase64"].as_str() {
        Some(data) => unbase64(data),
        None => {
            let mut bytes = unbase64(scenario["padFrom"].as_str().expect("a file to pad"));
            bytes.resize(scenario["sizeBytes"].as_u64().expect("a size") as usize, 0x20);
            bytes
        }
    }
}

/// The options the intake measures with (`store.mjs`): the page limit for a provider that takes the PDF natively, none for one
/// that takes its text.
fn measuring(native: bool) -> InspectOptions {
    InspectOptions { measure_text: true, max_pages: native.then_some(MAX_PDF_PAGES), ..InspectOptions::default() }
}

#[test]
fn the_intake_scenarios_count_what_the_intake_recorded() {
    let manifest = json(fixtures().join("pdf-intake/MANIFEST.json"));
    let mut replayed = 0;
    for scenario in manifest["scenarios"].as_array().expect("the scenarios") {
        let name = scenario.as_str().expect("a name");
        let recording = json(fixtures().join(format!("pdf-intake/{name}.json")));
        let native = recording["nativePdf"] == Value::Bool(true);
        let outcome = inspect_pdf_buffer(&intake_bytes(&recording), &measuring(native));
        if name == "size-over-limit" {
            // The intake refuses a PDF over 20 MiB by its size before inspecting it; the bytes themselves read.
            assert_eq!(outcome.expect("one space more than the file at the limit").page_count, 1, "{name}");
            replayed += 1;
            continue;
        }
        if let Some(recorded) = recording.get("error") {
            let failure = outcome.expect_err(name);
            assert_eq!(failure.message(), recorded["message"].as_str().expect("a message"), "{name}: message");
            let code = recorded["code"].as_u64().map_or_else(|| "failed".to_owned(), |code| code.to_string());
            assert_eq!(failure.code(), code, "{name}: code");
            replayed += 1;
            continue;
        }
        let file = &recording["prompt"][1];
        let inspection = outcome.unwrap_or_else(|failure| panic!("{name}: {failure}"));
        assert_eq!(inspection.page_count, file["pageCount"].as_u64().unwrap(), "{name}: pages");
        let Detail::Counts { text_pages, text_chars } = inspection.detail else { panic!("{name}: counts") };
        assert_eq!(text_pages, file["textPages"].as_u64().unwrap(), "{name}: text pages");
        assert_eq!(text_chars, file["textChars"].as_u64().unwrap(), "{name}: text chars");
        replayed += 1;
    }
    assert_eq!(replayed, 8);
}

#[test]
fn the_page_limit_is_a_range_error_unless_there_is_none() {
    let bytes = intake_bytes(&json(fixtures().join("pdf-intake/pages-101.json")));
    let limited = inspect_pdf_buffer(&bytes, &InspectOptions::default()).expect_err("101 pages are over the limit");
    assert_eq!(limited, InspectError::TooManyPages { count: 101, limit: 100 });
    assert_eq!(limited.message(), "PDF has 101 pages; maximum supported attachment is 100 pages");
    let unlimited = inspect_pdf_buffer(&bytes, &InspectOptions { max_pages: None, ..InspectOptions::default() }).expect("no limit");
    assert_eq!(unlimited.page_count, 101);
    let hundred = intake_bytes(&json(fixtures().join("pdf-intake/pages-100.json")));
    let at_limit = inspect_pdf_buffer(&hundred, &InspectOptions::default()).expect("100 pages");
    assert_eq!(at_limit.page_count, 100);
    assert_eq!(at_limit.detail, Detail::Nothing);
}

#[test]
fn the_extraction_is_blocks_of_pages_cut_to_the_budget() {
    let bytes = intake_bytes(&json(fixtures().join("pdf-intake/pages-101-text.json")));
    let text = |options: InspectOptions| match inspect_pdf_buffer(&bytes, &options).expect("an inspection").detail {
        Detail::Text { text, truncated, pages } => (text, truncated, pages),
        other => panic!("not a text: {other:?}"),
    };
    let range = Some(PageRange { from: 2.0, to: 3.0 });
    let (whole, truncated, pages) =
        text(InspectOptions { extract_text: true, max_pages: None, page_range: range, ..InspectOptions::default() });
    assert!(!truncated);
    assert_eq!(pages.iter().map(|page| page.page).collect::<Vec<_>>(), [2, 3]);
    assert!(whole.starts_with("--- Page 2 ---\n"));
    assert!(whole.contains("\n\n--- Page 3 ---\n"));
    assert!(!whole.contains("--- Page 4 ---"));
    let (cut, truncated, _) =
        text(InspectOptions { extract_text: true, max_pages: None, max_output_bytes: 40.0, ..InspectOptions::default() });
    assert!(truncated);
    assert!(cut.ends_with("\n\n... [PDF text truncated to the prompt input budget]"));
}

#[test]
fn a_scan_has_blocks_with_the_no_text_line() {
    let bytes = intake_bytes(&json(fixtures().join("pdf-intake/scanned-text-only.json")));
    let options = InspectOptions { extract_text: true, ..InspectOptions::default() };
    let Detail::Text { text, truncated, pages } = inspect_pdf_buffer(&bytes, &options).expect("an inspection").detail else {
        panic!("not a text")
    };
    assert!(!truncated);
    assert_eq!(pages.len(), 3);
    assert!(text.contains("--- Page 1 ---\n"));
}

#[test]
fn the_page_texts_of_every_recorded_file_are_the_page_body_of_pdfjs_items() {
    let manifest = json(fixtures().join("pdf-reader/MANIFEST.json"));
    let (mut files, mut pages) = (0usize, 0usize);
    let mut differences: Vec<String> = Vec::new();
    for case in manifest["cases"].as_array().expect("the cases") {
        let golden = json(fixtures().join(format!("pdf-reader/goldens/{}.json", case.as_str().expect("a case"))));
        let outcome = match golden["withReadableDataUrls"].get("outcome") {
            Some(readable) if golden["withReadableDataUrls"]["sameAsReference"] == Value::Bool(false) => readable,
            _ => &golden["outcome"],
        };
        if outcome["ok"] != Value::Bool(true) {
            continue;
        }
        let file = golden["file"].as_str().expect("a file");
        let bytes = mixdog_testkit::read(fixtures().join("pdf-reader").join(file));
        let options = InspectOptions {
            extract_text: true,
            max_pages: None,
            max_output_bytes: f64::INFINITY,
            ..InspectOptions::default()
        };
        // A page pdf.js could not load makes `getPage` reject, and with it the whole inspection: the failure is the page's.
        if let Some(message) = outcome["pages"].as_array().and_then(|list| list.iter().find_map(|page| page["error"]["message"].as_str())) {
            match inspect_pdf_buffer(&bytes, &options) {
                Err(failure) if failure.to_string() == message => files += 1,
                Err(failure) => differences.push(format!("{file}: failed with {failure}, pdf.js has {message}")),
                Ok(_) => differences.push(format!("{file}: read, pdf.js fails with {message}")),
            }
            continue;
        }
        let inspection = match inspect_pdf_buffer(&bytes, &options) {
            Ok(inspection) => inspection,
            Err(failure) => {
                differences.push(format!("{file}: {failure}"));
                continue;
            }
        };
        files += 1;
        let recorded = outcome["pages"].as_array().expect("the pages");
        if inspection.page_count != outcome["numPages"].as_u64().unwrap_or(0) {
            differences.push(format!("{file}: {} pages, pdf.js {}", inspection.page_count, outcome["numPages"]));
        }
        let Detail::Text { pages: ours, .. } = inspection.detail else { panic!("text") };
        for (page, theirs) in ours.iter().zip(recorded) {
            pages += 1;
            let items = theirs["text"]["items"].as_array().expect("items");
            let strings: Vec<&str> = items.iter().map(|item| item["str"].as_str().unwrap_or("")).collect();
            let runs = items.iter().zip(&strings).map(|(item, text)| {
                let number = |index: usize| item["transform"][index].as_f64().unwrap_or(f64::NAN);
                Run {
                    text,
                    transform: [number(0), number(1), number(2), number(3), number(4), number(5)],
                    width: item["width"].as_f64().unwrap_or(f64::NAN),
                    has_eol: item["hasEOL"] == Value::Bool(true),
                }
            });
            if page.text != page_body_text(runs) {
                differences.push(format!("{file} page {}: text differs from the body of pdf.js's items", page.page));
            }
        }
    }
    println!("{files} files, {pages} pages compared");
    assert!(differences.is_empty(), "{}", differences.join("\n"));
    assert!(files > 20);
}
