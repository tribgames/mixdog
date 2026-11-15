//! A program run in a pseudo-terminal, its output replayed on the VT grid of `mixdog-term` (the screen a terminal would show).
#![allow(dead_code, reason = "each test uses the part it needs")]

use std::ffi::OsString;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
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
    /// Bytes received so far (a change of this number is a change of the screen).
    received: usize,
    last_output: Instant,
    ended: bool,
}

pub struct Pty {
    shared: Arc<Mutex<Shared>>,
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
        let shared = Arc::new(Mutex::new(Shared { grid: VtGrid::new(COLUMNS, ROWS), received: 0, last_output: Instant::now(), ended: false }));
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
                let mut shared = feed.lock().unwrap();
                shared.grid.feed(bytes);
                shared.received += read;
                shared.last_output = Instant::now();
            }
            feed.lock().unwrap().ended = true;
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
        self.shared.lock().unwrap().grid.dump().into_iter().map(|row| row.trim_end().to_owned()).collect()
    }

    /// Whether the screen shows `marker` anywhere.
    pub fn shows(&self, marker: &str) -> bool {
        self.screen().iter().any(|row| row.contains(marker))
    }

    /// Waits up to `limit` for the screen to show `marker`.
    pub fn wait_for(&self, marker: &str, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        while Instant::now() < end {
            if self.shows(marker) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.shows(marker)
    }

    /// Waits up to `limit` for the output to be quiet for `quiet` (a stable screen); `false` when it never was.
    pub fn wait_stable(&self, quiet: Duration, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        while Instant::now() < end {
            {
                let shared = self.shared.lock().unwrap();
                if shared.received > 0 && shared.last_output.elapsed() >= quiet {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
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

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        if let Some(reader) = self.reader.take() {
            drop(reader);
        }
    }
}
