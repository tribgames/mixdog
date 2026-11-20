//! The Auto-clear panel (`maintenance-pickers/auto-clear-picker.mjs`): the on/off toggle with its lead-cache TTL note, and the
//! Advanced list of provider default idle windows edited as text.

use mixdog_tui_style::Key;
use mixdog_tui_style::theme::theme_color;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::panel::Panel;
use super::rows::{member, text_of};
use super::{PickerController, duration_text, open_panel, report};
use crate::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{first_truthy_text, truthy, value_text};

// The lead messages cache TTL follows autoClear: off or an idle window of an hour or more (including unlimited) keeps the 1h
// cache, a shorter idle window the 5m one.
const HOUR_MS: f64 = 60.0 * 60.0 * 1000.0;
/// Typed (and shown) for "never auto-clear"; the runtime stores it as 0.
const UNLIMITED_INPUT: &str = "unlimited";

/// `formatDurationInput(ms, unlimited)`: the duration as it is typed back (`1h`, `30m`, `45s`, `1500ms`).
fn duration_input(ms: &Value, unlimited: bool) -> String {
    if unlimited {
        return UNLIMITED_INPUT.to_owned();
    }
    let number = mixdog_js::to_number(ms);
    let value = mixdog_js::math::round(if number.is_nan() { 0.0 } else { number }).max(0.0);
    let divisible = |unit: f64| value > 0.0 && value % unit == 0.0;
    if divisible(HOUR_MS) {
        format!("{}h", mixdog_js::number_to_string(value / HOUR_MS))
    } else if divisible(60_000.0) {
        format!("{}m", mixdog_js::number_to_string(value / 60_000.0))
    } else if divisible(1000.0) {
        format!("{}s", mixdog_js::number_to_string(value / 1000.0))
    } else {
        format!("{}ms", mixdog_js::number_to_string(value))
    }
}

/// Which of the two panels is up.
enum Screen {
    /// The toggle, with the state it was painted from (`enabled`).
    Main { enabled: bool },
    /// The provider list, with the entries it was painted from.
    Advanced { entries: Vec<Value> },
}

/// The Auto-clear panel on screen.
pub struct AutoClearPicker {
    own: Own,
    return_to: bool,
    screen: Screen,
    panel: Panel,
}

/// `readCurrent()`: the setting, `Null` when it cannot be read.
fn read_current(host: &mut dyn PickerHost) -> Value {
    host.store_call("getAutoClear", json!([])).ok().filter(truthy).unwrap_or(Value::Null)
}

/// `openAutoClearPicker(options)`: `{ advanced, returnTo }`.
pub fn open_auto_clear_picker(host: &mut dyn PickerHost, options: &Value) -> Option<AutoClearPicker> {
    // The claim is taken at the user's open action: every paint re-validates and re-arms it, so a read settling after Esc,
    // on open or on any later toggle, can never paint over the user's surface.
    let mut picker = AutoClearPicker {
        own: Own::take(host),
        return_to: truthy(member(options, "returnTo")),
        screen: Screen::Main { enabled: true },
        panel: Panel::default(),
    };
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    picker.own.clear_context(host);
    host.close_usage_panel();
    if member(options, "advanced") == &Value::Bool(true) {
        picker.render_advanced(host);
    } else {
        picker.render(host);
    }
    Some(picker)
}

impl AutoClearPicker {
    fn paint(&mut self, host: &mut dyn PickerHost, panel: Panel) {
        if self.own.paint(host, &panel) {
            self.panel = panel;
        }
    }

    fn provider_default_items(current: &Value) -> Vec<PickerItem> {
        let provider = first_truthy_text(current, &["provider"]).unwrap_or_else(|| "default".to_owned());
        member(current, "providerDefaults")
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| {
                let name = value_text(member(entry, "provider"));
                let mut item = PickerItem::new(&format!("provider:{name}"), &name);
                if name == provider {
                    item.marker = "\u{2713}".to_owned();
                }
                item.marker_color = Some(theme_color(Key::Success));
                let window = if truthy(member(entry, "unlimited")) { "Unlimited".to_owned() } else { duration_text(member(entry, "idleMs")) };
                item.meta = format!("{window}{}", if truthy(member(entry, "custom")) { " custom" } else { "" });
                item.description = format!("Default idle window for {name}. Enter to edit as text.");
                item
            })
            .collect()
    }

    fn render_advanced(&mut self, host: &mut dyn PickerHost) {
        let current = read_current(host);
        let items = Self::provider_default_items(&current);
        let entries = member(&current, "providerDefaults").as_array().cloned().unwrap_or_default();
        let panel = Panel {
            title: "Auto-clear \u{b7} Advanced".to_owned(),
            description: "Provider idle windows override the global duration. Enter edits the duration text.".to_owned(),
            help: Some("\u{2191}/\u{2193} Select \u{b7} Enter Edit \u{b7} Esc Back".to_owned()),
            index_mode: Some(IndexMode::Always),
            label_width: Some(18),
            meta_width: Some(18),
            items,
            ..Panel::default()
        };
        self.paint(host, panel);
        self.screen = Screen::Advanced { entries };
    }

    fn render(&mut self, host: &mut dyn PickerHost) {
        let current = read_current(host);
        let enabled = member(&current, "enabled") != &Value::Bool(false);
        let idle_ms = if truthy(member(&current, "idleMs")) { mixdog_js::to_number(member(&current, "idleMs")) } else { HOUR_MS };
        let unlimited = member(&current, "unlimited") == &Value::Bool(true);
        let cache_ttl = if !enabled || idle_ms >= HOUR_MS { "1h" } else { "5m" };
        let provider = first_truthy_text(&current, &["provider"]).unwrap_or_else(|| "default".to_owned());
        let source = if truthy(member(&current, "providerCustom")) {
            format!("{} override", text_of(member(&current, "provider")))
        } else if truthy(member(&current, "custom")) {
            "global".to_owned()
        } else {
            format!("{provider} default")
        };
        let idle = duration_text(&json!(idle_ms));
        let clear_text = if unlimited { format!("Never clear idle sessions ({source})") } else { format!("Clear idle sessions after {idle} ({source})") };
        let mut toggle = PickerItem::new("toggle", "Auto-clear");
        toggle.meta = if enabled { "On" } else { "Off" }.to_owned();
        toggle.description = if enabled { format!("{clear_text} \u{b7} lead cache TTL {cache_ttl}.") } else { "Idle auto-clear disabled.".to_owned() };
        let mut advanced = PickerItem::new("advanced", "Advanced");
        advanced.description = "Edit provider-paired default idle windows as text.".to_owned();
        let window = if enabled && !unlimited { format!("{idle} ({source})") } else { "never".to_owned() };
        let panel = Panel {
            title: "Auto-clear".to_owned(),
            description: format!("Clear idle context after {window} \u{b7} lead cache TTL {cache_ttl}."),
            help: Some("\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Toggle On/Off \u{b7} Enter Open/Toggle \u{b7} Esc Close".to_owned()),
            index_mode: Some(IndexMode::Always),
            label_width: Some(10),
            items: vec![toggle, advanced],
            ..Panel::default()
        };
        self.paint(host, panel);
        self.screen = Screen::Main { enabled };
    }

    fn apply(&mut self, host: &mut dyn PickerHost, patch: Value) {
        // Bound to the claim on this keypress: a write acking after Esc must not re-open the Auto-clear panel.
        let settled = self.own.defer();
        match host.store_call("setAutoClear", json!([patch])) {
            Ok(next) if truthy(&next) => {
                let notice = if !truthy(member(&next, "enabled")) {
                    "autoclear off".to_owned()
                } else if truthy(member(&next, "unlimited")) {
                    "autoclear on \u{b7} unlimited".to_owned()
                } else {
                    format!("autoclear on \u{b7} idle {}", duration_text(member(&next, "idleMs")))
                };
                host.push_notice(&notice, Tone::Info);
            }
            Ok(_) => host.push_notice("autoclear unavailable", Tone::Warn),
            Err(error) => report(host, "autoclear failed", &error, Tone::Error),
        }
        if self.own.holds(host, settled) {
            self.render(host);
        }
    }

    fn open_duration_editor(&mut self, host: &mut dyn PickerHost, entry: &Value) {
        let provider = member(entry, "provider");
        if !truthy(provider) {
            return;
        }
        let name = value_text(provider);
        self.own.close(host);
        let built_in = duration_input(member(entry, "builtInMs"), truthy(member(entry, "builtInUnlimited")));
        let mut prompt = TextPrompt::new("autoclear-provider");
        prompt.label = format!("Auto-clear \u{b7} {name}");
        prompt.hint = format!("Type a duration like 10m, 1h, or 24h, or {UNLIMITED_INPUT} to never auto-clear. Empty resets to built-in {built_in}.");
        prompt.initial_value = Some(duration_input(member(entry, "idleMs"), truthy(member(entry, "unlimited"))));
        prompt.fields.insert("provider".to_owned(), provider.clone());
        if !member(entry, "builtInMs").is_null() {
            prompt.fields.insert("builtInMs".to_owned(), member(entry, "builtInMs").clone());
        }
        // The Node prompt carried the function that re-opens Settings; the host finds it from this flag.
        if self.return_to {
            prompt.fields.insert("_returnTo".to_owned(), Value::Bool(true));
        }
        host.set_prompt(PromptSurface::Settings, Some(prompt));
    }
}

impl PickerController for AutoClearPicker {
    fn panel(&self) -> &Panel {
        &self.panel
    }

    fn left(&mut self, host: &mut dyn PickerHost, value: &str) {
        if value == "toggle" && matches!(self.screen, Screen::Main { .. }) {
            self.apply(host, json!({"enabled": false}));
        }
    }

    fn right(&mut self, host: &mut dyn PickerHost, value: &str) {
        if value == "toggle" && matches!(self.screen, Screen::Main { .. }) {
            self.apply(host, json!({"enabled": true}));
        }
    }

    fn select(&mut self, host: &mut dyn PickerHost, value: &str) {
        match &self.screen {
            Screen::Main { enabled } => {
                let enabled = *enabled;
                match value {
                    "toggle" => self.apply(host, json!({"enabled": !enabled})),
                    "advanced" => self.render_advanced(host),
                    _ => {}
                }
            }
            Screen::Advanced { entries } => {
                let entry = entries.iter().find(|entry| format!("provider:{}", value_text(member(entry, "provider"))) == value).cloned();
                if let Some(entry) = entry {
                    self.open_duration_editor(host, &entry);
                }
            }
        }
    }

    fn cancel(&mut self, host: &mut dyn PickerHost) {
        if matches!(self.screen, Screen::Advanced { .. }) {
            self.render(host);
            return;
        }
        self.own.close(host);
        if self.return_to {
            open_panel(host, Opener::Settings, json!({}));
        }
    }
}
