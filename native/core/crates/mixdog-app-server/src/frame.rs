//! Encoding of the frames the server itself writes on a connection's control lane (P §3):
//! responses, errors, `error` notifications and `host/*` requests. Feed frames are encoded
//! by their producers.

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use mixdog_app_protocol::ErrorData;
use mixdog_app_protocol::JsonRpcError;
use mixdog_app_protocol::JsonRpcNotification;
use mixdog_app_protocol::JsonRpcRequest;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::notifications::ErrorNotificationParams;
use serde::Serialize;
use serde_json::Value;

use crate::error::message;

#[derive(Serialize)]
struct ResponseRef<'a> {
    id: &'a RequestId,
    result: &'a Value,
}

fn encode(message: &impl Serialize) -> Bytes {
    Bytes::from(serde_json::to_vec(message).expect("wire messages serialize"))
}

/// `{id, result}`.
pub fn response_frame(id: &RequestId, result: &Value) -> Bytes {
    encode(&ResponseRef { id, result })
}

/// `{id, error:{code, message, data}}`; `data` is `{reason, …}` and the English `message`
/// is for logs only.
pub fn error_frame(id: &RequestId, data: &ErrorData) -> Bytes {
    encode(&JsonRpcError {
        error: data.clone().into_body(message(data)),
        id: id.clone(),
        lone_surrogates: Vec::new(),
    })
}

/// The connection-scoped `error` notification (P §8.4 step 5).
pub fn error_notification_frame(data: &ErrorData) -> Bytes {
    let params = ErrorNotificationParams {
        error: data.clone().into_body(message(data)),
        thread_id: None,
        will_retry: None,
        provider_error: None,
    };
    notification_frame(
        "error",
        serde_json::to_value(params).expect("error params serialize"),
    )
}

/// A connection-scoped server notification: no `feed` stamp.
pub(crate) fn notification_frame(method: &str, params: Value) -> Bytes {
    encode(&JsonRpcNotification {
        method: method.to_owned(),
        params: Some(params),
        emitted_at_ms: Some(now_ms()),
        feed: None,
        lone_surrogates: Vec::new(),
    })
}

/// A server request to a client (`host/*`).
pub(crate) fn request_frame(id: RequestId, method: &str, params: Value) -> Bytes {
    encode(&JsonRpcRequest {
        id,
        method: method.to_owned(),
        params: Some(params),
        trace: None,
        lone_surrogates: Vec::new(),
    })
}

/// `serverRequest/resolved` for a `host/*` request its asker gave up (cancelled, timed out, dropped): the claimant ends the
/// handler it is still running for `id`. A host request belongs to no thread.
pub(crate) fn abandoned_request_frame(id: &RequestId) -> Bytes {
    notification_frame(
        "serverRequest/resolved",
        serde_json::json!({
            "threadId": "",
            "requestId": id,
            "resolution": { "kind": "cancelled", "at": now_ms() },
        }),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
