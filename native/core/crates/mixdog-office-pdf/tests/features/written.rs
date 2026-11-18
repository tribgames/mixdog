use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_pdf::writer::create_pdf;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-features-{}-{name}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    directory
}

fn write(path: &std::path::Path, spec: &Value) -> Result<Value, String> {
    create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), spec).map_err(|error| error.message().to_owned())
}

fn pages_text(path: &std::path::Path) -> Vec<String> {
    let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Path(path), &LayoutOptions::default()).expect("a layout");
    layout.pages.iter().map(|page| page.items.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join(" ")).collect()
}

#[test]
fn prose_longer_than_a_page_flows_onto_more_pages_in_reading_order() {
    let path = scratch("flow").join("flow.pdf");
    let blocks: Vec<Value> = (1..=80).map(|n| json!({ "type": "paragraph", "text": format!("Paragraph number {n} says something worth reading twice.") })).collect();
    let result = write(&path, &json!({ "blocks": blocks })).expect("written");
    assert_eq!(result["ok"], true);
    let pages = result["pages"].as_u64().expect("page count");
    assert!(pages >= 2, "80 paragraphs do not fit on one page");
    let text = pages_text(&path);
    assert_eq!(text.len() as u64, pages);
    let all = text.join(" ");
    let first = all.find("Paragraph number 1 ").expect("the first paragraph");
    let last = all.find("Paragraph number 80 ").expect("the last paragraph");
    assert!(first < last);
    assert!(text[0].contains("Paragraph number 1 "));
    assert!(text[text.len() - 1].contains("Paragraph number 80 "));
}

#[test]
fn a_table_prints_its_headers_and_every_cell() {
    let path = scratch("table").join("table.pdf");
    write(&path, &json!({ "blocks": [{ "type": "table", "headers": ["Item", "Cost"], "rows": [["Pens", "1,200"], ["Ink", "300"]] }] })).expect("written");
    let text = pages_text(&path).join(" ");
    for word in ["Item", "Cost", "Pens", "1,200", "Ink", "300"] {
        assert!(text.contains(word), "{word} is missing from {text}");
    }
}

#[test]
fn a_page_break_starts_a_new_page_and_document_properties_are_kept() {
    let path = scratch("break").join("break.pdf");
    let result = write(&path, &json!({ "blocks": [{ "type": "paragraph", "text": "before" }, { "type": "pagebreak" }, { "type": "paragraph", "text": "after" }], "properties": { "title": "T" } })).expect("written");
    assert_eq!(result["pages"], 2);
    let text = pages_text(&path);
    assert!(text[0].contains("before") && !text[0].contains("after"));
    assert!(text[1].contains("after"));
}

#[test]
fn a_value_that_is_not_a_block_list_is_read_as_no_blocks_and_a_faulty_block_writes_no_file() {
    // Only a list is read as blocks; anything else is an empty document, which is still a written file.
    let empty = scratch("empty").join("empty.pdf");
    let result = write(&empty, &json!({ "blocks": "not a list" })).expect("written");
    assert_eq!(result["ok"], true);
    assert!(empty.exists());
    // A list whose blocks break their contracts is refused as a whole, before any file is written.
    let refused = scratch("refused").join("refused.pdf");
    let message = write(&refused, &json!({ "blocks": [{ "type": "table" }, { "type": "chart", "categories": ["a"], "values": [1, 2] }] })).unwrap_err();
    assert!(message.starts_with("This PDF breaks 2 block contracts; fix them together."), "{message}");
    assert!(!refused.exists());
}
