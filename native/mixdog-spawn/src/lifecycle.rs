use super::*;

/// The final tree's event, emitted in the hold that made it final. A
/// RELEASED one whose breakaway could not be restored says so
/// (`breakawayRestored: false`): its survivors stay in a job they cannot
/// leave.
pub(super) fn emit_tree(id: u64, state: &TaskState) {
    let event = match state.tree {
        Tree::Empty => "tree_empty",
        Tree::Unverified => "tree_unverified",
        Tree::Released => "tree_released",
        _ => return,
    };
    let mut message = json!({ "id": id, "event": event });
    if state.breakaway_unrestored {
        message["breakawayRestored"] = json!(false);
    }
    emit(&message);
}

/// Under the state lock: let a contained job's survivors go (RELEASED): no
/// kill on close, breakaway allowed again, every kill refused. RELEASED is
/// final either way. A breakaway that could not be restored is recorded
/// (emit_tree, `exit`, task snapshots) and logged.
pub(super) fn release_held(managed: &ManagedProcess, state: &mut TaskState) {
    if let Err(error) = managed.preserve_descendants() {
        state.breakaway_unrestored = true;
        eprintln!(
            "mixdog-spawn: request {}: breakaway could not be restored for the survivors let go \
             ({error}); they remain in a job they cannot leave",
            managed.request_id
        );
    }
    state.tree = Tree::Released;
}

/// Under the state lock (`state`): the registry lets the command go once
/// nothing is left to decide: its completion reported and, contained, its
/// tree final. Its job handle goes with the last reference.
pub(super) fn deregister_held(manager: &Manager, managed: &ManagedProcess, state: &TaskState) {
    if !state.reported || (state.contained && !state.tree.is_final()) {
        return;
    }
    let mut live = manager.lock_live();
    if live.get(&managed.request_id).is_some_and(|entry| std::ptr::eq(entry.as_ref(), managed)) {
        live.remove(&managed.request_id);
    }
}

/// Every kill of a running command, under its state lock (`state`), the kill
/// issued in the same hold. Running: an uncontained command until its root
/// is done; a contained one while its tree is Open (the root runs, or exited
/// on its own and its job still settles), which the kill moves to Killing
/// (settle_tree verifies it). False, and nothing done, otherwise.
pub(super) fn kill_running(managed: &ManagedProcess, state: &mut TaskState) -> bool {
    if state.contained {
        if state.tree != Tree::Open {
            return false;
        }
        state.tree = Tree::Killing;
    } else if managed.done.load(Ordering::Acquire) {
        return false;
    }
    state.killed = true;
    managed.terminate();
    true
}

/// A targeted cancel, by request id or (`by_task`) by job id: the command
/// while it runs, else the survivors a contained command left kept in its
/// job (kill_kept_held). One state-lock hold.
pub(super) fn cancel_targeted(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, by_task: bool) {
    let mut state = managed.lock_state();
    if (!by_task || state.status == "running") && kill_running(managed, &mut state) {
        if by_task {
            state.status = "cancelled".to_string();
            state.error = Some("cancelled by task control".to_string());
        }
        return;
    }
    kill_kept_held(managed, manager, &mut state);
}

/// Under the state lock: survivors kept in their job (Preserved) are killed
/// through the job (kill on close again) and verified on their own thread,
/// like any contained kill. Nothing otherwise.
#[cfg(windows)]
pub(super) fn kill_kept_held(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, state: &mut TaskState) {
    if state.tree != Tree::Preserved {
        return;
    }
    state.tree = Tree::Killing;
    managed.control.rearm();
    managed.terminate();
    let (managed, manager) = (Arc::clone(managed), Arc::clone(manager));
    thread::spawn(move || verify_kill(&managed, &manager));
}

#[cfg(not(windows))]
pub(super) fn kill_kept_held(_: &Arc<ManagedProcess>, _: &Arc<Manager>, _: &mut TaskState) {}

/// Re-issue the kill of a command still being killed, under its state lock.
#[cfg(windows)]
pub(super) fn rekill(managed: &ManagedProcess) {
    let state = managed.lock_state();
    if state.tree == Tree::Killing {
        managed.terminate();
    }
}

/// A killed contained job (Killing), verified empty: EMPTY within
/// KILL_VERIFY (its kill re-issued meanwhile), else it stays Killing
/// ("pending") under the bounded late verification (watch_late).
#[cfg(windows)]
pub(super) fn verify_kill(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>) {
    managed.control.await_empty(KILL_VERIFY, || rekill(managed));
    let mut state = managed.lock_state();
    if state.tree != Tree::Killing {
        return;
    }
    if managed.control.active_processes() == Some(0) {
        state.tree = Tree::Empty;
        deregister_held(manager, managed, &state);
        return emit_tree(managed.request_id, &state);
    }
    drop(state);
    watch_late(Arc::clone(managed), Arc::clone(manager), LATE_EMPTY_POLL, LATE_VERIFY_DEADLINE, LATE_FAILURE_LIMIT);
}

/// Watch survivors kept in their job (Preserved) at `poll` until a kill or
/// the shutdown reap took them over (the tree is no longer Preserved), the
/// job empties (EMPTY), or `deadline` passes (RELEASED: let go as an
/// uncontained command's survivors are). Each check is one state-lock hold
/// that acts inside it; on its verdict the registry entry, and with it the job
/// handle, is let go.
#[cfg(windows)]
pub(super) fn watch_kept(managed: Arc<ManagedProcess>, manager: Arc<Manager>, poll: Duration, deadline: Duration) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let started = std::time::Instant::now();
        let id = managed.request_id;
        loop {
            thread::sleep(poll);
            pause(id, "watch_kept:check");
            let mut state = managed.lock_state();
            if state.tree != Tree::Preserved {
                return;
            }
            if managed.control.active_processes() == Some(0) {
                state.tree = Tree::Empty;
            } else if started.elapsed() >= deadline {
                release_held(&managed, &mut state);
            } else {
                continue;
            }
            deregister_held(&manager, &managed, &state);
            emit_tree(id, &state);
            drop(state);
            return pause(id, "watch_kept:decided");
        }
    })
}

/// Test builds: a named point at which a test can hold the thread that
/// reaches it (tests::gates), to drive one interleaving deterministically.
#[cfg(all(windows, test))]
pub(super) fn pause(id: u64, point: &'static str) {
    tests::gates::pause(id, point);
}

#[cfg(all(windows, not(test)))]
#[inline(always)]
pub(super) fn pause(_id: u64, _point: &'static str) {}

/// After the root's exit. A killed contained job must empty (verify_kill).
/// One whose root exited on its own first lets the console hosts it left
/// signal their exit (console_hosts::settle) and stays Open, so killable,
/// meanwhile: a cancel, deadline or the shutdown reap that
/// lands then makes it a killed job (Killing), verified like any other.
/// Otherwise, decided in one state-lock hold: EMPTY; or its survivors, which a
/// natural exit never kills, are kept in the job (PRESERVED, watch_kept),
/// where a later targeted cancel still kills exactly them; or, when the job
/// cannot keep them, they are let go (RELEASED).
#[cfg(windows)]
pub(super) fn settle_tree(managed: &Arc<ManagedProcess>, manager: &Arc<Manager>, exited_on_its_own: bool) {
    let control = &managed.control;
    if !control.contained {
        return;
    }
    let id = managed.request_id;
    if exited_on_its_own {
        console_hosts::settle(control.handle, console_hosts::SETTLE_DEADLINE, || {});
        pause(id, "settle:check");
        let mut state = managed.lock_state();
        if state.tree == Tree::Open {
            managed.done.store(true, Ordering::Release);
            if control.active_processes() == Some(0) {
                state.tree = Tree::Empty;
            } else if control.keep_survivors() {
                state.tree = Tree::Preserved;
                watch_kept(Arc::clone(managed), Arc::clone(manager), LATE_EMPTY_POLL, KEPT_WATCH);
            } else {
                release_held(managed, &mut state);
            }
            emit_tree(id, &state);
            drop(state);
            return pause(id, "settle:decided");
        }
    } else {
        // Not on its own: a kill reached it (Killing already), or waiting on
        // it failed and nothing is known: killed now.
        kill_running(managed, &mut managed.lock_state());
    }
    verify_kill(managed, manager);
}

#[cfg(not(windows))]
pub(super) fn settle_tree(_managed: &Arc<ManagedProcess>, _manager: &Arc<Manager>, _exited_on_its_own: bool) {}

/// The bounded late verification of a killed job that did not empty in time
/// (watch_late). Each check is given the job's process count (None when the
/// query failed) and, while members remain, re-issues the kill. It ends
/// EMPTY, or UNVERIFIED once `deadline` passed or `failure_limit` consecutive
/// queries or kills failed.
#[cfg(any(windows, test))]
pub(super) struct LateCheck {
    started: std::time::Instant,
    deadline: Duration,
    failure_limit: u32,
    failures: u32,
}

#[cfg(any(windows, test))]
impl LateCheck {
    pub(super) fn new(deadline: Duration, failure_limit: u32) -> Self {
        Self { started: std::time::Instant::now(), deadline, failure_limit, failures: 0 }
    }

    pub(super) fn step(&mut self, active: Option<u32>, kill: impl FnOnce() -> bool) -> Option<Tree> {
        match active {
            Some(0) => return Some(Tree::Empty),
            Some(_) if kill() => self.failures = 0,
            _ => self.failures += 1,
        }
        (self.failures >= self.failure_limit || self.started.elapsed() >= self.deadline).then_some(Tree::Unverified)
    }
}

/// A killed job still occupied after KILL_VERIFY, verified on its own thread.
/// Every check is one state-lock hold (and stops if the tree is no longer
/// Killing). On its verdict it reports EMPTY or UNVERIFIED and lets the
/// registry entry, and with it the job handle, go.
#[cfg(windows)]
pub(super) fn watch_late(
    managed: Arc<ManagedProcess>,
    manager: Arc<Manager>,
    poll: Duration,
    deadline: Duration,
    failure_limit: u32,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut check = LateCheck::new(deadline, failure_limit);
        loop {
            let mut state = managed.lock_state();
            if state.tree != Tree::Killing {
                return;
            }
            let active = managed.control.active_processes();
            if let Some(tree) = check.step(active, || managed.control.terminate()) {
                state.tree = tree;
                deregister_held(&manager, &managed, &state);
                return emit_tree(managed.request_id, &state);
            }
            drop(state);
            thread::sleep(poll);
        }
    })
}

/// Fold the root process's exit into the task's terminal status, exit code
/// and signal. A timeout, cancellation, recorded error or kill outranks the
/// raw exit status.
pub(super) fn settle_exit(state: &mut TaskState, status: std::io::Result<ExitStatus>) {
    state.finished_at_ms = Some(now_ms());
    match status {
        Ok(exit) => {
            state.exit_code = exit.code();
            // Unix: a signal death has code()==None; surface the signal
            // name so the JS contract (killed => result.signal) holds.
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if state.signal.is_none() {
                    if let Some(signal) = exit.signal() {
                        state.signal = Some(signal_name(signal));
                    }
                }
            }
            if state.timed_out {
                state.status = "failed".to_string();
                state.exit_code = Some(124);
            } else if state.status == "cancelled" {
                state.exit_code = Some(137);
                #[cfg(unix)]
                if state.signal.is_none() {
                    state.signal = Some("SIGKILL".to_string());
                }
            } else if state.error.is_some() {
                state.status = "failed".to_string();
                state.exit_code = Some(137);
            } else if state.killed {
                state.status = "cancelled".to_string();
                state.exit_code = Some(137);
                #[cfg(unix)]
                if state.signal.is_none() {
                    state.signal = Some("SIGKILL".to_string());
                }
            } else {
                state.status = if exit.success() { "completed".to_string() } else { "failed".to_string() };
            }
        }
        Err(error) => {
            state.status = "failed".to_string();
            state.error = Some(error.to_string());
        }
    }
}
