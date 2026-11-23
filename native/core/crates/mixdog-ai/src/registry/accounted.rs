//! The accounted provider: Node's `accountProviderSend` (`shared/llm/usage-accounting.mjs`) at the
//! one boundary every model request passes. The registry hands out this wrapper for each provider
//! it builds, so a turn, a route hop, a compaction summary and a one-shot call all send through
//! it and each send writes its ledger row.
//!
//! The terminal `StreamEvent::Completed` is held until the completed row is recorded, then
//! released with `request_ms` stamped (Node's `usageDurationMs`): a consumer never sees a
//! `Completed` without the duration the ledger measured. A stream that fails, or ends without its
//! terminal event, records a failed row; one dropped before its end records a cancelled row with
//! the last usage it showed.
//!
//! Billed attempts abandoned by a provider replay, account rotation or loop retry get their
//! own rows within the logical send. Settlement never polls or reissues the provider request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::FutureExt;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelListing, ModelRequest, ModelStream, ProviderAdapter, ProviderError, RequestOptions, SendEnd, StreamEvent, TransportFault, Usage,
    WireCodec, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::accounting::{Completed, Facts, Outcome, Recorded, SendAccounting, SendIdentity, UsagePricing, UsageSink, random_uuid, wall_ms};

#[derive(Default)]
struct Journal {
    has_sink: bool,
    current: Report,
    abandoned: Vec<AbandonedUsage>,
}

struct AbandonedUsage {
    usage: Box<Usage>,
    model: Option<Box<str>>,
    speed: String,
    account: Option<String>,
}

tokio::task_local! {
    static ATTEMPT_USAGE: Arc<Mutex<Journal>>;
}

/// `work` under the attempt journal of the task that calls this ([`crate::task_context::carry`]).
pub(crate) fn carry<F: std::future::Future>(work: F) -> impl std::future::Future<Output = F::Output> {
    mixdog_rt::within_local(&ATTEMPT_USAGE, ATTEMPT_USAGE.try_with(Arc::clone).ok(), work)
}

#[derive(Default)]
struct Report {
    observed: Option<(Usage, Option<String>)>,
    usage: Option<Usage>,
    served: Option<String>,
    fallback: bool,
    response_id: Option<String>,
    output_at: Option<i64>,
}

impl Report {
    fn note_billing_event(&mut self, event: &StreamEvent) {
        match event {
            StreamEvent::Usage(usage) => self.usage = Some(usage.clone()),
            StreamEvent::ServedModel(model) => self.served = Some(model.clone()),
            _ => {}
        }
    }

    fn partial(&self) -> (Option<&Usage>, Option<&str>) {
        match &self.observed {
            Some((usage, model)) => (Some(usage), model.as_deref().or(self.served.as_deref())),
            None => (self.usage.as_ref(), self.served.as_deref()),
        }
    }

    fn fill_failure(&self, error: &mut ProviderError) {
        let (usage, model) = self.partial();
        if error.partial_usage.is_none() {
            error.partial_usage = usage.cloned().map(Box::new);
        }
        if error.partial_usage.is_some() && error.partial_model.is_none() {
            error.partial_model = model.map(Box::from);
        }
    }
}

/// A cumulative provider observation that the stream has not necessarily emitted yet.
pub(crate) fn observe_attempt_usage(usage: Usage, model: Option<String>) {
    let _ = ATTEMPT_USAGE.try_with(|journal| {
        journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current.observed = Some((usage, model));
    });
}

/// The attempt's observation replaced after a provider rolled its decoding back: `None` clears it, so a failure or a
/// cancellation books only what the restored decoding holds.
pub(crate) fn reset_attempt_usage(observed: Option<(Usage, Option<String>)>) {
    let _ = ATTEMPT_USAGE.try_with(|journal| {
        journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current.observed = observed;
    });
}

pub(crate) fn attach_observed_usage(error: &mut ProviderError) {
    let _ = ATTEMPT_USAGE.try_with(|journal| {
        journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current.fill_failure(error);
    });
}

/// Pool preflight can hold the first event before the accounted stream has even opened.
/// Keep it as an emitted fallback, not in place of a decoder's further-ahead observation.
pub(super) fn observe_pool_event(event: &StreamEvent) {
    if matches!(event, StreamEvent::Usage(_) | StreamEvent::ServedModel(_)) {
        let _ = ATTEMPT_USAGE.try_with(|journal| {
            journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current.note_billing_event(event);
        });
    }
}

/// Roster work can suspend after this frame but before the pool decides to surface or retry it.
pub(super) fn observe_pool_failure(error: &mut ProviderError) {
    attach_observed_usage(error);
    if let Some(usage) = error.partial_usage.as_deref() {
        observe_attempt_usage(usage.clone(), error.partial_model.as_deref().map(str::to_owned));
    }
}

/// Books a billed attempt the provider discarded inside the stream it is still reading (Node's `noteAbandonedUsage`): its
/// own row, with the current attempt's report left as it is. `false` when no accounting owner takes it.
pub(crate) fn note_abandoned_usage(usage: Usage, model: Option<String>, sent: &mixdog_core_api::domain::provider::SendIdentity) -> bool {
    ATTEMPT_USAGE
        .try_with(|journal| {
            let mut journal = journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !journal.has_sink {
                return false;
            }
            journal.abandoned.push(AbandonedUsage {
                usage: Box::new(usage),
                model: model.map(Into::into),
                speed: sent.dispatched_speed_tier(),
                account: sent.account().map(|s| s.account),
            });
            true
        })
        .unwrap_or(false)
}

/// Transfer the abandoned bill before an internal replay overwrites the
/// attempt's speed or is cancelled. Without an accounting owner, leave the
/// usage on the error so the caller can settle it.
pub(crate) fn handoff_abandoned_usage(error: &mut ProviderError, sent: &mixdog_core_api::domain::provider::SendIdentity) -> bool {
    ATTEMPT_USAGE
        .try_with(|journal| {
            let mut journal = journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            journal.current.fill_failure(error);
            if error.partial_usage.is_some() && !journal.has_sink {
                return false;
            }
            journal.current = Report::default();
            if let Some(usage) = error.partial_usage.take() {
                journal.abandoned.push(AbandonedUsage {
                    usage,
                    model: error.partial_model.take(),
                    speed: sent.dispatched_speed_tier(),
                    account: sent.account().map(|s| s.account),
                });
            }
            true
        })
        .unwrap_or(false)
}

/// The wrapped provider's stages behind the one every provider of the registry raises first: Node's admission scheduler
/// announces a send as `requesting` once it is admitted (`admission-scheduler.mjs:592`), ahead of the adapter's own
/// stages, around every provider the registry hands out. A provider standing in the registry's place raises none.
fn admitted(mut stages: mixdog_core_api::domain::provider::SendStages) -> mixdog_core_api::domain::provider::SendStages {
    stages.preparing += 1;
    stages
}

/// What the session knows about a send that the request does not say.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scope {
    /// `opts.usageSessionId || opts.sessionId`: the session whose spend this is.
    pub session_id: Option<String>,
    /// `session.sourceType || opts.sourceType || opts.requestKind`.
    pub source_type: String,
    pub owner_session_id: Option<String>,
    /// `session.routeFallbackPrimary` while the session stands on `provider`.
    pub primary: Option<(String, String)>,
}

/// Reads the [`Scope`] of a send. The host implements it over the session directory.
pub trait SendScope: Send + Sync {
    fn of(&self, provider: &str, request: &ModelRequest) -> Scope;
}

/// The scope a request states itself: its session id and request kind.
pub struct RequestScope;

impl SendScope for RequestScope {
    fn of(&self, _provider: &str, request: &ModelRequest) -> Scope {
        let RequestOptions { session_id, usage_session_id, source_type, request_kind, .. } = &request.options;
        Scope {
            session_id: usage_session_id.clone().or_else(|| session_id.clone()),
            source_type: source_type.clone().or_else(|| request_kind.clone()).unwrap_or_default(),
            ..Scope::default()
        }
    }
}

/// The route the send asks for: the primary route of a session on a route-fallback hop (kept at the
/// first hop, however many hops the chain has taken) while it differs from the route sent to, else
/// the route itself. The flag is `routeHop`.
pub fn requested_route(primary: Option<(String, String)>, provider: &str, model: &str) -> (String, String, bool) {
    match primary.filter(|(p, m)| p != provider || m != model) {
        Some((p, m)) => (p, m, true),
        None => (provider.to_owned(), model.to_owned(), false),
    }
}

/// Fallback for sends without a pinned roster row (`currentProviderAccountId`,
/// `usage-accounting.mjs:161`). A dispatched account takes precedence over this live lookup.
#[async_trait]
pub trait AccountOf: Send + Sync {
    async fn of(&self, provider: &str) -> Result<String, String>;
}

#[async_trait]
impl AccountOf for crate::accounts::AccountStore {
    async fn of(&self, provider: &str) -> Result<String, String> {
        self.current_provider_account_id(provider).await.map_err(|error| error.to_string())
    }
}

/// No account roster: every send is bound to none.
pub struct NoAccounts;

#[async_trait]
impl AccountOf for NoAccounts {
    async fn of(&self, _provider: &str) -> Result<String, String> {
        Ok(String::new())
    }
}

/// Everything the accounting of a send reads that is not the send.
#[derive(Clone)]
pub struct AccountingDeps {
    pub pricing: Arc<dyn UsagePricing>,
    /// `getUsageLedger()`, read per send: `None` while no ledger is open.
    pub ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>,
    pub scope: Arc<dyn SendScope>,
    /// The account a row is recorded under (account providers only; `""` otherwise).
    pub account: Arc<dyn AccountOf>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl AccountingDeps {
    pub fn new(pricing: Arc<dyn UsagePricing>, ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>) -> Self {
        Self { pricing, ledger, scope: Arc::new(RequestScope), account: Arc::new(NoAccounts), now: Arc::new(wall_ms), new_id: Arc::new(random_uuid) }
    }
}

/// `instance.constructor.inputExcludesCache`, the one source of the usage convention, for a registered
/// name: the adapter classes that report input without its cache reads and writes (`static
/// inputExcludesCache = true` in anthropic.mjs, anthropic-oauth.mjs, devin.mjs, vertex-ai.mjs); every
/// other class reports input with the cache. A custom provider's class is its protocol's (the
/// anthropic protocol extends `AnthropicProvider`, `custom-provider.mjs:162`), which a name cannot
/// tell: its adapter states it ([`ProviderAdapter::input_excludes_cache`]), read first by the
/// accounting and the model proxy's advertisement.
pub fn input_excludes_cache(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth" | "devin-oauth" | "vertex-ai")
}

/// `providerInputExcludesCache` of the actual adapter (`registry.mjs:492`): what it declares, else its class's by name.
/// Resolved once where a send is built and carried with its reports, never read again from a provider name.
pub fn adapter_input_excludes_cache(adapter: &dyn ProviderAdapter) -> bool {
    adapter.input_excludes_cache().unwrap_or_else(|| input_excludes_cache(adapter.id().as_str()))
}

/// The accounting of a logical send between its attempts, with the failure of the last one
/// held back: the next attempt of the group makes it an abandoned attempt of the same row, and
/// `settle_send` makes it the send's own failed row.
struct Held {
    accounting: SendAccounting,
    failed: Option<ProviderError>,
    runtime: tokio::runtime::Handle,
}

#[derive(Default)]
struct GroupState {
    held: HashMap<String, Held>,
    writing: HashMap<String, Vec<Write>>,
}

type Groups = Arc<Mutex<GroupState>>;
type Group = (String, Groups);

/// `noteErrorUsage`: an attempt that is retried abandons the usage the provider billed for it.
fn note_failed(accounting: &mut SendAccounting, failed: Option<ProviderError>) {
    if let Some(error) = failed
        && let Some(usage) = error.partial_usage.as_deref()
    {
        accounting.note_abandoned(usage, error.partial_model.as_deref().map(str::to_owned));
    }
}

pub struct AccountedAdapter {
    inner: Arc<dyn ProviderAdapter>,
    name: String,
    deps: Arc<AccountingDeps>,
    groups: Groups,
}

impl AccountedAdapter {
    pub fn wrap(inner: Arc<dyn ProviderAdapter>, name: &str, deps: Arc<AccountingDeps>) -> Arc<dyn ProviderAdapter> {
        Arc::new(Self { inner, name: name.to_owned(), deps, groups: Groups::default() })
    }

    /// The accounting this attempt belongs to: its group's, while a group is open, else a new send's.
    fn open(&self, request: &ModelRequest) -> Result<SendAccounting, ProviderError> {
        if let Some(group) = request.options.send_group.as_deref() {
            let mut state = self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(held) = state.held.get(group)
                && !held.accounting.has_sink()
                && let Some(error) = held.failed.as_ref().filter(|e| e.partial_usage.is_some())
            {
                return Err(error.clone());
            }
            if let Some(Held { mut accounting, failed, .. }) = state.held.remove(group) {
                note_failed(&mut accounting, failed);
                return Ok(accounting);
            }
        }
        Ok(self.begin(request))
    }

    /// One request of the inner provider (an attempt, or its re-issue of a spent send) under the send's accounting.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn accounted(&self, request: Arc<ModelRequest>, reissue: bool) -> Result<Box<dyn ModelStream>, ProviderError> {
        let accounting = self.open(&request)?;
        let group = request.options.send_group.clone().map(|id| (id, Arc::clone(&self.groups)));
        let sent = request.options.send_identity.clone();
        // This attempt starts with nothing dispatched: a previous attempt's tier never labels it, and an attempt that fails
        // before its request is handed to the transport (credentials, admission) stays standard.
        sent.note_dispatched_speed_tier("");
        let journal = Arc::new(Mutex::new(Journal { has_sink: accounting.has_sink(), ..Journal::default() }));
        let mut pending = PendingOpen { open: Some(Open { accounting, sent, journal: journal.clone() }), group, runtime: tokio::runtime::Handle::current() };
        let opened =
            ATTEMPT_USAGE.scope(journal, async { if reissue { self.inner.recover_spent(request).await } else { self.inner.attempt(request).await } }).await;
        match opened {
            Ok(stream) => Ok(Box::new(AccountedStream { inner: stream, pending, terminal: None, now: Arc::clone(&self.deps.now), wire_left: None })),
            Err(mut error) => {
                let (accounting, report) = pending.close();
                report.fill_failure(&mut error);
                // Neither a pre-transport cache refusal nor a local quota skip is a billable attempt.
                let failed = (error.partial_usage.is_some() || (error.tail_refusal.is_none() && !super::key_pool::is_local_quota_refusal(&error)))
                    .then(|| error.clone());
                if let Some(write) = hold_or_finish(accounting, pending.group.take(), failed) {
                    write.await;
                }
                Err(error)
            }
        }
    }

    fn begin(&self, request: &ModelRequest) -> SendAccounting {
        let deps = &self.deps;
        let provider = self.name.as_str();
        let scope = deps.scope.of(provider, request);
        let started_at = (deps.now)();
        let model = request.model.as_str();
        let (requested_provider, requested_model, route_hop) = requested_route(scope.primary, provider, model);
        let identity = SendIdentity {
            provider: provider.to_owned(),
            model: model.to_owned(),
            requested_provider,
            requested_model,
            route_hop,
            session_id: scope.session_id,
            owner_session_id: scope.owner_session_id,
            source_type: scope.source_type,
            input_tokens_inclusive: !self.inner.input_excludes_cache().unwrap_or_else(|| input_excludes_cache(provider)),
            request_service_tier: String::new(),
            account: Ok(String::new()),
            request_id: (deps.new_id)(),
            started_at,
        };
        SendAccounting::new(identity, Arc::clone(&deps.pricing), (deps.ledger)())
            .with_sources(Arc::clone(&deps.now), Arc::clone(&deps.new_id))
            .with_account(Arc::clone(&deps.account))
    }
}

#[async_trait]
impl ProviderAdapter for AccountedAdapter {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    async fn quota_eligibility(&self, model: &str) -> Option<bool> {
        self.inner.quota_eligibility(model).await
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn retry_policy_for(&self, model: &str) -> &RetryPolicy {
        self.inner.retry_policy_for(model)
    }
    async fn prepare_send(&self, request: &ModelRequest) {
        self.inner.prepare_send(request).await;
    }
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.inner.retry_policy_of(request)
    }
    fn send_stages_of(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::SendStages {
        admitted(self.inner.send_stages_of(request))
    }
    fn retry_line_of(&self, request: &ModelRequest) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.inner.retry_line_of(request)
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.inner.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.inner.wire_routing()
    }
    fn release_session(&self, session_id: &str) {
        self.inner.release_session(session_id);
    }
    fn begin_loop(&self) {
        self.inner.begin_loop();
    }
    fn release_transport_scope(&self, scope: &str) {
        self.inner.release_transport_scope(scope);
    }
    fn native_pdf(&self) -> bool {
        self.inner.native_pdf()
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.inner.cache_warm()
    }
    fn native_documents(&self) -> Option<bool> {
        self.inner.native_documents()
    }
    fn input_excludes_cache(&self) -> Option<bool> {
        self.inner.input_excludes_cache()
    }
    async fn media_support(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::MediaSupport {
        self.inner.media_support(request).await
    }
    async fn takes_vision(&self, request: &ModelRequest) -> bool {
        self.inner.takes_vision(request).await
    }
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        self.inner.image_route(request).await
    }
    fn first_response_budget(
        &self,
        model: &str,
        parameters: Option<&mixdog_protocol::JsonValue>,
    ) -> Option<mixdog_core_api::domain::provider::FirstResponseBudget> {
        self.inner.first_response_budget(model, parameters)
    }

    fn send_stages(&self, model: &str) -> mixdog_core_api::domain::provider::SendStages {
        admitted(self.inner.send_stages(model))
    }
    fn retry_line(&self, model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.inner.retry_line(model)
    }
    fn recovers_spent(&self, request: &ModelRequest, failure: &ProviderError) -> bool {
        self.inner.recovers_spent(request, failure)
    }

    fn recovers_cut(&self, request: &ModelRequest, failure: &ProviderError) -> bool {
        self.inner.recovers_cut(request, failure)
    }

    fn recovery_line(&self, model: &str, failure: &ProviderError) -> Option<String> {
        self.inner.recovery_line(model, failure)
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.accounted(request, false).await
    }

    /// The re-issue is one more request the provider bills: accounted as an attempt is.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.accounted(request, true).await
    }

    fn release_send(&self, group: &str) {
        group_writes(&self.groups, group, SendEnd::Cancelled);
        self.inner.release_send(group);
    }

    async fn settle_send(&self, group: &str, end: SendEnd) {
        let writes = group_writes(&self.groups, group, end);
        self.inner.settle_send(group, end).await;
        for write in writes {
            write.await;
        }
    }
}

/// An attempt failed: inside a group the failure is held for the loop's verdict (a retry makes it
/// an abandoned attempt, `settle_send` its row); alone it is the send's failed row.
fn hold_or_finish(accounting: SendAccounting, group: Option<Group>, failed: Option<ProviderError>) -> Option<Write> {
    let held = Held { accounting, failed, runtime: tokio::runtime::Handle::current() };
    match group {
        Some((id, groups)) => {
            groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).held.insert(id, held);
            None
        }
        None => Some(held.finish(SendEnd::Surfaced)),
    }
}

type Write = futures::future::Shared<futures::future::BoxFuture<'static, Recorded>>;

fn spawn_write(runtime: &tokio::runtime::Handle, work: impl std::future::Future<Output = Recorded> + Send + 'static) -> Write {
    runtime.spawn(work).map(written).boxed().shared()
}

impl GroupState {
    /// Publish under the same lock that consumed Held. Release never waits; settle can join the
    /// same task even after release, and a release without a later settle leaves no finished entry.
    fn track(&mut self, groups: &Groups, id: &str, write: Write, runtime: &tokio::runtime::Handle) {
        self.writing.entry(id.to_owned()).or_default().push(write.clone());
        let (groups, id) = (groups.clone(), id.to_owned());
        runtime.spawn(async move {
            write.await;
            let mut state = groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(running) = state.writing.get_mut(&id) {
                running.retain(|w| w.peek().is_none());
                if running.is_empty() {
                    state.writing.remove(&id);
                }
            }
        });
    }
}

fn group_writes(groups: &Groups, id: &str, end: SendEnd) -> Vec<Write> {
    let mut state = groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(held) = state.held.remove(id) {
        let runtime = held.runtime.clone();
        state.track(groups, id, held.finish(end), &runtime);
    }
    state.writing.get(id).cloned().unwrap_or_default()
}

/// A ledger task failure, like a sink error, is never a reason to reissue provider work.
fn written(result: Result<Recorded, tokio::task::JoinError>) -> Recorded {
    result.unwrap_or_else(|error| {
        mixdog_rt::node_stderr!("[usage-ledger] RECORD NOT SAVED: {error}");
        Recorded { error: Some(error.to_string()), request_ms: None }
    })
}

impl Held {
    fn finish(self, end: SendEnd) -> Write {
        let Self { mut accounting, failed, runtime } = self;
        spawn_write(&runtime, async move {
            if matches!(end, SendEnd::Surfaced) {
                if let Some(error) = failed {
                    return accounting.finish(Outcome::Failed(&error)).await;
                }
            } else {
                note_failed(&mut accounting, failed);
            }
            accounting.finish(Outcome::Cancelled { reported: None, model: None }).await
        })
    }
}

/// A send whose row is not yet written.
struct Open {
    accounting: SendAccounting,
    /// The send's identity as the adapter sees it: a recovery inside the stream may put another request on the wire,
    /// whose tier is read when the row is written.
    sent: mixdog_core_api::domain::provider::SendIdentity,
    journal: Arc<Mutex<Journal>>,
}

/// Installed before the first inner poll (pool preflight can itself consume a billed frame).
struct PendingOpen {
    open: Option<Open>,
    group: Option<Group>,
    runtime: tokio::runtime::Handle,
}

impl PendingOpen {
    fn write(&self, work: impl std::future::Future<Output = Recorded> + Send + 'static) -> Write {
        if let Some((id, groups)) = &self.group {
            let mut state = groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let write = spawn_write(&self.runtime, work);
            state.track(groups, id, write.clone(), &self.runtime);
            write
        } else {
            spawn_write(&self.runtime, work)
        }
    }

    fn close(&mut self) -> (SendAccounting, Report) {
        let Open { mut accounting, sent, journal } = self.open.take().expect("attempt closed twice");
        let Journal { current, abandoned, .. } = std::mem::take(&mut *journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        for AbandonedUsage { usage, model, speed, account } in abandoned {
            accounting.note_account(account);
            accounting.note_attempt_speed(speed);
            accounting.note_abandoned(&usage, model.map(String::from));
        }
        accounting.note_account(sent.account().map(|s| s.account));
        accounting.note_attempt_speed(sent.dispatched_speed_tier());
        (accounting, current)
    }
}

struct AccountedStream {
    inner: Box<dyn ModelStream>,
    pending: PendingOpen,
    /// Dropping the waiter cannot cancel the write. Polling again returns the terminal event
    /// without polling the provider a second time.
    terminal: Option<(Write, Option<Result<StreamEvent, ProviderError>>)>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Told when the wire's terminal event is in, before the row is written ([`ModelStream::on_wire_left`]).
    wire_left: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl AccountedStream {
    async fn written(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let (write, _) = self.terminal.as_mut()?;
        let recorded = write.await;
        let (_, mut event) = self.terminal.take()?;
        if let Some(Ok(StreamEvent::Completed { request_ms, .. })) = &mut event {
            *request_ms = recorded.request_ms.or(*request_ms);
        }
        event
    }

    fn leave_wire(&self) {
        if let Some(left) = &self.wire_left {
            left();
        }
    }
}

#[async_trait]
impl ModelStream for AccountedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if self.terminal.is_some() {
            return self.written().await;
        }
        let journal = self.pending.open.as_ref()?.journal.clone();
        let step = ATTEMPT_USAGE.scope(journal.clone(), self.inner.next()).await;
        match step {
            Some(Ok(StreamEvent::Completed { stop, pricing_model, request_ms })) => {
                let (accounting, report) = self.pending.close();
                let ended = (self.now)();
                let (partial, model) = report.partial();
                let done = Completed {
                    facts: report.usage.as_ref().or(partial).map(Facts::from),
                    model: report.served.clone().or_else(|| model.map(str::to_owned)),
                    fallback: report.fallback,
                    response_id: report.response_id,
                    pricing_model: pricing_model.clone(),
                    // The generation window: from the output's start to the stream's end (`generationWindow`,
                    // generation-window.mjs:9).
                    generation_ms: report.output_at.map(|at| (ended - at) as f64),
                    stream_ended_at: ended,
                    ..Completed::default()
                };
                self.leave_wire();
                let write = self.pending.write(async move { accounting.finish(Outcome::Completed(done)).await });
                self.terminal = Some((write, Some(Ok(StreamEvent::Completed { stop, pricing_model, request_ms }))));
                self.written().await
            }
            Some(Ok(event)) => {
                let report = &mut journal.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current;
                report.note_billing_event(&event);
                match &event {
                    StreamEvent::ProviderMetadata(metadata) => {
                        report.fallback = metadata.get("anthropicFallbacks").and_then(Value::as_array).is_some_and(|f| !f.is_empty());
                    }
                    StreamEvent::ResponseId(id) => report.response_id = Some(id.clone()),
                    StreamEvent::OutputStarted => {
                        report.output_at.get_or_insert_with(|| (self.now)());
                    }
                    _ => {}
                }
                Some(Ok(event))
            }
            failure => {
                let (accounting, report) = self.pending.close();
                self.leave_wire();
                let eof = failure.is_none();
                let mut error =
                    failure.and_then(Result::err).unwrap_or_else(|| ProviderError::transport(TransportFault::TruncatedStream, self.inner.delivery()));
                report.fill_failure(&mut error);
                let write = hold_or_finish(accounting, self.pending.group.take(), Some(error.clone()));
                let event = (!eof).then_some(Err(error));
                if let Some(write) = write {
                    self.terminal = Some((write, event));
                    self.written().await
                } else {
                    event
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        // The stream it wraps may await after the wire too (the key pool binding its serving key).
        self.inner.on_wire_left(Arc::clone(&left));
        self.wire_left = Some(left);
    }
}

#[cfg(test)]
mod speed_tests;

impl Drop for PendingOpen {
    fn drop(&mut self) {
        if self.open.is_some() {
            let (accounting, report) = self.close();
            let (usage, model) = report.partial();
            let outcome = Outcome::Cancelled { reported: usage.map(Facts::from), model: model.map(str::to_owned) };
            drop(self.write(async move { accounting.finish(outcome).await }));
        }
    }
}
