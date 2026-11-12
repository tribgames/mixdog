//! A wedged lane no longer stalls its callers forever (F1, F26). Own test binary: it wedges a
//! lane of the process-wide executors. Time never passes: leases are expired by
//! `Executors::sweep_leases` with a future `now`, and every wait is on a signal.

use std::future::Future;
use std::pin::pin;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::JobDropped;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneWedged;
use mixdog_rt::SubmitWaitError;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;

/// Waits on `fut` itself, within a deadline: a caller still stalled on the wedged lane fails the
/// test.
fn bounded(rt: &tokio::runtime::Handle, fut: impl Future<Output = ()>) {
    rt.block_on(async { mixdog_rt::time::timeout(WAIT, fut).await.expect("every caller of the lane is answered") });
}

/// Polls `fut` once.
async fn poll_once<F: Future + Unpin>(fut: &mut F) -> std::task::Poll<F::Output> {
    std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *fut).poll(cx))).await
}

/// Longer than the longest lease of any pooled lane (cpu-bulk: 10 minutes).
const PAST_ANY_LEASE: Duration = Duration::from_secs(601);

/// The deadline of every wait in this test.
const WAIT: Duration = Duration::from_secs(60);

#[test]
fn a_wedged_lane_resolves_every_caller_instead_of_stalling_them() {
    let mut config = RtConfig::for_cores(8);
    config.cpu_bulk = PoolParams::fixed(1, 2, 3);
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("boot");
    let rt = executors.handle(TaskClass::Work);
    let lane = tokens.cpu_bulk;
    let never = CancellationToken::new();
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let started = || started_rx.recv_timeout(WAIT).expect("the stuck job starts on the lane");

    // Job A, submitted the way `quota_resume` does (`submit`, then await the handle), takes the
    // only worker and is stuck until released.
    let (release_a, a_gate) = mpsc::channel::<()>();
    let a_started = started_tx.clone();
    let a = lane
        .submit(&never, move |_| {
            a_started.send(()).unwrap();
            let _ = a_gate.recv_timeout(WAIT);
            11
        })
        .unwrap();
    started();
    let q1 = lane.submit(&never, |_| 1).unwrap();
    let q2 = lane.submit(&never, |_| 2).unwrap();
    // A `submit_wait` caller with a token nobody cancels, parked behind the queue's room (polled
    // once here, so it holds its place); with it the queue holds its far bound.
    let parked_token = CancellationToken::new();
    let mut parked = Box::pin(lane.submit_wait(&parked_token, |_| 4));
    assert!(rt.block_on(poll_once(&mut parked)).is_pending(), "the caller waits behind the room");
    assert_eq!(
        executors.diagnostics().lanes.iter().find(|l| l.kind == LaneKind::CpuBulk).unwrap().waiters,
        1
    );
    assert_eq!(
        lane.submit(&never, |_| 3).err(),
        Some(LaneFull {
            lane: LaneKind::CpuBulk
        })
    );

    // Lease expiry: a replacement worker serves the queue and the parked caller gets through.
    // A is not abandoned: it is still running and its handle stays unresolved.
    executors.sweep_leases(Instant::now() + PAST_ANY_LEASE);
    bounded(&rt, Box::pin(async move {
        assert_eq!(q1.await, Ok(1));
        assert_eq!(q2.await, Ok(2));
        assert_eq!(parked.await.expect("the parked caller is admitted").await, Ok(4));
    }));

    // The replacement wedges as well: job B, then a queue holding its room, then a parked caller.
    let (release_b, b_gate) = mpsc::channel::<()>();
    let b_started = started_tx.clone();
    let b = rt
        .block_on(lane.submit_wait(&never, move |_| {
            b_started.send(()).unwrap();
            let _ = b_gate.recv_timeout(WAIT);
            12
        }))
        .unwrap();
    started();
    let c1 = lane.submit(&never, |_| 5).unwrap();
    let c2 = lane.submit(&never, |_| 6).unwrap();
    let parked_token = CancellationToken::new();
    let mut parked = Box::pin(lane.submit_wait(&parked_token, |_| 7));
    assert!(rt.block_on(poll_once(&mut parked)).is_pending(), "the caller waits behind the room");

    // No healthy worker is left: queued jobs (which never ran) are dropped, the parked caller
    // and every new caller are answered `Wedged` at once. B, running, is not dropped.
    executors.sweep_leases(Instant::now() + PAST_ANY_LEASE);
    let wedged = SubmitWaitError::Wedged(LaneWedged {
        lane: LaneKind::CpuBulk,
    });
    let after = rt.spawn(async move { lane.submit_wait(&CancellationToken::new(), |_| 8).await.err() });
    bounded(&rt, Box::pin(async move {
        assert_eq!(c1.await, Err(JobDropped::Dropped));
        assert_eq!(c2.await, Err(JobDropped::Dropped));
        assert_eq!(parked.await.err(), Some(wedged));
        assert_eq!(after.await.unwrap(), Some(wedged));
    }));
    assert!(executors.lane_wedged(LaneKind::CpuBulk));
    assert_eq!(
        lane.submit(&never, |_| 9).err(),
        Some(LaneFull {
            lane: LaneKind::CpuBulk
        })
    );
    assert_eq!(
        executors
            .diagnostics()
            .lanes
            .iter()
            .find(|l| l.kind == LaneKind::CpuBulk)
            .unwrap()
            .wedged,
        2
    );

    // The stuck jobs return late: their callers get the real results (the writes they stood
    // for happened, and nobody was told otherwise), and the lane recovers and serves again.
    drop(release_a);
    drop(release_b);
    bounded(&rt, Box::pin(async move {
        assert_eq!(a.await, Ok(11));
        assert_eq!(b.await, Ok(12));
    }));
    let freed = executors.capacity_notify(LaneKind::CpuBulk).unwrap();
    bounded(&rt, Box::pin({
        let executors = executors.clone();
        async move {
            loop {
                let notified = freed.notified();
                let mut notified = pin!(notified);
                // Registered before the check, so a recovery in between is not missed.
                notified.as_mut().enable();
                if !executors.lane_wedged(LaneKind::CpuBulk) {
                    break;
                }
                notified.await;
            }
        }
    }));
    let served = rt.block_on(async {
        lane.submit_wait(&CancellationToken::new(), |_| 10)
            .await
            .unwrap()
            .await
    });
    assert_eq!(served, Ok(10));
}
