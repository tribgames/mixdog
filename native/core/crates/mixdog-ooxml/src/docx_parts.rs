//! `portable/portable-docx-parts.mjs`: the parts a Word package is given beside its document: pictures, section
//! properties (the sectPr upsert and its schema order), notes (footnotes and endnotes with their separators and styles),
//! comments with the three sidecars Word cross-links them through (thread, id map, timestamp), running headers and
//! footers, the settings part, tracked-change attributes and the numbering definitions of bullet, numbered and Korean
//! lists. The package is edited as text with the patterns of the Node code (`JsRegex`), so a match is the one V8 finds;
//! offsets are byte offsets (Node's are UTF-16 units; the text between two offsets is the same). Node's `async` is gone:
//! the package is in memory.

use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::time::{Tz, local_fields_in};
use mixdog_js::{JsRegex, js_trim, js_trim_end, math, number_to_string, to_number};
use serde_json::Value;

use crate::opc::{
    IMAGE_CONTENT_TYPES, PixelSize, add_package_relationship, ensure_content_type_override, ensure_default_content_type, image_content_type, image_pixel_size,
    part_from_target, part_relationship_path,
};
use crate::package::os_message;
use crate::slide_shapes::{EMU_PER_POINT, remove_first, replace_first_text, replace_first_with};
use crate::snapshot_docx::{DocxBodyModel, docx_body_model, numbering_level_format};
pub use crate::xml::WORD_MAIN_NS;
use crate::xml::{
    DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, SECTION_PROPERTIES_SOURCE, WORD_RUN_SOURCE, XML_HEADER, compiled, settings_track_changes, tag_pattern,
    trailing_section_pattern, upsert_ordered_child, xml_encode,
};
use crate::zipio::Package;

const HEADER_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const FOOTER_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
const WORD_DRAWING_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PICTURE_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const DOCUMENT_PART: &str = "word/document.xml";

/// `text.replace(pattern, () => replacement)` for a pattern without the `g` flag: the first match only.
fn replace_first(pattern: &JsRegex, text: &str, replacement: &str) -> String {
    replace_first_with(pattern, text, |_| replacement.to_owned())
}

/// `text.slice(0, -1)`: the text without its last character.
fn without_last_character(text: &str) -> &str {
    &text[..text.len() - text.chars().next_back().map_or(0, char::len_utf8)]
}

/// `path.extname(String(source || ''))` without its dot, lower-cased.
fn image_extension(source: &str) -> String {
    let base = source.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = match base.rfind('.') {
        Some(at) if at > 0 && base != ".." => &base[at + 1..],
        _ => "",
    };
    mixdog_js::js_to_lowercase(extension)
}

/// What [`add_document_image`] stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentImage {
    pub part: String,
    pub relationship_id: String,
    pub pixels: Option<PixelSize>,
    pub name: String,
}

/// `addDocumentImage(zip, source)`: the picture file at `source` stored under `word/media` and related to the document.
pub fn add_document_image<P: ReadProof>(proof: &P, zip: &mut Package, source: &str) -> Result<DocumentImage, String> {
    let extension = image_extension(source);
    let Some(content_type) = image_content_type(&extension) else {
        let known: Vec<&str> = IMAGE_CONTENT_TYPES.iter().map(|(name, _)| *name).collect();
        return Err(format!("Unsupported image type: .{}. Use {}", if extension.is_empty() { "unknown" } else { &extension }, known.join(", ")));
    };
    let data = mixdog_fsio::read(proof, Path::new(source)).map_err(|error| os_message(&error, "open", Path::new(source)))?;
    let mut ordinal = 1_u64;
    while zip.file(&format!("word/media/image{ordinal}.{extension}")).is_some() {
        ordinal += 1;
    }
    let part = format!("word/media/image{ordinal}.{extension}");
    let pixels = image_pixel_size(&data);
    zip.set(&part, data);
    ensure_default_content_type(zip, &extension, content_type);
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(DOCUMENT_PART),
        &format!("{OFFICE_RELATIONSHIP_BASE}/image"),
        &format!("media/image{ordinal}.{extension}"),
        "",
    );
    Ok(DocumentImage { part, relationship_id, pixels, name: format!("image{ordinal}.{extension}") })
}

/// The arguments of [`word_drawing_xml`].
#[derive(Debug, Clone, Copy)]
pub struct WordDrawing<'a> {
    pub id: u64,
    pub embed_id: &'a str,
    pub name: &'a str,
    /// Points.
    pub width: f64,
    pub height: f64,
    pub alt_text: &'a str,
}

/// `wordDrawingXml(...)`: an inline picture. A reader who cannot see the picture hears its description; Word reads it
/// from the drawing's `descr`, so it is written on both names of the picture.
pub fn word_drawing_xml(drawing: &WordDrawing<'_>) -> String {
    let extent = |points: f64| number_to_string(math::max(1.0, math::round(points * EMU_PER_POINT)));
    let (cx, cy) = (extent(drawing.width), extent(drawing.height));
    let alt = js_trim(drawing.alt_text);
    let descr = if alt.is_empty() { String::new() } else { format!(" descr=\"{}\"", xml_encode(alt)) };
    let (id, embed_id) = (drawing.id, drawing.embed_id);
    let name = xml_encode(drawing.name);
    format!(
        "<w:drawing><wp:inline xmlns:wp=\"{WORD_DRAWING_NS}\" distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/>\
<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\
<wp:docPr id=\"{id}\" name=\"{name}\"{descr}/>\
<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a=\"{DRAWING_MAIN_NS}\" noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic xmlns:a=\"{DRAWING_MAIN_NS}\"><a:graphicData uri=\"{PICTURE_NS}\">\
<pic:pic xmlns:pic=\"{PICTURE_NS}\">\
<pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"{descr}/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip xmlns:a=\"{DRAWING_MAIN_NS}\" r:embed=\"{embed_id}\"/>\
<a:stretch xmlns:a=\"{DRAWING_MAIN_NS}\"><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm xmlns:a=\"{DRAWING_MAIN_NS}\"><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom xmlns:a=\"{DRAWING_MAIN_NS}\" prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>\
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>"
    )
}

/// The document body and where its trailing section properties lie in the body's content.
#[derive(Debug, Clone)]
pub struct TrailingSection {
    pub model: DocxBodyModel,
    /// The offset in the body's content and the section properties there.
    pub found: Option<(usize, String)>,
}

const NO_BODY: &str = "DOCX document body is missing";

/// `trailingSectionProperties(documentXml)`.
pub fn trailing_section_properties(document_xml: &str) -> Result<TrailingSection, String> {
    let model = docx_body_model(document_xml);
    let body = model.body.as_ref().ok_or_else(|| NO_BODY.to_owned())?;
    let found = trailing_section_pattern().find(&body.inner).map(|range| (range.start, body.inner[range].to_owned()));
    Ok(TrailingSection { model, found })
}

// CT_SectPr fixes the order of its children (the header and footer references share the first place). titlePg written
// straight after pgMar stood ahead of the cols every section carries, and the schema check refused the file.
const SECTION_CHILD_ORDER: [&str; 21] = [
    "headerReference",
    "footnotePr",
    "endnotePr",
    "type",
    "pgSz",
    "pgMar",
    "paperSrc",
    "pgBorders",
    "lnNumType",
    "pgNumType",
    "cols",
    "formProt",
    "vAlign",
    "noEndnote",
    "titlePg",
    "textDirection",
    "bidi",
    "rtlGutter",
    "docGrid",
    "printerSettings",
    "sectPrChange",
];

fn section_child_rank(tag: &str) -> isize {
    let name = if tag == "footerReference" { "headerReference" } else { tag };
    SECTION_CHILD_ORDER.iter().position(|candidate| *candidate == name).map_or(-1, |at| at as isize)
}

/// `upsertSectionChild(sectionXml, tag, element)`: replaces the section's own `tag` element, or writes it ahead of the first
/// child the schema places after it.
pub fn upsert_section_child(section_xml: &str, tag: &str, element: &str) -> String {
    let own = compiled(&format!(r"<w:{}\b[^>]*\/>", tag_pattern(tag)), "");
    if own.is_match(section_xml) {
        return replace_first(&own, section_xml, element);
    }
    let rank = section_child_rank(tag);
    let from = section_xml.find('>').map_or(0, |at| at + 1);
    let children = compiled(r"<w:(\w+)\b", "g");
    for found in children.captures_iter(&section_xml[from..]) {
        if section_child_rank(found.get(1).unwrap_or("")) > rank {
            let at = from + found.range().start;
            return format!("{}{element}{}", &section_xml[..at], &section_xml[at..]);
        }
    }
    // A missing closing tag is `lastIndexOf` of -1: `slice(0, -1)` and `slice(-1)`.
    let close = section_xml.rfind("</w:sectPr>").unwrap_or_else(|| without_last_character(section_xml).len());
    format!("{}{element}{}", &section_xml[..close], &section_xml[close..])
}

/// One sectPr of a body: where it lies in the body's content and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionSpan {
    pub start: usize,
    pub end: usize,
    pub xml: String,
}

/// `documentSectionSpans(documentXml)`: the sections in reading order. Each break paragraph carries the properties of the
/// section it closes, and the trailing sectPr governs the last one.
pub fn document_section_spans(document_xml: &str) -> Result<(DocxBodyModel, Vec<SectionSpan>), String> {
    let model = docx_body_model(document_xml);
    let body = model.body.as_ref().ok_or_else(|| NO_BODY.to_owned())?;
    let pattern = compiled(SECTION_PROPERTIES_SOURCE, "g");
    let spans = pattern.find_iter(&body.inner).map(|range| SectionSpan { start: range.start, end: range.end, xml: body.inner[range].to_owned() }).collect();
    Ok((model, spans))
}

/// The document with the body's content replaced.
fn with_body_inner(document_xml: &str, model: &DocxBodyModel, inner: &str) -> String {
    let body = model.body.as_ref().expect("a model with a body");
    format!("{}{inner}{}", &document_xml[..body.start], &document_xml[body.end..])
}

/// `section == null || section === ''` read as "no section named"; otherwise a positive whole number.
fn named_section(section: &Value) -> Result<Option<f64>, String> {
    if section.is_null() || section.as_str() == Some("") {
        return Ok(None);
    }
    let requested = to_number(section);
    if !requested.is_finite() || requested.fract() != 0.0 || requested < 1.0 {
        return Err("DOCX section must be a positive whole number".to_owned());
    }
    Ok(Some(requested))
}

/// `writeSectionPropertiesAt(documentXml, section, mutate)`: `section` names one section, 1-based; without it the edit
/// lands on the section the document is currently being written into, the last one.
pub fn write_section_properties_at(document_xml: &str, section: &Value, mutate: &dyn Fn(&str) -> String) -> Result<String, String> {
    let requested = named_section(section)?;
    let (model, spans) = document_section_spans(document_xml)?;
    if spans.is_empty() {
        return write_section_properties(document_xml, mutate);
    }
    let target = match requested {
        None => spans.last(),
        Some(number) if number <= spans.len() as f64 => spans.get(number as usize - 1),
        Some(_) => None,
    };
    let Some(target) = target else {
        return Err(format!(
            "DOCX has {} section{}; section {} does not exist",
            spans.len(),
            if spans.len() == 1 { "" } else { "s" },
            number_to_string(requested.unwrap_or(0.0))
        ));
    };
    let body = model.body.as_ref().expect("a body");
    let inner = format!("{}{}{}", &body.inner[..target.start], mutate(&target.xml), &body.inner[target.end..]);
    Ok(with_body_inner(document_xml, &model, &inner))
}

/// `writeEverySectionProperties(documentXml, section, mutate)`: the running header, footer and page number belong to the
/// whole document: written to the last section only, a report whose header was set after its landscape break showed it on
/// the final page alone (Word links a section's header to the one before it). Without a named section every section takes it.
pub fn write_every_section_properties(document_xml: &str, section: &Value, mutate: &dyn Fn(&str) -> String) -> Result<String, String> {
    if named_section(section)?.is_some() {
        return write_section_properties_at(document_xml, section, mutate);
    }
    let (model, spans) = document_section_spans(document_xml)?;
    if spans.len() <= 1 {
        return write_section_properties_at(document_xml, section, mutate);
    }
    let mut inner = model.body.as_ref().expect("a body").inner.clone();
    for span in spans.iter().rev() {
        inner = format!("{}{}{}", &inner[..span.start], mutate(&span.xml), &inner[span.end..]);
    }
    Ok(with_body_inner(document_xml, &model, &inner))
}

fn write_section_properties(document_xml: &str, mutate: &dyn Fn(&str) -> String) -> Result<String, String> {
    let trailing = trailing_section_properties(document_xml)?;
    let body = trailing.model.body.as_ref().expect("a body");
    let inner = match &trailing.found {
        Some((at, current)) => format!("{}{}{}", &body.inner[..*at], mutate(current), &body.inner[at + current.len()..]),
        None => format!("{}{}", body.inner, mutate("<w:sectPr></w:sectPr>")),
    };
    Ok(with_body_inner(document_xml, &trailing.model, &inner))
}

/// One of the note parts: footnotes or endnotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoteDefinition {
    pub part: &'static str,
    pub root: &'static str,
    pub tag: &'static str,
    pub reference: &'static str,
    pub style: &'static str,
    pub text_style: &'static str,
    pub content_type: &'static str,
    pub relationship: &'static str,
}

const FOOTNOTES: NoteDefinition = NoteDefinition {
    part: "word/footnotes.xml",
    root: "w:footnotes",
    tag: "w:footnote",
    reference: "w:footnoteReference",
    style: "FootnoteReference",
    text_style: "FootnoteText",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
    relationship: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
};

const ENDNOTES: NoteDefinition = NoteDefinition {
    part: "word/endnotes.xml",
    root: "w:endnotes",
    tag: "w:endnote",
    reference: "w:endnoteReference",
    style: "EndnoteReference",
    text_style: "EndnoteText",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
    relationship: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
};

/// `noteDefinition(kind)`: `footnote` when `kind` is empty.
pub fn note_definition(kind: &str) -> Result<NoteDefinition, String> {
    let name = if kind.is_empty() { "footnote".to_owned() } else { mixdog_js::js_to_lowercase(kind) };
    match name.as_str() {
        "footnote" => Ok(FOOTNOTES),
        "endnote" => Ok(ENDNOTES),
        _ => Err(format!("Unsupported note kind: {kind}. Use footnote or endnote.")),
    }
}

/// The part a package must hold, with what makes it one.
#[derive(Debug, Clone, Copy)]
pub struct PartDefinition<'a> {
    pub part: &'a str,
    pub xml: &'a str,
    pub content_type: &'a str,
    pub relationship: &'a str,
}

/// `ensurePart(zip, {...})`: a part Word did not ship with takes three steps, never one: the part itself, the content-type
/// override that names it, and the relationship the document reads it through. A part already in the package is returned as
/// it stands.
pub fn ensure_part(zip: &mut Package, definition: &PartDefinition<'_>) -> String {
    let existing = zip.text(definition.part);
    if !existing.is_empty() {
        return existing;
    }
    zip.set(definition.part, definition.xml);
    ensure_content_type_override(zip, &format!("/{}", definition.part), definition.content_type);
    let target = definition.part.strip_prefix("word/").unwrap_or(definition.part);
    add_package_relationship(zip, &part_relationship_path(DOCUMENT_PART), definition.relationship, target, "");
    definition.xml.to_owned()
}

/// The note's own styles: a note set in Normal printed at the body size with the body's paragraph spacing, two notes taking
/// a sixth of the page foot. Word's defaults are a 10 pt note under a superscript mark; the note reads at 9 pt here, tight,
/// the way a printed source line does. A styles part that already names them is left as it is.
fn ensure_note_styles(zip: &mut Package, definition: &NoteDefinition) {
    let part = "word/styles.xml";
    let styles = zip.text(part);
    if styles.is_empty() {
        return;
    }
    let note_name = if definition.text_style == "FootnoteText" { "footnote text" } else { "endnote text" };
    let mark_name = if definition.style == "FootnoteReference" { "footnote reference" } else { "endnote reference" };
    let text_style = definition.text_style;
    let style = definition.style;
    let mut additions = String::new();
    if !styles.contains(&format!("w:styleId=\"{text_style}\"")) {
        additions.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{text_style}\"><w:name w:val=\"{note_name}\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/>\
<w:pPr><w:spacing w:after=\"40\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>"
        ));
    }
    if !styles.contains(&format!("w:styleId=\"{style}\"")) {
        additions.push_str(&format!(
            "<w:style w:type=\"character\" w:styleId=\"{style}\"><w:name w:val=\"{mark_name}\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/>\
<w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr></w:style>"
        ));
    }
    if !additions.is_empty() {
        zip.set(part, replace_first_text(&styles, "</w:styles>", &format!("{additions}</w:styles>")));
    }
}

/// A note part and what it holds.
#[derive(Debug, Clone)]
pub struct NotePart {
    pub definition: NoteDefinition,
    pub xml: String,
}

/// `ensureNotePart(zip, kind)`: Word reads the separator notes (ids -1 and 0) before any real note: without them the note
/// area has no rule above it and Word repairs the file on open.
pub fn ensure_note_part(zip: &mut Package, kind: &str) -> Result<NotePart, String> {
    let definition = note_definition(kind)?;
    ensure_note_styles(zip, &definition);
    let tag = definition.tag;
    let separator = |id: i32, element: &str| {
        format!(
            "<{tag} w:type=\"{element}\" w:id=\"{id}\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>\
<w:r><w:{element}/></w:r></w:p></{tag}>"
        )
    };
    let root = definition.root;
    let created = format!(
        "{XML_HEADER}<{root} xmlns:w=\"{WORD_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\">{}{}</{root}>",
        separator(-1, "separator"),
        separator(0, "continuationSeparator")
    );
    let xml = ensure_part(
        zip,
        &PartDefinition { part: definition.part, xml: &created, content_type: definition.content_type, relationship: definition.relationship },
    );
    Ok(NotePart { definition, xml })
}

const COMMENTS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_EXTENDED_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml";
const COMMENTS_EXTENDED_RELATIONSHIP: &str = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
pub const WORD_2010_NS: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const WORD_2012_NS: &str = "http://schemas.microsoft.com/office/word/2012/wordml";

/// `commentParagraphId(commentId)`: eight upper-case hexadecimal digits.
pub fn comment_paragraph_id(comment_id: u64) -> String {
    format!("{:08X}", 0x1000_0000 + comment_id)
}

/// A part of the package and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartText {
    pub part: String,
    pub xml: String,
}

fn ensure_comments_extended_part(zip: &mut Package) -> PartText {
    let part = "word/commentsExtended.xml";
    let created = format!("{XML_HEADER}<w15:commentsEx xmlns:w15=\"{WORD_2012_NS}\"></w15:commentsEx>");
    let xml =
        ensure_part(zip, &PartDefinition { part, xml: &created, content_type: COMMENTS_EXTENDED_CONTENT_TYPE, relationship: COMMENTS_EXTENDED_RELATIONSHIP });
    PartText { part: part.to_owned(), xml }
}

/// `registerCommentThread(zip, { commentId, parentId, done })`: the comment's entry in `commentsExtended`, written where
/// the comment already has one; answers its paragraph id.
pub fn register_comment_thread(zip: &mut Package, comment_id: u64, parent_id: u64, done: bool) -> String {
    let extended = ensure_comments_extended_part(zip);
    let para_id = comment_paragraph_id(comment_id);
    let pattern = compiled(&format!(r#"<w15:commentEx\b[^>]*\bw15:paraId="{para_id}"[^>]*\/>"#), "");
    let parent = if parent_id != 0 { format!(" w15:paraIdParent=\"{}\"", comment_paragraph_id(parent_id)) } else { String::new() };
    let entry = format!("<w15:commentEx w15:paraId=\"{para_id}\"{parent} w15:done=\"{}\"/>", u8::from(done));
    let next = if pattern.is_match(&extended.xml) {
        replace_first(&pattern, &extended.xml, &entry)
    } else {
        replace_first_text(&extended.xml, "</w15:commentsEx>", &format!("{entry}</w15:commentsEx>"))
    };
    zip.set(&extended.part, next);
    para_id
}

/// `ensureCommentsPart(zip)`.
pub fn ensure_comments_part(zip: &mut Package) -> PartText {
    let part = "word/comments.xml";
    let created = format!("{XML_HEADER}<w:comments xmlns:w=\"{WORD_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"></w:comments>");
    let xml = ensure_part(
        zip,
        &PartDefinition { part, xml: &created, content_type: COMMENTS_CONTENT_TYPE, relationship: &format!("{OFFICE_RELATIONSHIP_BASE}/comments") },
    );
    PartText { part: part.to_owned(), xml }
}

const MARKUP_COMPATIBILITY_NS: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

struct CommentSidecar {
    part: &'static str,
    root: &'static str,
    ns: &'static str,
    prefix: &'static str,
    content_type: &'static str,
    relationship: &'static str,
}

const SIDECAR_IDS: CommentSidecar = CommentSidecar {
    part: "word/commentsIds.xml",
    root: "w16cid:commentsIds",
    ns: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    prefix: "w16cid",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml",
    relationship: "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
};

const SIDECAR_EXTENSIBLE: CommentSidecar = CommentSidecar {
    part: "word/commentsExtensible.xml",
    root: "w16cex:commentsExtensible",
    ns: "http://schemas.microsoft.com/office/word/2018/wordml/cex",
    prefix: "w16cex",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml",
    relationship: "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
};

fn ensure_comment_sidecar(zip: &mut Package, sidecar: &CommentSidecar) -> PartText {
    let created = format!(
        "{XML_HEADER}<{root} xmlns:{prefix}=\"{ns}\" xmlns:mc=\"{MARKUP_COMPATIBILITY_NS}\" mc:Ignorable=\"{prefix}\"></{root}>",
        root = sidecar.root,
        prefix = sidecar.prefix,
        ns = sidecar.ns
    );
    let xml = ensure_part(zip, &PartDefinition { part: sidecar.part, xml: &created, content_type: sidecar.content_type, relationship: sidecar.relationship });
    PartText { part: sidecar.part.to_owned(), xml }
}

/// `commentDurableId(commentId)`: eight hex digits below 0x7FFFFFFF, spread so neighbouring ids differ.
fn comment_durable_id(comment_id: u64) -> String {
    let spread = (comment_id as f64 * 2_654_435_761.0) % f64::from(0x6fff_ffff_u32);
    format!("{:08X}", 0x1000_0000 + spread as u64)
}

/// `registerCommentIdentity(zip, { commentId, date })`: a comment Word treats as its own is cross-linked through four
/// parts: the comment, its thread entry (`commentsExtended`), the paragraph-id to durable-id map (`commentsIds`), and the
/// durable-id timestamp (`commentsExtensible`). This writes the last two for one comment; answers the paragraph id and the
/// durable id.
pub fn register_comment_identity(zip: &mut Package, comment_id: u64, date: &str) -> (String, String) {
    let para_id = comment_paragraph_id(comment_id);
    let durable_id = comment_durable_id(comment_id);
    let ids = ensure_comment_sidecar(zip, &SIDECAR_IDS);
    if !ids.xml.contains(&format!("w16cid:paraId=\"{para_id}\"")) {
        let entry = format!("<w16cid:commentId w16cid:paraId=\"{para_id}\" w16cid:durableId=\"{durable_id}\"/></{}>", SIDECAR_IDS.root);
        zip.set(&ids.part, replace_first_text(&ids.xml, &format!("</{}>", SIDECAR_IDS.root), &entry));
    }
    let extensible = ensure_comment_sidecar(zip, &SIDECAR_EXTENSIBLE);
    if !extensible.xml.contains(&format!("w16cex:durableId=\"{durable_id}\"")) {
        let entry =
            format!("<w16cex:commentExtensible w16cex:durableId=\"{durable_id}\" w16cex:dateUtc=\"{}\"/></{}>", xml_encode(date), SIDECAR_EXTENSIBLE.root);
        zip.set(&extensible.part, replace_first_text(&extensible.xml, &format!("</{}>", SIDECAR_EXTENSIBLE.root), &entry));
    }
    (para_id, durable_id)
}

/// `forgetCommentIdentity(zip, commentXml)`: removes a deleted comment's thread, id map and timestamp entries, found through
/// the paragraph id the comment itself carries so comments Word authored are cleaned the same way. Answers the parts it changed.
pub fn forget_comment_identity(zip: &mut Package, comment_xml: &str) -> Vec<String> {
    let mut removed = Vec::new();
    let paragraph_id = compiled(r#"\bw14:paraId="([0-9A-Fa-f]+)""#, "");
    let Some(para_id) = paragraph_id.captures(comment_xml).and_then(|found| found.get(1).map(str::to_owned)) else {
        return removed;
    };
    let extended = zip.text("word/commentsExtended.xml");
    let thread = compiled(&format!(r#"<w15:commentEx\b[^>]*\bw15:paraId="{para_id}"[^>]*\/>"#), "");
    let extended_next = remove_first(&thread, &extended);
    if extended_next != extended {
        zip.set("word/commentsExtended.xml", extended_next);
        removed.push("word/commentsExtended.xml".to_owned());
    }
    let ids = zip.text(SIDECAR_IDS.part);
    let id_pattern = compiled(&format!(r#"<w16cid:commentId\b[^>]*\bw16cid:paraId="{para_id}"[^>]*\/>"#), "");
    let Some(id_entry) = id_pattern.find(&ids).map(|range| ids[range].to_owned()) else { return removed };
    zip.set(SIDECAR_IDS.part, replace_first_text(&ids, &id_entry, ""));
    removed.push(SIDECAR_IDS.part.to_owned());
    let durable = compiled(r#"\bw16cid:durableId="([0-9A-Fa-f]+)""#, "");
    let Some(durable_id) = durable.captures(&id_entry).and_then(|found| found.get(1).map(str::to_owned)) else { return removed };
    let extensible = zip.text(SIDECAR_EXTENSIBLE.part);
    let timestamp = compiled(&format!(r#"<w16cex:commentExtensible\b[^>]*\bw16cex:durableId="{durable_id}"[^>]*\/>"#), "");
    let extensible_next = remove_first(&timestamp, &extensible);
    if extensible_next != extensible {
        zip.set(SIDECAR_EXTENSIBLE.part, extensible_next);
        removed.push(SIDECAR_EXTENSIBLE.part.to_owned());
    }
    removed
}

/// `anchorDocxComment(paragraphXml, id)`: the comment's range around the paragraph's content and its reference after it.
pub fn anchor_docx_comment(paragraph_xml: &str, id: impl std::fmt::Display) -> String {
    let opening_pattern = compiled(r"^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?", "");
    let opening = opening_pattern.find(paragraph_xml).map_or("<w:p>", |range| &paragraph_xml[range]);
    // `paragraphXml.slice(opening.length)`: past the end of a paragraph that is not one, the text is empty.
    let body = paragraph_xml.get(opening.len()..).unwrap_or("");
    let anchored = format!("{opening}<w:commentRangeStart w:id=\"{id}\"/>{body}");
    match anchored.strip_suffix("</w:p>") {
        Some(head) => format!("{head}<w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r></w:p>"),
        None => anchored,
    }
}

/// The arguments of [`write_header_footer_part`].
pub struct HeaderFooter<'a> {
    pub header: bool,
    /// Receives the story already in the package (empty for a new part) and returns what to write, so an operation can add to
    /// a header or footer the author wrote instead of erasing their words.
    pub body: &'a dyn Fn(&str) -> String,
    pub document_xml: &'a str,
    pub kind: &'a str,
}

/// Where a header or footer was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderFooterPart {
    pub part: String,
    pub relationship_id: String,
    /// The story the section already referenced was rewritten where it lives.
    pub replaced: bool,
}

/// The first element of `elements` whose text matches `pattern`, found by walking the matches of `finder` in `text`.
fn first_matching<'t>(finder: &JsRegex, text: &'t str, pattern: &JsRegex) -> Option<&'t str> {
    finder.find_iter(text).map(|range| &text[range]).find(|element| pattern.is_match(element))
}

/// `writeHeaderFooterPart(zip, { header, body, documentXml, kind })`.
pub fn write_header_footer_part(zip: &mut Package, request: &HeaderFooter<'_>) -> HeaderFooterPart {
    let tag = if request.header { "hdr" } else { "ftr" };
    let prefix = if request.header { "header" } else { "footer" };
    let document = |content: &str| format!("{XML_HEADER}<w:{tag} xmlns:w=\"{WORD_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\">{content}</w:{tag}>");
    let compose = request.body;
    // A story this section already references is rewritten where it lives. Writing a new part for every call left the
    // previous one orphaned in the package while the section pointed at whichever was written last.
    let reference = if !request.kind.is_empty() && !request.document_xml.is_empty() {
        let own_type = compiled(&format!(r#"\bw:type="{}""#, tag_pattern(request.kind)), "");
        let references = compiled(&format!(r"<w:{prefix}Reference\b[^>]*\/>"), "g");
        first_matching(&references, request.document_xml, &own_type)
    } else {
        None
    };
    let id_pattern = compiled(r#"\br:id="([^"]+)""#, "");
    let referenced_id = reference.and_then(|element| id_pattern.captures(element).and_then(|found| found.get(1).map(str::to_owned))).unwrap_or_default();
    if !referenced_id.is_empty() {
        let relationships = zip.text(&part_relationship_path(DOCUMENT_PART));
        let own_id = compiled(&format!(r#"\bId="{}""#, tag_pattern(&referenced_id)), "");
        let all = compiled(r"<Relationship\b[^>]*\/>", "g");
        let target_pattern = compiled(r#"\bTarget="([^"]+)""#, "");
        let path = first_matching(&all, &relationships, &own_id)
            .and_then(|element| target_pattern.captures(element).and_then(|found| found.get(1).map(str::to_owned)))
            .unwrap_or_default();
        let existing = if path.is_empty() { String::new() } else { part_from_target("word", &path) };
        if !existing.is_empty() && zip.file(&existing).is_some() {
            // The story keeps its own root: Word's declares the w14, mc and wp prefixes its paragraphs use, and page numbers
            // added into Word's footer under a root naming only w and r left a document Word would not open.
            let story = zip.text(&existing);
            let root_pattern = compiled(&format!(r"(<w:{tag}\b[^>]*>)([\s\S]*)</w:{tag}>"), "");
            let written = match root_pattern.captures(&story) {
                Some(root) => format!("{}{}{}</w:{tag}>", &story[..root.range().start], root.get(1).unwrap_or(""), compose(root.get(2).unwrap_or(""))),
                None => document(&compose("")),
            };
            zip.set(&existing, written);
            return HeaderFooterPart { part: existing, relationship_id: referenced_id, replaced: true };
        }
    }
    let mut ordinal = 1_u64;
    while zip.file(&format!("word/{prefix}{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let part = format!("word/{prefix}{ordinal}.xml");
    zip.set(&part, document(&compose("")));
    ensure_content_type_override(zip, &format!("/{part}"), if request.header { HEADER_CONTENT_TYPE } else { FOOTER_CONTENT_TYPE });
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(DOCUMENT_PART),
        &format!("{OFFICE_RELATIONSHIP_BASE}/{prefix}"),
        &format!("{prefix}{ordinal}.xml"),
        "",
    );
    HeaderFooterPart { part, relationship_id, replaced: false }
}

pub const SETTINGS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";

pub const SETTINGS_ORDER: [&str; 29] = [
    "w:writeProtection",
    "w:view",
    "w:zoom",
    "w:removePersonalInformation",
    "w:removeDateAndTime",
    "w:proofState",
    "w:attachedTemplate",
    "w:linkStyles",
    "w:stylePaneFormatFilter",
    "w:documentType",
    "w:mailMerge",
    "w:revisionView",
    "w:trackRevisions",
    "w:doNotTrackMoves",
    "w:doNotTrackFormatting",
    "w:documentProtection",
    "w:autoFormatOverride",
    "w:styleLockTheme",
    "w:styleLockQFSet",
    "w:defaultTabStop",
    "w:autoHyphenation",
    "w:characterSpacingControl",
    "w:updateFields",
    "w:compat",
    "w:rsids",
    "w:themeFontLang",
    "w:clrSchemeMapping",
    "w:decimalSymbol",
    "w:listSeparator",
];

/// `ensureDocxUpdateFields(zip)`: a TOC field carries the entries we cached, and Word draws exactly those until something
/// asks it to rebuild the field: the recipient opened a table of contents that was three lines of plain text with no leaders
/// and no page numbers. `updateFields` is the package asking for that rebuild on open, which is when Word writes the real
/// thing. Answers the part written.
pub fn ensure_docx_update_fields(zip: &mut Package) -> String {
    let part = "word/settings.xml";
    let created = format!("{XML_HEADER}<w:settings xmlns:w=\"{WORD_MAIN_NS}\"></w:settings>");
    let settings = ensure_part(
        zip,
        &PartDefinition { part, xml: &created, content_type: SETTINGS_CONTENT_TYPE, relationship: &format!("{OFFICE_RELATIONSHIP_BASE}/settings") },
    );
    zip.set(part, upsert_ordered_child(&settings, &SETTINGS_ORDER, "w:updateFields", "<w:updateFields w:val=\"true\"/>"));
    part.to_owned()
}

/// `upsertSectionReference(sectionXml, tag, kind, relationshipId)`.
pub fn upsert_section_reference(section_xml: &str, tag: &str, kind: &str, relationship_id: &str) -> String {
    let element = format!("<w:{tag} w:type=\"{kind}\" r:id=\"{relationship_id}\"/>");
    let pattern = compiled(&format!(r#"<w:{}\b[^>]*\bw:type="{}"[^>]*\/>"#, tag_pattern(tag), tag_pattern(kind)), "");
    if pattern.is_match(section_xml) {
        return replace_first(&pattern, section_xml, &element);
    }
    let position = section_xml.find('>').map_or(0, |at| at + 1);
    format!("{}{element}{}", &section_xml[..position], &section_xml[position..])
}

/// `documentTracksChanges(zip)`.
pub fn document_tracks_changes(zip: &Package) -> bool {
    settings_track_changes(&zip.text("word/settings.xml"))
}

/// `revisionAttributes(id, author)` at the instant `now_ms`. The `w:date` is the instant in UTC, which is what its `Z` says.
pub fn revision_attributes_at(id: u64, author: &str, now_ms: f64) -> String {
    let date = local_fields_in(Tz::UTC, now_ms).map_or_else(String::new, |fields| {
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second)
    });
    format!("w:id=\"{id}\" w:author=\"{}\" w:date=\"{date}\"", xml_encode(if author.is_empty() { "Mixdog" } else { author }))
}

/// `revisionAttributes(id, author)` now.
pub fn revision_attributes(id: u64, author: &str) -> String {
    let now = mixdog_office_base::clock::now_ms();
    revision_attributes_at(id, author, now)
}

/// `nextRevisionId(documentXml)`: one more than the highest `w:id` of an insertion or deletion.
pub fn next_revision_id(document_xml: &str) -> u64 {
    let ids = compiled(r#"<w:(?:ins|del)\b[^>]*\bw:id="(\d+)""#, "g");
    ids.captures_iter(document_xml).map(|found| found.get(1).and_then(|digits| digits.parse::<u64>().ok()).unwrap_or(0)).fold(0, u64::max) + 1
}

/// `markRunsDeleted(paragraphXml, id, author)`: every run of the paragraph wrapped as a tracked deletion, one id per run. A
/// field's instruction (PAGE, HYPERLINK, TOC) is deleted text too: Word refuses an `<w:instrText>` inside `<w:del>`.
pub fn mark_runs_deleted(paragraph_xml: &str, id: u64, author: &str) -> String {
    let run_pattern = compiled(WORD_RUN_SOURCE, "g");
    let runs: Vec<(usize, usize)> = run_pattern.find_iter(paragraph_xml).map(|range| (range.start, range.end)).collect();
    let text_open = compiled(r"<w:t(\s[^>]*)?>", "g");
    let instruction_open = compiled(r"<w:instrText(\s[^>]*)?>", "g");
    let mut output = paragraph_xml.to_owned();
    for (index, (start, end)) in runs.iter().enumerate().rev() {
        let deleted = text_open.replace_all_with(&paragraph_xml[*start..*end], |found| format!("<w:delText{}>", found.get(1).unwrap_or("")));
        let deleted = deleted.replace("</w:t>", "</w:delText>");
        let deleted = instruction_open.replace_all_with(&deleted, |found| format!("<w:delInstrText{}>", found.get(1).unwrap_or("")));
        let deleted = deleted.replace("</w:instrText>", "</w:delInstrText>");
        let wrapped = format!("<w:del {}>{deleted}</w:del>", revision_attributes(id + index as u64, author));
        output = format!("{}{wrapped}{}", &output[..*start], &output[*end..]);
    }
    output
}

/// How far a list's text hangs after its mark, on every level of both kinds (the Word backend's templates set the same).
pub const LIST_HANGING_POINTS: u32 = 18;

// The levels a numbered list counts in: the global 1. a. i., and the Korean document's 1. 가. 1) (Word's ganada format),
// which the Word backend's templates set the same.
const GLOBAL_NUMBER_LEVELS: [(&str, &str); 3] = [("decimal", "%1."), ("lowerLetter", "%2."), ("lowerRoman", "%3.")];
const KOREAN_NUMBER_LEVELS: [(&str, &str); 3] = [("decimal", "%1."), ("ganada", "%2."), ("decimal", "%3)")];
const BULLET_MARKS: [&str; 3] = ["\u{2022}", "\u{25E6}", "\u{25AA}"];

fn numbering_definition(abstract_id: i64, kind: &str) -> String {
    let hanging = LIST_HANGING_POINTS * 20;
    let mut levels = String::new();
    for level in 0..3_usize {
        let indent = 720 * (level + 1);
        if kind == "bullet" {
            levels.push_str(&format!(
                "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/>\
<w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/>\
<w:pPr><w:ind w:left=\"{indent}\" w:hanging=\"{hanging}\"/></w:pPr>\
<w:rPr><w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\" w:hint=\"default\"/></w:rPr></w:lvl>",
                BULLET_MARKS[level]
            ));
            continue;
        }
        let (format, text) = if kind == "korean" { KOREAN_NUMBER_LEVELS[level] } else { GLOBAL_NUMBER_LEVELS[level] };
        levels.push_str(&format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{format}\"/>\
<w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/>\
<w:pPr><w:ind w:left=\"{indent}\" w:hanging=\"{hanging}\"/></w:pPr></w:lvl>"
        ));
    }
    format!("<w:abstractNum w:abstractNumId=\"{abstract_id}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{levels}</w:abstractNum>")
}

/// `numberedListScheme(text, named)`: the numbering a new list counts in: a list that opens on Korean text counts 1. 가. 1),
/// as a Korean document does, and any other the global 1. a. i.; `named` (`korean` or `global`) names it outright. Read from
/// the words rather than the document's language, which only says which Word installed the file.
pub fn numbered_list_scheme(text: &str, named: &str) -> Result<&'static str, String> {
    let scheme = mixdog_js::js_to_lowercase(named);
    match scheme.as_str() {
        "korean" => return Ok("korean"),
        "global" => return Ok("number"),
        "" => {}
        _ => return Err(format!("listNumbering must be 'korean' or 'global', not \"{named}\"")),
    }
    Ok(if text.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)) { "korean" } else { "number" })
}

/// The kind a list definition serves, by what its first level shows. A document Word wrote keeps its bullet list as a decimal
/// level with the mark "•": matched by numFmt, a numbered item appended after a heading reused it and printed a bullet.
fn first_level_format(abstract_xml: &str) -> String {
    let pattern = compiled(r#"<w:lvl\b[^>]*\bw:ilvl="0"[^>]*>[\s\S]*?<\/w:lvl>"#, "");
    numbering_level_format(pattern.find(abstract_xml).map_or("", |range| &abstract_xml[range]))
}

/// `numberingScheme(abstractXml)`: bullet, korean (a numbered list whose second level counts 가, 나, 다), number (any other
/// numbered list), or empty for a definition that is neither: the kinds `ensure_numbering` reuses a definition for.
fn numbering_scheme(abstract_xml: &str) -> &'static str {
    let first = first_level_format(abstract_xml);
    if first == "bullet" {
        return "bullet";
    }
    if first != "decimal" {
        return "";
    }
    let pattern = compiled(r#"<w:lvl\b[^>]*\bw:ilvl="1"[^>]*>[\s\S]*?<\/w:lvl>"#, "");
    let second = pattern.find(abstract_xml).map_or("", |range| &abstract_xml[range]);
    if numbering_level_format(second) == "ganada" { "korean" } else { "number" }
}

/// A numbering part's text and the list instance chosen in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberingPart {
    pub xml: String,
    pub num_id: u64,
    pub created: bool,
}

fn number_of(digits: &str) -> u64 {
    digits.parse().unwrap_or(0)
}

/// `ensureNumbering(zip, kind, { restart })`: kind is bullet, number (1. a. i.), or korean (1. 가. 1)). `restart` makes a new
/// list instance of the kind, counting from 1 again. Word numbers every instance of one abstract definition as one list
/// unless the instance overrides its start, so the restart names it on each level.
pub fn ensure_numbering(zip: &mut Package, kind: &str, restart: bool) -> NumberingPart {
    let part = "word/numbering.xml";
    let created = format!("{XML_HEADER}<w:numbering xmlns:w=\"{WORD_MAIN_NS}\"></w:numbering>");
    let xml = ensure_part(
        zip,
        &PartDefinition {
            part,
            xml: &created,
            content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
            relationship: &format!("{OFFICE_RELATIONSHIP_BASE}/numbering"),
        },
    );
    let mut existing_abstract: Option<i64> = None;
    let abstracts = compiled(r#"<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>"#, "g");
    for found in abstracts.captures_iter(&xml) {
        if numbering_scheme(&xml[found.range()]) != kind {
            continue;
        }
        let abstract_id = found.get(1).unwrap_or("");
        let instance = compiled(&format!(r#"<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="{abstract_id}"\/>"#), "");
        if let Some(reuse) = instance.captures(&xml) {
            if !restart {
                return NumberingPart { xml: xml.clone(), num_id: number_of(reuse.get(1).unwrap_or("")), created: false };
            }
            existing_abstract = Some(number_of(abstract_id) as i64);
            break;
        }
    }
    let abstract_ids = compiled(r#"\bw:abstractNumId="(\d+)""#, "g");
    let highest_abstract = abstract_ids.captures_iter(&xml).map(|found| number_of(found.get(1).unwrap_or("")) as i64).fold(-1, i64::max);
    let instance_ids = compiled(r#"<w:num\b[^>]*\bw:numId="(\d+)""#, "g");
    let highest_instance = instance_ids.captures_iter(&xml).map(|found| number_of(found.get(1).unwrap_or(""))).fold(0, u64::max);
    let abstract_id = existing_abstract.unwrap_or(highest_abstract + 1);
    let num_id = highest_instance + 1;
    let overrides = if existing_abstract.is_none() {
        String::new()
    } else {
        (0..3).map(|level| format!("<w:lvlOverride w:ilvl=\"{level}\"><w:startOverride w:val=\"1\"/></w:lvlOverride>")).collect()
    };
    let definition = format!("<w:num w:numId=\"{num_id}\"><w:abstractNumId w:val=\"{abstract_id}\"/>{overrides}</w:num>");
    let mut next = xml.clone();
    if existing_abstract.is_none() {
        let all = compiled(r"<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>", "g");
        let position = match all.find_iter(&xml).last() {
            Some(range) => range.end,
            None => {
                // `indexOf('>', indexOf('<w:numbering')) + 1`; a missing marker reads from the start.
                let from = xml.find("<w:numbering").unwrap_or(0);
                xml[from..].find('>').map_or(0, |at| from + at + 1)
            }
        };
        next = format!("{}{}{}", &xml[..position], numbering_definition(abstract_id, kind), &xml[position..]);
    }
    next = replace_first_text(&next, "</w:numbering>", &format!("{definition}</w:numbering>"));
    zip.set(part, next.clone());
    NumberingPart { xml: next, num_id, created: true }
}

/// What decides the list an appended item belongs to.
#[derive(Debug, Clone, Copy)]
pub struct NumberingChoice<'a> {
    /// The item's `listContinue`: carries the latest list on past what stands between.
    pub continued: bool,
    /// `number` or `korean`: the numbering a new list counts in.
    pub scheme: &'a str,
}

impl Default for NumberingChoice<'_> {
    fn default() -> Self {
        Self { continued: false, scheme: "number" }
    }
}

/// `appendedNumbering(zip, documentXml, options)`: the numbered list an appended item belongs to. An item right after a list
/// item (its own list's, or a bullet nested under it) continues the latest numbered list; after anything else (a heading, a
/// body paragraph, a table) it starts a new list at 1: "3. 다음 분기 과제" read its two items as 4 and 5 of the list two sections
/// above. An item that continues a list takes the scheme that list opened with, so a Korean list's "QA" item stays its third
/// item rather than opening a list of its own at 1.
pub fn appended_numbering(zip: &mut Package, document_xml: &str, choice: &NumberingChoice<'_>) -> NumberingPart {
    // `slice(0, lastIndexOf(...))`: a missing marker is -1, which drops the last character.
    let before = match document_xml.rfind("<w:sectPr").or_else(|| document_xml.rfind("</w:body>")) {
        Some(at) => &document_xml[..at],
        None => without_last_character(document_xml),
    };
    numbering_after(zip, before, choice)
}

/// `numberingAfter(zip, before, { continued, scheme })`: the same choice for an item anywhere in the body, `before` being the
/// body up to it: set_list and set_paragraph_format put a paragraph in a list as Word's backend does, continuing the list just
/// before it and otherwise opening one at 1.
pub fn numbering_after(zip: &mut Package, before: &str, choice: &NumberingChoice<'_>) -> NumberingPart {
    let body = js_trim_end(before);
    let last_paragraph = [body.rfind("<w:p>"), body.rfind("<w:p ")].into_iter().flatten().max();
    let list_item = compiled(r"<w:numPr\b", "");
    let follows_list = !body.ends_with("</w:tbl>") && last_paragraph.is_some_and(|at| list_item.is_match(&body[at..]));
    if !follows_list && !choice.continued {
        return ensure_numbering(zip, choice.scheme, true);
    }
    let existing = zip.text("word/numbering.xml");
    let abstracts = compiled(r#"<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>"#, "g");
    let numbered_abstracts: Vec<String> = abstracts
        .captures_iter(&existing)
        .filter(|found| ["number", "korean"].contains(&numbering_scheme(&existing[found.range()])))
        .map(|found| found.get(1).unwrap_or("").to_owned())
        .collect();
    let instances = compiled(r#"<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)""#, "g");
    let numbered_ids: Vec<String> = instances
        .captures_iter(&existing)
        .filter(|found| numbered_abstracts.iter().any(|id| id == found.get(2).unwrap_or("")))
        .map(|found| found.get(1).unwrap_or("").to_owned())
        .collect();
    let marker = "<w:numId ";
    let own = compiled(r#"^<w:numId w:val="(\d+)""#, "");
    let mut at = body.rfind(marker);
    while let Some(index) = at {
        if let Some(id) = own.captures(&body[index..]).and_then(|found| found.get(1).map(str::to_owned)) {
            if numbered_ids.contains(&id) {
                return NumberingPart { xml: existing, num_id: number_of(&id), created: false };
            }
        }
        // `lastIndexOf(marker, at - 1)`: the next marker that starts before this one. Node's search finds a marker at the
        // very start again for ever; here the walk ends there.
        at = if index == 0 { None } else { body[..(index - 1 + marker.len()).min(body.len())].rfind(marker) };
    }
    ensure_numbering(zip, choice.scheme, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(files: &[(&str, &str)]) -> Package {
        let mut package = Package::new();
        for (name, content) in files {
            package.set(name, *content);
        }
        package
    }

    #[test]
    fn comment_ids_are_eight_hex_digits() {
        assert_eq!(comment_paragraph_id(0), "10000000");
        assert_eq!(comment_paragraph_id(255), "100000FF");
        assert_eq!(comment_durable_id(0), "10000000");
        assert_eq!(comment_durable_id(1), "3E3779B2");
    }

    #[test]
    fn a_section_child_is_written_in_schema_order() {
        let section = "<w:sectPr><w:pgSz/><w:cols/></w:sectPr>";
        assert_eq!(upsert_section_child(section, "titlePg", "<w:titlePg/>"), "<w:sectPr><w:pgSz/><w:cols/><w:titlePg/></w:sectPr>");
        assert_eq!(upsert_section_child(section, "pgMar", "<w:pgMar/>"), "<w:sectPr><w:pgSz/><w:pgMar/><w:cols/></w:sectPr>");
        assert_eq!(upsert_section_child(section, "pgSz", "<w:pgSz w:w=\"1\"/>"), "<w:sectPr><w:pgSz w:w=\"1\"/><w:cols/></w:sectPr>");
    }

    #[test]
    fn a_missing_section_is_reported_by_number() {
        let document = "<w:document><w:body><w:p/><w:sectPr/></w:body></w:document>";
        let error = write_section_properties_at(document, &json!(3), &|xml| xml.to_owned()).expect_err("one section");
        assert_eq!(error, "DOCX has 1 section; section 3 does not exist");
        let error = write_section_properties_at(document, &json!(1.5), &|xml| xml.to_owned()).expect_err("not whole");
        assert_eq!(error, "DOCX section must be a positive whole number");
    }

    #[test]
    fn numbering_reuses_a_definition_and_restarts_on_request() {
        let mut zip = package(&[("[Content_Types].xml", "<Types></Types>")]);
        let first = ensure_numbering(&mut zip, "number", false);
        assert!(first.created);
        assert_eq!(first.num_id, 1);
        assert_eq!(ensure_numbering(&mut zip, "number", false), NumberingPart { xml: first.xml.clone(), num_id: 1, created: false });
        let restarted = ensure_numbering(&mut zip, "number", true);
        assert_eq!(restarted.num_id, 2);
        assert!(restarted.xml.contains("<w:num w:numId=\"2\"><w:abstractNumId w:val=\"0\"/><w:lvlOverride"));
        assert!(zip.text("[Content_Types].xml").contains("/word/numbering.xml"));
    }

    #[test]
    fn the_numbering_scheme_follows_the_words() {
        assert_eq!(numbered_list_scheme("가나다", ""), Ok("korean"));
        assert_eq!(numbered_list_scheme("abc", ""), Ok("number"));
        assert_eq!(numbered_list_scheme("가", "GLOBAL"), Ok("number"));
        assert!(numbered_list_scheme("x", "roman").is_err());
    }

    #[test]
    fn a_comment_identity_is_written_once_and_forgotten() {
        let mut zip = package(&[("[Content_Types].xml", "<Types></Types>")]);
        register_comment_thread(&mut zip, 1, 0, false);
        let (para_id, _) = register_comment_identity(&mut zip, 1, "2026-01-02T03:04:05Z");
        register_comment_identity(&mut zip, 1, "2026-01-02T03:04:05Z");
        assert_eq!(zip.text("word/commentsIds.xml").matches("w16cid:commentId ").count(), 1);
        let removed = forget_comment_identity(&mut zip, &format!("<w:comment><w:p w14:paraId=\"{para_id}\"/></w:comment>"));
        assert_eq!(removed, ["word/commentsExtended.xml", "word/commentsIds.xml", "word/commentsExtensible.xml"]);
        assert!(!zip.text("word/commentsIds.xml").contains("w16cid:commentId "));
    }

    #[test]
    fn a_numbered_walk_ends_at_a_marker_at_the_start() {
        let mut zip = package(&[("[Content_Types].xml", "<Types></Types>")]);
        let part = numbering_after(&mut zip, "<w:numId w:val=\"9\"/>", &NumberingChoice { continued: true, scheme: "number" });
        assert!(part.created);
    }

    #[test]
    fn revision_dates_are_utc_whatever_the_local_zone() {
        // 2023-11-14T22:13:20Z is 07:13:20 on the 15th in Seoul; the date still says the UTC instant.
        let seoul = mixdog_js::time::with_local_zone(Tz::Asia__Seoul, || revision_attributes_at(4, "", 1_700_000_000_000.0));
        assert_eq!(seoul, "w:id=\"4\" w:author=\"Mixdog\" w:date=\"2023-11-14T22:13:20Z\"");
        let utc = mixdog_js::time::with_local_zone(Tz::UTC, || revision_attributes_at(5, "A & B", 1_700_000_000_999.0));
        assert_eq!(utc, "w:id=\"5\" w:author=\"A &amp; B\" w:date=\"2023-11-14T22:13:20Z\"");
    }
}
