//! `browser_surfaces`: a reveal or hide of a session's browser surface, reported by the host as
//! `host/browser/surface` (Node's `browserRemoteOpen`), published to the attached clients as
//! `ui/openRequested { kind: "browser", ... }` on the app feed.

use mixdog_app_protocol::v2::host::UiOpenBrowser;
use mixdog_core_domains::domains::host::BrowserSurfaces;
use mixdog_tools::desktop::reveal::OpenFeed;
use serde_json::json;

pub struct FeedSurfaces<F: OpenFeed> {
    feed: F,
}

impl<F: OpenFeed> FeedSurfaces<F> {
    pub fn new(feed: F) -> Self {
        Self { feed }
    }
}

impl<F: OpenFeed> BrowserSurfaces for FeedSurfaces<F> {
    fn requested(&self, request: UiOpenBrowser) {
        let mut params = serde_json::to_value(&request).expect("protocol types serialize");
        params["kind"] = json!("browser");
        // With no client attached there is no one to tell; the request is not queued.
        self.feed.publish_open(params);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;

    struct Feed(Mutex<Vec<Value>>);

    impl OpenFeed for &'static Feed {
        fn publish_open(&self, params: Value) -> bool {
            self.0.lock().unwrap().push(params);
            true
        }
    }

    #[test]
    fn the_request_is_published_as_a_browser_open_with_its_fields() {
        let feed: &'static Feed = Box::leak(Box::new(Feed(Mutex::default())));
        let surfaces = FeedSurfaces::new(feed);
        surfaces.requested(UiOpenBrowser {
            session_id: "s1".into(),
            reveal: Some(true),
            hide: None,
            handoff: None,
            tab_id: Some("p1".into()),
            title: None,
            error: None,
        });
        assert_eq!(
            feed.0.lock().unwrap()[0],
            json!({ "kind": "browser", "sessionId": "s1", "reveal": true, "tabId": "p1" })
        );
    }
}
