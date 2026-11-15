//! `shell-layout/surfaces.mjs`: which surfaces own the bottom area this render (floating panels, text-entry prompts, boot
//! settling) and the live spinner and transient hint the prompt cluster shows.

use super::{HintText, ShellLayoutInput, ShellRefs, TextEntryPrompt, TranscriptTail};

/// What owns the bottom area.
#[derive(Clone, Debug, Default)]
pub(super) struct Surfaces {
    pub text_entry_prompt: Option<TextEntryPrompt>,
    pub has_text_entry_prompt: bool,
    pub has_floating_panel: bool,
    pub expanded_option_panel: bool,
    pub boot_settling: bool,
    pub project_selection_active: bool,
    pub input_box_hidden: bool,
}

/// The kinds of the settings prompt that belong to the initial project entry.
const PROJECT_PROMPT_KINDS: [&str; 3] = ["project-new", "project-create-confirm", "project-rename"];

/// `deriveSurfaces(input)`. Latches `project_boot_input_latch` once the project picker has gone.
pub(super) fn derive_surfaces(input: &ShellLayoutInput, refs: &mut ShellRefs) -> Surfaces {
    let text_entry_prompt = input.provider_prompt.clone().or_else(|| input.settings_prompt.clone());
    let has_text_entry_prompt = text_entry_prompt.is_some();
    let picker = input.picker.is_some();
    let has_floating_panel = input.tool_approval.is_some()
        || picker
        || input.context_panel
        || input.usage_panel
        || input.slash_palette_open
        || has_text_entry_prompt
        || input.btw_panel.is_some();
    let expanded_option_panel = input.tool_approval.is_some() || picker || input.context_panel || input.usage_panel || has_text_entry_prompt;
    if refs.panel_transition.signature.contains("picker:project") && !picker {
        refs.project_boot_input_latch = true;
    }
    let boot_settling = !input.tui_ready && input.state.item_count == 0 && !has_floating_panel && !refs.project_boot_input_latch;
    // Project selection (the initial-entry experience) keeps the welcome banner visible above the picker or the path-entry
    // prompt, unlike the other floating panels.
    let project_selection_active = input.picker.as_ref().is_some_and(|picker| picker.kind == "project")
        || input.settings_prompt.as_ref().is_some_and(|prompt| PROJECT_PROMPT_KINDS.contains(&prompt.kind.as_str()));
    // Slash search floats above the normal prompt. Actual option panels own the prompt and status area, so they hide those
    // rows and expand into that space.
    let input_box_hidden = expanded_option_panel || boot_settling;
    Surfaces {
        text_entry_prompt,
        has_text_entry_prompt,
        has_floating_panel,
        expanded_option_panel,
        boot_settling,
        project_selection_active,
        input_box_hidden,
    }
}

/// `deriveLiveHints(input)`: the live spinner and the transient hint.
#[derive(Clone, Debug, Default)]
pub(super) struct LiveHints {
    pub live_spinner: bool,
    /// The command-status spinner (auto-clear, compact and the like) is not part of the spinner to TurnDone handoff: it
    /// typically starts while the transcript tail is already a done row (an idle session), so the done-at-tail suppression
    /// must never hide it, which read as a frozen UI during auto-clear.
    pub live_spinner_is_command: bool,
    pub latest_toast: Option<HintText>,
    pub toast_hint: String,
    pub progress_hint: Option<HintText>,
    pub input_hint: String,
    pub input_hint_tone: String,
    pub latest_transcript_item: Option<TranscriptTail>,
}

pub(super) fn derive_live_hints(input: &ShellLayoutInput) -> LiveHints {
    let state = &input.state;
    let live_spinner = state.spinner_active || state.command_status_active;
    let live_spinner_is_command = !state.spinner_active && state.command_status_active;
    let toast_hint = state.latest_toast.as_ref().map(|toast| toast.text.clone()).unwrap_or_default();
    let first_text = |texts: [&str; 3]| texts.into_iter().find(|text| !text.is_empty()).unwrap_or("").to_owned();
    let progress_text = state.progress_hint.as_ref().map_or("", |hint| hint.text.as_str());
    let input_hint = first_text([input.prompt_hint.as_str(), toast_hint.as_str(), progress_text]);
    let input_hint_tone = if !input.prompt_hint.is_empty() {
        input.prompt_hint_tone.clone()
    } else {
        let toast_tone = state.latest_toast.as_ref().map_or("", |toast| toast.tone.as_str());
        let progress_tone = state.progress_hint.as_ref().map_or("", |hint| hint.tone.as_str());
        first_text([toast_tone, progress_tone, "info"])
    };
    LiveHints {
        live_spinner,
        live_spinner_is_command,
        latest_toast: state.latest_toast.clone(),
        toast_hint,
        progress_hint: state.progress_hint.clone(),
        input_hint,
        input_hint_tone,
        latest_transcript_item: state.latest_item.clone(),
    }
}
