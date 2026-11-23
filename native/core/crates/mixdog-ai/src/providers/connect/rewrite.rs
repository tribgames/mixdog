//! The HTTP adapter shared by the providers that speak another family's wire
//! through their own endpoint and credentials (`grok`, `local`, `custom`): a
//! request rewriter around an inner codec, and one attempt that adds the
//! credential header, sends once and decodes the answer with the inner codec.
//! A rejected credential gets one refreshed credential and one resend, which is
//! part of getting a request accepted; retrying is above the adapter.

use crate::providers::compat::adapter::shared_first_byte_gate;
use crate::providers::compat::adapter::stream_call;
use crate::providers::first_byte::FirstByteSettings;
use crate::transport::deadlines::MODEL_STREAM;
use crate::transport::model_driver::ModelDriver;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use super::stream::DecodedStream;
use crate::transport::http::HttpSend;

/// Edits the request an inner codec encoded: endpoint, headers, body.
pub trait Rewriter: Send + Sync {
    fn rewrite(&self, wire: WireRequest, request: &ModelRequest) -> Result<WireRequest, ProviderError>;
}

impl Rewriter for Arc<dyn Rewriter> {
    fn rewrite(&self, wire: WireRequest, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        (**self).rewrite(wire, request)
    }
}

/// An inner codec whose requests pass through a [`Rewriter`]; decoding and
/// classification are the inner codec's.
pub struct RewriteCodec<R: Rewriter> {
    inner: Arc<dyn WireCodec>,
    rewriter: R,
}

impl<R: Rewriter> RewriteCodec<R> {
    pub fn new(inner: Arc<dyn WireCodec>, rewriter: R) -> Self {
        Self { inner, rewriter }
    }
}

impl<R: Rewriter> WireCodec for RewriteCodec<R> {
    fn transport(&self) -> TransportKind {
        self.inner.transport()
    }
    /// A rewriter changes headers and the body's envelope, never the wire: the images travel the inner codec's branch.
    fn image_branch(&self, request: &ModelRequest) -> mixdog_image_egress::route::WireBranch {
        self.inner.image_branch(request)
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        self.rewriter.rewrite(self.inner.encode(request)?, request)
    }

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        self.inner.decoder(request)
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        self.inner.classify(response)
    }
}

/// What one request is sent on: its credential header, if the endpoint wants one, and what the credential that served
/// it tells the login behind it by. A refusal hands the whole attempt back, so the credential acts on that login and on
/// no other.
#[derive(Clone)]
pub struct Attempt {
    pub header: Option<(String, String)>,
    /// The credential's own; nothing else reads it.
    login: Option<Arc<dyn std::any::Any + Send + Sync>>,
}

impl Attempt {
    /// A header with no login behind it (a key, or none).
    pub fn plain(header: Option<(String, String)>) -> Self {
        Self { header, login: None }
    }

    /// A header served under `login`, which [`Self::login`] gives back to the credential.
    pub fn served_under(header: Option<(String, String)>, login: impl std::any::Any + Send + Sync) -> Self {
        Self { header, login: Some(Arc::new(login)) }
    }

    pub fn login<T: std::any::Any>(&self) -> Option<&T> {
        self.login.as_ref()?.downcast_ref()
    }
}

/// What a credential answers a refusal with: the attempt the request is sent again on, and what was done to get it.
pub struct Recovered {
    pub attempt: Attempt,
    /// Whether the refused attempt's own login was renewed for this answer (its key read again, its token exchanged).
    /// False when another login, stored since, is returned as it is: nothing was tried for that one yet.
    pub exchanged: bool,
}

/// The credential of a request.
#[async_trait]
pub trait Credential: Send + Sync {
    /// What a request is sent on now.
    async fn attempt(&self) -> Result<Attempt, ProviderError>;

    /// The server refused `rejected`: the key is read again, or the token refreshed, of the login that attempt was served
    /// under and of no other. A login stored since is returned as it is. A credential that cannot change answers as
    /// [`Self::attempt`] does.
    async fn after_rejection(&self, _rejected: &Attempt) -> Result<Recovered, ProviderError> {
        Ok(Recovered { attempt: self.attempt().await?, exchanged: false })
    }

    /// The header alone, for a request that is not sent again when refused.
    async fn header(&self) -> Result<Option<(String, String)>, ProviderError> {
        Ok(self.attempt().await?.header)
    }

    /// Puts the credential header among the request's headers: after them all, unless the client the wire stands in for
    /// writes it elsewhere.
    fn place(&self, headers: &mut Vec<(String, String)>, header: (String, String)) {
        headers.push(header);
    }

    /// Whether a forced refresh can produce a different credential.
    fn refreshable(&self) -> bool {
        false
    }

    /// Whether a refusal (its status and body) is answered with a forced refresh and one resend: a 401, when the
    /// credential can refresh.
    fn refreshes_on(&self, status: u16, _body: &[u8]) -> bool {
        status == 401 && self.refreshable()
    }

    /// Whether the resend after a refresh needs a credential other than the refused one.
    fn resend_needs_new(&self) -> bool {
        true
    }

    /// Marks the error of a resend refused again after the refused login was renewed for it ([`Recovered::exchanged`]).
    fn refused_again(&self, _status: u16, _error: &mut ProviderError) {}

    /// The account `header` (a header this credential produced) signs in as, when the credential names one.
    fn account_of(&self, _header: &(String, String)) -> Option<String> {
        None
    }
}

/// One credential header that never changes (or none: a keyless endpoint).
pub struct StaticCredential(pub Option<(String, String)>);

#[async_trait]
impl Credential for StaticCredential {
    async fn attempt(&self) -> Result<Attempt, ProviderError> {
        Ok(Attempt::plain(self.0.clone()))
    }
}

/// A refusal the provider answers by sending the request once more at once, encoded anew (Grok's client-version gate,
/// `grok-oauth.mjs` `send`): true when the refused attempt's error is one.
pub type Resend = Arc<dyn Fn(&ProviderError) -> bool + Send + Sync>;

/// One attempt of `codec` (an OpenAI-compatible wire: Chat Completions or Responses) through `driver` with `credential`:
/// a rejected credential is refreshed and the request sent again, or a refusal `resend` names is sent again at once;
/// either once, and never both. Every send is an attempt of the driver under the stream windows of the wire
/// ([`crate::providers::compat::adapter::stream_call`], labelled `label`, read from `settings`).
pub async fn run_attempt(
    codec: &dyn WireCodec,
    driver: &ModelDriver,
    credential: &dyn Credential,
    request: &ModelRequest,
    resend: Option<&Resend>,
    label: &str,
    settings: &FirstByteSettings,
) -> Result<Box<dyn ModelStream>, ProviderError> {
    // The credential first: a rewriter may read identity it loads.
    let mut attempt = credential.attempt().await?;
    let mut wire = codec.encode(request)?;
    let mut again = false;
    let mut refreshed = false;
    // `requesting`: Chat Completions raises it for every attempt of its ladder (openai-compat-chat-send.mjs:276), the
    // Messages wire (anthropic.mjs:300) and Responses (grok-oauth.mjs, openai-compat-xai-send.mjs:103) once before it.
    if wire.url.ends_with("/chat/completions") {
        request.options.send_identity.raise_stage("requesting");
    } else {
        request.options.send_identity.raise_requesting_once();
    }
    loop {
        let mut sent = wire.clone();
        if let Some(header) = attempt.header.clone() {
            credential.place(&mut sent.headers, header);
        }
        let identity = &request.options.send_identity;
        let call = stream_call(label.to_owned(), settings, identity, Some(shared_first_byte_gate(settings, identity, label.to_owned())), false);
        let (head, handle) = driver.send(&call, sent, MODEL_STREAM).await?;
        if head.is_success() {
            // `onStreamDelta('transport')` as the stream opens (`reportTransport`, openai-compat-chat-stream.mjs:75).
            identity.raise_transport();
            return Ok(Box::new(DecodedStream::new(head.body, codec.decoder(request)).driven(handle, identity.clone())));
        }
        let status = head.status;
        let rejected = head.read_all().await?;
        if again {
            let mut error = codec.classify(&rejected);
            if refreshed {
                credential.refused_again(status, &mut error);
            }
            return Err(error);
        }
        if !crate::providers::compat::login::opencode_go::gateway_owns_auth_recovery() && credential.refreshes_on(status, &rejected.body) {
            again = true;
            // The refusal is of the attempt this request was sent on, whatever login the credential holds by now.
            let next = credential.after_rejection(&attempt).await?;
            // A login stored since goes out untried: its refusal is its first, not a refresh that did not help.
            refreshed = next.exchanged;
            // The same rejected credential is not sent again, unless the provider resends whatever the refresh gave.
            if next.attempt.header != attempt.header || !credential.resend_needs_new() {
                attempt = next.attempt;
                continue;
            }
            return Err(codec.classify(&rejected));
        }
        let error = codec.classify(&rejected);
        if resend.is_some_and(|resend| resend(&error)) {
            again = true;
            // Node's gate calls `send` again: the resend is a request with an id of its own.
            request.options.send_identity.remint();
            wire = codec.encode(request)?;
            continue;
        }
        return Err(error);
    }
}

/// A [`ProviderAdapter`] over a fixed codec, transport and credential.
pub struct HttpAdapter {
    id: ProviderId,
    codec: Arc<dyn WireCodec>,
    /// The transport of every model exchange: its phase deadlines are the driver's.
    driver: ModelDriver,
    credential: Arc<dyn Credential>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    listing: Option<Arc<dyn ModelListing>>,
    resend: Option<Resend>,
    retry_line: Option<mixdog_core_api::domain::provider::RetryLine>,
    /// The stream windows, from the environment as Node reads it.
    first_byte: FirstByteSettings,
}

impl HttpAdapter {
    pub fn new(id: ProviderId, codec: Arc<dyn WireCodec>, http: Arc<dyn HttpSend>, credential: Arc<dyn Credential>, policy: RetryPolicy) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id,
            codec,
            driver: ModelDriver::new(http),
            credential,
            policy,
            keepalive: KeepaliveSchedule::SPEC,
            listing: None,
            resend: None,
            retry_line: None,
            first_byte: FirstByteSettings::process(),
        }
    }

    /// The stream windows of this adapter, when they are not the process environment's.
    pub fn with_first_byte(mut self, settings: FirstByteSettings) -> Self {
        self.first_byte = settings;
        self
    }

    /// The line the provider's ladder writes before each retry ([`ProviderAdapter::retry_line`]).
    pub fn with_retry_line(mut self, line: mixdog_core_api::domain::provider::RetryLine) -> Self {
        self.retry_line = Some(line);
        self
    }

    /// The refusals the provider sends again at once ([`Resend`]).
    pub fn with_resend(mut self, resend: Resend) -> Self {
        self.resend = Some(resend);
        self
    }

    /// The provider's model listing, served through [`ProviderAdapter::models`].
    pub fn with_listing(mut self, listing: Arc<dyn ModelListing>) -> Self {
        self.listing = Some(listing);
        self
    }
}

#[async_trait]
impl ProviderAdapter for HttpAdapter {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        self.codec.as_ref()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    fn retry_line(&self, _model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.retry_line.clone()
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        run_attempt(self.codec.as_ref(), &self.driver, self.credential.as_ref(), &request, self.resend.as_ref(), self.id.as_str(), &self.first_byte).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_deref()
    }

    /// Grok, the local runtime and a custom provider's Chat and Responses engines (`provider.nativePdf = false`).
    fn native_pdf(&self) -> bool {
        false
    }
}

/// A model endpoint on the test's clock, and the stall checks every lane that streams through the driver passes.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::Boundary;
    use mixdog_core_api::domain::provider::ModelRequest;
    use mixdog_core_api::domain::provider::ProviderAdapter;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::SendIdentity;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::TransportFault;
    use mixdog_core_api::domain::provider::WireRequest;
    use mixdog_core_api::domain::retry::JitterSamples;
    use mixdog_core_api::domain::retry::RetryClass;
    use mixdog_core_api::domain::retry::RetryDecider;
    use mixdog_core_api::domain::retry::RetryState;
    use mixdog_core_api::domain::retry::Verdict;
    use tokio::time::Instant;

    use crate::transport::link::BodyStream;
    use crate::transport::link::Exchange;
    use crate::transport::link::HttpResponse;
    use crate::transport::link::HttpSend;

    /// `(wait in seconds, chunk)` in order; after the last one the body stays silent and open.
    pub(crate) type Chunks = Vec<(u64, Vec<u8>)>;

    struct Timed(VecDeque<(u64, Vec<u8>)>);

    #[async_trait]
    impl BodyStream for Timed {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            let Some((wait, _)) = self.0.front() else { return std::future::pending().await };
            mixdog_rt::time::sleep(Duration::from_secs(*wait)).await;
            self.0.pop_front().map(|(_, chunk)| Ok(Bytes::from(chunk)))
        }
    }

    struct Whole(Option<Vec<u8>>);

    #[async_trait]
    impl BodyStream for Whole {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(|body| Ok(Bytes::from(body)))
        }
    }

    type Unary = Box<dyn Fn(&WireRequest) -> Option<(u16, Vec<u8>)> + Send + Sync>;

    /// Answers a request `unary` names at once and whole; every other request is a stream: its head at once, its body the
    /// next of `streams` on its timetable (silent when none is left).
    pub(crate) struct Paced {
        pub(crate) streamed: Mutex<Vec<WireRequest>>,
        streams: Mutex<VecDeque<Chunks>>,
        unary: Unary,
    }

    impl Paced {
        pub(crate) fn new(streams: Vec<Chunks>) -> Arc<Self> {
            Self::with_unary(streams, |_| None)
        }

        pub(crate) fn with_unary(streams: Vec<Chunks>, unary: impl Fn(&WireRequest) -> Option<(u16, Vec<u8>)> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(Self { streamed: Mutex::new(Vec::new()), streams: Mutex::new(streams.into()), unary: Box::new(unary) })
        }
    }

    #[async_trait]
    impl HttpSend for Paced {
        async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            if let Some((status, body)) = (self.unary)(&request) {
                return Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Whole(Some(body))) });
            }
            self.streamed.lock().unwrap().push(request);
            let chunks = self.streams.lock().unwrap().pop_front().unwrap_or_default();
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Timed(chunks.into())) })
        }
    }

    /// What a wire's stall checks expect: a record that carries no output and one that does, the code and window (seconds)
    /// of a stream silent before its first byte and of one silent after its first record, and whether the lane's ladder
    /// retries them.
    pub(crate) struct WireStalls {
        pub(crate) opening: Vec<u8>,
        pub(crate) output: Vec<u8>,
        pub(crate) first_byte: (&'static str, u64),
        pub(crate) mid_body: (&'static str, u64),
        pub(crate) retried: bool,
    }

    fn sse(record: &serde_json::Value) -> Vec<u8> {
        format!("data: {record}\n\n").into_bytes()
    }

    /// `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS` in seconds: the window after an OpenAI-compatible stream's first record.
    fn first_output_secs() -> u64 {
        crate::providers::first_byte::FirstByteSettings::default().first_output_ms.expect("the stream watchdog is on by default") as u64 / 1000
    }

    /// Chat Completions: `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (60 s), then `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS` for the first output.
    pub(crate) fn chat() -> WireStalls {
        WireStalls {
            opening: sse(&serde_json::json!({ "choices": [{ "index": 0, "delta": { "role": "assistant" } }] })),
            output: sse(&serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": "hi" } }] })),
            first_byte: ("EPROVIDERTIMEOUT", 60),
            mid_body: ("ESTREAMSTALL", first_output_secs()),
            retried: true,
        }
    }

    /// Responses: the same windows as Chat Completions.
    pub(crate) fn responses() -> WireStalls {
        WireStalls {
            opening: sse(&serde_json::json!({ "type": "response.created", "response": { "id": "resp_1", "model": "m" } })),
            output: sse(&serde_json::json!({ "type": "response.output_text.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "hi" })),
            ..chat()
        }
    }

    /// Messages: no `message_start` within `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (60 s), and `PROVIDER_SSE_IDLE_TIMEOUT_MS` (120 s)
    /// of byte silence once it came.
    pub(crate) fn messages() -> WireStalls {
        WireStalls {
            opening: concat!(
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
            )
            .as_bytes()
            .to_vec(),
            output: concat!(
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
            )
            .as_bytes()
            .to_vec(),
            first_byte: ("EEMPTYSTREAM", 60),
            mid_body: ("ESTREAMSTALL", 120),
            retried: true,
        }
    }

    fn fresh(request: &ModelRequest) -> ModelRequest {
        let mut request = request.clone();
        request.options.send_identity = SendIdentity::default();
        request
    }

    /// The failure one send of `request` ends in, and the seconds of the test's clock it took.
    async fn failure(adapter: &dyn ProviderAdapter, request: &ModelRequest) -> (ProviderError, u64) {
        let began = Instant::now();
        let failure = match adapter.attempt(Arc::new(fresh(request))).await {
            Err(failure) => failure,
            Ok(mut stream) => loop {
                match stream.next().await.expect("a failure ends the silent stream") {
                    Ok(_) => {}
                    Err(failure) => break failure,
                }
            },
        };
        (failure, began.elapsed().as_secs())
    }

    fn assert_retried(adapter: &dyn ProviderAdapter, request: &ModelRequest, failure: &ProviderError, retried: bool) {
        let decision = crate::retry::StandardRetryDecider.verdict(
            failure,
            &RetryState::new(RetryClass::Midstream, request.model.clone()),
            adapter.retry_policy_for(&request.model),
            JitterSamples { step: 0.5, advice: 0.5 },
        );
        assert_eq!(matches!(decision.verdict, Verdict::Retry { .. }), retried, "the lane's ladder on {}", failure.message);
    }

    /// The three checks of a lane, on the test's clock: `build` makes the lane's adapter over an endpoint that streams the
    /// given bodies, and `request` is a turn it serves. A stream silent before its first byte and one silent after its first
    /// record each end as the wire's stall after its window, which the lane's ladder retries (a stall after shown output is
    /// the loop's to withdraw first); a healthy stream that takes its time reports transport, and the attempt's phases,
    /// before its first output.
    pub(crate) async fn assert_stalls(build: impl Fn(Vec<Chunks>) -> Arc<dyn ProviderAdapter>, request: &ModelRequest, wire: &WireStalls) {
        let adapter = build(vec![Vec::new()]);
        let (silent, waited) = failure(adapter.as_ref(), request).await;
        assert_eq!((silent.code.as_deref(), waited), (Some(wire.first_byte.0), wire.first_byte.1), "{}", silent.message);
        assert!(silent.timed_out, "{}", silent.message);
        assert_retried(adapter.as_ref(), request, &silent, wire.retried);

        let adapter = build(vec![vec![(0, wire.opening.clone())]]);
        let (stalled, waited) = failure(adapter.as_ref(), request).await;
        assert_eq!((stalled.code.as_deref(), waited), (Some(wire.mid_body.0), wire.mid_body.1), "{}", stalled.message);
        assert!(stalled.timed_out, "{}", stalled.message);
        assert_retried(adapter.as_ref(), request, &stalled, wire.retried);

        let adapter = build(vec![vec![(0, wire.opening.clone()), (50, wire.output.clone())]]);
        let request = fresh(request);
        let identity = request.options.send_identity.clone();
        let read = async {
            let mut stream = adapter.attempt(Arc::new(request)).await.expect("the stream opens");
            while !matches!(stream.next().await.expect("the output comes").expect("a healthy stream"), StreamEvent::TextDelta(_)) {}
        };
        let watch = async {
            mixdog_rt::time::sleep(Duration::from_secs(10)).await;
            (identity.take_transport(), identity.take_published())
        };
        let ((), (transport, published)) = tokio::join!(read, watch);
        assert!(transport, "transport is reported before the first output");
        let boundaries: Vec<Boundary> = published.into_iter().map(|(_, _, boundary)| boundary).collect();
        assert!(boundaries.contains(&Boundary::AttemptStarted) && boundaries.contains(&Boundary::HeadReceived), "{boundaries:?}");
        assert!(!boundaries.contains(&Boundary::FirstSemanticOutput), "{boundaries:?}");
    }
}
