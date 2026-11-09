//! The notices a session posts around an MCP sign-in and sign-out, against what the session
//! extensions API of Node posted (`fixtures/mcp-login-notices`, recorded by
//! `record-mcp-login-notices.mjs` from the real `createSessionExtensionsApi` at b6f10295a): for
//! each flow the order of the runtime call, the notice (text and tone) and the reply, and the
//! reply or the failure itself. The sessions are scripted; the real sessions replay the failure
//! flows in `mixdog-core-session` (`mcp_failure_replay`).

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

/// The sessions, answering with the notices in the shape the recording logged them: `{notice: {text, tone}}`, with the thread they went to.
struct Toasts {
    log: Log,
    threads: Mutex<Vec<String>>,
}

struct Session {
    thread: String,
    toasts: Arc<Toasts>,
}

#[async_trait]
impl Incarnation for Session {
    async fn toast(&self, text: &str, tone: &str) -> Result<(), String> {
        self.toasts.threads.lock().unwrap().push(self.thread.clone());
        self.toasts.log.lock().unwrap().push(json!({ "notice": { "text": text, "tone": tone } }));
        Ok(())
    }

    fn disposed(&self) -> bool {
        false
    }
}

struct Hosting(Arc<Toasts>);

impl SessionToasts for Hosting {
    fn closed(&self) -> bool {
        false
    }

    fn incarnation(&self, thread: &str) -> Option<Arc<dyn Incarnation>> {
        Some(Arc::new(Session { thread: thread.to_owned(), toasts: self.0.clone() }))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_sign_in_flow_posts_the_notices_and_replies_in_the_order_node_did() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/mcp-login-notices/golden.json")).expect("fixture");
    for flow in golden["flows"].as_array().expect("flows") {
        let name = flow["name"].as_str().unwrap();
        let log: Log = Arc::default();
        let script: Script = Arc::new(Mutex::new(flow["runtime"].clone()));
        let toasts = Arc::new(Toasts { log: Arc::clone(&log), threads: Mutex::default() });
        let service = mixdog_mcp::scripted::service(script, Arc::clone(&log), None, Arc::new(Hosting(toasts.clone())));
        let method: &'static str = Box::leak(format!("mcp/{}", flow["method"].as_str().unwrap()).into_boxed_str());
        let mut params = flow["params"].clone();
        params["threadId"] = json!("t1");
        let outcome = service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await;
        log.lock().unwrap().push(json!("return"));
        match (outcome, flow["error"].as_str()) {
            (Ok(Reply::Value(got)), None) => assert_eq!(got, flow["reply"], "{name}: reply"),
            (Err(CoreError::DomainError { message: Some(got), .. }), Some(expected)) => assert_eq!(&*got, expected, "{name}: failure"),
            (other, expected) => panic!("{name}: got {other:?}, Node error {expected:?}"),
        }
        assert_eq!(Value::Array(log.lock().unwrap().clone()), flow["events"], "{name}: runtime call, notice and return in order");
        let posted: Vec<String> = flow["events"].as_array().unwrap().iter().filter(|e| e.get("notice").is_some()).map(|_| "t1".to_owned()).collect();
        assert_eq!(*toasts.threads.lock().unwrap(), posted, "{name}: the notice goes to the session that asked");
    }
}
