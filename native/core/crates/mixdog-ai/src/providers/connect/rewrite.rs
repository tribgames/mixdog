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

    /// Whether a forced refresh can produce a different credential.
    fn refreshable(&self) -> bool {
        false
    }
}

/// One credential header that never changes (or none: a keyless endpoint).
pub struct StaticCredential(pub Option<(String, String)>);

#[async_trait]
impl Credential for StaticCredential {
    async fn header(&self, _force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        Ok(self.0.clone())
    }
}

/// One attempt of `codec` against `http` with `credential`.
pub async fn run_attempt(
    codec: &dyn WireCodec,
    http: &dyn HttpSend,
    credential: &dyn Credential,
    request: &ModelRequest,
) -> Result<Box<dyn ModelStream>, ProviderError> {
    // The credential first: a rewriter may read identity it loads.
    let mut header = credential.header(false).await?;
    let wire = codec.encode(request)?;
    let mut refreshed = false;
    loop {
        let mut sent = wire.clone();
        sent.headers.extend(header.clone());
        let head = http.send(sent, MODEL_STREAM).await?;
        if head.status == 401 && credential.refreshable() && !refreshed {
            refreshed = true;
            let next = credential.header(true).await?;
            // The same rejected credential is not sent again.
            if next != header {
                header = next;
                continue;
            }
        }
        if !head.is_success() {
            let rejected = head.read_all().await?;
            return Err(codec.classify(&rejected));
        }
        return Ok(Box::new(DecodedStream::new(head.body, codec.decoder(request))));
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
        }
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
        run_attempt(self.codec.as_ref(), self.http.as_ref(), self.credential.as_ref(), &request).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_deref()
    }

    /// Grok, the local runtime and a custom provider's engines (`provider.nativePdf = false`).
    fn native_pdf(&self) -> bool {
        false
    }
}
