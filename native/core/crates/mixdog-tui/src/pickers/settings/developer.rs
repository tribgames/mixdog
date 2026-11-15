//! Settings, Developer (`maintenance-pickers/developer-picker.mjs`): level 1 lists the developer sections, level 2 the selected
//! section's options as On/Off toggles. Both levels render from `getDeveloperSettings`, so a new section or option needs no
//! code here. Turning on an option that carries a `warning` goes through a confirmation panel showing that warning; turning
//! an option off never asks.

use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::theme_color;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::panel::Panel;
use super::rows::{member, text_of};
use super::{PickerController, open_panel, report};
use crate::slash::host::{Opener, PromptSurface, Tone};
use crate::slash::notices::{truthy, value_text};

/// Picker footers truncate each line to the panel width rather than wrap, so the warning is pre-wrapped to a width that still
/// fits an 80-column terminal.
const WARNING_WRAP_COLUMNS: usize = 60;

/// Which level is up.
enum Screen {
    Sections,
    Section(String),
    /// The warning of `option` of section `.0`, asked before the option turns on.
    Confirm(String, Value),
}

/// The Developer panel on screen.
pub struct DeveloperPicker {
    own: Own,
    return_to: bool,
    screen: Screen,
    /// The sections as the last read gave them: the rows' options, which the handlers act on.
    sections: Vec<Value>,
    panel: Panel,
}

/// `wrapText(text, width)`: non-empty lines, or one empty line.
fn wrapped_lines(text: &str, width: usize) -> Vec<String> {
    let wrapped = wrap_ansi(text.trim_end(), width, WrapOptions { hard: false, word_wrap: true, trim: false });
    let lines: Vec<String> = wrapped.split('\n').filter(|line| !line.is_empty()).map(str::to_owned).collect();
    if lines.is_empty() { vec![String::new()] } else { lines }
}

fn read_sections(host: &mut dyn PickerHost) -> Vec<Value> {
    match host.store_call("getDeveloperSettings", json!([])) {
        Ok(settings) => member(&settings, "sections").as_array().cloned().unwrap_or_default(),
        Err(error) => {
            report(host, "developer settings unavailable", &error, Tone::Error);
            Vec::new()
        }
    }
}

fn options_of(section: &Value) -> &[Value] {
    member(section, "options").as_array().map(|list| list.as_slice()).unwrap_or(&[])
}

fn on_off(option: &Value) -> &'static str {
    if truthy(member(option, "enabled")) { "On" } else { "Off" }
}

/// `openDeveloperPicker(options)`: `{ returnTo }`.
pub fn open_developer_picker(host: &mut dyn PickerHost, options: &Value) -> Option<DeveloperPicker> {
    // The claim is taken at the user's open action: every paint re-validates, so a read settling after Esc never paints over
    // the user's surface.
    let mut picker = DeveloperPicker {
        own: Own::take(host),
        return_to: truthy(member(options, "returnTo")),
        screen: Screen::Sections,
        sections: Vec::new(),
        panel: Panel::default(),
    };
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    picker.own.clear_context(host);
    host.close_usage_panel();
    picker.render_sections(host, None);
    Some(picker)
}

impl DeveloperPicker {
    fn paint(&mut self, host: &mut dyn PickerHost, panel: Panel) -> bool {
        let painted = self.own.paint(host, &panel);
        if painted {
            self.panel = panel;
        }
        painted
    }

    fn render_sections(&mut self, host: &mut dyn PickerHost, focus: Option<&str>) {
        let sections = read_sections(host);
        let items: Vec<PickerItem> = sections
            .iter()
            .map(|section| {
                let mut item = PickerItem::new(&text_of(member(section, "id")), &text_of(member(section, "label")));
                item.meta = format!("{} on", options_of(section).iter().filter(|option| truthy(member(option, "enabled"))).count());
                item.description =
                    options_of(section).iter().map(|option| text_of(member(option, "label"))).collect::<Vec<_>>().join(", ");
                item
            })
            .collect();
        let panel = Panel {
            title: "Developer".to_owned(),
            description: "Developer-only options.".to_owned(),
            help: Some("\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} Esc Back".to_owned()),
            index_mode: Some(IndexMode::Always),
            label_width: Some(18),
            meta_width: Some(10),
            initial_index: Panel::focus_index(&items, focus),
            items,
            ..Panel::default()
        };
        self.sections = sections;
        self.screen = Screen::Sections;
        self.paint(host, panel);
    }

    fn render_section(&mut self, host: &mut dyn PickerHost, section_id: &str, focus: Option<&str>) {
        let sections = read_sections(host);
        let Some(section) = sections.iter().find(|section| text_of(member(section, "id")) == section_id).cloned() else {
            self.render_sections(host, Some(section_id));
            return;
        };
        let items: Vec<PickerItem> = options_of(&section)
            .iter()
            .map(|option| {
                let mut item = PickerItem::new(&text_of(member(option, "id")), &text_of(member(option, "label")));
                item.meta = on_off(option).to_owned();
                item.description = text_of(member(option, "description"));
                item
            })
            .collect();
        let panel = Panel {
            title: format!("Developer \u{b7} {}", text_of(member(&section, "label"))),
            description: "Developer-only options.".to_owned(),
            help: Some("\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Toggle On/Off \u{b7} Enter Toggle \u{b7} Esc Back".to_owned()),
            index_mode: Some(IndexMode::Always),
            label_width: Some(26),
            meta_width: Some(10),
            initial_index: Panel::focus_index(&items, focus),
            items,
            ..Panel::default()
        };
        self.sections = sections;
        self.screen = Screen::Section(section_id.to_owned());
        self.paint(host, panel);
    }

    fn option(&self, section_id: &str, option_id: &str) -> Option<Value> {
        let section = self.sections.iter().find(|section| text_of(member(section, "id")) == section_id)?;
        options_of(section).iter().find(|option| text_of(member(option, "id")) == option_id).cloned()
    }

    fn back_to_section(&mut self, host: &mut dyn PickerHost, section_id: &str, option: &Value) {
        self.render_section(host, section_id, Some(&text_of(member(option, "id"))));
    }

    fn write_option(&mut self, host: &mut dyn PickerHost, section_id: &str, option: &Value, enabled: bool) {
        // Bound to the claim on this keypress: a write acking after Esc must not re-open the panel.
        let settled = self.own.defer();
        let label = text_of(member(option, "label"));
        match host.store_call("setDeveloperOption", json!([member(option, "id"), enabled])) {
            Ok(next) if truthy(&next) => {
                // A provider option adds or removes that provider's models: the next /model or /agents open must not serve
                // the cached list.
                if truthy(member(option, "provider")) {
                    host.clear_model_caches("all");
                }
                host.push_notice(&format!("{label} {}", if enabled { "on" } else { "off" }), Tone::Info);
            }
            Ok(_) => host.push_notice("developer settings unavailable", Tone::Warn),
            Err(error) => report(host, &format!("{label} failed"), &error, Tone::Error),
        }
        if self.own.holds(host, settled) {
            self.back_to_section(host, section_id, option);
        }
    }

    /// Only Accept writes; Cancel and Esc return to the section unchanged.
    fn confirm_option(&mut self, host: &mut dyn PickerHost, section_id: &str, option: &Value) {
        let warning = member(option, "warning");
        let footer = wrapped_lines(&value_text(warning), WARNING_WRAP_COLUMNS)
            .into_iter()
            .enumerate()
            .map(|(index, text)| FooterInput::Object {
                glyph: if index == 0 { "!" } else { " " }.to_owned(),
                color: Some(theme_color(Key::Warning)),
                text: text.trim().to_owned(),
            })
            .collect();
        let panel = Panel {
            title: format!("Turn on {}", text_of(member(option, "label"))),
            index_mode: Some(IndexMode::Always),
            label_width: Some(26),
            items: vec![PickerItem::new("cancel", "Cancel"), PickerItem::new("accept", "Accept risk and turn on")],
            footer,
            ..Panel::default()
        };
        self.paint(host, panel);
        self.screen = Screen::Confirm(section_id.to_owned(), option.clone());
    }

    fn apply_option(&mut self, host: &mut dyn PickerHost, section_id: &str, option: Option<Value>, enabled: bool) {
        let Some(option) = option else { return };
        if member(&option, "enabled") == &Value::Bool(enabled) {
            return;
        }
        if enabled && truthy(member(&option, "warning")) {
            self.confirm_option(host, section_id, &option);
        } else {
            self.write_option(host, section_id, &option, enabled);
        }
    }

    fn arrow(&mut self, host: &mut dyn PickerHost, value: &str, enabled: bool) {
        if let Screen::Section(section_id) = &self.screen {
            let section_id = section_id.clone();
            let option = self.option(&section_id, value);
            self.apply_option(host, &section_id, option, enabled);
        }
    }
}

impl PickerController for DeveloperPicker {
    fn panel(&self) -> &Panel {
        &self.panel
    }

    fn left(&mut self, host: &mut dyn PickerHost, value: &str) {
        self.arrow(host, value, false);
    }

    fn right(&mut self, host: &mut dyn PickerHost, value: &str) {
        self.arrow(host, value, true);
    }

    fn select(&mut self, host: &mut dyn PickerHost, value: &str) {
        match &self.screen {
            Screen::Sections => self.render_section(host, value, None),
            Screen::Section(section_id) => {
                let section_id = section_id.clone();
                let option = self.option(&section_id, value);
                let enabled = option.as_ref().is_none_or(|option| !truthy(member(option, "enabled")));
                self.apply_option(host, &section_id, option, enabled);
            }
            Screen::Confirm(section_id, option) => {
                let (section_id, option) = (section_id.clone(), option.clone());
                if value == "accept" {
                    self.write_option(host, &section_id, &option, true);
                } else {
                    self.back_to_section(host, &section_id, &option);
                }
            }
        }
    }

    fn cancel(&mut self, host: &mut dyn PickerHost) {
        match &self.screen {
            Screen::Sections => {
                self.own.close(host);
                if self.return_to {
                    open_panel(host, Opener::Settings, json!({}));
                }
            }
            Screen::Section(section_id) => {
                let section_id = section_id.clone();
                self.render_sections(host, Some(&section_id));
            }
            Screen::Confirm(section_id, option) => {
                let (section_id, option) = (section_id.clone(), option.clone());
                self.back_to_section(host, &section_id, &option);
            }
        }
    }
}
