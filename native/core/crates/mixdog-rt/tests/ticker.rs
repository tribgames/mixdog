//! The core ticker against the real executors.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::Backend;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::RtConfig;

fn rt() -> &'static Arc<Executors> {
    static BOOT: OnceLock<Arc<Executors>> = OnceLock::new();
    BOOT.get_or_init(|| mixdog_rt::exec::boot(RtConfig::for_cores(4)).unwrap().0)
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn fires_in_deadline_order_at_or_after_the_deadline() {
    rt();
    let ticker = mixdog_rt::ticker();
    let (tx, rx) = mpsc::channel();
    let start = Instant::now();
    // Registered out of order; the first registration is the latest.
    for (name, delay) in [("c", 90), ("a", 30), ("b", 60)] {
        let tx = tx.clone();
        let _ = ticker.register(start + ms(delay), move || {
            tx.send((name, start.elapsed())).unwrap();
        });
    }
    let got: Vec<_> = (0..3)
        .map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect();
    assert_eq!(got.iter().map(|g| g.0).collect::<Vec<_>>(), ["a", "b", "c"]);
    assert!(got[0].1 >= ms(30) && got[2].1 >= ms(90));
}

#[test]
fn an_earlier_deadline_preempts_a_pending_far_one() {
    rt();
    let ticker = mixdog_rt::ticker();
    let far = ticker.register(Instant::now() + Duration::from_secs(3600), || {});
    let (tx, rx) = mpsc::channel();
    let _ = ticker.register(Instant::now() + ms(20), move || tx.send(()).unwrap());
    rx.recv_timeout(Duration::from_secs(5)).expect("woken for the earlier deadline");
    assert!(far.cancel());
}

#[test]
fn cancel_prevents_the_callback_and_reports_it() {
    rt();
    let ticker = mixdog_rt::ticker();
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let handle = ticker.register(Instant::now() + ms(40), move || {
        h.fetch_add(1, SeqCst);
    });
    assert!(handle.cancel());
    // Nothing ever sends on this channel, so the timeout is a pure 150 ms wait.
    let (_keep, idle) = mpsc::channel::<()>();
    assert!(idle.recv_timeout(ms(150)).is_err());
    assert_eq!(hits.load(SeqCst), 0);

    // Cancelling after it fired reports false.
    let (tx, rx) = mpsc::channel();
    let fired = ticker.register(Instant::now(), move || tx.send(()).unwrap());
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!fired.cancel());
}

#[test]
fn a_dropped_handle_keeps_the_deadline_and_a_panic_does_not_stop_the_ticker() {
    rt();
    let ticker = mixdog_rt::ticker();
    let (tx, rx) = mpsc::channel();
    let _ = ticker.register(Instant::now() + ms(10), || panic!("callback panic"));
    let _ = ticker.register(Instant::now() + ms(30), move || tx.send(()).unwrap());
    rx.recv_timeout(Duration::from_secs(5)).expect("ticker survived the panic");
}

#[test]
fn wait_until_resolves_and_disarms_when_dropped() {
    let executors = rt();
    // Own ticker: the global one is shared with the parallel tests of this binary.
    let ticker = &mixdog_rt::Ticker::start();
    let before = ticker.pending();
    let handle = executors.handle(TaskClass::Work);
    handle.block_on(async {
        let started = Instant::now();
        ticker.wait_until(started + ms(30)).await;
        assert!(started.elapsed() >= ms(30));

        let abandoned = ticker.wait_until(Instant::now() + Duration::from_secs(3600));
        assert!(tokio::time::timeout(ms(20), abandoned).await.is_err());
    });
    assert_eq!(ticker.pending(), before, "the abandoned wait disarmed itself");
}

#[test]
fn many_deadlines_share_one_task() {
    rt();
    let ticker = mixdog_rt::ticker();
    let count = Arc::new(Mutex::new(0usize));
    let (tx, rx) = mpsc::channel();
    let at = Instant::now() + ms(50);
    for _ in 0..10_000 {
        let (count, tx) = (count.clone(), tx.clone());
        let _ = ticker.register(at, move || {
            let mut n = count.lock().unwrap();
            *n += 1;
            if *n == 10_000 {
                tx.send(()).unwrap();
            }
        });
    }
    rx.recv_timeout(Duration::from_secs(10)).expect("all fired");
    let diag = rt().diagnostics();
    let tasks = diag.tasks.iter().filter(|t| t.task == "core-ticker").count();
    assert_eq!(tasks, 1);
}
