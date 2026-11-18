//! Gemini usage with each field missing in turn, against Node's recordings (`fixtures/provider-wire/gemini-usage`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through the Gemini API and Vertex AI express):
//! the provider is built by the production builder from the recorded configuration and sends the turn over the
//! recorder's hub: the request is compared whole with Node's, the recorded stream's reading whole with Node's result,
//! and the stream callbacks in order.

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
async fn every_usage_shape_reads_as_node_reads_it() {
    let names = scenarios("gemini-usage");
    assert_eq!(names.len(), 16, "{names:?}");
    for name in names {
        let recorded = load("gemini-usage", &name);
        let hub = Hub::new(&recorded);
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs::default()).await;
        let request = Arc::new(request_of(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_same_requests(&hub.sent(), &recorded, &[], &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
