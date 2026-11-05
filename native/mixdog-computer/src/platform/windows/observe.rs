//! Who is using the mouse and keyboard: low-level hooks on a thread of their
//! own record every input event as this host's (injected with its marker) or
//! someone else's, into the shared ledger.

use super::input::{note_foreign, unassigned};
use crate::observer::Shared;
use std::sync::{Arc, OnceLock};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL,
};

const INJECTED_MOUSE: u32 = 0x1;
const INJECTED_KEY: u32 = 0x10;

struct Source {
    shared: Arc<Shared>,
    marker: usize,
}

static SOURCE: OnceLock<Source> = OnceLock::new();

unsafe extern "system" fn on_mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        if let Some(source) = SOURCE.get() {
            let event = &*(data.0 as *const MSLLHOOKSTRUCT);
            let own = event.flags & INJECTED_MOUSE != 0 && event.dwExtraInfo == source.marker;
            source.shared.record(own);
            if !own {
                match message.0 as u32 {
                    0x201 | 0x202 => note_foreign(1),
                    0x204 | 0x205 => note_foreign(2),
                    0x207 | 0x208 => note_foreign(4),
                    _ => {}
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

unsafe extern "system" fn on_key(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        if let Some(source) = SOURCE.get() {
            let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
            let injected = event.flags.0 & INJECTED_KEY != 0;
            // The system injects a reserved key while a packaged app takes the
            // foreground; counting it as a person's input would block every
            // restore of the person's focus.
            if !(injected && unassigned(event.vkCode)) {
                let own = injected && event.dwExtraInfo == source.marker;
                source.shared.record(own);
                if !own {
                    note_foreign(event.vkCode as usize);
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

/// Installs both hooks and serves them from their own thread for the life of
/// the process. The ledger is ready only once both are installed.
pub fn start(shared: Arc<Shared>, marker: i64) {
    let _ = SOURCE.set(Source {
        shared: shared.clone(),
        marker: marker as usize,
    });
    let (installed, wait) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("input-observer".into())
        .spawn(move || {
            // SAFETY: hooks are installed and pumped on this one thread.
            unsafe {
                let module = GetModuleHandleW(None).ok().map(|module| module.into());
                let mouse: Result<HHOOK, _> =
                    SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0);
                let keyboard: Result<HHOOK, _> =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0);
                if mouse.is_err() || keyboard.is_err() {
                    let _ = installed.send(());
                    return;
                }
                shared.set_ready(true);
                let _ = installed.send(());
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
                shared.set_ready(false);
            }
        });
    // The first request must find the ledger already answering.
    if spawned.is_ok() {
        let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
    }
}
