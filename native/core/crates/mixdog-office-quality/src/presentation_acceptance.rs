//! `presentation-acceptance.mjs`: mechanical diagnostics and a current rendered review are independent evidence.
//! Neither a high pixel score nor an author's unacknowledged critique approves a deck.

use serde_json::{Value, json};

use crate::document_acceptance::{is_automated_ready, review_status};
use crate::{field, is_true, is_truthy};

/// `assessPresentationAcceptance(evidence, { acknowledged, critique })`.
pub fn assess_presentation_acceptance(evidence: &Value, acknowledged: bool, critique: Option<&Value>) -> Value {
    let automated_ready = is_automated_ready(evidence);
    let visual_status =
        review_status(is_truthy(critique), is_true(critique.and_then(|review| field(review, "ok"))), acknowledged);
    json!({
        "scoreMeaning": "automated-diagnostics-not-design-quality",
        "automatedReady": automated_ready,
        "visualReview": {
            "status": visual_status,
            "required": true,
            "basis": "current-render-and-slide-specific-critique",
        },
        "releaseReady": automated_ready && visual_status == "accepted",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> Value {
        json!({ "structuralAvailable": true, "expectedPages": 5, "pageCoverage": 1, "blockingIssueCount": 0 })
    }

    #[test]
    fn a_current_accepted_visual_review_is_required_independently_of_perfect_diagnostics() {
        let accepted = assess_presentation_acceptance(&evidence(), true, Some(&json!({ "ok": true })));
        assert_eq!(accepted["releaseReady"], true);
        assert_eq!(accepted["visualReview"]["status"], "accepted");
        for (acknowledged, critique) in [(true, None), (true, Some(json!({ "ok": false }))), (false, Some(json!({ "ok": true })))] {
            let verdict = assess_presentation_acceptance(&evidence(), acknowledged, critique.as_ref());
            assert_eq!(verdict["releaseReady"], false);
        }
    }

    #[test]
    fn visual_approval_cannot_replace_missing_coverage_or_override_diagnostic_warnings() {
        for partial in [
            json!({ "structuralAvailable": false }),
            json!({ "expectedPages": 0 }),
            json!({ "pageCoverage": 0.8 }),
            json!({ "blockingIssueCount": 1 }),
        ] {
            let mut merged = evidence();
            for (key, value) in partial.as_object().expect("object") {
                merged[key.as_str()] = value.clone();
            }
            let result = assess_presentation_acceptance(&merged, true, Some(&json!({ "ok": true })));
            assert_eq!(result["automatedReady"], false);
            assert_eq!(result["visualReview"]["status"], "accepted");
            assert_eq!(result["releaseReady"], false);
        }
    }

    #[test]
    fn a_critique_that_is_not_ok_needs_work_and_none_is_not_reviewed() {
        let needs = assess_presentation_acceptance(&evidence(), false, Some(&json!({ "ok": false })));
        assert_eq!(needs["visualReview"]["status"], "needs-work");
        let none = assess_presentation_acceptance(&evidence(), true, None);
        assert_eq!(none["visualReview"]["status"], "not-reviewed");
        assert_eq!(none["scoreMeaning"], "automated-diagnostics-not-design-quality");
    }
}
