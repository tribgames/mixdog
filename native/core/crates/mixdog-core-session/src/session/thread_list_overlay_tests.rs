//! The list rows' live overlay over the hosted threads (`LiveListOverlay`, Node
//! `withRuntimeActivity` + `withApprovalWaits`).

use std::sync::Arc;

use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::Method;
use mixdog_services::task_reports::host::BotWork;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::eventually;
use super::tests::start_thread;
use super::tests::turn;
use super::thread_list::ListOverlay;
use super::thread_list::LiveListOverlay;
use super::thread_list::RowOverlay;

/// A Lead whose turn waits on `ask_user`, a worker of that Lead whose turn runs, and a bot's work
/// in the Lead: the Lead's row is working, waits on a question, has an agent working and is the
/// bot's; the worker's row is working only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_overlay_carries_the_hosted_threads_live_facts() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if run.header.get("agent").and_then(|agent| agent.as_str()) != Some("worker") {
                let _ = run
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
            }
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let lead = start_thread(&directory).await;
    let worker = start_thread(&directory).await;
    let patch = json!({ "threadId": worker.id, "set": { "ownerSessionId": lead.id, "agent": "worker" }, "unset": [] });
    worker
        .request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("patch");
    let bots = Arc::new(BotWork::new(Arc::new(|_: &str| {})));
    bots.note("run-1", lead.id.as_str(), "bot1");
    let overlay = LiveListOverlay::new(directory.clone(), bots);

    assert_eq!(overlay.of(&lead.id), RowOverlay { handed_by: Some(vec!["bot1".into()]), ..RowOverlay::default() }, "nothing runs yet");
    turn(&lead, "ask me", "op-1").await;
    turn(&worker, "work", "op-2").await;
    eventually(|| (!lead.cell.approvals.load().is_empty() && worker.cell.run.load().is_some()).then_some(())).await;
    assert_eq!(
        overlay.of(&lead.id),
        RowOverlay {
            working: Some(true),
            agent_working: Some(true),
            awaiting_approval: Some(true),
            awaiting_question: Some(true),
            handed_by: Some(vec!["bot1".into()]),
        }
    );
    assert_eq!(overlay.of(&worker.id), RowOverlay { working: Some(true), ..RowOverlay::default() });
}
