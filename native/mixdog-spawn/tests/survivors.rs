//! The survivors of a finished command are listed and reported gone from the operating system's
//! events, against a real job object (Windows) or process group (Linux).

mod common;

use std::time::Duration;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_spawn::survivors::ProcessSurvivors;
use tokio_util::sync::CancellationToken;

/// A command whose root exits at once, leaving a long sleeper that does not hold its output.
fn leaves_a_sleeper() -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: "$p = Start-Process ping -ArgumentList '-n','90','127.0.0.1' -PassThru -WindowStyle Hidden; \
                     Write-Output \"CHILD=$($p.Id)\""
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell {
            script: "sleep 90 >/dev/null 2>&1 & echo CHILD=$!".to_owned(),
            shell: None,
        }
    }
}

/// Runs the command to its exit and returns the sleeper's pid.
async fn run_and_find_sleeper(
    m: &mixdog_spawn::LocalProcessManager,
    h: &mixdog_protocol::ProcessHandle,
) -> u32 {
    run_and_find(m, h, leaves_a_sleeper()).await
}

async fn run_and_find(
    m: &mixdog_spawn::LocalProcessManager,
    h: &mixdog_protocol::ProcessHandle,
    command: CommandSpec,
) -> u32 {
    use mixdog_core_api::domain::process::ProcessManager;
    m.spawn(request(h, command)).await.unwrap();
    let (bytes, _) = collect(m, h).await;
    let out = text(&bytes);
    let at = out.find("CHILD=").expect("the command printed its child");
    out[at + 6..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap()
}

fn end_externally(pid: u32) {
    let status = if cfg!(windows) {
        std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output()
    } else {
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).output()
    };
    status.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_survivor_is_listed_and_its_end_wakes_the_waiter() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-wait");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    assert!(pid_alive(sleeper));
    let report = watch.survivors(&h).expect("the sleeper outlived its command");
    assert!(report.reachable);

    let waiter = tokio::spawn({
        let (watch, h) = (watch.clone(), h.clone());
        async move { watch.wait_gone(&h, &CancellationToken::new()).await }
    });
    // Nothing ends while the sleeper runs, however long the waiter has been parked.
    let mut waiter = waiter;
    assert!(tokio::time::timeout(Duration::from_millis(300), &mut waiter).await.is_err(), "the waiter returned with a survivor running");

    end_externally(sleeper);
    let confirmed = tokio::time::timeout(Duration::from_secs(10), waiter)
        .await
        .expect("the survivor's end wakes the waiter")
        .unwrap();
    assert!(confirmed, "the end of the last survivor is a confirmation");
    assert_eq!(watch.survivors(&h), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_ends_the_survivors_and_a_second_look_finds_none() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-kill");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    assert!(watch.survivors(&h).is_some());
    assert!(watch.kill(&h).await, "a fresh look finds every survivor gone");
    assert!(!pid_alive(sleeper), "the sleeper survived the kill");
    assert_eq!(watch.survivors(&h), None);
    // Nothing left: waiting returns at once.
    let confirmed = tokio::time::timeout(Duration::from_secs(2), watch.wait_gone(&h, &CancellationToken::new())).await.expect("nothing to wait for");
    assert!(confirmed);
}

/// An abort ends the wait with `false` (`waitForShellDescendants`), not with a confirmation: the survivor is still there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_abort_ends_the_wait_unconfirmed_and_leaves_the_survivor_running() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-abort");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    let abort = CancellationToken::new();
    let waiter = tokio::spawn({
        let (watch, h, abort) = (watch.clone(), h.clone(), abort.clone());
        async move { watch.wait_gone(&h, &abort).await }
    });
    abort.cancel();
    let confirmed = tokio::time::timeout(Duration::from_secs(10), waiter).await.expect("the abort ends the wait").unwrap();
    assert!(!confirmed, "an aborted wait confirms nothing");
    assert!(pid_alive(sleeper), "aborting a wait does not touch the survivor");
    assert!(watch.survivors(&h).is_some());
    assert!(!watch.wait_gone(&h, &abort).await, "an abort already raised answers false at once");
    end_externally(sleeper);
}

/// The cancel's own schedule (`killShellDescendants`): SIGTERM to the group first, and a survivor that ignores it is ended by
/// the forced stop that follows, so the kill still reports every one gone.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_survivor_that_ignores_sigterm_is_ended_by_the_forced_stop() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-ignores-term");
    let ignoring = CommandSpec::Shell {
        script: "(trap '' TERM; exec sleep 90) >/dev/null 2>&1 & echo CHILD=$!".to_owned(),
        shell: None,
    };
    let sleeper = run_and_find(&m, &h, ignoring).await;
    assert!(watch.survivors(&h).is_some());
    assert!(watch.kill(&h).await, "the forced stop ends what SIGTERM did not");
    assert!(!pid_alive(sleeper), "the sleeper survived the kill");
    assert_eq!(watch.survivors(&h), None);
}