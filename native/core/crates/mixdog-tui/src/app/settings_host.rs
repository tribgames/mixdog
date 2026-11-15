//! `PickerHost` of the settings pickers (Settings, auto-clear, profile, update, developer): the picker claim and the panel
//! they paint. The controller of the picker on screen is [`AppState::settings_picker`].

use serde_json::Value;

use super::AppState;
use super::picker::AppPicker;
use crate::pickers::model::options::route_model_label;
use crate::pickers::settings::SettingsState;
use crate::pickers::settings::host::PickerHost;
use crate::pickers::settings::panel::Panel;
use crate::surface::{SurfaceClaim, SurfaceKind};

impl PickerHost for AppState {
    fn claim_picker(&mut self) -> SurfaceClaim {
        self.surface.surface_claim(SurfaceKind::Picker)
    }

    fn paint_panel(&mut self, claim: SurfaceClaim, panel: &Panel) -> Option<SurfaceClaim> {
        self.paint_guarded(claim, Some(AppPicker::Settings(panel.clone())))
    }

    fn clear_context(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim> {
        self.clear_context_guarded(claim)
    }

    fn settings_state(&mut self) -> &mut SettingsState {
        &mut self.settings_state
    }

    fn route_model_label(&self, route: &Value) -> String {
        route_model_label(route)
    }
}
