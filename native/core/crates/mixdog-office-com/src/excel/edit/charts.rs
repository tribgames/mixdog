//! Charts: `Office-ChartTypeCode`, `Excel-ChartSourceRange`, `Set-ChartTitleFace`, `Ink-OnFill`, `Set-ChartCategoryLabelsLow` and
//! `add_chart` in full. Each step that Excel may answer busy goes through `Invoke-ExcelComRetry` as the script does.

use std::sync::OnceLock;

use regex::Regex;

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::com::retry;
use crate::excel::cells::attempt;
use crate::excel::cells::count_of;
use crate::excel::cells::double_of;
use crate::excel::cells::get_with;
use crate::excel::cells::int_of;
use crate::excel::cells::ps_of;
use crate::office::Env;
use crate::ppt::ink::ink_luminance;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::pipeline_items;
use crate::ps::text;

use super::cached;
use super::com_text;
use super::equals_bool;
use super::flag;
use super::int_cast;
use super::int_of_com;
use super::is_blank;
use super::is_match;
use super::present;
use super::prop;
use super::quiet;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::sheets::sheet_named;
use super::single_cast;
use super::string_of_com;
use super::text_of;
use super::print::set_one_page_wide;

/// The chart kinds the portable writer draws, by the XlChartType Excel and PowerPoint take, in the order the refusal lists them.
const CHART_CODES: [(&str, i32); 9] = [
    ("column", 51),
    ("bar", 57),
    ("stacked_column", 52),
    ("stacked_bar", 58),
    ("line", 4),
    ("area", 1),
    ("pie", 5),
    ("doughnut", -4120),
    ("scatter", -4169),
];

/// `Office-ChartTypeCode`: an unknown name is refused as the portable writer refuses it (falling back to a clustered column
/// drew "stacked_column" as side-by-side bars).
pub(crate) fn chart_type_code(chart_type: &Value) -> Result<i32> {
    let given = convert::to_ps_string(chart_type);
    if chart_type.is_null() || is_blank(&given) {
        return Ok(51);
    }
    if matches!(chart_type, Value::Int(_) | Value::Long(_) | Value::Double(_)) {
        return int_cast(chart_type);
    }
    let lowered = text::to_lower_invariant(given.trim());
    let mut kind = text::replace(&lowered, r"[\s-]+", "_", false).map_err(Error::host)?;
    if kind == "donut" {
        kind = "doughnut".to_owned();
    }
    if let Some((_, code)) = CHART_CODES.iter().find(|(name, _)| *name == kind) {
        return Ok(*code);
    }
    if let Some(number) = convert::try_parse_int(&kind) {
        return Ok(number);
    }
    let known: Vec<&str> = CHART_CODES.iter().map(|(name, _)| *name).collect();
    Err(Error::host(format!("Unknown chart type: {given}; use one of {}", known.join(", "))))
}

fn source_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    cached(&PATTERN, r"\s*(?:(?:'((?:[^']|'')+)'|([^',!]+))!([^,]+)|([^,]+))")
}

/// `Excel-ChartSourceRange`: a chart source read as the portable writer reads it: comma-joined areas, each optionally naming the
/// sheet it stands on (`'month'!A1:A7,'month'!D1:D7`), one sheet for all, which the contract has already checked.
/// `Worksheet.Range` refuses another sheet's address, so the areas are read from the sheet they name.
fn chart_source_range(book: &Com, sheet: &Com, range: &str) -> Result<Com> {
    let mut source = sheet.clone();
    let mut areas: Vec<String> = Vec::new();
    for found in source_pattern().captures_iter(range) {
        if let Some(area) = found.get(3) {
            let name = match found.get(1) {
                Some(quoted) => quoted.as_str().replace("''", "'"),
                None => found.get(2).map_or_else(String::new, |plain| plain.as_str().trim().to_owned()),
            };
            source = sheet_named(book, &name)?;
            areas.push(area.as_str().trim().to_owned());
        } else {
            areas.push(found.get(4).map_or_else(String::new, |area| area.as_str().trim().to_owned()));
        }
    }
    range_of(&source, &areas.join(","))
}

/// `Color-Value` as an Int32 argument.
fn color_of(hex: &str) -> Result<Com> {
    convert::color_value(hex).map(Com::I4).map_err(Error::host)
}

/// `Set-ChartTitleFace`: a chart title set as the portable writer sets it: bold, in the near-black ink, at its size (0 keeps the
/// application's own). Office's default was a regular grey title.
pub(crate) fn set_chart_title_face(chart: &Com, size: f32) {
    quiet(|| {
        let font = chart.member("ChartTitle")?.member("Format")?.member("TextFrame2")?.member("TextRange")?.member("Font")?;
        font.set_member("Bold", Com::I4(-1))?;
        font.member("Fill")?.member("ForeColor")?.set_member("RGB", color_of("171717")?)?;
        if size > 0.0 {
            font.set_member("Size", Com::R4(size))?;
        }
        Ok(())
    });
}

/// `Ink-OnFill`: the ink a shape's fill can carry, as the portable writer chooses it: white on a dark fill, near-black on a light
/// one or on none.
pub(crate) fn ink_on_fill(fill: &str) -> Result<String> {
    let hex = fill.trim().trim_start_matches('#').to_owned();
    if !is_match(&hex, "^[0-9A-Fa-f]{6}$")? {
        return Ok("1F2429".to_owned());
    }
    let field = ink_luminance(&hex).map_err(Error::host)?;
    let white = 1.05 / (field + 0.05);
    let dark = ink_luminance("1F2429").map_err(Error::host)?;
    let ink = (field.max(dark) + 0.05) / (field.min(dark) + 0.05);
    Ok(if white >= ink { "FFFFFF".to_owned() } else { "1F2429".to_owned() })
}

/// `[double]::TryParse([string]$value, [ref]$number)` and the number is below zero.
fn is_negative_number(value: &Com) -> bool {
    let number = match value {
        Com::Str(text) => {
            let cleaned = text.trim().replace(',', "");
            if cleaned.is_empty() { None } else { cleaned.parse::<f64>().ok() }
        }
        Com::I1(_) | Com::I2(_) | Com::I4(_) | Com::I8(_) | Com::UI1(_) | Com::UI2(_) | Com::UI4(_) | Com::UI8(_) => value.as_f64(),
        Com::R4(_) | Com::R8(_) | Com::Currency(_) | Com::Decimal(_) => value.as_f64(),
        _ => None,
    };
    number.is_some_and(|number| number < 0.0)
}

/// `Set-ChartCategoryLabelsLow`: with a series below zero the category names stand at the foot of the plot, as the portable writer
/// places them, not on the zero line, where a loss bar's value label and its category name ran over each other.
fn set_category_labels_low(chart: &Com, plotted: &[Com]) {
    if plotted.iter().any(is_negative_number) {
        quiet(|| chart.call_member("Axes", &[Com::I4(1), Com::I4(1)]).and_then(|axis| axis.set_member("TickLabelPosition", Com::I4(-4134))));
    }
}

/// `@($value)` of a COM answer: the elements of an array, or the one value.
fn elements_of(value: &Com) -> Vec<Com> {
    match value {
        Com::Array(array) => array.data().to_vec(),
        other => vec![other.clone()],
    }
}

/// `$chart.SeriesCollection().Item($index)`.
fn series_item(chart: &Com, index: i32) -> Result<Com> {
    get_with(&chart.call_member("SeriesCollection", &[])?, "Item", &[Com::I4(index)])
}

/// `try { [int]$series.Points().Count } catch { 0 }`.
fn point_count(series: &Com) -> i32 {
    attempt(|| int_of(&series.call_member("Points", &[])?.member("Count")?)).unwrap_or(0)
}

/// `$series.Points($index)` filled solid with `color`: `Format.Fill.Solid()` then `Format.Fill.ForeColor.RGB`.
fn fill_point(point: &Com, color: &Com) -> Result<()> {
    point.member("Format")?.member("Fill")?.call_member("Solid", &[])?;
    point.member("Format")?.member("Fill")?.member("ForeColor")?.set_member("RGB", color.clone())
}

/// What the position of a data label means.
fn label_position(name: &str) -> i32 {
    match text::to_lower_invariant(name).as_str() {
        "center" => -4108,
        "inside_base" => 4,
        "inside_end" => 3,
        "outside_end" => 2,
        _ => 5,
    }
}

/// `add_chart`.
pub(super) fn add_chart(env: &Env<'_>, book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let chart_type = chart_type_code(&prop(op, "chartType"))?;
    let frame_anchor = if flag(op, "cell") { Some(range_of(&sheet, &text_of(op, "cell"))?) } else { None };
    let anchored = |name: &str, member: &str, fallback: f32| -> Result<f32> {
        if present(op, name) {
            single_cast(&prop(op, name))
        } else if let Some(anchor) = &frame_anchor {
            single_cast(&ps_of(&anchor.member(member)?))
        } else {
            Ok(fallback)
        }
    };
    let left = anchored("left", "Left", 300.0)?;
    let top = anchored("top", "Top", 20.0)?;
    let mut width = if flag(op, "width") { single_cast(&prop(op, "width"))? } else { 480.0 };
    if flag(op, "toColumn") {
        // To the right edge of toColumn as this workbook lays its columns out, as the portable writer measures its own: a Korean
        // Excel's column is an eighth wider than the points a caller could have given.
        let Some(anchor) = &frame_anchor else {
            return Err(Error::host("XLSX add_chart toColumn ends a frame placed at cell; give cell as well"));
        };
        let end = range_of(&sheet, &format!("{}1", text_of(op, "toColumn").trim()))?;
        if int_of_com(&end.member("Column")?)? < int_of_com(&anchor.member("Column")?)? {
            return Err(Error::host(format!("XLSX add_chart toColumn {} lies left of {}", text_of(op, "toColumn"), text_of(op, "cell"))));
        }
        let span = double_of(&end.member("Left")?)? + double_of(&end.member("Width")?)? - double_of(&anchor.member("Left")?)?;
        width = span as f32;
    }
    let height = if flag(op, "height") { single_cast(&prop(op, "height"))? } else { 280.0 };
    let shape = retry::excel(env, "Excel add chart", &[], || {
        sheet.member("Shapes")?.call_member(
            "AddChart2",
            &[Com::I4(-1), Com::I4(chart_type), Com::R4(left), Com::R4(top), Com::R4(width), Com::R4(height)],
        )
    })?;
    let page_fit = set_one_page_wide(&sheet);
    let chart = retry::excel(env, "Excel chart proxy", &[], || shape.member("Chart"))?;
    if flag(op, "range") {
        set_source(env, book, op, &sheet, &chart)?;
    }
    // Every text in the chart in the sheet's face, where Excel otherwise sets the workbook default. Set before the title's face:
    // the chart area's font, set after it, put the title back in Excel's regular grey.
    if flag(op, "fontName") {
        quiet(|| {
            let font = chart.member("ChartArea")?.member("Format")?.member("TextFrame2")?.member("TextRange")?.member("Font")?;
            font.set_member("Name", com_text(text_of(op, "fontName")))?;
            font.set_member("NameFarEast", com_text(text_of(op, "fontName")))
        });
    }
    if flag(op, "title") {
        retry::excel(env, "Excel chart title", &[], || {
            chart.set_member("HasTitle", Com::Bool(true))?;
            chart.member("ChartTitle")?.set_member("Text", com_text(text_of(op, "title")))?;
            Ok(true)
        })?;
        set_chart_title_face(&chart, 12.0);
    }
    // A chart given no title carries none, as in the portable file; Excel otherwise writes its own "Chart Title".
    if !flag(op, "title") {
        quiet(|| chart.set_member("HasTitle", Com::Bool(false)));
    }
    // Horizontal bars read top-down in the range's order, as the portable writer draws them: the category axis runs reversed and
    // the value axis crosses it at the far end, so it stays under the bars.
    if chart_type == 57 || chart_type == 58 {
        quiet(|| {
            let axis = chart.call_member("Axes", &[Com::I4(1)])?;
            axis.set_member("ReversePlotOrder", Com::Bool(true))?;
            axis.set_member("Crosses", Com::I4(2))
        });
    }
    let series_count = int_of_com(&retry::excel(env, "Excel chart series", &[], || chart.call_member("SeriesCollection", &[])?.member("Count"))?)?;
    let palette: Vec<String> = pipeline_items(&prop(op, "seriesColors"))
        .iter()
        .filter(|color| !color.is_null() && !is_blank(&convert::to_ps_string(color)))
        .map(convert::to_ps_string)
        .collect();
    // A pie or doughnut is its categories: each slice takes the next colour of the palette, as the portable writer cycles them.
    let slices = chart_type == 5 || chart_type == -4120;
    for series_index in 1..=series_count {
        style_series(op, &chart, series_index, &palette, slices)?;
    }
    // A pie's legend names its slices, as the portable writer keeps it; otherwise one series goes unlabelled.
    let legend_visible = if present(op, "showLegend") { flag(op, "showLegend") } else { series_count > 1 || slices };
    retry::excel(env, "Excel chart legend", &[], || {
        chart.set_member("HasLegend", Com::Bool(legend_visible))?;
        // Under the plot, in series order, as the portable writer places it: Excel's default right-hand legend took a fifth of the
        // frame's width and listed a stacked chart's series upside down.
        if legend_visible {
            chart.member("Legend")?.set_member("Position", Com::I4(-4107))?;
        }
        Ok(true)
    })?;
    quiet(|| chart.member("ChartArea")?.member("Format")?.member("Line")?.set_member("Visible", Com::I4(0)));
    quiet(|| chart.member("PlotArea")?.member("Format")?.member("Fill")?.set_member("Visible", Com::I4(0)));
    quiet(|| {
        let axis = chart.call_member("Axes", &[Com::I4(1), Com::I4(1)])?;
        axis.set_member("CategoryType", Com::I4(2))?;
        axis.set_member("TickLabelPosition", Com::I4(4))?;
        axis.member("TickLabels")?.set_member("Orientation", Com::I4(0))
    });
    let mut plotted: Vec<Com> = Vec::new();
    for index in 1..=series_count {
        if let Some(values) = attempt(|| Ok(elements_of(&series_item(&chart, index)?.member("Values")?))) {
            plotted.extend(values);
        }
    }
    set_category_labels_low(&chart, &plotted);
    quiet(|| {
        let axis = chart.call_member("Axes", &[Com::I4(2), Com::I4(1)])?;
        if flag(op, "zeroBaseline") {
            axis.set_member("MinimumScale", Com::I4(0))?;
        }
        if flag(op, "valueNumberFormat") {
            axis.member("TickLabels")?.set_member("NumberFormat", com_text(text_of(op, "valueNumberFormat")))?;
        }
        Ok(())
    });
    quiet(|| chart.call_member("ChartGroups", &[Com::I4(1)])?.set_member("GapWidth", Com::I4(90)));
    if flag(op, "showValues") && text::to_lower_invariant(&text_of(op, "dataLabelPosition")) == "inside_end" {
        quiet(|| {
            let current = single_cast(&ps_of(&chart.member("PlotArea")?.member("InsideWidth")?))?;
            if current > 100.0 {
                chart.member("PlotArea")?.set_member("InsideWidth", Com::R4((f64::from(current) - 18.0) as f32))?;
            }
            Ok(())
        });
    }
    let points = if series_count > 0 {
        let counted = retry::excel(env, "Excel chart point count", &[-2_146_827_864], || {
            series_item(&chart, 1)?.call_member("Points", &[])?.member("Count")
        })?;
        int_of_com(&counted)?
    } else {
        0
    };
    // The quiet plot and the one lit bar, as the portable writer draws them: gridlines:false, valueAxis:false, highlight (a 0-based
    // index or a category's text) in the series colour with the rest in mutedColor.
    if equals_bool(&prop(op, "gridlines"), false) {
        quiet(|| chart.call_member("Axes", &[Com::I4(2), Com::I4(1)])?.set_member("HasMajorGridlines", Com::Bool(false)));
    }
    if equals_bool(&prop(op, "valueAxis"), false) {
        quiet(|| chart.call_member("Axes", &[Com::I4(2), Com::I4(1)])?.call_member("Delete", &[]));
    }
    if present(op, "highlight") && !text_of(op, "highlight").is_empty() && series_count == 1 && !slices {
        highlight_point(op, &chart, &palette, points)?;
    }
    let mut more = vec![
        ("name", Value::String(string_of_com(&shape.member("Name")?))),
        ("series", Value::Int(series_count)),
        ("categories", Value::Int(points)),
    ];
    if let Some(fit) = page_fit {
        more.push(("pageFit", Value::string(fit)));
    }
    Ok(record_of("add_chart", true, more))
}

/// The source of the chart. `plotBy: 'rows'` (xlRows = 1) is as the portable writer reads it: the first row the categories, each
/// row under it a series. Always passing xlColumns drew a row of periods as one bar per year.
fn set_source(env: &Env<'_>, book: &Com, op: &Value, sheet: &Com, chart: &Com) -> Result<()> {
    let by_rows = text::to_lower_invariant(&text_of(op, "plotBy")) == "rows";
    let plot_by = if by_rows { 1 } else { 2 };
    let block = chart_source_range(book, sheet, &text_of(op, "range"))?;
    retry::excel(env, "Excel chart source", &[], || {
        chart.call_member("SetSourceData", &[block.clone(), Com::I4(plot_by)])?;
        Ok(true)
    })?;
    if !by_rows {
        return Ok(());
    }
    // Excel reads a header row of years as numbers and plots it as a series of its own; the series are named explicitly instead:
    // the first row (after its first cell) the categories, each row under it one series named by its first cell.
    retry::excel(env, "Excel chart series by rows", &[], || {
        let rows = int_of_com(&block.member("Rows")?.member("Count")?)?;
        let columns = int_of_com(&block.member("Columns")?.member("Count")?)?;
        while count_of(&chart.call_member("SeriesCollection", &[])?)? > 0 {
            chart.call_member("SeriesCollection", &[Com::I4(1)])?.call_member("Delete", &[])?;
        }
        let first_cell = get_with(&block.member("Cells")?, "Item", &[Com::I4(1), Com::I4(2)])?;
        let categories = get_with(&first_cell, "Resize", &[Com::I4(1), Com::I4(columns - 1)])?;
        for row in 2..=rows {
            let series = chart.call_member("SeriesCollection", &[])?.call_member("NewSeries", &[])?;
            let label = get_with(&block.member("Cells")?, "Item", &[Com::I4(row), Com::I4(1)])?;
            series.set_member("Name", com_text(string_of_com(&label.member("Text")?)))?;
            let first_value = get_with(&block.member("Cells")?, "Item", &[Com::I4(row), Com::I4(2)])?;
            series.set_member("Values", get_with(&first_value, "Resize", &[Com::I4(1), Com::I4(columns - 1)])?)?;
            series.set_member("XValues", categories.clone())?;
        }
        // A rebuilt single series brings Excel's automatic title back with it.
        if !flag(op, "title") {
            chart.set_member("HasTitle", Com::Bool(true))?;
            chart.set_member("HasTitle", Com::Bool(false))?;
        }
        Ok(true)
    })?;
    Ok(())
}

/// One series of the chart: its palette colour (or its slices'), and its data labels.
fn style_series(op: &Value, chart: &Com, series_index: i32, palette: &[String], slices: bool) -> Result<()> {
    let series = series_item(chart, series_index)?;
    let colour_at = |position: i32| -> Result<Com> {
        let at = usize::try_from(position).unwrap_or(0) % palette.len();
        color_of(&palette[at])
    };
    if !palette.is_empty() && slices {
        for point_index in 1..=point_count(&series) {
            let color = colour_at(point_index - 1)?;
            quiet(|| fill_point(&series.call_member("Points", &[Com::I4(point_index)])?, &color));
        }
    } else if !palette.is_empty() {
        let color = colour_at(series_index - 1)?;
        quiet(|| {
            series.member("Format")?.member("Fill")?.call_member("Solid", &[])?;
            series.member("Format")?.member("Fill")?.member("ForeColor")?.set_member("RGB", color.clone())
        });
        quiet(|| series.member("Format")?.member("Line")?.member("ForeColor")?.set_member("RGB", color.clone()));
    }
    if !flag(op, "showValues") {
        return Ok(());
    }
    quiet(|| {
        series.call_member("ApplyDataLabels", &[])?;
        let labels = series.call_member("DataLabels", &[])?;
        labels.set_member("ShowValue", Com::Bool(true))?;
        labels.set_member("ShowCategoryName", Com::Bool(false))?;
        if flag(op, "valueNumberFormat") {
            labels.set_member("NumberFormat", com_text(text_of(op, "valueNumberFormat")))?;
        }
        if flag(op, "dataLabelPosition") {
            labels.set_member("Position", Com::I4(label_position(&text_of(op, "dataLabelPosition"))))?;
        }
        if flag(op, "dataLabelColor") {
            let color = color_of(&text_of(op, "dataLabelColor"))?;
            labels.member("Font")?.set_member("Color", color)?;
        }
        Ok(())
    });
    // Each slice's value in the ink its slice can carry, as the portable writer sets it.
    let position = text::to_lower_invariant(&text_of(op, "dataLabelPosition"));
    let inside_labels = !flag(op, "dataLabelPosition") || ["center", "inside_end", "inside_base"].contains(&position.as_str());
    if slices && inside_labels && !flag(op, "dataLabelColor") && !palette.is_empty() {
        for point_index in 1..=point_count(&series) {
            let at = usize::try_from(point_index - 1).unwrap_or(0) % palette.len();
            let ink = color_of(&ink_on_fill(&palette[at])?)?;
            quiet(|| {
                series
                    .call_member("Points", &[Com::I4(point_index)])?
                    .member("DataLabel")?
                    .member("Font")?
                    .set_member("Color", ink.clone())
            });
        }
    }
    Ok(())
}

/// `highlight`: the one lit bar in the series colour, the rest in `mutedColor`.
fn highlight_point(op: &Value, chart: &Com, palette: &[String], points: i32) -> Result<()> {
    let series = series_item(chart, 1)?;
    let highlight = prop(op, "highlight");
    let lit = if matches!(
        highlight,
        Value::Bool(_) | Value::Int(_) | Value::Long(_) | Value::Double(_) | Value::Single(_) | Value::Decimal(_) | Value::DateTime(_)
    ) {
        int_cast(&highlight)?
    } else {
        let names: Vec<String> = elements_of(&series.member("XValues")?).iter().map(string_of_com).collect();
        let wanted = text_of(op, "highlight");
        names.iter().position(|name| *name == wanted).map_or(-1, |at| i32::try_from(at).unwrap_or(i32::MAX))
    };
    if lit < 0 || lit >= points {
        return Ok(());
    }
    let accent = color_of(palette.first().map_or("2F6DB5", String::as_str))?;
    let muted = if flag(op, "mutedColor") { color_of(&text_of(op, "mutedColor"))? } else { color_of("C9CED6")? };
    for point_index in 1..=points {
        quiet(|| {
            let point = series.call_member("Points", &[Com::I4(point_index)])?;
            let color = if point_index == lit + 1 { accent.clone() } else { muted.clone() };
            fill_point(&point, &color)?;
            // The series' outline was set in the accent; a receded bar keeps no accent edge.
            point.member("Format")?.member("Line")?.member("ForeColor")?.set_member("RGB", color)
        });
    }
    Ok(())
}
