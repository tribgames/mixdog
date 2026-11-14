//! What a reply says about the protection its delivery had against the target
//! taking the foreground: the foreground lock's facts and the notes for a
//! delivery that lacked the lock or the no-activate hold (Invoke-BackgroundWindow's
//! tail, input-semantic.ps1:127-139; Add-ActivationProtection, runtime.ps1:57-66).

use super::Host;
use crate::protocol::{Obj, Req};
use serde_json::{Value, json};

const LOCK_UNAVAILABLE: &str = "; the foreground lock was unavailable, so background delivery had less protection against the target taking the foreground";
const REFUSED_HOLD: &str = "; the target refused the no-activate hold, so background delivery had less protection against it coming forward";

/// Forgets a refusal an earlier request left (the reset before each request,
/// runtime.ps1:225).
pub(super) fn begin(host: &Host) {
    if let Some(background) = host.desktop.background() {
        background.take_activation_unprotected();
    }
}

/// Annotates the result of `req` after it was handled: the lock's facts and
/// its note first (they come from the guarded call), then the refused hold's.
pub(super) fn annotate(host: &Host, req: &Req, result: &mut Obj) {
    let unprotected = host
        .desktop
        .background()
        .is_some_and(|background| background.take_activation_unprotected());
    let facts = host.activation_facts.borrow().clone();
    let Some(annotated) = annotated(&req.action(), result) else {
        return;
    };
    if let Some(facts) = facts {
        note_lock(annotated, facts);
    }
    if unprotected {
        note_refused_hold(annotated);
    }
}

/// A sequence step carries its input's result inside the step envelope.
fn annotated<'a>(action: &str, result: &'a mut Obj) -> Option<&'a mut Obj> {
    if action == "sequence_step" {
        result.get_mut("step_result").and_then(Value::as_object_mut)
    } else {
        Some(result)
    }
}

fn delivered(result: &Obj) -> bool {
    result.get("delivery_accepted") == Some(&json!(true))
}

fn add_note(result: &mut Obj, note: &str) {
    let text = result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = format!("{text}{note}");
    result.insert("activation_protection".into(), json!("unavailable"));
    result.insert("text".into(), json!(text));
}

/// Who held the lock, how the hold and any restore ended; without a holder the
/// target could take the foreground from the person's window, so accepted
/// input must not read as protected from that.
fn note_lock(result: &mut Obj, facts: Value) {
    let unlocked = facts.get("holder") == Some(&json!("none"));
    result.insert("foreground_lock".into(), facts);
    if unlocked && delivered(result) {
        add_note(result, LOCK_UNAVAILABLE);
    }
}

/// A target that refused the no-activate style still got the input, but the
/// result must not present that delivery as protected from raising it.
fn note_refused_hold(result: &mut Obj) {
    if delivered(result) && result.get("delivery") == Some(&json!("background")) {
        add_note(result, REFUSED_HOLD);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    fn delivered(accepted: bool, delivery: &str) -> Obj {
        obj! { "text" => "clicked", "delivery_accepted" => accepted, "delivery" => delivery }
    }

    const NO_CHANNEL: fn() -> Value =
        || json!({ "holder": "none", "host_answer": "not_offered", "release": "none" });

    #[test]
    fn a_refused_hold_marks_an_accepted_background_delivery() {
        let mut result = delivered(true, "background");
        note_refused_hold(&mut result);
        assert_eq!(
            result.get("activation_protection"),
            Some(&json!("unavailable"))
        );
        assert_eq!(
            result.get("text"),
            Some(&json!(format!("clicked{REFUSED_HOLD}")))
        );
    }

    #[test]
    fn a_refused_delivery_or_a_foreground_one_gets_no_hold_suffix() {
        for mut result in [
            delivered(false, "background"),
            delivered(true, "foreground"),
        ] {
            let before = result.clone();
            note_refused_hold(&mut result);
            assert_eq!(result, before);
        }
    }

    #[test]
    fn an_unavailable_lock_reports_its_facts_and_marks_an_accepted_delivery() {
        let mut result = delivered(true, "background");
        note_lock(&mut result, NO_CHANNEL());
        assert_eq!(result["foreground_lock"]["holder"], json!("none"));
        assert_eq!(result["foreground_lock"]["host_answer"], json!("not_offered"));
        assert_eq!(result["activation_protection"], json!("unavailable"));
        assert_eq!(result["text"], json!(format!("clicked{LOCK_UNAVAILABLE}")));
    }

    #[test]
    fn a_held_lock_or_a_refused_delivery_gets_the_facts_without_a_suffix() {
        let mut held = delivered(true, "background");
        note_lock(&mut held, json!({ "holder": "worker", "release": "released" }));
        assert_eq!(held["foreground_lock"]["holder"], json!("worker"));
        assert_eq!(held["text"], json!("clicked"));
        assert!(!held.contains_key("activation_protection"));

        let mut refused = delivered(false, "background");
        note_lock(&mut refused, NO_CHANNEL());
        assert!(refused.contains_key("foreground_lock"));
        assert_eq!(refused["text"], json!("clicked"));
        assert!(!refused.contains_key("activation_protection"));
    }

    #[test]
    fn both_suffixes_combine_in_the_lock_then_hold_order() {
        let mut result = delivered(true, "background");
        note_lock(&mut result, NO_CHANNEL());
        note_refused_hold(&mut result);
        assert_eq!(
            result["text"],
            json!(format!("clicked{LOCK_UNAVAILABLE}{REFUSED_HOLD}"))
        );
    }

    #[test]
    fn a_sequence_step_is_marked_inside_its_envelope() {
        let mut result = obj! { "text" => "step", "step_result" => Value::Object(delivered(true, "background")) };
        let step = annotated("sequence_step", &mut result).expect("the envelope");
        note_lock(step, NO_CHANNEL());
        note_refused_hold(step);
        assert_eq!(result.get("text"), Some(&json!("step")));
        assert!(!result.contains_key("foreground_lock"));
        assert_eq!(
            result["step_result"]["activation_protection"],
            json!("unavailable")
        );
        assert!(result["step_result"]["foreground_lock"].is_object());
        let mut bare = obj! { "text" => "step" };
        assert!(annotated("sequence_step", &mut bare).is_none());
    }
}
