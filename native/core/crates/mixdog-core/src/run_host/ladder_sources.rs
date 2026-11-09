//! `LadderSources` over the process services ([`ProcessLadder::new`]): what the step judge's
//! ladder reads off the route (`step-auto-effort.mjs:164-167`).
//!
//! - the provider's cached model row (`providerImpl.getCachedModelInfo`), asked of every provider
//!   (`autoEffortModel`): the stored row of the registered provider's own listing, for a provider whose class has
//!   the function (`CatalogService::cached_row`). A custom provider's is its discovered rows under the config's
//!   overrides; before any listing it holds the rows its config states (`effectiveCustomModelRows(config, [])`);
//! - the rejected efforts (`rejectedEffortLevelsSync`): the process's rejection store;
//! - a custom provider's protocol and base URL (`providerClient.customConfig`): its config entry;
//! - the Anthropic efforts (`anthropicEffortLevelsFor`): [`CatalogCaps::effort_levels_for`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::providers::custom::Protocol;
use serde_json::{Map, Value};

use super::builder_env::CatalogCaps;
use super::process::{EffortRejections, ProcessServices};
use super::step_judge::LadderSources;
use mixdog_core_config::config::Config;

/// `config.providers[provider]`.
pub(super) fn provider_entry(config: &Config, provider: &str) -> Option<Value> {
    config.agent().get("providers").and_then(|p| p.get(provider)).filter(|v| v.is_object()).cloned()
}

/// The row a provider's `getCachedModelInfo(model)` answers (`providerImpl.getCachedModelInfo`): the provider's own
/// stored row, asked of the registered provider; none for a provider whose class has no such function. A custom
/// provider's holds the rows its config states from the moment it is built.
pub(super) fn cached_row(catalog: &CatalogService, provider: &str, model: &str) -> Option<Map<String, Value>> {
    catalog.cached_row(provider, model)?.as_object().cloned()
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
        cached_row(&self.catalog, provider, model)
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
