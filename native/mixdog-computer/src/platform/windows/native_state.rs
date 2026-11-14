//! A native control's own observable state: an edit's text, a button's check
//! (NativeObservableState, MixWin32Keyboard.cs:668-701), which a background
//! key or click changes without any accessibility value moving.

use super::background::send_value;
use super::native::{class_name, is_window};
use crate::platform::Wid;
use windows::Win32::UI::WindowsAndMessaging::{WM_GETTEXT, WM_GETTEXTLENGTH};

/// The longest text read back, in UTF-16 units.
const TEXT_CAP: usize = 32768;
const BM_GETCHECK: u32 = 0x00F0;
const CLICKS: [&str; 5] = ["click", "double_click", "right_click", "middle_click", "triple_click"];

/// The state `action` could change on `child`; None where it reports none.
pub fn read(child: Wid, action: &str) -> Option<String> {
    if !is_window(child) {
        return None;
    }
    describe(
        &class_name(child),
        action,
        || edit_text(child),
        || send_value(child, BM_GETCHECK, 0, 0).ok(),
    )
}

/// Picks what to read by the control's class and the action: an edit's text
/// after keys, a button's check after a click. Each read answers `None` when
/// the control did not.
fn describe(
    class: &str,
    action: &str,
    text: impl FnOnce() -> Option<String>,
    check: impl FnOnce() -> Option<usize>,
) -> Option<String> {
    let class = class.to_uppercase();
    let action = action.to_lowercase();
    if matches!(action.as_str(), "key" | "type") && class.contains("EDIT") {
        return text().map(|text| format!("native_text={text}"));
    }
    if CLICKS.contains(&action.as_str()) && class.contains("BUTTON") {
        return check().map(|check| format!("native_check={check}"));
    }
    None
}

/// The control's whole text, up to the cap (WM_GETTEXTLENGTH, WM_GETTEXT).
fn edit_text(child: Wid) -> Option<String> {
    let length = send_value(child, WM_GETTEXTLENGTH, 0, 0).ok()?.min(TEXT_CAP);
    let mut buffer = vec![0u16; length + 1];
    send_value(child, WM_GETTEXT, length + 1, buffer.as_mut_ptr() as isize).ok()?;
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(length);
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(class: &str, action: &str) -> Option<String> {
        describe(class, action, || Some("abc".into()), || Some(1))
    }

    #[test]
    fn an_edit_reports_its_text_after_keys_only() {
        assert_eq!(state("Edit", "type").as_deref(), Some("native_text=abc"));
        assert_eq!(state("RICHEDIT50W", "KEY").as_deref(), Some("native_text=abc"));
        assert_eq!(state("Edit", "click"), None);
    }

    #[test]
    fn a_button_reports_its_check_after_a_click_only() {
        assert_eq!(state("Button", "click").as_deref(), Some("native_check=1"));
        assert_eq!(state("WindowsForms10.BUTTON.app", "triple_click").as_deref(), Some("native_check=1"));
        assert_eq!(state("Button", "key"), None);
        assert_eq!(state("Static", "click"), None);
    }

    #[test]
    fn a_control_that_does_not_answer_reports_nothing() {
        assert_eq!(describe("Edit", "type", || None, || None), None);
        assert_eq!(describe("Button", "click", || None, || None), None);
    }
}
