//! The left and right arrow writes (and Enter on a toggle) of the Settings rows (`settings-picker/settings-toggles.mjs`,
//! `settings-toggles/store-toggles.mjs`, `listed-cyclers.mjs`, `theme-cycler.mjs`): each one goes through the store, reports,
//! and refreshes Settings through the deferred refresh bound to the keypress that started it.

use serde_json::{Value, json};

use super::host::{Deferred, Own, PickerHost};
use super::picker::refresh_settings;
use super::rows::{SettingsView, member};
use super::{answered, cycled_index, duration_text, report};
use crate::slash::host::Tone;
use crate::slash::notices::{output_style_notice, theme_notice, truthy, value_text, workflow_switch_notice};

/// The rows whose Enter flips them; the arrows flip these too.
const TOGGLES: [&str; 4] = ["autocompact", "web-search-enabled", "memory-enabled", "voice"];

/// The post-write refresh, bound to the claim at action time: Esc only invalidates builds that already exist, so a write
/// settling afterwards would otherwise take a fresh generation and re-open the panel the user just closed.
fn settled(host: &mut dyn PickerHost, own: &Own, deferred: Deferred) {
    if own.holds(host, deferred) {
        refresh_settings(host, false);
    }
}

/// The left and right arrows on a row: toggles flip, cyclers step in `direction`.
pub fn cycle_row(host: &mut dyn PickerHost, own: &Own, view: &SettingsView, action: &str, direction: i64) {
    match action {
        "autocompact" => toggle_compaction(host, own, view),
        "web-search-enabled" => toggle_tool_module(host, own, "Web search", "setWebSearchEnabled", !view.web_search_on),
        "memory-enabled" => toggle_tool_module(host, own, "Memory", "setMemoryToolsEnabled", !view.memory_tools_on),
        "voice" => apply_voice(host, own),
        "autoclear" => apply_auto_clear(host, own, json!({"enabled": !view.auto_clear_enabled})),
        "output-style" => cycle_output_style(host, own, direction),
        "theme" => cycle_theme(host, direction),
        "workflow" => cycle_workflow(host, own, view, direction),
        _ => {}
    }
}

/// Enter on a row: a toggle flips; false when the row is not one.
pub fn toggle_row(host: &mut dyn PickerHost, own: &Own, view: &SettingsView, action: &str) -> bool {
    if !TOGGLES.contains(&action) {
        return false;
    }
    cycle_row(host, own, view, action, 1);
    true
}

/// On and Off only: the idle-window override lives in the Advanced picker, opened with Enter on the row.
fn apply_auto_clear(host: &mut dyn PickerHost, own: &Own, patch: Value) {
    let deferred = own.defer();
    let result = host.store_call("setAutoClear", json!([patch]));
    match &result {
        Ok(next) if truthy(next) => {
            let text = if truthy(member(next, "enabled")) {
                format!("Auto-clear on \u{b7} idle {}", duration_text(member(next, "idleMs")))
            } else {
                "Auto-clear off".to_owned()
            };
            host.push_notice(&text, Tone::Info);
        }
        Ok(_) => host.push_notice("autoclear unavailable", Tone::Warn),
        Err(error) => report(host, "autoclear failed", error, Tone::Error),
    }
    settled(host, own, deferred);
}

fn toggle_compaction(host: &mut dyn PickerHost, own: &Own, view: &SettingsView) {
    let deferred = own.defer();
    let turn_on = member(&view.compaction, "auto") == &Value::Bool(false);
    let result = host.store_call("setCompactionSettings", json!([{"auto": turn_on}]));
    match &result {
        Ok(next) if truthy(next) => {
            let state = if member(next, "auto") != &Value::Bool(false) { "auto on" } else { "auto off" };
            host.push_notice(&format!("Compaction {state}"), Tone::Info);
        }
        Ok(_) => host.push_notice("compaction setting is busy", Tone::Warn),
        Err(error) => report(host, "compaction failed", error, Tone::Error),
    }
    settled(host, own, deferred);
}

fn toggle_tool_module(host: &mut dyn PickerHost, own: &Own, label: &str, setter: &str, enabled: bool) {
    let deferred = own.defer();
    let result = host.store_call(setter, json!([enabled]));
    match &result {
        Ok(next) if truthy(next) => {
            host.push_notice(&format!("{label} {} \u{b7} new sessions", if enabled { "on" } else { "off" }), Tone::Info);
        }
        Ok(_) => host.push_notice(&format!("{label} setting is busy"), Tone::Warn),
        Err(error) => report(host, &format!("{label} setting failed"), error, Tone::Error),
    }
    settled(host, own, deferred);
}

/// The voice toggle: enabling installs the managed whisper and ffmpeg runtime the first time, then flips `voice.enabled`. The
/// core owns the install and the state (`voice/getVoiceStatus`, `voice/toggleVoice`); the notices are this picker's.
fn apply_voice(host: &mut dyn PickerHost, own: &Own) {
    let deferred = own.defer();
    let status = match host.store_call("getVoiceStatus", json!([])) {
        Ok(status) => status,
        Err(error) => {
            report(host, "voice setup failed", &error, Tone::Error);
            settled(host, own, deferred);
            return;
        }
    };
    if truthy(member(&status, "busy")) {
        host.push_notice("Voice install is already running", Tone::Warn);
        return;
    }
    let target = !truthy(member(&status, "enabled"));
    match host.store_call("toggleVoice", json!([target])) {
        Ok(reply) => voice_notice(host, target, member(&reply, "result")),
        Err(error) => report(host, "voice setup failed", &error, Tone::Error),
    }
    settled(host, own, deferred);
}

/// The outcome of `toggleVoice(target)`: `{ ok: true, enabled }`, `{ ok: false, error }` or `{ ok: false }` (an install is
/// already running).
fn voice_notice(host: &mut dyn PickerHost, target: bool, result: &Value) {
    if truthy(member(result, "ok")) {
        // Enabling that a later OFF superseded writes nothing and says nothing.
        if !target {
            host.push_notice("Voice OFF", Tone::Info);
        } else if truthy(member(result, "enabled")) {
            host.push_notice("Voice ON \u{2014} channel voice messages will be transcribed", Tone::Info);
        }
        return;
    }
    match (truthy(member(result, "error")), target) {
        (true, false) => report(host, "Voice OFF failed", &value_text(member(result, "error")), Tone::Error),
        (true, true) => host.push_notice(&value_text(member(result, "error")), Tone::Error),
        (false, _) => host.push_notice("Voice install is already running", Tone::Warn),
    }
}

/// The list read of the two cyclers: its entries, or the notice that ends the cycle.
fn listed(host: &mut dyn PickerHost, call: &str, failure: &str) -> Option<Value> {
    match host.store_call(call, json!([])) {
        Ok(value) => Some(value),
        Err(error) => {
            report(host, failure, &error, Tone::Error);
            None
        }
    }
}

fn cycle_output_style(host: &mut dyn PickerHost, own: &Own, direction: i64) {
    // The epoch is captured on the keypress, before the list read: taking it after would bind to whatever surface the user
    // moved to meanwhile, and the refresh would re-open Settings over it.
    let deferred = own.defer();
    let Some(listing) = listed(host, "listOutputStyles", "could not list output styles") else { return };
    let status = if truthy(&listing) { listing } else { Value::Null };
    let styles = member(&status, "styles").as_array().cloned().unwrap_or_default();
    if styles.is_empty() {
        host.push_notice("no output styles available", Tone::Warn);
        return;
    }
    let current_id = member(member(&status, "current"), "id");
    let current_id = if truthy(current_id) { current_id.clone() } else { json!("default") };
    let current = styles.iter().position(|style| member(style, "id") == &current_id);
    let next = &styles[cycled_index(styles.len(), current, direction)];
    let result = host.store_call("setOutputStyle", json!([member(next, "id")]));
    match answered(&result) {
        Some(applied) => host.push_notice(&output_style_notice(applied), Tone::Info),
        None => match &result {
            Err(error) => report(host, "Couldn\u{2019}t switch output style", error, Tone::Error),
            Ok(_) => host.push_notice("Output style switch is already running.", Tone::Warn),
        },
    }
    settled(host, own, deferred);
}

fn cycle_workflow(host: &mut dyn PickerHost, own: &Own, view: &SettingsView, direction: i64) {
    // Same as the output styles: the epoch belongs to the keypress, not to the list ack that lands after the user may have
    // closed Settings.
    let deferred = own.defer();
    let Some(listing) = listed(host, "listWorkflows", "could not list workflows") else { return };
    let workflows = if truthy(&listing) { listing.as_array().cloned().unwrap_or_default() } else { Vec::new() };
    if workflows.is_empty() {
        host.push_notice("no workflows available", Tone::Warn);
        return;
    }
    let active = workflows.iter().position(|item| truthy(member(item, "active")));
    let current = active.or_else(|| workflows.iter().position(|item| member(item, "id") == member(&view.workflow, "id")));
    let next = &workflows[cycled_index(workflows.len(), current, direction)];
    let result = host.store_call("setWorkflow", json!([member(next, "id")]));
    match answered(&result) {
        Some(applied) => host.push_notice(&workflow_switch_notice(applied), Tone::Info),
        None => match &result {
            Err(error) => report(host, "Couldn\u{2019}t switch workflow", error, Tone::Error),
            Ok(_) => host.push_notice("Workflow switch is already running.", Tone::Warn),
        },
    }
    settled(host, own, deferred);
}

/// The one cycler that is entirely synchronous: themes are listed and applied in-process, so there is no ack to defer; it
/// refreshes Settings directly.
fn cycle_theme(host: &mut dyn PickerHost, direction: i64) {
    let themes = match host.store_call("listThemes", json!([])) {
        Ok(listed) => listed.as_array().cloned().unwrap_or_default(),
        Err(error) => {
            report(host, "could not list themes", &error, Tone::Error);
            return;
        }
    };
    if themes.is_empty() {
        host.push_notice("no themes available", Tone::Warn);
        return;
    }
    let from_store = host.store_call("getTheme", json!([])).unwrap_or(Value::Null);
    let current_id = if truthy(&from_store) {
        from_store
    } else {
        let marked = themes.iter().find(|theme| truthy(member(theme, "current")));
        marked.unwrap_or(&themes[0]).get("id").cloned().unwrap_or(Value::Null)
    };
    let current = themes.iter().position(|theme| member(theme, "id") == &current_id);
    let next = &themes[cycled_index(themes.len(), current, direction)];
    match host.store_call("setTheme", json!([member(next, "id"), {"persist": true}])) {
        Ok(applied) => {
            let shown = if truthy(&applied) { applied } else { next.clone() };
            host.push_notice(&theme_notice(&shown), Tone::Info);
        }
        Err(error) => report(host, "Couldn\u{2019}t set theme", &error, Tone::Error),
    }
    refresh_settings(host, false);
}
