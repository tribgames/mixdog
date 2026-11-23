use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use mixdog_term::testing::VtGrid;
use portable_pty::{Child, MasterPty, PtySize, native_pty_system};

use super::daemon::Workspace;

pub struct Shared {
    pub grid: VtGrid,
    pub raw: Vec<u8>,
    pub eof: bool,
    pub first_output: Option<Instant>,
}

type Cell = Arc<(Mutex<Shared>, Condvar)>;
type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The text of `grid`, empty rows left out, with row numbers.
pub fn dump_text(grid: &VtGrid) -> String {
    grid.dump().iter().enumerate().filter(|(_, row)| !row.is_empty()).map(|(y, row)| format!("{y:>3}| {row}")).collect::<Vec<_>>().join("\n")
}

pub struct TuiSession {
    child: Box<dyn Child + Send + Sync>,
    writer: Writer,
    master: Box<dyn MasterPty + Send>,
    shared: Cell,
    pub started: Instant,
}

impl TuiSession {
    /// Starts the terminal UI of `workspace` on a pseudo-terminal of `columns` x `rows`.
    pub fn spawn(workspace: &Workspace, columns: u16, rows: u16) -> Self {
        let pair = native_pty_system().openpty(PtySize { rows, cols: columns, pixel_width: 0, pixel_height: 0 }).expect("a pseudo-terminal");
        let started = Instant::now();
        let child = pair.slave.spawn_command(workspace.child_command()).expect("the terminal UI child starts");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("the master's reader");
        let writer: Writer = Arc::new(Mutex::new(pair.master.take_writer().expect("the master's writer")));
        let shared: Cell = Arc::new((Mutex::new(Shared { grid: VtGrid::new(columns, rows), raw: Vec::new(), eof: false, first_output: None }), Condvar::new()));
        let (cell, answers) = (Arc::clone(&shared), Arc::clone(&writer));
        thread::Builder::new()
            .name("pty-reader".to_owned())
            .spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    let read = match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => read,
                    };
                    let chunk = &buffer[..read];
                    // ConPTY asks for the cursor position at start-up and waits for the answer a terminal gives.
                    if cfg!(windows) && chunk.windows(4).any(|window| window == b"\x1b[6n") {
                        let mut writer = held(&answers);
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    let (lock, wake) = &*cell;
                    let mut state = held(lock);
                    state.first_output.get_or_insert_with(Instant::now);
                    state.grid.feed(chunk);
                    state.raw.extend_from_slice(chunk);
                    wake.notify_all();
                }
                let (lock, wake) = &*cell;
                held(lock).eof = true;
                wake.notify_all();
            })
            .expect("the reader thread");
        Self { child, writer, master: pair.master, shared, started }
    }

    /// Writes `text` to the terminal as the user's keystrokes.
    pub fn send(&self, text: &str) {
        let mut writer = held(&self.writer);
        writer.write_all(text.as_bytes()).expect("the child is reading");
        writer.flush().expect("the child is reading");
    }

    /// Resizes the terminal (the child is told).
    pub fn resize(&self, columns: u16, rows: u16) {
        self.master.resize(PtySize { rows, cols: columns, pixel_width: 0, pixel_height: 0 }).expect("a resize");
        held(&self.shared.0).grid.resize(columns, rows);
    }

    /// Waits until `predicate` holds for the screen; the time from now to the chunk that made it hold, or `None` at the limit.
    pub fn try_wait_until(&self, limit: Duration, predicate: impl Fn(&VtGrid) -> bool) -> Option<Duration> {
        let begin = Instant::now();
        let deadline = begin + limit;
        let (lock, wake) = &*self.shared;
        let mut state = held(lock);
        loop {
            if predicate(&state.grid) {
                return Some(begin.elapsed());
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            if left.is_zero() {
                return None;
            }
            state = wake.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
        }
    }

    /// [`Self::try_wait_until`] that fails the test with the screen when the limit passes.
    pub fn wait_until(&self, what: &str, limit: Duration, predicate: impl Fn(&VtGrid) -> bool) -> Duration {
        match self.try_wait_until(limit, predicate) {
            Some(took) => took,
            None => panic!("timed out after {limit:?} waiting for {what}\n--- screen ---\n{}", self.screen_text()),
        }
    }

    /// Runs `read` on the screen as it is now.
    pub fn with_grid<T>(&self, read: impl FnOnce(&VtGrid) -> T) -> T {
        read(&held(&self.shared.0).grid)
    }

    /// The text of the screen, empty rows left out, with row numbers.
    pub fn screen_text(&self) -> String {
        self.with_grid(dump_text)
    }

    /// Every byte the child has written so far.
    pub fn raw(&self) -> Vec<u8> {
        held(&self.shared.0).raw.clone()
    }

    /// How many bytes the child has written so far.
    pub fn raw_len(&self) -> usize {
        held(&self.shared.0).raw.len()
    }

    /// The bytes written after the first `mark` bytes.
    pub fn raw_since(&self, mark: usize) -> Vec<u8> {
        held(&self.shared.0).raw.get(mark..).unwrap_or_default().to_vec()
    }

    /// Waits until `read` finds what it looks for in the bytes written after the first `mark` (read again as each chunk
    /// arrives, so a sequence split across chunks is found whole); what it found, or `None` at the limit.
    pub fn try_wait_raw<T>(&self, mark: usize, limit: Duration, read: impl Fn(&[u8]) -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + limit;
        let (lock, wake) = &*self.shared;
        let mut state = held(lock);
        loop {
            if let Some(found) = read(state.raw.get(mark..).unwrap_or_default()) {
                return Some(found);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            state = wake.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
        }
    }

    /// When the child wrote its first byte.
    pub fn first_output(&self) -> Option<Instant> {
        held(&self.shared.0).first_output
    }

    /// Waits for the child to end; its exit code, or `None` at the limit.
    pub fn wait_exit(&mut self, limit: Duration) -> Option<u32> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().expect("the child's state") {
                return Some(status.exit_code());
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::park_timeout(Duration::from_millis(25));
        }
    }

    /// Waits until the child has written nothing for `quiet`.
    pub fn settle(&self, quiet: Duration, limit: Duration) {
        let deadline = Instant::now() + limit;
        let mut last = (self.raw_len(), Instant::now());
        while Instant::now() < deadline {
            thread::park_timeout(Duration::from_millis(25));
            let now = self.raw_len();
            if now != last.0 {
                last = (now, Instant::now());
            } else if last.1.elapsed() >= quiet {
                return;
            }
        }
    }
}

impl Drop for TuiSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
