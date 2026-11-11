//! `fixtures/provider-anthropic-stream` (`record-anthropic-stream.mjs`): `AnthropicProvider({ apiKey }).send` against
//! the scripted SSE body, replayed through `DefaultProviderBuilder::build("anthropic")` and `ModelBroker::send`.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use tokio_util::sync::CancellationToken;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;
use crate::replay_anthropic;
use crate::replay_world;

/// Every case whole: the request as it arrives at the socket (the Anthropic SDK's headers in its order and letter
/// case, undici's own, the body bytes), and the send's result and callbacks as Node's.
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("anthropic-stream");
    for case in &set.cases {
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let home = tempfile::tempdir().expect("a home");
        let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
        let config = plain_config(case.args_of("AnthropicProvider", 0));
        let adapter = replay_world::adapter(&builder, "anthropic", &config).await;
        let args = case.args_of("AnthropicProvider#send", 0);
        assert_eq!(args[2].as_array().len(), 0, "{}: no tools", case.id);
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let cancel = CancellationToken::new();
        let (outcome, events) = within(&format!("{}: the send", case.id), replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default())).await;
        assert_eq!(outcome.expect("the scripted stream completes"), 1, "{}: one attempt", case.id);
        set.assert_requests(case, &endpoint.arrivals(), None);
        replay_anthropic::assert_send(&set, &case.id, case.result(), &replay_anthropic::send(&events.events, args[1].as_str()));
    }
}

/// The recorded `new AnthropicProvider(config)` argument as the builder's config.
fn plain_config(args: &[mixdog_testkit::Exact]) -> serde_json::Value {
    let config = crate::provider_cases::plain(&args[0]);
    assert!(config.as_object().is_some_and(|c| c.keys().all(|k| k == "apiKey")), "a key-only config: {config}");
    config
}
