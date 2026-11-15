//! Slash commands that open a management panel (project, MCP, skills, plugins, providers, memory, auto-clear, usage, context,
//! settings, profile, update) or answer with a notice where the surface is desktop-only (`slash-dispatch/panel-commands.mjs`).

use mixdog_js::{js_to_lowercase, js_trim, js_words};
use serde_json::{Value, json};

use super::report_failure;
use super::slash_panel::open_slash_panel;
use crate::slash::host::{Opener, SlashHost, Tone};
use crate::slash::notices::truthy;
use crate::slash::parsers::parse_memory_command;
use mixdog_tui_style::time_format::{DurationOptions, format_duration};

pub(super) fn handler(name: &str) -> Option<super::Handler> {
    let handler: super::Handler = match name {
        "project" => |host, arg, _| project(host, arg),
        "mcp" => |host, arg, _| mcp(host, arg),
        "skills" => |host, _, _| panel(host, "skills", "Skills", Opener::Skills),
        "plugins" => |host, _, _| panel(host, "plugins", "Plugins", Opener::Plugins),
        "providers" => |host, _, _| panel(host, "providers", "Providers", Opener::ProviderSetup),
        // Management surface is desktop-only (user decision): hidden from the palette, and a typed command answers instead of
        // opening a picker.
        "schedules" | "webhooks" => |host, _, _| desktop_only_notice(host),
        "memory" => |host, arg, _| memory(host, arg),
        "autoclear" => |host, arg, _| autoclear(host, arg),
        "usage" => |host, arg, _| usage(host, arg),
        "context" => |host, _, _| panel(host, "context", "Context Usage", Opener::Context),
        "settings" | "config" => |host, _, _| panel(host, "settings", "Settings", Opener::Settings),
        "profile" => |host, _, _| panel(host, "profile", "Profile", Opener::Profile),
        "update" => |host, _, _| panel(host, "update", "Update", Opener::Update),
        _ => return None,
    };
    Some(handler)
}

fn panel(host: &mut dyn SlashHost, command: &str, title: &str, opener: Opener) -> bool {
    open_slash_panel(host, command, title, opener, json!({}));
    true
}

fn desktop_only_notice(host: &mut dyn SlashHost) -> bool {
    host.push_notice("Schedules and webhooks are managed in the Mixdog desktop app", Tone::Info);
    true
}

fn project(host: &mut dyn SlashHost, arg: &str) -> bool {
    let target = js_trim(arg);
    if target.is_empty() {
        return panel(host, "project", "Projects", Opener::Project);
    }
    host.enter_project(target);
    true
}

fn mcp(host: &mut dyn SlashHost, arg: &str) -> bool {
    let mut words = js_words(arg);
    let action = words.next().map(js_to_lowercase);
    if let Some(action) = action.as_deref().filter(|action| matches!(*action, "login" | "logout")) {
        let name = words.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            host.push_notice(&format!("usage: /mcp {action} <name>"), Tone::Warn);
            return true;
        }
        if action == "login" {
            host.login_mcp_server(&name);
        } else {
            host.logout_mcp_server(&name);
        }
        return true;
    }
    panel(host, "mcp", "MCP Servers", Opener::Mcp)
}

fn memory(host: &mut dyn SlashHost, arg: &str) -> bool {
    if js_trim(arg).is_empty() {
        open_slash_panel(host, "memory", "Memory", Opener::MemoryCore, json!({"returnTo": Value::Null}));
        return true;
    }
    if let Err(error) = host.store_call("memoryControl", json!([parse_memory_command(arg)])) {
        report_failure(host, "memory failed", &error);
    }
    true
}

fn autoclear(host: &mut dyn SlashHost, arg: &str) -> bool {
    let value = js_to_lowercase(js_trim(arg));
    if value.is_empty() {
        return panel(host, "autoclear", "Auto-clear", Opener::AutoClear);
    }
    let call = match value.as_str() {
        "status" => host.store_call("getAutoClear", json!([])),
        "on" | "enable" | "enabled" => host.store_call("setAutoClear", json!([{"enabled": true}])),
        "off" | "disable" | "disabled" => host.store_call("setAutoClear", json!([{"enabled": false}])),
        _ => host.store_call("setAutoClear", json!([{"duration": value}])),
    };
    match call {
        Ok(next) if truthy(&next) => {
            let enabled = if next.get("enabled").is_some_and(truthy) { "on" } else { "off" };
            let idle =
                format_duration(next.get("idleMs").map_or(f64::NAN, mixdog_js::to_number), DurationOptions::default());
            host.push_notice(&format!("autoclear {enabled} \u{b7} idle {idle}"), Tone::Info);
        }
        Ok(_) => host.push_notice("autoclear unavailable", Tone::Warn),
        Err(error) => report_failure(host, "autoclear failed", &error),
    }
    true
}

fn usage(host: &mut dyn SlashHost, arg: &str) -> bool {
    open_slash_panel(host, "usage", "Provider Quotas", Opener::Usage, Value::String(arg.to_owned()));
    true
}
