//! The raw Windows calls behind the port: the only code that hands input or a change to another application. Nothing here
//! decides whether a call may happen; `WinPort` does, and it is the only caller.

use super::{A11y, Broker, Message, Posted, Refusal, Reply, Staged, WinDriver};
use crate::platform::windows::input::{self as tracked, Section};
use crate::platform::windows::native::{self, hwnd};
use crate::platform::windows_input::Event;
use crate::platform::{Wid, WinState};
use crate::port::{Boundary, Scope};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{
    CloseHandle, E_POINTER, ERROR_ACCESS_DENIED, GetLastError, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, SetLastError, WPARAM,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::System::DataExchange::{EmptyClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId, GetProcessId, PROCESS_TERMINATE, TerminateProcess};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSE_EVENT_FLAGS, MOUSEINPUT, SendInput,
    SetActiveWindow, SetFocus, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::{AO_NOERRORUI, ApplicationActivationManager, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GWL_EXSTYLE, GetWindowLongW, IsHungAppWindow, MSG, PM_NOREMOVE, PeekMessageW, PostMessageW, SMTO_ABORTIFHUNG, SMTO_BLOCK, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE, SW_SHOWNOACTIVATE, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SendMessageCallbackW, SendMessageTimeoutW,
    SetForegroundWindow, SetWindowLongW, SetWindowPos, ShowWindowAsync, WM_CLOSE, WM_COMMAND,
};
use windows::core::{HSTRING, PCWSTR};

const WS_EX_NOACTIVATE: i32 = 0x0800_0000;
const CF_UNICODETEXT: u32 = 13;

/// `SendInput` with this host's marker in each event's extra info.
fn send_input(events: &[Event], marker: usize) -> u32 {
    if events.is_empty() {
        return 0;
    }
    let inputs: Vec<INPUT> = events
        .iter()
        .map(|event| match *event {
            Event::Key { vk, scan, flags } => INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: KEYBD_EVENT_FLAGS(flags), time: 0, dwExtraInfo: marker } },
            },
            Event::Mouse { flags, dx, dy, data } => INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: MOUSE_EVENT_FLAGS(flags), time: 0, dwExtraInfo: marker } },
            },
        })
        .collect();
    // SAFETY: the slice and the struct size describe the same allocation.
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) }
}

pub(super) struct Real {
    marker: usize,
    /// The cross-process receipt every batch is tracked in, or why there is none.
    section: Result<&'static Section, &'static str>,
}

impl Real {
    pub(super) fn new(marker: i64) -> Real {
        Real { marker: marker as usize, section: tracked::section(marker) }
    }
}

/// The reply slot a queued message's callback fills: the `Arc` handed to the system is taken back by the callback.
unsafe extern "system" fn answered(_: HWND, _: u32, data: usize, result: LRESULT) {
    // SAFETY: `data` is the `Arc::into_raw` of `enqueue`, given to the system for exactly this one callback.
    let slot = unsafe { Arc::from_raw(data as *const Mutex<Option<usize>>) };
    *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result.0 as usize);
}

fn refusal(code: u32) -> Refusal {
    match code {
        code if code == ERROR_ACCESS_DENIED.0 => Refusal::Isolated,
        0 | 1460 => Refusal::Hung,
        1400 => Refusal::Gone,
        code => Refusal::Failed(code),
    }
}

impl WinDriver for Real {
    fn send_input(&self, events: &[Event], admission: Option<&Scope>) -> Result<u32, String> {
        let receipt = self.section.map_err(String::from)?.receipt();
        let marker = self.marker;
        // The receipt's cross-process lock is taken by `deliver_tracked` before this closure runs: the wait on other processes
        // is over before admission, and admission spans only the `SendInput` call.
        receipt.deliver_tracked(
            events,
            &mut |batch| {
                let _admitted = admission.map(|scope| scope.admit(Boundary::Local)).transpose()?;
                Ok(send_input(batch, marker))
            },
            &tracked::key_down,
        )
    }

    fn hung(&self, window: Wid) -> bool {
        // SAFETY: a plain read; a stale handle answers false.
        native::is_window(window) && unsafe { IsHungAppWindow(hwnd(window)) }.as_bool()
    }

    fn owner(&self, window: Wid) -> (u32, u32) {
        if native::is_window(window) { native::pid_thread(window) } else { (0, 0) }
    }

    fn enqueue(&self, window: Wid, message: Message) -> Result<Reply, Refusal> {
        if !native::is_window(window) {
            return Err(Refusal::Gone);
        }
        let reply = Reply::default();
        let data = Arc::into_raw(reply.0.clone()) as usize;
        let (message, wparam, lparam) = message.raw();
        // SAFETY: the callback takes back `data` once; it is taken back here when the call queued nothing.
        let queued = unsafe {
            SetLastError(Default::default());
            SendMessageCallbackW(hwnd(window), message, WPARAM(wparam), LPARAM(lparam), Some(answered), data)
        };
        if queued.is_err() {
            // SAFETY: the system did not take the callback, so `data` is still this call's.
            drop(unsafe { Arc::from_raw(data as *const Mutex<Option<usize>>) });
            return Err(refusal(unsafe { GetLastError() }.0));
        }
        Ok(reply)
    }

    fn wait(&self, reply: &Reply, timeout: Duration) -> Option<usize> {
        let started = Instant::now();
        loop {
            if let Some(answer) = reply.get() {
                return Some(answer);
            }
            if started.elapsed() >= timeout {
                return None;
            }
            // A peek runs the callbacks of this thread's queued messages.
            let mut message = MSG::default();
            // SAFETY: a valid out pointer; nothing is removed from the queue.
            let _ = unsafe { PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE) };
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn post(&self, window: Wid, posted: Posted) -> Result<(), Refusal> {
        let (message, wparam) = match posted {
            Posted::Close => (WM_CLOSE, 0),
            Posted::MenuCommand(id) => (WM_COMMAND, (id & 0xFFFF) as usize),
        };
        // SAFETY: plain value arguments.
        unsafe { PostMessageW(Some(hwnd(window)), message, WPARAM(wparam), LPARAM(0)) }.map_err(|error| refusal(error.code().0 as u32 & 0xFFFF))
    }

    fn foreground(&self) -> Wid {
        native::foreground()
    }

    fn iconic(&self, window: Wid) -> bool {
        native::is_iconic(window)
    }

    fn current_thread(&self) -> u32 {
        // SAFETY: a plain read.
        unsafe { GetCurrentThreadId() }
    }

    fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool {
        // SAFETY: plain value arguments.
        unsafe { AttachThreadInput(from, to, attach) }.as_bool()
    }

    fn bring_to_top(&self, window: Wid) {
        // SAFETY: a plain value argument.
        let _ = unsafe { BringWindowToTop(hwnd(window)) };
    }

    fn set_foreground(&self, window: Wid) {
        // SAFETY: a plain value argument.
        let _ = unsafe { SetForegroundWindow(hwnd(window)) };
    }

    fn set_active(&self, window: Wid) {
        // SAFETY: a plain value argument.
        let _ = unsafe { SetActiveWindow(hwnd(window)) };
    }

    fn set_focus(&self, window: Wid) {
        // SAFETY: a plain value argument.
        let _ = unsafe { SetFocus(Some(hwnd(window))) };
    }

    fn no_name_key(&self) {
        const VK_NONAME: u16 = 0xFC;
        // The marker lets the observer count the pair as this host's own input.
        send_input(&[Event::key(VK_NONAME, 0, 0), Event::key(VK_NONAME, 0, KEYEVENTF_KEYUP.0)], self.marker);
    }

    fn show_async(&self, window: Wid, state: WinState) {
        let command = match state {
            WinState::Minimize => SW_MINIMIZE,
            WinState::Maximize => SW_MAXIMIZE,
            WinState::Restore => SW_RESTORE,
        };
        // SAFETY: plain value arguments.
        let _ = unsafe { ShowWindowAsync(hwnd(window), command) };
    }

    fn place_async(&self, window: Wid, x: i32, y: i32, width: i32, height: i32) -> bool {
        // SAFETY: plain value arguments.
        unsafe { SetWindowPos(hwnd(window), None, x, y, width, height, SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE).is_ok() }
    }

    fn terminate(&self, pid: u32) -> Result<(), String> {
        let process =
            native::Process::open(pid, PROCESS_TERMINATE.0).ok_or_else(|| format!("could not open pid {pid}: {}", std::io::Error::last_os_error()))?;
        // SAFETY: the handle carries PROCESS_TERMINATE.
        unsafe { TerminateProcess(process.0, 1) }.map_err(|error| error.to_string())
    }

    fn set_no_activate(&self, root: Wid, on: bool) -> bool {
        // SAFETY: plain value arguments.
        unsafe {
            let style = GetWindowLongW(hwnd(root), GWL_EXSTYLE);
            let wanted = if on { style | WS_EX_NOACTIVATE } else { style & !WS_EX_NOACTIVATE };
            SetWindowLongW(hwnd(root), GWL_EXSTYLE, wanted);
            GetWindowLongW(hwnd(root), GWL_EXSTYLE) & WS_EX_NOACTIVATE != 0
        }
    }

    fn set_enabled(&self, window: Wid, enabled: bool) {
        // SAFETY: plain value arguments.
        let _ = unsafe { EnableWindow(hwnd(window), enabled) };
    }

    fn accessibility(&self, action: &A11y<'_>) -> Result<(), String> {
        // SAFETY: calls on live COM objects the caller holds.
        unsafe {
            match action {
                A11y::Invoke(pattern) => pattern.Invoke(),
                A11y::Toggle(pattern) => pattern.Toggle(),
                A11y::Expand(pattern) => pattern.Expand(),
                A11y::Collapse(pattern) => pattern.Collapse(),
                A11y::SetValue(pattern, value) => pattern.SetValue(*value),
                A11y::Select(pattern) => pattern.Select(),
                A11y::Scroll(pattern, horizontal, amount) => {
                    let none = windows::Win32::UI::Accessibility::ScrollAmount_NoAmount;
                    if *horizontal { pattern.Scroll(*amount, none) } else { pattern.Scroll(none, *amount) }
                }
                A11y::DefaultAction(object, child) => object.accDoDefaultAction(&VARIANT::from(*child)),
                A11y::PutValue(object, child, value) => object.put_accValue(&VARIANT::from(*child), *value),
            }
        }
        .map_err(|error| error.message())
    }

    fn stage_text(&self, text: &str) -> Result<Staged, String> {
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a fresh movable block, filled while locked; freed on drop unless the clipboard takes it.
        unsafe {
            let global = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2).map_err(|error| error.to_string())?;
            let staged = Global(global.0 as isize);
            let pointer = GlobalLock(global) as *mut u16;
            if pointer.is_null() {
                return Err("the clipboard text could not be staged".into());
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
            let _ = GlobalUnlock(global);
            Ok(Staged(Some(staged)))
        }
    }

    fn clipboard_empty(&self) -> Result<(), String> {
        // SAFETY: the caller opened the clipboard.
        unsafe { EmptyClipboard() }.map_err(|error| error.to_string())
    }

    fn clipboard_set(&self, staged: Staged) -> Result<(), String> {
        let Some(global) = staged.0 else { return Ok(()) };
        // SAFETY: the caller opened the clipboard; ownership of the global passes to it on success.
        let set = unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0 as *mut _))) };
        if set.is_ok() {
            std::mem::forget(global);
        }
        set.map(|_| ()).map_err(|error| error.to_string())
    }

    fn shell_execute(&self, target: &str) -> windows::core::Result<u32> {
        // Shown without activation, so the person's foreground window survives the launch.
        let file = HSTRING::from(target);
        let mut request = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
            lpFile: PCWSTR(file.as_ptr()),
            nShow: SW_SHOWNOACTIVATE.0,
            ..Default::default()
        };
        // SAFETY: the request points at `file`, which outlives the call.
        unsafe {
            ShellExecuteExW(&mut request)?;
            if request.hProcess.is_invalid() {
                return Ok(0);
            }
            let pid = GetProcessId(request.hProcess);
            let _ = CloseHandle(request.hProcess);
            Ok(pid)
        }
    }

    fn create_broker(&self) -> windows::core::Result<Broker> {
        // SAFETY: COM is initialised on this thread by the desktop.
        unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_ALL) }.map(|manager| Broker(Some(manager)))
    }

    fn activate_application(&self, broker: &Broker, app_id: &str) -> windows::core::Result<u32> {
        let Some(manager) = broker.0.as_ref() else { return Err(E_POINTER.into()) };
        // A packaged app starts through the activation broker, which names the process that hosts it.
        // SAFETY: a live manager; the id outlives the call.
        unsafe { manager.ActivateApplication(&HSTRING::from(app_id), PCWSTR::null(), AO_NOERRORUI) }
    }
}

/// Global memory staged for the clipboard; freed unless the clipboard took it.
pub(crate) struct Global(isize);

impl Drop for Global {
    fn drop(&mut self) {
        // SAFETY: the block is this value's until the clipboard takes it (then it is forgotten, not dropped).
        let _ = unsafe { GlobalFree(Some(HGLOBAL(self.0 as *mut _))) };
    }
}

/// The messages a read sends: none of them changes the window.
pub(crate) enum ReadMessage<'a> {
    /// `EM_GETSEL`.
    Selection,
    /// `WM_GETTEXTLENGTH`.
    TextLength,
    /// `WM_GETTEXT` into the buffer.
    Text(&'a mut [u16]),
    /// `BM_GETCHECK`.
    Check,
}

/// One read of a window's state through its queue, bounded by a second; a read holds no permission.
pub(crate) fn read_message(window: Wid, read: ReadMessage<'_>) -> Result<usize, Refusal> {
    let (message, wparam, lparam) = match read {
        ReadMessage::Selection => (0x00B0, 0, 0),
        ReadMessage::TextLength => (0x000E, 0, 0),
        ReadMessage::Text(buffer) => (0x000D, buffer.len(), buffer.as_mut_ptr() as isize),
        ReadMessage::Check => (0x00F0, 0, 0),
    };
    let mut result = 0usize;
    // SAFETY: the call can fail without setting an error, so it is cleared first; a text buffer outlives the call.
    let sent = unsafe {
        SetLastError(Default::default());
        SendMessageTimeoutW(hwnd(window), message, WPARAM(wparam), LPARAM(lparam), SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000, Some(&mut result))
    };
    if sent.0 != 0 {
        return Ok(result);
    }
    Err(refusal(unsafe { GetLastError() }.0))
}

/// A batch sent as a person's input would be (no marker, no receipt): the live tests' stand-in for the person.
#[cfg(test)]
pub(crate) fn send_unmarked(events: &[Event]) -> u32 {
    send_input(events, 0)
}

/// The cleanup of input another process of this marker left held, from a fresh process (the abort run, an elevated worker's
/// supervisor, the cursor watchdog): only the releases the receipt records, never anything else.
pub(crate) fn release_recorded(marker: i64) -> Result<(), String> {
    match Section::open(marker) {
        Some(section) => section.receipt().release_owned(&mut |events| Ok(send_input(events, marker as usize)), &tracked::key_down),
        None => tracked::release_without_receipt(&tracked::key_down),
    }
}

/// What a killed host left on other applications' windows, put back from a fresh process: the no-activate bit cleared and a
/// shielded window enabled again. Neither ever sets a bit or disables a window.
pub(crate) mod restore_recorded {
    use super::*;

    /// Clears the no-activate bit; whether it stays set.
    pub(crate) fn clear_no_activate(root: Wid) -> bool {
        // SAFETY: plain value arguments.
        unsafe {
            let style = GetWindowLongW(hwnd(root), GWL_EXSTYLE);
            SetWindowLongW(hwnd(root), GWL_EXSTYLE, style & !WS_EX_NOACTIVATE);
            GetWindowLongW(hwnd(root), GWL_EXSTYLE) & WS_EX_NOACTIVATE != 0
        }
    }

    pub(crate) fn enable(window: Wid) {
        // SAFETY: plain value arguments.
        let _ = unsafe { EnableWindow(hwnd(window), true) };
    }
}
