//! Owner: s4-engine-lane
//! What the host pushes, routed where it is kept: events and facts into the [`Mirror`]'s ledgers, the person's input into the
//! [`UserHold`] that aborts agent commands, and the end of the host's claim into both. Synchronous and ordered, as [`EngineSink`]
//! requires: every method records and returns.

use std::sync::Arc;

use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageFactsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserUserInputParams;

use super::mirror::Mirror;
use crate::port::EngineSink;
use crate::queue::user_hold::UserHold;

pub struct EngineSinkImpl {
    mirror: Arc<Mirror>,
    hold: Arc<UserHold>,
}

impl EngineSinkImpl {
    pub fn new(mirror: Arc<Mirror>, hold: Arc<UserHold>) -> Self {
        Self { mirror, hold }
    }
}

impl EngineSink for EngineSinkImpl {
    fn events(&self, params: HostBrowserEventsParams) {
        self.mirror.events(params);
    }

    fn facts(&self, params: HostBrowserPageFactsParams) {
        self.mirror.facts(&params.facts);
    }

    fn user_input(&self, params: HostBrowserUserInputParams) {
        self.hold.on_user_input(params);
    }

    fn host_gone(&self) {
        self.mirror.host_gone();
        self.hold.host_gone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::page_facts;
    use crate::queue::key::QueueKey;
    use mixdog_app_protocol::v2::browser_engine::BrowserUserInputReason;
    use mixdog_app_protocol::v2::browser_engine::PageFacts;
    use serde_json::json;

    fn facts(page: &str, seq: u64) -> PageFacts {
        serde_json::from_value(page_facts(page, seq)).expect("facts")
    }

    fn events(page: &str, seq: u64) -> HostBrowserEventsParams {
        serde_json::from_value(json!({"pageId": page, "seq": seq, "events": []})).expect("events")
    }

    fn held(page: &str) -> HostBrowserUserInputParams {
        HostBrowserUserInputParams { page_id: page.into(), seq: 1, held: true, until: None, reason: BrowserUserInputReason::Pointer }
    }

    fn page(id: &str) -> QueueKey {
        QueueKey::new("foreground", Some(id.into()))
    }

    fn sink() -> (EngineSinkImpl, Arc<Mirror>, Arc<UserHold>) {
        let mirror = Arc::new(Mirror::new());
        let hold = Arc::new(UserHold::new());
        (EngineSinkImpl::new(mirror.clone(), hold.clone()), mirror, hold)
    }

    #[test]
    fn events_and_facts_move_the_pages_cursor_in_order() {
        let (sink, mirror, _) = sink();
        sink.events(events("p1", 1));
        sink.facts(HostBrowserPageFactsParams { page_id: "p1".into(), seq: 2, facts: facts("p1", 2) });
        assert_eq!(mirror.cursor("p1"), Some(2));
        assert_eq!(mirror.cursor("p2"), None);
    }

    #[test]
    fn user_input_goes_to_the_hold() {
        let (sink, _, hold) = sink();
        sink.user_input(held("p1"));
        assert!(hold.takeover_error(&page("p1")).is_err());
        assert!(hold.takeover_error(&page("p2")).is_ok());
    }

    #[test]
    fn the_end_of_the_claim_drops_the_pages_and_the_holds() {
        let (sink, mirror, hold) = sink();
        sink.events(events("p1", 4));
        sink.user_input(held("p1"));
        sink.host_gone();
        assert_eq!(mirror.cursor("p1"), None);
        assert_eq!(hold.takeover_error(&page("p1")), Ok(()));
    }
}
