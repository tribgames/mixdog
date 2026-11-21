//! `design/docx/design-docx-components.mjs`: the carriers a document is drawn with (the decision callout, the metric
//! strip, the roadmap) and the section tables, as portable docx operations. A carrier is a boxed table whose cells are
//! styled one by one; a data table follows the documented anatomy (a bold header on a rule, hairlines between rows)
//! unless the operation names a table style.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, math, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Value, json};

use super::{DocxState, Props, color, color_or, colors_of, face_of, format_of, nullish_text, num};
use crate::content_model::office_number_format;
use crate::discipline::STATE_ROLES;
use crate::{array_of, first_text, first_truthy, prop, text};

/// A figure with its sign, currency, grouping, and a short unit: 38 · −4.2% · ₩740,000 · 1.6배 · 12건 · 2.6억 원.
static FIGURE_CELL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^[(+\-−]?[₩$€£¥]?\s?\d[\d,.]*\s*(?:%|%p|(?:\s?[A-Za-z가-힣]{1,3}){0,2})\)?$", ""));

/// A roadmap step written as `Label: text` (a label of up to 18 characters before the first colon).
static STEP_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([^:：]{1,18})[:：]\s*(.+)$", ""));

/// A carrier (callout box, stat strip, roadmap) is drawn as a boxed grid.
const BOXED_VARIANTS: [&str; 3] = ["callout", "scorecard", "roadmap"];

/// Hangul, kana, and Han: `[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]`. These scripts have no
/// italic and take a full em.
pub(crate) fn is_cjk(c: char) -> bool {
    matches!(c, '\u{1100}'..='\u{11ff}' | '\u{3040}'..='\u{30ff}' | '\u{3130}'..='\u{318f}' | '\u{3400}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}')
}

fn table_borders(design: &Value) -> Value {
    Props::new().set("style", "single").opt("color", color(design, "surface2")).set("size", 4).into_value()
}

/// A preset restates the cell's anatomy; a cell that already carries it (an unfilled body cell in the table's own
/// type) is not a failed edit.
fn style_cell(output: &mut Vec<Value>, table: u64, row: usize, col: usize, properties: Props) {
    output.push(json!({
        "op": "set_table_cell_style",
        "table": table,
        "row": row,
        "col": col,
        "properties": properties.into_value(),
        "allowNoChange": true,
    }));
}

/// The widths a named preset variant draws at. A plain section table takes the writer's widths from its own text
/// (`natural_column_widths` of the base crate, when the file is written): a fixed split wrapped a description beside
/// a two-word label column.
fn table_widths(columns: usize, variant: &str) -> Option<Vec<f64>> {
    if columns <= 1 {
        return Some(vec![480.0]);
    }
    match (variant, columns) {
        ("roadmap", 2) => Some(vec![86.0, 394.0]),
        ("gates", 3) => Some(vec![126.0, 190.0, 164.0]),
        ("metrics", 3) => Some(vec![146.0, 128.0, 206.0]),
        ("scorecard", _) => Some(vec![480.0 / columns as f64; columns]),
        _ => None,
    }
}

fn rows_of(values: &[Value]) -> usize {
    values.iter().map(|row| row.as_array().map_or(0, Vec::len)).max().unwrap_or(0)
}

/// `pushTable`: the table, its fit, and the 1 pt spacer paragraph that keeps what follows off its last rule. Answers
/// the table's number and its column count.
fn push_table(
    output: &mut Vec<Value>,
    state: &mut DocxState,
    values: &[Value],
    design: &Value,
    variant: &str,
    widths: Option<Vec<f64>>,
    table_style: &str,
) -> (u64, usize) {
    let columns = rows_of(values).max(1);
    state.table += 1;
    let table = state.table;
    let column_widths = widths.or_else(|| table_widths(columns, variant));
    let properties = table_properties(design, variant, values.len(), column_widths, table_style);
    output.push(json!({ "op": "add_table", "values": values, "properties": properties.into_value() }));
    output.push(json!({ "op": "fit_table", "table": table }));
    state.paragraph += 1;
    let spacer = Props::new()
        .opt("name", face_of(design, "body"))
        .num("size", 1.0)
        .opt("color", color(design, "canvas"))
        .num("spacingBefore", 2.0)
        .num("spacingAfter", if variant == "callout" { 10.0 } else { 2.0 })
        .num("lineSpacing", 2.0);
    output.push(json!({ "op": "append_text", "text": "\u{00A0}", "style": "Normal", "properties": spacer.into_value() }));
    (table, columns)
}

fn table_properties(design: &Value, variant: &str, row_count: usize, column_widths: Option<Vec<f64>>, table_style: &str) -> Props {
    let boxed = BOXED_VARIANTS.contains(&variant);
    let size = math::max(9.0, format_of(design, "body") - 0.5);
    let mut properties = Props::new();
    if boxed || !table_style.is_empty() {
        properties = properties.set("style", if table_style.is_empty() { "Table Grid" } else { table_style });
    }
    properties = properties
        .set("textStyle", "Normal")
        .opt("fontName", face_of(design, "body"))
        .num("fontSize", size)
        .opt("color", color(design, "ink"))
        .num("spacingAfter", 0.0);
    if let Some(widths) = column_widths {
        properties = properties.set("columnWidths", Value::Array(widths.into_iter().map(num).collect()));
    }
    let roadmap = variant == "roadmap";
    let height = if roadmap { 40.0 } else { math::round(size * 1.3 + 7.0) };
    properties = properties.set("rowHeights", Value::Array((0..row_count).map(|_| num(height)).collect()));
    if roadmap {
        properties = properties.set("repeatHeader", false);
    }
    if boxed {
        properties = properties.set("borders", table_borders(design));
    }
    properties.set("alignment", "center")
}

/// The points a one-line label takes at its size: Hangul, kana, and Han a full em, the rest about half of one.
fn label_points(label: &str, size: f64) -> f64 {
    let mut ems = 0.0;
    for c in label.chars() {
        ems += if is_cjk(c) { 1.0 } else { 0.55 };
    }
    ems * size
}

/// How a callout is drawn. `emphasis`: `inverse` (the dark field), `accent` or a state tone (`positive`, `warning`,
/// `critical`, `informative`): the label sits on the state's weak field in its text colour, so a verdict reads the
/// same as in a deck's badge. `label`: empty draws the field without a caption row (a section's callout names itself
/// only when the author gave it a label; an invented one told the reader the wrong thing). `east_asia`: the Korean
/// face paired with the display face the callout's text is set in.
#[derive(Debug, Clone)]
pub struct CalloutOptions<'a> {
    pub label: &'a str,
    pub emphasis: &'a str,
    pub east_asia: Option<Value>,
}

impl Default for CalloutOptions<'_> {
    fn default() -> Self {
        Self { label: "", emphasis: "inverse", east_asia: None }
    }
}

/// `addDocxDecisionCallout`.
pub fn add_docx_decision_callout(output: &mut Vec<Value>, state: &mut DocxState, written: &str, design: &Value, options: &CalloutOptions) {
    let caption = options.label;
    let emphasis = options.emphasis;
    let colors = colors_of(design);
    let has = |key: String| prop(colors, &key).is_some_and(truthy);
    let tone = if STATE_ROLES.contains(&emphasis) && has(format!("{emphasis}Weak")) && has(format!("{emphasis}Text")) { emphasis } else { "" };
    let accent = emphasis == "accent";
    let (fill, foreground) = if tone.is_empty() {
        if accent { (color(design, "accent"), color(design, "onAccent")) } else { (color(design, "inverse"), color(design, "onInverse")) }
    } else {
        (color(design, &format!("{tone}Weak")), color(design, &format!("{tone}Text")))
    };
    let values = if caption.is_empty() { vec![json!([written])] } else { vec![json!([caption]), json!([written])] };
    let (table, _) = push_table(output, state, &values, design, "callout", None, "");
    if !caption.is_empty() {
        style_cell(
            output,
            table,
            1,
            1,
            Props::new()
                .opt("fillColor", fill)
                .opt("color", foreground)
                .opt("fontName", face_of(design, "data"))
                .num("fontSize", 9.5)
                .set("bold", true)
                .set("verticalAlignment", "center"),
        );
    }
    let east_asia = options.east_asia.clone().filter(truthy);
    style_cell(
        output,
        table,
        if caption.is_empty() { 1 } else { 2 },
        1,
        Props::new()
            .opt("fillColor", color(design, "surface"))
            .opt("color", color(design, "ink"))
            .opt("fontName", face_of(design, "display"))
            .opt("fontNameEastAsia", east_asia)
            .num("fontSize", format_of(design, "body") + 1.5)
            .set("bold", true)
            .set("verticalAlignment", "center"),
    );
}

fn strip_label_style(design: &Value, face: &str) -> Props {
    Props::new()
        .opt("fillColor", color(design, "inverse"))
        .opt("color", color(design, "onInverse"))
        .opt("fontName", face_of(design, face))
        .num("fontSize", 8.5)
        .set("bold", true)
        .set("horizontalAlignment", "center")
        .set("verticalAlignment", "center")
}

fn strip_detail_style(design: &Value, fill: &str) -> Props {
    Props::new()
        .opt("fillColor", color(design, fill))
        .opt("color", color(design, "muted"))
        .opt("fontName", face_of(design, "body"))
        .num("fontSize", 8.5)
        .set("horizontalAlignment", "center")
        .set("verticalAlignment", "center")
}

/// The digits a strip figure keeps after the point when its number format names them (`/\.(0+)/`): none named means
/// every digit the number has, up to 20.
fn figure_fraction_digits(format: &str) -> Option<usize> {
    let bytes = format.as_bytes();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'.' {
            let zeros = bytes[at + 1..].iter().take_while(|next| **next == b'0').count();
            if zeros > 0 {
                return Some(zeros);
            }
        }
    }
    None
}

/// `Number.prototype.toLocaleString('en-US', { useGrouping, minimumFractionDigits, maximumFractionDigits })`: ICU
/// writes the shortest decimal that reads back as the number, rounds it half away from zero to the fraction digits
/// and shows the sign of a negative number that rounds to zero.
fn en_us_number(value: f64, grouping: bool, min_fraction: usize, max_fraction: usize) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if value.is_infinite() {
        return format!("{sign}∞");
    }
    let shortest = format!("{:e}", value.abs());
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let point = exponent.parse::<i64>().unwrap_or(0) + 1;
    let (mut whole, mut fraction) = if point <= 0 {
        ("0".to_owned(), format!("{}{digits}", "0".repeat((-point) as usize)))
    } else if point as usize >= digits.len() {
        (format!("{digits}{}", "0".repeat(point as usize - digits.len())), String::new())
    } else {
        (digits[..point as usize].to_owned(), digits[point as usize..].to_owned())
    };
    if fraction.len() > max_fraction {
        (whole, fraction) = round_half_up(&whole, &fraction, max_fraction);
    }
    while fraction.len() > min_fraction && fraction.ends_with('0') {
        fraction.pop();
    }
    while fraction.len() < min_fraction {
        fraction.push('0');
    }
    let whole = if grouping { group_thousands(&whole) } else { whole };
    if fraction.is_empty() { format!("{sign}{whole}") } else { format!("{sign}{whole}.{fraction}") }
}

/// The decimal digits `whole.fraction` cut to `max_fraction` fraction digits, the last kept one rounded up when the
/// first dropped one is 5 or more.
fn round_half_up(whole: &str, fraction: &str, max_fraction: usize) -> (String, String) {
    let round_up = fraction.as_bytes()[max_fraction] >= b'5';
    let kept = &fraction[..max_fraction];
    if !round_up {
        return (whole.to_owned(), kept.to_owned());
    }
    let mut all: Vec<u8> = whole.bytes().chain(kept.bytes()).collect();
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
    let split = all.len() - kept.len();
    (String::from_utf8_lossy(&all[..split]).into_owned(), String::from_utf8_lossy(&all[split..]).into_owned())
}

fn group_thousands(whole: &str) -> String {
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn metric_value_text(entry: &Value) -> Result<String, String> {
    let unit = js_trim(&text(prop(entry, "unit"))).to_owned();
    // A Korean counter closes on the figure (12명); a Latin unit takes the space it is read with (47,210 orders).
    let gap = if unit.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '(') { " " } else { "" };
    let suffix = if unit.is_empty() { String::new() } else { format!("{gap}{unit}") };
    let value = prop(entry, "value");
    let Some(number) = value.and_then(Value::as_f64).filter(|number| number.is_finite()) else {
        return Ok(format!("{}{suffix}", nullish_text(value)));
    };
    let format = office_number_format(entry);
    let percent = format.contains('%');
    let decimals = figure_fraction_digits(&format);
    let scaled = if percent { number * 100.0 } else { number };
    if decimals.is_some_and(|count| count > 100) {
        return Err("minimumFractionDigits value is out of range.".into());
    }
    let grouping = format.is_empty() || format.contains("#,#") || format.contains("0,0");
    let figure = en_us_number(scaled, grouping, decimals.unwrap_or(0), decimals.unwrap_or(20));
    Ok(format!("{figure}{}{suffix}", if percent { "%" } else { "" }))
}

/// `addDocxMetricStrip`: up to four figures as a boxed strip (label row, figure row, and a detail row when a metric
/// says something there). The accent marks the figure the page is about: the one marked `emphasis: true`, else the
/// first, which leads the strip.
pub fn add_docx_metric_strip(output: &mut Vec<Value>, state: &mut DocxState, metrics: &Value, design: &Value) -> Result<bool, String> {
    let entries: Vec<&Value> = array_of(Some(metrics)).map(|list| list.iter().take(4).collect()).unwrap_or_default();
    if entries.is_empty() {
        return Ok(false);
    }
    let details: Vec<String> = entries.iter().map(|entry| text(prop(entry, "detail"))).collect();
    // A detail row nobody filled is a blank band under the figures on the page, so the strip carries it only when a
    // metric actually says something there.
    let has_details = details.iter().any(|detail| !js_trim(detail).is_empty());
    let figures: Vec<Value> = entries.iter().map(|entry| metric_value_text(entry).map(Value::String)).collect::<Result<_, _>>()?;
    let mut values = vec![Value::Array(entries.iter().map(|entry| Value::String(text(prop(entry, "label")))).collect()), Value::Array(figures)];
    if has_details {
        values.push(Value::Array(details.iter().cloned().map(Value::String).collect()));
    }
    let (table, columns) = push_table(output, state, &values, design, "scorecard", None, "");
    let emphasized = entries.iter().position(|entry| prop(entry, "emphasis") == Some(&Value::Bool(true))).map_or(1, |index| index + 1);
    let body = format_of(design, "body");
    for column in 1..=columns {
        style_cell(output, table, 1, column, strip_label_style(design, "data"));
        let lead = column == emphasized;
        style_cell(
            output,
            table,
            2,
            column,
            Props::new()
                .opt("fillColor", color(design, if lead { "accent" } else { "surface" }))
                .opt("color", color(design, if lead { "onAccent" } else { "ink" }))
                .opt("fontName", face_of(design, "data"))
                .num("fontSize", math::max(15.0, body + 4.0))
                .set("bold", true)
                .set("horizontalAlignment", "center")
                .set("verticalAlignment", "center"),
        );
        if !has_details {
            continue;
        }
        style_cell(output, table, 3, column, strip_detail_style(design, if column % 2 == 0 { "canvas" } else { "surface" }));
    }
    Ok(true)
}

/// One step of a roadmap: its label and its text.
fn roadmap_step(entry: &Value, index: usize) -> (String, String) {
    let pad = format!("{:0>2}", index + 1);
    if matches!(entry, Value::Object(_) | Value::Array(_)) {
        let title = text(prop(entry, "title"));
        let detail = first_text(&[prop(entry, "detail"), prop(entry, "body")]);
        let label = first_truthy(&[prop(entry, "label"), prop(entry, "phase"), prop(entry, "week")]).map_or(pad, value_to_string);
        let joined: Vec<String> = [title, detail].into_iter().filter(|part| !part.is_empty()).collect();
        return (label, joined.join("\n"));
    }
    let line = text(Some(entry));
    match STEP_LINE.captures(&line) {
        Some(found) => (found.get(1).unwrap_or_default().to_owned(), found.get(2).unwrap_or_default().to_owned()),
        None => (pad, line),
    }
}

/// `addDocxRoadmap`: steps as a two-column boxed table (a label cell on the dark field, the first on the accent, and
/// the step's text). A step is `{ title, detail }` (with `label`, `phase` or `week` naming it) or a `Label: text`
/// string. Answers whether anything was drawn.
pub fn add_docx_roadmap(output: &mut Vec<Value>, state: &mut DocxState, steps: &Value, design: &Value) -> bool {
    let parsed: Vec<(String, String)> = array_of(Some(steps))
        .map(|list| list.iter().enumerate().map(|(index, entry)| roadmap_step(entry, index)).filter(|(_, line)| !line.is_empty()).collect())
        .unwrap_or_default();
    if parsed.is_empty() {
        return false;
    }
    // The label column takes its longest label on one line (with the cell's padding), between the 86 pt the variant
    // draws at and a third of the width: at a fixed 86 pt "야간 교대 추가" broke after 교대.
    let longest = parsed.iter().map(|(label, _)| label_points(label, 11.5)).fold(f64::NEG_INFINITY, math::max);
    let label_width = math::min(170.0, math::max(86.0, math::ceil(longest + 16.0)));
    let rows: Vec<Value> = parsed.iter().map(|(label, line)| json!([label, line])).collect();
    let (table, _) = push_table(output, state, &rows, design, "roadmap", Some(vec![label_width, 480.0 - label_width]), "");
    let body = format_of(design, "body");
    for index in 0..parsed.len() {
        let row = index + 1;
        let first = index == 0;
        style_cell(
            output,
            table,
            row,
            1,
            Props::new()
                .opt("fillColor", color(design, if first { "accent" } else { "inverse" }))
                .opt("color", color(design, if first { "onAccent" } else { "onInverse" }))
                .opt("fontName", face_of(design, "data"))
                .num("fontSize", 11.5)
                .set("bold", true)
                .set("verticalAlignment", "center"),
        );
        style_cell(
            output,
            table,
            row,
            2,
            Props::new()
                .opt("fillColor", color(design, if index % 2 == 0 { "canvas" } else { "surface" }))
                .opt("color", color(design, "ink"))
                .num("fontSize", math::max(11.5, body))
                .set("verticalAlignment", "center"),
        );
    }
    true
}

/// `values[row]?.[index]`.
fn cell_of(row: &Value, index: usize) -> Option<&Value> {
    row.as_array().and_then(|cells| cells.get(index))
}

/// Draws a metrics table as a strip, its header over every figure; answers whether the table qualified (three to five
/// rows of three cells under the header).
fn add_metrics_scorecard(output: &mut Vec<Value>, state: &mut DocxState, values: &[Value], design: &Value) -> bool {
    let metric_rows: Vec<&Value> = values.iter().skip(1).take(5).filter(|row| row.as_array().is_some_and(|cells| cells.len() >= 3)).collect();
    if metric_rows.len() < 3 {
        return false;
    }
    let detail_header = js_trim(&nullish_text(values.first().and_then(|row| cell_of(row, 2)))).to_owned();
    let strings = |column: usize| -> Vec<Value> { metric_rows.iter().map(|row| Value::String(text(cell_of(row, column)))).collect() };
    let details: Vec<Value> = metric_rows
        .iter()
        .map(|row| {
            let detail = text(cell_of(row, 2));
            Value::String(if !detail_header.is_empty() && !detail.is_empty() { format!("{detail_header}: {detail}") } else { detail })
        })
        .collect();
    let scorecard = vec![Value::Array(strings(0)), Value::Array(strings(1)), Value::Array(details)];
    let (table, columns) = push_table(output, state, &scorecard, design, "scorecard", None, "");
    let body = format_of(design, "body");
    for column in 1..=columns {
        style_cell(output, table, 1, column, strip_label_style(design, "body"));
        style_cell(
            output,
            table,
            2,
            column,
            Props::new()
                .opt("fillColor", color(design, if column == 1 { "surface" } else { "canvas" }))
                .opt("color", color(design, "accent"))
                .opt("fontName", face_of(design, "data"))
                .num("fontSize", math::max(12.5, body + 2.0))
                .set("bold", true)
                .set("horizontalAlignment", "center")
                .set("verticalAlignment", "center"),
        );
        style_cell(output, table, 3, column, strip_detail_style(design, if column % 2 == 0 { "surface" } else { "canvas" }));
    }
    true
}

/// `addDocxSectionTable`: the rows of a section's table. `variant` is the section's `kind` (`decision-gates` is
/// `gates`): the metrics variant becomes a strip, gates colour their release and stop columns by state, and a column
/// of figures is aligned to its right edge under its header. `style` names a table style; empty keeps the anatomy.
/// Answers whether anything was drawn.
pub fn add_docx_section_table(output: &mut Vec<Value>, state: &mut DocxState, values: &[Value], design: &Value, variant: &str, style: &str) -> bool {
    if values.is_empty() {
        return false;
    }
    let resolved = if variant == "decision-gates" { "gates" } else { variant };
    if resolved == "metrics" && values.len() > 2 && add_metrics_scorecard(output, state, values, design) {
        return true;
    }
    let (table, columns) = push_table(output, state, values, design, resolved, None, style);
    // A column of figures is read down its right edge, its header over it (the docx skill's table anatomy); the
    // preset left 38, 21, 0 flush left under "대기 (분)".
    let figure_column: Vec<bool> = (0..columns)
        .map(|index| {
            let body: Vec<String> =
                values.iter().skip(1).map(|row| js_trim(&nullish_text(cell_of(row, index))).to_owned()).filter(|cell| !cell.is_empty()).collect();
            index > 0 && !body.is_empty() && body.iter().all(|cell| FIGURE_CELL.is_match(cell))
        })
        .collect();
    let aligned = |properties: Props, column: usize| {
        if figure_column[column - 1] { properties.set("horizontalAlignment", "right") } else { properties }
    };
    let body = format_of(design, "body");
    for column in 1..=columns {
        // The header stays unfilled: the anatomy (or the named style) draws it, a bold row on its rule.
        let header = Props::new()
            .opt("color", color(design, "ink"))
            .opt("fontName", face_of(design, "body"))
            .num("fontSize", math::max(9.0, body - 0.5))
            .set("bold", true);
        style_cell(output, table, 1, column, aligned(header, column));
    }
    for row in 2..=values.len() {
        for column in 1..=columns {
            let metric_value = resolved == "metrics" && column == 2;
            let release = resolved == "gates" && column == 2;
            let stop = resolved == "gates" && column == 3;
            // A release gate is a positive state, a stop gate a critical one: the state fields and words, never a literal tint.
            let fill = if release {
                color_or(design, &["positiveWeak", "surface"])
            } else if stop {
                color_or(design, &["criticalWeak", "surface2", "surface"])
            } else {
                None
            };
            let ink = if metric_value {
                color(design, "accent")
            } else if release {
                color_or(design, &["positiveText", "accent"])
            } else if stop {
                color_or(design, &["criticalText", "accent2"])
            } else {
                color(design, "ink")
            };
            let cell = Props::new().opt("fillColor", fill).opt("color", ink).set("bold", column == 1 || metric_value);
            style_cell(output, table, row, column, aligned(cell, column));
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figures_are_written_the_way_intl_writes_them() {
        assert_eq!(en_us_number(-0.0, true, 0, 20), "-0");
        assert_eq!(en_us_number(-0.001, true, 0, 0), "-0");
        assert_eq!(en_us_number(-0.001, true, 2, 2), "-0.00");
        assert_eq!(en_us_number(1.005, true, 2, 2), "1.01");
        assert_eq!(en_us_number(1_234_567.891, true, 0, 20), "1,234,567.891");
        assert_eq!(en_us_number(0.1 + 0.2, true, 0, 20), "0.30000000000000004");
        assert_eq!(en_us_number(1e21, true, 0, 20), "1,000,000,000,000,000,000,000");
        assert_eq!(en_us_number(123_456_789_012_345_680_000.0, true, 0, 20), "123,456,789,012,345,680,000");
        assert_eq!(en_us_number(1e-7, true, 0, 20), "0.0000001");
        assert_eq!(en_us_number(2.5, true, 0, 0), "3");
        assert_eq!(en_us_number(-2.5, true, 0, 0), "-3");
        assert_eq!(en_us_number(0.5, true, 0, 0), "1");
        assert_eq!(en_us_number(1234.5, false, 1, 1), "1234.5");
        assert_eq!(en_us_number(9.995, true, 2, 2), "10.00");
        assert_eq!(en_us_number(5e-324, true, 0, 20), "0");
        assert_eq!(en_us_number(1.45, true, 1, 1), "1.5");
        assert_eq!(en_us_number(8.345, true, 2, 2), "8.35");
        assert_eq!(en_us_number(f64::INFINITY, true, 0, 20), "∞");
    }

    #[test]
    fn a_figure_carries_its_unit_and_the_metrics_own_format() {
        let text_of = |entry: Value| metric_value_text(&entry).expect("a figure");
        assert_eq!(text_of(json!({ "value": 47210, "unit": "orders" })), "47,210 orders");
        assert_eq!(text_of(json!({ "value": 12, "unit": "명" })), "12명");
        assert_eq!(text_of(json!({ "value": 0.928, "format": "percent" })), "92.8%");
        assert_eq!(text_of(json!({ "value": 0.5, "numberFormat": "0.00%" })), "50.00%");
        assert_eq!(text_of(json!({ "value": 1234.5, "numberFormat": "0.0" })), "1234.5");
        assert_eq!(text_of(json!({ "value": "n/a", "unit": "(x)" })), "n/a (x)");
        assert_eq!(text_of(json!({ "unit": "건" })), "건");
        let too_many = json!({ "value": 1, "numberFormat": format!("0.{}", "0".repeat(101)) });
        assert_eq!(metric_value_text(&too_many).unwrap_err(), "minimumFractionDigits value is out of range.");
    }

    #[test]
    fn a_figure_cell_is_a_number_with_a_short_unit() {
        for cell in ["38", "-4.2%", "−4.2%", "₩740,000", "1.6배", "12건", "(12)", "+3%p", "2.6억 원", "$ 5"] {
            assert!(FIGURE_CELL.is_match(cell), "{cell}");
        }
        for cell in ["", "abc", "12 months ago", "1.6 배배배배배배배", "-", "12건 건 건"] {
            assert!(!FIGURE_CELL.is_match(cell), "{cell}");
        }
    }

    #[test]
    fn a_roadmap_step_is_an_object_or_a_labelled_line() {
        assert_eq!(roadmap_step(&json!({ "title": "A", "detail": "b", "phase": "P1" }), 0), ("P1".to_owned(), "A\nb".to_owned()));
        assert_eq!(roadmap_step(&json!("Week 1: ship"), 4), ("Week 1".to_owned(), "ship".to_owned()));
        assert_eq!(roadmap_step(&json!("no label"), 2), ("03".to_owned(), "no label".to_owned()));
        assert_eq!(roadmap_step(&json!(null), 0), ("01".to_owned(), String::new()));
    }
}
