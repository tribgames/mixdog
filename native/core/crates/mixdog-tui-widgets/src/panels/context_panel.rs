//! `components/ContextPanel.jsx`: the context window by category, as a bordered panel. With a context report (`detail` of
//! type `context`) it shows the used share of the window as a bar, the measurement source, the compaction state, the last
//! request and the categories as bars (or, when the core sent an inspection of the context, the inspector under the
//! source line); without one it lists the rows it was given.

use mixdog_js::math::{round, to_fixed};
use mixdog_js::{js_words, number_to_string, to_number_of, utf16_len, value_to_string};
use mixdog_term::frame::Style;
use mixdog_term::input::KeyFlags;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::Key;
use mixdog_view_model::display::context_measurement::{context_measurement_label, context_percent};
use serde_json::Value;

use crate::panel_cell_text::{cells, pad_panel_cells, truncate_panel_text};
use crate::panels::context_inspector::{InspectOutcome, InspectorEffect, InspectorProps, InspectorState, paint_context_inspector};
use crate::panels::{field, finite_number, is_nullish, paint_frame, put, rows_of, text_or_empty, truthy};
use crate::{Justify, basis, paint_split, split_row, themed};

/// The props of the panel.
#[derive(Clone, Debug)]
pub struct ContextPanelProps<'a> {
    /// The rows of the plain list (`{ value, label, description }`), used when `detail` is not a context report.
    pub rows: &'a [Value],
    pub title: String,
    pub columns: usize,
    /// The height the panel fills (`fillHeight`: the rows of its parent), or none for its own height.
    pub fill_height: Option<u16>,
    /// The context report (`{ type: "context", usage, compaction, messages, request, lastApi, cache, speed, inspection }`).
    pub detail: Option<&'a Value>,
    pub description: String,
    /// The rows the owner measured for the panel (0 when it did not).
    pub panel_rows: usize,
}

impl<'a> ContextPanelProps<'a> {
    pub fn new(rows: &'a [Value]) -> Self {
        Self { rows, title: "Context Usage".to_owned(), columns: 80, fill_height: None, detail: None, description: String::new(), panel_rows: 0 }
    }

    fn is_context_usage(&self) -> bool {
        field(self.detail, "type").and_then(Value::as_str) == Some("context")
    }

    /// The inspection of the report, when there is one to browse.
    fn inspection(&self) -> Option<&'a Value> {
        if !self.is_context_usage() {
            return None;
        }
        field(self.detail, "inspection").filter(|inspection| truthy(Some(*inspection)))
    }

    fn window_tokens(&self) -> f64 {
        finite_number(field(field(self.detail, "usage"), "windowTokens"))
    }

    fn inspector_props<'b>(&self, inspection: &'b Value) -> InspectorProps<'b> {
        let measured = if self.panel_rows == 0 { 26 } else { self.panel_rows };
        InspectorProps { inspection, columns: self.columns, rows: 3.max(measured.saturating_sub(10)), window_tokens: self.window_tokens() }
    }
}

/// The state of the panel: the inspector it mounts while the report carries an inspection, which starts over when the
/// revision of the inspection changes (`key={detail.inspection.revision}`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextPanelState {
    inspector: InspectorState,
    revision: Option<Value>,
}

impl ContextPanelState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The inspector, to read its state.
    pub fn inspector(&self) -> &InspectorState {
        &self.inspector
    }

    /// Follows the props: an inspector is mounted while there is an inspection and is a new one for a new revision.
    pub fn sync(&mut self, props: &ContextPanelProps) {
        let revision = props.inspection().map(|inspection| field(Some(inspection), "revision").cloned().unwrap_or(Value::Null));
        if revision != self.revision {
            self.inspector.unmount();
            self.inspector = InspectorState::new();
            self.revision = revision;
        }
    }

    /// One key: only the inspector listens.
    pub fn handle_key(&mut self, input: &str, key: &KeyFlags, props: &ContextPanelProps) -> InspectorEffect {
        self.sync(props);
        match props.inspection() {
            Some(inspection) => self.inspector.handle_key(input, key, &props.inspector_props(inspection)),
            None => InspectorEffect::None,
        }
    }

    /// The answer of the preview fetch `token` stands for.
    pub fn finish_inspect(&mut self, token: u64, outcome: InspectOutcome) {
        self.inspector.finish_inspect(token, outcome);
    }
}

/// `panelInnerWidth(columns)`: the text width inside the bordered, padded panel (never below 24 cells).
fn inner_width(columns: usize) -> usize {
    let columns = if columns == 0 { 80 } else { columns };
    24.max(columns.saturating_sub(4))
}

/// `formatTokens(value)`.
fn format_tokens(value: Option<f64>) -> String {
    let Some(n) = value else { return "\u{2014}".to_owned() };
    if n <= 0.0 {
        return "0".to_owned();
    }
    if n >= 1_000_000.0 {
        return format!("{}m", to_fixed(n / 1_000_000.0, if n >= 10_000_000.0 { 0 } else { 1 }));
    }
    if n >= 10_000.0 {
        return format!("{}k", number_to_string(round(n / 1000.0)));
    }
    if n >= 1000.0 {
        return format!("{}k", to_fixed(n / 1000.0, 1));
    }
    number_to_string(round(n))
}

/// `formatTokens(x.field)` of a field of a report: absent or null is a dash, anything else its finite number.
fn format_tokens_of(value: Option<&Value>) -> String {
    format_tokens(if is_nullish(value) { None } else { Some(finite_number(value)) })
}

/// `percent(value, total)`: the share clamped to 0..100, or none without a reading or a total.
fn percent(value: Option<f64>, total: f64) -> Option<f64> {
    let n = value?;
    if total <= 0.0 {
        return None;
    }
    Some((n / total * 100.0).min(100.0).max(0.0))
}

/// `percentLabel(value, total)`.
fn percent_label(value: Option<f64>, total: f64) -> String {
    if percent(value, total).is_none() {
        return "N/A".to_owned();
    }
    match context_percent(value, total) {
        Some(rounded) => format!("{}%", number_to_string(rounded)),
        None => "N/A%".to_owned(),
    }
}

/// `usageColor(pct)`: an unknown share reads 0.
fn usage_color(pct: Option<f64>) -> Key {
    let pct = pct.unwrap_or(0.0);
    if pct >= 95.0 {
        Key::Error
    } else if pct >= 80.0 {
        Key::Warning
    } else {
        Key::Success
    }
}

/// `ProgressBar`: a box `width` cells wide holding the filled cells and the empty ones as two texts. Returns its rows.
fn paint_progress_bar(painter: &mut Painter, x: i32, y: i32, value: Option<f64>, total: f64, width: usize) -> u16 {
    if width == 0 {
        return 0;
    }
    let pct = percent(value, total).unwrap_or(0.0);
    let filled = round(pct / 100.0 * width as f64).max(0.0).min(width as f64) as usize;
    let empty = width - filled;
    let left = ("\u{2588}".repeat(filled), themed(usage_color(Some(pct))));
    let right = ("\u{2591}".repeat(empty), themed(Key::Inactive));
    let modes = (TextWrap::Wrap, TextWrap::Wrap);
    match (filled > 0, empty > 0) {
        (true, true) => {
            let split = split_row(&left.0, &right.0, width, modes, Justify::Start);
            paint_split(painter, x, y, &split, &left, &right, modes)
        }
        (true, false) => put(painter, x, y, &left.0, left.1, basis(&left.0, width, TextWrap::Wrap), TextWrap::Wrap),
        _ => put(painter, x, y, &right.0, right.1, basis(&right.0, width, TextWrap::Wrap), TextWrap::Wrap),
    }
}

/// `metricValue(parts)`: the parts that say something, joined.
fn metric_value(parts: &[String]) -> String {
    parts.iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" \u{b7} ")
}

/// A part of a metric line: the text of a value that is set, nothing for one that is not (`value ? text : ''`).
fn part_of(value: Option<&Value>, text: impl FnOnce(&Value) -> String) -> String {
    match value {
        Some(value) if truthy(Some(value)) => text(value),
        _ => String::new(),
    }
}

/// `a !== b` of two JSON values (numbers compare by value).
fn strictly_differs(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() != y.as_f64(),
        _ => a != b,
    }
}

/// `bucketTokens(map, names)`: the tokens of the named buckets of a breakdown.
fn bucket_tokens(map: Option<&Value>, names: &[&str]) -> f64 {
    names.iter().map(|name| finite_number(field(field(map, name), "tokens"))).sum()
}

/// A row of two texts at `x`: the label column and the value (`DetailLine`).
fn paint_detail_line(painter: &mut Painter, x: i32, y: i32, label: &str, value: &str, columns: usize) -> u16 {
    let label_width = 10;
    let value_width = inner_width(columns).saturating_sub(label_width + 2);
    let mut at = x;
    at += painter.line(at, y, &pad_panel_cells(&truncate_panel_text(label, label_width), label_width), themed(Key::Subtle)) as i32;
    at += painter.line(at, y, " ", themed(Key::Inactive)) as i32;
    painter.line(at, y, &truncate_panel_text(value, value_width), themed(Key::Text));
    1
}

/// One category and its share as a bar (`CategoryItem`) in a row `width` cells wide. Returns its rows.
fn paint_category_item(painter: &mut Painter, x: i32, y: i32, label: &str, tokens: f64, total: f64, width: usize) -> u16 {
    let label_width = 11.min(7.max((width as f64 * 0.22).floor() as usize));
    let pct_width = 6;
    let flexible = width.saturating_sub(label_width + 1 + pct_width + 1);
    let token_width = 7.min(flexible);
    let bar_width = flexible - token_width;
    let pct = percent(Some(tokens), total);
    let mut at = x;
    at += painter.line(at, y, &pad_panel_cells(&truncate_panel_text(label, label_width), label_width), themed(Key::Subtle)) as i32;
    at += painter.line(at, y, " ", themed(Key::Inactive)) as i32;
    at += painter.line(at, y, &pad_panel_cells(&percent_label(Some(tokens), total), pct_width), themed(usage_color(pct))) as i32;
    let bar_rows = paint_progress_bar(painter, at, y, Some(tokens), total, bar_width);
    at += bar_width as i32;
    at += painter.line(at, y, " ", themed(Key::Inactive)) as i32;
    let shown = pad_panel_cells(&truncate_panel_text(&format_tokens(Some(tokens)), token_width), token_width);
    painter.line(at, y, &shown, themed(Key::Text));
    1.max(bar_rows)
}

/// A category of the grid: its label and the tokens it holds.
struct Category {
    label: &'static str,
    tokens: f64,
}

/// `CategoryGrid`: one column of categories, or two from 84 cells of interior on. Returns its rows.
fn paint_category_grid(painter: &mut Painter, x: i32, y: i32, categories: &[Category], columns: usize, total: f64) -> u16 {
    let inner = inner_width(columns);
    let mut rows: u16 = 0;
    if inner < 84 {
        for category in categories {
            rows += paint_category_item(painter, x, y + i32::from(rows), category.label, category.tokens, total, inner);
        }
        return rows;
    }
    let gap = 4;
    let left_width = (inner - gap) / 2;
    let right_width = inner - gap - left_width;
    for pair in categories.chunks(2) {
        let row_y = y + i32::from(rows);
        let mut height = paint_category_item(painter, x, row_y, pair[0].label, pair[0].tokens, total, left_width);
        if let Some(second) = pair.get(1) {
            let right_x = x + (left_width + gap) as i32;
            height = height.max(paint_category_item(painter, right_x, row_y, second.label, second.tokens, total, right_width));
        }
        rows += height;
    }
    rows
}

/// `ContextUsageView`: what a context report says. Returns its rows.
fn paint_usage_view(painter: &mut Painter, x: i32, y: i32, props: &ContextPanelProps, state: &ContextPanelState, detail: &Value) -> u16 {
    let columns = props.columns;
    let inner = inner_width(columns);
    let detail = Some(detail);
    let usage = field(detail, "usage");
    let compaction = field(detail, "compaction");
    let messages = field(detail, "messages");
    let request = field(detail, "request");
    let last_api = field(detail, "lastApi");
    let cache = field(detail, "cache");
    let semantic = field(messages, "semantic");
    let schema = field(request, "toolSchemaBreakdown");
    let used_tokens = if is_nullish(field(usage, "usedTokens")) { None } else { Some(finite_number(field(usage, "usedTokens"))) };
    let window_tokens = finite_number(field(usage, "windowTokens"));
    let raw_window_value = finite_number(field(usage, "rawWindowTokens"));
    let raw_window_tokens = if raw_window_value == 0.0 { window_tokens } else { raw_window_value };
    let free_tokens = match used_tokens {
        Some(used) if window_tokens != 0.0 => Some((window_tokens - used).max(0.0)),
        _ => None,
    };
    let used_pct = percent(used_tokens, window_tokens);
    let summary_text = format!(
        "{} / {} \u{b7} {} free",
        format_tokens(used_tokens),
        format_tokens(Some(window_tokens)),
        format_tokens(free_tokens)
    );
    let pct_text = if used_tokens.is_none() { "\u{2014}".to_owned() } else { format!("{} used", percent_label(used_tokens, window_tokens)) };
    let bar_width = 12.max(34.min(inner as i64 - cells(&summary_text) as i64 - cells(&pct_text) as i64 - 5)) as usize;
    let system_prompt_tokens = bucket_tokens(semantic, &["system", "workflow", "workspace", "environment", "other"]);
    let system_tools_tokens = bucket_tokens(schema, &["code", "web", "mutation", "channels", "setup", "other", "control", "session"]);
    let tokens_part = |key: &str, label: &str| part_of(field(compaction, key), |value| format!("{label} {}", format_tokens_of(Some(value))));
    let compaction_line = metric_value(&[
        part_of(field(compaction, "stage"), |value| if value.as_str() == Some("pending") { String::new() } else { value_to_string(value) }),
        part_of(field(compaction, "state"), value_to_string),
        part_of(field(compaction, "type"), |value| format!("type {}", value_to_string(value))),
        tokens_part("triggerTokens", "trigger"),
        tokens_part("boundaryTokens", "boundary"),
        tokens_part("pressureTokens", "pressure"),
        tokens_part("reserveTokens", "reserve"),
    ]);
    let speed = field(field(detail, "speed"), "outputTokensPerSecond");
    let speed_part = if is_nullish(speed) {
        String::new()
    } else {
        let n = to_number_of(speed);
        format!("{} tok/s", if n < 10.0 { to_fixed(n, 1) } else { number_to_string(round(n)) })
    };
    let raw_window = field(usage, "rawWindowTokens");
    let source_line = metric_value(&[
        context_measurement_label(field(usage, "measurementSource").and_then(Value::as_str).unwrap_or("")).to_owned(),
        if truthy(field(usage, "effective")) {
            format!("effective {}", format_tokens(Some(window_tokens)))
        } else {
            format!("window {}", format_tokens(Some(window_tokens)))
        },
        if truthy(raw_window) && strictly_differs(raw_window, field(usage, "windowTokens")) {
            format!("raw {}", format_tokens_of(raw_window))
        } else {
            String::new()
        },
        speed_part,
    ]);
    let raw_input = field(last_api, "rawInputTokens");
    let api_line = metric_value(&[
        format!("last ctx {}", format_tokens_of(field(last_api, "contextTokens"))),
        format!("uncached/out {}/{}", format_tokens_of(field(last_api, "inputTokens")), format_tokens_of(field(last_api, "outputTokens"))),
        if truthy(raw_input) && strictly_differs(raw_input, field(last_api, "inputTokens")) {
            format!("raw in {}", format_tokens_of(raw_input))
        } else {
            String::new()
        },
        part_of(field(cache, "writeTokens"), |value| format!("write {}", format_tokens_of(Some(value)))),
        format!("cache {}", if truthy(field(cache, "hitRate")) { text_or_empty(field(cache, "hitRate")) } else { "N/A".to_owned() }),
    ]);
    let mut categories = vec![
        Category { label: "System prompt", tokens: system_prompt_tokens },
        Category { label: "System tools", tokens: system_tools_tokens },
        Category { label: "MCP tools", tokens: bucket_tokens(schema, &["mcp"]) },
        Category { label: "Custom agents", tokens: bucket_tokens(schema, &["agents"]) },
        Category { label: "Memory files", tokens: bucket_tokens(semantic, &["memory"]) + bucket_tokens(schema, &["memory"]) },
        Category { label: "Skills", tokens: bucket_tokens(schema, &["skills"]) },
        Category { label: "Messages", tokens: bucket_tokens(semantic, &["chat", "assistant", "toolResults"]) },
        Category { label: "Reasoning tokens", tokens: bucket_tokens(semantic, &["reasoning"]) },
    ];
    let categorized_tokens: f64 = categories.iter().map(|category| category.tokens).sum();
    let category_window_tokens = raw_window_tokens.max(categorized_tokens);
    categories.push(Category { label: "Free space", tokens: (window_tokens - categorized_tokens).max(0.0) });

    let pct_width = 10.min(inner);
    let mut at = x;
    at += painter.line(at, y, &pad_panel_cells(&pct_text, pct_width), Style { bold: true, ..themed(usage_color(used_pct)) }) as i32;
    at += painter.line(at, y, " ", themed(Key::Inactive)) as i32;
    let bar_rows = paint_progress_bar(painter, at, y, used_tokens, window_tokens, bar_width);
    at += bar_width as i32;
    at += painter.line(at, y, " ", themed(Key::Inactive)) as i32;
    let summary_width = inner.saturating_sub(pct_width + bar_width + 3);
    painter.line(at, y, &truncate_panel_text(&summary_text, summary_width), themed(Key::Text));
    // The block under the bar starts one row below it (`marginTop={1}`).
    let mut rows: u16 = 1.max(bar_rows) + 1;
    if let Some(inspection) = props.inspection() {
        rows += put(painter, x, y + i32::from(rows), &truncate_panel_text(&source_line, inner), themed(Key::Subtle), inner, TextWrap::Wrap);
        let inspector = props.inspector_props(inspection);
        rows += paint_context_inspector(painter, x, y + i32::from(rows), &inspector, state.inspector());
    } else {
        rows += paint_detail_line(painter, x, y + i32::from(rows), "Source", &source_line, columns);
        rows += paint_detail_line(painter, x, y + i32::from(rows), "Compaction", &compaction_line, columns);
        rows += paint_detail_line(painter, x, y + i32::from(rows), "API/cache", &api_line, columns);
        rows += 1;
        rows += put(painter, x, y + i32::from(rows), "Estimated usage by category", themed(Key::Subtle), inner, TextWrap::Wrap);
        rows += 1;
        rows += paint_category_grid(painter, x, y + i32::from(rows), &categories, columns, category_window_tokens);
    }
    rows
}

/// `panelDescription`: the description with its blanks collapsed, or the line a context report brings, truncated.
fn panel_description(props: &ContextPanelProps) -> String {
    let fallback = if props.inspection().is_some() {
        "Current context snapshot. R refresh \u{b7} Enter inspect."
    } else if props.is_context_usage() {
        "Live context window usage by category."
    } else {
        ""
    };
    let source = if props.description.is_empty() { fallback } else { props.description.as_str() };
    let collapsed = js_words(source).collect::<Vec<_>>().join(" ");
    truncate_panel_text(&collapsed, props.columns.saturating_sub(4))
}

/// Paints the panel with its top-left cell at `(x, y)`. Returns the rows it took.
pub fn paint_context_panel(painter: &mut Painter, x: i32, y: i32, props: &ContextPanelProps, state: &ContextPanelState) -> u16 {
    let columns = props.columns;
    let inner = columns.saturating_sub(4);
    let cx = x + 2;
    let modes = (TextWrap::Wrap, TextWrap::Wrap);
    let title = split_row(&props.title, "Esc back", inner, modes, Justify::Between);
    let left = (props.title.clone(), themed(Key::PanelTitle));
    let right = ("Esc back".to_owned(), themed(Key::Subtle));
    let mut rows: u16 = 1 + paint_split(painter, cx, y + 1, &title, &left, &right, modes);
    // A blank row, the description row (a blank when there is none), a blank row.
    rows += 1;
    let description = panel_description(props);
    let shown = if description.is_empty() { " " } else { description.as_str() };
    rows += painter.text(cx, y + i32::from(rows), shown, themed(Key::Subtle), inner, TextWrap::Wrap);
    rows += 1;
    if props.is_context_usage() {
        if let Some(detail) = props.detail {
            rows += paint_usage_view(painter, cx, y + i32::from(rows), props, state, detail);
        }
    } else {
        let widest = props.rows.iter().map(|row| utf16_len(&text_or_empty(field(Some(row), "label")))).max().unwrap_or(0);
        let label_width = widest.min(12.max((columns as f64 * 0.24).floor() as usize));
        let value_width = columns.saturating_sub(label_width + 8);
        for row in props.rows {
            let row_y = y + i32::from(rows);
            let mut at = cx;
            let label = pad_panel_cells(&truncate_panel_text(&text_or_empty(field(Some(row), "label")), label_width), label_width);
            at += painter.line(at, row_y, &label, themed(Key::Inactive)) as i32;
            let value = format!("  {}", truncate_panel_text(&text_or_empty(field(Some(row), "description")), value_width));
            painter.line(at, row_y, &value, themed(Key::Text));
            rows += 1;
        }
    }
    let height = props.fill_height.unwrap_or(rows + 1);
    paint_frame(painter, x, y, columns, height);
    height
}

/// The rows the panel takes.
pub fn context_panel_rows(props: &ContextPanelProps, state: &ContextPanelState) -> u16 {
    rows_of(props.columns, |painter| paint_context_panel(painter, 0, 0, props, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::Grid;
    use serde_json::json;

    fn screen(props: &ContextPanelProps, state: &ContextPanelState, rows: u16) -> Vec<String> {
        let mut grid = Grid::new(props.columns as u16, rows);
        let mut painter = Painter::new(&mut grid);
        paint_context_panel(&mut painter, 0, 0, props, state);
        (0..rows).map(|row| grid.row_text(row).trim_end().to_owned()).collect()
    }

    #[test]
    fn tokens_are_written_the_way_the_dashboard_writes_them() {
        assert_eq!(format_tokens(None), "\u{2014}");
        assert_eq!(format_tokens(Some(0.0)), "0");
        assert_eq!(format_tokens(Some(999.4)), "999");
        assert_eq!(format_tokens(Some(1500.0)), "1.5k");
        assert_eq!(format_tokens(Some(12_400.0)), "12k");
        assert_eq!(format_tokens(Some(1_250_000.0)), "1.3m");
        assert_eq!(format_tokens(Some(12_000_000.0)), "12m");
    }

    #[test]
    fn shares_clamp_and_an_unknown_one_reads_as_the_calm_colour() {
        assert_eq!(percent_label(Some(500.0), 1000.0), "50%");
        assert_eq!(percent_label(Some(999.0), 1000.0), "99.9%");
        assert_eq!(percent_label(Some(5.0), 0.0), "N/A");
        assert_eq!(percent_label(None, 10.0), "N/A");
        assert_eq!(percent(Some(2000.0), 1000.0), Some(100.0));
        assert_eq!(usage_color(None), Key::Success);
        assert_eq!(usage_color(Some(80.0)), Key::Warning);
        assert_eq!(usage_color(Some(95.0)), Key::Error);
    }

    #[test]
    fn a_plain_list_shows_its_rows_under_the_title() {
        let rows = vec![json!({ "value": "a", "label": "Model", "description": "claude" }), json!({ "label": "Window", "description": "200k" })];
        let mut props = ContextPanelProps::new(&rows);
        props.columns = 50;
        let lines = screen(&props, &ContextPanelState::new(), 9);
        assert!(lines[0].starts_with('\u{256d}'));
        assert!(lines[1].contains("Context Usage") && lines[1].contains("Esc back"));
        assert!(lines[5].contains("Model") && lines[5].contains("claude"));
        assert!(lines[6].contains("Window") && lines[6].contains("200k"));
        assert!(lines[7].starts_with('\u{2570}'));
        assert_eq!(context_panel_rows(&props, &ContextPanelState::new()), 8);
    }

    #[test]
    fn a_context_report_shows_the_bar_the_source_and_the_categories() {
        let detail = json!({
            "type": "context",
            "usage": { "usedTokens": 500, "windowTokens": 1000, "rawWindowTokens": 1200, "measurementSource": "last_api_request" },
            "messages": { "semantic": { "system": { "tokens": 100 }, "chat": { "tokens": 150 } } },
            "request": { "toolSchemaBreakdown": { "mcp": { "tokens": 50 } } },
            "lastApi": { "contextTokens": 500, "inputTokens": 40, "outputTokens": 9 },
            "cache": { "hitRate": "75%" },
        });
        let rows: Vec<Value> = Vec::new();
        let mut props = ContextPanelProps::new(&rows);
        props.columns = 80;
        props.detail = Some(&detail);
        let text = screen(&props, &ContextPanelState::new(), 30).join("\n");
        assert!(text.contains("50% used") && text.contains("500 / 1.0k \u{b7} 500 free"), "{text}");
        assert!(text.contains("Last measured input \u{b7} window 1.0k \u{b7} raw 1.2k"), "{text}");
        assert!(text.contains("last ctx 500 \u{b7} uncached/out 40/9 \u{b7} cache 75%"), "{text}");
        assert!(text.contains("Live context window usage by category."), "{text}");
        assert!(text.contains("System pro\u{2026}") && text.contains("MCP tools") && text.contains("Free space"), "{text}");
        // 100 of 1200 for the system prompt, the raw window being the scale.
        assert!(text.contains("8.3%"), "{text}");
    }

    #[test]
    fn an_inspection_mounts_the_inspector_and_a_new_revision_starts_it_over() {
        let detail = json!({
            "type": "context",
            "inspection": { "revision": "a", "categories": [{ "key": "system", "label": "System prompt", "tokens": 20 }], "entries": [] },
            "usage": { "usedTokens": 30, "windowTokens": 100 },
        });
        let rows: Vec<Value> = Vec::new();
        let mut props = ContextPanelProps::new(&rows);
        props.columns = 60;
        props.panel_rows = 22;
        props.detail = Some(&detail);
        let mut state = ContextPanelState::new();
        let (input, key) = mixdog_term::input::decode_key("\r");
        state.handle_key(&input, &key, &props);
        assert_eq!(state.inspector().category(), "system");
        let text = screen(&props, &state, 24).join("\n");
        assert!(text.contains("Current context snapshot. R refresh"), "{text}");
        assert!(text.contains("No entries."), "{text}");
        let other = json!({
            "type": "context",
            "inspection": { "revision": "b", "categories": [], "entries": [] },
            "usage": { "usedTokens": 30, "windowTokens": 100 },
        });
        props.detail = Some(&other);
        state.sync(&props);
        assert_eq!(state.inspector().category(), "");
    }

    #[test]
    fn the_description_collapses_blanks_and_is_cut_to_the_panel() {
        let rows: Vec<Value> = Vec::new();
        let mut props = ContextPanelProps::new(&rows);
        props.columns = 30;
        props.description = "  one   two\n three ".to_owned();
        assert_eq!(panel_description(&props), "one two three");
        props.description = "x".repeat(40);
        assert_eq!(cells(&panel_description(&props)), 26);
    }

    #[test]
    fn a_bar_without_width_is_nothing() {
        let mut grid = Grid::new(20, 1);
        let mut painter = Painter::new(&mut grid);
        assert_eq!(paint_progress_bar(&mut painter, 0, 0, Some(50.0), 100.0, 0), 0);
        assert!(paint_progress_bar(&mut painter, 0, 0, Some(50.0), 100.0, 4) >= 1);
    }
}
