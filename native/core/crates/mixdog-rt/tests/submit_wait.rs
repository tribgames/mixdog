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
use mixdog_rt::LaneFull;
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
        config.cpu_bulk = PoolParams {
            threads: 2,
            queue: 2,
        };
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

/// Fills `cpu_bulk` (2 threads running, 2 queued) with jobs that wait for `gate`.
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
        started_rx.recv().unwrap();
    }
    for _ in 0..2 {
        let gate = gate.clone();
        handles.push(
            tokens
                .cpu_bulk
                .submit(&CancellationToken::new(), move |_| gate.wait())
                .unwrap(),
        );
    }
    assert_eq!(
        tokens
            .cpu_bulk
            .submit(&CancellationToken::new(), |_| ())
            .err(),
        Some(LaneFull {
            lane: mixdog_rt::LaneKind::CpuBulk
        })
    );
    handles
}

async fn settle() {
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
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
        let canceller = cancel.clone();
        tokio::spawn(async move {
            settle().await;
            canceller.cancel();
        });
        tokens.cpu_bulk.submit_wait(&cancel, |_| ()).await
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
        let waiting = tokens
            .cpu_bulk
            .submit_wait(&cancel, move |_| flag.store(true, SeqCst));
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
    let after = block_on(
        tokens
            .cpu_bulk
            .submit(&CancellationToken::new(), |_| 1)
            .unwrap(),
    );
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
        let waiters: Vec<_> = (0..6)
            .map(|_| {
                let done = done.clone();
                tokio::spawn(async move {
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
        settle().await;
        assert_eq!(done.load(SeqCst), 0);
        gate.open();
        for w in waiters {
            w.await.unwrap();
        }
    });
    assert_eq!(done.load(SeqCst), 6);
    for h in held {
        block_on(h).unwrap();
    }
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
