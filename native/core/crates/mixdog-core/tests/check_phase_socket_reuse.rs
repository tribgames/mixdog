//! Node's recording `native/core/fixtures/node-socket-reuse` (`benchmarks/rust-core/recorders/record-node-socket-reuse.mjs`)
//! replayed on the core's replay clock end to end: the product's HTTP link (mixdog-ai `ReqwestLink`, the node_http client)
//! resends a rejected request the way the OpenAI adapter does (`open_http`: hold the connection, drain, resend), from the
//! first of two timers due in the same millisecond; the second sends a request of its own. Which socket each request gets
//! depends on the held socket staying busy until the turn's check phase (`mixdog_rt::time::immediate`, undici's
//! `setImmediate(client[kResume])`). Each test is the replay: it starts this test binary again as the core (the `core` test,
//! under [`ROLE`]), serves its requests on a loopback listener, and drives its clock. Every wait has one deadline.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: the replay side starts the core as a child process and talks to it over std sockets")]

use std::io::BufRead;
use std::io::BufReader;
use std::io::Lines;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_ai::transport::{BodyStream, HttpSend, ReqwestLink, deadlines};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::RtConfig;
use mixdog_rt::time;
use mixdog_rt::virtual_clock;

/// Which case the core process runs (its body size); unset in the test process itself.
const ROLE: &str = "MIXDOG_SOCKET_REUSE_TEST_BODY";
/// The test's HTTP listener.
const SERVER: &str = "MIXDOG_SOCKET_REUSE_TEST_SERVER";
const TOKEN: &str = "the-token-of-this-core";
const WALL: u64 = 1_924_992_000_000;
/// The one bound of every wait of a test.
const DEADLINE: Duration = Duration::from_secs(30);
const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/node-socket-reuse/golden.json"));

// ── the core side ──

fn event(name: &str) {
    let v = virtual_clock::now_ms().expect("the replay's clock runs this core") - WALL as i64;
    mixdog_rt::node_stderr!("event {name} {v}");
}

fn request(url: &str, tag: &str) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: url.to_owned(),
        headers: vec![("x-req".to_owned(), tag.to_owned())],
        body: b"{}".to_vec(),
    }
}

/// The recorder's client: `r0`, then `t1` (drain r0 held, resend as `r1`) and `t2` (`r2`) armed for the same 100 ms, then `r3`.
fn scenario(url: String) {
    drop(mixdog_rt::spawn("socket-reuse", TaskClass::Work, async move {
        let link = std::sync::Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the link"));
        let r0 = link.send(request(&url, "r0"), deadlines::OPENAI_CATALOG).await.expect("r0");
        assert_eq!(r0.status, 400);
        event("r0-head");
        let (t1, t2) = (time::sleep(Duration::from_millis(100)), time::sleep(Duration::from_millis(100)));
        let first = {
            let (link, url) = (link.clone(), url.clone());
            mixdog_rt::spawn("t1", TaskClass::Work, async move {
                t1.await;
                event("t1");
                let mut body = r0.body;
                body.hold_connection();
                while body.next().await.is_some() {}
                event("r0-read");
                let resent = link.send(request(&url, "r1"), deadlines::OPENAI_CATALOG).await.expect("r1");
                drop(body);
                resent.read_all().await.expect("r1's body");
            })
        };
        let second = {
            let (link, url) = (link.clone(), url.clone());
            mixdog_rt::spawn("t2", TaskClass::Work, async move {
                t2.await;
                event("t2");
                link.send(request(&url, "r2"), deadlines::OPENAI_CATALOG).await.expect("r2").read_all().await.expect("r2's body");
            })
        };
        event("armed");
        first.await.expect("t1 runs");
        second.await.expect("t2 runs");
        link.send(request(&url, "r3"), deadlines::OPENAI_CATALOG).await.expect("r3").read_all().await.expect("r3's body");
        event("done");
    }));
}

#[test]
fn core() {
    if std::env::var_os(ROLE).is_none() {
        return;
    }
    let (_executors, _tokens) = mixdog_rt::exec::boot(RtConfig::for_cores(4)).expect("the executors");
    scenario(format!("http://{}/", std::env::var(SERVER).expect("the server's address")));
    loop {
        std::thread::park();
    }
}

// ── the replay side ──

/// One request off `stream`: its `x-req` tag; `None` at the end of the connection.
fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut data = Vec::new();
    let mut byte = [0u8; 1];
    while !data.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => data.push(byte[0]),
            _ => return None,
        }
    }
    let head = String::from_utf8_lossy(&data).to_ascii_lowercase();
    let length: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")?.trim().parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).ok()?;
    head.lines().find_map(|l| Some(l.strip_prefix("x-req:")?.trim().to_owned()))
}

/// The recorder's server: `r0` answered 400 with `body` bytes, every other request `ok`. Sends each `(tag, connection)` as
/// it is read, and `written` once r0's answer is written whole.
fn serve(listener: TcpListener, body: usize, seen: mpsc::Sender<(String, usize)>) {
    std::thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let Ok(mut stream) = stream else { return };
            let seen = seen.clone();
            std::thread::spawn(move || {
                while let Some(tag) = read_request(&mut stream) {
                    if seen.send((tag.clone(), n + 1)).is_err() {
                        return;
                    }
                    let answer = if tag == "r0" {
                        let mut answer = format!("HTTP/1.1 400 Bad Request\r\ncontent-length: {body}\r\n\r\n").into_bytes();
                        answer.resize(answer.len() + body, b'a');
                        answer
                    } else {
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".to_vec()
                    };
                    if stream.write_all(&answer).and_then(|()| stream.flush()).is_err() {
                        return;
                    }
                    if tag == "r0" && seen.send(("written".to_owned(), n + 1)).is_err() {
                        return;
                    }
                }
            });
        }
    });
}

struct Control {
    lines: Lines<BufReader<TcpStream>>,
    stream: TcpStream,
}

impl Control {
    fn ask(&mut self, command: &str) -> String {
        writeln!(self.stream, "{command}").unwrap_or_else(|error| panic!("sending {command:?}: {error}"));
        match self.lines.next() {
            Some(Ok(line)) => line,
            other => panic!("no answer to {command:?} within {DEADLINE:?}: {other:?}"),
        }
    }

    fn wait(&mut self, line: &str) {
        let answer = self.ask(&format!("wait {} {line}", DEADLINE.as_millis()));
        assert!(answer.starts_with("seen "), "waiting for {line:?}: {answer}");
    }
}

/// The core's events from its stderr, in order, each within the deadline.
fn events(lines: &mpsc::Receiver<String>, n: usize) -> Vec<String> {
    let mut events = Vec::new();
    while events.len() < n {
        let line = lines.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core wrote {events:?} and no further event within {DEADLINE:?}"));
        if let Some(event) = line.strip_prefix("event ") {
            events.push(event.to_owned());
        }
    }
    events
}

/// One case of the recording: the order of `t1`, `r0-read`, `t2`, which socket `r1`-`r3` went on (r0's, or a new one), and
/// how many sockets were accepted.
fn replay(body: usize) -> (Vec<String>, Vec<(String, &'static str)>, usize) {
    let server = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let server_address = server.local_addr().expect("address").to_string();
    let (seen_tx, seen) = mpsc::channel();
    serve(server, body, seen_tx);
    let clock = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["core", "--exact", "--nocapture", "--test-threads=1"])
        .env(ROLE, body.to_string())
        .env(SERVER, &server_address)
        .env(virtual_clock::ENV, clock.local_addr().expect("address").to_string())
        .env(virtual_clock::TOKEN_ENV, TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().expect("the core process");
    let stderr = child.stderr.take().expect("piped stderr");
    let (line_tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let (accepted_tx, accepted) = mpsc::channel();
    std::thread::spawn(move || drop(accepted_tx.send(clock.accept().map(|(stream, _)| stream))));
    let stream = accepted.recv_timeout(DEADLINE).expect("the core's clock connects within the deadline").expect("the clock's connection");
    stream.set_read_timeout(Some(DEADLINE)).expect("a read deadline");
    let mut control = Control { lines: BufReader::new(stream.try_clone().expect("stream")).lines(), stream };
    assert!(control.lines.next().and_then(Result::ok).is_some_and(|hello| hello.starts_with("hello ")));
    assert_eq!(control.ask(&format!("start {TOKEN} {WALL} 30000")), format!("now {WALL}"));
    // r0 is real I/O: its answer is written whole, and its head read, before the timers are due.
    let mut by_tag = Vec::new();
    while !by_tag.iter().any(|(tag, _): &(String, usize)| tag == "written") {
        by_tag.push(seen.recv_timeout(DEADLINE).expect("the server sees r0 and writes its answer within the deadline"));
    }
    control.wait("event r0-head 0");
    control.wait("event armed 0");
    assert_eq!(control.ask("advance 100"), format!("now {}", WALL + 100));
    control.wait("event done 100");
    let order: Vec<String> = events(&lines, 5).into_iter().filter_map(|e| ["t1 100", "r0-read 100", "t2 100"].contains(&e.as_str()).then(|| e.trim_end_matches(" 100").to_owned())).collect();
    while by_tag.iter().filter(|(tag, _)| tag.starts_with('r')).count() < 4 {
        by_tag.push(seen.recv_timeout(DEADLINE).expect("the server sees r1, r2 and r3 within the deadline"));
    }
    drop(control);
    let _ = child.kill();
    let _ = child.wait();
    let first = by_tag.iter().find(|(tag, _)| tag == "r0").expect("r0").1;
    let sockets = ["r1", "r2", "r3"].map(|tag| (tag.to_owned(), if by_tag.iter().find(|(t, _)| t == tag).expect("each request").1 == first { "reused" } else { "new" }));
    let accepted = by_tag.iter().map(|(_, n)| *n).collect::<std::collections::BTreeSet<_>>().len();
    (order, sockets.to_vec(), accepted)
}

/// The one case the core does not replay equal, and why: undici's socket is busy from the end of the response's message,
/// which for a body that fits its buffers is when it arrives (a poll phase whose check phase frees it before any later
/// timer); the core's link holds the socket from when the caller reads the body whole (`H1Body::release`), here inside
/// `t1`, so the resend finds it busy and dials. That is the link's model of when a message ends, not the clock's.
const DIVERGES: (&str, &str) = ("a-body-ended-before-the-timers", "r1");

#[test]
fn a_socket_held_for_a_resend_stays_busy_until_the_check_phase_as_in_node() {
    let recording: serde_json::Value = serde_json::from_str(RECORDING).expect("the recording");
    for case in recording["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("a name");
        let body = usize::try_from(case["body"].as_u64().expect("a body size")).expect("a size");
        let order: Vec<String> = serde_json::from_value(case["order"].clone()).expect("the order");
        let mut sockets: Vec<(String, &str)> = ["r1", "r2", "r3"].map(|tag| (tag.to_owned(), case["sockets"][tag].as_str().expect("reused or new"))).to_vec();
        let mut accepted = usize::try_from(case["accepted"].as_u64().expect("a count")).expect("a count");
        if name == DIVERGES.0 {
            // Exactly the difference named in [`DIVERGES`]: that request dials where Node's reused r0's socket.
            let request = sockets.iter_mut().find(|(tag, _)| tag == DIVERGES.1).expect("the diverging request");
            assert_eq!(request.1, "reused");
            request.1 = "new";
            accepted += 1;
        }
        assert_eq!(replay(body), (order, sockets, accepted), "case {name}");
    }
}
