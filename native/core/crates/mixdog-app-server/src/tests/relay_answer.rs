//! What a paired phone is told of a failed request: the answer the server writes for a refusal, whole. A relay connection is told
//! the message, the code and the typed detail of a code that declares public params, with the strings of its own call that are
//! secrets removed; a local client is told the failure whole. A service that refuses with the thrown error stands where the room,
//! account and MCP services stand.

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

/// Every method a call below reaches, refused with the error the host threw.
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

/// The error the core's own service would refuse with for what the host threw: the code's typed detail carries `details`.
fn core_error(thrown: &Value) -> CoreError {
    let code = thrown["code"].as_str();
    let detail = code.and_then(detail_tag).filter(|_| thrown["details"].is_object()).map(|tag| {
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

/// The secret of the call the refusals below are about; it is long enough to count as one.
const SECRET: &str = "my-secret-value";

/// What the host threw for a call that carried [`SECRET`]: its text and a public param name both contain it.
fn thrown_with_secret() -> Value {
    json!({ "message": "401 for key my-secret-value", "code": "ROOM_MEMBER_SWITCHED_OFF", "details": { "name": "Rel-my-secret-value-x" } })
}

/// A save of a provider key, the call whose own strings are secrets.
fn key_call(secret: &str, op: &str) -> Value {
    json!({ "opId": op, "providerId": "anthropic", "secret": secret })
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

/// The first `error` notification the client is written, whatever else is written before it.
async fn error_notification(client: &Client) -> Value {
    for _ in 0..5_000 {
        if let Some(wire) = client.drain().into_iter().find(|wire| wire.body["method"] == "error") {
            return wire.body;
        }
        super::pause().await;
    }
    panic!("no error notification was written");
}

/// The relay is the only leg that redacts and whitelists: a desktop on the loopback is told the failure whole.
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

/// The whole answer a phone gets for a refusal: the wire error of the core's request error, its `data` carrying the message, the
/// code and the typed detail the phone may read.
fn told(id: i64, message: &str, code: Option<&str>, detail: Option<Value>) -> Value {
    let mut data = json!({ "reason": "domainError", "domain": "room", "message": message });
    if let Some(code) = code {
        data["code"] = json!(code);
    }
    if let Some(detail) = detail {
        data["detail"] = detail;
    }
    json!({ "id": id, "error": { "code": mixdog_app_protocol::error::INVALID_REQUEST, "message": "domainError", "data": data } })
}

/// What a phone is told of a refusal: the strings of its own call that are long enough to be a secret are removed from the
/// message and from the public param, in the escaped forms a JSON body gives them too; a string under six characters is no secret.
#[tokio::test(start_paused = true)]
async fn a_phone_is_told_a_refusal_without_the_secrets_of_its_own_call() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let cases = [
        ("the secret is removed from the message", key_call(SECRET, "op-0"), json!({ "message": "401 for key my-secret-value", "code": null, "details": null }), "401 for key [redacted]", None),
        (
            "every string of the call that is long enough is a secret",
            key_call(SECRET, "op-1"),
            json!({ "message": "anthropic refused my-secret-value", "code": null, "details": null }),
            "[redacted] refused [redacted]",
            None,
        ),
        (
            "the secret as a JSON body escapes it is removed too",
            json!({ "opId": "op-2", "providerId": "p", "secret": "pa\"ss\\word99" }),
            json!({ "message": "bad body {\"secret\":\"pa\\\"ss\\\\word99\"} and pa\"ss\\word99", "code": null, "details": null }),
            "bad body {\"secret\":\"[redacted]\"} and [redacted]",
            None,
        ),
        ("a string under six characters is no secret", json!({ "opId": "op-3", "providerId": "p", "secret": "abc12" }), json!({ "message": "key abc12 refused", "code": null, "details": null }), "key abc12 refused", None),
    ];
    for (n, (why, params, thrown, message, code)) in cases.into_iter().enumerate() {
        let answer = world.refused(&phone, n as i64 + 1, &thrown, "account/saveProviderApiKey", params).await;
        assert_eq!(answer, told(n as i64 + 1, message, code, None), "{why}");
    }
}

/// A refusal's params reach a phone only for a code that declares them, and only as that code's typed detail, redacted like the text.
#[tokio::test(start_paused = true)]
async fn a_phone_is_told_the_public_params_of_a_refusal_code_and_no_others() {
    let world = World::new();
    let phone = world.client(1, Origin::Relay);
    let switched_off = json!({ "message": "\"Release\" is switched off.", "code": "ROOM_MEMBER_SWITCHED_OFF", "details": { "name": "Release" } });
    let answer = world.refused(&phone, 1, &switched_off, "room/send", json!({ "opId": "op-a", "input": {} })).await;
    assert_eq!(answer, told(1, "\"Release\" is switched off.", Some("ROOM_MEMBER_SWITCHED_OFF"), Some(json!({ "type": "roomMemberSwitchedOff", "name": "Release" }))));

    let bare = json!({ "message": "\"Release\" is switched off.", "code": "ROOM_MEMBER_SWITCHED_OFF", "details": null });
    let answer = world.refused(&phone, 2, &bare, "room/send", json!({ "opId": "op-b", "input": {} })).await;
    assert_eq!(answer, told(2, "\"Release\" is switched off.", Some("ROOM_MEMBER_SWITCHED_OFF"), None), "a code with no params carries none");

    let other = json!({ "message": "x", "code": "ENOENT", "details": null });
    let answer = world.refused(&phone, 3, &other, "room/send", json!({ "opId": "op-c", "input": {} })).await;
    assert_eq!(answer, told(3, "x", Some("ENOENT"), None), "a code that declares no param is told as its code only");

    let secret_param = thrown_with_secret();
    let answer = world.refused(&phone, 4, &secret_param, "account/saveProviderApiKey", key_call(SECRET, "op-d")).await;
    assert_eq!(
        answer,
        told(4, "401 for key [redacted]", Some("ROOM_MEMBER_SWITCHED_OFF"), Some(json!({ "type": "roomMemberSwitchedOff", "name": "Rel-[redacted]-x" })))
    );
}

/// The relay keeps no outcome: the same failed call, asked again from another connection, fails afresh and is told as the first
/// time was; and no frame it ever sent carries the call's secret.
#[tokio::test(start_paused = true)]
async fn a_phone_that_asks_again_is_told_the_failure_afresh() {
    let world = World::new();
    let thrown = thrown_with_secret();
    let phone = world.client(1, Origin::Relay);
    let first = world.refused(&phone, 1, &thrown, "account/saveProviderApiKey", key_call(SECRET, "op-1")).await;
    // After a reconnect: a second connection, the same call.
    let phone = world.client(2, Origin::Relay);
    let again = world.refused(&phone, 1, &thrown, "account/saveProviderApiKey", key_call(SECRET, "op-1")).await;
    assert_eq!(first, again);
    assert!(!first.to_string().contains(SECRET) && !again.to_string().contains(SECRET));
}
/// What the core stored of a rejection, read back through `op/status`: a relay connection is not told the secret of the call, and
/// its read differs from a local client's, which is whole, only by the text and the params a relay is not told.
#[tokio::test(start_paused = true)]
async fn a_stored_rejection_read_by_a_phone_carries_no_secret_of_its_call() {
    let world = World::new();
    let secret = SECRET;
    let stored = core_error(&thrown_with_secret());
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
#[tokio::test(start_paused = true)]
async fn a_paired_client_can_read_push_outcomes_but_not_stored_provisioning_replies() {
    let world = World::new();
    let scope = OpScope::Domain("remoteAccess".into());
    let provisioning = json!({ "info": { "relay": { "token": "test-token" } }, "pairCode": { "code": "012345" } });
    let index = world.rig.core.mock.op_index();
    index.set(scope.clone(), OpId::from("op-host"), OpStatus::Applied { seq: None, result: Some(provisioning.clone()) });
    index.set(scope, OpId::from("op-push"), OpStatus::Applied { seq: None, result: Some(json!(true)) });
    for (connection, origin) in [(1, Origin::Local), (2, Origin::Relay)] {
        let client = world.client(connection, origin);
        client.request(1, "op/status", json!({ "scope": "remoteAccess", "opIds": ["op-host", "op-push"], "fence": false }));
        let answer = client.response(1).await;
        let host = if origin == Origin::Local {
            json!({ "opId": "op-host", "state": "applied", "result": provisioning })
        } else {
            json!({ "opId": "op-host", "state": "applied" })
        };
        assert_eq!(answer["result"]["ops"], json!([host, { "opId": "op-push", "state": "applied", "result": true }]));
    }
}

/// A rejected answer of a server request, told to the connection that sent it: whole to a local client, without the secret to a
/// relay connection.
#[tokio::test(start_paused = true)]
async fn a_rejected_answer_told_to_a_phone_carries_no_secret_of_its_call() {
    let world = World::new();
    let secret = SECRET;
    let (phone, local) = (world.client(2, Origin::Relay), world.client(3, Origin::Local));
    let announced = |client: &Client| client.drain().into_iter().map(|wire| wire.body.to_string()).collect::<Vec<_>>();
    world.rig.outgoing.response_rejected(ConnectionId(2), core_error(&thrown_with_secret()));
    world.rig.outgoing.response_rejected(ConnectionId(3), core_error(&thrown_with_secret()));
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
    let secret = SECRET;
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
    handle.actor.refuse_with(core_error(&thrown_with_secret()));
    phone.send(json!({ "id": "ap1", "result": { "approved": true } }));
    local.send(json!({ "id": "ap1", "result": { "approved": true } }));
    // The writer flushes after the answer is handled, and the asks' own frames may still be on their way: wait for the
    // `error` notification itself, then see that no second one follows.
    let (told, whole) = (error_notification(&phone).await, error_notification(&local).await);
    super::pause().await;
    assert_eq!((phone.drain().iter().filter(|w| w.body["method"] == "error").count(), local.drain().iter().filter(|w| w.body["method"] == "error").count()), (0, 0), "told once");
    assert!(whole.to_string().contains(secret), "a local client is told whole: {whole}");
    let mut expected = whole;
    let error = expected["params"]["error"]["data"].as_object_mut().unwrap();
    error.remove("message");
    error.remove("detail");
    // Each frame is stamped when it is written (`emittedAtMs`, the wall clock): the two were written a moment apart.
    let mut told = told;
    for frame in [&mut told, &mut expected] {
        assert!(frame["emittedAtMs"].is_number(), "{frame}");
        frame.as_object_mut().unwrap().remove("emittedAtMs");
    }
    assert_eq!(told, expected);
}
