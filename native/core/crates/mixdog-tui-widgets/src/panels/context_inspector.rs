//! `components/ContextInspector.jsx`: the browser of what the context holds. A list of categories under a map of the
//! window, a list of the entries of one category, and the preview of one entry (fetched on Enter, scrolled with the arrow
//! keys, never kept after leaving it).
//!
//! The component keeps its category, selection, preview, scroll and zoom, and a request counter that discards the answer of
//! a preview that was left before it came back: [`InspectorState`] holds the same, [`InspectorState::handle_key`] returns
//! what the owner has to do (fetch a preview, refresh the snapshot) and [`InspectorState::finish_inspect`] takes the answer
//! of a fetch.

use mixdog_js::math::to_fixed;
use mixdog_js::to_number_of;
use mixdog_term::frame::{Rect, Style};
use mixdog_term::input::KeyFlags;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};
use mixdog_tui_style::Key;
use mixdog_view_model::display::context_inspection::{CategoryTokens, ContextMapOptions, build_context_map};
use serde_json::Value;

use crate::panel_cell_text::cells;
use crate::panels::{field, items, put, template_text, text_or_empty, truthy};
use crate::themed;

/// What the preview of an entry says while it loads.
const LOADING: &str = "Loading preview\u{2026}";

/// The props of the inspector.
#[derive(Clone, Copy, Debug)]
pub struct InspectorProps<'a> {
    /// `{ revision, categories, entries, calibration }` of the core's context inspection.
    pub inspection: &'a Value,
    pub columns: usize,
    /// The rows the inspector takes (`rows = 16`).
    pub rows: usize,
    pub window_tokens: f64,
}

impl InspectorProps<'_> {
    /// The cells of a line: the panel's interior.
    fn width(&self) -> usize {
        4.max(self.columns.saturating_sub(4))
    }

    fn visible_rows(&self, in_category: bool) -> usize {
        1.max(self.rows.saturating_sub(if in_category { 3 } else { 7 }))
    }

    fn preview_rows(&self) -> usize {
        1.max(self.rows.saturating_sub(2))
    }
}

/// A preview of an entry: its text and whether the core cut it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

impl Preview {
    fn message(text: &str) -> Self {
        Self { text: text.to_owned(), truncated: false }
    }
}

/// What the owner does after a key.
#[derive(Clone, Debug, PartialEq)]
pub enum InspectorEffect {
    None,
    /// `onRefresh()`.
    Refresh,
    /// `onInspect(id, revision)`: fetch the preview and give the answer to [`InspectorState::finish_inspect`] with `token`.
    Inspect { id: Value, revision: Value, token: u64 },
}

/// How a fetch of a preview ended.
#[derive(Clone, Debug, PartialEq)]
pub enum InspectOutcome {
    /// What `onInspect` resolved to: an object (`{ text, truncated }` or `{ stale: true }`), or nothing.
    Answer(Option<Value>),
    /// `onInspect` threw.
    Failed,
}

/// The state of an inspector (`category`, `index`, `preview`, `scroll`, `fit` and the request counter).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InspectorState {
    category: String,
    index: usize,
    preview: Option<Preview>,
    scroll: usize,
    fit: bool,
    request: u64,
}

impl InspectorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The category being browsed (empty at the list of categories).
    pub fn category(&self) -> &str {
        &self.category
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn preview(&self) -> Option<&Preview> {
        self.preview.as_ref()
    }

    pub fn scroll(&self) -> usize {
        self.scroll
    }

    pub fn fit(&self) -> bool {
        self.fit
    }

    /// The component unmounted (a new revision mounts a fresh one in its place): it starts over, and an answer of a fetch
    /// asked for before comes back to a request counter that has moved on, so it is dropped, also by the fresh one.
    pub fn unmount(&mut self) {
        *self = Self { request: self.request + 1, ..Self::default() };
    }

    fn choices<'a>(&self, props: &InspectorProps<'a>) -> Vec<&'a Value> {
        if self.category.is_empty() {
            items(field(Some(props.inspection), "categories")).iter().collect()
        } else {
            items(field(Some(props.inspection), "entries"))
                .iter()
                .filter(|entry| entry.get("category").is_some_and(|category| category.as_str() == Some(self.category.as_str())))
                .collect()
        }
    }

    fn preview_lines(&self, width: usize) -> Vec<String> {
        match &self.preview {
            Some(preview) => wrap_ansi(&preview.text, width, WrapOptions { hard: true, word_wrap: true, trim: false })
                .split('\n')
                .map(str::to_owned)
                .collect(),
            None => Vec::new(),
        }
    }

    /// `openEntry`: Enter on a category opens it, Enter on an entry asks for its preview.
    fn open_entry(&mut self, props: &InspectorProps) -> InspectorEffect {
        let choices = self.choices(props);
        let Some(entry) = choices.get(self.index).copied() else { return InspectorEffect::None };
        if self.category.is_empty() {
            self.category = text_or_empty(field(Some(entry), "key"));
            self.index = 0;
            return InspectorEffect::None;
        }
        self.request += 1;
        self.scroll = 0;
        self.preview = Some(Preview::message(LOADING));
        InspectorEffect::Inspect {
            id: field(Some(entry), "id").cloned().unwrap_or(Value::Null),
            revision: field(Some(props.inspection), "revision").cloned().unwrap_or(Value::Null),
            token: self.request,
        }
    }

    /// The answer of the fetch `token` asked for. An answer of a preview that was left meanwhile is dropped.
    pub fn finish_inspect(&mut self, token: u64, outcome: InspectOutcome) {
        if self.request != token {
            return;
        }
        self.preview = Some(match outcome {
            InspectOutcome::Failed => Preview::message("Preview unavailable. Press R to retry."),
            InspectOutcome::Answer(answer) => match answer.as_ref().filter(|answer| truthy(Some(*answer))) {
                Some(answer) if truthy(field(Some(answer), "stale")) => Preview::message("Context changed. Press R to refresh."),
                Some(answer) => {
                    Preview { text: text_or_empty(field(Some(answer), "text")), truncated: truthy(field(Some(answer), "truncated")) }
                }
                None => Preview::message("Preview unavailable."),
            },
        });
    }

    /// One key (`useInput`).
    pub fn handle_key(&mut self, input: &str, key: &KeyFlags, props: &InspectorProps) -> InspectorEffect {
        if input == "r" {
            return InspectorEffect::Refresh;
        }
        if input == "z" && self.category.is_empty() && self.preview.is_none() {
            self.fit = !self.fit;
            return InspectorEffect::None;
        }
        if key.backspace || key.left_arrow {
            self.request += 1;
            if self.preview.is_some() {
                self.preview = None;
            } else {
                self.category.clear();
                self.index = 0;
            }
            return InspectorEffect::None;
        }
        if key.return_key && self.preview.is_none() {
            return self.open_entry(props);
        }
        let visible = props.visible_rows(!self.category.is_empty()) as i64;
        let delta: i64 = if key.up_arrow {
            -1
        } else if key.down_arrow {
            1
        } else if key.page_up {
            -visible
        } else if key.page_down {
            visible
        } else {
            0
        };
        if delta == 0 {
            return InspectorEffect::None;
        }
        if self.preview.is_some() {
            let lines = self.preview_lines(props.width()).len() as i64;
            let max = (lines - props.preview_rows() as i64).max(0);
            self.scroll = (self.scroll as i64 + delta).min(max).max(0) as usize;
        } else {
            let last = self.choices(props).len() as i64 - 1;
            self.index = (self.index as i64 + delta).min(last).max(0) as usize;
        }
        InspectorEffect::None
    }
}

/// `fitLine(text, width)`: the longest start of the text that is at most `width` cells wide.
pub(crate) fn fit_line(text: &str, width: usize) -> String {
    let mut result = String::new();
    for character in text.chars() {
        result.push(character);
        if cells(&result) > width {
            result.pop();
            break;
        }
    }
    result
}

/// `Number.prototype.toLocaleString()` (en-US) of a count: digits grouped by thousands, at most three decimals.
pub(crate) fn locale_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value < 0.0 { "-\u{221e}" } else { "\u{221e}" }.to_owned();
    }
    let fixed = to_fixed(value.abs(), 3);
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let fraction = fraction.trim_end_matches('0');
    let mut grouped = String::new();
    for (at, digit) in whole.chars().enumerate() {
        if at > 0 && (whole.len() - at) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let sign = if value < 0.0 && (grouped != "0" || !fraction.is_empty()) { "-" } else { "" };
    if fraction.is_empty() { format!("{sign}{grouped}") } else { format!("{sign}{grouped}.{fraction}") }
}

/// The SGR code and glyph a map cell is drawn with (`COLORS` and `cellGlyph`): a key without a colour is drawn plain.
fn map_cell(key: &str) -> String {
    let code = match key {
        "system" | "free" => "90",
        "tools" => "32",
        "mcp" | "agents" => "35",
        "memory" => "36",
        "skills" => "33",
        "user" => "34",
        "assistant" => "94",
        "reasoning" => "93",
        "toolResults" => "92",
        "attachments" => "91",
        _ => "",
    };
    let glyph = if key == "free" { "\u{b7}" } else { "\u{25a0}" };
    if code.is_empty() { glyph.to_owned() } else { format!("\x1b[{code}m{glyph}\x1b[39m") }
}

/// The text and colour of a row of the list (`renderChoice`).
fn choice_line(row: &Value, selected: bool, width: usize) -> (String, Style) {
    let state = field(Some(row), "state");
    let deferred = state.and_then(Value::as_str) == Some("deferred");
    // The selected row is `theme.accent`, which no theme defines: Ink gets no colour and draws it in the terminal's own.
    let style = if selected {
        Style::default()
    } else if deferred {
        themed(Key::Subtle)
    } else {
        themed(Key::Text)
    };
    let size = if deferred { "deferred".to_owned() } else { format!("\u{2248}{}", locale_number(to_number_of(field(Some(row), "tokens")))) };
    let state_note = match state {
        Some(state) if truthy(Some(state)) && state.as_str() != Some("deferred") && state.as_str() != Some("active") => {
            format!(" \u{b7} {}", template_text(Some(state)))
        }
        _ => String::new(),
    };
    let tool_results = items(field(Some(row), "toolResults"));
    let tool_note = if tool_results.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = tool_results
            .iter()
            .map(|result| match field(Some(result), "name") {
                None | Some(Value::Null) => String::new(),
                Some(name) => mixdog_js::value_to_string(name),
            })
            .collect();
        format!(" \u{b7} {}", names.join(", "))
    };
    let count = field(Some(row), "count");
    let count_note = if count.is_some() { format!(" \u{b7} {} items", template_text(count)) } else { String::new() };
    let mark = if selected { "\u{203a}" } else { " " };
    let text = format!("{mark} {} \u{b7} {size}{state_note}{tool_note}{count_note}", template_text(field(Some(row), "label")));
    (fit_line(&text, width), style)
}

/// The label of the calibration line.
fn calibration_label(calibration: Option<&Value>) -> String {
    if field(calibration, "source").and_then(Value::as_str) == Some("provider") {
        let number = |key: &str, fallback: f64| {
            let value = field(calibration, key);
            if truthy(value) { to_number_of(value) } else { fallback }
        };
        format!(
            "Scaled to measured {} (\u{d7}{}) \u{b7} raw \u{2248}{}",
            locale_number(number("measuredTokens", 0.0)),
            to_fixed(number("ratio", 1.0), 2),
            locale_number(number("estimatedTokens", 0.0)),
        )
    } else {
        "Local estimates \u{b7} no provider reading covers this transcript yet".to_owned()
    }
}

/// Paints the inspector with its top-left cell at `(x, y)`: a box `rows` rows high that clips what does not fit. Returns
/// its rows.
pub fn paint_context_inspector(painter: &mut Painter, x: i32, y: i32, props: &InspectorProps, state: &InspectorState) -> u16 {
    let rows = 1.max(props.rows).min(usize::from(u16::MAX));
    let width = props.width();
    let previous = if x >= 0 && y >= 0 {
        let area_width = props.columns.saturating_sub(4).min(usize::from(u16::MAX));
        Some(painter.push_clip(Rect::new(x as u16, y as u16, area_width as u16, rows as u16)))
    } else {
        None
    };
    let subtle = themed(Key::Subtle);
    let mut at = y;
    let mut line = |painter: &mut Painter, text: &str, style: Style| {
        at += i32::from(put(painter, x, at, text, style, width, TextWrap::Wrap));
    };
    line(painter, &fit_line("\u{2191}\u{2193} select \u{b7} Enter inspect \u{b7} \u{2190} back \u{b7} Z zoom \u{b7} R refresh", width), subtle);
    if let Some(preview) = state.preview() {
        let note = if preview.truncated { "Preview limited to 32,000 characters." } else { "Local preview \u{b7} opaque data excluded" };
        line(painter, &fit_line(note, width), subtle);
        let lines = state.preview_lines(width);
        for text in lines.iter().skip(state.scroll()).take(props.preview_rows()) {
            line(painter, if text.is_empty() { " " } else { text.as_str() }, Style::default());
        }
    } else {
        let categories = items(field(Some(props.inspection), "categories"));
        let in_category = !state.category().is_empty();
        if in_category {
            let label = categories
                .iter()
                .find(|row| row.get("key").is_some_and(|key| key.as_str() == Some(state.category())))
                .map(|row| text_or_empty(field(Some(row), "label")))
                .unwrap_or_default();
            line(painter, &fit_line(&label, width), Style { bold: true, ..Style::default() });
        } else {
            let map_columns = 4.max(32.min(width));
            let tokens: Vec<CategoryTokens> = categories
                .iter()
                .map(|category| CategoryTokens {
                    key: text_or_empty(field(Some(category), "key")),
                    tokens: to_number_of(field(Some(category), "tokens")),
                })
                .collect();
            let map = build_context_map(
                &tokens,
                ContextMapOptions { window_tokens: props.window_tokens, cells: (map_columns * 3) as f64, fit: state.fit() },
            );
            let overflow = if map.overflow { " \u{b7} over window" } else { "" };
            let composition = format!("Estimated composition \u{b7} {}{overflow}", if state.fit() { "Fit" } else { "Window" });
            line(painter, &fit_line(&composition, width), subtle);
            for row in 0..3 {
                let start = (row * map_columns).min(map.cells.len());
                let end = ((row + 1) * map_columns).min(map.cells.len());
                let painted: String = map.cells[start..end].iter().map(|key| map_cell(key)).collect();
                line(painter, &painted, Style::default());
            }
            line(painter, &fit_line("\u{b7} free", width), subtle);
            line(painter, &fit_line(&calibration_label(field(Some(props.inspection), "calibration")), width), subtle);
        }
        let choices = state.choices(props);
        let visible = props.visible_rows(in_category);
        let start = (state.index() + 1).saturating_sub(visible);
        for (offset, row) in choices.iter().skip(start).take(visible).enumerate() {
            let (text, style) = choice_line(row, state.index() == start + offset, width);
            line(painter, &text, style);
        }
        if choices.is_empty() {
            line(painter, "No entries.", subtle);
        }
    }
    if let Some(previous) = previous {
        painter.pop_clip(previous);
    }
    rows as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::input::decode_key;
    use serde_json::json;

    fn inspection() -> Value {
        json!({
            "revision": "r1",
            "categories": [
                { "key": "system", "label": "System prompt", "tokens": 20, "count": 1 },
                { "key": "tools", "label": "System tools", "tokens": 5 },
            ],
            "entries": [
                { "id": "message:0", "category": "system", "label": "Instructions", "tokens": 20 },
                { "id": "tool:1", "category": "tools", "label": "Bash", "tokens": 5, "state": "deferred" },
            ],
        })
    }

    fn props(inspection: &Value) -> InspectorProps<'_> {
        InspectorProps { inspection, columns: 40, rows: 12, window_tokens: 100.0 }
    }

    fn press(state: &mut InspectorState, sequence: &str, props: &InspectorProps) -> InspectorEffect {
        let (input, key) = decode_key(sequence);
        state.handle_key(&input, &key, props)
    }

    #[test]
    fn enter_opens_a_category_then_asks_for_the_preview_of_an_entry() {
        let value = inspection();
        let props = props(&value);
        let mut state = InspectorState::new();
        assert_eq!(press(&mut state, "\r", &props), InspectorEffect::None);
        assert_eq!(state.category(), "system");
        let effect = press(&mut state, "\r", &props);
        assert_eq!(effect, InspectorEffect::Inspect { id: json!("message:0"), revision: json!("r1"), token: 1 });
        assert_eq!(state.preview().map(|preview| preview.text.as_str()), Some("Loading preview\u{2026}"));
        state.finish_inspect(1, InspectOutcome::Answer(Some(json!({ "text": "hello", "truncated": true }))));
        assert_eq!(state.preview(), Some(&Preview { text: "hello".to_owned(), truncated: true }));
    }

    #[test]
    fn an_answer_of_a_preview_that_was_left_is_dropped() {
        let value = inspection();
        let props = props(&value);
        let mut state = InspectorState::new();
        press(&mut state, "\r", &props);
        press(&mut state, "\r", &props);
        press(&mut state, "\x1b[D", &props);
        assert!(state.preview().is_none());
        state.finish_inspect(1, InspectOutcome::Answer(Some(json!({ "text": "late" }))));
        assert!(state.preview().is_none());
        assert_eq!(state.category(), "system");
        press(&mut state, "\x1b[D", &props);
        assert_eq!(state.category(), "");
    }

    #[test]
    fn the_answers_a_fetch_can_end_with_are_the_four_messages() {
        let mut state = InspectorState::new();
        let mut say = |outcome: InspectOutcome| {
            state.request = 7;
            state.finish_inspect(7, outcome);
            state.preview().map(|preview| preview.text.clone()).unwrap_or_default()
        };
        assert_eq!(say(InspectOutcome::Answer(Some(json!({ "stale": true })))), "Context changed. Press R to refresh.");
        assert_eq!(say(InspectOutcome::Answer(None)), "Preview unavailable.");
        assert_eq!(say(InspectOutcome::Failed), "Preview unavailable. Press R to retry.");
        assert_eq!(say(InspectOutcome::Answer(Some(json!({})))), "");
    }

    #[test]
    fn r_refreshes_z_zooms_only_on_the_category_list_and_arrows_stay_in_range() {
        let value = inspection();
        let props = props(&value);
        let mut state = InspectorState::new();
        assert_eq!(press(&mut state, "r", &props), InspectorEffect::Refresh);
        press(&mut state, "z", &props);
        assert!(state.fit());
        press(&mut state, "\x1b[B", &props);
        press(&mut state, "\x1b[B", &props);
        assert_eq!(state.index(), 1);
        press(&mut state, "\x1b[A", &props);
        press(&mut state, "\x1b[A", &props);
        assert_eq!(state.index(), 0);
        press(&mut state, "\r", &props);
        press(&mut state, "z", &props);
        assert!(state.fit());
    }

    #[test]
    fn the_preview_scrolls_within_its_wrapped_lines() {
        let value = inspection();
        let props = InspectorProps { rows: 5, ..props(&value) };
        let mut state = InspectorState::new();
        press(&mut state, "\r", &props);
        press(&mut state, "\r", &props);
        state.finish_inspect(1, InspectOutcome::Answer(Some(json!({ "text": "a\nb\nc\nd\ne\nf" }))));
        for _ in 0..10 {
            press(&mut state, "\x1b[B", &props);
        }
        // Six lines through three rows.
        assert_eq!(state.scroll(), 3);
        press(&mut state, "\x1b[5~", &props);
        assert_eq!(state.scroll(), 1);
    }

    #[test]
    fn numbers_are_grouped_and_lines_fitted_by_cells() {
        assert_eq!(locale_number(1234567.0), "1,234,567");
        assert_eq!(locale_number(1234.5), "1,234.5");
        assert_eq!(locale_number(0.0), "0");
        assert_eq!(locale_number(-12000.0), "-12,000");
        assert_eq!(fit_line("abcdef", 4), "abcd");
        assert_eq!(fit_line("\u{65e5}\u{672c}\u{8a9e}", 5), "\u{65e5}\u{672c}");
    }

    #[test]
    fn a_choice_row_says_size_state_tools_and_count() {
        let row = json!({ "label": "Tool results", "tokens": 1500, "state": "stale", "toolResults": [{ "name": "Bash" }, { "name": "Read" }], "count": 3 });
        let (text, _) = choice_line(&row, true, 100);
        assert_eq!(text, "\u{203a} Tool results \u{b7} \u{2248}1,500 \u{b7} stale \u{b7} Bash, Read \u{b7} 3 items");
        let deferred = json!({ "label": "Bash", "tokens": 5, "state": "deferred" });
        assert_eq!(choice_line(&deferred, false, 100).0, "  Bash \u{b7} deferred");
    }
}
