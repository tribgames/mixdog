use std::sync::Arc;
use std::time::Duration;

use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionError;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::admission::Outcome;
use mixdog_ai::admission::Priority;
use tokio_util::sync::CancellationToken;

fn key(provider: &str, account: &str) -> LaneKey {
    LaneKey::new(provider.into(), account)
}

fn req(owner: &str, priority: Priority) -> AdmissionRequest {
    AdmissionRequest {
        owner: Arc::from(owner),
        priority,
        on_cooldown_wait: None,
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