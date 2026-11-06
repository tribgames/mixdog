//! `HopDeps.wiring` and `HopDeps.errors` over the process services ([`HopBindings::new`]).
//!
//! - `errors` is `presentErrorText(error)` (`route-fallback.mjs:51`): the one function the
//!   provider errors of the whole product are phrased with.
//! - `wiring` is [`RouteWirer`], the factory the turn start uses for `RunSettings.effort` and
//!   `.text_only`, over a [`WiringSource`] that reads the provider object's facts the way Node
//!   does: its config entry, the custom protocol, the cached model row, the Anthropic effort
//!   gates of the catalog's caps (the release-generation floor for an undescribed id) and the
//!   wire value of an effort name.

use std::sync::Arc;

use mixdog_agent::text_only::MediaText;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::effort::reasoning_row;
use mixdog_ai::providers::custom::reasoning::{is_custom_provider_name, resolve};
use mixdog_ai::service::error_text::{present_error_text, ErrorView, PresentOptions};
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_protocol::ProviderId;
use serde_json::{json, Value};

use super::builder_env::CatalogCaps;
use mixdog_core_run::run_host::hop_host::ErrorText;
use mixdog_core_run::run_host::hop_host::HopWiring;
use super::ladder_sources::{cached_row, custom_config, provider_entry};
use super::process::{LocalModels, ProcessServices};
use mixdog_core_run::run_host::route_wiring::AnthropicEffortGates;
use mixdog_core_run::run_host::route_wiring::CodexDeclared;
use mixdog_core_run::run_host::route_wiring::LocalEntry;
use mixdog_core_run::run_host::route_wiring::ProviderFacts;
use mixdog_core_run::run_host::route_wiring::RouteWirer;
use mixdog_core_run::run_host::route_wiring::WiringSource;
use mixdog_core_config::config::Config;

/// What the hop host takes from the process.
pub struct HopBindings {
    pub wiring: Arc<dyn HopWiring>,
    pub errors: ErrorText,
}

struct ProcessWiring {
    catalog: Arc<CatalogService>,
    config: Config,
    caps: CatalogCaps,
    local: Arc<dyn LocalModels>,
}

impl WiringSource for ProcessWiring {
    fn facts(&self, provider: &str, model: &str, _adapter: &Arc<dyn ProviderAdapter>) -> ProviderFacts {
        let config = provider_entry(&self.config, provider).unwrap_or_else(|| json!({}));
        let custom = custom_config(&self.config, provider);
        let cached = cached_row(&self.catalog, &self.config, provider, model).map(Value::Object);
        let wire: mixdog_agent::effort::WireEffort = match (is_custom_provider_name(provider), &custom, &cached) {
            // A custom route sends the level its row maps the effort to.
            (true, Some((protocol, base_url)), row) => {
                let (protocol, base_url) = (protocol.clone(), base_url.clone());
                let row = reasoning_row(row.as_ref().unwrap_or(&Value::Null));
                Arc::new(move |effort| resolve(&protocol, &row, Some(effort), &base_url).level.map(str::to_owned))
            }
            _ => Arc::new(|effort| Some(effort.to_owned())),
        };
        ProviderFacts {
            config,
            protocol: custom.map(|(protocol, _)| serde_json::to_value(protocol).ok().and_then(|v| v.as_str().map(str::to_owned))).flatten(),
            cached_model: cached,
            gates: AnthropicEffortGates::for_model(model, self.caps.caps(model).as_ref()),
            wire,
        }
    }

    fn local_entry(&self, model: &str) -> Option<LocalEntry> {
        self.local.entry(model)
    }

    fn runtime_tools(&self, model: &str) -> Option<bool> {
        self.local.runtime_tools(model)
    }

    fn media(&self, updated: &Value) -> Arc<dyn MediaText> {
        self.local.media(updated)
    }
}

impl HopBindings {
    pub fn new(p: &ProcessServices) -> Self {
        let source = ProcessWiring {
            catalog: p.catalog.clone(),
            config: p.config.clone(),
            caps: CatalogCaps::new(p.catalog.clone(), &*p.env),
            local: p.local.clone(),
        };
        let catalog = p.catalog.clone();
        let codex_declared: Arc<CodexDeclared> = Arc::new(move |id| {
            let snapshot = catalog.snapshot();
            snapshot.models_of(&ProviderId::from("openai-oauth")).iter().find(|r| r.id == id).and_then(|r| r.supports_reasoning_effort_updates)
        });
        let unsupported: Arc<UnsupportedEfforts> = p.unsupported.clone();
        Self {
            wiring: Arc::new(RouteWirer::new(Arc::new(source), unsupported, codex_declared)),
            errors: Arc::new(|error| present_error_text(&ErrorView::from(error), &PresentOptions::default())),
        }
    }
}
