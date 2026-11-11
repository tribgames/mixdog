//! The model a compatible provider's answer names, against Node's recordings (`fixtures/provider-wire/served-model`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through each provider's own Node class): Node
//! reports `response.model || useModel` (openai-compat-chat-send.mjs:321, chunk-events.mjs:56; Muse Code always sends
//! Responses). Each provider is built by the production builder from the recorded configuration and sends the recorded
//! turn over the recorder's hub: every request is compared whole with Node's, the answer whole with Node's result, and
//! the stream callbacks in order.

use std::sync::Arc;

use super::wire_fixtures::Hub;
use super::wire_fixtures::Inputs;
use super::wire_fixtures::assert_same_events;
use super::wire_fixtures::assert_same_requests;
use super::wire_fixtures::assert_same_result;
use super::wire_fixtures::attempt;
use super::wire_fixtures::built;
use super::wire_fixtures::core_result;
use super::wire_fixtures::load;
use super::wire_fixtures::node_result;
use super::wire_fixtures::request_of;
use super::wire_fixtures::scenarios;

#[tokio::test]
async fn every_compatible_provider_reports_the_model_that_answered() {
    let names = scenarios("served-model");
    assert_eq!(names.len(), 7, "{names:?}");
    for name in names {
        let recorded = load("served-model", &name);
        let hub = Hub::new(&recorded);
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs::default()).await;
        let request = Arc::new(request_of(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_same_requests(&hub.sent(), &recorded, &[], &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
