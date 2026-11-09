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

async fn until(_what: &str, mut ok: impl FnMut() -> bool) {
    while !ok() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

type Published = Vec<(SectionName, Option<String>, SectionChange)>;

/// The section publisher the terminal tests read: every publication wakes the waiters, so a test
/// waits for the publication its assertion reads, never for a count of ticks.
#[derive(Default)]
struct SectionLog {
    inner: MockStatePublisher,
    pushed: tokio::sync::Notify,
}

impl SectionLog {
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

    service
        .call(request("process/kill", json!({ "processHandle": name }), 1))
        .await
        .unwrap();
    until("the killed process to end", || !pid_alive(pid)).await;
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
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 100, "rows": 30, "claim": true }), ConnectionId(1));
    let mine = attach(1).await;
    assert_eq!((mine["own"].clone(), mine["cols"].clone(), mine["rows"].clone()), (json!(true), json!(100), json!(30)));
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
    assert_eq!(owner_in_section(), first.clone().map(|c| (c, 100, 30)));

    // A resize that is not a claim is ignored while one stands.
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 70, "rows": 20 }), ConnectionId(2));
    assert_eq!(attach(1).await["cols"], json!(100));

    // The owner's connection closing releases nothing: its lease does.
    service.connection_closed(ConnectionId(1));
    assert_eq!(attach(2).await["cols"], json!(100));
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 0, "rows": 0, "claim": true }), ConnectionId(1));
    assert_eq!(attach(2).await, Value::Null);

    for method in ["terminal/pause", "terminal/resume"] {
        let reply = service.call(request(method, json!({ "tabId": id }), 2)).await.unwrap();
        assert!(matches!(reply, Reply::Value(ref v) if v == &json!({})), "{method} answers with an empty result");
    }
    service.call(request("terminal/dispose", json!({ "tabId": id }), 2)).await.unwrap();
}

/// Node's `termActivity` walked its tab map, so the tabs came in creation order, not sorted by id.
#[tokio::test(flavor = "multi_thread")]
async fn terminal_activity_lists_tabs_in_creation_order() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(SectionLog::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    // Only a shell with the marker integration reports activity; the test picks one itself, so it
    // does not depend on which shell the machine defaults to.
    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    let integrated = profiles
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
        .to_owned();
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
    let Reply::Value(ensured) = service
        .call(request("terminal/ensure", json!({ "tabId": "term_feed", "options": { "cwd": cwd } }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/ensure answers with a value");
    };
    assert_eq!(ensured["id"], json!("term_feed"));
    let ids: Vec<String> = made.ids().iter().map(ToString::to_string).collect();
    assert_eq!(ids, vec!["process:term_feed".to_owned()]);
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
    service.call(request("terminal/focus", json!({ "tabId": first, "focused": false }), 1)).await.unwrap();
    assert_eq!(service.tabs().size_owner(&first).map(|o| o.owner), Some("1".to_owned()));

    // A tab that is not running is Node's `null`, and nothing is spawned.
    let Reply::Value(none) = service.call(request("terminal/attach", json!({ "tabId": "term_never" }), 1)).await.unwrap() else {
        panic!("an unknown tab answers with a value");
    };
    assert_eq!(none, Value::Null);
    service.tabs().dispose_all();
}

#[tokio::test(flavor = "multi_thread")]
async fn ports_are_sampled_only_while_a_connection_views_them() {
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&reads);
    let service = SystemService::with_source(scoped(), Duration::from_millis(20), move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(vec![ListeningPort { port: 8080, addresses: vec!["127.0.0.1".into()], process: Some("x".into()), pid: Some(1) }])
    });
    assert_eq!(service.sampler_threads(), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0, "nothing is read before someone views");

    let Reply::Subscribe(sub) = service.call(request("system/ports/subscribe", json!({}), 7)).await.unwrap() else {
        panic!("system/ports/subscribe answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), "ports");
    until("the first sample", || reads.load(Ordering::SeqCst) > 0).await;
    assert_eq!(service.sampler_threads(), 1);

    // A second viewer shares the one sampler; the first leaving keeps it, the last stops it.
    service.call(request("system/ports/subscribe", json!({}), 8)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.call(request("system/ports/unsubscribe", json!({}), 7)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.connection_closed(ConnectionId(8));
    until("the sampler to stop", || service.sampler_threads() == 0).await;
    let settled = reads.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(reads.load(Ordering::SeqCst), settled, "no sampling once nobody views");
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
