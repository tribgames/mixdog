//! The design review of a deck: the composition sequence of its pages and what the review says of a run of beats, a
//! page that carries one sentence, and pages that repeat one composition.

use mixdog_office_author::brief;
use mixdog_office_author::receipt::{WIDE_CANVAS, slide_receipt};
use mixdog_office_quality::design_review::{AuthorReads, review_office_design};
use serde_json::{Value, json};

/// The deck receipt and the brief readings, answered by the authoring crate.
struct Authoring;

impl AuthorReads for Authoring {
    fn slide_receipt(&self, slide: &Value) -> Value {
        slide_receipt(slide, WIDE_CANVAS)
    }
    fn is_showcase_brief(&self, brief_value: &Value) -> bool {
        brief::is_showcase_brief(brief_value)
    }
    fn review_brief_promises(&self, document: &Value, brief_value: &Value) -> Vec<Value> {
        brief::review_brief_promises(document, brief_value)
    }
    fn review_fact_coverage(&self, document: &Value, brief_value: &Value) -> Vec<Value> {
        brief::review_fact_coverage(document, brief_value)
    }
    fn review_source_grounding(&self, brief_value: &Value) -> Vec<Value> {
        brief::review_source_grounding(brief_value)
    }
}

fn title(index: u32) -> Value {
    json!({ "type": 17, "text": format!("Title {index}"), "left": 58, "top": 46, "width": 780, "height": 70, "font": { "size": 40 } })
}

fn beat(index: u32, color: &str) -> Value {
    json!({ "index": index, "background": { "color": color }, "shapes": [{ "type": 17, "text": format!("Beat {index}"), "left": 58, "top": 200, "width": 700, "height": 120, "font": { "size": 44 } }] })
}

fn evidence(index: u32) -> Value {
    json!({
        "index": index,
        "background": { "color": "F7F9FC" },
        "shapes": [title(index), { "chart": { "type": if index % 2 == 1 { "bar" } else { "line" } }, "left": 58, "top": 150, "width": 800 - index * 7, "height": 340 }],
    })
}

fn thin(index: u32) -> Value {
    json!({
        "index": index,
        "background": { "color": "F7F9FC" },
        "shapes": [title(index), { "type": 17, "text": "대기 시간이 줄었다.", "left": 58, "top": 200, "width": 600, "height": 40, "font": { "size": 15 } }],
    })
}

fn charted(index: u32) -> Value {
    json!({
        "index": index,
        "background": { "color": "F7F9FC" },
        "shapes": [
            title(index),
            { "type": 17, "text": "대기 시간이 줄었다.", "left": 58, "top": 200, "width": 300, "height": 40, "font": { "size": 15 } },
            { "chart": { "type": "bar" }, "left": 400, "top": 150, "width": 500, "height": 340 },
        ],
    })
}

fn issues_of(slides: Vec<Value>) -> Vec<Value> {
    let document = json!({ "slideWidth": 960, "slideHeight": 540, "slides": slides });
    let request = json!({ "intent": "Approve the plan", "signature": "structure-led", "deck": { "backgroundMode": "custom" } });
    let review = review_office_design(&Authoring, "pptx", &document, Some(&request), None, "").expect("the design resolves");
    review["issues"].as_array().expect("issues").clone()
}

fn with_code<'a>(issues: &'a [Value], code: &str) -> Vec<&'a Value> {
    issues.iter().filter(|issue| issue["code"] == code).collect()
}

#[test]
fn three_consecutive_beats_and_a_deck_that_is_mostly_beats_are_reported_and_a_dark_theme_is_let_through() {
    let dark = "0F1B26";
    let run = issues_of(vec![
        beat(1, dark),
        evidence(2),
        evidence(3),
        beat(4, dark),
        beat(5, dark),
        beat(6, dark),
        evidence(7),
        evidence(8),
        evidence(9),
        beat(10, dark),
    ]);
    let consecutive = with_code(&run, "consecutive_beats");
    assert_eq!(consecutive.len(), 1, "three beats in a row are reported");
    assert!(consecutive[0]["message"].as_str().expect("message").contains("Slides 4-6"));
    assert!(!with_code(&run, "beat_share_high").is_empty(), "3 of the 8 slides between the cover and the closing are beats");
    let covers = issues_of(vec![beat(1, dark), beat(2, dark), evidence(3), evidence(4), evidence(5), evidence(6), evidence(7), beat(8, dark)]);
    assert!(with_code(&covers, "beat_share_high").is_empty(), "one agenda beat among six inner pages is the ordinary shape");
    assert!(with_code(&covers, "consecutive_beats").is_empty(), "two beats in the front matter and the closing are the ordinary shape");
    let theme =
        issues_of(
            (0..10)
                .map(|i| {
                    if i % 3 == 2 { json!({ "index": i + 1, "background": { "color": dark }, "shapes": evidence(i + 1)["shapes"] }) } else { beat(i + 1, dark) }
                })
                .collect(),
        );
    assert!(with_code(&theme, "beat_share_high").is_empty(), "a deck dark on every page is a theme, not beats");
}

#[test]
fn a_body_page_that_carries_one_sentence_and_nothing_else_is_reported() {
    let cover = |index: u32| beat(index, "0F1B26");
    let issues = issues_of(vec![cover(1), charted(2), thin(3), charted(4), cover(5)]);
    let underfill = with_code(&issues, "page_underfill");
    assert_eq!(underfill.len(), 1);
    assert_eq!(underfill[0]["path"], "/slide[3]");
    assert!(with_code(&issues_of(vec![cover(1), charted(2), charted(3), cover(4)]), "page_underfill").is_empty(), "a sentence beside a chart is a reading");
    let laned = json!({
        "index": 3,
        "background": { "color": "F7F9FC" },
        "shapes": [title(3), { "type": 17, "text": "조례 개정", "name": "mixdog-spec:structure:lanes", "left": 200, "top": 150, "width": 180, "height": 50, "font": { "size": 14 } }],
    });
    assert!(with_code(&issues_of(vec![cover(1), charted(2), laned, charted(4), cover(5)]), "page_underfill").is_empty(), "a structure carries the page");
}

#[test]
fn three_node_pages_in_a_row_repeat_one_composition_and_signed_structures_are_distinct_types() {
    let page = |index: u32, kind: &str, name: &str| {
        json!({
            "index": index,
            "background": { "color": "F7F9FC", "followMaster": false, "source": "slide" },
            "shapes": [
                { "type": 17, "text": format!("Point {index}"), "left": 58, "top": 46, "width": 780, "height": 70, "font": { "size": 40 } },
                { "type": 1, "text": "", "geometry": "ellipse", "left": 120, "top": 200, "width": 60, "height": 60 },
                { "type": 17, "text": kind, "name": name, "left": 200, "top": 210, "width": 300, "height": 40, "font": { "size": 14 } },
            ],
        })
    };
    let claim = |index: u32| json!({ "index": index, "background": { "color": "F7F9FC" }, "shapes": [{ "type": 17, "text": "Claim", "left": 58, "top": 200, "width": 700, "height": 120, "font": { "size": 44 } }] });
    let same = issues_of(vec![page(1, "cover", ""), page(2, "node", ""), page(3, "node", ""), page(4, "node", ""), claim(5), claim(6)]);
    let run = with_code(&same, "consecutive_composition_repeat");
    assert_eq!(run.len(), 1);
    assert!(run[0]["message"].as_str().expect("message").starts_with("Slides 2-4 repeat one composition"));
    let signed = issues_of(vec![
        page(1, "cover", ""),
        page(2, "node", "mixdog-spec:structure:hub"),
        page(3, "node", "mixdog-spec:structure:timeline"),
        page(4, "node", "mixdog-spec:structure:hub"),
        claim(5),
        claim(6),
    ]);
    assert!(with_code(&signed, "consecutive_composition_repeat").is_empty(), "a hub page and a timeline page are two visual types");
}

#[test]
fn a_native_document_request_is_diagnostics_only_and_an_unknown_format_is_refused() {
    let native = review_office_design(&Authoring, "DOCX", &json!({ "paragraphs": [] }), Some(&json!({ "review": false })), None, "").expect("a review");
    assert_eq!(native["status"], "diagnostics-only");
    assert_eq!(native["authoring"], "native");
    let unsupported = review_office_design(&Authoring, "unknown", &json!({}), None, None, "");
    assert_eq!(unsupported.expect_err("an unknown format"), "Unsupported Office design format: unknown");
}
