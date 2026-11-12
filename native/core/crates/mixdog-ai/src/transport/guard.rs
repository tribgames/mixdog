//! The one place every provider exchange has its credentials redacted from what comes back.
//!
//! [`Guarded`] wraps a transport seam ([`HttpSend`], [`BidiOpen`], [`WsDial`]). It remembers what each request
//! carries ([`carried::note_request`]) and redacts it, in every form a server repeats it in, from the response's headers
//! (a `Location` that names the key in its query), from its body however the chunks cut it, from a WebSocket's
//! frames and its closing, and from the text of a failure (a transport error names its URL). Every error, refusal,
//! redirect, log line and event a provider builds is built from what passed through here, so none of them can hold a
//! credential the request carried.

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

/// A body redacted as it streams: a form cut by a chunk boundary is held until the chunk that finishes it, and only a
/// tail that is the beginning of a form waits at all.
struct RedactedBody {
    inner: Box<dyn BodyStream>,
    matcher: Arc<Matcher>,
    held: Vec<u8>,
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
                    self.held.extend_from_slice(&chunk);
                    let (out, from) = self.matcher.redact(&self.held, false);
                    self.held.drain(..from);
                    if !out.is_empty() {
                        return Some(Ok(Bytes::from(out)));
                    }
                }
                end => {
                    // The body is over (cleanly or by a fault): what was held is whole text now.
                    self.ended = true;
                    self.fault = end.and_then(Result::err);
                    let (out, _) = self.matcher.redact(&self.held, true);
                    self.held.clear();
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

fn clean_response(mut response: HttpResponse, matcher: &Arc<Matcher>) -> HttpResponse {
    if matcher.is_empty() {
        return response;
    }
    matcher.redact_headers(&mut response.headers);
    // A successful answer that is not an event stream is a document the caller reads for what it holds: a token grant
    // carries the credentials it issues, often the refresh token the request carried. Only a refusal, a redirect and a
    // stream (whose in-band error events repeat the key as a refusal does) are redacted.
    let event_stream = response.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
    if (response.is_success() && !event_stream) || framed_binary(&response.headers) {
        return response;
    }
    response.body = Box::new(RedactedBody { inner: response.body, matcher: matcher.clone(), held: Vec::new(), ended: false, fault: None });
    response
}

#[async_trait]
impl<T: HttpSend> HttpSend for Guarded<T> {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        carried::note_request(&request);
        let matcher = carried::matcher();
        match self.0.send(request, exchange).await {
            Ok(response) => Ok(clean_response(response, &matcher)),
            Err(error) => Err(matcher.redact_error(error)),
        }
    }
}

#[async_trait]
impl<T: BidiOpen> BidiOpen for Guarded<T> {
    async fn open(&self, request: WireRequest, first: Vec<u8>, exchange: Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        carried::note_request(&request);
        let matcher = carried::matcher();
        match self.0.open(request, first, exchange).await {
            Ok((response, sink)) => Ok((clean_response(response, &matcher), sink)),
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
        carried::note_upgrade(&request.uri().to_string(), &headers);
        let matcher = carried::matcher();
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
}
