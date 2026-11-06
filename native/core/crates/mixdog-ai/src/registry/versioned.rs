//! The client-version duties of the dialects that gate on one (`warmCodexClientVersion`,
//! `warmGrokCliVersion`, `warmCursorClientVersion`, `ensureAntigravityVersion`), kept at the
//! provider boundary like the accounting: the version is warmed before the dialect's first
//! request (cheap after it: a day's cache, ten minutes after a failure), for a listing as for a
//! send, and what an attempt puts on the wire is read at encode time.
//!
//! Grok's version gate answers 426. When the body states a minimum above the version in use,
//! Node (`grok-oauth.mjs`) learns it and sends the same request once more, provided nothing was
//! emitted; the replay is that one send's own, not a pass through the retry ladder.

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

    /// A 426 whose body states a minimum the client did not meet, before anything was emitted.
    fn upgraded_by(&self, error: &ProviderError) -> bool {
        self.dialect == Dialect::Grok
            && error.status == Some(426)
            && !error.exposure.text_emitted
            && !error.exposure.tool_dispatched
            && self.versions.learn_grok_required(&error.message)
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
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_ref().map(|l| l as &dyn ModelListing)
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.inner.wire_routing()
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.versions.warm(self.dialect).await;
        match self.inner.attempt(Arc::clone(&request)).await {
            Err(error) if self.upgraded_by(&error) => self.inner.attempt(request).await,
            other => other,
        }
    }

    async fn settle_send(&self, group: &str, end: SendEnd) {
        self.inner.settle_send(group, end).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, RequestOptions};

    use super::*;
    use crate::client_versions::{versions_in, Net};

    /// An adapter whose attempts fail as scripted, noting the Grok version each would have sent.
    struct Scripted {
        base: MockProvider,
        versions: Arc<ClientVersions>,
        script: Mutex<Vec<ProviderError>>,
        sent: Mutex<Vec<String>>,
        attempts: AtomicUsize,
    }

    #[async_trait]
    impl ProviderAdapter for Scripted {
        fn id(&self) -> &ProviderId {
            self.base.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.base.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.base.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.base.keepalive()
        }
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            self.sent.lock().unwrap().push(self.versions.grok());
            Err(self.script.lock().unwrap().remove(0))
        }
    }

    fn refusal(status: u16, message: &str) -> ProviderError {
        let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
        error.status = Some(status);
        error.message = message.to_owned();
        error
    }

    fn request() -> Arc<ModelRequest> {
        Arc::new(ModelRequest { model: "grok-4".into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() })
    }

    async fn grok_after(script: Vec<ProviderError>, dialect: Dialect, env: &[(&str, &str)]) -> (Vec<String>, usize) {
        let dir = tempfile::tempdir().unwrap();
        let net = Arc::new(Net::default());
        let versions = versions_in(
            dir.path(),
            &net,
            env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect::<HashMap<_, _>>(),
            &Arc::new(AtomicU64::new(1_800_000_000_000)),
        );
        let inner = Arc::new(Scripted {
            base: MockProvider::new([]),
            versions: Arc::clone(&versions),
            script: Mutex::new(script),
            sent: Mutex::new(Vec::new()),
            attempts: AtomicUsize::new(0),
        });
        let wrapped = VersionedAdapter::wrap(inner.clone(), dialect, versions);
        let _ = wrapped.attempt(request()).await.err();
        let sent = inner.sent.lock().unwrap().clone();
        (sent, inner.attempts.load(Ordering::SeqCst))
    }

    /// `grok-oauth.mjs`: a 426 whose body states a minimum above the version in use is sent once
    /// more at the learned version; a second refusal, a minimum already met, another status and
    /// another dialect surface at once.
    #[tokio::test]
    async fn a_426_stating_a_higher_minimum_is_replayed_once_at_that_version() {
        let (sent, attempts) = grok_after(vec![refusal(426, "426: minimum version 1.0.95 required"), refusal(426, "minimum version 1.0.95")], Dialect::Grok, &[]).await;
        assert_eq!((attempts, sent), (2, vec!["1.0.70".to_owned(), "1.0.95".to_owned()]));
        // The replayed refusal is the send's result: no third attempt.
        let (_, attempts) = grok_after(vec![refusal(426, "minimum version 1.0.60"), refusal(426, "x")], Dialect::Grok, &[]).await;
        assert_eq!(attempts, 1);
        let (_, attempts) = grok_after(vec![refusal(400, "minimum version 1.0.95"), refusal(426, "x")], Dialect::Grok, &[]).await;
        assert_eq!(attempts, 1);
        let (_, attempts) = grok_after(vec![refusal(426, "minimum version 1.0.95"), refusal(426, "x")], Dialect::Cursor, &[]).await;
        assert_eq!(attempts, 1);
        let (_, attempts) = grok_after(vec![refusal(426, "minimum version 1.0.95"), refusal(426, "x")], Dialect::Grok, &[("MIXDOG_GROK_CLIENT_VERSION", "1.0.50")]).await;
        assert_eq!(attempts, 1);
        let mut emitted = refusal(426, "minimum version 1.0.95");
        emitted.exposure.text_emitted = true;
        let (_, attempts) = grok_after(vec![emitted, refusal(426, "x")], Dialect::Grok, &[]).await;
        assert_eq!(attempts, 1);
    }
}