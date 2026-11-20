//! The input of the running application: where a decoded key, mouse report or paste goes (`App.jsx`'s `useInput` handlers in
//! their order: the global key handler, the picker on screen, the tool approval, the prompt), and the application's side of the
//! prompt handlers ([`PromptHost`], [`GlobalKeyHost`], [`PasteIo`]) and of the mouse ([`MouseHost`]).
//!
//! The editor and the mouse state are taken out of [`AppState`] for the length of a call into them, because their callbacks
//! reach back into the application; the draft the editor holds is copied back at the end of every key, so the frame paints it.

use std::collections::BTreeMap;

use mixdog_term::os::{Platform, SystemRunner};
use mixdog_term::paste::{
    ImageAttachment, PastedImage, ResizeRequest, ResizedImage, read_clipboard_image_attachment, read_clipboard_text, read_image_attachment_from_path,
};
use mixdog_term::selection::{CellSpan, SelectedRow, SelectionRect as TermRect, line_rect_at, word_rect_at};
use mixdog_term::{KeyFlags, MouseReport};
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::question::{QuestionAction, QuestionState, questions_of};
use serde_json::{Value, json};

use super::AppState;
use super::store::AppStore;
use crate::editor::draft::Draft;
use crate::editor::helpers::HintTone as EditorHint;
use crate::editor::prompt::{EscapePhase, HistoryDirection, PaletteNav, PaletteReply, PasteReply, PasteSource, PromptCallbacks, PromptProps, RestoreRequest};
use crate::handlers::draft_flow::{accept_slash_palette, apply_prompt_draft_change, cancel_slash_palette, complete_slash_palette};
use crate::handlers::escape::handle_prompt_escape;
use crate::handlers::global_keys::{ApprovalDecision, GlobalKeyOutcome, SelectionMove, ToolApproval, handle_global_key};
use crate::handlers::history_nav::handle_prompt_history_navigate;
use crate::handlers::host::{GlobalKeyHost, PromptHost, Reply};
use crate::handlers::interrupt::{InterruptOutcome, handle_prompt_interrupt, on_busy_changed};
use crate::handlers::paste::{PasteIo, handle_prompt_paste};
use crate::handlers::queue_restore::{RestoreOptions, RestoredQueue, restore_queued_to_prompt};
use crate::handlers::state::PromptState;
use crate::mouse::host::{PromptSelection, RenderStore, SelectionIo};
use crate::mouse::{FocusMove, HintTone as MouseHint, Mouse, MouseHost, SlashPalette as MousePalette};
use crate::slash::commands::OverlayOwner;
use crate::slash::host::TextPrompt;
use crate::slash::palette::{
    PaletteInputs, PaletteItem, PaletteKind, SlashPalette, clamp_slash_index, derive_slash_palette, fetch_mention_skills, mention_active,
};
use crate::slash::workflow_cycle::{TabCycleOverlays, workflow_tab_cycle};
use crate::surface::latch::EnterLatch;
use crate::transcript::scroll::engine::ScrollHost;
use crate::transcript::window::selection_shift::SelectionRect;
use crate::view::{PaletteMove, step_palette_index};

/// What the editor reports to the application while a key is handled.
pub(crate) struct Bridge<'a>(pub(crate) &'a mut AppState);

impl PromptCallbacks for Bridge<'_> {
    fn on_submit(&mut self, text: &str) -> bool {
        crate::slash::on_submit(self.0, text)
    }

    fn on_draft_change(&mut self, value: &str) {
        self.0.prompt.value = value.to_owned();
        apply_prompt_draft_change(self.0, value);
    }

    fn on_caret_change(&mut self, cursor: usize) {
        self.0.prompt.caret = i64::try_from(cursor).ok();
    }

    fn on_interrupt(&mut self, value: &str) -> Option<String> {
        handle_prompt_interrupt(self.0, value)
    }

    fn on_escape(&mut self, value: &str, phase: EscapePhase) -> bool {
        handle_prompt_escape(self.0, value, phase)
    }

    fn on_tab(&mut self, _value: &str) -> bool {
        self.0.cycle_workflow_from_tab()
    }

    fn on_command_palette_navigate(&mut self, nav: PaletteNav) {
        let count = self.0.palette().slash_commands.len();
        let direction = match nav {
            PaletteNav::Step(rows) => PaletteMove::Rows(f64::from(rows)),
            PaletteNav::Home => PaletteMove::Home,
            PaletteNav::End => PaletteMove::End,
            PaletteNav::Left => PaletteMove::Left,
            PaletteNav::Right => PaletteMove::Right,
        };
        self.0.slash_index = step_palette_index(self.0.slash_index, direction, count);
    }

    fn on_command_palette_accept(&mut self, value: &str, cursor: usize) -> PaletteReply {
        accept_slash_palette(self.0, value, i64::try_from(cursor).ok())
    }

    fn on_command_palette_cancel(&mut self, value: &str) {
        cancel_slash_palette(self.0, value);
    }

    fn on_command_palette_complete(&mut self, value: &str, cursor: usize) -> PaletteReply {
        complete_slash_palette(self.0, value, i64::try_from(cursor).ok())
    }

    fn on_restore_queued(&mut self, request: &RestoreRequest) -> bool {
        self.0.live_draft = Some(request.draft.clone());
        let options = RestoreOptions { restore_draft: true, show_hint: request.show_hint, current_text: Some(request.current_text.clone()), live_draft: true };
        restore_queued_to_prompt(self.0, &options)
    }

    fn on_history_navigate(&mut self, direction: HistoryDirection, value: &str, empty_draft: bool) -> Option<String> {
        handle_prompt_history_navigate(self.0, direction, value, empty_draft)
    }

    fn on_paste_text(&mut self, text: &str, source: PasteSource) -> PasteReply {
        // A paste that reads the clipboard or an image file is read on a worker: the editor takes the answer with its ticket.
        if self.0.start_paste_job(text, source) {
            return PasteReply::Pending;
        }
        handle_prompt_paste(self.0, text, source).into_reply()
    }

    fn grid_selection_active(&mut self) -> bool {
        self.0.mouse.as_ref().is_some_and(Mouse::grid_selection_active)
    }
}

/// The callbacks of a mouse gesture on the prompt box: the selection moves, the text does not, so nothing is reported.
struct Silent;

impl PromptCallbacks for Silent {}

impl PromptSelection for crate::editor::PromptEditor {
    fn offset_at_cell(&mut self, row: usize, col: usize) -> usize {
        self.mouse_offset_at_cell(row, col)
    }

    fn has_selection(&mut self) -> bool {
        self.mouse_has_selection()
    }

    fn clear(&mut self) {
        self.mouse_clear(&mut Silent);
    }

    fn anchor_at(&mut self, offset: usize) {
        self.mouse_anchor_at(offset, &mut Silent);
    }

    fn extend_to(&mut self, offset: Option<usize>, immediate: bool) {
        self.mouse_extend_to(offset, immediate, &mut Silent);
    }

    fn select_word_at(&mut self, offset: usize) {
        self.mouse_select_word_at(offset, &mut Silent);
    }

    fn select_line_at(&mut self, offset: usize) {
        self.mouse_select_line_at(offset, &mut Silent);
    }
}

fn editor_tone(tone: MouseHint) -> EditorHint {
    match tone {
        MouseHint::Plain => EditorHint::Plain,
        MouseHint::Error => EditorHint::Error,
    }
}

/// The highlight colour of the theme: `selectionHighlightBackground`, else `selectionBackground`.
pub(crate) fn theme_selection_background() -> mixdog_term::frame::Rgb {
    for key in [Key::SelectionHighlightBackground, Key::SelectionBackground] {
        if let mixdog_tui_style::Color::Rgb(..) = theme_color(key) {
            return mixdog_term::selection::selection_background(&theme_color(key).css());
        }
    }
    mixdog_term::selection::selection_background("")
}

impl AppState {
    /// A new editor over an empty draft (`PromptInput`'s mount).
    pub(crate) fn new_editor() -> crate::editor::PromptEditor {
        crate::editor::PromptEditor::new("")
    }

    // ---- the palette -----------------------------------------------------------------------------------------------

    /// The tool approval the store holds, if any.
    pub(crate) fn tool_approval_value(&self) -> Option<Value> {
        self.store.state().get("toolApproval").filter(|approval| approval.is_object()).cloned()
    }

    /// The slash or `$name` palette of this moment (`useSlashPalette`).
    pub fn palette(&self) -> SlashPalette {
        let state = self.store.state();
        derive_slash_palette(&PaletteInputs {
            provider_prompt: self.provider_prompt.is_some(),
            settings_prompt: self.settings_prompt.is_some(),
            tool_approval: state.get("toolApproval").is_some_and(|approval| approval.is_object()),
            context_panel: self.surface.context().is_some(),
            usage_panel: self.surface.usage().is_some(),
            picker: self.surface.picker().is_some(),
            exiting: self.prompt.exit.requested(),
            command_busy: state.get("commandBusy") == Some(&Value::Bool(true)),
            prompt_draft: &self.prompt.draft,
            slash_dismissed_for: &self.prompt.slash_dismissed_for,
            skills: &self.mention_skills,
            prompt_caret: self.prompt.caret,
        })
    }

    /// The selected row of the palette, kept inside its list.
    pub(crate) fn palette_selection(&self, palette: &SlashPalette) -> usize {
        clamp_slash_index(self.slash_index, palette.slash_commands.len())
    }

    /// `useSkillMentionSkills`: the skill list is fetched each time a `$name` mention starts.
    fn refresh_mention_skills(&mut self) {
        let active = mention_active(&self.prompt.draft, self.prompt.caret);
        if active && !self.mention_was_active {
            if let Some(skills) = fetch_mention_skills(self, true) {
                self.mention_skills = skills;
            }
        }
        self.mention_was_active = active;
    }

    /// The tab key of the prompt: the workflow cycle, unless another surface owns the keys.
    fn cycle_workflow_from_tab(&mut self) -> bool {
        let overlays = TabCycleOverlays {
            slash_palette_open: self.palette().slash_palette_open,
            tool_approval: self.tool_approval_value().is_some(),
            picker: self.surface.picker().is_some(),
            settings_prompt: self.settings_prompt.is_some(),
            provider_prompt: self.provider_prompt.is_some(),
            context_panel: self.surface.context().is_some(),
            usage_panel: self.surface.usage().is_some(),
        };
        let mut guard = self.tab_guard;
        let consumed = workflow_tab_cycle(self, &mut guard, overlays);
        self.tab_guard = guard;
        consumed
    }

    // ---- the prompt ------------------------------------------------------------------------------------------------

    /// The props the key dispatch reads at event time.
    fn prompt_props(&self) -> PromptProps {
        let state = self.store.state();
        let palette = self.palette();
        let count = palette.slash_commands.len();
        PromptProps {
            disabled: self.prompt.exit.requested()
                || !self.chrome.is_ready()
                || self.surface.picker().is_some()
                || self.surface.context().is_some()
                || state.get("toolApproval").is_some_and(|approval| approval.is_object()),
            interrupt_active: state.get("busy") == Some(&Value::Bool(true)),
            command_palette_active: palette.slash_palette_open && count > 0,
            command_palette_open: Some(palette.slash_palette_open),
            command_palette_option_count: Some(count as i64),
            command_palette_moves_caret: palette.palette_kind == PaletteKind::Skills,
            has_queued_messages: state.get("queued").and_then(Value::as_array).is_some_and(|queued| !queued.is_empty()),
            has_messages: crate::pickers::extensions::message_selector::has_user_messages(
                state.get("items").and_then(Value::as_array).map_or(&[], Vec::as_slice),
            ),
            raw_mode_supported: true,
            ..PromptProps::default()
        }
    }

    /// Whether a surface other than the prompt owns the keys and is not connected to them yet (a text-entry prompt).
    pub fn text_entry_open(&self) -> bool {
        self.provider_prompt.is_some() || self.settings_prompt.is_some()
    }

    /// One key at the prompt box; false when the editor is not available (it is in use further up the stack).
    pub fn prompt_key(&mut self, input: &str, key: &KeyFlags) -> bool {
        let Some(mut editor) = self.editor.take() else { return false };
        let props = self.prompt_props();
        editor.handle_key(input, key, &props, &mut Bridge(self));
        editor.end_input_batch();
        self.after_editor(&mut editor);
        self.editor = Some(editor);
        self.after_prompt_input();
        true
    }

    /// A bracketed paste.
    pub fn prompt_paste(&mut self, text: &str) {
        if self.text_entry_open() && self.text_entry_paste(text) {
            return;
        }
        let Some(mut editor) = self.editor.take() else { return };
        let props = self.prompt_props();
        editor.handle_paste(text, &props, &mut Bridge(self));
        editor.end_input_batch();
        self.after_editor(&mut editor);
        self.editor = Some(editor);
        self.after_prompt_input();
    }

    /// What follows an operation on the editor: the draft it holds is the one the frame paints, the selection and the box it
    /// reports are the ones the mouse and the copy read.
    pub(crate) fn after_editor(&mut self, editor: &mut crate::editor::PromptEditor) {
        self.draft = editor.draft().clone();
        self.prompt.selection = editor.selection(false);
        self.prompt.box_rect = editor.box_rect();
        self.live_draft = None;
        // The answers of pastes that read on a worker finish on a later turn with the tickets the editor handed out.
        let tickets = editor.take_pending_pastes();
        if !tickets.is_empty() {
            self.bind_paste_tickets(tickets);
        }
        let _ = editor.take_render_request();
    }

    /// The prompt changed: the palette follows its draft, and a draft published by a handler reaches the editor.
    pub(crate) fn after_prompt_input(&mut self) {
        self.refresh_mention_skills();
        let palette = self.palette();
        self.slash_index = self.palette_selection(&palette);
        self.apply_published_override();
    }

    /// A draft a handler published (a restored queue, an interrupt's restored prompt, a rewound message) goes into the editor
    /// once per publication.
    pub(crate) fn apply_published_override(&mut self) {
        let Some(published) = self.prompt.draft_override.clone() else { return };
        if self.override_applied.as_ref() == Some(&published) {
            return;
        }
        self.override_applied = Some(published.clone());
        let Some(mut editor) = self.editor.take() else { return };
        editor.apply_draft_override(&published.draft, &mut Bridge(self));
        self.after_editor(&mut editor);
        self.editor = Some(editor);
    }

    // ---- the keys --------------------------------------------------------------------------------------------------

    /// One decoded key: the global handler, then the picker on screen, the tool approval and the prompt.
    pub fn on_key(&mut self, input: &str, key: &KeyFlags) {
        if handle_global_key(self, input, key) == GlobalKeyOutcome::Consumed {
            return;
        }
        if self.picker_input(input, key) {
            return;
        }
        if self.approval_input(input, key) {
            return;
        }
        if self.text_entry_open() {
            self.text_entry_key(input, key);
            return;
        }
        self.prompt_key(input, key);
    }

    /// The keys of the tool approval panel on screen: the picker's arrows and Enter, or the question panel's own keys.
    fn approval_input(&mut self, input: &str, key: &KeyFlags) -> bool {
        let Some(approval) = self.tool_approval_value() else { return false };
        let id = approval.get("id").map(mixdog_js::value_to_string).unwrap_or_default();
        if approval.get("kind").and_then(Value::as_str) == Some("question") {
            let questions = questions_of(&approval);
            if self.question_for.as_deref() != Some(id.as_str()) {
                self.question_for = Some(id.clone());
                self.question_state = Some(QuestionState::new(&questions));
            }
            let Some(state) = self.question_state.as_mut() else { return true };
            match state.handle_key(&questions, input, key) {
                QuestionAction::None => {}
                QuestionAction::Submit(answers) => {
                    let values: Vec<Value> = answers.iter().map(|answer| answer.as_ref().map_or(Value::Null, |answer| answer.to_value())).collect();
                    self.finish_approval(&id, true, "answered by user", Some(Value::Array(values)));
                }
                QuestionAction::Dismiss => self.finish_approval(&id, false, "dismissed by user", None),
            }
            return true;
        }
        if self.approval_for.as_deref() != Some(id.as_str()) {
            self.approval_for = Some(id.clone());
            self.approval_selected = 0;
        }
        if key.up_arrow || key.down_arrow {
            self.approval_selected = 1 - self.approval_selected.min(1);
        } else if key.return_key {
            let approved = self.approval_selected == 1;
            self.finish_approval(&id, approved, if approved { "approved by user" } else { "denied by user" }, None);
        }
        true
    }

    fn finish_approval(&mut self, id: &str, approved: bool, reason: &str, answers: Option<Value>) {
        let mut decision = json!({ "approved": approved, "reason": reason });
        if let Some(answers) = answers {
            decision["answers"] = answers;
        }
        if let Err(error) = self.store.resolve_tool_approval(id, &decision) {
            self.notice(&format!("approval failed: {error}"), crate::slash::host::Tone::Error);
        }
        self.question_for = None;
        self.question_state = None;
        self.approval_for = None;
    }

    /// One mouse report.
    pub fn on_mouse(&mut self, report: &MouseReport) {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return };
        mouse.handle_report(report, self, now);
        self.mouse = Some(mouse);
        self.sync_editor_after_mouse();
    }

    /// The timers of the mouse (the throttled selection paint, the edge autoscroll, the copy retry) and of the wheel coalescer.
    pub(crate) fn on_mouse_timers(&mut self) {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return };
        if let Some(rows) = self.scroll_coalescer.tick(now) {
            self.scroll_rows_with(&mut mouse, rows);
        }
        mouse.tick(self, now);
        self.mouse = Some(mouse);
        self.sync_editor_after_mouse();
        if let Some(mut editor) = self.editor.take() {
            editor.flush_mouse_due(&mut Silent);
            self.after_editor(&mut editor);
            self.editor = Some(editor);
        }
    }

    /// When the mouse or the wheel coalescer needs the loop to wake.
    pub(crate) fn mouse_deadline(&self) -> Option<u64> {
        let editor = self.editor.as_ref().and_then(crate::editor::PromptEditor::mouse_deadline);
        [self.mouse.as_ref().and_then(Mouse::next_deadline), self.scroll_coalescer.deadline(), editor].into_iter().flatten().min()
    }

    fn sync_editor_after_mouse(&mut self) {
        if let Some(mut editor) = self.editor.take() {
            self.after_editor(&mut editor);
            self.editor = Some(editor);
        }
    }

    /// A transcript scroll of `rows` (positive toward older rows) with the selection following the content. Scrolling past the
    /// oldest or newest loaded row pages the history through the store inside the scroll, as `use-transcript-scroll.mjs` does,
    /// because the scroll goes on by whether a page was restored.
    fn scroll_rows_with(&mut self, mouse: &mut Mouse, rows: f64) {
        let mut scroll = std::mem::take(&mut self.scroll);
        let now = self.clock.now();
        let state = self.store.state();
        let flag = |name: &str| state.get(name) == Some(&Value::Bool(true));
        let (before, after) = (flag("transcriptHistoryBefore"), flag("transcriptHistoryAfter"));
        let error = {
            let AppState { store, rendered_grid, render_selection, frame_requested, repaint_requested, .. } = &mut *self;
            let mut render = Render { grid: rendered_grid, selection: render_selection, frame: frame_requested, repaint: repaint_requested };
            let mut paging = Paging { before, after, store: &mut **store, error: None };
            {
                let mut host = crate::mouse::scroll::SelectionScroll { mouse, store: &mut render, inner: &mut paging, now_ms: now };
                scroll.scroll_rows(&mut host, rows, false);
            }
            paging.error
        };
        self.scroll = scroll;
        self.frame_requested = true;
        if let Some(error) = error {
            self.notice(&format!("transcript page failed: {error}"), crate::slash::host::Tone::Error);
        }
    }

    /// After a frame was painted: what the mouse reads of the frame just painted.
    pub(crate) fn after_frame(&mut self) {
        let Some(mut mouse) = self.mouse.take() else { return };
        mouse.after_frame(self);
        self.mouse = Some(mouse);
    }

    /// A handler or a timer changed what the frame shows since the last call.
    pub fn take_frame_request(&mut self) -> bool {
        std::mem::take(&mut self.frame_requested)
    }

    /// The store's `busy` flag flipped: a parked interrupt restore settles.
    pub(crate) fn on_busy_flip(&mut self) {
        on_busy_changed(self);
        self.apply_published_override();
    }
}

/// The paging of transcript history is the store's: the scroll learns whether a page exists and asks for it, and goes on by the
/// answer (`store.restoreOlderTranscript()` answers whether a page was restored).
struct Paging<'a> {
    before: bool,
    after: bool,
    store: &'a mut dyn AppStore,
    error: Option<String>,
}

impl Paging<'_> {
    fn restore(&mut self, action: &str) -> bool {
        match self.store.call(action, &[]) {
            Ok(answer) => answer == Value::Bool(true),
            Err(error) => {
                self.error = Some(error);
                false
            }
        }
    }
}

impl ScrollHost for Paging<'_> {
    fn history_before(&self) -> bool {
        self.before
    }

    fn history_after(&self) -> bool {
        self.after
    }

    fn restore_older(&mut self) -> bool {
        self.restore("restoreOlderTranscript")
    }

    fn restore_newer(&mut self) -> bool {
        self.restore("restoreNewerTranscript")
    }
}

/// The rendered frame and the render selection as the mouse reads them, borrowed apart from the store so a scroll that pages
/// the history can hold both.
struct Render<'a> {
    grid: &'a Option<mixdog_term::frame::Grid>,
    selection: &'a mut mixdog_term::selection::SelectionState,
    frame: &'a mut bool,
    repaint: &'a mut bool,
}

impl RenderStore for Render<'_> {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan> {
        self.grid.as_ref().and_then(|grid| word_rect_at(grid, x, y))
    }

    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan> {
        self.grid.as_ref().and_then(|grid| line_rect_at(grid, y))
    }

    fn set_render_selection(&mut self, rect: Option<&TermRect>) {
        if self.selection.set_selection(rect.copied()) {
            *self.frame = true;
        }
    }

    fn render_selection_text(&mut self) -> Option<String> {
        self.selection.selection_text().map(str::to_owned)
    }

    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>> {
        self.selection.selection_rows().map(<[SelectedRow]>::to_vec)
    }

    fn force_render_repaint(&mut self) {
        *self.repaint = true;
    }
}

// ---- the prompt handlers' host ----------------------------------------------------------------------------------------

fn text_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

fn pasted_images_of(value: Option<&Value>) -> Option<BTreeMap<u64, PastedImage>> {
    let map = value?.as_object()?;
    Some(
        map.iter()
            .filter_map(|(id, image)| {
                let id: u64 = id.parse().ok()?;
                Some((
                    id,
                    PastedImage {
                        id,
                        content: text_of(image, "content"),
                        media_type: image.get("mediaType").and_then(Value::as_str).map(str::to_owned),
                        metadata_text: image.get("metadataText").and_then(Value::as_str).map(str::to_owned),
                    },
                ))
            })
            .collect(),
    )
}

fn pasted_texts_of(value: Option<&Value>) -> Option<BTreeMap<u64, String>> {
    let map = value?.as_object()?;
    Some(map.iter().filter_map(|(id, text)| Some((id.parse().ok()?, text.as_str()?.to_owned()))).collect())
}

impl PromptHost for AppState {
    fn prompt(&mut self) -> &mut PromptState {
        &mut self.prompt
    }

    fn sync_prompt_layout_rows(&mut self, text: &str) {
        self.prompt_layout_value = text.to_owned();
    }

    fn dismiss_welcome_prompt_hint(&mut self) {
        self.dismiss_welcome_hint();
    }

    fn usage_panel_open(&self) -> bool {
        self.surface.usage().is_some()
    }

    fn context_panel_open(&self) -> bool {
        self.surface.context().is_some()
    }

    fn btw_panel_open(&self) -> bool {
        self.btw.panel().is_some()
    }

    fn close_btw_panel(&mut self) {
        let mut btw = std::mem::take(&mut self.btw);
        btw.close(self);
        self.btw = btw;
    }

    fn open_message_selector(&mut self) -> bool {
        self.with_extensions(|_, host| crate::pickers::extensions::message_selector::open_message_selector(host)).unwrap_or(false)
    }

    fn store_busy(&self) -> bool {
        self.store.state().get("busy") == Some(&Value::Bool(true))
    }

    fn remember_prompt_history(&mut self, text: &str) -> Result<(), String> {
        if !self.store.has_method("rememberPromptHistory") {
            return Ok(());
        }
        self.call_store("rememberPromptHistory", json!([text])).map(|_| ())
    }

    fn abort(&mut self, _generation: u64) -> Reply<Option<InterruptOutcome>> {
        let answer = self.store.abort(&json!({ "restorePrompt": false }));
        Reply::Ready(answer.map(|answer| interrupt_outcome(&answer)))
    }

    fn restore_queued(&mut self) -> Reply<Option<RestoredQueue>> {
        let answer = self.store.restore_queued("");
        Reply::Ready(answer.map(|answer| restored_queue(&answer)))
    }

    fn queued(&self) -> Vec<Value> {
        self.store.state().get("queued").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn current_draft(&self) -> Option<Draft> {
        self.live_draft.clone().or_else(|| self.editor.as_ref().map(|editor| editor.draft().clone()))
    }

    fn recent_prompt_history(&self) -> Vec<String> {
        let state = self.store.state();
        let published: Option<Vec<String>> =
            state.get("promptHistory").and_then(Value::as_array).map(|list| list.iter().filter_map(|entry| entry.as_str().map(str::to_owned)).collect());
        crate::history::recent_prompt_history(published.as_deref(), state.get("items").and_then(Value::as_array).map_or(&[], Vec::as_slice))
    }

    fn selected_palette_item(&self) -> Option<PaletteItem> {
        let palette = self.palette();
        palette.slash_commands.get(self.palette_selection(&palette)).cloned()
    }

    fn enter_latch(&mut self) -> &mut EnterLatch {
        &mut self.enter_latch
    }

    /// `providerPrompt.login.cancel()`: an MCP sign-in is cancelled and said so; a provider sign-in's flow is cancelled in the core.
    fn cancel_provider_login(&mut self, target: &TextPrompt) {
        if crate::pickers::extensions::mcp_login::is_login_prompt(target) {
            self.with_extensions(|extensions, host| extensions.login.cancel(host));
            return;
        }
        let flow = target.text("_login");
        if !flow.is_empty() {
            let _ = self.call_store("cancelOAuthProviderLogin", json!([flow]));
        }
    }

    /// `providerPrompt.cancelReturn()`: the OAuth code prompt goes back to the provider's sign-in actions (not to the `returnTo`
    /// of the open, which is `afterSave`'s).
    fn provider_cancel_return(&mut self, target: &TextPrompt) -> bool {
        if target.fields.get("_cancelReturn").is_some_and(crate::slash::notices::truthy) {
            crate::pickers::provider::oauth_cancel_return(self);
            return true;
        }
        false
    }
}

/// `{ aborted, restoreText, pastedImages, pastedTexts, discardPastedImages, discardPastedTexts }` of `store.abort`.
fn interrupt_outcome(answer: &Value) -> Option<InterruptOutcome> {
    if answer.is_null() {
        return None;
    }
    Some(InterruptOutcome {
        result: crate::editor::interrupt::InterruptResult {
            aborted: answer.get("aborted").and_then(Value::as_bool),
            restore_text: text_of(answer, "restoreText"),
        },
        pasted_images: pasted_images_of(answer.get("pastedImages")),
        pasted_texts: pasted_texts_of(answer.get("pastedTexts")),
        discard_pasted_images: pasted_images_of(answer.get("discardPastedImages")),
        discard_pasted_texts: pasted_texts_of(answer.get("discardPastedTexts")),
    })
}

/// `{ count, text, pastedImages, pastedTexts, notice }` of `store.restoreQueued`.
fn restored_queue(answer: &Value) -> Option<RestoredQueue> {
    if answer.is_null() {
        return None;
    }
    Some(RestoredQueue {
        count: answer.get("count").and_then(Value::as_u64).map_or(0, |count| count as usize),
        text: text_of(answer, "text"),
        pasted_images: pasted_images_of(answer.get("pastedImages")),
        pasted_texts: pasted_texts_of(answer.get("pastedTexts")),
        notice: answer.get("notice").and_then(Value::as_str).filter(|notice| !notice.is_empty()).map(str::to_owned),
    })
}

impl PasteIo for AppState {
    fn platform(&self) -> Platform {
        Platform::current()
    }

    fn paste_cwd(&self) -> String {
        self.session_cwd()
    }

    fn read_image_from_path(&mut self, raw_path: &str) -> Result<Option<ImageAttachment>, String> {
        if let Some(read) = self.paste.reads.take_path(raw_path) {
            return read;
        }
        let cwd = self.session_cwd();
        let provider = text_of(&self.store.state(), "provider");
        let platform = Platform::current();
        let cwd_path = std::path::PathBuf::from(&cwd);
        let resize = self.image_resizer();
        read_image_attachment_from_path(raw_path, Some(&cwd_path), &provider, platform, &resize)
    }

    fn read_clipboard_text(&mut self) -> Result<String, String> {
        if let Some(read) = self.paste.reads.take_text() {
            return read;
        }
        read_clipboard_text(Platform::current(), &SystemRunner)
    }

    fn read_clipboard_image(&mut self) -> Result<Option<ImageAttachment>, String> {
        if let Some(read) = self.paste.reads.take_image() {
            return read;
        }
        let provider = text_of(&self.store.state(), "provider");
        let resize = self.image_resizer();
        read_clipboard_image_attachment(Platform::current(), &SystemRunner, &provider, &resize)
    }
}

impl AppState {
    /// The resize of a pasted image is the core's (`thread/resizeImage`).
    fn image_resizer(&mut self) -> impl Fn(&ResizeRequest<'_>) -> Result<ResizedImage, String> + '_ {
        let cell = std::cell::RefCell::new(self);
        move |request: &ResizeRequest<'_>| {
            let data = mixdog_term::paste::base64_encode(request.bytes);
            let input = json!({ "data": data, "mimeType": request.mime_type, "filename": request.label });
            let answer = cell.borrow_mut().call_store("resizeImage", json!([input]))?;
            Ok(ResizedImage {
                data: text_of(&answer, "data"),
                media_type: text_of(&answer, "mimeType"),
                metadata_text: answer.get("metadataText").and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned),
            })
        }
    }

    /// The surfaces that own the floating area and the wheel (`scrollFocusRef.current`).
    pub(crate) fn overlay_owner_now(&self) -> OverlayOwner {
        OverlayOwner {
            slash_palette_open: self.palette().slash_palette_open,
            picker: self.surface.picker().is_some(),
            tool_approval: self.tool_approval_value().is_some(),
            context_panel: self.surface.context().is_some(),
            usage_panel: self.surface.usage().is_some(),
            btw_panel: self.btw.panel().is_some(),
            provider_prompt: self.provider_prompt.is_some(),
            settings_prompt: self.settings_prompt.is_some(),
        }
    }
}

// ---- the global key handler's host ------------------------------------------------------------------------------------

fn region_name(region: crate::mouse::Region) -> &'static str {
    match region {
        crate::mouse::Region::Transcript => "transcript",
        crate::mouse::Region::Status => "status",
        crate::mouse::Region::Prompt => "prompt",
    }
}

fn shifted_rect(rect: &TermRect) -> SelectionRect {
    SelectionRect {
        mode: None,
        x1: i64::from(rect.x1),
        y1: i64::from(rect.y1),
        x2: i64::from(rect.x2),
        y2: i64::from(rect.y2),
        clip_y1: rect.clip_y1.map(i64::from),
        clip_y2: rect.clip_y2.map(i64::from),
        capture_text: Some(rect.capture_text),
    }
}

impl GlobalKeyHost for AppState {
    fn settle_stuck_drag(&mut self) {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return };
        mouse.settle_stuck_drag(self, now);
        self.mouse = Some(mouse);
    }

    fn tool_approval(&self) -> Option<ToolApproval> {
        let approval = self.tool_approval_value()?;
        Some(ToolApproval { id: approval.get("id").map(mixdog_js::value_to_string).unwrap_or_default(), kind: text_of(&approval, "kind") })
    }

    fn resolve_tool_approval(&mut self, id: &str, decision: ApprovalDecision) {
        self.finish_approval(id, decision.approved, decision.reason, None);
    }

    fn picker_open(&self) -> bool {
        self.surface.picker().is_some()
    }

    fn prompt_selection_text(&self) -> Option<String> {
        self.prompt.selection.as_ref().map(|selection| selection.text.clone())
    }

    fn drag_region(&self) -> Option<String> {
        self.mouse.as_ref()?.drag.region.map(|region| region_name(region).to_owned())
    }

    fn drag_rect(&self) -> Option<SelectionRect> {
        self.mouse.as_ref()?.drag.rect.as_ref().map(shifted_rect)
    }

    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String> {
        mixdog_term::clipboard::copy_to_clipboard(&mut std::io::stdout(), text, false).map(|_| ()).map_err(|error| error.0)
    }

    fn copy_selection(&mut self) {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return };
        mouse.copy_selection(self, 0, now);
        self.mouse = Some(mouse);
    }

    fn toggle_expand(&mut self) {
        self.tool_output_expanded = !self.tool_output_expanded;
    }

    fn grid_selection_active(&self) -> bool {
        self.mouse.as_ref().is_some_and(Mouse::grid_selection_active)
    }

    fn move_selection_focus(&mut self, direction: SelectionMove) -> bool {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return false };
        let step = match direction {
            SelectionMove::Left => FocusMove::Left,
            SelectionMove::Right => FocusMove::Right,
            SelectionMove::Up => FocusMove::Up,
            SelectionMove::Down => FocusMove::Down,
            SelectionMove::LineStart => FocusMove::LineStart,
            SelectionMove::LineEnd => FocusMove::LineEnd,
        };
        let moved = mouse.move_selection_focus(self, step, now);
        self.mouse = Some(mouse);
        moved
    }

    fn scroll_focus(&self) -> OverlayOwner {
        self.overlay_owner_now()
    }

    fn rows(&self) -> Option<usize> {
        Some(self.chrome.resize_state().rows)
    }

    fn scroll_transcript_rows(&mut self, delta: i64) {
        let Some(mut mouse) = self.mouse.take() else { return };
        self.scroll_rows_with(&mut mouse, delta as f64);
        self.mouse = Some(mouse);
    }

    fn reset_transcript_scroll(&mut self) {
        self.scroll.reset_transcript_scroll();
        self.frame_requested = true;
    }

    fn reset_drag(&mut self) {
        if let Some(mouse) = self.mouse.as_mut() {
            mouse.drag.active = false;
            mouse.drag.region = None;
            mouse.drag.anchor_span = None;
        }
    }

    fn clear_prompt_mouse_selection(&mut self) {
        if let Some(editor) = self.editor.as_mut() {
            PromptSelection::clear(editor);
        }
        self.sync_editor_after_mouse();
    }

    fn clear_selection_rect(&mut self) {
        let now = self.clock.now();
        let Some(mut mouse) = self.mouse.take() else { return };
        mouse.apply_selection_rect(self, None, now);
        self.mouse = Some(mouse);
    }

    fn is_windows(&self) -> bool {
        cfg!(windows)
    }
}

// ---- the mouse's host --------------------------------------------------------------------------------------------------

impl AppState {
    fn render_view(&mut self) -> Render<'_> {
        Render { grid: &self.rendered_grid, selection: &mut self.render_selection, frame: &mut self.frame_requested, repaint: &mut self.repaint_requested }
    }
}

impl RenderStore for AppState {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan> {
        self.render_view().word_rect_at(x, y)
    }

    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan> {
        self.render_view().line_rect_at(y)
    }

    fn set_render_selection(&mut self, rect: Option<&TermRect>) {
        self.render_view().set_render_selection(rect);
    }

    fn render_selection_text(&mut self) -> Option<String> {
        self.render_view().render_selection_text()
    }

    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>> {
        self.render_view().render_selection_rows()
    }

    fn force_render_repaint(&mut self) {
        self.render_view().force_render_repaint();
    }
}

impl SelectionIo for AppState {
    fn scroll_target(&self) -> f64 {
        self.scroll.target
    }
}

impl MouseHost for AppState {
    fn prompt(&mut self) -> Option<&mut dyn PromptSelection> {
        self.editor.as_mut().map(|editor| editor as &mut dyn PromptSelection)
    }

    fn stop_smooth_scroll(&mut self) {
        self.scroll.stop_smooth_scroll();
    }

    fn queue_scroll_coalesced(&mut self, mouse: &mut Mouse, rows: f64) {
        let now = self.clock.now();
        let coalesce_ms = mouse.config().tuning.coalesce_ms;
        if let Some(rows) = self.scroll_coalescer.queue(rows, now, coalesce_ms) {
            self.scroll_rows_with(mouse, rows);
        }
    }

    fn scroll_transcript_rows(&mut self, mouse: &mut Mouse, rows: f64) {
        self.scroll_rows_with(mouse, rows);
    }

    fn bottom_slack_rows(&self) -> f64 {
        self.scroll.bottom_slack_rows as f64
    }

    fn slash_palette(&self) -> MousePalette {
        let palette = self.palette();
        MousePalette { open: palette.slash_palette_open, count: palette.slash_commands.len() }
    }

    fn overlay_owner(&self) -> OverlayOwner {
        self.overlay_owner_now()
    }

    fn step_slash_index(&mut self, wheel_dir: i32, count: usize) {
        let next = self.slash_index as i64 - i64::from(wheel_dir);
        self.slash_index = next.clamp(0, count.saturating_sub(1) as i64) as usize;
    }

    fn passthrough_ctrl_wheel_zoom(&mut self) {
        self.zoom_passthrough();
    }

    fn write_clipboard(&mut self, text: &str) -> Result<(), String> {
        GlobalKeyHost::copy_to_clipboard(self, text)
    }

    fn show_selection_copy_hint(&mut self, message: &str, tone: MouseHint) {
        let now = self.clock.now();
        self.prompt.hint.show(message, editor_tone(tone), None, now);
    }
}
