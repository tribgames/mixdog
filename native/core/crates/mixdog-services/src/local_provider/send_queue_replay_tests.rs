//! Replays `native/core/fixtures/local-send-queue`: what `MixdogLocalProvider.send` does around the inner send — the one
//! request queue every send goes through, the inference measurement (`beginLocalInference`) and `getCachedModelInfo`.
//! The registered adapter (mixdog-ai) runs over the real [`LocalProvider`] (its queue and model state) through
//! [`ManagedRuntime`]; only the server start is the test's (a fixed endpoint, as the Node recording injects `ensureServer`)
//! and the wire is scripted with the recording's steps, on a paused clock that those steps advance.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::admission::{Admission, AdmissionRequest, LaneKey, process_lane_settings};
use mixdog_ai::broker::{AttemptSink, ModelBroker, SendRequest};
use mixdog_ai::catalog::CachedModelInfo;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_ai::providers::local::Endpoint;
use mixdog_ai::providers::local::Inference;
use mixdog_ai::providers::local::LocalRuntime;
use mixdog_ai::providers::local::RegisteredAdapter;
use mixdog_ai::providers::local::listing::InstalledModels;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider as p;
use serde_json::Value;
use serde_json::json;

use super::installed_models::ManagedRuntime;
use super::provider::LocalProvider;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/local-send-queue/golden.json");

fn recorded(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

/// The managed runtime but for the server start: a fixed endpoint, as the recording's injected `ensureServer`.
struct Injected(ManagedRuntime);

#[async_trait]
impl InstalledModels for Injected {
    async fn installed(&self) -> Result<Vec<Value>, p::ProviderError> {
        self.0.installed().await
    }
}

#[async_trait]
impl LocalRuntime for Injected {
    async fn ensure_server(&self, _: &str) -> Result<Endpoint, p::ProviderError> {
        Ok(Endpoint { base_url: "http://127.0.0.1:12345/v1".into(), api_key: "k".into() })
    }
    async fn begin(&self, model: &str) -> Result<Box<dyn Inference>, p::ProviderError> {
        self.0.begin(model).await
    }
    fn installed_now(&self) -> Option<Vec<Value>> {
        self.0.installed_now()
    }
}

/// One step of a recorded script.
enum Step {
    Advance(u64),
    Progress(String),
    Snapshot(String),
    Hold,
    Fail,
    /// The request is answered with this status and an error body.
    Status(u16),
    Result { input: u64, output: u64 },
}

fn steps_of(recorded: &Value) -> Vec<Step> {
    recorded
        .as_array()
        .unwrap()
        .iter()
        .map(|step| {
            if let Some(ms) = step.get("advance") {
                Step::Advance(ms.as_u64().unwrap())
            } else if let Some(status) = step.get("status") {
                Step::Status(status.as_u64().unwrap() as u16)
            } else if let Some(kind) = step.get("progress") {
                Step::Progress(kind.as_str().unwrap().into())
            } else if let Some(name) = step.get("snapshot") {
                Step::Snapshot(name.as_str().unwrap().into())
            } else if step.get("hold").is_some() {
                Step::Hold
            } else if step.get("fail").is_some() {
                Step::Fail
            } else {
                let usage = &step["result"];
                Step::Result { input: usage["inputTokens"].as_u64().unwrap(), output: usage["outputTokens"].as_u64().unwrap() }
            }
        })
        .collect()
}

/// What the scripted wire shares with the test.
struct Shared {
    model: String,
    runtime: Arc<LocalProvider>,
    /// Sends that reached the wire, by script name.
    reached: Mutex<Vec<String>>,
    /// The inference state the scripts snapshot, by name.
    snapshots: Mutex<serde_json::Map<String, Value>>,
    /// A script holds at its `Hold` step until the test releases it; `held` tells the test one arrived.
    held: tokio::sync::Notify,
    release: tokio::sync::Notify,
    /// Requests in the order they reached the wire (`A#1`), and the holds among them, for the scripts that name requests.
    order: Mutex<Vec<String>>,
    /// When each named request reached the wire, on the paused clock.
    times: Mutex<Vec<(String, tokio::time::Instant)>>,
}

/// The wire: each send takes the next script and answers it as an event stream (a `progress` of text is a content chunk, the
/// result a final chunk with the usage, a failure a reset), taking the script's time on the paused clock.
struct Wire {
    shared: Arc<Shared>,
    scripts: Mutex<VecDeque<(String, Vec<Step>)>>,
    /// Scripts by request name, `<sender>#<n>`: the sender is the text of the message the request carries, n counts its requests.
    named: Mutex<std::collections::HashMap<String, Vec<Step>>>,
    counts: Mutex<std::collections::HashMap<String, usize>>,
}

/// One chunk, then the end.
struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, p::TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Body {
    shared: Arc<Shared>,
    name: String,
    steps: VecDeque<Step>,
}

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, p::TransportFault>> {
        loop {
            match self.steps.pop_front()? {
                Step::Advance(ms) => tokio::time::advance(Duration::from_millis(ms)).await,
                Step::Progress(kind) if kind == "text" => return Some(Ok(Bytes::from("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n"))),
                // A transport-level progress is the response head, which the wire already answered.
                Step::Progress(_) => {}
                Step::Snapshot(name) => {
                    let state = self.shared.runtime.catalog.state.get(&self.shared.model);
                    self.shared.snapshots.lock().unwrap().insert(name, state["inference"].clone());
                }
                // The status answers the head; nothing follows it.
                Step::Status(_) => {}
                Step::Hold => {
                    self.shared.reached.lock().unwrap().push(format!("{} holds", self.name));
                    self.shared.order.lock().unwrap().push(format!("{} holds", self.name));
                    self.shared.held.notify_one();
                    self.shared.release.notified().await;
                }
                Step::Fail => return Some(Err(p::TransportFault::Reset)),
                Step::Result { input, output } => {
                    let chunk = format!("data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":{input},\"completion_tokens\":{output},\"total_tokens\":{}}}}}\n\ndata: [DONE]\n\n", input + output);
                    return Some(Ok(Bytes::from(chunk)));
                }
            }
        }
    }
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, wire: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        let named = !self.named.lock().unwrap().is_empty();
        let (name, steps) = if named {
            let body: Value = serde_json::from_slice(&wire.body).unwrap();
            let who = body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_owned();
            let n = {
                let mut counts = self.counts.lock().unwrap();
                *counts.entry(who.clone()).or_default() += 1;
                counts[&who]
            };
            let name = format!("{who}#{n}");
            self.shared.order.lock().unwrap().push(name.clone());
            self.shared.times.lock().unwrap().push((name.clone(), tokio::time::Instant::now()));
            let steps = self.named.lock().unwrap().remove(&name).unwrap_or_else(|| panic!("a script for {name}"));
            (name, steps)
        } else {
            self.scripts.lock().unwrap().pop_front().expect("a script for each send")
        };
        if let Some(Step::Status(status)) = steps.first() {
            let body = Bytes::from_static(br#"{"error":{"message":"boom"}}"#);
            return Ok(HttpResponse { status: *status, headers: vec![("content-type".into(), "application/json".into())], body: Box::new(Once(Some(body))) });
        }
        Ok(HttpResponse { status: 200, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(Body { shared: self.shared.clone(), name, steps: steps.into() }) })
    }
}

struct World {
    shared: Arc<Shared>,
    adapter: Arc<RegisteredAdapter>,
    wire: Arc<Wire>,
    _dir: tempfile::TempDir,
}

fn world(model: &str, scripts: Vec<(&str, Vec<Step>)>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let runtime = super::provider::tests::provider(dir.path());
    let shared = Arc::new(Shared { model: model.into(), runtime: runtime.clone(), reached: Mutex::default(), snapshots: Mutex::default(), held: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), order: Mutex::default(), times: Mutex::default() });
    let wire = Arc::new(Wire { shared: shared.clone(), scripts: Mutex::new(scripts.into_iter().map(|(name, steps)| (name.to_owned(), steps)).collect()), named: Mutex::default(), counts: Mutex::default() });
    let adapter = Arc::new(RegisteredAdapter::new(wire.clone(), Arc::new(Injected(ManagedRuntime(runtime)))));
    World { shared, adapter, wire, _dir: dir }
}

fn request(model: &str) -> Arc<p::ModelRequest> {
    request_of(model, "hi", None)
}

/// A request carrying `text`, of the send group `group` (the loop's logical send, whose attempts it replays).
fn request_of(model: &str, text: &str, group: Option<&str>) -> Arc<p::ModelRequest> {
    let options = p::RequestOptions { send_group: group.map(str::to_owned), ..p::RequestOptions::default() };
    Arc::new(p::ModelRequest { model: model.into(), messages: vec![p::Message::new(p::Role::User, p::Content::Text(text.into()))], tools: Vec::new(), options })
}

/// One send, drained: what it returned, or the error that ended it.
async fn send(adapter: &RegisteredAdapter, model: &str) -> Result<(), String> {
    let mut stream = p::ProviderAdapter::attempt(adapter, request(model)).await.map_err(|e| e.message)?;
    while let Some(event) = stream.next().await {
        event.map_err(|e| e.message)?;
    }
    Ok(())
}

/// The recorded inference with the stamp taken out (checked as an instant) and, for a failure, the error text compared to the
/// text the send ended with.
fn settled(state: &Value, failure: Option<&str>) -> Value {
    let mut state = state.clone();
    let at = state.as_object_mut().unwrap().remove("at").expect("a finished inference is stamped");
    assert!(chrono::DateTime::parse_from_rfc3339(at.as_str().unwrap()).is_ok(), "{at}");
    if let Some(failure) = failure {
        assert_eq!(state["error"], json!(mixdog_js::slice_utf16(failure, 1024)));
        state["error"] = Value::Null;
    }
    state
}

fn recorded_inference(observed: &Value) -> Value {
    let mut state = observed["inference"].clone();
    state.as_object_mut().unwrap().remove("at");
    if state["state"] == "failed" {
        state["error"] = Value::Null;
    }
    state
}

#[tokio::test(start_paused = true)]
async fn a_streamed_send_is_measured() {
    let node = recorded("a streamed send is measured: first response, duration, tokens per second");
    let world = world("local-streamed", vec![("only", steps_of(&node["steps"]))]);
    assert_eq!(send(&world.adapter, "local-streamed").await, Ok(()));
    let state = world.shared.runtime.catalog.state.get("local-streamed");
    assert_eq!(settled(&state["inference"], None), recorded_inference(&node));
    assert_eq!(Value::Object(world.shared.snapshots.lock().unwrap().clone()), node["snapshots"]);
}

#[tokio::test(start_paused = true)]
async fn a_failed_send_is_measured_as_failed_and_rethrown() {
    let node = recorded("a failed send is measured as failed and its error is rethrown");
    let world = world("local-failed", vec![("only", steps_of(&node["steps"]))]);
    let failure = send(&world.adapter, "local-failed").await.expect_err("the send fails");
    assert!(node["outcome"].get("threw").is_some());
    let state = world.shared.runtime.catalog.state.get("local-failed");
    assert_eq!(settled(&state["inference"], Some(&failure)), recorded_inference(&node));
}

#[tokio::test(start_paused = true)]
async fn a_send_that_shows_no_output_has_no_first_response() {
    let node = recorded("a send that shows no output has no first response and no speed");
    let world = world("local-silent", vec![("only", steps_of(&node["steps"]))]);
    assert_eq!(send(&world.adapter, "local-silent").await, Ok(()));
    let state = world.shared.runtime.catalog.state.get("local-silent");
    assert_eq!(settled(&state["inference"], None), recorded_inference(&node));
}

#[tokio::test(start_paused = true)]
async fn a_second_send_waits_for_the_first_and_its_queue_wait_is_measured() {
    let node = recorded("a second send waits for the first, and its queue wait is measured");
    let [first, second] = [&node["scripts"][0], &node["scripts"][1]];
    let model = node["model"].as_str().unwrap();
    let world = world(model, vec![("A", steps_of(first)), ("B", steps_of(second))]);
    let mut a = tokio::spawn({
        let adapter = world.adapter.clone();
        let model = model.to_owned();
        async move { send(&adapter, &model).await }
    });
    let b = tokio::spawn({
        let adapter = world.adapter.clone();
        let model = model.to_owned();
        async move { send(&adapter, &model).await }
    });
    // No timer here: the clock is paused and the installed-models reads the provider keeps run on blocking threads, during
    // which a pending timer would be fired early. The wait ends when the first send holds the slot or can no longer do so.
    tokio::select! {
        () = world.shared.held.notified() => {}
        ended = &mut a => panic!("the first send ended before it held the slot: {ended:?}"),
    }
    let during = world.shared.runtime.catalog.state.get(model)["inference"].clone();
    assert_eq!((world.shared.reached.lock().unwrap().clone(), during), (node["reachedWhileHeld"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>(), node["duringHold"].clone()));
    assert_eq!(world.shared.snapshots.lock().unwrap().len(), 0, "the second send has not started");
    tokio::time::advance(Duration::from_millis(node["elapsedWhileHeld"].as_u64().unwrap())).await;
    world.shared.release.notify_one();
    assert_eq!((a.await.unwrap(), b.await.unwrap()), (Ok(()), Ok(())));
    assert_eq!(Value::Object(world.shared.snapshots.lock().unwrap().clone()), node["secondSaw"]);
    let state = world.shared.runtime.catalog.state.get(model);
    assert_eq!(settled(&state["inference"], None), recorded_inference(&node));
}

/// One logical send as the loop makes it: every attempt carries the send's group; a failed attempt is retried after the
/// backoff `delay_ms` (the clock moves by it), and a send that ends on a failure settles its group. Returns the send's end and
/// what the wire had seen, and the inference showed, when the first backoff was over.
async fn send_retrying(adapter: &RegisteredAdapter, shared: &Shared, model: &str, who: &str, delay_ms: u64) -> (Result<(), String>, Option<(Vec<String>, Value)>) {
    let group = format!("group-{who}");
    let mut after_backoff = None;
    loop {
        let attempt = p::ProviderAdapter::attempt(adapter, request_of(model, who, Some(&group))).await;
        let mut stream = match attempt {
            Ok(stream) => stream,
            Err(_) if after_backoff.is_none() => {
                tokio::time::advance(Duration::from_millis(delay_ms)).await;
                after_backoff = Some((shared.order.lock().unwrap().clone(), shared.runtime.catalog.state.get(model)["inference"].clone()));
                continue;
            }
            Err(error) => {
                p::ProviderAdapter::settle_send(adapter, &group, p::SendEnd::Surfaced).await;
                return (Err(error.message), after_backoff);
            }
        };
        while let Some(event) = stream.next().await {
            if let Err(error) = event {
                return (Err(error.message), after_backoff);
            }
        }
        return (Ok(()), after_backoff);
    }
}

#[tokio::test(start_paused = true)]
async fn a_retry_keeps_the_slot_while_a_second_send_waits() {
    let node = recorded("a retry keeps the slot while a second send waits");
    let model = node["model"].as_str().unwrap();
    let delay = node["retryDelayMs"].as_u64().unwrap();
    let world = world(model, Vec::new());
    for (name, steps) in node["scripts"].as_object().unwrap() {
        world.wire.named.lock().unwrap().insert(name.clone(), steps_of(steps));
    }
    let spawn = |who: &'static str| {
        let (adapter, shared, model) = (world.adapter.clone(), world.shared.clone(), model.to_owned());
        tokio::spawn(async move { send_retrying(&adapter, &shared, &model, who, delay).await })
    };
    let mut a = spawn("A");
    let b = spawn("B");
    // No timer here (see the queued test): the wait ends when A's retry holds the slot or A can no longer do so.
    tokio::select! {
        () = world.shared.held.notified() => {}
        ended = &mut a => panic!("the first send ended before its retry held the slot: {ended:?}"),
    }
    let strings = |value: &Value| value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(*world.shared.order.lock().unwrap(), strings(&node["reachedWhileHeld"]));
    assert_eq!(world.shared.runtime.catalog.state.get(model)["inference"], node["duringHold"]);
    tokio::time::advance(Duration::from_millis(node["elapsedWhileHeld"].as_u64().unwrap())).await;
    world.shared.release.notify_one();
    let ((a_end, backoff_over), (b_end, _)) = (a.await.unwrap(), b.await.unwrap());
    assert_eq!((a_end, b_end), (Ok(()), Ok(())));
    let (reached, state) = backoff_over.expect("the first request failed and was retried");
    assert_eq!((reached, state), (strings(&node["reachedBeforeBackoffEnds"]), node["stateInBackoff"].clone()));
    assert_eq!(*world.shared.order.lock().unwrap(), strings(&node["wireOrder"]));
    // Node's measurement clock does not move with its timers, Rust's is the one clock: the wait of the send that queued
    // behind the retry also holds the backoff.
    let mut expected = recorded_inference(&node);
    expected["queueWaitMs"] = json!(node["inference"]["queueWaitMs"].as_u64().unwrap() + delay);
    let state = world.shared.runtime.catalog.state.get(model);
    assert_eq!(settled(&state["inference"], None), expected);
}

/// The model proxy's send: the PC's broker sends once through the registered adapter, the retries of the send are its own.
struct Discard(Option<tokio_util::sync::CancellationToken>);

impl AttemptSink for Discard {
    fn event(&mut self, _: p::StreamEvent) {}
    fn discard(&mut self) {
        if let Some(cancel) = &self.0 {
            cancel.cancel();
        }
    }
}

async fn broker_send(broker: &ModelBroker, adapter: &RegisteredAdapter, model: &str, who: &str, lane: &str, cancel: &tokio_util::sync::CancellationToken, cancel_on_retry: bool) -> Result<u32, String> {
    let key = LaneKey::new(mixdog_protocol::ProviderId::from("mixdog-local"), lane);
    let send = SendRequest { request: request_of(model, who, None), lane: broker.admission().lane(&key, process_lane_settings()(&key)), admission: AdmissionRequest::default() };
    let mut sink = Discard(cancel_on_retry.then(|| cancel.clone()));
    broker.send(adapter, send, &mut sink, cancel).await.map_err(|error| format!("{error:?}"))
}

fn broker() -> ModelBroker {
    ModelBroker::new(Arc::new(Admission::new()), Arc::new(StandardRetryDecider))
}

/// The next local send is admitted: it answers inside a deadline of the paused clock, which a held slot would let pass.
async fn next_send_is_admitted(world: &World, model: &str) {
    let next = tokio::time::timeout(Duration::from_secs(5), send(&world.adapter, model)).await;
    assert_eq!(next.expect("the next local send to be admitted"), Ok(()));
}

/// Node's proxy calls the queue-wrapped provider send, which holds the slot across the inner retries. The recorded retry case
/// ("a retry keeps the slot while a second send waits"), through the broker the model proxy sends with: its own retry decides
/// the attempts, and the second send, on another lane, waits in the local queue behind the whole send.
#[tokio::test(start_paused = true)]
async fn a_retry_through_the_broker_keeps_the_slot_while_a_second_send_waits() {
    let node = recorded("a retry keeps the slot while a second send waits");
    let model = node["model"].as_str().unwrap();
    let world = world(model, Vec::new());
    for (name, steps) in node["scripts"].as_object().unwrap() {
        world.wire.named.lock().unwrap().insert(name.clone(), steps_of(steps));
    }
    let broker = Arc::new(broker());
    let spawn = |who: &'static str| {
        let (adapter, broker, model) = (world.adapter.clone(), broker.clone(), model.to_owned());
        tokio::spawn(async move { broker_send(&broker, &adapter, &model, who, who, &tokio_util::sync::CancellationToken::new(), false).await })
    };
    let mut a = spawn("A");
    let b = spawn("B");
    tokio::select! {
        () = world.shared.held.notified() => {}
        ended = &mut a => panic!("the first send ended before its retry held the slot: {ended:?}"),
    }
    let strings = |value: &Value| value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(*world.shared.order.lock().unwrap(), strings(&node["reachedWhileHeld"]));
    tokio::time::advance(Duration::from_millis(node["elapsedWhileHeld"].as_u64().unwrap())).await;
    world.shared.release.notify_one();
    let (a_end, b_end) = (a.await.unwrap(), b.await.unwrap());
    assert_eq!((a_end.is_ok(), b_end.is_ok()), (true, true), "{a_end:?} {b_end:?}");
    assert_eq!(*world.shared.order.lock().unwrap(), strings(&node["wireOrder"]));
    // The broker's backoff is its own (jittered), Node's retry delay is the recording's: the wait of the send that queued
    // behind the retry holds whichever backoff the first send took.
    let times = world.shared.times.lock().unwrap().clone();
    let at = |name: &str| times.iter().find(|(n, _)| n == name).unwrap().1;
    let backoff = (at("A#2") - at("A#1")).as_millis() as u64;
    let mut expected = recorded_inference(&node);
    expected["queueWaitMs"] = json!(node["inference"]["queueWaitMs"].as_u64().unwrap() + backoff);
    let state = world.shared.runtime.catalog.state.get(model);
    assert_eq!(settled(&state["inference"], None), expected);
}

/// A send group that ends on its last error lets the next send in.
#[tokio::test(start_paused = true)]
async fn a_group_that_ends_on_its_last_error_lets_the_next_send_in() {
    let world = world("local-group-error", vec![("A", vec![Step::Status(500)]), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    let attempt = p::ProviderAdapter::attempt(&*world.adapter, request_of("local-group-error", "A", Some("g1"))).await;
    assert!(attempt.is_err());
    p::ProviderAdapter::settle_send(&*world.adapter, "g1", p::SendEnd::Surfaced).await;
    next_send_is_admitted(&world, "local-group-error").await;
}

/// The group's guard dropped between attempts (the caller's future dropped, in or out of a runtime, or a panic) lets go through
/// `release_send`, which is synchronous.
#[tokio::test(start_paused = true)]
async fn a_group_let_go_between_attempts_lets_the_next_send_in() {
    let world = world("local-group-between", vec![("A", vec![Step::Status(500)]), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    assert!(p::ProviderAdapter::attempt(&*world.adapter, request_of("local-group-between", "A", Some("g2"))).await.is_err());
    p::ProviderAdapter::release_send(&*world.adapter, "g2");
    next_send_is_admitted(&world, "local-group-between").await;
}

/// A group whose answer was being read when its caller went away lets the next send in.
#[tokio::test(start_paused = true)]
async fn a_group_let_go_mid_answer_lets_the_next_send_in() {
    let steps = vec![Step::Progress("text".into()), Step::Hold];
    let world = world("local-group-mid", vec![("A", steps), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    let mut stream = p::ProviderAdapter::attempt(&*world.adapter, request_of("local-group-mid", "A", Some("g3"))).await.unwrap();
    assert!(stream.next().await.unwrap().is_ok());
    drop(stream);
    p::ProviderAdapter::release_send(&*world.adapter, "g3");
    next_send_is_admitted(&world, "local-group-mid").await;
}

/// The broker's send cancelled between attempts lets the next send in.
#[tokio::test(start_paused = true)]
async fn a_broker_send_cancelled_between_attempts_lets_the_next_send_in() {
    let world = world("local-broker-cancel", vec![("A", vec![Step::Status(500)]), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    let cancel = tokio_util::sync::CancellationToken::new();
    let ended = broker_send(&broker(), &world.adapter, "local-broker-cancel", "A", "a", &cancel, true).await;
    assert!(ended.unwrap_err().contains("Cancelled"));
    next_send_is_admitted(&world, "local-broker-cancel").await;
}

/// The broker's send ending on its last error lets the next send in.
#[tokio::test(start_paused = true)]
async fn a_broker_send_that_surfaces_its_error_lets_the_next_send_in() {
    let world = world("local-broker-error", vec![("A", vec![Step::Status(400)]), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    let ended = broker_send(&broker(), &world.adapter, "local-broker-error", "A", "a", &tokio_util::sync::CancellationToken::new(), false).await;
    assert!(ended.is_err());
    next_send_is_admitted(&world, "local-broker-error").await;
}

/// The broker's future dropped while its retry holds the slot (a dropped caller) lets the next send in.
#[tokio::test(start_paused = true)]
async fn a_broker_send_dropped_while_it_holds_the_slot_lets_the_next_send_in() {
    let world = world("local-broker-drop", vec![("A1", vec![Step::Status(500)]), ("A2", vec![Step::Progress("text".into()), Step::Hold]), ("next", vec![Step::Result { input: 1, output: 1 }])]);
    let broker = Arc::new(broker());
    let task = tokio::spawn({
        let (adapter, broker) = (world.adapter.clone(), broker.clone());
        async move { broker_send(&broker, &adapter, "local-broker-drop", "A", "a", &tokio_util::sync::CancellationToken::new(), false).await }
    });
    world.shared.held.notified().await;
    task.abort();
    let _ = task.await;
    next_send_is_admitted(&world, "local-broker-drop").await;
}

/// `getCachedModelInfo` is `installedLocalProviderModels().find(id) || null`, read now (Node reads the disk on every call): at each
/// moment the adapter answers the row the runtime lists for the id, or nothing, for a model installed, not downloaded, removed
/// and one that was never registered.
#[tokio::test]
async fn the_cached_model_info_is_the_installed_models_row_at_every_moment() {
    let node = recorded("the cached model info is the installed model's row at every moment");
    // The recording's relation, which is the contract: every moment's cached row is the listing's row of that id, else null.
    for moment in node["moments"].as_array().unwrap() {
        for (id, cached) in moment["cached"].as_object().unwrap() {
            let listed = moment["listed"].as_array().unwrap().iter().find(|row| row["id"] == json!(id)).cloned().unwrap_or(Value::Null);
            assert_eq!(&listed, cached, "{} / {id}", moment["name"]);
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let provider = super::provider::tests::provider(dir.path());
    let adapter = RegisteredAdapter::new(Arc::new(Wire { shared: Arc::new(Shared { model: String::new(), runtime: provider.clone(), reached: Mutex::default(), snapshots: Mutex::default(), held: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), order: Mutex::default(), times: Mutex::default() }), scripts: Mutex::default(), named: Mutex::default(), counts: Mutex::default() }), Arc::new(Injected(ManagedRuntime(provider.clone()))));
    let mut rows = provider.installed_rows();
    let (first, second) = (install(&provider, 1, b"first weights").await, install(&provider, 2, b"second weights").await);
    let ids = [first.as_str(), second.as_str(), "never-registered"];
    // Installing finishes and a context change ticks the provider's change signal, after which the row is there.
    provider.set_context(&first, Some(16_384)).await.unwrap();
    wait_for_rows(&mut rows, &[&first, &second]).await;
    let answers = |adapter: &RegisteredAdapter| ids.map(|id| adapter.cached_row(id).map(|row| row["id"].clone()));
    assert_eq!(answers(&adapter), [Some(json!(first)), Some(json!(second)), None]);
    let listed = provider.catalog.installed_models().await.unwrap();
    for id in ids {
        assert_eq!(adapter.cached_row(id).as_deref(), listed.iter().find(|row| row["id"] == json!(id)), "{id}");
    }
    // A deletion ticks it as well: the removed model has no row from then on.
    let token = provider.model_details(&first).await.unwrap()["confirmationToken"].as_str().unwrap().to_owned();
    provider.delete_model(&token).await.unwrap();
    wait_for_rows(&mut rows, &[&second]).await;
    assert_eq!(answers(&adapter), [None, Some(json!(second)), None]);
}

/// A read after an operation on the models has completed sees it, with no wait on the change signal: Node reads the catalog on
/// every call, and the refreshed rows are published before the operation returns.
#[tokio::test]
async fn a_cached_read_right_after_an_operation_sees_its_result() {
    let dir = tempfile::tempdir().unwrap();
    let provider = super::provider::tests::provider(dir.path());
    let adapter = RegisteredAdapter::new(Arc::new(Wire { shared: Arc::new(Shared { model: String::new(), runtime: provider.clone(), reached: Mutex::default(), snapshots: Mutex::default(), held: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), order: Mutex::default(), times: Mutex::default() }), scripts: Mutex::default(), named: Mutex::default(), counts: Mutex::default() }), Arc::new(Injected(ManagedRuntime(provider.clone()))));
    let (first, second) = (install(&provider, 1, b"first weights").await, install(&provider, 2, b"second weights").await);
    let ids = [first.as_str(), second.as_str()];
    let cached = |adapter: &RegisteredAdapter| ids.map(|id| adapter.cached_row(id).map(|row| row["id"].clone()));
    // The models are placed and an operation completes: a read returns what it left.
    provider.set_context(&first, Some(16_384)).await.unwrap();
    assert_eq!(cached(&adapter), [Some(json!(first)), Some(json!(second))]);
    // The removal completes: the removed model has no row.
    let token = provider.model_details(&first).await.unwrap()["confirmationToken"].as_str().unwrap().to_owned();
    provider.delete_model(&token).await.unwrap();
    assert_eq!(cached(&adapter), [None, Some(json!(second))]);
}

/// Registers model `n` with the digest of `content` and puts `content` where its weights are: an installed model.
async fn install(provider: &LocalProvider, n: u8, content: &[u8]) -> String {
    let mut m = super::registered_models::tests::model(n, 16384);
    m["size"] = json!(content.len());
    m["estimatedVramBytes"] = json!(content.len() + 1);
    m["minimumVramBytes"] = json!(content.len() + 1);
    m["sha256"] = json!(sha256_hex(content));
    let registered = provider.hf.registry().register(&m).await.unwrap();
    let path = provider.catalog.model_path(&registered);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
    registered["id"].as_str().unwrap().to_owned()
}

fn sha256_hex(content: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(content).iter().map(|b| format!("{b:02x}")).collect()
}

/// Waits (one deadline) until the runtime's installed rows are exactly the models `ids`.
async fn wait_for_rows(rows: &mut tokio::sync::watch::Receiver<Option<Vec<Value>>>, ids: &[&str]) {
    let want: Vec<&str> = ids.to_vec();
    tokio::time::timeout(Duration::from_secs(5), rows.wait_for(|rows| rows.as_ref().is_some_and(|rows| rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>() == want)))
        .await
        .unwrap_or_else(|_| panic!("the installed rows to become {ids:?}"))
        .expect("the provider to live");
}
