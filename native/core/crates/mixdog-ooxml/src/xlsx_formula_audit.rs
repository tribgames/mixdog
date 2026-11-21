//! `portable/xlsx-formula-audit.mjs`: the backend-neutral formula audit over snapshot sheets. A sheet is
//! `{ name, path?, cells: [...], tables?, notes?, freezePanes? }`; the COM and portable snapshots both produce this
//! shape, so one audit serves both backends and the qa/finalize review. Findings use the office issue shape
//! (`{ severity, code, path, message }`).
//!
//! Two tiers: the workbook hygiene of [`crate::xlsx_sheet_hygiene`] runs for every profile; the modelling discipline here
//! (inline constants, unguarded division, a lone formula that breaks a row pattern, a reference past the data, hardcodes
//! inside formula rows, unsourced inputs, failed checks, unmarked inputs) runs under the audit profile
//! `financial-model`. Sheets and cells are the snapshot JSON of [`crate::xlsx_audit_support`].

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim_end, js_trim_start, number_to_string, string_to_number};
use mixdog_office_base::a1::{column_number, parse_cell_ref};
use serde_json::{Map, Value, json};

use crate::xlsx_audit_support::{
    Issue, IssueList, Located, MAX_ISSUES_PER_CODE, Position, cell_path, false_value, formula_body_of, has_visible_style, inside_table_body,
    is_marked_input_style, js_text, list, noted_refs, numeric_value, position, sheet_path, table_areas, text_or_empty, truthy,
};
use crate::xlsx_sheet_hygiene::{audit_sheet_hygiene, audit_sheet_layout, external_defined_names};

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static WHITESPACE: LazyLock<JsRegex> = regex!(r"\s+", "g");
static RELATIVE_REFERENCE: LazyLock<JsRegex> = regex!(r"(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_(])", "gi");
static NUMBER_LITERAL: LazyLock<JsRegex> = regex!(r"(?<![A-Za-z0-9_.$])(\d+(?:\.\d+)?)(?![A-Za-z0-9_(])", "g");
static IF_FAMILY: LazyLock<JsRegex> = regex!(r"(?<![A-Za-z0-9_.])(?:IFERROR|IFNA|IF|IFS)\s*\(", "i");
static COMPOUNDING_BASE: LazyLock<JsRegex> = regex!(r"\/\s*\(\s*1\s*\+", "g");
static DIVISOR: LazyLock<JsRegex> = regex!(r"\/\s*(?:\(|[A-Za-z_$'])", "");
static SINGLE_REFERENCE: LazyLock<JsRegex> = regex!(r"(?<![A-Za-z0-9_.!':$\]])\$?([A-Z]{1,3})\$?([1-9]\d*)(?![A-Za-z0-9_(:])", "gi");
static SUMMED: LazyLock<JsRegex> = regex!(r"^SUM\(([^()]+)\)$", "i");
static SPAN: LazyLock<JsRegex> = regex!(r"^\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$", "i");
static ONE: LazyLock<JsRegex> = regex!(r"^\$?([A-Z]{1,3})\$?([1-9]\d*)$", "i");

/// Unit and calendar constants belong in a formula; a rate or a factor does not.
const UNIT_LITERALS: [f64; 15] = [0.0, 1.0, 2.0, 7.0, 10.0, 12.0, 24.0, 52.0, 60.0, 100.0, 365.0, 1000.0, 10000.0, 100_000.0, 1_000_000.0];

/// The model-discipline verdicts the shared audit owns outright. Excel's host makes cruder versions of these (every numeric
/// cell on a data sheet with no comment was "unsourced", one per cell), so its findings for them are replaced by the shared
/// audit's, and both backends report the same workbook the same way.
const SHARED_MODEL_VERDICTS: [&str; 3] = ["hardcode_missing_source", "rogue_hardcode", "formula_inconsistency"];

/// A cell's coordinates as the audit keys its maps by them.
fn key(number: f64) -> i64 {
    number as i64
}

/// `relativeFormulaSignature` from where the cell stands.
fn signature_at(formula: &str, origin: Option<Position>) -> String {
    let body = WHITESPACE.replace_all_with(&formula_body_of(formula), |_| String::new());
    RELATIVE_REFERENCE
        .replace_all_with(&body, |found| {
            let Some(origin) = origin else { return "#REF".to_owned() };
            let absolute_column = found.get(1).unwrap_or("");
            let label = found.get(2).unwrap_or("").to_uppercase();
            let absolute_row = found.get(3).unwrap_or("");
            let row = string_to_number(found.get(4).unwrap_or(""));
            let column = column_number(&label);
            format!(
                "{}{}",
                if absolute_row.is_empty() { format!("R[{}]", number_to_string(row - origin.row)) } else { format!("R{}", number_to_string(row)) },
                if absolute_column.is_empty() { format!("C[{}]", number_to_string(column - origin.column)) } else { format!("C{}", number_to_string(column)) },
            )
        })
        .to_uppercase()
}

/// `relativeFormulaSignature(formula, ref)`: a formula expressed relative to its own cell (R1C1), so the same pattern copied
/// across a row or down a column yields the same signature.
pub fn relative_formula_signature(formula: &str, reference: &str) -> String {
    let origin = parse_cell_ref(reference).ok().map(|parsed| Position { row: parsed.row as f64, column: column_number(&parsed.col) });
    signature_at(formula, origin)
}

/// `inlineConstants(formula)`: numeric literals that scale or shift a value: `*1.05`, `/1.1`, `^2`, `(1+0.05)`. A function
/// argument (`ROUND(x, 2)`) is not adjacent to an operator and is never reported; unit constants are exempt.
pub fn inline_constants(formula: &str) -> Vec<String> {
    let text = formula_body_of(formula);
    let mut found = Vec::new();
    for matched in NUMBER_LITERAL.captures_iter(&text) {
        let literal_text = matched.get(1).unwrap_or("");
        if UNIT_LITERALS.contains(&string_to_number(literal_text)) {
            continue;
        }
        let range = matched.range();
        let before = js_trim_end(&text[..range.start]).chars().next_back();
        let after = js_trim_start(&text[range.end..]).chars().next();
        let operator = |character: Option<char>, set: &str| character.is_some_and(|character| set.contains(character));
        let scaling = operator(before, "*/^") || operator(after, "*/^");
        let fractional_shift = literal_text.contains('.') && (operator(before, "+-") || operator(after, "+-"));
        if scaling || fractional_shift {
            found.push(literal_text.to_owned());
        }
    }
    found
}

/// `unguardedDivision(formula)`: a divisor that is a reference, a name, a function, or a bracketed expression can be zero; a
/// literal cannot. Any IF-family wrapper counts as a guard. A compounding base, `(1+rate)` raised to a power or not, is zero
/// only at a rate of -100%.
pub fn unguarded_division(formula: &str) -> bool {
    let text = formula_body_of(formula);
    if IF_FAMILY.is_match(&text) {
        return false;
    }
    DIVISOR.is_match(&COMPOUNDING_BASE.replace_all_with(&text, |_| "*(1+".to_owned()))
}

/// A single same-sheet reference of a formula.
#[derive(Debug, Clone, PartialEq)]
pub struct SingleReference {
    pub reference: String,
    pub column: f64,
    pub row: f64,
}

/// `singleCellReferences(formula)`: single same-sheet references in a formula: not a range end, not another sheet's cell. An
/// open-ended `SUM(B2:B100)` is a habit; `=B31` on a 30-row sheet is the off-by-one that recalculates cleanly and reads wrong.
pub fn single_cell_references(formula: &str) -> Vec<SingleReference> {
    let text = formula_body_of(formula);
    SINGLE_REFERENCE
        .captures_iter(&text)
        .map(|found| {
            let label = found.get(1).unwrap_or("").to_uppercase();
            let digits = found.get(2).unwrap_or("");
            SingleReference { column: column_number(&label), row: string_to_number(digits), reference: format!("{label}{digits}") }
        })
        .collect()
}

/// A block of cells.
#[derive(Debug, Clone, Copy)]
struct Block {
    start_column: f64,
    end_column: f64,
    start_row: f64,
    end_row: f64,
}

fn block_of(columns: [f64; 2], rows: [f64; 2]) -> Block {
    Block { start_column: columns[0].min(columns[1]), end_column: columns[0].max(columns[1]), start_row: rows[0].min(rows[1]), end_row: rows[0].max(rows[1]) }
}

/// `additiveAreas(formula)`: the areas a purely additive formula reads (`SUM(B2:B9)`, `B2+B3`, or the two together) and
/// nothing else: a product, a ratio, a name, another sheet, or any other function disqualifies the formula, so only a plain
/// total is read as one.
fn additive_areas(formula: &str) -> Option<Vec<Block>> {
    let body = WHITESPACE.replace_all_with(&formula_body_of(formula), |_| String::new());
    if body.is_empty() {
        return None;
    }
    let mut areas = Vec::new();
    for term in body.split('+') {
        let summed = SUMMED.captures(term).and_then(|found| found.get(1).map(str::to_owned));
        let pieces: Vec<&str> = match &summed {
            Some(inner) => inner.split(',').collect(),
            None => vec![term],
        };
        for piece in pieces {
            if let Some(span) = SPAN.captures(piece) {
                let column = |at: usize| column_number(&span.get(at).unwrap_or("").to_uppercase());
                let row = |at: usize| string_to_number(span.get(at).unwrap_or(""));
                areas.push(block_of([column(1), column(3)], [row(2), row(4)]));
            } else if let Some(one) = ONE.captures(piece) {
                let column = column_number(&one.get(1).unwrap_or("").to_uppercase());
                let row = string_to_number(one.get(2).unwrap_or(""));
                areas.push(Block { start_column: column, end_column: column, start_row: row, end_row: row });
            } else {
                return None;
            }
        }
    }
    if areas.is_empty() { None } else { Some(areas) }
}

fn inside_block(block: &Block, at: Position) -> bool {
    at.column >= block.start_column && at.column <= block.end_column && at.row >= block.start_row && at.row <= block.end_row
}

fn covers_block(outer: &Block, inner: &Block) -> bool {
    inner.start_column >= outer.start_column && inner.end_column <= outer.end_column && inner.start_row >= outer.start_row && inner.end_row <= outer.end_row
}

fn multi_cell(block: &Block) -> bool {
    block.start_row != block.end_row || block.start_column != block.end_column
}

/// A map that keeps its keys in the order they were first added, as a JavaScript `Map` does.
struct Grouped<T> {
    order: Vec<i64>,
    groups: HashMap<i64, Vec<T>>,
}

impl<T> Grouped<T> {
    fn new() -> Self {
        Self { order: Vec::new(), groups: HashMap::new() }
    }

    fn push(&mut self, at: i64, entry: T) {
        if !self.groups.contains_key(&at) {
            self.order.push(at);
        }
        self.groups.entry(at).or_default().push(entry);
    }

    fn get(&self, at: i64) -> Option<&Vec<T>> {
        self.groups.get(&at)
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

struct Subtotal<'a> {
    cell: &'a Value,
    at: Position,
    terms: Vec<Block>,
}

/// `auditDoubleCounting`: a total that counts a subtotal again: the outer range covers a cell that is itself the sum of cells
/// inside that same range, so every value under the subtotal lands in the answer twice. The sheet recalculates cleanly and the
/// number is wrong by construction, which is why this reads under every profile.
fn audit_double_counting(list: &mut IssueList, sheet: &Value, cells: &[Value]) {
    let located: Vec<Located<'_>> =
        cells.iter().filter(|cell| truthy(cell.get("formula"))).filter_map(|cell| position(cell).map(|at| Located { cell, at })).collect();
    let mut subtotals: Grouped<Subtotal<'_>> = Grouped::new();
    for entry in &located {
        let Some(terms) = additive_areas(&text_or_empty(entry.cell.get("formula"))) else { continue };
        if !terms.iter().any(multi_cell) {
            continue;
        }
        subtotals.push(key(entry.at.column), Subtotal { cell: entry.cell, at: entry.at, terms });
    }
    if subtotals.is_empty() {
        return;
    }
    for Located { cell, at } in &located {
        let Some(outer) = additive_areas(&text_or_empty(cell.get("formula"))) else { continue };
        let counted = outer.iter().filter(|area| multi_cell(area)).find_map(|area| {
            let steps = area.end_column - area.start_column + 1.0;
            let mut step = 0.0;
            while step < steps {
                let candidates = subtotals.get(key(area.start_column + step));
                let hit = candidates.into_iter().flatten().find(|candidate| {
                    candidate.at.row != at.row
                        && inside_block(area, candidate.at)
                        && candidate.terms.iter().all(|term| covers_block(area, term) && !inside_block(term, candidate.at))
                });
                if hit.is_some() {
                    return hit;
                }
                step += 1.0;
            }
            None
        });
        let Some(counted) = counted else { continue };
        list.push(
            "warning",
            "subtotal_double_counted",
            cell_path(sheet, cell),
            format!(
                "The total covers {}, which is itself the sum of cells inside that same range; every value under that subtotal lands in this total twice. Sum the detail rows only, or leave the subtotal out of the range.",
                js_text(counted.cell.get("ref"))
            ),
        );
    }
}

/// One formula cell of a row or a column.
struct LineEntry<'a> {
    cell: &'a Value,
    index: f64,
    signature: String,
}

/// `auditLine`: the formula cells on one row (`axis` row) or one column (`axis` column), sorted by index.
fn audit_line(list: &mut IssueList, sheet: &Value, cells: &[&LineEntry<'_>], axis: &str) {
    if cells.len() < 4 {
        return;
    }
    let mut order: Vec<&str> = Vec::new();
    let mut tally: HashMap<&str, usize> = HashMap::new();
    for entry in cells {
        let count = tally.entry(entry.signature.as_str()).or_insert(0);
        if *count == 0 {
            order.push(entry.signature.as_str());
        }
        *count += 1;
    }
    let mut dominant = "";
    let mut dominant_count = 0;
    for signature in order {
        let count = tally[signature];
        if count > dominant_count {
            dominant = signature;
            dominant_count = count;
        }
    }
    if dominant_count < 3 || (dominant_count as f64) / (cells.len() as f64) < 0.75 {
        return;
    }
    let positions: Vec<f64> = cells.iter().filter(|entry| entry.signature == dominant).map(|entry| entry.index).collect();
    let first = positions.iter().copied().fold(f64::INFINITY, f64::min);
    let last = positions.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    for entry in cells {
        if entry.signature == dominant || entry.index <= first || entry.index >= last {
            continue;
        }
        list.push(
            "warning",
            "formula_pattern_inconsistency",
            cell_path(sheet, entry.cell),
            format!("Formula breaks the pattern its neighbours share along the {axis}; a lone edited cell mid-line is the commonest silent model error."),
        );
    }
}

/// The last populated row and column and the first populated row of the sheet.
struct Extent {
    row: f64,
    column: f64,
    first_row: f64,
}

fn populated_extent(cells: &[Value]) -> Extent {
    let mut extent = Extent { row: 0.0, column: 0.0, first_row: f64::INFINITY };
    for cell in cells {
        let Some(at) = position(cell) else { continue };
        extent.row = extent.row.max(at.row);
        extent.column = extent.column.max(at.column);
        extent.first_row = extent.first_row.min(at.row);
    }
    extent
}

/// One formula cell's own findings: reads past the data, embedded assumptions, unguarded division, and a failed tie-out on
/// the Checks sheet.
fn audit_formula_cell(list: &mut IssueList, sheet: &Value, cell: &Value, extent: &Extent, checks_sheet: bool) {
    let formula = text_or_empty(cell.get("formula"));
    let mut beyond: Vec<String> = Vec::new();
    for reference in single_cell_references(&formula) {
        if (reference.row > extent.row || reference.column > extent.column) && !beyond.contains(&reference.reference) {
            beyond.push(reference.reference);
        }
    }
    let path = cell_path(sheet, cell);
    if !beyond.is_empty() {
        list.push(
            "warning",
            "formula_reads_beyond_data",
            path.clone(),
            format!(
                "Formula reads {}, past the last populated row or column of the sheet; a reference one row or column off recalculates cleanly and shows the wrong number.",
                beyond.join(", ")
            ),
        );
    }
    let constants = inline_constants(&formula);
    if !constants.is_empty() {
        list.push(
            "warning",
            "inline_constant_in_formula",
            path.clone(),
            format!("Formula embeds {}; put each assumption in its own labelled cell and reference it (=B5*(1+$B$6), never =B5*1.05).", constants.join(", ")),
        );
    }
    if unguarded_division(&formula) {
        list.push(
            "warning",
            "unguarded_division",
            path.clone(),
            "Formula divides by a cell that can be zero; wrap it in IFERROR or guard the denominator with IF.",
        );
    }
    if checks_sheet && false_value(cell) {
        list.push("warning", "failed_check", path, "Tie-out on the Checks sheet evaluates to FALSE; the model does not add up until it reads TRUE.");
    }
}

/// An input cell of the unsourced-inputs report.
struct Unsourced {
    row: f64,
    column: f64,
    reference: String,
    path: String,
}

/// `contiguousRuns(entries)`: cells that sit side by side in the same row are one input line to the reader.
fn contiguous_runs(entries: &[Unsourced]) -> Vec<Vec<&Unsourced>> {
    let mut by_row: Grouped<&Unsourced> = Grouped::new();
    for entry in entries {
        by_row.push(key(entry.row), entry);
    }
    let mut rows = by_row.order.clone();
    rows.sort_unstable();
    let mut runs: Vec<Vec<&Unsourced>> = Vec::new();
    for row in rows {
        let mut line: Vec<&Unsourced> = by_row.get(row).cloned().unwrap_or_default();
        line.sort_by(|left, right| left.column.total_cmp(&right.column));
        let mut current: Vec<&Unsourced> = Vec::new();
        for entry in line {
            if current.last().is_some_and(|last| entry.column != last.column + 1.0) {
                runs.push(std::mem::take(&mut current));
            }
            current.push(entry);
        }
        if !current.is_empty() {
            runs.push(current);
        }
    }
    runs
}

/// One input row missing its source is one decision the reader cannot check, not four: reported per cell it fills the answer
/// and pushes other findings out of the list.
fn report_unsourced_runs(list: &mut IssueList, unsourced: &[Unsourced]) {
    for run in contiguous_runs(unsourced) {
        let first = run[0];
        let last = run[run.len() - 1];
        let span = if run.len() > 1 { format!("{}:{}", first.reference, last.reference) } else { first.reference.clone() };
        list.push(
            "warning",
            "hardcode_missing_source",
            first.path.clone(),
            if run.len() > 1 {
                format!(
                    "{} hardcoded inputs ({span}) have no note naming their source or the assumption behind them; add_provenance or add_note on the row.",
                    run.len()
                )
            } else {
                "Hardcoded input has no note naming its source or the assumption behind it; add_provenance or add_note on the cell.".to_owned()
            },
        );
    }
}

/// The formula cells of a sheet by row and by column, and the hardcoded numbers beside them.
struct FormulaLines<'a> {
    by_row: Grouped<LineEntry<'a>>,
    by_column: Grouped<LineEntry<'a>>,
    formula_rows: Grouped<f64>,
    formula_columns: HashSet<i64>,
    formula_count: usize,
    hardcodes: usize,
    marked_hardcodes: usize,
    styled_cells: usize,
}

/// Audits every formula cell and groups them by row and column, counting the hardcoded numbers beside them.
fn collect_formula_lines<'a>(list: &mut IssueList, sheet: &Value, cells: &'a [Value], extent: &Extent, checks_sheet: bool) -> FormulaLines<'a> {
    let mut lines = FormulaLines {
        by_row: Grouped::new(),
        by_column: Grouped::new(),
        formula_rows: Grouped::new(),
        formula_columns: HashSet::new(),
        formula_count: 0,
        hardcodes: 0,
        marked_hardcodes: 0,
        styled_cells: 0,
    };
    for cell in cells {
        let Some(at) = position(cell) else { continue };
        if has_visible_style(cell.get("style")) {
            lines.styled_cells += 1;
        }
        if truthy(cell.get("formula")) {
            audit_formula_cell(list, sheet, cell, extent, checks_sheet);
            lines.formula_count += 1;
            lines.formula_columns.insert(key(at.column));
            let signature = signature_at(&text_or_empty(cell.get("formula")), Some(at));
            lines.by_row.push(key(at.row), LineEntry { cell, index: at.column, signature: signature.clone() });
            lines.by_column.push(key(at.column), LineEntry { cell, index: at.row, signature });
            lines.formula_rows.push(key(at.row), at.column);
        } else if numeric_value(cell).is_some() {
            lines.hardcodes += 1;
            if is_marked_input_style(cell.get("style")) {
                lines.marked_hardcodes += 1;
            }
        }
    }
    lines
}

fn audit_hardcode_interruption(list: &mut IssueList, path: &str, at: Position, lines: &FormulaLines<'_>) {
    let mut column_entries: Vec<&LineEntry<'_>> = lines.by_column.get(key(at.column)).map(|entries| entries.iter().collect()).unwrap_or_default();
    column_entries.sort_by(|left, right| left.index.total_cmp(&right.index));
    let above = column_entries.iter().rev().find(|entry| entry.index < at.row);
    let below = column_entries.iter().find(|entry| entry.index > at.row);
    if let (Some(above), Some(below)) = (above, below)
        && !above.signature.is_empty()
        && above.signature == below.signature
    {
        list.push(
            "warning",
            "formula_inconsistency",
            path,
            "A hardcoded value interrupts a column of formulas; the schedule no longer recalculates through this cell.",
        );
    }
    let Some(formula_columns) = lines.formula_rows.get(key(at.row)) else { return };
    if formula_columns.len() < 2 {
        return;
    }
    let first = formula_columns.iter().copied().fold(f64::INFINITY, f64::min);
    let last = formula_columns.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if at.column > first && at.column < last {
        list.push(
            "warning",
            "formula_inconsistency",
            path,
            "A hardcoded value interrupts a row of formulas; the projection no longer recalculates through this cell.",
        );
    } else if at.column > last {
        list.push("warning", "rogue_hardcode", path, "Numeric hardcode sits after the formulas of its row; a pasted result where a formula belongs.");
    }
}

/// An input a formula reads (marked as one, or sharing a row or column with formulas) says where its number came from; raw
/// data does not, and a year across the first populated row is a column heading.
fn audit_hardcodes(list: &mut IssueList, sheet: &Value, cells: &[Value], lines: &FormulaLines<'_>, extent: &Extent) {
    let noted = noted_refs(sheet, cells);
    let bodies: Vec<_> = table_areas(sheet).iter().map(|table| table.area).collect();
    let mut unsourced: Vec<Unsourced> = Vec::new();
    for cell in cells {
        let value = numeric_value(cell);
        if truthy(cell.get("formula")) {
            continue;
        }
        let Some(value) = value else { continue };
        let Some(at) = position(cell) else { continue };
        let path = cell_path(sheet, cell);
        let feeds_model = lines.formula_count > 0
            && (is_marked_input_style(cell.get("style")) || lines.formula_rows.get(key(at.row)).is_some() || lines.formula_columns.contains(&key(at.column)));
        let header_year = at.row == extent.first_row && value.fract() == 0.0 && (1900.0..=2100.0).contains(&value);
        let reference = js_text(cell.get("ref")).to_uppercase();
        if feeds_model && !header_year && !noted.contains(&reference) && !inside_table_body(&bodies, &at) {
            unsourced.push(Unsourced { row: at.row, column: at.column, reference, path: path.clone() });
        }
        audit_hardcode_interruption(list, &path, at, lines);
    }
    report_unsourced_runs(list, &unsourced);
}

/// `isChecksSheetName(name)`: the tie-out sheet is named in the reader's language. Matching the English convention alone left
/// a Korean workbook's checks unread, so the profile's central test never ran and the model passed as if it had none.
pub fn is_checks_sheet_name(name: &str) -> bool {
    let label = js_to_lowercase(mixdog_js::js_trim(name));
    ["checks", "check", "검증", "점검"].contains(&label.as_str())
}

fn audit_model_discipline(list: &mut IssueList, sheet: &Value, cells: &[Value]) {
    let checks_sheet = is_checks_sheet_name(&text_or_empty(sheet.get("name")));
    let extent = populated_extent(cells);
    let lines = collect_formula_lines(list, sheet, cells, &extent, checks_sheet);
    audit_hardcodes(list, sheet, cells, &lines, &extent);
    for axis in [(&lines.by_row, "row"), (&lines.by_column, "column")] {
        for at in &axis.0.order {
            let mut line: Vec<&LineEntry<'_>> = axis.0.groups[at].iter().collect();
            line.sort_by(|left, right| left.index.total_cmp(&right.index));
            audit_line(list, sheet, &line, axis.1);
        }
    }
    if lines.styled_cells > 0 && lines.formula_count >= 3 && lines.hardcodes >= 5 && lines.marked_hardcodes == 0 {
        list.push(
            "info",
            "input_cells_unmarked",
            sheet_path(sheet),
            format!(
                "{} hardcoded inputs are indistinguishable from formulas; mark inputs (blue font, or a fill for cells the reader edits) and add a legend.",
                lines.hardcodes
            ),
        );
    }
}

/// What `auditXlsxFormulas` is told besides the sheets.
#[derive(Debug, Clone, Copy, Default)]
pub struct AuditOptions<'a> {
    /// `financial-model` turns the modelling discipline on; anything else runs the hygiene alone.
    pub audit_profile: &'a str,
    /// The names of the workbook's sheets; empty reads them from the sheets themselves.
    pub sheet_names: &'a [String],
    /// The workbook's defined names (`[{ name, refersTo }]`).
    pub defined_names: &'a [Value],
}

/// `auditXlsxFormulas(sheets, { auditProfile, sheetNames, definedNames })`.
pub fn audit_xlsx_formulas(sheets: &[Value], options: &AuditOptions<'_>) -> Vec<Issue> {
    let mut found = IssueList::new();
    let names: Cow<'_, [String]> = if options.sheet_names.is_empty() {
        Cow::Owned(sheets.iter().filter(|sheet| truthy(sheet.get("name"))).map(|sheet| js_text(sheet.get("name"))).collect())
    } else {
        Cow::Borrowed(options.sheet_names)
    };
    let external_names = external_defined_names(options.defined_names);
    for sheet in sheets {
        let listed = list(sheet.get("cells"));
        let cells: Cow<'_, [Value]> = if listed.iter().all(|cell| truthy(cell.get("ref"))) {
            Cow::Borrowed(listed)
        } else {
            Cow::Owned(listed.iter().filter(|cell| truthy(cell.get("ref"))).cloned().collect())
        };
        if cells.is_empty() {
            continue;
        }
        audit_sheet_hygiene(&mut found, sheet, &cells, &names, &external_names);
        audit_sheet_layout(&mut found, sheet, &cells);
        audit_double_counting(&mut found, sheet, &cells);
        if options.audit_profile == "financial-model" {
            audit_model_discipline(&mut found, sheet, &cells);
        }
    }
    let mut issues = found.issues;
    if found.omitted > 0 {
        issues.push(Issue {
            severity: "info",
            code: "audit_issues_truncated",
            path: "/".to_owned(),
            message: format!("{} additional formula audit finding(s) were omitted after {MAX_ISSUES_PER_CODE} per code.", found.omitted),
        });
    }
    issues
}

/// `/^\/sheet\[[^\]]*\]/.exec(path)?.[0]`.
fn sheet_owner(path: &str) -> Option<&str> {
    static OWNER: LazyLock<JsRegex> = regex!(r"^\/sheet\[[^\]]*\]", "");
    OWNER.find(path).map(|range| &path[range])
}

/// The sheets the snapshot carries whole and the cells of the truncated ones it carries in part: the host's verdict stands
/// for any cell outside both.
fn audited_scope(sheets: &[Value]) -> (HashSet<String>, HashSet<String>) {
    let mut read_sheets: HashSet<String> = HashSet::new();
    let mut read_cells: HashSet<String> = HashSet::new();
    for entry in sheets {
        let cells = list(entry.get("cells"));
        if cells.is_empty() {
            continue;
        }
        let owner = format!("/sheet[{}]", js_to_lowercase(&text_or_empty(entry.get("name"))));
        if !truthy(entry.get("truncated")) {
            read_sheets.insert(owner);
        } else {
            for cell in cells {
                let path = if truthy(cell.get("path")) { js_text(cell.get("path")) } else { format!("{owner}/cell[{}]", text_or_empty(cell.get("ref"))) };
                read_cells.insert(js_to_lowercase(&path));
            }
        }
    }
    (read_sheets, read_cells)
}

/// `mergeXlsxFormulaAudit(result, document, { auditProfile, sheet })`: folds the shared audit into a backend's own issues
/// result (Excel's issues come from its host, which reports a subset of these codes); a finding the host already made is not
/// repeated, and a sheet-scoped request stays scoped.
pub fn merge_xlsx_formula_audit(result: &Value, document: &Value, audit_profile: &str, sheet: &str) -> Value {
    let sheets = list(document.get("sheets"));
    let scope = if sheet.is_empty() { String::new() } else { format!("/sheet[{}]", js_to_lowercase(sheet)) };
    let names: Vec<String> = sheets.iter().map(|entry| js_text(entry.get("name"))).collect();
    let findings: Vec<Issue> =
        audit_xlsx_formulas(sheets, &AuditOptions { audit_profile, sheet_names: &names, defined_names: list(document.get("definedNames")) })
            .into_iter()
            .filter(|finding| scope.is_empty() || finding.path == "/" || js_to_lowercase(&finding.path).starts_with(&scope))
            .collect();
    let (read_sheets, read_cells) = audited_scope(sheets);
    let mut issues: Vec<Value> = list(result.get("issues"))
        .iter()
        .filter(|entry| {
            let shared = entry.get("code").and_then(Value::as_str).is_some_and(|code| SHARED_MODEL_VERDICTS.contains(&code));
            if !shared {
                return true;
            }
            let path = js_to_lowercase(&text_or_empty(entry.get("path")));
            !sheet_owner(&path).is_some_and(|owner| read_sheets.contains(owner) || read_cells.contains(&path))
        })
        .cloned()
        .collect();
    let seen: HashSet<String> = issues.iter().map(|entry| format!("{}|{}", js_text(entry.get("code")), js_text(entry.get("path")))).collect();
    let added: Vec<Value> = findings.iter().filter(|finding| !seen.contains(&format!("{}|{}", finding.code, finding.path))).map(Issue::to_json).collect();
    let added_count = added.len();
    issues.extend(added);
    let count = issues.len();
    let cells_read: usize = sheets.iter().map(|entry| list(entry.get("cells")).len()).sum();
    let mut merged: Map<String, Value> = result.as_object().cloned().unwrap_or_default();
    merged.insert("issues".to_owned(), Value::Array(issues));
    merged.insert("issueCount".to_owned(), json!(count));
    merged.insert("sharedAudit".to_owned(), json!({ "added": added_count, "cellsRead": cells_read }));
    Value::Object(merged)
}
