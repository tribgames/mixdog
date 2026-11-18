//! What the `terminal` tool's host (`RevealingTerminalHost`) asks of the session core: the
//! thread's working directory, and the `ui/openRequested` event on the app feed.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::DesktopPresence;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_base::state::SectionFeedState;
use mixdog_tools::desktop::reveal::OpenFeed;
use mixdog_tools::desktop::reveal::RevealFeed;
use mixdog_tools::desktop::reveal::SessionCwds;
use serde_json::Value;

use super::run_stamps::Records;

/// `sessionCwd(id)` of the desktop's terminal bridge: `listSessions().find(id)?.cwd || null`.
/// The header is the one `thread/setCwd` writes: the live one of a loaded thread, else the
/// stored record. An unknown session, or one with no folder, has none.
pub struct DirectoryCwds {
    records: Arc<dyn Records>,
}

impl DirectoryCwds {
    /// `records` is the `SessionDirectory`.
    pub fn new(records: Arc<dyn Records>) -> Self {
        Self { records }
    }
}

#[async_trait]
impl SessionCwds for DirectoryCwds {
    async fn session_cwd(&self, session_id: &str) -> Option<String> {
        let header = self.records.record(session_id).await?;
        header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).map(str::to_owned)
    }
}

/// `ui/openRequested` on the app feed. Node's `sendToWindow` is false unless the desktop window
/// exists; paired clients get a projection but never count. The request is published whether or
/// not a desktop window is attached (Node relays to the phones first, `run-dispatch.ts`); with
/// none attached the caller reports the terminal as not shown at once.
pub struct AppFeedOpen {
    app: Arc<SectionFeedState>,
    ui: Arc<dyn DesktopPresence>,
}

impl AppFeedOpen {
    /// `app` is the section state over the app feed; `ui` is the server's connection table.
    pub fn new(app: Arc<SectionFeedState>, ui: Arc<dyn DesktopPresence>) -> Self {
        Self { app, ui }
    }
}

impl OpenFeed for AppFeedOpen {
    fn publish_open(&self, params: Value) -> bool {
        self.app.notify("ui/openRequested", &params);
        self.ui.desktop_attached()
    }
}

/// One connection live on the app feed, as far as a terminal reveal needs to know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Audience {
    pub id: ConnectionId,
    /// A paired phone (origin relay): it is told the reveal without a path or an ack id.
    pub relay: bool,
    /// A desktop window: it can take the request, and its claim is the reveal's answer.
    pub window: bool,
}

/// The connections live on the app feed, asked of the connection table as they are.
pub trait AppFeedAudience: Send + Sync {
    fn audience(&self) -> Vec<Audience>;
}

/// The terminal reveal on the connections of the app feed: every one but a paired phone gets the
/// whole `ui/openRequested` request, a phone the projection without `requestId` and `cwd`
/// (`run-dispatch.ts`). The request goes out whether or not a desktop window is attached; with
/// none attached the caller reports the terminal as not shown at once.
pub struct AudienceReveal {
    audience: Arc<dyn AppFeedAudience>,
    notifier: Arc<dyn ConnectionNotifier>,
}

impl AudienceReveal {
    pub fn new(audience: Arc<dyn AppFeedAudience>, notifier: Arc<dyn ConnectionNotifier>) -> Self {
        Self { audience, notifier }
    }
}

impl RevealFeed for AudienceReveal {
    fn publish_reveal(&self, full: Value, relay: Value) -> bool {
        let mut taken = false;
        for member in self.audience.audience() {
            let params = if member.relay { &relay } else { &full };
            let sent = self.notifier.notify(member.id, Method("ui/openRequested"), params.clone()).is_ok();
            taken |= sent && member.window;
        }
        taken
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use mixdog_core_api::ids::FeedEpoch;
    use mixdog_core_api::ids::FeedId;
    use mixdog_core_base::state::empty_view;
    use mixdog_store::schema::record::Header;
    use mixdog_tools::desktop::pending::PendingWaits;
    use mixdog_tools::desktop::reveal::RevealingTerminalHost;
    use mixdog_core_api::service::DomainService;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::Method;
    use mixdog_rt::Ticker;
    use mixdog_spawn::terminal::SessionTab;
    use mixdog_spawn::terminal::TerminalBridgeHost;
    use serde_json::json;

    use super::super::FeedFactory;
    use super::super::testing::RecFeeds;
    use super::*;

    struct Stored(Option<Header>);

    #[async_trait]
    impl Records for Stored {
        async fn record(&self, _session: &str) -> Option<Header> {
            self.0.clone()
        }
    }

    fn header(value: Value) -> Header {
        value.as_object().cloned().unwrap()
    }

    async fn cwd_of(stored: Option<Header>) -> Option<String> {
        DirectoryCwds::new(Arc::new(Stored(stored))).session_cwd("s1").await
    }

    #[tokio::test]
    async fn the_cwd_is_the_threads_folder_or_nothing() {
        assert_eq!(cwd_of(Some(header(json!({ "cwd": "/work/app" })))).await.as_deref(), Some("/work/app"));
        // `|| null`: an empty folder, a missing one and a non-text one are all none.
        assert_eq!(cwd_of(Some(header(json!({ "cwd": "" })))).await, None);
        assert_eq!(cwd_of(Some(header(json!({ "title": "x" })))).await, None);
        assert_eq!(cwd_of(Some(header(json!({ "cwd": 7 })))).await, None);
        assert_eq!(cwd_of(None).await, None, "an unknown session");
    }

    struct Ui(AtomicBool);

    impl DesktopPresence for Ui {
        fn desktop_attached(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn app_feed(feeds: &RecFeeds) -> Arc<SectionFeedState> {
        let id = FeedId::from("app");
        let epoch = FeedEpoch::from("e1".to_owned());
        let feed = feeds.thread_feed(id.clone(), epoch.clone(), empty_view(&id, &epoch));
        Arc::new(SectionFeedState::new(feed))
    }

    fn tab() -> SessionTab {
        SessionTab { id: "session-terminal:s1".into(), tab: 1, shell: "sh".into(), running: true, cwd: Some("/w".into()) }
    }

    #[tokio::test]
    async fn an_open_is_published_on_the_app_feed_only_while_a_ui_is_attached() {
        let feeds = RecFeeds::default();
        let ui = Arc::new(Ui(AtomicBool::new(false)));
        let open = AppFeedOpen::new(app_feed(&feeds), ui.clone());
        let params = json!({ "kind": "browser", "sessionId": "s1" });

        // No desktop window: the phones still get it (Node relays first), and the caller is told no one took it.
        assert!(!open.publish_open(params.clone()));
        assert_eq!(feeds.frames("app").len(), 1, "paired clients are told with no desktop attached");

        ui.0.store(true, Ordering::SeqCst);
        assert!(open.publish_open(params.clone()));
        let frames = feeds.frames("app");
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[1].1.as_str(), &frames[1].2), ("ui/openRequested", &params));
    }

    struct Table(Vec<Audience>);

    impl AppFeedAudience for Table {
        fn audience(&self) -> Vec<Audience> {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Sent(std::sync::Mutex<Vec<(u64, Value)>>);

    impl ConnectionNotifier for Sent {
        fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), mixdog_core_api::CoreError> {
            assert_eq!(method.as_str(), "ui/openRequested");
            if to.0 == 9 {
                return Err(mixdog_core_api::CoreError::ConnectionClosed);
            }
            self.0.lock().unwrap().push((to.0, params));
            Ok(())
        }
    }

    fn member(id: u64, relay: bool, window: bool) -> Audience {
        Audience { id: ConnectionId(id), relay, window }
    }

    #[test]
    fn a_reveal_no_window_took_is_not_shown_though_the_phones_are_told() {
        let sent = Arc::new(Sent::default());
        let table = Table(vec![member(2, true, false), member(9, false, true)]);
        let reveal = AudienceReveal::new(Arc::new(table), sent.clone());
        assert!(!reveal.publish_reveal(json!({ "kind": "terminal" }), json!({ "kind": "terminal" })), "a window that is gone took nothing");
        assert_eq!(sent.0.lock().unwrap().len(), 1, "the phone is still told");
    }


    #[test]
    fn paired_phones_get_the_reveal_without_any_path_or_ack_id_while_the_window_keeps_the_full_request() {
        let sent = Arc::new(Sent::default());
        let table = Table(vec![member(1, false, true), member(2, true, false), member(3, false, false)]);
        let reveal = AudienceReveal::new(Arc::new(table), sent.clone());
        let full = json!({ "kind": "terminal", "sessionId": "s1", "requestId": "r1", "tabs": [{ "id": "t", "tab": 1, "cwd": "/home/secret" }] });
        let relay = mixdog_tools::desktop::reveal::relay_projection(&full);
        assert!(reveal.publish_reveal(full.clone(), relay.clone()));
        let sent = sent.0.lock().unwrap();
        assert_eq!(*sent, vec![(1, full.clone()), (2, relay.clone()), (3, full)]);
        assert!(!sent[1].1.to_string().contains("secret") && sent[1].1.get("requestId").is_none());
    }


    /// The whole reveal: the host sends the request to the connections of the app feed, a window's
    /// `ui/terminalRun/claimed` reaches the one `PendingWaits`, and the run is shown.
    #[tokio::test(start_paused = true)]
    async fn the_reveal_is_shown_when_the_pane_claims_the_request_and_not_otherwise() {
        mixdog_rt::testing::tokens();
        let sent = Arc::new(Sent::default());
        let waits = PendingWaits::new(Ticker::start(), Duration::from_secs(5), Duration::from_millis(150));
        let host_with = |audience: Vec<Audience>| {
            RevealingTerminalHost::new(
                Arc::new(DirectoryCwds::new(Arc::new(Stored(Some(header(json!({ "cwd": "/w" }))))))),
                Arc::new(AudienceReveal::new(Arc::new(Table(audience)), sent.clone())),
                waits.clone(),
            )
        };
        let target = tab();
        let targets = std::slice::from_ref(&target);

        // No window attached: false at once, the phone is still told.
        let host = host_with(vec![member(2, true, false)]);
        assert_eq!(host.session_cwd("s1").await.as_deref(), Some("/w"));
        assert!(!host.reveal("s1", &target, targets).await);
        assert_eq!(sent.0.lock().unwrap().len(), 1);

        // A window that never claims: the wait ends and the terminal runs in the background.
        let host = host_with(vec![member(1, false, true), member(2, true, false)]);
        assert!(!host.reveal("s1", &target, targets).await);
        assert_eq!(sent.0.lock().unwrap().len(), 3);

        // A window that claims what it was asked to show.
        let reveal = host.reveal("s1", &target, targets);
        let claim = async {
            let params = crate::session::testing::awaiting(
                || "the request to reach the window".to_owned(),
                async {
                    loop {
                        if let Some((_, params)) = sent.0.lock().unwrap().get(3).cloned() {
                            return params;
                        }
                        // Not a timer: `awaiting` holds the paused clock while its deadline runs, so a sleep here never ends.
                        tokio::task::yield_now().await;
                    }
                },
            )
            .await;
            let request = params["requestId"].as_str().unwrap().to_owned();
            assert_eq!(params["kind"], "terminal");
            assert_eq!(params["terminalId"], "session-terminal:s1");
            waits.notify(Method("ui/terminalRun/claimed"), json!({ "requestId": request }), ConnectionId(1));
        };
        let ((), shown) = crate::session::testing::awaiting(|| "the reveal to end once its request is claimed".to_owned(), async { tokio::join!(claim, reveal) }).await;
        assert!(shown, "a claimed request is shown");
    }
}
