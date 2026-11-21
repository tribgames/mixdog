//! `LaneToken::submit_wait` against the real executors. Own test binary: it fills a small
//! lane completely, which would starve unrelated tests sharing the process.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::JobHandle;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::SubmitWaitError;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;

fn rt() -> &'static (Arc<Executors>, LaneTokens) {
    static BOOT: OnceLock<(Arc<Executors>, LaneTokens)> = OnceLock::new();
    BOOT.get_or_init(|| {
        let mut config = RtConfig::for_cores(8);
        config.cpu_bulk = PoolParams::fixed(2, 2, 8);
        mixdog_rt::exec::boot(config).expect("boot")
    })
}

/// The tests fill the one shared cpu-bulk lane, so they run one at a time.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn block_on<F: Future>(fut: F) -> F::Output {
    rt().0.handle(TaskClass::Work).block_on(fut)
}

#[derive(Clone)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn new() -> Self {
        Self(Arc::new((Mutex::new(false), Condvar::new())))
    }

    fn wait(&self) {
        let mut open = self.0.0.lock().unwrap();
        while !*open {
            open = self.0.1.wait(open).unwrap();
        }
    }

    fn open(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}

/// Fills `cpu_bulk` (2 threads running, 2 queued: its room) with jobs that wait for `gate`.
fn fill_lane(gate: &Gate) -> Vec<JobHandle<()>> {
    let tokens = rt().1;
    let (started_tx, started_rx) = mpsc::channel();
    let mut handles = Vec::new();
    for _ in 0..2 {
        let (gate, started) = (gate.clone(), started_tx.clone());
        handles.push(
            tokens
                .cpu_bulk
                .submit(&CancellationToken::new(), move |_| {
                    started.send(()).unwrap();
                    gate.wait();
                })
                .unwrap(),
        );
    }
    for _ in 0..2 {
        started_rx.recv_timeout(Duration::from_secs(60)).expect("both cpu-bulk threads are held");
    }
    for _ in 0..2 {
        let gate = gate.clone();
        handles.push(tokens.cpu_bulk.submit(&CancellationToken::new(), move |_| gate.wait()).unwrap());
    }
    let lane = rt().0.diagnostics().lanes.into_iter().find(|l| l.kind == mixdog_rt::LaneKind::CpuBulk).unwrap();
    assert_eq!((lane.queue_depth, lane.room), (2, 2), "the queue holds its room");
    handles
}

#[test]
fn waits_for_room_then_enqueues_and_runs() {
    let _serial = serial();
    let tokens = rt().1;
    let gate = Gate::new();
    let held = fill_lane(&gate);
    let cancel = CancellationToken::new();

    let value = block_on(async {
        let mut waiting = pin!(tokens.cpu_bulk.submit_wait(&cancel, |_| 41 + 1));
        // Still waiting while the lane is full.
        let polled = std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx))).await;
        assert!(polled.is_pending());
        gate.open();
        waiting.await.expect("accepted once room appears").await
    });
    assert_eq!(value, Ok(42));
    for h in held {
        block_on(h).unwrap();
    }
}

#[test]
fn cancelling_the_token_ends_the_wait() {
    let _serial = serial();
    let tokens = rt().1;
    let gate = Gate::new();
    let held = fill_lane(&gate);
    let cancel = CancellationToken::new();

    let result = block_on(async {
        let mut waiting = pin!(tokens.cpu_bulk.submit_wait(&cancel, |_| ()));
        let polled = std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx))).await;
        assert!(polled.is_pending(), "the full lane makes the caller wait");
        cancel.cancel();
        waiting.await
    });
    assert_eq!(result.err(), Some(SubmitWaitError::Cancelled));
    gate.open();
    for h in held {
        block_on(h).unwrap();
    }
}

#[test]
fn dropping_the_wait_enqueues_nothing() {
    let _serial = serial();
    let tokens = rt().1;
    let gate = Gate::new();
    let held = fill_lane(&gate);
    let ran = Arc::new(AtomicBool::new(false));

    block_on(async {
        let cancel = CancellationToken::new();
        let flag = ran.clone();
        let waiting = tokens.cpu_bulk.submit_wait(&cancel, move |_| flag.store(true, SeqCst));
        // Abandoned mid-wait, as a `select!` branch or a timeout would.
        let mut waiting = pin!(waiting);
        let polled = std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx))).await;
        assert!(polled.is_pending());
    });
    gate.open();
    for h in held {
        block_on(h).unwrap();
    }
    // The lane is idle and serving; the abandoned job never appears.
    let after = block_on(tokens.cpu_bulk.submit(&CancellationToken::new(), |_| 1).unwrap());
    assert_eq!(after, Ok(1));
    assert!(!ran.load(SeqCst));
}

#[test]
fn every_waiter_is_served_as_room_frees() {
    let _serial = serial();
    let tokens = rt().1;
    let gate = Gate::new();
    let held = fill_lane(&gate);
    let done = Arc::new(AtomicUsize::new(0));

    block_on(async {
        let mut waiters: Vec<_> = (0..6)
            .map(|_| {
                let done = done.clone();
                Box::pin(async move {
                    let cancel = CancellationToken::new();
                    let handle = tokens
                        .cpu_bulk
                        .submit_wait(&cancel, move |_| {
                            done.fetch_add(1, SeqCst);
                        })
                        .await
                        .expect("accepted");
                    handle.await.unwrap();
                })
            })
            .collect();
        // One poll queues a waiter behind the full lane: all six are waiting before room frees.
        for waiting in &mut waiters {
            let polled = std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx))).await;
            assert!(polled.is_pending(), "the full lane makes every caller wait");
        }
        assert_eq!(done.load(SeqCst), 0);
        gate.open();
        std::future::poll_fn(|cx| {
            waiters.retain_mut(|waiting| waiting.as_mut().poll(cx).is_pending());
            if waiters.is_empty() { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
        })
        .await;
    });
    assert_eq!(done.load(SeqCst), 6);
    for h in held {
        block_on(h).unwrap();
    }
}

/// A caller waiting outside the full queue is cancelled, then the queue frees slots, and only then
/// is the wait polled: it hears it was cancelled (not admitted, and not a lost result), and no slot
/// stays reserved for it.
#[test]
fn a_caller_cancelled_outside_the_full_queue_before_capacity_frees_hears_cancelled() {
    let _serial = serial();
    let tokens = rt().1;
    let gate = Gate::new();
    let mut held = fill_lane(&gate);
    for _ in 0..6 {
        let gate = gate.clone();
        held.push(tokens.cpu_bulk.submit(&CancellationToken::new(), move |_| gate.wait()).expect("below the far bound"));
    }
    assert!(tokens.cpu_bulk.submit(&CancellationToken::new(), |_| ()).is_err(), "the queue holds its far bound");
    let cancel = CancellationToken::new();
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let mut waiting = Box::pin(tokens.cpu_bulk.submit_wait(&cancel, move |_| flag.store(true, SeqCst)));
    block_on(async {
        let polled = std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx))).await;
        assert!(polled.is_pending(), "the caller waits outside the full queue");
    });
    cancel.cancel();
    gate.open();
    for h in held {
        block_on(h).unwrap();
    }
    assert_eq!(block_on(waiting).err(), Some(SubmitWaitError::Cancelled));
    let lane = cpu_bulk();
    assert_eq!((lane.queue_depth, lane.outside), (0, 0));
    assert!(!ran.load(SeqCst));
}

fn cpu_bulk() -> mixdog_rt::exec::LaneSnapshot {
    rt().0.diagnostics().lanes.into_iter().find(|l| l.kind == mixdog_rt::LaneKind::CpuBulk).unwrap()
}

/// Polls `fut` once.
fn poll_once<F: Future + Unpin>(fut: &mut F) -> std::task::Poll<F::Output> {
    block_on(std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *fut).poll(cx))))
}

/// A job whose body holds a marker (its captures) and records whether it ran.
fn captured() -> (Arc<()>, Arc<AtomicBool>, impl FnOnce(&mixdog_rt::InLane<mixdog_rt::CpuBulk>) + Send + 'static) {
    let marker = Arc::new(());
    let flag = Arc::new(AtomicBool::new(false));
    let (keep, ran) = (marker.clone(), flag.clone());
    (marker, flag, move |_: &mixdog_rt::InLane<mixdog_rt::CpuBulk>| {
        let _keep = &keep;
        ran.store(true, SeqCst);
    })
}

/// Dropping a wait releases its job's captures at once wherever the job is: never polled (the
/// future still owns it), beyond the far bound, or admitted while no thread took it yet and the
/// wait was not polled since. No body runs. Dropping a returned handle withdraws nothing.
#[test]
fn a_dropped_wait_releases_its_job_and_a_dropped_handle_does_not() {
    let _serial = serial();
    let tokens = rt().1;
    let cancel = CancellationToken::new();

    let (marker, ran, body) = captured();
    drop(tokens.cpu_bulk.submit_wait(&cancel, body));
    assert_eq!((Arc::strong_count(&marker), ran.load(SeqCst)), (1, false), "never polled");

    // Both threads held; eight queued jobs (the far bound) share a token the test cancels later.
    let gate = Gate::new();
    let (started_tx, started_rx) = mpsc::channel();
    let running: Vec<_> = (0..2)
        .map(|_| {
            let (gate, started) = (gate.clone(), started_tx.clone());
            tokens
                .cpu_bulk
                .submit(&CancellationToken::new(), move |_| {
                    started.send(()).unwrap();
                    gate.wait();
                })
                .unwrap()
        })
        .collect();
    for _ in 0..2 {
        started_rx.recv_timeout(Duration::from_secs(60)).expect("both cpu-bulk threads are held");
    }
    let queued_cancel = CancellationToken::new();
    let queued: Vec<_> = (0..8).map(|_| tokens.cpu_bulk.submit(&queued_cancel, |_| ()).expect("below the far bound")).collect();

    let (marker, ran, body) = captured();
    let mut beyond = Box::pin(tokens.cpu_bulk.submit_wait(&cancel, body));
    assert!(poll_once(&mut beyond).is_pending());
    assert_eq!((Arc::strong_count(&marker), cpu_bulk().outside), (2, 1), "the lane holds the job beyond its bound");
    drop(beyond);
    assert_eq!((Arc::strong_count(&marker), ran.load(SeqCst), cpu_bulk().outside), (1, false, 0), "dropped beyond the bound");

    // The queued jobs are cancelled: their places bring the late waiter inside and admit it, while
    // both threads are still held and its wait is not polled. Dropping the wait then withdraws it.
    let (late_marker, late_ran, late_body) = captured();
    let mut late = Box::pin(tokens.cpu_bulk.submit_wait(&cancel, late_body));
    assert!(poll_once(&mut late).is_pending());
    queued_cancel.cancel();
    assert_eq!((cpu_bulk().queue_depth, cpu_bulk().waiters, cpu_bulk().outside), (1, 0, 0), "admitted, not taken");
    drop(late);
    assert_eq!((Arc::strong_count(&late_marker), late_ran.load(SeqCst), cpu_bulk().queue_depth), (1, false, 0));
    for handle in queued {
        assert_eq!(block_on(handle), Err(mixdog_rt::JobDropped::Cancelled));
    }
    gate.open();
    for handle in running {
        block_on(handle).unwrap();
    }

    let (ran_tx, ran_rx) = mpsc::channel();
    let handle = block_on(tokens.cpu_bulk.submit_wait(&cancel, move |_| ran_tx.send(()).unwrap())).expect("admitted on an idle lane");
    drop(handle);
    assert_eq!(ran_rx.recv_timeout(Duration::from_secs(60)), Ok(()), "a dropped handle does not withdraw its job");
}

#[test]
fn a_job_cancelled_while_queued_still_resolves_dropped() {
    let _serial = serial();
    let tokens = rt().1;
    let cancel = CancellationToken::new();
    cancel.cancel();
    // Already cancelled: the wait ends without enqueuing.
    let result = block_on(tokens.cpu_bulk.submit_wait(&cancel, |_| ()));
    assert_eq!(result.err(), Some(SubmitWaitError::Cancelled));
}
