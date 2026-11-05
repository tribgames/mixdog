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
    let first = fx.lifecycle.connection();
    let second = fx.lifecycle.connection();
    drop(first);
    assert!(!fx.recorder.has_exited(), "one client is still attached");
    drop(second);
    assert!(fx.recorder.wait_exit());
    assert_eq!(release_events(&fx.recorder.events()), RELEASE_ORDER);
    let exit = last_exit(fx.runtime_root.path());
    assert_eq!(exit["reason"], "noClients");
    assert_eq!(exit["instanceId"], "instance-1");
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Stopped);
}

#[test]
fn work_keeps_an_unattended_core_alive_until_it_ends() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let client = fx.lifecycle.connection();
    let work = fx.lifecycle.begin_activity(turn());
    drop(client);
    assert!(!fx.recorder.has_exited());
    assert_eq!(fx.lifecycle.status().state, StateName::Serving);
    drop(work);
    assert!(fx.recorder.wait_exit());
}

#[test]
fn goals_schedules_and_channels_keep_it_alive() {
    for kind in [ActivityKind::Goal, ActivityKind::Schedule, ActivityKind::Channel] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let client = fx.lifecycle.connection();
        let keeper = fx.lifecycle.begin_activity(ActivityInfo { kind, thread_id: None, turn_id: None, title: "k".into() });
        drop(client);
        assert!(!fx.recorder.has_exited(), "{kind:?}");
        drop(keeper);
        assert!(fx.recorder.wait_exit(), "{kind:?}");
    }
}

#[test]
fn an_update_stop_waits_for_running_work_and_nothing_times_it() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _client = fx.lifecycle.connection();
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
    assert!(fx.recorder.wait_exit());
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
    assert!(fx.recorder.wait_exit(), "the cancelled turn ended the idle wait, from inside the port");
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
    assert!(fx.recorder.wait_exit(), "a fence waits for nothing");
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
    let _client = fx.lifecycle.connection();
    let after = fx.lifecycle.status();
    assert!(after.seq_of_snapshot > before);
    assert_eq!(after.clients, 1);
}

#[test]
fn concurrent_sessions_register_and_end_without_losing_the_count() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _client = fx.lifecycle.connection();
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
