//! A member's approval as its room shows it, against `fixtures/room-approvals/golden.json`
//! (recorded from the real `ask-user-tool.mjs` callers, `normalizeToolApprovalRequest` and
//! `decorateRoomSnapshot`), and the room's answer through the session's decision path.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::session::SessionDirectory;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::eventually_on;
use crate::session::tests::start_thread;
use crate::session::tests::turn;


/// `requestToolApproval`'s delegation step: a sub-agent's request of a delegated kind names who asks and the chat it shows in;
/// a question, a connector widening and a request whose surface is its own session carry neither.
#[test]
fn a_sub_agents_card_names_its_chain_and_its_chat() {
    let surface = ApprovalSurface { session_id: "lead".into(), chain: vec!["Lead".into(), "Worker".into()] };
    let delegated = |kind: &str, session: &str| {
        let mut card = json!({ "kind": kind, "sessionId": session });
        delegate_card(&mut card, &surface);
        card
    };
    assert_eq!(delegated("approval", "w1"), json!({ "kind": "approval", "sessionId": "w1", "chain": ["Lead", "Worker"], "surfaceSessionId": "lead" }));
    assert_eq!(delegated("", "w1")["surfaceSessionId"], "lead");
    for (kind, session) in [("question", "w1"), ("connector", "w1"), ("approval", "lead")] {
        assert_eq!(delegated(kind, session), json!({ "kind": kind, "sessionId": session }), "{kind} of {session}");
    }
    // Read off the ask before the card is built: a bare gate (no kind) is delegated, a question and a connector widening are not.
    let ask = |kind: ApprovalKind, tool: &str, payload: Value| ApprovalAsk { kind, call_id: None, tool: Some(tool.to_owned()), action_kind: None, reason: None, payload, remember: Vec::new(), expires_after: None };
    assert!(is_delegated(&ask(ApprovalKind::Tool, "bash", json!({ "name": "bash", "args": { "command": "ls" } }))));
    assert!(!is_delegated(&ask(ApprovalKind::UserInput, "ask_user", json!({ "questions": [] }))));
    assert!(!is_delegated(&ask(ApprovalKind::Tool, "connect", json!({ "kind": "connector" }))));
}



/// The row a client is shown for `input`, its offered scopes only.
fn offered(input: Value) -> Value {
    normalize_tool_approval_request(input.as_object().expect("a request"), "1", 0)["remember"].clone()
}

/// Regression: the row took its scopes from the list it carried and judged the category only without a tool key, so a
/// payment carrying a tool key kept what it listed and an outbound row with no tool kept scopes nothing could store.
#[test]
fn a_row_offers_only_what_its_writer_can_store_whatever_it_lists() {
    let every = json!(["once", "session", "agent", "always"]);
    let outbound = |category: &str| json!({ "category": category, "target": "t", "account": "a", "payload": "", "editable": [], "details": {} });
    for category in ["payment", "delete"] {
        let row = json!({ "kind": "outbound", "remember": every, "grantAction": "tool:mcp__shop__buy", "outbound": outbound(category) });
        assert_eq!(offered(row), json!(["once"]), "outbound {category}");
        let row = json!({ "kind": "approval", "remember": every, "grantAction": "tool:mcp__shop__buy", "actionKind": category });
        assert_eq!(offered(row), json!(["once"]), "hook ask {category}");
    }
    let no_tool = json!({ "kind": "outbound", "remember": every, "outbound": outbound("email") });
    assert_eq!(offered(no_tool), json!(["once"]), "an outbound row naming no tool stores nothing");
    let email = json!({ "kind": "outbound", "remember": every, "grantAction": "tool:mcp__gmail__send_email", "outbound": outbound("email") });
    assert_eq!(offered(email.clone()), json!(["once", "session", "agent"]), "an outbound card never offers every agent");
    let mut unattended = email;
    unattended["unattended"] = json!(true);
    assert_eq!(offered(unattended), json!(["once", "agent"]), "no conversation scope where nobody attends");
    let hook = json!({ "kind": "approval", "remember": every, "grantAction": "tool:shell" });
    assert_eq!(offered(hook), json!(["once", "session", "always"]));
    let lists_less = json!({ "kind": "approval", "remember": ["once"], "grantAction": "tool:shell" });
    assert_eq!(offered(lists_less), json!(["once", "session", "always"]), "the row's own list decides nothing");
    let connector = json!({ "kind": "approval", "connectorPolicy": true, "remember": every });
    assert_eq!(offered(connector), json!(["once", "agent"]));
    for kind in ["permission", "secret", "takeover", "connector"] {
        assert_eq!(offered(json!({ "kind": kind, "remember": every })), json!(["once"]), "{kind}");
    }
}




/// A member's turn waits on ask_user: its snapshot carries the approval as the room reads it, a
/// room answer to another id is refused, and the answer to the shown one resolves the turn's
/// wait through the session's decision path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_reads_and_answers_the_members_approval() {
    let rig = Rig::new();
    let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
    let seen = resolved.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let resolution = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::UserInput,
                    call_id: None,
                    tool: Some("ask_user".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "questions": [{ "question": "Which one?" }] }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            *seen.lock().unwrap() = Some(resolution);
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(directory.member_approval(&handle.id), None, "nothing waits yet");
    turn(&handle, "ask me", "op-1").await;
    let shown = eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id)).await;
    assert_eq!((shown["name"].as_str(), shown["kind"].as_str()), (Some("ask_user"), Some("question")));
    assert_eq!(shown["sessionId"], json!(handle.id.as_str()));
    let snapshot = directory.member_snapshot(&handle.id).await.expect("snapshot");
    assert_eq!(snapshot["toolApproval"], shown);

    let id = shown["id"].as_str().unwrap().to_owned();
    let answer = |approval: String| {
        let (directory, thread) = (&directory, &handle.id);
        async move {
            directory.answer_member_approval(thread, &approval, ConnectionId(1), "desktop".into(), ConnectionKind::Desktop, mixdog_protocol::Origin::Local, json!({ "approved": true })).await
        }
    };
    assert!(!answer("999".into()).await.expect("refused"), "not the approval the member shows");
    assert!(answer(id.clone()).await.expect("answered"));
    let resolution = eventually_on!(&[&handle.cell.stepped], || resolved.lock().unwrap().clone()).await;
    assert!(matches!(resolution, ApprovalResolution::Decided { .. }), "{resolution:?}");
    eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).is_none().then_some(())).await;
}
