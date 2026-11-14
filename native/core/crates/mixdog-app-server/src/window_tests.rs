//! The window gate, the initialize refusal, the validators and the blob references, in the order the server applies them.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::boundary::validate;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_protocol::Origin;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use crate::param_refs::ParamRefs;
use crate::tests::Client;
use crate::tests::Rig;
use crate::tests::VERSION;
use crate::tests::reason;

/// A rig whose connections 1 (main) and 2 (server role, for connection `c-9`) are windows; every other connection is not.
fn rig() -> Rig {
    let rig = Rig::new();
    let scope = |id: ConnectionId| match id.0 {
        1 => Some(WindowScope { id: Arc::from("w-1"), role: WindowRole::Main }),
        2 => Some(WindowScope { id: Arc::from("w-1"), role: WindowRole::Server { connection_id: "c-9".to_owned() } }),
        _ => None,
    };
    assert!(rig.server.set_window_of(Arc::new(scope)).is_ok());
    rig
}

async fn ready(rig: &Rig, id: u64, capabilities: Value) -> (Client, Value) {
    let client = rig.connect(id, Origin::Local);
    client.initialize(VERSION, capabilities);
    let response = client.response(0).await;
    (client, response)
}

fn denied(response: &Value, method: &str) -> bool {
    response["error"]["data"]["reason"] == json!("permissionDenied") && response["error"]["data"]["method"] == json!(method)
}

#[tokio::test(start_paused = true)]
async fn window_gate_refuses_host_roles_only() {
    let rig = rig();
    let (window, _) = ready(&rig, 1, json!({})).await;
    for (n, method) in ["process/spawn", "process/kill", "host/claim", "modelProxy/run", "connections/endpoint"].into_iter().enumerate() {
        window.request(n as i64 + 1, method, json!({}));
        let response = window.response(n as i64 + 1).await;
        assert!(denied(&response, method), "{method}: {response}");
    }
    // A method the renderer reached through main is open to the window: whatever it answers, it is not the gate's refusal.
    window.request(10, "thread/list", json!({}));
    let response = window.response(10).await;
    assert_ne!(response["error"]["data"]["reason"], json!("permissionDenied"), "{response}");
}

#[tokio::test(start_paused = true)]
async fn server_role_window_holds_to_its_own_connection() {
    let rig = rig();
    let (window, _) = ready(&rig, 2, json!({})).await;
    window.request(1, "thread/list", json!({ "connectionId": "c-8" }));
    assert_eq!(window.response(1).await["error"]["data"]["reason"], json!("permissionDenied"));
    window.request(2, "thread/list", json!({ "connectionId": "c-9" }));
    assert_ne!(window.response(2).await["error"]["data"]["reason"], json!("permissionDenied"));
}

#[tokio::test(start_paused = true)]
async fn window_initialize_host_refused() {
    let rig = rig();
    let window = rig.connect(1, Origin::Local);
    for capabilities in [json!({ "host": {} }), json!({ "modelProxy": true })] {
        window.initialize(VERSION, capabilities);
        let response = window.response(0).await;
        assert!(denied(&response, "initialize"), "{response}");
    }
    // The refusals latched nothing: the window initializes without the claim, and is told its id.
    window.initialize(VERSION, json!({ "approvalsInbox": true }));
    let response = window.response(0).await;
    assert_eq!(response["result"]["connection"]["window"], json!("w-1"), "{response}");
    // A connection that is no window echoes none.
    let (_, response) = ready(&rig, 3, json!({ "host": {} })).await;
    assert!(response["result"]["connection"].get("window").is_none(), "{response}");
}

#[tokio::test(start_paused = true)]
async fn window_claim_refused() {
    let rig = rig();
    let (window, response) = ready(&rig, 1, json!({})).await;
    assert!(response.get("result").is_some());
    window.request(1, "host/claim", json!({ "hostId": "h-1" }));
    let response = window.response(1).await;
    assert!(denied(&response, "host/claim"), "{response}");
}

fn pending(id: &str, thread: &str) -> PendingServerRequest {
    let frame = json!({ "id": id, "method": "item/tool/requestApproval", "params": { "threadId": thread } });
    PendingServerRequest {
        id: ServerRequestId(id.to_owned()),
        method: Method("item/tool/requestApproval"),
        thread: ThreadId::from(thread),
        surface: ThreadId::from(thread),
        order: 1,
        frame: Bytes::from(frame.to_string()),
    }
}

/// The renderer saw every approval main received: a local Main window that asks for the inbox gets those of every thread.
#[tokio::test(start_paused = true)]
async fn main_window_with_approvals_inbox_receives_every_thread() {
    let rig = rig();
    let (window, response) = ready(&rig, 1, json!({ "approvalsInbox": true })).await;
    assert!(response.get("result").is_some(), "{response}");
    rig.outgoing.publish(pending("ap1", "t-a"));
    rig.outgoing.publish(pending("ap2", "t-b"));
    crate::tests::settle().await;
    let ids: Vec<String> = window.drain().into_iter().filter_map(|wire| wire.body["id"].as_str().map(str::to_owned)).collect();
    assert_eq!(ids, ["ap1", "ap2"]);
}

/// Replaces the reference at `/input/prompt` by the text its digest names; the digest `missing` is not in the store.
struct Blobs;

#[async_trait]
impl ParamRefs for Blobs {
    async fn expand(&self, _method: &str, params: &mut Value, _cancel: &CancellationToken) -> Result<(), CoreError> {
        if let Some(slot) = params.pointer_mut("/input/prompt") {
            if let Some(digest) = slot.get("$blobRef").and_then(Value::as_str) {
                if digest == "missing" {
                    return Err(CoreError::InvalidParams { path: "/input/prompt/$blobRef".into(), expected: "a stored blob".into() });
                }
                *slot = Value::String("hello".to_owned());
            }
        }
        Ok(())
    }
}

fn turn(prompt: Value) -> Value {
    json!({ "threadId": "t-1", "opId": "0190f3c2-7a31-7c00-8000-000000000900", "input": { "prompt": prompt } })
}

#[tokio::test(start_paused = true)]
async fn validation_runs_before_route() {
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    client.request(1, "turn/start", turn(json!("")));
    let response = client.response(1).await;
    assert_eq!(reason(&response), "invalidParams");
    assert_eq!(response["error"]["data"]["path"], json!("/input/prompt"), "{response}");
    assert_eq!(response["error"]["data"]["expected"], json!("prompt is invalid."), "{response}");
}

#[tokio::test(start_paused = true)]
async fn blob_ref_expanded() {
    let _ = crate::param_refs::install(Arc::new(Blobs));
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    // The reference is expanded before the validators see the prompt: the empty-prompt refusal does not apply to the blob's text.
    client.request(1, "turn/start", turn(json!({ "$blobRef": "present", "as": "text" })));
    let response = client.response(1).await;
    assert_ne!(response["error"]["data"]["path"], json!("/input/prompt"), "{response}");
    // A blob that is not stored is the expander's refusal, answered as it is.
    client.request(2, "turn/start", turn(json!({ "$blobRef": "missing", "as": "text" })));
    let response = client.response(2).await;
    assert_eq!(reason(&response), "invalidParams");
    assert_eq!(response["error"]["data"]["path"], json!("/input/prompt/$blobRef"), "{response}");
}

/// Every input the TUI, the phone and the protocol clients send today passes the validators.
#[test]
fn clients_accepted_corpus_passes() {
    let corpus: Vec<Value> = serde_json::from_str(include_str!("../../mixdog-app-protocol/src/boundary/validate/fixtures/clients-accepted.json"))
        .expect("the corpus is a JSON array");
    assert!(!corpus.is_empty());
    for row in &corpus {
        let (method, params) = (row["method"].as_str().expect("method"), row.get("params"));
        if let Err(refused) = validate::check(method, params) {
            panic!("{} {}: refused with {refused:?}", row["client"], method);
        }
    }
}
