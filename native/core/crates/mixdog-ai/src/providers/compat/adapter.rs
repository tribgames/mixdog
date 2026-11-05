//! `ProviderAdapter` of the OpenAI-compatible family: encode, add the
//! credential, send once, hand back the decoded stream. Retrying is above the
//! adapter. The one repeat inside an attempt is the credential reload after a
//! 401 (status-only, before a stream exists) for keys that can change under
//! us; a key that needs a new login is surfaced with `reauth_required`.
//!
//! The HTTP exchange is the shared `transport::HttpSend` seam.

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelRequest, ModelStream, ProviderAdapter, ProviderError, StreamEvent,
    WireCodec, WireDecoder, WireRequest,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use crate::transport::{BodyStream, HttpResponse, HttpSend};

use super::chat::CompatChatCodec;
use super::models::{CompatModelInfo, parse_models};
use super::profile::{CompatProfile, CredentialKind};

pub use crate::providers::key_source::ApiKeySource;

/// Removes the request key, and any run of at least `min(8, len)` of its
/// leading characters ("Incorrect API key provided: sk-abcd****"), from text
/// a gateway echoed.
pub fn redact_key(value: &str, key: &str) -> String {
    if key.is_empty() {
        return value.to_owned();
    }
    let key: Vec<char> = key.chars().collect();
    let chars: Vec<char> = value.chars().collect();
    let min = key.len().min(8);
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        let run = chars[i..]
            .iter()
            .zip(&key)
            .take_while(|(a, b)| a == b)
            .count();
        if run >= min {
            out.push_str("[redacted]");
            i += run;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

pub struct CompatAdapter {
    id: ProviderId,
    codec: CompatChatCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    /// `None` for a keyless endpoint: no credential header at all.
    key: Option<Arc<dyn ApiKeySource>>,
}

impl CompatAdapter {
    pub fn new(
        codec: CompatChatCodec,
        http: Arc<dyn HttpSend>,
        key: Option<Arc<dyn ApiKeySource>>,
    ) -> Self {
        let profile = codec.profile();
        debug_assert_eq!(
            key.is_none(),
            profile.credential == CredentialKind::Keyless,
            "a keyless profile has no key source and a keyed one has"
        );
        Self {
            id: ProviderId::from(profile.id),
            policy: profile.retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            codec,
            http,
            key,
        }
    }

    fn with_key(wire: &WireRequest, key: Option<&str>) -> WireRequest {
        let mut request = wire.clone();
        if let Some(key) = key {
            request
                .headers
                .push(("authorization".into(), format!("Bearer {key}")));
        }
        request
    }

    /// Whether a rejected key may change under us (a static config key can be
    /// edited; a login-issued key needs a new login instead).
    fn reloadable(profile: &CompatProfile) -> bool {
        profile.credential == CredentialKind::StaticKey { reauth_on_401: false }
    }

    async fn failure(&self, response: HttpResponse, key: Option<&str>) -> ProviderError {
        let body = match response.read_all().await {
            Ok(body) => body,
            Err(err) => return err,
        };
        let mut err = self.codec.classify(&body);
        if let Some(key) = key {
            err.message = redact_key(&err.message, key);
        }
        err
    }
}

#[async_trait]
impl ProviderAdapter for CompatAdapter {
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
        let mut key = match &self.key {
            Some(source) => Some(source.key().await?),
            None => None,
        };
        let mut reloaded = false;
        loop {
            let response = self.http.send(Self::with_key(&wire, key.as_deref())).await?;
            if response.is_success() {
                return Ok(Box::new(CompatStream::new(response.body, self.codec.decoder())));
            }
            let err = self.failure(response, key.as_deref()).await;
            if err.status == Some(401)
                && !reloaded
                && Self::reloadable(self.codec.profile())
                && let Some(source) = &self.key
            {
                reloaded = true;
                let next = source.reload().await?;
                if key.as_deref() != Some(next.as_str()) {
                    key = Some(next);
                    continue;
                }
            }
            return Err(err);
        }
    }
}

/// `GET {base}/models`. A refused request keeps the provider's own reason
/// with the request key redacted from it.
pub async fn fetch_models(
    http: &dyn HttpSend,
    profile: &CompatProfile,
    base_url: &str,
    key: Option<&str>,
) -> Result<Vec<CompatModelInfo>, ProviderError> {
    let mut headers: Vec<(String, String)> = vec![("accept".into(), "application/json".into())];
    headers.extend(profile.headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    if let Some(key) = key {
        headers.push(("authorization".into(), format!("Bearer {key}")));
    }
    let response = http
        .send(WireRequest {
            transport: mixdog_core_api::domain::keepalive::TransportKind::Http1,
            method: "GET".into(),
            url: format!("{}/models", base_url.trim_end_matches('/')),
            headers,
            body: Vec::new(),
        })
        .await?;
    let ok = response.is_success();
    let body = response.read_all().await?;
    if !ok {
        let mut err = super::error::classify(profile, &body);
        if let Some(key) = key {
            err.message = redact_key(&err.message, key);
        }
        return Err(err);
    }
    // A reachable endpoint that returns something else lists nothing.
    let json = serde_json::from_slice(&body.body).unwrap_or(serde_json::Value::Null);
    Ok(parse_models(&json))
}

struct CompatStream {
    body: Option<Box<dyn BodyStream>>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
}

impl CompatStream {
    fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self {
            body: Some(body),
            decoder,
            queue: VecDeque::new(),
            failed: None,
        }
    }
}

#[async_trait]
impl ModelStream for CompatStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            if let Some(err) = self.failed.take() {
                return Some(Err(err));
            }
            let body = self.body.as_mut()?;
            // The terminal event ends the attempt; anything after it is dropped.
            if self.decoder.terminal_seen() {
                self.body = None;
                return None;
            }
            match body.next().await {
                Some(Ok(chunk)) => match self.decoder.feed(&chunk) {
                    Ok(events) => self.queue.extend(events),
                    Err(err) => {
                        self.body = None;
                        self.failed = Some(err);
                    }
                },
                Some(Err(fault)) => {
                    self.body = None;
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.failed = Some(err);
                }
                None => {
                    self.body = None;
                    match self.decoder.finish() {
                        Ok(events) => self.queue.extend(events),
                        Err(err) => self.failed = Some(err),
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
}
