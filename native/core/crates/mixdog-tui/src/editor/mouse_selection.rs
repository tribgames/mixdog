//! The prompt box's mouse drag-selection driver (`components/prompt-input/mouse-selection.mjs`).
//!
//! The app's mouse handler maps a click or drag cell over the box to an edit offset and calls these, so the same
//! `selectionAnchor`/cursor engine the keyboard's Shift-selection uses paints the highlight: anchor on press, extend on
//! drag and release, clear on a plain click. Its one extra job is cadence: drag-extend commits are coalesced to one per
//! [`MOUSE_EXTEND_COALESCE_MS`] (SGR motion can fire faster than a frame) while the press and release edges commit straight
//! through. The timer is the host's: it wakes at [`PromptEditor::mouse_deadline`] and calls
//! [`PromptEditor::flush_mouse_due`].

use super::draft::Draft;
use super::editing::{len16, line_end, line_start, offset_at_cell, selection_range, word_range_at};
use super::prompt::{CommitOptions, PromptCallbacks, PromptEditor};

/// Drag-extend commits are coalesced to this cadence, the transcript selection's paint cadence.
pub const MOUSE_EXTEND_COALESCE_MS: u64 = 24;

/// A drag-extend commit waiting for its turn.
#[derive(Clone, Debug, Default)]
pub struct MouseCoalesce {
    pending_next: Option<Draft>,
    /// When the pending commit is due.
    due_at: Option<u64>,
    /// When the last commit was made.
    last_at: u64,
}

/// A mouse-mapped edit offset clamped into the value.
fn clamp_mouse_offset(value: &str, offset: usize) -> usize {
    offset.min(len16(value))
}

impl PromptEditor {
    pub(super) fn cancel_mouse_extend_coalesce(&mut self) {
        self.mouse.due_at = None;
        self.mouse.pending_next = None;
    }

    fn queue_mouse_extend_commit(&mut self, next: Draft, immediate: bool, cb: &mut dyn PromptCallbacks) {
        if immediate {
            self.cancel_mouse_extend_coalesce();
            self.commit_draft(next, CommitOptions { immediate_settle: true, ..CommitOptions::default() }, cb);
            self.mouse.last_at = self.now();
            return;
        }
        let throttled = CommitOptions { throttled_render: true, ..CommitOptions::default() };
        if *self.draft() == next {
            self.cancel_mouse_extend_coalesce();
            self.commit_draft(next, throttled, cb);
            return;
        }
        let now = self.now();
        let elapsed = now.saturating_sub(self.mouse.last_at);
        if elapsed >= MOUSE_EXTEND_COALESCE_MS {
            self.cancel_mouse_extend_coalesce();
            self.mouse.last_at = now;
            self.commit_draft(next, throttled, cb);
            return;
        }
        self.mouse.pending_next = Some(next);
        if self.mouse.due_at.is_none() {
            self.mouse.due_at = Some(now + (MOUSE_EXTEND_COALESCE_MS - elapsed).max(1));
        }
    }

    /// When the host must call [`Self::flush_mouse_due`]; none when no drag commit waits.
    pub fn mouse_deadline(&self) -> Option<u64> {
        self.mouse.due_at
    }

    /// Commits the waiting drag-extend draft when its time has come.
    pub fn flush_mouse_due(&mut self, cb: &mut dyn PromptCallbacks) {
        let now = self.now();
        let Some(due_at) = self.mouse.due_at else { return };
        if now < due_at {
            return;
        }
        let pending = self.mouse.pending_next.take();
        self.mouse.due_at = None;
        self.mouse.last_at = now;
        if let Some(pending) = pending {
            self.commit_draft(pending, CommitOptions { throttled_render: true, ..CommitOptions::default() }, cb);
        }
    }

    /// The edit offset of cell (`row`, `col`) of the content box.
    pub fn mouse_offset_at_cell(&self, row: usize, col: usize) -> usize {
        offset_at_cell(&self.draft().value, row, col, self.content_width())
    }

    /// Press: the caret and the anchor go to `offset`.
    pub fn mouse_anchor_at(&mut self, offset: usize, cb: &mut dyn PromptCallbacks) {
        self.cancel_mouse_extend_coalesce();
        let off = clamp_mouse_offset(&self.draft().value, offset);
        let next = Draft { cursor: off, selection_anchor: Some(off), ..self.draft().clone() };
        self.commit_draft(next, CommitOptions::default(), cb);
        self.mouse.last_at = self.now();
    }

    /// Drag or release: the caret goes to `offset`, the anchor stays (or starts at the old caret). `None` is a drag outside
    /// the box: nothing moves, and a release cancels the waiting commit.
    pub fn mouse_extend_to(&mut self, offset: Option<usize>, immediate: bool, cb: &mut dyn PromptCallbacks) {
        let Some(offset) = offset else {
            if immediate {
                self.cancel_mouse_extend_coalesce();
            }
            return;
        };
        let d = self.draft().clone();
        let off = clamp_mouse_offset(&d.value, offset);
        let anchor = d.selection_anchor.unwrap_or(d.cursor);
        self.queue_mouse_extend_commit(Draft { cursor: off, selection_anchor: Some(anchor), ..d }, immediate, cb);
    }

    pub fn mouse_has_selection(&self) -> bool {
        selection_range(self.draft()).is_some()
    }

    /// Double click: the word or punctuation run under `offset` becomes the selection.
    pub fn mouse_select_word_at(&mut self, offset: usize, cb: &mut dyn PromptCallbacks) {
        self.cancel_mouse_extend_coalesce();
        let d = self.draft().clone();
        let range = word_range_at(&d.value, clamp_mouse_offset(&d.value, offset));
        self.commit_draft(Draft { cursor: range.end, selection_anchor: Some(range.start), ..d }, CommitOptions::default(), cb);
        self.mouse.last_at = self.now();
    }

    /// Triple click: the line under `offset` becomes the selection.
    pub fn mouse_select_line_at(&mut self, offset: usize, cb: &mut dyn PromptCallbacks) {
        self.cancel_mouse_extend_coalesce();
        let d = self.draft().clone();
        let off = clamp_mouse_offset(&d.value, offset);
        let (start, end) = (line_start(&d.value, off), line_end(&d.value, off));
        self.commit_draft(Draft { cursor: end, selection_anchor: Some(start), ..d }, CommitOptions::default(), cb);
        self.mouse.last_at = self.now();
    }

    /// A plain click: a live selection is cleared.
    pub fn mouse_clear(&mut self, cb: &mut dyn PromptCallbacks) {
        self.cancel_mouse_extend_coalesce();
        if selection_range(self.draft()).is_some() {
            let cleared = super::editing::clear_selection(self.draft());
            self.commit_draft(cleared, CommitOptions::default(), cb);
        }
    }
}
