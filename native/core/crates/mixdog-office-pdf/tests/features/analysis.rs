//! Reading a written document back: text search with its geometry, and page images asserted by size, not by pixels.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::adapter::{SnapshotOptions, snapshot_pdf};
use mixdog_office_pdf::search::{SearchOptions, find_pdf_text};
use mixdog_office_pdf::writer::create_pdf;
use mixdog_office_pdf::{LayoutOptions, PdfFormView, PdfSource, RenderPagesOptions, RenderedPages, extract_pdf_text_layout, render_pdf_pages};
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-analysis-{}-{name}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    directory
}

fn document(name: &str, blocks: Vec<Value>) -> PathBuf {
    let path = scratch(name).join(format!("{name}.pdf"));
    create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), &json!({ "blocks": blocks })).expect("written");
    path
}

fn paragraph(text: &str) -> Value {
    json!({ "type": "paragraph", "text": text })
}

fn layout(path: &Path) -> mixdog_office_pdf::PdfLayout {
    extract_pdf_text_layout(&Unlaned, PdfSource::Path(path), &LayoutOptions::default()).expect("a layout")
}

#[test]
fn a_search_finds_text_regardless_of_case_and_reports_its_page_line_and_box() {
    let path =
        document("search", vec![paragraph("Grand total due: 120 USD."), json!({ "type": "pagebreak" }), paragraph("The second page mentions the total once.")]);
    let found = find_pdf_text(&layout(&path), "TOTAL due", &SearchOptions::default()).expect("searched");
    assert_eq!(found.matches.len(), 1);
    let hit = &found.matches[0];
    assert_eq!(hit.page, 1);
    assert_eq!(hit.text.to_lowercase(), "total due");
    assert!(hit.line.contains("Grand total due"), "{}", hit.line);
    assert!(hit.rect.width > 0.0 && hit.rect.height > 0.0);
    let two = find_pdf_text(&layout(&path), "total", &SearchOptions::default()).expect("searched");
    assert_eq!(two.matches.iter().map(|m| m.page).collect::<Vec<_>>(), [1, 2]);
    assert!(!two.truncated);
}

#[test]
fn a_whole_word_search_skips_parts_of_words_and_a_limit_truncates() {
    let path = document("words", vec![paragraph("total totals subtotal total")]);
    let page = layout(&path);
    let whole = find_pdf_text(&page, "total", &SearchOptions { whole_word: true, ..SearchOptions::default() }).expect("searched");
    assert_eq!(whole.matches.len(), 2, "only the two standalone words");
    let any = find_pdf_text(&page, "total", &SearchOptions::default()).expect("searched");
    assert_eq!(any.matches.len(), 4);
    let limited = find_pdf_text(&page, "total", &SearchOptions { limit: 1, ..SearchOptions::default() }).expect("searched");
    assert_eq!(limited.matches.len(), 1);
    assert!(limited.truncated);
}

#[test]
fn an_empty_query_and_a_pattern_that_does_not_parse_are_refused_with_their_reasons() {
    let page = layout(&document("refused", vec![paragraph("some text")]));
    assert_eq!(find_pdf_text(&page, "   ", &SearchOptions::default()).unwrap_err().to_string(), "PDF text search needs query text");
    let broken = find_pdf_text(&page, "(", &SearchOptions { regex: true, ..SearchOptions::default() }).unwrap_err().to_string();
    assert!(broken.starts_with("PDF text search pattern is invalid: "), "{broken}");
}

struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().expect("lock").push(path.to_path_buf());
    }
}

fn render(path: &Path, options: RenderPagesOptions) -> (Result<RenderedPages, mixdog_office_pdf::AnalysisError>, Arc<Noted>) {
    let note = Arc::new(Noted(Mutex::new(Vec::new())));
    let lanes = mixdog_rt::testing::tokens();
    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let note_for_call: Arc<dyn WriteNote> = Arc::clone(&note) as Arc<dyn WriteNote>;
    (runtime.block_on(render_pdf_pages(lanes, Arc::new(Registry::new()), note_for_call, path, options)), note)
}

#[test]
fn a_page_is_drawn_to_the_width_asked_for_in_the_pages_own_proportion_and_written_beside_the_pdf() {
    let path = document("render", vec![paragraph("first"), json!({ "type": "pagebreak" }), paragraph("second")]);
    let (rendered, note) = render(&path, RenderPagesOptions { max_width: 300.0, ..RenderPagesOptions::default() });
    let rendered = rendered.expect("rendered").to_json();
    assert_eq!(rendered["pageCount"], 2);
    let images = rendered["images"].as_array().expect("images");
    assert_eq!(images.len(), 2);
    for (at, image) in images.iter().enumerate() {
        let (width, height) = (image["width"].as_f64().expect("width"), image["height"].as_f64().expect("height"));
        assert!((width - 300.0).abs() <= 1.0, "scaled to the requested width: {width}");
        assert!((height / width - 842.0 / 595.0).abs() < 0.02, "an A4 page keeps its proportion: {width}x{height}");
        assert_eq!(image["page"], at + 1);
    }
    assert_eq!(rendered["visualCoverage"]["total"], 2);
    let stem = path.file_stem().expect("stem").to_string_lossy().into_owned();
    for page in 1..=2 {
        let file = path.with_file_name(format!("{stem}-page-{page}.png"));
        assert!(file.exists(), "{}", file.display());
        assert!(note.0.lock().expect("lock").contains(&file), "the write is reported before it happens");
    }
}

#[test]
fn named_pages_are_the_only_ones_drawn_and_an_in_memory_render_writes_nothing() {
    let path = document("named", vec![paragraph("a"), json!({ "type": "pagebreak" }), paragraph("b"), json!({ "type": "pagebreak" }), paragraph("c")]);
    let (rendered, note) = render(&path, RenderPagesOptions { pages: Some(vec![3.0, 1.0]), write_images: false, ..RenderPagesOptions::default() });
    let rendered = rendered.expect("rendered").to_json();
    let pages: Vec<u64> = rendered["images"].as_array().expect("images").iter().map(|image| image["page"].as_u64().expect("page")).collect();
    assert_eq!(pages, [3, 1], "in the order given");
    assert!(note.0.lock().expect("lock").is_empty());
    let stem = path.file_stem().expect("stem").to_string_lossy().into_owned();
    assert!(!path.with_file_name(format!("{stem}-page-3.png")).exists());
    let (outside, _) = render(&path, RenderPagesOptions { pages: Some(vec![4.0]), ..RenderPagesOptions::default() });
    assert!(outside.is_err(), "a page the document does not have");
}

#[test]
fn a_document_of_more_than_twelve_pages_is_drawn_as_labelled_contact_sheets_beside_the_pdf() {
    let mut blocks = Vec::new();
    for page in 1..=13 {
        if page > 1 {
            blocks.push(json!({ "type": "pagebreak" }));
        }
        blocks.push(paragraph(&format!("page {page}")));
    }
    let path = document("sheets", blocks);
    let (rendered, note) = render(&path, RenderPagesOptions::default());
    let rendered = rendered.expect("rendered").to_json();
    assert_eq!(rendered["pageCount"], 13);
    let images = rendered["images"].as_array().expect("images");
    assert!(!images.is_empty() && images.len() <= 12, "{} sheets", images.len());
    let listed: usize = images.iter().map(|sheet| sheet["pages"].as_array().expect("pages").len()).sum();
    assert_eq!(listed, 13, "every page is on a sheet");
    let stem = path.file_stem().expect("stem").to_string_lossy().into_owned();
    let first = path.with_file_name(format!("{stem}-pages-1-{}.png", images[0]["pages"].as_array().expect("pages").last().expect("a page")));
    assert!(first.exists(), "{}", first.display());
    assert!(note.0.lock().expect("lock").contains(&first), "the write is reported before it happens");
}

#[test]
fn a_snapshot_reads_a_window_of_pages_with_their_text_and_offers_the_next_one() {
    let path = document(
        "snapshot",
        vec![paragraph("First page."), json!({ "type": "pagebreak" }), paragraph("Second page."), json!({ "type": "pagebreak" }), paragraph("Third page.")],
    );
    let options = SnapshotOptions::from_json(&json!({ "paged": true, "limit": 2 }));
    let snapshot = snapshot_pdf(&Unlaned, &path, &options, &PdfFormView).expect("a snapshot");
    assert_eq!(snapshot["pageCount"], json!(3));
    assert_eq!(snapshot["pages"].as_array().map(Vec::len), Some(2));
    assert!(snapshot["pages"][1]["text"].as_str().expect("text").contains("Second page."));
    assert!(snapshot["pages"][0]["width"].is_number());
    assert_eq!(snapshot["pagination"]["returned"], json!(2));
    assert_eq!(snapshot["pagination"]["total"], json!(3));
    assert_eq!(snapshot["pagination"]["nextOffset"], json!(2));
    assert_eq!(snapshot["encrypted"], json!(false));
    assert_eq!(snapshot["ocrRequired"], json!(false));
    let named = SnapshotOptions::from_json(&json!({ "paged": true, "pages": [3] }));
    let third = snapshot_pdf(&Unlaned, &path, &named, &PdfFormView).expect("a snapshot");
    assert_eq!(third["pages"][0]["index"], json!(3));
    assert_eq!(third["pagination"]["nextOffset"], Value::Null);
}
