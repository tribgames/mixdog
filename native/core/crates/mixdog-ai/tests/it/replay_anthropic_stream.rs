//! `fixtures/provider-anthropic-stream` (`record-anthropic-stream.mjs`): `AnthropicProvider({ apiKey }).send` against
//! the scripted SSE body, replayed through `DefaultProviderBuilder::build("anthropic")` and `ModelBroker::send`.

use serde_json::json;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;
use crate::replay_env;
use crate::replay_env::ProviderBuilder as _;

/// Every case's request, as it arrives at the socket, equals Node's whole: the Anthropic SDK's headers in its order
/// and letter case (`Accept`, `User-Agent`, `X-Stainless-*`, then `anthropic-version`, `x-api-key`, `content-type`,
/// `anthropic-beta`), undici's own, and the body bytes; and the send completes on the scripted stream.
#[tokio::test(start_paused = true)]
async fn every_request_arrives_as_nodes() {
    let set = CaseSet::load("anthropic-stream");
    for case in &set.cases {
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let env = replay_env::env(&endpoint);
        let key = case.args_of("AnthropicProvider", 0)[0].get("apiKey").as_str().to_owned();
        let adapter = env.builder.build("anthropic", &json!({ "apiKey": key })).await.expect("built");
        let request = replay_env::request(case.args_of("AnthropicProvider#send", 0));
        let (_, outcome) = within(&format!("{}: the send", case.id), replay_env::send(adapter.as_ref(), request)).await;
        assert_eq!(outcome.expect("the scripted stream completes"), 1, "{}: one attempt", case.id);
        set.assert_requests(case, &endpoint.arrivals(), None);
    }
}
