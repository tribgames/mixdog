//! `portable/portable-pptx-charts.mjs`: the chart operations of a presentation batch (`add_chart`, `set_chart_data`,
//! `set_chart_axis`, `set_chart_series`, `set_chart_trendline` / `set_chart_error_bars`, `set_chart_data_labels`). Each handler
//! takes the package, the slides the presentation lists and the operation as the caller wrote it, and answers the object the
//! operation reports. The chart parts are edited as text, as the script does: a data refresh rewrites the caches and ranges of
//! the chart in place and keeps what the deck's author set (label face, number format, accent point, hidden axis); it rebuilds
//! the chart from the template only when the new data is not the shape of the old.

use std::cell::Cell;

use mixdog_js::{is_js_space, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::chart::{ChartSpec, SLIDE_CHART_TEXT, chart_workbook_rows, chart_xml};
use crate::opc::{add_package_relationship, part_relationship_path, posix, relationship_target, relationship_target_by_type};
use crate::pptx_chart::{
    CHART_AXIS_ORDER, LABEL_POSITION_CODES, chart_categories, chart_frame_xml, chart_title_text, detect_chart_type,
    read_chart_presentation, resolve_slide_chart, write_presentation_chart,
};
use crate::pptx_core::{append_slide_shape, next_shape_id, pptx_related_part, theme_color};
use crate::pptx_deck::Handled;
use crate::pptx_package::{SlideRef, slide_path};
use crate::slide_shapes::{first_group, remove_first, replace_first_with, text_if_truthy, text_or_empty};
use crate::xml::{OFFICE_RELATIONSHIP_BASE, compiled, tag_pattern, upsert_ordered_child, xml_encode};
use crate::zipio::Package;

fn group(pattern: &str, text: &str) -> Option<String> {
    first_group(&compiled(pattern, ""), text)
}

fn matched(pattern: &str, text: &str) -> String {
    compiled(pattern, "").find(text).map(|found| text[found].to_owned()).unwrap_or_default()
}

fn blocks(pattern: &str, text: &str) -> Vec<String> {
    compiled(pattern, "g").find_iter(text).map(|found| text[found].to_owned()).collect()
}

/// `Array.isArray(op.name) ? op.name : []`.
fn array_of(op: &Value, name: &str) -> Vec<Value> {
    op.get(name).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `slidePath(slides, op.slide)`.
fn slide_path_of(slides: &[SlideRef], op: &Value) -> Result<String, String> {
    match op.get("slide") {
        Some(number) => slide_path(slides, number),
        None => Err("PPTX slide undefined not found".to_owned()),
    }
}

/// `Number(op.slide)` as the JSON the result carries.
fn slide_number(op: &Value) -> Value {
    json_number(op.get("slide").map_or(f64::NAN, to_number))
}

/// `{ op: op.op, ... }` in the order the entries are given.
fn answer(op: &Value, entries: Vec<(&str, Value)>) -> Value {
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    for (key, value) in entries {
        result.insert(key.to_owned(), value);
    }
    Value::Object(result)
}

/// `op.name != null`.
fn is_set(op: &Value, name: &str) -> bool {
    op.get(name).is_some_and(|value| !value.is_null())
}

/// `showLegend` as `chartXml` reads it: null and absent leave it to the chart, a boolean is that, anything else is not `false`.
fn legend_flag(value: Option<&Value>) -> Option<bool> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => Some(true),
    }
}

/// `zeroBaseline` as `chartXml` reads it: null and absent leave it to the chart type, otherwise it is `=== true`.
fn baseline_flag(value: Option<&Value>) -> Option<bool> {
    match value {
        None | Some(Value::Null) => None,
        Some(other) => Some(other.as_bool() == Some(true)),
    }
}

fn workbook_rows(categories: &[Value], series: &[Value]) -> Vec<Value> {
    chart_workbook_rows(categories, series).into_iter().map(Value::Array).collect()
}

/// `handleAddChart`: a chart part with its workbook, related to the slide and framed on it.
pub fn handle_add_chart(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_path_of(slides, op)?;
    let current = zip.text(&path);
    let categories = array_of(op, "categories");
    let series = array_of(op, "series");
    let mut ordinal = 1;
    while zip.file(&format!("ppt/charts/chart{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let chart_part = format!("ppt/charts/chart{ordinal}.xml");
    let chart_type = text_if_truthy(op.get("chartType"));
    let title = text_if_truthy(op.get("title"));
    let position = text_if_truthy(op.get("dataLabelPosition"));
    let color = text_if_truthy(op.get("dataLabelColor"));
    let format = text_if_truthy(op.get("valueNumberFormat"));
    let chart = chart_xml(&ChartSpec {
        chart_type: &chart_type,
        title: &title,
        categories: &categories,
        series: &series,
        show_values: op.get("showValues").and_then(Value::as_bool) == Some(true),
        data_label_position: &position,
        data_label_color: &color,
        value_number_format: &format,
        show_legend: legend_flag(op.get("showLegend")),
        zero_baseline: baseline_flag(op.get("zeroBaseline")),
        external_data_id: "rId1",
        text: SLIDE_CHART_TEXT,
        ..ChartSpec::default()
    })?;
    write_presentation_chart(zip, &chart_part, &format!("ppt/embeddings/chartData{ordinal}.xlsx"), &chart, &workbook_rows(&categories, &series))?;
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(&path),
        &format!("{OFFICE_RELATIONSHIP_BASE}/chart"),
        &posix::relative("ppt/slides", &chart_part),
        "",
    );
    let id = next_shape_id(&current);
    let placed = |name: &str, default: f64| op.get(name).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!(default));
    let frame = chart_frame_xml(&json!({
        "id": json_number(id),
        "relationshipId": relationship_id,
        "left": placed("left", 72.0),
        "top": placed("top", 72.0),
        "width": placed("width", 480.0),
        "height": placed("height", 280.0),
    }));
    zip.set(&path, append_slide_shape(&current, &frame)?);
    Ok(answer(op, vec![("changed", json!(true)), ("shapeId", json_number(id)), ("chart", json!(chart_part))]))
}

// A data refresh changes the numbers, not the chart: the deck's label face and size, the number format on the labels, the gap
// between the bars, the accent point, and the axis the author hid all stay as authored. When the new data has the chart's own
// series and every series one value per category, the caches and ranges are rewritten in place; anything else (another series
// count or a type change) takes the rebuild. A new title is words, set in the chart's own title block either way.
const REBUILD_FIELDS: [&str; 7] =
    ["chartType", "showValues", "showLegend", "zeroBaseline", "valueNumberFormat", "dataLabelPosition", "dataLabelColor"];

/// An accent on the last point marks the latest period; when the refresh changes the number of points it moves to the new
/// last one. Kept at its index, a monthly refresh left April lit under a title about May.
fn accent_on_last_point(series: &str, count: usize) -> String {
    let mut block = series.to_owned();
    let previous_count = group(r#"<c:val>[\s\S]*?<c:ptCount val="(\d+)""#, &block).map_or(0.0, |text| string_to_number(&text));
    let previous_count = if previous_count.is_nan() { 0.0 } else { previous_count };
    let before_points = block.split("<c:dPt>").next().unwrap_or("");
    let series_color = group(r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#, before_points).unwrap_or_default();
    let point_at = |point: &str| group(r#"<c:idx val="(\d+)""#, point).map_or(f64::NAN, |text| string_to_number(&text));
    let points = blocks(r"<c:dPt>[\s\S]*?</c:dPt>", &block);
    let accents: Vec<&String> = points
        .iter()
        .filter(|point| group(r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#, point).is_none_or(|color| color != series_color))
        .collect();
    let count_value = count as f64;
    if count_value != previous_count && accents.len() == 1 && point_at(accents[0]) == previous_count - 1.0 {
        // The accent and the point now last trade places; one past the new end is dropped by the caller.
        let displaced = points.iter().find(|point| point_at(point) == count_value - 1.0);
        let moved = |point: &str, to: f64| {
            replace_first_with(&compiled(r#"<c:idx val="\d+"/>"#, ""), point, |_| format!("<c:idx val=\"{}\"/>", number_to_string(to)))
        };
        block = block.replacen(accents[0].as_str(), &moved(accents[0], count_value - 1.0), 1);
        if let Some(displaced) = displaced {
            block = block.replacen(displaced.as_str(), &moved(displaced, previous_count - 1.0), 1);
        }
    }
    block
}

/// `refreshChartDataInPlace`: the chart with the new categories and values in its caches and ranges, or `None` when the new
/// data does not have the shape of the old chart.
fn refresh_chart_data_in_place(xml: &str, categories: &[Value], series: &[Value], op: &Value) -> Option<String> {
    if REBUILD_FIELDS.iter().any(|field| op.get(*field).is_some()) {
        return None;
    }
    let ranges: Vec<std::ops::Range<usize>> = compiled(r"<c:ser>[\s\S]*?</c:ser>", "g").find_iter(xml).collect();
    let count = categories.len();
    if ranges.is_empty() || ranges.len() != series.len() || count == 0 {
        return None;
    }
    if series.iter().any(|entry| entry.get("values").and_then(Value::as_array).is_none_or(|values| values.len() != count)) {
        return None;
    }
    let last_row = count + 1;
    let to_row = |formula: &str| replace_first_with(&compiled(r"\$(\d+)$", ""), formula, |_| format!("${last_row}"));
    let category_points: String = categories
        .iter()
        .enumerate()
        .map(|(index, entry)| format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", xml_encode(&text_or_empty(Some(entry)))))
        .collect();
    let mut next = xml.to_owned();
    for index in (0..ranges.len()).rev() {
        let mut block = next[ranges[index].clone()].to_owned();
        let entry = &series[index];
        if !compiled(r"<c:val>[\s\S]*?<c:numCache>", "").is_match(&block) {
            return None;
        }
        block = accent_on_last_point(&block, count);
        if let Some(name) = entry.get("name").filter(|name| !name.is_null()) {
            let name = xml_encode(&value_to_string(name));
            // A name read from the sheet keeps its reference and takes the new cache; one written as text is rewritten.
            block = if compiled(r"<c:tx>\s*<c:v>", "").is_match(&block) {
                replace_first_with(&compiled(r"<c:tx>\s*<c:v>[\s\S]*?</c:v>\s*</c:tx>", ""), &block, |_| format!("<c:tx><c:v>{name}</c:v></c:tx>"))
            } else {
                replace_first_with(&compiled(r"(<c:tx>\s*<c:strRef>[\s\S]*?<c:strCache>)[\s\S]*?(</c:strCache>)", ""), &block, |found| {
                    format!("{}<c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{name}</c:v></c:pt>{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
                })
            };
        }
        if compiled(r"<c:cat>[\s\S]*?<c:multiLvlStrCache>", "").is_match(&block) {
            block = replace_first_with(&compiled(r"(<c:cat>[\s\S]*?<c:multiLvlStrCache>)[\s\S]*?(</c:multiLvlStrCache>)", ""), &block, |found| {
                format!("{}<c:ptCount val=\"{count}\"/><c:lvl>{category_points}</c:lvl>{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            });
        } else if compiled(r"<c:cat>[\s\S]*?<c:strCache>", "").is_match(&block) {
            block = replace_first_with(&compiled(r"(<c:cat>[\s\S]*?<c:strCache>)[\s\S]*?(</c:strCache>)", ""), &block, |found| {
                format!("{}<c:ptCount val=\"{count}\"/>{category_points}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            });
        } else {
            return None;
        }
        let value_points: String = entry["values"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .enumerate()
            .map(|(point, value)| {
                let blank = value.is_null() || value.as_str() == Some("") || !to_number(value).is_finite();
                if blank { String::new() } else { format!("<c:pt idx=\"{point}\"><c:v>{}</c:v></c:pt>", number_to_string(to_number(value))) }
            })
            .collect();
        block = replace_first_with(
            &compiled(r"(<c:val>[\s\S]*?<c:numCache>\s*(?:<c:formatCode>[\s\S]*?</c:formatCode>\s*)?)[\s\S]*?(</c:numCache>)", ""),
            &block,
            |found| format!("{}<c:ptCount val=\"{count}\"/>{value_points}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or("")),
        );
        for opener in ["<c:cat>", "<c:val>"] {
            block = replace_first_with(&compiled(&format!(r"({opener}[\s\S]*?<c:f>)([^<]*)(</c:f>)"), ""), &block, |found| {
                format!("{}{}{}", found.get(1).unwrap_or(""), to_row(found.get(2).unwrap_or("")), found.get(3).unwrap_or(""))
            });
        }
        // A point override past the new last point has nothing to colour.
        block = compiled(r"<c:dPt>[\s\S]*?</c:dPt>", "g").replace_all_with(&block, |found| {
            let point = found.get(0).unwrap_or("");
            let at = group(r#"<c:idx val="(\d+)""#, point).map_or(f64::NAN, |text| string_to_number(&text));
            if at < count as f64 { point.to_owned() } else { String::new() }
        });
        next = format!("{}{block}{}", &next[..ranges[index].start], &next[ranges[index].end..]);
    }
    Some(next)
}

/// The chart's own title, not an axis's: it stands between `<c:chart>` and the plot area.
fn chart_title_block(xml: &str) -> String {
    group(r"<c:chart>(?:(?!<c:plotArea>)[\s\S])*?(<c:title>[\s\S]*?</c:title>)", xml).unwrap_or_default()
}

/// A title block with new words: its first run keeps its properties and takes the text, the other runs go.
fn title_words(own: &str, text: &str) -> String {
    let first = Cell::new(true);
    compiled(r"<a:r>([\s\S]*?)</a:r>", "g").replace_all_with(own, |found| {
        if !first.replace(false) {
            return String::new();
        }
        let properties = matched(r"<a:rPr\b[\s\S]*?(?:/>|</a:rPr>)", found.get(1).unwrap_or(""));
        format!("<a:r>{properties}<a:t>{}</a:t></a:r>", xml_encode(text))
    })
}

/// A rebuilt chart kept its data, colours and labels but set its title in the runtime's own bold 171717: a template's light
/// grey title turned heavy on the first refresh. The chart's own title block stays and only its words change.
fn keep_title_treatment(existing: &str, rebuilt: &str, text: &str) -> String {
    let own = chart_title_block(existing);
    let fresh = chart_title_block(rebuilt);
    if own.is_empty() || fresh.is_empty() || !own.contains("<a:r>") {
        return rebuilt.to_owned();
    }
    rebuilt.replacen(&fresh, &title_words(&own, text), 1)
}

/// A title is words, not structure: it changes inside the chart's own title block and the chart around it stays as it stands,
/// as PowerPoint sets it. `title:''` takes the title away; a chart without a title block of words to change is rebuilt
/// instead (`None`).
fn retitled_chart(xml: &str, text: &str) -> Option<String> {
    let own = chart_title_block(xml);
    if text.is_empty() {
        let untitled = if own.is_empty() { xml.to_owned() } else { xml.replacen(&own, "", 1) };
        let deleted = compiled(r"<c:autoTitleDeleted\b[^>]*/>", "");
        return Some(if deleted.is_match(&untitled) {
            replace_first_with(&deleted, &untitled, |_| "<c:autoTitleDeleted val=\"1\"/>".to_owned())
        } else {
            untitled.replacen("<c:chart>", "<c:chart><c:autoTitleDeleted val=\"1\"/>", 1)
        });
    }
    if !own.contains("<a:r>") {
        return None;
    }
    Some(xml.replacen(&own, &title_words(&own, text), 1))
}

/// The order a horizontal bar chart lists its categories in: `topDown` reads them from the top in the order given, `bottomUp`
/// is PowerPoint's default. Empty when the operation does not say.
fn category_orientation_for(op: &Value) -> Result<&'static str, String> {
    let Some(order) = op.get("categoryOrder").filter(|order| !order.is_null() && order.as_str() != Some("")) else { return Ok("") };
    let key: String = js_to_lowercase(&value_to_string(order)).chars().filter(|c| !(is_js_space(*c) || *c == '_' || *c == '-')).collect();
    match key.as_str() {
        "topdown" => Ok("maxMin"),
        "bottomup" => Ok("minMax"),
        _ => Err("set_chart_data categoryOrder must be 'topDown' or 'bottomUp'".to_owned()),
    }
}

fn category_orientation_of(xml: &str) -> String {
    let category_axis = matched(r"<c:catAx>[\s\S]*?</c:catAx>", xml);
    group(r#"<c:orientation val="(minMax|maxMin)"/>"#, &category_axis).unwrap_or_else(|| "minMax".to_owned())
}

/// The category axis running the other way and the value axis crossing it at the far end, so it stays under the bars.
fn with_category_orientation(xml: &str, orientation: &str) -> String {
    let category_axis = matched(r"<c:catAx>[\s\S]*?</c:catAx>", xml);
    let value_axis = matched(r"<c:valAx>[\s\S]*?</c:valAx>", xml);
    if category_axis.is_empty() || value_axis.is_empty() {
        return xml.to_owned();
    }
    let element = format!("<c:orientation val=\"{orientation}\"/>");
    let existing = compiled(r#"<c:orientation val="[^"]*"/>"#, "");
    let oriented = if existing.is_match(&category_axis) {
        replace_first_with(&existing, &category_axis, |_| element.clone())
    } else if category_axis.contains("<c:scaling/>") {
        category_axis.replacen("<c:scaling/>", &format!("<c:scaling>{element}</c:scaling>"), 1)
    } else {
        category_axis.replacen("<c:scaling>", &format!("<c:scaling>{element}"), 1)
    };
    let crosses = if orientation == "maxMin" { "max" } else { "autoZero" };
    let crossing = compiled(r#"<c:crosses val="[^"]*"/>"#, "");
    let crossed = if crossing.is_match(&value_axis) {
        replace_first_with(&crossing, &value_axis, |_| format!("<c:crosses val=\"{crosses}\"/>"))
    } else if !compiled(r"<c:crossesAt\b", "").is_match(&value_axis) {
        replace_first_with(&compiled(r#"(<c:crossAx val="[^"]*"/>)"#, ""), &value_axis, |found| {
            format!("{}<c:crosses val=\"{crosses}\"/>", found.get(1).unwrap_or(""))
        })
    } else {
        value_axis.clone()
    };
    xml.replacen(&category_axis, &oriented, 1).replacen(&value_axis, &crossed, 1)
}

/// The colours the chart already had, read back from it.
struct KeptColors {
    series: Vec<String>,
    points: Vec<Vec<Value>>,
}

/// `withKeptColors`: the new series carrying the colours the chart already had. Point colours are kept only where the new data
/// still has that point, so a shorter refresh never leaves the accent on a category that is gone; a lone accent on the last
/// point follows the last point.
fn with_kept_colors(series: &[Value], kept: &KeptColors, previous_count: usize) -> Vec<Value> {
    series
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if !truthy(entry) {
                return entry.clone();
            }
            let mut points = kept.points.get(index).cloned().unwrap_or_default();
            let value_count = entry.get("values").and_then(Value::as_array).map_or(0, Vec::len);
            let base = kept.series.get(index).map_or("", String::as_str);
            let lit: Vec<usize> =
                points.iter().enumerate().filter(|(_, color)| truthy(color) && color.as_str() != Some(base)).map(|(point, _)| point).collect();
            if value_count != previous_count && lit.len() == 1 && previous_count > 0 && lit[0] == previous_count - 1 {
                let accent = points[lit[0]].clone();
                points[lit[0]] = if value_count > 0 { points.get(value_count - 1).cloned().unwrap_or(Value::Null) } else { Value::Null };
                if value_count > 0 {
                    if points.len() < value_count {
                        points.resize(value_count, Value::Null);
                    }
                    points[value_count - 1] = accent;
                }
            }
            let carried = if entry.get("pointColors").is_none() && points.iter().any(truthy) {
                points.truncate(value_count);
                Some(Value::Array(points))
            } else {
                None
            };
            let filled = if entry.get("color").is_none() { kept.series.get(index).filter(|color| !color.is_empty()) } else { None };
            if carried.is_none() && filled.is_none() {
                return entry.clone();
            }
            let mut object = entry.as_object().cloned().unwrap_or_default();
            if let Some(color) = filled {
                object.insert("color".to_owned(), json!(color));
            }
            if let Some(points) = carried {
                object.insert("pointColors".to_owned(), points);
            }
            Value::Object(object)
        })
        .collect()
}

const BOTTOM_UP_NOTE: &str =
    "The bars read from the bottom up, the first category lowest, as this chart was authored; categoryOrder:'topDown' lists them from the top in the order given.";

fn kept_strings(kept: &Value, key: &str) -> Vec<String> {
    kept[key].as_array().map(|list| list.iter().map(|item| item.as_str().unwrap_or("").to_owned()).collect()).unwrap_or_default()
}

/// `handleSetChartData`: new categories and series for a chart, keeping the chart's own presentation.
pub fn handle_set_chart_data(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let chart = resolve_slide_chart(zip, slides, op)?;
    let (chart_part, existing) = (chart.part, chart.xml);
    let series = array_of(op, "series");
    if series.is_empty() {
        return Err("set_chart_data requires series".to_owned());
    }
    let orientation = category_orientation_for(op)?;
    let categories: Vec<Value> = match op.get("categories").and_then(Value::as_array) {
        Some(given) => given.clone(),
        None => chart_categories(&existing).into_iter().map(Value::from).collect(),
    };
    let chart_relationships = zip.text(&part_relationship_path(&chart_part));
    let embedded = relationship_target_by_type(&chart_relationships, "package");
    let embedding_part = if embedded.is_empty() {
        let number = group(r"chart(\d+)\.xml$", &chart_part).map_or(f64::NAN, |text| string_to_number(&text));
        format!("ppt/embeddings/chartData{}.xlsx", if number.is_nan() || number == 0.0 { "1".to_owned() } else { number_to_string(number) })
    } else {
        relationship_target(&part_relationship_path(&chart_part), &embedded)
    };
    // The chart is rewritten around the new numbers, so its own presentation is read back first: a monthly refresh keeps the
    // labels, number format, legend, base line, and series colours the deck was approved with.
    let kept = read_chart_presentation(&existing);
    let mut series_colors = kept_strings(&kept, "seriesColors");
    let scheme_colors = kept_strings(&kept, "seriesSchemeColors");
    // Series coloured from the theme keep their colours: each scheme name is resolved through the slide's master.
    if scheme_colors.iter().any(|token| !token.is_empty()) {
        let slide_part = slide_path_of(slides, op)?;
        let layout_part = pptx_related_part(zip, &slide_part, "slideLayout");
        let master_part = if layout_part.is_empty() { String::new() } else { pptx_related_part(zip, &layout_part, "slideMaster") };
        for (index, token) in scheme_colors.iter().enumerate() {
            if series_colors.get(index).is_some_and(String::is_empty) && !token.is_empty() {
                series_colors[index] = theme_color(zip, &master_part, token)?;
            }
        }
    }
    let kept_colors = KeptColors {
        series: series_colors,
        points: kept["pointColors"]
            .as_array()
            .map(|lists| lists.iter().map(|list| list.as_array().cloned().unwrap_or_default()).collect())
            .unwrap_or_default(),
    };
    let previous_count = chart_categories(&existing).len();
    let coloured = with_kept_colors(&series, &kept_colors, previous_count);
    let in_place = refresh_chart_data_in_place(&existing, &categories, &series, op);
    let refreshed = match in_place {
        Some(xml) if is_set(op, "title") => retitled_chart(&xml, &value_to_string(&op["title"])),
        other => other,
    };
    let kept_axis = kept["axis"].clone();
    let detected = detect_chart_type(&existing);
    // Another type is another chart: its categories read the way that type reads them.
    let retyped = op.get("chartType").is_some_and(|given| truthy(given) && given.as_str() != Some(detected));
    let axis = if retyped {
        let mut axis = kept_axis.as_object().cloned().unwrap_or_default();
        axis.insert("categoryOrientation".to_owned(), json!(""));
        Value::Object(axis)
    } else {
        kept_axis.clone()
    };
    let title_text = if is_set(op, "title") { value_to_string(&op["title"]) } else { chart_title_text(&existing) };
    let written = match refreshed {
        Some(xml) => xml,
        None => {
            let chosen = |given: Option<&Value>, kept_flag: bool| match given {
                None => kept_flag,
                Some(given) => given.as_bool() == Some(true),
            };
            let kept_text = |key: &str| kept[key].as_str().unwrap_or("").to_owned();
            let given_text = |key: &str| if is_set(op, key) { value_to_string(&op[key]) } else { kept_text(key) };
            let chart_type = match op.get("chartType").filter(|given| truthy(given)) {
                Some(given) => value_to_string(given),
                None => detected.to_owned(),
            };
            let title = if is_set(op, "title") && !truthy(&op["title"]) { String::new() } else { title_text.clone() };
            let position = given_text("dataLabelPosition");
            let color = given_text("dataLabelColor");
            let format = given_text("valueNumberFormat");
            let legend = if is_set(op, "showLegend") { legend_flag(op.get("showLegend")) } else { Some(kept["showLegend"].as_bool().unwrap_or(false)) };
            let rebuilt = chart_xml(&ChartSpec {
                chart_type: &chart_type,
                title: &title,
                categories: &categories,
                series: &coloured,
                show_values: chosen(op.get("showValues"), kept["showValues"].as_bool().unwrap_or(false)),
                data_label_position: &position,
                data_label_color: &color,
                value_number_format: &format,
                show_legend: legend,
                zero_baseline: Some(chosen(op.get("zeroBaseline"), kept["zeroBaseline"].as_bool().unwrap_or(false))),
                axis: Some(&axis),
                external_data_id: "rId1",
                text: SLIDE_CHART_TEXT,
                ..ChartSpec::default()
            })?;
            keep_title_treatment(&existing, &rebuilt, &title_text)
        }
    };
    let horizontal = written.contains("<c:barDir val=\"bar\"/>");
    if !orientation.is_empty() && !horizontal {
        return Err("set_chart_data categoryOrder orders a horizontal bar chart's categories; this chart is not one".to_owned());
    }
    let chart_text = if orientation.is_empty() { written } else { with_category_orientation(&written, orientation) };
    write_presentation_chart(zip, &chart_part, &embedding_part, &chart_text, &workbook_rows(&categories, &coloured))?;
    // Bars left reading from the bottom up are named, with the field that turns them over: nothing else tells the caller that
    // its first category landed at the bottom.
    let bottom_up = horizontal && orientation.is_empty() && category_orientation_of(&chart_text) == "minMax";
    // A zero baseline is already reported on its own; the axis line is what the caller could not have asked for: a hidden axis,
    // a zoomed range, no grid.
    let flag = |key: &str| kept_axis[key].as_bool().unwrap_or(false);
    let minimum = &kept_axis["min"];
    let axis_kept = flag("hideValueAxis")
        || flag("hideCategoryAxis")
        || !kept_axis["max"].is_null()
        || (!minimum.is_null() && to_number(minimum) != 0.0)
        || !flag("gridlines");
    let mut preserved: Vec<&str> = Vec::new();
    if kept["showValues"].as_bool() == Some(true) {
        preserved.push("dataLabels");
    }
    if truthy(&kept["valueNumberFormat"]) {
        preserved.push("numberFormat");
    }
    if kept["showLegend"].as_bool() == Some(true) {
        preserved.push("legend");
    }
    if kept["zeroBaseline"].as_bool() == Some(true) {
        preserved.push("zeroBaseline");
    }
    if kept_colors.series.iter().any(|color| !color.is_empty()) {
        preserved.push("seriesColors");
    }
    let accented = |entry: &Value| entry.get("pointColors").and_then(Value::as_array).is_some_and(|points| points.iter().any(truthy));
    if coloured.iter().any(accented) {
        preserved.push("pointColors");
    }
    if axis_kept {
        preserved.push("axis");
    }
    let mut entries = vec![("changed", json!(true)), ("slide", slide_number(op)), ("chart", json!(chart_part))];
    if !preserved.is_empty() {
        entries.push(("preserved", json!(preserved)));
    }
    if bottom_up {
        entries.push(("readingOrder", json!("bottomUp")));
        entries.push(("note", json!(BOTTOM_UP_NOTE)));
    }
    Ok(answer(op, entries))
}

/// `rewriteChartSeries`: the chart's series blocks rewritten in place. `wanted` is a 1-based series number; anything else (no
/// number, 0, NaN) means every series. The flag says whether any series was reached, which is how a caller learns that the
/// series it named does not exist.
fn rewrite_chart_series(xml: &str, wanted: f64, rewrite: impl Fn(&str) -> String) -> (String, bool) {
    let index = Cell::new(0.0_f64);
    let changed = Cell::new(false);
    let next = compiled(r"<c:ser>[\s\S]*?</c:ser>", "g").replace_all_with(xml, |found| {
        let series = found.get(0).unwrap_or("");
        index.set(index.get() + 1.0);
        if wanted.is_finite() && wanted.fract() == 0.0 && wanted > 0.0 && wanted != index.get() {
            return series.to_owned();
        }
        changed.set(true);
        rewrite(series)
    });
    (next, changed.get())
}

/// `handleSetChartAxis`: a chart axis's bounds, number format, major unit and title.
pub fn handle_set_chart_axis(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let axis = js_to_lowercase(&text_if_truthy(op.get("axis")));
    let tag = match axis.as_str() {
        "category" => "c:catAx",
        "value" => "c:valAx",
        _ => return Err("set_chart_axis axis must be category or value".to_owned()),
    };
    let chart = resolve_slide_chart(zip, slides, op)?;
    let escaped = tag_pattern(tag);
    let found = compiled(&format!(r"<{escaped}>[\s\S]*?</{escaped}>"), "").find(&chart.xml).ok_or_else(|| format!("Chart has no {axis} axis"))?;
    let block = chart.xml[found.clone()].to_owned();
    let mut updated = block.clone();
    if is_set(op, "minimum") || is_set(op, "maximum") {
        updated = replace_first_with(&compiled(r"<c:scaling>[\s\S]*?</c:scaling>", ""), &updated, |scaling| {
            let cleaned = remove_first(&compiled(r"<c:max\b[^>]*/>", ""), &remove_first(&compiled(r"<c:min\b[^>]*/>", ""), scaling.get(0).unwrap_or("")));
            let bound = |name: &str, element: &str| {
                if is_set(op, name) { format!("<c:{element} val=\"{}\"/>", number_to_string(to_number(&op[name]))) } else { String::new() }
            };
            cleaned.replacen("</c:scaling>", &format!("{}{}</c:scaling>", bound("maximum", "max"), bound("minimum", "min")), 1)
        });
    }
    if is_set(op, "numberFormat") {
        let format = &op["numberFormat"];
        let element = if truthy(format) { format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", xml_encode(&value_to_string(format))) } else { String::new() };
        updated = upsert_ordered_child(&updated, &CHART_AXIS_ORDER, "c:numFmt", &element);
    }
    if is_set(op, "majorUnit") {
        let unit = to_number(&op["majorUnit"]);
        let element = if unit > 0.0 { format!("<c:majorUnit val=\"{}\"/>", number_to_string(unit)) } else { String::new() };
        updated = upsert_ordered_child(&updated, &CHART_AXIS_ORDER, "c:majorUnit", &element);
    }
    if is_set(op, "title") {
        let title = value_to_string(&op["title"]);
        let element = if title.is_empty() {
            String::new()
        } else {
            format!(
                "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\" sz=\"900\"/><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title>",
                xml_encode(&title)
            )
        };
        updated = upsert_ordered_child(&updated, &CHART_AXIS_ORDER, "c:title", &element);
    }
    zip.set(&chart.part, format!("{}{updated}{}", &chart.xml[..found.start], &chart.xml[found.end..]));
    Ok(answer(op, vec![("changed", json!(updated != block)), ("slide", slide_number(op)), ("axis", json!(axis))]))
}

/// The row a range formula of a block ends at, set to `row`.
fn last_row_to(block: &str, row: usize) -> String {
    replace_first_with(&compiled(r"(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(</c:f>)", ""), block, |found| {
        format!("{}{row}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
    })
}

/// `handleSetChartSeries`: a series' name, categories and values rewritten in its caches and ranges.
pub fn handle_set_chart_series(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    if is_set(op, "chartType") || is_set(op, "secondaryAxis") {
        return Err("Portable set_chart_series cannot change the series type or axis; rebuild the chart with add_chart".to_owned());
    }
    let chart = resolve_slide_chart(zip, slides, op)?;
    let number = op.get("series").map_or(f64::NAN, to_number);
    let wanted = math::max(1.0, if number.is_nan() || number == 0.0 { 1.0 } else { number });
    let name = is_set(op, "name").then(|| xml_encode(&value_to_string(&op["name"])));
    let categories = op.get("categories").and_then(Value::as_array).filter(|list| !list.is_empty());
    let values = op.get("values").and_then(Value::as_array).filter(|list| !list.is_empty());
    let (next, changed) = rewrite_chart_series(&chart.xml, wanted, |series| {
        let mut updated = series.to_owned();
        if let Some(name) = &name {
            updated = replace_first_with(&compiled(r#"(<c:tx>[\s\S]*?<c:strCache>[\s\S]*?<c:pt idx="0"><c:v>)[\s\S]*?(</c:v>)"#, ""), &updated, |found| {
                format!("{}{name}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            });
        }
        if let Some(categories) = categories {
            let points: String = categories
                .iter()
                .enumerate()
                .map(|(position, entry)| format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", xml_encode(&text_or_empty(Some(entry)))))
                .collect();
            updated = replace_first_with(&compiled(r"<c:cat>[\s\S]*?</c:cat>", ""), &updated, |block| {
                let block = block.get(0).unwrap_or("");
                let cache = replace_first_with(&compiled(r"<c:strCache>[\s\S]*?</c:strCache>", ""), block, |_| {
                    format!("<c:strCache><c:ptCount val=\"{}\"/>{points}</c:strCache>", categories.len())
                });
                last_row_to(&cache, categories.len() + 1)
            });
        }
        if let Some(values) = values {
            let points: String = values
                .iter()
                .enumerate()
                .filter_map(|(position, entry)| {
                    let numeric = to_number(entry);
                    numeric.is_finite().then(|| format!("<c:pt idx=\"{position}\"><c:v>{}</c:v></c:pt>", number_to_string(numeric)))
                })
                .collect();
            updated = replace_first_with(&compiled(r"<c:val>[\s\S]*?</c:val>", ""), &updated, |block| {
                let block = block.get(0).unwrap_or("");
                let cache = replace_first_with(&compiled(r"<c:numCache>[\s\S]*?</c:numCache>", ""), block, |cache| {
                    replace_first_with(&compiled(r#"<c:ptCount val="\d+"/>[\s\S]*?(?=</c:numCache>)"#, ""), cache.get(0).unwrap_or(""), |_| {
                        format!("<c:ptCount val=\"{}\"/>{points}", values.len())
                    })
                });
                last_row_to(&cache, values.len() + 1)
            });
        }
        updated
    });
    if !changed {
        return Err(format!("Chart has no series {}", number_to_string(wanted)));
    }
    zip.set(&chart.part, next);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", slide_number(op)), ("series", json_number(wanted))]))
}

/// The kinds by their names (exponential, moving_average) or the file's own codes (exp, movingAvg): the Office backend took
/// only the names and drew 'exp' as a straight line, this one only the codes.
fn trendline_type(name: &str) -> Option<&'static str> {
    match name {
        "linear" => Some("linear"),
        "exponential" | "exp" => Some("exp"),
        "logarithmic" | "log" => Some("log"),
        "polynomial" | "poly" => Some("poly"),
        "power" => Some("power"),
        "movingaverage" | "movingavg" => Some("movingAvg"),
        _ => None,
    }
}

/// `String(op.name || fallback)`.
fn text_or_fallback(op: &Value, name: &str, fallback: &str) -> String {
    match op.get(name).filter(|value| truthy(value)) {
        Some(value) => value_to_string(value),
        None => fallback.to_owned(),
    }
}

fn trendline_xml(op: &Value) -> Result<String, String> {
    let given = text_or_fallback(op, "type", "linear");
    let lowered = js_to_lowercase(js_trim(&given));
    let key = compiled(r"[\s_-]+", "g").replace_all_with(&lowered, |_| String::new());
    let Some(kind) = trendline_type(&key) else {
        return Err("set_chart_trendline type must be linear, exponential, logarithmic, polynomial, power, or moving_average".to_owned());
    };
    let flag = |name: &str| u8::from(op.get(name).and_then(Value::as_bool) == Some(true));
    Ok(format!(
        "<c:trendline><c:trendlineType val=\"{kind}\"/><c:dispRSqr val=\"{}\"/><c:dispEq val=\"{}\"/></c:trendline>",
        flag("displayRSquared"),
        flag("displayEquation")
    ))
}

fn error_bars_xml(op: &Value) -> Result<String, String> {
    let direction = match js_to_lowercase(&text_or_fallback(op, "direction", "y")).as_str() {
        "y" | "vertical" => "y",
        "x" | "horizontal" => "x",
        _ => return Err("set_chart_error_bars direction must be x or y".to_owned()),
    };
    let style = js_to_lowercase(&text_or_fallback(op, "endStyle", "both"));
    let bar_type = if ["both", "minus", "plus"].contains(&style.as_str()) { style.as_str() } else { "both" };
    let amount = op.get("amount").map_or(f64::NAN, to_number);
    if !amount.is_finite() || amount <= 0.0 {
        return Err("set_chart_error_bars requires a positive amount".to_owned());
    }
    Ok(format!(
        "<c:errBars><c:errDir val=\"{direction}\"/><c:errBarType val=\"{bar_type}\"/><c:errValType val=\"fixedVal\"/><c:noEndCap val=\"0\"/><c:val val=\"{}\"/></c:errBars>",
        number_to_string(amount)
    ))
}

/// The element put before the first of the anchors the series has, or before the series' closing tag.
fn put_in_series(series: &str, anchors: &[&str], element: &str) -> String {
    for anchor in anchors {
        if let Some(at) = series.find(anchor) {
            return format!("{}{element}{}", &series[..at], &series[at..]);
        }
    }
    series.replacen("</c:ser>", &format!("{element}</c:ser>"), 1)
}

fn no_such_series(op: &Value) -> String {
    js_trim(&format!("Chart has no series {}", text_or_empty(op.get("series")))).to_owned()
}

/// `wanted || 'all'`: the series a trendline, error bars or labels went to.
fn reached(wanted: f64) -> Value {
    if wanted.is_nan() || wanted == 0.0 { json!("all") } else { json_number(wanted) }
}

/// `handleSetChartTrendlineOrSetChartErrorBars`: a trendline or fixed error bars on one series or on all of them.
pub fn handle_set_chart_trendline_or_set_chart_error_bars(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let chart = resolve_slide_chart(zip, slides, op)?;
    let wanted = op.get("series").map_or(f64::NAN, to_number);
    let trendline = op.get("op").and_then(Value::as_str) == Some("set_chart_trendline");
    let element = if trendline { trendline_xml(op)? } else { error_bars_xml(op)? };
    let tag = tag_pattern(if trendline { "c:trendline" } else { "c:errBars" });
    let existing = compiled(&format!(r"<{tag}>[\s\S]*?</{tag}>"), "g");
    let (next, changed) = rewrite_chart_series(&chart.xml, wanted, |series| {
        let cleaned = existing.replace_all_with(series, |_| String::new());
        put_in_series(&cleaned, &["<c:cat>", "<c:val>"], &element)
    });
    if !changed {
        return Err(no_such_series(op));
    }
    zip.set(&chart.part, next);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", slide_number(op)), ("series", reached(wanted))]))
}

/// `handleSetChartDataLabels`: data labels on one series or on all of them (or none, which removes them).
pub fn handle_set_chart_data_labels(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let chart = resolve_slide_chart(zip, slides, op)?;
    let named = js_to_lowercase(&text_if_truthy(op.get("position")));
    let position = LABEL_POSITION_CODES.iter().find(|(name, _)| *name == named).map_or("", |(_, code)| *code);
    let stacked = chart.xml.contains("<c:grouping val=\"stacked\"/>");
    let pie = compiled(r"<c:(?:pie|doughnut)Chart\b", "").is_match(&chart.xml);
    let usable = if stacked && position == "outEnd" { "ctr" } else { position };
    let show_value = op.get("showValue").and_then(Value::as_bool) != Some(false);
    let show_category = op.get("showCategoryName").and_then(Value::as_bool) == Some(true);
    let labels = if show_value || show_category {
        let format = op.get("numberFormat").filter(|format| truthy(format));
        format!(
            "<c:dLbls>{}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>{}<c:showLegendKey val=\"0\"/><c:showVal val=\"{}\"/><c:showCatName val=\"{}\"/><c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbls>",
            format.map_or(String::new(), |format| format!("<c:numFmt formatCode=\"{}\" sourceLinked=\"0\"/>", xml_encode(&value_to_string(format)))),
            if !usable.is_empty() && !pie { format!("<c:dLblPos val=\"{usable}\"/>") } else { String::new() },
            u8::from(show_value),
            u8::from(show_category),
        )
    } else {
        String::new()
    };
    let wanted = op.get("series").map_or(f64::NAN, to_number);
    let existing = compiled(r"<c:dLbls>[\s\S]*?</c:dLbls>", "");
    let (next, changed) = rewrite_chart_series(&chart.xml, wanted, |series| {
        let cleaned = remove_first(&existing, series);
        if labels.is_empty() {
            return cleaned;
        }
        put_in_series(&cleaned, &["<c:cat>"], &labels)
    });
    if !changed {
        return Err(no_such_series(op));
    }
    zip.set(&chart.part, next);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", slide_number(op)), ("series", reached(wanted))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERIES: &str = "<c:ser>A</c:ser><c:ser>B</c:ser><c:ser>C</c:ser>";

    #[test]
    fn a_series_number_reaches_one_series_and_anything_else_reaches_all() {
        let mark = |series: &str| format!("<c:ser>{}!</c:ser>", &series[7..8]);
        assert_eq!(rewrite_chart_series(SERIES, 2.0, mark), ("<c:ser>A</c:ser><c:ser>B!</c:ser><c:ser>C</c:ser>".to_owned(), true));
        for wanted in [0.0, f64::NAN, 1.5, -1.0] {
            assert_eq!(rewrite_chart_series(SERIES, wanted, mark).0, "<c:ser>A!</c:ser><c:ser>B!</c:ser><c:ser>C!</c:ser>", "{wanted}");
        }
        assert_eq!(rewrite_chart_series(SERIES, 4.0, mark), (SERIES.to_owned(), false));
    }

    #[test]
    fn an_element_goes_before_the_first_anchor_or_before_the_series_closes() {
        assert_eq!(put_in_series("<c:ser><c:tx/><c:val>1</c:val></c:ser>", &["<c:cat>", "<c:val>"], "<x/>"), "<c:ser><c:tx/><x/><c:val>1</c:val></c:ser>");
        assert_eq!(put_in_series("<c:ser><c:tx/></c:ser>", &["<c:cat>", "<c:val>"], "<x/>"), "<c:ser><c:tx/><x/></c:ser>");
    }

    #[test]
    fn trendline_kinds_take_their_names_and_the_files_own_codes() {
        let kind = |name: &str| trendline_xml(&json!({ "type": name })).map(|xml| group(r#"<c:trendlineType val="([^"]+)""#, &xml).unwrap_or_default());
        assert_eq!(kind("Moving Average").unwrap(), "movingAvg");
        assert_eq!(kind("moving_avg").unwrap(), "movingAvg");
        assert_eq!(kind("exp").unwrap(), "exp");
        assert_eq!(kind("exponential").unwrap(), "exp");
        assert_eq!(trendline_xml(&json!({})).unwrap(), trendline_xml(&json!({ "type": "linear" })).unwrap());
        assert!(kind("constructor").unwrap_err().starts_with("set_chart_trendline type must be"));
        assert!(trendline_xml(&json!({ "displayEquation": true })).unwrap().contains("<c:dispEq val=\"1\"/>"));
    }

    #[test]
    fn error_bars_need_a_direction_and_a_positive_amount() {
        assert!(error_bars_xml(&json!({ "amount": 2.5 })).unwrap().contains("<c:errDir val=\"y\"/><c:errBarType val=\"both\"/>"));
        assert!(error_bars_xml(&json!({ "amount": 1, "direction": "Horizontal", "endStyle": "plus" })).unwrap().contains("<c:errDir val=\"x\"/><c:errBarType val=\"plus\"/>"));
        assert!(error_bars_xml(&json!({ "amount": 1, "endStyle": "wide" })).unwrap().contains("<c:errBarType val=\"both\"/>"));
        assert_eq!(error_bars_xml(&json!({ "amount": 1, "direction": "z" })).unwrap_err(), "set_chart_error_bars direction must be x or y");
        for amount in [json!(0), json!(-1), json!("many"), Value::Null] {
            assert_eq!(error_bars_xml(&json!({ "amount": amount })).unwrap_err(), "set_chart_error_bars requires a positive amount");
        }
    }

    #[test]
    fn a_title_changes_inside_the_charts_own_title_block() {
        let chart = "<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:rPr sz=\"1400\"/><a:t>Old</a:t></a:r><a:r><a:t>tail</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:catAx><c:title><a:r><a:t>axis</a:t></a:r></c:title></c:catAx></c:plotArea></c:chart>";
        let renamed = retitled_chart(chart, "New & more").unwrap();
        assert!(renamed.contains("<a:r><a:rPr sz=\"1400\"/><a:t>New &amp; more</a:t></a:r></a:p>"), "{renamed}");
        assert!(renamed.contains("<a:t>axis</a:t>"), "an axis title is not the chart's");
        let untitled = retitled_chart(chart, "").unwrap();
        assert!(untitled.starts_with("<c:chart><c:autoTitleDeleted val=\"1\"/><c:plotArea>"), "{untitled}");
        assert_eq!(retitled_chart("<c:chart><c:plotArea/></c:chart>", "x"), None);
    }

    #[test]
    fn the_category_axis_turns_over_with_the_value_axis_crossing_at_the_far_end() {
        let chart = "<c:catAx><c:scaling><c:orientation val=\"minMax\"/></c:scaling></c:catAx><c:valAx><c:crossAx val=\"1\"/></c:valAx>";
        let turned = with_category_orientation(chart, "maxMin");
        assert_eq!(turned, "<c:catAx><c:scaling><c:orientation val=\"maxMin\"/></c:scaling></c:catAx><c:valAx><c:crossAx val=\"1\"/><c:crosses val=\"max\"/></c:valAx>");
        assert_eq!(category_orientation_of(&turned), "maxMin");
        assert_eq!(with_category_orientation("<c:catAx/>", "maxMin"), "<c:catAx/>");
    }

    #[test]
    fn a_lone_accent_on_the_last_point_follows_the_last_point() {
        let kept = KeptColors { series: vec!["336699".to_owned()], points: vec![vec![Value::Null, Value::Null, json!("FF0000")]] };
        let moved = with_kept_colors(&[json!({ "name": "S", "values": [1, 2, 3, 4] })], &kept, 3);
        assert_eq!(moved[0]["pointColors"], json!([null, null, null, "FF0000"]));
        assert_eq!(moved[0]["color"], "336699");
        let shorter = with_kept_colors(&[json!({ "values": [1, 2] })], &kept, 3);
        assert_eq!(shorter[0]["pointColors"], json!([null, "FF0000"]));
        let own = with_kept_colors(&[json!({ "values": [1, 2, 3], "color": "00FF00", "pointColors": [] })], &kept, 3);
        assert_eq!(own[0], json!({ "values": [1, 2, 3], "color": "00FF00", "pointColors": [] }));
    }
}
