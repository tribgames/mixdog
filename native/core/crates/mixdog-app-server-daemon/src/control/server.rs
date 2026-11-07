//! The control listener (LR §6.1): its own OS threads, no async runtime, no actor. It reads
//! the lifecycle's lock-free status snapshot and calls the lifecycle's synchronous commands,
//! so it answers `status` and honours `terminate` while every async worker is blocked.

use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

use serde::de::DeserializeOwned;

use super::api::CANCEL_DRAIN_PATH;
use super::api::CancelDrainRequest;
use super::api::ErrorReply;
use super::api::command_error;
use super::api::HOLD_PATH;
use super::api::HoldRequest;
use super::api::RELEASE_PATH;
use super::api::ReleaseRequest;
use super::api::STATUS_PATH;
use super::api::STOP_PATH;
use super::api::StatusReply;
use super::api::StopRequest;
use super::api::TERMINATE_PATH;
use super::api::TerminateRequest;
use super::http::ParseError;
use super::http::Request;
use super::http::Response;
use super::http::read_request;
use super::legacy::Legacy;
use crate::lifecycle::CommandError;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::StopReason;
use crate::lifecycle::ct_eq;

/// Connections served at once. A slow or silent client holds one thread and nothing else.
const MAX_CONNECTIONS: usize = 16;
/// Socket read and write bound: it frees a thread from a silent peer; it decides nothing
/// about the core.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct ControlConfig {
    /// The discovery token: it authenticates the RPC upgrade and every management request.
    pub token: String,
    pub legacy: Legacy,
}

/// A fresh 256-bit token.
pub fn new_token() -> String {
    crate::lifecycle::hex(&rand::random::<[u8; 32]>())
}

struct Shared {
    config: ControlConfig,
    lifecycle: Arc<Lifecycle>,
    active: AtomicUsize,
}

pub struct ControlServer {
    port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// The bound control socket, before anything accepts on it: discovery names its port before the
/// lifecycle that serves it exists.
pub struct ControlListener {
    listener: TcpListener,
    port: u16,
}

impl ControlListener {
    /// Binds `127.0.0.1` on a free port.
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl ControlServer {
    /// Binds `127.0.0.1` on a free port and starts accepting.
    pub fn start(config: ControlConfig, lifecycle: Arc<Lifecycle>) -> std::io::Result<Self> {
        Self::serve(ControlListener::bind()?, config, lifecycle)
    }

    /// Starts accepting on a bound listener.
    pub fn serve(bound: ControlListener, config: ControlConfig, lifecycle: Arc<Lifecycle>) -> std::io::Result<Self> {
        let ControlListener { listener, port } = bound;
        let shutdown = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared { config, lifecycle, active: AtomicUsize::new(0) });
        let thread = std::thread::Builder::new().name("mixdog-control".into()).spawn({
            let shutdown = Arc::clone(&shutdown);
            move || accept_loop(&listener, &shared, &shutdown)
        })?;
        Ok(Self { port, shutdown, thread: Some(thread) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Wakes the blocking accept.
        let _ = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn accept_loop(listener: &TcpListener, shared: &Arc<Shared>, shutdown: &AtomicBool) {
    for incoming in listener.incoming() {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                tracing::warn!(%error, "control accept failed");
                continue;
            }
        };
        if stream.set_read_timeout(Some(IO_TIMEOUT)).is_err()
            || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
        {
            continue;
        }
        if shared.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.active.fetch_sub(1, Ordering::SeqCst);
            let _ = Response::json(503, &ErrorReply::new("busy", "too many control connections"))
                .write_to(&mut &stream);
            continue;
        }
        let worker = Arc::clone(shared);
        let spawned = std::thread::Builder::new().name("mixdog-control-conn".into()).spawn(move || {
            worker.serve(stream);
            worker.active.fetch_sub(1, Ordering::SeqCst);
        });
        if let Err(error) = spawned {
            // The connection went down with the closure; the client sees it close.
            shared.active.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!(%error, "no thread for a control connection");
        }
    }
}

impl Shared {
    fn serve(&self, mut stream: TcpStream) {
        let outcome = match read_request(&stream) {
            Ok(request) => self.route(&request, &mut stream),
            Err(ParseError::BodyTooLarge) => {
                Response::json(413, &ErrorReply::new("bodyTooLarge", "body over 64 KiB"))
                    .write_to(&mut stream)
            }
            Err(ParseError::Io(error)) => Err(error),
            Err(error) => Response::json(400, &ErrorReply::new("badRequest", error.to_string()))
                .write_to(&mut stream),
        };
        if let Err(error) = outcome {
            tracing::debug!(%error, "control connection ended early");
        }
    }

    fn route(&self, request: &Request, out: &mut impl Write) -> std::io::Result<()> {
        if request.path.starts_with("/mgmt/") {
            return self.manage(request, out);
        }
        if request.method == "GET" && request.path == "/health" {
            return self.config.legacy.health().write_to(out);
        }
        // Everything else is a route a 1.4.5 client could call.
        self.config.legacy.refuse().write_to(out)
    }

    fn manage(&self, request: &Request, out: &mut impl Write) -> std::io::Result<()> {
        if request.header("origin").is_some() {
            return Response::json(403, &ErrorReply::new("originRefused", "browser origins are refused"))
                .write_to(out);
        }
        let expected = format!("Bearer {}", self.config.token);
        if !request.header("authorization").is_some_and(|given| ct_eq(given, &expected)) {
            return Response::json(401, &ErrorReply::new("unauthorized", "missing or wrong token"))
                .write_to(out);
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", STATUS_PATH) => self.status_reply().write_to(out),
            ("POST", HOLD_PATH) => {
                self.with_body(request, out, |lc, r: HoldRequest| lc.hold(r.on))
            }
            ("POST", STOP_PATH) => self.stop(request, out),
            ("POST", CANCEL_DRAIN_PATH) => self
                .with_body(request, out, |lc, r: CancelDrainRequest| lc.cancel_drain(&r.drain_id)),
            ("POST", RELEASE_PATH) => self.with_body(request, out, |lc, r: ReleaseRequest| {
                lc.release_decision(r.pid, &r.confirm_token)
            }),
            ("POST", TERMINATE_PATH) => self.terminate(request, out),
            _ => Response::json(404, &ErrorReply::new("unknownRoute", "no such management route"))
                .write_to(out),
        }
    }

    fn status_reply(&self) -> Response {
        let status = self.lifecycle.status();
        Response::json(200, &StatusReply { status: (*status).clone(), stalled_ms: self.lifecycle.stalled_ms() })
    }

    fn stop(&self, request: &Request, out: &mut impl Write) -> std::io::Result<()> {
        match serde_json::from_slice::<StopRequest>(&request.body) {
            Ok(body) if body.reason == StopReason::NoClients => {
                bad_request("noClients is the core's own trigger", out)
            }
            // Node's replacement text names the build (`daemon.mjs:589`): a replacement stop without one has nothing to say.
            Ok(body) if body.reason.is_replacement() && body.replacement.is_none() => {
                bad_request("a replacement stop names the build that replaces this one (replacement{revision, version})", out)
            }
            Ok(body) => self.command(out, |lifecycle| match &body.replacement {
                Some(build) => lifecycle.stop_noting(body.mode, body.reason, body.confirm_token.as_deref(), &build.node_text()),
                None => lifecycle.stop(body.mode, body.reason, body.confirm_token.as_deref()),
            }),
            Err(error) => bad_request(&error.to_string(), out),
        }
    }

    fn with_body<T: DeserializeOwned>(
        &self,
        request: &Request,
        out: &mut impl Write,
        run: impl FnOnce(&Arc<Lifecycle>, T) -> Result<(), CommandError>,
    ) -> std::io::Result<()> {
        match serde_json::from_slice::<T>(&request.body) {
            Ok(body) => self.command(out, |lifecycle| run(lifecycle, body)),
            Err(error) => bad_request(&error.to_string(), out),
        }
    }

    /// A command answers with the state after it, or `409` with the refusal.
    fn command(
        &self,
        out: &mut impl Write,
        run: impl FnOnce(&Arc<Lifecycle>) -> Result<(), CommandError>,
    ) -> std::io::Result<()> {
        match run(&self.lifecycle) {
            Ok(()) => self.status_reply().write_to(out),
            Err(error) => Response::json(409, &command_error(error)).write_to(out),
        }
    }

    fn terminate(&self, request: &Request, out: &mut impl Write) -> std::io::Result<()> {
        let body: TerminateRequest = match serde_json::from_slice(&request.body) {
            Ok(body) => body,
            Err(error) => return bad_request(&error.to_string(), out),
        };
        let mut written = Ok(());
        let verdict = self.lifecycle.terminate(&body.confirm_token, || {
            written = self.status_reply().write_to(out);
        });
        match verdict {
            Ok(()) => written,
            Err(error) => Response::json(409, &command_error(error)).write_to(out),
        }
    }
}

fn bad_request(message: &str, out: &mut impl Write) -> std::io::Result<()> {
    Response::json(400, &ErrorReply::new("badRequest", message)).write_to(out)
}
