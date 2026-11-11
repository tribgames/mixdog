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

/// The core process: boots the executors under the replay's clock and runs its scenario. The replay ends it by closing the
/// clock's connection.
#[test]
fn core() {
    let Ok(role) = std::env::var(ROLE) else { return };
    let (_executors, tokens) = mixdog_rt::exec::boot(RtConfig::for_cores(4)).expect("the executors");
    match role.as_str() {
        "order" => order(),
        "hops" => hops(tokens),
        "io" => io(),
        "stuck" => stuck(tokens),
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

fn launch(role: &str, address: &str, io: Option<SocketAddr>) -> Core {
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["core", "--exact", "--nocapture", "--test-threads=1"])
        .env(ROLE, role)
        .env(virtual_clock::ENV, address)
        .env(virtual_clock::TOKEN_ENV, TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(io) = io {
        command.env(IO, io.to_string());
    }
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
    /// The next `event` line, without its `event ` prefix.
    fn event(&self) -> String {
        let line = self.lines.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core logged no further event within {DEADLINE:?}"));
        line.strip_prefix("event ").unwrap_or_else(|| panic!("the core wrote {line:?} where an event was expected")).to_owned()
    }

    /// The next `n` events, each read within the deadline.
    fn events(&self, n: usize) -> Vec<String> {
        let mut events = Vec::new();
        for _ in 0..n {
            match self.lines.recv_timeout(DEADLINE) {
                Ok(line) => events.push(line.strip_prefix("event ").unwrap_or_else(|| panic!("the core wrote {line:?} after {events:?}")).to_owned()),
                Err(_) => panic!("the core logged {events:?} and no further event within {DEADLINE:?}"),
            }
        }
        events
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

    /// `advance <ms>`, and the V it answers.
    fn advance(&mut self, ms: u64) -> u64 {
        let answer = self.ask(&format!("advance {ms}"));
        let wall: u64 = answer.strip_prefix("now ").and_then(|ms| ms.parse().ok()).unwrap_or_else(|| panic!("advance {ms} answered {answer:?}"));
        wall - WALL
    }
}

/// Binds the clock's listener, starts the core and takes its `hello`.
fn handshake(role: &str, io: Option<SocketAddr>) -> (Core, Control) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let core = launch(role, &listener.local_addr().expect("address").to_string(), io);
    let stream = accept(listener, "the core's clock");
    stream.set_read_timeout(Some(DEADLINE)).expect("a read deadline");
    let mut control = Control { lines: BufReader::new(stream.try_clone().expect("stream")).lines(), stream };
    assert_eq!(control.line("connecting"), format!("hello {}", core.pid));
    (core, control)
}

/// [`handshake`], `start`, and the core's `ready`.
fn started(role: &str, io: Option<SocketAddr>, settle_ms: u64) -> (Core, Control) {
    let (core, mut control) = handshake(role, io);
    assert_eq!(control.ask(&format!("start {TOKEN} {WALL} {settle_ms}")), format!("now {WALL}"));
    assert_eq!(core.event(), "ready 0");
    (core, control)
}

fn ended_by_the_clock(core: Core, cause: &str) {
    let (code, stderr) = core.ended();
    assert_eq!(code, Some(virtual_clock::EXIT_CODE), "the core's stderr: {stderr}");
    assert!(stderr.contains(&format!("mixdog virtual clock: {cause}")), "the core's stderr names {cause:?}: {stderr}");
}

#[test]
fn timers_fire_in_due_then_arming_order_across_runtimes_with_v_at_each_due() {
    let (core, mut control) = started("order", None, 30_000);
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
    let (core, mut control) = started("hops", Some(io.local_addr().expect("address")), 30_000);
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
    let (core, mut control) = started("io", Some(io.local_addr().expect("address")), 30_000);
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
    let (core, control) = started("idle", None, 30_000);
    drop(control);
    ended_by_the_clock(core, "the replay closed the control connection");
}

#[test]
fn a_malformed_command_ends_the_core() {
    let (core, mut control) = started("idle", None, 30_000);
    control.send("advance soon");
    ended_by_the_clock(core, "the replay sent a malformed command \"advance soon\"");
}

#[test]
fn a_start_with_another_token_ends_the_core() {
    let (core, mut control) = handshake("idle", None);
    control.send(&format!("start not-{TOKEN} {WALL} 30000"));
    ended_by_the_clock(core, "the replay's `start` carries a token that is not this core's");
}

#[test]
fn a_non_loopback_address_ends_the_core() {
    let core = launch("idle", "192.0.2.1:9", None);
    ended_by_the_clock(core, "MIXDOG_VIRTUAL_CLOCK=192.0.2.1:9 is not a loopback address");
}

#[test]
fn an_advance_that_does_not_settle_within_the_bound_ends_the_core() {
    let (core, mut control) = started("stuck", None, 500);
    control.send("advance 100");
    ended_by_the_clock(core, "advance 100: the core did not settle within 500 ms: 1 lane job(s) are queued or running");
}
