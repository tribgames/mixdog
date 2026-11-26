//! Lifecycle behaviour through the real handle, ports recorded.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures use blocking std")]

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreState;
use mixdog_core_session::session::StartHold;
use mixdog_protocol::DrainReason;

use super::testing::fixture;
use super::*;

fn turn() -> ActivityInfo {
    ActivityInfo { kind: ActivityKind::Turn, thread_id: Some("thread-1".into()), turn_id: Some("turn-1".into()), title: "refactor".into() }
}

fn last_exit(dir: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.join(LAST_EXIT_FILE)).unwrap()).unwrap()
}

const RELEASE_ORDER: [&str; 6] = ["final_barriers", "close_data_handles", "withdraw", "close_connections", "close_ext_host", "exit"];

fn release_events(events: &[String]) -> Vec<&str> {
    events.iter().map(String::as_str).filter(|e| RELEASE_ORDER.contains(e)).collect()
}

#[test]
fn the_last_client_leaving_an_idle_core_stops_it_when_no_grace_is_configured() {
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
    for (kind, text) in
        [(ClientKind::Session, "no live session clients"), (ClientKind::Channel, "no live channel clients"), (ClientKind::Remote, "remote clients changed")]
    {
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

/// A `Quit` request held back by a service call in flight reads 'service calls settled' (`daemon.mjs:543`, `drainDeferral` ->
/// 'calls'), the one recheck text that no recording could drive (no call stays in flight from outside); the order of the two kinds
/// follows Node's recheck chain: the kind that ends last names the stop.
#[test]
fn a_stop_held_back_by_calls_or_work_reads_the_one_that_settled_last() {
    for (calls_first, text) in [(true, "busy service work settled"), (false, "service calls settled")] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let call = fx.lifecycle.begin_call();
        let work = fx.lifecycle.begin_activity(turn());
        fx.lifecycle.request_stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
        if calls_first {
            drop(call);
            assert!(!fx.recorder.has_exited(), "the work still holds it");
            drop(work);
        } else {
            drop(work);
            assert!(!fx.recorder.has_exited(), "the call still holds it");
            drop(call);
        }
        fx.recorder.wait_exit();
        assert_eq!(release_reason(&fx.recorder.events()), [text]);
    }
}

#[test]
fn a_signal_s_name_wins_over_the_recheck_text() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.note_trigger("SIGTERM");
    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
    drop(work);
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["SIGTERM"]);
}

#[test]
fn a_replacement_and_the_users_own_stop_are_not_put_off_by_attached_clients() {
    // `daemon.mjs:512`: `!replacing &&` precedes the client check; the user's stop command waits for the exit.
    for reason in [StopReason::Update, StopReason::UserStop] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let _client = fx.lifecycle.connection(ClientKind::Session);
        fx.lifecycle.request_stop(StopMode::WhenIdle, reason, None).unwrap();
        fx.recorder.wait_exit();
    }
}

#[test]
fn the_causes_without_a_fact_to_carry_read_as_node_has_them() {
    // The control listener's stop of an idle core is Node's `POST /shutdown`, which calls `onClientsEmpty` (`routes.mjs:189-196`, `daemon.mjs:1245`).
    assert_eq!(ReleaseCause::Stop(StopReason::Quit).node_text(), "no live session clients");
    assert_eq!(ReleaseCause::Stop(StopReason::UserStop).node_text(), "no live session clients");
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
    fx.lifecycle.hold(true, None).unwrap();
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Held);
    let work = fx.lifecycle.begin_activity(turn());

    fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
    // Commit: admission sees the drain, deferred starts are released into it, which refuses them.
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Draining { reason: DrainReason::Update });
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Closed(DrainReason::Update));
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
    assert_eq!(fx.lifecycle.stop(StopMode::AbortConfirmed, StopReason::Quit, Some("guess")), Err(CommandError::ConfirmationInvalid));
    assert!(fx.recorder.cancelled().is_empty(), "no abort without the token");

    let token = fx.lifecycle.status().drain.clone().unwrap().confirm_token;
    fx.lifecycle.stop(StopMode::AbortConfirmed, StopReason::Quit, Some(&token)).unwrap();
    assert_eq!(fx.recorder.cancelled().len(), 1);
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Closed(DrainReason::Quit), "no turn starts after the abort");
    fx.recorder.wait_exit();
}

/// The desktop's quit: its clients are gone before it asks, so no drain notice reaches anyone to confirm. One `Force` request cancels the running
/// turn, waits for it to end, and the core leaves through its release with a recorded process-exit reason (what makes the exit close the agents).
#[test]
fn a_forced_stop_aborts_the_running_work_in_one_request_and_leaves_through_the_release() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let work = Arc::new(Mutex::new(Some(fx.lifecycle.begin_activity(turn()))));
    let ending = Arc::clone(&work);
    *fx.recorder.on_cancel.lock().unwrap() = Some(Box::new(move |_| drop(ending.lock().unwrap().take())));

    fx.lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
    fx.recorder.wait_exit();

    let cancelled = fx.recorder.cancelled();
    assert_eq!(cancelled.len(), 1, "the running work was cancelled");
    assert_eq!(cancelled[0].len(), 1);
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Closed(DrainReason::Quit), "no turn starts after the abort");
    let events = fx.recorder.events();
    assert_eq!(release_events(&events), RELEASE_ORDER);
    assert_eq!(release_reason(&events), [FORCED_STOP_TEXT]);
    assert!(mixdog_core_session::session::is_process_exit_reason(FORCED_STOP_TEXT), "the session directory closes the agents for it");
    assert_eq!(last_exit(fx.runtime_root.path())["reason"], "userStop");
    assert_eq!(fx.recorder.exit_code(), Some(0));
}

/// Node's forced `shutdown()` does not wait for the cancelled work (`daemon.mjs:268-296`): a turn that never answers its cancel does not hold the release
/// back, whose first steps (the sessions' teardown) finalise it; and a stop that waited for it would be killed by the launcher's wait first.
#[test]
fn a_forced_stop_does_not_wait_for_work_that_ignores_its_cancel() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let _stuck = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
    fx.recorder.wait_exit();
    assert_eq!(fx.recorder.cancelled().len(), 1, "it was cancelled");
    let events = fx.recorder.events();
    assert_eq!(release_events(&events), RELEASE_ORDER);
    // What must not be lost runs first: the stop steps (sessions, records, database) come before the connections and the extension host.
    let at = |name: &str| events.iter().position(|e| e == name).unwrap();
    assert!(at("close_data_handles") < at("close_connections") && at("close_data_handles") < at("close_ext_host"));
}

/// A forced stop of an idle core is just the release, and one that arrives in a drain already waiting for the work aborts it.
#[test]
fn a_forced_stop_of_an_idle_core_or_of_a_waiting_drain() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    fx.lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
    fx.recorder.wait_exit();
    assert!(fx.recorder.cancelled().iter().all(Vec::is_empty), "nothing ran, nothing was cancelled");

    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    let work = Arc::new(Mutex::new(Some(fx.lifecycle.begin_activity(turn()))));
    let ending = Arc::clone(&work);
    *fx.recorder.on_cancel.lock().unwrap() = Some(Box::new(move |_| drop(ending.lock().unwrap().take())));
    fx.lifecycle.request_stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
    assert!(fx.recorder.cancelled().is_empty(), "the idle wait cancels nothing");
    fx.lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
    fx.recorder.wait_exit();
    assert_eq!(fx.recorder.cancelled().len(), 1);
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
    assert_eq!(fx.recorder.serving_count(), 2, "the core is told it serves at the boot and again when the drain is cancelled");
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
    assert_eq!(fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None), Err(CommandError::Migrating));
    fx.lifecycle.set_serving().unwrap();
    assert_eq!(fx.recorder.published().last().unwrap().phase, DiscoveryPhase::Serving);
}

#[test]
fn clearing_a_blocked_verdict_returns_to_booting_without_migrating() {
    let fx = fixture();
    fx.lifecycle.set_blocked(Blocked::WaitExit { pid: 77 }).unwrap();
    assert_eq!(fx.lifecycle.status().state, StateName::Blocked);
    assert!(fx.recorder.published().last().unwrap().blocked.is_some());
    fx.lifecycle.set_booting().unwrap();
    assert_eq!(fx.lifecycle.status().state, StateName::Booting);
    assert!(fx.lifecycle.status().blocked.is_none());
    let published = fx.recorder.published();
    assert_eq!(published.last().unwrap().phase, DiscoveryPhase::Booting);
    assert!(published.last().unwrap().blocked.is_none());
    fx.lifecycle.set_serving().unwrap();
    assert!(fx.lifecycle.set_booting().is_err());
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
fn a_discovery_that_cannot_be_published_ends_the_core_through_the_release_with_exit_code_2() {
    // Node: the awaited initial publication rejects into `main().catch`, `shutdown('fatal boot error', 2)`.
    let fx = fixture();
    fx.lifecycle.set_migrating(Migration { kind: "sessions".into(), done: 0, total: 1 }).unwrap();
    fx.lifecycle.fail_boot();
    fx.recorder.wait_exit();
    assert_eq!(fx.recorder.exit_code(), Some(2));
    assert_eq!(release_events(&fx.recorder.events()), RELEASE_ORDER);
    assert_eq!(release_reason(&fx.recorder.events()), ["fatal boot error"]);
    assert_eq!(last_exit(fx.runtime_root.path())["reason"], "fatalBoot");
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Stopped);
}

#[test]
fn a_completed_stop_distinguishes_the_managed_drain_outcomes() {
    use mixdog_spawn::ShutdownOutcome;

    for (outcome, code, reason) in [
        (ShutdownOutcome::Clean, 0, "userStop"),
        (ShutdownOutcome::Unverified, 0, "userStop (managed process drain coverage unverified)"),
        (ShutdownOutcome::ConfirmedFailure, 1, "userStop (managed process drain failed)"),
    ] {
        let fx = fixture();
        assert!(fx.recorder.managed_drain.set(outcome).is_ok());
        fx.lifecycle.set_serving().unwrap();
        fx.lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
        fx.recorder.wait_exit();
        assert_eq!(fx.recorder.exit_code(), Some(code));
        assert_eq!(release_events(&fx.recorder.events()), RELEASE_ORDER);
        assert_eq!(last_exit(fx.runtime_root.path())["reason"], reason);
    }
}

/// The release's backstop is due only once every step could have used its whole budget; when it fires (here with the stop steps blocked),
/// the exit is on disk before the process ends, with the published managed-drain survivor and the fatal exit code kept.
#[test]
fn the_backstop_is_due_after_every_step_budget_and_records_the_exit_before_it_ends_the_process() {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::handle::TestBackstop;
    use super::testing::Recorder;
    use mixdog_spawn::ShutdownOutcome;

    /// The exit code, and the exit record on disk when the exit was called.
    struct ExitProbe {
        recorder: Arc<Recorder>,
        root: std::path::PathBuf,
        codes: mpsc::Sender<(i32, Option<serde_json::Value>)>,
    }

    impl Exiter for ExitProbe {
        fn exit(&self, code: i32) {
            let record = std::fs::read(self.root.join(LAST_EXIT_FILE)).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap());
            self.recorder.exit(code);
            let _ = self.codes.send((code, record));
        }
    }

    const WAIT: Duration = Duration::from_secs(10);
    let budgets = ReleaseBudgets::default();
    // Each step may take its whole budget: the release waits on every one of them at least once.
    let every_step = budgets.final_barriers
        + budgets.close_data_handles
        + budgets.record_exit
        + budgets.withdraw_discovery
        + budgets.close_connections
        + budgets.close_ext_host;
    for (fatal_boot, code, reason) in [(false, 1, "userStop (managed process drain failed)"), (true, 2, "fatalBoot (managed process drain failed)")] {
        let recorder = Arc::new(Recorder::default());
        let root = tempfile::tempdir().unwrap();
        let (codes, exits) = mpsc::channel();
        let lifecycle = Lifecycle::with_budgets(
            LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: root.path().to_owned() },
            Ports {
                core: recorder.clone(),
                discovery: recorder.clone(),
                exiter: Arc::new(ExitProbe { recorder: recorder.clone(), root: root.path().to_owned(), codes }),
            },
            budgets,
        );
        let (expire_now, expire) = mpsc::channel();
        let (armed, deadline) = mpsc::channel();
        *lifecycle.test_backstop.lock().unwrap() = Some(TestBackstop { armed, expire });
        let (entered, flush_entered) = mpsc::channel();
        let (unblock, blocked_flush) = mpsc::channel::<()>();
        recorder.managed_drain.set(ShutdownOutcome::ConfirmedFailure).unwrap();
        *recorder.after_managed_drain.lock().unwrap() = Some(Box::new(move || {
            let _ = entered.send(());
            let _ = blocked_flush.recv();
        }));

        if fatal_boot {
            lifecycle.fail_boot();
        } else {
            lifecycle.set_serving().unwrap();
            lifecycle.request_stop(StopMode::Force, StopReason::UserStop, None).unwrap();
        }
        flush_entered.recv_timeout(WAIT).expect("flush started after the manager result was published");
        assert_eq!(release_events(&recorder.events()), ["final_barriers", "close_data_handles"]);
        let armed = deadline.recv_timeout(WAIT).expect("the release armed its backstop");
        assert!(armed >= every_step, "the backstop ({armed:?}) is due before every step had its budget ({every_step:?})");
        expire_now.send(()).unwrap();
        let (exited, record) = exits.recv_timeout(WAIT).expect("backstop exited with the flush still blocked");
        assert_eq!(exited, code);
        let exit = record.expect("the exit was recorded before the process ended");
        assert_eq!(exit["reason"], reason);
        assert_eq!(exit["stuckStep"], "shutdownBudget");
        assert_eq!(release_events(&recorder.events()), ["final_barriers", "close_data_handles", "exit"]);

        // The recorder stands in for process exit. Let the abandoned release finish so no thread is left blocked.
        unblock.send(()).unwrap();
        assert_eq!(exits.recv_timeout(WAIT).expect("release finished after unblocking the flush").0, code);
        let events = recorder.events();
        let mut ordered = release_events(&events);
        assert_eq!(ordered.remove(2), "exit", "the backstop exited before teardown resumed");
        assert_eq!(ordered, RELEASE_ORDER);
    }
}

#[test]
fn terminate_answers_before_it_exits_and_records_the_stall() {
    let fx = fixture();
    fx.lifecycle.set_serving().unwrap();
    assert_eq!(fx.lifecycle.terminate("wrong", || panic!("no answer for a wrong token")), Err(CommandError::ConfirmationInvalid));
    fx.lifecycle.set_stalled_ms(4200);
    let token = fx.lifecycle.status().terminate_token.clone();
    let recorder = Arc::clone(&fx.recorder);
    fx.lifecycle.terminate(&token, move || assert!(!recorder.has_exited(), "answered first")).unwrap();
    assert!(fx.recorder.has_exited());
    let exit = last_exit(fx.runtime_root.path());
    assert_eq!(exit["reason"], "userTerminated");
    assert_eq!(exit["stalledMs"], 4200);
}

#[test]
fn terminate_withdraws_the_discovery_file_it_names_and_leaves_another_cores() {
    for (named, left) in [("instance-1", false), ("instance-2", true)] {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let file = crate::discovery::path(fx.runtime_root.path());
        std::fs::write(&file, serde_json::json!({ "core": { "instanceId": named } }).to_string()).unwrap();
        let token = fx.lifecycle.status().terminate_token.clone();
        fx.lifecycle.terminate(&token, || {}).unwrap();
        assert_eq!(file.exists(), left, "{named}");
    }
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

/// Node's grace (`client-grace.mjs`) through the real handle on a clock the test moves: a flapping client does not end the core.
#[test]
fn a_client_leaving_and_returning_inside_the_grace_does_not_stop_the_core() {
    use std::time::Duration;
    let timer = super::testing::ManualTimer::new();
    let fx = super::testing::fixture_with_grace(ClientGrace::node(), timer.clone());
    fx.lifecycle.set_serving().unwrap();
    drop(fx.lifecycle.connection(ClientKind::Session));
    assert_eq!(timer.armed(), [Duration::from_secs(10)]);
    timer.advance(Duration::from_secs(9));
    assert!(!fx.recorder.has_exited());
    let back = fx.lifecycle.connection(ClientKind::Session);
    assert!(timer.armed().is_empty(), "the client's return cancels the grace");
    timer.advance(Duration::from_secs(3600));
    assert!(!fx.recorder.has_exited());
    assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Serving);
    drop(back);
    assert_eq!(timer.armed(), [Duration::from_secs(10)], "a full grace again");
    timer.advance(Duration::from_secs(10));
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["no live session clients"]);
    assert_eq!(last_exit(fx.runtime_root.path())["reason"], "noClients");
}
#[test]
fn a_remote_client_leaving_gets_the_long_grace_and_the_turn_it_left_running_is_not_cut() {
    use std::time::Duration;
    let timer = super::testing::ManualTimer::new();
    let grace = ClientGrace { local: ClientGrace::NODE_LOCAL, remote: Some(ClientGrace::NODE_REMOTE) };
    let fx = super::testing::fixture_with_grace(grace, timer.clone());
    fx.lifecycle.set_serving().unwrap();
    let client = fx.lifecycle.connection(ClientKind::Remote);
    let work = fx.lifecycle.begin_activity(turn());
    drop(client);
    assert_eq!(timer.armed(), [Duration::from_secs(1800)]);
    timer.advance(Duration::from_secs(1799));
    assert!(!fx.recorder.has_exited());
    timer.advance(Duration::from_secs(1));
    assert!(!fx.recorder.has_exited(), "the running turn defers the stop");
    assert!(fx.recorder.cancelled().is_empty(), "and is not cancelled");
    drop(work);
    fx.recorder.wait_exit();
    assert_eq!(release_reason(&fx.recorder.events()), ["busy service work settled"]);
}
#[test]
fn a_client_arriving_while_the_core_is_winding_down_does_not_undo_the_release() {
    use std::time::Duration;
    let timer = super::testing::ManualTimer::new();
    let fx = super::testing::fixture_with_grace(ClientGrace::node(), timer.clone());
    fx.lifecycle.set_serving().unwrap();
    drop(fx.lifecycle.connection(ClientKind::Session));
    timer.advance(Duration::from_secs(10));
    let late = fx.lifecycle.connection(ClientKind::Session);
    fx.recorder.wait_exit();
    drop(late);
    timer.advance(Duration::from_secs(3600));
    assert_eq!(release_events(&fx.recorder.events()), RELEASE_ORDER, "one release");
}
/// Node's hold lapses by itself (`daemon-work-gate.mjs`: 120 s by default), so an installer that died never leaves the core refusing
/// work; a release before that drops the timer, and a hold taken while work runs is not taken.
#[test]
fn a_hold_lapses_after_its_ttl_and_a_release_drops_the_timer() {
    let timer = super::testing::ManualTimer::new();
    let fx = super::testing::fixture_with_grace(ClientGrace::immediate(), timer.clone());
    fx.lifecycle.set_serving().unwrap();
    fx.lifecycle.hold(true, None).unwrap();
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Held);
    timer.advance(std::time::Duration::from_secs(119));
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Held);
    timer.advance(std::time::Duration::from_secs(1));
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Open, "the TTL released the hold");
    assert!(!fx.lifecycle.status().hold);

    fx.lifecycle.hold(true, None).unwrap();
    fx.lifecycle.hold(false, None).unwrap();
    assert!(timer.armed().is_empty(), "a release drops the timer");

    let _work = fx.lifecycle.begin_activity(turn());
    fx.lifecycle.hold(true, None).unwrap();
    assert_eq!(*fx.lifecycle.hold_gate().borrow(), StartHold::Open, "running work keeps admission open");
}
