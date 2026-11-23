//! A program run in a pseudo-terminal, its output replayed on the VT grid of `mixdog-term` (the screen a terminal would show).
#![allow(dead_code, reason = "each test uses the part it needs")]

use std::ffi::OsString;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use mixdog_term::testing::VtGrid;
use portable_pty::CommandBuilder;
use portable_pty::PtySize;
use portable_pty::native_pty_system;

pub const COLUMNS: u16 = 100;
pub const ROWS: u16 = 30;

/// The cursor-position query a Windows pseudo-console sends before it lets a program start; it is answered at once.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";

struct Shared {
    grid: VtGrid,
    ended: bool,
}

pub struct Pty {
    /// The screen, and the signal raised with every chunk that reaches it.
    shared: Arc<(Mutex<Shared>, Condvar)>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl Pty {
    /// Starts `program args` in `cwd` with exactly `env`, on a [`COLUMNS`] x [`ROWS`] terminal.
    pub fn spawn(program: &OsString, args: &[OsString], cwd: &Path, env: &[(OsString, OsString)]) -> Self {
        let pair = native_pty_system().openpty(PtySize { rows: ROWS, cols: COLUMNS, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd);
        command.env_clear();
        for (name, value) in env {
            command.env(name, value);
        }
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut source = pair.master.try_clone_reader().unwrap();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let shared = Arc::new((Mutex::new(Shared { grid: VtGrid::new(COLUMNS, ROWS), ended: false }), Condvar::new()));
        let (feed, reply) = (shared.clone(), writer.clone());
        let reader = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = source.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let bytes = &buffer[..read];
                if bytes.windows(CURSOR_QUERY.len()).any(|window| window == CURSOR_QUERY) {
                    let mut writer = reply.lock().unwrap();
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                let (screen, fed) = &*feed;
                screen.lock().unwrap().grid.feed(bytes);
                fed.notify_all();
            }
            let (screen, fed) = &*feed;
            screen.lock().unwrap().ended = true;
            fed.notify_all();
        });
        Self { shared, writer, child, _master: pair.master, reader: Some(reader) }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    /// Sends bytes as keystrokes.
    pub fn send(&self, bytes: &[u8]) {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes).unwrap();
        writer.flush().unwrap();
    }

    /// The rows of the screen, trailing blanks trimmed.
    pub fn screen(&self) -> Vec<String> {
        rows(&self.shared.0.lock().unwrap().grid)
    }

    /// Whether the screen shows `marker` anywhere.
    pub fn shows(&self, marker: &str) -> bool {
        self.screen().iter().any(|row| row.contains(marker))
    }

    /// Waits up to `limit` for `holds` to be true of the screen's rows, looked at again as each chunk of output reaches it.
    pub fn wait_until(&self, limit: Duration, holds: impl Fn(&[String]) -> bool) -> bool {
        let end = Instant::now() + limit;
        let (screen, fed) = &*self.shared;
        let mut shared = screen.lock().unwrap();
        loop {
            if holds(&rows(&shared.grid)) {
                return true;
            }
            let Some(left) = end.checked_duration_since(Instant::now()) else { return false };
            shared = fed.wait_timeout(shared, left).unwrap().0;
        }
    }

    /// Waits up to `limit` for the screen to show `marker`.
    pub fn wait_for(&self, marker: &str, limit: Duration) -> bool {
        self.wait_until(limit, |rows| rows.iter().any(|row| row.contains(marker)))
    }

    /// Waits up to `limit` for the program to end; its exit code.
    pub fn wait_exit(&mut self, limit: Duration) -> Option<u32> {
        let end = Instant::now() + limit;
        while Instant::now() < end {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status.exit_code());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    /// Ends the program if it still runs.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

fn rows(grid: &VtGrid) -> Vec<String> {
    grid.dump().into_iter().map(|row| row.trim_end().to_owned()).collect()
}

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        if let Some(reader) = self.reader.take() {
            drop(reader);
        }
    }
}
