//! `provider-session-provider-replay`: the SDK header layer of its Anthropic request. The whole provider sends wait for
//! the product's catalog world (the model caps and OpenAI facts the builder takes from `mixdog-core`'s `CatalogCaps` /
//! `CatalogOpenAiFacts`).

use futures::StreamExt as _;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;

const SET: &str = "session-provider-replay";

/// The Anthropic client's own headers keep the spelling `@anthropic-ai/sdk` gives them (`Accept`, `User-Agent`,
/// `X-Stainless-*`): the recorded Messages request's codec headers and body, written by the production gateway
/// transport (`GatewayHttp::through_sdk(Sdk::Anthropic)`) over the production link, arrive as Node's did.
#[tokio::test(start_paused = true)]
async fn the_anthropic_client_headers_arrive_in_the_sdk_spelling() {
    use mixdog_ai::registry::gateway::GatewayHttp;
    use mixdog_ai::registry::gateway::Sdk;
    use mixdog_ai::transport::HttpSend;
    use mixdog_ai::transport::KeepaliveSchedule;
    use mixdog_ai::transport::ReqwestLink;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::WireRequest;
    let set = CaseSet::load(SET);
    let case = set.case("openai-to-anthropic-tool-pair");
    let recorded = &case.requests[0];
    let endpoint = Endpoint::start().await;
    endpoint.serve(case);
    // The headers the Messages codec writes; the SDK and `fetch` write the rest.
    let codec: Vec<(String, String)> = recorded
        .get("headers")
        .as_array()
        .iter()
        .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
        .filter(|(name, _)| matches!(name.as_str(), "x-api-key" | "content-type" | "anthropic-beta"))
        .collect();
    let link = endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link"));
    let http = GatewayHttp::new(std::sync::Arc::new(link)).through_sdk(Sdk::Anthropic, &[]);
    let request = WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: format!("{}{}", recorded.get("origin").as_str(), recorded.get("path").as_str()),
        headers: codec,
        body: recorded.get("body").as_str().as_bytes().to_vec(),
    };
    let mut response = within("the answer", http.send(request, mixdog_ai::transport::deadlines::MODEL_STREAM)).await.expect("answered");
    while within("the body", response.body.next()).await.is_some() {}
    set.assert_requests(case, &endpoint.arrivals(), None);
}
