//! The background task count (`spawn_task`) settles however the task ends.

use std::time::Duration;

use super::runtime::{GoalConfig, GoalEnv, GoalRuntime};

fn runtime() -> GoalRuntime {
    GoalRuntime::new(GoalConfig::new("unused"), GoalEnv::system(mixdog_rt::testing::tokens().durability_io))
}

/// A panicking task used to skip the decrement: `settled` and `close` then waited forever. The
/// paused clock makes the bound deterministic: the timeout fires only if nothing else can run.
#[tokio::test(start_paused = true)]
async fn a_panicking_background_task_still_settles_and_closes() {
    let runtime = runtime();
    runtime.inner.spawn_task(async { panic!("background task failure") });
    runtime.inner.spawn_task(async {});
    mixdog_rt::time::timeout(Duration::from_secs(60), runtime.settled()).await.expect("settled returned");
    mixdog_rt::time::timeout(Duration::from_secs(60), runtime.close()).await.expect("close returned");
}

#[tokio::test]
async fn snapshot_probes_allocate_no_slots_and_unloaded_or_deleted_sessions_release_theirs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = GoalRuntime::new(GoalConfig::new(dir.path().to_string_lossy().into_owned()), GoalEnv::system(mixdog_rt::testing::tokens().durability_io));

    assert!(runtime.snapshot("s-absent").await.expect("snapshot").is_none());
    assert!(runtime.stored_snapshot("s-absent").await.expect("stored").is_none());
    assert!(runtime.legacy_tasks("s-absent").await.is_empty());
    assert!(runtime.tool_status("s-absent").await.expect("status").is_none());
    runtime.reset_continuation_rules("s-absent").expect("reset");
    assert_eq!(runtime.slots_held(), 0, "read-only probes allocate no slots");

    runtime.tool_create("s-blocked", "Finish".into(), None).await.expect("create");
    runtime.tool_settle("s-blocked", "block", Some("Need key".into())).await.expect("block");
    runtime.settle_turn("s-blocked", serde_json::json!({ "status": "completed" })).await.expect("settle turn");
    assert_eq!(runtime.slots_held(), 1);
    runtime.release_unloaded("s-blocked");
    assert_eq!(runtime.slots_held(), 0, "unloading a non-running session releases its slot");

    let probed = runtime.snapshot("s-blocked").await.expect("re-read").expect("stored blocked goal");
    assert_eq!(probed.get("status").and_then(|v| v.as_str()), Some("blocked"));
    assert_eq!(runtime.slots_held(), 0, "probing a stored non-running goal allocates no permanent slot");

    runtime.tool_create("s-active", "Keep working".into(), Some(60_000.0)).await.expect("create active");
    runtime.settle_turn("s-active", serde_json::json!({ "status": "completed", "toolCalls": 1 })).await.expect("settle active turn");
    assert_eq!(runtime.slots_held(), 1);
    runtime.release_unloaded("s-active");
    assert_eq!(runtime.slots_held(), 1, "active timers keep the slot alive until finished or deleted");
    runtime.forget_session("s-active");
    assert_eq!(runtime.slots_held(), 0, "deleting a session releases its slot and stops timers");

    runtime.close().await;
}

#[tokio::test]
async fn forgotten_session_tombstone_prevents_timer_rearm_and_slot_resurrection() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::runtime::{GoalTimers, Timer, TimerKind};

    struct CountTimers {
        live: Arc<AtomicUsize>,
    }
    impl GoalTimers for CountTimers {
        fn after(&self, _kind: TimerKind, _delay_ms: f64, _cb: Box<dyn FnOnce() + Send>) -> Timer {
            self.live.fetch_add(1, Ordering::SeqCst);
            let live = self.live.clone();
            Timer::new(move || {
                live.fetch_sub(1, Ordering::SeqCst);
            })
        }
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let live_timers = Arc::new(AtomicUsize::new(0));
    let mut env = GoalEnv::system(mixdog_rt::testing::tokens().durability_io);
    env.timers = Arc::new(CountTimers { live: live_timers.clone() });
    let runtime = GoalRuntime::new(GoalConfig::new(dir.path().to_string_lossy().into_owned()), env);

    let created = runtime.tool_create("s-del", "Ship it".into(), Some(60_000.0)).await.expect("create").expect("goal");
    let slot = runtime.inner.existing_slot("s-del").expect("slot exists");
    assert!(live_timers.load(Ordering::SeqCst) > 0, "active goal armed timers");

    runtime.forget_session("s-del");
    assert_eq!(runtime.slots_held(), 0);
    assert_eq!(live_timers.load(Ordering::SeqCst), 0, "forget_session cancelled all timers");

    // Simulate an in-flight commit calling arm_deadline / schedule_title / limit_if_expired on the forgotten slot.
    runtime.inner.arm_deadline(&slot, "s-del", Some(created.clone()));
    runtime.inner.schedule_title(&slot, "s-del", &created);
    let _ = runtime.inner.limit_if_expired_with(&slot, "s-del", Some(created));
    runtime.settled().await;

    assert_eq!(live_timers.load(Ordering::SeqCst), 0, "no timer re-arms on a tombstoned slot");
    assert_eq!(runtime.slots_held(), 0, "no late background task resurrects a deleted slot");
    runtime.close().await;
}

#[tokio::test]
async fn unloaded_expired_goal_probes_deduplicate_and_release_ephemeral_slot() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::js::put_num;
    use super::runtime::{GoalClock, GoalTimers, Timer, TimerKind};

    struct ManualClock(AtomicU64);
    impl GoalClock for ManualClock {
        fn now(&self) -> f64 {
            self.0.load(Ordering::SeqCst) as f64
        }
        fn monotonic(&self) -> Option<f64> {
            None
        }
    }

    struct NoopTimers;
    impl GoalTimers for NoopTimers {
        fn after(&self, _kind: TimerKind, _delay_ms: f64, _cb: Box<dyn FnOnce() + Send>) -> Timer {
            Timer::new(|| {})
        }
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let clock = Arc::new(ManualClock(AtomicU64::new(1_000_000)));
    let mut env = GoalEnv::system(mixdog_rt::testing::tokens().durability_io);
    env.clock = clock.clone();
    env.timers = Arc::new(NoopTimers);
    let runtime = GoalRuntime::new(GoalConfig::new(dir.path().to_string_lossy().into_owned()), env);

    runtime.tool_create("s-exp", "Expire me".into(), Some(60_000.0)).await.expect("create");
    // Stamp live heartbeat past the 60s cap (as if the runtime ran to the deadline and exited before committing expiry).
    clock.0.store(1_070_000, Ordering::SeqCst);
    runtime
        .inner
        .with_mutation("s-exp", |tx| {
            let mut goal = tx.require_goal()?;
            put_num(&mut goal, "liveAt", 1_070_000.0);
            tx.stamp_live(&goal)
        })
        .await
        .expect("stamp live");
    // Drop the slot as if the runtime restarted or session unloaded before expiry.
    runtime.forget_session("s-exp");
    assert_eq!(runtime.slots_held(), 0);

    // Advance wall clock further; reload keeps the observed 70s live span past the 60s cap.
    clock.0.store(1_080_000, Ordering::SeqCst);

    let (a, b) = tokio::join!(runtime.snapshot("s-exp"), runtime.snapshot("s-exp"));
    assert_eq!(a.expect("a").expect("goal").get("status").and_then(|v| v.as_str()), Some("duration_reached"));
    assert_eq!(b.expect("b").expect("goal").get("status").and_then(|v| v.as_str()), Some("duration_reached"));

    runtime.settled().await;
    assert_eq!(runtime.slots_held(), 0, "ephemeral expiry slot is released once settled");

    let stored = runtime.read_stored_snapshot("s-exp").await.expect("stored").expect("goal");
    assert_eq!(stored.get("status").and_then(|v| v.as_str()), Some("duration_reached"));
    runtime.close().await;
}
