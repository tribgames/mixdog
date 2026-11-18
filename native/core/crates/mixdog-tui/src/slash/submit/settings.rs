//! Text-entry prompts opened from the settings, project and profile pickers and the extension surfaces (plugins, MCP servers,
//! skills, core memory) (`prompt-submit/settings-prompts.mjs`). Daemon-acknowledged writes go through the settings panel
//! write; extension writes close the prompt at once and report through notices.

use mixdog_js::{js_to_lowercase, js_trim};
use mixdog_term::paste::PromptContent;
use serde_json::{Map, Value, json};

use super::panel_write::{begin, end, fail, finish, in_flight};
use super::{open_panel, submit_prompt};
use crate::slash::host::{Opener, PromptSurface, SlashHost, TextPrompt, Tone};
use crate::slash::notices::{project_name_from_path, truthy, value_text};
use crate::slash::parsers::{memory_core_result_error_text, parse_mcp_server_input, parse_skill_input};
use crate::slash::store_service_call::service_call;

const SETTINGS: PromptSurface = PromptSurface::Settings;

/// One acknowledged settings write: `begin`, the service call, then `finish(after)` or `fail` (restoring the typed value).
/// `value` is what a failure restores.
fn settings_save(
    host: &mut dyn SlashHost,
    target: &TextPrompt,
    value: &str,
    method: &str,
    args: Vec<Value>,
    on_saved: impl FnOnce(&mut dyn SlashHost, &Value),
    after: impl FnOnce(&mut dyn SlashHost),
    failure_prefix: &str,
) -> bool {
    let token = begin(host, SETTINGS, target);
    match service_call(host, method, args) {
        Ok(result) => {
            on_saved(host, &result);
            finish(host, SETTINGS, token, after);
        }
        Err(error) => fail(host, SETTINGS, target, value, &format!("{failure_prefix}: {error}"), token, Tone::Error),
    }
    true
}

fn none_saved(_: &mut dyn SlashHost, _: &Value) {}

fn require_text(host: &mut dyn SlashHost, text: &str, notice: &str) -> bool {
    if !text.is_empty() {
        return true;
    }
    host.push_notice(notice, Tone::Warn);
    false
}

fn set_cwd(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    if !require_text(host, command_text, "working directory path is required") {
        return false;
    }
    let message = format!("Project set: {}", project_name_from_path(command_text));
    settings_save(
        host,
        target,
        command_text,
        "setCwd",
        vec![json!(command_text), json!({"message": message})],
        none_saved,
        |host| open_panel(host, Opener::Settings, json!({})),
        "project switch failed",
    )
}

fn register_project(host: &mut dyn SlashHost, path: &str) {
    if let Err(error) = host.register_project(path) {
        host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
    }
}

fn project_new(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    if !require_text(host, command_text, "project path is required") {
        return false;
    }
    let token = begin(host, SETTINGS, target);
    match service_call(host, "inspectProjectPath", vec![json!(command_text)]) {
        Ok(result) => {
            let path =
                result.get("path").filter(|path| truthy(path)).map_or_else(|| command_text.to_owned(), value_text);
            if result.get("directory") == Some(&Value::Bool(true)) {
                finish(host, SETTINGS, token, |host| register_project(host, &path));
            } else if result.get("exists") == Some(&Value::Bool(true)) {
                let message = format!("{path} is not a directory");
                fail(host, SETTINGS, target, command_text, &message, token, Tone::Warn);
            } else {
                end(host, SETTINGS, token);
                if !host.is_panel_epoch_current(token) {
                    return true;
                }
                host.supersede_panel_epoch();
                let mut confirm = TextPrompt::new("project-create-confirm");
                confirm.label = "New project \u{b7} Create folder?".to_owned();
                confirm.hint = format!("{path} does not exist. Type \"y\" to create it, or anything else to cancel.");
                confirm.fields.insert("pendingPath".to_owned(), Value::String(path));
                host.set_prompt(SETTINGS, Some(confirm));
            }
        }
        Err(error) => {
            let message = format!("project path check failed: {error}");
            fail(host, SETTINGS, target, command_text, &message, token, Tone::Error);
        }
    }
    true
}

fn is_yes(command_text: &str) -> bool {
    matches!(js_to_lowercase(js_trim(command_text)).as_str(), "y" | "yes")
}

fn project_create_confirm(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    let pending_path = target.text("pendingPath");
    if !is_yes(command_text) {
        host.set_prompt(SETTINGS, None);
        host.push_notice("project creation canceled", Tone::Info);
        return true;
    }
    let token = begin(host, SETTINGS, target);
    match service_call(host, "ensureProjectDirectory", vec![json!(pending_path)]) {
        Ok(created) => {
            let path = if truthy(&created) { value_text(&created) } else { pending_path };
            finish(host, SETTINGS, token, |host| register_project(host, &path));
        }
        Err(error) => {
            end(host, SETTINGS, token);
            host.push_notice(&format!("could not create folder: {error}"), Tone::Error);
            // The typed value here is only the y/n answer, so close rather than restore, but never close a surface this
            // write no longer owns.
            if host.is_panel_epoch_current(token) {
                host.set_prompt(SETTINGS, None);
            }
        }
    }
    true
}

fn project_rename(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    settings_save(
        host,
        target,
        command_text,
        "renameProject",
        vec![json!(target.text("projectPath")), json!(command_text)],
        |host, updated| {
            if truthy(updated) {
                let name = updated.get("name").map_or_else(|| "undefined".to_owned(), value_text);
                host.push_notice(&format!("project renamed to \"{name}\""), Tone::Info);
            }
        },
        |host| open_panel(host, Opener::Project, json!({})),
        "rename failed",
    )
}

fn system_shell(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    // Empty is the documented reset to automatic selection.
    settings_save(
        host,
        target,
        command_text,
        "setSystemShell",
        vec![json!(command_text)],
        none_saved,
        |host| open_panel(host, Opener::Settings, json!({})),
        "system shell update failed",
    )
}

fn auto_clear_provider(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    let provider = js_trim(&target.text("provider")).to_owned();
    if provider.is_empty() {
        host.push_notice("auto-clear provider is missing", Tone::Warn);
        return false;
    }
    let duration = js_trim(command_text).to_owned();
    // Empty is the documented reset to the built-in provider default.
    let patch = if duration.is_empty() {
        json!({"provider": provider, "resetProvider": true})
    } else {
        json!({"provider": provider, "duration": duration})
    };
    let (saved_provider, saved_duration) = (provider.clone(), duration.clone());
    settings_save(
        host,
        target,
        &duration,
        "setAutoClear",
        vec![patch],
        move |host, _| {
            let text = if saved_duration.is_empty() {
                format!("Auto-clear {saved_provider} default reset")
            } else {
                format!("Auto-clear {saved_provider} default set to {saved_duration}")
            };
            host.push_notice(&text, Tone::Info);
        },
        |host| {
            if let Err(error) = host.open_with_return(Opener::AutoClear, json!({"advanced": true}), target) {
                host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
            }
        },
        "autoclear failed",
    )
}

fn profile_title(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    // Empty is the documented "clear the title" action.
    let text = if command_text.is_empty() {
        "Title cleared".to_owned()
    } else {
        format!("Title set to \"{}\"", js_trim(command_text))
    };
    settings_save(
        host,
        target,
        command_text,
        "setProfile",
        vec![json!({"title": command_text})],
        move |host, _| host.push_notice(&text, Tone::Info),
        |host| open_panel(host, Opener::Profile, json!({})),
        "profile update failed",
    )
}

/// Extension adds close the prompt immediately; the store call reports back through a notice and reopens the owning picker
/// on success.
fn extension_add(host: &mut dyn SlashHost, method: &str, value: Value, reopen: Opener, failure_prefix: &str) -> bool {
    // `store[method]?.(value).then(...)`: a store without the method only closes the prompt.
    if !host.has_store_method(method) {
        host.set_prompt(SETTINGS, None);
        return true;
    }
    let result = host.store_call(method, json!([value]));
    host.set_prompt(SETTINGS, None);
    let outcome = result.and_then(|_| host.open(reopen, json!({})));
    if let Err(error) = outcome {
        host.push_notice(&format!("{failure_prefix}: {error}"), Tone::Error);
    }
    true
}

fn plugin_add(host: &mut dyn SlashHost, _target: &TextPrompt, command_text: &str) -> bool {
    if !require_text(host, command_text, "plugin URL/path is required") {
        return false;
    }
    extension_add(host, "addPlugin", json!(command_text), Opener::Plugins, "plugin add failed")
}

fn mcp_add(host: &mut dyn SlashHost, _target: &TextPrompt, command_text: &str) -> bool {
    match parse_mcp_server_input(command_text) {
        Ok(server) => extension_add(host, "addMcpServer", server, Opener::McpServers, "mcp add failed"),
        Err(usage) => {
            host.push_notice(&usage, Tone::Warn);
            false
        }
    }
}

fn skill_add(host: &mut dyn SlashHost, _target: &TextPrompt, command_text: &str) -> bool {
    match parse_skill_input(command_text) {
        Ok(skill) => extension_add(host, "addSkill", skill, Opener::ProjectSkills, "skill add failed"),
        Err(usage) => {
            host.push_notice(&usage, Tone::Warn);
            false
        }
    }
}

fn skill_use(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    let skill_name = js_trim(&target.text("skillName")).to_owned();
    if skill_name.is_empty() {
        host.push_notice("skill name is missing", Tone::Warn);
        return false;
    }
    let suffix = if command_text.is_empty() { String::new() } else { format!(" {command_text}") };
    host.set_prompt(SETTINGS, None);
    let accepted = submit_prompt(host, &PromptContent::Text(format!("${skill_name}{suffix}")), None);
    if accepted {
        host.arm_transcript_follow();
    }
    accepted
}

/// Core memory writes: the prompt closes first; the result (or an error text carried inside a successful reply) lands as a
/// notice and the picker reopens.
fn core_memory_write(host: &mut dyn SlashHost, args: Value, success: &str, failure_prefix: &str) -> bool {
    // `store.memoryControl?.(...).then(...)`: a store without the method reports nothing and reopens nothing.
    if !host.has_store_method("memoryControl") {
        return true;
    }
    match host.store_call("memoryControl", json!([args])) {
        Ok(result) => {
            let text = if truthy(&result) { value_text(&result) } else { String::new() };
            match memory_core_result_error_text(&text) {
                Some(error) => host.push_notice(&error, Tone::Error),
                None => host.push_notice(success, Tone::Info),
            }
        }
        Err(error) => host.push_notice(&format!("{failure_prefix}: {error}"), Tone::Error),
    }
    open_panel(host, Opener::MemoryCore, json!({}));
    true
}

fn core_add(host: &mut dyn SlashHost, _target: &TextPrompt, command_text: &str) -> bool {
    let sentence = js_trim(command_text);
    if !require_text(host, sentence, "memory sentence is required") {
        return false;
    }
    host.set_prompt(SETTINGS, None);
    core_memory_write(
        host,
        json!({"action": "core", "op": "add", "project_id": "common", "element": sentence, "summary": sentence}),
        "core memory added",
        "core add failed",
    )
}

/// The arguments naming the memory entry a prompt was opened for.
fn core_entry_args(target: &TextPrompt, op: &str) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert("action".to_owned(), json!("core"));
    args.insert("op".to_owned(), json!(op));
    args.insert("id".to_owned(), target.fields.get("_id").cloned().unwrap_or(Value::Null));
    if let Some(revision) = target.fields.get("_indexRevision") {
        args.insert("index_revision".to_owned(), revision.clone());
    }
    let project = target.fields.get("_projectId").filter(|project| !project.is_null()).cloned();
    args.insert("project_id".to_owned(), project.unwrap_or_else(|| json!("common")));
    args
}

fn core_edit(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    let sentence = js_trim(command_text);
    if !require_text(host, sentence, "memory sentence is required") {
        return false;
    }
    host.set_prompt(SETTINGS, None);
    // Single-sentence semantics only rewrite `element` when the row was already element === summary at load. A distinct
    // legacy element carries meaning this text prompt never captured: clobbering it on every edit would corrupt the entry.
    // Otherwise only `summary` is sent.
    let mut args = core_entry_args(target, "edit");
    if target.fields.get("_singleSentence").is_some_and(truthy) {
        args.insert("element".to_owned(), json!(sentence));
    }
    args.insert("summary".to_owned(), json!(sentence));
    core_memory_write(host, Value::Object(args), "core memory updated", "core edit failed")
}

fn core_delete_confirm(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    host.set_prompt(SETTINGS, None);
    if !is_yes(command_text) {
        host.push_notice("delete canceled", Tone::Info);
        open_panel(host, Opener::MemoryCore, json!({}));
        return true;
    }
    core_memory_write(
        host,
        Value::Object(core_entry_args(target, "delete")),
        "core memory deleted",
        "core delete failed",
    )
}

type SettingsHandler = fn(&mut dyn SlashHost, &TextPrompt, &str) -> bool;

fn handler_for(kind: &str) -> Option<SettingsHandler> {
    Some(match kind {
        "cwd" => set_cwd,
        "project-new" => project_new,
        "project-create-confirm" => project_create_confirm,
        "project-rename" => project_rename,
        "system-shell" => system_shell,
        "autoclear-provider" => auto_clear_provider,
        "profile-title" => profile_title,
        "plugin-add" => plugin_add,
        "mcp-add" => mcp_add,
        "skill-add" => skill_add,
        "skill-use" => skill_use,
        "core-add" => core_add,
        "core-edit" => core_edit,
        "core-delete-confirm" => core_delete_confirm,
        _ => return None,
    })
}

/// `submitSettingsPrompt(ctx, settingsPrompt, commandText)`: `Some(handled)` when the prompt consumed the submit, `None` for
/// an unknown kind.
///
/// Settings writes are daemon calls and the panel stays open until they are acknowledged, so a second Enter used to start an
/// overlapping write whose older acknowledgement closed the prompt that already held the newer, restored value and lost the
/// user's input. One write at a time per surface, and a superseded acknowledgement is ignored by the panel write.
pub fn submit_settings_prompt(host: &mut dyn SlashHost, prompt: &TextPrompt, command_text: &str) -> Option<bool> {
    if host.state().command_busy {
        host.push_notice("wait for the current command to finish", Tone::Warn);
        return Some(false);
    }
    if in_flight(host, SETTINGS) {
        host.push_notice("wait for the current settings change to finish", Tone::Warn);
        return Some(false);
    }
    handler_for(&prompt.kind).map(|handler| handler(host, prompt, command_text))
}
