//! openai-ws-handshake (3 WIRE cases): the recorder called `acquireWebSocket` with its own handshake headers, so the
//! replay dials those headers through the core's own dialer (`RedirectedDialer`, the production `WsDial` redirected to
//! the endpoint), compares the ordered ws-world events (dial, the upgrade request with every header, the refusal) whole,
//! and the refusal as the OpenAI OAuth adapter's codec classifies it against the recorded error, field by field through
//! the driver's error table.

use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::link::WsDial as _;
use mixdog_ai::transport::ws::CallerHeaders;
use mixdog_ai::transport::ws::ConnectError;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use tokio_util::sync::CancellationToken;
use mixdog_testkit::Exact;
use hyper::header::HeaderName;
use hyper::header::HeaderValue;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::ErrorSide;
use crate::provider_case::within;
use crate::replay_errors::Left;
use crate::replay_world::Events;

const SET: &str = "openai-ws-handshake";

/// The headers the recorder handed `acquireWebSocket`: the upgrade's headers ahead of the ones `ws` writes itself.
fn caller_headers(upgrade: &Exact) -> Vec<(String, String)> {
    upgrade
        .get("headers")
        .as_array()
        .iter()
        .map(|pair| (pair.as_array()[0].as_str().to_owned(), pair.as_array()[1].as_str().to_owned()))
        .take_while(|(name, _)| !name.eq_ignore_ascii_case("sec-websocket-version"))
        .collect()
}

async fn replay(case: &Case) {
    let id = case.id.as_str();
    let recorded = case.recorded();
    let events = recorded.get("events").raw().as_array();
    let endpoint = Endpoint::start().await;
    endpoint.ws_script(events);
    let upgrade = events.iter().find(|e| e.get("event").as_str() == "upgrade-request").expect("an upgrade request");
    let headers = caller_headers(upgrade);
    let mut request = format!("wss://chatgpt.com{}", upgrade.get("target").as_str()).into_client_request().expect("the url");
    for (name, value) in &headers {
        request.headers_mut().append(
            HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
            HeaderValue::from_str(value).expect("a header value"),
        );
    }
    request.extensions_mut().insert(CallerHeaders(headers));
    let dialer = endpoint.dialer(KeepaliveSchedule::SPEC);
    let refused = match within("the dial", dialer.dial(request)).await {
        Err(ConnectError::Rejected(response)) => response,
        Err(other) => panic!("{SET} {id}: the upgrade failed otherwise: {other:?}"),
        Ok(_) => panic!("{SET} {id}: the upgrade was accepted"),
    };
    endpoint.until("the refusal in the trace", |e| e.trace().len() >= events.len()).await;
    recorded.get("events").assert_eq(&format!("{SET} {id} events"), &Exact::Array(endpoint.trace()));

    drop(refused);

    // The error as the product makes it of the same refusal: one `openai-oauth` send on WebSocket alone
    // (`MIXDOG_OAI_TRANSPORT=ws-full`, no HTTP/SSE switch), its upgrade refused as recorded. The send's own upgrade
    // headers are the product's (the recorded ones were the recorder's) and are not compared.
    let product = Endpoint::start().await;
    product.ws_script(events);
    let home = tempfile::tempdir().expect("a home");
    std::fs::write(
        home.path().join("openai-oauth.json"),
        r#"{"access_token":"fixture-access-token","refresh_token":"r","expires_at":4102444800000,"account_id":"acct-fixture"}"#,
    )
    .expect("the credential");
    let builder = crate::replay_world::builder(&product, home.path(), vec![("MIXDOG_OAI_TRANSPORT".into(), "ws-full".into())]).await;
    let adapter = crate::replay_world::adapter(&builder, "openai-oauth", &serde_json::json!({})).await;
    let request = ModelRequest {
        model: "gpt-5.5".into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    let cancel = CancellationToken::new();
    let (sent, got) = within("the send", crate::replay_world::send_with(&*adapter, request, &cancel, Events::default())).await;
    recorded.get("outcome").get("error").assert_error(&format!("{SET} {id} error"), ErrorSide::Send(&Left::of(&sent, &got)));
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: SET, run: every_case_replays_as_nodes }];

/// Every case of the set, in one test: the set's drop holds each to its comparison.
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load(SET);
    assert_eq!(set.cases.len(), 3, "the recorded cases");
    for case in &set.cases {
        replay(case).await;
    }
}
