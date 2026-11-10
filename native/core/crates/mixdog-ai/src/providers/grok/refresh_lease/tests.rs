//! The core's Grok refresh against Node's own (`refresh_lease/record.mjs`): every recorded case is run through
//! [`GrokCredential::ensure`] (what a send's header asks for) with the case's credential file, lease file, other-process
//! steps and token-endpoint script, on a virtual clock driven like the recorder's (timers fire in due-time then
//! registration order, one at a time, after everything that can run without the clock has run), and what it did (each
//! token request, each lease or backoff wait as it fires, each caller's result, the file and its directory at the end)
//! is compared whole with what Node did. Two owners in one process are two credentials with lease owners and refreshes
//! in flight of their own over one file, as the recording's two copies of Node's modules are; two real processes are
//! [`processes`]'s.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a test sets up and reads its own files")]

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::oauth::CredentialIo;
use crate::providers::grok::fixture_manifest;
use mixdog_core_api::domain::provider::TransportFault;

use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;

#[path = "processes.rs"]
mod processes;

const RECORDER: &str = "native/core/crates/mixdog-ai/src/providers/grok/refresh_lease/record.mjs";
/// A pid no process has: not a multiple of 4 (Windows) and past every `pid_max` (Linux), the recorder's.
const DEAD_PID: u32 = 2147483645;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn recording() -> Value {
    let dir = repo().join("native/core/fixtures/grok-refresh-lease");
    fixture_manifest::verify_dir(&repo(), &dir, RECORDER);
    serde_json::from_slice(&std::fs::read(dir.join("node-recorded.json")).unwrap()).unwrap()
}

/// What a timer does when it fires.
enum Fire {
    /// Wakes a wait of the clock.
    Wake(Arc<Slot>),
    /// The other process's step `n` of the case.
    Action(usize),
    /// Caller `n` of the case starts.
    Start(usize),
}

struct Timer {
    due: u64,
    id: u64,
    ms: u64,
    recorded: bool,
    fire: Fire,
}

#[derive(Default)]
struct Slot {
    fired: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

/// The virtual clock: the case's `Date.now()`, its timers, and what the case did.
struct Clock {
    t0: u64,
    state: Mutex<ClockState>,
}

struct ClockState {
    now: u64,
    next_id: u64,
    timers: Vec<Timer>,
    events: Vec<Value>,
}

impl Clock {
    fn state(&self) -> std::sync::MutexGuard<'_, ClockState> {
        self.state.lock().unwrap()
    }

    fn at(&self) -> u64 {
        self.state().now - self.t0
    }

    fn add(&self, due: u64, ms: u64, recorded: bool, fire: Fire) {
        let mut state = self.state();
        state.next_id += 1;
        let id = state.next_id;
        state.timers.push(Timer { due, id, ms, recorded, fire });
    }

    /// A wait of `ms` the clock fires; `recorded` waits are the product's own.
    fn fired_after(&self, ms: u64, recorded: bool) -> impl Future<Output = ()> + Send + 'static {
        let slot = Arc::new(Slot::default());
        let due = self.state().now + ms;
        self.add(due, ms, recorded, Fire::Wake(slot.clone()));
        std::future::poll_fn(move |cx| {
            if slot.fired.load(Ordering::SeqCst) {
                return Poll::Ready(());
            }
            *slot.waker.lock().unwrap() = Some(cx.waker().clone());
            Poll::Pending
        })
    }

    fn event(&self, event: Value) {
        self.state().events.push(event);
    }
}

#[async_trait]
impl Pace for Arc<Clock> {
    fn now_ms(&self) -> u64 {
        self.state().now
    }

    /// Every wait the refresh takes is a lease wait or a backoff: both are recorded as they fire.
    async fn wait(&self, duration: Duration) {
        self.fired_after(duration.as_millis() as u64, true).await;
    }

    /// `Math.random()`, 0.5 in the recording.
    fn draw(&self) -> f64 {
        0.5
    }
}

/// The case's token endpoint: each request is recorded and answered with the case's next reply after its `afterMs`.
struct Endpoint {
    proc: String,
    clock: Arc<Clock>,
    replies: Arc<Mutex<Vec<Value>>>,
}

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.clock.event(json!({
            "at": self.clock.at(),
            "kind": "request",
            "proc": self.proc,
            "url": request.url,
            "body": String::from_utf8(request.body).unwrap(),
        }));
        let reply = {
            let mut replies = self.replies.lock().unwrap();
            assert!(!replies.is_empty(), "a token request the case has no reply for");
            replies.remove(0)
        };
        self.clock.fired_after(reply["afterMs"].as_u64().unwrap(), false).await;
        Ok(HttpResponse {
            status: reply["status"].as_u64().unwrap() as u16,
            headers: Vec::new(),
            body: Box::new(OneChunk(Some(Bytes::from(reply["body"].as_str().unwrap().to_owned())))),
        })
    }
}

struct Flag(AtomicBool);

impl Wake for Flag {
    fn wake(self: Arc<Self>) {
        self.0.store(true, Ordering::SeqCst);
    }
}

type Call = Pin<Box<dyn Future<Output = Result<StoredTokens, ProviderError>> + Send>>;

/// The error as the recording keeps it.
fn error_of(error: &ProviderError) -> Value {
    json!({ "message": error.message, "status": error.status, "code": error.code, "reauthRequired": error.reauth_required })
}

/// Runs one recorded case through the core and returns what it did, in the recording's shape.
fn run(case: &Value, t0: u64) -> Value {
    let name = case["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grok-oauth.json");
    std::fs::write(&path, case["file"].as_str().unwrap()).unwrap();
    let lock = refresh_lock_path(&path);
    if let Some(preset) = case["lock"].as_object() {
        let record = match preset["kind"].as_str().unwrap() {
            "live" => format!("{} {t0} holder000000000000000000", std::process::id()),
            "dead" => format!("{DEAD_PID} {t0} holder000000000000000000"),
            "ownerless" => String::new(),
            other => panic!("{name}: lock kind {other}"),
        };
        std::fs::write(&lock, record).unwrap();
        let mtime = std::time::UNIX_EPOCH + Duration::from_millis(t0 - preset["ageMs"].as_u64().unwrap());
        std::fs::File::options().write(true).open(&lock).unwrap().set_modified(mtime).unwrap();
    }
    let clock = Arc::new(Clock { t0, state: Mutex::new(ClockState { now: t0, next_id: 0, timers: Vec::new(), events: Vec::new() }) });
    let replies = Arc::new(Mutex::new(case["replies"].as_array().unwrap().clone()));
    let rt = mixdog_rt::testing::tokens();
    let mut credentials: HashMap<String, Arc<GrokCredential>> = HashMap::new();
    let callers = case["callers"].as_array().unwrap();
    for caller in callers {
        let proc = caller["proc"].as_str().unwrap().to_owned();
        credentials.entry(proc.clone()).or_insert_with(|| {
            let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
            let http = Arc::new(Endpoint { proc, clock: clock.clone(), replies: replies.clone() });
            let process = Arc::new(RefreshProcess::new(Arc::new(LockProcess::new(mixdog_statefile::LockOwner::another_in_process()))));
            Arc::new(GrokCredential::new(http, file).with_pace(Arc::new(clock.clone())).in_process(process))
        });
    }
    // The other process's steps, then the callers, each at its time (the recorder's registration order).
    let actions = case["actions"].as_array().unwrap();
    for (n, action) in actions.iter().enumerate() {
        let at = action["at"].as_u64().unwrap();
        clock.add(t0 + at, at, false, Fire::Action(n));
    }
    for (n, caller) in callers.iter().enumerate() {
        let at = caller["at"].as_u64().unwrap();
        clock.add(t0 + at, at, false, Fire::Start(n));
    }
    let mut calls: Vec<Option<(Call, Arc<Flag>)>> = (0..callers.len()).map(|_| None).collect();
    let mut pending = callers.len();
    while pending > 0 {
        // Everything runs that can without the clock.
        loop {
            let mut ran = false;
            for (n, slot) in calls.iter_mut().enumerate() {
                let Some((call, flag)) = slot else { continue };
                if !flag.0.swap(false, Ordering::SeqCst) {
                    continue;
                }
                ran = true;
                let waker = Waker::from(flag.clone());
                if let Poll::Ready(outcome) = call.as_mut().poll(&mut Context::from_waker(&waker)) {
                    let mut event = json!({ "at": clock.at(), "kind": "result", "caller": n });
                    match outcome {
                        Ok(tokens) => event["token"] = json!(tokens.access_token),
                        Err(error) => event["error"] = error_of(&error),
                    }
                    clock.event(event);
                    *slot = None;
                    pending -= 1;
                }
            }
            if !ran {
                break;
            }
        }
        if pending == 0 {
            break;
        }
        let timer = {
            let mut state = clock.state();
            state.timers.sort_by_key(|t| (t.due, t.id));
            assert!(!state.timers.is_empty(), "{name}: {pending} caller(s) wait on nothing the clock can fire, after {}", Value::Array(state.events.iter().rev().take(4).cloned().collect()));
            let timer = state.timers.remove(0);
            state.now = timer.due;
            if timer.recorded {
                state.events.push(json!({ "at": timer.due - t0, "kind": "wait", "ms": timer.ms }));
            }
            timer
        };
        match timer.fire {
            Fire::Wake(slot) => {
                slot.fired.store(true, Ordering::SeqCst);
                if let Some(waker) = slot.waker.lock().unwrap().take() {
                    waker.wake();
                }
            }
            Fire::Action(n) => match actions[n]["kind"].as_str().unwrap() {
                "write" => std::fs::write(&path, actions[n]["text"].as_str().unwrap()).unwrap(),
                "release" => std::fs::remove_file(&lock).unwrap(),
                other => panic!("{name}: action {other}"),
            },
            Fire::Start(n) => {
                let credential = credentials[callers[n]["proc"].as_str().unwrap()].clone();
                let force = callers[n]["force"].as_bool().unwrap();
                // Outside tokio's cooperative budget: this driver polls in one runtime task that never yields, where a
                // spent budget would park the call on a wake deferred to that yield.
                let call: Call = Box::pin(tokio::task::unconstrained(async move { credential.ensure(force).await }));
                calls[n] = Some((call, Arc::new(Flag(AtomicBool::new(true)))));
            }
        }
    }
    let mut entries: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    entries.sort();
    let events = std::mem::take(&mut clock.state().events);
    json!({
        "events": events,
        "fileAfter": std::fs::read_to_string(&path).unwrap(),
        "entries": entries,
        "unusedReplies": replies.lock().unwrap().len(),
    })
}

/// Every recorded case: the core makes the token requests Node made, at the same instants, waits as Node waited,
/// gives each caller what Node gave it, and leaves the credential file and its directory as Node left them.
#[tokio::test(flavor = "current_thread")]
async fn every_refresh_case_does_what_node_did() {
    let recording = recording();
    let t0 = recording["t0"].as_u64().unwrap();
    let mut differing = Vec::new();
    for case in recording["cases"].as_array().unwrap() {
        let node = json!({ "events": case["events"], "fileAfter": case["fileAfter"], "entries": case["entries"], "unusedReplies": case["unusedReplies"] });
        let core = run(case, t0);
        if core != node {
            differing.push(format!("{}:\n  node {node}\n  core {core}", case["name"].as_str().unwrap()));
        }
    }
    assert!(differing.is_empty(), "{} of {} cases differ from Node:\n{}", differing.len(), recording["cases"].as_array().unwrap().len(), differing.join("\n"));
}
