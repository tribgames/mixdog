//! The data of a slide chart: the embedded workbook, the Excel it starts, and everything the chart operations do around it.
//!
//! The Excel a chart starts for its data is tracked in the session's [`ChartExcel`](crate::state::ChartExcel) so the session's
//! cleanup quits it, and the process ids that were not there before the operation began are its own.

use crate::com::Decimal;
use crate::com::Error;
use crate::com::Result;
use crate::com::SafeArray;
use crate::com::Value as Com;
use crate::com::retry;
use crate::format::EditContext;
use crate::office::Env;
use crate::ppt::long_cast;
use crate::ppt::truth;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::text;

use super::ItemAt;
use super::array_of;
use super::attempt;
use super::boolean;
use super::bstr;
use super::color;
use super::color_text;
use super::count;
use super::i4;
use super::int_value;
use super::pipeline;
use super::present;
use super::prop;
use super::put_path;
use super::r4;
use super::shapes::ink_on_fill;
use super::string_value;
use super::text_of;
use super::truthy;
use super::walk;

/// How many times the embedded workbook is asked for before the chart is given up on, and the pause between asks.
const OPEN_ATTEMPTS: u32 = 100;
const OPEN_PAUSE_MS: u32 = 100;

use crate::excel::cells::column_letters;

/// `Excel-ProcessIds`: the ids of the running Excel processes.
pub(crate) fn excel_process_ids(env: &Env<'_>) -> Vec<i32> {
    env.platform.excel_process_ids()
}

/// `$application.Hwnd` as `[long]`, 0 where it cannot be read.
fn window_handle(application: &Com) -> i64 {
    application.member("Hwnd").and_then(|handle| long_cast(&handle)).unwrap_or(0)
}

pub(crate) fn register_chart_excel_application(
    context: &mut EditContext<'_>,
    workbook: &Com,
    process_ids_before: &[i32],
    require_isolated: bool,
) -> Result<()> {
    let application = workbook.member("Application")?;
    let Some(object) = application.as_obj().cloned() else { return Ok(()) };
    let handle = window_handle(&application);
    let key = if handle != 0 { format!("hwnd:{handle}") } else { object.identity_key() };
    if context.chart_excel.contains_application(&key) {
        return Ok(());
    }
    let process_id = if handle != 0 { context.env.platform.process_id_for_window(handle) } else { 0 };
    let known_owned_process = process_id > 0 && context.chart_excel.knows_process(process_id);
    if process_id > 0 && process_ids_before.contains(&process_id) && !known_owned_process {
        if require_isolated {
            return Err(Error::host("Background PowerPoint chart data refused an embedded workbook that reused an existing user Excel process."));
        }
        return Ok(());
    }
    if process_id > 0 {
        context.chart_excel.add_process(process_id);
    }
    for running in excel_process_ids(&context.env) {
        if !process_ids_before.contains(&running) {
            context.chart_excel.add_process(running);
        }
    }
    context.chart_excel.insert_application(&key, object);
    Ok(())
}

/// A value of the request as a cell of the data block (`object[,]`): text and numbers as they are, `$null` as an empty cell.
pub(crate) fn cell_of(value: &Value) -> Com {
    match value {
        Value::Null | Value::DbNull => Com::Empty,
        Value::Bool(flag) => Com::Bool(*flag),
        Value::Int(number) => Com::I4(*number),
        Value::Long(number) => Com::I8(*number),
        Value::Double(number) => Com::R8(*number),
        Value::Single(number) => Com::R4(*number),
        Value::Decimal(number) => Decimal::parse(&number.to_text()).map_or_else(|| Com::R8(number.to_f64()), Com::Decimal),
        other => Com::Str(convert::to_ps_string(other)),
    }
}

/// The block written to the data sheet: a header row (`Category` and the series names), then one row per point.
fn data_matrix(categories: &[Value], specs: &[Value], point_count: usize) -> Option<SafeArray> {
    let mut rows: Vec<Vec<Com>> = Vec::with_capacity(point_count + 1);
    let mut header = vec![Com::from("Category")];
    header.extend(specs.iter().map(|spec| Com::Str(text_of(&prop(spec, "name")))));
    rows.push(header);
    for point in 1..=point_count {
        let category = match categories.get(point - 1) {
            Some(found) => cell_of(found),
            None => Com::Str(format!("Item {point}")),
        };
        let mut row = vec![category];
        for spec in specs {
            let values = array_of(&prop(spec, "values"));
            row.push(values.get(point - 1).map_or(Com::Empty, cell_of));
        }
        rows.push(row);
    }
    SafeArray::zero_based(rows)
}

/// The embedded workbook, once the chain `Workbook`, `Worksheets`, the first sheet, its cells and the source range answered,
/// the block was written and the chart bound to it.
struct OpenSheet {
    workbook: Com,
}

/// What is written to the chart's data sheet and where.
struct Block<'a> {
    chart: &'a Com,
    chart_data: &'a Com,
    matrix: &'a SafeArray,
    source_address: &'a str,
    last_column: &'a str,
    last_row: usize,
    allow_ui_activation: bool,
    process_ids_before: &'a [i32],
}

/// One try at the embedded workbook: each step that is not ready fails with its text, and the sheet is adopted (and the Excel
/// registered) only after the block was written and the chart bound to it.
fn open_attempt(context: &mut EditContext<'_>, block: &Block<'_>, first: bool, opened: &mut Option<OpenSheet>) -> Result<()> {
    if !first && block.allow_ui_activation {
        block.chart_data.call_member("Activate", &[])?;
    }
    let workbook = block.chart_data.member("Workbook")?;
    if workbook.is_null() {
        return Err(Error::host("Workbook is not ready"));
    }
    let worksheets = workbook.member("Worksheets")?;
    if worksheets.is_null() || count(&worksheets)? == 0 {
        return Err(Error::host("Worksheets collection is not ready"));
    }
    let worksheet = worksheets.item_at(1)?;
    if worksheet.is_null() {
        return Err(Error::host("First worksheet is not ready"));
    }
    let cells = worksheet.member("Cells")?;
    if cells.is_null() {
        return Err(Error::host("Worksheet cells are not ready"));
    }
    // A non-null worksheet proxy can still be stale while the embedded workbook is activating: the chain is adopted only
    // after the first intended worksheet operation succeeds.
    cells.call_member("Clear", &[])?;
    let source = worksheet.call_member("Range", &[bstr(block.source_address)])?;
    if source.is_null() {
        return Err(Error::host("Chart source range is not ready"));
    }
    source.set_member("Value2", Com::Array(block.matrix.clone()))?;
    let sheet_name = string_value(&worksheet.member("Name")?).replace('\'', "''");
    let (last_column, last_row) = (block.last_column, block.last_row);
    let source_formula = format!("='{sheet_name}'!$A$1:${last_column}${last_row}");
    // Bind the complete range in one native operation so PowerPoint replaces its placeholder series without a chain of mutable
    // COM collection calls.
    block.chart.call_member("SetSourceData", &[bstr(&source_formula), i4(2)])?;
    *opened = Some(OpenSheet { workbook: workbook.clone() });
    register_chart_excel_application(context, &workbook, block.process_ids_before, !block.allow_ui_activation)
}

/// `Set-PowerPointChartData`: the series and categories written to the chart's embedded workbook as one block, the chart bound
/// to it, the series' colours set. Answers how many categories and series the chart has. `keep_legend` leaves the legend as it
/// stands (new numbers for a chart that already stands keep its legend, as the portable writer keeps it).
pub(crate) fn set_powerpoint_chart_data(
    context: &mut EditContext<'_>,
    chart: &Com,
    category_values: &Value,
    series_values: &Value,
    allow_ui_activation: bool,
    keep_legend: bool,
) -> Result<(i32, i32)> {
    let specs = array_of(series_values);
    if specs.is_empty() {
        return Err(Error::host("PowerPoint chart data requires at least one series"));
    }
    let mut categories = array_of(category_values);
    let mut point_count = categories.len();
    for spec in &specs {
        point_count = point_count.max(array_of(&prop(spec, "values")).len());
    }
    if point_count == 0 {
        return Err(Error::host("PowerPoint chart data requires at least one category or value"));
    }
    if categories.is_empty() {
        categories = (1..=point_count).map(|point| Value::String(format!("Item {point}"))).collect();
    }
    let matrix = data_matrix(&categories, &specs, point_count).ok_or_else(|| Error::host("The chart data block could not be built."))?;
    let last_column = column_letters(specs.len() as i32 + 1);
    let last_row = point_count + 1;
    let source_address = format!("A1:{last_column}{last_row}");
    let process_ids_before = excel_process_ids(&context.env);
    let chart_data = chart.member("ChartData")?;
    let block = Block {
        chart,
        chart_data: &chart_data,
        matrix: &matrix,
        source_address: &source_address,
        last_column: &last_column,
        last_row,
        allow_ui_activation,
        process_ids_before: &process_ids_before,
    };
    let mut opened: Option<OpenSheet> = None;
    let outcome = write_and_bind(context, &block, keep_legend, &specs, &mut opened);
    // Close the embedded workbook but never quit the Excel host that PowerPoint started for it: PowerPoint reuses that host for
    // the next chart in the same presentation, and quitting it here left the following operation holding a dead workbook
    // whose Worksheets came back null.
    if let Some(sheet) = opened {
        attempt(|| sheet.workbook.call_member("Close", &[boolean(true)]).map(|_| ()));
    }
    outcome.map(|series_count| (point_count as i32, series_count))
}

fn write_and_bind(context: &mut EditContext<'_>, block: &Block<'_>, keep_legend: bool, specs: &[Value], opened: &mut Option<OpenSheet>) -> Result<i32> {
    let chart = block.chart;
    if block.allow_ui_activation {
        block.chart_data.call_member("Activate", &[])?;
    }
    let mut last_open_error = String::new();
    let mut attempts = 0;
    while attempts < OPEN_ATTEMPTS && opened.is_none() {
        if let Err(error) = open_attempt(context, block, attempts == 0, opened) {
            last_open_error = error.message().to_owned();
        }
        if opened.is_none() {
            context.env.platform.sleep(OPEN_PAUSE_MS);
        }
        attempts += 1;
    }
    if opened.is_none() {
        return Err(Error::host(format!("PowerPoint chart embedded workbook did not expose its first worksheet. Last error: {last_open_error}")));
    }
    attempt(|| {
        chart.call_member("Refresh", &[])?;
        let category_axis = chart.call_member("Axes", &[i4(1), i4(1)])?;
        category_axis.set_member("CategoryType", i4(2))?;
        category_axis.set_member("TickLabelPosition", i4(4))?;
        walk(&category_axis, &["TickLabels"])?.set_member("Orientation", i4(0))
    });
    let series_count = retry::powerpoint(&context.env, "PowerPoint chart series", || count(&chart.call_member("SeriesCollection", &[])?))?;
    let mut series_index = 1;
    while series_index <= (specs.len() as i32).min(series_count) {
        let spec = &specs[series_index as usize - 1];
        let series = chart.call_member("SeriesCollection", &[])?.item_at(series_index)?;
        let ink = prop(spec, "color");
        if truthy(&ink) {
            attempt(|| {
                put_path(&series, &["Format", "Fill", "ForeColor", "RGB"], color(&ink)?)?;
                put_path(&series, &["Format", "Line", "ForeColor", "RGB"], color(&ink)?)
            });
        }
        // Point colours go on once the data sheet is closed (set_point_colors): while it is open a chart added after another
        // one can report no points, and its slices kept the theme's colours.
        series_index += 1;
    }
    // A pie or doughnut keeps the legend that names its slices, as the portable writer draws it.
    if !keep_legend {
        let legend_visible = specs.len() > 1 || [5, -4120].contains(&chart_type_of(chart));
        retry::powerpoint(&context.env, "PowerPoint chart legend", || chart.set_member("HasLegend", boolean(legend_visible)).map(|()| true))?;
    }
    Ok(series_count)
}

/// `$(try { [int]$chart.ChartType } catch { 0 })`.
pub(crate) fn chart_type_of(chart: &Com) -> i32 {
    chart.member("ChartType").and_then(|kind| int_value(&kind)).unwrap_or(0)
}

/// `try { [int]$chart.SeriesCollection().Count } catch { 0 }`.
fn series_count_of(chart: &Com) -> i32 {
    chart.call_member("SeriesCollection", &[]).and_then(|series| count(&series)).unwrap_or(0)
}

/// `$series.DataLabels()`'s position names, as `add_chart` and `set_chart_data` take them (anything else is outside end).
fn label_position(name: &Value) -> i32 {
    match text::to_lower_invariant(&text_of(name)).as_str() {
        "center" => -4108,
        "inside_base" => 4,
        "inside_end" => 3,
        _ => 2,
    }
}

/// `$value -eq $false`: PowerShell converts `$false` to the left operand's type.
fn equals_false(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => !flag,
        Value::Int(number) => *number == 0,
        Value::Long(number) => *number == 0,
        Value::Double(number) => *number == 0.0,
        Value::Single(number) => *number == 0.0,
        Value::Decimal(number) => number.is_zero(),
        Value::String(text) => text.eq_ignore_ascii_case("False"),
        _ => false,
    }
}

/// `Set-PowerPointDataLabels`: value labels on every series of a slide chart. `showValues: true` shows each value (in
/// `valueNumberFormat`, at `dataLabelPosition`, in `dataLabelColor`), `showValues: false` takes them away, and a label field
/// alone restyles the labels the chart already shows.
pub(crate) fn set_data_labels(chart: &Com, op: &Value) -> Result<()> {
    let series_count = count(&chart.call_member("SeriesCollection", &[])?)?;
    for series_index in 1..=series_count {
        let series = chart.call_member("SeriesCollection", &[])?.item_at(series_index)?;
        let show_values = prop(op, "showValues");
        attempt(|| {
            if equals_false(&show_values) {
                return series.set_member("HasDataLabels", boolean(false));
            }
            let labels = if truthy(&show_values) {
                series.call_member("ApplyDataLabels", &[])?;
                let labels = series.call_member("DataLabels", &[])?;
                labels.set_member("ShowValue", boolean(true))?;
                labels.set_member("ShowCategoryName", boolean(false))?;
                labels
            } else if truth(&series.member("HasDataLabels")?) {
                series.call_member("DataLabels", &[])?
            } else {
                return Ok(());
            };
            let number_format = prop(op, "valueNumberFormat");
            if truthy(&number_format) {
                labels.set_member("NumberFormat", bstr(&text_of(&number_format)))?;
            }
            let position = prop(op, "dataLabelPosition");
            if truthy(&position) {
                labels.set_member("Position", i4(label_position(&position)))?;
            }
            let ink = prop(op, "dataLabelColor");
            if truthy(&ink) {
                walk(&labels, &["Font"])?.set_member("Color", color(&ink)?)?;
            }
            Ok(())
        });
    }
    Ok(())
}

/// `Set-ChartCategoryLabelsLow`: a series below zero puts the category names at the foot of the plot, as the portable writer
/// places them, not on the zero line, where a loss bar's value label and its category name ran over each other. The values come
/// from the caller: read back from a PowerPoint chart they reopened its data and dropped the slice colours a doughnut had just
/// been given.
pub(crate) fn set_category_labels_low(chart: &Com, values: &[Value]) {
    for value in values {
        let text = text_of(value);
        let number = if text.trim().is_empty() { None } else { convert::to_double(&Value::String(text)).ok() };
        if number.is_some_and(|number| number < 0.0) {
            attempt(|| chart.call_member("Axes", &[i4(1), i4(1)])?.set_member("TickLabelPosition", i4(-4134)));
            return;
        }
    }
}

/// `Set-ChartTitleFace`: a chart title bold in the near-black ink at its size (0 keeps the application's own: PowerPoint's
/// 18.6 pt is the portable slide size too). Office's default was a regular grey title.
pub(crate) fn set_chart_title_face(chart: &Com, size: f32) {
    attempt(|| {
        let font = walk(chart, &["ChartTitle", "Format", "TextFrame2", "TextRange", "Font"])?;
        font.set_member("Bold", i4(-1))?;
        walk(&font, &["Fill", "ForeColor"])?.set_member("RGB", color_text("171717")?)?;
        if size > 0.0 {
            font.set_member("Size", r4(size))?;
        }
        Ok(())
    });
}

/// The per-series accent that marks the latest period: exactly one point whose fill differs from its series', and that point
/// the last.
pub(crate) struct Accent {
    series: i32,
    color: i32,
    base: i32,
    count: i32,
}

/// `Get-PowerPointLastPointAccents`: read before a data refresh so the accent can follow the last point when the number of
/// points changes.
pub(crate) fn last_point_accents(chart: &Com) -> Vec<Accent> {
    let mut accents = Vec::new();
    for series_index in 1..=series_count_of(chart) {
        attempt(|| {
            let series = chart.call_member("SeriesCollection", &[])?.item_at(series_index)?;
            let base = int_value(&walk(&series, &["Format", "Fill", "ForeColor", "RGB"])?)?;
            let points = count(&series.call_member("Points", &[])?)?;
            let mut lit: Vec<(i32, i32)> = Vec::new();
            for point_index in 1..=points {
                let fill = int_value(&walk(&series.call_member("Points", &[i4(point_index)])?, &["Format", "Fill", "ForeColor", "RGB"])?)?;
                if fill != base {
                    lit.push((point_index, fill));
                }
            }
            if lit.len() == 1 && lit[0].0 == points {
                accents.push(Accent { series: series_index, color: lit[0].1, base, count: points });
            }
            Ok(())
        });
    }
    accents
}

/// `Move-PowerPointLastPointAccents`: a monthly refresh that adds a period left the accent on the old last point, under a title
/// about the new one; a lone last-point accent moves to the new last point and the point it left takes its series colour. A
/// series the caller gave its own `pointColors` is the caller's.
pub(crate) fn move_last_point_accents(chart: &Com, accents: &[Accent], series_specs: &Value) {
    let specs = array_of(series_specs);
    for accent in accents {
        let spec = if (accent.series as usize) <= specs.len() { specs.get(accent.series as usize - 1) } else { None };
        // @($null) is one element in PowerShell: an absent pointColors must read as none, not as the caller's own.
        if let Some(spec) = spec {
            let colors = prop(spec, "pointColors");
            if present(&colors) && !array_of(&colors).is_empty() {
                continue;
            }
        }
        attempt(|| {
            let series = chart.call_member("SeriesCollection", &[])?.item_at(accent.series)?;
            let points = count(&series.call_member("Points", &[])?)?;
            if points < 1 || points == accent.count {
                return Ok(());
            }
            if accent.count <= points {
                let left = series.call_member("Points", &[i4(accent.count)])?;
                walk(&left, &["Format", "Fill"])?.call_member("Solid", &[])?;
                put_path(&left, &["Format", "Fill", "ForeColor", "RGB"], i4(accent.base))?;
            }
            let last = series.call_member("Points", &[i4(points)])?;
            walk(&last, &["Format", "Fill"])?.call_member("Solid", &[])?;
            put_path(&last, &["Format", "Fill", "ForeColor", "RGB"], i4(accent.color))
        });
    }
}

/// `Set-PowerPointPointColors`: one colour per bar or slice (`series[].pointColors`), once the chart's data sheet is closed: while
/// it is open a chart added after another one could report no points at all, and a doughnut kept the theme's colours. Only a
/// slice carries its label on its own fill; a bar's value stands above it on the page.
pub(crate) fn set_point_colors(chart: &Com, series_specs: &Value, label_ink: bool) {
    let specs = array_of(series_specs);
    let label_ink = label_ink && [5, -4120].contains(&chart_type_of(chart));
    let series_count = series_count_of(chart);
    let mut series_index = 1;
    while series_index <= (specs.len() as i32).min(series_count) {
        let colors = array_of(&prop(&specs[series_index as usize - 1], "pointColors"));
        for (at, entry) in colors.iter().enumerate() {
            let point_index = at as i32 + 1;
            let ink = text_of(entry);
            if ink.chars().all(char::is_whitespace) {
                continue;
            }
            attempt(|| {
                let point = chart.call_member("SeriesCollection", &[])?.item_at(series_index)?.call_member("Points", &[i4(point_index)])?;
                walk(&point, &["Format", "Fill"])?.call_member("Solid", &[])?;
                put_path(&point, &["Format", "Fill", "ForeColor", "RGB"], color_text(&ink)?)?;
                put_path(&point, &["Format", "Line", "ForeColor", "RGB"], color_text(&ink)?)?;
                // A labelled slice's value in the ink the slice can carry, as the portable writer sets it.
                if label_ink && truth(&point.member("HasDataLabel")?) {
                    put_path(&point, &["DataLabel", "Font", "Color"], color_text(&ink_on_fill(&ink))?)?;
                }
                Ok(())
            });
        }
        series_index += 1;
    }
}

/// `Close-PowerPointChartData`: the chart's data sheet is closed (after a refresh, only for a chart that kept PowerPoint's sample
/// data: a refresh after the data writer had coloured the slices put a doughnut back on the theme's colours), and the Excel the
/// chart started for its data, left with no workbook, is quit at once: left to shut down on its own it lingered about a minute,
/// and the next call that read the chart waited for it, which timed an operation out. An Excel that was running before the chart,
/// or one this host cannot identify, is left alone.
pub(crate) fn close_chart_data(env: &Env<'_>, chart: &Com, sample_data: bool, excel_before: &[i32]) {
    attempt(|| {
        let open_book = walk(chart, &["ChartData", "Workbook"])?;
        if open_book.is_null() {
            return Ok(());
        }
        let application = open_book.member("Application")?;
        if sample_data {
            attempt(|| chart.call_member("Refresh", &[]).map(|_| ()));
        }
        if count(&chart.call_member("SeriesCollection", &[])?)? > 0 {
            open_book.call_member("Close", &[boolean(true)])?;
        }
        if count(&application.member("Workbooks")?)? == 0 {
            let handle = window_handle(&application);
            let process_id = if handle != 0 { env.platform.process_id_for_window(handle) } else { 0 };
            if process_id > 0 && !excel_before.contains(&process_id) {
                application.set_member("DisplayAlerts", boolean(false))?;
                application.call_member("Quit", &[])?;
            }
        }
        Ok(())
    });
}

/// `@($op.series | ForEach-Object { @($_.values) })`: every value of every series, for the category labels' test.
pub(crate) fn series_values(series: &Value) -> Vec<Value> {
    pipeline(series).iter().flat_map(|spec| array_of(&prop(spec, "values"))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    #[test]
    fn column_letters_count_like_excel() {
        assert_eq!(column_letters(1), "A");
        assert_eq!(column_letters(3), "C");
        assert_eq!(column_letters(27), "AA");
        assert_eq!(column_letters(0), "");
    }

    #[test]
    fn the_data_block_has_a_header_row_and_a_row_per_point_with_the_item_names_for_missing_categories() {
        let specs = array_of(&parse_payload("[{\"name\":\"Sales\",\"values\":[1,2.5,3]},{\"name\":\"Cost\",\"values\":[4]}]").unwrap());
        let categories = vec![Value::string("2023"), Value::Int(2024)];
        let matrix = data_matrix(&categories, &specs, 3).expect("a block");
        assert_eq!(matrix.dims().len(), 2);
        assert_eq!(matrix.get(&[0, 0]), Some(&Com::from("Category")));
        assert_eq!(matrix.get(&[0, 1]), Some(&Com::from("Sales")));
        assert_eq!(matrix.get(&[0, 2]), Some(&Com::from("Cost")));
        assert_eq!(matrix.get(&[1, 0]), Some(&Com::from("2023")));
        assert_eq!(matrix.get(&[2, 0]), Some(&Com::I4(2024)));
        assert_eq!(matrix.get(&[3, 0]), Some(&Com::from("Item 3")));
        assert_eq!(matrix.get(&[1, 1]), Some(&Com::I4(1)));
        assert_eq!(matrix.get(&[3, 2]), Some(&Com::Empty));
        assert!(matches!(matrix.get(&[2, 1]), Some(Com::Decimal(_))));
    }

    #[test]
    fn the_position_names_are_those_of_add_chart_and_anything_else_is_outside_end() {
        assert_eq!(label_position(&Value::string("Center")), -4108);
        assert_eq!(label_position(&Value::string("inside_base")), 4);
        assert_eq!(label_position(&Value::string("inside_end")), 3);
        assert_eq!(label_position(&Value::string("outside_end")), 2);
        assert_eq!(label_position(&Value::string("best_fit")), 2);
    }

    #[test]
    fn false_equals_false_in_the_types_powershell_converts_it_to() {
        assert!(equals_false(&Value::Bool(false)));
        assert!(equals_false(&Value::Int(0)));
        assert!(equals_false(&Value::string("false")));
        assert!(!equals_false(&Value::Null));
        assert!(!equals_false(&Value::Bool(true)));
        assert!(!equals_false(&Value::string("no")));
    }

    #[test]
    fn the_values_of_every_series_are_gathered_for_the_category_label_test() {
        let series = parse_payload("[{\"values\":[1,-2]},{\"values\":[3]},{\"name\":\"none\"}]").unwrap();
        // A series with no values reads as one `$null` item, as `@($_.values)` does.
        assert_eq!(series_values(&series).len(), 4);
    }
}
