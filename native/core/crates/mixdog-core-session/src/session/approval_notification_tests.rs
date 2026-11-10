//! A notification's Allow / Deny against Node's (`apps/mobile/fixtures/phone-pushes/golden.json`, scenario `approval-answers`,
//! recorded by `benchmarks/rust-core/recorders/record-phone-pushes.mjs`): for each recorded approval, a session of the core waits on
//! the same request, shows it as Node's session showed it, and each recorded button gives the page's result and, when it answered,
//! resolves the approval with the decision Node handed its session (the device is the answering connection's).

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use crate::eventually_on;
use crate::session::SessionDirectory;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::tests::start_thread;
use crate::session::tests::turn;

/// `STALE_APPROVAL_ID` of the script: an id no session shows.
const STALE: &str = "999999";
/// The answering phone's connection; the rig names it `desktop-7` (the script's `APPROVAL_DEVICE`).
const PHONE: ConnectionId = ConnectionId(7);

fn recorded() -> Value {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/phone-pushes/golden.json")).expect("golden.json");
    golden["scenarios"]["approval-answers"].clone()
}

/// The request the session's caller makes for the recorded hook request: `ask_user`'s question, else a gate's request as the book holds it.
fn ask_of(input: &Value) -> ApprovalAsk {
    let mut payload = input.as_object().cloned().expect("an object");
    let (kind, tool) = match payload.get("name").and_then(Value::as_str) {
        Some("ask_user") => (ApprovalKind::UserInput, "ask_user".to_owned()),
        Some(name) => (ApprovalKind::Tool, name.to_owned()),
        None => panic!("a named request"),
    };
    let payload = if kind == ApprovalKind::UserInput { json!({ "questions": input["args"]["questions"] }) } else { payload.shift_remove("sessionId"); Value::Object(payload) };
    ApprovalAsk { kind, call_id: None, tool: Some(tool), action_kind: None, reason: None, payload, remember: Vec::new(), expires_after: None }
}

async fn answer(directory: &SessionDirectory, thread: &str, approval: &str, action: &str) -> Value {
    let request = CoreRequest {
        method: Method("thread/approval/answerNotification"),
        params: json!({ "threadId": thread, "approvalId": approval, "action": action }),
        op: None,
        ctx: CallContext::connection(PHONE, Origin::Relay, Default::default()),
    };
    match directory.request(request).await {
        Ok(Reply::Value(value)) => json!({ "value": value["outcome"] }),
        Ok(other) => panic!("a value reply, got {other:?}"),
        Err(error) => panic!("refused: {error:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_notifications_allow_and_deny_answer_as_nodes() {
    let recorded = recorded();
    for case in recorded["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap();
        let node = &case["toolApproval"];
        let rig = Rig::new();
        let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
        let seen = resolved.clone();
        let ask = ask_of(&case["input"]);
        rig.set_script(Arc::new(move |run| {
            let (seen, ask) = (seen.clone(), ask.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                *seen.lock().unwrap() = Some(run.port.request(ask).await);
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let thread = handle.id.as_str().to_owned();
        turn(&handle, "go", "op-1").await;
        let mut shown = eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id)).await;
        let id = shown["id"].as_str().unwrap().to_owned();
        for key in ["id", "sessionId", "requestedAt"] {
            shown[key] = node[key].clone();
        }
        assert_eq!(&shown, node, "{name}: the session shows the approval as Node's did");
        for step in case["answers"].as_array().unwrap() {
            let approval = if step["stale"] == json!(true) { STALE } else { id.as_str() };
            let outcome = answer(&directory, &thread, approval, step["action"].as_str().unwrap()).await;
            assert_eq!(outcome, step["outcome"], "{name}: {step}");
            if outcome["value"] != json!("answered") {
                continue;
            }
            let resolution = eventually_on!(&[&handle.cell.stepped], || resolved.lock().unwrap().clone()).await;
            let ApprovalResolution::Decided { decision, device, .. } = resolution else { panic!("{name}: decided, got {resolution:?}") };
            let mut decided = serde_json::to_value(decision).unwrap();
            decided["device"] = json!(device);
            assert_eq!(decided, step["decided"][0], "{name}: the decision Node handed its session");
            eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).is_none().then_some(())).await;
        }
    }
}
