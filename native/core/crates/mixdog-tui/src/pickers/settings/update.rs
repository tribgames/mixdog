//! The Update panel (`maintenance-pickers/update-picker.mjs`): installed and latest versions from the daemon, the auto-update
//! toggle, re-check, and the in-place update run.

use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::panel::Panel;
use super::rows::{member, text_of};
use super::{PickerController, answered, open_panel, report};
use crate::slash::host::{Opener, PromptSurface, Tone};
use crate::slash::notices::{truthy, value_text};

const UPDATE_NOW: &str = "update-now";

/// The Update panel on screen: its claim and what its last paint was built from (the handlers act on that, as the closures
/// of Node's render did).
pub struct UpdatePicker {
    own: Own,
    return_to: bool,
    panel: Panel,
    settings: Value,
    phase: String,
    installed: Option<String>,
}

fn read_settings(host: &mut dyn PickerHost) -> Value {
    answered(&host.store_call("getUpdateSettings", json!([]))).cloned().unwrap_or_else(|| json!({}))
}

fn read_status(host: &mut dyn PickerHost) -> Value {
    answered(&host.store_call("getUpdateStatus", json!([]))).cloned().unwrap_or_else(|| json!({"phase": "idle"}))
}

fn button_label(installed: Option<&str>, phase: &str, settings: &Value) -> String {
    if let Some(version) = installed {
        return format!("v{version} installed \u{2014} restart to apply");
    }
    if phase == "installing" {
        return "Installing\u{2026}".to_owned();
    }
    if truthy(member(settings, "updateAvailable")) {
        let latest = text_of(member(settings, "latestVersion"));
        return format!("Update to v{}", if latest.is_empty() { "latest" } else { &latest });
    }
    "Update now".to_owned()
}

fn row(value: &str, label: &str, meta: String, description: String) -> PickerItem {
    let mut item = PickerItem::new(value, label);
    item.meta = meta;
    item.description = description;
    item
}

fn items(settings: &Value, phase: &str, installed: Option<&str>, checking: bool) -> Vec<PickerItem> {
    let current = text_of(member(settings, "currentVersion"));
    let current = if current.is_empty() { "unknown".to_owned() } else { current };
    let latest = text_of(member(settings, "latestVersion"));
    let latest_meta = if checking || phase == "checking" {
        "checking\u{2026}".to_owned()
    } else if latest.is_empty() {
        "unknown".to_owned()
    } else {
        latest
    };
    vec![
        row(
            "current",
            "Current version",
            installed.map_or_else(|| current.clone(), |version| format!("{current} \u{2192} {version}")),
            installed.map_or_else(
                || "Installed mixdog version.".to_owned(),
                |version| format!("v{version} installed \u{2014} restart mixdog to apply."),
            ),
        ),
        row("latest", "Latest version", latest_meta, "Enter to re-check now.".to_owned()),
        row(
            "auto-update",
            "Auto-update",
            if truthy(member(settings, "autoUpdate")) { "On" } else { "Off" }.to_owned(),
            "Enter to toggle automatic updates.".to_owned(),
        ),
    ]
}

/// `openUpdatePicker(options)`. The first paint, THEN the initial check: the repaint epoch is captured after this panel took the
/// surface, so the open transition cannot supersede it and leave "Latest version" stuck on "checking...". Esc after the paint
/// still closes the panel for good. `None` when the open was abandoned (the panel never took the surface).
pub fn open_update_picker(host: &mut dyn PickerHost, options: &Value) -> Option<UpdatePicker> {
    // The claim is taken at the user's open action, before the first daemon read.
    let mut picker = UpdatePicker {
        own: Own::take(host),
        return_to: truthy(member(options, "returnTo")),
        panel: Panel::default(),
        settings: json!({}),
        phase: String::new(),
        installed: None,
    };
    if !picker.render(host, true) {
        return None;
    }
    let initial = picker.own.defer();
    let _ = host.store_call("checkForUpdate", json!([{}]));
    picker.repaint_when_settled(host, initial);
    Some(picker)
}

impl UpdatePicker {
    /// Reads, then paints through the claim (which re-validates and re-arms), so a re-check or install settling after Esc
    /// cannot paint over what the user is looking at now. False when nothing was painted.
    fn render(&mut self, host: &mut dyn PickerHost, checking: bool) -> bool {
        let settings = read_settings(host);
        let status = read_status(host);
        let phase = text_of(member(&status, "phase"));
        // After a successful in-place install the running process is still the old version; surface the pending version so
        // "Current" does not look stale until restart.
        let installed = (phase == "installed")
            .then(|| {
                let version = text_of(member(&status, "version"));
                let version = if version.is_empty() { text_of(member(&settings, "latestVersion")) } else { version };
                (!version.is_empty()).then_some(version)
            })
            .flatten();
        if !self.own.owns(host) {
            return false;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        let panel = Panel {
            title: "Update".to_owned(),
            description: "Check version and update mixdog.".to_owned(),
            help: Some("\u{2191}/\u{2193} Select \u{b7} Enter Open/Toggle \u{b7} Esc Close".to_owned()),
            index_mode: Some(IndexMode::Always),
            label_width: Some(16),
            meta_width: Some(16),
            items: items(&settings, &phase, installed.as_deref(), checking),
            confirm_buttons: vec![ConfirmButton::new(UPDATE_NOW, &button_label(installed.as_deref(), &phase, &settings))],
            ..Panel::default()
        };
        if !self.own.paint(host, &panel) {
            return false;
        }
        self.panel = panel;
        self.settings = settings;
        self.phase = phase;
        self.installed = installed;
        true
    }

    /// The deferred repaint bound to the claim at action time: a check or install that settles after Esc must not re-open the
    /// Update panel.
    fn repaint_when_settled(&mut self, host: &mut dyn PickerHost, deferred: super::host::Deferred) {
        if self.own.holds(host, deferred) {
            self.render(host, false);
        }
    }

    /// Persisted by the daemon: the new value is claimed only once it is written.
    fn toggle_auto_update(&mut self, host: &mut dyn PickerHost, enabled: bool) {
        let settled = self.own.defer();
        match host.store_call("setAutoUpdate", json!([enabled])) {
            Ok(_) => host.push_notice(&format!("Auto-update {}", if enabled { "on" } else { "off" }), Tone::Info),
            Err(error) => report(host, "auto-update failed", &error, Tone::Error),
        }
        self.repaint_when_settled(host, settled);
    }

    fn recheck(&mut self, host: &mut dyn PickerHost) {
        self.render(host, true);
        let settled = self.own.defer();
        if let Err(error) = host.store_call("checkForUpdate", json!([{"force": true}])) {
            report(host, "update check failed", &error, Tone::Error);
        }
        self.repaint_when_settled(host, settled);
    }

    fn run_update(&mut self, host: &mut dyn PickerHost) {
        host.push_notice("Updating\u{2026}", Tone::Info);
        let settled = self.own.defer();
        match host.store_call("runUpdateNow", json!([])) {
            Ok(result) if truthy(member(&result, "ok")) => {
                host.push_notice(&format!("v{} installed \u{2014} restart to apply", value_text(member(&result, "version"))), Tone::Warn);
            }
            Ok(result) => {
                let error = text_of(member(&result, "error"));
                let error = if error.is_empty() { "unknown error".to_owned() } else { error };
                host.push_notice(&format!("Update failed: {error}"), Tone::Error);
            }
            Err(error) => host.push_notice(&format!("Update failed: {error}"), Tone::Error),
        }
        self.repaint_when_settled(host, settled);
    }
}

impl PickerController for UpdatePicker {
    fn panel(&self) -> &Panel {
        &self.panel
    }

    fn select(&mut self, host: &mut dyn PickerHost, value: &str) {
        match value {
            "latest" => self.recheck(host),
            "auto-update" => {
                let enabled = !truthy(member(&self.settings, "autoUpdate"));
                self.toggle_auto_update(host, enabled);
            }
            _ => {}
        }
    }

    fn confirm(&mut self, host: &mut dyn PickerHost, button: &str) {
        if button == UPDATE_NOW && self.installed.is_none() && self.phase != "installing" {
            self.run_update(host);
        }
    }

    fn cancel(&mut self, host: &mut dyn PickerHost) {
        self.own.close(host);
        if self.return_to {
            open_panel(host, Opener::Settings, json!({}));
        }
    }
}
