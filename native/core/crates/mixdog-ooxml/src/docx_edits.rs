//! `portable/portable-docx-edits.mjs`: the body, table, comment and story edits the portable Word backend applies to a
//! document. Every edit takes the package and the operation (the JSON object a batch carries) and answers the operation's
//! result object, or the message Node throws; the dispatcher in [`crate::docx`] owns the loop. The package is edited as text
//! with the patterns of the Node code (`JsRegex`), so a match is the one V8 finds; offsets are byte offsets (Node's are UTF-16
//! units: the text between two offsets is the same). Node's `async` is gone: the package is in memory. A table that names
//! no widths is measured in its own face and a picture is read from a file, so those two edits take the measurer and the
//! read proof.

use std::cell::{Cell, RefCell};

use mixdog_fsio::ReadProof;
use mixdog_js::time::{Tz, local_fields_in, local_offset_ms};
use mixdog_js::{js_to_lowercase, js_trim, json_number, locale_compare_en, number_to_string, to_number, value_to_string};
use serde_json::{Map, Value, json};

use crate::docx_formatting::{format_first_body_phrase, patch_paragraph_format};
use crate::docx_operations::{docx_heading_levels, docx_toc_cache_runs, docx_toc_entries, replace_tracked_paragraphs};
use crate::docx_parts::{
    HeaderFooter, LIST_HANGING_POINTS, NumberingChoice, PartDefinition, PartText, SETTINGS_CONTENT_TYPE, SETTINGS_ORDER, WORD_2010_NS,
    WordDrawing, add_document_image, anchor_docx_comment, appended_numbering, comment_paragraph_id, document_section_spans,
    ensure_comments_part, ensure_docx_update_fields, ensure_numbering, ensure_part, forget_comment_identity, mark_runs_deleted,
    next_revision_id, numbered_list_scheme, numbering_after, register_comment_identity, register_comment_thread, revision_attributes,
    trailing_section_properties, upsert_section_child, upsert_section_reference, word_drawing_xml, write_every_section_properties,
    write_header_footer_part,
};
use crate::docx_runs::normalize_docx_runs;
use crate::docx_styles::document_style_id;
use crate::docx_tracked_edits::{PhraseMarkers, anchor_phrase_in_paragraph, tracked_paragraph_rewrite};
use crate::docx_xml::{
    Numbering, align_word_table_columns, blank_table_cells, check_docx_column, docx_table, insert_docx_block_at,
    missing_docx_cell_error, missing_docx_row_error, paragraph_format_xml, replace_docx_table, replace_word_properties, rewrite_table_columns,
    row_cell_matches, section_text_width, table_row_matches, with_first_run_text, word_justification, word_paragraph, word_run_properties,
    word_table_properties, word_table_xml, word_text_content, word_text_element,
};
use crate::opc::{PIXELS_TO_POINTS, add_package_relationship, part_relationship_path, provenance_citation};
use crate::slide_shapes::replace_first_with;
use crate::snapshot_docx::{BodyBlock, DocxBodyModel, append_docx_block, docx_body_model};
use crate::template_tokens::{FillTemplate, fill_template_parts};
use crate::text_metrics::TextMeasurer;
use crate::xlsx_audit_support::truthy;
use crate::xml::{
    Container, OFFICE_RELATIONSHIP_BASE, Replaced, WORD_MAIN_NS, XML_HEADER, compiled, container_inner, paragraph_texts, replace_across_runs,
    text_nodes, top_level_elements, upsert_ordered_child, xml_encode,
};
use crate::zipio::Package;

const DOCUMENT_PART: &str = "word/document.xml";
const STORY_VARIANTS: [&str; 3] = ["default", "first", "even"];

/// What the dispatcher carries from one operation to the next: the story parts of the package and whether the document tracks
/// its changes.
#[derive(Debug, Clone, Copy)]
pub struct DocxContext<'a> {
    pub parts: &'a [String],
    pub tracking: bool,
}

// ---- small readers of what Node reads off an operation -----------------------------------------------------------------------

/// A value as a template literal prints it (`undefined` for an absent one).
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    value.filter(|value| truthy(Some(*value))).map(value_to_string).unwrap_or_default()
}

/// `String(value ?? '')`.
fn text_or_blank(value: Option<&Value>) -> String {
    value.filter(|value| !value.is_null()).map(value_to_string).unwrap_or_default()
}

/// `Number(value)` of a field that may be missing (`undefined`, so NaN).
fn number_of(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `Number(value) || fallback`.
fn or_else(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() { fallback } else { value }
}

/// The element at a 1-based position a caller named (`items[Number(x) - 1]`); none for a position that is not a whole number
/// inside the list.
fn nth<T>(items: &[T], one_based: f64) -> Option<&T> {
    let index = one_based - 1.0;
    if index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64 { items.get(index as usize) } else { None }
}

/// The result object of an operation, opened with its own `op`.
fn result_of(op: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    if let Some(name) = op.get("op") {
        result.insert("op".to_owned(), name.clone());
    }
    result
}

fn is_op(op: &Value, name: &str) -> bool {
    op.get("op").and_then(Value::as_str) == Some(name)
}

/// The first group of a pattern's first match.
fn first_group(pattern: &str, text: &str) -> Option<String> {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1)).map(str::to_owned)
}

/// `Number(op.properties?.x)`-style reading of the properties an operation carries (`op.properties || {}`).
fn properties_of(op: &Value) -> Value {
    match op.get("properties") {
        Some(properties) if truthy(Some(properties)) => properties.clone(),
        _ => json!({}),
    }
}

/// `text.replace(search, () => replacement)` for a string search: the first occurrence.
fn replace_text(text: &str, search: &str, replacement: &str) -> String {
    text.replacen(search, replacement, 1)
}

// ---- paragraphs of the body ----------------------------------------------------------------------------------------------

fn body_paragraphs(model: &DocxBodyModel) -> Vec<&BodyBlock> {
    model.blocks.iter().filter(|block| block.name == "w:p").collect()
}

/// The 1-based body paragraph an operation names, or the usual error.
fn body_paragraph_at(model: &DocxBodyModel, ordinal: Option<&Value>) -> Result<BodyBlock, String> {
    nth(&body_paragraphs(model), number_of(ordinal))
        .map(|paragraph| (*paragraph).clone())
        .ok_or_else(|| format!("DOCX paragraph {} not found", shown(ordinal)))
}

/// `insertDocxBlockAt(document, block, op.paragraph)`: the block after the numbered paragraph, or at the end of the body when the
/// operation names none. A name that is no number (or a text that reads as 0) is a paragraph that is not there (the shared helper takes a number).
fn insert_block_after(current: &str, block: &str, paragraph: Option<&Value>) -> Result<String, String> {
    if !truthy(paragraph) {
        return insert_docx_block_at(current, block, 0.0);
    }
    let number = number_of(paragraph);
    if number.is_nan() || number == 0.0 {
        if docx_body_model(current).body.is_none() {
            return Err("DOCX document body is missing".to_owned());
        }
        return Err(format!("DOCX paragraph {} not found", shown(paragraph)));
    }
    insert_docx_block_at(current, block, number)
}

/// The paragraphs inside the body's tables, with offsets into the body like a top-level paragraph's, so one can be spliced back
/// the same way.
fn table_cell_paragraphs(model: &DocxBodyModel) -> Vec<BodyBlock> {
    let mut paragraphs = Vec::new();
    for block in model.blocks.iter().filter(|entry| entry.name == "w:tbl") {
        let Some(table) = container_inner(&block.xml, "w:tbl", 0) else { continue };
        for row in top_level_elements(&table.inner, &["w:tr"]) {
            let row_start = block.start + table.start + row.start;
            let Some(row_inner) = container_inner(&row.xml, "w:tr", 0) else { continue };
            for cell in top_level_elements(&row_inner.inner, &["w:tc"]) {
                let cell_start = row_start + row_inner.start + cell.start;
                let Some(cell_inner) = container_inner(&cell.xml, "w:tc", 0) else { continue };
                for paragraph in top_level_elements(&cell_inner.inner, &["w:p"]) {
                    let start = cell_start + cell_inner.start + paragraph.start;
                    paragraphs.push(BodyBlock { name: paragraph.name, start, end: start + paragraph.xml.len(), xml: paragraph.xml, logical_index: 0 });
                }
            }
        }
    }
    paragraphs
}

/// A phrase the body does not hold may sit in a table cell, where Word anchors a comment, hyperlink, or bookmark just as well;
/// without Office this was the only backend, and a Mac could not comment on any table text.
fn paragraph_containing(model: &DocxBodyModel, find: &str) -> Option<BodyBlock> {
    let holds = |entry: &BodyBlock| paragraph_texts(&entry.xml, "w:t").join("").contains(find);
    if let Some(found) = body_paragraphs(model).into_iter().find(|entry| holds(entry)) {
        return Some(found.clone());
    }
    table_cell_paragraphs(model).into_iter().find(|entry| holds(entry))
}

/// Splice one rewritten paragraph back into the document body.
fn replace_body_paragraph(current: &str, body: &Container, paragraph: &BodyBlock, next_paragraph: &str) -> String {
    let next_inner = format!("{}{next_paragraph}{}", &body.inner[..paragraph.start], &body.inner[paragraph.end..]);
    format!("{}{next_inner}{}", &current[..body.start], &current[body.end..])
}

fn body_of(model: &DocxBodyModel) -> &Container {
    model.body.as_ref().expect("a body holds the paragraph")
}

// ---- comments ------------------------------------------------------------------------------------------------------------------

fn comment_entry_xml(id: u64, op: &Value, text: &str, stamp: &str) -> String {
    let author = text_or_empty(op.get("author"));
    let initials = text_or_empty(op.get("initials"));
    format!(
        "<w:comment w:id=\"{id}\" w:author=\"{}\" w:date=\"{stamp}\" w:initials=\"{}\">\
<w:p xmlns:w14=\"{WORD_2010_NS}\" w14:paraId=\"{}\"><w:r>{}</w:r></w:p></w:comment>",
        xml_encode(if author.is_empty() { "Mixdog" } else { &author }),
        xml_encode(if initials.is_empty() { "MD" } else { &initials }),
        comment_paragraph_id(id),
        word_text_element(text, false)
    )
}

/// `Math.max(0, ...ids) + 1`.
fn next_comment_id(comments_xml: &str) -> u64 {
    let ids = compiled(r#"<w:comment\b[^>]*\bw:id="(\d+)""#, "g");
    ids.captures_iter(comments_xml).map(|found| found.get(1).and_then(|digits| digits.parse::<u64>().ok()).unwrap_or(0)).fold(0, u64::max) + 1
}

/// `date.toISOString().replace(/\.\d+Z$/, 'Z')` of an instant.
fn iso_stamp(ms: f64) -> String {
    local_fields_in(Tz::UTC, ms).map_or_else(String::new, |fields| {
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second)
    })
}

/// Word keeps a comment's w:date in local wall-clock time (under a Z it does not mean) and the instant itself in
/// commentsExtensible's dateUtc. Written in UTC, a comment added in Seoul read nine hours early in Word's thread.
fn comment_stamps() -> (String, String) {
    let now = mixdog_office_base::clock::now_ms();
    (iso_stamp(now + local_offset_ms(now) as f64), iso_stamp(now))
}

fn comment_entry_pattern(id: u64) -> String {
    format!(r#"<w:comment\b[^>]*\bw:id="{id}"[^>]*>[\s\S]*?<\/w:comment>"#)
}

/// A new comment is one entry in the comments part plus the thread and the identity records that carry its author and
/// timestamp. `parent` is the comment a reply answers (0 for none).
fn append_comment(zip: &mut Package, comments: &PartText, op: &Value, text: &str, parent: u64) -> u64 {
    let id = next_comment_id(&comments.xml);
    let (local, utc) = comment_stamps();
    zip.set(&comments.part, replace_text(&comments.xml, "</w:comments>", &format!("{}</w:comments>", comment_entry_xml(id, op, text, &local))));
    register_comment_thread(zip, id, parent, false);
    register_comment_identity(zip, id, &utc);
    id
}

/// The stories text can stand in, body first; the comments part carries no text of its own.
fn docx_story_part_names(zip: &Package) -> Vec<String> {
    let story = compiled(r"^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$", "i");
    let mut names: Vec<String> = zip.names().into_iter().filter(|name| story.is_match(name)).collect();
    names.sort_by(|left, right| {
        (right == DOCUMENT_PART).cmp(&(left == DOCUMENT_PART)).then_with(|| locale_compare_en(left, right))
    });
    names
}

/// A caller that names the thing it wants (kind:'footer') must get a footer. Reading that name as an unknown page variant wrote
/// the text into a second header instead, and reported success for a document whose footer never existed. `named` is the
/// story/variant word, `kind` the resolved page variant.
fn story_target(op: &Value) -> Result<(String, String), String> {
    let named = js_to_lowercase(&text_or_empty(op.get("kind")));
    let name = shown(op.get("op"));
    if !named.is_empty() && !["header", "footer"].contains(&named.as_str()) && !STORY_VARIANTS.contains(&named.as_str()) {
        return Err(format!("{name} kind must be header, footer, {}", STORY_VARIANTS.join(", ")));
    }
    let requested = js_to_lowercase(&text_or_empty(op.get("variant")));
    if !requested.is_empty() && !STORY_VARIANTS.contains(&requested.as_str()) {
        return Err(format!("{name} variant must be {}", STORY_VARIANTS.join(", ")));
    }
    let kind = if !requested.is_empty() {
        requested
    } else if STORY_VARIANTS.contains(&named.as_str()) {
        named.clone()
    } else {
        "default".to_owned()
    };
    Ok((named, kind))
}

// ---- track changes, templates and text ---------------------------------------------------------------------------------

/// `setDocxTrackChanges(zip, op)`: the new state is answered with the result so the dispatcher can carry it to the following
/// operations.
pub fn set_docx_track_changes(zip: &mut Package, op: &Value) -> (Value, bool) {
    let enabled = op.get("enabled") != Some(&Value::Bool(false));
    let part = "word/settings.xml";
    let created = format!("{XML_HEADER}<w:settings xmlns:w=\"{WORD_MAIN_NS}\"></w:settings>");
    let settings = ensure_part(
        zip,
        &PartDefinition {
            part,
            xml: &created,
            content_type: SETTINGS_CONTENT_TYPE,
            relationship: &format!("{OFFICE_RELATIONSHIP_BASE}/settings"),
        },
    );
    zip.set(part, upsert_ordered_child(&settings, &SETTINGS_ORDER, "w:trackRevisions", if enabled { "<w:trackRevisions/>" } else { "" }));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("enabled".to_owned(), json!(enabled));
    (Value::Object(result), enabled)
}

/// `fillDocxTemplate(zip, op, { parts, tracking })`: under track changes each token becomes a tracked deletion plus the
/// inserted value, so a filled template still passes the redlining audit.
pub fn fill_docx_template(zip: &mut Package, op: &Value, context: &DocxContext<'_>) -> Result<Value, String> {
    let author = text_or_empty(op.get("author"));
    let fill = FillTemplate { tokens: op.get("tokens").unwrap_or(&Value::Null), strict: truthy(op.get("strict")) };
    let filled = if context.tracking {
        let replace = |xml: &str, _tag: &str, find: &str, replacement: &str| -> Result<Replaced, String> {
            let done = replace_tracked_paragraphs(xml, find, replacement, &author)?;
            Ok(Replaced { xml: done.xml, count: done.count })
        };
        fill_template_parts(zip, context.parts, "w:t", &fill, &replace)?
    } else {
        fill_template_parts(zip, context.parts, "w:t", &fill, &replace_across_runs)?
    };
    let mut result = filled.to_value();
    if context.tracking {
        if let Value::Object(map) = &mut result {
            map.insert("tracked".to_owned(), json!(true));
        }
    }
    Ok(result)
}

/// `replaceDocxText(zip, op, { parts, tracking })`.
pub fn replace_docx_text(zip: &mut Package, op: &Value, context: &DocxContext<'_>) -> Result<Value, String> {
    let find = text_or_empty(op.get("find"));
    let replacement = text_or_blank(op.get("replace"));
    let author = text_or_empty(op.get("author"));
    let mut count = 0_usize;
    let mut paragraph_rewrites = 0_usize;
    for part in context.parts {
        let current = zip.text(part);
        let (xml, replaced, rewrites) = if context.tracking {
            let done = replace_tracked_paragraphs(&current, &find, &replacement, &author)?;
            (done.xml, done.count, done.paragraph_rewrites)
        } else {
            let done = replace_across_runs(&current, "w:t", &find, &replacement)?;
            (done.xml, done.count, 0)
        };
        if replaced > 0 {
            zip.set(part, xml);
        }
        count += replaced;
        paragraph_rewrites += rewrites;
    }
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(count > 0));
    result.insert("count".to_owned(), json!(count));
    if context.tracking {
        result.insert("tracked".to_owned(), json!(true));
        result.insert("granularity".to_owned(), json!(if paragraph_rewrites > 0 { "paragraph" } else { "run" }));
        if paragraph_rewrites > 0 {
            result.insert("paragraphRewrites".to_owned(), json!(paragraph_rewrites));
            result.insert(
                "note".to_owned(),
                json!(format!(
                    "{paragraph_rewrites} paragraph(s) held the match across a tab, break, field, or drawing and were rewritten whole: their runs are marked deleted and one inserted run carries the new text."
                )),
            );
        }
    }
    Ok(Value::Object(result))
}

/// On an item this call puts in a list, indentLeft places its mark and the text hangs one list step after it, as the Word
/// backend sets it: read as the text's edge, as a Word left indent is, a callout's 12 pt inset hung the bullet 6 pt outside the
/// field and into the page margin. An indentFirstLine given with it is taken as it stands.
fn list_item_indent(properties: &Value, numbering: bool) -> Value {
    if !numbering || properties.get("indentLeft").is_none() || properties.get("indentFirstLine").is_some() {
        return properties.clone();
    }
    let mut next = properties.clone();
    if let Value::Object(map) = &mut next {
        map.insert("indentLeft".to_owned(), json_number(number_of(properties.get("indentLeft")) + f64::from(LIST_HANGING_POINTS)));
        map.insert("indentFirstLine".to_owned(), json_number(-f64::from(LIST_HANGING_POINTS)));
    }
    next
}

/// The list membership a paragraph format writes (`{ numId, level: properties.listLevel }`).
fn list_membership(properties: &Value, num_id: u64) -> Numbering {
    Numbering { level: number_of(properties.get("listLevel")), num_id: num_id.to_string() }
}

/// `appendDocxText(zip, op, { tracking })`.
pub fn append_docx_text(zip: &mut Package, op: &Value, context: &DocxContext<'_>) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let properties = properties_of(op);
    let list_kind = js_to_lowercase(&text_or_empty(properties.get("listKind")));
    let mut numbering = None;
    // listKind:'none' is a plain paragraph, as Word's backend reads it; it had drawn a bullet here.
    if list_kind == "number" {
        let scheme = numbered_list_scheme(&text_or_blank(op.get("text")), &text_or_blank(properties.get("listNumbering")))?;
        numbering = Some(appended_numbering(zip, &current, &NumberingChoice { continued: truthy(properties.get("listContinue")), scheme }));
    } else if !list_kind.is_empty() && list_kind != "none" {
        numbering = Some(ensure_numbering(zip, "bullet", false));
    }
    let requested_style = [op.get("style"), properties.get("style")]
        .into_iter()
        .flatten()
        .find(|value| truthy(Some(*value)))
        .map(value_to_string)
        .unwrap_or_else(|| if numbering.is_some() { "List Paragraph".to_owned() } else { String::new() });
    let resolved = document_style_id(zip, &requested_style, "paragraph");
    let membership = numbering.as_ref().map(|part| list_membership(&properties, part.num_id));
    let format = paragraph_format_xml(&list_item_indent(&properties, numbering.is_some()), membership.as_ref());
    let style_xml = if resolved.id.is_empty() { String::new() } else { format!("<w:pStyle w:val=\"{}\"/>", xml_encode(&resolved.id)) };
    let paragraph_properties = if resolved.id.is_empty() && format.is_empty() { String::new() } else { format!("<w:pPr>{style_xml}{format}</w:pPr>") };
    let run_properties = word_run_properties(&properties);
    let run = format!(
        "<w:r>{}{}</w:r>",
        if run_properties.is_empty() { String::new() } else { format!("<w:rPr>{run_properties}</w:rPr>") },
        word_text_content(&text_or_empty(op.get("text")), false)
    );
    let content = if context.tracking {
        // The reviewer's label comes where it does on every other tracked edit (beside the operation), and the older nested
        // spelling still works.
        let author = match op.get("author") {
            Some(author) if !author.is_null() => text_or_empty(Some(author)),
            _ => text_or_empty(properties.get("author")),
        };
        format!("<w:ins {}>{run}</w:ins>", revision_attributes(next_revision_id(&current), &author))
    } else {
        run
    };
    let block = format!("<w:p>{paragraph_properties}{content}</w:p>");
    zip.set(DOCUMENT_PART, append_docx_block(&current, &block)?);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("style".to_owned(), json!(resolved.id));
    if !resolved.found {
        result.insert("styleNotFound".to_owned(), json!(requested_style));
    }
    if context.tracking {
        result.insert("tracked".to_owned(), json!(true));
    }
    Ok(Value::Object(result))
}

// ---- tables ----------------------------------------------------------------------------------------------------------------------

/// A table style the document does not define is dropped (and reported), so the table takes the default rules as the Word
/// backend draws it: kept, it named a style Word could not find and the table printed bare. Both styles take the ids the
/// document carries for them.
fn with_known_table_style(zip: &mut Package, op: &Value) -> (Value, Option<String>) {
    let Some(Value::Object(original)) = op.get("properties") else { return (op.clone(), None) };
    let style = original.get("style").filter(|value| truthy(Some(*value)));
    let text_style = original.get("textStyle").filter(|value| truthy(Some(*value)));
    if style.is_none() && text_style.is_none() {
        return (op.clone(), None);
    }
    let mut properties = original.clone();
    let mut style_not_found = None;
    if let Some(style) = style {
        let resolved = document_style_id(zip, &value_to_string(style), "table");
        if resolved.found {
            properties.insert("style".to_owned(), json!(resolved.id));
        } else {
            properties.remove("style");
            style_not_found = Some(value_to_string(style));
        }
    }
    if let Some(text_style) = text_style {
        properties.insert("textStyle".to_owned(), json!(document_style_id(zip, &value_to_string(text_style), "paragraph").id));
    }
    let mut next = op.clone();
    if let Value::Object(map) = &mut next {
        map.insert("properties".to_owned(), Value::Object(properties));
    }
    (next, style_not_found)
}

/// `addDocxTable(zip, requested)`: the table lands after the named paragraph, or at the end of the body.
pub fn add_docx_table<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &mut Package, requested: &Value) -> Result<Value, String> {
    let (op, style_not_found) = with_known_table_style(zip, requested);
    let mut current = zip.text(DOCUMENT_PART);
    let mut measure = |text: &str, font: &crate::text_metrics::FontSpec| measurer.measure_text_width(text, font).map_err(|error| error.to_string());
    if truthy(op.get("paragraph")) {
        let model = docx_body_model(&current);
        let paragraph = body_paragraph_at(&model, op.get("paragraph"))?;
        let body = body_of(&model);
        let table = word_table_xml(&op, section_text_width(&current, body.start + paragraph.end) / 20.0, &mut measure)?;
        let next_inner = format!("{}{table}{}", &body.inner[..paragraph.end], &body.inner[paragraph.end..]);
        current = format!("{}{next_inner}{}", &current[..body.start], &current[body.end..]);
    } else {
        // Appended into the last section, whose properties close the body.
        let trailing = current.rfind("<w:sectPr").unwrap_or(0);
        let table = word_table_xml(&op, section_text_width(&current, trailing) / 20.0, &mut measure)?;
        current = append_docx_block(&current, &table)?;
    }
    zip.set(DOCUMENT_PART, current.as_str());
    let mut result = result_of(&op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("table".to_owned(), json!(docx_body_model(&current).blocks.iter().filter(|block| block.name == "w:tbl").count()));
    if let Some(style) = style_not_found {
        result.insert("styleNotFound".to_owned(), json!(style));
    }
    Ok(Value::Object(result))
}

/// `setDocxParagraphStyle(zip, op)`.
pub fn set_docx_paragraph_style(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let named = if truthy(op.get("style")) { value_to_string(&op["style"]) } else { "Normal".to_owned() };
    let resolved = document_style_id(zip, &named, "paragraph");
    let current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraph = body_paragraph_at(&model, op.get("paragraph"))?;
    let style = xml_encode(&resolved.id);
    let properties_open = compiled(r"<w:pPr(?:\s[^>]*)?>", "");
    let style_element = compiled(r"<w:pStyle\b[^>]*\/>", "");
    let next_paragraph = if properties_open.is_match(&paragraph.xml) {
        if style_element.is_match(&paragraph.xml) {
            replace_first_with(&style_element, &paragraph.xml, |_| format!("<w:pStyle w:val=\"{style}\"/>"))
        } else {
            replace_first_with(&properties_open, &paragraph.xml, |found| format!("{}<w:pStyle w:val=\"{style}\"/>", found.get(0).unwrap_or("")))
        }
    } else {
        replace_first_with(&compiled(r"<w:p(?:\s[^>]*)?>", ""), &paragraph.xml, |found| {
            format!("{}<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>", found.get(0).unwrap_or(""))
        })
    };
    zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body_of(&model), &paragraph, &next_paragraph));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("style".to_owned(), if truthy(op.get("style")) { op["style"].clone() } else { json!("Normal") });
    if !resolved.found {
        result.insert("styleNotFound".to_owned(), json!(shown(op.get("style"))));
    }
    Ok(Value::Object(result))
}

/// `setDocxTableCell(zip, op, { tracking })`.
pub fn set_docx_table_cell(zip: &mut Package, op: &Value, context: &DocxContext<'_>) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let table = docx_table(&current, op.get("table"))?;
    let rows = table_row_matches(&table.xml);
    let Some(row) = nth(&rows, number_of(op.get("row"))) else { return Err(missing_docx_row_error(op, &table.xml)) };
    let cells = row_cell_matches(&row.xml);
    let Some(cell) = nth(&cells, number_of(op.get("col"))) else { return Err(missing_docx_cell_error(op, &cells)) };
    let text = text_or_blank(op.get("text"));
    let author = text_or_empty(op.get("author"));
    let next_cell = if context.tracking {
        // The first paragraph takes the new text as a tracked rewrite; any further paragraph in the cell is marked deleted.
        let id = Cell::new(next_revision_id(&current));
        let first = Cell::new(true);
        let failure: RefCell<Option<String>> = RefCell::new(None);
        let run_open = compiled(r"<w:r(?:\s[^>]*)?>", "g");
        let rewritten = compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g").replace_all_with(&cell.xml, |found| {
            let paragraph = found.get(0).unwrap_or("");
            let run_count = run_open.find_iter(paragraph).count() as u64;
            if first.get() {
                first.set(false);
                return match tracked_paragraph_rewrite(paragraph, &text, id.get(), &author) {
                    Ok(rewritten) => {
                        id.set(id.get() + run_count + 1);
                        rewritten
                    }
                    Err(message) => {
                        *failure.borrow_mut() = Some(message);
                        paragraph.to_owned()
                    }
                };
            }
            let deleted = mark_runs_deleted(paragraph, id.get(), &author);
            id.set(id.get() + run_count);
            deleted
        });
        if let Some(message) = failure.into_inner() {
            return Err(message);
        }
        if first.get() {
            replace_text(
                &cell.xml,
                "</w:tc>",
                &format!("<w:p><w:ins {}><w:r>{}</w:r></w:ins></w:p></w:tc>", revision_attributes(id.get(), &author), word_text_content(&text, true)),
            )
        } else {
            rewritten
        }
    } else if !text_nodes(&cell.xml, "w:t").is_empty() {
        with_first_run_text(&cell.xml, &text)
    } else {
        replace_text(&cell.xml, "</w:tc>", &format!("<w:p><w:r>{}</w:r></w:p></w:tc>", word_text_content(&text, false)))
    };
    let next_row = replace_text(&row.xml, &cell.xml, &next_cell);
    let next_table = replace_text(&table.xml, &row.xml, &next_row);
    zip.set(DOCUMENT_PART, format!("{}{next_table}{}", &current[..table.index], &current[table.index + table.xml.len()..]));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    if context.tracking {
        result.insert("tracked".to_owned(), json!(true));
    }
    Ok(Value::Object(result))
}

/// `setDocxTableStyle(zip, requested)`.
pub fn set_docx_table_style(zip: &mut Package, requested: &Value) -> Result<Value, String> {
    let (op, style_not_found) = with_known_table_style(zip, requested);
    let current = zip.text(DOCUMENT_PART);
    let table = docx_table(&current, op.get("table"))?;
    // Restyling a table must not undo its width: the declared width is part of the layout, not of the style being replaced.
    let declared_width = first_group(r#"<w:tblW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa""#, &table.xml)
        .map_or(0.0, |digits| or_else(to_number(&Value::String(digits)), 0.0));
    let no_properties = Value::Null;
    let properties = op.get("properties").unwrap_or(&no_properties);
    let alignments: Vec<Value> = properties.get("columnAlignments").and_then(Value::as_array).cloned().unwrap_or_default();
    let next_table = align_word_table_columns(
        &replace_word_properties(&table.xml, "tbl", "tblPr", &word_table_properties(properties, declared_width)),
        &alignments,
    );
    zip.set(DOCUMENT_PART, replace_docx_table(&current, &table, &next_table));
    let mut result = result_of(&op);
    result.insert("changed".to_owned(), json!(next_table != table.xml));
    result.insert("table".to_owned(), json_number(number_of(op.get("table"))));
    if let Some(style) = style_not_found {
        result.insert("styleNotFound".to_owned(), json!(style));
    }
    Ok(Value::Object(result))
}

/// `editDocxTableRowsOrColumns(zip, op)`: insert_table_row, delete_table_row, insert_table_column and delete_table_column.
pub fn edit_docx_table_rows_or_columns(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let table = docx_table(&current, op.get("table"))?;
    let mut next_table = table.xml.clone();
    if is_op(op, "insert_table_row") || is_op(op, "delete_table_row") {
        let rows = table_row_matches(&table.xml);
        if rows.is_empty() {
            return Err(format!("DOCX table {} has no rows", shown(op.get("table"))));
        }
        if is_op(op, "delete_table_row") {
            if rows.len() <= 1 {
                return Err("A table must keep at least one row".to_owned());
            }
            let Some(row) = nth(&rows, number_of(op.get("row"))) else { return Err(missing_docx_row_error(op, &table.xml)) };
            next_table = format!("{}{}", &table.xml[..row.index], &table.xml[row.index + row.xml.len()..]);
        } else {
            // A row past the end was taken as the end: row 4 of a two-row table added a row to it, and the cells written into
            // "row 5" next failed against a table the caller had not meant. Word refuses it too.
            let named = op.get("row").filter(|value| !value.is_null());
            if let Some(named) = named {
                let row = to_number(named);
                if !(row.fract() == 0.0 && row >= 1.0 && row <= (rows.len() + 1) as f64) {
                    return Err(missing_docx_row_error(op, &table.xml));
                }
            }
            let position = mixdog_js::math::max(
                1.0,
                mixdog_js::math::min(or_else(number_of(op.get("row")), (rows.len() + 1) as f64), (rows.len() + 1) as f64),
            ) as usize;
            let template = &rows[position.min(rows.len()) - 1];
            let blank = blank_table_cells(&template.xml);
            next_table = if position > rows.len() {
                match table.xml.strip_suffix("</w:tbl>") {
                    Some(head) => format!("{head}{blank}</w:tbl>"),
                    None => table.xml.clone(),
                }
            } else {
                format!("{}{blank}{}", &table.xml[..template.index], &table.xml[template.index..])
            };
        }
    } else {
        let column_index = check_docx_column(op, &table.xml)?;
        next_table = rewrite_table_columns(&table.xml, column_index, is_op(op, "delete_table_column"))?;
    }
    zip.set(DOCUMENT_PART, replace_docx_table(&current, &table, &next_table));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(next_table != table.xml));
    result.insert("table".to_owned(), json_number(number_of(op.get("table"))));
    Ok(Value::Object(result))
}

// ---- paragraph format, lists, pictures -------------------------------------------------------------------------------------

/// `setDocxParagraphFormat(zip, op)`.
pub fn set_docx_paragraph_format(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let properties = properties_of(op);
    let list_kind = js_to_lowercase(&text_or_empty(properties.get("listKind")));
    let current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraph = body_paragraph_at(&model, op.get("paragraph"))?;
    let body = body_of(&model);
    let mut numbering = None;
    // listKind:'none' takes the paragraph out of its list, as set_list does; it had drawn a bullet here.
    if list_kind == "number" {
        let scheme = numbered_list_scheme(&paragraph_texts(&paragraph.xml, "w:t").join(""), &text_or_blank(properties.get("listNumbering")))?;
        numbering = Some(numbering_after(
            zip,
            &body.inner[..paragraph.start],
            &NumberingChoice { continued: truthy(properties.get("listContinue")), scheme },
        ));
    } else if !list_kind.is_empty() && list_kind != "none" {
        numbering = Some(ensure_numbering(zip, "bullet", false));
    }
    let mut source = paragraph.xml.clone();
    if list_kind == "none" {
        // The paragraph's own list reference, not the one a tracked formatting change records under it.
        let own = compiled(r"<w:numPr>[\s\S]*?<\/w:numPr>", "").find(&source);
        let change = source.find("<w:pPrChange");
        if let Some(own) = own {
            if change.is_none_or(|change| own.start < change) {
                source = format!("{}{}", &source[..own.start], &source[own.end..]);
            }
        }
    }
    let membership = numbering.as_ref().map(|part| list_membership(&properties, part.num_id));
    let next_paragraph = patch_paragraph_format(&source, &list_item_indent(&properties, numbering.is_some()), membership.as_ref())?;
    zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body, &paragraph, &next_paragraph));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(next_paragraph != paragraph.xml));
    result.insert("paragraph".to_owned(), json_number(number_of(op.get("paragraph"))));
    Ok(Value::Object(result))
}

/// `addDocxImage(zip, op)`.
pub fn add_docx_image<P: ReadProof>(proof: &P, zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let media = add_document_image(proof, zip, &text_or_empty(op.get("path")))?;
    let pixels = media.pixels;
    // A picture given no size is as wide as its pixels up to the text width, as Word fits it on insertion: a 1400 px screenshot
    // ran 1050 pt across a 450 pt column.
    let text_width = section_text_width(&current, current.rfind("<w:sectPr").unwrap_or(0)) / 20.0;
    let natural_width = pixels.map_or(240.0, |size| mixdog_js::math::min(f64::from(size.width) * PIXELS_TO_POINTS, text_width));
    let requested_width = number_of(op.get("width"));
    let width = if requested_width > 0.0 { requested_width } else { natural_width };
    // A requested width scales the natural height so the picture keeps its aspect ratio.
    let scale = pixels.map_or(1.0, |size| width / (f64::from(size.width) * PIXELS_TO_POINTS));
    let natural_height = pixels.map_or(180.0, |size| f64::from(size.height) * PIXELS_TO_POINTS * scale);
    let requested_height = number_of(op.get("height"));
    let height = if requested_height > 0.0 { requested_height } else { natural_height };
    let id = compiled(r#"<wp:docPr\b[^>]*\bid="(\d+)""#, "g")
        .captures_iter(&current)
        .map(|found| found.get(1).and_then(|digits| digits.parse::<u64>().ok()).unwrap_or(0))
        .fold(0, u64::max)
        + 1;
    // The picture keeps with the paragraph after it (its caption) unless the caller says otherwise: a picture that ended a page
    // left "그림 1." alone at the top of the next. properties.alignment places it (a centred figure).
    let mut format_properties = Map::new();
    format_properties.insert("keepWithNext".to_owned(), json!(true));
    if let Some(Value::Object(own)) = op.get("properties") {
        for (key, value) in own {
            format_properties.insert(key.clone(), value.clone());
        }
    }
    let format = paragraph_format_xml(&Value::Object(format_properties), None);
    let alt_text = text_or_blank(op.get("altText"));
    let drawing = word_drawing_xml(&WordDrawing { id, embed_id: &media.relationship_id, name: &media.name, width, height, alt_text: &alt_text });
    let block = format!("<w:p>{}<w:r>{drawing}</w:r></w:p>", if format.is_empty() { String::new() } else { format!("<w:pPr>{format}</w:pPr>") });
    zip.set(DOCUMENT_PART, insert_block_after(&current, &block, op.get("paragraph"))?);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("image".to_owned(), json!(media.part));
    result.insert("width".to_owned(), json_number(width));
    result.insert("height".to_owned(), json_number(height));
    let alt = js_trim(&alt_text);
    if !alt.is_empty() {
        result.insert("altText".to_owned(), json!(alt));
    }
    Ok(Value::Object(result))
}

/// `setDocxList(zip, op)`.
pub fn set_docx_list(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let kind_word = if truthy(op.get("kind")) { value_to_string(&op["kind"]) } else { "bullet".to_owned() };
    let requested = js_to_lowercase(&kind_word);
    let current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraph = body_paragraph_at(&model, op.get("paragraph"))?;
    let body = body_of(&model);
    let existing = first_group(r"<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>", &paragraph.xml).unwrap_or_default();
    let list_reference = compiled(r"<w:numPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:numPr>)", "");
    // kind:'none' takes the paragraph out of its list and leaves its style, as Word's RemoveNumbers does: read as a bullet, it
    // had put one on the paragraph it was asked to clear.
    if requested == "none" {
        let unlisted = replace_first_with(&list_reference, &existing, |_| String::new());
        let next_paragraph = replace_word_properties(&paragraph.xml, "p", "pPr", &unlisted);
        zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body, &paragraph, &next_paragraph));
        let mut result = result_of(op);
        result.insert("changed".to_owned(), json!(next_paragraph != paragraph.xml));
        result.insert("paragraph".to_owned(), json_number(number_of(op.get("paragraph"))));
        result.insert("kind".to_owned(), json!("none"));
        return Ok(Value::Object(result));
    }
    let kind = if requested == "number" { "number" } else { "bullet" };
    let numbering = if kind == "number" {
        let scheme = numbered_list_scheme(&paragraph_texts(&paragraph.xml, "w:t").join(""), &text_or_blank(op.get("numbering")))?;
        numbering_after(zip, &body.inner[..paragraph.start], &NumberingChoice { continued: false, scheme })
    } else {
        ensure_numbering(zip, "bullet", false)
    };
    // List Paragraph as the document names it ("a6" in a Korean Word document).
    let list_style = document_style_id(zip, "List Paragraph", "paragraph").id;
    let level = mixdog_js::math::max(0.0, mixdog_js::math::min(2.0, or_else(number_of(op.get("level")), 0.0)));
    let cleaned = replace_first_with(&compiled(r"<w:pStyle\b[^>]*\/>", ""), &replace_first_with(&list_reference, &existing, |_| String::new()), |_| String::new());
    let properties = format!(
        "<w:pStyle w:val=\"{}\"/><w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>{cleaned}",
        xml_encode(&list_style),
        number_to_string(level),
        numbering.num_id
    );
    let next_paragraph = replace_word_properties(&paragraph.xml, "p", "pPr", &properties);
    zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body, &paragraph, &next_paragraph));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("paragraph".to_owned(), json_number(number_of(op.get("paragraph"))));
    result.insert("kind".to_owned(), json!(kind));
    result.insert("numId".to_owned(), json!(numbering.num_id));
    Ok(Value::Object(result))
}

/// `addDocxHyperlink(zip, op)`.
pub fn add_docx_hyperlink(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let address = js_trim(&text_or_empty(op.get("address"))).to_owned();
    // Linking a phrase must not rewrite it: the reader asked for 정시 출고율 to become a link, not to be replaced by the raw
    // address. Only a caller naming display, or a link with no phrase to sit on, uses other text.
    let display = js_trim(
        &[op.get("display"), op.get("find"), Some(&Value::String(address.clone()))]
            .into_iter()
            .flatten()
            .find(|value| truthy(Some(*value)))
            .map(value_to_string)
            .unwrap_or_default(),
    )
    .to_owned();
    let sub_address = op.get("subAddress").filter(|value| truthy(Some(*value)));
    if address.is_empty() && sub_address.is_none() {
        return Err("add_hyperlink requires address or subAddress".to_owned());
    }
    if display.is_empty() {
        return Err("add_hyperlink requires display text".to_owned());
    }
    let mut current = zip.text(DOCUMENT_PART);
    let relationship_id = if address.is_empty() {
        String::new()
    } else {
        add_package_relationship(zip, &part_relationship_path(DOCUMENT_PART), &format!("{OFFICE_RELATIONSHIP_BASE}/hyperlink"), &address, "External")
    };
    let run = format!("<w:r><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr>{}</w:r>", word_text_element(&display, false));
    let link = format!(
        "<w:hyperlink{}{}>{run}</w:hyperlink>",
        if relationship_id.is_empty() { String::new() } else { format!(" r:id=\"{relationship_id}\"") },
        sub_address.map_or_else(String::new, |anchor| format!(" w:anchor=\"{}\"", xml_encode(&value_to_string(anchor))))
    );
    // A link asked for by phrase replaces that phrase, the way Word does it. Appending it to the end of the document instead
    // put the link somewhere the caller never named and still reported success.
    let find = text_or_empty(op.get("find"));
    let anchor;
    if !find.is_empty() {
        let model = docx_body_model(&current);
        let Some(paragraph) = paragraph_containing(&model, &find) else { return Err(format!("DOCX text not found for hyperlink: {find}")) };
        let markers = PhraseMarkers { start: Some(link), end: Some(String::new()), replace: true };
        let Some(linked) = anchor_phrase_in_paragraph(&paragraph.xml, &find, 0, Some(&markers)) else {
            return Err(format!("DOCX hyperlink phrase crosses a tab, break, field, or drawing: {find}"));
        };
        current = replace_body_paragraph(&current, body_of(&model), &paragraph, &linked);
        anchor = "phrase";
    } else if truthy(op.get("paragraph")) {
        let model = docx_body_model(&current);
        let paragraph = body_paragraph_at(&model, op.get("paragraph"))?;
        let next_paragraph = match paragraph.xml.strip_suffix("</w:p>") {
            Some(head) => format!("{head}{link}</w:p>"),
            None => paragraph.xml.clone(),
        };
        current = replace_body_paragraph(&current, body_of(&model), &paragraph, &next_paragraph);
        anchor = "paragraph";
    } else {
        current = append_docx_block(&current, &format!("<w:p>{link}</w:p>"))?;
        anchor = "appended";
    }
    zip.set(DOCUMENT_PART, current);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("address".to_owned(), json!(address));
    result.insert("display".to_owned(), json!(display));
    result.insert("anchor".to_owned(), json!(anchor));
    Ok(Value::Object(result))
}

/// `setDocxFont(zip, op)`.
pub fn set_docx_font(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let formatted = format_first_body_phrase(&current, &text_or_empty(op.get("find")), &properties_of(op))?;
    if formatted.changed {
        zip.set(DOCUMENT_PART, formatted.xml);
    }
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(formatted.changed));
    result.insert("scope".to_owned(), json!("body"));
    result.insert("matches".to_owned(), json!(1));
    Ok(Value::Object(result))
}

// ---- comments ------------------------------------------------------------------------------------------------------------------

/// `addDocxComment(zip, op)`: add_comment and add_provenance.
pub fn add_docx_comment(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let provenance = is_op(op, "add_provenance");
    let text = if provenance { provenance_citation(op.get("source").unwrap_or(&Value::Null)) } else { text_or_empty(op.get("text")) };
    if text.is_empty() {
        return Err(format!("{} requires {}", shown(op.get("op")), if provenance { "source" } else { "text" }));
    }
    let current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraph = if provenance {
        nth(&body_paragraphs(&model), number_of(op.get("paragraph"))).map(|found| (*found).clone())
    } else {
        paragraph_containing(&model, &text_or_empty(op.get("find")))
    };
    let Some(paragraph) = paragraph else {
        return Err(if provenance {
            format!("DOCX paragraph {} not found", shown(op.get("paragraph")))
        } else {
            format!("DOCX text not found for comment anchor: {}", shown(op.get("find")))
        });
    };
    let comments = ensure_comments_part(zip);
    let id = append_comment(zip, &comments, op, &text, 0);
    // A comment marks the phrase it was asked about; the paragraph only when the phrase cannot be cut out of its runs.
    let phrase = if is_op(op, "add_comment") { anchor_phrase_in_paragraph(&paragraph.xml, &text_or_empty(op.get("find")), id, None) } else { None };
    let anchored = phrase.clone().unwrap_or_else(|| anchor_docx_comment(&paragraph.xml, id));
    zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body_of(&model), &paragraph, &anchored));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("comment".to_owned(), json!(id));
    result.insert("anchor".to_owned(), json!(if phrase.is_some() { "phrase" } else { "paragraph" }));
    if provenance {
        result.insert("target".to_owned(), json!(format!("/body/p[{}]", number_to_string(number_of(op.get("paragraph"))))));
        result.insert("citation".to_owned(), json!(text));
    }
    Ok(Value::Object(result))
}

/// The comment id an operation names: a positive whole number.
fn comment_id_of(op: &Value) -> Option<u64> {
    let id = number_of(op.get("comment"));
    (id.fract() == 0.0 && id >= 1.0 && id.is_finite()).then_some(id as u64)
}

/// `replyOrResolveDocxComment(zip, op)`: add_comment_reply and set_comment_resolved.
pub fn reply_or_resolve_docx_comment(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let Some(parent) = comment_id_of(op) else { return Err(format!("{} requires a positive comment id", shown(op.get("op")))) };
    let comments = ensure_comments_part(zip);
    if !compiled(&comment_entry_pattern(parent), "").is_match(&comments.xml) {
        return Err(format!("DOCX comment {parent} not found"));
    }
    let mut result = result_of(op);
    if is_op(op, "set_comment_resolved") {
        let resolved = op.get("resolved") != Some(&Value::Bool(false));
        register_comment_thread(zip, parent, 0, resolved);
        result.insert("changed".to_owned(), json!(true));
        result.insert("comment".to_owned(), json!(parent));
        result.insert("resolved".to_owned(), json!(resolved));
        return Ok(Value::Object(result));
    }
    let text = text_or_empty(op.get("text"));
    if text.is_empty() {
        return Err("add_comment_reply requires text".to_owned());
    }
    let id = append_comment(zip, &comments, op, &text, parent);
    let marks = format!(
        "<w:commentRangeStart w:id=\"{id}\"/><w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r>"
    );
    // The reply spans its parent's words, as Word writes a reply: its start beside the parent's start, its end and reference after
    // the parent's reference. Marked as an empty range before the parent's end, Word read it as a second comment of its own on no
    // text rather than as an answer in the thread.
    // The parent may be anchored in any story: the body, a header, a footer, a note. A reply marked only where the body happens
    // to hold the id reached no story at all, and the next accept-all pruned it as orphaned.
    let start_pattern = compiled(&format!(r#"<w:commentRangeStart\b[^>]*\bw:id="{parent}"[^>]*\/>"#), "");
    let reference_pattern = compiled(
        &format!(
            r#"<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\bw:id="{parent}"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>"#
        ),
        "",
    );
    let end_pattern = compiled(&format!(r#"<w:commentRangeEnd\b[^>]*\bw:id="{parent}"[^>]*\/>"#), "");
    for part in docx_story_part_names(zip) {
        let story = zip.text(&part);
        let start = start_pattern.find(&story);
        let reference = reference_pattern.find(&story);
        if let (Some(start), Some(reference)) = (&start, &reference) {
            if start.start < reference.start {
                let (opened, closed) = (start.end, reference.end);
                zip.set(
                    &part,
                    format!(
                        "{}<w:commentRangeStart w:id=\"{id}\"/>{}<w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r>{}",
                        &story[..opened],
                        &story[opened..closed],
                        &story[closed..]
                    ),
                );
                break;
            }
        }
        let Some(anchor) = end_pattern.find(&story) else { continue };
        zip.set(&part, format!("{}{marks}{}", &story[..anchor.start], &story[anchor.start..]));
        break;
    }
    result.insert("changed".to_owned(), json!(true));
    result.insert("comment".to_owned(), json!(id));
    result.insert("parent".to_owned(), json!(parent));
    Ok(Value::Object(result))
}

/// `deleteDocxComment(zip, op)`.
pub fn delete_docx_comment(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let Some(id) = comment_id_of(op) else { return Err("delete_comment requires a positive comment id".to_owned()) };
    let comments = ensure_comments_part(zip);
    let pattern = compiled(&comment_entry_pattern(id), "");
    let Some(entry) = pattern.find(&comments.xml) else { return Err(format!("DOCX comment {id} not found")) };
    zip.set(&comments.part, format!("{}{}", &comments.xml[..entry.start], &comments.xml[entry.end..]));
    forget_comment_identity(zip, &comments.xml[entry]);
    let current = zip.text(DOCUMENT_PART);
    let next = compiled(&format!(r#"<w:commentRangeStart\b[^>]*\bw:id="{id}"[^>]*\/>"#), "g").replace_all_with(&current, |_| String::new());
    let next = compiled(&format!(r#"<w:commentRangeEnd\b[^>]*\bw:id="{id}"[^>]*\/>"#), "g").replace_all_with(&next, |_| String::new());
    let next = compiled(
        &format!(r#"<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\bw:id="{id}"[^>]*\/>[\s\S]*?<\/w:r>"#),
        "g",
    )
    .replace_all_with(&next, |_| String::new());
    zip.set(DOCUMENT_PART, next);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("comment".to_owned(), json!(id));
    Ok(Value::Object(result))
}

// ---- contents, bookmarks, running text, breaks ------------------------------------------------------------------------------

/// `insertDocxToc(zip, op)`.
pub fn insert_docx_toc(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    // The two bounds of the levels listed, in either order: Word's own API calls the first level (1) the upper one, and a caller
    // writing upperHeadingLevel:1, lowerHeadingLevel:2 got a list of the level 2 headings alone.
    let bounds = [or_else(number_of(op.get("lowerHeadingLevel")), 1.0), or_else(number_of(op.get("upperHeadingLevel")), 3.0)];
    let lower = mixdog_js::math::max(1.0, mixdog_js::math::min(bounds[0], bounds[1]));
    let upper = mixdog_js::math::min(9.0, mixdog_js::math::max(bounds[0], bounds[1]));
    let range = format!("{}-{}", number_to_string(lower), number_to_string(upper));
    let instruction = format!(" TOC \\o \"{range}\" \\h \\z \\u ");
    let cached = docx_toc_cache_runs(&docx_toc_entries(&current, lower, upper, &docx_heading_levels(zip)), lower);
    let block = format!("<w:p><w:fldSimple w:instr=\"{}\">{cached}</w:fldSimple></w:p>", xml_encode(&instruction));
    zip.set(DOCUMENT_PART, insert_block_after(&current, &block, op.get("paragraph"))?);
    // The cached entries are what Word draws until it rebuilds the field, so the package asks for that rebuild: without it the
    // contents reach the reader as plain lines with no leaders and no page numbers.
    ensure_docx_update_fields(zip);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("levels".to_owned(), json!(range));
    result.insert("updateFields".to_owned(), json!(true));
    Ok(Value::Object(result))
}

/// `addDocxBookmark(zip, op)`.
pub fn add_docx_bookmark(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let name = js_trim(&text_or_empty(op.get("name"))).to_owned();
    if name.is_empty() {
        return Err("add_bookmark requires name".to_owned());
    }
    let current = zip.text(DOCUMENT_PART);
    let id = compiled(r#"<w:bookmarkStart\b[^>]*\bw:id="(\d+)""#, "g")
        .captures_iter(&current)
        .map(|found| found.get(1).and_then(|digits| digits.parse::<u64>().ok()).unwrap_or(0))
        .fold(0, u64::max)
        + 1;
    let model = docx_body_model(&current);
    let paragraph = if truthy(op.get("paragraph")) {
        nth(&body_paragraphs(&model), number_of(op.get("paragraph"))).map(|found| (*found).clone())
    } else {
        paragraph_containing(&model, &text_or_empty(op.get("find")))
    };
    let Some(paragraph) = paragraph else { return Err("add_bookmark could not resolve a target paragraph".to_owned()) };
    let opening_pattern = compiled(r"^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?", "");
    let opening = opening_pattern.find(&paragraph.xml).map_or("<w:p>", |range| &paragraph.xml[range]);
    let rest = paragraph.xml.get(opening.len()..).unwrap_or("");
    let tail = match rest.strip_suffix("</w:p>") {
        Some(head) => format!("{head}<w:bookmarkEnd w:id=\"{id}\"/></w:p>"),
        None => rest.to_owned(),
    };
    let marked = format!("{opening}<w:bookmarkStart w:id=\"{id}\" w:name=\"{}\"/>{tail}", xml_encode(&name));
    zip.set(DOCUMENT_PART, replace_body_paragraph(&current, body_of(&model), &paragraph, &marked));
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("name".to_owned(), json!(name));
    result.insert("bookmark".to_owned(), json!(id));
    Ok(Value::Object(result))
}

/// `setDocxHeaderFooter(zip, op)`.
pub fn set_docx_header_footer(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let (named, kind) = story_target(op)?;
    let mut header = op.get("header") != Some(&Value::Bool(false));
    if named == "footer" {
        header = false;
    } else if named == "header" {
        header = true;
    }
    // The running line is set in the author's type (name, nameEastAsia, size, color, bold, alignment): left to the document
    // default it printed at body size in black above an eyebrow set at 9.5 pt.
    let properties = properties_of(op);
    let justification = word_justification(&text_or_empty(properties.get("alignment")));
    let body = word_paragraph(
        &text_or_blank(op.get("text")),
        if justification.is_empty() { if header { "" } else { "center" } } else { justification },
        "",
        &word_run_properties(&properties),
    );
    let written = write_header_footer_part(zip, &HeaderFooter { header, body: &|_: &str| body.clone(), document_xml: &current, kind: &kind });
    let title_page = compiled(r"<w:titlePg\b", "");
    let reference_tag = if header { "headerReference" } else { "footerReference" };
    let next = write_every_section_properties(&current, op.get("section").unwrap_or(&Value::Null), &|section: &str| {
        let referenced = upsert_section_reference(section, reference_tag, &kind, &written.relationship_id);
        if kind == "first" && !title_page.is_match(&referenced) { upsert_section_child(&referenced, "titlePg", "<w:titlePg/>") } else { referenced }
    })?;
    zip.set(DOCUMENT_PART, next);
    // replaced says the section already had this story: whatever stood there (a page number, an earlier line) is gone, not
    // beside the new text.
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("part".to_owned(), json!(written.part));
    result.insert("header".to_owned(), json!(header));
    result.insert("kind".to_owned(), json!(kind));
    if written.replaced {
        result.insert("replaced".to_owned(), json!(true));
    }
    Ok(Value::Object(result))
}

/// A separator says the number stands against the total ("3 / 12"): asked for with separator:' / ' and no includeTotal, the
/// footer printed "3" alone. includeTotal:false still keeps the number alone.
fn page_numbers_include_total(op: &Value) -> bool {
    let include = op.get("includeTotal");
    include == Some(&Value::Bool(true))
        || (include != Some(&Value::Bool(false)) && !js_trim(&text_or_blank(op.get("separator"))).is_empty())
}

/// `addDocxPageNumbers(zip, op)`: the same vocabulary as set_header_footer: kind names the story (the footer unless the caller
/// asks for the header), variant names the page.
pub fn add_docx_page_numbers(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let (named, kind) = story_target(op)?;
    let header = named == "header";
    let requested = js_to_lowercase(&text_or_empty(op.get("alignment")));
    let alignment = if ["left", "center", "right"].contains(&requested.as_str()) { requested } else { "center".to_owned() };
    // The number is set at 9 pt, as the Word backend sets it: left on the body size it printed a size and a half larger in the
    // portable file than the same footer written through Word.
    let size = "<w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr>";
    let prefix = match op.get("prefix") {
        Some(prefix) if truthy(Some(prefix)) => format!("<w:r>{size}<w:t xml:space=\"preserve\">{} </w:t></w:r>", xml_encode(&value_to_string(prefix))),
        _ => String::new(),
    };
    let include_total = page_numbers_include_total(op);
    let separator = if include_total {
        let separator_text = text_or_empty(op.get("separator"));
        let mark = js_trim(&separator_text);
        format!(
            "<w:r>{size}<w:t xml:space=\"preserve\"> {} </w:t></w:r><w:fldSimple w:instr=\" NUMPAGES \"><w:r>{size}<w:t>1</w:t></w:r></w:fldSimple>",
            xml_encode(if mark.is_empty() { "/" } else { mark })
        )
    } else {
        String::new()
    };
    let numbering = format!(
        "<w:p><w:pPr><w:jc w:val=\"{alignment}\"/><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:pPr>{prefix}\
<w:fldSimple w:instr=\" PAGE \"><w:r>{size}<w:t>1</w:t></w:r></w:fldSimple>{separator}</w:p>"
    );
    // A footer line and its page number are two operations, and this one used to write the story from scratch: the author's footer
    // text was gone from the file while the result reported success. Only the paragraph carrying the page field is rewritten, so
    // asking twice never stacks a second number and never erases the words around it.
    let kept_story = Cell::new(false);
    let page_field = compiled(r#"w:instr="[^"]*\bPAGE\b"#, "");
    let paragraphs = compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g");
    let compose = |story: &str| {
        let around = paragraphs.replace_all_with(story, |found| {
            let paragraph = found.get(0).unwrap_or("");
            if page_field.is_match(paragraph) { String::new() } else { paragraph.to_owned() }
        });
        kept_story.set(!js_trim(&around).is_empty());
        format!("{around}{numbering}")
    };
    let written = write_header_footer_part(zip, &HeaderFooter { header, body: &compose, document_xml: &current, kind: &kind });
    let reference_tag = if header { "headerReference" } else { "footerReference" };
    let next = write_every_section_properties(&current, op.get("section").unwrap_or(&Value::Null), &|section: &str| {
        upsert_section_reference(section, reference_tag, &kind, &written.relationship_id)
    })?;
    zip.set(DOCUMENT_PART, next);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("part".to_owned(), json!(written.part));
    result.insert("header".to_owned(), json!(header));
    result.insert("includeTotal".to_owned(), json!(include_total));
    if written.replaced {
        result.insert("replaced".to_owned(), json!(true));
    }
    if kept_story.get() {
        result.insert("keptExistingContent".to_owned(), json!(true));
    }
    Ok(Value::Object(result))
}

/// `insertDocxBreak(zip, op)`.
pub fn insert_docx_break(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let kind = js_to_lowercase(&if truthy(op.get("kind")) { value_to_string(&op["kind"]) } else { "page".to_owned() });
    if !["page", "column", "section_next", "section_continuous"].contains(&kind.as_str()) {
        return Err("insert_break supports page, column, section_next, or section_continuous".to_owned());
    }
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    if kind.starts_with("section") {
        // A section break paragraph carries the properties of the section it closes, so the text before it keeps the page it was
        // written for and the trailing sectPr (which set_page edits) governs what follows. A section's w:type says how that
        // section itself begins, so the start the break asks for belongs to the section after it: written on the closing copy, a
        // continuous break still began the next section on a new page, and a two-column body under a picture moved to page 2.
        let closing = trailing_section_properties(&current)?.found.map_or_else(|| "<w:sectPr></w:sectPr>".to_owned(), |(_, section)| section);
        let block = format!("<w:p><w:pPr>{closing}</w:pPr></w:p>");
        let mut next = insert_block_after(&current, &block, op.get("paragraph"))?;
        let start = format!("<w:type w:val=\"{}\"/>", if kind == "section_continuous" { "continuous" } else { "nextPage" });
        let at = next.find(&block).unwrap_or(0) + block.len();
        let following = compiled(r"<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>", "").find(&next[at..]);
        if let Some(following) = following {
            let (from, to) = (at + following.start, at + following.end);
            let found = &next[from..to];
            let section = match found.strip_suffix("/>") {
                Some(head) => format!("{head}></w:sectPr>"),
                None => found.to_owned(),
            };
            next = format!("{}{}{}", &next[..from], upsert_section_child(&section, "type", &start), &next[to..]);
        }
        zip.set(DOCUMENT_PART, next.as_str());
        result.insert("kind".to_owned(), json!(kind));
        result.insert("sections".to_owned(), json!(document_section_spans(&next)?.1.len()));
        return Ok(Value::Object(result));
    }
    let block = format!("<w:p><w:r><w:br w:type=\"{kind}\"/></w:r></w:p>");
    zip.set(DOCUMENT_PART, insert_block_after(&current, &block, op.get("paragraph"))?);
    result.insert("kind".to_owned(), json!(kind));
    Ok(Value::Object(result))
}

/// `normalizeDocxStoryRuns(zip, op, { parts })`.
pub fn normalize_docx_story_runs(zip: &mut Package, op: &Value, context: &DocxContext<'_>) -> Value {
    let (mut merged, mut text_merged, mut proof_err_removed, mut rsid_stripped) = (0_usize, 0_usize, 0_usize, 0_usize);
    let mut parts = Vec::new();
    for part in context.parts {
        let current = zip.text(part);
        let normalized = normalize_docx_runs(&current);
        if normalized.merged + normalized.proof_err_removed + normalized.rsid_stripped == 0 {
            continue;
        }
        zip.set(part, normalized.xml);
        merged += normalized.merged;
        text_merged += normalized.text_merged;
        proof_err_removed += normalized.proof_err_removed;
        rsid_stripped += normalized.rsid_stripped;
        parts.push(part.clone());
    }
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(!parts.is_empty()));
    result.insert("merged".to_owned(), json!(merged));
    result.insert("textMerged".to_owned(), json!(text_merged));
    result.insert("proofErrRemoved".to_owned(), json!(proof_err_removed));
    result.insert("rsidStripped".to_owned(), json!(rsid_stripped));
    result.insert("parts".to_owned(), json!(parts));
    Value::Object(result)
}
