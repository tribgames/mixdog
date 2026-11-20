//! The Plugins menu, the installed-plugins list, the per-plugin detail panel (info, update, MCP, copy, uninstall) and the
//! add-plugin prompt (`extension-pickers/plugins-pickers.mjs`).

use mixdog_js::js_trim;
use serde_json::{Value, json};

use super::Extensions;
use super::panel::{Action, ExtItem, ExtPanel, ExtensionsHost, Handler, claim, close_now, js_text, or_text, read_status, status_list, with_scope};
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};

/// A plugin's MCP servers, derived from its declarations (`mcpServers` on the status row); older hosts only report
/// `mcpScript` and `mcpServerName`.
fn mcp_names(plugin: &Value) -> Vec<String> {
    if let Some(servers) = plugin.get("mcpServers").and_then(Value::as_array) {
        return servers.iter().map(|server| server.get("name").map_or_else(String::new, join_text)).collect();
    }
    match plugin.get("mcpServerName") {
        Some(name) if truthy(name) => vec![value_text(name)],
        _ => Vec::new(),
    }
}

/// An element as `Array.prototype.join` writes it: null and undefined are empty.
fn join_text(value: &Value) -> String {
    if value.is_null() { String::new() } else { mixdog_js::value_to_string(value) }
}

fn has_mcp(plugin: &Value) -> bool {
    !mcp_names(plugin).is_empty() || ["mcpScript", "mcpInline"].iter().any(|key| plugin.get(*key).is_some_and(truthy))
}

fn server_state(server: &Value) -> String {
    if server.get("serverEnabled") == Some(&Value::Bool(false)) {
        return "off".to_owned();
    }
    if server.get("enabled") == Some(&Value::Bool(false)) {
        return "plugin off".to_owned();
    }
    let fallback = if server.get("connected").is_some_and(truthy) { "connected" } else { "disconnected" };
    or_text(server, "status", fallback)
}

fn mcp_errors(plugin: &Value) -> &[Value] {
    plugin.get("mcpErrors").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn mcp_summary(plugin: &Value) -> String {
    if !has_mcp(plugin) {
        return match mcp_errors(plugin).first() {
            Some(error) => format!("(invalid: {})", js_text(error, "message")),
            None => "(none)".to_owned(),
        };
    }
    let Some(servers) = plugin.get("mcpServers").and_then(Value::as_array) else {
        let state = if plugin.get("mcpEnabled").is_some_and(truthy) { "enabled" } else { "available" };
        return format!("{state} ({})", mcp_names(plugin).join(", "));
    };
    let errors = match mcp_errors(plugin).len() {
        0 => String::new(),
        count => format!(" \u{b7} {count} declaration error(s)"),
    };
    let listed: Vec<String> = servers.iter().map(|server| format!("{} {}", js_text(server, "name"), server_state(server))).collect();
    format!("{}{errors}", listed.join(", "))
}

fn source_label(plugin: &Value) -> String {
    match plugin.get("sourceType").filter(|value| truthy(value)) {
        Some(source) => value_text(source),
        None => js_text(plugin, "source"),
    }
}

fn mcp_action_item(plugin: &Value) -> ExtItem {
    if !has_mcp(plugin) {
        return ExtItem::new("enable-mcp", "No MCP server", "plugin declares no MCP servers (.mcp.json or manifest mcpServers)", Action::Noop);
    }
    let enabled = plugin.get("mcpEnabled").is_some_and(truthy);
    let names = mcp_names(plugin).join(", ");
    ExtItem::new(
        "enable-mcp",
        if enabled { "Reconnect MCP servers" } else { "Enable MCP servers" },
        &format!("{} \u{b7} {}", if names.is_empty() { "plugin MCP" } else { names.as_str() }, if enabled { "on" } else { "turned off" }),
        Action::EnableMcp,
    )
}

fn plugin_summary(plugin: &Value) -> String {
    let version = plugin.get("version").filter(|version| truthy(version)).map_or_else(String::new, |version| format!(" \u{b7} {}", value_text(version)));
    let mcp = if has_mcp(plugin) {
        let count = mcp_names(plugin).len();
        let off = if plugin.get("mcpEnabled").is_some_and(truthy) { "" } else { " off" };
        format!(" \u{b7} mcp {}{off}", if count == 0 { 1 } else { count })
    } else {
        String::new()
    };
    let warning =
        plugin.get("warning").filter(|warning| truthy(warning)).map_or_else(String::new, |warning| format!(" \u{b7} \u{26a0} {}", value_text(warning)));
    format!("{}{version} \u{b7} skills {}{mcp}{warning}", source_label(plugin), or_text(plugin, "skillCount", "0"))
}

fn plugin_info_notice(plugin: &Value) -> String {
    let version = plugin.get("version").filter(|version| truthy(version)).map_or_else(String::new, |version| format!(" {}", value_text(version)));
    let source_url = plugin.get("sourceUrl").filter(|url| truthy(url)).map_or_else(String::new, |url| format!(" / {}", value_text(url)));
    let scope = match plugin.get("scope").and_then(Value::as_array) {
        Some(scope) if !scope.is_empty() => scope.iter().map(join_text).collect::<Vec<_>>().join(", "),
        _ => "all projects".to_owned(),
    };
    let warning = plugin.get("warning").filter(|warning| truthy(warning)).map_or_else(String::new, |warning| format!("warning: {}", value_text(warning)));
    let description = plugin.get("description").filter(|text| truthy(text)).map_or_else(String::new, |text| format!("\n{}", value_text(text)));
    [
        format!("{}{version}", or_text(plugin, "title", &js_text(plugin, "name"))),
        format!("source: {}{source_url}", source_label(plugin)),
        format!("skills: {}", or_text(plugin, "skillCount", "0")),
        format!("mcp: {}", mcp_summary(plugin)),
        format!("applies to: {scope}"),
        format!("root: {}", js_text(plugin, "root")),
        warning,
        description,
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn detail_items(plugin: &Value) -> Vec<ExtItem> {
    let local = plugin.get("sourceType").and_then(Value::as_str) == Some("local");
    let version = plugin.get("version").filter(|version| truthy(version)).map_or_else(String::new, |version| format!(" \u{b7} {}", value_text(version)));
    let names = mcp_names(plugin);
    vec![
        ExtItem::new("info", "Plugin info", &format!("{}{version} \u{b7} skills {}", source_label(plugin), or_text(plugin, "skillCount", "0")), Action::Info),
        ExtItem::new(
            "update",
            if local { "Refresh metadata" } else { "Update plugin" },
            if local { "rescan local plugin manifest" } else { "pull latest from source URL" },
            Action::Update,
        ),
        mcp_action_item(plugin),
        ExtItem::new("copy-root", "Copy root path", &or_text(plugin, "root", ""), Action::CopyRoot),
        ExtItem::new(
            "copy-mcp-name",
            if names.is_empty() { "No MCP server name" } else { "Copy MCP server name" },
            &names.join(", "),
            if names.is_empty() { Action::Noop } else { Action::CopyMcpName },
        ),
        ExtItem::new(
            "uninstall",
            "Uninstall plugin",
            if plugin.get("managed") == Some(&Value::Bool(false)) { "remove from registry only" } else { "remove registry entry and installed files" },
            Action::Uninstall,
        ),
    ]
}

/// `beginAddPlugin()`: closes the panel and asks for the plugin's URL.
pub fn begin_add_plugin(host: &mut dyn ExtensionsHost) {
    close_now(host);
    let mut prompt = TextPrompt::new("plugin-add");
    prompt.label = "Plugin URL".to_owned();
    prompt.hint = "Git URL, owner/repo, or local path".to_owned();
    host.set_prompt(PromptSurface::Settings, Some(prompt));
}

fn copy_text(host: &mut dyn ExtensionsHost, text: &str, done: &str) {
    match host.copy_to_clipboard(text) {
        Ok(()) => host.push_plain_notice(done),
        Err(error) => host.push_notice(&format!("copy failed: {error}"), Tone::Error),
    }
}

impl Extensions {
    /// `openPluginDetailPicker(plugin)`: a synchronous panel for an Enter on a plugin row, an ordinary claimed paint.
    pub fn open_plugin_detail(&mut self, host: &mut dyn ExtensionsHost, plugin: &Value) {
        let mut own = claim(host);
        let described = js_trim(&or_text(plugin, "description", "")).to_owned();
        let description = if described.is_empty() { "Update, MCP, or uninstall this plugin." } else { described.as_str() };
        let title = or_text(plugin, "title", &js_text(plugin, "name"));
        host.paint(&mut own, Some(ExtPanel::new(&title, description, detail_items(plugin), Handler::PluginDetail(plugin.clone()))));
    }

    /// Enter on a row of the plugin panel. The panel clears first: the reopens below are bound to this keypress.
    pub(super) fn plugin_detail_select(&mut self, host: &mut dyn ExtensionsHost, plugin: &Value, item: &ExtItem) {
        let mut own = claim(host);
        host.paint(&mut own, None);
        let name = js_text(plugin, "name");
        match item.action {
            Action::Info => host.push_notice(&plugin_info_notice(plugin), Tone::Info),
            Action::Update => self.plugin_write(host, own.epoch, "updatePlugin", plugin, "plugin update failed", false),
            Action::EnableMcp => self.plugin_write(host, own.epoch, "enablePluginMcp", plugin, "plugin MCP reconnect failed", true),
            Action::CopyRoot => copy_text(host, &js_text(plugin, "root"), &format!("copied plugin root: {name}")),
            Action::CopyMcpName => {
                let names = mcp_names(plugin).join(", ");
                copy_text(host, &names, &format!("copied plugin MCP server: {names}"));
            }
            Action::Uninstall => self.plugin_write(host, own.epoch, "removePlugin", plugin, "plugin uninstall failed", false),
            _ => {}
        }
    }

    /// A post-write delegation: the reopen is bound to the epoch of this keypress, so an ack after Esc cannot reopen a list. A
    /// store without the method does nothing (the optional call short-circuited the whole chain).
    fn plugin_write(&mut self, host: &mut dyn ExtensionsHost, token: u64, method: &str, plugin: &Value, failure: &str, then_mcp: bool) {
        if !host.has_store_method(method) {
            return;
        }
        match host.store_call(method, json!([plugin])) {
            Ok(_) => {
                if host.is_panel_epoch_current(token) {
                    if then_mcp {
                        self.open_mcp_servers(host, None, None);
                    } else {
                        self.open_installed_plugins(host);
                    }
                }
            }
            Err(error) => host.push_notice(&format!("{failure}: {error}"), Tone::Error),
        }
    }

    /// `openInstalledPluginsPicker()`.
    pub fn open_installed_plugins(&mut self, host: &mut dyn ExtensionsHost) {
        let mut own = claim(host);
        let Some(status) = read_status(host, "pluginsStatus", "plugins", "plugins status") else { return };
        let plugins = status_list(&status, "plugins");
        let mut items = Vec::new();
        if plugins.is_empty() {
            items.push(ExtItem::new("empty", "No installed plugins", "Esc back \u{b7} add from Plugins > Add plugin", Action::Noop));
        }
        for plugin in &plugins {
            let id = match plugin.get("id").filter(|id| truthy(id)) {
                Some(id) => value_text(id),
                None => js_text(plugin, "name"),
            };
            items.push(ExtItem::new(
                &format!("{id}:{}", or_text(plugin, "version", "")),
                &or_text(plugin, "title", &js_text(plugin, "name")),
                &with_scope(&plugin_summary(plugin), plugin),
                Action::Plugin(plugin.clone()),
            ));
        }
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        host.paint(&mut own, Some(ExtPanel::new("Installed plugins", "Open an installed plugin to manage it.", items, Handler::InstalledPlugins)));
    }

    /// `openPluginsPicker()`: the menu.
    pub fn open_plugins(&mut self, host: &mut dyn ExtensionsHost) {
        let mut own = claim(host);
        let Some(status) = read_status(host, "pluginsStatus", "plugins", "plugins status") else { return };
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        let items = vec![
            ExtItem::new(
                "installed",
                "Installed plugins",
                &format!("{} installed", status.get("count").filter(|count| truthy(count)).map_or_else(|| "0".to_owned(), value_text)),
                Action::Installed,
            ),
            ExtItem::new("add", "Add plugin", "Git URL, owner/repo, or local path", Action::Add),
        ];
        host.paint(&mut own, Some(ExtPanel::new("Plugins", "Add or manage local plugin integrations.", items, Handler::Plugins)));
    }
}
