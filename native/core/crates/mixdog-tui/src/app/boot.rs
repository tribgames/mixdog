//! The first mount of the application (`App.jsx`'s first render and its mount effects).
//!
//! What the first frame must already show is decided here synchronously: with the session empty and the first-run wizard not owning
//! the screen, the project list is on the surface as a loading frame (`useProjectPickerBoot`: built in the render phase, so there
//! is no picker-less flash frame). The reads that fill it, the disabled-skill set and the wizard's launch run afterwards as
//! background work ([`super::AppState::run_background`]), after that frame was painted.

use super::AppState;
use super::picker::AppPicker;
use crate::pickers::extensions::project::initial_project_panel;
use crate::pickers::provider::resolve_onboarding_completed;
use serde_json::json;

impl AppState {
    /// The first mount. Idempotent.
    pub fn mount(&mut self) {
        if self.mounted {
            return;
        }
        self.mounted = true;
        self.sync_welcome_hint();
        let verdict = self.options.onboarding_completed;
        let completed =
            resolve_onboarding_completed(verdict, || self.store.has_method("getOnboardingStatus").then(|| self.call_store("getOnboardingStatus", json!([]))));
        let onboarding_owns_screen = !completed || self.options.force_onboarding;
        if !onboarding_owns_screen && self.item_count() == 0 {
            let cwd = self.session_cwd();
            self.set_picker(Some(AppPicker::Ext(initial_project_panel(&cwd))));
            self.project_boot_pending = true;
        }
        self.disabled_skills_pending = true;
        self.start_onboarding_gate();
        self.schedule_catalog_prefetch();
    }

    /// `state.cwd || process.cwd()`.
    pub(crate) fn session_cwd(&self) -> String {
        match self.store.state().get("cwd").and_then(serde_json::Value::as_str) {
            Some(cwd) if !cwd.is_empty() => cwd.to_owned(),
            _ => self.options.cwd.clone(),
        }
    }
}
