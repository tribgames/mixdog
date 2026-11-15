//! The prompt draft and slash-palette flow (`app/use-prompt-draft-flow.mjs`, `use-prompt-draft-flow/{draft-change,
//! prompt-cancels}.mjs`): keystroke-time draft sync (the slash-token lift, the history-navigation reset, argument hints), the
//! two text-entry prompt cancel paths, and accept, complete and cancel for the slash palette.

use serde_json::json;

use crate::editor::helpers::HintTone;
use crate::editor::prompt::PaletteReply;
use crate::slash::commands::{slash_argument_hint, slash_command_token_for_palette_accept, slash_query};
use crate::slash::dispatch::run_slash_command;
use crate::slash::host::{Opener, PromptSurface, Tone};
use crate::slash::palette::{PaletteItem, complete_skill_mention};
use crate::slash::submit::open_panel;

use super::host::PromptHost;

/// What one prompt keystroke does outside the prompt input: layout rows, the history-navigation reset, the slash-token lift
/// into the App state, and the argument hint.
///
/// Pasted-text entries are not pruned on an edit: a partially edited token can be undone back to its intact form, which must
/// still expand on submit, so entries are kept until an accepted submit or an explicit clear.
pub fn apply_prompt_draft_change(host: &mut dyn PromptHost, value: &str) {
    if !value.is_empty() {
        host.dismiss_welcome_prompt_hint();
    }
    host.sync_prompt_layout_rows(value);
    let state = host.prompt();
    let suppress_hint = state.history_draft_change;
    state.history_draft_change = false;
    let nav = &state.history_nav;
    if value.is_empty() || (nav.active && value != nav.last_value && value != nav.seed) {
        state.reset_history_nav();
    }
    // The draft is lifted into App state only when it can affect the slash palette (a single "/token"); prose typing renders
    // inside the prompt input. Entering and leaving slash mode both sync, and so does clearing, so a consumed slash command
    // does not come back later as a stale initial value.
    let next_slash = slash_query(value).is_some();
    let previous_was_slash_flow = state.draft.starts_with('/');
    if value.is_empty() {
        state.draft.clear();
    } else if next_slash || previous_was_slash_flow {
        state.draft = value.to_owned();
    }
    state.draft_override = None;
    let argument_hint = slash_argument_hint(value);
    if !argument_hint.is_empty() && !suppress_hint {
        host.show_prompt_hint(&argument_hint, HintTone::Info, None);
    } else if suppress_hint || host.prompt().hint.is_live() {
        // Only clear when a hint is live (shown or pending its timer): clearing on every keystroke would redraw the frame per
        // key. A hint still vanishes at once because the guard includes the active state, also when the draft went empty.
        host.clear_prompt_hint();
    }
    let state = host.prompt();
    if !state.slash_dismissed_for.is_empty() && state.slash_dismissed_for != value {
        state.slash_dismissed_for.clear();
    }
}

/// Esc out of the provider text-entry prompt. The keypress takes the surface back first (the panel epoch is superseded), so an
/// in-flight save that acknowledges later cannot reopen or replace whatever the user does next; then the panel the prompt was
/// reached from is returned to.
pub fn cancel_provider_prompt(host: &mut dyn PromptHost) {
    host.supersede_panel_epoch();
    let prompt = host.provider_prompt();
    if let Some(prompt) = &prompt {
        host.cancel_provider_login(prompt);
    }
    host.set_oauth_submitting(false);
    host.set_prompt(PromptSurface::Provider, None);
    if let Some(prompt) = &prompt
        && !host.provider_cancel_return(prompt)
    {
        host.provider_after_save(prompt);
    }
}

/// Esc out of the settings text-entry prompt: the project entry prompts return to the project picker, the memory core ones to
/// the memory picker and the auto-clear provider prompt to the auto-clear picker, rather than dropping to a bare prompt.
pub fn cancel_settings_prompt(host: &mut dyn PromptHost) {
    host.supersede_panel_epoch();
    let target = host.settings_prompt();
    host.set_prompt(PromptSurface::Settings, None);
    let Some(target) = target else { return };
    match target.kind.as_str() {
        "project-new" | "project-create-confirm" | "project-rename" => open_panel(host, Opener::Project, json!({})),
        "core-add" | "core-edit" | "core-delete-confirm" => open_panel(host, Opener::MemoryCore, json!({})),
        "autoclear-provider" => {
            if let Err(error) = host.open_with_return(Opener::AutoClear, json!({ "advanced": true }), &target) {
                host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
            }
        }
        _ => {}
    }
}

/// `acceptSlashPalette(draftValue, caret)`: a skill row completes the `$name` mention at the caret (the returned draft replaces
/// the box) instead of running anything; a command row runs with the picker Enter latch armed.
pub fn accept_slash_palette(host: &mut dyn PromptHost, draft_value: &str, caret: Option<i64>) -> PaletteReply {
    let Some(item) = host.selected_palette_item() else { return PaletteReply::Declined };
    match item {
        PaletteItem::Skill { name, .. } => match complete_skill_mention(draft_value, &name, caret) {
            Some(done) => PaletteReply::Draft { value: done.value, cursor: done.cursor },
            None => PaletteReply::Declined,
        },
        PaletteItem::Command(command) => {
            let token = slash_command_token_for_palette_accept(command, draft_value);
            host.enter_latch().arm();
            let accepted = run_slash_command(host, &token, "");
            let now = host.now_ms();
            host.enter_latch().finish(now);
            if accepted { PaletteReply::Accepted } else { PaletteReply::Declined }
        }
    }
}

/// `completeSlashPalette(draftValue, caret)`: Tab on a palette row: `/token ` for a command, the completed mention for a skill.
pub fn complete_slash_palette(host: &mut dyn PromptHost, draft_value: &str, caret: Option<i64>) -> PaletteReply {
    let Some(item) = host.selected_palette_item() else { return PaletteReply::Accepted };
    match item {
        PaletteItem::Skill { name, .. } => match complete_skill_mention(draft_value, &name, caret) {
            Some(done) => PaletteReply::Draft { value: done.value, cursor: done.cursor },
            None => PaletteReply::Accepted,
        },
        PaletteItem::Command(command) => {
            let token = slash_command_token_for_palette_accept(command, draft_value);
            if token.is_empty() { PaletteReply::Accepted } else { PaletteReply::Text(format!("/{token} ")) }
        }
    }
}

/// `cancelSlashPalette(value)`: the suggestions close without changing the draft. The exact value is remembered so the palette
/// does not reopen at once; the next edit clears the marker in [`apply_prompt_draft_change`].
pub fn cancel_slash_palette(host: &mut dyn PromptHost, value: &str) {
    host.prompt().slash_dismissed_for = value.to_owned();
}
