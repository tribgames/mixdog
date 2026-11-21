//! `portable/portable-opc.mjs`: the Open Packaging Conventions layer: content types, relationships and the parts a
//! relationship points at, over a [`Package`]. Parts are copied between packages (a slide imported from another deck) and
//! within one (a duplicated slide) with the parts they own; a picture, a theme or a layout stays shared.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, number_to_string};
use mixdog_office_base::labels::preset_labels;
use mixdog_office_base::values::truthy;
use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::xml::{OFFICE_RELATIONSHIP_BASE, XML_HEADER, compiled, tag_pattern, xml_attribute, xml_decode, xml_encode};
use crate::zipio::Package;

/// The pieces of Node's `path.posix` the package paths use.
pub mod posix {
    use mixdog_js::nodepath::{self, Style};

    /// `posix.dirname`.
    pub fn dirname(path: &str) -> String {
        if path.is_empty() {
            return ".".to_owned();
        }
        let has_root = path.starts_with('/');
        let bytes = path.as_bytes();
        let mut end: Option<usize> = None;
        let mut matched_slash = true;
        for at in (1..bytes.len()).rev() {
            if bytes[at] == b'/' {
                if !matched_slash {
                    end = Some(at);
                    break;
                }
            } else {
                matched_slash = false;
            }
        }
        match end {
            None => if has_root { "/" } else { "." }.to_owned(),
            Some(1) if has_root => "//".to_owned(),
            Some(at) => path[..at].to_owned(),
        }
    }

    /// `posix.basename`.
    pub fn basename(path: &str) -> String {
        path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_owned()
    }

    /// `posix.normalize`.
    pub fn normalize(path: &str) -> String {
        nodepath::normalize(Style::Posix, path)
    }
    /// `posix.join`.
    pub fn join(parts: &[&str]) -> String {
        let joined: Vec<&str> = parts.iter().copied().filter(|part| !part.is_empty()).collect();
        if joined.is_empty() { ".".to_owned() } else { normalize(&joined.join("/")) }
    }
    /// `posix.relative` of two package paths. Node completes a relative path with the process directory, which both
    /// paths share; here they share a root, so the answer does not depend on where the process runs.
    pub fn relative(from: &str, to: &str) -> String {
        let rooted = |path: &str| if path.starts_with('/') { path.to_owned() } else { format!("/{path}") };
        nodepath::relative(Style::Posix, &rooted(from), &rooted(to))
    }
}

pub const PACKAGE_RELATIONSHIP_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub const CHART_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
pub const WORKBOOK_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/// `PIXELS_TO_POINTS`.
pub const PIXELS_TO_POINTS: f64 = 0.75;
const CONTENT_TYPES_PART: &str = "[Content_Types].xml";
const RELATIONSHIPS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-package.relationships+xml";

/// `IMAGE_CONTENT_TYPES`: the content type of an image extension.
pub const IMAGE_CONTENT_TYPES: [(&str, &str); 9] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("svg", "image/svg+xml"),
    ("webp", "image/webp"),
];

/// `IMAGE_CONTENT_TYPES[extension]`.
pub fn image_content_type(extension: &str) -> Option<&'static str> {
    IMAGE_CONTENT_TYPES.iter().find(|(known, _)| *known == extension).map(|(_, content_type)| *content_type)
}

/// The Id to Target pairs of a relationships part (`Map`: a repeated Id keeps its first place and takes the last Target).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelationshipMap {
    entries: Vec<(String, String)>,
}

impl RelationshipMap {
    fn set(&mut self, id: &str, target: &str) {
        match self.entries.iter_mut().find(|(known, _)| known == id) {
            Some(entry) => entry.1 = target.to_owned(),
            None => self.entries.push((id.to_owned(), target.to_owned())),
        }
    }

    pub fn get(&self, id: &str) -> Option<&str> {
        self.entries.iter().find(|(known, _)| known == id).map(|(_, target)| target.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(id, target)| (id.as_str(), target.as_str()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

static RELATIONSHIP_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<Relationship\b([^>]+?)\/?>", "g"));
static RELATIONSHIP_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bId="([^"]+)""#, ""));
static RELATIONSHIP_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bTarget="([^"]+)""#, ""));

/// `relationshipMap(xml)`.
pub fn relationship_map(xml: &str) -> RelationshipMap {
    let mut map = RelationshipMap::default();
    for found in RELATIONSHIP_TAG.captures_iter(xml) {
        let attrs = found.get(1).unwrap_or("");
        let id = RELATIONSHIP_ID.captures(attrs).and_then(|c| c.get(1));
        let target = RELATIONSHIP_TARGET.captures(attrs).and_then(|c| c.get(1));
        if let (Some(id), Some(target)) = (id, target) {
            map.set(id, target);
        }
    }
    map
}

/// An image's size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelSize {
    pub width: u32,
    pub height: u32,
}

fn be32(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn be16(data: &[u8], at: usize) -> u32 {
    u32::from(u16::from_be_bytes([data[at], data[at + 1]]))
}

/// `imagePixelSize(data)`: the size a PNG, JPEG or GIF header declares.
pub fn image_pixel_size(data: &[u8]) -> Option<PixelSize> {
    if data.len() > 24 && be32(data, 0) == 0x8950_4e47 {
        return Some(PixelSize { width: be32(data, 16), height: be32(data, 20) });
    }
    if data.len() > 4 && data[0] == 0xff && data[1] == 0xd8 {
        let mut offset = 2;
        while offset + 9 < data.len() {
            if data[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = data[offset + 1];
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                return Some(PixelSize { height: be16(data, offset + 5), width: be16(data, offset + 7) });
            }
            let length = be16(data, offset + 2) as usize;
            if length < 2 {
                break;
            }
            offset += 2 + length;
        }
    }
    if data.len() > 10 && &data[..3] == b"GIF" {
        return Some(PixelSize { width: u32::from(u16::from_le_bytes([data[6], data[7]])), height: u32::from(u16::from_le_bytes([data[8], data[9]])) });
    }
    None
}

static RELATIONSHIP_ID_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bId="rId(\d+)""#, "g"));

/// `nextRelationshipId(rels)`: `rId` and one more than the highest `rId` number present.
pub fn next_relationship_id(rels: &str) -> String {
    let highest = RELATIONSHIP_ID_NUMBER.captures_iter(rels).map(|found| mixdog_js::string_to_number(found.get(1).unwrap_or(""))).fold(0.0_f64, f64::max);
    format!("rId{}", number_to_string(highest + 1.0))
}

/// `xml.replace(search, () => replacement)` with a string pattern: the first occurrence only.
fn replace_first(text: &str, search: &str, replacement: &str) -> String {
    text.replacen(search, replacement, 1)
}

/// `ensureContentTypeOverride(zip, part, type)`.
pub fn ensure_content_type_override(zip: &mut Package, part: &str, content_type: &str) {
    let xml = zip.text(CONTENT_TYPES_PART);
    if xml.contains(&format!("PartName=\"{part}\"")) {
        return;
    }
    let next = replace_first(&xml, "</Types>", &format!("<Override PartName=\"{part}\" ContentType=\"{content_type}\"/></Types>"));
    zip.set(CONTENT_TYPES_PART, next);
}

/// `removeContentTypeOverride(zip, part)`.
pub fn remove_content_type_override(zip: &mut Package, part: &str) {
    let xml = zip.text(CONTENT_TYPES_PART);
    let pattern = compiled(&format!(r#"<Override\b[^>]*\bPartName="{}"[^>]*\/>"#, tag_pattern(part)), "");
    zip.set(CONTENT_TYPES_PART, remove_first(&pattern, &xml));
}

/// `text.replace(pattern, '')` for a pattern without the `g` flag.
fn remove_first(pattern: &JsRegex, text: &str) -> String {
    match pattern.find(text) {
        Some(range) => format!("{}{}", &text[..range.start], &text[range.end..]),
        None => text.to_owned(),
    }
}

/// `ensureDefaultContentType(zip, extension, type)`.
pub fn ensure_default_content_type(zip: &mut Package, extension: &str, content_type: &str) {
    let xml = zip.text(CONTENT_TYPES_PART);
    let known = compiled(&format!(r#"<Default\b[^>]*\bExtension="{extension}""#), "i");
    if known.is_match(&xml) {
        return;
    }
    static TYPES_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<Types\b[^>]*>", ""));
    let next = match TYPES_OPEN.find(&xml) {
        Some(range) => format!("{}<Default Extension=\"{extension}\" ContentType=\"{content_type}\"/>{}", &xml[..range.end], &xml[range.end..]),
        None => xml,
    };
    zip.set(CONTENT_TYPES_PART, next);
}

/// `addPackageRelationship(zip, relsPath, type, target, mode)`: the new relationship's Id. A relationships part the
/// package never had is created, and a package that declares content types gets the rels default.
pub fn add_package_relationship(zip: &mut Package, rels_path: &str, relationship_type: &str, target: &str, mode: &str) -> String {
    let existing = zip.text(rels_path);
    if existing.is_empty() {
        // A relationships part the package never had needs the rels default content type, or the package validator
        // reports the new part as untyped.
        let types = zip.text(CONTENT_TYPES_PART);
        if types.contains("</Types>") {
            ensure_default_content_type(zip, "rels", RELATIONSHIPS_CONTENT_TYPE);
        }
    }
    let xml = if existing.is_empty() { format!("{XML_HEADER}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\"></Relationships>") } else { existing };
    let id = next_relationship_id(&xml);
    let mode_attribute = if mode.is_empty() { String::new() } else { format!(" TargetMode=\"{mode}\"") };
    let relationship = format!("<Relationship Id=\"{id}\" Type=\"{relationship_type}\" Target=\"{}\"{mode_attribute}/>", xml_encode(target));
    zip.set(rels_path, replace_first(&xml, "</Relationships>", &format!("{relationship}</Relationships>")));
    id
}

/// `removePackageRelationship(zip, relsPath, id)`.
pub fn remove_package_relationship(zip: &mut Package, rels_path: &str, id: &str) {
    let xml = zip.text(rels_path);
    if xml.is_empty() {
        return;
    }
    let pattern = compiled(&format!(r#"<Relationship\b[^>]*\bId="{}"[^>]*\/>"#, tag_pattern(id)), "");
    zip.set(rels_path, remove_first(&pattern, &xml));
}

/// `partRelationshipPath(part)`: where the relationships of a part live.
pub fn part_relationship_path(part: &str) -> String {
    format!("{}/_rels/{}.rels", posix::dirname(part), posix::basename(part))
}

/// `relationshipTargetByType(relationshipsXml, type)`: the Target of the first relationship of one type, exactly as the
/// rels part writes it (relative to the owning part, or absolute from the package root); empty when the part declares
/// none.
pub fn relationship_target_by_type(relationships_xml: &str, relationship_type: &str) -> String {
    let pattern = compiled(&format!(r#"<Relationship\b[^>]*\bType="[^"]*/{}"[^>]*\bTarget="([^"]+)""#, tag_pattern(relationship_type)), "");
    pattern.captures(relationships_xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
}

static RELATIONSHIP_ANY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<Relationship\b([^>]*?)\/?>", "g"));

/// One relationship of a rels part that points inside the package.
struct InternalRelationship {
    block: String,
    raw: String,
    target: String,
}

static RELATIONSHIP_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<Relationship\b[^>]*?\/>", "g"));
static EXTERNAL_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bTargetMode="External""#, "i"));

/// Every relationship of a rels part that points inside the package: an external target is an address the package does
/// not own, and a block without a target has nothing to copy or rewrite.
fn internal_relationships(xml: &str) -> Vec<InternalRelationship> {
    let mut found = Vec::new();
    for range in RELATIONSHIP_BLOCK.find_iter(xml) {
        let block = &xml[range];
        if EXTERNAL_TARGET.is_match(block) {
            continue;
        }
        let raw = xml_attribute(block, "Target");
        let target = xml_decode(&raw);
        if target.is_empty() {
            continue;
        }
        found.push(InternalRelationship { block: block.to_owned(), raw, target });
    }
    found
}

static SOURCE_LABEL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:출처|자료|source)\s*[:：]", "i"));

/// The text of a JavaScript value that is a string, a number or a boolean, read with `String(...)`.
fn text_of(value: &Value) -> String {
    mixdog_js::value_to_string(value)
}

/// `source.document || source.label || ''` read as `String(...).trim()`.
fn trimmed_first_truthy(source: &Value, keys: &[&str]) -> String {
    let chosen = keys.iter().filter_map(|key| source.get(*key)).find(|value| truthy(value));
    chosen.map_or_else(String::new, |value| js_trim(&text_of(value)).to_owned())
}

/// `provenanceCitation(source)`: the citation printed on the page, composed once for both backends. Its prefix follows
/// the language the source is named in; a source already written with its label keeps it.
pub fn provenance_citation(source: &Value) -> String {
    if !truthy(source) {
        return String::new();
    }
    let labelled = |cited: &str, sample: &Value| -> String {
        if SOURCE_LABEL.is_match(cited) { cited.to_owned() } else { format!("{}: {cited}", preset_labels(sample).source) }
    };
    match source {
        Value::String(text) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() { String::new() } else { labelled(trimmed, source) }
        }
        Value::Object(_) => {
            let document = trimmed_first_truthy(source, &["document", "label"]);
            let target = trimmed_first_truthy(source, &["target"]);
            if document.is_empty() {
                return String::new();
            }
            let cited = if target.is_empty() { document.clone() } else { format!("{document}#{target}") };
            let label = source.get("label").cloned().unwrap_or(Value::Null);
            labelled(&cited, &Value::Array(vec![Value::String(document), Value::String(target), label]))
        }
        _ => String::new(),
    }
}

/// `partNaming(path)`: the prefix and extension a copy of a part is named by.
fn part_naming(path: &str) -> (String, String) {
    static NUMBERED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Za-z_]+?)\d*\.([A-Za-z0-9]+)$", ""));
    let base = posix::basename(path);
    if let Some(found) = NUMBERED.captures(&base) {
        return (found.get(1).unwrap_or("").to_owned(), found.get(2).unwrap_or("").to_owned());
    }
    match base.rfind('.').filter(|dot| *dot > 0) {
        Some(dot) => (base[..dot].to_owned(), base[dot + 1..].to_owned()),
        None => (base, "bin".to_owned()),
    }
}

/// `nextAvailablePart`: the first `<directory>/<prefix><n>.<extension>` no file holds.
fn next_available_part(zip: &Package, directory: &str, prefix: &str, extension: &str) -> String {
    let mut ordinal = 1_u64;
    while zip.file(&format!("{directory}/{prefix}{ordinal}.{extension}")).is_some() {
        ordinal += 1;
    }
    format!("{directory}/{prefix}{ordinal}.{extension}")
}

fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `partDigest(archive, path)`: the SHA-1 of a part, empty when the part is missing.
fn part_digest(archive: &Package, path: &str) -> String {
    archive.file(path).map(sha1_hex).unwrap_or_default()
}

/// `findMatchingPart(zip, pattern, digest)`: the first entry whose name the pattern matches and whose bytes hash to the
/// digest.
fn find_matching_part(zip: &Package, pattern: &JsRegex, digest: &str) -> String {
    if digest.is_empty() {
        return String::new();
    }
    for name in zip.names() {
        if pattern.is_match(&name) && part_digest(zip, &name) == digest {
            return name;
        }
    }
    String::new()
}

/// How the content type of a part is declared: an override of the part, or the default of its extension.
enum ContentTypeRule {
    Override(String),
    Default { extension: String, content_type: String },
}

/// The rule `types_xml` declares for a part (`copyPartContentType`'s reading).
fn content_type_rule(types_xml: &str, source_path: &str) -> Option<ContentTypeRule> {
    let override_pattern = compiled(&format!(r#"<Override\b[^>]*\bPartName="/{}"[^>]*\/>"#, tag_pattern(source_path)), "");
    if let Some(range) = override_pattern.find(types_xml) {
        return Some(ContentTypeRule::Override(xml_attribute(&types_xml[range], "ContentType")));
    }
    let extension = js_to_lowercase(&part_naming(source_path).1);
    let default_pattern = compiled(&format!(r#"<Default\b[^>]*\bExtension="{extension}"[^>]*\/>"#), "i");
    default_pattern
        .find(types_xml)
        .map(|range| ContentTypeRule::Default { extension: extension.clone(), content_type: xml_attribute(&types_xml[range], "ContentType") })
}

/// `copyPartContentType`'s writing: the target part is declared the way the source part was.
fn apply_content_type(zip: &mut Package, rule: Option<ContentTypeRule>, target_path: &str) {
    match rule {
        Some(ContentTypeRule::Override(content_type)) => ensure_content_type_override(zip, &format!("/{target_path}"), &content_type),
        Some(ContentTypeRule::Default { extension, content_type }) => ensure_default_content_type(zip, &extension, &content_type),
        None => {}
    }
}

fn copy_part_content_type(source: &Package, zip: &mut Package, source_path: &str, target_path: &str) {
    let rule = content_type_rule(&source.text(CONTENT_TYPES_PART), source_path);
    apply_content_type(zip, rule, target_path);
}

/// `block.replace(`Target="${raw}"`, ...)` inside the first occurrence of `block` in `output`.
fn rewrite_target(output: &str, block: &str, raw: &str, rewritten: &str) -> String {
    let changed = replace_first(block, &format!("Target=\"{raw}\""), &format!("Target=\"{}\"", xml_encode(rewritten)));
    replace_first(output, block, &changed)
}

static TARGET_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bTarget="[^"]*""#, ""));

/// `block.replace(/\bTarget="[^"]*"/, ...)` inside the first occurrence of `block` in `output`.
fn retarget(output: &str, block: &str, rewritten: &str) -> String {
    let changed = match TARGET_ATTRIBUTE.find(block) {
        Some(range) => format!("{}Target=\"{}\"{}", &block[..range.start], xml_encode(rewritten), &block[range.end..]),
        None => block.to_owned(),
    };
    replace_first(output, block, &changed)
}

/// Parts a slide owns rather than shares: a chart carries its own data, a diagram its own nodes. A picture, a theme, or
/// a layout is the same object on every page that uses it, so a copy keeps pointing at the original.
static SHARED_ON_CLONE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\/(image|media|video|audio|theme|slideLayout|slideMaster|notesMaster|notesSlide|hyperlink)$", ""));

static OWNED_BY_SLIDE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\/(chart|chartEx|diagramData|diagramLayout|diagramColors|diagramQuickStyle|diagramDrawing|comments)$", ""));

/// Slide layout ids live above 2^31 by the OOXML convention PowerPoint writes.
const FIRST_SLIDE_LAYOUT_ID: f64 = 2_147_483_648.0;

/// `relationshipOwner(relPath)`: the part a rels part belongs to (empty for the package's own).
pub fn relationship_owner(rel_path: &str) -> String {
    if rel_path == "_rels/.rels" {
        return String::new();
    }
    static OWNED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(.*)\/_rels\/([^/]+)\.rels$", "i"));
    OWNED.captures(rel_path).map(|found| format!("{}/{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))).unwrap_or_default()
}

/// `decodeURIComponent`; `None` for a malformed escape or a sequence that is not UTF-8 (a `URIError`).
pub(crate) fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.to_owned());
    }
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = text.get(at + 1..at + 3)?;
            if !pair.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn types(extra: &str) -> String {
        format!(
            "{XML_HEADER}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/>{extra}</Types>"
        )
    }

    #[test]
    fn content_type_overrides_and_defaults_are_added_once_and_removed() {
        let mut zip = Package::new();
        zip.set(CONTENT_TYPES_PART, types(""));
        ensure_content_type_override(&mut zip, "/word/a.xml", "text/a");
        ensure_content_type_override(&mut zip, "/word/a.xml", "text/a");
        ensure_default_content_type(&mut zip, "png", "image/png");
        ensure_default_content_type(&mut zip, "PNG", "image/png");
        let xml = zip.text(CONTENT_TYPES_PART);
        assert_eq!(xml.matches("PartName=\"/word/a.xml\"").count(), 1);
        assert_eq!(xml.matches("Extension=\"png\"").count(), 1);
        assert!(xml.contains("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"png\""));
        remove_content_type_override(&mut zip, "/word/a.xml");
        assert!(!zip.text(CONTENT_TYPES_PART).contains("PartName"));
    }

    #[test]
    fn a_relationship_is_added_with_the_next_id_and_removed_by_id() {
        let mut zip = Package::new();
        zip.set(CONTENT_TYPES_PART, types(""));
        let first = add_package_relationship(&mut zip, "word/_rels/document.xml.rels", "t/image", "media/a & b.png", "");
        let second = add_package_relationship(&mut zip, "word/_rels/document.xml.rels", "t/hyperlink", "https://x.y/", "External");
        assert_eq!((first.as_str(), second.as_str()), ("rId1", "rId2"));
        let rels = zip.text("word/_rels/document.xml.rels");
        assert!(rels.starts_with(XML_HEADER));
        assert!(rels.contains("Target=\"media/a &amp; b.png\"/>"));
        assert!(rels.contains("Target=\"https://x.y/\" TargetMode=\"External\"/>"));
        assert!(zip.text(CONTENT_TYPES_PART).contains("Extension=\"rels\""));
        remove_package_relationship(&mut zip, "word/_rels/document.xml.rels", "rId1");
        assert!(!zip.text("word/_rels/document.xml.rels").contains("rId1"));
        remove_package_relationship(&mut zip, "missing.rels", "rId1");
        assert!(!zip.contains("missing.rels"));
    }

    #[test]
    fn image_headers_give_their_size() {
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&640_u32.to_be_bytes());
        png.extend_from_slice(&480_u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        assert_eq!(image_pixel_size(&png), Some(PixelSize { width: 640, height: 480 }));
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0];
        assert_eq!(image_pixel_size(&jpeg), Some(PixelSize { width: 30, height: 20 }));
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 5, 0, 7, 0, 0, 0];
        assert_eq!(image_pixel_size(&gif), Some(PixelSize { width: 5, height: 7 }));
        assert_eq!(image_pixel_size(b"not an image"), None);
    }

    #[test]
    fn a_citation_keeps_its_label_or_takes_the_language_of_the_source() {
        assert_eq!(provenance_citation(&json!("")), "");
        assert_eq!(provenance_citation(&json!(null)), "");
        assert_eq!(provenance_citation(&json!("  Annual report  ")), "Source: Annual report");
        assert_eq!(provenance_citation(&json!("자료: 운영관리시스템")), "자료: 운영관리시스템");
        assert_eq!(provenance_citation(&json!("운영관리시스템")), "출처: 운영관리시스템");
        assert_eq!(provenance_citation(&json!({ "document": "book", "target": "p4" })), "Source: book#p4");
        assert_eq!(provenance_citation(&json!({ "label": "내부 자료" })), "출처: 내부 자료");
        assert_eq!(provenance_citation(&json!({ "target": "p4" })), "");
        assert_eq!(provenance_citation(&json!(7)), "");
    }

    fn deck() -> Package {
        let mut zip = Package::new();
        zip.set(
            CONTENT_TYPES_PART,
            types("<Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"s\"/><Override PartName=\"/ppt/charts/chart1.xml\" ContentType=\"c\"/>"),
        );
        zip.set("ppt/slides/slide1.xml", "<p:sld/>");
        zip.set(
            "ppt/slides/_rels/slide1.xml.rels",
            "<Relationships><Relationship Id=\"rId1\" Type=\"x/chart\" Target=\"../charts/chart1.xml\"/><Relationship Id=\"rId2\" Type=\"x/image\" Target=\"../media/image1.png\"/></Relationships>",
        );
        zip.set("ppt/charts/chart1.xml", "<c:chart/>");
        zip.set(
            "ppt/charts/_rels/chart1.xml.rels",
            "<Relationships><Relationship Id=\"rId1\" Type=\"x/package\" Target=\"../embeddings/book1.xlsx\"/></Relationships>",
        );
        zip.set("ppt/embeddings/book1.xlsx", vec![1_u8, 2, 3]);
        zip.set("ppt/media/image1.png", vec![9_u8]);
        zip
    }

    #[test]
    fn posix_paths_follow_node() {
        assert_eq!(posix::dirname("a/b/c.xml"), "a/b");
        assert_eq!(posix::dirname("c.xml"), ".");
        assert_eq!(posix::dirname("/c.xml"), "/");
        assert_eq!(posix::dirname("a/b/"), "a");
        assert_eq!(posix::basename("a/b/c.xml"), "c.xml");
        assert_eq!(posix::basename("a/b/"), "b");
        assert_eq!(posix::join(&["ppt/slides", "../media/a.png"]), "ppt/media/a.png");
        assert_eq!(posix::join(&["", "x"]), "x");
        assert_eq!(posix::relative("ppt/slides", "ppt/media/a.png"), "../media/a.png");
        assert_eq!(part_relationship_path("ppt/slides/slide1.xml"), "ppt/slides/_rels/slide1.xml.rels");
        assert_eq!(part_relationship_path("a.xml"), "./_rels/a.xml.rels");
    }
    #[test]
    fn relationships_are_read_and_numbered() {
        let xml = "<Relationships><Relationship Id=\"rId1\" Type=\"t/slide\" Target=\"slides/slide1.xml\"/><Relationship Id=\"rId7\" Type=\"t/theme\" Target=\"theme/theme1.xml\"></Relationship><Relationship Id=\"rId2\" Type=\"t/x\"/></Relationships>";
        let map = relationship_map(xml);
        assert_eq!(map.get("rId1"), Some("slides/slide1.xml"));
        assert_eq!(map.get("rId7"), Some("theme/theme1.xml"));
        assert_eq!(map.get("rId2"), None);
        assert_eq!(next_relationship_id(xml), "rId8");
        assert_eq!(next_relationship_id("<Relationships/>"), "rId1");
        assert_eq!(relationship_target_by_type(xml, "theme"), "theme/theme1.xml");
        assert_eq!(relationship_target_by_type(xml, "chart"), "");
        let targets = relationship_targets_by_type(xml, "ppt/presentation.xml", "slide");
        assert_eq!(targets.iter().collect::<Vec<_>>(), [("rId1", "ppt/slides/slide1.xml")]);
    }
    #[test]
    fn a_relationship_target_resolves_against_its_owner() {
        assert_eq!(relationship_owner("_rels/.rels"), "");
        assert_eq!(relationship_owner("ppt/slides/_rels/slide1.xml.rels"), "ppt/slides/slide1.xml");
        assert_eq!(relationship_target("ppt/slides/_rels/slide1.xml.rels", "../media/a%20b.png#x"), "ppt/media/a b.png");
        assert_eq!(relationship_target("ppt/slides/_rels/slide1.xml.rels", "/ppt/media/a.png"), "ppt/media/a.png");
        assert_eq!(relationship_target("_rels/.rels", "word/document.xml"), "word/document.xml");
        assert_eq!(relationship_target("_rels/.rels", "a%zz.xml"), "a%zz.xml");
    }
    #[test]
    fn a_duplicated_slide_owns_its_chart_and_shares_its_picture() {
        let mut zip = deck();
        let copied = clone_owned_slide_parts(&mut zip, "ppt/slides/_rels/slide1.xml.rels");
        assert_eq!(copied, ["ppt/charts/chart2.xml"]);
        let rels = zip.text("ppt/slides/_rels/slide1.xml.rels");
        assert!(rels.contains("Target=\"../charts/chart2.xml\""));
        assert!(rels.contains("Target=\"../media/image1.png\""));
        assert_eq!(zip.text("ppt/charts/chart2.xml"), "<c:chart/>");
        assert!(zip.text("ppt/charts/_rels/chart2.xml.rels").contains("Target=\"../embeddings/book2.xlsx\""));
        assert_eq!(zip.file("ppt/embeddings/book2.xlsx"), Some(&[1_u8, 2, 3][..]));
        assert!(zip.text(CONTENT_TYPES_PART).contains("PartName=\"/ppt/charts/chart2.xml\" ContentType=\"c\""));
    }
    #[test]
    fn imported_relationships_point_at_this_decks_copies_and_drop_notes() {
        let source = deck();
        let mut target = Package::new();
        target.set(CONTENT_TYPES_PART, types(""));
        let relationships = "<Relationships><Relationship Id=\"rId1\" Type=\"x/chart\" Target=\"../charts/chart1.xml\"/><Relationship Id=\"rId2\" Type=\"x/notesSlide\" Target=\"../notesSlides/notesSlide1.xml\"/></Relationships>";
        let mut cache = HashMap::new();
        let rewritten =
            rewrite_imported_relationships(&source, &mut target, "ppt/slides/slide1.xml", "ppt/slides/slide3.xml", relationships, &mut cache).unwrap();
        assert_eq!(rewritten, "<Relationships><Relationship Id=\"rId1\" Type=\"x/chart\" Target=\"../charts/chart1.xml\"/></Relationships>");
        assert_eq!(target.text("ppt/charts/chart1.xml"), "<c:chart/>");
        assert_eq!(target.file("ppt/embeddings/book1.xlsx"), Some(&[1_u8, 2, 3][..]));
        let layout = "<Relationships><Relationship Id=\"rId1\" Type=\"x/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/></Relationships>";
        let mut layouts = deck();
        layouts.set("ppt/slideLayouts/slideLayout1.xml", "<p:sldLayout/>");
        let refused = rewrite_imported_relationships(&layouts, &mut target, "ppt/slides/slide1.xml", "ppt/slides/slide3.xml", layout, &mut HashMap::new());
        assert_eq!(
            refused.unwrap_err(),
            "import_slides cannot place the layout of ppt/slideLayouts/slideLayout1.xml: this presentation has no slide master to adopt it"
        );
    }
    #[test]
    fn a_missing_source_part_is_named() {
        let source = Package::new();
        let mut target = Package::new();
        let relationships = "<Relationships><Relationship Id=\"rId1\" Type=\"x/image\" Target=\"../media/none.png\"/></Relationships>";
        let result = rewrite_imported_relationships(&source, &mut target, "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", relationships, &mut HashMap::new());
        assert_eq!(result.unwrap_err(), "import_slides source package is missing ppt/media/none.png");
    }
}

/// `relationshipTargetsByType(relationshipsXml, owner, type)`: every relationship of one type, as its Id and the package
/// path it points at (a Target is written relative to the owning part unless it starts at the package root).
pub fn relationship_targets_by_type(relationships_xml: &str, owner: &str, relationship_type: &str) -> RelationshipMap {
    let mut targets = RelationshipMap::default();
    let suffix = format!("/{relationship_type}");
    for found in RELATIONSHIP_ANY.captures_iter(relationships_xml) {
        let attributes = found.get(1).unwrap_or("");
        if !xml_attribute(attributes, "Type").ends_with(&suffix) {
            continue;
        }
        let id = xml_attribute(attributes, "Id");
        let target = xml_attribute(attributes, "Target");
        if id.is_empty() || target.is_empty() {
            continue;
        }
        targets.set(&id, &part_from_target(&posix::dirname(owner), &target));
    }
    targets
}
/// `partFromTarget(directory, target)`: the part a relationship target names: absolute from the package root, relative
/// from the directory of the part that declares it.
pub fn part_from_target(directory: &str, target: &str) -> String {
    match target.strip_prefix('/') {
        Some(rooted) => rooted.to_owned(),
        None => posix::normalize(&posix::join(&[directory, target])),
    }
}
/// `importPartTree(source, zip, sourcePath, cache)`: a part of another package copied in with the parts it points at;
/// a part this package already holds byte for byte is reused.
fn import_part_tree(source: &Package, zip: &mut Package, source_path: &str, cache: &mut HashMap<String, String>) -> Result<String, String> {
    if let Some(known) = cache.get(source_path) {
        return Ok(known.clone());
    }
    let Some(data) = source.file(source_path) else {
        return Err(format!("import_slides source package is missing {source_path}"));
    };
    let data = data.to_vec();
    let digest = sha1_hex(&data);
    let directory = posix::dirname(source_path);
    let (prefix, extension) = part_naming(source_path);
    let sibling = compiled(&format!("^{}/{}\\d*\\.{}$", tag_pattern(&directory), tag_pattern(&prefix), tag_pattern(&extension)), "i");
    let reused = find_matching_part(zip, &sibling, &digest);
    if !reused.is_empty() {
        cache.insert(source_path.to_owned(), reused.clone());
        return Ok(reused);
    }
    let target_path = next_available_part(zip, &directory, &prefix, &extension);
    zip.set(&target_path, data);
    cache.insert(source_path.to_owned(), target_path.clone());
    copy_part_content_type(source, zip, source_path, &target_path);
    let relationships = source.text(&part_relationship_path(source_path));
    if !relationships.is_empty() {
        let rewritten = rewrite_imported_relationships(source, zip, source_path, &target_path, &relationships, cache)?;
        zip.set(&part_relationship_path(&target_path), rewritten);
    }
    Ok(target_path)
}
/// `clonePartTree(zip, sourcePath, cache)`: a part and the parts it owns inside the same package, always as new parts: a
/// duplicated slide that keeps pointing at the original chart makes an edit to one page silently rewrite the other.
fn clone_part_tree(zip: &mut Package, source_path: &str, cache: &mut HashMap<String, String>) -> String {
    if let Some(known) = cache.get(source_path) {
        return known.clone();
    }
    let Some(data) = zip.file(source_path) else { return String::new() };
    let data = data.to_vec();
    let directory = posix::dirname(source_path);
    let (prefix, extension) = part_naming(source_path);
    let target_path = next_available_part(zip, &directory, &prefix, &extension);
    zip.set(&target_path, data);
    cache.insert(source_path.to_owned(), target_path.clone());
    let rule = content_type_rule(&zip.text(CONTENT_TYPES_PART), source_path);
    apply_content_type(zip, rule, &target_path);
    let relationships = zip.text(&part_relationship_path(source_path));
    if relationships.is_empty() {
        return target_path;
    }
    let mut output = relationships.clone();
    for relationship in internal_relationships(&relationships) {
        if SHARED_ON_CLONE.is_match(&xml_attribute(&relationship.block, "Type")) {
            continue;
        }
        let absolute = relationship.target.starts_with('/');
        let cloned = clone_part_tree(zip, &part_from_target(&directory, &relationship.target), cache);
        if cloned.is_empty() {
            continue;
        }
        let rewritten = if absolute { format!("/{cloned}") } else { posix::relative(&posix::dirname(&target_path), &cloned) };
        output = rewrite_target(&output, &relationship.block, &relationship.raw, &rewritten);
    }
    zip.set(&part_relationship_path(&target_path), output);
    target_path
}
/// `cloneOwnedSlideParts(zip, relationshipsPath)`: the relationships a copied slide must own outright before it is
/// editable on its own (everything else stays shared with the slide it was copied from); the parts copied.
pub fn clone_owned_slide_parts(zip: &mut Package, relationships_path: &str) -> Vec<String> {
    let xml = zip.text(relationships_path);
    if xml.is_empty() {
        return Vec::new();
    }
    let owner = posix::dirname(&posix::dirname(relationships_path));
    let mut cache = HashMap::new();
    let mut copied = Vec::new();
    let mut output = xml.clone();
    for relationship in internal_relationships(&xml) {
        // A slide's comments are its own too: two slides pointing at one comments part are a file PowerPoint refuses as
        // corrupted, and PowerPoint's Duplicate copies them with the slide.
        if !OWNED_BY_SLIDE.is_match(&xml_attribute(&relationship.block, "Type")) {
            continue;
        }
        let absolute = relationship.target.starts_with('/');
        let cloned = clone_part_tree(zip, &part_from_target(&owner, &relationship.target), &mut cache);
        if cloned.is_empty() {
            continue;
        }
        let rewritten = if absolute { format!("/{cloned}") } else { posix::relative(&owner, &cloned) };
        copied.push(cloned);
        output = rewrite_target(&output, &relationship.block, &relationship.raw, &rewritten);
    }
    if !copied.is_empty() {
        zip.set(relationships_path, output);
    }
    copied
}
/// The layout of an imported page, its relationships re-targeted at this deck's copies of the parts. The layout answers
/// to this deck's master, which is what keeps one theme over every page instead of two masters fighting for the deck.
fn remap_layout_relationships(
    source: &Package,
    zip: &mut Package,
    layout_path: &str,
    target_path: &str,
    master: &str,
    cache: &mut HashMap<String, String>,
) -> Result<(), String> {
    let relationships = source.text(&part_relationship_path(layout_path));
    if relationships.is_empty() {
        return Ok(());
    }
    let mut output = relationships.clone();
    for relationship in internal_relationships(&relationships) {
        let resolved = part_from_target(&posix::dirname(layout_path), &relationship.target);
        let mapped = if xml_attribute(&relationship.block, "Type").ends_with("/slideMaster") {
            master.to_owned()
        } else {
            import_part_tree(source, zip, &resolved, cache)?
        };
        if mapped.is_empty() {
            continue;
        }
        output = retarget(&output, &relationship.block, &posix::relative(&posix::dirname(target_path), &mapped));
    }
    zip.set(&part_relationship_path(target_path), output);
    Ok(())
}
/// `registerLayoutOnMaster`: lists the layout on the master, where PowerPoint reads the deck's layouts from.
fn register_layout_on_master(zip: &mut Package, master: &str, target_path: &str) {
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(master),
        &format!("{OFFICE_RELATIONSHIP_BASE}/slideLayout"),
        &posix::relative(&posix::dirname(master), target_path),
        "",
    );
    let master_xml = zip.text(master);
    static LAYOUT_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<p:sldLayoutId\b[^>]*\bid="(\d+)""#, "g"));
    let highest =
        LAYOUT_ID.captures_iter(&master_xml).map(|found| mixdog_js::string_to_number(found.get(1).unwrap_or(""))).fold(FIRST_SLIDE_LAYOUT_ID, f64::max);
    let entry = format!("<p:sldLayoutId id=\"{}\" r:id=\"{relationship_id}\"/>", number_to_string(highest + 1.0));
    let next = if master_xml.contains("</p:sldLayoutIdLst>") {
        replace_first(&master_xml, "</p:sldLayoutIdLst>", &format!("{entry}</p:sldLayoutIdLst>"))
    } else {
        static COLOUR_MAP: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(<p:clrMap\b[^>]*\/>)", ""));
        match COLOUR_MAP.find(&master_xml) {
            Some(range) => format!("{}<p:sldLayoutIdLst>{entry}</p:sldLayoutIdLst>{}", &master_xml[..range.end], &master_xml[range.end..]),
            None => master_xml,
        }
    };
    zip.set(master, next);
}

fn adopt_imported_layout(source: &Package, zip: &mut Package, layout_path: &str, cache: &mut HashMap<String, String>) -> Result<String, String> {
    static MASTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^ppt\/slideMasters\/slideMaster\d+\.xml$", ""));
    let mut masters: Vec<String> = zip.names().into_iter().filter(|name| MASTER.is_match(name)).collect();
    masters.sort();
    let (Some(master), Some(layout)) = (masters.into_iter().next(), source.file(layout_path)) else {
        return Ok(String::new());
    };
    let layout = layout.to_vec();
    let target_path = next_available_part(zip, "ppt/slideLayouts", "slideLayout", "xml");
    zip.set(&target_path, layout);
    cache.insert(layout_path.to_owned(), target_path.clone());
    copy_part_content_type(source, zip, layout_path, &target_path);
    remap_layout_relationships(source, zip, layout_path, &target_path, &master, cache)?;
    register_layout_on_master(zip, &master, &target_path);
    Ok(target_path)
}
/// `rewriteImportedRelationships(source, zip, sourceOwner, targetOwner, relationships, cache)`: the relationships of a
/// part imported from another package, re-targeted at the copies in this one. A slide's notes are not carried; a
/// relationship to a slide not imported is dropped; a layout is matched to this deck's or adopted.
pub fn rewrite_imported_relationships(
    source: &Package,
    zip: &mut Package,
    source_owner: &str,
    target_owner: &str,
    relationships: &str,
    cache: &mut HashMap<String, String>,
) -> Result<String, String> {
    let source_directory = posix::dirname(source_owner);
    let target_directory = posix::dirname(target_owner);
    let mut output = relationships.to_owned();
    for relationship in internal_relationships(relationships) {
        let relationship_type = xml_attribute(&relationship.block, "Type");
        let resolved = part_from_target(&source_directory, &relationship.target);
        if relationship_type.ends_with("/notesSlide") {
            output = replace_first(&output, &relationship.block, "");
            continue;
        }
        let mapped = if relationship_type.ends_with("/slideLayout") {
            static LAYOUT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$", ""));
            let mut mapped = find_matching_part(zip, &LAYOUT, &part_digest(source, &resolved));
            if mapped.is_empty() {
                mapped = adopt_imported_layout(source, zip, &resolved, cache)?;
            }
            if mapped.is_empty() {
                return Err(format!("import_slides cannot place the layout of {resolved}: this presentation has no slide master to adopt it"));
            }
            mapped
        } else if relationship_type.ends_with("/slide") {
            let mapped = cache.get(&format!("slide:{resolved}")).cloned().unwrap_or_default();
            if mapped.is_empty() {
                output = replace_first(&output, &relationship.block, "");
                continue;
            }
            mapped
        } else {
            import_part_tree(source, zip, &resolved, cache)?
        };
        output = retarget(&output, &relationship.block, &posix::relative(&target_directory, &mapped));
    }
    Ok(output)
}
/// `relationshipTarget(relPath, target)`: the package path a Target of a rels part names (the fragment and query cut, a
/// percent escape decoded, a malformed one kept as written).
pub fn relationship_target(rel_path: &str, target: &str) -> String {
    let decoded_entities = xml_decode(target);
    let without_fragment = decoded_entities.split('#').next().unwrap_or("");
    let without_query = without_fragment.split('?').next().unwrap_or("");
    let decoded = decode_uri_component(without_query).unwrap_or_else(|| without_query.to_owned());
    let owner = relationship_owner(rel_path);
    let base = if owner.is_empty() { String::new() } else { posix::dirname(&owner) };
    match decoded.strip_prefix('/') {
        Some(rooted) => posix::normalize(rooted),
        None => posix::normalize(&posix::join(&[&base, &decoded])),
    }
}
