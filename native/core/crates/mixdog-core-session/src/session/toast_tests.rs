//! The toast queue (`notice-surface.mjs` `pushToast`): a toast stays for its 3 s and is then removed and published; a
//! cleared or closed session's timers are cancelled (`clearToastTimers`, `session-reset.mjs:50`, `dispose.mjs:23`).

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::control::Ctl;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

/// The `toasts` of the newest `thread/runtime/updated` on `thread`'s feed, `None` before one is published.
fn published_toasts(rig: &Rig, thread: &ThreadId) -> Option<Vec<Value>> {
    rig.feeds
        .frames(thread.as_str())
        .into_iter()
        .rev()
        .find(|(_, method, _)| method == "thread/runtime/updated")
        .map(|(_, _, params)| params["value"]["toasts"].as_array().cloned().unwrap_or_default())
}

/// How many `thread/runtime/updated` frames `thread`'s feed holds.
fn runtime_frames(rig: &Rig, thread: &ThreadId) -> usize {
    rig.feeds.frames(thread.as_str()).iter().filter(|(_, method, _)| method == "thread/runtime/updated").count()
}

/// A rig whose runs fail: `failTurn` raises its toast (`pushNotice(failureDetail, 'error', { owner: 'transcript' })`,
/// `turn.mjs:570`).
fn failing_rig() -> Rig {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "boom".into(), data: json!({}), provider_error: None })
        })
    }));
    rig
}

/// A failed turn on a new thread, and the toast it raised once the session published it. Woken by the session's steps,
/// never by the clock: the 3 s are counted from the push.
async fn thread_with_toast(rig: &Rig) -> (SessionDirectory, Arc<SessionHandle>, Vec<Value>) {
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let shown = eventually_on(&[&handle.cell.stepped], || published_toasts(rig, &handle.id).filter(|toasts| !toasts.is_empty())).await;
    (directory, handle, shown)
}

/// A failed turn's toast is in the runtime section for 3 s: 2999 ms in it is still there, 1 ms later it is removed and
/// the removal is published.
#[tokio::test(start_paused = true)]
async fn a_toast_stays_three_seconds_then_is_removed_and_published() {
    let rig = failing_rig();
    let (_directory, handle, shown) = thread_with_toast(&rig).await;
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["tone"], "error");
    assert_eq!(shown[0]["owner"], "transcript");
    assert!(shown[0]["id"].as_str().is_some_and(|id| !id.is_empty()));

    tokio::time::advance(Duration::from_millis(2999)).await;
    tokio::task::yield_now().await;
    assert_eq!(published_toasts(&rig, &handle.id), Some(shown.clone()), "2999 ms in, the toast is still published");

    tokio::time::advance(Duration::from_millis(1)).await;
    let gone = eventually_on(&[&handle.cell.stepped], || published_toasts(&rig, &handle.id).filter(|toasts| toasts.is_empty())).await;
    assert!(gone.is_empty(), "at 3000 ms the removal is published");
}

/// The turn's close does not take the toast: the queue is the session's own and leaves with its timer, so the runtime frame that
/// follows `turn/completed` (and the state a client reads then) still holds the failure's toast.
#[tokio::test(start_paused = true)]
async fn the_turns_close_leaves_its_toast_in_the_runtime_state() {
    let rig = failing_rig();
    let (_directory, handle, shown) = thread_with_toast(&rig).await;
    eventually_on(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on(&[&handle.cell.stepped], || {
        rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, _)| method == "turn/completed").then_some(())
    })
    .await;
    assert_eq!(published_toasts(&rig, &handle.id), Some(shown.clone()), "the frame after turn/completed holds the toast");
    let held = handle.cell.view.load_full().state.runtime.clone().expect("runtime").toasts;
    assert_eq!(held, shown);
}
/// The notice a sign-in or sign-out posts (`pushNotice(text, 'info')` of the session extensions API) is a toast of the session it
/// was made on, with the text polished as Node's surface polished it (`fixtures/mcp-login-notices`); a thread no loaded session
/// hosts shows nothing.
#[tokio::test(start_paused = true)]
async fn a_posted_notice_is_the_toast_node_showed() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/mcp-login-notices/golden.json")).expect("fixture");
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let mut posted = 0;
    for flow in golden["flows"].as_array().expect("flows") {
        let Some(notice) = flow["events"].as_array().expect("events").iter().find_map(|event| event.get("notice")) else { continue };
        let handle = start_thread(&directory).await;
        let session = directory.hosting(&handle.id).expect("hosted");
        session.push_toast(notice["text"].as_str().unwrap(), notice["tone"].as_str().unwrap()).await.unwrap_or_else(|cause| panic!("{}: {cause}", flow["name"]));
        let shown = published_toasts(&rig, &handle.id).expect("published");
        let without_ids: Vec<Value> = shown.iter().map(|toast| json!({ "text": toast["text"], "tone": toast["tone"] })).collect();
        assert_eq!(Value::Array(without_ids), flow["toasts"], "{}", flow["name"]);
        assert!(shown.iter().all(|toast| toast["id"].as_str().is_some_and(|id| !id.is_empty()) && toast.get("owner").is_none()));
        posted += 1;
    }
    assert!(posted > 0, "the recording holds notices");
    assert!(directory.hosting(&ThreadId::from("not-loaded")).is_none(), "a cold session has no incarnation");
}

/// An earlier record the store has not acknowledged holds the outbox, and with it the toast: `push_toast` (the sign-in notice
/// that MCP's reply waits for, as Node posted it before returning) answers only once the toast's runtime frame is published,
/// never while the record before it is still held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_toast_behind_an_unacknowledged_record_answers_only_when_it_is_published() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *super::testing::lock(&rig.store.commit_gate) = Some((arrived.clone(), go.1));
    let renamed = {
        let (handle, id) = (handle.clone(), handle.id.clone());
        tokio::spawn(async move {
            let rename = CoreRequest {
                method: Method("thread/name/set"),
                params: json!({ "threadId": id, "opId": "op-name", "title": "renamed" }),
                op: Some(OpId::from("op-name")),
                ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
            };
            handle.request(rename).await
        })
    };
    // The record is at the store, unacknowledged.
    arrived.notified().await;

    let session = directory.hosting(&handle.id).expect("hosted");
    let mut toast = Box::pin(session.push_toast(TEXT, "info"));
    assert!(futures::poll!(toast.as_mut()).is_pending());
    // The inbox is in order: once this answers, the actor has taken the toast.
    let (tx, taken) = tokio::sync::oneshot::channel();
    handle.inbox.send(super::actor::Inbox::QuotaFacts { tx }).await.expect("the actor takes the inbox");
    taken.await.expect("the actor answers");

    assert!(futures::poll!(toast.as_mut()).is_pending(), "the held toast is not yet answered");
    assert!(toast_frames(&rig, &handle.id).is_empty(), "nothing of it is published");
    assert!(!renamed.is_finished(), "the record before it is still held");

    // The record is acknowledged; the toast's frame is then released, and held again just before it is recorded.
    let (feed_arrived, feed_go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *super::testing::lock(&rig.feeds.publish_gate) = Some((TEXT.to_owned(), feed_arrived.clone(), feed_go.1));
    go.0.send(()).expect("the commit waits");
    feed_arrived.notified().await;
    assert!(futures::poll!(toast.as_mut()).is_pending(), "the toast is released but not yet published");
    assert!(toast_frames(&rig, &handle.id).is_empty());

    feed_go.0.send(()).expect("the publication waits");
    toast.await.expect("answered once published");
    // The history, not the newest state: the toast's 3 s expiry may already have cleared it.
    let frames = toast_frames(&rig, &handle.id);
    assert_eq!(frames.len(), 1, "one frame carries the toast");
    let toasts = frames[0]["params"]["value"]["toasts"].as_array().expect("toasts");
    assert_eq!(toasts.iter().map(|toast| (toast["text"].clone(), toast["tone"].clone())).collect::<Vec<_>>(), [(json!(TEXT), json!("info"))]);
    renamed.await.expect("joined").expect("name/set");
}

const TEXT: &str = "mcp sign-in started: linear";

/// The runtime frames of `thread`'s whole publication history that carry the sign-in toast.
fn toast_frames(rig: &Rig, thread: &ThreadId) -> Vec<Value> {
    rig.feeds
        .history(thread.as_str())
        .into_iter()
        .map(|(_, frame)| frame)
        .filter(|frame| frame["params"]["value"]["toasts"].as_array().is_some_and(|toasts| toasts.iter().any(|toast| toast["text"] == TEXT)))
        .collect()
}

/// `thread/clear` empties the queue and cancels the timers: past the toast's 3 s nothing more is published.
#[tokio::test(start_paused = true)]
async fn a_cleared_session_publishes_no_expiry() {
    let rig = failing_rig();
    let (_directory, handle, _shown) = thread_with_toast(&rig).await;
    eventually_on(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let clear = CoreRequest {
        method: Method("thread/clear"),
        params: json!({ "threadId": handle.id, "opId": "op-clear" }),
        op: Some(OpId::from("op-clear")),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    };
    handle.request(clear).await.expect("clear");
    eventually_on(&[&handle.cell.stepped], || published_toasts(&rig, &handle.id).filter(|toasts| toasts.is_empty())).await;
    let published = runtime_frames(&rig, &handle.id);

    tokio::time::advance(Duration::from_millis(3000)).await;
    tokio::task::yield_now().await;
    assert_eq!(runtime_frames(&rig, &handle.id), published, "no timer of the cleared queue publishes");
}

/// A closed thread cancels its timers: past the toast's 3 s nothing more is published.
#[tokio::test(start_paused = true)]
async fn a_closed_session_publishes_no_expiry() {
    let rig = failing_rig();
    let (_directory, handle, _shown) = thread_with_toast(&rig).await;
    let published = runtime_frames(&rig, &handle.id);
    let stopped = format!("stopped:{}", handle.id.as_str());

    handle.cell.close();
    handle.cell.ctl_tx.try_send(Ctl::Unsubscribed).expect("the control lane has room");
    // The actor's last step; yielding moves no clock.
    while !rig.snapshots.0.lock().unwrap().contains(&stopped) {
        tokio::task::yield_now().await;
    }

    tokio::time::advance(Duration::from_millis(3000)).await;
    tokio::task::yield_now().await;
    assert_eq!(runtime_frames(&rig, &handle.id), published, "no timer of the closed thread publishes");
}
