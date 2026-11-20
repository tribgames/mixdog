//! `portable/portable-pptx-shapes.mjs`: the operations that edit the shapes of one slide of a presentation. Each takes the
//! package, the slides the presentation lists and the operation (`serde_json::Value`, read the way the script reads it:
//! `??`, `Number(...)`, `String(...)`, truthiness) and answers the JSON the script answered. The slide XML is edited as text
//! at the offsets of the shape tree, so the text written equals the text Node writes. Operations that read a picture or a
//! media file take a read proof; `fit_text` takes the measurer whose faces decide how large a text fits.

use std::collections::HashMap;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::{js_sort_by, js_to_lowercase, js_trim, json_number, math, string_to_number, to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::image_layout::resolve_image_layout;
use crate::opc::{add_package_relationship, ensure_default_content_type, image_pixel_size, part_relationship_path, posix, remove_package_relationship};
use crate::package::os_message;
use crate::pptx_core::{
    Frame, append_slide_shape, next_shape_id, presentation_slide_size, selected_shape_spans, set_table_values, shape_frame, shape_paragraphs, text_insets,
    update_shape_geometry, write_shape_tree,
};
use crate::pptx_package::{SlideRef, add_slide_image, slide_path};
use crate::slide_shapes::{
    EMU_PER_POINT, SLIDE_SHAPE_TAGS, first_group, num, picture_xml, remove_first, replace_first_text, replace_first_with, resolve_geometry, restyle_shape_text,
    restyled_paragraphs, shape_xml, solid_fill_xml, supported_shape_types, table_xml, text_anchor, text_body_xml, text_if_truthy, text_of, text_or_empty,
    to_emu,
};
use crate::text_metrics::{Paragraph, Run, ShrinkOptions, TextMeasurer, contrast_ratio};
use crate::xml::{
    Container, DRAWING_MAIN_NS, Element, OFFICE_RELATIONSHIP_BASE, compiled, container_body, container_inner, rebuild_text_nodes, text_nodes,
    top_level_elements, xml_encode,
};
use crate::zipio::Package;

// ---- what every operation shares ----------------------------------------------------------------------------------

/// The slide's shape tree with the slide XML it was read from.
struct SlideTree {
    path: String,
    current: String,
    tree: Container,
}

/// `slidePath(slides, op.slide)`.
fn slide_path_of(slides: &[SlideRef], op: &Value) -> Result<String, String> {
    match op.get("slide") {
        Some(number) => slide_path(slides, number),
        None => Err("PPTX slide undefined not found".to_owned()),
    }
}

/// `slideShapeTree(context, op)`.
fn slide_shape_tree(zip: &Package, slides: &[SlideRef], op: &Value) -> Result<SlideTree, String> {
    let path = slide_path_of(slides, op)?;
    let current = zip.text(&path);
    let tree = container_inner(&current, "p:spTree", 0).ok_or_else(|| "PPTX slide shape tree is missing".to_owned())?;
    Ok(SlideTree { path, current, tree })
}

/// `array[Number(value) - 1]`'s index: `None` for a position no array element has.
fn position(value: Option<&Value>) -> Option<usize> {
    let index = to_number_of(value) - 1.0;
    if index.fract() == 0.0 && index >= 0.0 { Some(index as usize) } else { None }
}

/// `slideShape(tree, op)`: the top-level shape `op.shape` numbers.
fn slide_shape(tree: &Container, op: &Value) -> Result<Element, String> {
    let shapes = top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS);
    position(op.get("shape"))
        .and_then(|index| shapes.into_iter().nth(index))
        .ok_or_else(|| format!("PPTX shape {} not found on slide {}", text_of(op.get("shape")), text_of(op.get("slide"))))
}

/// `writeSlideTree(context, slide, inner)`.
fn write_slide_tree(zip: &mut Package, slide: &SlideTree, inner: &str) {
    zip.set(&slide.path, format!("{}{inner}{}", &slide.current[..slide.tree.start], &slide.current[slide.tree.end..]));
}

/// `writeShape(context, slide, shape, xml)`: the slide with one top-level shape replaced by `xml` (empty removes it).
fn write_shape(zip: &mut Package, slide: &SlideTree, shape: &Element, xml: &str) {
    let inner = format!("{}{xml}{}", &slide.tree.inner[..shape.start], &slide.tree.inner[shape.end..]);
    write_slide_tree(zip, slide, &inner);
}

/// `rewriteShapeTree(tree, shapes, replacementFor)`: the tree's inner XML with the selected shapes rewritten; the
/// replacement is a shape's new XML (empty drops it) or `None` to keep it as it is.
fn rewrite_shape_tree(tree: &Container, shapes: &[Element], replacement_for: impl Fn(&Element) -> Option<String>) -> String {
    let mut inner = String::new();
    let mut cursor = 0;
    for shape in shapes {
        let Some(replacement) = replacement_for(shape) else { continue };
        inner.push_str(&tree.inner[cursor..shape.start]);
        inner.push_str(&replacement);
        cursor = shape.end;
    }
    inner.push_str(&tree.inner[cursor..]);
    inner
}

/// A number as a value `selected_shape_spans` reads back to the same number and prints the same (`NaN` and the infinities as
/// the words).
fn numeric_of(number: f64) -> Value {
    if number.is_nan() {
        Value::from("NaN")
    } else if number.is_infinite() {
        Value::from(if number > 0.0 { "Infinity" } else { "-Infinity" })
    } else {
        json_number(number)
    }
}

/// `Number(value)` for `selected_shape_spans`.
fn numeric(value: &Value) -> Value {
    numeric_of(to_number(value))
}

/// `Number(op[key])` as the answer prints it (`NaN` is `null`).
fn number_of(op: &Value, key: &str) -> Value {
    json_number(to_number_of(op.get(key)))
}

/// The answer object: `op` first, then the fields.
fn reply(op: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut answer = Map::new();
    if let Some(name) = op.get("op") {
        answer.insert("op".to_owned(), name.clone());
    }
    for (key, value) in fields {
        answer.insert(key.to_owned(), value);
    }
    Value::Object(answer)
}

/// `a ?? b ?? c`: the first operand that is neither null nor absent, else the last operand as it is.
fn nullish(chain: &[Option<&Value>]) -> Option<Value> {
    chain.iter().flatten().find(|value| !value.is_null()).map(|value| (*value).clone()).or_else(|| chain.last().and_then(|last| last.cloned()))
}

/// `op.properties || {}` as an object (a value that is not an object reads as having no property).
fn properties_of(op: &Value) -> Map<String, Value> {
    op.get("properties").filter(|value| truthy(value)).and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `Math.min(...)` and `Math.max(...)` of the frames' edges.
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn frames_extent(frames: &[Frame]) -> Bounds {
    let mut bounds = Bounds { left: f64::INFINITY, top: f64::INFINITY, right: f64::NEG_INFINITY, bottom: f64::NEG_INFINITY };
    for frame in frames {
        bounds.left = math::min(bounds.left, frame.left);
        bounds.top = math::min(bounds.top, frame.top);
        bounds.right = math::max(bounds.right, frame.left + frame.width);
        bounds.bottom = math::max(bounds.bottom, frame.top + frame.height);
    }
    bounds
}

/// The path of a file an operation names, as `readFile` takes it.
fn source_path(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(path)) => Ok(path.clone()),
        other => {
            let received = match other {
                None => "undefined".to_owned(),
                Some(Value::Null) => "null".to_owned(),
                Some(number @ Value::Number(_)) => format!("type number ({})", value_to_string(number)),
                Some(Value::Bool(flag)) => format!("type boolean ({flag})"),
                Some(Value::Array(_)) => "an instance of Array".to_owned(),
                _ => "an instance of Object".to_owned(),
            };
            Err(format!("The \"path\" argument must be of type string or an instance of Buffer or URL. Received {received}"))
        }
    }
}

/// `readFile(path)`.
fn read_source<P: ReadProof>(proof: &P, path: &str) -> Result<Vec<u8>, String> {
    mixdog_fsio::read(proof, Path::new(path)).map_err(|error| os_message(&error, "open", Path::new(path)))
}

// ---- hyperlinks, order, alignment ---------------------------------------------------------------------------------

/// `handleSetHyperlink`: a shape's click link, to an address or a slide.
pub fn set_hyperlink(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let address = js_trim(&text_if_truthy(op.get("address"))).to_owned();
    let sub_address = op.get("subAddress").is_some_and(truthy);
    if address.is_empty() && !sub_address {
        return Err("set_hyperlink requires address or subAddress".to_owned());
    }
    let relationship_id = if address.is_empty() {
        String::new()
    } else {
        add_package_relationship(zip, &part_relationship_path(&slide.path), &format!("{OFFICE_RELATIONSHIP_BASE}/hyperlink"), &address, "External")
    };
    let link = format!(
        "<a:hlinkClick xmlns:a=\"{DRAWING_MAIN_NS}\"{}{}/>",
        if relationship_id.is_empty() { " r:id=\"\"".to_owned() } else { format!(" r:id=\"{relationship_id}\"") },
        if sub_address { " action=\"ppaction://hlinksldjump\"" } else { "" }
    );
    let without = remove_first(&compiled(r"<a:hlinkClick\b[^>]*?(?:/>|>[\s\S]*?</a:hlinkClick>)", ""), &shape.xml);
    let updated = replace_first_with(&compiled(r"<p:cNvPr\b([^>]*?)(/>|>)", ""), &without, |found| {
        let attributes = found.get(1).unwrap_or("");
        if found.get(2) == Some("/>") { format!("<p:cNvPr{attributes}>{link}</p:cNvPr>") } else { format!("<p:cNvPr{attributes}>{link}") }
    });
    write_shape(zip, &slide, &shape, &updated);
    Ok(reply(
        op,
        vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("shape", number_of(op, "shape")), ("address", Value::String(address))],
    ))
}

/// `handleZOrder`: a shape moved to the front or back, or one step forward or backward.
pub fn z_order(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let SlideTree { path, current, tree } = slide_shape_tree(zip, slides, op)?;
    let command = js_to_lowercase(&text_if_truthy(op.get("command")));
    if !["front", "back", "forward", "backward"].contains(&command.as_str()) {
        return Err("z_order command must be front, back, forward, or backward".to_owned());
    }
    let Some(wanted) = op.get("shape") else { return Err("PPTX shape undefined not found".to_owned()) };
    let (shapes, _) = selected_shape_spans(&tree, std::slice::from_ref(wanted))?;
    let index = position(Some(wanted)).unwrap_or(0);
    let mut ordered: Vec<String> = shapes.iter().map(|shape| shape.xml.clone()).collect();
    let moved = ordered.remove(index);
    let destination = match command.as_str() {
        "front" => ordered.len(),
        "back" => 0,
        other => {
            let step = if other == "forward" { 1.0 } else { -1.0 };
            math::max(0.0, math::min(ordered.len() as f64, index as f64 + step)) as usize
        }
    };
    ordered.insert(destination, moved);
    let preamble = tree.inner[..shapes.first().map_or(tree.inner.len(), |first| first.start)].to_owned();
    let mut written = vec![preamble];
    written.extend(ordered);
    zip.set(&path, write_shape_tree(&current, &tree, &written));
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("command", Value::String(command))]))
}

/// `alignPlacements`: each placement moved onto the requested edge or centre line of `bounds`.
fn align_placements(placements: &mut [Frame], bounds: &Bounds, op: &Value) -> Result<(), String> {
    let align = js_to_lowercase(&text_if_truthy(op.get("align")));
    let horizontal = match align.as_str() {
        "left" => Some(0.0),
        "center" => Some(0.5),
        "right" => Some(1.0),
        _ => None,
    };
    let vertical = match align.as_str() {
        "top" => Some(0.0),
        "middle" | "center" => Some(0.5),
        "bottom" => Some(1.0),
        _ => None,
    };
    if horizontal.is_none() && vertical.is_none() {
        return Err("align must be left, center, right, top, middle, or bottom".to_owned());
    }
    for placement in placements {
        if let Some(factor) = horizontal {
            placement.left = bounds.left + (bounds.right - bounds.left - placement.width) * factor;
        } else if let Some(factor) = vertical {
            placement.top = bounds.top + (bounds.bottom - bounds.top - placement.height) * factor;
        }
    }
    Ok(())
}

/// `distributePlacements`: the placements spread along one axis of `bounds` with equal gaps.
fn distribute_placements(placements: &mut [Frame], bounds: &Bounds, op: &Value) -> Result<(), String> {
    let direction = js_to_lowercase(&text_if_truthy(op.get("direction")));
    if !["horizontal", "vertical"].contains(&direction.as_str()) {
        return Err("distribute direction must be horizontal or vertical".to_owned());
    }
    let horizontal = direction == "horizontal";
    let mut order: Vec<usize> = (0..placements.len()).collect();
    js_sort_by(
        &mut order,
        |left, right| {
            if horizontal { placements[*left].left - placements[*right].left } else { placements[*left].top - placements[*right].top }
        },
    );
    let taken = order.iter().fold(0.0, |sum, at| sum + if horizontal { placements[*at].width } else { placements[*at].height });
    let total = if horizontal { bounds.right - bounds.left - taken } else { bounds.bottom - bounds.top - taken };
    let gap = total / math::max(1.0, order.len() as f64 - 1.0);
    let mut cursor = if horizontal { bounds.left } else { bounds.top };
    for at in order {
        if horizontal {
            placements[at].left = cursor;
            cursor += placements[at].width + gap;
        } else {
            placements[at].top = cursor;
            cursor += placements[at].height + gap;
        }
    }
    Ok(())
}

/// `handleAlignShapesOrDistributeShapes`: shapes aligned to an edge, or spread with equal gaps, within their own extent or
/// the slide.
pub fn align_shapes_or_distribute_shapes(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let numbers: Vec<Value> = op.get("shapes").and_then(Value::as_array).map(|list| list.iter().map(numeric).collect()).unwrap_or_default();
    let name = text_of(op.get("op"));
    if numbers.len() < 2 {
        return Err(format!("{name} requires at least two shapes"));
    }
    let (shapes, selected) = selected_shape_spans(&slide.tree, &numbers)?;
    let mut frames = Vec::with_capacity(selected.len());
    for shape in &selected {
        frames.push(shape_frame(&shape.xml).ok_or_else(|| format!("PPTX shape has no explicit position; {name} needs sized shapes"))?);
    }
    let (slide_width, slide_height) = presentation_slide_size(zip);
    let bounds = if op.get("relativeToSlide") == Some(&Value::Bool(true)) {
        Bounds { left: 0.0, top: 0.0, right: slide_width, bottom: slide_height }
    } else {
        frames_extent(&frames)
    };
    let mut placements = frames;
    if op.get("op").and_then(Value::as_str) == Some("align_shapes") {
        align_placements(&mut placements, &bounds, op)?;
    } else {
        distribute_placements(&mut placements, &bounds, op)?;
    }
    let mut updates: HashMap<usize, String> = HashMap::new();
    for (shape, placement) in selected.iter().zip(&placements) {
        let moved = json!({ "left": json_number(placement.left), "top": json_number(placement.top) });
        updates.insert(shape.start, update_shape_geometry(&shape.xml, &moved));
    }
    let inner = rewrite_shape_tree(&slide.tree, &shapes, |shape| updates.get(&shape.start).cloned());
    write_slide_tree(zip, &slide, &inner);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("shapes", Value::from(numbers.len()))]))
}

// ---- text -----------------------------------------------------------------------------------------------------------

/// `withSingleTextParagraph(shapeXml)`: PowerPoint's `TextRange.Text` leaves one paragraph, in the formatting of the one
/// that held the first text; the paragraphs around it go.
fn with_single_text_paragraph(shape: &str) -> String {
    let Some(body) = compiled(r"(<p:txBody\b[^>]*>)([\s\S]*?)(</p:txBody>)", "").captures(shape) else { return shape.to_owned() };
    let whole = body.range();
    let inside = body.get(2).unwrap_or("");
    let paragraphs: Vec<std::ops::Range<usize>> = compiled(r"<a:p\b[^>]*?(?:/>|>[\s\S]*?</a:p>)", "g").find_iter(inside).collect();
    if paragraphs.len() < 2 {
        return shape.to_owned();
    }
    let text_tag = compiled(r"<a:t\b", "");
    let kept = paragraphs.iter().find(|paragraph| text_tag.is_match(&inside[(*paragraph).clone()])).unwrap_or(&paragraphs[0]);
    let first = &paragraphs[0];
    let last = &paragraphs[paragraphs.len() - 1];
    let inner = format!("{}{}{}", &inside[..first.start], &inside[kept.clone()], &inside[last.end..]);
    format!("{}{}{inner}{}{}", &shape[..whole.start], body.get(1).unwrap_or(""), body.get(3).unwrap_or(""), &shape[whole.end..])
}

/// `handleSetText`: a shape's text replaced by one run, as PowerPoint's `TextRange.Text` leaves it.
pub fn set_text(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let single = with_single_text_paragraph(&shape.xml);
    let mut nodes = text_nodes(&single, "a:t");
    if nodes.is_empty() {
        return Err(format!("PPTX shape {} has no editable text", text_of(op.get("shape"))));
    }
    nodes[0].text = text_or_empty(op.get("text"));
    for node in nodes.iter_mut().skip(1) {
        node.text.clear();
    }
    // One run: the old text's line breaks and the runs it emptied go too, rather than standing on as a blank line under the
    // new words.
    let rebuilt = rebuild_text_nodes(&single, "a:t", &nodes);
    let breaks = compiled(r"<a:br\b[^>]*?(?:/>|>[\s\S]*?</a:br>)", "g");
    let emptied = compiled(r"<a:r>(?:(?!</a:r>)[\s\S])*?<a:t\b[^>]*?(?:/>|></a:t>)</a:r>", "g");
    let next = replace_first_with(&compiled(r"<p:txBody\b[^>]*>[\s\S]*?</p:txBody>", ""), &rebuilt, |body| {
        emptied.replace_all_with(&breaks.replace_all_with(body.get(0).unwrap_or(""), |_| String::new()), |_| String::new())
    });
    write_shape(zip, &slide, &shape, &next);
    Ok(reply(op, vec![("changed", Value::Bool(true))]))
}

/// `inkOnFill(fill)`: white on a dark card, near-black on a light one, nothing for a fill that is not six hex digits (the
/// inherited colour keeps deciding).
fn ink_on_fill(fill: Option<&Value>) -> Option<String> {
    let text = text_if_truthy(fill);
    let field = text.strip_prefix('#').unwrap_or(&text).to_uppercase();
    if field.len() != 6 || !field.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'A'..=b'F')) {
        return None;
    }
    let white = contrast_ratio("FFFFFF", &field).unwrap_or(0.0);
    let dark = contrast_ratio("1F2429", &field).unwrap_or(0.0);
    Some(if white >= dark { "FFFFFF" } else { "1F2429" }.to_owned())
}

/// `handleAddTextboxOrAddShape`.
pub fn add_textbox_or_shape(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let path = slide_path_of(slides, op)?;
    let current = zip.text(&path);
    let id = next_shape_id(&current);
    let properties = properties_of(op);
    let text_box = op.get("op").and_then(Value::as_str) == Some("add_textbox");
    let geometry = if text_box { "rect" } else { resolve_geometry(op.get("shapeType")) };
    if geometry.is_empty() {
        return Err(format!("Unsupported shapeType: {}. Use one of: {}", text_of(op.get("shapeType")), supported_shape_types().join(", ")));
    }
    let paragraphs = match op.get("paragraphs").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => Value::Array(list.clone()),
        _ => json!([{ "text": text_or_empty(op.get("text")) }]),
    };
    let supplied = js_trim(&text_if_truthy(op.get("name"))).to_owned();
    let name = if supplied.is_empty() { format!("Mixdog {} {}", if text_box { "TextBox" } else { "Shape" }, num(id)) } else { supplied };
    let property = |key: &str| properties.get(key);
    let default_left = json!(72);
    let default_width = json!(360);
    let default_height = json!(72);
    let default_size = json!(18);
    let mut merged = properties.clone();
    if !op.get("fillColor").is_none_or(Value::is_null) {
        merged.insert("fillColor".to_owned(), op["fillColor"].clone());
    }
    if let Some(line) = op.get("lineColor") {
        merged.insert("lineColor".to_owned(), line.clone());
    }
    // A caller who fills a shape and says nothing about its text gets ink the fill can carry: the default dark ink on a dark
    // card was text the runtime's own contrast check then reported as unreadable.
    let fill = nullish(&[op.get("fillColor"), property("fillColor")]);
    let ink = ink_on_fill(fill.as_ref()).map(Value::from);
    let mut defaults = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            defaults.insert(key.to_owned(), value);
        }
    };
    put("fontName", nullish(&[op.get("fontName"), property("fontName")]));
    put("fontSize", nullish(&[op.get("fontSize"), property("fontSize"), Some(&default_size)]));
    put("color", nullish(&[op.get("color"), property("color"), ink.as_ref()]));
    put("bold", property("bold").cloned());
    put("italic", property("italic").cloned());
    // `alignment` and `verticalAlignment` are the names the contract lists and the Office backend reads.
    put("align", nullish(&[property("alignment"), property("align")]));
    put("paragraphSpacing", property("paragraphSpacing").cloned());
    let truthy_or = |first: Option<&Value>, second: Option<&Value>, last: &str| -> Value {
        [first, second].into_iter().flatten().find(|value| truthy(value)).cloned().unwrap_or_else(|| Value::from(last))
    };
    let anchor = truthy_or(property("verticalAlignment"), property("anchor"), if text_box { "" } else { "center" });
    let autofit = truthy_or(property("autofit"), None, "none");
    let text_body = text_body_xml(&json!({
        "paragraphs": paragraphs,
        "defaults": Value::Object(defaults),
        "anchor": anchor,
        "margins": Value::Object(properties.clone()),
        "autofit": autofit,
    }));
    let mut options = Map::new();
    options.insert("id".to_owned(), json_number(id));
    options.insert("name".to_owned(), Value::String(name));
    options.insert("geometry".to_owned(), Value::from(geometry));
    for (key, fallback) in [("left", &default_left), ("top", &default_left), ("width", &default_width), ("height", &default_height)] {
        if let Some(value) = nullish(&[op.get(key), property(key), Some(fallback)]) {
            options.insert(key.to_owned(), value);
        }
    }
    options.insert("properties".to_owned(), Value::Object(merged));
    options.insert("textBody".to_owned(), Value::String(text_body));
    options.insert("textBox".to_owned(), Value::Bool(text_box));
    let shape = shape_xml(&Value::Object(options));
    zip.set(&path, append_slide_shape(&current, &shape)?);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("shapeId", json_number(id))]))
}

/// `handleDeleteShape`.
pub fn delete_shape(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    write_shape(zip, &slide, &shape, "");
    Ok(reply(op, vec![("changed", Value::Bool(true))]))
}

/// `handleAddTable`.
pub fn add_table(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let path = slide_path_of(slides, op)?;
    let current = zip.text(&path);
    let id = next_shape_id(&current);
    let values = match op.get("values") {
        Some(list @ Value::Array(_)) => list.clone(),
        _ => json!([]),
    };
    let mut options = Map::new();
    options.insert("id".to_owned(), json_number(id));
    options.insert("values".to_owned(), values);
    for (key, fallback) in [("left", 72), ("top", 72), ("width", 480), ("height", 120)] {
        options.insert(key.to_owned(), nullish(&[op.get(key), Some(&json!(fallback))]).unwrap_or(Value::Null));
    }
    options.insert("properties".to_owned(), Value::Object(properties_of(op)));
    let table = table_xml(&Value::Object(options))?;
    zip.set(&path, append_slide_shape(&current, &table)?);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("shapeId", json_number(id))]))
}

// ---- pictures and media -------------------------------------------------------------------------------------------

/// `handleAddImage`: a picture placed on the slide, fitted to its frame as the operation's `fit` says.
pub fn add_image<P: ReadProof>(proof: &P, zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let path = slide_path_of(slides, op)?;
    let source = source_path(op.get("path"))?;
    let size = image_pixel_size(&read_source(proof, &source)?);
    let mut layout = Map::new();
    if let Some(size) = size {
        layout.insert("sourceWidth".to_owned(), json!(size.width));
        layout.insert("sourceHeight".to_owned(), json!(size.height));
    }
    for (key, fallback) in [("left", 72), ("top", 72), ("width", 240), ("height", 180)] {
        layout.insert(key.to_owned(), nullish(&[op.get(key), Some(&json!(fallback))]).unwrap_or(Value::Null));
    }
    for key in ["fit", "focusX", "focusY"] {
        if let Some(value) = op.get(key) {
            layout.insert(key.to_owned(), value.clone());
        }
    }
    let placement = resolve_image_layout(&Value::Object(layout))?;
    let media = add_slide_image(proof, zip, &path, &source)?;
    let current = zip.text(&path);
    let id = next_shape_id(&current);
    let mut picture = Map::new();
    picture.insert("id".to_owned(), json_number(id));
    picture.insert("embedId".to_owned(), Value::String(media.relationship_id.clone()));
    for key in ["left", "top", "width", "height", "crop"] {
        picture.insert(key.to_owned(), placement[key].clone());
    }
    if let Some(alt) = op.get("altText") {
        picture.insert("altText".to_owned(), alt.clone());
    }
    zip.set(&path, append_slide_shape(&current, &picture_xml(&Value::Object(picture)))?);
    let frame: Map<String, Value> = ["left", "top", "width", "height"].iter().map(|key| ((*key).to_owned(), placement[*key].clone())).collect();
    Ok(reply(
        op,
        vec![
            ("changed", Value::Bool(true)),
            ("shapeId", json_number(id)),
            ("image", Value::String(media.part)),
            ("fit", placement["fit"].clone()),
            ("placement", Value::Object(frame)),
        ],
    ))
}

/// The `crop` fractions as the hundred-thousandths a `srcRect` edge holds.
fn crop_edge(value: f64) -> f64 {
    math::round(math::max(0.0, math::min(1.0, if value.is_nan() { 0.0 } else { value })) * 100_000.0)
}

/// `.replace(/<a:srcRect\b[^>]*\/>/, '').replace(<a:blip ...>, blip + rect)`: the picture's crop replaced by `rect`.
fn with_crop_rect(picture: &str, rect: &str) -> String {
    let stripped = remove_first(&compiled(r"<a:srcRect\b[^>]*/>", ""), picture);
    replace_first_with(&compiled(r"(<a:blip\b[^>]*?(?:/>|>[\s\S]*?</a:blip>))", ""), &stripped, |found| format!("{}{rect}", found.get(1).unwrap_or("")))
}

/// `replacedPicture(zip, path, shape, op)`: the picture frame keeps its place and size; only the image inside changes. The new
/// picture is centred and cropped to the frame the way `add_image` with `fit: 'cover'` places one, and a crop the old picture
/// carried is replaced, never kept over the new one.
fn replaced_picture<P: ReadProof>(proof: &P, zip: &mut Package, path: &str, shape: &Element, op: &Value) -> Result<(String, Map<String, Value>), String> {
    let describe = || format!("PPTX shape {} on slide {}", text_of(op.get("shape")), text_of(op.get("slide")));
    if shape.name != "p:pic" {
        return Err(format!("{} is not a picture", describe()));
    }
    let previous = first_group(&compiled(r#"<a:blip\b[^>]*\br:embed="([^"]*)""#, ""), &shape.xml).filter(|id| !id.is_empty());
    let Some(previous) = previous else {
        return Err(format!("PPTX picture {} on slide {} has no image reference", text_of(op.get("shape")), text_of(op.get("slide"))));
    };
    let source = text_if_truthy(op.get("path"));
    let media = add_slide_image(proof, zip, path, &source)?;
    let mut updated = replace_first_with(&compiled(r#"(<a:blip\b[^>]*\br:embed=")[^"]*(")"#, ""), &shape.xml, |found| {
        format!("{}{}{}", found.get(1).unwrap_or(""), media.relationship_id, found.get(2).unwrap_or(""))
    });
    let mut detail = Map::new();
    detail.insert("image".to_owned(), Value::String(media.part.clone()));
    detail.insert("replaced".to_owned(), Value::String(previous));
    let extent = compiled(r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "")
        .captures(&shape.xml)
        .map(|found| (string_to_number(found.get(1).unwrap_or("")), string_to_number(found.get(2).unwrap_or(""))));
    let size = image_pixel_size(&read_source(proof, &source)?);
    if let (Some((width, height)), Some(size)) = (extent, size)
        && size.width != 0
        && size.height != 0
    {
        let placed = resolve_image_layout(&json!({
            "sourceWidth": size.width,
            "sourceHeight": size.height,
            "width": json_number(width / EMU_PER_POINT),
            "height": json_number(height / EMU_PER_POINT),
            "fit": "cover",
        }))?;
        let crop = &placed["crop"];
        let cropped = crop.as_object().is_some_and(|edges| edges.values().any(|edge| to_number(edge) > 0.0));
        let rect = if cropped {
            let edge = |key: &str| num(crop_edge(to_number(&crop[key])));
            format!("<a:srcRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/>", edge("left"), edge("top"), edge("right"), edge("bottom"))
        } else {
            String::new()
        };
        updated = with_crop_rect(&updated, &rect);
        detail.insert("cropped".to_owned(), Value::Bool(cropped));
    }
    // The frame keeps the description of the picture that used to be in it, so a replaced photo is announced as the old one
    // until the caller renames it.
    let alt_text = js_trim(&text_or_empty(op.get("altText"))).to_owned();
    if !alt_text.is_empty() {
        let encoded = xml_encode(&alt_text);
        updated = if compiled(r#"<p:cNvPr\b[^>]*\bdescr=""#, "").is_match(&updated) {
            replace_first_with(&compiled(r#"(<p:cNvPr\b[^>]*\bdescr=")[^"]*(")"#, ""), &updated, |found| {
                format!("{}{encoded}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            })
        } else {
            replace_first_with(&compiled(r"(<p:cNvPr\b[^>]*?)(/?>)", ""), &updated, |found| {
                format!("{} descr=\"{encoded}\"{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            })
        };
        detail.insert("altText".to_owned(), Value::String(alt_text));
    }
    Ok((updated, detail))
}

/// The cell fills of a table cell's `a:tcPr`.
const CELL_FILLS: [&str; 6] = ["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"];

/// `filledCellProperties(tcPr, fill, anchor)`: a cell's fill in its `a:tcPr` (after the borders and the 3-D cell, before
/// headers and extensions, as the schema orders). Only the cell's own fill is replaced: each border line carries a fill of its
/// own (a hidden border is a line with `noFill`), and clearing those drew a black frame round the cell.
fn filled_cell_properties(tc_pr: &str, fill: &str, anchor: &str) -> String {
    let Some(open) = compiled(r"^<a:tcPr\b([^>]*?)(/?)>", "").captures(tc_pr) else { return tc_pr.to_owned() };
    let mut attributes = open.get(1).unwrap_or("").to_owned();
    if !anchor.is_empty() {
        let anchored = compiled(r#"\banchor=""#, "");
        attributes = if anchored.is_match(&attributes) {
            replace_first_with(&compiled(r#"\banchor="[^"]*""#, ""), &attributes, |_| format!("anchor=\"{anchor}\""))
        } else {
            format!("{attributes} anchor=\"{anchor}\"")
        };
    }
    let mut children = if open.get(2) == Some("/") {
        String::new()
    } else {
        let end = tc_pr.rfind("</a:tcPr>").unwrap_or_else(|| tc_pr.len().saturating_sub(1));
        tc_pr.get(open.range().end..end).unwrap_or("").to_owned()
    };
    if !fill.is_empty() {
        for element in top_level_elements(&children, &CELL_FILLS).iter().rev() {
            children = format!("{}{}", &children[..element.start], &children[element.end..]);
        }
        let at = top_level_elements(&children, &["a:headers", "a:extLst"]).first().map_or(children.len(), |later| later.start);
        children = format!("{}{fill}{}", &children[..at], &children[at..]);
    }
    if children.is_empty() { format!("<a:tcPr{attributes}/>") } else { format!("<a:tcPr{attributes}>{children}</a:tcPr>") }
}

/// `handleSetTableCellStyle`: one cell of a slide table restyled as the Office backend sets it through `Cell(row, col)`: its
/// fill and vertical anchor on the cell, its paragraphs' alignment, its runs' face, size, weight and colour.
pub fn set_table_cell_style(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let describe = || format!("PPTX shape {} on slide {}", text_of(op.get("shape")), text_of(op.get("slide")));
    if !shape.xml.contains("<a:tbl>") {
        return Err(format!("{} is not a table", describe()));
    }
    let rows: Vec<String> = compiled(r"<a:tr\b[^>]*>[\s\S]*?</a:tr>", "g").find_iter(&shape.xml).map(|found| shape.xml[found].to_owned()).collect();
    let cell_pattern = compiled(r"<a:tc\b[^>]*?(?:/>|>[\s\S]*?</a:tc>)", "g");
    let row = position(op.get("row")).and_then(|index| rows.get(index));
    let cells: Vec<String> = row.map(|row| cell_pattern.find_iter(row).map(|found| row[found].to_owned()).collect()).unwrap_or_default();
    let (Some(row), Some(cell)) = (row, position(op.get("col")).and_then(|index| cells.get(index))) else {
        let columns = rows.first().map_or(0, |first| compiled(r"<a:tc\b", "g").find_iter(first).count());
        return Err(format!(
            "PPTX table shape {} is {}x{columns}; row {}, col {} is outside it",
            text_of(op.get("shape")),
            rows.len(),
            text_of(op.get("row")),
            text_of(op.get("col"))
        ));
    };
    let properties = properties_of(op);
    let mut restyle = properties.clone();
    if let Some(alignment) = nullish(&[properties.get("horizontalAlignment"), properties.get("alignment")]) {
        restyle.insert("alignment".to_owned(), alignment);
    }
    let restyle = Value::Object(restyle);
    let mut styled = replace_first_with(&compiled(r"<a:txBody>([\s\S]*?)</a:txBody>", ""), cell, |body| {
        format!("<a:txBody>{}</a:txBody>", restyled_paragraphs(body.get(1).unwrap_or(""), &restyle))
    });
    // `fillColor: null` leaves the cell unfilled, as the Office backend's `Fill.Visible = 0` does.
    let fill = match properties.get("fillColor") {
        Some(Value::Null) => "<a:noFill/>".to_owned(),
        Some(color) if truthy(color) => solid_fill_xml(Some(color), None),
        _ => String::new(),
    };
    let anchor = text_anchor(properties.get("verticalAlignment"));
    // The cell's own text frame may name an anchor too (this writer's add_table sets one); it follows the cell's.
    if !anchor.is_empty() {
        styled =
            replace_first_with(&compiled(r#"(<a:bodyPr\b[^>]*?\banchor=")[^"]*""#, ""), &styled, |found| format!("{}{anchor}\"", found.get(1).unwrap_or("")));
    }
    if !fill.is_empty() || !anchor.is_empty() {
        if !compiled(r"<a:tcPr\b", "").is_match(&styled) {
            styled = replace_first_text(&styled, "</a:tc>", "<a:tcPr/></a:tc>");
        }
        styled = replace_first_with(&compiled(r"<a:tcPr\b[^>]*?(?:/>|>[\s\S]*?</a:tcPr>)", ""), &styled, |found| {
            filled_cell_properties(found.get(0).unwrap_or(""), &fill, anchor)
        });
    }
    let next_row = replace_first_text(row, cell, &styled);
    let updated = replace_first_text(&shape.xml, row, &next_row);
    write_shape(zip, &slide, &shape, &updated);
    Ok(reply(
        op,
        vec![
            ("changed", Value::Bool(updated != shape.xml)),
            ("slide", number_of(op, "slide")),
            ("shape", number_of(op, "shape")),
            ("row", number_of(op, "row")),
            ("col", number_of(op, "col")),
        ],
    ))
}

/// `handleSetTableDataOrReplaceImage`: a table refilled from rows (it grows with the data), or the picture in a frame replaced.
pub fn set_table_data_or_replace_image<P: ReadProof>(proof: &P, zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let updated;
    let detail: Map<String, Value>;
    if op.get("op").and_then(Value::as_str) == Some("set_table_data") {
        let values: Vec<Value> =
            op.get("values").and_then(Value::as_array).map(|rows| rows.iter().filter(|row| row.is_array()).cloned().collect()).unwrap_or_default();
        if values.is_empty() {
            return Err("set_table_data requires values as an array of rows".to_owned());
        }
        let filled = set_table_values(&shape.xml, &values)?;
        let filled_xml = filled["xml"].as_str().unwrap_or("").to_owned();
        let added_height = to_number(&filled["addedHeight"]);
        // The frame grows down with the rows the data added, so the table's box is the table; its width stays.
        updated = replace_first_with(&compiled(r#"(<p:xfrm>[\s\S]*?<a:ext\b[^>]*\bcy=")(\d+)""#, ""), &filled_xml, |found| {
            format!("{}{}\"", found.get(1).unwrap_or(""), num(string_to_number(found.get(2).unwrap_or("")) + added_height))
        });
        let mut counts = Map::new();
        for key in ["rows", "cells", "capacity"] {
            counts.insert(key.to_owned(), filled[key].clone());
        }
        for key in ["addedRows", "addedColumns"] {
            if filled.get(key).is_some_and(truthy) {
                counts.insert(key.to_owned(), filled[key].clone());
            }
        }
        detail = counts;
    } else {
        let (xml, found) = replaced_picture(proof, zip, &slide.path, &shape, op)?;
        updated = xml;
        detail = found;
    }
    let next_inner = format!("{}{updated}{}", &slide.tree.inner[..shape.start], &slide.tree.inner[shape.end..]);
    let next_slide = format!("{}{next_inner}{}", &slide.current[..slide.tree.start], &slide.current[slide.tree.end..]);
    zip.set(&slide.path, next_slide.as_str());
    if let Some(replaced) = detail.get("replaced").and_then(Value::as_str).filter(|id| !id.is_empty())
        && !next_slide.contains(&format!("r:embed=\"{replaced}\""))
    {
        remove_package_relationship(zip, &part_relationship_path(&slide.path), replaced);
    }
    let mut answer = reply(op, vec![("changed", Value::Bool(updated != shape.xml)), ("slide", number_of(op, "slide"))]);
    if let Value::Object(fields) = &mut answer {
        fields.extend(detail);
    }
    Ok(answer)
}

/// `handleCropImage`: the picture's crop set from the four edges given in percent.
pub fn crop_image(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    if shape.name != "p:pic" {
        return Err(format!("PPTX shape {} on slide {} is not a picture", text_of(op.get("shape")), text_of(op.get("slide"))));
    }
    let edge = |key: &str| {
        let value = to_number_of(op.get(key));
        num(math::max(0.0, math::min(100_000.0, math::round((if value.is_nan() || value == 0.0 { 0.0 } else { value }) * 1000.0))))
    };
    let rect = format!("<a:srcRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/>", edge("left"), edge("top"), edge("right"), edge("bottom"));
    let updated = with_crop_rect(&shape.xml, &rect);
    write_shape(zip, &slide, &shape, &updated);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("shape", number_of(op, "shape"))]))
}

const MEDIA_CONTENT_TYPES: [(&str, &str); 8] = [
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("mov", "video/quicktime"),
    ("avi", "video/x-msvideo"),
    ("wmv", "video/x-ms-wmv"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("wav", "audio/wav"),
];

/// `extname(String(path || '')).replace(/^\./, '').toLowerCase()`.
fn extension_of(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = match base.rfind('.') {
        Some(at) if at > 0 && base != ".." => &base[at + 1..],
        _ => "",
    };
    js_to_lowercase(extension)
}

/// `mediaFileType(op)`: the kind, the extension and the content type of the media file, or why it cannot be added.
fn media_file_type(op: &Value) -> Result<(String, String, &'static str), String> {
    let requested = js_to_lowercase(&text_if_truthy(op.get("kind")));
    let kind = if requested.is_empty() { "video".to_owned() } else { requested };
    if !["video", "audio"].contains(&kind.as_str()) {
        return Err("add_media kind must be video or audio".to_owned());
    }
    let extension = extension_of(&text_if_truthy(op.get("path")));
    if extension.is_empty() {
        return Err("add_media requires a media file path".to_owned());
    }
    let Some(content_type) = MEDIA_CONTENT_TYPES.iter().find(|(name, _)| *name == extension).map(|(_, content_type)| *content_type) else {
        let known: Vec<&str> = MEDIA_CONTENT_TYPES.iter().map(|(name, _)| *name).collect();
        return Err(format!("Unsupported media type: .{extension}. Use {}", known.join(", ")));
    };
    if !op.get("poster").is_some_and(truthy) {
        return Err("add_media requires poster for the preview frame".to_owned());
    }
    Ok((kind, extension, content_type))
}

/// `mediaPictureXml`: a media frame: the poster picture, the media link and embed relationships, and the click action that
/// plays it.
fn media_picture_xml(id: f64, name: &str, kind: &str, op: &Value, link_id: &str, media_id: &str, poster_id: &str) -> String {
    let description = match op.get("altText").filter(|alt| truthy(alt)) {
        Some(alt) => format!(" descr=\"{}\"", xml_encode(&value_to_string(alt))),
        None => String::new(),
    };
    let point = |key: &str, fallback: f64| {
        to_emu(match op.get(key).filter(|value| !value.is_null()) {
            Some(value) => to_number(value),
            None => fallback,
        })
    };
    format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{}\" name=\"{}\"{description}><a:hlinkClick xmlns:a=\"{DRAWING_MAIN_NS}\" r:id=\"\" action=\"ppaction://media\"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr><a:{kind}File xmlns:a=\"{DRAWING_MAIN_NS}\" r:link=\"{link_id}\"/><p:extLst><p:ext uri=\"{{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}}\"><p14:media xmlns:p14=\"http://schemas.microsoft.com/office/powerpoint/2010/main\" r:embed=\"{media_id}\"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed=\"{poster_id}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        num(id),
        xml_encode(name),
        num(point("left", 72.0)),
        num(point("top", 72.0)),
        num(math::max(1.0, point("width", 360.0))),
        num(math::max(1.0, point("height", 240.0)))
    )
}

/// `handleAddMedia`: a video or audio file stored in the deck, with its poster, related to the slide and framed.
pub fn add_media<P: ReadProof>(proof: &P, zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let path = slide_path_of(slides, op)?;
    let current = zip.text(&path);
    let (kind, extension, content_type) = media_file_type(op)?;
    let mut ordinal = 1;
    while zip.file(&format!("ppt/media/media{ordinal}.{extension}")).is_some() {
        ordinal += 1;
    }
    let media_part = format!("ppt/media/media{ordinal}.{extension}");
    let source = source_path(op.get("path"))?;
    zip.set(&media_part, read_source(proof, &source)?);
    ensure_default_content_type(zip, &extension, content_type);
    let relative = posix::relative("ppt/slides", &media_part);
    let rels = part_relationship_path(&path);
    let media_id = add_package_relationship(zip, &rels, "http://schemas.microsoft.com/office/2007/relationships/media", &relative, "");
    let link_id = add_package_relationship(zip, &rels, &format!("{OFFICE_RELATIONSHIP_BASE}/{kind}"), &relative, "");
    let poster = add_slide_image(proof, zip, &path, &text_if_truthy(op.get("poster")))?;
    let shape = media_picture_xml(next_shape_id(&current), &posix::basename(&media_part), &kind, op, &link_id, &media_id, &poster.relationship_id);
    let appended = append_slide_shape(&zip.text(&path), &shape)?;
    zip.set(&path, appended);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("media", Value::String(media_part)), ("kind", Value::String(kind))]))
}

// ---- fitting text ---------------------------------------------------------------------------------------------------

/// A shape's `a:ext` in EMU.
fn extent_of(shape: &str) -> Option<(f64, f64)> {
    compiled(r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "")
        .captures(shape)
        .map(|found| (string_to_number(found.get(1).unwrap_or("")), string_to_number(found.get(2).unwrap_or(""))))
}

/// The shape's text area inside its own insets, in points.
fn text_area_size(shape: &str, extent: (f64, f64)) -> (f64, f64) {
    let attributes = first_group(&compiled(r"<a:bodyPr\b([^>]*?)/?>", ""), shape).unwrap_or_default();
    let inset = text_insets(&attributes);
    let side = |key: &str| to_number(&inset[key]);
    (
        math::max(1.0, extent.0 / EMU_PER_POINT - side("insetLeft") - side("insetRight")),
        math::max(1.0, extent.1 / EMU_PER_POINT - side("insetTop") - side("insetBottom")),
    )
}

/// A shape and its frame after `frameInsideSlide`.
struct Framed {
    xml: String,
    extent: (f64, f64),
    clamped: bool,
}

/// `frameInsideSlide(context, shapeXml, extent)`: a box running past the slide's right or bottom edge ends at the edge, its
/// corner kept, as PowerPoint's `fit_text` draws it: the text is fitted inside the page, and a box only placed past the edge
/// was left there unchanged.
fn frame_inside_slide(zip: &Package, shape: &str, extent: (f64, f64)) -> Framed {
    let unchanged = || Framed { xml: shape.to_owned(), extent, clamped: false };
    let Some(offset) = compiled(r#"<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)""#, "").captures(shape) else { return unchanged() };
    let (slide_width, slide_height) = presentation_slide_size(zip);
    let room = |edge: f64, start: Option<&str>| math::round(edge * EMU_PER_POINT) - string_to_number(start.unwrap_or(""));
    let width = math::min(extent.0, math::max(1.0, room(slide_width, offset.get(1))));
    let height = math::min(extent.1, math::max(1.0, room(slide_height, offset.get(2))));
    if width == extent.0 && height == extent.1 {
        return unchanged();
    }
    let xml = replace_first_with(&compiled(r#"(<a:ext\b[^>]*\bcx=")\d+("[^>]*\bcy=")\d+(")"#, ""), shape, |found| {
        format!("{}{}{}{}{}", found.get(1).unwrap_or(""), num(width), found.get(2).unwrap_or(""), num(height), found.get(3).unwrap_or(""))
    });
    Framed { xml, extent: (width, height), clamped: true }
}

/// The paragraph `shape_paragraphs` read, as the measurer takes it.
fn paragraph_of(value: &Value) -> Paragraph {
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Paragraph {
        text: text("text").unwrap_or_default(),
        font_name: text("fontName"),
        font_size: number("fontSize"),
        bold: value["bold"] == json!(true),
        italic: value["italic"] == json!(true),
        line_spacing: number("lineSpacing"),
        space_before: number("spaceBefore").unwrap_or(0.0),
        space_after: number("spaceAfter").unwrap_or(0.0),
        runs: value.get("runs").and_then(Value::as_array).map(|runs| {
            runs.iter()
                .map(|run| Run {
                    text: run.get("text").and_then(Value::as_str).unwrap_or("").to_owned(),
                    font_size: run.get("fontSize").and_then(Value::as_f64),
                })
                .collect()
        }),
        color: text("color"),
        char_spacing: number("charSpacing").unwrap_or(0.0),
    }
}

/// `Number(value) || 18`.
fn size_or_default(paragraph: &Value) -> f64 {
    let size = to_number_of(paragraph.get("fontSize"));
    if size.is_nan() || size == 0.0 { 18.0 } else { size }
}

/// `handleFitText`: the shape's text shrunk to the largest size of the type ladder at which it fits, and a box running past
/// the slide's edge ended at the edge.
pub fn fit_text<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let shape_number = text_of(op.get("shape"));
    let paragraphs = shape_paragraphs(&shape.xml).filter(|list| !list.is_empty());
    let Some(paragraphs) = paragraphs else { return Err(format!("PPTX shape {shape_number} has no measurable text run")) };
    let Some(extent) = extent_of(&shape.xml) else { return Err(format!("PPTX shape {shape_number} has no explicit size")) };
    let framed = frame_inside_slide(zip, &shape.xml, extent);
    let stated = to_number_of(op.get("minFontSize"));
    let minimum = math::max(1.0, if stated.is_nan() || stated == 0.0 { 8.0 } else { stated });
    let (width, height) = text_area_size(&framed.xml, framed.extent);
    let measured: Vec<Paragraph> = paragraphs.iter().map(paragraph_of).collect();
    let fitted = measurer
        .shrink_font_size_to_fit(&measured, &ShrinkOptions { width, height, minimum_font_size: minimum, steps: None })
        .map_err(|error| error.to_string())?;
    // Nothing on the ladder fits: the text goes down to the floor and the audit keeps reporting what is left, as PowerPoint's
    // `fit_text` stops at the floor.
    let largest = paragraphs.iter().map(size_or_default).fold(1.0, math::max);
    let fits = fitted.scale != 0.0 && !fitted.scale.is_nan();
    let scale = if fits { fitted.scale } else { math::min(1.0, minimum / largest) };
    let sizes: Vec<f64> = if fits {
        fitted.sizes.clone()
    } else {
        paragraphs.iter().map(|paragraph| math::max(minimum, math::round(size_or_default(paragraph) * scale * 2.0) / 2.0)).collect()
    };
    let changed = framed.clamped || scale < 1.0;
    if changed {
        let updated = compiled(r#"\bsz="(\d+)""#, "g").replace_all_with(&framed.xml, |found| {
            let size = string_to_number(found.get(1).unwrap_or(""));
            format!("sz=\"{}\"", num(math::max(minimum * 100.0, math::round(size * scale))))
        });
        write_shape(zip, &slide, &shape, &updated);
    }
    let largest_size = sizes.iter().map(|size| if size.is_nan() { 0.0 } else { *size }).fold(0.0, math::max);
    let mut fields = vec![
        ("changed", Value::Bool(changed)),
        ("slide", number_of(op, "slide")),
        ("shape", number_of(op, "shape")),
        ("scale", json_number(string_to_number(&math::to_fixed(scale, 2)))),
    ];
    // The size the copy now reads at: shrinking is the last repair, so the author sees what it cost and can rewrite the line.
    if largest_size != 0.0 {
        fields.push(("fontSize", json_number(largest_size)));
    }
    if !fits {
        fields.push(("fits", Value::Bool(false)));
        fields.push(("note", Value::String(format!("The text does not fit above {} pt; shorten it or enlarge the box.", num(minimum)))));
    }
    Ok(reply(op, fields))
}

// ---- grouping -------------------------------------------------------------------------------------------------------

/// `ungroupShape`: the group's children put in its place.
fn ungroup_shape(zip: &mut Package, op: &Value, slide: &SlideTree) -> Result<Value, String> {
    let group = slide_shape(&slide.tree, op)?;
    if group.name != "p:grpSp" {
        return Err(format!("PPTX shape {} on slide {} is not a group", text_of(op.get("shape")), text_of(op.get("slide"))));
    }
    let body = container_body(&group.xml, "p:grpSp");
    let without_identity = remove_first(&compiled(r"<p:nvGrpSpPr>[\s\S]*?</p:nvGrpSpPr>", ""), &body);
    let children = remove_first(&compiled(r"<p:grpSpPr>[\s\S]*?</p:grpSpPr>", ""), &without_identity);
    write_shape(zip, slide, &group, &children);
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("shape", number_of(op, "shape"))]))
}

/// `groupShapeXml(id, bounds, selected)`.
fn group_shape_xml(id: f64, bounds: &Bounds, selected: &[Element]) -> String {
    let (left, top) = (num(to_emu(bounds.left)), num(to_emu(bounds.top)));
    let width = num(math::max(1.0, to_emu(bounds.right - bounds.left)));
    let height = num(math::max(1.0, to_emu(bounds.bottom - bounds.top)));
    let id = num(id);
    let children: String = selected.iter().map(|shape| shape.xml.as_str()).collect();
    format!(
        "<p:grpSp><p:nvGrpSpPr><p:cNvPr id=\"{id}\" name=\"Group {id}\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"{left}\" y=\"{top}\"/><a:ext cx=\"{width}\" cy=\"{height}\"/><a:chOff x=\"{left}\" y=\"{top}\"/><a:chExt cx=\"{width}\" cy=\"{height}\"/></a:xfrm></p:grpSpPr>{children}</p:grpSp>"
    )
}

/// `handleGroupShapesOrUngroupShape`: shapes gathered into a group at the front of the slide, or a group dissolved.
pub fn group_shapes_or_ungroup_shape(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    if op.get("op").and_then(Value::as_str) == Some("ungroup_shape") {
        return ungroup_shape(zip, op, &slide);
    }
    let mut numbers: Vec<f64> = Vec::new();
    if let Some(list) = op.get("shapes").and_then(Value::as_array) {
        for item in list {
            let number = to_number(item);
            if !numbers.iter().any(|seen| *seen == number || (seen.is_nan() && number.is_nan())) {
                numbers.push(number);
            }
        }
    }
    js_sort_by(&mut numbers, |left, right| left - right);
    if numbers.len() < 2 {
        return Err("group_shapes requires at least two shapes".to_owned());
    }
    let wanted: Vec<Value> = numbers.iter().map(|number| numeric_of(*number)).collect();
    let (shapes, selected) = selected_shape_spans(&slide.tree, &wanted)?;
    let frames: Vec<Frame> = selected.iter().filter_map(|shape| shape_frame(&shape.xml)).collect();
    if frames.len() != selected.len() {
        return Err("group_shapes needs shapes with explicit geometry".to_owned());
    }
    let id = next_shape_id(&slide.current);
    let anchors: Vec<usize> = selected.iter().map(|shape| shape.start).collect();
    let inner = rewrite_shape_tree(&slide.tree, &shapes, |shape| anchors.contains(&shape.start).then(String::new));
    write_slide_tree(zip, &slide, &format!("{inner}{}", group_shape_xml(id, &frames_extent(&frames), &selected)));
    Ok(reply(op, vec![("changed", Value::Bool(true)), ("slide", number_of(op, "slide")), ("shapes", Value::from(numbers.len())), ("shapeId", json_number(id))]))
}

// ---- animation ------------------------------------------------------------------------------------------------------

/// The entrance effects: name, preset id and the filter the effect plays.
const ANIMATION_EFFECTS: [(&str, u32, &str); 6] = [
    ("appear", 1, ""),
    ("fade", 10, "fade"),
    ("wipe", 22, "wipe(up)"),
    ("zoom", 23, "fade"),
    ("fly", 2, "slide(fromBottom)"),
    ("float", 30, "slide(fromBottom)"),
];
const ANIMATION_TRIGGERS: [(&str, &str); 3] = [("onclick", "clickEffect"), ("withprevious", "withEffect"), ("afterprevious", "afterEffect")];

/// What `add_animation` asked for.
struct AnimationRequest {
    effect_name: &'static str,
    preset_id: u32,
    filter: &'static str,
    trigger: &'static str,
    node_type: &'static str,
    duration: f64,
    delay: f64,
}

/// `animationName(value)`: every other multiword value in this runtime is written with a separator (`outside_end`,
/// `section_next`), so `on_click` and `after_previous` name the same triggers as `onclick` and `afterprevious`.
fn animation_name(value: Option<&Value>) -> String {
    compiled(r"[\s_-]+", "g").replace_all_with(&js_to_lowercase(&text_if_truthy(value)), |_| String::new())
}

fn animation_request(op: &Value) -> Result<AnimationRequest, String> {
    let named = animation_name(op.get("effect"));
    let requested = if named.is_empty() { "fade".to_owned() } else { named };
    let Some((effect_name, preset_id, filter)) = ANIMATION_EFFECTS.iter().find(|(name, _, _)| *name == requested).copied() else {
        let names: Vec<&str> = ANIMATION_EFFECTS.iter().map(|(name, _, _)| *name).collect();
        return Err(format!("add_animation effect must be one of: {}", names.join(", ")));
    };
    let named = animation_name(op.get("trigger"));
    let trigger_name = if named.is_empty() { "onclick".to_owned() } else { named };
    let Some((trigger, node_type)) = ANIMATION_TRIGGERS.iter().find(|(name, _)| *name == trigger_name).copied() else {
        return Err("add_animation trigger must be one of: on_click, with_previous, after_previous".to_owned());
    };
    let seconds = |key: &str, fallback: f64| {
        let value = to_number_of(op.get(key));
        if value > 0.0 { value } else { fallback }
    };
    Ok(AnimationRequest {
        effect_name,
        preset_id,
        filter,
        trigger,
        node_type,
        duration: math::max(1.0, math::round(seconds("duration", 0.5) * 1000.0)),
        delay: math::max(0.0, math::round(seconds("delay", 0.0) * 1000.0)),
    })
}

/// Hands out the next unused timing node id.
struct NodeIds(f64);

impl NodeIds {
    fn next(&mut self) -> String {
        let id = self.0;
        self.0 += 1.0;
        num(id)
    }
}

/// `animationNodes(shapeId, request, id)`: the entrance effect node for one shape and the click group that carries it.
fn animation_nodes(shape_id: f64, request: &AnimationRequest, ids: &mut NodeIds) -> (String, String) {
    let target = format!("<p:tgtEl><p:spTgt spid=\"{}\"/></p:tgtEl>", num(shape_id));
    let mut behaviour = format!(
        "<p:set><p:cBhvr><p:cTn id=\"{}\" dur=\"1\" fill=\"hold\"><p:stCondLst><p:cond delay=\"0\"/></p:stCondLst></p:cTn>{target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val=\"visible\"/></p:to></p:set>",
        ids.next()
    );
    if !request.filter.is_empty() {
        behaviour.push_str(&format!(
            "<p:animEffect transition=\"in\" filter=\"{}\"><p:cBhvr><p:cTn id=\"{}\" dur=\"{}\"/>{target}</p:cBhvr></p:animEffect>",
            request.filter,
            ids.next(),
            num(request.duration)
        ));
    }
    let node = format!(
        "<p:par><p:cTn id=\"{}\" presetID=\"{}\" presetClass=\"entr\" presetSubtype=\"0\" fill=\"hold\" grpId=\"0\" nodeType=\"{}\"><p:stCondLst><p:cond delay=\"{}\"/></p:stCondLst><p:childTnLst>{behaviour}</p:childTnLst></p:cTn></p:par>",
        ids.next(),
        request.preset_id,
        request.node_type,
        num(request.delay)
    );
    let outer = ids.next();
    let inner = ids.next();
    let group = format!(
        "<p:par><p:cTn id=\"{outer}\" fill=\"hold\"><p:stCondLst><p:cond delay=\"indefinite\"/></p:stCondLst><p:childTnLst><p:par><p:cTn id=\"{inner}\" fill=\"hold\"><p:stCondLst><p:cond delay=\"0\"/></p:stCondLst><p:childTnLst>{node}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>"
    );
    (node, group)
}

/// `timingWithAnimation(existing, nodes, trigger, id)`: the slide's timing tree with the animation added: a fresh main
/// sequence when the slide has none, a new click group for `on_click`, or the effect joined to the last group for
/// `with_previous` and `after_previous`.
fn timing_with_animation(existing: &str, node: &str, group: &str, trigger: &str, ids: &mut NodeIds) -> Result<String, String> {
    if existing.is_empty() {
        return Ok(format!(
            "<p:timing><p:tnLst><p:par><p:cTn id=\"1\" dur=\"indefinite\" restart=\"never\" nodeType=\"tmRoot\"><p:childTnLst><p:seq concurrent=\"1\" nextAc=\"seek\"><p:cTn id=\"{}\" dur=\"indefinite\" nodeType=\"mainSeq\"><p:childTnLst>{group}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt=\"onPrev\" delay=\"0\"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt=\"onNext\" delay=\"0\"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>",
            ids.next()
        ));
    }
    let head = compiled(r#"<p:cTn\b[^>]*\bnodeType="mainSeq"[^>]*>"#, "").find(existing);
    let sequence = head.and_then(|head| container_inner(existing, "p:childTnLst", head.end));
    let Some(sequence) = sequence else { return Err("PPTX slide timing has no main animation sequence".to_owned()) };
    let last = top_level_elements(&sequence.inner, &["p:par"]).pop();
    let next_inner = match last {
        Some(last) if trigger != "onclick" => {
            let closes: Vec<usize> = last.xml.match_indices("</p:childTnLst>").map(|(at, _)| at).collect();
            let merged = match closes.len() {
                0 => format!("{}{node}{}", last.xml, last.xml),
                1 => format!("{}{node}{}", &last.xml[..closes[0]], &last.xml[closes[0]..]),
                count => format!("{}{node}{}", &last.xml[..closes[count - 2]], &last.xml[closes[count - 2]..]),
            };
            format!("{}{merged}{}", &sequence.inner[..last.start], &sequence.inner[last.end..])
        }
        _ => format!("{}{group}", sequence.inner),
    };
    Ok(format!("{}{next_inner}{}", &existing[..sequence.start], &existing[sequence.end..]))
}

/// `handleAddAnimation`: an entrance effect for a shape, on click or together with or after the one before it.
pub fn add_animation(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let shape_id = first_group(&compiled(r#"<p:cNvPr\b[^>]*\bid="(\d+)""#, ""), &shape.xml).map_or(f64::NAN, |id| string_to_number(&id));
    if shape_id.is_nan() || shape_id == 0.0 {
        return Err(format!("PPTX shape {} on slide {} has no shape id", text_of(op.get("shape")), text_of(op.get("slide"))));
    }
    let request = animation_request(op)?;
    let timing_pattern = compiled(r"<p:timing>[\s\S]*?</p:timing>", "");
    let existing = timing_pattern.find(&slide.current).map(|found| slide.current[found].to_owned()).unwrap_or_default();
    let highest =
        compiled(r#"<p:cTn\b[^>]*\bid="(\d+)""#, "g").captures_iter(&existing).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(2.0, math::max);
    let mut ids = NodeIds(highest + 1.0);
    let (node, group) = animation_nodes(shape_id, &request, &mut ids);
    let timing = timing_with_animation(&existing, &node, &group, request.trigger, &mut ids)?;
    let stripped = remove_first(&timing_pattern, &slide.current);
    zip.set(&slide.path, replace_first_text(&stripped, "</p:sld>", &format!("{timing}</p:sld>")));
    Ok(reply(
        op,
        vec![
            ("changed", Value::Bool(true)),
            ("slide", number_of(op, "slide")),
            ("shape", number_of(op, "shape")),
            ("effect", Value::from(request.effect_name)),
            ("trigger", Value::from(request.trigger)),
        ],
    ))
}

// ---- restyling ------------------------------------------------------------------------------------------------------

/// `handleSetShape`: a shape's frame, fill, outline and text restyled from the operation's properties.
pub fn set_shape(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Result<Value, String> {
    let slide = slide_shape_tree(zip, slides, op)?;
    let shape = slide_shape(&slide.tree, op)?;
    let properties = Value::Object(properties_of(op));
    let updated = restyle_shape_text(&update_shape_geometry(&shape.xml, &properties), &properties);
    write_shape(zip, &slide, &shape, &updated);
    Ok(reply(op, vec![("changed", Value::Bool(updated != shape.xml))]))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SLIDE: &str = "ppt/slides/slide1.xml";

    fn shape(id: u32, name: &str, left: u32, text: &[&str]) -> String {
        let paragraphs: Vec<Value> = text.iter().map(|line| json!({ "text": line, "fontSize": 18 })).collect();
        shape_xml(&json!({
            "id": id, "name": name, "left": left, "top": 20, "width": 100, "height": 40,
            "textBody": text_body_xml(&json!({ "paragraphs": paragraphs })),
        }))
    }

    fn deck(shapes: &[String]) -> (Package, Vec<SlideRef>) {
        let mut zip = Package::new();
        zip.set(
            SLIDE,
            format!(
                "<p:sld xmlns:a=\"{DRAWING_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{}</p:spTree></p:cSld></p:sld>",
                shapes.concat()
            ),
        );
        (zip, vec![SlideRef { id: 256.0, rid: "rId2".to_owned(), path: SLIDE.to_owned() }])
    }

    fn three() -> (Package, Vec<SlideRef>) {
        deck(&[shape(2, "A", 10, &["one"]), shape(3, "B", 50, &["two"]), shape(4, "C", 90, &["three"])])
    }

    /// The shapes named A, B and C, in the order the slide holds them.
    fn order(zip: &Package) -> Vec<char> {
        let xml = zip.text(SLIDE);
        let mut found: Vec<(usize, char)> = ['A', 'B', 'C'].iter().filter_map(|name| xml.find(&format!("name=\"{name}\"")).map(|at| (at, *name))).collect();
        found.sort_unstable();
        found.into_iter().map(|(_, name)| name).collect()
    }

    #[test]
    fn z_order_moves_a_shape_to_the_front_and_one_step_back() {
        let (mut zip, slides) = three();
        z_order(&mut zip, &slides, &json!({ "op": "z_order", "slide": 1, "shape": 1, "command": "Front" })).expect("front");
        assert_eq!(order(&zip), vec!['B', 'C', 'A']);
        let answer = z_order(&mut zip, &slides, &json!({ "op": "z_order", "slide": 1, "shape": 3, "command": "backward" })).expect("backward");
        assert_eq!(order(&zip), vec!['B', 'A', 'C']);
        assert_eq!(answer, json!({ "op": "z_order", "changed": true, "slide": 1, "command": "backward" }));
    }

    #[test]
    fn a_shape_or_command_that_does_not_exist_is_refused_with_the_original_words() {
        let (mut zip, slides) = three();
        assert_eq!(
            z_order(&mut zip, &slides, &json!({ "slide": 1, "shape": 1, "command": "up" })),
            Err("z_order command must be front, back, forward, or backward".to_owned())
        );
        assert_eq!(delete_shape(&mut zip, &slides, &json!({ "slide": 1, "shape": 9 })), Err("PPTX shape 9 not found on slide 1".to_owned()));
        assert_eq!(delete_shape(&mut zip, &slides, &json!({ "slide": 4, "shape": 1 })), Err("PPTX slide 4 not found".to_owned()));
        assert_eq!(delete_shape(&mut zip, &slides, &json!({ "shape": 1 })), Err("PPTX slide undefined not found".to_owned()));
    }

    #[test]
    fn delete_shape_removes_only_that_shape() {
        let (mut zip, slides) = three();
        delete_shape(&mut zip, &slides, &json!({ "op": "delete_shape", "slide": 1, "shape": 2 })).expect("deleted");
        assert_eq!(order(&zip), vec!['A', 'C']);
    }

    #[test]
    fn shapes_are_grouped_at_the_front_and_ungrouped_in_place() {
        let (mut zip, slides) = three();
        let answer = group_shapes_or_ungroup_shape(&mut zip, &slides, &json!({ "op": "group_shapes", "slide": 1, "shapes": [2, 1, 2] })).expect("grouped");
        assert_eq!(answer, json!({ "op": "group_shapes", "changed": true, "slide": 1, "shapes": 2, "shapeId": 5 }));
        let xml = zip.text(SLIDE);
        assert!(xml.contains("<p:cNvPr id=\"5\" name=\"Group 5\"/>"));
        assert!(xml.contains("<a:chOff x=\"127000\" y=\"254000\"/>"));
        assert_eq!(order(&zip), vec!['C', 'A', 'B']);
        group_shapes_or_ungroup_shape(&mut zip, &slides, &json!({ "op": "ungroup_shape", "slide": 1, "shape": 2 })).expect("ungrouped");
        assert!(!zip.text(SLIDE).contains("<p:grpSp>"));
        assert_eq!(order(&zip), vec!['C', 'A', 'B']);
        assert_eq!(
            group_shapes_or_ungroup_shape(&mut zip, &slides, &json!({ "op": "ungroup_shape", "slide": 1, "shape": 1 })),
            Err("PPTX shape 1 on slide 1 is not a group".to_owned())
        );
        assert_eq!(
            group_shapes_or_ungroup_shape(&mut zip, &slides, &json!({ "op": "group_shapes", "slide": 1, "shapes": [1] })),
            Err("group_shapes requires at least two shapes".to_owned())
        );
    }

    #[test]
    fn align_puts_every_selected_shape_on_the_same_edge() {
        let (mut zip, slides) = three();
        align_shapes_or_distribute_shapes(&mut zip, &slides, &json!({ "op": "align_shapes", "slide": 1, "shapes": [1, 2], "align": "left" })).expect("aligned");
        assert_eq!(zip.text(SLIDE).matches("<a:off x=\"127000\"").count(), 2);
        assert_eq!(
            align_shapes_or_distribute_shapes(&mut zip, &slides, &json!({ "op": "align_shapes", "slide": 1, "shapes": [1, 2], "align": "diagonal" })),
            Err("align must be left, center, right, top, middle, or bottom".to_owned())
        );
        assert_eq!(
            align_shapes_or_distribute_shapes(&mut zip, &slides, &json!({ "op": "distribute_shapes", "slide": 1, "shapes": [1] })),
            Err("distribute_shapes requires at least two shapes".to_owned())
        );
    }

    #[test]
    fn set_text_leaves_one_paragraph_with_one_run() {
        let (mut zip, slides) = deck(&[shape(2, "A", 10, &["one", "two", "three"])]);
        set_text(&mut zip, &slides, &json!({ "op": "set_text", "slide": 1, "shape": 1, "text": "new & <old>" })).expect("set");
        let xml = zip.text(SLIDE);
        assert!(xml.contains("<a:t>new &amp; &lt;old&gt;</a:t>"));
        assert_eq!(xml.matches("<a:p>").count(), 1);
        assert_eq!(xml.matches("<a:r>").count(), 1);
        assert!(!xml.contains("three"));
    }

    #[test]
    fn a_hyperlink_is_related_to_the_slide_and_set_on_the_shape() {
        let (mut zip, slides) = three();
        let address = " https://example.com/a?b=1&c=2 ";
        let answer = set_hyperlink(&mut zip, &slides, &json!({ "op": "set_hyperlink", "slide": 1, "shape": 1, "address": address })).expect("linked");
        assert_eq!(answer["address"], json!("https://example.com/a?b=1&c=2"));
        assert!(zip.text(SLIDE).contains("r:id=\"rId1\"/></p:cNvPr>"));
        let rels = zip.text("ppt/slides/_rels/slide1.xml.rels");
        assert!(rels.contains("TargetMode=\"External\"") && rels.contains("b=1&amp;c=2"));
        assert_eq!(set_hyperlink(&mut zip, &slides, &json!({ "slide": 1, "shape": 1 })), Err("set_hyperlink requires address or subAddress".to_owned()));
    }

    #[test]
    fn a_text_box_filled_dark_gets_light_ink() {
        let (mut zip, slides) = deck(&[]);
        let answer = add_textbox_or_shape(&mut zip, &slides, &json!({ "op": "add_textbox", "slide": 1, "text": "Hi", "fillColor": "#000000" })).expect("added");
        assert_eq!(answer, json!({ "op": "add_textbox", "changed": true, "shapeId": 2 }));
        let xml = zip.text(SLIDE);
        assert!(xml.contains("name=\"Mixdog TextBox 2\"") && xml.contains("FFFFFF"));
        let refused = add_textbox_or_shape(&mut zip, &slides, &json!({ "op": "add_shape", "slide": 1, "shapeType": "blob" }));
        assert!(refused.is_err_and(|message| message.starts_with("Unsupported shapeType: blob. Use one of: rectangle, rect, ")));
    }

    #[test]
    fn animations_get_distinct_node_ids_and_join_the_last_click_group() {
        let (mut zip, slides) = three();
        add_animation(&mut zip, &slides, &json!({ "op": "add_animation", "slide": 1, "shape": 1, "effect": "Fade" })).expect("first");
        let answer = add_animation(
            &mut zip,
            &slides,
            &json!({ "op": "add_animation", "slide": 1, "shape": 2, "effect": "wipe", "trigger": "with_previous", "duration": 2 }),
        )
        .expect("second");
        assert_eq!(answer["trigger"], json!("withprevious"));
        let xml = zip.text(SLIDE);
        assert!(xml.contains("nodeType=\"mainSeq\"") && xml.contains("nodeType=\"clickEffect\"") && xml.contains("nodeType=\"withEffect\""));
        assert!(xml.contains("dur=\"2000\""));
        assert_eq!(xml.matches("<p:timing>").count(), 1);
        let mut ids: Vec<String> = compiled(r#"<p:cTn id="(\d+)""#, "g").captures_iter(&xml).map(|found| found.get(1).unwrap_or("").to_owned()).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
        assert_eq!(
            add_animation(&mut zip, &slides, &json!({ "slide": 1, "shape": 1, "effect": "spin" })),
            Err("add_animation effect must be one of: appear, fade, wipe, zoom, fly, float".to_owned())
        );
    }

    #[test]
    fn crop_image_needs_a_picture() {
        let (mut zip, slides) = three();
        assert_eq!(crop_image(&mut zip, &slides, &json!({ "slide": 1, "shape": 1, "left": 5 })), Err("PPTX shape 1 on slide 1 is not a picture".to_owned()));
    }

    #[test]
    fn a_media_file_without_a_known_type_or_poster_is_refused() {
        let (mut zip, slides) = three();
        let proof = mixdog_fsio::Unlaned;
        assert_eq!(
            add_media(&proof, &mut zip, &slides, &json!({ "slide": 1, "path": "clip.xyz", "poster": "p.png" })),
            Err("Unsupported media type: .xyz. Use mp4, m4v, mov, avi, wmv, mp3, m4a, wav".to_owned())
        );
        assert_eq!(
            add_media(&proof, &mut zip, &slides, &json!({ "slide": 1, "path": "clip.mp4" })),
            Err("add_media requires poster for the preview frame".to_owned())
        );
        assert_eq!(
            add_media(&proof, &mut zip, &slides, &json!({ "slide": 1, "kind": "image", "path": "clip.mp4" })),
            Err("add_media kind must be video or audio".to_owned())
        );
    }
}
