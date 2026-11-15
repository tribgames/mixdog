//! Slash commands that change the route: model, web-search model, agents, workflow, output style, theme, effort and Fast
//! (`slash-dispatch/route-commands.mjs`).

use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use serde_json::{Value, json};

use super::report_failure;
use super::slash_panel::open_slash_panel;
use crate::slash::host::{Opener, SlashHost, Tone};
use crate::slash::notices::{
    first_truthy_text, model_switch_notice, output_style_notice, theme_notice, truthy, value_text,
    workflow_switch_notice,
};

const STATUS_WORDS: [&str; 3] = ["status", "current", "show"];

pub(super) fn handler(name: &str) -> Option<super::Handler> {
    let handler: super::Handler = match name {
        "model" => |host, arg, _| model(host, arg),
        "websearch" => |host, arg, _| websearch(host, arg),
        "agents" => |host, arg, _| agents(host, arg),
        "workflow" => |host, arg, _| workflow(host, arg),
        "outputstyle" => |host, arg, _| outputstyle(host, arg),
        "theme" => |host, arg, _| theme(host, arg),
        "effort" => |host, arg, _| effort(host, arg),
        "fast" => |host, arg, _| fast(host, arg),
        _ => return None,
    };
    Some(handler)
}

fn is_status_word(lower: &str) -> bool {
    STATUS_WORDS.contains(&lower)
}

fn model(host: &mut dyn SlashHost, arg: &str) -> bool {
    if arg.is_empty() {
        open_slash_panel(host, "model", "Model", Opener::Model, json!({}));
        return true;
    }
    if js_to_lowercase(js_trim(arg)) == "refresh" {
        // Explicit catalog reload: force a fresh remote provider list.
        open_slash_panel(host, "model", "Model", Opener::Model, json!({"refreshModels": true}));
        return true;
    }
    match host.store_call("setModel", json!([arg])) {
        Ok(result) if truthy(&result) => host.push_notice(&model_switch_notice(), Tone::Info),
        Ok(_) => host.push_notice("Model switch is already running.", Tone::Warn),
        Err(error) => report_failure(host, "Couldn\u{2019}t switch model", &error),
    }
    true
}

fn websearch(host: &mut dyn SlashHost, arg: &str) -> bool {
    // No busy guard: /websearch only picks the web-search provider/model (a config save the NEXT web_search tool call reads).
    // It never touches the in-flight turn, and the same picker is reachable mid-turn through /settings.
    if !arg.is_empty() {
        host.push_notice(
            "/websearch sets the web-search provider/model; the web_search tool uses that model when called.",
            Tone::Warn,
        );
    }
    open_slash_panel(host, "websearch", "Web Search Model", Opener::WebSearch, json!({}));
    true
}

fn agents(host: &mut dyn SlashHost, arg: &str) -> bool {
    let options = if js_to_lowercase(js_trim(arg)) == "refresh" { json!({"refreshModels": true}) } else { json!({}) };
    open_slash_panel(host, "agents", "Agents", Opener::Agents, options);
    true
}

fn workflow(host: &mut dyn SlashHost, arg: &str) -> bool {
    if arg.is_empty() {
        open_slash_panel(host, "workflow", "Workflow", Opener::Workflow, json!({}));
        return true;
    }
    // `store.setWorkflow?.(...).then(...)`: a store without the method does nothing.
    if !host.has_store_method("setWorkflow") {
        return true;
    }
    match host.store_call("setWorkflow", json!([js_trim(arg)])) {
        Ok(result) if truthy(&result) => host.push_notice(&workflow_switch_notice(&result), Tone::Info),
        Ok(_) => host.push_notice("Workflow switch is already running.", Tone::Warn),
        Err(error) => report_failure(host, "Couldn\u{2019}t switch workflow", &error),
    }
    true
}

fn outputstyle(host: &mut dyn SlashHost, arg: &str) -> bool {
    if host.state().busy {
        host.push_notice("wait for the current turn to finish before /OutputStyle", Tone::Warn);
        return false;
    }
    let value = js_trim(arg);
    if value.is_empty() {
        open_slash_panel(host, "outputstyle", "Output Style", Opener::OutputStyle, json!({}));
        return true;
    }
    if is_status_word(&js_to_lowercase(value)) {
        match host.store_call("getOutputStyle", json!([])) {
            Ok(status) => {
                let current = status.get("current").cloned().unwrap_or(Value::Null);
                let label = first_truthy_text(&current, &["label", "id"])
                    .or_else(|| first_truthy_text(&status, &["configured"]))
                    .unwrap_or_else(|| "Default".to_owned());
                host.push_notice(&format!("Output style: {label}"), Tone::Info);
            }
            Err(error) => report_failure(host, "Couldn\u{2019}t read output style", &error),
        }
        return true;
    }
    // `store.setOutputStyle?.(...).then(...)`: a store without the method does nothing.
    if !host.has_store_method("setOutputStyle") {
        return true;
    }
    match host.store_call("setOutputStyle", json!([value])) {
        Ok(result) if truthy(&result) => host.push_notice(&output_style_notice(&result), Tone::Info),
        Ok(_) => host.push_notice("Output style switch is already running.", Tone::Warn),
        Err(error) => report_failure(host, "Couldn\u{2019}t switch output style", &error),
    }
    true
}

fn theme(host: &mut dyn SlashHost, arg: &str) -> bool {
    let value = js_trim(arg);
    let lower = js_to_lowercase(value);
    if value.is_empty() {
        open_slash_panel(host, "theme", "Theme", Opener::Theme, json!({}));
        return true;
    }
    let themes: Vec<Value> = match host.store_call("listThemes", json!([])) {
        Ok(listed) => listed.as_array().cloned().unwrap_or_default(),
        Err(error) => {
            report_failure(host, "could not list themes", &error);
            return true;
        }
    };
    let text_of = |theme: &Value, key: &str| theme.get(key).map(value_text).unwrap_or_default();
    if is_status_word(&lower) {
        let id = host.store_call("getTheme", json!([])).unwrap_or(Value::Null);
        let id_text = if truthy(&id) { value_text(&id) } else { String::new() };
        let entry = themes.iter().find(|theme| theme.get("id") == Some(&id) && truthy(&id));
        let label = entry.and_then(|entry| first_truthy_text(entry, &["label"])).filter(|label| !label.is_empty());
        let shown =
            label.or_else(|| Some(id_text).filter(|text| !text.is_empty())).unwrap_or_else(|| "default".to_owned());
        host.push_notice(&format!("Theme: {shown}"), Tone::Info);
        return true;
    }
    let found = themes
        .iter()
        .find(|theme| js_to_lowercase(&text_of(theme, "id")) == lower)
        .or_else(|| themes.iter().find(|theme| js_to_lowercase(&text_of(theme, "label")) == lower));
    let Some(found) = found.cloned() else {
        let ids: Vec<String> = themes.iter().map(|theme| text_of(theme, "id")).collect();
        host.push_notice(&format!("usage: /theme [id]. Available: {}", ids.join(", ")), Tone::Warn);
        return true;
    };
    let id = found.get("id").cloned().unwrap_or(Value::Null);
    match host.store_call("setTheme", json!([id, {"persist": true}])) {
        Ok(applied) => {
            let shown = if truthy(&applied) { applied } else { found };
            host.push_notice(&theme_notice(&shown), Tone::Info);
        }
        Err(error) => report_failure(host, "Couldn\u{2019}t set theme", &error),
    }
    true
}

fn effort(host: &mut dyn SlashHost, arg: &str) -> bool {
    // A running turn does not block the switch: the in-flight turn keeps the effort it started with, and the new level
    // applies from the next turn. The same holds for /fast.
    let pending_turn = if host.state().busy { " (applies from the next turn)" } else { "" };
    if arg.is_empty() {
        open_slash_panel(host, "effort", "Effort", Opener::Effort, json!({}));
        return true;
    }
    match host.store_call("setEffort", json!([arg])) {
        Ok(result) if truthy(&result) => {
            host.push_notice(&format!("Effort set to {}{pending_turn}", value_to_string(&result)), Tone::Info);
        }
        Ok(_) => host.push_notice("Effort switch is already running.", Tone::Warn),
        Err(error) => report_failure(host, "Couldn\u{2019}t switch effort", &error),
    }
    true
}

/// What `/fast` was asked for.
enum FastRequest {
    Toggle,
    Ultrafast,
    On,
    Off,
}

fn fast_request(value: &str) -> Option<FastRequest> {
    match value {
        "" => Some(FastRequest::Toggle),
        "ultra" | "ultrafast" => Some(FastRequest::Ultrafast),
        "1" | "true" | "yes" | "on" | "enable" | "enabled" => Some(FastRequest::On),
        "0" | "false" | "no" | "off" | "disable" | "disabled" => Some(FastRequest::Off),
        _ => None,
    }
}

fn fast(host: &mut dyn SlashHost, arg: &str) -> bool {
    let state = host.state();
    let Some(request) = fast_request(&js_to_lowercase(js_trim(arg))) else {
        host.push_notice("usage: /fast [on|off|ultra]", Tone::Warn);
        return true;
    };
    let outcome = match request {
        FastRequest::Toggle => host.store_call("toggleFast", json!([])),
        FastRequest::Ultrafast => host.store_call("setFast", json!(["ultrafast"])),
        FastRequest::On => host.store_call("setFast", json!([true])),
        FastRequest::Off => host.store_call("setFast", json!([false])),
    };
    match outcome {
        Ok(Value::Null) => host.push_notice("Fast mode switch is already running.", Tone::Warn),
        Ok(enabled) => {
            let on = truthy(&enabled);
            let mode_label = if matches!(request, FastRequest::Ultrafast) {
                "Ultrafast"
            } else if on {
                "Fast mode on"
            } else {
                "Fast mode off"
            };
            let pending = if state.busy { " (applies from the next turn)" } else { "" };
            host.push_notice(&format!("{mode_label} for {}/{}{pending}", state.provider, state.model), Tone::Info);
        }
        Err(error) => report_failure(host, "Couldn\u{2019}t update fast mode", &error),
    }
    true
}
