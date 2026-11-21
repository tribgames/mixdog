//! The notices a session posts around an MCP sign-in and sign-out: a sign-in that is waiting on the browser says "mcp sign-in started",
//! a sign-out says "mcp signed out", the name is shown as it was given, the notice comes after the runtime answered and before the
//! reply returns, and nothing else (a stored sign-in, a failure, a status read, a cancel, a paste, a probe) posts one.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::mcp_service::Incarnation;
use mixdog_mcp::mcp_service::SessionToasts;
use mixdog_mcp::scripted::Log;
use mixdog_mcp::scripted::Script;
use serde_json::Value;
use serde_json::json;

struct Session {
    log: Log,
}

#[async_trait]
impl Incarnation for Session {
    async fn toast(&self, text: &str, tone: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(json!({"notice": {"text": text, "tone": tone}}));
        Ok(())
    }

    fn disposed(&self) -> bool {
        false
    }
}

struct Hosting(Log);

impl SessionToasts for Hosting {
    fn closed(&self) -> bool {
        false
    }

    fn incarnation(&self, _thread: &str) -> Option<Arc<dyn Incarnation>> {
        Some(Arc::new(Session { log: self.0.clone() }))
    }
}

/// Calls `method` with `params` against a runtime that answers `script`; the reply or failure, and the ordered events
/// (the runtime call, the notices, the return).
async fn call(method: &'static str, params: Value, script: Value) -> (Result<Value, String>, Vec<Value>) {
    let log: Log = Arc::default();
    let script: Script = Arc::new(Mutex::new(script));
    let service = mixdog_mcp::scripted::service(script, Arc::clone(&log), None, Arc::new(Hosting(Arc::clone(&log))));
    let mut params = params;
    params["threadId"] = json!("t1");
    let outcome = service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await;
    log.lock().unwrap().push(json!("return"));
    let result = match outcome {
        Ok(Reply::Value(value)) => Ok(value),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        other => panic!("{other:?}"),
    };
    let events = log.lock().unwrap().clone();
    (result, events)
}

fn started(name: &str) -> Value {
    json!({"notice": {"text": format!("mcp sign-in started: {name}"), "tone": "info"}})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_waiting_for_the_browser_posts_a_started_notice_after_the_runtime_answers() {
    let pending = json!({"result": {"flowId": "f1", "state": "pending", "url": "https://auth.example/authorize"}});
    let (reply, events) = call("mcp/beginMcpOAuthLogin", json!({"name": "linear"}), pending.clone()).await;
    assert_eq!(reply.unwrap(), pending["result"]);
    assert_eq!(events, [json!({"runtime": "beginMcpOAuthLogin"}), started("linear"), json!("return")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_started_notice_shows_the_name_as_it_was_given() {
    let pending = json!({"result": {"flowId": "f1", "state": "pending", "url": "https://auth.example/authorize"}});
    let (_, events) = call("mcp/beginMcpOAuthLogin", json!({"name": " linear "}), pending).await;
    assert_eq!(events[1], started(" linear "));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_that_needed_no_browser_or_that_failed_posts_nothing() {
    let (reply, events) = call("mcp/beginMcpOAuthLogin", json!({"name": "linear"}), json!({"result": {"flowId": "f2", "state": "complete"}})).await;
    assert_eq!(reply.unwrap()["state"], "complete");
    assert_eq!(events, [json!({"runtime": "beginMcpOAuthLogin"}), json!("return")]);
    let (reply, events) = call("mcp/beginMcpOAuthLogin", json!({"name": "linear"}), json!({"throws": "MCP OAuth sign-in was not completed"})).await;
    assert_eq!(reply.unwrap_err(), "MCP OAuth sign-in was not completed");
    assert_eq!(events, [json!({"runtime": "beginMcpOAuthLogin"}), json!("return")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_out_posts_a_signed_out_notice_and_a_failed_one_posts_nothing_and_says_why() {
    let status = json!({"servers": [{"name": "linear", "status": "connected"}], "revoked": true});
    let (reply, events) = call("mcp/signOutMcpServer", json!({"name": "linear"}), json!({"result": status})).await;
    assert_eq!(reply.unwrap(), status);
    assert_eq!(events, [json!({"runtime": "signOutMcpServer"}), json!({"notice": {"text": "mcp signed out: linear", "tone": "info"}}), json!("return")]);
    let (reply, events) = call("mcp/signOutMcpServer", json!({"name": "linear"}), json!({"throws": "keychain locked"})).await;
    assert_eq!(reply.unwrap_err(), "keychain locked");
    assert_eq!(events, [json!({"runtime": "signOutMcpServer"}), json!("return")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reading_cancelling_completing_or_probing_a_sign_in_posts_nothing_and_a_refused_paste_says_why() {
    let cases = [
        (
            "mcp/getMcpOAuthLoginStatus",
            json!({"flowId": "f1", "options": {"since": "pending:browser", "waitMs": 0}}),
            json!({"flowId": "f1", "state": "pending", "step": "browser"}),
        ),
        ("mcp/cancelMcpOAuthLogin", json!({"flowId": "f1"}), json!({"flowId": "f1", "state": "cancelled"})),
        ("mcp/completeMcpOAuthLogin", json!({"flowId": "f1", "callbackUrl": "http://127.0.0.1/cb?code=1"}), json!({"flowId": "f1", "state": "complete"})),
        ("mcp/probeMcpServerAuth", json!({"cfg": {"type": "http", "url": "https://x.example/mcp"}}), json!({"auth": "oauth"})),
    ];
    for (method, params, result) in cases {
        let (reply, events) = call(method, params, json!({"result": result})).await;
        assert_eq!(reply.unwrap(), result, "{method}");
        assert_eq!(events.len(), 2, "{method}: only the runtime call and the return: {events:?}");
    }
    let (reply, events) = call("mcp/completeMcpOAuthLogin", json!({"flowId": "f1", "callbackUrl": "nope"}), json!({"throws": "Invalid callback URL"})).await;
    assert_eq!(reply.unwrap_err(), "Invalid callback URL");
    assert_eq!(events.len(), 2);
}
