//! Replay of Node's helper client after authentication (recorded by `record-screen-control-client.mjs` from the
//! export of b6f10295a): every scenario's script is run against Rust's client on the product's runtime and the
//! virtual clock, with a fake pipe that only records what the client writes and hands each write's outcome back when
//! the script says, and a fake connector that gives the authenticated pipe with the recorder's hello. The whole trace
//! and the final state must equal the recording.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_secure_desktop::protocol::InputEvent;
use mixdog_secure_desktop::protocol::Message;
use serde_json::Value;
use serde_json::json;

use super::adapter::HelperService;
use super::adapter::HelperSession;
use super::adapter::SecureDesktopAdapter;
use super::installer::Timers;
use super::helper_client::ClientSession;
use super::helper_client::Dialing;
use super::helper_client::HelperClient;
use super::helper_client::HelperConnector;
use super::helper_client::HelperPipe;
use super::helper_client::LinkConnector;
use super::helper_client::LinkIo;
use super::helper_client::PipeEvents;
use super::lease::Challenge;
use super::lease::Grant;
use super::router::BoxFuture;
use super::testing::DEADLINE;
use super::testing::Log;
use super::testing::Replay;
use super::testing::ThreadedTimers;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: &str = include_str!("../../../../../fixtures/screen-control/client/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/client/MANIFEST.json");

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Done = Box<dyn FnOnce(Result<(), String>) + Send>;

struct Pipe {
    log: Log,
    writes: Mutex<Vec<Option<Done>>>,
}

impl HelperPipe for Pipe {
    fn write(&self, message: Message, done: Done) {
        let mut writes = lock(&self.writes);
        log_push(&self.log, json!({"ev": "write", "n": writes.len(), "message": message}));
        writes.push(Some(done));
    }
    fn end(&self) {
        log_push(&self.log, json!({"ev": "end"}));
    }
}

struct Connector {
    pipe: Arc<Pipe>,
}

impl HelperConnector for Connector {
    fn available(&self) -> bool {
        true
    }
    fn connect(&self, _events: Arc<dyn PipeEvents>) -> Dialing {
        let pipe: Arc<dyn HelperPipe> = self.pipe.clone();
        let hello = ClientSession { protocol: 4, version: "1.4.5".to_string(), session: 1, desktop: "Winlogon".to_string(), locked: Some(false) };
        Dialing {
            done: Box::pin(async move {
                next_turn().await;
                Ok((pipe, hello))
            }),
            abort: Box::new(|| panic!("no client scenario closes during the handshake")),
        }
    }
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let log = log_new();
    let pipe = Arc::new(Pipe { log: log.clone(), writes: Mutex::new(Vec::new()) });
    let timers = VirtualTimers::new(replay.clone());
    let client = HelperClient::new(Arc::new(Connector { pipe: pipe.clone() }), Arc::new(timers.clone()));
    let events = client.events();
    let calls: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start_call = |name: &str, done: BoxFuture<Result<(), String>>, value: Value| {
        lock(&calls).insert(name.to_string(), false);
        let (calls, log, name) = (calls.clone(), log.clone(), name.to_string());
        replay.spawn(Box::pin(async move {
            let event = match done.await {
                Ok(()) => json!({"ev": "done", "call": name, "ok": true, "value": value}),
                Err(error) => json!({"ev": "done", "call": name, "ok": false, "error": error}),
            };
            lock(&calls).insert(name, true);
            log_push(&log, event);
        }));
    };
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        match step["op"].as_str().expect("a step op") {
            "session" => log_push(&log, json!({"ev": "session", "session": client.client_session()})),
            "connect" => start_call(call, client.connect(), json!("hello")),
            "send" => {
                let sent = match step["what"].as_str().expect("what") {
                    "input" => client.send_input(serde_json::from_value::<InputEvent>(step["event"].clone()).expect("an input event")),
                    "grant" => client.send_grant(Grant {
                        challenge: step["grant"]["challenge"].as_str().expect("a challenge").to_string(),
                        epoch: step["grant"]["epoch"].as_u64().expect("an epoch"),
                        signature: step["grant"]["signature"].as_str().expect("a signature").to_string(),
                    }),
                    _ => client.sas(),
                };
                start_call(call, sent, Value::Null);
            }
            "setActive" => client.set_active(step["active"].as_bool().expect("active")),
            "videoRun" => client.set_video_run(step["epoch"].as_u64().expect("an epoch")),
            "written" => {
                let done = lock(&pipe.writes)
                    .get_mut(step["n"].as_u64().expect("n") as usize)
                    .and_then(Option::take)
                    .unwrap_or_else(|| panic!("{}: no write {}", scenario["name"], step["n"]));
                done(step["error"].as_str().map_or(Ok(()), |error| Err(error.to_string())));
            }
            "listen" => {
                let changed = log.clone();
                drop(client.on_desktop_changed(Arc::new(move |session: &HelperSession| {
                    log_push(&changed, json!({"ev": "desktop-changed", "desktop": session.desktop, "session": session.session, "locked": session.locked}));
                })));
                let challenged = log.clone();
                drop(client.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
                    log_push(&challenged, json!({"ev": "grant-challenge", "challenge": {"nonce": challenge.nonce, "challenge": challenge.challenge}}));
                })));
                let errors = log.clone();
                drop(client.on_error(Arc::new(move |(code, message): &(String, String)| {
                    log_push(&errors, json!({"ev": "error", "code": code, "message": message}));
                })));
                let closed = log.clone();
                drop(client.on_close(Arc::new(move |_: &()| log_push(&closed, json!({"ev": "close"})))));
            }
            "peer" => {
                let message = &step["message"];
                match message["type"].as_str().expect("a message type") {
                    "desktop-changed" => events.desktop_changed(
                        message["desktop"].as_str().expect("a desktop").to_string(),
                        message["session"].as_u64().expect("a session") as u32,
                        message["locked"].as_bool(),
                    ),
                    "grant-challenge" => events.grant_challenge(Challenge {
                        nonce: message["nonce"].as_str().expect("a nonce").to_string(),
                        challenge: message["challenge"].as_str().expect("a challenge").to_string(),
                    }),
                    "error" => events.error(
                        message["code"].as_str().expect("a code").to_string(),
                        message["message"].as_str().expect("a message").to_string(),
                    ),
                    other => panic!("unknown peer message {other}"),
                }
            }
            "peerClose" => events.closed(),
            "close" => client.close(),
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let ran = timers.advance(ms).await;
                log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
            }
            "settle" => replay.settle().await,
            "await" => {
                replay.settle().await;
                let name = step["call"].as_str().expect("a call");
                assert!(lock(&calls).get(name).copied().unwrap_or(false), "{}: {name} did not finish", scenario["name"]);
            }
            other => panic!("unknown step {other}"),
        }
    }
    replay.settle().await;
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending()});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_client_scenario_replays_to_nodes_whole_trace() {
    let recording: Value = serde_json::from_str(RECORDING).expect("the recording parses");
    let scenarios = recording["scenarios"].as_array().expect("scenarios");
    manifest_names(MANIFEST, scenarios);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = Replay::run(|replay| play(replay, scenario.clone()));
        let want = scenario["trace"].as_array().expect("a trace");
        if let Some(index) = (0..trace.len().max(want.len())).find(|&index| trace.get(index) != want.get(index)) {
            failures.push(format!("{name}: trace event {index}\n  rust: {:?}\n  node: {:?}", trace.get(index), want.get(index)));
        } else if final_state != scenario["final"] {
            failures.push(format!("{name}: the final state\n  rust: {final_state}\n  node: {}", scenario["final"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} scenarios differ from Node:\n{}", failures.len(), scenarios.len(), failures.join("\n"));
}

// A connect given up during its handshake (Node: `client.ts` close() ends the connection while it authenticates, and
// the adapter closes a connection made after its dispose, `secure-desktop-adapter.ts:201-204,297`). The real
// connector and its owner thread, on a multi-threaded runtime; the handshake is a stand-in held until the test
// answers it, after the adapter was disposed and released. The owner thread must end, the pipe handle with it, and
// every task the connect started (the pipe's event task, the adapter's reaction) must end.

#[derive(Debug, PartialEq)]
enum Seen {
    HandshakeBegan,
    Wrote,
    HandleReleased,
    OwnerEnded,
}

/// Lives in the owner thread's local storage: dropped when that thread ends.
struct OwnerAlive(std::sync::mpsc::Sender<Seen>);

impl Drop for OwnerAlive {
    fn drop(&mut self) {
        drop(self.0.send(Seen::OwnerEnded));
    }
}

thread_local! {
    static OWNER: std::cell::RefCell<Option<OwnerAlive>> = const { std::cell::RefCell::new(None) };
}

/// An authenticated link from which the helper sends nothing.
struct QuietLink {
    seen: std::sync::mpsc::Sender<Seen>,
    /// Never sent on: `next` waits its time on it as the real link waits for the helper.
    silence: std::sync::mpsc::Receiver<()>,
    _open: std::sync::mpsc::Sender<()>,
}

impl LinkIo for QuietLink {
    fn write(&mut self, _message: Message) -> std::io::Result<()> {
        drop(self.seen.send(Seen::Wrote));
        Ok(())
    }

    fn next(&mut self, wait: std::time::Duration) -> std::io::Result<Option<mixdog_secure_desktop::client::Event>> {
        drop(self.silence.recv_timeout(wait));
        Ok(None)
    }
}

impl Drop for QuietLink {
    fn drop(&mut self) {
        drop(self.seen.send(Seen::HandleReleased));
    }
}

fn give_up_during_the_handshake(succeeds: bool) -> Vec<Seen> {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a multi-threaded runtime");
    let timers = ThreadedTimers::new(runtime.handle().clone());
    let (tell, seen) = std::sync::mpsc::channel::<Seen>();
    let (answer, answered) = std::sync::mpsc::channel::<bool>();
    let answered = Arc::new(Mutex::new(Some(answered)));
    let dial_tell = tell.clone();
    let dial: Arc<dyn Fn() -> Result<(Box<dyn LinkIo>, ClientSession), String> + Send + Sync> = Arc::new(move || {
        OWNER.with(|owner| *owner.borrow_mut() = Some(OwnerAlive(dial_tell.clone())));
        drop(dial_tell.send(Seen::HandshakeBegan));
        let answered = lock(&answered).take().expect("one dial");
        if !answered.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the test did not answer the handshake within {DEADLINE:?}")) {
            return Err("unauthorized: the client is not allowed".to_string());
        }
        let (open, silence) = std::sync::mpsc::channel();
        let link = QuietLink { seen: dial_tell.clone(), silence, _open: open };
        let hello = ClientSession { protocol: 4, version: "1.4.5".to_string(), session: 1, desktop: "Winlogon".to_string(), locked: Some(false) };
        Ok((Box::new(link) as Box<dyn LinkIo>, hello))
    });
    let shared: Arc<dyn Timers> = Arc::new(timers.clone());
    let connector = Arc::new(LinkConnector::with(dial, shared.clone()));
    let turn = timers.turn.clone();
    let adapter = turn.enter(|| SecureDesktopAdapter::create(Arc::new(HelperClient::new(connector, shared.clone())), shared.clone()));
    turn.enter(|| shared.spawn(adapter.set_active(true)));
    let mut observed = Vec::new();
    let next = |what: &str| seen.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("waiting for {what}: nothing came within {DEADLINE:?}"));
    observed.push(next("the handshake to begin"));
    turn.enter(|| adapter.dispose());
    drop(adapter);
    answer.send(succeeds).expect("the handshake waits for its answer");
    loop {
        let event = next("the owner thread to end");
        let ended = event == Seen::OwnerEnded;
        observed.push(event);
        if ended {
            break;
        }
    }
    timers.settle();
    observed
}

#[test]
fn a_connect_given_up_during_its_handshake_ends_its_owner_thread_and_releases_the_pipe() {
    assert_eq!(
        give_up_during_the_handshake(true),
        [Seen::HandshakeBegan, Seen::HandleReleased, Seen::OwnerEnded],
        "the handshake then succeeds: the link is dropped unused and its thread ends"
    );
    assert_eq!(
        give_up_during_the_handshake(false),
        [Seen::HandshakeBegan, Seen::OwnerEnded],
        "the handshake then fails: its thread ends"
    );
}
