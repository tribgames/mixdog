//! Elastic IO lanes and the waiting queue against the real executors: an IO lane grows past its
//! warm threads to its cap, a job past the cap waits in FIFO order, a cancelled waiter enqueues
//! nothing, the far bound refuses as overloaded, grown threads end when idle (on the injected
//! clock), and a CPU lane does not grow. Own test binary: it fills lanes completely. Every wait is
//! on a signal or a gate; nothing sleeps.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::task::Poll;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::JobHandle;
use mixdog_rt::LaneKind;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::SubmitWaitError;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::IDLE_GROWN;
use mixdog_rt::exec::LaneSnapshot;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;

const WAIT: Duration = Duration::from_secs(60);

fn rt() -> &'static (Arc<Executors>, LaneTokens) {
    static BOOT: OnceLock<(Arc<Executors>, LaneTokens)> = OnceLock::new();
    BOOT.get_or_init(|| {
        let mut config = RtConfig::for_cores(8);
        config.interactive_io = PoolParams { threads: 2, max_threads: 4, queue: 2 };
        config.cpu_interactive = PoolParams::fixed(2, 2);
        mixdog_rt::exec::boot(config).expect("boot")
    })
}

/// The tests fill the shared lanes, so they run one at a time.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn block_on<F: Future>(fut: F) -> F::Output {
    rt().0.handle(TaskClass::Work).block_on(fut)
}

fn snapshot(kind: LaneKind) -> LaneSnapshot {
    rt().0.diagnostics().lanes.into_iter().find(|lane| lane.kind == kind).unwrap()
}

fn never_runs() {
    panic!("a cancelled waiter's job never runs");
}

/// Polls `fut` once.
async fn poll_once<F: Future>(fut: &mut Pin<Box<F>>) -> Poll<F::Output> {
    std::future::poll_fn(|cx| Poll::Ready(fut.as_mut().poll(cx))).await
}

/// A job that reports `n` when a thread takes it, then holds the thread until released.
struct Held {
    started: mpsc::Receiver<usize>,
    started_tx: mpsc::Sender<usize>,
    releases: Vec<mpsc::Sender<()>>,
}

impl Held {
    fn new() -> Self {
        let (started_tx, started) = mpsc::channel();
        Self { started, started_tx, releases: Vec::new() }
    }

    /// The body of job `n`.
    fn job(&mut self, n: usize) -> impl FnOnce(&mixdog_rt::InLane<mixdog_rt::InteractiveIo>) + Send + 'static {
        let (release, held) = mpsc::channel::<()>();
        self.releases.push(release);
        let started = self.started_tx.clone();
        move |_| {
            started.send(n).unwrap();
            let _ = held.recv();
        }
    }

    fn submit(&mut self, n: usize) -> JobHandle<()> {
        let job = self.job(n);
        rt().1.interactive_io.submit(&CancellationToken::new(), job).expect("the lane takes the job")
    }

    fn started(&self) -> usize {
        self.started.recv_timeout(WAIT).expect("a held job starts")
    }

    fn release(&self, n: usize) {
        self.releases[n].send(()).unwrap();
    }
}

#[test]
fn an_io_lane_grows_to_its_cap_then_queues_serves_waiters_fifo_and_refuses_at_the_far_bound() {
    let _serial = serial();
    let tokens = rt().1;
    let mut held = Held::new();
    let mut handles = Vec::new();
    // The two warm threads, then two grown ones: every job starts while the lane is below its cap.
    for n in 0..4 {
        handles.push(held.submit(n));
        assert_eq!(held.started(), n);
    }
    let lane = snapshot(LaneKind::InteractiveIo);
    assert_eq!((lane.threads, lane.grown, lane.max_threads), (4, 2, 4));
    // At the cap: the next two wait in the queue (its far bound), and the next is refused as overloaded.
    handles.push(held.submit(4));
    handles.push(held.submit(5));
    assert_eq!(snapshot(LaneKind::InteractiveIo).queue_depth, 2);
    assert_eq!(snapshot(LaneKind::InteractiveIo).threads, 4, "no thread past the cap");
    let refused = tokens.interactive_io.submit(&CancellationToken::new(), |_| ()).err().expect("refused at the far bound");
    assert_eq!(refused.to_string(), "overloaded: io-interactive");

    block_on(async {
        // Three waiters, in this order, and one that is cancelled while it waits.
        let cancel = CancellationToken::new();
        let mut waiters = Vec::new();
        for n in 6..9 {
            waiters.push(Box::pin(tokens.interactive_io.submit_wait(&cancel, held.job(n))));
        }
        for waiter in &mut waiters {
            assert!(poll_once(waiter).await.is_pending());
        }
        let dropped = CancellationToken::new();
        let mut cancelled = Box::pin(tokens.interactive_io.submit_wait(&dropped, |_| never_runs()));
        assert!(poll_once(&mut cancelled).await.is_pending());
        assert_eq!(snapshot(LaneKind::InteractiveIo).waiters, 4);
        dropped.cancel();
        assert!(matches!(poll_once(&mut cancelled).await, Poll::Ready(Err(SubmitWaitError::Cancelled))));
        assert_eq!(snapshot(LaneKind::InteractiveIo).waiters, 3);
        assert_eq!(snapshot(LaneKind::InteractiveIo).queue_depth, 2, "the cancelled waiter queued nothing");

        // One thread frees: queued job 4 starts, its room goes to the oldest waiter only.
        for (released, first, rest) in [(0, 0, 1..3), (1, 1, 2..3), (2, 2, 3..3)] {
            held.release(released);
            assert_eq!(held.started(), released + 4);
            match poll_once(&mut waiters[first]).await {
                Poll::Ready(Ok(handle)) => handles.push(handle),
                _ => panic!("waiter {first} is served when room frees"),
            }
            for later in rest {
                assert!(poll_once(&mut waiters[later]).await.is_pending(), "waiter {later} still waits");
            }
        }
    });
    // The rest run in the order they were queued.
    for (release, starts) in [(3, 7), (4, 8), (5, 6)] {
        held.release(release);
        if starts != 6 {
            assert_eq!(held.started(), starts);
        }
    }
    for n in 6..9 {
        held.release(n);
    }
    for handle in handles {
        assert_eq!(block_on(handle), Ok(()));
    }
}

#[test]
fn idle_grown_threads_end_on_the_lane_clock_and_the_warm_ones_stay() {
    let _serial = serial();
    let mut held = Held::new();
    let handles: Vec<_> = (0..4)
        .map(|n| {
            let handle = held.submit(n);
            assert_eq!(held.started(), n);
            handle
        })
        .collect();
    assert_eq!(snapshot(LaneKind::InteractiveIo).grown, 2);
    for n in 0..4 {
        held.release(n);
    }
    for handle in handles {
        assert_eq!(block_on(handle), Ok(()));
    }
    // Idle, but not yet for the idle time: nothing ends.
    rt().0.sweep_leases(Instant::now());
    assert_eq!(snapshot(LaneKind::InteractiveIo).grown, 2);
    // Past the idle time on the lane's clock: the grown threads end, the warm two stay.
    let freed = rt().0.capacity_notify(LaneKind::InteractiveIo).unwrap();
    rt().0.sweep_leases(Instant::now() + IDLE_GROWN * 2);
    block_on(async {
        let ended = async {
            loop {
                let notified = freed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if snapshot(LaneKind::InteractiveIo).threads == 2 {
                    break;
                }
                notified.await;
            }
        };
        mixdog_rt::time::timeout(WAIT, ended).await.expect("the grown threads end");
    });
    let lane = snapshot(LaneKind::InteractiveIo);
    assert_eq!((lane.threads, lane.grown), (2, 0));
}

#[test]
fn a_cpu_lane_does_not_grow_its_jobs_wait_for_its_threads() {
    let _serial = serial();
    assert_eq!(RtConfig::for_cores(8).cpu_bulk.max_threads, RtConfig::for_cores(8).cpu_bulk.threads);
    assert_eq!(RtConfig::for_cores(8).cpu_interactive.max_threads, RtConfig::for_cores(8).cpu_interactive.threads);
    let tokens = rt().1;
    let (started_tx, started) = mpsc::channel();
    let mut releases = Vec::new();
    let mut handles = Vec::new();
    for n in 0..3 {
        // The first two start before the next is queued: the queue's room counts jobs no thread took yet.
        if n == 2 {
            started.recv_timeout(WAIT).unwrap();
            started.recv_timeout(WAIT).unwrap();
        }
        let (release, held) = mpsc::channel::<()>();
        releases.push(release);
        let started = started_tx.clone();
        handles.push(
            tokens
                .cpu_interactive
                .submit(&CancellationToken::new(), move |_| {
                    started.send(()).unwrap();
                    let _ = held.recv();
                })
                .unwrap(),
        );
    }
    let lane = snapshot(LaneKind::CpuInteractive);
    assert_eq!((lane.threads, lane.grown, lane.queue_depth), (2, 0, 1), "the third job waits for one of the two threads");
    drop(releases);
    started.recv_timeout(WAIT).unwrap();
    for handle in handles {
        assert_eq!(block_on(handle), Ok(()));
    }
}
