//! Stop races with root exit and with feed exit finalization. Alone in its
//! test binary because the window seams are process-wide.

mod common;

use std::time::Duration;
use std::time::Instant;

use common::*;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessManager;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_in_the_exit_window_is_refused_not_lost() {
    let m = manager();
    let h = handle("exit-window");
    mixdog_spawn::testing::arm_exit_window();
    m.spawn(request(&h, shell("echo done", "echo done"))).await.unwrap();
    // The process has ended and its reason is fixed; the exit is not published yet.
    tokio::task::spawn_blocking(mixdog_spawn::testing::wait_exit_window_entered)
        .await
        .unwrap();
    assert!(m.info(&h).unwrap().exit.is_none(), "the exit is held back");
    let result = m.kill_with(&h, KillReason::Requested);
    mixdog_spawn::testing::release_exit_window();
    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = loop {
        if let Some(exit) = m.info(&h).unwrap().exit {
            break exit;
        }
        assert!(Instant::now() < deadline, "the exit was never published");
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    match &result {
        Ok(()) => assert_eq!(exit.killed, Some(KillReason::Requested), "an accepted kill is in the exit"),
        Err(error) => {
            assert_eq!(*error, ProcessError::AlreadyExited);
            assert_eq!(exit.killed, None, "a refused kill leaves no reason");
        }
    }
    assert_eq!(result, Err(ProcessError::AlreadyExited), "the window is closed to kills");

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    {
        shutdown_keeps_the_already_observed_natural_exit().await;
        shutdown_during_startup_rollback_waits_for_the_real_root().await;
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
async fn shutdown_during_startup_rollback_waits_for_the_real_root() {
    use std::future::Future;
    use std::task::Poll;
    use mixdog_spawn::{ShutdownOutcome, testing};

    let m = manager();
    let other = manager();
    let h = handle("rollback-exit-window");
    let req = mixdog_core_api::domain::process::SpawnRequest {
        stdin_piped: true,
        ..request(&h, shell("sort.exe", "exec cat"))
    };
    let unrelated = other.spawn(req.clone()).await.unwrap();
    let created = testing::refuse_waiter(h.clone());
    let mut stop = Box::pin(m.shutdown());
    let (launch, pid, pending) = testing::with_root_exit_window(async {
        let launcher = m.clone();
        let launch = tokio::spawn(async move { launcher.spawn(req).await });
        let pid = tokio::time::timeout(WAIT, created).await.unwrap().unwrap();
        assert!(tokio::task::spawn_blocking(|| testing::wait_root_exit_window_entered(WAIT)).await.unwrap());
        let pending = std::future::poll_fn(|cx| Poll::Ready(stop.as_mut().poll(cx).is_pending())).await;
        (launch, pid, pending)
    }).await;

    let rejected = tokio::time::timeout(WAIT, launch).await.unwrap().unwrap();
    let outcome = tokio::time::timeout(WAIT, stop).await.unwrap();
    let unrelated_alive = pid_alive(unrelated.pid);
    let expected = if cfg!(windows) { ShutdownOutcome::Clean } else { ShutdownOutcome::Unverified };
    assert_eq!(tokio::time::timeout(WAIT, other.shutdown()).await.unwrap(), expected);
    assert!(pending, "shutdown cannot finish while the aborted launch still owns its root");
    assert_eq!(rejected, Err(ProcessError::Io { os_code: None }));
    assert_eq!(outcome, expected);
    assert!(!pid_alive(pid));
    assert!(unrelated_alive);
    assert_eq!(m.live(), 0);
    assert!(matches!(m.info(&h), Err(ProcessError::UnknownHandle)));
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
async fn shutdown_keeps_the_already_observed_natural_exit() {
    use std::future::Future;
    use std::task::Poll;

    use mixdog_core_api::domain::process::ExitStatus;
    use mixdog_spawn::ShutdownOutcome;
    use mixdog_spawn::testing::wait_root_exit_window_entered;
    use mixdog_spawn::testing::with_root_exit_window;

    let m = manager();
    let h = handle("shutdown-root-exit");
    let mut stop = Box::pin(m.shutdown());
    let pending = with_root_exit_window(async {
        m.spawn(request(&h, shell("exit /b 137", "exit 7"))).await.unwrap();
        assert!(tokio::task::spawn_blocking(|| wait_root_exit_window_entered(WAIT)).await.unwrap());
        std::future::poll_fn(|cx| Poll::Ready(stop.as_mut().poll(cx).is_pending())).await
    }).await;
    assert!(pending, "shutdown waits for exit publication");
    let expected = if cfg!(windows) { ShutdownOutcome::Clean } else { ShutdownOutcome::Unverified };
    assert_eq!(tokio::time::timeout(WAIT, stop).await.unwrap(), expected);
    let exit = m.info(&h).unwrap().exit.unwrap();
    assert_eq!(exit.status, ExitStatus::Code(if cfg!(windows) { 137 } else { 7 }));
    assert_eq!(exit.killed, None);
}
