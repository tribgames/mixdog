//! One frame of the application (`App.jsx`'s render): the shell layout from the published state and the surfaces, the transcript
//! window and its rows, the panel slots, and [`crate::view::render_app`] over a fresh grid.

use mixdog_term::frame::{CursorPos, Grid};
use mixdog_term::paint::Painter;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::sign_in_url::CopyStatus;
use mixdog_tui_widgets::text_entry::TextEntryDraft;
use serde_json::{Map, Value, json};

use super::AppState;
use crate::slash::host::TextPrompt;
use crate::surface::layout::{
    BtwPanel, HintText, PickerLayout, QueuedCommand, ShellLayoutInput, ShellState, StreamingTail, TextEntryPrompt, TranscriptTail,
    compute_shell_layout,
};
use crate::transcript::window::heights::{HeightParams, item_id, item_kind};
use crate::transcript::window::render_window::{WindowTuning, transcript_render_window};
use crate::transcript::window::row_index::Items;
use crate::transcript::window::visible_items::{overlay_hint_placement, visible_transcript_items};
use crate::view::panel::{PanelSlots, PickerSlot, TextEntrySlot, fit_picker};
use crate::view::rows::{MountInput, mount_rows};
use crate::view::{AppViewProps, render_app};

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

fn active(value: &Value, key: &str) -> bool {
    value.get(key).and_then(|member| member.get("active")) == Some(&Value::Bool(true))
}

fn hint_text(value: &Value) -> Option<HintText> {
    value.is_object().then(|| HintText { text: text(value, "text"), tone: text(value, "tone") })
}

/// `{ kind, label, hint, ...fields }`: the prompt as the view's labels read it.
fn prompt_value(prompt: &TextPrompt) -> Value {
    let mut map: Map<String, Value> = prompt.fields.clone();
    map.insert("kind".to_owned(), json!(prompt.kind));
    map.insert("label".to_owned(), json!(prompt.label));
    map.insert("hint".to_owned(), json!(prompt.hint));
    Value::Object(map)
}

fn entry_prompt(prompt: &TextPrompt) -> TextEntryPrompt {
    TextEntryPrompt { kind: prompt.kind.clone(), detail: prompt.text("detail") }
}

/// What the shell layout reads of the published state.
fn shell_state(state: &Value, items: &[Value]) -> ShellState {
    ShellState {
        item_count: items.len(),
        latest_item: items.last().map(|item| TranscriptTail { id: item_id(item), kind: item_kind(item).to_owned() }),
        queued: state
            .get("queued")
            .and_then(Value::as_array)
            .map(|queued| queued.iter().map(|entry| QueuedCommand { display_text: text(entry, "displayText"), text: text(entry, "text") }).collect())
            .unwrap_or_default(),
        spinner_active: active(state, "spinner"),
        command_status_active: active(state, "commandStatus"),
        latest_toast: state.get("toasts").and_then(Value::as_array).and_then(|toasts| toasts.last()).and_then(hint_text),
        progress_hint: state.get("progressHint").and_then(hint_text),
        streaming_tail: state
            .get("streamingTail")
            .filter(|tail| tail.is_object())
            .map(|tail| StreamingTail { kind: item_kind(tail).to_owned(), streaming: tail.get("streaming") == Some(&Value::Bool(true)), text: text(tail, "text") }),
        transcript_view_active: state.get("transcriptViewItems").is_some_and(Value::is_array),
    }
}

impl AppState {
    /// Paints the application for a terminal of `columns` by `rows`: the grid and where the hardware cursor goes.
    pub fn render_frame(&mut self, columns: u16, rows: u16) -> (Grid, Option<CursorPos>) {
        let state = self.store.state();
        let columns_used = usize::from(columns);
        let rows_used = usize::from(rows);
        let frame_columns = columns_used.saturating_sub(1).max(1);
        self.view_columns = frame_columns;
        let view_items = state.get("transcriptViewItems").filter(|items| items.is_array());
        let items: &[Value] = view_items
            .or_else(|| state.get("items"))
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let tail = if view_items.is_some() { None } else { state.get("streamingTail").filter(|tail| tail.is_object()) };
        let list = Items::new(items, tail);
        let (selected, confirm_focus) = self.picker_selection().unwrap_or((0, -1));
        let picker = self.surface.picker().cloned();
        let btw_panel = self.btw.panel().cloned();
        let input = ShellLayoutInput {
            provider_prompt: self.provider_prompt.as_ref().map(entry_prompt),
            settings_prompt: self.settings_prompt.as_ref().map(entry_prompt),
            tool_approval: state.get("toolApproval").filter(|approval| approval.is_object()).cloned(),
            picker: picker.as_ref().map(|picker| PickerLayout { kind: picker.layout_kind(), fill_available: false }),
            context_panel: self.surface.context().is_some(),
            usage_panel: self.surface.usage().is_some(),
            btw_panel: btw_panel.as_ref().map(|panel| BtwPanel { done: text(panel, "status") == "done", text: text(panel, "text") }),
            slash_palette_open: false,
            tui_ready: self.chrome.is_ready(),
            state: shell_state(&state, items),
            rows: rows_used,
            frame_columns,
            prompt_hint: self.prompt.hint.text().to_owned(),
            prompt_hint_tone: format!("{:?}", self.prompt.hint.tone()).to_lowercase(),
            text_entry_layout_rows: 0,
            onboarding_active: self.onboarding_active,
            conditional_welcome_prompt_hint: String::new(),
            welcome_prompt_hint_dismissed: true,
            welcome_prompt_hint: String::new(),
            panel_transition_epoch: self.surface.epoch().current(),
            prompt_layout_value: self.prompt_layout_value.clone(),
            prompt_content_columns: frame_columns.saturating_sub(4).max(1),
        };
        self.shell_refs.frame_rows = rows_used;
        let layout = compute_shell_layout(&input, &mut self.shell_refs);
        self.picker_visible_rows = layout.picker_visible_rows;

        let params = HeightParams { columns: frame_columns, tool_output_expanded: self.tool_output_expanded };
        let revision = state.get("structureRevision").and_then(Value::as_u64).unwrap_or(0);
        let index = self.row_index.build(&list, &mut self.heights, &params, revision);
        let window = transcript_render_window(index, self.scroll.scroll_offset as f64, layout.transcript_content_height as f64, &WindowTuning::current());
        let rendered = visible_transcript_items(&list, &window);
        let overlay = overlay_hint_placement(&rendered, &window, layout.overlay_hint_requested, layout.floating_panel_rows, layout.transcript_guard_rows);
        let streaming_tail_id = tail.and_then(|tail| tail.get("id")).and_then(Value::as_str);
        let mounted = mount_rows(
            &mut self.heights,
            &MountInput {
                items: &list,
                window: &window,
                layout: &layout,
                frame_columns,
                tool_output_expanded: self.tool_output_expanded,
                streaming_tail_id,
                overlay: &overlay,
                now_ms: self.clock.now() as f64,
            },
        );

        let mut picker_props = picker.as_ref().map(|picker| picker.props(frame_columns, selected));
        if let Some(props) = picker_props.as_mut() {
            fit_picker(props, frame_columns, &layout);
        }
        let provider_value = self.provider_prompt.as_ref().map(prompt_value);
        let settings_value = self.settings_prompt.as_ref().map(prompt_value);
        let entry_draft = TextEntryDraft::default();
        let panels = PanelSlots {
            picker: picker_props.as_ref().map(|props| PickerSlot { props, selected, confirm_focus, status: CopyStatus::Idle }),
            provider_prompt: provider_value.as_ref().map(|prompt| TextEntrySlot { prompt, draft: &entry_draft, status: CopyStatus::Idle }),
            settings_prompt: settings_value.as_ref().map(|prompt| TextEntrySlot { prompt, draft: &entry_draft, status: CopyStatus::Idle }),
            ..PanelSlots::default()
        };
        let queued: &[Value] = state.get("queued").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let spinner: &[Line] = &[];
        let props = AppViewProps {
            columns: columns_used,
            rows: rows_used,
            layout: &layout,
            cwd: &self.options.cwd,
            version: &self.options.version,
            transcript: &mounted,
            overlay: &overlay,
            panels,
            draft: &self.draft,
            exiting: self.prompt.exit.requested(),
            tui_ready: self.chrome.is_ready(),
            spinner,
            queued,
            footer: "",
            workflow: state.get("workflow").filter(|workflow| workflow.is_object()),
        };
        let mut grid = Grid::new(columns, rows);
        let frame = render_app(&props, &mut Painter::new(&mut grid));
        // Writes the surface made since the last frame are what this frame shows.
        let _ = self.surface.take_events();
        (grid, frame.cursor)
    }
}
