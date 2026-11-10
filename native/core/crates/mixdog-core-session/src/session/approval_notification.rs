//! A phone notification's Allow / Deny on an approval (`thread/approval/answerNotification`, Node's
//! `answerApprovalNotification`, `remote-session-methods.ts:200-215` at b6f10295a).
//!
//! The rule is the core's, whatever the phone offered: Deny answers as the card's 거절 (`{approved: false}`); Allow answers
//! once with the very decision this PC's card sends for its 한 번만 허용, and only for the approval the thread shows now where
//! that card allows it with a bare Enter (`shared/approval-enter-rule.ts` `approvalAllowOnceDecision`, read by
//! `push-notifier.ts` `approvalAllowDecision`); any other Allow (a payment, a permanent delete, an Office rollback or discard,
//! a connector widening, an always-only permission, a sign-in, a takeover, a secret, a question) is not taken and answers
//! `open`. The answer goes through the thread's one decision path, stamped with the answering connection's device.

use mixdog_app_protocol::v2::approval::ApprovalNotificationAction;
use mixdog_app_protocol::v2::approval::ApprovalNotificationOutcome;
use mixdog_app_protocol::v2::approval::ThreadApprovalAnswerNotificationParams;
use mixdog_app_protocol::v2::approval::ThreadApprovalAnswerNotificationResponse;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::Caller;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::thread::Decision;
use mixdog_core_api::thread::RunControl;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::room_approval::tool_approval;

/// `requiredString(id, 'approval id', 1_024)`.
const APPROVAL_ID_UNITS: usize = 1_024;
const ONCE_KINDS: [&str; 5] = ["allow_once", "once", "allow_session", "session", "allow_scoped"];

/// `recordOf`: an object (never an array).
fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(value || fallback)`.
fn or_text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if truthy(Some(value)) => mixdog_js::value_to_string(value),
        _ => fallback.to_owned(),
    }
}

/// `permissionChoices(permissionScopesOf(request)).once?.id`: the narrowest once-type option, by kind (a scope without one
/// is read by its id), ties to the option listed first.
fn once_scope(request: &Map<String, Value>) -> Option<String> {
    let scopes = record(request.get("permission")).and_then(|permission| permission.get("scopes")).and_then(Value::as_array);
    let list: Vec<(String, String)> = scopes
        .into_iter()
        .flatten()
        .filter_map(|scope| record(Some(scope)))
        .filter(|scope| truthy(scope.get("id")))
        .map(|scope| {
            let kind = match scope.get("kind") {
                Some(kind) if truthy(Some(kind)) => mixdog_js::value_to_string(kind),
                _ => mixdog_js::value_to_string(&scope["id"]),
            };
            (mixdog_js::value_to_string(&scope["id"]), kind.to_lowercase())
        })
        .collect();
    ONCE_KINDS.iter().find_map(|once| list.iter().find(|(_, kind)| kind == once).map(|(id, _)| id.clone()))
}

/// `approvalAllowIsPointerOnly`: a payment, a permanent delete, an Office rollback or recovery discard, a connector widening.
fn pointer_only(request: &Map<String, Value>) -> bool {
    if request.get("kind").and_then(Value::as_str) == Some("connector") {
        return true;
    }
    let category = if request.get("kind").and_then(Value::as_str) == Some("outbound") {
        or_text(record(request.get("outbound")).and_then(|outbound| outbound.get("category")), "")
    } else {
        String::new()
    };
    if category == "payment" || category == "delete" {
        return true;
    }
    let action = or_text(record(request.get("args")).and_then(|args| args.get("action")), "").to_lowercase();
    or_text(request.get("name"), "").to_lowercase() == "office" && (action == "rollback" || action == "discard")
}

/// `approvalAllowOnceDecision(approval)`: what the card's 한 번만 허용 sends for the approval as the thread shows it (Node's
/// `state.toolApproval`); `None` where a bare Enter does not allow it once.
pub fn allow_once_decision(approval: &Value) -> Option<Value> {
    let request = record(Some(approval))?;
    if pointer_only(request) {
        return None;
    }
    let kind = or_text(request.get("kind"), "approval");
    if kind == "permission" {
        return once_scope(request).map(|scope| json!({ "approved": true, "scope": scope }));
    }
    if kind != "approval" && kind != "outbound" {
        return None;
    }
    let action = or_text(record(request.get("args")).and_then(|args| args.get("action")), "").to_lowercase();
    if or_text(request.get("name"), "").to_lowercase() == "office" && action == "commit" {
        return Some(json!({ "approved": true, "response": "approve" }));
    }
    Some(json!({ "approved": true }))
}

fn reply(outcome: ApprovalNotificationOutcome) -> Result<Reply, CoreError> {
    Ok(Reply::Value(serde_json::to_value(ThreadApprovalAnswerNotificationResponse { outcome }).expect("protocol types serialize")))
}

impl SessionDirectory {
    /// `thread/approval/answerNotification`. A thread that is not loaded shows no approval: Allow is `open`, Deny `settled`.
    pub(super) fn answer_approval_notification(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadApprovalAnswerNotificationParams = serde_json::from_value(req.params.clone())
            .map_err(|error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() })?;
        let id = js_trim(&params.approval_id);
        if id.is_empty() || mixdog_js::utf16_len(id) > APPROVAL_ID_UNITS {
            return Err(mixdog_core_base::support::failed("approval", "approval id is invalid."));
        }
        let Caller::Connection(connection) = req.ctx.caller else {
            return Err(CoreError::InvalidParams { path: "caller".into(), expected: "a client connection".into() });
        };
        let handle = self.handle(&params.thread_id);
        let shown = handle.as_ref().and_then(|handle| handle.cell.shown_approval.load_full()).filter(|request| request.id.0.to_string() == id);
        let decision = match params.action {
            ApprovalNotificationAction::Allow => shown.as_ref().and_then(|request| allow_once_decision(&tool_approval(request))),
            ApprovalNotificationAction::Deny => Some(json!({ "approved": false })),
        };
        let Some(decision) = decision else { return reply(ApprovalNotificationOutcome::Open) };
        let (Some(handle), Some(_)) = (handle, shown) else { return reply(ApprovalNotificationOutcome::Settled) };
        let device = handle.deps.devices.describe(connection);
        RunControl::decide(
            &*handle,
            Decision { request: ServerRequestId(id.to_owned()), connection, device: device.device, connection_kind: device.kind, result: decision },
        )?;
        reply(ApprovalNotificationOutcome::Answered)
    }
}

#[cfg(test)]
#[path = "approval_notification_tests.rs"]
mod tests;
