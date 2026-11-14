//! Owner: s4-engine-target-points
//! Where a ref is on screen (`ref-point-probe.ts`, `ref-rect-probe.ts`): the page-world functions that measure an element,
//! and the reading of what they report. The page confirms the element, or the label a person would click instead, is on
//! top at the point it hands back; a covered, hidden, disabled or moving element is refused with the reason, because a wrong
//! point clicks the wrong thing. The functions run through `host/browser/ref/call` (`points`), so an accessibility ref and a
//! page-side DOM ref are measured by the same source.

use serde::Deserialize;
use serde_json::Value;

use super::access::ActionabilityReason;
use super::access::RefError;
use super::access::stale_ref_message;

/// The page-world sources (`assets/page/`), whose placeholders are filled with the other assets' text.
const REF_POINT_PROBE: &str = include_str!("../../assets/page/ref-point-probe.js");
const REF_RECT: &str = include_str!("../../assets/page/ref-rect.js");
const STABLE_RECT: &str = include_str!("../../assets/page/stable-rect.js");
const FRAME_HAS_TRANSFORM: &str = include_str!("../../assets/page/frame-transform.js");

/// A point of the viewport of the realm the ref lives in, hit-tested by the page.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// The box a ref occupies, in the same coordinates as [`Point`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The text of the section `name` of an asset that holds several sources, each started by a `//@@ <name>` line.
fn section<'a>(text: &'a str, name: &str) -> &'a str {
    let marker = format!("//@@ {name}\n");
    let Some(at) = text.match_indices(&marker).map(|(at, _)| at).find(|&at| at == 0 || text.as_bytes()[at - 1] == b'\n') else {
        return "";
    };
    let body = &text[at + marker.len()..];
    let body = &body[..body.find("\n//@@ ").unwrap_or(body.len())];
    body.strip_suffix('\n').unwrap_or(body)
}

/// The function the point probe calls on the element (`REF_POINT_PROBE`).
pub fn ref_point_declaration() -> String {
    REF_POINT_PROBE.replace("__MIXDOG_STABLE_RECT__", STABLE_RECT).replace("__MIXDOG_FRAME_HAS_TRANSFORM__", FRAME_HAS_TRANSFORM)
}

/// The function the rect measurement calls on the element: `BROWSER_REF_RECT` applied to `this`.
pub fn ref_rect_declaration() -> String {
    let measure = section(REF_RECT, "BROWSER_REF_RECT").replace("__MIXDOG_STABLE_RECT__", STABLE_RECT);
    format!("async function() {{ return ({measure})(this); }}")
}

/// What the point probe reports: a point, or why there is none.
#[derive(Default, Deserialize)]
#[serde(default)]
struct PointReport {
    error: Option<String>,
    covering: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
}

/// What the rect measurement reports.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RectReport {
    error: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
}

fn refused(reason: ActionabilityReason, message: String) -> RefError {
    RefError::Refused { reason, message }
}

/// `refPointFailure`: the refusal a probe's reason becomes.
fn point_failure(ref_id: &str, error: &str, covering: Option<&str>) -> RefError {
    match error {
        "transformed-frame" => RefError::Failed(format!("ref {ref_id} is inside a transformed parent frame; ref input is unsupported and was not dispatched")),
        "covered" => refused(
            ActionabilityReason::Covered,
            format!("ref {ref_id} is covered by {}; input was not dispatched.", covering.filter(|text| !text.is_empty()).unwrap_or("another element")),
        ),
        "not-visible" => refused(ActionabilityReason::Hidden, format!("ref {ref_id} is not visible; take a fresh snapshot first")),
        "disabled" => refused(ActionabilityReason::Disabled, format!("ref {ref_id} is disabled")),
        "moving" => refused(ActionabilityReason::Moving, format!("ref {ref_id} is still moving; wait briefly and take a fresh snapshot")),
        "not-actionable" => refused(ActionabilityReason::Hidden, format!("ref {ref_id} is not actionable (hidden, transparent, or pointer events disabled)")),
        _ => RefError::Failed(stale_ref_message(ref_id)),
    }
}

/// The point the probe's answer names. An answer with neither a point nor a reason is a ref the page cannot show.
pub fn point_from_report(ref_id: &str, report: Value) -> Result<Point, RefError> {
    let report: PointReport = serde_json::from_value(report).unwrap_or_default();
    if let Some(error) = report.error.as_deref().filter(|error| !error.is_empty()) {
        return Err(point_failure(ref_id, error, report.covering.as_deref()));
    }
    match (report.x, report.y) {
        (Some(x), Some(y)) => Ok(Point { x, y }),
        _ => Err(point_failure(ref_id, "not-visible", None)),
    }
}

/// `refRectFailure`.
fn rect_failure(ref_id: &str, error: Option<&str>) -> RefError {
    match error {
        Some("moving") => refused(ActionabilityReason::Moving, format!("ref {ref_id} is still moving; wait briefly and try again")),
        Some("not-visible") => refused(ActionabilityReason::Hidden, format!("ref {ref_id} is not visible; take a fresh snapshot first")),
        _ => RefError::Failed(stale_ref_message(ref_id)),
    }
}

/// The box the measurement's answer names; a box without width or height is no box.
pub fn rect_from_report(ref_id: &str, report: Value) -> Result<Rect, RefError> {
    let report: RectReport = serde_json::from_value(report).unwrap_or_default();
    if report.error.as_deref().is_some_and(|error| !error.is_empty()) {
        return Err(rect_failure(ref_id, report.error.as_deref()));
    }
    match (report.x, report.y, report.width, report.height) {
        (Some(x), Some(y), Some(width), Some(height)) if width != 0.0 && height != 0.0 => Ok(Rect { x, y, width, height }),
        _ => Err(rect_failure(ref_id, None)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn reason(error: &RefError) -> Option<ActionabilityReason> {
        error.reason()
    }

    #[test]
    fn a_probe_answer_with_a_point_is_the_point() {
        assert_eq!(point_from_report("r", json!({"x": 12.5, "y": 30, "via": "label"})), Ok(Point { x: 12.5, y: 30.0 }));
    }

    #[test]
    fn each_probe_reason_is_refused_in_its_words() {
        let covered = point_from_report("r", json!({"error": "covered", "covering": "div \"Loading\""})).expect_err("covered");
        assert_eq!(reason(&covered), Some(ActionabilityReason::Covered));
        assert_eq!(covered.to_string(), "ref r is covered by div \"Loading\"; input was not dispatched.");
        let anonymous = point_from_report("r", json!({"error": "covered"})).expect_err("covered");
        assert_eq!(anonymous.to_string(), "ref r is covered by another element; input was not dispatched.");
        let table = [
            ("not-visible", Some(ActionabilityReason::Hidden), "ref r is not visible; take a fresh snapshot first"),
            ("disabled", Some(ActionabilityReason::Disabled), "ref r is disabled"),
            ("moving", Some(ActionabilityReason::Moving), "ref r is still moving; wait briefly and take a fresh snapshot"),
            ("not-actionable", Some(ActionabilityReason::Hidden), "ref r is not actionable (hidden, transparent, or pointer events disabled)"),
            ("transformed-frame", None, "ref r is inside a transformed parent frame; ref input is unsupported and was not dispatched"),
            ("stale", None, "ref r is stale or unknown; take a fresh snapshot first"),
            ("anything else", None, "ref r is stale or unknown; take a fresh snapshot first"),
        ];
        for (error, wanted, message) in table {
            let refused = point_from_report("r", json!({"error": error})).expect_err(error);
            assert_eq!((reason(&refused), refused.to_string().as_str()), (wanted, message), "{error}");
        }
    }

    #[test]
    fn an_answer_without_a_point_or_a_reason_is_not_visible() {
        for report in [json!({}), json!(null), json!({"x": 1}), json!({"error": ""}), json!("x")] {
            let error = point_from_report("r", report).expect_err("no point");
            assert_eq!(reason(&error), Some(ActionabilityReason::Hidden));
        }
    }

    #[test]
    fn a_rect_needs_a_position_and_a_size() {
        assert_eq!(rect_from_report("r", json!({"x": 1, "y": 2, "width": 3, "height": 4})), Ok(Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }));
        let moving = rect_from_report("r", json!({"error": "moving"})).expect_err("moving");
        assert_eq!((reason(&moving), moving.to_string().as_str()), (Some(ActionabilityReason::Moving), "ref r is still moving; wait briefly and try again"));
        let hidden = rect_from_report("r", json!({"error": "not-visible"})).expect_err("hidden");
        assert_eq!(reason(&hidden), Some(ActionabilityReason::Hidden));
        for report in [json!({"error": "stale"}), json!({"x": 1, "y": 2, "width": 0, "height": 4}), json!({"x": 1, "y": 2, "width": 3}), json!(null)] {
            let stale = rect_from_report("r", report).expect_err("no box");
            assert_eq!((reason(&stale), stale.to_string().as_str()), (None, "ref r is stale or unknown; take a fresh snapshot first"));
        }
    }

    #[test]
    fn the_declarations_are_the_assets_with_their_placeholders_filled() {
        let point = ref_point_declaration();
        assert!(!point.contains("__MIXDOG_"), "a placeholder is left");
        assert!(point.starts_with("async function()") && point.contains(STABLE_RECT) && point.contains(FRAME_HAS_TRANSFORM));
        let rect = ref_rect_declaration();
        assert!(!rect.contains("__MIXDOG_"), "a placeholder is left");
        assert!(rect.starts_with("async function() { return (async function(target, frames = [])") && rect.ends_with(")(this); }"));
        assert!(rect.contains(STABLE_RECT) && !rect.contains("browserRefRectExpression") && !rect.contains("//@@"));
    }

    #[test]
    fn a_section_runs_to_the_next_marker_without_its_newline() {
        let text = "//@@ A\none\ntwo\n//@@ B\nthree\n";
        assert_eq!(section(text, "A"), "one\ntwo");
        assert_eq!(section(text, "B"), "three");
        assert_eq!(section(text, "C"), "");
    }
}
