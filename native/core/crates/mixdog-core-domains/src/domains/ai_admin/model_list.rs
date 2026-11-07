//! `model/list`: Node's `listProviderModels` (`collectProviderModels`, session-runtime/
//! provider-models.mjs) over the resident [`CatalogService`].
//!
//! Node keeps two caches under it: the process-wide provider catalog with its partial-answer
//! backoff (`provider-catalog-cache.mjs`) and the flattened rows (`providerModelsCache`). The
//! catalog snapshot already holds the first, with each provider's last-listing status
//! (`CatalogSnapshot::status`), so nothing is cached here: every read flattens the snapshot
//! again, which is what Node does with its cached rows (availability, saved settings and the
//! sort are applied at read time anyway).
//!
//! The rows are Node's: the listing object of every model (`listing_value`) goes through
//! `providerModelCacheRow`, hidden ones leave the picker, and the rest are hydrated with the
//! user's saved settings and sorted route-provider-first. A partial answer says so on every row
//! (`catalogPartial`, `catalogMissing`, `catalogRetryAt`); a quick read of a complete catalog is
//! marked `catalogComplete`. A forced read asks every provider again first.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot};
use mixdog_ai::effort::effort_items_for;
use mixdog_ai::service::admin_models::{
    HydrationFacts, hydrate_provider_model_row, is_selectable_llm_model, model_proxy_client_mode, provider_available,
    provider_model_cache_row, sort_provider_models, with_catalog_state,
};
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::effort_configuration::{UnsupportedEfforts, custom_auto_effort_capable, effort_configuration_mode};
use mixdog_ai::service::model_listing::listing_value;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_app_protocol::v2::params::ModelListParams;
use mixdog_core_api::call::{CoreRequest, Reply};
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::{Admit, DomainService};
use serde_json::{Value, json};

use mixdog_core_config::config::Config;

const LIST: &str = "model/list";

pub struct ModelListService {
    pub catalog: Arc<CatalogService>,
    pub config: Config,
    /// The provider of the live route (`route().provider`): its models list first.
    pub primary_provider: Arc<dyn Fn() -> String + Send + Sync>,
    /// The models that rejected a mid-conversation effort update in this process.
    pub unsupported: Arc<UnsupportedEfforts>,
}

/// The facts row hydration reads, over the catalog and the effort modules.
struct RowFacts<'a> {
    catalog: &'a CatalogService,
    snapshot: &'a CatalogSnapshot,
    unsupported: &'a UnsupportedEfforts,
    config: &'a Obj,
}

impl HydrationFacts for RowFacts<'_> {
    fn fast_capable(&self, provider: &str, row: &Value) -> bool {
        self.catalog.fast_capable(provider, row, None, &json!({}))
    }

    fn ultrafast_capable(&self, provider: &str, row: &Value) -> bool {
        self.catalog.ultrafast_capable(provider, row)
    }

    fn effort_items(&self, provider: &str, row: &Value) -> Value {
        Value::Array(
            effort_items_for(provider, row, None, None)
                .into_iter()
                .map(|item| json!({ "value": item.value, "label": item.label, "description": item.description }))
                .collect(),
        )
    }

    fn effort_configuration_mode(&self, provider: &str, model: &str, opts: &Value) -> bool {
        // `codexModelSupportsEffortUpdates(id)`: the OAuth catalog's own statement for the model.
        let declared = |id: &str| {
            let (_, records) = self.snapshot.models.iter().find(|(p, _)| p.as_str() == "openai-oauth")?;
            records.iter().find(|r| r.id == id)?.supports_reasoning_effort_updates
        };
        effort_configuration_mode(provider, &Value::from(model), opts, self.unsupported, &declared).is_some()
    }

    fn custom_auto_effort_capable(&self, provider: &str, protocol: Option<&Value>, row: &Value) -> bool {
        custom_auto_effort_capable(provider, protocol, row)
    }

    /// `getProvider(provider)?.config`: the provider's entry of the configuration it was built from.
    fn provider_config(&self, provider: &str) -> Obj {
        self.config.get("providers").and_then(|p| p.get(provider)).and_then(Value::as_object).cloned().unwrap_or_default()
    }
}

impl ModelListService {
    /// The catalog before the first read: a snapshot nothing was listed into (the compiled-in
    /// generation) is listed now, as Node's first full read loads every provider.
    pub async fn ready(&self, force: bool, provider: Option<&str>) {
        if force {
            // `forceRefresh && provider` (`catalog-load.mjs` `prepare`): only the providers the
            // name matches are asked again.
            match provider.filter(|p| !p.is_empty()) {
                Some(provider) => self.catalog.refresh_matching(provider).await,
                None => self.catalog.refresh().await,
            };
            return;
        }
        let snapshot = self.catalog.snapshot();
        if snapshot.generation == 0 && snapshot.status.is_empty() {
            self.catalog.refresh_due().await;
        }
    }

    /// `collectProviderModels({ force, quick })`.
    pub async fn rows(&self, force: bool, quick: bool) -> Vec<Value> {
        self.rows_for(force, quick, None).await
    }

    /// `collectProviderModels({ force, quick, provider })`: `provider` scopes a forced refresh.
    pub async fn rows_for(&self, force: bool, quick: bool, provider: Option<&str>) -> Vec<Value> {
        self.ready(force, provider).await;
        let snapshot = self.catalog.snapshot();
        let mut rows = self.from_cache_rows(&snapshot, &self.cache_rows(&snapshot));
        if snapshot.partial() {
            let missing: Vec<String> = snapshot.missing().iter().map(|id| id.as_str().to_owned()).collect();
            let retry_at = snapshot.retry_at().map_or(f64::NAN, |at| at as f64);
            return with_catalog_state(rows, Some((&missing, retry_at)));
        }
        // A quick answer from the loaded catalog already is the full catalog; saying so lets a
        // caller skip the full read it would otherwise follow up with.
        if quick && !force && snapshot.complete() {
            for row in &mut rows {
                if let Some(row) = row.as_object_mut() {
                    row.insert("catalogComplete".into(), Value::Bool(true));
                }
            }
        }
        rows
    }

    /// The catalog flattened into deduplicated cache rows; a hidden custom model leaves the picker.
    pub fn cache_rows(&self, snapshot: &CatalogSnapshot) -> Vec<Value> {
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for (provider, records) in &snapshot.models {
            let name = provider.as_str();
            for record in records {
                let listing = listing_value(record);
                if record.id.is_empty() || !is_selectable_llm_model(&listing) {
                    continue;
                }
                let catalog_row = self.catalog.model_meta(name, &record.id);
                let web_search = web_search_capable_for(name, &record.id, Some(&listing), Some(&catalog_row));
                let row = provider_model_cache_row(name, &listing, web_search);
                if !seen.insert(format!("{name}:{}", record.id)) || row.get("hidden") == Some(&Value::Bool(true)) {
                    continue;
                }
                rows.push(Value::Object(row));
            }
        }
        rows
    }

    /// `providerModelsFromCacheRows`: availability applied at read time, then hydrated and sorted.
    pub fn from_cache_rows(&self, snapshot: &CatalogSnapshot, rows: &[Value]) -> Vec<Value> {
        let config = self.config.agent();
        let developer = config.get("developer").cloned().unwrap_or(Value::Null);
        let client_mode = model_proxy_client_mode(&|name| std::env::var(name).ok());
        let facts = RowFacts { catalog: &self.catalog, snapshot, unsupported: &self.unsupported, config: &config };
        let mut rows: Vec<Value> = rows
            .iter()
            .filter(|row| provider_available(row.get("provider").and_then(Value::as_str).unwrap_or_default(), client_mode, &developer))
            .map(|row| hydrate_provider_model_row(&config, row, &facts))
            .collect();
        sort_provider_models(&mut rows, &(self.primary_provider)());
        rows
    }
}

fn invalid(expected: &str) -> CoreError {
    CoreError::InvalidParams { path: "params".into(), expected: expected.into() }
}

#[async_trait]
impl DomainService for ModelListService {
    fn methods(&self) -> &'static [&'static str] {
        &[LIST]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ModelListParams = serde_json::from_value(req.params).map_err(|e| invalid(&e.to_string()))?;
        // `refresh` is the setup tool's name for `force`.
        let force = params.force == Some(true) || params.refresh == Some(true);
        Ok(Reply::Value(Value::Array(self.rows(force, params.quick == Some(true)).await)))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
