//! The host against `fixtures/delegated-host/golden.json`, recorded from the real
//! `delegated-approval-host.mjs`: each scripted step's return value and the offers and
//! withdrawals the fake queues saw, in order.

use serde_json::json;

use mixdog_services::bots::delivery::queue::Handoffs;

use mixdog_core_session::session::delegated_host::{DelegatedApprovalHost, HostHandoffs};

/// The report-watch store keeps the host in step through `Handoffs`: a watch added notes its hand-off,
/// a watch gone ends it for good (the host's scripted steps above are `noteHandoff` / `endHandoff`).
#[tokio::test]
async fn the_report_watch_store_notes_and_ends_hand_offs_through_the_adapter() {
    let host = DelegatedApprovalHost::new();
    let handoffs = HostHandoffs::new(host.clone());
    let watch = json!({ "runId": "run1", "taskSessionId": "task", "homeSessionId": "chat", "title": "Bench" });
    handoffs.note(&watch);
    assert_eq!(host.handoff_chats_of("task"), vec![("chat".to_owned(), "Bench".to_owned())]);
    handoffs.end("run1");
    assert!(host.handoff_chats_of("task").is_empty());
    handoffs.note(&watch);
    assert!(host.handoff_chats_of("task").is_empty(), "an ended run is not noted again");
}
