//! Keys as X keysyms.

use crate::keys::{Key, Mod, Named};

pub const SHIFT_L: u32 = 0xffe1;
pub const CONTROL_L: u32 = 0xffe3;
pub const ALT_L: u32 = 0xffe9;
pub const SUPER_L: u32 = 0xffeb;
pub const RETURN: u32 = 0xff0d;
pub const TAB: u32 = 0xff09;

pub fn modifier(modifier: Mod) -> u32 {
    match modifier {
        Mod::Shift => SHIFT_L,
        Mod::Ctrl => CONTROL_L,
        Mod::Alt => ALT_L,
        Mod::Super => SUPER_L,
    }
}

pub fn of_char(c: char) -> u32 {
    let code = c as u32;
    match code {
        0x20..=0x7e | 0xa0..=0xff => code,
        _ => 0x0100_0000 + code,
    }
}

pub fn of_key(key: Key) -> Result<u32, String> {
    Ok(match key {
        Key::Mod(modifier_key) => modifier(modifier_key),
        Key::Char(c) => of_char(c),
        Key::Named(named) => match named {
            Named::Backspace => 0xff08,
            Named::Tab => TAB,
            Named::Enter => RETURN,
            Named::Escape => 0xff1b,
            Named::Space => 0x20,
            Named::PageUp => 0xff55,
            Named::PageDown => 0xff56,
            Named::End => 0xff57,
            Named::Home => 0xff50,
            Named::Left => 0xff51,
            Named::Up => 0xff52,
            Named::Right => 0xff53,
            Named::Down => 0xff54,
            Named::Insert => 0xff63,
            Named::Delete => 0xffff,
            Named::CapsLock => 0xffe5,
            Named::NumLock => 0xff7f,
            Named::ScrollLock => 0xff14,
            Named::Apps => 0xff67,
            Named::PrintScreen => 0xff61,
            Named::Pause => 0xff13,
            Named::F(number) => 0xffbe + number as u32 - 1,
        },
    })
}
