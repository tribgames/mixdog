//! Secret input against the goldens of `fixtures/secret-input`, recorded from the Node code that
//! answers it (`benchmarks/rust-core/recorders/record-secret-input.mjs`).

use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::ClaimedHostChannel;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostClaim;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::HostId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_protocol::JsonValue;
use mixdog_tools::desktop::host::HostCommandError;
use mixdog_tools::desktop::host::HostCommands;
use serde_json::Value;
use serde_json::json;

use super::*;
use super::redact::redact_secrets;

const ID: &str = "secret_0123456789ab";
const VALUE: &str = "Tr0ub4dor&3";

fn golden(name: &str) -> Value {
    let text = match name {
        "slots.json" => include_str!("../../../../../fixtures/secret-input/slots.json"),
        "computer.json" => include_str!("../../../../../fixtures/secret-input/computer.json"),
        "browser.json" => include_str!("../../../../../fixtures/secret-input/browser.json"),
        "redaction.json" => include_str!("../../../../../fixtures/secret-input/redaction.json"),
        "remote.json" => include_str!("../../../../../fixtures/secret-input/remote.json"),
        "host-replies.json" => include_str!("../../../../../fixtures/secret-host/host-replies.json"),
        other => panic!("{other}"),
    };
    serde_json::from_str(text).unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn lasting() -> SecretSlots {
    SecretSlots::new(SECRET_INPUT_TIMEOUT)
}

/// The slots of `id` and its binding as the recorder reads them.
fn state(slots: &SecretSlots, id: &str) -> Value {
    json!({
        "held": slots.has(id),
        "username": slots.has(&format!("{id}{SECRET_USERNAME_SUFFIX}")),
        "save": slots.has(&format!("{id}{SECRET_SAVE_SUFFIX}")),
        "browser": slots.browser_binding(id).map(|b| b.session),
        "computer": slots.computer_binding(id).map(|b| json!({ "sessionId": b.session, "windowId": b.window_id, "ref": b.reference })),
    })
}

struct Gates {
    browser: bool,
    computer: bool,
}

impl FillGates for Gates {
    fn browser_free(&self, _: &ThreadId) -> bool {
        self.browser
    }
    fn computer_free(&self) -> bool {
        self.computer
    }
}

/// A host that answers the scripted replies in order and keeps every command it was sent.
struct Computer {
    script: Vec<Value>,
    sent: Mutex<Vec<Value>>,
}

#[async_trait]
impl ComputerCommands for Computer {
    async fn execute(&self, _: &ThreadId, command: Value) -> Result<Value, String> {
        let mut sent = self.sent.lock().unwrap_or_else(PoisonError::into_inner);
        sent.push(command);
        match self.script.get(sent.len() - 1) {
            None => Ok(Value::Null),
            Some(step) => match step.get("throw").and_then(Value::as_str) {
                Some("string") => Err("a thrown string stale_target".to_owned()),
                Some(message) => Err(message.to_owned()),
                None => Ok(step.get("reply").cloned().unwrap_or(Value::Null)),
            },
        }
    }
}

fn idle_computer() -> Arc<Computer> {
    Arc::new(Computer { script: Vec::new(), sent: Mutex::new(Vec::new()) })
}

fn fill_with(slots: &Arc<SecretSlots>, gates: Gates, computer: Arc<Computer>) -> SecretFill {
    SecretFill::new(slots.clone(), Arc::new(gates), computer, Desk::new())
}

fn open() -> Gates {
    Gates { browser: true, computer: true }
}

/// A browser host that answers `answer` and keeps every command it was sent.
struct Page {
    answer: Result<JsonValue, HostCommandError>,
    sent: Mutex<Vec<(String, JsonValue)>>,
}

impl Page {
    fn answering(answer: Result<JsonValue, HostCommandError>) -> Arc<Self> {
        Arc::new(Self { answer, sent: Mutex::new(Vec::new()) })
    }

    fn sent(&self) -> Vec<(String, JsonValue)> {
        self.sent.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

#[async_trait]
impl HostCommands for Page {
    async fn browser(&self, _: &ThreadId, action: &str, input: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        self.sent.lock().unwrap_or_else(PoisonError::into_inner).push((action.to_owned(), input));
        self.answer.clone()
    }

    async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        Err(HostCommandError::NoHost)
    }
}

#[tokio::test]
async fn provided_values_follow_the_recorded_slots() {
    for case in golden("slots.json")["provide"].as_array().unwrap() {
        let name = text(case, "name");
        let id = text(case, "requestId");
        let slots = lasting();
        assert_eq!(json!(slots.provide(id, text(case, "value"))), case["accepted"], "{name}");
        assert_eq!(json!(slots.has(id)), case["held"], "{name}");
        assert_eq!(json!(slots.take(id)), case["taken"], "{name}");
        assert_eq!(json!(slots.take(id)), case["takenAgain"], "{name}");
    }
}

#[tokio::test]
async fn slots_and_bindings_follow_the_recorded_sequences() {
    let doc = golden("slots.json");
    let cases = doc["sequences"].as_array().unwrap();
    let case = |name: &str| cases.iter().find(|c| text(c, "name") == name).unwrap();

    let recorded = case("discard drops the value, username and save slots and the binding");
    let slots = lasting();
    assert!(slots.provide(ID, "a"));
    assert!(slots.provide(&format!("{ID}{SECRET_USERNAME_SUFFIX}"), "user"));
    assert!(slots.provide(&format!("{ID}{SECRET_SAVE_SUFFIX}"), "1"));
    assert!(slots.bind(ID, "S1", claim()));
    assert_eq!(state(&slots, ID), recorded["before"]);
    slots.discard(ID);
    assert_eq!(state(&slots, ID), recorded["after"]);

    let slots = lasting();
    assert!(slots.provide(ID, "first") && slots.provide(ID, "second"));
    assert_eq!(json!(slots.take(ID)), case("a second value replaces the first")["taken"]);

    let recorded = case("a request has one binding, of the kind bound last");
    let slots = lasting();
    let steps = recorded["states"].as_array().unwrap();
    let seen = vec![(slots.bind(ID, "S1", claim()), state(&slots, ID)), (slots.bind_computer(ID, "S1", "w1", "e1"), state(&slots, ID)), (slots.bind(ID, "S2", claim()), state(&slots, ID))];
    for ((ok, got), step) in seen.into_iter().zip(steps) {
        assert_eq!(json!(ok), step["ok"], "{step}");
        for key in ["held", "username", "save", "browser", "computer"] {
            assert_eq!(got[key], step[key], "{step} {key}");
        }
    }

    let recorded = case("a bind needs a runtime-minted id");
    let slots = lasting();
    assert_eq!(json!(slots.bind("not-a-request", "S1", claim())), recorded["bad"]);
    assert_eq!(json!(slots.bind_computer("not-a-request", "S1", "w1", "e1")), recorded["badComputer"]);
    assert_eq!(state(&slots, "not-a-request")["browser"], recorded["browser"]);
}

#[tokio::test]
async fn a_computer_request_is_bound_as_the_bridge_binds_it() {
    for case in golden("slots.json")["bindComputer"].as_array().unwrap() {
        let name = text(case, "name");
        let slots = Arc::new(lasting());
        let fill = fill_with(&slots, open(), idle_computer());
        let thread = ThreadId::from(text(case, "sessionId"));
        let bound = fill.computer_bind(&thread, text(case, "requestId"), text(case, "windowId"), text(case, "ref"));
        assert_eq!(json!(bound), case["text"], "{name}");
        let got = slots.computer_binding(text(case, "requestId")).map(|b| json!({ "sessionId": b.session, "windowId": b.window_id, "ref": b.reference }));
        assert_eq!(got.unwrap_or(Value::Null), case["binding"], "{name}");
    }
}

/// Every deadline passes with nothing asking for the entry, and an older timer never deletes a
/// replacement: the schedule of the recorded timelines on a clock that only moves when told.
#[tokio::test(start_paused = true)]
async fn entries_expire_at_their_deadline_and_a_replacement_outlives_the_older_timer() {
    for line in golden("slots.json")["timelines"].as_array().unwrap() {
        let name = text(line, "name");
        let ms = |key: &str| Duration::from_millis(line["options"][key].as_u64().unwrap());
        let slots = SecretSlots::with_binding_timeout(ms("timeoutMs"), ms("bindingTimeoutMs"));
        let mut now = 0;
        let mut observed = Vec::new();
        for step in line["steps"].as_array().unwrap() {
            let at = step["at"].as_u64().unwrap();
            mixdog_rt::time::sleep(Duration::from_millis(at - now)).await;
            now = at;
            match text(step, "do") {
                "provide" => assert!(slots.provide(ID, text(step, "value")), "{name}"),
                "bind" => assert!(slots.bind(ID, text(step, "session"), claim()), "{name}"),
                _ => {
                    let mut row = json!({ "at": at, "held": slots.has(ID) });
                    if step["take"] == json!(true) {
                        row["take"] = json!(slots.take(ID));
                    }
                    row["browser"] = json!(slots.browser_binding(ID).map(|b| b.session));
                    observed.push(row);
                }
            }
        }
        assert_eq!(json!(observed), line["observed"], "{name}");
    }
}

#[tokio::test(start_paused = true)]
async fn an_expired_value_leaves_memory_without_any_later_operation() {
    let slots = SecretSlots::with_binding_timeout(Duration::from_millis(100), Duration::from_millis(200));
    assert!(slots.provide(ID, "plaintext") && slots.bind(ID, "S1", claim()));
    mixdog_rt::time::sleep(Duration::from_millis(150)).await;
    // Inspected beneath the operations, which would otherwise sweep it themselves.
    assert!(slots.inner.state().slots.is_empty(), "the value outlived its deadline");
    assert_eq!(slots.inner.state().bindings.len(), 1);
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert!(slots.inner.state().bindings.is_empty());
    drop(slots);
}

fn thread_of(case: &Value) -> Option<ThreadId> {
    let session = case["command"]["session_id"].as_str().unwrap_or_default();
    (!session.is_empty()).then(|| ThreadId::from(session))
}

#[tokio::test]
async fn a_computer_secret_is_typed_as_the_bridge_types_it() {
    for case in golden("computer.json")["type"].as_array().unwrap() {
        let name = text(case, "name");
        // A request with no session cannot be made of a thread, which always has an id.
        let Some(thread) = thread_of(case) else { continue };
        let slots = Arc::new(lasting());
        let computer = Arc::new(Computer { script: case["script"].as_array().unwrap().clone(), sent: Mutex::new(Vec::new()) });
        let gates = Gates { browser: true, computer: case["gateHeld"] != json!(true) };
        let fill = fill_with(&slots, gates, computer.clone());
        if let Some(provided) = case["provide"].as_str() {
            assert!(slots.provide(ID, provided), "{name}");
        }
        if let Some(bind) = case["bind"].as_object() {
            let got = |key: &str| bind[key].as_str().unwrap().to_owned();
            assert!(slots.bind_computer(ID, &got("session"), &got("windowId"), &got("ref")), "{name}");
        }
        let command = &case["command"];
        let named = |key: &str| command.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let outcome = fill.computer_input(&thread, text(command, "request_id"), &named("window_id"), &named("ref")).await;
        assert_eq!(json!(outcome), case["outcome"], "{name}");
        assert_eq!(json!(computer.sent.lock().unwrap().clone()), case["commands"], "{name}");
        let after = &case["after"];
        assert_eq!(json!(slots.has(ID)), after["held"], "{name}");
        assert_eq!(state(&slots, ID)["computer"], after["computer"], "{name}");
        assert_eq!(json!(fill.focus_armed(&thread)), after["focusArmed"], "{name}");
        let sample = format!("pw={} and {VALUE}!", case["provide"].as_str().unwrap_or_default());
        assert_eq!(json!(fill.redact(&thread, &sample)), after["redacted"], "{name}");
    }
}

#[tokio::test]
async fn a_computer_secret_needs_a_computer_binding() {
    let recorded = &golden("computer.json")["bindThenType"];
    let slots = Arc::new(lasting());
    let fill = fill_with(&slots, open(), idle_computer());
    let thread = ThreadId::from("S1");
    assert!(slots.provide(ID, VALUE));
    assert_eq!(json!(fill.bind_browser(&thread, ID, claim())), recorded[0]["browser"]);
    let outcome = fill.computer_input(&thread, ID, "", "").await;
    assert_eq!(json!(outcome), recorded[1]["outcome"]);
    assert_eq!(json!(slots.has(ID)), recorded[1]["held"]);
}


fn claim() -> HostClaim {
    HostClaim { host: HostId::from("host-A"), connection: ConnectionId(1), generation: 1 }
}

/// The desktops of the host channel: one claim serves the browser at a time, it answers by
/// action, and it keeps what it was sent (only what the claim that serves received).
struct Desk {
    claim: Mutex<HostClaim>,
    replies: Mutex<std::collections::HashMap<String, Result<JsonValue, HostError>>>,
    sent: Mutex<Vec<(String, JsonValue)>>,
    /// A newer desktop claims the browser role as soon as this action was answered.
    takeover_after: Mutex<Option<String>>,
}

impl Desk {
    fn new() -> Arc<Self> {
        Arc::new(Self { claim: Mutex::new(claim()), replies: Mutex::default(), sent: Mutex::default(), takeover_after: Mutex::new(None) })
    }

    fn reply(&self, action: &str, answer: Result<JsonValue, HostError>) {
        self.replies.lock().unwrap().insert(action.to_owned(), answer);
    }

    fn claimant_changes(&self) {
        let mut current = self.claim.lock().unwrap();
        *current = HostClaim { host: HostId::from("host-B"), connection: ConnectionId(2), generation: 2 };
    }

    fn sent(&self) -> Vec<(String, JsonValue)> {
        self.sent.lock().unwrap().clone()
    }

    fn answer(&self, params: &JsonValue) -> Result<JsonValue, HostError> {
        let action = params["action"].as_str().unwrap().to_owned();
        self.sent.lock().unwrap().push((action.clone(), params.clone()));
        let answer = self.replies.lock().unwrap().get(&action).cloned().unwrap_or(Ok(JsonValue::Null));
        if self.takeover_after.lock().unwrap().as_deref() == Some(action.as_str()) {
            self.claimant_changes();
        }
        answer
    }
}

#[async_trait]
impl HostChannel for Desk {
    async fn request(&self, _: HostCapability, _: Method, params: JsonValue) -> Result<JsonValue, HostError> {
        self.answer(&params)
    }
    fn notify(&self, _: HostCapability, _: Method, _: JsonValue) -> Result<(), CoreError> {
        unreachable!("a secret fill sends requests")
    }
}

#[async_trait]
impl ClaimedHostChannel for Desk {
    async fn request_claimed(&self, _: HostCapability, _: Method, params: JsonValue) -> Result<(HostClaim, JsonValue), HostError> {
        let serving = self.claim.lock().unwrap().clone();
        Ok((serving, self.answer(&params)?))
    }

    async fn request_to(&self, to: &HostClaim, _: HostCapability, _: Method, params: JsonValue) -> Result<JsonValue, HostError> {
        if *to != *self.claim.lock().unwrap() {
            return Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "claimantChanged".into() }));
        }
        self.answer(&params)
    }
}

/// A request that the bound desktop (host-A, session S1) holds the page of.
fn browser_fill(desk: &Arc<Desk>, gates: Gates) -> (Arc<SecretSlots>, SecretFill) {
    let slots = Arc::new(lasting());
    let fill = SecretFill::new(slots.clone(), Arc::new(gates), idle_computer(), desk.clone());
    (slots, fill)
}

fn has_value(sent: &[(String, JsonValue)]) -> bool {
    sent.iter().any(|(_, params)| params.to_string().contains(VALUE))
}

#[tokio::test]
async fn the_core_checks_of_a_browser_fill_refuse_before_the_desktop_is_asked() {
    for case in golden("browser.json").as_array().unwrap().iter().filter(|c| text(c, "checkedBy") == "core") {
        let name = text(case, "name");
        let thread = ThreadId::from(text(case, "session"));
        let desk = Desk::new();
        let gates = Gates { browser: case["gateHeld"] != json!(true), computer: true };
        let (slots, fill) = browser_fill(&desk, gates);
        if case["provide"].is_object() {
            assert!(slots.provide(ID, VALUE), "{name}");
        }
        if let Some(bind) = case["bind"].as_object() {
            assert!(slots.bind(ID, bind["session"].as_str().unwrap(), claim()), "{name}");
        }
        if case["computerBind"] == json!(true) {
            assert!(slots.bind_computer(ID, text(case, "session"), "w1", "e1"), "{name}");
        }
        let outcome = fill.fill_browser(&thread, ID).await;
        assert_eq!(json!(outcome.text()), case["outcome"], "{name}");
        assert!(desk.sent().is_empty(), "{name}: the desktop is not asked, and no value reaches it");
        let after = state(&slots, ID);
        for key in ["held", "username", "save", "browser", "computer"] {
            assert_eq!(after[key], case["after"][key], "{name} {key}");
        }
        assert_eq!(fill.redact(&thread, &format!("pw={VALUE}!")), format!("pw={VALUE}!"), "{name}: a refused value is not remembered");
    }
}

/// What the real desktop code answers (`fixtures/secret-host`): the core sends the commands the
/// desktop was recorded with and ends as the desktop's answers say.
#[tokio::test]
async fn the_core_fills_through_the_desktop_as_recorded() {
    let doc = golden("host-replies.json");
    assert_eq!(doc["hostId"], "host-A");
    for case in doc["cases"].as_array().unwrap() {
        let name = text(case, "name");
        // The core never sends an empty value: its own slot would have expired.
        if name == "a fill with no value is blocked" {
            continue;
        }
        let thread = ThreadId::from(text(case, "thread"));
        let desk = Desk::new();
        let (slots, fill) = browser_fill(&desk, open());
        desk.reply("secret_precheck", Ok(case["precheck"]["reply"].clone()));
        if let Some(sent) = case.get("fill") {
            desk.reply("secret_fill", Ok(sent["reply"].clone()));
        }
        let input = case["fill"]["params"]["input"].clone();
        assert!(slots.provide(ID, VALUE));
        if let Some(username) = input["username"].as_str().filter(|u| !u.is_empty()) {
            assert!(slots.provide(&format!("{ID}{SECRET_USERNAME_SUFFIX}"), username));
        }
        if input["save"] == json!(true) {
            assert!(slots.provide(&format!("{ID}{SECRET_SAVE_SUFFIX}"), "1"));
        }
        assert!(slots.bind(ID, thread.as_str(), claim()));
        let outcome = fill.fill_browser(&thread, ID).await;
        let sent = desk.sent();
        assert_eq!(sent[0], ("secret_precheck".to_owned(), case["precheck"]["params"].clone()), "{name}");
        let filled = case.get("fill").is_some();
        let want = if filled { case["fill"]["reply"]["text"].clone() } else { case["precheck"]["reply"]["text"].clone() };
        assert_eq!(json!(outcome.text()), want, "{name}");
        let after = state(&slots, ID);
        assert_eq!((after["held"].clone(), after["username"].clone(), after["save"].clone(), after["browser"].clone()), (json!(false), json!(false), json!(false), Value::Null), "{name}: nothing is kept");
        if filled {
            let mut want_fill = case["fill"]["params"].clone();
            want_fill["input"]["value"] = json!(VALUE);
            assert_eq!(sent, vec![("secret_precheck".to_owned(), case["precheck"]["params"].clone()), ("secret_fill".to_owned(), want_fill)], "{name}");
            assert_eq!(fill.redact(&thread, &format!("pw={VALUE}!")), "pw=[redacted]!", "{name}: the value that was sent is remembered");
        } else {
            assert_eq!(sent.len(), 1, "{name}: a refused pre-check sends no value");
            assert!(!has_value(&sent), "{name}");
            assert_eq!(fill.redact(&thread, &format!("pw={VALUE}!")), format!("pw={VALUE}!"), "{name}: a refused value is not remembered");
        }
    }
}

#[tokio::test]
async fn a_precheck_that_is_not_the_bound_desktops_ready_sends_nothing() {
    for answer in [Ok(json!({ "text": "ready", "hostId": "host-B" })), Ok(json!({ "text": "ready" })), Ok(json!({ "hostId": "host-A" })), Ok(json!({ "text": "entered", "hostId": "host-A" })), Ok(json!({})), Err(HostError::Core(CoreError::ConnectionClosed))] {
        let desk = Desk::new();
        let (slots, fill) = browser_fill(&desk, open());
        let thread = ThreadId::from("S1");
        assert!(slots.provide(ID, VALUE) && slots.bind(ID, "S1", claim()));
        desk.reply("secret_precheck", answer.clone());
        assert_eq!(fill.fill_browser(&thread, ID).await, SecretOutcome::Blocked, "{answer:?}");
        assert!(!has_value(&desk.sent()) && !slots.has(ID) && slots.browser_binding(ID).is_none());
        assert_eq!(fill.redact(&thread, VALUE), VALUE);
    }
}

#[tokio::test]
async fn the_value_never_goes_to_a_desktop_that_no_longer_holds_the_claim() {
    // A newer desktop claimed the browser role since the request was bound: the pre-check is refused.
    let desk = Desk::new();
    let (slots, fill) = browser_fill(&desk, open());
    let thread = ThreadId::from("S1");
    assert!(slots.provide(ID, VALUE) && slots.bind(ID, "S1", claim()));
    desk.claimant_changes();
    assert_eq!(fill.fill_browser(&thread, ID).await, SecretOutcome::Blocked);
    assert!(desk.sent().is_empty() && !slots.has(ID));
    assert_eq!(fill.redact(&thread, VALUE), VALUE);

    // The claim moves between the two phases: the value is not delivered to either desktop.
    let desk = Desk::new();
    let (slots, fill) = browser_fill(&desk, open());
    assert!(slots.provide(ID, VALUE) && slots.bind(ID, "S1", claim()));
    desk.reply("secret_precheck", Ok(json!({ "text": "ready", "hostId": "host-A" })));
    *desk.takeover_after.lock().unwrap() = Some("secret_precheck".into());
    assert_eq!(fill.fill_browser(&thread, ID).await, SecretOutcome::Blocked);
    assert!(!has_value(&desk.sent()), "the newer desktop never saw the value");
    assert!(!slots.has(ID), "and it is gone from the core");
}

#[tokio::test]
async fn a_request_is_bound_to_the_desktop_that_bound_its_page() {
    let desk = Desk::new();
    let (slots, fill) = browser_fill(&desk, open());
    let thread = ThreadId::from("S1");
    let inner = Page::answering(Ok(json!({})));
    let host = SecretHostCommands::new(inner.clone(), Arc::new(fill));
    let bind = json!({ "request_id": ID, "field": "password" });
    for (facts, bound) in [
        (json!({ "origin": "https://example.com", "form": "password", "length": 6 }), true),
        (json!({ "origin": "https://example.com", "form": "" }), false),
        (json!({ "origin": "", "form": "password" }), false),
        (json!({}), false),
    ] {
        slots.discard(ID);
        desk.reply("secret_bind", Ok(facts.clone()));
        assert_eq!(host.browser(&thread, "secret_bind", bind.clone(), &mixdog_rt::CancellationToken::new()).await.unwrap(), facts);
        assert_eq!(slots.browser_binding(ID), bound.then(|| BrowserBinding { session: "S1".into(), claim: claim() }), "{facts}");
    }
    desk.reply("secret_bind", Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "noClaimant".into() })));
    assert_eq!(host.browser(&thread, "secret_bind", bind, &mixdog_rt::CancellationToken::new()).await, Err(HostCommandError::NoHost));

    // `secret_input` answers the outcome only; every other command goes to the host as it is.
    slots.discard(ID);
    desk.reply("secret_bind", Ok(json!({ "origin": "https://example.com", "form": "password" })));
    host.browser(&thread, "secret_bind", json!({ "request_id": ID }), &mixdog_rt::CancellationToken::new()).await.unwrap();
    assert!(slots.provide(ID, VALUE));
    desk.reply("secret_precheck", Ok(json!({ "text": "ready", "hostId": "host-A" })));
    desk.reply("secret_fill", Ok(json!({ "text": "entered" })));
    let answered = host.browser(&thread, "secret_input", json!({ "request_id": ID }), &mixdog_rt::CancellationToken::new()).await.unwrap();
    assert_eq!(answered, json!({ "text": "entered" }));
    assert!(!answered.to_string().contains(VALUE));
    let passed = host.browser(&thread, "page_url", json!({ "tab": "t1" }), &mixdog_rt::CancellationToken::new()).await.unwrap();
    assert_eq!(passed, json!({}));
    assert_eq!(inner.sent(), vec![("page_url".to_owned(), json!({ "tab": "t1" }))]);
}

/// Each browser command of a secret request leaves its `browser_timing` row, as Node's bridge client traced its
/// `secret_bind` and `secret_input` requests (`requestBridge`); the core's fill sends `secret_precheck`, then `secret_fill`,
/// and leaves the one `secret_input` row Node does, with the answer that ended it. A row holds the action and the timing the
/// desktop answered with, never the value. A pre-check the changed claim refused leaves a row with no answer; with no desktop
/// at all nothing was sent and there is none.
#[tokio::test]
async fn each_browser_command_of_a_secret_request_leaves_its_timing_row() {
    let rows: Arc<Mutex<Vec<serde_json::Map<String, Value>>>> = Arc::default();
    let log: mixdog_tools::desktop::host::BrowserTimingLog = {
        let rows = rows.clone();
        Arc::new(move |args| rows.lock().unwrap().push(args))
    };
    let desk = Desk::new();
    let (slots, fill) = browser_fill(&desk, open());
    let host = SecretHostCommands::new(Page::answering(Ok(json!({}))), Arc::new(fill.with_timing(log)));
    let thread = ThreadId::from("S1");
    let live = mixdog_rt::CancellationToken::new();
    let bind = json!({ "request_id": ID });
    desk.reply("secret_bind", Ok(json!({ "origin": "https://example.com", "form": "password", "timing": { "commandMs": 3 } })));
    desk.reply("secret_precheck", Ok(json!({ "text": "ready", "hostId": "host-A", "timing": { "commandMs": 1 } })));
    desk.reply("secret_fill", Ok(json!({ "text": "entered", "timing": { "inputMs": 2 } })));
    host.browser(&thread, "secret_bind", bind.clone(), &live).await.unwrap();
    assert!(slots.provide(ID, VALUE));
    assert_eq!(host.browser(&thread, "secret_input", bind.clone(), &live).await.unwrap(), json!({ "text": "entered" }));

    host.browser(&thread, "secret_bind", bind.clone(), &live).await.unwrap();
    assert!(slots.provide(ID, VALUE));
    desk.claimant_changes();
    assert_eq!(host.browser(&thread, "secret_input", bind.clone(), &live).await.unwrap(), json!({ "text": "blocked" }));

    desk.reply("secret_bind", Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "noClaimant".into() })));
    assert_eq!(host.browser(&thread, "secret_bind", bind, &live).await, Err(HostCommandError::NoHost));

    let rows = rows.lock().unwrap().clone();
    assert!(!Value::from(rows.clone()).to_string().contains(VALUE), "no row holds the value");
    let seen: Vec<(Value, Option<Value>)> = rows
        .iter()
        .map(|row| {
            assert!(row["bridgeMs"].as_f64().is_some_and(|ms| ms >= 0.0), "{row:?}");
            (row["context"].clone(), row.get("body").cloned())
        })
        .collect();
    let answered = |action: &str, timing: Value| (json!({ "sessionId": "S1", "action": action }), Some(json!({ "ok": true, "value": { "timing": timing } })));
    assert_eq!(
        seen,
        [
            answered("secret_bind", json!({ "commandMs": 3 })),
            answered("secret_input", json!({ "inputMs": 2 })),
            answered("secret_bind", json!({ "commandMs": 3 })),
            (json!({ "sessionId": "S1", "action": "secret_input" }), None),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn an_overdue_entry_is_refused_even_before_its_timer_ran() {
    let slots = lasting();
    assert!(slots.provide(ID, VALUE) && slots.bind(ID, "S1", claim()) && slots.bind_computer(&format!("{ID}2"), "S1", "w1", "e1"));
    // The timers have not run (nothing was awaited): push every deadline into the past.
    {
        let mut state = slots.inner.state();
        let past = tokio::time::Instant::now() - Duration::from_millis(1);
        state.slots.values_mut().for_each(|held| held.deadline = past);
        state.bindings.values_mut().for_each(|held| held.deadline = past);
    }
    assert!(!slots.has(ID));
    assert!(slots.browser_binding(ID).is_none() && slots.computer_binding(&format!("{ID}2")).is_none());
    assert_eq!(slots.take(ID), "");
}

#[tokio::test]
async fn the_secret_never_prints_through_debug() {
    let secret = "482190-PLAINTEXT";
    let slots = Arc::new(lasting());
    let service = SecretInputService::new(slots.clone());
    let params = |id: &str, value: &str| json!({ "opId": "x", "requestId": id, "secret": value });
    // The protocol DTO, as a request would decode it.
    let dto: mixdog_app_protocol::v2::approval::ApprovalProvideSecretParams = serde_json::from_value(params(ID, secret)).unwrap();
    assert!(!format!("{dto:?}").contains(secret) && !format!("{dto:#?}").contains(secret));
    assert!(format!("{dto:?}").contains(ID));
    // The request, accepted and refused (bad id, empty value, no op id).
    for (body, op) in [(params(ID, secret), Some(1)), (params("nope", secret), Some(2)), (params(ID, ""), Some(3)), (params(ID, secret), None)] {
        let req = request("approval/provideSecret", body, op);
        assert!(!format!("{req:?}").contains(secret) && !format!("{req:#?}").contains(secret));
        let answer = value(&service, req).await;
        assert!(!format!("{answer:?}").contains(secret));
    }
    // Other methods still print their params.
    let other = request("thread/read", json!({ "threadId": "t1" }), None);
    assert!(format!("{other:?}").contains("t1"));
}
#[test]
fn redaction_follows_the_recorded_markers_and_sessions() {
    let doc = golden("redaction.json");
    for case in doc["redact"].as_array().unwrap() {
        let secrets: Vec<String> = case["secrets"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
        assert_eq!(json!(redact_secrets(text(case, "text"), &secrets, "[redacted]")), case["out"], "{}", text(case, "name"));
    }
    let recorded = doc["sessions"].as_array().unwrap();
    let sessions = SessionSecrets::new();
    let snap = |step: &str| {
        json!({
            "step": step,
            "s1": sessions.secrets_of("S1"),
            "s2": sessions.secrets_of("S2"),
            "redacted1": sessions.redact("S1", "abcdef abc ab a"),
            "redacted2": sessions.redact("S2", "abcdef abc ab a"),
            "focus1": sessions.focus_armed("S1"),
            "focus2": sessions.focus_armed("S2"),
        })
    };
    let mut got = Vec::new();
    sessions.remember("S1", "ab");
    got.push(snap("one secret"));
    sessions.remember("S1", "abc");
    sessions.remember("S1", "ab");
    got.push(snap("a longer one and a repeat"));
    sessions.remember("S1", "");
    sessions.remember("", "nope");
    sessions.remember("S2", "a");
    got.push(snap("empties are not kept; sessions are separate"));
    sessions.remember("S1", "abcdef");
    got.push(snap("the longest is replaced first"));
    sessions.arm_focus("S1");
    got.push(snap("focus is armed"));
    sessions.clear_focus("S1");
    got.push(snap("focus is cleared"));
    sessions.arm_focus("S1");
    sessions.arm_focus("S2");
    sessions.forget("S1");
    got.push(snap("forget drops the secrets and the focus of one session"));
    assert_eq!(json!(got), json!(recorded));
}

/// A paired phone submits by request id, as the card does: the service holds the value for the
/// id with no session or connection check, and the consumers enforce the binding.
#[tokio::test]
async fn a_phone_submission_is_taken_as_the_window_process_takes_it() {
    for case in golden("remote.json").as_array().unwrap() {
        let name = text(case, "name");
        let slots = Arc::new(lasting());
        let service = SecretInputService::new(slots.clone());
        if name.contains("name the session") {
            assert!(slots.bind(ID, "S1", claim()));
        }
        let id = match &case["params"][0] {
            Value::String(s) => json!(s),
            other => other.clone(),
        };
        let answered = value(&service, request("approval/provideSecret", json!({ "opId": "x", "requestId": id, "secret": case["params"][1] }), Some(1))).await;
        match &case["result"] {
            result if result["ok"] == json!(true) => {
                assert_eq!(answered.unwrap(), json!({}), "{name}");
                assert_eq!(json!(slots.take(ID)), case["taken"], "{name}");
            }
            result if result["ok"] == json!(false) => {
                assert!(answered.is_err(), "{name}");
                assert!(!slots.has(ID), "{name}");
            }
            result => {
                let CoreError::DomainError { message: Some(got), .. } = answered.unwrap_err() else { panic!("{name}: a domain error") };
                assert_eq!(&*got, text(&result["error"], "message"), "{name}");
            }
        }
    }
}

#[tokio::test]
async fn provide_secret_answers_only_that_it_was_taken() {
    let slots = Arc::new(lasting());
    let service = SecretInputService::new(slots.clone());
    let params = |id: &str, secret: &str| json!({ "opId": "x", "requestId": id, "secret": secret });
    let answered = value(&service, request("approval/provideSecret", params(" secret_0123456789ab ", "482190"), Some(1))).await.unwrap();
    assert_eq!(answered, json!({}));
    assert_eq!(slots.take(ID), "482190");
    for (bad, message) in [(params("nope", "v"), "secret was not accepted."), (params(ID, ""), "secret was not accepted."), (params("  ", "v"), "secret request id is invalid.")] {
        let CoreError::DomainError { message: Some(got), .. } = value(&service, request("approval/provideSecret", bad, Some(2))).await.unwrap_err() else { panic!("a domain error") };
        assert_eq!(&*got, message);
        assert!(!slots.has(ID));
    }
    let missing = value(&service, request("approval/provideSecret", params(ID, "v"), None)).await.unwrap_err();
    assert!(matches!(missing, CoreError::OpIdRequired));
    assert!(!slots.has(ID), "no value is kept without an op id");
    let number = json!({ "opId": "x", "requestId": 7, "secret": "v" });
    let CoreError::DomainError { message: Some(got), .. } = value(&service, request("approval/provideSecret", number, Some(3))).await.unwrap_err() else { panic!("a domain error") };
    assert_eq!(&*got, "secret request id must be a string.");
}

/// Node's five pre-fill refusals: nothing bound, another session's binding, a held takeover, a
/// page that changed, a bound page with no field. Each refuses with its outcome, drops the value,
/// sends it to no desktop and remembers nothing for redaction.
#[tokio::test]
async fn each_pre_fill_refusal_drops_the_value_and_remembers_nothing() {
    for (name, bind_session, gates, precheck, want) in [
        ("no binding", None, open(), None, SecretOutcome::Blocked),
        ("another session", Some("S2"), open(), None, SecretOutcome::Blocked),
        ("held takeover", Some("S1"), Gates { browser: false, computer: true }, None, SecretOutcome::Blocked),
        ("page changed", Some("S1"), open(), Some("page_changed"), SecretOutcome::PageChanged),
        ("no field", Some("S1"), open(), Some("no_field"), SecretOutcome::NoField),
    ] {
        let desk = Desk::new();
        let (slots, fill) = browser_fill(&desk, gates);
        let thread = ThreadId::from("S1");
        assert!(slots.provide(ID, VALUE), "{name}");
        if let Some(session) = bind_session {
            assert!(slots.bind(ID, session, claim()), "{name}");
        }
        if let Some(text) = precheck {
            desk.reply("secret_precheck", Ok(json!({ "text": text })));
        }
        assert_eq!(fill.fill_browser(&thread, ID).await, want, "{name}");
        assert!(!has_value(&desk.sent()), "{name}: no desktop saw the value");
        assert!(!slots.has(ID) && slots.browser_binding(ID).is_none(), "{name}: slots and binding dropped");
        assert_eq!(fill.redact(&thread, &format!("pw={VALUE}!")), format!("pw={VALUE}!"), "{name}: not remembered");
    }
}

/// `fill_saved_login` served by [`SavedLoginComputerBackend`]: the saved-login fill instead of the
/// backend answering `unsupported`.
mod saved_login_backend {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerError;
    use mixdog_core_api::domain::computer::ComputerRequest;
    use mixdog_core_api::domain::computer::ComputerStatus;
    use mixdog_core_api::domain::computer::DesktopIdentity;
    use mixdog_core_api::domain::computer::DisplayId;
    use mixdog_core_api::domain::computer::DisplayInfo;
    use mixdog_core_api::domain::computer::InputOutcome;
    use mixdog_core_api::domain::computer::ScreenInput;
    use mixdog_core_api::domain::media::MediaFrameSource;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_tools::desktop::host::BROWSER_UNAVAILABLE;
    use tokio_util::sync::CancellationToken;

    use super::super::SavedLoginRegistry;
    use super::super::SavedLoginTurn;
    use super::super::computer::SavedLoginComputerBackend;
    use super::super::computer::SavedLoginTurns;
    use super::*;

    const PASSWORD: &str = "Pa55-\"word\"\\x";
    const SESSION: &str = "S1";

    /// The backend that would answer `unsupported`: it counts what reaches it.
    struct Inner(AtomicUsize);

    #[async_trait]
    impl ComputerBackend for Inner {
        async fn run(&self, _: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![ToolPart::Text("inner".to_owned())])
        }
        fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            unreachable!()
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            unreachable!()
        }
        fn input_desktop(&self) -> Option<DesktopIdentity> {
            None
        }
        fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            unreachable!()
        }
        fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            unreachable!()
        }
        fn status(&self) -> ComputerStatus {
            unreachable!()
        }
    }

    /// The desktop browser host, answering the saved-login actions.
    struct Desktop {
        actions: Mutex<Vec<String>>,
        auto_login: bool,
        gone: bool,
    }

    #[async_trait]
    impl HostCommands for Desktop {
        async fn browser(&self, _: &ThreadId, action: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            self.actions.lock().unwrap().push(action.to_owned());
            if self.gone {
                return Err(HostCommandError::NoHost);
            }
            Ok(match action {
                "saved_login_admit" => json!({ "enabled": self.auto_login }),
                "saved_login_release" => json!({ "released": true }),
                _ => json!({ "enabled": self.auto_login, "value": PASSWORD, "label": "j•••e@example.com", "origin": "https://login.example.com" }),
            })
        }
        async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            unreachable!()
        }
    }

    /// The session computer helper: it proves the page and takes the write.
    struct Helper(Mutex<Vec<Value>>);

    #[async_trait]
    impl ComputerCommands for Helper {
        async fn execute(&self, _: &ThreadId, command: Value) -> Result<Value, String> {
            self.0.lock().unwrap().push(command.clone());
            Ok(match command["action"].as_str() {
                Some("window_bounds") if command["app"] == "chrome" => json!({ "window_id": "hwnd:0x1", "title": "Sign in" }),
                Some("window_bounds") => return Err("ambiguous_window_target: app \"edge\" matched 2 windows; retry with one exact window_id".to_owned()),
                Some("saved_login_check") => json!({ "saved_login_target": { "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com" } }),
                _ => json!({ "action": "fill_saved_login", "effect": "confirmed" }),
            })
        }
    }

    struct Turn(Option<u64>);

    impl SavedLoginTurns for Turn {
        fn turn(&self, _: &ThreadId) -> Option<u64> {
            self.0
        }
    }

    struct Registered(Arc<SavedLoginRegistry>);

    impl Redact for Registered {
        fn redact(&self, _: &ThreadId, text: &str) -> String {
            self.0.redact(text)
        }
    }

    struct Rig {
        backend: SavedLoginComputerBackend,
        inner: Arc<Inner>,
        desktop: Arc<Desktop>,
        helper: Arc<Helper>,
        registry: Arc<SavedLoginRegistry>,
    }

    fn rig(turn: Option<u64>, auto_login: bool, gone: bool) -> Rig {
        let inner = Arc::new(Inner(AtomicUsize::new(0)));
        let desktop = Arc::new(Desktop { actions: Mutex::new(Vec::new()), auto_login, gone });
        let helper = Arc::new(Helper(Mutex::new(Vec::new())));
        let registry = SavedLoginRegistry::new();
        let backend = SavedLoginComputerBackend::new(
            inner.clone(),
            ThreadId::from(SESSION),
            desktop.clone(),
            helper.clone(),
            registry.clone(),
            Arc::new(Registered(registry.clone())),
            Arc::new(Turn(turn)),
        );
        Rig { backend, inner, desktop, helper, registry }
    }

    fn login() -> ComputerRequest {
        ComputerRequest { action: ComputerAction::SavedLogin, input: json!({ "window_id": "hwnd:0x1", "savedAccount": "j•••e@example.com", "field": "password" }) }
    }

    fn failure(outcome: Result<Vec<ToolPart>, ComputerError>) -> (String, String) {
        match outcome {
            Err(ComputerError::Failed { code, message }) => (code, message),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_saved_login_fill_is_served_by_the_vault_and_the_helper_and_the_value_stays_out_of_the_reply() {
        let rig = rig(Some(7), true, false);
        let parts = rig.backend.run(login(), CancellationToken::new()).await.unwrap();
        let [ToolPart::Text(text)] = parts.as_slice() else { panic!("one text part") };
        assert!(!text.contains("Pa55"), "the reply carries no value");
        let reply: Value = serde_json::from_str(text).unwrap();
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["action"], "saved_login");
        // The host's reply of a semantic action: what the write did, how it was delivered, the window, and the verdict.
        assert_eq!(reply["effect"], "confirmed");
        assert_eq!(reply["delivery"], "background");
        assert_eq!(reply["window_id"], "hwnd:0x1");
        assert_eq!(reply["verified"], false);
        assert_eq!(reply["verdict"]["decision"], "verify_fresh_state");
        assert_eq!(reply["saved_login"], json!({ "account": "j•••e@example.com", "origin": "https://login.example.com", "field": "password" }));
        assert!(reply["message"].as_str().unwrap().starts_with("filled the saved password of j•••e@example.com"));
        assert_eq!(rig.inner.0.load(Ordering::SeqCst), 0, "the backend never saw the action");
        assert_eq!(*rig.desktop.actions.lock().unwrap(), ["saved_login_admit", "saved_login_value", "saved_login_release"]);
        let sent = rig.helper.0.lock().unwrap().clone();
        assert_eq!(sent.iter().map(|command| command["action"].as_str().unwrap()).collect::<Vec<_>>(), ["saved_login_check", "saved_login_type"]);
        assert!(sent.iter().all(|command| command["session_id"] == SESSION && command["window_id"] == "hwnd:0x1"));
        // The password is hidden from later replies, and the pixels of its browser are withheld until the turn settles.
        assert_eq!(rig.registry.redact(&format!("x {PASSWORD} y")), "x [saved login] y");
        let capture = ComputerRequest { action: ComputerAction::Capture, input: json!({ "window_id": "hwnd:0x1" }) };
        assert!(failure(rig.backend.run(capture.clone(), CancellationToken::new()).await).1.starts_with("capture_withheld"));
        let ax = ComputerRequest { action: ComputerAction::Capture, input: json!({ "window_id": "hwnd:0x1", "mode": "ax" }) };
        rig.backend.run(ax, CancellationToken::new()).await.unwrap();
        rig.registry.settle(&SavedLoginTurn { session: SESSION.to_owned(), turn: 7 }).await;
        rig.backend.run(capture, CancellationToken::new()).await.unwrap();
    }

    /// A command that names its window by app is resolved to the app's one window first (`resolveAppWindowId`), and a refusal of
    /// that resolution is the fill's refusal with nothing sent to the desktop.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_fill_that_names_an_app_is_made_in_the_apps_window() {
        let chrome = rig(Some(7), true, false);
        let by_app = ComputerRequest { action: ComputerAction::SavedLogin, input: json!({ "app": "chrome", "savedAccount": "j•••e@example.com", "field": "password" }) };
        chrome.backend.run(by_app, CancellationToken::new()).await.unwrap();
        let sent = chrome.helper.0.lock().unwrap().clone();
        assert_eq!(sent.iter().map(|command| command["action"].as_str().unwrap()).collect::<Vec<_>>(), ["window_bounds", "saved_login_check", "saved_login_type"]);
        assert_eq!(sent[0], json!({ "action": "window_bounds", "session_id": SESSION, "app": "chrome" }));
        assert!(sent[1..].iter().all(|command| command["window_id"] == "hwnd:0x1"));

        let edge = rig(Some(8), true, false);
        let by_app = ComputerRequest { action: ComputerAction::SavedLogin, input: json!({ "app": "edge", "savedAccount": "j•••e@example.com", "field": "password" }) };
        let (code, message) = failure(edge.backend.run(by_app, CancellationToken::new()).await);
        assert_eq!(code, "ambiguous_window_target");
        assert!(message.contains("retry with one exact window_id"));
        assert!(edge.desktop.actions.lock().unwrap().is_empty(), "nothing reached the desktop");
    }

    /// The agent turn a fill is scoped to is the session's running one; its settlement (the actor's `turn_settled`) lifts the
    /// redaction and the pixel guard of that turn, and a session that ends lifts all of its own.
    #[tokio::test]
    async fn a_turns_settlement_lifts_its_fills_redaction_and_pixel_guard() {
        use crate::session::turn_snapshots::TurnSnapshots;

        use super::super::computer::SavedLoginTurnClock;
        use super::super::computer::SettlingSavedLogins;

        #[derive(Default)]
        struct Calls(Mutex<Vec<String>>);
        impl TurnSnapshots for Calls {
            fn turn_settled(&self, thread: &ThreadId) {
                self.0.lock().unwrap().push(format!("settled {}", thread.as_str()));
            }
            fn runtime_stopped(&self, thread: &ThreadId) {
                self.0.lock().unwrap().push(format!("stopped {}", thread.as_str()));
            }
            fn dispose(&self) {
                self.0.lock().unwrap().push("dispose".to_owned());
            }
        }
        async fn until(what: &str, mut done: impl FnMut() -> bool) {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !done() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{what}"));
        }
        let registry = SavedLoginRegistry::new();
        let inner = Arc::new(Calls::default());
        let clock = SavedLoginTurnClock::new(registry.clone());
        let snapshots = SettlingSavedLogins::new(inner.clone(), clock.clone());
        let thread = ThreadId::from(SESSION);
        assert_eq!(clock.turn(&thread), Some(1), "the first turn is turn 1");
        let first = SavedLoginTurn { session: SESSION.to_owned(), turn: 1 };
        assert!(registry.remember(&first, &[PASSWORD.to_owned()]));
        assert!(registry.arm_pixels(super::super::PixelGuard { turn: first, window_id: "hwnd:0x1".to_owned(), pid: "4242".to_owned() }));
        assert_eq!(registry.redact(PASSWORD), "[saved login]");
        snapshots.turn_settled(&thread);
        until("turn 1 to settle", || registry.spellings().is_empty() && registry.pixel_guards().is_empty()).await;
        assert_eq!(clock.turn(&thread), Some(2), "the next turn is turn 2");
        assert_eq!(registry.redact(PASSWORD), PASSWORD);
        assert_eq!(*inner.0.lock().unwrap(), ["settled S1"], "the wrapped snapshots still settle");
        // A fill of turn 2 dies with its session.
        let second = SavedLoginTurn { session: SESSION.to_owned(), turn: 2 };
        assert!(registry.remember(&second, &[PASSWORD.to_owned()]));
        snapshots.runtime_stopped(&thread);
        until("the session to be forgotten", || registry.spellings().is_empty()).await;
        assert_eq!(inner.0.lock().unwrap().last().map(String::as_str), Some("stopped S1"));
        // Another session counts its own turns.
        assert_eq!(clock.turn(&ThreadId::from("S2")), Some(1));
        snapshots.dispose();
        assert_eq!(inner.0.lock().unwrap().last().map(String::as_str), Some("dispose"));
    }

    #[tokio::test]
    async fn a_fill_with_no_agent_turn_no_desktop_or_auto_login_off_sends_nothing() {
        let no_turn = rig(None, true, false);
        let (code, message) = failure(no_turn.backend.run(login(), CancellationToken::new()).await);
        assert_eq!(code, "saved_login_unavailable");
        assert!(message.contains("no runtime and agent turn") && no_turn.desktop.actions.lock().unwrap().is_empty());

        let gone = rig(Some(7), true, true);
        let (code, message) = failure(gone.backend.run(login(), CancellationToken::new()).await);
        assert_eq!(code, "saved_login_unavailable");
        assert!(message.contains(BROWSER_UNAVAILABLE), "{message}");

        let off = rig(Some(7), false, false);
        let (code, message) = failure(off.backend.run(login(), CancellationToken::new()).await);
        assert_eq!(code, "saved_login_unavailable");
        assert!(message.ends_with("no input was sent"), "{message}");
        assert!(off.helper.0.lock().unwrap().is_empty() && off.registry.spellings().is_empty());
        assert!(!off.desktop.actions.lock().unwrap().iter().any(|action| action == "saved_login_value"));
    }

    #[tokio::test]
    async fn every_other_action_goes_to_the_backend() {
        let rig = rig(Some(7), true, false);
        let list = ComputerRequest { action: ComputerAction::List, input: json!({}) };
        assert_eq!(rig.backend.run(list, CancellationToken::new()).await.unwrap().len(), 1);
        assert_eq!(rig.inner.0.load(Ordering::SeqCst), 1);
        assert!(rig.desktop.actions.lock().unwrap().is_empty());
    }
}
