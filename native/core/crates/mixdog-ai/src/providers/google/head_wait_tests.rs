//! The response-head timer of the Gemini-wire routes and the OpenAI-compatible chat route: a request whose head does not
//! come in its first-byte window is a `headers`-phase timeout on the provider's own ladder (`gemini.mjs:795-807`,
//! `antigravity-transport.mjs:220-253`, `openai-compat-chat-send.mjs:174-181`), and the head that does come tells the run
//! (`onStreamDelta('transport')`).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;

use super::GoogleAdapter;
use super::auth::ApiKeyAuth;
use super::codec::GoogleCodec;
use super::policy;
use super::traits::CatalogGoogleTraits;
use crate::providers::compat::adapter::CompatAdapter;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::profile::CompatProfile;
use crate::providers::first_byte::FirstByteSettings;
use crate::providers::key_source::ApiKeySource;
use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

/// A server that takes the request and never answers.
struct Silent;

#[async_trait]
impl HttpSend for Silent {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        std::future::pending().await
    }
}

struct Empty;

#[async_trait]
impl BodyStream for Empty {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        None
    }
}

/// A server that answers the head at once with `status` and an empty body.
struct Head(u16);

#[async_trait]
impl HttpSend for Head {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: self.0, headers: vec![], body: Box::new(Empty) })
    }
}

struct Key;

#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("k".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        Ok("k".into())
    }
}

fn request(model: &str) -> Arc<ModelRequest> {
    Arc::new(ModelRequest { model: model.to_owned(), messages: vec![Message::new(Role::User, mixdog_core_api::domain::provider::Content::Text("hi".into()))], tools: vec![], options: RequestOptions::default() })
}

fn antigravity(http: Arc<dyn HttpSend>) -> GoogleAdapter {
    let settings = FirstByteSettings::default();
    let traits = Arc::new(CatalogGoogleTraits(Vec::new()));
    GoogleAdapter::new(GoogleCodec::antigravity(super::auth::antigravity::ENDPOINT, "p", "2.19.1", traits), policy::antigravity_with(&settings), http, Arc::new(ApiKeyAuth::new("k")), String::new()).with_first_byte(settings)
}

fn compat(profile: CompatProfile, http: Arc<dyn HttpSend>) -> CompatAdapter {
    CompatAdapter::new(CompatChatCodec::new(profile, CompatConfig::default()), http, Some(Arc::new(Key) as Arc<dyn ApiKeySource>)).with_first_byte(FirstByteSettings::default())
}

/// What one attempt that meets a silent server comes to: the error, and how long it waited.
async fn timed_out(adapter: &dyn ProviderAdapter, request: &Arc<ModelRequest>) -> (ProviderError, Duration) {
    let began = tokio::time::Instant::now();
    let err = adapter.attempt(request.clone()).await.err().expect("the head never comes");
    (err, began.elapsed())
}

fn transport_marks(request: &ModelRequest) -> usize {
    usize::from(request.options.send_identity.take_transport())
}

/// One long first-byte window for every Gemini route (Node gave the Gemini API 60 s), and Antigravity Pro's retry rule: a
/// silent request is retried once after 285 s, and the second silence is the provider's terminal verdict.
#[tokio::test(start_paused = true)]
async fn a_silent_gemini_api_head_times_out_in_285_seconds_in_the_headers_phase() {
    let adapter = super::gemini("k", Arc::new(Silent), Arc::new(CatalogGoogleTraits(Vec::new())));
    let asked = request("gemini-3.6-flash");
    let (err, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert_eq!(err.timeout_phase, Some(StreamTimeoutPhase::Headers));
    assert_eq!(err.code.as_deref(), Some("EPROVIDERTIMEOUT"));
    assert_eq!(err.message, "Gemini REST first byte timed out after 285000ms");
    assert_eq!(err.kind, ErrorKind::Transient);
    assert!(err.timed_out && !err.recovery_exhausted && err.should_retry != Some(false), "the ladder retries it");
    let (again, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert!(again.recovery_terminal && again.recovery_exhausted && again.should_retry == Some(false), "a first-byte timeout past the one retry is final");
    assert!(!adapter.recovers_spent("gemini-3.6-flash", &again), "and gets no non-streaming re-issue");
}

/// Node: a Pro-class model waits `ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS` (300 s, clamped to 285 s) for its head, one
/// first-byte retry on a window doubled to the same ceiling, and the timeout past it ends the ladder.
#[tokio::test(start_paused = true)]
async fn an_antigravity_pro_head_waits_285_seconds_and_retries_one_first_byte_timeout() {
    let adapter = antigravity(Arc::new(Silent));
    let asked = request("gemini-4-argon");
    let (first, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert_eq!(first.message, "Antigravity first byte timed out after 285000ms");
    assert!(!first.recovery_exhausted && first.should_retry != Some(false));
    let (second, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285), "the doubled window is held to the ceiling");
    assert!(second.recovery_terminal && second.recovery_exhausted && second.should_retry == Some(false), "a first-byte timeout past the one retry is final");
}

/// A Flash-class model waits the same long window as Pro (Node gave it the shared 60 s, then 120 s), with the same one
/// first-byte retry.
#[tokio::test(start_paused = true)]
async fn an_antigravity_flash_head_waits_the_same_285_seconds_as_pro() {
    let adapter = antigravity(Arc::new(Silent));
    let asked = request("gemini-3.8-flash");
    let (first, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert_eq!(first.message, "Antigravity first byte timed out after 285000ms");
    assert!(!first.recovery_exhausted);
    let (second, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert!(second.recovery_exhausted && second.should_retry == Some(false));
}

/// A model without a Gemini family (Claude, GPT-OSS on Antigravity) is not a Gemini route: it keeps the shared 60 s on the
/// ordinary ladder.
#[tokio::test(start_paused = true)]
async fn an_antigravity_model_without_a_gemini_family_keeps_the_shared_window() {
    let adapter = antigravity(Arc::new(Silent));
    let asked = request("claude-sonnet-4-6");
    for _ in 0..2 {
        let (err, waited) = timed_out(&adapter, &asked).await;
        assert_eq!((waited, err.recovery_exhausted), (Duration::from_secs(60), false));
    }
}

/// The windows each Gemini route declares to the watchdog are one attempt's, per phase, never a sum over its retries: the Gemini
/// API and Antigravity 285 s for the head and 285 s for the first payload; Vertex AI 600 s of head bound and 285 s of first chunk (one
/// deadline), a Flex route its own 2 x 570 s. A provider that declares none keeps the watchdog's 120 s.
#[test]
fn every_gemini_route_declares_its_long_window_to_the_watchdog() {
    let traits = || Arc::new(CatalogGoogleTraits(Vec::new()));
    let budget = |b: Option<mixdog_core_api::domain::provider::FirstResponseBudget>| b.map(|b| (b.transport_ms, b.semantic_ms));
    let api = super::gemini("k", Arc::new(Silent), traits());
    assert_eq!(budget(api.first_response_budget("gemini-3.6-flash", None)), Some((285_000, 285_000)));
    let antigravity = antigravity(Arc::new(Silent));
    for model in ["gemini-4-argon", "gemini-3.8-flash", ""] {
        assert_eq!(budget(antigravity.first_response_budget(model, None)), Some((285_000, 285_000)), "{model}");
    }
    let vertex = super::vertex_express("k", Arc::new(Silent), traits());
    assert_eq!(budget(vertex.first_response_budget("gemini-3.6-flash", None)), Some((885_000, 885_000)));
    assert_eq!(budget(vertex.first_response_budget("gemini-3.6-flash", Some(&serde_json::json!({ "serviceTier": "flex" })))), Some((1_140_000, 1_140_000)));
}

/// Node: the response head tells the run the server is answering, a refusal's too (`gemini.mjs:811`,
/// `antigravity-transport.mjs:257`), so a ladder of refused requests is not read as a hung connection.
#[tokio::test(start_paused = true)]
async fn a_gemini_head_marks_transport_whatever_its_status() {
    for status in [200_u16, 429] {
        let adapter = super::gemini("k", Arc::new(Head(status)), Arc::new(CatalogGoogleTraits(Vec::new())));
        let asked = request("gemini-3.6-flash");
        let _ = adapter.attempt(asked.clone()).await;
        assert_eq!(transport_marks(&asked), 1, "status {status}");
    }
}

/// Node: an OpenAI-compatible chat request waits `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (60 s) per attempt for its head,
/// `TIMEOUT_PHASE.HEADERS`, every attempt on the same window while its profile caps no first-byte retries.
#[tokio::test(start_paused = true)]
async fn a_silent_compat_chat_head_times_out_in_sixty_seconds_on_every_attempt() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Silent));
    let asked = request("deepseek-v4-pro");
    for _ in 0..3 {
        let (err, waited) = timed_out(&adapter, &asked).await;
        assert_eq!(waited, Duration::from_secs(60));
        assert_eq!(err.timeout_phase, Some(StreamTimeoutPhase::Headers));
        assert_eq!(err.message, "deepseek first byte timed out after 60000ms");
        assert!(!err.recovery_exhausted);
    }
}

/// Node: Mimo's profile gives its head 285 s (300 s held to the ceiling), one first-byte retry, then the ladder ends
/// (`firstByteRetries: 1`, `openai-compat-retry-profile.mjs:85-93,234-239`).
#[tokio::test(start_paused = true)]
async fn mimo_retries_one_silent_head_and_then_stops() {
    let adapter = compat(CompatProfile::mimo_oauth(), Arc::new(Silent));
    let asked = request("mimo-v2.6-pro");
    let (first, waited) = timed_out(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(285));
    assert!(!first.recovery_exhausted);
    let (second, _) = timed_out(&adapter, &asked).await;
    assert!(second.recovery_exhausted && second.should_retry == Some(false));
}

/// Node: the stream-open `transport` mark is made for an accepted chat response only (a refusal is the SDK's thrown error).
#[tokio::test(start_paused = true)]
async fn a_compat_chat_head_marks_transport_only_when_it_is_accepted() {
    let accepted = request("deepseek-v4-pro");
    let _ = compat(CompatProfile::deepseek(), Arc::new(Head(200))).attempt(accepted.clone()).await;
    assert_eq!(transport_marks(&accepted), 1);
    let refused = request("deepseek-v4-pro");
    let _ = compat(CompatProfile::deepseek(), Arc::new(Head(500))).attempt(refused.clone()).await;
    assert_eq!(transport_marks(&refused), 0);
}

/// A server that answers the head at once with 200 and a body that delivers `(wait, bytes)` in order, then stays silent.
struct Streaming(Vec<(u64, &'static str)>);

#[async_trait]
impl HttpSend for Streaming {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: 200, headers: vec![], body: crate::providers::idle::testing::Timetable::of(&self.0) })
    }
}

const ROLE_ONLY: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n";
const HELLO: &str = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n";

/// What reading a compat stream (its head already answered) to its first failure comes to: the error, the time it took and
/// the events before it.
async fn read_to_failure(adapter: &CompatAdapter, asked: &Arc<ModelRequest>) -> (ProviderError, Duration, Vec<mixdog_core_api::domain::provider::StreamEvent>) {
    let mut stream = adapter.attempt(asked.clone()).await.ok().expect("the head is answered");
    let began = tokio::time::Instant::now();
    let mut seen = Vec::new();
    loop {
        match stream.next().await.expect("the stream ends in a failure") {
            Ok(event) => seen.push(event),
            Err(err) => return (err, began.elapsed(), seen),
        }
    }
}

/// A head that came ends only the head wait: with nothing after it the first-payload window, the same first-byte window
/// again, ends the attempt as a first-chunk timeout, counted against the send (`openai-compat-chat-stream.mjs:78-99`).
#[tokio::test(start_paused = true)]
async fn a_compat_head_then_silence_times_out_in_the_first_chunk_window() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![])));
    let asked = request("deepseek-v4-pro");
    let (err, waited, _) = read_to_failure(&adapter, &asked).await;
    assert_eq!(waited, Duration::from_secs(60));
    assert_eq!((err.code.as_deref(), err.timeout_phase), (Some("EPROVIDERTIMEOUT"), Some(StreamTimeoutPhase::FirstChunk)));
    assert_eq!(err.message, "deepseek first byte timed out after 60000ms");
    assert_eq!(asked.options.send_identity.first_byte_timeouts().count, 1);
}

/// Comments and the bytes of an unfinished record are not a decoded event: they do not end the first-payload window.
#[tokio::test(start_paused = true)]
async fn comments_and_a_fragmented_record_do_not_satisfy_the_first_payload_window() {
    let pings = vec![(10, ": ping\n\n"); 8];
    let (err, waited, seen) = read_to_failure(&compat(CompatProfile::deepseek(), Arc::new(Streaming(pings))), &request("deepseek-v4-pro")).await;
    assert_eq!((waited, err.timeout_phase), (Duration::from_secs(60), Some(StreamTimeoutPhase::FirstChunk)));
    assert!(seen.iter().all(|e| matches!(e, mixdog_core_api::domain::provider::StreamEvent::ProviderKeepalive)), "{seen:?}");
    let fragment = vec![(10, "data: {\"choices\":[{\"delta\":{\"ro"), (10, "le\":\"assistant\"")];
    let (err, waited, _) = read_to_failure(&compat(CompatProfile::deepseek(), Arc::new(Streaming(fragment))), &request("deepseek-v4-pro")).await;
    assert_eq!((waited, err.timeout_phase), (Duration::from_secs(60), Some(StreamTimeoutPhase::FirstChunk)));
}

/// A record that comes just inside the window ends it; the stream is then bounded by the first-output window.
#[tokio::test(start_paused = true)]
async fn a_first_payload_just_inside_the_window_is_accepted() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![(59, HELLO)])));
    let mut stream = adapter.attempt(request("deepseek-v4-pro")).await.ok().expect("the head is answered");
    let began = tokio::time::Instant::now();
    let first = stream.next().await.expect("an event");
    assert!(first.is_ok(), "{first:?}");
    assert_eq!(began.elapsed(), Duration::from_secs(59));
}

/// A role-only event is a payload, not output: the first-payload window is over, and silence after it ends the stream by the
/// first-output window (`ESTREAMSTALL`), not as a first-byte timeout.
#[tokio::test(start_paused = true)]
async fn a_role_only_event_then_silence_fails_by_the_first_output_window() {
    let asked = request("deepseek-v4-pro");
    let (err, waited, _) = read_to_failure(&compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![(1, ROLE_ONLY)]))), &asked).await;
    assert_eq!((err.code.as_deref(), err.timeout_phase), (Some("ESTREAMSTALL"), Some(StreamTimeoutPhase::Idle)));
    assert!(waited > Duration::from_secs(60), "not cut by the first-byte window: {waited:?}");
    assert_eq!(asked.options.send_identity.first_byte_timeouts().count, 0);
}

/// The non-streaming re-issue answers only when the generation is done: its one bound is the generate-total window over the
/// head and the body together, so a head that came and a body that never completes fails it at 285 s.
#[tokio::test(start_paused = true)]
async fn a_compat_reissue_whose_body_never_completes_fails_at_the_generate_total_bound() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![])));
    let began = tokio::time::Instant::now();
    let err = adapter.recover_spent(request("deepseek-v4-pro")).await.err().expect("the body never completes");
    assert_eq!(began.elapsed(), Duration::from_secs(285));
    assert_eq!(err.message, "deepseek non-streaming fallback timed out after 285000ms");
}

/// The idle window starts with the first output: it cannot cut the wait for the first payload. A Gemini API head that came and a
/// body that stays silent ends at the first-chunk window (285 s), as a first-byte timeout that is counted, so the next such timeout
/// is the terminal one; an idle stall at the semantic window would have fired first and escaped the count.
#[tokio::test(start_paused = true)]
async fn the_idle_window_cannot_cut_the_wait_for_the_first_payload() {
    let adapter = super::gemini("k", Arc::new(Streaming(vec![])), Arc::new(CatalogGoogleTraits(Vec::new())));
    let asked = request("gemini-3.6-flash");
    for terminal in [false, true] {
        let mut stream = adapter.attempt(asked.clone()).await.ok().expect("the head is answered");
        let began = tokio::time::Instant::now();
        let err = stream.next().await.expect("the silence ends the stream").expect_err("a timeout");
        assert_eq!(began.elapsed(), Duration::from_secs(285));
        assert_eq!((err.code.as_deref(), err.timeout_phase), (Some("EGEMINITIMEOUT"), Some(StreamTimeoutPhase::FirstChunk)));
        assert_eq!(err.message, "Gemini REST streamGenerateContent first byte timed out after 285000ms");
        assert_eq!(err.recovery_terminal, terminal, "the shared first-byte retry: one retry, then terminal");
    }
}

/// Every exchange begins an attempt of its own: a retry's head, payload and first-output clocks are fresh, on Vertex AI as on
/// the Gemini API, with no display stage deciding it.
#[tokio::test(start_paused = true)]
async fn every_gemini_exchange_begins_a_fresh_attempt() {
    use mixdog_core_api::domain::provider::Boundary;
    for adapter in [
        super::vertex_express("k", Arc::new(Streaming(vec![])), Arc::new(CatalogGoogleTraits(Vec::new()))),
        super::gemini("k", Arc::new(Streaming(vec![])), Arc::new(CatalogGoogleTraits(Vec::new()))),
    ] {
        let asked = request("gemini-3.6-flash");
        let _first = adapter.attempt(asked.clone()).await.ok().expect("answered");
        let _second = adapter.attempt(asked.clone()).await.ok().expect("answered");
        let started: Vec<u64> = asked.options.send_identity.take_boundaries().into_iter().filter(|(_, b)| *b == Boundary::AttemptStarted).map(|(id, _)| id).collect();
        assert_eq!(started.len(), 2, "one attempt per exchange");
        assert_ne!(started[0], started[1]);
        assert_eq!(asked.options.send_identity.attempt_context().id, started[1]);
    }
}

/// A read that holds a decoded failure behind its events returns it before waiting for more input: the idle window must not
/// replace a refusal the decoder already had.
#[tokio::test(start_paused = true)]
async fn a_failure_decoded_with_a_text_delta_is_returned_before_the_body_is_waited_on() {
    let both = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"error\":{\"message\":\"refused\",\"code\":\"server_error\"}}\n\n";
    let (err, waited, seen) = read_to_failure(&compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![(1, both)]))), &request("deepseek-v4-pro")).await;
    assert_eq!(waited, Duration::from_secs(1), "the open body is not waited on");
    assert_ne!(err.code.as_deref(), Some("ESTREAMSTALL"), "{err:?}");
    assert!(err.message.contains("refused"), "{}", err.message);
    assert!(seen.iter().any(|e| matches!(e, mixdog_core_api::domain::provider::StreamEvent::TextDelta(_))), "{seen:?}");
}

/// A retry's compat stream gets the whole first-output window again, counted from its own first payload.
#[tokio::test(start_paused = true)]
async fn a_compat_retry_gets_a_fresh_first_output_window() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![(1, ROLE_ONLY)])));
    let asked = request("deepseek-v4-pro");
    let (first_err, first_wait, _) = read_to_failure(&adapter, &asked).await;
    let (second_err, second_wait, _) = read_to_failure(&adapter, &asked).await;
    assert_eq!((first_err.code.as_deref(), second_err.code.as_deref()), (Some("ESTREAMSTALL"), Some("ESTREAMSTALL")));
    assert_eq!(first_wait, second_wait, "the second attempt does not inherit the first one's spent window");
    assert!(second_wait > Duration::from_secs(60));
}

/// A quiet payload (a role-only chunk with empty text) decodes to a chunk that carries no output.
const META: &str = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"\"}]}}]}\n\n";

/// A Gemini API stream whose payloads carry no output, then silence, ends at the full first-output window (600 s) counted from
/// the first payload; further metadata does not renew it. The enforcement is the driver's, so a direct adapter call has it.
#[tokio::test(start_paused = true)]
async fn google_metadata_only_payloads_then_silence_expire_at_the_full_first_output_window() {
    let adapter = super::gemini("k", Arc::new(Streaming(vec![(0, META), (100, META), (100, META)])), Arc::new(CatalogGoogleTraits(Vec::new())));
    let asked = request("gemini-3.6-flash");
    let mut stream = adapter.attempt(asked.clone()).await.ok().expect("the head is answered");
    let began = tokio::time::Instant::now();
    let err = loop {
        match stream.next().await.expect("the silence ends the stream") {
            Ok(_) => {}
            Err(err) => break err,
        }
    };
    assert_eq!(began.elapsed(), Duration::from_secs(600));
    assert_eq!((err.code.as_deref(), err.timeout_phase), (Some("EGEMINITIMEOUT"), Some(StreamTimeoutPhase::Idle)));
    assert_eq!(err.message, "Gemini REST streamGenerateContent first output timed out after 600000ms");
    assert_eq!(asked.options.send_identity.first_byte_timeouts().count, 0, "not a first-byte timeout");
}

/// The non-streaming re-issue survives 120 s and expires at its 285 s generation total, with its head early.
#[tokio::test(start_paused = true)]
async fn a_compat_reissue_survives_120_seconds_and_expires_at_its_285_second_total() {
    let adapter = compat(CompatProfile::deepseek(), Arc::new(Streaming(vec![])));
    let began = tokio::time::Instant::now();
    let mut reissue = std::pin::pin!(adapter.recover_spent(request("deepseek-v4-pro")));
    tokio::select! {
        _ = mixdog_rt::time::sleep(Duration::from_secs(120)) => {}
        _ = &mut reissue => panic!("the re-issue ended before its total"),
    }
    let err = reissue.await.err().expect("the body never completes");
    assert_eq!(began.elapsed(), Duration::from_secs(285));
    assert_eq!(err.message, "deepseek non-streaming fallback timed out after 285000ms");
}

/// An authorization that the server rejects and the credential source can replace.
struct Replaceable;

#[async_trait]
impl super::auth::RequestAuth for Replaceable {
    async fn authorize(&self) -> Result<super::auth::Authorization, ProviderError> {
        Ok(super::auth::Authorization { headers: vec![("x-goog-api-key".into(), "k".into())], identity: String::new() })
    }
    async fn rejected(&self, _: &super::auth::Authorization) -> bool {
        true
    }
}

/// Answers 401 to the first request and 200 to the next.
struct UnauthorizedOnce(std::sync::atomic::AtomicU32);

#[async_trait]
impl HttpSend for UnauthorizedOnce {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let status = if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 { 401 } else { 200 };
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Empty) })
    }
}

/// The resend after a refreshed credential is an attempt of its own with a fresh identity and the whole window.
#[tokio::test(start_paused = true)]
async fn the_authorization_resend_is_a_fresh_attempt_with_the_whole_window() {
    use mixdog_core_api::domain::provider::Boundary;
    let settings = FirstByteSettings::default();
    let traits = Arc::new(CatalogGoogleTraits(Vec::new()));
    let adapter = GoogleAdapter::new(GoogleCodec::antigravity(super::auth::antigravity::ENDPOINT, "p", "2.19.1", traits), policy::antigravity_with(&settings), Arc::new(UnauthorizedOnce(Default::default())), Arc::new(Replaceable), String::new()).with_first_byte(settings);
    let asked = request("gemini-3.8-flash");
    let _stream = adapter.attempt(asked.clone()).await.ok().expect("the resend is answered");
    let started: Vec<u64> = asked.options.send_identity.take_boundaries().into_iter().filter(|(_, b)| *b == Boundary::AttemptStarted).map(|(id, _)| id).collect();
    assert_eq!(started.len(), 2, "the first send and the resend");
    assert_ne!(started[0], started[1]);
    let ctx = asked.options.send_identity.attempt_context();
    assert_eq!((ctx.id, ctx.window), (started[1], Duration::from_secs(285)), "the resend has the whole window");
}