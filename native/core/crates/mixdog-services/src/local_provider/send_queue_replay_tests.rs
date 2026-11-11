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
use mixdog_ai::catalog::CachedModelInfo;
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
}

/// The wire: each send takes the next script and answers it as an event stream (a `progress` of text is a content chunk, the
/// result a final chunk with the usage, a failure a reset), taking the script's time on the paused clock.
struct Wire {
    shared: Arc<Shared>,
    scripts: Mutex<VecDeque<(String, Vec<Step>)>>,
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
                Step::Hold => {
                    self.shared.reached.lock().unwrap().push(format!("{} holds", self.name));
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
    async fn send(&self, _: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        let (name, steps) = self.scripts.lock().unwrap().pop_front().expect("a script for each send");
        Ok(HttpResponse { status: 200, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(Body { shared: self.shared.clone(), name, steps: steps.into() }) })
    }
}

struct World {
    shared: Arc<Shared>,
    adapter: Arc<RegisteredAdapter>,
    _dir: tempfile::TempDir,
}

fn world(model: &str, scripts: Vec<(&str, Vec<Step>)>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let runtime = super::provider::tests::provider(dir.path());
    let shared = Arc::new(Shared { model: model.into(), runtime: runtime.clone(), reached: Mutex::default(), snapshots: Mutex::default(), held: tokio::sync::Notify::new(), release: tokio::sync::Notify::new() });
    let wire = Arc::new(Wire { shared: shared.clone(), scripts: Mutex::new(scripts.into_iter().map(|(name, steps)| (name.to_owned(), steps)).collect()) });
    let adapter = Arc::new(RegisteredAdapter::new(wire, Arc::new(Injected(ManagedRuntime(runtime)))));
    World { shared, adapter, _dir: dir }
}

fn request(model: &str) -> Arc<p::ModelRequest> {
    Arc::new(p::ModelRequest { model: model.into(), messages: vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))], tools: Vec::new(), options: p::RequestOptions::default() })
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
    let adapter = RegisteredAdapter::new(Arc::new(Wire { shared: Arc::new(Shared { model: String::new(), runtime: provider.clone(), reached: Mutex::default(), snapshots: Mutex::default(), held: tokio::sync::Notify::new(), release: tokio::sync::Notify::new() }), scripts: Mutex::default() }), Arc::new(Injected(ManagedRuntime(provider.clone()))));
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
