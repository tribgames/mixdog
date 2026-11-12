//! The shared case driver of the provider replays: one scripted loopback endpoint and one reader for every set under
//! `native/core/fixtures/provider-<set>/` (recorded by `benchmarks/rust-core/recorders/record-<set>.mjs` through
//! `lib/provider-case-recorder.mjs` and `lib/ws-world.mjs`). A set's replay drives the product's real entry over the
//! core's own HTTP client or WebSocket dialer, redirected here, and compares what the recording holds, whole and in order.
//!
//! API (a set uses these and nothing else of the endpoint):
//! - [`CaseSet::load`]`(set)` reads `cases.json` and `MANIFEST.json` at run time (decoded with `mixdog_testkit::exact`);
//!   [`CaseSet::case`]`(id)` gives a [`Case`]: `input`, `outcome` (result or error), `calls` (`$shared` arguments
//!   resolved), `requests` (each as it arrived, with its scripted `reply`), `clock` (the recorded advances). A recorded
//!   property the driver does not read fails the load.
//! - [`Case::recorded`]: the outcome (Node's result, or the error it threw) as a [`Recorded`] value. Reading it marks
//!   nothing; only a comparison the driver itself makes does, and it marks exactly the path it compared whole:
//!   [`Recorded::assert_eq`] (the replay hands in the core's actual; the manifest's exclusion lines are the only members
//!   left out, at any depth), [`Recorded::assert_json`] (the same, an `undefined` member as its absence),
//!   [`Recorded::assert_filtered`] (an array less the items of a kind a named exclusion line declares) and
//!   [`Recorded::assert_error`] (an error, every field through `ERROR_FIELDS`). Dropping the set fails the test, naming
//!   them, when a case was not compared or has a recorded property no comparison covered (a path is covered by a
//!   comparison of it or of what holds it, or by a manifest exclusion), unless the case was named
//!   [`CaseSet::not_replayed`] with the reason (another group's branch replays it). A set has one replay test, so its
//!   own drop holds every case: no run depends on another test having run.
//! - [`Replay`]: every replay module lists its test functions in its `REPLAYS`; a set whose replay compared every case is
//!   registered at run time when the set is dropped, and `every_provider_set_has_a_comparing_replay` runs the listed
//!   entries and fails naming each recorded set no entry compared.
//! - [`CaseSet::excludes`]`(name)`: the one way a replay leaves a recorded property out: a manifest exclusion line
//!   ``` `name` is not compared: <reason> ``` (a bare property name holds at any depth).
//! - [`RecorderDraws`]: the recording process's random bytes, uuids and `Math.random`, computed as the recorders draw them,
//!   to script the core's random sources (`mixdog_ai::random`); a replay that scripts them runs under
//!   `mixdog_ai::random::run_scoped` (its runtime, paused by `tokio::time::pause()`), whose threads alone see the scripts.
//! - [`Endpoint::start`] opens the endpoint (plain HTTP/1.1 and WebSocket on 127.0.0.1) and holds the paused clock for
//!   its lifetime: run the test as `#[tokio::test(start_paused = true)]` (current-thread); time then moves only by
//!   [`Endpoint::advance`] with a recorded step, never by tokio's auto-advance; [`Endpoint::assert_clock`] compares the
//!   steps taken with the recorded ones.
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
//! - [`Endpoint::body`]`(k)`: what the product did with the k-th response's body through that link (reads begun, its end
//!   reached, dropped), so a clocked replay gates each recorded step with [`Endpoint::until`] on where the product waits
//!   (a read pending under a window; a dropped body before a retry wait), as the recorder gated it on its pending timers.
//! - [`Endpoint::arrivals`]: each request as it arrived, in the recorded shape (method, origin, path, every header in
//!   arrival order and case, body bytes; `clientClosedConnection` when a held response saw the client close).
//!   A `HEAD` is the core's socket warm-up (`preconnect`, http-agent.mjs:496-527), a raw `undici.request` the
//!   recorders' `fetch` redirect never saw: answered `200` empty, never scripted, and kept apart in
//!   [`Endpoint::warmups`].
//! - [`T0_MS`]` + `[`Endpoint::now_ms`]: the recorders' `Date.now()`, for `mixdog_ai::wall::set` where the product
//!   stamps wall time into its result.
//! - [`CaseSet::assert_requests`]`(case, arrivals, either_order)`: whole and in order, after the manifest's declared rules
//!   only: `host` as the addressed origin's host (or `127.0.0.1:<port>`), the `x-stainless-*` recording-host placeholders,
//!   a `Content-Encoding: gzip` body as its gzip header and inflated bytes, and one declared either-order pair of
//!   request indexes.
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
use mixdog_ai::transport::redirect::BodyEvent;
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

/// The recorders' `Date.now()` at running-clock 0 (`T0`, provider-case-recorder.mjs: `2026-11-09T12:00:00Z`).
pub const T0_MS: u64 = 1_794_225_600_000;

/// The recorders' `process.pid` (provider-case-recorder.mjs: `installDeterministicWorld({ pid: 4242 })`).
pub const RECORDER_PID: u32 = 4242;

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
    outcome: Outcome,
    pub calls: Vec<Call>,
    /// Each request as it arrived, with the `reply` the endpoint answered it with.
    pub requests: Vec<Exact>,
    pub clock: Vec<ClockStep>,
    /// The set's running clock when the case began: where the set's previous recorded step ended (0 for none).
    pub clock_origin_ms: u64,
    /// The paths of each case's outcome a comparison covered (shared with the set, see [`CaseSet`]'s drop).
    compared: Marks,
    /// The set manifest's exclusion lines, which a whole comparison leaves out ([`Recorded::assert_eq`]).
    exclusions: Arc<Vec<String>>,
}

/// Per case id, the outcome paths a comparing call marked (`""`: the whole outcome).
type Marks = Arc<Mutex<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>>>;

impl Case {
    /// What Node's call returned (or the error it threw), as a recorded value to compare: reading it marks nothing.
    pub fn recorded(&self) -> Recorded<'_> {
        let value = match &self.outcome {
            Outcome::Result(value) | Outcome::Error(value) => value,
        };
        Recorded { case: self, path: String::new(), value }
    }

    /// Whether Node's call threw.
    pub fn threw(&self) -> bool {
        matches!(self.outcome, Outcome::Error(_))
    }

    fn mark(&self, path: &str) {
        self.compared.lock().unwrap().entry(self.id.clone()).or_default().insert(path.to_owned());
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
    exclusions: Arc<Vec<String>>,
    /// `clockStartMs` of the recording, where the recorder wrote one: its `T0`.
    pub clock_start_ms: Option<u64>,
    /// The paths of each case's outcome a comparison covered.
    compared: Marks,
    /// The cases named [`CaseSet::not_replayed`], each with its reason: recorded, not compared.
    skipped: Mutex<Vec<(String, String)>>,
    /// Whether dropping the set checks that every case was compared (a replay's set), or not (the driver's own checks).
    checked: bool,
}

/// The keys a recording may hold at each level; a key outside them fails the load, so nothing recorded is passed over.
const RECORDING_KEYS: [&str; 5] = ["set", "nodeCommit", "shared", "cases", "clockStartMs"];
const CASE_KEYS: [&str; 8] = ["id", "source", "input", "result", "error", "calls", "requests", "clock"];
const STEP_KEYS: [&str; 4] = ["advanceMs", "fromMs", "toMs", "fired"];
const FIRED_KEYS: [&str; 1] = ["dueMs"];
const CALL_KEYS: [&str; 2] = ["entry", "args"];
/// What [`Endpoint::serve`] answers with; a reply key outside them fails the serve.
const REPLY_KEYS: [&str; 9] = ["status", "contentType", "headers", "body", "chunks", "hold", "destroy", "later", "reset"];
/// The keys of a `later` chunk: written on the held response once the recorded step `afterStep` was taken.
const LATER_KEYS: [&str; 2] = ["afterStep", "chunk"];

/// The connection faults of `record-gemini-send-retry.mjs`: a closed loopback port (`CLOSED_PORT`) and a loopback listener
/// that resets the connection on the client's TLS hello (`TLS_PORT`).
pub const CLOSED_PORT: u16 = 47652;
pub const TLS_PORT: u16 = 47651;

#[track_caller]
fn known_keys(what: &str, value: &Exact, known: &[&str]) {
    let unknown: Vec<&str> = value.entries().iter().map(|(k, _)| k.as_str()).filter(|k| !known.contains(k)).collect();
    assert!(unknown.is_empty(), "{what}: recorded properties the driver does not read: {unknown:?}");
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
    /// `set` without its `provider-` prefix, e.g. `anthropic-stream`. Dropping the set fails the test when a case's outcome
    /// was never read ([`Case::outcome`] / [`Case::result`]) and the replay did not name it [`CaseSet::not_replayed`].
    pub fn load(set: &str) -> Self {
        let dir = fixtures().join(format!("provider-{set}"));
        Self::from_recording(set, Exact::load(dir.join("MANIFEST.json")), Exact::load(dir.join("cases.json")), true)
    }

    /// The set for the driver's own structural checks: no case needs to be consumed.
    fn read(set: &str) -> Self {
        let mut loaded = Self::load(set);
        loaded.checked = false;
        loaded
    }

    /// The set of `recording` (a `cases.json`) under `manifest`; every recorded property is one the driver reads, else the
    /// load fails naming it.
    fn from_recording(set: &str, manifest: Exact, recording: Exact, checked: bool) -> Self {
        known_keys(&format!("{set}: the recording"), &recording, &RECORDING_KEYS);
        assert_eq!(recording.get("set").as_str(), format!("provider-{set}"), "{set}: the recording's set");
        assert_eq!(recording.get("set"), manifest.get("set"), "{set}: the manifest's set");
        assert_eq!(recording.get("nodeCommit"), manifest.get("product").get("commit"), "{set}: the recording's Node commit");
        let clock_start_ms = recording.try_get("clockStartMs").map(ms);
        if let Some(start) = clock_start_ms {
            assert_eq!(start, T0_MS, "{set}: clockStartMs is the recorders' T0");
        }
        let shared = recording.try_get("shared").map(|s| s.as_array().to_vec()).unwrap_or_default();
        let compared: Marks = Arc::default();
        let exclusions: Arc<Vec<String>> = Arc::new(match manifest.try_get("exclusions") {
            Some(Exact::Array(items)) => items.iter().map(|e| e.as_str().to_owned()).collect(),
            _ => Vec::new(),
        });
        let mut running_ms = 0;
        let cases = recording
            .get("cases")
            .as_array()
            .iter()
            .map(|case| {
                let id = case.get("id").as_str().to_owned();
                known_keys(&format!("{set} {id}"), case, &CASE_KEYS);
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
                            .map(|step| {
                                known_keys(&format!("{set} {id}: a clock step"), step, &STEP_KEYS);
                                ClockStep {
                                    advance_ms: ms(step.get("advanceMs")),
                                    from_ms: ms(step.get("fromMs")),
                                    to_ms: ms(step.get("toMs")),
                                    fired: step
                                        .get("fired")
                                        .as_array()
                                        .iter()
                                        .map(|f| {
                                            known_keys(&format!("{set} {id}: a fired timer"), f, &FIRED_KEYS);
                                            ms(f.get("dueMs"))
                                        })
                                        .collect(),
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let clock_origin_ms = running_ms;
                if let Some(last) = clock.last() {
                    running_ms = last.to_ms;
                }
                Case {
                    source: case.get("source").as_str().to_owned(),
                    input: case.get("input").clone(),
                    outcome,
                    calls: case
                        .try_get("calls")
                        .map(|calls| {
                            calls
                                .as_array()
                                .iter()
                                .map(|call| {
                                    known_keys(&format!("{set} {id}: a call"), call, &CALL_KEYS);
                                    Call {
                                        entry: call.get("entry").as_str().to_owned(),
                                        args: call.get("args").as_array().iter().map(|arg| unshare(arg, &shared)).collect(),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    requests: case.try_get("requests").map(|r| r.as_array().to_vec()).unwrap_or_default(),
                    clock,
                    clock_origin_ms,
                    compared: compared.clone(),
                    exclusions: exclusions.clone(),
                    id,
                }
            })
            .collect();
        Self { set: set.to_owned(), manifest, cases, exclusions, clock_start_ms, compared, checked, skipped: Mutex::default() }
    }

    /// Names cases no replay of this branch compares, with the reason (another group's branch replays them). They are
    /// not covered: the set's drop keeps each with its reason apart from the compared sets ([`SKIPPED_SETS`]), prints
    /// them, and registers a set holding any as not wholly compared. Every id must be one of the set's. The set's one
    /// replay names them: a set is never split over several tests of this branch.
    pub fn not_replayed(&self, ids: &[&str], reason: &str) {
        assert!(!reason.trim().is_empty(), "{}: a reason for {ids:?}", self.set);
        let mut skipped = self.skipped.lock().unwrap();
        for id in ids {
            assert!(self.cases.iter().any(|c| c.id == *id), "{}: no case {id}", self.set);
            skipped.push(((*id).to_owned(), reason.to_owned()));
        }
    }

    fn is_skipped(&self, id: &str) -> bool {
        self.skipped.lock().unwrap().iter().any(|(skipped, _)| skipped == id)
    }

    /// Whether the manifest declares `name` (a recorded property) not compared: an exclusion line reading
    /// ``` `name` is not compared: <reason> ```. The one way a replay leaves a recorded property out.
    pub fn excludes(&self, name: &str) -> bool {
        excluded(&self.exclusions, name)
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
        let (want, got_inflated): (Vec<Exact>, Vec<Exact>) = if self.declares("`Content-Encoding: gzip`") {
            (want.iter().map(inflated).collect(), got.iter().map(inflated).collect())
        } else {
            (want, got.clone())
        };
        got = got_inflated;
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

impl CaseSet {
    /// The recorded cases no comparison touched, and per other case the recorded properties of its outcome no comparison
    /// covered (by its path or a path holding it) and no manifest exclusion declares.
    fn uncovered(&self) -> (Vec<String>, Vec<(String, Vec<String>)>) {
        let marks = self.compared.lock().unwrap();
        let mut untouched = Vec::new();
        let mut partial = Vec::new();
        for case in self.cases.iter().filter(|case| !self.is_skipped(&case.id)) {
            let Some(marked) = marks.get(&case.id) else {
                untouched.push(case.id.clone());
                continue;
            };
            let mut missing = Vec::new();
            uncovered_paths(case.recorded().value, "", "", marked, &|generic| self.excludes(generic), &mut missing);
            if !missing.is_empty() {
                partial.push((case.id.clone(), missing));
            }
        }
        (untouched, partial)
    }
}

/// Whether the exclusion lines declare `name` not compared: a line ``` `<name>` is not compared: <reason> ```, or one
/// naming the last segments of `name` (a bare property name holds wherever the property is recorded:
/// `sends[].result.stopDetails` under `` `stopDetails` ``).
fn excluded(exclusions: &[String], name: &str) -> bool {
    exclusions.iter().any(|line| {
        line.strip_prefix('`')
            .and_then(|rest| rest.split_once("` is not compared: "))
            .is_some_and(|(declared, _)| declared == name || name.ends_with(&format!(".{declared}")))
    })
}

/// Whether `item` is of the kind the exclusion line `exclusion` declares not compared. Each line a replay filters by is
/// read here, once; a line this does not know fails.
fn excluded_kind(exclusion: &str, item: &Exact) -> bool {
    match exclusion {
        // `onStreamDelta('transport')`: the delta kinds Node recorded as strings.
        "onStreamDelta('transport')" => item.as_str() == "transport",
        // The stage the run loop raises when a stream opens: `streaming`, and no other.
        "streaming stages" => item.try_get("stage").is_some_and(|stage| stage.as_str() == "streaming"),
        other => panic!("no kind is known for the exclusion `{other}`"),
    }
}

/// `path` with every array index written `[]`, as an exclusion line names it.
fn generic_of(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut in_index = false;
    for c in path.chars() {
        match c {
            '[' => {
                in_index = true;
                out.push('[');
            }
            ']' => {
                in_index = false;
                out.push(']');
            }
            _ if in_index => {}
            other => out.push(other),
        }
    }
    out
}

/// `value` (at `generic`) without the members the exclusion lines declare not compared, at any depth.
fn without_excluded(value: &Exact, generic: &str, exclusions: &[String]) -> Exact {
    let child = |key: &str| if generic.is_empty() { key.to_owned() } else { format!("{generic}.{key}") };
    match value {
        Exact::Object(entries) => Exact::Object(
            entries
                .iter()
                .filter(|(key, _)| !excluded(exclusions, &child(key)))
                .map(|(key, inner)| (key.clone(), without_excluded(inner, &child(key), exclusions)))
                .collect(),
        ),
        Exact::Array(items) => Exact::Array(items.iter().map(|item| without_excluded(item, &format!("{generic}[]"), exclusions)).collect()),
        other => other.clone(),
    }
}

/// `JSON.stringify`'s view of a value: an object member holding `undefined` is not written.
fn json_form(value: &Exact) -> Exact {
    match value {
        Exact::Object(entries) => Exact::Object(entries.iter().filter(|(_, v)| *v != Exact::Undefined).map(|(k, v)| (k.clone(), json_form(v))).collect()),
        Exact::Array(items) => Exact::Array(items.iter().map(json_form).collect()),
        other => other.clone(),
    }
}

/// Whether `mark` is `path` or a path inside it (`""` holds every path).
fn within_path(mark: &str, path: &str) -> bool {
    path.is_empty() || mark == path || mark.strip_prefix(path).is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['))
}

/// The paths under `value` (at `path`; `generic` the same path with `[]` for every array index, as a manifest exclusion
/// names it) that no mark covers.
fn uncovered_paths(
    value: &Exact,
    path: &str,
    generic: &str,
    marks: &std::collections::BTreeSet<String>,
    excludes: &dyn Fn(&str) -> bool,
    out: &mut Vec<String>,
) {
    if marks.contains(path) || (!path.is_empty() && excludes(generic)) {
        return;
    }
    let child = |key: &str| if path.is_empty() { key.to_owned() } else { format!("{path}.{key}") };
    let child_generic = |key: &str| if generic.is_empty() { key.to_owned() } else { format!("{generic}.{key}") };
    match value {
        Exact::Object(entries) if !entries.is_empty() => {
            for (key, inner) in entries {
                uncovered_paths(inner, &child(key), &child_generic(key), marks, excludes, out);
            }
        }
        Exact::Array(items) if !items.is_empty() && marks.iter().any(|m| within_path(m, path)) => {
            for (i, inner) in items.iter().enumerate() {
                uncovered_paths(inner, &format!("{path}[{i}]"), &format!("{generic}[]"), marks, excludes, out);
            }
        }
        _ => out.push(if path.is_empty() { "(the outcome)".to_owned() } else { path.to_owned() }),
    }
}

/// The sets whose replay compared every case, registered when the set was dropped (see [`Replay`]).
static COMPARED_SETS: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());

/// The sets that ended with cases named [`CaseSet::not_replayed`]: per set, each skipped case and its reason. Such a set
/// is never in [`COMPARED_SETS`].
static SKIPPED_SETS: Mutex<std::collections::BTreeMap<String, Vec<(String, String)>>> = Mutex::new(std::collections::BTreeMap::new());

/// A replay's set fails when it ends with a recorded case no comparison touched, or with a recorded property of a case's
/// outcome no comparison covered, unless the case was named [`CaseSet::not_replayed`]; a set that skipped none is
/// registered as compared, one that skipped some is registered apart with the skipped cases and their reasons, and
/// they are printed.
impl Drop for CaseSet {
    fn drop(&mut self) {
        if !self.checked || std::thread::panicking() {
            return;
        }
        let (untouched, partial) = self.uncovered();
        assert!(untouched.is_empty(), "{}: recorded cases no replay compared: {untouched:?}", self.set);
        assert!(partial.is_empty(), "{}: recorded properties no comparison covered: {partial:?}", self.set);
        let skipped = self.skipped.lock().unwrap().clone();
        if skipped.is_empty() {
            COMPARED_SETS.lock().unwrap().insert(self.set.clone());
            return;
        }
        for (id, reason) in &skipped {
            eprintln!("NOT REPLAYED {} {id}: {reason}", self.set);
        }
        SKIPPED_SETS.lock().unwrap().insert(self.set.clone(), skipped);
    }
}

/// A recorded value of a case's outcome at its path (`""` the whole outcome, `key.inner`, `list[2]`). Reading it marks
/// nothing; each comparing call compares the core's actual with it whole and marks its path covered.
#[derive(Clone)]
pub struct Recorded<'c> {
    case: &'c Case,
    path: String,
    value: &'c Exact,
}

impl<'c> Recorded<'c> {
    /// The recorded value itself, to drive the replay or choose a comparison: marks nothing.
    pub fn raw(&self) -> &'c Exact {
        self.value
    }

    /// The path of this value in the outcome.
    pub fn path(&self) -> &str {
        &self.path
    }

    fn at(&self, key: &str, value: &'c Exact) -> Self {
        let path = if self.path.is_empty() { key.to_owned() } else { format!("{}.{key}", self.path) };
        Self { case: self.case, path, value }
    }

    /// The member `key` of a recorded object; panics naming the path when absent.
    pub fn get(&self, key: &str) -> Self {
        self.try_get(key).unwrap_or_else(|| panic!("{}: no recorded {key:?} at {:?}", self.case.id, self.path))
    }

    pub fn try_get(&self, key: &str) -> Option<Self> {
        self.value.try_get(key).map(|value| self.at(key, value))
    }

    /// The members of a recorded object, in recorded order.
    pub fn entries(&self) -> Vec<(&'c str, Self)> {
        self.value.entries().iter().map(|(key, value)| (key.as_str(), self.at(key, value))).collect()
    }

    /// The items of a recorded array, in order.
    pub fn items(&self) -> Vec<Self> {
        self.value
            .as_array()
            .iter()
            .enumerate()
            .map(|(i, value)| Self { case: self.case, path: format!("{}[{i}]", self.path), value })
            .collect()
    }

    /// The recorded value without the members the manifest declares not compared (at any depth below this path).
    fn declared(&self) -> Exact {
        without_excluded(self.value, &generic_of(&self.path), &self.case.exclusions)
    }

    /// `got` equals the recorded value whole, but for the members the manifest declares not compared; marks the path.
    /// The only lossy step is the manifest's own, which also covers what it leaves out.
    #[track_caller]
    pub fn assert_eq(&self, what: &str, got: &Exact) {
        assert_exact(what, &self.declared(), got);
        self.case.mark(&self.path);
    }

    /// As [`Recorded::assert_eq`], both sides as `JSON.stringify` writes them: an object member holding `undefined` is
    /// the member's absence (the product's value went to the wire as JSON); marks the path.
    #[track_caller]
    pub fn assert_json(&self, what: &str, got: &Exact) {
        assert_exact(what, &json_form(&self.declared()), &json_form(got));
        self.case.mark(&self.path);
    }

    /// A recorded array whose items of one kind the manifest declares not compared (`exclusion`, a line the manifest
    /// must hold): the items outside that kind, in order, equal `got` whole; marks the path. The kind is the driver's
    /// own reading of the named line ([`excluded_kind`]), never a predicate the replay brings, so nothing beyond what
    /// the line declares is left out.
    #[track_caller]
    pub fn assert_filtered(&self, what: &str, exclusion: &str, got: &Exact) {
        assert!(excluded(&self.case.exclusions, exclusion), "{what}: the manifest declares no `{exclusion}` exclusion");
        let kept = Exact::Array(self.declared().as_array().iter().filter(|item| !excluded_kind(exclusion, item)).cloned().collect());
        assert_exact(what, &kept, got);
        self.case.mark(&self.path);
    }

    /// A recorded error (an `Exact::Error`) against the core's, every field through `ERROR_FIELDS` as the table maps it
    /// (`replay_errors::compare_error`, or the error-contract set's own table comparison for an error built outside a
    /// send): a field the comparison does not know fails it. Marks the path once every field compared.
    #[track_caller]
    pub fn assert_error(&self, what: &str, core: ErrorSide<'_>) {
        match core {
            ErrorSide::Send(left) => crate::replay_errors::compare_error(what, self.value, left),
            ErrorSide::Contract(built) => crate::replay_gemini_error_contract::compare_error(what, self.value, built),
        }
        self.case.mark(&self.path);
    }
}

/// The core's side of a recorded error ([`Recorded::assert_error`]).
pub enum ErrorSide<'a> {
    /// What left the provider layer of a send.
    Send(&'a crate::replay_errors::Left<'a>),
    /// An error the Gemini error contract built from one response.
    Contract(&'a crate::replay_gemini_error_contract::Built),
}

/// One replay entry of a module's `REPLAYS`: the set it replays and its test function (a `#[tokio::test]` builds its own
/// runtime).
pub struct Replay {
    pub set: &'static str,
    pub run: fn(),
}

/// A request under the declared gzip rule: a `Content-Encoding: gzip` body as its 10-byte gzip header and inflated
/// bytes, its `content-length` as `<the arrived body's length>` (checked equal to that length here).
fn inflated(request: &Exact) -> Exact {
    let Exact::Object(entries) = request else { unreachable!("a request is an object") };
    let gzip = request.get("headers").as_array().iter().any(|pair| {
        let pair = pair.as_array();
        pair[0].as_str().eq_ignore_ascii_case("content-encoding") && pair[1].as_str() == "gzip"
    });
    if !gzip {
        return request.clone();
    }
    let Exact::Bytes { bytes, .. } = request.get("body") else { panic!("a gzip body is bytes: {request:?}") };
    let mut text = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes.as_slice()), &mut text).expect("a gzip body");
    let length = bytes.len().to_string();
    Exact::Object(
        entries
            .iter()
            .map(|(key, value)| match key.as_str() {
                "body" => (
                    key.clone(),
                    Exact::Object(vec![
                        ("gzipHeader".into(), Exact::String(format!("{:02x?}", &bytes[..10]))),
                        ("inflated".into(), Exact::String(String::from_utf8_lossy(&text).into_owned())),
                    ]),
                ),
                "headers" => (
                    key.clone(),
                    Exact::Array(
                        value
                            .as_array()
                            .iter()
                            .map(|pair| {
                                let pair = pair.as_array();
                                if pair[0].as_str().eq_ignore_ascii_case("content-length") {
                                    assert_eq!(pair[1].as_str(), length, "content-length is the arrived body's length");
                                    Exact::Array(vec![pair[0].clone(), Exact::String("<the arrived body's length>".into())])
                                } else {
                                    Exact::Array(pair.to_vec())
                                }
                            })
                            .collect(),
                    ),
                ),
                _ => (key.clone(), value.clone()),
            })
            .collect(),
    )
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
// The recorders' random source
// ---------------------------------------------------------------------------------------------------------------------

/// The draws the recording process made, computed as the recorders made them, never read from a recording: the world's
/// `crypto.randomBytes(n)` / `crypto.randomUUID()` (`lib/deterministic-world.mjs`: per kind, the n-th draw is the SHA-256 of
/// `"<kind> <n>"`, kinds `bytes <size>` and `uuid`) and `Math.random` (`lib/provider-case-recorder.mjs`, seed `0x2545f491`).
/// One per set, used across its cases in recorded order: the counters run over the whole recording process.
pub struct RecorderDraws {
    counts: std::collections::HashMap<String, u32>,
    seed: u32,
}

impl Default for RecorderDraws {
    fn default() -> Self {
        Self { counts: std::collections::HashMap::new(), seed: 0x2545_f491 }
    }
}

impl RecorderDraws {
    fn draw(&mut self, kind: &str, n: usize) -> Vec<u8> {
        use sha2::Digest as _;
        let mut out = Vec::new();
        while out.len() < n {
            let count = self.counts.entry(kind.to_owned()).or_default();
            *count += 1;
            out.extend_from_slice(&sha2::Sha256::digest(format!("{kind} {count}")));
        }
        out.truncate(n);
        out
    }

    /// `crypto.randomBytes(n)`.
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        self.draw(&format!("bytes {n}"), n)
    }

    /// The 16 bytes of `crypto.randomUUID()`: the world's hex with the version nibble `4` and the variant nibble `8`.
    pub fn uuid_bytes(&mut self) -> Vec<u8> {
        let mut bytes = self.draw("uuid", 16);
        bytes[6] = 0x40 | (bytes[6] & 0x0f);
        bytes[8] = 0x80 | (bytes[8] & 0x0f);
        bytes
    }

    /// `Math.random()`.
    pub fn math_random(&mut self) -> f64 {
        let x = self.seed ^ (self.seed >> 15);
        self.seed = x.wrapping_mul(0x2c1b_3c6d).wrapping_add(0x6d2b_79f5);
        f64::from(self.seed) / 4_294_967_296.0
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recorded errors
// ---------------------------------------------------------------------------------------------------------------------

pub use mixdog_testkit::provider_fields::ERROR_FIELDS;
pub use mixdog_testkit::provider_fields::error_field;
pub use mixdog_testkit::provider_fields::error_field_unread;
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
    warmups: Vec<Exact>,
    trace: Vec<Exact>,
    /// The connection of each trace entry (`None`: a case-side entry), for the script to address its actions.
    trace_conns: Vec<Option<usize>>,
    ws_conns: Vec<mpsc::UnboundedSender<WsCommand>>,
    /// The recorded `Sec-WebSocket-Key` of each upgrade, in order, for the dialer's scripted key source.
    ws_keys: std::collections::VecDeque<String>,
    steps: Vec<ClockStep>,
    /// What the product did with each response body the link returned, by response.
    bodies: Vec<Body>,
    /// The sends through the link that failed (a connection fault among them).
    failed: usize,
    /// The arrivals (by index) whose HTTP/2 stream the client has ended or reset.
    closed: std::collections::HashSet<usize>,
}

/// What the product did with one response body: reads begun, whether a read returned its end (or fault), whether it
/// was dropped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Body {
    pub reads: u32,
    pub ended: bool,
    pub dropped: bool,
}

struct Inner {
    state: Mutex<State>,
    /// The origin the link sends to instead of the endpoint (a connection fault of the case).
    fault_origin: Arc<Mutex<Option<String>>>,
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
    /// Opens the endpoint on 127.0.0.1 and holds the (paused) clock: no auto-advance while it lives. Local time is
    /// UTC for the process, as the recorders set `TZ=UTC` (`lib/provider-case-recorder.mjs:65`).
    pub async fn start() -> Self {
        let _ = mixdog_js::time::set_process_zone(mixdog_js::time::Tz::UTC);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the loopback endpoint");
        let addr = listener.local_addr().expect("its address");
        let inner = Arc::new(Inner { state: Mutex::new(State::default()), fault_origin: Arc::default(), events: watch::channel(0).0 });
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

    /// The recorders' `Date.now()` on the set's running clock now: `T0` (`lib/provider-case-recorder.mjs:42`,
    /// 2026-11-09T12:00:00Z) plus [`Endpoint::now_ms`].
    pub fn wall_now(&self) -> std::time::SystemTime {
        let t0 = mixdog_js::time::date_parse("2026-11-09T12:00:00Z") as u64;
        std::time::UNIX_EPOCH + Duration::from_millis(t0 + self.now_ms())
    }

    /// Scripts the HTTP side with the case's recorded replies: the k-th arrival is answered by `requests[k].reply`.
    pub fn serve(&self, case: &Case) {
        self.clock_at(case);
        for (k, request) in case.requests.iter().enumerate() {
            known_keys(&format!("{}: request {k}'s reply", case.id), request.get("reply"), &REPLY_KEYS);
        }
        self.inner.state.lock().unwrap().replies = case.requests.iter().map(|request| request.get("reply").clone()).collect();
    }

    /// The core's own link `inner` with every request redirected here.
    pub fn link<L>(&self, inner: L) -> Redirected<L> {
        let tapped = self.inner.clone();
        let tap = Arc::new(move |index: usize, event: BodyEvent| {
            {
                let mut state = tapped.state.lock().unwrap();
                if state.bodies.len() <= index {
                    state.bodies.resize(index + 1, Body::default());
                }
                let body = &mut state.bodies[index];
                match event {
                    BodyEvent::Read => body.reads += 1,
                    BodyEvent::Ended => body.ended = true,
                    BodyEvent::Dropped => body.dropped = true,
                }
            }
            tapped.bump();
        });
        let failing = self.inner.clone();
        let failed = Arc::new(move || {
            failing.state.lock().unwrap().failed += 1;
            failing.bump();
        });
        Redirected { inner, addr: self.addr, tap, returned: Arc::default(), fault_origin: self.inner.fault_origin.clone(), failed }
    }

    /// Every later send of the link fails as the case's recorded connection fault did (`input.fault` of
    /// `record-gemini-send-retry.mjs`): `refused` - a closed loopback port; `tls` - a loopback listener that resets the
    /// connection on the client's TLS hello. The sends that failed so far: [`Endpoint::failed`].
    pub async fn connect_fault(&self, fault: &str) {
        let origin = match fault {
            "refused" => format!("http://127.0.0.1:{CLOSED_PORT}"),
            "tls" => {
                let listener = TcpListener::bind(("127.0.0.1", TLS_PORT)).await.expect("bind the TLS fault listener");
                tokio::spawn(async move {
                    while let Ok((mut socket, _)) = listener.accept().await {
                        let mut hello = [0u8; 1];
                        if matches!(socket.read(&mut hello).await, Ok(n) if n > 0) {
                            socket2::SockRef::from(&socket).set_linger(Some(Duration::ZERO)).expect("a reset on close");
                        }
                    }
                });
                format!("https://127.0.0.1:{TLS_PORT}")
            }
            other => panic!("a connection fault of the recorder: {other}"),
        };
        *self.inner.fault_origin.lock().unwrap() = Some(origin);
    }

    /// The sends through the link that failed so far.
    pub fn failed(&self) -> usize {
        self.inner.state.lock().unwrap().failed
    }

    /// Whether the client has ended or reset the HTTP/2 stream of the k-th arrival.
    pub fn stream_closed(&self, k: usize) -> bool {
        self.inner.state.lock().unwrap().closed.contains(&k)
    }

    /// What the product did with the k-th response body its link returned (none yet: the default).
    pub fn body(&self, k: usize) -> Body {
        self.inner.state.lock().unwrap().bodies.get(k).copied().unwrap_or_default()
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

    /// How many requests have arrived so far, read when a stage is delivered: the stage's place among the arrivals.
    pub fn arrival_probe(&self) -> Box<dyn Fn() -> usize + Send + Sync> {
        let inner = self.inner.clone();
        Box::new(move || inner.state.lock().unwrap().arrivals.len())
    }

    /// Each request as it arrived, in the recorded shape.
    pub fn arrivals(&self) -> Vec<Exact> {
        self.inner.state.lock().unwrap().arrivals.clone()
    }

    /// Each `HEAD` warm-up as it arrived (`{method, origin, path}`), apart from the requests.
    pub fn warmups(&self) -> Vec<Exact> {
        self.inner.state.lock().unwrap().warmups.clone()
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
        // Which timers fired is not observable on tokio's clock: the replay's step names none (see `assert_clock`).
        self.inner.state.lock().unwrap().steps.push(ClockStep { advance_ms: step.advance_ms, from_ms: from, to_ms: to, fired: Vec::new() });
        self.inner.bump();
    }

    /// The steps the replay took equal the case's recorded steps, whole and in order: each one's length, start and end on
    /// the set's running clock. The timers each step fired (`fired`) are compared once the core's test clock reports them
    /// (Lead decision: `core-test-clock`); until then the replay's steps name none and `fired` is left out here only.
    #[track_caller]
    pub fn assert_clock(&self, case: &Case) {
        let shape = |steps: &[ClockStep]| -> Vec<(u64, u64, u64)> { steps.iter().map(|s| (s.advance_ms, s.from_ms, s.to_ms)).collect() };
        assert_eq!(shape(&self.steps()), shape(&case.clock), "{}: the clock steps", case.id);
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

/// One HTTP/2 connection in clear text (a client with prior knowledge: the HTTP/2 twin of the recorders' h2c hub,
/// `lib/h2-world.mjs`): each stream is answered from the script like an HTTP/1 request.
async fn h2_connection(inner: Arc<Inner>, socket: TcpStream) {
    let Ok(mut connection) = h2::server::handshake(socket).await else { return };
    while let Some(Ok((request, respond))) = connection.accept().await {
        tokio::spawn(h2_stream(inner.clone(), request, respond));
    }
}

/// One stream, as the hub records it: the pseudo-headers first (`:method`, `:scheme`, `:authority`, `:path`: the scheme and
/// authority of the origin the product addressed, the order the recorder writes them in), then every header in arrival order
/// but the redirect's own; the body of a Connect stream is its first frame once whole, any other body whole.
async fn h2_stream(
    inner: Arc<Inner>,
    request: tokio_tungstenite::tungstenite::http::Request<h2::RecvStream>,
    mut respond: h2::server::SendResponse<bytes::Bytes>,
) {
    let (parts, mut body) = request.into_parts();
    let origin = parts.headers.get(ORIGIN_HEADER).expect("the redirect names the origin").to_str().expect("an origin").to_owned();
    let addressed = url::Url::parse(&origin).expect("an origin URL");
    let host = match addressed.port() {
        Some(port) => format!("{}:{port}", addressed.host_str().expect("a host")),
        None => addressed.host_str().expect("a host").to_owned(),
    };
    let path = parts.uri.path_and_query().map_or("/", |p| p.as_str()).to_owned();
    let mut headers = vec![
        (":method".to_owned(), parts.method.as_str().to_owned()),
        (":scheme".to_owned(), addressed.scheme().to_owned()),
        (":authority".to_owned(), host),
        (":path".to_owned(), path.clone()),
    ];
    for (name, value) in &parts.headers {
        // Declared (manifest exclusion on HTTP/2 streams): reqwest's client adds `accept: */*` and the `content-length` of a
        // whole body, and Node's `node:http2` adds no header of its own; those two are left out of the arrival.
        let library_default = (name.as_str() == "accept" && value.as_bytes() == b"*/*") || name.as_str() == "content-length";
        if name.as_str() != ORIGIN_HEADER && !library_default {
            headers.push((name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned()));
        }
    }
    const CONNECT: &[u8] = b"application/connect+proto";
    let connect = parts.headers.get("content-type").is_some_and(|v| v.as_bytes().windows(CONNECT.len()).any(|w| w == CONNECT));
    let mut raw = Vec::new();
    let mut whole = false;
    while let Some(Ok(chunk)) = body.data().await {
        let n = chunk.len();
        raw.extend_from_slice(&chunk);
        let _ = body.flow_control().release_capacity(n);
        if connect && raw.len() >= 5 {
            let frame = 5 + u32::from_be_bytes(raw[1..5].try_into().expect("4 bytes")) as usize;
            if raw.len() >= frame {
                raw.truncate(frame);
                whole = true;
                break;
            }
        }
    }
    let arrival = obj(vec![
        ("method", text(parts.method.as_str())),
        ("origin", text(origin)),
        ("path", text(path)),
        ("headers", Exact::Array(headers.into_iter().map(|(name, value)| Exact::Array(vec![text(name), text(value)])).collect())),
        ("body", body_of(raw)),
    ]);
    let (index, reply) = {
        let mut state = inner.state.lock().unwrap();
        state.arrivals.push(arrival);
        let index = state.arrivals.len() - 1;
        (index, state.replies.get(index).cloned())
    };
    inner.bump();
    // The rest of the request body (a run's heartbeats) is read and dropped: the stream is closed once the client ends or resets it.
    let watching = inner.clone();
    tokio::spawn(async move {
        if whole {
            while let Some(Ok(chunk)) = body.data().await {
                let _ = body.flow_control().release_capacity(chunk.len());
            }
        }
        watching.state.lock().unwrap().closed.insert(index);
        watching.bump();
    });
    let reply = reply.unwrap_or_else(|| {
        obj(vec![
            ("status", Exact::Number(404.0)),
            ("contentType", text("application/json")),
            ("body", text(r#"{"error":{"message":"not scripted"}}"#)),
        ])
    });
    for key in ["hold", "destroy", "later", "reset"] {
        assert!(reply.try_get(key).is_none(), "the h2 hub does not serve a reply's `{key}`");
    }
    let status = reply.try_get("status").map_or(200, |s| s.as_f64() as u16);
    // The recorder's hub writes `date` first, then `content-type` and the reply's headers.
    let mut response = tokio_tungstenite::tungstenite::http::Response::builder()
        .status(status)
        .header("date", "Thu, 01 Jan 2026 00:00:00 GMT")
        .header("content-type", reply.try_get("contentType").map_or("application/connect+proto", |c| c.as_str()));
    if let Some(extra) = reply.try_get("headers") {
        for (name, value) in extra.entries() {
            response = response.header(name.as_str(), value.as_str());
        }
    }
    let chunks: Vec<Vec<u8>> = match reply.try_get("chunks") {
        Some(chunks) => chunks.as_array().iter().map(bytes_of).collect(),
        None => reply.try_get("body").map(bytes_of).filter(|b| !b.is_empty()).into_iter().collect(),
    };
    let Ok(mut send) = respond.send_response(response.body(()).expect("a response head"), chunks.is_empty()) else { return };
    for chunk in chunks {
        if send.send_data(bytes::Bytes::from(chunk), false).is_err() {
            return;
        }
    }
    let _ = send.send_data(bytes::Bytes::new(), true);
}

/// One TCP connection: HTTP/1.1 requests answered from the script, a WebSocket upgrade, or HTTP/2 (the client's preface).
async fn connection(inner: Arc<Inner>, mut socket: TcpStream) {
    let mut preface = [0u8; 3];
    if matches!(socket.peek(&mut preface).await, Ok(3)) && &preface == b"PRI" {
        h2_connection(inner, socket).await;
        return;
    }
    let port = socket.peer_addr().map(|a| a.port()).unwrap_or_default();
    let mut buf = Vec::new();
    while let Some(head) = read_head(&mut socket, &mut buf).await {
        if head.get("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket")) {
            websocket(inner, socket, head, buf).await;
            return;
        }
        let Some(body) = read_body(&mut socket, &mut buf, &head).await else { return };
        let origin = head.get(ORIGIN_HEADER).map_or_else(|| format!("http://127.0.0.1:{port}"), str::to_owned);
        if head.method == "HEAD" {
            let warmup = obj(vec![("method", text(head.method.clone())), ("origin", text(origin)), ("path", text(head.target.clone()))]);
            inner.state.lock().unwrap().warmups.push(warmup);
            inner.bump();
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nConnection: close\r\n\r\n").await;
            return;
        }
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
    // `writeHead` stores the head before the body is known, so Node frames every answer in chunks unless the script
    // names its length.
    let chunked = !has("content-length") && !bodiless;
    if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
    }
    head.push_str("\r\n");
    let chunks = chunks.unwrap_or_else(|| if bodiless || body.is_empty() { Vec::new() } else { vec![body] });
    let hold = reply.try_get("hold").is_some_and(|h| h == &Exact::Bool(true));
    let reset = reply.try_get("reset").is_some_and(|r| r == &Exact::Bool(true));
    let later: Vec<(usize, Vec<u8>)> = reply.try_get("later").map_or_else(Vec::new, |later| {
        later
            .as_array()
            .iter()
            .map(|entry| {
                known_keys("a later chunk", entry, &LATER_KEYS);
                (entry.get("afterStep").as_f64() as usize, bytes_of(entry.get("chunk")))
            })
            .collect()
    });
    if socket.write_all(head.as_bytes()).await.is_err() {
        return false;
    }
    let frame = |chunk: Vec<u8>| {
        if chunked {
            let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
            framed.extend_from_slice(&chunk);
            framed.extend_from_slice(b"\r\n");
            framed
        } else {
            chunk
        }
    };
    for chunk in chunks {
        if socket.write_all(&frame(chunk)).await.is_err() || socket.flush().await.is_err() {
            return false;
        }
    }
    let mut events = inner.events.subscribe();
    for (after, chunk) in later {
        // Written on the held response once the recorded step `after` was taken, as the recorder wrote it.
        while inner.state.lock().unwrap().steps.len() <= after {
            if events.changed().await.is_err() {
                return false;
            }
        }
        if socket.write_all(&frame(chunk)).await.is_err() || socket.flush().await.is_err() {
            return false;
        }
    }
    if reset {
        // The recorder reset the connection once the product decoded the chunks: here once the product's read is pending
        // past them (the second read of this response's body; the k-th arrival's body is the k-th the link returned).
        while inner.state.lock().unwrap().bodies.get(index).map_or(0, |b| b.reads) < 2 {
            if events.changed().await.is_err() {
                return false;
            }
        }
        socket2::SockRef::from(&*socket).set_linger(Some(Duration::ZERO)).expect("a reset on close");
        // Node's endpoint saw the held response's connection close, as on a client's close.
        let mut state = inner.state.lock().unwrap();
        if let Exact::Object(entries) = &mut state.arrivals[index] {
            entries.push(("clientClosedConnection".into(), Exact::Bool(true)));
        }
        drop(state);
        inner.bump();
        return false;
    }
    if hold {
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
    let set = CaseSet::read("anthropic-stream");
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
    let set = CaseSet::read("openai-ws-handshake");
    let case = set.case("non-json-body-keeps-status-and-headers");
    let events = case.recorded().raw().get("events").as_array().to_vec();
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

/// Every field of every recorded error of the sets whose errors the table covers is in [`ERROR_FIELDS`] (a group adds
/// its sets here with its rows).
#[test]
fn every_recorded_error_field_is_in_the_table() {
    fn fields(value: &Exact, out: &mut Vec<String>) {
        match value {
            Exact::Error { code, cause, props, .. } => {
                out.extend(["name".to_owned(), "message".to_owned()]);
                if code.is_some() {
                    out.push("code".into());
                }
                if let Some(cause) = cause {
                    out.push("cause".into());
                    fields(cause, out);
                }
                for (key, prop) in props {
                    out.push(key.clone());
                    if key == "streamOutcome"
                        && let Exact::Object(outcome) = prop
                    {
                        out.extend(outcome.iter().map(|(field, _)| format!("streamOutcome.{field}")));
                    }
                    fields(prop, out);
                }
            }
            Exact::Array(items) => items.iter().for_each(|item| fields(item, out)),
            Exact::Object(entries) => entries.iter().for_each(|(_, item)| fields(item, out)),
            _ => {}
        }
    }
    const SETS: [&str; 25] = [
        "anthropic-api-key-fetch-rest",
        "anthropic-replay-blocks",
        "anthropic-server-fallback",
        "anthropic-stream",
        "anthropic-thinking-contract",
        "antigravity-request",
        "gemini-error-contract",
        "gemini-history-signatures",
        "gemini-stream",
        "devin-wire-protobuf",
        "devin-wire-request",
        "devin-wire-session",
        "leak-guards",
        "openai-oauth",
        "openai-oauth-transport",
        "openai-ws-connect",
        "openai-ws-delta",
        "openai-ws-handshake",
        "openai-ws-send-attempts",
        "openai-ws-stream",
        "transport-policy",
        "openai-compat-stream-lifecycle",
        "session-provider-replay",
        "gemini-send-retry",
        "retry-stages",
    ];
    let mut missing = Vec::new();
    for set in SETS {
        let loaded = CaseSet::read(set);
        for case in &loaded.cases {
            let mut found = Vec::new();
            fields(case.recorded().raw(), &mut found);
            missing.extend(found.into_iter().filter(|f| !ERROR_FIELDS.iter().any(|(name, _, _)| name == f)).map(|f| format!("{set} {}: {f}", case.id)));
        }
    }
    missing.dedup();
    assert!(missing.is_empty(), "error fields not in ERROR_FIELDS: {missing:?}");
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
        let cases = CaseSet::read(set);
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

/// The provider sets whose replay is another branch's (groups B, C, D and the sets no group replays yet), so that this
/// branch holds no replay of them; every other set has one here.
const REPLAYED_ELSEWHERE: &[&str] = &[
    "accounts-policy-cases", "admin-dev-providers", "auth-api", "change-effects", "compat-chat-stream-tool-calls",
    "compat-responses-alignment", "compat-responses-boundaries", "compat-responses-effort", "custom-provider-keys",
    "custom-provider-route", "custom-reasoning", "deepseek-replay", "devin-wire-protobuf", "devin-wire-request",
    "devin-wire-session", "gateways", "lane-settings", "local-context-settings", "local-managed-runtime", "mimo-oauth",
    "mimo-oauth-wire", "mixdog-local-wire", "model-catalog-projection", "model-recency", "openai-oauth",
    "openai-oauth-transport", "openai-ws-connect", "openai-ws-send-attempts", "openai-ws-stream", "opencode-go-gemini",
    "openrouter", "ready", "refusal", "setup", "setup-custom", "setup-warmup", "status", "tool-cut", "wire", "xai-grok",
];

/// Every module's replay entries ([`Replay`]), in one list.
fn registry() -> Vec<&'static Replay> {
    let lists: [&'static [Replay]; 17] = [
        crate::replay_anthropic_api_key_fetch::REPLAYS,
        crate::replay_anthropic_replay_blocks::REPLAYS,
        crate::replay_anthropic_server_fallback::REPLAYS,
        crate::replay_anthropic_stream::REPLAYS,
        crate::replay_anthropic_thinking_contract::REPLAYS,
        crate::replay_antigravity_request::REPLAYS,
        crate::replay_compat_stream_lifecycle::REPLAYS,
        crate::replay_gemini_error_contract::REPLAYS,
        crate::replay_gemini_history_signatures::REPLAYS,
        crate::replay_gemini_send_retry::REPLAYS,
        crate::replay_gemini_stream::REPLAYS,
        crate::replay_leak_guards::REPLAYS,
        crate::replay_openai_ws_delta::REPLAYS,
        crate::replay_openai_ws_handshake::REPLAYS,
        crate::replay_retry_stages::REPLAYS,
        crate::replay_session_provider_replay::REPLAYS,
        crate::replay_transport_policy::REPLAYS,
    ];
    lists.iter().flat_map(|list| list.iter()).collect()
}

/// The recorded provider sets (`native/core/fixtures/provider-<set>/cases.json`).
fn recorded_sets() -> Vec<String> {
    mixdog_testkit::entry_names(fixtures())
        .into_iter()
        .filter_map(|name| name.to_string_lossy().strip_prefix("provider-").map(str::to_owned))
        .filter(|set| mixdog_testkit::exists(fixtures().join(format!("provider-{set}")).join("cases.json")))
        .collect()
}

/// Runs every entry of `replays` (each on its own fresh process state) and returns the recorded sets no entry loaded and
/// compared whole (its set registered by its drop) and that [`REPLAYED_ELSEWHERE`] does not name.
fn uncompared(replays: &[&Replay], recorded: &[String]) -> Vec<String> {
    COMPARED_SETS.lock().unwrap().clear();
    SKIPPED_SETS.lock().unwrap().clear();
    for replay in replays {
        mixdog_ai::reset_process_state();
        (replay.run)();
    }
    let compared = COMPARED_SETS.lock().unwrap().clone();
    recorded.iter().filter(|set| !REPLAYED_ELSEWHERE.contains(&set.as_str()) && !compared.contains(*set)).cloned().collect()
}

/// The tests that read or clear the two registries run one at a time.
static REGISTRY_TESTS: Mutex<()> = Mutex::new(());

/// Cases recorded but not replayed in the sets of the last [`uncompared`] run: (set, case, reason).
fn skipped_cases() -> Vec<(String, String, String)> {
    SKIPPED_SETS
        .lock()
        .unwrap()
        .iter()
        .flat_map(|(set, cases)| cases.iter().map(move |(id, reason)| (set.clone(), id.clone(), reason.clone())))
        .collect()
}

/// Every recorded provider set has a replay here that loaded it and compared every case (registered at run time by the
/// set's drop), or is named in [`REPLAYED_ELSEWHERE`]; a set replayed here is not named there.
#[test]
fn every_provider_set_has_a_comparing_replay() {
    let _alone = REGISTRY_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let replays = registry();
    for replay in &replays {
        assert!(!REPLAYED_ELSEWHERE.contains(&replay.set), "{}: replayed here and named as another branch's", replay.set);
    }
    let missing = uncompared(&replays, &recorded_sets());
    // A set with skipped cases is not among the compared ones: its cases and reasons are listed apart.
    let skipped = skipped_cases();
    for (set, id, reason) in &skipped {
        eprintln!("recorded, not replayed: {set} {id}: {reason}");
    }
    let partial: std::collections::BTreeSet<String> = skipped.iter().map(|(set, ..)| set.clone()).collect();
    let missing: Vec<String> = missing.into_iter().filter(|set| !partial.contains(set)).collect();
    assert!(missing.is_empty(), "recorded provider sets no replay compared: {missing:?}");
}

/// A case named not replayed stays visible: its set is not registered as compared, and its reason is kept.
#[test]
fn a_not_replayed_case_is_kept_apart_with_its_reason() {
    let _alone = REGISTRY_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    COMPARED_SETS.lock().unwrap().clear();
    SKIPPED_SETS.lock().unwrap().clear();
    let set = two_property_set();
    set.not_replayed(&["a"], "another branch replays it");
    drop(set);
    assert!(!COMPARED_SETS.lock().unwrap().contains("anthropic-replay-blocks"), "a set with a skipped case is not compared");
    let kept = skipped_cases();
    assert!(
        kept.iter().any(|(set, id, reason)| set == "anthropic-replay-blocks" && id == "a" && reason == "another branch replays it"),
        "{kept:?}"
    );
}

/// A replay that names its set but never loads and compares it registers nothing: its set is reported.
#[test]
fn a_set_named_but_never_compared_does_not_count() {
    const UNLOADED: Replay = Replay {
        set: "anthropic-replay-blocks",
        run: || {
            const SET: &str = "anthropic-replay-blocks";
            assert!(!SET.is_empty());
        },
    };
    assert_eq!(uncompared(&[&UNLOADED], &["anthropic-replay-blocks".to_owned()]), ["anthropic-replay-blocks"]);
}

/// The synthetic set of the driver's own checks: the real manifest of `anthropic-replay-blocks` and one case whose result
/// is `{x, y}`.
fn two_property_set() -> CaseSet {
    synthetic_set(Exact::Object(vec![("x".into(), Exact::Number(1.0)), ("y".into(), Exact::Number(2.0))]), &[])
}

/// A set of one case `a` whose result is `result`, under the real manifest of `anthropic-replay-blocks` with
/// `exclusions` as its exclusion lines.
fn synthetic_set(result: Exact, exclusions: &[&str]) -> CaseSet {
    let Exact::Object(mut manifest) = Exact::load(fixtures().join("provider-anthropic-replay-blocks").join("MANIFEST.json")) else {
        panic!("a manifest")
    };
    manifest.retain(|(key, _)| key != "exclusions");
    manifest.push(("exclusions".into(), Exact::Array(exclusions.iter().map(|line| Exact::String((*line).into())).collect())));
    let manifest = Exact::Object(manifest);
    let recording = Exact::Object(vec![
        ("set".into(), Exact::String("provider-anthropic-replay-blocks".into())),
        ("nodeCommit".into(), manifest.get("product").get("commit").clone()),
        (
            "cases".into(),
            Exact::Array(vec![Exact::Object(vec![
                ("id".into(), Exact::String("a".into())),
                ("source".into(), Exact::String("synthetic".into())),
                ("input".into(), Exact::Object(Vec::new())),
                ("result".into(), result),
            ])]),
        ),
    ]);
    CaseSet::from_recording("anthropic-replay-blocks", manifest, recording, true)
}

fn object(entries: &[(&str, Exact)]) -> Exact {
    Exact::Object(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

/// A whole comparison leaves out only what the manifest declares: a declared member, at any depth, is neither compared
/// nor left uncovered, and the parent's mark stands for the rest; an actual that lacks an undeclared member is a
/// difference, so no projection of the recorded value can stand in for it.
#[test]
fn a_whole_comparison_leaves_out_only_declared_members() {
    let result = object(&[("x", Exact::Number(1.0)), ("inner", object(&[("y", Exact::Number(2.0)), ("stopDetails", Exact::Number(3.0))]))]);
    let without = object(&[("x", Exact::Number(1.0)), ("inner", object(&[("y", Exact::Number(2.0))]))]);
    let set = synthetic_set(result.clone(), &["`stopDetails` is not compared: synthetic"]);
    set.cases[0].recorded().assert_eq("declared", &without);
    drop(set);

    let lossy = std::panic::catch_unwind(|| {
        let set = synthetic_set(result.clone(), &[]);
        set.cases[0].recorded().assert_eq("undeclared", &without);
    })
    .map_err(panic_text)
    .expect_err("an undeclared member left out is a difference");
    assert!(lossy.contains("stopDetails"), "{lossy}");

    let filtered = std::panic::catch_unwind(|| {
        let set = synthetic_set(object(&[("deltas", Exact::Array(vec![Exact::String("text".into()), Exact::String("transport".into())]))]), &[]);
        set.cases[0].recorded().get("deltas").assert_filtered("deltas", "onStreamDelta('transport')", &Exact::Array(vec![Exact::String("text".into())]));
    })
    .map_err(panic_text)
    .expect_err("a filter needs its exclusion line");
    assert!(filtered.contains("declares no `onStreamDelta('transport')` exclusion"), "{filtered}");

    // With its line declared, a filter leaves out only that kind: an actual with nothing in it still differs from the
    // recorded `text`, and the array is not marked compared.
    let excessive = std::panic::catch_unwind(|| {
        let set = synthetic_set(
            object(&[("deltas", Exact::Array(vec![Exact::String("text".into()), Exact::String("transport".into())]))]),
            &["`onStreamDelta('transport')` is not compared: synthetic"],
        );
        set.cases[0].recorded().get("deltas").assert_filtered("deltas", "onStreamDelta('transport')", &Exact::Array(Vec::new()));
    })
    .map_err(panic_text)
    .expect_err("a filter leaves out only its declared kind");
    assert!(excessive.contains("deltas"), "{excessive}");
}

/// The `streaming stages` line leaves out that stage and no other: the provider's own `requesting` and `model_thinking`
/// (and any later stage) stay in the comparison.
#[test]
fn the_stages_filter_leaves_out_only_streaming() {
    let stage = |name: &str| object(&[("stage", Exact::String(name.into()))]);
    let recorded = || Exact::Array(["requesting", "model_thinking", "streaming", "reconnecting"].map(stage).to_vec());
    let line = "`streaming stages` is not compared: synthetic";
    let set = synthetic_set(object(&[("stages", recorded())]), &[line]);
    set.cases[0].recorded().get("stages").assert_filtered("stages", "streaming stages", &Exact::Array(vec![stage("requesting"), stage("model_thinking"), stage("reconnecting")]));
    drop(set);

    let lossy = std::panic::catch_unwind(|| {
        let set = synthetic_set(object(&[("stages", recorded())]), &[line]);
        set.cases[0].recorded().get("stages").assert_filtered("stages", "streaming stages", &Exact::Array(vec![stage("model_thinking"), stage("reconnecting")]));
    })
    .map_err(panic_text)
    .expect_err("a stage the line does not name is compared");
    assert!(lossy.contains("stages"), "{lossy}");
}

/// An error is marked compared only by its table comparison: a recorded field the table does not hold fails it, and
/// the case is then left unconsumed at the set's drop.
#[test]
fn an_error_is_compared_only_through_every_field() {
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    let recorded = Exact::Error {
        name: "Error".into(),
        message: "boom".into(),
        code: None,
        cause: None,
        props: vec![("fieldNoTableHolds".into(), Exact::Bool(true))],
    };
    let mut core = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    core.message = "boom".into();
    let left = crate::replay_errors::Left { error: Some(&core), cancelled: false, exhausted: false, events: &[], attempts: None };
    let set = synthetic_set(object(&[("error", recorded)]), &[]);
    let field = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set.cases[0].recorded().get("error").assert_error("error", ErrorSide::Send(&left))))
        .map_err(panic_text)
        .expect_err("a field the table does not hold fails the comparison");
    assert!(field.contains("fieldNoTableHolds"), "{field}");
    let unconsumed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(set))).map_err(panic_text).expect_err("the case was not consumed");
    assert!(unconsumed.contains("recorded cases no replay compared: [\"a\"]"), "{unconsumed}");
}

fn panic_text(panic: Box<dyn std::any::Any + Send>) -> String {
    panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned())).unwrap_or_default()
}

/// A recorded property the driver does not read fails the load (here a case key no recorder writes); a replay that only
/// reads the outcomes fails at the set's drop; one that compares a subset fails naming the property it left; one that
/// compares the whole outcome passes.
#[test]
fn only_a_comparison_consumes_a_recorded_case() {
    let manifest = Exact::load(fixtures().join("provider-anthropic-replay-blocks").join("MANIFEST.json"));
    let recording = Exact::load(fixtures().join("provider-anthropic-replay-blocks").join("cases.json"));
    let with_case_key = |key: &str| {
        let Exact::Object(mut top) = recording.clone() else { panic!("a recording") };
        let cases = &mut top.iter_mut().find(|(k, _)| k == "cases").expect("cases").1;
        let Exact::Array(items) = cases else { panic!("cases") };
        let Exact::Object(first) = &mut items[0] else { panic!("a case") };
        first.push((key.to_owned(), Exact::Bool(true)));
        Exact::Object(top)
    };
    let unread = std::panic::catch_unwind(|| CaseSet::from_recording("anthropic-replay-blocks", manifest.clone(), with_case_key("warnings"), false))
        .map(|_| ())
        .map_err(panic_text)
        .expect_err("the load fails");
    assert!(unread.contains("recorded properties the driver does not read: [\"warnings\"]"), "{unread}");

    let read_only = std::panic::catch_unwind(|| {
        let set = two_property_set();
        for case in &set.cases {
            assert_eq!(case.recorded().raw().entries().len(), 2);
            let _ = case.recorded().get("x").raw();
        }
    })
    .map_err(panic_text)
    .expect_err("a replay that only reads fails");
    assert!(read_only.contains("recorded cases no replay compared: [\"a\"]"), "{read_only}");

    let subset = std::panic::catch_unwind(|| {
        let set = two_property_set();
        set.cases[0].recorded().get("x").assert_eq("x", &Exact::Number(1.0));
    })
    .map_err(panic_text)
    .expect_err("a replay that compares a subset fails");
    assert!(subset.contains("recorded properties no comparison covered: [(\"a\", [\"y\"])]"), "{subset}");

    let set = two_property_set();
    set.cases[0].recorded().get("x").assert_eq("x", &Exact::Number(1.0));
    set.cases[0].recorded().get("y").assert_eq("y", &Exact::Number(2.0));
}
