//! What a paired phone is told of a failed request (`fixtures/composer-submit-error-cases`, recorded by
//! `record-composer-submit-error-cases.mjs`): the relay answer frame of Node's `executeRemoteFrame`, whole, against the error the
//! server writes for the same refusal. Node's frame `error` is the wire error's `message`, `errorCode` its `code`, `errorParams`
//! its `detail`. A service that refuses with the thrown error stands where the room, account and MCP services stand.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use mixdog_core_api::service::Admit;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use super::actor::ActorThread;
use super::actor::ApprovalActor;
use super::Client;
use super::Rig;
use super::VERSION;

const RECORDED: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/composer-submit-error-cases/golden.json");

fn recorded(prefix: &str) -> Value {
    let all: Value = serde_json::from_str(&RECORDED).unwrap();
    all["cases"].as_array().unwrap().iter().find(|case| case["case"].as_str().unwrap().starts_with(prefix)).unwrap_or_else(|| panic!("no recorded case {prefix}")).clone()
}

/// Every method a recorded call reaches, refused with the error Node's host threw.
#[derive(Default)]
struct Refuses {
    thrown: Mutex<Value>,
}

const METHODS: &[&str] = &["room/send", "account/saveProviderApiKey", "mcp/completeMcpOAuthLogin", "connector/addConnectorAccount", "mcp/saveMcpServer", "approval/provideSecret"];

/// The wire tag of the typed detail of a code that declares a public param.
fn detail_tag(code: &str) -> Option<&'static str> {
    Some(match code {
        "ROOM_MEMBER_SWITCHED_OFF" => "roomMemberSwitchedOff",
        "SCHEDULE_NAME_TAKEN" => "scheduleNameTaken",
        "SCHEDULE_RENAME_RUNNING" => "scheduleRenameRunning",
        "SCHEDULE_RENAME_RELOAD_FAILED" => "scheduleRenameReloadFailed",
        "WORKTREE_DIRTY" => "worktreeDirty",
        _ => return None,
    })
}

/// The error the core's own service would refuse with for what Node's host threw: the code's typed detail carries `details`.
fn core_error(thrown: &Value) -> CoreError {
    let code = thrown["code"].as_str();
    let detail = code.and_then(detail_tag).map(|tag| {
        let mut detail = thrown["details"].as_object().cloned().unwrap_or_default();
        detail.insert("type".to_owned(), json!(tag));
        Box::new(serde_json::from_value(Value::Object(detail)).expect("a typed detail"))
    });
    CoreError::DomainError { domain: "room".into(), code: code.map(|code| code.into()), message: thrown["message"].as_str().map(|message| message.into()), detail }
}

#[async_trait]
impl DomainService for Refuses {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, _: CoreRequest) -> Result<Reply, CoreError> {
        Err(core_error(&self.thrown.lock().unwrap()))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

/// The wire call for what the phone sent Node: a capability's arguments are the params of its method (a wrapped call carries them as
/// `input`); a handoff secret is `approval/provideSecret`'s; `send` is `room/send`.
fn wire_call(method: &str, params: &Value, op: &str) -> (&'static str, Value) {
    match method {
        "invokeCapability" => {
            let args = params[0]["args"].clone();
            let (wire, wrapped) = match params[0]["capability"].as_str().unwrap() {
                "saveProviderApiKey" => ("account/saveProviderApiKey", false),
                "completeMcpOAuthLogin" => ("mcp/completeMcpOAuthLogin", false),
                "addConnectorAccount" => ("connector/addConnectorAccount", true),
                "saveMcpServer" => ("mcp/saveMcpServer", true),
                other => panic!("no method for the capability {other}"),
            };
            let mut wire_params = if wrapped { json!({ "input": args }) } else { args };
            wire_params["opId"] = json!(op);
            (wire, wire_params)
        }
        "provideSecretInput" => ("approval/provideSecret", json!({ "opId": op, "requestId": params[0], "secret": params[1] })),
        "send" => ("room/send", json!({ "opId": op, "input": params.get(0).cloned().unwrap_or_else(|| json!({})) })),
        other => panic!("no method for {other}"),
    }
}

struct World {
    rig: Rig,
    service: Arc<Refuses>,
}

impl World {
    fn new() -> Self {
        let rig = Rig::new();
        let service = Arc::new(Refuses::default());
        rig.core.serve(service.clone());
        Self { rig, service }
    }

    fn client(&self, id: u64, origin: Origin) -> Client {
        let client = self.rig.connect(id, origin);
        client.initialize(VERSION, json!({}));
        let frames = client.drain();
        assert_eq!(frames.len(), 1, "initialize response only: {frames:?}");
        client
    }

    /// The whole answer frame to `method` called with `params` (as request `id`) while the service refuses with `thrown`.
    async fn refused(&self, client: &Client, id: i64, thrown: &Value, method: &str, params: Value) -> Value {
        *self.service.thrown.lock().unwrap() = thrown.clone();
        client.request(id, method, params);
        client.response(id).await
    }
}

/// The whole answer frame a Node relay frame stands for. Node's members map to the JSON-RPC ones: `id` to `id` (the replay sends
/// the recorded one), `ok: false` to an `error` member in place of a `result`, `error` / `errorCode` / `errorParams` to the
/// `data`'s message, code and detail; the error's own `code` and `message` are the constants of the core's request error. A member of Node's frame this does not name fails the replay.
fn wire_frame(frame: &Value) -> Value {
    for key in frame.as_object().unwrap().keys() {
        assert!(["id", "ok", "error", "errorCode", "errorParams"].contains(&key.as_str()), "a member of Node's frame the replay does not map: {key}");
    }
    assert_eq!(frame["ok"], json!(false), "the replay maps refusals only");
    let code = frame.get("errorCode").and_then(Value::as_str);
    let mut data = json!({ "reason": "domainError", "domain": "room", "message": frame["error"] });
    if let Some(code) = code {
        data["code"] = json!(code);
    }
    if let Some(params) = frame.get("errorParams") {
        data["detail"] = json!({ "type": detail_tag(code.unwrap()).unwrap(), "name": params["name"] });
    }
    json!({ "id": frame["id"], "error": { "code": mixdog_app_protocol::error::INVALID_REQUEST, "message": "domainError", "data": data } })
}

#[tokio::test(start_paused = true)]
async fn a_phone_is_answered_the_frame_nodes_relay_sent_for_each_refusal_shape() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let case = recorded("the relay answers a refusal");
    for (n, row) in case["observed"]["answered"].as_array().unwrap().iter().enumerate() {
        let (method, params) = wire_call(row["method"].as_str().unwrap(), &row["params"], &format!("op-{n}"));
        let answer = world.refused(&phone, row["frame"]["id"].as_i64().unwrap(), &row["thrown"], method, params).await;
        assert_eq!(answer, wire_frame(&row["frame"]), "{}", row["why"]);
    }
}

#[tokio::test(start_paused = true)]
async fn the_recorded_refusals_of_a_send_reach_a_phone_as_nodes_frames_do() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let named = recorded("a send to a switched-off room member")["observed"].clone();
    let answer = world.refused(&phone, named["relayFrame"]["id"].as_i64().unwrap(), &named["original"], "room/send", json!({ "opId": "op-a", "input": {} })).await;
    assert_eq!(answer, wire_frame(&named["relayFrame"]));
    let params = recorded("error params are whitelisted")["observed"].clone();
    let file = json!({ "message": params["fileFrame"]["error"], "code": params["fileFrame"]["errorCode"], "details": null });
    let answer = world.refused(&phone, params["fileFrame"]["id"].as_i64().unwrap(), &file, "room/send", json!({ "opId": "op-b", "input": {} })).await;
    assert_eq!(answer, wire_frame(&params["fileFrame"]));
}

/// Node's relay keeps no outcome (`the relay keeps no outcome`): the same failed call, asked again from another connection, fails
/// afresh and is told as the first time was, whole; and no frame it ever sent carries the call's secret.
#[tokio::test(start_paused = true)]
async fn a_phone_that_asks_again_is_told_the_failure_afresh_as_nodes_relay_told_it() {
    let world = World::new();
    let case = recorded("the relay keeps no outcome")["observed"].clone();
    let secret = case["secret"].as_str().unwrap();
    let (method, params) = wire_call(case["call"]["method"].as_str().unwrap(), &case["call"]["params"], "op-1");
    let phone = world.client(1, Origin::Relay);
    let first = world.refused(&phone, case["first"]["id"].as_i64().unwrap(), &case["thrown"], method, params.clone()).await;
    assert_eq!(first, wire_frame(&case["first"]));
    // After a reconnect: a second connection, the same call.
    let phone = world.client(2, Origin::Relay);
    let again = world.refused(&phone, case["again"]["id"].as_i64().unwrap(), &case["thrown"], method, params).await;
    assert_eq!(again, wire_frame(&case["again"]));
    let leaks = case["secretInFrames"].as_array().unwrap();
    assert_eq!([first.to_string().contains(secret), again.to_string().contains(secret)], [leaks[0].as_bool().unwrap(), leaks[1].as_bool().unwrap()]);
}

/// What the core stored of a rejection, read back through `op/status`: a relay connection is not told the secret of the call, and
/// its read differs from a local client's, which is whole, only by the text and the params a relay is not told.
#[tokio::test(start_paused = true)]
async fn a_stored_rejection_read_by_a_phone_carries_no_secret_of_its_call() {
    let world = World::new();
    let case = recorded("the relay keeps no outcome")["observed"].clone();
    let secret = case["secret"].as_str().unwrap();
    let stored = core_error(&case["thrown"]);
    world.rig.core.mock.op_index().set(OpScope::Domain("account".into()), OpId::from("op-1"), OpStatus::Rejected { error: stored });
    async fn read(client: &Client, id: i64) -> Value {
        client.request(id, "op/status", json!({ "scope": "account", "opIds": ["op-1"], "fence": false }));
        client.response(id).await
    }
    let local = world.client(3, Origin::Local);
    let whole = read(&local, 40).await;
    assert!(whole.to_string().contains(secret), "a local client reads the rejection whole: {whole}");
    let phone = world.client(2, Origin::Relay);
    let told = read(&phone, 41).await;
    assert!(!told.to_string().contains(secret), "{told}");
    let mut expected = whole;
    expected["id"] = json!(41);
    let error = expected["result"]["ops"][0]["error"]["data"].as_object_mut().unwrap();
    error.remove("message");
    error.remove("detail");
    assert_eq!(told, expected);
}

/// A rejected answer of a server request, told to the connection that sent it: whole to a local client, without the secret to a
/// relay connection.
#[tokio::test(start_paused = true)]
async fn a_rejected_answer_told_to_a_phone_carries_no_secret_of_its_call() {
    let world = World::new();
    let case = recorded("the relay keeps no outcome")["observed"].clone();
    let secret = case["secret"].as_str().unwrap();
    let (phone, local) = (world.client(2, Origin::Relay), world.client(3, Origin::Local));
    let announced = |client: &Client| client.drain().into_iter().map(|wire| wire.body.to_string()).collect::<Vec<_>>();
    world.rig.outgoing.response_rejected(ConnectionId(2), core_error(&case["thrown"]));
    world.rig.outgoing.response_rejected(ConnectionId(3), core_error(&case["thrown"]));
    let (relay, local) = (announced(&phone), announced(&local));
    assert_eq!((relay.len(), local.len()), (1, 1));
    assert!(!relay[0].contains(secret), "{}", relay[0]);
    assert!(local[0].contains(secret), "a local client is told whole: {}", local[0]);
}

/// A decision the thread's `decide` itself refuses (not `response_rejected`): the sender is told by an `error` notification, whole
/// to a local client and, to a relay connection, without the text and the params it may not read.
#[tokio::test(start_paused = true)]
async fn a_decision_refused_by_decide_is_told_a_phone_without_the_secret_and_a_local_client_whole() {
    let world = World::new();
    let case = recorded("the relay keeps no outcome")["observed"].clone();
    let secret = case["secret"].as_str().unwrap();
    let thread = world.rig.core.mock.directory().insert(ThreadId::from("t1"));
    let handle = Arc::new(ActorThread { thread, actor: ApprovalActor::new("t1", world.rig.outgoing.clone()) });
    world.rig.core.load("t1", handle.clone());
    let connect = |id: u64, origin: Origin| {
        let client = world.rig.connect(id, origin);
        client.initialize(VERSION, json!({ "approvalsInbox": true }));
        client
    };
    let (phone, local) = (connect(2, Origin::Relay), connect(3, Origin::Local));
    handle.actor.ask("ap1", "t1", &[], None);
    handle.actor.refuse_with(core_error(&case["thrown"]));
    phone.drain();
    local.drain();
    phone.send(json!({ "id": "ap1", "result": { "approved": true } }));
    local.send(json!({ "id": "ap1", "result": { "approved": true } }));
    let (told, whole) = (phone.drain(), local.drain());
    assert_eq!((told.len(), whole.len()), (1, 1));
    let (told, whole) = (told[0].body.clone(), whole[0].body.clone());
    assert!(whole.to_string().contains(secret), "a local client is told whole: {whole}");
    let mut expected = whole;
    let error = expected["params"]["error"]["data"].as_object_mut().unwrap();
    error.remove("message");
    error.remove("detail");
    assert_eq!(told, expected);
}

/// Node's relay is the only leg that redacts and whitelists: a desktop on the loopback is told the failure whole.
#[tokio::test(start_paused = true)]
async fn a_local_client_is_told_the_failure_whole() {
    let world = World::new();
    let local = world.client(1, Origin::Local);
    let thrown = json!({ "message": "401 for key my-secret-value", "code": "WORKTREE_DIRTY", "details": { "files": ["C:/path.txt"] } });
    let params = json!({ "opId": "op-1", "providerId": "anthropic", "secret": "my-secret-value" });
    let data = world.refused(&local, 10, &thrown, "account/saveProviderApiKey", params).await["error"]["data"].clone();
    assert_eq!(data["message"], "401 for key my-secret-value");
    assert_eq!(data["detail"], json!({ "type": "worktreeDirty", "files": ["C:/path.txt"] }));
}
