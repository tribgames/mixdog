//! The Windows side of `--screen-input` (crate::screen_input): the phone's
//! input through this helper's checked `SendInput` transport, and the watcher
//! of the input desktop, the elevation prompt and the sign-in screen.

use super::input::{release_owned, Sender};
use crate::platform::Button as PointerButton;
use crate::screen_input::{code, desktop_state, id_of, on_screen, parse, Button, Command};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, POINT};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

/// How often the watcher looks at the desktop (`WATCH_INTERVAL_MS`).
const WATCH_INTERVAL: Duration = Duration::from_millis(400);

/// stdout, one whole line at a time from either thread.
#[derive(Clone)]
struct Out(Arc<Mutex<std::io::Stdout>>);

impl Out {
    fn line(&self, text: &str) {
        let out = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut out = out.lock();
        let _ = out.write_all(format!("{text}\n").as_bytes());
        let _ = out.flush();
    }
}

fn marker() -> Option<i64> {
    let value: i64 = std::env::var("MIXDOG_SCREEN_INPUT_MARKER").ok()?.trim().parse().ok()?;
    (1..=i64::from(i32::MAX)).contains(&value).then_some(value)
}

fn session_of(pid: u32) -> Option<u32> {
    let mut session = 0u32;
    // SAFETY: session is a valid out pointer.
    unsafe { ProcessIdToSessionId(pid, &mut session) }.ok().map(|_| session)
}

/// The input desktop's object name; None while it cannot be opened (the
/// secure desktop).
fn desktop_name() -> Option<String> {
    // SAFETY: the handle is closed below; the buffer outlives the call.
    unsafe {
        let desktop = OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS).ok()?;
        let mut name = [0u16; 256];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desktop);
        read.ok()?;
        let end = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
        Some(String::from_utf16_lossy(&name[..end]))
    }
}

/// Whether consent.exe and LogonUI.exe run in this process's session.
fn prompts(session: Option<u32>) -> (bool, bool) {
    let (mut consent, mut logon) = (false, false);
    // SAFETY: the snapshot handle is closed below; the entry is sized.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return (false, false) };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let end = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
            let wanted = name == "consent.exe" || name == "logonui.exe";
            if wanted && session.is_some() && session_of(entry.th32ProcessID) == session {
                if name == "consent.exe" {
                    consent = true;
                } else {
                    logon = true;
                }
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    (consent, logon)
}

fn state(session: Option<u32>) -> String {
    let (consent, logon) = prompts(session);
    desktop_state(desktop_name().as_deref(), consent, logon)
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    // SAFETY: metrics queries take plain values.
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn move_to(sender: &Sender, x: i32, y: i32) -> Result<(), String> {
    on_screen(virtual_screen(), x, y)?;
    sender.move_to(x, y)
}

fn pointer(button: Button) -> PointerButton {
    match button {
        Button::Left => PointerButton::Left,
        Button::Right => PointerButton::Right,
        Button::Middle => PointerButton::Middle,
    }
}

/// Text as the PowerShell host typed it: tabs as the Tab key (a Unicode
/// packet for a control character is dropped or misread by many apps), line
/// breaks as Enter, everything else as Unicode, paced per glyph.
fn text(sender: &Sender, text: &str) -> Result<(), String> {
    for glyph in text.chars() {
        if glyph == '\t' {
            sender.key_code(0x09, 0x0F, false, true)?;
            sender.key_code(0x09, 0x0F, false, false)?;
            std::thread::sleep(Duration::from_millis(4));
        } else {
            sender.text(glyph.encode_utf8(&mut [0; 4]))?;
        }
    }
    Ok(())
}

/// One command: the `ok` fields after the id, or the error.
fn handle(sender: &Sender, command: Command) -> Result<Option<String>, String> {
    match command {
        Command::Move { x, y } => move_to(sender, x, y)?,
        Command::Button { button, down, at } => {
            if let Some((x, y)) = at {
                move_to(sender, x, y)?;
            }
            sender.button(pointer(button), down)?;
        }
        Command::Wheel { x, y, dx, dy } => {
            move_to(sender, x, y)?;
            if dy != 0 {
                sender.wheel_units(dy, false)?;
            }
            if dx != 0 {
                sender.wheel_units(dx, true)?;
            }
        }
        Command::Key { vk, scan, extended, down } => sender.key_code(vk, scan, extended, down)?,
        Command::Text(literal) => text(sender, &literal)?,
        Command::Cursor => {
            let mut point = POINT::default();
            // SAFETY: point is a valid out pointer.
            unsafe { GetCursorPos(&mut point) }.map_err(|_| "cursor_unavailable: no cursor".to_string())?;
            return Ok(Some(format!("{} {}", point.x, point.y)));
        }
    }
    Ok(None)
}

pub fn run() -> i32 {
    let out = Out(Arc::new(Mutex::new(std::io::stdout())));
    let Some(marker) = marker() else {
        eprintln!("mixdog-computer --screen-input: input_marker_unavailable");
        return 2;
    };
    // Physical pixels everywhere: the virtual-screen metrics and the cursor
    // read-back must agree with the capture's native pixels.
    // SAFETY: a process-wide setting made before any window or metric read.
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let sender = Sender::new(marker);
    // SAFETY: a plain query of this process's id.
    let session = session_of(unsafe { GetCurrentProcessId() });
    // The first desktop state and this process's session go out before ready,
    // so every press can be tagged with where it lands.
    let mut last = state(session);
    out.line(&format!("desktop {last}"));
    out.line(&format!("ready {}", session.map_or_else(String::new, |session| session.to_string())).trim_end().to_string());
    let watcher = out.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);
        let now = state(session);
        if now != last {
            watcher.line(&format!("desktop {now}"));
            last = now;
        }
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line == "q" {
            break;
        }
        let id = id_of(&line).to_string();
        match parse(&line).and_then(|command| handle(&sender, command)) {
            Ok(Some(fields)) => out.line(&format!("ok {id} {fields}")),
            Ok(None) => out.line(&format!("ok {id}")),
            Err(error) => out.line(&format!("err {id} {}", code(&error))),
        }
    }
    // `q` or end of stdin (the app died): let go of everything this process holds.
    match release_owned(marker) {
        Ok(()) => out.line("released"),
        Err(error) => out.line(&format!("err 0 {}", code(&error))),
    }
    0
}
