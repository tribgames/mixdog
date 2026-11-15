//! `components/QuestionPanel.jsx` and `components/question-panel-model.mjs`: the ask_user multiple-choice panel.
//!
//! The model is pure: the answer built for the tool result from the drafts, the geometry of the option rows, and the view
//! that fits the panel into the rows it is given. [`QuestionState`] is the keyboard: digits and arrows choose, Space
//! toggles a multi-select option, left and right switch questions, Enter confirms the current question (and sends on the
//! last), Escape dismisses. The last row is an inline text input; while typing, every key belongs to the input.

use mixdog_js::{js_trim, utf16_len};
use mixdog_term::frame::{Color, Rect, Style};
use mixdog_term::input::{KeyFlags, is_csi_private_reply};
use mixdog_term::paint::{Painter, RoundBorder, TextWrap};
use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};
use mixdog_tui_style::Key;
use serde_json::{Value, json};

use crate::panel_cell_text::{cells, pad_panel_cells, truncate_panel_text};
use crate::{Run, basis, fitted_rows, runs_to_ansi, runs_width, selected_style, themed};

pub const CUSTOM_LABEL: &str = "\u{c9c1}\u{c811} \u{c785}\u{b825}\u{2026}";
const RECOMMENDED_SUFFIX: &str = " (\u{cd94}\u{cc9c})";
const MULTI_HINT: &str = " (\u{c5ec}\u{b7ec} \u{ac1c} \u{c120}\u{d0dd} \u{ac00}\u{b2a5})";
/// Border (2), title, blank and the blank after the question; the question rows are added separately.
const FIXED_ROWS: usize = 5;
/// The panel interior is the frame minus two border cells and two cells of padding.
const CHROME_COLUMNS: usize = 4;
const DETAIL_GAP: &str = "  ";
const MIN_DETAIL_CELLS: usize = 6;
const MAX_ANSWER_CHARS: usize = 4000;
const MIN_OPTION_ROWS: usize = 3;
const MAX_TAB_CELLS: usize = 10;

/// One option of a question.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// One question of the ask_user tool.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub recommended: Option<usize>,
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

impl Question {
    /// A question from the tool arguments.
    pub fn from_value(value: &Value) -> Self {
        let options = value
            .get("options")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|option| QuestionOption { label: text_of(option.get("label")), description: text_of(option.get("description")) })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            question: text_of(value.get("question")),
            header: text_of(value.get("header")),
            options,
            multi_select: value.get("multi_select") == Some(&Value::Bool(true)),
            recommended: value.get("recommended").and_then(Value::as_u64).map(|index| index as usize),
        }
    }
}

/// `questionsOf(toolApproval)`: the questions of a tool approval's arguments.
pub fn questions_of(tool_approval: &Value) -> Vec<Question> {
    // Node's card carries them as `args.questions`; the card the session store publishes from the wire request (`item/tool/requestUserInput`)
    // has them at its top, as the protocol names them.
    tool_approval
        .pointer("/args/questions")
        .or_else(|| tool_approval.get("questions"))
        .and_then(Value::as_array)
        .map(|list| list.iter().map(Question::from_value).collect())
        .unwrap_or_default()
}

/// What the user has picked and typed for one question.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub selected: Vec<usize>,
    pub text: String,
}

/// One question's answer: the labels of the chosen options, and the typed text when there is some.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub selected: Vec<String>,
    pub text: Option<String>,
}

impl Answer {
    /// The object of the tool result.
    pub fn to_value(&self) -> Value {
        match &self.text {
            Some(text) => json!({ "selected": self.selected, "text": text }),
            None => json!({ "selected": self.selected }),
        }
    }
}

/// `answerFor(question, draft)`: none when nothing is chosen or typed.
pub fn answer_for(question: &Question, draft: &Draft) -> Option<Answer> {
    let mut chosen: Vec<usize> = draft.selected.iter().copied().filter(|index| *index < question.options.len()).collect();
    chosen.sort_unstable();
    chosen.dedup();
    let selected: Vec<String> = chosen.into_iter().map(|index| question.options[index].label.clone()).collect();
    let text = js_trim(&draft.text);
    if selected.is_empty() && text.is_empty() {
        return None;
    }
    Some(Answer { selected, text: (!text.is_empty()).then(|| text.to_owned()) })
}

/// `buildAnswers(questions, drafts)`.
pub fn build_answers(questions: &[Question], drafts: &[Draft]) -> Vec<Option<Answer>> {
    questions.iter().enumerate().map(|(index, question)| drafts.get(index).and_then(|draft| answer_for(question, draft))).collect()
}

/// One option row: its label cut to fit, the recommended mark and the one-sentence tradeoff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptionRow {
    pub label: String,
    pub suffix: String,
    pub detail: String,
}

/// The geometry of one question's option rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptionLayout {
    pub rows: Vec<OptionRow>,
    pub prefix_cells: usize,
    pub avail: usize,
    pub index_cells: usize,
}

/// `optionLayout(question, columns)`: one line per option (its label, the recommended mark, then its tradeoff in the
/// cells left, cut with an ellipsis).
pub fn option_layout(question: &Question, columns: usize) -> OptionLayout {
    let total = question.options.len() + 1;
    let index_cells = cells(&format!("{total}. "));
    let marker_cells = if question.multi_select { 4 } else { 0 };
    let prefix_cells = 2 + index_cells + marker_cells;
    let avail = 10.max(columns.saturating_sub(CHROME_COLUMNS));
    let label_cap = 4.max(avail.saturating_sub(prefix_cells));
    let rows = question
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            let suffix = if question.recommended == Some(index) { RECOMMENDED_SUFFIX } else { "" };
            let label = truncate_panel_text(&option.label, 1.max(label_cap.saturating_sub(cells(suffix))));
            let left = label_cap as i64 - cells(&format!("{label}{suffix}")) as i64 - DETAIL_GAP.len() as i64;
            let text = js_trim(&option.description);
            let detail = if !text.is_empty() && left >= MIN_DETAIL_CELLS as i64 {
                format!("{DETAIL_GAP}{}", truncate_panel_text(text, left as usize))
            } else {
                String::new()
            };
            OptionRow { label, suffix: suffix.to_owned(), detail }
        })
        .collect();
    OptionLayout { rows, prefix_cells, avail, index_cells }
}

/// `appendCapped(base, text)`: `text` appended to `base`, never past 4000 UTF-16 units (the unit the runtime checks) and
/// never splitting a character.
pub fn append_capped(base: &str, text: &str) -> String {
    let mut out = base.to_owned();
    let mut units = utf16_len(&out);
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > MAX_ANSWER_CHARS {
            break;
        }
        out.push(ch);
        units += width;
    }
    out
}

fn question_lines(question: &Question, columns: usize) -> Vec<String> {
    let shown = format!("{}{}", question.question, if question.multi_select { MULTI_HINT } else { "" });
    let width = 1.max(columns.saturating_sub(CHROME_COLUMNS));
    wrap_ansi(&shown, width, WrapOptions { hard: true, trim: false, word_wrap: true }).split('\n').map(str::to_owned).collect()
}

fn ellipsize(line: &str, width: usize) -> String {
    let cut = truncate_panel_text(line, 1.max(width.saturating_sub(1)));
    format!("{}\u{2026}", cut.strip_suffix('\u{2026}').unwrap_or(&cut))
}

/// The panel fitted into its rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionView {
    pub q_lines: Vec<String>,
    /// The option indexes shown; `options.len()` is the custom-input row.
    pub items: Vec<usize>,
    pub above: usize,
    pub below: usize,
}

/// `planQuestionView(question, columns, rows, cursor)`: fits the panel into `rows` (`None` is unbudgeted). It always
/// keeps the question text (capped, leaving three rows for options) and the highlighted option; the rest scroll with
/// "more" indicators. Every option takes one row, so the rows are counted rather than summed.
pub fn plan_question_view(question: &Question, columns: usize, rows: Option<usize>, cursor: usize) -> QuestionView {
    let n = question.options.len();
    let mut q_lines = question_lines(question, columns);
    if let Some(rows) = rows {
        let option_budget = rows as i64 - FIXED_ROWS as i64;
        let q_cap = 1.max(option_budget - MIN_OPTION_ROWS as i64) as usize;
        if q_lines.len() > q_cap {
            q_lines.truncate(q_cap);
            let last = ellipsize(&q_lines[q_cap - 1], 1.max(columns.saturating_sub(CHROME_COLUMNS)));
            q_lines[q_cap - 1] = last;
        }
    }
    let avail = rows.map_or(i64::MAX, |rows| 1.max(rows as i64 - FIXED_ROWS as i64 - q_lines.len() as i64));
    let total = n + 1;
    let mut start = cursor.min(total - 1);
    let mut end = start + 1;
    let mut used = 1i64;
    let fits = |start: usize, end: usize, sum: i64| sum + i64::from(start > 0) + i64::from(end < total) <= avail;
    let mut grew = true;
    while grew {
        grew = false;
        if end < total && fits(start, end + 1, used + 1) {
            used += 1;
            end += 1;
            grew = true;
        }
        if start > 0 && fits(start - 1, end, used + 1) {
            used += 1;
            start -= 1;
            grew = true;
        }
    }
    QuestionView { q_lines, items: (start..end).collect(), above: start, below: total - end }
}

fn question_rows(question: &Question, columns: usize) -> usize {
    FIXED_ROWS + question_lines(question, columns).len() + question.options.len() + 1
}

/// `questionPanelRows(questions, columns)`: the floating-panel rows to reserve, the tallest question's, so switching
/// questions never resizes the panel.
pub fn question_panel_rows(questions: &[Question], columns: usize) -> usize {
    questions.iter().map(|question| question_rows(question, columns)).fold(FIXED_ROWS + 3, usize::max)
}

/// `initialCursor(question)`: the recommended option, else the first.
pub fn initial_cursor(question: &Question) -> usize {
    match question.recommended {
        Some(index) if index < question.options.len() => index,
        _ => 0,
    }
}

/// `questionHelp(...)`: the key hint of the title row.
pub fn question_help(multi: bool, typing: bool, last: bool, count: usize, question_count: usize) -> String {
    if typing {
        return "Enter Send \u{b7} Esc Back to list".to_owned();
    }
    // With several questions the title row also holds the tabs, so the help stays short.
    let mut parts: Vec<String> = if question_count > 1 { Vec::new() } else { vec![format!("1\u{2013}{count} Choose"), "\u{2191}/\u{2193} Move".to_owned()] };
    if multi {
        parts.push("Space Toggle".to_owned());
    }
    if question_count > 1 {
        parts.push("\u{2190}/\u{2192} Question".to_owned());
    }
    parts.push(if last { "Enter Send" } else { "Enter Next" }.to_owned());
    parts.push("Esc Dismiss".to_owned());
    parts.join(" \u{b7} ")
}

/// What the owner has to do after a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuestionAction {
    None,
    /// The last question was confirmed: `onSubmit(answers)`.
    Submit(Vec<Option<Answer>>),
    /// Escape outside the text input: `onDismiss()`.
    Dismiss,
}

/// The panel's state: the current question, each question's cursor and draft, and the inline input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionState {
    pub qi: usize,
    pub cursors: Vec<usize>,
    pub drafts: Vec<Draft>,
    pub typing: bool,
    pub buf: String,
}

/// `cleanTyped(value)`: CSI sequences removed, runs of line breaks and tabs made one blank, other control characters
/// removed.
fn clean_typed(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut without_csi = String::new();
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '\x1b' && chars.get(at + 1) == Some(&'[') {
            let mut end = at + 2;
            while end < chars.len() && (chars[end].is_ascii_digit() || matches!(chars[end], ';' | '?' | '<')) {
                end += 1;
            }
            if end < chars.len() && (chars[end].is_ascii_alphabetic() || chars[end] == '~') {
                at = end + 1;
                continue;
            }
        }
        without_csi.push(chars[at]);
        at += 1;
    }
    let mut spaced = String::new();
    let mut in_break = false;
    for ch in without_csi.chars() {
        if matches!(ch, '\r' | '\n' | '\t') {
            if !in_break {
                spaced.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            spaced.push(ch);
        }
    }
    spaced.chars().filter(|ch| !matches!(u32::from(*ch), 0..=0x1f | 0x7f)).collect()
}

/// `/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(raw)`: an SGR mouse report in the input.
fn contains_mouse_report(raw: &str) -> bool {
    let mut rest = raw;
    while let Some(at) = rest.find("[<") {
        rest = &rest[at + 2..];
        if is_mouse_report_tail(rest) {
            return true;
        }
    }
    false
}

/// The digits at the start of `text`.
fn leading_digits(text: &str) -> usize {
    text.len() - text.trim_start_matches(|ch: char| ch.is_ascii_digit()).len()
}

/// `\d+;\d+;\d+[Mm]` at the start of `tail`.
fn is_mouse_report_tail(tail: &str) -> bool {
    let mut rest = tail;
    for _ in 0..2 {
        let digits = leading_digits(rest);
        if digits == 0 || !rest[digits..].starts_with(';') {
            return false;
        }
        rest = &rest[digits + 1..];
    }
    let digits = leading_digits(rest);
    digits > 0 && rest[digits..].starts_with(['M', 'm'])
}

impl QuestionState {
    pub fn new(questions: &[Question]) -> Self {
        Self {
            qi: 0,
            cursors: questions.iter().map(initial_cursor).collect(),
            drafts: questions.iter().map(|_| Draft::default()).collect(),
            typing: false,
            buf: String::new(),
        }
    }

    fn with_draft(&mut self, qi: usize, selected: Option<Vec<usize>>, text: Option<String>) {
        let draft = &mut self.drafts[qi];
        if let Some(selected) = selected {
            draft.selected = selected;
        }
        if let Some(text) = text {
            draft.text = text;
        }
    }

    /// Takes `next` as the state: confirming the question (`advance`) moves to the next one, or sends the answers on the
    /// last one and leaves the state as it was (the panel closes); without `advance` it only replaces the state.
    fn settle(&mut self, mut next: QuestionState, questions: &[Question], advance: bool) -> QuestionAction {
        if !advance {
            *self = next;
            return QuestionAction::None;
        }
        if next.qi + 1 >= questions.len() {
            return QuestionAction::Submit(build_answers(questions, &next.drafts));
        }
        next.qi += 1;
        next.typing = false;
        next.buf.clear();
        *self = next;
        QuestionAction::None
    }

    fn type_into(&mut self, input: &str) {
        let text = clean_typed(input);
        if !text.is_empty() {
            self.buf = append_capped(&self.buf, &text);
        }
    }

    /// A bracketed paste: it types into the input while the input is open, and is dropped otherwise.
    pub fn paste(&mut self, text: &str) {
        if self.typing {
            self.type_into(text);
        }
    }

    /// One key.
    pub fn handle_key(&mut self, questions: &[Question], input: &str, key: &KeyFlags) -> QuestionAction {
        if questions.is_empty() || contains_mouse_report(input) || is_csi_private_reply(input) {
            return QuestionAction::None;
        }
        let qi = self.qi;
        let question = &questions[qi];
        let n = question.options.len();
        let multi = question.multi_select;
        let last = questions.len() - 1;

        if self.typing {
            if key.escape {
                self.typing = false;
                self.buf.clear();
                return QuestionAction::None;
            }
            if key.return_key {
                let text = js_trim(&self.buf).to_owned();
                let selected = if multi { self.drafts[qi].selected.clone() } else { Vec::new() };
                let mut next = self.clone();
                next.with_draft(qi, Some(selected), Some(text.clone()));
                next.typing = false;
                next.buf.clear();
                return self.settle(next, questions, !text.is_empty());
            }
            if key.backspace || key.delete {
                self.buf.pop();
                return QuestionAction::None;
            }
            if key.ctrl || key.meta || key.up_arrow || key.down_arrow || key.left_arrow || key.right_arrow || key.tab {
                return QuestionAction::None;
            }
            self.type_into(input);
            return QuestionAction::None;
        }

        if key.escape {
            return QuestionAction::Dismiss;
        }
        let cursor = self.cursors[qi];
        if key.up_arrow {
            self.cursors[qi] = (cursor + n) % (n + 1);
            return QuestionAction::None;
        }
        if key.down_arrow {
            self.cursors[qi] = (cursor + 1) % (n + 1);
            return QuestionAction::None;
        }
        if key.left_arrow || key.right_arrow {
            self.qi = if key.left_arrow { qi.saturating_sub(1) } else { (qi + 1).min(last) };
            return QuestionAction::None;
        }
        if key.return_key {
            if cursor == n {
                self.typing = true;
                self.buf = self.drafts[qi].text.clone();
                return QuestionAction::None;
            }
            let draft = self.drafts[qi].clone();
            let mut next = self.clone();
            if !multi {
                next.with_draft(qi, Some(vec![cursor]), Some(String::new()));
            } else if draft.selected.is_empty() && js_trim(&draft.text).is_empty() {
                next.with_draft(qi, Some(vec![cursor]), None);
            }
            return self.settle(next, questions, true);
        }
        if input == " " && !key.ctrl && !key.meta {
            if cursor < n {
                self.choose(qi, multi, cursor);
            }
            return QuestionAction::None;
        }
        if let [digit @ b'1'..=b'9'] = input.as_bytes() {
            let index = usize::from(digit - b'1');
            if index < n {
                self.choose(qi, multi, index);
            } else if index == n {
                self.cursors[qi] = n;
            }
        }
        QuestionAction::None
    }

    /// Toggles (multi-select) or picks (single) option `index` and moves the cursor to it.
    fn choose(&mut self, qi: usize, multi: bool, index: usize) {
        let draft = self.drafts[qi].clone();
        let selected = if multi {
            if draft.selected.contains(&index) {
                draft.selected.iter().copied().filter(|chosen| *chosen != index).collect()
            } else {
                let mut next = draft.selected.clone();
                next.push(index);
                next
            }
        } else {
            vec![index]
        };
        self.cursors[qi] = index;
        self.with_draft(qi, Some(selected), if multi { None } else { Some(String::new()) });
    }
}

/// The text of a row of the view, an outer `<Text>` whose style a selected row sets: a nested run without a colour of
/// its own takes the outer one, and the background is the outer one's.
fn row_text(selected: bool, runs: Vec<Run>) -> String {
    let base = if selected { selected_style() } else { Style::default() };
    let inherit = |(text, style): Run| {
        let fg = if style.fg == Color::Default { base.fg } else { style.fg };
        (text, Style { fg, bg: base.bg, ..style })
    };
    runs_to_ansi(&runs.into_iter().map(inherit).collect::<Vec<_>>())
}

/// The title row: the title and the tabs (cut at their end on one row), and the key hint, which keeps its width and wraps in
/// it when the panel is narrow (the title gives its cells up first).
struct TitleRow {
    runs: Vec<Run>,
    help: String,
    left_cells: usize,
    right_x: usize,
    right_cells: usize,
    rows: u16,
}

fn title_row(questions: &[Question], state: &QuestionState, inner: usize) -> TitleRow {
    let question = &questions[state.qi];
    let title = if questions.len() > 1 { format!("Question {}/{}", state.qi + 1, questions.len()) } else { "Question".to_owned() };
    let mut runs: Vec<Run> = vec![(title, themed(Key::PanelTitle))];
    if questions.len() > 1 {
        for (index, tab_question) in questions.iter().enumerate() {
            let header = if tab_question.header.is_empty() { format!("Q{}", index + 1) } else { tab_question.header.clone() };
            let text = truncate_panel_text(&header, MAX_TAB_CELLS);
            let answered = answer_for(tab_question, &state.drafts[index]).is_some();
            runs.push(("  ".to_owned(), Style::default()));
            if index == state.qi {
                runs.push((format!(" {}{text} ", if answered { "✓ " } else { "" }), selected_style()));
            } else if answered {
                runs.push((format!("✓ {text}"), themed(Key::Success)));
            } else {
                runs.push((text, themed(Key::Subtle)));
            }
        }
    }
    let help = question_help(question.multi_select, state.typing, state.qi + 1 >= questions.len(), question.options.len(), questions.len());
    // The hint's box does not shrink: it asks for the widest line of its text wrapped to the row less its margin of two.
    let right_cells = basis(&help, inner.saturating_sub(2), TextWrap::Wrap);
    let left_cells = runs_width(&runs).min(inner).min(inner.saturating_sub(right_cells + 2));
    let rows = fitted_rows(&help, right_cells, TextWrap::Wrap).max(1);
    TitleRow { runs, help, left_cells, right_x: inner - right_cells, right_cells, rows }
}

/// The rows the panel draws for this state at `columns` in `rows` (the floating-panel rows, `None` unbudgeted).
pub fn question_view_rows(questions: &[Question], state: &QuestionState, columns: usize, rows: Option<usize>) -> u16 {
    let question = &questions[state.qi];
    let view = plan_question_view(question, columns, rows, state.cursors[state.qi]);
    let more = usize::from(view.above > 0) + usize::from(view.below > 0);
    let title = title_row(questions, state, columns.saturating_sub(CHROME_COLUMNS));
    (2 + usize::from(title.rows) + 1 + view.q_lines.len() + 1 + view.items.len() + more) as u16
}

/// Paints the panel with its top-left cell at `(x, y)`. Returns the rows it took.
pub fn paint_question(painter: &mut Painter, x: i32, y: i32, questions: &[Question], state: &QuestionState, columns: usize, rows: Option<usize>) -> u16 {
    let question = &questions[state.qi];
    let multi = question.multi_select;
    let layout = option_layout(question, columns);
    let n = question.options.len();
    let cursor = state.cursors[state.qi];
    let draft = &state.drafts[state.qi];
    let avail = layout.avail;
    let inner = columns.saturating_sub(CHROME_COLUMNS);
    let cx = x + 2;
    let view = plan_question_view(question, columns, rows, cursor);
    let total_rows = question_view_rows(questions, state, columns, rows);

    if x >= 0 && y >= 0 {
        painter.border(Rect::new(x as u16, y as u16, columns as u16, total_rows), &RoundBorder::all(themed(Key::PromptBorder)));
    }

    let title = title_row(questions, state, inner);
    if title.left_cells > 0 {
        painter.text(cx, y + 1, &runs_to_ansi(&title.runs), Style::default(), title.left_cells, TextWrap::TruncateEnd);
    }
    painter.text(cx + title.right_x as i32, y + 1, &title.help, themed(Key::Subtle), title.right_cells, TextWrap::Wrap);

    let mut row = y + 2 + i32::from(title.rows);
    for line in &view.q_lines {
        painter.text(cx, row, line, themed(Key::Text), inner, TextWrap::TruncateEnd);
        row += 1;
    }
    row += 1;

    let index_text = |index: usize| format!("{} ", pad_panel_cells(&format!("{}.", index + 1), layout.index_cells - 1));
    let more_row = |painter: &mut Painter, row: i32, text: String| {
        painter.text(cx, row, &format!("    {text}"), themed(Key::Subtle), inner, TextWrap::TruncateEnd);
    };
    if view.above > 0 {
        more_row(painter, row, format!("\u{2191} {} more", view.above));
        row += 1;
    }
    for &index in &view.items {
        let selected = index == cursor;
        let lead = format!("{}{}", if selected { "\u{203a} " } else { "  " }, index_text(index));
        let mut runs: Vec<Run> = vec![(lead.clone(), Style::default())];
        if index == n {
            let marker_pad = if multi { "    " } else { "" };
            let body = if state.typing {
                let room = 1.max(avail.saturating_sub(cells(&lead) + cells(marker_pad) + 1));
                let mut shown: Vec<char> = state.buf.chars().collect();
                let keep = shown.len().saturating_sub(room);
                shown.drain(..keep);
                let mut shown: String = shown.into_iter().collect();
                while cells(&shown) > room {
                    shown.remove(0);
                }
                format!("{shown}\u{258c}")
            } else if !draft.text.is_empty() {
                truncate_panel_text(&draft.text, 1.max(avail.saturating_sub(cells(&lead) + cells(marker_pad))))
            } else {
                CUSTOM_LABEL.to_owned()
            };
            let color = if selected {
                selected_style().fg
            } else if !draft.text.is_empty() && !state.typing {
                themed(Key::Text).fg
            } else {
                themed(Key::Inactive).fg
            };
            let fill = if selected { " ".repeat(avail.saturating_sub(cells(&format!("{lead}{marker_pad}{body}")))) } else { String::new() };
            runs.push((marker_pad.to_owned(), Style::default()));
            runs.push((body, if state.typing { Style::default() } else { Style { fg: color, ..Style::default() } }));
            runs.push((fill, Style::default()));
        } else {
            let option = &layout.rows[index];
            let checked = draft.selected.contains(&index);
            if multi {
                let fg = if selected {
                    selected_style().fg
                } else if checked {
                    themed(Key::Success).fg
                } else {
                    Color::Default
                };
                runs.push((if checked { "[x] " } else { "[ ] " }.to_owned(), Style { fg, ..Style::default() }));
            }
            runs.push((option.label.clone(), Style::default()));
            if !option.suffix.is_empty() {
                runs.push((option.suffix.clone(), themed(if selected { Key::SelectionText } else { Key::Suggestion })));
            }
            if !option.detail.is_empty() {
                runs.push((option.detail.clone(), themed(if selected { Key::SelectionText } else { Key::Subtle })));
            }
            if selected {
                let used = cells(&format!("{}{}{}", option.label, option.suffix, option.detail));
                runs.push((" ".repeat(avail.saturating_sub(layout.prefix_cells + used)), Style::default()));
            }
        }
        painter.text(cx, row, &row_text(selected, runs), Style::default(), inner, TextWrap::TruncateEnd);
        row += 1;
    }
    if view.below > 0 {
        more_row(painter, row, format!("\u{2193} {} more", view.below));
    }
    total_rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(label: &str, description: &str) -> QuestionOption {
        QuestionOption { label: label.to_owned(), description: description.to_owned() }
    }

    fn sample(count: usize) -> Question {
        Question {
            question: "Pick one".to_owned(),
            header: String::new(),
            options: (0..count).map(|index| option(&format!("Option {index}"), "")).collect(),
            multi_select: false,
            recommended: None,
        }
    }

    fn key(name: &str) -> KeyFlags {
        let mut flags = KeyFlags::default();
        match name {
            "up" => flags.up_arrow = true,
            "down" => flags.down_arrow = true,
            "left" => flags.left_arrow = true,
            "right" => flags.right_arrow = true,
            "return" => flags.return_key = true,
            "escape" => flags.escape = true,
            "backspace" => flags.backspace = true,
            _ => {}
        }
        flags
    }

    #[test]
    fn an_answer_has_the_chosen_labels_in_option_order_and_the_trimmed_text() {
        let mut question = sample(3);
        question.options[1].label = "Beta".to_owned();
        let draft = Draft { selected: vec![2, 1, 1, 9], text: "  note ".to_owned() };
        let answer = answer_for(&question, &draft).unwrap();
        assert_eq!(answer.selected, vec!["Beta", "Option 2"]);
        assert_eq!(answer.to_value(), json!({ "selected": ["Beta", "Option 2"], "text": "note" }));
        assert_eq!(answer_for(&question, &Draft::default()), None);
        assert_eq!(answer_for(&question, &Draft { selected: vec![0], text: String::new() }).unwrap().to_value(), json!({ "selected": ["Option 0"] }));
    }

    #[test]
    fn the_recommended_option_gets_its_mark_and_a_tradeoff_only_when_it_fits() {
        let mut question = sample(2);
        question.recommended = Some(1);
        question.options[0].description = "short".to_owned();
        question.options[1].description = "x".repeat(200);
        let layout = option_layout(&question, 40);
        assert_eq!(layout.rows[1].suffix, RECOMMENDED_SUFFIX);
        assert!(layout.rows[0].detail.starts_with("  short"));
        assert!(layout.rows[1].detail.is_empty() || layout.rows[1].detail.ends_with('\u{2026}'));
        let narrow = option_layout(&question, 12);
        assert!(narrow.rows[0].detail.is_empty());
    }

    #[test]
    fn the_view_keeps_the_highlighted_option_and_shows_what_is_hidden() {
        let question = sample(10);
        let all = plan_question_view(&question, 80, None, 0);
        assert_eq!((all.items.len(), all.above, all.below), (11, 0, 0));
        let fitted = plan_question_view(&question, 80, Some(12), 5);
        assert!(fitted.items.contains(&5));
        assert_eq!(fitted.above + fitted.items.len() + fitted.below, 11);
        assert!(fitted.above > 0 && fitted.below > 0);
        let rows_used = fitted.q_lines.len() + fitted.items.len() + usize::from(fitted.above > 0) + usize::from(fitted.below > 0);
        assert!(rows_used + FIXED_ROWS <= 12);
    }

    #[test]
    fn a_long_question_is_cut_with_an_ellipsis_to_leave_room_for_options() {
        let mut question = sample(2);
        question.question = "word ".repeat(80);
        let view = plan_question_view(&question, 30, Some(10), 0);
        assert_eq!(view.q_lines.len(), 2);
        assert!(view.q_lines[1].ends_with('\u{2026}'));
    }

    #[test]
    fn the_reserved_height_is_the_tallest_question() {
        let (short, tall) = (sample(1), sample(6));
        assert_eq!(question_panel_rows(&[short.clone(), tall.clone()], 80), FIXED_ROWS + 1 + 6 + 1);
        assert_eq!(question_panel_rows(&[], 80), FIXED_ROWS + 3);
        assert_eq!(question_rows(&short, 80), FIXED_ROWS + 1 + 1 + 1);
    }

    #[test]
    fn help_follows_the_mode() {
        assert_eq!(question_help(false, true, false, 3, 1), "Enter Send \u{b7} Esc Back to list");
        assert_eq!(question_help(true, false, true, 3, 1), "1\u{2013}3 Choose \u{b7} \u{2191}/\u{2193} Move \u{b7} Space Toggle \u{b7} Enter Send \u{b7} Esc Dismiss");
        assert_eq!(question_help(false, false, false, 3, 2), "\u{2190}/\u{2192} Question \u{b7} Enter Next \u{b7} Esc Dismiss");
    }

    #[test]
    fn digits_choose_and_enter_sends_on_the_last_question() {
        let questions = vec![sample(3)];
        let mut state = QuestionState::new(&questions);
        assert_eq!(state.handle_key(&questions, "2", &KeyFlags::default()), QuestionAction::None);
        assert_eq!(state.cursors[0], 1);
        let action = state.handle_key(&questions, "", &key("return"));
        let QuestionAction::Submit(answers) = action else { panic!("expected a submit") };
        assert_eq!(answers[0].as_ref().unwrap().selected, vec!["Option 1"]);
        assert_eq!(state.handle_key(&questions, "", &key("escape")), QuestionAction::Dismiss);
    }

    #[test]
    fn space_toggles_a_multi_select_option_and_enter_with_nothing_chosen_takes_the_cursor_row() {
        let mut question = sample(3);
        question.multi_select = true;
        let questions = vec![question, sample(2)];
        let mut state = QuestionState::new(&questions);
        state.handle_key(&questions, " ", &KeyFlags::default());
        state.handle_key(&questions, "", &key("down"));
        state.handle_key(&questions, " ", &KeyFlags::default());
        assert_eq!(state.drafts[0].selected, vec![0, 1]);
        state.handle_key(&questions, " ", &KeyFlags::default());
        assert_eq!(state.drafts[0].selected, vec![0]);
        state.handle_key(&questions, "", &key("return"));
        assert_eq!(state.qi, 1);
        state.handle_key(&questions, "", &key("left"));
        assert_eq!(state.qi, 0);
    }

    #[test]
    fn the_custom_row_takes_typed_text_and_sends_it_as_the_answer() {
        let questions = vec![sample(2)];
        let mut state = QuestionState::new(&questions);
        state.handle_key(&questions, "3", &KeyFlags::default());
        assert_eq!(state.cursors[0], 2);
        state.handle_key(&questions, "", &key("return"));
        assert!(state.typing);
        state.handle_key(&questions, "hi\u{1b}[31m there", &KeyFlags::default());
        state.paste("\n!");
        state.handle_key(&questions, "", &key("backspace"));
        assert_eq!(state.buf, "hi there ");
        let action = state.handle_key(&questions, "", &key("return"));
        let QuestionAction::Submit(answers) = action else { panic!("expected a submit") };
        assert_eq!(answers[0].as_ref().unwrap().to_value(), json!({ "selected": [], "text": "hi there" }));
    }

    #[test]
    fn terminal_replies_and_mouse_reports_never_type_into_the_input() {
        let questions = vec![sample(2)];
        let mut state = QuestionState::new(&questions);
        state.typing = true;
        state.handle_key(&questions, "\u{1b}[<0;10;5M", &KeyFlags::default());
        state.handle_key(&questions, "[?1;0c", &KeyFlags::default());
        assert_eq!(state.buf, "");
        assert!(contains_mouse_report("x[<35;1;2m"));
        assert!(!contains_mouse_report("[<35;1;2"));
    }

    #[test]
    fn typed_text_is_capped_without_splitting_a_character() {
        let long = "a".repeat(3999);
        assert_eq!(utf16_len(&append_capped(&long, "bc")), 4000);
        assert_eq!(utf16_len(&append_capped(&long, "\u{1f600}")), 3999);
        assert_eq!(clean_typed("a\r\n\tb\u{7}c"), "a bc");
    }
}
