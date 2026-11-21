//! `portable/portable-docx-operations.mjs`: the document-level operations the portable Word backend applies: the table of
//! contents refresh (and the pages a render measured), notes, the document font, style definitions, page setup, table fitting,
//! content controls, paragraph edits, table cells and the resolution of tracked changes. The package is edited as text with the
//! patterns of the Node code (`JsRegex`), so a match is the one V8 finds; offsets are byte offsets (Node's are UTF-16 units: the
//! text between two offsets is the same). Node's `async` is gone: the package is in memory.
//!
//! An operation is the JSON object the batch carries (`op`, `paragraph`, `table`, `properties`, ...); each function reads it the
//! way the Node code does (`Number(x)`, `String(x || '')`) and answers the result object, or the message Node throws.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use mixdog_js::{js_to_lowercase, js_trim, json_number, locale_compare_en, number_to_string, string_to_number, to_number, value_to_string};
use mixdog_office_base::docx_style_defs::docx_style_definitions;
use serde_json::{Map, Value, json};

use crate::docx_formatting::{patch_paragraph_format, patch_word_style};
use crate::docx_parts::{
    NoteDefinition, ensure_note_part, forget_comment_identity, mark_runs_deleted, next_revision_id, revision_attributes, trailing_section_properties,
    upsert_section_child, write_section_properties_at,
};
use crate::docx_revisions::{docx_revision_tree, flatten_docx_revisions};
use crate::docx_runs::{SettleOptions, SettledStory, settle_docx_story};
use crate::docx_styles::document_style_id;
use crate::docx_tracked_edits::{PhraseMarkers, anchor_phrase_in_paragraph, tracked_paragraph_replace, tracked_paragraph_rewrite};
use crate::docx_xml::{
    Matched, RunFontOverrides, apply_word_run_format, docx_table, exact_line_pitch_twips, justify_word_paragraphs, merge_word_cell_properties,
    merge_word_run_fonts, missing_docx_cell_error, missing_docx_row_error, replace_docx_table, replace_word_properties, row_cell_matches, table_row_matches,
    with_first_run_text, word_justification, word_table_properties, word_text_content, word_text_element,
};
use crate::slide_shapes::replace_first_with;
use crate::snapshot_docx::{BodyBlock, docx_body_model};
use crate::xlsx_audit_support::truthy;
use crate::xml::{compiled, paragraph_texts, rebuild_text_nodes, tag_pattern, text_nodes, xml_decode, xml_encode};
use crate::zipio::Package;

const DOCUMENT_PART: &str = "word/document.xml";
const STYLES_PART: &str = "word/styles.xml";
const COMMENTS_PART: &str = "word/comments.xml";
const A4_WIDTH_TWIPS: f64 = 11_906.0;
const A4_HEIGHT_TWIPS: f64 = 16_838.0;
const DEFAULT_MARGIN_TWIPS: f64 = 1_418.0;
const DEFAULT_HEADER_MARGIN_TWIPS: f64 = 709.0;

/// The paragraph mark's own revision id sits clear of the ids the paragraph's runs take.
const PARAGRAPH_MARK_ID_OFFSET: u64 = 900;

// ---- small readers of what Node reads off an operation -------------------------------------------------------------------

/// `Number(x) || fallback`.
fn or_else(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() { fallback } else { value }
}

/// `String(value || '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    value.filter(|value| truthy(Some(*value))).map(value_to_string).unwrap_or_default()
}

/// `String(value ?? '')`.
fn string_or_blank(value: Option<&Value>) -> String {
    value.filter(|value| !value.is_null()).map(value_to_string).unwrap_or_default()
}

/// A value as a template literal prints it (`undefined` for an absent one).
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `Number(x)` of a field that may be missing (`undefined`, so NaN).
fn number_of(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
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

/// `Number(/pattern/.exec(text)?.[1])`: NaN when the pattern does not match.
fn digits(pattern: &str, text: &str) -> f64 {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1)).map_or(f64::NAN, string_to_number)
}

/// The first group of a pattern's first match.
fn first_group<'t>(pattern: &str, text: &'t str) -> Option<&'t str> {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1))
}

/// The text of a pattern's first match.
fn first_match<'t>(pattern: &str, text: &'t str) -> Option<&'t str> {
    compiled(pattern, "").find(text).map(|range| &text[range])
}

/// `text.replace(search, () => replacement)` for a string search: the first occurrence.
fn replace_text(text: &str, search: &str, replacement: &str) -> String {
    text.replacen(search, replacement, 1)
}

// ---- the table of contents --------------------------------------------------------------------------------------------------

/// `docxHeadingLevels(zip)`: which paragraph styles this document calls a heading. Word's own style ids are not the only ones a
/// real file carries: a localized or converted document names its headings 제목 1 or declares an outline level under its own id,
/// and a table of contents that only knows "Heading1" lists nothing at all.
pub fn docx_heading_levels(zip: &Package) -> HashMap<String, u32> {
    let styles = zip.text(STYLES_PART);
    let mut levels = HashMap::new();
    for found in compiled(r#"<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>"#, "g").captures_iter(&styles) {
        let style = found.get(0).unwrap_or("");
        let name = first_group(r#"<w:name\b[^>]*\bw:val="([^"]*)""#, style).unwrap_or("");
        let outline = digits(r#"<w:outlineLvl\b[^>]*\bw:val="(\d+)""#, style);
        let named = compiled(r"^(?:heading|제목|표제)\s*([1-9])", "i").captures(js_trim(name)).and_then(|named| named.get(1)).map(string_to_number);
        let level = if outline.fract() == 0.0 && (0.0..=8.0).contains(&outline) {
            outline as u32 + 1
        } else if let Some(named) = named {
            named as u32
        } else {
            0
        };
        if level != 0 {
            levels.insert(found.get(1).unwrap_or("").to_owned(), level);
        }
    }
    levels
}

/// One heading a table of contents lists, with the page a render measured for it.
#[derive(Debug, Clone, PartialEq)]
pub struct TocEntry {
    pub level: u32,
    pub text: String,
    pub page: Option<f64>,
}

/// `docxTocEntries(documentXml, lower, upper, headingLevels)`: the headings of the body between two levels, in order.
pub fn docx_toc_entries(document_xml: &str, lower: f64, upper: f64, heading_levels: &HashMap<String, u32>) -> Vec<TocEntry> {
    let mut entries = Vec::new();
    for found in compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g").find_iter(document_xml) {
        let paragraph = &document_xml[found];
        let style = first_group(r#"<w:pStyle\b[^>]*\bw:val="([^"]+)""#, paragraph).unwrap_or("");
        let named = compiled(r"^Heading([1-9])$", "").captures(style).and_then(|named| named.get(1)).map_or(0.0, string_to_number);
        let level = if named != 0.0 { named } else { f64::from(heading_levels.get(style).copied().unwrap_or(0)) };
        if level < lower || level > upper {
            continue;
        }
        let text = paragraph_texts(paragraph, "w:t").join("");
        let text = js_trim(&text);
        if !text.is_empty() {
            entries.push(TocEntry { level: level as u32, text: text.to_owned(), page: None });
        }
    }
    entries
}

/// `docxTocCacheRuns(entries, lower)`: Word rebuilds a TOC field when the reader updates it; until then the cached result is
/// what every other reader shows: a preview, a PDF export, a render. An entry carries its page after a tab once a render has
/// measured it; the tab stop on the paragraph sets it on the right margin behind a dot leader, the way Word draws its own
/// contents.
pub fn docx_toc_cache_runs(entries: &[TocEntry], lower: f64) -> String {
    if entries.is_empty() {
        return "<w:r><w:t>Update this field in Word to build the table of contents.</w:t></w:r>".to_owned();
    }
    let page_run = |entry: &TocEntry| match entry.page {
        Some(page) if page != 0.0 && !page.is_nan() => format!("<w:r><w:tab/></w:r><w:r><w:t>{}</w:t></w:r>", number_to_string(page)),
        _ => String::new(),
    };
    entries
        .iter()
        .map(|entry| {
            let indent = "    ".repeat((f64::from(entry.level) - lower).max(0.0) as usize);
            format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>{}", xml_encode(&format!("{indent}{}", entry.text)), page_run(entry))
        })
        .collect::<Vec<_>>()
        .join("<w:r><w:br/></w:r>")
}

const TOC_FIELD: &str = r#"<w:fldSimple\b([^>]*\bw:instr="([^"]*TOC[^"]*)"[^>]*)>([\s\S]*?)<\/w:fldSimple>"#;

/// `cachedTocPages(cache)`: the pages a cache already shows, by entry text: a save rebuilds the entries from the headings, and a
/// heading that did not change keeps the page its last render measured.
fn cached_toc_pages(cache: &str) -> HashMap<String, f64> {
    let mut pages = HashMap::new();
    for line in cache.split("<w:r><w:br/></w:r>") {
        let texts: Vec<String> =
            compiled(r"<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>", "g").captures_iter(line).map(|found| xml_decode(found.get(1).unwrap_or(""))).collect();
        if texts.len() == 2 && line.contains("<w:tab/>") && compiled(r"^\d+$", "").is_match(&texts[1]) {
            pages.insert(js_trim(&texts[0]).to_owned(), string_to_number(&texts[1]));
        }
    }
    pages
}

/// `tocFieldLevels(instruction)`: the heading levels a contents field lists, by its \o switch (1-3 when it names none).
fn toc_field_levels(instruction: &str) -> (f64, f64) {
    let range = compiled(r#"\\o\s*(?:"|&quot;)(\d+)-(\d+)(?:"|&quot;)"#, "").captures(instruction);
    let lower = or_else(range.as_ref().and_then(|range| range.get(1)).map_or(f64::NAN, string_to_number), 1.0).max(1.0);
    let upper = or_else(range.as_ref().and_then(|range| range.get(2)).map_or(f64::NAN, string_to_number), 3.0).max(lower);
    (lower, upper)
}

type PageFor<'a> = &'a dyn Fn(&TocEntry, usize) -> Option<f64>;

fn rebuild_table_of_contents(current: &str, heading_levels: &HashMap<String, u32>, page_for: Option<PageFor<'_>>) -> String {
    compiled(TOC_FIELD, "g").replace_all_with(current, |found| {
        let attributes = found.get(1).unwrap_or("");
        let (lower, upper) = toc_field_levels(found.get(2).unwrap_or(""));
        let carried = cached_toc_pages(found.get(3).unwrap_or(""));
        let entries: Vec<TocEntry> = docx_toc_entries(current, lower, upper, heading_levels)
            .into_iter()
            .enumerate()
            .map(|(index, entry)| {
                let page = match page_for {
                    Some(page_for) => page_for(&entry, index),
                    None => carried.get(&entry.text).copied(),
                };
                TocEntry { page, ..entry }
            })
            .collect();
        format!("<w:fldSimple{attributes}>{}</w:fldSimple>", docx_toc_cache_runs(&entries, lower))
    })
}

/// `refreshDocxTableOfContents(zip)`: a table of contents is usually written before the sections it lists, so the cache captured
/// at insert time would show an empty document forever. Every save rebuilds it from the body as it stands.
pub fn refresh_docx_table_of_contents(zip: &mut Package) -> bool {
    let current = zip.text(DOCUMENT_PART);
    if !compiled(r#"<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC"#, "").is_match(&current) {
        return false;
    }
    let next = rebuild_table_of_contents(&current, &docx_heading_levels(zip), None);
    if next == current {
        return false;
    }
    zip.set(DOCUMENT_PART, next);
    true
}

fn rendered_toc_pages(entries: &[TocEntry], above: usize, page_texts: &[String]) -> Vec<Option<f64>> {
    let squash = |value: &str| compiled(r"\s+", "g").replace_all_with(value, |_| String::new());
    let text = page_texts.concat();
    let mut page_starts = Vec::with_capacity(page_texts.len());
    let mut offset = 0;
    for page in page_texts {
        page_starts.push(offset);
        offset += page.len();
    }
    let mut cursor = 0;
    let mut page_of = |entry: &TocEntry| -> Option<f64> {
        let needle = squash(&entry.text);
        let at = if needle.is_empty() { None } else { text[cursor..].find(&needle).map(|found| cursor + found) }?;
        cursor = at + needle.len();
        page_starts.iter().rposition(|start| *start <= at).map(|index| (index + 1) as f64)
    };
    let mut pages: Vec<Option<f64>> = entries[..above].iter().map(&mut page_of).collect();
    for entry in entries {
        page_of(entry);
    }
    pages.extend(entries[above..].iter().map(&mut page_of));
    pages
}

fn with_toc_dot_leader_tab(document: &str) -> Result<String, String> {
    let failure: RefCell<Option<String>> = RefCell::new(None);
    let paragraph_pattern = compiled(r#"<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC[\s\S]*?<\/w:p>"#, "");
    let next = replace_first_with(&paragraph_pattern, document, |found| {
        let paragraph = found.get(0).unwrap_or("");
        let section = first_match(r"<w:sectPr\b[\s\S]*?<\/w:sectPr>", &document[found.range().start..]).unwrap_or("");
        let width = or_else(digits(r#"<w:pgSz\b[^>]*\bw:w="(\d+)""#, section), A4_WIDTH_TWIPS);
        let left = or_else(digits(r#"<w:pgMar\b[^>]*\bw:left="(\d+)""#, section), 1_440.0);
        let right = or_else(digits(r#"<w:pgMar\b[^>]*\bw:right="(\d+)""#, section), 1_440.0);
        let tab_stops = json!({ "tabStops": [{ "position": json_number((width - left - right) / 20.0), "alignment": "right", "leader": "dot" }] });
        match patch_paragraph_format(paragraph, &tab_stops, None) {
            Ok(patched) => patched,
            Err(message) => {
                failure.borrow_mut().get_or_insert(message);
                paragraph.to_owned()
            }
        }
    });
    match failure.into_inner() {
        Some(message) => Err(message),
        None => Ok(next),
    }
}

/// `writeDocxTocPages(zip, pageTexts)`: the page every contents entry lands on, read from a rendered copy of the document:
/// `page_texts` is each page's text with the whitespace removed. The rendered text meets the headings in document order, and the
/// contents list itself (each entry once more, on one page or across several) where the field stands; walked in that order, a
/// heading is found past the list and past the heading before it. The walk takes the field's own levels. Returns whether the
/// cache changed; the paragraph holding the field takes a right tab with a dot leader on the text edge so the numbers line up.
pub fn write_docx_toc_pages(zip: &mut Package, page_texts: &[String]) -> Result<bool, String> {
    let current = zip.text(DOCUMENT_PART);
    let field_pattern = compiled(r#"<w:fldSimple\b[^>]*\bw:instr="([^"]*TOC[^"]*)""#, "");
    let Some(field) = field_pattern.captures(&current) else { return Ok(false) };
    let field_start = field.range().start;
    let heading_levels = docx_heading_levels(zip);
    let (lower, upper) = toc_field_levels(field.get(1).unwrap_or(""));
    let entries = docx_toc_entries(&current, lower, upper, &heading_levels);
    let above = docx_toc_entries(&current[..field_start], lower, upper, &heading_levels).len();
    let pages = rendered_toc_pages(&entries, above.min(entries.len()), page_texts);
    let page_for = |_: &TocEntry, index: usize| pages.get(index).copied().flatten();
    let rebuilt = rebuild_table_of_contents(&current, &heading_levels, Some(&page_for));
    let next = with_toc_dot_leader_tab(&rebuilt)?;
    if next == current {
        return Ok(false);
    }
    zip.set(DOCUMENT_PART, next);
    Ok(true)
}

// ---- tracked find and replace ------------------------------------------------------------------------------------------------

/// What [`replace_tracked_paragraphs`] did to a story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedReplacement {
    pub xml: String,
    pub count: usize,
    pub paragraph_rewrites: usize,
}

/// `replaceTrackedParagraphs(xml, find, replacement, author)`: tracked find-and-replace cuts only the matched characters out of
/// their runs (deletion plus insertion in the run's own formatting). A match that crosses a run carrying a tab, break, field, or
/// drawing falls back to rewriting that paragraph as one deletion plus one insertion, so every changed character still sits
/// inside a wrapper for the redlining audit.
pub fn replace_tracked_paragraphs(xml: &str, find: &str, replacement: &str, author: &str) -> Result<TrackedReplacement, String> {
    if find.is_empty() {
        return Err("replace_text requires non-empty find".to_owned());
    }
    let id = Cell::new(next_revision_id(xml));
    let count = Cell::new(0usize);
    let rewrites = Cell::new(0usize);
    let failure: RefCell<Option<String>> = RefCell::new(None);
    let next = compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g").replace_all_with(xml, |found| {
        let paragraph = found.get(0).unwrap_or("");
        if failure.borrow().is_some() {
            return paragraph.to_owned();
        }
        let joined: String = text_nodes(paragraph, "w:t").into_iter().map(|node| node.text).collect();
        if !joined.contains(find) {
            return paragraph.to_owned();
        }
        let cut = match tracked_paragraph_replace(paragraph, find, replacement, id.get(), author) {
            Ok(cut) => cut,
            Err(message) => {
                *failure.borrow_mut() = Some(message);
                return paragraph.to_owned();
            }
        };
        if cut.count > 0 {
            count.set(count.get() + cut.count);
            id.set(cut.next_id);
            return cut.xml;
        }
        count.set(count.get() + joined.matches(find).count());
        rewrites.set(rewrites.get() + 1);
        let run_count = compiled(r"<w:r(?:\s[^>]*)?>", "g").find_iter(paragraph).count() as u64;
        match tracked_paragraph_rewrite(paragraph, &joined.replace(find, replacement), id.get(), author) {
            Ok(rewritten) => {
                id.set(id.get() + run_count + 1);
                rewritten
            }
            Err(message) => {
                *failure.borrow_mut() = Some(message);
                paragraph.to_owned()
            }
        }
    });
    if let Some(message) = failure.into_inner() {
        return Err(message);
    }
    Ok(TrackedReplacement { xml: next, count: count.get(), paragraph_rewrites: rewrites.get() })
}

// ---- comments left without text ------------------------------------------------------------------------------------------------

/// The stories are the body, the headers, the footers, and the notes; the comments part carries no tracked text of its own.
fn is_story_part(name: &str) -> bool {
    !compiled(r"\/comments\.xml$", "i").is_match(name)
}

/// `pruneOrphanComments(zip, parts)`: Word drops a comment together with the text it marked; after accepting a deletion that
/// carried the whole anchor, the comment has no reference left in any story and is removed with its thread, id map, and
/// timestamp.
fn prune_orphan_comments(zip: &mut Package, parts: &[String]) -> usize {
    let comments = zip.text(COMMENTS_PART);
    if comments.is_empty() {
        return 0;
    }
    let stories: Vec<&String> = parts.iter().filter(|part| is_story_part(part)).collect();
    let mut referenced: Vec<String> = Vec::new();
    for part in &stories {
        let xml = zip.text(part);
        for found in compiled(r#"<w:commentReference\b[^>]*\bw:id="([^"]*)""#, "g").captures_iter(&xml) {
            referenced.push(found.get(1).unwrap_or("").to_owned());
        }
    }
    let mut next = comments.clone();
    let mut removed_ids: Vec<String> = Vec::new();
    for found in compiled(r#"<w:comment\b[^>]*\bw:id="([^"]*)"[^>]*>[\s\S]*?<\/w:comment>"#, "g").captures_iter(&comments) {
        let id = found.get(1).unwrap_or("");
        if referenced.iter().any(|known| known == id) {
            continue;
        }
        let comment = found.get(0).unwrap_or("");
        next = replace_text(&next, comment, "");
        forget_comment_identity(zip, comment);
        removed_ids.push(id.to_owned());
    }
    if removed_ids.is_empty() {
        return 0;
    }
    zip.set(COMMENTS_PART, next);
    // The range markers are not runs, so a deletion never carried them away; without their comment they would read as a marker
    // mismatch.
    for part in &stories {
        let xml = zip.text(part);
        let mut stripped = xml.clone();
        for id in &removed_ids {
            let markers = compiled(&format!(r#"<w:commentRange(?:Start|End)\b[^>]*\bw:id="{}"[^>]*\/>"#, tag_pattern(id)), "g");
            stripped = markers.replace_all_with(&stripped, |_| String::new());
        }
        if stripped != xml {
            zip.set(part, stripped);
        }
    }
    removed_ids.len()
}

// ---- notes -------------------------------------------------------------------------------------------------------------------

fn whole_word_phrase<'t>(text: &'t str, find: &'t str) -> &'t str {
    let letter_or_digit = compiled(r"[\p{L}\p{N}]", "u");
    let ends_in_word = compiled(r"[\p{L}\p{N}]$", "u");
    let Some(at) = text.find(find) else { return find };
    if !ends_in_word.is_match(find) {
        return find;
    }
    let mut end = at + find.len();
    // Node tests one UTF-16 unit at a time: half of a surrogate pair is never a letter.
    for character in text[end..].chars() {
        if character.len_utf16() != 1 || !letter_or_digit.is_match(&character.to_string()) {
            break;
        }
        end += character.len_utf8();
    }
    &text[at..end]
}

fn note_entry_xml(definition: &NoteDefinition, id_text: &str, text: &str, faces: &str) -> String {
    let note_run = if faces.is_empty() { String::new() } else { format!("<w:rPr>{faces}</w:rPr>") };
    let reference_kind = if definition.reference == "w:footnoteReference" { "footnoteRef" } else { "endnoteRef" };
    format!(
        "<{tag} w:id=\"{id_text}\"><w:p><w:pPr><w:pStyle w:val=\"{text_style}\"/></w:pPr><w:r><w:rPr><w:rStyle w:val=\"{style}\"/>{faces}<w:vertAlign w:val=\"superscript\"/></w:rPr><w:{reference_kind}/></w:r><w:r>{note_run}<w:t xml:space=\"preserve\"> {}</w:t></w:r></w:p></{tag}>",
        xml_encode(text),
        tag = definition.tag,
        text_style = definition.text_style,
        style = definition.style,
    )
}

/// The paragraph with the note's mark after the cited phrase, and the phrase when one was anchored; a phrase split across a
/// tab, field, or drawing leaves the mark at the end of the paragraph.
fn anchor_note_mark(definition: &NoteDefinition, paragraph_xml: &str, find: &str, id_text: &str) -> (String, Option<String>) {
    let mark = format!(
        "<w:r><w:rPr><w:rStyle w:val=\"{}\"/><w:vertAlign w:val=\"superscript\"/></w:rPr><{} w:id=\"{id_text}\"/></w:r>",
        definition.style, definition.reference
    );
    let joined = paragraph_texts(paragraph_xml, "w:t").join("");
    let cited = if find.is_empty() { "" } else { whole_word_phrase(&joined, find) };
    let phrase = if cited.is_empty() {
        None
    } else {
        anchor_phrase_in_paragraph(paragraph_xml, cited, id_text, Some(&PhraseMarkers { start: Some(String::new()), end: Some(mark.clone()), replace: false }))
    };
    let anchored = match &phrase {
        Some(phrase) => phrase.clone(),
        None => match compiled(r"<\/w:p>$", "").find(paragraph_xml) {
            Some(range) => format!("{}{mark}</w:p>{}", &paragraph_xml[..range.start], &paragraph_xml[range.end..]),
            None => paragraph_xml.to_owned(),
        },
    };
    (anchored, phrase)
}

/// `addDocxNote(zip, op)`: writes a footnote or endnote and anchors its mark on the phrase it cites.
pub fn add_docx_note(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let text = string_or_empty(op.get("text"));
    if text.is_empty() {
        return Err("add_note requires text".to_owned());
    }
    let kind = if truthy(op.get("kind")) { value_to_string(&op["kind"]) } else { "footnote".to_owned() };
    let note = ensure_note_part(zip, &kind)?;
    let definition = note.definition;
    let mut current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraphs: Vec<&BodyBlock> = model.blocks.iter().filter(|block| block.name == "w:p").collect();
    let find = string_or_empty(op.get("find"));
    let paragraph = if truthy(op.get("paragraph")) {
        nth(&paragraphs, number_of(op.get("paragraph"))).copied()
    } else {
        paragraphs.iter().find(|entry| paragraph_texts(&entry.xml, "w:t").join("").contains(&find)).copied()
    };
    let Some(paragraph) = paragraph else {
        return Err(if truthy(op.get("paragraph")) {
            format!("DOCX paragraph {} not found", shown(op.get("paragraph")))
        } else {
            format!("DOCX text not found for note anchor: {find}")
        });
    };
    let id_pattern = compiled(&format!(r#"<{}\b[^>]*\bw:id="(-?\d+)""#, tag_pattern(definition.tag)), "g");
    let id = id_pattern.captures_iter(&note.xml).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(0.0, f64::max) + 1.0;
    let id_text = number_to_string(id);
    let faces = first_group(r"<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?(<w:rFonts\b[^>]*\/>)", &paragraph.xml).unwrap_or("");
    let closing = format!("</{}>", definition.root);
    zip.set(definition.part, replace_text(&note.xml, &closing, &format!("{}{closing}", note_entry_xml(&definition, &id_text, &text, faces))));
    let (anchored, phrase) = anchor_note_mark(&definition, &paragraph.xml, &find, &id_text);
    let body = model.body.as_ref().expect("a body holds the paragraph");
    let next_inner = format!("{}{anchored}{}", &body.inner[..paragraph.start], &body.inner[paragraph.end..]);
    current = format!("{}{next_inner}{}", &current[..body.start], &current[body.end..]);
    zip.set(DOCUMENT_PART, current);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("kind".to_owned(), json!(if definition.tag == "w:footnote" { "footnote" } else { "endnote" }));
    result.insert("note".to_owned(), json_number(id));
    result.insert("anchor".to_owned(), json!(if phrase.is_some() { "phrase" } else { "paragraph" }));
    Ok(Value::Object(result))
}

// ---- the document font and styles ------------------------------------------------------------------------------------------------

fn with_default_run_font(styles: &str, font: &RunFontOverrides<'_>) -> String {
    let defaults = compiled(r"<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<\/w:rPr>\s*<\/w:rPrDefault>", "")
        .captures(styles)
        .map(|found| (found.range(), found.get(1).unwrap_or("").to_owned()));
    let default_run =
        format!("<w:rPrDefault><w:rPr>{}</w:rPr></w:rPrDefault>", merge_word_run_fonts(defaults.as_ref().map_or("", |(_, inner)| inner.as_str()), font));
    if let Some((range, _)) = &defaults {
        format!("{}{default_run}{}", &styles[..range.start], &styles[range.end..])
    } else if styles.contains("<w:docDefaults>") {
        replace_text(styles, "<w:docDefaults>", &format!("<w:docDefaults>{default_run}"))
    } else {
        replace_first_with(&compiled(r"<w:styles\b[^>]*>", ""), styles, |open| {
            format!("{}<w:docDefaults>{default_run}</w:docDefaults>", open.get(0).unwrap_or(""))
        })
    }
}

/// The default paragraph style is found by `w:default` (Korean Word writes Normal as styleId "a") and cut out first, so a Normal
/// without run properties never reaches into the style after it.
fn with_normal_style_font(styles: &str, font: &RunFontOverrides<'_>) -> String {
    let normal = compiled(r#"<w:style\b(?=[^>]*\bw:type="paragraph")(?=[^>]*\bw:default="1")[^>]*>[\s\S]*?<\/w:style>"#, "");
    replace_first_with(&normal, styles, |style| {
        let style = style.get(0).unwrap_or("");
        replace_first_with(&compiled(r"<w:rPr>([\s\S]*?)<\/w:rPr>", ""), style, |found| {
            let inner = found.get(1).unwrap_or("");
            if compiled(r"<w:(rFonts|sz)\b", "").is_match(inner) {
                format!("<w:rPr>{}</w:rPr>", merge_word_run_fonts(inner, font))
            } else {
                found.get(0).unwrap_or("").to_owned()
            }
        })
    })
}

/// `setDocxDocumentFont(zip, op)`: the document's own face and size: the default run properties, and the Normal style's where it
/// names its own.
pub fn set_docx_document_font(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let properties = op.get("properties").filter(|value| truthy(Some(*value))).cloned().unwrap_or_else(|| json!({}));
    let name = js_trim(&string_or_empty(properties.get("name"))).to_owned();
    let name_east_asia = js_trim(&string_or_empty(properties.get("nameEastAsia"))).to_owned();
    let size = or_else(number_of(properties.get("size")), 0.0);
    let color_text = string_or_empty(properties.get("color"));
    let color = js_trim(color_text.strip_prefix('#').unwrap_or(&color_text)).to_owned();
    if name.is_empty() && name_east_asia.is_empty() && size <= 0.0 && color.is_empty() {
        return Err("set_document_font needs properties.name, nameEastAsia, size, or color".to_owned());
    }
    let mut styles = zip.text(STYLES_PART);
    if styles.is_empty() {
        return Err("DOCX package has no styles part (word/styles.xml)".to_owned());
    }
    let font = RunFontOverrides { name: &name, name_east_asia: &name_east_asia, size, color: &color };
    styles = with_default_run_font(&styles, &font);
    styles = with_normal_style_font(&styles, &font);
    zip.set(STYLES_PART, styles);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("name".to_owned(), json!(name));
    result.insert("nameEastAsia".to_owned(), json!(name_east_asia));
    result.insert("size".to_owned(), json_number(size));
    result.insert("color".to_owned(), json!(color));
    Ok(Value::Object(result))
}

/// `defineDocxStyles(zip, op)`: Word's own styles defined once (the title, headings, body, caption a report is set in) so every
/// paragraph that names the style takes them, and a paragraph the reader adds in Word under that style matches the rest. Set
/// paragraph by paragraph instead, a heading added later came out in Word's blue Calibri.
pub fn define_docx_styles(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let no_fields = Map::new();
    let definitions = docx_style_definitions(op.as_object().unwrap_or(&no_fields))?;
    let mut defined: Vec<String> = Vec::new();
    let mut not_found: Vec<String> = Vec::new();
    for &(requested, fields) in &definitions {
        let resolved = document_style_id(zip, requested, "paragraph");
        if !resolved.found {
            not_found.push(requested.to_owned());
            continue;
        }
        let styles = zip.text(STYLES_PART);
        let pattern = compiled(&format!(r#"<w:style\b(?=[^>]*\bw:styleId="{}")[^>]*>[\s\S]*?<\/w:style>"#, tag_pattern(&resolved.id)), "");
        let Some(style) = pattern.find(&styles).map(|range| styles[range].to_owned()) else {
            not_found.push(requested.to_owned());
            continue;
        };
        let patched = patch_word_style(&style, fields)?;
        zip.set(STYLES_PART, replace_text(&styles, &style, &patched));
        defined.push(requested.to_owned());
    }
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(!defined.is_empty()));
    result.insert("styles".to_owned(), json!(defined));
    if !not_found.is_empty() {
        result.insert("styleNotFound".to_owned(), json!(not_found));
    }
    Ok(Value::Object(result))
}

// ---- page setup --------------------------------------------------------------------------------------------------------------

/// What `set_page` asks for: the sheet's orientation, its text columns and its size in twips.
struct PageRequest {
    orientation: String,
    column_count: Option<f64>,
    column_spacing: Option<f64>,
    size: Option<[f64; 2]>,
}

/// `pageRequest(properties)`: page size, orientation, margins and text columns of one section, keeping what was not asked for.
fn page_request(properties: &Value) -> Result<PageRequest, String> {
    let orientation = js_to_lowercase(&string_or_empty(properties.get("orientation")));
    if !orientation.is_empty() && orientation != "portrait" && orientation != "landscape" {
        return Err("set_page orientation must be portrait or landscape".to_owned());
    }
    let present = |name: &str| properties.get(name).filter(|value| !value.is_null());
    let column_count = present("columns").map(to_number);
    if let Some(count) = column_count {
        if count.fract() != 0.0 || !count.is_finite() || !(1.0..=12.0).contains(&count) {
            return Err("set_page columns must be a whole number from 1 to 12".to_owned());
        }
    }
    let column_spacing = present("columnSpacing").map(to_number);
    if let Some(spacing) = column_spacing {
        if !spacing.is_finite() || spacing < 0.0 {
            return Err("set_page columnSpacing must be a number of points".to_owned());
        }
    }
    // pageSize arrives resolved to points (pageWidth, pageHeight) by the batch.
    let width = number_of(properties.get("pageWidth"));
    let height = number_of(properties.get("pageHeight"));
    let sized = present("pageWidth").is_some() || present("pageHeight").is_some();
    if sized && !(width > 0.0 && height > 0.0) {
        return Err("set_page pageSize must be a named size ('a4', 'letter', ...) or [width, height] in points".to_owned());
    }
    let size = sized.then(|| [mixdog_js::math::round(width * 20.0), mixdog_js::math::round(height * 20.0)]);
    Ok(PageRequest { orientation, column_count, column_spacing, size })
}

fn section_with_page(section: &str, properties: &Value, request: &PageRequest) -> String {
    let current = first_group(r"<w:pgSz\b([^>]*)\/>", section).unwrap_or("");
    let mut page_width = or_else(digits(r#"\bw:w="(\d+)""#, current), A4_WIDTH_TWIPS);
    let mut page_height = or_else(digits(r#"\bw:h="(\d+)""#, current), A4_HEIGHT_TWIPS);
    let landscape = if request.orientation.is_empty() { page_width > page_height } else { request.orientation == "landscape" };
    if let Some([width, height]) = request.size {
        page_width = width;
        page_height = height;
    }
    if if landscape { page_width < page_height } else { page_width > page_height } {
        std::mem::swap(&mut page_width, &mut page_height);
    }
    let margins = first_group(r"<w:pgMar\b([^>]*)\/>", section).unwrap_or("");
    let margin = |name: &str, key: &str, fallback: f64| -> String {
        if let Some(requested) = properties.get(key).filter(|value| !value.is_null()) {
            let twips = mixdog_js::math::round(to_number(requested) * 20.0);
            return number_to_string(if twips.is_nan() { twips } else { twips.max(0.0) });
        }
        match first_group(&format!(r#"\bw:{name}="(-?\d+)""#), margins) {
            Some(existing) => number_to_string(string_to_number(existing)),
            None => number_to_string(fallback),
        }
    };
    let with_size = upsert_section_child(
        section,
        "pgSz",
        &format!(
            "<w:pgSz w:w=\"{}\" w:h=\"{}\"{}/>",
            number_to_string(page_width),
            number_to_string(page_height),
            if landscape { " w:orient=\"landscape\"" } else { "" }
        ),
    );
    let with_margins = upsert_section_child(
        &with_size,
        "pgMar",
        &format!(
            "<w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"{}\" w:footer=\"{}\" w:gutter=\"0\"/>",
            margin("top", "topMargin", DEFAULT_MARGIN_TWIPS),
            margin("right", "rightMargin", DEFAULT_MARGIN_TWIPS),
            margin("bottom", "bottomMargin", DEFAULT_MARGIN_TWIPS),
            margin("left", "leftMargin", DEFAULT_MARGIN_TWIPS),
            margin("header", "headerMargin", DEFAULT_HEADER_MARGIN_TWIPS),
            margin("footer", "footerMargin", DEFAULT_HEADER_MARGIN_TWIPS)
        ),
    );
    section_with_columns(&with_margins, request)
}

fn section_with_columns(section: &str, request: &PageRequest) -> String {
    if request.column_count.is_none() && request.column_spacing.is_none() {
        return section.to_owned();
    }
    let declared = first_group(r"<w:cols\b([^>]*)\/>", section).unwrap_or("");
    let carried_count = or_else(digits(r#"\bw:num="(\d+)""#, declared), 1.0);
    let count = request.column_count.unwrap_or(carried_count);
    let carried_space = or_else(digits(r#"\bw:space="(\d+)""#, declared), 708.0);
    let space = request.column_spacing.map_or(carried_space, |spacing| mixdog_js::math::round(spacing * 20.0));
    upsert_section_child(
        section,
        "cols",
        &format!(
            "<w:cols{} w:space=\"{}\"/>",
            if count > 1.0 { format!(" w:num=\"{}\" w:equalWidth=\"1\"", number_to_string(count)) } else { String::new() },
            number_to_string(space)
        ),
    )
}

/// `setDocxPage(zip, op)`: page size, orientation, margins and text columns of one section.
pub fn set_docx_page(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let current = zip.text(DOCUMENT_PART);
    let properties = op.get("properties").filter(|value| truthy(Some(*value))).cloned().unwrap_or_else(|| json!({}));
    let request = page_request(&properties)?;
    let next = write_section_properties_at(&current, op.get("section").unwrap_or(&Value::Null), &|section| section_with_page(section, &properties, &request))?;
    zip.set(DOCUMENT_PART, next.clone());
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(next != current));
    result.insert("orientation".to_owned(), json!(if request.orientation.is_empty() { "unchanged" } else { request.orientation.as_str() }));
    if let Some(columns) = request.column_count {
        result.insert("columns".to_owned(), json_number(columns));
    }
    Ok(Value::Object(result))
}

// ---- fitting a table ------------------------------------------------------------------------------------------------------------

/// `usableTextWidth(documentXml)`: the text column's width in twips: the trailing section's page width less its side margins.
fn usable_text_width(document_xml: &str) -> Result<f64, String> {
    let trailing = trailing_section_properties(document_xml)?;
    let section = trailing.found.as_ref().map_or("", |(_, xml)| xml.as_str());
    let size = first_group(r"<w:pgSz\b([^>]*)\/>", section).unwrap_or("");
    let margins = first_group(r"<w:pgMar\b([^>]*)\/>", section).unwrap_or("");
    let page_width = or_else(digits(r#"\bw:w="(\d+)""#, size), A4_WIDTH_TWIPS);
    let margin_left = or_else(digits(r#"\bw:left="(-?\d+)""#, margins), DEFAULT_MARGIN_TWIPS);
    let margin_right = or_else(digits(r#"\bw:right="(-?\d+)""#, margins), DEFAULT_MARGIN_TWIPS);
    Ok((page_width - margin_left - margin_right).max(720.0))
}

fn fit_table_cells(table_xml: &str, widths: &[f64]) -> String {
    compiled(r"<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>", "g").replace_all_with(table_xml, |row| {
        let index = Cell::new(0usize);
        compiled(r"<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>", "g").replace_all_with(row.get(0).unwrap_or(""), |found| {
            let cell = found.get(0).unwrap_or("");
            let existing = first_group(r"<w:tcPr>([\s\S]*?)<\/w:tcPr>", cell).unwrap_or("");
            let keep = |pattern: &str| first_match(pattern, existing).unwrap_or("");
            let span = or_else(digits(r#"<w:gridSpan\b[^>]*\bw:val="(\d+)""#, existing), 1.0).max(1.0) as usize;
            let from = index.get().min(widths.len());
            let covered: f64 = widths[from..(from + span).min(widths.len())].iter().sum();
            let width = if covered == 0.0 || covered.is_nan() { widths.last().copied().unwrap_or(f64::NAN) } else { covered };
            index.set(index.get() + span);
            replace_word_properties(
                cell,
                "tc",
                "tcPr",
                &format!(
                    "<w:tcW w:w=\"{}\" w:type=\"dxa\"/>{}{}{}{}{}{}{}",
                    number_to_string(width),
                    keep(r"<w:gridSpan\b[^>]*\/>"),
                    keep(r"<w:hMerge\b[^>]*\/>"),
                    keep(r"<w:vMerge\b[^>]*\/>"),
                    keep(r"<w:tcBorders>[\s\S]*?<\/w:tcBorders>"),
                    keep(r"<w:shd\b[^>]*\/>"),
                    keep(r"<w:tcMar>[\s\S]*?<\/w:tcMar>"),
                    keep(r"<w:vAlign\b[^>]*\/>")
                ),
            )
        })
    })
}

fn fitted_column_widths(columns: &[String], usable: f64) -> Vec<f64> {
    let count = columns.len().max(1);
    let current_widths: Vec<f64> = columns.iter().map(|attributes| or_else(digits(r#"\bw:w="(\d+)""#, attributes), 0.0)).collect();
    let total: f64 = current_widths.iter().sum();
    if total > 0.0 {
        current_widths.iter().map(|width| mixdog_js::math::round(width / total * usable).max(240.0)).collect()
    } else {
        vec![mixdog_js::math::round(usable / count as f64); count]
    }
}

fn table_properties_with_width(table_properties: &str, usable: f64) -> String {
    let declared = format!("<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", number_to_string(usable));
    let width_element = compiled(r"<w:tblW\b[^>]*\/>", "");
    let style_element = compiled(r"(<w:tblStyle\b[^>]*\/>)", "");
    if width_element.is_match(table_properties) {
        replace_first_with(&width_element, table_properties, |_| declared.clone())
    } else if style_element.is_match(table_properties) {
        replace_first_with(&style_element, table_properties, |found| format!("{}{declared}", found.get(1).unwrap_or("")))
    } else {
        format!("{declared}{table_properties}")
    }
}

/// `fitDocxTable(zip, op)`: rebalances a table across the text column, keeping each column's share and every cell's own
/// properties.
pub fn fit_docx_table(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let mut current = zip.text(DOCUMENT_PART);
    let table = docx_table(&current, op.get("table"))?;
    let usable = usable_text_width(&current)?;
    let grid = first_match(r"<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>", &table.xml);
    let columns: Vec<String> = match grid {
        Some(grid) => compiled(r"<w:gridCol\b([^>]*)\/>", "g").captures_iter(grid).map(|found| found.get(1).unwrap_or("").to_owned()).collect(),
        None => Vec::new(),
    };
    let count = columns.len().max(1);
    let widths = fitted_column_widths(&columns, usable);
    let mut next_table = match grid {
        Some(grid) => {
            let rebuilt = format!(
                "<w:tblGrid>{}</w:tblGrid>",
                widths.iter().map(|width| format!("<w:gridCol w:w=\"{}\"/>", number_to_string(*width))).collect::<String>()
            );
            replace_text(&table.xml, grid, &rebuilt)
        }
        None => table.xml.clone(),
    };
    let table_properties = match op.get("properties").filter(|value| truthy(Some(*value))) {
        Some(properties) => word_table_properties(properties, 0.0),
        None => first_group(r"<w:tblPr>([\s\S]*?)<\/w:tblPr>", &next_table).unwrap_or("").to_owned(),
    };
    let table_properties = table_properties_with_width(&table_properties, usable);
    next_table = fit_table_cells(&replace_word_properties(&next_table, "tbl", "tblPr", &table_properties), &widths);
    current = replace_docx_table(&current, &table, &next_table);
    zip.set(DOCUMENT_PART, current);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("table".to_owned(), json_number(number_of(op.get("table"))));
    result.insert("width".to_owned(), json_number(usable));
    result.insert("columns".to_owned(), json!(count));
    Ok(Value::Object(result))
}

// ---- content controls -----------------------------------------------------------------------------------------------------------

/// `controlFilledWith(control, contentInner, text)`: one run carries the value, the rest are dropped: a control filled across its
/// old runs keeps fragments of the placeholder it replaced. A placeholder control shows grey prompt text until the flag goes.
fn control_filled_with(control: &str, content_inner: &str, text: &str) -> String {
    let first = first_match(r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>", content_inner);
    let run_properties = first.and_then(|first| first_match(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>", first)).unwrap_or("");
    let run = format!("<w:r>{run_properties}{}</w:r>", word_text_element(text, false));
    let paragraph = match first_match(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", content_inner) {
        Some(first_paragraph) => {
            let head = first_match(r"^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?", first_paragraph).unwrap_or("<w:p>");
            format!("{head}{run}</w:p>")
        }
        None => run,
    };
    let cleaned = compiled(r"<w:showingPlcHdr\b[^>]*\/>", "g").replace_all_with(control, |_| String::new());
    replace_first_with(&compiled(r"<w:sdtContent\b[^>]*>[\s\S]*?<\/w:sdtContent>", ""), &cleaned, |_| format!("<w:sdtContent>{paragraph}</w:sdtContent>"))
}

/// word/document.xml first, then headers and footers in name order.
fn document_part_first(left: &String, right: &String) -> std::cmp::Ordering {
    if left == DOCUMENT_PART {
        return std::cmp::Ordering::Less;
    }
    if right == DOCUMENT_PART {
        return std::cmp::Ordering::Greater;
    }
    locale_compare_en(left, right)
}

/// `fillDocxContentControl(zip, op)`: fills one named or numbered content control, in the body, a header, or a footer.
pub fn fill_docx_content_control(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let text = string_or_blank(op.get("text"));
    let tag = js_trim(&string_or_empty(op.get("tag"))).to_owned();
    let wanted = number_of(op.get("control"));
    if tag.is_empty() && !(wanted.is_finite() && wanted.fract() == 0.0) {
        return Err("set_content_control requires tag or control".to_owned());
    }
    let story = compiled(r"^word\/(document|header\d+|footer\d+)\.xml$", "i");
    let mut parts: Vec<String> = zip.names().into_iter().filter(|name| story.is_match(name)).collect();
    parts.sort_by(document_part_first);
    let ordinal = Cell::new(0.0f64);
    let filled: RefCell<Option<(f64, String)>> = RefCell::new(None);
    let failure: RefCell<Option<String>> = RefCell::new(None);
    for part in &parts {
        let xml = zip.text(part);
        if xml.is_empty() {
            continue;
        }
        let changed = Cell::new(false);
        let next = compiled(r"<w:sdt\b[^>]*>[\s\S]*?<\/w:sdt>", "g").replace_all_with(&xml, |found| {
            let control = found.get(0).unwrap_or("");
            if filled.borrow().is_some() || failure.borrow().is_some() {
                return control.to_owned();
            }
            ordinal.set(ordinal.get() + 1.0);
            let properties = first_group(r"<w:sdtPr\b[^>]*>([\s\S]*?)<\/w:sdtPr>", control).unwrap_or("");
            let control_tag = xml_decode(first_group(r#"<w:tag\b[^>]*\bw:val="([^"]*)""#, properties).unwrap_or(""));
            let wrong = if tag.is_empty() { ordinal.get() != wanted } else { control_tag != tag };
            if wrong {
                return control.to_owned();
            }
            let lock = first_group(r#"<w:lock\b[^>]*\bw:val="([^"]*)""#, properties).unwrap_or("");
            if compiled(r"contentLocked|sdtContentLocked", "i").is_match(lock) {
                let named = if tag.is_empty() { number_to_string(wanted) } else { tag.clone() };
                *failure.borrow_mut() = Some(format!("DOCX content control {named} is locked for editing (lock: {lock})"));
                return control.to_owned();
            }
            let Some(body) = first_group(r"<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>", control) else { return control.to_owned() };
            changed.set(true);
            *filled.borrow_mut() = Some((ordinal.get(), control_tag));
            control_filled_with(control, body, &text)
        });
        if let Some(message) = failure.borrow_mut().take() {
            return Err(message);
        }
        if changed.get() {
            zip.set(part, next);
            break;
        }
    }
    let Some((control, control_tag)) = filled.into_inner() else {
        return Err(if tag.is_empty() {
            format!("DOCX content control {} not found", number_to_string(wanted))
        } else {
            format!("DOCX content control not found for tag: {tag}")
        });
    };
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    result.insert("control".to_owned(), json_number(control));
    if !control_tag.is_empty() {
        result.insert("tag".to_owned(), json!(control_tag));
    }
    result.insert("text".to_owned(), json!(text));
    Ok(Value::Object(result))
}

// ---- paragraph edits -------------------------------------------------------------------------------------------------------------

/// `movedParagraphInner(inner, model, paragraph, destination)`: moves the paragraph before the destination-th remaining
/// paragraph, or to the end of the body when there is none.
fn moved_paragraph_inner(inner: &str, blocks: &[BodyBlock], paragraph: &BodyBlock, destination: f64) -> String {
    let remaining: Vec<&BodyBlock> = blocks.iter().filter(|block| block.start != paragraph.start).collect();
    let paragraph_blocks: Vec<&&BodyBlock> = remaining.iter().filter(|block| block.name == "w:p").collect();
    let anchor = nth(&paragraph_blocks, destination).copied();
    let without = format!("{}{}", &inner[..paragraph.start], &inner[paragraph.end..]);
    let Some(anchor) = anchor else { return format!("{without}{}", paragraph.xml) };
    let adjusted_start = if anchor.start > paragraph.start { anchor.start - paragraph.xml.len() } else { anchor.start };
    format!("{}{}{}", &without[..adjusted_start], paragraph.xml, &without[adjusted_start..])
}

/// `paragraphWithText(paragraph, op)`: untracked text edits: set_run_text replaces one run, set_paragraph_text keeps the first
/// run and empties the rest, and an empty paragraph gains a run.
fn paragraph_with_text(paragraph: &BodyBlock, op: &Value) -> Result<String, String> {
    let mut nodes = text_nodes(&paragraph.xml, "w:t");
    if nodes.is_empty() {
        if is_op(op, "set_run_text") {
            return Err(format!("DOCX paragraph {} has no editable text", shown(op.get("paragraph"))));
        }
        let run = format!("<w:r>{}</w:r>", word_text_content(&string_or_blank(op.get("text")), true));
        if let Some(range) = compiled(r"<\/w:p>\s*$", "").find(&paragraph.xml) {
            return Ok(format!("{}{run}</w:p>{}", &paragraph.xml[..range.start], &paragraph.xml[range.end..]));
        }
        if let Some(range) = compiled(r"\/>\s*$", "").find(&paragraph.xml) {
            return Ok(format!("{}>{run}</w:p>{}", &paragraph.xml[..range.start], &paragraph.xml[range.end..]));
        }
        return Err(format!("DOCX paragraph {} is malformed", shown(op.get("paragraph"))));
    }
    if is_op(op, "set_run_text") {
        let run = number_of(op.get("run")) - 1.0;
        if run < 0.0 || run.fract() != 0.0 || run >= nodes.len() as f64 {
            return Err(format!("DOCX run {} not found in paragraph {}", shown(op.get("run")), shown(op.get("paragraph"))));
        }
        nodes[run as usize].text = string_or_blank(op.get("text"));
        return Ok(rebuild_text_nodes(&paragraph.xml, "w:t", &nodes));
    }
    Ok(with_first_run_text(&paragraph.xml, &string_or_blank(op.get("text"))))
}

/// `withParagraphMarkRevision(paragraphXml, mark)`: a deleted paragraph mark lives in the paragraph's own run properties: the
/// mark joins an existing `<w:rPr>`, else opens one under `<w:pPr>`, else opens a `<w:pPr>` at the head of the paragraph. Inside
/// `<w:rPr>` the schema puts an insertion before a deletion, so a mark another reviewer inserted keeps its place ahead of the
/// deletion that rejects it.
fn with_paragraph_mark_revision(paragraph_xml: &str, mark: &str) -> String {
    if !compiled(r"<w:pPr(?:\s[^>]*)?>", "").is_match(paragraph_xml) {
        return replace_first_with(&compiled(r"^(<w:p(?:\s[^>]*)?>)", ""), paragraph_xml, |found| {
            format!("{}<w:pPr><w:rPr>{mark}</w:rPr></w:pPr>", found.get(1).unwrap_or(""))
        });
    }
    if compiled(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>\s*<\/w:pPr>", "").is_match(paragraph_xml) {
        return replace_first_with(&compiled(r"(<w:rPr(?:\s[^>]*)?>)((?:<w:ins\b[^>]*\/>|<w:ins\b[^>]*>[\s\S]*?<\/w:ins>)?)", ""), paragraph_xml, |found| {
            format!("{}{}{mark}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""))
        });
    }
    replace_text(paragraph_xml, "</w:pPr>", &format!("<w:rPr>{mark}</w:rPr></w:pPr>"))
}

/// The author an operation names, as `revisionAttributes` reads it (a missing one is the default reviewer).
fn author_of(op: &Value) -> String {
    string_or_empty(op.get("author"))
}

/// `editDocxParagraph(zip, op, tracking)`: rewrites, removes, or moves one body paragraph, tracked when the document tracks.
pub fn edit_docx_paragraph(zip: &mut Package, op: &Value, tracking: bool) -> Result<Value, String> {
    let mut current = zip.text(DOCUMENT_PART);
    let model = docx_body_model(&current);
    let paragraphs: Vec<&BodyBlock> = model.blocks.iter().filter(|block| block.name == "w:p").collect();
    let Some(paragraph) = nth(&paragraphs, number_of(op.get("paragraph"))).copied() else {
        return Err(format!("DOCX paragraph {} not found", shown(op.get("paragraph"))));
    };
    let body = model.body.as_ref().expect("a body holds the paragraph");
    let author = author_of(op);
    let splice = |replacement: &str| format!("{}{replacement}{}", &body.inner[..paragraph.start], &body.inner[paragraph.end..]);
    let mut between = false;
    let next_inner = if is_op(op, "remove_paragraph") && tracking {
        let id = next_revision_id(&current);
        let marked = mark_runs_deleted(&paragraph.xml, id, &author);
        let mark = format!("<w:del {}/>", revision_attributes(id + PARAGRAPH_MARK_ID_OFFSET, &author));
        splice(&with_paragraph_mark_revision(&marked, &mark))
    } else if is_op(op, "remove_paragraph") {
        // The only paragraph between two tables is what keeps them two: removed, Word and LibreOffice read one table with the
        // second one's rows under the first. Its words go and an empty paragraph stays.
        between =
            compiled(r"<\/w:tbl>\s*$", "").is_match(&body.inner[..paragraph.start]) && compiled(r"^\s*<w:tbl[\s>]", "").is_match(&body.inner[paragraph.end..]);
        splice(if between { "<w:p/>" } else { "" })
    } else if is_op(op, "move_paragraph") {
        moved_paragraph_inner(&body.inner, &model.blocks, paragraph, mixdog_js::math::max(1.0, number_of(op.get("index"))))
    } else if tracking && is_op(op, "set_paragraph_text") {
        splice(&tracked_paragraph_rewrite(&paragraph.xml, &string_or_blank(op.get("text")), next_revision_id(&current), &author)?)
    } else {
        splice(&paragraph_with_text(paragraph, op)?)
    };
    current = format!("{}{next_inner}{}", &current[..body.start], &current[body.end..]);
    zip.set(DOCUMENT_PART, current);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(true));
    if tracking && (is_op(op, "set_paragraph_text") || is_op(op, "remove_paragraph")) {
        result.insert("tracked".to_owned(), json!(true));
    }
    if between {
        result.insert("keptBetweenTables".to_owned(), json!(true));
    }
    Ok(Value::Object(result))
}

// ---- table cells ------------------------------------------------------------------------------------------------------------------

fn styled_docx_cell(cell: &str, op: &Value) -> Result<String, String> {
    let properties = op.get("properties").unwrap_or(&Value::Null);
    let mut next_cell = merge_word_cell_properties(cell, properties);
    let cell_size = number_of(properties.get("fontSize"));
    let sized = cell_size.is_finite() && cell_size > 0.0;
    next_cell = apply_word_run_format(&next_cell, &cell_run_format(properties, cell_size, sized));
    if sized {
        let pitch = number_to_string(exact_line_pitch_twips(cell_size));
        next_cell = compiled(r#"(<w:spacing\b[^>]*\bw:line=")(\d+)("[^>]*\bw:lineRule="(?:atLeast|exact)")"#, "g")
            .replace_all_with(&next_cell, |found| format!("{}{pitch}{}", found.get(1).unwrap_or(""), found.get(3).unwrap_or("")));
    }
    let alignment = js_to_lowercase(js_trim(&string_or_empty(properties.get("horizontalAlignment"))));
    if !alignment.is_empty() {
        let justification = word_justification(&alignment);
        if justification.is_empty() {
            return Err(format!("set_table_cell_style horizontalAlignment must be left, center, right, or justify, not {alignment}"));
        }
        next_cell = justify_word_paragraphs(&next_cell, justification);
    }
    Ok(next_cell)
}

fn cell_run_format(properties: &Value, cell_size: f64, sized: bool) -> String {
    let cell_font = if truthy(properties.get("fontName")) { xml_encode(&value_to_string(&properties["fontName"])) } else { String::new() };
    let cell_east_asia = if truthy(properties.get("fontNameEastAsia")) { xml_encode(&value_to_string(&properties["fontNameEastAsia"])) } else { String::new() };
    let latin_font_attrs = if cell_font.is_empty() { String::new() } else { format!(" w:ascii=\"{cell_font}\" w:hAnsi=\"{cell_font}\" w:cs=\"{cell_font}\"") };
    let east_asia_font_attrs = if cell_east_asia.is_empty() { String::new() } else { format!(" w:eastAsia=\"{cell_east_asia}\"") };
    let toggled = |tag: &str, value: Option<&Value>| match value {
        None => String::new(),
        Some(value) if truthy(Some(value)) => format!("<w:{tag}/><w:{tag}Cs/>"),
        Some(_) => format!("<w:{tag} w:val=\"0\"/><w:{tag}Cs w:val=\"0\"/>"),
    };
    [
        if cell_font.is_empty() && cell_east_asia.is_empty() { String::new() } else { format!("<w:rFonts{latin_font_attrs}{east_asia_font_attrs}/>") },
        toggled("b", properties.get("bold")),
        toggled("i", properties.get("italic")),
        if truthy(properties.get("color")) {
            let color = value_to_string(&properties["color"]);
            format!("<w:color w:val=\"{}\"/>", xml_encode(color.strip_prefix('#').unwrap_or(&color)))
        } else {
            String::new()
        },
        if sized {
            let half_points = number_to_string(mixdog_js::math::round(cell_size * 2.0));
            format!("<w:sz w:val=\"{half_points}\"/><w:szCs w:val=\"{half_points}\"/>")
        } else {
            String::new()
        },
    ]
    .concat()
}

/// A merged cell keeps what it carried and takes the spans; its width becomes the widths it joins. Children stay in schema
/// order: cnfStyle, tcW, gridSpan, vMerge, then the rest.
fn merged_cell_xml(joined: &[&str], spans: &str) -> String {
    let existing = first_group(r"<w:tcPr(?:\s[^>]*)?>([\s\S]*?)<\/w:tcPr>", joined[0]).unwrap_or("");
    let kept = compiled(r"<w:(tcW|gridSpan|hMerge|vMerge)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)", "g").replace_all_with(existing, |_| String::new());
    let conditional = first_match(r"<w:cnfStyle\b[^>]*?(?:\/>|>[\s\S]*?<\/w:cnfStyle>)", &kept).unwrap_or("").to_owned();
    let rest = if conditional.is_empty() { kept.clone() } else { replace_text(&kept, &conditional, "") };
    let widths: Vec<Option<&str>> = joined.iter().map(|xml| first_group(r#"<w:tcW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa""#, xml)).collect();
    let width = if widths.iter().all(Option::is_some) {
        let sum: f64 = widths.iter().map(|value| string_to_number(value.unwrap_or(""))).sum();
        format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", number_to_string(sum))
    } else {
        String::new()
    };
    replace_word_properties(joined[0], "tc", "tcPr", &format!("{conditional}{width}{spans}{rest}"))
}

/// `mergedDocxTable({ table, rows, row, cells }, op)`: merges the located cell across colSpan columns (dropping the absorbed
/// cells) and rowSpan rows (continuation cells become vMerge, spanning the same columns: a block merge left the continuation
/// rows' absorbed cells in place, one grid column too many a cell).
fn merged_docx_table(table: &Matched, rows: &[Matched], row: &Matched, cells: &[Matched], op: &Value) -> String {
    let col_span = or_else(number_of(op.get("colSpan")), 1.0).max(1.0) as usize;
    let row_span = or_else(number_of(op.get("rowSpan")), 1.0).max(1.0) as usize;
    let grid_span = if col_span > 1 { format!("<w:gridSpan w:val=\"{col_span}\"/>") } else { String::new() };
    let first = (number_of(op.get("col")) - 1.0) as usize;
    // By position: two cells of one row can read the same (empty, equally wide), and replacing by text took the first.
    let merge_row = |row_xml: &str, row_cells: &[Matched], spans: &str| -> String {
        let joined = &row_cells[first.min(row_cells.len())..first.saturating_add(col_span).min(row_cells.len())];
        let last = joined.last().expect("the named cell exists");
        let end = last.index + last.xml.len();
        let merged = merged_cell_xml(&joined.iter().map(|entry| entry.xml.as_str()).collect::<Vec<_>>(), spans);
        format!("{}{merged}{}", &row_xml[..joined[0].index], &row_xml[end..])
    };
    let row_number = number_of(op.get("row"));
    let mut next_table = replace_text(
        &table.xml,
        &row.xml,
        &merge_row(&row.xml, cells, &format!("{grid_span}{}", if row_span > 1 { "<w:vMerge w:val=\"restart\"/>" } else { "" })),
    );
    if row_span > 1 {
        let mut row_index = row_number as usize;
        while (row_index as f64) < row_number + row_span as f64 - 1.0 {
            let Some(continuation) = rows.get(row_index) else { break };
            let continuation_cells = row_cell_matches(&continuation.xml);
            if continuation_cells.get(first).is_some() {
                next_table =
                    replace_text(&next_table, &continuation.xml, &merge_row(&continuation.xml, &continuation_cells, &format!("{grid_span}<w:vMerge/>")));
            }
            row_index += 1;
        }
    }
    next_table
}

/// `styleOrMergeDocxTableCell(zip, op)`: styles one table cell, or merges it across columns and rows.
pub fn style_or_merge_docx_table_cell(zip: &mut Package, op: &Value) -> Result<Value, String> {
    let mut current = zip.text(DOCUMENT_PART);
    let table = docx_table(&current, op.get("table"))?;
    let rows = table_row_matches(&table.xml);
    let Some(row) = nth(&rows, number_of(op.get("row"))) else { return Err(missing_docx_row_error(op, &table.xml)) };
    let cells = row_cell_matches(&row.xml);
    let Some(cell) = nth(&cells, number_of(op.get("col"))) else { return Err(missing_docx_cell_error(op, &cells)) };
    let next_table = if is_op(op, "set_table_cell_style") {
        replace_text(&table.xml, &cell.xml, &styled_docx_cell(&cell.xml, op)?)
    } else {
        merged_docx_table(&table, &rows, row, &cells, op)
    };
    current = replace_docx_table(&current, &table, &next_table);
    zip.set(DOCUMENT_PART, current);
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(next_table != table.xml));
    result.insert("table".to_owned(), json_number(number_of(op.get("table"))));
    result.insert("row".to_owned(), json_number(number_of(op.get("row"))));
    result.insert("col".to_owned(), json_number(number_of(op.get("col"))));
    Ok(Value::Object(result))
}

// ---- resolving tracked changes ------------------------------------------------------------------------------------------------

/// What one `accept` or `reject` asks for.
struct ResolutionRequest {
    resolution: String,
    target: f64,
    revision_id: String,
    author: String,
    single: bool,
}

/// What settling the stories counted.
#[derive(Default)]
struct Totals {
    resolved: usize,
    merged: usize,
    cleared: usize,
    unmerged: usize,
    rows_removed: usize,
    rows_cleared: usize,
    property_changes: usize,
}

impl Totals {
    fn add(&mut self, story: &SettledStory) {
        self.resolved += story.resolved;
        self.merged += story.merged;
        self.cleared += story.cleared;
        self.unmerged += story.unmerged;
        self.rows_removed += story.rows_removed;
        self.rows_cleared += story.rows_cleared;
        self.property_changes += story.property_changes;
    }
}

/// `settleDocxStories(zip, stories, totals, request)`: settles each story part in turn, adding its counts to `totals`. A single
/// addressed revision (by ordinal or id) stops at the part that held it; ordinals run across the parts in the order given.
fn settle_docx_stories(zip: &mut Package, stories: &[&String], totals: &mut Totals, request: &ResolutionRequest) -> (Vec<String>, bool) {
    let mut reviewers: Vec<String> = Vec::new();
    let mut ordinal_offset = 0.0;
    let mut settled = false;
    for part in stories {
        let current = zip.text(part);
        if current.is_empty() {
            continue;
        }
        let spans = if request.target != 0.0 || !request.author.is_empty() { docx_revision_tree(&current) } else { Vec::new() };
        let flat = flatten_docx_revisions(&spans);
        for span in &flat {
            if !reviewers.contains(&span.author) {
                reviewers.push(span.author.clone());
            }
        }
        let mut part_target = 0.0;
        if request.target != 0.0 {
            let first = ordinal_offset + 1.0;
            ordinal_offset += flat.len() as f64;
            if request.target < first || request.target > ordinal_offset {
                continue;
            }
            part_target = request.target - first + 1.0;
        }
        // An ordinal is a whole number: a fractional one is no revision's place, so no wrapper is settled by it.
        if part_target.fract() != 0.0 {
            continue;
        }
        let story = settle_docx_story(
            &current,
            &SettleOptions { resolution: &request.resolution, target: part_target as usize, id: &request.revision_id, author: &request.author },
        );
        totals.add(&story);
        let resolved = story.resolved;
        if story.xml != current {
            zip.set(part, story.xml);
        }
        if request.single && resolved > 0 {
            settled = true;
            break;
        }
    }
    (reviewers, settled)
}

fn revision_resolution_request(op: &Value) -> Result<ResolutionRequest, String> {
    let resolution = js_to_lowercase(&if truthy(op.get("resolution")) { value_to_string(&op["resolution"]) } else { "accept".to_owned() });
    if resolution != "accept" && resolution != "reject" {
        return Err(format!("{} resolution must be accept or reject", shown(op.get("op"))));
    }
    // One revision is addressed by the snapshot ordinal or, portable only, by its w:id; either way the paragraph marks and
    // formatting records stay untouched because they carry no ordinal.
    let named = |field: &str| op.get(field).filter(|value| !value.is_null() && value.as_str() != Some(""));
    let revision_id = if is_op(op, "resolve_revision") { named("id").map(value_to_string).unwrap_or_default() } else { String::new() };
    let target = if is_op(op, "resolve_revision") && revision_id.is_empty() { or_else(number_of(op.get("revision")), 1.0).max(1.0) } else { 0.0 };
    // resolve_revisions may settle one reviewer only; the other reviewers' wrappers, paragraph marks, rows, and formatting
    // records stay tracked.
    let author = if is_op(op, "resolve_revisions") { named("author").map(value_to_string).unwrap_or_default() } else { String::new() };
    let single = target != 0.0 || !revision_id.is_empty();
    Ok(ResolutionRequest { resolution, target, revision_id, author, single })
}

/// `unmatchedAuthorNote(author, reviewers)`: a label that matches nobody is most often a misspelt reviewer; the names actually
/// present let the caller correct it.
fn unmatched_author_note(author: &str, reviewers: &[String]) -> String {
    if reviewers.is_empty() {
        format!("No revision by \"{author}\"; the document carries no tracked change.")
    } else {
        format!(
            "No revision by \"{author}\"; the tracked changes are by {}.",
            reviewers.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ")
        )
    }
}

/// `resolveDocxRevisions(zip, parts, op)`: accepts or rejects tracked changes across the body, headers, footers, and notes.
pub fn resolve_docx_revisions(zip: &mut Package, parts: &[String], op: &Value) -> Result<Value, String> {
    let request = revision_resolution_request(op)?;
    // Headers, footers, and notes carry tracked changes of their own, and Word's accept-all settles them too. Snapshot ordinals
    // run through the story parts in name order, which is the order walked here.
    let mut stories: Vec<&String> = parts.iter().filter(|part| is_story_part(part)).collect();
    stories.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut totals = Totals::default();
    let (reviewers, settled) = settle_docx_stories(zip, &stories, &mut totals, &request);
    if request.single && !settled {
        return Err(if request.revision_id.is_empty() {
            format!("DOCX revision {} not found", number_to_string(request.target))
        } else {
            format!("DOCX revision id {} not found", request.revision_id)
        });
    }
    let comments_removed = if request.single { 0 } else { prune_orphan_comments(zip, parts) };
    Ok(resolution_result(op, &request, &totals, &reviewers, comments_removed))
}

fn resolution_result(op: &Value, request: &ResolutionRequest, totals: &Totals, reviewers: &[String], comments_removed: usize) -> Value {
    let paragraph_marks = totals.merged + totals.cleared + totals.unmerged;
    let table_rows = totals.rows_removed + totals.rows_cleared;
    let changed = totals.resolved > 0 || paragraph_marks > 0 || table_rows > 0 || totals.property_changes > 0 || comments_removed > 0;
    let note = if !request.author.is_empty() && !changed { unmatched_author_note(&request.author, reviewers) } else { String::new() };
    let mut result = result_of(op);
    result.insert("changed".to_owned(), json!(changed));
    result.insert("resolution".to_owned(), json!(request.resolution));
    result.insert("resolved".to_owned(), json!(totals.resolved));
    if !request.revision_id.is_empty() {
        result.insert("id".to_owned(), json!(request.revision_id));
    }
    if !request.author.is_empty() {
        result.insert("author".to_owned(), json!(request.author));
    }
    if !note.is_empty() {
        result.insert("note".to_owned(), json!(note));
    }
    if paragraph_marks > 0 {
        result.insert("paragraphMarks".to_owned(), json!(paragraph_marks));
        result.insert("mergedParagraphs".to_owned(), json!(totals.merged));
    }
    if table_rows > 0 {
        result.insert("tableRows".to_owned(), json!({ "removed": totals.rows_removed, "cleared": totals.rows_cleared }));
    }
    if totals.property_changes > 0 {
        result.insert("propertyChanges".to_owned(), json!(totals.property_changes));
    }
    if comments_removed > 0 {
        result.insert("commentsRemoved".to_owned(), json!(comments_removed));
    }
    if totals.unmerged > 0 {
        result.insert(
            "note".to_owned(),
            json!(format!(
                "{} paragraph mark(s) could not join the next block (a table or the end of the body); the mark was cleared instead.",
                totals.unmerged
            )),
        );
    }
    Value::Object(result)
}
