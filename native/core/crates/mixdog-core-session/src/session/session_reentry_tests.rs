//! `fixtures/session-reentry-cases` (`record-session-reentry-cases.mjs`, b6f10295a): the cases whose subject is the session's own
//! answer to a client, replayed through `turn/start` on the thread.

use std::sync::Arc;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ItemId;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::ItemCommit;
use super::SessionDirectory;
use super::handle::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::Script;
use super::tests::idle;
use super::tests::rows;
use super::tests::start_thread;
use crate::eventually_on;

fn observed(name: &str) -> Exact {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-reentry-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == name).cloned();
    found.unwrap_or_else(|| panic!("no recorded case {name:?}")).get("observed").clone()
}

/// The recorder's runtime: each submit appends its prompt and `reply: <prompt>`.
fn replies() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            let reply = ItemCommit {
                iid: ItemId::from(format!("a-{}", run.turn)),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "text": format!("reply: {text}") }),
                prompt: None,
            };
            run.port.commit_item(reply).await.expect("commit");
            RunOutcome::Completed(Default::default())
        })
    })
}

/// `submitToSession(id, prompt, { id })`: `turn/start` with the submission id; accepted when the session took it (started or queued,
/// or joined the submission that did).
async fn submit(handle: &SessionHandle, op: &str, prompt: &str, submission: &str) -> bool {
    let params = json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt, "options": { "clientSubmissionId": submission } } });
    let request = mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("turn/start"),
        params,
        op: Some(mixdog_core_api::ids::OpId::from(op)),
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    };
    let reply = handle.request(request).await.expect("turn/start");
    let Reply::Value(answer) = reply else { panic!("turn/start answers a value") };
    matches!(answer["kind"].as_str(), Some("started" | "queued"))
}

/// Case "a replayed submission id joins the original instead of double-submitting": two sends of one submission at once, then a third,
/// are all accepted and the prompt runs once.
#[tokio::test(start_paused = true)]
async fn a_replayed_submission_id_joins_the_original_as_node_recorded() {
    let observed = observed("a replayed submission id joins the original instead of double-submitting");
    let rig = Rig::new();
    rig.set_script(replies());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let both = tokio::join!(submit(&handle, "op-1", "once", "retry-id"), submit(&handle, "op-2", "once", "retry-id"));
    let again = submit(&handle, "op-3", "once", "retry-id").await;
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (idle(&handle) && rows(&handle).len() >= 2).then_some(())).await;
    let texts: Vec<String> = rows(&handle).into_iter().map(|(_, text)| text).collect();
    let once = texts.iter().filter(|text| *text == "once").count();
    let rust = json!({ "both": [both.0, both.1], "again": again, "onceCount": once, "texts": texts });
    let recorded = observed.get("both").clone();
    assert_eq!(Exact::plain(&rust["both"]), recorded, "both sends");
    assert_eq!(Exact::plain(&rust["again"]), *observed.get("again"), "the third send");
    assert_eq!(Exact::plain(&rust["onceCount"]), *observed.get("onceCount"), "the prompt ran once");
    assert_eq!(Exact::plain(&rust["texts"]), *observed.get("texts"), "the published texts");
}
