//! `portable/portable-pptx-package.mjs`: the parts a presentation keeps its slides in. Slide, layout, master, notes and
//! comment parts are listed and written here; slide ids and relationship ids are allocated the way PowerPoint numbers them,
//! so the package that comes out holds the text the Node writer produced.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{js_to_lowercase, js_trim, json_number, math, string_to_number, to_number, value_to_string};
use mixdog_office_base::write_note::WriteNote;
use serde_json::{Value, json};

use crate::opc::{
    IMAGE_CONTENT_TYPES, PACKAGE_RELATIONSHIP_NS, add_package_relationship, ensure_content_type_override,
    ensure_default_content_type, image_content_type, part_from_target, part_relationship_path, posix, relationship_map,
    relationship_target_by_type, remove_content_type_override, remove_package_relationship, rewrite_imported_relationships,
};
use crate::package::{load_package, os_message, save_package};
use crate::slide_shapes::{replace_first_text, text_body_xml, text_or_empty};
use crate::xml::{OFFICE_RELATIONSHIP_BASE, XML_HEADER, block_text, compiled, tag_pattern, xml_attribute, xml_decode, xml_encode};
use crate::zipio::Package;

const PRESENTATION_PART: &str = "ppt/presentation.xml";
const PRESENTATION_RELATIONSHIPS: &str = "ppt/_rels/presentation.xml.rels";

fn presentation_namespaces() -> String {
    format!(
        "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\""
    )
}

pub const SLIDE_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const NOTES_SLIDE_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const NOTES_MASTER_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";
const THEME_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";
const COMMENTS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml";
const COMMENT_AUTHORS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml";

fn empty_group_shape() -> &'static str {
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
}

/// A slide as the presentation lists it: its id, the relationship id it is reached by and its part.
#[derive(Debug, Clone, PartialEq)]
pub struct SlideRef {
    pub id: f64,
    pub rid: String,
    pub path: String,
}

impl SlideRef {
    /// The `{ id, rid, path }` object Node passed around.
    pub fn to_value(&self) -> Value {
        json!({ "id": json_number(self.id), "rid": self.rid, "path": self.path })
    }
}

/// `presentationSlides(zip)`: the slides in the order the presentation lists them; a presentation that lists none is read
/// from the slide parts by their number.
pub fn presentation_slides(zip: &Package) -> Vec<SlideRef> {
    let presentation = zip.text(PRESENTATION_PART);
    let rels = relationship_map(&zip.text(PRESENTATION_RELATIONSHIPS));
    let mut slides = Vec::new();
    for found in compiled(r"<p:sldId\b([^>]*?)/>", "g").captures_iter(&presentation) {
        let attributes = found.get(1).unwrap_or("");
        let rid = compiled(r#"\br:id="([^"]+)""#, "").captures(attributes).and_then(|id| id.get(1).map(str::to_owned)).unwrap_or_default();
        let target = if rid.is_empty() { "" } else { rels.get(&rid).unwrap_or("") };
        if target.is_empty() {
            continue;
        }
        let id = compiled(r#"\bid="(\d+)""#, "")
            .captures(attributes)
            .and_then(|id| id.get(1).map(string_to_number))
            .filter(|id| *id != 0.0 && !id.is_nan())
            .unwrap_or(0.0);
        let path = match target.strip_prefix('/') {
            Some(rooted) => rooted.to_owned(),
            None => posix::normalize(&posix::join(&["ppt", target])),
        };
        slides.push(SlideRef { id, rid, path });
    }
    if !slides.is_empty() {
        return slides;
    }
    let pattern = compiled(r"^ppt\/slides\/slide\d+\.xml$", "");
    let number = |name: &str| -> f64 {
        compiled(r"(\d+)\.xml$", "").captures(name).and_then(|found| found.get(1).map(string_to_number)).unwrap_or(f64::NAN)
    };
    let mut names: Vec<String> = zip.names().into_iter().filter(|name| pattern.is_match(name)).collect();
    mixdog_js::js_sort_by(&mut names, |left, right| number(left) - number(right));
    names.into_iter().map(|path| SlideRef { id: 0.0, rid: String::new(), path }).collect()
}

/// `slides[Number(number) - 1]`.
pub fn slide_at<'a>(slides: &'a [SlideRef], number: &Value) -> Option<&'a SlideRef> {
    let index = to_number(number) - 1.0;
    if index.fract() != 0.0 || index < 0.0 || index >= slides.len() as f64 {
        return None;
    }
    slides.get(index as usize)
}

/// `slidePath(slides, number)`.
pub fn slide_path(slides: &[SlideRef], number: &Value) -> Result<String, String> {
    slide_at(slides, number).map(|slide| slide.path.clone()).ok_or_else(|| format!("PPTX slide {} not found", value_to_string(number)))
}

/// A slide layout part: its name and its type as the layout declares them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutPart {
    pub path: String,
    pub name: String,
    pub layout_type: String,
}

impl LayoutPart {
    /// The `{ path, name, type }` object Node passed around.
    pub fn to_value(&self) -> Value {
        json!({ "path": self.path, "name": self.name, "type": self.layout_type })
    }
}

/// `slideLayoutParts(zip)`: the layouts in the order of their number.
pub fn slide_layout_parts(zip: &Package) -> Vec<LayoutPart> {
    let pattern = compiled(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$", "");
    let number = |name: &str| -> f64 {
        compiled(r"(\d+)\.xml$", "").captures(name).and_then(|found| found.get(1).map(string_to_number)).unwrap_or(f64::NAN)
    };
    let mut paths: Vec<String> = zip.names().into_iter().filter(|name| pattern.is_match(name)).collect();
    mixdog_js::js_sort_by(&mut paths, |left, right| number(left) - number(right));
    paths
        .into_iter()
        .map(|path| {
            let xml = zip.text(&path);
            let name = compiled(r#"<p:cSld\b[^>]*\bname="([^"]*)""#, "").captures(&xml).and_then(|found| found.get(1).map(xml_decode)).unwrap_or_default();
            let layout_type =
                compiled(r#"<p:sldLayout\b[^>]*\btype="([^"]*)""#, "").captures(&xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
            LayoutPart { path, name, layout_type }
        })
        .collect()
}

// The default layouts' English names name the same layout types in a deck of another language, as the Office backend
// reads them: 'Title Only' found nothing in a deck Korean PowerPoint wrote, whose layout is "제목만".
const DEFAULT_LAYOUT_TYPES: [(&str, &str); 10] = [
    ("title slide", "title"),
    ("title and content", "obj"),
    ("section header", "secHead"),
    ("two content", "twoObj"),
    ("comparison", "twoTxTwoObj"),
    ("title only", "titleOnly"),
    ("content with caption", "objTx"),
    ("picture with caption", "picTx"),
    ("title and vertical text", "vertTx"),
    ("vertical title and text", "vertTitleAndTx"),
];

/// `selectSlideLayout(layouts, requested)`: the layout a request names (empty: a blank one; a number: that layout; else a
/// name, a type, or the English name of a default layout).
pub fn select_slide_layout<'a>(layouts: &'a [LayoutPart], requested: Option<&Value>) -> Result<&'a LayoutPart, String> {
    if layouts.is_empty() {
        return Err("Presentation has no slide layout for a new slide".to_owned());
    }
    let value = js_trim(&text_or_empty(requested)).to_owned();
    if value.is_empty() {
        return Ok(layouts.iter().find(|layout| layout.layout_type == "blank").unwrap_or(&layouts[0]));
    }
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        let at = string_to_number(&value) - 1.0;
        let found = if at.fract() == 0.0 && at >= 0.0 { layouts.get(at as usize) } else { None };
        return found.ok_or_else(|| format!("Slide layout {value} not found"));
    }
    let lowered = js_to_lowercase(&value);
    let default_type = DEFAULT_LAYOUT_TYPES.iter().find(|(name, _)| *name == lowered).map(|(_, layout_type)| *layout_type);
    let matched = layouts
        .iter()
        .find(|layout| js_to_lowercase(&layout.name) == lowered)
        .or_else(|| layouts.iter().find(|layout| js_to_lowercase(&layout.layout_type) == lowered))
        .or_else(|| default_type.and_then(|wanted| layouts.iter().find(|layout| layout.layout_type == wanted)));
    matched.ok_or_else(|| {
        let available: Vec<&str> = layouts
            .iter()
            .map(|layout| {
                if !layout.name.is_empty() {
                    layout.name.as_str()
                } else if !layout.layout_type.is_empty() {
                    layout.layout_type.as_str()
                } else {
                    "(unnamed)"
                }
            })
            .collect();
        format!("Slide layout not found: {value}. Available: {}", available.join(", "))
    })
}

fn slide_id_list() -> std::sync::Arc<mixdog_js::JsRegex> {
    compiled(r"<p:sldIdLst\b[^>]*?(?:/>|>[\s\S]*?</p:sldIdLst>)", "")
}

/// `writeSlideIdList(presentation, entries)`: the presentation with its slide id list replaced by the entries (or put
/// before the slide size when it had none).
pub fn write_slide_id_list(presentation: &str, entries: &[String]) -> String {
    let element = format!("<p:sldIdLst>{}</p:sldIdLst>", entries.concat());
    if let Some(existing) = slide_id_list().find(presentation) {
        return format!("{}{element}{}", &presentation[..existing.start], &presentation[existing.end..]);
    }
    if let Some(size) = compiled(r"<p:sldSz\b", "").find(presentation) {
        return format!("{}{element}{}", &presentation[..size.start], &presentation[size.start..]);
    }
    replace_first_text(presentation, "</p:presentation>", &format!("{element}</p:presentation>"))
}

/// `slideIdEntries(presentation)`: the `<p:sldId .../>` elements of the slide id list.
pub fn slide_id_entries(presentation: &str) -> Vec<String> {
    match slide_id_list().find(presentation) {
        Some(list) => {
            let block = &presentation[list];
            compiled(r"<p:sldId\b[^>]*?/>", "g").find_iter(block).map(|found| block[found].to_owned()).collect()
        }
        None => Vec::new(),
    }
}

/// `Number(xmlAttribute(entry, 'id')) || 0`.
fn entry_id(entry: &str) -> f64 {
    let id = string_to_number(&xml_attribute(entry, "id"));
    if id.is_nan() { 0.0 } else { id }
}

/// Lists a slide relationship in the presentation's slide order at `position` (at most the end) under the next free slide
/// id; answers with the index used.
fn insert_slide_id(zip: &mut Package, relationship_id: &str, position: f64) -> f64 {
    let presentation = zip.text(PRESENTATION_PART);
    let mut entries = slide_id_entries(&presentation);
    let highest = entries.iter().map(|entry| entry_id(entry)).fold(255.0, math::max);
    let index = math::min(position, entries.len() as f64);
    let at = index.trunc().max(0.0) as usize;
    entries.insert(at.min(entries.len()), format!("<p:sldId id=\"{}\" r:id=\"{relationship_id}\"/>", crate::slide_shapes::num(highest + 1.0)));
    zip.set(PRESENTATION_PART, write_slide_id_list(&presentation, &entries));
    index
}

/// A new slide with no layout named takes the layout of the slide it follows, as PowerPoint's New Slide does: a blank
/// layout dropped the deck's page number, running mark, and paper from a page added between two content pages. After a
/// title page it takes the blank layout instead: a second cover is not what follows a cover.
fn following_layout<'a>(zip: &Package, layouts: &'a [LayoutPart], index: Option<&Value>) -> Option<&'a LayoutPart> {
    let slides = presentation_slides(zip);
    let wanted = index.map_or(f64::NAN, to_number);
    let last = if wanted > 0.0 { wanted - 1.0 } else { slides.len() as f64 };
    let at = math::min(slides.len() as f64, last) - 1.0;
    let before = (if at.fract() == 0.0 && at >= 0.0 { slides.get(at as usize) } else { None })?;
    let target = relationship_target_by_type(&zip.text(&part_relationship_path(&before.path)), "slideLayout");
    if target.is_empty() {
        return None;
    }
    let path = part_from_target(&posix::dirname(&before.path), &target);
    layouts.iter().find(|entry| entry.path == path).filter(|layout| layout.layout_type != "title")
}

/// The first `prefix<n>suffix` (n from 1) the package has no file for.
fn next_ordinal(zip: &Package, prefix: &str, suffix: &str) -> usize {
    let mut ordinal = 1;
    while zip.file(&format!("{prefix}{ordinal}{suffix}")).is_some() {
        ordinal += 1;
    }
    ordinal
}

/// `addPresentationSlide(zip, op)`: a slide of the layout the operation names (`op.layout`) at `op.index`; answers
/// `{ part, position, layout }`.
pub fn add_presentation_slide(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let layouts = slide_layout_parts(zip);
    let named = js_trim(&text_or_empty(op.get("layout"))).to_owned();
    let following = if named.is_empty() { following_layout(zip, &layouts, op.get("index")) } else { None };
    let layout = match following {
        Some(layout) => layout,
        None => select_slide_layout(&layouts, op.get("layout"))?,
    };
    let ordinal = next_ordinal(zip, "ppt/slides/slide", ".xml");
    let part = format!("ppt/slides/slide{ordinal}.xml");
    zip.set(
        &part,
        format!(
            "{XML_HEADER}<p:sld {}><p:cSld><p:spTree>{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            presentation_namespaces(),
            empty_group_shape()
        ),
    );
    zip.set(
        &part_relationship_path(&part),
        format!(
            "{XML_HEADER}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELATIONSHIP_BASE}/slideLayout\" Target=\"{}\"/></Relationships>",
            posix::relative("ppt/slides", &layout.path)
        ),
    );
    ensure_content_type_override(zip, &format!("/{part}"), SLIDE_CONTENT_TYPE);
    let relationship_id = add_package_relationship(
        zip,
        PRESENTATION_RELATIONSHIPS,
        &format!("{OFFICE_RELATIONSHIP_BASE}/slide"),
        &format!("slides/slide{ordinal}.xml"),
        "",
    );
    let index = op.get("index").map_or(f64::NAN, to_number);
    let requested = if index > 0.0 { index - 1.0 } else { f64::INFINITY };
    let position = insert_slide_id(zip, &relationship_id, requested);
    let described = [&layout.name, &layout.layout_type, &layout.path].into_iter().find(|text| !text.is_empty()).map_or_else(String::new, |text| text.clone());
    Ok(json!({ "part": part, "position": json_number(position + 1.0), "layout": described }))
}

/// Everything a slide owns in the package: the notes slide hanging off it, the slide part itself, and the relationship
/// parts and content-type overrides of both. A part left behind is an orphan the package validator reports.
fn remove_slide_parts(zip: &mut Package, slide_path: &str) {
    let relationships = part_relationship_path(slide_path);
    let notes = relationship_target_by_type(&zip.text(&relationships), "notesSlide");
    if !notes.is_empty() {
        let notes_part = posix::normalize(&posix::join(&[&posix::dirname(slide_path), &notes]));
        zip.remove(&notes_part);
        let notes_relationships = part_relationship_path(&notes_part);
        if zip.file(&notes_relationships).is_some() {
            zip.remove(&notes_relationships);
        }
        remove_content_type_override(zip, &format!("/{notes_part}"));
    }
    zip.remove(slide_path);
    if zip.file(&relationships).is_some() {
        zip.remove(&relationships);
    }
    remove_content_type_override(zip, &format!("/{slide_path}"));
}

/// `deletePresentationSlide(zip, slides, number)`: an error for the only slide or a slide that is not there.
pub fn delete_presentation_slide(zip: &mut Package, slides: &[SlideRef], number: &Value) -> Result<(), String> {
    if slides.len() <= 1 {
        return Err("A presentation must keep at least one slide".to_owned());
    }
    let slide = slide_at(slides, number).ok_or_else(|| format!("PPTX slide {} not found", value_to_string(number)))?;
    let presentation = zip.text(PRESENTATION_PART);
    let entries: Vec<String> = slide_id_entries(&presentation).into_iter().filter(|entry| xml_attribute(entry, "r:id") != slide.rid).collect();
    zip.set(PRESENTATION_PART, write_slide_id_list(&presentation, &entries));
    remove_package_relationship(zip, PRESENTATION_RELATIONSHIPS, &slide.rid);
    remove_slide_parts(zip, &slide.path);
    Ok(())
}

fn move_package_part(zip: &mut Package, from: &str, to: &str) {
    if from == to {
        return;
    }
    let text = zip.text(from);
    zip.set(to, text);
    zip.remove(from);
    let from_relationships = part_relationship_path(from);
    if zip.file(&from_relationships).is_some() {
        let relationships = zip.text(&from_relationships);
        zip.set(&part_relationship_path(to), relationships);
        zip.remove(&from_relationships);
    }
}

/// `renumberPresentationSlides(zip)`: after a structural edit (delete, keep, move, duplicate, import) the slide part names
/// no longer follow the presentation order: slide9.xml can be the fourth slide. Operations address slides by position while
/// the snapshot, validation, and review paths read the part number, so every "/slide[n]" would name a different slide than
/// "slide: n". Renaming the parts to their positions keeps the two in step. True when any part moved.
pub fn renumber_presentation_slides(zip: &mut Package) -> bool {
    let slides = presentation_slides(zip);
    let moves: Vec<(String, String)> = slides
        .iter()
        .enumerate()
        .map(|(index, slide)| (slide.path.clone(), format!("ppt/slides/slide{}.xml", index + 1)))
        .filter(|(from, to)| from != to)
        .collect();
    if moves.is_empty() {
        return false;
    }
    // Two phases so a swap never overwrites a part that is still to be read.
    let mut staged = Vec::new();
    for (index, (from, to)) in moves.iter().enumerate() {
        let temporary = format!("ppt/slides/renumber-{index}.xml");
        move_package_part(zip, from, &temporary);
        staged.push((temporary, to.clone()));
    }
    for (from, to) in &staged {
        move_package_part(zip, from, to);
    }
    let renamed: HashMap<&str, &str> = moves.iter().map(|(from, to)| (from.as_str(), to.as_str())).collect();
    // Every relationship that resolved to an old part name (the presentation's slide list, a notes slide's back-reference,
    // a hyperlink to a slide) now points at the new one; content types follow.
    let target = compiled(r#"(<Relationship\b[^>]*\bTarget=")([^"]+)(")"#, "g");
    let owned = compiled(r"(^|/)_rels/([^/]+)\.rels$", "");
    for name in zip.names().into_iter().filter(|entry| compiled(r"\.rels$", "i").is_match(entry)) {
        let xml = zip.text(&name);
        if xml.is_empty() {
            continue;
        }
        let owner = match owned.captures(&name) {
            Some(found) => {
                let range = found.range();
                format!("{}{}{}", &name[..range.start], found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
            }
            None => name.clone(),
        };
        let directory = if owner == name { String::new() } else { posix::dirname(&owner) };
        let changed = Cell::new(false);
        let next = target.replace_all_with(&xml, |found| {
            let whole = &xml[found.range()];
            let (lead, link, tail) = (found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), found.get(3).unwrap_or(""));
            let resolved = match link.strip_prefix('/') {
                Some(rooted) => rooted.to_owned(),
                None => posix::normalize(&posix::join(&[&directory, link])),
            };
            let Some(to) = renamed.get(resolved.as_str()) else { return whole.to_owned() };
            changed.set(true);
            let written = if link.starts_with('/') {
                format!("/{to}")
            } else {
                posix::relative(if directory.is_empty() { "." } else { &directory }, to)
            };
            format!("{lead}{written}{tail}")
        });
        if changed.get() {
            zip.set(&name, next);
        }
    }
    let content_types = zip.text("[Content_Types].xml");
    let renumbered = compiled(r#"PartName="/(ppt/slides/slide\d+\.xml)""#, "g").replace_all_with(&content_types, |found| {
        match renamed.get(found.get(1).unwrap_or("")) {
            Some(to) => format!("PartName=\"/{to}\""),
            None => content_types[found.range()].to_owned(),
        }
    });
    zip.set("[Content_Types].xml", renumbered);
    true
}

/// `movePresentationSlide(zip, slides, number, index)`: the slide moved to the 1-based position `index`.
pub fn move_presentation_slide(zip: &mut Package, slides: &[SlideRef], number: &Value, index: &Value) -> Result<(), String> {
    let slide = slide_at(slides, number).ok_or_else(|| format!("PPTX slide {} not found", value_to_string(number)))?;
    let target = to_number(index);
    if !target.is_finite() || target < 1.0 || target > slides.len() as f64 {
        return Err(format!("move_slide index must be between 1 and {}", slides.len()));
    }
    let presentation = zip.text(PRESENTATION_PART);
    let mut entries = slide_id_entries(&presentation);
    let from = entries
        .iter()
        .position(|entry| xml_attribute(entry, "r:id") == slide.rid)
        .ok_or_else(|| format!("PPTX slide {} is not listed in the presentation", value_to_string(number)))?;
    let moved = entries.remove(from);
    let at = ((target - 1.0).trunc() as usize).min(entries.len());
    entries.insert(at, moved);
    zip.set(PRESENTATION_PART, write_slide_id_list(&presentation, &entries));
    Ok(())
}

fn ensure_notes_master(zip: &mut Package) -> Result<String, String> {
    let part = "ppt/notesMasters/notesMaster1.xml";
    if zip.file(part).is_some() {
        return Ok(part.to_owned());
    }
    let theme_pattern = compiled(r"^ppt\/theme\/theme\d+\.xml$", "");
    let theme = zip
        .names()
        .into_iter()
        .find(|name| theme_pattern.is_match(name))
        .ok_or_else(|| "Presentation is missing a theme for the notes master".to_owned())?;
    // PowerPoint rejects a package whose notes master shares the slide master's theme part outright: it reports the whole
    // file as corrupt and unreadable, so every deck carrying speaker notes failed to open. Each master owns a theme, so
    // copy the presentation theme into one for the notes master.
    let theme_ordinal = next_ordinal(zip, "ppt/theme/theme", ".xml");
    let notes_theme = format!("ppt/theme/theme{theme_ordinal}.xml");
    let theme_text = zip.text(&theme);
    zip.set(&notes_theme, theme_text);
    ensure_content_type_override(zip, &format!("/{notes_theme}"), THEME_CONTENT_TYPE);
    let color_map = "bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"";
    zip.set(
        part,
        format!(
            "{XML_HEADER}<p:notesMaster {}><p:cSld><p:spTree>{}</p:spTree></p:cSld><p:clrMap {color_map}/><p:notesStyle><a:lvl1pPr><a:defRPr sz=\"1200\"/></a:lvl1pPr></p:notesStyle></p:notesMaster>",
            presentation_namespaces(),
            empty_group_shape()
        ),
    );
    zip.set(
        &part_relationship_path(part),
        format!(
            "{XML_HEADER}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELATIONSHIP_BASE}/theme\" Target=\"{}\"/></Relationships>",
            posix::relative("ppt/notesMasters", &notes_theme)
        ),
    );
    ensure_content_type_override(zip, &format!("/{part}"), NOTES_MASTER_CONTENT_TYPE);
    let relationship_id = add_package_relationship(
        zip,
        PRESENTATION_RELATIONSHIPS,
        &format!("{OFFICE_RELATIONSHIP_BASE}/notesMaster"),
        "notesMasters/notesMaster1.xml",
        "",
    );
    let presentation = zip.text(PRESENTATION_PART);
    if !compiled(r"<p:notesMasterIdLst\b", "").is_match(&presentation) {
        let element = format!("<p:notesMasterIdLst><p:notesMasterId r:id=\"{relationship_id}\"/></p:notesMasterIdLst>");
        let anchor = compiled(r"<p:sldIdLst\b", "").find(&presentation).or_else(|| compiled(r"<p:sldSz\b", "").find(&presentation));
        let next = match anchor {
            Some(found) => format!("{}{element}{}", &presentation[..found.start], &presentation[found.start..]),
            None => replace_first_text(&presentation, "</p:presentation>", &format!("{element}</p:presentation>")),
        };
        zip.set(PRESENTATION_PART, next);
    }
    Ok(part.to_owned())
}

/// `ensureCommentAuthor(zip, author, initials)`: the id of the comment author of that name, added when the deck has none.
pub fn ensure_comment_author(zip: &mut Package, author: &str, initials: &str) -> f64 {
    let part = "ppt/commentAuthors.xml";
    let mut xml = zip.text(part);
    if xml.is_empty() {
        xml = format!("{XML_HEADER}<p:cmAuthorLst {}></p:cmAuthorLst>", presentation_namespaces());
        zip.set(part, xml.clone());
        ensure_content_type_override(zip, &format!("/{part}"), COMMENT_AUTHORS_CONTENT_TYPE);
        add_package_relationship(zip, PRESENTATION_RELATIONSHIPS, &format!("{OFFICE_RELATIONSHIP_BASE}/commentAuthors"), "commentAuthors.xml", "");
    }
    let existing = compiled(&format!(r#"<p:cmAuthor\b[^>]*\bname="{}"[^>]*/>"#, tag_pattern(&xml_encode(author))), "");
    if let Some(found) = existing.find(&xml) {
        let id = string_to_number(&xml_attribute(&xml[found], "id"));
        return if id.is_nan() { 0.0 } else { id };
    }
    let highest = compiled(r#"<p:cmAuthor\b[^>]*\bid="(\d+)""#, "g")
        .captures_iter(&xml)
        .map(|found| string_to_number(found.get(1).unwrap_or("")))
        .fold(-1.0, math::max);
    let id = highest + 1.0;
    let entry = format!(
        "<p:cmAuthor id=\"{}\" name=\"{}\" initials=\"{}\" lastIdx=\"1\" clrIdx=\"{}\"/>",
        crate::slide_shapes::num(id),
        xml_encode(author),
        xml_encode(initials),
        crate::slide_shapes::num(id)
    );
    zip.set(part, replace_first_text(&xml, "</p:cmAuthorLst>", &format!("{entry}</p:cmAuthorLst>")));
    id
}

/// `ensureSlideComments(zip, slide)`: the slide's comments part, created when it has none.
pub fn ensure_slide_comments(zip: &mut Package, slide: &SlideRef) -> String {
    let relationships = part_relationship_path(&slide.path);
    let target = relationship_target_by_type(&zip.text(&relationships), "comments");
    if !target.is_empty() {
        return part_from_target(&posix::dirname(&slide.path), &target);
    }
    let ordinal = next_ordinal(zip, "ppt/comments/comment", ".xml");
    let part = format!("ppt/comments/comment{ordinal}.xml");
    zip.set(&part, format!("{XML_HEADER}<p:cmLst {}></p:cmLst>", presentation_namespaces()));
    ensure_content_type_override(zip, &format!("/{part}"), COMMENTS_CONTENT_TYPE);
    add_package_relationship(
        zip,
        &relationships,
        &format!("{OFFICE_RELATIONSHIP_BASE}/comments"),
        &posix::relative(&posix::dirname(&slide.path), &part),
        "",
    );
    part
}

/// `readSlideNotes(zip, slide)`: the text of the slide's speaker notes.
pub fn read_slide_notes(zip: &Package, slide: &SlideRef) -> String {
    let linked = relationship_target_by_type(&zip.text(&part_relationship_path(&slide.path)), "notesSlide");
    if linked.is_empty() {
        return String::new();
    }
    let part = part_from_target(&posix::dirname(&slide.path), &linked);
    let xml = zip.text(&part);
    if xml.is_empty() {
        return String::new();
    }
    let body = compiled(r#"<p:sp>[\s\S]*?<p:ph type="body"[\s\S]*?</p:sp>"#, "").find(&xml).map_or(xml.as_str(), |found| &xml[found]);
    js_trim(&block_text(body, "a:t")).to_owned()
}

/// `copySlideNotes(zip, sourcePath, targetPath)`: a duplicated slide keeps the speaker notes, as PowerPoint's Duplicate does:
/// a notes page of its own, the source's copied as it stands and pointed back at the copy. The source's page belongs to the
/// source alone.
pub fn copy_slide_notes(zip: &mut Package, source_path: &str, target_path: &str) {
    let linked = relationship_target_by_type(&zip.text(&part_relationship_path(source_path)), "notesSlide");
    if linked.is_empty() {
        return;
    }
    let source_notes = part_from_target(&posix::dirname(source_path), &linked);
    let xml = zip.text(&source_notes);
    if xml.is_empty() {
        return;
    }
    let ordinal = next_ordinal(zip, "ppt/notesSlides/notesSlide", ".xml");
    let notes = format!("ppt/notesSlides/notesSlide{ordinal}.xml");
    zip.set(&notes, xml);
    let relationships = zip.text(&part_relationship_path(&source_notes));
    if !relationships.is_empty() {
        let target = posix::relative(&posix::dirname(&notes), target_path);
        let rewritten = compiled(r"<Relationship\b[^>]*/>", "g").replace_all_with(&relationships, |found| {
            let entry = found.get(0).unwrap_or("");
            if compiled(r#"\bType="[^"]*/slide""#, "").is_match(entry) {
                compiled(r#"\bTarget="[^"]*""#, "")
                    .find(entry)
                    .map_or_else(|| entry.to_owned(), |range| format!("{}Target=\"{target}\"{}", &entry[..range.start], &entry[range.end..]))
            } else {
                entry.to_owned()
            }
        });
        zip.set(&part_relationship_path(&notes), rewritten);
    }
    ensure_content_type_override(zip, &format!("/{notes}"), NOTES_SLIDE_CONTENT_TYPE);
    add_package_relationship(
        zip,
        &part_relationship_path(target_path),
        &format!("{OFFICE_RELATIONSHIP_BASE}/notesSlide"),
        &posix::relative(&posix::dirname(target_path), &notes),
        "",
    );
}

/// `setSlideNotes(zip, slides, number, text)`: the slide's speaker notes set to the text, one paragraph per line.
pub fn set_slide_notes(zip: &mut Package, slides: &[SlideRef], number: &Value, text: &Value) -> Result<(), String> {
    let slide = slide_at(slides, number).ok_or_else(|| format!("PPTX slide {} not found", value_to_string(number)))?;
    ensure_notes_master(zip)?;
    let slide_relationships = part_relationship_path(&slide.path);
    let linked = relationship_target_by_type(&zip.text(&slide_relationships), "notesSlide");
    let from_name = compiled(r"slide(\d+)\.xml$", "").captures(&slide.path).and_then(|found| found.get(1).map(string_to_number)).filter(|value| *value != 0.0 && !value.is_nan());
    let ordinal = from_name.unwrap_or_else(|| to_number(number));
    let part = if linked.is_empty() {
        format!("ppt/notesSlides/notesSlide{}.xml", crate::slide_shapes::num(ordinal))
    } else {
        posix::normalize(&posix::join(&[&posix::dirname(&slide.path), &linked]))
    };
    let lines = text_or_empty(Some(text));
    let pieces: Vec<&str> = lines.split('\n').collect();
    let last = pieces.len() - 1;
    let paragraphs: Vec<Value> = pieces
        .iter()
        .enumerate()
        .map(|(at, piece)| json!({ "text": if at == last { *piece } else { piece.strip_suffix('\r').unwrap_or(*piece) } }))
        .collect();
    let body = text_body_xml(&json!({ "paragraphs": paragraphs, "defaults": { "fontSize": 12 } }));
    zip.set(
        &part,
        format!(
            "{XML_HEADER}<p:notes {}><p:cSld><p:spTree>{}<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Placeholder\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody>{body}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
            presentation_namespaces(),
            empty_group_shape()
        ),
    );
    if zip.file(&part_relationship_path(&part)).is_none() {
        let directory = posix::dirname(&part);
        zip.set(
            &part_relationship_path(&part),
            format!(
                "{XML_HEADER}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELATIONSHIP_BASE}/slide\" Target=\"{}\"/><Relationship Id=\"rId2\" Type=\"{OFFICE_RELATIONSHIP_BASE}/notesMaster\" Target=\"{}\"/></Relationships>",
                posix::relative(&directory, &slide.path),
                posix::relative(&directory, "ppt/notesMasters/notesMaster1.xml")
            ),
        );
    }
    ensure_content_type_override(zip, &format!("/{part}"), NOTES_SLIDE_CONTENT_TYPE);
    if linked.is_empty() {
        add_package_relationship(
            zip,
            &slide_relationships,
            &format!("{OFFICE_RELATIONSHIP_BASE}/notesSlide"),
            &posix::relative(&posix::dirname(&slide.path), &part),
            "",
        );
    }
    Ok(())
}

/// `path.extname(String(source || ''))` without its dot, lower-cased.
fn image_extension(source: &str) -> String {
    let base = source.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = match base.rfind('.') {
        Some(at) if at > 0 && base != ".." => &base[at + 1..],
        _ => "",
    };
    js_to_lowercase(extension)
}

/// The part and relationship id of a picture added to a slide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlideImage {
    pub part: String,
    pub relationship_id: String,
}

/// `addSlideImage(zip, slidePart, source)`: the picture file at `source` stored in the deck and related to the slide.
pub fn add_slide_image<P: ReadProof>(proof: &P, zip: &mut Package, slide_part: &str, source: &str) -> Result<SlideImage, String> {
    let extension = image_extension(source);
    let Some(content_type) = image_content_type(&extension) else {
        let known: Vec<&str> = IMAGE_CONTENT_TYPES.iter().map(|(name, _)| *name).collect();
        return Err(format!(
            "Unsupported image type: .{}. Use {}",
            if extension.is_empty() { "unknown" } else { &extension },
            known.join(", ")
        ));
    };
    let data = mixdog_fsio::read(proof, Path::new(source)).map_err(|error| os_message(&error, "open", Path::new(source)))?;
    let ordinal = next_ordinal(zip, "ppt/media/image", &format!(".{extension}"));
    let part = format!("ppt/media/image{ordinal}.{extension}");
    zip.set(&part, data);
    ensure_default_content_type(zip, &extension, content_type);
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(slide_part),
        &format!("{OFFICE_RELATIONSHIP_BASE}/image"),
        &posix::relative(&posix::dirname(slide_part), &part),
        "",
    );
    Ok(SlideImage { part, relationship_id })
}

/// `importSlidesIntoPresentation(zip, sourcePath, slideNumbers, after)`: slides of another deck copied in after position
/// `after`, with the parts they own; answers `{ count, slides }`.
pub fn import_slides_into_presentation<P: ReadProof>(
    proof: &P,
    zip: &mut Package,
    source_path: &str,
    slide_numbers: Option<&Value>,
    after: Option<&Value>,
) -> Result<Value, String> {
    let bytes = mixdog_fsio::read(proof, Path::new(source_path)).map_err(|error| os_message(&error, "open", Path::new(source_path)))?;
    let source = Package::load_unchecked(&bytes)?;
    let source_slides = presentation_slides(&source);
    if source_slides.is_empty() {
        return Err("import_slides source has no slides".to_owned());
    }
    let requested: Vec<f64> = match slide_numbers.and_then(Value::as_array).filter(|list| !list.is_empty()) {
        Some(list) => list.iter().map(to_number).collect(),
        None => (1..=source_slides.len()).map(|number| number as f64).collect(),
    };
    let mut cache = HashMap::new();
    let after = after.map_or(f64::NAN, to_number);
    let mut position = math::max(0.0, if after.is_nan() { 0.0 } else { after });
    let mut imported = Vec::new();
    for number in requested {
        let at = number - 1.0;
        let entry = if at.fract() == 0.0 && at >= 0.0 { source_slides.get(at as usize) } else { None };
        let Some(entry) = entry else {
            return Err(format!("import_slides source has no slide {}", crate::slide_shapes::num(number)));
        };
        let ordinal = next_ordinal(zip, "ppt/slides/slide", ".xml");
        let target_path = format!("ppt/slides/slide{ordinal}.xml");
        zip.set(&target_path, source.text(&entry.path));
        cache.insert(format!("slide:{}", entry.path), target_path.clone());
        ensure_content_type_override(zip, &format!("/{target_path}"), SLIDE_CONTENT_TYPE);
        let relationships = source.text(&part_relationship_path(&entry.path));
        if !relationships.is_empty() {
            let rewritten = rewrite_imported_relationships(&source, zip, &entry.path, &target_path, &relationships, &mut cache)?;
            zip.set(&part_relationship_path(&target_path), rewritten);
        }
        let relationship_id = add_package_relationship(
            zip,
            PRESENTATION_RELATIONSHIPS,
            &format!("{OFFICE_RELATIONSHIP_BASE}/slide"),
            &format!("slides/slide{ordinal}.xml"),
            "",
        );
        position = insert_slide_id(zip, &relationship_id, position) + 1.0;
        imported.push(json_number(number));
    }
    Ok(json!({ "count": imported.len(), "slides": imported }))
}

/// `clearPortablePresentationSlides(path)`: every slide taken out of the deck at `path` (its layouts and master stay);
/// answers how many were removed.
pub fn clear_portable_presentation_slides<P: WriteProof>(proof: &P, note: &dyn WriteNote, path: &Path) -> Result<usize, String> {
    let mut zip = load_package(proof, path)?;
    let slides = presentation_slides(&zip);
    let presentation = zip.text(PRESENTATION_PART);
    zip.set(PRESENTATION_PART, write_slide_id_list(&presentation, &[]));
    for slide in &slides {
        if !slide.rid.is_empty() {
            remove_package_relationship(&mut zip, PRESENTATION_RELATIONSHIPS, &slide.rid);
        }
        remove_slide_parts(&mut zip, &slide.path);
    }
    save_package(proof, note, &zip, path)?;
    Ok(slides.len())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The layouts of a deck Korean PowerPoint wrote: its names are Korean, its types the file's own.
    fn korean() -> Vec<LayoutPart> {
        [
            ("제목 슬라이드", "title"),
            ("제목 및 내용", "obj"),
            ("구역 머리글", "secHead"),
            ("콘텐츠 2개", "twoObj"),
            ("비교", "twoTxTwoObj"),
            ("제목만", "titleOnly"),
            ("빈 화면", "blank"),
        ]
        .into_iter()
        .map(|(name, layout_type)| LayoutPart { path: String::new(), name: name.to_owned(), layout_type: layout_type.to_owned() })
        .collect()
    }

    #[test]
    fn the_default_layouts_are_found_by_their_english_names_in_a_deck_of_another_language() {
        let layouts = korean();
        let pick = |requested: &str| select_slide_layout(&layouts, Some(&json!(requested))).map(|layout| layout.name.clone());
        assert_eq!(pick("Title Only").as_deref(), Ok("제목만"));
        assert_eq!(pick("title and content").as_deref(), Ok("제목 및 내용"));
        assert_eq!(pick("Section Header").as_deref(), Ok("구역 머리글"));
        assert_eq!(pick("Two Content").as_deref(), Ok("콘텐츠 2개"));
        assert_eq!(pick("Comparison").as_deref(), Ok("비교"));
        // The deck's own name and the layout type still come first.
        assert_eq!(pick("제목만").as_deref(), Ok("제목만"));
        assert_eq!(pick("blank").as_deref(), Ok("빈 화면"));
        let error = pick("Agenda").expect_err("no such layout");
        assert!(error.starts_with("Slide layout not found: Agenda. Available: 제목 슬라이드"), "{error}");
    }

    #[test]
    fn a_layout_is_picked_by_number_and_an_empty_request_takes_the_blank_one() {
        let layouts = korean();
        assert_eq!(select_slide_layout(&layouts, Some(&json!(" 2 "))).map(|layout| layout.layout_type.as_str()), Ok("obj"));
        assert_eq!(select_slide_layout(&layouts, Some(&json!("0"))), Err("Slide layout 0 not found".to_owned()));
        assert_eq!(select_slide_layout(&layouts, None).map(|layout| layout.layout_type.as_str()), Ok("blank"));
        assert_eq!(select_slide_layout(&[], None), Err("Presentation has no slide layout for a new slide".to_owned()));
    }

    #[test]
    fn the_slide_id_list_is_replaced_or_placed_before_the_slide_size() {
        let entry = vec!["<p:sldId id=\"256\" r:id=\"rId2\"/>".to_owned()];
        assert_eq!(
            write_slide_id_list("<p:presentation><p:sldIdLst/><p:sldSz/></p:presentation>", &entry),
            "<p:presentation><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst><p:sldSz/></p:presentation>"
        );
        assert_eq!(
            write_slide_id_list("<p:presentation><p:sldSz/></p:presentation>", &entry),
            "<p:presentation><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst><p:sldSz/></p:presentation>"
        );
        assert_eq!(slide_id_entries("<p:presentation><p:sldIdLst><p:sldId id=\"1\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>").len(), 1);
    }
}
