//! A chart: what `slide.addChart(type, data, options)` of pptxgenjs 4.0.1 keeps (`addChartDefinition`: the defaults and
//! the corrections it applies to the options) and the parts it writes for it (`makeXmlCharts`, `makeChartType`,
//! `makeCatAxis`, `makeValAxis`, `genXmlTitle`): `ppt/charts/chart<n>.xml`, its relationships, the embedded workbook
//! (`chart_workbook`) and the `p:graphicFrame` the slide holds.
//!
//! The kinds the HTML route and the kit draw are carried: area, bar and column (clustered, stacked, percent stacked),
//! line, pie, doughnut, radar and scatter, each with series, categories (several label levels included), both axes
//! (titles, scaling, units, tick marks, labels, number formats, the axis line), data labels, a data table, the legend,
//! colours, shadows, borders and the manual layout. Not carried: the 3D bar, the bubble chart and a combo chart of
//! several types with a secondary axis. A series past the colour list takes a random colour for its marker, as it
//! does in pptxgenjs (`Math.random`).

use mixdog_js::math;

use super::chart_workbook::{column_name, workbook_bytes};
use super::shapes::{Fill, color_element, color_selection, color_selection_of};
use super::{Axis, Dim, Layout, encode_xml_entities, num, rotation_value, round, smart_parse, val_to_pts};

const DEFAULT_FONT_COLOR: &str = "000000";
const DEFAULT_FONT_SIZE: f64 = 12.0;
const DEFAULT_TITLE_FONT_SIZE: f64 = 18.0;
const DEFAULT_BORDER_COLOR: &str = "363636";
const DEFAULT_GRIDLINE_COLOR: &str = "888888";
const AXIS_ID_VALUE: &str = "2094734552";
const AXIS_ID_CATEGORY: &str = "2094734554";
const AXIS_ID_SERIES: &str = "2094734556";
const BAR_COLORS: [&str; 16] = [
    "C0504D", "4F81BD", "9BBB59", "8064A2", "4BACC6", "F79646", "628FC6", "C86360", "C0504D", "4F81BD", "9BBB59", "8064A2", "4BACC6", "F79646", "628FC6",
    "C86360",
];
const PIE_COLORS: [&str; 18] = [
    "5DA5DA", "FAA43A", "60BD68", "F17CB0", "B2912F", "B276B2", "DECF3F", "F15854", "A7A7A7", "5DA5DA", "FAA43A", "60BD68", "F17CB0", "B2912F", "B276B2",
    "DECF3F", "F15854", "A7A7A7",
];

/// The chart types (`CHART_TYPE`) this writer carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartKind {
    Area,
    Bar,
    Doughnut,
    Line,
    Pie,
    Radar,
    Scatter,
}

impl ChartKind {
    /// The name of the type, which `c:<name>Chart` is spelled from.
    pub fn name(self) -> &'static str {
        match self {
            ChartKind::Area => "area",
            ChartKind::Bar => "bar",
            ChartKind::Doughnut => "doughnut",
            ChartKind::Line => "line",
            ChartKind::Pie => "pie",
            ChartKind::Radar => "radar",
            ChartKind::Scatter => "scatter",
        }
    }

    fn is_pie(self) -> bool {
        matches!(self, ChartKind::Pie | ChartKind::Doughnut)
    }
}

/// One series (`IOptsChartData`): its name, the label groups of its categories (one group per level; a scatter chart
/// gives the labels of its points in the first group) and its values. A value that is absent or NaN is an empty point.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartData {
    pub name: String,
    pub labels: Vec<Vec<String>>,
    pub values: Vec<Option<f64>>,
}

/// `OptsChartGridLine`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GridLine {
    pub size: Option<f64>,
    pub color: Option<String>,
    pub style: Option<String>,
    pub cap: Option<String>,
}

/// `ShadowProps` of a chart: blur and offset in points, the angle in degrees, the opacity 0-1.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartShadow {
    pub kind: Option<String>,
    pub color: Option<String>,
    pub blur: Option<f64>,
    pub offset: Option<f64>,
    pub angle: Option<f64>,
    pub opacity: Option<f64>,
    pub rotate_with_shape: Option<bool>,
}

/// A border of the plot area, the chart area or the data points: its width in points and its colour.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartBorder {
    pub pt: Option<f64>,
    pub color: Option<String>,
}

/// `plotArea`: its border and its fill.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlotArea {
    pub border: Option<ChartBorder>,
    pub fill: Option<Fill>,
}

/// `chartArea`: its border, its fill and whether the corners are rounded (they are unless it says otherwise).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartArea {
    pub border: Option<ChartBorder>,
    pub fill: Option<Fill>,
    pub rounded_corners: Option<bool>,
}

/// `layout`: the inner plot area as fractions (0-1) of the chart; a value outside 0-1 is dropped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartLayout {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

/// `titlePos`: where the title is put, in inches from the chart's corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TitlePos {
    pub x: f64,
    pub y: f64,
}

/// Where an axis crosses the other: a value on it (a number) or a named place (`autoZero`, `min`, `max`).
#[derive(Debug, Clone, PartialEq)]
pub enum AxisCrossing {
    At(f64),
    Mode(String),
}

/// What an axis of a chart is given (the `catAxis*` or the `valAxis*` options of one axis).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AxisStyle {
    pub hidden: bool,
    pub orientation: Option<String>,
    pub max_val: Option<f64>,
    pub min_val: Option<f64>,
    pub show_title: bool,
    pub title: Option<String>,
    pub title_color: Option<String>,
    pub title_font_face: Option<String>,
    pub title_font_size: Option<f64>,
    pub title_rotate: Option<f64>,
    pub major_tick_mark: Option<String>,
    pub minor_tick_mark: Option<String>,
    pub label_pos: Option<String>,
    /// `<axis>AxisLineShow`: the line is drawn unless this is `false`.
    pub line_show: Option<bool>,
    pub line_size: Option<f64>,
    pub line_color: Option<String>,
    pub line_style: Option<String>,
    pub label_rotate: Option<f64>,
    pub label_font_size: Option<f64>,
    pub label_bold: bool,
    pub label_italic: bool,
    pub label_color: Option<String>,
    pub label_font_face: Option<String>,
}

/// What `addChart` is given as its options (`IChartOpts`). Unset is `undefined`; a boolean is `false` when unset.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChartOptions {
    pub x: Option<Dim>,
    pub y: Option<Dim>,
    pub w: Option<Dim>,
    pub h: Option<Dim>,
    pub object_name: Option<String>,
    pub alt_text: Option<String>,
    pub lang: Option<String>,
    // bars
    pub bar_dir: Option<String>,
    pub bar_grouping: Option<String>,
    pub bar_gap_width_pct: Option<f64>,
    pub bar_overlap_pct: Option<f64>,
    // title
    pub show_title: bool,
    pub title: Option<String>,
    pub title_color: Option<String>,
    pub title_font_face: Option<String>,
    pub title_font_size: Option<f64>,
    pub title_align: Option<String>,
    pub title_bold: bool,
    pub title_pos: Option<TitlePos>,
    pub title_rotate: Option<f64>,
    // legend
    pub show_legend: bool,
    pub legend_pos: Option<String>,
    pub legend_font_face: Option<String>,
    pub legend_font_size: Option<f64>,
    pub legend_color: Option<String>,
    // data labels
    pub show_value: bool,
    pub show_label: bool,
    pub show_percent: bool,
    pub show_ser_name: bool,
    pub show_leader_lines: bool,
    pub data_label_position: Option<String>,
    pub data_label_bkgrd_colors: bool,
    pub data_label_format_code: Option<String>,
    pub data_label_format_scatter: Option<String>,
    pub data_label_color: Option<String>,
    pub data_label_font_face: Option<String>,
    pub data_label_font_size: Option<f64>,
    pub data_label_font_bold: bool,
    pub data_label_font_italic: bool,
    // lines and markers
    pub line_size: Option<f64>,
    pub line_cap: Option<String>,
    pub line_dash: Option<String>,
    pub line_smooth: bool,
    pub line_data_symbol: Option<String>,
    pub line_data_symbol_size: Option<f64>,
    pub line_data_symbol_line_size: Option<f64>,
    pub line_data_symbol_line_color: Option<String>,
    pub radar_style: Option<String>,
    pub display_blanks_as: Option<String>,
    // colours and areas
    pub chart_colors: Option<Vec<String>>,
    pub chart_colors_opacity: Option<f64>,
    pub inverted_colors: Option<Vec<String>>,
    pub shadow: Option<ChartShadow>,
    /// `border` (deprecated: the plot area's border, and it wins over `plot_area.border`).
    pub border: Option<ChartBorder>,
    /// `fill` (deprecated: the plot area's fill colour, and it wins over `plot_area.fill.color`).
    pub fill: Option<String>,
    pub plot_area: PlotArea,
    pub chart_area: ChartArea,
    pub data_border: Option<ChartBorder>,
    pub data_no_effects: bool,
    pub layout: Option<ChartLayout>,
    // data table
    pub show_data_table: bool,
    pub show_data_table_horz_border: bool,
    pub show_data_table_vert_border: bool,
    pub show_data_table_outline: bool,
    pub show_data_table_keys: bool,
    pub data_table_font_size: Option<f64>,
    pub data_table_format_code: Option<String>,
    // pie
    pub first_slice_ang: Option<f64>,
    pub hole_size: Option<f64>,
    // axes
    pub cat_axis: AxisStyle,
    pub val_axis: AxisStyle,
    pub cat_grid_line: Option<GridLine>,
    pub val_grid_line: Option<GridLine>,
    pub cat_label_format_code: Option<String>,
    pub cat_axis_label_frequency: Option<f64>,
    pub cat_axis_base_time_unit: Option<String>,
    pub cat_axis_major_time_unit: Option<String>,
    pub cat_axis_minor_time_unit: Option<String>,
    pub cat_axis_major_unit: Option<f64>,
    pub cat_axis_minor_unit: Option<f64>,
    pub cat_axis_multi_level_labels: bool,
    /// `catAxisCrossesAt`: where the value axis crosses the category axis.
    pub cat_axis_crosses_at: Option<AxisCrossing>,
    /// `valAxisCrossesAt`: where the category axis crosses the value axis.
    pub val_axis_crosses_at: Option<AxisCrossing>,
    pub val_axis_log_scale_base: Option<f64>,
    pub val_axis_major_unit: Option<f64>,
    pub val_axis_label_format_code: Option<String>,
    pub val_axis_display_unit: Option<String>,
    pub val_axis_display_unit_label: bool,
    pub val_label_format_code: Option<String>,
}

/// A chart of a slide (`ISlideRelChart` with its slide object): the options as `addChartDefinition` kept them.
#[derive(Debug, Clone, PartialEq)]
pub struct Chart {
    kind: ChartKind,
    data: Vec<ChartData>,
    options: ChartOptions,
    colors: Vec<String>,
    colors_given: bool,
    id: usize,
    rid: usize,
    object_name: String,
}

/// `value || fallback` for a string.
fn text_or<'a>(value: &'a Option<String>, fallback: &'a str) -> &'a str {
    value.as_deref().filter(|text| !text.is_empty()).unwrap_or(fallback)
}

/// A string option that is set (not empty).
fn set_text(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

/// A number option that is truthy (not 0, not NaN).
fn truthy(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value != 0.0 && !value.is_nan())
}

/// `value || value === 0`: a number option that is not NaN.
fn present(value: Option<f64>) -> Option<f64> {
    value.filter(|value| !value.is_nan())
}

/// `Math.round(points * 100)`, the `sz` of a font size.
fn size_hundredths(points: f64) -> String {
    num(round(points * 100.0))
}

fn flag(on: bool) -> &'static str {
    if on { "1" } else { "0" }
}

/// The text of a value in a cache: `value || value === 0 ? value : ''`.
fn point_text(value: Option<f64>) -> String {
    present(value).map_or_else(String::new, num)
}

/// `createLineCap`.
fn line_cap(cap: Option<&str>) -> Result<&'static str, String> {
    match cap.filter(|cap| !cap.is_empty()) {
        None | Some("flat") => Ok("flat"),
        Some("square") => Ok("sq"),
        Some("round") => Ok("rnd"),
        Some(other) => Err(format!("Invalid chart line cap: {other}")),
    }
}

/// `createShadowElement(options, DEF_SHAPE_SHADOW)`: the chart's shadow over the library's default one.
fn shadow_element(shadow: &Option<ChartShadow>) -> String {
    let Some(shadow) = shadow else { return "<a:effectLst/>".to_owned() };
    let kind = set_text(&shadow.kind).unwrap_or("outer");
    let blur = val_to_pts(shadow.blur.unwrap_or(3.0));
    let offset = val_to_pts(shadow.offset.unwrap_or(23_000.0 / 12_700.0));
    let angle = round(shadow.angle.unwrap_or(90.0) * 60_000.0);
    let color = shadow.color.as_deref().unwrap_or("000000");
    let opacity = round(shadow.opacity.unwrap_or(0.35) * 100_000.0);
    let rotate = flag(shadow.rotate_with_shape.unwrap_or(true));
    format!(
        "<a:effectLst><a:{kind}Shdw sx=\"100000\" sy=\"100000\" kx=\"0\" ky=\"0\"  algn=\"bl\" blurRad=\"{}\" rotWithShape=\"{rotate}\" dist=\"{}\" dir=\"{}\"><a:srgbClr val=\"{color}\"><a:alpha val=\"{}\"/></a:srgbClr></a:{kind}Shdw></a:effectLst>",
        num(blur),
        num(offset),
        num(angle),
        num(opacity)
    )
}

/// `createGridLineElement`.
fn grid_line_element(line: &GridLine) -> Result<String, String> {
    let size = truthy(line.size).unwrap_or(1.0);
    let cap = line_cap(Some(text_or(&line.cap, "flat")))?;
    let mut xml = String::from("<c:majorGridlines>");
    xml.push_str(" <c:spPr>");
    xml.push_str(&format!("  <a:ln w=\"{}\" cap=\"{cap}\">", num(val_to_pts(size))));
    xml.push_str(&format!("  <a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", text_or(&line.color, DEFAULT_GRIDLINE_COLOR)));
    xml.push_str(&format!("   <a:prstDash val=\"{}\"/><a:round/>", text_or(&line.style, "solid")));
    xml.push_str("  </a:ln>");
    xml.push_str(" </c:spPr>");
    xml.push_str("</c:majorGridlines>");
    Ok(xml)
}

/// `correctGridLineOptions`: an unusable size, style or cap is dropped (pptxgenjs says so on the console).
fn corrected_grid_line(mut line: GridLine) -> GridLine {
    if line.style.as_deref() == Some("none") {
        return line;
    }
    if line.size.is_some_and(|size| size.is_nan() || size <= 0.0) {
        line.size = None;
    }
    if set_text(&line.style).is_some_and(|style| !["solid", "dash", "dot"].contains(&style)) {
        line.style = None;
    }
    if set_text(&line.cap).is_some_and(|cap| !["flat", "square", "round"].contains(&cap)) {
        line.cap = None;
    }
    line
}

/// `correctShadowOptions`.
fn corrected_shadow(mut shadow: ChartShadow) -> ChartShadow {
    if !matches!(shadow.kind.as_deref(), Some("outer" | "inner" | "none")) {
        shadow.kind = Some("outer".to_owned());
    }
    if let Some(angle) = truthy(shadow.angle) {
        let angle = if (0.0..=359.0).contains(&angle) { angle } else { 270.0 };
        shadow.angle = Some(round(angle));
    }
    if let Some(opacity) = truthy(shadow.opacity) {
        shadow.opacity = Some(if (0.0..=1.0).contains(&opacity) { opacity } else { 0.75 });
    }
    if let Some(color) = shadow.color.as_mut().filter(|color| color.starts_with('#')) {
        *color = color.replacen('#', "", 1);
    }
    shadow
}

/// A border with the width and the colour `addChartDefinition` gives one that lacks them.
fn corrected_border(border: ChartBorder, fallback_pt: f64) -> ChartBorder {
    ChartBorder { pt: Some(truthy(border.pt).unwrap_or(fallback_pt)), color: Some(text_or(&border.color, DEFAULT_BORDER_COLOR).to_owned()) }
}

/// Whether a colour is a 6-digit hex or a scheme colour name.
fn is_hex_or_scheme(color: &str) -> bool {
    (color.len() == 6 && color.chars().all(|ch| ch.is_ascii_hexdigit()))
        || ["tx1", "tx2", "bg1", "bg2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].contains(&color)
}

/// `getUuid(format)`: a random hex digit for each `x` and `y`.
fn uuid(format: &str) -> String {
    format
        .chars()
        .map(|ch| match ch {
            'x' | 'y' => {
                let digit = (math::random() * 16.0).floor() as u32;
                let digit = if ch == 'x' { digit } else { (digit & 3) | 8 };
                char::from_digit(digit, 16).unwrap_or('0')
            }
            other => other,
        })
        .collect()
}

/// The checks that keep the writer from indexing what is not there (pptxgenjs throws a TypeError at write time).
fn check_data(kind: ChartKind, data: &[ChartData]) -> Result<(), String> {
    if data.is_empty() {
        return Err(format!("Cannot read properties of undefined (reading '{}')", if kind == ChartKind::Scatter { "values" } else { "labels" }));
    }
    if kind == ChartKind::Scatter {
        return Ok(());
    }
    let drawn = if kind.is_pie() { &data[..1] } else { data };
    if drawn.iter().any(|series| series.labels.is_empty()) {
        return Err("Cannot read properties of undefined (reading 'length')".to_owned());
    }
    Ok(())
}

/// The parts of a title (`genXmlTitle`).
#[derive(Default)]
struct Title<'a> {
    title: &'a str,
    color: Option<&'a str>,
    font_face: Option<&'a str>,
    font_size: Option<f64>,
    align: Option<&'a str>,
    bold: bool,
    pos: Option<TitlePos>,
    rotate: Option<f64>,
}

/// `genXmlTitle`: `chart` is the chart's corner in inches, which a manual title position is added to.
fn title_xml(title: &Title<'_>, chart: (f64, f64)) -> String {
    let align = match title.align {
        Some(align @ ("left" | "right")) => format!("<a:pPr algn=\"{}\">", &align[..1]),
        _ => "<a:pPr>".to_owned(),
    };
    let rotate = match truthy(title.rotate) {
        Some(degrees) => format!("<a:bodyPr rot=\"{}\"/>", num(rotation_value(degrees))),
        None => "<a:bodyPr/>".to_owned(),
    };
    let size = truthy(title.font_size).map_or_else(String::new, |size| format!("sz=\"{}\"", size_hundredths(size)));
    let bold = flag(title.bold);
    let mut layout = "<c:layout/>".to_owned();
    if let Some(pos) = title.pos {
        let spread = |total: f64| {
            let mut value = if total == 0.0 { 0.0 } else { (total * (total / 5.0)) / 10.0 };
            if value >= 1.0 {
                value /= 10.0;
            }
            if value >= 0.1 {
                value /= 10.0;
            }
            value
        };
        layout = format!(
            "<c:layout><c:manualLayout><c:xMode val=\"edge\"/><c:yMode val=\"edge\"/><c:x val=\"{}\"/><c:y val=\"{}\"/></c:manualLayout></c:layout>",
            num(spread(pos.x + chart.0)),
            num(spread(pos.y + chart.1))
        );
    }
    let color = color_element(title.color.filter(|color| !color.is_empty()).unwrap_or(DEFAULT_FONT_COLOR), "");
    let face = title.font_face.filter(|face| !face.is_empty()).unwrap_or("Arial");
    format!(
        "<c:title><c:tx><c:rich>{rotate}<a:lstStyle/><a:p>{align}<a:defRPr {size} b=\"{bold}\" i=\"0\" u=\"none\" strike=\"noStrike\"><a:solidFill>{color}</a:solidFill><a:latin typeface=\"{face}\"/></a:defRPr></a:pPr><a:r><a:rPr {size} b=\"{bold}\" i=\"0\" u=\"none\" strike=\"noStrike\"><a:solidFill>{color}</a:solidFill><a:latin typeface=\"{face}\"/></a:rPr><a:t>{}</a:t></a:r></a:p></c:rich></c:tx>{layout}<c:overlay val=\"0\"/></c:title>",
        encode_xml_entities(title.title)
    )
}

impl Chart {
    /// `addChartDefinition`: the chart the slide adds, with the options the library keeps. `id` is the chart's number in
    /// the deck (`chart<id>.xml`), `rid` its relationship id on the slide and `charts_before` the charts the slide
    /// already holds (the default object name is `Chart <charts_before>`).
    pub fn new(kind: ChartKind, data: Vec<ChartData>, mut options: ChartOptions, id: usize, rid: usize, charts_before: usize) -> Result<Self, String> {
        check_data(kind, &data)?;
        let object_name = set_text(&options.object_name).map_or_else(|| format!("Chart {charts_before}"), encode_xml_entities);
        let colors_given = options.chart_colors.is_some();
        let colors = options.chart_colors.clone().unwrap_or_else(|| {
            let list: &[&str] = if kind.is_pie() { &PIE_COLORS } else { &BAR_COLORS };
            list.iter().map(|color| (*color).to_owned()).collect()
        });
        resolve(kind, &mut options);
        Ok(Self { kind, data, options, colors, colors_given, id, rid, object_name })
    }

    pub fn kind(&self) -> ChartKind {
        self.kind
    }

    /// The relationship id the slide gives the chart.
    pub fn rid(&self) -> usize {
        self.rid
    }

    /// `/ppt/charts/chart<n>.xml`, the target of the slide's relationship and the part's content type override.
    pub fn target(&self) -> String {
        format!("/ppt/charts/chart{}.xml", self.id)
    }

    /// `ppt/charts/_rels/chart<n>.xml.rels`: the relationship to the embedded workbook.
    pub fn rels_xml(&self) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/package\" Target=\"../embeddings/Microsoft_Excel_Worksheet{}.xlsx\"/></Relationships>",
            self.id
        )
    }

    /// The parts the chart adds to the package, in pptxgenjs's order: the workbook, the chart's relationships, the chart.
    pub fn parts(&self) -> Result<Vec<(String, Vec<u8>)>, String> {
        Ok(vec![
            (format!("ppt/embeddings/Microsoft_Excel_Worksheet{}.xlsx", self.id), workbook_bytes(self.kind, &self.data)?),
            (format!("ppt/charts/_rels/chart{}.xml.rels", self.id), self.rels_xml().into_bytes()),
            (format!("ppt/charts/chart{}.xml", self.id), self.xml()?.into_bytes()),
        ])
    }

    /// The `p:graphicFrame` of the chart on its slide (`slideObjectToXml`, chart case); `index` is the object's place
    /// among the slide's objects.
    pub fn frame_xml(&self, index: usize, layout: &Layout) -> String {
        let place = |dim: Option<Dim>, axis: Axis| dim.map_or(0.0, |dim| smart_parse(dim, axis, layout));
        let (x, y) = (place(self.options.x, Axis::X), place(self.options.y, Axis::Y));
        let (cx, cy) = (place(self.options.w, Axis::X), place(self.options.h, Axis::Y));
        let mut xml = String::from("<p:graphicFrame>");
        xml.push_str(" <p:nvGraphicFramePr>");
        xml.push_str(&format!(
            "   <p:cNvPr id=\"{}\" name=\"{}\" descr=\"{}\"/>",
            index + 2,
            self.object_name,
            encode_xml_entities(self.options.alt_text.as_deref().unwrap_or(""))
        ));
        xml.push_str("   <p:cNvGraphicFramePr/>");
        xml.push_str("   <p:nvPr></p:nvPr>");
        xml.push_str(" </p:nvGraphicFramePr>");
        xml.push_str(&format!(" <p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm>", num(x), num(y), num(cx), num(cy)));
        xml.push_str(" <a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">");
        xml.push_str("  <a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\">");
        xml.push_str(&format!("   <c:chart r:id=\"rId{}\" xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"/>", self.rid));
        xml.push_str("  </a:graphicData>");
        xml.push_str(" </a:graphic>");
        xml.push_str("</p:graphicFrame>");
        xml
    }
}

/// The part of `addChartDefinition` that corrects and defaults the options (the colour list and the object name are
/// settled by the caller).
fn resolve(kind: ChartKind, options: &mut ChartOptions) {
    let number_or_one = |dim: Option<Dim>| match dim {
        Some(Dim::Number(value)) if !value.is_nan() => Dim::Number(value),
        _ => Dim::Number(1.0),
    };
    options.x = Some(number_or_one(options.x));
    options.y = Some(number_or_one(options.y));
    options.w = Some(options.w.filter(|dim| dim.truthy()).unwrap_or(Dim::Percent(50.0)));
    options.h = Some(options.h.filter(|dim| dim.truthy()).unwrap_or(Dim::Percent(50.0)));
    if !matches!(options.bar_dir.as_deref(), Some("bar" | "col")) {
        options.bar_dir = Some("col".to_owned());
    }
    let grouping = options.bar_grouping.clone().unwrap_or_default();
    if kind == ChartKind::Area && !["stacked", "standard", "percentStacked"].contains(&grouping.as_str()) {
        options.bar_grouping = Some("standard".to_owned());
    }
    if kind == ChartKind::Bar && !["clustered", "stacked", "percentStacked"].contains(&grouping.as_str()) {
        options.bar_grouping = Some("clustered".to_owned());
    }
    if options.bar_grouping.as_deref().is_some_and(|grouping| grouping.contains("tacked")) && truthy(options.bar_gap_width_pct).is_none() {
        options.bar_gap_width_pct = Some(50.0);
    }
    correct_label_position(kind, options);
    if !matches!(options.legend_pos.as_deref(), Some("b" | "l" | "r" | "t" | "tr")) {
        options.legend_pos = Some("r".to_owned());
    }
    if !matches!(options.line_data_symbol.as_deref(), Some("circle" | "dash" | "diamond" | "dot" | "none" | "square" | "triangle")) {
        options.line_data_symbol = Some("circle".to_owned());
    }
    if !matches!(options.display_blanks_as.as_deref(), Some("gap" | "span")) {
        options.display_blanks_as = Some("span".to_owned());
    }
    if !matches!(options.radar_style.as_deref(), Some("standard" | "marker" | "filled")) {
        options.radar_style = Some("standard".to_owned());
    }
    options.line_data_symbol_size = Some(truthy(options.line_data_symbol_size).unwrap_or(6.0));
    options.line_data_symbol_line_size = Some(val_to_pts(truthy(options.line_data_symbol_line_size).unwrap_or(0.75)));
    if let Some(layout) = options.layout.as_mut() {
        for value in [&mut layout.x, &mut layout.y, &mut layout.w, &mut layout.h] {
            if value.is_none_or(|value| value.is_nan() || !(0.0..=1.0).contains(&value)) {
                *value = None;
            }
        }
    }
    let scatter_line = || GridLine { color: Some("D9D9D9".to_owned()), size: Some(1.0), ..GridLine::default() };
    let cat_line = options
        .cat_grid_line
        .take()
        .unwrap_or_else(|| if kind == ChartKind::Scatter { scatter_line() } else { GridLine { style: Some("none".to_owned()), ..GridLine::default() } });
    let val_line = options.val_grid_line.take().unwrap_or_else(|| if kind == ChartKind::Scatter { scatter_line() } else { GridLine::default() });
    options.cat_grid_line = Some(corrected_grid_line(cat_line));
    options.val_grid_line = Some(corrected_grid_line(val_line));
    options.shadow = options.shadow.take().map(corrected_shadow);
    options.cat_axis.line_show = Some(options.cat_axis.line_show.unwrap_or(true));
    options.val_axis.line_show = Some(options.val_axis.line_show.unwrap_or(true));
    options.bar_gap_width_pct = Some(options.bar_gap_width_pct.filter(|pct| (0.0..=1000.0).contains(pct)).unwrap_or(150.0));
    options.chart_colors_opacity = truthy(options.chart_colors_opacity);
    options.border = options.border.take().map(|border| corrected_border(border, 1.0));
    options.plot_area.border = options.plot_area.border.take().map(|border| corrected_border(border, 1.0));
    if options.border.is_some() {
        options.plot_area.border.clone_from(&options.border);
    }
    let mut fill = options.plot_area.fill.take().unwrap_or_default();
    if let Some(color) = set_text(&options.fill) {
        fill.color = Some(color.to_owned());
    }
    options.plot_area.fill = Some(fill);
    options.chart_area.border = options.chart_area.border.take().map(|border| corrected_border(border, 1.0));
    options.chart_area.rounded_corners = Some(options.chart_area.rounded_corners.unwrap_or(true));
    options.data_border = options.data_border.take().map(|border| {
        let color = set_text(&border.color).map(|color| if is_hex_or_scheme(color) { color.to_owned() } else { "F9F9F9".to_owned() });
        ChartBorder { pt: Some(truthy(border.pt).unwrap_or(0.75)), color }
    });
    if set_text(&options.data_label_format_code).is_none() && kind == ChartKind::Scatter {
        options.data_label_format_code = Some("General".to_owned());
    }
    if set_text(&options.data_label_format_code).is_none() && kind.is_pie() {
        options.data_label_format_code = Some(if options.show_percent { "0%" } else { "General" }.to_owned());
    }
    if set_text(&options.data_label_format_code).is_none() {
        options.data_label_format_code = Some("#,##0".to_owned());
    }
    if set_text(&options.data_label_format_scatter).is_none() && kind == ChartKind::Scatter {
        options.data_label_format_scatter = Some("custom".to_owned());
    }
    options.line_size = Some(options.line_size.unwrap_or(2.0));
    if !matches!(kind, ChartKind::Area | ChartKind::Bar | ChartKind::Line) {
        options.cat_axis_multi_level_labels = false;
    }
}

/// The data label position `addChartDefinition` keeps for the kind: one the kind cannot show is dropped.
fn correct_label_position(kind: ChartKind, options: &mut ChartOptions) {
    if set_text(&options.data_label_position).is_none() {
        return;
    }
    let grouping = options.bar_grouping.clone().unwrap_or_default();
    let allowed = |options: &ChartOptions, list: &[&str]| set_text(&options.data_label_position).is_some_and(|position| list.contains(&position));
    match kind {
        ChartKind::Area | ChartKind::Doughnut | ChartKind::Radar => options.data_label_position = None,
        ChartKind::Pie => {
            if !allowed(options, &["bestFit", "ctr", "inEnd", "outEnd"]) {
                options.data_label_position = None;
            }
        }
        ChartKind::Line | ChartKind::Scatter => {
            if !allowed(options, &["b", "ctr", "l", "r", "t"]) {
                options.data_label_position = None;
            }
        }
        ChartKind::Bar => {
            if !["stacked", "percentStacked"].contains(&grouping.as_str()) && !allowed(options, &["ctr", "inBase", "inEnd"]) {
                options.data_label_position = None;
            }
            if grouping != "clustered" && !allowed(options, &["ctr", "inBase", "inEnd", "outEnd"]) {
                options.data_label_position = None;
            }
        }
    }
}

// the chart part

impl Chart {
    fn point_color(&self, index: usize) -> &str {
        if self.colors.is_empty() { "" } else { &self.colors[index % self.colors.len()] }
    }

    /// `opts.chartColors[idx + 1 > length ? Math.floor(Math.random() * length) : idx]`.
    fn marker_color(&self, index: usize) -> &str {
        let length = self.colors.len();
        let at = if index + 1 > length { (math::random() * length as f64).floor() as usize } else { index };
        self.colors.get(at).map_or("", String::as_str)
    }

    fn colour(color: &str) -> String {
        color_element(color, "")
    }

    fn chart_corner(&self) -> (f64, f64) {
        let value = |dim: Option<Dim>| match dim {
            Some(Dim::Number(value)) => value,
            _ => 1.0,
        };
        (value(self.options.x), value(self.options.y))
    }

    fn lang(&self) -> &str {
        text_or(&self.options.lang, "en-US")
    }

    fn label_format_code(&self) -> String {
        let code = encode_xml_entities(text_or(&self.options.data_label_format_code, ""));
        if code.is_empty() { "General".to_owned() } else { code }
    }

    /// The `a:defRPr` of data label text.
    fn label_run_properties(&self, sz_first: bool) -> String {
        let o = &self.options;
        let size = size_hundredths(truthy(o.data_label_font_size).unwrap_or(DEFAULT_FONT_SIZE));
        let (bold, italic) = (flag(o.data_label_font_bold), flag(o.data_label_font_italic));
        let attributes = if sz_first {
            format!("sz=\"{size}\" b=\"{bold}\" i=\"{italic}\" u=\"none\" strike=\"noStrike\"")
        } else {
            format!("b=\"{bold}\" i=\"{italic}\" strike=\"noStrike\" sz=\"{size}\" u=\"none\"")
        };
        format!(
            "<a:defRPr {attributes}><a:solidFill>{}</a:solidFill><a:latin typeface=\"{}\"/></a:defRPr>",
            Self::colour(text_or(&o.data_label_color, DEFAULT_FONT_COLOR)),
            text_or(&o.data_label_font_face, "Arial")
        )
    }

    /// `makeXmlCharts`: `ppt/charts/chart<n>.xml`.
    pub fn xml(&self) -> Result<String, String> {
        let o = &self.options;
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        xml.push_str("<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">");
        xml.push_str("<c:date1904 val=\"0\"/>");
        xml.push_str(&format!("<c:roundedCorners val=\"{}\"/>", flag(o.chart_area.rounded_corners.unwrap_or(true))));
        xml.push_str("<c:chart>");
        if o.show_title {
            let title = Title {
                title: text_or(&o.title, "Chart Title"),
                color: set_text(&o.title_color),
                font_face: set_text(&o.title_font_face),
                font_size: Some(truthy(o.title_font_size).unwrap_or(DEFAULT_TITLE_FONT_SIZE)),
                align: set_text(&o.title_align),
                bold: o.title_bold,
                pos: o.title_pos,
                rotate: o.title_rotate,
            };
            xml.push_str(&title_xml(&title, self.chart_corner()));
            xml.push_str("<c:autoTitleDeleted val=\"0\"/>");
        } else {
            xml.push_str("<c:autoTitleDeleted val=\"1\"/>");
        }
        xml.push_str("<c:plotArea>");
        if let Some(layout) = &o.layout {
            xml.push_str("<c:layout>");
            xml.push_str(" <c:manualLayout>");
            xml.push_str("  <c:layoutTarget val=\"inner\" />");
            xml.push_str("  <c:xMode val=\"edge\" />");
            xml.push_str("  <c:yMode val=\"edge\" />");
            xml.push_str(&format!("  <c:x val=\"{}\" />", num(truthy(layout.x).unwrap_or(0.0))));
            xml.push_str(&format!("  <c:y val=\"{}\" />", num(truthy(layout.y).unwrap_or(0.0))));
            xml.push_str(&format!("  <c:w val=\"{}\" />", num(truthy(layout.w).unwrap_or(1.0))));
            xml.push_str(&format!("  <c:h val=\"{}\" />", num(truthy(layout.h).unwrap_or(1.0))));
            xml.push_str(" </c:manualLayout>");
            xml.push_str("</c:layout>");
        } else {
            xml.push_str("<c:layout/>");
        }
        match self.kind {
            ChartKind::Scatter => xml.push_str(&self.scatter_chart()?),
            ChartKind::Pie | ChartKind::Doughnut => xml.push_str(&self.pie_chart()),
            _ => xml.push_str(&self.category_chart()?),
        }
        if !self.kind.is_pie() {
            xml.push_str(&self.category_axis()?);
            xml.push_str(&self.value_axis()?);
        }
        if o.show_data_table {
            xml.push_str(&self.data_table());
        }
        xml.push_str("  <c:spPr>");
        match &o.plot_area.fill {
            Some(fill) if set_text(&fill.color).is_some() => xml.push_str(&color_selection(fill)),
            _ => xml.push_str("<a:noFill/>"),
        }
        match &o.plot_area.border {
            Some(border) => xml.push_str(&format!(
                "<a:ln w=\"{}\" cap=\"flat\">{}</a:ln>",
                num(val_to_pts(border.pt.unwrap_or(0.0))),
                color_selection_of(border.color.as_deref().unwrap_or(""))
            )),
            None => xml.push_str("<a:ln><a:noFill/></a:ln>"),
        }
        xml.push_str("    <a:effectLst/>");
        xml.push_str("  </c:spPr>");
        xml.push_str("</c:plotArea>");
        if o.show_legend {
            xml.push_str(&self.legend());
        }
        xml.push_str("  <c:plotVisOnly val=\"1\"/>");
        xml.push_str(&format!("  <c:dispBlanksAs val=\"{}\"/>", text_or(&o.display_blanks_as, "span")));
        if self.kind == ChartKind::Scatter {
            xml.push_str("<c:showDLblsOverMax val=\"1\"/>");
        }
        xml.push_str("</c:chart>");
        xml.push_str("<c:spPr>");
        match &o.chart_area.fill {
            Some(fill) if set_text(&fill.color).is_some() => xml.push_str(&color_selection(fill)),
            _ => xml.push_str("<a:noFill/>"),
        }
        match &o.chart_area.border {
            Some(border) => xml.push_str(&format!(
                "<a:ln w=\"{}\" cap=\"flat\">{}</a:ln>",
                num(val_to_pts(border.pt.unwrap_or(0.0))),
                color_selection_of(border.color.as_deref().unwrap_or(""))
            )),
            None => xml.push_str("<a:ln><a:noFill/></a:ln>"),
        }
        xml.push_str("  <a:effectLst/>");
        xml.push_str("</c:spPr>");
        xml.push_str("<c:externalData r:id=\"rId1\"><c:autoUpdate val=\"0\"/></c:externalData>");
        xml.push_str("</c:chartSpace>");
        Ok(xml)
    }

    fn legend(&self) -> String {
        let o = &self.options;
        let mut xml = String::from("<c:legend>");
        xml.push_str(&format!("<c:legendPos val=\"{}\"/>", text_or(&o.legend_pos, "r")));
        xml.push_str("<c:overlay val=\"0\"/>");
        if set_text(&o.legend_font_face).is_some() || truthy(o.legend_font_size).is_some() || set_text(&o.legend_color).is_some() {
            xml.push_str("<c:txPr>");
            xml.push_str("  <a:bodyPr/>");
            xml.push_str("  <a:lstStyle/>");
            xml.push_str("  <a:p>");
            xml.push_str("    <a:pPr>");
            match truthy(o.legend_font_size) {
                Some(size) => xml.push_str(&format!("<a:defRPr sz=\"{}\">", size_hundredths(size))),
                None => xml.push_str("<a:defRPr>"),
            }
            if let Some(color) = set_text(&o.legend_color) {
                xml.push_str(&color_selection_of(color));
            }
            if let Some(face) = set_text(&o.legend_font_face) {
                xml.push_str(&format!("<a:latin typeface=\"{face}\"/>"));
                xml.push_str(&format!("<a:cs    typeface=\"{face}\"/>"));
            }
            xml.push_str("      </a:defRPr>");
            xml.push_str("    </a:pPr>");
            xml.push_str("    <a:endParaRPr lang=\"en-US\"/>");
            xml.push_str("  </a:p>");
            xml.push_str("</c:txPr>");
        }
        xml.push_str("</c:legend>");
        xml
    }

    fn data_table(&self) -> String {
        let o = &self.options;
        let mut xml = String::from("<c:dTable>");
        xml.push_str(&format!("  <c:showHorzBorder val=\"{}\"/>", flag(o.show_data_table_horz_border)));
        xml.push_str(&format!("  <c:showVertBorder val=\"{}\"/>", flag(o.show_data_table_vert_border)));
        xml.push_str(&format!("  <c:showOutline    val=\"{}\"/>", flag(o.show_data_table_outline)));
        xml.push_str(&format!("  <c:showKeys       val=\"{}\"/>", flag(o.show_data_table_keys)));
        xml.push_str("  <c:spPr>");
        xml.push_str("    <a:noFill/>");
        xml.push_str("    <a:ln w=\"9525\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"tx1\"><a:lumMod val=\"15000\"/><a:lumOff val=\"85000\"/></a:schemeClr></a:solidFill><a:round/></a:ln>");
        xml.push_str("    <a:effectLst/>");
        xml.push_str("  </c:spPr>");
        xml.push_str("  <c:txPr>");
        xml.push_str("   <a:bodyPr rot=\"0\" spcFirstLastPara=\"1\" vertOverflow=\"ellipsis\" vert=\"horz\" wrap=\"square\" anchor=\"ctr\" anchorCtr=\"1\"/>");
        xml.push_str("   <a:lstStyle/>");
        xml.push_str("   <a:p>");
        xml.push_str("     <a:pPr rtl=\"0\">");
        xml.push_str(&format!(
            "       <a:defRPr sz=\"{}\" b=\"0\" i=\"0\" u=\"none\" strike=\"noStrike\" kern=\"1200\" baseline=\"0\">",
            size_hundredths(truthy(o.data_table_font_size).unwrap_or(DEFAULT_FONT_SIZE))
        ));
        xml.push_str("         <a:solidFill><a:schemeClr val=\"tx1\"><a:lumMod val=\"65000\"/><a:lumOff val=\"35000\"/></a:schemeClr></a:solidFill>");
        xml.push_str("         <a:latin typeface=\"+mn-lt\"/>");
        xml.push_str("         <a:ea typeface=\"+mn-ea\"/>");
        xml.push_str("         <a:cs typeface=\"+mn-cs\"/>");
        xml.push_str("       </a:defRPr>");
        xml.push_str("     </a:pPr>");
        xml.push_str("    <a:endParaRPr lang=\"en-US\"/>");
        xml.push_str("   </a:p>");
        xml.push_str(" </c:txPr>");
        xml.push_str("</c:dTable>");
        xml
    }

    /// The fill of a series: nothing for `transparent`, an alpha when `chartColorsOpacity` is set.
    fn series_fill(&self, color: &str) -> String {
        if color == "transparent" {
            "<a:noFill/>".to_owned()
        } else if let Some(opacity) = self.options.chart_colors_opacity {
            format!("<a:solidFill>{}</a:solidFill>", color_element(color, &format!("<a:alpha val=\"{}\"/>", num(round(opacity * 1000.0)))))
        } else {
            format!("<a:solidFill>{}</a:solidFill>", Self::colour(color))
        }
    }

    /// The `a:ln` of a line, radar or scatter series.
    fn series_line(&self, color: &str) -> Result<String, String> {
        let o = &self.options;
        if o.line_size == Some(0.0) {
            return Ok("<a:ln><a:noFill/></a:ln>".to_owned());
        }
        Ok(format!(
            "<a:ln w=\"{}\" cap=\"{}\"><a:solidFill>{}</a:solidFill><a:prstDash val=\"{}\"/><a:round/></a:ln>",
            num(val_to_pts(o.line_size.unwrap_or(2.0))),
            line_cap(o.line_cap.as_deref())?,
            Self::colour(color),
            text_or(&o.line_dash, "solid")
        ))
    }

    /// The `c:marker` of a line, radar or scatter series.
    fn marker(&self, symbol_fill: &str, line_color: &str) -> String {
        let o = &self.options;
        let mut xml = String::from("<c:marker>");
        xml.push_str(&format!("  <c:symbol val=\"{}\"/>", text_or(&o.line_data_symbol, "circle")));
        if let Some(size) = truthy(o.line_data_symbol_size) {
            xml.push_str(&format!("<c:size val=\"{}\"/>", num(size)));
        }
        xml.push_str("  <c:spPr>");
        xml.push_str(&format!("    <a:solidFill>{}</a:solidFill>", Self::colour(symbol_fill)));
        let line_color = set_text(&o.line_data_symbol_line_color).unwrap_or(line_color);
        xml.push_str(&format!(
            "    <a:ln w=\"{}\" cap=\"flat\"><a:solidFill>{}</a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln>",
            num(o.line_data_symbol_line_size.unwrap_or(0.0)),
            Self::colour(line_color)
        ));
        xml.push_str("    <a:effectLst/>");
        xml.push_str("  </c:spPr>");
        xml.push_str("</c:marker>");
        xml
    }

    /// The `c:dLbls` that closes the series of a category or scatter chart (`scatter` leaves out the leader lines).
    fn group_data_labels(&self, scatter: bool) -> String {
        let o = &self.options;
        let mut xml = String::from("  <c:dLbls>");
        xml.push_str(&format!("    <c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", self.label_format_code()));
        xml.push_str("    <c:txPr>");
        xml.push_str("      <a:bodyPr/>");
        xml.push_str("      <a:lstStyle/>");
        xml.push_str(&format!("      <a:p><a:pPr>{}</a:pPr></a:p>", self.label_run_properties(false)));
        xml.push_str("    </c:txPr>");
        if let Some(position) = set_text(&o.data_label_position) {
            xml.push_str(&format!(" <c:dLblPos val=\"{position}\"/>"));
        }
        xml.push_str("    <c:showLegendKey val=\"0\"/>");
        xml.push_str(&format!("    <c:showVal val=\"{}\"/>", flag(o.show_value)));
        xml.push_str("    <c:showCatName val=\"0\"/>");
        xml.push_str(&format!("    <c:showSerName val=\"{}\"/>", flag(o.show_ser_name)));
        xml.push_str("    <c:showPercent val=\"0\"/>");
        xml.push_str("    <c:showBubbleSize val=\"0\"/>");
        if !scatter {
            xml.push_str(&format!("    <c:showLeaderLines val=\"{}\"/>", flag(o.show_leader_lines)));
        }
        xml.push_str("  </c:dLbls>");
        xml
    }

    /// The series of an area, bar, line or radar chart plus the chart's own tail.
    fn category_chart(&self) -> Result<String, String> {
        let o = &self.options;
        let kind = self.kind;
        let grouping = o.bar_grouping.as_deref().unwrap_or("");
        let mut xml = format!("<c:{}Chart>", kind.name());
        if kind == ChartKind::Area && grouping == "stacked" {
            xml.push_str(&format!("<c:grouping val=\"{grouping}\"/>"));
        }
        if kind == ChartKind::Bar {
            xml.push_str(&format!("<c:barDir val=\"{}\"/>", text_or(&o.bar_dir, "col")));
            xml.push_str(&format!("<c:grouping val=\"{}\"/>", if grouping.is_empty() { "clustered" } else { grouping }));
        }
        if kind == ChartKind::Radar {
            xml.push_str(&format!("<c:radarStyle val=\"{}\"/>", text_or(&o.radar_style, "standard")));
        }
        xml.push_str("<c:varyColors val=\"0\"/>");
        for (index, series) in self.data.iter().enumerate() {
            let color = self.point_color(index);
            let labels = series.labels.len();
            let points = series.labels[0].len();
            let value_column = column_name(index + labels + 1);
            xml.push_str("<c:ser>");
            xml.push_str(&format!("  <c:idx val=\"{index}\"/><c:order val=\"{index}\"/>"));
            xml.push_str("  <c:tx>");
            xml.push_str("    <c:strRef>");
            xml.push_str(&format!("      <c:f>Sheet1!${value_column}$1</c:f>"));
            xml.push_str(&format!(
                "      <c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{}</c:v></c:pt></c:strCache>",
                encode_xml_entities(&series.name)
            ));
            xml.push_str("    </c:strRef>");
            xml.push_str("  </c:tx>");
            xml.push_str("  <c:spPr>");
            xml.push_str(&self.series_fill(color));
            if matches!(kind, ChartKind::Line | ChartKind::Radar) {
                xml.push_str(&self.series_line(color)?);
            } else if let Some(border) = &o.data_border {
                xml.push_str(&format!(
                    "<a:ln w=\"{}\" cap=\"{}\"><a:solidFill>{}</a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln>",
                    num(val_to_pts(border.pt.unwrap_or(0.0))),
                    line_cap(o.line_cap.as_deref())?,
                    Self::colour(border.color.as_deref().unwrap_or(""))
                ));
            }
            xml.push_str(&shadow_element(&o.shadow));
            xml.push_str("  </c:spPr>");
            xml.push_str("  <c:invertIfNegative val=\"0\"/>");
            if kind != ChartKind::Radar {
                xml.push_str("<c:dLbls>");
                xml.push_str(&format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", self.label_format_code()));
                if o.data_label_bkgrd_colors {
                    xml.push_str(&format!("<c:spPr><a:solidFill>{}</a:solidFill></c:spPr>", Self::colour(color)));
                }
                xml.push_str(&format!("<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>{}</a:pPr></a:p></c:txPr>", self.label_run_properties(false)));
                if let Some(position) = set_text(&o.data_label_position) {
                    xml.push_str(&format!("<c:dLblPos val=\"{position}\"/>"));
                }
                xml.push_str("<c:showLegendKey val=\"0\"/>");
                xml.push_str(&format!("<c:showVal val=\"{}\"/>", flag(o.show_value)));
                xml.push_str(&format!(
                    "<c:showCatName val=\"0\"/><c:showSerName val=\"{}\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/>",
                    flag(o.show_ser_name)
                ));
                xml.push_str(&format!("<c:showLeaderLines val=\"{}\"/>", flag(o.show_leader_lines)));
                xml.push_str("</c:dLbls>");
            }
            if matches!(kind, ChartKind::Line | ChartKind::Radar) {
                xml.push_str(&self.marker(self.marker_color(index), color));
            }
            if kind == ChartKind::Bar
                && self.data.len() == 1
                && ((self.colors_given && self.colors.len() > 1) || o.inverted_colors.as_ref().is_some_and(|colors| !colors.is_empty()))
            {
                for (position, value) in series.values.iter().enumerate() {
                    let negative = value.is_some_and(|value| value < 0.0);
                    let palette: &[String] = match (&o.inverted_colors, negative) {
                        (Some(inverted), true) => inverted,
                        _ => &self.colors,
                    };
                    let chosen = if palette.is_empty() { "undefined" } else { palette[position % palette.len()].as_str() };
                    xml.push_str("  <c:dPt>");
                    xml.push_str(&format!("    <c:idx val=\"{position}\"/>"));
                    xml.push_str("      <c:invertIfNegative val=\"0\"/>");
                    xml.push_str("    <c:bubble3D val=\"0\"/>");
                    xml.push_str("    <c:spPr>");
                    if o.line_size == Some(0.0) {
                        xml.push_str("<a:ln><a:noFill/></a:ln>");
                    } else {
                        xml.push_str("<a:solidFill>");
                        xml.push_str(&format!("  <a:srgbClr val=\"{chosen}\"/>"));
                        xml.push_str("</a:solidFill>");
                    }
                    xml.push_str(&shadow_element(&o.shadow));
                    xml.push_str("    </c:spPr>");
                    xml.push_str("  </c:dPt>");
                }
            }
            xml.push_str("<c:cat>");
            if let Some(code) = set_text(&o.cat_label_format_code) {
                xml.push_str("  <c:numRef>");
                xml.push_str(&format!("    <c:f>Sheet1!$A$2:$A${}</c:f>", points + 1));
                xml.push_str("    <c:numCache>");
                xml.push_str(&format!("      <c:formatCode>{code}</c:formatCode>"));
                xml.push_str(&format!("      <c:ptCount val=\"{points}\"/>"));
                for (position, label) in series.labels[0].iter().enumerate() {
                    xml.push_str(&format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", encode_xml_entities(label)));
                }
                xml.push_str("    </c:numCache>");
                xml.push_str("  </c:numRef>");
            } else {
                xml.push_str("  <c:multiLvlStrRef>");
                xml.push_str(&format!("    <c:f>Sheet1!$A$2:${}${}</c:f>", column_name(labels), points + 1));
                xml.push_str("    <c:multiLvlStrCache>");
                xml.push_str(&format!("      <c:ptCount val=\"{points}\"/>"));
                for group in &series.labels {
                    xml.push_str("<c:lvl>");
                    for (position, label) in group.iter().enumerate() {
                        xml.push_str(&format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", encode_xml_entities(label)));
                    }
                    xml.push_str("</c:lvl>");
                }
                xml.push_str("    </c:multiLvlStrCache>");
                xml.push_str("  </c:multiLvlStrRef>");
            }
            xml.push_str("</c:cat>");
            xml.push_str("<c:val>");
            xml.push_str("  <c:numRef>");
            xml.push_str(&format!("<c:f>Sheet1!${value_column}$2:${value_column}${}</c:f>", points + 1));
            xml.push_str("    <c:numCache>");
            let value_format = set_text(&o.val_label_format_code).or(set_text(&o.data_table_format_code)).unwrap_or("General");
            xml.push_str(&format!("      <c:formatCode>{value_format}</c:formatCode>"));
            xml.push_str(&format!("      <c:ptCount val=\"{points}\"/>"));
            for (position, value) in series.values.iter().enumerate() {
                xml.push_str(&format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", point_text(*value)));
            }
            xml.push_str("    </c:numCache>");
            xml.push_str("  </c:numRef>");
            xml.push_str("</c:val>");
            if kind == ChartKind::Line {
                xml.push_str(&format!("<c:smooth val=\"{}\"/>", flag(o.line_smooth)));
            }
            xml.push_str("</c:ser>");
        }
        xml.push_str(&self.group_data_labels(false));
        if kind == ChartKind::Bar {
            xml.push_str(&format!("  <c:gapWidth val=\"{}\"/>", num(o.bar_gap_width_pct.unwrap_or(150.0))));
            let overlap = if grouping.contains("tacked") { 100.0 } else { truthy(o.bar_overlap_pct).unwrap_or(0.0) };
            xml.push_str(&format!("  <c:overlap val=\"{}\"/>", num(overlap)));
        } else if kind == ChartKind::Line {
            xml.push_str("  <c:marker val=\"1\"/>");
        }
        xml.push_str(&format!("<c:axId val=\"{AXIS_ID_CATEGORY}\"/><c:axId val=\"{AXIS_ID_VALUE}\"/><c:axId val=\"{AXIS_ID_SERIES}\"/>"));
        xml.push_str(&format!("</c:{}Chart>", kind.name()));
        Ok(xml)
    }

    /// The scatter chart: one series per Y column, the X column shared.
    fn scatter_chart(&self) -> Result<String, String> {
        let o = &self.options;
        let x = &self.data[0];
        let mut xml = String::from("<c:scatterChart>");
        xml.push_str("<c:scatterStyle val=\"lineMarker\"/>");
        xml.push_str("<c:varyColors val=\"0\"/>");
        for (index, series) in self.data.iter().skip(1).enumerate() {
            let color = self.point_color(index);
            xml.push_str("<c:ser>");
            xml.push_str(&format!("  <c:idx val=\"{index}\"/>"));
            xml.push_str(&format!("  <c:order val=\"{index}\"/>"));
            xml.push_str("  <c:tx>");
            xml.push_str("    <c:strRef>");
            xml.push_str(&format!("      <c:f>Sheet1!${}$1</c:f>", column_name(index + 2)));
            xml.push_str(&format!(
                "      <c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{}</c:v></c:pt></c:strCache>",
                encode_xml_entities(&series.name)
            ));
            xml.push_str("    </c:strRef>");
            xml.push_str("  </c:tx>");
            xml.push_str("  <c:spPr>");
            xml.push_str(&self.series_fill(color));
            xml.push_str(&self.series_line(color)?);
            xml.push_str(&shadow_element(&o.shadow));
            xml.push_str("  </c:spPr>");
            xml.push_str(&self.marker(self.marker_color(index), color));
            if o.show_label {
                xml.push_str(&self.scatter_labels(series)?);
            }
            xml.push_str("<c:xVal>");
            xml.push_str("  <c:numRef>");
            xml.push_str(&format!("    <c:f>Sheet1!$A$2:$A${}</c:f>", x.values.len() + 1));
            xml.push_str("    <c:numCache>");
            xml.push_str("      <c:formatCode>General</c:formatCode>");
            xml.push_str(&format!("      <c:ptCount val=\"{}\"/>", x.values.len()));
            for (position, value) in x.values.iter().enumerate() {
                xml.push_str(&format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", point_text(*value)));
            }
            xml.push_str("    </c:numCache>");
            xml.push_str("  </c:numRef>");
            xml.push_str("</c:xVal>");
            let column = column_name(index + 2);
            xml.push_str("<c:yVal>");
            xml.push_str("  <c:numRef>");
            xml.push_str(&format!("    <c:f>Sheet1!${column}$2:${column}${}</c:f>", x.values.len() + 1));
            xml.push_str("    <c:numCache>");
            xml.push_str("      <c:formatCode>General</c:formatCode>");
            xml.push_str(&format!("      <c:ptCount val=\"{}\"/>", x.values.len()));
            for position in 0..x.values.len() {
                xml.push_str(&format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", point_text(series.values.get(position).copied().flatten())));
            }
            xml.push_str("    </c:numCache>");
            xml.push_str("  </c:numRef>");
            xml.push_str("</c:yVal>");
            xml.push_str(&format!("<c:smooth val=\"{}\"/>", flag(o.line_smooth)));
            xml.push_str("</c:ser>");
        }
        xml.push_str(&self.group_data_labels(true));
        xml.push_str(&format!("<c:axId val=\"{AXIS_ID_CATEGORY}\"/><c:axId val=\"{AXIS_ID_VALUE}\"/>"));
        xml.push_str("</c:scatterChart>");
        Ok(xml)
    }

    /// The labels of the points of a scatter series (`showLabel`): the text of each point, with or without its X and Y
    /// values, or the chart's own X and Y labels.
    fn scatter_labels(&self, series: &ChartData) -> Result<String, String> {
        let o = &self.options;
        let format = o.data_label_format_scatter.as_deref().unwrap_or("");
        let chart_uuid = uuid("-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
        let lang = self.lang();
        let mut xml = String::new();
        if format == "custom" || format == "customXY" {
            let Some(labels) = series.labels.first() else {
                return Err("Cannot read properties of undefined (reading '0')".to_owned());
            };
            xml.push_str("<c:dLbls>");
            for (position, label) in labels.iter().enumerate() {
                xml.push_str("  <c:dLbl>");
                xml.push_str(&format!("    <c:idx val=\"{position}\"/>"));
                xml.push_str("    <c:tx>");
                xml.push_str("      <c:rich>");
                xml.push_str("            <a:bodyPr>");
                xml.push_str("                <a:spAutoFit/>");
                xml.push_str("            </a:bodyPr>");
                xml.push_str("            <a:lstStyle/>");
                xml.push_str("            <a:p>");
                xml.push_str("                <a:pPr>");
                xml.push_str("                    <a:defRPr/>");
                xml.push_str("                </a:pPr>");
                xml.push_str("              <a:r>");
                xml.push_str(&format!("                    <a:rPr lang=\"{lang}\" dirty=\"0\"/>"));
                xml.push_str(&format!("                    <a:t>{}</a:t>", encode_xml_entities(label)));
                xml.push_str("              </a:r>");
                if format == "customXY" && !label.chars().all(|ch| ch == ' ') {
                    let name = encode_xml_entities(&series.name);
                    xml.push_str("              <a:r>");
                    xml.push_str(&format!("                  <a:rPr lang=\"{lang}\" baseline=\"0\" dirty=\"0\"/>"));
                    xml.push_str("                  <a:t> (</a:t>");
                    xml.push_str("              </a:r>");
                    xml.push_str(&format!("              <a:fld id=\"{{{}}}\" type=\"XVALUE\">", uuid("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")));
                    xml.push_str(&format!("                  <a:rPr lang=\"{lang}\" baseline=\"0\"/>"));
                    xml.push_str("                  <a:pPr>");
                    xml.push_str("                      <a:defRPr/>");
                    xml.push_str("                  </a:pPr>");
                    xml.push_str(&format!("                  <a:t>[{name}</a:t>"));
                    xml.push_str("              </a:fld>");
                    xml.push_str("              <a:r>");
                    xml.push_str(&format!("                  <a:rPr lang=\"{lang}\" baseline=\"0\" dirty=\"0\"/>"));
                    xml.push_str("                  <a:t>, </a:t>");
                    xml.push_str("              </a:r>");
                    xml.push_str(&format!("              <a:fld id=\"{{{}}}\" type=\"YVALUE\">", uuid("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")));
                    xml.push_str(&format!("                  <a:rPr lang=\"{lang}\" baseline=\"0\"/>"));
                    xml.push_str("                  <a:pPr>");
                    xml.push_str("                      <a:defRPr/>");
                    xml.push_str("                  </a:pPr>");
                    xml.push_str(&format!("                  <a:t>[{name}]</a:t>"));
                    xml.push_str("              </a:fld>");
                    xml.push_str("              <a:r>");
                    xml.push_str(&format!("                  <a:rPr lang=\"{lang}\" baseline=\"0\" dirty=\"0\"/>"));
                    xml.push_str("                  <a:t>)</a:t>");
                    xml.push_str("              </a:r>");
                    xml.push_str(&format!("              <a:endParaRPr lang=\"{lang}\" dirty=\"0\"/>"));
                }
                xml.push_str("            </a:p>");
                xml.push_str("      </c:rich>");
                xml.push_str("    </c:tx>");
                xml.push_str("    <c:spPr>");
                xml.push_str("        <a:noFill/>");
                xml.push_str("        <a:ln>");
                xml.push_str("            <a:noFill/>");
                xml.push_str("        </a:ln>");
                xml.push_str("        <a:effectLst/>");
                xml.push_str("    </c:spPr>");
                if let Some(position) = set_text(&o.data_label_position) {
                    xml.push_str(&format!(" <c:dLblPos val=\"{position}\"/>"));
                }
                xml.push_str("    <c:showLegendKey val=\"0\"/>");
                xml.push_str("    <c:showVal val=\"0\"/>");
                xml.push_str("    <c:showCatName val=\"0\"/>");
                xml.push_str("    <c:showSerName val=\"0\"/>");
                xml.push_str("    <c:showPercent val=\"0\"/>");
                xml.push_str("    <c:showBubbleSize val=\"0\"/>");
                xml.push_str("       <c:showLeaderLines val=\"1\"/>");
                xml.push_str("    <c:extLst>");
                xml.push_str(
                    "      <c:ext uri=\"{CE6537A1-D6FC-4f65-9D91-7224C49458BB}\" xmlns:c15=\"http://schemas.microsoft.com/office/drawing/2012/chart\"/>",
                );
                xml.push_str(
                    "      <c:ext uri=\"{C3380CC4-5D6E-409C-BE32-E72D297353CC}\" xmlns:c16=\"http://schemas.microsoft.com/office/drawing/2014/chart\">",
                );
                let unique = position + 1;
                let padding = &"00000000"[..8 - unique.to_string().len().min(8)];
                xml.push_str(&format!("            <c16:uniqueId val=\"{{{padding}{unique}{chart_uuid}}}\"/>"));
                xml.push_str("      </c:ext>");
                xml.push_str("        </c:extLst>");
                xml.push_str("</c:dLbl>");
            }
            xml.push_str("</c:dLbls>");
        }
        if format == "XY" {
            xml.push_str("<c:dLbls>");
            xml.push_str("    <c:spPr>");
            xml.push_str("        <a:noFill/>");
            xml.push_str("        <a:ln>");
            xml.push_str("            <a:noFill/>");
            xml.push_str("        </a:ln>");
            xml.push_str("          <a:effectLst/>");
            xml.push_str("    </c:spPr>");
            xml.push_str("    <c:txPr>");
            xml.push_str("        <a:bodyPr>");
            xml.push_str("            <a:spAutoFit/>");
            xml.push_str("        </a:bodyPr>");
            xml.push_str("        <a:lstStyle/>");
            xml.push_str("        <a:p>");
            xml.push_str("            <a:pPr>");
            xml.push_str("                <a:defRPr/>");
            xml.push_str("            </a:pPr>");
            xml.push_str("            <a:endParaRPr lang=\"en-US\"/>");
            xml.push_str("        </a:p>");
            xml.push_str("    </c:txPr>");
            if let Some(position) = set_text(&o.data_label_position) {
                xml.push_str(&format!(" <c:dLblPos val=\"{position}\"/>"));
            }
            xml.push_str("    <c:showLegendKey val=\"0\"/>");
            xml.push_str(&format!(" <c:showVal val=\"{}\"/>", flag(o.show_label)));
            xml.push_str(&format!(" <c:showCatName val=\"{}\"/>", flag(o.show_label)));
            xml.push_str(&format!(" <c:showSerName val=\"{}\"/>", flag(o.show_ser_name)));
            xml.push_str("    <c:showPercent val=\"0\"/>");
            xml.push_str("    <c:showBubbleSize val=\"0\"/>");
            xml.push_str("    <c:extLst>");
            xml.push_str("        <c:ext uri=\"{CE6537A1-D6FC-4f65-9D91-7224C49458BB}\" xmlns:c15=\"http://schemas.microsoft.com/office/drawing/2012/chart\">");
            xml.push_str("            <c15:showLeaderLines val=\"1\"/>");
            xml.push_str("        </c:ext>");
            xml.push_str("    </c:extLst>");
            xml.push_str("</c:dLbls>");
        }
        Ok(xml)
    }

    /// The pie or doughnut chart: one series, a point and a label per category.
    fn pie_chart(&self) -> String {
        let o = &self.options;
        let kind = self.kind;
        let series = &self.data[0];
        let points = series.labels[0].len();
        let mut xml = format!("<c:{}Chart>", kind.name());
        xml.push_str("  <c:varyColors val=\"1\"/>");
        xml.push_str("<c:ser>");
        xml.push_str("  <c:idx val=\"0\"/>");
        xml.push_str("  <c:order val=\"0\"/>");
        xml.push_str("  <c:tx>");
        xml.push_str("    <c:strRef>");
        xml.push_str("      <c:f>Sheet1!$B$1</c:f>");
        xml.push_str("      <c:strCache>");
        xml.push_str("        <c:ptCount val=\"1\"/>");
        xml.push_str(&format!("        <c:pt idx=\"0\"><c:v>{}</c:v></c:pt>", encode_xml_entities(&series.name)));
        xml.push_str("      </c:strCache>");
        xml.push_str("    </c:strRef>");
        xml.push_str("  </c:tx>");
        xml.push_str("  <c:spPr>");
        xml.push_str("    <a:solidFill><a:schemeClr val=\"accent1\"/></a:solidFill>");
        xml.push_str("    <a:ln w=\"9525\" cap=\"flat\"><a:solidFill><a:srgbClr val=\"F9F9F9\"/></a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln>");
        if o.data_no_effects {
            xml.push_str("<a:effectLst/>");
        } else {
            xml.push_str(&shadow_element(&o.shadow));
        }
        xml.push_str("  </c:spPr>");
        for index in 0..points {
            xml.push_str("<c:dPt>");
            xml.push_str(&format!(" <c:idx val=\"{index}\"/>"));
            xml.push_str(" <c:bubble3D val=\"0\"/>");
            xml.push_str(" <c:spPr>");
            xml.push_str(&format!("<a:solidFill>{}</a:solidFill>", Self::colour(self.marker_color(index))));
            if let Some(border) = &o.data_border {
                xml.push_str(&format!(
                    "<a:ln w=\"{}\" cap=\"flat\"><a:solidFill>{}</a:solidFill><a:prstDash val=\"solid\"/><a:round/></a:ln>",
                    num(val_to_pts(border.pt.unwrap_or(0.0))),
                    Self::colour(border.color.as_deref().unwrap_or(""))
                ));
            }
            xml.push_str(&shadow_element(&o.shadow));
            xml.push_str("  </c:spPr>");
            xml.push_str("</c:dPt>");
        }
        xml.push_str("<c:dLbls>");
        for index in 0..points {
            xml.push_str("<c:dLbl>");
            xml.push_str(&format!(" <c:idx val=\"{index}\"/>"));
            xml.push_str(&format!("  <c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", self.label_format_code()));
            xml.push_str("  <c:spPr/><c:txPr>");
            xml.push_str("   <a:bodyPr/><a:lstStyle/>");
            xml.push_str(&format!("   <a:p><a:pPr>{}</a:pPr></a:p>", self.label_run_properties(true)));
            xml.push_str("    </c:txPr>");
            if kind == ChartKind::Pie {
                if let Some(position) = set_text(&o.data_label_position) {
                    xml.push_str(&format!("<c:dLblPos val=\"{position}\"/>"));
                }
            }
            xml.push_str("    <c:showLegendKey val=\"0\"/>");
            xml.push_str(&format!("    <c:showVal val=\"{}\"/>", flag(o.show_value)));
            xml.push_str(&format!("    <c:showCatName val=\"{}\"/>", flag(o.show_label)));
            xml.push_str(&format!("    <c:showSerName val=\"{}\"/>", flag(o.show_ser_name)));
            xml.push_str(&format!("    <c:showPercent val=\"{}\"/>", flag(o.show_percent)));
            xml.push_str("    <c:showBubbleSize val=\"0\"/>");
            xml.push_str("  </c:dLbl>");
        }
        xml.push_str(&format!(" <c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", self.label_format_code()));
        xml.push_str("    <c:txPr>");
        xml.push_str("      <a:bodyPr/>");
        xml.push_str("      <a:lstStyle/>");
        xml.push_str("      <a:p>");
        xml.push_str("        <a:pPr>");
        xml.push_str(&format!(
            "          <a:defRPr sz=\"1800\" b=\"{}\" i=\"{}\" u=\"none\" strike=\"noStrike\">",
            flag(o.data_label_font_bold),
            flag(o.data_label_font_italic)
        ));
        xml.push_str("            <a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill><a:latin typeface=\"Arial\"/>");
        xml.push_str("          </a:defRPr>");
        xml.push_str("        </a:pPr>");
        xml.push_str("      </a:p>");
        xml.push_str("    </c:txPr>");
        if kind == ChartKind::Pie {
            xml.push_str("<c:dLblPos val=\"ctr\"/>");
        }
        xml.push_str("    <c:showLegendKey val=\"0\"/>");
        xml.push_str("    <c:showVal val=\"0\"/>");
        xml.push_str("    <c:showCatName val=\"1\"/>");
        xml.push_str("    <c:showSerName val=\"0\"/>");
        xml.push_str("    <c:showPercent val=\"1\"/>");
        xml.push_str("    <c:showBubbleSize val=\"0\"/>");
        xml.push_str(&format!(" <c:showLeaderLines val=\"{}\"/>", flag(o.show_leader_lines)));
        xml.push_str("</c:dLbls>");
        xml.push_str("<c:cat>");
        xml.push_str("  <c:strRef>");
        xml.push_str(&format!("    <c:f>Sheet1!$A$2:$A${}</c:f>", points + 1));
        xml.push_str("    <c:strCache>");
        xml.push_str(&format!("         <c:ptCount val=\"{points}\"/>"));
        for (index, label) in series.labels[0].iter().enumerate() {
            xml.push_str(&format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", encode_xml_entities(label)));
        }
        xml.push_str("    </c:strCache>");
        xml.push_str("  </c:strRef>");
        xml.push_str("</c:cat>");
        xml.push_str("  <c:val>");
        xml.push_str("    <c:numRef>");
        xml.push_str(&format!("      <c:f>Sheet1!$B$2:$B${}</c:f>", points + 1));
        xml.push_str("      <c:numCache>");
        xml.push_str(&format!("           <c:ptCount val=\"{points}\"/>"));
        for (index, value) in series.values.iter().enumerate() {
            xml.push_str(&format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", point_text(*value)));
        }
        xml.push_str("      </c:numCache>");
        xml.push_str("    </c:numRef>");
        xml.push_str("  </c:val>");
        xml.push_str("  </c:ser>");
        let angle = truthy(o.first_slice_ang).map_or(0.0, round);
        xml.push_str(&format!("  <c:firstSliceAng val=\"{}\"/>", num(angle)));
        if kind == ChartKind::Doughnut {
            xml.push_str(&format!("<c:holeSize val=\"{}\"/>", o.hole_size.map_or_else(|| "50".to_owned(), num)));
        }
        xml.push_str(&format!("</c:{}Chart>", kind.name()));
        xml
    }

    /// `a:ln` and the text properties an axis shares: the line of the axis and the properties of its labels.
    fn axis_look(&self, style: &AxisStyle) -> String {
        let mut xml = String::from(" <c:spPr>");
        let width = truthy(style.line_size).map_or(12_700.0, val_to_pts);
        xml.push_str(&format!("   <a:ln w=\"{}\" cap=\"flat\">", num(width)));
        if style.line_show == Some(false) {
            xml.push_str("<a:noFill/>");
        } else {
            xml.push_str(&format!("<a:solidFill>{}</a:solidFill>", Self::colour(text_or(&style.line_color, DEFAULT_GRIDLINE_COLOR))));
        }
        xml.push_str(&format!("     <a:prstDash val=\"{}\"/>", text_or(&style.line_style, "solid")));
        xml.push_str("     <a:round/>");
        xml.push_str("   </a:ln>");
        xml.push_str(" </c:spPr>");
        xml.push_str(" <c:txPr>");
        match truthy(style.label_rotate) {
            Some(degrees) => xml.push_str(&format!("<a:bodyPr rot=\"{}\"/>", num(rotation_value(degrees)))),
            None => xml.push_str("<a:bodyPr/>"),
        }
        xml.push_str("  <a:lstStyle/>");
        xml.push_str("  <a:p>");
        xml.push_str("    <a:pPr>");
        xml.push_str(&format!(
            "      <a:defRPr sz=\"{}\" b=\"{}\" i=\"{}\" u=\"none\" strike=\"noStrike\">",
            size_hundredths(truthy(style.label_font_size).unwrap_or(DEFAULT_FONT_SIZE)),
            flag(style.label_bold),
            flag(style.label_italic)
        ));
        xml.push_str(&format!("        <a:solidFill>{}</a:solidFill>", Self::colour(text_or(&style.label_color, DEFAULT_FONT_COLOR))));
        xml.push_str(&format!("        <a:latin typeface=\"{}\"/>", text_or(&style.label_font_face, "Arial")));
        xml.push_str("      </a:defRPr>");
        xml.push_str("    </a:pPr>");
        xml.push_str(&format!("  <a:endParaRPr lang=\"{}\"/>", self.lang()));
        xml.push_str("  </a:p>");
        xml.push_str(" </c:txPr>");
        xml
    }

    fn axis_title(&self, style: &AxisStyle) -> String {
        let title = Title {
            title: text_or(&style.title, "Axis Title"),
            color: set_text(&style.title_color),
            font_face: set_text(&style.title_font_face),
            font_size: style.title_font_size,
            rotate: style.title_rotate,
            ..Title::default()
        };
        title_xml(&title, (f64::NAN, f64::NAN))
    }

    /// `<c:max>` and `<c:min>` of an axis's scaling.
    fn scaling_limits(style: &AxisStyle) -> String {
        let mut xml = String::new();
        if let Some(max) = present(style.max_val) {
            xml.push_str(&format!("<c:max val=\"{}\"/>", num(max)));
        }
        if let Some(min) = present(style.min_val) {
            xml.push_str(&format!("<c:min val=\"{}\"/>", num(min)));
        }
        xml
    }

    /// `makeCatAxis`: the category axis (a scatter chart's X axis is a value axis).
    fn category_axis(&self) -> Result<String, String> {
        let o = &self.options;
        let style = &o.cat_axis;
        let scatter = self.kind == ChartKind::Scatter;
        let date = set_text(&o.cat_label_format_code).is_some();
        let tag = if scatter {
            "valAx"
        } else if date {
            "dateAx"
        } else {
            "catAx"
        };
        let column = text_or(&o.bar_dir, "col") == "col";
        let mut xml = format!("<c:{tag}>");
        xml.push_str(&format!("  <c:axId val=\"{AXIS_ID_CATEGORY}\"/>"));
        xml.push_str("  <c:scaling>");
        xml.push_str(&format!("<c:orientation val=\"{}\"/>", text_or(&style.orientation, "minMax")));
        xml.push_str(&Self::scaling_limits(style));
        xml.push_str("</c:scaling>");
        xml.push_str(&format!("  <c:delete val=\"{}\"/>", flag(style.hidden)));
        xml.push_str(&format!("  <c:axPos val=\"{}\"/>", if column { "b" } else { "l" }));
        if let Some(line) = o.cat_grid_line.as_ref().filter(|line| line.style.as_deref() != Some("none")) {
            xml.push_str(&grid_line_element(line)?);
        }
        if style.show_title {
            xml.push_str(&self.axis_title(style));
        }
        if scatter {
            xml.push_str(&format!(
                "  <c:numFmt formatCode=\"{}\" sourceLinked=\"1\"/>",
                if set_text(&o.val_axis_label_format_code).is_some() {
                    encode_xml_entities(text_or(&o.val_axis_label_format_code, ""))
                } else {
                    "General".to_owned()
                }
            ));
            xml.push_str("  <c:majorTickMark val=\"none\"/>");
            xml.push_str("  <c:minorTickMark val=\"none\"/>");
            xml.push_str("  <c:tickLblPos val=\"nextTo\"/>");
        } else {
            let code = encode_xml_entities(text_or(&o.cat_label_format_code, ""));
            xml.push_str(&format!("  <c:numFmt formatCode=\"{}\" sourceLinked=\"1\"/>", if code.is_empty() { "General" } else { code.as_str() }));
            xml.push_str(&format!("  <c:majorTickMark val=\"{}\"/>", text_or(&style.major_tick_mark, "out")));
            xml.push_str(&format!("  <c:minorTickMark val=\"{}\"/>", text_or(&style.minor_tick_mark, "none")));
            xml.push_str(&format!("  <c:tickLblPos val=\"{}\"/>", text_or(&style.label_pos, if column { "low" } else { "nextTo" })));
        }
        xml.push_str(&self.axis_look(style));
        xml.push_str(&format!(" <c:crossAx val=\"{AXIS_ID_VALUE}\"/>"));
        match &o.val_axis_crosses_at {
            Some(AxisCrossing::At(at)) => {
                xml.push_str(&format!(" <c:crossesAt val=\"{}\"/>", if truthy(Some(*at)).is_some() { num(*at) } else { "autoZero".to_owned() }))
            }
            Some(AxisCrossing::Mode(mode)) if !mode.is_empty() => xml.push_str(&format!(" <c:crosses val=\"{mode}\"/>")),
            _ => xml.push_str(" <c:crosses val=\"autoZero\"/>"),
        }
        xml.push_str(" <c:auto val=\"1\"/>");
        xml.push_str(" <c:lblAlgn val=\"ctr\"/>");
        xml.push_str(&format!(" <c:noMultiLvlLbl val=\"{}\"/>", if o.cat_axis_multi_level_labels { 0 } else { 1 }));
        if let Some(frequency) = truthy(o.cat_axis_label_frequency) {
            xml.push_str(&format!(" <c:tickLblSkip val=\"{}\"/>", num(frequency)));
        }
        if date || scatter {
            if date {
                let unit = |value: &Option<String>| set_text(value).map(str::to_lowercase).filter(|unit| ["days", "months", "years"].contains(&unit.as_str()));
                if let Some(unit) = unit(&o.cat_axis_base_time_unit) {
                    xml.push_str(&format!("<c:baseTimeUnit val=\"{unit}\"/>"));
                }
                if let Some(unit) = unit(&o.cat_axis_major_time_unit) {
                    xml.push_str(&format!("<c:majorTimeUnit val=\"{unit}\"/>"));
                }
                if let Some(unit) = unit(&o.cat_axis_minor_time_unit) {
                    xml.push_str(&format!("<c:minorTimeUnit val=\"{unit}\"/>"));
                }
            }
            if let Some(unit) = truthy(o.cat_axis_major_unit) {
                xml.push_str(&format!("<c:majorUnit val=\"{}\"/>", num(unit)));
            }
            if let Some(unit) = truthy(o.cat_axis_minor_unit) {
                xml.push_str(&format!("<c:minorUnit val=\"{}\"/>", num(unit)));
            }
        }
        xml.push_str(&format!("</c:{tag}>"));
        Ok(xml)
    }

    /// `makeValAxis`: the primary value axis.
    fn value_axis(&self) -> Result<String, String> {
        let o = &self.options;
        let style = &o.val_axis;
        let scatter = self.kind == ChartKind::Scatter;
        let column = text_or(&o.bar_dir, "col") == "col";
        let position = if column { "l" } else { "b" };
        let mut xml = String::from("<c:valAx>");
        xml.push_str(&format!("  <c:axId val=\"{AXIS_ID_VALUE}\"/>"));
        xml.push_str("  <c:scaling>");
        if let Some(base) = truthy(o.val_axis_log_scale_base) {
            xml.push_str(&format!("<c:logBase val=\"{}\"/>", num(base)));
        }
        xml.push_str(&format!("<c:orientation val=\"{}\"/>", text_or(&style.orientation, "minMax")));
        xml.push_str(&Self::scaling_limits(style));
        xml.push_str("  </c:scaling>");
        xml.push_str(&format!("  <c:delete val=\"{}\"/>", flag(style.hidden)));
        xml.push_str(&format!("  <c:axPos val=\"{position}\"/>"));
        if let Some(line) = o.val_grid_line.as_ref().filter(|line| line.style.as_deref() != Some("none")) {
            xml.push_str(&grid_line_element(line)?);
        }
        if style.show_title {
            xml.push_str(&self.axis_title(style));
        }
        let code = if set_text(&o.val_axis_label_format_code).is_some() {
            encode_xml_entities(text_or(&o.val_axis_label_format_code, ""))
        } else {
            "General".to_owned()
        };
        xml.push_str(&format!("<c:numFmt formatCode=\"{code}\" sourceLinked=\"0\"/>"));
        if scatter {
            xml.push_str("  <c:majorTickMark val=\"none\"/>");
            xml.push_str("  <c:minorTickMark val=\"none\"/>");
            xml.push_str("  <c:tickLblPos val=\"nextTo\"/>");
        } else {
            xml.push_str(&format!(" <c:majorTickMark val=\"{}\"/>", text_or(&style.major_tick_mark, "out")));
            xml.push_str(&format!(" <c:minorTickMark val=\"{}\"/>", text_or(&style.minor_tick_mark, "none")));
            xml.push_str(&format!(" <c:tickLblPos val=\"{}\"/>", text_or(&style.label_pos, if column { "nextTo" } else { "low" })));
        }
        xml.push_str(&self.axis_look(style));
        xml.push_str(&format!(" <c:crossAx val=\"{AXIS_ID_CATEGORY}\"/>"));
        match &o.cat_axis_crosses_at {
            Some(AxisCrossing::At(at)) => xml.push_str(&format!(" <c:crossesAt val=\"{}\"/>", num(*at))),
            Some(AxisCrossing::Mode(mode)) => xml.push_str(&format!(" <c:crosses val=\"{mode}\"/>")),
            None => xml.push_str(" <c:crosses val=\"autoZero\"/>"),
        }
        xml.push_str(&format!(" <c:crossBetween val=\"{}\"/>", if scatter { "midCat" } else { "between" }));
        if let Some(unit) = truthy(o.val_axis_major_unit) {
            xml.push_str(&format!(" <c:majorUnit val=\"{}\"/>", num(unit)));
        }
        if let Some(unit) = set_text(&o.val_axis_display_unit) {
            xml.push_str(&format!(
                "<c:dispUnits><c:builtInUnit val=\"{unit}\"/>{}</c:dispUnits>",
                if o.val_axis_display_unit_label { "<c:dispUnitsLbl/>" } else { "" }
            ));
        }
        xml.push_str("</c:valAx>");
        Ok(xml)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        Layout { name: "screen16x9".to_owned(), width: 9_144_000.0, height: 5_143_500.0 }
    }

    fn months(name: &str, values: &[f64]) -> ChartData {
        ChartData {
            name: name.to_owned(),
            labels: vec![["Jan", "Feb", "Mar"].iter().map(|label| (*label).to_owned()).collect()],
            values: values.iter().map(|value| Some(*value)).collect(),
        }
    }

    fn bar(options: ChartOptions) -> Chart {
        Chart::new(ChartKind::Bar, vec![months("North", &[1.0, 2.0, 3.0]), months("South", &[4.0, 5.0, 6.0])], options, 1, 1, 0).expect("a chart")
    }

    #[test]
    fn a_column_chart_takes_the_defaults_of_the_library() {
        let chart = bar(ChartOptions::default());
        let xml = chart.xml().expect("the chart part");
        assert!(xml.contains("<c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>"));
        assert!(xml.contains("<c:gapWidth val=\"150\"/>  <c:overlap val=\"0\"/>"));
        assert!(xml.contains("<c:autoTitleDeleted val=\"1\"/>"));
        assert!(xml.contains("<c:roundedCorners val=\"1\"/>"));
        assert!(!xml.contains("<c:legendPos"), "no legend unless asked for");
        assert!(xml.contains("<c:axId val=\"2094734554\"/><c:axId val=\"2094734552\"/><c:axId val=\"2094734556\"/>"));
        let frame = chart.frame_xml(0, &layout());
        assert!(frame.contains("name=\"Chart 0\" descr=\"\""));
        assert!(
            frame.contains("<a:off x=\"914400\" y=\"914400\"/><a:ext cx=\"4572000\" cy=\"2571750\"/>"),
            "a position of one inch, a size of half the slide: {frame}"
        );
        assert!(frame.contains("r:id=\"rId1\""));
    }

    #[test]
    fn a_stacked_chart_overlaps_completely_and_narrows_its_gap() {
        let xml = bar(ChartOptions { bar_grouping: Some("stacked".to_owned()), ..ChartOptions::default() }).xml().expect("the chart part");
        assert!(xml.contains("<c:grouping val=\"stacked\"/>"));
        assert!(xml.contains("<c:gapWidth val=\"50\"/>  <c:overlap val=\"100\"/>"));
    }

    #[test]
    fn a_label_position_the_kind_cannot_show_is_dropped() {
        let kept =
            bar(ChartOptions { show_value: true, data_label_position: Some("inEnd".to_owned()), ..ChartOptions::default() }).xml().expect("the chart part");
        assert!(kept.contains("<c:dLblPos val=\"inEnd\"/>"));
        let dropped =
            bar(ChartOptions { show_value: true, data_label_position: Some("outEnd".to_owned()), ..ChartOptions::default() }).xml().expect("the chart part");
        assert!(!dropped.contains("<c:dLblPos"), "outEnd is not for a clustered column");
    }

    #[test]
    fn a_pie_labels_its_slices_in_percent_when_asked_to() {
        let data =
            vec![ChartData { name: "Status".to_owned(), labels: vec![vec!["Red".to_owned(), "Green".to_owned()]], values: vec![Some(10.0), Some(20.0)] }];
        let plain = Chart::new(ChartKind::Pie, data.clone(), ChartOptions::default(), 1, 1, 0).expect("a pie").xml().expect("the chart part");
        assert!(plain.contains("<c:numFmt formatCode=\"General\" sourceLinked=\"0\"/>"));
        assert!(plain.contains("<c:firstSliceAng val=\"0\"/>"));
        let percent = Chart::new(ChartKind::Doughnut, data, ChartOptions { show_percent: true, ..ChartOptions::default() }, 2, 1, 0)
            .expect("a doughnut")
            .xml()
            .expect("the chart part");
        assert!(percent.contains("<c:numFmt formatCode=\"0%\" sourceLinked=\"0\"/>"));
        assert!(percent.contains("<c:holeSize val=\"50\"/>"));
        assert!(!percent.contains("<c:catAx>"), "a pie has no axes");
    }

    #[test]
    fn a_chart_gets_its_parts_in_the_order_of_the_library() {
        let chart = bar(ChartOptions::default());
        let parts = chart.parts().expect("the parts");
        let names: Vec<&str> = parts.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx", "ppt/charts/_rels/chart1.xml.rels", "ppt/charts/chart1.xml"]);
        assert_eq!(chart.target(), "/ppt/charts/chart1.xml");
    }

    #[test]
    fn an_object_name_is_encoded_and_the_alt_text_too() {
        let chart = bar(ChartOptions { object_name: Some("A <b>".to_owned()), alt_text: Some("say \"hi\"".to_owned()), ..ChartOptions::default() });
        let frame = chart.frame_xml(3, &layout());
        assert!(frame.contains("<p:cNvPr id=\"5\" name=\"A &lt;b&gt;\" descr=\"say &quot;hi&quot;\"/>"));
    }

    #[test]
    fn a_line_cap_the_library_does_not_know_fails_the_write_and_a_missing_label_list_fails_the_chart() {
        let line = Chart::new(
            ChartKind::Line,
            vec![months("A", &[1.0, 2.0, 3.0])],
            ChartOptions { line_cap: Some("triangle".to_owned()), ..ChartOptions::default() },
            1,
            1,
            0,
        )
        .expect("a line chart");
        assert_eq!(line.xml().err().as_deref(), Some("Invalid chart line cap: triangle"));
        let bare = ChartData { name: "A".to_owned(), labels: Vec::new(), values: vec![Some(1.0)] };
        assert_eq!(
            Chart::new(ChartKind::Bar, vec![bare], ChartOptions::default(), 1, 1, 0).err().as_deref(),
            Some("Cannot read properties of undefined (reading 'length')")
        );
    }

    #[test]
    fn a_manual_layout_keeps_only_the_fractions_between_zero_and_one() {
        let options = ChartOptions { layout: Some(ChartLayout { x: Some(0.1), y: Some(7.0), w: None, h: Some(0.5) }), ..ChartOptions::default() };
        let xml = Chart::new(ChartKind::Line, vec![months("A", &[1.0, 2.0, 3.0])], options, 1, 1, 0).expect("a line chart").xml().expect("the chart part");
        assert!(xml.contains("<c:x val=\"0.1\" />"));
        assert!(xml.contains("<c:y val=\"0\" />"), "a fraction over one is dropped and reads as zero");
        assert!(xml.contains("<c:w val=\"1\" />"));
        assert!(xml.contains("<c:h val=\"0.5\" />"));
    }
}
