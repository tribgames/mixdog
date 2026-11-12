//! `shell-run-settle.slow.test.mjs`: a foreground command whose kill could not be confirmed keeps its owner's workspace
//! busy until the command has really exited. Node holds the run's workspace admission (`releaseAdmissionOnConfirmedTermination`,
//! `shell-run-settle.mjs:46-104`): it follows confirmed termination, or an explicit release, and no timer. Its 60 s ceiling
//! (`UNCONFIRMED_KILL_CLEANUP_CEILING_MS`, `:28`) bounds only the capture and resource clean-up, which this core has no
//! counterpart of (the output is spilled files); the core holds the command's row as termination-unconfirmed, which the
//! workspace gate counts as one of the owner's shell jobs (`assertLeadIdle`'s `shell-jobs`), and lets it go when the
//! process exits (`cancel_foreground`: no time bound on the hold). Every wait here is an event under one deadline that
//! names it: the spawn, the call's return after the kill check, and the registry's publication of the owner's strip without the command.

use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use super::*;

const DEADLINE: Duration = Duration::from_secs(30);

/// The daemon shutting down during the wait (`fixtures/shell-settle-shutdown-cases`, `record-shell-settle-shutdown-cases.mjs`): Node
/// closes the owner and shuts its shell jobs down, which leaves the folder reserved; the reservation then ends with the command's
/// confirmed exit, or another session's release (the process stays). Each observation, in order, against Node's. The folder is
/// reserved when a row of the registry `reserves_folder` (the predicate the worktree gate reads), which Node reports as
/// `WORKTREE_BUSY_JOBS`; the core's close (`ShellControl::cancel_owned`) answers nothing, so Node's shutdown report (a count of
/// background jobs it cancelled) has no counterpart and is left out, as the manifest says.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shutdown_during_the_unconfirmed_wait_leaves_the_folder_reserved_as_in_node() {
    let golden: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-settle-shutdown-cases/golden.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let rig = rig();
        rig.processes.refuse_kill.store(true, SeqCst);
        let call = ctx(&rig, "u1");
        let (owner, cancel) = (call.thread_id.clone(), call.cancel.clone());
        let cancel_once_running = async {
            tokio::time::timeout(DEADLINE, rig.processes.spawned.notified()).await.expect("waited 30 s for the command's process to spawn");
            cancel.cancel();
        };
        let (answered, ()) = tokio::join!(
            tokio::time::timeout(DEADLINE, rig.shell.call(&call, serde_json::json!({ "command": "node long-task.js" }))),
            cancel_once_running
        );
        let _ = answered.expect("waited 30 s for the cancelled call to return after the kill check");
        let tasks = rig.runtime.config.tasks.clone();
        let busy = || tasks.list().iter().any(|row| row.reserves_folder());
        let code = |busy: bool| if busy { serde_json::json!("WORKTREE_BUSY_JOBS") } else { serde_json::Value::Null };
        let control = crate::exec::ShellControl::new(rig.runtime.clone(), rig.manager.clone());
        let mut seen = Vec::new();
        for step in case["observed"].as_array().unwrap() {
            let what = step["what"].as_str().unwrap();
            let value = match what {
                "the folder after the unconfirmed settle" => code(busy()),
                "the folder after the shutdown" => {
                    control.cancel_owned(&owner);
                    code(busy())
                }
                "the folder at the end" => {
                    // The exit case ends the reservation by the command's own exit; the release case already ended it.
                    if name.ends_with("exit") {
                        let mut strips = rig.strips.clone();
                        {
                            let mut senders = rig.processes.senders.lock().unwrap();
                            let (tx, seq) = senders.values_mut().next().expect("the command's process");
                            send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(1), killed: None } });
                        }
                        while busy() {
                            tokio::time::timeout(DEADLINE, strips.changed()).await.unwrap_or_else(|_| panic!("{name}: waited 30 s for the command's exit to end the reservation")).unwrap();
                        }
                    }
                    code(busy())
                }
                "the release by another session" => {
                    let id = tasks.list().into_iter().find(|row| row.termination_unconfirmed).expect("the held command's row").task_id;
                    let held = control.hold(&id).is_some();
                    control.release(&id);
                    serde_json::json!({ "released": held })
                }
                "the child after the release" => serde_json::json!(if rig.processes.senders.lock().unwrap().is_empty() { "exited" } else { "running" }),
                // Node's report of the background tasks its shutdown cancelled: the core's close answers nothing.
                "the shutdown answer" => continue,
                other => panic!("{name}: {other} has no replay"),
            };
            seen.push(serde_json::json!({ "what": what, "value": value }));
        }
        let want: Vec<_> = case["observed"].as_array().unwrap().iter().filter(|s| s["what"] != "the shutdown answer").cloned().collect();
        assert_eq!(seen, want, "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unconfirmed_foreground_kill_keeps_the_owner_busy_until_the_command_exits() {
    let rig = rig();
    rig.processes.refuse_kill.store(true, SeqCst);
    let call = ctx(&rig, "u1");
    let (owner, cancel) = (call.thread_id.clone(), call.cancel.clone());
    let cancel_once_running = async {
        tokio::time::timeout(DEADLINE, rig.processes.spawned.notified()).await.expect("waited 30 s for the command's process to spawn");
        cancel.cancel();
    };
    let (answered, ()) = tokio::join!(
        tokio::time::timeout(DEADLINE, rig.shell.call(&call, serde_json::json!({ "command": "node long-task.js" }))),
        cancel_once_running
    );
    let _ = answered.expect("waited 30 s for the cancelled call to return after the kill check");

    let held = rig.runtime.config.tasks.thread_state(owner.as_str()).jobs;
    assert_eq!(held.len(), 1, "the killed command is still one of the owner's shell jobs");
    assert!(held[0].termination_unconfirmed, "{held:?}");

    // The process exits on its own: the hold ends and the row goes.
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.values_mut().next().expect("the command's process");
        send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(1), killed: None } });
    }
    let mut strips = rig.strips.clone();
    // The registry publishes under its own lock, so the row is read here, outside any watch lock.
    // What a client sees of the hold ending is the owner's strip: the row leaves it when the command's exit is confirmed.
    while !rig.runtime.config.tasks.thread_state(owner.as_str()).jobs.is_empty() {
        tokio::time::timeout(DEADLINE, strips.changed()).await.expect("waited 30 s for the owner's strip to drop the exited command").unwrap();
    }
    assert!(rig.runtime.config.tasks.thread_state(owner.as_str()).jobs.is_empty(), "the owner is idle again");
}
