//! The Word and PowerPoint builders asserted through the packages they produce: what a measured flow or deck becomes in the
//! parts, and what the parts read back as. Inputs are built here; no browser, Office or recording is involved.

use std::collections::BTreeMap;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_author::docx_build::{DocxPage, build_docx_from_flow};
use mixdog_office_author::measure_deck::Canvas;
use mixdog_office_author::pptx_build::{Pictures, build_pptx_from_measure};
use mixdog_ooxml::zipio::Package;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

fn paragraph(text: &str) -> Value {
    json!({ "kind": "p", "runs": [{ "text": text, "size": 11 }], "before": 0, "after": 8, "line": 17.6, "align": "left" })
}

fn word(blocks: Vec<Value>, page: DocxPage) -> Package {
    let flow = json!({ "blocks": blocks, "body": { "size": 11 } });
    let built = build_docx_from_flow(&Unlaned, &Registry::new(), &flow, &page, &BTreeMap::new(), &BTreeMap::new(), "Quarterly report").expect("a document");
    Package::load(&built.bytes).expect("a package")
}

const A4: DocxPage = DocxPage { width: 595.3, height: 841.9, top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 };
const LETTER: DocxPage = DocxPage { width: 612.0, height: 792.0, top: 72.0, right: 72.0, bottom: 72.0, left: 72.0 };

#[test]
fn paragraphs_are_written_in_order_with_their_text_escaped_and_korean_kept() {
    let package = word(vec![paragraph("첫 문단"), paragraph("a < b & c"), paragraph("마지막")], A4);
    let document = package.text("word/document.xml");
    let at = |text: &str| document.find(text).unwrap_or_else(|| panic!("{text} is missing from {document}"));
    assert!(at("첫 문단") < at("a &lt; b &amp; c") && at("a &lt; b &amp; c") < at("마지막"));
    assert!(!document.contains("a < b"), "text is escaped, never written as markup");
}

#[test]
fn the_page_size_is_the_measured_sheet_in_twentieths_of_a_point() {
    assert!(word(vec![paragraph("x")], A4).text("word/document.xml").contains("<w:pgSz w:w=\"11906\" w:h=\"16838\""));
    assert!(word(vec![paragraph("x")], LETTER).text("word/document.xml").contains("<w:pgSz w:w=\"12240\" w:h=\"15840\""));
}

#[test]
fn the_document_carries_the_title_it_was_given_and_the_parts_a_word_package_needs() {
    let package = word(vec![paragraph("x")], A4);
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml"] {
        assert!(package.contains(part), "{part} is missing from {:?}", package.names());
    }
    assert!(package.text("docProps/core.xml").contains("Quarterly report"));
}

fn canvas() -> Canvas {
    Canvas { width: 1920, height: 1080, inch_width: 0.0, inch_height: 0.0 }
}

fn text_item(text: &str, y: f64) -> Value {
    let style = json!({ "font": "Noto Sans KR", "size": 28, "bold": false, "italic": false, "color": { "hex": "14181F", "a": 1 }, "ls": 0, "hl": null });
    json!({
        "kind": "text",
        "box": { "x": 96, "y": y, "w": 800, "h": 42 },
        "inset": { "l": 0, "r": 0, "t": 0, "b": 0 },
        "frame": null, "align": "left", "lineHeight": 42, "fontSize": 28, "inkW": 600,
        "lines": [{ "top": y + 4.0, "bottom": y + 38.0, "width": 600, "runs": [{ "text": text, "style": style }] }],
    })
}

fn deck(slides: Vec<Value>) -> Package {
    let bytes = build_pptx_from_measure(canvas(), &slides, &SvgFonts::none(), &Pictures::new()).expect("built");
    Package::load(&bytes).expect("a package")
}

#[test]
fn each_measured_slide_is_a_slide_part_in_order_with_its_own_text_and_notes() {
    let package = deck(vec![
        json!({ "bg": null, "notes": "say this first", "items": [text_item("첫 슬라이드", 100.0)] }),
        json!({ "bg": null, "items": [text_item("A & B < C", 100.0)] }),
    ]);
    assert!(package.text("ppt/slides/slide1.xml").contains("첫 슬라이드"));
    let second = package.text("ppt/slides/slide2.xml");
    assert!(second.contains("A &amp; B &lt; C") && !second.contains("첫 슬라이드"), "{second}");
    assert!(package.text("ppt/notesSlides/notesSlide1.xml").contains("say this first"));
    let presentation = package.text("ppt/presentation.xml");
    assert_eq!(presentation.matches("<p:sldId ").count(), 2, "{presentation}");
}

#[test]
fn the_slide_is_the_canvas_at_the_wide_size_and_a_filled_box_keeps_its_colour() {
    let rect = json!({ "kind": "rect", "box": { "x": 96, "y": 200, "w": 400, "h": 200 }, "fill": { "hex": "FF7A45", "a": 1 }, "radius": 0, "stroke": null, "shadow": null });
    let package = deck(vec![json!({ "bg": { "hex": "F4F5F7", "a": 1 }, "items": [rect] })]);
    assert!(package.text("ppt/presentation.xml").contains("<p:sldSz cx=\"12192000\" cy=\"6858000\"/>"));
    let slide = package.text("ppt/slides/slide1.xml");
    assert!(slide.contains("FF7A45"), "the box fill: {slide}");
    assert!(slide.contains("F4F5F7"), "the slide background: {slide}");
}
