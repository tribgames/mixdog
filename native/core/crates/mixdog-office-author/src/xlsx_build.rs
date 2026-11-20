//! The Excel HTML route, second half (`authoring/xlsx-html-build.mjs`): each measured sheet (`measure_xlsx`) becomes a
//! worksheet on a column grid cut at every edge the browser drew (a card's border and its text's, a table's cells, a chart's
//! frame), so the layout lands on columns and rows of the widths and heights it had. Texts become values (numbers where a
//! table cell holds a figure, formulas where `data-formula` names one) in their type and alignment, merged across the cells
//! they span; boxes become fills and rules; charts become native charts over their data; and the page is set to print as one
//! sheet. Everything is written through the workbook batch of `mixdog-ooxml` (`apply_xlsx`), so the workbook is ordinary,
//! editable Excel.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::math::round as js_round;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use mixdog_ooxml::blank::blank_parts;
use mixdog_ooxml::blank::kind_family;
use mixdog_ooxml::blank::package_of;
use mixdog_ooxml::package::package_buffer;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx::apply_xlsx;
use mixdog_ooxml::xlsx_sheet_edits::typed_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// CSS px to points.
const PX_TO_PT: f64 = 0.75;

/// Two box edges within this many px are one edge.
const SNAP: f64 = 2.0;

/// The hidden sheet a chart without a data range keeps its labels and values in.
pub const CHART_DATA_SHEET: &str = "차트 데이터";

/// What `buildXlsxFromSheets` answers, with the workbook itself.
#[derive(Clone, Debug, PartialEq)]
pub struct BuiltXlsx {
    /// The package as bytes.
    pub bytes: Vec<u8>,
    /// How many operations the workbook batch held.
    pub operations: usize,
    /// What the build left as written, one sentence each.
    pub notes: Vec<String>,
}

/// `columnLabel(number)`: 1 is `A`, 27 is `AA`; 0 is the empty label.
fn column_label(number: usize) -> String {
    let mut value = number;
    let mut label = Vec::new();
    while value > 0 {
        value -= 1;
        label.push(b'A' + (value % 26) as u8);
        value /= 26;
    }
    label.reverse();
    String::from_utf8(label).unwrap_or_default()
}

/// `quoted(name)`: a sheet name as a formula writes it, in quotes unless it is a plain identifier.
fn quoted(name: &str) -> String {
    let mut chars = name.chars();
    let plain = chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain { name.to_owned() } else { format!("'{}'", name.replace('\'', "''")) }
}

/// Excel's column width is in characters of the workbook's digit (7 px for the default Calibri 11): px = 7w + 5 from one
/// character up, 12 px per character under it.
fn column_characters(px: f64) -> f64 {
    if px >= 12.0 { (px - 5.0) / 7.0 } else { (px / 12.0).max(0.08) }
}

/// A box in CSS px.
#[derive(Clone, Copy, Debug)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn rect_of(item: &Value) -> Rect {
    let side = |key: &str| to_number_of(item.get("rect").and_then(|rect| rect.get(key)));
    Rect { left: side("left"), top: side("top"), right: side("right"), bottom: side("bottom") }
}

fn area(rect: Rect) -> f64 {
    (rect.right - rect.left) * (rect.bottom - rect.top)
}

/// The distinct edges of every box, snapped: within two pixels is one edge.
fn edges(values: &[f64], extent: f64) -> Vec<f64> {
    let mut sorted: Vec<f64> = std::iter::once(0.0).chain(values.iter().copied()).chain(std::iter::once(extent)).filter(|value| value.is_finite()).collect();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mut out: Vec<f64> = Vec::new();
    for value in sorted {
        if out.last().is_none_or(|last| value - last > SNAP) {
            out.push(value);
        }
    }
    out
}

/// The index of the edge nearest to `value` (the first of equals).
fn index_of(list: &[f64], value: f64) -> usize {
    let mut best = 0;
    for index in 1..list.len() {
        if (list[index] - value).abs() < (list[best] - value).abs() {
            best = index;
        }
    }
    best
}

/// The columns and rows of one sheet.
struct Grid {
    xs: Vec<f64>,
    ys: Vec<f64>,
}

/// The cells a box spans: the zero-based corners, the range and the first cell.
struct Span {
    c0: usize,
    c1: usize,
    r0: usize,
    r1: usize,
    range: String,
    cell: String,
}

impl Grid {
    fn span(&self, rect: Rect) -> Span {
        let c0 = index_of(&self.xs, rect.left);
        let c1 = (c0 + 1).max(index_of(&self.xs, rect.right));
        let r0 = index_of(&self.ys, rect.top);
        let r1 = (r0 + 1).max(index_of(&self.ys, rect.bottom));
        Span {
            c0,
            c1,
            r0,
            r1,
            range: format!("{}{}:{}{}", column_label(c0 + 1), r0 + 1, column_label(c1), r1),
            cell: format!("{}{}", column_label(c0 + 1), r0 + 1),
        }
    }

    /// `A1:<last column><last row>`: the whole sheet.
    fn whole(&self) -> String {
        format!("A1:{}{}", column_label(self.xs.len() - 1), self.ys.len() - 1)
    }
}

/// What a text's cell holds: a formula, or a value, with the number format it was written in.
struct Content {
    formula: Option<String>,
    value: Option<Value>,
    format: Option<Value>,
}

/// `item.format || fallback`.
fn format_or(own: Option<&Value>, fallback: String) -> Value {
    match own {
        Some(own) if truthy(own) => own.clone(),
        _ => Value::String(fallback),
    }
}

/// A table cell's text as a value: a figure is a number in the format it was written in ("184,200" is `#,##0`, "+12.0%" is
/// `+0.0%`), an ISO date is a date; `data-value` and `data-format` override, `data-formula` writes a formula.
fn cell_content(item: &Value, figures: bool) -> Content {
    let own_format = item.get("format");
    if item.get("formula").is_some_and(truthy) {
        let formula = value_to_string(&item["formula"]);
        let formula = if formula.starts_with('=') { formula } else { format!("={formula}") };
        return Content { formula: Some(formula), value: None, format: own_format.cloned() };
    }
    if let Some(value) = item.get("value") {
        return Content { formula: None, value: Some(value.clone()), format: own_format.cloned() };
    }
    let text = item.get("text").filter(|text| truthy(text)).map(value_to_string).unwrap_or_default();
    if figures {
        let trimmed = js_trim(&text);
        let signed = trimmed.strip_prefix('\u{2212}').map_or_else(|| trimmed.to_owned(), |rest| format!("-{rest}"));
        if let Some(figure) = typed_number(&Value::String(signed)) {
            let percent = trimmed.ends_with('%');
            let digits = trimmed.strip_suffix('%').unwrap_or(trimmed);
            let mut parts = digits.split('.');
            let whole = parts.next().unwrap_or_default();
            let decimals = parts.next().unwrap_or_default();
            let fraction = if decimals.is_empty() { String::new() } else { format!(".{}", "0".repeat(utf16_len(decimals))) };
            let grouped = if whole.contains(',') || figure.value.abs() >= 1000.0 { "#,##0" } else { "0" };
            let mut format = format!("{}{fraction}{}", if percent { "0" } else { grouped }, if percent { "%" } else { "" });
            if trimmed.starts_with('+') {
                format = format!("+{format};-{format};{format}");
            }
            return Content { formula: None, value: Some(json_number(figure.value)), format: Some(format_or(own_format, format)) };
        }
        if is_iso_date(&text) {
            return Content { formula: None, value: Some(Value::String(text)), format: Some(format_or(own_format, "yyyy-mm-dd".to_owned())) };
        }
    }
    Content { formula: None, value: Some(Value::String(text)), format: own_format.cloned() }
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn is_iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10 && bytes.iter().enumerate().all(|(at, byte)| if at == 4 || at == 7 { *byte == b'-' } else { byte.is_ascii_digit() })
}

/// A colour as the chart takes it: without its leading `#`.
fn bare_color(color: &Value) -> String {
    let text = value_to_string(color);
    let stripped = text.strip_prefix('#').map(str::to_owned);
    stripped.unwrap_or(text)
}

/// A chart's `data-chart` spec as `add_chart` reads it. One series with one colour set apart is a highlight.
fn chart_operation(chart: &Value, sheet: &str, cell: &str, to_column: &str, range: &str) -> Value {
    let empty = Value::Object(Map::new());
    let spec = chart.get("spec").filter(|spec| truthy(spec)).unwrap_or(&empty);
    let requested = spec.get("type").filter(|kind| truthy(kind)).map_or_else(|| "col".to_owned(), value_to_string);
    let kind = match js_to_lowercase(&requested).as_str() {
        "bar" => "bar",
        "line" => "line",
        "area" => "area",
        "pie" => "pie",
        "doughnut" => "doughnut",
        _ => "column",
    };
    let colors: Vec<String> = spec.get("colors").and_then(Value::as_array).map(|list| list.iter().map(bare_color).collect()).unwrap_or_default();
    let single = !spec.get("series").is_some_and(Value::is_array);
    let mut palette = colors.clone();
    let mut highlight = None;
    let mut muted = None;
    if single && colors.len() > 1 && !matches!(kind, "pie" | "doughnut") {
        let mut distinct: Vec<&String> = Vec::new();
        for color in &colors {
            if !distinct.contains(&color) {
                distinct.push(color);
            }
        }
        let odd = colors.iter().position(|color| colors.iter().filter(|other| *other == color).count() == 1);
        if let (2, Some(odd)) = (distinct.len(), odd) {
            highlight = Some(odd);
            palette = vec![colors[odd].clone()];
            muted = colors.iter().find(|color| **color != colors[odd]).cloned();
        }
    }
    let rect = rect_of(chart);
    let mut op = Map::new();
    op.insert("op".into(), json!("add_chart"));
    op.insert("sheet".into(), json!(sheet));
    op.insert("range".into(), json!(range));
    op.insert("cell".into(), json!(cell));
    op.insert("toColumn".into(), json!(to_column));
    op.insert("height".into(), json_number(js_round(rect.bottom - rect.top) * PX_TO_PT));
    op.insert("chartType".into(), json!(kind));
    if let Some(title) = chart.get("title").filter(|title| truthy(title)) {
        op.insert("title".into(), title.clone());
    }
    if !palette.is_empty() {
        op.insert("seriesColors".into(), json!(palette));
    }
    if let Some(highlight) = highlight {
        op.insert("highlight".into(), json!(highlight));
        op.insert("mutedColor".into(), json!(muted));
    }
    let flag = |key: &str| spec.get(key).is_some_and(truthy);
    op.insert("showValues".into(), json!(spec.get("showValues") != Some(&json!(false))));
    op.insert("showLegend".into(), json!(flag("legend")));
    op.insert("gridlines".into(), json!(flag("grid")));
    op.insert("valueAxis".into(), json!(spec.get("valueAxis") == Some(&json!(true))));
    op.insert("zeroBaseline".into(), json!(true));
    if let Some(format) = spec.get("format").filter(|format| truthy(format)) {
        op.insert("valueNumberFormat".into(), format.clone());
    }
    if let Some(font) = chart.get("font").filter(|font| truthy(font)) {
        op.insert("fontName".into(), font.clone());
    }
    Value::Object(op)
}

/// Where the element with an id landed: its sheet and its cell.
type Placed = BTreeMap<String, (String, String)>;

/// `/\{([A-Za-z][\w-]*)\}/g`: each placeholder's start, end and id.
fn placeholders(text: &str) -> Vec<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'{' && bytes.get(at + 1).is_some_and(u8::is_ascii_alphabetic) {
            let mut end = at + 2;
            while bytes.get(end).is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-') {
                end += 1;
            }
            if bytes.get(end) == Some(&b'}') {
                found.push((at, end + 1, &text[at + 1..end]));
                at = end + 1;
                continue;
            }
        }
        at += 1;
    }
    found
}

/// `{id}` in a formula or a chart's data-range is the cell the element with that id landed on, qualified with its sheet when
/// the formula stands on another, so the HTML names its cells without knowing the grid they land on.
fn resolve_placeholders(text: &str, sheet: &str, cells: &Placed, notes: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    for (start, end, id) in placeholders(text) {
        out.push_str(&text[from..start]);
        match cells.get(id) {
            None => {
                notes.push(format!("{{{id}}} names no element with that id; it was left as written"));
                out.push_str(&text[start..end]);
            }
            Some((cell_sheet, cell)) if cell_sheet == sheet => out.push_str(cell),
            Some((cell_sheet, cell)) => out.push_str(&format!("{}!{cell}", quoted(cell_sheet))),
        }
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

/// A chart's range, area by area: an area named by placeholders takes its sheet once, at its front (`'보고'!B14:B18`).
fn resolve_range(text: &str, cells: &Placed, notes: &mut Vec<String>) -> String {
    text.split(',')
        .map(|area| {
            let ids: Vec<&str> = placeholders(area).into_iter().map(|(_, _, id)| id).collect();
            let sheet = ids.iter().filter_map(|id| cells.get(*id)).map(|(sheet, _)| sheet.as_str()).find(|sheet| !sheet.is_empty());
            match sheet {
                Some(sheet) if !ids.is_empty() => format!("{}!{}", quoted(sheet), js_trim(&resolve_placeholders(area, sheet, cells, notes))),
                _ => resolve_placeholders(area, "", cells, notes),
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The operations in the order they were found: values and layout first, formulas and charts after every sheet's values.
struct Operations {
    first: Vec<Value>,
    later: Vec<Value>,
    placed: Placed,
}

/// A fill on every cell of the item, each rule on its edge.
fn decorate(first: &mut Vec<Value>, name: &str, grid: &Grid, item: &Value) {
    let span = grid.span(rect_of(item));
    if let Some(fill) = item.get("fill").filter(|fill| truthy(fill)) {
        first.push(json!({ "op": "set_style", "sheet": name, "range": span.range, "properties": { "fillColor": fill } }));
    }
    if let Some(borders) = item.get("borders").filter(|borders| truthy(borders)).and_then(Value::as_object) {
        let (c0, c1, r0, r1) = (span.c0, span.c1, span.r0, span.r1);
        let side = |edge: &str| match edge {
            "top" => Some(format!("{}{}:{}{}", column_label(c0 + 1), r0 + 1, column_label(c1), r0 + 1)),
            "bottom" => Some(format!("{}{}:{}{}", column_label(c0 + 1), r1, column_label(c1), r1)),
            "left" => Some(format!("{}{}:{}{}", column_label(c0 + 1), r0 + 1, column_label(c0 + 1), r1)),
            "right" => Some(format!("{}{}:{}{}", column_label(c1), r0 + 1, column_label(c1), r1)),
            _ => None,
        };
        for (edge, border) in borders {
            if truthy(border) {
                let mut one = Map::new();
                one.insert(edge.clone(), border.clone());
                first.push(json!({ "op": "set_style", "sheet": name, "range": side(edge), "properties": { "borders": one } }));
            }
        }
    }
}

/// A text or a table cell: the value at the top-left, merged across the cells the text spans, in its own type.
fn write_item(out: &mut Operations, name: &str, grid: &Grid, item: &Value, figures: bool, merge: bool) {
    let span = grid.span(rect_of(item));
    if let Some(id) = item.get("id").filter(|id| truthy(id)) {
        out.placed.insert(value_to_string(id), (name.to_owned(), span.cell.clone()));
    }
    if item.get("fill").is_some_and(truthy) || item.get("borders").is_some_and(truthy) {
        decorate(&mut out.first, name, grid, item);
    }
    if merge && (span.c1 - span.c0 > 1 || span.r1 - span.r0 > 1) {
        out.first.push(json!({ "op": "merge_cells", "sheet": name, "range": span.range }));
    }
    let content = cell_content(item, figures);
    if let Some(formula) = &content.formula {
        out.later.push(json!({ "op": "set_formula", "sheet": name, "cell": span.cell, "formula": formula }));
    } else if let Some(value) = content.value.as_ref().filter(|value| **value != json!("")) {
        out.first.push(json!({ "op": "set_range", "sheet": name, "range": span.cell, "values": [[value]] }));
    }
    // data-note: the figure's source or assumption, as the cell's note.
    if let Some(note) = item.get("note").filter(|note| truthy(note)) {
        out.later.push(json!({ "op": "add_note", "sheet": name, "cell": span.cell, "text": note }));
    }
    let wrap = to_number_of(item.get("lines")) > 1.0;
    let mut properties = Map::new();
    if let Some(font) = item.get("font").filter(|font| truthy(font)) {
        properties.insert("fontName".into(), font.clone());
    }
    for (key, source) in [("fontSize", "size"), ("bold", "bold"), ("italic", "italic"), ("color", "color"), ("horizontalAlignment", "align")] {
        if let Some(value) = item.get(source) {
            properties.insert(key.into(), value.clone());
        }
    }
    let vertical = match item.get("valign").filter(|valign| truthy(valign)) {
        Some(valign) => valign.clone(),
        None => json!(if wrap { "top" } else { "center" }),
    };
    properties.insert("verticalAlignment".into(), vertical);
    if wrap {
        properties.insert("wrapText".into(), json!(true));
    }
    if let Some(indent) = item.get("indent").filter(|indent| truthy(indent)) {
        properties.insert("indent".into(), indent.clone());
    }
    if let Some(format) = content.format.filter(|format| truthy(format)) {
        properties.insert("numberFormat".into(), format);
    }
    let range = if merge { span.range.clone() } else { span.cell.clone() };
    out.first.push(json!({ "op": "set_style", "sheet": name, "range": range, "properties": properties }));
}

/// The labels and values a chart without a data range keeps in the hidden data sheet: its block (a header row, then one
/// row per label) and the range the chart reads it from, which starts at row `start`.
fn chart_data_block(chart: &Value, start: usize) -> (Vec<Vec<Value>>, String) {
    let empty = Value::Object(Map::new());
    let spec = chart.get("spec").filter(|spec| truthy(spec)).unwrap_or(&empty);
    let series: Vec<Value> = match spec.get("series").and_then(Value::as_array) {
        Some(series) => series.clone(),
        None => {
            let label = [spec.get("name"), chart.get("title")].into_iter().flatten().find(|value| truthy(value)).cloned().unwrap_or_else(|| json!("값"));
            let values = spec.get("values").filter(|values| truthy(values)).cloned().unwrap_or_else(|| json!([]));
            vec![json!({ "name": label, "values": values })]
        }
    };
    let labels = items(spec, "labels");
    let header = std::iter::once(json!(""))
        .chain(series.iter().map(|entry| entry.get("name").filter(|name| truthy(name)).cloned().unwrap_or_else(|| json!(""))))
        .collect();
    let mut block: Vec<Vec<Value>> = vec![header];
    for (index, label) in labels.iter().enumerate() {
        let figures = series.iter().map(|entry| {
            let value = entry.get("values").and_then(|values| values.get(index)).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!(0));
            json_number(to_number_of(Some(&value)))
        });
        block.push(std::iter::once(json!(value_to_string(label))).chain(figures).collect());
    }
    let range = format!("{}!A{start}:{}{}", quoted(CHART_DATA_SHEET), column_label(series.len() + 1), start + block.len() - 1);
    (block, range)
}

/// The operations that write one measured workbook; formulas and charts come after every sheet's values.
pub fn xlsx_operations_from_sheets(sheets: &[Value], captures: &BTreeMap<usize, PathBuf>, notes: &mut Vec<String>) -> Vec<Value> {
    let mut out = Operations { first: Vec::new(), later: Vec::new(), placed: Placed::new() };
    let mut chart_data: Vec<Vec<Vec<Value>>> = Vec::new();
    for (sheet_index, sheet) in sheets.iter().enumerate() {
        let name = value_to_string(sheet.get("name").unwrap_or(&Value::Null));
        let name = name.as_str();
        out.first.push(if sheet_index == 0 {
            json!({ "op": "rename_sheet", "sheet": "Sheet1", "name": name })
        } else {
            json!({ "op": "add_sheet", "name": name })
        });
        let tables = items(sheet, "tables");
        let cells: Vec<&Value> = tables.iter().flat_map(|table| items(table, "rows")).flat_map(|row| row.as_array().into_iter().flatten()).collect();
        let (texts, boxes, charts, pictures) = (items(sheet, "texts"), items(sheet, "boxes"), items(sheet, "charts"), items(sheet, "pictures"));
        let rects: Vec<Rect> = texts.iter().chain(boxes).chain(cells.iter().copied()).chain(charts).chain(pictures).map(rect_of).collect();
        // The sheet ends where its content does, plus the section's own right and bottom padding: a section left at the page's
        // width (a data sheet) gave its last column the rest of the browser window.
        let right = rects.iter().map(|rect| rect.right).fold(1.0, f64::max);
        let bottom = rects.iter().map(|rect| rect.bottom).fold(1.0, f64::max);
        let padding = |key: &str| {
            let pad = to_number_of(sheet.get(key));
            if pad.is_nan() { 0.0 } else { pad }
        };
        let xs = edges(&rects.iter().flat_map(|rect| [rect.left, rect.right]).collect::<Vec<_>>(), right + padding("padRight"));
        let ys = edges(&rects.iter().flat_map(|rect| [rect.top, rect.bottom]).collect::<Vec<_>>(), bottom + padding("padBottom"));
        let grid = Grid { xs, ys };
        // Columns and rows at the widths and heights the browser drew.
        for index in 0..grid.xs.len().saturating_sub(1) {
            let width = js_round(column_characters(grid.xs[index + 1] - grid.xs[index]) * 100.0) / 100.0;
            out.first.push(json!({ "op": "set_column_width", "sheet": name, "column": column_label(index + 1), "width": json_number(width) }));
        }
        for index in 0..grid.ys.len().saturating_sub(1) {
            let height = js_round((grid.ys[index + 1] - grid.ys[index]) * PX_TO_PT * 100.0) / 100.0;
            out.first.push(json!({ "op": "set_row_height", "sheet": name, "row": index + 1, "height": json_number(height) }));
        }
        let mut base = Map::new();
        if let Some(font) = sheet.get("font").filter(|font| truthy(font)) {
            base.insert("fontName".into(), font.clone());
        }
        out.first.push(json!({ "op": "set_style", "sheet": name, "range": grid.whole(), "properties": base }));
        // Boxes, outer first so a card's fill sits over its panel's.
        let mut by_area: Vec<&Value> = boxes.iter().collect();
        by_area.sort_by(|a, b| area(rect_of(b)).partial_cmp(&area(rect_of(a))).unwrap_or(std::cmp::Ordering::Equal));
        for item in by_area {
            decorate(&mut out.first, name, &grid, item);
        }
        // Texts and table cells.
        for text in texts {
            write_item(&mut out, name, &grid, text, false, true);
        }
        for table in tables {
            let named = table.get("name").is_some_and(truthy);
            let rows = items(table, "rows");
            for row in rows {
                for cell in row.as_array().into_iter().flatten() {
                    write_item(&mut out, name, &grid, cell, !cell.get("header").is_some_and(truthy), !named);
                }
            }
            if rows.is_empty() {
                continue;
            }
            let corners = grid.span(rect_of(table));
            let table_range = format!("{}{}:{}{}", column_label(corners.c0 + 1), corners.r0 + 1, column_label(corners.c1), corners.r1);
            if named {
                let style = table.get("style").filter(|style| truthy(style)).cloned().unwrap_or_else(|| json!("TableStyleLight1"));
                out.first.push(json!({ "op": "add_table", "sheet": name, "range": table_range, "name": table["name"], "style": style }));
            }
            if table.get("freezeHeader").is_some_and(truthy) {
                out.later.push(json!({ "op": "freeze_panes", "sheet": name, "row": corners.r0 + 2 }));
            }
            let headed = rows[0].as_array().is_some_and(|row| row.iter().any(|cell| cell.get("header").is_some_and(truthy)));
            if headed && charts.is_empty() && boxes.is_empty() {
                out.later.push(json!({ "op": "set_page_setup", "sheet": name, "printTitleRows": format!("{}", corners.r0 + 1) }));
            }
        }
        // Charts over their data: the data-range given, else the spec's labels and values in the hidden data sheet.
        for chart in charts {
            let span = grid.span(rect_of(chart));
            let range = match chart.get("range").filter(|range| truthy(range)) {
                Some(range) => value_to_string(range),
                None => {
                    let start = chart_data.iter().fold(1, |row, block| row + block.len() + 1);
                    let (block, range) = chart_data_block(chart, start);
                    chart_data.push(block);
                    range
                }
            };
            out.later.push(chart_operation(chart, name, &span.cell, &column_label(span.c1), &range));
        }
        for picture in pictures {
            let Some(path) = picture.get("capture").and_then(Value::as_u64).and_then(|number| captures.get(&(number as usize))) else { continue };
            let span = grid.span(rect_of(picture));
            let rect = rect_of(picture);
            let alt = picture.get("alt").filter(|alt| truthy(alt)).cloned().unwrap_or_else(|| json!("picture"));
            out.later.push(json!({
                "op": "add_image",
                "sheet": name,
                "path": path.display().to_string(),
                "cell": span.cell,
                "width": json_number((rect.right - rect.left) * PX_TO_PT),
                "height": json_number((rect.bottom - rect.top) * PX_TO_PT),
                "altText": alt,
            }));
        }
        // The sheet as the HTML showed it: no gridlines unless asked, printed one page wide (one page for a report).
        out.later.push(json!({ "op": "set_sheet_view", "sheet": name, "showGridlines": sheet.get("gridlines").is_some_and(truthy) }));
        let report = !charts.is_empty() || !boxes.is_empty() || !texts.is_empty();
        let orientation = match sheet.get("orientation").filter(|orientation| truthy(orientation)) {
            Some(orientation) => orientation.clone(),
            None => json!(if grid.xs.last().copied().unwrap_or(0.0) > grid.ys.last().copied().unwrap_or(0.0) { "landscape" } else { "portrait" }),
        };
        let mut setup = Map::new();
        setup.insert("op".into(), json!("set_page_setup"));
        setup.insert("sheet".into(), json!(name));
        setup.insert("printArea".into(), json!(grid.whole()));
        setup.insert("orientation".into(), orientation);
        setup.insert("fitToPagesWide".into(), json!(1));
        if report || sheet.get("fit") == Some(&json!("page")) {
            setup.insert("fitToPagesTall".into(), json!(1));
        }
        out.later.push(Value::Object(setup));
        if let Some(freeze) = sheet.get("freeze").filter(|freeze| truthy(freeze)) {
            out.later.push(json!({ "op": "freeze_panes", "sheet": name, "row": json_number(to_number_of(Some(freeze))) }));
        }
        if sheet.get("hidden").is_some_and(truthy) {
            out.later.push(json!({ "op": "set_sheet_visibility", "sheet": name, "visible": false }));
        }
    }
    if !chart_data.is_empty() {
        out.first.push(json!({ "op": "add_sheet", "name": CHART_DATA_SHEET }));
        let mut row = 1;
        for block in &chart_data {
            out.first.push(json!({
                "op": "set_range",
                "sheet": CHART_DATA_SHEET,
                "range": format!("A{row}:{}{}", column_label(block[0].len()), row + block.len() - 1),
                "values": block,
            }));
            row += block.len() + 1;
        }
        out.later.push(json!({ "op": "set_sheet_visibility", "sheet": CHART_DATA_SHEET, "visible": false }));
    }
    let Operations { first, mut later, placed } = out;
    for operation in &mut later {
        match operation["op"].as_str() {
            Some("set_formula") => {
                let (sheet, formula) = (value_to_string(&operation["sheet"]), value_to_string(&operation["formula"]));
                operation["formula"] = Value::String(resolve_placeholders(&formula, &sheet, &placed, notes));
            }
            Some("add_chart") => {
                let range = value_to_string(&operation["range"]);
                operation["range"] = Value::String(resolve_range(&range, &placed, notes));
            }
            _ => {}
        }
    }
    first.into_iter().chain(later).collect()
}

/// Writes the measured sheets (`measure["sheets"]`) as an .xlsx. `captures` are the picture files of the photographed
/// elements by capture number; the pictures are read through `proof` and `registry` holds the faces the workbook batch
/// measures in.
pub fn build_xlsx_from_sheets<P: ReadProof>(
    proof: &P,
    registry: &Registry,
    measure: &Value,
    captures: &BTreeMap<usize, PathBuf>,
    title: &str,
) -> Result<BuiltXlsx, String> {
    let sheets = items(measure, "sheets");
    if sheets.is_empty() {
        return Err("The HTML holds no <section data-sheet=\"이름\">; every worksheet is one section with its sheet name.".to_owned());
    }
    let family = kind_family("xlsx").ok_or_else(|| "Portable Office creation does not support xlsx".to_owned())?;
    let parts = blank_parts(family, if title.is_empty() { "Untitled" } else { title }, "xlsx", "Sheet1").unwrap_or_default();
    let mut zip = package_of(&parts);
    let mut notes = Vec::new();
    let operations = xlsx_operations_from_sheets(sheets, captures, &mut notes);
    let measurer = TextMeasurer::new(proof, registry);
    apply_xlsx(proof, &measurer, &mut zip, &operations)?;
    Ok(BuiltXlsx { bytes: package_buffer(&zip)?, operations: operations.len(), notes })
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    fn rect(left: f64, top: f64, right: f64, bottom: f64) -> Value {
        json!({ "left": left, "top": top, "right": right, "bottom": bottom })
    }

    fn with(mut item: Value, extra: Value) -> Value {
        item.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        item
    }

    fn text(value: &str, rect: Value, extra: Value) -> Value {
        with(
            json!({ "rect": rect, "text": value, "font": "Malgun Gothic", "size": 9, "bold": false, "italic": false, "color": "374151", "align": "left", "lines": 1, "indent": 0 }),
            extra,
        )
    }

    fn sheet(name: &str, texts: Vec<Value>) -> Value {
        json!({ "name": name, "texts": texts, "boxes": [], "tables": [], "charts": [], "pictures": [], "padRight": 0, "padBottom": 0, "gridlines": false })
    }

    #[test]
    fn column_labels_count_in_letters() {
        assert_eq!(column_label(0), "");
        assert_eq!(column_label(1), "A");
        assert_eq!(column_label(26), "Z");
        assert_eq!(column_label(27), "AA");
        assert_eq!(column_label(702), "ZZ");
        assert_eq!(column_label(703), "AAA");
    }

    #[test]
    fn a_sheet_name_is_quoted_unless_it_is_an_identifier() {
        assert_eq!(quoted("Ops"), "Ops");
        assert_eq!(quoted("_a1"), "_a1");
        assert_eq!(quoted("보고"), "'보고'");
        assert_eq!(quoted("it's"), "'it''s'");
        assert_eq!(quoted("1st"), "'1st'");
        assert_eq!(quoted(""), "''");
    }

    #[test]
    fn a_column_is_seven_pixels_a_character_plus_five() {
        assert_eq!(column_characters(75.0), 10.0);
        assert_eq!(column_characters(12.0), 1.0);
        assert_eq!(column_characters(6.0), 0.5);
        assert_eq!(column_characters(0.5), 0.08);
    }

    #[test]
    fn edges_within_two_pixels_are_one_edge() {
        assert_eq!(edges(&[24.0, 25.5, 100.0, 102.0, f64::NAN, 300.0], 400.0), vec![0.0, 24.0, 100.0, 300.0, 400.0]);
        assert_eq!(edges(&[], 1.0), vec![0.0]);
        assert_eq!(index_of(&[0.0, 24.0, 100.0], 62.0), 1);
        assert_eq!(index_of(&[0.0, 24.0, 100.0], 63.0), 2);
    }

    #[test]
    fn placeholders_are_found_where_the_pattern_has_them() {
        let found: Vec<&str> = placeholders("={w6}-{w9}+{1a}+{a b}+{ok-id_2}{").into_iter().map(|(_, _, id)| id).collect();
        assert_eq!(found, vec!["w6", "w9", "ok-id_2"]);
    }

    #[test]
    fn a_placeholder_is_the_cell_its_element_landed_on() {
        let mut placed = Placed::new();
        placed.insert("a".into(), ("보고".into(), "B2".into()));
        placed.insert("b".into(), ("Ops".into(), "C3".into()));
        let mut notes = Vec::new();
        assert_eq!(resolve_placeholders("={a}-{b}*{gone}", "보고", &placed, &mut notes), "=B2-Ops!C3*{gone}");
        assert_eq!(notes, vec!["{gone} names no element with that id; it was left as written"]);
        assert_eq!(resolve_range("{a}:{a},{b}:{b}", &placed, &mut notes), "'보고'!B2:B2,Ops!C3:C3");
        assert_eq!(resolve_range("Ops!A1:B2", &placed, &mut notes), "Ops!A1:B2");
    }

    #[test]
    fn a_figure_is_a_number_in_the_format_it_was_written_in() {
        let cell = |text: &str, extra: Value| cell_content(&with(json!({ "text": text }), extra), true);
        let cases = [
            ("184,200", json!(184200), "#,##0"),
            ("1234", json!(1234), "#,##0"),
            ("12", json!(12), "0"),
            ("+12.0%", json!(0.12), "+0.0%;-0.0%;0.0%"),
            ("\u{2212}5", json!(-5), "0"),
            ("3.50", json!(3.5), "0.00"),
            ("2026-09-30", json!("2026-09-30"), "yyyy-mm-dd"),
        ];
        for (source, value, format) in cases {
            let content = cell(source, json!({}));
            assert_eq!((content.value, content.format), (Some(value), Some(json!(format))), "{source}");
        }
        for plain in ["007", "1,2", "1 2", "1e3"] {
            let content = cell(plain, json!({}));
            assert_eq!((content.value, content.format), (Some(json!(plain)), None), "{plain}");
        }
        assert_eq!(cell("12", json!({ "format": "0\"분\"" })).format, Some(json!("0\"분\"")));
        let valued = cell("shown", json!({ "value": "007" }));
        assert_eq!((valued.value, valued.format), (Some(json!("007")), None));
        let formula = cell("37", json!({ "formula": "{a}-{b}", "format": "0" }));
        assert_eq!((formula.formula.as_deref(), formula.value), (Some("={a}-{b}"), None));
        assert_eq!(cell_content(&json!({ "text": "184,200" }), false).value, Some(json!("184,200")));
    }

    #[test]
    fn one_set_apart_colour_makes_a_highlight() {
        let chart = json!({ "rect": rect(0.0, 0.0, 300.0, 200.4), "title": "대기", "spec": { "type": "COL", "colors": ["#C9CED6", "#1F5E4B", "C9CED6"], "format": "0\"분\"" } });
        let op = chart_operation(&chart, "보고", "E5", "H12", "'보고'!B2:B3");
        assert_eq!(
            (op["chartType"].clone(), op["highlight"].clone(), op["mutedColor"].clone(), op["seriesColors"].clone()),
            (json!("column"), json!(1), json!("C9CED6"), json!(["1F5E4B"]))
        );
        assert_eq!(
            (op["height"].clone(), op["showValues"].clone(), op["showLegend"].clone(), op["valueAxis"].clone(), op["valueNumberFormat"].clone()),
            (json!(150), json!(true), json!(false), json!(false), json!("0\"분\""))
        );
        let pie = chart_operation(&json!({ "rect": rect(0.0, 0.0, 1.0, 1.0), "spec": { "type": "pie", "colors": ["a", "b", "b"] } }), "S", "A1", "B2", "A1:B2");
        assert!(pie.get("highlight").is_none() && pie["seriesColors"] == json!(["a", "b", "b"]));
    }

    #[test]
    fn texts_become_cells_on_a_grid_cut_at_their_edges() {
        let sheets =
            vec![sheet("보고", vec![text("제목", rect(24.0, 24.0, 876.0, 54.0), json!({})), text("값", rect(24.0, 60.0, 124.0, 90.0), json!({ "lines": 2 }))])];
        let mut notes = Vec::new();
        let operations = xlsx_operations_from_sheets(&sheets, &BTreeMap::new(), &mut notes);
        assert_eq!(operations[0], json!({ "op": "rename_sheet", "sheet": "Sheet1", "name": "보고" }));
        let named = |name: &str| operations.iter().filter(|op| op["op"] == json!(name)).count();
        // Edges 0 24 124 876 across, 0 24 54 60 90 down: three columns and four rows.
        assert_eq!((named("set_column_width"), named("set_row_height")), (3, 4));
        assert_eq!(operations[1], json!({ "op": "set_column_width", "sheet": "보고", "column": "A", "width": 2.71 }));
        assert!(operations.contains(&json!({ "op": "merge_cells", "sheet": "보고", "range": "B2:C2" })));
        assert!(operations.contains(&json!({ "op": "set_range", "sheet": "보고", "range": "B2", "values": [["제목"]] })));
        let wrapped = operations.iter().find(|op| op["range"] == json!("B4:B4") && op["op"] == json!("set_style")).expect("the wrapped text's style");
        assert_eq!((wrapped["properties"]["wrapText"].clone(), wrapped["properties"]["verticalAlignment"].clone()), (json!(true), json!("top")));
        assert_eq!(operations.last().unwrap()["op"], json!("set_page_setup"));
        assert!(notes.is_empty());
    }

    #[test]
    fn a_workbook_without_a_sheet_is_refused() {
        let refused = build_xlsx_from_sheets(&Unlaned, &Registry::new(), &json!({ "sheets": [], "notes": [] }), &BTreeMap::new(), "").unwrap_err();
        assert_eq!(refused, "The HTML holds no <section data-sheet=\"이름\">; every worksheet is one section with its sheet name.");
    }

    #[test]
    fn a_chart_without_a_range_keeps_its_data_in_the_hidden_sheet() {
        let mut chart_sheet = sheet("A", vec![text("t", rect(0.0, 0.0, 100.0, 20.0), json!({}))]);
        chart_sheet["charts"] =
            json!([{ "rect": rect(0.0, 30.0, 300.0, 200.0), "title": "처리량", "spec": { "type": "bar", "labels": ["x", "y"], "values": [1, "2"] } }]);
        let mut notes = Vec::new();
        let operations = xlsx_operations_from_sheets(&[chart_sheet], &BTreeMap::new(), &mut notes);
        let data = operations.iter().find(|op| op["sheet"] == json!(CHART_DATA_SHEET) && op["op"] == json!("set_range")).expect("the data block");
        assert_eq!(data["range"], json!("A1:B3"));
        assert_eq!(data["values"], json!([["", "처리량"], ["x", 1], ["y", 2]]));
        let chart = operations.iter().find(|op| op["op"] == json!("add_chart")).expect("the chart");
        assert_eq!(chart["range"], json!("'차트 데이터'!A1:B3"));
        assert_eq!(operations.last().unwrap(), &json!({ "op": "set_sheet_visibility", "sheet": CHART_DATA_SHEET, "visible": false }));
    }
}
