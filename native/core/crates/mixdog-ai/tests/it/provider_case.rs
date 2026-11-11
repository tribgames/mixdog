//! The shared case driver of the provider replays: one scripted loopback endpoint and one reader for every set under
//! `native/core/fixtures/provider-<set>/` (recorded by `benchmarks/rust-core/recorders/record-<set>.mjs` through
//! `lib/provider-case-recorder.mjs` and `lib/ws-world.mjs`). A set's replay drives the product's real entry over the
//! core's own HTTP client or WebSocket dialer, redirected here, and compares what the recording holds, whole and in order.
//!
//! API (a set uses these and nothing else of the endpoint):
//! - [`CaseSet::load`]`(set)` reads `cases.json` and `MANIFEST.json` at run time (decoded with `mixdog_testkit::exact`);
//!   [`CaseSet::case`]`(id)` gives a [`Case`]: `input`, `outcome` (result or error), `calls` (`$shared` arguments
//!   resolved), `requests` (each as it arrived, with its scripted `reply`), `clock` (the recorded advances).
//! - [`Endpoint::start`] opens the endpoint (plain HTTP/1.1 and WebSocket on 127.0.0.1) and holds the paused clock for
//!   its lifetime: run the test as `#[tokio::test(start_paused = true)]` (current-thread); time then moves only by
//!   [`Endpoint::advance`] with a recorded step, never by tokio's auto-advance.
//! - [`Endpoint::serve`]`(&case)`: the k-th request that arrives is answered by `requests[k].reply` as the recorder's
//!   endpoint answered it (status, `content-type`, headers, a body, or chunks each its own write; `hold` keeps the
//!   response open until the client closes; `destroy` drops the connection unanswered). An unscripted arrival gets the
//!   recorder's 404 `not scripted`.
//! - [`Endpoint::ws_script`]`(trace)`: the dialer is given each upgrade's recorded `Sec-WebSocket-Key` in order
//!   (`mixdog_ai::transport::ws::ScriptedKey`, a test-support seam), and the WebSocket side follows a recorded ws-world trace: each server action of it
//!   (upgrade answer, refusal, reset, silence, frame, ping, close, terminate) runs once the replay's own trace has as
//!   many entries as precede it in the recording. [`Endpoint::note`] appends a case-side entry (a callback, a stage) to
//!   the replay's trace, as the recorder's `world.note` did; [`Endpoint::trace`] is that trace.
//! - [`Endpoint::link`]`(inner)` / [`Endpoint::dialer`]`(schedule)`: the core's own link and dialer redirected here
//!   (`mixdog_ai::transport::redirect`), to hand to the product's builder in place of the production ones.
//! - [`Endpoint::arrivals`]: each request as it arrived, in the recorded shape (method, origin, path, every header in
//!   arrival order and case, body bytes; `clientClosedConnection` when a held response saw the client close).
//! - [`CaseSet::assert_requests`]`(case, arrivals, either_order)`: whole and in order, after the manifest's declared rules
//!   only: `host` as the addressed origin's host (or `127.0.0.1:<port>`), the `x-stainless-*` recording-host placeholders,
//!   and one declared either-order pair of request indexes.
//! - [`assert_exact`]: whole comparison, failing with the first differing path; [`within`] / [`Endpoint::until`]: every
//!   wait is an event with a deadline on the machine's clock and a message naming it.
#![allow(dead_code, reason = "the shared driver of every provider set: each set uses part of it")]

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::redirect::ORIGIN_HEADER;
use mixdog_ai::transport::redirect::Redirected;
use mixdog_ai::transport::redirect::RedirectedDialer;
use mixdog_testkit::Exact;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// How long one wait may last before it is the test's failure, on the machine's clock.
pub const DEADLINE: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------------------------------------------------
// The recording
// ---------------------------------------------------------------------------------------------------------------------

/// What Node's call returned or threw.
#[derive(Debug, Clone)]
pub enum Outcome {
    Result(Exact),
    Error(Exact),
}

/// One call the recorder made to a product export, with its arguments as viewed at call time.
#[derive(Debug, Clone)]
pub struct Call {
    pub entry: String,
    pub args: Vec<Exact>,
}

/// One recorded clock step: `advance_ms` from `from_ms` to `to_ms` on the set's running clock (one virtual clock for
/// the whole recording: it carries across cases, each step starting where the set's previous one ended), and the due
/// times of the timers that fired in it, in firing order.
#[derive(Debug, Clone, PartialEq)]
pub struct ClockStep {
    pub advance_ms: u64,
    pub from_ms: u64,
    pub to_ms: u64,
    pub fired: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct Case {
    pub id: String,
    pub source: String,
    pub input: Exact,
    pub outcome: Outcome,
    pub calls: Vec<Call>,
    /// Each request as it arrived, with the `reply` the endpoint answered it with.
    pub requests: Vec<Exact>,
    pub clock: Vec<ClockStep>,
    /// The set's running clock when the case began: where the set's previous recorded step ended (0 for none).
    pub clock_origin_ms: u64,
}

impl Case {
    /// The recorded result; panics naming the case when it threw.
    pub fn result(&self) -> &Exact {
        match &self.outcome {
            Outcome::Result(value) => value,
            Outcome::Error(error) => panic!("{}: recorded an error, not a result: {error:?}", self.id),
        }
    }

    /// The arguments of the `n`-th call to `entry` (an entry name ends with it, e.g. `AnthropicProvider#send`).
    pub fn args_of(&self, entry: &str, n: usize) -> &[Exact] {
        &self
            .calls
            .iter()
            .filter(|call| call.entry.ends_with(entry))
            .nth(n)
            .unwrap_or_else(|| panic!("{}: no call {n} of {entry}", self.id))
            .args
    }
}

pub struct CaseSet {
    pub set: String,
    pub manifest: Exact,
    pub cases: Vec<Case>,
    /// The manifest's exclusions, the only rules a replay applies.
    exclusions: Vec<String>,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// Replaces the recorder's `{"$shared": n}` argument references by the shared values.
fn unshare(value: &Exact, shared: &[Exact]) -> Exact {
    match value {
        Exact::Object(entries) if entries.len() == 1 && entries[0].0 == "$shared" => {
            shared[entries[0].1.as_f64() as usize].clone()
        }
        other => other.clone(),
    }
}

fn ms(value: &Exact) -> u64 {
    value.as_f64() as u64
}

impl CaseSet {
    /// `set` without its `provider-` prefix, e.g. `anthropic-stream`.
    pub fn load(set: &str) -> Self {
        let dir = fixtures().join(format!("provider-{set}"));
        let manifest = Exact::load(dir.join("MANIFEST.json"));
        let recording = Exact::load(dir.join("cases.json"));
        let shared = recording.try_get("shared").map(|s| s.as_array().to_vec()).unwrap_or_default();
        let mut running_ms = 0;
        let cases = recording
            .get("cases")
            .as_array()
            .iter()
            .map(|case| {
                let outcome = match (case.try_get("result"), case.try_get("error")) {
                    (Some(result), None) => Outcome::Result(result.clone()),
                    (None, Some(error)) => Outcome::Error(error.clone()),
                    _ => panic!("{set}: a case holds one of result and error: {case:?}"),
                };
                let clock: Vec<ClockStep> = case
                    .try_get("clock")
                    .map(|steps| {
                        steps
                            .as_array()
                            .iter()
                            .map(|step| ClockStep {
                                advance_ms: ms(step.get("advanceMs")),
                                from_ms: ms(step.get("fromMs")),
                                to_ms: ms(step.get("toMs")),
                                fired: step.get("fired").as_array().iter().map(|f| ms(f.get("dueMs"))).collect(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let clock_origin_ms = running_ms;
                if let Some(last) = clock.last() {
                    running_ms = last.to_ms;
                }
                Case {
                    id: case.get("id").as_str().to_owned(),
                    source: case.get("source").as_str().to_owned(),
                    input: case.get("input").clone(),
                    outcome,
                    calls: case
                        .try_get("calls")
                        .map(|calls| {
                            calls
                                .as_array()
                                .iter()
                                .map(|call| Call {
                                    entry: call.get("entry").as_str().to_owned(),
                                    args: call.get("args").as_array().iter().map(|arg| unshare(arg, &shared)).collect(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    requests: case.try_get("requests").map(|r| r.as_array().to_vec()).unwrap_or_default(),
                    clock,
                    clock_origin_ms,
                }
            })
            .collect();
        let exclusions = match manifest.try_get("exclusions") {
            Some(Exact::Array(items)) => items.iter().map(|e| e.as_str().to_owned()).collect(),
            _ => Vec::new(),
        };
        Self { set: set.to_owned(), manifest, cases, exclusions }
    }

    pub fn case(&self, id: &str) -> &Case {
        self.cases.iter().find(|case| case.id == id).unwrap_or_else(|| panic!("{}: no case {id}", self.set))
    }

    /// The case ids, in recorded order.
    pub fn ids(&self) -> Vec<&str> {
        self.cases.iter().map(|case| case.id.as_str()).collect()
    }

    /// The manifest's level row of a case (`wire` or `pure`, with the Rust function named for a pure one).
    pub fn level(&self, id: &str) -> &Exact {
        self.manifest
            .get("levels")
            .as_array()
            .iter()
            .find(|row| row.get("id").as_str() == id)
            .unwrap_or_else(|| panic!("{}: no level row for {id}", self.set))
    }

    fn declares(&self, text: &str) -> bool {
        self.exclusions.iter().any(|exclusion| exclusion.contains(text))
    }

    /// The arrivals with the manifest's declared rules applied (and only those).
    pub fn ruled(&self, arrivals: &[Exact]) -> Vec<Exact> {
        let origin_host = self.declares("`host` is the host of the origin the product addressed");
        let loopback_port = self.declares("`127.0.0.1:<port>`");
        let stainless = self.declares("x-stainless-os, x-stainless-arch and x-stainless-runtime-version");
        arrivals
            .iter()
            .map(|arrival| {
                let origin = arrival.get("origin").as_str().to_owned();
                let Exact::Object(entries) = arrival else { unreachable!("an arrival is an object") };
                let entries = entries
                    .iter()
                    .map(|(key, value)| {
                        if key != "headers" {
                            return (key.clone(), value.clone());
                        }
                        let headers = value
                            .as_array()
                            .iter()
                            .map(|pair| {
                                let [name, value] = pair.as_array() else { unreachable!("a header is a pair") };
                                let lower = name.as_str().to_ascii_lowercase();
                                let value = if lower == "host" && loopback_port {
                                    Exact::String("127.0.0.1:<port>".into())
                                } else if lower == "host" && origin_host {
                                    let url = url::Url::parse(&origin).expect("an origin");
                                    let host = url.host_str().expect("a host");
                                    Exact::String(url.port().map_or(host.to_owned(), |port| format!("{host}:{port}")))
                                } else if stainless && matches!(lower.as_str(), "x-stainless-os" | "x-stainless-arch" | "x-stainless-runtime-version") {
                                    Exact::String(format!("<recording host {lower}>"))
                                } else {
                                    value.clone()
                                };
                                Exact::Array(vec![name.clone(), value])
                            })
                            .collect();
                        (key.clone(), Exact::Array(headers))
                    })
                    .collect();
                Exact::Object(entries)
            })
            .collect()
    }

    /// The arrivals equal the case's recorded requests, whole and in order, after the declared rules. `either_order` is
    /// a pair of request indexes the manifest declares may arrive in either order.
    pub fn assert_requests(&self, case: &Case, arrivals: &[Exact], either_order: Option<(usize, usize)>) {
        let want: Vec<Exact> = case
            .requests
            .iter()
            .map(|request| match request {
                Exact::Object(entries) => Exact::Object(entries.iter().filter(|(k, _)| k != "reply").cloned().collect()),
                other => panic!("{}: a request is an object: {other:?}", case.id),
            })
            .collect();
        let mut got = self.ruled(arrivals);
        if let Some((a, b)) = either_order
            && got.len() > a.max(b)
            && got[a] == want[b]
            && got[b] == want[a]
        {
            got.swap(a, b);
        }
        assert_exact(&format!("{} {}: requests", self.set, case.id), &Exact::Array(want), &Exact::Array(got));
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------------------------------

fn show(value: &Exact) -> String {
    let text = format!("{value:?}");
    if text.len() > 400 { format!("{}…", text.chars().take(400).collect::<String>()) } else { text }
}

/// The first path at which `got` differs from `want`, keys and items in order.
pub fn first_difference(want: &Exact, got: &Exact, path: &str) -> Option<String> {
    match (want, got) {
        (Exact::Object(a), Exact::Object(b)) => {
            for i in 0..a.len().max(b.len()) {
                match (a.get(i), b.get(i)) {
                    (Some((ka, va)), Some((kb, vb))) if ka == kb => {
                        if let Some(found) = first_difference(va, vb, &format!("{path}.{ka}")) {
                            return Some(found);
                        }
                    }
                    (x, y) => {
                        return Some(format!(
                            "{path}: key {i}: Node {} / Rust {}",
                            x.map_or("absent".into(), |(k, v)| format!("{k}={}", show(v))),
                            y.map_or("absent".into(), |(k, v)| format!("{k}={}", show(v)))
                        ));
                    }
                }
            }
            None
        }
        (Exact::Array(a), Exact::Array(b)) => {
            for i in 0..a.len().max(b.len()) {
                match (a.get(i), b.get(i)) {
                    (Some(x), Some(y)) => {
                        if let Some(found) = first_difference(x, y, &format!("{path}[{i}]")) {
                            return Some(found);
                        }
                    }
                    (x, y) => {
                        return Some(format!(
                            "{path}[{i}]: Node {} / Rust {}",
                            x.map_or("absent".into(), show),
                            y.map_or("absent".into(), show)
                        ));
                    }
                }
            }
            None
        }
        _ if want == got => None,
        _ => Some(format!("{path}: Node {} / Rust {}", show(want), show(got))),
    }
}

/// `got` equals `want` whole; the failure names the first differing path.
#[track_caller]
pub fn assert_exact(what: &str, want: &Exact, got: &Exact) {
    if let Some(difference) = first_difference(want, got, "$") {
        panic!("{what}: differs from Node at {difference}");
    }
}

/// A plain JSON value of a Rust entry, as an exact value.
pub fn plain(value: &Value) -> Exact {
    Exact::plain(value)
}

// ---------------------------------------------------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------------------------------------------------

/// Awaits `wait`, failing with `what` if it has not ended within [`DEADLINE`] on the machine's clock. The deadline is a
/// blocking task, which a paused runtime clock cannot skip past, and it ends as soon as the wait is over.
pub async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    let (over, ended) = std::sync::mpsc::channel::<()>();
    let (fire, mut fired) = tokio::sync::oneshot::channel();
    #[allow(clippy::disallowed_methods, reason = "test deadline on the machine's clock")]
    tokio::task::spawn_blocking(move || {
        if ended.recv_timeout(DEADLINE) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            let _ = fire.send(());
        }
    });
    let _over = over;
    tokio::select! {
        biased;
        value = wait => value,
        Ok(()) = &mut fired => panic!("timed out after {DEADLINE:?} waiting for {what}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------------------------------

/// A command to one WebSocket connection's task.
enum WsCommand {
    Accept(Vec<String>),
    Refuse { status: u16, status_text: String, headers: Vec<(String, String)>, body_chunks: Vec<Vec<u8>> },
    Reset,
    LeaveUnanswered,
    Send(Message),
    Close(u16, String),
    Terminate,
}

#[derive(Default)]
struct State {
    replies: Vec<Exact>,
    arrivals: Vec<Exact>,
    trace: Vec<Exact>,
    /// The connection of each trace entry (`None`: a case-side entry), for the script to address its actions.
    trace_conns: Vec<Option<usize>>,
    ws_conns: Vec<mpsc::UnboundedSender<WsCommand>>,
    /// The recorded `Sec-WebSocket-Key` of each upgrade, in order, for the dialer's scripted key source.
    ws_keys: std::collections::VecDeque<String>,
    steps: Vec<ClockStep>,
}

struct Inner {
    state: Mutex<State>,
    /// Bumped on every event of the endpoint (an arrival, a trace entry, a close), waking [`Endpoint::until`].
    events: watch::Sender<u64>,
}

impl Inner {
    fn bump(&self) {
        self.events.send_modify(|n| *n += 1);
    }

    fn note(&self, entry: Exact, conn: Option<usize>) {
        {
            let mut state = self.state.lock().unwrap();
            state.trace.push(entry);
            state.trace_conns.push(conn);
        }
        self.bump();
    }
}

pub struct Endpoint {
    pub addr: SocketAddr,
    inner: Arc<Inner>,
    started: tokio::time::Instant,
    /// The set's running clock at `started` (the replayed case's [`Case::clock_origin_ms`]).
    origin_ms: std::sync::atomic::AtomicU64,
    /// Dropping it ends the clock hold.
    _hold: std::sync::mpsc::Sender<()>,
}

fn obj(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn text(value: impl Into<String>) -> Exact {
    Exact::String(value.into())
}

/// Text when the bytes are UTF-8 (as the recorder stores a body), else the bytes.
fn body_of(bytes: Vec<u8>) -> Exact {
    match String::from_utf8(bytes) {
        Ok(text) => Exact::String(text),
        Err(error) => Exact::Bytes { type_name: "Buffer".into(), bytes: error.into_bytes() },
    }
}

fn bytes_of(value: &Exact) -> Vec<u8> {
    match value {
        Exact::String(text) => text.clone().into_bytes(),
        Exact::Bytes { bytes, .. } => bytes.clone(),
        other => panic!("a body is text or bytes: {other:?}"),
    }
}

/// `http.STATUS_CODES` of Node for the statuses a recording answers with; Node writes `unknown` for any other.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        422 => "Unprocessable Entity",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "unknown",
    }
}

impl Endpoint {
    /// Opens the endpoint on 127.0.0.1 and holds the (paused) clock: no auto-advance while it lives.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the loopback endpoint");
        let addr = listener.local_addr().expect("its address");
        let inner = Arc::new(Inner { state: Mutex::new(State::default()), events: watch::channel(0).0 });
        let served = inner.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                socket.set_nodelay(true).expect("nodelay");
                tokio::spawn(connection(served.clone(), socket));
            }
        });
        // A pending blocking task keeps a paused current-thread runtime from auto-advancing its clock (tokio's
        // `BlockingSchedule`), so only `advance` moves it; it ends when the endpoint is dropped.
        let (hold, held) = std::sync::mpsc::channel::<()>();
        #[allow(clippy::disallowed_methods, reason = "holds the paused test clock; ends with the endpoint")]
        tokio::task::spawn_blocking(move || {
            let _ = held.recv_timeout(DEADLINE * 10);
        });
        Self { addr, inner, started: tokio::time::Instant::now(), origin_ms: 0.into(), _hold: hold }
    }

    /// Places the endpoint's clock on the set's running clock where `case` began; [`Endpoint::serve`] does it, a
    /// WebSocket-only replay calls it before its first [`Endpoint::advance`].
    pub fn clock_at(&self, case: &Case) {
        self.origin_ms.store(case.clock_origin_ms, std::sync::atomic::Ordering::Relaxed);
    }

    /// The set's running clock now.
    pub fn now_ms(&self) -> u64 {
        self.origin_ms.load(std::sync::atomic::Ordering::Relaxed) + self.started.elapsed().as_millis() as u64
    }

    /// Scripts the HTTP side with the case's recorded replies: the k-th arrival is answered by `requests[k].reply`.
    pub fn serve(&self, case: &Case) {
        self.clock_at(case);
        self.inner.state.lock().unwrap().replies = case.requests.iter().map(|request| request.get("reply").clone()).collect();
    }

    /// The core's own link `inner` with every request redirected here.
    pub fn link<L>(&self, inner: L) -> Redirected<L> {
        Redirected { inner, addr: self.addr }
    }

    /// The core's own WebSocket dialer with every dial redirected here; each dial is a `dial` entry of the trace.
    pub fn dialer(&self, schedule: KeepaliveSchedule) -> RedirectedDialer {
        let inner = self.inner.clone();
        let keyed = self.inner.clone();
        RedirectedDialer {
            schedule,
            addr: self.addr,
            keys: Arc::new(move || keyed.state.lock().unwrap().ws_keys.pop_front()),
            tap: Arc::new(move |host: &str, port: u16| {
                let servername = if host.parse::<std::net::IpAddr>().is_ok() { String::new() } else { host.to_owned() };
                inner.note(
                    obj(vec![
                        ("event", text("dial")),
                        ("host", text(host)),
                        ("port", Exact::Number(f64::from(port))),
                        ("servername", text(servername)),
                    ]),
                    None,
                );
            }),
        }
    }

    /// Each request as it arrived, in the recorded shape.
    pub fn arrivals(&self) -> Vec<Exact> {
        self.inner.state.lock().unwrap().arrivals.clone()
    }

    /// The replay's ws-world trace.
    pub fn trace(&self) -> Vec<Exact> {
        self.inner.state.lock().unwrap().trace.clone()
    }

    /// Appends a case-side entry to the trace (the recorder's `world.note`).
    pub fn note(&self, entry: Exact) {
        self.inner.note(entry, None);
    }

    /// Waits until `predicate(self)` holds, woken by every event of the endpoint; fails after [`DEADLINE`] naming `what`.
    pub async fn until(&self, what: &str, predicate: impl Fn(&Self) -> bool) {
        let mut events = self.inner.events.subscribe();
        within(what, async {
            while !predicate(self) {
                events.changed().await.expect("the endpoint lives");
            }
        })
        .await;
    }

    /// Moves the clock by one recorded step; the replay must be at the step's start on the set's running clock.
    pub async fn advance(&self, step: &ClockStep) {
        let from = self.now_ms();
        assert_eq!(from, step.from_ms, "the clock step starts where the recording's did");
        tokio::time::advance(Duration::from_millis(step.advance_ms)).await;
        let to = self.now_ms();
        self.inner.state.lock().unwrap().steps.push(ClockStep { advance_ms: step.advance_ms, from_ms: from, to_ms: to, fired: step.fired.clone() });
    }

    /// The steps the replay took.
    pub fn steps(&self) -> Vec<ClockStep> {
        self.inner.state.lock().unwrap().steps.clone()
    }

    /// Scripts the WebSocket side with a recorded ws-world trace: each server action runs once the replay's trace has as
    /// many entries as precede it in the recording, on the connection of the latest entry before it.
    pub fn ws_script(&self, recorded: &[Exact]) {
        // Node's `ws` drew each key from the recording's fixed random source: the dialer is given the same keys in order.
        self.inner.state.lock().unwrap().ws_keys = recorded
            .iter()
            .filter(|entry| entry.get("event").as_str() == "upgrade-request")
            .filter_map(|entry| {
                entry.get("headers").as_array().iter().find_map(|pair| {
                    let pair = pair.as_array();
                    pair[0].as_str().eq_ignore_ascii_case("sec-websocket-key").then(|| pair[1].as_str().to_owned())
                })
            })
            .collect();
        let inner = self.inner.clone();
        let recorded = recorded.to_vec();
        tokio::spawn(async move {
            let mut events = inner.events.subscribe();
            for (index, entry) in recorded.iter().enumerate() {
                let Some(command) = server_action(entry) else { continue };
                loop {
                    let target = {
                        let state = inner.state.lock().unwrap();
                        (state.trace.len() >= index).then(|| state.trace_conns.iter().rev().find_map(|c| *c))
                    };
                    match target {
                        Some(Some(conn)) => {
                            let sender = inner.state.lock().unwrap().ws_conns[conn].clone();
                            let _ = sender.send(command);
                            break;
                        }
                        Some(None) => panic!("ws script: action {index} has no connection to run on: {entry:?}"),
                        None => {
                            if events.changed().await.is_err() {
                                return;
                            }
                        }
                    }
                }
                // The action's own entry is noted by its connection; the next action waits for it.
                let wanted = index + 1;
                while inner.state.lock().unwrap().trace.len() < wanted {
                    if events.changed().await.is_err() {
                        return;
                    }
                }
            }
        });
    }
}

/// The command a recorded server-side entry of the ws world stands for; `None` for an entry the client or the case makes.
fn server_action(entry: &Exact) -> Option<WsCommand> {
    let event = entry.get("event").as_str();
    let string_pairs = |value: &Exact| -> Vec<(String, String)> {
        value
            .as_array()
            .iter()
            .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
            .collect()
    };
    Some(match event {
        "upgrade-response" => {
            WsCommand::Accept(entry.get("lines").as_array().iter().skip(4).map(|line| line.as_str().to_owned()).collect())
        }
        "upgrade-refused" => WsCommand::Refuse {
            status: entry.get("status").as_f64() as u16,
            status_text: entry.get("statusText").as_str().to_owned(),
            headers: string_pairs(entry.get("headers")),
            body_chunks: entry.get("bodyChunks").as_array().iter().map(bytes_of).collect(),
        },
        "upgrade-reset" => WsCommand::Reset,
        "upgrade-left-unanswered" => WsCommand::LeaveUnanswered,
        "frame" if entry.get("dir").as_str() == "server->client" => match entry.try_get("text") {
            Some(text) => WsCommand::Send(Message::Text(text.as_str().into())),
            None => WsCommand::Send(Message::Binary(hex_decode(entry.get("bytesHex").as_str()).into())),
        },
        "ping" if entry.get("dir").as_str() == "server->client" => {
            WsCommand::Send(Message::Ping(entry.get("data").as_str().as_bytes().to_vec().into()))
        }
        "close-sent" => WsCommand::Close(entry.get("code").as_f64() as u16, entry.get("reason").as_str().to_owned()),
        "terminate" => WsCommand::Terminate,
        _ => return None,
    })
}

fn hex_decode(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A request head as it arrived: the request line and every header (name and value as sent, in order).
struct Head {
    method: String,
    target: String,
    version: u8,
    headers: Vec<(String, String)>,
}

impl Head {
    fn get(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Reads one request head off `socket` (`buf` holds what was read beyond the previous request); `None` when the client
/// closed the connection.
async fn read_head(socket: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Head> {
    loop {
        let mut slots = [httparse::EMPTY_HEADER; 128];
        let mut parsed = httparse::Request::new(&mut slots);
        if let httparse::Status::Complete(len) = parsed.parse(buf).expect("a well-formed request head") {
            let head = Head {
                method: parsed.method.expect("method").to_owned(),
                target: parsed.path.expect("target").to_owned(),
                version: parsed.version.expect("version"),
                headers: parsed
                    .headers
                    .iter()
                    .map(|h| (h.name.to_owned(), String::from_utf8_lossy(h.value).trim_matches([' ', '\t']).to_owned()))
                    .collect(),
            };
            buf.drain(..len);
            return Some(head);
        }
        let mut chunk = [0u8; 16384];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

async fn fill(socket: &mut TcpStream, buf: &mut Vec<u8>, want: usize) -> bool {
    while buf.len() < want {
        let mut chunk = [0u8; 16384];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

/// The request body: by `content-length`, or decoded from `transfer-encoding: chunked`.
async fn read_body(socket: &mut TcpStream, buf: &mut Vec<u8>, head: &Head) -> Option<Vec<u8>> {
    if head.get("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        let mut body = Vec::new();
        loop {
            let line_end = loop {
                if let Some(at) = buf.windows(2).position(|w| w == b"\r\n") {
                    break at;
                }
                let have = buf.len();
                if !fill(socket, buf, have + 1).await {
                    return None;
                }
            };
            let size_text = String::from_utf8_lossy(&buf[..line_end]).into_owned();
            let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).expect("a chunk size");
            buf.drain(..line_end + 2);
            if !fill(socket, buf, size + 2).await {
                return None;
            }
            body.extend_from_slice(&buf[..size]);
            buf.drain(..size + 2);
            if size == 0 {
                return Some(body);
            }
        }
    }
    let length: usize = head.get("content-length").map_or(0, |v| v.parse().expect("a content-length"));
    if !fill(socket, buf, length).await {
        return None;
    }
    Some(buf.drain(..length).collect())
}

/// One TCP connection: HTTP/1.1 requests answered from the script, or a WebSocket upgrade.
async fn connection(inner: Arc<Inner>, mut socket: TcpStream) {
    let port = socket.peer_addr().map(|a| a.port()).unwrap_or_default();
    let mut buf = Vec::new();
    while let Some(head) = read_head(&mut socket, &mut buf).await {
        if head.get("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket")) {
            websocket(inner, socket, head, buf).await;
            return;
        }
        let Some(body) = read_body(&mut socket, &mut buf, &head).await else { return };
        let origin = head.get(ORIGIN_HEADER).map_or_else(|| format!("http://127.0.0.1:{port}"), str::to_owned);
        let headers = head
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case(ORIGIN_HEADER))
            .map(|(name, value)| Exact::Array(vec![text(name.clone()), text(value.clone())]))
            .collect();
        let arrival = obj(vec![
            ("method", text(head.method.clone())),
            ("origin", text(origin)),
            ("path", text(head.target.clone())),
            ("headers", Exact::Array(headers)),
            ("body", body_of(body)),
        ]);
        let (index, reply) = {
            let mut state = inner.state.lock().unwrap();
            state.arrivals.push(arrival);
            let index = state.arrivals.len() - 1;
            (index, state.replies.get(index).cloned())
        };
        inner.bump();
        let reply = reply.unwrap_or_else(|| {
            obj(vec![
                ("status", Exact::Number(404.0)),
                ("contentType", text("application/json")),
                ("body", text(r#"{"error":{"message":"not scripted"}}"#)),
            ])
        });
        if reply.try_get("destroy").is_some_and(|d| d == &Exact::Bool(true)) {
            return;
        }
        let keep_alive = head.version == 1 && !head.get("connection").is_some_and(|v| v.eq_ignore_ascii_case("close"));
        if !answer(&inner, &mut socket, index, &reply, keep_alive).await || !keep_alive {
            return;
        }
    }
}

/// Writes the scripted reply as Node's `http` server wrote it (`date` set first, then `content-type` and the reply's
/// headers, then Node's own `Connection`, `Keep-Alive` and framing headers); `false` when the connection is done.
async fn answer(inner: &Inner, socket: &mut TcpStream, index: usize, reply: &Exact, keep_alive: bool) -> bool {
    let status = reply.try_get("status").map_or(200, |s| s.as_f64() as u16);
    let mut headers: Vec<(String, String)> = vec![
        ("date".into(), "Thu, 01 Jan 2026 00:00:00 GMT".into()),
        ("content-type".into(), reply.try_get("contentType").map_or("text/event-stream", |c| c.as_str()).to_owned()),
    ];
    if let Some(extra) = reply.try_get("headers") {
        for (name, value) in extra.entries() {
            let value = value.as_str().to_owned();
            match headers.iter_mut().find(|(known, _)| known.eq_ignore_ascii_case(name)) {
                Some(slot) => slot.1 = value,
                None => headers.push((name.clone(), value)),
            }
        }
    }
    let has = |name: &str| headers.iter().any(|(known, _)| known.eq_ignore_ascii_case(name));
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in &headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has("connection") {
        head.push_str(if keep_alive { "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n" } else { "Connection: close\r\n" });
    }
    let chunks = reply.try_get("chunks").map(|c| c.as_array().iter().map(bytes_of).collect::<Vec<_>>());
    let body = reply.try_get("body").map(bytes_of).unwrap_or_default();
    let bodiless = status == 204 || status == 304;
    match &chunks {
        Some(_) if !has("content-length") && !bodiless => head.push_str("Transfer-Encoding: chunked\r\n"),
        None if !has("content-length") && !bodiless => head.push_str(&format!("Content-Length: {}\r\n", body.len())),
        _ => {}
    }
    head.push_str("\r\n");
    let chunked = chunks.is_some() && !has("content-length");
    if socket.write_all(head.as_bytes()).await.is_err() {
        return false;
    }
    match chunks {
        Some(chunks) => {
            for chunk in chunks {
                let framed = if chunked {
                    let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
                    framed.extend_from_slice(&chunk);
                    framed.extend_from_slice(b"\r\n");
                    framed
                } else {
                    chunk
                };
                if socket.write_all(&framed).await.is_err() || socket.flush().await.is_err() {
                    return false;
                }
            }
            if reply.try_get("hold").is_some_and(|h| h == &Exact::Bool(true)) {
                // Held open until the client closes the connection; that close is part of the record.
                let mut sink = [0u8; 4096];
                while matches!(socket.read(&mut sink).await, Ok(n) if n > 0) {}
                let mut state = inner.state.lock().unwrap();
                if let Exact::Object(entries) = &mut state.arrivals[index] {
                    entries.push(("clientClosedConnection".into(), Exact::Bool(true)));
                }
                drop(state);
                inner.bump();
                return false;
            }
            if chunked && socket.write_all(b"0\r\n\r\n").await.is_err() {
                return false;
            }
        }
        None => {
            if !bodiless && socket.write_all(&body).await.is_err() {
                return false;
            }
        }
    }
    socket.flush().await.is_ok()
}

/// One WebSocket connection: the upgrade request is noted, then the connection follows the commands of the script.
async fn websocket(inner: Arc<Inner>, mut socket: TcpStream, head: Head, early: Vec<u8>) {
    assert!(early.is_empty(), "the client sent nothing before the upgrade was answered");
    let (commands, mut received) = mpsc::unbounded_channel();
    let conn = {
        let mut state = inner.state.lock().unwrap();
        state.ws_conns.push(commands);
        state.ws_conns.len() - 1
    };
    let note = |entry: Exact| inner.note(entry, Some(conn));
    note(obj(vec![
        ("event", text("upgrade-request")),
        ("method", text(head.method.clone())),
        ("target", text(head.target.clone())),
        ("httpVersion", text(format!("1.{}", head.version))),
        ("headers", Exact::Array(head.headers.iter().map(|(n, v)| Exact::Array(vec![text(n.clone()), text(v.clone())])).collect())),
    ]));
    let Some(first) = received.recv().await else { return };
    let extra = match first {
        WsCommand::Accept(extra) => extra,
        WsCommand::Refuse { status, status_text, headers, body_chunks } => {
            note(obj(vec![
                ("event", text("upgrade-refused")),
                ("status", Exact::Number(f64::from(status))),
                ("statusText", text(status_text.clone())),
                ("headers", Exact::Array(headers.iter().map(|(n, v)| Exact::Array(vec![text(n.clone()), text(v.clone())])).collect())),
                ("bodyChunks", Exact::Array(body_chunks.iter().map(|c| body_of(c.clone())).collect())),
            ]));
            let length: usize = body_chunks.iter().map(Vec::len).sum();
            let mut lines = vec![format!("HTTP/1.1 {status} {status_text}")];
            lines.extend(headers.iter().map(|(n, v)| format!("{n}: {v}")));
            lines.push(format!("content-length: {length}"));
            lines.push("connection: close".into());
            let _ = socket.write_all(format!("{}\r\n\r\n", lines.join("\r\n")).as_bytes()).await;
            for chunk in body_chunks {
                let _ = socket.write_all(&chunk).await;
                let _ = socket.flush().await;
            }
            let _ = socket.shutdown().await;
            return;
        }
        WsCommand::Reset => {
            note(obj(vec![("event", text("upgrade-reset"))]));
            let _ = socket2::SockRef::from(&socket).set_linger(Some(Duration::ZERO));
            return;
        }
        WsCommand::LeaveUnanswered => {
            note(obj(vec![("event", text("upgrade-left-unanswered"))]));
            let mut sink = [0u8; 1024];
            while matches!(socket.read(&mut sink).await, Ok(n) if n > 0) {}
            return;
        }
        _ => panic!("ws script: the first action on a connection answers its upgrade"),
    };
    let key = head.get("sec-websocket-key").expect("a Sec-WebSocket-Key").to_owned();
    let mut lines = vec![
        "HTTP/1.1 101 Switching Protocols".to_owned(),
        "Upgrade: websocket".to_owned(),
        "Connection: Upgrade".to_owned(),
        format!("Sec-WebSocket-Accept: {}", derive_accept_key(key.as_bytes())),
    ];
    lines.extend(extra);
    note(obj(vec![("event", text("upgrade-response")), ("lines", Exact::Array(lines.iter().map(|l| text(l.clone())).collect()))]));
    if socket.write_all(format!("{}\r\n\r\n", lines.join("\r\n")).as_bytes()).await.is_err() {
        return;
    }
    let mut ws = WebSocketStream::from_raw_socket(socket, Role::Server, None).await;
    note(obj(vec![("event", text("open"))]));
    let mut server_initiated = false;
    let closed = |server_initiated: bool, code: u16, reason: String| {
        obj(vec![
            ("event", text("closed")),
            ("serverInitiated", Exact::Bool(server_initiated)),
            ("code", Exact::Number(f64::from(code))),
            ("reason", text(reason)),
        ])
    };
    loop {
        tokio::select! {
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Text(t))) => note(obj(vec![("event", text("frame")), ("dir", text("client->server")), ("text", text(t.as_str()))])),
                Some(Ok(Message::Binary(b))) => note(obj(vec![
                    ("event", text("frame")),
                    ("dir", text("client->server")),
                    ("binary", Exact::Bool(true)),
                    ("bytesHex", text(hex_encode(&b))),
                ])),
                Some(Ok(Message::Ping(d))) => note(obj(vec![("event", text("ping")), ("dir", text("client->server")), ("data", text(String::from_utf8_lossy(&d)))])),
                Some(Ok(Message::Pong(d))) => note(obj(vec![("event", text("pong")), ("dir", text("client->server")), ("data", text(String::from_utf8_lossy(&d)))])),
                Some(Ok(Message::Close(frame))) => {
                    // The closing handshake completes (tungstenite answers the close); `ws` then reports `close`.
                    while let Some(Ok(_)) = ws.next().await {}
                    let (code, reason) = frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                    note(closed(server_initiated, code, reason));
                    return;
                }
                Some(Ok(Message::Frame(_))) => {}
                Some(Err(error)) => {
                    note(obj(vec![("event", text("socket-error")), ("message", text(error.to_string())), ("code", Exact::Null)]));
                    note(closed(server_initiated, 1006, String::new()));
                    return;
                }
                None => {
                    note(closed(server_initiated, 1006, String::new()));
                    return;
                }
            },
            command = received.recv() => match command {
                Some(WsCommand::Send(message)) => {
                    let entry = match &message {
                        Message::Text(t) => obj(vec![("event", text("frame")), ("dir", text("server->client")), ("text", text(t.as_str()))]),
                        Message::Binary(b) => obj(vec![
                            ("event", text("frame")),
                            ("dir", text("server->client")),
                            ("binary", Exact::Bool(true)),
                            ("bytesHex", text(hex_encode(b))),
                        ]),
                        Message::Ping(d) => obj(vec![("event", text("ping")), ("dir", text("server->client")), ("data", text(String::from_utf8_lossy(d)))]),
                        _ => unreachable!("the script sends frames and pings"),
                    };
                    note(entry);
                    let _ = ws.send(message).await;
                }
                Some(WsCommand::Close(code, reason)) => {
                    server_initiated = true;
                    note(obj(vec![("event", text("close-sent")), ("by", text("server")), ("code", Exact::Number(f64::from(code))), ("reason", text(reason.clone()))]));
                    let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                }
                Some(WsCommand::Terminate) => {
                    server_initiated = true;
                    note(obj(vec![("event", text("terminate")), ("by", text("server"))]));
                    // The connection ends without a close frame once every frame written is flushed (`socket.end()`).
                    let _ = ws.flush().await;
                    let _ = ws.get_mut().shutdown().await;
                }
                Some(_) => panic!("ws script: an upgrade answer on an open connection"),
                None => return,
            },
        }
    }
}

/// The endpoint against the core's own link: a recorded request's caller headers (those before the ones `fetch` adds)
/// and body, sent by the production `ReqwestLink` to the recorded origin, arrive whole as Node's did (after the declared
/// rules), and the scripted chunks come back as the recorder's endpoint wrote them.
#[tokio::test(start_paused = true)]
async fn the_endpoint_serves_and_records_the_core_link_as_the_recorder_did() {
    use mixdog_ai::transport::HttpSend;
    use mixdog_ai::transport::ReqwestLink;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::WireRequest;
    const FETCH_OWN: [&str; 6] = ["host", "connection", "accept-language", "sec-fetch-mode", "accept-encoding", "content-length"];
    let set = CaseSet::load("anthropic-stream");
    let case = &set.cases[0];
    let recorded = &case.requests[0];
    let endpoint = Endpoint::start().await;
    endpoint.serve(case);
    let headers = recorded
        .get("headers")
        .as_array()
        .iter()
        .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
        .filter(|(name, _)| !FETCH_OWN.contains(&name.to_ascii_lowercase().as_str()))
        .collect();
    let request = WireRequest {
        transport: TransportKind::Http1,
        method: recorded.get("method").as_str().to_owned(),
        url: format!("{}{}", recorded.get("origin").as_str(), recorded.get("path").as_str()),
        headers,
        body: bytes_of(recorded.get("body")),
    };
    let link = endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link"));
    let mut response = within("the scripted answer", link.send(request, mixdog_ai::transport::deadlines::MODEL_STREAM))
        .await
        .expect("answered");
    let mut body = Vec::new();
    while let Some(chunk) = within("a body chunk", response.body.next()).await {
        body.extend_from_slice(&chunk.expect("a chunk"));
    }
    let chunks: Vec<u8> = recorded.get("reply").get("chunks").as_array().iter().flat_map(bytes_of).collect();
    assert_eq!(String::from_utf8_lossy(&body), String::from_utf8_lossy(&chunks));
    set.assert_requests(case, &endpoint.arrivals(), None);
}

/// The WebSocket side against the core's own dialer: a recorded refusal (`openai-ws-handshake`) is served as the world
/// served it, the dialer reads it as the refusal, and the replay's trace has the recorded entries in order.
#[tokio::test(start_paused = true)]
async fn the_endpoint_follows_a_recorded_ws_trace_against_the_core_dialer() {
    use mixdog_ai::transport::WsDial;
    use mixdog_ai::transport::ws::CallerHeaders;
    use mixdog_ai::transport::ws::ConnectError;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let set = CaseSet::load("openai-ws-handshake");
    let case = set.case("non-json-body-keeps-status-and-headers");
    let events = case.result().get("events").as_array().to_vec();
    let upgrade = events.iter().find(|e| e.get("event").as_str() == "upgrade-request").expect("an upgrade");
    let caller: Vec<(String, String)> = upgrade
        .get("headers")
        .as_array()
        .iter()
        .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
        .take_while(|(name, _)| name != "Sec-WebSocket-Version")
        .collect();
    let endpoint = Endpoint::start().await;
    endpoint.ws_script(&events);
    let mut request = format!("wss://chatgpt.com{}", upgrade.get("target").as_str()).into_client_request().expect("a request");
    request.extensions_mut().insert(CallerHeaders(caller));
    let dialer = endpoint.dialer(KeepaliveSchedule::SPEC);
    let refused = within("the refused upgrade", dialer.dial(request)).await;
    let Err(ConnectError::Rejected(response)) = refused else { panic!("the upgrade is refused") };
    assert_eq!(response.status().as_u16(), 403);
    assert_exact("ws trace", &Exact::Array(events), &Exact::Array(endpoint.trace()));
}

/// Every provider set's recording decodes, and each case holds what the driver reads.
#[test]
fn every_provider_recording_loads() {
    let mut loaded = Vec::new();
    for name in mixdog_testkit::entry_names(fixtures()) {
        let name = name.to_string_lossy().into_owned();
        let Some(set) = name.strip_prefix("provider-") else { continue };
        if !mixdog_testkit::exists(fixtures().join(&name).join("cases.json")) {
            continue;
        }
        let cases = CaseSet::load(set);
        for case in &cases.cases {
            for request in &case.requests {
                request.get("reply");
            }
            // One running clock per set: each step starts where the set's previous step ended.
            let mut at = case.clock_origin_ms;
            for step in &case.clock {
                assert_eq!((step.from_ms, step.from_ms + step.advance_ms), (at, step.to_ms), "{set} {}: clock step", case.id);
                at = step.to_ms;
            }
        }
        loaded.push((set.to_owned(), cases.cases.len()));
    }
    assert!(loaded.iter().any(|(set, n)| set == "anthropic-stream" && *n == 11), "{loaded:?}");
}
