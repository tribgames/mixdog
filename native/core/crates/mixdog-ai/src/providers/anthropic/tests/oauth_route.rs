//! The subscription route against a scripted upstream: the listing request, the messages request's shape, the
//! stream, the wording of refusals, a refused floor feature and a refused fast request, the refresh that times out,
//! and the catalog that survives a failed listing. Expectations are written out in the tests.

use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelListing;

use super::*;
use crate::claude_floors;
use crate::claude_floors::Feature;
use crate::providers::anthropic::fast_mode::FastMode;

const OK: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":4,\"cache_read_input_tokens\":6}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fine\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

const TOKEN: &str = "fixture-access-token";

fn caps_config(caps: ModelCaps) -> AnthropicConfig {
    AnthropicConfig::new(Arc::new(move |_: &str| Some(caps.clone())))
}

fn subscription(config: AnthropicConfig, script: Vec<Scripted>) -> (AnthropicAdapter, Arc<ScriptedHttp>, Arc<MemoryStore>) {
    let http = ScriptedHttp::new(script);
    let store = MemoryStore::signed_in();
    let session = Arc::new(OAuthSession::new(store.file.clone(), http.clone()));
    (AnthropicAdapter::oauth(config, http.clone(), session, false, cpu_bulk()), http, store)
}

fn with_headers(status: u16, body: &str, headers: &[(&str, &str)]) -> Scripted {
    Scripted { headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), ..Scripted::body(status, body) }
}

fn refusal_body(kind: &str, message: &str) -> String {
    json!({ "type": "error", "error": { "type": kind, "message": message } }).to_string()
}

fn ask(model: &str, options: RequestOptions) -> Arc<ModelRequest> {
    let mut req = request(base_messages(), options);
    req.model = model.into();
    Arc::new(req)
}

async fn text_of(adapter: &AnthropicAdapter, request: Arc<ModelRequest>) -> Result<String, ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    let mut text = String::new();
    for item in drain(stream.as_mut()).await {
        if let StreamEvent::TextDelta(t) = item? {
            text.push_str(&t);
        }
    }
    Ok(text)
}

fn find<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn body_of(sent: &mixdog_core_api::domain::provider::WireRequest) -> Value {
    serde_json::from_slice(&sent.body).expect("a plain JSON body")
}

const BASE_BETAS: &str = "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27";

#[tokio::test]
async fn a_learned_cli_minimum_updates_the_messages_replay_listing_and_token_exchanges() {
    use crate::oauth::PkceProvider;

    let minimum = refusal_body("invalid_request_error", "Claude Code 2.1.317 does not support this model; version 2.9.120 or newer is required");
    let token = r#"{"access_token":"fixture-next","refresh_token":"fixture-next-refresh","expires_in":28800,"scope":"user:inference"}"#;
    let http = ScriptedHttp::new([
        Scripted::body(400, &minimum),
        Scripted::body(401, &refusal_body("authentication_error", "Token expired")),
        Scripted::body(200, token),
        Scripted::body(200, OK),
        Scripted::body(200, r#"{"data":[{"id":"claude-opus-4-8"}]}"#),
        Scripted::body(200, token),
    ]);
    let store = MemoryStore::signed_in();
    let version = Arc::new(crate::providers::anthropic::ClaudeClientVersion::fixed(""));
    let session = OAuthSession::new(store.file.clone(), http.clone()).with_cli_version_source(version.clone());
    let adapter = AnthropicAdapter::oauth(caps_config(ModelCaps::default()), http.clone(), Arc::new(session), false, cpu_bulk());
    assert_eq!(text_of(&adapter, ask("m", RequestOptions::default())).await.expect("the replay completes"), "fine");
    adapter.list_rows().await.expect("model list");
    let login = crate::providers::anthropic::AnthropicLogin::new(store.file.clone(), http.clone()).with_cli_version_source(version);
    login.authorize_url(&crate::oauth::AuthorizeRequest { redirect_uri: "http://localhost/callback", code_challenge: "challenge", state: "state" });
    assert!(login.exchange("code", "verifier", "http://localhost/callback").await.is_ok());

    let sent = http.sent();
    let requests: Vec<_> = sent.iter().map(|wire| (url::Url::parse(&wire.url).unwrap().path().to_owned(), find(&wire.headers, "user-agent"))).collect();
    let learned = Some("claude-cli/2.9.120 (external, sdk-cli)");
    assert_eq!(
        requests,
        [
            ("/v1/messages".to_owned(), Some("claude-cli/2.1.317 (external, sdk-cli)")),
            ("/v1/messages".to_owned(), learned),
            ("/v1/oauth/token".to_owned(), learned),
            ("/v1/messages".to_owned(), learned),
            ("/v1/models".to_owned(), learned),
            ("/v1/oauth/token".to_owned(), learned),
        ]
    );
}

// Requests

#[tokio::test]
async fn the_subscription_listing_is_one_get_on_anthropics_origin_with_the_cli_identity_and_the_bearer_token() {
    let (adapter, http, _store) = subscription(
        {
            let mut config = caps_config(ModelCaps::default());
            config.base_url = "https://gateway.example".into();
            config.extra_headers = vec![("x-tenant".into(), "t".into())];
            config
        },
        vec![Scripted::body(200, r#"{"data":[{"id":"claude-opus-4-8"}]}"#)],
    );
    let rows = adapter.list_rows().await.expect("the listing");
    assert_eq!(rows[0].id, "claude-opus-4-8");
    let sent = &http.sent()[0];
    assert_eq!((sent.method.as_str(), sent.url.as_str()), ("GET", "https://api.anthropic.com/v1/models"));
    assert!(sent.body.is_empty());
    assert_eq!(find(&sent.headers, "authorization"), Some("Bearer fixture-access-token"));
    assert_eq!(find(&sent.headers, "anthropic-version"), Some(crate::providers::anthropic::ANTHROPIC_VERSION));
    assert_eq!(find(&sent.headers, "anthropic-beta"), Some(BASE_BETAS));
    assert_eq!(find(&sent.headers, "anthropic-dangerous-direct-browser-access"), Some("true"));
    assert_eq!(find(&sent.headers, "x-app"), Some("cli"));
    assert_eq!(
        find(&sent.headers, "user-agent"),
        Some(format!("claude-cli/{} (external, sdk-cli)", crate::providers::anthropic::DEFAULT_CLI_VERSION).as_str())
    );
    assert_eq!(find(&sent.headers, "x-tenant"), None, "the subscription route sends no configured extra headers");
}

#[tokio::test]
async fn a_subscription_send_posts_the_claude_code_identity_first_and_names_messages_before_system() {
    let (adapter, http, _store) = subscription(caps_config(sonnet_caps()), vec![Scripted::body(200, OK)]);
    assert_eq!(text_of(&adapter, ask("claude-sonnet-4-6", RequestOptions::default())).await.unwrap(), "fine");
    let sent = &http.sent()[0];
    assert_eq!((sent.method.as_str(), sent.url.as_str()), ("POST", "https://api.anthropic.com/v1/messages"));
    assert_eq!(sent.headers[0], ("Authorization".to_owned(), format!("Bearer {TOKEN}")), "the credential is the first header");
    assert_eq!(find(&sent.headers, "content-type"), Some("application/json"));
    assert_eq!(find(&sent.headers, "anthropic-beta"), Some(format!("{BASE_BETAS},effort-2025-11-24").as_str()));
    let body = body_of(sent);
    let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    assert_eq!(keys[..5], ["model", "max_tokens", "messages", "stream", "system"], "{keys:?}");
    assert_eq!(body["stream"], true);
    assert_eq!(body["system"][0], json!({ "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." }));
    assert_eq!(body["system"][1]["text"], "\n\nYou are a fixture assistant.");
    assert_eq!(body["system"][1]["cache_control"], json!({ "type": "ephemeral", "ttl": "1h" }));
    assert_eq!(body["thinking"], json!({ "type": "adaptive" }));
}

#[tokio::test]
async fn the_subscription_stream_yields_the_text_usage_and_stop_reason() {
    let (adapter, _http, _store) = subscription(caps_config(sonnet_caps()), vec![Scripted::body(200, OK)]);
    let mut stream = adapter.attempt(ask("claude-sonnet-4-6", RequestOptions::default())).await.unwrap();
    let events: Vec<StreamEvent> = drain(stream.as_mut()).await.into_iter().map(Result::unwrap).collect();
    let folded = fold(&events);
    assert_eq!(folded.content, "fine");
    assert_eq!(folded.stop, Some(StopReason::EndTurn));
    let usage = folded.usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (4, 6, 2));
}

#[tokio::test]
async fn an_error_event_after_text_ends_the_subscription_stream_with_its_typed_error_once() {
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
    );
    let (adapter, http, _store) = subscription(caps_config(sonnet_caps()), vec![Scripted::body(200, body)]);
    let mut stream = adapter.attempt(ask("claude-sonnet-4-6", RequestOptions::default())).await.unwrap();
    let items = drain(stream.as_mut()).await;
    let texts: String = items
        .iter()
        .filter_map(|i| match i {
            Ok(StreamEvent::TextDelta(t)) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, "partial");
    let err = items.last().unwrap().as_ref().expect_err("the stream ends in the error");
    assert_eq!(err.kind, ErrorKind::Overloaded);
    assert!(err.exposure.text_emitted);
    assert_eq!(http.sent().len(), 1, "one attempt replays nothing on its own");
}

// Refusals

#[tokio::test]
async fn a_transient_refusal_is_worded_by_its_status_alone_and_another_one_carries_the_scrubbed_body() {
    let (adapter, _http, _store) = subscription(caps_config(sonnet_caps()), vec![Scripted::body(529, &refusal_body("overloaded_error", "Overloaded"))]);
    let err = adapter.attempt(ask("claude-sonnet-4-6", RequestOptions::default())).await.err().expect("refused");
    assert_eq!((err.kind, err.status, err.message.as_str()), (ErrorKind::Overloaded, Some(529), "Anthropic OAuth API 529"));
    let echoed = refusal_body("invalid_request_error", &format!("bad request for {TOKEN}"));
    let (adapter, http, _store) = subscription(caps_config(sonnet_caps()), vec![Scripted::body(400, &echoed)]);
    let err = adapter.attempt(ask("claude-sonnet-4-6", RequestOptions::default())).await.err().expect("refused");
    assert_eq!((err.kind, err.status), (ErrorKind::InvalidRequest, Some(400)));
    assert!(err.message.starts_with("Anthropic OAuth API 400: "), "{}", err.message);
    assert!(!err.message.contains(TOKEN), "the credential the server echoed is redacted: {}", err.message);
    assert_eq!(http.sent().len(), 1);
}

// A refused floor feature and a refused fast request on the subscription route

fn display_caps() -> ModelCaps {
    ModelCaps {
        adaptive_thinking: true,
        effort_levels: vec!["low".into(), "high".into()],
        max_output_tokens: Some(16384),
        thinking_display_updates: true,
        ..ModelCaps::default()
    }
}

#[tokio::test]
async fn a_refused_thinking_display_is_replayed_once_without_it_and_remembered_for_this_route_only() {
    let model = "claude-sonnet-5-6";
    let refused = refusal_body("invalid_request_error", "thinking.adaptive.display: Extra inputs are not permitted");
    let (adapter, http, _store) =
        subscription(caps_config(display_caps()), vec![Scripted::body(400, &refused), Scripted::body(200, OK), Scripted::body(200, OK)]);
    assert_eq!(text_of(&adapter, ask(model, RequestOptions::default())).await.unwrap(), "fine");
    let sent = http.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(body_of(&sent[0])["thinking"], json!({ "type": "adaptive", "display": "updates" }));
    assert!(find(&sent[0].headers, "anthropic-beta").unwrap().contains("thinking-display-updates"));
    assert_eq!(body_of(&sent[1])["thinking"], json!({ "type": "adaptive" }));
    assert!(!find(&sent[1].headers, "anthropic-beta").unwrap().contains("thinking-display-updates"));
    assert!(!claude_floors::enabled(Feature::ProgressUpdates, "anthropic-oauth", model));
    assert!(claude_floors::enabled(Feature::ProgressUpdates, "anthropic", model));
    text_of(&adapter, ask(model, RequestOptions::default())).await.unwrap();
    assert_eq!(body_of(&http.sent()[2])["thinking"], json!({ "type": "adaptive" }), "the next send does not offer it again");
}

#[tokio::test]
async fn a_second_floor_refusal_of_the_same_feature_surfaces_on_the_subscription_route() {
    let refused = refusal_body("invalid_request_error", "thinking.adaptive.display: Extra inputs are not permitted");
    let (adapter, http, _store) = subscription(caps_config(display_caps()), vec![Scripted::body(400, &refused), Scripted::body(400, &refused)]);
    let err = adapter.attempt(ask("claude-sonnet-5-7", RequestOptions::default())).await.err().expect("refused twice");
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(http.sent().len(), 2);
}

#[tokio::test]
async fn a_refused_turn_scoped_reminder_is_replayed_as_a_block_of_the_user_message_on_the_subscription_route() {
    let model = "claude-sonnet-5-8";
    let mut reminder = text_message(Role::User, "remember the rules");
    reminder.source = Some(MessageSource::TailReminder);
    let mut messages = base_messages();
    messages.push(reminder);
    let mut req = request(messages, RequestOptions::default());
    req.model = model.into();
    let refused = refusal_body("invalid_request_error", "messages.2.clear_at: Extra inputs are not permitted");
    let (adapter, http, _store) = subscription(caps_config(display_caps()), vec![Scripted::body(400, &refused), Scripted::body(200, OK)]);
    text_of(&adapter, Arc::new(req)).await.unwrap();
    let sent = http.sent();
    let last = |i: usize| body_of(&sent[i])["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last(0)["role"], "system");
    assert_eq!(last(0)["clear_at"], "next_user_message");
    assert_eq!(last(1)["role"], "user");
    assert!(!claude_floors::enabled(Feature::TurnScopedSystem, "anthropic-oauth", model));
}

#[tokio::test]
async fn a_fast_request_the_pool_refuses_is_replayed_at_standard_speed_on_the_subscription_route() {
    let fast = Arc::new(FastMode::new());
    let mut config = caps_config(ModelCaps { fast_mode: true, manual_thinking: true, max_output_tokens: Some(16384), ..ModelCaps::default() });
    config.fast_mode = Arc::clone(&fast);
    let refused = with_headers(429, &refusal_body("rate_limit_error", "fast pool is full"), &[("retry-after", "120")]);
    let (adapter, http, _store) = subscription(config, vec![refused, Scripted::body(200, OK)]);
    let options = RequestOptions { fast: true, ..RequestOptions::default() };
    assert_eq!(text_of(&adapter, ask("claude-opus-4-8", options)).await.unwrap(), "fine");
    let sent = http.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(body_of(&sent[0])["speed"], "fast");
    assert!(find(&sent[0].headers, "anthropic-beta").unwrap().contains("fast-mode"));
    assert!(body_of(&sent[1]).get("speed").is_none());
    assert!(find(&sent[1].headers, "anthropic-beta").unwrap().contains("fast-mode"), "the betas stay");
    assert!(!fast.available(crate::providers::anthropic::fast_mode::now_ms()));
}

// Timers and a failed listing

struct TimedOut;

#[async_trait]
impl HttpSend for TimedOut {
    async fn send(&self, _: mixdog_core_api::domain::provider::WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        error.message = "the transport's own wording".into();
        error.timed_out = true;
        Err(error)
    }
}

#[tokio::test]
async fn a_token_refresh_the_transport_timed_out_reads_as_a_thirty_second_timeout() {
    let store = MemoryStore::signed_in();
    let session = OAuthSession::new(store.file.clone(), Arc::new(TimedOut));
    let attempt = session.attempt().await.expect("the stored login");
    let err = session.after_rejection(&attempt).await.err().expect("the refresh timed out");
    assert_eq!(err.message, "Anthropic OAuth token refresh timed out after 30000ms");
    // The credential is untouched: a timeout is not a dead grant.
    assert_eq!(session.access_token().await.unwrap(), TOKEN);
}

#[tokio::test]
async fn a_listing_that_fails_leaves_the_catalog_with_its_own_rows() {
    let http = ScriptedHttp::new([Scripted::body(500, &refusal_body("api_error", "down"))]);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
    assert!(adapter.list_models().await.is_err());
    let http = ScriptedHttp::new([Scripted::body(500, &refusal_body("api_error", "down"))]);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
    let source = crate::catalog::ModelSource::of_adapter(mixdog_protocol::ProviderId::from("anthropic"), Arc::new(adapter)).unwrap();
    assert!(!source.list().await.expect("the failure is swallowed into the floor").is_empty());
}
