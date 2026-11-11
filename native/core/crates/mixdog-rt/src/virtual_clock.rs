//! A replay's clock (feature `virtual-clock`; `build.rs` fails any release-profile build with it).
//!
//! # Contract
//!
//! Start the core with `MIXDOG_VIRTUAL_CLOCK=<loopback ip:port>` and `MIXDOG_VIRTUAL_CLOCK_TOKEN=<token>`. It connects there, sends
//! `hello <pid>`, waits for `start <token> <wall-ms> <settle-ms>` and answers `now <wall-ms>`. Virtual time V starts at 0; the wall
//! clock reads wall-ms + V and moves only by `advance`.
//!
//! `advance <ms>` runs Node's idle event loop over `ms`: it turns at each timer list's expiry before V+ms, in order, and once at
//! V+ms, with V set to that instant; a turn fires what Node's `processTimers` fires there, one timer at a time (timers armed
//! meanwhile join their lists), then its check phase: the immediates queued before that phase began (below). After each timer
//! and immediate it waits for the settle point below (RT-C and RT-W parked with empty queues, no lane job queued or running);
//! then it answers `now <wall-ms>`, or `now <wall-ms> immediates <n>` when n immediates queued by immediates wait for the next
//! turn: `advance 0` is that turn, at the same V. So everything those timers made runnable, across both runtimes and the
//! lanes, has run until it waits on a later timer, on real I/O, on the next turn's check phase, or on a task that does.
//!
//! Real I/O (sockets, children, PTY, dedicated threads) completes in real time: before advancing past it, wait for its observable,
//! a message on your own connection or `wait <deadline-ms> <line>`.
//!
//! `wait`: the core numbers its `node_log` lines from 0 in log order and keeps every one from the cursor (0 at start) on. `wait`
//! finds the first kept line equal to `<line>`, the whole line, byte for byte (a longer line that starts the same is another
//! line), waiting up to deadline-ms of real time for it to be logged; it answers `seen <n>`, its number, once the core settles, or
//! `missed "<line>": ` and what was kept instead: `no line logged from the cursor <c>`, or `from the cursor <c>, <k> line(s): `
//! and the kept lines, each quoted (Rust's `{:?}`), comma-separated, only the last 20 (`, the last 20` before the colon) when
//! there are more. It moves nothing: lines are matched in log order whatever order they are waited in. `cursor <n>` moves the cursor
//! forward to `n`, at most the number of lines logged so far, and answers `cursor <n>`; the lines before it are dropped, so the next
//! `wait` for a repeated line finds its next occurrence. A cursor moved back or past the lines logged ends the process.
//!
//! Ordered exactly: `mixdog_rt::time`, the ticker, `Scope`, `Liveness`; `clippy.toml` refuses `tokio::time`'s timer functions in
//! every other crate, and here only `time.rs` (its wrappers, for use off this clock) and tests arm them; such a timer fires at the
//! first stop at or after its due, unordered among its kind.
//!
//! A thread of its own reads the connection while commands run, so a closed connection or a malformed command ends the process at
//! once, during an `advance` or a `wait` too. Every millisecond count on the wire is at most [`MAX_MS`] (2^53 - 1, JavaScript's
//! largest exact integer), and the wall clock (wall-ms, then wall-ms + V) at most [`max_wall_ms`], the last millisecond every
//! reader of it holds (chrono's `DateTime<Utc>`, this platform's `SystemTime`): a larger number, a `start` past it, or an
//! `advance` that would take wall-ms + V past it, ends the process, as do a wrong token, a non-loopback address and no settle
//! within settle-ms: exit [`EXIT_CODE`], the cause on stderr.
//!
//! # The settle point: invariant
//!
//! Counted work shows on one of five indicators: each runtime's inject queue (`global_queue_depth`), each runtime's busy flag
//! (set in its `on_thread_unpark` hook, cleared in its `on_thread_park` hook), and the lane jobs in flight. `settle` reads the
//! epoch, then both queues, then both busy flags and the in-flight count, then the epoch again, and calls the core idle only when
//! all five read zero between two equal epoch reads. Every transition keeps three rules:
//!
//! 1. Hand-over: work that creates work makes the new work show on an indicator before its own indicator can read zero.
//! 2. Bump before release: an indicator that drops to zero first bumps the epoch (`bump`, then the store). `released` bumps
//!    once more after the store, so a settle that read the first bump and the indicator before the drop wakes and looks again.
//! 3. Queue before flag: a runtime takes a task off its inject queue only with its busy flag already set.
//!
//! Why an idle read is true: take any counted work alive at the first epoch read and follow it through its hand-overs. Every
//! hand-over (rule 1) is followed by a release that bumps first (rule 2), so with equal epochs no hand-over finished in between,
//! and some piece of that work stayed on one indicator for the whole read: on a busy flag or the in-flight count, which is read
//! after the queues and cannot drop unbumped, or on a queue, which it leaves only for its runtime's flag, read later (rule 3).
//! Work that was not alive at the first read was made by work that was, or by an uncounted source.
//!
//! # Transitions
//!
//! | # | Transition | Indicator change | Upheld by |
//! |---|---|---|---|
//! | 1 | task spawned or woken from another thread (the other runtime, a lane, this clock, any thread) | its runtime's queue +1 inside the wake, before the waker returns | tokio `current_thread` `Schedule::schedule`: `inject.push`, then `driver.unpark` |
//! | 2 | task spawned or woken on its own runtime's thread (channel, `JoinHandle`, `spawn` from a task) | local queue while the busy flag is set | tokio `block_on` loop: `park` only after `next_task` found nothing and `has_pending_work` is false |
//! | 3 | deferred wake (`yield_now`, coop budget) | defer list while the busy flag is set | same loop: `park_yield`, which runs no hook, while `defer` is not empty |
//! | 4 | task woken by this clock's timer | row 1 from this clock's thread | `advance`: `fire_next`, then `settle`, on one thread |
//! | 5 | ticker callback | a task spawned on RT-C from this clock's thread (row 1) | `run` |
//! | 6 | tokio timer (`tokio::time` armed directly: this crate's tests) | fired by its runtime's driver in `park_yield` while the move task runs (row 2) | `move_to` spawns the move on each runtime (row 1) |
//! | 7 | task woken by the I/O driver in a real park | local queue while the busy flag is clear: unseen until row 8 | not upheld: real I/O, which the replay waits for (`wait`) |
//! | 8 | runtime unparked | busy flag set before any task is taken (rule 3) | `build`: the `on_thread_unpark` hook runs in tokio's `park` before the loop's `next_task` |
//! | 9 | runtime parks | bump, busy flag cleared, bump | `build`: the `on_thread_park` hook |
//! | 10 | lane job queued | in-flight +1 before the job enters a lane queue | `counted`, called by `Executors::submit` before `LaneExec::submit` |
//! | 11 | lane job started | none: in flight since row 10 | `counted` |
//! | 12 | lane job finished | result sent (its waiter: row 1), bump, in-flight -1, bump | `InFlight`'s drop |
//! | 13 | lane job dropped unrun (cancelled at dequeue, refused, lane gone) | result sender dropped (row 1), bump, in-flight -1, bump | `InFlight`'s drop |
//! | 14 | task spawned by a lane job | row 1 before row 12 | the job's body runs inside `InFlight` |
//! | 15 | PTY job, a thread token's or a crate's own thread, `Handle::block_on` off the runtimes (mixdogd's `serve`) | not counted | real I/O; whatever they wake on a runtime is row 1 from its push on |
//! | 16 | immediate queued | none: its task waits on it as on a timer | `check_phase`, run under `turn` by `advance` (each turn, and before it answers), by `wait` before it answers, and by `drive_checks` between commands |
//! | 17 | immediate fired | row 4: row 1 from this clock's thread, then `settle` | `check_phase` |
//!
//! `tests/virtual_clock.rs` holds each counted transition half done at a pause point ([`pause`]: `lane-queued`, `lane-start`,
//! `lane-sent`, `lane-bumped`, `lane-released`, `spawned <task>`, `polled <task>`, `parking <RT>`, `parked <RT>`,
//! `unparking <RT>`, `unparked <RT>`, `settle-read-queues`) while an `advance` settles, and checks that it answers only after the
//! transition completed and its work ran; `the_reviewers_interleaving` is a lane completion between settle's queue and flag
//! reads.
//!
//! # Same-instant order: Node's
//!
//! Node v22.20.0, `lib/internal/timers.js` (read from the binary: `process.binding('natives')`), which `Timers` copies:
//! - `new Timeout`: a duration under 1 ms (or not a number, or over 2^31 - 1) is 1 ms; `insert` cuts it to whole milliseconds.
//! - `insert(item, msecs, start = getLibuvNow())`: one list per duration (`timerListMap[msecs]`); a missing list is created with
//!   `expiry = start + msecs` and the next `timerListId`, and queued; the timer goes to the list's end.
//! - The queue orders lists by expiry, then id (`compareTimersLists`). `processTimers(now)` takes the head list while its
//!   expiry <= now; `listOnTimeout` fires its timers from the front while `now - _idleStart >= msecs`; at the first that is not
//!   due it sets `expiry = max(_idleStart + msecs, now + 1)` and a new id (the list goes behind lists of the same expiry made
//!   since), and an emptied list is deleted, so a later timer of that duration makes a new list.
//! - `clearTimeout` (`unenroll`) of a refed timer deletes its list once empty; of an unrefed one (`timer.unref()`, not `ref()`ed
//!   since) it leaves the list queued, empty or not, with its expiry and id, so the next timer of that duration joins it and,
//!   when its expiry comes, is re-queued behind the lists of its own expiry made since. `unref()` and `ref()` alone move nothing.
//!   An interval is re-inserted after its callback returns, `msecs` from the `getLibuvNow()` read before it.
//! - Between two timers only `process.nextTick` callbacks and microtasks run (`runNextTicks`); `setImmediate` callbacks and I/O
//!   run after every timer of the turn. The check phase (`processImmediate`) takes the queue as it is and runs it in order;
//!   an immediate queued meanwhile waits for the next loop turn, whose timers phase comes first.
//!
//! So of timers due in the same millisecond, the one whose list is older fires first, which is not always the one armed first,
//! and a timer armed while another fires never fires in the same turn. Here: a sleep (`sleep`, `timeout`) is a `setTimeout` of
//! its duration; a deadline (`sleep_until`, `timeout_at`, `Sleep::reset`, a ticker `register`) is one of its distance to the
//! nearest millisecond, ready at once when that is none; `interval_at` is a `setInterval` whose first tick is a deadline; a
//! dropped sleep or a cancelled ticker deadline is a `clearTimeout`; `sleep_unrefed`, `sleep_until_unrefed` and
//! `interval_at_unrefed` are those of an `unref()`ed Node timer. `mixdog_rt::time::immediate()` is `await new Promise((r) =>
//! setImmediate(r))` and `check_phase()` the start of a task Node runs as `setImmediate(f)`: each is queued when made and fired by
//! [`check_phase`] after the timers of the turn, one at a time with a settle after each; the immediates they queue run in the
//! next turn (an immediate that queues itself again runs once a turn, never holding an `advance` at one V). An immediate queued
//! between commands (by real I/O, or work an answer left behind) runs once the core is idle, from a thread of the clock's own,
//! or in the check phase an `advance` or a `wait`'s answer runs first; the immediates that phase queues no answer reports:
//! Node runs them in its next turn at once, so a replay that resumes after real I/O sends `advance 0` (a turn at the same V,
//! a no-op when nothing is queued) until it answers no `immediates`, before advancing time. The recording
//! `native/core/fixtures/node-timer-order` (`benchmarks/rust-core/recorders/record-node-timer-order.mjs`, real Node timers on an
//! idle loop turned at each list's expiry) is replayed case for case by `tests/virtual_clock.rs` `node_timer_order`.
//!
//! Not replayed (the recording's `exclusions`): `process.nextTick`'s priority over promise jobs. The clock's guarantee is that
//! everything a timer's or an immediate's code makes runnable runs to the settle point before the next one, which is what Node's
//! `runNextTicks` drains between them; among it, tasks run in the order spawned on one runtime and unordered across the two.
//! No core code can observe the priority: Node b6f10295a calls `process.nextTick` nowhere in `src/` outside tests, so no core
//! code is its counterpart, and a Rust port orders its own continuations by program order inside one task, which the clock does
//! not touch (`ticks-and-promises-between-timers`, ticks and promise jobs queued in order, is replayed). Also unlike Node:
//! between two timers the core runs everything to the settle point, so a lane job one timer started has finished before the
//! next timer of the turn; a task spawned by a timer's code runs before that timer's list is re-queued (Node re-queues it before
//! its nextTicks), so a timer such a task arms for the same expiry as the re-queued list goes ahead of it; and durations over
//! 2^31 - 1 ms stay as they are.
//!
//! # Time readers
//!
//! Under this clock, on RT-C and RT-W, `tokio::time::Instant::now()` reads V: each runtime's tokio clock is paused and moved to V
//! at every stop (`move_to`), its origin within half a millisecond of the other's. Wall-clock readers in the crates with
//! this feature (mixdog-rt, mixdog-core-session, mixdog-app-server-daemon, mixdog-cli) go through [`system_now`]
//! (`mixdog_rt::wall_clock!`, `mixdog_rt::utc_now!`), and every crate's timers through `mixdog_rt::time`. These read real
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
//! A frozen core's I/O timeouts fire only when an advance passes them.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::num::IntErrorKind;
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
use std::sync::mpsc;
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
/// The largest millisecond count the wire carries, and the largest wall-ms + V: JavaScript's largest exact integer
/// (`Number.MAX_SAFE_INTEGER`), where a Node replay's numbers end.
pub const MAX_MS: u64 = (1 << 53) - 1;
/// How long the core waits for the replay to accept its connection and send `start`.
const HANDSHAKE: Duration = Duration::from_secs(30);

/// An armed timer, for `disarm`.
pub(crate) type Key = u64;

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
    /// V, mirrored from `timers` for lock-free readers.
    now: AtomicU64,
    timers: Mutex<Timers>,
    /// Node's `immediateQueue`: queued and not yet fired, oldest first.
    immediates: Mutex<VecDeque<Arc<Slot>>>,
    /// Wakes the check driver ([`drive_checks`]) when an immediate is queued.
    immediate_queued: Condvar,
    /// A check phase is firing immediates ([`check_phase`]).
    checking: AtomicBool,
    /// An immediate was queued outside a check phase: the check driver owes it one.
    checks_owed: AtomicBool,
    /// Held by whoever runs Node's loop phases (an `advance`, a `wait`'s answer, the check driver): one at a time.
    turn: Mutex<()>,
    log: Mutex<Log>,
    logged: Condvar,
    /// The commands read and not yet answered, oldest first.
    unanswered: Mutex<VecDeque<String>>,
}

/// The `node_log` lines from the cursor on.
#[derive(Default)]
struct Log {
    /// The cursor: the number of `lines[0]`.
    first: u64,
    lines: VecDeque<String>,
}

/// Node's timer lists (`lib/internal/timers.js`): one list per duration, the lists in a queue by (expiry, list id).
#[derive(Default)]
struct Timers {
    now: u64,
    next_key: Key,
    /// Node's `timerListId`.
    next_list_id: u64,
    next_uid: u64,
    /// By identity: a list deleted from `by_msecs` and recreated is another list.
    lists: HashMap<u64, List>,
    /// Node's `timerListMap`.
    by_msecs: HashMap<u64, u64>,
    /// Node's `timerListQueue`: (expiry, id, list).
    queue: BTreeSet<(u64, u64, u64)>,
    /// The list each armed timer is in.
    armed: HashMap<Key, u64>,
}

struct List {
    msecs: u64,
    expiry: u64,
    id: u64,
    /// In arming order, each with its start (`_idleStart`) and whether it is refed (`kRefed`).
    items: BTreeMap<Key, (u64, bool, Entry)>,
}

impl Timers {
    /// Node's `insert(item, msecs, start)`: appends to the list of `msecs`, creating it (expiry `start + msecs`, the next id).
    fn insert(&mut self, msecs: u64, start: u64, refed: bool, entry: Entry) -> Key {
        let uid = match self.by_msecs.get(&msecs) {
            Some(uid) => *uid,
            None => {
                let (uid, id, expiry) = (self.next_uid, self.next_list_id, start.saturating_add(msecs));
                self.next_uid += 1;
                self.next_list_id += 1;
                self.lists.insert(uid, List { msecs, expiry, id, items: BTreeMap::new() });
                self.by_msecs.insert(msecs, uid);
                self.queue.insert((expiry, id, uid));
                uid
            }
        };
        let key = self.next_key;
        self.next_key += 1;
        self.lists.get_mut(&uid).expect("a queued list").items.insert(key, (start, refed, entry));
        self.armed.insert(key, uid);
        key
    }

    /// Node's `unenroll`: removes the timer, and, when it is refed, its list once that is empty; an unrefed timer's list stays
    /// queued, empty or not, with its expiry and id, and the next timer of its duration joins it.
    fn remove(&mut self, key: Key) -> bool {
        let Some(uid) = self.armed.remove(&key) else { return false };
        let list = self.lists.get_mut(&uid).expect("an armed timer's list");
        let (_, refed, _) = list.items.remove(&key).expect("an armed timer");
        if refed && list.items.is_empty() {
            self.delete(uid);
        }
        true
    }

    fn delete(&mut self, uid: u64) {
        if let Some(list) = self.lists.remove(&uid) {
            self.queue.remove(&(list.expiry, list.id, uid));
            if self.by_msecs.get(&list.msecs) == Some(&uid) {
                self.by_msecs.remove(&list.msecs);
            }
        }
    }

    /// The next timer Node's `processTimers(now)` fires, taken out of its list, with V = `now`: the head list is due, its
    /// first timer is due (or the list is re-queued as `listOnTimeout` does), an emptied list is deleted.
    fn take_due(&mut self) -> Option<Entry> {
        let now = self.now;
        loop {
            let &(expiry, id, uid) = self.queue.first()?;
            if expiry > now {
                return None;
            }
            let list = self.lists.get_mut(&uid).expect("a queued list");
            let Some((&key, &(start, ..))) = list.items.first_key_value() else {
                self.delete(uid);
                continue;
            };
            if now.saturating_sub(start) < list.msecs {
                // `list.expiry = MathMax(timer._idleStart + msecs, now + 1); list.id = timerListId++`
                (list.expiry, list.id) = (start.saturating_add(list.msecs).max(now + 1), self.next_list_id);
                self.next_list_id += 1;
                self.queue.remove(&(expiry, id, uid));
                self.queue.insert((list.expiry, list.id, uid));
                continue;
            }
            let (.., entry) = list.items.remove(&key).expect("the first timer");
            self.armed.remove(&key);
            return Some(entry);
        }
    }
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

/// Rule 2: the epoch moves before an indicator drops to zero.
fn bump() {
    ACTIVITY.epoch.fetch_add(1, SeqCst);
}

/// After an indicator dropped: moves the epoch again, so a settle that read the epoch after the first bump but the indicator
/// before the drop looks again, and wakes it.
fn released() {
    bump();
    notify();
}

/// Wakes a settle waiting for the epoch to move.
fn notify() {
    // Taken so a settle between its check and its wait cannot miss the notification.
    drop(lock(&ACTIVITY.lock));
    ACTIVITY.changed.notify_all();
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
        // At most `max_wall_ms()`: `start` and `advance` refuse a wall clock past it.
        Some(clock) => UNIX_EPOCH + Duration::from_millis(clock.wall_origin + clock.now.load(SeqCst)),
        None => SystemTime::now(),
    }
}

/// Whether every reader of the wall clock holds `ms` since the Unix epoch: the wire ([`MAX_MS`]), this platform's `SystemTime`
/// ([`system_now`]) and chrono's `DateTime<Utc>` (`utc_now!`).
fn wall_holds(ms: u64) -> bool {
    ms <= MAX_MS && UNIX_EPOCH.checked_add(Duration::from_millis(ms)).is_some() && i64::try_from(ms).ok().and_then(chrono::DateTime::from_timestamp_millis).is_some()
}

/// The largest wall clock, in milliseconds since the Unix epoch, every reader holds: chrono's last instant (year 262142), or
/// sooner where this platform's `SystemTime` ends (Windows: year 30828).
pub fn max_wall_ms() -> u64 {
    // `wall_holds` is true from 0 up to its bound and false past it.
    let (mut held, mut past) = (0, MAX_MS + 1);
    while past - held > 1 {
        let mid = held + (past - held) / 2;
        if wall_holds(mid) {
            held = mid;
        } else {
            past = mid;
        }
    }
    held
}

/// Node's timer duration (the `Timeout` constructor and `insert`): whole milliseconds, the fraction cut, under 1 ms made 1 ms.
/// Above Node's `TIMEOUT_MAX` (2^31 - 1 ms), which Node also makes 1 ms, the duration stays as it is: core code sleeps that long
/// to mean "not in this run".
fn node_ms(delay: Duration) -> u64 {
    u64::try_from(delay.as_millis()).unwrap_or(u64::MAX).max(1)
}

/// A deadline's distance in whole milliseconds, to the nearest: the runtimes' tokio clocks are under half a millisecond apart.
fn nearest_ms(distance: Duration) -> u64 {
    u64::try_from((distance.as_nanos() + 500_000) / 1_000_000).unwrap_or(u64::MAX)
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

enum Due {
    /// `setTimeout(f, delay)`: [`node_ms`] from V, never at once.
    After(Duration),
    /// A deadline this far from now: [`nearest_ms`] from V, at once when that is V.
    Until(Duration),
    /// An interval's next tick, as Node's `insert(timer, repeat, start)`: `msecs` from `start`, the V its last tick fired at.
    From { msecs: u64, start: u64 },
}

/// Inserts `entry` into Node's lists, refed or not (`timer.unref()`); `Err` with it when it is due at once.
fn arm(due: Due, refed: bool, entry: Entry) -> Result<(Key, u64), Entry> {
    let mut timers = lock(&clock().timers);
    let now = timers.now;
    let (msecs, start) = match due {
        Due::After(delay) => (node_ms(delay), now),
        Due::Until(distance) => (nearest_ms(distance), now),
        Due::From { msecs, start } => (msecs, start),
    };
    let due = start.saturating_add(msecs);
    if due <= now {
        return Err(entry);
    }
    Ok((timers.insert(msecs, start, refed, entry), due))
}

fn wake(due: Due, refed: bool) -> Armed {
    let slot = Arc::new(Slot::default());
    match arm(due, refed, Entry::Wake(slot.clone())) {
        Ok((key, due)) => Armed { key: Some(key), slot, due },
        Err(_) => Armed { key: None, slot: Slot::elapsed(), due: clock().now.load(SeqCst) },
    }
}

/// `sleep(delay)`: Node's `setTimeout(f, delay)`, unrefed (`timer.unref()`) when not `refed`.
pub(crate) fn wake_after(delay: Duration, refed: bool) -> Armed {
    wake(Due::After(delay), refed)
}

/// `sleep_until(at)`, `at` on the calling thread's tokio clock.
pub(crate) fn wake_at(at: tokio::time::Instant, refed: bool) -> Armed {
    wake(Due::Until(at.saturating_duration_since(tokio::time::Instant::now())), refed)
}

/// An interval's next tick: `period` from `start`, the V its last tick fired at.
pub(crate) fn wake_from(start: u64, period: Duration, refed: bool) -> Armed {
    wake(Due::From { msecs: node_ms(period), start }, refed)
}

/// Node's `setImmediate`: ready in the check phase ([`check_phase`]) after the turn that queued it.
pub(crate) fn immediate() -> Arc<Slot> {
    let clock = clock();
    let slot = Arc::new(Slot::default());
    let mut immediates = lock(&clock.immediates);
    immediates.push_back(slot.clone());
    // One queued by an immediate waits for the next turn of an advance; any other is owed a check phase between commands.
    if !clock.checking.load(SeqCst) {
        clock.checks_owed.store(true, SeqCst);
    }
    drop(immediates);
    clock.immediate_queued.notify_all();
    slot
}

/// Runs `call` in a task on RT-C when a deadline `distance` from now comes (at once when that is V); `None` when it ran at
/// once.
pub(crate) fn call_after(distance: Duration, call: Box<dyn FnOnce() + Send>) -> Option<Key> {
    match arm(Due::Until(distance), true, Entry::Call(call)) {
        Ok((key, _)) => Some(key),
        Err(entry) => {
            run(clock(), entry);
            None
        }
    }
}

/// Takes a timer out of its list, as Node's `clearTimeout`; `false` when it already fired.
pub(crate) fn disarm(key: Key) -> bool {
    lock(&clock().timers).remove(key)
}

/// Counts `job` until it has run and sent its result, or was dropped unrun. PTY jobs are not counted: they last as long as their
/// terminal, which is real I/O.
pub(crate) fn counted(job: QueuedJob) -> QueuedJob {
    if !active() || job.lane() == LaneKind::PtyIo {
        return job;
    }
    // Row 10: counted before the lane queue holds it.
    ACTIVITY.in_flight.fetch_add(1, SeqCst);
    pause::point(|| "lane-queued".to_owned());
    job.map_run(|run| {
        let held = InFlight(Some(run));
        Box::new(move || {
            let mut held = held;
            pause::point(|| "lane-start".to_owned());
            if let Some(run) = held.0.take() {
                run();
            }
        })
    })
}

/// A lane job's place in the in-flight count (rows 12 and 13).
struct InFlight(Option<Box<dyn FnOnce() + Send>>);

impl Drop for InFlight {
    fn drop(&mut self) {
        // The job (and the result sender of an unrun one) goes first, so its waiter is queued before the count drops (rule 1).
        drop(self.0.take());
        pause::point(|| "lane-sent".to_owned());
        bump();
        pause::point(|| "lane-bumped".to_owned());
        ACTIVITY.in_flight.fetch_sub(1, SeqCst);
        released();
        pause::point(|| "lane-released".to_owned());
    }
}

/// Records a `node_log` line for `wait`.
pub(crate) fn logged(line: &str) {
    if let Some(clock) = CLOCK.get() {
        lock(&clock.log).lines.push_back(line.to_owned());
        clock.logged.notify_all();
    }
}

/// Connects to the replay, builds RT-C and RT-W on its clock and serves its commands on a thread of its own. Returns the two
/// runtimes' handles; every failure ends the process.
pub(crate) fn start(on_control: impl FnOnce() + Send + 'static, on_work: impl FnOnce() + Send + 'static) -> io::Result<(Handle, Handle)> {
    let (mut stream, reader, wall_origin, settle_within) = handshake();
    let (control, control_busy) = build("mixdog-rt-c", "RT-C")?;
    let (work, work_busy) = build("mixdog-rt-w", "RT-W")?;
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
        now: AtomicU64::new(0),
        timers: Mutex::new(Timers::default()),
        immediates: Mutex::new(VecDeque::new()),
        immediate_queued: Condvar::new(),
        checking: AtomicBool::new(false),
        checks_owed: AtomicBool::new(false),
        turn: Mutex::new(()),
        log: Mutex::new(Log::default()),
        logged: Condvar::new(),
        unanswered: Mutex::new(VecDeque::new()),
    };
    if CLOCK.set(clock).is_err() {
        fail("a second set of executors started under the replay's clock");
    }
    let clock = self::clock();
    answer(&mut stream, &format!("now {}", clock.wall_origin));
    let (commands, received) = mpsc::channel();
    std::thread::Builder::new().name("mixdog-virtual-clock-reader".to_owned()).spawn(move || read(clock, reader, &commands))?;
    std::thread::Builder::new().name("mixdog-virtual-clock".to_owned()).spawn(move || serve(clock, &received, stream))?;
    std::thread::Builder::new().name("mixdog-virtual-clock-check".to_owned()).spawn(move || drive_checks(clock))?;
    Ok(handles)
}

/// A millisecond count from the wire: `None` when `field` is not a decimal; past [`MAX_MS`], the process ends.
fn wire_ms(field: &str, line: &str) -> Option<u64> {
    match field.parse::<u64>() {
        Ok(ms) if ms <= MAX_MS => Some(ms),
        Err(error) if *error.kind() != IntErrorKind::PosOverflow => None,
        _ => fail(format!("the replay sent {line:?}: {field} is past {MAX_MS} ms (2^53 - 1), the largest millisecond count of the wire")),
    }
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
    let line = next_line(&mut reader, || "before `start`".to_owned());
    let (wall_origin, settle_within) = match line.split(' ').collect::<Vec<_>>().as_slice() {
        ["start", given, wall, settle] => {
            if *given != token {
                fail(format!("the replay's `start` carries a token that is not this core's {TOKEN_ENV}: its clock is refused"));
            }
            match (wire_ms(wall, &line), wire_ms(settle, &line)) {
                (Some(wall), Some(_)) if !wall_holds(wall) => fail(format!(
                    "the replay sent {line:?}: wall-ms {wall} is past {} ms, the largest wall clock this core's readers hold",
                    max_wall_ms()
                )),
                (Some(wall), Some(settle)) if settle > 0 => (wall, Duration::from_millis(settle)),
                _ => fail(format!("the replay sent a malformed `start` {line:?}: expected `start <token> <wall-ms> <settle-ms>`")),
            }
        }
        _ => fail(format!("the replay sent {line:?} where `start <token> <wall-ms> <settle-ms>` was expected")),
    };
    stream.set_read_timeout(None).unwrap_or_else(|error| fail(format!("the control connection: {error}")));
    (stream, reader, wall_origin, settle_within)
}

/// The next line; a closed or failed connection ends the process, the cause naming `when` (what the core was doing).
fn next_line(reader: &mut BufReader<TcpStream>, when: impl FnOnce() -> String) -> String {
    let mut line = String::new();
    let closed = |how: &str, when: String| -> ! {
        fail(format!("the replay closed the control connection ({how}) {when}: a core under a replay's clock does not run on its own"))
    };
    match reader.read_line(&mut line) {
        Ok(0) => closed("end of stream", when()),
        Ok(_) => line.trim_end_matches(['\r', '\n']).to_owned(),
        Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => closed(&error.to_string(), when()),
        Err(error) => fail(format!("the replay's control connection failed {}: {error}", when())),
    }
}

fn answer(stream: &mut TcpStream, line: &str) {
    if let Err(error) = writeln!(stream, "{line}") {
        fail(format!("answering the replay ({line:?}): {error}"));
    }
}

/// A paused `current_thread` runtime whose park hooks keep its busy flag (rows 8 and 9).
fn build(name: &'static str, rt: &'static str) -> io::Result<(Runtime, Arc<AtomicBool>)> {
    let busy = Arc::new(AtomicBool::new(true));
    let (parks, unparks) = (busy.clone(), busy.clone());
    let runtime = Builder::new_current_thread()
        .thread_name(name)
        .enable_all()
        .start_paused(true)
        .on_thread_park(move || {
            pause::point(|| format!("parking {rt}"));
            bump();
            pause::point(|| format!("parked {rt}"));
            parks.store(false, SeqCst);
            released();
        })
        .on_thread_unpark(move || {
            pause::point(|| format!("unparking {rt}"));
            unparks.store(true, SeqCst);
            pause::point(|| format!("unparked {rt}"));
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

/// Fires the next timer Node's `processTimers(V)` fires, if any is left.
fn fire_next(clock: &Clock) -> bool {
    let entry = lock(&clock.timers).take_due();
    entry.map(|entry| run(clock, entry)).is_some()
}

/// Sets V to `to` and moves both tokio clocks there, from a task on each runtime, then settles.
fn move_to(clock: &Clock, to: u64, during: &str) {
    lock(&clock.timers).now = to;
    clock.now.store(to, SeqCst);
    for runtime in &clock.runtimes {
        let at = runtime.origin.checked_add(Duration::from_millis(to)).unwrap_or_else(|| fail(format!("{during}: V {to} ms is past what {}'s clock holds", runtime.name)));
        drop(runtime.handle.spawn(async move {
            let now = tokio::time::Instant::now();
            if at > now {
                tokio::time::advance(at - now).await;
            }
        }));
    }
    settle(clock, during);
}

/// Runs Node's idle loop over `ms`: the wall clock it ends at, and the immediates still queued for the next turn.
fn advance(clock: &Clock, ms: u64) -> (u64, usize) {
    let during = format!("advance {ms}");
    let now = clock.now.load(SeqCst);
    let Some((target, wall)) = now.checked_add(ms).and_then(|target| Some((target, clock.wall_origin.checked_add(target)?))).filter(|(_, wall)| wall_holds(*wall)) else {
        fail(format!("{during}: wall-ms {} + V {now} + {ms} is past {} ms, the largest wall clock this core's readers hold", clock.wall_origin, max_wall_ms()))
    };
    let _turn = lock(&clock.turn);
    settle(clock, &during);
    owed_check_phase(clock, &during);
    // An idle Node loop over `ms`: a turn at each list's expiry, in order, and one at the target: the timers phase
    // (`processTimers`) fires what is due, then the check phase the immediates queued before it began. Immediates queued
    // by immediates wait for the next turn; the answer counts those left when the target's turn is done.
    loop {
        let next = lock(&clock.timers).queue.first().map(|&(expiry, _, _)| expiry).filter(|expiry| *expiry < target);
        let Some(expiry) = next else { break };
        if expiry > clock.now.load(SeqCst) {
            move_to(clock, expiry, &during);
        }
        timers_phase(clock, &during);
        check_phase(clock, &during);
    }
    if clock.now.load(SeqCst) < target {
        move_to(clock, target, &during);
    }
    timers_phase(clock, &during);
    check_phase(clock, &during);
    (wall, lock(&clock.immediates).len())
}

/// The check phase owed to immediates queued between commands (by real I/O, or by work an answer left waiting), if the check
/// driver has not run it yet; immediates queued by immediates wait for an advance's next turn.
fn owed_check_phase(clock: &Clock, during: &str) {
    let owed = {
        let _immediates = lock(&clock.immediates);
        clock.checks_owed.swap(false, SeqCst)
    };
    if owed {
        check_phase(clock, during);
    }
}

/// Node's timers phase at V (`processTimers`): every timer due, in Node's order, settling after each.
fn timers_phase(clock: &Clock, during: &str) {
    while fire_next(clock) {
        settle(clock, during);
    }
}

/// Node's check phase (`processImmediate`), from the settle point: fires the immediates queued before it began, oldest
/// first, settling after each; those they queue wait for the next loop turn.
fn check_phase(clock: &Clock, during: &str) {
    let queued = {
        let mut immediates = lock(&clock.immediates);
        // This phase serves every immediate queued so far: none is owed one any more.
        clock.checks_owed.store(false, SeqCst);
        clock.checking.store(true, SeqCst);
        std::mem::take(&mut *immediates)
    };
    for slot in queued {
        slot.fire();
        settle(clock, during);
    }
    clock.checking.store(false, SeqCst);
}

/// Runs the check phase of immediates queued between commands (by real I/O, or by work an answer left waiting on one) once the
/// core is idle, as Node's loop runs it after the poll phase that queued them.
fn drive_checks(clock: &'static Clock) {
    const DURING: &str = "the check phase between commands";
    loop {
        drop(
            clock
                .immediate_queued
                .wait_while(lock(&clock.immediates), |queued| queued.is_empty() || !clock.checks_owed.load(SeqCst))
                .unwrap_or_else(PoisonError::into_inner),
        );
        // Unbounded and without the turn: real work may run for as long as it takes; an advance meanwhile runs the owed phase.
        let _ = quiesce(clock, None);
        let _turn = lock(&clock.turn);
        settle(clock, DURING);
        owed_check_phase(clock, DURING);
    }
}

/// `within` from now on this machine's clock; a span it cannot hold ends the process.
fn real_deadline(within: Duration, during: &str) -> std::time::Instant {
    std::time::Instant::now().checked_add(within).unwrap_or_else(|| fail(format!("{during}: {} ms from now is past what this machine's clock holds", within.as_millis())))
}

/// What keeps the core from its settle point, if anything: the queues first, then the busy flags and the lanes (the invariant's
/// read order).
fn busy(clock: &Clock) -> Option<String> {
    let queued = clock.runtimes.each_ref().map(|runtime| runtime.handle.metrics().global_queue_depth());
    pause::point(|| "settle-read-queues".to_owned());
    let running = clock.runtimes.each_ref().map(|runtime| runtime.busy.load(SeqCst));
    let jobs = ACTIVITY.in_flight.load(SeqCst);
    for (at, runtime) in clock.runtimes.iter().enumerate() {
        if queued[at] > 0 {
            return Some(format!("{} has {} task(s) queued", runtime.name, queued[at]));
        }
        if running[at] {
            return Some(format!("{} is running a task", runtime.name));
        }
    }
    (jobs > 0).then(|| format!("{jobs} lane job(s) are queued or running"))
}

/// Waits for the settle point (the invariant above), within the replay's settle bound.
fn settle(clock: &Clock, during: &str) {
    let deadline = real_deadline(clock.settle_within, during);
    if let Err(busy) = quiesce(clock, Some(deadline)) {
        fail(format!("{during}: the core did not settle within {} ms: {busy}", clock.settle_within.as_millis()));
    }
}

/// Waits for the settle point, until `deadline` if any; `Err` with what kept the core busy when it passed.
fn quiesce(clock: &Clock, deadline: Option<std::time::Instant>) -> Result<(), String> {
    loop {
        let seen = ACTIVITY.epoch.load(SeqCst);
        let poked = pause::pokes();
        let busy = busy(clock);
        if busy.is_none() && ACTIVITY.epoch.load(SeqCst) == seen {
            return Ok(());
        }
        if let Some(busy) = &busy {
            pause::settle_waits(busy);
        }
        let guard = lock(&ACTIVITY.lock);
        let unchanged = |_: &mut ()| ACTIVITY.epoch.load(SeqCst) == seen && pause::pokes() == poked;
        match deadline {
            None => drop(ACTIVITY.changed.wait_while(guard, unchanged)),
            Some(deadline) => {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    return Err(busy.unwrap_or_else(|| "its activity never stopped".to_owned()));
                }
                drop(ACTIVITY.changed.wait_timeout_while(guard, left, unchanged));
            }
        }
    }
}

/// Test-only pause points: named places inside the transitions above where a test holds the thread that reaches them
/// (`tests/virtual_clock.rs`). With no point armed, a point is one atomic load.
#[doc(hidden)]
pub mod pause {
    use super::*;

    struct Gate {
        point: String,
        held: bool,
    }

    static ARMED: AtomicUsize = AtomicUsize::new(0);
    static GATES: Mutex<Vec<Gate>> = Mutex::new(Vec::new());
    static RELEASED: Condvar = Condvar::new();
    /// Moves when a point is armed or reached, so a waiting settle looks again (without moving the epoch).
    static POKES: AtomicU64 = AtomicU64::new(0);
    /// Whether the settle reported waiting since a point was last reached.
    static REPORTED: AtomicBool = AtomicBool::new(true);

    /// Arms `point`: the next thread that reaches it writes `pause held <point>` to stderr and stops until [`release`].
    pub fn hold(point: &str) {
        lock(&GATES).push(Gate { point: point.to_owned(), held: false });
        ARMED.fetch_add(1, SeqCst);
        eprintln!("pause armed {point}");
        poke();
    }

    /// Lets the thread held at `point` go, or disarms `point` if no thread reached it.
    pub fn release(point: &str) {
        let mut gates = lock(&GATES);
        if let Some(at) = gates.iter().position(|gate| gate.point == point) {
            gates.remove(at);
            ARMED.fetch_sub(1, SeqCst);
        }
        drop(gates);
        RELEASED.notify_all();
    }

    pub(crate) fn point(name: impl FnOnce() -> String) {
        if ARMED.load(SeqCst) == 0 {
            return;
        }
        let name = name();
        let mut gates = lock(&GATES);
        let Some(gate) = gates.iter_mut().find(|gate| gate.point == name && !gate.held) else { return };
        gate.held = true;
        eprintln!("pause held {name}");
        REPORTED.store(false, SeqCst);
        poke();
        while gates.iter().any(|gate| gate.point == name && gate.held) {
            gates = RELEASED.wait(gates).unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub(super) fn pokes() -> u64 {
        POKES.load(SeqCst)
    }

    /// The settle found `busy`: written once (`pause settle-waits <busy>`) after a point was reached.
    pub(super) fn settle_waits(busy: &str) {
        if ARMED.load(SeqCst) > 0 && !REPORTED.swap(true, SeqCst) {
            eprintln!("pause settle-waits {busy}");
        }
    }

    fn poke() {
        POKES.fetch_add(1, SeqCst);
        notify();
    }
}

/// The most kept lines a `missed` answer quotes.
const MISSED_QUOTES: usize = 20;

/// The number of the first line from the cursor on equal to `wanted`, within `within`; nothing is consumed. Past `within`, the
/// `missed` answer: the awaited line and the lines kept instead (the last [`MISSED_QUOTES`], with the count before them).
fn wait_log(clock: &Clock, within: Duration, wanted: &str) -> Result<u64, String> {
    let deadline = real_deadline(within, &format!("wait for {wanted:?}"));
    let mut log = lock(&clock.log);
    // Commands run one at a time, so the cursor stays put while this waits: lines already looked at need no second look.
    let mut looked = 0;
    loop {
        if let Some(at) = log.lines.iter().skip(looked).position(|line| line == wanted) {
            return Ok(log.first + (looked + at) as u64);
        }
        looked = log.lines.len();
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            let (first, kept) = (log.first, log.lines.len());
            let unquoted = kept.saturating_sub(MISSED_QUOTES);
            let quoted = log.lines.iter().skip(unquoted).map(|line| format!("{line:?}")).collect::<Vec<_>>().join(", ");
            return Err(match (kept, unquoted) {
                (0, _) => format!("missed {wanted:?}: no line logged from the cursor {first}"),
                (_, 0) => format!("missed {wanted:?}: from the cursor {first}, {kept} line(s): {quoted}"),
                _ => format!("missed {wanted:?}: from the cursor {first}, {kept} line(s), the last {MISSED_QUOTES}: {quoted}"),
            });
        }
        log = clock.logged.wait_timeout(log, left).unwrap_or_else(PoisonError::into_inner).0;
    }
}

/// Moves the cursor forward to `to`, dropping the lines before it.
fn move_cursor(clock: &Clock, to: u64) {
    let mut log = lock(&clock.log);
    let end = log.first + log.lines.len() as u64;
    if to < log.first || to > end {
        let first = log.first;
        drop(log);
        fail(format!("`cursor {to}`: the cursor is at {first} and {end} line(s) are logged; it moves forward, up to the lines logged"));
    }
    let skipped = usize::try_from(to - log.first).expect("at most the lines kept");
    log.lines.drain(..skipped);
    log.first = to;
}

enum Command {
    Advance(u64),
    Wait { within: u64, line: String },
    Cursor(u64),
}

fn parse(line: &str) -> Option<Command> {
    let (verb, rest) = line.split_once(' ')?;
    match verb {
        "advance" => wire_ms(rest, line).map(Command::Advance),
        "wait" => {
            let (within, wanted) = rest.split_once(' ')?;
            (!wanted.is_empty()).then_some(())?;
            Some(Command::Wait { within: wire_ms(within, line)?, line: wanted.to_owned() })
        }
        "cursor" => rest.parse().ok().map(Command::Cursor),
        _ => None,
    }
}

/// Reads the replay's commands as they come, on a thread of its own, so a closed connection or a malformed command ends the
/// process while another command blocks (an `advance` settling, a `wait` waiting).
fn read(clock: &'static Clock, mut reader: BufReader<TcpStream>, commands: &mpsc::Sender<Command>) {
    loop {
        let line = next_line(&mut reader, || match lock(&clock.unanswered).iter().map(|line| format!("`{line}`")).collect::<Vec<_>>() {
            unanswered if unanswered.is_empty() => "between commands".to_owned(),
            unanswered => format!("with {} unanswered", unanswered.join(", ")),
        });
        let command = parse(&line).unwrap_or_else(|| {
            fail(format!("the replay sent a malformed command {line:?}: the clock knows `advance <ms>`, `wait <deadline-ms> <line>` and `cursor <n>`"))
        });
        lock(&clock.unanswered).push_back(line);
        if commands.send(command).is_err() {
            return;
        }
    }
}

/// Runs the commands [`read`] passes on, one at a time, in order.
fn serve(clock: &'static Clock, commands: &mpsc::Receiver<Command>, mut stream: TcpStream) {
    for command in commands {
        let reply = match command {
            Command::Advance(ms) => match advance(clock, ms) {
                (wall, 0) => format!("now {wall}"),
                (wall, left) => format!("now {wall} immediates {left}"),
            },
            Command::Wait { within, line } => match wait_log(clock, Duration::from_millis(within), &line) {
                Ok(seen) => {
                    let during = format!("wait for {line:?}");
                    let _turn = lock(&clock.turn);
                    settle(clock, &during);
                    owed_check_phase(clock, &during);
                    format!("seen {seen}")
                }
                Err(missed) => missed,
            },
            Command::Cursor(to) => {
                move_cursor(clock, to);
                format!("cursor {to}")
            }
        };
        lock(&clock.unanswered).pop_front();
        answer(&mut stream, &reply);
    }
}
