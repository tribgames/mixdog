// Private names for existing callback/result shapes; representations are unchanged.
type SettingLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

use crate::transport::deadlines::GEMINI_MODELS;
use crate::transport::deadlines::MODEL_STREAM_FETCH;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::AttemptHandle;
use mixdog_core_api::domain::provider::Boundary;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RetryLine;
use mixdog_core_api::domain::provider::RetryLineStyle;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::SendEnd;
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

use super::auth::ApiKeyAuth;
use super::auth::Authorization;
use super::auth::RequestAuth;
use super::cache::layer::Ask;
use super::cache::layer::ExplicitCache;
use super::cache::policy::CacheRequest;
use super::codec::Attach;
use super::codec::GoogleCodec;
use super::codec::Target;
use super::decode::GeminiDecoder;
use super::maas::VertexModel;
use super::models;
use super::redirect;
use super::serving::Tier;
use super::serving::VertexAccount;
use crate::catalog::ListingLookup;
use crate::providers::connect::stream::decode_read;
use crate::providers::first_byte::FirstBytePolicy;
use crate::providers::first_byte::FirstByteSettings;
use crate::providers::first_byte::attempt_budget;
use crate::providers::first_byte::vertex_budget;
use crate::providers::first_byte::vertex_flex_budget;
use crate::providers::head_wait::FirstByteGate;
use crate::providers::key_source::ApiKeySource;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::model_driver::ModelCall;
use crate::transport::model_driver::ModelDriver;
use crate::transport::preconnect::Preconnect;
use mixdog_core_api::domain::provider::PhaseWindows;

pub struct GoogleAdapter {
    id: ProviderId,
    codec: GoogleCodec,
    policy: RetryPolicy,
    /// The policy of Vertex AI's open models ([`ProviderAdapter::retry_policy_for`]).
    maas_policy: RetryPolicy,
    /// The policy of Claude on Vertex AI.
    claude_policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    /// The transport of every model exchange: its phase deadlines are the driver's, and listings go through [`ModelDriver::aux`].
    driver: ModelDriver,
    /// An open model's sends: Node posts them through the OpenAI client (`vertex-ai-maas.mjs`, no default headers),
    /// whose head the SDK writes.
    maas_driver: ModelDriver,
    auth: Arc<dyn RequestAuth>,
    /// The account the codec's target was built for.
    identity: String,
    cache: Option<ExplicitCache>,
    /// The Gemini API's key as Node re-reads it after a typed 401 (`GeminiProvider.reloadApiKey`).
    reload: Option<Arc<dyn ApiKeySource>>,
    /// Antigravity's records that carry a `wire`: the one source of the route
    /// table, from the last listing or the catalog's restored snapshot.
    roster: Mutex<Vec<ModelRecord>>,
    /// Vertex Gemini's regional 404 fallback applies to the rest of that send, including its unary recovery.
    global_sends: Mutex<HashMap<String, (String, Tier)>>,
    gemini_sends: Mutex<HashMap<String, GeminiSend>>,
    /// Antigravity's roster file (`antigravity-oauth-models.json`), written after a live listing and read back after a
    /// restart.
    roster_cache: Option<super::roster_cache::RosterCache>,
    /// The metadata enrichment and picker sanitizer Gemini's listing ends with.
    lookup: ListingLookup,
    /// The Gemini API's socket warm-up (`preconnect(GEMINI_API_ORIGIN)`).
    preconnect: Option<Preconnect>,
    /// The process environment the stream windows resolve from (`resolveTimeoutMs`).
    var: Arc<SettingLookup>,
    /// The credential values this adapter's requests were sent with (the key, the bearer token), so a refusal that
    /// echoes one is read with it redacted. Each is the value a request carried, kept after a refresh replaces it.
    carried: Mutex<Vec<String>>,
    /// The first-byte windows and Antigravity's ladder, read from the environment as Node does.
    first_byte: FirstByteSettings,
    /// The resizer of a Claude request's images ([`crate::providers::anthropic::images`]).
    images: Option<crate::providers::anthropic::images::ImageFitter>,
    /// Vertex AI's last complete publisher listing, by publisher: what a listing that could not finish shows in its place.
    discovered: Mutex<HashMap<String, Vec<Value>>>,
}

/// The whole of one Vertex discovery attempt, inside the catalog's listing deadline with room to answer.
const VERTEX_DISCOVERY_BUDGET: std::time::Duration = crate::catalog::LIST_DEADLINE.saturating_sub(std::time::Duration::from_secs(1));

impl GoogleAdapter {
    pub fn new(codec: GoogleCodec, policy: RetryPolicy, http: Arc<dyn HttpSend>, auth: Arc<dyn RequestAuth>, identity: String) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id: codec.provider().clone(),
            codec,
            policy,
            maas_policy: crate::providers::compat::retry::unprofiled(),
            // The Anthropic rows; the loop replay of a spent cut is the Anthropic providers' own ladder, which this send does not run.
            claude_policy: RetryPolicy { stream_cut_loop_replay: false, ..crate::providers::anthropic::retry_policy(true) },
            keepalive: KeepaliveSchedule::SPEC,
            maas_driver: ModelDriver::new(Arc::new(
                crate::registry::gateway::GatewayHttp::new(http.clone()).through_sdk(crate::registry::gateway::Sdk::OpenAi, &[]),
            )),
            driver: ModelDriver::new(http),
            auth,
            identity,
            cache: None,
            reload: None,
            roster: Mutex::default(),
            global_sends: Mutex::default(),
            gemini_sends: Mutex::default(),
            roster_cache: None,
            lookup: ListingLookup::new(),
            preconnect: None,
            var: Arc::new(|name| std::env::var(name).ok()),
            carried: Mutex::default(),
            first_byte: FirstByteSettings::process(),
            images: None,
            discovered: Mutex::default(),
        }
    }

    /// Remembers the credential `authorization` puts on a request: its header values, and a bearer's token itself.
    fn note_carried(&self, authorization: &Authorization) {
        let mut carried = self.carried.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for (name, value) in &authorization.headers {
            if !["authorization", "x-goog-api-key", "x-api-key", "api-key"].iter().any(|own| name.eq_ignore_ascii_case(own)) {
                continue;
            }
            for secret in [value.as_str(), value.strip_prefix("Bearer ").unwrap_or(value)] {
                if !secret.is_empty() && !carried.iter().any(|known| known == secret) {
                    carried.push(secret.to_owned());
                }
            }
        }
    }

    /// A refusal with the credentials this adapter's requests carried redacted from its body, so no message built from
    /// it echoes one (a key or token a server repeats in its error text).
    fn scrubbed(&self, mut refusal: ErrorResponse) -> ErrorResponse {
        let carried = self.carried.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let secrets: Vec<&str> = carried.iter().map(String::as_str).collect();
        let text = String::from_utf8_lossy(&refusal.body);
        let clean = crate::oauth::scrub::scrub_oauth_secrets(&text, &secrets);
        if clean != text {
            refusal.body = clean.into_bytes();
        }
        refusal
    }

    /// The first-byte settings of this adapter, when they are not the process environment's. The retry `policy` it was built
    /// with must come from the same settings ([`super::policy::antigravity_with`]).
    pub fn with_first_byte(mut self, settings: FirstByteSettings) -> Self {
        self.first_byte = settings;
        self
    }

    /// Fits the images of Claude requests with `fitter`.
    pub fn with_images(mut self, fitter: Option<crate::providers::anthropic::images::ImageFitter>) -> Self {
        self.images = fitter;
        self
    }

    pub(crate) fn with_vertex_environment(mut self, env: Arc<dyn crate::registry::keys::Environment>) -> Self {
        self.codec = self.codec.with_env(env);
        self
    }

    /// Warms the Gemini API now, as `GeminiProvider`'s constructor does (`gemini.mjs:291`), and again before each send
    /// (`send`, `gemini.mjs:651`).
    /// The settings the adapter reads (its first-byte and idle windows) from `var` instead of the process environment.
    pub fn with_settings(mut self, var: Arc<SettingLookup>) -> Self {
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

    /// Gives the adapter its roster file; [`Self::restore_roster`] reads it.
    pub fn with_roster_cache(mut self, cache: super::roster_cache::RosterCache) -> Self {
        self.roster_cache = Some(cache);
        self
    }

    /// The last live roster, past its TTL as well (`antigravityCatalogModels`: sends never refresh it), seeds the route
    /// table; with no readable file the curated list stays the answer.
    pub async fn restore_roster(self) -> Self {
        if let Some(cache) = &self.roster_cache
            && let Some(records) = cache.load(true).await
        {
            self.set_roster(&records);
        }
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
        let pinned = models::xhigh_pin(&request.model);
        if model == request.model && effort == request.options.effort && !pinned {
            return request;
        }
        let mut routed = (*request).clone();
        routed.model = model;
        if effort != routed.options.effort || pinned {
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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

    fn reattachable_cache(&self, request: &ModelRequest, inner: &Value, key: Option<&str>) -> Result<Option<Cached>, ProviderError> {
        let sent = request
            .options
            .send_group
            .as_ref()
            .and_then(|group| self.gemini_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(group).cloned());
        if let (Some(sent), Some(key)) = (&sent, key)
            && sent.credential != super::cache::policy::credential_fingerprint(key)
        {
            let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
            error.reauth_required = true;
            error.message = "the credential changed during the request".into();
            return Err(unary_failure(error));
        }
        Ok(sent.and_then(|sent| sent.cached).filter(|cached| {
            let (Some(key), Some(cache), Some(ask)) = (key, &self.cache, Self::cache_ask(request, inner)) else { return false };
            cache.keyed(key).can_reattach(&cached.state, &ask)
        }))
    }

    fn cache_ask<'a>(request: &'a ModelRequest, inner: &'a Value) -> Option<Ask<'a>> {
        if !request.options.hosted_tools.is_empty() {
            return None;
        }
        let system = inner["systemInstruction"]["parts"][0]["text"].as_str().unwrap_or_default();
        let tools = inner["tools"].as_array().map(Vec::as_slice).unwrap_or_default();
        let contents = inner["contents"].as_array().map(Vec::as_slice).unwrap_or_default();
        Some(Ask {
            model: &request.model,
            request: CacheRequest { system_instruction: system, tools, tool_config: inner.get("toolConfig"), contents },
            state: request.options.provider_state.as_ref(),
            iteration: request.options.iteration,
            fork: request.options.shared_cache_prefix_count.is_some_and(|n| n > 0),
        })
    }

    async fn cached_prefix(&self, cache: Option<&ExplicitCache>, request: &ModelRequest, inner: &Value) -> Option<Cached> {
        let answer = cache?.ensure(Self::cache_ask(request, inner)?).await;
        let name = answer.cache_name?;
        let state = answer.state.as_ref().or(request.options.provider_state.as_ref()).and_then(|s| s.gemini.clone()).filter(|s| s.cache_name == name)?;
        Some(Cached { name, state, changed: answer.state })
    }

    /// One authorized model submission of `request`, with the single credential-recovery resend of a 401: each submission is
    /// its own attempt, with a fresh identity and the whole window, whatever came before it.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn dispatch(&self, request: &ModelRequest, wire: &WireRequest) -> Result<(HttpResponse, AttemptHandle), ProviderError> {
        self.dispatch_on(&self.driver, request, wire, false).await
    }

    /// The Gemini API key is read once for both cache selection and model dispatch. Other routes keep their own auth.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn dispatch_with_key(
        &self,
        request: &ModelRequest,
        wire: &WireRequest,
        key: Option<&str>,
        recovery: bool,
    ) -> Result<(HttpResponse, AttemptHandle), ProviderError> {
        let Some(key) = key else {
            return self.dispatch_on(&self.driver, request, wire, recovery).await;
        };
        let authorization = ApiKeyAuth::authorization(key.to_owned())?;
        self.check_identity(&authorization)?;
        self.note_carried(&authorization);
        self.send_authorized(&self.driver, request, wire, &authorization, recovery).await
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn dispatch_on(
        &self,
        driver: &ModelDriver,
        request: &ModelRequest,
        wire: &WireRequest,
        recovery: bool,
    ) -> Result<(HttpResponse, AttemptHandle), ProviderError> {
        let mut authorization = self.auth.authorize().await?;
        self.check_identity(&authorization)?;
        self.note_carried(&authorization);
        let mut sent = self.send_authorized(driver, request, wire, &authorization, recovery).await?;
        if sent.0.status == 401 && !crate::providers::compat::login::opencode_go::gateway_owns_auth_recovery() && self.auth.rejected(&authorization).await {
            authorization = self.auth.authorize().await?;
            self.check_identity(&authorization)?;
            self.note_carried(&authorization);
            sent = self.send_authorized(driver, request, wire, &authorization, recovery).await?;
        }
        Ok(sent)
    }

    /// The request with `authorization` as one attempt of the driver.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn send_authorized(
        &self,
        driver: &ModelDriver,
        request: &ModelRequest,
        wire: &WireRequest,
        authorization: &Authorization,
        recovery: bool,
    ) -> Result<(HttpResponse, AttemptHandle), ProviderError> {
        // Authorized and about to be written: the Vertex request-type header of this very request is its tier. Only Priority
        // is a premium speed; Flex is discounted and groups as standard.
        let priority = wire.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("X-Vertex-AI-LLM-Shared-Request-Type") && value == "priority");
        request.options.send_identity.note_dispatched_speed_tier(if priority { "priority" } else { "" });
        let sent = driver.send(&self.model_call(request, recovery), Self::authorized(wire, authorization), MODEL_STREAM_FETCH).await?;
        // The head, a refusal's too, tells the run the server is answering (`gemini.mjs:811`, `antigravity-transport.mjs:257`).
        request.options.send_identity.raise_stage("transport");
        Ok(sent)
    }

    /// One listing fetch: no credential recovery and no resend. Node's listing
    /// calls take whatever credential is current and report what comes back.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn fetch_listing(&self, wire: &WireRequest) -> Result<Vec<u8>, ProviderError> {
        let authorization = self.auth.authorize().await?;
        self.check_identity(&authorization)?;
        self.note_carried(&authorization);
        let response = self.driver.aux().send(Self::authorized(wire, &authorization), GEMINI_MODELS).await?;
        let succeeded = response.is_success();
        let read = response.read_all().await?;
        if !succeeded {
            return Err(self.codec.classify(&self.scrubbed(read)));
        }
        Ok(read.body)
    }

    /// Every `publisherModels[]` row of one publisher, following `nextPageToken`.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn publisher_models(&self, publisher: &str) -> Result<Vec<Value>, ProviderError> {
        let mut items = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let body = self.fetch_listing(&models::publisher_request(publisher, token.as_deref())).await?;
            let page = models::publisher_page(&body)?;
            items.extend(page.models);
            match page.next {
                Some(next) if token.as_deref() != Some(next.as_str()) => token = Some(next),
                _ => return Ok(items),
            }
        }
    }
}

impl GoogleAdapter {
    async fn vertex_listing(&self, place: &super::serving::VertexPlace) -> (Vec<ModelRecord>, bool) {
        // An express API key serves Gemini models only.
        let publishers: &[&'static str] = if place.account == VertexAccount::Express { &["google"] } else { &["google", "anthropic"] };
        let results = futures::future::join_all(publishers.iter().map(|&publisher| async move {
            let listed = crate::transport::deadlines::bounded(VERTEX_DISCOVERY_BUDGET, self.publisher_models(publisher)).await;
            let answer = match listed {
                Some(Ok(items)) => Some(items),
                Some(Err(error)) if error.kind == ErrorKind::Permission => Some(Vec::new()),
                Some(Err(_)) | None => None,
            };
            (publisher, answer)
        }))
        .await;
        let complete = results.iter().all(|(_, answer)| answer.is_some());
        let mut found: Vec<(&str, Value)> = Vec::new();
        {
            let mut kept = self.discovered.lock().unwrap_or_else(|e| e.into_inner());
            for (publisher, answer) in results {
                match answer {
                    Some(items) => {
                        kept.insert(publisher.to_owned(), items.clone());
                        found.extend(items.into_iter().map(|item| (publisher, item)));
                    }
                    None => found.extend(kept.get(publisher).into_iter().flatten().map(|item| (publisher, item.clone()))),
                }
            }
        }
        found.retain(|(publisher, item)| models::discovered_id(publisher, item).is_some_and(|id| self.codec.standard_send_accepted(id)));
        let table = models::vertex_table();
        let mut added = self.lookup.enrich_listed("vertex-ai", models::vertex_discovered(&found, &table));
        for record in &mut added {
            record.display_name.get_or_insert_with(|| record.id.clone());
        }
        // Dated snapshots, stale and non-chat rows go by the sanitizer's rules, judged beside the table's rows, which stay.
        let judged = self.lookup.sanitize_listed("vertex-ai", table.iter().chain(&added).cloned().collect());
        added.retain(|record| judged.iter().any(|kept| kept.id == record.id));
        let mut rows = table;
        rows.extend(added);
        (rows, complete)
    }
}

#[async_trait]
impl ModelListing for GoogleAdapter {
    async fn list_roster(&self) -> Result<mixdog_core_api::domain::provider::ListedRoster, ProviderError> {
        use mixdog_core_api::domain::provider::ListedRoster;
        use mixdog_core_api::domain::provider::Provenance;
        let (rows, provenance) = match self.codec.target() {
            // The table with what was found stands in for a discovery a publisher did not answer: the catalog shows
            // it stale and asks again when its backoff passes.
            Target::Vertex { place } => match self.vertex_listing(place).await {
                (rows, true) => (rows, Provenance::Fetched),
                (rows, false) => (rows, Provenance::Seed),
            },
            _ => (self.list_models().await?, Provenance::Fetched),
        };
        Ok(ListedRoster { rows, provenance, identity: Default::default() })
    }

    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        match self.codec.target() {
            // The fixed table plus what the Model Garden publisher listings add: the table at the least.
            Target::Vertex { place } => Ok(self.vertex_listing(place).await.0),
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
                // `listModels`: a roster within its TTL answers without a fetch and is not written again.
                if let Some(cache) = &self.roster_cache
                    && let Some(records) = cache.load(false).await
                {
                    self.set_roster(&records);
                    return Ok(records);
                }
                let body = self.fetch_listing(&models::antigravity_request(origin, project, &client_version.get())).await?;
                let records = models::antigravity_records(&body, self.codec.traits())?;
                self.set_roster(&records);
                if let Some(cache) = &self.roster_cache {
                    cache.save(&records).await;
                }
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
        let message = format!("{} is now served by Google as {} (redirect effective 2026-12-01; billed at {} rates)", self.requested, self.target, self.target);
        mixdog_rt::node_stderr!("[gemini] {message}");
        Some(StreamEvent::Notice { message, warn: true })
    }
}

#[derive(Clone)]
struct Cached {
    name: String,
    state: GeminiCacheState,
    /// `Some` when attaching changed the session's provider state.
    changed: Option<ProviderState>,
}

#[derive(Clone)]
struct GeminiSend {
    credential: String,
    cached: Option<Cached>,
}

/// `hasLongAdvice` (`gemini-retry-policy.mjs`): a server wait over 300 s on a kind a retry could change.
fn long_advice(failure: &ProviderError) -> bool {
    failure.retry_after.is_some_and(|wait| wait > super::policy::GEMINI_RETRY_ADVICE_LIMIT) && !failure.kind.is_deterministic()
}

/// The Gemini ladder ends its recovery on long advice, before or after the response opened (`runGeminiStreamAttempts`
/// marks it provider-terminal): no retry, no non-streaming re-issue, no loop ladder after it.
fn end_on_long_advice(failure: &mut ProviderError) {
    if long_advice(failure) {
        failure.recovery_exhausted = true;
        failure.recovery_terminal = true;
    }
}

/// `canFallbackNonStreaming` of the Gemini API: nothing of the failed stream reached the caller, no call was cut or
/// dispatched, it is transient, stalled or a truncated stream, and no long advice ended the recovery.
fn unary_recoverable(failure: &ProviderError) -> bool {
    let exposed = failure.unsafe_to_retry || failure.exposure.text_emitted || failure.exposure.tool_dispatched || failure.exposure.tool_input_cut;
    let transient = matches!(failure.kind, ErrorKind::Transient | ErrorKind::Overloaded)
        || failure.timed_out
        || failure.transport == Some(mixdog_core_api::domain::provider::TransportFault::TruncatedStream);
    !exposed
        && !failure.recovery_terminal
        && !long_advice(failure)
        && failure.code.as_deref() != Some("no_response_text")
        && !failure.kind.is_deterministic()
        && transient
}

fn unary_failure(mut error: ProviderError) -> ProviderError {
    end_on_long_advice(&mut error);
    if error.reauth_required || matches!(error.kind, ErrorKind::Policy | ErrorKind::Auth | ErrorKind::Permission) {
        error.recovery_terminal = true;
    }
    error
}

#[async_trait]
impl ProviderAdapter for GoogleAdapter {
    fn release_send(&self, group: &str) {
        self.global_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(group);
        self.gemini_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(group);
    }

    async fn settle_send(&self, group: &str, _end: SendEnd) {
        self.release_send(group);
    }
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

    fn send_stages(&self, model: &str) -> SendStages {
        let gemini_ladder = self.gemini_ladder(model);
        if !self.direct_gemini(model) {
            // Antigravity's attempt notes `model_thinking` once its request is on the wire (antigravity-transport.mjs:236).
            let model_thinking = matches!(self.codec.target(), Target::Antigravity { .. });
            let own = self.codec.maas_model(model).is_some();
            let each_attempt = model_thinking;
            return SendStages {
                preparing: u32::from(!each_attempt && !own),
                each_attempt,
                ladder_by_connection: gemini_ladder,
                reconnecting: !gemini_ladder,
                model_thinking,
                ..SendStages::default()
            };
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
    fn recovers_spent(&self, request: &ModelRequest, failure: &ProviderError) -> bool {
        let model = request.model.as_str();
        self.gemini_unary_supported(model) && (self.direct_gemini(model) || failure.delivery == DeliveryState::Accepted) && unary_recoverable(failure)
    }

    /// `[gemini] stream failed (<code, else message>); recovered via non-streaming generateContent` (gemini.mjs), as
    /// the broker writes it for its own sends.
    fn recovery_line(&self, _model: &str, failure: &ProviderError) -> Option<String> {
        let cause = crate::oauth::carried::remembered().redact_str(failure.code.as_deref().filter(|c| !c.is_empty()).unwrap_or(&failure.message));
        Some(format!("[gemini] stream failed ({cause}); recovered via non-streaming generateContent"))
    }

    /// Re-issue the generation on the same account and route, retaining a still-valid cache attachment.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let (request, redirect) = self.served(self.routed(request));
        if !self.gemini_unary_supported(&request.model) {
            return Err(super::request::invalid("This model does not support Gemini unary recovery"));
        }
        let inner = self.codec.build_inner(&request)?;
        let global = self.uses_global(&request);
        let key = self.current_key().await.map_err(unary_failure)?;
        let mut cached = self.reattachable_cache(&request, &inner, key.as_deref())?;
        let attach = cached.as_ref().map(|c| Attach { name: &c.name, state: &c.state });
        let streamed = self.codec.wire_at(&request, &inner, attach, global)?;
        let mut wire = streamed.clone();
        wire.url = wire.url.replacen(":streamGenerateContent?alt=sse", ":generateContent", 1);
        // One generation total over the head and the whole body: the recovery's attempt begins in it, and a head arriving
        // does not reset it.
        let (response, _) = self.dispatch_with_key(&request, &wire, key.as_deref(), true).await.map_err(unary_failure)?;
        let answered = self.scrubbed(response.read_all().await?);
        if !(200..300).contains(&answered.status.unwrap_or(0)) {
            if matches!(answered.status, Some(400 | 404))
                && let (Some(cache), Some(attached)) = (&self.cache, &cached)
                && names_cached_content(&answered.body, &attached.name)
            {
                cache.forget(&attached.name);
            }
            return Err(unary_failure(self.codec.classify_for(&answered, &request, global)));
        }
        let Some(payload) = serde_json::from_slice::<Value>(&answered.body).ok() else {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted));
        };
        let mut decoder = self.codec.gemini_decoder(&request);
        // A direct Gemini answer that ends `CONTINUATION` is the first hop of a long decode, whose next hops go back to the
        // stream with its token (`_doSend` resends through `_streamViaRest` whichever way a hop was answered).
        let continuation = match (&key, self.direct_gemini(&request.model)) {
            (Some(key), true) => Some(self.continuation(&request, streamed, key)?),
            _ => None,
        };
        // Decode the entire answer before returning any events: a refused unary answer must not dispatch tools.
        let (events, token) =
            if continuation.is_some() { decoder.unary_hop(payload).map_err(unary_failure)? } else { (decoder.unary(payload).map_err(unary_failure)?, None) };
        let mut stream = GoogleStream::with_decoder(Box::new(EmptyBody), Decoder::Gemini(Box::new(decoder)));
        stream.gemini_ladder = self.gemini_ladder(&request.model);
        stream.require_answer(&request);
        stream.publish_usage();
        if let Some(redirect) = redirect {
            stream.queue.push_back(Ok(StreamEvent::ServedModel(redirect.target.to_owned())));
        }
        if let Some(state) = cached.take().and_then(|c| c.changed) {
            stream.queue.push_back(Ok(StreamEvent::ProviderState(state)));
        }
        stream.push(events);
        match token {
            Some(token) => {
                stream.continuation = continuation;
                stream.continue_with(token).await;
            }
            None => stream.ended = true,
        }
        Ok(Box::new(stream))
    }

    fn first_response_budget(&self, model: &str, parameters: Option<&mixdog_protocol::JsonValue>) -> Option<FirstResponseBudget> {
        match self.codec.target() {
            // The Gemini API waits its one long window on each attempt of its request ladder.
            Target::Gemini { .. } => Some(attempt_budget(&self.first_byte_policy(model)?)),
            // A Vertex AI send waits the same window for its first chunk (a Flex route its own longer one); the head is not
            // marked, so the transport deadline covers both waits. Claude and open models stream through other consumers.
            Target::Vertex { .. } => {
                // A Flex send states its window whatever the model (Node's class states it from no model); a standard one only for
                // the Gemini models whose stream this adapter times.
                if Tier::requested(parameters) == Tier::Flex {
                    Some(vertex_flex_budget())
                } else if self.codec.claude_model(model).is_some() || self.codec.maas_model(model).is_some() {
                    None
                } else {
                    Some(vertex_budget(
                        crate::providers::first_byte::VERTEX_HEAD_BOUND_MS,
                        super::cache::policy::gemini_first_byte_ms(|name| (self.var)(name)) as i64,
                    ))
                }
            }
            Target::Antigravity { .. } => {
                let model = if model.is_empty() { models::DEFAULT_ANTIGRAVITY_MODEL } else { model };
                let family = models::antigravity_family(&self.roster.lock().unwrap_or_else(std::sync::PoisonError::into_inner), model);
                Some(attempt_budget(&self.first_byte.antigravity_policy(family.as_deref())))
            }
        }
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if let Some(preconnect) = &self.preconnect {
            preconnect.warm(super::codec::GEMINI_ORIGIN);
        }
        let (request, redirect) = self.served(self.routed(request));
        // `_servedModel` announces, and claims the once-per-process notice, before the request is built or sent:
        // a send that fails still showed it, and a later one does not show it again.
        let notice = redirect.as_ref().and_then(Redirect::announce);
        let model = request.model.clone();
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
                if self.gemini_ladder(&model) {
                    end_on_long_advice(&mut error);
                }
                Err(error)
            }
        }
    }
}

/// The unary answer has already been read and decoded.
struct EmptyBody;

#[async_trait]
impl BodyStream for EmptyBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        None
    }
}

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
    cached: Option<Cached>,
    /// The attempt of the submission that answered: its phase clock, which its stream publishes the response's boundaries on.
    attempt: AttemptHandle,
    /// The request the answering exchange sent, as the codec built it (credentials not yet added).
    wire: Option<WireRequest>,
}

/// `GEMINI_MAX_CONTINUATION_HOPS` (`gemini.mjs`): the requests one long-decode turn may make.
const MAX_CONTINUATION_HOPS: u32 = 32;

/// The wait before a continued hop is sent again, on the runtime's clock as every window of a provider is.
async fn retry_wait(delay: std::time::Duration) {
    mixdog_rt::Deadline::after(delay).bound(std::future::pending::<()>()).await;
}

fn continuation_limit() -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    err.code = Some("CONTINUATION_LIMIT".into());
    err.message = format!("Gemini long decode exceeded {MAX_CONTINUATION_HOPS} continuation hops");
    err
}

/// The resend of a long-decode turn (`gemini.mjs` `_doSend` loop): the same body plus the hop's continuation token, as a
/// fresh attempt of the same send, on the credential the first hop used.
struct Continuation {
    driver: ModelDriver,
    call: ModelCall,
    /// The hop's non-streaming re-issue (`_recoverGeminiNonStreaming`), under the recovery window.
    unary: ModelCall,
    wire: WireRequest,
    authorization: Authorization,
    request: Arc<ModelRequest>,
    /// The Gemini ladders each hop runs on its own (`_streamViaRest` runs `runGeminiStreamAttempts` per hop).
    policy: RetryPolicy,
    /// The hops requested, the first included.
    sent: u32,
    /// The hop being read, once the turn has continued.
    hop: Option<Hop>,
}

/// One continued hop: its token, the decoder as the hop began, and the hop's own attempt ladders.
struct Hop {
    token: String,
    start: Box<GeminiDecoder>,
    /// The hop showed output: a failure of it is past its own replay boundary.
    shown: bool,
    connect: mixdog_core_api::domain::retry::RetryState,
    stream: mixdog_core_api::domain::retry::RetryState,
}

impl Continuation {
    /// The next hop, from `start`, the decoder after the hop that ended with `token`.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn begin(&mut self, token: String, start: GeminiDecoder) -> Result<(), ProviderError> {
        use mixdog_core_api::domain::retry::{RetryClass, RetryState};
        if self.sent >= MAX_CONTINUATION_HOPS {
            return Err(continuation_limit());
        }
        self.sent += 1;
        let model = self.request.model.clone();
        self.hop = Some(Hop {
            token,
            start: Box::new(start),
            shown: false,
            connect: RetryState::new(RetryClass::Request, model.clone()),
            stream: RetryState::new(RetryClass::Midstream, model),
        });
        Ok(())
    }

    /// The hop's own verdict on its failure (`midstream`: after its response opened): the wait before it is sent again, or
    /// `None` when the failure ends the turn. A hop that showed output is never resent.
    fn retry(&mut self, err: &ProviderError, midstream: bool) -> Option<std::time::Duration> {
        use mixdog_core_api::domain::retry::{RetryDecider, Verdict};
        let hop = self.hop.as_mut().filter(|hop| !hop.shown)?;
        // The turn's exposure is the earlier hops'; this hop exposed nothing.
        let mut own = err.clone();
        own.exposure = mixdog_core_api::domain::provider::Exposure::default();
        let state = if midstream { &mut hop.stream } else { &mut hop.connect };
        let decision = crate::retry::StandardRetryDecider.verdict(&own, state, &self.policy, crate::retry::random_samples());
        *state = decision.next;
        match decision.verdict {
            Verdict::Retry { delay, .. } => Some(delay),
            _ => None,
        }
    }

    /// The streamed request with the hop's token.
    fn hop_wire(&self) -> WireRequest {
        let token = self.hop.as_ref().map(|hop| hop.token.clone()).unwrap_or_default();
        let mut body: Value = serde_json::from_slice(&self.wire.body).unwrap_or(Value::Null);
        body["continuationToken"] = Value::String(token);
        let mut wire = self.wire.clone();
        wire.body = serde_json::to_vec(&body).unwrap_or_default();
        wire
    }

    /// A refused head, with the credential redacted, as the route's typed failure.
    async fn refused(&self, response: HttpResponse, label: &'static str) -> ProviderError {
        let rejected = match response.read_all().await {
            Ok(rejected) => rejected,
            Err(err) => return err,
        };
        let carried: Vec<&str> = self.authorization.headers.iter().map(|(_, v)| v.as_str()).collect();
        let text = String::from_utf8_lossy(&rejected.body).into_owned();
        let mut rejected = rejected;
        rejected.body = crate::oauth::scrub::scrub_oauth_secrets(&text, &carried).into_bytes();
        super::error::classify(&rejected, &super::error::ErrorDialect::gemini(label), std::time::SystemTime::now())
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn send(&self) -> Result<(Box<dyn BodyStream>, AttemptHandle), ProviderError> {
        let wire = self.hop_wire();
        let (response, attempt) = self.driver.send(&self.call, GoogleAdapter::authorized(&wire, &self.authorization), MODEL_STREAM_FETCH).await?;
        self.request.options.send_identity.raise_stage("transport");
        if !response.is_success() {
            return Err(self.refused(response, "Gemini REST streamGenerateContent").await);
        }
        Ok((response.body, attempt))
    }

    /// The hop re-issued once as one `generateContent` call with its token (`_restGenerateContent`): the answer, or `None`
    /// when it fails or carries no candidate.
    async fn recover(&self) -> Option<Value> {
        let mut wire = self.hop_wire();
        wire.url = wire.url.replacen(":streamGenerateContent?alt=sse", ":generateContent", 1);
        let (response, _) = self.driver.send(&self.unary, GoogleAdapter::authorized(&wire, &self.authorization), MODEL_STREAM_FETCH).await.ok()?;
        if !response.is_success() {
            return None;
        }
        let answered = response.read_all().await.ok()?;
        let payload: Value = serde_json::from_slice(&answered.body).ok()?;
        payload.get("candidates").and_then(Value::as_array).is_some_and(|c| !c.is_empty()).then_some(payload)
    }
}

/// The next step of a continued hop.
enum HopStep {
    /// Send the hop.
    Open,
    /// The hop failed, before its response opened or after (`midstream`).
    Failed(ProviderError, bool),
}

impl GoogleAdapter {
    /// The long decode of a direct Gemini send whose first hop went out as `wire` (the streamed request) on `key`.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn continuation(&self, request: &Arc<ModelRequest>, wire: WireRequest, key: &str) -> Result<Continuation, ProviderError> {
        Ok(Continuation {
            driver: self.driver.clone(),
            call: self.model_call(request, false),
            unary: self.model_call(request, true),
            wire,
            authorization: ApiKeyAuth::authorization(key.to_owned())?,
            request: Arc::clone(request),
            policy: self.policy.clone(),
            sent: 1,
            hop: None,
        })
    }

    /// A Gemini model on the Gemini API or Vertex AI: the sends `runGeminiStreamAttempts` runs.
    fn gemini_ladder(&self, model: &str) -> bool {
        !matches!(self.codec.target(), Target::Antigravity { .. }) && self.codec.maas_model(model).is_none() && self.codec.claude_model(model).is_none()
    }

    /// A send to `model` on the Gemini API itself (`GeminiProvider`), not one of its other engines.
    fn direct_gemini(&self, model: &str) -> bool {
        matches!(self.codec.target(), Target::Gemini { .. }) && self.codec.maas_model(model).is_none() && self.codec.claude_model(model).is_none()
    }

    fn gemini_unary_supported(&self, model: &str) -> bool {
        self.direct_gemini(model)
            || matches!(self.codec.target(), Target::Vertex { .. }) && super::maas::vertex_model(model).is_ok_and(|m| m.wire == super::serving::Wire::Gemini)
    }

    fn uses_global(&self, request: &ModelRequest) -> bool {
        let tier = Tier::requested(request.options.model_parameters.as_ref());
        request.options.send_group.as_ref().is_some_and(|group| {
            self.global_sends
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(group)
                .is_some_and(|(model, sent_tier)| model == &request.model && *sent_tier == tier)
        })
    }

    fn clear_recovery_cache(&self, request: &ModelRequest) {
        if let Some(group) = &request.options.send_group
            && let Some(sent) = self.gemini_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(group)
        {
            sent.cached = None;
        }
    }

    /// The key the request is sent with, for the families that read one per send (`_getApiKey()`).
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn current_key(&self) -> Result<Option<String>, ProviderError> {
        match &self.reload {
            Some(source) => Ok(Some(source.key().await?)),
            None => Ok(None),
        }
    }

    /// The HTTP request of a Claude send: the API-key route's Messages body, its images fitted first.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn claude_fitted(&self, request: &ModelRequest, model: &VertexModel, global: bool) -> Result<WireRequest, ProviderError> {
        let wire = self.codec.claude_wire(request, model, global)?;
        match &self.images {
            Some(fitter) => fitter.fit_wire(request, wire).await,
            None => Ok(wire),
        }
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn exchange_maas(&self, request: &Arc<ModelRequest>, model: &VertexModel) -> Result<Exchanged, ProviderError> {
        self.auth.authorize().await?;
        request.options.send_identity.raise_stage("requesting");
        let (mut response, mut attempt) = self.dispatch_on(&self.maas_driver, request, &self.codec.maas_wire(request, model, false)?, false).await?;
        let global = response.status == 404 && self.codec.falls_back_to_global(request);
        if global {
            (response, attempt) = self.dispatch_on(&self.maas_driver, request, &self.codec.maas_wire(request, model, true)?, false).await?;
        }
        Ok(Exchanged { response, queue: VecDeque::new(), global, attempt, cached: None, wire: None })
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn exchange_claude(&self, request: &Arc<ModelRequest>, model: &VertexModel) -> Result<Exchanged, ProviderError> {
        let (mut response, mut attempt) = self.dispatch(request, &self.claude_fitted(request, model, false).await?).await?;
        let global = response.status == 404 && self.codec.falls_back_to_global(request);
        if global {
            (response, attempt) = self.dispatch(request, &self.claude_fitted(request, model, true).await?).await?;
        }
        Ok(Exchanged { response, queue: VecDeque::new(), global, attempt, cached: None, wire: None })
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn exchange(&self, request: &Arc<ModelRequest>, key: Option<&str>) -> Result<Exchanged, ProviderError> {
        if let Some(model) = self.codec.maas_model(&request.model) {
            return self.exchange_maas(request, &model).await;
        }
        if let Some(model) = self.codec.claude_model(&request.model) {
            return self.exchange_claude(request, &model).await;
        }
        let mut queue = VecDeque::new();
        let inner = self.codec.build_inner(request)?;
        let cache = self.cache.as_ref().map(|cache| cache.keyed(key.unwrap_or_default()));
        let mut cached = self.cached_prefix(cache.as_ref(), request, &inner).await;
        if let Some(state) = cached.as_ref().and_then(|c| c.changed.clone()) {
            queue.push_back(Ok(StreamEvent::ProviderState(state)));
        }
        let mut global = matches!(self.codec.target(), Target::Vertex { .. }) && self.uses_global(request);
        let mut wire = {
            let attach = cached.as_ref().map(|c| Attach { name: &c.name, state: &c.state });
            self.codec.wire_at(request, &inner, attach, global)?
        };
        let (mut response, mut attempt) = self.dispatch_with_key(request, &wire, key, false).await?;
        if matches!(response.status, 400 | 404)
            && let Some(attached) = cached.take()
        {
            let refused = response.read_all().await?;
            if !names_cached_content(&refused.body, &attached.name) {
                return Err(self.codec.classify_for(&refused, request, false));
            }
            if let Some(cache) = &cache {
                cache.forget(&attached.name);
            }
            self.clear_recovery_cache(request);
            // Node drops only the `gemini` key; the other provider keys stay.
            let rest = request.options.provider_state.as_ref().map(|s| s.rest.clone()).unwrap_or_default();
            queue.push_back(Ok(StreamEvent::ProviderState(ProviderState { gemini: None, rest })));
            wire = self.codec.wire(request, &inner, None)?;
            (response, attempt) = self.dispatch_with_key(request, &wire, key, false).await?;
        }
        // A region from the environment that lacks the model (404) is retried
        // once on global (`vertex-ai.mjs:325-327`).
        if !global && response.status == 404 && self.codec.falls_back_to_global(request) {
            global = true;
            if let Some(group) = &request.options.send_group {
                let tier = Tier::requested(request.options.model_parameters.as_ref());
                self.global_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(group.clone(), (request.model.clone(), tier));
            }
            wire = self.codec.wire_at(request, &inner, None, true)?;
            (response, attempt) = self.dispatch(request, &wire).await?;
        }
        Ok(Exchanged { response, queue, global, attempt, cached, wire: Some(wire) })
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn attempt_served(&self, mut request: Arc<ModelRequest>) -> Result<GoogleStream, ProviderError> {
        let mut key = self.current_key().await?;
        let mut sent = self.exchange(&request, key.as_deref()).await?;
        if sent.response.status == 401
            && let (Some(source), Some(old)) = (&self.reload, key.as_deref())
        {
            mixdog_rt::node_stderr!("[provider] Auth error, re-reading provider authentication...");
            if let Some(cache) = &self.cache {
                cache.keyed(old).forget_credential();
            }
            self.clear_recovery_cache(&request);
            if let Ok(new) = source.reload().await {
                let held = request.options.provider_state.as_ref().filter(|s| s.gemini.as_ref().is_some_and(|g| !g.cache_name.is_empty()));
                let mut again = (*request).clone();
                let mut dropped = None;
                if let Some(state) = held {
                    let state = ProviderState { gemini: None, rest: state.rest.clone() };
                    again.options.provider_state = Some(state.clone());
                    dropped = Some(Ok(StreamEvent::ProviderState(state)));
                }
                request = Arc::new(again);
                sent = self.exchange(&request, Some(&new)).await?;
                key = Some(new);
                if let Some(dropped) = dropped {
                    sent.queue.push_front(dropped);
                }
            }
        }
        let Exchanged { response, queue, global, attempt, cached, wire } = sent;
        if !response.is_success() {
            let rejected = self.scrubbed(response.read_all().await?);
            return Err(self.codec.classify_for(&rejected, &request, global));
        }
        if let (Some(group), Some(key)) = (&request.options.send_group, &key) {
            let sent = GeminiSend { credential: super::cache::policy::credential_fingerprint(key), cached };
            self.gemini_sends.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(group.clone(), sent);
        }
        let decoder = if self.codec.maas_model(&request.model).is_some() || self.codec.claude_model(&request.model).is_some() {
            Decoder::Other(self.codec.decoder_at(&request, global))
        } else {
            Decoder::Gemini(Box::new(self.codec.gemini_decoder(&request)))
        };
        let mut stream = GoogleStream::with_decoder(response.body, decoder).with_attempt(attempt.clone());
        stream.gemini_ladder = self.gemini_ladder(&request.model);
        stream.queue = queue;
        // Only the Gemini API itself long-decodes (`this._isDirectGeminiApi`).
        if self.direct_gemini(&request.model)
            && let (Some(wire), Some(key)) = (wire, &key)
        {
            stream.continuation = Some(self.continuation(&request, wire, key)?);
        }
        // `gemini.mjs`'s answer check: an empty answer right after a tool result is the model's answer.
        stream.require_answer(&request);
        Ok(stream)
    }
}

impl GoogleAdapter {
    fn first_byte_window(&self, request: &ModelRequest, gate: Option<&FirstByteGate>) -> Option<std::time::Duration> {
        if let Some(gate) = gate {
            return Some(gate.window());
        }
        let get = |name: &str| (self.var)(name);
        let gemini = super::cache::policy::gemini_first_byte_ms(get);
        let ms = match self.codec.target() {
            Target::Gemini { .. } | Target::Antigravity { .. } => gemini,
            Target::Vertex { .. } => {
                if self.codec.claude_model(&request.model).is_some() || self.codec.maas_model(&request.model).is_some() {
                    return None;
                }
                if super::serving::Tier::requested(request.options.model_parameters.as_ref()) == super::serving::Tier::Flex {
                    return Some(std::time::Duration::from_millis(570_000));
                }
                gemini
            }
        };
        Some(std::time::Duration::from_millis(ms as u64))
    }

    fn first_byte_policy(&self, model: &str) -> Option<FirstBytePolicy> {
        match self.codec.target() {
            Target::Gemini { .. } => self.direct_gemini(model).then(|| self.first_byte.gemini_policy()),
            Target::Vertex { .. } => None,
            Target::Antigravity { .. } => {
                let model = if model.is_empty() { models::DEFAULT_ANTIGRAVITY_MODEL } else { model };
                let family = models::antigravity_family(&self.roster.lock().unwrap_or_else(std::sync::PoisonError::into_inner), model);
                Some(self.first_byte.antigravity_policy(family.as_deref()))
            }
        }
    }
    /// The model submission of `request`: the windows this route declares for each phase (the common fallback policy fills the
    /// rest) and how an expiry of each reads. `MIXDOG_ENABLE_STREAM_WATCHDOG=0` drops the provider's idle policy and the fallback
    /// takes over: no phase is ever unbounded.
    fn model_call(&self, request: &ModelRequest, recovery: bool) -> ModelCall {
        let gate = self.first_byte_gate(request);
        let vertex = matches!(self.codec.target(), Target::Vertex { .. });
        let millis = |ms: i64| std::time::Duration::from_millis(u64::try_from(ms).unwrap_or(0));
        let head = match &gate {
            Some(gate) => Some(gate.window()),
            None => vertex.then(|| millis(crate::providers::first_byte::VERTEX_HEAD_BOUND_MS)),
        };
        let windows = PhaseWindows {
            head,
            payload: self.first_byte_window(request, gate.as_ref()),
            first_output: None,
            idle: super::cache::policy::semantic_idle_ms(|name| (self.var)(name)).map(|ms| std::time::Duration::from_millis(ms as u64)),
            recovery: Some(millis(self.first_byte.generate_total_ms)),
        };
        let label = self.codec.stream_label();
        let call = ModelCall::new(
            &request.options.send_identity,
            windows,
            Arc::new(move |expiry, delivery, exposure| super::watchdog::expired(label, gate.as_ref(), expiry, delivery, exposure)),
        );
        if recovery { call.recovery() } else { call }
    }

    /// The first-byte window of this attempt of the send ([`Self::first_byte_policy`]), counting against the send's first-byte timeouts.
    fn first_byte_gate(&self, request: &ModelRequest) -> Option<FirstByteGate> {
        let label = if matches!(self.codec.target(), Target::Antigravity { .. }) { "Antigravity" } else { "Gemini REST" };
        Some(FirstByteGate::of(&self.first_byte_policy(&request.model)?, &request.options.send_identity, label))
    }
}
enum Decoder {
    Gemini(Box<GeminiDecoder>),
    Other(Box<dyn WireDecoder>),
}

impl Decoder {
    fn wire(&mut self) -> &mut dyn WireDecoder {
        match self {
            Self::Gemini(d) => d.as_mut(),
            Self::Other(d) => d.as_mut(),
        }
    }
}

/// One response body through its decoder, with usage retained on terminal Gemini-wire failures.
pub struct GoogleStream {
    /// The attempt this stream answers, for the boundaries of its response.
    attempt: Option<AttemptHandle>,
    body: Box<dyn BodyStream>,
    decoder: Decoder,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    /// The provider's answer check (`gemini.mjs`): a clean end without text or a call fails, unless the turn
    /// answers a tool result.
    answer_required: bool,
    after_tool_result: bool,
    produced_output: bool,
    /// The long-decode resend of a direct Gemini send.
    continuation: Option<Continuation>,
    /// The send runs the Gemini ladder, whose recovery a long server wait ends ([`end_on_long_advice`]).
    gemini_ladder: bool,
}

impl GoogleStream {
    /// The consumer over a response whose headers just arrived. Its body is the driver's: the phase windows run there.
    pub fn consume(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self::with_decoder(body, Decoder::Other(decoder))
    }

    fn with_decoder(body: Box<dyn BodyStream>, decoder: Decoder) -> Self {
        Self {
            attempt: None,
            body,
            decoder,
            queue: VecDeque::new(),
            ended: false,
            answer_required: false,
            after_tool_result: false,
            produced_output: false,
            continuation: None,
            gemini_ladder: false,
        }
    }

    /// The attempt this stream answers: the boundaries of its response are reported on it.
    pub fn with_attempt(mut self, attempt: AttemptHandle) -> Self {
        self.attempt = Some(attempt);
        self
    }

    fn require_answer(&mut self, request: &ModelRequest) {
        self.answer_required = true;
        self.after_tool_result = request.messages.iter().rev().find(|m| m.role != Role::System).is_some_and(|m| m.role == Role::Tool);
        // The turn-wide check above judges the first hop; each continued hop is judged on its own answer.
        if let Decoder::Gemini(decoder) = &mut self.decoder {
            decoder.judge_hops(self.after_tool_result);
        }
    }

    fn fail(&mut self, mut err: ProviderError) {
        if let Decoder::Gemini(decoder) = &self.decoder {
            decoder.stamp_failure(&mut err);
        }
        if self.gemini_ladder {
            end_on_long_advice(&mut err);
        }
        self.ended = true;
        self.queue.push_back(Err(err));
    }

    fn publish_usage(&mut self) {
        if let Decoder::Gemini(decoder) = &mut self.decoder
            && let Some((usage, model)) = decoder.take_usage_update()
        {
            crate::registry::accounted::observe_attempt_usage(usage, model);
        }
    }

    /// A failure that ends the turn. After a continued hop, what the earlier hops showed is past the replay boundary
    /// (`carryGeminiHopsIntoFailure`), so the broker's retry and recovery see it.
    fn fail_turn(&mut self, mut err: ProviderError) {
        if self.continuation.as_ref().is_some_and(|c| c.hop.is_some()) {
            let turn = self.decoder.wire().exposure();
            err.exposure.text_emitted |= turn.text_emitted;
            err.exposure.tool_dispatched |= turn.tool_dispatched;
            err.unsafe_to_retry |= turn.text_emitted || turn.tool_dispatched;
        }
        self.fail(err);
    }

    /// A failure of the response being read: a continued hop takes it under its own ladders; any other ends the turn.
    async fn failed(&mut self, err: ProviderError) {
        if self.continuation.as_ref().is_some_and(|c| c.hop.is_some()) {
            self.advance(HopStep::Failed(err, true)).await;
        } else {
            self.fail_turn(err);
        }
    }

    /// The hop after the one that ended with `token`: begun from the decoder as it stands, then sent.
    async fn continue_with(&mut self, token: String) {
        let start = self.hop_start();
        match self.continuation.as_mut().expect("a long decode").begin(token, start) {
            Ok(()) => self.advance(HopStep::Open).await,
            Err(err) => self.fail_turn(err),
        }
    }

    /// The decoder back where the hop began; the discarded attempt's usage is booked apart, else carried in the turn.
    fn restart_hop(&mut self) {
        if let (Decoder::Gemini(decoder), Some(continuation)) = (&mut self.decoder, self.continuation.as_ref())
            && let Some(hop) = continuation.hop.as_ref()
        {
            let sent = &continuation.request.options.send_identity;
            decoder.restart_hop(&hop.start, |usage, model| crate::registry::accounted::note_abandoned_usage(usage, model, sent));
            // The observation follows the restored decoding down as well as up, to none when it holds none.
            crate::registry::accounted::reset_attempt_usage(decoder.settle_usage());
        }
    }

    /// Drives a continued hop until its response opens or the turn ends (`_streamViaRest` per hop): its request ladder
    /// before the response opens, its stream ladder after, which also re-asks an unusable answer, and once both are spent
    /// the one non-streaming re-issue with the token.
    async fn advance(&mut self, mut step: HopStep) {
        loop {
            step = match step {
                HopStep::Open => {
                    let continuation = self.continuation.as_mut().expect("a continued hop");
                    match continuation.send().await {
                        Ok((body, attempt)) => {
                            if let Some(hop) = continuation.hop.as_mut() {
                                // Each opening of the hop's stream starts a fresh request ladder (`runGeminiStreamAttempts`).
                                hop.connect = mixdog_core_api::domain::retry::RetryState::new(
                                    mixdog_core_api::domain::retry::RetryClass::Request,
                                    continuation.request.model.clone(),
                                );
                            }
                            self.body = body;
                            self.attempt = Some(attempt);
                            return;
                        }
                        Err(err) => HopStep::Failed(err, false),
                    }
                }
                HopStep::Failed(err, midstream) => match self.continuation.as_mut().and_then(|c| c.retry(&err, midstream)) {
                    Some(delay) => {
                        if midstream {
                            self.restart_hop();
                        }
                        retry_wait(delay).await;
                        HopStep::Open
                    }
                    None => {
                        let Some(token) = self.spent(err).await else { return };
                        let start = self.hop_start();
                        match self.continuation.as_mut().expect("a long decode").begin(token, start) {
                            Ok(()) => HopStep::Open,
                            Err(err) => {
                                self.fail_turn(err);
                                return;
                            }
                        }
                    }
                },
            };
        }
    }

    fn hop_start(&self) -> GeminiDecoder {
        match &self.decoder {
            Decoder::Gemini(decoder) => (**decoder).clone(),
            Decoder::Other(_) => unreachable!("only a Gemini decoder long-decodes"),
        }
    }

    async fn spent(&mut self, mut err: ProviderError) -> Option<String> {
        let Decoder::Gemini(decoder) = &mut self.decoder else {
            self.fail_turn(err);
            return None;
        };
        if decoder.hop_invalid() {
            // The re-asks are spent: the hop's answer is judged as final, which an unusable one fails.
            decoder.last_ask();
            let decoded = decoder.finish();
            self.publish_usage();
            match decoded {
                Ok(events) => {
                    self.ended = true;
                    self.push(events);
                }
                Err(err) => self.fail_turn(err),
            }
            return None;
        }
        let mut own = err.clone();
        own.exposure = mixdog_core_api::domain::provider::Exposure::default();
        let shown = self.continuation.as_ref().and_then(|c| c.hop.as_ref()).is_none_or(|hop| hop.shown);
        if shown || !unary_recoverable(&own) {
            self.fail_turn(err);
            return None;
        }
        self.restart_hop();
        // The rollback booked the failed attempt's usage on its own; the turn's failure carries what is left.
        err.partial_usage = None;
        err.partial_model = None;
        let continuation = self.continuation.as_ref().expect("a continued hop");
        let Some(payload) = continuation.recover().await else {
            err.recovery_exhausted = true;
            self.fail_turn(err);
            return None;
        };
        let Decoder::Gemini(decoder) = &mut self.decoder else { unreachable!("checked above") };
        // The re-issued answer is the hop's: never re-asked, and judged by the merged turn's finish alone
        // (`geminiIncompleteError`), so a malformed finish fails and an empty `STOP` completes with the earlier text.
        let decoded = decoder.unary_hop(payload);
        self.publish_usage();
        match decoded {
            Ok((events, token)) => {
                self.ended = token.is_none();
                self.push(events);
                token
            }
            Err(err) => {
                self.fail_turn(err);
                None
            }
        }
    }

    fn push(&mut self, events: Vec<StreamEvent>) {
        if let Some(hop) = self.continuation.as_mut().and_then(|c| c.hop.as_mut())
            && events.iter().any(|event| !matches!(event, StreamEvent::ChunkProgress(_) | StreamEvent::ProviderKeepalive | StreamEvent::Usage(_)))
        {
            hop.shown = true;
        }
        if let Some(attempt) = &self.attempt {
            let chunked = events.iter().any(|event| matches!(event, StreamEvent::ChunkProgress(_)));
            if chunked || events.iter().any(|event| !matches!(event, StreamEvent::ProviderKeepalive)) {
                attempt.observe(Boundary::FirstProtocolPayload);
            }
            let semantic = if chunked {
                events.iter().any(|event| matches!(event, StreamEvent::ChunkProgress(Some(_))))
            } else {
                events.iter().any(crate::providers::idle::output)
            };
            if semantic {
                attempt.observe(Boundary::FirstSemanticOutput);
            }
        }
        for mut event in events {
            match &mut event {
                StreamEvent::TextDelta(_) | StreamEvent::ToolCallDone(_) => self.produced_output = true,
                StreamEvent::Completed { stop: None, .. } if self.answer_required && !self.produced_output && !self.after_tool_result => {
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
                Some(Ok(chunk)) => {
                    let decoded = decode_read(self.decoder.wire(), Some(&chunk));
                    // The response ended: a consumer that stops at a completion decoded before the body's end drops the
                    // body, which is read off then.
                    if self.decoder.wire().terminal_seen() {
                        self.body.drain_on_drop();
                    }
                    self.publish_usage();
                    match decoded {
                        Ok((events, held)) => {
                            self.push(events);
                            if let Some(err) = held {
                                self.failed(err).await;
                            }
                        }
                        Err(err) => self.failed(err).await,
                    }
                }
                Some(Err(fault)) => {
                    // A phase deadline of the driver ended the body: its one failure, as the adapter classified it.
                    let exposure = self.decoder.wire().exposure();
                    let err = self.body.expired(exposure).unwrap_or_else(|| {
                        let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                        // Node reads the body through `fetch` (gemini-rest-stream), whose socket failure is undici's.
                        err.message = crate::transport::link::TERMINATED.to_owned();
                        err.exposure = exposure;
                        err.connection = self.body.connection();
                        err
                    });
                    self.failed(err).await;
                }
                None => {
                    if let (Decoder::Gemini(decoder), true) = (&mut self.decoder, self.continuation.is_some()) {
                        match decoder.end_hop() {
                            Err(err) => {
                                self.publish_usage();
                                self.failed(err).await;
                                continue;
                            }
                            Ok((events, Some(token))) => {
                                self.publish_usage();
                                self.push(events);
                                self.continue_with(token).await;
                                continue;
                            }
                            Ok((events, None)) => self.push(events),
                        }
                    }
                    let decoded = decode_read(self.decoder.wire(), None);
                    self.publish_usage();
                    match decoded {
                        Ok((events, None)) => {
                            self.ended = true;
                            self.push(events);
                        }
                        Ok((events, Some(err))) => {
                            self.push(events);
                            self.failed(err).await;
                        }
                        Err(err) => self.failed(err).await,
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
#[path = "continuation_tests.rs"]
mod continuation_tests;

#[cfg(test)]
mod held_failure_tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::ToolDefinition;

    use super::super::decode::DecodeDialect;
    use super::super::decode::UsageStyle;
    use super::super::error::ErrorDialect;
    use super::super::serving::Wire;
    use super::*;
    use crate::providers::connect::stream::tests::Scripted;
    use crate::providers::connect::stream::tests::read_out;

    /// A failure a Google route's decoder holds back behind events ends the turn as itself: a Gemini refusal behind text
    /// of the same read, though the body stays open until the stall deadline ends it, and the filter that stopped an open
    /// model's turn, behind the held-back text the body's end flushes.
    #[tokio::test]
    async fn a_failure_held_behind_events_ends_the_turn_as_itself() {
        let gemini = GeminiDecoder::new(DecodeDialect {
            owner: ProviderId::from("gemini"),
            envelope: false,
            usage: UsageStyle::Inclusive,
            errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
        });
        let body = Scripted::stalling(&[concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n",
            "data: {\"error\":{\"code\":403,\"message\":\"denied\",\"status\":\"PERMISSION_DENIED\"}}\n\n",
        )]);
        let mut stream = GoogleStream::with_decoder(Box::new(body), Decoder::Gemini(Box::new(gemini)));
        let (events, failure) = read_out(&mut stream).await;
        assert!(events.contains(&StreamEvent::TextDelta("Hi".into())));
        let failure = failure.expect("the refusal");
        assert_eq!((failure.status, failure.timed_out), (Some(403), false));

        let request = ModelRequest {
            model: "deepseek-ai/deepseek-v3".into(),
            messages: vec![Message::new(Role::User, Content::Text("Look it up.".into()))],
            tools: vec![ToolDefinition {
                name: "lookup".into(),
                description: "Read a value".into(),
                input_schema: serde_json::json!({"type": "object"}),
                defer_loading: false,
                freeform: None,
            }],
            options: Default::default(),
        };
        let model = VertexModel { publisher: "deepseek-ai".into(), id: "deepseek-v3".into(), wire: Wire::Maas };
        let body = Scripted::ending(&["data: {\"choices\":[{\"delta\":{\"content\":\"Hi <invo\"},\"finish_reason\":\"content_filter\"}]}\n\n"]);
        let mut stream = GoogleStream::consume(Box::new(body), Box::new(super::super::maas::decoder(&request, &model)));
        let (events, failure) = read_out(&mut stream).await;
        let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(text, "Hi <invo");
        assert_eq!(failure.expect("the filter").code.as_deref(), Some("PROVIDER_INCOMPLETE"));
    }
}
