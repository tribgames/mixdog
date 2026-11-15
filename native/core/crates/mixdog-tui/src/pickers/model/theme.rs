//! The Theme picker and the Effort picker (`src/tui/app/theme-effort-pickers.mjs`).
//!
//! The theme calls are the store's (`listThemes`, `getTheme`, `setTheme(id, { persist })`): the host binds them to the live
//! palette of `mixdog_tui_style::theme` (`list_themes`, `get_theme_setting`, `set_theme`, applied in this process first, as the
//! preview) and persists `ui.theme` through the core's `config/setTheme` when `persist` is set.

use std::cell::RefCell;
use std::rc::Rc;

use mixdog_tui_widgets::picker::PickerItem;
use mixdog_view_model::display::clean::clean;
use serde_json::{Value, json};

use super::options::text_of;
use crate::pickers::common::{
    CallerConfirm, ConfirmSpec, Onboarding, Own, PanelItem, PickerFn, PickerHandler, PickerHost, PickerPanel, check_row,
    picker_help, reset_surfaces,
};
use crate::slash::host::Tone;
use crate::slash::notices::{theme_notice, truthy};
use crate::surface::SurfaceKind;

/// The options of `openThemePicker(options)`.
#[derive(Clone, Default)]
pub struct ThemeOptions {
    pub return_to: Option<PickerFn>,
    pub handoff_panel: Option<PickerPanel>,
    /// Onboarding: Enter (row) and the confirm bar's Next both persist the highlighted theme, then advance; Back restores the
    /// original palette then steps back.
    pub onboarding: Option<Onboarding>,
    /// The caller's own confirm bar outside onboarding.
    pub confirm_bar: Option<CallerConfirm>,
}

/// `openThemePicker(options)`.
pub fn open_theme_picker(host: &mut dyn PickerHost, options: ThemeOptions) {
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    let themes = match host.store_call("listThemes", json!([])) {
        Ok(Value::Array(themes)) => themes,
        Ok(_) => Vec::new(),
        Err(error) => {
            host.push_notice(&format!("could not list themes: {error}"), Tone::Error);
            return;
        }
    };
    if themes.is_empty() {
        host.push_notice("no themes available", Tone::Warn);
        return;
    }
    let from_store = host.store_call("getTheme", json!([])).ok().map(|id| text_of(Some(&id))).filter(|id| !id.is_empty());
    let current_id = from_store
        .or_else(|| themes.iter().find(|theme| theme.get("current").is_some_and(truthy)).map(|theme| text_of(theme.get("id"))).filter(|id| !id.is_empty()))
        .unwrap_or_else(|| text_of(themes[0].get("id")));
    let items: Vec<PanelItem> = themes
        .iter()
        .map(|entry| {
            let id = text_of(entry.get("id"));
            let label = match text_of(entry.get("label")) {
                label if !label.is_empty() => label,
                _ => id.clone(),
            };
            let mut item = PickerItem::new(&id, &label);
            if id == current_id {
                item.marker = "\u{2713}".to_owned();
            }
            item.description = match text_of(entry.get("description")) {
                description if !description.is_empty() => description,
                _ => "color theme".to_owned(),
            };
            PanelItem::new(item, json!({"_theme": entry}))
        })
        .collect();
    reset_surfaces(host, &own);
    let onboarding = options.onboarding.is_some();
    let mut panel = PickerPanel::new("Theme");
    panel.description = "Choose the color theme that looks best with your terminal.".to_owned();
    panel.help = picker_help(onboarding, options.return_to.is_some(), "\u{2191}/\u{2193} Preview \u{b7} Enter Choose");
    panel.label_width = Some(22);
    panel.initial_index = Some(items.iter().position(|item| item.item.value == current_id).unwrap_or(0));
    panel.items = items;
    panel.confirm = if onboarding {
        Some(ConfirmSpec::back_next())
    } else {
        options.confirm_bar.as_ref().map(|confirm| ConfirmSpec { buttons: confirm.buttons.clone() })
    };
    panel.handler = Some(Rc::new(ThemeHandler { own: Rc::clone(&own), options, highlighted: RefCell::new(current_id.clone()), current_id }));
    own.paint(host, Some(panel));
}

struct ThemeHandler {
    own: Rc<Own>,
    options: ThemeOptions,
    highlighted: RefCell<String>,
    /// The theme active before the picker opened: Esc restores it.
    current_id: String,
}

impl ThemeHandler {
    fn apply_theme(host: &mut dyn PickerHost, id: &str, persist: bool) -> Option<Value> {
        match host.store_call("setTheme", json!([id, {"persist": persist}])) {
            Ok(applied) => Some(applied),
            Err(error) => {
                host.push_notice(&format!("Couldn\u{2019}t set theme: {error}"), Tone::Error);
                None
            }
        }
    }

    /// The surface is handed back: the handoff panel, else the picker closes.
    fn hand_back(&self, host: &mut dyn PickerHost) {
        if self.options.handoff_panel.is_some() {
            self.own.paint(host, self.options.handoff_panel.clone());
        } else {
            self.own.close(host);
        }
    }

    /// Onboarding: Enter (row) and the confirm bar's Next both persist the highlighted theme, then advance.
    fn save_theme(&self, host: &mut dyn PickerHost, id: &str, advance: bool) {
        self.hand_back(host);
        let applied = Self::apply_theme(host, id, true).filter(truthy).unwrap_or_else(|| json!({"id": id}));
        host.push_notice(&theme_notice(&applied), Tone::Info);
        match &self.options.onboarding {
            Some(onboarding) if advance => onboarding.advance(host),
            _ => {
                if let Some(return_to) = &self.options.return_to {
                    return_to(host);
                }
            }
        }
    }

    /// Restores the theme that was active before the picker opened (without persisting).
    fn restore(&self, host: &mut dyn PickerHost) {
        if !self.current_id.is_empty() {
            Self::apply_theme(host, &self.current_id, false);
        }
    }
}

impl PickerHandler for ThemeHandler {
    /// Live preview while moving: apply (no persist) so the surface re-tones as the selection moves. Enter persists; Esc
    /// restores the original.
    fn on_highlight(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        if let Some(entry) = item.tag("_theme") {
            let id = text_of(entry.get("id"));
            if !id.is_empty() {
                *self.highlighted.borrow_mut() = id.clone();
                Self::apply_theme(host, &id, false);
            }
        }
    }

    fn wants_highlight(&self) -> bool {
        true
    }

    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        let Some(entry) = item.tag("_theme") else { return };
        self.save_theme(host, &text_of(entry.get("id")), self.options.onboarding.is_some());
    }

    fn on_confirm(&self, host: &mut dyn PickerHost, button: &str) {
        let Some(onboarding) = &self.options.onboarding else {
            if let Some(confirm) = &self.options.confirm_bar {
                (confirm.on_confirm)(host, button);
            }
            return;
        };
        if button == "back" {
            // Restore the palette active before the picker opened, then step back.
            self.restore(host);
            onboarding.back(host);
            return;
        }
        let highlighted = self.highlighted.borrow().clone();
        self.save_theme(host, &highlighted, true);
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        self.hand_back(host);
        self.restore(host);
        match &self.options.onboarding {
            Some(onboarding) => onboarding.cancel(host),
            None => {
                if let Some(return_to) = &self.options.return_to {
                    return_to(host);
                }
            }
        }
    }
}

/// `openEffortPicker()`: the reasoning effort of the current model.
pub fn open_effort_picker(host: &mut dyn PickerHost) {
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    host.clear_prompts();
    let state = host.route_state();
    if state.effort_options.is_empty() {
        host.push_notice("Current model has no effort levels.", Tone::Warn);
        return;
    }
    let current = match state.effort.as_deref().filter(|effort| !effort.is_empty()) {
        Some(effort) => effort.to_owned(),
        None => text_of(state.effort_options[0].get("value")),
    };
    let items = state
        .effort_options
        .iter()
        .map(|entry| {
            let value = text_of(entry.get("value"));
            let mut item = check_row(&value, &text_of(entry.get("label")), value == current);
            let description = entry.get("description").cloned();
            let current_word = mixdog_js::js_to_lowercase(&clean(description.as_ref())) == "current";
            item.description = if current_word { String::new() } else { text_of(description.as_ref()) };
            PanelItem::new(item, Value::Null)
        })
        .collect();
    let mut panel = PickerPanel::new("Effort");
    panel.description = "Reasoning effort for the current model.".to_owned();
    panel.items = items;
    panel.handler = Some(Rc::new(EffortHandler { own: Rc::clone(&own) }));
    own.paint(host, Some(panel));
}

struct EffortHandler {
    own: Rc<Own>,
}

impl PickerHandler for EffortHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        self.own.close(host);
        // Mid-turn picks are allowed; the running turn keeps its own effort.
        let pending_turn = if host.route_state().busy { " (applies from the next turn)" } else { "" };
        match host.store_call("setEffort", json!([item.item.value])) {
            Ok(result) if truthy(&result) => host.push_notice(&format!("Effort set to {}{pending_turn}", text_of(Some(&result))), Tone::Info),
            Ok(_) => host.push_notice("Effort switch is already running.", Tone::Warn),
            Err(error) => host.push_notice(&format!("Couldn\u{2019}t switch effort: {error}"), Tone::Error),
        }
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        self.own.close(host);
    }
}
