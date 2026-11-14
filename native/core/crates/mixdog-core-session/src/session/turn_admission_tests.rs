//! Every turn's workspace admission (`admitTurnWorkspace`, `turn-prepare.mjs:100`): the turn's
//! loop runs only once its session is admitted, the admission is released when the turn settles
//! (`releaseWorkspace` of `settleTurn`), and a refused admission fails the turn unrun. The
//! admitted turn then passes the workspace gate (`prepareTurnWorkspace`, `turn-prepare.mjs:110`)
//! before its loop.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::ThreadHandle;
use mixdog_scm::worktree::errors;
use mixdog_scm::worktree::errors::RefusalReason;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::idle;
use super::tests::request;
use super::tests::start_thread;
use super::tests::turn;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_runs_admitted_and_releases_its_admission_when_it_settles() {
    let rig = Rig::new();
    let seen = rig.admissions.seen.clone();
    let at_run: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = at_run.clone();
    rig.set_script(Arc::new(move |_run| {
        let (seen, record) = (seen.clone(), record.clone());
        Box::pin(async move {
            *lock(&record) = lock(&seen).clone();
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let id = handle.id.as_str();
    eventually_on!(&[&*rig.admissions.changed], || (lock(&rig.admissions.seen).len() == 2).then_some(())).await;
    assert_eq!(*lock(&at_run), vec![format!("admit:{id}")], "the loop ran admitted");
    assert_eq!(*lock(&rig.admissions.seen), vec![format!("admit:{id}"), format!("release:{id}")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_admission_fails_the_turn_unrun_with_the_refusals_text() {
    let rig = Rig::new();
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    rig.set_script(Arc::new(move |_run| {
        let flag = flag.clone();
        Box::pin(async move {
            flag.store(true, Ordering::SeqCst);
            RunOutcome::Completed(Default::default())
        })
    }));
    let text = super::worktree::thrown_message(&errors::busy(RefusalReason::FolderInUse));
    *lock(&rig.admissions.refuse) = Some(errors::busy(RefusalReason::FolderInUse));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    // The failed turn's end, with the refusal's text, is shown once its completion is durable (`publishTurnClose`), after the
    // run is gone: the feed says when.
    eventually_on!(&[&rig.feeds.published], || rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "turnEnd" && params.to_string().contains(&text)).then_some(())).await;
    assert!(idle(&handle), "the run is gone when its end is shown");
    assert!(!ran.load(Ordering::SeqCst), "the loop never ran");
    assert!(lock(&rig.admissions.seen).is_empty(), "nothing was admitted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_admitted_turn_passes_the_workspace_gate_with_its_submission_and_prompt_before_its_loop() {
    let rig = Rig::new();
    let prepared = rig.admissions.prepared.clone();
    let at_run: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = at_run.clone();
    rig.set_script(Arc::new(move |_run| {
        let (prepared, record) = (prepared.clone(), record.clone());
        Box::pin(async move {
            *lock(&record) = lock(&prepared).clone();
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let params = json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "fix the login page", "options": { "clientSubmissionId": "sub-1" } } });
    handle.request(request("turn/start", params, "op-1")).await.expect("turn/start");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(*lock(&at_run), vec![format!("{}:sub-1:fix the login page", handle.id.as_str())], "the loop ran past the gate");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refusing_workspace_gate_fails_the_turn_unrun_and_releases_its_admission() {
    let rig = Rig::new();
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    rig.set_script(Arc::new(move |_run| {
        let flag = flag.clone();
        Box::pin(async move {
            flag.store(true, Ordering::SeqCst);
            RunOutcome::Completed(Default::default())
        })
    }));
    let text = super::worktree::thrown_message(&errors::missing(None, None, None));
    *lock(&rig.admissions.refuse_prepare) = Some(errors::missing(None, None, None));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually_on!(&[&rig.feeds.published], || rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "turnEnd" && params.to_string().contains(&text)).then_some(())).await;
    assert!(!ran.load(Ordering::SeqCst), "the loop never ran");
    let id = handle.id.as_str();
    eventually_on!(&[&*rig.admissions.changed], || (lock(&rig.admissions.seen).len() == 2).then_some(())).await;
    assert_eq!(*lock(&rig.admissions.seen), vec![format!("admit:{id}"), format!("release:{id}")], "the admission is released");
}
