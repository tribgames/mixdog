//! `quality-score.mjs`: the release score of a reviewed Office document and its diagnostics evidence.

use mixdog_js::{json_number, js_to_lowercase, to_number, to_number_of};
use mixdog_office_base::values::clamp;
use serde_json::{Map, Value};

use crate::document_acceptance::{assess_document_acceptance, document_visual_checks};
use crate::presentation_acceptance::assess_presentation_acceptance;
use crate::{field, is_true, is_truthy, text_or};

/// Warnings that weigh 0.07 instead of 0.03: faults the reader sees at once.
const HARD_WARNING_CODES: &[&str] = &[
    "blank_page",
    "content_touches_page_edge",
    "edge_margin",
    "heading_table_separation",
    "low_contrast",
    "number_without_source",
    "orphan_heading",
    "shape_overlap",
    "short_table_split",
    "small_font",
    "shape_out_of_bounds",
    "text_outside_slide",
    "text_overflow",
    "text_spacing_tight",
    "worksheet_print_too_small",
];

/// `Number(Number(value).toFixed(4))`: `toFixed` picks the larger of two equally near multiples, where Rust's
/// formatting picks the even one, so an exact tie is rounded up here.
fn rounded(value: f64) -> f64 {
    let value = if value.is_nan() { 0.0 } else { value };
    let magnitude = value.abs();
    let digits = format!("{magnitude:.80}");
    let (whole, tail) = digits.split_once('.').unwrap_or((digits.as_str(), ""));
    let tied = tail.len() > 4 && tail.as_bytes()[4] == b'5' && tail[5..].bytes().all(|digit| digit == b'0');
    let text = if tied {
        // The truncated four places plus one unit in the last place, added as decimal digits.
        let kept = format!("{whole}{}", &tail[..4]);
        let bumped = (kept.parse::<u128>().unwrap_or(0) + 1).to_string();
        let padded = format!("{bumped:0>5}");
        let (head, fraction) = padded.split_at(padded.len() - 4);
        format!("{head}.{fraction}")
    } else {
        format!("{magnitude:.4}")
    };
    let parsed: f64 = text.parse().unwrap_or(0.0);
    if value < 0.0 { -parsed } else { parsed }
}

fn issue_penalty(issue: &Value) -> f64 {
    let severity = js_to_lowercase(&text_or(field(issue, "severity"), ""));
    if severity == "error" {
        return 0.18;
    }
    if severity != "warning" {
        return 0.0;
    }
    if HARD_WARNING_CODES.contains(&text_or(field(issue, "code"), "").as_str()) { 0.07 } else { 0.03 }
}

fn is_blocking(issue: &Value) -> bool {
    matches!(js_to_lowercase(&text_or(field(issue, "severity"), "")).as_str(), "error" | "warning")
}

/// `scoreOfficeReleaseQuality(input)`: `input` is the options object (`format`, `aesthetics`, `issues`,
/// `renderedPages`, `expectedPages`, `structuralAvailable`, `planCoverage`; an absent one takes Node's default).
/// The score weighs the rendered aesthetics at 0.72 and the structural findings at 0.28; the diagnostics are kept for
/// comparison and never presented as an aesthetic verdict, so a presentation or a paginated document also carries
/// its acceptance verdict, which needs the independently checked review.
pub fn score_office_release_quality(input: &Value) -> Value {
    let format = js_to_lowercase(&text_or(field(input, "format"), ""));
    let aesthetics = field(input, "aesthetics").filter(|value| is_truthy(Some(*value)));
    let issues: &[Value] = match field(input, "issues") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let rendered_pages = field(input, "renderedPages").map_or(0.0, to_number);
    let expected_pages = field(input, "expectedPages").map_or(0.0, to_number);
    let structural_available = field(input, "structuralAvailable");
    let plan_coverage = field(input, "planCoverage").map_or(0.0, to_number);

    let render_score = {
        let number = to_number_of(aesthetics.and_then(|value| field(value, "score")));
        if number.is_finite() { clamp(number, 0.0, 1.0) } else { 0.0 }
    };
    let structural_penalty = issues.iter().fold(0.0, |total, issue| total + issue_penalty(issue)).min(0.85);
    let structural_score = clamp(1.0 - structural_penalty, 0.0, 1.0);
    let score = if aesthetics.is_some() { render_score * 0.72 + structural_score * 0.28 } else { structural_score * 0.55 };
    let mut page_coverage = if rendered_pages > 0.0 { 1.0 } else { 0.0 };
    if expected_pages > 0.0 {
        page_coverage = clamp(rendered_pages / expected_pages, 0.0, 1.0);
    }
    let plan_coverage = if format == "pptx" { clamp(plan_coverage, 0.0, 1.0) } else { 1.0 };
    let confidence = (if aesthetics.is_some() { 0.45 } else { 0.0 })
        + (if is_truthy(structural_available) { 0.3 } else { 0.0 })
        + page_coverage * 0.15
        + plan_coverage * 0.1;
    let blocking = issues.iter().filter(|issue| is_blocking(issue)).count();

    let mut evidence = Map::new();
    evidence.insert("renderedPages".to_owned(), json_number(positive_or_zero(rendered_pages)));
    evidence.insert("expectedPages".to_owned(), json_number(positive_or_zero(expected_pages)));
    evidence.insert("pageCoverage".to_owned(), json_number(rounded(page_coverage)));
    evidence.insert("planCoverage".to_owned(), json_number(rounded(plan_coverage)));
    evidence.insert("structuralAvailable".to_owned(), Value::Bool(is_true(structural_available)));
    evidence.insert("blockingIssueCount".to_owned(), Value::from(blocking));
    let evidence = Value::Object(evidence);

    let mut dimensions = Map::new();
    dimensions.insert("render".to_owned(), json_number(rounded(render_score)));
    dimensions.insert("structural".to_owned(), json_number(rounded(structural_score)));
    let mut quality = Map::new();
    quality.insert("version".to_owned(), Value::from(if format == "pptx" { 3 } else { 2 }));
    quality.insert("score".to_owned(), json_number(rounded(score)));
    quality.insert("confidence".to_owned(), json_number(rounded(clamp(confidence, 0.0, 1.0))));
    quality.insert("releaseReady".to_owned(), Value::Bool(blocking == 0 && score >= 0.7));
    quality.insert("dimensions".to_owned(), Value::Object(dimensions));
    quality.insert("evidence".to_owned(), evidence.clone());
    let acceptance = if format == "pptx" {
        Some(assess_presentation_acceptance(&evidence, false, None))
    } else if document_visual_checks(&format).is_some() {
        Some(assess_document_acceptance(&evidence, None))
    } else {
        None
    };
    if let Some(Value::Object(acceptance)) = acceptance {
        for (key, value) in acceptance {
            quality.insert(key, value);
        }
    }
    Value::Object(quality)
}

/// `Math.max(0, Number(value) || 0)`.
fn positive_or_zero(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value.max(0.0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounding_is_to_fixed_four_with_the_larger_neighbour_on_a_tie() {
        assert_eq!(rounded(0.03125), 0.0313);
        assert_eq!(rounded(0.15625), 0.1563);
        assert_eq!(rounded(0.72), 0.72);
        assert_eq!(rounded(0.123456), 0.1235);
        assert_eq!(rounded(0.0), 0.0);
        assert_eq!(rounded(f64::NAN), 0.0);
    }

    #[test]
    fn a_clean_workbook_is_automated_ready_but_not_release_ready() {
        let workbook = score_office_release_quality(&json!({
            "format": "xlsx", "aesthetics": { "score": 0.9 }, "renderedPages": 1, "expectedPages": 1, "structuralAvailable": true
        }));
        assert_eq!(workbook["version"], 2);
        assert_eq!(workbook["automatedReady"], true);
        assert_eq!(workbook["releaseReady"], false);
        assert_eq!(workbook["visualReview"]["status"], "not-reviewed");
    }

    #[test]
    fn a_deck_is_scored_as_version_three_and_waits_for_its_critique() {
        let quality = score_office_release_quality(&json!({
            "format": "pptx", "aesthetics": { "score": 1 }, "renderedPages": 5, "expectedPages": 5,
            "structuralAvailable": true, "planCoverage": 1
        }));
        assert_eq!(quality["version"], 3);
        assert_eq!(quality["score"], 1);
        assert_eq!(quality["releaseReady"], false);
        assert_eq!(quality["automatedReady"], true);
        assert_eq!(quality["visualReview"]["required"], true);
    }

    #[test]
    fn an_aesthetic_score_is_not_a_release_threshold_and_documents_wait_for_their_page_review() {
        let low = score_office_release_quality(&json!({
            "format": "pptx", "aesthetics": { "score": 0 }, "renderedPages": 5, "expectedPages": 5, "structuralAvailable": true
        }));
        let accepted = assess_presentation_acceptance(&low["evidence"], true, Some(&json!({ "ok": true })));
        assert_eq!(accepted["releaseReady"], true);
        for format in crate::document_acceptance::DOCUMENT_VISUAL_FORMATS {
            let unreviewed = score_office_release_quality(&json!({
                "format": format, "aesthetics": { "score": 1 }, "structuralAvailable": true, "renderedPages": 2, "expectedPages": 2
            }));
            assert_eq!(unreviewed["automatedReady"], true, "{format}");
            assert_eq!(unreviewed["releaseReady"], false, "{format}");
            let acknowledged = json!({ "acknowledged": true, "status": "accepted" });
            assert_eq!(assess_document_acceptance(&unreviewed["evidence"], Some(&acknowledged))["releaseReady"], true);
        }
    }

    #[test]
    fn a_blocking_issue_or_a_low_score_is_not_release_ready() {
        let issue = json!({ "severity": "warning", "code": "x" });
        let blocked = score_office_release_quality(&json!({ "format": "csv", "aesthetics": { "score": 1 }, "issues": [issue] }));
        assert_eq!(blocked["releaseReady"], false);
        assert_eq!(blocked["evidence"]["blockingIssueCount"], 1);
        assert!(blocked.get("scoreMeaning").is_none());
        let bare = score_office_release_quality(&json!({}));
        assert_eq!(bare["score"], 0.55);
        assert_eq!(bare["releaseReady"], false);
    }
}
