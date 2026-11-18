//! Claude through Antigravity replays its history as Node does, against Node's recordings
//! (`fixtures/provider-wire/antigravity-claude`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`
//! from the cases of `antigravity-request.test.mjs:402-795` sent through `AntigravityOAuthProvider`): empty parts,
//! rejoined and unsigned or foreign thinking, and the closing of an unthought tool loop. The provider is built by the
//! production builder from the recorded sign-in and sends each history over the recorder's hub: the request is compared
//! whole with Node's (the per-send `requestId` only for presence), the answer whole with Node's result (the replay
//! envelope the next turn sends back included), and the stream callbacks in order.

#[cfg(node_twin)]
use std::sync::Arc;

#[cfg(node_twin)]
use crate::providers::wire_fixtures::Hub;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::Inputs;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_events;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_requests;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::attempt;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::built;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::core_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::load;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::node_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::request_of;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::scenarios;

#[cfg(node_twin)]
#[tokio::test]
async fn every_claude_history_is_replayed_as_node_replays_it() {
    let names = scenarios("antigravity-claude");
    assert_eq!(names.len(), 17, "{names:?}");
    for name in names {
        let recorded = load("antigravity-claude", &name);
        let hub = Hub::new(&recorded);
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs::default()).await;
        let request = Arc::new(request_of(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        // Drawn per send: Antigravity's request id (`agent-<randomUUID>`).
        assert_same_requests(&hub.sent(), &recorded, &["requestId"], &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
