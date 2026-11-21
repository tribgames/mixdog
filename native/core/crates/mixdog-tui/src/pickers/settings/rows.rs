//! The Settings rows built from one settings snapshot (`settings-picker/settings-rows.mjs`). Row order groups by concern
//! (routing and model first, then session behaviour, integrations, voice, system) and stays in step with the desktop's
//! settings items.

use mixdog_tui_widgets::picker::PickerItem;
use serde_json::{Value, json};

use super::host::PickerHost;
use super::{HeavyCache, duration_text};
use crate::slash::notices::{first_truthy_text, truthy, value_text, workflow_display_name};

fn bool_label(enabled: bool) -> &'static str {
    if enabled { "On" } else { "Off" }
}

/// `value?.[key]`, `Null` when anything on the way is absent.
pub(super) fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

pub(super) fn text_of(value: &Value) -> String {
    if truthy(value) { value_text(value) } else { String::new() }
}

/// `snapshot[key] || fallback`.
fn or_else(snapshot: &Value, key: &str, fallback: Value) -> Value {
    let value = member(snapshot, key);
    if truthy(value) { value.clone() } else { fallback }
}

/// The profile row's meta, from the snapshot: a direct `getProfile` would be an extra round trip per row build.
fn profile_meta(profile: &Value) -> String {
    let language = first_truthy_text(member(profile, "languageEntry"), &["label"]).unwrap_or_else(|| "System".to_owned());
    let experience = first_truthy_text(member(profile, "experienceLevelEntry"), &["label"]).unwrap_or_default();
    [text_of(member(profile, "title")), experience, language].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
}

/// The theme row's meta: the label of the active theme, else its id, else `Default` (also when the themes cannot be read).
fn theme_meta(host: &mut dyn PickerHost) -> String {
    let (Ok(id), Ok(listed)) = (host.store_call("getTheme", json!([])), host.store_call("listThemes", json!([]))) else {
        return "Default".to_owned();
    };
    let entry = listed.as_array().and_then(|themes| themes.iter().find(|theme| theme.get("id") == Some(&id)));
    entry.and_then(|entry| first_truthy_text(entry, &["label"])).or_else(|| truthy(&id).then(|| value_text(&id))).unwrap_or_else(|| "Default".to_owned())
}

fn update_meta(update: &Value) -> String {
    let current = first_truthy_text(update, &["currentVersion"]);
    let latest = first_truthy_text(update, &["latestVersion"]);
    let shown = current.clone().unwrap_or_else(|| "unknown".to_owned());
    if let (true, Some(latest)) = (truthy(member(update, "updateAvailable")), latest) {
        return format!("{shown} \u{2192} {latest}");
    }
    if current.is_none() { "unknown".to_owned() } else { format!("{shown} (latest)") }
}

/// What one Settings build reads from the snapshot (and the heavy cache on a light refresh): the values every row and toggle
/// works from.
#[derive(Clone, Debug)]
pub struct SettingsView {
    pub auto_clear: Value,
    pub auto_clear_enabled: bool,
    pub compaction: Value,
    pub web_search_on: bool,
    pub memory_tools_on: bool,
    pub system_shell: Value,
    pub output_style: Value,
    pub workflow: Value,
    pub mcp: Value,
    pub plugins: Value,
    pub skills: Value,
}

impl SettingsView {
    /// `readSettingsView({ snapshot, heavyCache, state })`.
    pub fn read(snapshot: &Value, heavy_cache: Option<&HeavyCache>, workflow: &Value) -> Self {
        let auto_clear = or_else(snapshot, "autoClear", json!({}));
        let tool_modules = or_else(snapshot, "toolModules", json!({}));
        let module_on = |name: &str| member(member(&tool_modules, name), "enabled") != &Value::Bool(false);
        let (mcp, plugins, skills) = match heavy_cache {
            Some(cache) => (cache.mcp.clone(), cache.plugins.clone(), cache.skills.clone()),
            None => (
                or_else(snapshot, "mcp", json!({"connectedCount": 0, "configuredCount": 0, "failedCount": 0})),
                or_else(snapshot, "plugins", json!({"count": 0})),
                or_else(snapshot, "skills", json!({"count": 0})),
            ),
        };
        Self {
            auto_clear_enabled: member(&auto_clear, "enabled") != &Value::Bool(false),
            auto_clear,
            compaction: or_else(snapshot, "compaction", json!({})),
            web_search_on: module_on("webSearch"),
            memory_tools_on: module_on("memory"),
            system_shell: or_else(snapshot, "systemShell", json!({"source": "auto", "command": "", "effective": ""})),
            output_style: or_else(snapshot, "outputStyle", json!({})),
            workflow: if truthy(workflow) { workflow.clone() } else { json!({}) },
            mcp,
            plugins,
            skills,
        }
    }

    /// The heavy status this build read, for the cache the next light refresh reuses.
    pub fn heavy(&self) -> HeavyCache {
        HeavyCache { mcp: self.mcp.clone(), plugins: self.plugins.clone(), skills: self.skills.clone() }
    }
}

fn row(value: &str, label: &str, meta: Option<String>, description: String) -> PickerItem {
    let mut item = PickerItem::new(value, label);
    item.meta = meta.unwrap_or_default();
    item.description = description;
    item
}

fn count(value: &Value, key: &str) -> String {
    let number = member(value, key);
    if truthy(number) { value_text(number) } else { "0".to_owned() }
}

fn auto_clear_row_text(view: &SettingsView) -> (String, String) {
    let auto_clear = &view.auto_clear;
    let provider = first_truthy_text(auto_clear, &["provider"]).unwrap_or_else(|| "default".to_owned());
    let auto_clear_source = if truthy(member(auto_clear, "providerCustom")) {
        format!(" ({provider} override)")
    } else if truthy(member(auto_clear, "custom")) {
        " (global)".to_owned()
    } else {
        format!(" ({provider} default)")
    };
    let unlimited = truthy(member(auto_clear, "unlimited"));
    let idle = duration_text(member(auto_clear, "idleMs"));
    if view.auto_clear_enabled {
        let window = if unlimited { "Never clear idle sessions".to_owned() } else { format!("Clear idle sessions after {idle}") };
        (format!("On ({})", if unlimited { "Unlimited" } else { idle.as_str() }), format!("{window}{auto_clear_source}. Enter for options."))
    } else {
        ("Off".to_owned(), "Idle auto-clear disabled. Enter for options.".to_owned())
    }
}

fn mcp_row_description(view: &SettingsView) -> String {
    let failed = member(&view.mcp, "failedCount");
    format!(
        "{}/{} connected{}",
        count(&view.mcp, "connectedCount"),
        count(&view.mcp, "configuredCount"),
        if truthy(failed) { format!(" \u{b7} {} failed", value_text(failed)) } else { String::new() }
    )
}

/// `buildSettingsItems(...)`: every row; its `value` is also the action Enter and the arrows dispatch on.
pub fn build_settings_items(host: &mut dyn PickerHost, snapshot: &Value, view: &SettingsView, voice_on: bool) -> Vec<PickerItem> {
    let state = host.state();
    let output_style_label = first_truthy_text(member(&view.output_style, "current"), &["label", "id"])
        .or_else(|| first_truthy_text(&view.output_style, &["configured"]))
        .unwrap_or_else(|| "Default".to_owned());
    let (auto_clear_meta, auto_clear_description) = auto_clear_row_text(view);
    let mcp_description = mcp_row_description(view);
    let shell_command = text_of(member(&view.system_shell, "command"));
    let shell_effective = text_of(member(&view.system_shell, "effective"));
    let theme = theme_meta(host);
    vec![
        row("model", "Model", Some(mixdog_view_model::display::model_display::display_model_name(&state.model, "")), "Main chat model.".to_owned()),
        row(
            "websearch",
            "Web search model",
            Some(host.route_model_label(&or_else(snapshot, "webSearchRoute", Value::Null))),
            "Native web-search model.".to_owned(),
        ),
        row("workflow", "Workflow", Some(workflow_display_name(&view.workflow)), "Active agent routing profile.".to_owned()),
        row("output-style", "Output style", Some(output_style_label), "Response tone and format.".to_owned()),
        row("profile", "Profile", Some(profile_meta(member(snapshot, "profile"))), "Your title, development experience, and response language.".to_owned()),
        row("theme", "Theme", Some(theme), "TUI color theme.".to_owned()),
        row(
            "web-search-enabled",
            "Web search",
            Some(bool_label(view.web_search_on).to_owned()),
            "Expose web search and fetch tools to new sessions.".to_owned(),
        ),
        row(
            "memory-enabled",
            "Memory",
            Some(bool_label(view.memory_tools_on).to_owned()),
            "Memory and recall tools plus core-memory injection for new sessions.".to_owned(),
        ),
        row(
            "autocompact",
            "Auto-compact",
            Some(bool_label(member(&view.compaction, "auto") != &Value::Bool(false)).to_owned()),
            "Compact when context is high.".to_owned(),
        ),
        row("autoclear", "Auto-clear", Some(auto_clear_meta), auto_clear_description),
        row("memory", "Core memories", None, "List and edit user-curated core memories.".to_owned()),
        row("providers", "Providers", None, "Auth, API keys, OAuth, local.".to_owned()),
        row("mcp", "MCP servers", None, mcp_description),
        row("plugins", "Plugins", None, format!("{} detected", count(&view.plugins, "count"))),
        row("skills", "Skills", None, format!("{} available", count(&view.skills, "count"))),
        row("voice", "Voice", Some(bool_label(voice_on).to_owned()), "Transcribe voice input (managed Whisper runtime).".to_owned()),
        row(
            "system-shell",
            "System shell",
            Some(if shell_command.is_empty() { "Auto".to_owned() } else { shell_command }),
            if shell_effective.is_empty() { "Use the platform default shell command.".to_owned() } else { format!("Effective command: {shell_effective}") },
        ),
        row("developer", "Developer", None, "Developer-only options.".to_owned()),
        row("update", "Update", Some(update_meta(&or_else(snapshot, "updateSettings", json!({})))), "Check version and update mixdog.".to_owned()),
    ]
}
