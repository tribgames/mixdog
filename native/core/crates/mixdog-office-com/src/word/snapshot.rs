//! `Snapshot-Word`: what a Word document holds, as the record the portable reader's snapshot has the same shape of.
//!
//! The paragraphs are walked with `Next()` (`Paragraphs.Item(n)` counts from the top of the document on every call), the
//! tracked changes, pictures, tables and page starts are read once ([`reading`](super::reading)), and every read of a
//! property is the script's: where the script wrapped a read in `try { } catch { }` a failure leaves the field out or at its
//! default, anywhere else it ends the snapshot.

use std::sync::LazyLock;

use regex::Regex;

use super::reading::ReadingContext;
use super::reading::accepted_text;
use super::reading::reading_context;
use super::styles::canonical_style_name;
use super::truth;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Object;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::collate::SortOptions;
use crate::ps::collate::sort_by_key;
use crate::ps::collate::strings_equal_ignore_case;
use crate::ps::convert;
use crate::ps::datetime;
use crate::ps::payload;
use crate::ps::text::trim_end_cr_bel;
use crate::ps::unroll;

/// `$payload.target -match '^/body/p\[(\d+)\]'`.
static PARAGRAPH_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/body/p\[(\d+)\]").expect("the paragraph target pattern is valid"));

fn dictionary() -> Object {
    Object::new(ObjectKind::Ordered)
}

fn string_value(text: &str) -> Value {
    Value::String(text.to_owned())
}

/// `[int]$value` of a payload value.
fn payload_int(value: &Value) -> Result<i32> {
    convert::to_int(value).map_err(Error::host)
}

/// `-replace '[\x01\x02\x05\x0c\x0e]', ''`: Word holds a picture, a note reference and a comment mark in the text as `\x01`,
/// `\x02` and `\x05`, and a page or section break and a column break as `\x0c` and `\x0e`; the sentence read "12% 늘었습니다\x02."
/// where the portable reader, and the page, show "12% 늘었습니다.".
fn without_controls(text: &str) -> String {
    text.chars().filter(|c| !matches!(c, '\u{1}' | '\u{2}' | '\u{5}' | '\u{c}' | '\u{e}')).collect()
}

/// `try { <text> } catch { '' }` over the text a read answers.
fn quietly(read: impl FnOnce() -> Result<String>) -> String {
    read().unwrap_or_default()
}

/// `([datetime]$value).ToUniversalTime().ToString('o')`.
fn date_text(value: &Com) -> Result<String> {
    match value {
        Com::Date(days) => datetime::oa_date_to_utc_text(*days).map_err(Error::host),
        other => Err(Error::host(format!("Cannot convert the \"{}\" value to type \"System.DateTime\".", other.dotnet_type_name()))),
    }
}

/// `Snapshot-Word`.
pub(super) fn snapshot_word(document: &Obj, payload: &Value) -> Result<Value> {
    let _ = document.call("Repaginate", &[]);
    let mut context = reading_context(document);
    let paragraph_count = super::count(&document.get("Paragraphs")?)?;
    let paged = convert::to_bool(&payload::property(payload, "paged"));
    let mut offset = if paged { payload_int(&payload::property(payload, "offset"))?.max(0) } else { 0 };
    let mut limit = if paged { payload_int(&payload::property(payload, "limit"))?.max(1) } else { paragraph_count };
    let target = payload::property(payload, "target");
    if convert::to_bool(&target) {
        if let Some(captures) = PARAGRAPH_TARGET.captures(&convert::to_ps_string(&target)) {
            offset = payload_int(&string_value(&captures[1]))? - 1;
            limit = 1;
        }
    }
    let paragraph_end = i32::try_from(i64::from(paragraph_count).min(i64::from(offset) + i64::from(limit))).unwrap_or(paragraph_count);
    let paragraphs = read_paragraphs(document, &mut context, offset, paragraph_end)?;
    let (tables, table_count) = read_tables(document, &context)?;
    let block_order = block_order(&paragraphs, &tables);
    let sections = read_sections(document)?;
    let images = read_images(document)?;
    let comments = read_comments(document)?;
    let revisions = read_revisions(document)?;
    let paragraphs = attach_revisions(paragraphs, &revisions.by_paragraph);
    let footnotes = read_notes(document, "Footnotes", "footnote")?;
    let endnotes = read_notes(document, "Endnotes", "endnote")?;
    let controls = read_content_controls(document)?;
    let path = super::string(&document.get("FullName")?);
    let track_changes = truth(&document.get("TrackRevisions")?);
    let revision_count = document.get("Revisions")?.member("Count")?;
    let pagination = if paged {
        let next = if paragraph_end < paragraph_count { Value::Int(paragraph_end) } else { Value::Null };
        Value::object(
            ObjectKind::Ordered,
            vec![
                ("unit", string_value("paragraph")),
                ("offset", Value::Int(offset)),
                ("limit", Value::Int(limit)),
                ("returned", Value::Int(count_of(&paragraphs))),
                ("total", Value::Int(paragraph_count)),
                ("nextOffset", next),
            ],
        )
    } else {
        Value::Null
    };
    Ok(Value::object(
        ObjectKind::Ordered,
        vec![
            ("format", string_value("docx")),
            ("path", Value::String(path)),
            ("trackChanges", Value::Bool(track_changes)),
            ("paragraphCount", Value::Int(paragraph_count)),
            ("tableCount", Value::Int(table_count)),
            ("commentCount", Value::Int(count_of(&comments))),
            ("revisionCount", Value::Int(super::int(&revision_count)?)),
            ("comments", Value::Array(comments)),
            ("revisions", Value::Array(revisions.entries)),
            ("revisionAuthors", Value::Array(revisions.authors)),
            ("propertyChangeCount", Value::Int(revisions.property_changes)),
            ("footnoteCount", Value::Int(count_of(&footnotes))),
            ("endnoteCount", Value::Int(count_of(&endnotes))),
            ("footnotes", Value::Array(footnotes)),
            ("endnotes", Value::Array(endnotes)),
            ("contentControlCount", Value::Int(count_of(&controls))),
            ("contentControls", Value::Array(controls)),
            ("paragraphs", Value::Array(paragraphs.into_iter().map(|entry| Value::Object(entry.object)).collect())),
            ("tables", Value::Array(tables.into_iter().map(Value::Object).collect())),
            ("blockOrder", block_order),
            ("sections", Value::Array(sections)),
            ("images", Value::Array(images)),
            ("pagination", pagination),
        ],
    ))
}

fn count_of<T>(items: &[T]) -> i32 {
    i32::try_from(items.len()).unwrap_or(i32::MAX)
}

// ---------------------------------------------------------------------------------------------------------------------
// paragraphs

/// A listed paragraph and where it starts: the facts the block order and the revisions are attached by.
struct ParagraphEntry {
    index: i32,
    start: i32,
    in_table: bool,
    path: String,
    object: Object,
}

/// The paragraphs from `offset` to `end`, walked with `Next()`.
fn read_paragraphs(document: &Obj, context: &mut ReadingContext, offset: i32, end: i32) -> Result<Vec<ParagraphEntry>> {
    let mut paragraphs = Vec::new();
    let mut current: Option<Com> = if offset < end { Some(super::item(&document.get("Paragraphs")?, offset + 1)?).filter(super::is_object) } else { None };
    let mut index = offset + 1;
    while index <= end {
        let Some(paragraph) = current.take() else { break };
        if let Some(entry) = read_paragraph(document, context, &paragraph, index)? {
            paragraphs.push(entry);
        }
        current = Some(paragraph.call_member("Next", &[])?).filter(super::is_object);
        index += 1;
    }
    Ok(paragraphs)
}

/// One paragraph's record; `None` for an empty table mark (a row's end), which stays out as it does in the portable reader.
fn read_paragraph(document: &Obj, context: &mut ReadingContext, paragraph: &Com, index: i32) -> Result<Option<ParagraphEntry>> {
    let range = paragraph.member("Range")?;
    let range_start = super::int(&range.member("Start")?)?;
    let range_end = super::int(&range.member("End")?)?;
    let in_table = context.in_table(range_start);
    let accepted = accepted_text(document, &range, context)?;
    let text = without_controls(&trim_end_cr_bel(&accepted.text));
    let deleted_text = without_controls(&trim_end_cr_bel(&accepted.deleted));
    // An empty body paragraph is listed too, as the portable reader lists it: left out, a paragraph cleared for later text
    // had no number to fill it by.
    let empty_body = text.is_empty() && deleted_text.is_empty() && !in_table;
    if text.is_empty() && deleted_text.is_empty() && !empty_body {
        return Ok(None);
    }
    // The paragraph's own style: Range.Style answers a character style laid over its first letter instead, and costs twenty
    // times as much to ask.
    let style = paragraph.member("Style")?;
    let style_name = canonical_style_name(document, &style_name_of(&style));
    let mut tab_stops = Vec::new();
    // Tab stops shape only a line that holds a tab, and Word lists every default stop beside the paragraph's own.
    if text.contains('\t') {
        let _ = read_tab_stops(paragraph, &mut tab_stops);
    }
    let format = paragraph.member("Format")?;
    let path = format!("/body/p[{index}]");
    let mut entry = dictionary();
    entry.set("path", Value::String(path.clone()));
    entry.set("index", Value::Int(index));
    entry.set("text", Value::String(text.clone()));
    entry.set("style", Value::String(style_name));
    entry.set("start", Value::Int(range_start));
    entry.set("end", Value::Int(range_end));
    entry.set("inTable", Value::Bool(in_table));
    entry.set("pageStart", Value::Int(context.page_at(range_start)));
    entry.set("pageEnd", Value::Int(context.page_at(range_start.max(range_end - 1))));
    entry.set(
        "format",
        Value::object(
            ObjectKind::Ordered,
            vec![
                ("alignment", Value::Int(super::int(&format.member("Alignment")?)?)),
                ("spacingBefore", Value::Double(super::double(&format.member("SpaceBefore")?)?)),
                ("spacingAfter", Value::Double(super::double(&format.member("SpaceAfter")?)?)),
                ("lineSpacing", Value::Double(super::double(&format.member("LineSpacing")?)?)),
                ("keepWithNext", Value::Int(super::int(&format.member("KeepWithNext")?)?)),
                ("pageBreakBefore", Value::Int(super::int(&format.member("PageBreakBefore")?)?)),
                ("tabStops", Value::Array(tab_stops)),
            ],
        ),
    );
    // The portable reader reports the same two facts from the XML: tracked changes touching the paragraph, and list
    // membership as kind + 0-based level.
    if accepted.tracked {
        entry.set("tracked", Value::Bool(true));
    }
    if !deleted_text.is_empty() {
        entry.set("deletedText", Value::String(deleted_text));
    }
    // Word can hide a run: the words stay in the document and the page does not show them. Reported like ordinary body text
    // they get quoted and edited as what the document says, so the hidden part is named beside the paragraph.
    let mut hidden_text = String::new();
    let paragraph_font = range.member("Font")?;
    let _ = read_hidden_text(&range, &paragraph_font, &text, &mut hidden_text);
    let hidden_text = trim_end_cr_bel(&hidden_text);
    if !hidden_text.is_empty() {
        entry.set("hiddenText", Value::String(hidden_text));
    }
    let mut font = None;
    let _ = read_font(&paragraph_font, &mut font);
    if let Some(font) = font {
        entry.set("font", Value::Object(font));
    }
    if let Ok(Some(list)) = read_list(&range) {
        entry.set("list", Value::Object(list));
    }
    Ok(Some(ParagraphEntry { index, start: range_start, in_table, path, object: entry }))
}

/// `try { [string]$style.NameLocal } catch { try { [string]$style.Name } catch { [string]$style } }`.
fn style_name_of(style: &Com) -> String {
    style
        .member("NameLocal")
        .map(|name| super::string(&name))
        .or_else(|_| style.member("Name").map(|name| super::string(&name)))
        .unwrap_or_else(|_| super::string(style))
}

/// The paragraph's own tab stops (a default stop is not `CustomTab`); what was read before a failure stays.
fn read_tab_stops(paragraph: &Com, stops: &mut Vec<Value>) -> Result<()> {
    let tabs = paragraph.member("TabStops")?;
    let tab_count = super::count(&tabs)?;
    for tab_index in 1..=tab_count {
        let tab = super::item(&tabs, tab_index)?;
        if !truth(&tab.member("CustomTab")?) {
            continue;
        }
        let position = super::double(&tab.member("Position")?)?;
        let alignment = super::int(&tab.member("Alignment")?)?;
        let leader = super::int(&tab.member("Leader")?)?;
        stops.push(Value::object(
            ObjectKind::Ordered,
            vec![("position", Value::Double(position)), ("alignment", Value::Int(alignment)), ("leader", Value::Int(leader))],
        ));
    }
    Ok(())
}

/// The hidden part of a paragraph: all of its text, or the hidden words of one of at most 200 words; what was read before a
/// failure stays.
fn read_hidden_text(range: &Com, font: &Com, text: &str, hidden: &mut String) -> Result<()> {
    let state = super::int(&font.member("Hidden")?)?;
    if state == -1 {
        text.clone_into(hidden);
    } else if state != 0 && super::count(&range.member("Words")?)? <= 200 {
        for word in super::items_of(&range.member("Words")?)? {
            if super::int(&word.member("Font")?.member("Hidden")?)? == -1 {
                hidden.push_str(&super::string(&word.member("Text")?));
            }
        }
    }
    Ok(())
}

/// The type the paragraph is set in, the same reading the portable snapshot resolves from styles.xml. Word answers 9999999
/// for a range set in more than one size, which says nothing about the paragraph and is left out. What was read before a
/// failure stays.
fn read_font(font: &Com, out: &mut Option<Object>) -> Result<()> {
    let size = super::double(&font.member("Size")?)?;
    if !(size > 0.0 && size < 1639.0) {
        return Ok(());
    }
    let name = super::string(&font.member("Name")?);
    let bold = super::int(&font.member("Bold")?)? == -1;
    let mut record = dictionary();
    record.set("name", Value::String(name));
    record.set("size", Value::Double(size));
    record.set("bold", Value::Bool(bold));
    let record = out.insert(record);
    // The colour (WdColor is BGR; automatic and mixed values are left out), caps and tracking.
    let color = super::long(&font.member("Color")?)?;
    if (0..=16_777_215).contains(&color) && color != 9_999_999 {
        record.set("color", Value::String(convert::color_hex(color)));
    }
    if super::int(&font.member("AllCaps")?)? == -1 || super::int(&font.member("SmallCaps")?)? == -1 {
        record.set("caps", Value::Bool(true));
    }
    let spacing = super::double(&font.member("Spacing")?)?;
    if spacing != 0.0 && spacing < 1000.0 {
        record.set("letterSpacing", Value::Double(spacing));
    }
    Ok(())
}

/// The list the paragraph is in: its kind and 0-based level. A gallery template reports an outline list type for bullets and
/// numbers alike; the level's number style (22 picture bullet, 23 bullet) is what separates them, and so does a literal mark
/// with no `%n` placeholder (the document's own bullet list keeps the Arabic number style, which an outline template cannot
/// drop).
fn read_list(range: &Com) -> Result<Option<Object>> {
    let list_format = range.member("ListFormat")?;
    let list_type = super::int(&list_format.member("ListType")?)?;
    if list_type == 0 {
        return Ok(None);
    }
    let level_number = super::int(&list_format.member("ListLevelNumber")?)?.max(1);
    let level = list_format
        .member("ListTemplate")
        .and_then(|template| template.member("ListLevels"))
        .and_then(|levels| super::item(&levels, level_number))
        .unwrap_or(Com::Null);
    let number_style = level.member("NumberStyle").and_then(|style| super::int(&style)).unwrap_or(-1);
    let number_format = level.member("NumberFormat").map(|format| super::string(&format)).unwrap_or_default();
    let literal_mark = !number_format.is_empty() && !number_format.contains('%');
    let bullet = number_style == 23 || number_style == 22 || literal_mark || list_type == 1 || list_type == 5;
    let mut list = dictionary();
    list.set("kind", string_value(if bullet { "bullet" } else { "number" }));
    list.set("level", Value::Int(level_number - 1));
    Ok(Some(list))
}

// ---------------------------------------------------------------------------------------------------------------------
// tables

/// What a table cell read: its accepted view, its struck-through words, and its type.
struct CellRecord {
    text: String,
    deleted: String,
    tracked: bool,
    size: f64,
    bold: bool,
}

/// One cell: the accepted view and the struck-through words, as for a paragraph, so a redline in a table reads the same way;
/// and the cell's type, as the portable reader states it (a stat strip's label set at the figure's size).
fn read_cell(document: &Obj, table: &Com, row: i32, column: i32, context: &ReadingContext) -> Result<CellRecord> {
    let cell_range = table.call_member("Cell", &[Com::I4(row), Com::I4(column)])?.member("Range")?;
    let accepted = accepted_text(document, &cell_range, context)?;
    let (mut size, mut bold) = (0.0, false);
    let _ = read_cell_type(&cell_range, &mut size, &mut bold);
    Ok(CellRecord { text: trim_end_cr_bel(&accepted.text), deleted: trim_end_cr_bel(&accepted.deleted), tracked: accepted.tracked, size, bold })
}

fn read_cell_type(cell_range: &Com, size: &mut f64, bold: &mut bool) -> Result<()> {
    let measured = super::double(&cell_range.member("Font")?.member("Size")?)?;
    if measured > 0.0 && measured < 1000.0 {
        *size = measured;
    }
    *bold = super::int(&cell_range.member("Font")?.member("Bold")?)? == -1;
    Ok(())
}

fn column_widths_by_columns(table: &Com, column_count: i32, widths: &mut Vec<Value>) -> Result<()> {
    for column_index in 1..=column_count {
        let column = super::item(&table.member("Columns")?, column_index)?;
        widths.push(Value::Double(super::double(&column.member("Width")?)?));
    }
    Ok(())
}

/// The fallback when the columns cannot be read (a table with merged cells): the first row's cells.
fn column_widths_by_cells(table: &Com, widths: &mut Vec<Value>) -> Result<()> {
    let first_row = super::item(&table.member("Rows")?, 1)?;
    let mut column_index = 1;
    while column_index <= super::count(&first_row.member("Cells")?)? {
        let cell = super::item(&first_row.member("Cells")?, column_index)?;
        widths.push(Value::Double(super::double(&cell.member("Width")?)?));
        column_index += 1;
    }
    Ok(())
}

/// `try { [string]$table.Style.NameLocal } catch { try { [string]$table.Style } catch { '' } }`.
fn table_style_name(table: &Com) -> String {
    table
        .member("Style")
        .and_then(|style| style.member("NameLocal"))
        .map(|name| super::string(&name))
        .or_else(|_| table.member("Style").map(|style| super::string(&style)))
        .unwrap_or_default()
}

fn read_tables(document: &Obj, context: &ReadingContext) -> Result<(Vec<Object>, i32)> {
    let table_count = super::count(&document.get("Tables")?)?;
    let mut tables = Vec::new();
    for index in 1..=table_count {
        let table = super::item(&document.get("Tables")?, index)?;
        let table_range = table.member("Range")?;
        let row_count = super::count(&table.member("Rows")?)?;
        let column_count = super::count(&table.member("Columns")?)?;
        let mut rows: Vec<Vec<Option<CellRecord>>> = Vec::new();
        for row in 1..=row_count {
            let mut cells = Vec::new();
            for column in 1..=column_count {
                cells.push(read_cell(document, &table, row, column, context).ok());
            }
            rows.push(cells);
        }
        let mut table_rows = Vec::new();
        for (row_at, cells) in rows.iter().enumerate() {
            let row = row_at as i32 + 1;
            let mut cell_values = Vec::new();
            for (column_at, record) in cells.iter().enumerate() {
                let column = column_at as i32 + 1;
                let mut cell = dictionary();
                cell.set("path", Value::String(format!("/body/tbl[{index}]/row[{row}]/cell[{column}]")));
                cell.set("index", Value::Int(column));
                cell.set("text", record.as_ref().map_or(Value::Null, |record| Value::String(record.text.clone())));
                if let Some(record) = record {
                    if record.size > 0.0 || record.bold {
                        cell.set("font", Value::object(ObjectKind::Ordered, vec![("size", Value::Double(record.size)), ("bold", Value::Bool(record.bold))]));
                    }
                    if record.tracked {
                        cell.set("tracked", Value::Bool(true));
                    }
                    if !record.deleted.is_empty() {
                        cell.set("deletedText", Value::String(record.deleted.clone()));
                    }
                }
                cell_values.push(Value::Object(cell));
            }
            table_rows.push(Value::object(
                ObjectKind::Ordered,
                vec![("path", Value::String(format!("/body/tbl[{index}]/row[{row}]"))), ("index", Value::Int(row)), ("cells", Value::Array(cell_values))],
            ));
        }
        let mut widths = Vec::new();
        if column_widths_by_columns(&table, column_count, &mut widths).is_err() {
            let _ = column_widths_by_cells(&table, &mut widths);
        }
        let mut entry = dictionary();
        entry.set("path", Value::String(format!("/body/tbl[{index}]")));
        entry.set("index", Value::Int(index));
        entry.set("style", Value::String(canonical_style_name(document, &table_style_name(&table))));
        let alignment = table.member("Rows").and_then(|rows| rows.member("Alignment")).and_then(|alignment| super::int(&alignment)).unwrap_or(0);
        entry.set("alignment", Value::Int(alignment));
        entry.set("columnWidths", Value::Array(widths));
        entry.set("rows", Value::Array(table_rows));
        let start = super::int(&table_range.member("Start")?)?;
        let end = super::int(&table_range.member("End")?)?;
        entry.set("start", Value::Int(start));
        entry.set("end", Value::Int(end));
        entry.set("pageStart", Value::Int(context.page_at(super::int(&table_range.member("Start")?)?)));
        let last = super::int(&table_range.member("Start")?)?.max(super::int(&table_range.member("End")?)? - 1);
        entry.set("pageEnd", Value::Int(context.page_at(last)));
        tables.push(entry);
    }
    Ok((tables, table_count))
}

/// The paragraphs outside tables and the tables, in document order.
fn block_order(paragraphs: &[ParagraphEntry], tables: &[Object]) -> Value {
    #[derive(Clone)]
    struct Block {
        kind: &'static str,
        index: i32,
        path: String,
        start: i32,
    }
    let mut blocks: Vec<Block> = paragraphs
        .iter()
        .filter(|entry| !entry.in_table)
        .map(|entry| Block { kind: "paragraph", index: entry.index, path: entry.path.clone(), start: entry.start })
        .collect();
    for table in tables {
        let number = |key: &str| match table.get(key) {
            Some(Value::Int(number)) => *number,
            _ => 0,
        };
        let path = match table.get("path") {
            Some(Value::String(path)) => path.clone(),
            _ => String::new(),
        };
        blocks.push(Block { kind: "table", index: number("index"), path, start: number("start") });
    }
    let sorted = sort_by_key(&blocks, SortOptions::default(), |block| Value::Int(block.start));
    unroll(
        sorted
            .into_iter()
            .map(|block| {
                Value::object(
                    ObjectKind::Ordered,
                    vec![
                        ("type", string_value(block.kind)),
                        ("index", Value::Int(block.index)),
                        ("path", Value::String(block.path)),
                        ("start", Value::Int(block.start)),
                    ],
                )
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------------------------------------------------
// sections

/// The pages' headers and footers that exist: primary, first and even, header before footer.
fn read_stories(section: &Com, section_index: i32) -> Vec<Value> {
    let mut stories = Vec::new();
    for (name, value) in [("primary", 1), ("first", 2), ("even", 3)] {
        for location in ["header", "footer"] {
            // Read straight off the section: a collection passed through an if-expression unrolls into an array whose
            // Item(n) is 0-based.
            let read = || -> Result<Option<Value>> {
                let collection = section.member(if location == "header" { "Headers" } else { "Footers" })?;
                let story = super::item(&collection, value)?;
                if !truth(&story.member("Exists")?) {
                    return Ok(None);
                }
                let text = super::range_text(&story.member("Range")?)?;
                let link = truth(&story.member("LinkToPrevious")?);
                Ok(Some(Value::object(
                    ObjectKind::Ordered,
                    vec![
                        ("path", Value::String(format!("/section[{section_index}]/{location}[{name}]"))),
                        ("kind", string_value(name)),
                        ("location", string_value(location)),
                        ("text", Value::String(text)),
                        ("linkToPrevious", Value::Bool(link)),
                    ],
                )))
            };
            if let Ok(Some(story)) = read() {
                stories.push(story);
            }
        }
    }
    stories
}

fn read_sections(document: &Obj) -> Result<Vec<Value>> {
    let mut sections = Vec::new();
    let mut section_index = 1;
    while section_index <= super::count(&document.get("Sections")?)? {
        let section = super::item(&document.get("Sections")?, section_index)?;
        let stories = read_stories(&section, section_index);
        // The columns the text flows through, as the portable reader names them. Assigned, not taken through $(): a
        // subexpression unrolls the collection into its columns, and their spacing read back as nothing.
        let text_columns = section.member("PageSetup").and_then(|setup| setup.member("TextColumns")).unwrap_or(Com::Null);
        let column_count = super::count(&text_columns).map_or(1, |count| count.max(1));
        let setup = |name: &str| -> Result<Com> { section.member("PageSetup")?.member(name) };
        let mut entry = dictionary();
        entry.set("path", Value::String(format!("/section[{section_index}]")));
        entry.set("index", Value::Int(section_index));
        entry.set("orientation", Value::Int(super::int(&setup("Orientation")?)?));
        entry.set("topMargin", Value::Double(super::double(&setup("TopMargin")?)?));
        entry.set("bottomMargin", Value::Double(super::double(&setup("BottomMargin")?)?));
        entry.set("leftMargin", Value::Double(super::double(&setup("LeftMargin")?)?));
        entry.set("rightMargin", Value::Double(super::double(&setup("RightMargin")?)?));
        entry.set("columns", Value::Int(column_count));
        if column_count > 1 {
            let spacing = text_columns.member("Spacing").and_then(|spacing| super::double(&spacing)).unwrap_or(36.0);
            entry.set("columnSpacing", Value::Double(spacing));
        }
        entry.set("stories", Value::Array(stories));
        sections.push(Value::Object(entry));
        section_index += 1;
    }
    Ok(sections)
}

// ---------------------------------------------------------------------------------------------------------------------
// images, comments, revisions, notes, content controls

fn read_images(document: &Obj) -> Result<Vec<Value>> {
    let mut images = Vec::new();
    let mut image_index = 1;
    while image_index <= super::count(&document.get("InlineShapes")?)? {
        let image = super::item(&document.get("InlineShapes")?, image_index)?;
        images.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("path", Value::String(format!("/body/image[{image_index}]"))),
                ("index", Value::Int(image_index)),
                ("type", Value::Int(super::int(&image.member("Type")?)?)),
                ("width", Value::Double(super::double(&image.member("Width")?)?)),
                ("height", Value::Double(super::double(&image.member("Height")?)?)),
                ("altText", Value::String(quietly(|| Ok(super::string(&image.member("AlternativeText")?))))),
            ],
        ));
        image_index += 1;
    }
    Ok(images)
}

/// The replies of a comment; what was read before a failure stays.
fn read_replies(comment: &Com, replies: &mut Vec<Value>) -> Result<()> {
    let mut reply_index = 1;
    while reply_index <= super::count(&comment.member("Replies")?)? {
        let reply = super::item(&comment.member("Replies")?, reply_index)?;
        replies.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("index", Value::Int(reply_index)),
                ("author", Value::String(quietly(|| Ok(super::string(&reply.member("Author")?))))),
                ("date", Value::String(quietly(|| date_text(&reply.member("Date")?)))),
                ("text", Value::String(quietly(|| super::range_text(&reply.member("Range")?)))),
            ],
        ));
        reply_index += 1;
    }
    Ok(())
}

fn read_comments(document: &Obj) -> Result<Vec<Value>> {
    let mut comments = Vec::new();
    let mut comment_index = 1;
    while comment_index <= super::count(&document.get("Comments")?)? {
        let comment = super::item(&document.get("Comments")?, comment_index)?;
        comment_index += 1;
        let index = comment_index - 1;
        let is_reply = comment.member("Ancestor").is_ok_and(|ancestor| super::is_object(&ancestor));
        if is_reply {
            continue;
        }
        let mut replies = Vec::new();
        let _ = read_replies(&comment, &mut replies);
        comments.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("path", Value::String(format!("/body/comment[{index}]"))),
                ("index", Value::Int(index)),
                ("author", Value::String(quietly(|| Ok(super::string(&comment.member("Author")?))))),
                ("initials", Value::String(quietly(|| Ok(super::string(&comment.member("Initial")?))))),
                ("date", Value::String(quietly(|| date_text(&comment.member("Date")?)))),
                ("text", Value::String(quietly(|| super::range_text(&comment.member("Range")?)))),
                ("anchoredText", Value::String(quietly(|| super::range_text(&comment.member("Scope")?)))),
                ("resolved", Value::Bool(comment.member("Done").is_ok_and(|done| truth(&done)))),
                ("replies", Value::Array(replies)),
            ],
        ));
    }
    Ok(comments)
}

/// `$revisionTypes`: the name of each type Word reports.
fn revision_type_name(code: i32) -> &'static str {
    match code {
        1 => "insertion",
        2 => "deletion",
        3 => "property",
        4 => "paragraph_number",
        5 => "display_field",
        6 => "reconcile",
        7 => "conflict",
        8 => "style",
        9 => "replacement",
        10 => "paragraph_property",
        11 => "table_property",
        12 => "section_property",
        13 => "style_definition",
        14 => "moved_from",
        15 => "moved_to",
        16 => "cell_insertion",
        17 => "cell_deletion",
        18 => "cell_merge",
        _ => "unknown",
    }
}

/// What the revisions of a document read as.
struct RevisionReading {
    entries: Vec<Value>,
    authors: Vec<Value>,
    property_changes: i32,
    by_paragraph: Vec<(i32, Vec<i32>)>,
}

/// Where a revision starts: the paragraph the range up to and including its first character ends in (a range ending exactly
/// at a paragraph start would not count the paragraph), or the cell of the table it sits in, as the portable reader names it:
/// Word counts a cell's paragraphs among the body's, so /body/p[11] pointed at no paragraph the other backend could address.
/// What was assigned before a failure stays.
fn locate_revision(
    document: &Obj,
    revision: &Com,
    document_end: i32,
    entry: &mut Object,
    by_paragraph: &mut Vec<(i32, Vec<i32>)>,
    revision_index: i32,
) -> Result<()> {
    let head = document_end.min(super::int(&revision.member("Range")?.member("Start")?)?.max(0) + 1);
    let paragraph = super::paragraph_ordinal(document, head)?;
    entry.set("at", Value::String(format!("/body/p[{paragraph}]")));
    if truth(&super::indexed(&revision.member("Range")?, "Information", &[Com::I4(12)])?) {
        let cell = super::item(&revision.member("Range")?.member("Cells")?, 1)?;
        let table = super::count(&super::document_range(document, 0, head)?.member("Tables")?)?;
        let row = super::int(&cell.member("RowIndex")?)?;
        let column = super::int(&cell.member("ColumnIndex")?)?;
        entry.set("at", Value::String(format!("/body/tbl[{table}]/row[{row}]/cell[{column}]")));
    }
    match by_paragraph.iter_mut().find(|(known, _)| *known == paragraph) {
        Some((_, found)) => found.push(revision_index),
        None => by_paragraph.push((paragraph, vec![revision_index])),
    }
    Ok(())
}

/// Word lists formatting revisions among the others; the portable reader counts them apart as propertyChangeCount and tallies
/// each author's insertions and deletions, so the same figures are reported here.
fn read_revisions(document: &Obj) -> Result<RevisionReading> {
    const INSERTIONS: [i32; 3] = [1, 15, 16];
    const DELETIONS: [i32; 3] = [2, 14, 17];
    const PROPERTIES: [i32; 6] = [3, 8, 10, 11, 12, 13];
    let mut reading = RevisionReading { entries: Vec::new(), authors: Vec::new(), property_changes: 0, by_paragraph: Vec::new() };
    let mut authors: Vec<(String, i32, i32)> = Vec::new();
    let document_end = super::int(&document.get("Content")?.member("End")?)?;
    let mut revision_index = 1;
    while revision_index <= super::count(&document.get("Revisions")?)? {
        let revision = super::item(&document.get("Revisions")?, revision_index)?;
        let type_code = super::int(&revision.member("Type")?)?;
        let author = quietly(|| Ok(super::string(&revision.member("Author")?)));
        let mut entry = dictionary();
        entry.set("path", Value::String(format!("/body/revision[{revision_index}]")));
        entry.set("index", Value::Int(revision_index));
        entry.set("type", string_value(revision_type_name(type_code)));
        entry.set("author", Value::String(author.clone()));
        entry.set("date", Value::String(quietly(|| date_text(&revision.member("Date")?))));
        entry.set("text", Value::String(quietly(|| super::range_text(&revision.member("Range")?))));
        let _ = locate_revision(document, &revision, document_end, &mut entry, &mut reading.by_paragraph, revision_index);
        reading.entries.push(Value::Object(entry));
        revision_index += 1;
        if PROPERTIES.contains(&type_code) {
            reading.property_changes += 1;
            continue;
        }
        let at = match authors.iter().position(|(known, _, _)| strings_equal_ignore_case(known, &author)) {
            Some(at) => at,
            None => {
                authors.push((author, 0, 0));
                authors.len() - 1
            }
        };
        if INSERTIONS.contains(&type_code) {
            authors[at].1 += 1;
        } else if DELETIONS.contains(&type_code) {
            authors[at].2 += 1;
        }
    }
    reading.authors = authors
        .into_iter()
        .map(|(author, insertions, deletions)| {
            Value::object(
                ObjectKind::Ordered,
                vec![("author", Value::String(author)), ("insertions", Value::Int(insertions)), ("deletions", Value::Int(deletions))],
            )
        })
        .collect();
    Ok(reading)
}

/// The revisions that start in each paragraph are named beside it, after everything else the paragraph reports.
fn attach_revisions(mut paragraphs: Vec<ParagraphEntry>, by_paragraph: &[(i32, Vec<i32>)]) -> Vec<ParagraphEntry> {
    for entry in &mut paragraphs {
        if let Some((_, found)) = by_paragraph.iter().find(|(known, _)| *known == entry.index) {
            entry.object.set("revisions", Value::Array(found.iter().map(|index| Value::Int(*index)).collect()));
        }
    }
    paragraphs
}

/// The footnotes or endnotes of the document.
fn read_notes(document: &Obj, collection: &str, kind: &str) -> Result<Vec<Value>> {
    let mut notes = Vec::new();
    let mut note_index = 1;
    while note_index <= super::count(&document.get(collection)?)? {
        let note = super::item(&document.get(collection)?, note_index)?;
        notes.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("path", Value::String(format!("/body/{kind}[{note_index}]"))),
                ("index", Value::Int(note_index)),
                ("text", Value::String(super::range_text(&note.member("Range")?)?)),
            ],
        ));
        note_index += 1;
    }
    Ok(notes)
}

fn read_content_controls(document: &Obj) -> Result<Vec<Value>> {
    let mut controls = Vec::new();
    let mut control_index = 1;
    while control_index <= super::count(&document.get("ContentControls")?)? {
        let control = super::item(&document.get("ContentControls")?, control_index)?;
        controls.push(Value::object(
            ObjectKind::Ordered,
            vec![
                ("path", Value::String(format!("/body/content-control[{control_index}]"))),
                ("index", Value::Int(control_index)),
                ("tag", Value::String(super::string(&control.member("Tag")?))),
                ("title", Value::String(super::string(&control.member("Title")?))),
                ("lockContents", Value::Bool(truth(&control.member("LockContents")?))),
                ("lockControl", Value::Bool(truth(&control.member("LockContentControl")?))),
                ("text", Value::String(super::range_text(&control.member("Range")?)?)),
            ],
        ));
        control_index += 1;
    }
    Ok(controls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_are_removed_from_the_text() {
        assert_eq!(without_controls("12%\u{2}.\u{1}\u{5}\u{c}\u{e}x"), "12%.x");
    }

    #[test]
    fn a_revision_type_has_the_name_the_portable_reader_gives_it() {
        assert_eq!(revision_type_name(1), "insertion");
        assert_eq!(revision_type_name(17), "cell_deletion");
        assert_eq!(revision_type_name(99), "unknown");
    }

    #[test]
    fn the_paragraph_target_is_read_in_any_case() {
        let captures = PARAGRAPH_TARGET.captures("/BODY/p[12]/x").expect("a target");
        assert_eq!(&captures[1], "12");
        assert!(PARAGRAPH_TARGET.captures("x/body/p[1]").is_none());
    }
}
