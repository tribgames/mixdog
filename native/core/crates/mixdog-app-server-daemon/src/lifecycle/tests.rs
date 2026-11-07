//! Lifecycle behaviour through the real handle, ports recorded.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures use blocking std")]

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreState;
use mixdog_protocol::DrainReason;

use super::testing::fixture;
use super::*;

fn turn() -> ActivityInfo {
    ActivityInfo {
        kind: ActivityKind::Turn,
        thread_id: Some("thread-1".into()),
        turn_id: Some("turn-1".into()),
        title: "refactor".into(),
    }
}

fn last_exit(dir: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.join(LAST_EXIT_FILE)).unwrap()).unwrap()
}

const RELEASE_ORDER: [&str; 6] = [
    "final_barriers",
    "close_connections",
    "close_ext_host",
    "withdraw",
    "close_data_handles",
    "exit",
];

fn release_events(events: &[String]) -> Vec<&str> {
    events
        .iter()
        .map(String::as_str)
        .filter(|e| RELEASE_ORDER.contains(e))
        .collect()
}

#[test]
fn the_last_client_leaving_an_idle_core_stops_it_with_no_grace() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let first = fx.lifecycle.connection(ClientKind::Session);
    let second = fx.lifecycle.connection(ClientKind::Session);
    drop(first);
    assert!(!fx.recorder.has_exited(), "one client is still attached");
    drop(second);
    fx.recorder.wait_exit();
    assert_eq!(release_events(&fx.recorder.events()), RELEASE_ORDER);
    let exit = last_exit(fx.runtime_root.path());
    assert_eq!(exit["reason"], "noClients");
    assert_eq!(exit["instanceId"], "instance-1");
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Stopped);
}

fn release_reason(events: &[String]) -> Vec<&str> {
    events.iter().filter_map(|e| e.strip_prefix("release_started:")).collect()
}

#[test]
fn the_release_tells_the_core_node_s_text_of_the_cause_before_its_first_step() {
    // The last client leaving is Node's self-shutdown with no live session clients (`daemon.mjs:1245`).
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    drop(fx.lifecycle.connection(ClientKind::Session));
    fx.recorder.wait_exit();
    let events = fx.recorder.events();
    assert_eq!(release_reason(&events), ["no live session clients"]);
    let started = events.iter().position(|e| e.starts_with("release_started:")).unwrap();
    assert!(started < events.iter().position(|e| e == "final_barriers").unwrap(), "before the first step");
}

#[test]
fn a_signal_s_name_is_the_reason_the_trigger_noted() {
    // `daemon.mjs:1298-1308`: `shutdown('SIGTERM')`. The cause enum only says `quit`.
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    fx.lifecycle.note_trigger("SIGTERM");
    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["SIGTERM"]);
}

#[test]
fn the_last_client_of_each_registry_names_node_s_text() {
    // `daemon.mjs:1245`, `:917`, `:1159`.
    for (kind, text) in [
        (ClientKind::Session, "no live session clients"),
        (ClientKind::Channel, "no live channel clients"),
        (ClientKind::Remote, "remote clients changed"),
    ] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        drop(fx.lifecycle.connection(kind));
        fx.recorder.wait_exit();
        assert_eq!(release_reason(&fx.recorder.events()), [text]);
    }
}

#[test]
fn the_work_that_lets_the_core_stop_names_node_s_recheck_text() {
    // `daemon.mjs:543`, `:556`, `:1065`: the deferred self-shutdown, by what settled.
    for (settled, text) in [
        (None, "busy service work settled"),
        (Some(SERVICE_CALLS_SETTLED), "service calls settled"),
        (Some(MEMORY_AGENT_ACTIVITY_CHANGED), "memory agent activity changed"),
    ] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let client = fx.lifecycle.connection(ClientKind::Session);
        let work = match settled {
            Some(settled) => fx.lifecycle.begin_activity_settling(turn(), settled),
            None => fx.lifecycle.begin_activity(turn()),
        };
        drop(client);
        assert!(!fx.recorder.has_exited(), "the work keeps the core alive");
        drop(work);
        fx.recorder.wait_exit();
        assert_eq!(release_reason(&fx.recorder.events()), [text]);
    }
}

#[test]
fn a_replacement_names_the_build_it_is_for() {
    // `daemon.mjs:589`.
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    fx.lifecycle.stop_noting(StopMode::WhenIdle, StopReason::Update, None, "daemon replacement by revision/build 7/1.5.0").unwrap();
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["daemon replacement by revision/build 7/1.5.0"]);
}

#[test]
fn a_refused_stop_leaves_no_text_behind() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
    // Draining already: an abort without its token is refused, and its text must not stick to the release that follows.
    assert!(fx.lifecycle.stop_noting(StopMode::AbortConfirmed, StopReason::Quit, None, "stale").is_err());
    fx.lifecycle.note_trigger("SIGINT");
    drop(_work);
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["SIGINT"]);
}

#[test]
fn a_lost_owner_lock_names_its_file() {
    // `daemon.mjs:655`.
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    fx.lifecycle.fence_lock_file(std::path::Path::new("/data/daemon-owner.lock"));
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["owner lock file /data/daemon-owner.lock was deleted or replaced"]);
}

#[test]
fn the_causes_without_a_fact_to_carry_read_as_node_has_them() {
    // `Quit` and `UserStop` have no Node counterpart of their own; the parent's IPC message (`daemon.mjs:1311`) is the nearest.
    assert_eq!(ReleaseCause::Stop(StopReason::Quit).node_text(), "IPC shutdown");
    assert_eq!(ReleaseCause::Stop(StopReason::UserStop).node_text(), "IPC shutdown");
    assert_eq!(ReleaseCause::Fenced(FenceReason::LockLost).node_text(), "lockLost", "a fence Node has no text for keeps its own name");
}

#[test]
fn work_keeps_an_unattended_core_alive_until_it_ends() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let client = fx.lifecycle.connection(ClientKind::Session);
    let work = fx.lifecycle.begin_activity(turn());
    drop(client);
    assert!(!fx.recorder.has_exited());
    assert_eq!(fx.lifecycle.status().state, StateName::Serving);
    drop(work);
    fx.recorder.wait_exit();
}

#[test]
fn goals_schedules_and_channels_keep_it_alive() {
    for kind in [ActivityKind::Goal, ActivityKind::Schedule, ActivityKind::Channel] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let client = fx.lifecycle.connection(ClientKind::Session);
        let keeper = fx.lifecycle.begin_activity(ActivityInfo { kind, thread_id: None, turn_id: None, title: "k".into() });
        drop(client);
        assert!(!fx.recorder.has_exited(), "{kind:?}");
        drop(keeper);
        fx.recorder.wait_exit();
    }
}

#[test]
fn an_update_stop_waits_for_running_work_and_nothing_times_it() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _client = fx.lifecycle.connection(ClientKind::Session);
    let work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.hold(true).unwrap();
    assert!(*fx.lifecycle.hold_gate().borrow());

    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
    // Commit: admission sees the drain, deferred starts are released into it.
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Draining { reason: DrainReason::Update });
    assert!(!*fx.lifecycle.hold_gate().borrow());
    let notices = fx.recorder.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].running.len(), 1);
    assert_eq!(notices[0].running[0].title, "refactor");
    assert!(fx.recorder.published().iter().any(|d| d.phase == DiscoveryPhase::Draining && d.drain_id.is_some()));
    assert!(!fx.recorder.has_exited());

    drop(work);
    fx.recorder.wait_exit();
    assert_eq!(last_exit(fx.runtime_root.path())["reason"], "update");
}

#[test]
fn abort_needs_the_token_the_status_shows_and_then_cancels() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let work = Arc::new(Mutex::new(Some(fx.lifecycle.begin_activity(turn()))));
    // The cancelled turn ends as the core cancels it.
    let ending = Arc::clone(&work);
    *fx.recorder.on_cancel.lock().unwrap() = Some(Box::new(move |_| drop(ending.lock().unwrap().take())));

    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
    assert_eq!(
        fx.lifecycle.stop(StopMode::AbortConfirmed, StopReason::Quit, Some("guess")),
        Err(CommandError::ConfirmationInvalid)
    );
    assert!(fx.recorder.cancelled().is_empty(), "no abort without the token");

    let token = fx.lifecycle.status().drain.clone().unwrap().confirm_token;
    fx.lifecycle.stop(StopMode::AbortConfirmed, StopReason::Quit, Some(&token)).unwrap();
    assert_eq!(fx.recorder.cancelled().len(), 1);
    fx.recorder.wait_exit();
}

#[test]
fn cancel_drain_returns_to_serving_and_republishes_discovery() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Restart, None).unwrap();
    let drain_id = fx.lifecycle.status().drain.clone().unwrap().drain_id;
    fx.lifecycle.cancel_drain(&drain_id).unwrap();
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Serving);
    assert_eq!(fx.recorder.published().last().unwrap().phase, DiscoveryPhase::Serving);
    drop(work);
    assert!(!fx.recorder.has_exited(), "back to serving: nothing stops it");
}

#[test]
fn boot_progress_is_visible_and_a_stop_during_migration_is_refused() {
    let fx = fixture();
    fx.lifecycle.set_blocked(Blocked::WaitExit { pid: 77 }).unwrap();
    assert_eq!(fx.lifecycle.status().state, StateName::Blocked);
    fx.lifecycle.set_migrating(Migration { kind: "sessions".into(), done: 3, total: 9 }).unwrap();
    assert!(matches!(&*fx.lifecycle.state().borrow(), CoreState::Migrating(m) if m.done == 3 && m.total == 9));
    assert_eq!(
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None),
        Err(CommandError::Migrating)
    );
    fx.lifecycle.set_serving().unwrap();
    assert_eq!(fx.recorder.published().last().unwrap().phase, DiscoveryPhase::Serving);
}

#[test]
fn a_fence_leaves_at_once_with_its_reason() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.fence(FenceReason::LockLost);
    fx.recorder.wait_exit();
    assert_eq!(last_exit(fx.runtime_root.path())["reason"], "lockLost");
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Stopped);
}

#[test]
fn terminate_answers_before_it_exits_and_records_the_stall() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    assert_eq!(fx.lifecycle.terminate("wrong", || panic!("no answer for a wrong token")), Err(CommandError::ConfirmationInvalid));
    fx.lifecycle.set_stalled_ms(4200);
    let token = fx.lifecycle.status().terminate_token.clone();
    let recorder = Arc::clone(&fx.recorder);
    fx.lifecycle
        .terminate(&token, move || assert!(!recorder.has_exited(), "answered first"))
        .unwrap();
    assert!(fx.recorder.has_exited());
    let exit = last_exit(fx.runtime_root.path());
    assert_eq!(exit["reason"], "userTerminated");
    assert_eq!(exit["stalledMs"], 4200);
}

#[test]
fn status_snapshot_is_lock_free_and_orders_by_sequence() {
    let fx = fixture();
    let before = fx.lifecycle.status().seq_of_snapshot;
    fx.lifecycle.set_serving().unwrap();
    let _client = fx.lifecycle.connection(ClientKind::Session);
    let after = fx.lifecycle.status();
    assert!(after.seq_of_snapshot > before);
    assert_eq!(after.clients, 1);
}

#[test]
fn concurrent_sessions_register_and_end_without_losing_the_count() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _client = fx.lifecycle.connection(ClientKind::Session);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let lifecycle = Arc::clone(&fx.lifecycle);
            std::thread::spawn(move || {
                for _ in 0..200 {
                    let guard = lifecycle.begin_activity(turn());
                    drop(guard);
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert!(fx.lifecycle.status().running.is_empty());
    assert!(!fx.recorder.has_exited());
}
