//! A native edit control's selection by EM_SETSEL and EM_GETSEL, which the
//! keyboard value replacement proves before it deletes anything
//! (BackgroundSelectAll and BackgroundTextEnd, MixWin32Keyboard.cs:597-660).

use super::background::{keyboard_target_of, send_value, WinBackground};
use crate::platform::Wid;

const EM_GETSEL: u32 = 0x00B0;
const EM_SETSEL: u32 = 0x00B1;
/// A caret position no text reaches, which the control clamps to its end.
const PAST_END: usize = 0x7FFF_FFFF;

/// One message to the control: message, wparam, lparam, and its reply.
type Send<'a> = &'a dyn Fn(u32, usize, isize) -> Result<usize, String>;

/// The control the messages go to (KeyboardTarget's checks for a named child).
/// Without one there is no control to prove a selection in.
/// The control a native selection works on: the one background keys reach
/// (KeyboardTarget), with its class and Tk checks and the focused-descendant
/// fallback when the ref names no exact child.
fn target(top: Wid, preferred: Wid) -> Result<Wid, String> {
    keyboard_target_of(top, preferred)
}

/// The selection EM_GETSEL reports; `None` when its packed reply cannot carry
/// the positions: -1 (an end past 65,535) or anything wider than two 16-bit
/// words (ReadSelection).
fn read_selection(send: Send) -> Result<Option<(i32, i32)>, String> {
    let reply = send(EM_GETSEL, 0, 0)? as u64;
    let (start, end) = ((reply & 0xFFFF) as i32, ((reply >> 16) & 0xFFFF) as i32);
    Ok((reply < 0xFFFF_FFFF).then_some((start, end)))
}

/// Puts the caret past the end, which the control clamps to its last
/// insertion position, and returns that position; -1 when the reply is not
/// one collapsed position (CaretAtEnd).
fn caret_at_end(send: Send) -> Result<i32, String> {
    send(EM_SETSEL, PAST_END, PAST_END as isize)?;
    Ok(match read_selection(send)? {
        Some((start, end)) if start == end => end,
        _ => -1,
    })
}

/// Selects everything and proves it in the control's own units: the caret at
/// the end clamps to its last insertion position P, then the control must
/// report a selection from 0 that reaches P. It may reach past P: a
/// multi-line RichEdit reports P + 1, its final paragraph mark, which no
/// caret can stand after and no key deletes. Returns P, or -1 when the proof
/// fails (a partial selection, an unpackable reply, or no position at all
/// while the value has text); a failed proof puts back the selection the
/// control reported first.
fn select_all_proof(send: Send, has_text: bool) -> Result<i32, String> {
    let original = read_selection(send)?;
    let caret = caret_at_end(send)?;
    send(EM_SETSEL, 0, -1)?;
    let whole = caret >= 0
        && (caret > 0 || !has_text)
        && matches!(read_selection(send)?, Some((0, last)) if last >= caret);
    if whole {
        return Ok(caret);
    }
    if let Some((start, end)) = original {
        send(EM_SETSEL, start as usize, end as isize)?;
    }
    Ok(-1)
}

/// Selects the control's whole text and returns its end, -1 when the
/// selection cannot be proved (BackgroundSelectAll).
pub fn select_all(background: &WinBackground, top: Wid, preferred: Wid, has_text: bool) -> Result<i32, String> {
    background.while_inactive(top, || {
        let control = target(top, preferred)?;
        select_all_proof(&|message, wparam, lparam| send_value(control, message, wparam, lparam), has_text)
    })
}

/// The control's last insertion position, 0 when it is empty (BackgroundTextEnd).
pub fn text_end(background: &WinBackground, top: Wid, preferred: Wid) -> Result<i32, String> {
    background.while_inactive(top, || {
        let control = target(top, preferred)?;
        caret_at_end(&|message, wparam, lparam| send_value(control, message, wparam, lparam))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A control that answers the two messages from its own selection state.
    struct Control {
        /// Its last insertion position P.
        end: i32,
        /// Selecting everything reaches this far (P + 1 in a RichEdit).
        whole: i32,
        selection: Cell<(i32, i32)>,
        /// A window that ignores the messages replies 0 to everything.
        inert: bool,
        /// Selecting everything stops here, as a protected range would.
        partial: Option<i32>,
    }

    impl Control {
        fn edit(end: i32) -> Control {
            Control { end, whole: end, selection: Cell::new((0, 0)), inert: false, partial: None }
        }

        fn send(&self, message: u32, wparam: usize, lparam: isize) -> Result<usize, String> {
            if self.inert {
                return Ok(0);
            }
            if message == EM_SETSEL {
                let place = |value: i64| value.min(self.end as i64) as i32;
                self.selection.set(if lparam == -1 && wparam == 0 {
                    (0, self.partial.unwrap_or(self.whole))
                } else {
                    (place(wparam as i64), place(lparam as i64))
                });
                return Ok(0);
            }
            let (start, end) = self.selection.get();
            Ok(if end > 0xFFFF { usize::MAX } else { (start as usize) | ((end as usize) << 16) })
        }
    }

    fn prove(control: &Control, has_text: bool) -> Result<i32, String> {
        select_all_proof(&|m, w, l| control.send(m, w, l), has_text)
    }

    #[test]
    fn a_classic_edit_proves_its_end_and_a_richedit_may_report_one_more() {
        assert_eq!(prove(&Control::edit(5), true), Ok(5));
        let rich = Control { whole: 6, ..Control::edit(5) };
        assert_eq!(prove(&rich, true), Ok(5));
        assert_eq!(rich.selection.get(), (0, 6));
        assert_eq!(prove(&Control::edit(0), false), Ok(0));
    }

    #[test]
    fn a_window_that_ignores_the_messages_proves_nothing() {
        let inert = Control { inert: true, ..Control::edit(5) };
        assert_eq!(prove(&inert, true), Ok(-1));
        // Empty text proves an empty selection even from silence.
        assert_eq!(prove(&inert, false), Ok(0));
    }

    #[test]
    fn a_text_past_the_packed_range_cannot_be_proved() {
        let long = Control::edit(70_000);
        assert_eq!(prove(&long, true), Ok(-1));
    }

    #[test]
    fn a_partial_selection_puts_the_original_selection_back() {
        let partial = Control { partial: Some(3), ..Control::edit(5) };
        partial.selection.set((1, 2));
        assert_eq!(prove(&partial, true), Ok(-1));
        assert_eq!(partial.selection.get(), (1, 2));
    }

    #[test]
    fn the_text_end_is_one_collapsed_position() {
        let control = Control::edit(4);
        assert_eq!(caret_at_end(&|m, w, l| control.send(m, w, l)), Ok(4));
        let empty = Control::edit(0);
        assert_eq!(caret_at_end(&|m, w, l| empty.send(m, w, l)), Ok(0));
        let long = Control::edit(70_000);
        assert_eq!(caret_at_end(&|m, w, l| long.send(m, w, l)), Ok(-1));
    }
}
