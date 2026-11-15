//! `portable/portable-xlsx-reference-shift.mjs`: rows or columns inserted into or deleted from one worksheet, with
//! everything in the workbook that names them rewritten as Excel rewrites it. Formulas on every sheet, names (the print
//! area among them), conditional formats, validations, chart series, pivot sources, filters, links, merges, tables and
//! drawings follow the cells. As Excel 16 writes them: a range the insert lands inside grows, one that starts at or past
//! it moves; a deleted reference becomes `#REF!` (`Data!#REF!` from another sheet) and a range that loses part of itself
//! closes up; the inserted cells take the formatting of the row above or the column to the left, its height or width
//! included. Whatever this cannot rewrite refuses the edit, listed, before anything is changed.
//!
//! The same module renames and deletes a sheet's references, points a copied sheet at its copy, moves a sorted row's
//! formulas and drops the calculation chain. Offsets are byte offsets into the `&str` searched (Node's are UTF-16
//! units); the text between them is the same.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{Caps, JsRegex, js_to_lowercase, js_trim, js_words, number_to_string, string_to_number};
use mixdog_xlsx_formula::{UnsupportedFormula, formula_references, translate_shared_formula};

use crate::cells::{Sheet, column_label, column_number, iterate_sheet_cells, parse_cell_ref};
use crate::opc::{part_relationship_path, posix, relationship_target, relationship_targets_by_type};
use crate::sheet_xml::{quote_sheet_name, shift_worksheet_columns, shift_worksheet_rows};
use crate::xml::{compiled, set_xml_attribute, tag_pattern, xml_decode, xml_encode};
use crate::zipio::Package;

/// A pattern fixed in the source, compiled on first use.
macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

const LIMIT_ROWS: i64 = 1_048_576;
const LIMIT_COLUMNS: i64 = 16_384;

static REFERENCE_PART: LazyLock<JsRegex> = regex!(r"^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$", "");
static ROW_TAIL: LazyLock<JsRegex> = regex!(r"\d+$", "");
static COLUMN_LETTERS: LazyLock<JsRegex> = regex!(r"[A-Za-z]{1,3}", "");
static QUOTED_PREFIX: LazyLock<JsRegex> = regex!(r"^'(?:[^']|'')+'!", "");
static PLAIN_PREFIX: LazyLock<JsRegex> = regex!(r"^[^!#]+!", "");
static FORMULA_ELEMENT: LazyLock<JsRegex> = regex!(r"<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)", "");
static FORMULA_OPEN: LazyLock<JsRegex> = regex!(r"<f[\s>/]", "");
static PLAIN_FORMULA_ELEMENT: LazyLock<JsRegex> = regex!(r"<f\b([^>]*?)(?<!\/)>([\s\S]*?)<\/f>", "");
static SHARED_TYPE: LazyLock<JsRegex> = regex!(r#"\bt="shared""#, "");
static DATA_TABLE_TYPE: LazyLock<JsRegex> = regex!(r#"\bt="dataTable""#, "");
static ARRAY_TYPE: LazyLock<JsRegex> = regex!(r#"\bt="array""#, "");
static SHARED_ID: LazyLock<JsRegex> = regex!(r#"\bsi="([^"]+)""#, "");
static REF_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bref="([^"]+)""#, "");
static SQREF_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bsqref="([^"]*)""#, "");
/// A cell written `<c .../>` holds no formula, and must not be read as opening the cell after it.
static OPEN_CELL: LazyLock<JsRegex> = regex!(r#"<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?<!\/)>([\s\S]*?)<\/c>"#, "g");
static RULE_FORMULA: LazyLock<JsRegex> = regex!(r"<(formula[12]?|xm:f)>([\s\S]*?)<\/\1>", "g");
static XM_SQREF: LazyLock<JsRegex> = regex!(r"<xm:sqref>([^<]*)<\/xm:sqref>", "g");
static SINGLE_CELL: LazyLock<JsRegex> = regex!(r"^([^:]+):\1$", "");
static MERGE_CELL: LazyLock<JsRegex> = regex!(r"<mergeCell\b([^>]*?)(\/>)", "g");
static HYPERLINK: LazyLock<JsRegex> = regex!(r"<hyperlink\b([^>]*?)(\/>|>[\s\S]*?<\/hyperlink>)", "g");
static EMPTY_HYPERLINKS: LazyLock<JsRegex> = regex!(r"<hyperlinks>\s*<\/hyperlinks>", "");
static SORT_CONDITION: LazyLock<JsRegex> = regex!(r"<sortCondition\b([^>]*?)(\/>)", "g");
static SORT_STATE: LazyLock<JsRegex> = regex!(r"<sortState\b([^>]*?)(\/>|>[\s\S]*?<\/sortState>)", "g");
static AUTO_FILTER: LazyLock<JsRegex> = regex!(r"<autoFilter\b([^>]*?)(\/>|>[\s\S]*?<\/autoFilter>)", "");
static FILTER_COLUMN: LazyLock<JsRegex> = regex!(r"<filterColumn\b", "");
static DIMENSION: LazyLock<JsRegex> = regex!(r"<dimension\b([^>]*?)\/>", "");
static BREAK: LazyLock<JsRegex> = regex!(r"<brk\b([^>]*?)\/>", "g");
static BREAK_OPEN: LazyLock<JsRegex> = regex!(r"<brk\b", "g");
static MANUAL_BREAK: LazyLock<JsRegex> = regex!(r#"<brk\b[^>]*\bman="(?:1|true)""#, "g");
static BREAK_ID: LazyLock<JsRegex> = regex!(r#"\bid="(\d+)""#, "");
static BREAK_COUNT: LazyLock<JsRegex> = regex!(r#"\bcount="\d+""#, "");
static MANUAL_BREAK_COUNT: LazyLock<JsRegex> = regex!(r#"\bmanualBreakCount="\d+""#, "");
static ANCHOR: LazyLock<JsRegex> = regex!(r"<xdr:(oneCellAnchor|twoCellAnchor)\b([^>]*)>([\s\S]*?)<\/xdr:\1>", "g");
static EDIT_AS: LazyLock<JsRegex> = regex!(r#"\beditAs="([^"]+)""#, "");
static ANCHOR_FROM: LazyLock<JsRegex> = regex!(r"<xdr:from>([\s\S]*?)<\/xdr:from>", "");
static ANCHOR_TO: LazyLock<JsRegex> = regex!(r"<xdr:to>([\s\S]*?)<\/xdr:to>", "");
static NOTE_CLIENT_DATA: LazyLock<JsRegex> = regex!(r#"<x:ClientData\b[^>]*\bObjectType="Note""#, "");
static NOTE_ANCHOR: LazyLock<JsRegex> = regex!(r"<x:Anchor>([^<]*)<\/x:Anchor>", "");
static HIDDEN_OR_COLLAPSED: LazyLock<JsRegex> = regex!(r#"\s+(?:hidden|collapsed)="[^"]*""#, "g");
static STYLE_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bs="(\d+)""#, "");
static HEIGHT_OR_STYLE: LazyLock<JsRegex> = regex!(r#"\b(?:ht|s)="#, "");
static COLUMN_WIDTH: LazyLock<JsRegex> = regex!(r"<col\b([^>]*?)\/>", "g");
static COLUMN_MIN: LazyLock<JsRegex> = regex!(r#"\bmin="(\d+)""#, "");
static COLUMN_MAX: LazyLock<JsRegex> = regex!(r#"\bmax="(\d+)""#, "");
static EMPTY_COLS: LazyLock<JsRegex> = regex!(r"<cols>\s*<\/cols>", "");
static DEFINED_NAME: LazyLock<JsRegex> = regex!(r"<definedName\b([^>]*)>([\s\S]*?)<\/definedName>", "g");
static LOCAL_SHEET_ID: LazyLock<JsRegex> = regex!(r#"\blocalSheetId="(\d+)""#, "");
static NAME_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bname="([^"]*)""#, "");
static CHART_PART: LazyLock<JsRegex> = regex!(r"^xl\/charts\/chart\d+\.xml$", "i");
static CHART_SERIES: LazyLock<JsRegex> = regex!(r"<(c|c15):f>([\s\S]*?)<\/\1:f>", "g");
static PIVOT_CACHE_PART: LazyLock<JsRegex> = regex!(r"^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$", "i");
static WORKSHEET_SOURCE: LazyLock<JsRegex> = regex!(r"<worksheetSource\b([^>]*?)\/>", "");
static SHEET_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bsheet="([^"]+)""#, "");
static TABLE_REF: LazyLock<JsRegex> = regex!(r#"<table\b[^>]*?\bref="([^"]+)""#, "");
static TABLE_NAME: LazyLock<JsRegex> = regex!(r#"<table\b[^>]*?\bdisplayName="([^"]+)""#, "");
static TABLE_AREAS: LazyLock<JsRegex> = regex!(r#"(<(?:table|autoFilter)\b[^>]*?\bref=")([^"]+)""#, "g");
static PIVOT_LOCATION: LazyLock<JsRegex> = regex!(r"<location\b([^>]*?)\/>", "");
static COMMENT: LazyLock<JsRegex> = regex!(r#"<comment\b([^>]*?)\bref="([^"]+)"([^>]*)>([\s\S]*?)<\/comment>"#, "g");
static VML_SHAPE: LazyLock<JsRegex> = regex!(r"<v:shape\b[\s\S]*?<\/v:shape>", "g");
static RELATIONSHIP: LazyLock<JsRegex> = regex!(r"<Relationship\b([^>]*?)\/>", "g");
static TYPE_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bType="([^"]+)""#, "");
static TARGET_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bTarget="([^"]+)""#, "");
static EXTERNAL_MODE: LazyLock<JsRegex> = regex!(r#"\bTargetMode="External""#, "");
static OVERRIDE_TARGET: LazyLock<JsRegex> = regex!(r"^(.*?)\d*(\.\w+)$", "");
static CALC_CHAIN_OVERRIDE: LazyLock<JsRegex> = regex!(r#"<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>"#, "");
static CALC_CHAIN_RELATIONSHIP: LazyLock<JsRegex> =
    regex!(r#"<Relationship\b[^>]*\bType="[^"]*\/calcChain"[^>]*\/>"#, "g");
static TABLE_RELATIONSHIP: LazyLock<JsRegex> = regex!(r"\/table$", "");
/// The relationships a sheet owns outright, which a copy needs its own of: two sheets drawing through one drawing part is
/// a package Excel will not open. Pictures, printer settings and pivot caches stay shared.
static OWNED_RELATIONSHIP: LazyLock<JsRegex> =
    regex!(r"\/(?:drawing|chart|chartUserShapes|comments|vmlDrawing|chartStyle|chartColorStyle|pivotTable)$", "");

/// `String.prototype.replace` with a global pattern and a replacer that keeps state.
fn replace_each(pattern: &JsRegex, text: &str, mut with: impl FnMut(&Caps) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in pattern.captures_iter(text) {
        let whole = caps.range();
        out.push_str(&text[last..whole.start]);
        out.push_str(&with(&caps));
        last = whole.end;
    }
    out.push_str(&text[last..]);
    out
}

/// `String.prototype.replace` with a pattern that is not global: the first match only.
fn replace_first(pattern: &JsRegex, text: &str, with: impl FnOnce(&Caps) -> String) -> String {
    match pattern.captures(text) {
        Some(caps) => {
            let whole = caps.range();
            format!("{}{}{}", &text[..whole.start], with(&caps), &text[whole.end..])
        }
        None => text.to_owned(),
    }
}

/// The text of a capture group, empty when the group did not take part.
fn group<'t>(caps: &Caps<'t>, at: usize) -> &'t str {
    caps.get(at).unwrap_or("")
}

/// The first group of a match, as `pattern.exec(text)?.[1]`.
fn first_group(pattern: &JsRegex, text: &str) -> Option<String> {
    pattern.captures(text).and_then(|caps| caps.get(1).map(str::to_owned))
}

/// What one edit does: the rows (columns) of `sheet` from `from` on are moved by `amount`, or `amount` of them taken out.
#[derive(Debug, Clone)]
struct Move {
    sheet: String,
    rows: bool,
    from: i64,
    amount: i64,
    insert: bool,
    limit: i64,
}

/// Excel's rule for one span `[start, end]` of rows (columns): an insert moves every index at or past `from` on by
/// `amount`, so a span that starts there moves whole and one that crosses it grows; a delete takes its indices out and
/// closes the rest up, and a span with nothing left is `None`.
fn moved_span(start: i64, end: i64, mv: &Move) -> Option<(i64, i64)> {
    let (from, amount) = (mv.from, mv.amount);
    if mv.insert {
        let first = if start >= from { start + amount } else { start };
        if first > mv.limit {
            return None;
        }
        return Some((first, (if end >= from { end + amount } else { end }).min(mv.limit)));
    }
    let last = from + amount - 1;
    let closed_up = |index: i64, fallback: i64| if index > last { index - amount } else { fallback };
    let first = if start < from { start } else { closed_up(start, from) };
    let fin = if end < from { end } else { closed_up(end, from - 1) };
    if fin < first { None } else { Some((first, fin)) }
}

/// Where one row (column) lands; a deleted one is `None`.
fn moved_index(index: i64, mv: &Move) -> Option<i64> {
    moved_span(index, index, mv).map(|span| span.0)
}

/// The rows (columns) a reference body spans.
struct Span<'a> {
    parts: Vec<&'a str>,
    indices: Vec<i64>,
    start: i64,
    end: i64,
}

/// The rows (columns) a reference body spans, in the direction the edit moves; `None` for one it cannot reach (a whole
/// column under a row edit) or text that is no reference.
fn reference_span<'a>(body: &'a str, mv: &Move) -> Option<Span<'a>> {
    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() > 2 {
        return None;
    }
    let mut indices = Vec::with_capacity(parts.len());
    for part in &parts {
        let caps = REFERENCE_PART.captures(part)?;
        let (letters, digits) = (caps.get(2), caps.get(4));
        if letters.is_none() && digits.is_none() {
            return None;
        }
        let index = if mv.rows {
            digits.map(string_to_number).filter(|number| !number.is_nan())? as i64
        } else {
            column_number(letters?) as i64
        };
        if index == 0 {
            return None;
        }
        indices.push(index);
    }
    let start = *indices.iter().min()?;
    let end = *indices.iter().max()?;
    Some(Span { parts, indices, start, end })
}

/// One reference body (`A1`, `$A$1:B2`, `3:5`, `C:C`) moved; `None` when its cells are all deleted, the same text when
/// unmoved.
fn moved_reference(body: &str, mv: &Move) -> Option<String> {
    let Some(span) = reference_span(body, mv) else { return Some(body.to_owned()) };
    let moved = moved_span(span.start, span.end, mv)?;
    if moved.0 == span.start && moved.1 == span.end {
        return Some(body.to_owned());
    }
    let reversed = span.indices.len() == 2 && span.indices[0] > span.indices[1];
    let values = if span.parts.len() == 1 {
        vec![moved.0]
    } else if reversed {
        vec![moved.1, moved.0]
    } else {
        vec![moved.0, moved.1]
    };
    let written: Vec<String> = span
        .parts
        .iter()
        .zip(values)
        .map(|(part, value)| {
            if mv.rows {
                match ROW_TAIL.find(part) {
                    Some(range) => format!("{}{value}{}", &part[..range.start], &part[range.end..]),
                    None => (*part).to_owned(),
                }
            } else {
                match COLUMN_LETTERS.find(part) {
                    Some(range) => format!("{}{}{}", &part[..range.start], column_label(value as f64), &part[range.end..]),
                    None => (*part).to_owned(),
                }
            }
        })
        .collect();
    Some(written.join(":"))
}

/// Whether the edit cuts through a block (an array formula, a table's columns) rather than moving or removing it whole.
fn cuts_through(body: &str, mv: &Move) -> bool {
    let Some(span) = reference_span(body, mv) else { return false };
    if mv.insert {
        return span.start < mv.from && mv.from <= span.end;
    }
    let last = mv.from + mv.amount - 1;
    span.start.max(mv.from) <= span.end.min(last) && !(mv.from <= span.start && span.end <= last)
}

fn moved_area_list(list: &str, mv: &Move) -> String {
    js_words(list).filter_map(|area| moved_reference(area, mv)).filter(|area| !area.is_empty()).collect::<Vec<_>>().join(" ")
}

fn unquoted(name: &str) -> String {
    if name.starts_with('\'') {
        let mut chars = name.chars();
        chars.next();
        chars.next_back();
        chars.as_str().replace("''", "'")
    } else {
        name.to_owned()
    }
}

fn same_sheet(name: Option<&str>, sheet: &str) -> bool {
    name.is_some_and(|name| js_to_lowercase(name) == js_to_lowercase(sheet))
}

/// A reference token split into the sheet it names (`'My Data'!`, `Data!`, or none) and the cells after it.
struct ReferenceParts<'a> {
    sheet: Option<String>,
    prefix: &'a str,
    body: &'a str,
}

fn reference_parts(text: &str) -> ReferenceParts<'_> {
    let found = if text.starts_with('\'') { QUOTED_PREFIX.find(text) } else { PLAIN_PREFIX.find(text) };
    match found {
        Some(range) => {
            let prefix = &text[range.clone()];
            ReferenceParts { sheet: Some(unquoted(&prefix[..prefix.len() - 1])), prefix, body: &text[range.end..] }
        }
        None => ReferenceParts { sheet: None, prefix: "", body: text },
    }
}

fn mentions_sheet(text: &str, sheet: &str) -> bool {
    let lower = js_to_lowercase(text);
    let name = js_to_lowercase(sheet);
    lower.contains(&name) || lower.contains(&name.replace('\'', "''"))
}

/// A formula with its references to the moved sheet moved. `home` is the sheet an unqualified reference names: the sheet a
/// cell or rule sits on; none for a workbook name or a chart series.
fn moved_formula(formula: &str, home: Option<&str>, mv: &Move) -> Result<String, UnsupportedFormula> {
    if !same_sheet(home, &mv.sheet) && !mentions_sheet(formula, &mv.sheet) {
        return Ok(formula.to_owned());
    }
    let mut moved = String::new();
    let mut at = 0;
    let mut changed = false;
    for token in formula_references(formula)? {
        let parts = reference_parts(&token.text);
        let names = if parts.prefix.is_empty() { home } else { parts.sheet.as_deref() };
        if !same_sheet(names, &mv.sheet) {
            continue;
        }
        let next = moved_reference(parts.body, mv);
        if next.as_deref() == Some(parts.body) {
            continue;
        }
        moved.push_str(&formula[at..token.start]);
        moved.push_str(parts.prefix);
        moved.push_str(next.as_deref().unwrap_or("#REF!"));
        at = token.start + token.text.len();
        changed = true;
    }
    if changed {
        moved.push_str(&formula[at..]);
        Ok(moved)
    } else {
        Ok(formula.to_owned())
    }
}

/// A formula a sort moved `row_delta` rows, as Excel 16 moves it: a reference on the formula's own sheet follows the row
/// where it is relative (`=C6/B6-1` moved to row 2 reads `=C2/B2-1`, `$B6` reads `$B2`) and stays where it is pinned
/// (`B$2`, `$C$2:$C$6`); a reference that names a sheet, its own included (`Report!C6`, `Data!C6`), keeps naming the same
/// cell. Fails when the formula cannot be read or a reference would move off the sheet.
pub fn sorted_formula(formula: &str, row_delta: i64) -> Result<String, UnsupportedFormula> {
    if row_delta == 0 {
        return Ok(formula.to_owned());
    }
    let mut moved = String::new();
    let mut at = 0;
    let mut changed = false;
    for token in formula_references(formula)? {
        if !reference_parts(&token.text).prefix.is_empty() {
            continue;
        }
        moved.push_str(&formula[at..token.start]);
        moved.push_str(&translate_shared_formula(&token.text, row_delta, 0)?);
        at = token.start + token.text.len();
        changed = true;
    }
    if changed {
        moved.push_str(&formula[at..]);
        Ok(moved)
    } else {
        Ok(formula.to_owned())
    }
}

/// A formula with the sheet its references name replaced: by the sheet's new name (`replacement` is the name with its
/// quotes and `!`), or, where the sheet was deleted (`None`), the whole reference by `#REF!`. Excel shows
/// `SUM(#REF!B2:B4)` while the workbook is open but saves `SUM(#REF!)`, and a file holding `#REF!B2:B4` is one Excel will
/// not open.
fn renamed_formula(formula: &str, name: &str, replacement: Option<&str>) -> Result<String, UnsupportedFormula> {
    if !mentions_sheet(formula, name) {
        return Ok(formula.to_owned());
    }
    let mut renamed = String::new();
    let mut at = 0;
    let mut changed = false;
    for token in formula_references(formula)? {
        let parts = reference_parts(&token.text);
        if parts.prefix.is_empty() || !same_sheet(parts.sheet.as_deref(), name) {
            continue;
        }
        renamed.push_str(&formula[at..token.start]);
        match replacement {
            None => renamed.push_str("#REF!"),
            Some(prefix) => {
                renamed.push_str(prefix);
                renamed.push_str(parts.body);
            }
        }
        at = token.start + token.text.len();
        changed = true;
    }
    if changed {
        renamed.push_str(&formula[at..]);
        Ok(renamed)
    } else {
        Ok(formula.to_owned())
    }
}

/// How one formula text is rewritten: the formula, and the sheet an unqualified reference in it names.
type Transform<'a> = &'a dyn Fn(&str, Option<&str>) -> Result<String, UnsupportedFormula>;

/// A formula rewriter that counts what it changed and lists what it could not read.
struct Rewriter<'a> {
    transform: Transform<'a>,
    rewritten: usize,
    refused: Vec<String>,
}

impl<'a> Rewriter<'a> {
    fn new(transform: Transform<'a>) -> Self {
        Self { transform, rewritten: 0, refused: Vec::new() }
    }

    /// `rewrite(where, text, home)`: the text rewritten, or as it was with the reason it could not be read noted.
    fn rewrite(&mut self, place: &str, text: &str, home: Option<&str>) -> String {
        match (self.transform)(text, home) {
            Ok(next) => {
                if next != text {
                    self.rewritten += 1;
                }
                next
            }
            Err(error) => {
                self.refused.push(format!("{place} ={text} ({})", error.reason));
                text.to_owned()
            }
        }
    }
}

/// One group of cells sharing a formula.
struct SharedGroup {
    cells: Vec<String>,
    master: Option<String>,
    text: String,
    block: Option<String>,
}

/// Every cell formula of one sheet moved. A shared formula is stored once, in its first cell, with the others holding its
/// id; a group any of whose cells would change is written out cell by cell, as the plain formulas Excel shows.
fn moved_cell_formulas(xml: &str, home: &str, own: bool, mv: &Move, rw: &mut Rewriter<'_>) -> Result<String, String> {
    if !FORMULA_OPEN.is_match(xml) {
        return Ok(xml.to_owned());
    }
    let mut ids: Vec<String> = Vec::new();
    let mut groups: Vec<SharedGroup> = Vec::new();
    for cell in iterate_sheet_cells(xml) {
        let Some(element) = FORMULA_ELEMENT.captures(cell.body) else { continue };
        let attributes = group(&element, 1);
        if !SHARED_TYPE.is_match(attributes) {
            continue;
        }
        let Some(id) = first_group(&SHARED_ID, attributes) else { continue };
        let at = match ids.iter().position(|known| *known == id) {
            Some(at) => at,
            None => {
                ids.push(id);
                groups.push(SharedGroup { cells: Vec::new(), master: None, text: String::new(), block: None });
                groups.len() - 1
            }
        };
        let entry = &mut groups[at];
        entry.cells.push(cell.reference.to_owned());
        let stored = group(&element, 2);
        if !stored.is_empty() {
            entry.master = Some(cell.reference.to_owned());
            entry.text = xml_decode(stored);
            entry.block = first_group(&REF_ATTRIBUTE, attributes);
        }
    }
    let mut unshared: HashMap<String, String> = HashMap::new();
    for shared in &groups {
        let Some(master) = &shared.master else { continue };
        if !own && !mentions_sheet(&shared.text, &mv.sheet) {
            continue;
        }
        let origin = parse_cell_ref(master)?;
        let mut texts: Vec<(String, String)> = Vec::new();
        let mut changed = own
            && shared.block.as_deref().is_some_and(|block| !block.is_empty() && moved_reference(block, mv).as_deref() != Some(block));
        for reference in &shared.cells {
            let at = parse_cell_ref(reference)?;
            let row_delta = at.row as i64 - origin.row as i64;
            let column_delta = column_number(&at.col) as i64 - column_number(&origin.col) as i64;
            let text = match translate_shared_formula(&shared.text, row_delta, column_delta) {
                Ok(text) => text,
                Err(error) => {
                    rw.refused.push(format!("{home}!{reference} (a shared formula: {})", error.reason));
                    continue;
                }
            };
            let next = rw.rewrite(&format!("{home}!{reference}"), &text, Some(home));
            changed = changed || next != text;
            match texts.iter_mut().find(|(known, _)| known == reference) {
                Some(entry) => entry.1 = next,
                None => texts.push((reference.clone(), next)),
            }
        }
        if changed {
            unshared.extend(texts);
        }
    }
    Ok(replace_each(&OPEN_CELL, xml, |caps| {
        let (attributes, reference, body) = (group(caps, 1), group(caps, 2), group(caps, 3));
        let whole_text = &xml[caps.range()];
        let Some(element) = FORMULA_ELEMENT.captures(body) else { return whole_text.to_owned() };
        let element_attributes = group(&element, 1);
        let replacement;
        if let Some(text) = unshared.get(reference) {
            replacement = format!("<f>{}</f>", xml_encode(text));
        } else if SHARED_TYPE.is_match(element_attributes) {
            return whole_text.to_owned();
        } else if DATA_TABLE_TYPE.is_match(element_attributes) {
            if own {
                rw.refused.push(format!("{home}!{reference} (a what-if data table)"));
            }
            return whole_text.to_owned();
        } else {
            let mut written = element_attributes.to_owned();
            if own && ARRAY_TYPE.is_match(&written) {
                let block = first_group(&REF_ATTRIBUTE, &written).unwrap_or_else(|| reference.to_owned());
                if cuts_through(&block, mv) {
                    rw.refused.push(format!("{home}!{block} (an array formula the edit would split)"));
                    return whole_text.to_owned();
                }
                if let Some(moved) = moved_reference(&block, mv) {
                    if !moved.is_empty() {
                        written = set_xml_attribute(&written, "ref", &moved);
                    }
                }
            }
            let stored = element.get(2);
            let text = xml_decode(stored.unwrap_or(""));
            let next = match stored {
                None => text.clone(),
                Some(_) => rw.rewrite(&format!("{home}!{reference}"), &text, Some(home)),
            };
            if next == text && written == element_attributes {
                return whole_text.to_owned();
            }
            replacement = match stored {
                None => format!("<f{written}/>"),
                Some(_) => format!("<f{written}>{}</f>", xml_encode(&next)),
            };
        }
        let element_text = &body[element.range()];
        format!("<c{attributes}>{}</c>", body.replacen(element_text, &replacement, 1))
    }))
}

/// The formulas of a sheet's conditional formats and validations, and of its Excel 2010 extensions (a validation list on
/// another sheet, a sparkline's data), which read unqualified references on that sheet.
fn moved_rule_formulas(xml: &str, home: &str, rw: &mut Rewriter<'_>) -> String {
    replace_each(&RULE_FORMULA, xml, |caps| {
        let (tag, text) = (group(caps, 1), group(caps, 2));
        let decoded = xml_decode(text);
        let kind = match tag {
            "formula" => "conditional format",
            "xm:f" => "rule",
            _ => "validation",
        };
        let next = rw.rewrite(&format!("{home} {kind}"), &decoded, Some(home));
        if next == decoded { xml[caps.range()].to_owned() } else { format!("<{tag}>{}</{tag}>", xml_encode(&next)) }
    })
}

/// A container's count attribute written again from the children it holds; the container goes when it holds none.
fn recounted(xml: &str, container: &str, child: &str) -> String {
    let pattern = compiled(&format!(r"<{container}\b([^>]*)>([\s\S]*?)<\/{container}>"), "");
    let children = compiled(&format!(r"<{child}\b(?![\w:])"), "g");
    replace_first(&pattern, xml, |caps| {
        let (attributes, body) = (group(caps, 1), group(caps, 2));
        let count = children.find_iter(body).count();
        if count == 0 {
            return String::new();
        }
        let attributes = if has_count_attribute(attributes) {
            set_xml_attribute(attributes, "count", &count.to_string())
        } else {
            attributes.to_owned()
        };
        format!("<{container}{attributes}>{body}</{container}>")
    })
}

/// `/\bcount="/.test(attributes)`.
fn has_count_attribute(attributes: &str) -> bool {
    static COUNT: LazyLock<JsRegex> = regex!(r#"\bcount=""#, "");
    COUNT.is_match(attributes)
}

/// A list-of-areas element (`sqref`) or a single-area element (`ref`) moved with `moved`.
fn referenced(tag: &str, drop_single_cell: bool, mv: &Move, attributes: &str, rest: &str, whole: &str) -> String {
    let Some(reference) = first_group(&REF_ATTRIBUTE, attributes) else { return whole.to_owned() };
    let moved = moved_reference(&reference, mv);
    if moved.as_deref() == Some(reference.as_str()) {
        return whole.to_owned();
    }
    let Some(moved) = moved else { return String::new() };
    if moved.is_empty() || (drop_single_cell && SINGLE_CELL.is_match(&moved.replace('$', ""))) {
        return String::new();
    }
    format!("<{tag}{}{rest}", set_xml_attribute(attributes, "ref", &moved))
}

/// The moved sheet's own lists of areas: each area moves, one whose cells are all deleted drops out, and an element left
/// with none goes, as Excel drops a rule, validation, merge or link whose cells it deleted.
fn moved_sheet_ranges(xml: &str, mv: &Move, refused: &mut Vec<String>) -> String {
    let mut next = xml.to_owned();
    for tag in ["conditionalFormatting", "dataValidation", "ignoredError", "protectedRange"] {
        let pattern = compiled(&format!(r"<{tag}\b([^>]*?)(\/>|>[\s\S]*?<\/{tag}>)"), "g");
        next = pattern.replace_all_with(&next, |caps| {
            let (attributes, rest) = (group(caps, 1), group(caps, 2));
            let whole = caps.get(0).unwrap_or("");
            let Some(list) = first_group(&SQREF_ATTRIBUTE, attributes) else { return whole.to_owned() };
            let moved = moved_area_list(&list, mv);
            if moved == list {
                return whole.to_owned();
            }
            if moved.is_empty() { String::new() } else { format!("<{tag}{}{rest}", set_xml_attribute(attributes, "sqref", &moved)) }
        });
    }
    next = recounted(&next, "dataValidations", "dataValidation");
    next = recounted(&next, "ignoredErrors", "ignoredError");
    next = recounted(&next, "protectedRanges", "protectedRange");
    next = replace_each(&XM_SQREF, &next, |caps| {
        let list = group(caps, 1);
        let whole = caps.get(0).unwrap_or("");
        let moved = moved_area_list(list, mv);
        if moved == list {
            return whole.to_owned();
        }
        if moved.is_empty() {
            refused.push(format!("{} extension rule on {list} (its cells are all deleted)", mv.sheet));
            return whole.to_owned();
        }
        format!("<xm:sqref>{moved}</xm:sqref>")
    });
    // A merge left over one cell is no merge, and Excel drops it.
    next = MERGE_CELL.replace_all_with(&next, |caps| {
        referenced("mergeCell", true, mv, group(caps, 1), group(caps, 2), caps.get(0).unwrap_or(""))
    });
    next = recounted(&next, "mergeCells", "mergeCell");
    next = HYPERLINK.replace_all_with(&next, |caps| {
        referenced("hyperlink", false, mv, group(caps, 1), group(caps, 2), caps.get(0).unwrap_or(""))
    });
    next = replace_first(&EMPTY_HYPERLINKS, &next, |_| String::new());
    next = SORT_CONDITION.replace_all_with(&next, |caps| {
        referenced("sortCondition", false, mv, group(caps, 1), group(caps, 2), caps.get(0).unwrap_or(""))
    });
    next = SORT_STATE.replace_all_with(&next, |caps| {
        referenced("sortState", false, mv, group(caps, 1), group(caps, 2), caps.get(0).unwrap_or(""))
    });
    next = replace_first(&AUTO_FILTER, &next, |caps| {
        let (attributes, rest) = (group(caps, 1), group(caps, 2));
        let whole = caps.get(0).unwrap_or("");
        if let Some(reference) = first_group(&REF_ATTRIBUTE, attributes) {
            if !mv.rows && FILTER_COLUMN.is_match(rest) && cuts_through(&reference, mv) {
                refused.push(format!("{} filter criteria on {reference} (their column numbers would change)", mv.sheet));
                return whole.to_owned();
            }
        }
        referenced("autoFilter", false, mv, attributes, rest, whole)
    });
    next = replace_first(&DIMENSION, &next, |caps| {
        let attributes = group(caps, 1);
        let whole = caps.get(0).unwrap_or("");
        let Some(reference) = first_group(&REF_ATTRIBUTE, attributes) else { return whole.to_owned() };
        let moved = moved_reference(&reference, mv);
        if moved.as_deref() == Some(reference.as_str()) {
            return whole.to_owned();
        }
        let moved = moved.filter(|moved| !moved.is_empty()).unwrap_or_else(|| "A1".to_owned());
        format!("<dimension{}/>", set_xml_attribute(attributes, "ref", &moved))
    });
    // A page break sits above the row (left of the column) its zero-based id names, and moves with it.
    let breaks = if mv.rows { "rowBreaks" } else { "colBreaks" };
    let pattern = compiled(&format!(r"<{breaks}\b([^>]*)>([\s\S]*?)<\/{breaks}>"), "");
    replace_first(&pattern, &next, |caps| {
        let (attributes, body) = (group(caps, 1), group(caps, 2));
        let kept = BREAK.replace_all_with(body, |brk| {
            let whole = brk.get(0).unwrap_or("");
            let brk_attributes = group(brk, 1);
            let Some(id) = first_group(&BREAK_ID, brk_attributes).and_then(|id| id.parse::<i64>().ok()) else {
                return String::new();
            };
            match moved_index(id + 1, mv) {
                Some(moved) if moved == id + 1 => whole.to_owned(),
                Some(moved) => format!("<brk{}/>", set_xml_attribute(brk_attributes, "id", &(moved - 1).to_string())),
                None => String::new(),
            }
        });
        let count = BREAK_OPEN.find_iter(&kept).count();
        if count == 0 {
            return String::new();
        }
        let manual = MANUAL_BREAK.find_iter(&kept).count();
        let attributes = replace_first(&BREAK_COUNT, attributes, |_| format!("count=\"{count}\""));
        let attributes = replace_first(&MANUAL_BREAK_COUNT, &attributes, |_| format!("manualBreakCount=\"{manual}\""));
        format!("<{breaks}{attributes}>{kept}</{breaks}>")
    })
}

/// Where one corner of a drawing anchor lands.
struct Corner {
    index: Option<i64>,
    next: i64,
    reset: bool,
}

/// A drawing's corners, zero-based in the file: a frame that moves and sizes with its cells (a two-cell anchor, Excel's
/// default) has each corner follow its own row, so an insert inside it makes it taller; one that only moves keeps its
/// size; an absolute one stays. A corner on a deleted row lands at the top of the row after the deletion.
fn moved_anchors(drawing: &str, mv: &Move) -> String {
    let tag = if mv.rows { "row" } else { "col" };
    let index_pattern = compiled(&format!(r"<xdr:{tag}>(\d+)<\/xdr:{tag}>"), "");
    let offset_pattern = compiled(&format!(r"<xdr:{tag}Off>-?\d+<\/xdr:{tag}Off>"), "");
    let place = |block: &str| -> Corner {
        let index = first_group(&index_pattern, block).and_then(|digits| digits.parse::<i64>().ok());
        let moved = index.and_then(|index| moved_index(index + 1, mv));
        Corner { index, next: moved.map_or(mv.from - 1, |moved| moved - 1), reset: moved.is_none() }
    };
    let written = |block: &str, index: &str, reset: bool| -> String {
        let moved = replace_first(&index_pattern, block, |_| format!("<xdr:{tag}>{index}</xdr:{tag}>"));
        if reset { replace_first(&offset_pattern, &moved, |_| format!("<xdr:{tag}Off>0</xdr:{tag}Off>")) } else { moved }
    };
    ANCHOR.replace_all_with(drawing, |caps| {
        let (kind, attributes, body) = (group(caps, 1), group(caps, 2), group(caps, 3));
        let whole = caps.get(0).unwrap_or("");
        let edit_as = if kind == "oneCellAnchor" {
            "oneCell".to_owned()
        } else {
            first_group(&EDIT_AS, attributes).unwrap_or_else(|| "twoCell".to_owned())
        };
        let Some(from) = ANCHOR_FROM.captures(body) else { return whole.to_owned() };
        if edit_as == "absolute" {
            return whole.to_owned();
        }
        let from_block = group(&from, 1);
        let start = place(from_block);
        let mut next = body.replacen(
            &body[from.range()],
            &format!("<xdr:from>{}</xdr:from>", written(from_block, &start.next.to_string(), start.reset)),
            1,
        );
        let to = if kind == "twoCellAnchor" { ANCHOR_TO.captures(body) } else { None };
        if let Some(to) = to {
            let to_block = group(&to, 1);
            let end = place(to_block);
            let index = if edit_as == "oneCell" {
                match (end.index, start.index) {
                    (Some(end_index), Some(start_index)) => (end_index + start.next - start_index).to_string(),
                    _ => "NaN".to_owned(),
                }
            } else {
                end.next.to_string()
            };
            next = next.replacen(
                &body[to.range()],
                &format!("<xdr:to>{}</xdr:to>", written(to_block, &index, edit_as != "oneCell" && end.reset)),
                1,
            );
        }
        if next == body { whole.to_owned() } else { format!("<xdr:{kind}{attributes}>{next}</xdr:{kind}>") }
    })
}

/// A note's box in the sheet's legacy drawing: its cell (zero-based `x:Row` and `x:Column`) and the box's corners
/// (`x:Anchor`: left column, offset, top row, offset, right column, offset, bottom row, offset) move by as much as the
/// cell moved; a note whose cell is deleted goes.
fn moved_note_shape(shape: &str, mv: &Move) -> String {
    if !NOTE_CLIENT_DATA.is_match(shape) {
        return shape.to_owned();
    }
    let tag = if mv.rows { "Row" } else { "Column" };
    let pattern = compiled(&format!(r"<x:{tag}>(\d+)<\/x:{tag}>"), "");
    let Some(index) = first_group(&pattern, shape).and_then(|digits| digits.parse::<i64>().ok()) else {
        return shape.to_owned();
    };
    let Some(moved) = moved_index(index + 1, mv) else { return String::new() };
    if moved == index + 1 {
        return shape.to_owned();
    }
    let delta = moved - 1 - index;
    let shape = replace_first(&pattern, shape, |_| format!("<x:{tag}>{}</x:{tag}>", moved - 1));
    replace_first(&NOTE_ANCHOR, &shape, |caps| {
        let mut corners: Vec<String> = group(caps, 1).split(',').map(|value| js_trim(value).to_owned()).collect();
        for position in if mv.rows { [2, 6] } else { [0, 4] } {
            // A corner past the end is `undefined` in Node: it reads as NaN, and the places before it join as empty.
            let value = corners.get(position).map_or(f64::NAN, |corner| string_to_number(corner));
            while corners.len() <= position {
                corners.push(String::new());
            }
            corners[position] = number_to_string(value + delta as f64);
        }
        format!("<x:Anchor>{}</x:Anchor>", corners.join(", "))
    })
}

/// An inserted row takes the row above's formatting (each cell's style, the row's own style and height) and an inserted
/// column the column on its left's, as Excel's default insert does; the first row or column takes none.
pub fn inherited_rows(xml: &str, from: i64, amount: i64) -> Result<String, String> {
    if from <= 1 {
        return Ok(xml.to_owned());
    }
    let above = compiled(&format!(r#"<row\b([^>]*?\br="{}"[^>]*?)(?:\/>|>([\s\S]*?)<\/row>)"#, from - 1), "");
    let Some(found) = above.captures(xml) else { return Ok(xml.to_owned()) };
    let attributes = HIDDEN_OR_COLLAPSED.replace_all_with(group(&found, 1), |_| String::new());
    let mut styled: Vec<(String, String)> = Vec::new();
    for cell in iterate_sheet_cells(group(&found, 2)) {
        let column = parse_cell_ref(cell.reference)?.col;
        if let Some(style) = first_group(&STYLE_ATTRIBUTE, cell.attributes) {
            if style != "0" {
                styled.push((column, style));
            }
        }
    }
    if styled.is_empty() && !HEIGHT_OR_STYLE.is_match(&attributes) {
        return Ok(xml.to_owned());
    }
    let rows: String = (0..amount)
        .map(|offset| {
            let index = from + offset;
            let cells: String =
                styled.iter().map(|(column, style)| format!("<c r=\"{column}{index}\" s=\"{style}\"/>")).collect();
            let attributes = set_xml_attribute(&attributes, "r", &index.to_string());
            if cells.is_empty() { format!("<row{attributes}/>") } else { format!("<row{attributes}>{cells}</row>") }
        })
        .collect();
    let end = found.range().end;
    Ok(format!("{}{rows}{}", &xml[..end], &xml[end..]))
}

fn inherited_columns(xml: &str, from: i64, amount: i64) -> String {
    if from <= 1 {
        return xml.to_owned();
    }
    let left = column_label((from - 1) as f64);
    let pattern = compiled(&format!(r#"<c\b([^>]*?\br="{left}(\d+)"[^>]*?)(\/>|>[\s\S]*?<\/c>)"#), "g");
    pattern.replace_all_with(xml, |caps| {
        let whole = caps.get(0).unwrap_or("");
        let row = group(caps, 2);
        match first_group(&STYLE_ATTRIBUTE, group(caps, 1)) {
            Some(style) if style != "0" => {
                let added: String = (0..amount)
                    .map(|offset| format!("<c r=\"{}{row}\" s=\"{style}\"/>", column_label((from + offset) as f64)))
                    .collect();
                format!("{whole}{added}")
            }
            _ => whole.to_owned(),
        }
    })
}

/// Column widths follow their columns; the columns an insert adds join the span of the column on their left.
fn moved_column_widths(xml: &str, mv: &Move) -> String {
    let moved = COLUMN_WIDTH.replace_all_with(xml, |caps| {
        let (whole, attributes) = (caps.get(0).unwrap_or(""), group(caps, 1));
        let number = |pattern: &JsRegex| first_group(pattern, attributes).and_then(|digits| digits.parse::<i64>().ok());
        let (Some(min), Some(max)) = (number(&COLUMN_MIN), number(&COLUMN_MAX)) else { return whole.to_owned() };
        if min == 0 || max == 0 {
            return whole.to_owned();
        }
        let span = if !mv.insert {
            moved_span(min, max, mv)
        } else if min >= mv.from {
            if min + mv.amount > mv.limit { None } else { Some((min + mv.amount, (max + mv.amount).min(mv.limit))) }
        } else {
            Some((min, if max >= mv.from - 1 { (max + mv.amount).min(mv.limit) } else { max }))
        };
        let Some(span) = span else { return String::new() };
        if span == (min, max) {
            return whole.to_owned();
        }
        let widened = set_xml_attribute(attributes, "min", &span.0.to_string());
        format!("<col{}/>", set_xml_attribute(&widened, "max", &span.1.to_string()))
    });
    replace_first(&EMPTY_COLS, &moved, |_| String::new())
}

/// The parts of a package a rewrite will write, in the order they were first set (a `Map`).
#[derive(Default)]
struct Writes(Vec<(String, String)>);

impl Writes {
    fn get(&self, part: &str) -> Option<&str> {
        self.0.iter().find(|(known, _)| known == part).map(|(_, text)| text.as_str())
    }

    fn set(&mut self, part: &str, text: String) {
        match self.0.iter_mut().find(|(known, _)| known == part) {
            Some(entry) => entry.1 = text,
            None => self.0.push((part.to_owned(), text)),
        }
    }
}

/// The workbook's names (the print area and titles among them) and every chart series, each rewritten by `rw` (a local
/// name reads unqualified references on its own sheet) into `writes`.
fn rewrite_names_and_charts(zip: &Package, sheets: &[Sheet], rw: &mut Rewriter<'_>, writes: &mut Writes) {
    let workbook_path = "xl/workbook.xml";
    let workbook = writes.get(workbook_path).map_or_else(|| zip.text(workbook_path), str::to_owned);
    let names = replace_each(&DEFINED_NAME, &workbook, |caps| {
        let (attributes, body) = (group(caps, 1), group(caps, 2));
        let local = first_group(&LOCAL_SHEET_ID, attributes);
        let text = xml_decode(body);
        let name = xml_decode(&first_group(&NAME_ATTRIBUTE, attributes).unwrap_or_default());
        let home = local.and_then(|local| local.parse::<usize>().ok()).and_then(|at| sheets.get(at)).map(|sheet| sheet.name.as_str());
        let next = rw.rewrite(&format!("name {name}"), &text, home);
        if next == text { caps.get(0).unwrap_or("").to_owned() } else { format!("<definedName{attributes}>{}</definedName>", xml_encode(&next)) }
    });
    if names != workbook {
        writes.set(workbook_path, names);
    }
    for part in zip.names().into_iter().filter(|entry| CHART_PART.is_match(entry)) {
        let chart = zip.text(&part);
        let next = replace_each(&CHART_SERIES, &chart, |caps| {
            let (tag, text) = (group(caps, 1), group(caps, 2));
            let decoded = xml_decode(text);
            let rewritten = rw.rewrite("chart series", &decoded, None);
            if rewritten == decoded { caps.get(0).unwrap_or("").to_owned() } else { format!("<{tag}:f>{}</{tag}:f>", xml_encode(&rewritten)) }
        });
        if next != chart {
            writes.set(&part, next);
        }
    }
}

/// A pivot cache that reads one sheet.
struct PivotSource {
    part: String,
    cache: String,
    /// The `worksheetSource` element.
    whole: String,
    attributes: String,
}

/// The pivot caches that read one sheet.
fn pivot_sources(zip: &Package, sheet_name: &str) -> Vec<PivotSource> {
    let mut found = Vec::new();
    for part in zip.names().into_iter().filter(|entry| PIVOT_CACHE_PART.is_match(entry)) {
        let cache = zip.text(&part);
        let Some(source) = WORKSHEET_SOURCE.captures(&cache) else { continue };
        let named = xml_decode(&first_group(&SHEET_ATTRIBUTE, group(&source, 1)).unwrap_or_default());
        if same_sheet(Some(&named), sheet_name) {
            let (whole, attributes) = (source.get(0).unwrap_or("").to_owned(), group(&source, 1).to_owned());
            found.push(PivotSource { part, cache: cache.clone(), whole, attributes });
        }
    }
    found
}

/// Every formula of a sheet rewritten where it stands. A rename reads the same from every cell a shared formula reaches,
/// so the group keeps its one stored formula.
fn renamed_cell_formulas(xml: &str, home: &str, rw: &mut Rewriter<'_>) -> String {
    if !FORMULA_OPEN.is_match(xml) {
        return xml.to_owned();
    }
    replace_each(&OPEN_CELL, xml, |caps| {
        let (attributes, reference, body) = (group(caps, 1), group(caps, 2), group(caps, 3));
        let whole = &xml[caps.range()];
        let Some(element) = PLAIN_FORMULA_ELEMENT.captures(body) else { return whole.to_owned() };
        let text = xml_decode(group(&element, 2));
        let next = rw.rewrite(&format!("{home}!{reference}"), &text, Some(home));
        if next == text {
            return whole.to_owned();
        }
        let replacement = format!("<f{}>{}</f>", group(&element, 1), xml_encode(&next));
        format!("<c{attributes}>{}</c>", body.replacen(&body[element.range()], &replacement, 1))
    })
}

/// The message of an edit refused for what it cannot rewrite: what, how many, the first four, and where to go instead.
fn refusal(head: &str, refused: &[String], tail: &str) -> String {
    let listed = refused.iter().take(4).cloned().collect::<Vec<_>>().join("; ");
    let more = if refused.len() > 4 { "; …" } else { "" };
    format!("{head}{listed}{more}. {tail}")
}

/// Every reference to one worksheet rewritten for its new name, or for its deletion (`to` is `None`), as Excel saves
/// them: `SUM(Data!B2:B4)` becomes `SUM('자료 2026'!B2:B4)`, or `SUM(#REF!)` once Data is gone. Formulas on every sheet,
/// rules, validations, names, chart series and (on a rename) pivot sources follow. Returns how many formulas, names and
/// chart series were rewritten; fails, with nothing changed, when a formula naming the sheet cannot be read.
pub fn rename_sheet_references(
    zip: &mut Package,
    sheets: &[Sheet],
    sheet: &Sheet,
    to: Option<&str>,
    op: &str,
) -> Result<usize, String> {
    let replacement = to.map(|name| format!("{}!", quote_sheet_name(name)));
    let transform = |text: &str, _home: Option<&str>| renamed_formula(text, &sheet.name, replacement.as_deref());
    let mut rw = Rewriter::new(&transform);
    let mut writes = Writes::default();
    for other in sheets {
        if to.is_none() && other.path == sheet.path {
            continue;
        }
        let source = zip.text(&other.path);
        if source.is_empty() {
            continue;
        }
        let cells = renamed_cell_formulas(&source, &other.name, &mut rw);
        let next = moved_rule_formulas(&cells, &other.name, &mut rw);
        if next != source {
            writes.set(&other.path, next);
        }
    }
    rewrite_names_and_charts(zip, sheets, &mut rw, &mut writes);
    if let Some(to) = to {
        for source in pivot_sources(zip, &sheet.name) {
            let element = format!("<worksheetSource{}/>", set_xml_attribute(&source.attributes, "sheet", &xml_encode(to)));
            writes.set(&source.part, source.cache.replacen(&source.whole, &element, 1));
        }
    }
    if !rw.refused.is_empty() {
        return Err(refusal(
            &format!("Portable {op} of {} cannot rewrite {} formula(s) that name it: ", sheet.name, rw.refused.len()),
            &rw.refused,
            "Run it on the Office backend (mode:'background'), where Excel rewrites them itself, or change those first.",
        ));
    }
    let rewritten = rw.rewritten;
    for (part, text) in writes.0 {
        zip.set(&part, text);
    }
    Ok(rewritten)
}

/// A copied sheet's own references pointed at the copy, as Excel's copy points them: `Report!A5` in the copy of Report
/// reads the copy's `A5` (`'Report 사본'!A5`), in its cells, rules and validations. Fails when a formula naming the sheet
/// cannot be read.
pub fn copied_sheet_xml(xml: &str, source: &str, name: &str) -> Result<String, String> {
    let replacement = format!("{}!", quote_sheet_name(name));
    let transform = |text: &str, _home: Option<&str>| renamed_formula(text, source, Some(&replacement));
    let mut rw = Rewriter::new(&transform);
    let cells = renamed_cell_formulas(xml, source, &mut rw);
    let next = moved_rule_formulas(&cells, source, &mut rw);
    if !rw.refused.is_empty() {
        return Err(refusal(
            &format!("Portable copy_sheet of {source} cannot point {} formula(s) at the copy: ", rw.refused.len()),
            &rw.refused,
            "Run it on the Office backend (mode:'background'), where Excel copies them itself, or change those first.",
        ));
    }
    Ok(next)
}

/// A part name free in the package, numbered after the stem of `part`.
fn free_part_name(zip: &Package, part: &str) -> Result<String, String> {
    let found = OVERRIDE_TARGET.captures(part).ok_or_else(|| format!("Cannot name a copy of {part}"))?;
    let (stem, extension) = (group(&found, 1), group(&found, 2));
    let mut index = 1;
    while zip.file(&format!("{stem}{index}{extension}")).is_some() {
        index += 1;
    }
    Ok(format!("{stem}{index}{extension}"))
}

fn duplicate_owned_part(zip: &mut Package, part: &str, rewrite_chart: &dyn Fn(&str) -> String) -> Result<String, String> {
    let copy = free_part_name(zip, part)?;
    let content = zip.text(part);
    let content = if CHART_PART.is_match(part) { rewrite_chart(&content) } else { content };
    zip.set(&copy, content);
    let types = zip.text("[Content_Types].xml");
    let override_pattern = compiled(&format!(r#"<Override\b[^>]*\bPartName="/{}"[^>]*\bContentType="([^"]+)""#, tag_pattern(part)), "");
    if let Some(found) = override_pattern.captures(&types) {
        let entry = format!("<Override PartName=\"/{copy}\" ContentType=\"{}\"/></Types>", group(&found, 1));
        zip.set("[Content_Types].xml", types.replacen("</Types>", &entry, 1));
    }
    duplicate_owned_relationships(zip, part, &copy, rewrite_chart, None)?;
    Ok(copy)
}

/// The owner's relationships written for its copy, each owned target copied under a new name and the rest shared.
fn duplicate_owned_relationships(
    zip: &mut Package,
    owner: &str,
    copy: &str,
    rewrite_chart: &dyn Fn(&str) -> String,
    drop: Option<&JsRegex>,
) -> Result<(), String> {
    let rels_path = part_relationship_path(owner);
    let rels = zip.text(&rels_path);
    if rels.is_empty() {
        return Ok(());
    }
    let mut next = rels.clone();
    for found in RELATIONSHIP.captures_iter(&rels) {
        let relationship = found.get(0).unwrap_or("");
        let attributes = group(&found, 1);
        let kind = first_group(&TYPE_ATTRIBUTE, attributes).unwrap_or_default();
        if drop.is_some_and(|drop| drop.is_match(&kind)) {
            next = next.replacen(relationship, "", 1);
            continue;
        }
        if EXTERNAL_MODE.is_match(attributes) || !OWNED_RELATIONSHIP.is_match(&kind) {
            continue;
        }
        let target = relationship_target(&rels_path, &first_group(&TARGET_ATTRIBUTE, attributes).unwrap_or_default());
        if zip.file(&target).is_none() {
            continue;
        }
        let copied = duplicate_owned_part(zip, &target, rewrite_chart)?;
        let relative = posix::relative(&posix::dirname(copy), &copied);
        let element = format!("<Relationship{}/>", set_xml_attribute(attributes, "Target", &relative));
        next = next.replacen(relationship, &element, 1);
    }
    zip.set(&part_relationship_path(copy), next);
    Ok(())
}

/// What a copied sheet needs beyond its cells, as Excel's copy makes it: its own drawing, charts (their series pointed at
/// the copy) and notes, and its names: each sheet-level name of the source, and each workbook name that reads the source,
/// given to the copy as a sheet-level name reading the copy.
pub fn copy_sheet_parts(zip: &mut Package, sheets: &[Sheet], source: &Sheet, copy: &Sheet) -> Result<(), String> {
    let replacement = format!("{}!", quote_sheet_name(&copy.name));
    let repoint = |text: &str| renamed_formula(text, &source.name, Some(&replacement)).unwrap_or_else(|_| text.to_owned());
    let rewrite_chart = |xml: &str| {
        replace_each(&CHART_SERIES, xml, |caps| {
            format!("<{0}:f>{1}</{0}:f>", group(caps, 1), xml_encode(&repoint(&xml_decode(group(caps, 2)))))
        })
    };
    duplicate_owned_relationships(zip, &source.path, &copy.path, &rewrite_chart, Some(&*TABLE_RELATIONSHIP))?;
    let workbook_path = "xl/workbook.xml";
    let workbook = zip.text(workbook_path);
    let source_index = sheets.iter().position(|entry| entry.path == source.path);
    let mut added: Vec<String> = Vec::new();
    for found in DEFINED_NAME.captures_iter(&workbook) {
        let (attributes, body) = (group(&found, 1), group(&found, 2));
        let local = first_group(&LOCAL_SHEET_ID, attributes);
        if let Some(local) = &local {
            if local.parse::<usize>().ok() != source_index {
                continue;
            }
        }
        let text = xml_decode(body);
        let repointed = repoint(&text);
        if local.is_none() && repointed == text {
            continue;
        }
        added.push(format!(
            "<definedName{}>{}</definedName>",
            set_xml_attribute(attributes, "localSheetId", &sheets.len().to_string()),
            xml_encode(&repointed)
        ));
    }
    if !added.is_empty() {
        zip.set(workbook_path, workbook.replacen("</definedNames>", &format!("{}</definedNames>", added.concat()), 1));
    }
    Ok(())
}

/// Excel's record of the order it last calculated formula cells in, by address. Cells that moved leave it naming cells
/// that hold none, which Excel repairs with a warning on open, and a deleted sheet leaves it naming a sheet that is gone,
/// which Excel will not open at all; without it Excel builds a new one.
pub fn drop_calculation_chain(zip: &mut Package) {
    if zip.file("xl/calcChain.xml").is_none() {
        return;
    }
    zip.remove("xl/calcChain.xml");
    let rels_path = "xl/_rels/workbook.xml.rels";
    let rels = zip.text(rels_path);
    if !rels.is_empty() {
        zip.set(rels_path, CALC_CHAIN_RELATIONSHIP.replace_all_with(&rels, |_| String::new()));
    }
    let types = zip.text("[Content_Types].xml");
    if !types.is_empty() {
        zip.set("[Content_Types].xml", replace_first(&CALC_CHAIN_OVERRIDE, &types, |_| String::new()));
    }
}

/// The sheet's tables: a table the edit moves whole follows it, one it would cut or empty is refused.
fn move_table_parts(zip: &Package, relationships: &str, sheet: &Sheet, mv: &Move, writes: &mut Writes, refused: &mut Vec<String>) {
    for (_, part) in relationship_targets_by_type(relationships, &sheet.path, "table").iter() {
        let table = zip.text(part);
        let Some(reference) = first_group(&TABLE_REF, &table) else { continue };
        let moved = moved_reference(&reference, mv);
        if moved.as_deref() == Some(reference.as_str()) {
            continue;
        }
        let name = xml_decode(&first_group(&TABLE_NAME, &table).unwrap_or_else(|| "table".to_owned()));
        let header = reference_span(&reference, mv).map_or(0, |span| span.start);
        let moved = match moved {
            Some(moved) if !(!mv.rows && cuts_through(&reference, mv)) => moved,
            _ => {
                let what = if mv.rows { "rows" } else { "columns" };
                refused.push(format!("table {name} {reference} (its {what} would change; Excel rebuilds the table)"));
                continue;
            }
        };
        if mv.rows && !mv.insert {
            let span = reference_span(&moved, mv);
            if moved_index(header, mv).is_none() || span.is_some_and(|span| span.start == span.end) {
                refused.push(format!("table {name} {reference} (the edit deletes its header or every data row)"));
                continue;
            }
        }
        writes.set(
            part,
            replace_each(&TABLE_AREAS, &table, |caps| {
                let area = group(caps, 2);
                let moved = moved_reference(area, mv).filter(|moved| !moved.is_empty());
                format!("{}{}\"", group(caps, 1), moved.as_deref().unwrap_or(area))
            }),
        );
    }
}

/// The sheet's pivot tables, notes (with their legacy boxes) and drawings, each moved with the cells it sits on.
fn move_owned_sheet_parts(zip: &Package, relationships: &str, sheet: &Sheet, mv: &Move, writes: &mut Writes, refused: &mut Vec<String>) {
    for (_, part) in relationship_targets_by_type(relationships, &sheet.path, "pivotTable").iter() {
        let pivot = zip.text(part);
        let Some(location) = PIVOT_LOCATION.captures(&pivot) else { continue };
        let Some(reference) = first_group(&REF_ATTRIBUTE, group(&location, 1)) else { continue };
        let moved = moved_reference(&reference, mv);
        if moved.as_deref() == Some(reference.as_str()) {
            continue;
        }
        match moved {
            Some(moved) if !cuts_through(&reference, mv) => {
                let element = format!("<location{}/>", set_xml_attribute(group(&location, 1), "ref", &moved));
                writes.set(part, pivot.replacen(&pivot[location.range()], &element, 1));
            }
            _ => refused.push(format!("pivot table at {}!{reference} (the edit cuts through it)", sheet.name)),
        }
    }
    // A note moves with its cell and goes with it, its box following by as many rows (columns) as the cell moved.
    for (_, part) in relationship_targets_by_type(relationships, &sheet.path, "comments").iter() {
        let notes = zip.text(part);
        let next = replace_each(&COMMENT, &notes, |caps| {
            let (before, reference, after, body) = (group(caps, 1), group(caps, 2), group(caps, 3), group(caps, 4));
            match moved_reference(reference, mv) {
                Some(moved) if moved == reference => caps.get(0).unwrap_or("").to_owned(),
                Some(moved) if !moved.is_empty() => format!("<comment{before}ref=\"{moved}\"{after}>{body}</comment>"),
                _ => String::new(),
            }
        });
        if next != notes {
            writes.set(part, next);
        }
    }
    for (_, part) in relationship_targets_by_type(relationships, &sheet.path, "vmlDrawing").iter() {
        let vml = zip.text(part);
        let next = VML_SHAPE.replace_all_with(&vml, |caps| moved_note_shape(caps.get(0).unwrap_or(""), mv));
        if next != vml {
            writes.set(part, next);
        }
    }
    for (_, part) in relationship_targets_by_type(relationships, &sheet.path, "drawing").iter() {
        let drawing = zip.text(part);
        let next = moved_anchors(&drawing, mv);
        if next != drawing {
            writes.set(part, next);
        }
    }
}

/// An insert or a delete of rows or columns of one worksheet.
#[derive(Debug, Clone, Copy)]
pub struct ShiftRequest<'a> {
    /// Rows when true, columns when false.
    pub rows: bool,
    /// The first row (1-based column number) the edit touches.
    pub from: i64,
    pub amount: i64,
    pub insert: bool,
    /// The operation's name, for the refusal text (`insert_rows`).
    pub op: &'a str,
}

/// Inserts or deletes rows (columns) of one worksheet and moves everything in the workbook that names them. `xml` is the
/// worksheet's text. Returns how many formulas, names and chart series were rewritten; fails, with nothing changed,
/// when something naming the moved cells cannot be rewritten.
pub fn shift_worksheet_cells(
    zip: &mut Package,
    sheets: &[Sheet],
    sheet: &Sheet,
    xml: &str,
    request: ShiftRequest<'_>,
) -> Result<usize, String> {
    let ShiftRequest { rows, from, amount, insert, op } = request;
    let mv = Move {
        sheet: sheet.name.clone(),
        rows,
        from,
        amount,
        insert,
        limit: if rows { LIMIT_ROWS } else { LIMIT_COLUMNS },
    };
    let transform = |text: &str, home: Option<&str>| moved_formula(text, home, &mv);
    let mut rw = Rewriter::new(&transform);
    let mut writes = Writes::default();
    for other in sheets {
        let own = other.path == sheet.path;
        let source = if own { xml.to_owned() } else { zip.text(&other.path) };
        if source.is_empty() {
            continue;
        }
        let cells = moved_cell_formulas(&source, &other.name, own, &mv, &mut rw)?;
        let mut next = moved_rule_formulas(&cells, &other.name, &mut rw);
        if own {
            next = moved_sheet_ranges(&next, &mv, &mut rw.refused);
        }
        if next != source || own {
            writes.set(&other.path, next);
        }
    }
    rewrite_names_and_charts(zip, sheets, &mut rw, &mut writes);
    for source in pivot_sources(zip, &sheet.name) {
        let Some(reference) = first_group(&REF_ATTRIBUTE, &source.attributes) else { continue };
        match moved_reference(&reference, &mv) {
            None => rw.refused.push(format!("pivot source {}!{reference} (its cells are all deleted)", sheet.name)),
            Some(moved) if moved != reference => {
                let element = format!("<worksheetSource{}/>", set_xml_attribute(&source.attributes, "ref", &moved));
                writes.set(&source.part, source.cache.replacen(&source.whole, &element, 1));
            }
            Some(_) => {}
        }
    }
    let relationships = zip.text(&part_relationship_path(&sheet.path));
    move_table_parts(zip, &relationships, sheet, &mv, &mut writes, &mut rw.refused);
    move_owned_sheet_parts(zip, &relationships, sheet, &mv, &mut writes, &mut rw.refused);
    if !rw.refused.is_empty() {
        let place = if rows { format!("row {from}") } else { format!("column {}", column_label(from as f64)) };
        return Err(refusal(
            &format!(
                "Portable {op} at {} {place} cannot rewrite {} thing(s) that name the cells it moves: ",
                sheet.name,
                rw.refused.len()
            ),
            &rw.refused,
            "Run the edit on the Office backend (mode:'background'), where Excel rewrites them itself, or change those first.",
        ));
    }
    let rewritten = rw.rewritten;
    let mut moved = writes.get(&sheet.path).unwrap_or_default().to_owned();
    let delta = (if insert { amount } else { -amount }) as f64;
    moved = if rows { shift_worksheet_rows(&moved, from as f64, delta)? } else { shift_worksheet_columns(&moved, from as f64, delta)? };
    if insert {
        moved = if rows { inherited_rows(&moved, from, amount)? } else { inherited_columns(&moved, from, amount) };
    }
    if !rows {
        moved = moved_column_widths(&moved, &mv);
    }
    writes.set(&sheet.path, moved);
    for (part, text) in writes.0 {
        zip.set(&part, text);
    }
    drop_calculation_chain(zip);
    Ok(rewritten)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn rows(sheet: &str, from: i64, amount: i64, insert: bool) -> Move {
        Move { sheet: sheet.to_owned(), rows: true, from, amount, insert, limit: LIMIT_ROWS }
    }

    fn columns(sheet: &str, from: i64, amount: i64, insert: bool) -> Move {
        Move { sheet: sheet.to_owned(), rows: false, from, amount, insert, limit: LIMIT_COLUMNS }
    }

    fn moved(formula: &str, home: &str, mv: &Move) -> String {
        moved_formula(formula, Some(home), mv).expect("a formula the tokenizer reads")
    }

    #[test]
    fn an_insert_grows_a_span_it_lands_inside_and_moves_one_it_precedes() {
        let insert = rows("Data", 6, 2, true);
        assert_eq!(moved_span(2, 6, &insert), Some((2, 8)));
        assert_eq!(moved_span(2, 5, &insert), Some((2, 5)));
        assert_eq!(moved_span(6, 7, &insert), Some((8, 9)));
        assert_eq!(moved_span(1_048_575, 1_048_576, &insert), None);
        assert_eq!(moved_span(5, 1_048_576, &insert), Some((5, 1_048_576)));
    }

    #[test]
    fn a_delete_closes_a_span_up_and_a_span_with_nothing_left_is_gone() {
        let delete = rows("Data", 4, 2, false);
        assert_eq!(moved_span(2, 9, &delete), Some((2, 7)));
        assert_eq!(moved_span(4, 5, &delete), None);
        assert_eq!(moved_span(5, 8, &delete), Some((4, 6)));
        assert_eq!(moved_span(1, 3, &delete), Some((1, 3)));
        assert_eq!(moved_span(6, 7, &delete), Some((4, 5)));
    }

    #[test]
    fn a_reference_body_is_moved_in_the_direction_of_the_edit() {
        let insert = rows("Data", 3, 1, true);
        assert_eq!(moved_reference("$A$5", &insert).as_deref(), Some("$A$6"));
        assert_eq!(moved_reference("B2:C9", &insert).as_deref(), Some("B2:C10"));
        assert_eq!(moved_reference("C9:B2", &insert).as_deref(), Some("C10:B2"));
        assert_eq!(moved_reference("4:6", &insert).as_deref(), Some("5:7"));
        // A whole column and text that is no reference are not the rows' business.
        assert_eq!(moved_reference("C:C", &insert).as_deref(), Some("C:C"));
        assert_eq!(moved_reference("Total", &insert).as_deref(), Some("Total"));
        let across = columns("Data", 2, 2, true);
        assert_eq!(moved_reference("C:C", &across).as_deref(), Some("E:E"));
        assert_eq!(moved_reference("A1:C4", &across).as_deref(), Some("A1:E4"));
        assert_eq!(moved_reference("3:5", &across).as_deref(), Some("3:5"));
        let delete = rows("Data", 3, 1, false);
        assert_eq!(moved_reference("A3", &delete), None);
        assert_eq!(moved_reference("A3:A6", &delete).as_deref(), Some("A3:A5"));
    }

    #[test]
    fn a_block_is_cut_through_when_the_edit_lands_strictly_inside_it() {
        let insert = rows("Data", 3, 1, true);
        assert!(cuts_through("A2:A5", &insert));
        assert!(!cuts_through("A3:A5", &insert));
        let delete = rows("Data", 3, 2, false);
        assert!(cuts_through("A2:A3", &delete));
        assert!(!cuts_through("A3:A4", &delete));
        assert!(!cuts_through("A6:A7", &delete));
    }

    #[test]
    fn rows_inserted_inside_a_range_widen_it_in_every_formula_that_names_it() {
        let insert = rows("Data", 6, 1, true);
        for (before, after) in [
            ("SUM(Data!D2:D6)", "SUM(Data!D2:D7)"),
            ("Data!A6", "Data!A7"),
            ("Data!$B$6+Data!B5", "Data!$B$7+Data!B5"),
            ("SUM(Data!6:6)", "SUM(Data!7:7)"),
            ("SUM(Data!C:C)", "SUM(Data!C:C)"),
            ("IF(Data!A6=\"Data!A6\",\"same\",Data!A6)", "IF(Data!A7=\"Data!A6\",\"same\",Data!A7)"),
            ("SUM(Sept)", "SUM(Sept)"),
            ("SUM(Data!D6:D7)", "SUM(Data!D7:D8)"),
            ("COUNTA(Data!A1:F1)", "COUNTA(Data!A1:F1)"),
            ("SUM(Data!B2:D3)", "SUM(Data!B2:D3)"),
        ] {
            assert_eq!(moved(before, "Report", &insert), after, "{before}");
        }
        // A formula on the moved sheet reads its own unqualified references.
        assert_eq!(moved("SUM(D2:D6)", "Data", &insert), "SUM(D2:D7)");
        assert_eq!(moved("D2/B2-1", "Data", &insert), "D2/B2-1");
        assert_eq!(moved("SUM(D2:D6)", "Report", &insert), "SUM(D2:D6)");
    }

    #[test]
    fn deleted_rows_leave_ref_where_excel_does_and_close_the_ranges_they_cut() {
        let delete = rows("Data", 6, 1, false);
        for (before, after) in [
            ("SUM(Data!D2:D6)", "SUM(Data!D2:D5)"),
            ("Data!A6", "Data!#REF!"),
            ("Data!$B$6+Data!B5", "Data!#REF!+Data!B5"),
            ("SUM(Data!6:6)", "SUM(Data!#REF!)"),
            ("SUM(Data!D6:D7)", "SUM(Data!D6:D6)"),
        ] {
            assert_eq!(moved(before, "Report", &delete), after, "{before}");
        }
    }

    #[test]
    fn inserted_and_deleted_columns_move_references_by_column() {
        let insert = columns("Data", 3, 1, true);
        assert_eq!(moved("SUM(Data!D2:D6)", "Report", &insert), "SUM(Data!E2:E6)");
        assert_eq!(moved("SUM(Data!C:C)", "Report", &insert), "SUM(Data!D:D)");
        assert_eq!(moved("COUNTA(Data!A1:F1)", "Report", &insert), "COUNTA(Data!A1:G1)");
        assert_eq!(moved("SUM(Data!B2:D3)", "Report", &insert), "SUM(Data!B2:E3)");
        assert_eq!(moved("SUM(Data!6:6)", "Report", &insert), "SUM(Data!6:6)");
        let delete = columns("Data", 4, 1, false);
        assert_eq!(moved("SUM(Data!D2:D6)", "Report", &delete), "SUM(Data!#REF!)");
        assert_eq!(moved("COUNTA(Data!A1:F1)", "Report", &delete), "COUNTA(Data!A1:E1)");
        assert_eq!(moved("D2/B2-1", "Data", &delete), "#REF!/B2-1");
    }

    #[test]
    fn a_sheet_named_in_korean_or_in_quotes_is_found() {
        let insert = rows("월별 자료", 3, 2, true);
        assert_eq!(moved("SUM('월별 자료'!D2:D6)", "보고서", &insert), "SUM('월별 자료'!D2:D8)");
        let delete = rows("데이터", 2, 1, false);
        assert_eq!(moved("SUM('데이터'!A1:A3)+데이터!A3", "보고서", &delete), "SUM('데이터'!A1:A2)+데이터!A2");
    }

    #[test]
    fn a_renamed_sheet_is_renamed_where_it_is_named_and_a_deleted_one_leaves_ref() {
        let to = "'자료 2026'!";
        let renamed = |formula: &str| renamed_formula(formula, "Data", Some(to)).expect("a formula");
        assert_eq!(renamed("SUM(Data!B2:B4)"), "SUM('자료 2026'!B2:B4)");
        assert_eq!(renamed("'Data'!A2&\"Data!A2\""), "'자료 2026'!A2&\"Data!A2\"");
        assert_eq!(renamed("Other!A1+Data!$B$2"), "Other!A1+'자료 2026'!$B$2");
        assert_eq!(renamed("B2/B3"), "B2/B3");
        let deleted = |formula: &str| renamed_formula(formula, "Data", None).expect("a formula");
        assert_eq!(deleted("SUM(Data!B2:B4)"), "SUM(#REF!)");
        assert_eq!(deleted("Other!A1+Data!$B$2"), "Other!A1+#REF!");
    }

    #[test]
    fn a_sorted_row_takes_its_unqualified_references_along() {
        assert_eq!(sorted_formula("C6/B6-1", -4).as_deref(), Ok("C2/B2-1"));
        assert_eq!(sorted_formula("Report!C6+C7+$B6+B$2", -4).as_deref(), Ok("Report!C6+C3+$B2+B$2"));
        assert_eq!(sorted_formula("Data!C6*2+SUM(B6:C6)", -4).as_deref(), Ok("Data!C6*2+SUM(B2:C2)"));
        assert_eq!(sorted_formula("C6/SUM($C$2:$C$6)", -4).as_deref(), Ok("C2/SUM($C$2:$C$6)"));
        assert_eq!(sorted_formula("A1", 0).as_deref(), Ok("A1"));
        assert!(sorted_formula("A1", -1).is_err());
    }

    #[test]
    fn an_inserted_row_takes_the_formatting_of_the_row_above() {
        let xml = "<sheetData><row r=\"5\" ht=\"30\" hidden=\"1\"><c r=\"B5\" s=\"3\"><v>1</v></c><c r=\"C5\" s=\"0\"/></row><row r=\"6\"/></sheetData>";
        assert_eq!(
            inherited_rows(xml, 6, 2).as_deref(),
            Ok("<sheetData><row r=\"5\" ht=\"30\" hidden=\"1\"><c r=\"B5\" s=\"3\"><v>1</v></c><c r=\"C5\" s=\"0\"/></row><row r=\"6\" ht=\"30\"><c r=\"B6\" s=\"3\"/></row><row r=\"7\" ht=\"30\"><c r=\"B7\" s=\"3\"/></row><row r=\"6\"/></sheetData>")
        );
        assert_eq!(inherited_rows(xml, 1, 2).as_deref(), Ok(xml));
        let bare = "<sheetData><row r=\"2\"><c r=\"A2\"/></row></sheetData>";
        assert_eq!(inherited_rows(bare, 3, 1).as_deref(), Ok(bare));
    }

    fn workbook() -> Package {
        let mut zip = Package::new();
        zip.set(
            "xl/workbook.xml",
            "<workbook xmlns:r=\"r\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Report\" sheetId=\"2\" r:id=\"rId2\"/></sheets><definedNames><definedName name=\"Sept\">Data!$D$2:$D$6</definedName></definedNames></workbook>",
        );
        zip.set(
            "xl/_rels/workbook.xml.rels",
            "<Relationships><Relationship Id=\"rId1\" Type=\"t\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"t\" Target=\"worksheets/sheet2.xml\"/><Relationship Id=\"rId9\" Type=\"http://x/calcChain\" Target=\"calcChain.xml\"/></Relationships>",
        );
        zip.set(
            "xl/worksheets/sheet1.xml",
            "<worksheet><dimension ref=\"A1:D7\"/><sheetData><row r=\"2\"><c r=\"D2\"><v>1</v></c></row><row r=\"6\"><c r=\"D6\"><v>2</v></c></row><row r=\"7\"><c r=\"D7\"><f>SUM(D2:D6)</f><v>3</v></c></row></sheetData><conditionalFormatting sqref=\"D2:D6\"><cfRule type=\"expression\" priority=\"1\"><formula>$D2&gt;AVERAGE($D$2:$D$6)</formula></cfRule></conditionalFormatting></worksheet>",
        );
        zip.set("xl/worksheets/sheet2.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>SUM(Data!D2:D6)</f><v>0</v></c></row></sheetData></worksheet>");
        zip.set("xl/calcChain.xml", "<calcChain/>");
        zip.set("[Content_Types].xml", "<Types><Override PartName=\"/xl/calcChain.xml\" ContentType=\"c\"/></Types>");
        zip
    }

    fn snapshot(zip: &Package) -> Vec<(String, String)> {
        zip.names().into_iter().map(|name| (zip.text(&name), name)).map(|(text, name)| (name, text)).collect()
    }

    #[test]
    fn rows_inserted_into_a_sheet_move_the_cells_and_everything_that_names_them() {
        let mut zip = workbook();
        let sheets = crate::cells::workbook_sheets(&zip);
        let data = sheets[0].clone();
        let xml = zip.text(&data.path);
        let request = ShiftRequest { rows: true, from: 6, amount: 1, insert: true, op: "insert_rows" };
        assert_eq!(shift_worksheet_cells(&mut zip, &sheets, &data, &xml, request), Ok(4));
        let data_xml = zip.text("xl/worksheets/sheet1.xml");
        assert!(data_xml.contains("<dimension ref=\"A1:D8\"/>"), "{data_xml}");
        assert!(data_xml.contains("<row r=\"7\"><c r=\"D7\"><v>2</v></c></row>"), "{data_xml}");
        assert!(data_xml.contains("<row r=\"8\"><c r=\"D8\"><f>SUM(D2:D7)</f><v>3</v></c></row>"), "{data_xml}");
        assert!(data_xml.contains("<conditionalFormatting sqref=\"D2:D7\">"), "{data_xml}");
        assert!(data_xml.contains("<formula>$D2&gt;AVERAGE($D$2:$D$7)</formula>"), "{data_xml}");
        assert!(zip.text("xl/worksheets/sheet2.xml").contains("<f>SUM(Data!D2:D7)</f>"));
        assert!(zip.text("xl/workbook.xml").contains(">Data!$D$2:$D$7</definedName>"));
        // The calculation chain names cells that moved: Excel builds a new one.
        assert!(zip.file("xl/calcChain.xml").is_none());
        assert!(!zip.text("xl/_rels/workbook.xml.rels").contains("calcChain"));
        assert!(!zip.text("[Content_Types].xml").contains("calcChain"));
    }

    #[test]
    fn what_cannot_be_rewritten_refuses_the_edit_and_leaves_the_workbook_as_it_was() {
        let mut zip = workbook();
        zip.set("xl/worksheets/sheet2.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>SUM(Data!D2:D6)+\u{1}</f></c></row></sheetData></worksheet>");
        let before = snapshot(&zip);
        let sheets = crate::cells::workbook_sheets(&zip);
        let data = sheets[0].clone();
        let xml = zip.text(&data.path);
        let request = ShiftRequest { rows: true, from: 6, amount: 1, insert: true, op: "insert_rows" };
        let error = shift_worksheet_cells(&mut zip, &sheets, &data, &xml, request).expect_err("a formula it cannot read");
        assert!(
            error.starts_with("Portable insert_rows at Data row 6 cannot rewrite 1 thing(s) that name the cells it moves: Report!A1 =SUM(Data!D2:D6)+"),
            "{error}"
        );
        assert!(error.ends_with("Run the edit on the Office backend (mode:'background'), where Excel rewrites them itself, or change those first."), "{error}");
        assert_eq!(before, snapshot(&zip));
    }

    #[test]
    fn a_deleted_sheet_leaves_ref_in_the_names_and_formulas_that_named_it() {
        let mut zip = workbook();
        let sheets = crate::cells::workbook_sheets(&zip);
        let data = sheets[0].clone();
        assert_eq!(rename_sheet_references(&mut zip, &sheets, &data, None, "delete_sheet"), Ok(2));
        assert!(zip.text("xl/worksheets/sheet2.xml").contains("<f>SUM(#REF!)</f>"));
        assert!(zip.text("xl/workbook.xml").contains(">#REF!</definedName>"));
        let mut zip = workbook();
        assert_eq!(rename_sheet_references(&mut zip, &sheets, &data, Some("자료 2026"), "rename_sheet"), Ok(2));
        assert!(zip.text("xl/worksheets/sheet2.xml").contains("<f>SUM(&apos;자료 2026&apos;!D2:D6)</f>"));
        assert!(zip.text("xl/workbook.xml").contains(">&apos;자료 2026&apos;!$D$2:$D$6</definedName>"));
    }

    #[test]
    fn a_copied_sheet_reads_its_own_cells_and_the_calculation_chain_goes() {
        let xml = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>Report!B2+Other!B2</f></c></row></sheetData></worksheet>";
        assert_eq!(
            copied_sheet_xml(xml, "Report", "Report 사본").as_deref(),
            Ok("<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>&apos;Report 사본&apos;!B2+Other!B2</f></c></row></sheetData></worksheet>")
        );
        let mut zip = workbook();
        drop_calculation_chain(&mut zip);
        assert!(zip.file("xl/calcChain.xml").is_none());
        assert!(!zip.text("xl/_rels/workbook.xml.rels").contains("calcChain"));
        assert!(!zip.text("[Content_Types].xml").contains("calcChain"));
    }
}
