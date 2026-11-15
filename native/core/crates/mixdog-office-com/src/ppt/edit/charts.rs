//! The chart operations of the deck editor: `add_chart`, `set_chart_data`, `set_chart_series`, `set_chart_axis`,
//! `set_chart_trendline`, `set_chart_error_bars` and `set_chart_data_labels`, and `Office-ChartTypeCode`.

use crate::com::Error;
use crate::com::Result;
use crate::com::SafeArray;
use crate::com::Value as Com;
use crate::format::EditContext;
use crate::ppt::truth;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::ItemAt;
use super::array_of;
use super::as_int_nonzero;
use super::attempt;
use super::boolean;
use super::bstr;
use super::chart_data::cell_of;
use super::chart_data::close_chart_data;
use super::chart_data::excel_process_ids;
use super::chart_data::last_point_accents;
use super::chart_data::move_last_point_accents;
use super::chart_data::series_values;
use super::chart_data::set_category_labels_low;
use super::chart_data::set_chart_title_face;
use super::chart_data::set_data_labels;
use super::chart_data::set_point_colors;
use super::chart_data::set_powerpoint_chart_data;
use super::chart_window::ensure_chart_window;
use super::color_text;
use super::count;
use super::double;
use super::has_property;
use super::i4;
use super::int;
use super::int_value;
use super::present;
use super::prop;
use super::put_path;
use super::r4;
use super::record;
use super::shape_of;
use super::single;
use super::slide_of;
use super::string_value;
use super::text_of;
use super::truthy;
use super::walk;

/// The chart kinds by name, in the order the refusal lists them.
const CHART_TYPES: [(&str, i32); 9] =
    [("column", 51), ("bar", 57), ("stacked_column", 52), ("stacked_bar", 58), ("line", 4), ("area", 1), ("pie", 5), ("doughnut", -4120), ("scatter", -4169)];

/// `Office-ChartTypeCode`: a chart type by name (`donut` is `doughnut`, spaces and hyphens are underscores) or by its code; a
/// column chart where none is named.
pub(crate) fn chart_type_code(chart_type: &Value) -> Result<i32> {
    if chart_type.is_null() || text_of(chart_type).chars().all(char::is_whitespace) {
        return Ok(51);
    }
    if matches!(chart_type, Value::Int(_) | Value::Long(_) | Value::Double(_)) {
        return int(chart_type);
    }
    let lowered = text::to_lower_invariant(text_of(chart_type).trim());
    let mut kind = text::replace(&lowered, "[\\s-]+", "_", false).map_err(Error::host)?;
    if kind == "donut" {
        kind = "doughnut".to_owned();
    }
    if let Some((_, code)) = CHART_TYPES.iter().find(|(name, _)| *name == kind) {
        return Ok(*code);
    }
    if let Some(number) = convert::try_parse_int(&kind) {
        return Ok(number);
    }
    let names: Vec<&str> = CHART_TYPES.iter().map(|(name, _)| *name).collect();
    Err(Error::host(format!("Unknown chart type: {}; use one of {}", text_of(chart_type), names.join(", "))))
}

/// `@(1..$count)`: PowerShell's range runs downwards when the count is below 1.
fn series_range(total: i32) -> Vec<i32> {
    if total >= 1 { (1..=total).collect() } else { (total..=1).rev().collect() }
}

/// `if ($op.series) { @([int]$op.series) } else { @(1..[int]$collection.Count) }`: the series a chart operation is for.
fn series_indexes(collection: &Com, op: &Value) -> Result<Vec<i32>> {
    let named = prop(op, "series");
    if truthy(&named) { Ok(vec![int(&named)?]) } else { Ok(series_range(count(collection)?)) }
}

/// `$(if ($op.series) { [int]$op.series } else { 'all' })`.
fn series_answer(op: &Value) -> Result<Value> {
    let named = prop(op, "series");
    if truthy(&named) { Ok(Value::Int(int(&named)?)) } else { Ok(Value::string("all")) }
}

/// A shape that holds a chart, or "Shape <n> is not a chart".
fn chart_shape(presentation: &Com, op: &Value) -> Result<Com> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    if !truth(&shape.member("HasChart")?) {
        return Err(Error::host(format!("Shape {} is not a chart", text_of(&prop(op, "shape")))));
    }
    Ok(shape)
}

/// `$chart.Axes(1); ReversePlotOrder = $true; Crosses = 2`: the categories of a horizontal bar chart read from the top.
fn reverse_category_axis(chart: &Com) {
    attempt(|| {
        let axis = chart.call_member("Axes", &[i4(1)])?;
        axis.set_member("ReversePlotOrder", boolean(true))?;
        axis.set_member("Crosses", i4(2))
    });
}

/// Whether the labels of a chart are inside its marks: no position named, or one of the inside ones.
fn labels_inside(op: &Value) -> bool {
    let position = prop(op, "dataLabelPosition");
    !truthy(&position) || ["center", "inside_end", "inside_base"].contains(&text::to_lower_invariant(&text_of(&position)).as_str())
}

/// The ink of a slice's value label is chosen when the labels are inside and the caller named no colour.
fn label_ink_wanted(op: &Value) -> bool {
    truthy(&prop(op, "showValues")) && labels_inside(op) && !truthy(&prop(op, "dataLabelColor"))
}

/// `add_chart`: the chart in its own (hidden) window, its data, no automatic title, the 55% doughnut hole, legends and axes.
pub(crate) fn add_chart(context: &mut EditContext<'_>, presentation: &Com, op: &Value, allow_ui: bool) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    ensure_chart_window(&context.env, presentation, allow_ui)?;
    let chart_type = chart_type_code(&prop(op, "chartType"))?;
    let left = if present(&prop(op, "left")) { single(&prop(op, "left"))? } else { 72.0 };
    let top = if present(&prop(op, "top")) { single(&prop(op, "top"))? } else { 72.0 };
    let width = if truthy(&prop(op, "width")) { single(&prop(op, "width"))? } else { 480.0 };
    let height = if truthy(&prop(op, "height")) { single(&prop(op, "height"))? } else { 280.0 };
    // An array even when no Excel runs: an empty result unrolled to $null and skipped the quit below.
    let excel_before = excel_process_ids(&context.env);
    let shape = slide.member("Shapes")?.call_member("AddChart2", &[i4(-1), i4(chart_type), r4(left), r4(top), r4(width), r4(height)])?;
    let mut chart_result: Option<(i32, i32)> = None;
    let series = prop(op, "series");
    if has_property(op, "series") && present(&series) {
        chart_result = Some(set_powerpoint_chart_data(context, &shape.member("Chart")?, &prop(op, "categories"), &series, allow_ui, false)?);
    }
    let title = prop(op, "title");
    if truthy(&title) {
        shape.member("Chart")?.set_member("HasTitle", boolean(true))?;
        walk(&shape, &["Chart", "ChartTitle"])?.set_member("Text", bstr(&text_of(&title)))?;
        set_chart_title_face(&shape.member("Chart")?, 0.0);
    } else {
        // A chart given no title carries none, as the portable writer draws it: PowerPoint otherwise sets the one series' name
        // over the plot as an automatic title, a second headline under the page's.
        attempt(|| {
            shape.member("Chart")?.set_member("HasTitle", boolean(true))?;
            shape.member("Chart")?.set_member("HasTitle", boolean(false))
        });
    }
    // The ring the portable writer draws (a 55 % hole); PowerPoint's own doughnut left a thin band.
    if chart_type == -4120 {
        attempt(|| walk(&shape, &["Chart"])?.call_member("ChartGroups", &[i4(1)])?.set_member("DoughnutHoleSize", i4(55)));
    }
    let chart = shape.member("Chart")?;
    if chart_type == 57 || chart_type == 58 {
        reverse_category_axis(&chart);
    }
    if truthy(&prop(op, "showValues")) {
        set_data_labels(&chart, op)?;
    }
    let show_legend = prop(op, "showLegend");
    if present(&show_legend) {
        attempt(|| chart.set_member("HasLegend", boolean(truthy(&show_legend))));
    }
    attempt(|| walk(&chart, &["ChartArea", "Format", "Line"])?.set_member("Visible", i4(0)));
    attempt(|| walk(&chart, &["PlotArea", "Format", "Fill"])?.set_member("Visible", i4(0)));
    attempt(|| {
        let value_axis = chart.call_member("Axes", &[i4(2), i4(1)])?;
        if truthy(&prop(op, "zeroBaseline")) {
            value_axis.set_member("MinimumScale", i4(0))?;
        }
        let number_format = prop(op, "valueNumberFormat");
        if truthy(&number_format) {
            walk(&value_axis, &["TickLabels"])?.set_member("NumberFormat", bstr(&text_of(&number_format)))?;
        }
        put_path(&value_axis, &["MajorGridlines", "Format", "Line", "ForeColor", "RGB"], color_text("D9E2DF")?)
    });
    attempt(|| chart.call_member("ChartGroups", &[i4(1)])?.set_member("GapWidth", i4(72)));
    set_category_labels_low(&chart, &series_values(&series));
    close_chart_data(&context.env, &shape.member("Chart")?, chart_result.is_none(), &excel_before);
    set_point_colors(&shape.member("Chart")?, &series, label_ink_wanted(op));
    let (categories, series_count) = match chart_result {
        Some((categories, series_count)) => (categories, series_count),
        None => (0, count(&walk(&shape, &["Chart"])?.call_member("SeriesCollection", &[])?)?),
    };
    Ok(record(vec![
        ("op", Value::string("add_chart")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
        ("categories", Value::Int(categories)),
        ("series", Value::Int(series_count)),
    ]))
}

/// The categories a chart holds, as text (`@($chart.SeriesCollection().Item(1).XValues | Where-Object { $null -ne $_ } |
/// ForEach-Object { [string]$_ })`), none where the read fails.
fn categories_of(chart: &Com) -> Vec<Value> {
    let read = || -> Result<Com> { chart.call_member("SeriesCollection", &[])?.item_at(1)?.member("XValues") };
    match read().unwrap_or(Com::Null) {
        Com::Array(array) => array.into_data().iter().filter(|item| !item.is_null()).map(|item| Value::String(string_value(item))).collect(),
        other if other.is_null() => Vec::new(),
        other => vec![Value::String(string_value(&other))],
    }
}

/// The note a bar chart that still reads from the bottom up is answered with.
const BOTTOM_UP_NOTE: &str = "The bars read from the bottom up, the first category lowest, as this chart was authored; categoryOrder:'topDown' lists them from the top in the order given.";

/// `set_chart_data`: new numbers for a chart that already stands. The categories it holds are kept unless the call names its own
/// (sent without them, the refresh wrote PowerPoint's placeholder labels under the bars), and the fields beside the numbers
/// change the chart only when given.
pub(crate) fn set_chart_data(context: &mut EditContext<'_>, presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let chart = shape.member("Chart")?;
    let accents = last_point_accents(&chart);
    let excel_before = excel_process_ids(&context.env);
    let mut categories = prop(op, "categories");
    if categories.is_null() || array_of(&categories).is_empty() {
        categories = Value::Array(categories_of(&chart));
    }
    let series = prop(op, "series");
    let (category_count, series_count) = set_powerpoint_chart_data(context, &chart, &categories, &series, true, true)?;
    if truthy(&prop(op, "chartType")) {
        let chart_type = chart_type_code(&prop(op, "chartType"))?;
        chart.set_member("ChartType", i4(chart_type))?;
        if chart_type == 57 || chart_type == 58 {
            reverse_category_axis(&chart);
        }
    }
    // The order a horizontal bar chart lists its categories in: topDown runs the category axis the other way with the value axis
    // crossing at its far end, under the bars; bottomUp is PowerPoint's default, which a template's bar chart usually carries.
    let horizontal_bars = [57, 58, 59, 60, 61, 62].contains(&int_value(&chart.member("ChartType")?)?);
    let order_given = prop(op, "categoryOrder");
    let mut category_order = String::new();
    if present(&order_given) && !text_of(&order_given).is_empty() {
        let squeezed = text::replace(&text_of(&order_given), "[\\s_-]", "", false).map_err(Error::host)?;
        category_order = text::to_lower_invariant(&squeezed);
        if category_order != "topdown" && category_order != "bottomup" {
            return Err(Error::host("set_chart_data categoryOrder must be 'topDown' or 'bottomUp'"));
        }
        if !horizontal_bars {
            return Err(Error::host("set_chart_data categoryOrder orders a horizontal bar chart's categories; this chart is not one"));
        }
        let category_axis = chart.call_member("Axes", &[i4(1)])?;
        if category_order == "topdown" {
            category_axis.set_member("ReversePlotOrder", boolean(true))?;
            category_axis.set_member("Crosses", i4(2))?;
        } else {
            category_axis.set_member("ReversePlotOrder", boolean(false))?;
            category_axis.set_member("Crosses", i4(-4105))?;
        }
    }
    if present(&prop(op, "showValues")) || truthy(&prop(op, "valueNumberFormat")) || truthy(&prop(op, "dataLabelPosition")) || truthy(&prop(op, "dataLabelColor")) {
        set_data_labels(&chart, op)?;
    }
    let zero_baseline = prop(op, "zeroBaseline");
    if present(&zero_baseline) || truthy(&prop(op, "valueNumberFormat")) {
        attempt(|| {
            let value_axis = chart.call_member("Axes", &[i4(2), i4(1)])?;
            if present(&zero_baseline) {
                if truthy(&zero_baseline) {
                    value_axis.set_member("MinimumScale", i4(0))?;
                } else {
                    value_axis.set_member("MinimumScaleIsAuto", boolean(true))?;
                }
            }
            let number_format = prop(op, "valueNumberFormat");
            if truthy(&number_format) {
                walk(&value_axis, &["TickLabels"])?.set_member("NumberFormat", bstr(&text_of(&number_format)))?;
            }
            Ok(())
        });
    }
    let show_legend = prop(op, "showLegend");
    if present(&show_legend) {
        attempt(|| chart.set_member("HasLegend", boolean(truthy(&show_legend))));
    }
    // title:'' removes the title, as the portable writer does: a template chart's own words otherwise stay.
    let title = prop(op, "title");
    if present(&title) {
        if !text_of(&title).is_empty() {
            chart.set_member("HasTitle", boolean(true))?;
            walk(&chart, &["ChartTitle"])?.set_member("Text", bstr(&text_of(&title)))?;
        } else {
            chart.set_member("HasTitle", boolean(false))?;
        }
    }
    close_chart_data(&context.env, &chart, false, &excel_before);
    move_last_point_accents(&chart, &accents, &series);
    set_point_colors(&chart, &series, label_ink_wanted(op));
    let mut pairs = vec![
        ("op", Value::string("set_chart_data")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("categories", Value::Int(category_count)),
        ("series", Value::Int(series_count)),
    ];
    // Bars left reading from the bottom up are named with the field that turns them over, as the portable writer names them.
    if horizontal_bars && category_order.is_empty() {
        let reversed = chart.call_member("Axes", &[i4(1)]).and_then(|axis| axis.member("ReversePlotOrder")).map(|flag| truth(&flag)).unwrap_or(true);
        if !reversed {
            pairs.push(("readingOrder", Value::string("bottomUp")));
            pairs.push(("note", Value::string(BOTTOM_UP_NOTE)));
        }
    }
    Ok(record(pairs))
}

/// `[object[]]@($values)`: the values of a series as the block a COM property takes.
fn object_array(values: &Value) -> Com {
    Com::Array(SafeArray::one_d(0, array_of(values).iter().map(cell_of).collect()))
}

/// `set_chart_series`.
pub(crate) fn set_chart_series(presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let series = walk(&shape, &["Chart"])?.call_member("SeriesCollection", &[])?.item_at(int(&prop(op, "series"))?)?;
    let name = prop(op, "name");
    if present(&name) {
        series.set_member("Name", bstr(&text_of(&name)))?;
    }
    let categories = prop(op, "categories");
    if present(&categories) {
        series.set_member("XValues", object_array(&categories))?;
    }
    let values = prop(op, "values");
    if present(&values) {
        series.set_member("Values", object_array(&values))?;
    }
    let secondary = prop(op, "secondaryAxis");
    if present(&secondary) {
        series.set_member("AxisGroup", i4(if truthy(&secondary) { 2 } else { 1 }))?;
    }
    let chart_type = prop(op, "chartType");
    if present(&chart_type) {
        series.set_member("ChartType", i4(chart_type_code(&chart_type)?))?;
    }
    Ok(record(vec![
        ("op", Value::string("set_chart_series")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("series", Value::Int(int(&prop(op, "series"))?)),
    ]))
}

/// `set_chart_axis`.
pub(crate) fn set_chart_axis(presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let axis_type = if payload::names_equal(&text_of(&prop(op, "axis")), "category") { 1 } else { 2 };
    let group = if truthy(&prop(op, "secondaryAxis")) { 2 } else { 1 };
    let axis = walk(&shape, &["Chart"])?.call_member("Axes", &[i4(axis_type), i4(group)])?;
    let title = prop(op, "title");
    if present(&title) {
        axis.set_member("HasTitle", boolean(true))?;
        walk(&axis, &["AxisTitle"])?.set_member("Text", bstr(&text_of(&title)))?;
    }
    for (name, member) in [("minimum", "MinimumScale"), ("maximum", "MaximumScale"), ("majorUnit", "MajorUnit")] {
        let value = prop(op, name);
        if present(&value) {
            axis.set_member(member, Com::R8(double(&value)?))?;
        }
    }
    let number_format = prop(op, "numberFormat");
    if truthy(&number_format) {
        walk(&axis, &["TickLabels"])?.set_member("NumberFormat", bstr(&text_of(&number_format)))?;
    }
    Ok(record(vec![
        ("op", Value::string("set_chart_axis")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("axis", Value::String(text_of(&prop(op, "axis")))),
    ]))
}

/// The trendline kinds by name or by the file's code.
const TRENDLINES: [(&str, i32); 10] = [
    ("linear", -4132),
    ("exponential", 5),
    ("exp", 5),
    ("logarithmic", -4133),
    ("log", -4133),
    ("polynomial", 3),
    ("poly", 3),
    ("power", 4),
    ("movingaverage", 6),
    ("movingavg", 6),
];

/// `set_chart_trendline`: every series unless one is named, an unknown kind refused rather than drawn linear.
pub(crate) fn set_chart_trendline(presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let kind_given = prop(op, "type");
    let kind = if truthy(&kind_given) {
        text::replace(&text::to_lower_invariant(&text_of(&kind_given)), "[\\s_-]+", "", false).map_err(Error::host)?
    } else {
        "linear".to_owned()
    };
    let Some((_, trend_type)) = TRENDLINES.iter().find(|(name, _)| payload::names_equal(name, &kind)) else {
        return Err(Error::host("set_chart_trendline type must be linear, exponential, logarithmic, polynomial, power, or moving_average"));
    };
    let collection = walk(&shape, &["Chart"])?.call_member("SeriesCollection", &[])?;
    for index in series_indexes(&collection, op)? {
        let trendline = collection.item_at(index)?.call_member("Trendlines", &[])?.call_member("Add", &[i4(*trend_type)])?;
        let equation = prop(op, "displayEquation");
        if present(&equation) {
            trendline.set_member("DisplayEquation", boolean(truthy(&equation)))?;
        }
        let r_squared = prop(op, "displayRSquared");
        if present(&r_squared) {
            trendline.set_member("DisplayRSquared", boolean(truthy(&r_squared)))?;
        }
    }
    Ok(record(vec![
        ("op", Value::string("set_chart_trendline")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("series", series_answer(op)?),
        ("type", Value::Int(*trend_type)),
    ]))
}

/// `set_chart_error_bars`: every series unless one is named, direction `x` or `y`, `endStyle` the bars' kind (both, plus, minus),
/// and a positive amount.
pub(crate) fn set_chart_error_bars(presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let collection = walk(&shape, &["Chart"])?.call_member("SeriesCollection", &[])?;
    let indexes = series_indexes(&collection, op)?;
    let direction_given = prop(op, "direction");
    let direction_name = if truthy(&direction_given) { text::to_lower_invariant(&text_of(&direction_given)) } else { "y".to_owned() };
    let direction = match direction_name.as_str() {
        "y" | "vertical" => 1,
        "x" | "horizontal" => -4168,
        _ => return Err(Error::host("set_chart_error_bars direction must be x or y")),
    };
    let style_given = prop(op, "endStyle");
    let style = if truthy(&style_given) { text::to_lower_invariant(&text_of(&style_given)) } else { "both".to_owned() };
    let include = match style.as_str() {
        "plus" => 2,
        "minus" => 3,
        _ => 1,
    };
    let amount_given = prop(op, "amount");
    let amount = double(&if present(&amount_given) { amount_given } else { Value::Int(0) })?;
    if !(amount > 0.0) {
        return Err(Error::host("set_chart_error_bars requires a positive amount"));
    }
    for index in indexes {
        let series = collection.item_at(index)?;
        series.call_member("ErrorBar", &[i4(direction), i4(include), i4(1), Com::R8(amount)])?;
        attempt(|| series.member("ErrorBars")?.set_member("EndStyle", i4(1)));
    }
    Ok(record(vec![
        ("op", Value::string("set_chart_error_bars")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("series", series_answer(op)?),
    ]))
}

/// The label positions by name.
const LABEL_POSITIONS: [(&str, i32); 6] = [("center", -4108), ("centre", -4108), ("inside_base", 4), ("inside_end", 3), ("outside_end", 2), ("best_fit", 5)];

/// The chart types that take no label position (a pie or doughnut), and the stacked ones that take no outside end.
const NO_POSITION: [i32; 8] = [5, 69, -4102, 70, -4120, 80, 68, 71];
const NO_OUTSIDE_END: [i32; 8] = [52, 53, 55, 56, 58, 59, 61, 62];

/// The position a label is given: by name, else by the file's code, and as the portable writer has it for the chart kinds.
fn label_position_for(given: &Value, chart_type: i32) -> Option<i32> {
    let mut position = None;
    if present(given) {
        let name = text::to_lower_invariant(&text_of(given));
        if let Some((_, code)) = LABEL_POSITIONS.iter().find(|(known, _)| payload::names_equal(known, &name)) {
            position = Some(*code);
        } else if as_int_nonzero(given).is_some() {
            position = convert::as_int(given);
        }
    }
    if NO_POSITION.contains(&chart_type) {
        None
    } else if NO_OUTSIDE_END.contains(&chart_type) && position == Some(2) {
        Some(-4108)
    } else {
        position
    }
}

/// `set_chart_data_labels`: every series when none is named, positions by add_chart's names.
pub(crate) fn set_chart_data_labels(presentation: &Com, op: &Value) -> Result<Value> {
    let shape = chart_shape(presentation, op)?;
    let collection = walk(&shape, &["Chart"])?.call_member("SeriesCollection", &[])?;
    let indexes = series_indexes(&collection, op)?;
    let given = prop(op, "position");
    let chart_type = int_value(&walk(&shape, &["Chart", "ChartType"])?)?;
    let position = label_position_for(&given, chart_type);
    for index in indexes {
        let series = collection.item_at(index)?;
        series.call_member("ApplyDataLabels", &[])?;
        let labels = series.call_member("DataLabels", &[])?;
        let show_value = prop(op, "showValue");
        if present(&show_value) {
            labels.set_member("ShowValue", boolean(truthy(&show_value)))?;
        }
        let show_category = prop(op, "showCategoryName");
        if present(&show_category) {
            labels.set_member("ShowCategoryName", boolean(truthy(&show_category)))?;
        }
        let number_format = prop(op, "numberFormat");
        if truthy(&number_format) {
            labels.set_member("NumberFormat", bstr(&text_of(&number_format)))?;
        }
        if let Some(position) = position {
            labels.set_member("Position", i4(position))?;
        }
    }
    Ok(record(vec![
        ("op", Value::string("set_chart_data_labels")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("series", series_answer(op)?),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    #[test]
    fn a_chart_type_is_a_name_a_code_or_a_column_chart() {
        assert_eq!(chart_type_code(&Value::Null).unwrap(), 51);
        assert_eq!(chart_type_code(&Value::string("  ")).unwrap(), 51);
        assert_eq!(chart_type_code(&Value::string("Stacked Bar")).unwrap(), 58);
        assert_eq!(chart_type_code(&Value::string("donut")).unwrap(), -4120);
        assert_eq!(chart_type_code(&Value::string("stacked-column")).unwrap(), 52);
        assert_eq!(chart_type_code(&Value::Int(4)).unwrap(), 4);
        assert_eq!(chart_type_code(&Value::string("77")).unwrap(), 77);
        assert_eq!(
            chart_type_code(&Value::string("radar")).unwrap_err().message(),
            "Unknown chart type: radar; use one of column, bar, stacked_column, stacked_bar, line, area, pie, doughnut, scatter"
        );
    }

    #[test]
    fn a_count_of_zero_ranges_downwards_as_powershell_does() {
        assert_eq!(series_range(3), vec![1, 2, 3]);
        assert_eq!(series_range(1), vec![1]);
        assert_eq!(series_range(0), vec![1, 0]);
    }

    #[test]
    fn label_positions_follow_the_chart_kind() {
        let outside = Value::string("outside_end");
        // A clustered column keeps the outside end; a stacked bar takes the centre instead; a doughnut takes no position.
        assert_eq!(label_position_for(&outside, 51), Some(2));
        assert_eq!(label_position_for(&outside, 58), Some(-4108));
        assert_eq!(label_position_for(&outside, -4120), None);
        assert_eq!(label_position_for(&Value::Null, 51), None);
        assert_eq!(label_position_for(&Value::string("Best_Fit"), 51), Some(5));
        assert_eq!(label_position_for(&Value::string("4"), 51), Some(4));
        assert_eq!(label_position_for(&Value::string("bogus"), 51), None);
    }

    #[test]
    fn value_labels_inside_a_slice_choose_their_ink_unless_a_colour_is_named() {
        let op = |text: &str| parse_payload(text).unwrap();
        assert!(label_ink_wanted(&op("{\"showValues\":true}")));
        assert!(label_ink_wanted(&op("{\"showValues\":true,\"dataLabelPosition\":\"Center\"}")));
        assert!(!label_ink_wanted(&op("{\"showValues\":true,\"dataLabelPosition\":\"outside_end\"}")));
        assert!(!label_ink_wanted(&op("{\"showValues\":true,\"dataLabelColor\":\"FFFFFF\"}")));
        assert!(!label_ink_wanted(&op("{}")));
    }
}
