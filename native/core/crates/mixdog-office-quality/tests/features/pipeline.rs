//! The polish plan and the submission gate built from the issues of a review.

use mixdog_office_quality::pipeline::{build_office_polish_plan, evaluate_office_submission_gate, normalize_office_review_issues};
use serde_json::{Value, json};

fn issue(code: &str, severity: &str, path: &str) -> Value {
    json!({ "code": code, "severity": severity, "path": path, "message": format!("{code} at {path}") })
}

#[test]
fn the_polish_plan_lists_errors_first_then_paths_and_one_target_per_path() {
    let issues = vec![
        issue("first_kind", "warning", "/b"),
        issue("custom_fault", "error", "/z"),
        issue("second_kind", "warning", "/a"),
        issue("third_kind", "warning", "/a"),
        issue("first_kind", "warning", "/b"),
    ];
    let plan = build_office_polish_plan("PPTX", &issues);
    assert_eq!(plan["format"], "pptx");
    assert_eq!(plan["status"], "needs-polish");
    assert_eq!(plan["targetCount"], 3);
    assert_eq!(plan["criticalCount"], 1);
    let targets = plan["targets"].as_array().expect("targets");
    let paths: Vec<&str> = targets.iter().map(|target| target["path"].as_str().expect("path")).collect();
    assert_eq!(paths, ["/z", "/a", "/b"]);
    assert_eq!(targets[0]["severity"], "error");
    assert_eq!(targets[1]["codes"], json!(["second_kind", "third_kind"]));
    assert_eq!(
        targets[2]["actions"],
        json!(["Correct first_kind at /b, then render and inspect the affected page again."]),
        "a repeated record is one action"
    );
    assert_eq!(plan["nextAction"], "Edit only the reported targets in one atomic batch, render the changed pages, then run QA again.");
}

#[test]
fn a_plan_with_nothing_to_fix_passes() {
    let plan = build_office_polish_plan("docx", &[issue("vertical_imbalance", "warning", "/p")]);
    assert_eq!(plan["status"], "pass");
    assert_eq!(plan["targetCount"], 0);
    assert_eq!(plan["nextAction"], "No targeted polish remains.");
}

#[test]
fn a_record_that_is_not_an_object_is_dropped_and_a_repeat_is_kept_once() {
    let entries = vec![json!("text"), json!(null), issue("a_kind", "warning", "/p"), issue("a_kind", "warning", "/p")];
    assert_eq!(normalize_office_review_issues(&entries).len(), 1);
}

#[test]
fn an_error_blocks_the_submission_and_a_warning_does_not() {
    let warnings = evaluate_office_submission_gate(&[issue("a_kind", "warning", "/p")], &json!(true), &json!({ "complete": true }));
    assert_eq!(warnings["ok"], true);
    assert_eq!(warnings["criticalCount"], 0);
    let errors = evaluate_office_submission_gate(&[issue("custom_fault", "error", "/p")], &json!(true), &json!({ "complete": true }));
    assert_eq!(errors["ok"], false);
    assert_eq!(errors["criticalCount"], 1);
    assert_eq!(errors["blocking"][0]["code"], "custom_fault");
}

#[test]
fn a_saved_document_that_was_not_reopened_or_a_render_that_missed_pages_blocks_the_submission() {
    let gate = evaluate_office_submission_gate(&[], &json!(false), &json!({ "complete": false }));
    assert_eq!(gate["ok"], false);
    assert_eq!(gate["persisted"], false);
    assert_eq!(gate["criticalCount"], 2);
    let blocking = gate["blocking"].as_array().expect("blocking");
    assert_eq!(blocking[0]["code"], "post_save_reopen_missing");
    assert_eq!(blocking[0]["message"], "The saved Office document was not reopened, so persistence is unproven.");
    assert_eq!(blocking[1]["code"], "visual_coverage_incomplete");
    assert_eq!(blocking[1]["message"], "Not every rendered page or slide was reviewed.");
    // No coverage record at all is not a coverage failure.
    assert_eq!(evaluate_office_submission_gate(&[], &json!(true), &Value::Null)["ok"], true);
}
