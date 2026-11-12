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
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

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

    /// The `error.data` of the answer to `method` called with `params` while the service refuses with `thrown`.
    async fn refused(&self, client: &Client, id: i64, thrown: &Value, method: &str, params: Value) -> Value {
        *self.service.thrown.lock().unwrap() = thrown.clone();
        client.request(id, method, params);
        let frame = client.response(id).await;
        assert!(frame.get("error").is_some(), "{method}: {frame}");
        frame["error"]["data"].clone()
    }
}

/// The wire error a Node relay frame stands for: its text, code and public params.
fn wire_of(frame: &Value) -> Value {
    let code = frame.get("errorCode").and_then(Value::as_str);
    let mut data = json!({ "reason": "domainError", "domain": "room", "message": frame["error"] });
    if let Some(code) = code {
        data["code"] = json!(code);
    }
    if let Some(params) = frame.get("errorParams") {
        data["detail"] = json!({ "type": detail_tag(code.unwrap()).unwrap(), "name": params["name"] });
    }
    data
}

#[tokio::test(start_paused = true)]
async fn a_phone_is_answered_the_frame_nodes_relay_sent_for_each_refusal_shape() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let case = recorded("the relay answers a refusal");
    for (n, row) in case["observed"]["answered"].as_array().unwrap().iter().enumerate() {
        let (method, params) = wire_call(row["method"].as_str().unwrap(), &row["params"], &format!("op-{n}"));
        let data = world.refused(&phone, 10 + n as i64, &row["thrown"], method, params).await;
        assert_eq!(data, wire_of(&row["frame"]), "{}", row["why"]);
    }
}

#[tokio::test(start_paused = true)]
async fn the_recorded_refusals_of_a_send_reach_a_phone_as_nodes_frames_do() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let named = recorded("a send to a switched-off room member")["observed"].clone();
    let data = world.refused(&phone, 10, &named["original"], "room/send", json!({ "opId": "op-a", "input": {} })).await;
    assert_eq!(data, wire_of(&named["relayFrame"]));
    let params = recorded("error params are whitelisted")["observed"].clone();
    let file = json!({ "message": params["fileFrame"]["error"], "code": params["fileFrame"]["errorCode"], "details": null });
    let data = world.refused(&phone, 11, &file, "room/send", json!({ "opId": "op-b", "input": {} })).await;
    assert_eq!(data, wire_of(&params["fileFrame"]));
}

/// Node's relay is the only leg that redacts and whitelists: a desktop on the loopback is told the failure whole.
#[tokio::test(start_paused = true)]
async fn a_local_client_is_told_the_failure_whole() {
    let world = World::new();
    let local = world.client(1, Origin::Local);
    let thrown = json!({ "message": "401 for key my-secret-value", "code": "WORKTREE_DIRTY", "details": { "files": ["C:/path.txt"] } });
    let params = json!({ "opId": "op-1", "providerId": "anthropic", "secret": "my-secret-value" });
    let data = world.refused(&local, 10, &thrown, "account/saveProviderApiKey", params).await;
    assert_eq!(data["message"], "401 for key my-secret-value");
    assert_eq!(data["detail"], json!({ "type": "worktreeDirty", "files": ["C:/path.txt"] }));
}
