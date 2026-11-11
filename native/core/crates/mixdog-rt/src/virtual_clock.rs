//! A replay's clock (feature `virtual-clock`; no ordinary build has it). A core started with [`ENV`] naming a loopback address runs
//! RT-C and RT-W as `current_thread` runtimes whose tokio clocks the replay holds and moves: real time until the replay freezes it, then still until the replay advances it. Each
//! runtime keeps one blocking task parked for its whole life, which is what keeps tokio's paused clock from auto-advancing while the
//! core waits on I/O (`tokio::time::pause`, "Preventing auto-advance"). The wall clock ([`now_ms`]) moves with the timers: the instant
//! the clock froze plus what the replay advanced.
//!
//! The control is a line protocol over one TCP connection the core opens to [`ENV`]: the core says `hello <pid>`; the replay sends
//! `freeze` or `advance <ms>` and the core answers `now <wall ms>`. `advance` moves the clock one millisecond at a time, RT-C then RT-W at
//! each, and lets the tasks the step's timers woke run before the next step: timers fire in due order, those due at one millisecond on
//! one runtime in the order they were registered, and the answer comes only after every timer due by it has run. The wall clock reads
//! each timer's due instant when it fires.

use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use tokio::runtime::Builder;
use tokio::runtime::Handle;
use tokio::time::Instant;

/// The replay's control address (`127.0.0.1:<port>`).
pub const ENV: &str = "MIXDOG_VIRTUAL_CLOCK";

const RUNNING: i64 = i64::MIN;

struct State {
    /// Each runtime with its timer driver's tick 0.
    handles: Mutex<Vec<(Handle, Instant)>>,
    /// The wall instant the clock froze at, [`RUNNING`] before.
    frozen_at: AtomicI64,
    advanced: AtomicI64,
}

static STATE: OnceLock<State> = OnceLock::new();

fn state() -> &'static State {
    STATE.get_or_init(|| State { handles: Mutex::new(Vec::new()), frozen_at: AtomicI64::new(RUNNING), advanced: AtomicI64::new(0) })
}

/// Whether this process was started under a replay's clock.
pub fn requested() -> bool {
    std::env::var_os(ENV).is_some()
}

fn real_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The wall clock in milliseconds since the Unix epoch: `None` while no replay clock is frozen (the real clock is the reading).
pub fn now_ms() -> Option<i64> {
    let state = STATE.get()?;
    let frozen = state.frozen_at.load(SeqCst);
    (frozen != RUNNING).then(|| frozen + state.advanced.load(SeqCst))
}

/// A `current_thread` runtime driven by a thread of its own, its clock pausable and kept from auto-advancing.
pub(crate) fn runtime(name: &str, on_start: impl Fn() + Send + Sync + 'static) -> io::Result<Handle> {
    let runtime = Builder::new_current_thread().thread_name(name).enable_all().start_paused(true).on_thread_start(on_start).build()?;
    let handle = runtime.handle().clone();
    // The driver's tick 0 is the paused clock's reading at build: read it before the clock runs on real time until the replay freezes it.
    let start = runtime.block_on(async {
        let start = Instant::now();
        tokio::time::resume();
        start
    });
    std::thread::Builder::new().name(name.to_owned()).spawn(move || runtime.block_on(std::future::pending::<()>()))?;
    // Never returns: while it runs, a paused clock moves only by `advance` (tokio's blocking schedule inhibits auto-advance).
    handle.spawn_blocking(|| {
        loop {
            std::thread::park();
        }
    });
    state().handles.lock().unwrap_or_else(|p| p.into_inner()).push((handle.clone(), start));
    Ok(handle)
}

/// Runs one step on each runtime in turn, RT-C first, each to its end before the next.
fn on_each<F: std::future::Future<Output = ()> + Send + 'static>(make: impl Fn(Instant) -> F) {
    let handles = state().handles.lock().unwrap_or_else(|p| p.into_inner()).clone();
    for (handle, start) in handles {
        let (done, wait) = std::sync::mpsc::channel();
        let step = make(start);
        handle.spawn(async move {
            step.await;
            let _ = done.send(());
        });
        let _ = wait.recv();
    }
}

/// Connects to the replay and serves its commands on a thread of its own. Panics when [`ENV`] names no listening replay: a core started
/// under a replay's clock must not run on its own.
pub(crate) fn start_control() {
    let address = std::env::var(ENV).expect("virtual clock address");
    let mut stream = TcpStream::connect(&address).unwrap_or_else(|error| panic!("the replay's clock at {address}: {error}"));
    let _ = stream.set_nodelay(true);
    writeln!(stream, "hello {}", std::process::id()).expect("the replay's clock");
    let reader = BufReader::new(stream.try_clone().expect("the replay's clock"));
    std::thread::Builder::new()
        .name("mixdog-virtual-clock".to_owned())
        .spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let state = state();
                match line.split_whitespace().collect::<Vec<_>>().as_slice() {
                    ["freeze"] => {
                        // The wall instant first, so a timer that reads it inside the frozen clock reads the frozen instant.
                        state.frozen_at.store(real_ms(), SeqCst);
                        // A timer's deadline is rounded up to its driver's next whole millisecond: the frozen clock is moved onto one,
                        // so a timer armed while frozen fires after exactly its duration of advances.
                        on_each(|start| async move {
                            tokio::time::pause();
                            let part = (Instant::now() - start).as_nanos() % 1_000_000;
                            if part != 0 {
                                tokio::time::advance(Duration::from_nanos((1_000_000 - part) as u64)).await;
                            }
                        });
                    }
                    ["advance", ms] => {
                        let ms: u64 = ms.parse().expect("advance <ms>");
                        for _ in 0..ms {
                            state.advanced.fetch_add(1, SeqCst);
                            // `advance` fires the step's timers and yields once, behind the tasks they woke; the second yield lets what
                            // those tasks scheduled in turn run too.
                            on_each(|_| async {
                                tokio::time::advance(Duration::from_millis(1)).await;
                                tokio::task::yield_now().await;
                            });
                        }
                    }
                    other => panic!("the replay's clock sent {other:?}"),
                }
                if writeln!(stream, "now {}", now_ms().unwrap_or_else(real_ms)).is_err() {
                    break;
                }
            }
        })
        .expect("the virtual clock thread");
}
