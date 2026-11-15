//! Data validation blocks and formula lineage (`Excel-ValidationRule`, `Excel-ValidationBlocks`, `Excel-FormulaPrecedents`,
//! `Excel-FormulaLineage`).

use std::sync::OnceLock;

use regex::Regex;

use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

use super::cells::attempt;
use super::cells::get_with;
use super::cells::int_of;
use super::cells::is_null_or_dbnull;
use super::cells::ordered;
use super::cells::string_of;

/// The bounds of the portable reader's walk of a validated area.
const MAX_ROWS: i32 = 512;
const MAX_COLUMNS: i32 = 64;

/// `Excel-ValidationRule`: the one rule a range holds throughout (`type|operator|formula1|formula2`), or `None` when its
/// cells hold different ones: Excel answers a mixed range's validation with nothing rather than an error.
pub(super) fn validation_rule(range: &Com) -> Result<Option<String>> {
    let validation = range.member("Validation")?;
    let kind = validation.member("Type")?;
    if is_null_or_dbnull(&kind) {
        return Ok(None);
    }
    let operator = attempt(|| int_of(&validation.member("Operator")?)).unwrap_or(0);
    let formula1 = attempt(|| Ok(string_of(&validation.member("Formula1")?))).unwrap_or_default();
    let formula2 = attempt(|| Ok(string_of(&validation.member("Formula2")?))).unwrap_or_default();
    Ok(Some(format!("{}|{operator}|{formula1}|{formula2}", int_of(&kind)?)))
}

/// One run of cells that hold the same rule.
struct Run {
    rule: Option<String>,
    top: i32,
    bottom: i32,
    left: i32,
    right: i32,
}

/// `Excel-ValidationBlocks`: SpecialCells joins validated cells that touch into one area, so a list in B beside a number
/// rule in C reads back as one list over both. An area whose cells differ is split by column, a mixed column by cell, and
/// neighbouring runs that hold the same rule over the same rows are joined again; the bounds are the portable reader's
/// (512 x 64).
pub(super) fn validation_blocks(sheet: &Com, area: &Com) -> Result<Vec<Com>> {
    if validation_rule(area)?.is_some() {
        return Ok(vec![area.clone()]);
    }
    let top = int_of(&area.member("Row")?)?;
    let bottom = top + super::cells::min_int(int_of(&area.member("Rows")?.member("Count")?)?, MAX_ROWS)? - 1;
    let left = int_of(&area.member("Column")?)?;
    let right = left + super::cells::min_int(int_of(&area.member("Columns")?.member("Count")?)?, MAX_COLUMNS)? - 1;
    let item = |row: i32, column: i32| -> Result<Com> {
        let cells = sheet.member("Cells")?;
        get_with(&cells, "Item", &[Com::I4(row), Com::I4(column)])
    };
    let span = |first_row: i32, first_column: i32, last_row: i32, last_column: i32| -> Result<Com> {
        let from = item(first_row, first_column)?;
        let to = item(last_row, last_column)?;
        get_with(sheet, "Range", &[from, to])
    };
    let mut runs: Vec<Run> = Vec::new();
    for column in left..=right {
        let mut column_runs: Vec<Run> = Vec::new();
        let rule = validation_rule(&span(top, column, bottom, column)?)?;
        if rule.is_some() {
            column_runs.push(Run { rule, top, bottom, left: column, right: column });
        } else {
            for row in top..=bottom {
                let cell_rule = validation_rule(&item(row, column)?)?;
                let continues = column_runs.last().is_some_and(|last| last.rule == cell_rule);
                if continues {
                    if let Some(last) = column_runs.last_mut() {
                        last.bottom = row;
                    }
                } else {
                    column_runs.push(Run { rule: cell_rule, top: row, bottom: row, left: column, right: column });
                }
            }
        }
        for run in column_runs {
            let joined = runs
                .iter()
                .position(|open| open.right == column - 1 && open.rule == run.rule && open.top == run.top && open.bottom == run.bottom);
            match joined {
                Some(at) => runs[at].right = column,
                None => runs.push(Run { rule: run.rule, top: run.top, bottom: run.bottom, left: column, right: column }),
            }
        }
    }
    let mut blocks = Vec::with_capacity(runs.len());
    for run in &runs {
        blocks.push(span(run.top, run.left, run.bottom, run.right)?);
    }
    Ok(blocks)
}

fn precedent_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:(?P<sheet>[A-Za-z0-9_ .-]+)!)?\$?(?P<col>[A-Z]{1,3})\$?(?P<row>[1-9]\d*)").expect("the precedent pattern is valid")
    })
}

/// `Excel-FormulaPrecedents`: the cells a formula names, once each (apostrophes removed, the key compared ignoring case),
/// on the sheet written before the `!` or else the current one.
pub(super) fn formula_precedents(formula: &str, current_sheet: &str) -> Vec<Value> {
    let clean = formula.replace('\'', "");
    let mut seen: Vec<String> = Vec::new();
    let mut output = Vec::new();
    for found in precedent_pattern().captures_iter(&clean) {
        let sheet = found.name("sheet").map_or(current_sheet, |name| name.as_str());
        let reference = format!("{}{}", &found["col"], &found["row"]);
        let key = format!("{sheet}!{reference}");
        if seen.iter().any(|known| payload::names_equal(known, &key)) {
            continue;
        }
        seen.push(key);
        output.push(ordered(vec![
            ("sheet", Value::string(sheet)),
            ("ref", Value::String(reference.clone())),
            ("path", Value::String(format!("/sheet[{sheet}]/cell[{reference}]"))),
        ]));
    }
    output
}

/// `Excel-FormulaLineage`: for each entry (`path`, `formula`), the cells its formula names.
pub(super) fn formula_lineage(entries: &[Value], sheet_name: &str) -> Vec<Value> {
    entries
        .iter()
        .map(|entry| {
            let path = convert::to_ps_string(&payload::property(entry, "path"));
            let formula = payload::property(entry, "formula");
            let precedents = formula_precedents(&convert::to_ps_string(&formula), sheet_name);
            ordered(vec![
                ("path", Value::String(format!("{path}/lineage"))),
                ("from", payload::property(entry, "path")),
                ("formula", formula),
                ("precedents", Value::Array(precedents)),
            ])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(precedents: &[Value]) -> Vec<String> {
        precedents.iter().map(|entry| convert::to_ps_string(&payload::property(entry, "path"))).collect()
    }

    #[test]
    fn precedents_name_each_cell_once_on_its_own_sheet() {
        let found = formula_precedents("=SUM(A1:B2)+$C$3+'Data'!A1+Data!a1+A1", "Model");
        assert_eq!(
            refs(&found),
            ["/sheet[Model]/cell[A1]", "/sheet[Model]/cell[B2]", "/sheet[Model]/cell[C3]", "/sheet[Data]/cell[A1]"]
        );
    }

    #[test]
    fn a_sheet_name_with_spaces_and_a_sheet_key_compared_ignoring_case_are_one_precedent() {
        let found = formula_precedents("='My Sheet'!B4+'my sheet'!B4", "S");
        assert_eq!(refs(&found), ["/sheet[My Sheet]/cell[B4]"]);
    }

    #[test]
    fn lineage_wraps_each_entry_with_its_precedents() {
        let entry = ordered(vec![("path", Value::string("/sheet[S]/cell[C1]")), ("formula", Value::string("=A1+B1"))]);
        let lineage = formula_lineage(&[entry], "S");
        assert_eq!(
            crate::ps::json::to_json(&lineage[0], 6),
            "{\"path\":\"/sheet[S]/cell[C1]/lineage\",\"from\":\"/sheet[S]/cell[C1]\",\"formula\":\"=A1+B1\",\"precedents\":[{\"sheet\":\"S\",\"ref\":\"A1\",\"path\":\"/sheet[S]/cell[A1]\"},{\"sheet\":\"S\",\"ref\":\"B1\",\"path\":\"/sheet[S]/cell[B1]\"}]}"
        );
    }
}
