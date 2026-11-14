//! Raw mode through termios, the flags libuv sets for `UV_TTY_MODE_RAW`.

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, RawFd};

use mixdog_fsio::{File, OpenOptions, Unlaned};

pub(super) struct State {
    fd: RawFd,
    /// Keeps `/dev/tty` open when stdin is not the terminal.
    _tty: Option<File>,
    original: libc::termios,
    restored: bool,
}

/// The terminal to configure: stdin when it is one, else the controlling terminal.
fn terminal() -> io::Result<(RawFd, Option<File>)> {
    // SAFETY: isatty only inspects the descriptor number.
    if unsafe { libc::isatty(0) } == 1 {
        return Ok((0, None));
    }
    let tty = OpenOptions::new().read(true).write(true).open(&Unlaned, "/dev/tty")?;
    Ok((tty.as_raw_fd(), Some(tty)))
}

fn get_attributes(fd: RawFd) -> io::Result<libc::termios> {
    let mut attributes = MaybeUninit::<libc::termios>::uninit();
    // SAFETY: tcgetattr fills the struct it is given when it returns 0.
    if unsafe { libc::tcgetattr(fd, attributes.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: initialised by the successful tcgetattr above.
    Ok(unsafe { attributes.assume_init() })
}

fn set_attributes(fd: RawFd, attributes: &libc::termios) -> io::Result<()> {
    // SAFETY: the pointer is to a live termios.
    if unsafe { libc::tcsetattr(fd, libc::TCSADRAIN, attributes) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn enable() -> io::Result<State> {
    let (fd, tty) = terminal()?;
    let original = get_attributes(fd)?;
    let mut raw = original;
    raw.c_iflag &= !(libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON);
    raw.c_oflag |= libc::ONLCR;
    raw.c_cflag |= libc::CS8;
    raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG);
    raw.c_cc[libc::VMIN] = 1;
    raw.c_cc[libc::VTIME] = 0;
    set_attributes(fd, &raw)?;
    Ok(State { fd, _tty: tty, original, restored: false })
}

/// True when this call put the modes back.
pub(super) fn restore(state: &mut State) -> bool {
    if state.restored {
        return false;
    }
    state.restored = true;
    // A terminal that is gone cannot be restored; nothing is left to report to.
    let _ = set_attributes(state.fd, &state.original);
    true
}

fn window_size(fd: RawFd) -> Option<(u16, u16)> {
    let mut size = MaybeUninit::<libc::winsize>::uninit();
    // SAFETY: TIOCGWINSZ writes a winsize through the pointer when it returns 0.
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, size.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: initialised by the successful ioctl above.
    let size = unsafe { size.assume_init() };
    (size.ws_col > 0 && size.ws_row > 0).then_some((size.ws_col, size.ws_row))
}

pub(super) fn terminal_size() -> io::Result<(u16, u16)> {
    for fd in [1, 0, 2] {
        if let Some(size) = window_size(fd) {
            return Ok(size);
        }
    }
    let tty = OpenOptions::new().read(true).write(true).open(&Unlaned, "/dev/tty")?;
    window_size(tty.as_raw_fd()).ok_or_else(|| io::Error::other("the terminal reports no size"))
}
