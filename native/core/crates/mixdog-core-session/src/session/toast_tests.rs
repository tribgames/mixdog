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
