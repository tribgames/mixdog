//! `components/BtwPanel.jsx`: the transient `/btw` side-question panel above the prompt. The answer lives only here (it is
//! never in the transcript): a bordered box with the question as its title, the answer as markdown in a body that scrolls
//! by pages, and a line that says it is not saved.
//!
//! The row arithmetic the component imports from `app/btw-controller.mjs` (the chrome rows, the rows of the answer, the
//! scroll limits) is here too, for the controller of the side question to use.

use mixdog_markdown_ansi::measure::measure_markdown_rendered_rows;
use mixdog_markdown_ansi::render::{RenderOptions, render_token_ansi_segments};
use mixdog_markdown_ansi::table::build_table_render;
use mixdog_term::frame::{Rect, Style};
use mixdog_term::input::KeyFlags;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::spans::{SgrColor, SgrStyle, parse_sgr, xterm256_rgb};
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::{Key, theme_color};
use serde_json::Value;

use crate::panels::{field, paint_frame, put, rows_of, template_text, text_or_empty};
use crate::themed;

/// Border (2), header (1) and footer (1): the rows of the panel that are not the answer.
pub const BTW_CHROME_ROWS: usize = 4;

/// The status of a panel: the question is being answered, the answer is in, or the question failed.
fn status_of(panel: &Value) -> &str {
    field(Some(panel), "status").and_then(Value::as_str).unwrap_or("")
}

/// `String(value ?? '')`.
fn text_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

/// `btwContentRows(panel, columns)`: the rows of the answer body, the scrollable content height (at least one).
pub fn btw_content_rows(panel: &Value, columns: usize) -> usize {
    let body = if status_of(panel) == "done" {
        measure_markdown_rendered_rows(&text_nullish(field(Some(panel), "text")), 1.max(columns.saturating_sub(4)), false)
    } else {
        text_or_empty(field(Some(panel), "text")).split('\n').count()
    };
    1.max(body)
}

/// `btwScrollMax(total, visible)`: the largest scroll offset for `total` content rows shown through `visible` rows.
pub fn btw_scroll_max(total: usize, visible: usize) -> usize {
    total.saturating_sub(1.max(visible))
}

/// `btwScrollOffset(key, offset, visible, total)`: the next scroll offset for a PageUp or PageDown key (other keys leave
/// it unchanged, inside the range).
pub fn btw_scroll_offset(key: &KeyFlags, offset: usize, visible: usize, total: usize) -> usize {
    let max = btw_scroll_max(total, visible);
    let page = 1.max(visible.saturating_sub(1));
    if key.page_up {
        return offset.min(max).saturating_sub(page);
    }
    if key.page_down {
        return (offset + page).min(max);
    }
    offset.min(max)
}

/// The props of the panel.
#[derive(Clone, Copy, Debug)]
pub struct BtwPanelProps<'a> {
    /// `{ question, status: "pending" | "done" | "error", text }`.
    pub panel: &'a Value,
    pub columns: usize,
    /// The rows the owner gave the panel, the chrome included (none: the body is one row).
    pub panel_rows: Option<usize>,
}

impl<'a> BtwPanelProps<'a> {
    pub fn new(panel: &'a Value) -> Self {
        Self { panel, columns: 80, panel_rows: None }
    }

    fn body_rows(&self) -> usize {
        1.max(self.panel_rows.unwrap_or(BTW_CHROME_ROWS + 1).saturating_sub(BTW_CHROME_ROWS))
    }

    fn total(&self) -> usize {
        btw_content_rows(self.panel, self.columns)
    }

    fn max_offset(&self) -> usize {
        btw_scroll_max(self.total(), self.body_rows())
    }
}

/// The scroll position of the answer; a new question or a settled answer starts from the top.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BtwPanelState {
    offset: usize,
    question: String,
    status: String,
}

impl BtwPanelState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The first row of the answer shown, kept inside the answer.
    pub fn offset(&self, props: &BtwPanelProps) -> usize {
        self.offset.min(props.max_offset())
    }

    /// Follows the panel: a new question or a new status scrolls back to the top.
    pub fn sync(&mut self, props: &BtwPanelProps) {
        let question = text_or_empty(field(Some(props.panel), "question"));
        let status = status_of(props.panel).to_owned();
        if question != self.question || status != self.status {
            self.offset = 0;
            self.question = question;
            self.status = status;
        }
    }

    /// One key (`useInput`): only PageUp and PageDown, and only when the answer does not fit.
    pub fn handle_key(&mut self, key: &KeyFlags, props: &BtwPanelProps) {
        self.sync(props);
        if props.max_offset() == 0 || (!key.page_up && !key.page_down) {
            return;
        }
        self.offset = btw_scroll_offset(key, self.offset, props.body_rows(), props.total());
    }
}

/// The colour an SGR colour has in `AnsiText`: the sixteen named colours are colours of the theme (or the terminal's own
/// magenta and cyan), the rest of the 256 palette is the cube and the grey ramp, and a truecolour stays.
enum Painted {
    Theme(Key),
    Named(u8),
    Rgb(u8, u8, u8),
}

fn painted_foreground(color: Option<SgrColor>) -> Painted {
    match color {
        None => Painted::Theme(Key::Text),
        Some(SgrColor::Rgb(r, g, b)) => Painted::Rgb(r, g, b),
        Some(SgrColor::Indexed(index)) => match xterm256_rgb(index) {
            Some((r, g, b)) => Painted::Rgb(r, g, b),
            None => match index {
                0 | 8 => Painted::Theme(Key::Subtle),
                1 | 9 => Painted::Theme(Key::Error),
                2 | 10 => Painted::Theme(Key::Success),
                3 | 11 => Painted::Theme(Key::Warning),
                4 | 12 => Painted::Theme(Key::Code),
                7 => Painted::Theme(Key::Text),
                15 => Painted::Theme(Key::StatusText),
                other => Painted::Named(other),
            },
        },
    }
}

fn foreground_code(color: Painted) -> String {
    match color {
        Painted::Rgb(r, g, b) => format!("38;2;{r};{g};{b}"),
        Painted::Named(index) if index < 8 => format!("{}", 30 + u16::from(index)),
        Painted::Named(index) => format!("{}", 90 + u16::from(index) - 8),
        Painted::Theme(key) => match theme_color(key) {
            ThemeColor::Rgb(r, g, b) => format!("38;2;{r};{g};{b}"),
            ThemeColor::Transparent => "39".to_owned(),
        },
    }
}

fn background_code(color: SgrColor) -> String {
    match color {
        SgrColor::Rgb(r, g, b) => format!("48;2;{r};{g};{b}"),
        SgrColor::Indexed(index) => match xterm256_rgb(index) {
            Some((r, g, b)) => format!("48;2;{r};{g};{b}"),
            None if index < 8 => format!("{}", 40 + u16::from(index)),
            None => format!("{}", 100 + u16::from(index) - 8),
        },
    }
}

/// The SGR of one run of `AnsiText`: every attribute and both colours written out, the default foreground being the text
/// colour of the theme.
fn run_sgr(style: &SgrStyle) -> String {
    let mut codes = vec!["0".to_owned()];
    for (on, code) in [(style.bold, "1"), (style.dim, "2"), (style.italic, "3"), (style.underline, "4"), (style.inverse, "7"), (style.strikethrough, "9")] {
        if on {
            codes.push(code.to_owned());
        }
    }
    codes.push(foreground_code(painted_foreground(style.foreground)));
    if let Some(background) = style.background {
        codes.push(background_code(background));
    }
    format!("\x1b[{}m", codes.join(";"))
}

/// `AnsiText`: text with SGR escapes as runs that carry their own colours and attributes, the colours the text names being
/// the theme's where `AnsiText` maps them, so a reset falls back to the text colour and not the terminal's own.
fn ansi_text(ansi: &str) -> String {
    let mut out = String::new();
    for (at, line) in parse_sgr(ansi).iter().enumerate() {
        if at > 0 {
            out.push('\n');
        }
        for run in &line.runs {
            if let Some(link) = &run.link {
                out.push_str(&format!("\x1b]8;{};{}\x07", link.parameters, link.uri));
            }
            out.push_str(&run_sgr(&run.style));
            out.push_str(&run.text);
            if run.link.is_some() {
                out.push_str("\x1b]8;;\x07");
            }
        }
    }
    out
}

/// The answer as `Markdown` lays it out: a block after another with one blank row between them, each wrapped to `width`.
/// A table is plain text (its own escapes pass through), every other block goes through [`ansi_text`]. Returns the rows.
fn paint_markdown(painter: &mut Painter, x: i32, y: i32, text: &str, columns: usize, width: usize) -> u16 {
    let layout_width = if columns == 0 { 80 } else { columns };
    let segments = render_token_ansi_segments(text, RenderOptions { width: layout_width, trim_partial_fences: false });
    let mut rows: u16 = 0;
    for (at, segment) in segments.iter().enumerate() {
        if at > 0 {
            rows += 1;
        }
        rows += match segment.ansi() {
            Some(ansi) => painter.text(x, y + i32::from(rows), &ansi_text(ansi), themed(Key::Text), width, TextWrap::Wrap),
            None => {
                let table = build_table_render(segment.token(), layout_width).join("\n");
                painter.text(x, y + i32::from(rows), &table, Style::default(), width, TextWrap::Wrap)
            }
        };
    }
    rows
}

/// Paints the panel with its top-left cell at `(x, y)`. Returns the rows it took.
pub fn paint_btw_panel(painter: &mut Painter, x: i32, y: i32, props: &BtwPanelProps, state: &BtwPanelState) -> u16 {
    let columns = props.columns;
    let inner = columns.saturating_sub(4);
    let cx = x + 2;
    let panel = props.panel;
    let body_rows = props.body_rows();
    let top = state.offset(props);
    let scrollable = props.max_offset() > 0;
    let mut used: u16 = 1;
    let title = format!("btw \u{b7} {}", template_text(field(Some(panel), "question")));
    used += put(painter, cx, y + i32::from(used), &title, themed(Key::PanelTitle), inner, TextWrap::TruncateEnd);
    // The body is a box of its own height that clips the answer, which starts `top` rows above it.
    let body_y = y + i32::from(used);
    let clip = if cx >= 0 && body_y >= 0 {
        Some(painter.push_clip(Rect::new(cx as u16, body_y as u16, inner.min(usize::from(u16::MAX)) as u16, body_rows.min(usize::from(u16::MAX)) as u16)))
    } else {
        None
    };
    let answer_y = body_y - top as i32;
    match status_of(panel) {
        "pending" => {
            put(painter, cx, answer_y, "answering\u{2026} (Esc to cancel)", themed(Key::Inactive), inner, TextWrap::Wrap);
        }
        "error" => {
            put(painter, cx, answer_y, &text_or_empty(field(Some(panel), "text")), themed(Key::Error), inner, TextWrap::Wrap);
        }
        _ => {
            paint_markdown(painter, cx, answer_y, &text_nullish(field(Some(panel), "text")), columns, inner);
        }
    }
    if let Some(previous) = clip {
        painter.pop_clip(previous);
    }
    used += body_rows.min(usize::from(u16::MAX)) as u16;
    let total = props.total();
    let position = if scrollable { format!("PgUp/PgDn scroll ({}-{}/{total}) \u{b7} ", top + 1, total.min(top + body_rows)) } else { String::new() };
    used += put(painter, cx, y + i32::from(used), &format!("{position}Esc to close \u{b7} not saved to the conversation"), themed(Key::Inactive), inner, TextWrap::Wrap);
    paint_frame(painter, x, y, columns, used + 1);
    used + 1
}

/// The rows the panel takes.
pub fn btw_panel_rows(props: &BtwPanelProps, state: &BtwPanelState) -> u16 {
    rows_of(props.columns, |painter| paint_btw_panel(painter, 0, 0, props, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;
    use mixdog_term::input::decode_key;
    use serde_json::json;

    fn screen(props: &BtwPanelProps, state: &BtwPanelState, rows: u16) -> Vec<String> {
        let mut grid = Grid::new(props.columns as u16, rows);
        let mut painter = Painter::new(&mut grid);
        paint_btw_panel(&mut painter, 0, 0, props, state);
        (0..rows).map(|row| grid.row_text(row).trim_end().to_owned()).collect()
    }

    fn long_answer() -> Value {
        let text: Vec<String> = (0..12).map(|n| format!("entry-{n}")).collect();
        json!({ "question": "why?", "status": "done", "text": text.join("\n") })
    }

    #[test]
    fn scroll_limits_and_pages_stay_inside_the_answer() {
        assert_eq!(btw_scroll_max(12, 5), 7);
        assert_eq!(btw_scroll_max(3, 5), 0);
        assert_eq!(btw_scroll_max(3, 0), 2);
        let (_, down) = decode_key("\x1b[6~");
        let (_, up) = decode_key("\x1b[5~");
        let (_, other) = decode_key("a");
        assert_eq!(btw_scroll_offset(&down, 0, 5, 12), 4);
        assert_eq!(btw_scroll_offset(&down, 4, 5, 12), 7);
        assert_eq!(btw_scroll_offset(&up, 7, 5, 12), 3);
        assert_eq!(btw_scroll_offset(&up, 2, 5, 12), 0);
        assert_eq!(btw_scroll_offset(&other, 9, 5, 12), 7);
    }

    #[test]
    fn an_answer_that_is_not_done_counts_its_lines() {
        assert_eq!(btw_content_rows(&json!({ "status": "pending", "text": "" }), 80), 1);
        assert_eq!(btw_content_rows(&json!({ "status": "error", "text": "a\nb\nc" }), 80), 3);
    }

    #[test]
    fn a_pending_panel_says_it_is_answering_and_an_error_shows_its_text() {
        let pending = json!({ "question": "why?", "status": "pending", "text": "" });
        let lines = screen(&BtwPanelProps::new(&pending), &BtwPanelState::new(), 6);
        assert!(lines[1].contains("btw \u{b7} why?"));
        assert!(lines[2].contains("answering\u{2026} (Esc to cancel)"));
        assert!(lines[3].contains("Esc to close \u{b7} not saved to the conversation"));
        assert!(!lines[3].contains("PgUp"));
        let failed = json!({ "question": "why?", "status": "error", "text": "side question failed" });
        assert!(screen(&BtwPanelProps::new(&failed), &BtwPanelState::new(), 6)[2].contains("side question failed"));
    }

    #[test]
    fn a_long_answer_scrolls_by_pages_and_shows_where_it_is() {
        let panel = long_answer();
        let props = BtwPanelProps { panel: &panel, columns: 80, panel_rows: Some(BTW_CHROME_ROWS + 5) };
        let mut state = BtwPanelState::new();
        let lines = screen(&props, &state, 9);
        assert!(lines[2].contains("entry-0"), "{lines:?}");
        assert!(!lines.join("\n").contains("entry-11"));
        assert!(lines[7].contains("PgUp/PgDn scroll (1-5/"), "{}", lines[7]);
        assert!(lines[7].contains("Esc to close \u{b7} not saved to the conversation"));
        let (_, down) = decode_key("\x1b[6~");
        let (_, up) = decode_key("\x1b[5~");
        for _ in 0..4 {
            state.handle_key(&down, &props);
        }
        assert!(screen(&props, &state, 9).join("\n").contains("entry-11"));
        for _ in 0..4 {
            state.handle_key(&up, &props);
        }
        assert_eq!(state.offset(&props), 0);
        let short = json!({ "question": "q", "status": "done", "text": "short" });
        let props = BtwPanelProps { panel: &short, columns: 80, panel_rows: Some(BTW_CHROME_ROWS + 5) };
        assert!(!screen(&props, &BtwPanelState::new(), 9).join("\n").contains("PgUp"));
    }

    #[test]
    fn a_new_question_or_status_starts_from_the_top() {
        let panel = long_answer();
        let props = BtwPanelProps { panel: &panel, columns: 80, panel_rows: Some(BTW_CHROME_ROWS + 5) };
        let mut state = BtwPanelState::new();
        let (_, down) = decode_key("\x1b[6~");
        state.handle_key(&down, &props);
        assert!(state.offset(&props) > 0);
        let next = json!({ "question": "another", "status": "done", "text": panel["text"] });
        let props = BtwPanelProps { panel: &next, ..props };
        state.sync(&props);
        assert_eq!(state.offset(&props), 0);
    }

    #[test]
    fn answer_text_keeps_its_attributes_and_falls_back_to_the_theme_colours() {
        let sgr = ansi_text("a\x1b[1mb\x1b[0mc\x1b[31md\x1b[0m\ne");
        let lines: Vec<&str> = sgr.split('\n').collect();
        assert_eq!(lines.len(), 2);
        let bold = lines[0].find("\x1b[0;1;").expect("a bold run");
        assert!(lines[0][bold..].contains('b'));
        // Red is the error colour of the theme, not the terminal's red.
        assert!(!sgr.contains("\x1b[0;31"));
        let named = ansi_text("\x1b[35mx");
        assert!(named.contains("\x1b[0;35m"));
        let background = ansi_text("\x1b[44mx");
        assert!(background.contains(";44m"));
        let cube = ansi_text("\x1b[38;5;196mx");
        assert!(cube.contains("38;2;255;0;0"));
    }
}
