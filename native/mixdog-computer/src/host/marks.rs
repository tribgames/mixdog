//! The element and to_element aliases a capture's marks hand out, resolved to
//! refs (resolveElementAliases, session/element-aliases.ts:120-152). The
//! session's marks name semantic refs only; an `ocr:<frame>:<mark>` ref names
//! a frame point the core resolves, and passes through untouched.

use super::{Host, Res};
use crate::protocol::Req;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The actions that may address a control by its mark (ELEMENT_ALIAS_ACTIONS).
const ALIAS_ACTIONS: [&str; 17] = [
    "invoke",
    "set_value",
    "toggle",
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "triple_click",
    "mouse_down",
    "mouse_up",
    "mouse_move",
    "drag",
    "type",
    "key",
    "key_down",
    "key_up",
    "scroll",
];

const MIXED_DRAG: &str =
    "drag source and destination must both be semantic elements or both be OCR/frame points";

/// The request with its aliases replaced by refs; None when it names none.
pub(super) fn resolve(host: &Host, req: &Req) -> Res<Option<Req>> {
    host.session(|session| resolve_with(&session.marks, req))
}

/// `ocr:<frame>:<mark>` (OCR_REF_PATTERN): a frame point, never a ref.
fn is_point_ref(value: &str) -> bool {
    value
        .strip_prefix("ocr:")
        .and_then(|rest| rest.rsplit_once(':'))
        .is_some_and(|(frame, mark)| {
            !frame.is_empty() && !mark.is_empty() && mark.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// The ref the mark in `label` names (elementTarget).
fn marked<'a>(marks: &'a BTreeMap<i64, String>, req: &Req, label: &str) -> Res<Option<&'a str>> {
    let Some(value) = req.raw(label) else {
        return Ok(None);
    };
    let whole = |number: &serde_json::Number| {
        number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|float| float.fract() == 0.0)
                .map(|float| float as i64)
        })
    };
    let mark = match value {
        Value::Number(number) => whole(number).filter(|mark| *mark >= 1),
        _ => None,
    };
    let Some(mark) = mark else {
        return Err(format!(
            "{label} must be a positive integer from the latest capture"
        ));
    };
    match marks.get(&mark) {
        Some(found) => Ok(Some(found.as_str())),
        None => Err(format!(
            "stale_element: {label}={mark} is not in the latest capture for this session"
        )),
    }
}

/// A mark and an explicit ref must name the same control, and a drag the same
/// kind of source and destination (assertElementAliasTargets).
fn resolve_with(marks: &BTreeMap<i64, String>, req: &Req) -> Res<Option<Req>> {
    let action = req.action();
    let drag = action == "drag";
    let source = if ALIAS_ACTIONS.contains(&action.as_str()) {
        marked(marks, req, "element")?
    } else {
        None
    };
    let destination = if drag {
        marked(marks, req, "to_element")?
    } else {
        None
    };
    if source.is_none() && destination.is_none() {
        return Ok(None);
    }
    let (named, named_to) = (req.str("ref"), req.str("to"));
    let differs = |marked: Option<&str>, named: &Option<String>| {
        marked.is_some_and(|marked| named.as_deref().is_some_and(|named| named != marked))
    };
    if differs(source, &named) {
        return Err("element and ref identify different controls".into());
    }
    if differs(destination, &named_to) {
        return Err("to_element and to identify different controls".into());
    }
    // The end of a drag that an OCR ref names instead of a mark is a frame point.
    let point = |marked: Option<&str>, named: &Option<String>| {
        marked.is_none() && named.as_deref().is_some_and(is_point_ref)
    };
    if drag && (point(source, &named) || point(destination, &named_to)) {
        return Err(MIXED_DRAG.into());
    }
    let mut resolved = req.0.clone();
    if let Value::Object(fields) = &mut resolved {
        if let Some(found) = source {
            fields.insert("ref".into(), json!(found));
        }
        if let Some(found) = destination {
            fields.insert("to".into(), json!(found));
        }
    }
    Ok(Some(Req(resolved)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(request: Value) -> Res<Option<Value>> {
        let marks = BTreeMap::from([(1, "r7".to_string()), (2, "r9".to_string())]);
        resolve_with(&marks, &Req(request)).map(|req| req.map(|req| req.0))
    }

    #[test]
    fn a_mark_becomes_its_ref_and_other_fields_stay() {
        assert_eq!(
            resolved(json!({ "action": "click", "element": 1, "window_id": "hwnd:0x3" })),
            Ok(Some(
                json!({ "action": "click", "element": 1, "window_id": "hwnd:0x3", "ref": "r7" })
            ))
        );
        // The same control named both ways agrees.
        assert_eq!(
            resolved(json!({ "action": "invoke", "element": 2.0, "ref": "r9" })),
            Ok(Some(json!({ "action": "invoke", "element": 2.0, "ref": "r9" })))
        );
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to_element": 2 })),
            Ok(Some(
                json!({ "action": "drag", "element": 1, "to_element": 2, "ref": "r7", "to": "r9" })
            ))
        );
    }

    #[test]
    fn a_request_without_marks_keeps_its_own_fields() {
        assert_eq!(resolved(json!({ "action": "click", "ref": "r7" })), Ok(None));
        assert_eq!(resolved(json!({ "action": "click", "element": null })), Ok(None));
        // Not an alias action, or not a drag: the field is not a mark there.
        assert_eq!(resolved(json!({ "action": "snapshot", "element": 99 })), Ok(None));
        assert_eq!(resolved(json!({ "action": "click", "to_element": 99 })), Ok(None));
        // OCR refs are the core's and pass through untouched.
        assert_eq!(resolved(json!({ "action": "click", "ref": "ocr:f1:4" })), Ok(None));
        assert_eq!(
            resolved(json!({ "action": "drag", "ref": "ocr:f1:4", "to": "ocr:f1:5" })),
            Ok(None)
        );
    }

    #[test]
    fn a_stale_mark_is_refused() {
        assert_eq!(
            resolved(json!({ "action": "click", "element": 3 })),
            Err("stale_element: element=3 is not in the latest capture for this session".into())
        );
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to_element": 8 })),
            Err("stale_element: to_element=8 is not in the latest capture for this session".into())
        );
    }

    #[test]
    fn a_mark_that_is_not_a_positive_integer_is_refused() {
        for element in [json!(1.5), json!(0), json!(-2), json!("1"), json!(true)] {
            assert_eq!(
                resolved(json!({ "action": "click", "element": element })),
                Err("element must be a positive integer from the latest capture".into()),
                "{element}"
            );
        }
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to_element": 2.5 })),
            Err("to_element must be a positive integer from the latest capture".into())
        );
    }

    #[test]
    fn a_mark_and_a_ref_for_different_controls_are_refused() {
        assert_eq!(
            resolved(json!({ "action": "click", "element": 1, "ref": "r9" })),
            Err("element and ref identify different controls".into())
        );
        assert_eq!(
            resolved(json!({ "action": "click", "element": 1, "ref": "ocr:f1:4" })),
            Err("element and ref identify different controls".into())
        );
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to_element": 2, "to": "r7" })),
            Err("to_element and to identify different controls".into())
        );
    }

    #[test]
    fn a_drag_between_a_semantic_element_and_a_frame_point_is_refused() {
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to": "ocr:f1:5" })),
            Err(MIXED_DRAG.into())
        );
        assert_eq!(
            resolved(json!({ "action": "drag", "ref": "ocr:f1:4", "to_element": 2 })),
            Err(MIXED_DRAG.into())
        );
        // A mark dragged to a plain ref is one kind.
        assert_eq!(
            resolved(json!({ "action": "drag", "element": 1, "to": "r9" })),
            Ok(Some(json!({ "action": "drag", "element": 1, "to": "r9", "ref": "r7" })))
        );
    }

    #[test]
    fn only_a_whole_ocr_ref_is_a_frame_point() {
        assert!(is_point_ref("ocr:frame:12"));
        assert!(is_point_ref("ocr:a:b:3"));
        assert!(!is_point_ref("ocr::3"));
        assert!(!is_point_ref("ocr:frame:"));
        assert!(!is_point_ref("ocr:frame:x"));
        assert!(!is_point_ref("r7"));
    }
}
