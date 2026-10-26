//! Named-pipe transport. The helper creates the app-facing pipe (secured by
//! [`crate::security::pipe_sddl`] and the per-install secret) as an overlapped
//! [`ServerPipe`] whose operations can never block the helper on its peer; the
//! app — and the bundled `probe` CLI, through the blocking [`PipeIo`] — connect
//! as a client. The pipe carries the byte stream that [`crate::protocol`]
//! frames; this module only moves bytes and enforces the local,
//! single-instance, no-remote constraints.
//!
//! No sockets are opened anywhere in this crate. A named pipe is local IPC with
//! no network listener, and `PIPE_REJECT_REMOTE_CLIENTS` refuses a client that
//! arrives over a remote mount of the pipe namespace.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeClientSessionId, GetNamedPipeServerProcessId, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForMultipleObjects, INFINITE};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use crate::security::is_system_sid;
use crate::winutil::{process_user_sid, wide, OwnedHandle, SecurityDescriptor};

/// Inbound (app -> helper) buffer: the helper drains it every loop pass in one
/// read of this size.
const IN_BUFFER: u32 = 1 << 16;

/// Outbound (helper -> app) buffer, kept **small on purpose: 4 KiB.** A write
/// completes once its bytes are in this buffer — not when the client has read
/// them — so this size is what turns a client that stops reading into a write
/// that cannot complete. Every video frame is far larger than 4 KiB, and control
/// frames are a few hundred bytes, so a non-reading client fills it within one
/// frame and the next write stalls until the frame deadline trips; a reading
/// client never notices (its reads drain it continuously). Windows treats pipe
/// buffer sizes as advisory (it may round up to an allocation boundary), which
/// still leaves it small next to any frame.
const OUT_BUFFER: u32 = 4 << 10;
const ERROR_PIPE_CONNECTED: u32 = 0x8007_0217;
const ERROR_BROKEN_PIPE: u32 = 0x8007_006D;
const ERROR_NO_DATA: u32 = 0x8007_00E8;
const ERROR_IO_INCOMPLETE: u32 = 0x8007_03E4;
const ERROR_IO_PENDING: u32 = 0x8007_03E5;

fn to_io(error: windows::core::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.to_string())
}

fn is_win32(error: &windows::core::Error, expected: u32) -> bool {
    error.code().0 as u32 == expected
}

/// A non-owning, blocking Read/Write adapter over a *client* pipe HANDLE (the
/// `probe` CLI). The helper's server end never uses it: it uses [`ServerPipe`],
/// whose writes are overlapped and deadline-bounded.
#[derive(Clone, Copy)]
pub struct PipeIo(pub HANDLE);

impl Read for PipeIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut read = 0u32;
        match unsafe { ReadFile(self.0, Some(buf), Some(&mut read), None) } {
            Ok(()) => Ok(read as usize),
            // A peer that closed the pipe reads as end-of-stream, not an error.
            Err(error) if is_win32(&error, ERROR_BROKEN_PIPE) || is_win32(&error, ERROR_NO_DATA) => {
                Ok(0)
            }
            Err(error) => Err(to_io(error)),
        }
    }
}

impl Write for PipeIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut written = 0u32;
        unsafe { WriteFile(self.0, Some(buf), Some(&mut written), None) }.map_err(to_io)?;
        Ok(written as usize)
    }

    /// No `FlushFileBuffers`: on a pipe it blocks until the *peer* has read
    /// everything, so one stalled reader would stall the writer per frame. A
    /// completed `WriteFile` has already handed the bytes to the pipe.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// How [`ServerPipe::accept`] returned.
pub enum Accept {
    Connected,
    /// The stop event was signalled while waiting; no client is attached.
    Stopped,
}

/// Why outbound I/O ended the connection.
#[derive(Debug)]
pub enum SendError {
    /// The peer closed the pipe, or the write failed.
    Closed(String),
    /// Backpressure: a queued frame's write could not complete within the frame
    /// deadline of being queued. Completion means the bytes reached the small
    /// outbound pipe buffer (`OUT_BUFFER`), not that the client read them; a
    /// client that stops reading leaves that buffer full, so writes stop
    /// completing and this fires.
    TimedOut,
}

/// A queued outbound frame and when it was queued (its total deadline starts
/// then, not when its write is issued).
struct Outgoing {
    frame: Vec<u8>,
    queued: Instant,
}

/// The single overlapped write in progress. The `OVERLAPPED` is boxed and the
/// frame owned here so both stay at a fixed address until the I/O completes or
/// is cancelled and reaped — see [`ServerPipe::cancel_write`].
struct InFlight {
    overlapped: Box<OVERLAPPED>,
    frame: Vec<u8>,
    written: usize,
    queued: Instant,
}

/// The helper's app-facing pipe server, opened for overlapped I/O so that **no
/// pipe operation can block the helper's loop on its peer**:
///
/// - `accept` waits on the connect *and* the shutdown stop event;
/// - reads take only bytes already buffered (`PeekNamedPipe` first);
/// - writes are queued and issued as overlapped `WriteFile`s that the loop
///   polls with [`pump`](Self::pump). A frame whose write cannot complete
///   within `frame_deadline` of being queued fails the connection
///   ([`SendError::TimedOut`]) — a bound on backpressure through the small
///   outbound buffer, not an acknowledgement that the client read it (the
///   protocol has no frame acks). There is no `FlushFileBuffers`, which would
///   block until the peer read everything.
///
/// So a client that stops reading costs at most one frame deadline, during
/// which the helper keeps reading control/input, enforcing its other
/// deadlines, following the desktop, releasing held input, and answering a
/// stop request.
pub struct ServerPipe {
    pipe: OwnedHandle,
    /// Manual-reset event for connect and reads (never concurrent with each other).
    io_event: OwnedHandle,
    /// Manual-reset event for the one in-flight write.
    write_event: OwnedHandle,
    outbox: VecDeque<Outgoing>,
    in_flight: Option<InFlight>,
    frame_deadline: Duration,
}

fn manual_reset_event() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(to_io)?;
    OwnedHandle::new(handle).ok_or_else(io::Error::last_os_error)
}

impl ServerPipe {
    /// Create the app-facing pipe server with the given SDDL-derived DACL. When
    /// `first_instance` is set, `FILE_FLAG_FIRST_PIPE_INSTANCE` refuses to
    /// create the pipe if another process already owns the name — a squatter
    /// cannot pre-create it and sit in the middle.
    pub fn create(name: &str, sddl: &str, first_instance: bool, frame_deadline: Duration) -> io::Result<Self> {
        let descriptor = SecurityDescriptor::from_sddl(sddl).map_err(to_io)?;
        let attributes = descriptor.attributes();
        let wname = wide(name);
        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first_instance {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wname.as_ptr()),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, // single instance: no second server can shadow it
                OUT_BUFFER, // nOutBufferSize: the server's writes
                IN_BUFFER,  // nInBufferSize: the server's reads
                0,
                Some(&attributes),
            )
        };
        Ok(ServerPipe {
            pipe: OwnedHandle::new(handle).ok_or_else(io::Error::last_os_error)?,
            io_event: manual_reset_event()?,
            write_event: manual_reset_event()?,
            outbox: VecDeque::new(),
            in_flight: None,
            frame_deadline,
        })
    }

    /// The pipe handle, for the per-connection identity checks.
    pub fn handle(&self) -> &OwnedHandle {
        &self.pipe
    }

    /// Wait for a client, or for `stop` to be signalled. A client that connected
    /// between creation and this call reports `ERROR_PIPE_CONNECTED` (success).
    pub fn accept(&mut self, stop: HANDLE) -> io::Result<Accept> {
        let mut overlapped = OVERLAPPED { hEvent: self.io_event.get(), ..Default::default() };
        match unsafe { ConnectNamedPipe(self.pipe.get(), Some(&mut overlapped)) } {
            Ok(()) => return Ok(Accept::Connected),
            Err(error) if is_win32(&error, ERROR_PIPE_CONNECTED) => return Ok(Accept::Connected),
            Err(error) if is_win32(&error, ERROR_IO_PENDING) => {}
            Err(error) => return Err(to_io(error)),
        }
        let handles = [self.io_event.get(), stop];
        let woke = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        let mut transferred = 0u32;
        if woke == WAIT_OBJECT_0 {
            unsafe { GetOverlappedResult(self.pipe.get(), &overlapped, &mut transferred, false) }
                .map_err(to_io)?;
            return Ok(Accept::Connected);
        }
        // Stop (or a failed wait): cancel the pending connect and reap it before
        // `overlapped` goes out of scope.
        unsafe {
            let _ = CancelIoEx(self.pipe.get(), Some(&overlapped));
            let _ = GetOverlappedResult(self.pipe.get(), &overlapped, &mut transferred, true);
        }
        if woke.0 == WAIT_OBJECT_0.0 + 1 {
            Ok(Accept::Stopped)
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Drop the current client so the server instance can accept the next one.
    /// Any unsent output is discarded and an in-flight write is cancelled.
    pub fn disconnect(&mut self) {
        self.cancel_write();
        self.outbox.clear();
        unsafe {
            let _ = DisconnectNamedPipe(self.pipe.get());
        }
    }

    /// Cancel the in-flight write (if any) and wait for the cancellation to
    /// complete, so the kernel no longer references its buffer or `OVERLAPPED`.
    /// Cancellation of a pipe write completes immediately; this wait is not on
    /// the peer.
    fn cancel_write(&mut self) {
        if let Some(in_flight) = self.in_flight.take() {
            let mut transferred = 0u32;
            unsafe {
                let _ = CancelIoEx(self.pipe.get(), Some(&*in_flight.overlapped));
                let _ = GetOverlappedResult(self.pipe.get(), &*in_flight.overlapped, &mut transferred, true);
            }
        }
    }

    /// Whether the client end is still open.
    pub fn peer_connected(&self) -> bool {
        let mut available = 0u32;
        unsafe { PeekNamedPipe(self.pipe.get(), None, 0, None, Some(&mut available), None) }.is_ok()
    }

    /// Read whatever bytes are currently buffered on the pipe, without blocking.
    /// `Some(0)` means nothing is waiting, `Some(n)` returns `n` bytes, and
    /// `None` means the peer is gone. Because it only ever reads bytes
    /// `PeekNamedPipe` reports as available, the overlapped read completes from
    /// the pipe buffer — a length prefix that arrives without its body leaves
    /// the helper free to keep capturing and monitoring the desktop.
    pub fn read_available(&mut self, buf: &mut [u8]) -> Option<usize> {
        let mut available = 0u32;
        if unsafe { PeekNamedPipe(self.pipe.get(), None, 0, None, Some(&mut available), None) }.is_err() {
            return None;
        }
        if available == 0 {
            return Some(0);
        }
        let want = (available as usize).min(buf.len());
        let mut overlapped = OVERLAPPED { hEvent: self.io_event.get(), ..Default::default() };
        match unsafe { ReadFile(self.pipe.get(), Some(&mut buf[..want]), None, Some(&mut overlapped)) } {
            Ok(()) => {}
            Err(error) if is_win32(&error, ERROR_IO_PENDING) => {}
            Err(_) => return None,
        }
        let mut read = 0u32;
        // The bytes are already buffered, so this completes without the peer.
        unsafe { GetOverlappedResult(self.pipe.get(), &overlapped, &mut read, true) }.ok()?;
        Some(read as usize)
    }

    /// Queue a complete frame for sending. Never blocks; call
    /// [`pump`](Self::pump) to make progress and observe failures.
    pub fn queue(&mut self, frame: Vec<u8>) {
        self.outbox.push_back(Outgoing { frame, queued: Instant::now() });
    }

    /// True when nothing is queued or in flight. The helper captures a new
    /// video frame only then, so a slow reader gets fewer frames (frames are
    /// skipped, never buffered without bound) rather than a growing backlog.
    pub fn is_idle(&self) -> bool {
        self.in_flight.is_none() && self.outbox.is_empty()
    }

    /// Advance outbound I/O without blocking: reap a completed write, start the
    /// next queued frame, and fail the connection if the frame at the head of
    /// the queue has outlived its total deadline.
    pub fn pump(&mut self) -> Result<(), SendError> {
        loop {
            if let Some(in_flight) = self.in_flight.as_mut() {
                let mut transferred = 0u32;
                match unsafe {
                    GetOverlappedResult(self.pipe.get(), &*in_flight.overlapped, &mut transferred, false)
                } {
                    Ok(()) => {
                        in_flight.written += transferred as usize;
                        let done = in_flight.written >= in_flight.frame.len();
                        let finished = self.in_flight.take().expect("in flight");
                        if !done {
                            // A short write: issue the remainder under the same
                            // deadline (still measured from when it was queued).
                            self.start_write(finished.frame, finished.written, finished.queued)?;
                        }
                        continue;
                    }
                    Err(error) if is_win32(&error, ERROR_IO_INCOMPLETE) => {
                        if in_flight.queued.elapsed() > self.frame_deadline {
                            return Err(SendError::TimedOut);
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        self.in_flight = None; // the I/O has completed (failed); nothing to reap
                        return Err(SendError::Closed(error.to_string()));
                    }
                }
            }
            let Some(next) = self.outbox.pop_front() else {
                return Ok(());
            };
            if next.queued.elapsed() > self.frame_deadline {
                return Err(SendError::TimedOut);
            }
            self.start_write(next.frame, 0, next.queued)?;
        }
    }

    /// Issue one overlapped `WriteFile` for `frame[written..]`. A synchronous
    /// completion still signals the event and is reaped by the next `pump`.
    fn start_write(&mut self, frame: Vec<u8>, written: usize, queued: Instant) -> Result<(), SendError> {
        let mut in_flight = InFlight {
            overlapped: Box::new(OVERLAPPED { hEvent: self.write_event.get(), ..Default::default() }),
            frame,
            written,
            queued,
        };
        let pointer: *mut OVERLAPPED = &mut *in_flight.overlapped;
        match unsafe { WriteFile(self.pipe.get(), Some(&in_flight.frame[written..]), None, Some(pointer)) } {
            Ok(()) => {}
            Err(error) if is_win32(&error, ERROR_IO_PENDING) => {}
            Err(error) => return Err(SendError::Closed(error.to_string())),
        }
        self.in_flight = Some(in_flight);
        Ok(())
    }
}

impl Drop for ServerPipe {
    fn drop(&mut self) {
        // The kernel must not outlive-reference an in-flight write's buffer.
        self.cancel_write();
    }
}

/// The helper's protocol writers (`protocol::write_all`, the handshake) write
/// one whole frame per call; on a [`ServerPipe`] that only queues it. Failures
/// surface from [`ServerPipe::pump`], which the helper's loop calls every
/// iteration.
impl Write for ServerPipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.queue(buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Process id of the connected client, used only for logging; authentication is
/// the DACL, the client's session and SID, and the secret — not the pid.
pub fn client_pid(server: &OwnedHandle) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(server.get(), &mut pid) }.ok()?;
    Some(pid)
}

/// Terminal-services session id of the connected client. The helper rejects a
/// client that is not in the console session it serves.
pub fn client_session_id(server: &OwnedHandle) -> Option<u32> {
    let mut session = 0u32;
    unsafe { GetNamedPipeClientSessionId(server.get(), &mut session) }.ok()?;
    Some(session)
}

/// Connect to the pipe server as a client and confirm the server process is
/// SYSTEM before returning. The caller sends the per-install secret as its
/// first message, so it must first be sure it is not talking to a same-name
/// squatter: `FILE_FLAG_FIRST_PIPE_INSTANCE` stops anyone from creating a
/// second instance once the SYSTEM helper owns the name, and this check refuses
/// a server that pre-created the name while the helper was not running. A pipe
/// whose server is not SYSTEM is closed without a byte being sent.
pub fn connect(name: &str) -> io::Result<OwnedHandle> {
    let wname = wide(name);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wname.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .map_err(to_io)?;
    let owned = OwnedHandle::new(handle).ok_or_else(io::Error::last_os_error)?;

    let mut pid = 0u32;
    unsafe { GetNamedPipeServerProcessId(owned.get(), &mut pid) }.map_err(to_io)?;
    match process_user_sid(pid) {
        Some(sid) if is_system_sid(&sid) => Ok(owned),
        other => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("pipe server is not SYSTEM (sid={other:?}); refusing to send the secret"),
        )),
    }
}
