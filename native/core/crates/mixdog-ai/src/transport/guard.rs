//! The one place every provider exchange has its credentials redacted from what comes back.
//!
//! [`Guarded`] wraps a transport seam ([`HttpSend`], [`BidiOpen`], [`WsDial`]). Before the request goes out it registers the
//! credentials the request carries ([`carried::attach_request`], [`carried::attach_upgrade`]: a few index entries per form,
//! no rebuild) in the process-wide registry, which also holds what each provider's own sign-in and refresh keep, and
//! redacts every credential the registry holds, however the text encodes it, from everything that leaves the transport on
//! any exchange's behalf (an error that repeats the old credential of a refreshed token, or the key of an earlier request,
//! is as redacted as one that repeats the current one). Each text, each chunk of a stream included, is read against the
//! registry as it is then ([`carried::remembered`]): a response that began before another request attached a credential is
//! searched for it from its next chunk on, the part of its text still held included:
//!
//! - the response's headers, whatever its status (a redirect's `Location`, an echo header);
//! - the body of a refusal, of a redirect and of an event stream, as it streams ([`carried::Stream`]), after the body was
//!   decoded (the Node-equal client undoes `content-encoding` below this seam; the HTTP/2 clients ask for none);
//! - the text of a transport failure (its message and code: a connect error names the URL, query string included);
//! - a WebSocket upgrade's refusal (headers and body), its text frames, its close reason, its protocol violation and a
//!   proxy's refusal of the tunnel.
//!
//! Every error, refusal, redirect, log line, trace and stage a provider builds from a response is built from these, so none
//! of them holds a credential the process attached. Two bodies pass whole, by rule: a token grant (a successful answer to
//! a token request, which has a `grant_type`, or to an exchange declared a grant: it names the credentials it issues, often
//! the very refresh token the request carried, and redacting it would break the sign-in; the provider that reads it
//! registers what it keeps), and a body of length-framed binary messages (Connect, gRPC, protobuf) cannot lose bytes
//! without breaking its frames; the decoders of those frames scrub the error text they read with the registry too
//! (`scrub_oauth_secrets` and Devin's `redact`). Every other successful body, a JSON document included, is redacted as it
//! streams: its text reaches the model, the transcript and the logs. No provider reaches the network
//! but through these seams: the only implementations of them outside tests are this guard and the links that wrap
//! themselves in it (`every_seam_outside_tests_is_guarded`).

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use super::link::BidiOpen;
use super::link::BodyStream;
use super::link::Exchange;
use super::link::FrameSink;
use super::link::HttpResponse;
use super::link::HttpSend;
use super::link::WsDial;
use super::link::WsSocket;
use super::ws::ConnectError;
use super::ws::Message;
use super::ws::WsEnding;
use crate::oauth::carried;
use crate::oauth::carried::Matcher;

/// A seam whose every exchange is redacted of the credentials it carried.
pub struct Guarded<T>(pub T);

/// A body redacted as it streams: a credential cut by a chunk boundary is held until the chunk that finishes it, and only
/// an end that may still become one waits at all.
struct RedactedBody {
    inner: Box<dyn BodyStream>,
    stream: carried::Stream,
    ended: bool,
    fault: Option<TransportFault>,
}

#[async_trait]
impl BodyStream for RedactedBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            if self.ended {
                return self.fault.take().map(Err);
            }
            match self.inner.next().await {
                Some(Ok(chunk)) => {
                    let out = self.stream.push(&chunk);
                    if !out.is_empty() {
                        return Some(Ok(Bytes::from(out)));
                    }
                }
                end => {
                    // The body is over (cleanly or by a fault): what was held is whole text now.
                    self.ended = true;
                    self.fault = end.and_then(Result::err);
                    let out = self.stream.finish();
                    if !out.is_empty() {
                        return Some(Ok(Bytes::from(out)));
                    }
                }
            }
        }
    }

    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }
}

/// A body of length-prefixed binary frames (Connect, gRPC, protobuf): a credential cut out of a frame's payload would leave
/// the frame's length wrong. Its decoder redacts the text it reads out of the frames instead.
fn framed_binary(headers: &[(String, String)]) -> bool {
    headers.iter().filter(|(name, _)| name.eq_ignore_ascii_case("content-type")).any(|(_, value)| {
        let kind = value.trim().to_ascii_lowercase();
        ["application/connect", "application/grpc", "application/proto", "application/x-protobuf", "application/octet-stream"].iter().any(|binary| kind.starts_with(binary))
    })
}

fn clean_response(mut response: HttpResponse, matcher: &Arc<Matcher>, grant: bool) -> HttpResponse {
    matcher.redact_headers(&mut response.headers);
    // A token grant carries the credentials it issues, often the refresh token the request carried: it is the one
    // successful body that arrives whole. Every other body, a successful document or stream and a refusal alike, reaches
    // the model, the transcript or a log, and is redacted as it streams (a framed binary body by its decoder), against the
    // registry as it is at each chunk: even one that holds nothing yet.
    if (grant && response.is_success()) || framed_binary(&response.headers) {
        return response;
    }
    response.body = Box::new(RedactedBody { inner: response.body, stream: carried::Stream::new(matcher.clone()), ended: false, fault: None });
    response
}

#[async_trait]
impl<T: HttpSend> HttpSend for Guarded<T> {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        carried::attach_request(&request);
        let matcher = carried::remembered();
        let grant = exchange.grant || carried::is_token_request(&request.body);
        match self.0.send(request, exchange).await {
            Ok(response) => Ok(clean_response(response, &matcher, grant)),
            Err(error) => Err(matcher.redact_error(error)),
        }
    }
}

#[async_trait]
impl<T: BidiOpen> BidiOpen for Guarded<T> {
    async fn open(&self, request: WireRequest, first: Vec<u8>, exchange: Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        carried::attach_request(&request);
        let matcher = carried::remembered();
        match self.0.open(request, first, exchange).await {
            Ok((response, sink)) => Ok((clean_response(response, &matcher, false), sink)),
            Err(error) => Err(matcher.redact_error(error)),
        }
    }
}

/// An open WebSocket whose frames and closing are redacted.
struct RedactedSocket {
    inner: Box<dyn WsSocket>,
    matcher: Arc<Matcher>,
}

#[async_trait]
impl WsSocket for RedactedSocket {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        self.inner.send(message).await
    }

    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        let message = self.inner.recv().await?;
        Some(message.map(|message| match message {
            Message::Text(text) => self.matcher.redacted(text.as_bytes()).map_or(Message::Text(text), |clean| Message::text(String::from_utf8_lossy(&clean).into_owned())),
            other => other,
        }))
    }

    fn link(&self) -> Arc<dyn TransportKeepalive> {
        self.inner.link()
    }

    fn ending(&self) -> Option<WsEnding> {
        self.inner.ending().map(|ending| match ending {
            WsEnding::Close { code, reason } => WsEnding::Close { code, reason: self.matcher.redact_str(&reason) },
            WsEnding::Violation { message, code, close_code } => WsEnding::Violation { message: self.matcher.redact_str(&message), code, close_code },
        })
    }

    fn close(self: Box<Self>, code: u16, reason: &str) {
        self.inner.close(code, reason);
    }

    fn closer(&self) -> Option<super::ws::WsCloser> {
        self.inner.closer()
    }

    fn closed(&self) -> Option<tokio::sync::watch::Receiver<bool>> {
        self.inner.closed()
    }
}

fn clean_upgrade(response: &mut Response<Option<Vec<u8>>>, matcher: &Matcher) {
    for value in response.headers_mut().values_mut() {
        if let Some(clean) = matcher.redacted(value.as_bytes())
            && let Ok(clean) = tokio_tungstenite::tungstenite::http::HeaderValue::from_bytes(&clean)
        {
            *value = clean;
        }
    }
    if let Some(body) = response.body_mut()
        && let Some(clean) = matcher.redacted(body)
    {
        *body = clean;
    }
}

#[async_trait]
impl<T: WsDial> WsDial for Guarded<T> {
    async fn dial(&self, request: Request) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        let headers: Vec<(String, String)> =
            request.headers().iter().filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))).collect();
        carried::attach_upgrade(&request.uri().to_string(), &headers);
        let matcher = carried::remembered();
        match self.0.dial(request).await {
            Ok((socket, mut response)) => {
                clean_upgrade(&mut response, &matcher);
                Ok((Box::new(RedactedSocket { inner: socket, matcher }), response))
            }
            Err(ConnectError::Rejected(mut response)) => {
                clean_upgrade(&mut response, &matcher);
                Err(ConnectError::Rejected(response))
            }
            Err(ConnectError::Proxy { code, message }) => Err(ConnectError::Proxy { code, message: matcher.redact_str(&message) }),
            Err(other) => Err(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use base64::Engine as _;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;

    use super::*;
    use crate::transport::deadlines::TOKEN_EXCHANGE;

    struct Chunks(VecDeque<&'static [u8]>);

    #[async_trait]
    impl BodyStream for Chunks {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.pop_front().map(|chunk| Ok(Bytes::from_static(chunk)))
        }
    }

    /// A server that answers every request with a refusal repeating the request's key as it sees fit.
    struct Echo {
        chunks: Vec<&'static [u8]>,
        location: &'static str,
        fail_with: Option<&'static str>,
        content_type: &'static str,
        status: u16,
    }

    #[async_trait]
    impl HttpSend for Echo {
        async fn send(&self, _request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
            if let Some(message) = self.fail_with {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = message.to_owned();
                return Err(error);
            }
            Ok(HttpResponse {
                status: self.status,
                headers: vec![("location".into(), self.location.into()), ("x-request-id".into(), "req_1".into()), ("content-type".into(), self.content_type.into())],
                body: Box::new(Chunks(self.chunks.iter().copied().collect())),
            })
        }
    }

    fn request(url: &str, headers: &[(&str, &str)]) -> WireRequest {
        WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url: url.into(),
            headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
            body: Vec::new(),
        }
    }

    async fn body_of(response: HttpResponse) -> String {
        String::from_utf8(response.read_all().await.expect("the body").body).unwrap()
    }

    /// The key a request carries in its query string comes back percent-encoded in a refusal cut across chunks and in a
    /// redirect's `Location`; none of it reaches the caller.
    #[tokio::test]
    async fn a_key_the_server_repeats_in_any_form_never_reaches_the_caller() {
        // `guard-key/with+chars-91c4`, as the query string, the body and the Location spell it.
        let link = Guarded(Echo {
            chunks: vec![b"{\"error\":\"key guard-key%2Fwith%2", b"Bchars-91c4 and guard-ke", b"y/with+chars-91c4 refused\"}"],
            location: "https://example.test/retry?key=guard-key%2Fwith%2Bchars-91c4",
            fail_with: None,
            content_type: "application/json",
            status: 400,
        });
        let sent = request("https://example.test/v1?key=guard-key%2Fwith%2Bchars-91c4&alt=sse", &[("accept", "text/event-stream")]);
        let response = link.send(sent, TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(response.headers[0].1, "https://example.test/retry?key=[REDACTED]");
        assert_eq!(response.headers[1].1, "req_1");
        assert_eq!(body_of(response).await, "{\"error\":\"key [REDACTED] and [REDACTED] refused\"}");
    }

    /// A Basic credential's base64 and the base64url of its `user:key` are the forms a proxy or a log echoes.
    #[tokio::test]
    async fn a_basic_credential_is_redacted_in_its_base64_forms() {
        let key = "basic-guard-key-3e8d77";
        let basic = base64::engine::general_purpose::STANDARD.encode(format!("user:{key}"));
        let url_safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("user:{key}"));
        let body: &'static [u8] = Box::leak(format!("sent {basic}, {url_safe} and {key}").into_bytes().into_boxed_slice());
        let link = Guarded(Echo { chunks: vec![body], location: "", fail_with: None, content_type: "text/event-stream", status: 200 });
        let sent = request("https://example.test/v1", &[("authorization", &format!("Basic {basic}"))]);
        let response = link.send(sent, TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(response).await, "sent [REDACTED], [REDACTED] and [REDACTED]");
    }

    /// A transport error names the URL it was sent to, query string included.
    #[tokio::test]
    async fn a_transport_error_does_not_name_the_key_in_its_url() {
        let link = Guarded(Echo { chunks: Vec::new(), location: "", fail_with: Some("error sending request for url (https://example.test/v1?key=guard-url-key-5a60)"), content_type: "", status: 0 });
        let error = link.send(request("https://example.test/v1?key=guard-url-key-5a60", &[]), TOKEN_EXCHANGE).await.err().expect("failed");
        assert_eq!(error.message, "error sending request for url (https://example.test/v1?key=[REDACTED])");
    }

    /// A Connect stream's frames carry their own length: the credential in a frame's payload is left for the decoder to redact,
    /// and the headers are redacted all the same.
    #[tokio::test]
    async fn a_framed_binary_body_is_not_cut() {
        let link = Guarded(Echo {
            chunks: vec![b"\0\0\0\0\x2fthe credential framed-key-7c19ab was refused...."],
            location: "https://example.test/?key=framed-key-7c19ab",
            fail_with: None,
            content_type: "application/connect+proto",
            status: 400,
        });
        let sent = request("https://example.test/run", &[("authorization", "Bearer framed-key-7c19ab")]);
        let response = link.send(sent, TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(response.headers[0].1, "https://example.test/?key=[REDACTED]");
        assert_eq!(body_of(response).await, "\0\0\0\0\x2fthe credential framed-key-7c19ab was refused....");
    }

    /// A token grant answers with the credentials it issues, and an issued refresh token is often the one the request carried:
    /// a successful answer that is not an event stream is the caller's to read, never redacted.
    #[tokio::test]
    async fn a_token_grant_that_reissues_the_carried_token_arrives_whole() {
        let grant: &'static [u8] = br#"{"access_token":"fresh-access-token-91","refresh_token":"carried-refresh-token-5d2e"}"#;
        let link = Guarded(Echo { chunks: vec![grant], location: "", fail_with: None, content_type: "application/json", status: 200 });
        let sent = request("https://example.test/token", &[("content-type", "application/x-www-form-urlencoded")]);
        let sent = WireRequest { body: b"grant_type=refresh_token&refresh_token=carried-refresh-token-5d2e".to_vec(), ..sent };
        let response = link.send(sent, TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(response).await.as_bytes(), grant);
    }

    struct Rejecting;

    #[async_trait]
    impl WsDial for Rejecting {
        async fn dial(&self, _request: Request) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
            let rejection = Response::builder()
                .status(400)
                .header("x-echo", "token guard-ws-token-77b1")
                .body(Some(b"the credential guard-ws-token-77b1 was refused".to_vec()))
                .unwrap();
            Err(ConnectError::Rejected(rejection))
        }
    }

    /// An upgrade the server refuses with the bearer the upgrade carried in its body and its headers.
    #[tokio::test]
    async fn a_refused_upgrade_does_not_echo_its_bearer() {
        let request = Request::builder()
            .uri("wss://example.test/v1/realtime")
            .header("authorization", "Bearer guard-ws-token-77b1")
            .body(())
            .unwrap();
        let Err(ConnectError::Rejected(response)) = Guarded(Rejecting).dial(request).await else { panic!("the upgrade is refused") };
        assert_eq!(response.headers()["x-echo"], "token [REDACTED]");
        assert_eq!(response.body().as_deref(), Some(b"the credential [REDACTED] was refused".as_slice()));
    }

    /// A bearer shorter than eight bytes is redacted from an echoed header (item 2).
    #[tokio::test]
    async fn a_short_bearer_is_redacted_from_an_echoed_header() {
        let link = Guarded(Echo { chunks: vec![b"bad Bearer abc1234"], location: "https://example.test/?token=abc1234", fail_with: None, content_type: "text/plain", status: 401 });
        let response = link.send(request("https://example.test/v1", &[("authorization", "Bearer abc1234")]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(response.headers[0].1, "https://example.test/?token=[REDACTED]");
        assert_eq!(body_of(response).await, "bad Bearer [REDACTED]");
    }

    /// A field named `code` in an ordinary request body is no credential, and what one exchange carried is nothing to
    /// another (item 3): a later refusal that repeats the tool result arrives whole.
    #[tokio::test]
    async fn an_ordinary_body_field_named_code_is_never_redacted() {
        let link = Guarded(Echo { chunks: vec![br#"{"error":"print(1) failed"}"#], location: "", fail_with: None, content_type: "application/json", status: 400 });
        let with_code = WireRequest { body: br#"{"input":[{"type":"function_call_output","output":{"code":"print(1)"}}]}"#.to_vec(), ..request("https://example.test/v1", &[]) };
        assert_eq!(body_of(link.send(with_code, TOKEN_EXCHANGE).await.expect("answered")).await, r#"{"error":"print(1) failed"}"#);
        assert_eq!(body_of(link.send(request("https://example.test/v2", &[]), TOKEN_EXCHANGE).await.expect("answered")).await, r#"{"error":"print(1) failed"}"#);
    }

    /// A resend after a refresh carries the new credential; the refusal of the resend repeats the old one (review 1123v item 1).
    #[tokio::test]
    async fn an_error_repeating_the_old_credential_of_a_refreshed_token_is_redacted() {
        let first = Guarded(Echo { chunks: vec![b"expired"], location: "", fail_with: None, content_type: "text/plain", status: 401 });
        let refused = first.send(request("https://example.test/v1", &[("authorization", "Bearer refreshed-oldcredential123")]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(refused).await, "expired");
        let resend = Guarded(Echo {
            chunks: vec![b"{\"error\":\"previous value refreshed-oldcredential123, current refreshed-newcredential456\"}"],
            location: "",
            fail_with: None,
            content_type: "application/json",
            status: 400,
        });
        let answered = resend.send(request("https://example.test/v1", &[("authorization", "Bearer refreshed-newcredential456")]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(answered).await, "{\"error\":\"previous value [REDACTED], current [REDACTED]\"}");
    }

    /// An exchange that carries no credential of its own repeats what an earlier request of the process carried (a pooled
    /// connection, a gateway), in the error of a transport failure as well.
    #[tokio::test]
    async fn an_error_repeating_the_credential_of_an_earlier_request_is_redacted() {
        let early = Guarded(Echo { chunks: vec![b"ok"], location: "", fail_with: None, content_type: "text/plain", status: 400 });
        early.send(request("https://example.test/v1?key=earlier%2Frequest-key-9d3b&alt=sse", &[]), TOKEN_EXCHANGE).await.expect("answered");
        let later = Guarded(Echo {
            chunks: vec![b"the key earlier/request-key-9d3b was refused"],
            location: "https://example.test/?k=earlier%2Frequest-key-9d3b",
            fail_with: None,
            content_type: "text/plain",
            status: 400,
        });
        let response = later.send(request("https://example.test/v2", &[]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(response.headers[0].1, "https://example.test/?k=[REDACTED]");
        assert_eq!(body_of(response).await, "the key [REDACTED] was refused");
        let failing = Guarded(Echo { chunks: Vec::new(), location: "", fail_with: Some("error sending request for url (https://example.test/v3?key=earlier/request-key-9d3b)"), content_type: "", status: 0 });
        let error = failing.send(request("https://example.test/v3", &[]), TOKEN_EXCHANGE).await.err().expect("failed");
        assert_eq!(error.message, "error sending request for url (https://example.test/v3?key=[REDACTED])");
    }

    /// Only a token grant arrives whole, and what the provider reading it keeps is a credential from then on: any other
    /// successful body (a JSON document its caller parses and hands on) that repeats a kept token, or a credential an earlier
    /// request carried, is redacted.
    #[tokio::test]
    async fn only_a_token_grant_arrives_whole_and_what_is_kept_of_it_is_a_credential() {
        let grant: &'static [u8] = br#"{"access_token":"granted-access-token-4e7f21","refresh_token":"granted-refresh-token-8a90c3","id_token":"granted-id-token-55b2d0"}"#;
        let link = Guarded(Echo { chunks: vec![grant], location: "", fail_with: None, content_type: "application/json", status: 200 });
        let refresh = WireRequest { body: b"grant_type=refresh_token&refresh_token=granted-refresh-token-8a90c3".to_vec(), ..request("https://example.test/token", &[]) };
        assert_eq!(body_of(link.send(refresh, TOKEN_EXCHANGE).await.expect("answered")).await.as_bytes(), grant);
        carried::keep("an account of the grant test", &["granted-access-token-4e7f21", "granted-id-token-55b2d0"]);
        // Cursor's exchange has no `grant_type`: the exchange is declared one.
        let exchange = Guarded(Echo { chunks: vec![br#"{"accessToken":"cursor-granted-access-6c1e","refreshToken":"cursor-granted-refresh-2f70"}"#], location: "", fail_with: None, content_type: "application/json", status: 200 });
        let body = body_of(exchange.send(request("https://example.test/auth/exchange", &[("authorization", "Bearer cursor-granted-refresh-2f70")]), crate::transport::deadlines::CURSOR_EXCHANGE).await.expect("answered")).await;
        assert!(body.contains("cursor-granted-refresh-2f70") && body.contains("cursor-granted-access-6c1e"), "{body}");
        // Later, an answer of no token request that repeats a kept token, or the one an earlier request carried.
        let document = Guarded(Echo {
            chunks: vec![br#"{"note":"granted-access-token-4e7f21 and cursor-granted-refresh-2f70 and granted-id-token-55b2d0"}"#],
            location: "",
            fail_with: None,
            content_type: "application/json",
            status: 200,
        });
        let answered = document.send(request("https://example.test/v1/models", &[]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(answered).await, r#"{"note":"[REDACTED] and [REDACTED] and [REDACTED]"}"#);
    }

    /// A static key attached once stays a credential however many tokens other accounts refresh after it (review 1124e
    /// P1: the registry dropped the oldest of 512 whatever it was).
    #[tokio::test]
    async fn a_static_key_outlives_any_number_of_refreshes_of_other_accounts() {
        let quiet = Guarded(Echo { chunks: vec![b"ok"], location: "", fail_with: None, content_type: "text/plain", status: 200 });
        body_of(quiet.send(request("https://static.example.test/v1", &[("x-api-key", "static-key-1123v")]), TOKEN_EXCHANGE).await.expect("answered")).await;
        for i in 0..600 {
            let bearer = format!("Bearer refreshed-token-of-another-account-{i:04}");
            body_of(quiet.send(request("https://other.example.test/v1", &[("authorization", &bearer)]), TOKEN_EXCHANGE).await.expect("answered")).await;
        }
        let echo = Guarded(Echo { chunks: vec![b"previous key static-key-1123v"], location: "", fail_with: None, content_type: "text/plain", status: 400 });
        let response = echo.send(request("https://static.example.test/v2", &[]), TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(response).await, "previous key [REDACTED]");
    }

    /// Request A streams; request B attaches its credential; A's response then echoes B's credential (review 1124e: a
    /// stream kept the matcher it began with).
    #[tokio::test]
    async fn a_stream_is_searched_for_a_credential_attached_after_it_began() {
        let a = Guarded(Echo {
            chunks: vec![b"data: first event\n\n", b"data: the other key midstream-key-of-b-41d7 leaked\n\n"],
            location: "",
            fail_with: None,
            content_type: "text/event-stream",
            status: 200,
        });
        let mut response = a.send(request("https://a.example.test/v1", &[("authorization", "Bearer stream-a-own-key-9e02")]), TOKEN_EXCHANGE).await.expect("answered");
        let first = response.body.next().await.expect("a first chunk").expect("no fault");
        assert_eq!(first.as_ref(), b"data: first event\n\n");
        let b = Guarded(Echo { chunks: vec![b"ok"], location: "", fail_with: None, content_type: "text/plain", status: 200 });
        body_of(b.send(request("https://b.example.test/v1", &[("authorization", "Bearer midstream-key-of-b-41d7")]), TOKEN_EXCHANGE).await.expect("answered")).await;
        let mut rest = Vec::new();
        while let Some(chunk) = response.body.next().await {
            rest.extend_from_slice(&chunk.expect("no fault"));
        }
        assert_eq!(String::from_utf8(rest).unwrap(), "data: the other key [REDACTED] leaked\n\n");
    }

    /// What `send` builds on the executor thread before the request goes out: the index entries of the forms of the one new
    /// credential it carries (a 1.2 KiB JWT: 28), however many the registry holds (here 2,000 JWT-sized ones more), within
    /// a stated bound of 50 ms on a debug build; the old version rebuilt the whole automaton there (3.4 s at 512 values).
    #[tokio::test]
    async fn a_send_builds_only_its_own_credentials_entries_on_the_executor_thread() {
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut part = |len: usize| -> String {
            const URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            (0..len)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    char::from(URL[(state % 64) as usize])
                })
                .collect()
        };
        for _ in 0..2000 {
            carried::keep("an account refreshed 2,000 times (the executor test)", &[&format!("eyJ{}.{}.{}", part(36), part(800), part(340))]);
        }
        let bearer = format!("Bearer eyJ{}.{}.{}", part(36), part(800), part(340));
        let quiet = Guarded(Echo { chunks: vec![b"ok"], location: "", fail_with: None, content_type: "text/plain", status: 200 });
        let before = carried::touched();
        let started = std::time::Instant::now();
        let response = quiet.send(request("https://executor.example.test/v1", &[("authorization", &bearer)]), TOKEN_EXCHANGE).await.expect("answered");
        let spent = started.elapsed();
        assert_eq!(carried::touched() - before, 28, "the forms of the one credential the request carries");
        assert!(spent < std::time::Duration::from_millis(50), "{spent:?}");
        assert_eq!(body_of(response).await, "ok");
    }

    /// A compressed refusal is decoded below the guard and redacted after: the real link, over TLS, with a gzip body.
    #[tokio::test]
    async fn a_compressed_refusal_is_redacted_after_it_is_decoded() {
        use std::io::Write as _;

        use crate::transport::loopback::Loopback;
        use crate::transport::loopback::Script;

        let loopback = Loopback::start(&["example.test"]).await;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(br#"{"error":"the credential gzip-guard-key/5e71 was refused"}"#).unwrap();
        let mut script = Script::default();
        script.http.push_back(serde_json::json!({
            "status": 401,
            "headers": { "content-type": "application/json", "content-encoding": "gzip" },
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(gzip.finish().unwrap()),
        }));
        loopback.begin(script);
        let link = crate::transport::link::ReqwestLink::pinned(&mixdog_core_api::domain::keepalive::KeepaliveSchedule::SPEC, loopback.addr, loopback.tls.clone());
        let sent = request("https://example.test/v1", &[("authorization", "Bearer gzip-guard-key/5e71")]);
        let response = link.send(sent, TOKEN_EXCHANGE).await.expect("answered");
        assert_eq!(body_of(response).await, r#"{"error":"the credential [REDACTED] was refused"}"#);
    }

    /// The modules a test-gated module declaration (`#[cfg(test)] mod x;`, `#[cfg(any(test, …))]`) brings in: their files and
    /// everything under their directories.
    fn test_gated(src: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut gated = Vec::new();
        let mut pending: Vec<std::path::PathBuf> = vec![src.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
                let base = if ["mod", "lib", "main"].contains(&stem.as_str()) { dir.clone() } else { dir.join(&stem) };
                let (mut test_only, mut path_attr) = (false, None::<String>);
                for line in text.lines().map(str::trim) {
                    // An attribute may follow another item on its line (`pub use x;#[cfg(test)]`).
                    if let Some(at) = line.find("#[cfg(")
                        && line.ends_with(")]")
                    {
                        test_only |= line[at..].contains("test");
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix("#[path = \"") {
                        path_attr = rest.strip_suffix("\"]").map(str::to_owned);
                        continue;
                    }
                    if line.starts_with("#[") {
                        continue;
                    }
                    let declared = line.trim_start_matches("pub(crate) ").trim_start_matches("pub(super) ").trim_start_matches("pub ");
                    if test_only && let Some(name) = declared.strip_prefix("mod ").and_then(|rest| rest.strip_suffix(';')) {
                        match &path_attr {
                            Some(file) => gated.push(dir.join(file)),
                            None => {
                                gated.push(base.join(format!("{name}.rs")));
                                gated.push(base.join(name));
                            }
                        }
                    }
                    test_only = false;
                    path_attr = None;
                }
            }
        }
        gated
    }

    /// No provider reaches the network but through the guard: outside tests, the transport seams are implemented by the
    /// guard and by the links that wrap themselves in it, and by the gateway's link, which adds headers before the link
    /// it wraps (one of these). A new implementation fails here until it is guarded and listed.
    #[test]
    fn every_seam_outside_tests_is_guarded() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let gated = test_gated(&src);
        let mut found = Vec::new();
        let mut pending = vec![src.clone()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if gated.iter().any(|gate| path.starts_with(gate)) {
                    continue;
                }
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                if text.lines().any(|line| line.trim() == "#![cfg(test)]") {
                    continue;
                }
                let file = path.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
                for line in text.lines().filter(|line| line.starts_with("impl")) {
                    if [" HttpSend for ", " BidiOpen for ", " WsDial for "].iter().any(|seam| line.contains(seam)) {
                        found.push(format!("{file}: {}", line.trim_end_matches(" {")));
                    }
                }
            }
        }
        found.sort();
        assert_eq!(
            found,
            [
                "registry/gateway.rs: impl HttpSend for GatewayHttp",
                "transport/guard.rs: impl<T: BidiOpen> BidiOpen for Guarded<T>",
                "transport/guard.rs: impl<T: HttpSend> HttpSend for Guarded<T>",
                "transport/guard.rs: impl<T: WsDial> WsDial for Guarded<T>",
                "transport/link.rs: impl BidiOpen for Bare<'_, ReqwestLink>",
                "transport/link.rs: impl BidiOpen for ReqwestLink",
                "transport/link.rs: impl HttpSend for Bare<'_, ReqwestLink>",
                "transport/link.rs: impl HttpSend for ReqwestLink",
                "transport/link.rs: impl WsDial for Bare<'_, KeepaliveDialer>",
                "transport/link.rs: impl WsDial for KeepaliveDialer",
            ]
        );
        // Each public link hands its exchange to the guard, and the unguarded one is private to its module.
        let link = std::fs::read_to_string(src.join("transport/link.rs")).unwrap();
        assert_eq!(link.matches("Guarded(Bare(self))").count(), 3);
        assert!(link.contains("\nstruct Bare<"));
    }
}
