//! The `browser/command` domain: UI-originated in-app browser control, forwarded to the desktop
//! host as `host/browser/command{action, input}`. Forward only: the host's single entry validates
//! every caller's command, so the core adds no checks of its own.

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
use serde_json::Map;
use serde_json::Value;

use crate::host_forward::forward;

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
        let mut command = Map::new();
        command.insert("action".into(), Value::String(action.to_owned()));
        if let Some(input) = req.params.get("input") {
            command.insert("input".into(), input.clone());
        }
        let result = forward(&*self.channel, HostCapability::Browser, "browser", "host/browser/command", Value::Object(command)).await?;
        Ok(Reply::Value(result))
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
        let CoreError::DomainError { domain, code, detail } = error else { panic!("a coded error") };
        assert_eq!((&*domain, &*code), ("browser", "HOST_COMMAND_FAILED"));
        assert_eq!(
            detail.as_deref(),
            Some(&mixdog_protocol::DomainErrorDetail::ExternalFailure { message: "Error: bad selector".into() })
        );
        assert!(matches!(service.call(request(json!({}))).await, Err(CoreError::InvalidParams { .. })));
    }
}
