//! `computer/userControl` (desktop → core): the Computer Use pill's Resume and Stop (Node's coordinator
//! `resumeAfterUserTakeover` and the overlay's Stop, `computer/session/coordinator.ts`), applied to the person's hold on the
//! desktop that the computer sessions share.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::computer_host::ComputerTakeoverReason;
use mixdog_app_protocol::v2::host::ComputerUserControlAction;
use mixdog_app_protocol::v2::host::ComputerUserControlParams;
use mixdog_app_protocol::v2::host::ComputerUserControlResult;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_tools::desktop::computer_user_control::UserControlState;
use serde_json::Value;
use serde_json::json;

/// Serves the pill's requests over the hold of the computer sessions' pool; `None` where no computer helper is installed, which
/// leaves nothing to resume or stop.
pub struct ComputerUserControlService {
    control: Option<Arc<UserControlState>>,
}

impl ComputerUserControlService {
    pub fn new(control: Option<Arc<UserControlState>>) -> Self {
        Self { control }
    }
}

#[async_trait]
impl DomainService for ComputerUserControlService {
    fn methods(&self) -> &'static [&'static str] {
        &["computer/userControl"]
    }

    async fn call(&self, request: CoreRequest) -> Result<Reply, CoreError> {
        let params: ComputerUserControlParams =
            serde_json::from_value(request.params).map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() })?;
        params.validate().map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.into() })?;
        let changed = match &self.control {
            None => false,
            Some(control) => match params.action {
                // A latched cleanup gets its verified recovery first; one that still does not confirm leaves the hold in place.
                ComputerUserControlAction::Resume => control.resume_verified(params.session_thread_id.as_ref().map(|session| session.as_str())).await,
                ComputerUserControlAction::Stop => control.stop_verified().await,
                ComputerUserControlAction::Pause => control.pause(),
                // The environment guard's takeover (the screen locked, the machine slept, a display changed) and the idle-resume setting.
                ComputerUserControlAction::Takeover => match params.reason {
                    Some(ComputerTakeoverReason::DesktopUnavailable) => control.take_over_environment("desktop_unavailable"),
                    Some(ComputerTakeoverReason::DisplayChanged) => control.take_over_environment("display_changed"),
                    None => false,
                },
                ComputerUserControlAction::ConfigureIdleResume => {
                    control.set_idle_resume(params.seconds.unwrap_or(0));
                    true
                }
            },
        };
        Ok(Reply::Value(json!(ComputerUserControlResult { ok: changed })))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_core_api::CallContext;

    use super::*;

    async fn ask(service: &ComputerUserControlService, params: Value) -> Value {
        let request = CoreRequest { method: Method("computer/userControl"), params, op: None, ctx: CallContext::internal("test") };
        match service.call(request).await.expect("an answer") {
            Reply::Value(value) => value,
            _ => panic!("a plain result"),
        }
    }

    /// Stop holds the desktop while a session uses the computer, and Resume ends the hold; with nothing held, or no helper,
    /// the answer is `ok: false`.
    #[tokio::test]
    async fn the_pill_stops_and_resumes_the_hold() {
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let service = ComputerUserControlService::new(Some(control.clone()));
        assert_eq!(ask(&service, json!({"action": "stop"})).await, json!({"ok": false}), "no session is using the computer");
        control.session_began("t1");
        assert_eq!(ask(&service, json!({"action": "stop"})).await, json!({"ok": true}));
        assert_eq!(control.section().map(|section| section.reason), Some("user_stop".to_owned()));
        assert_eq!(ask(&service, json!({"action": "resume", "sessionThreadId": "t1"})).await, json!({"ok": true}));
        assert_eq!(control.section(), None);
        assert_eq!(ask(&service, json!({"action": "resume"})).await, json!({"ok": false}), "nothing is held");
        assert_eq!(ask(&ComputerUserControlService::new(None), json!({"action": "resume"})).await, json!({"ok": false}));
    }

    /// The environment takeover holds the desktop until Resume; the idle-resume interval is the pill's setting; a takeover with no
    /// reason, and a pause, are answered as the control answers them.
    #[tokio::test]
    async fn the_takeover_and_the_idle_resume_are_applied() {
        let control = Arc::new(UserControlState::new(Duration::ZERO));
        let service = ComputerUserControlService::new(Some(control.clone()));
        control.session_began("t1");
        assert_eq!(ask(&service, json!({"action": "takeover", "reason": "display_changed"})).await, json!({"ok": true}));
        assert_eq!(control.section().map(|section| section.reason), Some("display_changed".to_owned()));
        assert_eq!(ask(&service, json!({"action": "configureIdleResume", "seconds": 12})).await, json!({"ok": true}));
        assert_eq!(control.idle_resume_seconds(), 12);
        assert_eq!(ask(&service, json!({"action": "resume"})).await, json!({"ok": true}));
        assert_eq!(ask(&service, json!({"action": "pause"})).await, json!({"ok": true}));
        assert_eq!(control.section().map(|section| section.reason), Some("user_pause".to_owned()));
        assert_eq!(ask(&service, json!({"action": "takeover"})).await, json!({"ok": false}), "a takeover that names no reason changes nothing");
    }

    #[tokio::test]
    async fn a_request_that_is_no_pill_action_is_refused() {
        let service = ComputerUserControlService::new(None);
        let request = CoreRequest { method: Method("computer/userControl"), params: json!({"action": "kneel"}), op: None, ctx: CallContext::internal("test") };
        assert!(matches!(service.call(request).await, Err(CoreError::InvalidParams { .. })));
    }
}
