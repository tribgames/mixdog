//! `portable/portable-xlsx-operations.mjs`: the worksheet-level operations the xlsx backend applies that are not a cell edit:
//! adding, renaming and deleting a sheet, the header and footer a printed sheet carries, conditional formats and data
//! validations. (Sorting, autofit, pictures, charts and pivot tables live in their own modules.)

use std::sync::{Arc, LazyLock};

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, number_to_string, string_to_number, utf16_len, value_to_string};
use mixdog_office_base::xlsx_validation::normalize_xlsx_validation;
use serde_json::{Map, Value, json};

use crate::cells::Sheet;
use crate::opc::{ensure_content_type_override, next_relationship_id, part_relationship_path, remove_content_type_override};
use crate::sheet_xml::{
    append_differential_format, append_worksheet_section, area_reference, conditional_scale_rule, parse_area_range,
    upsert_defined_name, upsert_worksheet_section, worksheet_section,
};
use crate::xlsx_audit_support::{js_text, text_or_empty, text_or_empty_nullish, truthy};
use crate::xlsx_contract::{conditional_format_kind, list_validation_choices};
use crate::xlsx_reference_shift::{drop_calculation_chain, rename_sheet_references};
use crate::xml::{
    OFFICE_RELATIONSHIP_BASE, SPREADSHEET_MAIN, compiled, container_body, tag_pattern, xml_attribute, xml_decode, xml_encode,
};
use crate::zipio::Package;

pub const WORKSHEET_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
pub const WORKSHEET_RELATIONSHIP: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
/// The cells one `set_style` may cover.
pub const MAX_STYLED_CELLS: f64 = 20_000.0;
pub const TABLE_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";

pub(crate) const WORKBOOK_PATH: &str = "xl/workbook.xml";
const WORKBOOK_RELATIONSHIPS: &str = "xl/_rels/workbook.xml.rels";

static FORBIDDEN_SHEET_CHARACTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[:\\/?*[\]]", ""));
static EDGE_APOSTROPHE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^'|'$", ""));
static HISTORY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^history$", "i"));
static SHEETS_SECTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<sheets\b[^>]*?(?:\/>|>[\s\S]*?<\/sheets>)", ""));
static SHEET_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<sheet\b[^>]*\bsheetId="(\d+)""#, "g"));
static DEFINED_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)", "g"));
static LOCAL_SHEET_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\blocalSheetId="\d+""#, ""));
static WHOLE_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d+$", ""));
static NAME_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bname="[^"]*""#, ""));
static ODD_FOOTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<oddFooter>[\s\S]*?<\/oddFooter>", ""));
static ODD_HEADER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<oddHeader>[\s\S]*?<\/oddHeader>", ""));
static CF_PRIORITY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<cfRule\b[^>]*\bpriority="(\d+)""#, "g"));
static VALIDATION_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<dataValidation\b", "g"));
static LEADING_EQUALS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^=", ""));

/// The first match of `pattern` in `text` replaced by what `with` makes of the matched text.
pub(crate) fn replace_first(pattern: &JsRegex, text: &str, with: impl FnOnce(&str) -> String) -> String {
    match pattern.find(text) {
        Some(range) => format!("{}{}{}", &text[..range.start], with(&text[range.clone()]), &text[range.end..]),
        None => text.to_owned(),
    }
}

/// `tableStyleInfoXml(style)`: a built-in table style bands the range from the workbook's own theme, which is not the palette a
/// composed sheet paints with. `style: 'none'` keeps the table (its name, its filters, its structured references) and leaves
/// the colours to whoever set them.
pub fn table_style_info_xml(style: Option<&Value>) -> String {
    let name = match style {
        None => "TableStyleMedium2".to_owned(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    };
    if name.is_empty() || js_to_lowercase(&name) == "none" {
        return "<tableStyleInfo showFirstColumn=\"0\" showLastColumn=\"0\" showRowStripes=\"0\" showColumnStripes=\"0\"/>".to_owned();
    }
    format!(
        "<tableStyleInfo name=\"{}\" showFirstColumn=\"0\" showLastColumn=\"0\" showRowStripes=\"1\" showColumnStripes=\"0\"/>",
        xml_encode(&name)
    )
}

fn empty_worksheet_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<worksheet xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\">\
<sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><sheetData/></worksheet>"
    )
}

/// `assertWorksheetName(operation, name)`: Excel refuses these itself: a workbook written with such a name opens as a repair
/// prompt, which is a worse answer than refusing the operation here.
pub fn assert_worksheet_name(operation: &str, name: Option<&Value>) -> Result<String, String> {
    let label = js_trim(&text_or_empty(name)).to_owned();
    if label.is_empty() {
        return Err(format!("{operation} requires name"));
    }
    if utf16_len(&label) > 31 {
        return Err("Worksheet names are limited to 31 characters".to_owned());
    }
    if let Some(range) = FORBIDDEN_SHEET_CHARACTER.find(&label) {
        return Err(format!("Worksheet names cannot contain : \\ / ? * [ ] \u{2014} \"{label}\" has {}", &label[range]));
    }
    if EDGE_APOSTROPHE.is_match(&label) {
        return Err(format!("Worksheet names cannot start or end with an apostrophe: {label}"));
    }
    if HISTORY.is_match(&label) {
        return Err("History is reserved by Excel and cannot name a worksheet".to_owned());
    }
    Ok(label)
}

fn sheet_entry_pattern(name: &str) -> Arc<JsRegex> {
    compiled(&format!(r#"<sheet\b[^>]*\bname="{}"[^>]*\/>"#, tag_pattern(&xml_encode(name))), "i")
}

/// The next `sheetId` of a workbook: one more than the highest.
pub(crate) fn next_sheet_id(workbook: &str) -> String {
    let highest = SHEET_ID.captures_iter(workbook).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(0.0, f64::max);
    number_to_string(highest + 1.0)
}

/// `addWorksheet(zip, name)`: a new empty sheet last in the workbook; answers the name it was given.
pub fn add_worksheet(zip: &mut Package, name: Option<&Value>) -> Result<String, String> {
    let label = assert_worksheet_name("add_sheet", name)?;
    let workbook = zip.text(WORKBOOK_PATH);
    if compiled(&format!(r#"<sheet\b[^>]*\bname="{}""#, tag_pattern(&xml_encode(&label))), "i").is_match(&workbook) {
        return Err(format!("Worksheet already exists: {label}"));
    }
    let mut ordinal = 1_u64;
    while zip.file(&format!("xl/worksheets/sheet{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let part = format!("xl/worksheets/sheet{ordinal}.xml");
    zip.set(&part, empty_worksheet_xml());
    let rels = zip.text(WORKBOOK_RELATIONSHIPS);
    if rels.is_empty() {
        return Err("Workbook relationships are missing".to_owned());
    }
    let relationship_id = next_relationship_id(&rels);
    let relationship = format!(
        "<Relationship Id=\"{relationship_id}\" Type=\"{WORKSHEET_RELATIONSHIP}\" Target=\"worksheets/sheet{ordinal}.xml\"/></Relationships>"
    );
    zip.set(WORKBOOK_RELATIONSHIPS, rels.replacen("</Relationships>", &relationship, 1));
    let entry = format!("<sheet name=\"{}\" sheetId=\"{}\" r:id=\"{relationship_id}\"/>", xml_encode(&label), next_sheet_id(&workbook));
    let Some(section) = SHEETS_SECTION.find(&workbook) else {
        return Err("Workbook is missing its sheet list".to_owned());
    };
    let current = &workbook[section.clone()];
    let next = if current.ends_with("/>") { format!("<sheets>{entry}</sheets>") } else { current.replacen("</sheets>", &format!("{entry}</sheets>"), 1) };
    zip.set(WORKBOOK_PATH, format!("{}{next}{}", &workbook[..section.start], &workbook[section.end..]));
    ensure_content_type_override(zip, &format!("/{part}"), WORKSHEET_CONTENT_TYPE);
    Ok(label)
}

/// `renameWorksheet(zip, sheet, name, sheets)`: Excel renames a sheet in every formula, name, rule and chart series that names
/// it; the workbook entry alone left them naming a sheet that no longer exists. Answers `{ from, to, referencesRewritten }`.
pub fn rename_worksheet(zip: &mut Package, sheet: &Sheet, name: Option<&Value>, sheets: &[Sheet]) -> Result<Value, String> {
    let label = assert_worksheet_name("rename_sheet", name)?;
    let pattern = sheet_entry_pattern(&sheet.name);
    if !pattern.is_match(&zip.text(WORKBOOK_PATH)) {
        return Err(format!("Worksheet not found: {}", sheet.name));
    }
    let rewritten = rename_sheet_references(zip, sheets, sheet, Some(label.as_str()), "rename_sheet")?;
    let workbook = zip.text(WORKBOOK_PATH);
    let Some(found) = pattern.find(&workbook) else {
        return Err("Cannot read properties of null (reading '0')".to_owned());
    };
    let renamed = replace_first(&NAME_ATTRIBUTE, &workbook[found.clone()], |_| format!("name=\"{}\"", xml_encode(&label)));
    zip.set(WORKBOOK_PATH, format!("{}{renamed}{}", &workbook[..found.start], &workbook[found.end..]));
    Ok(json!({ "from": sheet.name, "to": label, "referencesRewritten": rewritten }))
}

/// A defined name's `localSheetId` as a number; a workbook-level name carries none, and an absent attribute reads back as an
/// empty string: taking that as 0 deleted every global name along with the first sheet.
fn local_sheet_id(item: &str) -> Option<f64> {
    let raw = xml_attribute(item, "localSheetId");
    WHOLE_NUMBER.is_match(&raw).then(|| string_to_number(&raw))
}

/// `deleteWorksheet(zip, sheets, sheet)`: what named the sheet reads `#REF!` in its place, as Excel leaves it. Answers
/// `{ sheet }`.
pub fn delete_worksheet(zip: &mut Package, sheets: &[Sheet], sheet: &Sheet) -> Result<Value, String> {
    if sheets.len() <= 1 {
        return Err("A workbook must keep at least one worksheet".to_owned());
    }
    let index = sheets.iter().position(|entry| entry.name == sheet.name).map_or(-1.0, |at| at as f64);
    let pattern = sheet_entry_pattern(&sheet.name);
    if !pattern.is_match(&zip.text(WORKBOOK_PATH)) {
        return Err(format!("Worksheet not found: {}", sheet.name));
    }
    rename_sheet_references(zip, sheets, sheet, None, "delete_sheet")?;
    let mut workbook = zip.text(WORKBOOK_PATH);
    let Some(found) = pattern.find(&workbook) else {
        return Err("Cannot read properties of null (reading 'index')".to_owned());
    };
    workbook = format!("{}{}", &workbook[..found.start], &workbook[found.end..]);
    workbook = upsert_defined_name(&workbook, None, |item| local_sheet_id(item) == Some(index));
    workbook = DEFINED_NAME.replace_all_with(&workbook, |found| {
        let item = found.get(0).unwrap_or("");
        match local_sheet_id(item) {
            Some(local) if local > index => {
                replace_first(&LOCAL_SHEET_ID, item, |_| format!("localSheetId=\"{}\"", number_to_string(local - 1.0)))
            }
            _ => item.to_owned(),
        }
    });
    zip.set(WORKBOOK_PATH, workbook);
    let rels = zip.text(WORKBOOK_RELATIONSHIPS);
    let relationship = compiled(&format!(r#"<Relationship\b[^>]*\bId="{}"[^>]*\/>"#, tag_pattern(&sheet.rid)), "");
    zip.set(WORKBOOK_RELATIONSHIPS, replace_first(&relationship, &rels, |_| String::new()));
    zip.remove(&sheet.path);
    let part_rels = part_relationship_path(&sheet.path);
    if zip.file(&part_rels).is_some() {
        zip.remove(&part_rels);
    }
    remove_content_type_override(zip, &format!("/{}", sheet.path));
    drop_calculation_chain(zip);
    Ok(json!({ "sheet": sheet.name }))
}

/// A printed sheet names its pages the way a PDF stamp does ({page} / {pages}) instead of Excel's field codes. An ampersand
/// opens a code, so the caller's own text is escaped first and the tokens become codes afterwards; without this a page number
/// could not be written at all on the portable backend.
fn header_footer_fields(text: &str) -> String {
    let mut written = text.replace('&', "&&");
    for (token, code) in [("page", "&P"), ("pages", "&N"), ("date", "&D"), ("time", "&T"), ("sheet", "&A"), ("file", "&F")] {
        written = compiled(&format!(r"\{{{token}\}}"), "gi").replace_all_with(&written, |_| code.to_owned());
    }
    written
}

/// Splits one story's string into its L/C/R slots. `&&` is the caller's own ampersand; `&L`/`&C`/`&R` open a slot and every
/// other code (`&P`, `&N`, `&D`) belongs to the slot being read.
fn header_footer_slots(current: &str) -> [String; 3] {
    let mut slots = [String::new(), String::new(), String::new()];
    let slot_of = |code: char| match code {
        'L' => Some(0),
        'C' => Some(1),
        'R' => Some(2),
        _ => None,
    };
    let mut reading = 1;
    let mut buffer = String::new();
    let chars: Vec<char> = current.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '&' && chars.get(index + 1) == Some(&'&') {
            buffer.push_str("&&");
            index += 2;
            continue;
        }
        if chars[index] == '&'
            && let Some(next) = chars.get(index + 1).copied().and_then(slot_of)
        {
            slots[reading] = std::mem::take(&mut buffer);
            reading = next;
            index += 2;
            continue;
        }
        buffer.push(chars[index]);
        index += 1;
    }
    slots[reading] = buffer;
    slots
}

fn header_footer_story_text(slots: &[String; 3]) -> String {
    let joined: String =
        ["L", "C", "R"].iter().zip(slots).filter(|(_, text)| !text.is_empty()).map(|(key, text)| format!("&{key}{text}")).collect();
    xml_encode(&joined)
}

/// `setWorksheetHeaderFooter(zip, sheet, xml, op)`: writes one slot of a sheet's header or footer, keeping the other slots and
/// the other story.
pub fn set_worksheet_header_footer(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Map<String, Value>) -> Result<Value, String> {
    let named = js_to_lowercase(&text_or_empty(op.get("kind")));
    if named != "header" && named != "footer" {
        return Err("set_header_footer kind must be header or footer".to_owned());
    }
    let alignment = if truthy(op.get("alignment")) { js_to_lowercase(&js_text(op.get("alignment"))) } else { "center".to_owned() };
    let slot = match alignment.as_str() {
        "left" => 0,
        "center" => 1,
        "right" => 2,
        _ => return Err("set_header_footer alignment must be left, center, or right".to_owned()),
    };
    let existing = worksheet_section(xml, "headerFooter").map_or("", |range| &xml[range]);
    let other = if named == "header" { &ODD_FOOTER } else { &ODD_HEADER };
    let kept = other.find(existing).map_or("", |range| &existing[range]);
    // Excel keeps all three slots of one story in a single string. Writing the whole element for one slot dropped the
    // others, so a sheet could carry a title or a page number but never both: only the named slot is replaced.
    let story = if named == "header" { "oddHeader" } else { "oddFooter" };
    let own = compiled(&format!(r"<{story}>([\s\S]*?)</{story}>"), "");
    let current = xml_decode(own.captures(existing).and_then(|found| found.get(1)).unwrap_or(""));
    let mut slots = header_footer_slots(&current);
    slots[slot] = header_footer_fields(&text_or_empty_nullish(op.get("text")));
    let written = format!("<{story}>{}</{story}>", header_footer_story_text(&slots));
    let element = if named == "header" {
        format!("<headerFooter>{written}{kept}</headerFooter>")
    } else {
        format!("<headerFooter>{kept}{written}</headerFooter>")
    };
    zip.set(&sheet.path, upsert_worksheet_section(xml, "headerFooter", &element));
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "kind": named, "alignment": alignment }))
}

/// `applyConditionalFormat(zip, sheet, xml, op)`: adds a conditional rule over a range, or removes the rules already on it.
pub fn apply_conditional_format(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Map<String, Value>) -> Result<Value, String> {
    let reference = area_reference(&parse_area_range(&text_or_empty(op.get("range")))?);
    if op.get("op").and_then(Value::as_str) == Some("delete_conditional_formats") {
        let pattern = compiled(
            &format!(r#"<conditionalFormatting\b[^>]*\bsqref="{}"[^>]*>[\s\S]*?<\/conditionalFormatting>"#, tag_pattern(&reference)),
            "g",
        );
        let next = pattern.replace_all_with(xml, |_| String::new());
        zip.set(&sheet.path, next.clone());
        return Ok(json!({ "op": op.get("op"), "changed": next != xml, "sheet": sheet.name, "range": reference }));
    }
    let priority = CF_PRIORITY.captures_iter(xml).map(|found| string_to_number(found.get(1).unwrap_or(""))).fold(0.0, f64::max) + 1.0;
    // A rule that paints the cells it picks needs a differential format; a scale or a bar paints every cell in the range by
    // its own value, so it carries its colors inside the rule and takes no formula.
    let kind = conditional_format_kind(&Value::Object(op.clone()))?;
    let rule = if kind == "expression" { expression_conditional_rule(zip, op, priority)? } else { conditional_scale_rule(kind, op, priority as u32) };
    zip.set(
        &sheet.path,
        append_worksheet_section(xml, "conditionalFormatting", &format!("<conditionalFormatting sqref=\"{reference}\">{rule}</conditionalFormatting>")),
    );
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "range": reference, "priority": json_number(priority), "type": kind }))
}

/// An expression rule's differential format lives in the styles part; the rule references it by id.
fn expression_conditional_rule(zip: &mut Package, op: &Map<String, Value>, priority: f64) -> Result<String, String> {
    let styles = zip.text("xl/styles.xml");
    if styles.is_empty() {
        return Err("Workbook is missing xl/styles.xml".to_owned());
    }
    let differential = append_differential_format(&styles, &text_or_empty_nullish(op.get("color")), &text_or_empty_nullish(op.get("fillColor")));
    zip.set("xl/styles.xml", differential.xml);
    let formula = LEADING_EQUALS.replace_all_with(&js_text(op.get("formula")), |_| String::new());
    Ok(format!(
        "<cfRule type=\"expression\" dxfId=\"{}\" priority=\"{}\"><formula>{}</formula></cfRule>",
        differential.id,
        number_to_string(priority),
        xml_encode(&formula)
    ))
}

fn validation_formula(value: &Value) -> String {
    xml_encode(&LEADING_EQUALS.replace_all_with(&value_to_string(value), |_| String::new()))
}

/// `addWorksheetValidation(zip, sheet, xml, op)`: one data validation over a range, appended to the validations already there.
pub fn add_worksheet_validation(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Map<String, Value>) -> Result<Value, String> {
    let reference = area_reference(&parse_area_range(&text_or_empty(op.get("range")))?);
    let rule = normalize_xlsx_validation(op)?;
    let operator = rule.operator.unwrap_or("");
    let previous = worksheet_section(xml, "dataValidations").map(|range| container_body(&xml[range], "dataValidations")).unwrap_or_default();
    let count = VALIDATION_OPEN.find_iter(&previous).count() + 1;
    let message = |key: &str, attribute: &str| {
        if truthy(op.get(key)) { format!(" {attribute}=\"{}\"", xml_encode(&js_text(op.get(key)))) } else { String::new() }
    };
    let formula1 = op.get("formula1").unwrap_or(&Value::Null);
    let first = if rule.kind == "list" { xml_encode(&list_validation_choices(formula1)) } else { validation_formula(formula1) };
    let second = match op.get("formula2") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) if text.is_empty() => String::new(),
        Some(value) => format!("<formula2>{}</formula2>", validation_formula(value)),
    };
    let validation = format!(
        "<dataValidation type=\"{}\"{} allowBlank=\"1\" showInputMessage=\"1\" showErrorMessage=\"1\"{}{} sqref=\"{reference}\"><formula1>{first}</formula1>{second}</dataValidation>",
        rule.kind,
        if operator.is_empty() { String::new() } else { format!(" operator=\"{operator}\"") },
        message("inputMessage", "prompt"),
        message("errorMessage", "error"),
    );
    zip.set(
        &sheet.path,
        upsert_worksheet_section(xml, "dataValidations", &format!("<dataValidations count=\"{count}\">{previous}{validation}</dataValidations>")),
    );
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert("range".to_owned(), json!(reference));
    result.insert("type".to_owned(), json!(rule.kind));
    if !operator.is_empty() {
        result.insert("operator".to_owned(), json!(operator));
    }
    Ok(Value::Object(result))
}
