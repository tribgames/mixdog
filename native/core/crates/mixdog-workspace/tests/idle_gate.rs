#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
//! The DS-WS-5 gate's own verdict: a lane job that touches either edge of an idle window must fail
//! it. A separate test binary, because the counters are process-wide and `no_polling` asserts zero.

use std::sync::mpsc;

use mixdog_workspace::lanes::idle_window_violation;
use mixdog_workspace::lanes::job_snapshot;
use mixdog_workspace::lanes::run;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread")]
async fn a_job_at_either_boundary_fails_the_window() {
    let tokens = mixdog_rt::testing::tokens();
    let cancel = CancellationToken::new();

    // Quiet window: passes.
    let (open, close) = (job_snapshot(), job_snapshot());
    assert_eq!(idle_window_violation(open, close), None);

    // A job already running when the window opens (its file work would span the window).
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (lane, token) = (tokens.interactive_io, cancel.clone());
    let long = tokio::spawn(async move {
        run(lane, &token, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })
        .await
    });
    entered_rx.recv().unwrap();
    let open = job_snapshot();
    assert_eq!(open.running, 1);
    release_tx.send(()).unwrap();
    long.await.unwrap().unwrap();
    let close = job_snapshot();
    assert!(idle_window_violation(open, close).unwrap().contains("already running when the window opened"));

    // A job that starts right after the window opens and is gone before it closes.
    let open = job_snapshot();
    run(tokens.interactive_io, &cancel, || ()).await.unwrap();
    let close = job_snapshot();
    assert_eq!(close.running, 0);
    assert!(idle_window_violation(open, close).unwrap().contains("started inside the window"));

    // A job that starts inside the window and is still running when it closes.
    let open = job_snapshot();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (lane, token) = (tokens.interactive_io, cancel.clone());
    let long = tokio::spawn(async move {
        run(lane, &token, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })
        .await
    });
    entered_rx.recv().unwrap();
    let close = job_snapshot();
    assert!(idle_window_violation(open, close).unwrap().contains("started inside the window"));
    release_tx.send(()).unwrap();
    long.await.unwrap().unwrap();
}
