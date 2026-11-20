//! `assurance-structure-docx.mjs`: Word document structure review, the heading hierarchy and the body order.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, number_to_string, slice_utf16, string_to_number, value_to_string};
use serde_json::Value;

use super::{coalesce, distinct_sorted, length, list, nested, num, num0, path_or, text, trimmed, warn};
use crate::{field, field_of, is_true, is_truthy};

/// A heading is read as a heading because its type leads the body's, and one level carries one type.
const HEADING_TYPE_TOLERANCE: f64 = 0.05;
const DISPLAY_SIZE: f64 = 18.0;

static HEADING_STYLE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("(?:title|heading|제목|표제)", "i"));
static TITLE_STYLE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("(?:title|제목|표제)", "i"));
static HEADING_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:heading|제목\s*\d)", "i"));
static LEVEL_DIGIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("([1-9])", ""));
static LITERAL_BULLET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[•·●▪◦■*-]\s", ""));
/// A total row is a total by its label.
static TOTAL_LABEL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계|계)(?:\s|$))", "i"));
static FIGURE_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[\s+\-−₩$€¥]*[\d,.]+\s*(?:%|%p|[가-힣A-Za-z]{0,3})?\s*$", ""));

fn paragraph_size(paragraph: &Value) -> f64 {
    num0(nested(paragraph, "font", "size"))
}

/// The upper median of the numbers, as `sorted[Math.floor(length / 2)]`.
fn median_number(mut values: Vec<f64>) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied()
}

/// The upper median of the texts under JavaScript's string order (UTF-16 code units); an empty text is no value.
fn median_text(values: Vec<String>) -> Option<String> {
    let mut kept: Vec<String> = values.into_iter().filter(|value| !value.is_empty()).collect();
    kept.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let at = kept.len() / 2;
    kept.into_iter().nth(at)
}

/// Automatic colour is the effective default, black.
fn paragraph_color(paragraph: &Value) -> String {
    let font_color = nested(paragraph, "font", "color");
    let raw = if is_truthy(font_color) { text(font_color) } else { text(field(paragraph, "color")) };
    let color = raw.strip_prefix('#').unwrap_or(&raw).to_uppercase();
    if color == "AUTO" { "000000".to_owned() } else { color }
}

fn paragraph_tracking(paragraph: &Value) -> f64 {
    let font = field(paragraph, "font");
    let spacing = coalesce(field_of(font, "letterSpacing"), coalesce(field_of(font, "charSpacing"), field_of(font, "spacing")));
    num0(spacing)
}

fn paragraph_caps(paragraph: &Value) -> bool {
    ["caps", "allCaps", "smallCaps"].iter().any(|key| is_truthy(nested(paragraph, "font", key)))
}

fn paragraph_gap(paragraph: &Value) -> f64 {
    let format = field(paragraph, "format");
    let before = coalesce(field_of(format, "spacingBefore"), field(paragraph, "spaceBefore"));
    let after = coalesce(field_of(format, "spacingAfter"), field(paragraph, "spaceAfter"));
    num0(before) + num0(after)
}

struct Body {
    size: f64,
    color: String,
    gap: f64,
}

/// Whether a heading stands apart from the body by any of: size, weight, colour, letter-spacing or caps, or spacing.
fn heading_is_distinct(paragraph: &Value, body: &Body) -> bool {
    let size = paragraph_size(paragraph);
    if body.size != 0.0 && size > body.size {
        return true;
    }
    if is_truthy(nested(paragraph, "font", "bold")) {
        return true;
    }
    let color = paragraph_color(paragraph);
    let own = if color.is_empty() { "000000" } else { color.as_str() };
    let base = if body.color.is_empty() { "000000" } else { body.color.as_str() };
    if own != base {
        return true;
    }
    if paragraph_caps(paragraph) || paragraph_tracking(paragraph) != 0.0 {
        return true;
    }
    paragraph_gap(paragraph) >= body.gap + 6.0
}

/// `headingLevel(paragraph)`: none for a body paragraph, 0 for a title, else the level of the heading style.
fn heading_level(paragraph: Option<&Value>) -> Option<f64> {
    // A localized Word names its heading styles by id; the portable reader carries the name beside it.
    let named = paragraph.and_then(|inner| field(inner, "styleName"));
    let style = if is_truthy(named) { text(named) } else { text(paragraph.and_then(|inner| field(inner, "style"))) };
    if !HEADING_STYLE.is_match(&style) {
        return None;
    }
    if TITLE_STYLE.is_match(&style) && !HEADING_WORD.is_match(&style) {
        return Some(0.0);
    }
    let level = LEVEL_DIGIT.captures(&style).and_then(|found| found.get(1)).map_or(f64::NAN, string_to_number);
    Some(if level.is_finite() && level.fract() == 0.0 { level } else { 1.0 })
}

type Heading<'a> = (&'a Value, f64);

fn review_heading_type(content: &[&Value], headings: &[Heading<'_>], issues: &mut Vec<Value>) {
    let bodies: Vec<&Value> = content.iter().copied().filter(|paragraph| heading_level(Some(*paragraph)).is_none()).collect();
    let body = Body {
        size: median_number(bodies.iter().map(|paragraph| paragraph_size(paragraph)).filter(|size| *size > 0.0).collect()).unwrap_or(0.0),
        color: median_text(bodies.iter().map(|paragraph| paragraph_color(paragraph)).collect()).unwrap_or_default(),
        gap: median_number(bodies.iter().map(|paragraph| paragraph_gap(paragraph)).collect()).unwrap_or(0.0),
    };
    let mut by_level: Vec<(f64, Vec<(&Value, f64)>)> = Vec::new();
    for (paragraph, level) in headings {
        let size = paragraph_size(paragraph);
        if size == 0.0 {
            continue;
        }
        match by_level.iter_mut().find(|entry| entry.0 == *level) {
            Some((_, members)) => members.push((*paragraph, size)),
            None => by_level.push((*level, vec![(*paragraph, size)])),
        }
        if body.size != 0.0 && !heading_is_distinct(paragraph, &body) {
            issues.push(warn(
                "heading_not_distinct",
                Some(path_or(paragraph, "/body")),
                format!(
                    "Heading is set at {} pt against {} pt body text and differs in no size, weight, colour, letter-spacing, caps, or spacing; the hierarchy is not visible.",
                    number_to_string(size),
                    number_to_string(body.size)
                ),
            ));
        }
    }
    for (level, all_members) in &by_level {
        // A level's first occurrence may be a lead-in variant (a larger opening heading); the rest must agree.
        let members = &all_members[1..];
        if members.len() < 2 {
            continue;
        }
        let sizes: Vec<f64> = members.iter().map(|entry| entry.1).collect();
        let largest = sizes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let smallest = sizes.iter().copied().fold(f64::INFINITY, f64::min);
        if largest <= smallest * (1.0 + HEADING_TYPE_TOLERANCE) {
            continue;
        }
        issues.push(warn(
            "heading_style_inconsistent",
            Some(path_or(members[1].0, "/body")),
            format!("Level {} headings are set at {} pt; one level carries one type.", number_to_string(*level), distinct_sorted(&sizes)),
        ));
    }
}

fn heading_hierarchy_issues(content: &[&Value], headings: &[Heading<'_>], issues: &mut Vec<Value>) {
    if content.len() >= 8 && headings.is_empty() {
        issues.push(warn(
            "heading_hierarchy_missing",
            Some("/body".into()),
            "Document has substantial content but no visible title or heading hierarchy.".into(),
        ));
    }
    let mut prior: Option<f64> = None;
    for (paragraph, level) in headings {
        if let Some(before) = prior
            && *level > before + 1.0
        {
            issues.push(warn(
                "heading_hierarchy_jump",
                Some(path_or(paragraph, "/body")),
                format!("Heading level jumps from {} to {}.", number_to_string(before), number_to_string(*level)),
            ));
        }
        prior = Some(*level);
    }
}

/// A `Map` keyed by `Number(entry.index)`: a later entry replaces an earlier one and every NaN is one key.
struct ByIndex<'a>(HashMap<u64, &'a Value>);

impl<'a> ByIndex<'a> {
    fn key(index: f64) -> u64 {
        if index.is_nan() { f64::NAN.to_bits() } else { (index + 0.0).to_bits() }
    }

    fn of(entries: &'a [Value]) -> Self {
        Self(entries.iter().map(|entry| (Self::key(num(field(entry, "index"))), entry)).collect())
    }

    fn get(&self, index: f64) -> Option<&'a Value> {
        self.0.get(&Self::key(index)).copied()
    }
}

struct Block<'a> {
    kind: Option<&'a str>,
    index: Option<&'a Value>,
}

/// `wordBlockOrder(document)`: the blocks in the order the file lists them, sorted by start when all have one.
fn word_block_order<'a>(document: &'a Value, paragraphs: &'a [Value], tables: &'a [Value]) -> Vec<Block<'a>> {
    let listed = list(field(document, "blockOrder"));
    let mut blocks: Vec<(Block<'a>, f64)> = if listed.is_empty() {
        let of = |kind: &'static str| move |entry: &'a Value| (Block { kind: Some(kind), index: field(entry, "index") }, num(field(entry, "start")));
        paragraphs.iter().map(of("paragraph")).chain(tables.iter().map(of("table"))).collect()
    } else {
        listed
            .iter()
            .map(|entry| (Block { kind: field(entry, "type").and_then(Value::as_str), index: field(entry, "index") }, num(field(entry, "start"))))
            .collect()
    };
    if blocks.iter().all(|(_, start)| start.is_finite()) {
        // `left.start - right.start`: -0 and 0 are equal and keep their order, which `total_cmp` would not.
        blocks.sort_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(std::cmp::Ordering::Equal));
    }
    blocks.into_iter().map(|(block, _)| block).collect()
}

/// A heading whose next content block starts on another page, or that nothing follows, introduces nothing the reader
/// can see with it.
fn orphan_heading_issues(document: &Value, paragraphs: &[Value], tables: &[Value], issues: &mut Vec<Value>) {
    let paragraphs_by_index = ByIndex::of(paragraphs);
    let tables_by_index = ByIndex::of(tables);
    let order = word_block_order(document, paragraphs, tables);
    let page_of = |entry: &Value| {
        let start = field(entry, "pageStart");
        num(if is_truthy(start) { start } else { field(entry, "page") })
    };
    for (position, block) in order.iter().enumerate() {
        if block.kind != Some("paragraph") {
            continue;
        }
        let Some(paragraph) = paragraphs_by_index.get(num(block.index)) else { continue };
        if is_true(field(paragraph, "inTable")) || heading_level(Some(paragraph)).is_none() || trimmed(field(paragraph, "text")).is_empty() {
            continue;
        }
        let next_block = order[position + 1..]
            .iter()
            .find(|entry| entry.kind == Some("table") || !trimmed(paragraphs_by_index.get(num(entry.index)).and_then(|found| field(found, "text"))).is_empty());
        let next = next_block
            .and_then(|found| if found.kind == Some("table") { tables_by_index.get(num(found.index)) } else { paragraphs_by_index.get(num(found.index)) });
        let heading_page = page_of(paragraph);
        let next_page = next.map_or(f64::NAN, page_of);
        if next_block.is_none() || (heading_page > 0.0 && next_page > 0.0 && heading_page != next_page) {
            issues.push(warn("orphan_heading", Some(path_or(paragraph, "/body")), "Heading is separated from the content it introduces.".into()));
        }
    }
}

/// Machine tells: a bullet typed as text and a newline inside a paragraph both read as authoring by string instead of
/// by structure.
fn paragraph_text_issues(content: &[&Value], issues: &mut Vec<Value>) {
    for paragraph in content {
        let body = text(field(paragraph, "text"));
        if length(&body) > 900 {
            issues.push(warn("dense_paragraph", Some(path_or(paragraph, "/body")), "Paragraph is too dense for fast document scanning.".into()));
        }
        // Prose set at heading size, read as the Office backend reads it (past 180 characters at 18 pt).
        if length(&body) > 180 && paragraph_size(paragraph) >= 18.0 {
            issues.push(warn(
                "oversized_heading_text",
                Some(path_or(paragraph, "/body")),
                "A long paragraph uses heading-sized text and is likely mis-styled.".into(),
            ));
        }
    }
    for paragraph in content {
        let body = text(field(paragraph, "text"));
        if LITERAL_BULLET.is_match(&body) {
            issues.push(warn(
                "literal_bullet",
                Some(path_or(paragraph, "/body")),
                "Paragraph starts with a typed bullet character; a list marker comes from list formatting (listKind, set_list), never from text.".into(),
            ));
        }
        // A soft break reads back as a newline too, and Word draws that one as a line break; only the newlines
        // beyond the paragraph's breaks are the typed ones that collapse to a space.
        let newlines = body.matches('\n').count() as f64;
        if newlines > num0(field(paragraph, "softBreaks")) {
            issues.push(warn(
                "newline_in_text",
                Some(path_or(paragraph, "/body")),
                "Paragraph text carries a newline character, which Word renders as a space; split it into separate paragraphs.".into(),
            ));
        }
    }
}

fn short_table_split_issues(tables: &[Value], issues: &mut Vec<Value>) {
    for table in tables {
        let page_start = num(field(table, "pageStart"));
        let page_end = num(field(table, "pageEnd"));
        let rows = list(field(table, "rows")).len();
        if rows > 0 && rows <= 6 && page_start > 0.0 && page_end > 0.0 && page_start != page_end {
            issues.push(warn(
                "short_table_split",
                Some(path_or(table, "/body")),
                format!("A {rows}-row table is split across pages {}-{}.", number_to_string(page_start), number_to_string(page_end)),
            ));
        }
    }
}

/// `entry.path || table.path || '/body'`.
fn path_of_entry(entry: &Value, table: &Value) -> String {
    let own = text(field(entry, "path"));
    if own.is_empty() { path_or(table, "/body") } else { own }
}

/// Table type that does not suit its job, read from each cell's own type: a label set at a figure's display size, and
/// a total row set like the data above it.
fn table_type_issues(tables: &[Value], issues: &mut Vec<Value>) {
    for table in tables {
        let rows = list(field(table, "rows"));
        for row in rows {
            for cell in list(field(row, "cells")) {
                let label = trimmed(field(cell, "text"));
                let size = num0(nested(cell, "font", "size"));
                // A cell of several paragraphs (a card: its figure over its label) reports its largest type.
                if size >= DISPLAY_SIZE && length(&label) >= 6 && !label.contains('\n') && !FIGURE_TEXT.is_match(&label) {
                    issues.push(warn(
                        "table_label_oversized",
                        Some(path_of_entry(cell, table)),
                        format!(
                            "\"{}\" is set at {} pt: display size is for figures. Set labels at caption size (add_table properties.rowStyles, or set_table_cell_style).",
                            slice_utf16(&label, 24),
                            number_to_string(size)
                        ),
                    ));
                    break;
                }
            }
        }
        let Some(last) = rows.last().filter(|row| is_truthy(Some(*row))) else { continue };
        let cells = list(field(last, "cells"));
        let first_text = cells.first().and_then(|cell| field(cell, "text"));
        if rows.len() >= 3 && TOTAL_LABEL.is_match(&trimmed(first_text)) && !cells.iter().any(|cell| is_true(nested(cell, "font", "bold"))) {
            issues.push(warn(
                "total_row_unmarked",
                Some(path_of_entry(last, table)),
                format!(
                    "The \"{}\" row is set like the rows it sums; set it apart (add_table properties.totalRow:true, or bold with a rule above).",
                    js_trim(&first_text.map_or_else(|| "undefined".to_owned(), value_to_string))
                ),
            ));
        }
    }
}

/// `reviewDocxStructure(document)`.
pub fn review_docx_structure(document: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let paragraphs = list(field(document, "paragraphs"));
    let tables = list(field(document, "tables"));
    let content: Vec<&Value> =
        paragraphs.iter().filter(|paragraph| !is_true(field(paragraph, "inTable")) && !trimmed(field(paragraph, "text")).is_empty()).collect();
    let headings: Vec<Heading<'_>> = content.iter().filter_map(|paragraph| heading_level(Some(*paragraph)).map(|level| (*paragraph, level))).collect();
    review_heading_type(&content, &headings, &mut issues);
    heading_hierarchy_issues(&content, &headings, &mut issues);
    orphan_heading_issues(document, paragraphs, tables, &mut issues);
    paragraph_text_issues(&content, &mut issues);
    short_table_split_issues(tables, &mut issues);
    table_type_issues(tables, &mut issues);
    issues
}
