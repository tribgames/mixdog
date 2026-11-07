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
//! One `attempt` is one send. Retrying has a single owner, the loop's `RetryDecider`, so a retry
//! the loop makes is a send of its own with its own row; Node's provider-local retries sit inside
//! one send and so inside one row (`attempts`, the `retried` status).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelListing, ModelRequest, ModelStream, ProviderAdapter, ProviderError, RequestOptions, SendEnd, StreamEvent, TransportFault,
    Usage, WireCodec, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use super::accounting::{Completed, Facts, Outcome, SendAccounting, SendIdentity, UsagePricing, UsageSink, random_uuid};

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

/// The account a send is bound to (`currentProviderAccountId`), read where its row is written
/// (`usage-accounting.mjs:161`): a send that switched accounts mid-request is recorded under the
/// account current at that point. An unreadable roster is the error text Node's read throws inside
/// the row's write, which fails that recording (`usageAccountingError`).
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
        Self {
            pricing,
            ledger,
            scope: Arc::new(RequestScope),
            account: Arc::new(NoAccounts),
            now: Arc::new(|| {
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
            }),
            new_id: Arc::new(random_uuid),
        }
    }
}

/// `instance.constructor.inputExcludesCache`: Anthropic reports input without its cache reads.
fn input_excludes_cache(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth")
}

/// The accounting of a logical send between its attempts, with the failure of the last one
/// held back: the next attempt of the group makes it an abandoned attempt of the same row, and
/// `settle_send` makes it the send's own failed row.
struct Held {
    accounting: SendAccounting,
    failed: Option<ProviderError>,
}

type Groups = Arc<Mutex<HashMap<String, Held>>>;

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
    async fn open(&self, request: &ModelRequest) -> SendAccounting {
        if let Some(group) = request.options.send_group.as_deref()
            && let Some(Held { mut accounting, failed }) = self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(group)
        {
            note_failed(&mut accounting, failed);
            return accounting;
        }
        self.begin(request)
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
            input_tokens_inclusive: !input_excludes_cache(provider),
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
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
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
    fn native_pdf(&self) -> bool {
        self.inner.native_pdf()
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.inner.cache_warm()
    }
    fn native_documents(&self) -> Option<bool> {
        self.inner.native_documents()
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&mixdog_protocol::JsonValue>) -> Option<mixdog_core_api::domain::provider::FirstResponseBudget> {
        self.inner.first_response_budget(model, parameters)
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let accounting = self.open(&request).await;
        let group = request.options.send_group.clone().map(|id| (id, Arc::clone(&self.groups)));
        match self.inner.attempt(request).await {
            Ok(stream) => Ok(Box::new(AccountedStream {
                inner: stream,
                open: Some(Open { accounting, usage: None }),
                group,
                now: Arc::clone(&self.deps.now),
            })),
            Err(error) => {
                fail(accounting, group, error.clone()).await;
                Err(error)
            }
        }
    }

    async fn settle_send(&self, group: &str, end: SendEnd) {
        let held = self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(group);
        let Some(Held { mut accounting, failed }) = held else { return };
        match end {
            SendEnd::Surfaced => {
                if let Some(error) = failed {
                    accounting.finish(Outcome::Failed(&error)).await;
                }
            }
            // The cancel ended a send whose last failure was already retried (its usage noted):
            // only the abandoned attempts are recorded, never a request row of their own.
            SendEnd::Cancelled => {
                note_failed(&mut accounting, failed);
                accounting.finish(Outcome::Cancelled { reported: None }).await;
            }
        }
    }
}

/// An attempt failed: inside a group the failure is held for the loop's verdict (a retry makes it
/// an abandoned attempt, `settle_send` its row); alone it is the send's failed row.
async fn fail(accounting: SendAccounting, group: Option<(String, Groups)>, error: ProviderError) {
    match group {
        Some((id, groups)) => {
            groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id, Held { accounting, failed: Some(error) });
        }
        None => {
            accounting.finish(Outcome::Failed(&error)).await;
        }
    }
}

/// A send whose row is not yet written.
struct Open {
    accounting: SendAccounting,
    /// The last usage the stream showed (`StreamEvent::Usage` replaces).
    usage: Option<Usage>,
}

struct AccountedStream {
    inner: Box<dyn ModelStream>,
    /// `None` once the row is written.
    open: Option<Open>,
    group: Option<(String, Groups)>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

#[async_trait]
impl ModelStream for AccountedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let step = self.inner.next().await;
        let open = self.open.as_mut()?;
        match step {
            Some(Ok(StreamEvent::Usage(usage))) => {
                open.usage = Some(usage.clone());
                Some(Ok(StreamEvent::Usage(usage)))
            }
            Some(Ok(StreamEvent::Completed { stop, pricing_model, request_ms })) => {
                let open = self.open.take()?;
                let done = Completed {
                    facts: open.usage.as_ref().map(Facts::from),
                    pricing_model: pricing_model.clone(),
                    stream_ended_at: (self.now)(),
                    ..Completed::default()
                };
                let recorded = open.accounting.finish(Outcome::Completed(done)).await;
                Some(Ok(StreamEvent::Completed { stop, pricing_model, request_ms: recorded.request_ms.or(request_ms) }))
            }
            Some(Ok(event)) => Some(Ok(event)),
            Some(Err(error)) => {
                let open = self.open.take()?;
                fail(open.accounting, self.group.take(), error.clone()).await;
                Some(Err(error))
            }
            None => {
                // A stream may only end with its terminal event: the consumer fails it the same way.
                let open = self.open.take()?;
                let error = ProviderError::transport(TransportFault::TruncatedStream, self.inner.delivery());
                fail(open.accounting, self.group.take(), error).await;
                None
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }
}

impl Drop for AccountedStream {
    /// Dropped before its end: the send was cancelled, and records what it showed.
    fn drop(&mut self) {
        let Some(open) = self.open.take() else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        runtime.spawn(async move {
            let reported = open.usage.as_ref().map(Facts::from);
            open.accounting.finish(Outcome::Cancelled { reported }).await;
        });
    }
}
