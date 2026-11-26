//! The helper the supervisor's tests start: the real owner hold and serve loop over a scripted handler.
//!
//! Arguments: `--barrier <addr>`, the test's listener the scripted points wait at (each connects, names itself and its
//! pid, and waits for one byte); `--hold-ready`, wait there (`ready`) before serving; `--hold-drain`, wait there (`drain`)
//! before a drain is acknowledged; `--hold-forget`, wait there (`forget`) before a root removal answers; `--bad-ready`,
//! announce protocol 999 and serve nothing.
//!
//! A query's `args.do`: `echo` (the default) answers its pid and every write notice seen so far; `block` waits at the
//! barrier (`query`) first; `wait-change` waits for a notice of `release`; `crash` exits; `eof` closes its output and
//! hangs; `malformed` writes a frame that is not a message and hangs; `refuse`, `fail` and `panic` answer so; `big`
//! answers `args.bytes` bytes. `args.roots` is the answer's dependency roots (`null` for none), `args.complete` its
//! completeness.

use std::io;
use std::io::PipeWriter;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_graph_host::frame;
use mixdog_graph_host::wire::Answer;
use mixdog_graph_host::wire::Changed;
use mixdog_graph_host::wire::FailureKind;
use mixdog_graph_host::wire::FileIdentity;
use mixdog_graph_host::wire::ForgetRoot;
use mixdog_graph_host::wire::Forgot;
use mixdog_graph_host::wire::FromWorker;
use mixdog_graph_host::wire::Prewarm;
use mixdog_graph_host::wire::Query;
use mixdog_graph_host::wire::Ready;
use mixdog_graph_host::wire::Refusal;
use mixdog_graph_host::wire::Timings;
use mixdog_graph_host::wire::Warmed;
use mixdog_graph_host::wire::WorkerFailure;
use mixdog_graph_host::worker;
use mixdog_graph_host::worker::Handler;
use mixdog_graph_host::worker::Rejection;
use serde_json::Value;

type Sink = Arc<Mutex<Option<PipeWriter>>>;

/// The process's standard output as a pipe end of its own, so a script can close it.
#[cfg(unix)]
fn stdout_pipe() -> PipeWriter {
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    // SAFETY: descriptor 1 is open and nothing else in this process uses it.
    PipeWriter::from(unsafe { OwnedFd::from_raw_fd(1) })
}

#[cfg(windows)]
fn stdout_pipe() -> PipeWriter {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::io::OwnedHandle;
    // SAFETY: the standard output handle is open and nothing else in this process uses it.
    PipeWriter::from(unsafe { OwnedHandle::from_raw_handle(io::stdout().as_raw_handle()) })
}

struct Output(Sink);

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.0.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            Some(sink) => sink.write(buf),
            None => Err(io::ErrorKind::BrokenPipe.into()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.0.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            Some(sink) => sink.flush(),
            None => Err(io::ErrorKind::BrokenPipe.into()),
        }
    }
}

fn wait_at(barrier: Option<&str>, point: &str) {
    let mut stream = TcpStream::connect(barrier.expect("a scripted wait needs --barrier")).expect("the test's barrier");
    writeln!(stream, "{point} {}", std::process::id()).expect("the barrier takes the point's name");
    let mut released = [0u8; 1];
    let _ = stream.read(&mut released);
}

fn hang() -> ! {
    loop {
        std::thread::park();
    }
}

struct Fixture {
    sink: Sink,
    barrier: Option<String>,
    hold_drain: bool,
    hold_forget: bool,
    seen: Mutex<Vec<String>>,
    noticed: Condvar,
}

impl Fixture {
    fn echo(&self, query: &Query) -> Answer {
        let seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let text = serde_json::json!({ "pid": std::process::id(), "changes": seen }).to_string();
        let dependency_roots = match query.args.get("roots") {
            None => Some(vec![query.session_cwd.clone()]),
            Some(Value::Null) => None,
            Some(roots) => Some(roots.as_array().into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from).collect()),
        };
        let complete = query.args.get("complete").and_then(Value::as_bool).unwrap_or(true);
        Answer { text, dependency_roots, complete, timings: Timings::default() }
    }
}

impl Handler for Fixture {
    fn query(&self, query: Query) -> Result<Answer, Rejection> {
        match query.args.get("do").and_then(Value::as_str).unwrap_or("echo") {
            "block" => {
                wait_at(self.barrier.as_deref(), "query");
                Ok(self.echo(&query))
            }
            "wait-change" => {
                let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
                while !seen.iter().any(|change| change == "release") {
                    seen = self.noticed.wait(seen).unwrap_or_else(PoisonError::into_inner);
                }
                drop(seen);
                Ok(self.echo(&query))
            }
            "crash" => std::process::exit(3),
            "eof" => {
                drop(self.sink.lock().unwrap_or_else(PoisonError::into_inner).take());
                hang()
            }
            "malformed" => {
                if let Some(sink) = self.sink.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
                    let _ = sink.write_all(&[0, 0, 0, 5, 0, b'n', b'o', b'p', b'e']).and_then(|()| sink.flush());
                }
                hang()
            }
            "refuse" => Err(Rejection::Refused(Refusal { message: "refused by the fixture".to_owned() })),
            "fail" => Err(Rejection::Failed(WorkerFailure { kind: FailureKind::Io, message: "failed by the fixture".to_owned() })),
            "panic" => panic!("the fixture panicked"),
            "big" => {
                let bytes = query.args.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
                Ok(Answer { text: "x".repeat(bytes), ..self.echo(&query) })
            }
            _ => Ok(self.echo(&query)),
        }
    }

    fn prewarm(&self, _prewarm: Prewarm) -> Result<Warmed, WorkerFailure> {
        Ok(Warmed { built: true })
    }

    fn changed(&self, changed: Changed) {
        let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        seen.extend(changed.files.into_iter().map(|file| match file {
            FileIdentity::Known { identity } => identity,
            FileIdentity::Unknown => "?".to_owned(),
        }));
        self.noticed.notify_all();
    }

    fn forget_root(&self, forget: ForgetRoot) -> Result<Forgot, WorkerFailure> {
        if self.hold_forget {
            wait_at(self.barrier.as_deref(), "forget");
        }
        Ok(Forgot { removed: vec![forget.root.to_string_lossy().into_owned()], kept: Vec::new() })
    }

    fn drain(&self) -> Result<(), WorkerFailure> {
        if self.hold_drain {
            wait_at(self.barrier.as_deref(), "drain");
        }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|arg| arg == name);
    let barrier = args.iter().position(|arg| arg == "--barrier").and_then(|at| args.get(at + 1)).cloned();
    if worker::hold_to_parent().is_err() {
        std::process::exit(worker::EXIT_UNCONTAINED);
    }
    if flag("--hold-ready") {
        wait_at(barrier.as_deref(), "ready");
    }
    let sink: Sink = Arc::new(Mutex::new(Some(stdout_pipe())));
    if flag("--bad-ready") {
        let ready = frame::encode(&FromWorker::Ready { ready: Ready { version: 999, pid: std::process::id() } }).expect("a Ready encodes");
        let mut output = Output(sink);
        let _ = output.write_all(&ready).and_then(|()| output.flush());
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        std::process::exit(worker::EXIT_DONE);
    }
    let fixture = Fixture {
        sink: sink.clone(),
        barrier,
        hold_drain: flag("--hold-drain"),
        hold_forget: flag("--hold-forget"),
        seen: Mutex::new(Vec::new()),
        noticed: Condvar::new(),
    };
    std::process::exit(worker::serve(Arc::new(fixture), io::stdin().lock(), Output(sink)));
}
