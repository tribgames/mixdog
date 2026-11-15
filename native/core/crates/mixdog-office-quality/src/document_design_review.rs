//! The design review of a natively authored Word document, workbook or PDF. Ported from
//! `src/runtime/office/quality/document-design-review.mjs`: the structural diagnostics of the document wrapped with the
//! reading guidance of its format, marked as diagnostics only (a pass is not a design approval and not the user's
//! acceptance).
//!
//! The diagnostics themselves are `reviewOfficeStructure({ format, document, auditProfile })` (the structure review of
//! this crate); the caller passes the issues it answered, so this module owns the wrapping and the wording only.

use serde_json::{Value, json};

use crate::field;

/// `GUIDANCE[format]`: the lines a reviewer reads before judging the rendered pages of that format.
fn guidance(format: &str) -> &'static [&'static str] {
    match format {
        "docx" => &[
            "Read the actual pages as the intended genre: essay, letter, report, or reference; do not impose an executive-summary structure.",
            "Judge typography, body width, paragraph rhythm, heading emphasis and page transitions together.",
            "Name visible problems by page and element. Fix their layout cause rather than deleting content to fit a preset.",
        ],
        "xlsx" => &[
            "Read the report surface separately from the working grid: findings, chart meaning, units and editable inputs must be clear.",
            "Inspect calculated values, native chart labels, column proportions and the saved print area.",
            "Keep calculation integrity distinct from visual judgement; a compact working sheet does not need presentation decoration.",
        ],
        "pdf" => &[
            "Judge the actual fixed pages for reading order, typography, spacing and clipping.",
            "For edits, compare against the source and preserve its visual system; for new work, follow the stated reading purpose.",
            "Inspect page transitions, tables, images, forms and annotations in their rendered positions.",
        ],
        _ => &[],
    }
}

/// `reviewNativeDocumentDesign(format, document, auditProfile)` over the structure issues already read from the
/// document: `ok` when none is an error, always `diagnostics-only` and always asking for a visual inspection.
pub fn review_native_document_design(format: &str, issues: Vec<Value>) -> Value {
    let ok = !issues.iter().any(|issue| field(issue, "severity").and_then(Value::as_str) == Some("error"));
    let mut model_review: Vec<&str> = guidance(format).to_vec();
    model_review.push(
        "A diagnostic pass is not a design approval. Inspect images with fresh eyes, record concrete keep/fix observations, and rerender material changes.",
    );
    model_review.push("The agent review is not the user acceptance. Do not infer user approval from a score or completed checklist.");
    json!({
        "ok": ok,
        "status": "diagnostics-only",
        "authoring": "native",
        "issues": issues,
        "requiresVisualInspection": true,
        "modelReview": model_review,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_issue_fails_the_review_and_every_review_stays_diagnostics_only() {
        let clean = review_native_document_design("docx", vec![json!({ "severity": "warning", "code": "x" })]);
        assert_eq!(clean["ok"], true);
        assert_eq!(clean["status"], "diagnostics-only");
        assert_eq!(clean["modelReview"].as_array().unwrap().len(), 5);
        let failed = review_native_document_design("xlsx", vec![json!({ "severity": "error" })]);
        assert_eq!(failed["ok"], false);
        let other = review_native_document_design("odt", Vec::new());
        assert_eq!(other["modelReview"].as_array().unwrap().len(), 2);
        assert_eq!(other["requiresVisualInspection"], true);
    }
}
