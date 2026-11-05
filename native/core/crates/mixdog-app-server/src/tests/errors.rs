//! `CoreError` → wire mapping and the error frames (P §10).

use bytes::Bytes;
use mixdog_app_protocol::ErrorData;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::error::INTERNAL_ERROR;
use mixdog_app_protocol::error::INVALID_PARAMS;
use mixdog_app_protocol::error::INVALID_REQUEST;
use mixdog_app_protocol::error::OVERLOADED;
use mixdog_core_api::CoreError;
use mixdog_core_api::error::Precondition;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::BlobDigest;
use mixdog_protocol::DrainReason;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use crate::error_data;
use crate::error_frame;
use crate::error_notification_frame;

fn thread() -> ThreadId {
    ThreadId::from("t1")
}

fn op() -> OpId {
    OpId::from("op1")
}

fn digest() -> BlobDigest {
    format!("sha256:{}", "a".repeat(64)).parse().unwrap()
}

/// Every `CoreError` with the wire code and reason it must produce.
fn table() -> Vec<(CoreError, i64, &'static str)> {
    vec![
        (
            CoreError::ServerShuttingDown {
                drain_reason: DrainReason::Update,
            },
            INVALID_REQUEST,
            "serverShuttingDown",
        ),
        (
            CoreError::CoreMigrating {
                kind: "sessions".into(),
                done: 1,
                total: 2,
            },
            INVALID_REQUEST,
            "coreMigrating",
        ),
        (
            CoreError::ThreadNotFound { thread_id: thread() },
            INVALID_REQUEST,
            "threadNotFound",
        ),
        (
            CoreError::ThreadClosing { thread_id: thread() },
            INVALID_REQUEST,
            "threadClosing",
        ),
        (
            CoreError::TurnNotActive {
                thread_id: thread(),
                turn_id: None,
            },
            INVALID_REQUEST,
            "turnNotActive",
        ),
        (
            CoreError::ItemNotFound {
                thread_id: thread(),
                item_id: "i1".into(),
            },
            INVALID_REQUEST,
            "itemNotFound",
        ),
        (
            CoreError::QueuedEntryNotFound {
                thread_id: thread(),
                queued_id: "q1".into(),
            },
            INVALID_REQUEST,
            "queuedEntryNotFound",
        ),
        (
            CoreError::PreconditionFailed {
                precondition: Precondition::Revision {
                    expected: "1".into(),
                    actual: "2".into(),
                },
            },
            INVALID_REQUEST,
            "preconditionFailed",
        ),
        (
            CoreError::PermissionDenied {
                method: "turn/start".into(),
                origin: Origin::Relay,
            },
            INVALID_REQUEST,
            "permissionDenied",
        ),
        (
            CoreError::CapabilityUnavailable {
                capability: "office".into(),
                detail: "noJsRuntime".into(),
            },
            INVALID_REQUEST,
            "capabilityUnavailable",
        ),
        (CoreError::OpFenced { op_id: op() }, INVALID_REQUEST, "opFenced"),
        (CoreError::ConnectionClosed, INVALID_REQUEST, "connectionClosed"),
        (
            CoreError::InvalidParams {
                path: "a.b".into(),
                expected: "string".into(),
            },
            INVALID_PARAMS,
            "invalidParams",
        ),
        (
            CoreError::OpIdConflict { op_id: op() },
            INVALID_PARAMS,
            "opIdConflict",
        ),
        (
            CoreError::OpIdExpired {
                op_id: op(),
                watermark: "w".into(),
            },
            INVALID_PARAMS,
            "opIdExpired",
        ),
        (CoreError::OpIdRequired, INVALID_PARAMS, "opIdRequired"),
        (
            CoreError::CursorInvalidated {
                thread_id: thread(),
                history_rev: 3,
            },
            INVALID_PARAMS,
            "cursorInvalidated",
        ),
        (
            CoreError::InputTooLarge { limit: 9 },
            INVALID_PARAMS,
            "inputTooLarge",
        ),
        (
            CoreError::Internal {
                incident_id: "inc".into(),
            },
            INTERNAL_ERROR,
            "internal",
        ),
        (
            CoreError::BarrierFailed {
                scope: "thread:t1".into(),
                io_kind: "fsync".into(),
            },
            INTERNAL_ERROR,
            "barrierFailed",
        ),
        (
            CoreError::StorageIndeterminate {
                scope: "thread:t1".into(),
            },
            INTERNAL_ERROR,
            "storageIndeterminate",
        ),
        (
            CoreError::StorageUnsupported {
                op: "rename".into(),
                os_error: "5".into(),
            },
            INTERNAL_ERROR,
            "storageUnsupported",
        ),
        (
            CoreError::ExternalOutcomeUnknown {
                op_id: op(),
                effect: "git.push".into(),
                target: "origin".into(),
            },
            INTERNAL_ERROR,
            "externalOutcomeUnknown",
        ),
        (
            CoreError::ProviderError {
                provider: "anthropic".into(),
                status: Some(529),
                kind: "overloaded".into(),
            },
            INTERNAL_ERROR,
            "providerError",
        ),
        (
            CoreError::Cancelled { by: "abort".into() },
            INTERNAL_ERROR,
            "cancelled",
        ),
        (
            CoreError::StoreDamaged {
                thread_id: thread(),
                file_no: 1,
                offset: 2,
            },
            INVALID_REQUEST,
            "storeDamaged",
        ),
        (
            CoreError::ItemTooLarge { limit: 64 },
            INVALID_REQUEST,
            "itemTooLarge",
        ),
        (
            CoreError::CatalogRebuilding { done: 1, total: 9 },
            INVALID_REQUEST,
            "catalogRebuilding",
        ),
        (
            CoreError::BlobNotFound { digest: digest() },
            INVALID_REQUEST,
            "blobNotFound",
        ),
        (
            CoreError::BlobCorrupt { digest: digest() },
            INTERNAL_ERROR,
            "blobCorrupt",
        ),
        (
            CoreError::DomainError {
                domain: "git".into(),
                code: Some("WORKTREE_DIRTY".into()),
                detail: None,
            },
            INVALID_REQUEST,
            "domainError",
        ),
        (
            CoreError::InvalidServerRequestResponse {
                request_id: ServerRequestId("ap1".to_owned()),
                detail: "not a decision".into(),
            },
            INVALID_REQUEST,
            "invalidServerRequestResponse",
        ),
        (
            CoreError::WindowFull { thread_id: thread() },
            OVERLOADED,
            "windowFull",
        ),
        (
            CoreError::QueueFull {
                queue: "inbox".into(),
            },
            OVERLOADED,
            "queueFull",
        ),
    ]
}

fn frame_json(frame: Bytes) -> Value {
    serde_json::from_slice(&frame).unwrap()
}

#[test]
fn every_core_error_maps_to_its_code_and_reason() {
    for (error, code, reason) in table() {
        let data = error_data(&error);
        assert_eq!(data.code(), code, "{error}");
        assert_eq!(data.reason(), reason, "{error}");
    }
}

#[test]
fn error_frame_is_the_envelope_with_reason_data() {
    let error = CoreError::ThreadNotFound { thread_id: thread() };
    let frame = frame_json(error_frame(&RequestId::Integer(7), &error_data(&error)));
    assert_eq!(frame["id"], json!(7));
    assert_eq!(frame["error"]["code"], json!(INVALID_REQUEST));
    assert_eq!(
        frame["error"]["data"],
        json!({ "reason": "threadNotFound", "threadId": "t1" })
    );
    assert!(frame["error"]["message"].is_string());
    assert!(frame.get("result").is_none());
}

#[test]
fn precondition_failed_carries_both_sides() {
    let content = CoreError::PreconditionFailed {
        precondition: Precondition::Content {
            expected: Some(Bytes::from_static(b"old")),
            actual: None,
        },
    };
    assert_eq!(
        serde_json::to_value(error_data(&content)).unwrap(),
        json!({ "reason": "preconditionFailed", "expected": "old", "actual": null })
    );
    let idle = CoreError::PreconditionFailed {
        precondition: Precondition::LastUsedAt {
            expected: 10,
            actual: 20,
        },
    };
    assert_eq!(
        serde_json::to_value(error_data(&idle)).unwrap(),
        json!({
            "reason": "preconditionFailed",
            "expected": { "lastUsedAt": 10 },
            "actual": { "lastUsedAt": 20 },
        })
    );
    let revision = CoreError::PreconditionFailed {
        precondition: Precondition::Revision {
            expected: "r1".into(),
            actual: "r2".into(),
        },
    };
    assert_eq!(
        serde_json::to_value(error_data(&revision)).unwrap(),
        json!({ "reason": "preconditionFailed", "expected": "r1", "actual": "r2" })
    );
}

#[test]
fn invalid_server_request_response_keeps_the_approval_id_as_a_string_request_id() {
    let error = CoreError::InvalidServerRequestResponse {
        request_id: ServerRequestId("41".to_owned()),
        detail: "unknown decision".into(),
    };
    let ErrorData::InvalidServerRequestResponse { request_id, detail } = error_data(&error)
    else {
        panic!("wrong reason");
    };
    assert_eq!(request_id, RequestId::String("41".to_owned()));
    assert_eq!(detail, "unknown decision");

    let notification = frame_json(error_notification_frame(&error_data(&error)));
    assert_eq!(notification["method"], json!("error"));
    assert!(notification.get("id").is_none());
    assert_eq!(
        notification["params"]["error"]["data"],
        json!({
            "reason": "invalidServerRequestResponse",
            "requestId": "41",
            "detail": "unknown decision",
        })
    );
}
