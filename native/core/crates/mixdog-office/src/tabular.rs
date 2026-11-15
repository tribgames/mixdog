//! The CSV and TSV backend: a delimited file read as a one-sheet workbook. Ported from `core/tabular.mjs` (and the
//! `csvCell` of `core/office-actions-read.mjs`).
//!
//! The file is parsed and written here, not by the `csv` crate: its quoting and byte-order-mark behaviour differ from
//! what the files the tool already wrote look like. A parse follows RFC 4180 as far as the old one did (a quote opens
//! a quoted field only at the start of a field; `CRLF`, `LF` and `CR` end a row; a missing final newline is fine); a
//! write ends every row with `CRLF` and quotes a field holding a quote, a line break or the delimiter. An edit keeps
//! the byte-order mark the file arrived with, and an empty file whose first edit leaves ASCII gets one (Korean Excel
//! reads a UTF-8 file without it as CP949).
//!
//! Operations, options and results are JSON values: they are the tool's arguments and answers, and the JavaScript
//! coercions of their fields (`String(value)`, `Number(count ?? 1)`, `splice`'s clamping) are kept, including the
//! messages of the errors a malformed operation made. Every write goes through the [`WriteNote`] first.

use std::cmp::Ordering;
use std::io;
use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{js_to_lowercase, js_trim, json_number, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::a1::{
    XLSX_MAX_COLUMNS, XLSX_MAX_RANGE_CELLS, XlsxCell, XlsxRange, column_label, parse_xlsx_cell, parse_xlsx_range,
};
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use serde_json::{Value, json};

/// The widest sheet a validation accepts.
const MAX_COLUMNS: usize = XLSX_MAX_COLUMNS as usize;

/// `Array.from({ length })` refuses a length above 2^32 - 1.
const ARRAY_LENGTH_LIMIT: f64 = 4_294_967_295.0;

const BYTE_ORDER_MARK: char = '\u{FEFF}';

/// The two delimited formats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Csv,
    Tsv,
}

impl Format {
    /// `csv` or `tsv`.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "csv" => Some(Self::Csv),
            "tsv" => Some(Self::Tsv),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Tsv => "tsv",
        }
    }

    fn upper(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Tsv => "TSV",
        }
    }

    fn delimiter(self) -> char {
        match self {
            Self::Csv => ',',
            Self::Tsv => '\t',
        }
    }
}

type Rows = Vec<Vec<String>>;

/// `sheetName`: the file's name without its extension and without the `.mixdog-edit` an edit's working copy carries
/// (the caller is answered with the file they handed over, not the copy); the format's name when nothing is left.
fn sheet_name(path: &Path, format: Format) -> String {
    let full = path.to_string_lossy();
    let separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let mut text: &str = &full;
    if cfg!(windows) && text.len() >= 2 && text.as_bytes()[0].is_ascii_alphabetic() && text.as_bytes()[1] == b':' {
        text = &text[2..];
    }
    let trimmed = text.trim_end_matches(separator);
    let base = trimmed.rsplit(separator).next().unwrap_or("");
    // Node's `extname` of the base name: from the last dot, unless that dot starts the name or the name is `..`.
    let extension = match base.rfind('.') {
        Some(0) | None => "",
        Some(_) if base == ".." => "",
        Some(dot) => &base[dot..],
    };
    let stem = if !extension.is_empty() && base != extension { &base[..base.len() - extension.len()] } else { base };
    const EDIT: &str = ".mixdog-edit";
    let stem = match stem.len().checked_sub(EDIT.len()) {
        Some(at) if stem.is_char_boundary(at) && stem[at..].eq_ignore_ascii_case(EDIT) => &stem[..at],
        _ => stem,
    };
    if stem.is_empty() { format.upper().to_owned() } else { stem.to_owned() }
}

/// `parseDelimited`: the rows of a delimited text, its byte-order mark dropped.
fn parse_delimited(text: &str, delimiter: char) -> Rows {
    let source: Vec<char> = text.strip_prefix(BYTE_ORDER_MARK).unwrap_or(text).chars().collect();
    if source.is_empty() {
        return Vec::new();
    }
    let mut rows: Rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut index = 0;
    while index < source.len() {
        let character = source[index];
        if quoted {
            if character == '"' && source.get(index + 1) == Some(&'"') {
                field.push('"');
                index += 1;
            } else if character == '"' {
                quoted = false;
            } else {
                field.push(character);
            }
        } else if character == '"' && field.is_empty() {
            quoted = true;
        } else if character == delimiter {
            row.push(std::mem::take(&mut field));
        } else if character == '\r' || character == '\n' {
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            if character == '\r' && source.get(index + 1) == Some(&'\n') {
                index += 1;
            }
        } else {
            field.push(character);
        }
        index += 1;
    }
    let ends_with_break = matches!(source.last(), Some('\r' | '\n'));
    if !field.is_empty() || !row.is_empty() || !ends_with_break {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn serialize_field(value: &str, delimiter: char) -> String {
    if value.contains(['"', '\r', '\n']) || value.contains(delimiter) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// `serializeDelimited`: every row ends with `CRLF`; no rows is an empty text.
fn serialize_delimited(rows: &[Vec<String>], delimiter: char) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let separator = delimiter.to_string();
    let lines: Vec<String> = rows
        .iter()
        .map(|row| row.iter().map(|value| serialize_field(value, delimiter)).collect::<Vec<_>>().join(&separator))
        .collect();
    format!("{}\r\n", lines.join("\r\n"))
}

/// `csvCell`: a value as one field of a comma-separated line (RFC 4180 quoting).
pub fn csv_cell(text: &str) -> String {
    serialize_field(text, ',')
}

/// A message in the form Node gave a failed file call: `CODE: description, syscall 'path'`.
fn io_message(error: &io::Error, syscall: &str, path: &Path) -> String {
    let shown = path.display();
    match error.kind() {
        io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, {syscall} '{shown}'"),
        io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, {syscall} '{shown}'"),
        io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".to_owned(),
        _ => format!("{error}, {syscall} '{shown}'"),
    }
}

/// The file's text, decoded as UTF-8 (an invalid sequence becomes U+FFFD, as `readFile(path, 'utf8')` does).
fn read_text<P: ReadProof>(proof: &P, path: &Path) -> Result<String, String> {
    let bytes = mixdog_fsio::read(proof, path).map_err(|error| io_message(&error, "open", path))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A delimited file as read for an edit.
struct Delimited {
    rows: Rows,
    /// The file began with a byte-order mark.
    byte_order_mark: bool,
    /// The file had no text at all.
    empty: bool,
}

fn read_delimited<P: ReadProof>(proof: &P, path: &Path, format: Format) -> Result<Delimited, String> {
    let text = read_text(proof, path)?;
    Ok(Delimited {
        rows: parse_delimited(&text, format.delimiter()),
        byte_order_mark: text.starts_with(BYTE_ORDER_MARK),
        empty: text.is_empty(),
    })
}

/// A new file whose text leaves ASCII takes the mark; an all-ASCII one stays plain for the tools that trip on it.
fn leaves_ascii(rows: &[Vec<String>]) -> bool {
    rows.iter().any(|row| row.iter().any(|value| !value.is_ascii()))
}

fn save_rows<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    format: Format,
    rows: &[Vec<String>],
    byte_order_mark: bool,
) -> Result<(), String> {
    let body = serialize_delimited(rows, format.delimiter());
    let text = if byte_order_mark { format!("{BYTE_ORDER_MARK}{body}") } else { body };
    note.note_write(path);
    mixdog_fsio::write(proof, path, text.as_bytes()).map_err(|error| io_message(&error, "open", path))
}

/// `createTabular`: an empty file.
pub fn create<P: WriteProof>(proof: &P, note: &dyn WriteNote, path: &Path) -> Result<(), String> {
    note.note_write(path);
    mixdog_fsio::write(proof, path, b"").map_err(|error| io_message(&error, "open", path))
}

// ---- JavaScript coercions of the fields of an operation -------------------------------------------------------

/// `value == null ? '' : String(value)`.
fn cell_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `String(value || '')`.
fn truthy_text(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => value_to_string(value),
        _ => String::new(),
    }
}

/// `${value}`: an absent value is `undefined`.
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `target[index]`; `Err` where JavaScript throws (reading a property of `undefined` or `null`).
fn index_of(target: Option<&Value>, index: usize) -> Result<Option<Value>, String> {
    match target {
        None => Err(format!("Cannot read properties of undefined (reading '{index}')")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{index}')")),
        Some(Value::Array(items)) => Ok(items.get(index).cloned()),
        Some(Value::String(text)) => {
            Ok(text.encode_utf16().nth(index).map(|unit| Value::String(String::from_utf16_lossy(&[unit]))))
        }
        Some(Value::Object(map)) => Ok(map.get(&index.to_string()).cloned()),
        Some(_) => Ok(None),
    }
}

/// `parseXlsxCell(reference)`; an absent or falsy reference is named as itself in the message.
fn xlsx_cell(reference: Option<&Value>) -> Result<XlsxCell, String> {
    let text = truthy_text(reference);
    parse_xlsx_cell(&text).map_err(|message| {
        if text.is_empty() { format!("Invalid XLSX cell reference: {}", shown(reference)) } else { message }
    })
}

fn xlsx_range(reference: Option<&Value>, max_cells: usize) -> Result<XlsxRange, String> {
    let text = truthy_text(reference);
    parse_xlsx_range(&text, max_cells).map_err(|message| {
        if text.is_empty() { format!("Invalid XLSX range: {}", shown(reference)) } else { message }
    })
}

/// `Number(value ?? default)`.
fn number_or(value: Option<&Value>, default: f64) -> f64 {
    match value {
        None | Some(Value::Null) => default,
        value => to_number_of(value),
    }
}

/// The start index `splice` makes of its first argument.
fn splice_start(length: usize, start: f64) -> usize {
    let relative = if start.is_nan() { 0.0 } else { start.trunc() };
    if relative < 0.0 { (length as f64 + relative).max(0.0) as usize } else { relative.min(length as f64) as usize }
}

/// The number of items `splice` removes from `start` for its second argument.
fn splice_count(length: usize, start: usize, count: f64) -> usize {
    let count = if count.is_nan() { 0.0 } else { count.trunc() };
    count.clamp(0.0, (length - start) as f64) as usize
}

/// Array.from's ToLength and ordinary Array length bound. V8's incidental
/// argument-stack limit is not a stable data limit and must not reject counts
/// the old backend handled. Actual insertion uses a fallible heap reservation.
fn insertion_length(count: f64) -> Result<usize, String> {
    let length = if count.is_nan() { 0.0 } else { count.trunc() };
    if length <= 0.0 {
        return Ok(0);
    }
    if length > ARRAY_LENGTH_LIMIT {
        return Err("Invalid array length".to_owned());
    }
    Ok(length as usize)
}

/// Append empty entries after reserving the complete capacity, then rotate the
/// old suffix into place. No argument spread, intermediate collection or repeated
/// middle insertion is needed. Failure occurs before changing this vector.
fn insert_empty<T: Default>(values: &mut Vec<T>, start: usize, count: usize) -> Result<(), String> {
    values.try_reserve(count).map_err(|_| "Invalid array length".to_owned())?;
    let length = values.len() + count; // try_reserve checked capacity overflow.
    values.resize_with(length, T::default);
    values[start..].rotate_right(count);
    Ok(())
}

// ---- cells -----------------------------------------------------------------------------------------------------

fn set_cell(rows: &mut Rows, row: u32, column: u32, value: String) {
    let (row, column) = (row as usize, column as usize);
    while rows.len() < row {
        rows.push(Vec::new());
    }
    while rows[row - 1].len() < column {
        rows[row - 1].push(String::new());
    }
    rows[row - 1][column - 1] = value;
}

/// The A1 bounds of an options' `range`, none when it is absent or empty.
fn bounds_of(range: Option<&Value>) -> Result<Option<XlsxRange>, String> {
    match range {
        Some(value) if truthy(value) => xlsx_range(Some(value), usize::MAX).map(Some),
        _ => Ok(None),
    }
}

/// True when a zero-based cell falls outside a requested A1 range.
fn outside_bounds(bounds: Option<&XlsxRange>, row: usize, column: usize) -> bool {
    bounds.is_some_and(|bounds| {
        row + 1 < bounds.start.row as usize
            || row + 1 > bounds.end.row as usize
            || column + 1 < bounds.start.column as usize
            || column + 1 > bounds.end.column as usize
    })
}

fn cell_ref(row: usize, column: usize) -> String {
    format!("{}{}", column_label((column + 1) as f64), row + 1)
}

// ---- snapshot ----------------------------------------------------------------------------------------------------

/// `snapshotTabular`: the file as one sheet of populated cells. `options` is the tool's object: `sheet` (must name
/// the file's sheet), `range` (A1), and `paged: true` with `offset` and `limit` for a page of populated cells.
/// Pass an empty object for omitted Node options; explicit null remains a TypeError.
pub fn snapshot<P: ReadProof>(proof: &P, path: &Path, format: Format, options: &Value) -> Result<Value, String> {
    let rows = read_delimited(proof, path, format)?.rows;
    snapshot_rows(path, format, &rows, options)
}

fn snapshot_rows(path: &Path, format: Format, rows: &Rows, options: &Value) -> Result<Value, String> {
    let name = sheet_name(path, format);
    if options.is_null() { return Err("Cannot read properties of null (reading 'sheet')".to_owned()); }
    if let Some(sheet) = options.get("sheet").filter(|sheet| truthy(sheet)) {
        if js_to_lowercase(&value_to_string(sheet)) != js_to_lowercase(&name) {
            return Err(format!("{} sheet not found: {}", format.upper(), value_to_string(sheet)));
        }
    }
    let paged = options.get("paged") == Some(&Value::Bool(true));
    // `Number(x) || default`
    let or_default = |value: f64, default: f64| if value.is_nan() || value == 0.0 { default } else { value };
    let offset = if paged { or_default(to_number_of(options.get("offset")), 0.0).max(0.0) } else { 0.0 };
    let limit = if paged { or_default(to_number_of(options.get("limit")), 2_000.0).max(1.0) } else { f64::INFINITY };
    let range = options.get("range");
    let bounds = bounds_of(range)?;
    let mut cells: Vec<Value> = Vec::new();
    let mut total_cells = 0_usize;
    let mut columns = 0_usize;
    for (row, values) in rows.iter().enumerate() {
        columns = columns.max(values.len());
        for (column, value) in values.iter().enumerate() {
            if value.is_empty() || outside_bounds(bounds.as_ref(), row, column) {
                continue;
            }
            if !paged || (total_cells as f64 >= offset && (cells.len() as f64) < limit) {
                let reference = cell_ref(row, column);
                let mut cell = json!({
                    "path": format!("/sheet[{name}]/cell[{reference}]"),
                    "ref": reference,
                    "row": row + 1,
                    "column": column + 1,
                    "value": value,
                });
                // A plain value carries no formula field: an empty one on every cell of a sheet was noise in each read.
                if value.starts_with('=') {
                    cell["formula"] = json!(value);
                }
                cells.push(cell);
            }
            total_cells += 1;
        }
    }
    let returned = cells.len();
    let mut snapshot = json!({
        "format": format.name(),
        "path": path.to_string_lossy(),
        "delimiter": format.delimiter().to_string(),
        "sheetCount": 1,
        "sheets": [{
            "path": format!("/sheet[{name}]"),
            "name": name,
            "rows": rows.len(),
            "columns": columns,
            "cellCount": total_cells,
            "cells": cells,
        }],
    });
    if paged {
        let suffix = range
            .filter(|range| truthy(range))
            .map_or_else(String::new, |range| format!("!{}", value_to_string(range)));
        let next = offset + returned as f64;
        snapshot["pagination"] = json!({
            "unit": "populated-cell",
            "scope": format!("{name}{suffix}"),
            "offset": json_number(offset),
            "limit": json_number(limit),
            "returned": returned,
            "total": total_cells,
            "nextOffset": if next < total_cells as f64 { json_number(next) } else { Value::Null },
        });
    }
    Ok(snapshot)
}

// ---- operations --------------------------------------------------------------------------------------------------

/// `applyTabularBatch`: the operations in order on the file's rows, then one write. An operation that fails stops the
/// batch before anything is written. Each operation's answer is in the result, in order.
pub fn apply_batch<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    format: Format,
    operations: &[Value],
) -> Result<Vec<Value>, String> {
    let Delimited { mut rows, byte_order_mark, empty } = read_delimited(proof, path, format)?;
    let mut results = Vec::with_capacity(operations.len());
    for operation in operations {
        results.push(apply_operation(&mut rows, format, operation)?);
    }
    save_rows(proof, note, path, format, &rows, byte_order_mark || (empty && leaves_ascii(&rows)))?;
    Ok(results)
}

fn apply_operation(rows: &mut Rows, format: Format, operation: &Value) -> Result<Value, String> {
    if operation.is_null() {
        return Err("Cannot read properties of null (reading 'op')".to_owned());
    }
    let field = |key: &str| operation.get(key);
    let op = truthy_text(field("op"));
    match op.as_str() {
        "set_cell" | "set_formula" => {
            let cell = xlsx_cell(field("cell"))?;
            let value = cell_text(field(if op == "set_formula" { "formula" } else { "value" }));
            set_cell(rows, cell.row, cell.column, value);
            Ok(json!({ "op": op, "changed": true, "cell": cell.reference }))
        }
        "set_range" => {
            let area = xlsx_range(field("range"), XLSX_MAX_RANGE_CELLS)?;
            for row in 0..area.rows as usize {
                let values = index_of(field("values"), row)?;
                for column in 0..area.columns as usize {
                    let value = cell_text(index_of(values.as_ref(), column)?.as_ref());
                    set_cell(rows, area.start.row + row as u32, area.start.column + column as u32, value);
                }
            }
            Ok(json!({ "op": op, "changed": true, "range": field("range").cloned().unwrap_or(Value::Null) }))
        }
        "append_row" => {
            let values = match field("values") {
                Some(Value::Array(items)) => items.iter().map(|value| cell_text(Some(value))).collect(),
                Some(other) if truthy(other) => return Err("(operation.values || []).map is not a function".to_owned()),
                _ => Vec::new(),
            };
            rows.push(values);
            Ok(json!({ "op": op, "changed": true, "row": rows.len() }))
        }
        "clear_cell" => {
            let cell = xlsx_cell(field("cell"))?;
            let (row, column) = (cell.row as usize, cell.column as usize);
            let changed = row <= rows.len() && column <= rows[row - 1].len() && !rows[row - 1][column - 1].is_empty();
            if changed {
                rows[row - 1][column - 1].clear();
            }
            Ok(json!({ "op": op, "changed": changed, "cell": cell.reference }))
        }
        "replace_text" => {
            let find = truthy_text(field("find"));
            let replacement = cell_text(field("replace"));
            let mut count = 0_usize;
            if !find.is_empty() {
                for value in rows.iter_mut().flatten() {
                    let found = value.matches(&find).count();
                    if found > 0 {
                        count += found;
                        *value = value.replace(&find, &replacement);
                    }
                }
            }
            Ok(json!({ "op": op, "changed": count > 0, "count": count }))
        }
        "insert_rows" => {
            let row = to_number_of(field("row"));
            let count = number_or(field("count"), 1.0);
            let start = splice_start(rows.len(), row - 1.0);
            let added = insertion_length(count)?;
            insert_empty(rows, start, added)?;
            Ok(json!({ "op": op, "changed": true, "row": json_number(row), "count": json_number(count) }))
        }
        "delete_rows" => {
            let row = to_number_of(field("row"));
            let count = number_or(field("count"), 1.0);
            let start = splice_start(rows.len(), row - 1.0);
            let end = start + splice_count(rows.len(), start, count);
            let removed = rows.drain(start..end).count();
            Ok(json!({ "op": op, "changed": removed > 0, "row": json_number(row), "count": removed }))
        }
        "insert_columns" | "delete_columns" => {
            let column = to_number_of(field("column")) - 1.0;
            let count = number_or(field("count"), 1.0);
            for row in rows.iter_mut() {
                let start = splice_start(row.len(), column);
                if op == "insert_columns" {
                    let added = insertion_length(count)?;
                    insert_empty(row, start, added)?;
                } else {
                    let end = start + splice_count(row.len(), start, count);
                    row.drain(start..end);
                }
            }
            Ok(json!({ "op": op, "changed": true, "column": json_number(column + 1.0), "count": json_number(count) }))
        }
        _ => Err(format!("{} backend does not support operation: {op}", format.upper())),
    }
}

// ---- validation --------------------------------------------------------------------------------------------------

struct Structure {
    ok: bool,
    rows: usize,
    columns: usize,
    invalid_encoding: bool,
    nul_bytes: usize,
}

fn delimited_structure(text: &str, rows: &Rows) -> Structure {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let invalid_encoding = text.contains('\u{FFFD}');
    let nul_bytes = text.matches('\0').count();
    Structure {
        ok: !invalid_encoding && nul_bytes == 0 && columns <= MAX_COLUMNS,
        rows: rows.len(),
        columns,
        invalid_encoding,
        nul_bytes,
    }
}

/// `validateTabular`: whether the file is valid UTF-8 without NUL characters and no wider than a sheet.
pub fn validate<P: ReadProof>(proof: &P, path: &Path, format: Format) -> Result<Value, String> {
    let text = read_text(proof, path)?;
    let structure = delimited_structure(&text, &parse_delimited(&text, format.delimiter()));
    Ok(json!({
        "ok": structure.ok,
        "format": format.name(),
        "rows": structure.rows,
        "columns": structure.columns,
        "invalidEncoding": structure.invalid_encoding,
        "nulBytes": structure.nul_bytes,
        "validation": "utf8-delimited-structure",
    }))
}

/// The width the file's rows agree on: the most common one; a tie goes to the first row's width, then the wider.
fn expected_columns(widths: &[usize]) -> usize {
    let mut tally: Vec<(usize, usize)> = Vec::new();
    for width in widths {
        match tally.iter_mut().find(|(seen, _)| seen == width) {
            Some((_, count)) => *count += 1,
            None => tally.push((*width, 1)),
        }
    }
    let first = widths.first().copied();
    tally.sort_by(|left, right| {
        right.1.cmp(&left.1).then_with(|| {
            if Some(left.0) == first {
                Ordering::Less
            } else if Some(right.0) == first {
                Ordering::Greater
            } else {
                right.0.cmp(&left.0)
            }
        })
    });
    tally.first().map_or(0, |(width, _)| *width)
}

/// `issuesTabular`: ragged rows, values a spreadsheet would run as a formula, invalid UTF-8 and NUL characters.
/// `options.range` limits the formula-like check to an A1 range.
pub fn issues<P: ReadProof>(proof: &P, path: &Path, format: Format, options: &Value) -> Result<Value, String> {
    let text = read_text(proof, path)?;
    let rows = parse_delimited(&text, format.delimiter());
    if options.is_null() { return Err("Cannot read properties of null (reading 'range')".to_owned()); }
    let bounds = bounds_of(options.get("range"))?;
    let widths: Vec<usize> = rows.iter().map(Vec::len).collect();
    // The file's shape is the width its rows agree on, not the widest row it holds: measured against the maximum, one
    // row with an extra separator made every well-formed row, the header included, read as broken.
    let expected = expected_columns(&widths);
    let mut found: Vec<Value> = Vec::new();
    for (row, values) in rows.iter().enumerate() {
        if values.len() != expected {
            let extra = if values.len() > expected {
                " An unquoted separator inside a value splits it into an extra column."
            } else {
                ""
            };
            found.push(json!({
                "severity": "warning",
                "code": "ragged_row",
                "path": format!("/row[{}]", row + 1),
                "message": format!("Row has {} column(s); the file's rows are {expected} wide.{extra}", values.len()),
            }));
        }
        for (column, value) in values.iter().enumerate() {
            if outside_bounds(bounds.as_ref(), row, column) {
                continue;
            }
            // A leading =, +, - or @ is how a spreadsheet is tricked into evaluating a pasted value, but a negative
            // figure starts the same way, and reporting every one of them buries the one cell that carries a formula.
            let raw = js_trim(value);
            if raw.starts_with(['=', '+', '-', '@']) && !string_to_number(raw).is_finite() {
                found.push(json!({
                    "severity": "warning",
                    "code": "formula_like_value",
                    "path": format!("/sheet[{}]/cell[{}]", sheet_name(path, format), cell_ref(row, column)),
                    "message": "Value may execute as a formula when opened by spreadsheet software.",
                }));
            }
        }
    }
    let structure = delimited_structure(&text, &rows);
    if structure.invalid_encoding {
        found.push(json!({
            "severity": "error",
            "code": "invalid_utf8",
            "path": "/",
            "message": "File contains invalid UTF-8 replacement characters.",
        }));
    }
    if structure.nul_bytes > 0 {
        found.push(json!({
            "severity": "error",
            "code": "nul_byte",
            "path": "/",
            "message": format!("File contains {} NUL byte(s).", structure.nul_bytes),
        }));
    }
    let has_error = found.iter().any(|issue| issue["severity"] == "error");
    Ok(json!({
        "ok": structure.ok && !has_error,
        "format": format.name(),
        "issueCount": found.len(),
        "issues": found,
    }))
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;
    use serde_json::json;

    use super::*;

    fn rows(text: &str) -> Rows {
        parse_delimited(text, ',')
    }

    fn strings(items: &[&[&str]]) -> Rows {
        items.iter().map(|row| row.iter().map(|value| (*value).to_owned()).collect()).collect()
    }

    #[test]
    fn rows_end_with_crlf_lf_or_cr() {
        assert_eq!(rows("a,b\r\nc,d\r\n"), strings(&[&["a", "b"], &["c", "d"]]));
        assert_eq!(rows("a,b\nc,d"), strings(&[&["a", "b"], &["c", "d"]]));
        assert_eq!(rows("a\rb\r"), strings(&[&["a"], &["b"]]));
        assert_eq!(rows("a\n\nb"), strings(&[&["a"], &[""], &["b"]]));
        assert_eq!(rows(""), Rows::new());
        assert_eq!(rows("\u{FEFF}"), Rows::new());
        assert_eq!(rows("\n"), strings(&[&[""]]));
    }

    #[test]
    fn quotes_open_only_at_the_start_of_a_field() {
        assert_eq!(rows("\"a,b\",c"), strings(&[&["a,b", "c"]]));
        assert_eq!(rows("\"say \"\"hi\"\"\",x"), strings(&[&["say \"hi\"", "x"]]));
        assert_eq!(rows("a\"b,c"), strings(&[&["a\"b", "c"]]));
        assert_eq!(rows("\"line\nbreak\",x\n"), strings(&[&["line\nbreak", "x"]]));
        assert_eq!(rows("\"\""), strings(&[&[""]]));
        assert_eq!(rows("\"open,x\n"), strings(&[&["open,x\n"]]));
    }

    #[test]
    fn a_write_quotes_and_ends_rows_with_crlf() {
        let table = strings(&[&["a", "b,c"], &["say \"hi\"", "x\ny"]]);
        assert_eq!(serialize_delimited(&table, ','), "a,\"b,c\"\r\n\"say \"\"hi\"\"\",\"x\ny\"\r\n");
        assert_eq!(serialize_delimited(&strings(&[&["a\tb", "c,d"]]), '\t'), "\"a\tb\"\tc,d\r\n");
        assert_eq!(serialize_delimited(&Rows::new(), ','), "");
        assert_eq!(serialize_delimited(&strings(&[&[]]), ','), "\r\n");
    }

    #[test]
    fn a_pdf_table_cell_follows_rfc_4180() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn the_sheet_is_named_for_the_file() {
        let name = |path: &str, format| sheet_name(Path::new(path), format);
        assert_eq!(name("dir/sales.csv", Format::Csv), "sales");
        assert_eq!(name("dir/sales.mixdog-edit.csv", Format::Csv), "sales");
        assert_eq!(name("dir/Sales.MIXDOG-EDIT.tsv", Format::Tsv), "Sales");
        assert_eq!(name("dir/.csv", Format::Csv), ".csv");
        assert_eq!(name("dir/.mixdog-edit.csv", Format::Csv), "CSV");
        assert_eq!(name("dir/a.b.tsv", Format::Tsv), "a.b");
        assert_eq!(name("noext", Format::Tsv), "noext");
        assert_eq!(name("", Format::Tsv), "TSV");
    }

    #[test]
    fn splice_arguments_clamp_as_javascript_does() {
        assert_eq!(splice_start(3, f64::NAN), 0);
        assert_eq!(splice_start(3, -1.0), 2);
        assert_eq!(splice_start(3, -9.0), 0);
        assert_eq!(splice_start(3, 9.0), 3);
        assert_eq!(splice_start(3, 1.9), 1);
        assert_eq!(splice_count(3, 1, f64::NAN), 0);
        assert_eq!(splice_count(3, 1, 9.0), 2);
        assert_eq!(splice_count(3, 1, -2.0), 0);
        assert_eq!(insertion_length(f64::INFINITY), Err("Invalid array length".to_owned()));
        assert_eq!(insertion_length(-3.0), Ok(0));
    }

    #[test]
    fn the_expected_width_is_the_most_common_one() {
        assert_eq!(expected_columns(&[]), 0);
        assert_eq!(expected_columns(&[2, 3, 3]), 3);
        assert_eq!(expected_columns(&[2, 3]), 2);
        assert_eq!(expected_columns(&[3, 2]), 3);
        assert_eq!(expected_columns(&[1, 2, 3, 2, 3]), 3);
    }

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        mixdog_fsio::write(&Unlaned, &path, bytes).expect("write fixture");
        path
    }

    fn bytes(path: &Path) -> Vec<u8> {
        mixdog_fsio::read(&Unlaned, path).expect("read back")
    }

    fn apply(path: &Path, operations: Value) -> Result<Vec<Value>, String> {
        let operations = operations.as_array().expect("operations").clone();
        apply_batch(&Unlaned, &NoWriteNote, path, Format::Csv, &operations)
    }

    #[test]
    fn an_edit_keeps_the_byte_order_mark_and_ends_rows_with_crlf() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"\xEF\xBB\xBFname,qty\nfoo,1\n");
        let results = apply(&path, json!([{ "op": "set_cell", "cell": "b2", "value": 7 }])).expect("applies");
        assert_eq!(results, [json!({ "op": "set_cell", "changed": true, "cell": "B2" })]);
        assert_eq!(bytes(&path), b"\xEF\xBB\xBFname,qty\r\nfoo,7\r\n");
    }

    #[test]
    fn a_new_file_takes_a_mark_only_when_its_text_leaves_ascii() {
        let dir = dir();
        let plain = file(&dir, "plain.csv", b"");
        apply(&plain, json!([{ "op": "append_row", "values": ["a", 1, null] }])).expect("applies");
        assert_eq!(bytes(&plain), b"a,1,\r\n");
        let korean = file(&dir, "korean.csv", b"");
        apply(&korean, json!([{ "op": "append_row", "values": ["가"] }])).expect("applies");
        assert_eq!(bytes(&korean), "\u{FEFF}가\r\n".as_bytes());
        apply(&korean, json!([{ "op": "append_row", "values": ["b"] }])).expect("applies");
        assert_eq!(bytes(&korean), "\u{FEFF}가\r\nb\r\n".as_bytes());
        let created = dir.path().join("made.csv");
        create(&Unlaned, &NoWriteNote, &created).expect("created");
        assert_eq!(bytes(&created), b"");
    }

    #[test]
    fn rows_and_columns_are_inserted_and_deleted() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"a,b,c\r\n1,2,3\r\n4,5,6\r\n");
        let results = apply(
            &path,
            json!([
                { "op": "insert_rows", "row": 2 },
                { "op": "delete_rows", "row": 4, "count": 9 },
                { "op": "insert_columns", "column": 2, "count": 2 },
                { "op": "delete_columns", "column": 1 },
                { "op": "delete_rows", "row": 9 },
            ]),
        )
        .expect("applies");
        assert_eq!(results[0], json!({ "op": "insert_rows", "changed": true, "row": 2, "count": 1 }));
        assert_eq!(results[1], json!({ "op": "delete_rows", "changed": true, "row": 4, "count": 1 }));
        assert_eq!(results[2], json!({ "op": "insert_columns", "changed": true, "column": 2, "count": 2 }));
        assert_eq!(results[4], json!({ "op": "delete_rows", "changed": false, "row": 9, "count": 0 }));
        assert_eq!(bytes(&path), b",,b,c\r\n\r\n,,2,3\r\n");
    }

    #[test]
    fn replace_text_counts_every_occurrence() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"aaa,b\r\nca,d\r\n");
        let results = apply(
            &path,
            json!([{ "op": "replace_text", "find": "a", "replace": "x" }, { "op": "replace_text", "find": "" }]),
        )
        .expect("applies");
        assert_eq!(results[0], json!({ "op": "replace_text", "changed": true, "count": 4 }));
        assert_eq!(results[1], json!({ "op": "replace_text", "changed": false, "count": 0 }));
        assert_eq!(bytes(&path), b"xxx,b\r\ncx,d\r\n");
    }

    #[test]
    fn a_failing_operation_leaves_the_file_as_it_was() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"a,b\r\n");
        let before = bytes(&path);
        let message = |operations: Value| apply(&path, operations).expect_err("fails");
        assert_eq!(
            message(json!([{ "op": "set_cell", "cell": "A1", "value": "x" }, { "op": "merge" }])),
            "CSV backend does not support operation: merge"
        );
        assert_eq!(message(json!([{ "op": "set_cell", "value": "x" }])), "Invalid XLSX cell reference: undefined");
        assert_eq!(
            message(json!([{ "op": "set_range", "range": "A1:B2" }])),
            "Cannot read properties of undefined (reading '0')"
        );
        assert_eq!(
            message(json!([{ "op": "append_row", "values": "x" }])),
            "(operation.values || []).map is not a function"
        );
        assert_eq!(message(json!([null])), "Cannot read properties of null (reading 'op')");
        assert_eq!(bytes(&path), before);
    }

    #[test]
    fn a_snapshot_lists_the_populated_cells_and_pages_them() {
        let dir = dir();
        let path = file(&dir, "sales.mixdog-edit.csv", b"a,=1+1\r\n,c\r\n");
        let all = snapshot(&Unlaned, &path, Format::Csv, &json!({})).expect("snapshot");
        let sheet = &all["sheets"][0];
        assert_eq!(sheet["name"], "sales");
        assert_eq!((sheet["rows"].as_u64(), sheet["columns"].as_u64(), sheet["cellCount"].as_u64()), (Some(2), Some(2), Some(3)));
        assert_eq!(sheet["cells"][1]["formula"], "=1+1");
        assert!(sheet["cells"][0].get("formula").is_none());
        assert!(all.get("pagination").is_none());
        let paging = json!({ "paged": true, "offset": 1, "limit": 1, "sheet": "SALES" });
        let page = snapshot(&Unlaned, &path, Format::Csv, &paging).expect("page");
        assert_eq!(page["pagination"]["nextOffset"], 2);
        assert_eq!(page["sheets"][0]["cells"][0]["ref"], "B1");
        let ranged = snapshot(&Unlaned, &path, Format::Csv, &json!({ "range": "B1:B2", "paged": true })).expect("range");
        assert_eq!(ranged["pagination"]["scope"], "sales!B1:B2");
        assert_eq!(ranged["pagination"]["total"], 2);
        assert_eq!(ranged["pagination"]["nextOffset"], Value::Null);
        let other = snapshot(&Unlaned, &path, Format::Csv, &json!({ "sheet": "other" }));
        assert_eq!(other.expect_err("sheet"), "CSV sheet not found: other");
    }

    #[test]
    fn issues_report_the_odd_row_out_and_formula_like_values() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"h1,h2\r\n1,-5\r\n2,3,4\r\n=SUM(A1),@x\r\n-abc,+7\r\n");
        let report = issues(&Unlaned, &path, Format::Csv, &json!({})).expect("issues");
        let found: Vec<(&str, &str)> = report["issues"]
            .as_array()
            .expect("issues")
            .iter()
            .map(|issue| (issue["code"].as_str().expect("code"), issue["path"].as_str().expect("path")))
            .collect();
        assert_eq!(
            found,
            [
                ("ragged_row", "/row[3]"),
                ("formula_like_value", "/sheet[a]/cell[A4]"),
                ("formula_like_value", "/sheet[a]/cell[B4]"),
                ("formula_like_value", "/sheet[a]/cell[A5]"),
            ]
        );
        assert_eq!(
            report["issues"][0]["message"],
            "Row has 3 column(s); the file's rows are 2 wide. An unquoted separator inside a value splits it into an extra column."
        );
        assert_eq!(report["ok"], true);
        let limited = issues(&Unlaned, &path, Format::Csv, &json!({ "range": "A4:A4" })).expect("limited");
        assert_eq!(limited["issueCount"], 2);
    }

    #[test]
    fn invalid_bytes_and_nul_characters_fail_validation() {
        let dir = dir();
        let path = file(&dir, "a.csv", b"a,\xFF\r\nb\0,c\r\n");
        let checked = validate(&Unlaned, &path, Format::Csv).expect("validate");
        assert_eq!(
            (checked["ok"].as_bool(), checked["invalidEncoding"].as_bool(), checked["nulBytes"].as_u64()),
            (Some(false), Some(true), Some(1))
        );
        let report = issues(&Unlaned, &path, Format::Csv, &json!({})).expect("issues");
        assert_eq!(report["ok"], false);
        assert_eq!(report["issues"][0]["code"], "invalid_utf8");
        assert_eq!(report["issues"][1]["message"], "File contains 1 NUL byte(s).");
        let missing = dir.path().join("none.csv");
        let error = snapshot(&Unlaned, &missing, Format::Csv, &Value::Null).expect_err("missing");
        assert!(error.starts_with("ENOENT: no such file or directory, open '"));
    }

    #[test]
    fn inserts_above_the_old_guessed_cap_keep_every_existing_cell() {
        for count in [120_001, 122_000] {
            let mut rows = strings(&[&["first"], &["last"]]);
            apply_operation(&mut rows, Format::Csv, &json!({"op":"insert_rows","row":2,"count":count})).unwrap();
            assert_eq!(rows.len(), count + 2);
            assert_eq!(rows.first().unwrap(), &["first"]);
            assert_eq!(rows.last().unwrap(), &["last"]);
            assert!(rows[1..=count].iter().all(Vec::is_empty));
            let mut rows = strings(&[&["first", "last"]]);
            apply_operation(&mut rows, Format::Csv, &json!({"op":"insert_columns","column":2,"count":count})).unwrap();
            assert_eq!(rows[0].len(), count + 2);
            assert_eq!(rows[0][0], "first");
            assert_eq!(rows[0][count+1], "last");
            assert!(rows[0][1..=count].iter().all(String::is_empty));
        }
    }

    #[test]
    fn explicit_null_options_fail_after_reading_and_omitted_options_are_an_object() {
        let dir = dir();
        let path = file(&dir, "options.csv", b"a,b\r\n");
        assert!(snapshot(&Unlaned, &path, Format::Csv, &json!({})).is_ok());
        assert!(issues(&Unlaned, &path, Format::Csv, &json!({})).is_ok());
        assert_eq!(snapshot(&Unlaned, &path, Format::Csv, &Value::Null).unwrap_err(), "Cannot read properties of null (reading 'sheet')");
        assert_eq!(issues(&Unlaned, &path, Format::Csv, &Value::Null).unwrap_err(), "Cannot read properties of null (reading 'range')");
        let absent = dir.path().join("absent.csv");
        assert!(snapshot(&Unlaned, &absent, Format::Csv, &Value::Null).unwrap_err().starts_with("ENOENT:"));
        assert!(issues(&Unlaned, &absent, Format::Csv, &Value::Null).unwrap_err().starts_with("ENOENT:"));
    }

    #[test]
    fn bom_only_and_failed_batch_preserve_bytes_and_write_note_order() {
        struct Capture(std::sync::Mutex<Vec<Vec<u8>>>);
        impl WriteNote for Capture {
            fn note_write(&self, path: &Path) { self.0.lock().unwrap().push(mixdog_fsio::read(&Unlaned, path).unwrap()); }
        }
        let dir = dir();
        let path = file(&dir, "bom.csv", "\u{FEFF}".as_bytes());
        let note = Capture(std::sync::Mutex::new(Vec::new()));
        let before = bytes(&path);
        let failed = [json!({"op":"set_cell","cell":"A1","value":"changed"}), json!({"op":"unknown"})];
        assert!(apply_batch(&Unlaned, &note, &path, Format::Csv, &failed).is_err());
        assert_eq!(bytes(&path), before);
        assert!(note.0.lock().unwrap().is_empty(), "failed batches must not report a write");
        apply_batch(&Unlaned, &note, &path, Format::Csv, &[json!({"op":"append_row","values":["가"]})]).unwrap();
        assert_eq!(*note.0.lock().unwrap(), vec![before]);
        assert_eq!(bytes(&path), "\u{FEFF}가\r\n".as_bytes());
        apply_batch(&Unlaned, &note, &path, Format::Csv, &[json!({"op":"delete_rows","row":1})]).unwrap();
        assert_eq!(bytes(&path), "\u{FEFF}".as_bytes());
        assert_eq!(note.0.lock().unwrap().len(), 2);
        assert_eq!(note.0.lock().unwrap()[1], "\u{FEFF}가\r\n".as_bytes());
    }

}
