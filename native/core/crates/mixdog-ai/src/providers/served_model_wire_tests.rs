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

/// Muse Code's Responses engine over the hub, with the recorded key (`muse-code-oauth.json` `apiKey`).
fn muse_responses(hub: Arc<Hub>) -> Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter> {
    use super::compat::CompatConfig;
    use super::compat::CompatProfile;
    use super::compat::responses::CompatResponsesCodec;
    use super::connect::rewrite::HttpAdapter;
    use super::connect::rewrite::StaticCredential;
    let profile = CompatProfile::muse_code_oauth();
    let policy = profile.retry_policy();
    let config = CompatConfig::for_profile(&profile);
    let codec = Arc::new(CompatResponsesCodec::new(profile, config, mixdog_core_api::domain::keepalive::TransportKind::Http1));
    let credential = Arc::new(StaticCredential(Some(("authorization".to_owned(), "Bearer fixture-key".to_owned()))));
    Arc::new(HttpAdapter::new("muse-code-oauth".into(), codec, hub, credential, policy))
}

#[tokio::test]
async fn every_compatible_provider_reports_the_model_that_answered() {
    let names = scenarios("served-model");
    assert_eq!(names.len(), 7, "{names:?}");
    for name in names {
        let recorded = load("served-model", &name);
        let hub = Hub::new(&recorded);
        let (mut adapter, _dir) = built(&recorded, hub.clone(), Inputs::default()).await;
        if name == "muse-code-oauth" {
            // Node sends Muse Code over Responses only; this branch's builder still routes it to Chat, a route the
            // gateway registry owns (branch `provider-gateways`, whose builder sends it through this Responses
            // engine). Declared in the manifest.
            adapter = muse_responses(hub.clone());
        }
        let request = Arc::new(request_of(&recorded));
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_same_requests(&hub.sent(), &recorded, &[], &name);
        assert_same_result(&core_result(&events, &request.model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
