use crate::transport::deadlines::MODEL_STREAM;
use crate::transport::deadlines::compat_model_list;
use crate::transport::model_driver::Expiry;
use crate::transport::model_driver::ModelCall;
use crate::transport::model_driver::ModelDriver;
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelRequest, ModelStream, ProviderAdapter, ProviderError, StreamEvent, WireCodec, WireDecoder, WireRequest,
};
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
        let run = chars[i..].iter().zip(&key).take_while(|(a, b)| a == b).count();
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

/// What the router is told about a model that the profile cannot know: the
/// user's per-model wires (`modelWires`) and the catalog's wire for a model.
#[derive(Clone, Default)]
pub struct RouteInputs {
    pub model_wires: HashMap<String, Wire>,
    pub catalog: Option<Arc<dyn ModelTraits>>,
}

#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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

#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
async fn fetch_listing(
    http: &dyn HttpSend,
    profile: &CompatProfile,
    url: String,
    headers: Vec<(String, String)>,
    key: Option<&str>,
) -> Result<serde_json::Value, ProviderError> {
    let final_url = url.clone();
    let response = http
        .send(
            WireRequest { transport: mixdog_core_api::domain::keepalive::TransportKind::Http1, method: "GET".into(), url, headers, body: Vec::new() },
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
    // Every listing path Node throws on, each with its own text.
    let path = || url::Url::parse(&final_url).map(|u| u.path().to_owned()).unwrap_or_default();
    match serde_json::from_slice::<serde_json::Value>(&body.body) {
        // Command Code's `requestCommandCodeJson`: a body that does not parse names the path.
        Err(_) if profile.id == "command-code-oauth" => {
            let mut err = ProviderError::new(ErrorKind::Unknown, mixdog_core_api::domain::provider::DeliveryState::Accepted);
            err.message = format!("[command-code-oauth] {} returned invalid JSON", path());
            Err(err)
        }
        // OpenCode Go's `consoleGetJson`: a body that does not parse, or is `null`, is a failure naming the status.
        Err(_) | Ok(serde_json::Value::Null) if profile.id == "opencode-go-oauth" => {
            let text = String::from_utf8_lossy(&body.body);
            let secrets: Vec<&str> = key.into_iter().collect();
            let scrubbed = crate::oauth::scrub::scrub_oauth_secrets(&text, &secrets);
            let detail = mixdog_js::slice_utf16(mixdog_js::js_trim(&scrubbed), 300);
            let mut err = ProviderError::new(ErrorKind::Unknown, mixdog_core_api::domain::provider::DeliveryState::Accepted);
            err.status = Some(200);
            err.message = format!("[opencode-go-oauth] {} 200{}", path(), if detail.is_empty() { String::new() } else { format!(": {detail}") });
            Err(err)
        }
        // `fetchCompatModelItems` (every other gateway, MiMo and Muse Code included) awaits `res.json()`.
        Err(_) => super::listing::json_answer(&body.body),
        Ok(value) => Ok(value),
    }
}

/// The failure of `expiry` for this provider's stream: the first-byte phases are the gate's (counted against the send, once: the
/// driver calls this once per expiry); the first-output and idle windows are the stream stall (`streamStalledError`,
/// `stall-policy.mjs:161`: `ESTREAMSTALL`, transient, phase `idle`, unsafe to retry once a tool call was dispatched); the
/// recovery's generation total is the re-issue's own timeout.
fn expired(
    label: &str,
    gate: Option<&crate::providers::head_wait::FirstByteGate>,
    expiry: Expiry,
    delivery: DeliveryState,
    exposure: Exposure,
) -> ProviderError {
    let ms = expiry.window.as_millis();
    let mut err = ProviderError::new(ErrorKind::Transient, delivery);
    err.timed_out = true;
    err.exposure = exposure;
    match expiry.phase {
        AttemptPhase::Connect | AttemptPhase::Head | AttemptPhase::Payload => {
            let phase = if expiry.phase == AttemptPhase::Payload { StreamTimeoutPhase::FirstChunk } else { StreamTimeoutPhase::Headers };
            match gate {
                Some(gate) => return gate.expired(phase, delivery, exposure),
                None => {
                    err.code = Some("EPROVIDERTIMEOUT".into());
                    err.message = format!("{label} first byte timed out after {ms}ms");
                    err.timeout_phase = Some(phase);
                }
            }
        }
        AttemptPhase::Recovery => {
            err.code = Some("EPROVIDERTIMEOUT".into());
            err.message = format!("{label} non-streaming fallback timed out after {ms}ms");
        }
        AttemptPhase::FirstOutput | AttemptPhase::Idle | AttemptPhase::Retired => {
            err.code = Some("ESTREAMSTALL".into());
            err.message = format!("{label} SSE idle stream timed out after {ms}ms of inactivity");
            mixdog_rt::node_stderr!("[provider-stall] {} (tool dispatched: {})", err.message, exposure.tool_dispatched);
            err.timeout_phase = Some(StreamTimeoutPhase::Idle);
            err.unsafe_to_retry = exposure.tool_dispatched;
        }
    }
    err
}

/// The first-byte gate of a stream on the shared window (`PROVIDER_FIRST_BYTE_TIMEOUT_MS`), every timeout left to the
/// provider's ordinary ladder.
pub(crate) fn shared_first_byte_gate(
    settings: &crate::providers::first_byte::FirstByteSettings,
    identity: &mixdog_core_api::domain::provider::SendIdentity,
    label: String,
) -> crate::providers::head_wait::FirstByteGate {
    let policy = crate::providers::first_byte::FirstBytePolicy { timeout_ms: settings.provider_ms, max_ms: settings.max_before_warn_ms, retries: None };
    crate::providers::head_wait::FirstByteGate::of(&policy, identity, label)
}

/// The model submission of an OpenAI-compatible stream labelled `label` (Chat Completions or Responses, and the streams that
/// Node consumed as one): the head and first payload under `gate`'s first-byte window, the first output and idle windows of
/// `settings` (`consumeCompatChatCompletionStream` / `consumeCompatResponsesStream`), and a `recovery`'s generation total.
pub(crate) fn stream_call(
    label: String,
    settings: &crate::providers::first_byte::FirstByteSettings,
    identity: &mixdog_core_api::domain::provider::SendIdentity,
    gate: Option<crate::providers::head_wait::FirstByteGate>,
    recovery: bool,
) -> ModelCall {
    let millis = |ms: i64| std::time::Duration::from_millis(u64::try_from(ms).unwrap_or(0));
    let windows = PhaseWindows {
        head: gate.as_ref().map(crate::providers::head_wait::FirstByteGate::window),
        payload: None,
        first_output: settings.first_output_ms.map(millis),
        idle: settings.semantic_idle_ms.map(millis),
        recovery: Some(millis(settings.generate_total_ms)),
    };
    let call = ModelCall::new(identity, windows, Arc::new(move |expiry, delivery, exposure| expired(&label, gate.as_ref(), expiry, delivery, exposure)));
    if recovery { call.recovery() } else { call }
}

/// What a read's events say about `attempt`: a whole protocol record is the first payload (a decoder that reports none, the
/// Responses wire, is taken at its first event that is not a keepalive); output starts the idle window and later output, or an
/// item boundary after it, renews it; keepalives and metadata do neither. `had_output` is the stream's own record of output.
pub(crate) fn report_progress(
    attempt: &mixdog_core_api::domain::provider::AttemptHandle,
    decoder: &dyn WireDecoder,
    events: &[StreamEvent],
    had_output: &mut bool,
) {
    if decoder.payload_seen() || events.iter().any(|e| !matches!(e, StreamEvent::ProviderKeepalive)) {
        attempt.observe(mixdog_core_api::domain::provider::Boundary::FirstProtocolPayload);
    }
    let produced = events.iter().any(crate::providers::idle::output);
    if produced || (*had_output && events.iter().any(crate::providers::idle::boundary)) {
        attempt.observe(mixdog_core_api::domain::provider::Boundary::FirstSemanticOutput);
    }
    *had_output |= produced;
}

struct CompatStream {
    body: Option<Box<dyn BodyStream>>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// The attempt this stream answers: the first payload and the semantic progress are reported on it, and the driver follows
    /// the deadlines they install.
    attempt: Option<mixdog_core_api::domain::provider::AttemptHandle>,
    /// Output has come: later item boundaries are semantic progress that renews the idle window.
    had_output: bool,
}

impl CompatStream {
    fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self { body: Some(body), decoder, queue: VecDeque::new(), failed: None, attempt: None, had_output: false }
    }

    fn with_attempt(mut self, attempt: mixdog_core_api::domain::provider::AttemptHandle) -> Self {
        self.attempt = Some(attempt);
        self
    }

    fn report(&mut self, events: &[StreamEvent]) {
        let Some(attempt) = &self.attempt else { return };
        report_progress(attempt, self.decoder.as_ref(), events, &mut self.had_output);
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
                    Ok(events) => {
                        self.report(&events);
                        self.queue.extend(events);
                        // A failure the decoder holds behind this read's events surfaces after them, not after the next read: a
                        // timeout must not replace a refusal that was already decoded.
                        if let Err(err) = self.decoder.feed(&[]) {
                            self.body = None;
                            self.failed = Some(err);
                        }
                    }
                    Err(err) => {
                        self.body = None;
                        self.failed = Some(err);
                    }
                },
                Some(Err(fault)) => {
                    // A phase deadline of the driver ended the body: its one failure, as classified above.
                    let timed = body.expired(self.decoder.exposure());
                    let connection = body.connection();
                    self.body = None;
                    let mut failure = timed.unwrap_or_else(|| {
                        let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                        err.connection = connection;
                        // Node reads the body through the OpenAI SDK's `fetch` (`consumeCompatChatCompletionStream`), whose
                        // socket failure mid-body is undici's `TypeError: terminated`.
                        err.message = crate::transport::link::TERMINATED.to_owned();
                        err.exposure = self.decoder.exposure();
                        err
                    });
                    self.decoder.attach_observed_usage(&mut failure);
                    self.failed = Some(failure);
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

    /// A model list whose endpoint never answers ends in a failure after its own timer, never hangs and never lists
    /// nothing.
    #[tokio::test(start_paused = true)]
    async fn a_model_list_that_outlives_its_timer_fails() {
        let transport = crate::transport::timeout_probe::NeverAnswers::new();
        let profile = CompatProfile::plain("groq", "http://x.test/v1", CredentialKind::Keyless);
        let error = fetch_json(transport.as_ref(), &profile, "http://x.test/v1/models".to_owned(), &[], None).await.expect_err("the endpoint never answers");
        assert!(!error.message.is_empty());
        transport.assert_each_request_was_bounded(1);
    }

    /// A model list that outlives its timer reads as the real Node function did (`sites.compatModelList`): the
    /// labelled `"<provider> model list"` timer.
    #[tokio::test(start_paused = true)]
    async fn a_model_list_that_outlives_its_timer_reads_as_nodes() {
        let transport = TimingOut::new();
        let profile = CompatProfile::plain("groq", "http://x.test/v1", CredentialKind::Keyless);
        let error = fetch_json(transport.as_ref(), &profile, "http://x.test/v1/models".to_owned(), &[], None).await.expect_err("the endpoint never answers");
        assert_transport("compatModelList", &transport);
        assert_thrown("compatModelList", &error.message);
    }

    /// A 200 that is not JSON is a thrown error on every listing path Node has, each in its own words: Command Code's
    /// `requestCommandCodeJson` names the path, OpenCode Go's `consoleGetJson` the status, the rest `res.json()`'s
    /// `SyntaxError`; none lists nothing.
    #[tokio::test]
    async fn a_listing_body_that_is_not_json_throws_on_every_path_with_nodes_text() {
        use crate::providers::listing_row::testing::Replay;
        let page = Replay::new(|_| (200, b"<html>no</html>".to_vec()));
        let fetch = |profile: CompatProfile, url: &str| {
            let url = url.to_owned();
            let page = &page;
            async move { fetch_json(page, &profile, url, &[], Some("k")).await.expect_err("not JSON").into_message() }
        };
        assert_eq!(
            fetch(CompatProfile::command_code_oauth(), "https://api.commandcode.ai/provider/v1/models").await,
            "[command-code-oauth] /provider/v1/models returned invalid JSON"
        );
        assert_eq!(fetch(CompatProfile::opencode_go(), "https://opencode.ai/api/config").await, "[opencode-go-oauth] /api/config 200: <html>no</html>");
        for profile in [CompatProfile::mimo_oauth(), CompatProfile::muse_code_oauth()] {
            let message = fetch(profile, "https://x.test/v1/models").await;
            assert!(message.contains("Unexpected token '<', \"<html>no</html>\" is not valid JSON"), "{message}");
        }
    }
}

pub struct CompatAdapter {
    id: ProviderId,
    pub(super) codec: CompatChatCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    /// The transport of everything that is not a model attempt (listings, pairing): timed by each call's own `Exchange`.
    pub(super) http: Arc<dyn HttpSend>,
    /// The transport of every model exchange: its phase deadlines are the driver's.
    driver: ModelDriver,
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
impl CompatAdapter {
    pub fn profile(&self) -> &CompatProfile {
        self.codec.profile()
    }

    pub fn with_routing(mut self, routing: RouteInputs) -> Self {
        self.routing = routing;
        self
    }

    pub fn new(codec: CompatChatCodec, http: Arc<dyn HttpSend>, key: Option<Arc<dyn ApiKeySource>>) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        let profile = codec.profile();
        debug_assert_eq!(key.is_none(), profile.credential == CredentialKind::Keyless, "a keyless profile has no key source and a keyed one has");
        Self {
            id: ProviderId::from(profile.id),
            policy: profile.retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            codec,
            driver: ModelDriver::new(http.clone()),
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
            request.headers.push(("authorization".into(), format!("Bearer {key}")));
        }
        request
    }

    pub(super) async fn routed_key(&self) -> Result<(Option<String>, Option<String>), ProviderError> {
        match &self.key {
            Some(source) => source.routed_key(true).await.map(|(key, base)| (Some(key), base)),
            None => Ok((None, None)),
        }
    }

    pub(super) fn route_url(&self, url: &mut String, base: Option<&str>) {
        if let Some(base) = base
            && let Some(path) = url.strip_prefix(self.codec.base_url()).filter(|path| path.starts_with('/'))
        {
            *url = format!("{}{path}", base.trim_end_matches('/'));
        }
    }

    /// Whether a rejected key may change under us (a static config key can be
    /// edited; a login-issued key needs a new login instead).
    fn reloadable(profile: &CompatProfile) -> bool {
        profile.credential == CredentialKind::StaticKey { reauth_on_401: false } && !super::login::opencode_go::gateway_owns_auth_recovery()
    }

    pub(crate) fn opencode_auth(&self) -> Option<&super::login::opencode_go::OpenCodeGoAuth> {
        self.key.as_ref()?.opencode_auth()
    }

    pub(crate) async fn gateway_key(&self) -> Result<Option<String>, ProviderError> {
        match &self.key {
            Some(key) => key.key().await.map(Some),
            None => Ok(None),
        }
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

    /// `compatFirstResponseBudget(this.name, chatProfile)`: a profile with a first-byte window of its own (Mimo's 285 s) declares it:
    /// one attempt's head wait and the same window again for its first payload, never Node's sum over the retry ladder (the
    /// watchdog's clock restarts with every attempt); one on the shared window leaves the watchdog's default.
    fn first_response_budget(
        &self,
        _model: &str,
        _parameters: Option<&mixdog_protocol::JsonValue>,
    ) -> Option<mixdog_core_api::domain::provider::FirstResponseBudget> {
        let policy = self.first_byte.compat(self.profile().chat.first_byte?);
        Some(crate::providers::first_byte::attempt_budget(&policy))
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
    fn recovers_spent(&self, _request: &ModelRequest, failure: &ProviderError) -> bool {
        let exposed = failure.unsafe_to_retry || failure.exposure.text_emitted || failure.exposure.tool_dispatched || failure.exposure.tool_input_cut;
        let transient = matches!(failure.kind, ErrorKind::Transient | ErrorKind::Overloaded)
            || failure.timed_out
            || failure.transport == Some(mixdog_core_api::domain::provider::TransportFault::TruncatedStream);
        !exposed && !failure.recovery_terminal && transient
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
        let (key, base) = self.routed_key().await?;
        self.route_url(&mut wire.url, base.as_deref());
        request.options.send_identity.raise_stage("requesting");
        // A non-streaming call answers only when the generation is done, so the first-byte windows would cut it falsely: its
        // one bound is `PROVIDER_GENERATE_TOTAL_TIMEOUT_MS` over the head and the body together (`perAttemptTimeoutMs`,
        // openai-compat-chat-send.mjs:291), which the driver's recovery attempt starts in and a head arriving does not reset.
        // A request that outlives it fails the re-issue, as any other failure of it does.
        let call = self.model_call(&request, None, true);
        let (response, _) = self.driver.send(&call, Self::with_key(&wire, key.as_deref()), MODEL_STREAM).await?;
        if !response.is_success() {
            return Err(Self::failure(&self.codec, response, key.as_deref(), &wire.body).await);
        }
        let answered = response.read_all().await?;
        let chunk = super::nonstream::as_stream(&answered.body).ok_or_else(failed)?;
        let mut decoder = self.codec.decoder(&request);
        let mut events = decoder.feed(&chunk)?;
        events.extend(decoder.finish()?);
        Ok(Box::new(CompatStream { body: None, decoder, queue: super::nonstream::whole(events).into(), failed: None, attempt: None, had_output: false }))
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
    /// The first-byte window of the next attempt of the send (`compatFirstByteWindowMs(provider.name, firstByteTimeoutMs,
    /// firstByteTimeouts)`): the chat profile's own window, else the shared one; a profile that caps its first-byte retries
    /// (`firstByteRetries`) doubles it after each and ends the ladder past the cap.
    fn first_byte_gate(&self, identity: &mixdog_core_api::domain::provider::SendIdentity) -> crate::providers::head_wait::FirstByteGate {
        match self.profile().chat.first_byte {
            Some(policy) => crate::providers::head_wait::FirstByteGate::of(&self.first_byte.compat(policy), identity, self.profile().id.to_string()),
            None => shared_first_byte_gate(&self.first_byte, identity, self.profile().id.to_string()),
        }
    }

    fn model_call(&self, request: &ModelRequest, gate: Option<crate::providers::head_wait::FirstByteGate>, recovery: bool) -> ModelCall {
        stream_call(self.profile().id.to_string(), &self.first_byte, &request.options.send_identity, gate, recovery)
    }

    pub(crate) fn with_default_effort(&self, request: Arc<ModelRequest>) -> Arc<ModelRequest> {
        match &self.configured_effort {
            Some(effort) if request.options.effort.is_none() => {
                let mut owned = (*request).clone();
                owned.options.effort = Some(effort.clone());
                Arc::new(owned)
            }
            _ => request,
        }
    }

    /// One attempt of this provider's key and transport on another of its wires (`codec`): the gateway's
    /// Responses wire rides the same account as its Chat wire.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn attempt_with(&self, codec: &dyn WireCodec, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = self.with_default_effort(request);
        let mut wire = codec.encode(&request)?;
        let (mut key, base) = self.routed_key().await?;
        self.route_url(&mut wire.url, base.as_deref());
        let mut reloaded = false;
        loop {
            let gate = wire.url.ends_with("/chat/completions").then(|| self.first_byte_gate(&request.options.send_identity));
            // Chat Completions raises `requesting` for every attempt of its ladder (openai-compat-chat-send.mjs:276),
            // Responses once before it (openai-compat-xai-send.mjs:103).
            if wire.url.ends_with("/chat/completions") {
                request.options.send_identity.raise_stage("requesting");
            } else {
                request.options.send_identity.raise_requesting_once();
            }
            let call = self.model_call(&request, gate, false);
            let (response, attempt) = self.driver.send(&call, Self::with_key(&wire, key.as_deref()), MODEL_STREAM).await?;
            if response.is_success() {
                // `onStreamDelta('transport')` as the stream opens, for an accepted response only: a refusal is the SDK's
                // thrown error.
                request.options.send_identity.raise_stage("transport");
                return Ok(Box::new(CompatStream::new(response.body, codec.decoder(&request)).with_attempt(attempt)));
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
    async fn resolve_wire_route(&self, model: &str, context: &WireRouteContext) -> Result<Option<WireRoute>, ProviderError> {
        let profile = self.codec.profile();
        let mut facts = WireFacts {
            override_wire: self.routing.model_wires.get(model).copied().or_else(|| self.roster_wires.load().get(model).copied()),
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
