//! The dispatch against the conversation real Node had (`fixtures/agent-dispatch`, from
//! `benchmarks/rust-core/recorders/record-agent-dispatch.mjs`): Node's `makeAgentDispatch` over its
//! real session manager, admission and watchdog with a stub provider. Each recorded scenario's
//! inputs drive the Rust runner over fakes of the session manager and the config; what the fakes
//! see (admission, prepare spec, status, ask, close, diagnostics) and what the caller gets back
//! are compared with Node's. `admission.run` (Node's ambient lease context) has no counterpart:
//! the lease's yielder goes to the ask instead.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_agent::agent_tool::flow::seams::Lease;
use mixdog_agent::cancel::session_closed;
use serde_json::json;

use super::*;

const GOLDEN: &str = include_str!("../../../../../fixtures/agent-dispatch/golden.json");

/// The runs the dispatch reports, counted while they are in its table.
#[derive(Default)]
struct Watch(Arc<std::sync::atomic::AtomicUsize>);

struct Held(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Watch {
    fn live(&self) -> usize {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl RunWatch for Watch {
    fn started(&self) -> RunHold {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::new(Held(self.0.clone()))
    }
}

/// Epoch milliseconds that follow the paused tokio clock.
const T0: i64 = 1_000_000;

struct Virtual(tokio::time::Instant);

impl Clock for Virtual {
    fn now_ms(&self) -> i64 {
        T0 + self.0.elapsed().as_millis() as i64
    }
}

struct Slot;

#[async_trait]
impl Yielder for Slot {
    async fn run_yielded(&self, task: BoxFuture<'_, bool>, _cancel: Option<&Cancel>) -> Result<(), String> {
        task.await;
        Ok(())
    }
}

#[derive(Default)]
struct Log {
    events: Vec<Value>,
    lines: Vec<String>,
    /// The assistant rows the session gained.
    rows: Vec<AssistantText>,
    /// When the stub began streaming (the session's last progress).
    streaming_since: Option<i64>,
}

/// The session manager, admission and config of one recorded scenario.
struct Fake {
    log: Arc<Mutex<Log>>,
    input: Value,
    hidden: Value,
    tools: Vec<String>,
    clock: Arc<Virtual>,
}

impl Fake {
    fn log(&self) -> std::sync::MutexGuard<'_, Log> {
        self.log.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, event: Value) {
        self.log().events.push(event);
    }
}

struct FakeLease(Arc<Mutex<Log>>);

#[async_trait]
impl Lease for FakeLease {
    async fn release(self: Box<Self>) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).events.push(json!(["admission.release"]));
    }

    fn yielder(&self) -> Arc<dyn Yielder> {
        Arc::new(Slot)
    }
}

#[async_trait]
impl Admission for Fake {
    async fn acquire(&self, label: &str, owner_key: Option<&str>, cancel: &Cancel) -> Result<Box<dyn Lease>, String> {
        self.push(json!(["admission.acquire", "agent", { "label": label, "ownerKey": owner_key, "aborted": cancel.is_aborted() }]));
        match self.input["admissionFails"].as_str() {
            Some(message) => Err(message.to_owned()),
            None => Ok(Box::new(FakeLease(self.log.clone()))),
        }
    }
}

/// The spec as Node's `prepareAgentSession` was recorded receiving it: unset fields are absent.
fn spec_json(spec: &PrepareSpec) -> Value {
    let mut out = Map::new();
    out.insert("agent".into(), spec.agent.clone().into());
    out.insert("presetName".into(), spec.preset_name.clone().into());
    out.insert("preset".into(), spec.preset.clone());
    out.insert("permission".into(), json!(spec.permission));
    out.insert("cwd".into(), json!(spec.cwd));
    for (key, value) in [("sourceType", &spec.source_type), ("sourceName", &spec.source_name)] {
        if let Some(value) = value {
            out.insert(key.into(), value.clone().into());
        }
    }
    out.insert("parentSessionId".into(), json!(spec.parent_session_id));
    out.insert("ownerSessionId".into(), json!(spec.owner_session_id));
    out.insert("skipRoleReminder".into(), spec.skip_role_reminder.into());
    out.insert("schemaAllowedTools".into(), json!(spec.schema_allowed_tools));
    if let Some(task) = &spec.task_type {
        out.insert("taskType".into(), task.clone().into());
    }
    out.extend(spec.context.clone());
    Value::Object(out)
}

#[async_trait]
impl DispatchSessions for Fake {
    async fn prepare(&self, spec: PrepareSpec) -> Result<Prepared, String> {
        self.push(json!(["prepare", spec_json(&spec), { "lane": spec.runtime_spec["lane"] }]));
        Ok(Prepared { id: "sess_fake1".into(), tools: self.tools.clone() })
    }

    async fn set_status(&self, _id: &str, status: &str) {
        self.push(json!(["status", status]));
    }

    async fn message_count(&self, _id: &str) -> usize {
        self.log().rows.len()
    }

    async fn assistant_texts(&self, _id: &str, start: usize) -> Vec<AssistantText> {
        self.log().rows[start..].to_vec()
    }

    async fn ask(&self, id: &str, request: AskRequest, cancel: &Cancel) -> Result<String, String> {
        self.push(json!(["ask", { "prompt": request.prompt, "cwd": request.cwd, "liveProjection": request.live_projection }]));
        let script: Vec<Value> = match &self.input["stub"] {
            Value::Array(list) => list.clone(),
            Value::Null => vec![json!({})],
            single => vec![single.clone()],
        };
        let mut sent = 0;
        loop {
            let behaviour = &script[sent.min(script.len() - 1)];
            sent += 1;
            if behaviour["streamThenHang"] == true {
                self.log().streaming_since = Some(self.clock.now_ms());
            }
            if behaviour["hang"] == true || behaviour["streamThenHang"] == true {
                cancel.cancelled().await;
                return Err(session_closed(id, &format!("aborted during call: {}", cancel.reason())));
            }
            if let Some(message) = behaviour["fail"].as_str() {
                return Err(message.to_owned());
            }
            let reply = behaviour["reply"].as_str().unwrap_or("reply text");
            if behaviour["toolCalls"].is_array() {
                self.log().rows.push(AssistantText { content: reply.to_owned(), replay: String::new() });
                continue;
            }
            return Ok(reply.to_owned());
        }
    }

    fn progress(&self, _id: &str, _now: i64) -> Option<Snapshot> {
        let since = self.log().streaming_since?;
        Some(Snapshot { stage: Some("streaming".into()), last_progress_at: since, has_first_semantic: true, ..Snapshot::default() })
    }

    fn arm_turn_timeout(&self, _id: &str) {}

    async fn close(&self, _id: &str, reason: &str) {
        self.push(json!(["close", reason]));
    }
}

impl DispatchWorld for Fake {
    fn config(&self) -> Map<String, Value> {
        self.input["options"]["config"].as_object().cloned().unwrap_or_default()
    }

    fn hidden_agent(&self, name: &str) -> Option<Value> {
        self.hidden.get(name).cloned()
    }

    fn route_candidates(&self, config: &Map<String, Value>, role: &str) -> Vec<Value> {
        config.get("agents").and_then(|agents| agents.get(role)).cloned().into_iter().collect()
    }

    fn runtime_spec(&self, _preset: &Value, _agent: &str) -> Value {
        json!({ "lane": "agent", "scopeKey": "agent" })
    }

    /// The recorded choice (`contextPercent` 40, `contextTokens` 64000) comes back as stated.
    fn context_selection(&self, preset: &Value) -> Map<String, Value> {
        ["contextPercent", "contextTokens"].into_iter().filter_map(|key| preset.get(key).map(|value| (key.to_owned(), value.clone()))).collect()
    }

    fn env(&self, _name: &str) -> Option<String> {
        None
    }

    fn clock(&self) -> Arc<dyn Clock> {
        self.clock.clone()
    }

    fn diagnostic(&self, line: &str) {
        self.log().lines.push(line.to_owned());
    }
}

/// `sess_...` ids are the dispatch's own; Node's were masked the same way.
fn mask(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("sess_") {
        out.push_str(&rest[..at]);
        out.push_str("<session>");
        let tail = &rest[at + 5..];
        let used = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(tail.len());
        rest = &tail[used..];
    }
    out.push_str(rest);
    out
}

/// A measured time is not a fact.
fn without_elapsed(line: &str) -> String {
    match line.find("elapsed=") {
        Some(at) => format!("{}elapsed=<ms>", &line[..at]),
        None => line.to_owned(),
    }
}

fn masked(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(mask(text)),
        Value::Array(items) => Value::Array(items.iter().map(masked).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), masked(item))).collect()),
        other => other.clone(),
    }
}

/// Node's events in the vocabulary the fakes log: no ambient-lease event, no signal flag (every
/// Rust dispatch has a cancel), and the ask without its callback plumbing.
fn node_events(events: &Value) -> Vec<Value> {
    events
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event[0] != "admission.run")
        .map(|event| match event[0].as_str().unwrap() {
            "admission.acquire" => {
                let mut detail = event[2].as_object().unwrap().clone();
                detail.remove("signal");
                json!(["admission.acquire", event[1], detail])
            }
            "ask" => json!(["ask", { "prompt": event[1]["prompt"], "cwd": event[1]["cwd"], "liveProjection": event[1]["liveProjection"] }]),
            _ => event.clone(),
        })
        .collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}

/// The factory options and the call arguments, merged the way `dispatchAdmitted` reads them.
fn request_of(input: &Value) -> DispatchRequest {
    let (options, call) = (&input["options"], &input["call"]);
    DispatchRequest {
        agent: options["agent"].as_str().unwrap().to_owned(),
        // The recorder's own default (`{ prompt: 'summarise the rows', ...scenario.call }`).
        prompt: call["prompt"].as_str().unwrap_or("summarise the rows").to_owned(),
        brief: options["brief"] != false,
        salvage_partial: input["salvage"] == true,
        preset: Some(call["preset"].clone()).filter(|preset| !preset.is_null()),
        default_preset: Some(options["preset"].clone()).filter(|preset| !preset.is_null()),
        cwd: Some(call["cwd"].as_str().unwrap_or_default().to_owned()).filter(|_| call.get("cwd").is_some()),
        default_cwd: Some(options["cwd"].as_str().unwrap_or_default().to_owned()).filter(|_| options.get("cwd").is_some()),
        idle_timeout_ms: call["idleTimeoutMs"].as_f64(),
        default_idle_timeout_ms: options["idleTimeoutMs"].as_f64(),
        task_type: text(&options["taskType"]),
        source_type: text(&options["sourceType"]),
        source_name: call.get("sourceName").and_then(Value::as_str).map(str::to_owned),
        default_source_name: options.get("sourceName").and_then(Value::as_str).map(str::to_owned),
        parent_session_id: text(&options["parentSessionId"]),
        owner_session_id: options.get("ownerSessionId").map(text),
        ..DispatchRequest::default()
    }
}

/// The tool names Node's own diagnostic line listed for the scenario.
fn listed_tools(stderr: &Value) -> Vec<String> {
    let Some(line) = stderr.as_array().unwrap().iter().filter_map(Value::as_str).find(|line| line.contains(" tool-list (")) else { return Vec::new() };
    let names = line.split("): ").nth(1).unwrap().trim();
    names.split(',').filter(|name| !name.is_empty()).map(str::to_owned).collect()
}

#[tokio::test(start_paused = true)]
async fn every_recorded_dispatch_converses_with_its_collaborators_as_nodes_did() {
    mixdog_rt::testing::tokens();
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["dispatches"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        let fake = Arc::new(Fake {
            log: Arc::default(),
            input: input.clone(),
            hidden: golden["hidden"].clone(),
            tools: listed_tools(&case["stderr"]),
            clock: Arc::new(Virtual(tokio::time::Instant::now())),
        });
        let runner = HiddenRoleRunner::new(fake.clone(), fake.clone(), fake.clone());
        let parent = Cancel::new();
        if let Some(after) = input["abortAfterMs"].as_u64() {
            let (parent, reason) = (parent.clone(), if input["salvage"] == true { "deadline" } else { "parent aborted" });
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(after)).await;
                parent.abort(reason);
            });
        }
        let got = match dispatch(&runner, &request_of(input), &parent).await {
            Ok(reply) => json!({ "ok": reply }),
            Err(error) => json!({ "error": error.to_string() }),
        };
        assert_eq!(masked(&got), case["outcome"], "{id}: outcome");
        let log = fake.log();
        assert_eq!(masked(&Value::Array(log.events.clone())), Value::Array(node_events(&case["events"])), "{id}: conversation");
        let lines: Vec<String> = log.lines.iter().map(|line| without_elapsed(mask(line).trim_end())).collect();
        let want: Vec<String> = case["stderr"].as_array().unwrap().iter().map(|line| without_elapsed(line.as_str().unwrap().trim_end())).collect();
        assert_eq!(lines, want, "{id}: diagnostics");
    }
}

/// The inline host: its run table and the payload it hands the dispatcher.
struct HostFake {
    closed: bool,
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl HostWorld for HostFake {
    fn assert_open(&self, cancel: Option<&Cancel>) -> Result<(), String> {
        if self.closed {
            return Err("session runtime host is closed".to_owned());
        }
        match cancel.filter(|cancel| cancel.is_aborted()) {
            Some(cancel) => Err(cancel.reason()),
            None => Ok(()),
        }
    }

    async fn prepare_providers(&self, _cancel: &Cancel) -> Result<(), String> {
        self.calls.lock().unwrap().push(json!({ "prepared": true }));
        Ok(())
    }
}

/// The dispatcher: answers `answer:<prompt>`, or waits for its abort when the prompt is `hang`.
struct Echo(Arc<HostFake>);

#[async_trait]
impl ChildRunner for Echo {
    async fn run_child(&self, request: &DispatchRequest, cancel: Cancel) -> ChildResult {
        let mut args = Map::new();
        args.insert("prompt".into(), request.prompt.clone().into());
        if let Some(preset) = &request.preset {
            args.insert("preset".into(), preset.clone());
        }
        if let Some(cwd) = &request.cwd {
            args.insert("cwd".into(), cwd.clone().into());
        }
        args.insert("parentSignal".into(), true.into());
        if let Some(idle) = request.idle_timeout_ms {
            args.insert("idleTimeoutMs".into(), number(idle));
        }
        let options = json!({ "agent": request.agent, "taskType": request.task_type, "sourceType": request.source_type, "brief": request.brief });
        self.0.calls.lock().unwrap().push(json!({ "options": options, "args": args }));
        if request.prompt == "hang" {
            cancel.cancelled().await;
            return ChildResult { outcome: Err(cancel.reason()) };
        }
        ChildResult { outcome: Ok(format!("answer:{}", request.prompt)) }
    }
}

fn payload_of(input: &Value) -> AgentDispatchPayload {
    let (payload, params) = (&input["payload"], &input["payload"]["params"]);
    let option = |key: &str| match payload["options"][key].as_str() {
        Some("memory-cycle") => "memory-cycle",
        Some("maintenance") => "maintenance",
        _ => "",
    };
    AgentDispatchPayload {
        dispatch_id: payload["dispatchId"].as_str().unwrap_or_default().to_owned(),
        agent: "cycle1-agent",
        task_type: option("taskType"),
        source_type: option("sourceType"),
        brief: payload["options"]["brief"] != false,
        prompt: mixdog_js::value_to_string(&params["prompt"]),
        preset: Some(params["preset"].clone()).filter(|preset| !preset.is_null()),
        cwd: params["cwd"].as_str().map(str::to_owned),
        idle_timeout_ms: params["idleTimeoutMs"].as_f64(),
    }
}

/// One recorded call to the host, as a `Result` in the recorded `ok` / `error` shape.
async fn go(host: &InlineAgentDispatch, input: &Value) -> Value {
    let parent = Cancel::new();
    if input["signalAborted"] == true {
        parent.abort("caller gone");
    }
    match host.run(payload_of(input), &parent).await {
        Ok(answer) => json!({ "ok": answer }),
        Err(error) => json!({ "error": error }),
    }
}

#[tokio::test]
async fn the_inline_host_hands_the_dispatcher_what_nodes_host_handed_it() {
    mixdog_rt::testing::tokens();
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let case = |id: &str| golden["host"].as_array().unwrap().iter().find(|case| case["id"] == id).unwrap().clone();
    let world = Arc::new(HostFake { closed: false, calls: Mutex::default() });
    let watch = Arc::new(Watch::default());
    let host = Arc::new(InlineAgentDispatch::new(Arc::new(Echo(world.clone())), world.clone(), watch.clone()));
    let closed_world = Arc::new(HostFake { closed: true, calls: Mutex::default() });
    let closed_host = InlineAgentDispatch::new(Arc::new(Echo(closed_world.clone())), closed_world, watch.clone());
    // What the dispatcher saw since the last check, when Node's check read it.
    let verify = |id: &str, got: Value| {
        let case = case(id);
        assert_eq!(got.get("ok"), case["outcome"].get("ok"), "{id}: answer");
        assert_eq!(got.get("error"), case["outcome"].get("error"), "{id}: error");
        if let Some(want) = case.get("calls").and_then(Value::as_array) {
            let seen: Vec<Value> = world.calls.lock().unwrap().drain(..).collect();
            assert_eq!(seen[seen.len() - want.len()..], want[..], "{id}: calls");
        }
    };
    for id in ["no-dispatch-id", "plain", "params-normalised", "negative-idle-dropped"] {
        verify(id, go(&host, &case(id)["outcome"]["input"]).await);
    }
    // `d4` waits for its abort while the next calls are made.
    let hanging = {
        let host = host.clone();
        let payload = AgentDispatchPayload { dispatch_id: "d4".into(), prompt: "hang".into(), ..payload_of(&json!({ "payload": { "dispatchId": "d4" } })) };
        tokio::spawn(async move { host.run(payload, &Cancel::new()).await })
    };
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    // Only the hanging run is in the table: a refused duplicate enters nothing and leaves nothing.
    assert_eq!(watch.live(), 1, "the hanging run alone is watched");
    verify("duplicate-id", go(&host, &case("duplicate-id")["outcome"]["input"]).await);
    assert_eq!(watch.live(), 1, "a refused duplicate is not a run");
    host.abort_all("host closing");
    verify("abort-all", match hanging.await.unwrap() {
        Ok(answer) => json!({ "ok": answer }),
        Err(error) => json!({ "error": error }),
    });
    assert_eq!(watch.live(), 0, "the run left the table when it ended");
    verify("signal-already-aborted", go(&host, &case("signal-already-aborted")["outcome"]["input"]).await);
    verify("run-table-cleared", go(&host, &case("run-table-cleared")["outcome"]["input"]).await);
    let closed = go(&closed_host, &case("host-closed")["outcome"]["input"]).await;
    assert_eq!(closed.get("error"), case("host-closed")["outcome"].get("error"), "host-closed");
}