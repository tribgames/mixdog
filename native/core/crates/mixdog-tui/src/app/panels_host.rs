//! [`PanelsHost`]: the `/doctor`, `/usage`, `/context` and `/btw` controllers' side of the application.

use serde_json::Value;

use super::AppState;
use super::picker::AppPicker;
use crate::panels::{ContextPanel, ContextWindows, PanelsHost};
use crate::slash::host::Tone;
use crate::surface::owner::PanelSurface;

impl PanelsHost for AppState {
    type Picker = AppPicker;

    fn surface(&mut self) -> &mut PanelSurface<AppPicker, ContextPanel, Value> {
        &mut self.surface
    }

    fn store_has(&self, name: &str) -> bool {
        self.store.has_method(name)
    }

    fn read_store(&mut self, name: &str, args: Value) -> Option<Result<Value, String>> {
        if !self.store.has_method(name) {
            return None;
        }
        Some(self.call_store(name, args))
    }

    fn clear_text_prompts(&mut self) {
        self.provider_prompt = None;
        self.settings_prompt = None;
    }

    fn close_usage_panel(&mut self) {
        self.surface.close_usage();
    }

    fn notify(&mut self, text: &str, tone: Tone) {
        self.notice(text, tone);
    }

    fn context_windows(&self) -> ContextWindows {
        let state = self.store.state();
        ContextWindows {
            context_window: state.get("contextWindow").cloned().unwrap_or(Value::Null),
            raw_context_window: state.get("rawContextWindow").cloned().unwrap_or(Value::Null),
        }
    }
}
