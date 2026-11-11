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

use crate::transport::http::HttpSend;
use super::stream::DecodedStream;

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

/// The credential header of a request, if the endpoint wants one.
#[async_trait]
pub trait Credential: Send + Sync {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError>;

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

    /// Marks the error of a resend refused again after a refresh.
    fn refused_again(&self, _status: u16, _error: &mut ProviderError) {}
}

/// One credential header that never changes (or none: a keyless endpoint).
pub struct StaticCredential(pub Option<(String, String)>);

#[async_trait]
impl Credential for StaticCredential {
    async fn header(&self, _force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        Ok(self.0.clone())
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
    // The credential first: a rewriter may read identity it loads.
    let mut header = credential.header(false).await?;
    let mut wire = codec.encode(request)?;
    let mut again = false;
    let mut refreshed = false;
    loop {
        let mut sent = wire.clone();
        if let Some(header) = header.clone() {
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
        if credential.refreshes_on(status, &rejected.body) {
            again = true;
            refreshed = true;
            let next = credential.header(true).await?;
            // The same rejected credential is not sent again, unless the provider resends whatever the refresh gave.
            if next != header || !credential.resend_needs_new() {
                header = next;
                continue;
            }
            return Err(codec.classify(&rejected));
        }
        let error = codec.classify(&rejected);
        if resend.is_some_and(|resend| resend(&error)) {
            again = true;
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
    http: Arc<dyn HttpSend>,
    credential: Arc<dyn Credential>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    listing: Option<Arc<dyn ModelListing>>,
    resend: Option<Resend>,
}

impl HttpAdapter {
    pub fn new(
        id: ProviderId,
        codec: Arc<dyn WireCodec>,
        http: Arc<dyn HttpSend>,
        credential: Arc<dyn Credential>,
        policy: RetryPolicy,
    ) -> Self {
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
        }
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

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        run_attempt(self.codec.as_ref(), self.http.as_ref(), self.credential.as_ref(), &request, self.resend.as_ref()).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_deref()
    }

    /// Grok, the local runtime and a custom provider's engines (`provider.nativePdf = false`).
    fn native_pdf(&self) -> bool {
        false
    }
}
