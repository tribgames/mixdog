//! `computer/pointerReleased` (desktop → core, a notification): the user moved the real pointer over a session's arrow, so the
//! core ends that session's pointer hold (`overlay/cursor-overlay.ts` `watchHeldPointers` releasing through the coordinator).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_tools::desktop::computer_pointer::PointerHold;
use serde::Deserialize;
use serde_json::Value;

/// `{sessionThreadId}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    session_thread_id: String,
}

/// Serves the notification over the pool's pointer hold; `None` where no computer helper is installed, which leaves no hold to end.
pub struct ComputerPointerService {
    hold: Option<Arc<PointerHold>>,
}

impl ComputerPointerService {
    pub fn new(hold: Option<Arc<PointerHold>>) -> Self {
        Self { hold }
    }
}

#[async_trait]
impl DomainService for ComputerPointerService {
    fn methods(&self) -> &'static [&'static str] {
        &["computer/pointerReleased"]
    }

    /// A notification only: a request of it is not one the protocol has.
    async fn call(&self, _request: CoreRequest) -> Result<Reply, CoreError> {
        Err(CoreError::InvalidParams { path: "method".into(), expected: "a notification".into() })
    }

    /// A line that is not `{sessionThreadId}` is dropped: a notification has no one to answer.
    fn notify(&self, _method: Method, params: Value, _from: ConnectionId) -> Admit {
        if let (Some(hold), Ok(params)) = (&self.hold, serde_json::from_value::<Params>(params)) {
            hold.released_by_user(&params.session_thread_id);
        }
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_core_api::CallContext;
    use mixdog_tools::desktop::computer_pointer::PointerHost;
    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;

    struct Host {
        released: mpsc::UnboundedSender<String>,
    }

    #[async_trait]
    impl PointerHost for Host {
        fn release_pointer(&self, _: &str) {}
        fn is_running(&self, _: &str) -> bool {
            false
        }
        async fn release_cursor_theme(&self, session: &str) {
            let _ = self.released.send(session.to_owned());
        }
    }

    fn service() -> (ComputerPointerService, Arc<PointerHold>, mpsc::UnboundedReceiver<String>) {
        let (released, receive) = mpsc::unbounded_channel();
        let hold = Arc::new(PointerHold::new(Arc::new(Host { released })));
        (ComputerPointerService::new(Some(hold.clone())), hold, receive)
    }

    fn notify(service: &ComputerPointerService, params: Value) {
        assert!(matches!(service.notify(Method("computer/pointerReleased"), params, ConnectionId(1)), Admit::Accepted));
    }

    async fn quiet(receive: &mut mpsc::UnboundedReceiver<String>) -> bool {
        mixdog_rt::time::timeout(Duration::from_millis(150), receive.recv()).await.is_err()
    }

    #[tokio::test]
    async fn the_notification_ends_a_held_sessions_pointer_and_only_that_one() {
        let (service, hold, mut released) = service();
        hold.command_ended("t1");
        hold.command_ended("t2");
        notify(&service, json!({"sessionThreadId": "t1"}));
        let ended = mixdog_rt::time::timeout(Duration::from_secs(5), released.recv()).await.expect("in time");
        assert_eq!(ended.as_deref(), Some("t1"));
        assert!(quiet(&mut released).await, "t2 is still held");
        notify(&service, json!({"sessionThreadId": "t1"}));
        assert!(quiet(&mut released).await, "t1 is no longer held");
    }

    #[tokio::test]
    async fn a_malformed_notification_or_no_helper_is_taken_and_ignored() {
        let (service, hold, mut released) = service();
        hold.command_ended("t1");
        for params in [json!({}), json!({"sessionThreadId": 4}), json!("t1"), Value::Null] {
            notify(&service, params);
        }
        assert!(quiet(&mut released).await);
        notify(&ComputerPointerService::new(None), json!({"sessionThreadId": "t1"}));
    }

    #[tokio::test]
    async fn a_request_of_the_notification_is_refused() {
        let (service, _, _) = service();
        let request = CoreRequest { method: Method("computer/pointerReleased"), params: json!({"sessionThreadId": "t1"}), op: None, ctx: CallContext::internal("test") };
        assert!(matches!(service.call(request).await, Err(CoreError::InvalidParams { .. })));
    }
}
