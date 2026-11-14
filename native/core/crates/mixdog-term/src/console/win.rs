//! Raw mode on a Windows console: the input mode libuv sets for `UV_TTY_MODE_RAW_VT` (virtual-terminal input and window
//! events, with line input, echo and processed input off), so the bytes read are the terminal's VT sequences exactly as
//! Node read them; and virtual-terminal processing on the output as libuv enables it. The consoles are opened as
//! `CONIN$` and `CONOUT$` (as libuv reopens them) so a redirected stdin or stdout does not matter.

use std::io;
use std::os::windows::io::AsRawHandle;

use mixdog_fsio::{File, OpenOptions, Unlaned};
use windows_sys::Win32::System::Console::{
    CONSOLE_SCREEN_BUFFER_INFO, ENABLE_EXTENDED_FLAGS, ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    ENABLE_WINDOW_INPUT, GetConsoleMode, GetConsoleScreenBufferInfo, SetConsoleMode,
};

/// The input mode of a raw console: the flags libuv sets, so line input, echo and processed input are off.
const RAW_INPUT_MODE: u32 = ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS;

pub(super) struct State {
    input: File,
    output: Option<File>,
    input_mode: u32,
    output_mode: u32,
    restored: bool,
}

pub(crate) fn open_console(name: &str) -> io::Result<File> {
    OpenOptions::new().read(true).write(true).open(&Unlaned, name)
}

fn get_mode(file: &File) -> io::Result<u32> {
    let mut mode = 0u32;
    // SAFETY: the handle is owned by `file` and the pointer is to a live u32.
    if unsafe { GetConsoleMode(file.as_raw_handle(), &mut mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(mode)
}

fn set_mode(file: &File, mode: u32) -> io::Result<()> {
    // SAFETY: the handle is owned by `file`.
    if unsafe { SetConsoleMode(file.as_raw_handle(), mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn enable() -> io::Result<State> {
    let input = open_console("CONIN$")?;
    let input_mode = get_mode(&input)?;
    set_mode(&input, RAW_INPUT_MODE)?;
    // Without virtual-terminal processing (an old console) the output stays as it is, as in libuv.
    let output = open_console("CONOUT$").ok();
    let mut output_mode = 0;
    let mut output_changed = false;
    if let Some(output) = &output {
        if let Ok(mode) = get_mode(output) {
            output_mode = mode;
            output_changed = set_mode(output, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING).is_ok();
        }
    }
    Ok(State {
        input,
        output: if output_changed { output } else { None },
        input_mode,
        output_mode,
        restored: false,
    })
}

/// True when this call put the modes back.
pub(super) fn restore(state: &mut State) -> bool {
    if state.restored {
        return false;
    }
    state.restored = true;
    // A console that is gone cannot be restored; nothing is left to report to.
    let _ = set_mode(&state.input, state.input_mode);
    if let Some(output) = &state.output {
        let _ = set_mode(output, state.output_mode);
    }
    true
}

pub(super) fn terminal_size() -> io::Result<(u16, u16)> {
    let output = open_console("CONOUT$")?;
    // SAFETY: a zeroed CONSOLE_SCREEN_BUFFER_INFO is a valid value of the plain-data struct.
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is owned by `output` and the pointer is to a live struct.
    if unsafe { GetConsoleScreenBufferInfo(output.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let columns = i32::from(info.srWindow.Right) - i32::from(info.srWindow.Left) + 1;
    let rows = i32::from(info.srWindow.Bottom) - i32::from(info.srWindow.Top) + 1;
    match (u16::try_from(columns), u16::try_from(rows)) {
        (Ok(columns), Ok(rows)) if columns > 0 && rows > 0 => Ok((columns, rows)),
        _ => Err(io::Error::other("the console reports no size")),
    }
}
