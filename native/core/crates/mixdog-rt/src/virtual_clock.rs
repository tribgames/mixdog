//! A replay's clock (feature `virtual-clock`; `build.rs` fails any release-profile build with it).
//!
//! # Contract
//!
//! Start the core with `MIXDOG_VIRTUAL_CLOCK=<loopback ip:port>` and `MIXDOG_VIRTUAL_CLOCK_TOKEN=<token>`. It connects there, sends
//! `hello <pid>`, waits for `start <token> <wall-ms> <settle-ms>` and answers `now <wall-ms>`. Virtual time V starts at 0; the wall
//! clock reads wall-ms + V and moves only by `advance`.
//!
//! `advance <ms>` fires each queued timer due by V+ms, one at a time in (due, arming) order, V set to its due (timers armed meanwhile
//! join the queue). After each, and at V+ms, it waits until RT-C and RT-W are parked with empty queues and no lane job is queued or
//! running; then it answers `now <wall-ms>`. So everything those timers made runnable, across both runtimes and the lanes, has run
//! until it waits on a later timer, on real I/O, or on a task that does.
//!
//! Real I/O (sockets, children, PTY, dedicated threads) completes in real time: before advancing past it, wait for its observable,
//! a message on your own connection or `wait <deadline-ms> <log-line prefix>`, answered `seen <line>` or `missed <prefix>`.
//!
//! Ordered exactly: `mixdog_rt::time`, the ticker, `Scope`, `Liveness`. Timers armed on `tokio::time` directly fire at the first stop
//! at or after their due, unordered among themselves.
//!
//! Disconnect, a malformed command, a wrong token, a non-loopback address, or no settle within settle-ms: the process exits
//! [`EXIT_CODE`] with the cause on stderr.
//!
//! # Why the answer means that
//!
//! A runtime is idle from its `on_thread_park` hook (it found no task to run) to its `on_thread_unpark` hook. A task woken from
//! another thread (the other runtime, a lane, this clock) is pushed on the runtime's inject queue before the runtime is unparked,
//! so `global_queue_depth` covers the gap until the unpark hook runs. A task woken on the runtime's own thread while it is parked is
//! woken by its driver: by a tokio timer only after this clock moved that runtime's tokio clock, which it does from a task on that
//! runtime (so the runtime stays busy until the timers it fired have run), otherwise by real I/O. A lane job counts from its
//! submit until it has run and its result (the wake of its waiter) has been sent, or until it is dropped unrun. Every one of these
//! changes bumps one epoch; the settle point is a snapshot in which nothing is busy, taken with the same epoch before and after, so
//! nothing was busy in between, and nothing idle can wake anything except real I/O.
//!
//! Not observed, so treated as real I/O: PTY jobs (they live as long as their terminal), threads started by a thread token or by a
//! crate itself, and the future the composition root drives with `Handle::block_on` on its own thread (mixdogd's `serve`): a
//! replay starts advancing once the core says it is serving.
//!
//! # Same-instant order, against Node
//!
//! The recordings this clock replays run Node on a virtual timer queue (`benchmarks/rust-core/recorders/lib/phone-world.mjs`
//! `advance`, `record-file-downloads.mjs`, `record-browser-streams.mjs`): due time, then registration order (an interval's next tick
//! is a new registration), the clock set to each timer's due before its callback, one callback at a time with the microtasks
//! drained between. That is the rule above; a timer here is armed when its sleep is created (`sleep`, `sleep_until`, `timeout`,
//! a ticker `register`) and a reset or a new sleep for the same deadline takes a new place.
//!
//! Node's own loop (`lib/internal/timers.js`, v22.20.0) differs: timers sit in one list per duration, the lists in a heap by
//! (expiry, list id), and a list that still holds timers after firing is re-queued under a new id, so of two timers with different
//! durations due in the same millisecond the one whose list was queued first fires first, which is not always the one armed first;
//! all timers due at the loop's `now` fire before any I/O or `setImmediate` callback, with only `process.nextTick` callbacks and
//! microtasks run between two of them (`runNextTicks`); `setTimeout(f, 0)` waits 1 ms. `node:test`'s mock timers
//! (`mock.timers.tick`, `internal/test_runner/mock/mock_timers.js`) order by (runAt, creation id) as here, but set the clock to the
//! tick's end before the first callback and run the callbacks back to back with no microtask between.
//!
//! The core has no microtask/immediate split. Between two timers it runs everything to the settle point, so a lane job one timer
//! started has finished before the next timer of the same instant fires, where Node would finish that I/O after both. A zero delay
//! is never queued: `sleep(ZERO)` is ready at once.
//!
//! # Time readers
//!
//! Under this clock, on RT-C and RT-W, `tokio::time::Instant::now()` reads V: each runtime's tokio clock is paused and moved to V
//! at every stop (`move_to`), its origin within half a millisecond of the other's (`skew`). Wall-clock readers in the crates with
//! this feature (mixdog-rt, mixdog-core-session, mixdog-app-server-daemon, mixdog-cli) go through [`system_now`]
//! (`mixdog_rt::wall_clock!`, `mixdog_rt::utc_now!`), and mixdog-core-session's timers through `mixdog_rt::time`. These read real
//! time on purpose, none of them compared by a replay:
//! - measures of the machine: poll, queue-wait and service durations and the lane leases (mixdog-rt `lib.rs` `Instrumented`,
//!   `exec/pool.rs`, `lanes.rs`), the daemon's stall monitor and its `atMs` lines (`lifecycle/stall.rs`), its boot timing
//!   (`lib.rs` `booted_at`), and this clock's settle deadline;
//! - a std `Instant` turned into a deadline (`ticker::register`, `Scope::deadline`; the daemon's ticker deadlines in `exec.rs`,
//!   `pair_code.rs`, `catalog.rs`, `event_pipeline.rs`, `session_sweep.rs`): read only for its distance from now;
//! - the daemon's prior-owner and claim records (`barrier/mod.rs` `now_ms`, `verdict/mod.rs` release entries,
//!   `server_ensure/os.rs`): compared with other processes' records and OS process start times, which are real;
//! - setup-command progress and step durations (core-session `worktree_setup_run.rs`): they time a child process, real I/O;
//! - uuid v7 ids (core-session `mod.rs` `new_id`, `handle.rs`, `new_route.rs`, `route_session.rs`, `route_setup.rs`; daemon
//!   `late_session.rs`): their time bits sit beside random bits, so no replay compares them;
//! - `tokio::time::Instant::now()` off the runtimes (lane and dedicated threads) reads the real clock.
//!
//! Timers armed on `tokio::time` directly (the daemon, the CLI and every crate without this feature) fire at the first stop at or
//! after their due. A frozen core's I/O timeouts, on either kind of timer, fire only when an advance passes them.

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::pin::pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use tokio::runtime::Builder;
use tokio::runtime::Handle;
use tokio::runtime::Runtime;

use crate::LaneKind;
use crate::QueuedJob;

/// The replay's control address (`127.0.0.1:<port>` or `[::1]:<port>`).
pub const ENV: &str = "MIXDOG_VIRTUAL_CLOCK";
/// The one-time token the replay proves it started this core with.
pub const TOKEN_ENV: &str = "MIXDOG_VIRTUAL_CLOCK_TOKEN";
/// The exit code of a core whose replay's clock failed.
pub const EXIT_CODE: i32 = 86;
/// How long the core waits for the replay to accept its connection and send `start`.
const HANDSHAKE: Duration = Duration::from_secs(30);

/// A timer's place: virtual millisecond, then arming order.
pub(crate) type Key = (u64, u64);

struct Rt {
    name: &'static str,
    handle: Handle,
    /// From the unpark hook to the park hook.
    busy: Arc<AtomicBool>,
    /// The runtime's tokio clock at V = 0.
    origin: tokio::time::Instant,
}

struct Clock {
    /// RT-C, RT-W.
    runtimes: [Rt; 2],
    wall_origin: u64,
    settle_within: Duration,
    /// How far apart the two runtimes' origins are (under half a millisecond): a deadline taken on one runtime's clock and
    /// converted on the other's is this much off.
    skew: Duration,
    /// V, mirrored from `timers` for lock-free readers.
    now: AtomicU64,
    timers: Mutex<Timers>,
    /// `node_log` lines a `wait` has not consumed.
    log: Mutex<Vec<String>>,
    logged: Condvar,
}

#[derive(Default)]
struct Timers {
    now: u64,
    next_seq: u64,
    queue: BTreeMap<Key, Entry>,
}

enum Entry {
    Wake(Arc<Slot>),
    /// A ticker callback, run in a task on RT-C.
    Call(Box<dyn FnOnce() + Send>),
}

/// What a virtual sleep waits on.
#[derive(Default)]
pub(crate) struct Slot {
    fired: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl Slot {
    fn elapsed() -> Arc<Self> {
        Arc::new(Self { fired: AtomicBool::new(true), waker: Mutex::new(None) })
    }

    pub(crate) fn is_fired(&self) -> bool {
        self.fired.load(SeqCst)
    }

    pub(crate) fn poll(&self, cx: &mut Context<'_>) -> Poll<()> {
        if self.is_fired() {
            return Poll::Ready(());
        }
        *lock(&self.waker) = Some(cx.waker().clone());
        // Fired between the check and the store: the waker may have been taken before it was stored.
        if self.is_fired() { Poll::Ready(()) } else { Poll::Pending }
    }

    fn fire(&self) {
        self.fired.store(true, SeqCst);
        let waker = lock(&self.waker).take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

/// Activity of everything the settle point observes.
struct Activity {
    epoch: AtomicU64,
    in_flight: AtomicUsize,
    lock: Mutex<()>,
    changed: Condvar,
}

static ACTIVITY: Activity = Activity { epoch: AtomicU64::new(0), in_flight: AtomicUsize::new(0), lock: Mutex::new(()), changed: Condvar::new() };

static CLOCK: OnceLock<Clock> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ends the process: a core under a replay's clock never runs on its own.
fn fail(cause: impl fmt::Display) -> ! {
    eprintln!("mixdog virtual clock: {cause}");
    std::process::exit(EXIT_CODE)
}

fn changed(idle: bool) {
    ACTIVITY.epoch.fetch_add(1, SeqCst);
    if idle {
        // Taken so a settle between its check and its wait cannot miss the notification.
        drop(lock(&ACTIVITY.lock));
        ACTIVITY.changed.notify_all();
    }
}

/// Whether this process was started under a replay's clock.
pub fn requested() -> bool {
    std::env::var_os(ENV).is_some()
}

/// Whether the replay's clock runs this process.
pub fn active() -> bool {
    CLOCK.get().is_some()
}

/// The wall clock in milliseconds since the Unix epoch, `None` when no replay's clock runs this process.
pub fn now_ms() -> Option<i64> {
    CLOCK.get().map(|clock| i64::try_from(clock.wall_origin + clock.now.load(SeqCst)).unwrap_or(i64::MAX))
}

/// `SystemTime::now()`, on the replay's clock when one runs this process.
pub fn system_now() -> SystemTime {
    match CLOCK.get() {
        Some(clock) => UNIX_EPOCH + Duration::from_millis(clock.wall_origin + clock.now.load(SeqCst)),
        None => SystemTime::now(),
    }
}

fn ceil_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos().div_ceil(1_000_000)).unwrap_or(u64::MAX)
}

fn clock() -> &'static Clock {
    CLOCK.get().expect("the replay's clock runs this process")
}

/// Where a virtual sleep was armed.
pub(crate) struct Armed {
    /// Its place in the queue; `None` when it was due at once.
    pub(crate) key: Option<Key>,
    pub(crate) slot: Arc<Slot>,
    /// Its virtual millisecond.
    pub(crate) due: u64,
}

/// Queues `entry` at virtual millisecond `due`, or `delay` from V; `Err` (with `entry` and V) when that is not after V.
fn arm(due: Due, entry: Entry) -> Result<Key, (Entry, u64)> {
    let mut timers = lock(&clock().timers);
    let due = match due {
        Due::In(delay) => timers.now.saturating_add(ceil_ms(delay)),
        Due::At(due) => due,
    };
    if due <= timers.now {
        return Err((entry, timers.now));
    }
    timers.next_seq += 1;
    let key = (due, timers.next_seq);
    timers.queue.insert(key, entry);
    Ok(key)
}

enum Due {
    In(Duration),
    At(u64),
}

fn wake(due: Due) -> Armed {
    let slot = Arc::new(Slot::default());
    match arm(due, Entry::Wake(slot.clone())) {
        Ok(key) => Armed { key: Some(key), slot, due: key.0 },
        Err((_, now)) => Armed { key: None, slot: Slot::elapsed(), due: now },
    }
}

/// A sleep until `at` on the calling thread's tokio clock.
pub(crate) fn wake_at(at: tokio::time::Instant) -> Armed {
    wake(Due::In(at.saturating_duration_since(tokio::time::Instant::now()).saturating_sub(clock().skew)))
}

/// A sleep until virtual millisecond `due` (an interval's next tick: its last due plus its period, whatever thread re-arms it).
pub(crate) fn wake_on(due: u64) -> Armed {
    wake(Due::At(due))
}

/// `duration` in whole virtual milliseconds, as a deadline rounds it.
pub(crate) fn whole_ms(duration: Duration) -> u64 {
    ceil_ms(duration)
}

/// Runs `call` `delay` from now in a task on RT-C (at once when that is V); `None` when it ran at once.
pub(crate) fn call_after(delay: Duration, call: Box<dyn FnOnce() + Send>) -> Option<Key> {
    match arm(Due::In(delay), Entry::Call(call)) {
        Ok(key) => Some(key),
        Err((entry, _)) => {
            run(clock(), entry);
            None
        }
    }
}

/// Takes a timer out of the queue; `false` when it already fired.
pub(crate) fn disarm(key: Key) -> bool {
    lock(&clock().timers).queue.remove(&key).is_some()
}

/// Counts `job` until it has run and sent its result, or was dropped unrun. PTY jobs are not counted: they last as long as their
/// terminal, which is real I/O.
pub(crate) fn counted(job: QueuedJob) -> QueuedJob {
    if !active() || job.lane() == LaneKind::PtyIo {
        return job;
    }
    ACTIVITY.in_flight.fetch_add(1, SeqCst);
    changed(false);
    job.map_run(|run| {
        let held = InFlight(Some(run));
        Box::new(move || {
            let mut held = held;
            if let Some(run) = held.0.take() {
                run();
            }
        })
    })
}

struct InFlight(Option<Box<dyn FnOnce() + Send>>);

impl Drop for InFlight {
    fn drop(&mut self) {
        // The job (and the result sender of an unrun one) goes first, so its waiter is woken before the count drops.
        drop(self.0.take());
        ACTIVITY.in_flight.fetch_sub(1, SeqCst);
        changed(true);
    }
}

/// Records a `node_log` line for `wait`.
pub(crate) fn logged(line: &str) {
    if let Some(clock) = CLOCK.get() {
        lock(&clock.log).push(line.to_owned());
        clock.logged.notify_all();
    }
}

/// Connects to the replay, builds RT-C and RT-W on its clock and serves its commands on a thread of its own. Returns the two
/// runtimes' handles; every failure ends the process.
pub(crate) fn start(on_control: impl FnOnce() + Send + 'static, on_work: impl FnOnce() + Send + 'static) -> io::Result<(Handle, Handle)> {
    let (mut stream, reader, wall_origin, settle_within) = handshake();
    let (control, control_busy) = build("mixdog-rt-c")?;
    let (work, work_busy) = build("mixdog-rt-w")?;
    let origin = |runtime: &Runtime| {
        let _entered = runtime.enter();
        tokio::time::Instant::now()
    };
    let (control_origin, work_origin) = (origin(&control), origin(&work));
    // Each driver counts whole milliseconds from its own start, so each clock moves only by whole milliseconds; the gap between the
    // two starts is cut to the nearest whole millisecond by moving RT-C's clock.
    let gap = work_origin - control_origin;
    let whole = Duration::from_millis(u64::try_from((gap.as_nanos() + 500_000) / 1_000_000).unwrap_or(u64::MAX));
    if !whole.is_zero() {
        let _entered = control.enter();
        let mut advance = pin!(tokio::time::advance(whole));
        // The first poll moves the clock; the yield after it has no scheduler here and is dropped.
        let _ = advance.as_mut().poll(&mut Context::from_waker(Waker::noop()));
    }
    let control_origin = control_origin + whole;
    let skew = if work_origin > control_origin { work_origin - control_origin } else { control_origin - work_origin };
    let runtimes = [
        Rt { name: "RT-C", handle: control.handle().clone(), busy: control_busy, origin: control_origin },
        Rt { name: "RT-W", handle: work.handle().clone(), busy: work_busy, origin: work_origin },
    ];
    let handles = (runtimes[0].handle.clone(), runtimes[1].handle.clone());
    drive(control, "mixdog-rt-c", on_control)?;
    drive(work, "mixdog-rt-w", on_work)?;
    let clock = Clock {
        runtimes,
        wall_origin,
        settle_within,
        skew,
        now: AtomicU64::new(0),
        timers: Mutex::new(Timers::default()),
        log: Mutex::new(Vec::new()),
        logged: Condvar::new(),
    };
    if CLOCK.set(clock).is_err() {
        fail("a second set of executors started under the replay's clock");
    }
    let clock = self::clock();
    answer(&mut stream, &format!("now {}", clock.wall_origin));
    std::thread::Builder::new().name("mixdog-virtual-clock".to_owned()).spawn(move || serve(clock, reader, stream))?;
    Ok(handles)
}

fn handshake() -> (TcpStream, BufReader<TcpStream>, u64, Duration) {
    let address = std::env::var(ENV).unwrap_or_else(|_| fail(format!("{ENV} is not valid Unicode")));
    let token = std::env::var(TOKEN_ENV).unwrap_or_else(|_| fail(format!("{ENV} is set without {TOKEN_ENV}: only the process that started this core may drive its clock")));
    // SAFETY: the executors start once, at boot, on the thread that boots the process, before mixdog-rt starts any thread; the
    // binaries with this feature (mixdogd and its tests) read no environment on another thread meanwhile. Removed so a process this
    // core starts never inherits the replay's address or token.
    unsafe {
        std::env::remove_var(ENV);
        std::env::remove_var(TOKEN_ENV);
    }
    if token.is_empty() {
        fail(format!("{TOKEN_ENV} is empty"));
    }
    let address: SocketAddr = address.parse().unwrap_or_else(|_| fail(format!("{ENV}={address:?} is not an ip:port")));
    if !address.ip().is_loopback() {
        fail(format!("{ENV}={address} is not a loopback address: a replay's clock is driven from this machine only"));
    }
    let mut stream = TcpStream::connect_timeout(&address, HANDSHAKE).unwrap_or_else(|error| fail(format!("connecting to the replay's clock at {address}: {error}")));
    let _ = stream.set_nodelay(true);
    answer(&mut stream, &format!("hello {}", std::process::id()));
    stream.set_read_timeout(Some(HANDSHAKE)).unwrap_or_else(|error| fail(format!("the control connection: {error}")));
    let mut reader = BufReader::new(stream.try_clone().unwrap_or_else(|error| fail(format!("the control connection: {error}"))));
    let line = next_line(&mut reader, "`start`");
    let (wall_origin, settle_within) = match line.split(' ').collect::<Vec<_>>().as_slice() {
        ["start", given, wall, settle] => {
            if *given != token {
                fail(format!("the replay's `start` carries a token that is not this core's {TOKEN_ENV}: its clock is refused"));
            }
            match (wall.parse::<u64>(), settle.parse::<u64>()) {
                (Ok(wall), Ok(settle)) if settle > 0 => (wall, Duration::from_millis(settle)),
                _ => fail(format!("the replay sent a malformed `start` {line:?}: expected `start <token> <wall-ms> <settle-ms>`")),
            }
        }
        _ => fail(format!("the replay sent {line:?} where `start <token> <wall-ms> <settle-ms>` was expected")),
    };
    stream.set_read_timeout(None).unwrap_or_else(|error| fail(format!("the control connection: {error}")));
    (stream, reader, wall_origin, settle_within)
}

fn next_line(reader: &mut BufReader<TcpStream>, waiting_for: &str) -> String {
    let mut line = String::new();
    let closed = |how: &str| -> ! {
        fail(format!("the replay closed the control connection ({how}) while the core waited for {waiting_for}: a core under a replay's clock does not run on its own"))
    };
    match reader.read_line(&mut line) {
        Ok(0) => closed("end of stream"),
        Ok(_) => line.trim_end_matches(['\r', '\n']).to_owned(),
        Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => closed(&error.to_string()),
        Err(error) => fail(format!("the replay's control connection failed while the core waited for {waiting_for}: {error}")),
    }
}

fn answer(stream: &mut TcpStream, line: &str) {
    if let Err(error) = writeln!(stream, "{line}") {
        fail(format!("answering the replay ({line:?}): {error}"));
    }
}

/// A paused `current_thread` runtime whose park hooks report its activity.
fn build(name: &'static str) -> io::Result<(Runtime, Arc<AtomicBool>)> {
    let busy = Arc::new(AtomicBool::new(true));
    let (parks, unparks) = (busy.clone(), busy.clone());
    let runtime = Builder::new_current_thread()
        .thread_name(name)
        .enable_all()
        .start_paused(true)
        .on_thread_park(move || {
            parks.store(false, SeqCst);
            changed(true);
        })
        .on_thread_unpark(move || {
            unparks.store(true, SeqCst);
            changed(false);
        })
        .build()?;
    Ok((runtime, busy))
}

/// Drives `runtime` on a thread of its own, its clock held from auto-advancing.
fn drive(runtime: Runtime, name: &str, on_start: impl FnOnce() + Send + 'static) -> io::Result<()> {
    // A paused clock jumps to the next timer whenever its runtime is idle, unless a blocking task lives (tokio counts it against
    // auto-advance, `tokio::time::pause`): this one lives as long as the process.
    #[allow(clippy::disallowed_methods, reason = "a replay's clock, test builds only: a live blocking task is tokio's one hold on a paused clock's auto-advance")]
    drop(runtime.spawn_blocking(|| {
        loop {
            std::thread::park();
        }
    }));
    std::thread::Builder::new().name(name.to_owned()).spawn(move || {
        on_start();
        runtime.block_on(std::future::pending::<()>());
    })?;
    Ok(())
}

fn run(clock: &Clock, entry: Entry) {
    match entry {
        Entry::Wake(slot) => slot.fire(),
        Entry::Call(call) => drop(clock.runtimes[0].handle.spawn(async move { call() })),
    }
}

/// Fires the first queued timer if it is due at V.
fn fire_first(clock: &Clock) -> bool {
    let entry = {
        let mut timers = lock(&clock.timers);
        match timers.queue.first_key_value() {
            Some((key, _)) if key.0 <= timers.now => timers.queue.pop_first().map(|(_, entry)| entry),
            _ => None,
        }
    };
    entry.map(|entry| run(clock, entry)).is_some()
}

/// Sets V to `to` and moves both tokio clocks there, from a task on each runtime, then settles.
fn move_to(clock: &Clock, to: u64, during: &str) {
    lock(&clock.timers).now = to;
    clock.now.store(to, SeqCst);
    for runtime in &clock.runtimes {
        let at = runtime.origin + Duration::from_millis(to);
        drop(runtime.handle.spawn(async move {
            let now = tokio::time::Instant::now();
            if at > now {
                tokio::time::advance(at - now).await;
            }
        }));
    }
    settle(clock, during);
}

fn advance(clock: &Clock, ms: u64) {
    let during = format!("advance {ms}");
    settle(clock, &during);
    let target = clock.now.load(SeqCst).saturating_add(ms);
    loop {
        let next = lock(&clock.timers).queue.first_key_value().map(|(key, _)| key.0).filter(|due| *due <= target);
        let Some(due) = next else { break };
        if due > clock.now.load(SeqCst) {
            move_to(clock, due, &during);
        }
        if fire_first(clock) {
            settle(clock, &during);
        }
    }
    if clock.now.load(SeqCst) < target {
        move_to(clock, target, &during);
    }
}

/// What keeps the core from its settle point, if anything.
fn busy(clock: &Clock) -> Option<String> {
    for runtime in &clock.runtimes {
        if runtime.busy.load(SeqCst) {
            return Some(format!("{} is running a task", runtime.name));
        }
        let queued = runtime.handle.metrics().global_queue_depth();
        if queued > 0 {
            return Some(format!("{} has {queued} task(s) queued", runtime.name));
        }
    }
    match ACTIVITY.in_flight.load(SeqCst) {
        0 => None,
        jobs => Some(format!("{jobs} lane job(s) are queued or running")),
    }
}

/// Waits until nothing observed is busy, within the replay's settle bound.
fn settle(clock: &Clock, during: &str) {
    let deadline = std::time::Instant::now() + clock.settle_within;
    loop {
        let seen = ACTIVITY.epoch.load(SeqCst);
        let busy = busy(clock);
        if busy.is_none() && ACTIVITY.epoch.load(SeqCst) == seen {
            return;
        }
        let guard = lock(&ACTIVITY.lock);
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            let busy = busy.unwrap_or_else(|| "its activity never stopped".to_owned());
            fail(format!("{during}: the core did not settle within {} ms: {busy}", clock.settle_within.as_millis()));
        }
        drop(ACTIVITY.changed.wait_timeout_while(guard, left, |_| ACTIVITY.epoch.load(SeqCst) == seen));
    }
}

/// The first unconsumed log line starting with `prefix`, within `within`; the lines up to it are consumed.
fn wait_log(clock: &Clock, within: Duration, prefix: &str) -> Option<String> {
    let deadline = std::time::Instant::now() + within;
    let mut lines = lock(&clock.log);
    loop {
        if let Some(at) = lines.iter().position(|line| line.starts_with(prefix)) {
            return lines.drain(..=at).next_back();
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        lines = clock.logged.wait_timeout(lines, left).unwrap_or_else(PoisonError::into_inner).0;
    }
}

enum Command<'a> {
    Advance(u64),
    Wait { within: u64, prefix: &'a str },
}

fn parse(line: &str) -> Option<Command<'_>> {
    let (verb, rest) = line.split_once(' ')?;
    match verb {
        "advance" => rest.parse().ok().map(Command::Advance),
        "wait" => {
            let (within, prefix) = rest.split_once(' ')?;
            (!prefix.is_empty()).then_some(())?;
            Some(Command::Wait { within: within.parse().ok()?, prefix })
        }
        _ => None,
    }
}

fn serve(clock: &'static Clock, mut reader: BufReader<TcpStream>, mut stream: TcpStream) {
    loop {
        let line = next_line(&mut reader, "the replay's next command");
        let reply = match parse(&line) {
            Some(Command::Advance(ms)) => {
                advance(clock, ms);
                format!("now {}", clock.wall_origin + clock.now.load(SeqCst))
            }
            Some(Command::Wait { within, prefix }) => match wait_log(clock, Duration::from_millis(within), prefix) {
                Some(seen) => {
                    settle(clock, &format!("wait for {prefix:?}"));
                    format!("seen {seen}")
                }
                None => format!("missed {prefix}"),
            },
            None => fail(format!("the replay sent a malformed command {line:?}: the clock knows `advance <ms>` and `wait <deadline-ms> <log-line prefix>`")),
        };
        answer(&mut stream, &reply);
    }
}
