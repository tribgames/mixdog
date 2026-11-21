//! `design/xlsx/design-xlsx.mjs`, the sheet's layout and its sections: the canvas geometry every band shares, the
//! metric cards, the data table with its number formats, the chart, the decision panel and the print set-up.

use std::sync::LazyLock;

use mixdog_js::math::to_fixed;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::values::{plain_object, truthy};
use serde_json::Value;

use super::components::{Panel, Tokens, add_xlsx_decision_panel, col, num, operation, props, text_value};
use crate::content_model::office_number_format;
use crate::tokens::strings;
use crate::{opt_prop, prop, text};

static FIGURE_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?$", ""));
static ISO_DATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d{4}-\d{2}-\d{2}$", ""));
static HEADER_UNIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\(([^()]+)\)\s*$", ""));
static EXCEL_TOTAL_ROW: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))", "i"));
static TABLE_AGGREGATE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^=\s*(SUM|AVERAGE|MAX|MIN|COUNT)\s*\(\s*[^\[\]()]*\[([^\]]+)\]\s*\)\s*$", "i"));
static LATIN_UNIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z(]", ""));
static LEADING_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z_]", ""));

fn is_wide(c: char) -> bool {
    matches!(
        c,
        '\u{1100}'..='\u{115F}' | '\u{2E80}'..='\u{A4CF}' | '\u{AC00}'..='\u{D7A3}' | '\u{F900}'..='\u{FAFF}' | '\u{FE30}'..='\u{FE6F}' | '\u{FF00}'..='\u{FF60}' | '\u{FFE0}'..='\u{FFE6}'
    )
}

/// `displayWidth`: Hangul, CJK and fullwidth forms take two character cells of a column.
pub(super) fn display_width(text: &str) -> f64 {
    text.chars().map(|c| if is_wide(c) { 2.0 } else { 1.0 }).sum()
}

pub(super) fn truthy_of(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `Number(value) || fallback`.
pub(super) fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() || number == 0.0 { fallback } else { number }
}

/// `row?.[index]` of a row the caller wrote: a list's element, a text's UTF-16 unit, an object's numbered member.
fn indexed(row: &Value, index: usize) -> Option<Value> {
    match row {
        Value::Array(items) => items.get(index).cloned(),
        Value::String(written) => written.encode_utf16().nth(index).map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        Value::Object(members) => members.get(&index.to_string()).cloned(),
        _ => None,
    }
}

/// `Number(Array.isArray(row) ? row[index] : NaN)`.
fn array_number(row: &Value, index: usize) -> f64 {
    match row {
        Value::Array(items) => to_number_of(items.get(index)),
        _ => f64::NAN,
    }
}

/// `String(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => value_to_string(other),
    }
}

/// A cell that lands on the grid as a number: a figure, an empty cell, or an ISO date, which both backends store as
/// Excel's date serial and set right like any figure.
fn figure_cell(cell: Option<&Value>) -> bool {
    match cell {
        None | Some(Value::Null | Value::Number(_)) => true,
        Some(Value::String(written)) if written.is_empty() => true,
        Some(other) => ISO_DATE.is_match(&value_to_string(other)),
    }
}

/// The number format a metric writes: its notation the way a fact writes it, and its unit riding in the format so the
/// cell keeps a number a formula can use while the sheet shows "12명".
fn metric_number_format(metric: &Value) -> String {
    let resolved = office_number_format(metric);
    let unit = js_trim(&text(prop(metric, "unit"))).replace('"', "");
    if unit.is_empty() {
        return if resolved.is_empty() { "General".to_owned() } else { resolved };
    }
    let suffix = format!("{}{unit}", if LATIN_UNIT.is_match(&unit) { " " } else { "" });
    format!("{}\"{suffix}\"", if resolved.is_empty() { "#,##0" } else { resolved.as_str() })
}

/// A card's figure written as text ("+18%", "92.8%", "1,240") lands as the number it shows, in a format that shows it
/// the same way: kept as text, a card one column wide read as a number that will not sum.
fn figure_metric(metric: &Value) -> Result<Value, String> {
    let Some(Value::String(written)) = prop(metric, "value") else { return Ok(metric.clone()) };
    if !plain_object(metric) || truthy_of(prop(metric, "formula")) || truthy_of(prop(metric, "unit")) || !office_number_format(metric).is_empty() {
        return Ok(metric.clone());
    }
    let Some(found) = FIGURE_TEXT.captures(js_trim(written)) else { return Ok(metric.clone()) };
    let sign = found.get(1);
    let whole = found.get(2).unwrap_or_default();
    let fraction = found.get(3).unwrap_or_default();
    let percent = found.get(4).is_some();
    let magnitude = string_to_number(&format!("{}.{}", whole.replace(',', ""), if fraction.is_empty() { "0" } else { fraction }));
    let pattern = format!(
        "{}{}{}",
        if whole.contains(',') { "#,##0" } else { "0" },
        if fraction.is_empty() { String::new() } else { format!(".{}", "0".repeat(fraction.len())) },
        if percent { "%" } else { "" }
    );
    // 92.8 / 100 is 0.9279999999999999 in binary; the stored figure has the places the text wrote.
    let places = fraction.len() + if percent { 2 } else { 0 };
    if places > 100 {
        return Err("toFixed() digits argument must be between 0 and 100".to_owned());
    }
    let signed = if sign == Some("-") { -magnitude } else { magnitude };
    let scaled = string_to_number(&to_fixed(signed / if percent { 100.0 } else { 1.0 }, places));
    let mut figure = metric.clone();
    if let Some(map) = figure.as_object_mut() {
        map.insert("value".to_owned(), json_number(scaled));
        map.insert("numberFormat".to_owned(), Value::String(if sign == Some("+") { format!("+{pattern};-{pattern};{pattern}") } else { pattern }));
    }
    Ok(figure)
}

/// `safeTableName`.
fn safe_table_name(value: &Value) -> String {
    let written = if truthy(value) { value_to_string(value) } else { "MixdogTable".to_owned() };
    let normalized: String = written.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    let leading = if LEADING_NAME.is_match(&normalized) { normalized } else { format!("T{normalized}") };
    leading.chars().take(240).collect()
}

/// The unit a column header names in its trailing parenthesis ("지출 (만 원)").
fn header_unit(header: Option<&str>) -> String {
    HEADER_UNIT
        .captures(header.unwrap_or_default())
        .and_then(|found| found.get(1))
        .map_or_else(String::new, |unit| unit.chars().filter(|c| !mixdog_js::is_js_space(*c)).collect())
}

/// The run of columns of a table a chart can draw on one axis: starting at the first column of figures, stopping at a
/// column in another named unit or two orders of magnitude away.
fn comparable_series_columns(rows: &[Value], data_columns: usize, chart_rows: usize, headers: &[String]) -> Option<(usize, usize)> {
    let magnitude = |column: usize| -> f64 {
        let values: Vec<f64> =
            rows.iter().take(chart_rows).map(|row| array_number(row, column - 1)).filter(|entry| entry.is_finite() && *entry != 0.0).map(f64::abs).collect();
        values.into_iter().fold(None, |best: Option<f64>, value| Some(best.map_or(value, |best| math::max(best, value)))).unwrap_or(0.0)
    };
    let mut first = 2;
    while first <= data_columns && magnitude(first) == 0.0 {
        first += 1;
    }
    if first > data_columns {
        return None;
    }
    let mut last = first;
    let unit = header_unit(headers.get(first - 1).map(String::as_str));
    for column in first + 1..=data_columns {
        let next = magnitude(column);
        if next == 0.0 {
            break;
        }
        let next_unit = header_unit(headers.get(column - 1).map(String::as_str));
        if !unit.is_empty() && !next_unit.is_empty() && unit != next_unit {
            break;
        }
        if math::max(magnitude(first), next) / math::min(magnitude(first), next) > 25.0 {
            break;
        }
        last = column;
    }
    Some((first, last))
}

fn is_excel_total_row(row: &Value) -> bool {
    let first = indexed(row, 0);
    let label = if truthy_of(first.as_ref()) { value_to_string(first.as_ref().unwrap_or(&Value::Null)) } else { String::new() };
    EXCEL_TOTAL_ROW.is_match(js_trim(&label))
}

/// `value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })`: the figure
/// rounded half away from zero at its shortest decimal digits, with thousands separators.
fn en_us_figure(value: f64, places: usize) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if value.is_infinite() {
        return format!("{sign}∞");
    }
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    let point = exponent.parse::<i64>().unwrap_or(0) + 1;
    let (mut whole, mut fraction): (Vec<u8>, Vec<u8>) = if point > 0 {
        let cut = point as usize;
        let mut whole: Vec<u8> = digits.iter().take(cut).copied().collect();
        whole.resize(cut, b'0');
        (whole, digits.iter().skip(cut).copied().collect())
    } else {
        let mut fraction = vec![b'0'; (-point) as usize];
        fraction.extend(&digits);
        (vec![b'0'], fraction)
    };
    let round_up = fraction.get(places).is_some_and(|digit| *digit >= b'5');
    fraction.truncate(places);
    fraction.resize(places, b'0');
    if round_up {
        let mut all: Vec<u8> = whole.iter().chain(fraction.iter()).copied().collect();
        let mut at = all.len();
        loop {
            if at == 0 {
                all.insert(0, b'1');
                break;
            }
            at -= 1;
            if all[at] == b'9' {
                all[at] = b'0';
            } else {
                all[at] += 1;
                break;
            }
        }
        let split = all.len() - places;
        fraction = all.split_off(split);
        whole = all;
    }
    let mut grouped = String::new();
    for (index, digit) in whole.iter().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(char::from(*digit));
    }
    let fraction = String::from_utf8_lossy(&fraction);
    format!("{sign}{grouped}{}{fraction}", if places > 0 { "." } else { "" })
}

/// The text a card's value shows under its number format ("47.0%" for 0.47 under 0.0%, "12명" for 12 under 0"명").
fn metric_display_text(metric: &Value, value: Option<&Value>) -> String {
    let Some(Value::Number(figure)) = value else { return text_or_empty(value) };
    let figure = figure.as_f64().unwrap_or(f64::NAN);
    let format = metric_number_format(metric);
    let mut pattern = String::new();
    let mut units = String::new();
    let mut inside: Option<String> = None;
    for c in format.chars() {
        if c == '"' {
            match inside.take() {
                Some(closed) => units.push_str(&closed),
                None => inside = Some(String::new()),
            }
        } else if let Some(open) = inside.as_mut() {
            open.push(c);
        } else {
            pattern.push(c);
        }
    }
    if let Some(open) = inside {
        // An unclosed quote is not a literal: its text stays in the pattern.
        pattern.push('"');
        pattern.push_str(&open);
    }
    // `/\.(0+)/`: the first point that is followed by a zero.
    let places = pattern.match_indices('.').map(|(at, _)| pattern[at + 1..].chars().take_while(|c| *c == '0').count()).find(|zeros| *zeros > 0).unwrap_or(0);
    let percent = pattern.contains('%');
    let shown = en_us_figure(if percent { figure * 100.0 } else { figure }, places);
    format!("{shown}{}{units}", if percent { "%" } else { "" })
}

/// The columns of the metric strips: each card with the columns it spans.
struct Card {
    index: usize,
    strip: usize,
    start_column: usize,
    end_column: usize,
}

/// The cards of the strips: a strip's columns shared out among its cards, the spare ones to the leading cards, the last
/// card running to the strip's edge. More cards than columns wrap onto a second strip.
fn metric_card_spans(count: usize, columns: usize) -> Vec<Card> {
    let per_row = count.min(columns).max(1);
    let mut cards = Vec::new();
    let mut index = 0;
    while index < count {
        let size = per_row.min(count - index);
        let base_span = columns / size;
        let spare = columns % size;
        let mut start_column = 1;
        for card_index in 0..size {
            let span = (base_span + usize::from(card_index < spare)).max(1);
            let end_column = if card_index == size - 1 { columns } else { columns.min(start_column + span - 1) };
            cards.push(Card { index: index + card_index, strip: index / per_row, start_column, end_column });
            start_column = end_column + 1;
        }
        index += per_row;
    }
    cards
}

/// The per-column widths the metric cards floor the table at, in insertion order (a `Map`).
struct Floors(Vec<(usize, f64)>);

impl Floors {
    fn get(&self, column: usize) -> f64 {
        self.0.iter().find(|(at, _)| *at == column).map_or(0.0, |(_, width)| *width)
    }

    fn set(&mut self, column: usize, width: f64) {
        match self.0.iter_mut().find(|(at, _)| *at == column) {
            Some(entry) => entry.1 = width,
            None => self.0.push((column, width)),
        }
    }
}

/// The composition's default chart frame, in points.
struct Frame {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

/// Where a chart sits, and the bottom and right edges the print area follows.
struct Placement {
    fields: Vec<(&'static str, Value)>,
    bottom: f64,
    right: f64,
}

/// Everything the sheet's sections share: the composition's flags, the palette and type the design chose, and the
/// column and point geometry of the canvas. The canvas is as wide as the table under it, because the table's columns
/// are the canvas's columns.
pub(super) struct Layout<'a> {
    pub tokens: Tokens<'a>,
    format: Option<&'a Value>,
    pub design: &'a Value,
    accent_headline: bool,
    pub trend_dashboard: bool,
    comparison_board: bool,
    pub analysis_sheet: bool,
    pub narrative_scorecard: bool,
    pub sheet: String,
    pub headers: Vec<String>,
    pub rows: &'a [Value],
    pub metrics: Vec<Value>,
    pub dashboard: bool,
    data_columns: usize,
    panel_columns: usize,
    decision_text: String,
    decision_label: String,
    has_decision_panel: bool,
    canvas_columns: usize,
    portrait_canvas: bool,
    fill_width: f64,
    fills: bool,
    column_points: f64,
    canvas_points: f64,
    last_column: String,
    data_last_column: String,
    strip_columns: usize,
    band_last_column: String,
    band_points: f64,
}

/// The decision is a sentence, or `{ text, label }` when the panel names it itself.
fn decision_field(value: Option<&Value>) -> Result<(String, String), String> {
    match value {
        None | Some(Value::Null) => Ok((String::new(), String::new())),
        Some(Value::String(written)) if written.is_empty() => Ok((String::new(), String::new())),
        Some(Value::String(written)) => Ok((js_trim(written).to_owned(), String::new())),
        Some(object @ Value::Object(_)) if matches!(prop(object, "text"), Some(Value::String(_))) => {
            let sentence = prop(object, "text").and_then(Value::as_str).unwrap_or_default();
            let label = prop(object, "label").and_then(Value::as_str).unwrap_or_default();
            Ok((js_trim(sentence).to_owned(), js_trim(label).to_owned()))
        }
        Some(_) => Err("compose_sheet decision takes a sentence, or { text, label } to name the panel yourself".to_owned()),
    }
}

static NO_ROWS: Vec<Value> = Vec::new();

impl<'a> Layout<'a> {
    pub(super) fn new(operation: &'a Value, design: &'a Value, composition: Option<&Value>) -> Result<Self, String> {
        let composition_id = match opt_prop(composition, "id") {
            Some(id) if truthy(id) => value_to_string(id),
            _ => "monitor-dashboard".to_owned(),
        };
        let headers = strings(prop(operation, "headers"));
        let rows: &[Value] = prop(operation, "rows").and_then(Value::as_array).map_or(NO_ROWS.as_slice(), Vec::as_slice);
        let metrics: Vec<Value> = match prop(operation, "metrics") {
            Some(Value::Array(list)) => list.iter().take(4).map(figure_metric).collect::<Result<_, _>>()?,
            _ => Vec::new(),
        };
        let dashboard = js_to_lowercase(&text(prop(operation, "kind"))) == "dashboard" || !metrics.is_empty();
        let data_columns = rows.iter().map(|entry| entry.as_array().map_or(1, Vec::len)).chain([1, headers.len()]).max().unwrap_or(1);
        let columns = data_columns.max(if dashboard { metrics.len() * 2 } else { 1 });
        let content = opt_prop(Some(design), "content");
        let chosen = match prop(operation, "decision") {
            Some(value) if truthy(value) => Some(value),
            _ => opt_prop(content, "decision"),
        };
        let (decision_text, decision_label) = decision_field(chosen)?;
        // Every sheet carries the decision it was given: beside the table on a dashboard, under it otherwise.
        let has_decision_panel = !decision_text.is_empty();
        let format = prop(design, "format");
        let accent_headline = match prop(operation, "accentHeadline").filter(|value| !value.is_null()) {
            Some(value) => truthy(value),
            None => match opt_prop(format, "accentHeadline").filter(|value| !value.is_null()) {
                Some(value) => truthy(value),
                None => composition_id == "monitor-dashboard" || composition_id == "trend-dashboard",
            },
        };
        let canvas_columns = if dashboard { data_columns } else { columns };
        // A dashboard of up to three columns, with no panel beside it, is the narrow page; a wider one stays landscape.
        let portrait_canvas = dashboard && canvas_columns <= 3 && !has_decision_panel;
        let canvas_width_chars: f64 = if portrait_canvas { 78.0 } else { 120.0 };
        let fill_width = if dashboard && !has_decision_panel { math::min(40.0, math::floor(canvas_width_chars / canvas_columns as f64)) } else { 0.0 };
        let fills = fill_width >= 12.0;
        // Excel stores a column width in characters; a printed point is what the chart beside it is placed in.
        let column_points = if fills { (fill_width * 7.0 + 5.0) * 0.75 } else { 48.0 };
        let sheet_name = match prop(operation, "sheet") {
            Some(value) if truthy(value) => value_to_string(value),
            _ => "Sheet1".to_owned(),
        };
        let mut layout = Layout {
            tokens: Tokens::of(design),
            format,
            design,
            accent_headline,
            trend_dashboard: composition_id == "trend-dashboard",
            comparison_board: composition_id == "comparison-board",
            analysis_sheet: composition_id == "analysis-sheet",
            narrative_scorecard: composition_id == "narrative-scorecard",
            sheet: sheet_name,
            headers,
            rows,
            metrics,
            dashboard,
            data_columns,
            panel_columns: if dashboard { 6usize.max(18usize.saturating_sub(data_columns + 1)) } else { data_columns },
            decision_text,
            decision_label,
            has_decision_panel,
            canvas_columns,
            portrait_canvas,
            fill_width,
            fills,
            column_points,
            canvas_points: column_points * canvas_columns as f64,
            last_column: col(canvas_columns),
            data_last_column: col(data_columns),
            strip_columns: canvas_columns,
            band_last_column: String::new(),
            band_points: 0.0,
        };
        layout.apply_panel_geometry();
        layout.apply_band_geometry(operation);
        Ok(layout)
    }

    fn format_number(&self, key: &str) -> f64 {
        to_number_of(opt_prop(self.format, key))
    }

    pub(super) fn heading_size(&self) -> f64 {
        self.format_number("heading")
    }

    pub(super) fn body_size(&self) -> f64 {
        self.format_number("body")
    }

    pub(super) fn title_size(&self) -> f64 {
        self.format_number("title")
    }

    /// The printed width, in points, `autofit_range` gives a table column: its widest text two characters over, eight
    /// at least. A column past the table keeps Excel's default (48 pt).
    fn fitted_column_points(&self, index: usize) -> f64 {
        if index >= self.data_columns { 48.0 } else { (self.fitted_column_chars(index) * 7.0 + 5.0) * 0.75 }
    }

    fn fitted_column_chars(&self, index: usize) -> f64 {
        let header = self.headers.get(index).map_or(0.0, |text| display_width(text) + 2.0);
        self.rows
            .iter()
            .map(|row| row.as_array().and_then(|cells| cells.get(index)))
            .map(|cell| display_width(&text_or_empty(cell)) + 2.0)
            .fold(math::max(8.0, header), math::max)
    }

    /// The printed width of a table column once the metric cards above it have their floors, in Excel characters.
    fn table_column_chars(&self, index: usize, floors: &Floors) -> f64 {
        math::max(self.fitted_column_chars(index), floors.get(index + 1))
    }

    fn table_canvas_points(&self) -> f64 {
        let floors = self.metric_column_floors();
        (0..self.data_columns).fold(0.0, |points, index| points + (self.table_column_chars(index, &floors) * 7.0 + 5.0) * 0.75)
    }

    fn metric_value_size(&self) -> f64 {
        if self.narrative_scorecard {
            25.0
        } else if self.dashboard {
            27.0
        } else if self.comparison_board {
            20.0
        } else {
            22.0
        }
    }

    /// A card that reads the table by name (`=SUM(Hubs[처리량 (건)])`) holds no value until the workbook calculates, and
    /// measured as empty text it floored nothing: its aggregate over the rows this sheet writes stands in for the value
    /// when the formula is one aggregate of one table column.
    fn measured_value(&self, metric: &Value) -> Option<Value> {
        let value = prop(metric, "value");
        if matches!(value, Some(Value::Number(_))) {
            return value.cloned();
        }
        let formula = text(prop(metric, "formula"));
        let found = TABLE_AGGREGATE.captures(&formula);
        let column = found.as_ref().and_then(|found| found.get(2)).and_then(|name| self.headers.iter().position(|header| header == js_trim(name)));
        let (Some(found), Some(column)) = (found, column) else { return value.cloned() };
        let values: Vec<f64> = self.rows.iter().map(|row| array_number(row, column)).filter(|entry| entry.is_finite()).collect();
        if values.is_empty() {
            return value.cloned();
        }
        let sum = values.iter().fold(0.0, |total, entry| total + entry);
        let aggregate = match found.get(1).map(str::to_ascii_uppercase).as_deref() {
            Some("SUM") => sum,
            Some("AVERAGE") => sum / values.len() as f64,
            Some("MAX") => values.iter().copied().fold(f64::NEG_INFINITY, math::max),
            Some("MIN") => values.iter().copied().fold(f64::INFINITY, math::min),
            _ => values.len() as f64,
        };
        Some(json_number(aggregate))
    }

    /// The width a card's figure needs, in Excel characters. Two characters are the cell's own insets; the third keeps
    /// the figure off the card's edge. The value is bold, a fifth wider than the regular face the character count
    /// stands for.
    fn metric_needed_chars(&self, metric: &Value, size: f64) -> f64 {
        let shown = metric_display_text(metric, self.measured_value(metric).as_ref());
        math::ceil(display_width(&shown) * size * 1.2 / 11.0) + 3.0
    }

    fn metric_column_floors(&self) -> Floors {
        let mut floors = Floors(Vec::new());
        if self.metrics.is_empty() || self.fills || self.analysis_sheet {
            return floors;
        }
        let size = self.metric_value_size();
        for card in metric_card_spans(self.metrics.len(), self.canvas_columns) {
            let span = (card.end_column - card.start_column + 1) as f64;
            let share = math::ceil(self.metric_needed_chars(&self.metrics[card.index], size) / span);
            for column in card.start_column..=card.end_column {
                floors.set(column, math::max(floors.get(column), share));
            }
        }
        // The figure columns under the cards read as one grid: floored card by card, the months under the widest card
        // ran three times as wide as the month beside them. The label column keeps its own width.
        let last = self.canvas_columns.min(self.data_columns);
        let mut figure_width = 0.0;
        for column in 2..=last {
            figure_width = math::max(math::max(figure_width, floors.get(column)), self.fitted_column_chars(column - 1));
        }
        for column in 2..=last {
            floors.set(column, figure_width);
        }
        floors
    }

    /// Whether every card holds its figure across the given columns: a table column at its printed width, a column
    /// past the table at Excel's default (8.43 characters).
    fn cards_fit_columns(&self, columns: usize) -> bool {
        let size = self.metric_value_size();
        let floors = self.metric_column_floors();
        metric_card_spans(self.metrics.len(), columns).iter().all(|card| {
            let width = (card.start_column..=card.end_column)
                .fold(0.0, |total, column| total + if column <= self.data_columns { self.table_column_chars(column - 1, &floors) } else { 8.43 });
            width >= self.metric_needed_chars(&self.metrics[card.index], size)
        })
    }

    /// A dashboard's decision panel beside the table is as wide as the table, and the metric cards run over the panel's
    /// columns too when every card still holds its figure there.
    fn apply_panel_geometry(&mut self) {
        if !self.dashboard || !self.has_decision_panel {
            self.strip_columns = self.canvas_columns;
            return;
        }
        let panel_columns = math::min(13.0, math::max(6.0, math::round(self.table_canvas_points() / 48.0))) as usize;
        let strip_columns = self.data_columns + 1 + panel_columns;
        let across = !self.metrics.is_empty() && !self.analysis_sheet && self.cards_fit_columns(strip_columns);
        self.panel_columns = panel_columns;
        self.strip_columns = if across { strip_columns } else { self.canvas_columns };
    }

    /// The bands a sheet's header is made of run over its table and, when the chart sits beside the table, over the
    /// chart too. Columns past the table keep Excel's default 48 pt.
    fn apply_band_geometry(&mut self, operation: &Value) {
        let chart = prop(operation, "chart").filter(|chart| plain_object(chart));
        let beside = chart.is_some_and(|chart| {
            !self.dashboard
                && number_or(prop(chart, "left"), 0.0) == 0.0
                && number_or(prop(chart, "top"), 0.0) == 0.0
                && (!self.headers.is_empty() || !self.rows.is_empty())
        });
        match chart.filter(|_| beside) {
            Some(chart) => {
                let chart_columns = math::ceil(number_or(prop(chart, "width"), self.chart_defaults().width) / 48.0) as usize;
                let table_points = (0..self.data_columns).fold(0.0, |total, index| total + self.fitted_column_points(index));
                self.band_last_column = col(self.data_columns + 1 + chart_columns);
                self.band_points = table_points + 48.0 * (1 + chart_columns) as f64;
            }
            None => {
                self.band_last_column = self.last_column.clone();
                self.band_points = self.canvas_points;
            }
        }
    }

    /// The last column and the width in points the bands over the table take: beside a decision panel they span the
    /// panel too, since held to the table the page's right half stood empty above it. The second is whether they are
    /// widened.
    pub(super) fn panel_band(&self) -> (String, f64, bool) {
        if !self.dashboard || !self.has_decision_panel {
            return (self.band_last_column.clone(), self.band_points, false);
        }
        let panel_columns = self.panel_columns.max(4);
        (col(self.data_columns + 1 + panel_columns), self.table_canvas_points() + 48.0 * (1 + panel_columns) as f64, true)
    }

    fn chart_defaults(&self) -> Frame {
        if self.dashboard {
            Frame { left: 0.0, top: 0.0, width: self.canvas_points, height: 360.0 }
        } else if self.trend_dashboard {
            Frame { left: 360.0, top: 172.0, width: 510.0, height: 286.0 }
        } else if self.comparison_board {
            Frame { left: 390.0, top: 184.0, width: 480.0, height: 278.0 }
        } else if !self.analysis_sheet && self.narrative_scorecard {
            Frame { left: 430.0, top: 206.0, width: 450.0, height: 258.0 }
        } else {
            Frame { left: 520.0, top: 40.0, width: 480.0, height: 280.0 }
        }
    }

    /// One metric card: value over label over detail, merged across its span; the first card of the sheet is painted as
    /// the headline.
    fn push_metric_card(&self, output: &mut Vec<Value>, metric: &Value, headline: bool, card: &Card, strip_row: usize) {
        let sheet = text_value(&self.sheet);
        let start = col(card.start_column);
        let end = col(card.end_column);
        let (value_row, label_row, detail_row) = (strip_row, strip_row + 1, strip_row + 2);
        let value_cell = format!("{start}{value_row}");
        if truthy_of(prop(metric, "formula")) {
            output.push(operation(
                "set_formula",
                vec![("sheet", sheet.clone()), ("cell", text_value(&value_cell)), ("formula", text_value(&text(prop(metric, "formula"))))],
            ));
        } else {
            let value = prop(metric, "value").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| text_value(""));
            output.push(operation("set_cell", vec![("sheet", sheet.clone()), ("cell", text_value(&value_cell)), ("value", value)]));
        }
        // A card one column wide needs no merge; writing one left A4:A4 in the sheet.
        let spans = card.end_column > card.start_column;
        let merge = |output: &mut Vec<Value>, row: usize| {
            if spans {
                output.push(operation("merge_cells", vec![("sheet", sheet.clone()), ("range", text_value(&format!("{start}{row}:{end}{row}")))]));
            }
        };
        merge(output, value_row);
        output.push(operation(
            "set_cell",
            vec![("sheet", sheet.clone()), ("cell", text_value(&format!("{start}{label_row}"))), ("value", text_value(&text(prop(metric, "label"))))],
        ));
        merge(output, label_row);
        output.push(operation(
            "set_cell",
            vec![("sheet", sheet.clone()), ("cell", text_value(&format!("{start}{detail_row}"))), ("value", text_value(&text(prop(metric, "detail"))))],
        ));
        merge(output, detail_row);
        let tokens = &self.tokens;
        let value_fill = if self.trend_dashboard { tokens.color("canvas") } else { tokens.color("surface") };
        output.push(operation(
            "set_style",
            vec![
                ("sheet", sheet.clone()),
                ("range", text_value(&format!("{start}{value_row}:{end}{value_row}"))),
                (
                    "properties",
                    props(vec![
                        ("fontName", tokens.face("data")),
                        ("fontSize", Some(num(self.metric_value_size()))),
                        ("bold", Some(Value::Bool(true))),
                        ("color", if headline { tokens.color("onAccent") } else { tokens.color("ink") }),
                        ("fillColor", if headline { tokens.color("accent") } else { value_fill }),
                        ("numberFormat", Some(text_value(&metric_number_format(metric)))),
                        ("horizontalAlignment", Some(text_value("center"))),
                        ("verticalAlignment", Some(text_value("center"))),
                    ]),
                ),
            ],
        ));
        output.push(operation(
            "set_style",
            vec![
                ("sheet", sheet),
                ("range", text_value(&format!("{start}{label_row}:{end}{detail_row}"))),
                (
                    "properties",
                    props(vec![
                        ("fontName", tokens.face("body")),
                        ("fontSize", Some(num(if self.dashboard { 10.0 } else { 9.0 }))),
                        ("bold", Some(Value::Bool(true))),
                        ("color", tokens.color("muted")),
                        ("fillColor", tokens.color("surface")),
                        ("horizontalAlignment", Some(text_value("center"))),
                        ("verticalAlignment", Some(text_value("center"))),
                        ("wrapText", Some(Value::Bool(true))),
                    ]),
                ),
            ],
        ));
    }

    /// The metric strips; the first free row. The headline is the card marked `emphasis: true`, else the first.
    pub(super) fn push_metric_strips(&self, output: &mut Vec<Value>, row: usize) -> usize {
        if self.metrics.is_empty() {
            return row;
        }
        let lead = self.metrics.iter().position(|metric| prop(metric, "emphasis") == Some(&Value::Bool(true))).unwrap_or(0);
        let cards = metric_card_spans(self.metrics.len(), self.strip_columns);
        for card in &cards {
            let headline = card.index == lead && !self.analysis_sheet && self.accent_headline;
            self.push_metric_card(output, &self.metrics[card.index], headline, card, row + card.strip * 3);
        }
        row + (cards.last().map_or(0, |card| card.strip) + 1) * 3 + 1
    }

    /// The data block: values, a header band with a named table and frozen panes when headers were given, and the body
    /// type. Returns the block's last row.
    pub(super) fn push_data_table(&self, output: &mut Vec<Value>, operation_input: &Value, values: &[Value], start_row: usize) -> Result<usize, String> {
        let sheet = text_value(&self.sheet);
        let tokens = &self.tokens;
        let end_row = start_row + values.len() - 1;
        let last = &self.data_last_column;
        let has_headers = !self.headers.is_empty();
        output.push(operation(
            "set_range",
            vec![("sheet", sheet.clone()), ("range", text_value(&format!("A{start_row}:{last}{end_row}"))), ("values", Value::Array(values.to_vec()))],
        ));
        if has_headers {
            self.push_table_header(output, operation_input, values, start_row, end_row);
        }
        let first_body = start_row + usize::from(has_headers);
        output.push(operation(
            "set_style",
            vec![
                ("sheet", sheet.clone()),
                ("range", text_value(&format!("A{first_body}:{last}{end_row}"))),
                (
                    "properties",
                    props(vec![
                        ("fontName", tokens.face("body")),
                        ("fontSize", Some(num(self.body_size()))),
                        ("color", tokens.color("ink")),
                        ("verticalAlignment", Some(text_value("center"))),
                    ]),
                ),
            ],
        ));
        self.push_label_indents(output, values, start_row, end_row)?;
        Ok(end_row)
    }

    fn push_table_header(&self, output: &mut Vec<Value>, operation_input: &Value, values: &[Value], start_row: usize, end_row: usize) {
        let sheet = text_value(&self.sheet);
        let tokens = &self.tokens;
        let last = &self.data_last_column;
        output.push(operation(
            "set_style",
            vec![
                ("sheet", sheet.clone()),
                ("range", text_value(&format!("A{start_row}:{last}{start_row}"))),
                (
                    "properties",
                    props(vec![
                        ("fontName", tokens.face("body")),
                        ("fontSize", Some(num(self.heading_size()))),
                        ("bold", Some(Value::Bool(true))),
                        ("color", tokens.color("onAccent")),
                        ("fillColor", tokens.color("accent")),
                        ("horizontalAlignment", Some(text_value("left"))),
                        ("verticalAlignment", Some(text_value("center"))),
                        ("wrapText", Some(Value::Bool(true))),
                    ]),
                ),
            ],
        ));
        // A header over a column of figures sits on the figures' right edge, where the eye reads them.
        for index in 0..self.headers.len() {
            let body: Vec<Option<Value>> = values.iter().skip(1).map(|row| indexed(row, index)).collect();
            if body.is_empty() || !body.iter().all(|cell| figure_cell(cell.as_ref())) {
                continue;
            }
            output.push(operation(
                "set_style",
                vec![
                    ("sheet", sheet.clone()),
                    ("range", text_value(&format!("{}{start_row}", col(index + 1)))),
                    ("properties", props(vec![("horizontalAlignment", Some(text_value("right")))])),
                ],
            ));
        }
        let table_name = match prop(operation_input, "tableName") {
            Some(value) if truthy(value) => value.clone(),
            _ => text_value(&format!("{}Data", self.sheet)),
        };
        let style = match prop(operation_input, "tableStyle") {
            Some(value) if truthy(value) => value.clone(),
            _ => match opt_prop(self.format, "tableStyle") {
                Some(value) if truthy(value) => value.clone(),
                _ => text_value("none"),
            },
        };
        output.push(operation(
            "add_table",
            vec![
                ("sheet", sheet.clone()),
                ("range", text_value(&format!("A{start_row}:{last}{end_row}"))),
                ("name", text_value(&safe_table_name(&table_name))),
                ("style", style),
            ],
        ));
        output.push(operation(
            "freeze_panes",
            vec![("sheet", sheet.clone()), ("row", num((start_row + 1) as f64)), ("column", num(1.0)), ("allowNoChange", Value::Bool(true))],
        ));
    }

    fn push_label_indents(&self, output: &mut Vec<Value>, values: &[Value], start_row: usize, end_row: usize) -> Result<(), String> {
        let sheet = text_value(&self.sheet);
        let has_headers = !self.headers.is_empty();
        let figures = |index: usize| {
            let body: Vec<Option<Value>> = values.iter().skip(usize::from(has_headers)).map(|row| indexed(row, index)).collect();
            !body.is_empty() && body.iter().all(|cell| figure_cell(cell.as_ref()))
        };
        let width = match values.first() {
            Some(Value::Array(cells)) => cells.len(),
            Some(first) if !truthy(first) => 0,
            Some(_) => return Err("(values[0] || []).forEach is not a function".to_owned()),
            None => 0,
        };
        for index in 0..width {
            if index == 0 || figures(index) || !figures(index - 1) {
                continue;
            }
            let column = col(index + 1);
            output.push(operation(
                "set_style",
                vec![
                    ("sheet", sheet.clone()),
                    ("range", text_value(&format!("{column}{start_row}:{column}{end_row}"))),
                    ("properties", props(vec![("indent", Some(num(1.0)))])),
                ],
            ));
        }
        Ok(())
    }

    /// A column of numbers the caller named no format for shipped under General: the default is read off the values and
    /// claims nothing about them (integers take the thousands form, decimals keep the places they were written with).
    fn column_default_format(&self, index: usize) -> String {
        let values: Vec<f64> = self
            .rows
            .iter()
            .filter_map(|row| row.as_array().and_then(|cells| cells.get(index)))
            .filter_map(|entry| if let Value::Number(figure) = entry { figure.as_f64().filter(|figure| figure.is_finite()) } else { None })
            .collect();
        if values.is_empty() || values.len() < self.rows.len() {
            return String::new();
        }
        if values.iter().all(|entry| entry.fract() == 0.0) {
            return "#,##0".to_owned();
        }
        let places = values
            .iter()
            .map(|entry| number_to_string(*entry).split('.').nth(1).map_or(0, |fraction| fraction.encode_utf16().count()))
            .max()
            .unwrap_or(0)
            .min(3);
        if places > 0 { format!("#,##0.{}", "0".repeat(places)) } else { "#,##0".to_owned() }
    }

    /// The format the caller wrote for a column: by position in a list, or by header or column letter in an object.
    fn named_column_format(&self, formats: Option<&Value>, index: usize) -> Option<Value> {
        match formats {
            Some(Value::Array(list)) => list.get(index).cloned(),
            Some(Value::Object(map)) => {
                let by_header = map.get(self.headers.get(index).map_or("undefined", String::as_str));
                match by_header {
                    Some(value) if truthy(value) => Some(value.clone()),
                    _ => map.get(&col(index + 1)).cloned(),
                }
            }
            _ => None,
        }
    }

    /// Number formats per data column. A format the caller wrote that lands nowhere is reported rather than dropped.
    pub(super) fn push_column_formats(&self, output: &mut Vec<Value>, operation_input: &Value, start_row: usize, end_row: usize) -> Result<(), String> {
        if self.rows.is_empty() {
            return Ok(());
        }
        let formats = prop(operation_input, "columnFormats");
        let defaults: Vec<String> = (0..self.data_columns.max(self.headers.len())).map(|index| self.column_default_format(index)).collect();
        let first_data_row = start_row + usize::from(!self.headers.is_empty());
        let mut named = 0;
        for (index, default) in defaults.iter().enumerate() {
            let chosen = match self.named_column_format(formats, index) {
                Some(value) if truthy(&value) => value,
                _ => text_value(default),
            };
            if !truthy(&chosen) {
                continue;
            }
            if chosen != text_value(default) {
                named += 1;
            }
            let letter = col(index + 1);
            output.push(operation(
                "set_style",
                vec![
                    ("sheet", text_value(&self.sheet)),
                    ("range", text_value(&format!("{letter}{first_data_row}:{letter}{end_row}"))),
                    ("properties", props(vec![("numberFormat", Some(text_value(&value_to_string(&chosen))))])),
                ],
            ));
        }
        let given = match formats {
            Some(Value::Array(list)) => list.iter().any(truthy),
            Some(Value::Object(map)) => map.values().any(truthy),
            _ => false,
        };
        if given && named == 0 {
            return Err(format!(
                "compose_sheet columnFormats matched no column; give one entry per column in order, or key them by {}",
                if self.headers.is_empty() { "column letter".to_owned() } else { format!("header ({})", self.headers.join(", ")) }
            ));
        }
        Ok(())
    }

    /// Where the chart sits: the composition's default frame, pushed right of the table and, on a dashboard, below it
    /// when the two would overlap.
    fn chart_frame(&self, chart: &Value, data_end_row: usize, start_row: usize, categories: usize, horizontal: bool) -> Placement {
        let mut defaults = self.chart_defaults();
        // Horizontal bars stack their categories down the frame: each bar gets about a label's height, plus the axis and
        // the title. Beside the table the frame stops where the table does.
        if horizontal {
            let wanted = categories as f64 * 16.0 + 60.0;
            defaults.height = math::max(defaults.height, if self.dashboard { wanted } else { math::min(wanted, (categories + 1) as f64 * 15.0) });
        }
        let requested_left = number_or(prop(chart, "left"), defaults.left);
        let requested_top = number_or(prop(chart, "top"), defaults.top);
        let requested_width = number_or(prop(chart, "width"), defaults.width);
        let left = math::max(requested_left, if self.dashboard { 0.0 } else { self.data_columns as f64 * 60.0 + 40.0 });
        let width = math::max(360.0, requested_width - (left - requested_left));
        let table_right = self.data_columns as f64 * if self.dashboard { self.column_points } else { 60.0 };
        let overlaps = left < table_right;
        let height = number_or(prop(chart, "height"), defaults.height);
        // A frame that is to match the grid ends at a column rather than a width in points: a column's points depend on
        // the workbook's font.
        let sized = number_or(prop(chart, "width"), 0.0) != 0.0;
        let free = number_or(prop(chart, "left"), 0.0) == 0.0 && number_or(prop(chart, "top"), 0.0) == 0.0;
        if self.dashboard && overlaps && free {
            // A dashboard chart under its table is anchored to the row after the table's gap, not placed in points.
            // Beside a decision panel it runs under the panel too, to the bands' right edge.
            let span = if sized { ("width", num(width)) } else { ("toColumn", text_value(&self.panel_band().0)) };
            return Placement {
                fields: vec![("cell", text_value(&format!("A{}", data_end_row + 2))), span, ("height", num(height))],
                bottom: (data_end_row + 1) as f64 * 15.0 + height,
                right: width,
            };
        }
        // Any other sheet sets its chart beside the table, a column apart, its top on the header row.
        if !self.dashboard && free {
            let span = if sized { ("width", num(requested_width)) } else { ("toColumn", text_value(&self.band_last_column)) };
            return Placement {
                fields: vec![("cell", text_value(&format!("{}{start_row}", col(self.data_columns + 2)))), span, ("height", num(height))],
                bottom: (start_row as f64 - 1.0) * 15.0 + height,
                right: (self.data_columns + 1) as f64 * self.column_points + requested_width,
            };
        }
        let table_bottom = (data_end_row + 1) as f64 * if self.dashboard { 20.0 } else { 15.0 };
        let top = math::max(requested_top, if self.dashboard && overlaps { table_bottom + 24.0 } else { 0.0 });
        Placement {
            fields: vec![("left", num(left)), ("top", num(top)), ("width", num(width)), ("height", num(height))],
            bottom: top + height,
            right: left + width,
        }
    }

    /// The rows a chart plots: the table's, without the totals under it.
    fn plotted_rows(&self) -> usize {
        let mut rows = self.rows.len();
        while rows > 0 && is_excel_total_row(&self.rows[rows - 1]) {
            rows -= 1;
        }
        rows
    }

    /// Several series read as periods or groups against the last one, the current period: it takes the accent and the
    /// rest stay muted.
    fn default_series_colors(&self, series_count: usize) -> Value {
        let color = |role: &str| self.tokens.color(role).unwrap_or(Value::Null);
        if series_count > 1 {
            let mut list: Vec<Value> = (0..series_count - 1).map(|_| color("muted")).collect();
            list.push(color("accent"));
            Value::Array(list)
        } else {
            Value::Array(vec![color("accent"), color("accent2"), color("muted")])
        }
    }

    /// The data label fields of a chart: the position, and inside the bars the label colour.
    fn data_label_fields(&self, chart: &Value, show_values: &Value, bars: bool) -> Vec<(&'static str, Value)> {
        let position = match prop(chart, "dataLabelPosition") {
            Some(value) if truthy(value) => value.clone(),
            _ => text_value(if truthy(show_values) && bars { "inside_end" } else { "" }),
        };
        let mut fields = Vec::new();
        let inside_end = position == text_value("inside_end");
        if truthy(&position) {
            fields.push(("dataLabelPosition", position));
        }
        if inside_end {
            let label_color = match prop(chart, "dataLabelColor") {
                Some(value) if truthy(value) => Some(value.clone()),
                _ => self.tokens.color("onAccent"),
            };
            if let Some(label_color) = label_color {
                fields.push(("dataLabelColor", label_color));
            }
        }
        fields
    }

    /// Adds the chart over the comparable series; returns its bottom and right edges in points so the print area can
    /// follow it.
    pub(super) fn push_chart(&self, output: &mut Vec<Value>, chart: &Value, start_row: usize, data_end_row: usize) -> (f64, f64) {
        let chart_rows = self.plotted_rows();
        let header_rows = usize::from(!self.headers.is_empty());
        let chart_end_row = (start_row + header_rows + chart_rows).saturating_sub(1);
        let series = comparable_series_columns(self.rows, self.data_columns, chart_rows, &self.headers);
        let end_row = start_row.max(chart_end_row);
        // Categories in column A; a run of series that does not start beside them joins it by comma, the way Excel
        // reads it.
        let mut default_range = format!("A{start_row}:{}{end_row}", col(series.map_or(self.data_columns, |(_, last)| last)));
        if let Some((first, last)) = series.filter(|(first, _)| *first > 2) {
            default_range = format!("A{start_row}:A{end_row},{}{start_row}:{}{end_row}", col(first), col(last));
        }
        let chart_type = match prop(chart, "type") {
            Some(value) if truthy(value) => value.clone(),
            _ => text_value("column"),
        };
        let type_name = js_to_lowercase(&value_to_string(&chart_type));
        let bars = type_name == "column" || type_name == "bar";
        let show_values = match prop(chart, "showValues").filter(|value| !value.is_null()) {
            Some(value) => value.clone(),
            None => Value::Bool(self.dashboard && chart_rows <= 6),
        };
        let frame = self.chart_frame(chart, data_end_row, start_row, chart_rows, type_name == "bar");
        let series_count = match series {
            Some((first, last)) if !truthy_of(prop(chart, "range")) => last - first + 1,
            _ => 0,
        };
        let default_colors = self.default_series_colors(series_count);
        let mut fields: Vec<(&str, Value)> = vec![
            ("sheet", text_value(&self.sheet)),
            (
                "range",
                match prop(chart, "range") {
                    Some(value) if truthy(value) => value.clone(),
                    _ => text_value(&default_range),
                },
            ),
            ("chartType", chart_type),
            (
                "title",
                match prop(chart, "title") {
                    Some(value) if truthy(value) => value.clone(),
                    _ => text_value(""),
                },
            ),
        ];
        fields.extend(frame.fields);
        fields.push((
            "seriesColors",
            match prop(chart, "seriesColors") {
                Some(value) if truthy(value) => value.clone(),
                _ => default_colors,
            },
        ));
        fields.push(("showValues", show_values.clone()));
        fields.extend(self.data_label_fields(chart, &show_values, bars));
        fields.push((
            "zeroBaseline",
            match prop(chart, "zeroBaseline").filter(|value| !value.is_null()) {
                Some(value) => value.clone(),
                None => Value::Bool(bars),
            },
        ));
        if let Some(legend) = prop(chart, "showLegend").filter(|value| !value.is_null()) {
            fields.push(("showLegend", legend.clone()));
        }
        if let Some(format) = prop(chart, "valueNumberFormat").filter(|value| truthy(value)) {
            fields.push(("valueNumberFormat", format.clone()));
        }
        output.push(operation("add_chart", fields));
        (frame.bottom, frame.right)
    }

    /// The decision panel: beside the table on a dashboard, under it otherwise. Its last row and last column (0 when
    /// the sheet has no panel).
    pub(super) fn push_decision_panel(&self, output: &mut Vec<Value>, operation_input: &Value, start_row: usize, data_end_row: usize) -> (usize, usize) {
        if !self.has_decision_panel {
            return (data_end_row, 0);
        }
        let gates = prop(operation_input, "gates");
        let actions = prop(operation_input, "actions");
        if !self.dashboard {
            // Under the table, a row apart, as wide as the table (four columns at least, the gate row's three spans).
            let columns = self.data_columns.max(4);
            let last_row = add_xlsx_decision_panel(
                output,
                &Panel {
                    sheet: &self.sheet,
                    row: data_end_row + 2,
                    start_column: 1,
                    columns,
                    design: self.design,
                    decision: &self.decision_text,
                    gates,
                    actions,
                    label: &self.decision_label,
                    width_points: (0..columns).fold(0.0, |total, index| total + self.fitted_column_points(index)),
                },
            );
            return (last_row, columns);
        }
        let last_row = add_xlsx_decision_panel(
            output,
            &Panel {
                sheet: &self.sheet,
                row: start_row,
                start_column: self.data_columns + 2,
                columns: self.panel_columns,
                design: self.design,
                decision: &self.decision_text,
                gates,
                actions,
                label: &self.decision_label,
                width_points: self.panel_columns.max(4) as f64 * 48.0,
            },
        );
        // The panel sits to the right of the data and may run past the canvas columns: the print area follows it.
        (last_row, self.data_columns + 2 + self.panel_columns - 1)
    }

    /// Fit-to-page only scales down, so a dashboard whose columns hold just their text prints as a small block in the
    /// corner of the sheet of paper. The columns carry the printed width instead.
    pub(super) fn push_autofit(&self, output: &mut Vec<Value>, last_row: usize, last_column: usize) {
        let mut fields = vec![("sheet", text_value(&self.sheet)), ("range", text_value(&format!("A:{}", col(last_column))))];
        if self.fills {
            fields.push(("minWidth", num(self.fill_width)));
        }
        output.push(operation("autofit_range", fields));
        output.push(operation(
            "autofit_range",
            vec![("sheet", text_value(&self.sheet)), ("range", text_value(&format!("1:{last_row}"))), ("rows", Value::Bool(true))],
        ));
        for (column, min_width) in self.metric_column_floors().0 {
            let letter = col(column);
            output.push(operation(
                "autofit_range",
                vec![("sheet", text_value(&self.sheet)), ("range", text_value(&format!("{letter}:{letter}"))), ("minWidth", num(min_width))],
            ));
        }
    }

    /// A chart is anchored in points, past the data block. Print and PDF export clip to the print area, so cell extents
    /// that stopped at the data dropped the chart from every exported copy: the chart edges are converted back into
    /// cells with a small margin.
    pub(super) fn push_print_setup(&self, output: &mut Vec<Value>, operation_input: &Value, end: PrintEnd) {
        let chart_last_row = if end.chart_bottom > 0.0 { math::ceil(end.chart_bottom / 15.0) as usize + 1 } else { 0 };
        let chart_last_column = if end.chart_right > 0.0 { math::ceil(end.chart_right / self.column_points) as usize + 2 } else { 0 };
        let print_columns = self.canvas_columns.max(chart_last_column).max(end.decision_last_column);
        let landscape = if self.dashboard { !self.portrait_canvas } else { prop(operation_input, "chart").is_some_and(plain_object) };
        let margin = if self.dashboard { 0.25 } else { 0.5 };
        // The print area is what the sheet actually carries.
        let area_row = end.row.max(end.decision_last_row + 1).max(end.start_row + end.value_count + 1).max(chart_last_row);
        let mut fields = vec![
            ("sheet", text_value(&self.sheet)),
            ("printArea", text_value(&format!("A1:{}{area_row}", col(print_columns)))),
            ("fitToContent", Value::Bool(true)),
        ];
        // A table that runs past the page keeps naming its columns: its header row repeats on every printed page.
        if !self.headers.is_empty() {
            fields.push(("printTitleRows", text_value(&end.start_row.to_string())));
        }
        fields.extend([
            ("orientation", text_value(if landscape { "landscape" } else { "portrait" })),
            ("fitToPagesWide", num(1.0)),
            ("fitToPagesTall", num(if self.dashboard { 1.0 } else { 0.0 })),
            ("centerHorizontally", Value::Bool(true)),
            ("centerVertically", Value::Bool(false)),
            ("topMargin", num(margin)),
            ("bottomMargin", num(margin)),
            ("leftMargin", num(margin)),
            ("rightMargin", num(margin)),
        ]);
        output.push(operation("set_page_setup", fields));
        let zoom = if !self.analysis_sheet && self.dashboard {
            120.0
        } else if !self.analysis_sheet && self.trend_dashboard {
            95.0
        } else {
            100.0
        };
        output.push(operation("set_sheet_view", vec![("sheet", text_value(&self.sheet)), ("showGridlines", Value::Bool(false)), ("zoom", num(zoom))]));
    }

    pub(super) fn canvas_columns(&self) -> usize {
        self.canvas_columns
    }
}

/// Where the sheet's sections ended, for the print set-up.
pub(super) struct PrintEnd {
    pub row: usize,
    pub start_row: usize,
    pub value_count: usize,
    pub decision_last_row: usize,
    pub decision_last_column: usize,
    pub chart_bottom: f64,
    pub chart_right: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_card_figure_is_shown_the_way_its_format_prints_it() {
        let shown = |metric: Value| metric_display_text(&metric, prop(&metric, "value"));
        assert_eq!(shown(json!({ "value": 0.47, "numberFormat": "0.0%" })), "47.0%");
        assert_eq!(shown(json!({ "value": 12, "unit": "명" })), "12명");
        assert_eq!(shown(json!({ "value": 1234567.891, "numberFormat": "#,##0" })), "1,234,568");
        assert_eq!(shown(json!({ "value": 1.005, "numberFormat": "0.00" })), "1.01");
        assert_eq!(shown(json!({ "value": "text" })), "text");
        assert_eq!(en_us_figure(0.0004, 2), "0.00");
        assert_eq!(en_us_figure(999.999, 2), "1,000.00");
        assert_eq!(en_us_figure(-1500.5, 0), "-1,501");
    }

    #[test]
    fn cards_share_the_strip_and_the_spare_columns_go_to_the_leading_ones() {
        let spans: Vec<(usize, usize, usize)> = metric_card_spans(3, 4).iter().map(|card| (card.strip, card.start_column, card.end_column)).collect();
        assert_eq!(spans, [(0, 1, 2), (0, 3, 3), (0, 4, 4)]);
        // More cards than columns wrap onto a second strip.
        let wrapped: Vec<(usize, usize, usize)> = metric_card_spans(3, 2).iter().map(|card| (card.strip, card.start_column, card.end_column)).collect();
        assert_eq!(wrapped, [(0, 1, 1), (0, 2, 2), (1, 1, 2)]);
    }

    #[test]
    fn a_table_aggregate_stands_in_for_a_formula_card() {
        let design = json!({ "tokens": { "colors": {}, "typography": {} }, "format": {} });
        let operation = json!({ "headers": ["허브", "처리량 (건)"], "rows": [["a", 100], ["b", 250]], "metrics": [{ "formula": "=SUM(Hubs[처리량 (건)])" }] });
        let layout = Layout::new(&operation, &design, None).expect("layout");
        assert_eq!(layout.measured_value(&layout.metrics[0]), Some(json!(350)));
    }

    #[test]
    fn a_header_unit_and_the_series_run_follow_the_columns() {
        assert_eq!(header_unit(Some("지출 (만 원)")), "만원");
        assert_eq!(header_unit(Some("plain")), "");
        let rows = vec![json!(["a", 100, 90, 1_000_000]), json!(["b", 120, 80, 2_000_000])];
        let headers: Vec<String> = ["x", "건 (건)", "률 (건)", "큰 (원)"].map(String::from).to_vec();
        assert_eq!(comparable_series_columns(&rows, 4, 2, &headers), Some((2, 3)));
        assert_eq!(comparable_series_columns(&[json!(["a", "b"])], 2, 1, &[]), None);
    }

    #[test]
    fn a_name_for_a_table_is_a_safe_identifier() {
        assert_eq!(safe_table_name(&json!("월 데이터")), "T");
        assert_eq!(safe_table_name(&json!("9 lives!")), "T9lives");
        assert_eq!(safe_table_name(&json!("")), "MixdogTable");
    }
}
