//! What the `terminal` tool's host (`RevealingTerminalHost`) asks of the session core: the
//! thread's working directory, and the `ui/openRequested` event on the app feed.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::DesktopPresence;
use mixdog_core_base::state::SectionFeedState;
use mixdog_tools::desktop::reveal::OpenFeed;
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
/// exists; paired clients get a projection but never count. With no desktop window attached the
/// request is not published and the caller reports the terminal as not shown.
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
        if !self.ui.desktop_attached() {
            return false;
        }
        self.app.notify("ui/openRequested", &params);
        true
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
    use crate::eventually_on;
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
        let params = json!({ "kind": "terminal", "sessionId": "s1", "requestId": "r1" });

        assert!(!open.publish_open(params.clone()));
        assert!(feeds.frames("app").is_empty(), "nothing is published with no UI");

        ui.0.store(true, Ordering::SeqCst);
        assert!(open.publish_open(params.clone()));
        let frames = feeds.frames("app");
        assert_eq!(frames.len(), 1);
        assert_eq!((frames[0].1.as_str(), &frames[0].2), ("ui/openRequested", &params));
    }

    /// The whole reveal: the host publishes the request on the app feed, a pane's
    /// `ui/terminalRun/claimed` reaches the one `PendingWaits`, and the run is shown.
    #[tokio::test(start_paused = true)]
    async fn the_reveal_is_shown_when_the_pane_claims_the_request_and_not_otherwise() {
        mixdog_rt::testing::tokens();
        let feeds = RecFeeds::default();
        let ui = Arc::new(Ui(AtomicBool::new(false)));
        let waits = PendingWaits::new(Ticker::start(), Duration::from_secs(5), Duration::from_millis(150));
        let host = RevealingTerminalHost::new(
            Arc::new(DirectoryCwds::new(Arc::new(Stored(Some(header(json!({ "cwd": "/w" }))))))),
            Arc::new(AppFeedOpen::new(app_feed(&feeds), ui.clone())),
            waits.clone(),
        );
        assert_eq!(host.session_cwd("s1").await.as_deref(), Some("/w"));
        let target = tab();

        // No UI attached: false at once, nothing published.
        assert!(!host.reveal("s1", &target, std::slice::from_ref(&target)).await);
        assert!(feeds.frames("app").is_empty());

        // A UI that never claims: the wait ends and the terminal runs in the background.
        ui.0.store(true, Ordering::SeqCst);
        assert!(!host.reveal("s1", &target, std::slice::from_ref(&target)).await);
        assert_eq!(feeds.frames("app").len(), 1);

        // A pane that claims what it was asked to show.
        let claimer = {
            let (feeds_ref, waits) = (&feeds, waits.clone());
            let targets = std::slice::from_ref(&target);
            let mut reveal = std::pin::pin!(host.reveal("s1", &target, targets));
            let claim = async {
                // A reveal that ends without publishing its request is the failure, not a wait for a frame that never comes.
                let wakes: [&tokio::sync::Notify; 1] = [&feeds_ref.published];
                let (_, _, params) = tokio::select! {
                    biased;
                    frame = eventually_on!(&wakes, || feeds_ref.frames("app").into_iter().nth(1)) => frame,
                    shown = reveal.as_mut() => panic!("the reveal ended before it published its request: {shown}"),
                };
                let request = params["requestId"].as_str().unwrap().to_owned();
                assert_eq!(params["kind"], "terminal");
                assert_eq!(params["terminalId"], "session-terminal:s1");
                waits.notify(Method("ui/terminalRun/claimed"), json!({ "requestId": request }), ConnectionId(1));
            };
            claim.await;
            crate::session::testing::awaiting(|| "the reveal to end once its request is claimed".to_owned(), reveal).await
        };
        assert!(claimer, "a claimed request is shown");
    }
}
