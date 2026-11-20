//! One frame of the application (`App.jsx`'s render): the shell layout from the published state and the surfaces, the transcript
//! window and its rows, the panel slots, and [`crate::view::render_app`] over a fresh grid.

use mixdog_term::frame::{CursorPos, Grid};
use mixdog_term::paint::Painter;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::palette::SlashCommand as WidgetCommand;
use mixdog_tui_widgets::sign_in_url::CopyStatus;
use serde_json::{Map, Value, json};

use super::AppState;
use crate::slash::host::{PromptSurface, TextPrompt};
use crate::slash::palette::{PaletteItem, PaletteKind};
use crate::surface::layout::{
    BtwPanel, HintText, PickerLayout, QueuedCommand, ShellLayoutInput, ShellState, StreamingTail, TextEntryPrompt, TranscriptTail, compute_shell_layout,
};
use crate::transcript::scroll::anchor::Geometry;
use crate::transcript::scroll::lock::{CommitFrame, RowIndex as LockRows};
use crate::transcript::window::heights::{HeightParams, item_id, item_kind};
use crate::transcript::window::render_window::{WindowTuning, transcript_render_window};
use crate::transcript::window::row_index::Items;
use crate::transcript::window::visible_items::{overlay_hint_placement, visible_transcript_items};
use crate::view::panel::{PaletteSlot, PanelSlots, PickerSlot, TextEntrySlot, ToolApprovalSlot, fit_picker, settings_entry_layout_rows};
use crate::view::rows::{MountInput, mount_rows};
use crate::view::{AppFrame, AppViewProps, render_app};

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
        streaming_tail: state.get("streamingTail").filter(|tail| tail.is_object()).map(|tail| StreamingTail {
            kind: item_kind(tail).to_owned(),
            streaming: tail.get("streaming") == Some(&Value::Bool(true)),
            text: text(tail, "text"),
        }),
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
        let items: &[Value] = view_items.or_else(|| state.get("items")).and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let tail = if view_items.is_some() { None } else { state.get("streamingTail").filter(|tail| tail.is_object()) };
        let list = Items::new(items, tail);
        if self.take_follow_request() {
            self.scroll.arm_transcript_follow();
        }
        let (selected, confirm_focus) = self.picker_selection().unwrap_or((0, -1));
        let palette = self.palette();
        let palette_selected = self.palette_selection(&palette);
        let picker = self.surface.picker().cloned();
        let btw_panel = self.btw.panel().cloned();
        self.sync_text_entry();
        let (provider_draft, provider_copy) = self.text_entry_view(PromptSurface::Provider);
        let (settings_draft, settings_copy) = self.text_entry_view(PromptSurface::Settings);
        let settings_rows = self.settings_prompt.as_ref().map_or(0, |prompt| settings_entry_layout_rows(&prompt_value(prompt), &settings_draft, frame_columns));
        let input = ShellLayoutInput {
            provider_prompt: self.provider_prompt.as_ref().map(entry_prompt),
            settings_prompt: self.settings_prompt.as_ref().map(entry_prompt),
            tool_approval: state.get("toolApproval").filter(|approval| approval.is_object()).cloned(),
            picker: picker.as_ref().map(|picker| PickerLayout { kind: picker.layout_kind(), fill_available: false }),
            context_panel: self.surface.context().is_some(),
            usage_panel: self.surface.usage().is_some(),
            btw_panel: btw_panel.as_ref().map(|panel| BtwPanel { done: text(panel, "status") == "done", text: text(panel, "text") }),
            slash_palette_open: palette.slash_palette_open,
            tui_ready: self.chrome.is_ready(),
            state: shell_state(&state, items),
            rows: rows_used,
            frame_columns,
            prompt_hint: self.prompt.hint.text().to_owned(),
            prompt_hint_tone: format!("{:?}", self.prompt.hint.tone()).to_lowercase(),
            text_entry_layout_rows: settings_rows,
            onboarding_active: self.onboarding_active,
            conditional_welcome_prompt_hint: self.welcome.conditional().to_owned(),
            welcome_prompt_hint_dismissed: self.welcome.dismissed(),
            welcome_prompt_hint: self.welcome.tip().to_owned(),
            panel_transition_epoch: self.surface.epoch().current(),
            prompt_layout_value: self.prompt_layout_value.clone(),
            prompt_content_columns: frame_columns.saturating_sub(4).max(1),
        };
        self.shell_refs.frame_rows = rows_used;
        let layout = compute_shell_layout(&input, &mut self.shell_refs);
        self.picker_visible_rows = layout.picker_visible_rows;

        let params = HeightParams { columns: frame_columns, tool_output_expanded: self.tool_output_expanded };
        let revision = state.get("structureRevision").and_then(Value::as_u64).unwrap_or(0);
        let ids: Vec<Value> =
            (0..list.len()).map(|at| list.get(at).and_then(|item| item.get("id")).filter(|id| !id.is_null()).cloned().unwrap_or(Value::Null)).collect();
        let session = text(&state, "sessionId");
        if session != self.window_session {
            // A resumed or new session replaces the transcript: the window returns to its tail.
            self.window_session = session;
            self.prev_total_rows = 0;
            self.scroll.reset_transcript_scroll();
            self.scroll.geom = Geometry::default();
        }
        self.scroll.swap_reset(&ids);
        let index = self.row_index.build(&list, &mut self.heights, &params, revision);
        let view_rows = layout.transcript_content_height.max(1);
        let render_offset = self.scroll.resolve_render_scroll_offset(
            &ids,
            LockRows { total_rows: index.total_rows, prefix_rows: Some(&index.prefix_rows) },
            view_rows,
            layout.floating_panel_rows,
        );
        let window = transcript_render_window(index, render_offset, layout.transcript_content_height as f64, &WindowTuning::current());
        // The commit of the frame: the geometry a manual scroll reads, then the anchor lock and the follow rule against it.
        let previous_total_rows = std::mem::replace(&mut self.prev_total_rows, window.total_rows);
        self.scroll.geom = Geometry {
            prefix_rows: Some(index.prefix_rows.clone()),
            ids: ids.clone(),
            total_rows: window.total_rows,
            view_rows,
            render_offset: window.effective_scroll_offset as f64,
        };
        self.scroll.max_scroll_rows = window.max_scroll_rows;
        self.scroll.bottom_slack_rows = layout.transcript_bottom_slack_rows;
        let offset_before = (self.scroll.scroll_offset, self.scroll.target.to_bits());
        let drag_active = self.mouse.as_ref().is_some_and(|mouse| mouse.drag.active);
        self.scroll.sync_reading_anchor_after_commit(&CommitFrame {
            drag_active,
            total_rows: window.total_rows,
            previous_total_rows,
            prefix_rows: Some(&index.prefix_rows),
            ids: &ids,
            view_rows,
            max_rows: window.max_scroll_rows,
        });
        self.scroll.reset_scroll_when_unanchored();
        self.scroll.clamp_scroll_to_overflow(window.max_scroll_rows);
        if (self.scroll.scroll_offset, self.scroll.target.to_bits()) != offset_before {
            self.frame_requested = true;
        }
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
        let approval_pending = state.get("toolApproval").is_some_and(Value::is_object);
        let spinner_lines = self.spinner_rows(&state, layout.prompt_meta_visible, layout.prompt_spinner_columns, approval_pending);
        let provider_value = self.provider_prompt.as_ref().map(prompt_value);
        let settings_value = self.settings_prompt.as_ref().map(prompt_value);
        let panels = PanelSlots {
            picker: picker_props.as_ref().map(|props| PickerSlot { props, selected, confirm_focus, status: CopyStatus::Idle }),
            provider_prompt: provider_value.as_ref().map(|prompt| TextEntrySlot { prompt, draft: &provider_draft, status: provider_copy }),
            settings_prompt: settings_value.as_ref().map(|prompt| TextEntrySlot { prompt, draft: &settings_draft, status: settings_copy }),
            ..PanelSlots::default()
        };
        let palette_commands: Vec<WidgetCommand> = palette.slash_commands.iter().map(widget_command).collect();
        let palette_query = palette.active_slash_query.clone().unwrap_or_default();
        let approval_request = state.get("toolApproval").filter(|approval| approval.is_object());
        let panels = PanelSlots {
            tool_approval: approval_request.map(|request| ToolApprovalSlot {
                request,
                selected: self.approval_selected,
                question: self.question_state.as_ref(),
            }),
            slash_palette: palette.slash_palette_open.then_some(PaletteSlot {
                commands: &palette_commands,
                selected: palette_selected,
                query: &palette_query,
                skills: palette.palette_kind == PaletteKind::Skills,
            }),
            ..panels
        };
        let queued: &[Value] = state.get("queued").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let spinner: &[Line] = &spinner_lines;
        let footer_line = self.statusline_line().to_owned();
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
            footer: &footer_line,
            workflow: state.get("workflow").filter(|workflow| workflow.is_object()),
        };
        let mut grid = Grid::new(columns, rows);
        let frame = render_app(&props, &mut Painter::new(&mut grid));
        self.publish_frame(&mut grid, &frame, rows_used, frame_columns);
        (grid, frame.cursor)
    }

    /// What a painted frame tells the mouse, the prompt editor and the selection highlight.
    fn publish_frame(&mut self, grid: &mut Grid, frame: &AppFrame, rows_used: usize, frame_columns: usize) {
        if let Some(mouse) = self.mouse.as_mut() {
            if let Some(viewport) = self.shell_refs.transcript_viewport {
                mouse.set_transcript_viewport(viewport.top as f64, viewport.bottom as f64);
            }
            mouse.set_frame(rows_used as f64, frame_columns);
            mouse.set_selection_background(super::input::theme_selection_background());
        }
        if let (Some(layout), Some(editor)) = (frame.prompt_box, self.editor.as_mut()) {
            let enabled = !(self.prompt.exit.requested() || !self.chrome.is_ready());
            let _ = editor.cursor_anchor(&layout, enabled);
            self.prompt.box_rect = editor.box_rect();
            if let Some(mouse) = self.mouse.as_mut() {
                mouse.set_prompt_box_rect(self.prompt.box_rect.map(|rect| crate::mouse::PromptBoxRect {
                    top: rect.top,
                    left: rect.left,
                    height: i32::try_from(rect.height).unwrap_or(1),
                    content_width: i32::try_from(rect.content_width).unwrap_or(1),
                }));
            }
        }
        // The grid as the layout drew it serves the word and line bounds of a click; the highlight goes on a copy the writer takes.
        self.rendered_grid = Some(grid.clone());
        let soft_wrap = std::mem::take(&mut grid.soft_wrap);
        self.render_selection.apply(grid, &soft_wrap);
        grid.soft_wrap = soft_wrap;
        // Writes the surface made since the last frame are what this frame shows.
        let _ = self.surface.take_events();
    }
}

/// A palette row as the palette widget takes it.
fn widget_command(item: &PaletteItem) -> WidgetCommand {
    match item {
        PaletteItem::Command(command) => WidgetCommand {
            name: command.name.to_owned(),
            label: String::new(),
            usage: command.usage.to_owned(),
            aliases: command.aliases.iter().map(|alias| (*alias).to_owned()).collect(),
            alias_usage: command.alias_usage.iter().map(|usage| (*usage).to_owned()).collect(),
            show_alias_usage: command.show_alias_usage != Some(false),
            description: command.description.to_owned(),
        },
        PaletteItem::Skill { name, label, description } => WidgetCommand {
            name: name.clone(),
            label: label.clone(),
            usage: name.clone(),
            description: description.clone(),
            show_alias_usage: true,
            ..WidgetCommand::default()
        },
    }
}
