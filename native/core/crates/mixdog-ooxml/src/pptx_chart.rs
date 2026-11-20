//! `portable/portable-pptx-chart.mjs`: chart parts of a presentation: finding the part a chart frame points at, reading how an
//! existing chart presents itself (so a refresh keeps the treatment the deck was approved with), detecting its type and
//! writing new numbers into it with the workbook it cites.

use mixdog_js::{json_number, string_to_number, to_number, value_to_string};
use serde_json::{Map, Value, json};

use crate::blank::chart_workbook;
use crate::opc::{
    CHART_CONTENT_TYPE, PACKAGE_RELATIONSHIP_NS, WORKBOOK_CONTENT_TYPE, ensure_content_type_override, ensure_default_content_type, part_relationship_path,
    posix, relationship_map, relationship_target,
};
use crate::pptx_package::{SlideRef, slide_path};
use crate::slide_shapes::{SLIDE_SHAPE_TAGS, num, replace_first_text, to_emu};
use crate::xml::{OFFICE_RELATIONSHIP_BASE, XML_HEADER, compiled, container_inner, top_level_elements, xml_decode, xml_encode};
use crate::zipio::Package;

/// `LABEL_POSITION_CODES`: the word a caller writes for a data label position and the code the chart stores.
pub const LABEL_POSITION_CODES: [(&str, &str); 6] =
    [("inside_end", "inEnd"), ("inside_base", "inBase"), ("outside_end", "outEnd"), ("center", "ctr"), ("centre", "ctr"), ("best_fit", "bestFit")];

/// The word `LABEL_POSITION_NAMES` gives a code (the last word that names it).
fn label_position_name(code: &str) -> &'static str {
    LABEL_POSITION_CODES.iter().rev().find(|(_, stored)| *stored == code).map_or("", |(name, _)| *name)
}

fn matched(pattern: &str, text: &str) -> String {
    compiled(pattern, "").find(text).map(|found| text[found].to_owned()).unwrap_or_default()
}

fn group(pattern: &str, text: &str) -> Option<String> {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

fn blocks(pattern: &str, text: &str) -> Vec<String> {
    compiled(pattern, "g").find_iter(text).map(|found| text[found].to_owned()).collect()
}

/// `readChartPresentation(xml)`: how an existing chart presents itself: labels, number format, legend, base line, and the
/// series fills. New numbers must not silently strip the treatment the deck was approved with, so a refresh reads these and
/// keeps them unless the caller asks for something else.
pub fn read_chart_presentation(xml: &str) -> Value {
    let labels = matched(r"<c:dLbls>[\s\S]*?</c:dLbls>", xml);
    let value_axis = matched(r"<c:valAx>[\s\S]*?</c:valAx>", xml);
    let category_axis = matched(r"<c:catAx>[\s\S]*?</c:catAx>", xml);
    let code = group(r#"<c:dLblPos val="([^"]+)"/>"#, &labels).unwrap_or_default();
    let scale = |pattern: &str| -> Value {
        let value = group(pattern, &value_axis).map_or(f64::NAN, |text| string_to_number(&text));
        if value.is_finite() { json_number(value) } else { Value::Null }
    };
    let series_blocks = blocks(r"<c:ser>[\s\S]*?</c:ser>", xml);
    // The axis is part of the reading, not scaffolding: a hidden axis, a zoomed range, and gridlines off are how the approved
    // chart says what it says.
    let axis = json!({
        "hideValueAxis": compiled(r#"<c:delete val="1"/>"#, "").is_match(&value_axis),
        "hideCategoryAxis": compiled(r#"<c:delete val="1"/>"#, "").is_match(&category_axis),
        "min": scale(r#"<c:min val="([^"]+)"/>"#),
        "max": scale(r#"<c:max val="([^"]+)"/>"#),
        "gridlines": compiled(r"<c:majorGridlines", "").is_match(&value_axis),
        // The order the categories read in: a bar chart authored bottom-up (PowerPoint's default) stays so.
        "categoryOrientation": group(r#"<c:orientation val="(minMax|maxMin)"/>"#, &category_axis).unwrap_or_default(),
    });
    // The emphasized point (an accent bar, one highlighted slice) is per point, not per series: rewriting the series alone
    // flattens the chart's message.
    let point_colors: Vec<Value> = series_blocks
        .iter()
        .map(|series| {
            let mut colors: Vec<Value> = Vec::new();
            for point in blocks(r"<c:dPt>[\s\S]*?</c:dPt>", series) {
                let index = group(r#"<c:idx val="(\d+)"/>"#, &point).map_or(f64::NAN, |text| string_to_number(&text));
                let color = group(r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#, &point).unwrap_or_default();
                // A hole in the list reads back as null, as the array JavaScript fills sparsely does; an index past
                // sixteen million is not a point of any chart and is left out rather than allocated.
                if index.is_finite() && index.fract() == 0.0 && index < 16_000_000.0 && !color.is_empty() {
                    let at = index as usize;
                    if colors.len() <= at {
                        colors.resize(at + 1, Value::Null);
                    }
                    colors[at] = Value::String(color);
                }
            }
            Value::Array(colors)
        })
        .collect();
    // The series' own label colour, not a slice's: each slice label carries the ink its slice can hold.
    let own_labels = compiled(r"<c:dLbl>[\s\S]*?</c:dLbl>", "g").replace_all_with(&labels, |_| String::new());
    let mut presentation = Map::new();
    presentation.insert("axis".to_owned(), axis);
    presentation.insert("pointColors".to_owned(), Value::Array(point_colors));
    presentation.insert("showValues".to_owned(), Value::Bool(compiled(r#"<c:showVal val="1"/>"#, "").is_match(&labels)));
    presentation.insert("dataLabelPosition".to_owned(), Value::from(label_position_name(&code)));
    presentation
        .insert("dataLabelColor".to_owned(), Value::String(group(r#"<c:txPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})""#, &own_labels).unwrap_or_default()));
    presentation
        .insert("valueNumberFormat".to_owned(), Value::String(xml_decode(&group(r#"<c:numFmt formatCode="([^"]*)""#, &value_axis).unwrap_or_default())));
    presentation.insert("zeroBaseline".to_owned(), Value::Bool(compiled(r#"<c:min val="0"/>"#, "").is_match(&value_axis)));
    presentation.insert("showLegend".to_owned(), Value::Bool(compiled(r"<c:legend>", "").is_match(xml)));
    presentation.insert(
        "seriesColors".to_owned(),
        Value::Array(
            series_blocks
                .iter()
                .map(|series| Value::String(group(r#"<c:spPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})""#, series).unwrap_or_default()))
                .collect(),
        ),
    );
    // A template's chart names its series colours from the theme (accent1, accent2); the caller resolves them through the
    // deck's theme, or a rebuilt chart fell back to the default palette.
    presentation.insert(
        "seriesSchemeColors".to_owned(),
        Value::Array(
            series_blocks
                .iter()
                .map(|series| Value::String(group(r#"<c:spPr>[\s\S]*?<a:schemeClr val="([A-Za-z0-9]+)""#, series).unwrap_or_default()))
                .collect(),
        ),
    );
    Value::Object(presentation)
}

/// `chartFrameXml({ id, relationshipId, left, top, width, height })`: the graphic frame that places a chart on a slide.
pub fn chart_frame_xml(options: &Value) -> String {
    let text = |key: &str| options.get(key).map_or_else(|| "undefined".to_owned(), value_to_string);
    let number = |key: &str| options.get(key).map_or(f64::NAN, to_number);
    let id = text("id");
    format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"Chart {id}\"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" r:id=\"{}\"/></a:graphicData></a:graphic></p:graphicFrame>",
        num(to_emu(number("left"))),
        num(to_emu(number("top"))),
        num(mixdog_js::math::max(1.0, to_emu(number("width")))),
        num(mixdog_js::math::max(1.0, to_emu(number("height")))),
        text("relationshipId")
    )
}

/// `CHART_AXIS_ORDER`: the children of a chart axis in the order the schema lists them.
pub const CHART_AXIS_ORDER: [&str; 19] = [
    "c:axId",
    "c:scaling",
    "c:delete",
    "c:axPos",
    "c:majorGridlines",
    "c:minorGridlines",
    "c:title",
    "c:numFmt",
    "c:majorTickMark",
    "c:minorTickMark",
    "c:tickLblPos",
    "c:spPr",
    "c:txPr",
    "c:crossAx",
    "c:crosses",
    "c:crossesAt",
    "c:crossBetween",
    "c:majorUnit",
    "c:minorUnit",
];

/// The chart a slide's shape names: the slide part, the chart part and the chart's XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlideChart {
    pub path: String,
    pub part: String,
    pub xml: String,
}

/// `resolveSlideChart(zip, slides, op)`: the chart behind shape `op.shape` of slide `op.slide`. An error when the slide or
/// shape is missing, the shape is not a chart, or its relationship or part is missing.
pub fn resolve_slide_chart(zip: &Package, slides: &[SlideRef], op: &Value) -> Result<SlideChart, String> {
    let slide_label = op.get("slide").map_or_else(|| "undefined".to_owned(), value_to_string);
    let shape_label = op.get("shape").map_or_else(|| "undefined".to_owned(), value_to_string);
    let path = match op.get("slide") {
        Some(slide) => slide_path(slides, slide)?,
        None => return Err("PPTX slide undefined not found".to_owned()),
    };
    let current = zip.text(&path);
    let tree = container_inner(&current, "p:spTree", 0).ok_or_else(|| "PPTX slide shape tree is missing".to_owned())?;
    let shapes = top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS);
    let index = op.get("shape").map_or(f64::NAN, to_number) - 1.0;
    let shape = (if index.fract() == 0.0 && index >= 0.0 { shapes.get(index as usize) } else { None })
        .ok_or_else(|| format!("PPTX shape {shape_label} not found on slide {slide_label}"))?;
    let reference =
        group(r#"<c:chart\b[^>]*\br:id="([^"]+)""#, &shape.xml).ok_or_else(|| format!("PPTX shape {shape_label} on slide {slide_label} is not a chart"))?;
    let relationships = relationship_map(&zip.text(&part_relationship_path(&path)));
    let target = relationships.get(&reference).ok_or_else(|| format!("PPTX chart relationship {reference} is missing on slide {slide_label}"))?;
    // The Target is relative to the slide ("../charts/chart1.xml") or an absolute part name ("/ppt/charts/chart1.xml", which
    // pptxgenjs writes); both name the same part.
    let part = relationship_target(&part_relationship_path(&path), target);
    let xml = zip.text(&part);
    if xml.is_empty() {
        return Err(format!("PPTX chart part is missing: {part}"));
    }
    Ok(SlideChart { path, part, xml })
}

/// `detectChartType(xml)`: the type name a chart part is written under (`pie`, `doughnut`, `line`, `area`, `column`, `bar`,
/// `stacked_column`, `stacked_bar`).
pub fn detect_chart_type(xml: &str) -> &'static str {
    if compiled(r"<c:pieChart\b", "").is_match(xml) {
        return "pie";
    }
    if compiled(r"<c:doughnutChart\b", "").is_match(xml) {
        return "doughnut";
    }
    if compiled(r"<c:lineChart\b", "").is_match(xml) {
        return "line";
    }
    if compiled(r"<c:areaChart\b", "").is_match(xml) {
        return "area";
    }
    let stacked = compiled(r#"<c:grouping val="stacked"/>"#, "").is_match(xml);
    let horizontal = compiled(r#"<c:barDir val="bar"/>"#, "").is_match(xml);
    match (stacked, horizontal) {
        (true, true) => "stacked_bar",
        (true, false) => "stacked_column",
        (false, true) => "bar",
        (false, false) => "column",
    }
}

/// `chartCategories(xml)`: the category labels of a chart.
pub fn chart_categories(xml: &str) -> Vec<String> {
    let block = matched(r"<c:cat>[\s\S]*?</c:cat>", xml);
    compiled(r#"<c:pt idx="\d+"><c:v>([\s\S]*?)</c:v></c:pt>"#, "g").captures_iter(&block).map(|found| xml_decode(found.get(1).unwrap_or(""))).collect()
}

/// `chartTitleText(xml)`: the text of a chart's title.
pub fn chart_title_text(xml: &str) -> String {
    let block = matched(r"<c:title>[\s\S]*?</c:title>", xml);
    compiled(r"<a:t>([\s\S]*?)</a:t>", "g").captures_iter(&block).map(|found| xml_decode(found.get(1).unwrap_or(""))).collect()
}

/// `writePresentationChart(zip, { chartPart, embeddingPart, chart, rows })`: the chart's workbook written to the embedding
/// part and the chart part saved citing it. The chart names its workbook through one relationship of its own part: a refresh
/// rewrote that part with a single rId1 while the chart kept citing the id it was saved with (rId3 in a PowerPoint deck), so
/// the chart lost its data link and the style and colour parts beside it. The relationships the part already holds are kept,
/// the package one is pointed at the new workbook, and the chart cites whatever id it carries.
pub fn write_presentation_chart(zip: &mut Package, chart_part: &str, embedding_part: &str, chart: &str, rows: &[Value]) -> Result<(), String> {
    zip.set(embedding_part, chart_workbook(rows, "")?);
    ensure_default_content_type(zip, "xlsx", WORKBOOK_CONTENT_TYPE);
    let relationships_path = part_relationship_path(chart_part);
    let existing = zip.text(&relationships_path);
    let target = xml_encode(&posix::relative(&posix::dirname(chart_part), embedding_part));
    let previous = matched(r#"<Relationship\b[^>]*\bType="[^"]*/package"[^>]*/>"#, &existing);
    let taken =
        compiled(r#"\bId="rId(\d+)""#, "g").captures_iter(&existing).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(0.0, mixdog_js::math::max);
    let id = group(r#"\bId="([^"]+)""#, &previous).unwrap_or_else(|| format!("rId{}", num(taken + 1.0)));
    let relationship = format!("<Relationship Id=\"{id}\" Type=\"{OFFICE_RELATIONSHIP_BASE}/package\" Target=\"{target}\"/>");
    let relationships = if !previous.is_empty() {
        replace_first_text(&existing, &previous, &relationship)
    } else if existing.contains("</Relationships>") {
        replace_first_text(&existing, "</Relationships>", &format!("{relationship}</Relationships>"))
    } else {
        format!("{XML_HEADER}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\">{relationship}</Relationships>")
    };
    zip.set(&relationships_path, relationships);
    zip.set(chart_part, cite_chart_workbook(chart, &id));
    ensure_content_type_override(zip, &format!("/{chart_part}"), CHART_CONTENT_TYPE);
    Ok(())
}

/// `<c:externalData>` sits after the chart's text properties and before its print settings, user shapes, and extensions.
fn cite_chart_workbook(chart: &str, id: &str) -> String {
    let existing = compiled(r#"(<c:externalData\b[^>]*\br:id=")[^"]*(")"#, "");
    if compiled(r#"<c:externalData\b[^>]*\br:id=""#, "").is_match(chart) {
        return crate::slide_shapes::replace_first_with(&existing, chart, |found| format!("{}{id}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or("")));
    }
    let cited = format!("<c:externalData r:id=\"{id}\"><c:autoUpdate val=\"0\"/></c:externalData>");
    match compiled(r"<c:(?:printSettings|userShapes|extLst)\b|</c:chartSpace>", "").find(chart) {
        Some(before) => format!("{}{cited}{}", &chart[..before.start], &chart[before.start..]),
        None => chart.to_owned(),
    }
}
