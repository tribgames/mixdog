//! One [`ProviderAdapter`] for the three Google providers: encode, add
//! credentials, send once, hand back the decoded stream. Retrying is above;
//! the only repeat inside an attempt is the credential recovery of a 401
//! (one refreshed credential, one resend), which is part of getting one
//! request accepted.

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use mixdog_core_api::domain::provider::GeminiCacheState;
use mixdog_core_api::domain::provider::ProviderState;
use serde_json::Value;

use super::auth::Authorization;
use super::auth::RequestAuth;
use super::cache::layer::Ask;
use super::cache::layer::ExplicitCache;
use super::cache::policy::CacheRequest;
use super::codec::Attach;
use super::codec::GoogleCodec;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

pub struct GoogleAdapter {
    id: ProviderId,
    codec: GoogleCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    auth: Arc<dyn RequestAuth>,
    /// The account the codec's target was built for.
    identity: String,
    cache: Option<ExplicitCache>,
}

impl GoogleAdapter {
    pub fn new(
        codec: GoogleCodec,
        policy: RetryPolicy,
        http: Arc<dyn HttpSend>,
        auth: Arc<dyn RequestAuth>,
        identity: String,
    ) -> Self {
        Self {
            id: codec.provider().clone(),
            codec,
            policy,
            keepalive: KeepaliveSchedule::SPEC,
            http,
            auth,
            identity,
            cache: None,
        }
    }

    /// A request built for one account must not run under another's.
    fn check_identity(&self, authorization: &Authorization) -> Result<(), ProviderError> {
        if authorization.identity == self.identity {
            return Ok(());
        }
        let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        err.reauth_required = true;
        err.message = "the credential changed during the request".into();
        Err(err)
    }

    fn authorized(wire: &WireRequest, authorization: &Authorization) -> WireRequest {
        let mut request = wire.clone();
        request.headers.extend(authorization.headers.iter().cloned());
        request
    }

    /// Serves the Gemini API's explicit `cachedContents` ([`ExplicitCache`]).
    pub fn with_cache(mut self, cache: ExplicitCache) -> Self {
        self.cache = Some(cache);
        self
    }

    /// The cache to attach to `request`, if any, and the session state it
    /// changed. Hosted tools disable it, as in Node (`opts.nativeTools`).
    async fn cached_prefix(&self, request: &ModelRequest, inner: &Value) -> Option<Cached> {
        let cache = self.cache.as_ref()?;
        if !request.options.hosted_tools.is_empty() {
            return None;
        }
        let system = inner["systemInstruction"]["parts"][0]["text"].as_str().unwrap_or_default();
        let tools = inner["tools"].as_array().map(Vec::as_slice).unwrap_or_default();
        let contents = inner["contents"].as_array().map(Vec::as_slice).unwrap_or_default();
        let answer = cache
            .ensure(Ask {
                model: &request.model,
                request: CacheRequest {
                    system_instruction: system,
                    tools,
                    tool_config: inner.get("toolConfig"),
                    contents,
                },
                state: request.options.provider_state.as_ref(),
                iteration: request.options.iteration,
                fork: request.options.shared_cache_prefix_count.is_some_and(|n| n > 0),
            })
            .await;
        let name = answer.cache_name?;
        let state = answer
            .state
            .as_ref()
            .or(request.options.provider_state.as_ref())
            .and_then(|s| s.gemini.clone())
            .filter(|s| s.cache_name == name)?;
        Some(Cached { name, state, changed: answer.state })
    }

    /// One authorized send, with the single credential-recovery resend of a 401.
    async fn dispatch(&self, wire: &WireRequest) -> Result<HttpResponse, ProviderError> {
        let mut authorization = self.auth.authorize().await?;
        self.check_identity(&authorization)?;
        let mut response = self.http.send(Self::authorized(wire, &authorization)).await?;
        if response.status == 401 && self.auth.rejected(&authorization).await {
            authorization = self.auth.authorize().await?;
            self.check_identity(&authorization)?;
            response = self.http.send(Self::authorized(wire, &authorization)).await?;
        }
        Ok(response)
    }
}

struct Cached {
    name: String,
    state: GeminiCacheState,
    /// `Some` when attaching changed the session's provider state.
    changed: Option<ProviderState>,
}

#[async_trait]
impl ProviderAdapter for GoogleAdapter {
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
        // State changes reach the session only as stream events: Node persists
        // `providerState` from a delivered result alone (`ask-turn-settle.mjs:147`),
        // never from a failed send, so no error carries one.
        let inner = self.codec.build_inner(&request)?;
        let mut queue = VecDeque::new();
        let mut cached = self.cached_prefix(&request, &inner).await;
        if let Some(state) = cached.as_ref().and_then(|c| c.changed.clone()) {
            queue.push_back(Ok(StreamEvent::ProviderState(state)));
        }
        let mut response = {
            let attach = cached.as_ref().map(|c| Attach { name: &c.name, state: &c.state });
            self.dispatch(&self.codec.wire(&request, &inner, attach)?).await?
        };
        // A cache the server refuses (gone, evicted, mismatched) is forgotten
        // here and in the session, and the request runs once without it. The
        // only cache-specific thing a 400/404 can be about is the attachment.
        if let Some(rejected) = cached.take().filter(|_| matches!(response.status, 400 | 404)) {
            if let Some(cache) = &self.cache {
                cache.forget(&rejected.name);
            }
            // Node drops only the `gemini` key; the other provider keys stay.
            let rest = request.options.provider_state.as_ref().map(|s| s.rest.clone()).unwrap_or_default();
            queue.push_back(Ok(StreamEvent::ProviderState(ProviderState { gemini: None, rest })));
            response = self.dispatch(&self.codec.wire(&request, &inner, None)?).await?;
        }
        // A typed 401 is the only credential event Node acts on
        // (`gemini.mjs:667`): every cache made under the rejected key goes.
        if response.status == 401
            && let Some(cache) = &self.cache
        {
            cache.forget_credential();
        }
        if !response.is_success() {
            let rejected = response.read_all().await?;
            return Err(self.codec.classify_for(&rejected, &request));
        }
        Ok(Box::new(GoogleStream {
            body: response.body,
            decoder: self.codec.decoder(&request),
            queue,
            ended: false,
            model: request.model.clone(),
            // An empty answer right after a tool result is the model's answer.
            after_tool_result: request
                .messages
                .iter()
                .rev()
                .find(|m| m.role != Role::System)
                .is_some_and(|m| m.role == Role::Tool),
            produced_output: false,
        }))
    }
}

struct GoogleStream {
    body: Box<dyn BodyStream>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    model: String,
    after_tool_result: bool,
    produced_output: bool,
}

impl GoogleStream {
    fn fail(&mut self, err: ProviderError) {
        self.ended = true;
        self.queue.push_back(Err(err));
    }

    fn push(&mut self, events: Vec<StreamEvent>) {
        for mut event in events {
            match &mut event {
                StreamEvent::TextDelta(_) | StreamEvent::ToolCallDone(_) => self.produced_output = true,
                StreamEvent::ReasoningReplay(replay) => {
                    // A replay is bound to the model that produced it.
                    if let Some(items) = replay.items.as_object_mut() {
                        items.insert("model".into(), self.model.clone().into());
                    }
                }
                StreamEvent::Completed { stop: None }
                    if !self.produced_output && !self.after_tool_result =>
                {
                    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
                    err.code = Some("no_response_text".into());
                    err.message = "the response finished without any answer".into();
                    self.fail(err);
                    return;
                }
                _ => {}
            }
            self.queue.push_back(Ok(event));
        }
    }
}

#[async_trait]
impl ModelStream for GoogleStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(item) = self.queue.pop_front() {
                return Some(item);
            }
            if self.ended {
                return None;
            }
            match self.body.next().await {
                Some(Ok(chunk)) => match self.decoder.feed(&chunk) {
                    Ok(events) => self.push(events),
                    Err(err) => self.fail(err),
                },
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.fail(err);
                }
                None => {
                    self.ended = true;
                    match self.decoder.finish() {
                        Ok(events) => self.push(events),
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
