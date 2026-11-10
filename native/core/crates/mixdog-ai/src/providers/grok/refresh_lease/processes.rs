//! The Grok refresh lease between two real processes on one credential file (`refresh_lease/processes.mjs`): Node's
//! recording is of two Node processes; the core's replay runs the same coordinator with two core processes (this test
//! binary re-run as [`lease_child`]), and with a Node and a core process in both orders, and compares what happened
//! whole with Node's. The coordinator is the recorder itself, which runs no product code: each process keeps its own
//! virtual clock and steps only when the coordinator says so.
//!
//! The Node side of the interoperation cases and the coordinator run on the reference Node runtime
//! (`MIXDOG_REFERENCE_NODE`, the recording's Electron by default, run as Node) over the exact b6f10295a export
//! (`MIXDOG_REFERENCE_TREE`).

use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::process::Command;
use std::process::Stdio;

use super::*;

const COORDINATOR: &str = "native/core/crates/mixdog-ai/src/providers/grok/refresh_lease/processes.mjs";
const NODE_CHILD: &str = "native/core/crates/mixdog-ai/src/providers/grok/refresh_lease/node_child.mjs";
/// [`lease_child`]'s name in this test binary.
const CHILD_TEST: &str = "providers::grok::auth::refresh_lease_tests::processes::lease_child";
const REPLAY_DEADLINE: Duration = Duration::from_secs(300);

fn reference_node() -> PathBuf {
    std::env::var_os("MIXDOG_REFERENCE_NODE").map_or_else(|| PathBuf::from(r"C:\Users\tempe\side\dcr\apps\desktop\node_modules\electron\dist\electron.exe"), PathBuf::from)
}

fn reference_tree() -> PathBuf {
    std::env::var_os("MIXDOG_REFERENCE_TREE").map_or_else(|| PathBuf::from(r"D:\mixdog-build\tmp\b6f-tree"), PathBuf::from)
}

fn recording() -> Value {
    let dir = repo().join("native/core/fixtures/grok-refresh-lease-processes");
    let manifest = fixture_manifest::verify_dir(&repo(), &dir, COORDINATOR);
    assert_eq!(
        manifest["scripts"][NODE_CHILD],
        fixture_manifest::sha256(&std::fs::read(repo().join(NODE_CHILD)).unwrap()),
        "{NODE_CHILD} changed since the recording (re-record)"
    );
    serde_json::from_slice(&std::fs::read(dir.join("node-recorded.json")).unwrap()).unwrap()
}

/// What a case did, as the recording keeps it.
fn observed(case: &Value) -> Value {
    json!({ "events": case["events"], "fileAfter": case["fileAfter"], "entries": case["entries"], "unusedReplies": case["unusedReplies"] })
}

/// The coordinator over `kinds` (`A,B`, each `core` or `node`), within [`REPLAY_DEADLINE`]: the cases it ran.
fn replay(kinds: &str, only: Option<&str>) -> Vec<Value> {
    let out = tempfile::tempdir().unwrap();
    let out_file = out.path().join("replay.json");
    let mut command = Command::new(reference_node());
    command
        .env("ELECTRON_RUN_AS_NODE", "1")
        .arg(repo().join(COORDINATOR))
        .args(["--replay", "--kinds", kinds, "--core-test", CHILD_TEST, "--core-exe"])
        .arg(std::env::current_exe().unwrap())
        .arg("--out")
        .arg(&out_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // No window: the coordinator and every process it starts run without a console of their own.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    if kinds.contains("node") {
        command.arg("--tree").arg(reference_tree());
    }
    if let Some(only) = only {
        command.args(["--only", only]);
    }
    let mut coordinator = command.spawn().unwrap_or_else(|e| panic!("the coordinator {} did not start: {e}", reference_node().display()));
    // The coordinator's output and diagnostics to their end: its exit.
    let (mut stdout, mut stderr) = (coordinator.stdout.take().unwrap(), coordinator.stderr.take().unwrap());
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    let Ok(mut text) = rx.recv_timeout(REPLAY_DEADLINE) else {
        let _ = coordinator.kill();
        let _ = coordinator.wait();
        panic!("the coordinator ({kinds}) did not finish within {} s", REPLAY_DEADLINE.as_secs());
    };
    let status = coordinator.wait().unwrap();
    text.push_str(&errors.join().unwrap());
    assert!(status.success(), "the coordinator ({kinds}) failed ({status}):\n{text}");
    let replayed: Value = serde_json::from_slice(&std::fs::read(&out_file).unwrap()).unwrap();
    replayed["cases"].as_array().unwrap().clone()
}

/// Two core processes do in every case what two Node processes did: the same token requests from the same process at
/// the same instants, the same waits, the same kill and takeover, each caller the same result, and the credential file
/// and its directory left the same.
#[test]
fn two_core_processes_do_what_two_node_processes_did() {
    let recording = recording();
    let node: Vec<&Value> = recording["cases"].as_array().unwrap().iter().collect();
    let core = replay("core,core", None);
    assert_eq!(core.len(), node.len(), "the replay ran other cases");
    let differing: Vec<String> = node
        .iter()
        .zip(&core)
        .filter(|(n, c)| observed(n) != observed(c) || n["name"] != c["name"])
        .map(|(n, c)| format!("{}:\n  node {}\n  core {}", n["name"], observed(n), observed(c)))
        .collect();
    assert!(differing.is_empty(), "{} of {} cases differ from Node:\n{}", differing.len(), node.len(), differing.join("\n"));
}

/// A Node and a core process share the lease as two Node processes do, whichever holds it: Node holds and the core waits
/// (A is Node), and the core holds and Node waits (A is the core). One token request, both read the new generation, and
/// the file and directory end as Node's two processes left them.
#[test]
fn a_node_and_a_core_process_share_the_lease_as_two_node_processes_do() {
    let recording = recording();
    let case = recording["cases"].as_array().unwrap().iter().find(|c| c["name"] == "both-want-a-refresh").unwrap();
    for kinds in ["node,core", "core,node"] {
        let replayed = replay(kinds, Some("both-want-a-refresh"));
        assert_eq!(replayed.len(), 1);
        assert_eq!(observed(&replayed[0]), observed(case), "{kinds}: the processes did otherwise than Node's two");
    }
}

/// The token endpoint of a process the coordinator steps: the request is reported, and the coordinator's reply arrives
/// after its `afterMs` on the virtual clock.
struct Coordinated {
    clock: Arc<Clock>,
    waiting: Arc<Mutex<Option<Arc<Answer>>>>,
}

#[derive(Default)]
struct Answer {
    reply: Mutex<Option<Value>>,
    waker: Mutex<Option<Waker>>,
}

#[async_trait]
impl HttpSend for Coordinated {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.clock.event(json!({ "kind": "request", "url": request.url, "body": String::from_utf8(request.body).unwrap() }));
        let answer = Arc::new(Answer::default());
        *self.waiting.lock().unwrap() = Some(answer.clone());
        let reply = std::future::poll_fn(|cx| {
            if let Some(reply) = answer.reply.lock().unwrap().take() {
                return Poll::Ready(reply);
            }
            *answer.waker.lock().unwrap() = Some(cx.waker().clone());
            Poll::Pending
        })
        .await;
        self.clock.fired_after(reply["afterMs"].as_u64().unwrap(), false).await;
        Ok(HttpResponse {
            status: reply["status"].as_u64().unwrap() as u16,
            headers: Vec::new(),
            body: Box::new(OneChunk(Some(Bytes::from(reply["body"].as_str().unwrap().to_owned())))),
        })
    }
}

fn wake(slot: &Mutex<Option<Waker>>) {
    if let Some(waker) = slot.lock().unwrap().take() {
        waker.wake();
    }
}

/// One core process of a two-process case, when the coordinator starts this binary with `MIXDOG_LEASE_CHILD` (the
/// protocol of `node_child.mjs`, one JSON line each way); otherwise nothing. The process's Grok credential is the
/// product's own ([`GrokCredential::ensure`], the lease owned by this process's pid and token) over the coordinator's
/// credential file, on a virtual clock this process fires only when told.
#[tokio::test(flavor = "current_thread")]
async fn lease_child() {
    if std::env::var_os("MIXDOG_LEASE_CHILD").is_none() {
        return;
    }
    let mut lines = std::io::stdin().lock().lines();
    let mut command = move || -> Value { serde_json::from_str(&lines.next().expect("the coordinator's next command").unwrap()).unwrap() };
    let say = |message: Value| {
        let mut out = std::io::stdout().lock();
        writeln!(out, "@lease {message}").unwrap();
        out.flush().unwrap();
    };
    let init = command();
    assert_eq!(init["cmd"], "init", "the first command");
    let t0 = init["now"].as_u64().unwrap();
    let clock = Arc::new(Clock { t0, state: Mutex::new(ClockState { now: t0, next_id: 0, timers: Vec::new(), events: Vec::new() }) });
    let waiting = Arc::new(Mutex::new(None::<Arc<Answer>>));
    let rt = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(PathBuf::from(init["path"].as_str().unwrap()), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
    let http = Arc::new(Coordinated { clock: clock.clone(), waiting: waiting.clone() });
    let credential = Arc::new(GrokCredential::new(http, file).with_pace(Arc::new(clock.clone())));
    say(json!({ "ready": { "pid": std::process::id() } }));
    let mut calls: Vec<(u64, Call, Arc<Flag>)> = Vec::new();
    loop {
        let command = command();
        let cmd = command["cmd"].as_str().unwrap().to_owned();
        if cmd == "exit" {
            break;
        }
        let now = command["now"].as_u64().unwrap();
        clock.state().now = now;
        match cmd.as_str() {
            "call" => {
                let (credential, force) = (credential.clone(), command["force"].as_bool().unwrap());
                let call: Call = Box::pin(tokio::task::unconstrained(async move { credential.ensure(force).await }));
                calls.push((command["caller"].as_u64().unwrap(), call, Arc::new(Flag(AtomicBool::new(true)))));
            }
            "fire" => {
                let timer = {
                    let mut state = clock.state();
                    state.timers.sort_by_key(|t| (t.due, t.id));
                    assert!(state.timers.first().is_some_and(|t| t.due == now), "fire at {now}: the earliest timer is due at {:?}", state.timers.first().map(|t| t.due));
                    let timer = state.timers.remove(0);
                    if timer.recorded {
                        state.events.push(json!({ "kind": "wait", "ms": timer.ms }));
                    }
                    timer
                };
                let Fire::Wake(slot) = timer.fire else { panic!("a process's timer only wakes a wait") };
                slot.fired.store(true, Ordering::SeqCst);
                wake(&slot.waker);
            }
            "reply" => {
                let answer = waiting.lock().unwrap().take().expect("a reply with no token request in flight");
                *answer.reply.lock().unwrap() = Some(command.clone());
                wake(&answer.waker);
            }
            other => panic!("unknown command {other}"),
        }
        // Everything runs that can without the clock.
        loop {
            let mut ran = false;
            let mut n = 0;
            while n < calls.len() {
                let (caller, call, flag) = &mut calls[n];
                if !flag.0.swap(false, Ordering::SeqCst) {
                    n += 1;
                    continue;
                }
                ran = true;
                let waker = Waker::from(flag.clone());
                if let Poll::Ready(outcome) = call.as_mut().poll(&mut Context::from_waker(&waker)) {
                    let mut event = json!({ "kind": "result", "caller": *caller });
                    match outcome {
                        Ok(tokens) => event["token"] = json!(tokens.access_token),
                        Err(error) => event["error"] = error_of(&error),
                    }
                    clock.event(event);
                    drop(calls.remove(n));
                } else {
                    n += 1;
                }
            }
            if !ran {
                break;
            }
        }
        let (next, events) = {
            let mut state = clock.state();
            (state.timers.iter().map(|t| t.due).min(), std::mem::take(&mut state.events))
        };
        say(json!({ "status": { "next": next, "events": events } }));
    }
}
