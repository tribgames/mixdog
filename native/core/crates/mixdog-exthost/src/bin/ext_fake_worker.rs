//! A worker with scripted methods, for the pool's tests (`required-features = ["test-support"]`). It speaks the frame
//! protocol of `mixdog_exthost::frame` from the worker's side: one call at a time, chunks under the byte window the
//! core re-grants, a cancel that only methods which look at it see. Like the process it stands in for, it handles
//! frames on one thread, so a method that blocks (`spin`) hears nothing until it returns.
//!
//! Arguments: `overrun` ignores the core's chunk window; `g8` adds the methods of the throughput driver
//! (`tests/it/g8.rs`): `test.fill`, `test.stamp`, `test.spin` and stand-ins for `office.run` and `pdf.render`.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a test fake: it writes pid files, blocks its own thread and starts its helper process"
)]

use std::io::Read;
use std::io::Write;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_exthost::frame::CALL_WINDOW_BYTES;
use mixdog_exthost::frame::HEADER_BYTES;
use mixdog_exthost::frame::MAX_FRAME_BYTES;
use serde_json::Value;
use serde_json::json;

mod kind {
    pub const CALL: u8 = 1;
    pub const CANCEL: u8 = 2;
    pub const CREDIT: u8 = 3;
    pub const BROWSER: u8 = 4;
    pub const BYE: u8 = 5;
    pub const READY: u8 = 16;
    pub const CHUNK: u8 = 17;
    pub const RESULT: u8 = 18;
    pub const NEED_BROWSER: u8 = 19;
}

/// The most chunk bytes one frame carries (`MAX_CHUNK_BYTES` of the worker side of the protocol).
const MAX_CHUNK_BYTES: u64 = 64 * 1024;

/// The argument that starts a helper process instead of a worker.
const HELPER: &str = "helper";

struct Frame {
    kind: u8,
    id: u32,
    body: Vec<u8>,
}

struct Failure {
    code: String,
    message: String,
}

fn coded(code: &str, message: impl Into<String>) -> Failure {
    Failure { code: code.to_owned(), message: message.into() }
}

fn cancelled() -> Failure {
    coded("cancelled", "call cancelled")
}

struct Outcome {
    value: Value,
    pin: bool,
}

fn answer(value: Value) -> Result<Outcome, Failure> {
    Ok(Outcome { value, pin: false })
}

struct Request {
    method: String,
    params: Value,
    paths: Vec<Value>,
}

struct Worker {
    frames: mpsc::Receiver<Frame>,
    window: u64,
    g8: bool,
    /// The call being served: its id, the credit left for its chunks, whether the core cancelled it, and the browser
    /// answer once it came.
    id: u32,
    credit: u64,
    aborted: bool,
    browser: Option<Value>,
}

fn fail_protocol(error: &str) -> ! {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "ext-host protocol error: {error}");
    std::process::exit(2);
}

/// Reads frames off stdin on its own thread so a method that blocks does not stop them being received; they are handled
/// only where the worker looks for them.
fn read_frames() -> mpsc::Receiver<Frame> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut len = [0u8; 4];
            if input.read_exact(&mut len).is_err() {
                return;
            }
            let len = u32::from_be_bytes(len) as usize;
            if len < HEADER_BYTES - 4 {
                fail_protocol("frame shorter than its header");
            }
            if len > MAX_FRAME_BYTES {
                fail_protocol(&format!("frame of {len} bytes exceeds the limit"));
            }
            let mut rest = vec![0u8; len];
            if input.read_exact(&mut rest).is_err() {
                return;
            }
            let id = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]);
            let kind = rest[0];
            let body = rest.split_off(5);
            if tx.send(Frame { kind, id, body }).is_err() {
                return;
            }
        }
    });
    rx
}

fn send(kind: u8, id: u32, body: &[u8]) {
    let mut out = Vec::with_capacity(HEADER_BYTES + body.len());
    out.extend_from_slice(&((5 + body.len()) as u32).to_be_bytes());
    out.push(kind);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(body);
    let mut stdout = std::io::stdout().lock();
    if stdout.write_all(&out).and_then(|()| stdout.flush()).is_err() {
        // The core is gone.
        std::process::exit(0);
    }
}

impl Worker {
    /// Takes the next frame the core sent, waiting until `until` (for ever when `None`). The end of stdin is the end of
    /// the worker.
    fn step(&mut self, until: Option<Instant>) {
        let received = match until {
            None => self.frames.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            Some(until) => self.frames.recv_timeout(until.saturating_duration_since(Instant::now())),
        };
        match received {
            Ok(frame) => self.apply(&frame),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::process::exit(0),
        }
    }

    fn apply(&mut self, frame: &Frame) {
        match frame.kind {
            kind::CALL => fail_protocol("a call arrived while another is running"),
            kind::CANCEL => {
                if frame.id == self.id {
                    self.aborted = true;
                }
            }
            kind::CREDIT => {
                if frame.id == self.id
                    && let Ok(bytes) = <[u8; 4]>::try_from(frame.body.as_slice())
                {
                    self.credit += u64::from(u32::from_be_bytes(bytes));
                }
            }
            kind::BROWSER => {
                if frame.id == self.id
                    && let Ok(reply) = serde_json::from_slice(&frame.body)
                {
                    self.browser = Some(reply);
                }
            }
            kind::BYE => std::process::exit(0),
            other => fail_protocol(&format!("unknown frame kind {other}")),
        }
    }

    /// Holds until the core cancels the call.
    fn until_cancelled(&mut self) {
        while !self.aborted {
            self.step(None);
        }
    }

    /// Waits `ms` milliseconds, hearing the core meanwhile; a cancel does not end it.
    fn wait(&mut self, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < deadline {
            self.step(Some(deadline));
        }
    }

    /// Sends `remaining` bytes of `fill` as chunks, waiting for credit while the call's window is exhausted.
    fn emit(&mut self, mut remaining: u64, fill: u8) -> Result<(), Failure> {
        while remaining > 0 {
            while self.credit == 0 {
                if self.aborted {
                    return Err(cancelled());
                }
                self.step(None);
            }
            let size = remaining.min(self.credit).min(MAX_CHUNK_BYTES);
            self.credit -= size;
            send(kind::CHUNK, self.id, &vec![fill; size as usize]);
            remaining -= size;
        }
        Ok(())
    }

    /// Asks the core for the shared render browser's DevTools endpoint.
    fn request_browser(&mut self) -> Result<Value, Failure> {
        send(kind::NEED_BROWSER, self.id, &[]);
        while self.browser.is_none() {
            if self.aborted {
                return Err(cancelled());
            }
            self.step(None);
        }
        let reply = self.browser.take().unwrap_or(Value::Null);
        match reply.get("error") {
            Some(Value::Null) | None => Ok(reply.get("ws").cloned().unwrap_or(Value::Null)),
            Some(error) => {
                Err(coded("browser_unavailable", error.as_str().map_or_else(|| error.to_string(), str::to_owned)))
            }
        }
    }

    fn serve(&mut self, id: u32, body: &[u8]) {
        self.id = id;
        self.credit = self.window;
        self.aborted = false;
        self.browser = None;
        let result = match serde_json::from_slice::<Value>(body) {
            Ok(request) => self.run(&Request {
                method: request["method"].as_str().unwrap_or_default().to_owned(),
                params: request["params"].clone(),
                paths: request["paths"].as_array().cloned().unwrap_or_default(),
            }),
            Err(error) => Err(coded("failed", error.to_string())),
        };
        let pin = result.as_ref().is_ok_and(|outcome| outcome.pin);
        let mut frame = match result {
            Ok(outcome) => json!({"ok": outcome.value, "pin": outcome.pin}),
            Err(failure) => json!({"err": {"code": failure.code, "message": failure.message}, "pin": pin}),
        };
        if self.aborted {
            frame = json!({"err": {"code": "cancelled", "message": "call cancelled"}, "pin": pin});
        }
        send(kind::RESULT, id, frame.to_string().as_bytes());
    }

    fn run(&mut self, request: &Request) -> Result<Outcome, Failure> {
        let params = &request.params;
        match request.method.as_str() {
            "echo" => answer(params.clone()),
            // The environment variable the core sets for an Electron-in-node-mode worker.
            "electronMode" => answer(std::env::var("ELECTRON_RUN_AS_NODE").map_or(Value::Null, Value::String)),
            "whoami" => Ok(Outcome { value: json!(std::process::id()), pin: params["pin"] == json!(true) }),
            "sleep" => {
                self.wait(params["ms"].as_u64().unwrap_or(0));
                answer(json!(std::process::id()))
            }
            // Holds the slot until the core cancels.
            "hold" => {
                self.until_cancelled();
                answer(json!("released"))
            }
            "chunks" => {
                let bytes = params["bytes"].as_u64().unwrap_or(0);
                self.emit(bytes, params["fill"].as_u64().map_or(7, |fill| fill as u8))?;
                answer(json!({"sent": bytes}))
            }
            // Blocked in the thread that handles frames: the cancel is never seen.
            "spin" => block_for_ever(),
            // The same, recording its pid in `params.pidFile` first (a parser that never looks at the cancel).
            "spinWithPid" => {
                write_pid(params, std::process::id())?;
                block_for_ever()
            }
            "crash" => std::process::exit(3),
            // Starts a helper that outlives this worker unless the core ends the whole group, records its pid in
            // `params.pidFile`, then crashes.
            "crashWithHelper" => {
                start_helper(params)?;
                std::process::exit(3)
            }
            // Busy until the core ends it, with a helper that would outlive it.
            "holdWithHelper" => {
                start_helper(params)?;
                self.until_cancelled();
                answer(json!("released"))
            }
            // Answers normally, then exits 0 with the helper still running.
            "exitWithHelper" => {
                start_helper(params)?;
                send(kind::RESULT, self.id, json!({"ok": "answered", "pin": false}).to_string().as_bytes());
                self.wait(100);
                std::process::exit(0)
            }
            "browser" => self.request_browser().map(|ws| Outcome { value: ws, pin: false }),
            "approved" => answer(Value::Array(request.paths.clone())),
            method if self.g8 => self.run_g8(method, params),
            method => Err(coded("unknown_method", format!("unknown ext-host method {method}"))),
        }
    }

    fn run_g8(&mut self, method: &str, params: &Value) -> Result<Outcome, Failure> {
        match method {
            // Exhausts the call's whole window, writes `params.marker` once those bytes are on the pipe, then asks for
            // one more byte: it blocks there until the consumer takes chunks.
            "test.fill" => {
                self.emit(CALL_WINDOW_BYTES, 7)?;
                if let Some(marker) = params["marker"].as_str()
                    && let Err(error) = std::fs::write(marker, "")
                {
                    return Err(coded("failed", format!("{marker}: {error}")));
                }
                self.emit(1, 7)?;
                answer(Value::Null)
            }
            // When the worker produced its result (wall clock, fractional ms), for the core to measure how long the
            // result took to arrive.
            "test.stamp" => {
                let since_epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                answer(json!({"wroteAtMs": since_epoch.as_secs_f64() * 1000.0}))
            }
            // Holds the slot with a call the cancel cannot interrupt.
            "test.spin" => {
                let end = Instant::now() + Duration::from_millis(params["ms"].as_u64().unwrap_or(0));
                loop {
                    let left = end.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    std::thread::park_timeout(left);
                }
                answer(json!(std::process::id()))
            }
            "office.run" => self.office(&params["args"]),
            "pdf.render" => {
                self.emit(MAX_CHUNK_BYTES, 1)?;
                answer(json!({"pages": 1}))
            }
            other => Err(coded("unknown_method", format!("unknown ext-host method {other}"))),
        }
    }

    /// An office action answered with the envelope the real method sends: `create` names a session, `author` lays out
    /// HTML in the shared render browser (so asks for it), everything else is acknowledged.
    fn office(&mut self, args: &Value) -> Result<Outcome, Failure> {
        let text = match args["action"].as_str().unwrap_or_default() {
            "create" => json!({"session": format!("{}-session", args["format"].as_str().unwrap_or("doc"))}),
            "author" => {
                self.request_browser()?;
                json!({"ok": true})
            }
            _ => json!({"ok": true}),
        };
        answer(json!({"result": {"content": [{"type": "text", "text": text.to_string()}]}}))
    }
}

fn write_pid(params: &Value, pid: u32) -> Result<(), Failure> {
    let path = params["pidFile"].as_str().ok_or_else(|| coded("failed", "pidFile is required"))?;
    std::fs::write(path, pid.to_string()).map_err(|error| coded("failed", format!("{path}: {error}")))
}

/// Starts a process that idles until it is ended and records its pid in `params.pidFile`.
fn start_helper(params: &Value) -> Result<(), Failure> {
    let exe = std::env::current_exe().map_err(|error| coded("failed", error.to_string()))?;
    let helper = std::process::Command::new(exe)
        .arg(HELPER)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| coded("failed", error.to_string()))?;
    write_pid(params, helper.id())
}

/// Synchronous code the core's cancel cannot interrupt: nothing reads the frames again.
fn block_for_ever() -> ! {
    loop {
        std::thread::park();
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == HELPER {
        block_for_ever();
    }
    let mut worker = Worker {
        frames: read_frames(),
        window: if mode == "overrun" { 1 << 30 } else { CALL_WINDOW_BYTES },
        g8: mode == "g8",
        id: 0,
        credit: 0,
        aborted: false,
        browser: None,
    };
    send(kind::READY, 0, &[]);
    loop {
        // Between calls the worker waits for the next frame.
        let Ok(frame) = worker.frames.recv() else { std::process::exit(0) };
        match frame.kind {
            kind::CALL => worker.serve(frame.id, &frame.body),
            // A late cancel, credit or browser answer of a call that is over.
            kind::CANCEL | kind::CREDIT | kind::BROWSER => {}
            kind::BYE => std::process::exit(0),
            other => fail_protocol(&format!("unknown frame kind {other}")),
        }
    }
}
