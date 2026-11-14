//! A member's approval as its room shows it, against `fixtures/room-approvals/golden.json`
//! (recorded from the real `ask-user-tool.mjs` callers, `normalizeToolApprovalRequest` and
//! `decorateRoomSnapshot`), and the room's answer through the session's decision path.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::approval::ApprovalRequest;
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

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/room-approvals/golden.json")).expect("golden.json")
}

fn obj(value: &Value) -> Obj {
    value.as_object().cloned().expect("an object")
}

/// Every recorded hook request, presented as Node's queue presented it.
#[test]
fn every_kind_is_presented_as_nodes_queue_presents_it() {
    for case in golden()["cases"].as_array().unwrap() {
        let at = case["requestedAt"].as_i64().unwrap();
        let shown = normalize_tool_approval_request(&obj(&case["input"]), case["id"].as_str().unwrap(), at);
        assert_eq!(shown, case["toolApproval"], "{}", case["name"]);
    }
}

/// The request the Rust caller builds for a recorded kind (`ask_user.rs`, `handoff.rs`
/// `takeover_ask` and the secret gate, `pipeline.rs` `approval_ask`); `None` for a kind no Rust
/// caller builds (a bare hook ask, connector, permission).
fn rust_request(case: &Value, thread: &str) -> Option<ApprovalRequest> {
    let input = obj(&case["input"]);
    let at = std::time::UNIX_EPOCH + Duration::from_millis(case["requestedAt"].as_u64().unwrap());
    let call = input.get("toolCallId").and_then(Value::as_str).map(|id| mixdog_protocol::ToolCallId::from(id.to_owned()));
    let (kind, tool, payload, expires) = match (input["name"].as_str(), input.get("kind").and_then(Value::as_str)) {
        (Some("ask_user"), Some("question")) => (ApprovalKind::UserInput, "ask_user".to_owned(), json!({ "questions": input["args"]["questions"] }), None),
        (Some("handoff_user"), Some("secret")) => {
            (ApprovalKind::Tool, "handoff_user".to_owned(), json!({ "kind": "secret", "secret": input["secret"] }), Some(mixdog_tools::state::handoff::SECRET_REQUEST_TIMEOUT))
        }
        (Some("handoff_user"), Some("takeover")) => {
            (ApprovalKind::Tool, "handoff_user".to_owned(), json!({ "kind": "takeover", "takeover": input["takeover"] }), Some(mixdog_tools::state::handoff::TAKEOVER_EXPIRY))
        }
        (Some(name), Some("approval" | "outbound")) => {
            let mut payload = input.clone();
            payload.shift_remove("sessionId");
            payload.shift_remove("toolCallId");
            (ApprovalKind::Tool, name.to_owned(), Value::Object(payload), None)
        }
        _ => return None,
    };
    Some(ApprovalRequest {
        id: ApprovalId(case["id"].as_str().unwrap().parse().unwrap()),
        thread_id: mixdog_core_api::ids::ThreadId::from(thread.to_owned()),
        surface_thread_id: mixdog_core_api::ids::ThreadId::from(thread.to_owned()),
        chain: Vec::new(),
        order: 1,
        requested_at: at,
        expires_at: expires.map(|after| at + after),
        ask: ApprovalAsk { kind, call_id: call, tool: Some(tool), action_kind: None, reason: None, payload, remember: Vec::new(), expires_after: expires },
    })
}

/// The approval book's request of each kind a Rust caller builds is the hook request Node's
/// caller sent, and the room shows it as Node's room showed it.
#[test]
fn the_books_request_is_the_hook_request_nodes_caller_sent() {
    let golden = golden();
    let thread = golden["session"].as_str().unwrap();
    let mut mapped = 0;
    for case in golden["cases"].as_array().unwrap() {
        let Some(request) = rust_request(case, thread) else { continue };
        assert_eq!(Value::Object(hook_request(&request)), case["input"], "{} request", case["name"]);
        let shown = tool_approval(&request);
        assert_eq!(shown, case["toolApproval"], "{} toolApproval", case["name"]);
        // The kind the actor reads off the ask, before the card exists, to look a sub-agent's surface up is the card's.
        assert_eq!(is_delegated(&request.ask), DELEGATED_KINDS.contains(&shown["kind"].as_str().unwrap_or_default()), "{} delegated", case["name"]);
        mapped += 1;
    }
    assert!(mapped >= 9, "{mapped}");
}

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

/// `decorateRoomSnapshot` for each recorded state.
#[test]
fn the_room_view_is_decorated_as_nodes() {
    let golden = golden();
    let state = |value: &Value| {
        (!value.is_null()).then(|| RoomViewState {
            speaking: value["speaking"].as_str().unwrap_or_default().to_owned(),
            speaking_name: value["speakingName"].as_str().unwrap_or_default().to_owned(),
            typing_id: value["typingId"].as_str().unwrap_or_default().to_owned(),
            approval: Some(value["approval"].clone()).filter(|a| !a.is_null()),
        })
    };
    for case in golden["decorations"].as_array().unwrap() {
        let questions = case["handoffQuestions"].as_array().cloned().unwrap_or_default();
        let view = decorate_room_view(state(&case["state"]).as_ref(), &case["snapshot"], &questions);
        assert_eq!(view, case["view"], "{}", case["name"]);
    }
    let snapshot = &golden["decorations"][0]["snapshot"];
    for case in golden["cases"].as_array().unwrap() {
        let speaking = RoomViewState {
            speaking: "gh.bot".into(),
            speaking_name: "Git Hub".into(),
            typing_id: "room-typing-n1".into(),
            approval: Some(case["toolApproval"].clone()),
        };
        assert_eq!(decorate_room_view(Some(&speaking), snapshot, &[]), case["roomView"], "{}", case["name"]);
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
