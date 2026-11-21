//! The line editor the REPL reads its prompt with (a history of 200), on the decoder of `mixdog-term`.
//!
//! Editing keys: Ctrl+A / Home, Ctrl+E / End, Ctrl+B / Left, Ctrl+F / Right, Alt+B / Alt+F and Ctrl+Left / Ctrl+Right (a word),
//! Ctrl+K (to the end) and Ctrl+U (to the start) into the kill ring, Ctrl+Y (yank) and Alt+Y (yank pop), Ctrl+W / Ctrl+Backspace /
//! Alt+Backspace (the word before), Alt+D / Alt+Delete / Ctrl+Delete (the word after), Ctrl+Shift+Backspace / Ctrl+Shift+Delete
//! (to the start / the end), Ctrl+H / Backspace, Delete, Ctrl+D (delete at the cursor, end of input on an empty line), Ctrl+_
//! (undo) and Ctrl+^ (redo), Ctrl+T (transpose), Ctrl+L (clear the screen), Up / Ctrl+P and Down / Ctrl+N (the history of the
//! session; Up and Down search the history for the text before the cursor), Tab (a tab character: there is no completer), Enter,
//! and a bracketed paste. Ctrl+C is not an edit: the REPL's SIGINT handler ends the process, so the editor reports it as
//! [`Effect::Interrupt`].
//!
//! [`LineEditor::apply`] takes one decoded event and says what the REPL must do; [`LineEditor::paint`] rewrites the prompt row
//! (and the rows a pasted or wrapped line takes) in place.

use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_term::InputEvent;
use mixdog_term::KeyFlags;
use mixdog_termtext::display_width;
use mixdog_termtext::grapheme::graphemes_with_widths;
use mixdog_termtext::grapheme::next_boundary;
use mixdog_termtext::grapheme::prev_boundary;
use mixdog_termtext::strip_ansi;

/// `historySize: 200`.
pub const HISTORY_SIZE: usize = 200;

/// `kMaxLengthOfKillRing`.
const KILL_RING_SIZE: usize = 32;

/// `kMaxUndoRedoStackSize`.
const UNDO_SIZE: usize = 2048;

/// The width of a tab stop on the terminal.
const TAB_STOP: usize = 8;

/// What the REPL does after an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// The line changed: paint it again.
    Redraw,
    /// Enter: the line is ready; [`LineEditor::take`] hands it over.
    Submit,
    /// Ctrl+C.
    Interrupt,
    /// Ctrl+D on an empty line.
    Eof,
    /// Ctrl+L: clear the screen, then paint the prompt.
    ClearScreen,
}

/// The line being edited and the history of the session.
#[derive(Debug, Default)]
pub struct LineEditor {
    line: String,
    /// Byte offset of the cursor in `line`, on a cluster boundary.
    cursor: usize,
    /// The lines entered, the newest first (`rl.history`).
    history: Vec<String>,
    /// The history entry on show (`historyIndex`); none is `-1`, `Some(history.len())` the search text past the oldest.
    history_index: Option<usize>,
    /// The text before the cursor when Up or Down began a history walk (`kSubstringSearch`).
    search: Option<String>,
    /// Killed text, the newest first, and the entry the next yank takes.
    kill_ring: Vec<String>,
    kill_ring_cursor: usize,
    /// The last key was a yank (or a yank pop).
    yanking: bool,
    /// The line and cursor before each edit, and the ones undone.
    undo: Vec<(String, usize)>,
    redo: Vec<(String, usize)>,
    /// The row of the cursor below the first row of the prompt, as the last paint left it.
    cursor_row: usize,
}

/// `\w`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The end of the run of `chars` from `at` whose characters satisfy `keep`.
fn skip(text: &str, at: usize, keep: impl Fn(char) -> bool) -> usize {
    text[at..].char_indices().find(|(_, c)| !keep(*c)).map_or(text.len(), |(offset, _)| at + offset)
}

/// The start of the run of characters before `at` that satisfy `keep`.
fn skip_back(text: &str, at: usize, keep: impl Fn(char) -> bool) -> usize {
    text[..at].char_indices().rev().find(|(_, c)| !keep(*c)).map_or(0, |(offset, c)| offset + c.len_utf8())
}

/// `/^\s*(?:[^\w\s]+|\w+)?/` over the reversed text before `at`: the start of the word before the cursor.
fn word_left(text: &str, at: usize) -> usize {
    let at = skip_back(text, at, is_js_space);
    match text[..at].chars().next_back() {
        Some(c) if is_word(c) => skip_back(text, at, is_word),
        Some(_) => skip_back(text, at, |c| !is_word(c) && !is_js_space(c)),
        None => at,
    }
}

/// `/^(?:\s+|[^\w\s]+|\w+)\s*/` over the text after `at`: where a word move to the right lands.
fn word_right(text: &str, at: usize) -> usize {
    let end = match text[at..].chars().next() {
        Some(c) if is_js_space(c) => skip(text, at, is_js_space),
        Some(c) if is_word(c) => skip(text, at, is_word),
        Some(_) => skip(text, at, |c| !is_word(c) && !is_js_space(c)),
        None => at,
    };
    skip(text, end, is_js_space)
}

/// `/^(?:\s+|\W+|\w+)\s*/` over the text after `at`: the end of the word a forward word delete takes.
fn word_right_delete(text: &str, at: usize) -> usize {
    let end = match text[at..].chars().next() {
        Some(c) if is_js_space(c) => skip(text, at, is_js_space),
        Some(c) if is_word(c) => skip(text, at, is_word),
        Some(_) => skip(text, at, |c| !is_word(c)),
        None => at,
    };
    skip(text, end, is_js_space)
}

impl LineEditor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The line as typed.
    pub fn line(&self) -> &str {
        &self.line
    }

    pub fn is_empty(&self) -> bool {
        self.line.is_empty()
    }

    /// The history, the newest line first.
    pub fn history(&self) -> &[String] {
        &self.history
    }

    /// `kBeforeEdit`: the line and cursor before an edit go on the undo stack.
    fn before_edit(&mut self) {
        self.undo.push((self.line.clone(), self.cursor));
        if self.undo.len() > UNDO_SIZE {
            self.undo.remove(0);
        }
    }

    /// `kInsertString`.
    fn insert(&mut self, text: &str) {
        self.before_edit();
        self.line.insert_str(self.cursor, text);
        self.cursor += text.len();
    }

    fn delete_range(&mut self, from: usize, to: usize) {
        self.line.replace_range(from..to, "");
        self.cursor = from;
    }

    /// `kDeleteLeft`.
    fn delete_left(&mut self) {
        if self.cursor > 0 && !self.line.is_empty() {
            self.before_edit();
            let from = prev_boundary(&self.line, self.cursor);
            self.delete_range(from, self.cursor);
        }
    }

    /// `kDeleteRight`.
    fn delete_right(&mut self) {
        if self.cursor < self.line.len() {
            self.before_edit();
            let to = next_boundary(&self.line, self.cursor);
            self.line.replace_range(self.cursor..to, "");
        }
    }

    /// `kDeleteWordLeft`.
    fn delete_word_left(&mut self) {
        if self.cursor > 0 {
            self.before_edit();
            let from = word_left(&self.line, self.cursor);
            self.delete_range(from, self.cursor);
        }
    }

    /// `kDeleteWordRight`.
    fn delete_word_right(&mut self) {
        if self.cursor < self.line.len() {
            self.before_edit();
            let to = word_right_delete(&self.line, self.cursor);
            self.line.replace_range(self.cursor..to, "");
        }
    }

    /// `kDeleteLineLeft`: the text before the cursor goes to the kill ring.
    fn delete_line_left(&mut self) {
        self.before_edit();
        let killed: String = self.line.drain(..self.cursor).collect();
        self.cursor = 0;
        self.push_kill(killed);
    }

    /// `kDeleteLineRight`: the text after the cursor goes to the kill ring.
    fn delete_line_right(&mut self) {
        self.before_edit();
        let killed = self.line.split_off(self.cursor);
        self.push_kill(killed);
    }

    /// `kPushToKillRing`.
    fn push_kill(&mut self, killed: String) {
        if killed.is_empty() || self.kill_ring.first() == Some(&killed) {
            return;
        }
        self.kill_ring.insert(0, killed);
        self.kill_ring_cursor = 0;
        self.kill_ring.truncate(KILL_RING_SIZE);
    }

    /// `kYank`.
    fn yank(&mut self) {
        if let Some(text) = self.kill_ring.get(self.kill_ring_cursor).cloned() {
            self.yanking = true;
            self.insert(&text);
        }
    }

    /// `kYankPop`: the text the last yank inserted is replaced by the next older entry of the ring.
    fn yank_pop(&mut self) {
        if !self.yanking || self.kill_ring.len() < 2 {
            return;
        }
        let last = self.kill_ring[self.kill_ring_cursor].len();
        self.kill_ring_cursor = (self.kill_ring_cursor + 1) % self.kill_ring.len();
        let current = self.kill_ring[self.kill_ring_cursor].clone();
        let head = self.cursor.saturating_sub(last);
        self.line.replace_range(head..self.cursor, &current);
        self.cursor = head + current.len();
    }

    /// `kUndo`.
    fn undo(&mut self) {
        if let Some((line, cursor)) = self.undo.pop() {
            self.redo.push((std::mem::replace(&mut self.line, line), self.cursor));
            self.cursor = cursor;
        }
    }

    /// `kRedo`.
    fn redo(&mut self) {
        if let Some((line, cursor)) = self.redo.pop() {
            self.undo.push((std::mem::replace(&mut self.line, line), self.cursor));
            self.cursor = cursor;
        }
    }

    fn transpose(&mut self) {
        if self.line.is_empty() || self.cursor == 0 {
            return;
        }
        // At the end of the line the two clusters before the cursor trade places, elsewhere the one before and the one at it.
        let at = if self.cursor == self.line.len() { prev_boundary(&self.line, self.cursor) } else { self.cursor };
        let before = prev_boundary(&self.line, at);
        let after = next_boundary(&self.line, at);
        if before == at || after == at {
            return;
        }
        self.before_edit();
        let (first, second) = (self.line[before..at].to_owned(), self.line[at..after].to_owned());
        self.line.replace_range(before..after, &format!("{second}{first}"));
        self.cursor = after;
    }

    /// Shows the history entry `index` (the search text when it is past either end).
    fn show_history(&mut self, index: Option<usize>, search: &str) {
        let text = match index {
            Some(index) if index < self.history.len() => self.history[index].clone(),
            _ => search.to_owned(),
        };
        self.line = text;
        self.cursor = self.line.len();
        self.history_index = index;
    }

    /// `kHistoryPrev`: the next older entry that starts with the search text and differs from the line.
    fn history_prev(&mut self) {
        let next = self.history_index.map_or(0, |index| index + 1);
        if next > self.history.len() || self.history.is_empty() {
            return;
        }
        self.before_edit();
        let search = self.search.clone().unwrap_or_default();
        let mut index = next;
        while index < self.history.len() && (!self.history[index].starts_with(&search) || self.line == self.history[index]) {
            index += 1;
        }
        self.show_history(Some(index), &search);
    }

    /// `kHistoryNext`: the next newer entry that starts with the search text and differs from the line; past the newest the
    /// search text itself.
    fn history_next(&mut self) {
        let Some(current) = self.history_index else { return };
        self.before_edit();
        let search = self.search.clone().unwrap_or_default();
        let mut index = current.checked_sub(1);
        while let Some(at) = index
            && (!self.history[at].starts_with(&search) || self.line == self.history[at])
        {
            index = at.checked_sub(1);
        }
        self.show_history(index, &search);
    }

    /// `kLine` and `kAddHistory`: the line as typed, taken out of the editor. A line with words goes to the history unless it is
    /// the newest entry already; an empty or blank one does not, and leaves the history walk where it was.
    pub fn take(&mut self) -> String {
        let line = std::mem::take(&mut self.line);
        self.cursor = 0;
        self.undo.clear();
        self.redo.clear();
        if js_trim(&line).is_empty() {
            return line;
        }
        if self.history.first() != Some(&line) {
            self.history.insert(0, line.clone());
            self.history.truncate(HISTORY_SIZE);
        }
        self.history_index = None;
        line
    }

    fn move_to(&mut self, at: usize) -> Vec<Effect> {
        let moved = at != self.cursor;
        self.cursor = at;
        if moved { vec![Effect::Redraw] } else { Vec::new() }
    }

    fn key(&mut self, input: &str, key: &KeyFlags) -> Vec<Effect> {
        let lower = input.to_lowercase();
        if !(key.meta && lower == "y") {
            self.yanking = false;
        }
        // Up and Down (without a modifier) walk the history matching the text before the cursor; any other key ends the walk's
        // search.
        if (key.up_arrow || key.down_arrow) && !key.ctrl && !key.meta && !key.shift {
            if self.search.is_none() {
                self.search = Some(self.line[..self.cursor].to_owned());
            }
        } else if self.search.take().is_some() && self.history_index == Some(self.history.len()) {
            self.history_index = None;
        }
        match input {
            "\u{1f}" => {
                self.undo();
                return vec![Effect::Redraw];
            }
            "\u{1e}" => {
                self.redo();
                return vec![Effect::Redraw];
            }
            _ => {}
        }
        if key.escape {
            return Vec::new();
        }
        if key.return_key || (key.ctrl && matches!(lower.as_str(), "j" | "m")) {
            return vec![Effect::Submit];
        }
        if key.ctrl && key.shift && (key.backspace || key.delete) {
            if key.backspace {
                self.delete_line_left();
            } else {
                self.delete_line_right();
            }
            return vec![Effect::Redraw];
        }
        if key.ctrl {
            if key.backspace {
                self.delete_word_left();
            } else if key.delete {
                self.delete_word_right();
            } else if key.left_arrow {
                return self.move_to(word_left(&self.line, self.cursor));
            } else if key.right_arrow {
                return self.move_to(word_right(&self.line, self.cursor));
            } else {
                match lower.as_str() {
                    "c" => return vec![Effect::Interrupt],
                    "d" if self.line.is_empty() => return vec![Effect::Eof],
                    "d" => self.delete_right(),
                    "h" => self.delete_left(),
                    "u" => self.delete_line_left(),
                    "k" => self.delete_line_right(),
                    "a" => return self.move_to(0),
                    "e" => return self.move_to(self.line.len()),
                    "b" => return self.move_to(prev_boundary(&self.line, self.cursor)),
                    "f" => return self.move_to(next_boundary(&self.line, self.cursor)),
                    "l" => return vec![Effect::ClearScreen],
                    "n" => self.history_next(),
                    "p" => self.history_prev(),
                    "y" => self.yank(),
                    "w" => self.delete_word_left(),
                    "t" => self.transpose(),
                    _ => return Vec::new(),
                }
            }
            return vec![Effect::Redraw];
        }
        if key.meta {
            if key.backspace {
                self.delete_word_left();
            } else if key.delete {
                self.delete_word_right();
            } else {
                match lower.as_str() {
                    "b" => return self.move_to(word_left(&self.line, self.cursor)),
                    "f" => return self.move_to(word_right(&self.line, self.cursor)),
                    "d" => self.delete_word_right(),
                    "y" => self.yank_pop(),
                    _ => return Vec::new(),
                }
            }
            return vec![Effect::Redraw];
        }
        if key.backspace {
            self.delete_left();
        } else if key.delete {
            self.delete_right();
        } else if key.left_arrow {
            return self.move_to(prev_boundary(&self.line, self.cursor));
        } else if key.right_arrow {
            return self.move_to(next_boundary(&self.line, self.cursor));
        } else if key.home {
            return self.move_to(0);
        } else if key.end {
            return self.move_to(self.line.len());
        } else if key.up_arrow {
            self.history_prev();
        } else if key.down_arrow {
            self.history_next();
        } else if key.tab {
            // No completer: the tab is typed.
            self.insert("\t");
        } else if key.page_up || key.page_down {
            return Vec::new();
        } else {
            let typed: String = input.chars().filter(|c| !c.is_control()).collect();
            if typed.is_empty() {
                return Vec::new();
            }
            self.insert(&typed);
        }
        vec![Effect::Redraw]
    }

    /// One decoded event of the terminal.
    pub fn apply(&mut self, event: &InputEvent) -> Vec<Effect> {
        match event {
            InputEvent::Key { input, key } => self.key(input, key),
            InputEvent::Paste(text) => {
                self.yanking = false;
                if self.search.take().is_some() && self.history_index == Some(self.history.len()) {
                    self.history_index = None;
                }
                let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
                let kept: String = normalized.chars().filter(|c| matches!(c, '\n' | '\t') || !c.is_control()).collect();
                if kept.is_empty() {
                    return Vec::new();
                }
                self.insert(&kept);
                vec![Effect::Redraw]
            }
            InputEvent::Mouse(_) | InputEvent::Focus(_) => Vec::new(),
        }
    }

    /// The prompt row and the line, drawn again over what the last paint drew: the cursor goes back to the first row of the
    /// prompt, everything below it is cleared, and the cursor ends where the editor's is. A line that fills the last column
    /// leaves the terminal waiting to wrap: the cursor stays on that row and the next character wraps by itself.
    pub fn paint(&mut self, prompt: &str, columns: usize) -> String {
        let columns = columns.max(1);
        let start = display_width(&strip_ansi(prompt));
        let mut out = String::new();
        if self.cursor_row > 0 {
            out.push_str(&format!("\x1b[{}A", self.cursor_row));
        }
        out.push_str("\r\x1b[0J");
        out.push_str(prompt);
        out.push_str(&self.line.replace('\n', "\r\n"));
        let end = locate(start, &self.line, columns);
        let last = end.row - usize::from(end.pending);
        if self.cursor < self.line.len() {
            let at = locate(start, &self.line[..self.cursor], columns);
            if last > at.row {
                out.push_str(&format!("\x1b[{}A", last - at.row));
            }
            out.push('\r');
            if at.column > 0 {
                out.push_str(&format!("\x1b[{}C", at.column));
            }
            self.cursor_row = at.row;
        } else {
            self.cursor_row = last;
        }
        out
    }

    /// Enter: the cursor goes below the line, which stays on screen, and the next paint starts on a fresh row.
    pub fn finish_line(&mut self, prompt: &str, columns: usize) -> String {
        let start = display_width(&strip_ansi(prompt));
        let end = locate(start, &self.line, columns.max(1));
        let last = end.row - usize::from(end.pending);
        let mut out = String::new();
        if last > self.cursor_row {
            out.push_str(&format!("\x1b[{}B", last - self.cursor_row));
        }
        out.push_str("\r\n");
        self.cursor_row = 0;
        out
    }

    /// Ctrl+L: the screen is cleared and the next paint starts at its top.
    pub fn clear_screen(&mut self) -> String {
        self.cursor_row = 0;
        "\x1b[1;1H\x1b[0J".to_owned()
    }
}

/// Where the next character goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Place {
    row: usize,
    column: usize,
    /// The row is full and the terminal waits for the next character to wrap.
    pending: bool,
}

/// The place after `text` written from column `start` of the first row of a terminal `columns` wide; a character that does not
/// fit the row starts the next one, and a tab moves to the next tab stop without leaving the row.
fn locate(start: usize, text: &str, columns: usize) -> Place {
    let mut row = start / columns;
    let mut column = start % columns;
    for cluster in graphemes_with_widths(text) {
        if cluster.text == "\n" || cluster.text == "\r\n" {
            row += 1;
            column = 0;
            continue;
        }
        if cluster.text == "\t" {
            let stop = (column / TAB_STOP + 1) * TAB_STOP;
            column = if stop < columns { stop } else { column.max(columns - 1) };
            continue;
        }
        if column + cluster.width > columns {
            row += 1;
            column = 0;
        }
        column += cluster.width;
    }
    if column >= columns { Place { row: row + 1, column: 0, pending: true } } else { Place { row, column, pending: false } }
}

#[cfg(test)]
mod tests {
    use mixdog_term::testing::VtGrid;

    use super::*;

    fn key(input: &str, set: impl FnOnce(&mut KeyFlags)) -> InputEvent {
        let mut flags = KeyFlags::default();
        set(&mut flags);
        InputEvent::Key { input: input.to_owned(), key: flags }
    }

    fn type_text(editor: &mut LineEditor, text: &str) {
        editor.apply(&key(text, |_| {}));
    }

    fn ctrl(editor: &mut LineEditor, letter: &str) -> Vec<Effect> {
        editor.apply(&key(letter, |flags| flags.ctrl = true))
    }

    fn meta(editor: &mut LineEditor, letter: &str) -> Vec<Effect> {
        editor.apply(&key(letter, |flags| flags.meta = true))
    }

    fn named(editor: &mut LineEditor, set: impl FnOnce(&mut KeyFlags)) -> Vec<Effect> {
        editor.apply(&key("", set))
    }

    fn enter(editor: &mut LineEditor, line: &str) -> String {
        type_text(editor, line);
        assert_eq!(named(editor, |flags| flags.return_key = true), vec![Effect::Submit]);
        editor.take()
    }

    #[test]
    fn typed_text_lands_at_the_cursor_and_the_emacs_keys_move_and_cut() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "hello world");
        ctrl(&mut editor, "a");
        type_text(&mut editor, ">");
        assert_eq!(editor.line(), ">hello world");
        ctrl(&mut editor, "e");
        ctrl(&mut editor, "b");
        ctrl(&mut editor, "b");
        type_text(&mut editor, "_");
        assert_eq!(editor.line(), ">hello wor_ld");
        ctrl(&mut editor, "k");
        assert_eq!(editor.line(), ">hello wor_");
        ctrl(&mut editor, "w");
        assert_eq!(editor.line(), ">hello ");
        ctrl(&mut editor, "u");
        assert_eq!(editor.line(), "");
        type_text(&mut editor, "ab");
        ctrl(&mut editor, "h");
        assert_eq!(editor.line(), "a");
        ctrl(&mut editor, "a");
        ctrl(&mut editor, "d");
        assert_eq!(editor.line(), "");
        assert_eq!(ctrl(&mut editor, "d"), vec![Effect::Eof]);
        assert_eq!(ctrl(&mut editor, "c"), vec![Effect::Interrupt]);
    }

    #[test]
    fn words_are_runs_of_word_characters_or_of_punctuation_as_readline_matches_them() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "alpha beta gamma");
        named(&mut editor, |flags| flags.left_arrow = true);
        named(&mut editor, |flags| {
            flags.left_arrow = true;
            flags.ctrl = true;
        });
        type_text(&mut editor, "|");
        assert_eq!(editor.line(), "alpha beta |gamma");
        meta(&mut editor, "b");
        meta(&mut editor, "d");
        assert_eq!(editor.line(), "alpha beta gamma");
        meta(&mut editor, "d");
        assert_eq!(editor.line(), "alpha beta ");
        let mut path = LineEditor::new();
        type_text(&mut path, "cd foo.bar/baz");
        ctrl(&mut path, "w");
        assert_eq!(path.line(), "cd foo.bar/");
        ctrl(&mut path, "w");
        assert_eq!(path.line(), "cd foo.bar");
        named(&mut path, |flags| flags.home = true);
        meta(&mut path, "f");
        meta(&mut path, "f");
        type_text(&mut path, "^");
        assert_eq!(path.line(), "cd foo^.bar");
        named(&mut path, |flags| flags.home = true);
        named(&mut path, |flags| flags.delete = true);
        assert_eq!(path.line(), "d foo^.bar");
        named(&mut path, |flags| flags.end = true);
        named(&mut path, |flags| flags.backspace = true);
        assert_eq!(path.line(), "d foo^.ba");
        named(&mut path, |flags| {
            flags.backspace = true;
            flags.ctrl = true;
            flags.shift = true;
        });
        assert_eq!(path.line(), "");
    }

    #[test]
    fn transpose_and_a_tab_typed_as_a_tab() {
        let mut swap = LineEditor::new();
        type_text(&mut swap, "abc");
        ctrl(&mut swap, "t");
        assert_eq!(swap.line(), "acb");
        named(&mut swap, |flags| flags.tab = true);
        assert_eq!(swap.line(), "acb\t");
        assert_eq!(locate(2, "acb\t", 20), Place { row: 0, column: 8, pending: false });
        // A tab never wraps: it stops at the last column, where the next character is written and the row waits to wrap.
        assert_eq!(locate(2, "acb\tx", 6), Place { row: 1, column: 0, pending: true });
    }

    #[test]
    fn killed_text_is_yanked_back_and_a_yank_pop_takes_the_older_kill() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "one two");
        ctrl(&mut editor, "w");
        assert_eq!(editor.line(), "one ");
        ctrl(&mut editor, "u");
        type_text(&mut editor, "three");
        ctrl(&mut editor, "a");
        ctrl(&mut editor, "k");
        assert_eq!(editor.line(), "");
        ctrl(&mut editor, "y");
        assert_eq!(editor.line(), "three");
        meta(&mut editor, "y");
        assert_eq!(editor.line(), "one ");
        meta(&mut editor, "y");
        assert_eq!(editor.line(), "three");
        type_text(&mut editor, "!");
        meta(&mut editor, "y");
        assert_eq!(editor.line(), "three!");
    }

    #[test]
    fn undo_and_redo_walk_the_edits_of_the_line() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "ab");
        type_text(&mut editor, "c");
        named(&mut editor, |flags| flags.backspace = true);
        assert_eq!(editor.line(), "ab");
        type_text(&mut editor, "\u{1f}");
        assert_eq!(editor.line(), "abc");
        type_text(&mut editor, "\u{1f}");
        assert_eq!(editor.line(), "ab");
        type_text(&mut editor, "\u{1e}");
        assert_eq!(editor.line(), "abc");
        enter(&mut editor, "");
        type_text(&mut editor, "\u{1f}");
        assert_eq!(editor.line(), "");
    }

    #[test]
    fn enter_submits_into_a_history_that_up_and_down_walk() {
        let mut editor = LineEditor::new();
        for line in ["one", "two", "two", "", "   "] {
            assert_eq!(enter(&mut editor, line), line);
        }
        assert_eq!(editor.history(), ["two", "one"]);
        assert!(editor.is_empty());
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "two");
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "one");
        // Past the oldest entry the line is the search text (empty here); Down comes back.
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "one");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "two");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "");
        ctrl(&mut editor, "p");
        assert_eq!(editor.line(), "two");
    }

    #[test]
    fn up_searches_the_history_for_the_text_before_the_cursor() {
        let mut editor = LineEditor::new();
        for line in ["git status", "ls", "git log", "cargo test"] {
            enter(&mut editor, line);
        }
        type_text(&mut editor, "git");
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "git log");
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "git status");
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "git");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "git status");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "git log");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "git");
    }

    #[test]
    fn the_history_keeps_the_last_two_hundred_lines() {
        let mut editor = LineEditor::new();
        for number in 0..HISTORY_SIZE + 5 {
            enter(&mut editor, &number.to_string());
        }
        assert_eq!((editor.history().len(), editor.history()[HISTORY_SIZE - 1].as_str()), (HISTORY_SIZE, "5"));
    }

    #[test]
    fn a_paste_is_inserted_whole_with_its_line_breaks_and_tabs() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "a");
        assert_eq!(editor.apply(&InputEvent::Paste("x\r\ny\u{1b}z\tw".to_owned())), vec![Effect::Redraw]);
        assert_eq!(editor.line(), "ax\nyz\tw");
        assert!(editor.apply(&InputEvent::Paste(String::new())).is_empty());
        assert_eq!(named(&mut editor, |flags| flags.return_key = true), vec![Effect::Submit]);
        assert_eq!(editor.take(), "ax\nyz\tw");
    }

    /// The screen after the paints of an editor.
    fn screen(width: u16, height: u16, paints: &[String]) -> VtGrid {
        let mut grid = VtGrid::new(width, height);
        for paint in paints {
            grid.feed(paint.as_bytes());
        }
        grid
    }

    #[test]
    fn a_paint_draws_the_prompt_and_the_line_and_leaves_the_cursor_where_the_editor_is() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "hello");
        let first = editor.paint("> ", 20);
        ctrl(&mut editor, "b");
        ctrl(&mut editor, "b");
        let second = editor.paint("> ", 20);
        let grid = screen(20, 5, &[first, second]);
        assert_eq!(grid.row_text(0), "> hello");
        assert_eq!(grid.cursor(), (5, 0));
    }

    #[test]
    fn a_line_wider_than_the_terminal_wraps_and_is_rewritten_over_its_rows() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "abcdefghij");
        let first = editor.paint("> ", 6);
        type_text(&mut editor, "kl");
        let second = editor.paint("> ", 6);
        let grid = screen(6, 6, &[first, second]);
        assert_eq!((grid.row_text(0), grid.row_text(1), grid.row_text(2)), ("> abcd".to_owned(), "efghij".to_owned(), "kl".to_owned()));
        assert_eq!(grid.cursor(), (2, 2));
        // A line that fills the last column leaves the terminal waiting to wrap: the next paint still starts at the first row.
        let mut full = LineEditor::new();
        type_text(&mut full, "abcd");
        let first = full.paint("> ", 6);
        type_text(&mut full, "e");
        let grid = screen(6, 4, &[first, full.paint("> ", 6)]);
        assert_eq!((grid.row_text(0), grid.row_text(1), grid.cursor()), ("> abcd".to_owned(), "e".to_owned(), (1, 1)));
    }

    #[test]
    fn finishing_a_line_moves_below_it_and_a_cursor_in_the_middle_of_a_wrapped_line_is_placed() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "abcdefghij");
        named(&mut editor, |flags| flags.home = true);
        let paint = editor.paint("> ", 6);
        let grid = screen(6, 6, &[paint.clone()]);
        assert_eq!(grid.cursor(), (2, 0));
        let finish = editor.finish_line("> ", 6);
        let grid = screen(6, 6, &[paint, finish]);
        assert_eq!(grid.cursor(), (0, 2));
        assert_eq!(grid.row_text(1), "efghij");
    }

    #[test]
    fn wide_characters_count_two_columns_and_do_not_split() {
        assert_eq!(locate(2, "\u{d55c}\u{ae00}", 6), Place { row: 1, column: 0, pending: true });
        assert_eq!(locate(2, "a\u{d55c}\u{ae00}", 6), Place { row: 1, column: 2, pending: false });
        assert_eq!(locate(0, "ab\ncd", 10), Place { row: 1, column: 2, pending: false });
    }
}
