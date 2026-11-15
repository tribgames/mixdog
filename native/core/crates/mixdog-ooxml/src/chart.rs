//! `portable/portable-chart.mjs`: the DrawingML chart part that worksheets and slides share: bar, column, line, area, pie
//! and doughnut charts with their series, axes, data labels, number formats and palettes, and the cells a chart's cache is
//! refreshed from. Inputs are the loosely typed values a tool call carries (`serde_json::Value`), read the way Node read
//! them (`String(x ?? '')`, `Number(x)`, truthiness), so the text written is the text Node wrote.

use mixdog_js::{is_js_space, js_to_lowercase, js_trim, json_number, number_to_string, to_number, value_to_string};
use mixdog_office_base::a1::column_label;
use mixdog_office_base::values::truthy;
use serde_json::Value;

use crate::text_metrics::contrast_ratio;
use crate::xml::{DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, xml_encode};

const CHART_NAMESPACE: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const CATEGORY_AXIS_ID: u32 = 111_111_111;
const VALUE_AXIS_ID: u32 = 222_222_222;

/// One chart family: the plot element, the bar direction, whether it has axes and how its series are grouped.
#[derive(Debug, Clone, Copy)]
struct Family {
    element: &'static str,
    direction: Option<&'static str>,
    axes: bool,
    grouping: Option<&'static str>,
}

impl Family {
    fn stacked(&self) -> bool {
        self.grouping == Some("stacked")
    }

    fn slices(&self) -> bool {
        self.element == "pieChart" || self.element == "doughnutChart"
    }
}

const CHART_FAMILIES: [(&str, Family); 8] = [
    ("column", Family { element: "barChart", direction: Some("col"), axes: true, grouping: None }),
    ("bar", Family { element: "barChart", direction: Some("bar"), axes: true, grouping: None }),
    ("stacked_column", Family { element: "barChart", direction: Some("col"), axes: true, grouping: Some("stacked") }),
    ("stacked_bar", Family { element: "barChart", direction: Some("bar"), axes: true, grouping: Some("stacked") }),
    ("line", Family { element: "lineChart", direction: None, axes: true, grouping: None }),
    ("area", Family { element: "areaChart", direction: None, axes: true, grouping: None }),
    ("pie", Family { element: "pieChart", direction: None, axes: false, grouping: None }),
    ("doughnut", Family { element: "doughnutChart", direction: None, axes: false, grouping: None }),
];

/// Excel fills an unstyled series from the workbook theme, so a chart part written without a style or colour map is left to
/// the reader, and a reader that resolves nothing draws a plot of invisible bars under visible labels. Every series
/// therefore carries an explicit fill unless the caller names one; one hue family in light and dark steps keeps a
/// multi-series plot readable in print and on a projector.
pub const DEFAULT_SERIES_COLORS: [&str; 6] = ["2F6DB5", "9FB6CE", "1B4374", "6FA0D8", "4E6274", "C3D0DD"];

/// The text sizes a chart's parts take, in hundredths of a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChartText {
    pub title: u32,
    pub body: u32,
    pub label: u32,
}

/// A worksheet chart reads at Excel's scale (a 12 pt title over 9 pt axes).
pub const SHEET_CHART_TEXT: ChartText = ChartText { title: 1200, body: 900, label: 1000 };
/// A slide chart reads at PowerPoint's own: the 18.6 pt title over 12 pt text AddChart2 writes on the wide canvas. The
/// worksheet sizes on a slide set a chart's axes at 9 pt beside the 12 pt Office drew for the same one.
pub const SLIDE_CHART_TEXT: ChartText = ChartText { title: 1862, body: 1197, label: 1197 };

const LABEL_POSITIONS: [(&str, &str); 6] = [
    ("inside_end", "inEnd"),
    ("inside_base", "inBase"),
    ("outside_end", "outEnd"),
    ("center", "ctr"),
    ("centre", "ctr"),
    ("best_fit", "bestFit"),
];

/// `String(value ?? '')`.
fn string_of(value: &Value) -> String {
    if value.is_null() { String::new() } else { value_to_string(value) }
}

/// `hex(value)`: a six-digit colour (a three-digit one doubled), upper-cased and without `#`; empty when it is neither.
fn hex(value: &Value) -> String {
    hex_text(&string_of(value))
}

fn hex_text(text: &str) -> String {
    let trimmed = js_trim(text);
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed).to_uppercase();
    let digits = raw.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'A'..=b'F'));
    if digits && raw.len() == 6 {
        return raw;
    }
    if digits && raw.len() == 3 {
        return raw.chars().flat_map(|digit| [digit, digit]).collect();
    }
    String::new()
}

fn resolve_chart_family(chart_type: &str) -> Option<Family> {
    let raw = if chart_type.is_empty() { "column" } else { chart_type };
    let lowered = js_to_lowercase(js_trim(raw));
    let mut key = String::with_capacity(lowered.len());
    let mut in_separator = false;
    for character in lowered.chars() {
        if is_js_space(character) || character == '-' {
            if !in_separator {
                key.push('_');
            }
            in_separator = true;
        } else {
            key.push(character);
            in_separator = false;
        }
    }
    CHART_FAMILIES.iter().find(|(name, _)| *name == key).map(|(_, family)| *family)
}

fn supported_chart_types() -> Vec<&'static str> {
    CHART_FAMILIES.iter().map(|(name, _)| *name).collect()
}

fn string_reference(formula: &str, values: &[String]) -> String {
    let points: String =
        values.iter().enumerate().map(|(index, value)| format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", xml_encode(value))).collect();
    format!(
        "<c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{}\"/>{points}</c:strCache></c:strRef>",
        xml_encode(formula),
        values.len()
    )
}

fn number_reference(formula: &str, values: &[Value], format_code: &str) -> String {
    let points: String = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let numeric = to_number(value);
            if numeric.is_finite() { format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", number_to_string(numeric)) } else { String::new() }
        })
        .collect();
    let code = if format_code.is_empty() { "General" } else { format_code };
    format!(
        "<c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>{}</c:formatCode><c:ptCount val=\"{}\"/>{points}</c:numCache></c:numRef>",
        xml_encode(formula),
        xml_encode(code),
        values.len()
    )
}

fn series_shape(family: &Family, color: &Value) -> String {
    let fill = hex(color);
    if fill.is_empty() {
        return String::new();
    }
    if family.element == "lineChart" {
        return format!(
            "<c:spPr><a:ln w=\"28575\" cap=\"rnd\"><a:solidFill><a:srgbClr val=\"{fill}\"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>"
        );
    }
    format!("<c:spPr><a:solidFill><a:srgbClr val=\"{fill}\"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>")
}

fn data_point_shapes(family: &Family, colors: Option<&[Value]>) -> String {
    let Some(colors) = colors else { return String::new() };
    if family.element == "lineChart" {
        return String::new();
    }
    colors
        .iter()
        .enumerate()
        .map(|(index, color)| {
            let shape = series_shape(family, color);
            if shape.is_empty() { String::new() } else { format!("<c:dPt><c:idx val=\"{index}\"/>{shape}</c:dPt>") }
        })
        .collect()
}

/// A value printed on a slice reads in the ink that slice can carry (white on the navy one, near-black on the pale one)
/// when the caller names no label colour: one dark ink for every slice vanished into the darkest.
fn slice_labels(point_colors: Option<&[Value]>, size: u32) -> String {
    point_colors
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(index, fill)| {
            let field = hex(fill);
            if field.is_empty() {
                return String::new();
            }
            let ink = if contrast_ratio("FFFFFF", &field).unwrap_or(0.0) >= contrast_ratio("1F2429", &field).unwrap_or(0.0) {
                "FFFFFF"
            } else {
                "1F2429"
            };
            format!(
                "<c:dLbl><c:idx val=\"{index}\"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>\
                 <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{size}\"><a:solidFill><a:srgbClr val=\"{ink}\"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>\
                 <c:showLegendKey val=\"0\"/><c:showVal val=\"1\"/><c:showCatName val=\"0\"/><c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbl>"
            )
        })
        .collect()
}

struct LabelOptions<'a> {
    show_values: bool,
    position: &'a str,
    color: &'a str,
    number_format: &'a str,
    family: &'a Family,
    size: u32,
    point_colors: Option<&'a [Value]>,
}

fn data_labels(options: &LabelOptions<'_>) -> String {
    if !options.show_values {
        return String::new();
    }
    let family = options.family;
    let size = options.size;
    let position = js_to_lowercase(options.position);
    let resolved = LABEL_POSITIONS.iter().find(|(name, _)| *name == position).map_or("", |(_, code)| *code);
    let out_end_allowed = family.axes && !family.stacked();
    let usable = if !out_end_allowed && resolved == "outEnd" { "ctr" } else { resolved };
    let label = hex_text(options.color);
    let slices = family.slices();
    let mut out = String::from("<c:dLbls>");
    if slices && label.is_empty() {
        out.push_str(&slice_labels(options.point_colors, size));
    }
    if !options.number_format.is_empty() {
        out.push_str(&format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", xml_encode(options.number_format)));
    }
    out.push_str("<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>");
    // The labels carry their size whether or not a colour is named: unnamed, a slide chart's labels fell to the reader's
    // 10 pt beside 12 pt axes.
    if label.is_empty() {
        out.push_str(&format!(
            "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{size}\"/></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>"
        ));
    } else {
        out.push_str(&format!(
            "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{size}\" b=\"1\"><a:solidFill><a:srgbClr val=\"{label}\"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>"
        ));
    }
    if !usable.is_empty() && !slices {
        out.push_str(&format!("<c:dLblPos val=\"{usable}\"/>"));
    }
    out.push_str(
        "<c:showLegendKey val=\"0\"/><c:showVal val=\"1\"/><c:showCatName val=\"0\"/>\
         <c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbls>",
    );
    out
}

fn axis_text(size: u32) -> String {
    format!(
        "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{size}\">\
         <a:solidFill><a:srgbClr val=\"5F6368\"/></a:solidFill></a:defRPr></a:pPr>\
         <a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>"
    )
}

struct CategoryAxis<'a> {
    hidden: bool,
    horizontal: bool,
    reversed: bool,
    size: u32,
    low: bool,
    number_format: &'a str,
}

/// Horizontal bars (barDir bar) read top-down in the order given: the category axis runs max-to-min on the left and the
/// value axis crosses it at the far end, along the bottom. A series below zero sets the category names at the foot of the
/// plot (low), not on the zero line, where a loss bar's value label and its category name ran over each other. Dated
/// categories read in their cells' format on a text axis: auto would turn them into a date scale.
fn category_axis(axis: &CategoryAxis<'_>) -> String {
    let format = if axis.number_format.is_empty() {
        String::new()
    } else {
        format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"1\"/>", xml_encode(axis.number_format))
    };
    format!(
        "<c:catAx><c:axId val=\"{CATEGORY_AXIS_ID}\"/>\
         <c:scaling><c:orientation val=\"{}\"/></c:scaling><c:delete val=\"{}\"/><c:axPos val=\"{}\"/>{format}\
         <c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"{}\"/>\
         <c:spPr><a:ln w=\"9525\"><a:solidFill><a:srgbClr val=\"C7CBD1\"/></a:solidFill></a:ln></c:spPr>{}\
         <c:crossAx val=\"{VALUE_AXIS_ID}\"/><c:crosses val=\"autoZero\"/><c:auto val=\"{}\"/>\
         <c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/><c:noMultiLvlLbl val=\"0\"/></c:catAx>",
        if axis.reversed { "maxMin" } else { "minMax" },
        u8::from(axis.hidden),
        if axis.horizontal { "l" } else { "b" },
        if axis.low { "low" } else { "nextTo" },
        axis_text(axis.size),
        u8::from(axis.number_format.is_empty()),
    )
}

/// Per-point colors: the series' own list, a default cycle for pie and doughnut slices, else none.
fn point_colors_for(family: &Family, entry: &Value, rows: &[String]) -> Option<Vec<Value>> {
    if let Some(list) = entry.get("pointColors").and_then(Value::as_array).filter(|list| !list.is_empty()) {
        return Some(list.clone());
    }
    if family.slices() {
        return Some((0..rows.len()).map(|point| Value::from(DEFAULT_SERIES_COLORS[point % DEFAULT_SERIES_COLORS.len()])).collect());
    }
    None
}

struct ValueAxis<'a> {
    number_format: &'a str,
    zero_baseline: bool,
    hidden: bool,
    min: Option<String>,
    max: Option<String>,
    gridlines: bool,
    horizontal: bool,
    reversed: bool,
    size: u32,
}

fn value_axis(axis: &ValueAxis<'_>) -> String {
    let low = match &axis.min {
        Some(min) => Some(min.clone()),
        None if axis.zero_baseline => Some("0".to_owned()),
        None => None,
    };
    let gridlines = if axis.gridlines {
        "<c:majorGridlines><c:spPr><a:ln w=\"9525\"><a:solidFill><a:srgbClr val=\"E7E9EC\"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>"
    } else {
        ""
    };
    let format = if axis.number_format.is_empty() {
        String::new()
    } else {
        format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", xml_encode(axis.number_format))
    };
    format!(
        "<c:valAx><c:axId val=\"{VALUE_AXIS_ID}\"/><c:scaling><c:orientation val=\"minMax\"/>{}{}</c:scaling>\
         <c:delete val=\"{}\"/><c:axPos val=\"{}\"/>{gridlines}{format}\
         <c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/>\
         <c:spPr><a:ln><a:noFill/></a:ln></c:spPr>{}\
         <c:crossAx val=\"{CATEGORY_AXIS_ID}\"/><c:crosses val=\"{}\"/><c:crossBetween val=\"between\"/></c:valAx>",
        axis.max.as_ref().map_or_else(String::new, |max| format!("<c:max val=\"{max}\"/>")),
        low.map_or_else(String::new, |low| format!("<c:min val=\"{low}\"/>")),
        u8::from(axis.hidden),
        if axis.horizontal { "b" } else { "l" },
        axis_text(axis.size),
        if axis.reversed { "max" } else { "autoZero" },
    )
}

/// The faces a run names when the chart has one: a title is its own rich text, and the chart's default face did not reach
/// it through the recalculation's roundtrip.
fn run_faces(font: &str) -> String {
    if font.is_empty() {
        return String::new();
    }
    let face = xml_encode(font);
    format!("<a:latin typeface=\"{face}\"/><a:ea typeface=\"{face}\"/><a:cs typeface=\"{face}\"/>")
}

fn chart_title(text: &str, font: &str, size: u32) -> String {
    if text.is_empty() {
        return "<c:autoTitleDeleted val=\"1\"/>".to_owned();
    }
    let run_properties = if font.is_empty() {
        format!("<a:rPr lang=\"en-US\" sz=\"{size}\" b=\"1\"/>")
    } else {
        format!("<a:rPr lang=\"en-US\" sz=\"{size}\" b=\"1\">{}</a:rPr>", run_faces(font))
    };
    format!(
        "<c:title><c:tx><c:rich><a:bodyPr rot=\"0\" spcFirstLastPara=\"1\" vertOverflow=\"ellipsis\" vert=\"horz\" wrap=\"square\" anchor=\"ctr\" anchorCtr=\"1\"/>\
         <a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{size}\" b=\"1\">\
         <a:solidFill><a:srgbClr val=\"171717\"/></a:solidFill>{}</a:defRPr></a:pPr>\
         <a:r>{run_properties}<a:t>{}</a:t></a:r></a:p></c:rich></c:tx>\
         <c:overlay val=\"0\"/></c:title><c:autoTitleDeleted val=\"0\"/>",
        run_faces(font),
        xml_encode(text)
    )
}

/// The cells a chart cites: `{ sheet, category, names[], values[] }`; a part left empty is the default.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChartReferences<'a> {
    pub sheet: &'a str,
    pub category: &'a str,
    pub names: &'a [String],
    pub values: &'a [String],
}

/// Dated categories: their serials and the cells' date format, written as a number reference Excel reads in that format.
#[derive(Debug, Clone, Copy)]
pub struct CategoryDates<'a> {
    pub values: &'a [Value],
    pub format: &'a str,
}

/// The arguments of [`chart_xml`] (`chartXml({ ... })`; `Default` holds Node's defaults, `text` the worksheet's).
#[derive(Debug, Clone)]
pub struct ChartSpec<'a> {
    /// A family name; empty is `column`.
    pub chart_type: &'a str,
    pub title: &'a str,
    pub categories: &'a [Value],
    pub series: &'a [Value],
    pub references: Option<ChartReferences<'a>>,
    pub show_values: bool,
    pub data_label_position: &'a str,
    pub data_label_color: &'a str,
    pub value_number_format: &'a str,
    pub show_legend: Option<bool>,
    pub zero_baseline: Option<bool>,
    /// How the chart's axes were set up when it already exists (`hideCategoryAxis`, `hideValueAxis`, `min`, `max`,
    /// `gridlines`, `categoryOrientation`): a data refresh keeps the hidden axis, the zoomed range and the gridline decision
    /// the deck was approved with instead of redrawing a default chart around new numbers.
    pub axis: Option<&'a Value>,
    pub external_data_id: &'a str,
    /// The face every text in the chart takes by default. A worksheet chart names its workbook's.
    pub font: &'a str,
    pub text: ChartText,
    pub category_dates: Option<CategoryDates<'a>>,
}

impl Default for ChartSpec<'_> {
    fn default() -> Self {
        Self {
            chart_type: "column",
            title: "",
            categories: &[],
            series: &[],
            references: None,
            show_values: false,
            data_label_position: "",
            data_label_color: "",
            value_number_format: "",
            show_legend: None,
            zero_baseline: None,
            axis: None,
            external_data_id: "",
            font: "",
            text: SHEET_CHART_TEXT,
            category_dates: None,
        }
    }
}

/// `axis?.<name> === true`.
fn axis_flag(axis: Option<&Value>, name: &str) -> bool {
    axis.and_then(|axis| axis.get(name)).and_then(Value::as_bool) == Some(true)
}

/// `axis?.<name> ?? null`, as the text `${value}` writes.
fn axis_limit(axis: Option<&Value>, name: &str) -> Option<String> {
    axis.and_then(|axis| axis.get(name)).filter(|value| !value.is_null()).map(value_to_string)
}

/// `chartXml(spec)`: the chart part's text.
pub fn chart_xml(spec: &ChartSpec<'_>) -> Result<String, String> {
    let Some(family) = resolve_chart_family(spec.chart_type) else {
        return Err(format!("Unsupported chartType: {}. Use one of: {}", spec.chart_type, supported_chart_types().join(", ")));
    };
    let text = spec.text;
    let rows: Vec<String> = spec.categories.iter().map(string_of).collect();
    let entries: Vec<&Value> = spec.series.iter().filter(|entry| entry.get("values").is_some_and(Value::is_array)).collect();
    if entries.is_empty() {
        return Err("add_chart requires at least one series with values".to_owned());
    }
    // A loss reaches below the zero line: pinning the axis at 0 drew the "-8" column as nothing.
    let negative = entries.iter().any(|entry| entry.get("values").and_then(Value::as_array).is_some_and(|values| values.iter().any(|value| to_number(value) < 0.0)));
    // A bar or column says "this much" by its length, so its axis starts at zero unless the caller deliberately zooms in; a
    // line reads as a path and keeps the range that shows its movement.
    let baseline = !negative
        && match spec.zero_baseline {
            None => family.element == "barChart" || family.element == "areaChart",
            Some(flag) => flag,
        };
    // The order the categories read in: a bar chart lists them top-down, unless the chart being rebuilt was authored the
    // other way, which it keeps as PowerPoint's refresh keeps it.
    let orientation = spec.axis.and_then(|axis| axis.get("categoryOrientation")).filter(|value| truthy(value));
    let reversed = match orientation {
        Some(value) => value.as_str() == Some("maxMin"),
        None => family.direction == Some("bar"),
    };
    let references = spec.references.unwrap_or_default();
    let sheet = if references.sheet.is_empty() { "Sheet1" } else { references.sheet };
    let last_row = rows.len() + 1;
    let category_formula =
        if references.category.is_empty() { format!("{sheet}!$A$2:$A${last_row}") } else { references.category.to_owned() };
    let mut plots = String::new();
    for (index, entry) in entries.iter().enumerate() {
        let column = column_label((index + 2) as f64);
        let name_formula = match references.names.get(index).filter(|name| !name.is_empty()) {
            Some(name) => name.clone(),
            None => format!("{sheet}!${column}$1"),
        };
        let value_formula = match references.values.get(index).filter(|name| !name.is_empty()) {
            Some(name) => name.clone(),
            None => format!("{sheet}!${column}$2:${column}${last_row}"),
        };
        let own_format = entry.get("numberFormat").filter(|value| truthy(value)).map(value_to_string);
        let number_format = own_format.as_deref().unwrap_or(spec.value_number_format);
        let name = match entry.get("name").filter(|name| !name.is_null()) {
            Some(name) => value_to_string(name),
            None => format!("Series {}", index + 1),
        };
        let color = match entry.get("color").filter(|color| truthy(color)) {
            Some(color) => color.clone(),
            None => Value::from(DEFAULT_SERIES_COLORS[index % DEFAULT_SERIES_COLORS.len()]),
        };
        let point_colors = point_colors_for(&family, entry, &rows);
        let values = entry.get("values").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        plots.push_str(&format!(
            "<c:ser><c:idx val=\"{index}\"/><c:order val=\"{index}\"/><c:tx>{}</c:tx>",
            string_reference(&name_formula, &[name])
        ));
        plots.push_str(&series_shape(&family, &color));
        // A line is the line, as Microsoft Excel and PowerPoint draw chartType 'line': left to the reader's default a 21-day
        // series carried a diamond on every day and read as a dotted band.
        if family.element == "lineChart" {
            plots.push_str("<c:marker><c:symbol val=\"none\"/></c:marker>");
        }
        if family.element == "barChart" {
            plots.push_str("<c:invertIfNegative val=\"0\"/>");
        }
        plots.push_str(&data_point_shapes(&family, point_colors.as_deref()));
        plots.push_str(&data_labels(&LabelOptions {
            show_values: spec.show_values,
            position: spec.data_label_position,
            color: spec.data_label_color,
            number_format,
            family: &family,
            size: text.label,
            point_colors: point_colors.as_deref(),
        }));
        let categories = match &spec.category_dates {
            Some(dates) => number_reference(&category_formula, dates.values, dates.format),
            None => string_reference(&category_formula, &rows),
        };
        plots.push_str(&format!("<c:cat>{categories}</c:cat><c:val>{}</c:val>", number_reference(&value_formula, values, number_format)));
        if family.element == "lineChart" {
            plots.push_str("<c:smooth val=\"0\"/>");
        }
        plots.push_str("</c:ser>");
    }
    let grouping = match family.element {
        "barChart" => format!("<c:grouping val=\"{}\"/>", family.grouping.unwrap_or("clustered")),
        "lineChart" | "areaChart" => format!("<c:grouping val=\"{}\"/>", family.grouping.unwrap_or("standard")),
        _ => String::new(),
    };
    let gap_width = if family.stacked() { 60 } else { 90 };
    let mut plot = format!("<c:{}>", family.element);
    if let Some(direction) = family.direction {
        plot.push_str(&format!("<c:barDir val=\"{direction}\"/>"));
    }
    plot.push_str(&grouping);
    // A pie or doughnut varies its colours by point, so its legend lists the slices; left at 0, LibreOffice's legend named
    // the one series instead of the categories.
    plot.push_str(&format!("<c:varyColors val=\"{}\"/>", u8::from(family.slices())));
    plot.push_str(&plots);
    if family.element == "barChart" {
        plot.push_str(&format!("<c:gapWidth val=\"{gap_width}\"/>"));
        plot.push_str(if family.stacked() { "<c:overlap val=\"100\"/>" } else { "<c:overlap val=\"-20\"/>" });
    }
    // A ring states its hole: without holeSize PowerPoint drew the doughnut as a full pie.
    if family.element == "doughnutChart" {
        plot.push_str("<c:firstSliceAng val=\"0\"/><c:holeSize val=\"55\"/>");
    }
    if family.axes {
        plot.push_str(&format!("<c:axId val=\"{CATEGORY_AXIS_ID}\"/><c:axId val=\"{VALUE_AXIS_ID}\"/>"));
    }
    plot.push_str(&format!("</c:{}>", family.element));
    // A pie or doughnut is its categories, and its value labels do not name them: it keeps a legend by default, where one
    // series of bars or a line does without.
    let legend = if spec.show_legend == Some(false) || (spec.show_legend.is_none() && entries.len() < 2 && !family.slices()) {
        String::new()
    } else {
        format!(
            "<c:legend><c:legendPos val=\"b\"/><c:overlay val=\"0\"/>\
             <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"{}\"/></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>\
             </c:legend>",
            text.body
        )
    };
    let horizontal = family.direction == Some("bar");
    let axes = if family.axes {
        let date_format = spec.category_dates.as_ref().map_or("", |dates| dates.format);
        format!(
            "{}{}",
            category_axis(&CategoryAxis {
                hidden: axis_flag(spec.axis, "hideCategoryAxis"),
                horizontal,
                reversed,
                size: text.body,
                low: negative,
                number_format: date_format,
            }),
            value_axis(&ValueAxis {
                size: text.body,
                horizontal,
                reversed,
                number_format: spec.value_number_format,
                zero_baseline: baseline,
                hidden: axis_flag(spec.axis, "hideValueAxis"),
                min: axis_limit(spec.axis, "min"),
                max: axis_limit(spec.axis, "max"),
                gridlines: spec.axis.and_then(|axis| axis.get("gridlines")).and_then(Value::as_bool) != Some(false),
            })
        )
    } else {
        String::new()
    };
    let default_face = if spec.font.is_empty() {
        String::new()
    } else {
        format!(
            "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr>{}</a:defRPr></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>",
            run_faces(spec.font)
        )
    };
    let external = if spec.external_data_id.is_empty() {
        String::new()
    } else {
        format!("<c:externalData r:id=\"{}\"><c:autoUpdate val=\"0\"/></c:externalData>", spec.external_data_id)
    };
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
         <c:chartSpace xmlns:c=\"{CHART_NAMESPACE}\" xmlns:a=\"{DRAWING_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\">\
         <c:roundedCorners val=\"0\"/><c:chart>{}<c:plotArea><c:layout/>{plot}{axes}\
         <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>{legend}\
         <c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart>\
         <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>{default_face}{external}</c:chartSpace>",
        chart_title(spec.title, spec.font, text.title)
    ))
}

/// `chartWorkbookRows(categories, series)`: the header row (a blank corner and each series' name) and one row per category
/// (its label and each series' number there, or `""` where it is not a finite number).
pub fn chart_workbook_rows(categories: &[Value], series: &[Value]) -> Vec<Vec<Value>> {
    let mut header = vec![Value::from("")];
    for (index, entry) in series.iter().enumerate() {
        header.push(match entry.get("name").filter(|name| !name.is_null()) {
            Some(name) => name.clone(),
            None => Value::from(format!("Series {}", index + 1)),
        });
    }
    let mut rows = vec![header];
    for (row_index, category) in categories.iter().enumerate() {
        let mut row = vec![Value::from(string_of(category))];
        for entry in series {
            let value = entry.get("values").and_then(|values| values.get(row_index)).map_or(f64::NAN, to_number);
            row.push(if value.is_finite() { json_number(value) } else { Value::from("") });
        }
        rows.push(row);
    }
    rows
}
