use std::sync::Arc;
use std::time::Duration;

use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionError;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::admission::Outcome;
use mixdog_ai::admission::Priority;
use mixdog_ai::admission::RunLiveness;
use tokio_util::sync::CancellationToken;

fn key(provider: &str, account: &str) -> LaneKey {
    LaneKey::new(provider.into(), account)
}

fn req(owner: &str, priority: Priority) -> AdmissionRequest {
    AdmissionRequest {
        owner: Arc::from(owner),
        priority,
        on_cooldown_wait: None,
        liveness: None,
    }
}

fn limited(n: usize) -> LaneSettings {
    LaneSettings {
        concurrency: Some(n),
        ..LaneSettings::default()
    }
}

#[tokio::test]
async fn unbounded_lane_never_queues() {
    mixdog_rt::testing::tokens();
    let admission = Admission::new();
    let lane = admission.lane(&key("p", "a"), LaneSettings::default());
    let cancel = CancellationToken::new();
    let mut permits = Vec::new();
    for _ in 0..100 {
        permits.push(admission.acquire(&lane, req("s", Priority::default()), &cancel).await.unwrap());
    }
    assert_eq!(permits[99].metrics().queued, 0);
}

#[tokio::test]
async fn waiters_go_by_priority_then_round_robin_by_owner() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&key("p", "a"), limited(1));
    let cancel = CancellationToken::new();
    let first = admission.acquire(&lane, req("x", Priority::UserVisible), &cancel).await.unwrap();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut tasks = Vec::new();
    // Queue in this order; each task holds until released by finishing.
    for (owner, priority) in [
        ("a", Priority::BestEffort),
        ("a", Priority::UserVisible),
        ("a", Priority::UserVisible),
        ("b", Priority::UserVisible),
        ("c", Priority::UserBlocking),
    ] {
        let (admission, lane, cancel, order) =
            (admission.clone(), lane.clone(), cancel.clone(), order.clone());
        let label = format!("{owner}{priority:?}");
        tasks.push(tokio::spawn(async move {
            let permit = admission.acquire(&lane, req(owner, priority), &cancel).await.unwrap();
            order.lock().unwrap().push(label);
            permit.finish(Outcome::Success);
        }));
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    first.finish(Outcome::Success);
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(
        *order.lock().unwrap(),
        ["cUserBlocking", "aUserVisible", "bUserVisible", "aUserVisible", "aBestEffort"]
    );
}

#[tokio::test]
async fn queue_bound_and_cancellation() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(
        &key("p", "a"),
        LaneSettings {
            concurrency: Some(1),
            max_queue: 1,
            adaptive: false,
            unattended_lease: None,
        },
    );
    let cancel = CancellationToken::new();
    let held = admission.acquire(&lane, req("x", Priority::default()), &cancel).await.unwrap();
    let waiting_cancel = CancellationToken::new();
    let waiter = {
        let (admission, lane, c) = (admission.clone(), lane.clone(), waiting_cancel.clone());
        tokio::spawn(async move { admission.acquire(&lane, req("y", Priority::default()), &c).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(
        admission.acquire(&lane, req("z", Priority::default()), &cancel).await,
        Err(AdmissionError::QueueFull { .. })
    ));
    waiting_cancel.cancel();
    assert_eq!(waiter.await.unwrap(), Err(AdmissionError::Cancelled));
    assert_eq!(admission.snapshot()[0].queued, 0, "the cancelled waiter left");
    held.finish(Outcome::Abandoned);
    admission.acquire(&lane, req("w", Priority::default()), &cancel).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn adaptive_lane_halves_cools_down_and_recovers() {
    mixdog_rt::testing::tokens();
    let admission = Admission::new();
    let lane = admission.lane(
        &key("anthropic", "a"),
        LaneSettings {
            concurrency: Some(4),
            adaptive: true,
            ..LaneSettings::default()
        },
    );
    let cancel = CancellationToken::new();
    let permit = admission.acquire(&lane, req("s", Priority::default()), &cancel).await.unwrap();
    permit.finish(Outcome::Failure {
        status: Some(429),
        retry_after: Some(Duration::from_secs(10)),
    });
    let snap = &admission.snapshot()[0];
    assert_eq!(snap.limit, Some(2));
    assert_eq!(snap.cooldown, Duration::from_secs(10));
    assert_eq!(
        admission.immediate_block(&lane),
        Some(mixdog_ai::admission::Block::Cooldown)
    );
    // A request parks until the cooldown ends.
    let started = tokio::time::Instant::now();
    let p = admission.acquire(&lane, req("s", Priority::default()), &cancel).await.unwrap();
    assert!(started.elapsed() >= Duration::from_secs(10));
    p.finish(Outcome::Success);
    // limit 2: two successes add a slot -> 3; then 3 more -> 4 = configured.
    for _ in 0..4 {
        let p = admission.acquire(&lane, req("s", Priority::default()), &cancel).await.unwrap();
        p.finish(Outcome::Success);
    }
    assert!(admission.snapshot()[0].limit.is_none_or(|l| l >= 3));
    // Advice beyond the coordination cap is not recorded.
    assert!(!admission.record_rate_limit(&lane, Some(Duration::from_secs(61))));
    assert_eq!(admission.reset_cooldowns(None), 1);
    assert_eq!(admission.snapshot()[0].limit, Some(4));
}
const LEASE: Duration = Duration::from_secs(60);

fn leased(n: usize) -> LaneSettings {
    LaneSettings {
        concurrency: Some(n),
        unattended_lease: Some(LEASE),
        ..LaneSettings::default()
    }
}

fn run_req(run: &Arc<RunLiveness>) -> AdmissionRequest {
    AdmissionRequest {
        liveness: Some(run.clone()),
        ..req("run", Priority::default())
    }
}

/// Moves paused time forward one second at a time, letting every task it woke
/// run, so an event due mid-way sees the time it was due.
async fn settle(total: Duration) {
    let mut left = total;
    loop {
        let step = left.min(Duration::from_secs(1));
        tokio::time::advance(step).await;
        left -= step;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        if left.is_zero() {
            break;
        }
    }
}

fn active(admission: &Admission) -> usize {
    admission.snapshot()[0].active
}

#[tokio::test(start_paused = true)]
async fn an_unattended_silent_run_returns_its_permit_after_the_lease() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&key("p", "a"), leased(1));
    let abort = CancellationToken::new();
    let run = RunLiveness::new(false);
    let permit = admission.acquire(&lane, run_req(&run), &abort).await.unwrap();
    let other = {
        let (admission, lane) = (admission.clone(), lane.clone());
        tokio::spawn(async move {
            admission
                .acquire(&lane, req("other", Priority::default()), &CancellationToken::new())
                .await
        })
    };
    settle(LEASE - Duration::from_secs(1)).await;
    assert!(!other.is_finished(), "the lease has not run out");
    assert_eq!((active(&admission), admission.snapshot()[0].queued), (1, 1));
    settle(Duration::from_secs(1)).await;
    let other = other.await.unwrap().unwrap();
    assert!(!abort.is_cancelled(), "the run is not ended, only its slot returned");
    assert_eq!(active(&admission), 1, "the other session holds the one slot");
    // The silent run's own end gives nothing back a second time.
    permit.finish(Outcome::Abandoned);
    assert_eq!(active(&admission), 1);
    drop(other);
    assert_eq!(active(&admission), 0);
}

#[tokio::test(start_paused = true)]
async fn an_attended_silent_run_keeps_its_permit_until_it_is_unattended() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&key("p", "a"), leased(1));
    let run = RunLiveness::new(true);
    let permit = admission.acquire(&lane, run_req(&run), &CancellationToken::new()).await.unwrap();
    let other = {
        let (admission, lane) = (admission.clone(), lane.clone());
        tokio::spawn(async move {
            admission
                .acquire(&lane, req("other", Priority::default()), &CancellationToken::new())
                .await
        })
    };
    settle(LEASE * 10).await;
    assert!(!other.is_finished(), "no content timer for an attended run");
    assert_eq!(active(&admission), 1);
    // The viewer goes away after a long silence: the lease is already spent.
    run.set_attended(false);
    drop(other.await.unwrap().unwrap());
    drop(permit);
    assert_eq!(active(&admission), 0);
}

#[tokio::test(start_paused = true)]
async fn progress_moves_the_lease() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&key("p", "a"), leased(1));
    let run = RunLiveness::new(false);
    let _permit = admission.acquire(&lane, run_req(&run), &CancellationToken::new()).await.unwrap();
    settle(Duration::from_secs(40)).await;
    run.progress();
    settle(Duration::from_secs(59)).await;
    assert_eq!(active(&admission), 1, "99 s in, 59 s after the progress");
    settle(Duration::from_secs(1)).await;
    assert_eq!(active(&admission), 0, "60 s after the progress");
}

#[tokio::test(start_paused = true)]
async fn a_run_without_a_progress_fact_keeps_its_permit() {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&key("p", "a"), leased(1));
    let _permit = admission
        .acquire(&lane, req("run", Priority::default()), &CancellationToken::new())
        .await
        .unwrap();
    settle(LEASE * 10).await;
    assert_eq!(active(&admission), 1);
}