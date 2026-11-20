//! `portable/portable-snapshot-xlsx.mjs`: the workbook read model: cells, notes, tables, pivots, visuals and page setup per
//! sheet, validations and conditional formats, the formula lineage, defined names and the workbook's calculation state, in
//! the key order Node writes them (the snapshot is serialised, and compared, as text).

use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::a1::column_label;
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::cells::{
    CellPage, CellRecord, PagedCells, Sheet, boolean_xml_attribute, cell_records, formula_references, paged_cell_records, shared_strings, sheet_formula_totals,
    workbook_calculation, workbook_sheets,
};
use crate::opc::{part_relationship_path, posix, relationship_target_by_type, relationship_targets_by_type};
use crate::shared_formulas::expand_shared_formulas;
use crate::sheet_page::{WorksheetDrawing, worksheet_drawings};
use crate::sheet_styles::resolve_cell_styles;
use crate::sheet_xml::{hidden_sheet_areas, merged_ranges};
use crate::slide_shapes::first_group;
use crate::snapshot_shared::{chart_part_snapshot, populated_cell_pagination, related_part_by_id};
use crate::text_metrics::TextMeasurer;
use crate::xml::{paragraph_texts, xml_attribute, xml_decode};
use crate::zipio::Package;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static AUTHOR: LazyLock<JsRegex> = regex!(r"<author>([\s\S]*?)<\/author>", "g");
static COMMENT: LazyLock<JsRegex> = regex!(r"<comment\b([^>]*)>([\s\S]*?)<\/comment>", "g");
static REF_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bref="([^"]+)""#, "");
static AUTHOR_ID: LazyLock<JsRegex> = regex!(r#"\bauthorId="(\d+)""#, "");
static TABLE_OPEN: LazyLock<JsRegex> = regex!(r"<table\b([^>]*)>", "");
static DISPLAY_NAME: LazyLock<JsRegex> = regex!(r#"\bdisplayName="([^"]*)""#, "");
static NAME_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bname="([^"]*)""#, "");
static TABLE_STYLE: LazyLock<JsRegex> = regex!(r#"<tableStyleInfo\b[^>]*\bname="([^"]*)""#, "");
static PIVOT_LOCATION: LazyLock<JsRegex> = regex!(r#"<location\b[^>]*\bref="([^"]+)""#, "");
static PIVOT_NAME: LazyLock<JsRegex> = regex!(r#"<pivotTableDefinition\b[^>]*\bname="([^"]*)""#, "");
static DRAWING_NAME: LazyLock<JsRegex> = regex!(r#"<xdr:cNvPr\b[^>]*\bname="([^"]*)""#, "");
static DRAWING_DESCRIPTION: LazyLock<JsRegex> = regex!(r#"<xdr:cNvPr\b[^>]*\bdescr="([^"]*)""#, "");
static CHART_ID: LazyLock<JsRegex> = regex!(r#"<c:chart\b[^>]*\br:id="([^"]+)""#, "");
static PICTURE: LazyLock<JsRegex> = regex!(r"<xdr:pic\b", "");
static PAGE_SETUP: LazyLock<JsRegex> = regex!(r"<pageSetup\b([^>]*?)\/?>", "");
static PRINT_OPTIONS: LazyLock<JsRegex> = regex!(r"<printOptions\b([^>]*?)\/?>", "");
static FIT_TO_PAGE: LazyLock<JsRegex> = regex!(r#"<pageSetUpPr\b[^>]*\bfitToPage="(?:1|true)""#, "");
static ODD_HEADER: LazyLock<JsRegex> = regex!(r"<oddHeader>([\s\S]*?)<\/oddHeader>", "");
static ODD_FOOTER: LazyLock<JsRegex> = regex!(r"<oddFooter>([\s\S]*?)<\/oddFooter>", "");
static DEFINED_NAME: LazyLock<JsRegex> = regex!(r"<definedName\b([^>]*)>([\s\S]*?)<\/definedName>", "g");
static DEFINED_NAME_NAME: LazyLock<JsRegex> = regex!(r#"\bname="([^"]+)""#, "");
static LOCAL_SHEET_ID: LazyLock<JsRegex> = regex!(r#"\blocalSheetId="(\d+)""#, "");
static PANE: LazyLock<JsRegex> = regex!(r"<pane\b([^>]*)\/?>", "");
static FROZEN: LazyLock<JsRegex> = regex!(r#"\bstate="frozen(?:Split)?""#, "");
static Y_SPLIT: LazyLock<JsRegex> = regex!(r#"\bySplit="(\d+)""#, "");
static X_SPLIT: LazyLock<JsRegex> = regex!(r#"\bxSplit="(\d+)""#, "");
static SHEET_PROTECTION: LazyLock<JsRegex> = regex!(r"<sheetProtection\b([^>]*?)\/?>", "");
static SHEET_PROTECTION_OPEN: LazyLock<JsRegex> = regex!(r"<sheetProtection\b", "");
static PASSWORD: LazyLock<JsRegex> = regex!(r#"\b(?:password|hashValue)="[^"]+""#, "");
static FORMAT_CELLS_OFF: LazyLock<JsRegex> = regex!(r#"\bformatCells="0""#, "");
static SORT_OFF: LazyLock<JsRegex> = regex!(r#"\bsort="0""#, "");
static AUTO_FILTER_OFF: LazyLock<JsRegex> = regex!(r#"\bautoFilter="0""#, "");
static SQREF: LazyLock<JsRegex> = regex!(r#"\bsqref="([^"]+)""#, "");
static DATA_VALIDATION: LazyLock<JsRegex> = regex!(r"<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)", "g");
static VALIDATION_TYPE: LazyLock<JsRegex> = regex!(r#"\btype="([^"]+)""#, "");
static VALIDATION_OPERATOR: LazyLock<JsRegex> = regex!(r#"\boperator="([^"]+)""#, "");
static FORMULA_ONE: LazyLock<JsRegex> = regex!(r"<formula1(?:\s[^>]*)?>([\s\S]*?)<\/formula1>", "");
static FORMULA_TWO: LazyLock<JsRegex> = regex!(r"<formula2(?:\s[^>]*)?>([\s\S]*?)<\/formula2>", "");
static CONDITIONAL_FORMATTING: LazyLock<JsRegex> = regex!(r"<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>", "g");
static CF_RULE: LazyLock<JsRegex> = regex!(r"<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)", "g");
static PRIORITY: LazyLock<JsRegex> = regex!(r#"\bpriority="(\d+)""#, "");
static CF_FORMULA: LazyLock<JsRegex> = regex!(r"<formula(?:\s[^>]*)?>([\s\S]*?)<\/formula>", "g");

/// `FULL_READ_CELL_LIMIT`: how many populated cells one whole-sheet read carries. It bounds the work a single call does; past
/// it the reading says how far it got.
pub const FULL_READ_CELL_LIMIT: f64 = 200_000.0;

fn group(pattern: &JsRegex, text: &str) -> String {
    first_group(pattern, text).unwrap_or_default()
}

/// `Number(text) || 0` of digits.
fn count_of(pattern: &JsRegex, text: &str) -> f64 {
    let value = first_group(pattern, text).map_or(0.0, |digits| string_to_number(&digits));
    if value.is_nan() { 0.0 } else { value }
}

/// The package path a relationship target of `part` names.
fn target_part(part: &str, target: &str) -> String {
    match target.strip_prefix('/') {
        Some(rooted) => rooted.to_owned(),
        None => posix::normalize(&posix::join(&[posix::dirname(part).as_str(), target])),
    }
}

/// A legacy cell note in the shape Excel reports it: `{ path, cell, text, author }`.
struct Note {
    path: String,
    cell: String,
    text: String,
    author: String,
}

impl Note {
    fn to_json(&self) -> Value {
        json!({ "path": self.path, "cell": self.cell, "text": self.text, "author": self.author })
    }
}

/// `worksheetNotes(zip, sheet)`: legacy cell notes (the comments part a worksheet relates to).
fn worksheet_notes(zip: &Package, sheet: &Sheet) -> Vec<Note> {
    let relationships = zip.text(&part_relationship_path(&sheet.path));
    let target = relationship_target_by_type(&relationships, "comments");
    if target.is_empty() {
        return Vec::new();
    }
    let xml = zip.text(&target_part(&sheet.path, &target));
    if xml.is_empty() {
        return Vec::new();
    }
    let authors: Vec<String> = AUTHOR.captures_iter(&xml).map(|found| xml_decode(found.get(1).unwrap_or(""))).collect();
    let mut notes = Vec::new();
    for found in COMMENT.captures_iter(&xml) {
        let attributes = found.get(1).unwrap_or("");
        let cell = group(&REF_ATTRIBUTE, attributes).to_uppercase();
        if cell.is_empty() {
            continue;
        }
        let author_id = first_group(&AUTHOR_ID, attributes).map_or(-1.0, |digits| string_to_number(&digits));
        let author = if author_id >= 0.0 && author_id.fract() == 0.0 { authors.get(author_id as usize).cloned().unwrap_or_default() } else { String::new() };
        notes.push(Note {
            path: format!("/sheet[{}]/cell[{cell}]/note", sheet.name),
            text: paragraph_texts(found.get(2).unwrap_or(""), "t").join(""),
            author,
            cell,
        });
    }
    notes
}

/// `worksheetTables(zip, sheet)`: Excel tables (ListObjects) a worksheet relates to: `{ path, index, name, range, style }`.
fn worksheet_tables(zip: &Package, sheet: &Sheet) -> Vec<Value> {
    let relationships = zip.text(&part_relationship_path(&sheet.path));
    let mut tables = Vec::new();
    for (_, part) in relationship_targets_by_type(&relationships, &sheet.path, "table").iter() {
        let xml = zip.text(part);
        let open = group(&TABLE_OPEN, &xml);
        let range = group(&REF_ATTRIBUTE, &open).to_uppercase();
        if range.is_empty() {
            continue;
        }
        let display = group(&DISPLAY_NAME, &open);
        let name = if display.is_empty() { group(&NAME_ATTRIBUTE, &open) } else { display };
        tables.push(json!({
            "path": format!("/sheet[{}]/table[{}]", sheet.name, tables.len() + 1),
            "index": tables.len() + 1,
            "name": xml_decode(&name),
            "range": range,
            "style": xml_decode(&group(&TABLE_STYLE, &xml)),
        }));
    }
    tables
}

/// `worksheetPivots(zip, sheet)`: pivot tables a worksheet holds, in the shape Excel reports them: `{ path, index, name,
/// range }`. The workbook read said nothing of them, so a summary built on one was invisible to a caller on the portable
/// backend.
fn worksheet_pivots(zip: &Package, sheet: &Sheet) -> Vec<Value> {
    let relationships = zip.text(&part_relationship_path(&sheet.path));
    let mut pivots = Vec::new();
    for (_, part) in relationship_targets_by_type(&relationships, &sheet.path, "pivotTable").iter() {
        let xml = zip.text(part);
        let range = group(&PIVOT_LOCATION, &xml).to_uppercase();
        if range.is_empty() {
            continue;
        }
        pivots.push(json!({
            "path": format!("/sheet[{}]/pivot[{}]", sheet.name, pivots.len() + 1),
            "index": pivots.len() + 1,
            "name": xml_decode(&group(&PIVOT_NAME, &xml)),
            "range": range,
        }));
    }
    pivots
}

/// `Math.round(value * 100) / 100`.
fn round_hundredths(value: f64) -> Value {
    json_number(math::round(value * 100.0) / 100.0)
}

fn drawing_anchor(drawing: &WorksheetDrawing) -> Value {
    let mut anchor = Map::new();
    anchor.insert("from".to_owned(), Value::String(format!("{}{}", column_label(drawing.start_column), number_to_string(drawing.start_row))));
    anchor.insert("to".to_owned(), Value::String(format!("{}{}", column_label(drawing.end_column), number_to_string(drawing.end_row))));
    anchor.insert("startColumn".to_owned(), json_number(drawing.start_column));
    anchor.insert("startRow".to_owned(), json_number(drawing.start_row));
    anchor.insert("endColumn".to_owned(), json_number(drawing.end_column));
    anchor.insert("endRow".to_owned(), json_number(drawing.end_row));
    if let Some(frame) = drawing.frame.filter(|frame| frame.left.is_finite()) {
        anchor.insert("left".to_owned(), round_hundredths(frame.left));
        anchor.insert("top".to_owned(), round_hundredths(frame.top));
        anchor.insert("width".to_owned(), round_hundredths(frame.width));
        anchor.insert("height".to_owned(), round_hundredths(frame.height));
    }
    Value::Object(anchor)
}

fn drawing_image(sheet: &Sheet, drawing: &WorksheetDrawing, index: usize, anchor: Value) -> Value {
    json!({
        "path": format!("/sheet[{}]/image[{index}]", sheet.name),
        "index": index,
        "name": xml_decode(&group(&DRAWING_NAME, &drawing.body)),
        // What a reader who cannot see the picture is told about it.
        "altText": xml_decode(&group(&DRAWING_DESCRIPTION, &drawing.body)),
        "anchor": anchor,
    })
}

/// The charts and pictures of one sheet.
struct Visuals {
    charts: Vec<Value>,
    images: Vec<Value>,
    drawings_unreadable: Option<String>,
}

/// `worksheetVisuals(zip, sheet, xml)`: charts and pictures a worksheet carries, each placed on the cell grid so a review can
/// compare them with the print area the sheet actually declares.
fn worksheet_visuals<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, sheet: &Sheet, xml: &str) -> Visuals {
    let mut charts = Vec::new();
    let mut images = Vec::new();
    let drawings = match worksheet_drawings(measurer, zip, sheet, xml) {
        Ok(drawings) => drawings,
        Err(message) => return Visuals { charts, images, drawings_unreadable: Some(message) },
    };
    for drawing in &drawings {
        let anchor = drawing_anchor(drawing);
        let chart_id = group(&CHART_ID, &drawing.body);
        if !chart_id.is_empty() {
            let part = related_part_by_id(zip, &drawing.part, &chart_id);
            let mut chart = Map::new();
            chart.insert("path".to_owned(), Value::String(format!("/sheet[{}]/chart[{}]", sheet.name, charts.len() + 1)));
            chart.insert("index".to_owned(), Value::from(charts.len() + 1));
            chart.insert("part".to_owned(), Value::String(part.clone()));
            chart.insert("anchor".to_owned(), anchor);
            if let Value::Object(facts) = chart_part_snapshot(&if part.is_empty() { String::new() } else { zip.text(&part) }) {
                chart.extend(facts);
            }
            charts.push(Value::Object(chart));
            continue;
        }
        if PICTURE.is_match(&drawing.body) {
            images.push(drawing_image(sheet, drawing, images.len() + 1, anchor));
        }
    }
    Visuals { charts, images, drawings_unreadable: None }
}

/// `worksheetPageSetup(xml, printArea)`: print setup in the shape Excel reports it: fit-to-page counts hold only while the
/// sheet is set to fit, and the print area comes from the workbook name.
fn worksheet_page_setup(xml: &str, print_area: &str) -> Value {
    let setup = group(&PAGE_SETUP, xml);
    let options = group(&PRINT_OPTIONS, xml);
    // xsd:boolean: Excel writes "1", LibreOffice's recalculation save writes "true".
    let fit_to_page = FIT_TO_PAGE.is_match(xml);
    // A count the file leaves out is 1, the schema's default and how Excel and LibreOffice print it; 0 is automatic. A
    // missing height had read as free while the sheet printed shrunk onto one page.
    let fit_count = |name: &str| {
        let count = xml_attribute(&setup, name);
        if count.is_empty() {
            1.0
        } else {
            let number = string_to_number(&count);
            if number.is_nan() { 0.0 } else { number }
        }
    };
    let scale = string_to_number(&xml_attribute(&setup, "scale"));
    json!({
        "orientation": xml_attribute(&setup, "orientation"),
        "zoom": json_number(if scale.is_nan() || scale == 0.0 { 100.0 } else { scale }),
        "fitToPage": fit_to_page,
        "fitToPagesWide": json_number(if fit_to_page { fit_count("fitToWidth") } else { 0.0 }),
        "fitToPagesTall": json_number(if fit_to_page { fit_count("fitToHeight") } else { 0.0 }),
        "centerHorizontally": boolean_xml_attribute(&options, "horizontalCentered"),
        "centerVertically": boolean_xml_attribute(&options, "verticalCentered"),
        // What every printed page of this sheet says, beside what the grid holds.
        "header": xml_decode(&group(&ODD_HEADER, xml)),
        "footer": xml_decode(&group(&ODD_FOOTER, xml)),
        "printArea": print_area,
    })
}

/// A workbook defined name.
struct DefinedName {
    name: String,
    local_sheet_id: f64,
    refers_to: String,
    value: Value,
}

fn workbook_defined_names(workbook_xml: &str) -> Vec<DefinedName> {
    let mut names = Vec::new();
    for found in DEFINED_NAME.captures_iter(workbook_xml) {
        let attributes = found.get(1).unwrap_or("");
        let name = xml_decode(&group(&DEFINED_NAME_NAME, attributes));
        let local_sheet_id = first_group(&LOCAL_SHEET_ID, attributes).map_or(-1.0, |digits| string_to_number(&digits));
        let refers_to = xml_decode(found.get(2).unwrap_or(""));
        let value = json!({
            "path": format!("/defined-name[{}]", names.len() + 1),
            "index": names.len() + 1,
            "name": name,
            "localSheetId": json_number(local_sheet_id),
            "hidden": boolean_xml_attribute(attributes, "hidden"),
            "refersTo": refers_to,
        });
        names.push(DefinedName { name, local_sheet_id, refers_to, value });
    }
    names
}

/// `sheetPrintArea(definedNames, sheetIndex)`: `_xlnm.Print_Area` is a sheet-local defined name; Excel writes it absolute and
/// comma-separated when the sheet prints several areas.
fn sheet_print_area(defined_names: &[DefinedName], sheet_index: Option<usize>) -> String {
    let Some(entry) = defined_names.iter().find(|item| item.name == "_xlnm.Print_Area" && sheet_index.is_some_and(|index| item.local_sheet_id == index as f64))
    else {
        return String::new();
    };
    entry
        .refers_to
        .split(',')
        .map(|part| js_trim(&part.rsplit('!').next().unwrap_or("").replace('$', "")).to_owned())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

/// `xlsxCellLimit(options)`: a snapshot read for a person is trimmed to a readable page. A reader that audits, diffs, or
/// searches the workbook asks for the whole sheet instead (full): with the display cap in force every such check silently
/// stops at the same boundary and still answers as if it had read the sheet.
fn xlsx_cell_limit(options: &Value) -> f64 {
    let limit = to_number_of(options.get("cellLimit"));
    if limit.is_finite() {
        return math::max(1.0, limit);
    }
    if options.get("full") == Some(&Value::Bool(true)) { FULL_READ_CELL_LIMIT } else { 2_000.0 }
}

/// `selectXlsxSheets(sheets, options, paged, sheetOffset)`: a paged read walks the workbook one sheet at a time; without a
/// named sheet it starts where the cursor left off, so every sheet is reachable.
fn select_xlsx_sheets<'a>(sheets: &'a [Sheet], options: &Value, paged: bool, sheet_offset: f64) -> Result<Vec<&'a Sheet>, String> {
    if !paged {
        return Ok(sheets.iter().collect());
    }
    let named = options.get("sheet").filter(|name| truthy(name));
    let sheet = match named {
        Some(name) => {
            let wanted = js_to_lowercase(&value_to_string(name));
            sheets.iter().find(|entry| js_to_lowercase(&entry.name) == wanted)
        }
        None => {
            if sheet_offset.fract() == 0.0 {
                sheets.get(sheet_offset as usize)
            } else {
                None
            }
        }
    };
    if let Some(name) = named
        && sheet.is_none()
    {
        return Err(format!("XLSX sheet not found: {}", value_to_string(name)));
    }
    Ok(sheet.into_iter().collect())
}

/// `worksheetFreezePanes(xml)`: the same shape Excel reports: which rows and columns stay put.
fn worksheet_freeze_panes(xml: &str) -> Value {
    let pane = group(&PANE, xml);
    json!({
        "frozen": FROZEN.is_match(&pane),
        "splitRow": json_number(count_of(&Y_SPLIT, &pane)),
        "splitColumn": json_number(count_of(&X_SPLIT, &pane)),
    })
}

/// `worksheetProtection(xml)`: protection decides whether a locked cell is actually read-only, so the sheet reports it beside
/// the cells that carry the flag.
fn worksheet_protection(xml: &str) -> Value {
    let guard = group(&SHEET_PROTECTION, xml);
    let mut protection = Map::new();
    protection.insert("protected".to_owned(), Value::Bool(SHEET_PROTECTION_OPEN.is_match(xml)));
    if !guard.is_empty() {
        protection.insert("password".to_owned(), Value::Bool(PASSWORD.is_match(&guard)));
        protection.insert("allowFormattingCells".to_owned(), Value::Bool(FORMAT_CELLS_OFF.is_match(&guard)));
        protection.insert("allowSorting".to_owned(), Value::Bool(SORT_OFF.is_match(&guard)));
        protection.insert("allowFiltering".to_owned(), Value::Bool(AUTO_FILTER_OFF.is_match(&guard)));
    }
    Value::Object(protection)
}

/// `sqrefRanges(attributes)`: the cells a validation or a conditional format applies to: one sqref attribute holding
/// space-separated A1 ranges.
fn sqref_ranges(attributes: &str) -> Vec<Value> {
    xml_decode(&group(&SQREF, attributes)).split(mixdog_js::is_js_space).filter(|range| !range.is_empty()).map(Value::from).collect()
}

/// `worksheetValidations(xml, sheetName)`.
pub fn worksheet_validations(xml: &str, sheet_name: &str) -> Vec<Value> {
    let mut validations = Vec::new();
    for found in DATA_VALIDATION.captures_iter(xml) {
        let attributes = found.get(1).unwrap_or("");
        let body = found.get(2).unwrap_or("");
        validations.push(json!({
            "path": format!("/sheet[{sheet_name}]/validation[{}]", validations.len() + 1),
            "index": validations.len() + 1,
            "ranges": sqref_ranges(attributes),
            "type": group(&VALIDATION_TYPE, attributes),
            "operator": group(&VALIDATION_OPERATOR, attributes),
            "allowBlank": boolean_xml_attribute(attributes, "allowBlank"),
            "showInputMessage": boolean_xml_attribute(attributes, "showInputMessage"),
            "showErrorMessage": boolean_xml_attribute(attributes, "showErrorMessage"),
            "formula1": xml_decode(&group(&FORMULA_ONE, body)),
            "formula2": xml_decode(&group(&FORMULA_TWO, body)),
        }));
    }
    validations
}

fn worksheet_conditional_formats(xml: &str, sheet_name: &str) -> Vec<Value> {
    let mut formats = Vec::new();
    for found in CONDITIONAL_FORMATTING.captures_iter(xml) {
        let ranges = sqref_ranges(found.get(1).unwrap_or(""));
        for rule in CF_RULE.captures_iter(found.get(2).unwrap_or("")) {
            let attributes = rule.get(1).unwrap_or("");
            let body = rule.get(2).unwrap_or("");
            let priority = count_of(&PRIORITY, attributes);
            let formulas: Vec<Value> = CF_FORMULA.captures_iter(body).map(|entry| Value::String(xml_decode(entry.get(1).unwrap_or("")))).collect();
            formats.push(json!({
                "path": format!("/sheet[{sheet_name}]/conditional-format[{}]", formats.len() + 1),
                "index": formats.len() + 1,
                "ranges": ranges,
                "type": xml_decode(&group(&VALIDATION_TYPE, attributes)),
                "operator": xml_decode(&group(&VALIDATION_OPERATOR, attributes)),
                "priority": json_number(priority),
                "formulas": formulas,
            }));
        }
    }
    formats
}

fn formula_lineage(cells: &[CellRecord], sheet_name: &str) -> Vec<Value> {
    cells
        .iter()
        .filter_map(|cell| cell.formula.as_ref().filter(|info| !info.formula.is_empty()).map(|info| (cell, info)))
        .map(|(cell, info)| {
            let precedents: Vec<Value> = formula_references(&info.formula, sheet_name)
                .into_iter()
                .map(|reference| json!({ "sheet": reference.sheet, "ref": reference.reference, "path": reference.path }))
                .collect();
            json!({
                "path": format!("/sheet[{sheet_name}]/cell[{}]/lineage", cell.reference),
                "from": format!("/sheet[{sheet_name}]/cell[{}]", cell.reference),
                "formula": info.formula,
                "precedents": precedents,
            })
        })
        .collect()
}

/// The records of one sheet's read: every cell of an unpaged one, or the page of a paged one with the totals it counted.
enum CellRead {
    Whole(Vec<CellRecord>),
    Paged(PagedCells),
}

impl CellRead {
    fn records(&self) -> &[CellRecord] {
        match self {
            Self::Whole(records) => records,
            Self::Paged(page) => &page.records,
        }
    }

    fn records_mut(&mut self) -> &mut [CellRecord] {
        match self {
            Self::Whole(records) => records,
            Self::Paged(page) => &mut page.records,
        }
    }
}

/// What the workbook-wide parts of the read share with every sheet.
struct SnapshotContext<'a> {
    strings: Vec<String>,
    styles: Vec<Value>,
    defined_names: Vec<DefinedName>,
    sheets: &'a [Sheet],
    options: &'a Value,
    paged: bool,
    cell_limit: f64,
}

/// The cells a sheet entry reports: the page's records, or the first `cellLimit` of an unpaged read. Each cell carries its
/// path first and the note of its cell last.
///
/// A formula the stored-once expansion gave a cell (`patched`) is reported as Node reports it: written last, after the style,
/// with no cached value or cache state of its own (the cell's file carries no formula element to read them from).
fn worksheet_cell_page(sheet: &Sheet, read: &CellRead, patched: &[bool], notes: &[Note], context: &SnapshotContext<'_>) -> (Value, Value, Value) {
    let cells = read.records();
    let shown = if context.paged { cells.len() } else { cells.len().min(context.cell_limit as usize) };
    let mut by_cell: Vec<(&str, &str)> = Vec::new();
    for note in notes {
        by_cell.retain(|(cell, _)| *cell != note.cell);
        by_cell.push((note.cell.as_str(), note.text.as_str()));
    }
    let shown_cells: Vec<Value> = cells[..shown]
        .iter()
        .enumerate()
        .map(|(position, cell)| {
            let expanded = patched[position];
            let mut entry = Map::new();
            entry.insert("path".to_owned(), Value::String(format!("/sheet[{}]/cell[{}]", sheet.name, cell.reference)));
            if let Value::Object(record) = cell.to_json() {
                for (key, value) in record {
                    if !(expanded && matches!(key.as_str(), "formula" | "cachedValue" | "cacheState")) {
                        entry.insert(key, value);
                    }
                }
            }
            if let Some(info) = cell.formula.as_ref().filter(|_| expanded) {
                entry.insert("formula".to_owned(), Value::from(info.formula.as_str()));
            }
            if let Some((_, text)) = by_cell.iter().find(|(reference, text)| *reference == cell.reference && !text.is_empty()) {
                entry.insert("note".to_owned(), Value::from(*text));
            }
            Value::Object(entry)
        })
        .collect();
    let (count, truncated) = match read {
        CellRead::Paged(page) => (page.total, page.total > cells.len()),
        CellRead::Whole(records) => (records.len(), records.len() as f64 > context.cell_limit),
    };
    (Value::from(count), Value::Array(shown_cells), Value::Bool(truncated))
}

/// One sheet of the snapshot, with the cell records it was read from (a paged read reports the page's totals from them).
fn snapshot_worksheet<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &Package,
    sheet: &Sheet,
    context: &SnapshotContext<'_>,
) -> Result<(Value, CellRead), String> {
    let xml = zip.text(&sheet.path);
    let styles = Some(context.styles.as_slice());
    let mut read = if context.paged {
        let range = context.options.get("range").filter(|range| truthy(range)).map(value_to_string);
        let page = CellPage::new(to_number_of(context.options.get("offset")), to_number_of(context.options.get("limit")), range.as_deref());
        CellRead::Paged(paged_cell_records(&xml, &context.strings, styles, &page)?)
    } else {
        CellRead::Whole(cell_records(&xml, &context.strings, styles))
    };
    let had_formula: Vec<bool> = read.records().iter().map(|cell| cell.formula.is_some()).collect();
    expand_shared_formulas(&xml, read.records_mut())?;
    let patched: Vec<bool> = read.records().iter().zip(&had_formula).map(|(cell, had)| !had && cell.formula.is_some()).collect();
    let notes = worksheet_notes(zip, sheet);
    let tables = worksheet_tables(zip, sheet);
    let pivots = worksheet_pivots(zip, sheet);
    let visuals = worksheet_visuals(measurer, zip, sheet, &xml);
    let sheet_index = context.sheets.iter().position(|entry| entry.name == sheet.name);
    let page_setup = worksheet_page_setup(&xml, &sheet_print_area(&context.defined_names, sheet_index));
    let validations = worksheet_validations(&xml, &sheet.name);
    let conditional_formats = worksheet_conditional_formats(&xml, &sheet.name);
    let lineage = formula_lineage(read.records(), &sheet.name);
    let hidden = hidden_sheet_areas(&xml);
    let (cell_count, cells, truncated) = worksheet_cell_page(sheet, &read, &patched, &notes, context);
    let mut entry = Map::new();
    entry.insert("path".to_owned(), Value::String(format!("/sheet[{}]", sheet.name)));
    entry.insert("name".to_owned(), Value::from(sheet.name.as_str()));
    entry.insert("visibility".to_owned(), Value::from(sheet.visibility));
    // Rows and columns the sheet withholds: a filtered view or a working column still holds values, and an edit written
    // into one lands where the user never looks.
    entry.insert("hiddenRows".to_owned(), Value::Array(hidden.rows.iter().map(|row| Value::from(*row)).collect()));
    entry.insert("hiddenColumns".to_owned(), Value::Array(hidden.columns.iter().map(|column| Value::String(column_label(f64::from(*column)))).collect()));
    entry.insert("cellCount".to_owned(), cell_count);
    entry.insert("cells".to_owned(), cells);
    entry.insert("truncated".to_owned(), truncated);
    entry.insert("noteCount".to_owned(), Value::from(notes.len()));
    entry.insert("notes".to_owned(), Value::Array(notes.iter().map(Note::to_json).collect()));
    entry.insert("tableCount".to_owned(), Value::from(tables.len()));
    entry.insert("tables".to_owned(), Value::Array(tables));
    entry.insert("pivots".to_owned(), Value::Array(pivots));
    entry.insert("mergedRanges".to_owned(), Value::Array(merged_ranges(&xml).into_iter().map(Value::from).collect()));
    entry.insert("freezePanes".to_owned(), worksheet_freeze_panes(&xml));
    entry.insert("protection".to_owned(), worksheet_protection(&xml));
    entry.insert("pageSetup".to_owned(), page_setup);
    entry.insert("chartCount".to_owned(), Value::from(visuals.charts.len()));
    entry.insert("charts".to_owned(), Value::Array(visuals.charts));
    entry.insert("imageCount".to_owned(), Value::from(visuals.images.len()));
    entry.insert("images".to_owned(), Value::Array(visuals.images));
    if let Some(message) = visuals.drawings_unreadable {
        entry.insert("drawingsUnreadable".to_owned(), Value::String(message));
    }
    entry.insert("validationCount".to_owned(), Value::from(validations.len()));
    entry.insert("validations".to_owned(), Value::Array(validations));
    entry.insert("conditionalFormatCount".to_owned(), Value::from(conditional_formats.len()));
    entry.insert("conditionalFormats".to_owned(), Value::Array(conditional_formats));
    entry.insert("lineageCount".to_owned(), Value::from(lineage.len()));
    entry.insert("formulaLineage".to_owned(), Value::Array(lineage));
    Ok((Value::Object(entry), read))
}

/// The selected sheets' entries with the workbook's formula totals: an unpaged read counts the cells it returned, a paged
/// one counts the whole workbook (a paged snapshot returns one sheet, but the calculation state it reports belongs to the
/// workbook: a caller must not read needsRecalculation:false merely because the single sheet it received happens to be
/// settled).
struct SelectedSheets {
    entries: Vec<Value>,
    page: Value,
    formula_count: usize,
    formula_cache_missing: usize,
}

fn snapshot_selected_sheets<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &Package,
    selected: &[&Sheet],
    context: &SnapshotContext<'_>,
) -> Result<SelectedSheets, String> {
    let mut result = SelectedSheets { entries: Vec::new(), page: Value::Null, formula_count: 0, formula_cache_missing: 0 };
    for sheet in selected {
        let (entry, read) = snapshot_worksheet(measurer, zip, sheet, context)?;
        match &read {
            // Pagination reads the length of the page's records and the total, nothing else of them.
            CellRead::Paged(page) => result.page = json!({ "records": vec![Value::Null; page.records.len()], "total": page.total }),
            CellRead::Whole(cells) => {
                for cell in cells {
                    let Some(info) = &cell.formula else { continue };
                    if info.formula.is_empty() {
                        continue;
                    }
                    result.formula_count += 1;
                    if info.cache_state == "missing" {
                        result.formula_cache_missing += 1;
                    }
                }
            }
        }
        result.entries.push(entry);
    }
    if context.paged {
        for sheet in context.sheets {
            let (count, missing) = sheet_formula_totals(&zip.text(&sheet.path));
            result.formula_count += count;
            result.formula_cache_missing += missing;
        }
    }
    Ok(result)
}

/// `snapshotXlsx(zip, options)`: the workbook read model. `options` is `{ paged?, offset?, limit?, range?, sheet?,
/// sheetOffset?, cellLimit?, full? }`.
pub fn snapshot_xlsx<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, options: &Value) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let options = if options.is_null() { &empty } else { options };
    let sheets = workbook_sheets(zip);
    let styles = resolve_cell_styles(&zip.text("xl/styles.xml"));
    let workbook_xml = zip.text("xl/workbook.xml");
    let calculation = workbook_calculation(&workbook_xml);
    let defined_names = workbook_defined_names(&workbook_xml);
    let paged = options.get("paged") == Some(&Value::Bool(true));
    let offset = to_number_of(options.get("sheetOffset"));
    let offset = if offset.is_nan() || offset == 0.0 { 0.0 } else { offset };
    let sheet_offset = math::max(0.0, math::min(sheets.len() as f64 - 1.0, offset));
    let selected = select_xlsx_sheets(&sheets, options, paged, sheet_offset)?;
    let default_style = styles.first().cloned().unwrap_or(Value::Null);
    let defined_values: Vec<Value> = defined_names.iter().map(|entry| entry.value.clone()).collect();
    let context =
        SnapshotContext { strings: shared_strings(zip), styles, defined_names, sheets: &sheets, options, paged, cell_limit: xlsx_cell_limit(options) };
    let read = snapshot_selected_sheets(measurer, zip, &selected, &context)?;
    let pagination = if paged {
        let named: Vec<Value> = selected.iter().map(|sheet| json!({ "name": sheet.name })).collect();
        Some(populated_cell_pagination(options, &read.page, &named, sheets.len(), sheet_offset))
    } else {
        None
    };
    let mut snapshot = Map::new();
    snapshot.insert("format".to_owned(), Value::from("xlsx"));
    snapshot.insert("sheetCount".to_owned(), Value::from(sheets.len()));
    // Which sheets the workbook holds, whichever one this page carries: a paged read otherwise hides every sheet but the one
    // it returned.
    if paged {
        snapshot.insert("sheetNames".to_owned(), Value::Array(sheets.iter().map(|sheet| Value::from(sheet.name.as_str())).collect()));
    }
    snapshot.insert("sheets".to_owned(), Value::Array(read.entries));
    // The workbook default (cellXfs 0): what every unstyled cell renders with.
    snapshot.insert("defaultStyle".to_owned(), default_style);
    snapshot.insert("formulaCount".to_owned(), Value::from(read.formula_count));
    snapshot.insert("formulaCacheMissing".to_owned(), Value::from(read.formula_cache_missing));
    // An edit marks the workbook for a full calculation. Until that has run the cached values are the ones from before the
    // edit, cache or no cache, so a reader must not be told the workbook is current.
    snapshot.insert("needsRecalculation".to_owned(), Value::Bool(read.formula_cache_missing > 0 || calculation.full_calc_on_load));
    snapshot.insert(
        "calculation".to_owned(),
        json!({ "mode": calculation.mode, "fullCalcOnLoad": calculation.full_calc_on_load, "forceFullCalc": calculation.force_full_calc }),
    );
    snapshot.insert("definedNameCount".to_owned(), Value::from(defined_values.len()));
    snapshot.insert("definedNames".to_owned(), Value::Array(defined_values));
    if let Some(pagination) = pagination {
        snapshot.insert("pagination".to_owned(), pagination);
    }
    Ok(Value::Object(snapshot))
}
