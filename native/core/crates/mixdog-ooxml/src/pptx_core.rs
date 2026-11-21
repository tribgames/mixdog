//! `portable/portable-pptx-core.mjs`: reading a slide the way a reviewer needs it (every text box with its geometry, insets
//! and the colour it sits on; every other visible object), and the edits a slide takes: a table's values, a shape's frame
//! and fill, the slide background, the shape tree.

use std::cell::Cell;

use mixdog_js::{JsRegex, js_trim, json_number, math, number_to_string, string_to_number, to_number, to_number_of, value_to_string};
use serde_json::{Map, Value, json};

use crate::opc::{part_relationship_path, relationship_target};
use crate::pptx_package::presentation_slides;
use crate::relations::shape_identity;
use crate::slide_shapes::{
    EMU_PER_POINT, SLIDE_SHAPE_TAGS, background_xml, first_group, from_emu, is_set, num, remove_first, solid_fill_xml, text_or_empty, to_emu_of,
};
use crate::xml::{
    Container, Element, compiled, container_body, container_inner, element_spans, rebuild_text_nodes, text_nodes, top_level_elements, xml_attribute,
    xml_decode, xml_encode,
};
use crate::zipio::Package;

const DEFAULT_TEXT_INSETS: [f64; 4] = [7.2, 3.6, 7.2, 3.6];

/// A box on a slide in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    fn put(&self, map: &mut Map<String, Value>) {
        for (key, value) in [("left", self.left), ("top", self.top), ("width", self.width), ("height", self.height)] {
            map.insert(key.to_owned(), json_number(value));
        }
    }
}

/// A painted plane: the frame of a shape with a fill, and the colour the fill shows.
struct Painted {
    frame: Frame,
    color: String,
}

/// A painted plane covers a box when the box sits inside it (a point of slack for EMU rounding).
fn covers_bounds(entry: &Frame, bounds: &Frame) -> bool {
    entry.left <= bounds.left + 1.0
        && entry.top <= bounds.top + 1.0
        && entry.left + entry.width >= bounds.left + bounds.width - 1.0
        && entry.top + entry.height >= bounds.top + bounds.height - 1.0
}

/// The colour a translucent fill shows: `foreground` at `alpha` (0-1) over `background`, per channel.
fn blend_hex(foreground: &str, background: &str, alpha: f64) -> String {
    let channel =
        |hex: &str, at: usize| -> f64 { hex.get(at..at + 2).and_then(|pair| i64::from_str_radix(pair, 16).ok()).map_or(f64::NAN, |value| value as f64) };
    [0, 2, 4]
        .iter()
        .map(|at| math::round(alpha * channel(foreground, *at) + (1.0 - alpha) * channel(background, *at)))
        .map(|value| math::max(0.0, math::min(255.0, value)))
        .map(|value| format!("{:02x}", value as i64))
        .collect::<String>()
        .to_uppercase()
}

fn matched<'a>(pattern: &str, text: &'a str) -> Option<&'a str> {
    compiled(pattern, "").find(text).map(|found| &text[found])
}

/// `shapeParagraphs(shapeXml)`: the paragraphs of a shape with what each states (text, size in points, runs of another
/// size, weight, colour, face, spacing); `None` when a paragraph states no size, which leaves nothing to measure.
pub fn shape_paragraphs(shape_xml: &str) -> Option<Vec<Value>> {
    let soft_break = compiled(r"<a:br\b[^>]*?(?:/>|>[\s\S]*?</a:br>)", "g");
    let text_node = compiled(r"<a:t(?:\s[^>]*)?>([\s\S]*?)</a:t>", "g");
    let mut paragraphs = Vec::new();
    for found in compiled(r"<a:p>[\s\S]*?</a:p>", "g").find_iter(shape_xml) {
        let block = &shape_xml[found];
        // A soft break (<a:br/>, which the kit and the HTML route write between lines) reads as '\n', so the measure breaks
        // the line where PowerPoint does instead of running two lines together as one word.
        let text: String = text_node
            .captures_iter(&soft_break.replace_all_with(block, |_| "<a:t>\n</a:t>".to_owned()))
            .map(|node| xml_decode(node.get(1).unwrap_or("")))
            .collect();
        let run_element = matched(r"<a:rPr\b[^>]*?(?:/>|>[\s\S]*?</a:rPr>)", block).unwrap_or("");
        let run_properties = first_group(&compiled(r"^<a:rPr\b([^>]*?)(?:/>|>)", ""), run_element).unwrap_or_default();
        let size = string_to_number(&xml_attribute(&run_properties, "sz"));
        if !size.is_finite() || size <= 0.0 {
            return None;
        }
        // Each run with its own size, so a figure and its smaller unit are measured as they are set.
        let mut runs: Vec<(String, f64)> = Vec::new();
        for token in compiled(r"<a:r>([\s\S]*?)</a:r>|<a:br\b[^>]*?(?:/>|>[\s\S]*?</a:br>)", "g").captures_iter(block) {
            match token.get(1) {
                None => {
                    let size_of_last = runs.last().map_or(size / 100.0, |(_, font)| *font);
                    runs.push(("\n".to_owned(), size_of_last));
                }
                Some(inner) => {
                    let text: String = text_node.captures_iter(inner).map(|node| xml_decode(node.get(1).unwrap_or(""))).collect();
                    let stated = first_group(&compiled(r#"<a:rPr\b[^>]*\bsz="(\d+)""#, ""), inner).map_or(0.0, |value| string_to_number(&value));
                    runs.push((text, (if stated == 0.0 || stated.is_nan() { size } else { stated }) / 100.0));
                }
            }
        }
        // Tracking is stored in hundredths of a point on the run. Latin small caps want it; Hangul and CJK break apart under
        // it, so the reading is kept.
        let tracking = string_to_number(&xml_attribute(&run_properties, "spc"));
        let stated = |pattern: &str| first_group(&compiled(pattern, ""), block).map_or(0.0, |value| string_to_number(&value));
        let line_spacing = stated(r#"<a:lnSpc>\s*<a:spcPct\b[^>]*\bval="(\d+)""#);
        let space_after = stated(r#"<a:spcAft>\s*<a:spcPts\b[^>]*\bval="(\d+)""#) / 100.0;
        let space_before = stated(r#"<a:spcBef>\s*<a:spcPts\b[^>]*\bval="(\d+)""#) / 100.0;
        let mut paragraph = Map::new();
        paragraph.insert("text".to_owned(), Value::String(text));
        if line_spacing > 0.0 {
            paragraph.insert("lineSpacing".to_owned(), json_number(line_spacing / 100_000.0));
        }
        if space_after > 0.0 {
            paragraph.insert("spaceAfter".to_owned(), json_number(space_after));
        }
        if space_before > 0.0 {
            paragraph.insert("spaceBefore".to_owned(), json_number(space_before));
        }
        if tracking.is_finite() && tracking != 0.0 {
            paragraph.insert("charSpacing".to_owned(), json_number(tracking / 100.0));
        }
        paragraph.insert("fontSize".to_owned(), json_number(size / 100.0));
        let sizes: std::collections::HashSet<String> = runs.iter().map(|(_, font)| number_to_string(*font)).collect();
        if sizes.len() > 1 {
            let listed: Vec<Value> = runs.iter().map(|(run_text, font)| json!({ "text": run_text, "fontSize": json_number(*font) })).collect();
            paragraph.insert("runs".to_owned(), Value::Array(listed));
        }
        paragraph.insert("bold".to_owned(), Value::Bool(xml_attribute(&run_properties, "b") == "1"));
        paragraph.insert("italic".to_owned(), Value::Bool(xml_attribute(&run_properties, "i") == "1"));
        paragraph
            .insert("color".to_owned(), Value::String(first_group(&compiled(r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#, ""), run_element).unwrap_or_default()));
        let face = first_group(&compiled(r#"<a:latin\b[^>]*\btypeface="([^"]*)""#, ""), block).filter(|face| !face.is_empty());
        paragraph.insert("fontName".to_owned(), Value::String(face.unwrap_or_else(|| "Calibri".to_owned())));
        paragraphs.push(Value::Object(paragraph));
    }
    Some(paragraphs)
}

fn background_block(xml: &str) -> String {
    first_group(&compiled(r"<p:bg\b[^>]*>([\s\S]*?)</p:bg>", ""), xml).unwrap_or_default()
}

/// `pptxRelatedPart(zip, part, suffix)`: the part the first internal relationship of a type (ending in `suffix`) points at.
pub fn pptx_related_part(zip: &Package, part: &str, suffix: &str) -> String {
    let relationship_path = part_relationship_path(part);
    let relationships = zip.text(&relationship_path);
    if relationships.is_empty() {
        return String::new();
    }
    for found in compiled(r"<Relationship\b[^>]*?/?>", "g").find_iter(&relationships) {
        let element = &relationships[found];
        if compiled(r#"\bTargetMode="External""#, "i").is_match(element) {
            continue;
        }
        if !first_group(&compiled(r#"\bType="([^"]*)""#, ""), element).unwrap_or_default().ends_with(suffix) {
            continue;
        }
        let target = first_group(&compiled(r#"\bTarget="([^"]*)""#, ""), element).unwrap_or_default();
        if !target.is_empty() {
            return relationship_target(&relationship_path, &target);
        }
    }
    String::new()
}

/// `themeColor(zip, masterPart, token)`: bg1/tx1 and friends are names the master maps onto the theme's colours;
/// accent1..6 name them directly. Empty when the theme does not state the colour as hex.
pub fn theme_color(zip: &Package, master_part: &str, token: &str) -> Result<String, String> {
    if master_part.is_empty() {
        return Ok(String::new());
    }
    let master = zip.text(master_part);
    let map = first_group(&compiled(r"<p:clrMap\b([^>]*?)/?>", ""), &master).unwrap_or_default();
    let stated = xml_attribute(&map, token);
    let mapped = if stated.is_empty() { token.to_owned() } else { stated };
    let theme_part = pptx_related_part(zip, master_part, "theme");
    let theme = if theme_part.is_empty() { String::new() } else { zip.text(&theme_part) };
    let scheme = first_group(&compiled(r"<a:clrScheme\b[^>]*>([\s\S]*?)</a:clrScheme>", ""), &theme).unwrap_or_default();
    let entry = JsRegex::new(&format!(r"<a:{mapped}\b[^>]*>([\s\S]*?)</a:{mapped}>"), "")?;
    let entry = first_group(&entry, &scheme).unwrap_or_default();
    Ok(first_group(&compiled(r#"<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, ""), &entry)
        .or_else(|| first_group(&compiled(r#"<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})""#, ""), &entry))
        .unwrap_or_default())
}

/// `resolveSlideBackground(zip, slidePath, slideXml)`: the field a reader actually sees behind a slide's text: the slide's
/// own background when it has one, otherwise the layout's, otherwise the master's. A deck's dark slides usually carry that
/// colour on the layout, and without following the chain every contrast reading on them is skipped, which is exactly where
/// ink gets chosen wrongly.
pub fn resolve_slide_background(zip: &Package, slide_path: &str, slide_xml: &str) -> Result<String, String> {
    let layout_part = pptx_related_part(zip, slide_path, "slideLayout");
    let master_part = if layout_part.is_empty() { String::new() } else { pptx_related_part(zip, &layout_part, "slideMaster") };
    let mut chain = vec![slide_xml.to_owned()];
    if !layout_part.is_empty() {
        chain.push(zip.text(&layout_part));
    }
    if !master_part.is_empty() {
        chain.push(zip.text(&master_part));
    }
    for xml in chain {
        let block = background_block(&xml);
        if block.is_empty() || compiled(r"<a:noFill\b", "").is_match(&block) {
            continue;
        }
        let direct = first_group(&compiled(r#"<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, ""), &block).unwrap_or_default();
        if !direct.is_empty() {
            return Ok(direct);
        }
        let token = first_group(&compiled(r#"<a:schemeClr\b[^>]*\bval="([A-Za-z0-9]+)""#, ""), &block).unwrap_or_default();
        let resolved = if token.is_empty() { String::new() } else { theme_color(zip, &master_part, &token)? };
        if !resolved.is_empty() {
            return Ok(resolved);
        }
    }
    Ok(String::new())
}

/// A gradient plane reads as its first stop: the kit puts the text on that side (a scrim's dark edge). A translucent plane (a
/// venn set, a wash) is the color a reader sees: its fill blended by its alpha over whatever it covers; reading the fill
/// opaque reports contrast against a color that is not on the page.
fn shape_own_fill(shape_xml: &str, bounds: &Frame, painted: &[Painted], slide_background: &str) -> String {
    let properties = container_inner(shape_xml, "p:spPr", 0).map(|found| found.inner).unwrap_or_default();
    let solid = compiled(r#"<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"(?:/>|>([\s\S]*?)</a:srgbClr>)"#, "").captures(&properties);
    let gradient = first_group(&compiled(r#"<a:gradFill\b[\s\S]*?<a:gs\b[^>]*><a:srgbClr val="([0-9A-Fa-f]{6})""#, ""), &properties);
    let solid_color = solid.as_ref().and_then(|found| found.get(1)).map(str::to_owned);
    let mut own_fill = gradient.or_else(|| solid_color.clone()).unwrap_or_default();
    let alpha = match (&solid, &solid_color) {
        (Some(found), Some(color)) if &own_fill == color => {
            let stated = first_group(&compiled(r#"<a:alpha val="(\d+)""#, ""), found.get(2).unwrap_or(""));
            stated.map_or(100_000.0, |value| string_to_number(&value)) / 100_000.0
        }
        _ => 1.0,
    };
    if !own_fill.is_empty() && alpha < 1.0 {
        let under = painted.iter().rev().find(|entry| covers_bounds(&entry.frame, bounds)).map(|entry| entry.color.as_str());
        let under = under.filter(|color| !color.is_empty()).unwrap_or(slide_background);
        if !under.is_empty() {
            own_fill = blend_hex(&own_fill, under, alpha);
        }
    }
    own_fill
}

/// `textInsets(bodyProperties)`: the insets of a text frame in points (`insetLeft`, `insetTop`, `insetRight`,
/// `insetBottom`). A bodyPr that states no inset takes PowerPoint's (7.2 pt at the sides, 3.6 pt top and bottom): the missing
/// attribute read as Number('') = 0, so every box written without insets was measured 14 pt wider and 7 pt taller than
/// PowerPoint lays it out, and fit_text reported a 24 pt paragraph fitted that still overflowed at 8 pt.
pub fn text_insets(body_properties: &str) -> Value {
    let inset = |name: &str, fallback: f64| -> f64 {
        let stated = xml_attribute(body_properties, name);
        if stated.is_empty() { fallback } else { from_emu(string_to_number(&stated), fallback) }
    };
    let mut insets = Map::new();
    for (key, name, fallback) in [
        ("insetLeft", "lIns", DEFAULT_TEXT_INSETS[0]),
        ("insetTop", "tIns", DEFAULT_TEXT_INSETS[1]),
        ("insetRight", "rIns", DEFAULT_TEXT_INSETS[2]),
        ("insetBottom", "bIns", DEFAULT_TEXT_INSETS[3]),
    ] {
        insets.insert(key.to_owned(), json_number(inset(name, fallback)));
    }
    Value::Object(insets)
}

/// What a page collects while its shapes are read.
struct Page {
    boxes: Vec<Value>,
    content: Vec<Value>,
    painted: Vec<Painted>,
    background: String,
    slide_id: f64,
}

fn located(slide: usize, shape: usize) -> Map<String, Value> {
    let mut at = Map::new();
    at.insert("slide".to_owned(), Value::from(slide));
    at.insert("shape".to_owned(), Value::from(shape));
    at
}

/// Records one top-level shape on the page: every visible object joins the balance read (`content`), and a text-bearing
/// shape also becomes a box.
fn inspect_pptx_shape(shape: &Element, slide: usize, number: usize, page: &mut Page) {
    // A shape PowerPoint hides is not on the page: measuring it reports overflow, contrast, and collisions about something no
    // reader sees, and the fix round then chases an invisible box.
    if compiled(r#"<p:cNvPr\b[^>]*\bhidden="(?:1|true)""#, "").is_match(&shape.xml) {
        return;
    }
    let Some(bounds) = shape_frame(&shape.xml) else { return };
    if shape.name != "p:sp" {
        // The object's own name travels with its box: the kit signs the devices it draws (a motif, an orb, an icon) there, and
        // a page's balance is read against what carries it, not against its decoration.
        let object_name = first_group(&compiled(r#"<p:cNvPr\b[^>]*\bname="([^"]*)""#, ""), &shape.xml).unwrap_or_default();
        let mut entry = located(slide, number);
        entry.insert("kind".to_owned(), Value::String(shape.name.clone()));
        entry.insert("name".to_owned(), Value::String(object_name));
        bounds.put(&mut entry);
        page.content.push(Value::Object(entry));
        return;
    }
    let own_fill = shape_own_fill(&shape.xml, &bounds, &page.painted, &page.background);
    if !own_fill.is_empty() {
        page.painted.push(Painted { frame: bounds, color: own_fill.clone() });
    }
    let paragraphs = shape_paragraphs(&shape.xml);
    let has_text = paragraphs.as_ref().is_some_and(|list| list.iter().any(|paragraph| !js_trim(&text_or_empty(paragraph.get("text"))).is_empty()));
    if !own_fill.is_empty() || has_text {
        let mut entry = located(slide, number);
        entry.insert("kind".to_owned(), Value::from("p:sp"));
        bounds.put(&mut entry);
        page.content.push(Value::Object(entry));
    }
    let Some(paragraphs) = paragraphs.filter(|list| !list.is_empty()) else { return };
    let covering = page.painted.iter().rev().find(|entry| entry.color != own_fill && covers_bounds(&entry.frame, &bounds)).map(|entry| entry.color.clone());
    let body_properties = first_group(&compiled(r"<a:bodyPr\b([^>]*?)/?>", ""), &shape.xml).unwrap_or_default();
    let identity = shape_identity(&shape.xml);
    let mut entry = Map::new();
    entry.insert("shapeId".to_owned(), Value::String(identity.shape_id));
    if let Some(relation) = identity.relation {
        entry.insert("relation".to_owned(), relation);
    }
    if let Some(error) = identity.relation_error {
        entry.insert("relationError".to_owned(), Value::from(error));
    }
    entry.insert("slideId".to_owned(), json_number(page.slide_id));
    entry.extend(located(slide, number));
    bounds.put(&mut entry);
    if let Value::Object(insets) = text_insets(&body_properties) {
        entry.extend(insets);
    }
    entry.insert("wrap".to_owned(), Value::Bool(xml_attribute(&body_properties, "wrap") != "none"));
    entry.insert(
        "autofit".to_owned(),
        Value::Bool(compiled(r"<a:normAutofit\b", "").is_match(&shape.xml) || compiled(r"<a:spAutoFit\b", "").is_match(&shape.xml)),
    );
    let background = if !own_fill.is_empty() { own_fill } else { covering.filter(|color| !color.is_empty()).unwrap_or_else(|| page.background.clone()) };
    entry.insert("background".to_owned(), Value::String(background));
    entry.insert("paragraphs".to_owned(), Value::Array(paragraphs));
    page.boxes.push(Value::Object(entry));
}

/// `inspectPptxTextBoxes(zip)`: every text box of every visible slide with its geometry in points (`boxes`), every other
/// visible object (`content`), and the slide size.
pub fn inspect_pptx_text_boxes(zip: &Package) -> Result<Value, String> {
    let slides = presentation_slides(zip);
    let presentation = zip.text("ppt/presentation.xml");
    let size = compiled(r#"<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "").captures(&presentation);
    let mut page = Page { boxes: Vec::new(), content: Vec::new(), painted: Vec::new(), background: String::new(), slide_id: 0.0 };
    for (index, slide) in slides.iter().enumerate() {
        let xml = zip.text(&slide.path);
        // A slide the deck hides is skipped by every renderer and by the export, so measuring it reports contrast, fit, and
        // balance defects about a page no reader ever sees.
        if compiled(r#"<p:sld\b[^>]*\bshow="(?:0|false)""#, "").is_match(&xml) {
            continue;
        }
        let background = resolve_slide_background(zip, &slide.path, &xml)?;
        let Some(tree) = container_inner(&xml, "p:spTree", 0) else { continue };
        page.painted.clear();
        page.background = background;
        page.slide_id = slide.id;
        for (shape_index, shape) in top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS).iter().enumerate() {
            inspect_pptx_shape(shape, index + 1, shape_index + 1, &mut page);
        }
    }
    let dimension = |at: usize| size.as_ref().map_or(0.0, |found| string_to_number(found.get(at).unwrap_or("")) / EMU_PER_POINT);
    Ok(json!({
        "boxes": page.boxes,
        "content": page.content,
        "slideWidth": json_number(dimension(1)),
        "slideHeight": json_number(dimension(2)),
    }))
}

/// `setTableCellText(cell, text)`: the cell's first text node holds the text and the others are emptied; a cell with no text
/// node gets a run in its first paragraph (or a paragraph in its text body).
fn set_table_cell_text(cell: &str, text: &Value) -> Result<String, String> {
    let value = text_or_empty(Some(text));
    let mut nodes = text_nodes(cell, "a:t");
    if !nodes.is_empty() {
        nodes[0].text = value;
        for node in nodes.iter_mut().skip(1) {
            node.text = String::new();
        }
        return Ok(rebuild_text_nodes(cell, "a:t", &nodes));
    }
    let spaced = value.chars().next().is_some_and(mixdog_js::is_js_space) || value.chars().next_back().is_some_and(mixdog_js::is_js_space);
    let run = format!("<a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t{}>{}</a:t></a:r>", if spaced { " xml:space=\"preserve\"" } else { "" }, xml_encode(&value));
    if let Some(range) = compiled(r"<a:p(?:\s[^>]*)?>[\s\S]*?</a:p>", "").find(cell) {
        let paragraph = &cell[range.clone()];
        let replaced = match paragraph.strip_suffix("</a:p>") {
            Some(head) => format!("{head}{run}</a:p>"),
            None => paragraph.to_owned(),
        };
        return Ok(format!("{}{replaced}{}", &cell[..range.start], &cell[range.end..]));
    }
    if !cell.contains("</a:txBody>") {
        return Err("PPTX table cell has no text body".to_owned());
    }
    Ok(cell.replacen("</a:txBody>", &format!("<a:p>{run}</a:p></a:txBody>"), 1))
}

const MISSING_PART: &str = "Cannot read properties of undefined (reading 'xml')";

/// `Number(/\bw="(\d+)"/.exec(text)?.[1]) || 0`.
fn stated_width(text: &str) -> f64 {
    let width = first_group(&compiled(r#"\bw="(\d+)""#, ""), text).map_or(f64::NAN, |value| string_to_number(&value));
    if width.is_nan() { 0.0 } else { width }
}

/// `setTableValues(shapeXml, values)`: the table of a graphic frame filled from rows of cell text. Data wider or longer than
/// the table grows it: a new column repeats the last one (its cells' formatting), a new row repeats the last row. The rows
/// past the table's end had been dropped, so a refresh with one more hub lost that hub. The table grows down; its width is
/// the page's, and the columns it gains share it with the others: a template's three-column table given four columns ran past
/// the slide's edge and cut the last one off. Answers `{ xml, rows, cells, capacity, addedRows?, addedColumns?, addedHeight,
/// removedRows? }`.
pub fn set_table_values(shape_xml: &str, values: &[Value]) -> Result<Value, String> {
    let table = container_inner(shape_xml, "a:tbl", 0).ok_or_else(|| "PPTX shape does not contain a table".to_owned())?;
    let rows = element_spans(&table.inner, "a:tr");
    if rows.is_empty() {
        return Err("PPTX table has no rows".to_owned());
    }
    let (mut inner, filled_rows, filled_cells, removed_rows) = fill_table_rows(&table.inner, &rows, values)?;
    let added_columns = values.iter().filter_map(Value::as_array).map(Vec::len).max().unwrap_or(0).saturating_sub(element_spans(&inner, "a:gridCol").len());
    if added_columns > 0 {
        inner = grow_table_columns(&inner, values, added_columns)?;
    }
    let (inner, appended, added_height) = append_table_rows(&inner, values)?;
    let mut answer = Map::new();
    answer.insert("xml".to_owned(), Value::String(format!("{}{inner}{}", &shape_xml[..table.start], &shape_xml[table.end..])));
    answer.insert("rows".to_owned(), Value::from(filled_rows + appended));
    answer.insert("cells".to_owned(), Value::from(filled_cells));
    answer.insert("capacity".to_owned(), Value::from(rows.len()));
    if appended > 0 {
        answer.insert("addedRows".to_owned(), Value::from(appended));
    }
    if added_columns > 0 {
        answer.insert("addedColumns".to_owned(), Value::from(added_columns));
    }
    answer.insert("addedHeight".to_owned(), json_number(added_height));
    if removed_rows > 0 {
        answer.insert("removedRows".to_owned(), Value::from(removed_rows));
    }
    Ok(Value::Object(answer))
}

/// The table's rows filled from `values` (rows past the data are removed); answers the XML, the rows and cells filled and the rows removed.
fn fill_table_rows(table_inner: &str, rows: &[crate::xml::Span], values: &[Value]) -> Result<(String, usize, usize, usize), String> {
    let mut inner = table_inner.to_owned();
    let mut filled_rows = 0_usize;
    let mut filled_cells = 0_usize;
    let mut removed_rows = 0_usize;
    for row_index in (0..rows.len()).rev() {
        let row = &rows[row_index];
        let Some(source) = values.get(row_index).and_then(Value::as_array) else {
            if row_index >= values.len() {
                inner = format!("{}{}", &inner[..row.start], &inner[row.end..]);
                removed_rows += 1;
            }
            continue;
        };
        let mut body = container_body(&row.xml, "a:tr");
        let cells = element_spans(&body, "a:tc");
        for cell_index in (0..cells.len()).rev() {
            let cell = &cells[cell_index];
            let text = source.get(cell_index).cloned().unwrap_or_else(|| Value::from(""));
            body = format!("{}{}{}", &body[..cell.start], set_table_cell_text(&cell.xml, &text)?, &body[cell.end..]);
            filled_cells += 1;
        }
        let attrs = first_group(&compiled(r"^<a:tr\b([^>]*?)(?:/>|>)", ""), &row.xml).unwrap_or_default();
        inner = format!("{}<a:tr{attrs}>{body}</a:tr>{}", &inner[..row.start], &inner[row.end..]);
        filled_rows += 1;
    }
    Ok((inner, filled_rows, filled_cells, removed_rows))
}

/// `added_columns` copies of the last column appended to the grid and every row, the grid's width shared among all columns.
fn grow_table_columns(table_inner: &str, values: &[Value], added_columns: usize) -> Result<String, String> {
    let mut inner = table_inner.to_owned();
    let grid = element_spans(&inner, "a:gridCol");
    let last = grid.last().ok_or_else(|| MISSING_PART.to_owned())?;
    let frame: f64 = grid.iter().fold(0.0, |total, column| total + stated_width(&column.xml));
    let mut widths: Vec<f64> = grid.iter().map(|column| stated_width(&column.xml)).collect();
    widths.extend(std::iter::repeat_n(stated_width(&last.xml), added_columns));
    let grown = widths.iter().fold(0.0, |total, width| total + width);
    let mut shared: Vec<f64> = widths.iter().map(|width| if grown != 0.0 { math::round(width * frame / grown) } else { *width }).collect();
    if grown != 0.0 {
        let sum = shared.iter().fold(0.0, |total, width| total + width);
        if let Some(end) = shared.last_mut() {
            *end += frame - sum;
        }
    }
    inner = format!("{}{}{}", &inner[..last.end], last.xml.repeat(added_columns), &inner[last.end..]);
    let column = Cell::new(0_usize);
    inner = compiled(r#"<a:gridCol\b([^>]*?)\bw="\d+""#, "g").replace_all_with(&inner, |found| {
        let at = column.get();
        column.set(at + 1);
        format!("<a:gridCol{}w=\"{}\"", found.get(1).unwrap_or(""), shared.get(at).map_or_else(|| "undefined".to_owned(), |width| num(*width)))
    });
    let current = element_spans(&inner, "a:tr");
    for row_index in (0..current.len()).rev() {
        let row = &current[row_index];
        let cells = element_spans(&row.xml, "a:tc");
        let last_cell = cells.last().ok_or_else(|| MISSING_PART.to_owned())?;
        let source = values.get(row_index).and_then(Value::as_array);
        let mut extra = String::new();
        for offset in 0..added_columns {
            let text =
                source.and_then(|cells_of| cells_of.get(cells.len() + offset)).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::from(""));
            extra.push_str(&set_table_cell_text(&last_cell.xml, &text)?);
        }
        let next_row = format!("{}{extra}{}", &row.xml[..last_cell.end], &row.xml[last_cell.end..]);
        inner = format!("{}{next_row}{}", &inner[..row.start], &inner[row.end..]);
    }
    Ok(inner)
}

/// The rows `values` holds beyond the table, each a copy of the last row; answers the XML, the rows added and their height.
fn append_table_rows(table_inner: &str, values: &[Value]) -> Result<(String, usize, f64), String> {
    let mut inner = table_inner.to_owned();
    let mut added_height = 0.0;
    let current = element_spans(&inner, "a:tr");
    let mut appended = Vec::new();
    for source in values.iter().skip(current.len()) {
        let template = current.last().ok_or_else(|| MISSING_PART.to_owned())?;
        let cells = element_spans(&template.xml, "a:tc");
        let mut body = template.xml.clone();
        for cell_index in (0..cells.len()).rev() {
            let cell = &cells[cell_index];
            let text =
                source.as_array().and_then(|cells_of| cells_of.get(cell_index)).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::from(""));
            body = format!("{}{}{}", &body[..cell.start], set_table_cell_text(&cell.xml, &text)?, &body[cell.end..]);
        }
        added_height += first_group(&compiled(r#"^<a:tr\b[^>]*\bh="(\d+)""#, ""), &template.xml).map_or(0.0, |value| string_to_number(&value));
        appended.push(body);
    }
    if let (false, Some(template)) = (appended.is_empty(), current.last()) {
        inner = format!("{}{}{}", &inner[..template.end], appended.concat(), &inner[template.end..]);
    }
    Ok((inner, appended.len(), added_height))
}

/// `shapeFrame(shapeXml)`: the shape's offset and extent in points, or `None` when it states none.
pub fn shape_frame(shape_xml: &str) -> Option<Frame> {
    let offset = compiled(r#"<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)""#, "").captures(shape_xml)?;
    let extent = compiled(r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "").captures(shape_xml)?;
    let points = |found: &mixdog_js::Caps, at: usize| string_to_number(found.get(at).unwrap_or("")) / EMU_PER_POINT;
    Some(Frame { left: points(&offset, 1), top: points(&offset, 2), width: points(&extent, 1), height: points(&extent, 2) })
}

/// `presentationSlideSize(zip)`: the slide size in points (960 by 540 when the presentation states none).
pub fn presentation_slide_size(zip: &Package) -> (f64, f64) {
    let presentation = zip.text("ppt/presentation.xml");
    match compiled(r#"<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "").captures(&presentation) {
        Some(found) => (string_to_number(found.get(1).unwrap_or("")) / EMU_PER_POINT, string_to_number(found.get(2).unwrap_or("")) / EMU_PER_POINT),
        None => (960.0, 540.0),
    }
}

/// `selectedShapeSpans(tree, numbers)`: every top-level shape of the tree, and the ones the 1-based numbers select, in the
/// order named. An error for a number with no shape.
pub fn selected_shape_spans(tree: &Container, numbers: &[Value]) -> Result<(Vec<Element>, Vec<Element>), String> {
    let shapes = top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS);
    let mut selected = Vec::new();
    for number in numbers {
        let index = to_number(number) - 1.0;
        let shape = if index.fract() == 0.0 && index >= 0.0 { shapes.get(index as usize) } else { None };
        match shape {
            Some(shape) => selected.push(shape.clone()),
            None => return Err(format!("PPTX shape {} not found", value_to_string(number))),
        }
    }
    Ok((shapes, selected))
}

/// `writeShapeTree(slideXml, tree, shapes)`: the slide with its shape tree's content replaced by the shapes.
pub fn write_shape_tree(slide_xml: &str, tree: &Container, shapes: &[String]) -> String {
    format!("{}{}{}", &slide_xml[..tree.start], shapes.concat(), &slide_xml[tree.end..])
}

/// `appendSlideShape(xml, shape)`: the shape put last in the slide's shape tree.
pub fn append_slide_shape(xml: &str, shape: &str) -> Result<String, String> {
    if !xml.contains("</p:spTree>") {
        return Err("PPTX slide shape tree is missing".to_owned());
    }
    Ok(xml.replacen("</p:spTree>", &format!("{shape}</p:spTree>"), 1))
}

/// `setSlideBackground(xml, color)`: the slide's solid background set (replaced, or placed first in the slide's common data).
pub fn set_slide_background(xml: &str, color: Option<&Value>) -> Result<String, String> {
    let background = background_xml(color)?;
    if let Some(existing) = compiled(r"<p:bg\b[^>]*?(?:/>|>[\s\S]*?</p:bg>)", "").find(xml) {
        return Ok(format!("{}{background}{}", &xml[..existing.start], &xml[existing.end..]));
    }
    let common = compiled(r"<p:cSld\b[^>]*?>", "").find(xml).ok_or_else(|| "PPTX slide is missing its common slide data".to_owned())?;
    Ok(format!("{}{background}{}", &xml[..common.end], &xml[common.end..]))
}

const SHAPE_FILLS: [&str; 6] = ["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"];

/// `updateShapeGeometry(shape, properties)`: the shape with its description (`altText`), frame (`left`, `top`, `width`,
/// `height`, `rotation`) and fill (`fillColor`, `fillTransparency`) set from the properties.
pub fn update_shape_geometry(shape: &str, properties: &Value) -> String {
    let described = with_alt_text(shape, properties);
    let framed = with_frame(&described, properties);
    with_fill(&framed, properties)
}

/// Alternative text lives on the shape's name element, and a reader (or the audit that asks for it) has no other place to look.
fn with_alt_text(shape: &str, properties: &Value) -> String {
    let mut next = shape.to_owned();
    if is_set(properties.get("altText")) {
        let description = text_or_empty(properties.get("altText"));
        next = crate::slide_shapes::replace_first_with(&compiled(r"<p:cNvPr\b[^>]*?(/?)>", ""), &next, |found| {
            let matched = found.get(0).unwrap_or("");
            let self_closing = found.get(1) == Some("/");
            let cleaned = remove_first(&compiled(r#"\s+descr="[^"]*""#, ""), matched);
            let head = &cleaned[..cleaned.len() - if self_closing { 2 } else { 1 }];
            let described = if description.is_empty() { String::new() } else { format!(" descr=\"{}\"", xml_encode(&description)) };
            format!("{head}{described}{}", if self_closing { "/>" } else { ">" })
        });
    }
    next
}

/// The frame (`left`, `top`, `width`, `height`, `rotation`) written where the shape keeps its geometry.
fn with_frame(shape: &str, properties: &Value) -> String {
    let mut next = shape.to_owned();
    if ["left", "top", "width", "height", "rotation"].iter().any(|key| is_set(properties.get(*key))) {
        // A chart or a table sits in a graphic frame, and a frame keeps its geometry in <p:xfrm> where a shape or picture keeps
        // it in <a:xfrm>. Writing the shape form left the chart exactly where it was and answered that nothing had changed, so
        // a page could not be rebalanced around it.
        let frame_tag = if compiled(r"<p:graphicFrame[\s>]", "").is_match(&next) { "p:xfrm" } else { "a:xfrm" };
        let current = compiled(&format!(r"<{frame_tag}\b[^>]*?(?:/>|>[\s\S]*?</{frame_tag}>)"), "").find(&next);
        let current_text = current.clone().map(|range| next[range].to_owned());
        let offset = current_text.as_deref().and_then(|text| {
            compiled(r#"<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)""#, "")
                .captures(text)
                .map(|found| (found.get(1).unwrap_or("").to_owned(), found.get(2).unwrap_or("").to_owned()))
        });
        let extent = current_text.as_deref().and_then(|text| {
            compiled(r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "")
                .captures(text)
                .map(|found| (found.get(1).unwrap_or("").to_owned(), found.get(2).unwrap_or("").to_owned()))
        });
        let current_rotation = {
            let stated = string_to_number(&current_text.as_deref().map(|text| xml_attribute(text, "rot")).unwrap_or_default());
            if stated.is_nan() { 0.0 } else { stated }
        };
        let rotation = if is_set(properties.get("rotation")) { math::round(to_number_of(properties.get("rotation")) * 60_000.0) } else { current_rotation };
        let stated = |value: Option<&String>, fallback: f64| -> f64 { value.map_or(fallback, |text| string_to_number(text)) };
        let coordinate = |key: &str, value: Option<&String>| -> String {
            if is_set(properties.get(key)) { num(to_emu_of(properties.get(key))) } else { num(stated(value, 0.0)) }
        };
        let size = |key: &str, value: Option<&String>| -> String {
            if is_set(properties.get(key)) { num(to_emu_of(properties.get(key))) } else { num(stated(value, 1.0)) }
        };
        let frame = format!(
            "<{frame_tag}{}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></{frame_tag}>",
            if rotation != 0.0 && !rotation.is_nan() { format!(" rot=\"{}\"", num(rotation)) } else { String::new() },
            coordinate("left", offset.as_ref().map(|found| &found.0)),
            coordinate("top", offset.as_ref().map(|found| &found.1)),
            size("width", extent.as_ref().map(|found| &found.0)),
            size("height", extent.as_ref().map(|found| &found.1)),
        );
        if let Some(range) = current {
            next = format!("{}{frame}{}", &next[..range.start], &next[range.end..]);
        } else if frame_tag == "p:xfrm" {
            next = next.replacen("</p:nvGraphicFramePr>", &format!("</p:nvGraphicFramePr>{frame}"), 1);
        } else {
            next = crate::slide_shapes::replace_first_with(&compiled(r"<p:spPr(?:\s[^>]*)?>", ""), &next, |found| {
                format!("{}{frame}", found.get(0).unwrap_or(""))
            });
        }
    }
    next
}

/// The shape's own fill (`fillColor`, `fillTransparency`) replaced, ahead of its outline and effects.
fn with_fill(shape: &str, properties: &Value) -> String {
    let mut next = shape.to_owned();
    // A transparency alone keeps the fill's colour, as the Office backend's Fill.Transparency does; it was dropped here.
    let fill_color: Option<Value> = match properties.get("fillColor").filter(|value| !value.is_null()) {
        Some(color) => Some(color.clone()),
        None if is_set(properties.get("fillTransparency")) => {
            let inside = container_inner(&next, "p:spPr", 0).map(|found| found.inner).unwrap_or_default();
            let without_line = remove_first(&compiled(r"<a:ln\b[^>]*?(?:/>|>[\s\S]*?</a:ln>)", ""), &inside);
            first_group(&compiled(r#"<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, ""), &without_line).map(Value::String)
        }
        None => None,
    };
    // fillColor: null takes the fill away (the Office backend's Fill.Visible = 0), as add_shape reads it. Only the shape's own
    // fill is replaced: the first solidFill anywhere in its properties could be its outline's colour, and a shape that
    // inherited its fill lost the colour of its line.
    let clearing = properties.get("fillColor") == Some(&Value::Null);
    if fill_color.is_some() || clearing {
        let shape_properties = container_inner(&next, "p:spPr", 0);
        let fill = if clearing { "<a:noFill/>".to_owned() } else { solid_fill_xml(fill_color.as_ref(), properties.get("fillTransparency")) };
        if let Some(shape_properties) = shape_properties.filter(|_| !fill.is_empty()) {
            let mut cleaned = shape_properties.inner.clone();
            for element in top_level_elements(&cleaned.clone(), &SHAPE_FILLS).iter().rev() {
                cleaned = format!("{}{}", &cleaned[..element.start], &cleaned[element.end..]);
            }
            let later = top_level_elements(&cleaned, &["a:ln", "a:effectLst", "a:effectDag", "a:scene3d", "a:sp3d", "a:extLst"]);
            let position = later.first().map_or(cleaned.len(), |element| element.start);
            let inner = format!("{}{fill}{}", &cleaned[..position], &cleaned[position..]);
            next = format!("{}{inner}{}", &next[..shape_properties.start], &next[shape_properties.end..]);
        }
    }
    next
}

/// `nextShapeId(xml)`: one more than the highest shape id the slide uses.
pub fn next_shape_id(xml: &str) -> f64 {
    compiled(r#"\bcNvPr\s+id="(\d+)""#, "g").captures_iter(xml).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(1.0, math::max) + 1.0
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn cell(text: &str) -> String {
        format!("<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>{text}</a:t></a:r></a:p></a:txBody></a:tc>")
    }

    fn table(rows: &[&[&str]], widths: &[u32]) -> String {
        let grid: String = widths.iter().map(|width| format!("<a:gridCol w=\"{width}\"/>")).collect();
        let body: String = rows.iter().map(|row| format!("<a:tr h=\"100\">{}</a:tr>", row.iter().map(|text| cell(text)).collect::<String>())).collect();
        format!("<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid>{grid}</a:tblGrid>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>")
    }

    fn texts(xml: &str) -> Vec<String> {
        compiled(r"<a:t>([^<]*)</a:t>", "g").captures_iter(xml).map(|found| found.get(1).unwrap_or("").to_owned()).collect()
    }

    #[test]
    fn set_table_values_fills_cells_in_place() {
        let shape = table(&[&["a", "b"], &["c", "d"]], &[3000, 3000]);
        let done = set_table_values(&shape, &[json!(["w", "x"]), json!(["y", "z"])]).unwrap();
        assert_eq!((done["rows"].clone(), done["cells"].clone(), done["capacity"].clone()), (json!(2), json!(4), json!(2)));
        assert_eq!(done["addedHeight"], json!(0));
        assert!(done.get("addedRows").is_none() && done.get("addedColumns").is_none() && done.get("removedRows").is_none());
        assert_eq!(texts(done["xml"].as_str().unwrap()), ["w", "x", "y", "z"]);
    }

    #[test]
    fn set_table_values_grows_columns_and_rows_and_shares_the_width() {
        let shape = table(&[&["a", "b"], &["c", "d"]], &[3000, 3000]);
        let done = set_table_values(&shape, &[json!(["1", "2", "3"]), json!(["4", "5", "6"]), json!(["7", "8", "9"])]).unwrap();
        assert_eq!((done["addedColumns"].clone(), done["addedRows"].clone(), done["addedHeight"].clone()), (json!(1), json!(1), json!(100)));
        let xml = done["xml"].as_str().unwrap();
        assert_eq!(texts(xml), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        assert_eq!(xml.matches("<a:gridCol w=\"2000\"/>").count(), 3);
    }

    #[test]
    fn set_table_values_drops_rows_the_data_does_not_reach() {
        let shape = table(&[&["a", "b"], &["c", "d"]], &[3000, 3000]);
        let done = set_table_values(&shape, &[json!(["w"])]).unwrap();
        assert_eq!(done["removedRows"], json!(1));
        assert_eq!(done["rows"], json!(1));
        assert_eq!(texts(done["xml"].as_str().unwrap()), ["w", ""]);
    }

    #[test]
    fn set_table_values_refuses_a_shape_without_a_table() {
        assert_eq!(set_table_values("<p:sp/>", &[]).unwrap_err(), "PPTX shape does not contain a table");
    }

    const SHAPE: &str = "<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Box\"/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"100\" y=\"200\"/><a:ext cx=\"300\" cy=\"400\"/></a:xfrm><a:ln><a:solidFill><a:srgbClr val=\"00FF00\"/></a:solidFill></a:ln></p:spPr></p:sp>";

    #[test]
    fn update_shape_geometry_sets_the_description_on_the_name_element() {
        let described = update_shape_geometry(SHAPE, &json!({ "altText": "A box" }));
        assert!(described.contains("<p:cNvPr id=\"2\" name=\"Box\" descr=\"A box\"/>"), "{described}");
        let cleared = update_shape_geometry(&described, &json!({ "altText": "" }));
        assert!(!cleared.contains("descr="), "{cleared}");
    }

    #[test]
    fn update_shape_geometry_moves_one_edge_and_keeps_the_rest_of_the_frame() {
        let moved = update_shape_geometry(SHAPE, &json!({ "left": 10 }));
        assert!(moved.contains("<a:xfrm><a:off x=\"127000\" y=\"200\"/><a:ext cx=\"300\" cy=\"400\"/></a:xfrm>"), "{moved}");
        let turned = update_shape_geometry(SHAPE, &json!({ "rotation": 90 }));
        assert!(turned.contains("<a:xfrm rot=\"5400000\"><a:off x=\"100\" y=\"200\"/><a:ext cx=\"300\" cy=\"400\"/></a:xfrm>"), "{turned}");
    }

    #[test]
    fn update_shape_geometry_writes_a_graphic_frame_geometry_as_p_xfrm() {
        let frame = "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"3\" name=\"Chart\"/></p:nvGraphicFramePr></p:graphicFrame>";
        let placed = update_shape_geometry(frame, &json!({ "left": 1, "top": 2, "width": 3, "height": 4 }));
        assert!(placed.contains("</p:nvGraphicFramePr><p:xfrm><a:off x=\"12700\" y=\"25400\"/><a:ext cx=\"38100\" cy=\"50800\"/></p:xfrm>"), "{placed}");
    }

    #[test]
    fn update_shape_geometry_replaces_the_shape_fill_ahead_of_its_outline() {
        let filled = update_shape_geometry(SHAPE, &json!({ "fillColor": "FF0000" }));
        let fill = filled.find("<a:solidFill><a:srgbClr val=\"FF0000\"").expect("a fill");
        assert!(fill < filled.find("<a:ln>").unwrap(), "{filled}");
        assert!(filled.contains("<a:ln><a:solidFill><a:srgbClr val=\"00FF00\"/>"), "{filled}");
        let cleared = update_shape_geometry(&filled, &json!({ "fillColor": null }));
        assert!(cleared.contains("<a:noFill/><a:ln>") && !cleared.contains("FF0000"), "{cleared}");
    }

    #[test]
    fn update_shape_geometry_keeps_the_fill_colour_when_only_transparency_is_given() {
        let filled = update_shape_geometry(SHAPE, &json!({ "fillColor": "FF0000" }));
        let faded = update_shape_geometry(&filled, &json!({ "fillTransparency": 50 }));
        assert!(faded.contains("<a:srgbClr val=\"FF0000\"><a:alpha val=\"50000\"/>"), "{faded}");
    }
}
