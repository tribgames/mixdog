//! A bar chart the page draws itself, in the document's face and accent: categories and one series of values, each
//! value labelled at its bar and the axis left quiet (no grid; the labels carry the numbers). `chartType: "bar"` lays the
//! bars across, a ranking whose names read on the left; `"column"` stands them up, periods from left to right.
//! `highlight` (an index or a category) takes the accent and the other bars recede, so the page says which bar it is
//! about. `forecast` (an index, a category, or a list of them) draws those bars as projections: a pale fill inside a
//! dashed outline, their values muted.

use std::collections::BTreeSet;

use mixdog_fsio::WriteProof;
use mixdog_js::math::{max, min};
use mixdog_js::{js_to_lowercase, json_number, value_to_string};
use mixdog_pdf::author::draw::parse_color;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::PdfDocument;
use serde_json::{Map, Value};

use super::blocks::{assert_pdf_blocks, block_text, block_type, forecast_entries, forecast_index, is_truthy, items_of, num_nn, num_or, text_of, text_or};
use super::layout::{Flow, LineOpts, TextBox, caption_height, draw_lines, lines_height, wrap};
use super::{Face, RectStyle, WriterError, WriterResult, chart_faces, file_error, save_document};

/// `value.toLocaleString('en-US', { maximumFractionDigits: 2 })`: ICU writes the shortest decimal that reads back as the
/// number, rounds it half away from zero to two fraction digits, groups the integer part by thousands and shows the sign
/// of a negative number that rounds to zero.
fn en_us_number(value: f64) -> String {
    const MAX_FRACTION: usize = 2;
    if value.is_nan() {
        return "NaN".into();
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if value.is_infinite() {
        return format!("{sign}\u{221e}");
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
    if fraction.len() > MAX_FRACTION {
        let round_up = fraction.as_bytes()[MAX_FRACTION] >= b'5';
        fraction.truncate(MAX_FRACTION);
        if round_up {
            let mut all: Vec<u8> = whole.bytes().chain(fraction.bytes()).collect();
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
            let split = all.len() - fraction.len();
            whole = String::from_utf8_lossy(&all[..split]).into_owned();
            fraction = String::from_utf8_lossy(&all[split..]).into_owned();
        }
    }
    while fraction.ends_with('0') {
        fraction.pop();
    }
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if fraction.is_empty() { format!("{sign}{grouped}") } else { format!("{sign}{grouped}.{fraction}") }
}

/// What the bars are measured to: shared by the two directions.
struct ChartLayout {
    size: f64,
    values: Vec<f64>,
    labels: Vec<String>,
    title_size: f64,
    title_height: f64,
    highlight: f64,
    forecast: BTreeSet<i64>,
    across: bool,
    names: Vec<Vec<String>>,
    height: f64,
    /// Bars across: the names column, the values column and each row's height.
    label_width: f64,
    value_width: f64,
    rows: Vec<f64>,
    /// Bars upright: the plot's height and each column's width.
    plot_height: f64,
    column_width: f64,
}

fn chart_layout(font: &Face, bold: &Face, block: &Value, text_box: TextBox) -> WriterResult<ChartLayout> {
    let size = num_or(block.get("size"), 9.5);
    let categories: Vec<String> = items_of(block.get("categories")).iter().map(|category| text_of(Some(category))).collect();
    let values: Vec<f64> = items_of(block.get("values")).iter().map(mixdog_js::to_number).collect();
    let unit = text_of(block.get("unit"));
    let labels: Vec<String> = values.iter().map(|value| format!("{}{unit}", en_us_number(*value))).collect();
    let across = js_to_lowercase(&text_or(block.get("chartType"), "bar")) != "column";
    let title_size = size + 1.0;
    let title_height =
        if is_truthy(block.get("title")) { lines_height(bold, &text_of(block.get("title")), title_size, text_box.width, title_size * 1.3)? + 6.0 } else { 0.0 };
    let highlight = match block.get("highlight") {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(other) => categories.iter().position(|category| *category == value_to_string(other)).map_or(-1.0, |at| at as f64),
        None => -1.0,
    };
    let category_values = items_of(block.get("categories"));
    let forecast: BTreeSet<i64> = forecast_entries(block).into_iter().map(|entry| forecast_index(category_values, entry)).collect();
    let mut layout = ChartLayout {
        size,
        values,
        labels,
        title_size,
        title_height,
        highlight,
        forecast,
        across,
        names: Vec::new(),
        height: 0.0,
        label_width: 0.0,
        value_width: 0.0,
        rows: Vec::new(),
        plot_height: 0.0,
        column_width: 0.0,
    };
    if across {
        measure_bars_across(font, bold, &categories, text_box, &mut layout)?;
    } else {
        measure_bars_upright(font, block, &categories, text_box, &mut layout)?;
    }
    Ok(layout)
}

/// The names column is as wide as its longest name, a third of the width at most, where a longer name wraps.
fn measure_bars_across(font: &Face, bold: &Face, categories: &[String], text_box: TextBox, layout: &mut ChartLayout) -> WriterResult<()> {
    let size = layout.size;
    let mut widest_name = f64::NEG_INFINITY;
    for name in categories {
        widest_name = max(widest_name, font.width(name, size)?);
    }
    layout.label_width = min(text_box.width / 3.0, widest_name + 10.0);
    let mut widest_value = f64::NEG_INFINITY;
    for label in &layout.labels {
        widest_value = max(widest_value, bold.width(label, size)?);
    }
    layout.value_width = widest_value + 8.0;
    for name in categories {
        layout.names.push(wrap(font, name, size, max(8.0, layout.label_width - 10.0))?);
    }
    layout.rows = layout.names.iter().map(|lines| max(size * 2.4, lines.len() as f64 * size * 1.25 + 8.0)).collect();
    layout.height = layout.title_height + layout.rows.iter().sum::<f64>();
    Ok(())
}

fn measure_bars_upright(font: &Face, block: &Value, categories: &[String], text_box: TextBox, layout: &mut ChartLayout) -> WriterResult<()> {
    let size = layout.size;
    layout.plot_height = num_or(block.get("height"), 150.0);
    layout.column_width = text_box.width / max(1.0, layout.values.len() as f64);
    for name in categories {
        layout.names.push(wrap(font, name, size, max(8.0, layout.column_width - 6.0))?);
    }
    let tallest = layout.names.iter().map(Vec::len).max().unwrap_or(0).max(1) as f64;
    layout.height = layout.title_height + size * 1.6 + layout.plot_height + 6.0 + tallest * size * 1.3;
    Ok(())
}

/// The chart and the caption under it, measured as one unit: a caption alone atop the next page cites nothing.
pub fn chart_unit_height(flow: &Flow, block: &Value, following: Option<&Value>) -> WriterResult<f64> {
    if block_type(block) != "chart" {
        return Ok(0.0);
    }
    let text_box = flow.text_box(block);
    let trailing = caption_height(following, &flow.font, text_box.width)?;
    let height = chart_layout(&flow.font, &flow.bold, block, text_box)?.height;
    Ok(height + if trailing != 0.0 { num_nn(block.get("after"), 10.0) + trailing } else { 0.0 })
}

/// How a bar is inked: the highlight takes the accent and the others recede, a projected bar keeps its colour at a third
/// of its strength inside a dashed outline, and its value reads muted.
struct BarInk<'a> {
    accent: [f64; 3],
    line: [f64; 3],
    muted: [f64; 3],
    dark: [f64; 3],
    highlight: f64,
    forecast: &'a BTreeSet<i64>,
}

impl BarInk<'_> {
    fn lit(&self, index: usize) -> bool {
        self.highlight < 0.0 || index as f64 == self.highlight
    }

    fn projected(&self, index: usize) -> bool {
        self.forecast.contains(&(index as i64))
    }

    fn bar(&self, index: usize, style: RectStyle) -> RectStyle {
        let fill = if self.lit(index) { self.accent } else { self.line };
        if !self.projected(index) {
            return RectStyle { color: Some(fill), ..style };
        }
        let outline = if self.lit(index) && self.highlight >= 0.0 { self.accent } else { self.muted };
        RectStyle { color: Some(fill), opacity: Some(0.35), border_color: Some(outline), border_width: 0.8, dash: Some([2.4, 1.6]), ..style }
    }

    fn label_ink(&self, index: usize) -> [f64; 3] {
        if self.lit(index) && !self.projected(index) { self.dark } else { self.muted }
    }

    fn strong(&self, index: usize) -> bool {
        self.lit(index) && self.highlight >= 0.0
    }
}

pub fn draw_chart_block(flow: &mut Flow, block: &Value, following: Option<&Value>) -> WriterResult<()> {
    let text_box = flow.text_box(block);
    let layout = chart_layout(&flow.font, &flow.bold, block, text_box)?;
    let unit = chart_unit_height(flow, block, following)?;
    flow.keep_together(unit)?;
    let ink = BarInk {
        accent: parse_color(&text_or(block.get("accent"), &flow.ink.accent))?,
        line: parse_color(&flow.ink.line)?,
        muted: parse_color(&flow.ink.muted)?,
        dark: parse_color("1F2937")?,
        highlight: layout.highlight,
        forecast: &layout.forecast,
    };
    if is_truthy(block.get("title")) {
        let mut opts = LineOpts::new(layout.title_size * 1.3, "1F2937");
        opts.face = Some(flow.bold.clone());
        draw_lines(flow, text_box, &text_of(block.get("title")), layout.title_size, &opts)?;
        flow.y -= 6.0;
    }
    let peak = layout.values.iter().copied().fold(0.0, max);
    let scale = if peak == 0.0 || peak.is_nan() { 1.0 } else { peak };
    if layout.across {
        draw_bars_across(flow, &layout, text_box, &ink, scale)?;
    } else {
        draw_bars_upright(flow, &layout, text_box, &ink, scale)?;
    }
    flow.y -= num_nn(block.get("after"), 10.0);
    Ok(())
}

fn draw_bars_across(flow: &mut Flow, layout: &ChartLayout, text_box: TextBox, ink: &BarInk, scale: f64) -> WriterResult<()> {
    let (font, bold) = (flow.font.clone(), flow.bold.clone());
    let size = layout.size;
    let track = max(40.0, text_box.width - layout.label_width - layout.value_width);
    let left = text_box.left + layout.label_width;
    let top = flow.y;
    for (index, value) in layout.values.iter().enumerate() {
        let row_height = layout.rows[index];
        let mid = flow.y - row_height / 2.0;
        let lines = &layout.names[index];
        // The name stands against the bars, its lines centred on the bar.
        for (line_index, line) in lines.iter().enumerate() {
            let y = mid + ((lines.len() as f64 - 1.0) / 2.0 - line_index as f64) * size * 1.25 - size * 0.35;
            flow.page().draw_text(line, left - 10.0 - font.width(line, size)?, y, size, &font, ink.dark)?;
        }
        let width = (value / scale) * track;
        let bar_height = min(row_height - 6.0, size * 1.5);
        if width > 0.0 {
            flow.page().draw_rectangle(&ink.bar(index, RectStyle { x: left, y: mid - bar_height / 2.0, width, height: bar_height, ..RectStyle::default() }));
        }
        let face = if ink.strong(index) { &bold } else { &font };
        flow.page().draw_text(&layout.labels[index], left + width + 4.0, mid - size * 0.35, size, face, ink.label_ink(index))?;
        flow.y -= row_height;
    }
    let bottom = flow.y;
    flow.page().draw_line([left, top], [left, bottom], 0.6, ink.line);
    Ok(())
}

fn draw_bars_upright(flow: &mut Flow, layout: &ChartLayout, text_box: TextBox, ink: &BarInk, scale: f64) -> WriterResult<()> {
    let (font, bold) = (flow.font.clone(), flow.bold.clone());
    let size = layout.size;
    let baseline = flow.y - size * 1.6 - layout.plot_height;
    for (index, value) in layout.values.iter().enumerate() {
        let x = text_box.left + index as f64 * layout.column_width;
        let bar_width = min(layout.column_width * 0.56, 64.0);
        let height = (value / scale) * layout.plot_height;
        if height > 0.0 {
            flow.page().draw_rectangle(
                &ink.bar(index, RectStyle { x: x + (layout.column_width - bar_width) / 2.0, y: baseline, width: bar_width, height, ..RectStyle::default() }),
            );
        }
        let face = if ink.strong(index) { &bold } else { &font };
        let label = &layout.labels[index];
        flow.page().draw_text(label, x + (layout.column_width - face.width(label, size)?) / 2.0, baseline + height + 4.0, size, face, ink.label_ink(index))?;
        for (line_index, line) in layout.names[index].iter().enumerate() {
            let line_y = baseline - 6.0 - size - line_index as f64 * size * 1.3;
            flow.page().draw_text(line, x + (layout.column_width - font.width(line, size)?) / 2.0, line_y, size, &font, ink.dark)?;
        }
    }
    flow.page().draw_line([text_box.left, baseline], [text_box.left + text_box.width, baseline], 0.6, ink.line);
    flow.y -= layout.height - layout.title_height;
    Ok(())
}
/// `createChartPdf(path, block, { width, palette })`: one chart block on a page of its own size (`width` points wide
/// besides its padding, as tall as the chart), for a document that places the chart as a picture (a Word report): the
/// same drawing the PDF chart block makes, cut to the chart. The result is `{ path, width, height }`.
pub fn create_chart_pdf<P: WriteProof>(proof: &P, env: &FontEnv, path: &str, block: &Value, width: f64, palette: Option<&Value>) -> WriterResult<Value> {
    let mut chart: Map<String, Value> = block.as_object().cloned().unwrap_or_default();
    chart.insert("type".into(), Value::String("chart".into()));
    chart.insert("x".into(), json_number(0.0));
    chart.insert("width".into(), json_number(width));
    chart.insert("before".into(), json_number(0.0));
    chart.insert("after".into(), json_number(0.0));
    let chart = Value::Object(chart);
    assert_pdf_blocks(std::slice::from_ref(&chart))?;
    let mut document = PdfDocument::create();
    let (font, bold) = chart_faces(proof, env, &mut document, &block_text(&chart))?;
    let pad = 4.0;
    let height = chart_layout(&font, &bold, &chart, TextBox { left: 0.0, width })?.height;
    let size = [width + pad * 2.0, height + pad * 2.0];
    let mut flow = Flow::new(document, size, pad, font, bold, Some(&Value::String("FFFFFF".into())), palette)?;
    let mut placed = chart.as_object().cloned().ok_or_else(|| WriterError::new("a chart block is an object"))?;
    placed.insert("x".into(), json_number(pad));
    draw_chart_block(&mut flow, &Value::Object(placed), None)?;
    let bytes = save_document(&mut flow.document, &flow.pages, &[&*flow.font, &*flow.bold])?;
    mixdog_fsio::write(proof, path, bytes).map_err(file_error)?;
    let mut result = Map::new();
    result.insert("path".into(), Value::String(path.to_owned()));
    result.insert("width".into(), json_number(size[0]));
    result.insert("height".into(), json_number(size[1]));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_pdf::Ref;
    use mixdog_pdf::embed::{Font, StandardFontName};
    use serde_json::json;

    fn helvetica(key: &str, name: StandardFontName, number: i64) -> Face {
        Face { font: Font::standard(name), key: key.to_owned(), reference: Ref::new(number, 0) }
    }

    #[test]
    fn figures_are_written_the_way_en_us_locale_does() {
        assert_eq!(en_us_number(1234567.0), "1,234,567");
        assert_eq!(en_us_number(0.125), "0.13");
        assert_eq!(en_us_number(2.675), "2.68");
        assert_eq!(en_us_number(1000.5), "1,000.5");
        assert_eq!(en_us_number(0.0), "0");
        assert_eq!(en_us_number(999.999), "1,000");
        assert_eq!(en_us_number(0.004), "0");
        assert_eq!(en_us_number(12.0), "12");
    }

    #[test]
    fn bars_across_take_a_row_each_and_upright_bars_a_plot() {
        let (font, bold) = (helvetica("F1", StandardFontName::Helvetica, 1), helvetica("F2", StandardFontName::HelveticaBold, 2));
        let across = json!({ "type": "chart", "categories": ["North", "East"], "values": [10, 20], "title": "Sales", "unit": "k" });
        let layout = chart_layout(&font, &bold, &across, TextBox { left: 54.0, width: 487.0 }).unwrap();
        assert!(layout.across);
        assert_eq!(layout.labels, ["10k", "20k"]);
        assert_eq!(layout.rows, vec![9.5 * 2.4; 2]);
        assert_eq!(layout.height, layout.title_height + 9.5 * 2.4 * 2.0);
        let upright =
            json!({ "type": "chart", "chartType": "column", "categories": ["Q1", "Q2"], "values": [1, 2], "height": 100, "forecast": "Q2", "highlight": "Q1" });
        let layout = chart_layout(&font, &bold, &upright, TextBox { left: 0.0, width: 200.0 }).unwrap();
        assert!(!layout.across);
        assert_eq!(layout.column_width, 100.0);
        assert_eq!(layout.height, 9.5 * 1.6 + 100.0 + 6.0 + 9.5 * 1.3);
        assert!(layout.forecast.contains(&1));
        assert_eq!(layout.highlight, 0.0);
    }

    fn drawn(block: &Value) -> Flow {
        let (font, bold) = (helvetica("F1", StandardFontName::Helvetica, 1), helvetica("F2", StandardFontName::HelveticaBold, 2));
        let mut flow = Flow::new(PdfDocument::create(), [595.0, 842.0], 54.0, font, bold, None, None).unwrap();
        draw_chart_block(&mut flow, block, None).unwrap();
        flow
    }

    #[test]
    fn bars_across_advance_the_cursor_by_their_rows_and_draw_a_bar_each() {
        let flow = drawn(&json!({ "type": "chart", "categories": ["North", "East"], "values": [10, 20], "unit": "k" }));
        let content = &flow.pages[0].content;
        assert!((flow.y - (842.0 - 54.0 - 9.5 * 2.4 * 2.0 - 10.0)).abs() < 1e-9);
        assert_eq!(content.matches(" re\n").count(), 2);
        assert_eq!(content.matches(" m\n").count(), 1, "the axis rule");
        assert!(!content.contains(" d\n"), "no bar is projected");
    }

    #[test]
    fn upright_bars_project_the_forecast_and_stand_on_one_baseline() {
        let flow = drawn(&json!({
            "type": "chart", "chartType": "column", "categories": ["Q1", "Q2"], "values": [1, 2], "height": 100, "forecast": "Q2", "highlight": "Q1"
        }));
        let content = &flow.pages[0].content;
        assert!((flow.y - (842.0 - 54.0 - (9.5 * 1.6 + 100.0 + 6.0 + 9.5 * 1.3) - 10.0)).abs() < 1e-9);
        assert_eq!(content.matches(" re\n").count(), 2);
        assert_eq!(content.matches("[2.4 1.6] 0 d").count(), 1, "only Q2 is a projection");
        assert!(content.contains("/GS1 gs"));
    }
}
