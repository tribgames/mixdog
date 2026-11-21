//! `design-template-inspect.mjs`: the reading of a template's XML (the regex reading is kept equal), the walk of a
//! template directory, the slide selection into a new package and the coverage summary.
//!
//! Shapes are `serde_json` values built in the order Node builds its objects, so the JSON text of an inspection is the one
//! `JSON.stringify` gives.

use mixdog_ooxml::zipio::Package;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::nodepath::normalize_host;
use mixdog_js::{js_to_lowercase, js_trim, json_number, locale_compare, number_to_string, string_to_number, to_number, to_number_of};
use mixdog_office_base::values::truthy;
use mixdog_ooxml::xml::{compiled, xml_attribute as raw_attribute, xml_decode};
use serde_json::{Map, Value, json};

use crate::discipline::signed_visual_type;
use crate::library::{MAX_LOCAL_TEMPLATE_COUNT, MAX_SCAN_DEPTH, template_format};
use crate::{opt_prop, prop};

const SLIDE_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const NOTES_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const SLIDE_RELATIONSHIP_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RELATIONSHIP_BLOCK: &str = r"<(?:\w+:)?Relationship\b[^>]*\/?>";

/// `text.length`: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `path.extname(name)`.
pub(crate) fn extname(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    match base.rfind('.') {
        Some(index) if index > 0 && base != ".." => base[index..].to_owned(),
        _ => String::new(),
    }
}

/// The text of a file system error as Node writes it for a missing path, else the system's own.
pub(crate) fn fs_message(error: &std::io::Error, call: &str, path: &Path) -> String {
    if error.kind() == std::io::ErrorKind::NotFound { format!("ENOENT: no such file or directory, {call} '{}'", path.display()) } else { error.to_string() }
}

/// `walkTemplateDirectory(root, output, depth)`: the template files under a directory, depth first, names in locale
/// order; an unreadable directory holds nothing.
pub fn walk_template_directory<P: ReadProof>(proof: &P, root: &Path, output: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_SCAN_DEPTH || output.len() >= MAX_LOCAL_TEMPLATE_COUNT {
        return;
    }
    let Ok(reader) = mixdog_fsio::read_dir(proof, root) else { return };
    let mut entries: Vec<(String, mixdog_fsio::DirEntry)> =
        reader.filter_map(Result::ok).map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry)).collect();
    entries.sort_by(|left, right| locale_compare(&left.0, &right.0));
    for (name, entry) in entries {
        if output.len() >= MAX_LOCAL_TEMPLATE_COUNT {
            break;
        }
        let Ok(kind) = entry.file_type(proof) else { continue };
        let path = PathBuf::from(normalize_host(&root.join(&name).to_string_lossy()));
        if kind.is_dir() {
            walk_template_directory(proof, &path, output, depth + 1);
        } else if kind.is_file() && !compiled(r"\.mixdog-edit\.[^.]+$", "i").is_match(&name) && template_format(&js_to_lowercase(&extname(&name))).is_some() {
            output.push(path);
        }
    }
}

/// `xmlAttribute(source, name)`: the decoded value of an attribute, `""` when it is absent.
pub fn xml_attribute(source: &str, name: &str) -> String {
    xml_decode(&raw_attribute(source, name))
}

fn xml_texts(source: &str) -> Vec<String> {
    compiled(r"<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>", "gi")
        .captures_iter(source)
        .map(|found| js_trim(&xml_decode(found.get(1).unwrap_or(""))).to_owned())
        .filter(|text| !text.is_empty())
        .collect()
}

fn pptx_part_path(target: &str) -> String {
    let raw = target.replace('\\', "/");
    let raw = raw.trim_start_matches('/');
    let prefixed = if raw.starts_with("ppt/") { raw.to_owned() } else { format!("ppt/{raw}") };
    let mut normalized: Vec<&str> = Vec::new();
    for segment in prefixed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            normalized.pop();
        } else {
            normalized.push(segment);
        }
    }
    normalized.join("/")
}

/// `numberFromPath(value)`: the part number an OOXML part path ends with (`slide12.xml` is 12), or 0.
pub fn number_from_path(value: &str) -> f64 {
    let Some(stem) = value.strip_suffix(".xml") else { return 0.0 };
    let digits = stem.len() - stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 { 0.0 } else { string_to_number(&stem[stem.len() - digits..]) }
}

fn by_part_number(left: &String, right: &String) -> std::cmp::Ordering {
    number_from_path(left).partial_cmp(&number_from_path(right)).unwrap_or(std::cmp::Ordering::Equal)
}

/// One slide of a deck in presentation order.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideEntry {
    /// The relationship id the presentation lists the slide under; empty for a deck read by part name.
    pub relationship_id: String,
    pub name: String,
    pub slide: usize,
    pub part: f64,
}

fn numbered(slides: Vec<(String, String)>) -> Vec<SlideEntry> {
    slides
        .into_iter()
        .enumerate()
        .map(|(index, (relationship_id, name))| SlideEntry { part: number_from_path(&name), relationship_id, name, slide: index + 1 })
        .collect()
}

/// `pptxSlideEntries(zip)`: the slides of a deck in the order its presentation lists them; by part number where the
/// presentation or its relationships are missing or list no slide that exists.
pub fn pptx_slide_entries(zip: &Package) -> Vec<SlideEntry> {
    let slide_name = compiled(r"^ppt\/slides\/slide\d+\.xml$", "i");
    let mut fallback: Vec<String> = zip.names().into_iter().filter(|name| slide_name.is_match(name)).collect();
    fallback.sort_by(by_part_number);
    let by_name = |names: Vec<String>| numbered(names.into_iter().map(|name| (String::new(), name)).collect());
    if zip.file("ppt/presentation.xml").is_none() || zip.file("ppt/_rels/presentation.xml.rels").is_none() {
        return by_name(fallback);
    }
    let presentation = zip.text("ppt/presentation.xml");
    let relationships = zip.text("ppt/_rels/presentation.xml.rels");
    let slide_target = compiled(r"(?:^|\/)slides\/slide\d+\.xml$", "i");
    let mut targets = std::collections::HashMap::new();
    for found in compiled(RELATIONSHIP_BLOCK, "gi").find_iter(&relationships) {
        let block = &relationships[found];
        let (id, target) = (xml_attribute(block, "Id"), xml_attribute(block, "Target"));
        if !id.is_empty() && slide_target.is_match(&target) {
            targets.insert(id, target);
        }
    }
    let ordered: Vec<(String, String)> = compiled(r"<(?:\w+:)?sldId\b[^>]*\/?>", "gi")
        .find_iter(&presentation)
        .map(|found| {
            let id = xml_attribute(&presentation[found], "r:id");
            let name = pptx_part_path(targets.get(&id).map_or("", String::as_str));
            (id, name)
        })
        .filter(|(_, name)| zip.file(name).is_some())
        .collect();
    if ordered.is_empty() { by_name(fallback) } else { numbered(ordered) }
}

fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `xmlSetAttribute(source, name, value)`: the first attribute of that name rewritten where it is.
fn xml_set_attribute(source: &str, name: &str, value: &str) -> String {
    let pattern = compiled(&format!(r#"(\b{}=")[^"]*(")"#, regex_escape(name)), "i");
    match pattern.captures(source) {
        Some(found) => {
            let range = found.range();
            format!("{}{}{value}{}{}", &source[..range.start], found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), &source[range.end..])
        }
        None => source.to_owned(),
    }
}

fn relationship_type(block: &str, suffix: &str) -> bool {
    js_to_lowercase(&xml_attribute(block, "Type")).ends_with(&format!("/{}", js_to_lowercase(suffix)))
}

fn ensure_content_type_override(xml: &str, part_name: &str, content_type: &str) -> String {
    if xml.is_empty() || compiled(&format!(r#"\bPartName="{}""#, regex_escape(part_name)), "i").is_match(xml) {
        return xml.to_owned();
    }
    match compiled(r"<\/Types>", "i").find(xml) {
        Some(at) => format!("{}<Override PartName=\"{part_name}\" ContentType=\"{content_type}\"/>{}", &xml[..at.start], &xml[at.start..]),
        None => xml.to_owned(),
    }
}

fn relationship_blocks(xml: &str) -> Vec<String> {
    compiled(RELATIONSHIP_BLOCK, "gi").find_iter(xml).map(|found| xml[found].to_owned()).collect()
}

/// One relationship id per selected slide: the source deck's slide ids in order where they are free, fresh rId numbers
/// where they would collide with a non-slide relationship or an earlier pick.
fn selected_slide_relationship_ids(entries: &[SlideEntry], relationships: &str, count: usize) -> Vec<String> {
    let slide_ids: Vec<&str> = entries.iter().map(|entry| entry.relationship_id.as_str()).filter(|id| !id.is_empty()).collect();
    let non_slide: HashSet<String> =
        relationship_blocks(relationships).iter().filter(|block| !relationship_type(block, "slide")).map(|block| xml_attribute(block, "Id")).collect();
    let mut ids: Vec<String> = Vec::new();
    let mut next = 2;
    for index in 0..count {
        let mut id = slide_ids.get(index).copied().unwrap_or("").to_owned();
        while id.is_empty() || non_slide.contains(&id) || ids.contains(&id) {
            id = format!("rId{next}");
            next += 1;
        }
        ids.push(id);
    }
    ids
}

/// The slide part, its relationships, and its notes slide with theirs.
struct SlideParts {
    slide: String,
    slide_relationships: String,
    notes: String,
    notes_relationships: String,
}

fn read_slide_parts(zip: &Package, entry: &SlideEntry) -> SlideParts {
    let part = number_to_string(entry.part);
    let slide_relationships = zip.text(&format!("ppt/slides/_rels/slide{part}.xml.rels"));
    let notes_target = relationship_blocks(&slide_relationships)
        .into_iter()
        .find(|block| relationship_type(block, "notesSlide"))
        .map(|block| xml_attribute(&block, "Target"))
        .unwrap_or_default();
    let notes_part = compiled(r"notesSlide(\d+)\.xml$", "i").captures(&notes_target).and_then(|found| found.get(1).map(string_to_number)).unwrap_or(0.0);
    let (notes, notes_relationships) = if notes_part != 0.0 {
        let number = number_to_string(notes_part);
        (zip.text(&format!("ppt/notesSlides/notesSlide{number}.xml")), zip.text(&format!("ppt/notesSlides/_rels/notesSlide{number}.xml.rels")))
    } else {
        (String::new(), String::new())
    };
    SlideParts { slide: zip.text(&entry.name), slide_relationships, notes, notes_relationships }
}

fn presentation_with_slide_list(presentation: &str, relationship_ids: &[String]) -> Result<String, String> {
    let pattern = compiled(r"<((?:\w+:)?)sldIdLst\b[^>]*>[\s\S]*?<\/\1sldIdLst>", "i");
    let Some(found) = pattern.captures(presentation) else { return Err("PPTX presentation slide list is missing".to_owned()) };
    let prefix = found.get(1).unwrap_or("");
    let ids: String = relationship_ids.iter().enumerate().map(|(index, id)| format!("<{prefix}sldId id=\"{}\" r:id=\"{id}\"/>", 256 + index)).collect();
    let range = found.range();
    Ok(format!("{}<{prefix}sldIdLst>{ids}</{prefix}sldIdLst>{}", &presentation[..range.start], &presentation[range.end..]))
}

fn presentation_relationships_with_slides(relationships: &str, relationship_ids: &[String]) -> String {
    let slides: String = relationship_ids
        .iter()
        .enumerate()
        .map(|(index, id)| format!("<Relationship Id=\"{id}\" Type=\"{SLIDE_RELATIONSHIP_TYPE}\" Target=\"slides/slide{}.xml\"/>", index + 1))
        .collect();
    let kept = compiled(RELATIONSHIP_BLOCK, "gi").replace_all_with(relationships, |found| {
        let block = found.get(0).unwrap_or("");
        if relationship_type(block, "slide") { String::new() } else { block.to_owned() }
    });
    match compiled(r"<\/Relationships>", "i").find(&kept) {
        Some(at) => format!("{}{slides}{}", &kept[..at.start], &kept[at.start..]),
        None => kept,
    }
}

/// Retargets the relationships of a part whose `kind` relationship points at a part that moved.
fn retargeted(relationships: &str, kind: &str, target: &str) -> String {
    compiled(RELATIONSHIP_BLOCK, "gi").replace_all_with(relationships, |found| {
        let block = found.get(0).unwrap_or("");
        if relationship_type(block, kind) { xml_set_attribute(block, "Target", target) } else { block.to_owned() }
    })
}

/// Writes one selected slide (and its notes) under its new ordinal, retargeting the slide and notes relationships to
/// each other; answers the content types with both parts declared.
fn write_selected_slide(zip: &mut Package, part: &SlideParts, target: usize, content_types: &str) -> String {
    zip.set(&format!("ppt/slides/slide{target}.xml"), part.slide.as_bytes());
    if part.slide_relationships.is_empty() {
        zip.remove(&format!("ppt/slides/_rels/slide{target}.xml.rels"));
    } else {
        let rels = retargeted(&part.slide_relationships, "notesSlide", &format!("../notesSlides/notesSlide{target}.xml"));
        zip.set(&format!("ppt/slides/_rels/slide{target}.xml.rels"), rels.as_bytes());
    }
    let declared = ensure_content_type_override(content_types, &format!("/ppt/slides/slide{target}.xml"), SLIDE_CONTENT_TYPE);
    if part.notes.is_empty() {
        return declared;
    }
    zip.set(&format!("ppt/notesSlides/notesSlide{target}.xml"), part.notes.as_bytes());
    let notes_rels = retargeted(&part.notes_relationships, "slide", &format!("../slides/slide{target}.xml"));
    if !notes_rels.is_empty() {
        zip.set(&format!("ppt/notesSlides/_rels/notesSlide{target}.xml.rels"), notes_rels.as_bytes());
    }
    ensure_content_type_override(&declared, &format!("/ppt/notesSlides/notesSlide{target}.xml"), NOTES_CONTENT_TYPE)
}

/// `createPptxSlideSelection(sourcePath, slides, outputPath)`: a new deck holding the chosen slides (1-based, in the
/// order given, a slide may repeat) with their notes, written to `output`. A package that fails to be written leaves no
/// file behind.
pub fn create_pptx_slide_selection<P: WriteProof>(lane: &P, source: &str, slides: &Value, output: &str) -> Result<Value, String> {
    let selected: Vec<f64> = slides.as_array().map(|items| items.iter().map(to_number).collect()).unwrap_or_default();
    if selected.is_empty() || selected.iter().any(|slide| !slide.is_finite() || slide.fract() != 0.0 || *slide < 1.0) {
        return Err("PPTX slide selection requires positive integer slide numbers".to_owned());
    }
    let bytes = mixdog_fsio::read(lane, source).map_err(|error| fs_message(&error, "open", Path::new(source)))?;
    let mut zip = super::load_zip(&bytes)?;
    let entries = pptx_slide_entries(&zip);
    if selected.iter().any(|slide| *slide > entries.len() as f64) {
        return Err(format!("PPTX slide selection is outside source deck range 1-{}", entries.len()));
    }
    if zip.file("ppt/presentation.xml").is_none() || zip.file("ppt/_rels/presentation.xml.rels").is_none() {
        return Err("PPTX presentation relationships are missing".to_owned());
    }
    let presentation = zip.text("ppt/presentation.xml");
    let relationships = zip.text("ppt/_rels/presentation.xml.rels");
    let relationship_ids = selected_slide_relationship_ids(&entries, &relationships, selected.len());
    let parts: Vec<SlideParts> = selected.iter().map(|slide| read_slide_parts(&zip, &entries[*slide as usize - 1])).collect();
    zip.set("ppt/presentation.xml", presentation_with_slide_list(&presentation, &relationship_ids)?.into_bytes());
    zip.set("ppt/_rels/presentation.xml.rels", presentation_relationships_with_slides(&relationships, &relationship_ids).into_bytes());
    let mut content_types = zip.text("[Content_Types].xml");
    for (index, part) in parts.iter().enumerate() {
        content_types = write_selected_slide(&mut zip, part, index + 1, &content_types);
    }
    if !content_types.is_empty() {
        zip.set("[Content_Types].xml", content_types.into_bytes());
    }
    if zip.file("docProps/app.xml").is_some() {
        let app = zip.text("docProps/app.xml");
        let rewritten = match compiled(r"<Slides>\d+<\/Slides>", "i").find(&app) {
            Some(at) => format!("{}<Slides>{}</Slides>{}", &app[..at.start], selected.len(), &app[at.end..]),
            None => app,
        };
        zip.set("docProps/app.xml", rewritten.into_bytes());
    }
    write_package(lane, &zip, output)?;
    Ok(json!({ "output": output, "source": source, "slides": selected.iter().map(|slide| json_number(*slide)).collect::<Vec<_>>(), "count": selected.len() }))
}

/// A package that fails to serialize leaves no half-written file behind.
fn write_package<P: WriteProof>(lane: &P, zip: &Package, output: &str) -> Result<(), String> {
    let path = Path::new(output);
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        mixdog_fsio::create_dir_all(lane, parent).map_err(|error| fs_message(&error, "mkdir", parent))?;
    }
    let written = zip.generate().and_then(|bytes| mixdog_fsio::write(lane, path, bytes).map_err(|error| fs_message(&error, "open", path)));
    if written.is_err() {
        let _ = mixdog_fsio::remove_file(lane, path);
    }
    written
}

/// A shape element of a slide tree: its kind (`sp`, `pic`, `graphicFrame` or `grpSp`) and its text.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapeBlock {
    pub kind: String,
    pub xml: String,
}

/// `directPptxShapeBlocks(xml)`: the shapes directly under the slide's shape tree (a group counts as one).
pub fn direct_pptx_shape_blocks(xml: &str) -> Vec<ShapeBlock> {
    let tree = compiled(r"<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>", "i").captures(xml).and_then(|found| found.get(1)).unwrap_or("");
    let mut stack: Vec<String> = Vec::new();
    let mut output = Vec::new();
    let mut start: Option<usize> = None;
    let mut root_type = String::new();
    for found in compiled(r"<\/?p:(sp|pic|graphicFrame|grpSp)\b[^>]*>", "gi").captures_iter(tree) {
        let range = found.range();
        let token = &tree[range.clone()];
        let kind = found.get(1).unwrap_or("").to_owned();
        if !token.starts_with("</") {
            if stack.is_empty() {
                start = Some(range.start);
                root_type = kind.clone();
            }
            stack.push(kind);
        } else {
            let current = stack.pop();
            if current.as_deref() != Some(kind.as_str()) {
                stack.clear();
                start = None;
                root_type.clear();
                continue;
            }
            if let (true, Some(from)) = (stack.is_empty(), start) {
                output.push(ShapeBlock { kind: std::mem::take(&mut root_type), xml: tree[from..range.end].to_owned() });
                start = None;
            }
        }
    }
    output
}

fn token_slot_role(text: &str) -> String {
    let Some(token) = compiled(r"\{\{([A-Z0-9_]+)\}\}", "").captures(text).and_then(|found| found.get(1).map(str::to_owned)) else { return String::new() };
    for (pattern, family) in
        [(r"^METRIC_(\d+)_(VALUE|LABEL|DETAIL)$", "metric"), (r"^COLUMN_(\d+)_(TITLE|BODY)$", "column"), (r"^STEP_(\d+)_(TITLE|DETAIL)$", "step")]
    {
        if let Some(found) = compiled(pattern, "").captures(&token) {
            return format!("{family}-{}-{}", js_to_lowercase(found.get(2).unwrap_or("")), found.get(1).unwrap_or(""));
        }
    }
    js_to_lowercase(&token).replace('_', "-")
}

/// `pptxSlot(metadata, role)`: the slot a shape fills under a role; null for no role.
pub fn pptx_slot(metadata: &Value, role: &str) -> Value {
    if role.is_empty() {
        return Value::Null;
    }
    let mut slot = Map::new();
    slot.insert("role".to_owned(), Value::String(role.to_owned()));
    slot.insert("type".to_owned(), prop(metadata, "type").cloned().unwrap_or(Value::Null));
    slot.insert("shape".to_owned(), prop(metadata, "shape").cloned().unwrap_or(Value::Null));
    if let Some(kind) = prop(metadata, "placeholderType").filter(|kind| truthy(kind)) {
        slot.insert("placeholderType".to_owned(), kind.clone());
    }
    if let Some(index) = prop(metadata, "placeholderIndex").filter(|index| index.as_f64().is_some_and(|n| n.fract() == 0.0)) {
        slot.insert("placeholderIndex".to_owned(), index.clone());
    }
    slot.insert("geometry".to_owned(), prop(metadata, "geometry").cloned().unwrap_or(Value::Null));
    slot.insert("required".to_owned(), Value::Bool(role == "title"));
    Value::Object(slot)
}

fn shape_kind(block: &ShapeBlock) -> &'static str {
    let xml = block.xml.as_str();
    if block.kind == "pic" {
        "image"
    } else if block.kind == "graphicFrame" && compiled(r"<c:chart\b", "i").is_match(xml) {
        "chart"
    } else if block.kind == "graphicFrame" && compiled(r"<a:tbl\b", "i").is_match(xml) {
        "table"
    } else if block.kind == "graphicFrame" || block.kind == "grpSp" {
        "diagram"
    } else {
        "text"
    }
}

fn shape_role(text: &str, placeholder_type: &str, kind: &str, shape: usize) -> String {
    let role = token_slot_role(text);
    if !role.is_empty() {
        return role;
    }
    if placeholder_type == "title" || placeholder_type == "ctrTitle" {
        "title".to_owned()
    } else if placeholder_type == "subTitle" {
        "subtitle".to_owned()
    } else if placeholder_type == "pic" || kind == "image" {
        "image".to_owned()
    } else if kind == "chart" {
        "chart".to_owned()
    } else if kind == "table" {
        "table".to_owned()
    } else if !placeholder_type.is_empty() {
        format!("body-{shape}")
    } else {
        String::new()
    }
}

/// `pptxShapeMetadata(block, shape)`: what a shape element says of itself: name, kind, text, placeholder, geometry,
/// type size, outline, and the slot its tokens or placeholder name.
pub fn pptx_shape_metadata(block: &ShapeBlock, shape: usize) -> Value {
    let xml = block.xml.as_str();
    let first = |pattern: &str| compiled(pattern, "i").find(xml).map(|range| &xml[range]).unwrap_or("");
    let c_nv_pr = first(r"<p:cNvPr\b[^>]*>");
    let placeholder = first(r"<p:ph\b[^>]*\/?>");
    let placeholder_type = xml_attribute(placeholder, "type");
    let placeholder_index = string_to_number(&xml_attribute(placeholder, "idx"));
    let text = xml_texts(xml).join("\n");
    let off = first(r"<a:off\b[^>]*>");
    let ext = first(r"<a:ext\b[^>]*>");
    let number = |source: &str, name: &str| {
        let value = string_to_number(&xml_attribute(source, name));
        if value.is_nan() || value == 0.0 { 0.0 } else { value }
    };
    let geometry = json!({
        "left": json_number(number(off, "x")),
        "top": json_number(number(off, "y")),
        "width": json_number(number(ext, "cx")),
        "height": json_number(number(ext, "cy")),
    });
    let kind = shape_kind(block);
    let font_sizes: Vec<f64> = compiled(r#"<a:rPr\b[^>]*\bsz="(\d+)""#, "gi")
        .captures_iter(xml)
        .map(|found| string_to_number(found.get(1).unwrap_or("")) / 100.0)
        .filter(|size| *size > 0.0)
        .collect();
    let preset = if block.kind == "sp" {
        compiled(r#"<a:prstGeom\b[^>]*\bprst="([^"]+)""#, "i").captures(xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
    } else {
        String::new()
    };
    let mut metadata = Map::new();
    metadata.insert("shape".to_owned(), json!(shape));
    metadata.insert("name".to_owned(), Value::String(xml_attribute(c_nv_pr, "name")));
    metadata.insert("type".to_owned(), Value::String(kind.to_owned()));
    metadata.insert("text".to_owned(), Value::String(text.clone()));
    metadata.insert("placeholderType".to_owned(), Value::String(placeholder_type.clone()));
    if placeholder_index.is_finite() && placeholder_index.fract() == 0.0 {
        metadata.insert("placeholderIndex".to_owned(), json_number(placeholder_index));
    }
    metadata.insert("geometry".to_owned(), geometry);
    if !font_sizes.is_empty() {
        metadata.insert("fontSize".to_owned(), json_number(font_sizes.iter().copied().fold(f64::NEG_INFINITY, f64::max)));
    }
    if !preset.is_empty() {
        metadata.insert("preset".to_owned(), Value::String(preset));
    }
    let role = shape_role(&text, &placeholder_type, kind, shape);
    let mut metadata = Value::Object(metadata);
    let slot = pptx_slot(&metadata, &role);
    if !slot.is_null() {
        metadata["slot"] = slot;
    }
    metadata
}

/// `inferPptxSampleKind(sample, total)`: the job a page does: cover, closing, process, comparison, metrics, split,
/// statement or content.
pub fn infer_pptx_sample_kind(sample: &Value, total: f64) -> String {
    let roles: Vec<String> =
        prop(sample, "slots").and_then(Value::as_array).map(|slots| slots.iter().map(|slot| crate::text(prop(slot, "role"))).collect()).unwrap_or_default();
    let title = js_to_lowercase(&crate::text(prop(sample, "title")));
    let any = |prefix: &str| roles.iter().any(|role| role.starts_with(prefix));
    // The first page is the cover unless it carries a structure no cover has: a flow of steps, or columns with their
    // bodies under them. A deck that opens on its comparison page says so instead of being read as a title page.
    let structured = any("step-") || any("column-body-");
    let slide = to_number_of(prop(sample, "slide"));
    if slide == 1.0 && !structured {
        return "cover".to_owned();
    }
    if slide == total && compiled(r"(thank|next|close|감사|다음)", "i").is_match(&title) {
        return "closing".to_owned();
    }
    // A structure the kit signed says what it is: a timeline sets its labels above and below its spine, and read by rows
    // alone it was a two-column comparison.
    let signed = signed_visual_type(sample);
    if ["structure:timeline", "structure:steps", "process"].contains(&signed.as_str()) || any("step-") {
        return "process".to_owned();
    }
    if any("column-") {
        return "comparison".to_owned();
    }
    // A table carries quantities the same way a chart does, and the page that holds one does the same job.
    if roles.iter().any(|role| role == "chart" || role == "table") || any("metric-") {
        return "metrics".to_owned();
    }
    if roles.iter().any(|role| role == "image") {
        return "split".to_owned();
    }
    let shapes = prop(sample, "shapes").and_then(Value::as_array).map_or(0, Vec::len);
    if to_number_of(prop(sample, "textChars")) < 90.0 && shapes <= 6 {
        return "statement".to_owned();
    }
    "content".to_owned()
}

fn numbered_role_groups(slots: &[Value], prefix: &str) -> usize {
    let pattern = compiled(&format!(r"^{prefix}-(?:value|label|detail|title|body)-(\d+)$"), "");
    let mut numbers: Vec<f64> = Vec::new();
    for slot in slots {
        if let Some(found) = pattern.captures(&crate::text(prop(slot, "role"))) {
            let number = string_to_number(found.get(1).unwrap_or(""));
            if !numbers.contains(&number) {
                numbers.push(number);
            }
        }
    }
    numbers.len()
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

/// `pptxSampleCapacity(sample)`: how much text and how many groups a page holds.
pub fn pptx_sample_capacity(sample: &Value) -> Value {
    let slots: Vec<Value> = prop(sample, "slots").and_then(Value::as_array).cloned().unwrap_or_default();
    let text_slots: Vec<&Value> = slots.iter().filter(|slot| prop(slot, "type") == Some(&Value::String("text".to_owned()))).collect();
    let area: f64 = text_slots
        .iter()
        .map(|slot| number_or_zero(opt_prop(prop(slot, "geometry"), "width")).max(0.0) * number_or_zero(opt_prop(prop(slot, "geometry"), "height")).max(0.0))
        .sum();
    json!({
        "sampleTextChars": json_number(number_or_zero(prop(sample, "textChars"))),
        "shapeCount": prop(sample, "shapes").and_then(Value::as_array).map_or(0, Vec::len),
        "textSlots": text_slots.len(),
        "metricGroups": numbered_role_groups(&slots, "metric"),
        "columnGroups": numbered_role_groups(&slots, "column"),
        "stepGroups": numbered_role_groups(&slots, "step"),
        "textArea": json_number((area + 0.5).floor()),
    })
}

/// `[...new Set(values)].sort()`: the default sort compares UTF-16 code units.
fn unique_sorted(values: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut unique: Vec<Value> = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique.sort_by_key(|value| mixdog_js::value_to_string(value).encode_utf16().collect::<Vec<u16>>());
    unique
}

/// `officeTemplateCoverage(sampleSlides)`: which kinds, densities, purposes, expression modes and native objects the
/// pages of a template cover, and which of the recommended ones it lacks.
pub fn office_template_coverage(sample_slides: &[Value]) -> Value {
    let field_texts = |key: &str| unique_sorted(sample_slides.iter().map(|sample| Value::String(crate::text(prop(sample, key)))).filter(|value| *value != ""));
    let list_values = |key: &str| {
        unique_sorted(
            sample_slides.iter().flat_map(|sample| prop(sample, key).filter(|value| truthy(value)).and_then(Value::as_array).cloned().unwrap_or_default()),
        )
    };
    let kinds = field_texts("kind");
    let densities = field_texts("density");
    let purposes = list_values("purposes");
    let expression_modes = list_values("expressionModes");
    let capabilities = list_values("capabilities");
    let has = |list: &[Value], name: &str| list.iter().any(|value| value == name);
    let missing = |recommended: &[&str], list: &[Value]| -> Vec<Value> { recommended.iter().filter(|name| !has(list, name)).map(|name| json!(name)).collect() };
    let recommended_kinds = ["cover", "content", "statement", "comparison", "process", "metrics", "split", "closing"];
    let recommended_densities = ["light", "balanced", "dense"];
    let complete = recommended_kinds.iter().all(|kind| has(&kinds, kind))
        && recommended_densities.iter().all(|density| has(&densities, density))
        && ["image", "chart", "table"].iter().all(|capability| has(&capabilities, capability));
    json!({
        "sampleCount": sample_slides.len(),
        "kinds": kinds,
        "densities": densities,
        "purposes": purposes,
        "expressionModes": expression_modes,
        "capabilities": capabilities,
        "missingKinds": missing(&recommended_kinds, &kinds),
        "missingDensities": missing(&recommended_densities, &densities),
        "missingPurposes": missing(&["compare", "decide", "explain", "monitor"], &purposes),
        "missingExpressionModes": missing(&["conservative", "strong-fit", "divergent"], &expression_modes),
        "nativeObjectCoverage": {
            "image": has(&capabilities, "image"),
            "chart": has(&capabilities, "chart"),
            "table": has(&capabilities, "table"),
            "diagram": has(&capabilities, "diagram"),
        },
        "complete": complete,
    })
}
