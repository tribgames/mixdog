//! The `browser/command` domain: UI-originated in-app browser control, forwarded to the desktop
//! host as `host/browser/command{action, input}`. The host's single entry validates every caller's
//! command. A paired phone (relay origin) reaches only what Node's phone table offered
//! (`remote-methods.ts` `browserRemoteControl` / `browserReleasePage`, `remote-browser-methods.ts`):
//! any other action is the name Node's table did not have, and the session of a gesture is
//! `requiredSessionId`, checked before anything is forwarded.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_protocol::Origin;
use serde_json::Map;
use serde_json::Value;

use crate::browser_validate::validate_ui_action;
use crate::host_forward::forward;

/// The host actions Node's phone table forwarded to (`browserRemote`'s `control`, the host's `input`, and the
/// seven parity actions); their arguments are checked by `browser_validate` (Node's own functions, `host/browser-command.ts`).
const PHONE_ACTIONS: [&str; 8] = ["input", "tabOpen", "release", "history", "credentialSuggestions", "credentialFill", "importSources", "importStart"];

/// Node's refusal as the phone read it: an `Error` with no code.
fn refused(message: String) -> CoreError {
    CoreError::DomainError { domain: "browser".into(), code: None, message: Some(message.into()), detail: None }
}

/// A relay call: an action outside the phone's set is the name Node's table had no entry for (`executeRemoteFrame`:
/// `unknown method: <name>`, `(none)` for an empty one); a gesture's session is `requiredSessionId`, forwarded trimmed as
/// Node forwarded it (`browserRemoteControl`).
fn relay_admit(action: &str, input: &mut Option<Value>) -> Result<(), CoreError> {
    if !PHONE_ACTIONS.contains(&action) {
        return Err(refused(format!("unknown method: {}", if action.is_empty() { "(none)" } else { action })));
    }
    if action == "input" {
        let id = crate::domain_visualize::required_session_id(input.as_ref().and_then(|input| input.get("session_id"))).map_err(refused)?;
        if let Some(Value::Object(fields)) = input {
            fields.insert("session_id".into(), Value::String(id));
        }
    }
    Ok(())
}

pub struct BrowserService {
    channel: Arc<dyn HostChannel>,
}

impl BrowserService {
    /// Commands go to the desktop that claimed the host role and declared `browser`.
    pub fn new(channel: Arc<dyn HostChannel>) -> Self {
        Self { channel }
    }
}

#[async_trait]
impl DomainService for BrowserService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != "browser/command" {
            return Err(CoreError::InvalidParams { path: "method".into(), expected: "browser/command".into() });
        }
        let action = req
            .params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::InvalidParams { path: "action".into(), expected: "a string".into() })?;
        let mut input = req.params.get("input").cloned();
        if req.ctx.origin == Origin::Relay {
            relay_admit(action, &mut input)?;
        }
        // Every origin's arguments are checked here with the desktop's own texts; the host keeps its check.
        validate_ui_action(action, &mut input.clone().unwrap_or(Value::Null))?;
        let mut command = Map::new();
        command.insert("action".into(), Value::String(action.to_owned()));
        if let Some(input) = input {
            command.insert("input".into(), input);
        }
        let result = forward(&*self.channel, HostCapability::Browser, "browser", "host/browser/command", Value::Object(command), &req.ctx.cancel).await?;
        Ok(Reply::Value(result))
    }

    fn methods(&self) -> &'static [&'static str] {
        &["browser/command"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::mock::MockHostChannel;
    use serde_json::json;

    use super::*;

    fn request(params: Value) -> CoreRequest {
        CoreRequest { method: Method("browser/command"), params, op: None, ctx: CallContext::internal("test") }
    }

    #[tokio::test]
    async fn a_command_is_forwarded_untouched_and_its_result_returned() {
        let channel = Arc::new(MockHostChannel::default());
        channel.claim(HostCapability::Browser);
        channel.reply(Method("host/browser/command"), json!({ "text": "done" }));
        let service = BrowserService::new(channel.clone());

        let Reply::Value(value) =
            service.call(request(json!({ "action": "navigate", "input": { "url": "x", "anything": [1] } }))).await.unwrap()
        else {
            panic!("a value reply")
        };
        assert_eq!(value, json!({ "text": "done" }));
        let sent = channel.sent();
        assert_eq!(sent[0].1.as_str(), "host/browser/command");
        assert_eq!(sent[0].2, json!({ "action": "navigate", "input": { "url": "x", "anything": [1] } }));

        service.call(request(json!({ "action": "hide" }))).await.unwrap();
        assert_eq!(channel.sent()[1].2, json!({ "action": "hide" }), "no input, no input key");
    }

    /// Node's phone table, replayed through the core from a relay connection (`fixtures/phone-guards/golden.json`, recorded by
    /// `record-phone-guards.mjs` from `executeRemoteFrame` over `createRemoteMethods`): each Node call becomes the
    /// `browser/command` the phone sends for it. What Node refused is refused with Node's text and reaches no host; what it
    /// forwarded reaches the host (which runs Node's argument checks), a gesture with the session id Node forwarded.
    #[tokio::test]
    async fn a_relay_call_is_answered_as_nodes_phone_table_answered() {
        let golden: Value =
            serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-guards/golden.json"))).unwrap();
        let steps = golden["scenarios"]["browser"].as_array().unwrap();
        assert_eq!(steps.len(), 40);
        for step in steps {
            let (method, params, frame) = (step["method"].as_str().unwrap(), &step["params"], &step["frame"]);
            // The adapter's mapping: Node's method and positional params to the host action and its fields.
            let (action, input) = match method {
                "browserRemoteControl" => {
                    let mut input = params[1].clone();
                    input["session_id"] = params[0].clone();
                    ("input", input)
                }
                "browserRemoteTabOpen" => ("tabOpen", json!({ "url": params[0] })),
                "browserRemoteTabClose" | "browserReleasePage" => ("release", json!({ "id": params[0] })),
                "browserHistorySearch" => ("history", json!({ "query": params[0] })),
                "browserCredentialSuggestions" => ("credentialSuggestions", json!({ "session_id": params[0] })),
                "browserCredentialFill" => ("credentialFill", json!({ "session_id": params[0], "credentialId": params[1] })),
                "browserProfileImportSources" => ("importSources", json!({})),
                "browserProfileImportStart" => ("importStart", params[0].clone()),
                other => (other, params[0].clone()),
            };
            let channel = Arc::new(MockHostChannel::default());
            channel.claim(HostCapability::Browser);
            channel.reply(Method("host/browser/command"), frame["value"].clone());
            let service = BrowserService::new(channel.clone());
            let req = CoreRequest {
                method: Method("browser/command"),
                params: json!({ "action": action, "input": input }),
                op: None,
                ctx: CallContext::connection(ConnectionId(1), Origin::Relay, tokio_util::sync::CancellationToken::new()),
            };
            let answer = service.call(req).await;
            let sent = channel.sent();
            if frame["ok"] == true {
                let Ok(Reply::Value(value)) = answer else { panic!("{method} {params}: refused, Node answered {frame}") };
                assert_eq!(json!({ "ok": true, "value": value }), *frame, "{method} {params}");
                assert_eq!(sent.len(), 1, "{method} {params}");
                let mut forwarded = input.clone();
                if action == "input" {
                    forwarded["session_id"] = step["forwarded"][0]["args"][0].clone();
                }
                assert_eq!(sent[0].2, json!({ "action": action, "input": forwarded }), "{method} {params}");
            } else {
                let Err(CoreError::DomainError { domain, code, message, detail }) = answer else { panic!("{method} {params}: {answer:?}") };
                let mut node = json!({ "ok": false, "error": message.as_deref() });
                if let Some(code) = code.as_deref() {
                    node["errorCode"] = json!(code);
                }
                assert_eq!((&*domain, &node, detail), ("browser", frame, None), "{method} {params}");
                assert!(sent.is_empty(), "{method} {params}: nothing reaches the host");
            }
        }
    }

    #[tokio::test]
    async fn no_host_and_a_host_error_are_distinct_failures() {
        let channel = Arc::new(MockHostChannel::default());
        let service = BrowserService::new(channel.clone());
        assert!(matches!(
            service.call(request(json!({ "action": "x" }))).await,
            Err(CoreError::CapabilityUnavailable { .. })
        ));

        channel.claim(HostCapability::Browser);
        channel.fail(Method("host/browser/command"), -32000, "Error: bad selector", None);
        let error = service.call(request(json!({ "action": "click" }))).await.unwrap_err();
        let CoreError::DomainError { domain, code, message, detail } = error else { panic!("a coded error") };
        assert_eq!((&*domain, code.as_deref()), ("browser", Some("HOST_COMMAND_FAILED")));
        assert_eq!(message.as_deref(), Some("Error: bad selector"));
        assert_eq!(detail, None);
        assert!(matches!(service.call(request(json!({}))).await, Err(CoreError::InvalidParams { .. })));
    }
}
