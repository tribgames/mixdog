//! Every image a provider is given is one its destination accepts, decided once for the request that is actually sent.
//!
//! A registered provider is handed out wrapped by [`EgressGuard`] (`ProviderRegistry::accounted`, the one place a built adapter
//! becomes a registered one), so every caller that reaches an adapter through the registry (an agent turn's `attempt`, a side
//! question or a compaction fork's `send_forked`, the re-issue of a spent send, a cache warm's saved request, and the other-PC
//! model proxy through `ModelBroker::send`) passes the same three methods below. Each one
//!
//! 1. captures every image occurrence of the request as it stands (an image part, an attachment reference, a `data:` URL, a link,
//!    a file id, and any image block of a message's recorded provider form), before any projection; a request with none is
//!    sent as it is;
//! 2. resolves the route the request actually takes ([`ProviderAdapter::image_route`]) to one pinned plan;
//! 3. reads the recorded verdict and the stored bytes of each image from the attachment store ([`ImageSupply`]; a send decodes
//!    nothing of its own) and lets the destination matrix choose the original, a stored rendition, or a refusal;
//! 4. seals the request against that plan: either every occurrence is accounted for, or the whole request is [`NotSent`] with
//!    every blocker named, and the adapter is never called.
//!
//! The adapter then encodes a request whose images are exactly the sealed ones. A refused request is no send the ledger writes a
//! row for: the guard is outside the accounting wrapper.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::cache_warm::CacheWarmSend;
use mixdog_core_api::domain::cache_warm::WarmContext;
use mixdog_core_api::domain::cache_warm::WarmFailure;
use mixdog_core_api::domain::cache_warm::WarmUsage;
use mixdog_core_api::domain::image_supply::ImageSupply;
use mixdog_core_api::domain::image_supply::NoSupply;
use mixdog_core_api::domain::image_supply::PrepareFailure;
use mixdog_core_api::domain::image_supply::prepare_intent;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::prepared_request::DraftRequest;
use mixdog_core_api::domain::prepared_request::PreparedRequest;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::MediaSupport;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RetryLine;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::SendStages;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRouting;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_image_egress::NotSent;
use mixdog_image_egress::route::RouteFacts;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;
use tokio_util::sync::CancellationToken;

/// The supply could not answer: nothing is claimed about any image and nothing is sent.
fn unavailable(why: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = format!("Nothing was sent. The images in this request could not be checked just now ({why}). Try again in a moment.");
    error
}

/// `request` with every image occurrence prepared for the route it takes: the same request where it holds none, else the sealed
/// request with the prepared images in their places (content and recorded form alike); any image the destination cannot take
/// ends the call with every blocker named, and nothing is sent.
pub(crate) async fn prepare(adapter: &dyn ProviderAdapter, request: Arc<ModelRequest>) -> Result<Arc<ModelRequest>, ProviderError> {
    let session = request.options.session_id.clone().unwrap_or_default();
    let draft = DraftRequest::new(request, &session, "");
    if draft.intents().is_empty() {
        return Ok(draft.into_request());
    }
    let plan = mixdog_image_egress::route::resolve(&adapter.image_route(draft.request()).await);
    let supply: Arc<dyn ImageSupply> = mixdog_core_api::domain::image_supply::installed().unwrap_or_else(|| Arc::new(NoSupply));
    let mut batch = plan.batch(draft.intents().iter().map(|intent| intent.origin.clone()).collect());
    for intent in draft.intents() {
        match prepare_intent(&plan, intent, supply.as_ref()).await {
            Ok(image) => batch.accept(image),
            Err(PrepareFailure::Refused(refusal)) => batch.refuse(refusal),
            Err(PrepareFailure::Unavailable(why)) => return Err(unavailable(&why)),
        }
    }
    let refused = |mut not_sent: NotSent, draft: &DraftRequest| {
        draft.offer_new_context(&mut not_sent);
        ProviderError::images_not_sent(not_sent)
    };
    let sealed = batch.seal().map_err(|not_sent| refused(not_sent, &draft))?;
    let prepared = PreparedRequest::seal(draft.clone(), plan, sealed).map_err(|not_sent| refused(not_sent, &draft))?;
    Ok(Arc::new(prepared.wire_request()))
}

/// The cache warm of the wrapped provider, sent the prepared request: a warm refused for an image cancels that warm only.
struct GuardedWarm {
    inner: Arc<dyn ProviderAdapter>,
}

#[async_trait]
impl CacheWarmSend for GuardedWarm {
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        ctx: &WarmContext<'_>,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        let Some(warm) = self.inner.cache_warm() else { return Err(WarmFailure::new("provider has no cache-warm mode")) };
        let request = prepare(self.inner.as_ref(), Arc::new(request.clone())).await.map_err(|error| WarmFailure::new(error.into_message()))?;
        warm.send_cache_warm(&request, ctx, cancel, on_usage).await
    }
}

pub struct EgressGuard {
    inner: Arc<dyn ProviderAdapter>,
    warm: Option<GuardedWarm>,
}

impl EgressGuard {
    pub fn wrap(inner: Arc<dyn ProviderAdapter>) -> Arc<dyn ProviderAdapter> {
        let warm = inner.cache_warm().map(|_| GuardedWarm { inner: Arc::clone(&inner) });
        Arc::new(Self { inner, warm })
    }
}

#[async_trait]
impl ProviderAdapter for EgressGuard {
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
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.inner.retry_policy_of(request)
    }
    async fn prepare_send(&self, request: &ModelRequest) {
        self.inner.prepare_send(request).await;
    }
    fn send_stages_of(&self, request: &ModelRequest) -> SendStages {
        self.inner.send_stages_of(request)
    }
    fn retry_line_of(&self, request: &ModelRequest) -> Option<RetryLine> {
        self.inner.retry_line_of(request)
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = prepare(self.inner.as_ref(), request).await?;
        self.inner.attempt(request).await
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.inner.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.inner.wire_routing()
    }
    async fn settle_send(&self, group: &str, end: SendEnd) {
        self.inner.settle_send(group, end).await;
    }
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
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
    fn native_documents(&self) -> Option<bool> {
        self.inner.native_documents()
    }
    fn input_excludes_cache(&self) -> Option<bool> {
        self.inner.input_excludes_cache()
    }
    async fn media_support(&self, request: &ModelRequest) -> MediaSupport {
        self.inner.media_support(request).await
    }
    async fn takes_vision(&self, request: &ModelRequest) -> bool {
        self.inner.takes_vision(request).await
    }
    async fn image_route(&self, request: &ModelRequest) -> RouteFacts {
        self.inner.image_route(request).await
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        self.inner.first_response_budget(model, parameters)
    }
    fn cache_warm(&self) -> Option<&dyn CacheWarmSend> {
        self.warm.as_ref().map(|warm| warm as &dyn CacheWarmSend)
    }
    fn send_stages(&self, model: &str) -> SendStages {
        self.inner.send_stages(model)
    }
    fn retry_line(&self, model: &str) -> Option<RetryLine> {
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
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = prepare(self.inner.as_ref(), request).await?;
        self.inner.recover_spent(request).await
    }
}

#[cfg(test)]
mod tests;
