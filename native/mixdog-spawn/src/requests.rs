use super::*;

pub(super) fn stdin_write_request(manager: &Manager, stdin_write: u64, data: String, close: bool) {
    let managed = manager.live_process(stdin_write);
    if let Some(managed) = managed {
        // Write off the wire thread: a stalled child pipe must not
        // block request processing.
        thread::spawn(move || {
            let mut stdin = managed.stdin.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(handle) = stdin.as_mut() {
                let _ = handle.write_all(data.as_bytes());
                let _ = handle.flush();
            }
            if close {
                let _ = stdin.take();
            }
        });
    }
}

pub(super) fn stdin_close_request(manager: &Manager, stdin_close: u64) {
    let managed = manager.live_process(stdin_close);
    if let Some(managed) = managed {
        let _ = managed.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

// A request-id cancel reaches the command in whatever state it is registered:
// a finished contained command's kept survivors too, after its completion was
// reported.
pub(super) fn cancel_request(manager: &Arc<Manager>, cancel: u64) {
    if let Some(managed) = manager.entry(cancel) {
        cancel_targeted(&managed, manager, false);
    }
}

pub(super) fn cancel_task_request(manager: &Arc<Manager>, id: u64, cancel_task: &str) {
    let managed = manager.job(cancel_task).or_else(|| manager.entry_of_job(cancel_task));
    if let Some(managed) = managed {
        cancel_targeted(&managed, manager, true);
    } else {
        spawn_error(id, format!("task not found: {cancel_task}"));
    }
}

// A session close kills its running commands only: the survivors a finished
// command left run on.
pub(super) fn cancel_owner_request(manager: &Manager, id: u64, cancel_owner_session: &str) {
    let live: Vec<Arc<ManagedProcess>> = manager.lock_live().values().cloned().collect();
    let mut cancelled = 0usize;
    for managed in live {
        let mut state = managed.lock_state();
        if state.owner_session_id.as_deref() == Some(cancel_owner_session) && state.status == "running" && kill_running(&managed, &mut state) {
            state.status = "cancelled".to_string();
            state.error = Some("cancelled because the owning session closed".to_string());
            cancelled += 1;
        }
    }
    emit(&json!({ "id": id, "event": "owner_cancelled", "count": cancelled }));
}

pub(super) fn release_task_request(manager: &Manager, id: u64, release_task: String) {
    // Drop a SETTLED task's retained slot. A live task keeps its
    // slot: releasing it would strand a running process with no
    // way left to observe or cancel it.
    let released = {
        let mut jobs = manager.lock_jobs();
        match jobs.get(&release_task) {
            Some(managed) if managed.done.load(Ordering::Acquire) => {
                jobs.remove(&release_task);
                true
            }
            _ => false,
        }
    };
    if released {
        emit(&json!({ "id": id, "event": "task_released", "jobId": release_task }));
    } else {
        emit(&json!({
            "id": id,
            "event": "task_release_declined",
            "jobId": release_task,
        }));
    }
}

pub(super) fn task_status_request(manager: &Manager, id: u64, task_status: &str) {
    let managed = manager.job(task_status);
    if let Some(managed) = managed {
        emit_task(id, "task_status", &managed);
    } else {
        spawn_error(id, format!("task not found: {task_status}"));
    }
}

pub(super) fn task_list_request(manager: &Manager, id: u64, task_list: bool) {
    if !task_list {
        spawn_error(id, "invalid task list request");
        return;
    }
    let tasks: Vec<TaskSnapshot> = manager.lock_jobs().values().filter_map(|managed| managed.snapshot()).collect();
    emit(&json!({ "id": id, "event": "task_list", "tasks": tasks }));
}
