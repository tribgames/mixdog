//! The gateway's own rules: which refusals mean "this model is not served on this wire", how a reroute lowers the
//! history, and how the gateway's transport shapes a request (key mirrored as a bearer, path moved, headers in the order
//! the vendor SDK writes them, redirects refused).

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::AccountRouting;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::GatewayHttp;
use super::Refusal;
use super::Sdk;
use super::lowered;
use super::sdk_order;
use super::wire_unsupported;
use crate::providers::listing_row::testing::Replay;
use crate::transport::HttpSend;
use crate::transport::deadlines::TOKEN_GROK;

fn refused(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
    error.message = message.to_owned();
    error
}

fn refusal(status: u16, body: Value) -> Refusal {
    Refusal { status, headers: Vec::new(), body }
}

// which refusals reroute

#[test]
fn a_refusal_naming_the_endpoint_as_unsupported_means_the_model_is_not_served_on_this_wire() {
    for status in [405, 501] {
        assert!(wire_unsupported(&refused("nope"), Some(&refusal(status, Value::Null))), "{status}: the endpoint itself");
    }
    for status in [400, 404, 415, 422] {
        let body = json!({"error": {"message": "The /v1/messages endpoint is not supported for this model"}});
        assert!(wire_unsupported(&refused("x"), Some(&refusal(status, body))), "{status}");
    }
    let chat = json!({"error": {"message": "this model does not support chat completions"}});
    assert!(wire_unsupported(&refused("x"), Some(&refusal(404, chat))));
}

#[test]
fn a_refusal_that_is_about_anything_else_does_not_reroute() {
    let wrong = |status: u16, body: Value| !wire_unsupported(&refused("x"), Some(&refusal(status, body)));
    // Endpoint words alone, or "unsupported" alone, are not enough.
    assert!(wrong(404, json!({"error": {"message": "model not found on this endpoint"}})));
    assert!(wrong(400, json!({"error": {"message": "unsupported value"}})));
    // A parameter, quota or auth problem is the request's, not the wire's.
    assert!(wrong(400, json!({"error": {"message": "Unsupported parameter: temperature on the /v1/responses endpoint"}})));
    assert!(wrong(404, json!({"error": {"code": "insufficient_quota", "message": "the /v1/messages endpoint is not supported"}})));
    assert!(wrong(404, json!({"error": {"type": "authentication_error", "message": "the /v1/messages endpoint is not supported"}})));
    assert!(wrong(404, json!({"error": {"param": "stream", "message": "the /v1/messages endpoint is not supported"}})));
    assert!(wrong(400, json!({"error": {"message": "rate limit on the /v1/messages endpoint: not supported"}})));
    // Only the listed statuses can mean it.
    assert!(wrong(500, json!({"error": {"message": "the /v1/messages endpoint is not supported"}})));
    assert!(wrong(401, Value::Null));
}

#[test]
fn a_failure_that_showed_output_or_needs_a_new_sign_in_or_left_no_refusal_never_reroutes() {
    let body = || json!({"error": {"message": "the /v1/messages endpoint is not supported"}});
    let mut shown = refused("x");
    shown.exposure.text_emitted = true;
    assert!(!wire_unsupported(&shown, Some(&refusal(404, body()))));
    let mut dispatched = refused("x");
    dispatched.exposure.tool_dispatched = true;
    assert!(!wire_unsupported(&dispatched, Some(&refusal(404, body()))));
    let mut auth = refused("x");
    auth.reauth_required = true;
    assert!(!wire_unsupported(&auth, Some(&refusal(404, body()))));
    assert!(!wire_unsupported(&refused("x"), None));
    // The error's own code counts as the typed reason too.
    let mut quota = refused("x");
    quota.code = Some("billing_hard_limit".into());
    assert!(!wire_unsupported(&quota, Some(&refusal(405, Value::Null))));
}

// lowering the history

fn assistant(account: &str) -> Message {
    let mut message = Message::new(Role::Assistant, Content::Text("a".into()));
    message.account_routing = Some(AccountRouting { provider: "p".into(), account_id: account.into(), session_account_id: None });
    message
}

fn history() -> Arc<ModelRequest> {
    Arc::new(ModelRequest {
        model: "m".into(),
        messages: vec![
            Message::new(Role::User, Content::Text("u".into())),
            assistant("one"),
            Message::new(Role::User, Content::Text("u2".into())),
            assistant("two"),
        ],
        tools: Vec::new(),
        options: Default::default(),
    })
}

#[test]
fn a_reroute_sends_the_first_assistant_turns_without_their_wire_native_state() {
    let request = history();
    assert!(Arc::ptr_eq(&lowered(request.clone(), 0), &request), "nothing to lower is the same request");
    let one = lowered(request.clone(), 1);
    assert!(one.messages[1].account_routing.is_none());
    assert!(one.messages[3].account_routing.is_some(), "only the first count of assistant turns");
    let both = lowered(request.clone(), 5);
    assert!(both.messages[3].account_routing.is_none());
    assert_eq!(both.messages.len(), 4);
    assert!(request.messages[1].account_routing.is_some(), "the caller's request is not changed");
}

// the gateway's transport

fn post(url: &str, headers: &[(&str, &str)], body: &str) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
        body: body.as_bytes().to_vec(),
    }
}

fn names(request: &WireRequest) -> Vec<&str> {
    request.headers.iter().map(|(k, _)| k.as_str()).collect()
}

fn answering(status: u16) -> Arc<Replay> {
    Arc::new(Replay::new(move |_| (status, b"{}".to_vec())))
}

fn sent(replay: &Replay) -> WireRequest {
    replay.requests.lock().unwrap().last().cloned().expect("a request went out")
}

#[tokio::test]
async fn an_api_key_can_be_mirrored_as_a_bearer_right_after_it() {
    let replay = answering(200);
    let http = GatewayHttp::new(replay.clone()).mirroring_key_as_bearer();
    http.send(post("https://gw.test/v1/messages", &[("x-api-key", "K"), ("content-type", "application/json")], "{}"), TOKEN_GROK).await.unwrap();
    let request = sent(&replay);
    assert_eq!(
        request.headers[..3],
        [
            ("x-api-key".to_owned(), "K".to_owned()),
            ("authorization".to_owned(), "Bearer K".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned())
        ]
    );
}

#[tokio::test]
async fn the_path_prefix_is_moved_once_and_the_routes_own_headers_are_added() {
    let replay = answering(200);
    let http = GatewayHttp::new(replay.clone()).moving_path("/v1beta", "/v1").with_headers(vec![("x-route".into(), "r".into())]);
    http.send(post("https://gw.test/v1beta/models/m:generate/v1beta", &[], "{}"), TOKEN_GROK).await.unwrap();
    let request = sent(&replay);
    assert_eq!(request.url, "https://gw.test/v1/models/m:generate/v1beta");
    assert_eq!(request.headers, [("x-route".to_owned(), "r".to_owned())]);
}

#[tokio::test]
async fn a_plain_system_instruction_drops_its_role() {
    let replay = answering(200);
    let http = GatewayHttp::new(replay.clone()).plain_system_instruction();
    let body = json!({"systemInstruction": {"role": "system", "parts": [{"text": "s"}]}, "contents": []}).to_string();
    http.send(post("https://gw.test/x", &[], &body), TOKEN_GROK).await.unwrap();
    let sent_body: Value = serde_json::from_slice(&sent(&replay).body).unwrap();
    assert_eq!(sent_body["systemInstruction"], json!({"parts": [{"text": "s"}]}));
    assert_eq!(sent_body["contents"], json!([]));
}

#[tokio::test]
async fn a_model_request_never_follows_a_redirect_so_the_gateways_key_cannot_leave_it() {
    let http = GatewayHttp::new(answering(302)).refusing_redirects();
    let error = http.send(post("https://gw.test/v1/chat/completions", &[], "{}"), TOKEN_GROK).await.err().expect("refused");
    assert_eq!(error.message, "Connection error.");
    assert_eq!(error.delivery, DeliveryState::Ambiguous);

    let labelled = GatewayHttp::new(answering(307)).refusing_redirects_as("xai");
    let error = labelled.send(post("https://api.x.ai/v1/chat/completions", &[], "{}"), TOKEN_GROK).await.err().expect("refused");
    assert_eq!(error.message, "[xai] refusing to follow a redirect from api.x.ai");

    let mut listing = post("https://gw.test/v1/models", &[], "");
    listing.method = "GET".into();
    let answered = GatewayHttp::new(answering(302)).refusing_redirects().send(listing, TOKEN_GROK).await.unwrap();
    assert_eq!(answered.status, 302, "a listing read is a plain fetch");
}

// header order

#[test]
fn the_openai_sdk_writes_its_own_headers_then_the_key_then_the_clients_then_the_body_type_then_the_requests() {
    let headers = sdk_order(
        Sdk::OpenAi,
        &["x-gateway".to_owned()],
        vec![
            ("Content-Type".into(), "application/json".into()),
            ("authorization".into(), "Bearer k".into()),
            ("x-extra".into(), "e".into()),
            ("x-gateway".into(), "1".into()),
            ("accept".into(), "application/json".into()),
        ],
    );
    assert_eq!(headers[0], ("accept".to_owned(), "application/json".to_owned()));
    assert_eq!(headers[1], ("user-agent".to_owned(), "OpenAI/JS 6.49.0".to_owned()));
    let tail: Vec<&str> = headers[headers.len() - 4..].iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(tail, ["authorization", "x-gateway", "content-type", "x-extra"]);
    assert_eq!(headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("accept")).count(), 1, "the codec's own accept is the SDK's");
}

#[test]
fn the_anthropic_sdk_spells_its_headers_its_own_way_and_a_requests_timeout_replaces_the_default() {
    let headers = sdk_order(Sdk::Anthropic, &[], vec![("x-api-key".into(), "k".into()), ("x-stainless-timeout".into(), "30".into())]);
    assert_eq!(headers[0], ("Accept".to_owned(), "application/json".to_owned()));
    assert_eq!(headers[1], ("User-Agent".to_owned(), "Anthropic/JS 0.137.0".to_owned()));
    assert!(headers.contains(&("anthropic-version".to_owned(), "2023-06-01".to_owned())));
    let timeouts: Vec<&(String, String)> = headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("x-stainless-timeout")).collect();
    assert_eq!(timeouts, [&("X-Stainless-Timeout".to_owned(), "30".to_owned())]);
    assert!(headers.contains(&("x-api-key".to_owned(), "k".to_owned())));
}

#[tokio::test]
async fn a_gateway_post_through_an_sdk_is_reordered_but_a_listing_read_is_left_alone() {
    let replay = answering(200);
    let http = GatewayHttp::new(replay.clone()).through_sdk(Sdk::OpenAi, &[]);
    http.send(post("https://gw.test/v1/chat/completions", &[("authorization", "Bearer k")], "{}"), TOKEN_GROK).await.unwrap();
    assert_eq!(names(&sent(&replay))[0], "accept");
    let mut listing = post("https://gw.test/v1/models", &[("authorization", "Bearer k")], "");
    listing.method = "GET".into();
    http.send(listing, TOKEN_GROK).await.unwrap();
    assert_eq!(sent(&replay).headers, [("authorization".to_owned(), "Bearer k".to_owned())]);
}
