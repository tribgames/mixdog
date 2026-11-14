//! A1 cell references: `columnLabel`, `columnNumber` and `parseCellRef` of `portable/portable-cells.mjs`, and
//! `parseXlsxCell` and `parseXlsxRange` of `portable/xlsx-contract.mjs`. The formula engine, the CSV/TSV backend and
//! the xlsx engine all read cells through these, so there is one implementation.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, math};

pub const XLSX_MAX_ROWS: u32 = 1_048_576;
pub const XLSX_MAX_COLUMNS: u32 = 16_384;
pub const XLSX_MAX_RANGE_CELLS: usize = 100_000;

/// `/^([A-Z]+)([1-9]\d*)$/i`: both parsers read a cell this way.
static CELL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Z]+)([1-9]\d*)$", "i"));

fn upper(text: &str) -> String {
    text.to_uppercase()
}

/// `columnNumber(label)`: `A` is 1, `Z` 26, `AA` 27. Every character counts as `code - 64`, as the reduce over
/// `charCodeAt(0)` does, so a label that is not letters answers whatever number that gives.
pub fn column_number(label: &str) -> f64 {
    upper(label).chars().fold(0.0, |value, c| {
        let mut unit = [0_u16; 2];
        let first = c.encode_utf16(&mut unit)[0];
        value * 26.0 + f64::from(first) - 64.0
    })
}

/// `columnLabel(number)`: the letters of a 1-based column number (a number below 1, or NaN, is column 1). A fraction
/// is cut; infinity, which Node never returns from, is column 1.
pub fn column_label(number: f64) -> String {
    let mut value = if number.is_finite() { math::max(1.0, number.trunc()) } else { 1.0 };
    let mut letters: Vec<char> = Vec::new();
    while value > 0.0 {
        value -= 1.0;
        letters.push(char::from(65 + (value % 26.0) as u8));
        value = (value / 26.0).floor();
    }
    letters.iter().rev().collect()
}

/// A parsed `parseCellRef`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellRef {
    /// The column letters, upper-cased.
    pub col: String,
    pub row: u64,
    /// `col` and the row digits as written.
    pub reference: String,
}

/// `parseCellRef(ref)`; the row saturates where the digits exceed 64 bits (every caller range-checks it).
pub fn parse_cell_ref(reference: &str) -> Result<CellRef, String> {
    let Some(caps) = CELL.captures(js_trim(reference)) else {
        return Err(format!("Invalid cell reference: {reference}"));
    };
    let col = upper(caps.get(1).unwrap_or_default());
    let digits = caps.get(2).unwrap_or_default();
    Ok(CellRef { row: digits.parse().unwrap_or(u64::MAX), reference: format!("{col}{digits}"), col })
}

/// A parsed `parseXlsxCell`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XlsxCell {
    /// `A1`, upper-cased.
    pub reference: String,
    pub row: u32,
    pub column: u32,
}

/// `parseXlsxCell(reference)`: a cell inside the sheet grid (A to XFD, rows 1 to 1,048,576).
pub fn parse_xlsx_cell(reference: &str) -> Result<XlsxCell, String> {
    let Some(caps) = CELL.captures(js_trim(reference)) else {
        return Err(format!("Invalid XLSX cell reference: {reference}"));
    };
    let letters = caps.get(1).unwrap_or_default();
    let digits = caps.get(2).unwrap_or_default();
    let column = column_number(letters);
    if column < 1.0 || column > f64::from(XLSX_MAX_COLUMNS) {
        return Err(format!("XLSX column must be between A and XFD: {reference}"));
    }
    let row = digits.parse::<u64>().ok().and_then(|row| u32::try_from(row).ok()).filter(|row| *row <= XLSX_MAX_ROWS);
    let Some(row) = row else {
        return Err(format!("XLSX row must be between 1 and {XLSX_MAX_ROWS}: {reference}"));
    };
    Ok(XlsxCell { reference: format!("{}{row}", upper(letters)), row, column: column as u32 })
}

/// A parsed `parseXlsxRange`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XlsxRange {
    pub start: XlsxCell,
    pub end: XlsxCell,
    pub rows: u32,
    pub columns: u32,
    pub cells: u64,
}

/// `parseXlsxRange(reference, { maxCells })`. A single cell is a one-cell range: the writers already treat it as one,
/// and it is how a caller names a validated or styled cell.
pub fn parse_xlsx_range(reference: &str, max_cells: usize) -> Result<XlsxRange, String> {
    let text = js_trim(reference);
    if text.is_empty() {
        return Err(format!("Invalid XLSX range: {reference}"));
    }
    // `/^([^:]+):([^:]+)$/`: exactly one colon, a part on each side.
    let (first, second) = match text.split_once(':') {
        Some((left, right)) if !left.is_empty() && !right.is_empty() && !right.contains(':') => (left, right),
        _ => (text, text),
    };
    let start = parse_xlsx_cell(first)?;
    let end = parse_xlsx_cell(second)?;
    if start.row > end.row || start.column > end.column {
        return Err(format!("XLSX range start must not follow range end: {reference}"));
    }
    let rows = end.row - start.row + 1;
    let columns = end.column - start.column + 1;
    let cells = u64::from(rows) * u64::from(columns);
    if cells > max_cells as u64 {
        return Err(format!("XLSX range contains {cells} cells; maximum is {max_cells}"));
    }
    Ok(XlsxRange { start, end, rows, columns, cells })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_numbers_round_trip() {
        assert_eq!(column_label(1.0), "A");
        assert_eq!(column_label(26.0), "Z");
        assert_eq!(column_label(27.0), "AA");
        assert_eq!(column_label(702.0), "ZZ");
        assert_eq!(column_label(703.0), "AAA");
        assert_eq!(column_label(16_384.0), "XFD");
        assert_eq!(column_label(0.0), "A");
        assert_eq!(column_label(-4.0), "A");
        assert_eq!(column_label(f64::NAN), "A");
        assert_eq!(column_label(28.9), "AB");
        for number in [1_u32, 2, 26, 27, 52, 53, 702, 703, 16_384] {
            assert_eq!(column_number(&column_label(f64::from(number))), f64::from(number));
        }
        assert_eq!(column_number("aa"), 27.0);
        assert_eq!(column_number(""), 0.0);
        assert_eq!(column_number("1"), -15.0);
    }

    #[test]
    fn cell_refs_parse_trimmed_and_upper_cased() {
        assert_eq!(parse_cell_ref(" b12 ").unwrap(), CellRef { col: "B".into(), row: 12, reference: "B12".into() });
        for bad in ["", "A0", "1A", "A1:B2", "$A$1", "A01"] {
            assert_eq!(parse_cell_ref(bad).unwrap_err(), format!("Invalid cell reference: {bad}"));
        }
    }

    #[test]
    fn xlsx_cells_stay_inside_the_grid() {
        assert_eq!(parse_xlsx_cell("xfd1048576").unwrap(), XlsxCell { reference: "XFD1048576".into(), row: 1_048_576, column: 16_384 });
        assert_eq!(parse_xlsx_cell("XFE1").unwrap_err(), "XLSX column must be between A and XFD: XFE1");
        assert_eq!(parse_xlsx_cell("A1048577").unwrap_err(), "XLSX row must be between 1 and 1048576: A1048577");
        assert_eq!(parse_xlsx_cell("A99999999999999999999999").unwrap_err(), "XLSX row must be between 1 and 1048576: A99999999999999999999999");
        assert_eq!(parse_xlsx_cell("A-1").unwrap_err(), "Invalid XLSX cell reference: A-1");
    }

    #[test]
    fn xlsx_ranges() {
        let range = parse_xlsx_range("b2:D5", XLSX_MAX_RANGE_CELLS).unwrap();
        assert_eq!((range.rows, range.columns, range.cells), (4, 3, 12));
        assert_eq!((range.start.reference.as_str(), range.end.reference.as_str()), ("B2", "D5"));
        let single = parse_xlsx_range(" C3 ", XLSX_MAX_RANGE_CELLS).unwrap();
        assert_eq!(single.start, single.end);
        assert_eq!(single.cells, 1);
        assert_eq!(parse_xlsx_range("", 10).unwrap_err(), "Invalid XLSX range: ");
        assert_eq!(parse_xlsx_range("B2:A1", 10).unwrap_err(), "XLSX range start must not follow range end: B2:A1");
        assert_eq!(parse_xlsx_range("A1:C4", 10).unwrap_err(), "XLSX range contains 12 cells; maximum is 10");
        assert_eq!(parse_xlsx_range("A1:B2:C3", 10).unwrap_err(), "Invalid XLSX cell reference: A1:B2:C3");
        assert_eq!(parse_xlsx_range(":A1", 10).unwrap_err(), "Invalid XLSX cell reference: :A1");
    }
}
