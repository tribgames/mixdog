//! The keys of the picker on screen. The selection state is the widget's ([`PickerState`]); what a key asks for ([`PickerAction`])
//! is answered by the family that painted the panel: the model pickers' handler, the settings controller, the provider setup
//! and wizard, the extension pickers, or the slash dispatch's own panels.

use mixdog_term::KeyFlags;
use mixdog_term::clipboard::copy_to_clipboard;
use mixdog_tui_widgets::picker::state::{PickerAction, PickerKeyContext, PickerState};
use mixdog_tui_widgets::picker::{PickerItem, PickerProps, effective_visible_limit};

use super::AppState;
use super::picker::{AppPicker, SlashPanel, SlashPanelKind};
use crate::pickers::common::PanelItem;
use crate::pickers::provider::{cancel as provider_cancel, confirm as provider_confirm, highlight as provider_highlight, select as provider_select};
use crate::pickers::settings::PickerController;
use crate::slash::{stop_prompt_cancel, stop_prompt_select};
use crate::surface::SurfaceKind;
use crate::surface::epoch::PanelValue;

fn row_value(items: &[PickerItem], index: usize) -> String {
    items.get(index).map(|item| item.value.clone()).unwrap_or_default()
}

impl AppState {
    /// The picker the keys go to, with the selection state in step with its rows: a panel with a new identity starts from its
    /// initial row, a rebuild of the same panel keeps the selected row by value. `None` without a picker.
    fn picker_for_keys(&mut self) -> Option<(AppPicker, PickerProps)> {
        let picker = self.surface.picker().cloned()?;
        let mut props = picker.props(self.view_columns, 0);
        if self.picker_visible_rows > 0 {
            props.visible_count = self.picker_visible_rows;
        }
        let identity = format!("{}|{}|{}", picker.kind(), picker.title(), picker.picker_key());
        let initial = Some(picker.initial_index());
        if identity == self.picker_identity {
            self.picker_state.sync_items(&props.items, initial);
        } else {
            self.picker_identity = identity;
            self.picker_state = PickerState::new(&props.items, initial);
            self.picker_highlight = None;
        }
        self.report_highlight(&picker);
        Some((picker, props))
    }

    /// The selected row of the picker on screen (for the view).
    pub fn picker_selection(&mut self) -> Option<(usize, i64)> {
        self.picker_for_keys()?;
        Some((self.picker_state.selected_index, self.picker_state.confirm_focus))
    }

    /// The highlight moved onto a row (`onHighlight`), once per move and once for the initial selection.
    fn report_highlight(&mut self, picker: &AppPicker) {
        let index = self.picker_state.selected_index;
        if self.picker_highlight == Some(index) {
            return;
        }
        self.picker_highlight = Some(index);
        match picker {
            AppPicker::Model(panel) => {
                if let (Some(handler), Some(item)) = (panel.handler.clone(), panel.items.get(index)) {
                    if handler.wants_highlight() {
                        handler.on_highlight(self, item);
                    }
                }
            }
            AppPicker::Provider(panel) => provider_highlight(self, &panel.owner, index),
            AppPicker::Settings(_) | AppPicker::Ext(_) | AppPicker::Slash(_) => {}
        }
    }

    /// One key at the picker on screen; false when no picker is on screen (the key is not this surface's).
    pub fn picker_input(&mut self, input: &str, key: &KeyFlags) -> bool {
        let Some((picker, props)) = self.picker_for_keys() else { return false };
        let context = PickerKeyContext {
            item_count: props.items.len(),
            effective_visible_limit: effective_visible_limit(&props, self.picker_state.selected_index),
            confirm_buttons: props.confirm_buttons.len(),
            has_detail: !props.detail.is_empty(),
        };
        let now = self.clock.now();
        let action = self.picker_state.handle_key(input, key, &context, now);
        self.report_highlight(&picker);
        match action {
            PickerAction::None => {}
            PickerAction::Select(index) => self.picker_select(&picker, index),
            PickerAction::Cancel => self.picker_cancel(&picker),
            PickerAction::Left(index) => self.picker_adjust(&picker, index, Adjust::Left),
            PickerAction::Right(index) => self.picker_adjust(&picker, index, Adjust::Right),
            PickerAction::Tab(index) => self.picker_adjust(&picker, index, Adjust::Tab),
            PickerAction::Confirm(button) => {
                let value = props.confirm_buttons.get(button).map(|button| button.value.clone()).unwrap_or_default();
                self.picker_confirm(&picker, &value);
            }
            PickerAction::CopyUrl => {
                // Failing to copy leaves the URL on screen to be copied by hand.
                let _ = copy_to_clipboard(&mut std::io::stdout(), &props.detail, false);
            }
            PickerAction::Key(index) => self.picker_char(&picker, input, index),
        }
        true
    }

    fn panel_item(items: &[PanelItem], index: usize) -> Option<PanelItem> {
        items.get(index).cloned()
    }

    fn picker_select(&mut self, picker: &AppPicker, index: usize) {
        match picker {
            AppPicker::Model(panel) => {
                if let (Some(handler), Some(item)) = (panel.handler.clone(), Self::panel_item(&panel.items, index)) {
                    handler.on_select(self, &item);
                }
            }
            AppPicker::Settings(panel) => {
                let value = row_value(&panel.items, index);
                self.with_settings_picker(|controller, host| controller.select(host, &value));
            }
            AppPicker::Provider(panel) => provider_select(self, &panel.owner, index),
            AppPicker::Ext(panel) => {
                let panel = panel.clone();
                self.with_extensions(|extensions, host| extensions.select(host, &panel, index));
            }
            AppPicker::Slash(SlashPanel { kind: SlashPanelKind::StopConfirm { claim }, items, .. }) => {
                stop_prompt_select(self, *claim, &row_value(items, index));
            }
            AppPicker::Slash(_) => {}
        }
    }

    fn picker_cancel(&mut self, picker: &AppPicker) {
        match picker {
            AppPicker::Model(panel) => {
                if let Some(handler) = panel.handler.clone() {
                    handler.on_cancel(self);
                }
            }
            AppPicker::Settings(_) => self.with_settings_picker(|controller, host| controller.cancel(host)),
            AppPicker::Provider(panel) => provider_cancel(self, &panel.owner),
            AppPicker::Ext(panel) => {
                let panel = panel.clone();
                self.with_extensions(|extensions, host| extensions.cancel(host, &panel));
            }
            AppPicker::Slash(SlashPanel { kind: SlashPanelKind::StopConfirm { claim }, .. }) => stop_prompt_cancel(self, *claim),
            AppPicker::Slash(SlashPanel { kind: SlashPanelKind::Loading, .. }) => {
                let claim = self.surface.surface_claim(SurfaceKind::Picker);
                self.close_guarded(claim);
            }
        }
    }

    fn picker_adjust(&mut self, picker: &AppPicker, index: usize, direction: Adjust) {
        match picker {
            AppPicker::Model(panel) => {
                let (Some(handler), item) = (panel.handler.clone(), Self::panel_item(&panel.items, index)) else { return };
                match direction {
                    Adjust::Left => handler.on_left(self, item.as_ref()),
                    Adjust::Right => handler.on_right(self, item.as_ref()),
                    Adjust::Tab => handler.on_tab(self, item.as_ref()),
                }
            }
            AppPicker::Settings(panel) => {
                let value = row_value(&panel.items, index);
                match direction {
                    Adjust::Left => self.with_settings_picker(|controller, host| controller.left(host, &value)),
                    Adjust::Right => self.with_settings_picker(|controller, host| controller.right(host, &value)),
                    Adjust::Tab => {}
                }
            }
            AppPicker::Ext(panel) => {
                if !matches!(direction, Adjust::Tab) {
                    let panel = panel.clone();
                    self.with_extensions(|extensions, host| extensions.adjust(host, &panel, index));
                }
            }
            AppPicker::Provider(_) | AppPicker::Slash(_) => {}
        }
    }

    fn picker_confirm(&mut self, picker: &AppPicker, button: &str) {
        match picker {
            AppPicker::Model(panel) => {
                if let Some(handler) = panel.handler.clone() {
                    handler.on_confirm(self, button);
                }
            }
            AppPicker::Settings(_) => self.with_settings_picker(|controller, host| controller.confirm(host, button)),
            AppPicker::Provider(panel) => provider_confirm(self, &panel.owner, button),
            AppPicker::Ext(_) | AppPicker::Slash(_) => {}
        }
    }

    /// Any other typed key (`onKey(input, key, item)`).
    fn picker_char(&mut self, picker: &AppPicker, input: &str, index: usize) {
        match picker {
            AppPicker::Model(panel) => {
                if let Some(handler) = panel.handler.clone() {
                    handler.on_key(self, input, Self::panel_item(&panel.items, index).as_ref());
                }
            }
            AppPicker::Ext(panel) => {
                if let Some(ch) = input.chars().next() {
                    let panel = panel.clone();
                    self.with_extensions(|extensions, host| extensions.key(host, &panel, ch, Some(index)));
                }
            }
            AppPicker::Settings(_) | AppPicker::Provider(_) | AppPicker::Slash(_) => {}
        }
    }

    /// Runs `run` on the controller of the settings picker on screen, taken out for the call: the controller stays when the picker
    /// it painted is still the one on screen and it was not replaced by another.
    fn with_settings_picker(&mut self, run: impl FnOnce(&mut dyn PickerController, &mut AppState)) {
        let Some(mut controller) = self.settings_picker.take() else { return };
        run(controller.as_mut(), self);
        if self.settings_picker.is_none() && matches!(self.surface.live_picker(), Some(AppPicker::Settings(_))) {
            self.settings_picker = Some(controller);
        }
    }
}

#[derive(Clone, Copy)]
enum Adjust {
    Left,
    Right,
    Tab,
}
