//! The Settings picker (`settings-picker.mjs`): takes a build ticket, claims the surface, reads one settings snapshot and paints
//! the rows; the arrows write live (`toggles`) and Enter navigates (`navigation`).

use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::navigation::{open_row, settings_handoff_panel};
use super::panel::Panel;
use super::rows::{SettingsView, build_settings_items, member};
use super::toggles::{cycle_row, toggle_row};
use super::{PickerController, open_panel};
use crate::slash::host::{Opener, PromptSurface, Tone};
use crate::slash::notices::truthy;

/// The Settings panel on screen: its claim and the values its rows and toggles were built from.
pub struct SettingsPicker {
    own: Own,
    view: SettingsView,
    panel: Panel,
}

/// A build ticket: every open or refresh takes one and Esc takes the next, so a slow snapshot from a superseded (or already
/// closed) build can never re-open Settings.
fn next_request(host: &mut dyn PickerHost) -> u64 {
    let state = host.settings_state();
    state.request += 1;
    state.request
}

/// Whether a managed voice runtime is switched on (`isVoiceEnabled`): the core owns the config, a read that fails is Off.
fn voice_enabled(host: &mut dyn PickerHost) -> bool {
    host.store_call("getVoiceStatus", json!([])).is_ok_and(|status| truthy(member(&status, "enabled")))
}

/// The build. `Ok(None)` is a build that was abandoned (superseded, closed, or its handoff paint refused).
fn build(host: &mut dyn PickerHost, options: &Value, request: u64) -> Result<Option<SettingsPicker>, String> {
    // The surface claim is taken before the snapshot await. The ticket only invalidates builds that Settings' own Esc bumped;
    // a close or handover of ANOTHER surface while this open is pending is caught by the claim instead.
    let mut own = Own::take(host);
    let light = member(options, "light") == &Value::Bool(true);
    // A full Settings open usually follows another option panel. Paint the destination before the daemon snapshot so the
    // empty-chat welcome logo cannot appear between the old panel and Settings.
    if !light && !own.paint(host, &settings_handoff_panel("Loading settings...")) {
        return Ok(None);
    }
    // `heavy` re-reads MCP, plugin and skill status even on a light build: the cached values would otherwise win over a fresh
    // snapshot.
    let heavy_cache = if light && member(options, "heavy") != &Value::Bool(true) { host.settings_state().heavy_cache.clone() } else { None };
    let fresh_writes_at_start = host.settings_state().gate.fresh_writes;
    // One round trip for the whole panel: the core runs the same getters and answers once.
    let snapshot = host.store_call("getSettingsSnapshot", json!([{"heavy": heavy_cache.is_none()}]))?;
    let snapshot = if truthy(&snapshot) { snapshot } else { json!({}) };
    let view = SettingsView::read(&snapshot, heavy_cache.as_ref(), &host.state().workflow);
    // A superseded build (a newer open or refresh) or one whose panel was already closed with Esc must never paint, clear
    // prompts or write the cache: an older response settling late would otherwise roll the cache back for every later light
    // refresh.
    if host.settings_state().request != request {
        // Its fresh heavy rows were dropped; unless a newer heavy read already refreshed the cache, owe the still-open panel
        // one follow-up read.
        if heavy_cache.is_none() && own.owns(host) && host.settings_state().gate.fresh_writes == fresh_writes_at_start {
            host.settings_state().gate.queued = true;
        }
        return Ok(None);
    }
    if !own.owns(host) {
        return Ok(None);
    }
    // Refresh the cache every build (light or full) so the next light refresh reuses whatever was most recently known.
    let state = host.settings_state();
    state.heavy_cache = Some(view.heavy());
    if heavy_cache.is_none() {
        state.gate.fresh_writes += 1;
    }
    let voice_on = voice_enabled(host);
    let items = build_settings_items(host, &snapshot, &view, voice_on);
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    let focus = member(options, "focus");
    let panel = Panel {
        title: "Settings".to_owned(),
        description: "Runtime, model, tools, and integrations.".to_owned(),
        help: Some("\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Change \u{b7} Enter Open/Toggle \u{b7} Esc Close".to_owned()),
        index_mode: Some(IndexMode::Always),
        label_width: Some(18),
        meta_width: Some(18),
        initial_index: Panel::focus_index(&items, truthy(focus).then(|| crate::slash::notices::value_text(focus)).as_deref()),
        items,
        ..Panel::default()
    };
    own.paint(host, &panel);
    // A settings change from elsewhere re-reads this panel while it is still the one on screen (the claim's epoch guards a
    // closed or replaced panel). The change names no section (MCP servers, plugins and skills may have moved), so unlike a
    // post-write refresh it re-reads the heavy rows too.
    host.settings_state().live_refresh = Some(own.defer().epoch());
    Ok(Some(SettingsPicker { own, view, panel }))
}

/// The public entry point. NEVER fails to the caller, which fires it detached: a failed daemon read is a notice.
pub fn open_settings_picker(host: &mut dyn PickerHost, options: &Value) -> Option<SettingsPicker> {
    let request = next_request(host);
    match build(host, options, request) {
        Ok(picker) => picker,
        Err(error) => {
            host.push_notice(&format!("settings unavailable: {error}"), Tone::Error);
            None
        }
    }
}

/// One heavy read at a time; changes arriving meanwhile share a single follow-up, which goes through the live refresh so it is
/// a no-op once the panel was closed or replaced.
fn refresh_heavy(host: &mut dyn PickerHost) {
    if host.settings_state().gate.running {
        host.settings_state().gate.queued = true;
        return;
    }
    host.settings_state().gate.running = true;
    open_panel(host, Opener::Settings, json!({"light": true, "heavy": true}));
    let gate = &mut host.settings_state().gate;
    gate.running = false;
    if gate.queued {
        gate.queued = false;
        run_live_refresh(host);
    }
}

/// `refreshSettings({ heavy })`: re-opens the Settings panel in place (light: no handoff paint, cached heavy rows).
pub fn refresh_settings(host: &mut dyn PickerHost, heavy: bool) {
    if heavy {
        refresh_heavy(host);
    } else {
        open_panel(host, Opener::Settings, json!({"light": true}));
    }
}

/// A settings change from elsewhere (desktop, phone, the setup tool, a hand edit): re-reads the panel when it is still the
/// one on screen.
pub fn run_live_refresh(host: &mut dyn PickerHost) {
    if let Some(epoch) = host.settings_state().live_refresh {
        if host.is_panel_epoch_current(epoch) {
            refresh_settings(host, true);
        }
    }
}

impl PickerController for SettingsPicker {
    fn panel(&self) -> &Panel {
        &self.panel
    }

    fn left(&mut self, host: &mut dyn PickerHost, value: &str) {
        cycle_row(host, &self.own, &self.view, value, -1);
    }

    fn right(&mut self, host: &mut dyn PickerHost, value: &str) {
        cycle_row(host, &self.own, &self.view, value, 1);
    }

    fn select(&mut self, host: &mut dyn PickerHost, value: &str) {
        if !toggle_row(host, &self.own, &self.view, value) {
            open_row(host, &mut self.own, value, &self.view.system_shell);
        }
    }

    fn cancel(&mut self, host: &mut dyn PickerHost) {
        // Invalidate in-flight builds: Esc must win over a slow snapshot.
        next_request(host);
        host.settings_state().live_refresh = None;
        self.own.close(host);
    }
}
