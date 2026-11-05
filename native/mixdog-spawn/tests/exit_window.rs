//! A kill that races the exit's finalization is either in the published exit or refused. Alone
//! in its test binary because the window seam is process-wide.

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
}
