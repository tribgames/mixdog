//! How a failure becomes the text the user reads and the class it is persisted under: the typed sentence of a provider
//! error, the wording rules for failures that carry only text, the connection sentences, the diagnostic redaction, and
//! the sentence of each transport surface's timeout.

use std::time::Duration;

use mixdog_ai::service::error_text::Descriptor;
use mixdog_ai::service::error_text::ErrorView;
use mixdog_ai::service::error_text::PresentOptions;
use mixdog_ai::service::error_text::TimeoutPhase;
use mixdog_ai::service::error_text::error_line;
use mixdog_ai::service::error_text::present_error_text;
use mixdog_ai::service::error_text::provider_error_text;
use mixdog_ai::service::error_text::safe_error_details;
use mixdog_ai::service::error_text::sent_code;
use mixdog_ai::transport::Surface;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;

fn surface(name: &str) -> PresentOptions {
    PresentOptions { surface: name.to_owned(), ..PresentOptions::default() }
}

fn show(view: &ErrorView) -> String {
    present_error_text(view, &PresentOptions::default())
}

/// The text of a bare string failure.
fn says(text: &str) -> String {
    show(&ErrorView::message(text))
}

fn typed(kind: ErrorKind, status: u16, retry_after: Option<Duration>) -> ProviderError {
    let mut error = ProviderError::new(kind, DeliveryState::Accepted);
    error.status = Some(status);
    error.retry_after = retry_after;
    error
}

fn shown(error: &ProviderError) -> String {
    show(&ErrorView::from(error))
}

#[test]
fn a_classified_provider_error_reads_as_the_sentence_of_its_kind() {
    for (kind, status, text) in [
        (ErrorKind::Overloaded, 529, "Provider is busy at capacity."),
        (ErrorKind::RateLimited, 429, "Provider is rate-limited."),
        (ErrorKind::QuotaExhausted, 429, "Provider usage limit reached."),
        (ErrorKind::Entitlement, 403, "Not included in your plan."),
        (ErrorKind::Billing, 402, "Out of credits or at spend limit."),
        (ErrorKind::Permission, 403, "Access denied by the provider."),
        (ErrorKind::Policy, 400, "Refused by the provider safety policy."),
        (ErrorKind::Auth, 401, "Provider authentication failed."),
    ] {
        assert_eq!(shown(&typed(kind, status, None)), text, "{kind:?}");
    }
}

#[test]
fn a_rate_limit_states_the_wait_the_provider_asked_for() {
    assert_eq!(shown(&typed(ErrorKind::RateLimited, 429, Some(Duration::from_secs(4)))), "Provider is rate-limited (retry in 4s).");
    assert_eq!(shown(&typed(ErrorKind::RateLimited, 429, Some(Duration::from_millis(250)))), "Provider is rate-limited (retry in 250ms).");
    assert_eq!(shown(&typed(ErrorKind::RateLimited, 429, Some(Duration::from_secs(90)))), "Provider is rate-limited (retry in 90s).");
    assert_eq!(shown(&typed(ErrorKind::RateLimited, 429, Some(Duration::from_secs(120)))), "Provider is rate-limited (retry in 2m).");
}

#[test]
fn a_refused_request_reads_as_what_was_refused_not_the_providers_words() {
    let refused = |kind, status, message: &str| {
        let mut error = typed(kind, status, None);
        error.message = message.to_owned();
        shown(&error)
    };
    assert_eq!(refused(ErrorKind::InvalidRequest, 404, "The model `gpt-9` does not exist"), "This model isn't available for this account.");
    assert_eq!(refused(ErrorKind::InvalidRequest, 400, "image dimensions exceed the maximum of 8000 pixels"), "An attached image exceeds the provider limit.");
    assert_eq!(refused(ErrorKind::InvalidRequest, 400, "Invalid schema for function 'lookup'"), "The provider rejected a tool definition.");
    assert_eq!(refused(ErrorKind::RequestTooLarge, 413, "too big"), "The request exceeds the size limit.");
    // The status and the provider's own text ride the summary (issue #374), credentials redacted.
    assert_eq!(refused(ErrorKind::InvalidRequest, 400, "something odd"), "The provider rejected this request (HTTP 400): something odd");
    let long = refused(ErrorKind::InvalidRequest, 400, &"x".repeat(500));
    assert_eq!(long.chars().count(), "The provider rejected this request (HTTP 400): ".chars().count() + 300, "{long}");
    // A failure that already reads as the summary keeps its status, and its text is capped like a first presentation's.
    let again = refused(ErrorKind::InvalidRequest, 400, &format!("The provider rejected this request: {}", "y".repeat(500)));
    assert_eq!(again.chars().count(), "The provider rejected this request (HTTP 400): ".chars().count() + 300, "{again}");
    assert!(again.starts_with("The provider rejected this request (HTTP 400): yyy"), "{again}");
    let leaked = refused(ErrorKind::InvalidRequest, 400, "messages.1: bad block, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    assert!(leaked.starts_with("The provider rejected this request (HTTP 400): messages.1: bad block"), "{leaked}");
    assert!(!leaked.contains("abcdefghijklmnopqrstuvwxyz0123"), "{leaked}");
}

#[test]
fn a_failure_with_only_text_is_read_by_its_wording() {
    for (text, want) in [
        ("provider overloaded", "Provider is busy at capacity."),
        ("The model is currently at capacity", "Provider is busy at capacity."),
        ("invalid api key", "Provider authentication failed."),
        ("expired access token", "Provider authentication failed."),
        ("HTTP 429 too many requests", "Provider quota/rate limit hit."),
        ("insufficient_quota", "Provider quota/rate limit hit."),
        ("Anthropic OAuth rate limit cooldown retryAfter=2m", "Anthropic quota/rate limit hit; retry after 2m. Re-login or switch the provider account to continue now."),
        ("rate limit retryAfter=3600s", "Provider quota/rate limit hit; retry after 1h."),
        ("context window exceeded", "Context too large."),
        ("AGENT_CONTEXT_OVERFLOW", "Context too large."),
        ("compaction failed", "Compact failed."),
        ("socket hang up", "Connection to the provider was lost."),
        ("ECONNRESET happened: connection reset by peer", "Connection to the provider was lost."),
        ("connection refused", "Could not reach the provider."),
        ("fetch failed", "Could not reach the provider."),
        ("connection timed out", "The provider did not respond in time."),
        ("API 503 upstream", "Provider is temporarily unavailable (503)."),
        ("", "Unknown error"),
    ] {
        assert_eq!(says(text), want, "{text:?}");
    }
}

#[test]
fn a_json_error_body_and_an_embedded_error_line_are_unwrapped_to_their_message() {
    assert_eq!(says(r#"{"error":{"message":"Bad thing happened"}}"#), "Bad thing happened");
    assert_eq!(says(r#"{"message":"Top level"}"#), "Top level");
    assert_eq!(says("request failed\nError: the real reason\nmore"), "the real reason");
    assert_eq!(says("Error: prefixed"), "prefixed");
    assert_eq!(says("[provider error] prefixed too"), "[provider error] prefixed too", "a bracket tag without a colon is kept");
}

#[test]
fn the_text_is_one_line_with_session_ids_made_generic_and_cut_to_the_limit() {
    assert_eq!(says("line one\n\n   line   two"), "line one line two");
    assert_eq!(says("see sess_abc123 and run_ABCDEFGHIJKLMNOP1234 now"), "see session and run now");
    assert_eq!(says(&"a".repeat(400)), format!("{}...", "a".repeat(237)));
    let options = PresentOptions { max: Some(60.0), ..PresentOptions::default() };
    assert_eq!(present_error_text(&ErrorView::message("b".repeat(100)), &options), format!("{}...", "b".repeat(57)));
    let tiny = PresentOptions { max: Some(5.0), ..PresentOptions::default() };
    assert_eq!(present_error_text(&ErrorView::message("c".repeat(100)), &tiny), format!("{}...", "c".repeat(29)), "never shorter than 32 characters");
}

#[test]
fn a_surface_names_the_subject_of_a_cancellation_and_a_stall() {
    let cancelled = ErrorView { is_object: true, name: "AbortError".into(), message: "This operation was aborted".into(), ..ErrorView::default() };
    for (name, want) in [("", "Tool was cancelled."), ("turn", "Cancelled"), ("request", "Cancelled"), ("agent", "Agent was cancelled."), ("web_search", "Web search agent was cancelled.")] {
        assert_eq!(present_error_text(&cancelled, &surface(name)), want, "{name:?}");
    }
    let stale = |text: &str, name: &str| present_error_text(&ErrorView::message(text), &surface(name));
    assert_eq!(stale("agent task stale (180000ms)", "agent"), "The agent went stale after 3m without new stream/tool progress.");
    assert_eq!(stale("first response stale (120000ms)", "agent"), "No first response from the agent within 2m.");
    assert_eq!(stale("first transport stale (60000ms)", "agent"), "Agent watchdog stopped the run: no model response in 1m.");
    assert_eq!(stale(r#"Session "sess_x1" closed: aborted during call"#, "agent"), "Agent stopped while waiting for a response.");
    assert_eq!(stale(r#"Session "sess_x1" closed: closed during call"#, ""), "Tool stopped before the response completed.");
    assert_eq!(stale("parent signal aborted", "turn"), "Request was cancelled by its caller.");
    // A compaction failure shows its own text only where the compaction runs.
    assert_eq!(stale("compaction failed: bad summary", "compact"), "compaction failed: bad summary");
    assert_eq!(stale("compaction failed: bad summary", "agent"), "Compact failed.");
}

#[test]
fn a_stalled_or_slow_stream_names_how_long_nothing_arrived() {
    assert_eq!(says("stream timed out after 30000ms of inactivity"), "No progress 30s.");
    let stalled = ErrorView { is_object: true, name: "StreamStalledError".into(), message: "stalled".into(), ..ErrorView::default() };
    assert_eq!(show(&stalled), "No progress.");
    assert_eq!(says("first byte timed out after 90000ms"), "No first response 90s.");
    let waiting = ErrorView { is_object: true, message: "x".into(), timeout_phase: Some(TimeoutPhase::FirstChunk), waited_ms: 45_000, attempts: 2, ..ErrorView::default() };
    assert_eq!(show(&waiting), "Model still thinking: no output in 45s; the provider sent nothing yet; attempts: 2.");
    let named = PresentOptions { provider_label: Some("Acme".into()), ..PresentOptions::default() };
    assert_eq!(present_error_text(&ErrorView { attempts: 0, ..waiting.clone() }, &named), "Model still thinking: no output in 45s; Acme sent nothing yet.");
    let idle = ErrorView { timeout_phase: Some(TimeoutPhase::Idle), message: "timed out after 2500ms".into(), ..waiting };
    assert_eq!(show(&idle), "No progress 3s.", "2.5 s rounds to the nearest second");
}

#[test]
fn a_cut_stream_is_a_lost_connection_unless_the_stream_was_corrupted() {
    let cut = ErrorView { is_object: true, code: "TRUNCATED_STREAM".into(), message: "stream ended".into(), ..ErrorView::default() };
    assert_eq!(show(&cut), "Connection to the provider was lost (TRUNCATED_STREAM).");
    let corrupted = ErrorView { stream_corruption: true, ..cut };
    assert_ne!(show(&corrupted), "Connection to the provider was lost (TRUNCATED_STREAM).");
}

#[test]
fn a_connection_failure_names_the_code_the_socket_reported() {
    let coded = |code: &str, status: u32| show(&ErrorView { is_object: true, code: code.into(), status, message: "boom".into(), ..ErrorView::default() });
    assert_eq!(coded("ECONNRESET", 0), "Connection to the provider was lost (ECONNRESET).");
    assert_eq!(coded("econnreset", 0), "Connection to the provider was lost (ECONNRESET).", "the code is read in upper case");
    assert_eq!(coded("UND_ERR_SOCKET", 0), "Connection to the provider was lost (UND_ERR_SOCKET).");
    assert_eq!(coded("ENOTFOUND", 0), "Could not reach the provider (ENOTFOUND).");
    assert_eq!(coded("ECONNREFUSED", 0), "Could not reach the provider (ECONNREFUSED).");
    assert_eq!(coded("ETIMEDOUT", 0), "The provider did not respond in time (ETIMEDOUT).");
    assert_eq!(coded("UND_ERR_HEADERS_TIMEOUT", 0), "The provider did not respond in time (UND_ERR_HEADERS_TIMEOUT).");
    assert_eq!(coded("CERT_HAS_EXPIRED", 0), "Provider TLS certificate check failed (CERT_HAS_EXPIRED).");
    assert_eq!(coded("UNABLE_TO_VERIFY_LEAF_SIGNATURE", 0), "Provider TLS certificate check failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE).");
}

#[test]
fn an_unavailable_gateway_status_and_a_closed_websocket_read_as_connection_failures() {
    for status in [502, 503, 504, 521, 522, 523, 524] {
        let view = ErrorView { is_object: true, status, message: "x".into(), ..ErrorView::default() };
        assert_eq!(show(&view), format!("Provider is temporarily unavailable ({status})."), "{status}");
    }
    for close in [1000, 1001, 1005, 1006, 1011, 1012] {
        let view = ErrorView { is_object: true, ws_close_code: Some(close), message: "closed".into(), ..ErrorView::default() };
        assert_eq!(show(&view), "Connection to the provider was lost.", "{close}: a close code is not shown");
    }
    let normal = ErrorView { is_object: true, ws_close_code: Some(1008), message: "policy".into(), ..ErrorView::default() };
    assert_eq!(show(&normal), "policy", "a close that is not a loss is the provider's own message");
    let via_message = says("OpenAI WS closed before response.completed (code=1006, reason=)");
    assert_eq!(via_message, "Connection to the provider was lost.");
}

#[test]
fn a_transport_fault_without_a_message_names_its_code_and_how_far_the_request_got() {
    for (fault, text) in [
        (TransportFault::Reset, "Connection to the provider was lost (ECONNRESET)."),
        (TransportFault::Closed, "Connection to the provider was lost (UND_ERR_SOCKET)."),
        (TransportFault::Dns, "Could not reach the provider (ENOTFOUND)."),
        (TransportFault::H2RstStream { code: 8 }, "Connection to the provider was lost (ERR_HTTP2_STREAM_ERROR)."),
        (TransportFault::Tls, "Provider TLS certificate check failed."),
        (TransportFault::TruncatedStream, "Connection to the provider was lost (TRUNCATED_STREAM)."),
    ] {
        let error = ProviderError::transport(fault.clone(), DeliveryState::Ambiguous);
        assert_eq!(provider_error_text(&error, "agent"), text, "{fault:?}");
    }
    let mut spoken = ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
    spoken.message = "read ECONNRESET".into();
    assert_eq!(provider_error_text(&spoken, "agent"), "read ECONNRESET", "a message the error carries is shown as it is");
    for (delivery, text) in [
        (DeliveryState::NotSent, "The provider request failed (unknown, before the request was sent)."),
        (DeliveryState::Ambiguous, "The provider request failed (unknown, while the request was in flight)."),
        (DeliveryState::Accepted, "The provider request failed (unknown, after the provider accepted the request)."),
    ] {
        assert_eq!(provider_error_text(&ProviderError::new(ErrorKind::Unknown, delivery), "agent"), text);
    }
}

#[test]
fn the_persisted_class_of_an_error_carries_its_kind_code_status_and_positive_advice_only() {
    for (kind, name) in [
        (ErrorKind::Overloaded, "overloaded"),
        (ErrorKind::RateLimited, "rate_limited"),
        (ErrorKind::QuotaExhausted, "quota_exhausted"),
        (ErrorKind::Entitlement, "entitlement"),
        (ErrorKind::Billing, "billing"),
        (ErrorKind::Auth, "auth"),
        (ErrorKind::Permission, "permission"),
        (ErrorKind::ContextOverflow, "context_overflow"),
        (ErrorKind::RequestTooLarge, "request_too_large"),
        (ErrorKind::Policy, "policy"),
        (ErrorKind::ServiceTierUnavailable, "service_tier_unavailable"),
        (ErrorKind::InvalidRequest, "invalid_request"),
        (ErrorKind::ImageRejected, "invalid_request"),
        (ErrorKind::ReplayRejected, "invalid_request"),
        (ErrorKind::ToolSchemaRejected, "invalid_request"),
        (ErrorKind::Transient, "transient"),
        (ErrorKind::Unknown, "unknown"),
    ] {
        assert_eq!(Descriptor::of(&ProviderError::new(kind, DeliveryState::Accepted)).kind, name);
    }
    let mut error = typed(ErrorKind::RateLimited, 429, Some(Duration::from_millis(1500)));
    error.code = Some("  Rate_Limit_Exceeded ".into());
    error.reset_at = Some(std::time::UNIX_EPOCH + Duration::from_secs(1_900_000_000));
    let descriptor = Descriptor::of(&error);
    assert_eq!(
        (descriptor.code.as_str(), descriptor.status, descriptor.retry_after_ms, descriptor.reset_at),
        ("rate_limit_exceeded", 429, Some(1500), Some(1_900_000_000_000))
    );
    let plain = Descriptor::of(&ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted));
    assert_eq!((plain.status, plain.retry_after_ms, plain.reset_at), (0, None, None));
}

#[test]
fn the_code_of_a_failure_is_its_own_else_the_name_of_what_cut_the_connection() {
    for (fault, code) in [
        (TransportFault::Reset, "ECONNRESET"),
        (TransportFault::Closed, "UND_ERR_SOCKET"),
        (TransportFault::Dns, "ENOTFOUND"),
        (TransportFault::TruncatedStream, "TRUNCATED_STREAM"),
        (TransportFault::H2GoAway { code: 0 }, "ERR_HTTP2_GOAWAY_SESSION"),
        (TransportFault::Tls, ""),
    ] {
        assert_eq!(sent_code(&ProviderError::transport(fault, DeliveryState::Ambiguous)), code);
    }
    let mut own = ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
    own.code = Some("custom_code".into());
    assert_eq!(sent_code(&own), "custom_code");
}

#[test]
fn an_error_line_starts_with_error_unless_the_text_already_does() {
    let options = PresentOptions::default();
    assert_eq!(error_line(&ErrorView::message("socket hang up"), &options), "Error: Connection to the provider was lost.");
    assert_eq!(error_line(&ErrorView::message("something odd"), &options), "Error: something odd");
    assert_eq!(error_line(&ErrorView::message("TOOL_SURFACE_EXCEEDS_CONTEXT is meant"), &options), "Error: TOOL_SURFACE_EXCEEDS_CONTEXT is meant");
    let surfaced = ErrorView::message("Error: tool surface too big (TOOL_SURFACE_EXCEEDS_CONTEXT)");
    assert_eq!(present_error_text(&surfaced, &options), "tool surface too big (TOOL_SURFACE_EXCEEDS_CONTEXT)", "its own explanation, without the prefix");
    let mutated = ErrorView { is_object: true, code: "PROVIDER_PREFIX_MUTATION".into(), message: "prefix changed".into(), ..ErrorView::default() };
    assert_eq!(show(&mutated), "Session state changed unexpectedly.");
}

#[test]
fn diagnostic_text_loses_control_sequences_credentials_and_image_data() {
    assert_eq!(safe_error_details("\u{1b}[31mred\u{1b}[0m text"), "red text");
    assert_eq!(safe_error_details("a\r\nb\rc"), "a\nb\nc");
    assert_eq!(safe_error_details("clone https://user:hunter2@git.example/x.git"), "clone https://[redacted]@git.example/x.git");
    assert_eq!(safe_error_details("sent Bearer abc.def-123 now"), "sent Bearer [redacted] now");
    assert_eq!(safe_error_details("Basic dXNlcjpwYXNz was sent"), "Basic [redacted] was sent");
    assert_eq!(safe_error_details("GET /v1?token=SECRET&x=1"), "GET /v1?token=[redacted]&x=1");
    assert!(!safe_error_details("Authorization: Bearer abc.def-123").contains("abc.def"));
    assert!(!safe_error_details("GET /v1?api_key=SECRET&x=1").contains("SECRET"));
    assert_eq!(safe_error_details(r#"{"refresh_token": "abc", "ok": 1}"#), r#"{"refresh_token": [redacted], "ok": 1}"#);
    assert_eq!(safe_error_details("password=hunter2 next"), "password=[redacted] next");
    assert_eq!(safe_error_details("key sk-abcdefghijklmnop end"), "key [redacted] end");
    assert_eq!(safe_error_details("token ghp_abcdefghijklmnopqrst end"), "token [redacted] end");
    assert_eq!(safe_error_details("jwt eyJhbGciOi.eyJzdWIiOjF9.c2ln end"), "jwt [redacted] end");
    assert_eq!(safe_error_details("img (data:image/png;base64,iVBORw0KGgo=) end"), "img ([image data]) end");
    let blob = "A".repeat(300);
    assert_eq!(safe_error_details(&format!(r#"{{"data":"{blob}"}}"#)), r#"{"data":"[image data]"}"#);
    assert_eq!(safe_error_details(&format!(r#"{{"data":"{}"}}"#, "A".repeat(100))), format!(r#"{{"data":"{}"}}"#, "A".repeat(100)), "a short data field is not an image");
    assert_eq!(safe_error_details("  padded \n"), "padded");
    let long = safe_error_details(&"z".repeat(13_000));
    assert_eq!(long, format!("{}\n…", "z".repeat(12_000)));
}

#[test]
fn the_secrets_of_a_failure_never_reach_the_text_the_user_reads() {
    let text = says("request to https://u:pw@host/v1?api_key=KEYVALUE failed: Bearer tok.en-123 sk-abcdefghijklmnop");
    for secret in ["pw@", "KEYVALUE", "tok.en-123", "sk-abcdefghijklmnop"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[test]
fn each_transport_surface_words_its_connection_failure_and_its_timeout_as_its_caller_does() {
    let after = Duration::from_millis(2500);
    for (surface, connection, timeout) in [
        (Surface::Fetch, Some("fetch failed"), Some("fetch failed".to_owned())),
        (Surface::FetchSignal, Some("fetch failed"), Some("The operation was aborted due to timeout".to_owned())),
        (Surface::FetchAborted, Some("fetch failed"), Some("This operation was aborted".to_owned())),
        (Surface::FetchLabeled("Cursor request"), Some("fetch failed"), Some("Cursor request timed out after 2500ms".to_owned())),
        (Surface::Sdk, Some("Connection error."), Some("Request timed out.".to_owned())),
        (Surface::Socket, None, None),
        (Surface::SocketLabeled("Cursor request"), None, Some("Cursor request timed out after 2500ms".to_owned())),
        (Surface::SocketConnect, None, Some("Cursor stream was aborted".to_owned())),
    ] {
        assert_eq!(surface.connection_text(), connection, "{surface:?}");
        assert_eq!(surface.timeout_text(after), timeout, "{surface:?}");
    }
    assert_eq!(Surface::Socket.text(|| "connect ECONNREFUSED".to_owned()), "connect ECONNREFUSED", "the link's own sentence where the surface has none");
    assert_eq!(Surface::Fetch.text(|| unreachable!()), "fetch failed");
}
