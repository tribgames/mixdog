//! The `process`, `terminal` and `system` domain services over real processes, a mock scoped-feed
//! factory and a mock section publisher.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::Origin;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::SectionName;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ports::ListeningPort;
use mixdog_spawn::service::ProcessFeeds;
use mixdog_spawn::service::ProcessService;
use mixdog_spawn::service::SystemService;
use mixdog_spawn::service::TerminalService;
use mixdog_spawn::service::TerminalServiceConfig;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn request(method: &'static str, mut params: Value, connection: u64) -> CoreRequest {
    // Mutating methods carry an op id in their params; the other methods ignore it.
    if let Some(map) = params.as_object_mut().filter(|m| !m.is_empty()) {
        map.entry("opId").or_insert_with(|| json!(format!("op-{method}")));
    }
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Local, CancellationToken::new()) }
}

fn scoped() -> Arc<MockScopedFeeds> {
    Arc::new(MockScopedFeeds::new(MockLimits::default()))
}

/// How long a wait for an event of the product may take before it is a failure that names what was awaited.
const EVENT_DEADLINE: Duration = Duration::from_secs(60);

type Published = Vec<(SectionName, Option<String>, SectionChange)>;

/// The section publisher the terminal tests read: every publication wakes the waiters, so a test
/// waits for the publication its assertion reads, never for a count of ticks.
#[derive(Default)]
struct SectionLog {
    inner: MockStatePublisher,
    pushed: tokio::sync::Notify,
    /// A test's hold on the next activity publication: the publisher announces it has the publication in hand and does not publish it
    /// until the gate opens (the section worker is blocked meanwhile, as a slow publisher would block it).
    hold: std::sync::Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

impl SectionLog {
    /// Holds the next activity publication. Returns the receiver that says the publication is in hand and the sender that opens the gate.
    fn hold_next_activity(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (open_tx, open_rx) = std::sync::mpsc::channel();
        *self.hold.lock().unwrap() = Some((held_tx, open_rx));
        (held_rx, open_tx)
    }

    fn published(&self) -> Published {
        self.inner.published()
    }

    /// Returns once `ready` holds for what has been published. The deadline only turns a missing
    /// publication into a failure that names it.
    async fn wait_for(&self, what: &str, ready: impl Fn(&Published) -> bool) {
        let waited = tokio::time::timeout(EVENT_DEADLINE, async {
            loop {
                let pushed = self.pushed.notified();
                tokio::pin!(pushed);
                // Registered before the check, so a publication between check and await still wakes it.
                pushed.as_mut().enable();
                if ready(&self.published()) {
                    return;
                }
                pushed.await;
            }
        })
        .await;
        assert!(waited.is_ok(), "never published: {what}");
    }
}

impl StatePublisher for SectionLog {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        if section == SectionName::TerminalActivity {
            let hold = self.hold.lock().unwrap().take();
            if let Some((held, open)) = hold {
                held.send(()).expect("the test waits for the held publication");
                open.recv_timeout(EVENT_DEADLINE).expect("the test never opened the gate on the held activity publication");
            }
        }
        self.inner.publish(section, key, change);
        self.pushed.notify_waiters();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn process_spawn_streams_on_a_feed_and_kill_ends_it() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = ProcessService::new(manager.clone(), feeds);
    let name = handle("svc-spawn");
    let long = if cfg!(windows) { json!(["ping", "-n", "60", "127.0.0.1"]) } else { json!(["sleep", "60"]) };
    let params = json!({
        "processHandle": name,
        "argv": long,
        "cwd": temp_dir().as_path().to_string_lossy(),
        "owner": { "kind": "internal" },
    });
    let Reply::Subscribe(sub) = service.call(request("process/spawn", params, 1)).await.unwrap() else {
        panic!("process/spawn answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), format!("process:{name}"));
    let pid = sub.result["pid"].as_u64().expect("the reply carries the pid") as u32;
    assert!(pid_alive(pid));

    // A second spawn under the live handle is refused, not a second process.
    let again = json!({ "processHandle": name, "argv": ["x"], "cwd": temp_dir().as_path().to_string_lossy(), "owner": "internal" });
    assert!(service.call(request("process/spawn", again, 1)).await.is_err());

    // The process's end is its exit event, which the manager publishes once it has reaped the process.
    let mut events = manager.subscribe(&ProcessHandle::from(name.as_str()), None).expect("the running process has events");
    service.call(request("process/kill", json!({ "processHandle": name }), 1)).await.unwrap();
    tokio::time::timeout(EVENT_DEADLINE, async {
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                return;
            }
        }
        panic!("the killed process's events ended without its exit");
    })
    .await
    .unwrap_or_else(|_| panic!("the killed process did not exit within {EVENT_DEADLINE:?}"));
    assert!(!pid_alive(pid), "the process reported its exit but is alive");
    // A malformed request is a typed error, never a panic.
    assert!(service.call(request("process/spawn", json!({}), 1)).await.is_err());
    assert!(service.call(request("process/nope", json!({}), 1)).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn process_stdin_input_and_pty_resize_reach_the_process() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = ProcessService::new(manager.clone(), feeds);
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();

    // `sort` reads stdin to its end: one chunk by `process/input`, one by `process/writeStdin`
    // that also closes stdin; the sorted result proves both arrived.
    let sorter = handle("svc-stdin");
    let params = json!({ "processHandle": sorter, "argv": ["sort"], "cwd": cwd, "owner": "internal" });
    service.call(request("process/spawn", params, 1)).await.unwrap();
    service.notify(Method("process/input"), json!({ "processHandle": sorter, "bytesB64": STANDARD.encode("b\r\n") }), ConnectionId(1));
    let write = json!({ "processHandle": sorter, "bytesB64": STANDARD.encode("a\r\n"), "closeStdin": true });
    service.call(request("process/writeStdin", write, 1)).await.unwrap();
    let (output, _) = collect(&manager, &sorter).await;
    let lines: Vec<String> = text(&output).lines().map(str::to_owned).collect();
    assert_eq!(lines, ["a", "b"]);
    // A pipe has no size to change.
    let resize = json!({ "processHandle": sorter, "cols": 90, "rows": 30 });
    assert!(service.call(request("process/resizePty", resize, 1)).await.is_err());

    // A PTY process takes the new size.
    let long = if cfg!(windows) { json!(["ping", "-n", "60", "127.0.0.1"]) } else { json!(["sleep", "60"]) };
    let tty = handle("svc-pty");
    let params = json!({ "processHandle": tty, "argv": long, "cwd": cwd, "owner": "internal", "pty": { "cols": 80, "rows": 24 } });
    service.call(request("process/spawn", params, 1)).await.unwrap();
    let resize = json!({ "processHandle": tty, "cols": 120, "rows": 40 });
    service.call(request("process/resizePty", resize, 1)).await.unwrap();
    service.call(request("process/kill", json!({ "processHandle": tty }), 1)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_size_is_owned_by_the_claiming_connection_and_output_can_pause() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let Reply::Value(ensured) = service.call(request("terminal/ensure", json!({ "tabId": "term_own", "options": { "cwd": cwd } }), 1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    let id = ensured["id"].as_str().unwrap().to_owned();
    // The sizes of a tab's claims: the first claim of a tab (`own`, its size) and the claim released by a non-positive size.
    let (claimed, released) = (json!({ "cols": 90, "rows": 28, "own": true }), json!({ "cols": 0, "rows": 0, "own": false }));
    let attach = |connection: u64| {
        let service = Arc::clone(&service);
        let id = id.clone();
        async move {
            let Reply::Subscribe(sub) = service.call(request("terminal/attach", json!({ "tabId": id }), connection)).await.unwrap() else {
                panic!("terminal/attach answers with a subscription");
            };
            sub.result["sizeOwner"].clone()
        }
    };
    assert_eq!(attach(1).await, Value::Null, "nobody has claimed yet");

    // Focus is not a claim.
    service.call(request("terminal/focus", json!({ "tabId": id, "focused": true }), 1)).await.unwrap();
    assert_eq!(attach(1).await, Value::Null);

    // A claim (Node's `phoneOwner`) owns; it is told `own`, every other connection is not. The reply
    // names the connection (`client`) so a phone can tell its own claim in the tabs section.
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": claimed["cols"], "rows": claimed["rows"], "claim": true }), ConnectionId(1));
    let mine = attach(1).await;
    assert_eq!((mine["own"].clone(), mine["cols"].clone(), mine["rows"].clone()), (claimed["own"].clone(), claimed["cols"].clone(), claimed["rows"].clone()));
    assert_eq!(attach(2).await["own"], json!(false));
    let client_of = |connection: u64| {
        let service = Arc::clone(&service);
        let id = id.clone();
        async move {
            let Reply::Subscribe(sub) = service.call(request("terminal/attach", json!({ "tabId": id }), connection)).await.unwrap() else {
                panic!("terminal/attach answers with a subscription");
            };
            sub.result["client"].as_str().map(str::to_owned)
        }
    };
    let (first, second) = (client_of(1).await, client_of(2).await);
    assert!(first.as_deref().is_some_and(|c| !c.is_empty()) && first != second, "each connection is named: {first:?} / {second:?}");
    assert_eq!(ensured["client"].as_str().map(str::to_owned), first, "ensure names the asking connection as attach does");
    // The tab list section carries the owner by that name: the phone's `termSizeOwner` events are its changes.
    let owner_in_section = || -> Option<(String, u64, u64)> {
        let (_, _, change) = publisher.published().into_iter().rev().find(|(s, _, _)| *s == SectionName::TerminalTabs)?;
        let SectionChange::Set(bytes) = change else { return None };
        let tabs: Value = serde_json::from_slice(&bytes).ok()?;
        let owner = tabs.as_array()?.iter().find(|tab| tab["id"] == json!(id))?["sizeOwner"].clone();
        Some((owner["owner"].as_str()?.to_owned(), owner["cols"].as_u64()?, owner["rows"].as_u64()?))
    };
    publisher.wait_for("the owner in the tab list section", |_| owner_in_section().is_some()).await;
    assert_eq!(owner_in_section(), first.clone().map(|c| (c, claimed["cols"].as_u64().unwrap(), claimed["rows"].as_u64().unwrap())));

    // A resize that is not a claim is ignored while one stands.
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 70, "rows": 20 }), ConnectionId(2));
    assert_eq!(attach(1).await["cols"], claimed["cols"]);

    // The owner's connection closing releases nothing: its lease does.
    service.connection_closed(ConnectionId(1));
    assert_eq!(attach(2).await["cols"], claimed["cols"]);
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": released["cols"], "rows": released["rows"], "claim": true }), ConnectionId(1));
    assert_eq!(attach(2).await, Value::Null);
    service.call(request("terminal/dispose", json!({ "tabId": id }), 2)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_pause_and_resume_answer_with_an_empty_result() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = TerminalService::new(manager, feeds, Arc::new(SectionLog::default()), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    service.call(request("terminal/ensure", json!({ "tabId": "term_flow", "options": { "cwd": cwd } }), 1)).await.unwrap();
    for method in ["terminal/pause", "terminal/resume"] {
        let reply = service.call(request(method, json!({ "tabId": "term_flow" }), 2)).await.unwrap();
        assert!(matches!(reply, Reply::Value(ref v) if v == &json!({})), "{method} answers with an empty result");
    }
    service.call(request("terminal/dispose", json!({ "tabId": "term_flow" }), 2)).await.unwrap();
}

/// Claims belong to the id, not to a running tab. Node announces a claim and a release whether or not a PTY exists, and disposing an id that has
/// no tab forgets nothing (terminal-manager.ts:454-487, :536): the `sizeOwner` pushes of an id with no tab, with a `termDispose` between the
/// first and the second.
#[tokio::test(flavor = "multi_thread")]
async fn a_claim_on_an_id_without_a_tab_is_published_and_a_dispose_of_it_forgets_nothing() {
    // What the script does, in its order: the phone claims, the other connection claims, the other releases, the phone releases.
    let sizes: Vec<(u64, u64, bool)> = vec![(90, 28, true), (91, 29, false), (90, 28, true), (0, 0, false)];

    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let client_of = |connection: u64| {
        let service = Arc::clone(&service);
        let cwd = cwd.clone();
        async move {
            let Reply::Value(ensured) =
                service.call(request("terminal/ensure", json!({ "tabId": "term_bystander", "options": { "cwd": cwd } }), connection)).await.unwrap()
            else {
                panic!("terminal/ensure answers with a value");
            };
            ensured["client"].as_str().unwrap().to_owned()
        }
    };
    let (phone, other) = (client_of(1).await, client_of(2).await);
    // The latest published row of the id: None when no row, Some(None) when its owner is null, Some(Some(..)) with the owner.
    let row = || -> Option<Option<(String, u64, u64)>> {
        let (_, _, change) = publisher.published().into_iter().rev().find(|(s, _, _)| *s == SectionName::TerminalTabs)?;
        let SectionChange::Set(bytes) = change else { return None };
        let tabs: Value = serde_json::from_slice(&bytes).ok()?;
        let row = tabs.as_array()?.iter().find(|tab| tab["id"] == "term_ph2_none")?.clone();
        assert_eq!(row["tab"], json!(false), "a row for an id with no tab says so");
        Some(row["sizeOwner"].as_object().map(|o| (o["owner"].as_str().unwrap().to_owned(), o["cols"].as_u64().unwrap(), o["rows"].as_u64().unwrap())))
    };
    let expected = |at: usize| {
        let (cols, rows, own) = sizes[at];
        Some(Some((if own { phone.clone() } else { other.clone() }, cols, rows)))
    };
    let claim = |connection: u64, cols: u64, rows: u64| {
        service.notify(Method("terminal/resize"), json!({ "tabId": "term_ph2_none", "cols": cols, "rows": rows, "claim": true }), ConnectionId(connection))
    };

    claim(1, sizes[0].0, sizes[0].1);
    publisher.wait_for("the phone's claim on the id with no tab", |_| row() == expected(0)).await;
    service.call(request("terminal/dispose", json!({ "tabId": "term_ph2_none" }), 1)).await.unwrap();
    claim(2, sizes[1].0, sizes[1].1);
    publisher.wait_for("the other connection's claim, which owns after the dispose of an id with no tab", |_| row() == expected(1)).await;
    claim(2, 0, 0);
    publisher.wait_for("the phone's claim, which the dispose did not forget, owning again", |_| row() == expected(2)).await;
    claim(1, 0, 0);
    publisher.wait_for("the release of the last claim", |_| row() == Some(None)).await;
    assert_eq!((sizes[3].0, sizes[3].1, sizes[3].2), (0, 0, false), "the recording ends in a zero size nobody owns");
    // The release is published once: the next publication of the tab list has no row for the id.
    service.call(request("terminal/dispose", json!({ "tabId": "term_bystander" }), 1)).await.unwrap();
    publisher.wait_for("the tab list without the released id", |_| row().is_none()).await;
}

/// A terminal service whose shells get the marker integration: bash and zsh need a directory for their startup files (the core
/// gives it one, `compose_flip.rs`); without it only PowerShell would report activity.
fn integrated_service(manager: LocalProcessManager, feeds: Arc<ProcessFeeds>, publisher: Arc<SectionLog>, name: &str) -> Arc<TerminalService> {
    let config = TerminalServiceConfig { shell_integration_dir: Some(scratch_dir(&format!("{name}-integration"))) };
    TerminalService::new(manager, feeds, publisher, config)
}

/// A shell with the marker integration (only such a shell reports activity); the test picks one itself, so it does not depend on which
/// shell the machine defaults to.
async fn integrated_profile(service: &TerminalService) -> String {
    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    let mut listed = Vec::new();
    for profile in profiles.as_array().unwrap() {
        let id = profile["id"].as_str().unwrap().to_owned();
        let spawn = service.tabs().resolve_profile(&id).await.expect("a listed profile resolves");
        listed.push((id, spawn));
    }
    listed.into_iter().find(|(_, spawn)| reports_activity(spawn)).expect("this machine has a shell with terminal integration (PowerShell, bash, zsh or cmd)").0
}

/// One poll of a future, on the spot: what the future does before its first wait has been done when this returns.
async fn poll_once<F: std::future::Future + Unpin>(future: &mut F) -> std::task::Poll<F::Output> {
    std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *future).poll(cx))).await
}

/// Node forwards a disposed tab's end (`state: null`) before it answers the dispose (terminal-manager.ts:541, remote-relay-push-lanes.ts:150,
/// remote-methods.ts:1284), so a phone has the activity event ahead of the reply. The publication of the tab's end is held at the
/// publisher: the dispose's first poll runs everything it does before its first wait, so it is pending exactly when the reply waits
/// for the held publication, and it is ready (the reply sent with the event still held) when it does not.
#[tokio::test(flavor = "multi_thread")]
async fn a_dispose_is_answered_after_the_activity_it_ended_is_published() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = integrated_service(manager, feeds, publisher.clone(), "dispose-published");
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let integrated = integrated_profile(&service).await;
    service.call(request("terminal/ensure", json!({ "tabId": "term_end", "options": { "cwd": cwd, "profile": integrated } }), 1)).await.unwrap();
    let keys = || -> Vec<String> {
        publisher
            .published()
            .iter()
            .rev()
            .find_map(|(s, _, change)| match (s, change) {
                (SectionName::TerminalActivity, SectionChange::Set(bytes)) => {
                    Some(serde_json::from_slice::<Value>(bytes).unwrap().as_object().unwrap().keys().cloned().collect())
                }
                _ => None,
            })
            .unwrap_or_default()
    };
    publisher.wait_for("the tab has a known activity", |_| keys() == ["term_end"]).await;
    let (held, open) = publisher.hold_next_activity();
    let mut reply = Box::pin(service.call(request("terminal/dispose", json!({ "tabId": "term_end" }), 1)));
    assert!(poll_once(&mut reply).await.is_pending(), "the dispose was answered while the tab's end was still held back from the phone");
    held.recv_timeout(EVENT_DEADLINE).expect("the tab's end never reached the publisher");
    assert!(poll_once(&mut reply).await.is_pending(), "the dispose was answered while the tab's end was still held back from the phone");
    assert_eq!(keys(), ["term_end"], "the tab's end is held, so the phone still sees the tab");
    open.send(()).unwrap();
    tokio::time::timeout(EVENT_DEADLINE, reply).await.expect("the dispose was never answered after the tab's end was published").unwrap();
    assert!(keys().is_empty(), "the tab's end was not published before the reply: {:?}", keys());
}
/// The dispose's hold on the tab's feed (the killed shell's last output and exit line wait behind the answer) is
/// handed to the request's `after_answer`, which the server releases once it has queued the answer: when the call returns, the hold still
/// stands, and it ends with the release.
#[tokio::test(flavor = "multi_thread")]
async fn a_dispose_keeps_its_feed_hold_until_the_answer_is_queued() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher, TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    service.call(request("terminal/ensure", json!({ "tabId": "term_hold", "options": { "cwd": cwd } }), 1)).await.unwrap();
    let dispose = request("terminal/dispose", json!({ "tabId": "term_hold" }), 1);
    let after = dispose.ctx.after_answer.clone();
    service.call(dispose).await.unwrap();
    assert_eq!(format!("{after:?}"), "AfterAnswer(1)", "the feed hold outlives the call until the answer is queued");
    after.release();
    assert_eq!(format!("{after:?}"), "AfterAnswer(0)");
}

/// The ensure's hold on the new tab's feed (the shell's first output waits behind the answer, as in every recorded Node run: runs.json,
/// each tab's first output after its termEnsure answer) is handed to the request's `after_answer` like the dispose's.
#[tokio::test(flavor = "multi_thread")]
async fn an_ensure_keeps_its_feed_hold_until_the_answer_is_queued() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher, TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let ensure = request("terminal/ensure", json!({ "tabId": "term_new", "options": { "cwd": cwd } }), 1);
    let after = ensure.ctx.after_answer.clone();
    service.call(ensure).await.unwrap();
    assert_eq!(format!("{after:?}"), "AfterAnswer(1)", "the feed hold outlives the call until the answer is queued");
    after.release();
    assert_eq!(format!("{after:?}"), "AfterAnswer(0)");
    service.call(request("terminal/dispose", json!({ "tabId": "term_new" }), 1)).await.unwrap();
}

/// No process of a disposed tab's tree is left after the grace, counted by ownership: the tab's own containment (its job, or its process
/// group) is empty. The shell runs a child that would outlive it; the disposal closes the terminal, and once the shell has ended (or the
/// grace has passed) the captured process's tree is ended with everything in it.
#[tokio::test(flavor = "multi_thread")]
async fn a_disposed_tabs_tree_is_empty_after_the_grace() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager.clone(), feeds, publisher, TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    service.call(request("terminal/ensure", json!({ "tabId": "term_tree", "options": { "cwd": cwd } }), 1)).await.unwrap();
    let handle = ProcessHandle::from("term_tree");
    let mut events = manager.subscribe(&handle, Some(0)).unwrap();
    let child = if cfg!(windows) { "ping -n 120 127.0.0.1\r" } else { "sleep 120\r" };
    manager.write_input(&handle, child.as_bytes().to_vec()).unwrap();
    // The child is running once the shell has echoed its command line and (on Windows) ping has written its first line, which names the
    // address again (the line's wording is the system's language).
    let (started, times) = if cfg!(windows) { ("127.0.0.1", 2) } else { ("sleep 120", 1) };
    let mut seen = String::new();
    tokio::time::timeout(WAIT, async {
        while seen.matches(started).count() < times {
            match events.next().await {
                Some(ProcessEvent::Output { bytes, .. }) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                other => panic!("the shell ended before its child ran: {other:?}"),
            }
        }
    })
    .await
    .expect("the child started within the deadline");
    service.call(request("terminal/dispose", json!({ "tabId": "term_tree" }), 1)).await.unwrap();
    let survivors = mixdog_spawn::survivors::ProcessSurvivors::new(manager.clone());
    // The grace is 5 s; the deadline is past it.
    assert!(tokio::time::timeout(WAIT, survivors.wait_gone(&handle, &CancellationToken::new())).await.expect("within the deadline"), "the tab's tree emptied");
    assert!(survivors.survivors(&handle).is_none(), "nothing of the tab's tree is left");
}

/// Node's `termActivity` walked its tab map, so the tabs came in creation order, not sorted by id.
#[tokio::test(flavor = "multi_thread")]
async fn terminal_activity_lists_tabs_in_creation_order() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = integrated_service(manager, feeds, publisher.clone(), "activity-order");
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let integrated = integrated_profile(&service).await;
    // Created in reverse id order: a section sorted by id would list `term_a` first.
    for id in ["term_b", "term_a"] {
        service.call(request("terminal/ensure", json!({ "tabId": id, "options": { "cwd": cwd, "profile": integrated } }), 1)).await.unwrap();
    }
    let keys = || -> Vec<String> {
        publisher
            .published()
            .iter()
            .rev()
            .find_map(|(s, _, change)| match (s, change) {
                (SectionName::TerminalActivity, SectionChange::Set(bytes)) => {
                    let value: Value = serde_json::from_slice(bytes).unwrap();
                    Some(value.as_object().unwrap().keys().cloned().collect())
                }
                _ => None,
            })
            .unwrap_or_default()
    };
    publisher.wait_for("both tabs have a known activity", |_| keys().len() == 2).await;
    assert_eq!(keys(), vec!["term_b".to_owned(), "term_a".to_owned()]);
    service.tabs().dispose_all();
}

/// Node pushed the output of every running terminal to a phone reading the lane, whether or not it had attached: a tab's `process:<id>`
/// feed is live from its ensure, so a `feed/subscribe` finds it.
#[tokio::test(flavor = "multi_thread")]
async fn terminal_ensure_opens_the_output_feed_without_an_attach() {
    let manager = manager();
    let made = scoped();
    let feeds = ProcessFeeds::new(manager.clone(), made.clone());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let tab = "term_feed";
    let Reply::Value(ensured) = service.call(request("terminal/ensure", json!({ "tabId": tab, "options": { "cwd": cwd } }), 1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    // Node answers an ensure with the id it was given (`termEnsure` of `term_ph2_l1`: `{ id: "term_ph2_l1" }`).
    assert_eq!(ensured["id"], json!(tab));
    let ids: Vec<String> = made.ids().iter().map(ToString::to_string).collect();
    // The terminal lane (every phone reading it: Node's relay-lane framing) and the tab's raw feed (the window).
    assert_eq!(ids, vec!["process:relay".to_owned(), format!("process:{tab}")], "the ids, in the mock's sorted order");
    service.tabs().dispose_all();
}

/// The text of the output frames a tap has seen, in order.
fn output_text(frames: &[Value]) -> String {
    use base64::Engine;
    frames
        .iter()
        .filter(|frame| frame["method"] == "process/outputDelta")
        .map(|frame| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(frame["params"]["bytesB64"].as_str().expect("output carries bytes")).unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        })
        .collect()
}

/// A phone reading the terminal lane gets the first output of a tab another connection opens (Node's relay lane pushed every tab's output
/// to every phone reading the lane: remote-relay-push-lanes.ts:85-100). The phone subscribed
/// before the tab existed and does nothing about the tab; the desktop (connection 1) opens it and types into it.
#[tokio::test(flavor = "multi_thread")]
async fn a_phone_reading_the_lane_gets_the_first_output_of_a_tab_another_connection_opens() {
    use mixdog_core_api::ids::FeedId;
    use mixdog_core_api::mock::FeedTap;

    let manager = manager();
    let made = scoped();
    let feeds = ProcessFeeds::new(manager.clone(), made.clone());
    let service = TerminalService::new(manager, feeds, Arc::new(SectionLog::default()), TerminalServiceConfig::default());
    let phone = FeedTap::attach_as(&made.find(&FeedId::from("process:relay")).expect("the terminal lane exists"), 2);
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let tab = "term_first";
    let ensure = request("terminal/ensure", json!({ "tabId": tab, "options": { "cwd": cwd } }), 1);
    let after = ensure.ctx.after_answer.clone();
    service.call(ensure).await.unwrap();
    let raw = FeedTap::attach(&made.find(&FeedId::from(format!("process:{tab}"))).expect("the raw feed exists"));
    after.release();
    let taken =
        tokio::time::timeout(EVENT_DEADLINE, raw.notifications_until(|frames| !output_text(frames).is_empty())).await.expect("the shell wrote no output");
    let first = output_text(&taken);
    let mark = "mixdog_first_output_mark";
    let _ = service.notify(Method("terminal/input"), json!({ "tabId": tab, "data": format!("echo {mark}\r") }), ConnectionId(1));
    let got = tokio::time::timeout(EVENT_DEADLINE, phone.notifications_until(|frames| output_text(frames).contains(mark)))
        .await
        .expect("the phone never got the echoed mark");
    let named = got.iter().filter(|frame| frame["method"] == "process/outputDelta").all(|frame| frame["params"]["processHandle"] == json!(tab));
    assert!(named, "every output frame names its tab: {got:?}");
    let text = output_text(&got);
    assert!(text.starts_with(&first), "the phone's output does not start with the shell's first output {first:?}: {text:?}");
    service.tabs().dispose_all();
}

/// An ensure that names no profile spawns the shell `terminal/profiles` marks as the default (Node's `resolveShellProfile('')`):
/// on Windows that is pwsh before Windows PowerShell, not the manager's bare `powershell.exe`.
#[tokio::test(flavor = "multi_thread")]
async fn an_ensure_without_a_profile_spawns_the_default_profile() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    let default = profiles.as_array().unwrap().iter().find(|p| p["default"] == json!(true)).unwrap()["id"].as_str().unwrap().to_owned();
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    service.call(request("terminal/ensure", json!({ "tabId": "term_default", "options": { "cwd": cwd } }), 1)).await.unwrap();
    let shells: Vec<String> = service.tabs().list_tabs().into_iter().map(|tab| tab.shell).collect();
    assert_eq!(shells, vec![default]);
    service.tabs().dispose_all();
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_ensure_names_a_fresh_tab_and_attach_answers_replay_or_not_running() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    // No tab id: the core spawns a new terminal and answers the id it generated.
    let ensure = |connection: u64| request("terminal/ensure", json!({ "options": { "cwd": cwd } }), connection);
    let Reply::Value(first) = service.call(ensure(1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    let Reply::Value(second) = service.call(ensure(1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    let (first, second) = (first["id"].as_str().unwrap().to_owned(), second["id"].as_str().unwrap().to_owned());
    assert_ne!(first, second, "each ensure without an id is a new terminal");

    // attach to a running tab answers Node's `{id, replay, sizeOwner}`.
    let Reply::Subscribe(sub) = service.call(request("terminal/attach", json!({ "tabId": first }), 1)).await.unwrap() else {
        panic!("terminal/attach answers with a subscription");
    };
    assert_eq!(sub.result["id"], json!(first));
    assert!(sub.result["replay"].is_string());

    // The claim stays after the view leaves the tab (`focused: false`).
    service.notify(Method("terminal/resize"), json!({ "tabId": first, "cols": 90, "rows": 25, "claim": true }), ConnectionId(1));
    // Node answers a focus with null, and an attach of an id that is not running with null (`termFocus`, `termAttach`).
    let Reply::Value(focused) = service.call(request("terminal/focus", json!({ "tabId": first, "focused": false }), 1)).await.unwrap() else {
        panic!("terminal/focus answers with a value");
    };
    assert_eq!(focused, json!({}));
    assert_eq!(service.tabs().size_owner(&first).map(|o| o.owner), Some("1".to_owned()));

    // A tab that is not running is Node's `null`, and nothing is spawned.
    let Reply::Value(none) = service.call(request("terminal/attach", json!({ "tabId": "term_never" }), 1)).await.unwrap() else {
        panic!("an unknown tab answers with a value");
    };
    assert_eq!(none, Value::Null, "the answer for an id that is not running");
    service.tabs().dispose_all();
}

#[tokio::test(flavor = "multi_thread")]
async fn ports_are_sampled_only_while_a_connection_views_them() {
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&reads);
    let (sampled, mut first_sample) = tokio::sync::mpsc::unbounded_channel::<()>();
    let service = SystemService::with_source(scoped(), Duration::from_millis(20), move || {
        counted.fetch_add(1, Ordering::SeqCst);
        let _ = sampled.send(());
        Ok(vec![ListeningPort { port: 8080, addresses: vec!["127.0.0.1".into()], process: Some("x".into()), pid: Some(1) }])
    });
    assert_eq!(service.sampler_threads(), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0, "nothing is read before someone views");

    let Reply::Subscribe(sub) = service.call(request("system/ports/subscribe", json!({}), 7)).await.unwrap() else {
        panic!("system/ports/subscribe answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), "ports");
    tokio::time::timeout(EVENT_DEADLINE, first_sample.recv())
        .await
        .unwrap_or_else(|_| panic!("the sampler read nothing within {EVENT_DEADLINE:?} of the first viewer"));
    assert_eq!(service.sampler_threads(), 1);

    // A second viewer shares the one sampler; the first leaving keeps it, the last stops it.
    service.call(request("system/ports/subscribe", json!({}), 8)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.call(request("system/ports/unsubscribe", json!({}), 7)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.connection_closed(ConnectionId(8));
    // The sampler thread's end is signalled; once it has ended nothing calls the source again.
    let waiter = Arc::clone(&service);
    let stopped = tokio::task::spawn_blocking(move || waiter.wait_samplers_stopped(EVENT_DEADLINE)).await.unwrap();
    assert!(stopped, "the sampler thread still ran {EVENT_DEADLINE:?} after the last viewer left");
    assert_eq!(service.sampler_threads(), 0, "no sampling once nobody views");
}

/// The ports a `feed/snapshot` carries the way the desktop's link reads them: `state.sections`, the `ports` section's `value`.
fn snapshot_ports(frame: &Value) -> Option<Vec<Value>> {
    if frame["method"] != "feed/snapshot" {
        return None;
    }
    let sections = frame["params"]["state"]["sections"].as_array()?;
    let section = sections.iter().find(|section| section["section"] == "ports")?;
    section["value"].as_array().cloned()
}

fn carries_port(frame: &Value, port: u16) -> bool {
    let listed = |value: Option<&Vec<Value>>| value.is_some_and(|ports| ports.iter().any(|p| p["port"] == json!(port)));
    listed(snapshot_ports(frame).as_ref()) || listed(frame["params"]["value"].as_array())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_that_joins_late_gets_the_listening_ports_in_the_section_snapshot() {
    let feeds = scoped();
    // The source never changes: after the first sample nothing is published, so a late viewer has only its snapshot.
    let service = SystemService::with_source(feeds.clone(), Duration::from_millis(20), || {
        Ok(vec![ListeningPort { port: 8099, addresses: vec!["127.0.0.1".into()], process: None, pid: None }])
    });
    service.call(request("system/ports/subscribe", json!({}), 7)).await.unwrap();
    let feed = feeds.find(&mixdog_core_api::ids::FeedId::from("ports")).expect("the ports feed exists once viewed");
    let first = mixdog_core_api::mock::FeedTap::attach_as(&feed, 7);
    tokio::time::timeout(EVENT_DEADLINE, first.notifications_until(|frames| frames.iter().any(|frame| carries_port(frame, 8099))))
        .await
        .expect("the first viewer never got the ports");

    service.call(request("system/ports/subscribe", json!({}), 8)).await.unwrap();
    let late = mixdog_core_api::mock::FeedTap::attach_as(&feed, 8);
    let frames = tokio::time::timeout(EVENT_DEADLINE, late.notifications_until(|frames| !frames.is_empty())).await.expect("the late viewer never got a frame");
    let ports = snapshot_ports(&frames[0]).expect("the late viewer's first frame is a snapshot with the ports section");
    assert_eq!(ports.iter().map(|port| port["port"].clone()).collect::<Vec<_>>(), [json!(8099)]);
}
#[tokio::test(flavor = "multi_thread")]
async fn terminal_service_ensures_publishes_tabs_and_disposes() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());

    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    assert_eq!(profiles.as_array().unwrap().iter().filter(|p| p["default"] == json!(true)).count(), 1);

    let ensure = json!({ "tabId": "term_svc", "options": { "cwd": temp_dir().as_path().to_string_lossy() } });
    let Reply::Value(ensured) = service.call(request("terminal/ensure", ensure, 1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    let id = ensured["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("term_"));

    let Reply::Subscribe(sub) = service.call(request("terminal/attach", json!({ "tabId": id }), 1)).await.unwrap() else {
        panic!("terminal/attach answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), format!("process:{id}"));
    publisher.wait_for("the tab list section", |sections| sections.iter().any(|(s, _, _)| *s == SectionName::TerminalTabs)).await;

    service.call(request("terminal/dispose", json!({ "tabId": id }), 1)).await.unwrap();
    // A tab that is not running is Node's `null` (termAttach), not an error.
    let Reply::Value(gone) = service.call(request("terminal/attach", json!({ "tabId": id }), 1)).await.unwrap() else {
        panic!("a disposed tab answers with a value");
    };
    assert_eq!(gone, Value::Null);
}
