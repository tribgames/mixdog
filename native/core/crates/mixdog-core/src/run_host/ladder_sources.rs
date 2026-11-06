//! `LadderSources` over the process services ([`ProcessLadder::new`]): what the step judge's
//! ladder reads off the route (`step-auto-effort.mjs:164-167`).
//!
//! - the provider's cached model row (`providerImpl.getCachedModelInfo`), asked of every provider
//!   (`autoEffortModel`): the row the catalog lists for the model stands for the adapter's own
//!   listing. A custom provider's listing is already its discovered rows under the config's
//!   overrides; before any listing it holds the rows its config states
//!   (`effectiveCustomModelRows(config, [])`);
//! - the rejected efforts (`rejectedEffortLevelsSync`): the process's rejection store;
//! - a custom provider's protocol and base URL (`providerClient.customConfig`): its config entry;
//! - the Anthropic efforts (`anthropicEffortLevelsFor`): [`CatalogCaps::effort_levels_for`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::providers::custom::listing::{manual_rows, public_rows};
use mixdog_ai::providers::custom::reasoning::is_custom_provider_name;
use mixdog_ai::providers::custom::Protocol;
use mixdog_protocol::ProviderId;
use serde_json::{json, Map, Value};

use super::builder_env::CatalogCaps;
use super::process::{EffortRejections, ProcessServices};
use super::step_judge::LadderSources;
use crate::config::Config;

/// `config.providers[provider]`.
pub(super) fn provider_entry(config: &Config, provider: &str) -> Option<Value> {
    config.agent().get("providers").and_then(|p| p.get(provider)).filter(|v| v.is_object()).cloned()
}

/// The row a provider's `getCachedModelInfo(model)` answers.
pub(super) fn cached_row(catalog: &CatalogService, config: &Config, provider: &str, model: &str) -> Option<Map<String, Value>> {
    let listed = || {
        let snapshot = catalog.snapshot();
        let record = snapshot.models_of(&ProviderId::from(provider)).iter().find(|r| r.id == model)?.clone();
        let mut row = catalog.model_meta(provider, model).as_object().cloned()?;
        if let Some(custom) = &record.picker.custom_reasoning {
            row.insert("customReasoning".into(), json!(custom));
        }
        Some(row)
    };
    if is_custom_provider_name(provider) {
        return listed().or_else(|| {
            provider_entry(config, provider).and_then(|entry| {
                public_rows(&manual_rows(&entry)).into_iter().find(|r| r.get("id").and_then(Value::as_str) == Some(model)).and_then(|r| r.as_object().cloned())
            })
        });
    }
    listed()
}

/// The protocol and base URL of a custom provider's config entry.
pub(super) fn custom_config(config: &Config, provider: &str) -> Option<(Protocol, String)> {
    let entry = provider_entry(config, provider)?;
    let protocol = serde_json::from_value(entry.get("protocol")?.clone()).ok()?;
    let base_url = entry.get("baseURL").and_then(Value::as_str).unwrap_or_default().to_owned();
    Some((protocol, base_url))
}

pub struct ProcessLadder {
    catalog: Arc<CatalogService>,
    config: Config,
    rejections: Arc<dyn EffortRejections>,
    caps: CatalogCaps,
}

impl ProcessLadder {
    pub fn new(p: &ProcessServices) -> Self {
        Self {
            catalog: p.catalog.clone(),
            config: p.config.clone(),
            rejections: p.rejections.clone(),
            caps: CatalogCaps::new(p.catalog.clone(), &*p.env),
        }
    }
}

#[async_trait]
impl LadderSources for ProcessLadder {
    fn cached_row(&self, provider: &str, model: &str) -> Option<Map<String, Value>> {
        cached_row(&self.catalog, &self.config, provider, model)
    }

    async fn rejected(&self, provider: &str, model_id: &str) -> Option<RejectionEntry> {
        self.rejections.entry(provider, model_id).await
    }

    fn custom_config(&self, provider: &str) -> Option<(Protocol, String)> {
        custom_config(&self.config, provider)
    }

    fn anthropic_levels(&self, model: &str) -> Vec<String> {
        self.caps.effort_levels_for(model)
    }
}
