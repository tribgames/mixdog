//! Twin test `design_review`: the recording of Node's office design review (`native/core/fixtures/office-design-review/
//! golden.json`, written by `benchmarks/rust-core/recorders/record-office-design-review.mjs`) against this crate. Every
//! recorded input (the decks of the design-aesthetics, discipline, runtime-design and skill-kit suites, composition
//! sequences, briefs, and seeded generated decks that spread the thresholds) is run through the Rust function of the same
//! name and the exact JSON text of the answer must equal the recorded one: review records in Node's order with Node's
//! wording and key order, the deck diversity readings, the visual critique and its acknowledgement, the rubric score, the
//! slide roles and the authored-deck rules. Re-recording is `twin_live_design_review` (ignored: it runs Node).

use mixdog_js::{json_number, json_stringify, to_number_of};
use mixdog_office_author::brief;
use mixdog_office_author::receipt::{WIDE_CANVAS, slide_receipt};
use mixdog_office_base::twin;
use mixdog_office_quality::design_review::authored::{authored_background_ladder, is_card_grid_slide, is_ornamental_stripe, slide_size};
use mixdog_office_quality::design_review::diversity::review_pptx_deck_diversity;
use mixdog_office_quality::design_review::rubric::score_deck;
use mixdog_office_quality::design_review::slide_roles::{Size, is_pptx_specimen_slide};
use mixdog_office_quality::design_review::{
    AuthorReads, infer_pptx_slide_roles, is_pptx_diagram_slide, is_pptx_picture_slide, is_pptx_statement_slide,
    pptx_visual_review_acknowledged, review_office_design, review_pptx_visual_critique,
};
use serde_json::{Value, json};

/// The deck receipt and the brief readings, answered by the authoring crate.
pub struct Authoring;

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

fn golden() -> Value {
    twin::load_golden("office-design-review")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

fn cut(text: &str) -> String {
    text.chars().take(500).collect()
}

/// Replays one section: the answer of `run` to each recorded input must serialise to the recorded text (or be the recorded
/// error).
fn replay(golden: &Value, name: &str, run: impl Fn(&Value) -> Result<Value, String>) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for case in cases {
        let expected = match case.get("error") {
            Some(error) => format!("error: {}", error.as_str().unwrap_or_default()),
            None => json_stringify(&case["output"]),
        };
        let actual = match run(&case["input"]) {
            Ok(value) => json_stringify(&value),
            Err(error) => format!("error: {error}"),
        };
        if expected != actual {
            let input: String = json_stringify(&case["input"]).chars().take(300).collect();
            failures.push(format!("input {input}\n  recorded {}\n  produced {}", cut(&expected), cut(&actual)));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} of {} cases differ\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn size_of(value: Option<&Value>) -> Size {
    Size {
        width: to_number_of(value.and_then(|size| size.get("width"))),
        height: to_number_of(value.and_then(|size| size.get("height"))),
    }
}

fn shapes_of(input: &Value) -> Vec<&Value> {
    input["shapes"].as_array().map(|list| list.iter().collect()).unwrap_or_default()
}

fn has_text(shape: &Value) -> bool {
    shape.get("text").and_then(Value::as_str).is_some_and(|text| !mixdog_js::js_trim(text).is_empty())
}

fn every_review_equals_the_recording() {
    let g = golden();
    replay(&g, "design", |input| {
        let format = field(input, "format").and_then(Value::as_str).unwrap_or("");
        let audit = field(input, "auditProfile").and_then(Value::as_str).unwrap_or("");
        review_office_design(&Authoring, format, field(input, "document").unwrap_or(&Value::Null), field(input, "design"), field(input, "library"), audit)
    });
    replay(&g, "diversity", |input| {
        let document = field(input, "document").unwrap_or(&Value::Null);
        let design = field(input, "design").unwrap_or(&Value::Null);
        Ok(Value::Array(review_pptx_deck_diversity(&Authoring, document, design)))
    });
    replay(&g, "critique", |input| Ok(review_pptx_visual_critique(input)));
    replay(&g, "acknowledged", |input| Ok(Value::Bool(pptx_visual_review_acknowledged(input))));
    replay(&g, "rubric", |input| {
        let count = to_number_of(field(input, "issues")).max(0.0) as usize;
        Ok(score_deck(&Authoring, field(input, "receipt"), count, field(input, "brief")))
    });
    replay(&g, "roles", |input| Ok(infer_pptx_slide_roles(input)));
    replay(&g, "slideRoles", |input| {
        let slide = &input["slide"];
        let size = size_of(field(input, "size"));
        let text_shapes: Vec<&Value> = shapes_of(slide).into_iter().filter(|shape| has_text(shape)).collect();
        Ok(json!({
            "diagram": is_pptx_diagram_slide(slide, size),
            "picture": is_pptx_picture_slide(slide, size),
            "statement": is_pptx_statement_slide(slide),
            "specimen": is_pptx_specimen_slide(&text_shapes),
        }))
    });
    replay(&g, "specimen", |input| Ok(Value::Bool(is_pptx_specimen_slide(&shapes_of(input)))));
    replay(&g, "slideSize", |input| {
        let size = slide_size(field(input, "document").unwrap_or(&Value::Null));
        Ok(json!({ "width": json_number(size.width), "height": json_number(size.height) }))
    });
    replay(&g, "ladder", |input| {
        let backgrounds: Vec<String> = input["backgrounds"].as_array().map(|list| list.iter().map(|color| color.as_str().unwrap_or_default().to_owned()).collect()).unwrap_or_default();
        Ok(authored_background_ladder(&backgrounds, field(input, "tokenColors")).map_or(Value::Null, |ladder| json!({ "inverse": ladder.inverse, "canvas": ladder.canvas })))
    });
    replay(&g, "stripe", |input| {
        let shapes = shapes_of(input);
        let size = size_of(field(input, "size"));
        Ok(Value::Array(shapes.iter().map(|shape| Value::Bool(is_ornamental_stripe(shape, &shapes, size))).collect()))
    });
    replay(&g, "cardGrid", |input| {
        let shapes = shapes_of(input);
        let text_shapes: Vec<&Value> = shapes.iter().copied().filter(|shape| has_text(shape)).collect();
        Ok(Value::Bool(is_card_grid_slide(&text_shapes, &shapes)))
    });
    replay(&g, "receipts", |input| Ok(slide_receipt(&input["slide"], WIDE_CANVAS)));
}

#[test]
fn every_recorded_review_equals_the_recording() {
    every_review_equals_the_recording();
}

#[test]
fn the_recording_covers_every_reading_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [
        ("design", 300),
        ("diversity", 150),
        ("critique", 20),
        ("acknowledged", 10),
        ("rubric", 60),
        ("roles", 50),
        ("slideRoles", 100),
        ("stripe", 100),
        ("cardGrid", 100),
    ] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    let codes: Vec<&str> = ["design", "diversity"]
        .iter()
        .flat_map(|name| section(&g, name))
        .flat_map(|case| case["output"]["issues"].as_array().or_else(|| case["output"].as_array()).into_iter().flatten())
        .filter_map(|issue| issue["code"].as_str())
        .collect();
    for wanted in [
        "theme_background_drift",
        "theme_body_backgrounds",
        "font_family_overuse",
        "unsafe_font_family",
        "accent_hue_overuse",
        "meaningful_visual_missing",
        "excessive_slide_text",
        "decorative_stripe",
        "repetitive_composition",
        "card_grid_overuse",
        "native_evidence_too_weak",
        "recent_composition_repeat",
        "repeated_layout_grammar",
        "consecutive_composition_repeat",
        "repeated_decoration",
        "visual_role_variety_low",
        "beat_share_high",
        "consecutive_beats",
        "page_underfill",
        "art_direction_candidates_missing",
        "plan_promise_missing",
        "number_without_fact",
    ] {
        assert!(codes.contains(&wanted), "no {wanted} issue among the recorded reviews");
    }
}

/// The assertions of the Node suites on these modules (`office-design-aesthetics`, `office-design-discipline`), written
/// over the same decks.
mod suites {
    use super::*;

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
            beat(1, dark), evidence(2), evidence(3), beat(4, dark), beat(5, dark), beat(6, dark), evidence(7), evidence(8), evidence(9), beat(10, dark),
        ]);
        let consecutive = with_code(&run, "consecutive_beats");
        assert_eq!(consecutive.len(), 1, "three beats in a row are reported");
        assert!(consecutive[0]["message"].as_str().expect("message").contains("Slides 4-6"));
        assert!(!with_code(&run, "beat_share_high").is_empty(), "3 of the 8 slides between the cover and the closing are beats");
        let covers = issues_of(vec![beat(1, dark), beat(2, dark), evidence(3), evidence(4), evidence(5), evidence(6), evidence(7), beat(8, dark)]);
        assert!(with_code(&covers, "beat_share_high").is_empty(), "one agenda beat among six inner pages is the ordinary shape");
        assert!(with_code(&covers, "consecutive_beats").is_empty(), "two beats in the front matter and the closing are the ordinary shape");
        let theme = issues_of(
            (0..10)
                .map(|i| if i % 3 == 2 { json!({ "index": i + 1, "background": { "color": dark }, "shapes": evidence(i + 1)["shapes"] }) } else { beat(i + 1, dark) })
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
    fn a_native_document_request_is_diagnostics_only_and_an_unknown_format_is_the_error_node_throws() {
        let native = review_office_design(&Authoring, "DOCX", &json!({ "paragraphs": [] }), Some(&json!({ "review": false })), None, "").expect("a review");
        assert_eq!(native["status"], "diagnostics-only");
        assert_eq!(native["authoring"], "native");
        let unsupported = review_office_design(&Authoring, "unknown", &json!({}), None, None, "");
        assert_eq!(unsupported.expect_err("an unknown format"), "Unsupported Office design format: unknown");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_design_review -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_design_review() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-design-review.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_review_equals_the_recording();
}
