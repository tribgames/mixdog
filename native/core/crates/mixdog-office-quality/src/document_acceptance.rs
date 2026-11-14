//! `document-acceptance.mjs`: the review verdict ladder shared by document and presentation acceptance, the
//! page-by-page review of a paginated document, and its automated-readiness and release verdict.

use mixdog_js::{js_trim, json_number, json_stringify, number_to_string, to_number_of};
use serde_json::{Map, Value, json};

use crate::{field, field_of, is_true, is_truthy, strict_equals, text_or};

/// `reviewStatus`: not reviewed, needs work, not acknowledged, or accepted.
pub fn review_status(reviewed: bool, complete: bool, acknowledged: bool) -> &'static str {
    if !reviewed {
        "not-reviewed"
    } else if !complete {
        "needs-work"
    } else if acknowledged {
        "accepted"
    } else {
        "not-acknowledged"
    }
}

/// The formats of `DOCUMENT_VISUAL_CHECKS`, in its key order.
pub const DOCUMENT_VISUAL_FORMATS: [&str; 3] = ["docx", "xlsx", "pdf"];

/// `DOCUMENT_VISUAL_CHECKS[format]`: the checks a page of a document of this medium is read against; `None` for a
/// format with no paginated review (a tabular export).
pub fn document_visual_checks(format: &str) -> Option<&'static [&'static str]> {
    match format {
        "docx" => Some(&["hierarchy", "pagination", "legibility"]),
        "xlsx" => Some(&["sheetReadability", "chartVisibility", "printLayout"]),
        "pdf" => Some(&["legibility", "clipping", "readingOrder"]),
        _ => None,
    }
}

/// A check answered as a boolean or, in the deck critique's own vocabulary, as a 1-5 score: a 4 or 5 passes. The same
/// name (`hierarchy`, `legibility`) carries a score on a slide and a check on a page, so a number is not a fail.
fn check_passed(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Bool(true)) => true,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|score| score.is_finite() && score >= 4.0),
        _ => false,
    }
}

/// The reasons one page of the critique is not passed, empty when it is; `extra` is how many more entries name it.
fn page_reasons(entry: Option<&Value>, extra: usize, checks: &[&str]) -> Vec<String> {
    let Some(entry) = entry else { return vec!["no critique entry for this page".to_owned()] };
    let mut reasons: Vec<String> = Vec::new();
    if extra > 0 {
        reasons.push(format!("{} critique entries name this page", extra + 1));
    }
    if !matches!(field(entry, "verdict"), Some(Value::String(verdict)) if verdict.as_str() == "pass") {
        let shown = json_stringify(field(entry, "verdict").unwrap_or(&Value::Null));
        reasons.push(format!("verdict is {shown}, not 'pass'"));
    }
    let failed: Vec<&str> = checks.iter().copied().filter(|check| !check_passed(field(entry, check))).collect();
    if !failed.is_empty() {
        reasons.push(format!("{} not passed (true, or a score of 4 or 5)", failed.join(", ")));
    }
    match field(entry, "fixes") {
        Some(Value::Array(fixes)) if !fixes.is_empty() => {
            reasons.push(format!("{} unresolved fix(es) listed", fixes.len()));
        }
        _ => {}
    }
    if js_trim(&text_or(field(entry, "note"), "")).is_empty() {
        reasons.push("note is empty".to_owned());
    }
    reasons
}

/// `reviewDocumentPages(format, design, state)`: one verdict per rendered page from the author's critique entries,
/// whether the review is current for the last render, and why it is not accepted, in the order a caller can act on it.
/// `None` for a format without paginated review.
pub fn review_document_pages(format: &str, design: &Value, state: &Value) -> Option<Value> {
    let checks = document_visual_checks(format)?;
    let count = {
        let number = to_number_of(field(state, "renderedPageCount"));
        if number.is_nan() { 0.0 } else { number }
    };
    let entries: &[Value] = match field(design, "critique") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    // One row per rendered page: the record and the reasons it is not passed.
    let mut pages: Vec<(f64, Value, Vec<String>)> = Vec::new();
    let mut page = 1.0;
    while page <= count {
        let mut matching = entries.iter().filter(|entry| to_number_of(field(entry, "page")) == page);
        let entry = matching.next();
        let extra = matching.count();
        let reasons = page_reasons(entry, extra, checks);
        let mut record = Map::new();
        record.insert("page".to_owned(), json_number(page));
        record.insert("passed".to_owned(), Value::Bool(reasons.is_empty()));
        record.insert("note".to_owned(), Value::String(text_or(entry.and_then(|found| field(found, "note")), "")));
        if !reasons.is_empty() {
            record.insert("reasons".to_owned(), json!(reasons));
        }
        if let Some(entry) = entry {
            let answered: Map<String, Value> =
                checks.iter().filter_map(|check| field(entry, check).map(|value| ((*check).to_owned(), value.clone()))).collect();
            if !answered.is_empty() {
                record.insert("checks".to_owned(), Value::Object(answered));
            }
        }
        pages.push((page, Value::Object(record), reasons));
        page += 1.0;
    }
    let entry_count = entries.len() as f64;
    let complete = count > 0.0 && entry_count == count && pages.iter().all(|(_, _, reasons)| reasons.is_empty());
    let reviewed = is_true(field(design, "reviewed"));
    let token = field(state, "reviewToken");
    let same_token = strict_equals(field(design, "reviewToken"), token);
    let same_version = strict_equals(field(state, "renderedVersion"), field(state, "snapshotVersion"));
    let covered = is_true(field_of(field(state, "renderedCoverage"), "complete"));
    let current = is_truthy(token) && same_token && same_version && covered;
    // Why the review is not accepted, in the order a caller can act on it.
    let mut blockers: Vec<String> = Vec::new();
    if count == 0.0 {
        blockers.push("no rendered pages: render first".to_owned());
    } else if entry_count != count {
        blockers.push(format!("{} critique entries for {} rendered pages", entries.len(), number_to_string(count)));
    }
    for (number, _, reasons) in &pages {
        if !reasons.is_empty() {
            blockers.push(format!("page {}: {}", number_to_string(*number), reasons.join("; ")));
        }
    }
    if complete {
        if !is_truthy(token) {
            blockers.push("no current render: render first".to_owned());
        } else if !same_token {
            blockers.push("reviewToken is not the current render token".to_owned());
        } else if !same_version {
            blockers.push("the document changed after the render: render again".to_owned());
        } else if !covered {
            blockers.push("the last render did not cover every page: render all pages".to_owned());
        }
        if !reviewed {
            blockers.push("design.reviewed is not true".to_owned());
        }
    }
    let acknowledged = complete && current && reviewed;
    let mut review = Map::new();
    review.insert("format".to_owned(), Value::String(format.to_owned()));
    review.insert("checks".to_owned(), json!(checks));
    review.insert("pages".to_owned(), Value::Array(pages.into_iter().map(|(_, record, _)| record).collect()));
    review.insert("complete".to_owned(), Value::Bool(complete));
    review.insert("acknowledged".to_owned(), Value::Bool(acknowledged));
    review.insert("status".to_owned(), json!(review_status(!entries.is_empty(), complete, current && reviewed)));
    if !blockers.is_empty() {
        review.insert("blockers".to_owned(), json!(blockers));
    }
    review.insert("basis".to_owned(), json!("current-render-and-page-observations"));
    review.insert("authority".to_owned(), json!("agent-self-review"));
    review.insert("userAcceptance".to_owned(), json!("not-recorded"));
    Some(Value::Object(review))
}

/// `isAutomatedReady`: mechanical readiness shared by document and presentation acceptance: a structural review ran,
/// every expected page rendered, nothing blocking left.
pub fn is_automated_ready(evidence: &Value) -> bool {
    is_true(field(evidence, "structuralAvailable"))
        && to_number_of(field(evidence, "expectedPages")) > 0.0
        && to_number_of(field(evidence, "pageCoverage")) == 1.0
        && to_number_of(field(evidence, "blockingIssueCount")) == 0.0
}

/// `assessDocumentAcceptance(evidence, visual)`: rendering produces evidence, not an approval; the document is
/// release-ready only when it is automated-ready and its page review was acknowledged.
pub fn assess_document_acceptance(evidence: &Value, visual: Option<&Value>) -> Value {
    let automated_ready = is_automated_ready(evidence);
    let visual_review = match visual {
        Some(review) if is_truthy(Some(review)) => review.clone(),
        _ => json!({
            "status": "not-reviewed",
            "basis": "current-render-and-page-observations",
            "authority": "agent-self-review",
            "userAcceptance": "not-recorded",
        }),
    };
    json!({
        "scoreMeaning": "automated-diagnostics-not-design-quality",
        "automatedReady": automated_ready,
        "visualReview": visual_review,
        "releaseReady": automated_ready && is_true(visual.and_then(|review| field(review, "acknowledged"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({
            "renderedPageCount": 2, "reviewToken": "current", "renderedVersion": 4, "snapshotVersion": 4,
            "renderedCoverage": { "complete": true }
        })
    }

    fn evidence() -> Value {
        json!({ "structuralAvailable": true, "expectedPages": 2, "pageCoverage": 1, "blockingIssueCount": 0 })
    }

    fn page_entry(page: u32, checks: &[&str]) -> Value {
        let mut entry = json!({ "page": page, "verdict": "pass", "note": format!("Reviewed page {page}") });
        for check in checks {
            entry[*check] = json!(true);
        }
        entry
    }

    fn design(checks: &[&str]) -> Value {
        json!({ "reviewed": true, "reviewToken": "current", "critique": [page_entry(1, checks), page_entry(2, checks)] })
    }

    #[test]
    fn every_paginated_format_requires_current_page_specific_checks_not_a_diagnostic_score() {
        for format in DOCUMENT_VISUAL_FORMATS {
            let checks = document_visual_checks(format).expect("checks");
            let accepted = review_document_pages(format, &design(checks), &state()).expect("review");
            assert_eq!(accepted["acknowledged"], true, "{format}");
            assert_eq!(accepted["status"], "accepted");
            assert!(accepted.get("blockers").is_none());
            assert_eq!(assess_document_acceptance(&evidence(), Some(&accepted))["releaseReady"], true);

            let mut stale = design(checks);
            stale["reviewToken"] = json!("old");
            let mut short = design(checks);
            short["critique"] = json!([page_entry(1, checks)]);
            let mut duplicated = design(checks);
            duplicated["critique"] = json!([page_entry(1, checks), page_entry(1, checks)]);
            let mut failing = design(checks);
            failing["critique"][1][checks[0]] = json!(false);
            for invalid in [stale, short, duplicated, failing] {
                assert_eq!(review_document_pages(format, &invalid, &state()).expect("review")["acknowledged"], false);
            }
            let mut changed = state();
            changed["snapshotVersion"] = json!(5);
            assert_eq!(review_document_pages(format, &design(checks), &changed).expect("review")["acknowledged"], false);
            let mut partial = state();
            partial["renderedCoverage"] = json!({ "complete": false });
            assert_eq!(review_document_pages(format, &design(checks), &partial).expect("review")["acknowledged"], false);
        }
    }

    fn scored(score: u32) -> Value {
        let critique: Vec<Value> = [1, 2]
            .iter()
            .map(|page| json!({ "page": page, "verdict": "pass", "note": format!("page {page}"), "hierarchy": score, "legibility": score }))
            .collect();
        json!({ "reviewed": true, "reviewToken": "current", "critique": critique })
    }

    #[test]
    fn a_page_check_answered_as_a_score_passes_at_4_and_a_refusal_names_its_reason() {
        let passed = review_document_pages("docx", &scored(4), &state()).expect("review");
        assert_eq!(passed["acknowledged"], true);
        let low = review_document_pages("docx", &scored(3), &state()).expect("review");
        assert_eq!(low["acknowledged"], false);
        let blockers: Vec<&str> = low["blockers"].as_array().expect("blockers").iter().filter_map(Value::as_str).collect();
        assert!(blockers.join(" ").contains("page 1: hierarchy, legibility not passed"));
        let mut old = scored(5);
        old["reviewToken"] = json!("old");
        assert_eq!(
            review_document_pages("docx", &old, &state()).expect("review")["blockers"],
            json!(["reviewToken is not the current render token"])
        );
        let mut unreviewed = scored(5);
        unreviewed["reviewed"] = json!(false);
        assert_eq!(
            review_document_pages("docx", &unreviewed, &state()).expect("review")["blockers"],
            json!(["design.reviewed is not true"])
        );
        let one = json!({ "reviewed": true, "reviewToken": "current", "critique": [{ "page": 1, "verdict": "pass", "note": "ok" }] });
        let short = review_document_pages("pdf", &one, &state()).expect("review");
        assert_eq!(short["blockers"][0], "1 critique entries for 2 rendered pages");
        assert_eq!(short["blockers"][1], "page 2: no critique entry for this page");
        assert!(review_document_pages("docx", &scored(5), &state()).expect("review").get("blockers").is_none());
    }

    #[test]
    fn a_refusal_lists_every_reason_of_a_page_in_order() {
        let design = json!({
            "reviewed": true, "reviewToken": "current",
            "critique": [{ "page": 1, "verdict": "fail", "legibility": false, "fixes": ["a"], "note": "  " }, page_entry(2, &[])]
        });
        let review = review_document_pages("docx", &design, &state()).expect("review");
        assert_eq!(
            review["blockers"][0],
            "page 1: verdict is \"fail\", not 'pass'; legibility not passed (true, or a score of 4 or 5); 1 unresolved fix(es) listed; note is empty"
        );
        assert_eq!(review["pages"][0]["checks"], json!({ "legibility": false }));
        assert_eq!(review["status"], "needs-work");
    }

    #[test]
    fn tabular_exports_do_not_acquire_a_paginated_review_requirement() {
        assert!(review_document_pages("csv", &json!({}), &json!({})).is_none());
        assert!(review_document_pages("tsv", &json!({}), &json!({})).is_none());
    }

    #[test]
    fn rendering_is_evidence_not_approval() {
        let unreviewed = assess_document_acceptance(&evidence(), None);
        assert_eq!(unreviewed["automatedReady"], true);
        assert_eq!(unreviewed["releaseReady"], false);
        assert_eq!(unreviewed["visualReview"]["status"], "not-reviewed");
        let acknowledged = json!({ "acknowledged": true, "status": "accepted" });
        assert_eq!(assess_document_acceptance(&evidence(), Some(&acknowledged))["releaseReady"], true);
        let mut blocked = evidence();
        blocked["blockingIssueCount"] = json!(1);
        assert_eq!(assess_document_acceptance(&blocked, Some(&acknowledged))["releaseReady"], false);
    }

    #[test]
    fn the_status_ladder_runs_from_not_reviewed_to_accepted() {
        assert_eq!(review_status(false, true, true), "not-reviewed");
        assert_eq!(review_status(true, false, true), "needs-work");
        assert_eq!(review_status(true, true, false), "not-acknowledged");
        assert_eq!(review_status(true, true, true), "accepted");
    }
}
