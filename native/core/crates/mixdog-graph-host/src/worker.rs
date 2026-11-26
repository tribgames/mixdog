//! The helper's side of the wire: [`serve`] answers the core's requests through a [`Handler`].
//!
//! Three threads serve: the caller's reads the input and applies write notices itself, so each is applied, in order,
//! before any request read after it, whatever a build is doing; the build thread runs queries and prewarms one at a time
//! in arrival order; the maintenance thread runs root removals. Each reply is written whole under one lock. Nothing else
//! may write to the output: a byte outside a frame ends the helper's generation. The helper's log goes to its standard
//! error ([`log_to_stderr`]), which the core carries into its own.

use std::io;
use std::io::Read;
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;
use std::time::Instant;

pub use mixdog_spawn::owned::hold_to_parent;

use crate::frame;
use crate::frame::FrameReader;
use crate::wire::Answer;
use crate::wire::Changed;
use crate::wire::DrainAck;
use crate::wire::FailureKind;
use crate::wire::ForgetRoot;
use crate::wire::Forgot;
use crate::wire::FromWorker;
use crate::wire::MaintenanceResult;
use crate::wire::PROTOCOL_VERSION;
use crate::wire::Prewarm;
use crate::wire::Query;
use crate::wire::Ready;
use crate::wire::Refusal;
use crate::wire::Reply;
use crate::wire::RequestId;
use crate::wire::ToWorker;
use crate::wire::Warmed;
use crate::wire::WorkerFailure;

/// What the helper's engine supplies. Every method may run while another does: [`Handler::changed`] in particular is
/// called while a build runs and must not wait for it.
pub trait Handler: Send + Sync + 'static {
    /// One top-level query, on the build thread. A panic answers it with an internal failure.
    fn query(&self, query: Query) -> Result<Answer, Rejection>;

    /// Build the graph of the project `prewarm.cwd` belongs to, on the build thread.
    fn prewarm(&self, prewarm: Prewarm) -> Result<Warmed, WorkerFailure>;

    /// Write notices, on the control reader, in the order they were noticed.
    fn changed(&self, changed: Changed);

    /// Drop one root, on the maintenance thread, serialized with its refresh and pending commits by the engine.
    fn forget_root(&self, forget: ForgetRoot) -> Result<Forgot, WorkerFailure>;

    /// Flush staged writes before the helper exits; the build and maintenance threads have finished.
    fn drain(&self) -> Result<(), WorkerFailure>;
}

/// Why a query has no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rejection {
    Refused(Refusal),
    Failed(WorkerFailure),
}

/// The helper drained, or its owner closed the input.
pub const EXIT_DONE: i32 = 0;
/// The helper could not write to its owner or start a thread.
pub const EXIT_FAILED: i32 = 1;
/// The input was not a frame of a request.
pub const EXIT_MALFORMED: i32 = 2;
/// The helper could not hold to its owner ([`hold_to_parent`]), so it never served.
pub const EXIT_UNCONTAINED: i32 = 3;

/// The helper process: logs to its standard error, holds to its owner, then serves over the standard pipes. Answers the
/// process's exit code.
pub fn serve_stdio<H: Handler>(handler: H) -> i32 {
    log_to_stderr();
    if hold_to_parent().is_err() {
        return EXIT_UNCONTAINED;
    }
    serve(Arc::new(handler), io::stdin().lock(), io::stdout())
}

/// The helper's log: its records, filtered as the core filters its own (`RUST_LOG`), one line each on its standard
/// error, the level first, for the core to log again at that level. A process that already has a subscriber keeps it.
pub fn log_to_stderr() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .with_ansi(false)
        .without_time()
        .with_target(false)
        // Its standard error is the only place a failed write could be reported.
        .log_internal_errors(false)
        .try_init();
}

/// Announces [`Ready`] on `output`, then answers the requests read from `input` until a drain or the input's end.
/// Answers the exit code. At the input's end it returns at once: a build still running is the process's to end.
pub fn serve<H: Handler>(handler: Arc<H>, input: impl Read, output: impl Write + Send + 'static) -> i32 {
    let output = Arc::new(Output(Mutex::new(Box::new(output))));
    let ready = FromWorker::Ready { ready: Ready { version: PROTOCOL_VERSION, pid: std::process::id() } };
    if output.send(&ready).is_err() {
        return EXIT_FAILED;
    }
    let (builds, build_queue) = mpsc::channel::<Build>();
    let (removals, removal_queue) = mpsc::channel::<(RequestId, ForgetRoot)>();
    let build = {
        let (handler, output) = (handler.clone(), output.clone());
        std::thread::Builder::new().name("graph-build".to_owned()).spawn(move || run_builds(&*handler, &output, build_queue))
    };
    let maintenance = {
        let (handler, output) = (handler.clone(), output.clone());
        std::thread::Builder::new().name("graph-maintenance".to_owned()).spawn(move || run_removals(&*handler, &output, removal_queue))
    };
    let (Ok(build), Ok(maintenance)) = (build, maintenance) else { return EXIT_FAILED };
    let mut reader = FrameReader::new(input);
    loop {
        match reader.read::<ToWorker>() {
            Ok(Some(ToWorker::Query { id, query })) => drop(builds.send(Build::Query { id, query, received: Instant::now() })),
            Ok(Some(ToWorker::Prewarm { id, prewarm })) => drop(builds.send(Build::Prewarm { id, prewarm })),
            Ok(Some(ToWorker::Changed { changed })) => handler.changed(changed),
            Ok(Some(ToWorker::ForgetRoot { id, forget })) => drop(removals.send((id, forget))),
            Ok(Some(ToWorker::DrainAndExit { id })) => {
                drop((builds, removals));
                // Each thread answers its own panics, so a join only waits.
                let _ = (build.join(), maintenance.join());
                let failure = match guarded(|| handler.drain()) {
                    Ok(Ok(())) => None,
                    Ok(Err(failure)) | Err(failure) => Some(failure),
                };
                return match output.reply(id, Reply::DrainAck { ack: DrainAck { failure } }) {
                    Ok(()) => EXIT_DONE,
                    Err(_) => EXIT_FAILED,
                };
            }
            Ok(None) => return EXIT_DONE,
            Err(_) => return EXIT_MALFORMED,
        }
    }
}

enum Build {
    Query { id: RequestId, query: Query, received: Instant },
    Prewarm { id: RequestId, prewarm: Prewarm },
}

fn run_builds(handler: &impl Handler, output: &Output, queue: mpsc::Receiver<Build>) {
    for build in queue {
        let (id, reply) = match build {
            Build::Query { id, query, received } => {
                let queue_ms = u64::try_from(received.elapsed().as_millis()).unwrap_or(u64::MAX);
                let reply = match guarded(|| handler.query(query)) {
                    Ok(Ok(mut answer)) => {
                        answer.timings.queue_ms = queue_ms;
                        Reply::Answer { answer }
                    }
                    Ok(Err(Rejection::Refused(refusal))) => Reply::Refused { refusal },
                    Ok(Err(Rejection::Failed(failure))) | Err(failure) => Reply::Failed { failure },
                };
                (id, reply)
            }
            Build::Prewarm { id, prewarm } => {
                let reply = match guarded(|| handler.prewarm(prewarm)) {
                    Ok(Ok(warmed)) => Reply::Maintenance { result: MaintenanceResult::Warmed { warmed } },
                    Ok(Err(failure)) | Err(failure) => Reply::Failed { failure },
                };
                (id, reply)
            }
        };
        if output.reply(id, reply).is_err() {
            return;
        }
    }
}

fn run_removals(handler: &impl Handler, output: &Output, queue: mpsc::Receiver<(RequestId, ForgetRoot)>) {
    for (id, forget) in queue {
        let reply = match guarded(|| handler.forget_root(forget)) {
            Ok(Ok(forgot)) => Reply::Maintenance { result: MaintenanceResult::Forgot { forgot } },
            Ok(Err(failure)) | Err(failure) => Reply::Failed { failure },
        };
        if output.reply(id, reply).is_err() {
            return;
        }
    }
}

/// `work`, with a panic turned into the request's internal failure.
fn guarded<T>(work: impl FnOnce() -> T) -> Result<T, WorkerFailure> {
    std::panic::catch_unwind(AssertUnwindSafe(work)).map_err(|payload| {
        let text = payload.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_default();
        WorkerFailure { kind: FailureKind::Internal, message: format!("the code graph helper panicked: {text}") }
    })
}

struct Output(Mutex<Box<dyn Write + Send>>);

impl Output {
    fn send(&self, message: &FromWorker) -> io::Result<()> {
        self.write(&frame::encode(message).map_err(io::Error::other)?)
    }

    /// A reply too large to send fails its request instead of arriving cut.
    fn reply(&self, id: RequestId, reply: Reply) -> io::Result<()> {
        match frame::encode(&FromWorker::Reply { id, reply }) {
            Ok(bytes) => self.write(&bytes),
            Err(error) => {
                let failure = WorkerFailure { kind: FailureKind::Internal, message: format!("the reply could not be sent: {error}") };
                self.send(&FromWorker::Reply { id, reply: Reply::Failed { failure } })
            }
        }
    }

    fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut sink = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        sink.write_all(bytes)?;
        sink.flush()
    }
}
