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
    answer_from(directory, PHONE, thread, approval, action).await
}

async fn answer_from(directory: &SessionDirectory, phone: ConnectionId, thread: &str, approval: &str, action: &str) -> Value {
    let request = CoreRequest {
        method: Method("thread/approval/answerNotification"),
        params: json!({ "threadId": thread, "approvalId": approval, "action": action }),
        op: None,
        ctx: CallContext::connection(phone, Origin::Relay, Default::default()),
    };
    match directory.request(request).await {
        Ok(Reply::Value(value)) => json!({ "value": value["outcome"] }),
        Ok(other) => panic!("a value reply, got {other:?}"),
        Err(error) => panic!("refused: {error:?}"),
    }
}

/// A card's decision (`thread/approval/answer`, Node's `resolveToolApprovalForSession`) as the page was given it.
async fn card_from(directory: &SessionDirectory, connection: ConnectionId, thread: &str, approval: &str, result: &Value) -> Value {
    let request = CoreRequest {
        method: Method("thread/approval/answer"),
        params: json!({ "threadId": thread, "approvalId": approval, "result": result }),
        op: None,
        ctx: CallContext::connection(connection, Origin::Relay, Default::default()),
    };
    match directory.request(request).await {
        Ok(Reply::Value(value)) => json!({ "value": value["accepted"] }),
        Ok(other) => panic!("a value reply, got {other:?}"),
        Err(error) => panic!("refused: {error:?}"),
    }
}

/// One recorded answer: the PC's card (`{approved: true}`, its outcome not recorded), a phone's card, or a notification's button.
async fn step_answer(directory: &SessionDirectory, thread: &str, approval: &str, step: &Value) -> Option<Value> {
    let by = step["by"].as_str().expect("an answerer");
    let connection = connection_of(by);
    if by == "desktop" {
        card_from(directory, connection, thread, approval, &json!({ "approved": true })).await;
        return None;
    }
    Some(match step.get("card") {
        Some(card) => card_from(directory, connection, thread, approval, card).await,
        None => answer_from(directory, connection, thread, approval, step["action"].as_str().expect("an action")).await,
    })
}

/// The connection each recorded answerer is (`RACE_DEVICES` of the script: the rig names a connection `desktop-<id>`).
fn connection_of(by: &str) -> ConnectionId {
    match by {
        "a" => ConnectionId(7),
        "b" => ConnectionId(8),
        "desktop" => ConnectionId(1),
        other => panic!("an answerer of the script, got {other}"),
    }
}

/// The recorded races, and the request they answer (the `shell` case of `approval-answers`).
fn races() -> (Vec<Value>, Value) {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../apps/mobile/fixtures/phone-pushes/golden.json")).expect("golden.json");
    let cases = golden["scenarios"]["approval-races"]["cases"].as_array().expect("cases").clone();
    (cases, golden["scenarios"]["approval-answers"]["cases"][0]["input"].clone())
}

/// A session waiting on `input`'s request, and the resolution its caller is handed once it is answered.
struct Waiting {
    _rig: Rig,
    directory: SessionDirectory,
    handle: Arc<crate::session::SessionHandle>,
    thread: String,
    id: String,
    resolved: Arc<Mutex<Option<ApprovalResolution>>>,
}

async fn waiting_on(input: &Value) -> Waiting {
    let rig = Rig::new();
    let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
    let seen = resolved.clone();
    let ask = ask_of(input);
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
    let shown = eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id)).await;
    let id = shown["id"].as_str().unwrap().to_owned();
    Waiting { _rig: rig, directory, handle, thread, id, resolved }
}

impl Waiting {
    /// The PC answering `{approved: true}` as a client's server-request response does (`on_response` → `RunControl::decide`).
    fn desktop_answers(&self) {
        mixdog_core_api::thread::RunControl::decide(
            &*self.handle,
            mixdog_core_api::thread::Decision {
                request: mixdog_core_api::ids::ServerRequestId(self.id.clone()),
                connection: connection_of("desktop"),
                device: String::new(),
                connection_kind: mixdog_protocol::ConnectionKind::Desktop,
                result: json!({ "approved": true }),
            },
        )
        .expect("the desktop's answer is taken");
    }

    /// The decision the session resolved the request with, as Node's session host was handed it (with the answering device).
    async fn took(&self, name: &str) -> Value {
        let handle = &self.handle;
        let resolution = eventually_on!(&[&handle.cell.stepped], || self.resolved.lock().unwrap().clone()).await;
        let ApprovalResolution::Decided { decision, device, .. } = resolution else { panic!("{name}: decided, got {resolution:?}") };
        let mut took = serde_json::to_value(decision).unwrap();
        took["device"] = json!(device);
        json!([took])
    }
}

/// Answers that meet at the session (scenario `approval-races`): every answer of a race is handed to the session before its actor
/// runs (the test runs on one thread and polls each answer once, without yielding, so the actor gets no turn until all are in, which
/// `member_approval` still showing the request proves). Each card and button is shown what Node's was, and the session takes Node's
/// decision.
#[tokio::test(flavor = "current_thread")]
async fn answers_that_meet_at_the_session_are_arbitrated_as_nodes() {
    let (races, input) = races();
    for case in &races {
        let name = case["name"].as_str().unwrap();
        let waiting = waiting_on(&input).await;
        let Waiting { directory, handle, thread, id, .. } = &waiting;
        let steps = case["shown"].as_array().unwrap();
        let raced = case["raced"].as_u64().unwrap() as usize;
        let mut answering: Vec<_> = steps[..raced].iter().map(|step| Box::pin(step_answer(directory, thread, id, step))).collect();
        let mut first = Vec::new();
        for answer in &mut answering {
            first.push(futures::poll!(answer.as_mut()));
        }
        if raced > 1 {
            assert!(directory.member_approval(&handle.id).is_some(), "{name}: every answer reached the session before it took one");
        }
        let mut outcomes = Vec::new();
        for (answer, polled) in answering.into_iter().zip(first) {
            outcomes.push(match polled {
                std::task::Poll::Ready(outcome) => outcome,
                std::task::Poll::Pending => answer.await,
            });
        }
        eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).is_none().then_some(())).await;
        for step in &steps[raced..] {
            outcomes.push(step_answer(directory, thread, id, step).await);
        }
        for (step, outcome) in steps.iter().zip(&outcomes) {
            assert_eq!(outcome.as_ref(), step.get("outcome"), "{name}: what {} was shown", step["by"]);
        }
        assert_eq!(waiting.took(name).await, case["took"], "{name}: the decision the session took");
    }
}

/// A room's answer to its member's approval goes the same way (`answer_member_approval`, Node's room `deps.approve`, which is the session
/// host's `resolveToolApprovalForSession`): in the recorded race where the PC's card got in first, the room's answer, made with the
/// phone's decision, is not taken (Node's `accepted` false, which the phone was shown as `settled`, remote-session-methods.ts:214).
#[tokio::test(flavor = "current_thread")]
async fn a_rooms_answer_that_meets_another_is_arbitrated_as_nodes() {
    let (races, input) = races();
    let case = races.iter().find(|case| case["name"] == "the desktop, then a phone").expect("the recorded race");
    let waiting = waiting_on(&input).await;
    waiting.desktop_answers();
    let step = &case["shown"][1];
    let mut answer = Box::pin(waiting.directory.answer_member_approval(
        &waiting.handle.id,
        &waiting.id,
        connection_of(step["by"].as_str().unwrap()),
        "room".into(),
        mixdog_protocol::ConnectionKind::Desktop,
        json!({ "approved": step["action"] == "allow" }),
    ));
    let first = futures::poll!(answer.as_mut());
    assert!(waiting.directory.member_approval(&waiting.handle.id).is_some(), "both answers reached the session before it took one");
    let accepted = match first {
        std::task::Poll::Ready(accepted) => accepted,
        std::task::Poll::Pending => answer.await,
    }
    .expect("the room's answer is a decision");
    assert_eq!(json!({ "value": if accepted { "answered" } else { "settled" } }), step["outcome"], "what the room's answer came to");
    assert_eq!(waiting.took("room").await, case["took"], "the decision the session took");
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
