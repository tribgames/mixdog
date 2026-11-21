//! The measured read that rides on every mutating action (`quality/inline-audit.mjs`). `author` and `batch` attach it so a fit,
//! bounds, contrast, spacing, or package fault is visible in the turn that caused it, and the fix loop is counted where it
//! happens: a failing audit is answered in the same turn, only a pass counts as done, and after two fix rounds the residue is
//! reported instead of polished a third time. `qa` still owns the full review (design read, render read, checklist).
//!
//! It lives in the engine because it calls [`crate::inspect::issues`].

use std::sync::LazyLock;

use mixdog_fsio::WriteProof;
use mixdog_js::{JsRegex, json_number, locale_compare, number_to_string, to_number, value_to_string};
use mixdog_office_base::formats::is_ooxml_format;
use mixdog_office_base::values::truthy;
use mixdog_office_quality::pipeline::normalize_office_review_issues;
use serde_json::{Map, Value, json};

use crate::inspect::{InspectContext, issues};
use crate::session::registry::lock;
use crate::session::{Session, SessionHandle};
use crate::snapshot::ComHost;

pub const INLINE_AUDIT_TOP: usize = 12;
pub const INLINE_AUDIT_MAX_ROUNDS: u64 = 2;

static LOCATION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\/(slide|page|sheet|body)(?:\[([^\]]+)\])?", ""));
static DIGITS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d+$", ""));

/// The slide operations that renumber the pages: a batch with one of them reads the whole deck.
const STRUCTURAL_SLIDE_OPERATIONS: [&str; 7] =
    ["add_slide", "duplicate_slide", "delete_slide", "move_slide", "keep_slides", "import_slides", "use_template_page"];

/// The unit a fix is addressed to: a slide, a sheet, a PDF page, the Word body, or the package itself.
struct Location {
    key: String,
    label: String,
    /// `slide`, `page` or `sheet`, with the number or the name it carries.
    unit: Option<(&'static str, Value)>,
}

/// `String(value)` of a field that may be absent.
fn template_text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

fn location_of(path: Option<&Value>) -> Location {
    let text = match path {
        Some(path) if truthy(path) => value_to_string(path),
        _ => String::new(),
    };
    let Some(found) = LOCATION.captures(&text) else { return Location { key: "/".to_owned(), label: "document".to_owned(), unit: None } };
    let kind = found.get(1).unwrap_or_default();
    if kind == "body" {
        return Location { key: "/body".to_owned(), label: "body".to_owned(), unit: None };
    }
    let id = found.get(2).unwrap_or_default();
    let label = if id.is_empty() { kind.to_owned() } else { format!("{kind} {id}") };
    let unit = match kind {
        "slide" if DIGITS.is_match(id) => Some(("slide", json_number(id.parse::<f64>().unwrap_or(f64::NAN)))),
        "page" if DIGITS.is_match(id) => Some(("page", json_number(id.parse::<f64>().unwrap_or(f64::NAN)))),
        "sheet" if !id.is_empty() => Some(("sheet", Value::String(id.to_owned()))),
        _ => None,
    };
    Location { key: format!("/{kind}[{id}]"), label, unit }
}

/// The locations a batch touched, read from its operations, so the audit lists their defects first: what the author just
/// changed is what the author is looking at.
pub fn touched_locations(format: &str, operations: &[Value]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let mut add = |key: String| {
        if !keys.contains(&key) {
            keys.push(key);
        }
    };
    for operation in operations {
        if !matches!(operation, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        match format {
            "pptx" => {
                let number = |value: Option<&Value>| value.map_or(f64::NAN, to_number);
                if number(operation.get("slide")) > 0.0 {
                    add(format!("/slide[{}]", number_to_string(number(operation.get("slide")))));
                }
                if let Some(Value::Array(slides)) = operation.get("slides") {
                    for slide in slides {
                        if to_number(slide) > 0.0 {
                            add(format!("/slide[{}]", number_to_string(to_number(slide))));
                        }
                    }
                }
            }
            "xlsx" => {
                if let Some(sheet) = operation.get("sheet").filter(|sheet| truthy(sheet)) {
                    add(format!("/sheet[{}]", value_to_string(sheet)));
                }
            }
            "docx" => add("/body".to_owned()),
            _ => {}
        }
    }
    keys
}

fn severity_rank(issue: &Value) -> u8 {
    match issue.get("severity").and_then(Value::as_str) {
        Some("error") => 0,
        Some("warning") => 1,
        _ => 2,
    }
}

/// One location's counts in the order its first finding was met.
struct Group {
    location: Location,
    error: u64,
    warning: u64,
    info: u64,
}

/// `summarizeOfficeAudit(issueList, { touched })`: the findings counted, grouped by location and the twelve a fix must answer.
pub fn summarize_office_audit(issue_list: &[Value], touched: &[String]) -> Value {
    let normalized = normalize_office_review_issues(issue_list);
    let (counts, groups, location_keys) = tally_by_location(&normalized);
    let (top, actionable) = top_actionable(&normalized, &location_keys, touched);
    let locations = location_rows(&groups, touched);
    let truncated = actionable.saturating_sub(top.len());
    json!({
        "status": if actionable == 0 { "pass" } else { "fail" },
        "counts": { "error": counts[0], "warning": counts[1], "info": counts[2] },
        "locations": locations,
        "top": top,
        "truncated": truncated,
    })
}

/// The severity counts, the per-location counts in the order each location's first finding was met, and every finding's location key.
fn tally_by_location(normalized: &[Value]) -> ([u64; 3], Vec<Group>, Vec<String>) {
    let mut counts = [0_u64; 3];
    let mut groups: Vec<Group> = Vec::new();
    let mut location_keys: Vec<String> = Vec::with_capacity(normalized.len());
    for issue in normalized {
        // Only the three counted severities are severities: a name an object inherits ("toString") is not one.
        let slot = match issue.get("severity").and_then(Value::as_str) {
            Some("error") => 0,
            Some("info") => 2,
            _ => 1,
        };
        counts[slot] += 1;
        let location = location_of(issue.get("path"));
        location_keys.push(location.key.clone());
        let at = match groups.iter().position(|group| group.location.key == location.key) {
            Some(at) => at,
            None => {
                groups.push(Group { location, error: 0, warning: 0, info: 0 });
                groups.len() - 1
            }
        };
        let group = &mut groups[at];
        match slot {
            0 => group.error += 1,
            1 => group.warning += 1,
            _ => group.info += 1,
        }
    }
    (counts, groups, location_keys)
}

/// The twelve findings a fix must answer, touched locations first, then the number of findings that are not advisory.
fn top_actionable(normalized: &[Value], location_keys: &[String], touched: &[String]) -> (Vec<Value>, usize) {
    let is_touched = |key: &str| touched.iter().any(|entry| entry == key);
    // Advisory findings stay readable in qa; the audit lists only what a fix must answer.
    let mut actionable: Vec<(&Value, bool)> = normalized
        .iter()
        .zip(location_keys)
        .filter(|(issue, _)| issue.get("severity").and_then(Value::as_str) != Some("info"))
        .map(|(issue, key)| (issue, is_touched(key)))
        .collect();
    actionable.sort_by(|(left, left_touched), (right, right_touched)| {
        right_touched
            .cmp(left_touched)
            .then_with(|| severity_rank(left).cmp(&severity_rank(right)))
            .then_with(|| locale_compare(&template_text(left.get("path")), &template_text(right.get("path"))))
    });
    let top: Vec<Value> = actionable
        .iter()
        .take(INLINE_AUDIT_TOP)
        .map(|(issue, _)| {
            let mut entry = Map::new();
            for key in ["severity", "code", "path", "message"] {
                if let Some(value) = issue.get(key) {
                    entry.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(entry)
        })
        .collect();
    (top, actionable.len())
}

/// The locations that hold an error or a warning, touched ones first, then by error and warning count.
fn location_rows(groups: &[Group], touched: &[String]) -> Vec<Value> {
    let is_touched = |key: &str| touched.iter().any(|entry| entry == key);
    let mut shown: Vec<&Group> = groups.iter().filter(|group| group.error > 0 || group.warning > 0).collect();
    shown.sort_by(|left, right| {
        is_touched(&right.location.key)
            .cmp(&is_touched(&left.location.key))
            .then_with(|| right.error.cmp(&left.error))
            .then_with(|| right.warning.cmp(&left.warning))
            .then_with(|| locale_compare(&left.location.key, &right.location.key))
    });
    shown
        .into_iter()
        .map(|group| {
            let mut entry = Map::new();
            entry.insert("label".to_owned(), json!(group.location.label));
            if let Some((unit, value)) = &group.location.unit {
                entry.insert((*unit).to_owned(), value.clone());
            }
            entry.insert("error".to_owned(), json!(group.error));
            entry.insert("warning".to_owned(), json!(group.warning));
            entry.insert("info".to_owned(), json!(group.info));
            Value::Object(entry)
        })
        .collect()
}

fn plural(count: u64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn count_of(audit: &Value, key: &str) -> u64 {
    audit.pointer(&format!("/counts/{key}")).and_then(Value::as_u64).unwrap_or(0)
}

fn next_action_for(audit: &Value, format: &str) -> String {
    if audit.get("status").and_then(Value::as_str) == Some("pass") {
        if let Some(outside) = audit.get("outsideEdit").and_then(Value::as_u64).filter(|outside| *outside > 0) {
            return format!(
                "The edited slides pass. {outside} measured finding{} sit on slides this batch did not touch and belong to the deck as opened; leave them unless the user asked for those pages. Continue to the render and the visual read.",
                plural(outside)
            );
        }
        return "Audit passed: no measured defect remains. Continue to the render and the visual read; finalize needs both.".to_owned();
    }
    let count = count_of(audit, "error") + count_of(audit, "warning");
    if ["docx", "xlsx", "pdf"].contains(&format) {
        return format!(
            "Inspect the {count} reported finding{} at their document locations. Fix material defects with targeted edits, then inspect the changed result. Keep automated diagnostics separate from visual judgement; neither a fixed round count nor a diagnostic pass decides design acceptance.",
            if count == 1 { "" } else { "s" }
        );
    }
    let round = audit.get("round").and_then(Value::as_u64).unwrap_or(0);
    if round > INLINE_AUDIT_MAX_ROUNDS {
        return format!(
            "Audit still fails after {INLINE_AUDIT_MAX_ROUNDS} fix rounds ({count} measured defect{}). Stop polishing: report what remains with the deliverable instead of a further pass.",
            plural(count)
        );
    }
    format!(
        "Fix the {count} measured defect{} in this same turn — re-author the script or batch the reported targets — and read the audit that call returns; only an audit pass counts as done (fix round {round} of {INLINE_AUDIT_MAX_ROUNDS}).",
        plural(count)
    )
}

/// `recordInlineAuditRound(session, audit)`: rounds count consecutive failing audits on the same deck; a pass resets them. The
/// counter lives on the session and is carried across a re-author that replaces the session, since the loop belongs to the deck.
pub fn record_inline_audit_round(session: &mut Session, mut audit: Value) -> Value {
    let previous = session.caches.inline_audit.as_ref().and_then(|record| record.get("rounds")).and_then(Value::as_u64).unwrap_or(0);
    let rounds = if audit.get("status").and_then(Value::as_str) == Some("pass") { 0 } else { previous + 1 };
    session.caches.inline_audit = Some(json!({ "rounds": rounds }));
    if let Value::Object(fields) = &mut audit {
        fields.insert("round".to_owned(), json!(rounds));
    }
    let next_action = next_action_for(&audit, &session.format);
    if let Value::Object(fields) = &mut audit {
        fields.insert("nextAction".to_owned(), json!(next_action));
    }
    audit
}

/// The measured findings minus the excluded codes. A formula this batch wrote has no cached value until the next recalculation, which
/// render, qa and finalize run first, so its finding is read as advisory here and stays a finding in qa and issues.
fn reportable_findings(measured: &Value, exclude: &[String]) -> Vec<Value> {
    let Some(Value::Array(found)) = measured.get("issues") else { return Vec::new() };
    found
        .iter()
        .map(|issue| match issue {
            Value::Object(fields) if issue.get("code").and_then(Value::as_str) == Some("formula_cache_missing") => {
                let mut fields = fields.clone();
                fields.insert("severity".to_owned(), json!("info"));
                Value::Object(fields)
            }
            _ => issue.clone(),
        })
        .filter(|issue| !issue.get("code").and_then(Value::as_str).is_some_and(|code| exclude.iter().any(|excluded| excluded == code)))
        .collect()
}

/// Keeps the findings on the touched locations and on the package itself and answers how many non-advisory findings it dropped from the
/// pages the batch left alone.
fn drop_findings_outside_edit(list: &mut Vec<Value>, touched: &[String]) -> u64 {
    let in_scope = |issue: &Value| {
        let key = location_of(issue.get("path")).key;
        key == "/" || touched.contains(&key)
    };
    let outside = list.iter().filter(|issue| issue.get("severity").and_then(Value::as_str) != Some("info") && !in_scope(*issue)).count() as u64;
    list.retain(in_scope);
    outside
}

/// `inlineOfficeAudit(session, { operations, exclude })`: the measured read of the document after a mutation. A mutation that
/// landed is never failed by its audit: an inspection error is reported as unavailable so the author falls back to `qa`. `None`
/// for a format with no package to measure. `exclude` lists the finding codes that do not apply to what the reader receives (a
/// PDF the browser printed is not held to PowerPoint's text metrics).
pub async fn inline_office_audit<P: WriteProof, H: ComHost>(
    cx: &InspectContext<'_, P, H>,
    handle: &SessionHandle,
    operations: &[Value],
    exclude: &[String],
) -> Option<Value> {
    let (format, authored) = {
        let session = lock(handle);
        (session.format.clone(), session.authored.authored)
    };
    if !is_ooxml_format(&format) {
        return None;
    }
    let measured = match issues(cx, handle, &json!({})).await {
        Ok(measured) => measured,
        Err(reason) => {
            return Some(json!({
                "status": "unavailable",
                "reason": reason,
                "nextAction": "The measured audit could not run on this change; call action:qa render:false before relying on it.",
            }));
        }
    };
    let touched = touched_locations(&format, operations);
    let mut list = reportable_findings(&measured, exclude);
    let structural = operations.iter().any(|operation| operation.get("op").and_then(Value::as_str).is_some_and(|op| STRUCTURAL_SLIDE_OPERATIONS.contains(&op)));
    let outside_edit = if format == "pptx" && !authored && !touched.is_empty() && !structural { drop_findings_outside_edit(&mut list, &touched) } else { 0 };
    let mut audit = summarize_office_audit(&list, &touched);
    if outside_edit > 0
        && let Value::Object(fields) = &mut audit
    {
        fields.insert("outsideEdit".to_owned(), json!(outside_edit));
    }
    let mut session = lock(handle);
    Some(record_inline_audit_round(&mut session, audit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Backend, DesignState, Mode, SessionInit};

    fn session(format: &str) -> Session {
        Session::new(SessionInit {
            id: "office_x".to_owned(),
            source: String::new(),
            target: String::new(),
            file_kind: format.to_owned(),
            format: format.to_owned(),
            mode: Mode::Portable,
            backend: Backend::MixdogOoxml,
            opened_at: String::new(),
            data_dir: std::path::PathBuf::new(),
            created: false,
            created_new_file: None,
            design_state: DesignState::default(),
        })
    }

    fn finding(severity: &str, code: &str, path: &str, message: &str) -> Value {
        json!({ "severity": severity, "code": code, "path": path, "message": message })
    }

    // Port of `summarizeOfficeAudit ranks touched locations first, drops advisories from the targets, and caps the list`.
    #[test]
    fn summarize_ranks_touched_locations_first_drops_advisories_and_caps_the_list() {
        let mut list = vec![
            finding("warning", "text_overflow", "/slide[3]/shape[2]", "over"),
            finding("error", "missing_relationship", "/ppt/slides/_rels/slide1.xml.rels", "rel"),
            finding("info", "shapes_too_close", "/slide[1]/shape[1]", "close"),
            finding("warning", "low_contrast", "/slide[1]/shape[4]", "dim"),
        ];
        for index in 0..INLINE_AUDIT_TOP + 3 {
            list.push(finding("warning", "text_overflow", &format!("/slide[{}]/shape[1]", index + 4), &format!("over {index}")));
        }
        let audit = summarize_office_audit(&list, &["/slide[3]".to_owned()]);
        assert_eq!(audit["status"], "fail");
        // Words a box cannot hold are a measured defect, so every text_overflow here counts as an error beside the broken
        // relationship; only the contrast call stays a warning and the advisory stays out of the targets.
        assert_eq!(audit["counts"], json!({ "error": INLINE_AUDIT_TOP + 5, "warning": 1, "info": 1 }));
        let top = audit["top"].as_array().expect("top");
        assert_eq!(top.len(), INLINE_AUDIT_TOP);
        assert_eq!(top[0]["path"], "/slide[3]/shape[2]");
        assert_eq!(top[1]["code"], "missing_relationship");
        assert!(top.iter().all(|issue| issue["severity"] != "info"));
        assert_eq!(audit["truncated"], 6);
        let locations = audit["locations"].as_array().expect("locations");
        assert_eq!(locations[0]["slide"], 3);
        assert_eq!(locations.iter().find(|entry| entry["label"] == "document").expect("document")["error"], 1);
        assert!(!locations.iter().any(|entry| entry["slide"] == 1 && entry["warning"] == 0));

        let clean = summarize_office_audit(&[finding("info", "shapes_too_close", "/slide[1]/shape[1]", "close")], &[]);
        assert_eq!(clean["status"], "pass");
        assert_eq!(clean["top"], json!([]));
        assert_eq!(clean["locations"], json!([]));
    }

    // Port of `summarizeOfficeAudit keeps a prototype name out of the severity counts`.
    #[test]
    fn summarize_keeps_a_prototype_name_out_of_the_severity_counts() {
        let audit = summarize_office_audit(&[finding("toString", "low_contrast", "/slide[1]/shape[1]", "dim")], &[]);
        assert_eq!(audit["counts"], json!({ "error": 0, "warning": 1, "info": 0 }));
        assert_eq!(audit["locations"], json!([{ "label": "slide 1", "slide": 1, "error": 0, "warning": 1, "info": 0 }]));
    }

    // Port of `touchedLocations reads the edited slide, sheet, or body from the batch operations`.
    #[test]
    fn touched_locations_read_the_edited_slide_sheet_or_body() {
        let deck = [json!({ "op": "set_text", "slide": 2, "shape": 1 }), json!({ "op": "keep_slides", "slides": [1, 4] })];
        assert_eq!(touched_locations("pptx", &deck), ["/slide[2]", "/slide[1]", "/slide[4]"]);
        assert_eq!(touched_locations("xlsx", &[json!({ "op": "set_range", "sheet": "Data", "range": "A1" })]), ["/sheet[Data]"]);
        assert_eq!(touched_locations("docx", &[json!({ "op": "replace_text", "find": "a", "replace": "b" })]), ["/body"]);
        assert!(touched_locations("pptx", &[]).is_empty());
        assert!(touched_locations("pptx", &[json!(null), json!("x"), json!({ "slide": 0 })]).is_empty());
    }

    // Port of `audit rounds count consecutive failures on the session and reset on a pass`.
    #[test]
    fn audit_rounds_count_consecutive_failures_on_the_session_and_reset_on_a_pass() {
        let mut held = session("pptx");
        let failing = || summarize_office_audit(&[finding("warning", "text_overflow", "/slide[1]/shape[1]", "over")], &[]);
        assert_eq!(record_inline_audit_round(&mut held, failing())["round"], 1);
        let second = record_inline_audit_round(&mut held, failing());
        assert!(second["nextAction"].as_str().expect("text").contains(&format!("round 2 of {INLINE_AUDIT_MAX_ROUNDS}")));
        let exhausted = record_inline_audit_round(&mut held, failing());
        assert_eq!(exhausted["round"], INLINE_AUDIT_MAX_ROUNDS + 1);
        assert!(exhausted["nextAction"].as_str().expect("text").contains("report what remains"));
        let passed = record_inline_audit_round(&mut held, summarize_office_audit(&[], &[]));
        assert_eq!(passed["round"], 0);
        assert!(passed["nextAction"].as_str().expect("text").contains("passed"));
    }

    #[test]
    fn word_excel_and_pdf_audits_do_not_count_fix_rounds() {
        let mut held = session("docx");
        let audit = summarize_office_audit(&[finding("warning", "empty_document", "/body", "empty")], &["/body".to_owned()]);
        let recorded = record_inline_audit_round(&mut held, audit);
        assert!(recorded["nextAction"].as_str().expect("text").starts_with("Inspect the 1 reported finding at their document locations."));
    }

    #[test]
    fn a_formula_without_a_cached_value_is_advisory_and_an_excluded_code_is_dropped() {
        let measured = json!({ "issues": [
            finding("warning", "formula_cache_missing", "/sheet[A]/cell[B2]", "pending"),
            finding("warning", "text_overflow", "/slide[1]/shape[1]", "over"),
            finding("warning", "low_contrast", "/slide[1]/shape[2]", "dim"),
        ] });
        let kept = reportable_findings(&measured, &["low_contrast".to_owned()]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0]["severity"], "info");
        assert_eq!(kept[1]["severity"], "warning");
        assert!(reportable_findings(&json!({}), &[]).is_empty());
    }

    #[test]
    fn a_deck_edit_keeps_its_touched_slides_and_the_package_and_counts_the_rest() {
        let mut list = vec![
            finding("warning", "text_overflow", "/slide[2]/shape[1]", "touched"),
            finding("warning", "text_overflow", "/slide[5]/shape[1]", "untouched"),
            finding("info", "shapes_too_close", "/slide[6]/shape[1]", "advisory"),
            finding("error", "missing_relationship", "/ppt/slides/_rels/slide1.xml.rels", "package"),
        ];
        let outside = drop_findings_outside_edit(&mut list, &["/slide[2]".to_owned()]);
        assert_eq!(outside, 1);
        let messages: Vec<&str> = list.iter().map(|issue| issue["message"].as_str().expect("text")).collect();
        assert_eq!(messages, ["touched", "package"]);
    }

    #[test]
    fn an_outside_edit_pass_names_the_findings_the_batch_did_not_touch() {
        let mut audit = summarize_office_audit(&[], &[]);
        audit["outsideEdit"] = json!(2);
        assert!(next_action_for(&audit, "pptx").starts_with("The edited slides pass. 2 measured findings sit on slides this batch did not touch"));
    }
}
