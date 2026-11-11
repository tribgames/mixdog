//! One [`ProviderAdapter`] for the three Google providers: encode, add
//! credentials, send once, hand back the decoded stream. Retrying is above;
//! the only repeat inside an attempt is the credential recovery of a 401
//! (one refreshed credential, one resend), which is part of getting one
//! request accepted.

use crate::transport::deadlines::GEMINI_MODELS;
use crate::transport::deadlines::MODEL_STREAM_FETCH;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::RetryLine;
use mixdog_core_api::domain::provider::RetryLineStyle;
use mixdog_core_api::domain::provider::SendStages;
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
use crate::providers::key_source::ApiKeySource;
use super::cache::layer::Ask;
use super::cache::layer::ExplicitCache;
use super::cache::layer::HeldConnection;
use super::cache::policy::CacheRequest;
use super::codec::Attach;
use super::codec::GoogleCodec;
use super::codec::Target;
use super::models;
use super::watchdog::StreamWatch;
use super::watchdog::Watchdogs;
use super::redirect;
use crate::catalog::ListingLookup;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::preconnect::Preconnect;

pub struct GoogleAdapter {
    id: ProviderId,
    codec: GoogleCodec,
    policy: RetryPolicy,
    /// The policy of Vertex AI's open models ([`ProviderAdapter::retry_policy_for`]).
    maas_policy: RetryPolicy,
    /// The policy of Claude on Vertex AI.
    claude_policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    /// An open model's sends: Node posts them through the OpenAI client (`vertex-ai-maas.mjs`, no default headers),
    /// whose head the SDK writes.
    maas_http: Arc<dyn HttpSend>,
    auth: Arc<dyn RequestAuth>,
    /// The account the codec's target was built for.
    identity: String,
    cache: Option<ExplicitCache>,
    /// The Gemini API's key as Node re-reads it after a typed 401 (`GeminiProvider.reloadApiKey`).
    reload: Option<Arc<dyn ApiKeySource>>,
    /// Antigravity's records that carry a `wire`: the one source of the route
    /// table, from the last listing or the catalog's restored snapshot.
    roster: Mutex<Vec<ModelRecord>>,
    /// The metadata enrichment and picker sanitizer Gemini's listing ends with.
    lookup: ListingLookup,
    /// The Gemini API's socket warm-up (`preconnect(GEMINI_API_ORIGIN)`).
    preconnect: Option<Preconnect>,
    /// The process environment the stream windows resolve from (`resolveTimeoutMs`).
    var: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl GoogleAdapter {
    pub fn new(
        codec: GoogleCodec,
        policy: RetryPolicy,
        http: Arc<dyn HttpSend>,
        auth: Arc<dyn RequestAuth>,
        identity: String,
    ) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id: codec.provider().clone(),
            codec,
            policy,
            maas_policy: crate::providers::compat::retry::unprofiled(),
            claude_policy: crate::providers::anthropic::retry_policy(true),
            keepalive: KeepaliveSchedule::SPEC,
            maas_http: Arc::new(
                crate::registry::gateway::GatewayHttp::new(http.clone()).through_sdk(crate::registry::gateway::Sdk::OpenAi, &[]),
            ),
            http,
            auth,
            identity,
            cache: None,
            reload: None,
            roster: Mutex::default(),
            lookup: ListingLookup::new(),
            preconnect: None,
            var: Arc::new(|name| std::env::var(name).ok()),
        }
    }

    /// Warms the Gemini API now, as `GeminiProvider`'s constructor does (`gemini.mjs:291`), and again before each send
    /// (`send`, `gemini.mjs:651`).
    /// The settings the adapter reads (its first-byte and idle windows) from `var` instead of the process environment.
    pub fn with_settings(mut self, var: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>) -> Self {
        self.var = var;
        self
    }

    pub fn with_preconnect(mut self, preconnect: Preconnect) -> Self {
        preconnect.warm(super::codec::GEMINI_ORIGIN);
        self.preconnect = Some(preconnect);
        self
    }

    /// Shares the catalog's listing tables (`CatalogService::listing_lookup`).
    pub fn with_listing_lookup(mut self, lookup: ListingLookup) -> Self {
        self.lookup = lookup;
        self
    }

    /// Seeds the route table from the catalog's restored snapshot, before any
    /// send and with no fetch. Records without a `wire` are not routes.
    pub fn with_roster(self, records: &[ModelRecord]) -> Self {
        self.set_roster(records);
        self
    }

    fn set_roster(&self, records: &[ModelRecord]) {
        let wired = records.iter().filter(|r| r.wire.is_some()).cloned().collect();
        *self.roster.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = wired;
    }

    /// Antigravity names a tier family by one picker id; the wire id carries
    /// the chosen effort. An effort the route consumes (or drops) leaves the
    /// request, with its `thinkingLevel`.
    fn routed(&self, request: Arc<ModelRequest>) -> Arc<ModelRequest> {
        if !matches!(self.codec.target(), Target::Antigravity { .. }) {
            return request;
        }
        let roster = self.roster.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (model, effort) = models::resolve_wire(&roster, &request.model, request.options.effort.as_deref());
        drop(roster);
        if model == request.model && effort == request.options.effort {
            return request;
        }
        let mut routed = (*request).clone();
        routed.model = model;
        if effort != routed.options.effort {
            if effort.is_none()
                && let Some(Value::Object(params)) = routed.options.model_parameters.as_mut()
            {
                params.shift_remove("thinkingLevel");
            }
            routed.options.effort = effort;
        }
        Arc::new(routed)
    }

    /// `_servedModel`: the direct Gemini API serves some ids as another model from a date on; the served id is the
    /// request's model for the whole request (wire id, settings, cache, cost: the ledger books the send under it
    /// and the response reports it, by `StreamEvent::ServedModel`), announced once per process.
    fn served(&self, request: Arc<ModelRequest>) -> (Arc<ModelRequest>, Option<Redirect>) {
        let (Target::Gemini { .. }, Some(cache)) = (self.codec.target(), self.cache.as_ref()) else {
            return (request, None);
        };
        let Some(target) = redirect::served_as(&request.model, cache.now_ms()) else {
            return (request, None);
        };
        // `geminiBareModelId`: the id as given, without a `models/` prefix (any case).
        let requested = match request.model.get(..7) {
            Some(head) if head.eq_ignore_ascii_case("models/") => request.model[7..].to_owned(),
            _ => request.model.clone(),
        };
        let mut served = (*request).clone();
        served.model = target.to_owned();
        (Arc::new(served), Some(Redirect { requested, target }))
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
        // A header the codec gave a slot keeps its place in the head; any other goes last.
        for (name, value) in &authorization.headers {
            match request.headers.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                Some(slot) => slot.1.clone_from(value),
                None => request.headers.push((name.clone(), value.clone())),
            }
        }
        request
    }

    /// Serves the Gemini API's explicit `cachedContents` ([`ExplicitCache`]).
    pub fn with_cache(mut self, cache: ExplicitCache) -> Self {
        self.cache = Some(cache);
        self
    }

    /// A typed 401 re-reads the key through `source` and sends the whole request once more
    /// (`GeminiProvider.send`): the Gemini API's recovery, and no other family's.
    pub fn with_key_reload(mut self, source: Arc<dyn ApiKeySource>) -> Self {
        self.reload = Some(source);
        self
    }

    /// The cache to attach to `request` under `cache` (the cache serving the request's key), if any, and the
    /// session state it changed. Hosted tools disable it, as in Node (`opts.nativeTools`).
    async fn cached_prefix(&self, cache: Option<&ExplicitCache>, request: &ModelRequest, inner: &Value) -> Option<Cached> {
        let cache = cache?;
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
        Some(Cached { name, state, changed: answer.state, held: answer.held })
    }

    /// One authorized send, with the single credential-recovery resend of a 401.
    async fn dispatch(&self, wire: &WireRequest) -> Result<HttpResponse, ProviderError> {
        self.dispatch_on(&*self.http, wire).await
    }

    async fn dispatch_on(&self, http: &dyn HttpSend, wire: &WireRequest) -> Result<HttpResponse, ProviderError> {
        let mut authorization = self.auth.authorize().await?;
        self.check_identity(&authorization)?;
        let mut response = http.send(Self::authorized(wire, &authorization), MODEL_STREAM_FETCH).await?;
        if response.status == 401 && self.auth.rejected(&authorization).await {
            authorization = self.auth.authorize().await?;
            self.check_identity(&authorization)?;
            response = http.send(Self::authorized(wire, &authorization), MODEL_STREAM_FETCH).await?;
        }
        Ok(response)
    }

    /// One listing fetch: no credential recovery and no resend. Node's listing
    /// calls take whatever credential is current and report what comes back.
    async fn fetch_listing(&self, wire: &WireRequest) -> Result<Vec<u8>, ProviderError> {
        let authorization = self.auth.authorize().await?;
        self.check_identity(&authorization)?;
        let response = self
            .http
            .send(Self::authorized(wire, &authorization), GEMINI_MODELS)
            .await?;
        let succeeded = response.is_success();
        let read = response.read_all().await?;
        if !succeeded {
            return Err(self.codec.classify(&read));
        }
        Ok(read.body)
    }
}

#[async_trait]
impl ModelListing for GoogleAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        match self.codec.target() {
            // Vertex AI has no listing endpoint: its own list, with no credential.
            Target::Vertex { .. } => Ok(models::vertex_records()),
            Target::Gemini { origin } => {
                let mut items = Vec::new();
                let mut token: Option<String> = None;
                loop {
                    let body = self.fetch_listing(&models::gemini_request(origin, token.as_deref())).await?;
                    let page = models::gemini_page(&body)?;
                    items.extend(page.models);
                    match page.next {
                        Some(next) => token = Some(next),
                        // `enrichModels`, then `sanitizeModelList`
                        // (`gemini-model-catalog.mjs:121-124`).
                        None => {
                            let enriched = self.lookup.enrich_listed("gemini", models::gemini_records(&items));
                            return Ok(self.lookup.sanitize_listed("gemini", enriched));
                        }
                    }
                }
            }
            Target::Antigravity { origin, project, client_version } => {
                let body = self.fetch_listing(&models::antigravity_request(origin, project, &client_version.get())).await?;
                let records = models::antigravity_records(&body, self.codec.traits())?;
                self.set_roster(&records);
                Ok(records)
            }
        }
    }
}

/// `announcedRedirects` (`gemini.mjs:90`): the requested ids already announced in this process.
static ANNOUNCED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// No redirect announced yet, as in a new process.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_announced() {
    ANNOUNCED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
}

/// A model id the Gemini API serves as another one (`announcedRedirects` in `gemini.mjs`).
struct Redirect {
    requested: String,
    target: &'static str,
}

impl Redirect {
    /// The notice, once per requested id per process: Node announces on the first send that meets the id, to that
    /// send's `onStageChange` (tone `warn`) and to stderr. The claim is made here, before the request is built, as
    /// in Node: the notice rides the stream when the request has one and the error when it fails.
    fn announce(&self) -> Option<StreamEvent> {
        let mut announced = ANNOUNCED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if announced.contains(&self.requested) {
            return None;
        }
        announced.push(self.requested.clone());
        let message = format!(
            "{} is now served by Google as {} (redirect effective 2026-12-01; billed at {} rates)",
            self.requested, self.target, self.target
        );
        mixdog_rt::node_stderr!("[gemini] {message}");
        Some(StreamEvent::Notice { message, warn: true })
    }
}

struct Cached {
    name: String,
    state: GeminiCacheState,
    /// `Some` when attaching changed the session's provider state.
    changed: Option<ProviderState>,
    /// The connection of the create this request made, held until the request is sent.
    held: HeldConnection,
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

    /// An open model on Vertex AI retries as its OpenAI-compatible engine does (`withCompatRetryProfile('vertex-ai')`:
    /// no profile, the shared default); Claude as the first-party Anthropic route does (`_sendClaude`'s `withRetry`:
    /// Anthropic's backoff and attempts, 429 and 529 retried, `Retry-After` honoured).
    fn retry_policy_for(&self, model: &str) -> &RetryPolicy {
        if self.codec.maas_model(model).is_some() {
            &self.maas_policy
        } else if self.codec.claude_model(model).is_some() {
            &self.claude_policy
        } else {
            &self.policy
        }
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }

    /// `GeminiProvider._doSend`: `requesting` once the request is built and again once its cache is settled, then
    /// before every attempt (`run`) and before the non-streaming re-issue, and `reconnecting` before each retry wait
    /// (`geminiRetryLogger`, gemini.mjs:239-246). Gemini models on the Gemini API and on Vertex AI run
    /// `runGeminiStreamAttempts` (gemini.mjs:866-876, vertex-ai.mjs:382-398): the ladder by the response having opened;
    /// Vertex AI passes no `onRetry`, so it raises no `reconnecting`. Antigravity (antigravity-transport.mjs:185) and
    /// Vertex AI's Claude (vertex-ai.mjs:516) and open models raise it under their own ladders.
    fn send_stages(&self, model: &str) -> SendStages {
        let gemini_ladder = !matches!(self.codec.target(), Target::Antigravity { .. })
            && self.codec.maas_model(model).is_none()
            && self.codec.claude_model(model).is_none();
        if !self.direct_gemini(model) {
            // Antigravity's attempt notes `model_thinking` once its request is on the wire (antigravity-transport.mjs:236).
            let model_thinking = matches!(self.codec.target(), Target::Antigravity { .. });
            return SendStages { ladder_by_connection: gemini_ladder, reconnecting: !gemini_ladder, model_thinking, ..SendStages::default() };
        }
        SendStages { preparing: 2, each_attempt: true, before_recovery: true, reconnecting: true, ladder_by_connection: true, model_thinking: false }
    }

    /// `geminiRetryLogger(opts, '[gemini]')` of a send without a cached prefix (`_streamViaRest`'s label).
    fn retry_line(&self, model: &str) -> Option<RetryLine> {
        if self.direct_gemini(model) {
            return Some(RetryLine { tag: "[gemini]".into(), delay: false, style: RetryLineStyle::Attempt });
        }
        // Antigravity's ladder writes `[antigravity] retry <n> after <message>` (antigravity-transport.mjs:179); Vertex
        // AI's open models the compat ladder's line (`withCompatRetryProfile('vertex-ai')`, compat-request-policy.mjs:9).
        // Its Claude and Gemini models write none.
        if matches!(self.codec.target(), Target::Antigravity { .. }) {
            return Some(RetryLine { tag: "[antigravity]".into(), delay: false, style: RetryLineStyle::Plain });
        }
        self.codec.maas_model(model).is_some().then(|| RetryLine { tag: "[vertex-ai]".into(), delay: true, style: RetryLineStyle::Attempt })
    }

    /// `canFallbackNonStreaming` (retry-classification.mjs:402) of a stream-phase failure: nothing reached the caller,
    /// no call was cut or dispatched, and it is transient, stalled or a truncated stream.
    fn recovers_spent(&self, model: &str, failure: &ProviderError) -> bool {
        let exposed = failure.unsafe_to_retry
            || failure.exposure.text_emitted
            || failure.exposure.tool_dispatched
            || failure.exposure.tool_input_cut;
        let transient = matches!(failure.kind, ErrorKind::Transient | ErrorKind::Overloaded)
            || failure.timed_out
            || failure.transport == Some(mixdog_core_api::domain::provider::TransportFault::TruncatedStream);
        self.direct_gemini(model) && !exposed && transient
    }

    /// `_recoverGeminiNonStreaming`: the same body once to `:generateContent`; an answer with a candidate is the turn
    /// (and the stderr line), anything else fails the re-issue.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let (request, _) = self.served(self.routed(request));
        let inner = self.codec.build_inner(&request)?;
        let mut wire = self.codec.wire(&request, &inner, None)?;
        wire.url = wire.url.replacen(":streamGenerateContent?alt=sse", ":generateContent", 1);
        let response = self.dispatch(&wire).await?;
        let answered = response.read_all().await?;
        if !(200..300).contains(&answered.status.unwrap_or(0)) {
            return Err(self.codec.classify_for(&answered, &request, false));
        }
        let candidates = serde_json::from_slice::<Value>(&answered.body)
            .ok()
            .and_then(|body| body.get("candidates").and_then(Value::as_array).map(|c| !c.is_empty()));
        if candidates != Some(true) {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted));
        }
        let mut sse = b"data: ".to_vec();
        sse.extend_from_slice(&answered.body);
        sse.extend_from_slice(b"\n\n");
        let mut stream = GoogleStream::consume(Box::new(Whole(Some(sse.into()))), self.codec.decoder_at(&request, false), None);
        stream.answer_required = true;
        stream.after_tool_result =
            request.messages.iter().rev().find(|m| m.role != Role::System).is_some_and(|m| m.role == Role::Tool);
        Ok(Box::new(stream))
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if let Some(preconnect) = &self.preconnect {
            preconnect.warm(super::codec::GEMINI_ORIGIN);
        }
        let (request, redirect) = self.served(self.routed(request));
        // `_servedModel` announces, and claims the once-per-process notice, before the request is built or sent:
        // a send that fails still showed it, and a later one does not show it again.
        let notice = redirect.as_ref().and_then(Redirect::announce);
        match self.attempt_served(request).await {
            Ok(mut stream) => {
                // The result's `model` is the served one, which the ledger books and the turn reports.
                if let Some(redirect) = &redirect {
                    stream.queue.push_front(Ok(StreamEvent::ServedModel(redirect.target.to_owned())));
                }
                if let Some(notice) = notice {
                    stream.queue.push_front(Ok(notice));
                }
                Ok(Box::new(stream))
            }
            Err(mut error) => {
                if let Some(StreamEvent::Notice { message, warn }) = notice {
                    error.notices.push((message, warn));
                }
                Err(error)
            }
        }
    }
}

/// A body already read whole, as one chunk.
struct Whole(Option<bytes::Bytes>);

#[async_trait]
impl BodyStream for Whole {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// `isGeminiCachedContentError` (gemini.mjs:222-231) over the error `geminiRestError` makes of `body`: its message
/// (`<label> <status>: ` and the first 300 characters of the body) and its `data`, lower-cased, name the cached
/// content or the attached cache. `data` is the parsed payload whenever `payload?.error || payload` is truthy
/// (gemini.mjs:199), which is whenever the payload itself is: an object or array whatever its `error`, a non-empty
/// string, a number other than 0, `true`.
fn names_cached_content(body: &[u8], cache_name: &str) -> bool {
    let text = String::from_utf8_lossy(body);
    let head = String::from_utf16_lossy(&text.encode_utf16().take(300).collect::<Vec<u16>>());
    let truthy = |payload: &Value| match payload {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    let payload = serde_json::from_slice::<Value>(body).ok().filter(truthy);
    let data = payload.map_or_else(|| "\"\"".to_owned(), |p| p.to_string());
    let text = format!("{head} {data}").to_lowercase();
    text.contains("cachedcontent") || text.contains("cached content") || (!cache_name.is_empty() && text.contains(&cache_name.to_lowercase()))
}

/// One request's exchange: the answer, the session-state changes it made, and whether it ran on the global location.
struct Exchanged {
    response: HttpResponse,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    global: bool,
}

impl GoogleAdapter {
    /// A send to `model` on the Gemini API itself (`GeminiProvider`), not one of its other engines.
    fn direct_gemini(&self, model: &str) -> bool {
        matches!(self.codec.target(), Target::Gemini { .. }) && self.codec.maas_model(model).is_none() && self.codec.claude_model(model).is_none()
    }

    /// The key the request is sent with, for the families that read one per send (`_getApiKey()`).
    async fn current_key(&self) -> Result<Option<String>, ProviderError> {
        match &self.reload {
            Some(source) => Ok(Some(source.key().await?)),
            None => Ok(None),
        }
    }

    /// `_doSend` up to the first answer: the cache to attach (made under `key`), the generate call, the replay
    /// without a cache the server refused, and the global location for a region that lacks the model.
    async fn exchange(&self, request: &Arc<ModelRequest>, key: Option<&str>) -> Result<Exchanged, ProviderError> {
        let mut queue = VecDeque::new();
        // An open model on Vertex AI (`_sendMaas`): the Chat Completions engine, no explicit cache.
        if let Some(model) = self.codec.maas_model(&request.model) {
            let mut response = self.dispatch_on(&*self.maas_http, &self.codec.maas_wire(request, &model, false)?).await?;
            let global = response.status == 404 && self.codec.falls_back_to_global(request);
            if global {
                response = self.dispatch_on(&*self.maas_http, &self.codec.maas_wire(request, &model, true)?).await?;
            }
            return Ok(Exchanged { response, queue, global });
        }
        // Claude (`_sendClaude`): an Anthropic request through streamRawPredict, no explicit cache.
        if let Some(model) = self.codec.claude_model(&request.model) {
            let mut response = self.dispatch(&self.codec.claude_wire(request, &model, false)?).await?;
            let global = response.status == 404 && self.codec.falls_back_to_global(request);
            if global {
                response = self.dispatch(&self.codec.claude_wire(request, &model, true)?).await?;
            }
            return Ok(Exchanged { response, queue, global });
        }
        // State changes reach the session only as stream events: Node persists
        // `providerState` from a delivered result alone (`ask-turn-settle.mjs:147`),
        // never from a failed send, so no error carries one.
        let inner = self.codec.build_inner(request)?;
        let cache = self.cache.as_ref().map(|cache| cache.keyed(key.unwrap_or_default()));
        let mut cached = self.cached_prefix(cache.as_ref(), request, &inner).await;
        if let Some(state) = cached.as_ref().and_then(|c| c.changed.clone()) {
            queue.push_back(Ok(StreamEvent::ProviderState(state)));
        }
        let created = cached.as_mut().map(|c| std::mem::take(&mut c.held));        let mut response = {
            let attach = cached.as_ref().map(|c| Attach { name: &c.name, state: &c.state });
            self.dispatch(&self.codec.wire(request, &inner, attach)?).await?
        };
        drop(created);
        // A cache the server refuses (gone, evicted, mismatched) is forgotten
        // here and in the session, and the request runs once without it: a 400/404
        // whose error names the cached content (`isGeminiCachedContentError`,
        // gemini.mjs:222-231). Any other refusal is the request's error.
        if let Some(attached) = cached.take().filter(|_| matches!(response.status, 400 | 404)) {
            // Read and replayed on the same turn of Node's event loop: the replay finds the refusal's socket busy.
            let (refused, held) = response.read_all_held().await?;
            if !names_cached_content(&refused.body, &attached.name) {
                return Err(self.codec.classify_for(&refused, request, false));
            }
            if let Some(cache) = &cache {
                cache.forget(&attached.name);
            }
            // Node drops only the `gemini` key; the other provider keys stay.
            let rest = request.options.provider_state.as_ref().map(|s| s.rest.clone()).unwrap_or_default();
            queue.push_back(Ok(StreamEvent::ProviderState(ProviderState { gemini: None, rest })));
            response = self.dispatch(&self.codec.wire(request, &inner, None)?).await?;
            drop(held);
        }
        // A region from the environment that lacks the model (404) is retried
        // once on global (`vertex-ai.mjs:325-327`).
        let mut global = false;
        if response.status == 404 && self.codec.falls_back_to_global(request) {
            global = true;
            response = self.dispatch(&self.codec.wire_at(request, &inner, None, true)?).await?;
        }
        Ok(Exchanged { response, queue, global })
    }

    async fn attempt_served(&self, request: Arc<ModelRequest>) -> Result<GoogleStream, ProviderError> {
        let key = self.current_key().await?;
        let mut request = request;
        let mut sent = self.exchange(&request, key.as_deref()).await?;
        // `GeminiProvider.send`: a typed 401 re-reads the provider's key, drops every cache made under the old one and
        // the session's saved cache, and sends the whole request once more when the re-read finds a key. A second
        // refusal surfaces as it is. The failed first exchange left nothing in the session (`sent.queue` is dropped).
        if sent.response.status == 401
            && let (Some(source), Some(old)) = (&self.reload, key.as_deref())
        {
            mixdog_rt::node_stderr!("[provider] Auth error, re-reading provider authentication...");
            if let Some(cache) = &self.cache {
                cache.keyed(old).forget_credential();
            }
            if let Ok(new) = source.reload().await {
                let held = request
                    .options
                    .provider_state
                    .as_ref()
                    .filter(|s| s.gemini.as_ref().is_some_and(|g| !g.cache_name.is_empty()));
                let mut again = (*request).clone();
                let mut dropped = None;
                if let Some(state) = held {
                    let state = ProviderState { gemini: None, rest: state.rest.clone() };
                    again.options.provider_state = Some(state.clone());
                    dropped = Some(Ok(StreamEvent::ProviderState(state)));
                }
                request = Arc::new(again);
                sent = self.exchange(&request, Some(&new)).await?;
                if let Some(dropped) = dropped {
                    sent.queue.push_front(dropped);
                }
            }
        }
        let Exchanged { response, queue, global } = sent;
        if !response.is_success() {
            let rejected = response.read_all().await?;
            return Err(self.codec.classify_for(&rejected, &request, global));
        }
        let watch = self.first_byte_window(&request).map(|(first_byte, idle_after_first_chunk)| StreamWatch {
            first_byte,
            idle: super::cache::policy::semantic_idle_ms(|name| (self.var)(name)).map(|ms| std::time::Duration::from_millis(ms as u64)),
            idle_after_first_chunk,
            label: self.codec.stream_label(),
        });
        let mut stream = GoogleStream::consume(response.body, self.codec.decoder_at(&request, global), watch);
        stream.queue = queue;
        // `gemini.mjs`'s answer check: an empty answer right after a tool result is the model's answer.
        stream.answer_required = true;
        stream.after_tool_result =
            request.messages.iter().rev().find(|m| m.role != Role::System).is_some_and(|m| m.role == Role::Tool);
        Ok(stream)
    }
}

impl GoogleAdapter {
    /// `firstByteTimeoutMs` of the route's `consumeGeminiRestStreamResponse`: `GEMINI_FIRST_BYTE_TIMEOUT_MS` on the
    /// Gemini API (`gemini.mjs:878`) and on Vertex AI, `VERTEX_FLEX_FIRST_CHUNK_TIMEOUT_MS` for a Flex send there
    /// (`vertex-ai.mjs:414`), and on Antigravity the first window of the model's family (`antigravityFirstBytePolicy`:
    /// `ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS` for `gemini-pro`, else the Gemini window). Claude and open models on
    /// Vertex AI stream through other consumers: none. With the window, whether the idle window waits for the first
    /// payload (`idleAfterFirstChunk`, a Vertex Flex send).
    fn first_byte_window(&self, request: &ModelRequest) -> Option<(std::time::Duration, bool)> {
        let get = |name: &str| (self.var)(name);
        let gemini = super::cache::policy::gemini_first_byte_ms(get);
        let ms = match self.codec.target() {
            Target::Gemini { .. } => gemini,
            Target::Vertex { .. } => {
                if self.codec.claude_model(&request.model).is_some() || self.codec.maas_model(&request.model).is_some() {
                    return None;
                }
                if super::serving::Tier::requested(request.options.model_parameters.as_ref()) == super::serving::Tier::Flex {
                    return Some((std::time::Duration::from_millis(570_000), true));
                }
                gemini
            }
            Target::Antigravity { .. } => {
                let roster = self.roster.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                // `antigravityModelFamily`: the record of the picker id, else the one sending under that wire id.
                let sends = |r: &&ModelRecord| match &r.wire {
                    Some(mixdog_core_api::domain::provider::WireIds::One(id)) => *id == request.model,
                    Some(mixdog_core_api::domain::provider::WireIds::Tiers(tiers)) => tiers.iter().any(|(_, id)| *id == request.model),
                    None => false,
                };
                let record = roster.iter().find(|r| r.id == request.model).or_else(|| roster.iter().find(sends));
                let pro = record.and_then(|r| r.family.as_deref()) == Some("gemini-pro");
                if pro { super::cache::policy::antigravity_first_byte_ms(get) } else { gemini }
            }
        };
        Some((std::time::Duration::from_millis(ms as u64), false))
    }
}

/// One Gemini-wire response body through its decoder (`consumeGeminiRestStreamResponse`): the decoder's events in
/// order, the first-byte and idle watchdogs, and a transport fault as the stream's failure.
pub struct GoogleStream {
    watchdogs: Option<Watchdogs>,
    body: Box<dyn BodyStream>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    /// The provider's answer check (`gemini.mjs`): a clean end without text or a call fails, unless the turn
    /// answers a tool result.
    answer_required: bool,
    after_tool_result: bool,
    produced_output: bool,
}

impl GoogleStream {
    /// The consumer over a response whose headers just arrived, under `watch` (its windows and label).
    pub fn consume(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>, watch: Option<StreamWatch>) -> Self {
        Self {
            watchdogs: watch.map(Watchdogs::arm),
            body,
            decoder,
            queue: VecDeque::new(),
            ended: false,
            answer_required: false,
            after_tool_result: false,
            produced_output: false,
        }
    }

    fn fail(&mut self, err: ProviderError) {
        self.ended = true;
        self.queue.push_back(Err(err));
    }

    fn push(&mut self, events: Vec<StreamEvent>) {
        // A read that decoded a payload re-arms the idle window (`resetIdle` on semantic progress only).
        if let Some(watchdogs) = &mut self.watchdogs
            && events.iter().any(|e| matches!(e, StreamEvent::ChunkProgress(_)))
        {
            watchdogs.payload();
            watchdogs.reset_idle();
        }
        for mut event in events {
            match &mut event {
                StreamEvent::TextDelta(_) | StreamEvent::ToolCallDone(_) => self.produced_output = true,
                StreamEvent::Completed { stop: None, .. }
                    if self.answer_required && !self.produced_output && !self.after_tool_result =>
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
            let next = match &self.watchdogs {
                Some(watchdogs) => match watchdogs.read(self.body.next()).await {
                    Ok(next) => next,
                    Err(phase) => {
                        let err = watchdogs.expired(phase, self.decoder.exposure());
                        self.fail(err);
                        continue;
                    }
                },
                None => self.body.next().await,
            };
            match next {
                Some(Ok(chunk)) => match self.decoder.feed(&chunk) {
                    Ok(events) => self.push(events),
                    Err(err) => self.fail(err),
                },
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    // Node reads the body through `fetch` (gemini-rest-stream), whose socket failure is undici's.
                    err.message = crate::transport::link::TERMINATED.to_owned();
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

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}
