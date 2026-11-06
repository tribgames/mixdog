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

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    DeliveryState, ModelListing, ModelRequest, ModelStream, ProviderAdapter, ProviderError, RequestOptions, StreamEvent, TransportFault,
    Usage, WireCodec, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use super::accounting::{Completed, Facts, Outcome, SendAccounting, SendIdentity, UsagePricing, UsageSink, random_uuid};
use crate::accounts::ACCOUNT_PROVIDERS;

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
        let RequestOptions { session_id, request_kind, .. } = &request.options;
        Scope { session_id: session_id.clone(), source_type: request_kind.clone().unwrap_or_default(), ..Scope::default() }
    }
}

/// Everything the accounting of a send reads that is not the send.
#[derive(Clone)]
pub struct AccountingDeps {
    pub pricing: Arc<dyn UsagePricing>,
    /// `getUsageLedger()`, read per send: `None` while no ledger is open.
    pub ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>,
    pub scope: Arc<dyn SendScope>,
    /// The account a send is bound to (account providers only; `""` otherwise).
    pub account: Arc<dyn Fn(&str) -> String + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl AccountingDeps {
    pub fn new(pricing: Arc<dyn UsagePricing>, ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>) -> Self {
        Self {
            pricing,
            ledger,
            scope: Arc::new(RequestScope),
            account: Arc::new(|_| String::new()),
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

pub struct AccountedAdapter {
    inner: Arc<dyn ProviderAdapter>,
    name: String,
    deps: Arc<AccountingDeps>,
}

impl AccountedAdapter {
    pub fn wrap(inner: Arc<dyn ProviderAdapter>, name: &str, deps: Arc<AccountingDeps>) -> Arc<dyn ProviderAdapter> {
        Arc::new(Self { inner, name: name.to_owned(), deps })
    }

    fn begin(&self, request: &ModelRequest) -> (SendAccounting, i64) {
        let deps = &self.deps;
        let provider = self.name.as_str();
        let scope = deps.scope.of(provider, request);
        let started_at = (deps.now)();
        let model = request.model.as_str();
        let primary = scope.primary.filter(|(p, m)| p != provider || m != model);
        let route_hop = primary.is_some();
        let (requested_provider, requested_model) = primary.unwrap_or_else(|| (provider.to_owned(), model.to_owned()));
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
            account: if ACCOUNT_PROVIDERS.contains(&provider) { (deps.account)(provider) } else { String::new() },
            request_id: (deps.new_id)(),
            started_at,
        };
        let accounting = SendAccounting::new(identity, Arc::clone(&deps.pricing), (deps.ledger)())
            .with_sources(Arc::clone(&deps.now), Arc::clone(&deps.new_id));
        (accounting, started_at)
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

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let (accounting, started_at) = self.begin(&request);
        match self.inner.attempt(request).await {
            Ok(stream) => Ok(Box::new(AccountedStream {
                inner: stream,
                open: Some(Open { accounting, usage: None, started_at }),
                now: Arc::clone(&self.deps.now),
            })),
            Err(error) => {
                accounting.finish(Outcome::Failed(&error)).await;
                Err(error)
            }
        }
    }
}

/// A send whose row is not yet written.
struct Open {
    accounting: SendAccounting,
    /// The last usage the stream showed (`StreamEvent::Usage` replaces).
    usage: Option<Usage>,
    #[allow(dead_code)]
    started_at: i64,
}

struct AccountedStream {
    inner: Box<dyn ModelStream>,
    /// `None` once the row is written.
    open: Option<Open>,
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
                open.accounting.finish(Outcome::Failed(&error)).await;
                Some(Err(error))
            }
            None => {
                // A stream may only end with its terminal event: the consumer fails it the same way.
                let open = self.open.take()?;
                let error = ProviderError::transport(TransportFault::TruncatedStream, self.inner.delivery());
                open.accounting.finish(Outcome::Failed(&error)).await;
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
