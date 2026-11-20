//! `portable/portable-shared-formulas.mjs`: Excel stores a filled-down column once: the first cell holds the formula and a
//! shared id, every cell under it holds the id alone. Taken as written, those cells carry no formula at all, so a snapshot
//! shows pasted numbers, the model audit reports hardcodes where the workbook holds a calculation, and a recalculation
//! leaves the column empty without reporting anything missing. Every reader therefore goes through here first.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, math};
use mixdog_office_base::a1::{CellRef, column_label, column_number, parse_cell_ref};
use mixdog_xlsx_formula::translate_shared_formula;

use crate::cells::{CellRecord, FormulaInfo, iterate_sheet_cells};
use crate::xml::xml_decode;

/// A block wider than this is a range the file declares rather than a formula a reader will look at, and walking it cell by
/// cell costs more than it tells.
const MAX_BLOCK_CELLS: f64 = 20_000.0;

static STORED_ONCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<f\b[^>]*\bt="(?:shared|array)""#, ""));
static FORMULA_ELEMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)", ""));
static ARRAY_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="array""#, ""));
static SHARED_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="shared""#, ""));
static RANGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bref="([^"]+)""#, ""));
static SHARED_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bsi="([^"]+)""#, ""));

/// A cell whose stored-once formula could not be written, with the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedFormulaFailure {
    pub reference: String,
    pub reason: String,
}

struct Master {
    formula: String,
    at: CellRef,
}

struct ArrayBlock {
    formula: String,
    range: String,
}

/// Gives `record` the formula `formula`. The record has no cached result of its own for it (the file stores the formula
/// once, not here), so what the cell holds is its cached value.
fn give_formula(record: &mut CellRecord, formula: String) {
    record.formula = Some(FormulaInfo { formula, cached_value: Some(record.value.clone()), cache_state: "present" });
}

/// `expandSharedFormulas(xml, records)`: gives each cell a stored-once formula covers the formula it holds: a shared
/// follower gets it seen from where the cell sits, a cell inside an array block gets the block's own formula, which is
/// what Excel shows there. Returns the cells that could not be written, with the reason; records are patched in place.
/// An error is a cell reference that is not one (row 0), which Node's reader throws on.
pub fn expand_shared_formulas(xml: &str, records: &mut [CellRecord]) -> Result<Vec<SharedFormulaFailure>, String> {
    // Most sheets store every formula in its own cell, and walking them again to learn that costs as much as reading them
    // did.
    if !STORED_ONCE.is_match(xml) {
        return Ok(Vec::new());
    }
    let mut by_reference: HashMap<String, usize> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        by_reference.insert(record.reference.clone(), index);
    }
    let mut masters: HashMap<String, Master> = HashMap::new();
    let mut followers: Vec<(String, String)> = Vec::new();
    let mut arrays: Vec<ArrayBlock> = Vec::new();
    for cell in iterate_sheet_cells(xml) {
        let Some(element) = FORMULA_ELEMENT.captures(cell.body) else { continue };
        let attributes = element.get(1).unwrap_or("");
        let text = xml_decode(js_trim(element.get(2).unwrap_or("")));
        // An array formula is written in the first cell of the block it fills and nowhere else, though Excel shows the
        // same formula in every cell of it.
        if ARRAY_TYPE.is_match(attributes) && !text.is_empty() {
            let range = RANGE.captures(attributes).and_then(|found| found.get(1).map(str::to_owned));
            if let Some(range) = range.filter(|range| range.contains(':')) {
                arrays.push(ArrayBlock { formula: text, range });
            }
            continue;
        }
        if !SHARED_TYPE.is_match(attributes) {
            continue;
        }
        let Some(id) = SHARED_ID.captures(attributes).and_then(|found| found.get(1).map(str::to_owned)) else { continue };
        if text.is_empty() {
            followers.push((cell.reference.to_owned(), id));
        } else {
            masters.insert(id, Master { formula: text, at: parse_cell_ref(cell.reference)? });
        }
    }
    fill_array_formulas(&arrays, &by_reference, records)?;
    fill_shared_followers(&followers, &masters, &by_reference, records)
}

/// Every cell of an array block carries the block's formula.
fn fill_array_formulas(arrays: &[ArrayBlock], by_reference: &HashMap<String, usize>, records: &mut [CellRecord]) -> Result<(), String> {
    for array in arrays {
        // Every part is read, as the map over the split does: a third part that is not a cell fails the read too.
        let mut ends = array.range.split(':').map(|part| parse_cell_ref(&part.replace('$', ""))).collect::<Result<Vec<_>, _>>()?.into_iter();
        let (Some(start), Some(end)) = (ends.next(), ends.next()) else { continue };
        let (start_row, end_row) = (start.row as f64, end.row as f64);
        let first_row = math::min(start_row, end_row);
        let last_row = math::max(start_row, end_row);
        let (start_column, end_column) = (column_number(&start.col), column_number(&end.col));
        let first_column = math::min(start_column, end_column);
        let last_column = math::max(start_column, end_column);
        if (last_row - first_row + 1.0) * (last_column - first_column + 1.0) > MAX_BLOCK_CELLS {
            continue;
        }
        let mut row = first_row;
        while row <= last_row {
            let mut column = first_column;
            while column <= last_column {
                let reference = format!("{}{}", column_label(column), mixdog_js::number_to_string(row));
                if let Some(&index) = by_reference.get(&reference) {
                    if records[index].formula.is_none() {
                        give_formula(&mut records[index], array.formula.clone());
                    }
                }
                column += 1.0;
            }
            row += 1.0;
        }
    }
    Ok(())
}

/// A follower's formula is its master's, shifted by their distance; a shift the translator cannot express is recorded as a
/// failure.
fn fill_shared_followers(
    followers: &[(String, String)],
    masters: &HashMap<String, Master>,
    by_reference: &HashMap<String, usize>,
    records: &mut [CellRecord],
) -> Result<Vec<SharedFormulaFailure>, String> {
    let mut failures = Vec::new();
    for (reference, id) in followers {
        let master = masters.get(id);
        let index = by_reference.get(reference).copied();
        let at = parse_cell_ref(reference)?;
        let (Some(master), Some(index)) = (master, index) else { continue };
        if records[index].formula.is_some() {
            continue;
        }
        let row_delta = at.row as i64 - master.at.row as i64;
        let column_delta = (column_number(&at.col) - column_number(&master.at.col)) as i64;
        match translate_shared_formula(&master.formula, row_delta, column_delta) {
            Ok(formula) => give_formula(&mut records[index], formula),
            Err(failure) => failures.push(SharedFormulaFailure { reference: reference.clone(), reason: failure.reason }),
        }
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::cells::{CellValue, cell_records};

    const SHEET: &str = "<worksheet><sheetData>\
        <row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\"><f t=\"shared\" ref=\"B1:B3\" si=\"0\">A1*$C$1</f><v>10</v></c><c r=\"C1\"><v>10</v></c></row>\
        <row r=\"2\"><c r=\"A2\"><v>2</v></c><c r=\"B2\"><f t=\"shared\" si=\"0\"/><v>20</v></c></row>\
        <row r=\"3\"><c r=\"A3\"><v>3</v></c><c r=\"B3\"><f t=\"shared\" si=\"0\"/><v>30</v></c></row>\
        </sheetData></worksheet>";

    fn formulas(records: &[CellRecord]) -> BTreeMap<String, String> {
        records.iter().filter_map(|record| record.formula.as_ref().map(|info| (record.reference.clone(), info.formula.clone()))).collect()
    }

    fn expected(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    /// Every cell a shared formula covers reads as the formula it holds.
    #[test]
    fn every_cell_a_shared_formula_covers_reads_as_the_formula_it_holds() {
        let mut records = cell_records(SHEET, &[], None);
        assert_eq!(expand_shared_formulas(SHEET, &mut records), Ok(Vec::new()));
        // The row moves with the cell; the column pinned with $ stays where it is.
        assert_eq!(formulas(&records), expected(&[("B1", "A1*$C$1"), ("B2", "A2*$C$1"), ("B3", "A3*$C$1")]));
    }

    /// An array formula is written once for the block it fills, and Excel shows it in every cell of that block. Read as the
    /// file writes it, the cells after the first look like pasted results.
    #[test]
    fn every_cell_inside_an_array_block_reads_as_the_array_formula() {
        let sheet = "<worksheet><sheetData>\
            <row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\"><f t=\"array\" ref=\"B1:B3\">TREND(A1:A3)</f><v>1</v></c></row>\
            <row r=\"2\"><c r=\"A2\"><v>2</v></c><c r=\"B2\"><v>2</v></c></row>\
            <row r=\"3\"><c r=\"A3\"><v>3</v></c><c r=\"B3\"><v>3</v></c></row>\
            </sheetData></worksheet>";
        let mut records = cell_records(sheet, &[], None);
        expand_shared_formulas(sheet, &mut records).expect("expands");
        assert_eq!(formulas(&records), expected(&[("B1", "TREND(A1:A3)"), ("B2", "TREND(A1:A3)"), ("B3", "TREND(A1:A3)")]));
    }

    /// A cell outside any shared formula is left exactly as it was.
    #[test]
    fn a_cell_outside_any_shared_formula_is_left_exactly_as_it_was() {
        let mut records = cell_records(SHEET, &[], None);
        expand_shared_formulas(SHEET, &mut records).expect("expands");
        let plain = records.iter().find(|record| record.reference == "A2").expect("A2");
        assert!(plain.formula.is_none());
        assert_eq!(plain.value, CellValue::Number(2.0));
    }

    #[test]
    fn a_sheet_with_no_stored_once_formula_is_not_walked() {
        let sheet = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>";
        let mut records = cell_records(sheet, &[], None);
        assert_eq!(expand_shared_formulas(sheet, &mut records), Ok(Vec::new()));
        assert_eq!(formulas(&records), expected(&[("A1", "1+1")]));
    }

    #[test]
    fn a_block_wider_than_the_limit_is_left_alone() {
        let sheet = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f t=\"array\" ref=\"A1:Z1000\">X()</f><v>1</v></c><c r=\"A2\"><v>2</v></c></row></sheetData></worksheet>";
        let mut records = cell_records(sheet, &[], None);
        expand_shared_formulas(sheet, &mut records).expect("expands");
        assert_eq!(formulas(&records), expected(&[("A1", "X()")]));
    }
}
