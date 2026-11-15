//! The reasons finalize holds a file back, in the order they are checked, and the shape every hold result shares
//! (`core/office-finalize/holds.mjs`).

use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use super::StepMetrics;
use super::review_stage::ReviewStage;

/// What a hold result is built from.
pub struct HoldContext<'a> {
    pub session: &'a str,
    pub fail_on: &'a str,
    pub recalculation: &'a Value,
    pub metrics: &'a StepMetrics,
    pub requires_visual_review: bool,
}

/// `finalizeHold(context, reason, extra)`.
pub fn finalize_hold(context: &HoldContext<'_>, reason: &str, extra: Vec<(&str, Value)>) -> Value {
    let mut hold = Map::new();
    hold.insert("ok".to_owned(), Value::Bool(false));
    hold.insert("finalized".to_owned(), Value::Bool(false));
    hold.insert("session".to_owned(), Value::String(context.session.to_owned()));
    hold.insert("reason".to_owned(), Value::String(reason.to_owned()));
    hold.insert("failOn".to_owned(), Value::String(context.fail_on.to_owned()));
    hold.insert("recalculation".to_owned(), context.recalculation.clone());
    for (key, value) in extra {
        hold.insert(key.to_owned(), value);
    }
    hold.insert("stepMetrics".to_owned(), context.metrics.to_value());
    Value::Object(hold)
}

/// The first review-time hold: outstanding issues, formula errors, or a visual review that was required but not acknowledged. `None`
/// when the file may move on to save and validation.
pub fn review_hold(context: &HoldContext<'_>, args: &Value, stage: &ReviewStage) -> Option<Value> {
    let review = stage.review.clone().unwrap_or(Value::Null);
    let images = Value::Array(stage.review_images.clone());
    let with_review = |reason: &str, mut extra: Vec<(&str, Value)>| {
        let mut fields = vec![("review", review.clone())];
        fields.append(&mut extra);
        fields.push(("_images", images.clone()));
        finalize_hold(context, reason, fields)
    };
    if !stage.blocking_issues.is_empty() {
        return Some(finalize_hold(
            context,
            "review_issues",
            vec![
                ("blockingIssues", Value::Array(stage.blocking_issues.clone())),
                ("review", review.clone()),
                ("nextAction", json!("Fix the reported issues with one batch, then call finalize again.")),
                ("_images", images.clone()),
            ],
        ));
    }
    // Zero formula errors is a hard rule: a recalculation that found any holds the workbook even when the review was skipped.
    if context.recalculation.get("totalErrors").is_some_and(|errors| mixdog_js::to_number(errors) > 0.0) {
        return Some(with_review(
            "formula_errors",
            vec![(
                "nextAction",
                json!("Recalculation found formula errors; recalculation.errorSummary lists the cells by error type. Trace each to its inputs, fix the formula, then finalize again."),
            )],
        ));
    }
    if context.requires_visual_review && !stage.visual_review_acknowledged {
        return Some(with_review(
            "visual_review_required",
            vec![
                ("reviewToken", stage.review_token.clone()),
                ("visualCritique", stage.visual_critique.clone().unwrap_or(Value::Null)),
                (
                    "nextAction",
                    json!("Inspect every rendered slide and submit one distinct critique per slide with verdict, hierarchy, balance, legibility, cohesion, evidence, note, and fixes. Polish any failed slide, render again if changed, then finalize with the review token."),
                ),
            ],
        ));
    }
    if let Some(visual) = &stage.document_visual_review
        && args.get("review") != Some(&Value::Bool(false))
        && visual.get("acknowledged").is_none_or(|acknowledged| !truthy(acknowledged))
    {
        let blockers = visual.get("blockers").and_then(Value::as_array).filter(|blockers| !blockers.is_empty()).map_or_else(String::new, |blockers| {
            let joined: Vec<String> = blockers.iter().map(mixdog_js::value_to_string).collect();
            format!("Review not accepted \u{2014} {}. ", joined.join(" \u{b7} "))
        });
        let checks: Vec<String> = visual.get("checks").and_then(Value::as_array).map(|checks| checks.iter().map(mixdog_js::value_to_string).collect()).unwrap_or_default();
        return Some(with_review(
            "visual_review_required",
            vec![
                ("reviewToken", stage.review_token.clone()),
                ("visualReview", visual.clone()),
                (
                    "nextAction",
                    json!(format!(
                        "{blockers}Inspect the actual pages for {}. Record specific keep/fix observations, not checkbox assertions. Correct material issues and rerender. Then submit design.reviewed:true, design.reviewToken and design.critique with one {{page, verdict:'pass', note}} per page; unresolved fixes cannot be accepted. This records agent review, not user approval.",
                        checks.join(", ")
                    )),
                ),
            ],
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(blocking: Vec<Value>) -> ReviewStage {
        ReviewStage {
            reviewed: None,
            review: Some(json!({ "ok": true })),
            review_images: vec![json!({ "page": 1 })],
            review_token: json!("tok"),
            visual_critique: None,
            visual_review_acknowledged: false,
            document_visual_review: None,
            blocking_issues: blocking,
        }
    }

    fn context<'a>(recalculation: &'a Value, metrics: &'a StepMetrics, requires: bool) -> HoldContext<'a> {
        HoldContext { session: "office_1", fail_on: "error", recalculation, metrics, requires_visual_review: requires }
    }

    #[test]
    fn a_hold_has_the_shared_shape_and_keeps_its_extras_in_order() {
        let (recalculation, metrics) = (Value::Null, StepMetrics::default());
        let hold = finalize_hold(&context(&recalculation, &metrics, false), "validation_failed", vec![("nextAction", json!("x"))]);
        assert_eq!(
            mixdog_js::json_stringify(&hold),
            r#"{"ok":false,"finalized":false,"session":"office_1","reason":"validation_failed","failOn":"error","recalculation":null,"nextAction":"x","stepMetrics":{}}"#
        );
    }

    #[test]
    fn issues_come_before_formula_errors_before_the_visual_review() {
        let metrics = StepMetrics::default();
        let errors = json!({ "needed": true, "totalErrors": 2 });
        let held = review_hold(&context(&errors, &metrics, true), &json!({}), &stage(vec![json!({ "code": "a" })])).expect("a hold");
        assert_eq!(held["reason"], "review_issues");
        assert_eq!(held["blockingIssues"], json!([{ "code": "a" }]));
        assert_eq!(held["_images"], json!([{ "page": 1 }]));
        let held = review_hold(&context(&errors, &metrics, true), &json!({}), &stage(Vec::new())).expect("a hold");
        assert_eq!(held["reason"], "formula_errors");
        let none = Value::Null;
        let held = review_hold(&context(&none, &metrics, true), &json!({}), &stage(Vec::new())).expect("a hold");
        assert_eq!(held["reason"], "visual_review_required");
        assert_eq!(held["reviewToken"], "tok");
        assert!(review_hold(&context(&none, &metrics, false), &json!({}), &stage(Vec::new())).is_none());
    }

    #[test]
    fn a_document_review_that_is_not_accepted_says_what_blocks_it() {
        let metrics = StepMetrics::default();
        let none = Value::Null;
        let mut open = stage(Vec::new());
        open.document_visual_review = Some(json!({ "acknowledged": false, "blockers": ["page 2 missing", "no token"], "checks": ["fit", "contrast"] }));
        let held = review_hold(&context(&none, &metrics, false), &json!({}), &open).expect("a hold");
        let action = held["nextAction"].as_str().expect("text");
        assert!(action.starts_with("Review not accepted \u{2014} page 2 missing \u{b7} no token. Inspect the actual pages for fit, contrast."), "{action}");
        assert!(review_hold(&context(&none, &metrics, false), &json!({ "review": false }), &open).is_none());
    }
}
