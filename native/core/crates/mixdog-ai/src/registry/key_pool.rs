//! A custom provider's API keys as one roster (Node `createCustomKeyPoolProvider`, `account-pool.mjs`): the primary
//! engine is the `default` account and answers everything but the send; each additional key sends through an engine
//! of its own (`customKeyEngine`) built on the same configuration. A send walks the roster by the pool's rule
//! ([`AccountRotation::pool_send`]): an explicit quota refusal blocks the key for the model and moves on to the next
//! key, a refusal of any other kind ends the send, and a refusal after output started is never re-sent.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRouting;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value as JsonValue;
use tokio_util::sync::CancellationToken;

use crate::accounts::rotation::AccountRotation;
use crate::accounts::rotation::AccountSender;
use crate::accounts::rotation::Cause;
use crate::accounts::rotation::CooldownPolicy;
use crate::accounts::rotation::Failed;
use crate::accounts::rotation::PoolError;
use crate::accounts::rotation::SendContext;
use crate::accounts::rotation::Stage;

/// An additional key's engine, or why it cannot send (`customKeyEngine` throws when the key is not readable).
pub type KeyEngine = Result<Arc<dyn ProviderAdapter>, String>;

/// A custom provider's key has no plan usage to re-measure.
pub struct NoMeter;

#[async_trait]
impl crate::accounts::rotation::UsageProbe for NoMeter {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

pub struct KeyPoolAdapter {
    provider: String,
    primary: Arc<dyn ProviderAdapter>,
    /// `(key id, engine)` of every additional key, in roster order.
    keys: Vec<(String, KeyEngine)>,
    rotation: AccountRotation,
}

impl KeyPoolAdapter {
    pub fn new(provider: &str, primary: Arc<dyn ProviderAdapter>, keys: Vec<(String, KeyEngine)>, rotation: AccountRotation) -> Self {
        Self { provider: provider.to_owned(), primary, keys, rotation }
    }

    fn engine(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        if account == "default" {
            return Ok(self.primary.clone());
        }
        match self.keys.iter().find(|(id, _)| id == account).map(|(_, engine)| engine) {
            Some(Ok(engine)) => Ok(engine.clone()),
            Some(Err(message)) => Err(plain(ErrorKind::Unknown, None, message.clone())),
            None => Err(plain(
                ErrorKind::Unknown,
                None,
                format!("An additional API key of {} is not readable; enter it again in its settings.", self.provider),
            )),
        }
    }
}

fn plain(kind: ErrorKind, code: Option<&str>, message: String) -> ProviderError {
    let mut error = ProviderError::new(kind, DeliveryState::NotSent);
    error.code = code.map(str::to_owned);
    error.message = message;
    error
}

/// What a pool that ended without an answer throws (`accountsExhaustedError`, `accountsCoolingDownError`, or the
/// error that ended the send).
fn pool_error(error: PoolError) -> ProviderError {
    let message = error.message();
    match error.cause {
        Cause::Provider(provider) => provider,
        Cause::AccountsExhausted { .. } => plain(ErrorKind::QuotaExhausted, Some("provider_accounts_exhausted"), message),
        Cause::CoolingDown { retry_after_ms } => {
            let mut cooling = plain(ErrorKind::RateLimited, Some("rate_limited"), message);
            cooling.retry_after = retry_after_ms.and_then(|ms| u64::try_from(ms).ok()).map(std::time::Duration::from_millis);
            cooling
        }
        Cause::Cancelled => plain(ErrorKind::Unknown, None, message),
        Cause::Message(_) | Cause::Store(_) => plain(ErrorKind::Unknown, None, message),
    }
}

/// One key-bound attempt of the send.
struct KeySend<'a> {
    pool: &'a KeyPoolAdapter,
    request: Arc<ModelRequest>,
    served: Mutex<Option<String>>,
}

#[async_trait]
impl AccountSender<Box<dyn ModelStream>> for KeySend<'_> {
    /// A custom provider's engines declare no cooldown policy.
    fn cooldown_policy(&self, _: &str) -> Option<CooldownPolicy> {
        None
    }

    async fn send(&self, account: &str, _scoped: bool) -> Result<Box<dyn ModelStream>, Failed> {
        let engine = self.pool.engine(account).map_err(Failed::new)?;
        let stream = engine.attempt(self.request.clone()).await.map_err(|error| {
            let unsafe_to_retry = error.unsafe_to_retry;
            Failed { unsafe_to_retry, ..Failed::new(error) }
        })?;
        *self.served.lock().unwrap_or_else(PoisonError::into_inner) = Some(account.to_owned());
        Ok(stream)
    }

    fn stamp(&self, _: &mut Box<dyn ModelStream>, _: &str, _: &str) {}

    // The pool's stages (`reconnecting`, `account-changed`) are Node's stage indicator, which a provider stream has
    // no event for.
    fn notify(&self, _: Stage) {}
}

/// The served key's stream: a refusal that ends it after output started is judged and recorded on that key as the
/// pool's send records it (Node's send fails there, inside the pool), and never re-sent.
struct KeyStream {
    inner: Box<dyn ModelStream>,
    refusal: Option<(AccountRotation, String, String, String)>,
}

#[async_trait]
impl ModelStream for KeyStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let item = self.inner.next().await;
        if let Some(Err(error)) = &item
            && let Some((rotation, provider, account, model)) = self.refusal.take()
        {
            let failed = Failed { emitted: true, ..Failed::new(error.clone()) };
            // A store that cannot be written leaves the key unblocked; the refusal itself is the send's error.
            let _ = rotation.record_refusal(&provider, &account, &model, &failed, None).await;
        }
        item
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }
}

#[async_trait]
impl ProviderAdapter for KeyPoolAdapter {
    fn id(&self) -> &ProviderId {
        self.primary.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.primary.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.primary.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.primary.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.primary.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.primary.wire_routing()
    }
    async fn settle_send(&self, group: &str, end: SendEnd) {
        self.primary.settle_send(group, end).await;
    }
    fn release_session(&self, session_id: &str) {
        self.primary.release_session(session_id);
        for engine in self.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok()) {
            engine.release_session(session_id);
        }
    }
    fn release_transport_scope(&self, scope: &str) {
        self.primary.release_transport_scope(scope);
        for engine in self.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok()) {
            engine.release_transport_scope(scope);
        }
    }
    fn native_pdf(&self) -> bool {
        self.primary.native_pdf()
    }
    fn native_documents(&self) -> Option<bool> {
        self.primary.native_documents()
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        self.primary.first_response_budget(model, parameters)
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.primary.cache_warm()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let context = SendContext {
            model: request.model.clone(),
            session_id: request.options.session_id.clone(),
            bound_hint: None,
            cancel: CancellationToken::new(),
            implicit_plan_usage: None,
        };
        let sender = KeySend { pool: self, request: request.clone(), served: Mutex::new(None) };
        let stream = self.rotation.pool_send(&self.provider, &context, &sender).await.map_err(pool_error)?;
        let served = sender.served.into_inner().unwrap_or_else(PoisonError::into_inner).unwrap_or_else(|| "default".into());
        let refusal = Some((self.rotation.clone(), self.provider.clone(), served, request.model.clone()));
        Ok(Box::new(KeyStream { inner: stream, refusal }))
    }
}
