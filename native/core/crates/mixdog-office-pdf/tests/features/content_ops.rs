//! Content operations applied to a written document: they change what a reader finds, and a batch that fails changes nothing.

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_pdf::writer::create_pdf;
use mixdog_office_pdf::{ContentOperations, LayoutOptions, PdfSource, apply_batch, extract_pdf_text_layout};
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

fn content() -> ContentOperations {
    ContentOperations::new(FontEnv::default(), SvgFonts::none(), None, None)
}

fn three_pages(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-ops-{}-{name}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let path = directory.join("doc.pdf");
    let blocks = json!([
        { "type": "paragraph", "text": "Section 1 opens the report." },
        { "type": "pagebreak" },
        { "type": "paragraph", "text": "Section 2 follows." },
        { "type": "pagebreak" },
        { "type": "paragraph", "text": "Section 3 closes it." }
    ]);
    create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), &json!({ "blocks": blocks })).expect("written");
    path
}

fn words(path: &std::path::Path) -> String {
    let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Path(path), &LayoutOptions::default()).expect("a layout");
    layout.pages.iter().flat_map(|page| page.items.iter().map(|item| item.text.as_str())).collect::<Vec<_>>().join(" ")
}

fn run(path: &std::path::Path, operations: &[Value]) -> Result<Vec<Value>, String> {
    apply_batch(&Unlaned, &NoWriteNote, path, operations, &content()).map_err(|error| error.to_string())
}

#[test]
fn text_added_to_a_page_is_found_by_the_next_reader() {
    let path = three_pages("add");
    assert!(!words(&path).contains("APPROVED"));
    let rows = run(&path, &[json!({ "op": "add_text", "text": "APPROVED", "page": 1, "x": 72, "y": 72, "size": 14 })]).expect("applied");
    assert_eq!(rows.len(), 1, "one result row per operation");
    assert!(words(&path).contains("APPROVED"));
    assert!(words(&path).contains("Section 1"), "what was there stays");
}

#[test]
fn a_highlight_changes_the_file_and_leaves_the_text_readable() {
    let path = three_pages("mark");
    let before = mixdog_testkit::read(&path);
    run(&path, &[json!({ "op": "highlight", "find": "Section 2" })]).expect("applied");
    assert_ne!(mixdog_testkit::read(&path), before);
    assert!(words(&path).contains("Section 2 follows"));
}

#[test]
fn a_highlight_that_finds_nothing_names_the_pages_it_looked_at() {
    let path = three_pages("none");
    let refused = run(&path, &[json!({ "op": "highlight", "find": "nowhere", "pages": [1, 3] })]).unwrap_err();
    assert_eq!(refused, "highlight found no text matching \"nowhere\" in pages 1, 3; check the snapshot text or pass page, x, y, width, height");
}

#[test]
fn a_batch_that_fails_midway_leaves_the_document_as_it_was() {
    let path = three_pages("atomic");
    let before = mixdog_testkit::read(&path);
    let operations = [json!({ "op": "highlight", "find": "Section 1" }), json!({ "op": "highlight", "find": "text that is not there" })];
    assert!(run(&path, &operations).is_err());
    assert!(mixdog_testkit::read(&path) == before, "the first operation was not kept");
}
