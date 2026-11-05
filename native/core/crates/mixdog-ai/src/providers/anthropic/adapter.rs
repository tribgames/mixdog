//! `ProviderAdapter` of `anthropic` and `anthropic-oauth`: exactly one request
//! attempt. The only replays inside an attempt are the two credential/encoding
//! recoveries of the initial response, both decided on the status alone before
//! a stream exists: one credential refresh after a 401/403, and one uncompressed
//! resend after a 400/415 on a gzip body. A body is compressed exactly when
//! Node compresses it (official messages URL, at least 8 KiB),
//! waiting for lane room rather than ever skipping it.
//!
//! The HTTP exchange is the shared [`HttpSend`] seam of `transport::http`.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;

use async_trait::async_trait;
use flate2::Compression;
use flate2::write::GzEncoder;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use tokio_util::sync::CancellationToken;

use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

use super::codec::AnthropicCodec;
use super::codec::AnthropicConfig;
use super::codec::Flavor;
use super::oauth::OAuthSession;
use super::policy::retry_policy;

/// The compression job could not run to completion; nothing was sent.
fn gzip_failure(cause: &dyn std::fmt::Display) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    err.message = format!("request compression failed: {cause}");
    err
}

/// Request bodies at least this large are sent gzip-encoded.
const GZIP_MIN_BYTES: usize = 8 * 1024;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

pub use crate::providers::key_source::ApiKeySource;

pub enum Credentials {
    ApiKey(Arc<dyn ApiKeySource>),
    OAuth(Arc<OAuthSession>),
}

/// The secret one request carries.
#[derive(Clone)]
struct Secret(String);

impl Credentials {
    async fn current(&self) -> Result<Secret, ProviderError> {
        match self {
            Self::ApiKey(source) => source.key().await.map(Secret),
            Self::OAuth(session) => session.access_token().await.map(Secret),
        }
    }

    /// The secret to replay with after the server rejected `rejected`, if
    /// there is a different one.
    async fn after_rejection(&self, rejected: &Secret) -> Result<Option<Secret>, ProviderError> {
        match self {
            Self::ApiKey(source) => {
                let key = source.reload().await?;
                Ok((key != rejected.0).then_some(Secret(key)))
            }
            Self::OAuth(session) => session.token_after_rejection(&rejected.0).await.map(|t| Some(Secret(t))),
        }
    }

    fn header(&self, secret: &Secret) -> (String, String) {
        match self {
            Self::ApiKey(_) => ("x-api-key".to_owned(), secret.0.clone()),
            Self::OAuth(_) => ("authorization".to_owned(), format!("Bearer {}", secret.0)),
        }
    }

    /// Whether this status is one a credential refresh can fix. A 403 on the
    /// subscription wire gets one refresh too: the grant may have been revoked.
    fn refreshable(&self, status: Option<u16>) -> bool {
        match self {
            Self::ApiKey(_) => status == Some(401),
            Self::OAuth(_) => matches!(status, Some(401 | 403)),
        }
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct AnthropicAdapter {
    id: ProviderId,
    codec: AnthropicCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    credentials: Credentials,
    gzip_lane: CpuBulk,
}

impl AnthropicAdapter {
    pub fn api_key(
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        keys: Arc<dyn ApiKeySource>,
        gzip_lane: CpuBulk,
    ) -> Self {
        Self::new(Flavor::ApiKey, config, http, Credentials::ApiKey(keys), true, gzip_lane)
    }

    /// `enterprise`: a pay-as-you-go subscription whose 429 is retried like an
    /// API key's; every other subscription surfaces a 429 at once.
    pub fn oauth(
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        session: Arc<OAuthSession>,
        enterprise: bool,
        gzip_lane: CpuBulk,
    ) -> Self {
        Self::new(Flavor::OAuth, config, http, Credentials::OAuth(session), enterprise, gzip_lane)
    }

    fn new(
        flavor: Flavor,
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        credentials: Credentials,
        retry_429: bool,
        gzip_lane: CpuBulk,
    ) -> Self {
        Self {
            id: ProviderId::from(flavor.provider_name()),
            codec: AnthropicCodec::new(flavor, config),
            policy: retry_policy(retry_429),
            keepalive: KeepaliveSchedule::SPEC,
            http,
            credentials,
            gzip_lane,
        }
    }

    fn request_with(&self, wire: &WireRequest, secret: &Secret) -> WireRequest {
        let mut request = wire.clone();
        request.headers.push(self.credentials.header(secret));
        request
    }

    /// Compression is a bulk-CPU lane job and never skipped for load: this
    /// waits for lane room. Dropping the attempt cancels the wait, or the
    /// queued job, so a cancelled request compresses nothing.
    async fn gzip(&self, body: &[u8]) -> Result<Vec<u8>, ProviderError> {
        let raw = body.to_vec();
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let job = self
            .gzip_lane
            .submit_wait(&cancel, move |_| {
                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(&raw)?;
                encoder.finish()
            })
            .await
            .map_err(|e| gzip_failure(&e))?;
        job.await
            .map_err(|e| gzip_failure(&e))?
            .map_err(|e| gzip_failure(&e))
    }

    /// One POST. Node gzips exactly the official-URL bodies of at least
    /// `GZIP_MIN_BYTES`; a rejected gzip body is the provider's error, never
    /// resent plain.
    async fn post(&self, wire: &WireRequest, secret: &Secret) -> Result<HttpResponse, ProviderError> {
        let mut request = self.request_with(wire, secret);
        if self.codec.config().is_official_messages_url() && wire.body.len() >= GZIP_MIN_BYTES {
            request.body = self.gzip(&wire.body).await?;
            request.headers.push(("content-encoding".to_owned(), "gzip".to_owned()));
        }
        self.http.send(request).await
    }

    async fn failure(&self, response: HttpResponse) -> ProviderError {
        match response.read_all().await {
            Ok(rejected) => self.codec.classify(&rejected),
            Err(err) => err,
        }
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let wire = self.codec.encode(&request)?;
        let mut secret = self.credentials.current().await?;
        let mut refreshed = false;
        loop {
            let response = self.post(&wire, &secret).await?;
            if (200..300).contains(&response.status) {
                return Ok(Box::new(AnthropicStream::new(response.body, self.codec.decoder(&request))));
            }
            let mut err = self.failure(response).await;
            if !refreshed && self.credentials.refreshable(err.status) {
                refreshed = true;
                if let Some(next) = self.credentials.after_rejection(&secret).await? {
                    secret = next;
                    continue;
                }
            }
            if refreshed && err.status == Some(401) && err.kind == ErrorKind::Auth {
                // The grant was refreshed and is still refused.
                err.reauth_required = true;
            }
            return Err(err);
        }
    }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

struct AnthropicStream {
    body: Option<Box<dyn BodyStream>>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// The last usage report handed to the consumer, carried by a later error.
    last_usage: Option<Usage>,
}

impl AnthropicStream {
    fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self {
            body: Some(body),
            decoder,
            queue: VecDeque::new(),
            failed: None,
            last_usage: None,
        }
    }

    fn enqueue(&mut self, events: Vec<StreamEvent>) {
        for event in &events {
            if let StreamEvent::Usage(usage) = event {
                self.last_usage = Some(usage.clone());
            }
        }
        self.queue.extend(events);
    }

    fn fail(&mut self, mut err: ProviderError) {
        self.body = None;
        err.partial_usage = self.last_usage.clone().map(Box::new);
        self.failed = Some(err);
    }
}

#[async_trait]
impl ModelStream for AnthropicStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            if let Some(err) = self.failed.take() {
                return Some(Err(err));
            }
            let body = self.body.as_mut()?;
            // The terminal event ends the attempt; whatever else the body
            // carries (pings) is dropped with it.
            if self.decoder.terminal_seen() {
                self.body = None;
                return None;
            }
            match body.next().await {
                Some(Ok(chunk)) => match self.decoder.feed(&chunk) {
                    Ok(events) => {
                        self.enqueue(events);
                        // An error held back behind this chunk's events
                        // surfaces now, not when the next chunk arrives.
                        if let Err(err) = self.decoder.feed(&[]) {
                            self.fail(err);
                        }
                    }
                    Err(err) => self.fail(err),
                },
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.fail(err);
                }
                None => {
                    self.body = None;
                    match self.decoder.finish() {
                        Ok(events) => self.enqueue(events),
                        Err(err) => self.fail(err),
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
}
