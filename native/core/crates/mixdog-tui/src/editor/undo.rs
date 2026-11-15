//! The prompt editor's undo/redo history (`components/prompt-input/undo-stack.mjs`).
//!
//! It decides what becomes an undo step and hands steps back to the editor, which replays them through its own commit
//! path. Each entry is a draft snapshot. The editor owns the stack so the history survives redraws and resets it on submit
//! and on a draft override.

use super::draft::Draft;

/// Successive value-changing edits within this many milliseconds collapse into one undo step.
pub const UNDO_COALESCE_MS: u64 = 500;
/// How many steps are kept.
pub const UNDO_MAX: usize = 100;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UndoStack {
    past: Vec<Draft>,
    future: Vec<Draft>,
    last_push_at: u64,
    last_value: Option<String>,
}

impl UndoStack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn past_len(&self) -> usize {
        self.past.len()
    }

    pub fn future_len(&self) -> usize {
        self.future.len()
    }

    /// The snapshots of the past, oldest first.
    pub fn past(&self) -> &[Draft] {
        &self.past
    }

    /// The snapshots of the future, the next redo last.
    pub fn future(&self) -> &[Draft] {
        &self.future
    }

    fn push_past(&mut self, snapshot: Draft) {
        self.past.push(snapshot);
        if self.past.len() > UNDO_MAX {
            self.past.remove(0);
        }
    }

    /// Records a snapshot of the previous state before `next` is applied. A move of the caret or the selection (the value
    /// unchanged) is never a step, but it breaks the coalescing run so typing, a move and typing are two steps. Value edits
    /// within [`UNDO_COALESCE_MS`] keep only the first snapshot of the run, so one undo reverts the burst. `undo_break`
    /// forces a new step.
    pub fn record(&mut self, prev: &Draft, next: &Draft, undo_break: bool, now: u64) {
        if prev.value == next.value {
            self.last_push_at = 0;
            self.last_value = Some(next.value.clone());
            return;
        }
        let coalesce = !undo_break
            && !self.past.is_empty()
            && now.saturating_sub(self.last_push_at) < UNDO_COALESCE_MS
            && self.last_value.as_deref() == Some(prev.value.as_str());
        if !coalesce {
            self.push_past(prev.clone());
        }
        self.last_push_at = now;
        self.last_value = Some(next.value.clone());
        self.future.clear();
    }

    /// The draft to go back to, with `current` kept for a redo; none when there is no past.
    pub fn undo(&mut self, current: &Draft) -> Option<Draft> {
        let prev = self.past.pop()?;
        self.future.push(current.clone());
        self.last_push_at = 0;
        self.last_value = Some(prev.value.clone());
        Some(prev)
    }

    /// The draft to go forward to, with `current` kept for an undo; none when there is no future.
    pub fn redo(&mut self, current: &Draft) -> Option<Draft> {
        let next = self.future.pop()?;
        self.push_past(current.clone());
        self.last_push_at = 0;
        self.last_value = Some(next.value.clone());
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(value: &str) -> Draft {
        Draft::at_end(value)
    }

    #[test]
    fn typing_within_the_window_is_one_step() {
        let mut stack = UndoStack::new();
        stack.record(&d(""), &d("a"), false, 1_000);
        stack.record(&d("a"), &d("ab"), false, 1_100);
        stack.record(&d("ab"), &d("abc"), false, 1_200);
        assert_eq!(stack.past_len(), 1);
        assert_eq!(stack.undo(&d("abc")), Some(d("")));
        assert_eq!(stack.redo(&d("")), Some(d("abc")));
        assert_eq!(stack.undo(&d("abc")), Some(d("")));
        assert_eq!(stack.undo(&d("")), None);
    }

    #[test]
    fn a_pause_or_a_caret_move_or_a_break_starts_a_new_step() {
        let mut stack = UndoStack::new();
        stack.record(&d(""), &d("a"), false, 1_000);
        stack.record(&d("a"), &d("ab"), false, 1_600);
        assert_eq!(stack.past_len(), 2);
        stack.record(&d("ab"), &Draft::new("ab", 0, None), false, 1_650);
        stack.record(&d("ab"), &d("abc"), false, 1_700);
        assert_eq!(stack.past_len(), 3);
        stack.record(&d("abc"), &d("abcd"), true, 1_710);
        assert_eq!(stack.past_len(), 4);
    }

    #[test]
    fn an_edit_clears_the_redo_history_and_the_past_is_capped() {
        let mut stack = UndoStack::new();
        stack.record(&d(""), &d("a"), false, 1_000);
        stack.undo(&d("a"));
        assert_eq!(stack.future_len(), 1);
        stack.record(&d(""), &d("b"), false, 9_000);
        assert_eq!(stack.future_len(), 0);
        let mut capped = UndoStack::new();
        for step in 0..150u64 {
            capped.record(&d(&"x".repeat(step as usize)), &d(&"x".repeat(step as usize + 1)), true, step);
        }
        assert_eq!(capped.past_len(), UNDO_MAX);
        assert_eq!(capped.past()[0], d(&"x".repeat(50)));
    }

    #[test]
    fn a_first_edit_after_a_reset_is_never_coalesced() {
        let mut stack = UndoStack::new();
        stack.record(&d(""), &d("a"), false, 10);
        stack.reset();
        stack.record(&d(""), &d("z"), false, 20);
        assert_eq!(stack.past_len(), 1);
    }
}
