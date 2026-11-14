//! Value writes through accessibility, read back until the element shows the
//! written value; a window that raises itself on such a write gets the
//! keyboard replacement instead (Do-SetValue, input-semantic.ps1).

use crate::a11y::Element;
use crate::host::windows::effect;
use crate::host::{sleep_ms, Host, Res};
use crate::observer::Snapshot;
use crate::platform::{Background, Wid};
use crate::protocol::{Obj, Req};
use serde_json::json;
use std::cell::Cell;
use std::collections::HashMap;

/// How the value reaches the element once its guards pass.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Route {
    /// The accessibility write.
    Pattern,
    /// The control's own keyboard, on this exact native control.
    Keys(Wid),
    /// A refusal: the code and the state it names.
    Refused(&'static str, &'static str),
}

/// Picks the route (Do-SetValue :580-595). A window known to raise itself
/// on an accessibility write takes the keyboard, which honours the element's
/// own state first; with no keyboard target of its own, or one that drops
/// sent keys, nothing was sent and the accessibility write runs once.
fn route(activates: bool, enabled: bool, read_only: bool, preferred: Wid, keyboard_ok: impl FnOnce() -> bool) -> Route {
    if !activates {
        return Route::Pattern;
    }
    if !enabled {
        return Route::Refused("element_disabled", "is disabled");
    }
    if read_only {
        return Route::Refused("element_read_only", "is read-only");
    }
    if preferred != 0 && keyboard_ok() {
        Route::Keys(preferred)
    } else {
        Route::Pattern
    }
}

/// A typed line break is an Enter key, which each editor stores in its own
/// form (CR LF or CR alone); the text is the same either way
/// (ConvertTo-TypedLineBreaks).
fn typed_line_breaks(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

/// Forgets windows whose handle now names another owner (Get-ValueWriteActivators).
fn forget_changed(known: &mut HashMap<Wid, String>, identity: &dyn Fn(Wid) -> String) {
    known.retain(|window, owner| *owner == identity(*window));
}

/// Whether a write to `top` is known to raise it (Test-ValueWriteActivates).
fn activates(known: &mut HashMap<Wid, String>, top: Wid, identity: &dyn Fn(Wid) -> String) -> bool {
    forget_changed(known, identity);
    known.contains_key(&top)
}

/// Remembers (`raised`) or forgets what a write to `top` did to the
/// foreground (Register- and Unregister-ValueWriteActivation).
fn note_activation(known: &mut HashMap<Wid, String>, top: Wid, raised: bool, identity: &dyn Fn(Wid) -> String) {
    forget_changed(known, identity);
    let owner = identity(top);
    if !raised {
        known.remove(&top);
    } else if !owner.is_empty() {
        known.insert(top, owner);
    }
}

/// Whether a write raised its window: only a call the person stayed out of,
/// made while they were in another window, tells; `None` otherwise, and a
/// later change is never attributed to the write. `outside` says the
/// foreground before was a real window other than the target.
fn raised_by_write(before: &Snapshot, after: &Snapshot, outside: bool, inside_after: bool) -> Option<bool> {
    let unchanged = before.ready
        && after.ready
        && before.generation == after.generation
        && before.sequence == after.sequence;
    (unchanged && outside).then_some(inside_after)
}

/// What the keyboard replacement did.
#[derive(Debug, PartialEq)]
enum Replaced {
    /// The selection could not be proved; only selection messages were sent.
    Unproven,
    /// Delete was sent but the control still holds text; nothing was typed.
    Kept,
    Typed,
}

/// Selects all, deletes, proves the control empty, then types (the sends of
/// Write-ValueByKeys). No key that deletes goes out until the control itself
/// reports its whole text selected, and nothing is typed until it reports
/// itself empty. `deleted` says whether Delete may have gone out.
fn replace_text(
    background: &dyn Background,
    top: Wid,
    preferred: Wid,
    has_text: bool,
    typed: &str,
    deleted: &Cell<bool>,
) -> Res<Replaced> {
    let end = background.select_all(top, preferred, has_text)?;
    if end < 0 {
        return Ok(Replaced::Unproven);
    }
    if end > 0 {
        deleted.set(true);
        background.keys_to(top, preferred, "{DELETE}")?;
        // A selected range can still refuse deletion (protected text, a key
        // filter); empty is proven in the same selection units: the end of
        // the text is position 0.
        if background.text_end(top, preferred)? != 0 {
            return Ok(Replaced::Kept);
        }
    }
    if !typed.is_empty() {
        background.text_to(top, preferred, typed)?;
    }
    Ok(Replaced::Typed)
}

/// The verdict on an accessibility value write whose readback `matches`. A
/// Chromium or Electron page accepts the write and echoes it back through the
/// accessibility layer while the page may never have seen it, so a matching
/// readback on a web page proves nothing and is reported unverifiable.
fn written_value_verdict(reference: &str, route: &str, matches: bool, web_page: bool) -> (bool, String) {
    if matches && web_page {
        let message = format!(
            "set {reference} value {route}; the readback matches, but the web page may not have observed the write, so it is not confirmed; check the screenshot before treating it as complete"
        );
        return (false, message);
    }
    (matches, format!("set {reference} value {route}; readback={matches}"))
}

impl Host {
    pub(in crate::host) fn do_set_value(&self, req: &Req, text: &str) -> Res<Obj> {
        let reference = req.text("ref");
        let (element, window) = self.ref_record(&reference)?;
        let id = Some(window);
        let refuse = |message: String, code: &str| {
            Ok(self.background_unavailable("set_value", &message, id.clone(), code, false))
        };
        if element.source() == "msaa" {
            return self.set_msaa_value(&reference, &*element, text, id);
        }
        if element.value().is_none() && !element.settable() {
            return refuse(
                format!("element {reference} exposes no ValuePattern; no keystroke fallback was attempted"),
                "background_unavailable",
            );
        }
        if element.ignores_value_write() {
            return refuse(
                format!("element {reference} is an Excel cell, which echoes an accessibility value write without entering it; select the cell and type with explicit foreground delivery; no value was set"),
                "value_write_ignored",
            );
        }
        let top = element.top_window();
        let background = self.desktop.background();
        let identity = |window: Wid| self.desktop.window_owner_identity(window);
        let activating = self.session(|session| activates(&mut session.value_write_activators, top, &identity));
        let preferred = if activating { element.native_handle() } else { 0 };
        let keyboard_ok = || {
            background.is_some_and(|background| background.validate_target(top, preferred, "type", Some("")).is_ok())
        };
        let route = route(activating, element.enabled(), element.read_only(), preferred, keyboard_ok);
        if let Route::Refused(code, state) = route {
            return refuse(format!("element {reference} {state}; no input was sent"), code);
        }
        self.authorize_current(0)?;
        if let Err(scope) = element.exclusive_selection() {
            return refuse(
                format!("element {reference} belongs to an item that could not be made the only selection, and the write would apply to every selected item ({scope}); no value was set"),
                "selection_not_exclusive",
            );
        }
        if let (Route::Keys(preferred), Some(background)) = (route, background) {
            if let Some(result) = self.write_by_keys(background, &reference, &*element, top, preferred, text, id.clone())? {
                return Ok(result);
            }
        }
        // The observer brackets the foreground reads, so user input anywhere
        // between the two baselines shows up as a changed sequence.
        let input_before = self.observer.read();
        let foreground_before = self.desktop.foreground();
        element.set_value(text)?;
        let foreground_after = self.desktop.foreground();
        let input_after = self.observer.read();
        let in_target = |window: Wid| window == top || self.is_contained(window, top) || self.desktop.is_owned_by(window, top);
        let outside = self.is_window(foreground_before) && !in_target(foreground_before);
        if let Some(raised) = raised_by_write(&input_before, &input_after, outside, in_target(foreground_after)) {
            self.session(|session| note_activation(&mut session.value_write_activators, top, raised, &identity));
        }
        let mut actual = String::new();
        for _ in 0..8 {
            actual = element.value().unwrap_or_default();
            if actual == text {
                break;
            }
            sleep_ms(25);
        }
        let (prefix, tree) = self.semantic_words();
        let (verified, message) = written_value_verdict(&reference, &format!("through {tree}"), actual == text, self.is_web_page(top));
        Ok(self.action_result(
            "set_value",
            &format!("{prefix}_value"),
            effect(verified),
            verified,
            &message,
            None,
            "background",
            id,
        ))
    }

    fn is_web_page(&self, window: Wid) -> bool {
        self.desktop.background().is_some_and(|background| background.is_web_content_host(window))
    }

    /// An MSAA ref's value write (Do-SetValue, the msaa branch): the element's
    /// own state is honoured before any write, and the readback is ordinal.
    fn set_msaa_value(&self, reference: &str, element: &dyn Element, text: &str, id: Option<String>) -> Res<Obj> {
        for (refused, code, state) in [
            (!element.enabled(), "element_disabled", "is disabled"),
            (element.read_only(), "element_read_only", "is read-only"),
        ] {
            if refused {
                let message = format!("element {reference} {state}; no input was sent");
                return Ok(self.background_unavailable("set_value", &message, id, code, false));
            }
        }
        self.authorize_current(0)?;
        if let Err(error) = element.set_value(text) {
            let message = format!("MSAA value set failed for {reference}: {error}");
            return Ok(self.background_unavailable("set_value", &message, id, "msaa_value_failed", true));
        }
        let matches = element.value().unwrap_or_default() == text;
        let (verified, message) = written_value_verdict(reference, "through MSAA", matches, self.is_web_page(element.top_window()));
        Ok(self.action_result("set_value", "msaa_value", effect(verified), verified, &message, None, "background", id))
    }

    /// Replaces the value through the control's keyboard, in one inactive
    /// scope: the sent keys are handled by the control as typing, so its
    /// read-only state, length limit and change notifications all apply. The
    /// one readback after the send must equal the requested text; anything
    /// else is reported unverified and never written again. `None` when the
    /// selection could not be proved, so the caller may write another way
    /// (Write-ValueByKeys).
    #[allow(clippy::too_many_arguments)]
    fn write_by_keys(
        &self,
        background: &dyn Background,
        reference: &str,
        element: &dyn Element,
        top: Wid,
        preferred: Wid,
        text: &str,
        id: Option<String>,
    ) -> Res<Option<Obj>> {
        let Some(before) = element.value() else {
            return Ok(Some(self.background_unavailable(
                "set_value",
                &format!("the value of {reference} cannot be read, so its replacement could not be verified; no input was sent"),
                id,
                "background_unsupported",
                false,
            )));
        };
        // A bare CR would be dropped by the keyboard route, so every line
        // break is sent as the Enter it stands for.
        let typed = typed_line_breaks(text);
        let deleted = Cell::new(false);
        let replaced = self.within_scope(background, top, || {
            replace_text(background, top, preferred, !before.is_empty(), &typed, &deleted)
        });
        match replaced {
            Err(error) => self.background_failure("set_value", &error, id, deleted.get()).map(Some),
            Ok(Replaced::Unproven) => Ok(None),
            Ok(Replaced::Kept) => {
                let message = format!("sent Delete to the selected text of {reference}, but the control still holds text, so nothing was typed; refresh state before writing again");
                let mut kept = self.action_result("set_value", "win32_message", "unverifiable", false, &message, None, "background", id);
                kept.insert("input_may_have_executed".into(), json!(true));
                Ok(Some(kept))
            }
            Ok(Replaced::Typed) => {
                let verified = typed_line_breaks(&element.value().unwrap_or_default()) == typed;
                let readback = if verified {
                    "readback=True"
                } else {
                    "it does not read back as the requested text; refresh state before treating it as complete"
                };
                let message = format!("replaced {reference} value with native keyboard messages; {readback}");
                Ok(Some(self.action_result("set_value", "win32_message", effect(verified), verified, &message, None, "background", id)))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owners(pairs: &[(Wid, &'static str)]) -> impl Fn(Wid) -> String {
        let table: HashMap<Wid, &'static str> = pairs.iter().copied().collect();
        move |window| table.get(&window).copied().unwrap_or("").to_string()
    }

    fn input(ready: bool, generation: &str, sequence: i64) -> Snapshot {
        Snapshot { ready, reason: "", generation: generation.into(), sequence, relevant_sequence: sequence, tick: 0, own_tick: 0 }
    }

    #[test]
    fn a_window_that_raised_itself_is_remembered_until_its_owner_changes() {
        let mut known = HashMap::new();
        note_activation(&mut known, 5, true, &owners(&[(5, "10:20")]));
        assert!(activates(&mut known, 5, &owners(&[(5, "10:20")])));
        // The handle was reused by another window.
        assert!(!activates(&mut known, 5, &owners(&[(5, "11:21")])));
        assert!(known.is_empty());
        // A window that does not raise itself is forgotten; a gone one is never kept.
        note_activation(&mut known, 6, true, &owners(&[(6, "1:2")]));
        note_activation(&mut known, 6, false, &owners(&[(6, "1:2")]));
        note_activation(&mut known, 7, true, &owners(&[]));
        assert!(known.is_empty());
    }

    #[test]
    fn a_write_is_judged_only_when_nobody_else_acted() {
        let before = input(true, "g", 4);
        assert_eq!(raised_by_write(&before, &input(true, "g", 4), true, true), Some(true));
        assert_eq!(raised_by_write(&before, &input(true, "g", 4), true, false), Some(false));
        assert_eq!(raised_by_write(&before, &input(true, "g", 5), true, true), None);
        assert_eq!(raised_by_write(&before, &input(true, "h", 4), true, true), None);
        assert_eq!(raised_by_write(&before, &input(false, "g", 4), true, true), None);
        // The person was already in the target window.
        assert_eq!(raised_by_write(&before, &input(true, "g", 4), false, true), None);
    }

    #[test]
    fn the_route_honours_the_elements_state_before_any_key() {
        assert_eq!(route(false, false, true, 0, || true), Route::Pattern);
        assert_eq!(route(true, false, true, 9, || true), Route::Refused("element_disabled", "is disabled"));
        assert_eq!(route(true, true, true, 9, || true), Route::Refused("element_read_only", "is read-only"));
        assert_eq!(route(true, true, false, 9, || true), Route::Keys(9));
        // No keyboard target of its own, or one that drops keys: the pattern write runs.
        assert_eq!(route(true, true, false, 0, || true), Route::Pattern);
        assert_eq!(route(true, true, false, 9, || false), Route::Pattern);
    }

    #[test]
    fn a_web_page_readback_that_only_echoes_the_write_is_not_a_confirmation() {
        assert_eq!(written_value_verdict("s1:e0", "through UIA", true, false), (true, "set s1:e0 value through UIA; readback=true".into()));
        assert_eq!(written_value_verdict("s1:e0", "through UIA", false, true), (false, "set s1:e0 value through UIA; readback=false".into()));
        let (verified, message) = written_value_verdict("s1:e0", "through UIA", true, true);
        assert!(!verified);
        assert!(message.contains("may not have observed the write"));
    }

    #[test]
    fn line_breaks_are_one_enter_each() {
        assert_eq!(typed_line_breaks("a\r\nb\rc\nd"), "a\nb\nc\nd");
    }

    /// A background whose select and text-end replies are scripted and whose
    /// sends are logged.
    struct Script {
        select: Result<i32, String>,
        end: i32,
        log: std::cell::RefCell<Vec<String>>,
    }

    impl Background for Script {
        fn validate(&self, _: Wid, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn pointer(&self, _: Wid, _: i32, _: i32, _: &str, _: &[crate::keys::Mod]) -> Result<String, String> {
            unreachable!()
        }
        fn wheel(&self, _: Wid, _: i32, _: i32, _: i32, _: bool, _: &[crate::keys::Mod]) -> Result<String, String> {
            unreachable!()
        }
        fn drag(&self, _: Wid, _: &[(i32, i32)], _: &[crate::keys::Mod]) -> Result<String, String> {
            unreachable!()
        }
        fn keys(&self, _: Wid, _: &str) -> Result<String, String> {
            unreachable!()
        }
        fn text(&self, _: Wid, _: &str) -> Result<String, String> {
            unreachable!()
        }
        fn keys_to(&self, _: Wid, _: Wid, keys: &str) -> Result<String, String> {
            self.log.borrow_mut().push(format!("keys {keys}"));
            Ok(String::new())
        }
        fn text_to(&self, _: Wid, _: Wid, text: &str) -> Result<String, String> {
            self.log.borrow_mut().push(format!("text {text}"));
            Ok(String::new())
        }
        fn select_all(&self, _: Wid, _: Wid, _: bool) -> Result<i32, String> {
            self.select.clone()
        }
        fn text_end(&self, _: Wid, _: Wid) -> Result<i32, String> {
            Ok(self.end)
        }
    }

    fn replace(select: Result<i32, String>, end: i32) -> (Res<Replaced>, Vec<String>, bool) {
        let script = Script { select, end, log: Default::default() };
        let deleted = Cell::new(false);
        let outcome = replace_text(&script, 1, 2, true, "new", &deleted);
        (outcome, script.log.take(), deleted.get())
    }

    #[test]
    fn an_unproven_selection_sends_nothing_and_falls_back() {
        assert_eq!(replace(Ok(-1), 0), (Ok(Replaced::Unproven), vec![], false));
    }

    #[test]
    fn a_control_that_keeps_its_text_after_delete_is_never_typed_into() {
        let (outcome, log, deleted) = replace(Ok(4), 3);
        assert_eq!((outcome, deleted), (Ok(Replaced::Kept), true));
        assert_eq!(log, ["keys {DELETE}"]);
    }

    #[test]
    fn an_emptied_control_gets_the_text() {
        let (outcome, log, _) = replace(Ok(4), 0);
        assert_eq!(outcome, Ok(Replaced::Typed));
        assert_eq!(log, ["keys {DELETE}", "text new"]);
        // An already empty selection needs no delete.
        let (_, log, deleted) = replace(Ok(0), 0);
        assert_eq!((log, deleted), (vec!["text new".to_string()], false));
    }

    #[test]
    fn a_refused_selection_message_is_a_failure_before_any_delete() {
        let (outcome, _, deleted) = replace(Err("background_unsupported|x".into()), 0);
        assert_eq!((outcome, deleted), (Err("background_unsupported|x".into()), false));
    }

    /// Writes `text` to the one MSAA element of a window.
    fn write_msaa(probe: super::super::observable::probe::Probe, text: &str) -> (Obj, std::rc::Rc<super::super::observable::probe::Probe>) {
        use super::super::observable::probe::probe_node;
        use crate::host::semantic::tests::{host, snapshot};
        let probe = std::rc::Rc::new(probe);
        let (host, _) = host(vec![probe_node(&probe)]);
        snapshot(&host, json!({}));
        let result = host.do_set_value(&Req(json!({ "ref": "s1:e0" })), text).expect("set");
        (result, probe)
    }

    #[test]
    fn an_msaa_write_checks_the_elements_own_state_first() {
        use super::super::observable::probe::Probe;
        let (result, probe) = write_msaa(Probe { enabled: Cell::new(false), ..Probe::default() }, "x");
        assert_eq!((result["code"].as_str(), result.get("input_may_have_executed")), (Some("element_disabled"), None));
        assert!(probe.log.borrow().is_empty());
        let (result, probe) = write_msaa(Probe { read_only: true, ..Probe::default() }, "x");
        assert_eq!(result["code"], "element_read_only");
        assert_eq!(result["text"], "element s1:e0 is read-only; no input was sent");
        assert!(probe.log.borrow().is_empty());
    }

    #[test]
    fn an_msaa_write_is_read_back_ordinally() {
        use super::super::observable::probe::Probe;
        let (result, probe) = write_msaa(Probe::default(), "Abc");
        assert_eq!(result["path"], "msaa_value");
        assert_eq!((result["verified"].as_bool(), result["effect"].as_str()), (Some(true), Some("confirmed")));
        assert_eq!(result["text"], "set s1:e0 value through MSAA; readback=true");
        assert_eq!(*probe.log.borrow(), ["set Abc"]);
        // A control that keeps another case did not take the text.
        let (result, _) = write_msaa(Probe { keeps: Some("abc"), ..Probe::default() }, "Abc");
        assert_eq!((result["verified"].as_bool(), result["effect"].as_str()), (Some(false), Some("unverifiable")));
    }

    #[test]
    fn a_failed_msaa_write_may_have_run() {
        use super::super::observable::probe::Probe;
        let (result, _) = write_msaa(Probe { failure: Some("boom"), ..Probe::default() }, "x");
        assert_eq!(result["code"], "msaa_value_failed");
        assert_eq!(result["text"], "MSAA value set failed for s1:e0: boom");
        assert_eq!(result["delivery_accepted"], serde_json::Value::Null);
        assert_eq!(result["input_may_have_executed"], true);
    }
}
