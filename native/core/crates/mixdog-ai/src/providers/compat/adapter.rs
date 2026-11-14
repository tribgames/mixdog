//! `ProviderAdapter` of the OpenAI-compatible family: encode, add the
//! credential, send once, hand back the decoded stream. Retrying is above the
//! adapter. The one repeat inside an attempt is the credential reload after a
//! 401 (status-only, before a stream exists) for keys that can change under
//! us; a key that needs a new login is surfaced with `reauth_required`.
//!
//! The HTTP exchange is the shared `transport::HttpSend` seam.

use crate::transport::deadlines::compat_model_list;
use crate::transport::deadlines::MODEL_STREAM;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelRequest, ModelStream, ProviderAdapter, ProviderError, StreamEvent,
    WireCodec, WireDecoder, WireRequest,
};
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use crate::transport::{BodyStream, HttpResponse, HttpSend};

use super::chat::CompatChatCodec;
use super::profile::{CompatProfile, CredentialKind, Wire, WireInputs};
use super::wire_route::{WireFacts, route_for};
use crate::catalog::{ListingLookup, ModelTraits};
use arc_swap::ArcSwap;
use mixdog_core_api::domain::provider::{ModelListing, WireRoute, WireRouteContext, WireRouting};

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
    pub(super) codec: CompatChatCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    pub(super) http: Arc<dyn HttpSend>,
    /// `None` for a keyless endpoint: no credential header at all.
    pub(super) key: Option<Arc<dyn ApiKeySource>>,
    routing: RouteInputs,
    /// The tables the listing's enrichment and sanitizer read.
    pub(super) lookup: ListingLookup,
    /// The wire a roster states per model (the console config's `wire`),
    /// published by the last listing; the user's `modelWires` win over it.
    pub(super) roster_wires: ArcSwap<HashMap<String, Wire>>,
    /// The rows the last listing stored (`provider._enrichedModels`), which `getCachedModelInfo` answers.
    pub(super) rows: crate::catalog::RowStore,
    /// The first-byte ceiling a profile's window is held to (`PROVIDER_MAX_BEFORE_WARN_MS`), from the environment as Node reads it.
    first_byte: crate::providers::first_byte::FirstByteSettings,
    /// The provider config's `reasoningEffort`: the effort of a send whose turn names none (`opts.effort ??
    /// config.reasoningEffort`, on the Chat and Responses wires).
    configured_effort: Option<String>,
}

/// What the router is told about a model that the profile cannot know: the
/// user's per-model wires (`modelWires`) and the catalog's wire for a model.
#[derive(Clone, Default)]
pub struct RouteInputs {
    pub model_wires: HashMap<String, Wire>,
    pub catalog: Option<Arc<dyn ModelTraits>>,
}

impl CompatAdapter {
    pub fn profile(&self) -> &CompatProfile {
        self.codec.profile()
    }

    pub fn with_routing(mut self, routing: RouteInputs) -> Self {
        self.routing = routing;
        self
    }

    pub fn new(
        codec: CompatChatCodec,
        http: Arc<dyn HttpSend>,
        key: Option<Arc<dyn ApiKeySource>>,
    ) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
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
            routing: RouteInputs::default(),
            lookup: ListingLookup::new(),
            roster_wires: ArcSwap::from_pointee(HashMap::new()),
            rows: crate::catalog::RowStore::default(),
            first_byte: crate::providers::first_byte::FirstByteSettings::process(),
            configured_effort: None,
        }
    }

    /// The first-byte settings of this adapter, when they are not the process environment's.
    pub fn with_first_byte(mut self, settings: crate::providers::first_byte::FirstByteSettings) -> Self {
        self.first_byte = settings;
        self
    }

    /// The provider config's `reasoningEffort`, kept for the sends whose turn names no effort.
    pub fn with_configured_effort(mut self, effort: Option<String>) -> Self {
        self.configured_effort = effort;
        self
    }

    /// The handle the catalog service publishes its tables into.
    pub fn with_listing_lookup(mut self, lookup: ListingLookup) -> Self {
        self.lookup = lookup;
        self
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

    /// The refusal of the request whose body was `sent`.
    async fn failure(codec: &dyn WireCodec, response: HttpResponse, key: Option<&str>, sent: &[u8]) -> ProviderError {
        let body = match response.read_all().await {
            Ok(body) => body,
            Err(err) => return err,
        };
        let mut err = codec.classify(&body);
        // `rejectedToolSchema`: a 400 that names one of the tools this body carried.
        crate::providers::rejections::mark_tool_schema(&mut err, &body.body, &crate::providers::rejections::wire_tool_names(sent));
        if let Some(key) = key {
            err.message = redact_key(&err.message, key);
        }
        err
    }
}

#[async_trait]
impl ProviderAdapter for CompatAdapter {
    fn release_send(&self, _group: &str) {}
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

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }

    /// Every OpenAI-compatible class (`openai-compat.mjs`, the gateways, the OAuth presets) lowers
    /// a PDF to text.
    fn native_pdf(&self) -> bool {
        false
    }

    /// `compatFirstResponseBudget(this.name, chatProfile)`: a profile with a first-byte window of its own states the
    /// worst case over its retry ladder; one on the shared window leaves the watchdog's default.
    fn first_response_budget(&self, _model: &str, _parameters: Option<&mixdog_protocol::JsonValue>) -> Option<mixdog_core_api::domain::provider::FirstResponseBudget> {
        let policy = self.first_byte.compat(self.profile().chat.first_byte?);
        Some(crate::providers::first_byte::first_byte_budget(&policy, &self.policy.request.schedule))
    }

    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        // Only a gateway with a model-family table or its own inputs routes
        // models (Node's `PROFILES`); xAI's two wires are the codec's choice.
        let wires = &self.codec.profile().wires;
        (!wires.families.is_empty() || wires.inputs != WireInputs::OverrideOnly).then_some(self)
    }

    /// `compatStreamRetryReporter(provider.name)` of the Chat Completions send (openai-compat-chat-send.mjs:222,
    /// compat-request-policy.mjs:9).
    fn retry_line(&self, _model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        Some(mixdog_core_api::domain::provider::RetryLine {
            tag: format!("[{}]", self.id),
            delay: true,
            style: mixdog_core_api::domain::provider::RetryLineStyle::Attempt,
        })
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.attempt_with(&self.codec, request).await
    }

    /// `canFallbackNonStreaming` (retry-classification.mjs:402) of the failure a Chat Completions send's ladder ended
    /// on: nothing reached the caller, no call was cut or dispatched, and it is transient, stalled or a truncated
    /// stream.
    fn recovers_spent(&self, _model: &str, failure: &ProviderError) -> bool {
        let exposed =
            failure.unsafe_to_retry || failure.exposure.text_emitted || failure.exposure.tool_dispatched || failure.exposure.tool_input_cut;
        let transient = matches!(failure.kind, ErrorKind::Transient | ErrorKind::Overloaded)
            || failure.timed_out
            || failure.transport == Some(mixdog_core_api::domain::provider::TransportFault::TruncatedStream);
        !exposed && transient
    }

    /// `recoverCompatNonStreaming` (openai-compat-chat-send.mjs:268): the same Chat Completions body once more with
    /// `stream: false` and no `stream_options`; an answer with a choice is the turn, anything else fails the re-issue.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let failed = || ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        let request = match &self.configured_effort {
            Some(effort) if request.options.effort.is_none() => {
                let mut owned = (*request).clone();
                owned.options.effort = Some(effort.clone());
                Arc::new(owned)
            }
            _ => request,
        };
        let mut wire = self.codec.encode(&request)?;
        // Only the Chat Completions send has this recovery (`sendCompatChat`).
        if !wire.url.ends_with("/chat/completions") {
            return Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent));
        }
        wire.body = super::nonstream::body(&wire.body).ok_or_else(failed)?;
        let key = match &self.key {
            Some(source) => Some(source.key().await?),
            None => None,
        };
        request.options.send_identity.raise_stage("requesting");
        let response = self.http.send(Self::with_key(&wire, key.as_deref()), MODEL_STREAM).await?;
        if !response.is_success() {
            return Err(Self::failure(&self.codec, response, key.as_deref(), &wire.body).await);
        }
        let answered = response.read_all().await?;
        let chunk = super::nonstream::as_stream(&answered.body).ok_or_else(failed)?;
        let mut decoder = self.codec.decoder(&request);
        let mut events = decoder.feed(&chunk)?;
        events.extend(decoder.finish()?);
        Ok(Box::new(CompatStream { body: None, decoder, queue: super::nonstream::whole(events).into(), failed: None }))
    }

    /// `[<provider>] stream failed (<code, else message, else unknown>); recovered via non-streaming request`. The
    /// failure's text repeats what the endpoint answered: any credential the process holds is redacted.
    fn recovery_line(&self, _model: &str, failure: &ProviderError) -> Option<String> {
        let cause = [failure.code.as_deref(), Some(failure.message.as_str())].into_iter().flatten().find(|text| !text.is_empty()).unwrap_or("unknown");
        let cause = crate::oauth::carried::remembered().redact_str(cause);
        Some(format!("[{}] stream failed ({cause}); recovered via non-streaming request", self.id))
    }
}

impl CompatAdapter {
    /// One attempt of this provider's key and transport on another of its wires (`codec`): the gateway's
    /// Responses wire rides the same account as its Chat wire.
    pub async fn attempt_with(&self, codec: &dyn WireCodec, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = match &self.configured_effort {
            Some(effort) if request.options.effort.is_none() => {
                let mut owned = (*request).clone();
                owned.options.effort = Some(effort.clone());
                Arc::new(owned)
            }
            _ => request,
        };
        let wire = codec.encode(&request)?;
        let mut key = match &self.key {
            Some(source) => Some(source.key().await?),
            None => None,
        };
        let mut reloaded = false;
        loop {
            // Chat Completions raises `requesting` for every attempt of its ladder (openai-compat-chat-send.mjs:276),
            // Responses once before it (openai-compat-xai-send.mjs:103).
            if wire.url.ends_with("/chat/completions") {
                request.options.send_identity.raise_stage("requesting");
            } else {
                request.options.send_identity.raise_requesting_once();
            }
            let response = self
                .http
                .send(Self::with_key(&wire, key.as_deref()), MODEL_STREAM)
                .await?;
            if response.is_success() {
                return Ok(Box::new(CompatStream::new(response.body, codec.decoder(&request))));
            }
            let err = Self::failure(codec, response, key.as_deref(), &wire.body).await;
            if err.status == Some(401)
                && !reloaded
                && Self::reloadable(self.codec.profile())
                && let Some(source) = &self.key
            {
                reloaded = true;
                mixdog_rt::node_stderr!("[provider] Auth error, re-reading provider authentication...");
                let next = source.reload().await?;
                // The send runs anew (`send`, openai-compat.mjs:171-182), on the reloaded key when it names one and
                // the same key otherwise: its ladder raises `requesting` again.
                request.options.send_identity.reissue();
                if !next.is_empty() {
                    key = Some(next);
                }
                continue;
            }
            return Err(err);
        }
    }
}

#[async_trait]
impl WireRouting for CompatAdapter {
    async fn resolve_wire_route(
        &self,
        model: &str,
        context: &WireRouteContext,
    ) -> Result<Option<WireRoute>, ProviderError> {
        let profile = self.codec.profile();
        let mut facts = WireFacts {
            override_wire: self
                .routing
                .model_wires
                .get(model)
                .copied()
                .or_else(|| self.roster_wires.load().get(model).copied()),
            known: true,
            ..WireFacts::default()
        };
        let mut endpoints: Option<Vec<Wire>> = None;
        match profile.wires.inputs {
            WireInputs::OverrideOnly => {}
            WireInputs::Catalog => {
                facts.catalog_wire = self.routing.catalog.as_ref().and_then(|c| c.catalog_wire(model));
                // Each model answers on the one wire the catalog names.
                endpoints = facts.catalog_wire.filter(|w| profile.wires.offered.contains(w)).map(|w| vec![w]);
            }
            WireInputs::Roster => match self.codec.models().get(model) {
                // A row declaring none is served on Chat by convention.
                Some(row) => endpoints = Some(row.endpoints.clone().unwrap_or_else(|| vec![Wire::Chat])),
                None => facts.known = false,
            },
        }
        facts.endpoints = endpoints.as_deref();
        Ok(route_for(profile, profile.id, model, facts, context))
    }
}

/// `GET {url}` as JSON. A refused request keeps the provider's own reason
/// with the request key redacted from it; a reachable endpoint that answers
/// something else is `null`.
pub(super) async fn fetch_json(
    http: &dyn HttpSend,
    profile: &CompatProfile,
    url: String,
    extra_headers: &[(String, String)],
    key: Option<&str>,
) -> Result<serde_json::Value, ProviderError> {
    if profile.listing.plain_fetch {
        // `fetchCompatModelItems`: the bearer, then the client's default headers; the fetch adds its own `accept`.
        let mut headers: Vec<(String, String)> = key.map(|key| ("authorization".to_owned(), format!("Bearer {key}"))).into_iter().collect();
        headers.extend(profile.headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
        headers.extend(extra_headers.iter().cloned());
        return fetch_listing(http, profile, url, headers, key).await;
    }
    // `Accept` first, then the gateway's own headers (`fetchRoster`, `opencode-go-oauth-tokens.mjs` `request`).
    let accept = profile.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("accept")).map_or("application/json", |(_, v)| *v);
    let mut headers: Vec<(String, String)> = vec![("accept".into(), accept.into())];
    headers.extend(profile.headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("accept")).map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    headers.extend(extra_headers.iter().cloned());
    if let Some(key) = key {
        headers.push(("authorization".into(), format!("Bearer {key}")));
    }
    fetch_listing(http, profile, url, headers, key).await
}

async fn fetch_listing(
    http: &dyn HttpSend,
    profile: &CompatProfile,
    url: String,
    headers: Vec<(String, String)>,
    key: Option<&str>,
) -> Result<serde_json::Value, ProviderError> {
    let response = http
        .send(
            WireRequest {
                transport: mixdog_core_api::domain::keepalive::TransportKind::Http1,
                method: "GET".into(),
                url,
                headers,
                body: Vec::new(),
            },
            compat_model_list(profile.id),
        )
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
    Ok(serde_json::from_slice(&body.body).unwrap_or(serde_json::Value::Null))
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
                    // Node reads the body through the OpenAI SDK's `fetch` (`consumeCompatChatCompletionStream`), whose
                    // socket failure mid-body is undici's `TypeError: terminated`.
                    err.message = crate::transport::link::TERMINATED.to_owned();
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

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

#[cfg(test)]
mod site_tests {
    use super::*;
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

    /// A model list that outlives its timer reads as the real Node function did (`sites.compatModelList`): the
    /// labelled `"<provider> model list"` timer.
    #[tokio::test(start_paused = true)]
    async fn a_model_list_that_outlives_its_timer_reads_as_nodes() {
        let transport = TimingOut::new();
        let profile = CompatProfile::plain("groq", "http://x.test/v1", CredentialKind::Keyless);
        let error = fetch_json(transport.as_ref(), &profile, "http://x.test/v1/models".to_owned(), &[], None)
            .await
            .expect_err("the endpoint never answers");
        assert_transport("compatModelList", &transport);
        assert_thrown("compatModelList", &error.message);
    }
}
