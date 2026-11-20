//! The Output Style list (`route-pickers/output-style-picker.mjs`), in its Settings form (Enter saves and returns) and its
//! onboarding form (row select or the confirm bar's Next saves, then the wizard advances).

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};

use super::options::text_of;
use crate::pickers::common::{
    CallerConfirm, ConfirmSpec, Onboarding, Own, PanelItem, PickerFn, PickerHandler, PickerHost, PickerPanel, check_row, picker_help, reset_surfaces,
    run_deferred,
};
use crate::slash::host::Tone;
use crate::slash::notices::{output_style_notice, truthy};
use crate::surface::SurfaceKind;

/// The options of `openOutputStylePicker(options)`.
#[derive(Clone, Default)]
pub struct OutputStyleOptions {
    pub return_to: Option<PickerFn>,
    pub handoff_panel: Option<PickerPanel>,
    /// Onboarding mode: Enter (row select) and the confirm bar's Next both persist the chosen style, then advance.
    pub onboarding: Option<Onboarding>,
    /// The caller's own confirm bar outside onboarding.
    pub confirm_bar: Option<CallerConfirm>,
}

/// `openOutputStylePicker(options)`.
pub fn open_output_style_picker(host: &mut dyn PickerHost, options: OutputStyleOptions) {
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    let status = match host.store_call("listOutputStyles", json!([])) {
        Ok(status) => status,
        Err(error) => {
            host.push_notice(&format!("could not list output styles: {error}"), Tone::Error);
            return;
        }
    };
    let styles = status.get("styles").and_then(Value::as_array).cloned().unwrap_or_default();
    if styles.is_empty() {
        host.push_notice("no output styles available", Tone::Warn);
        return;
    }
    let current_id = match text_of(status.get("current").and_then(|current| current.get("id"))) {
        id if !id.is_empty() => id,
        _ => "default".to_owned(),
    };
    let items: Vec<PanelItem> = styles
        .iter()
        .map(|style| {
            let id = text_of(style.get("id"));
            let label = match text_of(style.get("label")) {
                label if !label.is_empty() => label,
                _ => id.clone(),
            };
            let mut item = check_row(&id, &label, id == current_id);
            item.description = [text_of(style.get("description")), text_of(style.get("source"))]
                .into_iter()
                .find(|text| !text.is_empty())
                .unwrap_or_else(|| "output style".to_owned());
            PanelItem::new(item, json!({"_style": style}))
        })
        .collect();
    if !own.owns(host) {
        return;
    }
    reset_surfaces(host, &own);
    let onboarding = options.onboarding.is_some();
    let mut panel = PickerPanel::new("Output Style");
    panel.description = "Select response style.".to_owned();
    // Onboarding uses a confirm bar (left and right are Back and Next); the picker supplies its own help instead of a stale
    // hint.
    panel.help = picker_help(onboarding, options.return_to.is_some(), "\u{2191}/\u{2193} Select \u{b7} Enter Choose");
    panel.label_width = Some(18);
    panel.items = items;
    panel.confirm =
        if onboarding { Some(ConfirmSpec::back_next()) } else { options.confirm_bar.as_ref().map(|confirm| ConfirmSpec { buttons: confirm.buttons.clone() }) };
    panel.handler = Some(Rc::new(OutputStyleHandler { own: Rc::clone(&own), options, highlighted: RefCell::new(current_id) }));
    own.paint(host, Some(panel));
}

struct OutputStyleHandler {
    own: Rc<Own>,
    options: OutputStyleOptions,
    highlighted: RefCell<String>,
}

impl OutputStyleHandler {
    fn save_style(&self, host: &mut dyn PickerHost, style_id: &str, advance: bool) {
        if style_id.is_empty() {
            return;
        }
        let onboarding = self.options.onboarding.as_ref();
        // Onboarding advance: keep the current picker visible during the async style switch so the screen never flashes empty
        // between steps; the next step (or finishOnboarding) replaces/clears the picker itself.
        if !(advance && onboarding.is_some()) {
            self.own.paint(host, self.options.handoff_panel.clone());
        }
        // Post-ack delegation (next onboarding step, or back to the caller): bound after this keypress's own navigation so an
        // Esc while the switch is in flight cannot paint a panel over the new surface.
        let deferred = self.own.claim();
        let after_save = |host: &mut dyn PickerHost| {
            run_deferred(host, deferred, |host| match onboarding {
                Some(onboarding) if advance => onboarding.advance(host),
                _ => {
                    if let Some(return_to) = &self.options.return_to {
                        return_to(host);
                    }
                }
            });
        };
        match host.store_call("setOutputStyle", json!([style_id])) {
            Ok(result) => {
                if !truthy(&result) {
                    host.push_notice("Output style switch is already running.", Tone::Warn);
                } else {
                    host.push_notice(&output_style_notice(&result), Tone::Info);
                }
                after_save(host);
            }
            Err(error) => {
                host.push_notice(&format!("Couldn\u{2019}t switch output style: {error}"), Tone::Error);
                if self.options.handoff_panel.is_some() {
                    after_save(host);
                }
            }
        }
    }
}

impl PickerHandler for OutputStyleHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        let Some(style) = item.tag("_style") else { return };
        self.save_style(host, &text_of(style.get("id")), self.options.onboarding.is_some());
    }

    fn on_highlight(&self, _host: &mut dyn PickerHost, item: &PanelItem) {
        if let Some(style) = item.tag("_style") {
            let id = text_of(style.get("id"));
            if !id.is_empty() {
                *self.highlighted.borrow_mut() = id;
            }
        }
    }

    fn wants_highlight(&self) -> bool {
        self.options.onboarding.is_some()
    }

    fn on_confirm(&self, host: &mut dyn PickerHost, button: &str) {
        let Some(onboarding) = &self.options.onboarding else {
            if let Some(confirm) = &self.options.confirm_bar {
                (confirm.on_confirm)(host, button);
            }
            return;
        };
        if button == "back" {
            self.own.close(host);
            onboarding.back(host);
            return;
        }
        let highlighted = self.highlighted.borrow().clone();
        self.save_style(host, &highlighted, true);
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        if self.options.handoff_panel.is_some() {
            self.own.paint(host, self.options.handoff_panel.clone());
        } else {
            self.own.close(host);
        }
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
