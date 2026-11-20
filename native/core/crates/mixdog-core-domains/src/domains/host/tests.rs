use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;

use super::*;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;

#[derive(Default)]
struct Spy {
    targets: Mutex<Vec<Option<RemoteTarget>>>,
    power: Mutex<Vec<PowerEvent>>,
    clicks: Mutex<Vec<String>>,
    surfaces: Mutex<Vec<UiOpenBrowser>>,
    display_changes: Mutex<u32>,
    stops: Mutex<Vec<String>>,
}

impl ScreenEvents for Spy {
    fn displays_changed(&self) {
        *self.display_changes.lock().unwrap() += 1;
    }

    fn indicator_stopped(&self, screen_id: &str) {
        self.stops.lock().unwrap().push(screen_id.to_owned());
    }
}

impl BrowserSurfaces for Spy {
    fn requested(&self, request: UiOpenBrowser) {
        self.surfaces.lock().unwrap().push(request);
    }
}

impl RemoteBridge for Spy {
    fn set_target(&self, target: Option<RemoteTarget>) {
        self.targets.lock().unwrap().push(target);
    }
}

impl PowerSink for Spy {
    fn power(&self, event: PowerEvent) {
        self.power.lock().unwrap().push(event);
    }
}

impl NotificationClicks for Spy {
    fn clicked(&self, thread: &ThreadId) {
        self.clicks.lock().unwrap().push(thread.to_string());
    }
}

fn rig() -> (Arc<HostService>, Arc<MockStatePublisher>, Arc<Spy>) {
    let (service, publisher, spy, _) = rig_with_panes();
    (service, publisher, spy)
}

fn rig_with_panes() -> (Arc<HostService>, Arc<MockStatePublisher>, Arc<Spy>, Arc<mixdog_exthost::VisualizePanes>) {
    let publisher = Arc::new(MockStatePublisher::default());
    let spy = Arc::new(Spy::default());
    let panes = Arc::new(mixdog_exthost::VisualizePanes::default());
    (HostService::new(publisher.clone(), spy.clone(), spy.clone(), spy.clone(), spy.clone(), spy.clone(), panes.clone()), publisher, spy, panes)
}

/// What the core handed the phones that view a session: the session, whether everyone gets it, and the payloads in order.
#[derive(Default)]
struct Pushed(Mutex<Vec<(String, bool, Vec<Value>)>>);

impl mixdog_exthost::VisualizePush for Pushed {
    fn push(&self, session_id: &str, everyone: bool, payloads: Vec<Value>) {
        self.0.lock().unwrap().push((session_id.to_owned(), everyone, payloads));
    }

    fn set_lane(&self, _: ConnectionId, _: bool) {}
}

/// A text value nested far past the frame's depth, holding a lone surrogate, is refused, not walked.
#[tokio::test]
async fn a_deeply_nested_visualize_text_with_a_lone_surrogate_is_refused() {
    let (service, _, _) = rig();
    let text = format!("{}\"\\ud800\"{}", "[".repeat(20_000), "]".repeat(20_000));
    assert!(service.call(from_claim(true, Value::String(text))).await.is_err());
}

/// A request as a connection sends a `host/state/set`; `claimant` is what the claim table answers when it is applied.
fn from_claim(claimant: bool, value: Value) -> CoreRequest {
    let mut ctx = mixdog_core_api::CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    ctx.visualize_claim = mixdog_core_api::call::ClaimProbe::new(move || claimant);
    CoreRequest { method: Method("host/state/set"), params: json!({ "key": "visualize", "value": value }), op: None, ctx }
}
#[test]
fn a_browser_surface_request_reaches_the_open_feed_and_a_malformed_one_is_dropped() {
    let (service, _, spy) = rig();
    let from = ConnectionId(1);
    service.notify(Method("host/browser/surface"), json!({ "sessionId": "s1", "reveal": true, "tabId": "p1", "title": "Docs" }), from);
    service.notify(Method("host/browser/surface"), json!({ "hide": true }), from);
    let seen = spy.surfaces.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].session_id, "s1");
    assert_eq!(seen[0].reveal, Some(true));
    assert_eq!(seen[0].tab_id.as_deref(), Some("p1"));
    assert_eq!(seen[0].hide, None);
}

fn set(change: &SectionChange) -> Value {
    match change {
        SectionChange::Set(bytes) => serde_json::from_slice(bytes).unwrap(),
        other => panic!("not a set: {other:?}"),
    }
}

#[tokio::test]
async fn desktop_state_is_published_under_its_key() {
    let (service, publisher, _) = rig();
    let tabs = json!([{ "id": "t1", "title": "Docs", "url": "https://example.com", "loading": false }]);
    let reply = value(&*service, request("host/state/set", json!({ "key": "browserTabs", "value": tabs }), None)).await.unwrap();
    assert_eq!(reply, json!({}));
    let published = publisher.published();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].0, SectionName::HostState);
    assert_eq!(published[0].1.as_deref(), Some("browserTabs"));
    assert_eq!(set(&published[0].2), tabs);
    // A key outside the four is not a request.
    assert!(matches!(service.call(request("host/state/set", json!({ "key": "other", "value": 1 }), None)).await, Err(CoreError::InvalidParams { .. })));
}

#[tokio::test]
async fn losing_a_desktop_host_removes_only_its_browser_dialog_marks() {
    let (service, publisher, _) = rig();
    let first = mixdog_rt::CancellationToken::new();
    let second = mixdog_rt::CancellationToken::new();
    let report = |owner, cancel, ids| {
        let mut ctx = mixdog_core_api::CallContext::connection(ConnectionId(owner), Origin::Local, cancel);
        ctx.host_claimant = true;
        CoreRequest { method: Method("host/state/set"), params: json!({ "key": "browserDialogApprovalSessions", "value": ids }), op: None, ctx }
    };
    service.call(report(1, first.clone(), vec!["one", "shared"])).await.unwrap();
    service.call(report(2, second.clone(), vec!["two", "shared"])).await.unwrap();
    first.cancel();
    service.connection_closed(ConnectionId(1));
    assert!(matches!(service.call(report(1, first, vec!["one"])).await, Err(CoreError::ConnectionClosed)));
    second.cancel();
    service.connection_closed(ConnectionId(2));
    let lists: Vec<_> = publisher.published().iter().map(|(_, _, change)| set(change)).collect();
    assert_eq!(lists, vec![json!(["one", "shared"]), json!(["one", "shared", "two"]), json!(["shared", "two"]), json!([])]);
}

#[tokio::test]
async fn the_remote_target_is_a_loopback_tunnel_or_absent() {
    let (service, _, spy) = rig();
    value(&*service, request("host/remoteTarget/set", json!({ "endpoint": "ws://127.0.0.1:52100/rpc", "token": "t" }), None)).await.unwrap();
    value(&*service, request("host/remoteTarget/set", json!({}), None)).await.unwrap();
    assert_eq!(*spy.targets.lock().unwrap(), vec![Some(RemoteTarget { endpoint: "ws://127.0.0.1:52100/rpc".into(), token: Some("t".into()) }), None]);
    for endpoint in ["wss://127.0.0.1:1/rpc", "ws://example.com:80/rpc", "ws://127.0.0.1/rpc", "nonsense"] {
        assert!(
            matches!(service.call(request("host/remoteTarget/set", json!({ "endpoint": endpoint }), None)).await, Err(CoreError::InvalidParams { .. })),
            "{endpoint}"
        );
    }
    assert_eq!(spy.targets.lock().unwrap().len(), 2);
}

#[test]
fn notifications_reach_their_consumers() {
    let (service, publisher, spy) = rig();
    let from = ConnectionId(1);
    service.notify(Method("host/power"), json!({ "event": "suspend" }), from);
    service.notify(Method("host/power"), json!({ "event": "resume" }), from);
    service.notify(Method("host/power"), json!({ "event": "sleep" }), from);
    service.notify(Method("host/notification/clicked"), json!({ "threadId": "th-1" }), from);
    service.notify(Method("host/update/report"), json!({ "state": { "phase": "downloaded", "version": "1.4.6" } }), from);
    assert_eq!(*spy.power.lock().unwrap(), vec![PowerEvent::Suspend, PowerEvent::Resume]);
    assert_eq!(*spy.clicks.lock().unwrap(), vec!["th-1".to_owned()]);
    let published = publisher.published();
    assert_eq!((published[0].0, published[0].1.as_deref()), (SectionName::Update, None));
    assert_eq!(set(&published[0].2), json!({ "phase": "downloaded", "version": "1.4.6" }));
}

#[test]
fn the_bridge_binding_is_published_as_host_state_remote_session() {
    let publisher = MockStatePublisher::default();
    publish_remote_session(&publisher, true, Some("phone_1"), None);
    let published = publisher.published();
    assert_eq!(published.len(), 1);
    assert_eq!((published[0].0, published[0].1.as_deref()), (SectionName::HostState, Some("remoteSession")));
}

/// A display change carries no params and reaches the screen sessions once each; the pill's Stop names the session it ends, and a stop
/// without a session id ends nothing.
#[test]
fn the_screen_reports_of_the_desktop_reach_the_screen_sessions() {
    let (service, _, spy) = rig();
    let from = ConnectionId(1);
    service.notify(Method("host/screen/displaysChanged"), json!({}), from);
    service.notify(Method("host/screen/displaysChanged"), json!({}), from);
    service.notify(Method("host/screen/indicator/stop"), json!({ "screenId": "2" }), from);
    service.notify(Method("host/screen/indicator/stop"), json!({}), from);
    assert_eq!(*spy.display_changes.lock().unwrap(), 2);
    assert_eq!(*spy.stops.lock().unwrap(), vec!["2".to_owned()]);
    assert!(service.methods().contains(&"host/screen/displaysChanged") && service.methods().contains(&"host/screen/indicator/stop"));
}

#[test]
fn remote_viewing_lists_the_visualize_panels_paired_devices_view() {
    let registry = DeviceRegistry::default();
    registry.connect_local(1, "desk", mixdog_remote::registry::LocalKind::Desktop);
    registry.connect_relay(2, "peer-a");
    let panels = ["b".to_owned(), "a".to_owned()];
    let report = |panels| mixdog_remote::registry::ScreenReport {
        sessions: Some(["screen".to_owned()].into_iter().collect()),
        browser_id: None,
        visualize: Some(panels),
        foreground: None,
    };
    registry.report_screen(2, report(&panels));
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": [] }), "a peer that is not paired shows nothing");
    registry.attach_peer("peer-a", "cred-a", "Pixel", "Safari");
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": ["a", "b"] }), "the screen set is not the panel set");
    registry.disconnect(2);
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": [] }));
}

/// The visualize state the desktop sets is folded into the core's copy of its panes, whatever the section publishes: the
/// snapshot Node's mirror was given in `fixtures/phone-guards/golden.json` makes its PDF pane a page file, and an event that
/// empties the session takes it away (`createRemoteVisualizeMirror` `replace` / `apply`).
#[tokio::test]
async fn the_visualize_state_set_by_the_desktop_is_folded_into_the_panes() {
    let snapshot = visualize_snapshot();
    let tab = &snapshot[0]["tabs"][0];
    let (cwd, pdf) = (tab["cwd"].as_str().unwrap().to_owned(), tab["panes"][0]["path"].as_str().unwrap().to_owned());
    let rel = std::path::Path::new(&pdf).strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
    let (service, _, _, panes) = rig_with_panes();
    let set = |value: Value| service.call(from_claim(true, value));
    assert!(!panes.page_file(std::path::Path::new(&cwd), &rel));
    set(snapshot.clone()).await.unwrap();
    assert!(panes.page_file(std::path::Path::new(&cwd), &rel));
    set(json!({ "sessionId": "s1", "state": { "sessionId": "s1", "tabs": [], "active": null } })).await.unwrap();
    assert!(!panes.page_file(std::path::Path::new(&cwd), &rel));
}
/// The `hostState` `visualize` section is readable by a paired phone's subscription, so no host path ever reaches it or a phone's
/// notification. A snapshot is the section's (state alone); an event goes to the phones that view its session whole, as Node pushed
/// it: the state it announces and its own effect fields exactly as the producer gave them, `held` absent when the producer left it out.
#[tokio::test]
async fn visualize_events_go_to_viewers_whole_and_path_free_and_the_section_holds_the_current_state() {
    let snapshot = visualize_snapshot();
    let tab = &snapshot[0]["tabs"][0];
    let (cwd, pdf) = (tab["cwd"].as_str().unwrap().to_owned(), tab["panes"][0]["path"].as_str().unwrap().to_owned());
    let (service, publisher, _, panes) = rig_with_panes();
    let pushed = Arc::new(Pushed::default());
    panes.bind_push(pushed.clone());
    let send = |value: Value| service.call(from_claim(true, value));
    let session = snapshot[0]["sessionId"].clone();
    send(snapshot.clone()).await.unwrap();
    send(json!({ "sessionId": session, "state": snapshot[0].clone(), "reveal": true, "tab": "t1", "updated": "t1", "held": true, "heldSince": 7 }))
        .await
        .unwrap();
    // The turn is released: the producer publishes the state without `held`.
    send(json!({ "sessionId": session, "state": snapshot[0].clone() })).await.unwrap();
    send(json!({ "sessionId": session, "openUrl": "https://a.test/" })).await.unwrap();
    let published = publisher.published();
    assert_eq!(published.len(), 4, "every publication updates the section, which holds the current state");
    for (_, _, change) in &published {
        let current = set(change);
        assert!(current.is_array() && !current.to_string().contains(&cwd), "the section holds the current path-free states");
    }
    assert!(set(&published[3].2).as_array().unwrap().len() == 1, "the session is still kept after the release");
    let pushed = pushed.0.lock().unwrap();
    assert_eq!(pushed.len(), 3);
    for (_, _, payloads) in pushed.iter() {
        let text = serde_json::to_string(payloads).unwrap();
        assert!(!text.contains(&cwd) && !text.contains(&pdf), "a host path reached a phone: {text}");
    }
    let held = &pushed[0].2[0];
    assert_eq!(
        (held["reveal"].clone(), held["tab"].clone(), held["held"].clone(), held["heldSince"].clone()),
        (json!(true), json!("t1"), json!(true), json!(7))
    );
    assert!(held["state"]["tabs"].as_array().is_some_and(|tabs| !tabs.is_empty()), "the event carries the state it announces");
    let released = &pushed[1].2[0];
    assert!(released.get("held").is_none() && released.get("reveal").is_none(), "no effect is invented: held stays absent, as published");
    assert_eq!((pushed[0].1, pushed[2].1), (false, true), "only a URL to open goes to every phone");
}
/// The state a snapshot read returns says whether its session is held now and since when, exactly as the producer last published it: held
/// while its events carry `held`, released by the state-bearing event without it; a producer snapshot carries none.
#[tokio::test]
async fn the_state_read_says_whether_a_session_is_held_as_the_producer_last_published_it() {
    let snapshot = visualize_snapshot();
    let session = snapshot[0]["sessionId"].clone();
    let (service, _, _, panes) = rig_with_panes();
    let send = |value: Value| service.call(from_claim(true, value));
    send(snapshot.clone()).await.unwrap();
    assert!(panes.remote_states()[0].get("held").is_none(), "a snapshot that says nothing of holds holds nothing");
    send(json!({ "sessionId": session, "state": snapshot[0].clone(), "held": true, "heldSince": 7 })).await.unwrap();
    let held = &panes.remote_states()[0];
    assert_eq!((held["held"].clone(), held["heldSince"].clone()), (json!(true), json!(7)));
    // An event without a state (a URL to open) does not change the hold.
    send(json!({ "sessionId": session, "openUrl": "https://a.test/" })).await.unwrap();
    assert_eq!(panes.remote_states()[0]["held"], json!(true));
    send(json!({ "sessionId": session, "state": snapshot[0].clone() })).await.unwrap();
    let released = &panes.remote_states()[0];
    assert!(released.get("held").is_none() && released.get("heldSince").is_none(), "the release is the state without `held`");
    // A reclaim: the producer's snapshot reports its holds per session, and the map it replaces is exactly that.
    let mut during = snapshot.clone();
    during[0]["held"] = json!(true);
    during[0]["heldSince"] = json!(9);
    send(during).await.unwrap();
    let after_reclaim = &panes.remote_states()[0];
    assert_eq!((after_reclaim["held"].clone(), after_reclaim["heldSince"].clone()), (json!(true), json!(9)), "a phone's read keeps the turn held");
    send(snapshot.clone()).await.unwrap();
    assert!(panes.remote_states()[0].get("held").is_none(), "a snapshot after the release shows it released");
}
/// An event too large for one control frame goes out as ordered parts whose texts, joined, are the event whole, and one session's
/// empty state followed by a reopen are two events, each with its own state.
#[tokio::test]
async fn a_large_event_goes_out_as_ordered_parts_that_rebuild_it_and_empty_then_reopen_are_two_events() {
    let snapshot = visualize_snapshot();
    let session = snapshot[0]["sessionId"].clone();
    let (service, _, _, panes) = rig_with_panes();
    let pushed = Arc::new(Pushed::default());
    panes.bind_push(pushed.clone());
    let send = |value: Value| service.call(from_claim(true, value));
    send(json!({ "sessionId": session, "state": { "sessionId": session, "tabs": [], "active": null } })).await.unwrap();
    let mut big = snapshot[0].clone();
    big["tabs"][0]["label"] = json!("x".repeat(300_000));
    send(json!({ "sessionId": session, "state": big, "reveal": true, "tab": "t1" })).await.unwrap();
    let pushed = pushed.0.lock().unwrap();
    assert!(pushed[0].2[0]["state"]["tabs"].as_array().unwrap().is_empty(), "the clear is an event with its own empty state");
    let parts: Vec<Value> = pushed[1].2.iter().map(|payload| payload["part"].clone()).collect();
    assert!(parts.len() > 1);
    assert_eq!(parts[0]["count"].as_u64().unwrap() as usize, parts.len());
    assert!(parts.iter().enumerate().all(|(index, part)| part["index"] == json!(index) && part["id"] == parts[0]["id"]));
    let text: String = parts.iter().map(|part| part["text"].as_str().unwrap()).collect();
    let rebuilt: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((rebuilt["reveal"].clone(), rebuilt["tab"].clone()), (json!(true), json!("t1")));
    assert_eq!(rebuilt["state"]["tabs"][0]["label"].as_str().unwrap().len(), 300_000);
}
/// A snapshot over the inbound frame travels as a blob and arrives as JSON text: it is folded and published as the snapshot
/// it holds, text that is neither a snapshot nor an event is refused, and nothing is folded for it.
#[tokio::test]
async fn a_visualize_state_that_arrived_as_json_text_is_folded_as_the_value_it_holds() {
    let snapshot = visualize_snapshot();
    let tab = &snapshot[0]["tabs"][0];
    let (cwd, pdf) = (tab["cwd"].as_str().unwrap().to_owned(), tab["panes"][0]["path"].as_str().unwrap().to_owned());
    let rel = std::path::Path::new(&pdf).strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
    let (service, publisher, _, panes) = rig_with_panes();
    let set = |value: Value| service.call(from_claim(true, value));
    assert!(set(Value::String("not json".into())).await.is_err());
    assert!(set(Value::String("\"a string\"".into())).await.is_err());
    assert!(!panes.page_file(std::path::Path::new(&cwd), &rel));
    set(Value::String(snapshot.to_string())).await.unwrap();
    assert!(panes.page_file(std::path::Path::new(&cwd), &rel));
    let _ = publisher;
}
/// A visualize value that travelled as text is judged for a lone surrogate as the inline value is (the frame check saw only
/// the blob reference): a label reads it as U+FFFD, an id is refused and nothing is folded. The inline half is
/// `free_text::tests::a_visualize_value_is_judged_alike_inline_and_as_text`.
#[tokio::test]
async fn a_lone_surrogate_in_a_visualize_text_value_is_free_in_a_label_and_refused_in_an_id() {
    let mut snapshot = visualize_snapshot();
    let tab = &snapshot[0]["tabs"][0];
    let (cwd, pdf) = (tab["cwd"].as_str().unwrap().to_owned(), tab["panes"][0]["path"].as_str().unwrap().to_owned());
    let rel = std::path::Path::new(&pdf).strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
    snapshot[0]["tabs"][0]["label"] = json!("LABELMARK");
    snapshot[0]["tabs"][0]["id"] = json!("IDMARK");
    let (service, _, _, panes) = rig_with_panes();
    let set = |text: String| service.call(from_claim(true, Value::String(text)));
    let with_id = snapshot.to_string().replace("LABELMARK", "label").replace("IDMARK", "i\\ud800d");
    assert!(set(with_id).await.is_err());
    assert!(!panes.page_file(std::path::Path::new(&cwd), &rel));
    let with_label = snapshot.to_string().replace("LABELMARK", "a\\ud800b").replace("IDMARK", "id");
    set(with_label).await.unwrap();
    assert!(panes.page_file(std::path::Path::new(&cwd), &rel));
}
/// Only the current claimant of the visualize role publishes it, asked when the publication is applied: a connection that is
/// not the claimant (a displaced one, one that has not claimed, an internal producer) is answered and dropped, and a request
/// built as the claimant but applied after the claim changed hands is dropped.
#[tokio::test]
async fn only_the_current_claimant_s_visualize_publication_is_applied() {
    let snapshot = visualize_snapshot();
    let tab = &snapshot[0]["tabs"][0];
    let (cwd, pdf) = (tab["cwd"].as_str().unwrap().to_owned(), tab["panes"][0]["path"].as_str().unwrap().to_owned());
    let rel = std::path::Path::new(&pdf).strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
    let (service, publisher, _, panes) = rig_with_panes();
    let page = || panes.page_file(std::path::Path::new(&cwd), &rel);
    service.call(from_claim(false, snapshot.clone())).await.unwrap();
    assert!(!page(), "a non-claimant's publication is not applied");
    assert!(publisher.published().is_empty(), "and not published");
    let claimant = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut request = from_claim(false, snapshot.clone());
    let live = claimant.clone();
    request.ctx.visualize_claim = mixdog_core_api::call::ClaimProbe::new(move || live.load(std::sync::atomic::Ordering::SeqCst));
    claimant.store(false, std::sync::atomic::Ordering::SeqCst);
    service.call(request).await.unwrap();
    assert!(!page(), "the claim changed hands before the request was applied");
    service.call(from_claim(true, snapshot.clone())).await.unwrap();
    assert!(page());
}
/// The session id the bridge's state leaves on a snapshot (`applyRemoteSessionState`): only an enabled bridge, and only an id of 1-256
/// letters, digits, dashes and underscores.
#[test]
fn remote_session_keeps_the_id_only_when_the_bridge_is_enabled_and_the_id_is_a_plain_token() {
    let long = "a".repeat(256);
    let too_long = "a".repeat(257);
    for (enabled, id, want) in [
        (true, Some("phone_1"), Some("phone_1")),
        (false, Some("phone_1"), None),
        (true, None, None),
        (true, Some(""), None),
        (true, Some(long.as_str()), Some(long.as_str())),
        (true, Some(too_long.as_str()), None),
        (true, Some("phone 1"), None),
        (true, Some("phone.1"), None),
        (true, Some("Phone-1_x"), Some("Phone-1_x")),
        (true, Some("폰_1"), None),
    ] {
        let value = remote_session_value(enabled, id, None);
        assert_eq!(value["sessionId"], want.map_or(Value::Null, |id| json!(id)), "enabled={enabled} id={id:?}");
    }
}

/// The visualize snapshot of a desktop with one session: a tab holding a PDF, an HTML page, a document under its own root and an image.
fn visualize_snapshot() -> Value {
    let (cwd, kept) = if cfg!(windows) { (r"C:\vis\cwd", r"C:\vis\kept") } else { ("/vis/cwd", "/vis/kept") };
    let sep = if cfg!(windows) { "\\" } else { "/" };
    let at = |dir: &str, name: &str| format!("{dir}{sep}{name}");
    json!([{
        "sessionId": "s1",
        "tabs": [{
            "id": "t1", "label": "Tab", "remoteLabel": "Tab", "revision": 1, "cwd": cwd,
            "panes": [
                { "kind": "pdf", "label": "pdf", "target": at(cwd, "report.pdf"), "path": at(cwd, "report.pdf"), "remoteTarget": "pdf" },
                { "kind": "html", "label": "html", "target": at(cwd, "page.html"), "path": at(cwd, "page.html"), "remoteTarget": "html" },
                { "kind": "document", "label": "document", "target": at(kept, "notes.docx"), "path": at(kept, "notes.docx"), "remoteTarget": "document", "root": kept, "version": 1 },
                { "kind": "image", "label": "image", "target": at(cwd, "img.png"), "path": at(cwd, "img.png"), "remoteTarget": "image" },
            ],
        }],
        "active": "t1",
    }])
}
