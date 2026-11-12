//! The client-version duties of the dialects that gate on one (`warmCodexClientVersion`,
//! `warmGrokCliVersion`, `warmCursorClientVersion`, `ensureAntigravityVersion`), kept at the
//! provider boundary like the accounting: the version is warmed before the dialect's first
//! request (cheap after it: a day's cache, ten minutes after a failure), for a listing as for a
//! send, and what an attempt puts on the wire is read at encode time. (Grok's version gate, a 426
//! that teaches a minimum and is sent again at once, is the Grok adapter's own: `grok::adapter`.)

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{
    ModelListing, ModelRecord, ModelRequest, ModelStream, ProviderAdapter, ProviderError, SendEnd, WireCodec, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use crate::client_versions::{ClientVersions, Dialect};

struct WarmedListing {
    inner: Arc<dyn ProviderAdapter>,
    dialect: Dialect,
    versions: Arc<ClientVersions>,
}

#[async_trait]
impl ModelListing for WarmedListing {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.versions.warm(self.dialect).await;
        match self.inner.models() {
            Some(listing) => listing.list_models().await,
            None => Ok(Vec::new()),
        }
    }
}

pub struct VersionedAdapter {
    inner: Arc<dyn ProviderAdapter>,
    dialect: Dialect,
    versions: Arc<ClientVersions>,
    listing: Option<WarmedListing>,
}

impl VersionedAdapter {
    pub fn wrap(inner: Arc<dyn ProviderAdapter>, dialect: Dialect, versions: Arc<ClientVersions>) -> Arc<dyn ProviderAdapter> {
        let listing = inner.models().map(|_| WarmedListing { inner: Arc::clone(&inner), dialect, versions: Arc::clone(&versions) });
        Arc::new(Self { inner, dialect, versions, listing })
    }
}

#[async_trait]
impl ProviderAdapter for VersionedAdapter {
    fn id(&self) -> &ProviderId {
        self.inner.id()
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
    /// The dialect's version is read before the send raises its first stage, as Node's send awaits it first
    /// (`ensureAntigravityVersion`, `warmCursorClientVersion`).
    async fn prepare_send(&self, request: &ModelRequest) {
        self.versions.warm(self.dialect).await;
        self.inner.prepare_send(request).await;
    }
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.inner.retry_policy_of(request)
    }
    fn send_stages_of(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::SendStages {
        self.inner.send_stages_of(request)
    }
    fn retry_line_of(&self, request: &ModelRequest) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.inner.retry_line_of(request)
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_ref().map(|l| l as &dyn ModelListing)
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.inner.wire_routing()
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.inner.cache_warm()
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&mixdog_protocol::JsonValue>) -> Option<mixdog_core_api::domain::provider::FirstResponseBudget> {
        self.inner.first_response_budget(model, parameters)
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.versions.warm(self.dialect).await;
        self.inner.attempt(request).await
    }

    fn send_stages(&self, model: &str) -> mixdog_core_api::domain::provider::SendStages {
        self.inner.send_stages(model)
    }

    fn retry_line(&self, model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.inner.retry_line(model)
    }

    fn recovers_spent(&self, model: &str, failure: &ProviderError) -> bool {
        self.inner.recovers_spent(model, failure)
    }

    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.inner.recover_spent(request).await
    }

    async fn settle_send(&self, group: &str, end: SendEnd) {
        self.inner.settle_send(group, end).await;
    }

    fn release_session(&self, session_id: &str) {
        self.inner.release_session(session_id);
    }

    fn release_transport_scope(&self, scope: &str) {
        self.inner.release_transport_scope(scope);
    }
}
