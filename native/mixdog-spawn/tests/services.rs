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
use mixdog_protocol::ProcessHandle;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::Origin;
use mixdog_protocol::SectionName;
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
    CoreRequest {
        method: Method(method),
        params,
        op: None,
        ctx: CallContext::connection(ConnectionId(connection), Origin::Local, CancellationToken::new()),
    }
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
        let waited = tokio::time::timeout(Duration::from_secs(10), async {
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
    service
        .call(request("process/kill", json!({ "processHandle": name }), 1))
        .await
        .unwrap();
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
    service.notify(
        Method("process/input"),
        json!({ "processHandle": sorter, "bytesB64": STANDARD.encode("b\r\n") }),
        ConnectionId(1),
    );
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
    let Reply::Value(ensured) = service
        .call(request("terminal/ensure", json!({ "tabId": "term_own", "options": { "cwd": cwd } }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/ensure answers with a value");
    };
    let id = ensured["id"].as_str().unwrap().to_owned();
    // The sizes are the claims Node recorded in the phone replay (apps/mobile/fixtures/phone-terminal/golden.json, trace.claims.order, the `sizeOwner` pushes in
    // the order the phone got them): the first claim of a tab (`own`, its size) and the claim released by a non-positive size.
    let golden: Value = serde_json::from_str(include_str!("../../../apps/mobile/fixtures/phone-terminal/golden.json")).unwrap();
    let owners: Vec<&Value> = golden["trace"]["claims"]["order"].as_array().unwrap().iter().filter(|e| e["push"] == "sizeOwner").map(|e| &e["event"]).collect();
    let (claimed, released) = (owners[0], owners[3]);
    assert_eq!((claimed["own"].clone(), released["own"].clone()), (json!(true), json!(false)), "the recorded claim owns, the recorded release does not");
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

    for method in ["terminal/pause", "terminal/resume"] {
        let reply = service.call(request(method, json!({ "tabId": id }), 2)).await.unwrap();
        assert!(matches!(reply, Reply::Value(ref v) if v == &json!({})), "{method} answers with an empty result");
    }
    service.call(request("terminal/dispose", json!({ "tabId": id }), 2)).await.unwrap();
}

/// Node's answers to the calls named `name`, in the order the recording made them (golden.json, trace.order).
fn recorded_calls(name: &str) -> Vec<Value> {
    let golden: Value = serde_json::from_str(include_str!("../../../apps/mobile/fixtures/phone-terminal/golden.json")).unwrap();
    golden["trace"]["order"].as_array().unwrap().iter().filter(|e| e["call"] == name).cloned().collect()
}

/// Claims belong to the id, not to a running tab. Node announces a claim and a release whether or not a PTY exists, and disposing an id that has
/// no tab forgets nothing (terminal-manager.ts:454-487, :536). Recorded: apps/mobile/fixtures/phone-terminal/golden.json, trace.claims.order,
/// the `sizeOwner` pushes of `term_ph2_none` and the `termDispose` between the first and the second.
#[tokio::test(flavor = "multi_thread")]
async fn a_claim_on_an_id_without_a_tab_is_published_and_a_dispose_of_it_forgets_nothing() {
    let golden: Value = serde_json::from_str(include_str!("../../../apps/mobile/fixtures/phone-terminal/golden.json")).unwrap();
    let order = golden["trace"]["claims"]["order"].as_array().unwrap();
    let first = order.iter().position(|e| e["push"] == "sizeOwner" && e["event"]["id"] == "term_ph2_none").expect("the recording claims an id with no tab");
    assert_eq!(order[first + 1]["call"], "termDispose", "the recording disposes the id after its first claim");
    assert_eq!(order[first + 1]["params"], json!(["term_ph2_none"]));
    let announced: Vec<&Value> = order.iter().filter(|e| e["push"] == "sizeOwner" && e["event"]["id"] == "term_ph2_none").map(|e| &e["event"]).collect();
    // What the recording's script did, in its order: the phone claims, the other connection claims, the other releases, the phone releases.
    let sizes: Vec<(u64, u64, bool)> = announced.iter().map(|e| (e["cols"].as_u64().unwrap(), e["rows"].as_u64().unwrap(), e["own"].as_bool().unwrap())).collect();
    assert_eq!(sizes.len(), 4, "{sizes:?}");

    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let client_of = |connection: u64| {
        let service = Arc::clone(&service);
        let cwd = cwd.clone();
        async move {
            let Reply::Value(ensured) = service.call(request("terminal/ensure", json!({ "tabId": "term_bystander", "options": { "cwd": cwd } }), connection)).await.unwrap() else {
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
    let claim = |connection: u64, cols: u64, rows: u64| service.notify(Method("terminal/resize"), json!({ "tabId": "term_ph2_none", "cols": cols, "rows": rows, "claim": true }), ConnectionId(connection));

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

/// A shell with the marker integration (only such a shell reports activity); the test picks one itself, so it does not depend on which
/// shell the machine defaults to.
async fn integrated_profile(service: &TerminalService) -> String {
    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    profiles
        .as_array()
        .unwrap()
        .iter()
        .find(|p| {
            let path = p["path"].as_str().unwrap().to_lowercase().replace('\\', "/");
            let name = path.rsplit('/').next().unwrap().trim_end_matches(".exe");
            // System32's bash.exe is the WSL launcher, which the integration leaves alone.
            matches!(name, "pwsh" | "powershell" | "zsh") || (name == "bash" && !path.contains("/system32/"))
        })
        .expect("this machine has a shell with terminal integration (PowerShell, bash or zsh)")["id"]
        .as_str()
        .unwrap()
        .to_owned()
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
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let integrated = integrated_profile(&service).await;
    service.call(request("terminal/ensure", json!({ "tabId": "term_end", "options": { "cwd": cwd, "profile": integrated } }), 1)).await.unwrap();
    let keys = || -> Vec<String> {
        publisher
            .published()
            .iter()
            .rev()
            .find_map(|(s, _, change)| match (s, change) {
                (SectionName::TerminalActivity, SectionChange::Set(bytes)) => Some(serde_json::from_slice::<Value>(bytes).unwrap().as_object().unwrap().keys().cloned().collect()),
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
    tokio::time::timeout(Duration::from_secs(10), reply).await.expect("the dispose was never answered after the tab's end was published").unwrap();
    assert!(keys().is_empty(), "the tab's end was not published before the reply: {:?}", keys());
}
/// Node's `termActivity` walked its tab map, so the tabs came in creation order, not sorted by id.
#[tokio::test(flavor = "multi_thread")]
async fn terminal_activity_lists_tabs_in_creation_order() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let integrated = integrated_profile(&service).await;
    // Created in reverse id order: a section sorted by id would list `term_a` first.
    for id in ["term_b", "term_a"] {
        service
            .call(request("terminal/ensure", json!({ "tabId": id, "options": { "cwd": cwd, "profile": integrated } }), 1))
            .await
            .unwrap();
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
    let Reply::Value(ensured) = service
        .call(request("terminal/ensure", json!({ "tabId": tab, "options": { "cwd": cwd } }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/ensure answers with a value");
    };
    // Node answers an ensure with the id it was given (phone-terminal golden.json, `termEnsure` of `term_ph2_l1`: `{ id: "term_ph2_l1" }`).
    assert_eq!(ensured["id"], json!(tab));
    let ids: Vec<String> = made.ids().iter().map(ToString::to_string).collect();
    assert_eq!(ids, vec![format!("process:{tab}")]);
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
    // Node's 	ermProfiles on the recording's machine marks pwsh as the default; the same machine's list does here.
    if cfg!(windows) {
        let recorded = recorded_calls("termProfiles").remove(0);
        let node_default = recorded["value"].as_array().unwrap().iter().find(|p| p["default"] == json!(true)).unwrap()["id"].clone();
        assert_eq!(json!(default), node_default, "the default profile is the one Node marked");
    }
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
    // Node answers a focus with null, and an attach of an id that is not running with null (golden.json: termFocus, termAttach).
    let Reply::Value(focused) = service.call(request("terminal/focus", json!({ "tabId": first, "focused": false }), 1)).await.unwrap() else {
        panic!("terminal/focus answers with a value");
    };
    assert_eq!(focused, json!({}));
    assert_eq!(service.tabs().size_owner(&first).map(|o| o.owner), Some("1".to_owned()));

    // A tab that is not running is Node's `null`, and nothing is spawned.
    let Reply::Value(none) = service.call(request("terminal/attach", json!({ "tabId": "term_never" }), 1)).await.unwrap() else {
        panic!("an unknown tab answers with a value");
    };
    assert_eq!(none, recorded_calls("termAttach").iter().find(|call| call.get("value").is_some_and(Value::is_null)).expect("the recording has an attach of an id that is not running")["value"], "Node's answer for an id that is not running");
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

    let Reply::Subscribe(sub) = service
        .call(request("terminal/attach", json!({ "tabId": id }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/attach answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), format!("process:{id}"));
    publisher
        .wait_for("the tab list section", |sections| sections.iter().any(|(s, _, _)| *s == SectionName::TerminalTabs))
        .await;

    service.call(request("terminal/dispose", json!({ "tabId": id }), 1)).await.unwrap();
    // A tab that is not running is Node's `null` (termAttach), not an error.
    let Reply::Value(gone) = service.call(request("terminal/attach", json!({ "tabId": id }), 1)).await.unwrap() else {
        panic!("a disposed tab answers with a value");
    };
    assert_eq!(gone, Value::Null);
}
