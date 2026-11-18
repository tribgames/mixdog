//! The intake inspection of a PDF: the page limit, the count of pages that carry a text layer, and the text extraction
//! in blocks of pages cut to the output budget.

use mixdog_pdf::inspect::{Detail, InspectError, InspectOptions, MAX_PDF_PAGES, PageRange, inspect_pdf_buffer};

use crate::read_support::pages_of;

const SUFFIX: &str = "\n\n... [PDF text truncated to the prompt input budget]";

fn text_options() -> InspectOptions {
    InspectOptions { extract_text: true, ..InspectOptions::default() }
}

fn three_pages() -> Vec<u8> {
    pages_of(&[
        "BT /F1 12 Tf 20 100 Td (Hello wonderful world) Tj ET",
        "BT /F1 12 Tf 20 100 Td (line one) Tj 0 -14 Td (line two) Tj ET",
        "0 0 10 10 re f",
    ])
}

fn extraction(bytes: &[u8], options: &InspectOptions) -> (String, bool, Vec<(u64, String)>) {
    match inspect_pdf_buffer(bytes, options).expect("an inspection").detail {
        Detail::Text { text, truncated, pages } => {
            (text, truncated, pages.into_iter().map(|p| (p.page, p.text)).collect())
        }
        other => panic!("not a text: {other:?}"),
    }
}

#[test]
fn a_document_over_the_page_limit_is_refused_unless_there_is_no_limit() {
    let contents = vec![""; 101];
    let bytes = pages_of(&contents);
    let error = inspect_pdf_buffer(&bytes, &InspectOptions::default()).expect_err("101 pages are over the limit");
    assert_eq!(error, InspectError::TooManyPages { count: 101, limit: MAX_PDF_PAGES });
    assert_eq!(error.message(), "PDF has 101 pages; maximum supported attachment is 100 pages");
    assert_eq!(error.code(), "failed");

    let unlimited = InspectOptions { max_pages: None, ..InspectOptions::default() };
    assert_eq!(inspect_pdf_buffer(&bytes, &unlimited).expect("no limit").page_count, 101);

    let at_limit = inspect_pdf_buffer(&pages_of(&vec![""; 100]), &InspectOptions::default()).expect("100 pages");
    assert_eq!((at_limit.page_count, at_limit.detail), (100, Detail::Nothing));
}

#[test]
fn only_pages_with_sixteen_visible_characters_count_as_a_text_layer() {
    let options = InspectOptions { measure_text: true, ..InspectOptions::default() };
    let inspection = inspect_pdf_buffer(&three_pages(), &options).expect("an inspection");
    // Page 1 has 19 visible characters and 21 in all; page 2 has 14 visible; page 3 draws no text.
    assert_eq!(inspection.page_count, 3);
    assert_eq!(inspection.detail, Detail::Counts { text_pages: 1, text_chars: 21 });
}

#[test]
fn the_extraction_is_one_block_per_page_with_a_note_for_a_page_without_text() {
    let (text, truncated, pages) = extraction(&three_pages(), &text_options());
    assert!(!truncated);
    assert_eq!(
        text,
        "--- Page 1 ---\nHello wonderful world\n\n--- Page 2 ---\nline one\nline two\n\n--- Page 3 ---\n(no extractable text on this page)"
    );
    assert_eq!(
        pages,
        vec![
            (1, "Hello wonderful world".to_owned()),
            (2, "line one\nline two".to_owned()),
            (3, String::new())
        ]
    );
}

#[test]
fn a_page_range_selects_its_pages_and_a_fractional_one_is_an_error() {
    let ranged = InspectOptions { page_range: Some(PageRange { from: 2.0, to: 3.0 }), ..text_options() };
    let (text, _, pages) = extraction(&three_pages(), &ranged);
    assert!(text.starts_with("--- Page 2 ---\n"));
    assert_eq!(pages.iter().map(|p| p.0).collect::<Vec<_>>(), [2, 3]);

    let open_ended = InspectOptions { page_range: Some(PageRange { from: 3.0, to: f64::NAN }), ..text_options() };
    assert_eq!(extraction(&three_pages(), &open_ended).2.len(), 1);

    let fractional = InspectOptions { page_range: Some(PageRange { from: 1.5, to: 2.0 }), ..text_options() };
    assert_eq!(inspect_pdf_buffer(&three_pages(), &fractional).expect_err("fractional"), InspectError::InvalidPage);
}

#[test]
fn the_output_budget_cuts_the_text_and_says_so() {
    let budget = SUFFIX.len() as f64 + 30.0;
    let options = InspectOptions { max_output_bytes: budget, ..text_options() };
    let (text, truncated, _) = extraction(&three_pages(), &options);
    assert!(truncated);
    assert!(text.ends_with(SUFFIX));
    assert!(text.len() as f64 <= budget, "{} bytes", text.len());
    assert!(text.starts_with("--- Page 1 ---\n"));
}
