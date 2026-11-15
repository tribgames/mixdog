//! `portable/portable-snapshot-docx.mjs`: the Word document read model (paragraphs with their formats, runs, tables, comments
//! with their threads, revisions, sections, numbering, headers and footers, pictures), the body model the docx writers build
//! on ([`docx_body_model`]) and the block append ([`append_docx_block`]). The snapshot is a JSON value equal to Node's, key
//! for key and in Node's key order, with absent keys kept apart from null ones.
//!
//! Offsets are byte offsets into the part searched; the one offset the snapshot reports (`blockOrder[].start`) is written in
//! UTF-16 units, as Node counts them.

use std::collections::{HashMap, HashSet};

use mixdog_js::{js_to_lowercase, json_number, math, string_to_number, to_number_of, utf16_len, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::docx_revisions::{RevisionKind, count_docx_property_changes, docx_revision_tree, flatten_docx_revisions};
use crate::opc::relationship_map;
use crate::snapshot_shared::{docx_paragraph_spacing, docx_run_font, next_page_offset, soft_break_facts, stated_run_font};
use crate::xml::{
    Container, block_text, compiled, container_inner, settings_track_changes, tag_pattern, text_nodes, top_level_elements,
    trailing_section_pattern, xml_attribute, xml_decode,
};
use crate::zipio::Package;

const TWIPS_PER_POINT: f64 = 20.0;

fn revision_type(tag: &str) -> &'static str {
    match tag {
        "ins" => "insertion",
        "del" => "deletion",
        "moveFrom" => "moved_from",
        _ => "moved_to",
    }
}

/// The first capture group of the first match.
fn first(pattern: &str, text: &str) -> Option<String> {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `xmlDecode(/pattern/.exec(text)?.[1] || '')`.
fn decoded(pattern: &str, text: &str) -> String {
    xml_decode(&first(pattern, text).unwrap_or_default())
}

/// The tracked-change wrappers `paragraphMarkup` and `cellMarkup` look for.
fn has_tracked_changes(xml: &str) -> bool {
    compiled(r"<w:(?:ins|del|moveFrom|moveTo)\b", "").is_match(xml)
}

/// What a paragraph carries beyond its text: list membership (numId 0 means "no numbering" in Word) and whether tracked
/// changes touch it. `text` is the accepted view (`w:t` only); the words a reviewer still sees struck through are listed
/// beside it, and so are the words of a hidden run, which stay in the file although the page does not show them.
fn paragraph_markup(paragraph_xml: &str, into: &mut Map<String, Value>) {
    let numbering = first(r"<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>", paragraph_xml).unwrap_or_default();
    let num_id = if numbering.is_empty() {
        f64::NAN
    } else {
        first(r#"<w:numId\b[^>]*\bw:val="(-?\d+)""#, &numbering).map_or(f64::NAN, |digits| string_to_number(&digits))
    };
    let tracked = has_tracked_changes(paragraph_xml);
    let deleted_text = if tracked { block_text(paragraph_xml, "w:delText") } else { String::new() };
    let hidden_text = if compiled(r"<w:vanish\b", "").is_match(paragraph_xml) {
        let properties = compiled(r"<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>", "");
        let vanished = compiled(r#"<w:vanish\b(?![^>]*\bw:val="(?:false|0)")"#, "");
        compiled(r"<w:r\b(?:\s[^>]*)?>[\s\S]*?<\/w:r>", "g")
            .find_iter(paragraph_xml)
            .map(|range| &paragraph_xml[range])
            .filter(|run| vanished.is_match(properties.find(run).map_or("", |found| &run[found])))
            .map(|run| block_text(run, "w:t"))
            .collect::<String>()
    } else {
        String::new()
    };
    if num_id.is_finite() && num_id > 0.0 {
        let level = first(r#"<w:ilvl\b[^>]*\bw:val="(\d+)""#, &numbering).map_or(0.0, |digits| string_to_number(&digits));
        let level = if level.is_nan() { 0.0 } else { level };
        into.insert("list".to_owned(), json!({ "numId": json_number(num_id), "level": json_number(level) }));
    }
    if tracked {
        into.insert("tracked".to_owned(), Value::Bool(true));
    }
    if !deleted_text.is_empty() {
        into.insert("deletedText".to_owned(), Value::String(deleted_text));
    }
    if !hidden_text.is_empty() {
        into.insert("hiddenText".to_owned(), Value::String(hidden_text));
    }
}

/// Tracked changes touching a table cell, reported the way a paragraph's are so a reviewer reads table edits alike.
fn cell_markup(cell_xml: &str, into: &mut Map<String, Value>) {
    if !has_tracked_changes(cell_xml) {
        return;
    }
    into.insert("tracked".to_owned(), Value::Bool(true));
    let deleted_text = block_text(cell_xml, "w:delText");
    if !deleted_text.is_empty() {
        into.insert("deletedText".to_owned(), Value::String(deleted_text));
    }
}

/// `{...object}`: the entries of an object value appended in order (a replaced key keeps its place).
fn spread(into: &mut Map<String, Value>, object: Value) {
    if let Value::Object(entries) = object {
        for (key, value) in entries {
            into.insert(key, value);
        }
    }
}

fn paragraph_record(block_xml: &str, paragraph_index: usize) -> Value {
    let runs: Vec<Value> = text_nodes(block_xml, "w:t")
        .into_iter()
        .enumerate()
        .map(|(index, node)| {
            json!({
                "path": format!("/body/p[{paragraph_index}]/run[{}]", index + 1),
                "index": index + 1,
                "text": node.text,
            })
        })
        .collect();
    let mut record = Map::new();
    record.insert("path".to_owned(), Value::String(format!("/body/p[{paragraph_index}]")));
    record.insert("index".to_owned(), Value::from(paragraph_index));
    // Word numbers every paragraph in the document, table cells included; this model walks body blocks only, and says so.
    record.insert("inTable".to_owned(), Value::Bool(false));
    record.insert("text".to_owned(), Value::String(block_text(block_xml, "w:t")));
    // A paragraph carrying no explicit style is Normal in Word and in the Office reader.
    let style = first(r#"<w:pStyle\b[^>]*\bw:val="([^"]+)""#, block_xml).unwrap_or_else(|| "Normal".to_owned());
    record.insert("style".to_owned(), Value::String(xml_decode(&style)));
    // What the paragraph's own runs state; `apply_style_fonts` fills in what its style says when they state nothing.
    spread(&mut record, stated_run_font(block_xml));
    let spacing = docx_paragraph_spacing(block_xml);
    if spacing.as_object().is_some_and(|entries| !entries.is_empty()) {
        record.insert("format".to_owned(), spacing);
    }
    // A soft break reads back as a newline like a typed one does, but Word draws it as a line break instead of a space.
    spread(&mut record, soft_break_facts(block_xml));
    record.insert("runs".to_owned(), Value::Array(runs));
    paragraph_markup(block_xml, &mut record);
    Value::Object(record)
}

fn table_record(block_xml: &str, table_index: usize) -> Value {
    let table_inner = container_inner(block_xml, "w:tbl", 0).map(|container| container.inner).unwrap_or_default();
    let rows: Vec<Value> = top_level_elements(&table_inner, &["w:tr"])
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let row_inner = container_inner(&row.xml, "w:tr", 0).map(|container| container.inner).unwrap_or_default();
            let cells: Vec<Value> = top_level_elements(&row_inner, &["w:tc"])
                .iter()
                .enumerate()
                .map(|(cell_index, cell)| {
                    let mut record = Map::new();
                    record.insert("path".to_owned(), Value::String(format!("/body/tbl[{table_index}]/row[{}]/cell[{}]", row_index + 1, cell_index + 1)));
                    record.insert("index".to_owned(), Value::from(cell_index + 1));
                    record.insert("text".to_owned(), Value::String(block_text(&cell.xml, "w:t")));
                    // The cell's own type, as the review reads a paragraph's.
                    spread(&mut record, stated_run_font(&cell.xml));
                    cell_markup(&cell.xml, &mut record);
                    Value::Object(record)
                })
                .collect();
            json!({
                "path": format!("/body/tbl[{table_index}]/row[{}]", row_index + 1),
                "index": row_index + 1,
                "cells": cells,
            })
        })
        .collect();
    // Word falls back to TableNormal when a table declares no style, which is what the Office reader reports.
    let style = first(r#"<w:tblStyle\b[^>]*\bw:val="([^"]+)""#, block_xml).unwrap_or_else(|| "TableNormal".to_owned());
    json!({
        "path": format!("/body/tbl[{table_index}]"),
        "index": table_index,
        "style": xml_decode(&style),
        "rows": rows,
    })
}

/// One top-level paragraph or table of a body, where it lies in the body's content and its place among the paragraphs or
/// the tables.
#[derive(Debug, Clone)]
pub struct BodyBlock {
    /// `w:p` or `w:tbl`.
    pub name: String,
    pub start: usize,
    pub end: usize,
    pub xml: String,
    /// The 1-based place among the paragraphs (for `w:p`) or among the tables (for `w:tbl`).
    pub logical_index: usize,
}

impl BodyBlock {
    fn is_paragraph(&self) -> bool {
        self.name == "w:p"
    }
}

/// What [`docx_body_model`] reads: the paragraph and table records (JSON values the later steps add to), the blocks in body
/// order and the body's content (`None` when the document has no body).
#[derive(Debug, Clone)]
pub struct DocxBodyModel {
    pub paragraphs: Vec<Value>,
    pub tables: Vec<Value>,
    pub blocks: Vec<BodyBlock>,
    pub body: Option<Container>,
}

/// `docxBodyModel(documentXml)`.
pub fn docx_body_model(document_xml: &str) -> DocxBodyModel {
    let Some(body) = container_inner(document_xml, "w:body", 0) else {
        return DocxBodyModel { paragraphs: Vec::new(), tables: Vec::new(), blocks: Vec::new(), body: None };
    };
    let mut paragraphs = Vec::new();
    let mut tables = Vec::new();
    let mut blocks = Vec::new();
    for element in top_level_elements(&body.inner, &["w:p", "w:tbl"]) {
        let logical_index = if element.name == "w:p" {
            paragraphs.push(paragraph_record(&element.xml, paragraphs.len() + 1));
            paragraphs.len()
        } else {
            tables.push(table_record(&element.xml, tables.len() + 1));
            tables.len()
        };
        blocks.push(BodyBlock { name: element.name, start: element.start, end: element.end, xml: element.xml, logical_index });
    }
    DocxBodyModel { paragraphs, tables, blocks, body: Some(body) }
}

/// `appendDocxBlock(documentXml, block)`: the block placed at the end of the body's content, before the document's own
/// trailing section properties. Appending reads the body's tail, never its whole model.
pub fn append_docx_block(document_xml: &str, block: &str) -> Result<String, String> {
    let body = container_inner(document_xml, "w:body", 0).ok_or_else(|| "DOCX document body is missing".to_owned())?;
    let trailing = trailing_section_pattern().find(&body.inner);
    let content = trailing.map_or(body.inner.as_str(), |range| &body.inner[..range.start]);
    let rest = &body.inner[content.len()..];
    let before = &document_xml[..body.start];
    let after = &document_xml[body.end..];
    // A fresh file's single empty paragraph is the one case that needs the blocks, and there is exactly one of them.
    let only_empty_paragraph = utf16_len(content) < 2000
        && compiled(r"<w:p\b", "g").find_iter(content).count() == 1
        && !compiled(r"<w:tbl\b", "").is_match(content)
        && !compiled(r"<w:t[ >]", "").is_match(content)
        && !compiled(r"<w:drawing\b", "").is_match(content);
    if only_empty_paragraph {
        return Ok(format!("{before}{block}{rest}{after}"));
    }
    // The empty paragraph that closes a table at the end of the body is where the next paragraph goes, as typing after a
    // table in Word fills it; a table keeps it as the paragraph between the two, or they would join into one.
    let closed = compiled(r"<\/w:tbl>\s*<w:p\/>\s*$", "").is_match(content);
    if closed && compiled(r"^<w:p[\s>]", "").is_match(block) {
        let kept = &content[..content.rfind("<w:p/>").unwrap_or(0)];
        return Ok(format!("{before}{kept}{block}{rest}{after}"));
    }
    Ok(format!("{before}{content}{block}{rest}{after}"))
}

const ADJACENT_TABLES: &str = r"<\/w:tbl>(\s*)(?=<w:tbl[\s>])";

/// `hasAdjacentTables(documentXml)`: two tables with nothing between them are one table to Word and LibreOffice.
pub fn has_adjacent_tables(document_xml: &str) -> bool {
    compiled(ADJACENT_TABLES, "").is_match(document_xml)
}

/// `separateAdjacentTables(documentXml)`: an empty paragraph keeps two tables that meet apart.
pub fn separate_adjacent_tables(document_xml: &str) -> String {
    compiled(ADJACENT_TABLES, "g").replace_all_with(document_xml, |found| format!("</w:tbl>{}<w:p/>", found.get(1).unwrap_or("")))
}

/// `closeTrailingTable(documentXml)`: a body that ends in a table carries a paragraph after it, as Word writes every
/// document.
pub fn close_trailing_table(document_xml: &str) -> String {
    let Some(body) = container_inner(document_xml, "w:body", 0) else { return document_xml.to_owned() };
    let trailing = trailing_section_pattern().find(&body.inner);
    let content = trailing.map_or(body.inner.as_str(), |range| &body.inner[..range.start]);
    if !compiled(r"<\/w:tbl>\s*$", "").is_match(content) {
        return document_xml.to_owned();
    }
    format!("{}{content}<w:p/>{}{}", &document_xml[..body.start], &body.inner[content.len()..], &document_xml[body.end..])
}

/// One `w15:commentEx` record: a comment thread's state.
struct ThreadRecord {
    para_id: String,
    parent_para_id: String,
    resolved: bool,
}

/// Word keeps a thread's state beside the comments: whether it was marked resolved, and which comment a reply answers.
fn comment_thread_records(comments_extended_xml: &str) -> Vec<ThreadRecord> {
    compiled(r"<w15:commentEx\b([^>]*?)\/?>", "g")
        .captures_iter(comments_extended_xml)
        .map(|found| {
            let attributes = found.get(1).unwrap_or("");
            ThreadRecord {
                para_id: xml_decode(&xml_attribute(attributes, "w15:paraId")),
                parent_para_id: xml_decode(&xml_attribute(attributes, "w15:paraIdParent")),
                resolved: compiled(r"^(?:1|true)$", "i").is_match(&xml_attribute(attributes, "w15:done")),
            }
        })
        .collect()
}

const COMMENT_PATTERN: &str = r"<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>";

/// The paragraph ids each comment carries (by the comment's id, in first-seen order), and the comment id each paragraph id
/// belongs to: a thread record names paragraphs, and a reply names its parent's paragraph.
fn comment_para_ids(comments_xml: &str) -> (Vec<(String, Vec<String>)>, HashMap<String, String>) {
    let mut para_ids_by_id: Vec<(String, Vec<String>)> = Vec::new();
    for found in compiled(COMMENT_PATTERN, "g").captures_iter(comments_xml) {
        let id = decoded(r#"\bw:id="([^"]+)""#, found.get(1).unwrap_or(""));
        let paragraphs: Vec<String> = compiled(r"<w:p\b([^>]*)", "g")
            .captures_iter(found.get(2).unwrap_or(""))
            .map(|entry| xml_attribute(entry.get(1).unwrap_or(""), "w14:paraId").to_uppercase())
            .filter(|para_id| !para_id.is_empty())
            .collect();
        if id.is_empty() || paragraphs.is_empty() {
            continue;
        }
        match para_ids_by_id.iter_mut().find(|(known, _)| *known == id) {
            Some(entry) => entry.1 = paragraphs,
            None => para_ids_by_id.push((id, paragraphs)),
        }
    }
    let mut id_by_para_id = HashMap::new();
    for (id, paragraphs) in &para_ids_by_id {
        for para_id in paragraphs {
            id_by_para_id.insert(para_id.clone(), id.clone());
        }
    }
    (para_ids_by_id, id_by_para_id)
}

/// The thread facts a comment carries: whether it is resolved, and the comment it replies to (by the id the snapshot
/// reports, not Word's internal paraId).
fn comment_thread(threads: &HashMap<String, usize>, records: &[ThreadRecord], para_ids: &[String], id_by_para_id: &HashMap<String, String>) -> Map<String, Value> {
    let mut facts = Map::new();
    let Some(entry) = para_ids.iter().find_map(|para_id| threads.get(para_id)).map(|&at| &records[at]) else { return facts };
    let reply_to = if entry.parent_para_id.is_empty() {
        String::new()
    } else {
        id_by_para_id.get(&entry.parent_para_id.to_uppercase()).cloned().unwrap_or_default()
    };
    if entry.resolved {
        facts.insert("resolved".to_owned(), Value::Bool(true));
    }
    if !reply_to.is_empty() {
        facts.insert("replyTo".to_owned(), Value::String(reply_to));
    }
    facts
}

/// The words a comment is anchored to, from the first story part that carries both ends of its range.
fn comment_anchor(story_xml: &[(String, String)], id: &str) -> (String, String) {
    let escaped = tag_pattern(id);
    let start_pattern = compiled(&format!(r#"<w:commentRangeStart\b[^>]*\bw:id="{escaped}"[^>]*/?>"#), "");
    let end_pattern = compiled(&format!(r#"<w:commentRangeEnd\b[^>]*\bw:id="{escaped}"[^>]*/?>"#), "");
    for (part, xml) in story_xml {
        let (Some(start), Some(end)) = (start_pattern.find(xml), end_pattern.find(xml)) else { continue };
        if end.start < start.start {
            continue;
        }
        return (block_text(xml.get(start.end..end.start).unwrap_or(""), "w:t"), part.clone());
    }
    (String::new(), String::new())
}

/// A reply inherits the state of the thread it belongs to: Word shows the whole thread as resolved when its first comment
/// is marked done.
fn inherit_thread_resolution(comments: &mut [Value]) {
    let mut thread_root: HashMap<String, usize> = HashMap::new();
    for (at, comment) in comments.iter().enumerate() {
        thread_root.insert(comment["id"].as_str().unwrap_or("").to_owned(), at);
    }
    for at in 0..comments.len() {
        let Some(reply_to) = comments[at].get("replyTo").and_then(Value::as_str).map(str::to_owned) else { continue };
        let mut root = thread_root.get(&reply_to).copied();
        let mut depth = 0;
        while depth < 20 {
            let Some(next) = root.and_then(|found| comments[found].get("replyTo")).and_then(Value::as_str).filter(|id| !id.is_empty()) else { break };
            root = thread_root.get(next).copied();
            depth += 1;
        }
        if root.is_some_and(|found| comments[found].get("resolved").is_some_and(truthy)) {
            comments[at]["resolved"] = Value::Bool(true);
        }
    }
}

fn docx_comments(story_xml: &[(String, String)], comments_xml: &str, comments_extended_xml: &str) -> (Vec<Value>, Vec<ThreadRecord>) {
    let records = comment_thread_records(comments_extended_xml);
    let mut threads: HashMap<String, usize> = HashMap::new();
    for (at, record) in records.iter().enumerate() {
        if !record.para_id.is_empty() {
            threads.insert(record.para_id.to_uppercase(), at);
        }
    }
    let (para_ids_by_id, id_by_para_id) = comment_para_ids(comments_xml);
    let mut comments: Vec<Value> = Vec::new();
    for found in compiled(COMMENT_PATTERN, "g").captures_iter(comments_xml) {
        let attributes = found.get(1).unwrap_or("");
        let id = decoded(r#"\bw:id="([^"]+)""#, attributes);
        let mut comment = Map::new();
        comment.insert("path".to_owned(), Value::String(format!("/body/comment[{}]", comments.len() + 1)));
        comment.insert("index".to_owned(), Value::from(comments.len() + 1));
        comment.insert("id".to_owned(), Value::String(id.clone()));
        comment.insert("author".to_owned(), Value::String(decoded(r#"\bw:author="([^"]*)""#, attributes)));
        comment.insert("initials".to_owned(), Value::String(decoded(r#"\bw:initials="([^"]*)""#, attributes)));
        comment.insert("date".to_owned(), Value::String(decoded(r#"\bw:date="([^"]*)""#, attributes)));
        comment.insert("text".to_owned(), Value::String(block_text(found.get(2).unwrap_or(""), "w:t")));
        let (anchored_text, part) = comment_anchor(story_xml, &id);
        comment.insert("anchoredText".to_owned(), Value::String(anchored_text));
        comment.insert("part".to_owned(), Value::String(part));
        let own_para_ids = para_ids_by_id.iter().find(|(known, _)| *known == id).map(|(_, ids)| ids.as_slice()).unwrap_or(&[]);
        for (key, value) in comment_thread(&threads, &records, own_para_ids, &id_by_para_id) {
            comment.insert(key, value);
        }
        comments.push(Value::Object(comment));
    }
    inherit_thread_resolution(&mut comments);
    (comments, records)
}

/// The pictures a Word story carries, as a Word session reports them: the name, the description a reader who cannot see it
/// is given, and the placed size in points. One reading serves the snapshot and the accessibility audit.
pub fn docx_pictures(xml: &str) -> Vec<Value> {
    let mut pictures = Vec::new();
    for range in compiled(r"<w:drawing\b[\s\S]*?<\/w:drawing>", "g").find_iter(xml) {
        let drawing = &xml[range];
        if !compiled(r"<pic:pic[\s>]", "").is_match(drawing) {
            continue;
        }
        let properties = compiled(r"<wp:docPr\b[^>]*>", "").find(drawing).map_or("", |found| &drawing[found]);
        let extent = compiled(r#"<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "").captures(drawing);
        let points = |group: usize| match &extent {
            Some(found) => json_number(math::round(string_to_number(found.get(group).unwrap_or("")) / 127.0) / 100.0),
            None => Value::from(0),
        };
        pictures.push(json!({
            "name": decoded(r#"\bname="([^"]*)""#, properties),
            "altText": decoded(r#"\bdescr="([^"]*)""#, properties),
            "width": points(1),
            "height": points(2),
        }));
    }
    pictures
}

/// The id and the name of each paragraph style whose name differs from its id. A localized Word writes its built-in styles
/// under ids of its own (Korean Word saves "heading 2" as `w:styleId="2"`), so the id alone names no heading; the style's
/// name travels beside its id when the two differ.
fn apply_style_names(model: &mut DocxBodyModel, styles_xml: &str) {
    if styles_xml.is_empty() {
        return;
    }
    let mut names: HashMap<String, String> = HashMap::new();
    let whitespace = compiled(r"\s+", "g");
    for found in compiled(r"<w:style\b([^>]*)>([\s\S]*?)<\/w:style>", "g").captures_iter(styles_xml) {
        let id = decoded(r#"\bw:styleId="([^"]+)""#, found.get(1).unwrap_or(""));
        let name = decoded(r#"<w:name\b[^>]*\bw:val="([^"]+)""#, found.get(2).unwrap_or(""));
        if !id.is_empty() && !name.is_empty() && js_to_lowercase(&whitespace.replace_all_with(&name, |_| String::new())) != js_to_lowercase(&id) {
            names.insert(id, name);
        }
    }
    for paragraph in &mut model.paragraphs {
        let name = paragraph.get("style").and_then(Value::as_str).and_then(|style| names.get(style)).cloned();
        if let (Some(name), Some(record)) = (name, paragraph.as_object_mut()) {
            record.insert("styleName".to_owned(), Value::String(name));
        }
    }
}

/// The type a style or the document defaults state (`docxRunFont`).
#[derive(Debug, Clone, Default)]
struct StyleFont {
    size: f64,
    bold: bool,
    name: String,
    color: Option<String>,
    caps: Option<bool>,
    letter_spacing: Option<f64>,
}

impl StyleFont {
    fn of(xml: &str) -> Self {
        let font = docx_run_font(xml);
        Self {
            size: font.get("size").and_then(Value::as_f64).unwrap_or(0.0),
            bold: font.get("bold").and_then(Value::as_bool).unwrap_or(false),
            name: font.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
            color: font.get("color").and_then(Value::as_str).filter(|color| !color.is_empty()).map(str::to_owned),
            caps: font.get("caps").and_then(Value::as_bool),
            letter_spacing: font.get("letterSpacing").and_then(Value::as_f64),
        }
    }
}

struct DeclaredStyle {
    based_on: String,
    font: StyleFont,
}

fn resolve_style_font(id: &str, declared: &HashMap<String, DeclaredStyle>, base: &StyleFont, seen: &mut HashSet<String>) -> StyleFont {
    let Some(entry) = declared.get(id) else { return base.clone() };
    if !seen.insert(id.to_owned()) {
        return base.clone();
    }
    let parent = if entry.based_on.is_empty() { base.clone() } else { resolve_style_font(&entry.based_on, declared, base, seen) };
    let font = &entry.font;
    StyleFont {
        size: if font.size != 0.0 { font.size } else { parent.size },
        bold: font.bold || parent.bold,
        name: if font.name.is_empty() { parent.name } else { font.name.clone() },
        color: font.color.clone().or(parent.color),
        caps: font.caps.or(parent.caps),
        letter_spacing: font.letter_spacing.or(parent.letter_spacing),
    }
}

/// The font of every style, the style chain resolved down to the document defaults; the empty id names the defaults.
fn resolve_style_fonts(styles_xml: &str) -> HashMap<String, StyleFont> {
    let mut fonts = HashMap::new();
    if styles_xml.is_empty() {
        return fonts;
    }
    let defaults = compiled(r"<w:docDefaults\b[\s\S]*?<\/w:docDefaults>", "").find(styles_xml).map_or("", |found| &styles_xml[found]);
    let base = StyleFont::of(defaults);
    let mut declared: HashMap<String, DeclaredStyle> = HashMap::new();
    for found in compiled(r"<w:style\b([^>]*)>([\s\S]*?)<\/w:style>", "g").captures_iter(styles_xml) {
        let id = decoded(r#"\bw:styleId="([^"]+)""#, found.get(1).unwrap_or(""));
        if id.is_empty() {
            continue;
        }
        let body = found.get(2).unwrap_or("");
        declared.insert(id, DeclaredStyle { based_on: decoded(r#"<w:basedOn\b[^>]*\bw:val="([^"]+)""#, body), font: StyleFont::of(body) });
    }
    for id in declared.keys() {
        fonts.insert(id.clone(), resolve_style_font(id, &declared, &base, &mut HashSet::new()));
    }
    fonts.insert(String::new(), base);
    fonts
}

/// The number a font object states for `key`, `None` when it states none (null or absent).
fn stated_number(font: Option<&Value>, key: &str) -> Option<f64> {
    font.and_then(|font| font.get(key)).and_then(Value::as_f64)
}

/// What a paragraph's style says about its font, filled in where the paragraph's own runs state nothing.
fn apply_style_fonts(model: &mut DocxBodyModel, style_fonts: &HashMap<String, StyleFont>) {
    if style_fonts.is_empty() {
        return;
    }
    for paragraph in &mut model.paragraphs {
        let style = paragraph.get("style").and_then(Value::as_str).unwrap_or("");
        let inherited = style_fonts.get(style).or_else(|| style_fonts.get("")).cloned().unwrap_or_default();
        let own = paragraph.get("font");
        let own_text = |key: &str| own.and_then(|font| font.get(key)).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let size = stated_number(own, "size").filter(|size| *size != 0.0).unwrap_or(inherited.size);
        let bold = own.and_then(|font| font.get("bold")).and_then(Value::as_bool).unwrap_or(false) || inherited.bold;
        let name = own_text("name").unwrap_or_else(|| inherited.name.clone());
        let color = own_text("color").or_else(|| inherited.color.clone()).unwrap_or_default();
        let caps = own.and_then(|font| font.get("caps")).and_then(Value::as_bool).or(inherited.caps).unwrap_or(false);
        let letter_spacing = stated_number(own, "letterSpacing").or(inherited.letter_spacing).unwrap_or(0.0);
        if size == 0.0 && !bold && name.is_empty() && color.is_empty() && !caps && letter_spacing == 0.0 {
            continue;
        }
        let mut font = Map::new();
        if size != 0.0 {
            font.insert("size".to_owned(), json_number(size));
        }
        if bold {
            font.insert("bold".to_owned(), Value::Bool(true));
        }
        if !name.is_empty() {
            font.insert("name".to_owned(), Value::String(name));
        }
        if !color.is_empty() {
            font.insert("color".to_owned(), Value::String(color));
        }
        if caps {
            font.insert("caps".to_owned(), Value::Bool(true));
        }
        if letter_spacing != 0.0 {
            font.insert("letterSpacing".to_owned(), json_number(letter_spacing));
        }
        if let Some(record) = paragraph.as_object_mut() {
            record.insert("font".to_owned(), Value::Object(font));
        }
    }
}

struct DeclaredSpacing {
    based_on: String,
    spacing: Map<String, Value>,
}

fn object_of(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(entries) => entries,
        _ => Map::new(),
    }
}

fn resolve_style_spacing(id: &str, declared: &HashMap<String, DeclaredSpacing>, base: &Map<String, Value>, seen: &mut HashSet<String>) -> Map<String, Value> {
    let Some(entry) = declared.get(id) else { return base.clone() };
    if !seen.insert(id.to_owned()) {
        return base.clone();
    }
    let mut spacing = if entry.based_on.is_empty() { base.clone() } else { resolve_style_spacing(&entry.based_on, declared, base, seen) };
    for (key, value) in &entry.spacing {
        spacing.insert(key.clone(), value.clone());
    }
    spacing
}

/// Paragraph spacing the style chain states (and the document defaults), filled in where the paragraph states none.
fn apply_style_spacing(model: &mut DocxBodyModel, styles_xml: &str) {
    if styles_xml.is_empty() {
        return;
    }
    let defaults = compiled(r"<w:pPrDefault\b[\s\S]*?<\/w:pPrDefault>", "").find(styles_xml).map_or("<w:pPr/>", |found| &styles_xml[found]);
    let base = object_of(docx_paragraph_spacing(defaults));
    let mut declared: HashMap<String, DeclaredSpacing> = HashMap::new();
    for found in compiled(r"<w:style\b([^>]*)>([\s\S]*?)<\/w:style>", "g").captures_iter(styles_xml) {
        let id = decoded(r#"\bw:styleId="([^"]+)""#, found.get(1).unwrap_or(""));
        if id.is_empty() {
            continue;
        }
        let body = found.get(2).unwrap_or("");
        let spacing = if compiled(r"<w:pPr\b", "").is_match(body) { object_of(docx_paragraph_spacing(body)) } else { Map::new() };
        declared.insert(id, DeclaredSpacing { based_on: decoded(r#"<w:basedOn\b[^>]*\bw:val="([^"]+)""#, body), spacing });
    }
    for paragraph in &mut model.paragraphs {
        let style = paragraph.get("style").and_then(Value::as_str).unwrap_or("").to_owned();
        let mut spacing = resolve_style_spacing(&style, &declared, &base, &mut HashSet::new());
        if let Some(own) = paragraph.get("format").and_then(Value::as_object) {
            for (key, value) in own {
                spacing.insert(key.clone(), value.clone());
            }
        }
        if !spacing.is_empty() {
            paragraph["format"] = Value::Object(spacing);
        }
    }
}

/// `numberingLevelFormat(levelXml)`: a numbering level's format: its numFmt, or `bullet` when the level shows a literal mark
/// with no `%n` placeholder. Word saves the document's own bullet list as decimal with the mark "•", since an outline
/// template cannot take the bullet style; read by numFmt alone, those bullets were numbers.
pub fn numbering_level_format(level_xml: &str) -> String {
    let format = first(r#"<w:numFmt\b[^>]*\bw:val="([^"]+)""#, level_xml).unwrap_or_default();
    let text = first(r#"<w:lvlText\b[^>]*\bw:val="([^"]*)""#, level_xml).unwrap_or_default();
    if format == "bullet" || (!text.is_empty() && !text.contains('%')) { "bullet".to_owned() } else { format }
}

/// A number as JavaScript writes it into a template string.
fn number_text(number: f64) -> String {
    value_to_string(&json_number(number))
}

/// A paragraph's numId names a definition in numbering.xml; the level's number format tells a bullet from a numbered list.
fn apply_list_kinds(model: &mut DocxBodyModel, numbering: &str) {
    if numbering.is_empty() || !model.paragraphs.iter().any(|paragraph| paragraph.get("list").is_some()) {
        return;
    }
    let mut abstract_of: HashMap<String, String> = HashMap::new();
    for found in compiled(r#"<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId\b[^>]*\bw:val="(\d+)""#, "g").captures_iter(numbering) {
        abstract_of.insert(number_text(string_to_number(found.get(1).unwrap_or(""))), number_text(string_to_number(found.get(2).unwrap_or(""))));
    }
    let mut formats: HashMap<String, String> = HashMap::new();
    for definition in compiled(r#"<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>"#, "g").captures_iter(numbering) {
        for level in compiled(r#"<w:lvl\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>"#, "g").captures_iter(definition.get(2).unwrap_or("")) {
            formats.insert(
                format!("{}:{}", definition.get(1).unwrap_or(""), level.get(1).unwrap_or("")),
                numbering_level_format(level.get(2).unwrap_or("")),
            );
        }
    }
    for paragraph in &mut model.paragraphs {
        let Some(list) = paragraph.get_mut("list").and_then(Value::as_object_mut) else { continue };
        let num_id = number_text(list.get("numId").and_then(Value::as_f64).unwrap_or(f64::NAN));
        let level = number_text(list.get("level").and_then(Value::as_f64).unwrap_or(f64::NAN));
        let Some(abstract_id) = abstract_of.get(&num_id) else { continue };
        let Some(format) = formats.get(&format!("{abstract_id}:{level}")).filter(|format| !format.is_empty()) else { continue };
        list.insert("kind".to_owned(), Value::String(if format == "bullet" { "bullet" } else { "number" }.to_owned()));
    }
}

/// The body blocks a read returns: the whole body, one page of it, or the single paragraph or table a target path names.
struct Page {
    paged: bool,
    offset: f64,
    limit: f64,
    /// Indexes into the model's blocks.
    blocks: Vec<usize>,
}

/// `Array.prototype.slice(start, end)` bounds for a non-negative start and end.
fn slice_bounds(start: f64, end: f64, length: usize) -> (usize, usize) {
    let clamp = |bound: f64| if bound.is_nan() { 0 } else { bound.trunc().min(length as f64) as usize };
    let (from, to) = (clamp(start), clamp(end));
    (from.min(to), to)
}

fn select_blocks(model: &DocxBodyModel, options: &Value) -> Page {
    let paged = options.get("paged") == Some(&Value::Bool(true));
    let number = |key: &str, fallback: f64| {
        let value = to_number_of(options.get(key));
        if value == 0.0 || value.is_nan() { fallback } else { value }
    };
    let offset = if paged { math::max(0.0, number("offset", 0.0)) } else { 0.0 };
    let limit = if paged { math::max(1.0, number("limit", 200.0)) } else { model.blocks.len() as f64 };
    let all: Vec<usize> = (0..model.blocks.len()).collect();
    if !paged {
        return Page { paged, offset, limit, blocks: all };
    }
    let target = options.get("target").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
    let paragraph = first(r"^\/body\/p\[(\d+)\]", &target);
    let table = first(r"^\/body\/tbl\[(\d+)\]", &target);
    let blocks = if let Some(wanted) = paragraph {
        let wanted = string_to_number(&wanted);
        all.into_iter().filter(|&at| model.blocks[at].is_paragraph() && model.blocks[at].logical_index as f64 == wanted).collect()
    } else if let Some(wanted) = table {
        let wanted = string_to_number(&wanted);
        all.into_iter().filter(|&at| !model.blocks[at].is_paragraph() && model.blocks[at].logical_index as f64 == wanted).collect()
    } else {
        let (from, to) = slice_bounds(offset, offset + limit, all.len());
        all[from..to].to_vec()
    };
    Page { paged, offset, limit, blocks }
}

/// Adds a revision's ordinal to the `revisions` list of a paragraph or cell.
fn add_revision_ordinal(record: &mut Value, ordinal: usize) {
    let Some(entries) = record.as_object_mut() else { return };
    match entries.get_mut("revisions").and_then(Value::as_array_mut) {
        Some(list) => list.push(Value::from(ordinal)),
        None => {
            entries.insert("revisions".to_owned(), json!([ordinal]));
        }
    }
}

/// The body block a document.xml offset falls in: a revision names the paragraph or table it sits in, and a paragraph lists
/// its revisions.
fn block_at(model: &DocxBodyModel, offset: usize) -> Option<usize> {
    let body = model.body.as_ref()?;
    let relative = offset as i64 - body.start as i64;
    model.blocks.iter().position(|block| block.start as i64 <= relative && relative < block.end as i64)
}

/// Where inside a table block an offset falls: the row and the cell (0 when it falls in none), and the path suffix.
struct CellAt {
    row: usize,
    cell: usize,
    suffix: String,
}

/// Inside a table, the row and cell an offset (relative to the table block) falls in, the outer table's when tables nest,
/// so the revision names the cell.
fn cell_at(block: &BodyBlock, offset: usize) -> CellAt {
    let none = CellAt { row: 0, cell: 0, suffix: String::new() };
    let Some(table) = container_inner(&block.xml, "w:tbl", 0) else { return none };
    let in_table = offset as i64 - table.start as i64;
    let rows = top_level_elements(&table.inner, &["w:tr"]);
    let Some(row_index) = rows.iter().position(|row| row.start as i64 <= in_table && in_table < row.end as i64) else { return none };
    let row_inner = container_inner(&rows[row_index].xml, "w:tr", 0);
    let cell_index = row_inner.and_then(|inner| {
        let in_row = in_table - rows[row_index].start as i64 - inner.start as i64;
        top_level_elements(&inner.inner, &["w:tc"]).iter().position(|cell| cell.start as i64 <= in_row && in_row < cell.end as i64)
    });
    CellAt {
        row: row_index + 1,
        cell: cell_index.map_or(0, |at| at + 1),
        suffix: format!("/row[{}]{}", row_index + 1, cell_index.map_or(String::new(), |at| format!("/cell[{}]", at + 1))),
    }
}

/// Wrappers in document order of their opening tags, parents before children: the ordinal `resolve_revision` addresses. A
/// paragraph-mark marker (`<w:del/>` inside `w:rPr`) and a formatting record (`w:rPrChange`) are not wrappers.
fn docx_revisions(model: &mut DocxBodyModel, story_xml: &[(String, String)]) -> (Vec<Value>, usize) {
    let mut revisions: Vec<Value> = Vec::new();
    let mut property_change_count = 0;
    let document_part = compiled(r"^word\/document\.xml$", "i");
    for (part, xml) in story_xml {
        property_change_count += count_docx_property_changes(xml);
        let in_body = document_part.is_match(part);
        let tree = docx_revision_tree(xml);
        for span in flatten_docx_revisions(&tree) {
            let block = if in_body { block_at(model, span.start) } else { None };
            let location = match block {
                Some(at) if !model.blocks[at].is_paragraph() => {
                    let relative = span.start as i64 - model.body.as_ref().map_or(0, |body| body.start) as i64 - model.blocks[at].start as i64;
                    cell_at(&model.blocks[at], relative.max(0) as usize)
                }
                _ => CellAt { row: 0, cell: 0, suffix: String::new() },
            };
            let at = match block {
                Some(found) if model.blocks[found].is_paragraph() => format!("/body/p[{}]", model.blocks[found].logical_index),
                Some(found) => format!("/body/tbl[{}]{}", model.blocks[found].logical_index, location.suffix),
                None => String::new(),
            };
            let text_tag = if span.kind == RevisionKind::Insertion { "w:t" } else { "w:delText" };
            let mut revision = Map::new();
            revision.insert("path".to_owned(), Value::String(format!("/body/revision[{}]", revisions.len() + 1)));
            revision.insert("index".to_owned(), Value::from(revisions.len() + 1));
            revision.insert("id".to_owned(), Value::String(xml_decode(&span.id)));
            revision.insert("author".to_owned(), Value::String(span.author.clone()));
            revision.insert("date".to_owned(), Value::String(xml_decode(&span.date)));
            revision.insert("type".to_owned(), Value::String(revision_type(&span.tag).to_owned()));
            revision.insert("text".to_owned(), Value::String(block_text(&xml[span.inner_start..span.inner_end], text_tag)));
            if !span.children.is_empty() {
                revision.insert("nested".to_owned(), Value::from(span.children.len()));
            }
            if !at.is_empty() {
                revision.insert("at".to_owned(), Value::String(at));
            }
            revision.insert("part".to_owned(), Value::String(part.clone()));
            revisions.push(Value::Object(revision));
            let ordinal = revisions.len();
            match block {
                Some(found) if model.blocks[found].is_paragraph() => {
                    add_revision_ordinal(&mut model.paragraphs[model.blocks[found].logical_index - 1], ordinal);
                }
                Some(found) if location.cell > 0 => {
                    let cell = model
                        .tables
                        .get_mut(model.blocks[found].logical_index - 1)
                        .and_then(|table| table.get_mut("rows"))
                        .and_then(|rows| rows.get_mut(location.row - 1))
                        .and_then(|row| row.get_mut("cells"))
                        .and_then(|cells| cells.get_mut(location.cell - 1));
                    if let Some(cell) = cell {
                        add_revision_ordinal(cell, ordinal);
                    }
                }
                _ => {}
            }
        }
    }
    (revisions, property_change_count)
}

/// Who changed what, at a glance: the redline reviewer reads this before the revision list.
fn revision_authors(revisions: &[Value]) -> Vec<Value> {
    let mut authors: Vec<(String, usize, usize)> = Vec::new();
    for revision in revisions {
        let author = revision["author"].as_str().unwrap_or("").to_owned();
        let at = match authors.iter().position(|(known, _, _)| *known == author) {
            Some(at) => at,
            None => {
                authors.push((author, 0, 0));
                authors.len() - 1
            }
        };
        if matches!(revision["type"].as_str(), Some("insertion" | "moved_to")) {
            authors[at].1 += 1;
        } else {
            authors[at].2 += 1;
        }
    }
    authors.into_iter().map(|(author, insertions, deletions)| json!({ "author": author, "insertions": insertions, "deletions": deletions })).collect()
}

/// The footnotes and endnotes of the document, each kind numbered on its own.
fn docx_notes(zip: &Package) -> Vec<(&'static str, Value)> {
    let mut notes = Vec::new();
    for (kind, part, tag) in [("footnote", "word/footnotes.xml", "w:footnote"), ("endnote", "word/endnotes.xml", "w:endnote")] {
        let xml = zip.text(part);
        let mut ordinal = 0;
        for found in compiled(&format!(r"<{tag}\b([^>]*)>([\s\S]*?)<\/{tag}>"), "g").captures_iter(&xml) {
            let attributes = found.get(1).unwrap_or("");
            let id = decoded(r#"\bw:id="([^"]+)""#, attributes);
            // The separator and continuation-separator entries are the rule Word draws above the note area, not notes.
            if string_to_number(&id) < 1.0 || compiled(r#"\bw:type=""#, "").is_match(attributes) {
                continue;
            }
            ordinal += 1;
            // The space the writer puts after the note's own reference mark separates the mark from the words.
            let text = block_text(found.get(2).unwrap_or(""), "w:t");
            let text = compiled(r"^\s+", "").find(&text).map_or(text.as_str(), |lead| &text[lead.end..]).to_owned();
            notes.push((kind, json!({ "path": format!("/body/{kind}[{ordinal}]"), "kind": kind, "id": id, "text": text, "part": part })));
        }
    }
    notes
}

fn docx_content_controls(story_xml: &[(String, String)]) -> Vec<Value> {
    let mut controls = Vec::new();
    for (part, xml) in story_xml {
        for found in compiled(r"<w:sdt\b[^>]*>([\s\S]*?)<\/w:sdt>", "g").captures_iter(xml) {
            let inner = found.get(1).unwrap_or("");
            let properties = first(r"<w:sdtPr\b[^>]*>([\s\S]*?)<\/w:sdtPr>", inner).unwrap_or_default();
            controls.push(json!({
                "path": format!("/body/content-control[{}]", controls.len() + 1),
                "index": controls.len() + 1,
                "tag": decoded(r#"<w:tag\b[^>]*\bw:val="([^"]*)""#, &properties),
                "title": decoded(r#"<w:alias\b[^>]*\bw:val="([^"]*)""#, &properties),
                "lock": decoded(r#"<w:lock\b[^>]*\bw:val="([^"]*)""#, &properties),
                "text": block_text(inner, "w:t"),
                "part": part,
            }));
        }
    }
    controls
}

fn docx_images(story_xml: &[(String, String)]) -> Vec<Value> {
    let mut images = Vec::new();
    for (part, xml) in story_xml {
        for picture in docx_pictures(xml) {
            let mut image = Map::new();
            image.insert("path".to_owned(), Value::String(format!("/body/image[{}]", images.len() + 1)));
            image.insert("index".to_owned(), Value::from(images.len() + 1));
            spread(&mut image, picture);
            image.insert("part".to_owned(), Value::String(part.clone()));
            images.push(Value::Object(image));
        }
    }
    images
}

/// The story parts of the package, each read once: every part with its text (for the `parts` list and the section stories)
/// and the parts the comment anchors, revisions, content controls and pictures read from.
struct StoryParts {
    part_xml: HashMap<String, String>,
    /// Each part with the text of its `w:t` elements, in part-name order.
    content: Vec<(String, String)>,
    story_xml: Vec<(String, String)>,
}

fn docx_story_parts(zip: &Package) -> StoryParts {
    let pattern = compiled(r"^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$", "i");
    let mut parts: Vec<String> = zip.names().into_iter().filter(|name| pattern.is_match(name)).collect();
    parts.sort();
    parts.dedup();
    let part_xml: HashMap<String, String> = parts.iter().map(|part| (part.clone(), zip.text(part))).collect();
    let content = parts.iter().map(|part| (part.clone(), block_text(&part_xml[part], "w:t"))).collect();
    let comments = compiled(r"\/comments\.xml$", "i");
    let story_xml = parts.iter().filter(|part| !comments.is_match(part)).map(|part| (part.clone(), part_xml[part].clone())).collect();
    StoryParts { part_xml, content, story_xml }
}

fn block_order_entries(model: &DocxBodyModel, page: &Page) -> Vec<Value> {
    page.blocks
        .iter()
        .map(|&at| {
            let block = &model.blocks[at];
            let kind = if block.is_paragraph() { "paragraph" } else { "table" };
            let path = if block.is_paragraph() { format!("/body/p[{}]", block.logical_index) } else { format!("/body/tbl[{}]", block.logical_index) };
            let start = model.body.as_ref().map_or(block.start, |body| utf16_len(&body.inner[..block.start]));
            json!({ "type": kind, "index": block.logical_index, "path": path, "start": start })
        })
        .collect()
}

/// The records of the blocks a page selected.
fn selected_records(records: &[Value], wanted: &HashSet<usize>) -> Vec<Value> {
    records.iter().filter(|record| record["index"].as_u64().is_some_and(|index| wanted.contains(&(index as usize)))).cloned().collect()
}

/// The body a page returns: every paragraph and table when unpaged, otherwise the blocks the page selected, with the story
/// parts summarised once the body outgrows the page.
fn paged_body(model: &DocxBodyModel, page: &Page, content: &[(String, String)]) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let parts_with_text: Vec<Value> = content.iter().map(|(part, text)| json!({ "part": part, "text": text })).collect();
    if !page.paged {
        return (model.paragraphs.clone(), model.tables.clone(), parts_with_text);
    }
    let selected = |paragraph: bool| -> HashSet<usize> {
        page.blocks.iter().map(|&at| &model.blocks[at]).filter(|block| block.is_paragraph() == paragraph).map(|block| block.logical_index).collect()
    };
    let parts = if model.blocks.len() as f64 > page.limit {
        content.iter().map(|(part, text)| json!({ "part": part, "chars": utf16_len(text) })).collect()
    } else {
        parts_with_text
    };
    (selected_records(&model.paragraphs, &selected(true)), selected_records(&model.tables, &selected(false)), parts)
}

fn docx_pagination(page: &Page, model: &DocxBodyModel) -> Option<Value> {
    if !page.paged {
        return None;
    }
    let returned = page.blocks.len() as f64;
    let total = model.blocks.len() as f64;
    Some(json!({
        "unit": "body-block",
        "offset": json_number(page.offset),
        "limit": json_number(page.limit),
        "returned": page.blocks.len(),
        "total": model.blocks.len(),
        "nextOffset": next_page_offset(page.offset, returned, total).map_or(Value::Null, json_number),
    }))
}

fn points_of(twips: f64) -> Value {
    json_number(math::round(twips / TWIPS_PER_POINT * 100.0) / 100.0)
}

/// The sections in the shape Word reports them: orientation, margins in points, and each header and footer with its text. A
/// section without a reference of its own shows its predecessor's, as Word links it (linkToPrevious); the primary header and
/// footer are listed even when empty, since Word keeps both on every section.
fn docx_sections(document_xml: &str, relationships_xml: &str, part_text: &HashMap<&str, &str>, referenced: &mut HashSet<String>) -> Vec<Value> {
    let targets = relationship_map(relationships_xml);
    let story_part = |id: &str| match targets.get(id) {
        None | Some("") => String::new(),
        Some(target) => target.strip_prefix('/').map_or_else(|| format!("word/{target}"), str::to_owned),
    };
    let story_kind = |declared: &str| {
        let declared = if declared.is_empty() { "default" } else { declared };
        match declared {
            "default" => Some("primary"),
            "first" => Some("first"),
            "even" => Some("even"),
            _ => None,
        }
    };
    let mut inherited: HashMap<String, String> = HashMap::new();
    let references = compiled(r"<w:(header|footer)Reference\b([^>]*)\/>", "g");
    let mut sections = Vec::new();
    for (offset, range) in compiled(r"<w:sectPr\b[\s\S]*?<\/w:sectPr>", "g").find_iter(document_xml).enumerate() {
        let section_xml = &document_xml[range];
        let index = offset + 1;
        let margin = |side: &str| {
            first(&format!(r#"<w:pgMar\b[^>]*\bw:{side}="(-?\d+)""#), section_xml).map(|twips| points_of(string_to_number(&twips)))
        };
        let mut own: HashMap<String, String> = HashMap::new();
        for found in references.captures_iter(section_xml) {
            let location = found.get(1).unwrap_or("");
            let attributes = found.get(2).unwrap_or("");
            let kind = story_kind(&first(r#"\bw:type="([^"]+)""#, attributes).unwrap_or_default());
            let id = first(r#"\br:id="([^"]+)""#, attributes);
            if let (Some(kind), Some(id)) = (kind, id) {
                let part = story_part(&id);
                own.insert(format!("{location}:{kind}"), part.clone());
                referenced.insert(part);
            }
        }
        let mut stories = Vec::new();
        for kind in ["primary", "first", "even"] {
            for location in ["header", "footer"] {
                let key = format!("{location}:{kind}");
                let part = own.get(&key).or_else(|| inherited.get(&key)).cloned();
                if part.is_none() && kind != "primary" {
                    continue;
                }
                // A reference to the very part the section before shows is that section's header carried on.
                let linked = index > 1 && (!own.contains_key(&key) || own.get(&key) == inherited.get(&key));
                if let Some(own_part) = own.get(&key) {
                    inherited.insert(key.clone(), own_part.clone());
                }
                let text = part.as_deref().filter(|part| !part.is_empty()).map_or("", |part| part_text.get(part).copied().unwrap_or(""));
                let mut story = Map::new();
                story.insert("path".to_owned(), Value::String(format!("/section[{index}]/{location}[{kind}]")));
                story.insert("kind".to_owned(), Value::String(kind.to_owned()));
                story.insert("location".to_owned(), Value::String(location.to_owned()));
                story.insert("text".to_owned(), Value::String(text.to_owned()));
                if linked {
                    story.insert("linkToPrevious".to_owned(), Value::Bool(true));
                }
                stories.push(Value::Object(story));
            }
        }
        // The columns the text flows through, as set_page columns lays them out.
        let cols = first(r"<w:cols\b([^>]*?)\/?>", section_xml).unwrap_or_default();
        let counted = first(r#"\bw:num="(\d+)""#, &cols).map_or(0.0, |digits| string_to_number(&digits));
        let columns = if counted == 0.0 { 1.0 } else { counted };
        let spacing = first(r#"\bw:space="(\d+)""#, &cols).map_or(Value::from(36), |digits| points_of(string_to_number(&digits)));
        let mut section = Map::new();
        section.insert("path".to_owned(), Value::String(format!("/section[{index}]")));
        section.insert("index".to_owned(), Value::from(index));
        let landscape = compiled(r#"<w:pgSz\b[^>]*\bw:orient="landscape""#, "").is_match(section_xml);
        section.insert("orientation".to_owned(), Value::String(if landscape { "landscape" } else { "portrait" }.to_owned()));
        for (key, side) in [("topMargin", "top"), ("bottomMargin", "bottom"), ("leftMargin", "left"), ("rightMargin", "right")] {
            if let Some(points) = margin(side) {
                section.insert(key.to_owned(), points);
            }
        }
        section.insert("columns".to_owned(), json_number(columns));
        // Word's own spacing when the file names none is half an inch.
        if columns > 1.0 {
            section.insert("columnSpacing".to_owned(), spacing);
        }
        section.insert("stories".to_owned(), Value::Array(stories));
        sections.push(Value::Object(section));
    }
    sections
}

/// `snapshotDocx(zip, options)`: the Word document as the Office tool shows it to the model. `options` is Node's
/// `{ paged, offset, limit, target }`.
pub fn snapshot_docx(zip: &Package, options: &Value) -> Value {
    let story_parts = docx_story_parts(zip);
    let document_xml = story_parts.part_xml.get("word/document.xml").map_or("", String::as_str);
    // Headers and footers read under the section that shows them, as Word reports them; the rest, a header part no section
    // references among them, stay listed by part.
    let mut referenced = HashSet::new();
    let part_text: HashMap<&str, &str> = story_parts.content.iter().map(|(part, text)| (part.as_str(), text.as_str())).collect();
    let sections = docx_sections(document_xml, &zip.text("word/_rels/document.xml.rels"), &part_text, &mut referenced);
    let content: Vec<(String, String)> = story_parts.content.iter().filter(|(part, _)| !referenced.contains(part)).cloned().collect();
    let mut model = docx_body_model(document_xml);
    let styles_xml = zip.text("word/styles.xml");
    apply_style_fonts(&mut model, &resolve_style_fonts(&styles_xml));
    apply_style_spacing(&mut model, &styles_xml);
    apply_style_names(&mut model, &styles_xml);
    apply_list_kinds(&mut model, &zip.text("word/numbering.xml"));
    let page = select_blocks(&model, options);
    // The annotations add the revisions each paragraph and cell carries, so they are read before the page is cut.
    let (comments, thread_records) = docx_comments(&story_parts.story_xml, &zip.text("word/comments.xml"), &zip.text("word/commentsExtended.xml"));
    let (revisions, property_change_count) = docx_revisions(&mut model, &story_parts.story_xml);
    let notes = docx_notes(zip);
    let notes_of = |kind: &str| notes.iter().filter(|(found, _)| *found == kind).map(|(_, note)| note.clone()).collect::<Vec<_>>();
    let (footnotes, endnotes) = (notes_of("footnote"), notes_of("endnote"));
    let content_controls = docx_content_controls(&story_parts.story_xml);
    let images = docx_images(&story_parts.story_xml);
    let comment_threads: Vec<Value> = thread_records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            json!({
                "path": format!("/body/comment-thread[{}]", index + 1),
                "index": index + 1,
                "paraId": record.para_id,
                "parentParaId": record.parent_para_id,
                "resolved": record.resolved,
            })
        })
        .collect();
    let (paragraphs, tables, parts) = paged_body(&model, &page, &content);
    let mut snapshot = Map::new();
    snapshot.insert("format".to_owned(), Value::from("docx"));
    snapshot.insert("path".to_owned(), Value::from("/"));
    // Whether this document records new edits as revisions: a reviewer's file often arrives with it already on.
    snapshot.insert("trackChanges".to_owned(), Value::Bool(settings_track_changes(&zip.text("word/settings.xml"))));
    snapshot.insert("paragraphCount".to_owned(), Value::from(model.paragraphs.len()));
    snapshot.insert("tableCount".to_owned(), Value::from(model.tables.len()));
    snapshot.insert("paragraphs".to_owned(), Value::Array(paragraphs));
    snapshot.insert("tables".to_owned(), Value::Array(tables));
    snapshot.insert("blockOrder".to_owned(), Value::Array(block_order_entries(&model, &page)));
    snapshot.insert("parts".to_owned(), Value::Array(parts));
    snapshot.insert("sections".to_owned(), Value::Array(sections));
    snapshot.insert("commentCount".to_owned(), Value::from(comments.len()));
    snapshot.insert("revisionCount".to_owned(), Value::from(revisions.len()));
    snapshot.insert("propertyChangeCount".to_owned(), Value::from(property_change_count));
    snapshot.insert("revisionAuthors".to_owned(), Value::Array(revision_authors(&revisions)));
    snapshot.insert("comments".to_owned(), Value::Array(comments));
    snapshot.insert("revisions".to_owned(), Value::Array(revisions));
    snapshot.insert("footnoteCount".to_owned(), Value::from(footnotes.len()));
    snapshot.insert("endnoteCount".to_owned(), Value::from(endnotes.len()));
    snapshot.insert("footnotes".to_owned(), Value::Array(footnotes));
    snapshot.insert("endnotes".to_owned(), Value::Array(endnotes));
    snapshot.insert("contentControlCount".to_owned(), Value::from(content_controls.len()));
    snapshot.insert("contentControls".to_owned(), Value::Array(content_controls));
    snapshot.insert("imageCount".to_owned(), Value::from(images.len()));
    snapshot.insert("images".to_owned(), Value::Array(images));
    snapshot.insert("commentThreadCount".to_owned(), Value::from(comment_threads.len()));
    snapshot.insert("commentThreads".to_owned(), Value::Array(comment_threads));
    if let Some(pagination) = docx_pagination(&page, &model) {
        snapshot.insert("pagination".to_owned(), pagination);
    }
    Value::Object(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

    fn style(id: &str, name: &str, inner: &str, based: &str) -> String {
        format!(r#"<w:style w:type="paragraph" w:styleId="{id}"><w:name w:val="{name}"/>{based}{inner}</w:style>"#)
    }

    /// The package of the three-paragraph document the format cases read: a heading and two body paragraphs.
    fn snapshot_of(heading_style: &str, heading_run: &str, body_run: &str) -> Value {
        let paragraph = |id: &str, text: &str, rpr: &str| {
            format!(r#"<w:p><w:pPr><w:pStyle w:val="{id}"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/>{rpr}</w:rPr><w:t>{text}</w:t></w:r></w:p>"#)
        };
        let mut zip = Package::new();
        zip.set(
            "word/document.xml",
            format!(
                "<w:document {W}><w:body>{}{}{}</w:body></w:document>",
                paragraph("Heading1", "Overview", heading_run),
                paragraph("Normal", "Body one.", body_run),
                paragraph("Normal", "Body two.", body_run)
            ),
        );
        zip.set(
            "word/styles.xml",
            format!(
                "<w:styles {W}>{}{}</w:styles>",
                style("Normal", "Normal", "", ""),
                style("Heading1", "heading 1", heading_style, r#"<w:basedOn w:val="Normal"/>"#)
            ),
        );
        snapshot_docx(&zip, &json!({}))
    }

    #[test]
    fn explicit_caps_and_tracking_resets_override_the_style_they_inherit_and_unstated_values_inherit() {
        let styled = r#"<w:rPr><w:caps/><w:spacing w:val="40"/></w:rPr>"#;
        let reset = snapshot_of(styled, r#"<w:caps w:val="0"/><w:spacing w:val="0"/>"#, "");
        assert_eq!(reset["paragraphs"][0]["font"].get("caps"), None);
        assert_eq!(reset["paragraphs"][0]["font"].get("letterSpacing"), None);
        let inherited = snapshot_of(styled, "", "");
        assert_eq!(inherited["paragraphs"][0]["font"]["caps"], json!(true));
        assert_eq!(inherited["paragraphs"][0]["font"]["letterSpacing"], json!(2));
    }

    #[test]
    fn an_explicit_colour_against_automatic_black_body_text_reads_back_as_stated() {
        let snapshot = snapshot_of("", r#"<w:color w:val="FF0000"/>"#, r#"<w:color w:val="auto"/>"#);
        assert_eq!(snapshot["paragraphs"][0]["font"]["color"], json!("FF0000"));
        assert_eq!(snapshot["paragraphs"][1]["font"]["color"], json!("000000"));
    }

    #[test]
    fn a_style_colour_and_a_preceding_space_reach_the_paragraphs_that_use_the_style() {
        let coloured = snapshot_of(r#"<w:rPr><w:color w:val="C0392B"/></w:rPr>"#, "", "");
        assert_eq!(coloured["paragraphs"][0]["font"]["color"], json!("C0392B"));
        let spaced = snapshot_of(r#"<w:pPr><w:spacing w:before="480" w:after="120"/></w:pPr>"#, "", "");
        assert_eq!(spaced["paragraphs"][0]["format"], json!({ "spacingBefore": 24, "spacingAfter": 6 }));
        let capitals = snapshot_of("<w:rPr><w:caps/></w:rPr>", "", "");
        assert_eq!(capitals["paragraphs"][0]["font"]["caps"], json!(true));
    }

    #[test]
    fn a_block_appends_before_the_trailing_section_and_into_an_empty_paragraph() {
        let fresh = format!("<w:document {W}><w:body><w:p/><w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>");
        assert!(append_docx_block(&fresh, "<w:p><w:r><w:t>x</w:t></w:r></w:p>").unwrap().contains("<w:body><w:p><w:r><w:t>x</w:t></w:r></w:p><w:sectPr>"));
        let filled = format!("<w:document {W}><w:body><w:p><w:r><w:t>a</w:t></w:r></w:p><w:sectPr/></w:body></w:document>");
        assert!(append_docx_block(&filled, "<w:p/>").unwrap().contains("</w:p><w:p/><w:sectPr/>"));
        assert_eq!(append_docx_block("<w:document/>", "<w:p/>"), Err("DOCX document body is missing".to_owned()));
    }

    #[test]
    fn adjacent_tables_are_kept_apart_and_a_closing_table_is_followed_by_a_paragraph() {
        let joined = "<w:body><w:tbl/></w:tbl> <w:tbl><w:tr/></w:tbl></w:body>";
        assert!(has_adjacent_tables(joined));
        assert!(separate_adjacent_tables(joined).contains("</w:tbl> <w:p/><w:tbl>"));
        let closing = "<w:body><w:tbl><w:tr/></w:tbl><w:sectPr/></w:body>";
        assert_eq!(close_trailing_table(closing), "<w:body><w:tbl><w:tr/></w:tbl><w:p/><w:sectPr/></w:body>");
    }

    #[test]
    fn a_literal_mark_with_no_placeholder_is_a_bullet() {
        assert_eq!(numbering_level_format(r#"<w:numFmt w:val="decimal"/><w:lvlText w:val="•"/>"#), "bullet");
        assert_eq!(numbering_level_format(r#"<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>"#), "decimal");
        assert_eq!(numbering_level_format(r#"<w:numFmt w:val="bullet"/>"#), "bullet");
    }
}
