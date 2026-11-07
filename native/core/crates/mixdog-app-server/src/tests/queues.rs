//! Keyed serialization (P §7.1): ordering inside a key, independence between keys.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::CancellationToken;
use tokio::sync::Barrier;
use tokio::sync::Notify;
use tokio::sync::oneshot;

use super::settle;
use crate::serialization::Access;
use crate::serialization::KeyedQueues;
use crate::serialization::QueueKey;

fn global(name: &'static str) -> QueueKey {
    QueueKey::Global(name)
}

fn setup() -> KeyedQueues {
    mixdog_rt::testing::tokens();
    KeyedQueues::new()
}

type Log = Arc<Mutex<Vec<&'static str>>>;

fn push(log: &Log, entry: &'static str) {
    log.lock().unwrap().push(entry);
}

#[tokio::test]
async fn unrelated_keys_never_wait_for_each_other() {
    let queues = setup();
    let (release_a, wait_a) = oneshot::channel::<()>();
    let (done_b, finished_b) = oneshot::channel::<()>();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = wait_a.await;
        }),
    );
    queues.enqueue(
        global("b"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done_b.send(());
        }),
    );
    // `b` completes while `a` is still held.
    finished_b.await.unwrap();
    release_a.send(()).unwrap();
}

/// Blocks in `drop` until released: stands for any foreign code that runs while a queue is
/// cleaned up (the future of a request that never ran owns whatever its handler captured).
struct SlowDrop {
    dropping: Option<oneshot::Sender<()>>,
    release: std::sync::mpsc::Receiver<()>,
}

impl Drop for SlowDrop {
    fn drop(&mut self) {
        if let Some(dropping) = self.dropping.take() {
            let _ = dropping.send(());
        }
        let _ = self.release.recv();
    }
}

fn colliding() -> KeyedQueues {
    mixdog_rt::testing::tokens();
    // One shard: every key shares it with every other key.
    KeyedQueues::with_shards(1)
}

#[tokio::test]
async fn colliding_keys_do_not_wait_for_a_busy_key() {
    let queues = colliding();
    let (release_a, wait_a) = oneshot::channel::<()>();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = wait_a.await;
        }),
    );
    // A second request of the busy key waits behind it, as it should.
    let (done_a2, finished_a2) = oneshot::channel::<()>();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done_a2.send(());
        }),
    );
    let (done_b, finished_b) = oneshot::channel::<()>();
    queues.enqueue(
        global("b"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done_b.send(());
        }),
    );
    finished_b.await.unwrap();
    release_a.send(()).unwrap();
    finished_a2.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_cleanup_of_one_key_does_not_hold_up_a_key_in_the_same_shard() {
    let queues = colliding();
    let (release_a, wait_a) = oneshot::channel::<()>();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = wait_a.await;
        }),
    );
    // A queued request of a connection that has since closed, whose drop is slow.
    let (dropping_tx, dropping) = oneshot::channel::<()>();
    let (unblock, blocked) = std::sync::mpsc::channel::<()>();
    let guard = SlowDrop {
        dropping: Some(dropping_tx),
        release: blocked,
    };
    let closed = CancellationToken::new();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        closed.clone(),
        Box::pin(async move {
            let _guard = guard;
        }),
    );
    closed.cancel();
    // Finishing the running request makes `a` dequeue and drop the closed one, and that stalls.
    release_a.send(()).unwrap();
    dropping.await.unwrap();

    // Another key, in the same shard, still admits and completes at once. It is enqueued from a
    // blocking thread so that a held lock would show as a missed deadline, not a hung test.
    let (done_b, finished_b) = oneshot::channel::<()>();
    let other = queues.clone();
    let runtime = tokio::runtime::Handle::current();
    let enqueue_b = std::thread::spawn(move || {
        let _entered = runtime.enter();
        other.enqueue(
            global("b"),
            Access::Exclusive,
            CancellationToken::new(),
            Box::pin(async move {
                let _ = done_b.send(());
            }),
        );
    });
    let b_ran = tokio::time::timeout(std::time::Duration::from_secs(5), finished_b)
        .await
        .is_ok();
    unblock.send(()).unwrap();
    enqueue_b.join().unwrap();
    assert!(b_ran, "key b waited for the cleanup of key a");

    // And `a` carries on once its cleanup returns.
    let (done_a, finished_a) = oneshot::channel::<()>();
    queues.enqueue(
        global("a"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done_a.send(());
        }),
    );
    finished_a.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keys_that_keep_going_idle_lose_no_request_under_concurrent_enqueues() {
    const THREADS: usize = 8;
    const PER_THREAD: usize = 400;
    let queues = colliding();
    let (ran, mut receipts) = tokio::sync::mpsc::unbounded_channel::<()>();
    let runtime = tokio::runtime::Handle::current();
    for thread in 0..THREADS {
        let (queues, ran, runtime) = (queues.clone(), ran.clone(), runtime.clone());
        // Each producer's `ran` clone drops when it finishes, so the receipts end after the last.
        std::thread::spawn(move || {
            let _entered = runtime.enter();
            {
                for n in 0..PER_THREAD {
                    let ran = ran.clone();
                    // Three keys, so that each is idle between most requests.
                    let key = ["k0", "k1", "k2"][(thread + n) % 3];
                    queues.enqueue(
                        global(key),
                        Access::Exclusive,
                        CancellationToken::new(),
                        Box::pin(async move {
                            let _ = ran.send(());
                        }),
                    );
                }
            }
        });
    }
    drop(ran);
    let mut count = 0;
    let all = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while receipts.recv().await.is_some() {
            count += 1;
        }
    })
    .await;
    assert!(all.is_ok(), "only {count} of {} requests ran", THREADS * PER_THREAD);
    assert_eq!(count, THREADS * PER_THREAD);
}

#[tokio::test(start_paused = true)]
async fn exclusive_requests_of_one_key_run_in_arrival_order() {
    let queues = setup();
    let log: Log = Arc::default();
    let (release, wait) = oneshot::channel::<()>();
    let all_done = Arc::new(Notify::new());
    queues.enqueue(global("k"), Access::Exclusive, CancellationToken::new(), {
        let log = log.clone();
        Box::pin(async move {
            push(&log, "first start");
            let _ = wait.await;
            push(&log, "first end");
        })
    });
    for name in ["second", "third"] {
        let (log, all_done) = (log.clone(), all_done.clone());
        queues.enqueue(
            global("k"),
            Access::Exclusive,
            CancellationToken::new(),
            Box::pin(async move {
                push(&log, name);
                all_done.notify_one();
            }),
        );
    }
    settle().await;
    assert_eq!(*log.lock().unwrap(), ["first start"]);
    release.send(()).unwrap();
    // `notify_one` keeps a permit, so waiting after the jobs ran still returns; wait for the
    // last job by its log entry.
    while log.lock().unwrap().len() < 4 {
        all_done.notified().await;
    }
    assert_eq!(
        *log.lock().unwrap(),
        ["first start", "first end", "second", "third"]
    );
}

#[tokio::test]
async fn shared_reads_run_together_and_order_against_writes() {
    let queues = setup();
    let log: Log = Arc::default();
    // Two reads that can only finish if they run at the same time.
    let barrier = Arc::new(Barrier::new(2));
    for name in ["read 1", "read 2"] {
        let (barrier, log) = (barrier.clone(), log.clone());
        queues.enqueue(
            global("config"),
            Access::SharedRead,
            CancellationToken::new(),
            Box::pin(async move {
                barrier.wait().await;
                push(&log, name);
            }),
        );
    }
    let (done, finished) = oneshot::channel::<()>();
    {
        let log = log.clone();
        queues.enqueue(
            global("config"),
            Access::Exclusive,
            CancellationToken::new(),
            Box::pin(async move {
                push(&log, "write");
                let _ = done.send(());
            }),
        );
    }
    finished.await.unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[2], "write", "the write waited for both reads: {log:?}");
}

#[tokio::test]
async fn requests_of_a_closed_connection_are_dropped_unrun() {
    let queues = setup();
    let log: Log = Arc::default();
    let (release, wait) = oneshot::channel::<()>();
    queues.enqueue(
        global("k"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = wait.await;
        }),
    );
    let closed = CancellationToken::new();
    {
        let log = log.clone();
        queues.enqueue(
            global("k"),
            Access::Exclusive,
            closed.clone(),
            Box::pin(async move { push(&log, "closed connection's request") }),
        );
    }
    let (done, finished) = oneshot::channel::<()>();
    queues.enqueue(
        global("k"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done.send(());
        }),
    );
    closed.cancel();
    release.send(()).unwrap();
    finished.await.unwrap();
    assert!(log.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_panicking_request_frees_its_key() {
    let queues = setup();
    queues.enqueue(
        global("k"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async { panic!("handler bug") }),
    );
    let (done, finished) = oneshot::channel::<()>();
    queues.enqueue(
        global("k"),
        Access::Exclusive,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done.send(());
        }),
    );
    finished.await.unwrap();
}
