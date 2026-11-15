//! The line editor the REPL reads its prompt with: what Node's `readline` interface gave `repl.mjs` (`createInterface` with a
//! prompt and a history of 200), on the decoder of `mixdog-term`.
//!
//! Editing keys: Ctrl+A / Home, Ctrl+E / End, Ctrl+B / Left, Ctrl+F / Right, Alt+B / Alt+F and Ctrl+Left / Ctrl+Right (a word),
//! Ctrl+K (to the end), Ctrl+U (to the start), Ctrl+W / Alt+Backspace (the word before), Alt+D (the word after), Ctrl+H /
//! Backspace, Delete, Ctrl+D (delete at the cursor, end of input on an empty line), Ctrl+T (transpose), Ctrl+L (clear the
//! screen), Up / Ctrl+P and Down / Ctrl+N (the history of the session), Enter, and a bracketed paste. Ctrl+C is not an edit:
//! the REPL's SIGINT handler ends the process, so the editor reports it as [`Effect::Interrupt`].
//!
//! The editor is a state machine: [`LineEditor::apply`] takes one decoded event and says what the REPL must do; the screen is
//! drawn by [`LineEditor::paint`], which rewrites the prompt row (and the rows a pasted or wrapped line takes) in place.

use mixdog_term::InputEvent;
use mixdog_term::KeyFlags;
use mixdog_termtext::display_width;
use mixdog_termtext::grapheme::graphemes_with_widths;
use mixdog_termtext::grapheme::next_boundary;
use mixdog_termtext::grapheme::prev_boundary;
use mixdog_termtext::strip_ansi;

/// `historySize: 200`.
pub const HISTORY_SIZE: usize = 200;

/// The width of a tab stop (`kTabSize`).
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
    /// The lines entered, the oldest first.
    history: Vec<String>,
    /// The history entry on show.
    recall: Option<usize>,
    /// The row of the cursor below the first row of the prompt, as the last paint left it.
    cursor_row: usize,
}

fn is_space(c: char) -> bool {
    c.is_whitespace()
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

    /// The history, the oldest line first.
    pub fn history(&self) -> &[String] {
        &self.history
    }

    fn set_line(&mut self, text: &str) {
        self.line = text.to_owned();
        self.cursor = self.line.len();
    }

    fn insert(&mut self, text: &str) {
        self.line.insert_str(self.cursor, text);
        self.cursor += text.len();
    }

    /// The byte offset of the start of the word before `at`: white space is skipped, then the word.
    fn word_before(&self, at: usize) -> usize {
        let head = &self.line[..at];
        let trimmed = head.trim_end_matches(is_space);
        trimmed.trim_end_matches(|c| !is_space(c)).len()
    }

    /// The byte offset of the end of the word after `at`: white space is skipped, then the word.
    fn word_after(&self, at: usize) -> usize {
        let tail = &self.line[at..];
        let after_space = tail.trim_start_matches(is_space);
        let after_word = after_space.trim_start_matches(|c| !is_space(c));
        self.line.len() - after_word.len()
    }

    fn delete_range(&mut self, from: usize, to: usize) {
        self.line.replace_range(from..to, "");
        self.cursor = from;
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
        let (first, second) = (self.line[before..at].to_owned(), self.line[at..after].to_owned());
        self.line.replace_range(before..after, &format!("{second}{first}"));
        self.cursor = after;
    }

    fn history_prev(&mut self) -> bool {
        let next = match self.recall {
            None if self.history.is_empty() => return false,
            None => self.history.len() - 1,
            Some(0) => return false,
            Some(index) => index - 1,
        };
        self.recall = Some(next);
        let entry = self.history[next].clone();
        self.set_line(&entry);
        true
    }

    fn history_next(&mut self) -> bool {
        match self.recall {
            None => false,
            Some(index) if index + 1 < self.history.len() => {
                self.recall = Some(index + 1);
                let entry = self.history[index + 1].clone();
                self.set_line(&entry);
                true
            }
            Some(_) => {
                self.recall = None;
                self.set_line("");
                true
            }
        }
    }

    /// The line as typed, taken out of the editor: it goes to the history (not when empty or the same as the last one).
    pub fn take(&mut self) -> String {
        let line = std::mem::take(&mut self.line);
        self.cursor = 0;
        self.recall = None;
        if !line.is_empty() && self.history.last() != Some(&line) {
            self.history.push(line.clone());
            if self.history.len() > HISTORY_SIZE {
                self.history.remove(0);
            }
        }
        line
    }

    fn redraw(changed: bool) -> Vec<Effect> {
        if changed { vec![Effect::Redraw] } else { Vec::new() }
    }

    fn key(&mut self, input: &str, key: &KeyFlags) -> Vec<Effect> {
        let lower = input.to_lowercase();
        let word = key.meta || key.ctrl;
        if key.return_key || (key.ctrl && matches!(lower.as_str(), "j" | "m")) {
            return vec![Effect::Submit];
        }
        if key.ctrl && !key.meta && !key.backspace && !key.delete && !key.left_arrow && !key.right_arrow {
            return match lower.as_str() {
                "c" => vec![Effect::Interrupt],
                "d" if self.line.is_empty() => vec![Effect::Eof],
                "d" => {
                    if self.cursor < self.line.len() {
                        let to = next_boundary(&self.line, self.cursor);
                        self.delete_range(self.cursor, to);
                    }
                    Self::redraw(true)
                }
                "a" => self.move_to(0),
                "e" => self.move_to(self.line.len()),
                "b" => self.move_to(prev_boundary(&self.line, self.cursor)),
                "f" => self.move_to(next_boundary(&self.line, self.cursor)),
                "k" => {
                    self.line.truncate(self.cursor);
                    Self::redraw(true)
                }
                "u" => {
                    self.delete_range(0, self.cursor);
                    Self::redraw(true)
                }
                "w" => {
                    let from = self.word_before(self.cursor);
                    self.delete_range(from, self.cursor);
                    Self::redraw(true)
                }
                "h" => self.backspace(),
                "t" => {
                    self.transpose();
                    Self::redraw(true)
                }
                "l" => vec![Effect::ClearScreen],
                "p" => Self::redraw(self.history_prev()),
                "n" => Self::redraw(self.history_next()),
                _ => Vec::new(),
            };
        }
        if key.backspace {
            if word {
                let from = self.word_before(self.cursor);
                self.delete_range(from, self.cursor);
                return Self::redraw(true);
            }
            return self.backspace();
        }
        if key.delete {
            if word {
                let to = self.word_after(self.cursor);
                self.delete_range(self.cursor, to);
            } else if self.cursor < self.line.len() {
                let to = next_boundary(&self.line, self.cursor);
                self.delete_range(self.cursor, to);
            }
            return Self::redraw(true);
        }
        if key.left_arrow {
            return self.move_to(if word { self.word_before(self.cursor) } else { prev_boundary(&self.line, self.cursor) });
        }
        if key.right_arrow {
            return self.move_to(if word { self.word_after(self.cursor) } else { next_boundary(&self.line, self.cursor) });
        }
        if key.home {
            return self.move_to(0);
        }
        if key.end {
            return self.move_to(self.line.len());
        }
        if key.up_arrow {
            return Self::redraw(self.history_prev());
        }
        if key.down_arrow {
            return Self::redraw(self.history_next());
        }
        if key.meta {
            return match lower.as_str() {
                "b" => self.move_to(self.word_before(self.cursor)),
                "f" => self.move_to(self.word_after(self.cursor)),
                "d" => {
                    let to = self.word_after(self.cursor);
                    self.delete_range(self.cursor, to);
                    Self::redraw(true)
                }
                _ => Vec::new(),
            };
        }
        if key.tab {
            // No completer: a tab is spaces up to the next tab stop.
            let column = display_width(&self.line[..self.cursor]);
            self.insert(&" ".repeat(TAB_STOP - column % TAB_STOP));
            return Self::redraw(true);
        }
        if key.escape || key.page_up || key.page_down || key.ctrl {
            return Vec::new();
        }
        let typed: String = input.chars().filter(|c| !c.is_control()).collect();
        if typed.is_empty() {
            return Vec::new();
        }
        self.insert(&typed);
        Self::redraw(true)
    }

    fn move_to(&mut self, at: usize) -> Vec<Effect> {
        let moved = at != self.cursor;
        self.cursor = at;
        Self::redraw(moved)
    }

    fn backspace(&mut self) -> Vec<Effect> {
        if self.cursor > 0 {
            let from = prev_boundary(&self.line, self.cursor);
            self.delete_range(from, self.cursor);
        }
        Self::redraw(true)
    }

    /// One decoded event of the terminal.
    pub fn apply(&mut self, event: &InputEvent) -> Vec<Effect> {
        match event {
            InputEvent::Key { input, key } => self.key(input, key),
            InputEvent::Paste(text) => {
                let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
                let kept: String = normalized.chars().filter(|c| *c == '\n' || !c.is_control()).collect();
                if kept.is_empty() {
                    return Vec::new();
                }
                self.insert(&kept);
                Self::redraw(true)
            }
            InputEvent::Mouse(_) | InputEvent::Focus(_) => Vec::new(),
        }
    }

    /// The editor emptied, as after a line was taken from another source (the history is kept).
    pub fn clear(&mut self) {
        self.line.clear();
        self.cursor = 0;
        self.recall = None;
        self.cursor_row = 0;
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
/// fit the row starts the next one.
fn locate(start: usize, text: &str, columns: usize) -> Place {
    let mut row = start / columns;
    let mut column = start % columns;
    for cluster in graphemes_with_widths(text) {
        if cluster.text == "\n" || cluster.text == "\r\n" {
            row += 1;
            column = 0;
            continue;
        }
        if column + cluster.width > columns {
            row += 1;
            column = 0;
        }
        column += cluster.width;
    }
    if column >= columns {
        Place { row: row + 1, column: 0, pending: true }
    } else {
        Place { row, column, pending: false }
    }
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

    fn named(editor: &mut LineEditor, set: impl FnOnce(&mut KeyFlags)) -> Vec<Effect> {
        editor.apply(&key("", set))
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
    fn arrows_words_delete_and_transpose() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "alpha beta gamma");
        named(&mut editor, |flags| flags.left_arrow = true);
        named(&mut editor, |flags| {
            flags.left_arrow = true;
            flags.ctrl = true;
        });
        type_text(&mut editor, "|");
        assert_eq!(editor.line(), "alpha beta |gamma");
        editor.apply(&key("b", |flags| flags.meta = true));
        editor.apply(&key("d", |flags| flags.meta = true));
        assert_eq!(editor.line(), "alpha beta ");
        named(&mut editor, |flags| flags.home = true);
        named(&mut editor, |flags| flags.delete = true);
        assert_eq!(editor.line(), "lpha beta ");
        named(&mut editor, |flags| flags.end = true);
        named(&mut editor, |flags| flags.backspace = true);
        assert_eq!(editor.line(), "lpha beta");
        ctrl(&mut editor, "t");
        assert_eq!(editor.line(), "lpha beat");
        let mut swap = LineEditor::new();
        type_text(&mut swap, "abc");
        ctrl(&mut swap, "t");
        assert_eq!(swap.line(), "acb");
        named(&mut swap, |flags| flags.tab = true);
        assert_eq!(swap.line(), format!("acb{}", " ".repeat(5)));
    }

    #[test]
    fn enter_submits_into_a_history_that_up_and_down_walk() {
        let mut editor = LineEditor::new();
        for line in ["one", "two", "two", ""] {
            type_text(&mut editor, line);
            assert_eq!(named(&mut editor, |flags| flags.return_key = true), vec![Effect::Submit]);
            assert_eq!(editor.take(), line);
        }
        assert_eq!(editor.history(), ["one", "two"]);
        assert!(editor.is_empty());
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "two");
        named(&mut editor, |flags| flags.up_arrow = true);
        assert_eq!(editor.line(), "one");
        assert!(named(&mut editor, |flags| flags.up_arrow = true).is_empty());
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "two");
        named(&mut editor, |flags| flags.down_arrow = true);
        assert_eq!(editor.line(), "");
        assert!(named(&mut editor, |flags| flags.down_arrow = true).is_empty());
    }

    #[test]
    fn the_history_keeps_the_last_two_hundred_lines() {
        let mut editor = LineEditor::new();
        for number in 0..HISTORY_SIZE + 5 {
            type_text(&mut editor, &number.to_string());
            named(&mut editor, |flags| flags.return_key = true);
            editor.take();
        }
        assert_eq!((editor.history().len(), editor.history()[0].as_str()), (HISTORY_SIZE, "5"));
    }

    #[test]
    fn a_paste_is_inserted_whole_with_its_line_breaks() {
        let mut editor = LineEditor::new();
        type_text(&mut editor, "a");
        assert_eq!(editor.apply(&InputEvent::Paste("x\r\ny\u{1b}z".to_owned())), vec![Effect::Redraw]);
        assert_eq!(editor.line(), "ax\nyz");
        assert!(editor.apply(&InputEvent::Paste(String::new())).is_empty());
        assert_eq!(named(&mut editor, |flags| flags.return_key = true), vec![Effect::Submit]);
        assert_eq!(editor.take(), "ax\nyz");
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
