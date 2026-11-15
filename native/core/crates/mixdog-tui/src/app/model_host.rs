//! [`PickerHost`] of the model, web search, agents, workflow, output style, theme and effort pickers: the picker on the surface,
//! the live route state, the catalog caches and the background refresh.

use serde_json::{Value, json};

use super::picker::AppPicker;
use super::AppState;
use crate::pickers::common::{PickerFn, PickerHost, PickerPanel, ProviderSetupRequest, RouteState};
use crate::pickers::model::catalog::{CatalogRefresh, ModelCatalogCaches};
use crate::pickers::provider::{Callback, SetupOptions, open_provider_setup as open_setup};
use crate::slash::host::{Opener, Tone};
use crate::surface::SurfaceClaim;


fn text(state: &Value, key: &str) -> String {
    match state.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

impl AppState {
    /// Holds `continuation` until the provider setup that was opened for it asks for it; the id goes in the callback.
    pub(crate) fn hold_continuation(&mut self, continuation: PickerFn) -> u64 {
        self.continuations.push(Some(continuation));
        (self.continuations.len() - 1) as u64
    }

    /// Runs a held continuation once.
    pub(crate) fn run_continuation(&mut self, id: u64) {
        let taken = usize::try_from(id).ok().and_then(|index| self.continuations.get_mut(index)).and_then(Option::take);
        if let Some(continuation) = taken {
            continuation(self);
        }
    }
}

impl PickerHost for AppState {
    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.notice(text, tone);
    }

    fn now_ms(&self) -> u64 {
        self.clock.now()
    }

    fn route_state(&self) -> RouteState {
        let state = self.store.state();
        RouteState {
            provider: text(&state, "provider"),
            model: text(&state, "model"),
            effort: state.get("effort").and_then(Value::as_str).filter(|effort| !effort.is_empty()).map(str::to_owned),
            fast: state.get("fast").and_then(Value::as_bool),
            model_parameters: state.get("modelParameters").cloned().unwrap_or(Value::Null),
            context_percent: state.get("contextPercent").cloned().unwrap_or(Value::Null),
            effort_options: state.get("effortOptions").and_then(Value::as_array).cloned().unwrap_or_default(),
            busy: state.get("busy") == Some(&Value::Bool(true)),
        }
    }

    fn clear_prompts(&mut self) {
        self.provider_prompt = None;
        self.settings_prompt = None;
    }

    fn clear_context_panel(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim> {
        self.clear_context_guarded(claim)
    }

    fn close_usage_panel(&mut self) {
        self.surface.close_usage();
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        self.close_guarded(claim);
    }

    fn paint_picker(&mut self, claim: SurfaceClaim, panel: Option<PickerPanel>) -> Option<SurfaceClaim> {
        self.paint_guarded(claim, panel.map(AppPicker::Model))
    }

    fn model_caches(&mut self) -> &mut ModelCatalogCaches {
        &mut self.caches
    }

    fn schedule_catalog_refresh(&mut self, job: CatalogRefresh) {
        self.catalog_jobs.push_back(job);
    }

    fn open_provider_setup(&mut self, request: ProviderSetupRequest) {
        let id = self.hold_continuation(request.on_continue);
        let options = SetupOptions {
            title: request.title,
            continue_label: request.continue_label,
            continue_description: request.continue_description,
            on_continue: Some(Callback::Open(Opener::Model, json!({ "continuation": id }))),
            ..SetupOptions::default()
        };
        open_setup(self, options);
    }
}
