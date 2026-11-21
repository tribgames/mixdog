//! The HTTP adapter shared by the providers that speak another family's wire
//! through their own endpoint and credentials (`grok`, `local`, `custom`): a
//! request rewriter around an inner codec, and one attempt that adds the
//! credential header, sends once and decodes the answer with the inner codec.
//! A rejected credential gets one refreshed credential and one resend, which is
//! part of getting a request accepted; retrying is above the adapter.

use crate::transport::deadlines::MODEL_STREAM;
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

/// One attempt of `codec` against `http` with `credential`: a rejected credential is refreshed and the request sent
/// again, or a refusal `resend` names is sent again at once; either once, and never both.
pub async fn run_attempt(
    codec: &dyn WireCodec,
    http: &dyn HttpSend,
    credential: &dyn Credential,
    request: &ModelRequest,
    resend: Option<&Resend>,
) -> Result<Box<dyn ModelStream>, ProviderError> {
    run_fitted_attempt(codec, http, credential, request, resend, None).await
}

async fn encode_fitted(
    codec: &dyn WireCodec,
    request: &ModelRequest,
    images: Option<&crate::providers::anthropic::images::ImageFitter>,
) -> Result<WireRequest, ProviderError> {
    let wire = codec.encode(request)?;
    match images {
        Some(fitter) => fitter.fit_wire(request, wire).await,
        None => Ok(wire),
    }
}

/// [`run_attempt`] for a Messages engine: each encoding of the request has its images fitted
/// ([`crate::providers::anthropic::images::ImageFitter::fit_wire`]) before it is sent.
pub async fn run_fitted_attempt(
    codec: &dyn WireCodec,
    http: &dyn HttpSend,
    credential: &dyn Credential,
    request: &ModelRequest,
    resend: Option<&Resend>,
    images: Option<&crate::providers::anthropic::images::ImageFitter>,
) -> Result<Box<dyn ModelStream>, ProviderError> {
    // The credential first: a rewriter may read identity it loads.
    let mut attempt = credential.attempt().await?;
    let mut wire = encode_fitted(codec, request, images).await?;
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
        let head = http.send(sent, MODEL_STREAM).await?;
        if head.is_success() {
            return Ok(Box::new(DecodedStream::new(head.body, codec.decoder(request))));
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
            wire = encode_fitted(codec, request, images).await?;
            continue;
        }
        return Err(error);
    }
}

/// A [`ProviderAdapter`] over a fixed codec, transport and credential.
pub struct HttpAdapter {
    id: ProviderId,
    codec: Arc<dyn WireCodec>,
    http: Arc<dyn HttpSend>,
    credential: Arc<dyn Credential>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    listing: Option<Arc<dyn ModelListing>>,
    resend: Option<Resend>,
    retry_line: Option<mixdog_core_api::domain::provider::RetryLine>,
    input_excludes_cache: Option<bool>,
    /// What the engine takes as a document when it is not the plain `nativePdf = false` of Grok, the local
    /// runtime and a custom provider's engines (a gateway's Messages engine declares its own).
    media: Option<mixdog_core_api::domain::provider::MediaSupport>,
    /// A Messages engine's image resizer ([`crate::providers::anthropic::images`]).
    images: Option<crate::providers::anthropic::images::ImageFitter>,
}

impl HttpAdapter {
    pub fn new(id: ProviderId, codec: Arc<dyn WireCodec>, http: Arc<dyn HttpSend>, credential: Arc<dyn Credential>, policy: RetryPolicy) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id,
            codec,
            http,
            credential,
            policy,
            keepalive: KeepaliveSchedule::SPEC,
            listing: None,
            resend: None,
            retry_line: None,
            input_excludes_cache: None,
            media: None,
            images: None,
        }
    }

    /// The line the provider's ladder writes before each retry ([`ProviderAdapter::retry_line`]).
    pub fn with_retry_line(mut self, line: mixdog_core_api::domain::provider::RetryLine) -> Self {
        self.retry_line = Some(line);
        self
    }

    /// The usage convention of an adapter whose class states it apart from its name ([`ProviderAdapter::input_excludes_cache`]).
    pub fn with_input_excludes_cache(mut self, excludes: bool) -> Self {
        self.input_excludes_cache = Some(excludes);
        self
    }

    /// Fits the images of every request with `fitter`: the Messages wire's `prepareAnthropicImages`.
    pub fn with_images(mut self, fitter: Option<crate::providers::anthropic::images::ImageFitter>) -> Self {
        self.images = fitter;
        self
    }

    /// The engine's own document capabilities (`GatewayMessagesEngine.nativePdf` / `.nativeDocuments`).
    pub fn with_media(mut self, media: mixdog_core_api::domain::provider::MediaSupport) -> Self {
        self.media = Some(media);
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
        run_fitted_attempt(self.codec.as_ref(), self.http.as_ref(), self.credential.as_ref(), &request, self.resend.as_ref(), self.images.as_ref()).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_deref()
    }

    fn input_excludes_cache(&self) -> Option<bool> {
        self.input_excludes_cache
    }

    /// Grok, the local runtime and a custom provider's engines (`provider.nativePdf = false`).
    fn native_pdf(&self) -> bool {
        self.media.is_some_and(|m| m.native_pdf)
    }

    fn native_documents(&self) -> Option<bool> {
        self.media.and_then(|m| m.native_documents)
    }
}
