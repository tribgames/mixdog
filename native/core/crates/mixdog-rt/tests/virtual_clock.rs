//! The replay's clock as a replay drives it (feature `virtual-clock`). Each test is the replay: it starts this test binary again
//! as the core (the `core` test, under [`ROLE`]), which boots the executors as `mixdogd` does (`exec::boot`) and connects to the
//! test's loopback listener. The core reports what it did as `node_log` lines (`event <name> <V>`), which the test reads from
//! its stderr in order and which the clock's `wait` sees. Every wait has one deadline and names what it waits for; a core ends
//! when its control connection closes, so no path leaves a process behind.
#![cfg(feature = "virtual-clock")]
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: the replay side starts the core as a child process and talks to it over std sockets")]

use std::io::BufRead;
use std::io::BufReader;
use std::io::ErrorKind;
use std::io::Lines;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::RtConfig;
use mixdog_rt::time;
use mixdog_rt::virtual_clock;

/// Which scenario the core process runs; unset in the test process itself.
const ROLE: &str = "MIXDOG_VIRTUAL_CLOCK_TEST_ROLE";
/// A second loopback address the core's real I/O goes to.
const IO: &str = "MIXDOG_VIRTUAL_CLOCK_TEST_IO";
/// A third loopback address, where the core takes `hold <point>` and `release <point>` lines for its pause points.
const GATES: &str = "MIXDOG_VIRTUAL_CLOCK_TEST_GATES";
/// The pause points a scenario arms from inside its work (comma-separated), where the test cannot time them from outside.
const HOLD: &str = "MIXDOG_VIRTUAL_CLOCK_TEST_HOLD";
const TOKEN: &str = "the-token-of-this-core";
/// 2031-01-01T00:00:00Z, the recorders' `CLOCK_START`.
const WALL: u64 = 1_924_992_000_000;
/// The one bound of every wait of a test.
const DEADLINE: Duration = Duration::from_secs(30);

// ── the core side ──

/// `event <name> <V>` through the Node log, which a replay's `wait` sees.
fn event(name: &str) {
    let v = virtual_clock::now_ms().expect("the replay's clock runs this core") - WALL as i64;
    mixdog_rt::node_stderr!("event {name} {v}");
}

fn after(name: &'static str, class: TaskClass, sleep: time::Sleep, then: impl FnOnce() + Send + 'static) {
    drop(mixdog_rt::spawn(name, class, async move {
        sleep.await;
        event(name);
        then();
    }));
}

fn ms(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

/// Arms every timer from this thread at V = 0, in this order; timers armed by a timer's task are armed at its due.
fn order() {
    after("a300", TaskClass::Work, time::sleep(ms(300)), || {});
    after("b100", TaskClass::Work, time::sleep(ms(100)), || {
        // Armed at 100 for 150: due at 250 with g250, after it.
        after("h150", TaskClass::Control, time::sleep(ms(150)), || {});
        drop(mixdog_rt::spawn("b100-zero", TaskClass::Work, async {
            // A zero delay is not queued: it runs inside b100's settle, before d100 fires.
            time::sleep(Duration::ZERO).await;
            event("b100-zero");
        }));
    });
    after("c200", TaskClass::Control, time::sleep(ms(200)), || after("k50", TaskClass::Work, time::sleep(ms(50)), || {}));
    after("d100", TaskClass::Control, time::sleep_until(time::Instant::now() + ms(100)), || after("j150", TaskClass::Work, time::sleep(ms(150)), || {}));
    let _ticker = mixdog_rt::ticker().register(std::time::Instant::now() + ms(100), || event("e100"));
    drop(mixdog_rt::spawn("f100", TaskClass::Work, {
        let timeout = time::timeout(ms(100), std::future::pending::<()>());
        async move {
            assert!(timeout.await.is_err(), "a pending future times out");
            event("f100");
        }
    }));
    after("g250", TaskClass::Work, time::sleep(ms(250)), || {});
    // Dropped before its due: never fires.
    drop(time::sleep(ms(100)));
    let cancelled = mixdog_rt::ticker().register(std::time::Instant::now() + ms(100), || event("cancelled"));
    assert!(cancelled.cancel(), "the deadline had not fired");
    // Node's own loop fires s90 first (its 90 ms list is queued before the re-queued 100 ms list); the recorders' queue and this
    // clock fire q100 first, armed 10 ms earlier.
    after("p10", TaskClass::Work, time::sleep(ms(10)), || after("q100", TaskClass::Work, time::sleep(ms(100)), || {}));
    after("r20", TaskClass::Control, time::sleep(ms(20)), || after("s90", TaskClass::Control, time::sleep(ms(90)), || {}));
    let mut interval = time::interval_at(time::Instant::now() + ms(50), ms(50));
    drop(mixdog_rt::spawn("interval", TaskClass::Work, async move {
        for _ in 0..3 {
            interval.tick().await;
            event("i");
        }
    }));
}

/// A timer on RT-C wakes a task on RT-W, which spawns back onto RT-C; a later timer starts a lane job whose result a task awaits.
/// The job waits for a line on the test's I/O connection. A tokio timer armed directly fires at the first stop after its due.
fn hops(tokens: LaneTokens) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    after("hop-c", TaskClass::Control, time::sleep(Duration::from_millis(100)), move || tx.send(()).expect("hop-w listens"));
    drop(mixdog_rt::spawn("hop-w", TaskClass::Work, async move {
        rx.recv().await.expect("hop-c sends");
        event("hop-w");
        drop(mixdog_rt::spawn("hop-back", TaskClass::Control, async { event("hop-back") }));
    }));
    drop(mixdog_rt::spawn("tokio30", TaskClass::Work, async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        event("tokio30");
    }));
    let io: SocketAddr = std::env::var(IO).expect("the I/O address").parse().expect("ip:port");
    drop(mixdog_rt::spawn("job", TaskClass::Work, async move {
        time::sleep(Duration::from_millis(200)).await;
        event("job-submit");
        let job = tokens.interactive_io.submit(&CancellationToken::new(), move |_| {
            event("job-start");
            let stream = TcpStream::connect(io).expect("the test's I/O listener");
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).expect("the test's release line");
            event("job-end");
            line
        });
        let line = job.expect("the lane takes the job").await.expect("the job runs");
        assert_eq!(line, "go\n");
        event("job-result");
    }));
}

/// A task waits for real I/O while the clock stands still, then arms a timer.
fn io() {
    let io: SocketAddr = std::env::var(IO).expect("the I/O address").parse().expect("ip:port");
    drop(mixdog_rt::spawn("io", TaskClass::Work, async move {
        let stream = tokio::net::TcpStream::connect(io).await.expect("the test's I/O listener");
        let mut buf = [0u8; 16];
        loop {
            stream.readable().await.expect("readable");
            match stream.try_read(&mut buf) {
                Ok(n) if n > 0 => break,
                Ok(_) => panic!("the test closed the I/O connection"),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("reading the I/O connection: {error}"),
            }
        }
        event("io-read");
        time::sleep(Duration::from_millis(50)).await;
        event("io-timer");
    }));
}

/// A timer starts a lane job that never ends.
fn stuck(tokens: LaneTokens) {
    drop(mixdog_rt::spawn("stuck", TaskClass::Work, async move {
        time::sleep(Duration::from_millis(100)).await;
        let (keep, never) = mpsc::channel::<()>();
        std::mem::forget(keep);
        let job = tokens.cpu_bulk.submit(&CancellationToken::new(), move |_| never.recv());
        let _ = job.expect("the lane takes the job").await;
    }));
}

/// Arms the pause points [`HOLD`] names, from inside the work they are to catch.
fn hold_here() {
    for point in std::env::var(HOLD).unwrap_or_default().split(',').filter(|point| !point.is_empty()) {
        virtual_clock::pause::hold(point);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Job {
    /// Spawns a task on RT-C.
    Spawning,
    /// Touches nothing but its result.
    Plain,
    /// Cancelled before it is queued: dropped unrun at dequeue.
    Cancelled,
}

/// A timer at 100 starts a lane job; the submitting task on RT-W awaits the job's result and then the task it spawned.
fn lane(tokens: LaneTokens, kind: Job) {
    drop(mixdog_rt::spawn("submitter", TaskClass::Work, async move {
        time::sleep(ms(100)).await;
        let cancel = CancellationToken::new();
        if kind == Job::Cancelled {
            cancel.cancel();
        }
        let job = tokens.interactive_io.submit(&cancel, move |_| {
            (kind == Job::Spawning).then(|| mixdog_rt::spawn("from-lane", TaskClass::Control, async { event("from-lane") }))
        });
        match job.expect("the lane takes the job").await {
            Ok(spawned) => {
                if let Some(spawned) = spawned {
                    spawned.await.expect("the lane's task runs");
                }
                event("job-result");
            }
            Err(_) => event("job-dropped"),
        }
    }));
}

/// A timer at 100 on RT-C wakes a task on RT-W; the points in [`HOLD`] are armed just before the wake.
fn runtimes() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    drop(mixdog_rt::spawn("hop-w", TaskClass::Work, async move {
        rx.recv().await.expect("hop-c sends");
        event("hop-w");
    }));
    drop(mixdog_rt::spawn("hop-c", TaskClass::Control, async move {
        time::sleep(ms(100)).await;
        hold_here();
        tx.send(()).expect("hop-w listens");
    }));
}

/// A tokio timer, fired when the clock moves RT-W's tokio clock, starts work that stays on RT-W: a spawned task that yields
/// (deferred wakes) and then wakes a third task through a channel, and the timer's task awaits both `JoinHandle`s. The points
/// in [`HOLD`] are armed first.
fn same_runtime() {
    drop(mixdog_rt::spawn("chain", TaskClass::Work, async {
        tokio::time::sleep(ms(100)).await;
        hold_here();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let yielder = mixdog_rt::spawn("yielder", TaskClass::Work, async move {
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            tx.send(()).expect("rx listens");
        });
        let receiver = mixdog_rt::spawn("rx", TaskClass::Work, async move {
            rx.await.expect("the yielder sends");
            event("rx");
        });
        yielder.await.expect("the yielder runs");
        receiver.await.expect("rx runs");
        event("chain");
    }));
}

/// A task on RT-W waits for real I/O; the points in [`HOLD`] are armed before it waits.
fn io_wake() {
    let io: SocketAddr = std::env::var(IO).expect("the I/O address").parse().expect("ip:port");
    drop(mixdog_rt::spawn("io", TaskClass::Work, async move {
        let stream = tokio::net::TcpStream::connect(io).await.expect("the test's I/O listener");
        hold_here();
        read_some(&stream).await;
        event("io-read");
    }));
}

async fn read_some(stream: &tokio::net::TcpStream) {
    let mut buf = [0u8; 16];
    loop {
        stream.readable().await.expect("readable");
        match stream.try_read(&mut buf) {
            Ok(n) if n > 0 => return,
            Ok(_) => panic!("the test closed the I/O connection"),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("reading the I/O connection: {error}"),
        }
    }
}

/// A thread of its own (real I/O to the clock) waits for a line from the test and then wakes a task on RT-W; the points in
/// [`HOLD`] are armed before it waits.
fn thread_wake() {
    let io: SocketAddr = std::env::var(IO).expect("the I/O address").parse().expect("ip:port");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    drop(mixdog_rt::spawn("woken", TaskClass::Work, async move {
        rx.recv().await.expect("the thread sends");
        event("woken");
    }));
    std::thread::spawn(move || {
        let stream = TcpStream::connect(io).expect("the test's I/O listener");
        hold_here();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).expect("the test's line");
        tx.send(()).expect("woken listens");
    });
}

/// Takes `hold <point>` and `release <point>` lines from the test's gate listener, when the test gave one.
fn gates() {
    let Ok(address) = std::env::var(GATES) else { return };
    let stream = TcpStream::connect(address).expect("the test's gate listener");
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            match line.split_once(' ') {
                Some(("hold", point)) => virtual_clock::pause::hold(point),
                Some(("release", point)) => virtual_clock::pause::release(point),
                _ => panic!("the test sent the gate command {line:?}"),
            }
        }
    });
}

/// The core process: boots the executors under the replay's clock and runs its scenario. The replay ends it by closing the
/// clock's connection.
#[test]
fn core() {
    let Ok(role) = std::env::var(ROLE) else { return };
    let (_executors, tokens) = mixdog_rt::exec::boot(RtConfig::for_cores(4)).expect("the executors");
    gates();
    match role.as_str() {
        "order" => order(),
        "hops" => hops(tokens),
        "io" => io(),
        "stuck" => stuck(tokens),
        "lane" => lane(tokens, Job::Spawning),
        "lane-plain" => lane(tokens, Job::Plain),
        "lane-cancelled" => lane(tokens, Job::Cancelled),
        "runtimes" => runtimes(),
        "same-runtime" => same_runtime(),
        "io-wake" => io_wake(),
        "thread-wake" => thread_wake(),
        _ => {}
    }
    event("ready");
    loop {
        std::thread::park();
    }
}

// ── the replay side ──

/// A core process: its stderr lines and its exit code, each read by a thread of its own.
struct Core {
    pid: u32,
    lines: mpsc::Receiver<String>,
    exited: mpsc::Receiver<Option<i32>>,
}

fn launch(role: &str, address: &str, env: &[(&str, String)]) -> Core {
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["core", "--exact", "--nocapture", "--test-threads=1"])
        .env(ROLE, role)
        .env(virtual_clock::ENV, address)
        .env(virtual_clock::TOKEN_ENV, TOKEN)
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().expect("the core process");
    let pid = child.id();
    let stderr = child.stderr.take().expect("piped stderr");
    let (line_tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let (exit_tx, exited) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = exit_tx.send(child.wait().ok().and_then(|status| status.code()));
    });
    Core { pid, lines, exited }
}

impl Core {
    /// The next stderr line, within the deadline.
    fn line(&self, after: &[String]) -> String {
        self.lines.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core wrote {after:?} and no further line within {DEADLINE:?}"))
    }

    /// The next `event` line, without its `event ` prefix; pause lines are passed over.
    fn event(&self) -> String {
        self.events(1).remove(0)
    }

    /// The next `n` events, each read within the deadline; pause lines are passed over.
    fn events(&self, n: usize) -> Vec<String> {
        let mut events = Vec::new();
        while events.len() < n {
            let line = self.line(&events);
            if line.starts_with("pause ") {
                continue;
            }
            events.push(line.strip_prefix("event ").unwrap_or_else(|| panic!("the core wrote {line:?} after {events:?}")).to_owned());
        }
        events
    }

    /// The first line `matches` takes, and the lines before it.
    fn until(&self, what: &str, matches: impl Fn(&str) -> bool) -> (String, Vec<String>) {
        let mut before = Vec::new();
        loop {
            let line = self.lines.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core wrote {before:?} and not {what} within {DEADLINE:?}"));
            if matches(&line) {
                return (line, before);
            }
            before.push(line);
        }
    }

    /// The lines up to `line`.
    fn until_line(&self, line: &str) -> Vec<String> {
        self.until(line, |seen| seen == line).1
    }

    /// The next `pause settle-waits <busy>` line's `<busy>`.
    fn settle_waits(&self) -> String {
        let (line, _) = self.until("a settle that waits", |line| line.starts_with("pause settle-waits "));
        line["pause settle-waits ".len()..].to_owned()
    }

    /// The exit code once the process has ended, and everything it wrote to stderr after the events already read.
    fn ended(self) -> (Option<i32>, String) {
        let code = self.exited.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core did not exit within {DEADLINE:?}"));
        let mut rest = Vec::new();
        loop {
            match self.lines.recv_timeout(DEADLINE) {
                Ok(line) => rest.push(line),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("the core's stderr did not close within {DEADLINE:?} of its exit"),
            }
        }
        (code, rest.join("\n"))
    }
}

/// Accepts one connection on `listener` within the deadline.
fn accept(listener: TcpListener, what: &'static str) -> TcpStream {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(listener.accept().map(|(stream, _)| stream));
    });
    rx.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("{what} did not connect within {DEADLINE:?}")).expect(what)
}

/// The replay's end of the clock's connection.
struct Control {
    lines: Lines<BufReader<TcpStream>>,
    stream: TcpStream,
}

impl Control {
    fn line(&mut self, after: &str) -> String {
        match self.lines.next() {
            Some(Ok(line)) => line,
            Some(Err(error)) => panic!("no line from the core within {DEADLINE:?} after {after}: {error}"),
            None => panic!("the core closed the clock's connection after {after}"),
        }
    }

    fn send(&mut self, command: &str) {
        writeln!(self.stream, "{command}").unwrap_or_else(|error| panic!("sending {command:?}: {error}"));
    }

    fn ask(&mut self, command: &str) -> String {
        self.send(command);
        self.line(command)
    }

    /// Fails if the core has answered: a settle that waits cannot answer, so this sees no byte.
    fn unanswered(&mut self, during: &str) {
        self.stream.set_nonblocking(true).expect("non-blocking");
        let mut byte = [0u8; 1];
        assert_eq!(self.stream.peek(&mut byte).map_err(|error| error.kind()), Err(ErrorKind::WouldBlock), "the core answered while {during} was held");
        self.stream.set_nonblocking(false).expect("blocking");
    }

    /// `advance <ms>`, and the V it answers.
    fn advance(&mut self, ms: u64) -> u64 {
        let answer = self.ask(&format!("advance {ms}"));
        let wall: u64 = answer.strip_prefix("now ").and_then(|ms| ms.parse().ok()).unwrap_or_else(|| panic!("advance {ms} answered {answer:?}"));
        wall - WALL
    }
}

/// Binds the clock's listener, starts the core and takes its `hello`.
fn handshake(role: &str, env: &[(&str, String)]) -> (Core, Control) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let core = launch(role, &listener.local_addr().expect("address").to_string(), env);
    let stream = accept(listener, "the core's clock");
    stream.set_read_timeout(Some(DEADLINE)).expect("a read deadline");
    let mut control = Control { lines: BufReader::new(stream.try_clone().expect("stream")).lines(), stream };
    assert_eq!(control.line("connecting"), format!("hello {}", core.pid));
    (core, control)
}

/// [`handshake`], `start`, and the core's `ready`.
fn started(role: &str, env: &[(&str, String)], settle_ms: u64) -> (Core, Control) {
    let (core, mut control) = handshake(role, env);
    assert_eq!(control.ask(&format!("start {TOKEN} {WALL} {settle_ms}")), format!("now {WALL}"));
    assert_eq!(core.event(), "ready 0");
    (core, control)
}

fn io_env(io: &TcpListener) -> (&'static str, String) {
    (IO, io.local_addr().expect("address").to_string())
}

/// The test's end of the core's pause points.
struct Gates(TcpStream);

impl Gates {
    /// Arms `point` and waits until the core says it is armed.
    fn hold(&mut self, core: &Core, point: &str) {
        writeln!(self.0, "hold {point}").unwrap_or_else(|error| panic!("arming {point}: {error}"));
        core.until_line(&format!("pause armed {point}"));
    }

    fn release(&mut self, point: &str) {
        writeln!(self.0, "release {point}").unwrap_or_else(|error| panic!("releasing {point}: {error}"));
    }
}

/// [`started`] with the core's pause points on a gate connection; `hold` is armed by the scenario itself ([`HOLD`]).
fn gated(role: &str, env: &[(&str, String)], hold: &str) -> (Core, Control, Gates) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let mut env = env.to_vec();
    env.push((GATES, listener.local_addr().expect("address").to_string()));
    env.push((HOLD, hold.to_owned()));
    let (core, mut control) = handshake(role, &env);
    assert_eq!(control.ask(&format!("start {TOKEN} {WALL} 30000")), format!("now {WALL}"));
    let gates = Gates(accept(listener, "the core's gate thread"));
    assert_eq!(core.event(), "ready 0");
    (core, control, gates)
}

/// With `advance <ms>` sent and `point` about to be held: the advance waits while the point is held, then answers, with `last`
/// logged before its answer. Returns what the core wrote before the point was held.
fn held_through(core: &Core, control: &mut Control, gates: &mut Gates, point: &str, ms: u64, last: &str) -> Vec<String> {
    let before = core.until_line(&format!("pause held {point}"));
    core.settle_waits();
    control.unanswered(point);
    gates.release(point);
    assert_eq!(control.line(point), format!("now {}", WALL + ms), "the answer after {point}");
    let name = last.rsplit_once(' ').map_or(last, |(name, _)| name);
    assert_eq!(control.ask(&format!("wait 0 {name}")), format!("seen {last}"), "logged before the answer after {point}");
    before
}

#[test]
fn an_advance_waits_for_a_lane_job_held_at_each_transition() {
    for point in ["lane-queued", "lane-start", "spawned from-lane", "polled from-lane", "lane-sent", "lane-bumped"] {
        let (core, mut control, mut gates) = gated("lane", &[], "");
        gates.hold(&core, point);
        control.send("advance 100");
        held_through(&core, &mut control, &mut gates, point, 100, "event job-result 100");
    }
}

#[test]
fn an_advance_waits_for_a_lane_job_dropped_unrun() {
    for point in ["lane-queued", "lane-sent", "lane-bumped"] {
        let (core, mut control, mut gates) = gated("lane-cancelled", &[], "");
        gates.hold(&core, point);
        control.send("advance 100");
        held_through(&core, &mut control, &mut gates, point, 100, "event job-dropped 100");
    }
}

#[test]
fn an_advance_waits_for_a_hop_between_the_runtimes_held_at_each_transition() {
    for point in ["polled hop-c", "parking RT-C", "parked RT-C", "unparking RT-W", "unparked RT-W"] {
        let (core, mut control, mut gates) = gated("runtimes", &[], point);
        control.send("advance 100");
        held_through(&core, &mut control, &mut gates, point, 100, "event hop-w 100");
    }
}

#[test]
fn work_that_stays_on_one_runtime_runs_before_the_runtime_parks() {
    let (core, mut control, mut gates) = gated("same-runtime", &[], "parking RT-W");
    control.send("advance 100");
    let before = held_through(&core, &mut control, &mut gates, "parking RT-W", 100, "event chain 100");
    let events: Vec<&String> = before.iter().filter(|line| line.starts_with("event ")).collect();
    assert_eq!(events, ["event rx 100", "event chain 100"], "logged before RT-W parked");
}

#[test]
fn an_io_completion_counts_from_its_runtimes_unpark_hook_on() {
    let io = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let (core, mut control, mut gates) = gated("io-wake", &[io_env(&io)], "unparked RT-W");
    let mut peer = accept(io, "the core's I/O task");
    core.until_line("pause armed unparked RT-W");
    peer.write_all(b"ping").expect("the I/O bytes");
    core.until_line("pause held unparked RT-W");
    control.send("advance 1");
    core.settle_waits();
    control.unanswered("unparked RT-W");
    gates.release("unparked RT-W");
    assert_eq!(control.line("advance 1"), format!("now {}", WALL + 1));
    assert_eq!(control.ask("wait 0 event io-read"), "seen event io-read 0");
}

#[test]
fn a_wake_from_a_thread_of_its_own_counts_from_its_push_on() {
    let io = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let (core, mut control, mut gates) = gated("thread-wake", &[io_env(&io)], "unparking RT-W");
    let mut peer = accept(io, "the core's thread");
    core.until_line("pause armed unparking RT-W");
    peer.write_all(b"go\n").expect("the thread's line");
    core.until_line("pause held unparking RT-W");
    control.send("advance 1");
    core.settle_waits();
    control.unanswered("unparking RT-W");
    gates.release("unparking RT-W");
    assert_eq!(control.line("advance 1"), format!("now {}", WALL + 1));
    assert_eq!(control.ask("wait 0 event woken"), "seen event woken 0");
}

/// The second review's interleaving: settle reads the queues (RT-W's is empty), a lane job then queues its waiter on RT-W,
/// leaves the in-flight count, and settle reads the flags and the count while RT-W has not yet set its busy flag. The epoch
/// moved before the count dropped, so this settle looks again and finds the waiter queued.
#[test]
fn the_reviewers_interleaving() {
    // A job that wakes nothing but its waiter: no other runtime activity moves the epoch.
    let (core, mut control, mut gates) = gated("lane-plain", &[], "");
    gates.hold(&core, "lane-start");
    control.send("advance 100");
    core.until_line("pause held lane-start");
    core.settle_waits();
    gates.hold(&core, "settle-read-queues");
    core.until_line("pause held settle-read-queues");
    gates.hold(&core, "unparking RT-W");
    gates.hold(&core, "lane-released");
    gates.release("lane-start");
    let both = |line: &str| line == "pause held unparking RT-W" || line == "pause held lane-released";
    let (first, _) = core.until("RT-W or the lane held", both);
    let (second, _) = core.until("the other of RT-W and the lane held", both);
    assert_ne!(first, second);
    // RT-W's queue holds the waiter, its flag is clear, and the lane has left the count: settle's read goes on.
    gates.release("settle-read-queues");
    assert_eq!(core.settle_waits(), "RT-W has 1 task(s) queued");
    control.unanswered("RT-W's unpark hook");
    gates.release("unparking RT-W");
    gates.release("lane-released");
    assert_eq!(control.line("advance 100"), format!("now {}", WALL + 100));
    assert_eq!(control.ask("wait 0 event job-result"), "seen event job-result 100");
}

fn ended_by_the_clock(core: Core, cause: &str) {
    let (code, stderr) = core.ended();
    assert_eq!(code, Some(virtual_clock::EXIT_CODE), "the core's stderr: {stderr}");
    assert!(stderr.contains(&format!("mixdog virtual clock: {cause}")), "the core's stderr names {cause:?}: {stderr}");
}

#[test]
fn timers_fire_in_due_then_arming_order_across_runtimes_with_v_at_each_due() {
    let (core, mut control) = started("order", &[], 30_000);
    let mut steps: Vec<(u64, Vec<&str>)> = vec![
        (9, vec![]),
        (10, vec!["p10 10"]),
        (20, vec!["r20 20"]),
        (50, vec!["i 50"]),
        (100, vec!["b100 100", "b100-zero 100", "d100 100", "e100 100", "f100 100", "i 100"]),
        (110, vec!["q100 110", "s90 110"]),
        (150, vec!["i 150"]),
        (199, vec![]),
        // One advance over two instants: V is each timer's due as it fires.
        (300, vec!["c200 200", "g250 250", "h150 250", "j150 250", "k50 250", "a300 300"]),
        (10_000, vec![]),
    ];
    let mut at = 0;
    for (to, expected) in steps.drain(..) {
        assert_eq!(control.advance(to - at), to);
        at = to;
        assert_eq!(core.events(expected.len()), expected, "the events up to V = {to}");
    }
    drop(control);
    let (code, rest) = core.ended();
    assert_eq!(code, Some(virtual_clock::EXIT_CODE));
    assert!(!rest.contains("event "), "no event after the last expected one: {rest}");
}

#[test]
fn advance_answers_after_the_cross_runtime_hops_and_lane_jobs_its_timers_started() {
    let io = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let (core, mut control) = started("hops", &[io_env(&io)], 30_000);
    control.send("advance 200");
    assert_eq!(core.events(5), ["tokio30 100", "hop-c 100", "hop-w 100", "hop-back 100", "job-submit 200"]);
    let mut release = accept(io, "the lane job");
    assert_eq!(core.event(), "job-start 200");
    // The job is running: the clock has not answered.
    control.stream.set_nonblocking(true).expect("non-blocking");
    let mut byte = [0u8; 1];
    assert_eq!(control.stream.peek(&mut byte).map_err(|error| error.kind()), Err(ErrorKind::WouldBlock), "advance answered while its lane job ran");
    control.stream.set_nonblocking(false).expect("blocking");
    release.write_all(b"go\n").expect("the release line");
    assert_eq!(control.line("advance 200"), format!("now {}", WALL + 200));
    // Logged before the answer: a `wait` with no time left sees it.
    assert_eq!(control.ask("wait 0 event job-result"), "seen event job-result 200");
    assert_eq!(core.events(2), ["job-end 200", "job-result 200"]);
}

#[test]
fn io_completes_while_the_clock_stands_still_and_wait_sees_its_log_line() {
    let io = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let (core, mut control) = started("io", &[io_env(&io)], 30_000);
    let mut peer = accept(io, "the core's I/O task");
    peer.write_all(b"ping").expect("the I/O line");
    assert_eq!(control.ask(&format!("wait {} event io-read", DEADLINE.as_millis())), "seen event io-read 0");
    assert_eq!(control.advance(49), 49);
    assert_eq!(control.ask("wait 0 event io-timer"), "missed event io-timer");
    assert_eq!(control.advance(1), 50);
    assert_eq!(control.ask("wait 0 event io-timer"), "seen event io-timer 50");
    assert_eq!(core.events(2), ["io-read 0", "io-timer 50"]);
}

#[test]
fn a_closed_control_connection_ends_the_core() {
    let (core, control) = started("idle", &[], 30_000);
    drop(control);
    ended_by_the_clock(core, "the replay closed the control connection");
}

#[test]
fn a_malformed_command_ends_the_core() {
    let (core, mut control) = started("idle", &[], 30_000);
    control.send("advance soon");
    ended_by_the_clock(core, "the replay sent a malformed command \"advance soon\"");
}

#[test]
fn a_start_with_another_token_ends_the_core() {
    let (core, mut control) = handshake("idle", &[]);
    control.send(&format!("start not-{TOKEN} {WALL} 30000"));
    ended_by_the_clock(core, "the replay's `start` carries a token that is not this core's");
}

#[test]
fn a_non_loopback_address_ends_the_core() {
    let core = launch("idle", "192.0.2.1:9", &[]);
    ended_by_the_clock(core, "MIXDOG_VIRTUAL_CLOCK=192.0.2.1:9 is not a loopback address");
}

#[test]
fn an_advance_that_does_not_settle_within_the_bound_ends_the_core() {
    let (core, mut control) = started("stuck", &[], 500);
    control.send("advance 100");
    ended_by_the_clock(core, "advance 100: the core did not settle within 500 ms: 1 lane job(s) are queued or running");
}
