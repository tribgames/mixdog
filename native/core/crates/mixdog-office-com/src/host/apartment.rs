//! The host's thread model: all COM work runs on one thread that entered a single-threaded apartment
//! (`powershell.exe -Sta`), a reader thread decodes stdin and hands what it read to that thread, and the apartment thread
//! waits for it in a call that keeps dispatching window messages, so Office's own callbacks into the host are served
//! while it is idle.

use std::io::Read;
use std::sync::mpsc;

#[cfg(windows)]
use std::sync::Arc;

#[cfg(windows)]
use windows::Win32::Foundation::CloseHandle;
#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows::Win32::System::Com::COWAIT_DISPATCH_WINDOW_MESSAGES;
#[cfg(windows)]
use windows::Win32::System::Com::CoWaitForMultipleHandles;
#[cfg(windows)]
use windows::Win32::System::Threading::CreateEventW;
#[cfg(windows)]
use windows::Win32::System::Threading::INFINITE;
#[cfg(windows)]
use windows::Win32::System::Threading::SetEvent;
#[cfg(windows)]
use windows::core::PCWSTR;

/// A single-threaded apartment on the calling thread, left (`CoUninitialize`) when dropped. It is entered exactly once, on
/// the thread that does all the COM work, and dropped after the last COM handle was.
pub struct Apartment {
    #[cfg(windows)]
    _sta: crate::com::live::Sta,
}

impl Apartment {
    pub fn enter() -> Result<Apartment, String> {
        #[cfg(windows)]
        {
            crate::com::live::Sta::enter().map(|sta| Apartment { _sta: sta }).map_err(|error| error.message)
        }
        #[cfg(not(windows))]
        {
            Ok(Apartment {})
        }
    }
}

/// What the reader thread hands over.
#[derive(Debug, PartialEq, Eq)]
pub enum Input {
    /// One line of a session host's stdin (without its line end).
    Line(String),
    /// All of a one-shot host's stdin.
    Text(String),
    /// stdin ended.
    End,
}

/// The reader's end of the hand-over.
pub struct Sender {
    tx: mpsc::Sender<Input>,
    #[cfg(windows)]
    wake: Arc<Event>,
}

/// The apartment thread's end: [`Inbox::recv`] waits for the next [`Input`] pumping window messages.
pub struct Inbox {
    rx: mpsc::Receiver<Input>,
    #[cfg(windows)]
    wake: Arc<Event>,
}

/// An auto-reset event the reader sets after each hand-over; the apartment thread waits on it.
#[cfg(windows)]
struct Event(HANDLE);

// SAFETY: an event handle is a kernel object usable from any thread; it is closed once, by the last owner.
#[cfg(windows)]
unsafe impl Send for Event {}
// SAFETY: as above, setting and waiting on an event are thread-safe.
#[cfg(windows)]
unsafe impl Sync for Event {}

#[cfg(windows)]
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle is open and closed once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// A hand-over between the reader thread and the apartment thread.
pub fn channel() -> Result<(Sender, Inbox), String> {
    let (tx, rx) = mpsc::channel();
    #[cfg(windows)]
    {
        // SAFETY: an auto-reset, unsignalled, unnamed event; the handle is owned by the returned value.
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.map_err(|error| error.to_string())?;
        let wake = Arc::new(Event(event));
        Ok((Sender { tx, wake: wake.clone() }, Inbox { rx, wake }))
    }
    #[cfg(not(windows))]
    {
        Ok((Sender { tx }, Inbox { rx }))
    }
}

impl Sender {
    /// Hands one input over; false when the apartment thread is gone.
    pub fn send(&self, input: Input) -> bool {
        let sent = self.tx.send(input).is_ok();
        #[cfg(windows)]
        {
            // SAFETY: the event is open while `self` holds it.
            let _ = unsafe { SetEvent(self.wake.0) };
        }
        sent
    }
}

#[cfg(windows)]
impl Drop for Sender {
    fn drop(&mut self) {
        // The apartment thread may be waiting: it finds the channel closed.
        // SAFETY: the event is open while `self` holds it.
        let _ = unsafe { SetEvent(self.wake.0) };
    }
}

impl Inbox {
    /// The next input; `None` once the reader is gone and everything it sent was taken. Window messages are dispatched
    /// while it waits.
    pub fn recv(&self) -> Option<Input> {
        #[cfg(windows)]
        {
            loop {
                match self.rx.try_recv() {
                    Ok(input) => return Some(input),
                    Err(mpsc::TryRecvError::Disconnected) => return None,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                // SAFETY: the event is open while `self` holds it.
                let waited =
                    unsafe { CoWaitForMultipleHandles(COWAIT_DISPATCH_WINDOW_MESSAGES.0 as u32, INFINITE, &[self.wake.0]) };
                if waited.is_err() {
                    // The wait itself failed: block on the channel instead of spinning.
                    return self.rx.recv().ok();
                }
            }
        }
        #[cfg(not(windows))]
        {
            self.rx.recv().ok()
        }
    }
}

/// `[Console]::In.ReadLine()`'s line ends: LF, CR and CRLF. Bytes are cut at line ends before they are decoded, so a
/// character split over two reads is whole when its line is.
#[derive(Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
    after_cr: bool,
}

impl LineSplitter {
    /// The lines that `bytes` completes.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\n' => lines.push(self.take()),
                b'\r' => {
                    lines.push(self.take());
                    self.after_cr = true;
                }
                other => self.pending.push(other),
            }
        }
        lines
    }

    /// The last line, which has no line end; `None` when nothing is pending.
    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() { None } else { Some(self.take()) }
    }

    fn take(&mut self) -> String {
        let line = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        line
    }
}

/// Reads `source` to its end and hands it over: line by line for a session host, whole for a one-shot host (stdin
/// decoded as UTF-8), then [`Input::End`].
pub fn pump(session: bool, mut source: impl Read, sender: &Sender) {
    let mut splitter = LineSplitter::default();
    let mut whole = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if session {
            for line in splitter.push(&buffer[..read]) {
                if !sender.send(Input::Line(line)) {
                    return;
                }
            }
        } else {
            whole.extend_from_slice(&buffer[..read]);
        }
    }
    if session {
        if let Some(line) = splitter.finish() {
            sender.send(Input::Line(line));
        }
    } else {
        sender.send(Input::Text(String::from_utf8_lossy(&whole).into_owned()));
    }
    sender.send(Input::End);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(chunks: &[&[u8]]) -> Vec<String> {
        let mut splitter = LineSplitter::default();
        let mut lines: Vec<String> = chunks.iter().flat_map(|chunk| splitter.push(chunk)).collect();
        lines.extend(splitter.finish());
        lines
    }

    #[test]
    fn lines_end_at_lf_cr_and_crlf_and_the_last_one_needs_no_end() {
        assert_eq!(lines_of(&[b"a\nb\r\nc\rd"]), ["a", "b", "c", "d"]);
        assert_eq!(lines_of(&[b"a\r", b"\nb\n"]), ["a", "b"]);
        assert_eq!(lines_of(&[b"\r\n\r\nx"]), ["", "", "x"]);
        assert_eq!(lines_of(&[b""]), Vec::<String>::new());
    }

    #[test]
    fn a_character_split_over_two_reads_is_decoded_whole() {
        let bytes = "caf\u{e9} \u{1f600}\n".as_bytes();
        let (head, tail) = bytes.split_at(4);
        assert_eq!(lines_of(&[head, tail]), ["caf\u{e9} \u{1f600}"]);
    }

    #[test]
    fn a_session_pump_hands_over_each_line_then_the_end() {
        let (sender, inbox) = channel().expect("channel");
        pump(true, &b"{\"a\":1}\r\n\r\n{\"b\":2}"[..], &sender);
        assert_eq!(inbox.recv(), Some(Input::Line("{\"a\":1}".to_owned())));
        assert_eq!(inbox.recv(), Some(Input::Line(String::new())));
        assert_eq!(inbox.recv(), Some(Input::Line("{\"b\":2}".to_owned())));
        assert_eq!(inbox.recv(), Some(Input::End));
    }

    #[test]
    fn a_one_shot_pump_hands_over_the_whole_text_decoded_as_utf8() {
        let (sender, inbox) = channel().expect("channel");
        pump(false, &"{\"t\":\"\u{e9}\"}\n".as_bytes()[..], &sender);
        assert_eq!(inbox.recv(), Some(Input::Text("{\"t\":\"\u{e9}\"}\n".to_owned())));
        assert_eq!(inbox.recv(), Some(Input::End));
    }

    #[test]
    fn a_closed_hand_over_ends_the_wait() {
        let (sender, inbox) = channel().expect("channel");
        drop(sender);
        assert_eq!(inbox.recv(), None);
    }
}
