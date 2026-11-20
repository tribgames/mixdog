//! `portable/portable-snapshot-pptx.mjs`: the presentation snapshot: slide backgrounds, notes, shapes and text facts, in the
//! key order Node writes them (the snapshot is serialised, and compared, as text).

use std::collections::HashMap;

use mixdog_fonts::face::FontError;
use mixdog_fsio::ReadProof;
use mixdog_js::{json_number, math, string_to_number};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::pptx_core::pptx_related_part;
use crate::pptx_package::{presentation_slides, slide_layout_parts};
use crate::pptx_table_fit::table_drawn_height;
use crate::relations::shape_identity;
use crate::slide_shapes::{EMU_PER_POINT, SLIDE_SHAPE_TAGS, number_or_zero};
use crate::snapshot_shared::{chart_part_snapshot, next_page_offset, related_part_by_id};
use crate::text_metrics::TextMeasurer;
use crate::xml::{Element, block_text, compiled, container_inner, paragraph_texts, top_level_elements, xml_decode};
use crate::zipio::Package;

fn first_group(source: &str, flags: &str, text: &str) -> Option<String> {
    compiled(source, flags).captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// Microsoft Office reports a resolved background per slide, and the theme review abandons the whole deck as soon as one slide
/// has none. Reading only the slide part would leave every template deck unreviewed, so inheritance is resolved through the
/// layout and master exactly as PowerPoint does.
fn slide_background(zip: &Package, slide_path: &str, slide_xml: &str) -> Value {
    const BACKGROUND: &str = r#"<p:bg\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#;
    let reading = |color: String, follow_master: bool, source: &str| json!({ "color": color.to_uppercase(), "followMaster": follow_master, "source": source });
    if let Some(own) = first_group(BACKGROUND, "", slide_xml) {
        return reading(own, false, "slide");
    }
    let layout_path = pptx_related_part(zip, slide_path, "/slideLayout");
    if !layout_path.is_empty() {
        if let Some(inherited) = first_group(BACKGROUND, "", &zip.text(&layout_path)) {
            return reading(inherited, true, "layout");
        }
        let master_path = pptx_related_part(zip, &layout_path, "/slideMaster");
        if !master_path.is_empty()
            && let Some(from_master) = first_group(BACKGROUND, "", &zip.text(&master_path))
        {
            return reading(from_master, true, "master");
        }
    }
    reading(String::new(), true, "master")
}

fn slide_notes(zip: &Package, slide_path: &str) -> String {
    let notes_path = pptx_related_part(zip, slide_path, "/notesSlide");
    if notes_path.is_empty() {
        return String::new();
    }
    let xml = zip.text(&notes_path);
    let Some(tree) = container_inner(&xml, "p:spTree", 0) else {
        return String::new();
    };
    let body = compiled(r#"<p:ph\b[^>]*\btype="body""#, "i");
    for shape in top_level_elements(&tree.inner, &["p:sp"]) {
        if body.is_match(&shape.xml) {
            return block_text(&shape.xml, "a:t");
        }
    }
    block_text(&xml, "a:t")
}

/// The colour of the text itself (the first run that names one) as Microsoft Office reports it under font.color. Without it
/// an agent adding a page to a deck could match the face and the size of the title it copied, never its colour: the new
/// kicker came out black under a deck of blue kickers.
fn run_color(shape_xml: &str) -> String {
    let inner = compiled(r#"^\s*<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, "i");
    for run in compiled(r"<a:rPr\b[^>]*>([\s\S]*?)</a:rPr>", "gi").captures_iter(shape_xml) {
        if let Some(color) = inner.captures(run.get(1).unwrap_or("")).and_then(|found| found.get(1).map(str::to_uppercase)) {
            return color;
        }
    }
    String::new()
}

/// `fontFacts(fontSizes, bold, fonts, color)`: `{ font, sizes }`, or nothing for a shape with no sized run.
fn font_facts(entries: &mut Map<String, Value>, font_sizes: &[f64], bold: bool, fonts: &[String], color: &str) {
    if font_sizes.is_empty() {
        return;
    }
    let mut font = Map::new();
    font.insert("size".to_owned(), json_number(font_sizes.iter().copied().fold(f64::NEG_INFINITY, math::max)));
    if bold {
        font.insert("bold".to_owned(), json!(true));
    }
    if let Some(name) = fonts.first() {
        font.insert("name".to_owned(), json!(name));
    }
    if !color.is_empty() {
        font.insert("color".to_owned(), json!(color));
    }
    let mut sizes: Vec<f64> = Vec::new();
    for size in font_sizes {
        if !sizes.contains(size) {
            sizes.push(*size);
        }
    }
    sizes.sort_by(|left, right| left.total_cmp(right));
    entries.insert("font".to_owned(), Value::Object(font));
    entries.insert("sizes".to_owned(), Value::Array(sizes.into_iter().map(json_number).collect()));
}

/// `options.pages?.length` is truthy: a list or a text with something in it.
fn has_length(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(list)) => !list.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(object)) => object.get("length").is_some_and(truthy),
        _ => false,
    }
}

/// The slides a read returns: the whole deck, one page of it, or the pages the caller named.
struct Selected {
    paged: bool,
    offset: f64,
    limit: f64,
    requested: Vec<String>,
}

fn select_slides(slide_paths: &[String], options: &Value) -> Selected {
    let paged = options.get("paged") == Some(&Value::Bool(true));
    let offset = if paged { math::max(0.0, number_or_zero(options.get("offset"))) } else { 0.0 };
    let limit = if paged {
        let stated = number_or_zero(options.get("limit"));
        math::max(1.0, if stated == 0.0 { 20.0 } else { stated })
    } else {
        slide_paths.len() as f64
    };
    let pages = options.get("pages").and_then(Value::as_array).filter(|list| !list.is_empty());
    let requested = match pages {
        Some(pages) if paged => pages
            .iter()
            .filter_map(|page| {
                let at = mixdog_js::to_number(page) - 1.0;
                if at.fract() == 0.0 && at >= 0.0 { slide_paths.get(at as usize).cloned() } else { None }
            })
            .collect(),
        None if paged => {
            let length = slide_paths.len() as f64;
            let start = offset.trunc().min(length) as usize;
            let end = (offset + limit).trunc().min(length) as usize;
            if start < end { slide_paths[start..end].to_vec() } else { Vec::new() }
        }
        _ => slide_paths.to_vec(),
    };
    Selected { paged, offset, limit, requested }
}

/// A chart frame carries only a relationship to its part, so the slide read alone says a chart is there and nothing about
/// what it draws. The part is resolved here (the series, the legend, the labels), which is what the review needs to say
/// whether a reader can tell the series apart. A part that cannot be resolved leaves the frame as it was, never as an empty
/// chart.
fn slide_chart_parts(zip: &Package, slide_path: &str, shapes: &[Element]) -> HashMap<usize, Map<String, Value>> {
    let mut chart_parts = HashMap::new();
    let chart = compiled(r#"<c:chart\b[^>]*\br:id="([^"]+)""#, "i");
    for (index, shape) in shapes.iter().enumerate() {
        let Some(id) = chart.captures(&shape.xml).and_then(|found| found.get(1).map(str::to_owned)) else {
            continue;
        };
        let part = related_part_by_id(zip, slide_path, &id);
        let part_xml = if part.is_empty() { String::new() } else { zip.text(&part) };
        if part_xml.is_empty() {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("part".to_owned(), json!(part));
        if let Value::Object(snapshot) = chart_part_snapshot(&part_xml) {
            entry.extend(snapshot);
        }
        chart_parts.insert(index, entry);
    }
    chart_parts
}

/// The distinct values of a pattern's first group over a shape, in the order they first appear.
fn distinct_groups(source: &str, shape_xml: &str, map: impl Fn(&str) -> String) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for entry in compiled(source, "gi").captures_iter(shape_xml) {
        let value = map(entry.get(1).unwrap_or(""));
        if !value.is_empty() && !found.contains(&value) {
            found.push(value);
        }
    }
    found
}

/// Preset geometry tells the diversity review which native structure a slide carries (chevron process, block-arc share,
/// trapezoid tiers).
fn shape_geometry(shape: &Element) -> String {
    if shape.name != "p:sp" {
        return String::new();
    }
    if compiled(r"<a:custGeom\b", "i").is_match(&shape.xml) {
        return "custGeom".to_owned();
    }
    first_group(r#"<a:prstGeom\b[^>]*\bprst="([^"]+)""#, "i", &shape.xml).unwrap_or_default()
}

/// The shape's own surface color (spPr solidFill, or a gradient's first stop: the side the kit puts type on), distinct from
/// text colors.
fn shape_fill(shape_xml: &str) -> String {
    let properties = first_group(r"<p:spPr\b[^>]*>([\s\S]*?)</p:spPr>", "i", shape_xml).unwrap_or_default();
    first_group(r#"<a:gradFill\b[\s\S]*?<a:gs\b[^>]*>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, "i", &properties)
        .or_else(|| first_group(r#"<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, "i", &properties))
        .map(|color| color.to_uppercase())
        .unwrap_or_default()
}

/// `{ left, top, width, height }` in points, or nothing when the shape states no offset and extent.
fn shape_frame(shape_xml: &str) -> Option<[f64; 4]> {
    let offset = compiled(r#"<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)""#, "i").captures(shape_xml)?;
    let extent = compiled(r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "i").captures(shape_xml)?;
    let points = |found: &mixdog_js::Caps, at: usize| string_to_number(found.get(at).unwrap_or("")) / EMU_PER_POINT;
    Some([points(&offset, 1), points(&offset, 2), points(&extent, 1), points(&extent, 2)])
}

fn count_of(source: &str, text: &str) -> usize {
    compiled(source, "gi").find_iter(text).count()
}

/// Design review reads evidence from the same fields Microsoft Office reports. Publishing only the raw element name left every
/// chart, table, group, picture, and type-scale rule blind on portable decks.
fn shape_snapshot<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    shape: &Element,
    shape_index: usize,
    slide_index: usize,
    chart_parts: &HashMap<usize, Map<String, Value>>,
) -> Result<Value, FontError> {
    let shape_path = format!("/slide[{slide_index}]/shape[{}]", shape_index + 1);
    let xml = shape.xml.as_str();
    let font_sizes: Vec<f64> = compiled(r#"<a:rPr\b[^>]*\bsz="(\d+)""#, "gi")
        .captures_iter(xml)
        .map(|found| string_to_number(found.get(1).unwrap_or("")) / 100.0)
        .filter(|size| *size > 0.0)
        .collect();
    // Weight is a type-scale step of its own: a specimen ladder sets one size in light / regular / bold.
    let bold = compiled(r#"<a:rPr\b[^>]*\bb="1""#, "i").is_match(xml);
    let table_rows = count_of(r"<a:tr\b", xml);
    let table_columns = count_of(r"<a:gridCol\b", xml);
    let fonts = distinct_groups(r#"<a:latin\b[^>]*\btypeface="([^"]+)""#, xml, xml_decode);
    let colors = distinct_groups(r#"<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, xml, str::to_uppercase);
    let shape_name = xml_decode(&first_group(r#"<p:cNvPr\b[^>]*\bname="([^"]*)""#, "i", xml).unwrap_or_default());
    let geometry = shape_geometry(shape);
    // What a reader who cannot see the picture is told about it; the audit asks for it, so the snapshot shows whether it is
    // there.
    let alt_text = xml_decode(&first_group(r#"<p:cNvPr\b[^>]*\bdescr="([^"]*)""#, "i", xml).unwrap_or_default());
    let fill = shape_fill(xml);
    // A table stands as tall as its rows draw, as PowerPoint reports it: rows grow to their text past the frame the file
    // declares, and a source line under a table that ran long read as clear of it.
    let mut frame = shape_frame(xml);
    if table_rows > 0
        && let Some(frame) = frame.as_mut()
    {
        frame[3] = math::max(frame[3], table_drawn_height(measurer, xml)? / EMU_PER_POINT);
    }
    let identity = shape_identity(xml);
    let mut entries = Map::new();
    entries.insert("path".to_owned(), json!(shape_path));
    entries.insert("index".to_owned(), json!(shape_index + 1));
    entries.insert("shapeId".to_owned(), json!(identity.shape_id));
    if let Some(relation) = identity.relation {
        entries.insert("relation".to_owned(), relation);
    }
    if let Some(error) = identity.relation_error {
        entries.insert("relationError".to_owned(), json!(error));
    }
    entries.insert("type".to_owned(), json!(shape.name));
    if !shape_name.is_empty() {
        entries.insert("name".to_owned(), json!(shape_name));
    }
    // PowerPoint's selection pane can hide a shape: it stays in the file and the slide does not show it, so it is neither
    // measured nor read as what the page says.
    if compiled(r#"<p:cNvPr\b[^>]*\bhidden="(?:1|true)""#, "i").is_match(xml) {
        entries.insert("hidden".to_owned(), json!(true));
    }
    if !alt_text.is_empty() {
        entries.insert("altText".to_owned(), json!(alt_text));
    }
    if !geometry.is_empty() {
        entries.insert("geometry".to_owned(), json!(geometry));
    }
    if !fill.is_empty() {
        entries.insert("fill".to_owned(), json!({ "color": fill }));
    }
    // A table's cells are separate strings a reader never runs together ("4:3" beside "8.8초" is not "4:38.8초"), so they
    // join on a space; a text body keeps its runs together and its breaks (a soft break (a:br, which the kit writes between
    // Hangul words) and a paragraph end) as newlines, so "4주차" + "잔존율" never reads "4주차잔존율".
    let text = if table_rows > 0 { paragraph_texts(xml, "a:t").join(" ") } else { block_text(xml, "a:t") };
    entries.insert("text".to_owned(), json!(text));
    if shape.name == "p:grpSp" {
        entries.insert("group".to_owned(), json!(true));
    }
    if compiled(r"<p:ph\b", "i").is_match(xml) {
        entries.insert("placeholder".to_owned(), json!(true));
    }
    if compiled(r"<c:chart\b", "i").is_match(xml) {
        let mut chart = Map::new();
        chart.insert("path".to_owned(), json!(format!("{shape_path}/chart")));
        if let Some(part) = chart_parts.get(&shape_index) {
            chart.extend(part.clone());
        }
        entries.insert("chart".to_owned(), Value::Object(chart));
    }
    // Each cell's text, row by row, as PowerPoint reports a table: without it the cells a set_table_data edit would replace
    // could only be read run together in `text`.
    if table_rows > 0 {
        let cell = compiled(r"<a:tc\b[^>]*?(?:/>|>([\s\S]*?)</a:tc>)", "g");
        let values: Vec<Value> = compiled(r"<a:tr\b[^>]*>([\s\S]*?)</a:tr>", "g")
            .captures_iter(xml)
            .map(|row| {
                let cells = cell.captures_iter(row.get(1).unwrap_or("")).map(|found| json!(block_text(found.get(1).unwrap_or(""), "a:t")));
                Value::Array(cells.collect())
            })
            .collect();
        entries.insert("table".to_owned(), json!({ "rows": table_rows, "columns": table_columns, "values": values }));
    }
    font_facts(&mut entries, &font_sizes, bold, &fonts, &run_color(xml));
    if !fonts.is_empty() {
        entries.insert("fonts".to_owned(), json!(fonts));
    }
    if !colors.is_empty() {
        entries.insert("colors".to_owned(), json!(colors));
    }
    if let Some([left, top, width, height]) = frame {
        for (key, value) in [("left", left), ("top", top), ("width", width), ("height", height)] {
            entries.insert(key.to_owned(), json_number(value));
        }
    }
    Ok(Value::Object(entries))
}

fn snapshot_slide<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, path: &str, index: usize, slide_id: f64) -> Result<Value, FontError> {
    let xml = zip.text(path);
    let tree = container_inner(&xml, "p:spTree", 0);
    let shape_blocks = tree.map(|tree| top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS)).unwrap_or_default();
    let chart_parts = slide_chart_parts(zip, path, &shape_blocks);
    let shapes = shape_blocks
        .iter()
        .enumerate()
        .map(|(shape_index, shape)| shape_snapshot(measurer, shape, shape_index, index, &chart_parts))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "path": format!("/slide[{index}]"),
        "index": index,
        "slideId": json_number(slide_id),
        // A hidden slide stays in the file and is skipped when the deck is shown; read as an ordinary page it puts a withdrawn
        // page back in the argument.
        "hidden": compiled(r#"<p:sld\b[^>]*\bshow="0""#, "").is_match(&xml),
        "background": slide_background(zip, path, &xml),
        "notes": slide_notes(zip, path),
        "text": paragraph_texts(&xml, "a:t"),
        "shapes": shapes,
    }))
}

/// `snapshotPptx(zip, options)`: the deck as a reader sees it. `options` may carry `paged`, `offset`, `limit` and `pages` to
/// read a window of the slides. Table heights are measured with `measurer`.
pub fn snapshot_pptx<P: ReadProof>(zip: &Package, options: &Value, measurer: &TextMeasurer<'_, P>) -> Result<Value, FontError> {
    let roster = presentation_slides(zip);
    let slide_paths: Vec<String> = roster.iter().map(|slide| slide.path.clone()).collect();
    let selected = select_slides(&slide_paths, options);
    let mut slides = Vec::new();
    for path in &selected.requested {
        // `slidePaths.indexOf(path) + 1`: the first slide of that part.
        if let Some(at) = slide_paths.iter().position(|candidate| candidate == path) {
            slides.push(snapshot_slide(measurer, zip, path, at + 1, roster[at].id)?);
        }
    }
    let layouts: Vec<Value> = slide_layout_parts(zip)
        .iter()
        .enumerate()
        .map(|(index, layout)| json!({ "path": format!("/layout[{}]", index + 1), "index": index + 1, "name": layout.name, "packagePart": layout.path }))
        .collect();
    let presentation = zip.text("ppt/presentation.xml");
    let size = compiled(r#"<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "i").captures(&presentation);
    let points = |at: usize| size.as_ref().map_or(0.0, |found| string_to_number(found.get(at).unwrap_or("")) / EMU_PER_POINT);
    let pages = options.get("pages");
    let pages_requested = pages.and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    let next_offset = if has_length(pages) {
        Value::Null
    } else {
        next_page_offset(selected.offset, slides.len() as f64, slide_paths.len() as f64).map_or(Value::Null, json_number)
    };
    let mut snapshot = Map::new();
    snapshot.insert("format".to_owned(), json!("pptx"));
    snapshot.insert("slideCount".to_owned(), json!(slide_paths.len()));
    snapshot.insert("slideWidth".to_owned(), json_number(points(1)));
    snapshot.insert("slideHeight".to_owned(), json_number(points(2)));
    let layout_count = layouts.len();
    let returned = slides.len();
    snapshot.insert("slides".to_owned(), Value::Array(slides));
    snapshot.insert("layoutCount".to_owned(), json!(layout_count));
    snapshot.insert("layouts".to_owned(), Value::Array(layouts));
    if selected.paged {
        let total = if pages_requested { selected.requested.len() } else { slide_paths.len() };
        snapshot.insert(
            "pagination".to_owned(),
            json!({
                "unit": "slide",
                "offset": json_number(selected.offset),
                "limit": json_number(selected.limit),
                "returned": returned,
                "total": total,
                "nextOffset": next_offset,
            }),
        );
    }
    Ok(Value::Object(snapshot))
}
