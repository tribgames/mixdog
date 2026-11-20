//! The input reader: a thread that turns terminal reads and resizes into events, and the drain that discards what is still
//! queued when the session ends.
//!
//! Unix reads stdin with `read(2)` (waiting in `poll(2)` so that stopping the reader wakes it) and takes SIGWINCH through
//! signal-hook. Windows waits on the console input handle and reads the records with `ReadConsoleInputW`: a key-down
//! record's UTF-16 character, with surrogate pairs joined, becomes UTF-8 bytes (in VT input mode the console delivers the
//! terminal's own sequences character by character), a window-buffer-size record becomes a [`TermEvent::Resize`] and every
//! other record is ignored. Resize events are not debounced here: the application does that.

use std::io::{IsTerminal, stdin};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;

/// What the reader reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TermEvent {
    /// Bytes the terminal sent (feed them to [`crate::input::Decoder`]).
    Bytes(Vec<u8>),
    /// The terminal's new size as `(columns, rows)`.
    Resize(u16, u16),
    /// The input is gone (end of file, a hangup, a read error): nothing more will arrive. The application ends the
    /// session through [`crate::guard::SignalCleanup::stdio_dead`].
    Closed,
}

/// The size of one read.
#[cfg(unix)]
const READ_CHUNK: usize = 8192;

/// Handle of a running reader. Dropping it stops the reader.
pub struct ReaderHandle {
    stop: Option<Box<dyn FnOnce() + Send>>,
    threads: Vec<JoinHandle<()>>,
}

impl std::fmt::Debug for ReaderHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReaderHandle").field("threads", &self.threads.len()).finish_non_exhaustive()
    }
}

impl ReaderHandle {
    /// Stops the reader threads and waits for them. Events already sent stay in the channel.
    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
        for thread in self.threads.drain(..) {
            // A reader thread that panicked has nothing more to report; the session is ending.
            let _ = thread.join();
        }
    }
}

impl Drop for ReaderHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts reading the terminal. When the reader cannot start, the channel gets [`TermEvent::Closed`].
pub fn spawn_reader(tx: Sender<TermEvent>) -> ReaderHandle {
    match platform::spawn(tx.clone()) {
        Ok(handle) => handle,
        Err(error) => {
            report_start_failure(&error);
            // The receiver may already be gone; then nobody waits for the event.
            let _ = tx.send(TermEvent::Closed);
            ReaderHandle { stop: None, threads: Vec::new() }
        }
    }
}

/// The reader could not start; the reason goes to stderr, which the stderr guard sends to its log.
fn report_start_failure(error: &std::io::Error) {
    eprintln!("mixdog: the terminal reader could not start: {error}");
}

/// Discards what the terminal still has queued so that keys and mouse reports typed during shutdown do not reach the
/// shell. Unix reads `/dev/tty` without blocking, at most 64 times 1 KiB (and turns raw mode on for the reads when it is
/// not on, so that a partial line is returned); Windows discards the pending console input records.
pub fn drain_stdin() {
    if !stdin().is_terminal() {
        return;
    }
    platform::drain();
}

/// UTF-16 units to UTF-8: a high surrogate waits for its low half, a lone one becomes U+FFFD.
#[cfg(any(windows, test))]
fn push_utf16_unit(out: &mut Vec<u8>, pending_high: &mut Option<u16>, unit: u16) {
    let mut buf = [0u8; 4];
    if let Some(high) = pending_high.take() {
        if (0xDC00..=0xDFFF).contains(&unit) {
            let c = char::decode_utf16([high, unit]).next().and_then(Result::ok).unwrap_or(char::REPLACEMENT_CHARACTER);
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            return;
        }
        out.extend_from_slice(char::REPLACEMENT_CHARACTER.encode_utf8(&mut buf).as_bytes());
    }
    if (0xD800..=0xDBFF).contains(&unit) {
        *pending_high = Some(unit);
        return;
    }
    let c = char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

#[cfg(unix)]
mod platform {
    use std::ffi::CStr;
    use std::io::{self, IsTerminal, stdin};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::sync::Arc;
    use std::sync::mpsc::Sender;

    use mixdog_fsio::{File, Unlaned};
    use signal_hook::consts::SIGWINCH;
    use signal_hook::iterator::Signals;

    use super::{READ_CHUNK, ReaderHandle, TermEvent};

    const TTY_PATH: &CStr = c"/dev/tty";
    use crate::console::{self, RawConsole};

    /// A pipe whose read end becomes readable when the reader must stop.
    struct Waker {
        read: RawFd,
        write: RawFd,
    }

    impl Waker {
        fn new() -> io::Result<Waker> {
            let mut fds = [0 as libc::c_int; 2];
            // SAFETY: pipe fills the two descriptors of the array.
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            for fd in fds {
                // SAFETY: the descriptors were just created; the close-on-exec flag keeps them from child processes.
                unsafe {
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
            }
            Ok(Waker { read: fds[0], write: fds[1] })
        }

        fn wake(&self) {
            let byte = 1u8;
            // SAFETY: writes one byte from a live local to the pipe's write end.
            unsafe {
                libc::write(self.write, std::ptr::from_ref(&byte).cast(), 1);
            }
        }
    }

    impl Drop for Waker {
        fn drop(&mut self) {
            // SAFETY: the two descriptors belong to this value.
            unsafe {
                libc::close(self.read);
                libc::close(self.write);
            }
        }
    }

    /// Stdin when it is a terminal, else the controlling terminal.
    fn input_file() -> io::Result<(RawFd, Option<File>)> {
        if stdin().is_terminal() {
            return Ok((0, None));
        }
        let tty = File::open(&Unlaned, "/dev/tty")?;
        Ok((tty.as_raw_fd(), Some(tty)))
    }

    fn read_loop(fd: RawFd, waker: &Waker, tx: &Sender<TermEvent>) {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            let mut fds = [libc::pollfd { fd, events: libc::POLLIN, revents: 0 }, libc::pollfd { fd: waker.read, events: libc::POLLIN, revents: 0 }];
            // SAFETY: the array holds two live pollfd structs.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if ready < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                let _ = tx.send(TermEvent::Closed);
                return;
            }
            if fds[1].revents != 0 {
                return;
            }
            if fds[0].revents == 0 {
                continue;
            }
            // SAFETY: reads into a live buffer of the given length.
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            match usize::try_from(n) {
                Ok(0) => {
                    let _ = tx.send(TermEvent::Closed);
                    return;
                }
                Ok(n) => {
                    if tx.send(TermEvent::Bytes(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let kind = io::Error::last_os_error().kind();
                    if matches!(kind, io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                        continue;
                    }
                    let _ = tx.send(TermEvent::Closed);
                    return;
                }
            }
        }
    }

    pub(super) fn spawn(tx: Sender<TermEvent>) -> io::Result<ReaderHandle> {
        let (fd, tty) = input_file()?;
        let waker = Arc::new(Waker::new()?);
        let mut signals = Signals::new([SIGWINCH])?;
        let signals_handle = signals.handle();

        let read_tx = tx.clone();
        let read_waker = Arc::clone(&waker);
        let reader = std::thread::Builder::new().name("mixdog-term-reader".into()).spawn(move || {
            let _tty = tty;
            read_loop(fd, &read_waker, &read_tx);
        })?;
        let resizer = std::thread::Builder::new().name("mixdog-term-resize".into()).spawn(move || {
            for _ in signals.forever() {
                if let Ok((columns, rows)) = console::terminal_size() {
                    if tx.send(TermEvent::Resize(columns, rows)).is_err() {
                        return;
                    }
                }
            }
        });
        let resizer = match resizer {
            Ok(thread) => thread,
            Err(error) => {
                waker.wake();
                let _ = reader.join();
                return Err(error);
            }
        };
        let stop: Box<dyn FnOnce() + Send> = Box::new(move || {
            signals_handle.close();
            waker.wake();
        });
        Ok(ReaderHandle { stop: Some(stop), threads: vec![reader, resizer] })
    }

    pub(super) fn drain() {
        let was_raw = console::is_raw();
        let raw = if was_raw { None } else { RawConsole::enable().ok() };
        if !was_raw && raw.is_none() {
            return;
        }
        // SAFETY: a NUL-terminated path; the descriptor it returns is owned below.
        let fd = unsafe { libc::open(TTY_PATH.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
        if fd >= 0 {
            // SAFETY: open returned a descriptor nobody else owns.
            let tty = unsafe { OwnedFd::from_raw_fd(fd) };
            let mut buf = [0u8; 1024];
            for _ in 0..64 {
                // SAFETY: reads into a live buffer of the given length.
                let n = unsafe { libc::read(tty.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n <= 0 {
                    break;
                }
            }
        }
        drop(raw);
    }
}

#[cfg(windows)]
mod platform {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::sync::Arc;
    use std::sync::mpsc::Sender;

    use mixdog_fsio::File;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{FlushConsoleInputBuffer, INPUT_RECORD, KEY_EVENT, ReadConsoleInputW, WINDOW_BUFFER_SIZE_EVENT};
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects};

    use super::{ReaderHandle, TermEvent, push_utf16_unit};
    use crate::console::{self, open_console};

    /// `VK_MENU`: the Alt key.
    const VK_MENU: u16 = 0x12;

    /// A manual-reset event that is set when the reader must stop.
    struct Waker(HANDLE);

    // SAFETY: an event handle may be used from any thread.
    unsafe impl Send for Waker {}
    // SAFETY: as above; setting and waiting on an event are thread-safe.
    unsafe impl Sync for Waker {}

    impl Waker {
        fn new() -> io::Result<Waker> {
            // SAFETY: no security attributes and no name.
            let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Waker(event))
        }

        fn wake(&self) {
            // SAFETY: the handle is owned by this value.
            unsafe {
                SetEvent(self.0);
            }
        }
    }

    impl Drop for Waker {
        fn drop(&mut self) {
            // SAFETY: the handle is owned by this value and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    const RECORDS: usize = 64;

    fn flush_bytes(bytes: &mut Vec<u8>, tx: &Sender<TermEvent>) -> bool {
        if bytes.is_empty() {
            return true;
        }
        tx.send(TermEvent::Bytes(std::mem::take(bytes))).is_ok()
    }

    fn read_loop(input: File, waker: &Waker, tx: &Sender<TermEvent>) {
        let handle = input.as_raw_handle();
        let handles = [handle, waker.0];
        let mut pending_high: Option<u16> = None;
        loop {
            // SAFETY: both handles are live for the whole loop.
            let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            if waited == WAIT_OBJECT_0 + 1 {
                return;
            }
            if waited != WAIT_OBJECT_0 {
                let _ = tx.send(TermEvent::Closed);
                return;
            }
            // SAFETY: INPUT_RECORD is plain data; all-zero is a valid value.
            let mut records: [INPUT_RECORD; RECORDS] = unsafe { std::mem::zeroed() };
            let mut read = 0u32;
            // SAFETY: the buffer holds RECORDS records and the count pointer is to a live u32.
            let ok = unsafe { ReadConsoleInputW(handle, records.as_mut_ptr(), RECORDS as u32, &mut read) };
            if ok == 0 {
                let _ = tx.send(TermEvent::Closed);
                return;
            }
            let mut bytes = Vec::new();
            for record in &records[..read as usize] {
                match u32::from(record.EventType) {
                    KEY_EVENT => {
                        // SAFETY: EventType says the KeyEvent member is the one set.
                        let key = unsafe { record.Event.KeyEvent };
                        // SAFETY: both members of the union are plain integers.
                        let unit = unsafe { key.uChar.UnicodeChar };
                        // A key-down carries its character; the release of Alt carries the one typed with the Alt+numpad sequence
                        // (the console host delivers every UTF-16 unit it has no key for, an emoji's two halves, that way).
                        if key.bKeyDown == 0 && !(key.wVirtualKeyCode == VK_MENU && unit != 0) {
                            continue;
                        }
                        if unit == 0 {
                            continue;
                        }
                        for _ in 0..key.wRepeatCount.max(1) {
                            push_utf16_unit(&mut bytes, &mut pending_high, unit);
                        }
                    }
                    WINDOW_BUFFER_SIZE_EVENT => {
                        if !flush_bytes(&mut bytes, tx) {
                            return;
                        }
                        // SAFETY: EventType says the WindowBufferSizeEvent member is the one set.
                        let size = unsafe { record.Event.WindowBufferSizeEvent.dwSize };
                        let (columns, rows) = console::terminal_size().unwrap_or((u16::try_from(size.X).unwrap_or(0), u16::try_from(size.Y).unwrap_or(0)));
                        if tx.send(TermEvent::Resize(columns, rows)).is_err() {
                            return;
                        }
                    }
                    _ => {}
                }
            }
            if !flush_bytes(&mut bytes, tx) {
                return;
            }
        }
    }

    pub(super) fn spawn(tx: Sender<TermEvent>) -> io::Result<ReaderHandle> {
        let input = open_console("CONIN$")?;
        let waker = Arc::new(Waker::new()?);
        let thread_waker = Arc::clone(&waker);
        let reader = std::thread::Builder::new().name("mixdog-term-reader".into()).spawn(move || read_loop(input, &thread_waker, &tx))?;
        Ok(ReaderHandle { stop: Some(Box::new(move || waker.wake())), threads: vec![reader] })
    }

    pub(super) fn drain() {
        if let Ok(input) = open_console("CONIN$") {
            // SAFETY: the handle is owned by `input`.
            unsafe {
                FlushConsoleInputBuffer(input.as_raw_handle());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(units: &[u16]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut pending = None;
        for unit in units {
            push_utf16_unit(&mut out, &mut pending, *unit);
        }
        out
    }

    #[test]
    fn ascii_and_bmp_units() {
        assert_eq!(encode(&[0x61, 0x1b, 0x5b, 0x41]), b"a\x1b[A");
        assert_eq!(encode(&[0xd55c]), "한".as_bytes());
    }

    #[test]
    fn a_surrogate_pair_is_joined() {
        assert_eq!(encode(&[0xd83d, 0xde00]), "😀".as_bytes());
    }

    #[test]
    fn a_lone_surrogate_is_the_replacement_character() {
        assert_eq!(encode(&[0xd83d, 0x61]), "\u{fffd}a".as_bytes());
        assert_eq!(encode(&[0xde00]), "\u{fffd}".as_bytes());
    }

    #[test]
    fn a_pair_split_over_two_batches_is_joined() {
        let mut pending = None;
        let mut first = Vec::new();
        push_utf16_unit(&mut first, &mut pending, 0xd83d);
        assert!(first.is_empty());
        let mut second = Vec::new();
        push_utf16_unit(&mut second, &mut pending, 0xde00);
        assert_eq!(second, "😀".as_bytes());
    }

    #[test]
    fn the_reader_event_is_comparable() {
        assert_eq!(TermEvent::Resize(80, 24), TermEvent::Resize(80, 24));
        assert_ne!(TermEvent::Closed, TermEvent::Bytes(Vec::new()));
    }
}
