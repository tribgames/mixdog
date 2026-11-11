//! Node's recording `native/core/fixtures/node-socket-reuse` (`benchmarks/rust-core/recorders/record-node-socket-reuse.mjs`)
//! replayed on the core's replay clock end to end, case for case and whole: the product's HTTP link (mixdog-ai
//! `ReqwestLink`, the node_http client) sends `r0`, whose answer a loopback server gives as the case says (a small or large
//! body, `connection: close`, or an error mid-body); two timers due in the same millisecond then do the case's action to
//! r0's body (read it whole, as the providers' resend of a rejected request does, cancel it, or nothing) and send `r1`,
//! and send `r2`; 20 ms after both are answered `r3` goes out. Which socket each request gets follows from when r0's socket
//! is free again: one check phase after its message has been read off the network to its end, as undici's
//! (`onMessageComplete`, `setImmediate(client[kResume])`). Each test is the replay: it starts this test binary again as the
//! core (the `core` test, under [`ROLE`]), serves its requests, and drives its clock. Every wait has one deadline.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: the replay side starts the core as a child process and talks to it over std sockets")]

use std::io::BufRead;
use std::io::BufReader;
use std::io::Lines;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::net::TcpListener;
use std::net::TcpStream;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_ai::transport::{HttpSend, ReqwestLink, deadlines};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::RtConfig;
use mixdog_rt::time;
use mixdog_rt::virtual_clock;
use serde_json::Value;

/// The case the core process runs; unset in the test process itself.
const ROLE: &str = "MIXDOG_SOCKET_REUSE_TEST_CASE";
/// The test's HTTP listener.
const SERVER: &str = "MIXDOG_SOCKET_REUSE_TEST_SERVER";
const TOKEN: &str = "the-token-of-this-core";
const WALL: u64 = 1_924_992_000_000;
/// The one bound of every wait of a test.
const DEADLINE: Duration = Duration::from_secs(30);
const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/node-socket-reuse/golden.json"));

fn recording() -> Value {
    serde_json::from_str(RECORDING).expect("the recording")
}

fn case(name: &str) -> Value {
    recording()["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no case {name}"))
}

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

/// The recorder's client: `r0`; `t1` (the action on r0's body, then `r1`) and `t2` (`r2`) armed for the same 100 ms; `r3`
/// 20 ms after both are answered; an unread r0 let go at the end.
fn scenario(url: String, action: String) {
    drop(mixdog_rt::spawn("socket-reuse", TaskClass::Work, async move {
        let link = Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the link"));
        let r0 = link.send(request(&url, "r0"), deadlines::OPENAI_CATALOG).await.expect("r0");
        assert_eq!(r0.status, 400);
        event("r0-head");
        let (t1, t2) = (time::sleep(Duration::from_millis(100)), time::sleep(Duration::from_millis(100)));
        let (unread_tx, unread_rx) = tokio::sync::oneshot::channel();
        let first = {
            let (link, url) = (link.clone(), url.clone());
            mixdog_rt::spawn("t1", TaskClass::Work, async move {
                t1.await;
                event("t1");
                let mut body = r0.body;
                match action.as_str() {
                    "read" => loop {
                        match body.next().await {
                            Some(Ok(_)) => {}
                            Some(Err(_)) => break event("r0-error"),
                            None => break event("r0-read"),
                        }
                    },
                    "cancel" => {
                        drop(body);
                        event("r0-cancelled");
                    }
                    _ => drop(unread_tx.send(body)),
                }
                link.send(request(&url, "r1"), deadlines::OPENAI_CATALOG).await.expect("r1").read_all().await.expect("r1's body");
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
        let later = time::sleep(Duration::from_millis(20));
        event("answered");
        later.await;
        link.send(request(&url, "r3"), deadlines::OPENAI_CATALOG).await.expect("r3").read_all().await.expect("r3's body");
        drop(unread_rx.await);
        event("done");
    }));
}

#[test]
fn core() {
    let Ok(name) = std::env::var(ROLE) else { return };
    let action = case(&name)["action"].as_str().expect("an action").to_owned();
    let (_executors, _tokens) = mixdog_rt::exec::boot(RtConfig::for_cores(4)).expect("the executors");
    scenario(format!("http://{}/", std::env::var(SERVER).expect("the server's address")), action);
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

/// What the server tells the replay: a request read (`tag`, connection), r0's answer written, a connection the client closed.
enum Seen {
    Request(String, usize),
    Written,
    Closed(usize),
}

/// The recorder's server: `r0` answered 400 with `body` bytes (`close`: with `connection: close`, then the connection ended;
/// `error`: 10 of them, then the connection ended), every other request `ok`.
fn serve(listener: TcpListener, body: usize, mode: String, seen: mpsc::Sender<Seen>) {
    std::thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let Ok(mut stream) = stream else { return };
            let (seen, mode) = (seen.clone(), mode.clone());
            std::thread::spawn(move || {
                while let Some(tag) = read_request(&mut stream) {
                    if seen.send(Seen::Request(tag.clone(), n + 1)).is_err() {
                        return;
                    }
                    if tag != "r0" {
                        if stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").is_err() {
                            return;
                        }
                        continue;
                    }
                    let close = if mode == "close" { "connection: close\r\n" } else { "" };
                    let mut answer = format!("HTTP/1.1 400 Bad Request\r\ncontent-length: {body}\r\n{close}\r\n").into_bytes();
                    answer.resize(answer.len() + if mode == "error" { 10 } else { body }, b'a');
                    if stream.write_all(&answer).is_err() || seen.send(Seen::Written).is_err() {
                        return;
                    }
                    if mode != "keep" {
                        // The server's end of the connection; the client's end is reported when it comes.
                        let _ = stream.shutdown(Shutdown::Write);
                        while stream.read(&mut [0u8; 64]).is_ok_and(|n| n > 0) {}
                        let _ = seen.send(Seen::Closed(n + 1));
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

/// The core's events from its stderr, in order, up to `last`, each within the deadline.
fn events(lines: &mpsc::Receiver<String>, last: &str) -> Vec<String> {
    let mut events = Vec::new();
    while events.last().is_none_or(|event| event != last) {
        let line = lines.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the core wrote {events:?} and no further event within {DEADLINE:?}"));
        if let Some(event) = line.strip_prefix("event ") {
            events.push(event.to_owned());
        }
    }
    events
}

/// The next thing the server saw, within the deadline.
fn next_seen(seen: &mpsc::Receiver<Seen>, what: &str) -> Seen {
    seen.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the server saw no {what} within {DEADLINE:?}"))
}

/// One case of the recording replayed: what it records, as the core gives it.
fn replay(name: &str) -> Value {
    let spec = case(name);
    let body = usize::try_from(spec["body"].as_u64().expect("a body size")).expect("a size");
    let mode = spec["server"].as_str().expect("a server mode").to_owned();
    let server = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let server_address = server.local_addr().expect("address").to_string();
    let (seen_tx, seen) = mpsc::channel();
    serve(server, body, mode.clone(), seen_tx);
    let clock = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["core", "--exact", "--nocapture", "--test-threads=1"])
        .env(ROLE, name)
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
    // r0 is real I/O, done before the timers are due as in the recording: its head read; an answer that fits one write
    // written whole (a larger one stays partly unread on purpose); a connection the server ends, ended on the core's side too.
    let mut requests = Vec::new();
    match next_seen(&seen, "r0") {
        Seen::Request(tag, n) => requests.push((tag, n)),
        _ => panic!("r0 comes first"),
    }
    if body <= 70_000 {
        assert!(matches!(next_seen(&seen, "r0's answer written"), Seen::Written));
    }
    if mode != "keep" {
        assert!(matches!(next_seen(&seen, "the client's end of r0's connection"), Seen::Closed(1)));
    }
    control.wait("event r0-head 0");
    control.wait("event armed 0");
    // A message that fits what the link may read ahead is read off the socket before the timers, as in Node: real I/O.
    if body <= 70_000 {
        control.wait("h1 message read off the socket");
    }
    // Node's loop turns again at once while immediates are queued: `advance 0` is that turn, until none is left; first for
    // those the check phase after real I/O left (no answer counts them), then for those the advance leaves.
    let turns_at_v = |control: &mut Control| while control.ask("advance 0").contains(" immediates ") {};
    let advance = |control: &mut Control, ms: u64| {
        turns_at_v(control);
        let mut answer = control.ask(&format!("advance {ms}"));
        while answer.contains(" immediates ") {
            answer = control.ask("advance 0");
        }
        answer
    };
    assert_eq!(advance(&mut control, 100), format!("now {}", WALL + 100));
    control.wait("event answered 100");
    assert_eq!(advance(&mut control, 20), format!("now {}", WALL + 120));
    control.wait("event done 120");
    let order: Vec<String> = events(&lines, "done 120")
        .into_iter()
        .filter_map(|event| event.strip_suffix(" 100").map(str::to_owned))
        .filter(|event| event != "answered")
        .collect();
    while requests.len() < 4 {
        if let Seen::Request(tag, n) = next_seen(&seen, "r1, r2 and r3") {
            requests.push((tag, n));
        }
    }
    drop(control);
    let _ = child.kill();
    let _ = child.wait();
    let conn = |tag: &str| requests.iter().find(|(t, _)| t == tag).unwrap_or_else(|| panic!("no {tag}")).1;
    let sockets: serde_json::Map<String, Value> = ["r1", "r2", "r3"].iter().map(|tag| (tag.to_string(), Value::from(if conn(tag) == conn("r0") { "reused" } else { "new" }))).collect();
    let accepted = requests.iter().map(|(_, n)| *n).collect::<std::collections::BTreeSet<_>>().len();
    let mut replayed = spec.clone();
    replayed["order"] = Value::from(order);
    replayed["sockets"] = Value::Object(sockets);
    replayed["accepted"] = Value::from(accepted);
    replayed
}

/// Every case of the recording, whole.
#[test]
fn a_socket_is_free_one_check_phase_after_its_message_ended_on_the_network_as_in_node() {
    for case in recording()["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("a name");
        eprintln!("case {name}");
        assert_eq!(&replay(name), case, "case {name}");
    }
}
