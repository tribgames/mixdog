//! The two relay processes of a twin comparison: the Node relay through `tests/twin/node/relay-host.mjs` and the Rust
//! relay through the `relay_twin_host` binary, both given the same knob object as their only argument, both on port 0,
//! both closing when their stdin ends. The listening line gives the port.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "the twin test runs the Node relay and the Rust relay host as separate programs, the reference peers of the comparison"
)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mixdog_fsio::Unlaned;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    Node,
    Rust,
}

impl Runtime {
    pub fn name(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Rust => "rust",
        }
    }

    pub fn other(self) -> Self {
        match self {
            Self::Node => Self::Rust,
            Self::Rust => Self::Node,
        }
    }
}

/// What a relay process wrote: the operator lines of each stream, in order per stream, and the `[twin]` lines of the
/// fakes (one JSON value each).
#[derive(Debug, Default, Clone)]
pub struct Lines {
    pub out: Vec<String>,
    pub err: Vec<String>,
    pub fakes: Vec<Value>,
    port: Option<u16>,
}

const START_LIMIT: Duration = Duration::from_secs(30);
const STOP_LIMIT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(20);
const NODE_FIX: &str = "node was not found on PATH: install Node.js 20 or newer";
const WS_FIX: &str = "if the packages ws and nodemailer do not resolve, run `npm ci --prefix apps/relay` in the tree";

pub struct Relay {
    pub runtime: Runtime,
    pub port: u16,
    pub scheme: &'static str,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Arc<Mutex<Lines>>,
    readers: Vec<JoinHandle<()>>,
}

fn node_host() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/twin/node/relay-host.mjs")
}

/// The port of the `[relay] <scheme> listening on :<port> (renderer: ...)` line.
fn listening_port(line: &str) -> Option<u16> {
    let rest = line.strip_prefix("[relay] ")?.split("listening on :").nth(1)?;
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

fn read_stream<R: std::io::Read + Send + 'static>(stream: R, is_out: bool, lines: Arc<Mutex<Lines>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            let Ok(mut shared) = lines.lock() else { break };
            if !is_out {
                shared.err.push(line);
            } else if let Some(json) = line.strip_prefix("[twin] ") {
                // The Node host names the package versions it resolved; the Rust host has none to name.
                match serde_json::from_str::<Value>(json) {
                    Ok(value) if value.get("versions").is_some() => {}
                    Ok(value) => shared.fakes.push(value),
                    Err(_) => shared.out.push(line),
                }
            } else {
                if let Some(port) = listening_port(&line) {
                    shared.port = Some(port);
                }
                shared.out.push(line);
            }
        }
    })
}

impl Relay {
    /// Starts the runtime's relay with the knob object and waits for its listening line.
    pub fn start(runtime: Runtime, knobs: &Value) -> Result<Self, String> {
        let argument = knobs.to_string();
        let mut command = match runtime {
            Runtime::Node => {
                let mut command = Command::new("node");
                command.arg(node_host());
                command
            }
            Runtime::Rust => Command::new(env!("CARGO_BIN_EXE_relay_twin_host")),
        };
        command.arg(argument).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| match (runtime, e.kind()) {
            (Runtime::Node, std::io::ErrorKind::NotFound) => NODE_FIX.to_owned(),
            _ => format!("{} relay did not start: {e}", runtime.name()),
        })?;
        let lines = Arc::new(Mutex::new(Lines::default()));
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(read_stream(stdout, true, lines.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(read_stream(stderr, false, lines.clone()));
        }
        let stdin = child.stdin.take();
        let mut relay = Self { runtime, port: 0, scheme: "http", child, stdin, lines, readers };
        let started = Instant::now();
        loop {
            let (port, line) = {
                let shared = relay.lines.lock().map_err(|_| "relay output lock poisoned".to_owned())?;
                (shared.port, shared.out.iter().find(|l| listening_port(l).is_some()).cloned())
            };
            if let (Some(port), Some(line)) = (port, line) {
                relay.port = port;
                relay.scheme = if line.starts_with("[relay] https ") { "https" } else { "http" };
                return Ok(relay);
            }
            if let Ok(Some(status)) = relay.child.try_wait() {
                let seen = relay.collect_after_exit();
                let hint = if runtime == Runtime::Node { WS_FIX } else { "" };
                return Err(format!(
                    "{} relay exited {status} before listening; stderr: {:?}. {hint}",
                    runtime.name(),
                    seen.err
                ));
            }
            if started.elapsed() > START_LIMIT {
                let _ = relay.child.kill();
                let seen = relay.collect_after_exit();
                return Err(format!(
                    "{} relay did not print its listening line in {START_LIMIT:?}; stdout {:?}, stderr {:?}",
                    runtime.name(),
                    seen.out,
                    seen.err
                ));
            }
            mixdog_fsio::sleep(&Unlaned, POLL);
        }
    }

    fn collect_after_exit(&mut self) -> Lines {
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        self.lines.lock().map(|shared| shared.clone()).unwrap_or_default()
    }

    /// Ends the relay the way the host contract says (stdin closes, the relay closes and exits 0) and returns what it
    /// wrote. A relay that does not exit in time is killed and the stop fails.
    pub fn stop(mut self) -> Result<Lines, String> {
        drop(self.stdin.take());
        let started = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if started.elapsed() > STOP_LIMIT {
                let _ = self.child.kill();
                let _ = self.collect_after_exit();
                return Err(format!(
                    "{} relay did not exit within {STOP_LIMIT:?} of its stdin closing",
                    self.runtime.name()
                ));
            }
            mixdog_fsio::sleep(&Unlaned, POLL);
        };
        let lines = self.collect_after_exit();
        if status.success() {
            Ok(lines)
        } else {
            Err(format!("{} relay exited {status}; stderr {:?}", self.runtime.name(), lines.err))
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        // A failed step leaves the relay running: it must not outlive the test.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listening_line_gives_the_port() {
        assert_eq!(listening_port("[relay] http listening on :43211 (renderer: none)"), Some(43211));
        assert_eq!(listening_port("[relay] https listening on :9 (renderer: C:\\x)"), Some(9));
        assert_eq!(listening_port("[relay] failed to start: x"), None);
        assert_eq!(listening_port("listening on :5"), None);
    }
}
