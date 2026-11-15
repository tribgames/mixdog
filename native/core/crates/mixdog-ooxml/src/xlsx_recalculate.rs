//! `portable/xlsx-recalculate.mjs`: recalculation for the portable backend. LibreOffice is the reference implementation and is
//! asked first (through the [`Soffice`] driver); the in-process engine ([`mixdog_xlsx_formula`]) answers only on a machine that
//! has none, and only for the formulas it can read. A cell it cannot evaluate keeps whatever the file already held, and the
//! result names it.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;
use std::sync::atomic::AtomicBool;

use mixdog_fsio::WriteProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim};
use mixdog_office_base::a1::{column_number, parse_cell_ref};
use mixdog_office_base::write_note::WriteNote;
use mixdog_xlsx_formula::coerce::to_js_string;
use mixdog_xlsx_formula::{Context, Extent, Failure, Value as Cell, evaluate_formula, is_blank, is_formula_error};
use serde_json::{Map, Value, json};

use crate::cells::{CachedValue, CellRecord, CellValue, Sheet, cell_records, shared_strings, workbook_sheets, write_cached_values};
use crate::package::{load_package, save_package};
use crate::shared_formulas::{SharedFormulaFailure, expand_shared_formulas};
use crate::soffice::Soffice;
use crate::xlsx_charts::refresh_chart_caches;
use crate::xml::{xml_decode, xml_encode};
use crate::zipio::Package;

const MAX_ENGINE_FORMULAS: usize = 20_000;
/// Each cell a formula waits on is another frame on the stack, and a column that points at the cell below it stacks one frame
/// per row. Past a depth this deep the engine stops at a fixed depth and says so, so the answer does not depend on the machine.
const MAX_CHAIN_DEPTH: usize = 500;
/// The same ceiling the LibreOffice summary reports under, so a caller reads one contract whichever backend answered.
const MAX_REPORTED_CELLS: usize = 100;
/// The stack the evaluation runs on: a chain of [`MAX_CHAIN_DEPTH`] cells nests the evaluator that many times over.
const EVALUATION_STACK: usize = 256 * 1024 * 1024;

/// The refusal reason of an evaluation that went too deep for the order the sheet was read in.
fn too_deep() -> String {
    format!("a dependency chain deeper than {MAX_CHAIN_DEPTH} cells")
}

/// A name the workbook defines as one cell, one range or a plain constant is that value under another word, and a model reads
/// better for it. Anything else a name can hold (a formula, a name that means something different on each sheet, a print area)
/// is left undefined, so the formulas using it are refused rather than read wrongly. None of these can name another name, so a
/// definition never chases its own tail.
static DEFINED_NAME_TARGET: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r#"^(?:(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"[^"]*")$"#,
        "",
    )
});
static DEFINED_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<definedName\b([^>]*)>([\s\S]*?)<\/definedName>", "g"));
static LOCAL_SHEET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\blocalSheetId=", ""));
static NAME_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bname="([^"]+)""#, ""));
static EXTERNAL_LINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^xl\/externalLinks\/", "i"));

fn workbook_defined_names(xml: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for found in DEFINED_NAME.captures_iter(xml) {
        let attributes = found.get(1).unwrap_or("");
        if LOCAL_SHEET.is_match(attributes) {
            continue;
        }
        let Some(name) = NAME_ATTRIBUTE.captures(attributes).and_then(|caps| caps.get(1).map(str::to_owned)) else { continue };
        if name.starts_with("_xlnm.") {
            continue;
        }
        let target = xml_decode(js_trim(found.get(2).unwrap_or("")));
        if !DEFINED_NAME_TARGET.is_match(&target) {
            continue;
        }
        names.insert(name.to_uppercase(), target);
    }
    names
}

/// A computed value typed the way [`write_cached_values`] stores it.
fn cached_cell(value: &Cell) -> CachedValue {
    if is_formula_error(value) {
        return CachedValue { kind: "e".to_owned(), text: xml_encode(&to_js_string(value)) };
    }
    match value {
        Cell::Bool(flag) => CachedValue { kind: "b".to_owned(), text: (if *flag { "1" } else { "0" }).to_owned() },
        Cell::Number(_) => CachedValue { kind: String::new(), text: to_js_string(value) },
        other if is_blank(other) => CachedValue { kind: "str".to_owned(), text: String::new() },
        other => CachedValue { kind: "str".to_owned(), text: xml_encode(&to_js_string(other)) },
    }
}

/// A sheet of the workbook: the part the engine writes back to, the cells it read, and the stored-once formulas it could not
/// write out.
struct SheetPart {
    sheet: Sheet,
    xml: String,
    records: Vec<CellRecord>,
    shared_failures: Vec<SharedFormulaFailure>,
}

/// One cell the evaluator reads: its literal, or the formula it holds.
struct GridCell {
    value: Cell,
    formula: Option<String>,
}

fn formula_of(record: &CellRecord) -> Option<&str> {
    record.formula.as_ref().map(|info| info.formula.as_str()).filter(|formula| !formula.is_empty())
}

fn literal_of(value: &CellValue) -> Cell {
    match value {
        CellValue::Text(text) => Cell::Text(text.clone()),
        CellValue::Number(number) => Cell::Number(*number),
        CellValue::Bool(flag) => Cell::Bool(*flag),
    }
}

/// The workbook's cells by sheet, plus the per-sheet parts the engine writes back to, and the formula count that gates the
/// engine.
fn load_workbook_grid(zip: &Package) -> Result<(Vec<SheetPart>, HashMap<String, HashMap<String, GridCell>>, usize), String> {
    let strings = shared_strings(zip);
    let mut parts = Vec::new();
    let mut grid: HashMap<String, HashMap<String, GridCell>> = HashMap::new();
    let mut formula_count = 0;
    for sheet in workbook_sheets(zip) {
        let xml = zip.text(&sheet.path);
        let mut records = cell_records(&xml, &strings, None);
        let shared_failures = expand_shared_formulas(&xml, &mut records)?;
        let cells = records
            .iter()
            .map(|record| (record.reference.clone(), GridCell { value: literal_of(&record.value), formula: formula_of(record).map(str::to_owned) }))
            .collect();
        grid.insert(js_to_lowercase(&sheet.name), cells);
        formula_count += records.iter().filter(|record| formula_of(record).is_some()).count();
        parts.push(SheetPart { sheet, xml, records, shared_failures });
    }
    Ok((parts, grid, formula_count))
}

/// A memoized cell evaluator over the grid: literals answer directly, formulas evaluate through their dependencies, with
/// circular references and over-deep chains refused.
struct Engine {
    grid: HashMap<String, HashMap<String, GridCell>>,
    defined_names: HashMap<String, String>,
    /// How far a sheet's own cells reach, which is what bounds `SUM(A:A)`.
    extents: RefCell<HashMap<String, Option<Extent>>>,
    computed: RefCell<HashMap<String, Cell>>,
    active: RefCell<HashSet<String>>,
}

impl Engine {
    fn sheet_extent(&self, sheet: &str) -> Option<Extent> {
        let key = js_to_lowercase(sheet);
        if let Some(known) = self.extents.borrow().get(&key) {
            return *known;
        }
        let extent = self.grid.get(&key).map(|records| {
            let (mut rows, mut columns) = (0_u64, 0_u64);
            for reference in records.keys() {
                let Ok(position) = parse_cell_ref(reference) else { continue };
                rows = rows.max(position.row);
                columns = columns.max(column_number(&position.col) as u64);
            }
            Extent { rows, columns }
        });
        self.extents.borrow_mut().insert(key, extent);
        extent
    }

    fn cell_value(&self, sheet: &str, reference: &str) -> Result<Cell, Failure> {
        let lower = js_to_lowercase(sheet);
        let key = format!("{lower}!{reference}");
        if let Some(known) = self.computed.borrow().get(&key) {
            return Ok(known.clone());
        }
        let Some(records) = self.grid.get(&lower) else {
            return Err(Failure::unsupported(format!("sheet \"{sheet}\" is not in this workbook")));
        };
        let Some(record) = records.get(reference) else { return Ok(Cell::Text(String::new())) };
        let Some(formula) = &record.formula else {
            self.computed.borrow_mut().insert(key, record.value.clone());
            return Ok(record.value.clone());
        };
        // A formula that reaches itself has no value to give; Excel reports the same condition rather than settling on a number.
        if self.active.borrow().contains(&key) {
            return Err(Failure::unsupported("a circular reference"));
        }
        // The cells being waited on are exactly the frames this evaluation holds. Depth is about the order this sheet is read
        // in, not about the formula: the same cell answers immediately once the ones it waits on are cached.
        if self.active.borrow().len() >= MAX_CHAIN_DEPTH {
            return Err(Failure::unsupported(too_deep()));
        }
        self.active.borrow_mut().insert(key.clone());
        let outcome = evaluate_formula(formula, &mut Frame { engine: self, sheet: sheet.to_owned() });
        self.active.borrow_mut().remove(&key);
        let value = outcome?;
        self.computed.borrow_mut().insert(key, value.clone());
        Ok(value)
    }
}

/// What one formula is evaluated against: the workbook around its cell.
struct Frame<'a> {
    engine: &'a Engine,
    sheet: String,
}

impl Context for Frame<'_> {
    fn sheet(&self) -> &str {
        &self.sheet
    }

    fn value(&mut self, sheet: &str, reference: &str) -> Result<Cell, Failure> {
        self.engine.cell_value(sheet, reference)
    }

    fn extent(&mut self, sheet: &str) -> Option<Extent> {
        self.engine.sheet_extent(sheet)
    }

    fn defined_name(&mut self, name: &str) -> Option<String> {
        self.engine.defined_names.get(&name.to_uppercase()).filter(|target| !target.is_empty()).cloned()
    }
}

/// What the formulas of every sheet came to.
#[derive(Default)]
struct Tally {
    unevaluated: Vec<(String, String)>,
    error_cells: Vec<(String, String)>,
    evaluated: usize,
}

/// Evaluates one sheet's formulas into the values it reached, recording refusals and error results on the tally. A column that
/// adds up the row above it resolves as the sheet is read. One written the other way round waits on a cell further down for
/// every row, and reading top-down would refuse each of them in turn. So the first refusal for depth turns the rest of the
/// sheet around: read from the bottom, every cell finds what it waits on already computed.
fn evaluate_sheet_formulas(part: &SheetPart, engine: &Engine, tally: &mut Tally) -> Result<Vec<(String, Cell)>, String> {
    let sheet_name = &part.sheet.name;
    let mut values: Vec<(String, Cell)> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for failure in &part.shared_failures {
        tally.unevaluated.push((format!("{sheet_name}!{}", failure.reference), failure.reason.clone()));
    }
    let mut attempt = |record: &CellRecord, tally: &mut Tally| -> Result<Option<String>, String> {
        match engine.cell_value(sheet_name, &record.reference) {
            Ok(value) => {
                if is_formula_error(&value) {
                    tally.error_cells.push((to_js_string(&value), format!("{sheet_name}!{}", record.reference)));
                }
                tally.evaluated += 1;
                match positions.get(&record.reference) {
                    Some(at) => values[*at].1 = value,
                    None => {
                        positions.insert(record.reference.clone(), values.len());
                        values.push((record.reference.clone(), value));
                    }
                }
                Ok(None)
            }
            Err(Failure::Unsupported(refusal)) => Ok(Some(refusal.reason)),
            Err(Failure::Thrown(message)) => Err(message),
        }
    };
    let formulas: Vec<&CellRecord> = part.records.iter().filter(|record| formula_of(record).is_some()).collect();
    let mut turned: Option<Vec<&CellRecord>> = None;
    for (index, record) in formulas.iter().enumerate() {
        let Some(reason) = attempt(record, tally)? else { continue };
        if reason == too_deep() {
            turned = Some(formulas[index..].iter().rev().copied().collect());
            break;
        }
        tally.unevaluated.push((format!("{sheet_name}!{}", record.reference), reason));
    }
    for record in turned.unwrap_or_default() {
        if let Some(reason) = attempt(record, tally)? {
            tally.unevaluated.push((format!("{sheet_name}!{}", record.reference), reason));
        }
    }
    Ok(values)
}

fn error_summary(error_cells: &[(String, String)]) -> Value {
    let mut by_type: Vec<(String, usize, Vec<Value>, usize)> = Vec::new();
    for (kind, at) in error_cells {
        let position = match by_type.iter().position(|(known, ..)| known == kind) {
            Some(position) => position,
            None => {
                by_type.push((kind.clone(), 0, Vec::new(), 0));
                by_type.len() - 1
            }
        };
        let bucket = &mut by_type[position];
        bucket.1 += 1;
        if bucket.2.len() < MAX_REPORTED_CELLS {
            bucket.2.push(json!(at));
        } else {
            bucket.3 += 1;
        }
    }
    Value::Object(
        by_type
            .into_iter()
            .map(|(kind, count, cells, truncated)| {
                let mut bucket = Map::new();
                bucket.insert("count".to_owned(), json!(count));
                bucket.insert("cells".to_owned(), Value::Array(cells));
                if truncated > 0 {
                    bucket.insert("truncated".to_owned(), json!(truncated));
                }
                (kind, Value::Object(bucket))
            })
            .collect(),
    )
}

fn refused(reason: String) -> Value {
    json!({ "recalculated": false, "reason": reason })
}

fn evaluate_package(zip: &mut Package) -> Result<Value, String> {
    if zip.names().iter().any(|entry| EXTERNAL_LINK.is_match(entry)) {
        return Ok(refused("The workbook reads another workbook, which this engine cannot open.".to_owned()));
    }
    let (parts, grid, formula_count) = load_workbook_grid(zip)?;
    if formula_count == 0 {
        return Ok(refused("The workbook has no formulas.".to_owned()));
    }
    if formula_count > MAX_ENGINE_FORMULAS {
        return Ok(refused(format!(
            "The workbook carries {formula_count} formulas, more than the {MAX_ENGINE_FORMULAS} this engine evaluates; install LibreOffice to recalculate it."
        )));
    }
    let engine = Engine {
        grid,
        defined_names: workbook_defined_names(&zip.text("xl/workbook.xml")),
        extents: RefCell::new(HashMap::new()),
        computed: RefCell::new(HashMap::new()),
        active: RefCell::new(HashSet::new()),
    };
    let mut tally = Tally::default();
    for part in &parts {
        let values = evaluate_sheet_formulas(part, &engine, &mut tally)?;
        if !values.is_empty() {
            let cached: Vec<(String, CachedValue)> = values.iter().map(|(reference, value)| (reference.clone(), cached_cell(value))).collect();
            zip.set(&part.sheet.path, write_cached_values(&part.xml, &cached));
        }
    }
    refresh_chart_caches(zip)?;
    let Tally { unevaluated, error_cells, evaluated } = tally;
    if evaluated == 0 {
        let reason = unevaluated.first().map_or("unknown reason", |entry| entry.1.as_str());
        return Ok(refused(format!("No formula in this workbook could be evaluated ({reason}).")));
    }
    // A clean status proves the formulas evaluate, not that they are right.
    let status = if !error_cells.is_empty() {
        "errors_found"
    } else if !unevaluated.is_empty() {
        "partial"
    } else {
        "success"
    };
    let mut report = Map::new();
    report.insert("recalculated".to_owned(), json!(true));
    report.insert("backend".to_owned(), json!("mixdog-formula"));
    report.insert("status".to_owned(), json!(status));
    report.insert("formulaCount".to_owned(), json!(formula_count));
    report.insert("evaluated".to_owned(), json!(evaluated));
    report.insert("totalErrors".to_owned(), json!(error_cells.len()));
    report.insert("errorSummary".to_owned(), error_summary(&error_cells));
    if !unevaluated.is_empty() {
        report.insert("unevaluatedCount".to_owned(), json!(unevaluated.len()));
        let listed: Vec<Value> = unevaluated.iter().take(MAX_REPORTED_CELLS).map(|(at, reason)| json!(format!("{at}: {reason}"))).collect();
        report.insert("unevaluated".to_owned(), Value::Array(listed));
    }
    Ok(Value::Object(report))
}

/// The engine over a package in memory: the formulas evaluated into their cached values, the chart caches refreshed, and the
/// answer `recalculateWithFormulaEngine` gives. A package whose answer says `recalculated: false` is not to be saved.
pub fn recalculate_engine_package(zip: &mut Package) -> Result<Value, String> {
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new()
            .name("xlsx-recalculate".to_owned())
            .stack_size(EVALUATION_STACK)
            .spawn_scoped(scope, || evaluate_package(zip))
            .map_err(|error| format!("Cannot start the recalculation: {error}"))?;
        match worker.join() {
            Ok(outcome) => outcome,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

/// `recalculateWithFormulaEngine(path)`: evaluates the workbook's formulas in this process and writes the values it reached.
pub fn recalculate_with_formula_engine<P: WriteProof>(proof: &P, note: &dyn WriteNote, path: &Path) -> Result<Value, String> {
    let mut zip = load_package(proof, path)?;
    let report = recalculate_engine_package(&mut zip)?;
    if report.get("recalculated") == Some(&Value::Bool(true)) {
        save_package(proof, note, &zip, path)?;
    }
    Ok(report)
}

/// `recalculatePortableWorkbook(path, { force, signal })`: recalculates a portable workbook: LibreOffice when it is installed,
/// the in-process engine when it is not.
pub fn recalculate_portable_workbook<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    soffice: &Soffice,
    path: &Path,
    force: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Value, String> {
    let libre_office = soffice.recalculate_workbook(proof, path, force, cancel)?;
    let flag = |name: &str| libre_office.get(name) == Some(&Value::Bool(true));
    if !flag("needed") || flag("recalculated") {
        return Ok(libre_office);
    }
    // LibreOffice answered and failed for its own reason; that answer stands.
    if soffice.available() {
        return Ok(libre_office);
    }
    if path.extension().map(|extension| extension.to_string_lossy().to_lowercase()).as_deref() != Some("xlsx") {
        return Ok(libre_office);
    }
    let engine = recalculate_with_formula_engine(proof, note, path)?;
    if engine.get("recalculated") != Some(&Value::Bool(true)) {
        let said = |value: &Value| value.get("reason").and_then(Value::as_str).unwrap_or("undefined").to_owned();
        let mut answer = libre_office.as_object().cloned().unwrap_or_default();
        let reason = format!("{} {}", said(&libre_office), said(&engine));
        answer.insert("reason".to_owned(), Value::String(js_trim(&reason).to_owned()));
        return Ok(Value::Object(answer));
    }
    let mut answer = Map::new();
    answer.insert("needed".to_owned(), json!(true));
    answer.insert("available".to_owned(), json!(true));
    answer.insert("missingCachedValues".to_owned(), libre_office.get("missingCachedValues").cloned().unwrap_or(Value::Null));
    if let Value::Object(fields) = engine {
        answer.extend(fields);
    }
    Ok(Value::Object(answer))
}
