//! Characters on the foreground window's keyboard layout (TaggedKeys.cs:155-170).
//! The worker asked VkKeyScan, which reads its own thread's layout; a
//! resident helper's thread never follows the user's layout switch, so the
//! foreground window's thread is asked first.

use crate::keys::Mod;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, VkKeyScanExW};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// VkKeyScanExW's answer for `glyph`: the virtual key in the low byte, the
/// shift state in the high byte. None for a glyph the layout does not type
/// with one key press.
fn scan(glyph: char) -> Option<i16> {
    let mut units = [0u16; 2];
    let [unit] = glyph.encode_utf16(&mut units) else {
        return None;
    };
    // SAFETY: these calls take and return plain values. No window in front
    // gives thread 0, which names this thread's layout.
    let mapping = unsafe {
        let mut layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), None));
        if layout.is_invalid() {
            layout = GetKeyboardLayout(0);
        }
        VkKeyScanExW(*unit, layout)
    };
    (mapping != -1).then_some(mapping)
}

/// The modifiers in a VkKeyScanExW shift state: Shift 1, Ctrl 2, Alt 4. AltGr
/// is Ctrl+Alt.
fn modifiers(mapping: i16) -> Vec<Mod> {
    [(0x100, Mod::Shift), (0x200, Mod::Ctrl), (0x400, Mod::Alt)]
        .into_iter()
        .filter(|(bit, _)| mapping & bit != 0)
        .map(|(_, modifier)| modifier)
        .collect()
}

/// The virtual key and modifiers that type `glyph`; None when the layout has
/// no key for it.
pub fn resolve_glyph(glyph: char) -> Option<(u16, Vec<Mod>)> {
    scan(glyph).map(|mapping| ((mapping & 0xFF) as u16, modifiers(mapping)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_state_bits_name_the_modifiers() {
        assert_eq!(modifiers(0x0041), Vec::<Mod>::new());
        assert_eq!(modifiers(0x0137), vec![Mod::Shift]);
        assert_eq!(modifiers(0x0651), vec![Mod::Ctrl, Mod::Alt]);
        assert_eq!(modifiers(0x0737), vec![Mod::Shift, Mod::Ctrl, Mod::Alt]);
    }
}
