//! The media model catalog loader (`catalog.mjs` `createMediaModelLoader`): one catalog request in
//! flight per credential, a 24 h cache, and the last successful catalog as the answer while the
//! provider is down. A catalog that is revoked, forbidden or unpaid is never served from the past,
//! and a lane that fell back is not asked again for 60 s. Where the rows come from (credentials,
//! HTTP) and where they are kept (a file per credential) are the [`CatalogSource`] and
//! [`CatalogCache`] the caller supplies.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::Value;

use super::catalog::{CatalogFailure, catalog_diagnostic};
use super::lanes::CatalogRows;

const RETRY_MS: i64 = 60_000;

/// What `source(lane)` answers: the credential's cache key and the provider catalog revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub key: String,
    pub revision: String,
    /// `false` for a catalog that has its own cache (the Codex account catalog).
    pub cached: bool,
}

#[async_trait]
pub trait CatalogSource: Send + Sync + 'static {
    /// `source(lane)`: resolves the credential; a missing one fails here.
    async fn target(&self, lane: &str) -> Result<Target, CatalogFailure>;
    /// `target.fetchModels()`: the provider's rows (anything but an array is an invalid answer).
    async fn fetch(&self, lane: &str) -> Result<Value, CatalogFailure>;
}

/// `cache(key)` / `cache(key, stale)`: the catalog saved for a credential. `stale` reads it
/// whatever its age.
#[async_trait]
pub trait CatalogCache: Send + Sync + 'static {
    async fn load(&self, key: &str, stale: bool) -> Option<Vec<Value>>;
    async fn save(&self, key: &str, rows: &[Value]);
}
type Flight = Shared<BoxFuture<'static, Result<CatalogRows, CatalogFailure>>>;

struct Retry {
    revision: String,
    at: i64,
    error: CatalogFailure,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, Flight>,
    revisions: HashMap<String, String>,
    retry_after: HashMap<String, Retry>,
}

/// The load that started a request owns its entry in `pending` and removes it when it is done
/// with the answer (`.finally(() => pending.delete(key))`, a turn after the request settles).
/// Calls made together with it all reach `pending` before it is gone, whichever of them the
/// executor happens to drive the request to its end.
struct Pending {
    state: Arc<Mutex<State>>,
    key: String,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.state.lock().unwrap().pending.remove(&self.key);
    }
}

pub struct ModelLoader {
    source: Arc<dyn CatalogSource>,
    cache: Arc<dyn CatalogCache>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    state: Arc<Mutex<State>>,
}

/// `staleCatalog(rows, error)`.
fn stale(rows: Vec<Value>, error: &CatalogFailure) -> CatalogRows {
    CatalogRows { rows, warning: Some(format!("Using the last successful model catalog. {}", catalog_diagnostic(error).1)) }
}

impl ModelLoader {
    pub fn new(source: Arc<dyn CatalogSource>, cache: Arc<dyn CatalogCache>, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { source, cache, now, state: Arc::default() }
    }

    /// `loadMediaModels(lane)`.
    pub async fn load(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        let Target { key, revision, cached } = self.source.target(lane).await?;
        let (flight, _owner) = {
            let mut state = self.state.lock().unwrap();
            // Joining a load in flight: the guard ends with this block, before any await.
            if let Some(flight) = state.pending.get(&key).cloned() {
                (flight, None)
            } else {
            let changed = state.revisions.get(&key).is_some_and(|known| *known != revision);
            let retry = state.retry_after.get(&key).filter(|retry| retry.revision == revision).map(|retry| (retry.at, retry.error.clone()));
            let (source, cache, now, shared) = (self.source.clone(), self.cache.clone(), self.now.clone(), self.state.clone());
            let (lane, key_owned) = (lane.to_owned(), key.clone());
            let flight: Flight = async move {
                Self::resolve(&source, &cache, &now, &shared, &lane, &key_owned, revision, cached, changed, retry).await
            }
            .boxed()
            .shared();
            state.pending.insert(key.clone(), flight.clone());
            (flight, Some(Pending { state: self.state.clone(), key }))
            }
        };
        flight.await
    }

    #[allow(clippy::too_many_arguments, reason = "one load's whole input")]
    async fn resolve(
        source: &Arc<dyn CatalogSource>,
        cache: &Arc<dyn CatalogCache>,
        now: &Arc<dyn Fn() -> i64 + Send + Sync>,
        shared: &Arc<Mutex<State>>,
        lane: &str,
        key: &str,
        revision: String,
        cached: bool,
        changed: bool,
        retry: Option<(i64, CatalogFailure)>,
    ) -> Result<CatalogRows, CatalogFailure> {
        if cached {
            // A lane that fell back is not asked again until its window ends.
            if let Some((_, error)) = retry.filter(|(at, _)| now() < *at) {
                if let Some(previous) = cache.load(key, true).await {
                    return Ok(stale(previous, &error));
                }
            }
            if !changed {
                if let Some(rows) = cache.load(key, false).await {
                    shared.lock().unwrap().revisions.insert(key.to_owned(), revision);
                    return Ok(CatalogRows { rows, warning: None });
                }
            }
        }
        // The request starts on the next turn (`Promise.resolve().then(fetch)`), so a call made
        // right behind this one joins it instead of starting its own.
        tokio::task::yield_now().await;
        let outcome = match source.fetch(lane).await {
            Ok(Value::Array(rows)) => Ok(rows),
            Ok(_) => Err(CatalogFailure::default()),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(rows) => {
                if cached {
                    cache.save(key, &rows).await;
                }
                let mut state = shared.lock().unwrap();
                state.revisions.insert(key.to_owned(), revision);
                state.retry_after.remove(key);
                Ok(CatalogRows { rows, warning: None })
            }
            // Only this credential's last successful catalog is a safe offline fallback. A
            // successful empty catalog is authoritative, not an outage.
            Err(error) => {
                let previous = if cached { cache.load(key, true).await } else { None };
                match previous {
                    // Revoked credentials and exhausted billing must not look available merely
                    // because this account had a successful catalog in the past.
                    Some(previous) if !matches!(error.code.as_deref(), Some("MEDIA_AUTH_REJECTED" | "MEDIA_ACCESS_DENIED" | "MEDIA_BILLING_BLOCKED")) => {
                        shared.lock().unwrap().retry_after.insert(key.to_owned(), Retry { revision, at: now() + RETRY_MS, error: error.clone() });
                        Ok(stale(previous, &error))
                    }
                    _ => Err(error),
                }
            }
        }
    }
}
