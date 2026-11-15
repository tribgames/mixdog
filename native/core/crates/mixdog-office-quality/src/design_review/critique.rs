//! `design-review-critique.mjs`: the model's own visual critique of a rendered deck (five axes, a note, and plan-derived
//! checks per slide) and the acknowledgement gate finalize reads.

use mixdog_js::{js_to_lowercase, json_number, to_number_of, utf16_len, value_to_string};
use mixdog_office_design::tokens::strings;
use serde_json::{Map, Value, json};

use super::{squash, utf16_sorted};
use crate::issue::issue_with;
use crate::structure::{coalesce, text, trimmed};
use crate::{field, is_true, is_truthy, template_text};

/// The five axes a slide is scored on (1-5 each); the pptx skill section 6 names them.
const PPTX_CRITIQUE_AXES: [&str; 5] = ["hierarchy", "balance", "legibility", "cohesion", "evidence"];

/// Instance-specific checks: binary questions derived from the slide's own plan line, answered against the render. A
/// judged deck needs at least three per slide.
const MIN_CHECKS: usize = 3;

fn critique_issue(code: &str, path: &str, message: &str) -> Value {
    issue_with(code, path, message, "visual-critique", "warning")
}

/// `{ item, pass }` of every check of a raw list that names its item.
fn parse_checks(raw: Option<&Value>) -> Vec<(String, bool)> {
    let Some(Value::Array(list)) = raw else { return Vec::new() };
    list.iter()
        .filter(|check| check.is_object())
        .map(|check| {
            let item = if is_truthy(field(check, "item")) { trimmed(field(check, "item")) } else { trimmed(field(check, "question")) };
            let pass = is_true(field(check, "pass")) || js_to_lowercase(&text(field(check, "answer"))) == "yes";
            (item, pass)
        })
        .filter(|(item, _)| !item.is_empty())
        .collect()
}

/// One entry of the critique as it is recorded.
struct Entry {
    note: String,
    checks: Vec<(String, bool)>,
}

/// `asTemplate(value)`: a note or a question with its digits, its case and its spacing read past, so a formula that only
/// swaps the slide number cannot hide.
fn as_template(value: &str) -> String {
    let lowered: String = js_to_lowercase(value).chars().filter(|c| !c.is_ascii_digit()).collect();
    squash(&lowered)
}

/// A template answer is not a review: one sentence with the slide number swapped in, or the same three questions asked
/// of every slide, says nothing about the page it judges.
fn repeated_critique_issue(entries: &[Entry], total: f64) -> Option<Value> {
    // Both readings are held against the page count, not the entries: a critique that misses a page is not a repeat.
    let notes: Vec<String> = entries.iter().map(|entry| as_template(&entry.note)).filter(|note| !note.is_empty()).collect();
    let repeated_notes = total > 1.0 && notes.len() as f64 == total && distinct(&notes) as f64 != total;
    let check_sets: Vec<String> = entries
        .iter()
        .map(|entry| utf16_sorted(entry.checks.iter().map(|(item, _)| as_template(item)).collect()).join(" | "))
        .filter(|set| !set.is_empty())
        .collect();
    let repeated_checks = total > 1.0 && check_sets.len() as f64 == total && distinct(&check_sets) == 1;
    if !repeated_notes && !repeated_checks {
        return None;
    }
    let message = if repeated_notes && repeated_checks {
        "Each slide needs its own critique note and its own checks; this critique repeats one note and one set of questions across the deck."
    } else if repeated_notes {
        "Each slide needs a distinct visual critique note; changing only the slide number is the same note."
    } else {
        "Each slide's checks come from its own plan line; every slide here asks the same questions."
    };
    Some(critique_issue("visual_critique_repeated_note", "/", message))
}

fn distinct(list: &[String]) -> usize {
    let mut seen: Vec<&String> = Vec::new();
    for entry in list {
        if !seen.contains(&entry) {
            seen.push(entry);
        }
    }
    seen.len()
}

/// `reviewPptxVisualCritique({ critique, pageCount, requireChecks })`: `{ ok, status, axes, pageCount, entries, issues }`.
pub fn review_pptx_visual_critique(args: &Value) -> Value {
    let total = {
        let number = to_number_of(field(args, "pageCount"));
        mixdog_js::math::max(0.0, if number.is_nan() { 0.0 } else { number })
    };
    let require_checks = is_truthy(field(args, "requireChecks"));
    let raw_list: &[Value] = field(args, "critique").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let mut issues: Vec<Value> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    let mut read: Vec<Entry> = Vec::new();
    let mut seen: Vec<f64> = Vec::new();
    for raw in raw_list {
        if !raw.is_object() {
            continue;
        }
        // A PDF of designed pages names its entries by page.
        let named = coalesce(field(raw, "slide"), field(raw, "page"));
        let slide = named.map_or(f64::NAN, |value| to_number_of(Some(value)));
        if !(slide.is_finite() && slide.fract() == 0.0) || slide < 1.0 || slide > total || seen.contains(&slide) {
            issues.push(critique_issue(
                "visual_critique_invalid_slide",
                "/",
                &format!("Visual critique has an invalid or duplicate slide index: {}", named.map_or_else(|| template_text(None), value_to_string)),
            ));
            continue;
        }
        let scores: Vec<f64> = PPTX_CRITIQUE_AXES.iter().map(|axis| to_number_of(field(raw, axis))).collect();
        let note = trimmed(field(raw, "note"));
        let fixes = strings(field(raw, "fixes"));
        let verdict = js_to_lowercase(&text(field(raw, "verdict")));
        let valid_scores = scores.iter().all(|score| score.is_finite() && score.fract() == 0.0 && (1.0..=5.0).contains(score));
        let checks = parse_checks(field(raw, "checks"));
        // An anchor (cover, section, closing) carries a statement or a picture, not evidence; its evidence score is
        // recorded but never gates finalize.
        let role = js_to_lowercase(&trimmed(field(raw, "role")));
        let anchor = ["anchor", "cover", "section", "closing"].contains(&role.as_str());
        let gated = |at: usize| !(anchor && PPTX_CRITIQUE_AXES[at] == "evidence");
        let mut entry = Map::new();
        entry.insert("slide".into(), json_number(slide));
        entry.insert("verdict".into(), json!(verdict));
        for (axis, score) in PPTX_CRITIQUE_AXES.iter().zip(&scores) {
            entry.insert((*axis).into(), json_number(*score));
        }
        entry.insert("note".into(), json!(note));
        entry.insert("fixes".into(), json!(fixes));
        if !role.is_empty() {
            entry.insert("role".into(), json!(role));
        }
        if !checks.is_empty() {
            entry.insert("checks".into(), Value::Array(checks.iter().map(|(item, pass)| json!({ "item": item, "pass": pass })).collect()));
        }
        entries.push(Value::Object(entry));
        seen.push(slide);
        let path = format!("/slide[{}]", mixdog_js::number_to_string(slide));
        if !valid_scores || utf16_len(&note) < 40 || (require_checks && checks.len() < MIN_CHECKS) {
            let message = if require_checks {
                format!(
                    "Visual critique requires five integer scores from 1-5, a slide-specific note of at least 40 characters, and at least {MIN_CHECKS} checks ({{ item, pass }}) derived from the slide's plan line."
                )
            } else {
                "Visual critique requires five integer scores from 1-5 and a slide-specific note of at least 40 characters.".to_owned()
            };
            issues.push(critique_issue("visual_critique_incomplete", &path, &message));
        } else if verdict != "pass" || !fixes.is_empty() || (0..PPTX_CRITIQUE_AXES.len()).any(|at| gated(at) && scores[at] < 4.0) || checks.iter().any(|(_, pass)| !pass) {
            issues.push(critique_issue(
                "visual_critique_needs_polish",
                &path,
                &format!("Slide {} still needs polish before finalization.", mixdog_js::number_to_string(slide)),
            ));
        }
        read.push(Entry { note, checks });
    }
    let mut slide = 1.0;
    while slide <= total {
        if !seen.contains(&slide) {
            let shown = mixdog_js::number_to_string(slide);
            issues.push(critique_issue("visual_critique_missing_slide", &format!("/slide[{shown}]"), &format!("Slide {shown} has no visual critique.")));
        }
        slide += 1.0;
    }
    if let Some(repeated) = repeated_critique_issue(&read, total) {
        issues.push(repeated);
    }
    let passed = total > 0.0 && issues.is_empty();
    json!({
        "ok": passed,
        "status": if passed { "pass" } else { "needs-polish" },
        "axes": PPTX_CRITIQUE_AXES,
        "pageCount": json_number(total),
        "entries": entries,
        "issues": issues,
    })
}

/// `pptxVisualReviewAcknowledged({ reviewed, providedToken, expectedToken, renderedVersion, snapshotVersion,
/// coverageComplete, critiqueOk })`: whether the model has read the render of the version being finalized. A parameter
/// that is absent takes its default (not reviewed, no token, no version, complete coverage, critique not ok).
pub fn pptx_visual_review_acknowledged(args: &Value) -> bool {
    let reviewed = is_true(field(args, "reviewed"));
    let expected = field(args, "expectedToken");
    let expected_set = is_truthy(expected);
    let provided = if is_truthy(field(args, "providedToken")) { text(field(args, "providedToken")) } else { String::new() };
    let expected_text = expected.map_or_else(|| "undefined".to_owned(), value_to_string);
    let rendered = field(args, "renderedVersion");
    let rendered_set = !matches!(rendered, None | Some(Value::Null));
    let snapshot = field(args, "snapshotVersion");
    let snapshot_number = if is_truthy(snapshot) { to_number_of(snapshot) } else { 0.0 };
    let coverage_complete = field(args, "coverageComplete").is_none_or(|value| matches!(value, Value::Bool(true)));
    reviewed
        && expected_set
        && provided == expected_text
        && rendered_set
        && to_number_of(rendered) == snapshot_number
        && coverage_complete
        && is_true(field(args, "critiqueOk"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(slide: u32, note: &str, score: u32, checks: Value) -> Value {
        json!({
            "slide": slide, "verdict": "pass", "hierarchy": score, "balance": score, "legibility": score, "cohesion": score, "evidence": score,
            "note": note, "fixes": [], "checks": checks,
        })
    }

    fn checks(seed: &str) -> Value {
        json!([{ "item": format!("{seed} one"), "pass": true }, { "item": format!("{seed} two"), "answer": "yes" }, { "item": format!("{seed} three"), "pass": true }])
    }

    #[test]
    fn a_complete_critique_of_every_page_passes_and_keeps_node_key_order() {
        let critique = json!([
            entry(1, "The cover sets the title against a calm field with one accent.", 5, checks("cover")),
            entry(2, "The chart carries the claim and the caption names its unit clearly.", 4, checks("chart")),
        ]);
        let review = review_pptx_visual_critique(&json!({ "critique": critique, "pageCount": 2, "requireChecks": true }));
        assert_eq!(review["ok"], true);
        assert_eq!(review["status"], "pass");
        let keys: Vec<&str> = review["entries"][0].as_object().expect("entry").keys().map(String::as_str).collect();
        assert_eq!(keys, ["slide", "verdict", "hierarchy", "balance", "legibility", "cohesion", "evidence", "note", "fixes", "checks"]);
    }

    #[test]
    fn missing_incomplete_and_unfinished_slides_are_each_reported() {
        let critique = json!([
            entry(1, "short", 5, checks("a")),
            { "slide": 3, "verdict": "fix", "hierarchy": 3, "balance": 5, "legibility": 5, "cohesion": 5, "evidence": 5, "note": "x".repeat(50) },
            { "slide": 3, "note": "duplicate" },
        ]);
        let review = review_pptx_visual_critique(&json!({ "critique": critique, "pageCount": 3 }));
        let codes: Vec<&str> = review["issues"].as_array().expect("issues").iter().map(|issue| issue["code"].as_str().expect("code")).collect();
        assert_eq!(codes, ["visual_critique_incomplete", "visual_critique_needs_polish", "visual_critique_invalid_slide", "visual_critique_missing_slide"]);
        assert_eq!(review["ok"], false);
    }

    #[test]
    fn an_anchor_is_not_held_to_its_evidence_score_and_one_note_for_every_page_is_repeated() {
        let mut cover = entry(1, "The cover sets the title against a calm field with one accent.", 5, checks("cover"));
        cover["evidence"] = json!(2);
        cover["role"] = json!("Cover");
        let review = review_pptx_visual_critique(&json!({ "critique": [cover], "pageCount": 1 }));
        assert_eq!(review["ok"], true);
        assert_eq!(review["entries"][0]["role"], "cover");
        let same = |slide: u32| entry(slide, &format!("Slide {slide} reads well with its chart and a clear title above."), 5, checks("same"));
        let repeated = review_pptx_visual_critique(&json!({ "critique": [same(1), same(2)], "pageCount": 2 }));
        assert_eq!(repeated["issues"][0]["code"], "visual_critique_repeated_note");
        assert!(repeated["issues"][0]["message"].as_str().expect("message").starts_with("Each slide needs its own critique note and its own checks"));
        // A page with no critique is reported as missing, never as a repeat of the pages that have one.
        let partial = review_pptx_visual_critique(&json!({ "critique": [same(1), same(2)], "pageCount": 3 }));
        let codes: Vec<&str> = partial["issues"].as_array().expect("issues").iter().map(|issue| issue["code"].as_str().expect("code")).collect();
        assert_eq!(codes, ["visual_critique_missing_slide"]);
    }

    #[test]
    fn the_acknowledgement_needs_the_token_the_version_the_coverage_and_a_passing_critique() {
        let ready = json!({ "reviewed": true, "providedToken": "t", "expectedToken": "t", "renderedVersion": 3, "snapshotVersion": 3, "critiqueOk": true });
        assert!(pptx_visual_review_acknowledged(&ready));
        let mut stale = ready.clone();
        stale["renderedVersion"] = json!(2);
        assert!(!pptx_visual_review_acknowledged(&stale));
        let mut open = ready.clone();
        open["coverageComplete"] = json!(false);
        assert!(!pptx_visual_review_acknowledged(&open));
        assert!(!pptx_visual_review_acknowledged(&json!({})));
    }
}
