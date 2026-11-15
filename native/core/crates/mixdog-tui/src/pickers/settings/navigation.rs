//! Where Enter on a Settings row goes (`settings-picker/settings-navigation.mjs`): the owning picker with a return to Settings
//! (and a handoff panel where the write is slow), or the system-shell prompt.

use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

use super::host::{Own, PickerHost};
use super::panel::Panel;
use super::{open_panel, returning};
use crate::slash::host::{Opener, PromptSurface, TextPrompt};
use crate::slash::notices::{truthy, value_text};

/// `settingsHandoffPanel(description)`: painted before a slow write or snapshot so the empty-chat logo cannot appear between
/// the old panel and the destination.
pub fn settings_handoff_panel(description: &str) -> Panel {
    Panel {
        title: "Settings".to_owned(),
        description: description.to_owned(),
        help: Some("Esc Close".to_owned()),
        index_mode: Some(IndexMode::Never),
        picker_key: "settings-handoff".to_owned(),
        loading: true,
        ..Panel::default()
    }
}

/// `{ returnTo, handoffPanel }`.
fn with_handoff(description: &str) -> Value {
    let mut options = returning();
    options["handoffPanel"] = settings_handoff_panel(description).to_json();
    options
}

/// The opener and options of a navigation row, `None` for a row that is not one.
fn route(action: &str) -> Option<(Opener, Value)> {
    Some(match action {
        "autoclear" => (Opener::AutoClear, returning()),
        "profile" => (Opener::Profile, returning()),
        "output-style" => (Opener::OutputStyle, with_handoff("Applying output style...")),
        "theme" => (Opener::Theme, with_handoff("Applying theme...")),
        "workflow" => (Opener::Workflow, with_handoff("Switching workflow...")),
        "model" => {
            let mut options = with_handoff("Switching model...");
            options["returnLabel"] = json!("Settings");
            options["returnOnNestedCancel"] = json!(true);
            options["onAfterSelect"] = json!("settings");
            (Opener::Model, options)
        }
        "websearch" => {
            let mut options = returning();
            options["returnLabel"] = json!("Settings");
            options["returnOnNestedCancel"] = json!(true);
            (Opener::WebSearch, options)
        }
        "providers" => {
            let mut options = returning();
            options["onCancel"] = json!("settings");
            options["continueLabel"] = json!("Back to settings");
            options["continueDescription"] = json!("return to settings");
            (Opener::ProviderSetup, options)
        }
        "mcp" => (Opener::Mcp, json!({})),
        "plugins" => (Opener::Plugins, json!({})),
        "skills" => (Opener::Skills, json!({})),
        "memory" => (Opener::MemoryCore, returning()),
        "developer" => (Opener::Developer, returning()),
        "update" => (Opener::Update, returning()),
        _ => return None,
    })
}

/// Enter on a navigation row; false when the row is not one. `own` is the Settings claim, closed before the shell prompt takes
/// the surface.
pub fn open_row(host: &mut dyn PickerHost, own: &mut Own, action: &str, system_shell: &Value) -> bool {
    if action == "system-shell" {
        own.close(host);
        let mut prompt = TextPrompt::new("system-shell");
        prompt.label = "System shell".to_owned();
        prompt.hint = "Enter a shell command, or leave empty for automatic selection. Windows accepts powershell.exe or pwsh."
            .to_owned();
        let command = system_shell.get("command").filter(|command| truthy(command)).map(value_text);
        prompt.initial_value = Some(command.unwrap_or_default());
        host.set_prompt(PromptSurface::Settings, Some(prompt));
        return true;
    }
    let Some((opener, options)) = route(action) else { return false };
    open_panel(host, opener, options);
    true
}
