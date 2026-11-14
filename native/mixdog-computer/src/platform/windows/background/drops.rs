//! Window classes whose input stack takes a posted message without acting on
//! it. The post still succeeds, so the call would report delivery that never
//! reached the control; the table below turns each such pairing into the
//! refusal every unsupported background route already gives, before any
//! message is sent. Chromium and the UWP/WinUI hosts are refused where their
//! routes read the class (keyboard.rs, pointer.rs), and Tk by the focus check
//! in keyboard.rs, which tells an inactive frame from a focused child.

/// What a posted message would have been.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Kind {
    Key,
    /// Literal text, posted as characters.
    Text,
    Click,
    Move,
}

struct Family {
    toolkit: &'static str,
    owns: fn(&str) -> bool,
    drops: &'static [Kind],
    /// The toolkit reads posted keys while its window is the foreground one.
    keys_in_foreground: bool,
    why: &'static str,
}

const FAMILIES: [Family; 3] = [
    Family {
        toolkit: "WPF",
        owns: |class| class.starts_with("HwndWrapper"),
        drops: &[Kind::Key, Kind::Text, Kind::Click, Kind::Move],
        keys_in_foreground: true,
        why: "reads pointer input only from the live system cursor, keys only while it is the foreground window, and no posted characters",
    },
    Family {
        toolkit: "GTK",
        owns: |class| class.starts_with("gdkWindow") || class.starts_with("gdkSurface"),
        drops: &[Kind::Click],
        keys_in_foreground: false,
        why: "button widgets ignore posted clicks",
    },
    Family {
        toolkit: "VCL (LibreOffice)",
        owns: |class| class.starts_with("SAL"),
        drops: &[Kind::Key],
        keys_in_foreground: false,
        // Posted characters still reach its document widgets.
        why: "reads accelerator keys from the key state, which posted keys do not set",
    },
];

/// The refusal for a posted `kind` to a window of `class`, if that class
/// would drop it; `foreground` is whether the target's top window is the
/// foreground window.
pub(super) fn refusal(class: &str, kind: Kind, foreground: bool) -> Option<String> {
    let family = FAMILIES.iter().find(|family| (family.owns)(class))?;
    if !family.drops.contains(&kind) || (kind == Kind::Key && family.keys_in_foreground && foreground) {
        return None;
    }
    let what = match kind {
        Kind::Key => "keys",
        Kind::Text => "text",
        Kind::Click => "clicks",
        Kind::Move => "pointer moves",
    };
    Some(format!(
        "background_unsupported|a {} window drops posted {what} ({}); use explicit foreground delivery; no input sent",
        family.toolkit, family.why
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wpf_drops_pointer_always_and_keys_unless_foreground() {
        let class = "HwndWrapper[App.exe;;1f2e]";
        assert!(refusal(class, Kind::Click, true).is_some());
        assert!(refusal(class, Kind::Move, true).is_some());
        assert!(refusal(class, Kind::Key, false).is_some());
        assert_eq!(refusal(class, Kind::Key, true), None);
        assert!(refusal(class, Kind::Text, true).is_some());
    }

    #[test]
    fn gtk_drops_clicks_but_not_drags_or_keys() {
        assert!(refusal("gdkWindowToplevel", Kind::Click, false).is_some());
        assert!(refusal("gdkSurfaceToplevel", Kind::Click, false).is_some());
        assert_eq!(refusal("gdkWindowToplevel", Kind::Move, false), None);
        assert_eq!(refusal("gdkWindowToplevel", Kind::Key, false), None);
        assert_eq!(refusal("gdkWindowToplevel", Kind::Text, false), None);
    }

    #[test]
    fn vcl_drops_keys_even_in_the_foreground_but_not_text() {
        assert!(refusal("SALFRAME", Kind::Key, true).is_some());
        assert_eq!(refusal("SALFRAME", Kind::Text, false), None);
        assert_eq!(refusal("SALFRAME", Kind::Click, false), None);
    }

    #[test]
    fn other_classes_are_left_to_their_own_routes() {
        assert_eq!(refusal("Notepad", Kind::Key, false), None);
        assert_eq!(refusal("Chrome_WidgetWin_1", Kind::Click, false), None);
    }
}
