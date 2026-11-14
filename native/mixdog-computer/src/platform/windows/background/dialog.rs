//! Background input a standard dialog would not act on: an inactive dialog
//! without its control named, and dialog-manager keys (Enter, Esc, Space,
//! Tab) sent as messages (backgroundDialogInputError,
//! input/background-dialog-input.ts:38-65). A modal dialog routes keys through
//! the dialog manager of the thread holding the input focus, so a message to
//! an unfocused dialog is discarded and a default button is never pressed.

use super::super::native;
use crate::platform::Wid;

/// Win32 registers every standard dialog under this class.
const DIALOG_CLASS: &str = "#32770";

/// Keys the dialog manager interprets for the whole dialog.
const DIALOG_MANAGER_KEYS: [&str; 7] = ["enter", "return", "escape", "esc", "space", "spacebar", "tab"];

/// `dialogManagerKey`: the key name when the whole stream is one of them.
fn dialog_manager_key(keys: &str) -> Option<String> {
    let lowered = keys.trim().to_lowercase();
    let name = lowered.strip_prefix('{').unwrap_or(&lowered);
    let name = name.strip_suffix('}').unwrap_or(name);
    DIALOG_MANAGER_KEYS.contains(&name).then(|| name.to_string())
}

/// The focus_required or dialog_key_unsupported refusal for this input, if
/// any.
pub(super) fn refusal(top: Wid, preferred: Wid, action: &str, keys: Option<&str>) -> Option<String> {
    if !matches!(action, "key" | "type") || !native::is_window(top) || native::class_name(top) != DIALOG_CLASS {
        return None;
    }
    let foreground = native::foreground();
    verdict(&native::title(top), foreground != 0 && foreground != top, preferred != 0, action, keys.unwrap_or(""))
}

/// The refusal text for a standard dialog `top` (its title, whether another
/// window holds the focus, whether a ref names its control).
fn verdict(title: &str, unfocused: bool, has_ref: bool, action: &str, keys: &str) -> Option<String> {
    let label = if title.is_empty() { "the dialog".to_string() } else { format!("'{title}'") };
    if !has_ref && unfocused {
        return Some(format!(
            "focus_required|{label} does not hold keyboard focus, so background {action} would be discarded without changing it; no input was sent. Focus that window first (window operation=\"focus\"), address the control with a fresh ref, or repeat with delivery=\"foreground\"."
        ));
    }
    if action == "key" {
        if let Some(key) = dialog_manager_key(keys) {
            return Some(format!(
                "dialog_key_unsupported|{label} routes '{key}' through the dialog manager, which a background message bypasses, so no button would be pressed; no input was sent. Click the button by ref or element, or repeat with delivery=\"foreground\"."
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Option<String>) -> Option<String> {
        result.map(|text| text.split('|').next().unwrap_or_default().to_string())
    }

    #[test]
    fn an_unfocused_dialog_without_a_ref_needs_focus() {
        let refused = verdict("Save", true, false, "type", "").unwrap();
        assert!(refused.starts_with("focus_required|'Save' does not hold keyboard focus, so background type"));
        assert_eq!(code(verdict("", true, false, "key", "a")), Some("focus_required".into()));
        assert!(verdict("", true, false, "key", "a").unwrap().contains("the dialog does not hold"));
    }

    #[test]
    fn a_ref_or_a_focused_dialog_is_not_refused_for_focus() {
        assert_eq!(verdict("Save", true, true, "type", ""), None);
        assert_eq!(verdict("Save", false, false, "type", ""), None);
    }

    #[test]
    fn dialog_manager_keys_are_refused_for_key_only() {
        for keys in ["{ENTER}", " {esc} ", "Space", "{Tab}", "{Return}", "spacebar", "escape"] {
            assert_eq!(code(verdict("Save", false, true, "key", keys)), Some("dialog_key_unsupported".into()), "{keys}");
        }
        assert!(verdict("Save", false, true, "key", "{ENTER}").unwrap().contains("routes 'enter' through"));
        assert_eq!(verdict("Save", false, true, "key", "{ENTER 2}"), None);
        assert_eq!(verdict("Save", false, true, "key", "{DOWN}"), None);
        assert_eq!(verdict("Save", false, true, "type", "{ENTER}"), None);
    }

    #[test]
    fn focus_is_judged_before_the_key() {
        assert_eq!(code(verdict("Save", true, false, "key", "{ENTER}")), Some("focus_required".into()));
    }
}
