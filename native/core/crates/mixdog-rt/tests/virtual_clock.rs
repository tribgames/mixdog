//! The replay's clock as a replay drives it (feature `virtual-clock`): the core's executors started the way `mixdogd` starts them
//! (`exec::boot`), under [`virtual_clock::ENV`]; this test is the replay on the other end of the loopback control.
#![cfg(feature = "virtual-clock")]

use std::future::Future;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::task::Poll;
use std::time::Duration;

use mixdog_rt::TaskClass;
use mixdog_rt::exec::RtConfig;
use mixdog_rt::virtual_clock;

type Fired = Arc<Mutex<Vec<(&'static str, i64)>>>;

/// Arms a timer of `ms` on `class`'s runtime and returns once the timer is registered, so the next one armed is registered after it.
fn arm(fired: &Fired, name: &'static str, class: TaskClass, ms: u64) {
    let (armed, registered) = mpsc::channel();
    let fired = fired.clone();
    drop(mixdog_rt::spawn(name, class, async move {
        let sleep = tokio::time::sleep(Duration::from_millis(ms));
        tokio::pin!(sleep);
        // The first poll registers the timer with the runtime's driver.
        std::future::poll_fn(|cx| {
            let _ = sleep.as_mut().poll(cx);
            Poll::Ready(())
        })
        .await;
        armed.send(()).expect("the test waits for the timer");
        sleep.await;
        fired.lock().unwrap().push((name, virtual_clock::now_ms().expect("the clock is frozen")));
    }));
    registered.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| panic!("timer {name} was not registered within 10 s"));
}

#[test]
fn timers_fire_in_due_then_registration_order_and_advance_answers_after_them() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    // SAFETY: this binary's only test sets it before the executors start; nothing else reads the environment concurrently.
    unsafe { std::env::set_var(virtual_clock::ENV, listener.local_addr().expect("address").to_string()) };
    let (_executors, _tokens) = mixdog_rt::exec::boot(RtConfig::for_cores(4)).expect("the executors");
    let (stream, _) = listener.accept().expect("the core connects to the replay's clock");
    stream.set_read_timeout(Some(Duration::from_secs(30))).expect("a read deadline");
    let mut lines = BufReader::new(stream.try_clone().expect("stream")).lines();
    let mut control = stream;
    let hello = lines.next().expect("hello").expect("hello line");
    assert_eq!(hello, format!("hello {}", std::process::id()));
    let mut send = |command: &str| -> i64 {
        writeln!(control, "{command}").expect("the control");
        let line = lines.next().expect("an answer").unwrap_or_else(|e| panic!("no answer to {command} within 30 s: {e}"));
        line.strip_prefix("now ").and_then(|ms| ms.parse().ok()).unwrap_or_else(|| panic!("{command} answered {line:?}"))
    };

    let at = send("freeze");
    let fired: Fired = Arc::default();
    arm(&fired, "a", TaskClass::Work, 300);
    arm(&fired, "b", TaskClass::Work, 100);
    arm(&fired, "c", TaskClass::Control, 200);
    arm(&fired, "d", TaskClass::Work, 100);
    // The core's deadline service (std `Instant` deadlines) runs on the same clock.
    let ticked = fired.clone();
    let _keep = mixdog_rt::ticker().register(std::time::Instant::now() + Duration::from_millis(250), move || {
        ticked.lock().unwrap().push(("ticker", virtual_clock::now_ms().expect("the clock is frozen")));
    });
    let taken = |fired: &Fired| std::mem::take(&mut *fired.lock().unwrap());

    // Nothing is due before 100: the clock stands still until it is advanced.
    assert_eq!(send("advance 99"), at + 99);
    assert_eq!(taken(&fired), vec![]);
    // b and d are due at 100, b registered first; each reads its due instant on the wall clock.
    assert_eq!(send("advance 51"), at + 150);
    assert_eq!(taken(&fired), vec![("b", at + 100), ("d", at + 100)]);
    // e is armed at 150 and due at 300 with a, after a.
    arm(&fired, "e", TaskClass::Work, 150);
    assert_eq!(send("advance 100"), at + 250);
    assert_eq!(taken(&fired), vec![("c", at + 200), ("ticker", at + 250)]);
    assert_eq!(send("advance 50"), at + 300);
    assert_eq!(taken(&fired), vec![("a", at + 300), ("e", at + 300)]);
}
