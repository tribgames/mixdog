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
