//! What the per-route model metadata memo (`model-meta.mjs`, `lookupModelMeta`) asks of a registered provider.
//!
//! # The stored-row contract (frozen)
//!
//! A **stored row** is the JSON object a Node provider keeps for a listed model and answers unchanged from
//! `getCachedModelInfo` and `listModels()`: the row after that provider's own enrichment and adjustments, with Node's
//! key presence (a key the row never stated is absent; `null`, `false`, `0` and `[]` are values). Tests compare these
//! objects as JSON, never through typed fields (`EnrichedRow::eq` is always true).
//!
//! * **One producer function.** Every producer (a listing, a config initialization, a disk-cache hydration, a
//!   send-time population) builds the row from the provider's final typed record with
//!   [`stored_row`](super::stored_row); any step that changes the row after `enrich_listed` (Node's `{ ...row, key }`
//!   spreads, renames, removals) goes through [`restate_row`](super::restate_row) on the record *before* that call.
//!   `Value::Null` means the record kept no row; no producer substitutes a made-up one (`{ id }` would be pinned as a
//!   found row).
//! * **One store type.** The adapter keeps its rows in a [`RowStore`] (`provider._enrichedModels`): `replace` at the end
//!   of a listing, `upsert` for a send-time population, `replace` of the hydrated rows for a disk cache. A `Null` row is
//!   never stored, so a model whose row is unavailable is a cache miss, which is what Node's provider answers before it
//!   has the row.
//! * **One capability.** A provider whose Node class has `getCachedModelInfo` implements [`CachedModelInfo`] over its
//!   store, and `ProviderBuilder::cached_model_info` hands it to the registry; a provider whose class has none offers
//!   none, and the memo then answers the marked placeholder until a fetch.
//! * **One listing.** [`ListedRows`] is the provider's own `listModels()` as stored rows. A record that kept no
//!   row is not a candidate of the memo's `find` (never a found `{ id }`); `Err` is only for a listing that failed, which
//!   the memo treats as a throwing `listModels()`.
//!
//! Node asks the registry's provider object two things: `getCachedModelInfo(model)` (only some classes have it; it
//! answers the row the provider's own last listing stored, or, for a custom provider, the effective rows its config
//! states) and `listModels()`. A provider here offers the same through [`RouteProvider`]: the capability is owned by
//! the adapter that stores the rows ([`CachedModelInfo`]), the listing is the adapter's own.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_protocol::ProviderId;
use serde_json::Value;

/// `provider.getCachedModelInfo(model)`: the stored row of the model, as the provider stored it.
pub trait CachedModelInfo: Send + Sync {
    fn cached_row(&self, model: &str) -> Option<Arc<Value>>;
}

/// `provider.listModels()`: the rows one call returns. `Err` is a throw.
#[async_trait]
pub trait ListedRows: Send + Sync {
    async fn list_rows(&self) -> Result<Vec<Arc<Value>>, ()>;
}

/// `reg().getProvider(name)` as the memo reads it: `cached` is present when the provider's class has
/// `getCachedModelInfo`, `listing` when it has `listModels`.
#[derive(Clone, Default)]
pub struct RouteProvider {
    pub cached: Option<Arc<dyn CachedModelInfo>>,
    pub listing: Option<Arc<dyn ListedRows>>,
}

/// The registry's providers by name.
pub type RouteProviders = Arc<dyn Fn(&str) -> Option<RouteProvider> + Send + Sync>;

/// The rows a provider's last listing stored (`provider._enrichedModels`): absent until it has listed.
#[derive(Default)]
pub struct RowStore(Mutex<Option<Vec<Arc<Value>>>>);

impl RowStore {
    pub fn replace(&self, rows: Vec<Arc<Value>>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(rows.into_iter().filter(|row| !row.is_null()).collect());
    }

    /// One row learned outside a listing (a send-time population): it replaces the stored row of its id, or joins them.
    pub fn upsert(&self, row: Arc<Value>) {
        if row.is_null() {
            return;
        }
        let mut rows = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let rows = rows.get_or_insert_with(Vec::new);
        match rows.iter().position(|stored| stored.get("id") == row.get("id")) {
            Some(at) => rows[at] = row,
            None => rows.push(row),
        }
    }

    /// `rows.find((row) => row.id === model) || null`.
    pub fn find(&self, model: &str) -> Option<Arc<Value>> {
        let rows = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        rows.as_ref()?.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model)).cloned()
    }
}

/// An adapter's own `listModels`, as rows.
pub struct AdapterRows {
    pub provider: ProviderId,
    pub adapter: Arc<dyn ProviderAdapter>,
}

#[async_trait]
impl ListedRows for AdapterRows {
    async fn list_rows(&self) -> Result<Vec<Arc<Value>>, ()> {
        let Some(listing) = self.adapter.models() else { return Ok(Vec::new()) };
        let listed = listing.list_models().await.map_err(|_| ())?;
        let rows: Vec<Arc<Value>> = listed.into_iter().map(|record| Arc::new(super::sources::stored_row(&self.provider, record))).collect();
        // `models.find(m => m?.id === modelId)`: a record that kept no row is simply not a candidate.
        Ok(rows.into_iter().filter(|row| !row.is_null()).collect())
    }
}
