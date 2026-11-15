//! The review stage of finalize: the QA pass, the visual-review acceptance for decks and documents, and which of the remaining
//! issues hold the file back (`core/office-finalize/review-stage.mjs`).

use std::time::Instant;

use mixdog_fsio::WriteLane;
use mixdog_js::to_number;
use mixdog_office_base::values::truthy;
use mixdog_office_quality::design_review::critique::{pptx_visual_review_acknowledged, review_pptx_visual_critique};
use mixdog_office_quality::document_acceptance::{assess_document_acceptance, review_document_pages};
use mixdog_office_quality::presentation_acceptance::assess_presentation_acceptance;
use serde_json::{Value, json};

use super::StepMetrics;
use crate::actions::{Host, Machine};
use crate::batch::BatchHost;
use crate::render::RenderEngine;
use crate::session::SessionHandle;
use crate::session::open::SessionCloser;
use crate::session::registry::lock;
use crate::transactions::TransactionError;

/// A script-authored deck is judged by the model looking at rendered slides; the heuristic design reviews still report, but only
/// file integrity and missing review coverage can hold the deck back.
const AUTHORED_ADVISORY_SOURCES: [&str; 4] = ["design-review", "aesthetic-review", "frontier-design-review", "text-metrics"];

/// What a reader sees broken whatever the author meant: a chart or picture over filled cells, or over another drawing, hides them
/// on the page. An authored document's warnings are the model's call, and a financial model passed finalize with its chart laid
/// over the figures it was drawn from.
const VISIBLE_DEFECT_CODES: [&str; 2] = ["drawing_covers_cells", "drawing_overlap"];

/// What the review stage settled.
pub struct ReviewStage {
    /// The QA answer as it came.
    pub reviewed: Option<Value>,
    /// The QA answer without its pixels, with the acceptance verdicts merged in.
    pub review: Option<Value>,
    pub review_images: Vec<Value>,
    pub review_token: Value,
    pub visual_critique: Option<Value>,
    pub visual_review_acknowledged: bool,
    pub document_visual_review: Option<Value>,
    pub blocking_issues: Vec<Value>,
}

/// A Word document or workbook written to a brief (`design.brief`): reviewed with the deck's scored critique.
pub fn briefed_document(format: &str, brief: Option<&Value>) -> bool {
    matches!(format, "docx" | "xlsx") && brief.and_then(|brief| brief.get("present")) == Some(&Value::Bool(true))
}

/// `blocksFinalize(issue, { failOn, authored })`.
pub fn blocks_finalize(issue: &Value, fail_on: &str, authored: bool) -> bool {
    let text = |key: &str| issue.get(key).filter(|value| truthy(value)).map(mixdog_js::value_to_string).unwrap_or_default();
    let severity = text("severity");
    if VISIBLE_DEFECT_CODES.contains(&text("code").as_str()) && (severity == "error" || severity == "warning") {
        return true;
    }
    if authored && AUTHORED_ADVISORY_SOURCES.contains(&text("source").as_str()) {
        return false;
    }
    severity == "error" || (fail_on == "warning" && severity == "warning")
}

/// `Object.assign(target[key], assessment)` on the quality record of a review.
fn merge_quality(review: &mut Value, assessment: &Value) {
    let Some(quality) = review.get_mut("review").and_then(|inner| inner.get_mut("quality")).and_then(Value::as_object_mut) else { return };
    if let Value::Object(fields) = assessment {
        for (key, value) in fields {
            quality.insert(key.clone(), value.clone());
        }
    }
}

/// `quality.evidence` of a review record.
fn evidence_of(review: &Value) -> Option<Value> {
    review.pointer("/review/quality").filter(|quality| truthy(quality)).map(|quality| quality.get("evidence").cloned().unwrap_or(Value::Null))
}

/// `args.design?.[key]`.
fn design_arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get("design").and_then(|design| design.get(key))
}

fn apply_pptx_acceptance(handle: &SessionHandle, args: &Value, review: &mut Option<Value>) -> (Value, bool) {
    let session = lock(handle);
    // `Number(review?.preview?.pageCount || session.designState?.renderedPageCount || 0)`.
    let counted = review.as_ref().and_then(|review| review.pointer("/preview/pageCount")).filter(|count| truthy(count)).cloned();
    let counted = counted.or_else(|| session.design_state.rendered_page_count.clone().filter(truthy));
    let page_count = counted.as_ref().map_or(0.0, to_number);
    let present = session.authored.brief.as_ref().and_then(|brief| brief.get("present")) == Some(&Value::Bool(true));
    let critique = review_pptx_visual_critique(&json!({
        "critique": design_arg(args, "critique").cloned().unwrap_or(Value::Null),
        "pageCount": mixdog_js::json_number(page_count),
        "requireChecks": present,
    }));
    if let Some(fields) = review.as_mut().and_then(Value::as_object_mut) {
        fields.insert("visualCritique".to_owned(), critique.clone());
    }
    let expected = session.design_state.review_token.clone().filter(truthy).unwrap_or_else(|| json!(""));
    let acknowledged = pptx_visual_review_acknowledged(&json!({
        "reviewed": design_arg(args, "reviewed") == Some(&Value::Bool(true)),
        "providedToken": design_arg(args, "reviewToken").cloned().unwrap_or(Value::Null),
        "expectedToken": expected,
        "renderedVersion": session.design_state.rendered_version.clone(),
        "snapshotVersion": session.snapshot_version,
        "coverageComplete": session.design_state.rendered_coverage.as_ref().and_then(|coverage| coverage.get("complete")) == Some(&Value::Bool(true)),
        "critiqueOk": critique.get("ok") == Some(&Value::Bool(true)),
    }));
    if let Some(review) = review
        && let Some(evidence) = evidence_of(review)
    {
        merge_quality(review, &assess_presentation_acceptance(&evidence, acknowledged, Some(&critique)));
    }
    (critique, acknowledged)
}

fn apply_document_acceptance(handle: &SessionHandle, args: &Value, review: &mut Option<Value>) -> Option<Value> {
    let (format, state) = {
        let session = lock(handle);
        let mut state = session.design_state.to_value();
        if let Some(fields) = state.as_object_mut() {
            fields.insert("snapshotVersion".to_owned(), json!(session.snapshot_version));
        }
        (session.format.clone(), state)
    };
    let visual = review_document_pages(&format, args.get("design").unwrap_or(&Value::Null), &state)?;
    if let Some(fields) = review.as_mut().and_then(Value::as_object_mut) {
        fields.insert("visualReview".to_owned(), visual.clone());
    }
    if let Some(review) = review
        && let Some(evidence) = evidence_of(review)
    {
        merge_quality(review, &assess_document_acceptance(&evidence, Some(&visual)));
    }
    Some(visual)
}

impl<L: WriteLane, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, L, H, C, R, B> {
    /// `reviewForFinalize(session, args, cwd, { timedStep, failOn, authored })`.
    pub(crate) async fn review_for_finalize(&self, handle: &SessionHandle, args: &Value, cwd: &str, metrics: &mut StepMetrics, fail_on: &str, authored: bool) -> Result<ReviewStage, TransactionError> {
        let reviewed = if args.get("review") == Some(&Value::Bool(false)) {
            None
        } else {
            let started = Instant::now();
            let outcome = self.qa(handle, args, cwd, true).await;
            metrics.record("review", started);
            Some(outcome?)
        };
        // A reused preview is the render the caller already received with its token; only pixels this call produced are new evidence
        // worth sending again.
        let review_images: Vec<Value> = match &reviewed {
            Some(reviewed) if reviewed.pointer("/preview/reused") != Some(&Value::Bool(true)) => reviewed.get("_images").and_then(Value::as_array).cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut review = reviewed.clone();
        // A PDF of designed pages is reviewed as the deck it was measured as, and so is a Word document or workbook written to a
        // brief: five scores, a note, and checks from the brief per page.
        let (format, frame, brief_present, frame_top, review_token) = {
            let session = lock(handle);
            (
                session.format.clone(),
                session.authored.frame,
                briefed_document(&session.format, session.authored.brief.as_ref()),
                session.authored.frame_audit.as_ref().and_then(|audit| audit.get("top")).and_then(Value::as_array).cloned().unwrap_or_default(),
                session.design_state.review_token.clone().filter(truthy).unwrap_or_else(|| json!("")),
            )
        };
        let scored = frame || brief_present;
        let deck = format == "pptx" || scored;
        let pptx = if deck { Some(apply_pptx_acceptance(handle, args, &mut review)) } else { None };
        let document_visual_review = if scored { None } else { apply_document_acceptance(handle, args, &mut review) };
        if let Some(fields) = review.as_mut().and_then(Value::as_object_mut) {
            fields.shift_remove("_images");
        }
        let issues_after: Vec<Value> = review.as_ref().and_then(|review| review.get("issuesAfter")).and_then(Value::as_array).cloned().unwrap_or_default();
        let blocked: Vec<bool> = issues_after.iter().map(|issue| blocks_finalize(issue, fail_on, authored)).collect();
        let mut blocking_issues: Vec<Value> = issues_after.iter().zip(&blocked).filter(|(_, blocked)| **blocked).map(|(issue, _)| issue.clone()).collect();
        // Its measured audit ran on the deck at author time; an error it found holds the file as it would the deck.
        if frame {
            blocking_issues.extend(frame_top.iter().filter(|issue| issue.get("severity").and_then(Value::as_str) == Some("error")).cloned());
        }
        if authored && let Some(fields) = review.as_mut().and_then(Value::as_object_mut) {
            let advisory: Vec<Value> = issues_after
                .iter()
                .zip(&blocked)
                .filter(|(issue, blocked)| !**blocked && matches!(issue.get("severity").and_then(Value::as_str), Some("error" | "warning")) && !blocking_issues.contains(issue))
                .map(|(issue, _)| issue.clone())
                .collect();
            fields.insert("advisoryIssues".to_owned(), Value::Array(advisory));
        }
        Ok(ReviewStage {
            reviewed,
            review,
            review_images,
            review_token,
            visual_critique: pptx.as_ref().map(|(critique, _)| critique.clone()),
            visual_review_acknowledged: pptx.is_some_and(|(_, acknowledged)| acknowledged),
            document_visual_review,
            blocking_issues,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warning(code: &str, source: &str) -> Value {
        json!({ "severity": "warning", "code": code, "source": source })
    }

    // Port of `a drawing that hides cells or another drawing holds finalize even on an authored document`
    // (core/office-finalize/review-stage.test.mjs): a chart over the figures it was drawn from passed finalize on an authored
    // workbook, whose warnings are the model's call; a drawing that hides cells or another drawing holds the file back on every
    // document, other warnings do not.
    #[test]
    fn a_drawing_that_hides_cells_or_another_drawing_holds_finalize_even_on_an_authored_document() {
        assert!(blocks_finalize(&warning("drawing_covers_cells", "format-review"), "error", true));
        assert!(blocks_finalize(&warning("drawing_overlap", "format-review"), "error", true));
        assert!(!blocks_finalize(&warning("label_truncated", "column-fit"), "error", true), "other warnings stay advisory");
        assert!(!blocks_finalize(&json!({ "severity": "info", "code": "drawing_overlap" }), "error", true), "an info note never holds");
        assert!(blocks_finalize(&warning("label_truncated", "column-fit"), "warning", false));
        assert!(!blocks_finalize(&warning("low_contrast", "text-metrics"), "warning", true));
    }

    #[test]
    fn only_a_word_document_or_workbook_with_a_brief_is_briefed() {
        let brief = json!({ "present": true });
        assert!(briefed_document("docx", Some(&brief)));
        assert!(briefed_document("xlsx", Some(&brief)));
        assert!(!briefed_document("pptx", Some(&brief)));
        assert!(!briefed_document("docx", Some(&json!({ "present": false }))));
        assert!(!briefed_document("docx", None));
    }

    #[test]
    fn the_acceptance_verdict_is_merged_into_the_quality_record() {
        let mut review = json!({ "review": { "quality": { "score": 1, "evidence": { "pages": 2 } } } });
        merge_quality(&mut review, &json!({ "score": 2, "accepted": true }));
        assert_eq!(review["review"]["quality"], json!({ "score": 2, "evidence": { "pages": 2 }, "accepted": true }));
        assert_eq!(evidence_of(&review), Some(json!({ "pages": 2 })));
        assert_eq!(evidence_of(&json!({ "review": {} })), None);
    }
}
