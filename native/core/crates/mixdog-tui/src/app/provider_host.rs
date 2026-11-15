//! [`ProviderHost`] and [`ModelLabels`]: the provider setup picker and the first-run wizard's side of the application: the panel
//! they paint, the flow they keep, the wizard state, the sign-in watch and the background prefetch.

use mixdog_tui_widgets::picker::MetaPart;
use serde_json::Value;

use super::picker::AppPicker;
use super::timers::OAuthWatch;
use super::AppState;
use crate::pickers::model::catalog::CatalogKind;
use crate::pickers::model::options::{agent_model_parts, model_description, normalize_model_options, provider_display_rank};
use crate::pickers::provider::{ModelLabels, OnboardingState, Prefetch, ProviderHost, ProviderPanel, ProviderSetup};
use crate::surface::SurfaceClaim;

impl ModelLabels for AppState {
    fn provider_display_rank(&self, provider: &str) -> f64 {
        provider_display_rank(provider)
    }

    fn normalize_model_options(&self, models: &[Value]) -> Vec<Value> {
        normalize_model_options(models)
    }

    fn model_description(&self, model: &Value) -> String {
        model_description(model)
    }

    fn agent_model_parts(&self, route: Option<&Value>) -> Vec<MetaPart> {
        let none = Value::Null;
        agent_model_parts(route.unwrap_or(&none))
    }
}

impl ProviderHost for AppState {
    fn paint_provider_panel(&mut self, claim: SurfaceClaim, panel: Option<ProviderPanel>) -> Option<SurfaceClaim> {
        self.paint_guarded(claim, panel.map(AppPicker::Provider))
    }

    fn watch_oauth_flow(&mut self, flow_id: &str) {
        let now = self.clock.now();
        self.oauth_watches.push(OAuthWatch::provider(flow_id, now));
    }

    fn take_provider_flow(&mut self) -> Option<ProviderSetup> {
        self.provider_flow.take()
    }

    fn put_provider_flow(&mut self, flow: ProviderSetup) {
        self.provider_flow = Some(flow);
    }

    fn has_provider_flow(&self) -> bool {
        self.provider_flow.is_some()
    }

    fn onboarding(&mut self) -> &mut OnboardingState {
        &mut self.onboarding
    }

    fn set_onboarding_active(&mut self, active: bool) {
        self.onboarding_active = active;
    }

    fn start_step2_prefetch(&mut self, wants: Prefetch) {
        if wants.provider_models || wants.agents {
            self.prefetches.push_back(wants);
        }
    }

    fn set_provider_models_cache(&mut self, models: &[Value], at_ms: u64) {
        self.caches.store(CatalogKind::Provider, Some(models.to_vec()), at_ms);
    }
}
