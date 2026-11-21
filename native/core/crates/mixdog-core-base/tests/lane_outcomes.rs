//! What a job queued through `on_lane_wait` or `lane_job` hears when its token is cancelled and its lane loses its last
//! healthy worker, in either order. Own test binary: it wedges a lane of the process-wide executors. Leases are expired
//! by `Executors::sweep_leases` with a future `now`; deadlines only detect a hung test.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::CoreError;
use mixdog_core_base::support::lane_job;
use mixdog_core_base::support::on_lane_wait;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::CpuBulk;
use mixdog_rt::InLane;
use mixdog_rt::LaneKind;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;

/// Longer than the longest lease of any pooled lane (cpu-bulk: 10 minutes).
const PAST_ANY_LEASE: Duration = Duration::from_secs(601);

const WAIT: Duration = Duration::from_secs(60);

fn poll_once<F: Future + Unpin>(rt: &tokio::runtime::Handle, fut: &mut F) -> std::task::Poll<F::Output> {
    rt.block_on(std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *fut).poll(cx))))
}

fn incident(why: &str) -> CoreError {
    CoreError::Internal { incident_id: format!("{}-{why}", LaneKind::CpuBulk.name()).into() }
}

fn cancelled() -> CoreError {
    CoreError::Cancelled { by: "caller".into() }
}

/// Jobs admitted and jobs still waiting behind the room are each cancelled before or after the drain that the lane's
/// last healthy worker going makes: cancelled first hears cancelled, drained first hears the wedge, through both
/// helpers, each callback once, no body run. The drain is answered on a task with no cooperative budget left. A job
/// whose result is truly lost (it panicked) is the one that reads `job-dropped`.
#[test]
fn a_cancellation_and_a_wedge_drain_keep_the_cause_that_came_first_through_both_helpers() {
    let mut config = RtConfig::for_cores(8);
    config.cpu_bulk = PoolParams::fixed(1, 4, 6);
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("boot");
    let rt = executors.handle(TaskClass::Work);
    let lane = tokens.cpu_bulk;
    let never = CancellationToken::new();

    let lost = rt.block_on(on_lane_wait(lane, &never, |_| -> u8 { panic!("the job's result is lost") }));
    assert_eq!(lost.err(), Some(incident("job-dropped")));
    let (lost_tx, lost) = mpsc::channel();
    lane_job(lane, "lost", &never, |_| -> u8 { panic!("the job's result is lost") }, move |result| lost_tx.send(result).unwrap());
    assert_eq!(lost.recv_timeout(WAIT).unwrap().err(), Some(incident("job-dropped")));

    // The only worker is stuck, then its replacement: the next sweep leaves the lane no healthy worker.
    let (started_tx, started) = mpsc::channel::<()>();
    let hold = |release: mpsc::Receiver<()>| {
        let started = started_tx.clone();
        lane.submit(&never, move |_| {
            started.send(()).unwrap();
            let _ = release.recv_timeout(WAIT);
        })
        .unwrap()
    };
    let (release_a, a_gate) = mpsc::channel();
    let a = hold(a_gate);
    started.recv_timeout(WAIT).expect("the first stuck job starts");
    executors.sweep_leases(Instant::now() + PAST_ANY_LEASE);
    let (release_b, b_gate) = mpsc::channel();
    let b = hold(b_gate);
    started.recv_timeout(WAIT).expect("the replacement's stuck job starts");

    let ran = Arc::new(AtomicUsize::new(0));
    let body = |n: u8| {
        let ran = ran.clone();
        move |_: &InLane<CpuBulk>| {
            ran.fetch_add(1, SeqCst);
            n
        }
    };
    let cancels: Vec<CancellationToken> = (0..6).map(|_| CancellationToken::new()).collect();
    let told = || mpsc::channel::<Result<u8, CoreError>>();
    // Arrival order: x1, l1, x2, l2 are admitted (room 4); w1, w2 wait behind them inside the far bound.
    let mut x1 = Box::pin(on_lane_wait(lane, &cancels[0], body(1)));
    assert!(poll_once(&rt, &mut x1).is_pending());
    let (l1_tx, l1) = told();
    lane_job(lane, "l1", &cancels[1], body(2), move |result| l1_tx.send(result).unwrap());
    let mut x2 = Box::pin(on_lane_wait(lane, &cancels[2], body(3)));
    assert!(poll_once(&rt, &mut x2).is_pending());
    let (l2_tx, l2) = told();
    lane_job(lane, "l2", &cancels[3], body(4), move |result| l2_tx.send(result).unwrap());
    let mut w1 = Box::pin(on_lane_wait(lane, &cancels[4], body(5)));
    assert!(poll_once(&rt, &mut w1).is_pending());
    let (w2_tx, w2) = told();
    lane_job(lane, "w2", &cancels[5], body(6), move |result| w2_tx.send(result).unwrap());
    let lane_now = executors.diagnostics().lanes.into_iter().find(|l| l.kind == LaneKind::CpuBulk).unwrap();
    assert_eq!((lane_now.queue_depth, lane_now.waiters, lane_now.outside), (6, 2, 0));

    // Cancelled before the drain: x1 and l1 (admitted), w2 (waiting).
    for at in [0, 1, 5] {
        cancels[at].cancel();
    }
    let sweeper = executors.clone();
    let budget_left = rt
        .block_on(rt.spawn(async move {
            for _ in 0..1024 {
                if !tokio::task::coop::has_budget_remaining() {
                    break;
                }
                tokio::task::consume_budget().await;
            }
            sweeper.sweep_leases(Instant::now() + PAST_ANY_LEASE);
            tokio::task::coop::has_budget_remaining()
        }))
        .unwrap();
    assert!(!budget_left, "the drain was answered on a task with no cooperative budget left");
    // Cancelled after the drain: x2 and l2 (admitted), w1.
    for at in [2, 3, 4] {
        cancels[at].cancel();
    }

    assert_eq!(rt.block_on(x1).err(), Some(cancelled()));
    assert_eq!(rt.block_on(x2).err(), Some(incident("lane-wedged")));
    assert_eq!(rt.block_on(w1).err(), Some(incident("lane-wedged")));
    for (told, expected) in [(&l1, cancelled()), (&l2, incident("lane-wedged")), (&w2, cancelled())] {
        assert_eq!(told.recv_timeout(WAIT).unwrap().err(), Some(expected));
        assert!(told.try_recv().is_err(), "the callback is called once");
    }
    assert_eq!(ran.load(SeqCst), 0, "no body ran");

    drop((release_a, release_b));
    rt.block_on(async {
        assert_eq!(a.await, Ok(()));
        assert_eq!(b.await, Ok(()));
    });
}
