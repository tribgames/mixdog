//! The prompt editor: the state of `components/PromptInput.jsx` and the key dispatch of
//! `components/prompt-input/key-handler.mjs` and `escape-key.mjs`.
//!
//! [`PromptEditor`] owns the draft, the undo history, the remembered column of a run of vertical moves, the escape arming
//! time, the paste generation and the submit gate. A host feeds it decoder events through [`PromptEditor::handle_key`] and
//! [`PromptEditor::handle_external_paste`] with the props of the moment ([`PromptProps`]) and the callbacks the prompt calls
//! ([`PromptCallbacks`], the `on*` props of the component). What the editor wants drawn it reports through
//! [`PromptEditor::take_render_request`]: keyboard edits and mouse-up want an immediate frame, drag motion the normal pace.

use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_js::{js_to_lowercase, js_trim};
use mixdog_term::KeyFlags;
use mixdog_termtext::display_width;
use mixdog_termtext::lone::stored;

use super::chords::apply_edit_chord;
use super::draft::Draft;
use super::editing::{
    Caret, caret_position, clear_selection, len16, line_end, line_start, move_cursor, next_word_offset, previous_word_offset, replace_selection,
    selection_range, slice16, splice16, vertical_offset,
};
use super::escape::{EscapeAction, EscapeInput, classify_prompt_escape};
use super::helpers::{
    HintTone, insert_text, is_any_modified_enter_sequence, is_modified_enter_sequence, left_arrow_offset, normalize_pasted_text, right_arrow_offset,
    single_trailing_line_break_prefix,
};
use super::mouse_selection::MouseCoalesce;
use super::restore::palette_owns_prompt_vertical_arrow;
use super::signals::{decode_arrow_signals, is_csi_private_reply, is_discarded_control_input, is_mouse_report_sequence, printable_from_input};
use super::undo::UndoStack;

/// Milliseconds on the wall clock; the editor's timestamps (undo coalescing, the escape double press, mouse-drag pacing).
pub type Clock = fn() -> u64;

fn system_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// The props of the component that the key dispatch reads at event time.
#[derive(Clone, Debug, Default)]
pub struct PromptProps {
    pub disabled: bool,
    pub interrupt_active: bool,
    pub command_palette_active: bool,
    /// Defaults to `command_palette_active`.
    pub command_palette_open: Option<bool>,
    /// Defaults to 2 while the palette is active, else 0.
    pub command_palette_option_count: Option<i64>,
    /// Whether Left/Right move the caret while the palette is open (a `$name` skill mention) instead of its selection.
    pub command_palette_moves_caret: bool,
    pub mask: bool,
    pub hint: String,
    pub hint_tone: HintTone,
    pub has_queued_messages: bool,
    pub has_messages: bool,
    /// Whether the terminal is a real TTY in raw mode; the hardware caret is only parked then.
    pub raw_mode_supported: bool,
}

impl PromptProps {
    pub fn palette_open(&self) -> bool {
        self.command_palette_open.unwrap_or(self.command_palette_active)
    }

    pub fn palette_option_count(&self) -> i64 {
        self.command_palette_option_count.unwrap_or(if self.command_palette_active { 2 } else { 0 })
    }
}

/// The phase an Escape press reports to `on_escape`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscapePhase {
    /// Before the prompt acts: the owner may consume the key.
    Before,
    ClearArm,
    Clear,
    SelectArm,
    Select,
    Empty,
}

/// What the palette is asked to do with a key it owns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaletteNav {
    /// Up or Down by this many options (PageUp/PageDown move by 8).
    Step(i32),
    Home,
    End,
    Left,
    Right,
}

/// What a palette accept or complete hands back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaletteReply {
    /// The palette did not accept (`false`).
    Declined,
    /// Accepted with no draft to put in the box (nothing, `true` or any other value).
    Accepted,
    /// The next draft as a string, the caret at its end.
    Text(String),
    /// The next draft with its caret (a completed `$name` skill mention).
    Draft { value: String, cursor: usize },
}

/// The draft a palette reply puts in the box (`paletteResultDraft`).
pub fn palette_result_draft(reply: &PaletteReply) -> Option<Draft> {
    match reply {
        PaletteReply::Text(text) => Some(Draft::at_end(text.as_str())),
        PaletteReply::Draft { value, cursor } => Some(Draft::new(value.as_str(), *cursor, None)),
        PaletteReply::Declined | PaletteReply::Accepted => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteSource {
    Paste,
    PasteFallback,
    ClipboardShortcut,
}

/// What an `on_paste_text` callback answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PasteReply {
    /// Insert this text instead of the pasted one.
    Insert(String),
    /// The callback consumed the paste.
    Drop,
    /// Insert the pasted text as it is (also what a failed callback gets).
    Fallback,
    /// The answer comes later: [`PromptEditor::take_pending_pastes`] hands the ticket to finish it with.
    Pending,
}

/// A paste whose callback answers later. Finishing it after the draft moved on (a submit, an override, the unmount) drops it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasteTicket {
    generation: u64,
    pasted: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryDirection {
    Up,
    Down,
}

/// A queued-message restore request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreRequest {
    pub show_hint: bool,
    pub current_text: String,
    /// The draft when the request was made; a restore that settles later merges with the latest draft.
    pub draft: Draft,
}

/// The `on*` props of the component. Every method has the answer a missing prop gives.
pub trait PromptCallbacks {
    /// The prompt was submitted; false keeps the draft in the box.
    fn on_submit(&mut self, _text: &str) -> bool {
        true
    }
    fn on_draft_change(&mut self, _value: &str) {}
    /// The caret moved (caret-aware completion of `$name` skill mentions).
    fn on_caret_change(&mut self, _cursor: usize) {}
    /// Escape cancelled active work; the answer is the submitted prompt to restore into an empty box.
    fn on_interrupt(&mut self, _value: &str) -> Option<String> {
        None
    }
    /// Escape; true consumes the key (only checked for [`EscapePhase::Before`]).
    fn on_escape(&mut self, _value: &str, _phase: EscapePhase) -> bool {
        false
    }
    /// Tab outside a palette; true consumes the key.
    fn on_tab(&mut self, _value: &str) -> bool {
        false
    }
    fn on_command_palette_navigate(&mut self, _nav: PaletteNav) {}
    fn on_command_palette_accept(&mut self, _value: &str, _cursor: usize) -> PaletteReply {
        PaletteReply::Accepted
    }
    fn on_command_palette_cancel(&mut self, _value: &str) {}
    fn on_command_palette_complete(&mut self, _value: &str, _cursor: usize) -> PaletteReply {
        PaletteReply::Accepted
    }
    /// Escape or Up asked for the queued messages to come back into the box; true when there were some.
    fn on_restore_queued(&mut self, _request: &RestoreRequest) -> bool {
        false
    }
    /// Up/Down at the first/last line: the history entry to show, if any.
    fn on_history_navigate(&mut self, _direction: HistoryDirection, _value: &str, _empty_draft: bool) -> Option<String> {
        None
    }
    fn on_paste_text(&mut self, _text: &str, _source: PasteSource) -> PasteReply {
        PasteReply::Fallback
    }
    /// Whether a transcript or status grid selection owns Shift+Arrow right now (read at event time, because the owner's own
    /// key handler runs after this one for the same event).
    fn grid_selection_active(&mut self) -> bool {
        false
    }
}

/// How much redrawing an edit wants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum RenderRequest {
    #[default]
    None,
    /// The normal frame pace (mouse-drag motion).
    Throttled,
    /// The next frame at once (keyboard echo, the end of a drag).
    Immediate,
}

/// How a draft is committed.
#[derive(Clone, Copy, Debug, Default)]
pub struct CommitOptions {
    pub skip_history: bool,
    pub keep_preferred_column: bool,
    pub undo_break: bool,
    pub immediate_settle: bool,
    pub throttled_render: bool,
}

/// An override of the draft published by the app (a restored queue, a picked message, a restored interrupted prompt).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftOverride {
    pub value: String,
    pub cursor: Option<usize>,
    pub selection_anchor: Option<usize>,
}

/// The selected text and its range, for a copy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionInfo {
    pub start: usize,
    pub end: usize,
    /// Empty for a masked prompt.
    pub text: String,
}

/// The absolute cell rect of the editable content box, published so the mouse handler can map a cell to an edit offset.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoxRect {
    pub top: i32,
    pub left: i32,
    pub height: usize,
    pub content_width: usize,
}

/// The layout the host knows about the content box when it asks for the caret.
#[derive(Clone, Copy, Debug, Default)]
pub struct BoxLayout {
    pub top: i32,
    pub left: i32,
    /// The computed width of the content box; 0 before layout.
    pub width: usize,
    pub height: usize,
}

/// Columns kept free at the left edge of the box for IME composition (the rounded box's padding already does).
pub const IME_LEFT_GUARD_COLUMNS: usize = 0;

#[derive(Debug)]
pub struct PromptEditor {
    draft: Draft,
    last_reported_value: String,
    last_reported_cursor: Option<usize>,
    /// Bumped on every submit, draft override and unmount so an async paste that settles after the draft moved on can tell.
    paste_generation: u64,
    /// One physical Enter must not enqueue twice when the terminal delivers the chord as several events before the draft
    /// clears (Windows CR/LF); released by [`Self::end_input_batch`].
    submit_gate: bool,
    escape_clear_at: u64,
    content_width: usize,
    preferred_column: Option<usize>,
    undo: UndoStack,
    pub(super) mouse: MouseCoalesce,
    box_rect: Option<BoxRect>,
    render_request: RenderRequest,
    pending_pastes: Vec<PasteTicket>,
    clock: Clock,
}

impl PromptEditor {
    /// An editor starting with `initial_value` and the caret after it.
    pub fn new(initial_value: &str) -> Self {
        Self::with_clock(initial_value, system_now)
    }

    pub fn with_clock(initial_value: &str, clock: Clock) -> Self {
        Self::with_draft(Draft::at_end(initial_value), clock)
    }

    /// An editor starting with `draft` (its caret and selection as given) on `clock`.
    pub fn with_draft(draft: Draft, clock: Clock) -> Self {
        Self {
            last_reported_value: draft.value.clone(),
            draft,
            last_reported_cursor: None,
            paste_generation: 0,
            submit_gate: false,
            escape_clear_at: 0,
            content_width: 80,
            preferred_column: None,
            undo: UndoStack::new(),
            mouse: MouseCoalesce::default(),
            box_rect: None,
            render_request: RenderRequest::None,
            pending_pastes: Vec::new(),
            clock,
        }
    }

    pub(super) fn now(&self) -> u64 {
        (self.clock)()
    }

    pub fn draft(&self) -> &Draft {
        &self.draft
    }

    pub fn value(&self) -> &str {
        &self.draft.value
    }

    pub fn undo_stack(&self) -> &UndoStack {
        &self.undo
    }

    pub fn escape_clear_armed_at(&self) -> u64 {
        self.escape_clear_at
    }

    pub fn content_width(&self) -> usize {
        self.content_width
    }

    pub fn box_rect(&self) -> Option<BoxRect> {
        self.box_rect
    }

    /// The live selection with its text (empty for a masked prompt).
    pub fn selection(&self, mask: bool) -> Option<SelectionInfo> {
        let range = selection_range(&self.draft)?;
        let text = if mask { String::new() } else { stored(slice16(&self.draft.value, range.start, range.end)).into_owned() };
        Some(SelectionInfo { start: range.start, end: range.end, text })
    }

    /// What the editor wants drawn since the last call.
    pub fn take_render_request(&mut self) -> RenderRequest {
        std::mem::take(&mut self.render_request)
    }

    /// The pastes whose callbacks answered [`PasteReply::Pending`] since the last call.
    pub fn take_pending_pastes(&mut self) -> Vec<PasteTicket> {
        std::mem::take(&mut self.pending_pastes)
    }

    /// The input events of one read are done: the submit gate opens again.
    pub fn end_input_batch(&mut self) {
        self.submit_gate = false;
    }

    /// A (re)mounted input reports its caret at the end of its initial value.
    pub fn mount(&mut self, cb: &mut dyn PromptCallbacks) {
        self.report_caret(self.draft.cursor, cb);
    }

    /// The input is gone: a paste that settles later is dropped and a pending drag commit is cancelled.
    pub fn unmount(&mut self) {
        self.paste_generation += 1;
        self.cancel_mouse_extend_coalesce();
    }

    fn report_caret(&mut self, cursor: usize, cb: &mut dyn PromptCallbacks) {
        if self.last_reported_cursor == Some(cursor) {
            return;
        }
        self.last_reported_cursor = Some(cursor);
        cb.on_caret_change(cursor);
    }

    fn request_render(&mut self, request: RenderRequest) {
        self.render_request = self.render_request.max(request);
    }

    /// Puts `next` in the box: records the undo step, reports the changed value and caret, and asks for a frame.
    pub fn commit_draft(&mut self, next: Draft, options: CommitOptions, cb: &mut dyn PromptCallbacks) {
        self.escape_clear_at = 0;
        let same_draft = self.draft == next;
        if !options.keep_preferred_column {
            self.preferred_column = None;
        }
        if same_draft {
            // Mouse-up is a render boundary even when the final cell matches the last coalesced drag cell: the final
            // highlight settles at once.
            if options.immediate_settle {
                self.request_render(RenderRequest::Immediate);
            }
            return;
        }
        if !options.skip_history {
            let now = self.now();
            self.undo.record(&self.draft, &next, options.undo_break, now);
        }
        self.draft = next;
        // Drag motion paces like any frame; keyboard edits and the end of a drag keep the low-latency flush.
        self.request_render(if options.throttled_render { RenderRequest::Throttled } else { RenderRequest::Immediate });
        if self.draft.value != self.last_reported_value {
            self.last_reported_value.clone_from(&self.draft.value);
            cb.on_draft_change(&stored(&self.draft.value));
        }
        self.report_caret(self.draft.cursor, cb);
    }

    fn commit(&mut self, next: Draft, cb: &mut dyn PromptCallbacks) {
        self.commit_draft(next, CommitOptions::default(), cb);
    }

    fn update(&mut self, edit: impl FnOnce(&Draft) -> Draft, cb: &mut dyn PromptCallbacks) {
        let next = edit(&self.draft);
        self.commit(next, cb);
    }

    fn commit_empty(&mut self, cb: &mut dyn PromptCallbacks) {
        self.commit(Draft::empty(), cb);
    }

    /// The visual-line move that remembers the preferred column across a run of vertical moves; false when the caret could
    /// not move.
    pub fn move_draft_vertically(&mut self, direction: i32, extend: bool, cb: &mut dyn PromptCallbacks) -> bool {
        let current = self.draft.clone();
        let moved = vertical_offset(&current.value, current.cursor, self.content_width, direction, self.preferred_column);
        self.preferred_column = Some(moved.preferred_column);
        if moved.cursor == current.cursor {
            return false;
        }
        let options = CommitOptions { keep_preferred_column: true, ..CommitOptions::default() };
        self.commit_draft(move_cursor(&current, moved.cursor, extend), options, cb);
        true
    }

    /// Asks the owner to bring queued messages back into the box. The owner merges them with the latest draft when its
    /// answer settles ([`super::restore::merge_queued_restore_draft`]) and puts the result in through [`Self::commit_draft`].
    pub fn restore_queued_to_draft(&mut self, show_hint: bool, cb: &mut dyn PromptCallbacks) -> bool {
        let current_text = stored(&self.draft.value).into_owned();
        let draft = Draft { value: current_text.clone(), ..self.draft.clone() };
        let request = RestoreRequest { show_hint, current_text, draft };
        cb.on_restore_queued(&request)
    }

    fn apply_history_navigation(&mut self, direction: HistoryDirection, cb: &mut dyn PromptCallbacks) -> bool {
        let empty_draft = self.draft.value.is_empty();
        let value = stored(&self.draft.value).into_owned();
        let Some(next) = cb.on_history_navigate(direction, &value, empty_draft) else { return false };
        self.commit(Draft::at_end(next), cb);
        true
    }

    fn insert_at_draft(&mut self, text: &str, cb: &mut dyn PromptCallbacks) {
        if text.is_empty() {
            return;
        }
        let next = insert_text(&self.draft, text);
        self.commit(next, cb);
    }

    /// A paste (bracketed paste, a newline-carrying input, the clipboard shortcut): the callback may take it, replace it or
    /// answer later; with no answer the pasted text is inserted.
    pub fn handle_external_paste(&mut self, text: &str, source: PasteSource, cb: &mut dyn PromptCallbacks) {
        let pasted = normalize_pasted_text(text);
        let generation = self.paste_generation;
        let reply = cb.on_paste_text(&pasted, source);
        self.apply_paste_reply(PasteTicket { generation, pasted }, reply, cb);
    }

    /// The answer of a callback that said [`PasteReply::Pending`]. A rejected callback answers [`PasteReply::Fallback`].
    pub fn finish_paste(&mut self, ticket: PasteTicket, reply: PasteReply, cb: &mut dyn PromptCallbacks) {
        self.apply_paste_reply(ticket, reply, cb);
    }

    fn apply_paste_reply(&mut self, ticket: PasteTicket, reply: PasteReply, cb: &mut dyn PromptCallbacks) {
        if ticket.generation != self.paste_generation {
            return;
        }
        match reply {
            PasteReply::Insert(text) => self.insert_at_draft(&text, cb),
            PasteReply::Drop => {}
            PasteReply::Fallback => self.insert_at_draft(&ticket.pasted, cb),
            PasteReply::Pending => self.pending_pastes.push(ticket),
        }
    }

    /// A bracketed paste from the terminal (the `usePaste` hook): ignored while the prompt is disabled.
    pub fn handle_paste(&mut self, text: &str, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        if !props.disabled {
            self.handle_external_paste(text, PasteSource::Paste, cb);
        }
    }

    /// Applies a draft override: the value, with the caret and anchor clamped into it (the caret at the end and no
    /// selection when not given). It is no undo step and it resets the undo history. The host calls it whenever the
    /// published override changes in any field, not on its id alone (a restored queue publishes twice within a millisecond).
    pub fn apply_draft_override(&mut self, draft_override: &DraftOverride, cb: &mut dyn PromptCallbacks) {
        self.paste_generation += 1;
        let length = len16(&draft_override.value);
        let cursor = draft_override.cursor.map_or(length, |cursor| cursor.min(length));
        let selection_anchor = draft_override.selection_anchor.map(|anchor| anchor.min(length));
        let next = Draft { value: draft_override.value.clone(), cursor, selection_anchor };
        self.commit_draft(next, CommitOptions { skip_history: true, ..CommitOptions::default() }, cb);
        self.undo.reset();
    }

    fn submit_draft(&mut self, next: Draft, cb: &mut dyn PromptCallbacks) {
        if self.submit_gate {
            return;
        }
        if js_trim(&next.value).is_empty() {
            return;
        }
        self.submit_gate = true;
        let accepted = cb.on_submit(&stored(&next.value));
        if !accepted {
            self.submit_gate = false;
            self.commit(next, cb);
            return;
        }
        self.paste_generation += 1;
        self.commit_draft(Draft::empty(), CommitOptions { skip_history: true, ..CommitOptions::default() }, cb);
        self.undo.reset();
        // The gate stays shut until the input batch drains, so a second return event of the same chord cannot re-submit.
    }

    fn submit_enter_chunk(&mut self, prefix: &str, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        let next = if prefix.is_empty() { self.draft.clone() } else { insert_text(&self.draft, prefix) };
        if props.command_palette_active {
            let accepted = cb.on_command_palette_accept(&stored(&next.value), next.cursor);
            if let Some(replacement) = palette_result_draft(&accepted) {
                self.commit(replacement, cb);
            } else if accepted != PaletteReply::Declined {
                self.commit_empty(cb);
            } else if !prefix.is_empty() {
                self.commit(next, cb);
            }
            return;
        }
        self.submit_draft(next, cb);
    }

    /// The hardware caret cell inside the content box and, as a side effect, the box rect and content width of the frame:
    /// what Ink's cursor-anchor function did during layout (`prompt-input/cursor-anchor.mjs`). `enabled` is whether the
    /// prompt is a real, active edit target; the box is not published while it is not asked.
    pub fn cursor_anchor(&mut self, layout: &BoxLayout, enabled: bool) -> Option<Caret> {
        self.box_rect = Some(BoxRect { top: layout.top, left: layout.left, height: layout.height.max(1), content_width: self.content_width });
        if !enabled {
            return None;
        }
        let width = layout.width;
        let guard = if width > IME_LEFT_GUARD_COLUMNS { IME_LEFT_GUARD_COLUMNS } else { 0 };
        let source = if width > 0 { width - guard } else { self.content_width };
        let content_width = (if source == 0 { 80 } else { source }).max(1);
        self.content_width = content_width;
        let d = &self.draft;
        // The prompt renders a trailing blank cell at the end of the input, so a caret flush on the last column there still
        // has a following cell.
        let trailing = if d.cursor >= d.len16() { Some(true) } else { None };
        Some(if width > 0 {
            let caret = caret_position(&d.value, d.cursor, content_width, trailing);
            Caret { row: caret.row, col: caret.col + guard }
        } else {
            Caret { row: 0, col: display_width(slice16(&d.value, 0, d.cursor)) }
        })
    }

    /// The Enter-key paths shared with the key handler: a `\` before the caret turns Enter into a newline.
    fn backslash_before_caret(&self) -> bool {
        self.draft.cursor > 0 && slice16(&self.draft.value, self.draft.cursor - 1, self.draft.cursor) == "\\"
    }

    /// One `(input, key)` event of the decoder, the prompt's whole key dispatch.
    pub fn handle_key(&mut self, input: &str, key: &KeyFlags, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        if props.disabled {
            return;
        }
        let raw = input;
        let input_key = js_to_lowercase(raw);
        if !key.escape {
            self.escape_clear_at = 0;
        }
        let signals = decode_arrow_signals(raw, key);

        // The app owns Shift+Arrow while a transcript or status grid selection is live.
        if cb.grid_selection_active() {
            let shift_arrow = key.shift && (key.left_arrow || key.right_arrow || key.up_arrow || key.down_arrow || key.home || key.end);
            if shift_arrow || signals.raw_shift_arrow_for_grid {
                return;
            }
        }

        // Terminal reports are not text: drop SGR mouse sequences and CSI-private replies before anything types them.
        if is_mouse_report_sequence(raw) || is_csi_private_reply(raw) {
            return;
        }

        let has_line_break = raw.contains(['\r', '\n']);
        let raw_enter = matches!(raw, "\r" | "\n" | "\r\n");
        let trailing_enter_prefix = single_trailing_line_break_prefix(raw);
        let raw_modified_enter = is_modified_enter_sequence(raw);
        let modified_line_break = key.shift || key.meta || key.ctrl || raw_modified_enter;

        // Ctrl+J is the protocol-independent newline. A lone `\n` is Ctrl+J on legacy terminals (a real Enter is CR); under
        // the kitty protocol it arrives as `j` with ctrl. It runs before the trailing-newline paths, which would take a bare
        // `\n` for a submit.
        if (raw == "\n" && !key.return_key) || (key.ctrl && input_key == "j") {
            self.update(|d| replace_selection(d, "\n"), cb);
            return;
        }

        // Uncommon modified-Enter combinations outside the Shift/Alt/Ctrl set are consumed so raw CSI bytes never enter.
        if !raw_modified_enter && is_any_modified_enter_sequence(raw) {
            return;
        }

        // Bracketed paste arrives on its own channel; this is the defensive path for a multi-character chunk with a newline.
        let paste_fallback = has_line_break && trailing_enter_prefix.is_none() && !raw_enter && (len16(raw) > 1 || !key.return_key);
        if paste_fallback {
            self.handle_external_paste(raw, PasteSource::PasteFallback, cb);
            return;
        }

        if let Some(prefix) = trailing_enter_prefix {
            if modified_line_break {
                self.update(|d| insert_text(d, &format!("{prefix}\n")), cb);
                return;
            }
            self.submit_enter_chunk(&prefix, props, cb);
            return;
        }

        if raw_modified_enter {
            self.update(|d| replace_selection(d, "\n"), cb);
            return;
        }

        if !props.command_palette_active && (key.ctrl || key.meta) && input_key == "v" {
            // Ctrl+V / Meta+V reads the OS clipboard (text first, image fallback); the empty text tags the shortcut path.
            self.handle_external_paste("", PasteSource::ClipboardShortcut, cb);
            return;
        }

        if key.return_key {
            self.handle_return(modified_line_break, props, cb);
            return;
        }

        // Ctrl+Shift+Left/Right extend the selection by whole words, before the plain shift-arrow branches.
        if signals.ctrl_shift_held && (signals.raw_ctrl_shift_left || (key.ctrl && key.shift && key.left_arrow)) {
            if !props.command_palette_active {
                self.update(|d| move_cursor(d, previous_word_offset(&d.value, d.cursor), true), cb);
            }
            return;
        }
        if signals.ctrl_shift_held && (signals.raw_ctrl_shift_right || (key.ctrl && key.shift && key.right_arrow)) {
            if !props.command_palette_active {
                self.update(|d| move_cursor(d, next_word_offset(&d.value, d.cursor), true), cb);
            }
            return;
        }

        if key.up_arrow || signals.raw_up_arrow || signals.raw_shift_up || signals.raw_ctrl_shift_up {
            self.handle_vertical_arrow(-1, signals.shift_held, props, cb);
            return;
        }
        if key.down_arrow || signals.raw_down_arrow || signals.raw_shift_down || signals.raw_ctrl_shift_down {
            self.handle_vertical_arrow(1, signals.shift_held, props, cb);
            return;
        }

        if props.command_palette_active {
            let nav = if key.page_up {
                Some(PaletteNav::Step(-8))
            } else if key.page_down {
                Some(PaletteNav::Step(8))
            } else if key.home {
                Some(PaletteNav::Home)
            } else if key.end {
                Some(PaletteNav::End)
            } else {
                None
            };
            if let Some(nav) = nav {
                cb.on_command_palette_navigate(nav);
                return;
            }
        }

        if key.tab {
            if props.command_palette_active {
                let value = stored(&self.draft.value).into_owned();
                let completed = palette_result_draft(&cb.on_command_palette_complete(&value, self.draft.cursor));
                if let Some(completed) = completed {
                    self.commit(completed, cb);
                }
                return;
            }
            let value = stored(&self.draft.value).into_owned();
            if cb.on_tab(&value) {
                return;
            }
        }

        if key.escape {
            self.handle_escape_key(props, cb);
            return;
        }

        let shift_held = signals.shift_held;
        if key.left_arrow || signals.raw_shift_left {
            if props.command_palette_active && !props.command_palette_moves_caret {
                cb.on_command_palette_navigate(PaletteNav::Left);
                return;
            }
            let word = key.ctrl || key.meta;
            self.update(|d| move_cursor(d, left_arrow_offset(d, word, shift_held), shift_held), cb);
            return;
        }
        if key.right_arrow || signals.raw_shift_right {
            if props.command_palette_active && !props.command_palette_moves_caret {
                cb.on_command_palette_navigate(PaletteNav::Right);
                return;
            }
            let word = key.ctrl || key.meta;
            self.update(|d| move_cursor(d, right_arrow_offset(d, word, shift_held), shift_held), cb);
            return;
        }
        if key.home {
            self.update(|d| move_cursor(d, line_start(&d.value, d.cursor), shift_held), cb);
            return;
        }
        if key.end {
            self.update(|d| move_cursor(d, line_end(&d.value, d.cursor), shift_held), cb);
            return;
        }

        // Undo and redo. Kitty reports Ctrl+Z as `z` with ctrl (and Ctrl+Shift+Z for redo); legacy terminals send the control
        // bytes 0x1A and 0x19, which can arrive without ctrl set, so the byte is matched too.
        let ctrl_z = (key.ctrl && input_key == "z") || raw == "\x1a";
        let ctrl_y = (key.ctrl && input_key == "y") || raw == "\x19";
        if ctrl_z && (key.shift || shift_held) {
            self.redo(cb);
            return;
        }
        if ctrl_z {
            self.undo(cb);
            return;
        }
        if ctrl_y {
            self.redo(cb);
            return;
        }

        // Ctrl+A selects all like a normal text box; Ctrl+E keeps readline's line end.
        if key.ctrl && input_key == "a" {
            self.update(
                |d| {
                    if d.value.is_empty() { clear_selection(d) } else { Draft { value: d.value.clone(), cursor: d.len16(), selection_anchor: Some(0) } }
                },
                cb,
            );
            return;
        }
        if key.ctrl && input_key == "e" {
            self.update(|d| move_cursor(d, line_end(&d.value, d.cursor), key.shift), cb);
            return;
        }
        if let Some(next) = apply_edit_chord(key, &input_key, &self.draft) {
            self.commit(next, cb);
            return;
        }

        // Printable input; the discarded Ctrl+Space encodings are a no-op.
        if is_discarded_control_input(raw) {
            return;
        }
        let printable = printable_from_input(raw);
        if !printable.is_empty() && !key.ctrl && !key.meta {
            self.update(|d| insert_text(d, &printable), cb);
        }
    }

    fn undo(&mut self, cb: &mut dyn PromptCallbacks) {
        if let Some(previous) = self.undo.undo(&self.draft) {
            self.commit_draft(previous, CommitOptions { skip_history: true, ..CommitOptions::default() }, cb);
        }
    }

    fn redo(&mut self, cb: &mut dyn PromptCallbacks) {
        if let Some(next) = self.undo.redo(&self.draft) {
            self.commit_draft(next, CommitOptions { skip_history: true, ..CommitOptions::default() }, cb);
        }
    }

    fn handle_return(&mut self, modified_line_break: bool, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        if modified_line_break {
            self.update(|d| replace_selection(d, "\n"), cb);
            return;
        }
        if props.command_palette_active {
            let value = stored(&self.draft.value).into_owned();
            let accepted = cb.on_command_palette_accept(&value, self.draft.cursor);
            // A draft-shaped accept (a completed skill mention) replaces the draft.
            if let Some(replacement) = palette_result_draft(&accepted) {
                self.commit(replacement, cb);
            } else if accepted != PaletteReply::Declined {
                self.commit_empty(cb);
            }
            return;
        }
        if self.backslash_before_caret() {
            self.update(|d| Draft { value: splice16(&d.value, d.cursor - 1, d.cursor, "\n"), cursor: d.cursor, selection_anchor: None }, cb);
            return;
        }
        let current = self.draft.clone();
        self.submit_draft(current, cb);
    }

    fn handle_vertical_arrow(&mut self, direction: i32, shift_held: bool, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        if props.command_palette_active && palette_owns_prompt_vertical_arrow(props.palette_option_count()) {
            cb.on_command_palette_navigate(PaletteNav::Step(direction));
            return;
        }
        // A Shift-held arrow is a selection gesture, never history navigation: extend by a visual line, or all the way to
        // the start (up) or end (down) of the document when already on the first (last) line.
        if shift_held {
            if !self.move_draft_vertically(direction, true, cb) {
                let edge = if direction < 0 { 0 } else { self.draft.len16() };
                self.update(|d| move_cursor(d, edge, true), cb);
            }
            return;
        }
        if self.move_draft_vertically(direction, false, cb) {
            return;
        }
        if direction < 0 {
            if !props.has_queued_messages || !self.restore_queued_to_draft(false, cb) {
                self.apply_history_navigation(HistoryDirection::Up, cb);
            }
        } else {
            self.apply_history_navigation(HistoryDirection::Down, cb);
        }
    }

    /// Escape (`prompt-input/escape-key.mjs`). Every path ends the key event.
    fn handle_escape_key(&mut self, props: &PromptProps, cb: &mut dyn PromptCallbacks) {
        if props.palette_open() {
            let value = stored(&self.draft.value).into_owned();
            cb.on_command_palette_cancel(&value);
            return;
        }
        if selection_range(&self.draft).is_some() {
            let cleared = clear_selection(&self.draft);
            self.commit(cleared, cb);
            return;
        }
        let current_value = stored(&self.draft.value).into_owned();
        if cb.on_escape(&current_value, EscapePhase::Before) {
            return;
        }
        let now = self.now();
        let mut decision = classify_prompt_escape(EscapeInput {
            interrupt_active: props.interrupt_active,
            has_selection: false,
            has_queued_messages: props.has_queued_messages,
            has_messages: props.has_messages,
            value: &current_value,
            last_clear_press_at: self.escape_clear_at,
            now,
        });
        if decision.action == EscapeAction::RestoreQueue {
            if self.restore_queued_to_draft(false, cb) {
                self.escape_clear_at = 0;
                return;
            }
            // A stale projected queue can empty between render and key handling: fall through to the draft/idle action.
            decision = classify_prompt_escape(EscapeInput {
                interrupt_active: props.interrupt_active,
                has_selection: false,
                has_queued_messages: false,
                has_messages: props.has_messages,
                value: &current_value,
                last_clear_press_at: self.escape_clear_at,
                now,
            });
        }
        self.escape_clear_at = decision.next_clear_press_at;
        match decision.action {
            // Active work always wins, even over a typed steering draft. The draft is kept; the submitted prompt comes back
            // only when the box is still empty after the cancellation.
            EscapeAction::Interrupt => {
                let restored = cb.on_interrupt(&current_value);
                if let (true, Some(text)) = (current_value.is_empty(), restored) {
                    self.commit(Draft::at_end(text), cb);
                }
            }
            EscapeAction::ArmClear => {
                cb.on_escape(&current_value, EscapePhase::ClearArm);
            }
            EscapeAction::Clear => {
                cb.on_escape(&current_value, EscapePhase::Clear);
                self.commit_empty(cb);
            }
            // An empty draft with history: the first press arms, the second opens the message selector.
            EscapeAction::ArmSelect => {
                cb.on_escape("", EscapePhase::SelectArm);
            }
            EscapeAction::MessageSelector => {
                cb.on_escape("", EscapePhase::Select);
            }
            EscapeAction::CollapseSelection | EscapeAction::RestoreQueue | EscapeAction::Idle => {
                cb.on_escape("", EscapePhase::Empty);
            }
        }
    }
}

#[cfg(test)]
mod tests;
