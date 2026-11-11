//! `shell-run-settle.slow.test.mjs`: a foreground command whose kill could not be confirmed keeps its owner's workspace
//! busy until the command has really exited. Node holds the run's workspace admission (`releaseAdmissionOnConfirmedTermination`);
//! the core holds the command's row as termination-unconfirmed, which the workspace gate counts as one of the owner's
//! shell jobs (`assertLeadIdle`'s `shell-jobs`), and lets it go when the process exits.

use std::sync::atomic::Ordering::SeqCst;

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unconfirmed_foreground_kill_keeps_the_owner_busy_until_the_command_exits() {
    let rig = rig();
    rig.processes.refuse_kill.store(true, SeqCst);
    let call = ctx(&rig, "u1");
    let (owner, cancel) = (call.thread_id.clone(), call.cancel.clone());
    let processes = rig.processes.clone();
    let abort = tokio::spawn(async move {
        while processes.senders.lock().unwrap().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        cancel.cancel();
    });
    let answered = tokio::time::timeout(std::time::Duration::from_secs(30), rig.shell.call(&call, serde_json::json!({ "command": "node long-task.js" })))
        .await
        .expect("the cancelled call returns after the kill check");
    assert!(abort.is_finished(), "the call ended before it was cancelled: {answered:?}");

    let held = rig.runtime.config.tasks.thread_state(owner.as_str()).jobs;
    assert_eq!(held.len(), 1, "the killed command is still one of the owner's shell jobs");
    assert!(held[0].termination_unconfirmed, "{held:?}");
    let id = held[0].task_id.clone();

    // The process exits on its own: the hold ends and the row goes.
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.values_mut().next().expect("the command's process");
        send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(1), killed: None } });
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while rig.runtime.config.tasks.get(&id).is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the exited command's row goes within 30 s");
    assert!(rig.runtime.config.tasks.thread_state(owner.as_str()).jobs.is_empty(), "the owner is idle again");
}
